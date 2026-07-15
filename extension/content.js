// Steelhead Automator — Content Script
// Confirms extension is active + communicates feature flags to MAIN world
// Heavy lifting moved to background.js (chrome.scripting.executeScript)

(function () {
  'use strict';
  console.log('[SteelheadAutomator] Content script activado en', window.location.href);

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
})();
