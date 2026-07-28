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

test('buildNeedsAttention: observed lleva la razón REAL del ciclo centinela', () => {
  // El 2026-07-24 SaveManyPartNumberPrices escaló con el genérico de queries aunque el ciclo
  // había abortado por IDENTIDAD → el Nivel B arrancó a re-descubrir la receta en vez de
  // revisar el centinela. La razón del ciclo debe viajar al payload.
  const na = buildNeedsAttention([{ op: 'SaveManyPartNumberPrices' }], {}, 'd', {
    SaveManyPartNumberPrices: 'ciclo centinela abortó: objeto cargado NO es centinela (identidad)',
  });
  assert.match(na.ops[0].observed, /identidad/);
});

test('buildNeedsAttention: sin razón declarada → genérico de siempre (retrocompat)', () => {
  const na = buildNeedsAttention([{ op: 'Otra' }], {}, 'd', { SaveManyPartNumberPrices: 'x' });
  assert.equal(na.ops[0].observed, 'la receta no disparó la op (0 capturas)');
  assert.equal(buildNeedsAttention([{ op: 'Otra' }], {}, 'd').ops[0].observed, 'la receta no disparó la op (0 capturas)');
});
