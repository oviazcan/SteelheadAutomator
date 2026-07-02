// tools/test/pn-lifecycle.test.js
const test = require('node:test');
const assert = require('node:assert');
const { slimPN } = require('../../remote/scripts/pn-lifecycle-core.js');

const NODE = {
  id: 5, name: 'ABC-1', createdAt: '2026-01-02T00:00:00Z',
  customerByCustomerId: { id: 9, name: 'Fisher' },
  customInputs: { DatosAdicionalesNP: { BaseMetal: 'Cobre', QuoteIBMS: '558' } },
  processNodeByDefaultProcessNodeId: { id: 7, name: 'T204 (EST)' },
  partNumberLabelsByPartNumberId: { nodes: [ { labelByLabelId: { id: 3, name: 'Plata' } } ] },
  acctPnDimensionValueSelectionsByPartNumberId: { nodes: [
    { dimensionId: 349, acctDimensionCustomValueByDimensionCustomValueId: { value: 'L1' } },
    { dimensionId: 586, acctDimensionCustomValueByDimensionCustomValueId: { value: 'D3' } },
  ] },
};
test('slimPN extrae campos enriquecidos', () => {
  const s = slimPN(NODE, true);
  assert.equal(s.id, 5);
  assert.equal(s.customer.name, 'Fisher');
  assert.equal(s.metal, 'Cobre');
  assert.equal(s.quoteIBMS, '558');
  assert.equal(s.proceso, 'T204 (EST)');
  assert.deepEqual(s.labels, [{ id: 3, name: 'Plata' }]);
  assert.equal(s.linea, 'L1');
  assert.equal(s.departamento, 'D3');
  assert.equal(s.archived, true);
});
test('slimPN tolera nodo vacío', () => {
  const s = slimPN({ id: 1, name: 'X' }, false);
  assert.equal(s.metal, ''); assert.equal(s.proceso, ''); assert.deepEqual(s.labels, []);
  assert.equal(s.linea, ''); assert.equal(s.archived, false);
});
