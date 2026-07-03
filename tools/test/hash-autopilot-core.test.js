// tools/test/hash-autopilot-core.test.js
// Núcleo PURO de hash-autopilot: clasificación de veredictos, shape check,
// decisión de deploy con freno de masa, y cobertura de recetas. Sin Playwright,
// sin red — todo testeable con node:test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOp, hasShape } = require('../hash-autopilot/hash-autopilot-core.mjs');

test('classifyOp: capturado igual al config → vigente', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'aaa', http: 200, shapeOk: true }), 'vigente');
});
test('classifyOp: distinto + 200 + shape ok → rotadoValidado', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 200, shapeOk: true }), 'rotadoValidado');
});
test('classifyOp: distinto pero http 400 → sospechoso (no se deploya)', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 400, shapeOk: false }), 'sospechoso');
});
test('classifyOp: distinto + 200 pero sin shape → sospechoso', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 200, shapeOk: false }), 'sospechoso');
});
test('classifyOp: no capturado (liveHash null) → noCapturado', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: null, http: null, shapeOk: false }), 'noCapturado');
});

test('hasShape: todas las llaves presentes → true', () => {
  assert.equal(hasShape({ pagedData: { nodes: [], totalCount: 3 } }, ['pagedData.nodes', 'pagedData.totalCount']), true);
});
test('hasShape: llave ausente → false', () => {
  assert.equal(hasShape({ pagedData: {} }, ['pagedData.nodes']), false);
});
test('hasShape: paths vacío → true (op sin shape declarado)', () => {
  assert.equal(hasShape({ anything: 1 }, []), true);
});
