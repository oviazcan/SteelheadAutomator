// tools/test/unit-autoconvert-core.test.js
// Golden tests del módulo puro de conversión de unidades.
// Run: node --test tools/test/unit-autoconvert-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/unit-autoconvert-core.js');

test('computePeers: peso KGM → LBR', () => {
  assert.deepEqual(Core.computePeers('KGM', 2.85), [{ code: 'LBR', value: 6.2832 }]);
});

test('computePeers: peso LBR → KGM (round-trip)', () => {
  assert.deepEqual(Core.computePeers('LBR', 6.2832), [{ code: 'KGM', value: 2.85 }]);
});

test('computePeers: superficie CMK → DMK, FTK (orden DMK luego FTK)', () => {
  assert.deepEqual(Core.computePeers('CMK', 760.48), [
    { code: 'DMK', value: 7.6048 },
    { code: 'FTK', value: 0.8186 },
  ]);
});

test('computePeers: superficie DMK → CMK, FTK', () => {
  assert.deepEqual(Core.computePeers('DMK', 7.6048), [
    { code: 'CMK', value: 760.48 },
    { code: 'FTK', value: 0.8186 },
  ]);
});

test('computePeers: longitud LM → FOT', () => {
  assert.deepEqual(Core.computePeers('LM', 0.38), [{ code: 'FOT', value: 1.2467 }]);
});

test('computePeers: LO no pertenece a ningún grupo → []', () => {
  assert.deepEqual(Core.computePeers('LO', 5), []);
});

test('computePeers: código desconocido → []', () => {
  assert.deepEqual(Core.computePeers('XYZ', 5), []);
});

test('computePeers: valores inválidos → []', () => {
  assert.deepEqual(Core.computePeers('KGM', 0), []);
  assert.deepEqual(Core.computePeers('KGM', -1), []);
  assert.deepEqual(Core.computePeers('KGM', NaN), []);
  assert.deepEqual(Core.computePeers('KGM', Infinity), []);
});

test('round4: redondea a 4 decimales y recorta ceros', () => {
  assert.equal(Core.round4(6.283174), 6.2832);
  assert.equal(Core.round4(2.85), 2.85);
  assert.equal(Core.round4(7.60480000), 7.6048);
});

test('unitCodeFromText: primer token en mayúsculas', () => {
  assert.equal(Core.unitCodeFromText('KGM Kilogramo / Part:'), 'KGM');
  assert.equal(Core.unitCodeFromText('CMK Centímetro Cuadrado'), 'CMK');
  assert.equal(Core.unitCodeFromText('  lbr libra '), 'LBR');
  assert.equal(Core.unitCodeFromText(''), '');
  assert.equal(Core.unitCodeFromText(null), '');
});

test('isReciprocalAdornment: detecta "Parts / X"', () => {
  assert.equal(Core.isReciprocalAdornment('Parts / KGM Kilogramo'), true);
  assert.equal(Core.isReciprocalAdornment('KGM Kilogramo / Parts'), false);
  assert.equal(Core.isReciprocalAdornment(''), false);
});

test('isConvertible: solo unidades del roster', () => {
  assert.equal(Core.isConvertible('DMK'), true);
  assert.equal(Core.isConvertible('KGM'), true);
  assert.equal(Core.isConvertible('LO'), false);
});
