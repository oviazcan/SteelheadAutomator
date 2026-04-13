# PO Comparator — Crear OV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the PO Comparator finds no matching OV, offer multi-signal duplicate detection, OV adoption (rename), or full OV creation with wizard — then attach the PDF and continue to comparison.

**Architecture:** Extends `po-comparator.js` with three new flows inserted between the existing "search" step and "load OV" step in `processOneFile()`. The multi-signal detection replaces the current `showOVSelector` when no match is found. New hashes are added to `config.json` for CreateReceivedOrder, customer info queries, and file upload mutations.

**Tech Stack:** Vanilla JS (IIFE pattern), Steelhead GraphQL persisted queries, existing `SteelheadAPI` wrapper.

---

### Task 1: Add new hashes to config.json

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Add mutation hashes**

In `remote/config.json`, add these entries to `steelhead.hashes.mutations` (after the existing `SendEmailChecked` line):

```json
"CreateReceivedOrder": "a72de5b673898badb7af85c8b350cc452a34e7bb6af3c375c83e1abb8ca779f9",
"CreateUserFile": "9028f6b729fe0cd253b1d47d5f27d84cc15293bbc12381225a7c00a402849ec9",
"CreateReceivedOrderUserFile": "5896851dd3ee71e025bd59be3a0a3795d2ccf177636ee1bb45b10084f1541f57",
```

- [ ] **Step 2: Add query hashes**

In `remote/config.json`, add these entries to `steelhead.hashes.queries` (after `CheckDuplicatePO`):

```json
"CreateEditReceivedOrderDialogQuery": "b4a8ae722ac336d4a2e474f860c8bd129d8e652a1ea61382fe1bb5cb35fb5aa1",
"GetCustomerInfoForReceivedOrder": "12ae26c6507ef68dfe676e6964cea1efbf921a89ab1660b3db097a095c6de8c6",
"PartNumberCreatableSelectGetPartNumbers": "723dbb599905cf895d306707fc01ed232486ad8190b1cf2649166f57b137d83f",
"SearchPartNumberPrices": "57ffed00ceedcbf4c2e221856c7e3a4d0e5a2a57fbc23df84be9967c5af56d14",
```

- [ ] **Step 3: Add hash documentation entries**

In the `hashDocumentation` section of `config.json`, add entries for each new hash:

```json
"CreateReceivedOrder": { "type": "mutation", "description": "Crear nueva orden de venta con custom inputs", "usedBy": "po-comparator" },
"CreateUserFile": { "type": "mutation", "description": "Registrar archivo subido en el sistema de archivos", "usedBy": "po-comparator, file-uploader" },
"CreateReceivedOrderUserFile": { "type": "mutation", "description": "Enlazar archivo a una orden de venta", "usedBy": "po-comparator" },
"CreateEditReceivedOrderDialogQuery": { "type": "query", "description": "Schema de inputs y defaults del dominio para crear/editar OV", "usedBy": "po-comparator" },
"GetCustomerInfoForReceivedOrder": { "type": "query", "description": "Contactos, direcciones, invoice terms y defaults de un cliente", "usedBy": "po-comparator" },
"PartNumberCreatableSelectGetPartNumbers": { "type": "query", "description": "Buscar PNs por nombre con filtro de cliente", "usedBy": "po-comparator" },
"SearchPartNumberPrices": { "type": "query", "description": "Buscar precios de un PN para un cliente", "usedBy": "po-comparator" },
```

- [ ] **Step 4: Commit**

```bash
git add remote/config.json
git commit -m "feat(po-comparator): add hashes for OV creation and file upload"
```

---

### Task 2: Multi-signal candidate detection

**Files:**
- Modify: `remote/scripts/po-comparator.js` (insert after `findSalesOrder` function, around line 143)

- [ ] **Step 1: Add `findCandidateOVs` function**

Insert after the `findSalesOrder` function (line 143) in `po-comparator.js`:

