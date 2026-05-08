// Receiver Date Override
// Inyecta un campo "Fecha real de recibido:" en el modal de Receive Parts
// Intercepta UpdateReceiver para swappear receivedAt cuando el usuario toca el campo
// No depende de SteelheadAPI (solo intercept de fetch nativo)

const ReceiverDateOverride = (() => {
  'use strict';

  const LOG_PREFIX = '[RDO]';
  let observerActive = false;
  let modalObserver = null;

  // modal element → { input, warningEl, userTouched, removalObserver }
  const modalStates = new WeakMap();

  function init() {
    const disabled = document.documentElement.dataset.saReceiverDateOverrideEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── MutationObserver: detect Receive Parts modal ──

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

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
    if (modal.dataset.saRdoAttached === 'true') return;
    modal.dataset.saRdoAttached = 'true';
    modalStates.set(modal, {});  // initialize empty state before any downstream code runs
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
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
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  // ── Placeholder functions (implementadas en tareas siguientes) ──

  function patchFetch() {
    // [PLACEHOLDER — Task 5]
    // Implementation contract:
    //   - MUST guard against double-patching: `if (window.__saRdoFetchPatched) return; window.__saRdoFetchPatched = true;`
    //   - Intercepts UpdateReceiver mutation; swaps `receivedAt` if user touched date in any active modal.
    //   - Reads modalStates to find the active modal's pending date string.
  }
  function injectStyles() {
    if (document.getElementById('sa-rdo-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-rdo-styles';
    style.textContent = `
      .sa-rdo-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .sa-rdo-input {
        border: 1px solid #c4c4c4;
        border-radius: 4px;
        padding: 8.5px 14px;
        font: inherit;
        font-size: 14px;
        background: #fff;
        color: rgba(0,0,0,0.87);
      }
      .sa-rdo-input:focus {
        outline: 2px solid #1976d2;
        outline-offset: -1px;
        border-color: transparent;
      }
      .sa-rdo-chip {
        border: 1px solid rgba(25,118,210,0.5);
        color: #1976d2;
        background: transparent;
        border-radius: 16px;
        padding: 4px 12px;
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
      }
      .sa-rdo-chip:hover {
        background: rgba(25,118,210,0.08);
        border-color: #1976d2;
      }
      .sa-rdo-warning {
        flex-basis: 100%;
        margin-top: 4px;
        font-size: 12px;
        color: #ed6c02;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }
  function injectField(modal) {}

  return { init };
})();

if (typeof window !== 'undefined') {
  window.ReceiverDateOverride = ReceiverDateOverride;
  ReceiverDateOverride.init();
}
