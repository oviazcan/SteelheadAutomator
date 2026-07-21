// Golden tests del módulo puro surtido-guard-core.js
// Run: node --test tools/test/surtido-guard-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// El core se publica como IIFE sobre window; para test en node lo cargamos con un shim.
global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'surtido-guard-core.js'));
const Core = global.window.SurtidoGuardCore;

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// ── Task 1: decisión unitaria shouldBlockMove ──────────────────────────────
test('shouldBlockMove: no bloquea si enforcement está OFF', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false, woId: 1 }, { enforcementEnabled: false });
  assert.deepStrictEqual(r, { block: false, reason: 'disabled' });
});

test('shouldBlockMove: FAIL-SAFE no bloquea si la WO no está en el mapa', () => {
  const r = Core.shouldBlockMove({ found: false }, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'unknown-failsafe');
});

test('shouldBlockMove: no bloquea WO programada', () => {
  const r = Core.shouldBlockMove({ found: true, programada: true, woId: 7 }, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'scheduled');
});

test('shouldBlockMove: bloquea WO no programada', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false, woId: 9 }, { enforcementEnabled: true });
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.reason, 'not-scheduled');
});

test('shouldBlockMove: opts ausente => disabled (no truena)', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false });
  assert.deepStrictEqual(r, { block: false, reason: 'disabled' });
});

// ── Task 2: parsers sobre fixtures con shape real ──────────────────────────
test('buildScheduledAccountSet: extrae los partsTransferAccountId programados', () => {
  const set = Core.buildScheduledAccountSet(fx('surtido-guard-schedule.json'));
  assert.strictEqual(set.has(1001), true);
  assert.strictEqual(set.has(1002), false);
  assert.strictEqual(set.size, 1);
});

test('buildSurtidoNodeSet: detecta el nodo de surtido aunque tenga prefijo de línea', () => {
  const set = Core.buildSurtidoNodeSet(fx('surtido-guard-workboard.json'));
  assert.strictEqual(set.has(7001), true);   // "T109 Preparando Surtido en Almacén"
  assert.strictEqual(set.has(7002), false);  // "T109 Recibo de Orden"
  assert.strictEqual(set.has(7003), false);  // "Listo para Preparar Surtido"
});

test('indexAccountNodeFromMoveVars: puente account -> {recipeNodeId, workOrderId} (single + multiple)', () => {
  const calls = fx('surtido-guard-movevars.json').moveDataCalls;
  let map = {};
  for (const c of calls) map = Core.indexAccountNodeFromMoveVars(c.op, c.vars, map);
  assert.deepStrictEqual(map[1001], { recipeNodeId: 7001, workOrderId: 5001 });
  assert.deepStrictEqual(map[1002], { recipeNodeId: 7001, workOrderId: 5002 });
  assert.deepStrictEqual(map[1003], { recipeNodeId: 7003, workOrderId: 5003 });
});

// ── Task 2: evaluación integrada de la mutación ────────────────────────────
function buildCtx() {
  const scheduledAccountIds = Core.buildScheduledAccountSet(fx('surtido-guard-schedule.json'));
  const surtidoNodeIds = Core.buildSurtidoNodeSet(fx('surtido-guard-workboard.json'));
  let accountNode = {};
  for (const c of fx('surtido-guard-movevars.json').moveDataCalls) {
    accountNode = Core.indexAccountNodeFromMoveVars(c.op, c.vars, accountNode);
  }
  return { scheduledAccountIds, accountNode, surtidoNodeIds };
}

test('evaluateMove: NO bloquea mover una pieza de surtido PROGRAMADA', () => {
  const muts = fx('surtido-guard-mutations.json');
  const r = Core.evaluateMove(muts.moveScheduled, buildCtx(), { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'scheduled');
});

test('evaluateMove: BLOQUEA mover una pieza de surtido NO programada', () => {
  const muts = fx('surtido-guard-mutations.json');
  const r = Core.evaluateMove(muts.moveNotScheduled, buildCtx(), { enforcementEnabled: true });
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.reason, 'not-scheduled');
  assert.deepStrictEqual(r.blocked, [{ accountId: 1002, workOrderId: 5002 }]);
});

test('evaluateMove: NO bloquea un move FUERA del nodo de surtido (otro nodo, aunque no programada)', () => {
  const muts = fx('surtido-guard-mutations.json');
  const r = Core.evaluateMove(muts.moveOutOfScope, buildCtx(), { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'out-of-scope-or-unknown');
});

test('evaluateMove: FAIL-SAFE no bloquea si el account no tiene puente (no se cargó el modal/drag)', () => {
  const muts = fx('surtido-guard-mutations.json');
  const r = Core.evaluateMove(muts.moveUnknownAccount, buildCtx(), { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'out-of-scope-or-unknown');
});

test('evaluateMove: enforcement OFF deja pasar todo', () => {
  const muts = fx('surtido-guard-mutations.json');
  const r = Core.evaluateMove(muts.moveNotScheduled, buildCtx(), { enforcementEnabled: false });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'disabled');
});

// ── Capa 4: marcado naranja de tarjetas NO movibles (bilingüe + salvaguarda) ──
test('hasScheduledCardSignal: reconoce ES y EN, ignora ruido', () => {
  assert.strictEqual(Core.hasScheduledCardSignal('… Tareas Programadas: T204 …'), true);
  assert.strictEqual(Core.hasScheduledCardSignal('… Scheduled Tasks: T204 …'), true); // case-insensitive
  assert.strictEqual(Core.hasScheduledCardSignal('Scheduled tasks'), true);
  assert.strictEqual(Core.hasScheduledCardSignal('WO: 123  Proceso: Zinc'), false);
  assert.strictEqual(Core.hasScheduledCardSignal(''), false);
  assert.strictEqual(Core.hasScheduledCardSignal(null), false);
});
test('isDomSignalBroken: solo roto si ninguna tarjeta señala pero la API sí reporta', () => {
  assert.strictEqual(Core.isDomSignalBroken(false, 5), true);  // señal DOM ausente + API tiene programadas
  assert.strictEqual(Core.isDomSignalBroken(true, 5), false);  // alguna tarjeta señaló → señal viva
  assert.strictEqual(Core.isDomSignalBroken(false, 0), false); // nada programado en API → no es rotura
  assert.strictEqual(Core.isDomSignalBroken(true, 0), false);
});
test('shouldMarkNotMovable: naranja solo si no-programada y señal no rota', () => {
  assert.strictEqual(Core.shouldMarkNotMovable(false, false), true);  // no programada, señal ok → naranja
  assert.strictEqual(Core.shouldMarkNotMovable(true, false), false);  // programada → sin marca
  assert.strictEqual(Core.shouldMarkNotMovable(false, true), false);  // señal rota → no marcar (fail-safe)
  assert.strictEqual(Core.shouldMarkNotMovable(true, true), false);
});