```javascript
  // ── Multi-signal OV detection ──────────────────────────────

  const PROVISIONAL_NAME_RE = /^(test|prueba|pendiente|temp|tmp)/i;

  async function findCandidateOVs(pdfData, customerId) {
    if (!customerId) return [];

    log('Buscando OVs candidatas del cliente...');

    // Fetch all active OVs for this customer
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

    // Extract PDF part numbers for matching
    const pdfPNs = new Set(
      pdfData.lines
        .map(l => normalizePN(l.partNumber))
        .filter(Boolean)
    );

    // Score each OV
    const candidates = [];
    for (const order of orders) {
      const ovId = order.idInDomain || order.id;
      const ovName = order.name || '';
      const score = { ovId, ovName, order, signals: [], pnMatchCount: 0, pnMatchList: [] };

      // Signal: provisional name
      if (PROVISIONAL_NAME_RE.test(ovName)) {
        score.signals.push('provisional');
      }

      // Signal: name similar to PO number
      if (pdfData.poNumber && ovName.toLowerCase().includes(pdfData.poNumber.toLowerCase())) {
        score.signals.push('name_similar');
      }

      // Load lines for PN cross-reference
      try {
        const ovData = await api().query('GetReceivedOrder', {
          idInDomain: parseInt(ovId, 10),
          revisionNumber: 1
        });
        const ovOrder = ovData?.receivedOrder;
        const roLines = ovOrder?.receivedOrderLines?.nodes || ovOrder?.receivedOrderLines || [];
        score.lineCount = roLines.length;
        score.deadline = ovOrder?.deadline;

        // Cross-reference PNs
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

      // Only include if there's at least one signal
      if (score.signals.length > 0) {
        candidates.push(score);
      }
    }

    // Sort: PN matches first (desc), then date (desc)
    candidates.sort((a, b) => {
      if (b.pnMatchCount !== a.pnMatchCount) return b.pnMatchCount - a.pnMatchCount;
      return (b.ovId || 0) - (a.ovId || 0);
    });

    log(`${candidates.length} candidata(s) encontrada(s)`);
    return candidates;
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add multi-signal candidate OV detection"
```

---

### Task 3: Candidate selector UI

**Files:**
- Modify: `remote/scripts/po-comparator.js` (insert after `findCandidateOVs`, add CSS)

- [ ] **Step 1: Add CSS for candidate list**

In the `injectStyles()` function, append these styles inside the template string (before the closing backtick):

```css
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
```

- [ ] **Step 2: Add `showCandidateSelector` function**

Insert after `findCandidateOVs`:

