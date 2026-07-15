// tools/test/masked-ops-coherence.test.js
// Blinda la FUENTE ÚNICA DE VERDAD de ops enmascaradas (masked-ops.json) contra
// regresiones: que cuadre con config.json (existen), route-catalog.json (las queries
// tienen ruta headless) y sentinels-config.json (las mutations tienen sentinela).
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

test('masked-ops: cada mutation enmascarada tiene un sentinela declarado (aunque id:0 = andamiaje)', () => {
  const sentinelOps = new Set();
  for (const e of Object.values(sentinels.entities || {})) {
    for (const op of (e._para || [])) sentinelOps.add(op);
    for (const op of (e.opsGroup || [])) sentinelOps.add(op);
  }
  for (const op of masked.mutations) {
    assert.ok(sentinelOps.has(op), `mutation enmascarada SIN sentinela en sentinels-config: ${op}`);
  }
});

test('sentinels-config: SaveManyPartNumberPrices andamiado (id:0, inactivo hasta afinar el selector del botón)', () => {
  const e = sentinels.entities.partNumberPrice;
  assert.ok(e, 'falta la entidad partNumberPrice');
  assert.equal(e.id, 0, 'partNumberPrice queda INACTIVO (id:0) hasta fijar el selector del botón de precio');
  assert.ok((e._para || []).includes('SaveManyPartNumberPrices'));
});
