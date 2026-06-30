// sa-bootstrap.js — PRELUDE del bundle (MAIN world). build-safari.sh lo concatena PRIMERO en
// main-bundle.js. Recibe el config.json que bridge.js (mundo aislado) fetchea de gh-pages y lo instala:
//   · window.REMOTE_CONFIG  → lo leen applets como paros-linea (const cfg = () => window.REMOTE_CONFIG)
//   · SteelheadAPI.init(config) → carga los hashes para query()/getHash()
//
// El config llega de forma ASÍNCRONA (tras el fetch del bridge, ~cientos de ms). Las mutaciones de
// los applets ocurren por ACCIÓN del usuario (clicks posteriores), así que para entonces el config ya
// está. Como los hashes NO se hornean en el bundle, rotan en caliente (git push a gh-pages) sin rebuild.
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
})();