```javascript
  function showCandidateSelector(candidates, pdfData) {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      let listHTML = '';
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const deadline = c.deadline ? new Date(c.deadline).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

        let badges = '';
        if (c.signals.includes('pn_match')) {
          badges += `<span class="badge badge-pn">${c.pnMatchCount} de ${pdfData.lines.length} PNs coinciden</span>`;
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

      // "Create new" option
      listHTML += `
        <label class="candidate-item candidate-create" data-idx="create">
          <input type="radio" name="dl9-candidate" value="create">
          <div class="candidate-info">
            <div class="candidate-name">Ninguna — Crear OV nueva</div>
            <div class="candidate-detail">Crear orden de venta con los datos del PDF</div>
          </div>
        </label>`;

      md.innerHTML = `
        <h2>OV no encontrada por nombre</h2>
        <p class="dl9-sub">Se encontraron ${candidates.length} OV(s) del mismo cliente que podrían ser la correcta. PO del PDF: <strong>${escHtml(pdfData.poNumber || '?')}</strong></p>
        <div class="candidate-list">${listHTML}</div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-cand-cancel">Cancelar</button>
          <button class="dl9-btn dl9-btn-primary" id="dl9-cand-confirm" disabled>Confirmar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      let selected = null;

      // Radio selection
      md.querySelectorAll('input[name="dl9-candidate"]').forEach(radio => {
        radio.addEventListener('change', () => {
          selected = radio.value;
          md.querySelector('#dl9-cand-confirm').disabled = false;
        });
      });

      // Click on label row also selects
      md.querySelectorAll('.candidate-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return; // let native handle
          const radio = item.querySelector('input[type=radio]');
          radio.checked = true;
          radio.dispatchEvent(new Event('change'));
        });
      });

      // Confirm
      md.querySelector('#dl9-cand-confirm').addEventListener('click', () => {
        removeOverlay();
        if (selected === 'create') {
          resolve({ action: 'create' });
        } else {
          const idx = parseInt(selected, 10);
          resolve({ action: 'adopt', candidate: candidates[idx] });
        }
      });

      // Cancel
      md.querySelector('#dl9-cand-cancel').addEventListener('click', () => {
        removeOverlay();
        resolve(null);
      });
    });
  }
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add candidate selector UI with badges"
```

---

### Task 4: PDF upload helper

**Files:**
- Modify: `remote/scripts/po-comparator.js` (insert after candidate selector)

- [ ] **Step 1: Add `uploadAndAttachPDF` function**

Insert after `showCandidateSelector`:

```javascript
  // ── PDF Upload & Attach ────────────────────────────────────

  async function uploadAndAttachPDF(file, receivedOrderId) {
    log(`Subiendo PDF "${file.name}" y adjuntando a OV...`);

    // Step 1: Upload binary
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

    // Step 2: Register file in Steelhead
    await api().query('CreateUserFile', {
      name: uploadResult.name,
      originalName: file.name
    });

    // Step 3: Link to received order
    await api().query('CreateReceivedOrderUserFile', {
      receivedOrderId: receivedOrderId,
      userFileName: uploadResult.name
    });

    log(`PDF adjuntado a OV exitosamente`);
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add PDF upload and attach helper"
```

---

### Task 5: Adopt OV flow

**Files:**
- Modify: `remote/scripts/po-comparator.js` (insert after upload helper)

- [ ] **Step 1: Add `adoptExistingOV` function**

Insert after `uploadAndAttachPDF`:

```javascript
  // ── Adopt existing OV ──────────────────────────────────────

  async function adoptExistingOV(candidate, pdfData, pdfFile) {
    const ovId = candidate.ovId;
    log(`Adoptando OV #${ovId} — renombrando a "${pdfData.poNumber}"...`);

    // Rename OV with the real PO number
    await api().query('UpdateReceivedOrder', {
      id: candidate.order.id || candidate.order.nodeId,
      name: String(pdfData.poNumber)
    });
    log(`OV renombrada: ${candidate.ovName} → ${pdfData.poNumber}`);

    // Attach PDF
    try {
      await uploadAndAttachPDF(pdfFile, candidate.order.id);
    } catch (e) {
      warn(`No se pudo adjuntar PDF: ${e.message}`);
    }

    return ovId; // Return idInDomain for loading
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add adopt-existing-OV flow with rename + PDF attach"
```

---

### Task 6: Creation wizard — data fetching

**Files:**
- Modify: `remote/scripts/po-comparator.js` (insert after adopt flow)

- [ ] **Step 1: Add `fetchCreationData` function**

Insert after `adoptExistingOV`:

```javascript
  // ── OV Creation Wizard ─────────────────────────────────────

  async function fetchCreationData(customerId) {
    log('Cargando datos para creación de OV...');
    const domainId = api().getDomain().id || 344;

    // Fetch in parallel: dialog defaults + customer info
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

    // Extract input schema
    const schemas = dialogData?.allReceivedOrderInputSchemas?.nodes || [];
    const inputSchema = schemas[0] || {};
    const inputSchemaId = inputSchema.id || 559;
    const schemaProperties = inputSchema.inputSchema?.properties || {};

    // Extract customer defaults
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

    // Extract razón social options from schema
    const razonSocialSchema = schemaProperties.RazonSocialVenta || {};
    const razonSocialOptions = razonSocialSchema.enum || razonSocialSchema.oneOf?.map(o => o.const || o.title) || [];

    // Extract divisa options
    const divisaSchema = schemaProperties.Divisa || {};
    const divisaOptions = divisaSchema.enum || divisaSchema.oneOf?.map(o => o.const || o.title) || ['USD', 'MXN'];

    // Extract verificado por options
    const verificadoSchema = schemaProperties.VerificadaPor || schemaProperties.VerificadoPor || {};
    const verificadoOptions = verificadoSchema.enum || verificadoSchema.oneOf?.map(o => o.const || o.title) || [];

    // Domain defaults
    const domain = dialogData?.domainById || {};
    const deadlineCutoffTime = domain.deadlineCutoffTime || '17:00:00';
    const timezoneName = domain.timezoneName || 'America/Mexico_City';

    log('Datos de creación cargados');

    return {
      inputSchemaId,
      schemaProperties,
      contacts,
      addresses,
      defaultContact,
      defaultBillTo,
      defaultShipTo,
      invoiceTerms,
      sector,
      defaultOrderType,
      defaultLeadTime,
      defaultShipViaId,
      razonSocialOptions,
      divisaOptions,
      verificadoOptions,
      deadlineCutoffTime,
      timezoneName,
      customer
    };
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add fetchCreationData for wizard defaults"
```

---

### Task 7: Creation wizard — UI

**Files:**
- Modify: `remote/scripts/po-comparator.js` (add CSS + `showCreationWizard` function)

- [ ] **Step 1: Add CSS for wizard**

In the `injectStyles()` function, append:

```css
.dl9-poc-modal .wizard-form{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;margin:16px 0}
.dl9-poc-modal .wizard-form .full-width{grid-column:1/-1}
.dl9-poc-modal .wizard-field{display:flex;flex-direction:column;gap:3px}
.dl9-poc-modal .wizard-field label{font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.dl9-poc-modal .wizard-field input,.dl9-poc-modal .wizard-field select{padding:8px 10px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px}
.dl9-poc-modal .wizard-field input:focus,.dl9-poc-modal .wizard-field select:focus{outline:none;border-color:#38bdf8}
.dl9-poc-modal .wizard-group{grid-column:1/-1;font-size:12px;color:#38bdf8;font-weight:600;margin-top:8px;padding-bottom:4px;border-bottom:1px solid #1e293b}
.dl9-poc-modal .wizard-field input[type=checkbox]{width:16px;height:16px;accent-color:#38bdf8}
.dl9-poc-modal .wizard-check{flex-direction:row;align-items:center;gap:8px}
```

- [ ] **Step 2: Add `showCreationWizard` function**

Insert after `fetchCreationData`:

```javascript
  function showCreationWizard(pdfData, creationData, customerId) {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      // Infer divisa from PDF
      const inferredDivisa = normalizeCurrency(pdfData.currency);
      // Infer razón social with fuzzy match
      const inferredRazon = creationData.razonSocialOptions.find(opt =>
        fuzzyMatch(opt, pdfData.customer || '')
      ) || '';

      // Calculate default deadline
      let defaultDeadline = '';
      if (creationData.defaultLeadTime) {
        const lead = creationData.defaultLeadTime;
        const days = (lead.hours || 0) / 24 + (lead.days || 0);
        const d = new Date();
        d.setDate(d.getDate() + Math.max(days, 1));
        defaultDeadline = d.toISOString().split('T')[0];
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 14); // Default 2 weeks
        defaultDeadline = d.toISOString().split('T')[0];
      }

      // Build dropdowns
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
        <p class="dl9-sub">Se creará una nueva OV con los datos extraídos del PDF. Verifica antes de confirmar.</p>
        <div class="wizard-form">

          <div class="wizard-group">Identificación</div>
          <div class="wizard-field">
            <label>Nombre (PO)</label>
            <input type="text" id="wiz-name" value="${escHtml(pdfData.poNumber || '')}">
          </div>
          <div class="wizard-field">
            <label>Tipo de orden</label>
            <select id="wiz-type">${orderTypeOpts}</select>
          </div>

          <div class="wizard-group">Contacto</div>
          <div class="wizard-field">
            <label>Contacto del cliente</label>
            <select id="wiz-contact">${contactOpts || '<option value="">(sin contactos)</option>'}</select>
          </div>
          <div class="wizard-field">
            <label>Plazo de entrega</label>
            <input type="date" id="wiz-deadline" value="${defaultDeadline}">
          </div>

          <div class="wizard-group">Direcciones</div>
          <div class="wizard-field">
            <label>Dirección de facturación</label>
            <select id="wiz-billto">${billToOpts || '<option value="">(sin direcciones)</option>'}</select>
          </div>
          <div class="wizard-field">
            <label>Dirección de envío</label>
            <select id="wiz-shipto">${shipToOpts || '<option value="">(sin direcciones)</option>'}</select>
          </div>

          <div class="wizard-group">Términos</div>
          <div class="wizard-field">
            <label>Invoice terms</label>
            <input type="text" id="wiz-invoiceterms" value="${escHtml(creationData.invoiceTerms?.terms || '')}" data-id="${creationData.invoiceTerms?.id || ''}" readonly style="opacity:0.7">
          </div>
          <div class="wizard-field">
            <label>Ship via</label>
            <input type="text" id="wiz-shipvia" value="Flete Propio">
          </div>

          <div class="wizard-group">Custom inputs</div>
          <div class="wizard-field">
            <label>Divisa</label>
            <select id="wiz-divisa">${divisaOpts}</select>
          </div>
          <div class="wizard-field">
            <label>Razón Social Venta</label>
            <select id="wiz-razon">${razonOpts}</select>
          </div>
          <div class="wizard-field">
            <label>Verificado por</label>
            <select id="wiz-verificado">${verificadoOpts}</select>
          </div>

          <div class="wizard-group">Opciones</div>
          <div class="wizard-field wizard-check">
            <input type="checkbox" id="wiz-blockpartial">
            <label for="wiz-blockpartial" style="text-transform:none;font-size:13px">Bloquear envíos parciales</label>
          </div>
          <div class="wizard-field wizard-check">
            <input type="checkbox" id="wiz-blanket">
            <label for="wiz-blanket" style="text-transform:none;font-size:13px">Orden abierta (blanket)</label>
          </div>

        </div>
        <p style="font-size:11px;color:#64748b;margin-top:8px">${pdfData.lines.length} líneas del PDF se agregarán automáticamente a la OV.</p>
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

        // Remove null fields
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
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add OV creation wizard UI"
```

---

### Task 8: Create OV execution flow

**Files:**
- Modify: `remote/scripts/po-comparator.js` (insert after wizard UI)

- [ ] **Step 1: Add `createNewOV` function**

Insert after `showCreationWizard`:

```javascript
  async function createNewOV(formData, pdfData, pdfFile) {
    log('Creando OV nueva...');

    // Step 1: Create the OV
    const createResult = await api().query('CreateReceivedOrder', formData);
    const newOV = createResult?.createReceivedOrder?.receivedOrder;
    if (!newOV) throw new Error('CreateReceivedOrder no devolvió OV');

    const ovId = newOV.idInDomain;
    const ovInternalId = newOV.id;
    log(`OV creada: #${ovId} (id: ${ovInternalId})`);

    // Step 2: Add lines from PDF
    // We need to resolve partNumberIds for each PDF line
    log('Resolviendo números de parte...');
    const lineItems = [];
    for (const pdfLine of pdfData.lines) {
      if (!pdfLine.partNumber) continue;

      // Search for PN in Steelhead
      let partNumberId = null;
      let partNumberPriceId = null;
      try {
        const pnData = await api().query('PartNumberCreatableSelectGetPartNumbers', {
          name: `%${pdfLine.partNumber}%`,
          searchQuery: '',
          hideCustomerPartsWhenNoCustomerIdFilter: true,
          customerId: formData.customerId || null,
          specIds: [],
          paramIds: []
        });
        const pns = pnData?.searchPartNumbers?.nodes || [];
        // Exact match first
        const exactMatch = pns.find(p => normalizePN(p.label) === normalizePN(pdfLine.partNumber));
        const pnMatch = exactMatch || pns[0];
        if (pnMatch) {
          partNumberId = pnMatch.value || pnMatch.id;

          // Get price for this PN + customer
          if (partNumberId && formData.customerId) {
            try {
              const priceData = await api().query('SearchPartNumberPrices', {
                searchQuery: '%%',
                partNumberId,
                customerId: formData.customerId,
                first: 5
              });
              const prices = priceData?.allPartNumberPrices?.nodes || [];
              if (prices.length > 0) {
                partNumberPriceId = prices[0].id;
              }
            } catch (e) {
              warn(`No se encontró precio para PN ${pdfLine.partNumber}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        warn(`No se encontró PN "${pdfLine.partNumber}" en Steelhead: ${e.message}`);
      }

      lineItems.push({
        lineNumber: pdfLine.lineNumber,
        partNumberId,
        partNumberPriceId,
        quantity: pdfLine.quantity,
        partNumber: pdfLine.partNumber // Keep for logging
      });
    }

    // Log resolution results
    const resolved = lineItems.filter(l => l.partNumberId).length;
    log(`${resolved}/${lineItems.length} PNs resueltos en Steelhead`);

    // Build receivedOrderLines for SaveReceivedOrderLinesAndItems
    // Only include lines where we found the PN
    const receivedOrderLines = lineItems
      .filter(l => l.partNumberId)
      .map(l => ({
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

    // Log unresolved lines
    const unresolved = lineItems.filter(l => !l.partNumberId);
    if (unresolved.length > 0) {
      warn(`${unresolved.length} líneas no se pudieron agregar (PN no encontrado): ${unresolved.map(l => l.partNumber).join(', ')}`);
    }

    // Step 3: Attach PDF
    try {
      await uploadAndAttachPDF(pdfFile, ovInternalId);
    } catch (e) {
      warn(`No se pudo adjuntar PDF: ${e.message}`);
    }

    log(`OV #${ovId} creada con ${receivedOrderLines.length} líneas`);
    return ovId;
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): add createNewOV execution with PN resolution and line creation"
```

---

### Task 9: Integrate into processOneFile

**Files:**
- Modify: `remote/scripts/po-comparator.js` (modify `processOneFile` function, lines 1391-1475)

- [ ] **Step 1: Replace the OV resolution block in processOneFile**

In `processOneFile`, replace the block from "Step 5: Resolve OV" (lines 1429-1436):

```javascript
    // Step 5: Resolve OV
    let orderId;
    if (searchResult.match === 'exact') {
      orderId = searchResult.orders[0].idInDomain || searchResult.orders[0].id;
    } else {
      orderId = await showOVSelector(searchResult, pdfData);
      if (!orderId) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }
    }
```

With this expanded version:

```javascript
    // Step 5: Resolve OV
    let orderId;
    if (searchResult.match === 'exact') {
      orderId = searchResult.orders[0].idInDomain || searchResult.orders[0].id;
    } else if (searchResult.match === 'multiple') {
      // Multiple matches — use original selector
      orderId = await showOVSelector(searchResult, pdfData);
      if (!orderId) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }
    } else {
      // No match — run multi-signal detection
      progress = showProgress(`${prefix}Buscando OVs candidatas...`, 'Analizando OVs activas del cliente...');
      let candidates;
      try {
        progress.update(30, 'Cargando OVs del cliente...');
        candidates = await findCandidateOVs(pdfData, customerId);
        progress.update(100, `${candidates.length} candidata(s) encontrada(s)`);
        progress.close();
      } catch (e) {
        progress.close();
        warn(`Error en detección de candidatas: ${e.message}`);
        candidates = [];
      }

      if (candidates.length > 0) {
        // Show candidate selector
        const selection = await showCandidateSelector(candidates, pdfData);
        if (!selection) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }

        if (selection.action === 'adopt') {
          progress = showProgress(`${prefix}Adoptando OV...`, 'Renombrando y adjuntando PDF...');
          try {
            progress.update(50, 'Renombrando OV...');
            orderId = await adoptExistingOV(selection.candidate, pdfData, files[fileIndex]);
            progress.update(100, 'OV adoptada');
            progress.close();
          } catch (e) {
            progress.close();
            alert(`${prefix}Error adoptando OV: ` + e.message);
            return { error: e.message };
          }
        } else {
          // User chose "create new" despite candidates existing
          progress = showProgress(`${prefix}Preparando wizard...`, 'Cargando datos del cliente...');
          let creationData;
          try {
            progress.update(50, 'Cargando defaults...');
            creationData = await fetchCreationData(customerId);
            progress.update(100, 'Datos cargados');
            progress.close();
          } catch (e) {
            progress.close();
            alert(`${prefix}Error cargando datos: ` + e.message);
            return { error: e.message };
          }

          const formData = await showCreationWizard(pdfData, creationData, customerId);
          if (!formData) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }

          progress = showProgress(`${prefix}Creando OV...`, 'Creando orden de venta...');
          try {
            progress.update(20, 'Creando OV...');
            orderId = await createNewOV(formData, pdfData, files[fileIndex]);
            progress.update(100, 'OV creada');
            progress.close();
          } catch (e) {
            progress.close();
            alert(`${prefix}Error creando OV: ` + e.message);
            return { error: e.message };
          }
        }
      } else {
        // No candidates at all — go directly to creation wizard
        // But show the option to manually search first
        const manualChoice = await showNoMatchOptions(pdfData);
        if (!manualChoice) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }

        if (manualChoice.action === 'manual') {
          orderId = manualChoice.orderId;
        } else {
          // Create new
          progress = showProgress(`${prefix}Preparando wizard...`, 'Cargando datos del cliente...');
          let creationData;
          try {
            progress.update(50, 'Cargando defaults...');
            creationData = await fetchCreationData(customerId);
            progress.update(100, 'Datos cargados');
            progress.close();
          } catch (e) {
            progress.close();
            alert(`${prefix}Error cargando datos: ` + e.message);
            return { error: e.message };
          }

          const formData = await showCreationWizard(pdfData, creationData, customerId);
          if (!formData) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }

          progress = showProgress(`${prefix}Creando OV...`, 'Creando orden de venta...');
          try {
            progress.update(20, 'Creando OV...');
            orderId = await createNewOV(formData, pdfData, files[fileIndex]);
            progress.update(100, 'OV creada');
            progress.close();
          } catch (e) {
            progress.close();
            alert(`${prefix}Error creando OV: ` + e.message);
            return { error: e.message };
          }
        }
      }
    }
```

- [ ] **Step 2: Fix the file reference**

The `files` array is not available inside `processOneFile`. The function receives `file` as parameter. Replace all occurrences of `files[fileIndex]` in the block above with `file`:

```javascript
// In the adopt block:
orderId = await adoptExistingOV(selection.candidate, pdfData, file);

// In both create blocks:
orderId = await createNewOV(formData, pdfData, file);
```

- [ ] **Step 3: Add `showNoMatchOptions` function**

Insert after `showCreationWizard`. This shows when there are no candidates at all — offers manual search or create:

```javascript
  function showNoMatchOptions(pdfData) {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      md.innerHTML = `
        <h2>OV no encontrada</h2>
        <p class="dl9-sub">No se encontró OV para PO "${escHtml(pdfData.poNumber || '?')}" y no hay OVs candidatas del cliente.</p>
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

        try {
          const customerId = getCustomerIdFromURL();
          const result = await findSalesOrder(val, customerId);
          if (result.match === 'exact') {
            removeOverlay();
            resolve({ action: 'manual', orderId: parseInt(result.orders[0].idInDomain || result.orders[0].id, 10) });
          } else if (result.match === 'multiple') {
            errEl.textContent = 'Múltiples resultados. Ingresa el idInDomain directamente.';
            errEl.style.display = 'block';
          } else {
            errEl.textContent = 'No se encontró OV con ese número.';
            errEl.style.display = 'block';
          }
        } catch (e) {
          errEl.textContent = 'Error: ' + e.message;
          errEl.style.display = 'block';
        }
      };

      md.querySelector('#dl9-nm-search').addEventListener('click', doSearch);
      md.querySelector('#dl9-nm-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
      md.querySelector('#dl9-nm-create').addEventListener('click', () => { removeOverlay(); resolve({ action: 'create' }); });
      md.querySelector('#dl9-nm-cancel').addEventListener('click', () => { removeOverlay(); resolve(null); });
    });
  }
```

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): integrate multi-signal detection + creation into processOneFile"
```

---

### Task 10: Update public API exports

**Files:**
- Modify: `remote/scripts/po-comparator.js` (return block at end of IIFE, around line 1498)

- [ ] **Step 1: Add new functions to public API**

In the `return` block at the end of the IIFE, add the new functions:

```javascript
  return {
    run,
    runWithUI,
    parsePDF,
    findSalesOrder,
    findCandidateOVs,
    loadSalesOrder,
    compareOrders,
    getCustomerIdFromURL,
    checkAttachedPDF,
    loadDiscrepancyData,
    matchLinesByPN,
    uploadAndAttachPDF,
    createNewOV,
    adoptExistingOV,
    fetchCreationData
  };
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-comparator.js
git commit -m "feat(po-comparator): export new OV creation functions"
```

---

### Task 11: Deploy to gh-pages

**Files:**
- Deploy: `remote/config.json`, `remote/scripts/po-comparator.js`

- [ ] **Step 1: Stash, switch to gh-pages, copy, commit, push both branches**

Follow the deploy recipe from memory:

```bash
# Stash any uncommitted changes
git stash

# Copy remote files to temp
cp -r remote /tmp/sa-remote-deploy

# Switch to gh-pages
git checkout gh-pages

# Copy flat (no remote/ prefix)
cp /tmp/sa-remote-deploy/config.json .
cp /tmp/sa-remote-deploy/scripts/po-comparator.js scripts/

# Commit and push
git add config.json scripts/po-comparator.js
git commit -m "deploy: po-comparator OV creation feature"

# Push both branches
git push origin gh-pages
git checkout main
git stash pop
git push origin main
```

- [ ] **Step 2: Verify deployment**

Open the extension in Chrome on a ReceivedOrder page and test:
1. Upload a PDF that has no matching OV → should see candidate detection
2. If candidates found → verify badges and selection works
3. If no candidates → verify "Crear OV nueva" wizard appears with pre-filled data
4. Create an OV → verify lines are added and PDF is attached
5. Adopt an existing OV → verify rename works and comparison proceeds
