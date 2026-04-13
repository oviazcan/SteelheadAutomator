// PO Comparator — PDF parsing, OV lookup, and comparison engine
// Depends on: SteelheadAPI, ClaudeAPI

const POComparator = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const claude = () => window.ClaudeAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── PDF Parsing ──────────────────────────────────────────────

  const PDF_EXTRACTION_PROMPT = `Analiza este PDF de orden de compra y extrae los datos en formato JSON.

Responde SOLAMENTE con un JSON válido, sin markdown, sin explicaciones. El formato es:
{
  "poNumber": "número de orden de compra",
  "customer": "nombre o razón social del cliente",
  "currency": "USD o MXN (infiere de los precios o símbolos)",
  "lines": [
    {
      "lineNumber": 1,
      "partNumber": "número de parte exacto como aparece",
      "description": "descripción del producto/servicio",
      "quantity": 500,
      "unitPrice": 2.85,
      "total": 1425.00
    }
  ]
}

Reglas:
- Extrae TODAS las líneas de la tabla de productos/servicios
- Los números deben ser numéricos (sin formato, sin comas, sin símbolos de moneda)
- Si no puedes determinar un campo, usa null
- El lineNumber debe ser secuencial empezando en 1
- Incluye solo líneas de productos reales, ignora subtotales, impuestos, totales generales`;

  async function parsePDF(file) {
    log('Leyendo PDF...');
    const base64 = await fileToBase64(file);
    log(`PDF cargado: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    log('Enviando PDF a Claude para extracción...');
    const result = await claude().sendWithPDF(base64, PDF_EXTRACTION_PROMPT);
    log(`Claude respondió (${result.usage.inputTokens} in / ${result.usage.outputTokens} out, $${result.usage.cost.toFixed(4)})`);

    let parsed;
    try {
      // Strip markdown fences if Claude wraps the response
      let text = result.content.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Error parseando respuesta de Claude: ${e.message}\nRespuesta: ${result.content.substring(0, 200)}`);
    }

    // Validate structure
    if (!parsed.lines || !Array.isArray(parsed.lines)) {
      throw new Error('Claude no devolvió líneas válidas');
    }
    if (parsed.lines.length === 0) {
      throw new Error('Claude no encontró líneas de productos en el PDF');
    }

    // Normalize numeric fields
    parsed.lines = parsed.lines.map((line, i) => ({
      lineNumber: line.lineNumber || i + 1,
      partNumber: line.partNumber ? String(line.partNumber).trim() : null,
      description: line.description || null,
      quantity: toNumber(line.quantity),
      unitPrice: toNumber(line.unitPrice),
      total: toNumber(line.total)
    }));

    log(`PDF parseado: PO ${parsed.poNumber}, ${parsed.lines.length} líneas, ${parsed.currency || '?'}`);
    return parsed;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        // Strip the data:...;base64, prefix
        resolve(dataUrl.split(',')[1]);
      };
      reader.onerror = () => reject(new Error('Error leyendo archivo'));
      reader.readAsDataURL(file);
    });
  }

  function toNumber(val) {
    if (val == null) return null;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  // ── OV Lookup ────────────────────────────────────────────────

  function getCustomerIdFromURL() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('customerId') || null;
    } catch {
      return null;
    }
  }

  async function findSalesOrder(poNumber, customerId) {
    if (!poNumber) return { match: 'none', orders: [] };

    log(`Buscando OV con PO "${poNumber}"${customerId ? ` (cliente ${customerId})` : ''}...`);

    try {
      const vars = {
        domainId: api().getDomain().id || 344,
        name: String(poNumber)
      };
      if (customerId) vars.customerId = parseInt(customerId, 10);

      const data = await api().query('CheckDuplicatePO', vars);
      const orders = data?.checkDuplicatePO || [];

      if (orders.length === 0) {
        log('No se encontró OV con ese número de PO');
        return { match: 'none', orders: [] };
      }
      if (orders.length === 1) {
        log(`OV encontrada: ${orders[0].name || orders[0].idInDomain}`);
        return { match: 'exact', orders };
      }

      log(`Múltiples OVs encontradas: ${orders.length}`);
      return { match: 'multiple', orders };
    } catch (e) {
      warn(`Error buscando OV: ${e.message}`);
      return { match: 'none', orders: [] };
    }
  }

  // ── Multi-signal OV detection ──────────────────────────────────

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
          if (e.target.tagName === 'INPUT') return;
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

  async function loadSalesOrder(receivedOrderId) {
    log(`Cargando OV ${receivedOrderId}...`);

    const data = await api().query('GetReceivedOrder', {
      idInDomain: parseInt(receivedOrderId, 10),
      revisionNumber: 1
    });

    const order = data?.receivedOrder;
    if (!order) throw new Error(`OV ${receivedOrderId} no encontrada`);

    // Extract custom inputs (Divisa, RazonSocialVenta)
    const customInputs = order.customInputs || [];
    const divisa = extractCustomInput(customInputs, 'Divisa') ||
                   extractCustomInput(customInputs, 'divisa');
    const razonSocial = extractCustomInput(customInputs, 'RazonSocialVenta') ||
                        extractCustomInput(customInputs, 'razonSocialVenta') ||
                        extractCustomInput(customInputs, 'Razon Social Venta');

    // Extract lines
    const roLines = order.receivedOrderLines?.nodes || order.receivedOrderLines || [];
    const lines = roLines.map((line, i) => ({
      lineNumber: line.lineNumber || i + 1,
      partNumber: line.partNumber?.name || line.partNumberName || null,
      quantity: toNumber(line.quantity),
      price: toNumber(line.price || line.unitPrice),
      roLineId: line.id || null
    }));

    log(`OV cargada: ${order.name || receivedOrderId}, ${lines.length} líneas`);

    return {
      id: order.id,
      idInDomain: order.idInDomain,
      name: order.name,
      divisa,
      razonSocial,
      lines
    };
  }

  function extractCustomInput(customInputs, fieldName) {
    if (!Array.isArray(customInputs)) return null;
    const field = customInputs.find(ci =>
      ci.name === fieldName || ci.fieldName === fieldName || ci.label === fieldName
    );
    return field ? (field.value || field.textValue || null) : null;
  }

  async function checkAttachedPDF(receivedOrderId) {
    log(`Verificando documentos adjuntos de OV ${receivedOrderId}...`);

    try {
      const data = await api().query('GetReceivedOrderDocuments', {
        idInDomain: parseInt(receivedOrderId, 10),
        revisionNumber: 1
      });

      const docs = data?.receivedOrder?.documents?.nodes ||
                   data?.receivedOrder?.documents ||
                   data?.receivedOrder?.userFiles?.nodes ||
                   [];

      const pdfs = docs.filter(d => {
        const name = (d.originalName || d.name || '').toLowerCase();
        return name.endsWith('.pdf');
      });

      log(`Documentos PDF adjuntos: ${pdfs.length}`);
      return pdfs.map(d => ({
        name: d.name,
        originalName: d.originalName || d.name,
        url: d.url || d.downloadUrl || null
      }));
    } catch (e) {
      warn(`Error cargando documentos: ${e.message}`);
      return [];
    }
  }

  // ── Comparison Engine ────────────────────────────────────────

  function compareOrders(pdfData, soData) {
    log('Comparando PO vs OV...');

    // Header comparison
    const header = {
      razonSocial: {
        pdf: pdfData.customer || null,
        so: soData.razonSocial || null,
        match: fuzzyMatch(pdfData.customer, soData.razonSocial)
      },
      divisa: {
        pdf: pdfData.currency || null,
        so: soData.divisa || null,
        match: normalizeCurrency(pdfData.currency) === normalizeCurrency(soData.divisa)
      }
    };

    // Line matching
    const matched = matchLinesByPN(pdfData.lines, soData.lines);

    // Classify each matched pair
    const lines = matched.map(pair => classifyLine(pair));

    // Stats
    const stats = {
      total: lines.length,
      ok: 0, partial: 0, priceMismatch: 0, qtyMismatch: 0,
      missingInSO: 0, extraInSO: 0
    };
    for (const line of lines) {
      switch (line.status) {
        case 'ok':              stats.ok++; break;
        case 'partial':         stats.partial++; break;
        case 'price_mismatch':  stats.priceMismatch++; break;
        case 'qty_mismatch':    stats.qtyMismatch++; break;
        case 'missing_in_so':   stats.missingInSO++; break;
        case 'extra_in_so':     stats.extraInSO++; break;
      }
    }

    log(`Comparación: ${stats.ok} OK, ${stats.partial} parciales, ${stats.priceMismatch} precio, ${stats.qtyMismatch} cantidad, ${stats.missingInSO} sin OV, ${stats.extraInSO} extra en OV`);

    return { header, lines, stats };
  }

  function matchLinesByPN(pdfLines, soLines) {
    const results = [];
    const usedSO = new Set();

    // Index SO lines by normalized part number
    const soByPN = new Map();
    for (let i = 0; i < soLines.length; i++) {
      const pn = normalizePN(soLines[i].partNumber);
      if (pn) {
        if (!soByPN.has(pn)) soByPN.set(pn, []);
        soByPN.get(pn).push(i);
      }
    }

    // Match each PDF line
    for (const pdfLine of pdfLines) {
      const pn = normalizePN(pdfLine.partNumber);
      const candidates = pn ? (soByPN.get(pn) || []) : [];
      const soIdx = candidates.find(i => !usedSO.has(i));

      if (soIdx !== undefined) {
        usedSO.add(soIdx);
        results.push({ pdfLine, soLine: soLines[soIdx] });
      } else {
        results.push({ pdfLine, soLine: null });
      }
    }

    // Add unmatched SO lines
    for (let i = 0; i < soLines.length; i++) {
      if (!usedSO.has(i)) {
        results.push({ pdfLine: null, soLine: soLines[i] });
      }
    }

    return results;
  }

  function classifyLine({ pdfLine, soLine }) {
    const result = {
      pdfLine: pdfLine || null,
      soLine: soLine || null,
      discrepancy: null,
      status: 'ok',
      priceDiff: null,
      qtyDiff: null
    };

    if (!soLine) {
      result.status = 'missing_in_so';
      return result;
    }
    if (!pdfLine) {
      result.status = 'extra_in_so';
      return result;
    }

    const pdfQty = pdfLine.quantity;
    const soQty = soLine.quantity;
    const pdfPrice = pdfLine.unitPrice;
    const soPrice = soLine.price;

    // Price comparison (tolerance of 0.01 for rounding)
    const priceMatch = pdfPrice == null || soPrice == null ||
                       Math.abs(pdfPrice - soPrice) < 0.01;
    // Quantity comparison
    const qtyMatch = pdfQty == null || soQty == null ||
                     pdfQty === soQty;

    if (priceMatch && qtyMatch) {
      result.status = 'ok';
    } else if (priceMatch && !qtyMatch && soQty < pdfQty) {
      // Partial: SO has less qty than PO, price matches
      result.status = 'partial';
      result.qtyDiff = pdfQty - soQty;
    } else if (!priceMatch && qtyMatch) {
      result.status = 'price_mismatch';
      result.priceDiff = pdfPrice - soPrice;
    } else if (!priceMatch) {
      // Both differ — prioritize price mismatch
      result.status = 'price_mismatch';
      result.priceDiff = pdfPrice - soPrice;
      result.qtyDiff = pdfQty - soQty;
    } else {
      result.status = 'qty_mismatch';
      result.qtyDiff = pdfQty - soQty;
    }

    return result;
  }

  function normalizePN(pn) {
    if (!pn) return null;
    return String(pn).trim().toLowerCase();
  }

  function normalizeCurrency(val) {
    if (!val) return '';
    const s = String(val).trim().toUpperCase();
    if (s.includes('USD') || s === 'DOLAR' || s === 'DÓLAR') return 'USD';
    if (s.includes('MXN') || s === 'PESO' || s === 'PESOS') return 'MXN';
    return s;
  }

  function fuzzyMatch(a, b) {
    if (!a || !b) return false;
    const na = a.trim().toLowerCase();
    const nb = b.trim().toLowerCase();
    return na === nb || na.includes(nb) || nb.includes(na);
  }

  // ── Batch Discrepancy Data (optional enrichment) ─────────────

  async function loadDiscrepancyData(receivedOrderId) {
    log(`Cargando datos de recepción para OV ${receivedOrderId}...`);

    try {
      const data = await api().query('ReceivingBatchesQuery', {
        receivedOrderId: parseInt(receivedOrderId, 10)
      });

      const batches = data?.receivingBatches?.nodes ||
                      data?.receivingBatches ||
                      [];

      const discrepancies = new Map();
      for (const batch of batches) {
        const lines = batch.receivingBatchLines?.nodes ||
                      batch.receivingBatchLines || [];
        for (const line of lines) {
          const pn = normalizePN(line.partNumber?.name || line.partNumberName);
          if (!pn) continue;
          const existing = discrepancies.get(pn) || { expected: 0, received: 0 };
          existing.expected += toNumber(line.expectedQuantity) || 0;
          existing.received += toNumber(line.receivedQuantity) || 0;
          discrepancies.set(pn, existing);
        }
      }

      log(`Datos de recepción: ${discrepancies.size} PNs con datos de batch`);
      return discrepancies;
    } catch (e) {
      warn(`Error cargando datos de recepción: ${e.message}`);
      return new Map();
    }
  }

  // ── Main Entry Point ─────────────────────────────────────────

  async function run(file) {
    log('=== PO Comparator iniciando ===');

    // 1. Parse PDF
    const pdfData = await parsePDF(file);

    // 2. Get customer context
    const customerId = getCustomerIdFromURL();

    // 3. Find matching SO
    const searchResult = await findSalesOrder(pdfData.poNumber, customerId);

    if (searchResult.match === 'none') {
      log('No se encontró OV automáticamente');
      return {
        step: 'no_match',
        pdfData,
        searchResult,
        comparison: null
      };
    }

    if (searchResult.match === 'multiple') {
      log('Múltiples OVs — se requiere selección del usuario');
      return {
        step: 'multiple_match',
        pdfData,
        searchResult,
        comparison: null
      };
    }

    // 4. Load the matched SO
    const order = searchResult.orders[0];
    const orderId = order.idInDomain || order.id;
    const soData = await loadSalesOrder(orderId);

    // 5. Compare
    const comparison = compareOrders(pdfData, soData);

    // 6. Optionally load discrepancy data
    let discrepancyData = new Map();
    try {
      discrepancyData = await loadDiscrepancyData(orderId);
    } catch (e) {
      warn(`Discrepancy data no disponible: ${e.message}`);
    }

    // Enrich comparison lines with discrepancy data
    if (discrepancyData.size > 0) {
      for (const line of comparison.lines) {
        const pn = normalizePN(line.pdfLine?.partNumber || line.soLine?.partNumber);
        if (pn && discrepancyData.has(pn)) {
          line.discrepancy = discrepancyData.get(pn);
        }
      }
    }

    log('=== PO Comparator completado ===');
    return {
      step: 'compared',
      pdfData,
      soData,
      searchResult,
      comparison
    };
  }

  // ── Styles ────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('dl9-poc-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl9-poc-styles';
    s.textContent = `
      .dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .dl9-poc-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:1080px;width:97%;max-height:92vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
      .dl9-poc-modal h2{color:#38bdf8;font-size:18px;margin-bottom:4px}
      .dl9-poc-modal .dl9-sub{color:#64748b;font-size:13px;margin-bottom:12px}
      .dl9-poc-modal .meta-compare{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:16px;font-size:12px}
      .dl9-poc-modal .meta-box{background:#0f172a;padding:10px 14px;border-radius:8px}
      .dl9-poc-modal .meta-box .label{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px}
      .dl9-poc-modal .meta-box .value{color:#e2e8f0;font-weight:600;font-size:13px}
      .dl9-poc-modal .meta-match{color:#4ade80}
      .dl9-poc-modal .meta-mismatch{color:#ef4444}
      .dl9-poc-modal .meta-status{display:flex;align-items:center;justify-content:center;padding:0 12px;font-size:18px}
      .dl9-poc-modal .dl9-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin:12px 0 16px}
      .dl9-poc-modal .dl9-stat{background:#0f172a;padding:8px 12px;border-radius:6px;font-size:13px}
      .dl9-poc-modal .dl9-stat b{color:#38bdf8}
      .dl9-poc-modal .stat-ok{color:#4ade80;font-weight:700}
      .dl9-poc-modal .stat-warn{color:#facc15;font-weight:700}
      .dl9-poc-modal .stat-err{color:#ef4444;font-weight:700}
      .dl9-poc-modal .stat-miss{color:#94a3b8;font-weight:700}
      .dl9-poc-modal .disc-type{display:inline-flex;gap:6px;margin:0 0 12px}
      .dl9-poc-modal .disc-chip{padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid #334155;color:#94a3b8;background:transparent;transition:all 0.15s}
      .dl9-poc-modal .disc-chip.active{border-color:#38bdf8;color:#38bdf8;background:rgba(56,189,248,0.08)}
      .dl9-poc-modal .comp-wrap{max-height:360px;overflow-y:auto;border:1px solid #334155;border-radius:8px}
      .dl9-poc-modal table{width:100%;border-collapse:collapse;font-size:11.5px}
      .dl9-poc-modal thead{position:sticky;top:0;z-index:1}
      .dl9-poc-modal th{background:#0f172a;text-align:left;padding:6px 7px;color:#94a3b8;font-weight:500;border-bottom:1px solid #334155;white-space:nowrap;font-size:11px}
      .dl9-poc-modal td{padding:5px 7px;border-bottom:1px solid #1a2332;vertical-align:middle}
      .dl9-poc-modal tr:hover{background:rgba(56,189,248,0.04)}
      .dl9-poc-modal .col-group-pdf{background:rgba(167,139,250,0.08)!important}
      .dl9-poc-modal .col-group-ov{background:rgba(56,189,248,0.08)!important}
      .dl9-poc-modal .col-group-disc{background:rgba(251,146,60,0.08)!important}
      .dl9-poc-modal .col-hdr-pdf{color:#a78bfa;border-bottom:2px solid #a78bfa}
      .dl9-poc-modal .col-hdr-ov{color:#38bdf8;border-bottom:2px solid #38bdf8}
      .dl9-poc-modal .col-hdr-disc{color:#fb923c;border-bottom:2px solid #fb923c}
      .dl9-poc-modal .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;white-space:nowrap}
      .dl9-poc-modal .badge-ok{background:rgba(74,222,128,0.15);color:#4ade80}
      .dl9-poc-modal .badge-partial{background:rgba(250,204,21,0.15);color:#facc15}
      .dl9-poc-modal .badge-price{background:rgba(239,68,68,0.15);color:#ef4444}
      .dl9-poc-modal .badge-qty{background:rgba(248,113,113,0.15);color:#f87171}
      .dl9-poc-modal .badge-miss{background:rgba(148,163,184,0.12);color:#94a3b8}
      .dl9-poc-modal .badge-extra{background:rgba(71,85,105,0.3);color:#64748b}
      .dl9-poc-modal .val-diff{color:#ef4444;font-weight:600;text-decoration:line-through}
      .dl9-poc-modal .val-correct{color:#4ade80;font-weight:600}
      .dl9-poc-modal .val-partial{color:#facc15;font-weight:600}
      .dl9-poc-modal .val-ref{color:#fb923c;font-style:italic}
      .dl9-poc-modal .class-section{margin-top:16px;padding:14px;background:#0f172a;border-radius:8px}
      .dl9-poc-modal .class-section h3{font-size:13px;color:#e2e8f0;margin-bottom:10px}
      .dl9-poc-modal .class-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;margin-bottom:4px}
      .dl9-poc-modal .class-row-err{background:rgba(239,68,68,0.06)}
      .dl9-poc-modal .class-row-miss{background:rgba(148,163,184,0.06)}
      .dl9-poc-modal .class-desc{color:#94a3b8;flex:1}
      .dl9-poc-modal .class-toggle{display:flex;gap:4px;margin-left:auto;flex-shrink:0}
      .dl9-poc-modal .toggle-btn{padding:3px 8px;border-radius:10px;font-size:10px;cursor:pointer;border:1px solid #334155;color:#94a3b8;background:transparent}
      .dl9-poc-modal .toggle-btn.sel{border-color:#38bdf8;color:#38bdf8;background:rgba(56,189,248,0.1)}
      .dl9-poc-modal .dl9-btnrow{display:flex;gap:10px;margin-top:18px;justify-content:flex-end;flex-wrap:wrap}
      .dl9-poc-modal .dl9-btn{padding:9px 20px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity 0.2s}
      .dl9-poc-modal .dl9-btn:hover{opacity:0.85}
      .dl9-poc-modal .dl9-btn-cancel{background:#475569;color:#e2e8f0}
      .dl9-poc-modal .dl9-btn-email-int{background:#f59e0b;color:#1e293b}
      .dl9-poc-modal .dl9-btn-email-cli{background:#0d9488;color:white}
      .dl9-poc-modal .dl9-btn-reorder{background:#2563eb;color:white}
      .dl9-poc-modal .dl9-btn-sidebyside{background:#6366f1;color:white}
      .dl9-poc-modal .dl9-btn:disabled{opacity:0.4;cursor:not-allowed}
      .dl9-poc-modal .dl9-progress{margin:16px 0;text-align:center}
      .dl9-poc-modal .dl9-progress .dl9-bar{height:6px;background:#334155;border-radius:3px;overflow:hidden;margin:8px 0}
      .dl9-poc-modal .dl9-progress .dl9-bar-fill{height:100%;background:#38bdf8;border-radius:3px;transition:width 0.3s}
      .dl9-poc-modal .dl9-progress p{font-size:12px;color:#94a3b8}
      .dl9-poc-modal .claude-indicator{display:inline-flex;align-items:center;gap:6px;margin-top:8px}
      .dl9-poc-modal .claude-spinner{animation:dl9-spin 1.2s linear infinite}
      .dl9-poc-modal .claude-usage{font-size:11px;color:#d4a574}
      @keyframes dl9-spin{to{transform:rotate(360deg)}}
      .dl9-poc-modal .dl9-file-zone{border:2px dashed #475569;border-radius:10px;padding:32px;text-align:center;cursor:pointer;transition:border-color 0.2s}
      .dl9-poc-modal .dl9-file-zone:hover{border-color:#38bdf8}
      .dl9-poc-modal .dl9-file-zone input[type=file]{display:none}
      .dl9-poc-modal .preview-table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
      .dl9-poc-modal .preview-table th{background:#0f172a;padding:4px 8px;text-align:left;color:#94a3b8;font-weight:500}
      .dl9-poc-modal .preview-table td{padding:4px 8px;border-bottom:1px solid #1a2332}
      .dl9-poc-modal .ov-selector{margin:8px 0}
      .dl9-poc-modal .ov-option{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0f172a;border-radius:6px;margin-bottom:4px;cursor:pointer;border:1px solid transparent;transition:border-color 0.15s}
      .dl9-poc-modal .ov-option:hover,.dl9-poc-modal .ov-option.selected{border-color:#38bdf8}
      .dl9-poc-modal .ov-option .ov-name{color:#e2e8f0;font-weight:600;font-size:13px}
      .dl9-poc-modal .ov-option .ov-detail{color:#64748b;font-size:11px}
      .dl9-poc-modal .manual-search{display:flex;gap:6px;margin:8px 0}
      .dl9-poc-modal .manual-search input{flex:1;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px}
      .dl9-poc-modal .manual-search button{padding:8px 16px;border:none;border-radius:6px;background:#38bdf8;color:#0f172a;font-weight:600;font-size:13px;cursor:pointer}
      .dl9-poc-modal .footer-usage{margin-top:12px;padding-top:10px;border-top:1px solid #334155;font-size:11px;color:#64748b;text-align:right}
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
    `;
    document.head.appendChild(s);
  }

  // ── UI Helpers ───────────────────────────────────────────────

  const STEELHEAD_BASE = 'https://app.gosteelhead.com';
  const DOMAIN_ID = 344;

  function createOverlay() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'dl9-overlay';
    ov.id = 'dl9-poc-overlay';
    return ov;
  }

  function createModal() {
    const md = document.createElement('div');
    md.className = 'dl9-poc-modal';
    return md;
  }

  function removeOverlay() {
    const ov = document.getElementById('dl9-poc-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  function claudeIndicatorHTML() {
    return `<div class="claude-indicator">
      <svg class="claude-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#d4a574" stroke-width="2" fill="none" stroke-dasharray="31.4 31.4" />
      </svg>
      <span class="claude-usage"></span>
    </div>`;
  }

  function fmtNum(n) {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  function fmtPrice(n) {
    if (n == null) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function statusBadge(status) {
    const map = {
      ok: '<span class="badge badge-ok">&#10003; OK</span>',
      partial: '<span class="badge badge-partial">&#9888; Parcial</span>',
      price_mismatch: '<span class="badge badge-price">&#10007; Precio</span>',
      qty_mismatch: '<span class="badge badge-qty">&#10007; Cantidad</span>',
      missing_in_so: '<span class="badge badge-miss">&#9898; Faltante</span>',
      extra_in_so: '<span class="badge badge-extra">&#9899; Extra</span>'
    };
    return map[status] || status;
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── UI Step: File Picker ────────────────────────────────────

  function showFilePicker() {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();
      md.innerHTML = `
        <h2>Validador OC vs OV</h2>
        <p class="dl9-sub">Sube el PDF de la orden de compra para comparar contra Steelhead</p>
        <div class="dl9-file-zone" id="dl9-poc-dropzone">
          <input type="file" accept=".pdf" id="dl9-poc-file" multiple>
          <p style="font-size:14px;color:#94a3b8;margin-bottom:4px">Seleccionar PDF(s) de Orden de Compra</p>
          <p style="font-size:11px;color:#64748b">Clic aqui o arrastra uno o varios archivos</p>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-poc-cancel">Cancelar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const dropzone = md.querySelector('#dl9-poc-dropzone');
      const fileInput = md.querySelector('#dl9-poc-file');

      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.style.borderColor = '#38bdf8'; });
      dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = '#475569'; });
      dropzone.addEventListener('drop', e => {
        e.preventDefault();
        dropzone.style.borderColor = '#475569';
        const pdfs = [...(e.dataTransfer?.files || [])].filter(f => f.type === 'application/pdf');
        if (pdfs.length > 0) { removeOverlay(); resolve(pdfs); }
      });
      fileInput.addEventListener('change', () => {
        const pdfs = [...(fileInput.files || [])].filter(f => f.type === 'application/pdf');
        if (pdfs.length > 0) { removeOverlay(); resolve(pdfs); }
      });
      md.querySelector('#dl9-poc-cancel').addEventListener('click', () => { removeOverlay(); resolve(null); });
    });
  }

  // ── UI Step: Progress ───────────────────────────────────────

  function showProgress(title, detail) {
    const ov = createOverlay();
    const md = createModal();
    md.innerHTML = `
      <h2>${escHtml(title)}</h2>
      <div class="dl9-progress" id="dl9-poc-progress">
        <div class="dl9-bar"><div class="dl9-bar-fill" id="dl9-poc-bar" style="width:10%"></div></div>
        <p id="dl9-poc-detail">${escHtml(detail || '')}</p>
        ${claudeIndicatorHTML()}
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);

    return {
      update(pct, text) {
        const bar = document.getElementById('dl9-poc-bar');
        const det = document.getElementById('dl9-poc-detail');
        if (bar) bar.style.width = pct + '%';
        if (det) det.textContent = text || '';
      },
      updateUsage() {
        const usageEl = ov.querySelector('.claude-usage');
        if (usageEl) {
          const usage = claude().getUsage();
          usageEl.textContent = claude().formatUsage(usage);
        }
      },
      close() { removeOverlay(); }
    };
  }

  // ── UI Step: PDF Preview & Confirm ──────────────────────────

  function showPDFPreview(pdfData) {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();

      let linesHTML = '';
      for (const line of (pdfData.lines || []).slice(0, 10)) {
        linesHTML += `<tr>
          <td>${line.lineNumber}</td>
          <td>${escHtml(line.partNumber)}</td>
          <td>${fmtNum(line.quantity)}</td>
          <td>${fmtPrice(line.unitPrice)}</td>
        </tr>`;
      }
      const moreMsg = pdfData.lines.length > 10 ? `<p style="font-size:11px;color:#64748b;margin-top:4px">...y ${pdfData.lines.length - 10} lineas mas</p>` : '';

      md.innerHTML = `
        <h2>Datos extraidos del PDF</h2>
        <p class="dl9-sub">PO: <strong style="color:#e2e8f0">${escHtml(pdfData.poNumber)}</strong> | Cliente: <strong style="color:#e2e8f0">${escHtml(pdfData.customer)}</strong> | Divisa: <strong style="color:#e2e8f0">${escHtml(pdfData.currency)}</strong> | Lineas: <strong style="color:#e2e8f0">${pdfData.lines.length}</strong></p>
        <div style="max-height:260px;overflow-y:auto;border:1px solid #334155;border-radius:8px">
          <table class="preview-table">
            <thead><tr><th>#</th><th>PN</th><th>Cant.</th><th>Precio</th></tr></thead>
            <tbody>${linesHTML}</tbody>
          </table>
        </div>
        ${moreMsg}
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-poc-retry">Reintentar</button>
          <button class="dl9-btn" id="dl9-poc-confirm" style="background:#4ade80;color:#0f172a">Confirmar y buscar OV</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#dl9-poc-retry').addEventListener('click', () => { removeOverlay(); resolve(false); });
      md.querySelector('#dl9-poc-confirm').addEventListener('click', () => { removeOverlay(); resolve(true); });
    });
  }

  // ── UI Step: OV Selector (multiple or manual search) ───────

  function showOVSelector(searchResult, pdfData) {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();
      const isNone = searchResult.match === 'none';

      let ordersHTML = '';
      if (!isNone) {
        for (const o of searchResult.orders) {
          const name = o.name || o.idInDomain || o.id;
          ordersHTML += `<div class="ov-option" data-id="${o.idInDomain || o.id}">
            <div><div class="ov-name">#${escHtml(name)}</div><div class="ov-detail">ID: ${o.idInDomain || o.id}</div></div>
          </div>`;
        }
      }

      md.innerHTML = `
        <h2>${isNone ? 'OV no encontrada' : 'Seleccionar OV'}</h2>
        <p class="dl9-sub">${isNone ? 'No se encontro una OV automaticamente para PO "' + escHtml(pdfData.poNumber) + '". Busca manualmente:' : 'Se encontraron ' + searchResult.orders.length + ' OVs posibles:'}</p>
        ${ordersHTML ? '<div class="ov-selector">' + ordersHTML + '</div>' : ''}
        <div class="manual-search">
          <input type="text" id="dl9-poc-ov-input" placeholder="Numero de OV (idInDomain)..." value="${escHtml(pdfData.poNumber || '')}">
          <button id="dl9-poc-ov-search">Buscar</button>
        </div>
        <p id="dl9-poc-ov-error" style="color:#ef4444;font-size:12px;margin-top:4px;display:none"></p>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-poc-ov-cancel">Cancelar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      // Click on OV option
      md.querySelectorAll('.ov-option').forEach(opt => {
        opt.addEventListener('click', () => {
          removeOverlay();
          resolve(parseInt(opt.dataset.id, 10));
        });
      });

      // Manual search
      const doSearch = async () => {
        const val = md.querySelector('#dl9-poc-ov-input').value.trim();
        if (!val) return;
        const errEl = md.querySelector('#dl9-poc-ov-error');
        errEl.style.display = 'none';

        // Try as idInDomain directly
        const asNum = parseInt(val, 10);
        if (!isNaN(asNum)) {
          removeOverlay();
          resolve(asNum);
          return;
        }

        // Try as PO search
        try {
          const customerId = getCustomerIdFromURL();
          const result = await findSalesOrder(val, customerId);
          if (result.match === 'exact') {
            removeOverlay();
            resolve(parseInt(result.orders[0].idInDomain || result.orders[0].id, 10));
          } else if (result.match === 'multiple') {
            errEl.textContent = 'Multiples resultados. Ingresa el idInDomain directamente.';
            errEl.style.display = 'block';
          } else {
            errEl.textContent = 'No se encontro OV con ese numero.';
            errEl.style.display = 'block';
          }
        } catch (e) {
          errEl.textContent = 'Error: ' + e.message;
          errEl.style.display = 'block';
        }
      };

      md.querySelector('#dl9-poc-ov-search').addEventListener('click', doSearch);
      md.querySelector('#dl9-poc-ov-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
      md.querySelector('#dl9-poc-ov-cancel').addEventListener('click', () => { removeOverlay(); resolve(null); });
    });
  }

  // ── UI Step: Comparison Report ──────────────────────────────

  function showComparisonReport(pdfData, soData, comparison) {
    return new Promise(resolve => {
      const ov = createOverlay();
      const md = createModal();
      const { header, lines, stats } = comparison;

      // Track discrepancy classifications: { idx: 'ours' | 'client' }
      const classifications = {};

      // Gather discrepancy indices
      const discrepancies = [];
      lines.forEach((line, idx) => {
        if (line.status !== 'ok' && line.status !== 'extra_in_so') {
          discrepancies.push(idx);
          classifications[idx] = 'ours'; // default
        }
      });
      // Header divisa mismatch
      const divisaMismatch = header.divisa && !header.divisa.match;
      if (divisaMismatch) classifications['divisa'] = 'ours';

      const ovUrl = `${STEELHEAD_BASE}/Domains/${DOMAIN_ID}/ReceivedOrders/${soData.idInDomain}`;

      // Build lines HTML
      function buildTableBody(filter) {
        let html = '';
        lines.forEach((line, idx) => {
          if (filter && filter !== 'all') {
            if (filter === 'discrepancies' && (line.status === 'ok' || line.status === 'extra_in_so' || line.status === 'partial' || line.status === 'missing_in_so')) return;
            if (filter === 'partials' && line.status !== 'partial') return;
            if (filter === 'missing' && line.status !== 'missing_in_so') return;
          }

          const pL = line.pdfLine;
          const sL = line.soLine;
          const num = pL ? pL.lineNumber : (sL ? sL.lineNumber : idx + 1);
          const pn = pL?.partNumber || sL?.partNumber || '—';
          const isErr = ['price_mismatch', 'qty_mismatch', 'missing_in_so'].includes(line.status);
          const isPart = line.status === 'partial';
          const isMiss = line.status === 'missing_in_so';
          const isExtra = line.status === 'extra_in_so';
          const bgStyle = isErr ? 'background:rgba(239,68,68,0.06)' : isPart ? 'background:rgba(250,204,21,0.06)' : isMiss ? 'background:rgba(148,163,184,0.06)' : '';

          // PDF cols
          let pdfQtyClass = '', pdfPriceClass = '';
          let ovQtyClass = '', ovPriceClass = '';
          if (line.status === 'price_mismatch') { pdfPriceClass = 'val-correct'; ovPriceClass = 'val-diff'; }
          if (line.status === 'qty_mismatch') { pdfQtyClass = 'val-correct'; ovQtyClass = 'val-diff'; }
          if (line.status === 'partial') { ovQtyClass = 'val-partial'; }

          // Discrepancy column
          let discVal = '<span style="color:#64748b">—</span>';
          if (line.discrepancy) {
            discVal = `<span class="val-ref" title="Recibido: ${line.discrepancy.received} de ${line.discrepancy.expected}">${fmtNum(line.discrepancy.received)}</span>`;
          }

          html += `<tr style="${bgStyle}" data-idx="${idx}" data-status="${line.status}">
            <td>${num}</td>
            <td${isMiss || isExtra ? ' style="color:#94a3b8"' : ''}>${escHtml(pn)}</td>
            <td class="col-group-pdf ${pdfQtyClass}"${isMiss ? ' style="color:#94a3b8"' : ''}>${pL ? fmtNum(pL.quantity) : '—'}</td>
            <td class="col-group-pdf ${pdfPriceClass}"${isMiss ? ' style="color:#94a3b8"' : ''}>${pL ? fmtPrice(pL.unitPrice) : '—'}</td>
            <td class="col-group-ov ${ovQtyClass}"${isExtra ? '' : isMiss ? ' style="color:#475569"' : ''}>${sL ? fmtNum(sL.quantity) : '<span style="color:#475569">—</span>'}</td>
            <td class="col-group-ov ${ovPriceClass}"${isExtra ? '' : isMiss ? ' style="color:#475569"' : ''}>${sL ? fmtPrice(sL.price) : '<span style="color:#475569">—</span>'}</td>
            <td class="col-group-disc">${discVal}</td>
            <td>${statusBadge(line.status)}</td>
          </tr>`;
        });
        return html;
      }

      // Build classifier rows
      function buildClassifier() {
        let html = '';
        lines.forEach((line, idx) => {
          if (line.status === 'ok' || line.status === 'extra_in_so') return;
          const pL = line.pdfLine;
          const sL = line.soLine;
          const pn = pL?.partNumber || sL?.partNumber || '?';

          let desc = '';
          let rowClass = 'class-row-err';
          let badgeHtml = '';

          if (line.status === 'price_mismatch') {
            const diff = line.priceDiff != null ? (line.priceDiff > 0 ? '+' : '') + fmtPrice(line.priceDiff) : '';
            desc = `${escHtml(pn)} — OC: ${fmtPrice(pL?.unitPrice)} vs OV: ${fmtPrice(sL?.price)} (dif: ${diff})`;
            badgeHtml = '<span class="badge badge-price">Precio</span>';
          } else if (line.status === 'qty_mismatch') {
            const diff = line.qtyDiff != null ? (line.qtyDiff > 0 ? '+' : '') + fmtNum(line.qtyDiff) : '';
            desc = `${escHtml(pn)} — OC: ${fmtNum(pL?.quantity)} vs OV: ${fmtNum(sL?.quantity)} (dif: ${diff})`;
            if (line.discrepancy) desc += ` · Recibo: ${fmtNum(line.discrepancy.received)}`;
            badgeHtml = '<span class="badge badge-qty">Cant.</span>';
          } else if (line.status === 'partial') {
            desc = `${escHtml(pn)} — OC: ${fmtNum(pL?.quantity)} vs OV: ${fmtNum(sL?.quantity)}`;
            if (line.discrepancy) desc += ` · Recibo: ${fmtNum(line.discrepancy.received)}`;
            badgeHtml = '<span class="badge badge-partial">Parcial</span>';
            rowClass = 'class-row-err';
          } else if (line.status === 'missing_in_so') {
            desc = `${escHtml(pn)} — En OC pero no en OV (${fmtNum(pL?.quantity)} pzas x ${fmtPrice(pL?.unitPrice)})`;
            badgeHtml = '<span class="badge badge-miss">Faltante</span>';
            rowClass = 'class-row-miss';
          }

          const selected = classifications[idx] || 'ours';
          html += `<div class="class-row ${rowClass}" data-class-idx="${idx}">
            ${badgeHtml}
            <span class="class-desc">${desc}</span>
            <div class="class-toggle">
              <button class="toggle-btn${selected === 'ours' ? ' sel' : ''}" data-val="ours">Error nuestro</button>
              <button class="toggle-btn${selected === 'client' ? ' sel' : ''}" data-val="client">Error cliente</button>
            </div>
          </div>`;
        });

        // Divisa mismatch
        if (divisaMismatch) {
          const selected = classifications['divisa'] || 'ours';
          html += `<div class="class-row" style="background:rgba(251,146,60,0.08)" data-class-idx="divisa">
            <span class="badge" style="background:rgba(251,146,60,0.15);color:#fb923c">Divisa</span>
            <span class="class-desc">Encabezado — OC: ${escHtml(header.divisa.pdf)} vs OV: ${escHtml(header.divisa.so)}</span>
            <div class="class-toggle">
              <button class="toggle-btn${selected === 'ours' ? ' sel' : ''}" data-val="ours">Error nuestro</button>
              <button class="toggle-btn${selected === 'client' ? ' sel' : ''}" data-val="client">Error cliente</button>
            </div>
          </div>`;
        }

        return html;
      }

      // Count by classification
      function countByClass(type) {
        return Object.values(classifications).filter(v => v === type).length;
      }

      // Compute filter counts
      const discCount = lines.filter(l => ['price_mismatch', 'qty_mismatch'].includes(l.status)).length;
      const partCount = stats.partial;
      const missCount = stats.missingInSO;

      // Usage footer
      const usage = claude().getUsage();
      const usageText = claude().formatUsage(usage);

      md.innerHTML = `
        <h2>Comparacion OC → OV</h2>
        <p class="dl9-sub">OC: <strong style="color:#e2e8f0">${escHtml(pdfData.poNumber)}</strong> (${escHtml(pdfData.customer)}) → OV: <a href="${ovUrl}" target="_blank" style="color:#38bdf8;text-decoration:underline"><strong>#${escHtml(soData.name || soData.idInDomain)}</strong></a></p>

        <div class="meta-compare">
          <div class="meta-box">
            <div class="label">Razon Social (OC → OV)</div>
            <div class="value ${header.razonSocial.match ? 'meta-match' : 'meta-mismatch'}">
              ${escHtml(header.razonSocial.pdf || '?')} → ${escHtml(header.razonSocial.so || '?')} ${header.razonSocial.match ? '&#10003;' : '&#10007;'}
            </div>
          </div>
          <div class="meta-box">
            <div class="label">Divisa (OC → OV)</div>
            <div class="value ${header.divisa.match ? 'meta-match' : 'meta-mismatch'}">
              ${escHtml(header.divisa.pdf || '?')} → ${escHtml(header.divisa.so || '?')} ${header.divisa.match ? '&#10003;' : '&#10007;'}
            </div>
          </div>
          <div class="meta-status" title="${divisaMismatch ? '1 discrepancia en encabezado' : 'Encabezado OK'}">${divisaMismatch ? '&#9888;&#65039;' : '&#9989;'}</div>
        </div>

        <div class="dl9-stats">
          <div class="dl9-stat"><b>Lineas OC:</b> ${stats.total - stats.extraInSO}</div>
          <div class="dl9-stat"><b>Match:</b> <span class="stat-ok">${stats.ok}</span></div>
          <div class="dl9-stat"><b>Parcial:</b> <span class="stat-warn">${stats.partial}</span></div>
          <div class="dl9-stat"><b>Precio:</b> <span class="stat-err">${stats.priceMismatch}</span></div>
          <div class="dl9-stat"><b>Cantidad:</b> <span class="stat-err">${stats.qtyMismatch}</span></div>
          <div class="dl9-stat"><b>Faltante:</b> <span class="stat-miss">${stats.missingInSO}</span></div>
        </div>

        <div class="disc-type" id="dl9-poc-filters">
          <button class="disc-chip active" data-filter="all">Todos (${stats.total})</button>
          <button class="disc-chip" data-filter="discrepancies">Discrepancias (${discCount})</button>
          <button class="disc-chip" data-filter="partials">Parciales (${partCount})</button>
          <button class="disc-chip" data-filter="missing">Faltantes (${missCount})</button>
        </div>

        <div class="comp-wrap" id="dl9-poc-table-wrap">
          <table>
            <thead>
              <tr>
                <th rowspan="2">#</th>
                <th rowspan="2">PN</th>
                <th colspan="2" class="col-hdr-pdf" style="text-align:center">OC (PDF)</th>
                <th colspan="2" class="col-hdr-ov" style="text-align:center">OV (Steelhead)</th>
                <th class="col-hdr-disc" style="text-align:center">Recibo</th>
                <th rowspan="2">Estado</th>
              </tr>
              <tr>
                <th class="col-hdr-pdf">Cant.</th>
                <th class="col-hdr-pdf">Precio</th>
                <th class="col-hdr-ov">Cant.</th>
                <th class="col-hdr-ov">Precio</th>
                <th class="col-hdr-disc">Disc.</th>
              </tr>
            </thead>
            <tbody id="dl9-poc-tbody">${buildTableBody('all')}</tbody>
          </table>
        </div>

        ${discrepancies.length > 0 || divisaMismatch ? `
        <div class="class-section" id="dl9-poc-classifier">
          <h3>Clasificar discrepancias antes de notificar:</h3>
          <div id="dl9-poc-class-rows">${buildClassifier()}</div>
        </div>` : ''}

        <div class="dl9-btnrow" id="dl9-poc-actions">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-poc-close">Cerrar</button>
          <button class="dl9-btn dl9-btn-sidebyside" id="dl9-poc-sidebyside">Abrir lado a lado</button>
          <button class="dl9-btn dl9-btn-reorder" id="dl9-poc-reorder">Reordenar lineas</button>
          <button class="dl9-btn dl9-btn-email-cli" id="dl9-poc-email-cli">Notificar a Serv. al Cliente (${countByClass('client')})</button>
          <button class="dl9-btn dl9-btn-email-int" id="dl9-poc-email-int">Notificar internamente (${countByClass('ours')})</button>
        </div>

        <div class="footer-usage">Claude API: ${escHtml(usageText)}</div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      // Wire filter chips
      md.querySelectorAll('#dl9-poc-filters .disc-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          md.querySelectorAll('#dl9-poc-filters .disc-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          const tbody = md.querySelector('#dl9-poc-tbody');
          tbody.innerHTML = buildTableBody(chip.dataset.filter);
        });
      });

      // Wire classification toggles
      md.addEventListener('click', e => {
        const btn = e.target.closest('.toggle-btn');
        if (!btn) return;
        const row = btn.closest('[data-class-idx]');
        if (!row) return;
        const idx = row.dataset.classIdx;
        const val = btn.dataset.val;
        classifications[idx] = val;

        // Update toggle UI
        row.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');

        // Update button counts
        const intBtn = md.querySelector('#dl9-poc-email-int');
        const cliBtn = md.querySelector('#dl9-poc-email-cli');
        if (intBtn) intBtn.textContent = `Notificar internamente (${countByClass('ours')})`;
        if (cliBtn) cliBtn.textContent = `Notificar a Serv. al Cliente (${countByClass('client')})`;
      });

      // Close
      md.querySelector('#dl9-poc-close').addEventListener('click', () => {
        removeOverlay();
        resolve({ action: 'close' });
      });

      // Side by side
      md.querySelector('#dl9-poc-sidebyside').addEventListener('click', () => {
        window.open(ovUrl, '_blank');
      });

      // Reorder
      md.querySelector('#dl9-poc-reorder').addEventListener('click', async () => {
        const btn = md.querySelector('#dl9-poc-reorder');
        btn.disabled = true;
        btn.textContent = 'Reordenando...';
        try {
          await reorderLines(comparison, soData);
          btn.textContent = 'Reordenado ✓';
          btn.style.background = '#4ade80';
          btn.style.color = '#0f172a';
        } catch (e) {
          btn.textContent = 'Error: ' + e.message;
          btn.style.background = '#ef4444';
          setTimeout(() => {
            btn.textContent = 'Reordenar lineas';
            btn.style.background = '#2563eb';
            btn.style.color = 'white';
            btn.disabled = false;
          }, 3000);
        }
      });

      // Email internal
      md.querySelector('#dl9-poc-email-int').addEventListener('click', async () => {
        const btn = md.querySelector('#dl9-poc-email-int');
        btn.disabled = true;
        btn.textContent = 'Enviando...';
        try {
          const oursDisc = getDiscrepanciesByClass(lines, classifications, 'ours', header);
          await sendInternalNotification(oursDisc, soData, pdfData);
          btn.textContent = 'Enviado ✓';
          btn.style.background = '#4ade80';
          btn.style.color = '#0f172a';
        } catch (e) {
          btn.textContent = 'Error: ' + e.message;
          btn.style.background = '#ef4444';
          setTimeout(() => {
            btn.textContent = `Notificar internamente (${countByClass('ours')})`;
            btn.style.background = '#f59e0b';
            btn.style.color = '#1e293b';
            btn.disabled = false;
          }, 3000);
        }
      });

      // Email client
      md.querySelector('#dl9-poc-email-cli').addEventListener('click', async () => {
        const btn = md.querySelector('#dl9-poc-email-cli');
        btn.disabled = true;
        btn.textContent = 'Enviando...';
        try {
          const clientDisc = getDiscrepanciesByClass(lines, classifications, 'client', header);
          await sendClientNotification(clientDisc, soData, pdfData);
          btn.textContent = 'Enviado ✓';
          btn.style.background = '#4ade80';
          btn.style.color = 'white';
        } catch (e) {
          btn.textContent = 'Error: ' + e.message;
          btn.style.background = '#ef4444';
          setTimeout(() => {
            btn.textContent = `Notificar a Serv. al Cliente (${countByClass('client')})`;
            btn.style.background = '#0d9488';
            btn.style.color = 'white';
            btn.disabled = false;
          }, 3000);
        }
      });
    });
  }

  function getDiscrepanciesByClass(lines, classifications, classType, header) {
    const result = [];
    lines.forEach((line, idx) => {
      if (line.status === 'ok' || line.status === 'extra_in_so') return;
      if (classifications[idx] === classType) {
        result.push({ ...line, lineIdx: idx });
      }
    });
    // Include divisa if classified
    if (header?.divisa && !header.divisa.match && classifications['divisa'] === classType) {
      result.push({ type: 'header_divisa', pdfVal: header.divisa.pdf, soVal: header.divisa.so });
    }
    return result;
  }

  // ── Reorder Lines (Step 7) ──────────────────────────────────

  async function reorderLines(comparison, soData) {
    log('Reordenando lineas de OV segun orden del PDF...');

    // Map PDF line order to SO line IDs
    const lineUpdates = [];
    let newOrder = 1;
    for (const line of comparison.lines) {
      if (line.soLine && line.soLine.roLineId) {
        lineUpdates.push({
          id: line.soLine.roLineId,
          lineNumber: newOrder
        });
        newOrder++;
      }
    }

    if (lineUpdates.length === 0) {
      throw new Error('No hay lineas de OV para reordenar');
    }

    log(`Reordenando ${lineUpdates.length} lineas...`);

    await api().query('SaveReceivedOrderLinesAndItems', {
      receivedOrderId: soData.id,
      receivedOrderLines: lineUpdates.map(lu => ({
        id: lu.id,
        lineNumber: lu.lineNumber
      })),
      receivedOrderItems: []
    });

    log('Lineas reordenadas exitosamente');
  }

  // ── Email Notifications (Step 8) ────────────────────────────

  function buildDiscrepancyTableHTML(discrepancies, pdfData, soData) {
    const ovUrl = `${STEELHEAD_BASE}/Domains/${DOMAIN_ID}/ReceivedOrders/${soData.idInDomain}`;

    let rows = '';
    for (const d of discrepancies) {
      if (d.type === 'header_divisa') {
        rows += `<tr style="background:#fff8f0">
          <td style="padding:6px 10px;border:1px solid #e5e7eb">—</td>
          <td style="padding:6px 10px;border:1px solid #e5e7eb"><em>Divisa</em></td>
          <td style="padding:6px 10px;border:1px solid #e5e7eb">${escHtml(d.pdfVal)}</td>
          <td style="padding:6px 10px;border:1px solid #e5e7eb">—</td>
          <td style="padding:6px 10px;border:1px solid #e5e7eb">${escHtml(d.soVal)}</td>
          <td style="padding:6px 10px;border:1px solid #e5e7eb">—</td>
          <td style="padding:6px 10px;border:1px solid #e5e7eb">Divisa incorrecta</td>
        </tr>`;
        continue;
      }

      const pL = d.pdfLine;
      const sL = d.soLine;
      const pn = pL?.partNumber || sL?.partNumber || '?';
      let statusText = '';
      switch (d.status) {
        case 'price_mismatch': statusText = `Precio: OC ${fmtPrice(pL?.unitPrice)} vs OV ${fmtPrice(sL?.price)}`; break;
        case 'qty_mismatch': statusText = `Cantidad: OC ${fmtNum(pL?.quantity)} vs OV ${fmtNum(sL?.quantity)}`; break;
        case 'partial': statusText = `Parcial: OC ${fmtNum(pL?.quantity)} vs OV ${fmtNum(sL?.quantity)}`; break;
        case 'missing_in_so': statusText = 'Faltante en OV'; break;
      }

      rows += `<tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${pL ? pL.lineNumber : '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${escHtml(pn)}</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${pL ? fmtNum(pL.quantity) : '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${pL ? fmtPrice(pL.unitPrice) : '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${sL ? fmtNum(sL.quantity) : '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${sL ? fmtPrice(sL.price) : '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb">${escHtml(statusText)}</td>
      </tr>`;
    }

    return `
      <div style="font-family:Arial,sans-serif;max-width:700px">
        <h2 style="color:#1e293b;margin-bottom:8px">Discrepancias OC vs OV</h2>
        <p style="color:#475569;font-size:14px">
          <strong>OC:</strong> ${escHtml(pdfData.poNumber)} (${escHtml(pdfData.customer)})<br>
          <strong>OV:</strong> <a href="${ovUrl}" style="color:#2563eb">#${escHtml(soData.name || soData.idInDomain)}</a>
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
          <thead>
            <tr style="background:#f1f5f9">
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">#</th>
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">PN</th>
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Cant.OC</th>
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Precio OC</th>
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Cant.OV</th>
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Precio OV</th>
              <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">Discrepancia</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#94a3b8;font-size:11px;margin-top:12px">Generado por Steelhead Automator</p>
      </div>
    `;
  }

  async function sendInternalNotification(discrepancies, soData, pdfData) {
    if (discrepancies.length === 0) throw new Error('No hay discrepancias para notificar');
    log('Enviando notificacion interna...');

    // Get email template
    const templateData = await api().query('GetEmailDefaultByTypeAndSubType', { type: 'SALES_ORDER' });
    const template = templateData?.emailDefault || {};

    // Get internal recipients
    const recipientData = await api().query('GetUserEmailRecipients', {});
    const recipients = recipientData?.users?.nodes || recipientData?.users || [];

    if (recipients.length === 0) warn('No se encontraron destinatarios internos');

    const subject = `[Error nuestro] Discrepancias OC ${pdfData.poNumber} vs OV #${soData.name || soData.idInDomain}`;
    const body = buildDiscrepancyTableHTML(discrepancies, pdfData, soData);

    const toEmails = recipients.slice(0, 10).map(r => r.email).filter(Boolean);

    const sendResult = await api().query('SendEmailChecked', {
      subject,
      body,
      to: toEmails,
      cc: [],
      bcc: [],
      from: template.from || null,
      replyTo: template.replyTo || null
    });

    // Log email
    const messageId = sendResult?.sendEmail?.messageId || sendResult?.sendEmailChecked?.messageId || null;
    if (messageId) {
      try {
        await api().query('CreateEmailLogReceivedOrder', {
          salesOrderId: soData.id,
          messageId
        });
      } catch (e) {
        warn('Error registrando email log: ' + e.message);
      }
    }

    log(`Notificacion interna enviada a ${toEmails.length} destinatarios`);
  }

  async function sendClientNotification(discrepancies, soData, pdfData) {
    if (discrepancies.length === 0) throw new Error('No hay discrepancias para notificar');
    log('Enviando notificacion a servicio al cliente...');

    // Get email template
    const templateData = await api().query('GetEmailDefaultByTypeAndSubType', { type: 'SALES_ORDER' });
    const template = templateData?.emailDefault || {};

    // Get internal recipients (service team handles client-facing errors internally)
    const recipientData = await api().query('GetUserEmailRecipients', {});
    const recipients = recipientData?.users?.nodes || recipientData?.users || [];

    if (recipients.length === 0) warn('No se encontraron destinatarios internos');

    const subject = `[Error cliente] Discrepancias OC ${pdfData.poNumber} vs OV #${soData.name || soData.idInDomain} — comunicar al cliente`;
    const body = buildDiscrepancyTableHTML(discrepancies, pdfData, soData);

    const toEmails = recipients.slice(0, 10).map(r => r.email).filter(Boolean);

    const sendResult = await api().query('SendEmailChecked', {
      subject,
      body,
      to: toEmails,
      cc: [],
      bcc: [],
      from: template.from || null,
      replyTo: template.replyTo || null
    });

    // Log email
    const messageId = sendResult?.sendEmail?.messageId || sendResult?.sendEmailChecked?.messageId || null;
    if (messageId) {
      try {
        await api().query('CreateEmailLogReceivedOrder', {
          salesOrderId: soData.id,
          messageId
        });
      } catch (e) {
        warn('Error registrando email log: ' + e.message);
      }
    }

    log(`Notificacion de error de cliente enviada a ${toEmails.length} destinatarios internos`);
  }

  // ── Main UI Entry Point ─────────────────────────────────────

  async function processOneFile(file, fileIndex, totalFiles) {
    const prefix = totalFiles > 1 ? `[${fileIndex + 1}/${totalFiles}] ` : '';
    log(`${prefix}Procesando: ${file.name}`);

    // Step 2: Parse PDF with progress
    let progress = showProgress(`${prefix}Analizando PDF con Claude...`, 'Extrayendo datos de la orden de compra...');
    let pdfData;
    try {
      progress.update(20, 'Enviando PDF a Claude...');
      pdfData = await parsePDF(file);
      progress.update(100, 'Extraccion completada');
      progress.updateUsage();
      progress.close();
    } catch (e) {
      progress.close();
      alert(`${prefix}Error analizando PDF: ` + e.message);
      return { error: e.message };
    }

    // Step 3: Preview and confirm
    const confirmed = await showPDFPreview(pdfData);
    if (!confirmed) return processOneFile(file, fileIndex, totalFiles); // Retry

    // Step 4: Search for OV
    progress = showProgress(`${prefix}Buscando OV en Steelhead...`, 'Buscando orden de venta con PO "' + (pdfData.poNumber || '') + '"...');
    const customerId = getCustomerIdFromURL();
    let searchResult;
    try {
      progress.update(50, 'Consultando Steelhead...');
      searchResult = await findSalesOrder(pdfData.poNumber, customerId);
      progress.update(100, 'Busqueda completada');
      progress.close();
    } catch (e) {
      progress.close();
      alert(`${prefix}Error buscando OV: ` + e.message);
      return { error: e.message };
    }

    // Step 5: Resolve OV
    let orderId;
    if (searchResult.match === 'exact') {
      orderId = searchResult.orders[0].idInDomain || searchResult.orders[0].id;
    } else {
      orderId = await showOVSelector(searchResult, pdfData);
      if (!orderId) { log(`${prefix}Cancelado por el usuario`); return { cancelled: true }; }
    }

    // Step 6: Load OV + compare
    progress = showProgress(`${prefix}Cargando y comparando...`, 'Obteniendo datos de la OV...');
    let soData, comparison;
    try {
      progress.update(30, 'Cargando OV...');
      soData = await loadSalesOrder(orderId);

      progress.update(60, 'Comparando lineas...');
      comparison = compareOrders(pdfData, soData);

      // Try to enrich with discrepancy data
      progress.update(80, 'Cargando datos de recepcion...');
      try {
        const discrepancyData = await loadDiscrepancyData(orderId);
        if (discrepancyData.size > 0) {
          for (const line of comparison.lines) {
            const pn = normalizePN(line.pdfLine?.partNumber || line.soLine?.partNumber);
            if (pn && discrepancyData.has(pn)) {
              line.discrepancy = discrepancyData.get(pn);
            }
          }
        }
      } catch (e) {
        warn('Discrepancy data no disponible: ' + e.message);
      }

      progress.update(100, 'Comparacion lista');
      progress.close();
    } catch (e) {
      progress.close();
      alert(`${prefix}Error cargando OV: ` + e.message);
      return { error: e.message };
    }

    // Step 7: Show comparison report
    const result = await showComparisonReport(pdfData, soData, comparison);
    return { pdfData, soData, comparison, result };
  }

  async function runWithUI() {
    log('=== PO Comparator UI iniciando ===');
    claude().resetUsage();

    // Step 1: File picker (supports multiple)
    const files = await showFilePicker();
    if (!files) { log('Cancelado por el usuario'); return { cancelled: true }; }

    const results = [];
    for (let i = 0; i < files.length; i++) {
      const r = await processOneFile(files[i], i, files.length);
      results.push(r);
      if (r?.cancelled) break;
    }

    log('=== PO Comparator UI completado ===');
    return results.length === 1 ? results[0] : { batch: true, results };
  }

  // ── Public API ───────────────────────────────────────────────

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
})();

if (typeof window !== 'undefined') window.POComparator = POComparator;
