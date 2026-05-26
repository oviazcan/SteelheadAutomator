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

const NON_FINISH = ['SMY', 'STX', 'SXC', 'SRG', 'SCM', 'SQR', 'SQ2', 'NP desconocido', 'En desarrollo', 'Muestras', 'Lote', 'Obsoleto'];

test('isNonFinishLabel: matchea exact case-sensitive', () => {
  const M = loadModule();
  assert.equal(M.isNonFinishLabel('SMY', NON_FINISH), true);
  assert.equal(M.isNonFinishLabel('NP desconocido', NON_FINISH), true);
  assert.equal(M.isNonFinishLabel('NIQ', NON_FINISH), false);
  assert.equal(M.isNonFinishLabel('smy', NON_FINISH), false); // case-sensitive
  assert.equal(M.isNonFinishLabel('', NON_FINISH), false);
  assert.equal(M.isNonFinishLabel(null, NON_FINISH), false);
  assert.equal(M.isNonFinishLabel(undefined, NON_FINISH), false);
});

test('canonicalFinishings: filtra nonFinish, deduplica, ordena ASC, joinea con |', () => {
  const M = loadModule();
  assert.equal(M.canonicalFinishings(['NIQ', 'EST', 'SMY'], NON_FINISH), 'EST|NIQ');
  assert.equal(M.canonicalFinishings(['SMY', 'STX'], NON_FINISH), ''); // todos nonFinish
  assert.equal(M.canonicalFinishings([], NON_FINISH), '');
  assert.equal(M.canonicalFinishings(['CROMADO'], NON_FINISH), 'CROMADO');
  assert.equal(M.canonicalFinishings(['NIQ', 'NIQ', 'EST'], NON_FINISH), 'EST|NIQ'); // dedup
  assert.equal(M.canonicalFinishings(['NIQ', null, '', 'EST'], NON_FINISH), 'EST|NIQ');
});

const METAL_EQUIV = [
  ['Estaño', 'Estaño s/Aluminio', 'Estaño s/Cobre'],
  ['Plata', 'Plata Flash'],
];

test('canonicalMetal: colapsa equivalentes al primero del grupo', () => {
  const M = loadModule();
  assert.equal(M.canonicalMetal('Estaño s/Aluminio', METAL_EQUIV), 'Estaño');
  assert.equal(M.canonicalMetal('Estaño s/Cobre', METAL_EQUIV), 'Estaño');
  assert.equal(M.canonicalMetal('Plata Flash', METAL_EQUIV), 'Plata');
  assert.equal(M.canonicalMetal('Cobre', METAL_EQUIV), 'Cobre'); // no en ningún grupo
  assert.equal(M.canonicalMetal('', METAL_EQUIV), '');
  assert.equal(M.canonicalMetal(null, METAL_EQUIV), '');
  assert.equal(M.canonicalMetal('Estaño', []), 'Estaño'); // sin equivalents
});

module.exports = { loadModule };
