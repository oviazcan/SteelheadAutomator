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

  // Lanzadores: applets con INTERFAZ que se abren desde el popup (no tienen botón flotante propio, o el
  // popup es un atajo). Al tocar uno escribimos un "comando" en storage; bridge.js lo reenvía al MAIN world
  // y sa-dispatcher.js llama la función global del applet. `message` debe coincidir con el allowlist de
  // sa-dispatcher.js (LAUNCH_FN) y con config.apps[].actions[].message.
  var LAUNCHERS = [
    { message: 'open-vale-almacen',     icon: '📦', label: 'Emitir Vale de Almacén',    sub: 'Registrar artículos entregados por usuario' },
    { message: 'run-archiver',          icon: '🗄️', label: 'Archivar / Desarchivar PNs', sub: 'Por etiquetas, fecha (opcional) y modo' },
    { message: 'assign-sensor-status',  icon: '📊', label: 'Asignar status de sensores', sub: 'Auto-asigna o elige candidato por member' },
    { message: 'open-station-config',   icon: '⚙️', label: 'Configurar Estaciones',      sub: 'Dims de tina, capacidad DMK y OEE por línea' }
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

  function renderLaunchers() {
    var ul = document.getElementById('launchers');
    if (!ul) return;
    ul.textContent = '';
    LAUNCHERS.forEach(function (a) {
      var li = document.createElement('li');
      li.className = 'act';
      li.setAttribute('role', 'button');
      li.tabIndex = 0;

      var ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = a.icon;

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = a.label;
      var small = document.createElement('small');
      small.textContent = a.sub;
      name.appendChild(small);

      var chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';

      li.appendChild(ic); li.appendChild(name); li.appendChild(chev);
      li.addEventListener('click', function () { launch(a.message); });
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launch(a.message); }
      });
      ul.appendChild(li);
    });
  }

  // Escribe el comando y cierra el popup para devolver el foco a la página (el applet abre su modal ahí).
  function launch(message) {
    set(makeObj('saCommand', { action: message, nonce: Date.now() }))
      .then(function () { try { window.close(); } catch (e) {} })
      .catch(function () {});
  }

  getAll(FLAGS.map(function (f) { return f.key; })).then(render).catch(function () { render({}); });
  renderLaunchers();

  // Versión del bundle (manifest) en el footer.
  try {
    var v = api.runtime.getManifest && api.runtime.getManifest().version;
    if (v) document.getElementById('ver').textContent = 'v' + v;
  } catch (e) {}
})();
