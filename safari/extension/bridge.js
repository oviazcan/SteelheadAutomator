// bridge.js — content script del mundo AISLADO (default). Replica el rol del background.js +
// content.js de Chrome. Dos trabajos:
//
//  1) CONFIG EN CALIENTE: fetchea config.json de GitHub Pages y lo pasa al bundle (MAIN world)
//     por postMessage → los hashes de persisted queries (que ROTAN) se actualizan con `git push`
//     a gh-pages SIN recompilar la app. config.json son DATOS, no código → permitido por Apple
//     Guideline 2.5.2. El mundo aislado no está sujeto a la CSP de app.gosteelhead.com.
//
//  2) FLAGS DE TOGGLE: lee browser.storage.local (lo escribe el popup) y propaga el estado al
//     MAIN world como data-attribute en <html> (document.documentElement.dataset.*), que es lo
//     que ya leen los applets. Mismos storage keys / atributos que content.js de Chrome.
(function () {
  'use strict';
  var api = (typeof browser !== 'undefined') ? browser : chrome;
  var CONFIG_URL = 'https://oviazcan.github.io/SteelheadAutomator/config.json';

  // storageKey ↔ data-attribute (camelCase de dataset). Default de TODOS: ON (enabled = !== false).
  var FLAGS = [
    { key: 'cfdiAttacherEnabled',             attr: 'saCfdiEnabled' },
    { key: 'weightQuickEntryEnabled',         attr: 'saWeightQuickEntryEnabled' },
    { key: 'receiverDateOverrideEnabled',     attr: 'saReceiverDateOverrideEnabled' },
    { key: 'warehouseLocationPrefillEnabled', attr: 'saWarehouseLocationPrefillEnabled' },
    { key: 'invoiceAutoRegenEnabled',         attr: 'saAutoRegenEnabled' },
    { key: 'invoiceDefaultTabEnabled',        attr: 'saInvoiceDefaultTabEnabled' }
  ];

  function setAttr(attr, val) {
    try { document.documentElement.dataset[attr] = (val !== false); } catch (e) {}
  }
  function getAll(keys) {
    try { var p = api.storage.local.get(keys); if (p && p.then) return p; } catch (e) {}
    return new Promise(function (res) { api.storage.local.get(keys, res); });
  }

  // (1) Flags → data-attributes (lo antes posible, en document_start).
  getAll(FLAGS.map(function (f) { return f.key; })).then(function (states) {
    FLAGS.forEach(function (f) { setAttr(f.attr, states[f.key]); });
  }).catch(function () {});

  try {
    api.storage.onChanged.addListener(function (changes) {
      FLAGS.forEach(function (f) {
        if (changes[f.key]) setAttr(f.attr, changes[f.key].newValue);
      });
    });
  } catch (e) {}

  // (2) Config en caliente → MAIN world.
  fetch(CONFIG_URL, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) { console.error('[SA] bridge: config.json vacío/no-OK'); return; }
      try { window.postMessage({ __saBridge: true, type: 'config', config: cfg }, location.origin); }
      catch (e) { console.error('[SA] bridge: postMessage falló', e); }
    })
    .catch(function (e) { console.error('[SA] bridge: no se pudo cargar config.json', e); });
})();
