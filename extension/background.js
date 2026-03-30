// Steelhead Automator — Service Worker (Background)
// Handles extension lifecycle events

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[SteelheadAutomator] Extensión instalada');
  } else if (details.reason === 'update') {
    console.log('[SteelheadAutomator] Extensión actualizada a', chrome.runtime.getManifest().version);
  }
});

// Relay messages between popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'content') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url?.includes('app.gosteelhead.com')) {
        chrome.tabs.sendMessage(tabs[0].id, message, sendResponse);
      } else {
        sendResponse({ error: 'No hay pestaña activa de Steelhead' });
      }
    });
    return true; // async response
  }
});
