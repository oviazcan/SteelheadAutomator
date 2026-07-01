// bridge.js — content script del mundo AISLADO. Corre en document_start. Replica background.js +
// content.js de Chrome. Dos trabajos:
//
//  1) FLAGS DE TOGGLE: lee browser.storage.local (lo escribe el popup) y los propaga al MAIN world
//     como data-attribute en <html> (dataset.*), que es lo que leen los applets EN SU init(). Por eso
//     va en document_start: setea los atributos ANTES de que el bundle (document_idle) los lea. Mismos
//     storage keys / atributos que content.js de Chrome.
//
//  2) CONFIG EN CALIENTE: fetchea config.json de GitHub Pages (DATOS, no código → permitido por Apple
//     2.5.2; el mundo aislado no está sujeto a la CSP de la página) y lo entrega al MAIN por postMessage.
//     Handshake: el bundle pide el config al arrancar (por si ya lo fetcheamos antes de que escuche);
//     también lo enviamos apenas llega. Así los hashes rotan en caliente con `git push` sin recompilar.
//
//  3) COMANDOS DEL POPUP: el popup LANZA un applet con interfaz (archivador, sensor-status, configurar
//     estaciones, vale de almacén, auto-ruteador). Aquí lo recibimos y lo reenviamos al MAIN por
//     postMessage {type:'command', action, nonce}; sa-dispatcher.js (MAIN world) resuelve la acción →
//     función global del applet. DOS vías (el dispatcher deduplica por nonce):
//       (3a) PRIMARIA — tabs.sendMessage(tabId,{__saCmd,action,nonce}) → runtime.onMessage. Fiable en Safari/iPad.
//       (3b) FALLBACK — storage.local.set({saCommand}) → storage.onChanged. En iPadOS esta NO dispara en el
//            content script (por eso los toggles surten solo al recargar), así que sola no basta; queda de red.
(function () {
  'use strict';
  var api = (typeof browser !== 'undefined') ? browser : chrome;
  var CONFIG_URL = 'https://oviazcan.github.io/SteelheadAutomator/config.json';

  var FLAGS = [
    { key: 'cfdiAttacherEnabled',             attr: 'saCfdiEnabled' },
    { key: 'weightQuickEntryEnabled',         attr: 'saWeightQuickEntryEnabled' },
    { key: 'receiverDateOverrideEnabled',     attr: 'saReceiverDateOverrideEnabled' },
    { key: 'warehouseLocationPrefillEnabled', attr: 'saWarehouseLocationPrefillEnabled' },
    { key: 'invoiceAutoRegenEnabled',         attr: 'saAutoRegenEnabled' },
    { key: 'invoiceDefaultTabEnabled',        attr: 'saInvoiceDefaultTabEnabled' }
  ];

  var savedConfig = null;

  function setAttr(attr, val) {
    try { document.documentElement.dataset[attr] = (val !== false); } catch (e) {}
  }
  function getAll(keys) {
    try { var p = api.storage.local.get(keys); if (p && p.then) return p; } catch (e) {}
    return new Promise(function (res) { api.storage.local.get(keys, res); });
  }
  function sendConfig() {
    if (!savedConfig) return;
    try { window.postMessage({ __saBridge: true, type: 'config', config: savedConfig }, location.origin); }
    catch (e) {}
  }

  // (1) Flags → data-attributes, lo antes posible (document_start; <html> ya existe).
  getAll(FLAGS.map(function (f) { return f.key; })).then(function (states) {
    FLAGS.forEach(function (f) { setAttr(f.attr, states[f.key]); });
  }).catch(function () {});

  function relayCommand(cmd) {
    if (!cmd || !cmd.action) return;
    console.log('[SA] bridge: relay comando →', cmd.action);
    try { window.postMessage({ __saBridge: true, type: 'command', action: cmd.action, nonce: cmd.nonce }, location.origin); }
    catch (e) {}
  }

  // (3a) Canal PRIMARIO del popup: tabs.sendMessage → runtime.onMessage (fiable en Safari/iPad;
  // storage.onChanged NO dispara en el content script en iPadOS, por eso no basta la vía 3b).
  try {
    api.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.__saCmd) { console.log('[SA] bridge: runtime cmd', msg.action); relayCommand({ action: msg.action, nonce: msg.nonce }); }
    });
  } catch (e) {}

  try {
    api.storage.onChanged.addListener(function (changes) {
      FLAGS.forEach(function (f) { if (changes[f.key]) setAttr(f.attr, changes[f.key].newValue); });
      // (3b) Fallback: comando del popup vía storage (por si tabs.sendMessage falla en algún iPadOS).
      if (changes.saCommand) { console.log('[SA] bridge: storage cmd', changes.saCommand.newValue && changes.saCommand.newValue.action); relayCommand(changes.saCommand.newValue); }
    });
  } catch (e) {}

  // (2) Handshake + config en caliente.
  window.addEventListener('message', function (e) {
    if (e.source === window && e.data && e.data.__saBridgeReq) sendConfig();
  });
  fetch(CONFIG_URL, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) { console.error('[SA] bridge: config.json vacío/no-OK'); return; }
      savedConfig = cfg; sendConfig();
    })
    .catch(function (e) { console.error('[SA] bridge: no se pudo cargar config.json', e); });
})();
