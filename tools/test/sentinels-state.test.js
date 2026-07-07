// tools/test/sentinels-state.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { cycleNext } = require('../hash-autopilot/sentinels.mjs');

test('cycleNext: ciclo feliz base→dirty→restoring→base', () => {
  assert.equal(cycleNext('base', 'open'), 'dirty');
  assert.equal(cycleNext('dirty', 'restore'), 'restoring');
  assert.equal(cycleNext('restoring', 'restored'), 'base');
});

test('cycleNext: error desde cualquier estado → failed', () => {
  assert.equal(cycleNext('dirty', 'error'), 'failed');
  assert.equal(cycleNext('restoring', 'error'), 'failed');
});

test('cycleNext: transición inválida lanza (fail-closed, no inventa estado)', () => {
  assert.throws(() => cycleNext('base', 'restore'), /transición inválida/);
  assert.throws(() => cycleNext('failed', 'open'), /transición inválida/);
});
