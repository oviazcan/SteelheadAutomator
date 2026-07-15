// tools/test/mutation-runner-guards.test.js
// Guardias del ciclo sentinela, con page/sink/deps mockeados (sin navegador real).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runMutationCycle } = require('../hash-autopilot/mutation-runner.mjs');

const cfg = { entities: { ReceivedOrder: { id: 'RO-1', marker: '__SA_SENTINEL__', baseState: 'archived' } } };
const route = { captures: ['SaveReceivedOrderLinesAndItems'], sentinel: { entityType: 'ReceivedOrder', strategy: 'archived-mutate-restore', mutateStep: {}, restoreStep: {} }, steps: [] };

function fakePage() { return { goto: async () => {}, evaluate: async () => {}, waitForTimeout: async () => {} }; }

test('escala destructiva sin tocar nada', async () => {
  const r = await runMutationCycle(fakePage(), { ...route, captures: ['DeleteReceivedOrder'] }, cfg, { hashes: {} }, {
    loadObject: async () => { throw new Error('no debió cargar'); }, readJournal: () => ({}), writeJournal: () => {},
  });
  assert.equal(r.captured, false);
  assert.equal(r.escalated, true);
});

test('aborta y NO muta NI restaura si el objeto cargado no es sentinela (fail-closed)', async () => {
  let mutated = false, restored = false;
  const r = await runMutationCycle(fakePage(), route, cfg, { hashes: {} }, {
    loadObject: async () => ({ name: 'OV Real de Cliente' }), // sin marca
    readJournal: () => ({}), writeJournal: () => {},
    doMutate: async () => { mutated = true; },
    doRestore: async () => { restored = true; },
  });
  assert.equal(mutated, false);
  // un restore que MUTA (p.ej. receivedOrderEdit hace SAVE) NUNCA debe correr sobre un
  // objeto NO verificado como sentinela — si no, el fail-closed del mutate sería inútil.
  assert.equal(restored, false, 'no restaurar objetos no verificados como sentinela');
  assert.equal(r.captured, false);
  assert.match(r.reason, /no.*sentinela|identidad/i);
});

test('captura el hash cuando el objeto ES sentinela y la mutación se dispara', async () => {
  const sink = { hashes: {} };
  const r = await runMutationCycle(fakePage(), route, cfg, sink, {
    loadObject: async () => ({ name: `OV __SA_SENTINEL__ no-tocar` }),
    readJournal: () => ({}), writeJournal: () => {},
    doMutate: async () => { sink.hashes['SaveReceivedOrderLinesAndItems'] = 'newhash123'; },
    doRestore: async () => {},
  });
  assert.equal(r.captured, true);
  assert.equal(r.hash, 'newhash123');
});

test('restaura (finally) si verificó identidad, aunque la captura falle', async () => {
  let restored = false;
  await runMutationCycle(fakePage(), route, cfg, { hashes: {} }, {
    loadObject: async () => ({ name: `OV __SA_SENTINEL__` }), // ES sentinela → verified
    readJournal: () => ({}), writeJournal: () => {},
    doMutate: async () => { throw new Error('mutación falló'); },
    doRestore: async () => { restored = true; },
  }).catch(() => {});
  assert.equal(restored, true);
});
