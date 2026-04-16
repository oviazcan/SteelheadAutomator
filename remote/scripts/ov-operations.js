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

  // Shared number formatter — thousands with comma, decimals with period.
  // Usage: fmtNumber(12473.49, 2) → "12,473.49"; fmtNumber(1500) → "1,500"
  function fmtNumber(n, decimals) {
    if (n == null || isNaN(n)) return '—';
    const d = decimals == null ? 0 : decimals;
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
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
      orderBy: ['ID_IN_DOMAIN_DESC'],
      computeMargins: false,
      showInvoicedSubtotal: false
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
        return { partNumberId, partNumberPriceId, exact: true, label: exactMatch.label };
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
          unitPrice: line.unitPrice,
          partNumber: line.partNumber
        });
      } else {
        warn(`No se pudo resolver PN "${line.partNumber}" a un PN exacto de Steelhead`);
      }
    }

    const resolvedCount = lineItems.length;
    const total = sourceData.lines.filter(l => l.partNumber).length;
    log(`${resolvedCount}/${total} PNs resueltos en Steelhead`);

    if (lineItems.length > 0) {
      // Paso 1: crear un ReceivedOrderPartTransform por cada PN único.
      // La unique constraint de Postgres prohibe (receivedOrderId, partNumberId, ...)
      // duplicados, así que sumamos cantidades de líneas con el mismo PN.
      const groups = new Map();
      for (const l of lineItems) {
        const key = l.partNumberId;
        if (!groups.has(key)) {
          groups.set(key, {
            partNumberId: l.partNumberId,
            partNumberPriceId: l.partNumberPriceId || null,
            totalCount: 0,
            partNumber: l.partNumber
          });
        }
        groups.get(key).totalCount += Number(l.quantity) || 0;
      }

      log(`Creando ${groups.size} part transforms (para ${lineItems.length} líneas)...`);
      const transformsByPN = new Map();
      let idx = 0;
      for (const [pnId, g] of groups) {
        idx++;
        const t0 = Date.now();
        log(`  [${idx}/${groups.size}] transform PN=${g.partNumber} (${g.totalCount} pz)...`);
        try {
          const tr = await api().query('SaveReceivedOrderPartTransforms', {
            input: [{
              isBillable: true,
              receivedOrderId: ovInternalId,
              shipToId: formData.shipToAddressId || null,
              partNumberPriceId: g.partNumberPriceId,
              maxPartTransformCount: g.totalCount,
              count: 0,
              partNumberId: pnId,
              orderType: formData.type || 'MAKE_TO_ORDER',
              description: '',
              deadline: formData.deadline,
              children: []
            }]
          });
          const t = tr?.saveReceivedOrderPartTransforms?.[0];
          if (!t?.id) throw new Error('no devolvió id');
          transformsByPN.set(pnId, t);
          log(`  [${idx}/${groups.size}] OK (id=${t.id}, ${Date.now() - t0}ms)`);
        } catch (e) {
          throw new Error(`Falló transform ${idx}/${groups.size} (PN=${g.partNumber}, partNumberId=${pnId}): ${e.message}`);
        }
      }

      // Paso 2: crear una línea por cada entrada original del PO, todas las que
      // compartan PN apuntan al mismo transform id
      log(`Agregando ${lineItems.length} líneas a la OV...`);
      const newLines = lineItems.map(l => {
        const t = transformsByPN.get(l.partNumberId) || {};
        return {
          id: null,
          name: String(l.partNumber),
          description: '',
          lineItems: [{
            archive: false,
            description: String(l.partNumber),
            quantity: String(l.quantity),
            price: String(l.unitPrice || '0'),
            productId: null,
            unitId: null,
            quoteLineItemId: null,
            receivedOrderLineItemPartTransforms: [{
              receivedOrderPartTransform: {
                id: t.id ?? null,
                partNumberId: l.partNumberId,
                partNumberPriceId: l.partNumberPriceId || null,
                count: 0,
                description: ''
              }
            }]
          }]
        };
      });

      await api().query('SaveReceivedOrderLinesAndItems', {
        input: {
          receivedOrderId: ovInternalId,
          newLines
        }
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

    log(`OV #${ovId} creada con ${lineItems.length} líneas`);
    return ovId;
  }

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

  return {
    normalizePN,
    aggressiveNormalizePN,
    normalizeCurrency,
    fuzzyMatchStr,
    escHtml,
    toNumber,
    fmtNumber,
    createOverlay,
    createModal,
    removeOverlay,
    findCandidateOVs,
    uploadAndAttachFile,
    adoptExistingOV,
    fetchCreationData,
    resolvePartNumber,
    createNewOV,
    showCandidateSelector,
    showNoMatchOptions,
    showCreationWizard,
    addSourceFileButton,
    ensureStyles,
    showSuggestionsModal
  };
})();

window.OVOperations = OVOperations;
