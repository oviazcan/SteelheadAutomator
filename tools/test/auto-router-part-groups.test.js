// tools/test/auto-router-part-groups.test.js
// Aislamiento de PISTAS de ruteo por grupo de partes.
//
// Modelo confirmado en vivo (WO 15074/15075, evidencia del operador 2026-07-27):
//   · Ruta con partGroupId = null  → GLOBAL de la orden; aplica a los grupos sin override.
//   · Ruta con partGroupId = X     → OVERRIDE del grupo X; TOMA PRECEDENCIA sobre la global.
//   · Las dos COEXISTEN para el mismo recipeNode. En la WO 15074, "Current Routes" lista:
//       TR-PRM-010 Recibo de Orden  ·  (sin grupo)  → T204-EN00-001
//       TR-PRM-010 Recibo de Orden  ·  grupo 2      → T205-EN00-001
//   · Un grupo sin override hereda la global; sin global, el default de la receta.
//
// Por eso el diff NO puede indexar solo por recipeNodeId: la override pisaba a la global
// en el Map y el ruteador podía mover el grupo equivocado o borrarle sus rutas — con
// consecuencia física (piezas a la tina que no es).
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../../remote/scripts/auto-router-engine.js');

const WO = 1908434;
const PN = 3028455;

// Rutas activas de una WO con global (T204) y override del grupo 2 (T205) en los
// MISMOS recipeNodes — el shape real de StationTreatmentByWorkOrder.activeRoutes.nodes[].
const ACTIVAS_MIXTAS = [
  { id: 9001, recipeNodeId: 1, stationId: 204001, partGroupId: null, workOrderId: WO, partNumberId: PN },
  { id: 9002, recipeNodeId: 1, stationId: 205001, partGroupId: 2, workOrderId: WO, partNumberId: PN },
  { id: 9003, recipeNodeId: 2, stationId: 204002, partGroupId: null, workOrderId: WO, partNumberId: PN },
  { id: 9004, recipeNodeId: 2, stationId: 205002, partGroupId: 2, workOrderId: WO, partNumberId: PN },
];

const ruta = (recipeNodeId, stationId, partGroupId) => ({
  recipeNodeId, stationId, partGroupId, treatmentId: 10, partNumberId: PN, workOrderId: WO,
});

test('rutear la GLOBAL no toca las rutas override del grupo', () => {
  const desired = [ruta(1, 203001, null), ruta(2, 203002, null)];
  const d = Engine.diffRoutes(desired, ACTIVAS_MIXTAS);
  // Solo se actualizan las globales (9001, 9003).
  assert.deepEqual(d.routesToUpdate.map((r) => r.id).sort(), [9001, 9003]);
  assert.deepEqual(d.routesToDelete, [], 'las override del grupo 2 NO se borran');
  assert.deepEqual(d.routesToCreate, []);
});

test('rutear el GRUPO no toca la ruta global', () => {
  const desired = [ruta(1, 207001, 2), ruta(2, 207002, 2)];
  const d = Engine.diffRoutes(desired, ACTIVAS_MIXTAS);
  assert.deepEqual(d.routesToUpdate.map((r) => r.id).sort(), [9002, 9004]);
  assert.deepEqual(d.routesToDelete, [], 'las globales NO se borran');
});

test('un grupo SIN override estrena rutas sin borrar las globales', () => {
  // El grupo 5 no tiene ninguna ruta activa: todo se crea, nada se toca.
  const desired = [ruta(1, 210001, 5), ruta(2, 210002, 5)];
  const d = Engine.diffRoutes(desired, ACTIVAS_MIXTAS);
  assert.equal(d.routesToCreate.length, 2);
  assert.deepEqual(d.routesToCreate.map((r) => r.partGroupId), [5, 5]);
  assert.deepEqual(d.routesToUpdate, []);
  assert.deepEqual(d.routesToDelete, [], 'no borra rutas de OTRAS pistas');
});

test('el borrado se acota a la pista que se está ruteando', () => {
  // Se rutea el grupo 2, pero ya no se incluye el recipeNode 2 → solo muere SU override.
  const desired = [ruta(1, 205001, 2)];
  const d = Engine.diffRoutes(desired, ACTIVAS_MIXTAS);
  assert.deepEqual(d.routesToDelete, [9004], 'solo la override sobrante del grupo 2');
  assert.deepEqual(d.routesToUpdate, [], 'misma tina → no-op');
});

test('misma pista y misma tina → no-op (idempotente)', () => {
  const desired = [ruta(1, 205001, 2), ruta(2, 205002, 2)];
  const d = Engine.diffRoutes(desired, ACTIVAS_MIXTAS);
  assert.deepEqual(d.routesToCreate, []);
  assert.deepEqual(d.routesToUpdate, []);
  assert.deepEqual(d.routesToDelete, []);
});

test('partGroupId ausente en la ruta activa se trata como global (null)', () => {
  // activeRoutes de órdenes viejas puede no traer la clave; undefined ≡ null.
  const activas = [{ id: 7001, recipeNodeId: 1, stationId: 204001 }];
  const d = Engine.diffRoutes([ruta(1, 203001, null)], activas);
  assert.deepEqual(d.routesToUpdate, [{ id: 7001, stationId: 203001 }]);
});

test('sin rutas deseadas no se borra nada (fail-safe: no hay pista declarada)', () => {
  const d = Engine.diffRoutes([], ACTIVAS_MIXTAS);
  assert.deepEqual(d.routesToDelete, []);
  assert.deepEqual(d.routesToCreate, []);
  assert.deepEqual(d.routesToUpdate, []);
});

test('dos pistas en una sola llamada: cada quien con lo suyo', () => {
  const desired = [ruta(1, 203001, null), ruta(1, 207001, 2)];
  const d = Engine.diffRoutes(desired, ACTIVAS_MIXTAS);
  assert.deepEqual(d.routesToUpdate.sort((a, b) => a.id - b.id),
    [{ id: 9001, stationId: 203001 }, { id: 9002, stationId: 207001 }]);
  // El recipeNode 2 sale de AMBAS pistas → mueren sus dos rutas.
  assert.deepEqual(d.routesToDelete.sort(), [9003, 9004]);
});
