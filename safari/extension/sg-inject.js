// PLAN B — loader para iPadOS donde content_scripts world:"MAIN" NO está disponible
// (Safari/iPadOS < 17). Corre en el mundo AISLADO (default) en document_start e inyecta
// el bundle como <script src> en el MAIN world de la página, que es donde necesita vivir
// para parchear window.fetch del SPA de Steelhead.
//
// Se activa usando manifest.fallback.json en lugar de manifest.json (ver README).
// NO se usa junto con la variante A (world:"MAIN"); es uno u otro.
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const s = document.createElement('script');
  s.src = api.runtime.getURL('main-bundle.js');
  s.onload = function () { s.remove(); };
  s.onerror = function () { console.error('[SA] bundle fallback: no cargó main-bundle.js'); };
  (document.head || document.documentElement).appendChild(s);
})();
