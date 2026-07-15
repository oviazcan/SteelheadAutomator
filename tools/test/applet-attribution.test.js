// tools/test/applet-attribution.test.js
// Núcleo PURO de atribución op→applet para el correo de hash-autopilot.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appletsForOp, annotateOps, formatOpLine } = require('../hash-autopilot/applet-attribution.mjs');

const SOURCES = {
  'bulk-upload': `const h = getHash('SearchUnits'); query("AllCustomers", {});`,
  'unit-autoconvert': `foo('SearchUnits');`,
  'invoice-autofill': `const c = query('Customer', v);`,
  'noise': `// menciona SearchUnits en un comentario pero no entre comillas`,
};

test('appletsForOp: match preciso op citada entre comillas (dobles o simples)', () => {
  assert.deepEqual(appletsForOp('SearchUnits', SOURCES, ''), ['bulk-upload', 'unit-autoconvert']);
});

test('appletsForOp: NO matchea la op mencionada en comentario sin comillas', () => {
  // 'noise' cita SearchUnits sin comillas → no debe contar.
  assert.equal(appletsForOp('SearchUnits', SOURCES, '').includes('noise'), false);
});

test('appletsForOp: resultado ordenado alfabéticamente', () => {
  const r = appletsForOp('SearchUnits', SOURCES, '');
  assert.deepEqual(r, [...r].sort());
});

test('appletsForOp: sin match en scripts → cae al usedBy del config', () => {
  assert.deepEqual(appletsForOp('SensorDashboardQuery', SOURCES, 'sensor-graph-hide-all, sensor-status-autofill'),
    ['sensor-graph-hide-all', 'sensor-status-autofill']);
});

test('appletsForOp: sin match y sin usedBy → []', () => {
  assert.deepEqual(appletsForOp('OpHuérfana', SOURCES, ''), []);
});

test('appletsForOp: op con regex-especiales se escapa (no crashea)', () => {
  assert.deepEqual(appletsForOp('Op.Rara(x)', { a: `'Op.Rara(x)'` }, ''), ['a']);
});

test('appletsForOp: los scripts ganan sobre el usedBy del config', () => {
  // aunque el config declare otra cosa, si el script lo referencia, gana el grep.
  assert.deepEqual(appletsForOp('Customer', SOURCES, 'algo-viejo'), ['invoice-autofill']);
});

test('annotateOps: anota cada op con sus applets vía knownOperations', () => {
  const known = { SensorDashboardQuery: { usedBy: 'sensor-graph-hide-all' } };
  const r = annotateOps(['Customer', 'SensorDashboardQuery'], SOURCES, known);
  assert.deepEqual(r, [
    { op: 'Customer', applets: ['invoice-autofill'] },
    { op: 'SensorDashboardQuery', applets: ['sensor-graph-hide-all'] },
  ]);
});

test('formatOpLine: con applets los enlista', () => {
  assert.equal(formatOpLine('Customer', ['invoice-autofill', 'create-order-autofill']),
    'Customer — applets: invoice-autofill, create-order-autofill');
});

test('formatOpLine: sin applets marca explícita', () => {
  assert.match(formatOpLine('OpHuérfana', []), /ningún applet/);
});
