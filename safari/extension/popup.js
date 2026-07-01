// popup.js — popup de la Safari Web Extension (iPad). Muestra interruptores para los applets
// del bundle que tienen flag de enable/disable. Persiste el estado en browser.storage.local;
// bridge.js (mundo aislado) lee ese storage y lo propaga al MAIN world como data-attribute
// (document.documentElement.dataset.*), que es lo que ya leen los applets. Mismo mecanismo que
// content.js de la extensión de Chrome — los storage keys deben coincidir con los de allá.
(function () {
  'use strict';
  var api = (typeof browser !== 'undefined') ? browser : chrome;

  // storageKey ↔ applet. El default de TODOS es ON (enabled = storage !== false).
  var FLAGS = [
    { key: 'cfdiAttacherEnabled',            label: 'Adjuntar XML/CFDI en facturas' },
    { key: 'weightQuickEntryEnabled',        label: 'Captura rápida de peso' },
    { key: 'receiverDateOverrideEnabled',    label: 'Override de fecha de recepción' },
    { key: 'warehouseLocationPrefillEnabled',label: 'Prellenado de ubicación de almacén' },
    { key: 'invoiceAutoRegenEnabled',        label: 'Auto-regenerar facturas' },
    { key: 'invoiceDefaultTabEnabled',       label: 'Pestaña por defecto de factura' }
  ];

  function getAll(keys) {
    // browser.* devuelve Promise; chrome.* usa callback. Normalizamos a Promise.
    try { var p = api.storage.local.get(keys); if (p && p.then) return p; } catch (e) {}
    return new Promise(function (res) { api.storage.local.get(keys, res); });
  }
  function set(obj) {
    try { var p = api.storage.local.set(obj); if (p && p.then) return p; } catch (e) {}
    return new Promise(function (res) { api.storage.local.set(obj, res); });
  }

  function render(states) {
    var ul = document.getElementById('toggles');
    ul.textContent = '';
    FLAGS.forEach(function (f) {
      var enabled = states[f.key] !== false; // default ON
      var li = document.createElement('li');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = f.label;
      var sw = document.createElement('label');
      sw.className = 'sw';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = enabled;
      input.addEventListener('change', function () {
        set(makeObj(f.key, input.checked)).catch(function () {});
      });
      var slider = document.createElement('span');
      slider.className = 'slider';
      sw.appendChild(input); sw.appendChild(slider);
      li.appendChild(name); li.appendChild(sw);
      ul.appendChild(li);
    });
  }
  function makeObj(k, v) { var o = {}; o[k] = v; return o; }

  getAll(FLAGS.map(function (f) { return f.key; })).then(render).catch(function () { render({}); });

  // Versión del bundle (manifest) en el footer.
  try {
    var v = api.runtime.getManifest && api.runtime.getManifest().version;
    if (v) document.getElementById('ver').textContent = 'v' + v;
  } catch (e) {}
})();
