// tools/test/masked-ops-coherence.test.js
// Blinda la FUENTE ÚNICA DE VERDAD de ops enmascaradas (masked-ops.json) contra
// regresiones: que cuadre con config.json (existen), route-catalog.json (las queries
// tienen ruta headless) y sentinels-config.json (las mutations tienen centinela).
// Sin esto, un typo o una op muerta reintroduce el desajuste whitelist ↔ SESSION_SENSITIVE.
const test = require('node:test');
const assert = require('node:assert/strict');

const masked = require('../hash-autopilot/masked-ops.json');
const sentinels = require('../hash-autopilot/sentinels-config.json');
const routeCatalog = require('../hash-autopilot/route-catalog.json');
const config = require('../../remote/config.json');

const cfgQueries = config.steelhead.hashes.queries;
const cfgMutations = config.steelhead.hashes.mutations;

test('masked-ops: estructura básica (queries no vacío, mutations array)', () => {
  assert.ok(Array.isArray(masked.queries) && masked.queries.length > 0);
  assert.ok(Array.isArray(masked.mutations));
});

test('masked-ops: las 5 queries enmascaradas esperadas, sin más ni menos', () => {
  assert.deepEqual([...masked.queries].sort(), [
    'AllCustomers', 'AllSensorDashboards', 'CurrentUser', 'Customer', 'SensorDashboardQuery',
  ]);
});

test('masked-ops: NO incluye la op muerta GetPurchaseOrder ni la validable GetPurchaseOrderDetail', () => {
  // GetPurchaseOrder ya no existe en config (renombrada); GetPurchaseOrderDetail la
  // valida bien el Python (no es session-sensitive) → ninguna debe estar enmascarada.
  assert.ok(!masked.queries.includes('GetPurchaseOrder'));
  assert.ok(!masked.queries.includes('GetPurchaseOrderDetail'));
  assert.ok(!masked.mutations.includes('GetPurchaseOrder'));
});

test('masked-ops: cada query enmascarada EXISTE en config.steelhead.hashes.queries', () => {
  for (const op of masked.queries) {
    assert.ok(Object.prototype.hasOwnProperty.call(cfgQueries, op), `query enmascarada ausente del config: ${op}`);
  }
});

test('masked-ops: cada mutation enmascarada EXISTE en config.steelhead.hashes.mutations', () => {
  for (const op of masked.mutations) {
    assert.ok(Object.prototype.hasOwnProperty.call(cfgMutations, op), `mutation enmascarada ausente del config: ${op}`);
  }
});

test('masked-ops: cada query enmascarada tiene AL MENOS una ruta headless que la captura', () => {
  const covered = new Set();
  for (const r of Object.values(routeCatalog.routes || {})) for (const c of (r.captures || [])) covered.add(c);
  for (const op of masked.queries) {
    assert.ok(covered.has(op), `query enmascarada SIN ruta en route-catalog: ${op} (no se podría recapturar headless)`);
  }
});

test('masked-ops: cada mutation enmascarada tiene un centinela declarado (aunque id:0 = andamiaje)', () => {
  const sentinelOps = new Set();
  for (const e of Object.values(sentinels.entities || {})) {
    for (const op of (e._para || [])) sentinelOps.add(op);
    for (const op of (e.opsGroup || [])) sentinelOps.add(op);
  }
  for (const op of masked.mutations) {
    assert.ok(sentinelOps.has(op), `mutation enmascarada SIN centinela en sentinels-config: ${op}`);
  }
});

test('sentinels-config: SaveManyPartNumberPrices apunta al flujo de cotización (quotePrice), variante única unificada', () => {
  // Steelhead UNIFICÓ las dos variantes de SaveManyPartNumberPrices en un solo hash (72946d4d…,
  // el que quedó vivo; el viejo batch 9da1874e murió). La captura vive en la COTIZACIÓN centinela
  // #288 ("Edit this Part" → "Save Parts" SIN editar → captura-y-aborta), validada end-to-end
  // headless 2026-07-17. El andamiaje del modal individual (partNumberPrice id:0) se RETIRÓ.
  const qp = sentinels.entities.quotePrice;
  assert.ok(qp, 'falta la entidad quotePrice');
  assert.ok((qp._para || []).includes('SaveManyPartNumberPrices'), 'quotePrice debe declarar SaveManyPartNumberPrices');
  assert.equal(qp._estrategia, 'quote-saveparts-abort', 'quotePrice usa la estrategia de cotización (no el modal)');
  assert.ok(qp.id && qp.id !== 0, 'quotePrice debe tener un id de centinela ACTIVO (≠0)');
  // El modal individual quedó retirado (deuda de variante redundante) — NO debe reaparecer.
  assert.equal(sentinels.entities.partNumberPrice, undefined, 'partNumberPrice (modal individual) fue retirado');
});
