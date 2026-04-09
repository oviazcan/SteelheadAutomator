// Steelhead Automator v2 — Service Worker (Background)
// Multi-app architecture: routes messages, injects per-app scripts

const REMOTE_BASE_URL = 'https://oviazcan.github.io/SteelheadAutomator';
const CONFIG_URL = `${REMOTE_BASE_URL}/config.json`;

let cachedConfig = null;

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[SA] Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
});

// ── Config ──
async function loadConfig() {
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cachedConfig = await response.json();
    await chrome.storage.local.set({ config: cachedConfig });
    return cachedConfig;
  } catch (err) {
    console.warn('[SA] Error cargando config:', err.message);
    const stored = await chrome.storage.local.get('config');
    cachedConfig = stored.config || null;
    return cachedConfig;
  }
}

// ── Script Injection ──
async function fetchScriptCode(scriptPath) {
  // Siempre re-cargar config para que `version` cache-buster sea fresco.
  // Sin esto, el service worker mantiene cachedConfig vieja entre acciones y
  // sigue pidiendo el script con el ?v=X anterior → CDN/browser sirve cached.
  const config = await loadConfig();
  const url = `${REMOTE_BASE_URL}/${scriptPath}?v=${config?.version || Date.now()}`;
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status} cargando ${scriptPath}`);
  return await response.text();
}

async function injectAppScripts(tabId, appId) {
  const config = cachedConfig || await loadConfig();
  if (!config) throw new Error('Config no disponible');

  // Find app's script list, fallback to root scripts
  const app = config.apps?.find(a => a.id === appId);
  const scripts = app?.scripts || config.scripts || [];

  for (const scriptPath of scripts) {
    const code = await fetchScriptCode(scriptPath);
    // Re-inyectar si cambió la version del config (sin esto, los updates nunca
    // llegan a la pestaña — el window.X viejo se queda pegado para siempre).
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (c, path, version) => {
        const globals = { 'scripts/steelhead-api.js': 'SteelheadAPI', 'scripts/bulk-upload.js': 'BulkUpload',
          'scripts/catalog-fetcher.js': 'CatalogFetcher', 'scripts/hash-scanner.js': 'HashScanner',
          'scripts/api-knowledge.js': 'APIKnowledge', 'scripts/inventory-reset.js': 'InventoryReset', 'scripts/spec-migrator.js': 'SpecMigrator', 'scripts/report-liberator.js': 'ReportLiberator' };
        const globalName = globals[path];
        // Skip si ya está cargado CON la misma version
        if (globalName && window[globalName] && window[globalName].__saVersion === version) return;
        try {
          new Function(c)();
          // Tag con la version actual para detectar staleness en próximas cargas
          if (globalName && window[globalName]) window[globalName].__saVersion = version;
        } catch (e) { console.error('[SA]', e); }
      },
      args: [code, scriptPath, config?.version || '0']
    });
  }

  // Always init API + APIKnowledge with latest config
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (j) => {
      const cfg = JSON.parse(j);
      if (window.SteelheadAPI) window.SteelheadAPI.init(cfg);
      if (window.HashScanner) window.HashScanner.init(cfg);
      if (window.APIKnowledge) window.APIKnowledge.init(cfg);
    },
    args: [JSON.stringify(config)]
  });
}

// Backward compat
async function injectScripts(tabId) { return injectAppScripts(tabId, 'carga-masiva'); }

async function getSteelheadTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url?.includes('app.gosteelhead.com')) throw new Error('Abre Steelhead primero (app.gosteelhead.com)');
  return tab;
}

// ── Message Router ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[SA] Error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.action) {

    // ── General ──
    case 'get-status': {
      const config = cachedConfig || await loadConfig();
      return { version: config?.version || 'sin conexión', lastUpdated: config?.lastUpdated || 'desconocido', connected: !!config };
    }

    case 'get-config':
      return cachedConfig || await loadConfig();

    case 'check-scan-status': {
      try {
        const tab = await getSteelheadTab();
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => window.HashScanner ? { scanning: window.HashScanner.isActive(), stats: window.HashScanner.getStats() } : { scanning: false }
        });
        return results?.[0]?.result || { scanning: false };
      } catch (_) { return { scanning: false }; }
    }

    // ── Carga Masiva ──
    case 'run-csv': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'carga-masiva');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (csv) => {
          if (!window.BulkUpload) return { error: 'BulkUpload no disponible' };
          window.BulkUpload.execute(csv).then(r => console.log('[SA] Pipeline:', r)).catch(e => console.error('[SA]', e));
          return { started: true, message: 'Pipeline iniciado. Revisa Steelhead.' };
        },
        args: [message.csvText]
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    case 'view-load-history': {
      const tab = await getSteelheadTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          const history = JSON.parse(localStorage.getItem('sa_load_history') || '[]');
          return { operations: history };
        }
      });
      return results?.[0]?.result || { operations: [] };
    }

    case 'download-load-csv': {
      // Download a specific load's data as CSV for correction.
      // V10: emite layout 69-cols compatible con bulk-upload (re-cargable directo).
      const tab = await getSteelheadTab();
      const loadId = message.loadId;
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (id) => {
          const history = JSON.parse(localStorage.getItem('sa_load_history') || '[]');
          const load = history.find(h => h.id === id);
          if (!load) return { error: 'Carga no encontrada' };
          const parts = load.parts || [];
          if (!parts.length) return { error: 'Sin datos de PNs' };

          // Predictive material columns (BB-BJ = 53-61) — debe matchear bulk-upload PREDICTIVE_MATERIALS
          const PRED_BY_ITEM = {
            364506: 53, 397490: 54, 412305: 55, 412805: 56, 412479: 57,
            412723: 58, 702767: 59, 702769: 60, 702768: 61
          };
          const TOTAL_COLS = 69;
          const COLS_USED_RANGE = 69; // A-BQ

          // CSV escape helper
          const esc = v => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
            return s;
          };
          const boolStr = b => (b ? 'V' : 'F');
          const blankRow = () => Array(TOTAL_COLS).fill('');

          const out = [];
          // Row 0: Modo en col G (idx 6) — parseRows escanea primeras 3 filas
          const row0 = blankRow(); row0[6] = load.header?.modo || load.mode || 'SOLO_PN';
          out.push(row0);
          // Row 1: title (no afecta parser, solo decoración)
          const row1 = blankRow(); row1[0] = 'Carga Masiva Steelhead v10 (export historial)';
          out.push(row1);
          // Row 2: Empresa, Layout, Notas
          const row2 = blankRow();
          row2[0] = 'Empresa Emisora:'; row2[2] = load.header?.empresaEmisora || '';
          row2[4] = 'Nombre Cotización/Layout:'; row2[6] = load.header?.quoteName || '';
          row2[8] = 'Notas Externas:'; row2[10] = load.header?.notasExternas || '';
          row2[14] = 'Notas Internas:'; row2[16] = load.header?.notasInternas || '';
          out.push(row2);
          // Row 3: Válida, Asignado
          const row3 = blankRow();
          row3[0] = 'Válida Hasta (días):'; row3[2] = load.header?.validaDias || '';
          row3[4] = 'Asignado:'; row3[6] = load.header?.asignado || '';
          out.push(row3);
          // Row 4: empty separator
          out.push(blankRow());
          // Row 5: section header — col A = "PARÁMETROS" → parseRows lo skipea
          const row5 = blankRow(); row5[0] = 'PARÁMETROS';
          out.push(row5);
          // Row 6: column header row — col A = "Archivado" → parseRows lo skipea
          const row6 = blankRow();
          row6[0] = 'Archivado'; row6[1] = 'Validación 1er recibo'; row6[2] = 'Forzar duplicar'; row6[3] = 'Archivar anterior';
          row6[4] = 'Cliente'; row6[5] = 'Número de parte'; row6[6] = 'Descripción'; row6[7] = 'PN alterno'; row6[8] = 'Grupo';
          row6[9] = 'Cantidad'; row6[10] = 'Precio'; row6[11] = 'Unidad precio'; row6[12] = 'Divisa'; row6[13] = 'Precio default';
          row6[14] = 'Metal base'; row6[15] = 'Etq1'; row6[16] = 'Etq2'; row6[17] = 'Etq3'; row6[18] = 'Etq4'; row6[19] = 'Etq5';
          row6[20] = 'Proceso'; row6[33] = 'Spec1'; row6[35] = 'Spec2';
          row6[41] = 'Rack Línea'; row6[43] = 'Rack Sec';
          row6[50] = 'Línea'; row6[51] = 'Departamento'; row6[52] = 'Código SAT';
          out.push(row6);
          // Row 7: type indicators — col A = "V/F" → parseRows lo skipea
          const row7 = blankRow(); row7[0] = 'V/F'; row7[5] = 'Texto';
          out.push(row7);

          // Data rows
          for (const p of parts) {
            const r = blankRow();
            // Parámetros
            r[0] = boolStr(p.archivado); r[1] = boolStr(p.validacion1er);
            r[2] = boolStr(p.forzarDuplicado); r[3] = boolStr(p.archivarAnterior);
            // Identificación
            r[4] = p.cliente || '';
            r[5] = p.pn || '';
            r[6] = p.descripcion || '';
            r[7] = p.pnAlterno || '';
            r[8] = p.pnGroup || '';
            // Precio
            r[9] = p.qty != null ? p.qty : '';
            r[10] = p.precio != null ? p.precio : '';
            r[11] = p.unidadPrecio || '';
            r[12] = p.divisa || '';
            r[13] = boolStr(p.precioDefault);
            // Acabados
            r[14] = p.metalBase || '';
            const labels = p.labels || [];
            for (let li = 0; li < 5; li++) r[15 + li] = labels[li] || '';
            // Proceso
            r[20] = p.procesoOverride || '';
            // Productos (hasta 3)
            const prods = p.products || [];
            for (let pi = 0; pi < Math.min(prods.length, 3); pi++) {
              const base = 21 + pi * 4;
              r[base] = prods[pi].name || '';
              r[base + 1] = prods[pi].price != null ? prods[pi].price : '';
              r[base + 2] = prods[pi].qty != null ? prods[pi].qty : '';
              r[base + 3] = prods[pi].unit || '';
            }
            // Specs (hasta 2) — formato "name | param" cuando hay param
            const specs = p.specs || [];
            for (let si = 0; si < Math.min(specs.length, 2); si++) {
              const sCol = 33 + si * 2;
              const s = specs[si];
              r[sCol] = s.param ? `${s.name} | ${s.param}` : (s.name || '');
            }
            // Conversiones
            const uc = p.unitConv || {};
            r[37] = uc.kgm != null ? uc.kgm : '';
            r[38] = uc.cmk != null ? uc.cmk : '';
            r[39] = uc.lm != null ? uc.lm : '';
            r[40] = uc.minPzasLote != null ? uc.minPzasLote : '';
            // Racks (hasta 2)
            const racks = p.racks || [];
            if (racks[0]) { r[41] = racks[0].name || ''; r[42] = racks[0].ppr != null ? racks[0].ppr : ''; }
            if (racks[1]) { r[43] = racks[1].name || ''; r[44] = racks[1].ppr != null ? racks[1].ppr : ''; }
            // Dimensiones
            const d = p.dims || {};
            r[45] = d.length != null ? d.length : '';
            r[46] = d.width != null ? d.width : '';
            r[47] = d.height != null ? d.height : '';
            r[48] = d.outerDiam != null ? d.outerDiam : '';
            r[49] = d.innerDiam != null ? d.innerDiam : '';
            // Asignación contable
            r[50] = p.linea || '';
            r[51] = p.departamento || '';
            r[52] = p.codigoSAT || '';
            // Predictivos (mapa por inventoryItemId → col)
            for (const pu of (p.predictiveUsage || [])) {
              const c = PRED_BY_ITEM[pu.inventoryItemId];
              if (c != null) r[c] = pu.usagePerPart != null ? pu.usagePerPart : '';
            }
            // IBMS
            r[62] = p.quoteIBMS || '';
            r[63] = p.estacionIBMS || '';
            r[64] = p.plano || '';
            r[65] = p.piezasCarga != null ? p.piezasCarga : '';
            r[66] = p.cargasHora || '';
            r[67] = p.tiempoEntrega != null ? p.tiempoEntrega : '';
            r[68] = p.notasAdicionalesPN || '';
            out.push(r);
          }

          const csv = out.map(row => row.map(esc).join(',')).join('\r\n');
          const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `correccion_${load.mode}_${new Date(load.timestamp).toISOString().slice(0, 10)}_${load.id}.csv`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
          return { started: true, message: 'CSV v10 descargado' };
        },
        args: [loadId]
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    case 'update-catalogs': {
      const tab = await getSteelheadTab();
      const xlsxCode = await fetchScriptCode('scripts/lib/xlsx.full.min.js');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (c) => { if (!window.XLSX) new Function(c)(); }, args: [xlsxCode]
      });
      await injectAppScripts(tab.id, 'carga-masiva');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.CatalogFetcher) return { error: 'CatalogFetcher no disponible' };
          window.CatalogFetcher.generateCatalogsFile().then(c => console.log('[SA] Catálogos:', c)).catch(e => alert('Error: ' + e.message));
          return { started: true };
        }
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Hash Scanner ──
    case 'toggle-scan': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'hash-scanner');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.HashScanner) return { error: 'HashScanner no disponible' };
          if (window.HashScanner.isActive()) {
            window.HashScanner.stop();
            // Auto-export scan results on stop
            const dateStr = new Date().toISOString().slice(0, 10);
            const scanData = window.HashScanner.getResults();
            const apiKnowledge = window.APIKnowledge ? window.APIKnowledge.getKnownOperations() : [];
            const fullExport = { exportedAt: new Date().toISOString(), scanResults: scanData, apiKnowledge: apiKnowledge };
            const blob = new Blob([JSON.stringify(fullExport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'scan_results_' + dateStr + '.json';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            return { started: false, message: 'Captura detenida. Resultados exportados.', stats: window.HashScanner.getStats() };
          } else {
            window.HashScanner.start();
            return { started: true, message: 'Captura iniciada. Navega por Steelhead para capturar operaciones.' };
          }
        }
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    case 'view-scan-results': {
      const tab = await getSteelheadTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.HashScanner) return { error: 'HashScanner no disponible. Inicia captura primero.' };
          return { operations: window.HashScanner.getResults(), stats: window.HashScanner.getStats() };
        }
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    case 'export-config': {
      const tab = await getSteelheadTab();
      const config = cachedConfig || await loadConfig();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (configJson) => {
          if (!window.HashScanner) return { error: 'HashScanner no disponible' };
          const updated = window.HashScanner.exportConfig(JSON.parse(configJson));
          const dateStr = new Date().toISOString().slice(0, 10);

          // 1. Download updated config
          const blob1 = new Blob([JSON.stringify(updated, null, 2)], { type: 'application/json' });
          const url1 = URL.createObjectURL(blob1);
          const a1 = document.createElement('a');
          a1.href = url1; a1.download = 'config_updated_' + dateStr + '.json';
          document.body.appendChild(a1); a1.click(); document.body.removeChild(a1);
          URL.revokeObjectURL(url1);

          // 2. Download full scan results (hashes + schemas + variables)
          const scanData = window.HashScanner.getResults();
          const apiKnowledge = window.APIKnowledge ? window.APIKnowledge.getKnownOperations() : [];
          const fullExport = { exportedAt: new Date().toISOString(), scanResults: scanData, apiKnowledge: apiKnowledge };
          const blob2 = new Blob([JSON.stringify(fullExport, null, 2)], { type: 'application/json' });
          const url2 = URL.createObjectURL(blob2);
          const a2 = document.createElement('a');
          a2.href = url2; a2.download = 'scan_results_' + dateStr + '.json';
          document.body.appendChild(a2); a2.click(); document.body.removeChild(a2);
          URL.revokeObjectURL(url2);
          URL.revokeObjectURL(url);
          return { started: true, message: 'Config exportado.' };
        },
        args: [JSON.stringify(config)]
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    case 'show-api-knowledge': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'hash-scanner');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.APIKnowledge) return { error: 'APIKnowledge no disponible' };
          return { operations: window.APIKnowledge.getKnownOperations(), summary: window.APIKnowledge.getSummary() };
        }
      });
      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Archiver ──
    case 'run-archiver': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'archiver');

      // Show config form in Steelhead page, then run
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.PNArchiver) return { error: 'PNArchiver no disponible' };

          // Show configuration form as modal
          return new Promise(resolve => {
            if (!document.getElementById('dl9-styles')) {
              const s = document.createElement('style'); s.id = 'dl9-styles';
              s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:500px;width:92%;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 12px}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#ef4444;color:white}`;
              document.head.appendChild(s);
            }

            const ov = document.createElement('div');
            ov.className = 'dl9-overlay';
            const md = document.createElement('div');
            md.className = 'dl9-modal';
            md.style.background = '#1a2e1a';
            md.innerHTML = `
              <h2 style="color:#4ade80">📦 Archivador Masivo de PNs</h2>
              <div style="margin-bottom:16px">
                <label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">Fecha de corte:</label>
                <input type="date" id="sa-arch-date" style="width:100%;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px" value="${new Date().toISOString().slice(0, 10)}">
              </div>
              <div style="margin-bottom:16px;display:flex;gap:8px">
                <div style="flex:1">
                  <label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">Dirección:</label>
                  <select id="sa-arch-direction" style="width:100%;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
                    <option value="before" selected>Antes de la fecha</option>
                    <option value="after">Después de la fecha</option>
                  </select>
                </div>
                <div style="flex:1">
                  <label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">Tipo de fecha:</label>
                  <select id="sa-arch-type" style="width:100%;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
                    <option value="utilizacion" selected>Última utilización</option>
                    <option value="creacion">Fecha de creación</option>
                    <option value="modificacion">Fecha de modificación</option>
                  </select>
                </div>
              </div>
              <div style="margin-bottom:16px;display:flex;align-items:center;gap:8px">
                <input type="checkbox" id="sa-arch-validation" checked>
                <label for="sa-arch-validation" style="font-size:13px;color:#e2e8f0">Activar validación de ingeniería al primer recibo</label>
              </div>
              <p style="font-size:11px;color:#64748b;margin-bottom:8px">Se archivarán todos los PNs activos cuya fecha seleccionada sea anterior a la fecha de corte. Podrás revisar y deseleccionar antes de ejecutar.</p>
              <div class="dl9-btnrow">
                <button class="dl9-btn dl9-btn-cancel" id="sa-arch-form-cancel">CANCELAR</button>
                <button class="dl9-btn" id="sa-arch-form-exec" style="background:#4ade80;color:#0f172a">BUSCAR PNs</button>
              </div>`;
            ov.appendChild(md);
            document.body.appendChild(ov);

            document.getElementById('sa-arch-form-cancel').onclick = () => {
              ov.parentNode.removeChild(ov);
              resolve({ cancelled: true });
            };
            document.getElementById('sa-arch-form-exec').onclick = async () => {
              const cutoffDate = document.getElementById('sa-arch-date').value;
              const dateType = document.getElementById('sa-arch-type').value;
              const direction = document.getElementById('sa-arch-direction').value;
              const enableValidation = document.getElementById('sa-arch-validation').checked;
              ov.parentNode.removeChild(ov);

              try {
                const result = await window.PNArchiver.run({ cutoffDate, dateType, direction, enableValidation });
                resolve(result);
              } catch (e) {
                resolve({ error: e.message });
              }
            };
          });
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── File Uploader ──
    case 'upload-pn-files': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'file-uploader');

      // Show overlay with file picker button (user click required for file dialog)
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.FileUploader) return { error: 'FileUploader no disponible' };
          return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif';
            const box = document.createElement('div');
            box.style.cssText = 'background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:400px;width:90%;text-align:center';
            box.innerHTML = '<h2 style="font-size:18px;margin:0 0 12px;color:#38bdf8">📎 Cargador de Archivos</h2><p style="font-size:13px;color:#94a3b8;margin-bottom:16px">Selecciona archivos nombrados como el PN</p>';

            const inp = document.createElement('input');
            inp.type = 'file'; inp.multiple = true;
            inp.accept = '.pdf,.jpg,.jpeg,.png,.gif,.bmp,.tiff,.doc,.docx,.xls,.xlsx';
            inp.style.cssText = 'margin-bottom:16px;font-size:13px;color:#e2e8f0';
            inp.onchange = async () => {
              if (!inp.files?.length) return;
              ov.parentNode.removeChild(ov);
              try {
                const result = await window.FileUploader.run(inp.files);
                resolve(result);
              } catch (e) { resolve({ error: e.message }); }
            };
            box.appendChild(inp);

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'CANCELAR';
            cancelBtn.style.cssText = 'padding:8px 20px;border:none;border-radius:6px;background:#475569;color:#e2e8f0;font-size:13px;cursor:pointer';
            cancelBtn.onclick = () => { ov.parentNode.removeChild(ov); resolve({ cancelled: true }); };
            box.appendChild(cancelBtn);

            ov.appendChild(box);
            document.body.appendChild(ov);
          });
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Auditor ──
    case 'run-auditor': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'auditor');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.PNAuditor) return { error: 'PNAuditor no disponible' };
          const criteria = window.PNAuditor.getCriteria();

          return new Promise(resolve => {
            // Build criteria form
            if (!document.getElementById('dl9-styles')) {
              const s = document.createElement('style'); s.id = 'dl9-styles';
              s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:600px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 12px}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.dl9-btn-cancel{background:#475569;color:#e2e8f0}`;
              document.head.appendChild(s);
            }

            const ov = document.createElement('div');
            ov.className = 'dl9-overlay';
            const md = document.createElement('div');
            md.className = 'dl9-modal';
            md.style.background = '#1a1a2e';

            // Group criteria
            const groups = {};
            for (const c of criteria) {
              if (!groups[c.group]) groups[c.group] = [];
              groups[c.group].push(c);
            }

            let criteriaHTML = '';
            for (const [group, items] of Object.entries(groups)) {
              criteriaHTML += `<div style="margin-bottom:10px"><div style="font-size:12px;color:#38bdf8;font-weight:600;margin-bottom:4px">${group}</div>`;
              for (const c of items) {
                criteriaHTML += `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#e2e8f0;padding:2px 0;cursor:pointer"><input type="checkbox" class="sa-aud-crit" value="${c.id}">${c.label}</label>`;
              }
              criteriaHTML += '</div>';
            }

            md.innerHTML = `
              <h2 style="color:#38bdf8">🔎 Auditor de Números de Parte</h2>
              <div style="margin-bottom:12px;display:flex;gap:8px">
                <div style="flex:1">
                  <label style="font-size:11px;color:#94a3b8">Filtrar por cliente (opcional):</label>
                  <input type="text" id="sa-aud-customer" placeholder="Nombre del cliente..." style="width:100%;padding:6px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px">
                </div>
                <div style="flex:1">
                  <label style="font-size:11px;color:#94a3b8">Buscar PN (opcional):</label>
                  <input type="text" id="sa-aud-search" placeholder="Nombre o parte del PN..." style="width:100%;padding:6px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px">
                </div>
              </div>
              <p style="font-size:11px;color:#f97316;margin-bottom:8px">⚠️ Sin filtros puede tomar ~10 minutos. Se puede detener para resultados parciales.</p>
              <div style="display:flex;gap:8px;margin-bottom:8px">
                <button id="sa-aud-all" style="font-size:10px;padding:3px 8px;border:1px solid #475569;border-radius:4px;background:none;color:#94a3b8;cursor:pointer">Seleccionar todos</button>
                <button id="sa-aud-none" style="font-size:10px;padding:3px 8px;border:1px solid #475569;border-radius:4px;background:none;color:#94a3b8;cursor:pointer">Deseleccionar todos</button>
              </div>
              ${criteriaHTML}
              <div class="dl9-btnrow">
                <button class="dl9-btn dl9-btn-cancel" id="sa-aud-cancel">CANCELAR</button>
                <button class="dl9-btn" id="sa-aud-exec" style="background:#38bdf8;color:#0f172a">AUDITAR</button>
              </div>`;

            ov.appendChild(md);
            document.body.appendChild(ov);

            document.getElementById('sa-aud-all').onclick = () => md.querySelectorAll('.sa-aud-crit').forEach(c => c.checked = true);
            document.getElementById('sa-aud-none').onclick = () => md.querySelectorAll('.sa-aud-crit').forEach(c => c.checked = false);

            document.getElementById('sa-aud-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve({ cancelled: true }); };
            document.getElementById('sa-aud-exec').onclick = async () => {
              const selected = [...md.querySelectorAll('.sa-aud-crit:checked')].map(c => c.value);
              const customerFilter = document.getElementById('sa-aud-customer').value.trim();
              const searchQuery = document.getElementById('sa-aud-search').value.trim();
              ov.parentNode.removeChild(ov);

              if (!selected.length) { resolve({ error: 'Selecciona al menos un criterio' }); return; }

              try {
                const results = await window.PNAuditor.run({ selectedCriteria: selected, searchQuery, customerFilter });
                window.PNAuditor.removeAuditorUI();

                // Show summary
                let summary = 'Auditoría completada:\\n\\n';
                for (const [id, data] of Object.entries(results.criteria)) {
                  if (data.count > 0) summary += `${data.count} — ${data.label}\\n`;
                }
                summary += `\\nTotal auditados: ${results.totalAudited}\\nTotal problemas: ${results.totalIssues}`;
                summary += results.stopped ? '\\n\\n(Resultados parciales — auditoría detenida)' : '';
                summary += '\\n\\n¿Descargar CSV de corrección?';

                if (confirm(summary)) {
                  const exported = window.PNAuditor.exportCSV(results);
                  alert('CSV descargado con ' + exported + ' PNs únicos.');
                }
                resolve(results);
              } catch (e) {
                window.PNAuditor.removeAuditorUI();
                resolve({ error: e.message });
              }
            };
          });
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Report Liberator ──
    case 'run-report-liberator': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'report-liberator');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.ReportLiberator) return { error: 'ReportLiberator no disponible' };
          return window.ReportLiberator.run();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Spec Migrator ──
    case 'run-spec-migrator': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'spec-migrator');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.SpecMigrator) return { error: 'SpecMigrator no disponible' };
          return window.SpecMigrator.run();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Assign Pending Params ──
    case 'assign-pending-params': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'spec-migrator');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.SpecMigrator) return { error: 'SpecMigrator no disponible' };
          return window.SpecMigrator.assignPendingParams();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    // ── Inventory Reset ──
    case 'run-inventory-reset': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'inventory-reset');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.InventoryReset) return { error: 'InventoryReset no disponible' };
          return window.InventoryReset.run();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    default:
      throw new Error(`Acción desconocida: ${message.action}`);
  }
}

loadConfig();
