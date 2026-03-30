// Steelhead Automator — Content Script
// Activates on app.gosteelhead.com, loads remote config and scripts

(function () {
  'use strict';

  const REMOTE_BASE_URL = 'https://oviazcan.github.io/SteelheadAutomator';
  const CONFIG_URL = `${REMOTE_BASE_URL}/config.json`;

  let currentConfig = null;
  let loadedScripts = {};

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
        loadedScripts = {}; // invalidate script cache
      }

      return currentConfig;
    } catch (err) {
      console.warn('[SteelheadAutomator] Error cargando config remoto, usando cache:', err.message);
      const cached = await chrome.storage.local.get('config');
      currentConfig = cached.config || null;
      return currentConfig;
    }
  }

  // Download and cache a remote script
  async function loadScript(scriptPath) {
    if (loadedScripts[scriptPath]) return loadedScripts[scriptPath];

    try {
      const url = `${REMOTE_BASE_URL}/${scriptPath}`;
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const code = await response.text();

      loadedScripts[scriptPath] = code;
      await chrome.storage.local.set({ [`script_${scriptPath}`]: code });

      console.log('[SteelheadAutomator] Script cargado:', scriptPath);
      return code;
    } catch (err) {
      console.warn('[SteelheadAutomator] Error cargando script, usando cache:', err.message);
      const cached = await chrome.storage.local.get(`script_${scriptPath}`);
      loadedScripts[scriptPath] = cached[`script_${scriptPath}`] || null;
      return loadedScripts[scriptPath];
    }
  }

  // Execute a cached script in page context
  function executeScript(code) {
    const script = document.createElement('script');
    script.textContent = code;
    document.documentElement.appendChild(script);
    script.remove();
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // async response
  });

  async function handleMessage(message) {
    switch (message.action) {
      case 'get-status':
        return {
          version: currentConfig?.version || 'sin conexión',
          lastUpdated: currentConfig?.lastUpdated || 'desconocido',
          connected: !!currentConfig,
          url: window.location.href
        };

      case 'load-scripts':
        if (!currentConfig) throw new Error('Config no disponible');
        for (const scriptPath of currentConfig.scripts) {
          await loadScript(scriptPath);
        }
        return { loaded: Object.keys(loadedScripts).length };

      case 'run-bulk-upload':
        if (!currentConfig) throw new Error('Config no disponible');
        const bulkCode = await loadScript('scripts/bulk-upload.js');
        if (!bulkCode) throw new Error('Script bulk-upload no disponible');
        // The bulk upload script will be executed with the CSV data
        // For now, return confirmation
        return { status: 'ready', message: 'Bulk upload script cargado' };

      case 'get-config':
        return currentConfig;

      default:
        throw new Error(`Acción desconocida: ${message.action}`);
    }
  }

  // Auto-load config on page load
  loadConfig();
})();
