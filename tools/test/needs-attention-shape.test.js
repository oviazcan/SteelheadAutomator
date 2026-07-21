// tools/test/needs-attention-shape.test.js — payload enriquecido de needs-attention (Nivel B).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNeedsAttention } = require('../hash-autopilot/hash-autopilot-core.mjs');

test('buildNeedsAttention: incluye module + captures + steps de la receta vieja', () => {
  const recipes = { 'invoices-x': { module: 'Invoices', steps: [{ goto: '/x' }], captures: ['GetReceivedOrdersWithReceivedOrderLineItems'] } };
  const na = buildNeedsAttention([{ op: 'GetReceivedOrdersWithReceivedOrderLineItems' }], recipes, '2026-07-17');
  assert.equal(na.date, '2026-07-17');
  assert.equal(na.ops[0].op, 'GetReceivedOrdersWithReceivedOrderLineItems');
  assert.equal(na.ops[0].recipeTried, 'invoices-x');
  assert.equal(na.ops[0].module, 'Invoices');
  assert.deepEqual(na.ops[0].steps, [{ goto: '/x' }]);
  assert.deepEqual(na.ops[0].captures, ['GetReceivedOrdersWithReceivedOrderLineItems']);
});
test('buildNeedsAttention: op sin receta → recipeTried null, steps null', () => {
  const na = buildNeedsAttention([{ op: 'Nueva' }], {}, 'd');
  assert.equal(na.ops[0].recipeTried, null);
  assert.equal(na.ops[0].steps, null);
});
