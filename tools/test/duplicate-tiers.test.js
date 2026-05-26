// tools/test/duplicate-tiers.test.js
// Carga remote/scripts/duplicate-tiers.js en un vm con stub window y extrae
// window.SADuplicateTiers para testear funciones puras.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'duplicate-tiers.js');

function loadModule() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'duplicate-tiers.js' });
  if (!sandbox.window.SADuplicateTiers) {
    throw new Error('window.SADuplicateTiers no fue exportado');
  }
  return sandbox.window.SADuplicateTiers;
}

test('harness boots and exports SADuplicateTiers', () => {
  const M = loadModule();
  assert.equal(typeof M, 'object');
  assert.equal(typeof M.hardBuckets, 'function');
  assert.equal(typeof M.scoreFor, 'function');
});

module.exports = { loadModule };
