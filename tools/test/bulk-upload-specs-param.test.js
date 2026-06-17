// tools/test/bulk-upload-specs-param.test.js
// Tests de pickSpecParamId — selección del defaultParamId de un spec field por
// match-POR-VALOR contra los segmentos del CSV (espesor/temp/tiempo combinados).
// Arregla el bug donde un field con >1 param que no era espesor caía a params[0]
// (ignorando, p.ej., la "Duración Horneado" elegida).

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSpecParamId } = require('../../remote/scripts/bulk-upload-parse.js');

const P = (...names) => names.map((n, i) => ({ name: n, id: 10 + i }));
const segsOf = (csParam) => csParam.split(' | ').map(s => s.trim()).filter(Boolean);

test('field de 1 param se auto-selecciona', () => {
  assert.deepEqual(pickSpecParamId(P('177 - 205 °C'), segsOf('177 - 205 °C | >= 2 hrs.'), false), { id: 10, espesorMiss: false });
});

test('field con varios params toma el segmento que coincide (Duración Horneado)', () => {
  const params = P('>= 3 hrs.', '>= 2 hrs.', '>= 1 hrs.'); // ids 10,11,12
  const got = pickSpecParamId(params, segsOf('177 - 205 °C | >= 1 hrs.'), false);
  assert.deepEqual(got, { id: 12, espesorMiss: false }); // ">= 1 hrs." → id 12
});

test('espesor v10/v11 (1 segmento) sigue matcheando', () => {
  const params = P('5 - 8', '10 - 15'); // ids 10,11
  assert.deepEqual(pickSpecParamId(params, segsOf('10 - 15'), true), { id: 11, espesorMiss: false });
});

test('espesor sin match → params[0] + espesorMiss=true', () => {
  const params = P('5 - 8', '10 - 15');
  assert.deepEqual(pickSpecParamId(params, segsOf('99 - 99'), true), { id: 10, espesorMiss: true });
});

test('no-espesor sin match → params[0] silencioso (sin error)', () => {
  const params = P('A', 'B', 'C');
  assert.deepEqual(pickSpecParamId(params, segsOf('Z'), false), { id: 10, espesorMiss: false });
});

test('params vacío → id null', () => {
  assert.deepEqual(pickSpecParamId([], ['x'], false), { id: null, espesorMiss: false });
});

test('el orden de los pipes no importa (match por valor)', () => {
  // mismo resultado si el tiempo viene antes que la temp en cs.param
  const params = P('>= 3 hrs.', '>= 2 hrs.');
  assert.equal(pickSpecParamId(params, segsOf('>= 2 hrs. | 177 - 205 °C'), false).id, 11);
  assert.equal(pickSpecParamId(params, segsOf('177 - 205 °C | >= 2 hrs.'), false).id, 11);
});
