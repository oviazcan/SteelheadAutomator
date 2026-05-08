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
    injectStyles();
    injectField(modal);
    watchModalRemoval(modal);
    preloadAduana(modal);
  }

  async function preloadAduana(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    try {
      const nodes = await fetchAduanaLocations();
      state.aduanaCache = nodes;
      console.log(LOG_PREFIX, `Aduana precargada: ${nodes.length} ubicaciones`);
    } catch {
      state.aduanaCache = [];
    }
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

  async function fetchAduanaLocations() {
    if (!api()) {
      console.warn(LOG_PREFIX, 'SteelheadAPI no disponible');
      return [];
    }
    try {
      const data = await api().query('SearchLocationsOnPath', {
        fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
        path: '', searchText: '%Aduana%', offset: 0, first: 100,
        subpathOffset: 0, searchTextLast: '%Aduana%',
        archivedIsNull: true, isEmpty: false, includeTypes: true
      }, 'SearchLocationsOnPath');
      return data?.searchLocationsOnPath?.nodes || [];
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error cargando ubicaciones Aduana:', err);
      throw err;
    }
  }

  async function fetchAllLocations(offset = 0, first = 200) {
    if (!api()) {
      console.warn(LOG_PREFIX, 'SteelheadAPI no disponible');
      return [];
    }
    try {
      const data = await api().query('SearchLocationsOnPath', {
        fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
        path: '', searchText: '', offset, first,
        subpathOffset: 0, searchTextLast: '',
        archivedIsNull: true, isEmpty: false, includeTypes: true
      }, 'SearchLocationsOnPath');
      return data?.searchLocationsOnPath?.nodes || [];
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error cargando catálogo completo de ubicaciones:', err);
      throw err;
    }
  }

  function injectStyles() {
    if (document.getElementById('sa-wlp-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-wlp-styles';
    style.textContent = `
      .sa-wlp-wrapper { margin-top: 12px; }
      .sa-wlp-controls {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .sa-wlp-combo {
        position: relative; min-width: 320px;
        border: 1px solid #c4c4c4; border-radius: 4px; background: #fff;
      }
      .sa-wlp-combo-input {
        width: 100%; border: 0; outline: 0; background: transparent;
        padding: 8.5px 32px 8.5px 14px; font: inherit; font-size: 14px;
        color: rgba(0,0,0,0.87);
      }
      .sa-wlp-combo:focus-within {
        outline: 2px solid #1976d2; outline-offset: -1px; border-color: transparent;
      }
      .sa-wlp-combo-clear {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        cursor: pointer; color: #888; font-size: 16px; line-height: 1;
        background: transparent; border: 0; padding: 2px 6px;
      }
      .sa-wlp-combo-clear:hover { color: #1976d2; }
      .sa-wlp-dropdown {
        position: absolute; top: 100%; left: 0; right: 0; z-index: 1500;
        background: #fff; border: 1px solid #c4c4c4; border-radius: 4px;
        max-height: 280px; overflow-y: auto; margin-top: 2px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
      }
      .sa-wlp-dropdown[hidden] { display: none; }
      .sa-wlp-option {
        padding: 8px 14px; cursor: pointer; font-size: 14px;
      }
      .sa-wlp-option:hover, .sa-wlp-option[data-active="true"] {
        background: rgba(25,118,210,0.08);
      }
      .sa-wlp-option-empty {
        padding: 8px 14px; font-size: 13px; color: #888; font-style: italic;
      }
      .sa-wlp-option-sentinel {
        padding: 8px 14px; font-size: 13px; color: #1976d2; font-style: italic;
        cursor: pointer; border-top: 1px solid #eee;
      }
      .sa-wlp-option-sentinel:hover { background: rgba(25,118,210,0.08); }
      .sa-wlp-row-overlay {
        position: absolute; inset: 0; display: flex; align-items: center;
        padding: 0 14px; background: rgba(245,245,245,0.85);
        font-size: 13px; color: rgba(0,0,0,0.65); font-style: italic;
        pointer-events: auto;
      }
    `;
    document.head.appendChild(style);
  }

  function injectField(modal) {
    if (modal.querySelector('[data-sa-wlp-field="true"]')) return;

    // Anclar al wrapper de "Receiver Comments" (el row container .css-xd9ivb del header)
    const labels = modal.querySelectorAll('p');
    let anchorWrapper = null;
    for (const p of labels) {
      if (/^(?:receiver\s+comments|comentarios\s+del\s+receptor):?$/i.test(p.textContent.trim())) {
        anchorWrapper = p.closest('.css-iyrxkt');
        break;
      }
    }
    if (!anchorWrapper) {
      console.warn(LOG_PREFIX, 'No se localizó el wrapper de Receiver Comments — layout cambió?');
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'css-iyrxkt sa-wlp-wrapper';
    wrapper.dataset.saWlpField = 'true';

    const label = document.createElement('p');
    label.className = 'MuiTypography-root MuiTypography-body1 css-9l3uo3';
    label.style.gridColumn = '1';
    label.textContent = 'Ubicación inicial:';
    wrapper.appendChild(label);

    const controls = document.createElement('div');
    controls.style.gridColumn = '2';
    controls.className = 'sa-wlp-controls';

    const combo = document.createElement('div');
    combo.className = 'sa-wlp-combo';
    combo.dataset.saWlpCombo = 'true';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sa-wlp-combo-input';
    input.placeholder = 'Buscar ubicación (filtro: Aduana)';
    input.autocomplete = 'off';
    combo.appendChild(input);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sa-wlp-combo-clear';
    clearBtn.textContent = '✕';
    clearBtn.hidden = true;
    clearBtn.title = 'Limpiar selección';
    combo.appendChild(clearBtn);

    const dropdown = document.createElement('div');
    dropdown.className = 'sa-wlp-dropdown';
    dropdown.hidden = true;
    combo.appendChild(dropdown);

    controls.appendChild(combo);
    wrapper.appendChild(controls);

    // Insertar como sibling del row container (.css-xd9ivb) — debajo del date applet si existe
    const rowContainer = anchorWrapper.parentElement;
    if (rowContainer) {
      // Si el date applet ya inyectó su sibling, insertar después de él
      const dateField = rowContainer.parentElement?.querySelector('[data-sa-rdo-field="true"]');
      if (dateField) {
        dateField.insertAdjacentElement('afterend', wrapper);
      } else {
        rowContainer.insertAdjacentElement('afterend', wrapper);
      }
    } else {
      anchorWrapper.insertAdjacentElement('afterend', wrapper);
    }

    // Stash refs en el state
    const state = modalStates.get(modal) || {};
    state.combo = combo;
    state.input = input;
    state.clearBtn = clearBtn;
    state.dropdown = dropdown;
    modalStates.set(modal, state);

    console.log(LOG_PREFIX, 'Combobox de ubicación inyectado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WarehouseLocationPrefill = WarehouseLocationPrefill;
  WarehouseLocationPrefill.init();
}
