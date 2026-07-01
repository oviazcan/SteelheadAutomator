// sa-dispatcher.js — despachador de comandos del popup (MAIN world). build-safari.sh lo concatena
// tras sa-bootstrap.js (ambos son el "pegamento" del bundle en el MAIN world).
//
// Contexto: en Chrome, el popup manda un chrome.runtime message y el service worker (background.js)
// inyecta los scripts del applet y llama su función global. En Safari NO hay re-inyector: TODOS los
// applets del bundle ya están cargados en el MAIN world (document_idle). Así que un botón del popup
// solo necesita DISPARAR la función de entrada del applet, no cargarlo.
//
// Canal (reusa el mismo puente storage→bridge→MAIN que ya usan los toggles):
//   popup.js  → browser.storage.local.set({ saCommand: { action, nonce } })
//   bridge.js → storage.onChanged detecta saCommand → postMessage {type:'command', action} al MAIN
//   AQUÍ      → resuelve action → función global del applet y la invoca
//
// Por qué un ALLOWLIST y no leer act.fn del config a ciegas:
//   (1) Varias acciones (run-archiver, assign-sensor-status) NO declaran `fn` en config.json —en Chrome
//       las resuelve un `switch` explícito en background.js—; el allowlist las cubre sin tocar el config
//       (hot file compartido con Chrome).
//   (2) Seguridad: el postMessage viene del MAIN world (que la página comparte); un allowlist evita que
//       un mensaje forjado invoque cualquier window.<path>. El applet ya vive en el MAIN world, así que
//       esto no agrega privilegios, pero acota la superficie a funciones conocidas.
// El fallback a REMOTE_CONFIG.apps[].actions[].fn cubre applets futuros que sí declaren `fn` en config.
(function () {
  'use strict';

  // message (config action.message) → función global del applet en el MAIN world.
  var LAUNCH_FN = {
    'open-vale-almacen':       'ValeAlmacen.open',
    'run-archiver':            'PNArchiver.openConfigAndRun',
    'assign-sensor-status':    'SensorStatusAutofill.run',
    'open-station-config':     'LoadCalculator.openStationConfig',
    // auto-router: openPanel re-rutea la(s) orden(es) capturada(s) del modal de ruteo (alerta si no
    // hay contexto); openBatch abre el modal de pegar números de orden (autocontenido). En Chrome su
    // trigger vive en chrome.runtime.onMessage (muerto en MAIN world); aquí lo revive el postMessage.
    'open-auto-router':        'AutoRouter.openPanel',
    'open-auto-router-batch':  'AutoRouter.openBatch',
    'open-wo-completer':       'WOCompleter.open',
    'run-wo-deadline':         'WODeadlineChanger.run'
  };

  function resolveFn(action) {
    if (LAUNCH_FN[action]) return LAUNCH_FN[action];
    // Fallback data-driven: busca act.fn en el config (seedeado + refrescado en caliente por el bridge).
    try {
      var apps = (window.REMOTE_CONFIG && window.REMOTE_CONFIG.apps) || [];
      for (var i = 0; i < apps.length; i++) {
        var acts = apps[i].actions || [];
        for (var j = 0; j < acts.length; j++) {
          if (acts[j].message === action && acts[j].fn) return acts[j].fn;
        }
      }
    } catch (e) {}
    return null;
  }

  function callByPath(path) {
    var parts = path.split('.');
    var obj = window;
    for (var k = 0; k < parts.length - 1; k++) {
      obj = obj[parts[k]];
      if (!obj) return { error: parts[k] + ' no disponible' };
    }
    var method = obj[parts[parts.length - 1]];
    if (typeof method !== 'function') return { error: path + ' no es una función' };
    try {
      var r = method.call(obj);
      // Muchas funciones de entrada devuelven Promise (abren un modal async). Fire-and-forget:
      // el popup ya se cerró; el applet muestra su propia UI en la página.
      if (r && typeof r.then === 'function') {
        r.then(function () {}).catch(function (e) { console.error('[SA] dispatcher', path, e); });
      }
      return { started: true };
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    }
  }

  var lastNonce = null; // dedup: el comando puede llegar por dos vías (runtime.onMessage + storage.onChanged).

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__saBridge !== true || d.type !== 'command' || !d.action) return;
    if (d.nonce != null && d.nonce === lastNonce) return; // ya lo procesamos por la otra vía
    lastNonce = d.nonce;
    console.log('[SA] dispatcher: comando', d.action);
    var fn = resolveFn(d.action);
    if (!fn) { console.warn('[SA] dispatcher: acción sin función registrada:', d.action); return; }
    var res = callByPath(fn);
    if (res && res.error) console.error('[SA] dispatcher:', d.action, '→', res.error);
    else console.log('[SA] dispatcher:', d.action, '→', fn, 'ok');
  });

  console.log('[SA] dispatcher listo (v2 tabs.sendMessage + storage fallback)');
})();
