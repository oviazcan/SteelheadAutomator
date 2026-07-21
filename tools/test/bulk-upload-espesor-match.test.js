// tools/test/bulk-upload-espesor-match.test.js
// pickSpecParamPositional — tolerancia de matching contra el catálogo de SH.
//
// Incidente carga 20 831 NP (2026-07-15): 254 de 410 params de Espesor no se aplicaron
// porque el matcher comparaba con `p.name === s` (exacto). Confirmado contra el catálogo
// EN VIVO de SH:
//   · BURNDY DI-EI-01/81 guarda el parámetro como " 8 - 12 µm" (ESPACIO INICIAL) → el CSV
//     manda "8 - 12 µm" y falla el ===. (196 casos) → se arregla trimeando AMBOS lados.
//   · ASTM B545 guarda "5.0 - 8.0 µm" y el CSV manda "5 - 8 µm" → mismos números, distinto
//     formato. (58 casos) → fallback numérico con salvaguarda de match único.
// Los rangos que GENUINAMENTE no existen en el catálogo siguen dando unmatched (datos).

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSpecParamPositional } = require('../../remote/scripts/bulk-upload-parse.js');

const P = (...names) => names.map((n, i) => ({ name: n, id: 10 + i }));

test('TRIM: catálogo con espacio inicial (" 8 - 12 µm") matchea el CSV "8 - 12 µm"', () => {
  const got = pickSpecParamPositional(P(' 8 - 12 µm', '5 - 8 µm', '5 - 12 µm'), '8 - 12 µm');
  assert.deepEqual(got, { id: 10, unmatched: false });
});

test('NUMERIC: catálogo "5.0 - 8.0 µm" matchea el CSV "5 - 8 µm" (mismos números)', () => {
  const got = pickSpecParamPositional(P('5.0 - 8.0 µm', '8 - 15 µm', '15 - 30 µm'), '5 - 8 µm');
  assert.deepEqual(got, { id: 10, unmatched: false });
});

test('NUMERIC salvaguarda: dos params colapsan al mismo número → NO elegir (unmatched)', () => {
  // "5.0 - 8.0" y "5.00 - 8.00" ambos ≡ 5|8 numéricamente y ninguno matchea exacto/trim
  const got = pickSpecParamPositional(P('5.0 - 8.0 µm', '5.00 - 8.00 µm'), '5 - 8 µm');
  assert.deepEqual(got, { id: null, unmatched: true });
});

test('NUMERIC no cruza unidades: "5 - 8 µm" NO matchea "5 - 8 mils"', () => {
  const got = pickSpecParamPositional(P('5 - 8 mils', '10 - 20 µm'), '5 - 8 µm');
  assert.deepEqual(got, { id: null, unmatched: true });
});

test('NUMERIC respeta el orden: "5 - 8" NO matchea "8 - 5"', () => {
  const got = pickSpecParamPositional(P('8 - 5 µm', '10 - 20 µm'), '5 - 8 µm');
  assert.deepEqual(got, { id: null, unmatched: true });
});

// --- No-regresión ---
test('no-reg: match exacto sigue ganando', () => {
  assert.deepEqual(pickSpecParamPositional(P('5 - 8 µm', '10 - 12 µm'), '5 - 8 µm'), { id: 10, unmatched: false });
});

test('no-reg: 1 solo param se auto-selecciona aunque no matchee', () => {
  assert.deepEqual(pickSpecParamPositional(P('lo que sea'), 'otra cosa'), { id: 10, unmatched: false });
});

test('no-reg: DATOS reales (rango inexistente) siguen dando unmatched', () => {
  // "3 - 8 µm" no existe (ni trim ni numérico) entre "3 - 5" y "8 - 12"
  assert.deepEqual(pickSpecParamPositional(P('3 - 5 µm', '8 - 12 µm'), '3 - 8 µm'), { id: null, unmatched: true });
});

test('no-reg: seg vacío → {id:null, unmatched:false}', () => {
  assert.deepEqual(pickSpecParamPositional(P('a', 'b'), ''), { id: null, unmatched: false });
});
