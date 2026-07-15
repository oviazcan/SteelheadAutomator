// tools/test/sentinels-plan.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { planMutationCapture } = require('../hash-autopilot/sentinels.mjs');

const cfg = { entities: { ReceivedOrder: { id: 'RO-1', marker: '__SA_SENTINEL__', baseState: 'archived', module: 'ReceivedOrders' } } };

test('archived-mutate-restore con sentinela declarado → run', () => {
  const r = planMutationCapture('SaveReceivedOrderLinesAndItems', cfg, 'ReceivedOrder');
  assert.equal(r.action, 'run');
  assert.equal(r.strategy, 'archived-mutate-restore');
  assert.equal(r.sentinelId, 'RO-1');
});
test('sin sentinela declarado para la entidad → escalate', () => {
  const r = planMutationCapture('SavePart', cfg, 'Part');
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /sentinela|no declarad/i);
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
