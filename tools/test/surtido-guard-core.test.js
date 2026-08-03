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
  // Quien NIEGA la programación es el mapa por cuenta (GetPartsInProcessNode4), no el Set de
  // GetRelatedScheduleData: ése viene filtrado por las estaciones del board, así que la ausencia
  // de una cuenta ahí no prueba nada. Antes estos escenarios negaban con el Set —esa premisa era
  // justo el bug de piso del 2026-07-30—, así que el estado "no programada" se declara aquí.
  const accountScheduled = new Map([[1001, true], [1002, false], [1003, false]]);
  return { scheduledAccountIds, accountScheduled, accountNode, surtidoNodeIds };
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

// ── Fuente REAL de "programada": GetPartsInProcessNode4 ────────────────────
// Contexto (bug de piso 2026-07-30): GetRelatedScheduleData se pide filtrada por las
// stationIds del WORKBOARD ({stationIds:[13785,-1]}). Un board de ALMACÉN no tiene tareas
// programadas en sus propias estaciones —las tareas viven en estaciones de LÍNEA (T204-LI…)—
// así que esa query devuelve validScheduleTasks:[] SIEMPRE y el set salía vacío. Con el set
// vacío, todo lo que estuviera en un nodo de surtido se bloqueaba, incluidas las programadas.
// La señal correcta viaja POR CUENTA en la query que el board ya pide para pintar las tarjetas.
test('buildAccountScheduleMap: mapea account -> programada desde GetPartsInProcessNode4', () => {
  const m = Core.buildAccountScheduleMap(fx('surtido-guard-partlocations.json'));
  assert.strictEqual(m.get(44812076), true);   // WO 1913029 — la del reporte, programada en T204-LI
  assert.strictEqual(m.get(45222065), true);
  assert.strictEqual(m.get(45101981), false);  // sin tareas asociadas
  assert.strictEqual(m.get(45320050), true);
  assert.strictEqual(m.size, 4);
});

test('buildAccountScheduleMap: acumula sobre un mapa previo (la query llega por lotes)', () => {
  const prev = new Map([[999, true]]);
  const m = Core.buildAccountScheduleMap(fx('surtido-guard-partlocations.json'), prev);
  assert.strictEqual(m, prev);                 // muta el mismo Map
  assert.strictEqual(m.get(999), true);        // no pierde lo anterior
  assert.strictEqual(m.get(44812076), true);
});

test('buildAccountScheduleMap: dato ausente/basura => mapa vacío, no truena', () => {
  assert.strictEqual(Core.buildAccountScheduleMap(null).size, 0);
  assert.strictEqual(Core.buildAccountScheduleMap({}).size, 0);
  assert.strictEqual(Core.buildAccountScheduleMap({ allPartLocations: { nodes: [{}] } }).size, 0);
});

// Reproducción del bug de piso, con los ids REALES del board 10922.
const REAL = {
  surtidoNodeIds: new Set([46068088, 46836961, 46837220]),
  accountNode: {
    44812076: { recipeNodeId: 46836961, workOrderId: 1913029 },  // programada (T204-LI)
    45101981: { recipeNodeId: 46068088, workOrderId: 1884951 }   // NO programada
  }
};
const mutMove = (accId) => ({
  partsTransferEventsPayload: {
    partsTransferEvents: [{ partsTransfers: [{ type: 'STEP', fromAccountId: accId }] }]
  }
});

test('REGRESIÓN: con GetRelatedScheduleData vacío, NO bloquea una orden que SÍ está programada', () => {
  const ctx = {
    scheduledAccountIds: new Set(),                                   // lo que devuelve la fuente legada
    accountScheduled: Core.buildAccountScheduleMap(fx('surtido-guard-partlocations.json')),
    accountNode: REAL.accountNode,
    surtidoNodeIds: REAL.surtidoNodeIds
  };
  const r = Core.evaluateMove(mutMove(44812076), ctx, { enforcementEnabled: true });
  assert.strictEqual(r.block, false, 'la WO 1913029 está programada en T204-LI: no se debe bloquear');
  assert.strictEqual(r.reason, 'scheduled');
});

test('el candado SIGUE bloqueando una orden de surtido realmente NO programada', () => {
  const ctx = {
    scheduledAccountIds: new Set(),
    accountScheduled: Core.buildAccountScheduleMap(fx('surtido-guard-partlocations.json')),
    accountNode: REAL.accountNode,
    surtidoNodeIds: REAL.surtidoNodeIds
  };
  const r = Core.evaluateMove(mutMove(45101981), ctx, { enforcementEnabled: true });
  assert.strictEqual(r.block, true);
  assert.deepStrictEqual(r.blocked, [{ accountId: 45101981, workOrderId: 1884951 }]);
});

test('FAIL-SAFE: sin dato de programación para ese account, NO bloquea', () => {
  // El account tiene puente y está en scope, pero ninguna fuente sabe si está programado.
  const ctx = {
    scheduledAccountIds: new Set(),
    accountScheduled: new Map(),      // GetPartsInProcessNode4 nunca llegó
    accountNode: REAL.accountNode,
    surtidoNodeIds: REAL.surtidoNodeIds
  };
  const r = Core.evaluateMove(mutMove(45101981), ctx, { enforcementEnabled: true });
  assert.strictEqual(r.block, false, 'sin evidencia no se frena el piso');
  assert.strictEqual(r.reason, 'out-of-scope-or-unknown');
});

test('la fuente legada solo AFIRMA: basta que una diga "programada" para no bloquear', () => {
  // GetRelatedScheduleData no puede NEGAR (sale vacía por diseño en boards de almacén), pero
  // cuando trae un account, ese dato es válido y debe absolver.
  const ctx = {
    scheduledAccountIds: new Set([45101981]),
    accountScheduled: new Map([[45101981, false]]),
    accountNode: REAL.accountNode,
    surtidoNodeIds: REAL.surtidoNodeIds
  };
  const r = Core.evaluateMove(mutMove(45101981), ctx, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'scheduled');
});

test('isPartsInProcessOp: sobrevive a que Steelhead suba la versión del nombre', () => {
  assert.strictEqual(Core.isPartsInProcessOp('GetPartsInProcessNode4'), true);
  assert.strictEqual(Core.isPartsInProcessOp('GetPartsInProcessNode5'), true);
  assert.strictEqual(Core.isPartsInProcessOp('GetPartsInProcessNode'), true);
  assert.strictEqual(Core.isPartsInProcessOp('GetPartsInProcessNodeXY'), false);
  assert.strictEqual(Core.isPartsInProcessOp('GetRelatedScheduleData'), false);
  assert.strictEqual(Core.isPartsInProcessOp(null), false);
});

test('hasScheduleEvidence: distingue "no hay programadas" de "no tengo el dato"', () => {
  assert.strictEqual(Core.hasScheduleEvidence({ accountScheduled: new Map(), scheduledAccountIds: new Set() }), false);
  assert.strictEqual(Core.hasScheduleEvidence({ accountScheduled: new Map([[1, false]]) }), true);
  assert.strictEqual(Core.hasScheduleEvidence({ scheduledAccountIds: new Set([1]) }), true);
  assert.strictEqual(Core.hasScheduleEvidence(null), false);
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
