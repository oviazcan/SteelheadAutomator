// Steelhead Automator — Content Script
// Activates on app.gosteelhead.com, loads remote config and scripts

(function () {
  'use strict';

  const REMOTE_BASE_URL = 'https://oviazcan.github.io/SteelheadAutomator';
  const CONFIG_URL = `${REMOTE_BASE_URL}/config.json`;

  let currentConfig = null;
  let scriptsLoaded = false;

  console.log('[SteelheadAutomator] Content script activado en', window.location.href);

  // Fetch remote config and compare with cached version
  async function loadConfig() {
    try {
      const response = await fetch(CONFIG_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remoteConfig = await response.json();

      const cached = await chrome.storage.local.get('config');
      if (cached.config && cached.config.version === remoteConfig.version) {
        console.log('[SteelheadAutomator] Config al día, versión:', remoteConfig.version);
        currentConfig = cached.config;
      } else {
        console.log('[SteelheadAutomator] Nueva versión detectada:', remoteConfig.version);
        currentConfig = remoteConfig;
        await chrome.storage.local.set({ config: remoteConfig });
        scriptsLoaded = false;
      }

      return currentConfig;
    } catch (err) {
      console.warn('[SteelheadAutomator] Error cargando config remoto, usando cache:', err.message);
      const cached = await chrome.storage.local.get('config');
      currentConfig = cached.config || null;
      return currentConfig;
    }
  }

  // Load and inject a remote script into the page context
  async function loadAndInjectScript(scriptPath) {
    const url = `${REMOTE_BASE_URL}/${scriptPath}?v=${currentConfig?.version || '0'}`;
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status} cargando ${scriptPath}`);
    const code = await response.text();
    const script = document.createElement('script');
    script.textContent = code;
    document.documentElement.appendChild(script);
    script.remove();
    console.log('[SteelheadAutomator] Script inyectado:', scriptPath);
  }

  // Load all remote scripts into page context
  async function ensureScriptsLoaded() {
    if (scriptsLoaded && window.SteelheadAPI && window.BulkUpload) return;
    if (!currentConfig) throw new Error('Config no disponible');

    for (const scriptPath of currentConfig.scripts) {
      await loadAndInjectScript(scriptPath);
    }

    // Initialize API with config
    if (window.SteelheadAPI) {
      window.SteelheadAPI.init(currentConfig);
      console.log('[SteelheadAutomator] API inicializada con config v' + currentConfig.version);
    }

    scriptsLoaded = true;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  });

  async function handleMessage(message) {
    switch (message.action) {
      case 'get-status':
        return {
          version: currentConfig?.version || 'sin conexión',
          lastUpdated: currentConfig?.lastUpdated || 'desconocido',
          connected: !!currentConfig,
          scriptsReady: scriptsLoaded,
          url: window.location.href
        };

      case 'get-config':
        return currentConfig;

      case 'run-bulk-upload': {
        await ensureScriptsLoaded();
        if (!window.BulkUpload) throw new Error('BulkUpload no disponible');

        // Decode CSV from base64 if needed
        let csvText = message.csvText;
        if (!csvText && message.fileData) {
          // fileData is base64 encoded
          const binary = atob(message.fileData);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

          if (message.fileType === 'csv') {
            csvText = new TextDecoder('utf-8').decode(bytes);
          } else {
            // XLSX — need SheetJS to convert to CSV
            // For now, only CSV is supported directly
            throw new Error('Formato XLSX no soportado aún. Exporta como CSV desde Excel.');
          }
        }

        if (!csvText) throw new Error('No se recibieron datos del archivo.');

        // Execute the pipeline — this runs in page context via injected scripts
        const result = await window.BulkUpload.execute(csvText);
        return result;
      }

      case 'pick-and-run': {
        // Let the user pick a CSV file directly from the page context
        await ensureScriptsLoaded();
        if (!window.BulkUpload) throw new Error('BulkUpload no disponible');

        const csvText = await new Promise(resolve => {
          const inp = document.createElement('input');
          inp.type = 'file'; inp.accept = '.csv';
          inp.onchange = () => {
            const f = inp.files[0];
            if (!f) { resolve(null); return; }
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.readAsText(f, 'UTF-8');
          };
          inp.click();
        });

        if (!csvText) return { cancelled: true };
        const result = await window.BulkUpload.execute(csvText);
        return result;
      }

      default:
        throw new Error(`Acción desconocida: ${message.action}`);
    }
  }

  // Auto-load config on page load
  loadConfig();
})();
