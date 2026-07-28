// tools/test/popup-actions-wired.test.js
// Trinquete: toda acción del popup tiene que TENER QUIEN LA ATIENDA.
// Run: node --test tools/test/popup-actions-wired.test.js
//
// ── Por qué existe (2026-07-27) ─────────────────────────────────────────────
// El popup no habla con la página: manda `action.message` al background, que
// resuelve en ESTE orden — (1) un `case '<message>':` explícito en su switch, o
// (2) el handler genérico, que busca en config una acción con el MISMO message y
// un campo `fn`, inyecta los scripts del app y ejecuta esa función en el mundo
// MAIN. Si la acción no cae en ninguno de los dos, el background tira
// "Acción desconocida: <message>" y el botón del popup queda MUERTO.
//
// Eso le pasó a las TRES acciones del auto-ruteador desde su fase 1: declaradas
// en config con `handler:"message"`, sin `fn` y sin case. `open-auto-router` y
// `open-auto-router-batch` se salvaban porque el FAB 🔀 los abría; el ruteo por
// grupos (`open-auto-router-lanes`) NO tiene FAB — el popup era su única puerta,
// así que nació inalcanzable y el operador lo reportó como "no me sale".
//
// El síntoma es silencioso a la vista del desarrollador (el botón SÍ se pinta,
// el config SÍ es válido, el script SÍ se deploya) y solo aparece al clicar en
// producción. De ahí el test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../remote/config.json');
const ROOT = path.join(__dirname, '../..');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

const messageActions = () => {
  const out = [];
  for (const app of config.apps || []) {
    for (const act of app.actions || []) {
      if (act.handler === 'message' && act.message) out.push({ app, act });
    }
  }
  return out;
};

// El switch del background: `case 'run-archiver': {` (o varios cases seguidos).
const backgroundCases = new Set(
  [...background.matchAll(/case\s+'([^']+)'\s*:/g)].map(m => m[1])
);

// ── Línea base de deuda (trinquete) ─────────────────────────────────────────
// Botones que HOY están muertos y NO se pueden arreglar desde `remote/`: los tres
// toggles guardan su estado en `chrome.storage.local` (el background lo lee al
// inyectar y lo baja al DOM como `dataset.sa…Enabled`), y `chrome.storage` no
// existe en el mundo MAIN — o sea que necesitan un `case` en background.js, y los
// cambios de `extension/` no se publican por diseño (§Seguridad, nota 2026-07-15).
// `run-wo-mover` sí es arreglable con `fn` (WOMover.openPanel existe); queda
// pendiente de validar en qué pantallas aplica antes de cablearlo.
// El test es TRINQUETE: falla si aparece una huérfana NUEVA, y si arreglas una
// obliga a borrarla de esta lista en el mismo commit.
const HUERFANAS_CONOCIDAS = [
  'wo-mover → run-wo-mover',
  'invoice-listing-marker → toggle-invoice-listing-marker',
  'create-order-autofill → toggle-create-order-autofill',
  'invoice-autofill → toggle-invoice-autofill',
];

test('toda acción handler:"message" tiene case en background o fn en config', () => {
  const huerfanas = messageActions()
    .filter(({ act }) => !act.fn && !backgroundCases.has(act.message))
    .map(({ app, act }) => `${app.id} → ${act.message}`);
  const nuevas = huerfanas.filter(h => !HUERFANAS_CONOCIDAS.includes(h));
  assert.deepEqual(nuevas, [], `Acciones NUEVAS sin quien las atienda (el popup diría "Acción desconocida"):\n  ${nuevas.join('\n  ')}`);
  const arregladas = HUERFANAS_CONOCIDAS.filter(h => !huerfanas.includes(h));
  assert.deepEqual(arregladas, [], `Ya no están huérfanas — bájalas de HUERFANAS_CONOCIDAS en este mismo commit:\n  ${arregladas.join('\n  ')}`);
});

test('cada fn apunta a un método que su applet exporta', () => {
  const rotas = [];
  for (const { app, act } of messageActions()) {
    if (!act.fn) continue;
    const [ns, method] = act.fn.split('.');
    assert.ok(ns && method, `fn mal formado en ${app.id}: ${act.fn}`);
    const sources = (app.scripts || [])
      .map(s => path.join(ROOT, 'remote', s))
      .filter(f => fs.existsSync(f))
      .map(f => fs.readFileSync(f, 'utf8'));
    // Basta con que ALGÚN script del app declare el método y asigne el namespace
    // a window: el export exacto (objeto literal, Object.assign, …) varía.
    const exportaNs = sources.some(src => new RegExp(`window\\.${ns}\\s*=`).test(src));
    const declaraMetodo = sources.some(src =>
      new RegExp(`(function\\s+${method}\\s*\\(|${method}\\s*[:(]\\s*(async\\s*)?(function|\\()|\\b${method}\\s*,|\\b${method}\\s*})`).test(src)
    );
    if (!exportaNs || !declaraMetodo) rotas.push(`${app.id} → ${act.fn} (window.${ns}=${exportaNs}, ${method}=${declaraMetodo})`);
  }
  assert.deepEqual(rotas, [], `fn que no resuelven en runtime:\n  ${rotas.join('\n  ')}`);
});

test('las cuatro puertas del auto-ruteador siguen cableadas', () => {
  const app = (config.apps || []).find(a => a.id === 'auto-router');
  assert.ok(app, 'no está el app auto-router en config');
  const byMsg = Object.fromEntries((app.actions || []).map(a => [a.message, a.fn]));
  assert.equal(byMsg['open-auto-router'], 'AutoRouter.openPanelFromPopup');
  assert.equal(byMsg['open-auto-router-batch'], 'AutoRouter.openBatchFromPopup');
  assert.equal(byMsg['open-auto-router-lanes'], 'AutoRouter.openLanesFromPopup');
  assert.equal(byMsg['open-auto-router-split'], 'AutoRouter.openSplitFromPopup');
  // Ruteo y partición comparten script: si se cae del app, se van las dos.
  assert.ok((app.scripts || []).includes('scripts/auto-router-lanes.js'));
});
