// Steelhead Automator — Content Script
// Confirms extension is active + communicates feature flags to MAIN world
// Heavy lifting moved to background.js (chrome.scripting.executeScript)

(function () {
  'use strict';
  // Ruido por-carga gateado (audit pre-producción #5). Activar: localStorage.sa_debug='1'.
  try { if (localStorage.getItem('sa_debug') === '1') console.log('[SteelheadAutomator] Content script activado en', window.location.href); } catch (_) {}

  // Communicate CFDI Attacher enabled state to MAIN world via data attribute
  chrome.storage.local.get('cfdiAttacherEnabled', (data) => {
    const enabled = data.cfdiAttacherEnabled !== false; // default: true
    document.documentElement.dataset.saCfdiEnabled = enabled;
  });

  // Communicate Weight Quick Entry enabled state to MAIN world
  chrome.storage.local.get('weightQuickEntryEnabled', (data) => {
    const enabled = data.weightQuickEntryEnabled !== false;
    document.documentElement.dataset.saWeightQuickEntryEnabled = enabled;
  });

  // Communicate Receiver Date Override enabled state to MAIN world
  chrome.storage.local.get('receiverDateOverrideEnabled', (data) => {
    const enabled = data.receiverDateOverrideEnabled !== false;
    document.documentElement.dataset.saReceiverDateOverrideEnabled = enabled;
  });

  // Communicate Warehouse Location Prefill enabled state to MAIN world
  chrome.storage.local.get('warehouseLocationPrefillEnabled', (data) => {
    const enabled = data.warehouseLocationPrefillEnabled !== false;
    document.documentElement.dataset.saWarehouseLocationPrefillEnabled = enabled;
  });

  // Communicate Planos en Remisión enabled state to MAIN world
  chrome.storage.local.get('packingSlipDrawingsEnabled', (data) => {
    const enabled = data.packingSlipDrawingsEnabled !== false;
    document.documentElement.dataset.saPsDrawingsEnabled = enabled;
  });

  // Listen for storage changes to update in real-time (e.g., when toggled from popup)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.cfdiAttacherEnabled) {
      const enabled = changes.cfdiAttacherEnabled.newValue !== false;
      document.documentElement.dataset.saCfdiEnabled = enabled;
    }
    if (changes.weightQuickEntryEnabled) {
      const enabled = changes.weightQuickEntryEnabled.newValue !== false;
      document.documentElement.dataset.saWeightQuickEntryEnabled = enabled;
    }
    if (changes.receiverDateOverrideEnabled) {
      const enabled = changes.receiverDateOverrideEnabled.newValue !== false;
      document.documentElement.dataset.saReceiverDateOverrideEnabled = enabled;
    }
    if (changes.packingSlipDrawingsEnabled) {
      const enabled = changes.packingSlipDrawingsEnabled.newValue !== false;
      document.documentElement.dataset.saPsDrawingsEnabled = enabled;
    }
    if (changes.warehouseLocationPrefillEnabled) {
      const enabled = changes.warehouseLocationPrefillEnabled.newValue !== false;
      document.documentElement.dataset.saWarehouseLocationPrefillEnabled = enabled;
    }
  });

  // NOTA (fix 2026-07-06): el auto-restart del hash-scanner tras un reload lo maneja
  // EXCLUSIVAMENTE background.js (chrome.tabs.onUpdated, status 'complete'). Antes había
  // TAMBIÉN un auto-restart aquí (page-load → setTimeout → 'auto-restart-scan'), y los dos
  // corrían concurrentes: re-inyectaban el scanner 2 veces y, como el script reseteaba su
  // `discovered` en cada re-inyección, en ciertas secuencias el mergeResults de lo capturado
  // antes del reload no se aplicaba → se perdía. Un solo mecanismo = sin race.

  // Listen for periodic scan persistence requests from MAIN world
  document.addEventListener('sa-persist-scan', () => {
    chrome.runtime.sendMessage({ action: 'persist-scan-results' });
  });

  // ── Aviso de navegación SPA al background ─────────────────────────────────
  //
  // Steelhead cambia de pantalla con history.pushState, sin recargar. El background
  // necesita enterarse para inyectar los applets de la pantalla nueva.
  //
  // Por qué se detecta AQUÍ y no en background.js: `chrome.tabs.onUpdated` no entrega
  // el pushState de forma confiable, y confiar en él costó una regresión en piso el
  // 2026-07-27 (Work Orders sin sus toggles; Bills quedándose con el invoice-autofill
  // de la pantalla anterior porque bill-autofill nunca llegaba).
  //
  // Y por qué por SONDEO y no parcheando history.pushState: el content script vive en
  // un mundo AISLADO. Comparte el DOM con la página, pero no su objeto `history`, así
  // que un patch de pushState aquí NO vería las llamadas del front. `location`, en
  // cambio, sí refleja la URL real. Comparar un string cada 400ms es despreciable y
  // funciona pase lo que pase del lado del front.
  let lastPath = location.pathname;
  let navCount = 0;

  function notifyNav(reason) {
    if (location.pathname === lastPath) return;   // el query cambia solo; el gate no lo mira
    lastPath = location.pathname;
    navCount++;
    // Testigo observable para validar en piso que la detección vive (sube al navegar).
    try { document.documentElement.dataset.saSpaNav = String(navCount); } catch (_) {}
    try {
      chrome.runtime.sendMessage({ action: 'spa-nav', url: location.href, reason });
    } catch (_) { /* contexto invalidado (extensión recargada) — la próxima recarga reengancha */ }
  }

  window.addEventListener('popstate', () => notifyNav('popstate'));
  setInterval(() => notifyNav('poll'), 400);
})();
