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
  const config = cachedConfig || await loadConfig();
  const url = `${REMOTE_BASE_URL}/${scriptPath}?v=${config?.version || '0'}`;
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
    // Only inject if not already loaded (prevents resetting state like HashScanner results)
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (c, path) => {
        // Check if script already loaded by looking for its global
        const globals = { 'scripts/steelhead-api.js': 'SteelheadAPI', 'scripts/bulk-upload.js': 'BulkUpload',
          'scripts/catalog-fetcher.js': 'CatalogFetcher', 'scripts/hash-scanner.js': 'HashScanner',
          'scripts/api-knowledge.js': 'APIKnowledge' };
        const globalName = globals[path];
        if (globalName && window[globalName]) return; // already loaded
        try { new Function(c)(); } catch (e) { console.error('[SA]', e); }
      },
      args: [code, scriptPath]
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
      // Download a specific load's data as CSV for correction
      const tab = await getSteelheadTab();
      const loadId = message.loadId;
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (id) => {
          const history = JSON.parse(localStorage.getItem('sa_load_history') || '[]');
          const load = history.find(h => h.id === id);
          if (!load) return { error: 'Carga no encontrada' };

          // Generate CSV from load data
          const parts = load.parts || [];
          if (!parts.length) return { error: 'Sin datos de PNs' };

          // Build CSV header
          const headers = ['Número de parte', 'Cantidad', 'Precio', 'Unidad', 'Descripción', 'Metal Base', 'Etiqueta 1', 'Etiqueta 2', 'Etiqueta 3', 'Etiqueta 4', 'Proceso', 'Grupo', 'Archivado', 'Validación', 'Forzar Dup', 'Precio Default'];
          const rows = [headers.join(',')];
          for (const p of parts) {
            rows.push([
              p.pn, p.qty || '', p.precio || '', p.unidadPrecio || '', p.descripcion || '',
              p.metalBase || '', ...(p.labels || []).concat(['', '', '', '']).slice(0, 4),
              p.procesoOverride || '', p.pnGroup || '',
              p.archivado ? 'SI' : 'NO', p.validacion1er ? 'SI' : 'NO',
              p.forzarDuplicado ? 'SI' : 'NO', p.precioDefault ? 'SI' : 'NO'
            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
          }

          const csv = rows.join('\n');
          const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `correccion_${load.mode}_${new Date(load.timestamp).toISOString().slice(0, 10)}_${load.id}.csv`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
          return { started: true, message: 'CSV descargado' };
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
              <div style="margin-bottom:16px">
                <label style="font-size:13px;color:#94a3b8;display:block;margin-bottom:4px">Tipo de fecha:</label>
                <select id="sa-arch-type" style="width:100%;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
                  <option value="utilizacion" selected>Última utilización (sin OT, recibos, facturas)</option>
                  <option value="creacion">Fecha de creación</option>
                  <option value="modificacion">Fecha de modificación</option>
                </select>
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
              const enableValidation = document.getElementById('sa-arch-validation').checked;
              ov.parentNode.removeChild(ov);

              try {
                const result = await window.PNArchiver.run({ cutoffDate, dateType, enableValidation });
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

    default:
      throw new Error(`Acción desconocida: ${message.action}`);
  }
}

loadConfig();
