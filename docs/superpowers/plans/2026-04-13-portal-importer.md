# Portal Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new applet that imports multi-PO XLS files from customer portals (starting with Hubbell) with single/bulk modes, fuzzy-match PN suggestions, and a shared source-file viewer. Refactor OV operations into a shared module consumed by both PO Comparator and Portal Importer.

**Architecture:** Extract `findCandidateOVs`, `showCandidateSelector`, `uploadAndAttachFile`, `adoptExistingOV`, `fetchCreationData`, `showCreationWizard`, `showNoMatchOptions`, `createNewOV`, `resolvePartNumber` from `po-comparator.js` into new `ov-operations.js` (exposes `window.OVOperations`). Shape data as unified `sourceData` object. Add `portal-importer.js` that parses XLS via SheetJS, detects layout from `config.portalLayouts`, falls back to Claude for unknown layouts, maintains a buyer-code→PN mapping in `chrome.storage.local`, and offers single or bulk mode.

**Tech Stack:** Vanilla JS IIFE modules, Steelhead GraphQL persisted queries, SheetJS (already bundled), Claude API (already integrated), `chrome.storage.local` for persistent state.

---

### Task 1: Create ov-operations.js with extracted functions

**Files:**
- Create: `remote/scripts/ov-operations.js`

- [ ] **Step 1: Create the module skeleton**

Create `remote/scripts/ov-operations.js` with this exact content:

```javascript
// OV Operations — shared module for ReceivedOrder creation, adoption, and helpers
// Consumed by po-comparator.js and portal-importer.js
// Depends on: SteelheadAPI

const OVOperations = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── Shared helpers ─────────────────────────────────────────

  function normalizePN(pn) {
    if (pn == null) return null;
    return String(pn).trim().toLowerCase();
  }

  function aggressiveNormalizePN(pn) {
    if (pn == null) return null;
    return String(pn).trim().toLowerCase().replace(/[\s\-\._]/g, '');
  }

  function normalizeCurrency(val) {
    if (!val) return null;
    const s = String(val).trim().toUpperCase();
    if (s.includes('USD') || s.includes('$') || s.includes('DLLS')) return 'USD';
    if (s.includes('MXN') || s.includes('PESO') || s.includes('MXP')) return 'MXN';
    return s.substring(0, 3);
  }

  function fuzzyMatchStr(a, b) {
    if (!a || !b) return false;
    const na = String(a).trim().toLowerCase();
    const nb = String(b).trim().toLowerCase();
    return na.includes(nb) || nb.includes(na);
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toNumber(val) {
    if (val == null) return null;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  // ── UI helpers (overlay/modal — duplicated from po-comparator styles) ─

  function createOverlay() {
    const ov = document.createElement('div');
    ov.id = 'dl9-ovop-overlay';
    ov.className = 'dl9-overlay';
    return ov;
  }

  function createModal() {
    const md = document.createElement('div');
    md.className = 'dl9-poc-modal';
    return md;
  }

  function removeOverlay() {
    const ov = document.getElementById('dl9-ovop-overlay');
    if (ov) ov.remove();
  }

  // Placeholder — functions below populated in later tasks

  return {
    normalizePN,
    aggressiveNormalizePN,
    normalizeCurrency,
    fuzzyMatchStr,
    escHtml,
    toNumber,
    createOverlay,
    createModal,
    removeOverlay
  };
})();

window.OVOperations = OVOperations;
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/ov-operations.js`
Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/ov-operations.js
git commit -m "feat(ov-operations): create shared module skeleton"
```

---

### Task 2: Move core OV functions into ov-operations.js

**Files:**
- Modify: `remote/scripts/ov-operations.js`

- [ ] **Step 1: Add findCandidateOVs, uploadAndAttachFile, adoptExistingOV**

Replace the `// Placeholder — functions below populated in later tasks` comment in `remote/scripts/ov-operations.js` with these functions (insert before the `return {` line):

```javascript
  // ── Multi-signal OV detection ──────────────────────────────

  const PROVISIONAL_NAME_RE = /^(test|prueba|pendiente|temp|tmp)/i;

  async function findCandidateOVs(sourceData, customerId) {
    if (!customerId) return [];

    log('Buscando OVs candidatas del cliente...');

    const data = await api().query('ActiveReceivedOrders', {
      domainId: api().getDomain().id || 344,
      customerId: parseInt(customerId, 10),
      first: 100,
      offset: 0,
      orderBy: ['ID_IN_DOMAIN_DESC']
    });

    const orders = data?.receivedOrders?.nodes ||
                   data?.allReceivedOrders?.nodes ||
                   data?.activeReceivedOrders?.nodes || [];

    if (orders.length === 0) {
      log('No hay OVs activas para este cliente');
      return [];
    }

    log(`${orders.length} OVs activas del cliente, analizando...`);

    const pdfPNs = new Set(
      sourceData.lines
        .map(l => normalizePN(l.partNumber))
        .filter(Boolean)
    );

    const candidates = [];
    for (const order of orders) {
      const ovId = order.idInDomain || order.id;
      const ovName = order.name || '';
      const score = { ovId, ovName, order, signals: [], pnMatchCount: 0, pnMatchList: [] };

      if (PROVISIONAL_NAME_RE.test(ovName)) {
        score.signals.push('provisional');
      }

      if (sourceData.poNumber && ovName.toLowerCase().includes(sourceData.poNumber.toLowerCase())) {
        score.signals.push('name_similar');
      }

      try {
        const ovData = await api().query('GetReceivedOrder', {
          idInDomain: parseInt(ovId, 10),
          revisionNumber: 1
        });
        const ovOrder = ovData?.receivedOrder;
        const roLines = ovOrder?.receivedOrderLines?.nodes || ovOrder?.receivedOrderLines || [];
        score.lineCount = roLines.length;
        score.deadline = ovOrder?.deadline;

        for (const line of roLines) {
          const pn = normalizePN(line.partNumber?.name || line.partNumberName);
          if (pn && pdfPNs.has(pn)) {
            score.pnMatchCount++;
            score.pnMatchList.push(pn);
          }
        }

        if (score.pnMatchCount > 0) {
          score.signals.push('pn_match');
        }
      } catch (e) {
        warn(`No se pudieron cargar líneas de OV ${ovId}: ${e.message}`);
        score.lineCount = '?';
      }

      if (score.signals.length > 0) {
        candidates.push(score);
      }
    }

    candidates.sort((a, b) => {
      if (b.pnMatchCount !== a.pnMatchCount) return b.pnMatchCount - a.pnMatchCount;
      return (b.ovId || 0) - (a.ovId || 0);
    });

    log(`${candidates.length} candidata(s) encontrada(s)`);
    return candidates;
  }

  // ── File Upload & Attach ──────────────────────────────────

  async function uploadAndAttachFile(file, receivedOrderId) {
    log(`Subiendo "${file.name}" y adjuntando a OV...`);

    const formData = new FormData();
    formData.append('myfile', file, file.name);

    const uploadResp = await fetch('/api/files', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });

    if (!uploadResp.ok) throw new Error(`Upload HTTP ${uploadResp.status}`);
    const uploadResult = await uploadResp.json();
    log(`Archivo subido: ${uploadResult.name}`);

    await api().query('CreateUserFile', {
      name: uploadResult.name,
      originalName: file.name
    });

    await api().query('CreateReceivedOrderUserFile', {
      receivedOrderId: receivedOrderId,
      userFileName: uploadResult.name
    });

    log(`Archivo adjuntado a OV exitosamente`);
  }

  // ── Adopt existing OV ──────────────────────────────────────

  async function adoptExistingOV(candidate, sourceData, file) {
    const ovId = candidate.ovId;
    log(`Adoptando OV #${ovId} — renombrando a "${sourceData.poNumber}"...`);

    await api().query('UpdateReceivedOrder', {
      id: candidate.order.id || candidate.order.nodeId,
      name: String(sourceData.poNumber)
    });
    log(`OV renombrada: ${candidate.ovName} → ${sourceData.poNumber}`);

    if (file) {
      try {
        await uploadAndAttachFile(file, candidate.order.id);
      } catch (e) {
        warn(`No se pudo adjuntar archivo: ${e.message}`);
      }
    }

    return ovId;
  }
