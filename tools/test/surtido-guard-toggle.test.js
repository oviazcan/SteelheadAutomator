// Regresión: el toggle del candado debe sobrevivir la RE-INYECCIÓN del script.
//
// background.js → injectAppScripts re-evalúa surtido-guard.js en CADA acción del
// popup (el script no está en el mapa `globals` de dedup). Eso crea una instancia
// nueva del IIFE. Si el flag `enforcementEnabled` vive en el closure, el toggle
// muta la instancia nueva mientras el interceptor de fetch —latcheado a la
// instancia ORIGINAL— sigue leyendo el flag viejo → "Desactivado" sin efecto real.
//
// El fix: el flag vive en window.__saSurtidoGuardEnabled (singleton compartido por
// todas las instancias), default ON solo en la PRIMERA carga (si está undefined),
// así una re-inyección no repisa lo que el operador apagó y un reload limpia window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPTS = path.join(__dirname, '../../remote/scripts');
const CORE = fs.readFileSync(path.join(SCRIPTS, 'surtido-guard-core.js'), 'utf8');
const GLUE = fs.readFileSync(path.join(SCRIPTS, 'surtido-guard.js'), 'utf8');

// window/document mínimos: location NO es un workboard, así init() hace solo
// patchFetch + installUrlChangeListener y retorna antes del DOM pesado.
function makeWindow() {
  const noop = () => {};
  const el = () => ({ style: {}, dataset: {}, id: '', className: '', textContent: '',
    setAttribute: noop, removeAttribute: noop, appendChild: noop, insertBefore: noop,
    classList: { add: noop, remove: noop }, querySelectorAll: () => [], querySelector: () => null });
  const win = {};
  win.window = win;
  win.fetch = async () => ({ clone: () => ({ json: () => Promise.resolve({}) }) });
  win.addEventListener = noop;
  win.dispatchEvent = noop;
  win.setTimeout = () => 0;            // no dispara callbacks (decorate/guard quedan no-op)
  win.clearTimeout = noop;
  win.console = { log: noop, warn: noop, error: noop };
  win.location = { pathname: '/', search: '' };
  win.history = { pushState: noop, replaceState: noop };
  win.document = { readyState: 'complete', getElementById: () => null, createElement: el,
    head: { appendChild: noop }, body: { appendChild: noop }, addEventListener: noop,
    createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] };
  win.MutationObserver = class { observe() {} disconnect() {} };
  win.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 3 };
  win.Event = class { constructor(t) { this.type = t; } };
  win.Response = class { constructor(b, i) { this.body = b; this.init = i; } };
  win.__CORE = CORE;
  win.__GLUE = GLUE;
  return win;
}

// Replica fielmente injectAppScripts (background.js): cada inyección corre
// new Function(code)(), que crea un scope de función nuevo — por eso el `const
// SurtidoGuard` top-level NO colisiona entre re-inyecciones (sí lo haría con un
// eval directo en el mismo scope global).
function inject(ctx) { vm.runInContext('new Function(__CORE)(); new Function(__GLUE)();', ctx); }

test('toggle desactiva el enforcement que lee el interceptor', () => {
  const win = makeWindow();
  const ctx = vm.createContext(win);
  inject(ctx);

  // Primera carga: default ON.
  assert.strictEqual(win.__saSurtidoGuardEnabled, true);
  assert.strictEqual(win.SurtidoGuard._getState().enforcementEnabled, true);

  // Toggle desde el popup → apaga.
  const r = win.SurtidoGuard.toggleFromPopup();
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(win.__saSurtidoGuardEnabled, false,
    'el flag singleton de window debe quedar en false tras el toggle');
});

test('el toggle SOBREVIVE la re-inyección del script (bug del candado)', () => {
  const win = makeWindow();
  const ctx = vm.createContext(win);
  inject(ctx);

  // Operador apaga el candado.
  win.SurtidoGuard.toggleFromPopup();
  assert.strictEqual(win.__saSurtidoGuardEnabled, false);

  // injectAppScripts re-evalúa el IIFE en la siguiente acción del popup.
  inject(ctx);

  // El flag NO debe repisarse a true: lo que el interceptor (latcheado a la 1ª
  // instancia) lee y lo que reporta la instancia nueva deben seguir en OFF.
  assert.strictEqual(win.__saSurtidoGuardEnabled, false,
    'la re-inyección NO debe reactivar el candado que el operador apagó');
  assert.strictEqual(win.SurtidoGuard._getState().enforcementEnabled, false);
});

test('un reload (window limpio) vuelve a default ON', () => {
  const win1 = makeWindow();
  const ctx1 = vm.createContext(win1);
  inject(ctx1);
  win1.SurtidoGuard.toggleFromPopup();             // apagado en esta "página"
  assert.strictEqual(win1.__saSurtidoGuardEnabled, false);

  // Nueva página (window nuevo) → debe arrancar ON (no persistente).
  const win2 = makeWindow();
  const ctx2 = vm.createContext(win2);
  inject(ctx2);
  assert.strictEqual(win2.__saSurtidoGuardEnabled, true);
});
