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
})();

window.OVOperations = OVOperations;
