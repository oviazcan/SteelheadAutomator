// Warehouse Location Prefill
// Inyecta un combobox "Ubicación inicial:" en el header del modal Receive Parts
// y, al elegir una ubicación, intercepta CreateReceiverChecked para sobrescribir
// el locationId en todos los receiverBomItems[].inventoryTransferEvent.
// debitAccounts.accounts[]. Deshabilita visualmente los combos per-line via
// overlay CSS mientras hay valor en el header.

const WarehouseLocationPrefill = (() => {
  'use strict';

  const LOG_PREFIX = '[WLP]';
  const api = () => window.SteelheadAPI;
  let observerActive = false;

  const modalStates = new WeakMap();

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

  function init() {
    const disabled = document.documentElement.dataset.saWarehouseLocationPrefillEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    let scanTimeout = null;
    const observer = new MutationObserver(() => {
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(scanForReceiveView, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForReceiveView();
  }

  function scanForReceiveView() {
    const candidates = document.querySelectorAll(HEADING_SELECTOR);
    for (const el of candidates) {
      if (!VIEW_REGEX.test(el.textContent?.trim())) continue;
      const container = el.closest('[role="dialog"]')
        || el.closest('.MuiDialog-paper')
        || el.closest('[class*="MuiPaper"]')
        || el.closest('main')
        || el.closest('form')
        || el.parentElement?.parentElement;
      if (container) {
        onModalFound(container);
        return;
      }
    }
  }

  function onModalFound(modal) {
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      fullCache: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    watchModalRemoval(modal);
  }

  function watchModalRemoval(modal) {
    const removalObserver = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        removalObserver.disconnect();
        cleanupModal(modal);
      }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const state = modalStates.get(modal);
    if (state) state.removalObserver = removalObserver;
  }

  function cleanupModal(modal) {
    const state = modalStates.get(modal);
    if (state?.removalObserver) state.removalObserver.disconnect();
    if (state?.rowObserver) state.rowObserver.disconnect();
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WarehouseLocationPrefill = WarehouseLocationPrefill;
  WarehouseLocationPrefill.init();
}
