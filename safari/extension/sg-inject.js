// PLAN B — loader para iPadOS donde content_scripts world:"MAIN" NO está disponible
// (Safari/iPadOS < 17). Este script corre en el mundo AISLADO (default) en document_start
// y, desde ahí, inyecta los scripts del candado como <script src> en el MAIN world de la
// página, que es donde necesitan vivir para parchear window.fetch del SPA de Steelhead.
//
// Se activa usando manifest.fallback.json en lugar de manifest.json (ver README).
// NO se usa junto con la variante A (world:"MAIN"); es uno u otro.
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined') ? browser : chrome;

  // Inyección SECUENCIAL para garantizar el orden core → glue (el glue depende de
  // window.SurtidoGuardCore). onload encadena el siguiente; cada tag se remueve tras cargar.
  function injectSeq(files, i) {
    i = i || 0;
    if (i >= files.length) return;
    const s = document.createElement('script');
    s.src = api.runtime.getURL(files[i]);
    s.onload = function () { s.remove(); injectSeq(files, i + 1); };
    s.onerror = function () { console.error('[SA] SurtidoGuard fallback: no cargó', files[i]); };
    (document.head || document.documentElement).appendChild(s);
  }

  injectSeq(['surtido-guard-core.js', 'surtido-guard.js']);
})();
