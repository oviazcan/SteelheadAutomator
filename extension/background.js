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
            return { started: false, message: 'Captura detenida.', stats: window.HashScanner.getStats() };
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
          // Download as file
          const blob = new Blob([JSON.stringify(updated, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'config_updated_' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
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

    default:
      throw new Error(`Acción desconocida: ${message.action}`);
  }
}

loadConfig();
