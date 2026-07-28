// tools/test/auto-router-lanes-fab.test.js
// Los FABs del auto-ruteador: 🔀 rutea (orden completa o grupos) y ✂️ parte/reagrupa
// las piezas. Su gate de ruta tiene que cubrir exactamente las pantallas que el applet
// declara en config, ni más ni menos — el 🔀 en la ficha y el tablero, el ✂️ en ambas
// desde 2026-07-28 (partir es una decisión de planificación, no de la ficha).
// Run: node --test tools/test/auto-router-lanes-fab.test.js
//
// ── Por qué (2026-07-27) ────────────────────────────────────────────────────
// Con el popup ya cableado (v0.3.1) el operador seguía abriendo el panel
// single-order creyendo que era el de grupos, y con un FAB 📦 extra (v0.3.2) la
// queja fue la correcta: los dos FABs llevaban a lo mismo. v0.3.3 reparte por
// TRABAJO, no por panel — 🔀 decide rutas (no mueve nada hasta aplicar) y ✂️
// parte/reagrupa piezas, que mueve material real y es lo que va ANTES, porque un
// grupo no se puede rutear hasta que existe. Si su gate se desalinea del config,
// el botón desaparece de la pantalla donde debe estar — en silencio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../remote/config.json');
const SRC = fs.readFileSync(path.join(__dirname, '../../remote/scripts/auto-router.js'), 'utf8');

// El regex tal cual está escrito en el glue.
const gateOf = name => {
  const m = SRC.match(new RegExp(`function ${name}\\(\\)\\s*\\{[^}]*?return (/[^;]+?)\\.test\\(location\\.pathname\\)`, 's'));
  assert.ok(m, `no encontré el gate de ${name}() en auto-router.js`);
  return eval(m[1]); // eslint-disable-line no-eval — es un literal del propio fuente
};

const FICHA = '/Domains/344/WorkOrders/15990';
const LISTADO = '/Domains/344/WorkOrders';
const BOARD = '/Schedules/12/ScheduleBoard/34';

test('los FABs de la ficha se montan en la ficha de una OT', () => {
  assert.equal(gateOf('isWorkOrderDetail').test(FICHA), true);
});

test('NO se monta en el listado de OTs', () => {
  // El listado no tiene número de orden: el panel no sabría qué cargar.
  assert.equal(gateOf('isWorkOrderDetail').test(LISTADO), false);
  assert.equal(gateOf('isBoardPage').test(LISTADO), false);
});

// ── El ✂️ también vive en el tablero (2026-07-28) ───────────────────────────
// Antes solo estaba en la ficha, y eso mandaba al operador a buscar la orden para
// cortar piezas justo cuando estaba planificando. La orden la da la fila marcada.
test('el ✂️ se monta en la ficha Y en el tablero de planificación', () => {
  assert.match(SRC, /function splitFabApplies\(\)\s*\{\s*return isWorkOrderDetail\(\) \|\| isBoardPage\(\);/,
    'splitFabApplies() debe cubrir ficha y tablero');
  assert.match(SRC, /const show = splitFabApplies\(\);/,
    'syncSplitFab() debe decidir con splitFabApplies()');
  const aplica = (p) => gateOf('isWorkOrderDetail').test(p) || gateOf('isBoardPage').test(p);
  assert.equal(aplica(FICHA), true);
  assert.equal(aplica(BOARD), true);
  assert.equal(aplica(LISTADO), false);
});

test('el gate del ✂️ en el tablero cae dentro de los urlPatterns del config', () => {
  const app = (config.apps || []).find(a => a.id === 'auto-router');
  const patterns = (app.urlPatterns || app.urlPatternsDisabled || []).map(p => new RegExp(p));
  // Si el config dejara de inyectar en el board, el ✂️ no existiría ahí por más que
  // su gate diga que sí — el mismo modo de fallo silencioso del 0.3.0.
  assert.ok(patterns.some(p => p.test(BOARD)), 'el config ya no inyecta el applet en el tablero');
});

test('el gate del FAB cae dentro de los urlPatterns que el config inyecta', () => {
  const app = (config.apps || []).find(a => a.id === 'auto-router');
  const patterns = (app.urlPatterns || app.urlPatternsDisabled || []).map(p => new RegExp(p));
  assert.ok(patterns.length, 'auto-router sin urlPatterns en config');
  // Si el config dejara de inyectar en la ficha, el FAB no existiría por más que
  // su propio gate diga que sí.
  assert.ok(patterns.some(p => p.test(FICHA)), 'el config ya no inyecta el applet en la ficha de OT');
});

test('el board sigue siendo territorio del 🔀 para el ruteo por selección', () => {
  assert.equal(gateOf('isBoardPage').test(BOARD), true);
  assert.equal(gateOf('isBoardPage').test(FICHA), false);
});
