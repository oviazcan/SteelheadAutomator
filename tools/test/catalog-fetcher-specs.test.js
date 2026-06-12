// tools/test/catalog-fetcher-specs.test.js
// Tests del producto cartesiano de specs combinables (espesor/temp/tiempo) del
// catalog-fetcher. Generaliza a cualquier EXTERNAL spec con esos fields (no hardcode);
// hoy solo "Deshidrogenado" trae temp/tiempo, pero el catálogo puede crecer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _comboFieldRank: rank, _buildSpecComboEntries: build, _splitSpecEntry: split } = require('../../remote/scripts/catalog-fetcher.js');

// Helper para construir un spec field como lo devuelve SpecFieldsAndOptions.
const field = (name, params, fieldType) => ({
  specFieldBySpecFieldId: { name, fieldType },
  defaultValues: { nodes: params.map((n, i) => ({ name: n, id: 1000 + i })) },
});

test('comboFieldRank clasifica espesor/temp/tiempo', () => {
  assert.equal(rank('Espesor (µm)'), 0);
  assert.equal(rank('Temperatura'), 1);
  assert.equal(rank('Duración Horneado', 'TIMER'), 2);   // por type
  assert.equal(rank('Tiempo de inmersión'), 2);          // por nombre
  assert.equal(rank('Duración Horneado'), 2);            // "duración"/"horneado" por nombre
  assert.equal(rank('Voltaje'), -1);
  assert.equal(rank('Nivel'), -1);
});

test('Deshidrogenado real: 1 temp × 3 tiempos → 3 entries, orden temp|tiempo', () => {
  const fields = [
    field('Temperatura', ['177 - 205 °C'], 'NUMBER'),
    field('Duración Horneado', ['>= 3 hrs.', '>= 2 hrs.', '>= 1 hrs.'], 'TIMER'),
  ];
  const { entries, truncated } = build('48053-001-01 (Deshidrogenado)', fields);
  assert.equal(truncated, false);
  assert.deepEqual(entries, [
    '48053-001-01 (Deshidrogenado) | 177 - 205 °C | >= 3 hrs.',
    '48053-001-01 (Deshidrogenado) | 177 - 205 °C | >= 2 hrs.',
    '48053-001-01 (Deshidrogenado) | 177 - 205 °C | >= 1 hrs.',
  ]);
});

test('solo espesor (2 params) → 2 entries (comportamiento histórico)', () => {
  const fields = [field('Espesor (µm)', ['5 - 8', '10 - 15'])];
  const { entries } = build('NIQUEL', fields);
  assert.deepEqual(entries, ['NIQUEL | 5 - 8', 'NIQUEL | 10 - 15']);
});

test('sin fields combinables → [] (la spec saldrá bare)', () => {
  const fields = [field('Voltaje', ['3 - 6']), field('Nivel', ['OK'])];
  assert.deepEqual(build('SPEC-X', fields).entries, []);
});

test('espesor × temp × tiempo → producto cartesiano en orden canónico', () => {
  const fields = [
    field('Duración Horneado', ['1 h', '2 h'], 'TIMER'),  // tiempo (rank 2)
    field('Espesor', ['5', '8']),                          // espesor (rank 0)
    field('Temperatura', ['100 °C']),                      // temp (rank 1)
  ];
  const { entries } = build('SP', fields);
  // Orden: espesor | temp | tiempo. 2×1×2 = 4 entries.
  assert.deepEqual(entries, [
    'SP | 5 | 100 °C | 1 h',
    'SP | 5 | 100 °C | 2 h',
    'SP | 8 | 100 °C | 1 h',
    'SP | 8 | 100 °C | 2 h',
  ]);
});

test('field combinable sin params → no rompe (se ignora)', () => {
  const fields = [field('Temperatura', []), field('Espesor', ['5'])];
  assert.deepEqual(build('SP', fields).entries, ['SP | 5']);
});

test('tope COMBO_CAP marca truncated', () => {
  const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
  const fields = [field('Espesor', many), field('Temperatura', many)]; // 900 > cap
  const { entries, truncated } = build('SP', fields, 500);
  assert.equal(truncated, true);
  assert.ok(entries.length <= 500);
});

// Bug real (catálogo 2026-06-12): la hoja Especificaciones destructuraba
// `[specName, paramName] = s.split(' | ')` → tiraba el 3er segmento (tiempo). Las 3
// filas de Deshidrogenado quedaban idénticas y el VBA dedupeaba a 1. splitSpecEntry
// preserva TODO tras el primer ' | '.
test('splitSpecEntry preserva todos los segmentos del param (no pierde el tiempo)', () => {
  assert.deepEqual(
    split('48053-001-01 (Deshidrogenado) | 177 - 205 °C | >= 3 hrs.'),
    { specName: '48053-001-01 (Deshidrogenado)', paramName: '177 - 205 °C | >= 3 hrs.' });
});

test('splitSpecEntry: espesor simple (1 segmento) sigue bien', () => {
  assert.deepEqual(split('NIQUEL | 5 - 8'), { specName: 'NIQUEL', paramName: '5 - 8' });
});

test('splitSpecEntry: spec bare (sin pipe) → paramName null', () => {
  assert.deepEqual(split('SPEC-X'), { specName: 'SPEC-X', paramName: null });
});

test('las 3 entries de Deshidrogenado producen 3 paramName distintos (dropdown no colapsa)', () => {
  const fields = [
    field('Temperatura', ['177 - 205 °C'], 'NUMBER'),
    field('Duración Horneado', ['>= 3 hrs.', '>= 2 hrs.', '>= 1 hrs.'], 'TIMER'),
  ];
  const { entries } = build('48053-001-01 (Deshidrogenado)', fields);
  const dropdown = new Set(entries.map(s => {
    const { specName, paramName } = split(s);
    return `${specName} | ${paramName}`; // como reconstruye el VBA
  }));
  assert.equal(dropdown.size, 3); // antes del fix: 1 (todas iguales tras perder el tiempo)
});
