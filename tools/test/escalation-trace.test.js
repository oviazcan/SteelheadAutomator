// tools/test/escalation-trace.test.js — núcleo puro del trace + gate del Nivel B.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newTrace, addAction, outcomeByOp, summarizeForEmail, shouldRunEscalation } = require('../hash-autopilot/escalation-trace.mjs');

const A = (op, opFired, observed) => ({ op, step: 1, action: 'clickButton', target: 'add invoice', selectorTried: "span[aria-label='Add Invoice']", observed, opFired, screenshot: null });

test('newTrace: estructura base', () => {
  const t = newTrace('2026-07-17');
  assert.equal(t.date, '2026-07-17');
  assert.deepEqual(t.actions, []);
});
test('addAction: agrega inmutable', () => {
  const t0 = newTrace('2026-07-17');
  const t1 = addAction(t0, A('X', false, 'no encontrado'));
  assert.equal(t0.actions.length, 0);
  assert.equal(t1.actions.length, 1);
  assert.equal(t1.actions[0].op, 'X');
});
test('outcomeByOp: reparada si alguna acción disparó la op', () => {
  let t = newTrace('d');
  t = addAction(t, A('X', false, 'falló'));
  t = addAction(t, A('X', true, 'op disparada'));
  t = addAction(t, A('Y', false, 'falló'));
  assert.deepEqual(outcomeByOp(t), { X: 'reparada', Y: 'escalada' });
});
test('summarizeForEmail: incluye op, observación y marca de resultado', () => {
  let t = newTrace('d');
  t = addAction(t, A('X', false, 'la UI cambió el aria-label'));
  t = addAction(t, A('X', true, 'op disparada con el nuevo selector'));
  const s = summarizeForEmail(t);
  assert.match(s, /X/);
  assert.match(s, /la UI cambió el aria-label/);
  assert.match(s, /✓|reparada/i);
});
test('summarizeForEmail: recorta a maxPerOp por op', () => {
  let t = newTrace('d');
  for (let i = 0; i < 12; i++) t = addAction(t, A('X', false, 'intento ' + i));
  const s = summarizeForEmail(t, 3);
  assert.match(s, /\+ 9 más|9 acciones más/);
});

test('gate: sin needs-attention → NO corre', () => {
  assert.equal(shouldRunEscalation(false, false), false);
});
test('gate: con needs-attention y no intentado hoy → corre', () => {
  assert.equal(shouldRunEscalation(true, false), true);
});
test('gate: con needs-attention pero ya intentado hoy → NO corre (idempotente)', () => {
  assert.equal(shouldRunEscalation(true, true), false);
});
