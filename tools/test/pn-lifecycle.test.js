// tools/test/pn-lifecycle.test.js
const test = require('node:test');
const assert = require('node:assert');
const { slimPN, applyFilters, discoverFacets } = require('../../remote/scripts/pn-lifecycle-core.js');

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

const P = [
  { id:1, name:'A', customer:{id:9,name:'Fisher'}, labels:[{id:3,name:'Plata'}], metal:'Cobre', proceso:'T204', linea:'L1', departamento:'D3', createdAt:'2026-01-01T00:00:00Z' },
  { id:2, name:'B', customer:{id:8,name:'Hubbell'}, labels:[{id:4,name:'Zinc'}], metal:'Acero', proceso:'T106', linea:'L2', departamento:'D3', createdAt:'2026-03-01T00:00:00Z' },
  { id:3, name:'C', customer:{id:9,name:'Fisher'}, labels:[{id:3,name:'Plata'},{id:5,name:'Decapado'}], metal:'Cobre', proceso:'T204', linea:'L1', departamento:'D9', createdAt:'2026-05-01T00:00:00Z' },
];
test('applyFilters: cliente', () => {
  assert.deepEqual(applyFilters(P, { customers:[9] }).map(x=>x.id), [1,3]);
});
test('applyFilters: proceso + metal (AND entre criterios)', () => {
  assert.deepEqual(applyFilters(P, { procesos:['T204'], metals:['Cobre'] }).map(x=>x.id), [1,3]);
});
test('applyFilters: etiquetas AND vs OR', () => {
  assert.deepEqual(applyFilters(P, { labels:{names:['Plata','Decapado'],mode:'AND'} }).map(x=>x.id), [3]);
  assert.deepEqual(applyFilters(P, { labels:{names:['Plata','Zinc'],mode:'OR'} }).map(x=>x.id), [1,2,3]);
});
test('applyFilters: fecha before', () => {
  assert.deepEqual(applyFilters(P, { dateFilter:{cutoffISO:'2026-02-01T00:00:00Z',direction:'before'} }).map(x=>x.id), [1]);
});
test('applyFilters: sin criterios = todos', () => {
  assert.equal(applyFilters(P, {}).length, 3);
});
test('discoverFacets: conteos por cliente y proceso', () => {
  const f = discoverFacets(P);
  assert.deepEqual(f.customers.find(c=>c.name==='Fisher'), {name:'Fisher',count:2});
  assert.equal(f.procesos.length, 2);
});
