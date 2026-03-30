// Steelhead Automator — Service Worker (Background)
// Handles script injection via chrome.scripting API (bypasses page CSP)

const REMOTE_BASE_URL = 'https://oviazcan.github.io/SteelheadAutomator';
const CONFIG_URL = `${REMOTE_BASE_URL}/config.json`;

let cachedConfig = null;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[SteelheadAutomator] Extensión instalada');
  } else if (details.reason === 'update') {
    console.log('[SteelheadAutomator] Extensión actualizada a', chrome.runtime.getManifest().version);
  }
});

// Fetch remote config
async function loadConfig() {
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cachedConfig = await response.json();
    await chrome.storage.local.set({ config: cachedConfig });
    return cachedConfig;
  } catch (err) {
    console.warn('[SteelheadAutomator] Error cargando config:', err.message);
    const stored = await chrome.storage.local.get('config');
    cachedConfig = stored.config || null;
    return cachedConfig;
  }
}

// Fetch a remote script's code as text
async function fetchScriptCode(scriptPath) {
  const config = cachedConfig || await loadConfig();
  const url = `${REMOTE_BASE_URL}/${scriptPath}?v=${config?.version || '0'}`;
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status} cargando ${scriptPath}`);
  return await response.text();
}

// Inject scripts into the MAIN world of a tab (bypasses CSP)
async function injectScripts(tabId) {
  const config = cachedConfig || await loadConfig();
  if (!config) throw new Error('Config no disponible');

  for (const scriptPath of config.scripts) {
    const code = await fetchScriptCode(scriptPath);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (scriptCode) => {
        try { new Function(scriptCode)(); } catch (e) { console.error('[SA] Error ejecutando script:', e); }
      },
      args: [code]
    });
    console.log('[SteelheadAutomator] Script inyectado en MAIN world:', scriptPath);
  }

  // Initialize API with config in MAIN world
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (configJson) => {
      if (window.SteelheadAPI) {
        window.SteelheadAPI.init(JSON.parse(configJson));
        console.log('[SA] API inicializada con config');
      }
    },
    args: [JSON.stringify(config)]
  });
}

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[SteelheadAutomator] Error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.action) {
    case 'get-status': {
      const config = cachedConfig || await loadConfig();
      return {
        version: config?.version || 'sin conexión',
        lastUpdated: config?.lastUpdated || 'desconocido',
        connected: !!config
      };
    }

    case 'get-config':
      return cachedConfig || await loadConfig();

    case 'inject-scripts': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || !tab.url?.includes('app.gosteelhead.com')) throw new Error('Abre Steelhead primero');
      await injectScripts(tab.id);
      return { injected: true };
    }

    case 'pick-and-run': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || !tab.url?.includes('app.gosteelhead.com')) throw new Error('Abre Steelhead primero');

      // Inject scripts first
      await injectScripts(tab.id);

      // Then trigger the file picker and pipeline in the MAIN world
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          return new Promise(resolve => {
            if (!window.BulkUpload) { resolve({ error: 'BulkUpload no disponible después de inyección' }); return; }
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.csv';
            inp.onchange = () => {
              const f = inp.files[0];
              if (!f) { resolve({ cancelled: true }); return; }
              const r = new FileReader();
              r.onload = async () => {
                try {
                  const result = await window.BulkUpload.execute(r.result);
                  resolve(result);
                } catch (e) { resolve({ error: e.message }); }
              };
              r.readAsText(f, 'UTF-8');
            };
            inp.click();
          });
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }

    default:
      // Relay to content script
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        return new Promise((resolve) => {
          chrome.tabs.sendMessage(tabs[0].id, message, resolve);
        });
      }
      throw new Error('No hay pestaña activa');
  }
}

// Load config on startup
loadConfig();