```

Then update the `return {` block to also export these:

```javascript
  return {
    normalizePN,
    aggressiveNormalizePN,
    normalizeCurrency,
    fuzzyMatchStr,
    escHtml,
    toNumber,
    createOverlay,
    createModal,
    removeOverlay,
    findCandidateOVs,
    uploadAndAttachFile,
    adoptExistingOV
  };
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/ov-operations.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/ov-operations.js
git commit -m "feat(ov-operations): extract findCandidateOVs, uploadAndAttachFile, adoptExistingOV"
```

---

### Task 3: Move creation flow functions into ov-operations.js

**Files:**
- Modify: `remote/scripts/ov-operations.js`

- [ ] **Step 1: Add fetchCreationData, resolvePartNumber, createNewOV**

Insert these functions in `remote/scripts/ov-operations.js` before the `return {` block:

```javascript
  // ── OV Creation Data Fetching ─────────────────────────────

  async function fetchCreationData(customerId) {
    log('Cargando datos para creación de OV...');
    const domainId = api().getDomain().id || 344;

    const [dialogData, customerData] = await Promise.all([
      api().query('CreateEditReceivedOrderDialogQuery', {
        domainId,
        quoteId: -1,
        processIds: [],
        withinLocationIds: null,
        receivedOrderId: -1,
        includeReceivedOrder: false
      }),
      customerId
        ? api().query('GetCustomerInfoForReceivedOrder', { customerId: parseInt(customerId, 10) })
        : Promise.resolve(null)
    ]);

    const schemas = dialogData?.allReceivedOrderInputSchemas?.nodes || [];
    const inputSchema = schemas[0] || {};
    const inputSchemaId = inputSchema.id || 559;
    const schemaProperties = inputSchema.inputSchema?.properties || {};

    const customer = customerData?.customerById || {};
    const contacts = customer.customerContactsByCustomerId?.nodes || [];
    const addresses = customer.customerAddressesByCustomerId?.nodes || [];
    const defaultContact = contacts.find(c => c.isReceivedOrderContact) || contacts[0] || null;
    const defaultBillTo = customer.customerAddressByDefaultBillToAddressId || addresses.find(a => a.useForBilling) || addresses[0] || null;
    const defaultShipTo = customer.customerAddressByDefaultShipToAddressId || addresses.find(a => a.useForShipping) || addresses[0] || null;
    const invoiceTerms = customer.invoiceTermByDefaultInvoiceTermsId || null;
    const sector = customer.sectorBySectorId || null;
    const defaultOrderType = customer.defaultOrderType || 'MAKE_TO_ORDER';
    const defaultLeadTime = customer.defaultLeadTime || null;
    const defaultShipViaId = customer.defaultShipViaId || null;

    const razonSocialSchema = schemaProperties.RazonSocialVenta || {};
    const razonSocialOptions = razonSocialSchema.enum || razonSocialSchema.oneOf?.map(o => o.const || o.title) || [];

    const divisaSchema = schemaProperties.Divisa || {};
    const divisaOptions = divisaSchema.enum || divisaSchema.oneOf?.map(o => o.const || o.title) || ['USD', 'MXN'];

    const verificadoSchema = schemaProperties.VerificadaPor || schemaProperties.VerificadoPor || {};
    const verificadoOptions = verificadoSchema.enum || verificadoSchema.oneOf?.map(o => o.const || o.title) || [];

    const domain = dialogData?.domainById || {};
    const deadlineCutoffTime = domain.deadlineCutoffTime || '17:00:00';
    const timezoneName = domain.timezoneName || 'America/Mexico_City';

    log('Datos de creación cargados');

    return {
      inputSchemaId, schemaProperties, contacts, addresses,
      defaultContact, defaultBillTo, defaultShipTo,
      invoiceTerms, sector, defaultOrderType, defaultLeadTime, defaultShipViaId,
      razonSocialOptions, divisaOptions, verificadoOptions,
      deadlineCutoffTime, timezoneName, customer
    };
  }

  // ── PN Resolution with Fuzzy Match Detection ──────────────

  async function resolvePartNumber(pnName, customerId) {
    if (!pnName) return null;

    try {
      const pnData = await api().query('PartNumberCreatableSelectGetPartNumbers', {
        name: `%${pnName}%`,
        searchQuery: '',
        hideCustomerPartsWhenNoCustomerIdFilter: true,
        customerId: customerId ? parseInt(customerId, 10) : null,
        specIds: [],
        paramIds: []
      });
      const pns = pnData?.searchPartNumbers?.nodes || [];

      const normalizedTarget = normalizePN(pnName);
      const exactMatch = pns.find(p => normalizePN(p.label) === normalizedTarget);

      if (exactMatch) {
        const partNumberId = exactMatch.value || exactMatch.id;
        let partNumberPriceId = null;
        if (customerId) {
          try {
            const priceData = await api().query('SearchPartNumberPrices', {
              searchQuery: '%%',
              partNumberId,
              customerId: parseInt(customerId, 10),
              first: 5
            });
            const prices = priceData?.allPartNumberPrices?.nodes || [];
            if (prices.length > 0) partNumberPriceId = prices[0].id;
          } catch (e) {
            warn(`No se encontró precio para ${pnName}: ${e.message}`);
          }
        }
        return { partNumberId, partNumberPriceId, exact: true };
      }

      // Fuzzy match: aggressive normalization
      if (String(pnName).length >= 4) {
        const aggTarget = aggressiveNormalizePN(pnName);
        const fuzzyMatches = pns.filter(p => aggressiveNormalizePN(p.label) === aggTarget);
        if (fuzzyMatches.length === 1) {
          const m = fuzzyMatches[0];
          return {
            suggestion: {
              currentName: m.label,
              suggestedName: pnName,
              partNumberId: m.value || m.id
            }
          };
        }
        if (fuzzyMatches.length > 1) {
          warn(`${fuzzyMatches.length} PNs ambiguos para "${pnName}" — requiere revisión manual`);
        }
      }

      return null;
    } catch (e) {
      warn(`Error resolviendo PN "${pnName}": ${e.message}`);
      return null;
    }
  }

  // ── Create New OV ──────────────────────────────────────────

  async function createNewOV(formData, sourceData, file) {
    log('Creando OV nueva...');

    const createResult = await api().query('CreateReceivedOrder', formData);
    const newOV = createResult?.createReceivedOrder?.receivedOrder;
    if (!newOV) throw new Error('CreateReceivedOrder no devolvió OV');

    const ovId = newOV.idInDomain;
    const ovInternalId = newOV.id;
    log(`OV creada: #${ovId} (id: ${ovInternalId})`);

    log('Resolviendo números de parte...');
    const lineItems = [];
    for (const line of sourceData.lines) {
      if (!line.partNumber) continue;

      const resolved = await resolvePartNumber(line.partNumber, formData.customerId);
      if (resolved && resolved.partNumberId && !resolved.suggestion) {
        lineItems.push({
          lineNumber: line.lineNumber,
          partNumberId: resolved.partNumberId,
          partNumberPriceId: resolved.partNumberPriceId,
          quantity: line.quantity,
          partNumber: line.partNumber
        });
      } else {
        warn(`No se pudo resolver PN "${line.partNumber}" a un PN exacto de Steelhead`);
      }
    }

    const resolved = lineItems.length;
    const total = sourceData.lines.filter(l => l.partNumber).length;
    log(`${resolved}/${total} PNs resueltos en Steelhead`);

    const receivedOrderLines = lineItems.map(l => ({
      lineNumber: l.lineNumber,
      partNumberId: l.partNumberId,
      quantity: l.quantity,
      partNumberPriceId: l.partNumberPriceId || undefined
    }));

    if (receivedOrderLines.length > 0) {
      log(`Agregando ${receivedOrderLines.length} líneas a la OV...`);
      await api().query('SaveReceivedOrderLinesAndItems', {
        receivedOrderId: ovInternalId,
        receivedOrderLines,
        receivedOrderItems: []
      });
      log('Líneas agregadas exitosamente');
    }

    if (file) {
      try {
        await uploadAndAttachFile(file, ovInternalId);
      } catch (e) {
        warn(`No se pudo adjuntar archivo: ${e.message}`);
      }
    }

    log(`OV #${ovId} creada con ${receivedOrderLines.length} líneas`);
    return ovId;
  }
```

Update `return {` block to add these:

```javascript
  return {
    normalizePN,
    aggressiveNormalizePN,
    normalizeCurrency,
    fuzzyMatchStr,
    escHtml,
    toNumber,
    createOverlay,
    createModal,
    removeOverlay,
    findCandidateOVs,
    uploadAndAttachFile,
    adoptExistingOV,
    fetchCreationData,
    resolvePartNumber,
    createNewOV
  };
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/ov-operations.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/ov-operations.js
git commit -m "feat(ov-operations): extract fetchCreationData, resolvePartNumber, createNewOV"
```

---

### Task 4: Move UI modal functions into ov-operations.js

**Files:**
- Modify: `remote/scripts/ov-operations.js`

- [ ] **Step 1: Add showCandidateSelector, showNoMatchOptions, showCreationWizard**

Insert before the `return {` block. Note: these UIs use the existing `dl9-poc-*` CSS classes which are already injected by `po-comparator.js` via its `injectStyles()`. We rely on that for now — if the portal importer is used without PO Comparator first, the styles may be missing. Task 7 adds a call to `ensureStyles()` at the start of each UI function to handle this.

```javascript
  // ── UI: Candidate Selector ─────────────────────────────────

  function showCandidateSelector(candidates, sourceData) {
    ensureStyles();
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      let listHTML = '';
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const deadline = c.deadline ? new Date(c.deadline).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

        let badges = '';
        if (c.signals.includes('pn_match')) {
          badges += `<span class="badge badge-pn">${c.pnMatchCount} de ${sourceData.lines.length} PNs coinciden</span>`;
        }
        if (c.signals.includes('provisional')) {
          badges += `<span class="badge badge-provisional">Nombre provisional</span>`;
        }
        if (c.signals.includes('name_similar')) {
          badges += `<span class="badge badge-similar">Nombre similar</span>`;
        }

        listHTML += `
          <label class="candidate-item" data-idx="${i}">
            <input type="radio" name="dl9-candidate" value="${i}">
            <div class="candidate-info">
              <div class="candidate-name">#${c.ovId} — ${escHtml(c.ovName)}</div>
              <div class="candidate-detail">${c.lineCount} líneas · Plazo: ${deadline}</div>
              <div class="candidate-badges">${badges}</div>
            </div>
          </label>`;
      }

      listHTML += `
        <label class="candidate-item candidate-create" data-idx="create">
          <input type="radio" name="dl9-candidate" value="create">
          <div class="candidate-info">
            <div class="candidate-name">Ninguna — Crear OV nueva</div>
            <div class="candidate-detail">Crear orden de venta con los datos del archivo</div>
          </div>
        </label>`;

      md.innerHTML = `
        <h2>OV no encontrada por nombre</h2>
        <p class="dl9-sub">Se encontraron ${candidates.length} OV(s) del mismo cliente que podrían ser la correcta. PO del archivo: <strong>${escHtml(sourceData.poNumber || '?')}</strong></p>
        <div class="candidate-list">${listHTML}</div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-cand-cancel">Cancelar</button>
          <button class="dl9-btn dl9-btn-primary" id="dl9-cand-confirm" disabled>Confirmar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      let selected = null;

      md.querySelectorAll('input[name="dl9-candidate"]').forEach(radio => {
        radio.addEventListener('change', () => {
          selected = radio.value;
          md.querySelector('#dl9-cand-confirm').disabled = false;
        });
      });

      md.querySelectorAll('.candidate-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          const radio = item.querySelector('input[type=radio]');
          radio.checked = true;
          radio.dispatchEvent(new Event('change'));
        });
      });

      md.querySelector('#dl9-cand-confirm').addEventListener('click', () => {
        removeOverlay();
        if (selected === 'create') {
          resolve({ action: 'create' });
        } else {
          const idx = parseInt(selected, 10);
          resolve({ action: 'adopt', candidate: candidates[idx] });
        }
      });

      md.querySelector('#dl9-cand-cancel').addEventListener('click', () => {
        removeOverlay();
        resolve(null);
      });
    });
  }

  // ── UI: No-Match Options ───────────────────────────────────

  function showNoMatchOptions(sourceData) {
    ensureStyles();
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      md.innerHTML = `
        <h2>OV no encontrada</h2>
        <p class="dl9-sub">No se encontró OV para PO "${escHtml(sourceData.poNumber || '?')}" y no hay OVs candidatas del cliente.</p>
        <div class="manual-search">
          <input type="text" id="dl9-nm-input" placeholder="Buscar OV por número...">
          <button id="dl9-nm-search">Buscar</button>
        </div>
        <p id="dl9-nm-error" style="color:#ef4444;font-size:12px;margin-top:4px;display:none"></p>
        <div style="text-align:center;margin:16px 0;color:#475569;font-size:12px">— o —</div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-nm-cancel">Cancelar</button>
          <button class="dl9-btn" id="dl9-nm-create" style="background:#f59e0b;color:#0f172a;font-weight:600">Crear OV nueva</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const doSearch = async () => {
        const val = md.querySelector('#dl9-nm-input').value.trim();
        if (!val) return;
        const errEl = md.querySelector('#dl9-nm-error');
        errEl.style.display = 'none';

        const asNum = parseInt(val, 10);
        if (!isNaN(asNum)) {
          removeOverlay();
          resolve({ action: 'manual', orderId: asNum });
          return;
        }

        errEl.textContent = 'Ingresa el idInDomain (numérico) de la OV.';
        errEl.style.display = 'block';
      };

      md.querySelector('#dl9-nm-search').addEventListener('click', doSearch);
      md.querySelector('#dl9-nm-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
      md.querySelector('#dl9-nm-create').addEventListener('click', () => { removeOverlay(); resolve({ action: 'create' }); });
      md.querySelector('#dl9-nm-cancel').addEventListener('click', () => { removeOverlay(); resolve(null); });
    });
  }

  // ── UI: Creation Wizard ────────────────────────────────────

  function showCreationWizard(sourceData, creationData, customerId) {
    ensureStyles();
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      const inferredDivisa = normalizeCurrency(sourceData.currency);
      const inferredRazon = creationData.razonSocialOptions.find(opt =>
        fuzzyMatchStr(opt, sourceData.customer || '')
      ) || '';

      let defaultDeadline = '';
      if (creationData.defaultLeadTime) {
        const lead = creationData.defaultLeadTime;
        const days = (lead.hours || 0) / 24 + (lead.days || 0);
        const d = new Date();
        d.setDate(d.getDate() + Math.max(days, 1));
        defaultDeadline = d.toISOString().split('T')[0];
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 14);
        defaultDeadline = d.toISOString().split('T')[0];
      }

      const contactOpts = creationData.contacts.map(c =>
        `<option value="${c.id}" ${c === creationData.defaultContact ? 'selected' : ''}>${escHtml(c.name)}${c.email ? ' (' + escHtml(c.email) + ')' : ''}</option>`
      ).join('');

      const billToOpts = creationData.addresses.filter(a => a.useForBilling !== false).map(a =>
        `<option value="${a.id}" ${a === creationData.defaultBillTo ? 'selected' : ''}>${escHtml(a.identifier || a.address || 'ID ' + a.id)}</option>`
      ).join('');

      const shipToOpts = creationData.addresses.filter(a => a.useForShipping !== false).map(a =>
        `<option value="${a.id}" ${a === creationData.defaultShipTo ? 'selected' : ''}>${escHtml(a.identifier || a.address || 'ID ' + a.id)}</option>`
      ).join('');

      const divisaOpts = creationData.divisaOptions.map(d =>
        `<option value="${d}" ${d === inferredDivisa ? 'selected' : ''}>${escHtml(d)}</option>`
      ).join('');

      const razonOpts = ['', ...creationData.razonSocialOptions].map(r =>
        `<option value="${escHtml(r)}" ${r === inferredRazon ? 'selected' : ''}>${r || '(seleccione)'}</option>`
      ).join('');

      const verificadoOpts = ['', ...creationData.verificadoOptions].map(v =>
        `<option value="${escHtml(v)}">${v || '(seleccione)'}</option>`
      ).join('');

      const orderTypeOpts = ['MAKE_TO_ORDER', 'MAKE_TO_STOCK', 'INVENTORY'].map(t =>
        `<option value="${t}" ${t === creationData.defaultOrderType ? 'selected' : ''}>${t.replace(/_/g, ' ')}</option>`
      ).join('');

      md.innerHTML = `
        <h2>Crear Orden de Venta</h2>
        <p class="dl9-sub">Se creará una nueva OV con los datos extraídos. Verifica antes de confirmar.</p>
        <div class="wizard-form">
          <div class="wizard-group">Identificación</div>
          <div class="wizard-field"><label>Nombre (PO)</label><input type="text" id="wiz-name" value="${escHtml(sourceData.poNumber || '')}"></div>
          <div class="wizard-field"><label>Tipo de orden</label><select id="wiz-type">${orderTypeOpts}</select></div>

          <div class="wizard-group">Contacto</div>
          <div class="wizard-field"><label>Contacto del cliente</label><select id="wiz-contact">${contactOpts || '<option value="">(sin contactos)</option>'}</select></div>
          <div class="wizard-field"><label>Plazo de entrega</label><input type="date" id="wiz-deadline" value="${defaultDeadline}"></div>

          <div class="wizard-group">Direcciones</div>
          <div class="wizard-field"><label>Dirección de facturación</label><select id="wiz-billto">${billToOpts || '<option value="">(sin direcciones)</option>'}</select></div>
          <div class="wizard-field"><label>Dirección de envío</label><select id="wiz-shipto">${shipToOpts || '<option value="">(sin direcciones)</option>'}</select></div>

          <div class="wizard-group">Términos</div>
          <div class="wizard-field"><label>Invoice terms</label><input type="text" id="wiz-invoiceterms" value="${escHtml(creationData.invoiceTerms?.terms || '')}" data-id="${creationData.invoiceTerms?.id || ''}" readonly style="opacity:0.7"></div>
          <div class="wizard-field"><label>Ship via</label><input type="text" id="wiz-shipvia" value="Flete Propio"></div>

          <div class="wizard-group">Custom inputs</div>
          <div class="wizard-field"><label>Divisa</label><select id="wiz-divisa">${divisaOpts}</select></div>
          <div class="wizard-field"><label>Razón Social Venta</label><select id="wiz-razon">${razonOpts}</select></div>
          <div class="wizard-field"><label>Verificado por</label><select id="wiz-verificado">${verificadoOpts}</select></div>

          <div class="wizard-group">Opciones</div>
          <div class="wizard-field wizard-check"><input type="checkbox" id="wiz-blockpartial"><label for="wiz-blockpartial" style="text-transform:none;font-size:13px">Bloquear envíos parciales</label></div>
          <div class="wizard-field wizard-check"><input type="checkbox" id="wiz-blanket"><label for="wiz-blanket" style="text-transform:none;font-size:13px">Orden abierta (blanket)</label></div>
        </div>
        <p style="font-size:11px;color:#64748b;margin-top:8px">${sourceData.lines.length} líneas del archivo se agregarán automáticamente a la OV.</p>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="wiz-cancel">Cancelar</button>
          <button class="dl9-btn dl9-btn-primary" id="wiz-create">Crear OV</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#wiz-create').addEventListener('click', () => {
        const deadlineDate = md.querySelector('#wiz-deadline').value;
        const deadlineISO = deadlineDate
          ? new Date(deadlineDate + 'T' + creationData.deadlineCutoffTime).toISOString()
          : new Date(Date.now() + 14 * 86400000).toISOString();

        const formData = {
          name: md.querySelector('#wiz-name').value.trim(),
          customerId: parseInt(customerId, 10),
          deadline: deadlineISO,
          customerContactId: parseInt(md.querySelector('#wiz-contact').value, 10) || null,
          billToAddressId: parseInt(md.querySelector('#wiz-billto').value, 10) || null,
          shipToAddressId: parseInt(md.querySelector('#wiz-shipto').value, 10) || null,
          invoiceTermsId: parseInt(md.querySelector('#wiz-invoiceterms').dataset.id, 10) || null,
          shipVia: md.querySelector('#wiz-shipvia').value.trim(),
          type: md.querySelector('#wiz-type').value,
          blockPartialShipments: md.querySelector('#wiz-blockpartial').checked,
          isBlanketOrder: md.querySelector('#wiz-blanket').checked,
          sectorId: creationData.sector?.id || null,
          inputSchemaId: creationData.inputSchemaId,
          customInputs: {
            Divisa: md.querySelector('#wiz-divisa').value,
            RazonSocialVenta: md.querySelector('#wiz-razon').value,
            VerificadaPor: md.querySelector('#wiz-verificado').value
          }
        };

        for (const key of Object.keys(formData)) {
          if (formData[key] === null || formData[key] === '' || Number.isNaN(formData[key])) {
            delete formData[key];
          }
        }

        removeOverlay();
        resolve(formData);
      });

      md.querySelector('#wiz-cancel').addEventListener('click', () => {
        removeOverlay();
        resolve(null);
      });
    });
  }

  // Placeholder — ensureStyles defined in Task 7, but referenced here.
  // Use a no-op until that task lands.
  function ensureStyles() { /* populated in Task 7 */ }
```

Update `return {` block:

```javascript
  return {
    normalizePN, aggressiveNormalizePN, normalizeCurrency, fuzzyMatchStr,
    escHtml, toNumber, createOverlay, createModal, removeOverlay,
    findCandidateOVs, uploadAndAttachFile, adoptExistingOV,
    fetchCreationData, resolvePartNumber, createNewOV,
    showCandidateSelector, showNoMatchOptions, showCreationWizard
  };
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/ov-operations.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/ov-operations.js
git commit -m "feat(ov-operations): extract showCandidateSelector, showNoMatchOptions, showCreationWizard"
```

---

### Task 5: Refactor po-comparator.js to use OVOperations

**Files:**
- Modify: `remote/scripts/po-comparator.js`

- [ ] **Step 1: Remove the extracted functions from po-comparator.js**

In `remote/scripts/po-comparator.js`, delete these function definitions entirely (they are now in `ov-operations.js`):

- `findCandidateOVs`
- `showCandidateSelector`
- `uploadAndAttachPDF` (renamed to `uploadAndAttachFile` in the shared module)
- `adoptExistingOV`
- `fetchCreationData`
- `showCreationWizard`
- `createNewOV`
- `showNoMatchOptions`
- The `PROVISIONAL_NAME_RE` constant

Also delete the duplicate helpers that now live in OVOperations (keep only the ones still used by PO Comparator's other functions — don't delete helpers used elsewhere in the file).

- [ ] **Step 2: Replace call sites with OVOperations calls**

Inside `processOneFile`, replace calls:

Change `await findCandidateOVs(pdfData, customerId)` → `await window.OVOperations.findCandidateOVs(pdfData, customerId)`
Change `await showCandidateSelector(candidates, pdfData)` → `await window.OVOperations.showCandidateSelector(candidates, pdfData)`
Change `await adoptExistingOV(selection.candidate, pdfData, file)` → `await window.OVOperations.adoptExistingOV(selection.candidate, pdfData, file)`
Change `await fetchCreationData(customerId)` → `await window.OVOperations.fetchCreationData(customerId)`
Change `await showCreationWizard(pdfData, creationData, customerId)` → `await window.OVOperations.showCreationWizard(pdfData, creationData, customerId)`
Change `await createNewOV(formData, pdfData, file)` → `await window.OVOperations.createNewOV(formData, pdfData, file)`
Change `await showNoMatchOptions(pdfData)` → `await window.OVOperations.showNoMatchOptions(pdfData)`

Also: the `pdfData` object should include `sourceType: 'pdf'` and `fileName: file.name` for consistency with the shared module. Update `parsePDF` return to include these:

At the end of `parsePDF`, before the final `return parsed;`:

```javascript
    parsed.sourceType = 'pdf';
```

And in `processOneFile`, after `pdfData = await parsePDF(file);` add:

```javascript
    pdfData.fileName = file.name;
```

- [ ] **Step 3: Update public exports**

Change the `return {` block at the end of the IIFE to remove the exports that moved:

```javascript
  return {
    run,
    runWithUI,
    parsePDF,
    findSalesOrder,
    loadSalesOrder,
    compareOrders,
    getCustomerIdFromURL,
    checkAttachedPDF,
    loadDiscrepancyData,
    matchLinesByPN
  };
```

- [ ] **Step 4: Verify syntax**

Run: `node --check remote/scripts/po-comparator.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "refactor(po-comparator): use OVOperations shared module"
```

---

### Task 6: Update config.json — categories, scripts, portalLayouts

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Split categories**

In `remote/config.json`:

1. For `inventory-reset` app (around line 254), change `"category": "Inventario & Facturación"` to `"category": "Inventario"`.
2. For `po-comparator` app (around line 265), change `"category": "Inventario & Facturación"` to `"category": "Facturación"`.
3. For `cfdi-attacher` app (around line 287), change `"category": "Inventario & Facturación"` to `"category": "Facturación"`.

- [ ] **Step 2: Add ov-operations.js to scripts list of po-comparator**

In the `po-comparator` app entry, change:

```json
"scripts": ["scripts/steelhead-api.js", "scripts/claude-api.js", "scripts/po-comparator.js"],
```

to:

```json
"scripts": ["scripts/steelhead-api.js", "scripts/claude-api.js", "scripts/ov-operations.js", "scripts/po-comparator.js"],
```

- [ ] **Step 3: Add portal-importer app entry**

In `remote/config.json`, after the `cfdi-attacher` app entry (closing `},` around line 295), add this new app entry:

```json
    {
      "id": "portal-importer",
      "name": "Importador de Portales",
      "subtitle": "Subir XLS de portales de clientes (Hubbell, etc.)",
      "icon": "📥",
      "category": "Facturación",
      "scripts": ["scripts/steelhead-api.js", "scripts/claude-api.js", "scripts/lib/xlsx.full.min.js", "scripts/ov-operations.js", "scripts/portal-importer.js"],
      "actions": [
        { "id": "run-portal-importer", "label": "Importar Portal", "sublabel": "Subir XLS y procesar POs", "icon": "📥", "type": "primary", "handler": "message", "message": "run-portal-importer" }
      ]
    },
```

- [ ] **Step 4: Add portalLayouts section**

In `remote/config.json`, at the root level (after `"steelhead": {...}` closes and before `"apps": [`), add this top-level key:

```json
  "portalLayouts": {
    "hubbell": {
      "name": "Hubbell Portal",
      "detection": {
        "requiredColumns": [
          "number", "status", "lineItem.itemNumber",
          "lineItem.materialCodeBuyer", "lineItem.materialDescription",
          "lineItem.netPrice", "lineItem.priceUnit",
          "lineItem.targetQuantity", "lineItem.schedule.deliveryDate"
        ],
        "minMatchRatio": 0.9
      },
      "mapping": {
        "poNumber": "number",
        "status": "status",
        "customer": "customerAddressName",
        "currency": "currency",
        "date": "date",
        "lineNumber": "lineItem.itemNumber",
        "buyerCode": "lineItem.materialCodeBuyer",
        "description": "lineItem.materialDescription",
        "netPrice": "lineItem.netPrice",
        "priceUnit": "lineItem.priceUnit",
        "quantity": "lineItem.targetQuantity",
        "deliveryDate": "lineItem.schedule.deliveryDate",
        "unit": "lineItem.unit"
      },
      "pnExtractor": {
        "type": "regex",
        "source": "description",
        "patterns": [
          "(?:Catalog|CATALOGO|CAT)\\s*[:=]\\s*(\\S+)",
          "(?:Material\\s*Number|MATERIAL)\\s*[:=]\\s*(\\S+)"
        ]
      },
      "statusFilter": { "activeValues": ["Nuevo"] },
      "unitPriceFormula": "netPrice / priceUnit"
    }
  },
```

- [ ] **Step 5: Verify JSON**

Run: `python3 -c "import json; json.load(open('remote/config.json'))"`
Expected: exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add remote/config.json
git commit -m "feat(config): split categories, register portal-importer, add Hubbell layout"
```

---

### Task 7: Add shared styles and source file viewer helper

**Files:**
- Modify: `remote/scripts/ov-operations.js`

- [ ] **Step 1: Add ensureStyles + addSourceFileButton**

In `remote/scripts/ov-operations.js`, replace the placeholder `function ensureStyles() { /* populated in Task 7 */ }` with this implementation, and add the source file viewer helper before it:

```javascript
  // ── Styles ────────────────────────────────────────────────

  function ensureStyles() {
    if (document.getElementById('dl9-ovop-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl9-ovop-styles';
    s.textContent = `
      .dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .dl9-poc-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:1080px;width:97%;max-height:92vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5);position:relative}
      .dl9-poc-modal h2{color:#38bdf8;font-size:18px;margin-bottom:4px}
      .dl9-poc-modal .dl9-sub{color:#64748b;font-size:13px;margin-bottom:12px}
      .dl9-poc-modal .dl9-btnrow{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
      .dl9-poc-modal .dl9-btn{padding:9px 18px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer}
      .dl9-poc-modal .dl9-btn-primary{background:#38bdf8;color:#0f172a}
      .dl9-poc-modal .dl9-btn-cancel{background:#475569;color:#e2e8f0}
      .dl9-poc-modal .manual-search{display:flex;gap:6px;margin:8px 0}
      .dl9-poc-modal .manual-search input{flex:1;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px}
      .dl9-poc-modal .manual-search button{padding:8px 16px;border:none;border-radius:6px;background:#38bdf8;color:#0f172a;font-weight:600;font-size:13px;cursor:pointer}
      .dl9-poc-modal .candidate-list{display:flex;flex-direction:column;gap:6px;margin:12px 0;max-height:320px;overflow-y:auto}
      .dl9-poc-modal .candidate-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:#0f172a;border:1px solid #334155;cursor:pointer;transition:border-color 0.15s}
      .dl9-poc-modal .candidate-item:hover{border-color:#38bdf8}
      .dl9-poc-modal .candidate-item input[type=radio]{accent-color:#38bdf8;width:16px;height:16px;flex-shrink:0}
      .dl9-poc-modal .candidate-info{flex:1;min-width:0}
      .dl9-poc-modal .candidate-name{font-weight:600;font-size:13px;color:#e2e8f0}
      .dl9-poc-modal .candidate-detail{font-size:11px;color:#64748b;margin-top:2px}
      .dl9-poc-modal .candidate-badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
      .dl9-poc-modal .badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600}
      .dl9-poc-modal .badge-pn{background:rgba(239,68,68,0.15);color:#f87171}
      .dl9-poc-modal .badge-provisional{background:rgba(250,204,21,0.15);color:#facc15}
      .dl9-poc-modal .badge-similar{background:rgba(52,211,153,0.15);color:#34d399}
      .dl9-poc-modal .candidate-create{border-style:dashed;border-color:#475569}
      .dl9-poc-modal .candidate-create:hover{border-color:#f59e0b}
      .dl9-poc-modal .wizard-form{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;margin:16px 0}
      .dl9-poc-modal .wizard-form .full-width{grid-column:1/-1}
      .dl9-poc-modal .wizard-field{display:flex;flex-direction:column;gap:3px}
      .dl9-poc-modal .wizard-field label{font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
      .dl9-poc-modal .wizard-field input,.dl9-poc-modal .wizard-field select{padding:8px 10px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px}
      .dl9-poc-modal .wizard-field input:focus,.dl9-poc-modal .wizard-field select:focus{outline:none;border-color:#38bdf8}
      .dl9-poc-modal .wizard-group{grid-column:1/-1;font-size:12px;color:#38bdf8;font-weight:600;margin-top:8px;padding-bottom:4px;border-bottom:1px solid #1e293b}
      .dl9-poc-modal .wizard-field input[type=checkbox]{width:16px;height:16px;accent-color:#38bdf8}
      .dl9-poc-modal .wizard-check{flex-direction:row;align-items:center;gap:8px}
      .dl9-source-btn{position:absolute;top:12px;right:16px;background:#0f172a;color:#38bdf8;border:1px solid #38bdf8;padding:6px 12px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;z-index:10}
      .dl9-source-btn:hover{background:#38bdf8;color:#0f172a}
      .dl9-suggestion-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:#0f172a;border:1px solid #334155;margin-bottom:6px}
      .dl9-suggestion-item input[type=checkbox]{accent-color:#38bdf8;width:16px;height:16px}
      .dl9-suggestion-text{flex:1;font-size:12px}
      .dl9-suggestion-text .code{background:#1e293b;padding:2px 6px;border-radius:3px;color:#fbbf24;font-family:monospace}
      .dl9-audit-table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0}
      .dl9-audit-table th,.dl9-audit-table td{padding:8px;text-align:left;border-bottom:1px solid #334155}
      .dl9-audit-table th{color:#94a3b8;text-transform:uppercase;font-size:10px;letter-spacing:0.5px}
      .dl9-audit-table tbody tr:hover{background:rgba(56,189,248,0.05)}
      .dl9-audit-table select{padding:4px 6px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px}
    `;
    document.head.appendChild(s);
  }

  // ── Source File Viewer ────────────────────────────────────

  // Shared state — single window across the whole session
  let sourceFileWindow = null;
  let sourceFileBlobUrl = null;

  function addSourceFileButton(modal, file, parsedData) {
    if (!file) return;

    const btn = document.createElement('button');
    btn.className = 'dl9-source-btn';
    btn.textContent = '📎 Ver archivo fuente';
    btn.addEventListener('click', () => openSourceFile(file, parsedData));
    modal.appendChild(btn);
  }

  function openSourceFile(file, parsedData) {
    // Reuse existing window if still open
    if (sourceFileWindow && !sourceFileWindow.closed) {
      sourceFileWindow.focus();
      return;
    }

    const isPDF = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

    if (isPDF) {
      if (sourceFileBlobUrl) URL.revokeObjectURL(sourceFileBlobUrl);
      sourceFileBlobUrl = URL.createObjectURL(file);
      const left = Math.max(0, window.screen.availWidth - 860);
      sourceFileWindow = window.open(sourceFileBlobUrl, 'sa-source-file', `width=840,height=${window.screen.availHeight - 40},left=${left},top=20`);
    } else {
      // XLS — render parsed data as HTML table
      const html = buildXLSViewerHTML(file, parsedData);
      const left = Math.max(0, window.screen.availWidth - 1000);
      sourceFileWindow = window.open('', 'sa-source-file', `width=980,height=${window.screen.availHeight - 40},left=${left},top=20`);
      if (sourceFileWindow) {
        sourceFileWindow.document.write(html);
        sourceFileWindow.document.close();
      }
    }
  }

  function buildXLSViewerHTML(file, parsedData) {
    if (!parsedData || !Array.isArray(parsedData.rows) || !Array.isArray(parsedData.headers)) {
      return `<html><body style="font-family:sans-serif;padding:20px">Sin datos parseados para mostrar.<br>Archivo: ${escHtml(file.name)}</body></html>`;
    }

    const poColors = {};
    const palette = ['#fef3c7', '#dbeafe', '#fce7f3', '#dcfce7', '#ede9fe', '#fee2e2', '#e0f2fe', '#fef9c3'];
    let colorIdx = 0;

    const headerHTML = parsedData.headers.map(h => `<th>${escHtml(h)}</th>`).join('');

    const rowsHTML = parsedData.rows.map(row => {
      const poCol = parsedData.poColumnIndex != null ? parsedData.poColumnIndex : 0;
      const po = row[poCol];
      if (!(po in poColors)) {
        poColors[po] = palette[colorIdx % palette.length];
        colorIdx++;
      }
      const bg = poColors[po];
      const cells = row.map(c => `<td>${escHtml(String(c == null ? '' : c).substring(0, 100))}</td>`).join('');
      return `<tr style="background:${bg}">${cells}</tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><title>${escHtml(file.name)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:0;background:#fafafa}
  .hdr{position:sticky;top:0;background:#1e293b;color:#fff;padding:10px 16px;z-index:2;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
  .hdr h1{margin:0;font-size:14px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th,td{padding:6px 10px;border:1px solid #e5e7eb;text-align:left;white-space:nowrap;overflow:hidden;max-width:280px;text-overflow:ellipsis}
  thead{position:sticky;top:36px;background:#f3f4f6;z-index:1}
  th{font-weight:700;color:#374151}
  tr:hover td{background:rgba(56,189,248,0.1)!important}
</style>
</head><body>
<div class="hdr"><h1>${escHtml(file.name)} — ${parsedData.rows.length} filas</h1></div>
<table><thead><tr>${headerHTML}</tr></thead><tbody>${rowsHTML}</tbody></table>
</body></html>`;
  }
```

Update `return {` block to include `addSourceFileButton`:

```javascript
  return {
    normalizePN, aggressiveNormalizePN, normalizeCurrency, fuzzyMatchStr,
    escHtml, toNumber, createOverlay, createModal, removeOverlay,
    findCandidateOVs, uploadAndAttachFile, adoptExistingOV,
    fetchCreationData, resolvePartNumber, createNewOV,
    showCandidateSelector, showNoMatchOptions, showCreationWizard,
    addSourceFileButton, ensureStyles
  };
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/ov-operations.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/ov-operations.js
git commit -m "feat(ov-operations): add shared styles and source file viewer helper"
```

---

### Task 8: Add fuzzy match suggestions modal to ov-operations.js

**Files:**
- Modify: `remote/scripts/ov-operations.js`

- [ ] **Step 1: Add showSuggestionsModal and applySuggestions**

Insert before the `return {` block in `remote/scripts/ov-operations.js`:

```javascript
  // ── PN Rename Suggestions ──────────────────────────────────

  function showSuggestionsModal(suggestions) {
    ensureStyles();
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      if (!suggestions || suggestions.length === 0) {
        resolve([]);
        return;
      }

      let itemsHTML = '';
      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        itemsHTML += `
          <div class="dl9-suggestion-item">
            <input type="checkbox" id="sug-${i}" data-idx="${i}">
            <div class="dl9-suggestion-text">
              Cliente dice: <span class="code">${escHtml(s.suggestedName)}</span><br>
              Steelhead tiene: <span class="code">${escHtml(s.currentName)}</span> (PN #${s.partNumberId})<br>
              <label for="sug-${i}" style="color:#94a3b8">Renombrar en Steelhead a "${escHtml(s.suggestedName)}"</label>
            </div>
          </div>`;
      }

      md.innerHTML = `
        <h2>Sugerencias de corrección de PN</h2>
        <p class="dl9-sub">Se encontraron ${suggestions.length} PN(s) con variaciones menores. Corregirlos en Steelhead evita futuras discrepancias.</p>
        <div style="max-height:400px;overflow-y:auto;margin:12px 0">${itemsHTML}</div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sug-skip">Saltar todas</button>
          <button class="dl9-btn dl9-btn-primary" id="sug-apply">Aplicar seleccionadas</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#sug-skip').addEventListener('click', () => {
        removeOverlay();
        resolve([]);
      });

      md.querySelector('#sug-apply').addEventListener('click', async () => {
        const selected = [];
        md.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
          selected.push(suggestions[parseInt(cb.dataset.idx, 10)]);
        });

        if (selected.length === 0) {
          removeOverlay();
          resolve([]);
          return;
        }

        md.querySelector('#sug-apply').disabled = true;
        md.querySelector('#sug-apply').textContent = 'Aplicando...';

        const applied = [];
        for (const s of selected) {
          try {
            await api().query('UpdatePartNumber', {
              id: s.partNumberId,
              name: s.suggestedName
            });
            applied.push(s);
            log(`PN renombrado: "${s.currentName}" → "${s.suggestedName}"`);
          } catch (e) {
            warn(`Error renombrando PN ${s.partNumberId}: ${e.message}`);
          }
        }

        removeOverlay();
        resolve(applied);
      });
    });
  }
```

Update `return {`:

```javascript
  return {
    normalizePN, aggressiveNormalizePN, normalizeCurrency, fuzzyMatchStr,
    escHtml, toNumber, createOverlay, createModal, removeOverlay,
    findCandidateOVs, uploadAndAttachFile, adoptExistingOV,
    fetchCreationData, resolvePartNumber, createNewOV,
    showCandidateSelector, showNoMatchOptions, showCreationWizard,
    addSourceFileButton, ensureStyles, showSuggestionsModal
  };
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/ov-operations.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/ov-operations.js
git commit -m "feat(ov-operations): add PN rename suggestions modal"
```

---

### Task 9: Create portal-importer.js scaffold — parse, detect, group

**Files:**
- Create: `remote/scripts/portal-importer.js`

- [ ] **Step 1: Create the initial applet file**

Create `remote/scripts/portal-importer.js` with this exact content:

```javascript
// Portal Importer — XLS de portales de clientes (Hubbell, etc.)
// Depends on: SteelheadAPI, ClaudeAPI, OVOperations, XLSX (SheetJS)

const PortalImporter = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const claude = () => window.ClaudeAPI;
  const ops = () => window.OVOperations;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  const MAPPING_STORAGE_KEY = 'sa_pn_mapping';

  // ── XLS Parsing ────────────────────────────────────────────

  async function parseXLS(file) {
    if (!window.XLSX) throw new Error('SheetJS (XLSX) no cargado');

    log(`Leyendo XLS: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    if (!firstSheet) throw new Error('El XLS no tiene hojas');

    const aoa = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
    if (aoa.length < 2) throw new Error('El XLS no tiene filas de datos');

    const headers = aoa[0].map(h => String(h).trim());
    const rows = aoa.slice(1).filter(r => r.some(c => c !== ''));

    log(`XLS parseado: ${headers.length} columnas, ${rows.length} filas`);

    return { headers, rows };
  }

  // ── Layout Detection ──────────────────────────────────────

  function detectLayout(headers) {
    const cfg = window.REMOTE_CONFIG || {};
    const layouts = cfg.portalLayouts || {};

    let bestLayoutId = null;
    let bestRatio = 0;

    for (const [id, layout] of Object.entries(layouts)) {
      const required = layout.detection?.requiredColumns || [];
      if (required.length === 0) continue;

      const matched = required.filter(col => headers.includes(col)).length;
      const ratio = matched / required.length;

      if (ratio >= (layout.detection.minMatchRatio || 0.9) && ratio > bestRatio) {
        bestLayoutId = id;
        bestRatio = ratio;
      }
    }

    if (bestLayoutId) {
      log(`Layout detectado: ${bestLayoutId} (${(bestRatio * 100).toFixed(0)}% coincidencia)`);
      return { id: bestLayoutId, layout: layouts[bestLayoutId], ratio: bestRatio };
    }

    log('No se detectó ningún layout conocido');
    return null;
  }

  // ── Data Extraction Using Layout Mapping ──────────────────

  function extractRowData(row, headers, mapping) {
    const data = {};
    for (const [key, colName] of Object.entries(mapping)) {
      const idx = headers.indexOf(colName);
      data[key] = idx >= 0 ? row[idx] : null;
    }
    return data;
  }

  function extractPN(description, pnExtractor) {
    if (!description) return null;
    if (!pnExtractor || pnExtractor.type !== 'regex') return null;

    const patterns = pnExtractor.patterns || [];
    for (const patternStr of patterns) {
      try {
        const re = new RegExp(patternStr);
        const match = String(description).match(re);
        if (match && match[1]) return match[1].trim();
      } catch (e) {
        warn(`Regex inválido: ${patternStr}`);
      }
    }
    return null;
  }

  // ── Group rows by PO ──────────────────────────────────────

  function groupByPO(rows, headers, layout) {
    const mapping = layout.mapping;
    const poMap = new Map();

    for (const row of rows) {
      const rowData = extractRowData(row, headers, mapping);
      const poNumber = rowData.poNumber;
      if (!poNumber) continue;

      const pnExtracted = extractPN(rowData.description, layout.pnExtractor);

      const netPrice = ops().toNumber(String(rowData.netPrice).replace(',', '.'));
      const priceUnit = ops().toNumber(rowData.priceUnit) || 1;
      const unitPrice = netPrice != null ? netPrice / priceUnit : null;

      const lineObj = {
        lineNumber: rowData.lineNumber,
        buyerCode: rowData.buyerCode,
        partNumber: pnExtracted,
        description: rowData.description,
        quantity: ops().toNumber(String(rowData.quantity).replace(',', '.')),
        unitPrice,
        netPrice,
        priceUnit,
        unit: rowData.unit,
        deliveryDate: rowData.deliveryDate
      };

      if (!poMap.has(poNumber)) {
        poMap.set(poNumber, {
          poNumber,
          status: rowData.status,
          customer: rowData.customer,
          currency: rowData.currency,
          date: rowData.date,
          lines: [],
          sourceType: 'xls'
        });
      }
      poMap.get(poNumber).lines.push(lineObj);
    }

    const pos = Array.from(poMap.values());
    log(`${pos.length} POs detectados en el archivo`);
    return pos;
  }

  // Public API — populated in later tasks
  async function runWithUI() {
    log('=== Portal Importer iniciando ===');
    alert('Portal Importer — implementación en progreso.');
  }

  return {
    runWithUI,
    parseXLS,
    detectLayout,
    groupByPO,
    extractPN,
    extractRowData
  };
})();

window.PortalImporter = PortalImporter;
```

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/portal-importer.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/portal-importer.js
git commit -m "feat(portal-importer): scaffold with XLS parsing, layout detection, PO grouping"
```

---

### Task 10: Portal importer — mapping table + message handler

**Files:**
- Modify: `remote/scripts/portal-importer.js`
- Modify: `extension/background.js` (verify message routing)

- [ ] **Step 1: Add mapping table helpers**

In `remote/scripts/portal-importer.js`, insert these functions before the `async function runWithUI()` line:

```javascript
  // ── Mapping Table (chrome.storage.local) ──────────────────

  function getMappingKey(customerId, layoutId) {
    return `${customerId || 'unknown'}-${layoutId}`;
  }

  async function loadMappingTable() {
    return new Promise((resolve) => {
      if (!window.chrome?.storage?.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get([MAPPING_STORAGE_KEY], (result) => {
        resolve(result[MAPPING_STORAGE_KEY] || {});
      });
    });
  }

  async function saveMappingEntry(customerId, layoutId, buyerCode, pnName) {
    const table = await loadMappingTable();
    const key = getMappingKey(customerId, layoutId);
    if (!table[key]) table[key] = {};
    table[key][String(buyerCode)] = pnName;

    return new Promise((resolve) => {
      if (!window.chrome?.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [MAPPING_STORAGE_KEY]: table }, resolve);
    });
  }

  async function getMappedPN(customerId, layoutId, buyerCode) {
    if (!buyerCode) return null;
    const table = await loadMappingTable();
    const key = getMappingKey(customerId, layoutId);
    return table[key]?.[String(buyerCode)] || null;
  }
```

- [ ] **Step 2: Add enrichLinesWithMapping helper**

Insert this function right after `getMappedPN` in `portal-importer.js`:

```javascript
  // Enrich each line's `partNumber` with mapped PN from chrome.storage when buyerCode has a known mapping.
  // Mutates pos in place.
  async function enrichLinesWithMapping(pos, customerId, layoutId) {
    if (!customerId || !layoutId) return;

    for (const po of pos) {
      for (const line of po.lines) {
        if (!line.buyerCode) continue;
        const mapped = await getMappedPN(customerId, layoutId, line.buyerCode);
        if (mapped) {
          line.partNumber = mapped;
          line._pnSource = 'mapping';
        } else if (line.partNumber) {
          line._pnSource = 'regex';
        }
      }
    }
  }

  // Persist a successful PN resolution for future reuse.
  async function recordSuccessfulMapping(line, customerId, layoutId) {
    if (!customerId || !layoutId || !line.buyerCode || !line.partNumber) return;
    if (line._pnSource === 'mapping') return; // Already from mapping
    try {
      await saveMappingEntry(customerId, layoutId, line.buyerCode, line.partNumber);
    } catch (e) {
      warn(`No se pudo guardar mapeo ${line.buyerCode} → ${line.partNumber}: ${e.message}`);
    }
  }
```

- [ ] **Step 3: Update return block**

Add the new functions to the `return {` block at the end of the IIFE:

```javascript
  return {
    runWithUI,
    parseXLS,
    detectLayout,
    groupByPO,
    extractPN,
    extractRowData,
    loadMappingTable,
    saveMappingEntry,
    getMappedPN,
    enrichLinesWithMapping,
    recordSuccessfulMapping
  };
```

- [ ] **Step 4: Verify background.js handles the message**

Read `extension/background.js`. Search for how other `handler: "message"` actions (e.g., `run-inventory-reset`) are routed. If the dispatch pattern uses the `message` field to call `Applet.runWithUI()`, verify that adding `run-portal-importer` follows the same convention.

If the dispatch is generic (pattern-based calling `{AppletName}.runWithUI()`), no changes needed — `portal-importer` message will route to `PortalImporter.runWithUI()`.

If background.js has hardcoded routing per app, add a case for `run-portal-importer` that calls `window.PortalImporter.runWithUI()`.

- [ ] **Step 5: Verify syntax**

Run: `node --check remote/scripts/portal-importer.js`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/portal-importer.js extension/background.js
git commit -m "feat(portal-importer): add chrome.storage.local mapping table helpers"
```

---

### Task 11: Portal importer — file picker + layout confirmation UI

**Files:**
- Modify: `remote/scripts/portal-importer.js`

- [ ] **Step 1: Implement showFilePicker and showLayoutConfirmation**

In `remote/scripts/portal-importer.js`, replace the stub `async function runWithUI()` with the following code plus the new UI helpers. Insert before `runWithUI`:

```javascript
  // ── UI: File Picker ────────────────────────────────────────

  function showFilePicker() {
    ops().ensureStyles();
    return new Promise(resolve => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      md.innerHTML = `
        <h2>Importar archivo de portal</h2>
        <p class="dl9-sub">Sube un XLS o XLSX exportado del portal del cliente (Hubbell, etc.).</p>
        <div id="pi-dropzone" style="border:2px dashed #475569;border-radius:10px;padding:40px;text-align:center;cursor:pointer;color:#94a3b8">
          <p style="margin:0 0 8px 0;font-size:14px">📥 Arrastra el archivo aquí o haz clic</p>
          <p style="margin:0;font-size:11px;color:#64748b">Formatos soportados: .xls, .xlsx</p>
          <input type="file" id="pi-file" accept=".xls,.xlsx" style="display:none">
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-cancel">Cancelar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const dz = md.querySelector('#pi-dropzone');
      const fi = md.querySelector('#pi-file');

      dz.addEventListener('click', () => fi.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.style.borderColor = '#38bdf8'; });
      dz.addEventListener('dragleave', () => { dz.style.borderColor = '#475569'; });
      dz.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) { ops().removeOverlay(); resolve(f); }
      });
      fi.addEventListener('change', () => {
        const f = fi.files?.[0];
        if (f) { ops().removeOverlay(); resolve(f); }
      });
      md.querySelector('#pi-cancel').addEventListener('click', () => { ops().removeOverlay(); resolve(null); });
    });
  }

  // ── UI: Layout Confirmation ────────────────────────────────

  function showLayoutConfirmation(detection, headers) {
    ops().ensureStyles();
    return new Promise(resolve => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      const isDetected = detection != null;
      const title = isDetected
        ? `Layout detectado: <span style="color:#34d399">${ops().escHtml(detection.layout.name)}</span>`
        : 'Layout no reconocido';
      const body = isDetected
        ? `<p class="dl9-sub">Coincidencia: ${(detection.ratio * 100).toFixed(0)}%. ¿Procesar con este layout?</p>`
        : `<p class="dl9-sub">No se encontró un layout conocido para las ${headers.length} columnas del archivo. ¿Usar Claude para inferir el mapeo?</p>`;

      md.innerHTML = `
        <h2>${title}</h2>
        ${body}
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-lc-cancel">Cancelar</button>
          ${isDetected ? `<button class="dl9-btn" id="pi-lc-claude" style="background:#475569;color:#e2e8f0">Usar Claude en su lugar</button>` : ''}
          <button class="dl9-btn dl9-btn-primary" id="pi-lc-confirm">${isDetected ? 'Sí, procesar' : 'Usar Claude'}</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#pi-lc-confirm').addEventListener('click', () => {
        ops().removeOverlay();
        resolve(isDetected ? 'detected' : 'claude');
      });
      if (isDetected) {
        md.querySelector('#pi-lc-claude').addEventListener('click', () => { ops().removeOverlay(); resolve('claude'); });
      }
      md.querySelector('#pi-lc-cancel').addEventListener('click', () => { ops().removeOverlay(); resolve(null); });
    });
  }

  // ── UI: Mode Selector ──────────────────────────────────────

  function showModeSelector(pos) {
    ops().ensureStyles();
    return new Promise(resolve => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      md.innerHTML = `
        <h2>${pos.length} PO(s) detectados</h2>
        <p class="dl9-sub">Elige cómo procesarlos.</p>
        <div style="display:flex;flex-direction:column;gap:8px;margin:16px 0">
          <button class="dl9-btn dl9-btn-primary" id="pi-mode-single" style="padding:16px;text-align:left">
            <div style="font-weight:700">Validar una OV específica</div>
            <div style="font-size:11px;opacity:0.85;margin-top:2px">Elige un PO del archivo y ejecuta el flujo completo de validación (igual que con PDF).</div>
          </button>
          <button class="dl9-btn" id="pi-mode-bulk" style="padding:16px;text-align:left;background:#475569;color:#e2e8f0">
            <div style="font-weight:700">Auditoría en batch</div>
            <div style="font-size:11px;opacity:0.85;margin-top:2px">Ver todos los POs en una tabla y procesar varios de una vez.</div>
          </button>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-mode-cancel">Cancelar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#pi-mode-single').addEventListener('click', () => { ops().removeOverlay(); resolve('single'); });
      md.querySelector('#pi-mode-bulk').addEventListener('click', () => { ops().removeOverlay(); resolve('bulk'); });
      md.querySelector('#pi-mode-cancel').addEventListener('click', () => { ops().removeOverlay(); resolve(null); });
    });
  }
```

- [ ] **Step 2: Implement runWithUI orchestration**

Replace the stub `async function runWithUI()` with this:

```javascript
  async function runWithUI() {
    log('=== Portal Importer iniciando ===');
    claude().resetUsage();

    const file = await showFilePicker();
    if (!file) { log('Cancelado en file picker'); return { cancelled: true }; }

    let parsed;
    try {
      parsed = await parseXLS(file);
    } catch (e) {
      alert('Error leyendo XLS: ' + e.message);
      return { error: e.message };
    }

    const detection = detectLayout(parsed.headers);
    const choice = await showLayoutConfirmation(detection, parsed.headers);
    if (!choice) return { cancelled: true };

    let layout;
    let layoutId;
    if (choice === 'detected' && detection) {
      layout = detection.layout;
      layoutId = detection.id;
    } else {
      // Claude inference fallback — for now, abort with message; implemented in Task 12
      alert('Inferencia con Claude no implementada aún. Por favor usa un layout conocido.');
      return { error: 'claude fallback not implemented' };
    }

    const pos = groupByPO(parsed.rows, parsed.headers, layout);
    if (pos.length === 0) {
      alert('No se detectaron POs en el archivo.');
      return { error: 'no POs' };
    }

    // Enrich lines with stored mapping table entries (buyerCode → known PN)
    const customerIdForMapping = window.POComparator?.getCustomerIdFromURL() || null;
    await enrichLinesWithMapping(pos, customerIdForMapping, layoutId);

    const mode = await showModeSelector(pos);
    if (!mode) return { cancelled: true };

    // Store parsedData for source viewer (with PO column index)
    const poColumnIndex = parsed.headers.indexOf(layout.mapping.poNumber);
    const parsedData = { headers: parsed.headers, rows: parsed.rows, poColumnIndex };

    if (mode === 'single') {
      alert('Modo single — implementado en Task 13.');
      return { todo: 'single mode' };
    } else {
      alert('Modo bulk — implementado en Task 14.');
      return { todo: 'bulk mode' };
    }
  }
```

- [ ] **Step 3: Verify syntax**

Run: `node --check remote/scripts/portal-importer.js`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/portal-importer.js
git commit -m "feat(portal-importer): file picker, layout confirmation, mode selector UIs"
```

---

### Task 12: Portal importer — Claude fallback for unknown layouts

**Files:**
- Modify: `remote/scripts/portal-importer.js`

- [ ] **Step 1: Add inferLayoutWithClaude**

In `remote/scripts/portal-importer.js`, insert before `async function runWithUI()`:

```javascript
  // ── Claude Fallback for Unknown Layouts ───────────────────

  const LAYOUT_INFERENCE_PROMPT = `Analiza los headers y filas de muestra de un XLS de un portal de cliente que contiene órdenes de compra.

Responde SOLAMENTE con un JSON válido (sin markdown) con esta estructura:
{
  "mapping": {
    "poNumber": "nombre de columna con el número de PO",
    "status": "nombre de columna con status (o null)",
    "customer": "nombre de columna con razón social del cliente (o null)",
    "currency": "nombre de columna con divisa (o null)",
    "date": "nombre de columna con fecha del PO (o null)",
    "lineNumber": "nombre de columna con número de línea",
    "buyerCode": "nombre de columna con código interno del cliente (o null)",
    "description": "nombre de columna con descripción del material",
    "netPrice": "nombre de columna con precio neto",
    "priceUnit": "nombre de columna con la unidad de precio (ej. por 1000)",
    "quantity": "nombre de columna con cantidad",
    "deliveryDate": "nombre de columna con fecha de entrega (o null)",
    "unit": "nombre de columna con unidad (EA, KG, etc.) (o null)"
  },
  "pnExtractor": {
    "type": "regex",
    "source": "description",
    "patterns": ["regex1 con grupo de captura para extraer el número de parte del campo description"]
  }
}

Reglas:
- Los valores del mapping deben ser nombres EXACTOS de headers, o null si no existe
- Para pnExtractor.patterns, infiere el regex observando las descripciones; si el PN ya está limpio en buyerCode, devuelve patterns: []
- No incluyas explicaciones, solo el JSON`;

  async function inferLayoutWithClaude(headers, sampleRows) {
    log('Enviando headers a Claude para inferir layout...');

    const sample = {
      headers,
      rows: sampleRows.slice(0, 5).map(r =>
        Object.fromEntries(headers.map((h, i) => [h, String(r[i] == null ? '' : r[i]).substring(0, 120)]))
      )
    };

    const prompt = LAYOUT_INFERENCE_PROMPT + '\n\nHeaders y filas de muestra:\n' + JSON.stringify(sample, null, 2);

    const result = await claude().send(prompt);
    log(`Claude respondió (${result.usage.inputTokens} in / ${result.usage.outputTokens} out, $${result.usage.cost.toFixed(4)})`);

    let text = result.content.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Claude devolvió JSON inválido: ${e.message}\nRespuesta: ${text.substring(0, 200)}`);
    }

    if (!parsed.mapping?.poNumber || !parsed.mapping?.lineNumber) {
      throw new Error('Claude no identificó columnas críticas (poNumber, lineNumber)');
    }

    return {
      name: 'Inferido con Claude',
      mapping: parsed.mapping,
      pnExtractor: parsed.pnExtractor || { type: 'regex', source: 'description', patterns: [] },
      statusFilter: null
    };
  }
```

- [ ] **Step 2: Replace Claude fallback placeholder in runWithUI**

In `runWithUI`, replace the block:

```javascript
    } else {
      // Claude inference fallback — for now, abort with message; implemented in Task 12
      alert('Inferencia con Claude no implementada aún. Por favor usa un layout conocido.');
      return { error: 'claude fallback not implemented' };
    }
```

with:

```javascript
    } else {
      try {
        layout = await inferLayoutWithClaude(parsed.headers, parsed.rows);
        layoutId = 'claude-inferred';
        log(`Layout inferido por Claude`);
      } catch (e) {
        alert('Error infiriendo layout con Claude: ' + e.message);
        return { error: e.message };
      }
    }
```

- [ ] **Step 3: Update return block**

Add `inferLayoutWithClaude` to the exports:

```javascript
  return {
    runWithUI, parseXLS, detectLayout, groupByPO, extractPN, extractRowData,
    loadMappingTable, saveMappingEntry, getMappedPN, inferLayoutWithClaude
  };
```

- [ ] **Step 4: Verify syntax**

Run: `node --check remote/scripts/portal-importer.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/portal-importer.js
git commit -m "feat(portal-importer): add Claude fallback for unknown layouts"
```

---

### Task 13: Portal importer — single mode

**Files:**
- Modify: `remote/scripts/portal-importer.js`

- [ ] **Step 1: Add single-mode UI and flow**

In `remote/scripts/portal-importer.js`, insert before `async function runWithUI()`:

```javascript
  // ── Single Mode UI ─────────────────────────────────────────

  function showPOSelector(pos, layout, file, parsedData) {
    ops().ensureStyles();
    return new Promise(resolve => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      const statusValues = layout.statusFilter?.activeValues || [];
      const defaultFilter = statusValues.length > 0 ? statusValues[0] : '__all__';

      const allStatuses = [...new Set(pos.map(p => p.status).filter(Boolean))];

      const statusSelect = `
        <select id="pi-po-status-filter" style="padding:6px 10px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px">
          <option value="__all__">Todos (${pos.length})</option>
          ${allStatuses.map(s => `<option value="${ops().escHtml(s)}" ${s === defaultFilter ? 'selected' : ''}>${ops().escHtml(s)} (${pos.filter(p => p.status === s).length})</option>`).join('')}
        </select>`;

      md.innerHTML = `
        <h2>Elegir PO a validar</h2>
        <p class="dl9-sub">Archivo: <strong>${ops().escHtml(file.name)}</strong> — ${pos.length} PO(s) detectados</p>
        <div style="margin:8px 0">Filtrar por status: ${statusSelect}</div>
        <div id="pi-po-list" style="max-height:400px;overflow-y:auto;margin:12px 0;display:flex;flex-direction:column;gap:6px"></div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-po-cancel">Cancelar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      ops().addSourceFileButton(md, file, parsedData);

      function renderList() {
        const filter = md.querySelector('#pi-po-status-filter').value;
        const filtered = filter === '__all__' ? pos : pos.filter(p => p.status === filter);
        const listEl = md.querySelector('#pi-po-list');

        if (filtered.length === 0) {
          listEl.innerHTML = '<p style="color:#64748b;font-size:13px;text-align:center;padding:16px">Sin POs para este filtro.</p>';
          return;
        }

        listEl.innerHTML = filtered.map(p => {
          const total = p.lines.reduce((sum, l) => sum + (l.quantity || 0) * (l.unitPrice || 0), 0);
          return `
            <div class="candidate-item" data-po="${ops().escHtml(p.poNumber)}">
              <div class="candidate-info">
                <div class="candidate-name">PO ${ops().escHtml(p.poNumber)}</div>
                <div class="candidate-detail">${p.lines.length} líneas · ${ops().escHtml(p.currency || '')} ${total.toFixed(2)} · Cliente: ${ops().escHtml(p.customer || '?')}</div>
              </div>
              <div class="badge badge-provisional">${ops().escHtml(p.status || '')}</div>
            </div>`;
        }).join('');

        listEl.querySelectorAll('.candidate-item').forEach(el => {
          el.addEventListener('click', () => {
            const poNumber = el.dataset.po;
            const po = pos.find(p => p.poNumber === poNumber);
            ops().removeOverlay();
            resolve(po);
          });
        });
      }

      md.querySelector('#pi-po-status-filter').addEventListener('change', renderList);
      md.querySelector('#pi-po-cancel').addEventListener('click', () => { ops().removeOverlay(); resolve(null); });

      renderList();
    });
  }

  // ── Single mode orchestration ─────────────────────────────

  async function processSingleMode(pos, layout, layoutId, file, parsedData, customerId) {
    const po = await showPOSelector(pos, layout, file, parsedData);
    if (!po) return { cancelled: true };

    // Enrich po with fileName for downstream compatibility
    po.fileName = file.name;

    // Build sourceData shape expected by OVOperations UIs
    const sourceData = {
      poNumber: po.poNumber,
      customer: po.customer,
      currency: po.currency,
      lines: po.lines,
      sourceType: 'xls',
      fileName: file.name
    };

    // Search by PO name via existing POComparator.findSalesOrder
    const searchResult = await window.POComparator.findSalesOrder(po.poNumber, customerId);

    if (searchResult.match === 'exact') {
      const orderId = searchResult.orders[0].idInDomain || searchResult.orders[0].id;
      log(`OV existente: #${orderId} — abrir para validar manualmente en Steelhead.`);
      alert(`La OV ya existe (#${orderId}). Puedes abrirla para validar en Steelhead.`);
      return { existed: true, orderId };
    }

    if (searchResult.match === 'multiple') {
      alert(`${searchResult.orders.length} OVs matchean el nombre. Se requiere selección manual en Steelhead por ahora.`);
      return { multiple: true };
    }

    // No exact match — candidates detection
    const candidates = await ops().findCandidateOVs(sourceData, customerId);

    if (candidates.length > 0) {
      const selection = await ops().showCandidateSelector(candidates, sourceData);
      if (!selection) return { cancelled: true };

      if (selection.action === 'adopt') {
        const orderId = await ops().adoptExistingOV(selection.candidate, sourceData, file);
        alert(`OV adoptada: #${orderId}`);
        return { adopted: true, orderId };
      }

      // selection.action === 'create'
      const creationData = await ops().fetchCreationData(customerId);
      const formData = await ops().showCreationWizard(sourceData, creationData, customerId);
      if (!formData) return { cancelled: true };
      const orderId = await ops().createNewOV(formData, sourceData, file);
      alert(`OV creada: #${orderId}`);
      return { created: true, orderId };
    }

    // No candidates — offer manual search or create
    const noMatch = await ops().showNoMatchOptions(sourceData);
    if (!noMatch) return { cancelled: true };
    if (noMatch.action === 'manual') return { manualId: noMatch.orderId };

    const creationData = await ops().fetchCreationData(customerId);
    const formData = await ops().showCreationWizard(sourceData, creationData, customerId);
    if (!formData) return { cancelled: true };
    const orderId = await ops().createNewOV(formData, sourceData, file);
    alert(`OV creada: #${orderId}`);
    return { created: true, orderId };
  }
```

- [ ] **Step 2: Wire single mode into runWithUI**

In `runWithUI`, replace:

```javascript
    if (mode === 'single') {
      alert('Modo single — implementado en Task 13.');
      return { todo: 'single mode' };
    } else {
```

with:

```javascript
    const customerId = window.POComparator?.getCustomerIdFromURL() || null;

    if (mode === 'single') {
      return await processSingleMode(pos, layout, file, parsedData, customerId);
    } else {
```

- [ ] **Step 3: Verify syntax**

Run: `node --check remote/scripts/portal-importer.js`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/portal-importer.js
git commit -m "feat(portal-importer): implement single mode (PO selector + full OV flow)"
```

---

### Task 14: Portal importer — bulk mode audit table + execution

**Files:**
- Modify: `remote/scripts/portal-importer.js`

- [ ] **Step 1: Add bulk audit table and execution**

Insert before `async function runWithUI()`:

```javascript
  // ── Bulk Mode ──────────────────────────────────────────────

  async function buildAuditRows(pos, customerId, layoutId) {
    log('Analizando estado de cada PO...');
    const rows = [];

    for (const po of pos) {
      const row = { po, action: 'skip', candidate: null, existingOrderId: null };

      try {
        const searchResult = await window.POComparator.findSalesOrder(po.poNumber, customerId);
        if (searchResult.match === 'exact') {
          row.existingOrderId = searchResult.orders[0].idInDomain || searchResult.orders[0].id;
          row.status = 'exists';
          row.action = 'skip';
          rows.push(row);
          continue;
        }
      } catch (e) {
        warn(`Error buscando PO ${po.poNumber}: ${e.message}`);
      }

      const sourceData = {
        poNumber: po.poNumber, customer: po.customer, currency: po.currency,
        lines: po.lines, sourceType: 'xls'
      };

      try {
        const candidates = await ops().findCandidateOVs(sourceData, customerId);
        if (candidates.length > 0) {
          row.candidate = candidates[0];
          row.status = 'candidate';
          row.action = 'adopt';
          rows.push(row);
          continue;
        }
      } catch (e) {
        warn(`Error buscando candidatas para ${po.poNumber}: ${e.message}`);
      }

      row.status = 'missing';
      row.action = 'create';
      rows.push(row);
    }

    log(`Auditoría completada: ${rows.length} POs analizados`);
    return rows;
  }

  function showAuditTable(auditRows, layout, file, parsedData) {
    ops().ensureStyles();
    return new Promise(resolve => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      const statusValues = layout.statusFilter?.activeValues || [];
      const defaultFilter = statusValues.length > 0 ? statusValues[0] : '__all__';
      const allStatuses = [...new Set(auditRows.map(r => r.po.status).filter(Boolean))];

      const statusSelect = `
        <select id="pi-audit-status" style="padding:6px 10px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px">
          <option value="__all__">Todos (${auditRows.length})</option>
          ${allStatuses.map(s => `<option value="${ops().escHtml(s)}" ${s === defaultFilter ? 'selected' : ''}>${ops().escHtml(s)} (${auditRows.filter(r => r.po.status === s).length})</option>`).join('')}
        </select>`;

      md.innerHTML = `
        <h2>Auditoría en batch</h2>
        <p class="dl9-sub">${auditRows.length} POs — revisa la acción sugerida por fila y procesa en lote.</p>
        <div style="margin:8px 0">Filtrar status: ${statusSelect}</div>
        <div style="max-height:420px;overflow-y:auto">
          <table class="dl9-audit-table">
            <thead><tr><th>PO</th><th>Líneas</th><th>Total</th><th>Estado Steelhead</th><th>Acción</th></tr></thead>
            <tbody id="pi-audit-tbody"></tbody>
          </table>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-audit-cancel">Cancelar</button>
          <button class="dl9-btn dl9-btn-primary" id="pi-audit-run">Procesar POs</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(md.parentNode === ov ? ov : (ov.appendChild(md), ov));

      ops().addSourceFileButton(md, file, parsedData);

      function statusLabel(r) {
        if (r.status === 'exists') return `<span style="color:#34d399">Existe (OV #${r.existingOrderId})</span>`;
        if (r.status === 'candidate') return `<span style="color:#facc15">Candidata: ${ops().escHtml(r.candidate.ovName)}</span>`;
        return `<span style="color:#f87171">No existe</span>`;
      }

      function actionSelect(r, idx) {
        const opts = [
          ['skip', 'Skip'],
          ['create', 'Crear'],
          ['validate', 'Validar manualmente']
        ];
        if (r.status === 'candidate') opts.splice(1, 0, ['adopt', 'Adoptar candidata']);
        return `<select data-idx="${idx}" class="pi-action-select">${opts.map(([v, lbl]) => `<option value="${v}" ${r.action === v ? 'selected' : ''}>${lbl}</option>`).join('')}</select>`;
      }

      function renderTable() {
        const filter = md.querySelector('#pi-audit-status').value;
        const tbody = md.querySelector('#pi-audit-tbody');
        const visible = auditRows.map((r, idx) => ({ r, idx })).filter(x => filter === '__all__' || x.r.po.status === filter);

        tbody.innerHTML = visible.map(({ r, idx }) => {
          const total = r.po.lines.reduce((sum, l) => sum + (l.quantity || 0) * (l.unitPrice || 0), 0);
          return `<tr>
            <td>${ops().escHtml(r.po.poNumber)}</td>
            <td>${r.po.lines.length}</td>
            <td>${ops().escHtml(r.po.currency || '')} ${total.toFixed(2)}</td>
            <td>${statusLabel(r)}</td>
            <td>${actionSelect(r, idx)}</td>
          </tr>`;
        }).join('');

        tbody.querySelectorAll('.pi-action-select').forEach(sel => {
          sel.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx, 10);
            auditRows[idx].action = e.target.value;
          });
        });
      }

      md.querySelector('#pi-audit-status').addEventListener('change', renderTable);
      md.querySelector('#pi-audit-cancel').addEventListener('click', () => { ops().removeOverlay(); resolve(null); });
      md.querySelector('#pi-audit-run').addEventListener('click', () => {
        ops().removeOverlay();
        resolve(auditRows.filter(r => r.action !== 'skip'));
      });

      renderTable();
    });
  }

  async function executeBulk(selectedRows, layout, layoutId, file, customerId) {
    if (selectedRows.length === 0) {
      alert('No hay POs para procesar.');
      return { processed: 0 };
    }

    log(`Procesando ${selectedRows.length} POs...`);

    // Pre-check: resolve all PNs, collect suggestions, record successful mappings
    const suggestions = [];
    for (const r of selectedRows) {
      if (r.action !== 'create' && r.action !== 'adopt') continue;
      for (const line of r.po.lines) {
        if (!line.partNumber) continue;
        const resolved = await ops().resolvePartNumber(line.partNumber, customerId);
        if (resolved?.suggestion) {
          if (!suggestions.find(s => s.partNumberId === resolved.suggestion.partNumberId)) {
            suggestions.push(resolved.suggestion);
          }
        } else if (resolved?.partNumberId && resolved.exact) {
          await recordSuccessfulMapping(line, customerId, layoutId);
        }
      }
    }

    if (suggestions.length > 0) {
      await ops().showSuggestionsModal(suggestions);
    }

    // Fetch creation data once for all creates
    const creationData = await ops().fetchCreationData(customerId);

    const results = [];
    for (let i = 0; i < selectedRows.length; i++) {
      const r = selectedRows[i];
      log(`[${i + 1}/${selectedRows.length}] Procesando PO ${r.po.poNumber} (${r.action})...`);

      const sourceData = {
        poNumber: r.po.poNumber, customer: r.po.customer, currency: r.po.currency,
        lines: r.po.lines, sourceType: 'xls', fileName: file.name
      };

      const csvFile = buildCSVForPO(r.po, file.name);

      try {
        if (r.action === 'adopt') {
          const orderId = await ops().adoptExistingOV(r.candidate, sourceData, csvFile);
          results.push({ po: r.po.poNumber, action: 'adopted', orderId });
        } else if (r.action === 'create') {
          const formData = buildDefaultFormData(sourceData, creationData, customerId);
          const orderId = await ops().createNewOV(formData, sourceData, csvFile);
          results.push({ po: r.po.poNumber, action: 'created', orderId });
        } else if (r.action === 'validate') {
          alert(`Pausando bulk para validar PO ${r.po.poNumber} manualmente.`);
          const single = await processSingleMode([r.po], layout, layoutId, file, null, customerId);
          results.push({ po: r.po.poNumber, action: 'validated', result: single });
        }
      } catch (e) {
        warn(`Error procesando ${r.po.poNumber}: ${e.message}`);
        results.push({ po: r.po.poNumber, action: r.action, error: e.message });
      }
    }

    showBulkResults(results);
    return { processed: results.length, results };
  }

  function buildDefaultFormData(sourceData, creationData, customerId) {
    const inferredDivisa = ops().normalizeCurrency(sourceData.currency) || 'MXN';
    const inferredRazon = creationData.razonSocialOptions.find(opt =>
      ops().fuzzyMatchStr(opt, sourceData.customer || '')
    ) || (creationData.razonSocialOptions[0] || '');

    let defaultDeadline;
    if (creationData.defaultLeadTime) {
      const lead = creationData.defaultLeadTime;
      const days = (lead.hours || 0) / 24 + (lead.days || 0);
      const d = new Date();
      d.setDate(d.getDate() + Math.max(days, 1));
      defaultDeadline = d.toISOString();
    } else {
      defaultDeadline = new Date(Date.now() + 14 * 86400000).toISOString();
    }

    const formData = {
      name: sourceData.poNumber,
      customerId: parseInt(customerId, 10),
      deadline: defaultDeadline,
      customerContactId: creationData.defaultContact?.id || null,
      billToAddressId: creationData.defaultBillTo?.id || null,
      shipToAddressId: creationData.defaultShipTo?.id || null,
      invoiceTermsId: creationData.invoiceTerms?.id || null,
      shipVia: 'Flete Propio',
      type: creationData.defaultOrderType || 'MAKE_TO_ORDER',
      blockPartialShipments: false,
      isBlanketOrder: false,
      sectorId: creationData.sector?.id || null,
      inputSchemaId: creationData.inputSchemaId,
      customInputs: {
        Divisa: inferredDivisa,
        RazonSocialVenta: inferredRazon,
        VerificadaPor: ''
      }
    };

    for (const key of Object.keys(formData)) {
      if (formData[key] === null || formData[key] === '' || Number.isNaN(formData[key])) {
        delete formData[key];
      }
    }

    return formData;
  }

  function buildCSVForPO(po, originalFilename) {
    const headers = ['lineNumber', 'partNumber', 'buyerCode', 'description', 'quantity', 'unitPrice', 'deliveryDate'];
    const rows = po.lines.map(l =>
      headers.map(h => {
        const v = l[h] == null ? '' : String(l[h]).replace(/"/g, '""');
        return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v}"` : v;
      }).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const base = originalFilename.replace(/\.[^.]+$/, '');
    return new File([blob], `${po.poNumber}-${base}.csv`, { type: 'text/csv' });
  }

  function showBulkResults(results) {
    ops().ensureStyles();
    const ov = ops().createOverlay();
    const md = ops().createModal();

    const rowsHTML = results.map(r => {
      const color = r.error ? '#f87171' : (r.action === 'created' || r.action === 'adopted' ? '#34d399' : '#94a3b8');
      const label = r.error ? `Error: ${r.error}` : (r.orderId ? `#${r.orderId}` : (r.result ? 'Validado' : '—'));
      return `<tr><td>${ops().escHtml(r.po)}</td><td style="color:${color}">${r.action}</td><td>${ops().escHtml(label)}</td></tr>`;
    }).join('');

    md.innerHTML = `
      <h2>Resultados del batch</h2>
      <p class="dl9-sub">${results.length} POs procesados.</p>
      <table class="dl9-audit-table">
        <thead><tr><th>PO</th><th>Acción</th><th>Resultado</th></tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
      <div class="dl9-btnrow">
        <button class="dl9-btn dl9-btn-primary" id="pi-br-close">Cerrar</button>
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);

    md.querySelector('#pi-br-close').addEventListener('click', () => ops().removeOverlay());
  }

  async function processBulkMode(pos, layout, layoutId, file, parsedData, customerId) {
    const auditRows = await buildAuditRows(pos, customerId, layoutId);
    const selected = await showAuditTable(auditRows, layout, file, parsedData);
    if (!selected) return { cancelled: true };

    return await executeBulk(selected, layout, layoutId, file, customerId);
  }
```

- [ ] **Step 2: Wire bulk mode into runWithUI**

In `runWithUI`, replace:

```javascript
    if (mode === 'single') {
      return await processSingleMode(pos, layout, file, parsedData, customerId);
    } else {
      alert('Modo bulk — implementado en Task 14.');
      return { todo: 'bulk mode' };
    }
```

with:

```javascript
    if (mode === 'single') {
      return await processSingleMode(pos, layout, layoutId, file, parsedData, customerId);
    } else {
      return await processBulkMode(pos, layout, layoutId, file, parsedData, customerId);
    }
```

- [ ] **Step 3: Update return block**

Add bulk exports:

```javascript
  return {
    runWithUI, parseXLS, detectLayout, groupByPO, extractPN, extractRowData,
    loadMappingTable, saveMappingEntry, getMappedPN, inferLayoutWithClaude,
    processSingleMode, processBulkMode, buildAuditRows, executeBulk
  };
```

- [ ] **Step 4: Verify syntax**

Run: `node --check remote/scripts/portal-importer.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/portal-importer.js
git commit -m "feat(portal-importer): implement bulk audit table + batch execution"
```

---

### Task 15: Wire source-file button into PO Comparator modals

**Files:**
- Modify: `remote/scripts/po-comparator.js`

- [ ] **Step 1: Add source file button to existing modals**

Find the `showPDFPreview` function in `remote/scripts/po-comparator.js`. Immediately after `document.body.appendChild(ov);`, add:

```javascript
      window.OVOperations.addSourceFileButton(md, file, null);
```

Note: the PDF viewer needs `file` in scope. `showPDFPreview` currently only receives `pdfData` — we need to pass `file` too. Update the signature and the call site.

Change `showPDFPreview(pdfData)` to `showPDFPreview(pdfData, file)`.

In `processOneFile`, change `await showPDFPreview(pdfData);` to `await showPDFPreview(pdfData, file);`.

Find the `showComparisonReport` function. Change its signature to accept `file` as a 4th parameter: `showComparisonReport(pdfData, soData, comparison, file)`. After `document.body.appendChild(ov);`, add the same button line. In `processOneFile`, pass `file` to the call.

- [ ] **Step 2: Verify syntax**

Run: `node --check remote/scripts/po-comparator.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): expose source-file viewer button in PDF preview and comparison"
```

---

### Task 16: Deploy to gh-pages

**Files:**
- Deploy: `remote/config.json`, `remote/scripts/ov-operations.js`, `remote/scripts/po-comparator.js`, `remote/scripts/portal-importer.js`

- [ ] **Step 1: Stash any unrelated working-tree changes**

```bash
git status --short
# If there are modified files unrelated to the feature (e.g., CLAUDE.md), stash them:
git stash push -u -m "pre-deploy-stash" -- <unrelated-files>
```

- [ ] **Step 2: Copy remote files to temp**

```bash
mkdir -p /tmp/sa-portal-deploy/scripts
cp remote/config.json /tmp/sa-portal-deploy/config.json
cp remote/scripts/ov-operations.js /tmp/sa-portal-deploy/scripts/
cp remote/scripts/po-comparator.js /tmp/sa-portal-deploy/scripts/
cp remote/scripts/portal-importer.js /tmp/sa-portal-deploy/scripts/
```

- [ ] **Step 3: Switch to gh-pages and deploy flat**

```bash
git checkout gh-pages
cp /tmp/sa-portal-deploy/config.json .
cp /tmp/sa-portal-deploy/scripts/ov-operations.js scripts/
cp /tmp/sa-portal-deploy/scripts/po-comparator.js scripts/
cp /tmp/sa-portal-deploy/scripts/portal-importer.js scripts/
git add config.json scripts/ov-operations.js scripts/po-comparator.js scripts/portal-importer.js
git commit -m "deploy: portal importer + ov-operations refactor"
git push origin gh-pages
```

- [ ] **Step 4: Return to main and push**

```bash
git checkout main
# Pop any stash created in Step 1:
git stash list | head -1
# If it shows "pre-deploy-stash", run: git stash pop
git push origin main
```

- [ ] **Step 5: Verify in Chrome**

Reload the extension in Chrome (load unpacked from disk). On a Steelhead page:
1. Open the popup; verify categories are "Inventario" and "Facturación" separately
2. Click "Importador de Portales" → upload the Hubbell XLS → confirm layout detection → try single mode with one PO → verify the source-file viewer button opens the XLS table
3. Try bulk mode → verify audit table shows correct states → run a small subset
4. Verify PO Comparator (PDF) still works end-to-end after refactor
