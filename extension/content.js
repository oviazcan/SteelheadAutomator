// Steelhead Automator — Content Script
// Minimal: just confirms the extension is active on this page
// Heavy lifting moved to background.js (chrome.scripting.executeScript)

(function () {
  'use strict';
  console.log('[SteelheadAutomator] Content script activado en', window.location.href);
})();
