// tools/test/sentinels-journal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { journalOpen, journalClose, pendingRepairs } = require('../hash-autopilot/sentinels.mjs');

test('journalOpen marca dirty; journalClose lo limpia', () => {
  let j = {};
  j = journalOpen(j, 'ReceivedOrder', 'RO-SENT-1', 'SaveReceivedOrderLinesAndItems', 1000);
  assert.equal(j.ReceivedOrder.state, 'dirty');
  assert.equal(j.ReceivedOrder.sentinelId, 'RO-SENT-1');
  j = journalClose(j, 'ReceivedOrder');
  assert.equal(j.ReceivedOrder, undefined);
});

test('journalOpen sobre entidad ya dirty lanza (no ciclos concurrentes)', () => {
  const j = journalOpen({}, 'Part', 'P-SENT', 'UpdatePart', 1);
  assert.throws(() => journalOpen(j, 'Part', 'P-SENT', 'UpdatePart', 2), /ya.*dirty|en curso|dirty/i);
});

test('pendingRepairs lista las entradas sucias, ordenadas y sin las limpias', () => {
  let j = {};
  j = journalOpen(j, 'Zebra', 'Z1', 'SaveZ', 1);
  j = journalOpen(j, 'Alpha', 'A1', 'SaveA', 2);
  const rep = pendingRepairs(j);
  assert.deepEqual(rep.map((r) => r.entityType), ['Alpha', 'Zebra']); // ordenado
  assert.deepEqual(rep.map((r) => r.op), ['SaveA', 'SaveZ']);
});

test('pendingRepairs: journal vacío → []', () => {
  assert.deepEqual(pendingRepairs({}), []);
});
