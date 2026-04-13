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

  // Auto-restart hash scanner if it was active before page reload
  chrome.storage.local.get(['sa_scanning'], (data) => {
    if (!data.sa_scanning) return;
    console.log('[SteelheadAutomator] Scanner was active — auto-restarting after page load');
    // Wait for page to settle, then ask background to re-inject and start scanner
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'auto-restart-scan' });
    }, 1500);
  });

  // Listen for periodic scan persistence requests from MAIN world
  document.addEventListener('sa-persist-scan', () => {
    chrome.runtime.sendMessage({ action: 'persist-scan-results' });
  });
})();
