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
})();

window.PortalImporter = PortalImporter;
