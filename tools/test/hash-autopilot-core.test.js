// tools/test/hash-autopilot-core.test.js
// Núcleo PURO de hash-autopilot: clasificación de veredictos, shape check,
// decisión de deploy con freno de masa, y cobertura de recetas. Sin Playwright,
// sin red — todo testeable con node:test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOp, hasShape, planDeploy, missingCoverage } = require('../hash-autopilot/hash-autopilot-core.mjs');

const R = (op, verdict) => ({ op, verdict, cfgHash: 'old', liveHash: verdict === 'vigente' ? 'old' : 'new' });

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

test('planDeploy: solo rotadoValidado va a toDeploy', () => {
  const res = [R('A', 'rotadoValidado'), R('B', 'vigente'), R('C', 'sospechoso'), R('D', 'noCapturado')];
  const p = planDeploy(res, {});
  assert.deepEqual(p.toDeploy.map((x) => x.op), ['A']);
  assert.deepEqual(p.suspicious.map((x) => x.op), ['C']);
  assert.deepEqual(p.notCaptured.map((x) => x.op), ['D']);
  assert.equal(p.massBrake, false);
});
test('planDeploy: >6 rotados dispara freno de masa (no deploya nada)', () => {
  const res = Array.from({ length: 7 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, true);
  assert.deepEqual(p.toDeploy, []);
  assert.match(p.reason, />6|freno|masa/i);
});
test('planDeploy: exactamente 6 rotados NO dispara freno', () => {
  const res = Array.from({ length: 6 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, false);
  assert.equal(p.toDeploy.length, 6);
});

test('missingCoverage: detecta ops target sin receta', () => {
  const recipes = { r1: { captures: ['AllCustomers'] }, r2: { captures: ['Customer'] } };
  const target = ['AllCustomers', 'Customer', 'CurrentUser'];
  assert.deepEqual(missingCoverage(recipes, target), ['CurrentUser']);
});
test('missingCoverage: todo cubierto → []', () => {
  const recipes = { r1: { captures: ['A', 'B'] } };
  assert.deepEqual(missingCoverage(recipes, ['A', 'B']), []);
});
