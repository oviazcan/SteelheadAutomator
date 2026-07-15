// sa-bootstrap.js — PRELUDE del bundle (MAIN world). build-safari.sh lo concatena tras steelhead-api.js.
// Recibe el config.json que bridge.js (mundo aislado) fetchea de gh-pages y lo instala en caliente:
//   · window.REMOTE_CONFIG  → lo leen applets como paros-linea
//   · SteelheadAPI.init(config) → hashes para query()/getHash()
// El arranque síncrono lo cubre el config-seed horneado; esto REFRESCA con el config en vivo (hashes que
// rotaron). Handshake: pedimos el config al bridge por si ya lo fetcheó antes de que registráramos el listener.
(function () {
  'use strict';
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__saBridge !== true || d.type !== 'config' || !d.config) return;
    window.REMOTE_CONFIG = d.config;
    try {
      if (window.SteelheadAPI && typeof window.SteelheadAPI.init === 'function') {
        window.SteelheadAPI.init(d.config);
      }
    } catch (err) { console.error('[SA] bootstrap: SteelheadAPI.init falló', err); }
  });
  // Pedir el config al bridge (que corre en document_start y pudo haberlo enviado ya).
  try { window.postMessage({ __saBridgeReq: true }, location.origin); } catch (e) {}
})();
