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

  // Listen for storage changes to update in real-time (e.g., when toggled from popup)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.cfdiAttacherEnabled) {
      const enabled = changes.cfdiAttacherEnabled.newValue !== false;
      document.documentElement.dataset.saCfdiEnabled = enabled;
    }
  });
})();
