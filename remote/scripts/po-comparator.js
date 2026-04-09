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

  // ── Public API ───────────────────────────────────────────────

  return {
    run,
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
