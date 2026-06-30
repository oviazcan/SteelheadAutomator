// bridge.js — content script del mundo AISLADO (default). Replica el rol del background.js
// de Chrome: fetchea config.json de GitHub Pages y lo pasa al bundle (MAIN world) por postMessage.
//
// POR QUÉ esto NO viola Apple Guideline 2.5.2: config.json son DATOS (hashes de persisted
// queries, IDs de dominio, constantes), no código ejecutable. Apple prohíbe descargar y EJECUTAR
// código remoto; descargar datos de configuración está permitido. Resultado: los hashes (que
// ROTAN con frecuencia) se actualizan EN CALIENTE con un `git push` a gh-pages, SIN recompilar ni
// redistribuir la app. Solo un cambio de LÓGICA (los .js empaquetados en main-bundle.js) requiere
// rebuild. El mundo AISLADO no está sujeto a la CSP de app.gosteelhead.com (igual que el background
// de Chrome), por eso puede fetchear github.io.
(function () {
  'use strict';
  var CONFIG_URL = 'https://oviazcan.github.io/SteelheadAutomator/config.json';

  fetch(CONFIG_URL, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) { console.error('[SA] bridge: config.json vacío/no-OK'); return; }
      try { window.postMessage({ __saBridge: true, type: 'config', config: cfg }, location.origin); }
      catch (e) { console.error('[SA] bridge: postMessage falló', e); }
    })
    .catch(function (e) { console.error('[SA] bridge: no se pudo cargar config.json', e); });
})();
