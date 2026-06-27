// Golden tests del módulo puro surtido-guard-core.js
// Run: node --test tools/test/surtido-guard-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// El core se publica como IIFE sobre window; para test en node lo cargamos con un shim.
global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'surtido-guard-core.js'));
const Core = global.window.SurtidoGuardCore;

test('shouldBlockMove: no bloquea si enforcement está OFF', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false, woId: 1 }, { enforcementEnabled: false });
  assert.deepStrictEqual(r, { block: false, reason: 'disabled' });
});

test('shouldBlockMove: FAIL-SAFE no bloquea si la WO no está en el mapa', () => {
  const r = Core.shouldBlockMove({ found: false }, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'unknown-failsafe');
});

test('shouldBlockMove: no bloquea WO programada', () => {
  const r = Core.shouldBlockMove({ found: true, programada: true, woId: 7 }, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'scheduled');
});

test('shouldBlockMove: bloquea WO no programada', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false, woId: 9 }, { enforcementEnabled: true });
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.reason, 'not-scheduled');
});

test('shouldBlockMove: opts ausente => disabled (no truena)', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false });
  assert.deepStrictEqual(r, { block: false, reason: 'disabled' });
});
