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

  try {
    api.storage.onChanged.addListener(function (changes) {
      FLAGS.forEach(function (f) { if (changes[f.key]) setAttr(f.attr, changes[f.key].newValue); });
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
