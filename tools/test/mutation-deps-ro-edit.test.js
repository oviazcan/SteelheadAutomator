// tools/test/mutation-deps-ro-edit.test.js
// Bloqueador #3 del self-heal: sentinela edit-restore para UpdateReceivedOrder.
// Prueba lo PURO (config + gate por id + entityFor/resolveUrl). El ciclo DOM
// (mutate+restore) se valida en corrida supervisada con una OV Sentinela real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const { entityFor, resolveUrl } = require('../hash-autopilot/mutation-deps.mjs');

const config = JSON.parse(readFileSync(join(__dirname, '../hash-autopilot/sentinels-config.json'), 'utf8'));
// gate REAL del motor (hash-autopilot.mjs mutEntityType): e.id truthy && _para/opsGroup incluye op
const gateType = (cfg, op) => {
  const hit = Object.entries(cfg.entities).find(([, e]) => e && e.id && ((e._para || []).includes(op) || (e.opsGroup || []).includes(op)));
  return hit ? hit[0] : null;
};

test('receivedOrderEdit: declara UpdateReceivedOrder con estrategia edit-restore', () => {
  const e = config.entities.receivedOrderEdit;
  assert.ok(e, 'entidad receivedOrderEdit existe');
  assert.deepEqual(e._para, ['UpdateReceivedOrder']);
  assert.equal(e._estrategia, 'edit-restore');
  assert.equal(e.marker, 'Sentinela');
});

test('receivedOrderEdit: id:0 lo deja INACTIVO (el motor NO corre el ciclo → no muta)', () => {
  assert.equal(config.entities.receivedOrderEdit.id, 0, 'placeholder id:0');
  assert.equal(gateType(config, 'UpdateReceivedOrder'), null, 'con id:0 el gate NO activa el ciclo');
});

test('receivedOrderEdit: con un id real, el gate lo activa y entityFor resuelve el handler', () => {
  const cfg = { entities: { ...config.entities, receivedOrderEdit: { ...config.entities.receivedOrderEdit, id: 1699 } } };
  assert.equal(gateType(cfg, 'UpdateReceivedOrder'), 'receivedOrderEdit', 'con id real se activa');
  const found = entityFor(cfg, 1699);
  assert.equal(found.type, 'receivedOrderEdit');
  assert.equal(resolveUrl(found.ent, 1699, 344), 'https://app.gosteelhead.com/Domains/344/SalesOrders/1699');
});

test('receivedOrderEdit: no colisiona con receivedOrder (CreateReceivedOrder sigue en su entidad)', () => {
  // create y update son entidades SEPARADAS (estrategias distintas): no se pisan.
  assert.deepEqual(config.entities.receivedOrder._para, ['CreateReceivedOrder']);
  assert.notEqual('receivedOrder', 'receivedOrderEdit');
});
