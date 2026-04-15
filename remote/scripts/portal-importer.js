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
        const re = new RegExp(patternStr, 'i');
        const match = String(description).match(re);
        if (match && match[1]) {
          return match[1].trim().replace(/[.,;:]+$/, '');
        }
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
        <div style="margin:8px 0">Filtrar status del portal: ${statusSelect}</div>
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
                <div class="candidate-detail">${p.lines.length} líneas · ${ops().escHtml(p.currency || '')} ${ops().fmtNumber(total, 2)} · Cliente: ${ops().escHtml(p.customer || '?')}</div>
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
      await resolveLinesForSingle(sourceData, customerId, layoutId);
      const orderId = await ops().createNewOV(formData, sourceData, file);
      const check = await verifyOVLines(orderId, sourceData.lines.filter(l => l.partNumber && !l._skipped).length);
      const msg = check ? `OV creada: #${orderId}\nLíneas: ${check.actual}/${check.expected}${check.missing ? ` (faltan ${check.missing})` : ''}` : `OV creada: #${orderId}`;
      alert(msg);
      return { created: true, orderId, check };
    }

    // No candidates — offer manual search or create
    const noMatch = await ops().showNoMatchOptions(sourceData);
    if (!noMatch) return { cancelled: true };
    if (noMatch.action === 'manual') return { manualId: noMatch.orderId };

    const creationData = await ops().fetchCreationData(customerId);
    const formData = await ops().showCreationWizard(sourceData, creationData, customerId);
    if (!formData) return { cancelled: true };
    await resolveLinesForSingle(sourceData, customerId, layoutId);
    const orderId = await ops().createNewOV(formData, sourceData, file);
    const check = await verifyOVLines(orderId, sourceData.lines.filter(l => l.partNumber && !l._skipped).length);
    const msg = check ? `OV creada: #${orderId}\nLíneas: ${check.actual}/${check.expected}${check.missing ? ` (faltan ${check.missing})` : ''}` : `OV creada: #${orderId}`;
    alert(msg);
    return { created: true, orderId, check };
  }

  // Pre-resolve PNs for a single PO with alternate fallback and manual picker.
  async function resolveLinesForSingle(sourceData, customerId, layoutId) {
    const unresolved = [];
    const suggestions = [];
    const fakePO = { poNumber: sourceData.poNumber };
    for (const line of sourceData.lines) {
      if (!line.partNumber && !line.buyerCode) continue;
      const res = await resolveLinePN(line, customerId);
      if (res.status === 'exact') {
        await recordSuccessfulMapping(line, customerId, layoutId);
      } else if (res.status === 'suggestion') {
        const s = res.resolved.suggestion;
        if (!suggestions.find(x => x.partNumberId === s.partNumberId)) suggestions.push(s);
      } else {
        unresolved.push({ line, po: fakePO, tried: res.tried });
      }
    }
    if (suggestions.length > 0) await ops().showSuggestionsModal(suggestions);
    if (unresolved.length > 0) {
      const picked = await showUnresolvedPNPicker(unresolved, customerId, layoutId);
      if (!picked) throw new Error('Cancelado en picker de PNs');
    }
  }

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
        <p class="dl9-sub">${auditRows.length} POs — revisa la acción sugerida por fila y procesa en lote. El filtro usa el status del <strong>portal</strong> (Hubbell), la columna "Estado Steelhead" indica si la OV ya existe en Steelhead.</p>
        <div style="margin:8px 0">Filtrar status del portal: ${statusSelect}</div>
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
      document.body.appendChild(ov);

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
            <td>${ops().escHtml(r.po.currency || '')} ${ops().fmtNumber(total, 2)}</td>
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
        const filter = md.querySelector('#pi-audit-status').value;
        const inFilter = (r) => filter === '__all__' || r.po.status === filter;
        ops().removeOverlay();
        resolve(auditRows.filter(r => inFilter(r) && r.action !== 'skip'));
      });

      renderTable();
    });
  }

  // Resolve a line's PN trying primary first, then the customer's buyerCode as alternate.
  // If resolved exact, mutates line.partNumber to the matched Steelhead label so downstream
  // resolvePartNumber calls (in createNewOV) find it too.
  async function resolveLinePN(line, customerId) {
    const tried = [];
    if (line.partNumber) {
      tried.push(line.partNumber);
      const r = await ops().resolvePartNumber(line.partNumber, customerId);
      if (r?.partNumberId && r.exact) {
        if (r.label) line.partNumber = r.label;
        return { status: 'exact', resolved: r, via: 'primary', tried };
      }
      if (r?.suggestion) return { status: 'suggestion', resolved: r, via: 'primary', tried };
    }
    if (line.buyerCode) {
      tried.push(line.buyerCode);
      const r = await ops().resolvePartNumber(line.buyerCode, customerId);
      if (r?.partNumberId && r.exact) {
        if (r.label) line.partNumber = r.label;
        line._resolvedVia = 'buyerCode';
        return { status: 'exact', resolved: r, via: 'buyerCode', tried };
      }
      if (r?.suggestion) return { status: 'suggestion', resolved: r, via: 'buyerCode', tried };
    }
    return { status: 'unresolved', tried };
  }

  // Shows a modal listing unresolved lines and lets the user search Steelhead's PN catalog
  // to pick the correct match for each one. Saved picks mutate line.partNumber and record
  // the mapping for future XLS imports.
  function showUnresolvedPNPicker(unresolved, customerId, layoutId) {
    ops().ensureStyles();
    return new Promise((resolve) => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      const items = unresolved.map((u, idx) => ({ ...u, idx, pickedId: null, pickedLabel: null }));

      md.innerHTML = `
        <h2>Números de parte no encontrados</h2>
        <p class="dl9-sub">${items.length} línea(s) sin PN resuelto en Steelhead. Busca el PN correcto por cada una — se guardará el mapeo para futuras importaciones. Las que dejes en "Omitir" no se crearán.</p>
        <div id="pi-upn-list" style="max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin:12px 0"></div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-upn-cancel">Cancelar batch</button>
          <button class="dl9-btn dl9-btn-primary" id="pi-upn-continue">Continuar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const listEl = md.querySelector('#pi-upn-list');

      listEl.innerHTML = items.map(it => {
        const tried = (it.tried || []).filter(Boolean).map(s => ops().escHtml(s)).join(' · ');
        const desc = it.line.description ? ops().escHtml(String(it.line.description).substring(0, 120)) : '';
        return `
          <div class="candidate-item" style="flex-direction:column;align-items:stretch;gap:6px" data-idx="${it.idx}">
            <div class="candidate-info">
              <div class="candidate-name">PO ${ops().escHtml(it.po.poNumber)} · línea ${ops().escHtml(String(it.line.lineNumber || ''))}</div>
              <div class="candidate-detail">Intentado: ${tried || '—'}${desc ? ` · ${desc}` : ''}</div>
            </div>
            <input type="text" class="pi-upn-search" placeholder="Buscar en catálogo de Steelhead..."
              style="padding:6px 8px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px">
            <div class="pi-upn-results" style="max-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>
            <div class="pi-upn-picked" style="font-size:12px;color:#94a3b8">Acción: <strong>Omitir</strong></div>
          </div>`;
      }).join('');

      async function runSearch(rowEl, idx, q) {
        const resultsEl = rowEl.querySelector('.pi-upn-results');
        if (!q || q.length < 2) { resultsEl.innerHTML = ''; return; }
        try {
          const data = await api().query('PartNumberCreatableSelectGetPartNumbers', {
            name: `%${q}%`,
            searchQuery: '',
            hideCustomerPartsWhenNoCustomerIdFilter: true,
            customerId: customerId ? parseInt(customerId, 10) : null,
            specIds: [],
            paramIds: []
          });
          const pns = (data?.searchPartNumbers?.nodes || []).slice(0, 15);
          if (pns.length === 0) { resultsEl.innerHTML = '<p style="color:#64748b;font-size:11px;padding:4px">Sin coincidencias.</p>'; return; }
          resultsEl.innerHTML = pns.map(p => `
            <div class="pi-upn-opt" data-id="${ops().escHtml(p.value || p.id)}" data-label="${ops().escHtml(p.label)}"
              style="padding:4px 8px;cursor:pointer;border-radius:3px;font-size:12px;color:#e2e8f0;background:#1e293b">
              ${ops().escHtml(p.label)}
            </div>`).join('');
          resultsEl.querySelectorAll('.pi-upn-opt').forEach(opt => {
            opt.addEventListener('click', () => {
              items[idx].pickedId = opt.dataset.id;
              items[idx].pickedLabel = opt.dataset.label;
              rowEl.querySelector('.pi-upn-picked').innerHTML = `Asignado: <strong style="color:#34d399">${ops().escHtml(opt.dataset.label)}</strong>`;
            });
          });
        } catch (e) {
          resultsEl.innerHTML = `<p style="color:#f87171;font-size:11px;padding:4px">Error: ${ops().escHtml(e.message)}</p>`;
        }
      }

      listEl.querySelectorAll('.candidate-item').forEach(rowEl => {
        const idx = parseInt(rowEl.dataset.idx, 10);
        const input = rowEl.querySelector('.pi-upn-search');
        const prefill = (items[idx].line.partNumber || items[idx].line.buyerCode || '').trim();
        if (prefill) { input.value = prefill; runSearch(rowEl, idx, prefill); }
        let timer = null;
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => runSearch(rowEl, idx, input.value.trim()), 300);
        });
      });

      md.querySelector('#pi-upn-cancel').addEventListener('click', () => { ops().removeOverlay(); resolve(null); });
      md.querySelector('#pi-upn-continue').addEventListener('click', async () => {
        for (const it of items) {
          if (it.pickedId && it.pickedLabel) {
            it.line.partNumber = it.pickedLabel;
            it.line._resolvedVia = 'manual';
            if (customerId && layoutId && it.line.buyerCode) {
              try { await saveMappingEntry(customerId, layoutId, it.line.buyerCode, it.pickedLabel); } catch (_) {}
            }
          } else {
            it.line.partNumber = null;
            it.line._skipped = true;
          }
        }
        ops().removeOverlay();
        resolve(items);
      });
    });
  }

  // Query Steelhead for the actual line count after create/adopt so we can verify
  // the expected lines were persisted. Returns { actual, missing } or null on error.
  async function verifyOVLines(ovId, expected) {
    try {
      const data = await api().query('GetReceivedOrder', {
        idInDomain: parseInt(ovId, 10),
        revisionNumber: 1
      });
      const order = data?.receivedOrder;
      const lines = order?.receivedOrderLines?.nodes || order?.receivedOrderLines || [];
      return { actual: lines.length, expected, missing: Math.max(expected - lines.length, 0) };
    } catch (e) {
      warn(`No se pudo verificar líneas de OV #${ovId}: ${e.message}`);
      return null;
    }
  }

  async function executeBulk(selectedRows, layout, layoutId, file, customerId) {
    if (selectedRows.length === 0) {
      alert('No hay POs para procesar.');
      return { processed: 0 };
    }

    log(`Procesando ${selectedRows.length} POs...`);

    // Pre-check: resolve PNs with alternate fallback; collect suggestions and unresolved lines.
    const suggestions = [];
    const unresolved = [];
    for (const r of selectedRows) {
      if (r.action !== 'create' && r.action !== 'adopt') continue;
      for (const line of r.po.lines) {
        if (!line.partNumber && !line.buyerCode) continue;
        const res = await resolveLinePN(line, customerId);
        if (res.status === 'exact') {
          await recordSuccessfulMapping(line, customerId, layoutId);
        } else if (res.status === 'suggestion') {
          const s = res.resolved.suggestion;
          if (!suggestions.find(x => x.partNumberId === s.partNumberId)) suggestions.push(s);
        } else {
          unresolved.push({ line, po: r.po, tried: res.tried });
        }
      }
    }

    if (suggestions.length > 0) {
      await ops().showSuggestionsModal(suggestions);
    }

    if (unresolved.length > 0) {
      log(`${unresolved.length} línea(s) sin PN resuelto — mostrando picker manual...`);
      const picked = await showUnresolvedPNPicker(unresolved, customerId, layoutId);
      if (!picked) { log('Batch cancelado en picker de PNs'); return { cancelled: true }; }
    }

    // Fetch creation data once for all creates
    const creationData = await ops().fetchCreationData(customerId);

    const results = [];
    for (let i = 0; i < selectedRows.length; i++) {
      const r = selectedRows[i];
      log(`[${i + 1}/${selectedRows.length}] Procesando PO ${r.po.poNumber} (${r.action})...`);

      const linesWithPN = r.po.lines.filter(l => l.partNumber && !l._skipped);
      const expectedLines = linesWithPN.length;

      const sourceData = {
        poNumber: r.po.poNumber, customer: r.po.customer, currency: r.po.currency,
        lines: r.po.lines, sourceType: 'xls', fileName: file.name
      };

      const csvFile = buildCSVForPO(r.po, file.name);

      try {
        if (r.action === 'adopt') {
          const orderId = await ops().adoptExistingOV(r.candidate, sourceData, csvFile);
          const check = await verifyOVLines(orderId, expectedLines);
          results.push({ po: r.po.poNumber, action: 'adopted', orderId, expectedLines, check });
        } else if (r.action === 'create') {
          const formData = buildDefaultFormData(sourceData, creationData, customerId);
          const orderId = await ops().createNewOV(formData, sourceData, csvFile);
          const check = await verifyOVLines(orderId, expectedLines);
          results.push({ po: r.po.poNumber, action: 'created', orderId, expectedLines, check });
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
      let linesCell = '—';
      if (r.check) {
        const { actual, expected, missing } = r.check;
        const lineColor = missing > 0 ? '#f87171' : '#34d399';
        linesCell = `<span style="color:${lineColor}">${actual}/${expected}${missing > 0 ? ` (faltan ${missing})` : ''}</span>`;
      } else if (r.expectedLines != null) {
        linesCell = `<span style="color:#94a3b8">?/${r.expectedLines}</span>`;
      }
      return `<tr><td>${ops().escHtml(r.po)}</td><td style="color:${color}">${r.action}</td><td>${ops().escHtml(label)}</td><td>${linesCell}</td></tr>`;
    }).join('');

    const mismatches = results.filter(r => r.check && r.check.missing > 0).length;
    const warnBanner = mismatches > 0
      ? `<p class="dl9-sub" style="color:#f87171"><strong>${mismatches}</strong> OV(s) con menos líneas de las esperadas. Revisa el log.</p>`
      : '';

    md.innerHTML = `
      <h2>Resultados del batch</h2>
      <p class="dl9-sub">${results.length} POs procesados.</p>
      ${warnBanner}
      <table class="dl9-audit-table">
        <thead><tr><th>PO</th><th>Acción</th><th>Resultado</th><th>Líneas</th></tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
      <div class="dl9-btnrow">
        <button class="dl9-btn" id="pi-br-copylog" style="background:#475569;color:#e2e8f0">Copiar log</button>
        <button class="dl9-btn dl9-btn-primary" id="pi-br-close">Cerrar</button>
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);

    md.querySelector('#pi-br-copylog').addEventListener('click', async () => {
      try {
        const lines = api().getLog().join('\n');
        await navigator.clipboard.writeText(lines);
        const btn = md.querySelector('#pi-br-copylog');
        const orig = btn.textContent;
        btn.textContent = `Copiado (${api().getLog().length} líneas)`;
        setTimeout(() => { btn.textContent = orig; }, 2000);
      } catch (e) {
        alert('No se pudo copiar: ' + e.message);
      }
    });
    md.querySelector('#pi-br-close').addEventListener('click', () => ops().removeOverlay());
  }

  async function processBulkMode(pos, layout, layoutId, file, parsedData, customerId) {
    const auditRows = await buildAuditRows(pos, customerId, layoutId);
    const selected = await showAuditTable(auditRows, layout, file, parsedData);
    if (!selected) return { cancelled: true };

    return await executeBulk(selected, layout, layoutId, file, customerId);
  }

  // ── Customer Resolution ───────────────────────────────────

  // Strips Mexican/international legal entity suffixes from the end of a razón social.
  // Iterates a set of patterns to handle both spaced ("SA DE CV") and dotted
  // ("S.A. de C.V.") variants, plus international (INC, LLC, GMBH, ...).
  function stripLegalSuffix(name) {
    if (!name) return '';
    const patterns = [
      /[,\.\s]+S\.?\s*A\.?\s*P\.?\s*I\.?\s+DE\s+C\.?\s*V\.?\s*$/i,
      /[,\.\s]+S\.?\s*DE\s+R\.?\s*L\.?\s+DE\s+C\.?\s*V\.?\s*$/i,
      /[,\.\s]+S\.?\s*A\.?\s+DE\s+C\.?\s*V\.?\s*$/i,
      /[,\.\s]+S\.?\s*DE\s+R\.?\s*L\.?\s*$/i,
      /[,\.\s]+S\.?\s*A\.?\s*S\.?\s*$/i,
      /[,\.\s]+S\.?\s*A\.?\s*B\.?\s*$/i,
      /[,\.\s]+S\.?\s*A\.?\s*$/i,
      /[,\.\s]+S\.?\s*C\.?\s*$/i,
      /[,\.\s]+(?:LLC|LTD|LTDA|INC|CORP|CO|GMBH|AG|KG|BV|NV|OY|PLC|SPA|SRL)\.?\s*$/i
    ];
    let out = String(name).trim();
    for (let i = 0; i < 3; i++) {
      let changed = false;
      for (const p of patterns) {
        const next = out.replace(p, '').trim().replace(/[,\.]+$/, '').trim();
        if (next !== out) { out = next; changed = true; }
      }
      if (!changed) break;
    }
    return out;
  }

  // Tries to match XLS customer names against Steelhead customers via CustomerSearchByName.
  // Returns { id, name } or null. Strips legal entity suffixes before searching so names
  // like "HUBBELL PRODUCTS MEXICO S. DE R.L. DE CV" match "HUBBELL PRODUCTS MEXICO".
  async function resolveCustomerFromXLS(pos) {
    const names = [...new Set(pos.map(p => p.customer).filter(Boolean))];
    if (names.length === 0) return null;

    for (const raw of names) {
      const queries = [raw];
      const stripped = stripLegalSuffix(raw);
      if (stripped && stripped !== raw) queries.push(stripped);

      for (const q of queries) {
        try {
          const data = await api().query('CustomerSearchByName', {
            nameLike: `%${q}%`, orderBy: ['NAME_ASC']
          });
          const nodes = data?.searchCustomers?.nodes || data?.pagedData?.nodes || data?.allCustomers?.nodes || [];
          const qUp = q.toUpperCase();
          const exact = nodes.find(c => (c.name || '').toUpperCase() === qUp);
          if (exact) return { id: String(exact.id), name: exact.name };
          const startsWith = nodes.find(c => (c.name || '').toUpperCase().startsWith(qUp));
          if (startsWith) return { id: String(startsWith.id), name: startsWith.name };
          if (nodes.length === 1) return { id: String(nodes[0].id), name: nodes[0].name };
        } catch (e) {
          warn(`CustomerSearchByName falló para "${q}": ${e.message}`);
        }
      }
    }
    return null;
  }

  // Fetches all non-archived customers via AllCustomers paginated.
  async function fetchActiveCustomers() {
    const all = [];
    const seen = new Set();
    const PAGE = 500;
    let offset = 0;
    while (true) {
      let data;
      try {
        data = await api().query('AllCustomers', {
          includeArchived: 'NO',
          includeAccountingFields: false,
          orderBy: ['NAME_ASC'],
          offset, first: PAGE, searchQuery: ''
        });
      } catch (e) {
        warn(`AllCustomers offset ${offset}: ${e.message}`);
        break;
      }
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (n.id && !seen.has(n.id) && !n.archivedAt) {
          seen.add(n.id);
          all.push({ id: String(n.id), name: n.name || '' });
        }
      }
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 20000) break;
    }
    return all;
  }

  // Modal with searchable list of non-archived customers.
  // Resolves to { id, name } or null (if cancelled).
  function showCustomerPicker(prefillQuery) {
    ops().ensureStyles();
    return new Promise((resolve) => {
      const ov = ops().createOverlay();
      const md = ops().createModal();

      md.innerHTML = `
        <h2>Selecciona el cliente</h2>
        <p class="dl9-sub">La URL no trae cliente y no se pudo inferir del XLS. Elige uno de la lista.</p>
        <input id="pi-cust-search" type="text" placeholder="Buscar cliente..." value="${ops().escHtml(prefillQuery || '')}"
          style="width:100%;padding:8px 10px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px;margin-bottom:8px">
        <div id="pi-cust-list" style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
          <p style="color:#94a3b8;text-align:center;padding:16px;font-size:13px">Cargando clientes activos...</p>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="pi-cust-cancel">Cancelar</button>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const searchEl = md.querySelector('#pi-cust-search');
      const listEl = md.querySelector('#pi-cust-list');
      let customers = [];

      function render() {
        const q = (searchEl.value || '').trim().toUpperCase();
        const filtered = q ? customers.filter(c => (c.name || '').toUpperCase().includes(q)) : customers;
        const MAX = 200;
        const shown = filtered.slice(0, MAX);

        if (filtered.length === 0) {
          listEl.innerHTML = '<p style="color:#64748b;text-align:center;padding:16px;font-size:13px">Sin coincidencias.</p>';
          return;
        }

        let html = shown.map(c => `
          <div class="candidate-item" data-id="${ops().escHtml(c.id)}">
            <div class="candidate-info">
              <div class="candidate-name">${ops().escHtml(c.name)}</div>
              <div class="candidate-detail">id ${ops().escHtml(c.id)}</div>
            </div>
          </div>`).join('');
        if (filtered.length > MAX) {
          html += `<p style="color:#64748b;text-align:center;padding:8px;font-size:12px">+${filtered.length - MAX} más — refina la búsqueda</p>`;
        }
        listEl.innerHTML = html;

        listEl.querySelectorAll('.candidate-item').forEach(el => {
          el.addEventListener('click', () => {
            const id = el.dataset.id;
            const c = customers.find(x => x.id === id);
            ops().removeOverlay();
            resolve(c ? { id: c.id, name: c.name } : null);
          });
        });
      }

      md.querySelector('#pi-cust-cancel').addEventListener('click', () => {
        ops().removeOverlay();
        resolve(null);
      });
      searchEl.addEventListener('input', render);

      fetchActiveCustomers().then(list => {
        customers = list;
        log(`Picker de clientes: ${customers.length} activos cargados`);
        render();
        searchEl.focus();
        searchEl.select();
      }).catch(e => {
        listEl.innerHTML = `<p style="color:#f87171;text-align:center;padding:16px;font-size:13px">Error cargando clientes: ${ops().escHtml(e.message)}</p>`;
      });
    });
  }

  // ── Main Orchestrator ─────────────────────────────────────

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
      try {
        layout = await inferLayoutWithClaude(parsed.headers, parsed.rows);
        layoutId = 'claude-inferred';
        log(`Layout inferido por Claude`);
      } catch (e) {
        alert('Error infiriendo layout con Claude: ' + e.message);
        return { error: e.message };
      }
    }

    const pos = groupByPO(parsed.rows, parsed.headers, layout);
    if (pos.length === 0) {
      alert('No se detectaron POs en el archivo.');
      return { error: 'no POs' };
    }

    let customerId = window.POComparator?.getCustomerIdFromURL() || null;
    if (customerId) {
      log(`Cliente detectado desde URL: #${customerId}`);
    } else {
      log('URL sin customerId — buscando cliente en Steelhead por el nombre del XLS...');
      const resolved = await resolveCustomerFromXLS(pos);
      if (resolved && confirm(`La URL no trae customerId. Cliente inferido del XLS:\n\n  ${resolved.name} (id ${resolved.id})\n\n¿Usar éste?`)) {
        customerId = resolved.id;
        log(`Cliente resuelto desde XLS: ${resolved.name} (#${customerId})`);
      } else {
        const xlsName = pos.map(p => p.customer).find(Boolean) || '';
        const picked = await showCustomerPicker(xlsName);
        if (!picked) {
          log('Abortado: usuario canceló el picker de clientes');
          return { cancelled: true };
        }
        customerId = picked.id;
        log(`Cliente seleccionado manualmente: ${picked.name} (#${customerId})`);
      }
    }

    // Enrich lines with stored mapping table entries (buyerCode → known PN)
    await enrichLinesWithMapping(pos, customerId, layoutId);

    const mode = await showModeSelector(pos);
    if (!mode) return { cancelled: true };

    // Store parsedData for source viewer (with PO column index)
    const poColumnIndex = parsed.headers.indexOf(layout.mapping.poNumber);
    const parsedData = { headers: parsed.headers, rows: parsed.rows, poColumnIndex };

    try {
      if (mode === 'single') {
        return await processSingleMode(pos, layout, layoutId, file, parsedData, customerId);
      } else {
        return await processBulkMode(pos, layout, layoutId, file, parsedData, customerId);
      }
    } catch (e) {
      warn(`Flujo interrumpido: ${e.message}`);
      try { ops().removeOverlay(); } catch (_) {}
      const copy = confirm(`Error en el flujo: ${e.message}\n\n¿Copiar log al portapapeles?`);
      if (copy) {
        try { await navigator.clipboard.writeText(api().getLog().join('\n')); } catch (_) {}
      }
      return { error: e.message };
    }
  }

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
    recordSuccessfulMapping,
    inferLayoutWithClaude,
    showPOSelector,
    processSingleMode,
    processBulkMode,
    buildAuditRows,
    executeBulk
  };
})();

window.PortalImporter = PortalImporter;
