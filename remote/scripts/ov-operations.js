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
    createNewOV,
    showCandidateSelector,
    showNoMatchOptions,
    showCreationWizard
  };
})();

window.OVOperations = OVOperations;
