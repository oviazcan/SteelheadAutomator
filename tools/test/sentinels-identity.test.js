// tools/test/sentinels-identity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSentinel, strategyFor, SENTINEL_MARKER } = require('../hash-autopilot/sentinels.mjs');

test('isSentinel: marca en name → true', () => {
  assert.equal(isSentinel({ name: `ZZZ ${SENTINEL_MARKER} no-tocar` }), true);
});
test('isSentinel: marca en tags → true', () => {
  assert.equal(isSentinel({ tags: ['x', SENTINEL_MARKER] }), true);
});
test('isSentinel: marca en customInputs anidado → true', () => {
  assert.equal(isSentinel({ customInputs: { Datos: { nota: `sentinela ${SENTINEL_MARKER}` } } }), true);
});
test('isSentinel: sin marca → false (fail-closed)', () => {
  assert.equal(isSentinel({ name: 'Cliente Real S.A.' }), false);
  assert.equal(isSentinel({}), false);
  assert.equal(isSentinel(null), false);
});
test('isSentinel: reconoce la palabra "Sentinela" en el nombre (marcador del usuario)', () => {
  assert.equal(isSentinel({ name: 'PN Sentinela QA' }), true);
  assert.equal(isSentinel({ name: 'sentinela' }), true);              // case-insensitive
  assert.equal(isSentinel({ name: 'Nodo Sentinela archivado' }), true);
  assert.equal(isSentinel({ name: 'Cliente Real 123' }), false);      // sigue fail-closed
});

test('strategyFor: Delete/Remove → ephemeral', () => {
  assert.equal(strategyFor('DeletePartNumber'), 'ephemeral-create-destroy');
  assert.equal(strategyFor('RemoveLabelUser'), 'ephemeral-create-destroy');
});
test('strategyFor: Save/Update/Archive/Set/Create → archived-mutate-restore', () => {
  for (const op of ['SaveQuoteLines', 'UpdateStationInputs', 'ArchiveInventoryBatchStatus', 'SetX', 'CreateReceivedOrder']) {
    assert.equal(strategyFor(op), 'archived-mutate-restore');
  }
});
test('strategyFor: prefijo desconocido → no-auto (escala)', () => {
  assert.equal(strategyFor('RecomputeSomething'), 'no-auto');
});
