// tools/test/sentinels-plan.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { planMutationCapture } = require('../hash-autopilot/sentinels.mjs');

const cfg = { entities: { ReceivedOrder: { id: 'RO-1', marker: '__SA_SENTINEL__', baseState: 'archived', module: 'ReceivedOrders' } } };

// Entidades de captura-y-aborta (cero efecto → seguras aun para destructivas / no-auto).
const cfgAbort = { entities: {
  ReportFolder: { id: 'rep-folder', _estrategia: 'capture-abort' },   // DeleteFolderById (destructiva)
  ReportGen: { id: 'rep-gen', _estrategia: 'capture-abort' },         // GenerateDuckDb (prefijo no-auto)
  ReportBad: { _estrategia: 'capture-abort' },                        // sin id → escalate
} };

test('capture-abort: destructiva (Delete…) → run (el abort da cero efecto)', () => {
  const r = planMutationCapture('DeleteFolderById', cfgAbort, 'ReportFolder');
  assert.equal(r.action, 'run');
  assert.equal(r.strategy, 'capture-abort');
  assert.equal(r.sentinelId, 'rep-folder');
});
test('capture-abort: prefijo no-auto (Generate…) → run', () => {
  const r = planMutationCapture('GenerateDuckDb', cfgAbort, 'ReportGen');
  assert.equal(r.action, 'run');
  assert.equal(r.strategy, 'capture-abort');
});
test('capture-abort sin id declarado → escalate (fail-closed)', () => {
  const r = planMutationCapture('DeleteFolderById', cfgAbort, 'ReportBad');
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /capture-abort sin id/i);
});

test('archived-mutate-restore con centinela declarado → run', () => {
  const r = planMutationCapture('SaveReceivedOrderLinesAndItems', cfg, 'ReceivedOrder');
  assert.equal(r.action, 'run');
  assert.equal(r.strategy, 'archived-mutate-restore');
  assert.equal(r.sentinelId, 'RO-1');
});
test('sin centinela declarado para la entidad → escalate', () => {
  const r = planMutationCapture('SavePart', cfg, 'Part');
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /centinela|no declarad/i);
});
test('mutation no-auto (prefijo desconocido) → escalate', () => {
  const r = planMutationCapture('RecomputeX', cfg, 'ReceivedOrder');
  assert.equal(r.action, 'escalate');
});
test('destructiva → escalate en v1 (ephemeral aún no soportado)', () => {
  const r = planMutationCapture('DeletePart', cfg, 'Part');
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /destructiva|ephemeral|efímero/i);
});
