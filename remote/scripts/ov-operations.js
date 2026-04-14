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
})();

window.OVOperations = OVOperations;
