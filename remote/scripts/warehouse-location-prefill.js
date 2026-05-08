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

  // modal element → { selectedLocation, aduanaCache, fullCache, ... }
  const modalStates = new WeakMap();

  function init() {
    const disabled = document.documentElement.dataset.saWarehouseLocationPrefillEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    console.log(LOG_PREFIX, 'Inicializado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WarehouseLocationPrefill = WarehouseLocationPrefill;
  WarehouseLocationPrefill.init();
}
