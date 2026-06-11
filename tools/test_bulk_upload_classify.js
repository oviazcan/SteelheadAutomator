// Golden tests de bulk-upload-classify.js — congelan equivalencias, matching y
// dedup ANTES de refactorizar el pipeline. Correr: node --test
//
// classifyOnePN puede invocar window.SteelheadBulkCC.decideBlankAcabados cuando el
// CSV no trae acabados (invariante #7); por eso exponemos cc.js en global.window.
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.window.SteelheadBulkCC = require('../remote/scripts/bulk-upload-cc.js');

const C = require('../remote/scripts/bulk-upload-classify.js');

test('normLabel: trim + upper, null/undefined -> ""', () => {
  assert.strictEqual(C.normLabel('  estaño '), 'ESTAÑO');
  assert.strictEqual(C.normLabel(null), '');
  assert.strictEqual(C.normLabel(undefined), '');
});

test('buildEquivIndex + equivalentValues: metales equivalentes (invariante bloque)', () => {
  const idx = C.buildEquivIndex([['Estaño', 'Estaño s/Aluminio', 'Estaño s/Cobre'], ['Plata', 'Plata Flash']]);
  assert.strictEqual(C.equivalentValues(idx, 'Estaño', 'Estaño s/Cobre'), true);
  assert.strictEqual(C.equivalentValues(idx, 'estaño', 'ESTAÑO'), true);   // normaliza
  assert.strictEqual(C.equivalentValues(idx, 'Plata', 'Plata Flash'), true);
  assert.strictEqual(C.equivalentValues(idx, 'Estaño', 'Plata'), false);   // grupos distintos
  assert.strictEqual(C.equivalentValues(idx, 'XYZ', 'ABC'), false);        // fuera de grupos
});

test('isNonFinishLabel: etiquetas no-acabado del config', () => {
  const nf = ['SMY', 'En desarrollo', 'Muestras'];
  assert.strictEqual(C.isNonFinishLabel('SMY', nf), true);
  assert.strictEqual(C.isNonFinishLabel('smy', nf), true);
  assert.strictEqual(C.isNonFinishLabel('Estaño', nf), false);
  assert.strictEqual(C.isNonFinishLabel('', nf), false);
  assert.strictEqual(C.isNonFinishLabel(null, nf), false);
});

test('acabadosOrdenados: filtra no-acabado, dedup, ordena alfabético', () => {
  assert.strictEqual(C.acabadosOrdenados(['Zinc', 'Estaño', 'Zinc'], []), 'ESTAÑO|ZINC');
  assert.strictEqual(C.acabadosOrdenados(['Estaño', 'SMY'], ['SMY']), 'ESTAÑO');
  assert.strictEqual(C.acabadosOrdenados([], []), '');
});

test('acabadosCanonicos: colapsa equivalentes al mismo token (invariante bloque)', () => {
  const idx = C.buildEquivIndex([['Estaño', 'Estaño s/Aluminio']]);
  const a = C.acabadosCanonicos(['Estaño'], [], idx);
  const b = C.acabadosCanonicos(['Estaño s/Aluminio'], [], idx);
  assert.strictEqual(a, b); // mismo token canónico __G0
  // sin equivIndex se comporta como acabadosOrdenados (exacto)
  assert.notStrictEqual(C.acabadosCanonicos(['Estaño'], [], new Map()), C.acabadosCanonicos(['Estaño s/Aluminio'], [], new Map()));
});

test('metalCanonico: grupo -> __M<id>, sin grupo -> normalizado', () => {
  const idx = C.buildEquivIndex([['Estaño', 'Estaño s/Aluminio']]);
  assert.strictEqual(C.metalCanonico('Estaño', idx), C.metalCanonico('Estaño s/Aluminio', idx));
  assert.strictEqual(C.metalCanonico('Cobre', idx), 'COBRE');
  assert.strictEqual(C.metalCanonico('', idx), '');
});

test('chunkParts: trocea respetando tamaño; bordes', () => {
  assert.deepStrictEqual(C.chunkParts([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(C.chunkParts([], 2), []);
  assert.deepStrictEqual(C.chunkParts([1, 2, 3], 10), [[1, 2, 3]]);
});

test('makeChunkQuoteName: 1 chunk sin sufijo, >1 con padStart', () => {
  assert.strictEqual(C.makeChunkQuoteName('COTI', 0, 1), 'COTI');
  assert.strictEqual(C.makeChunkQuoteName('COTI', 0, 3), 'COTI 01');
  assert.strictEqual(C.makeChunkQuoteName('COTI', 2, 3), 'COTI 03');
});

test('detectCsvDuplicates: marca grupos por pn+customer', () => {
  const parts = [{ pn: 'A', customerId: 1 }, { pn: 'A', customerId: 1 }, { pn: 'B', customerId: 1 }];
  const { dupGroups, dupRows } = C.detectCsvDuplicates(parts);
  assert.strictEqual(dupGroups, 1);
  assert.strictEqual(dupRows, 1);
  assert.strictEqual(parts[0].isCsvDuplicate, true);
  assert.strictEqual(parts[0].csvDuplicateGroupSize, 2);
  assert.strictEqual(parts[2].isCsvDuplicate, undefined); // B no es duplicado
});

test('rankCandidates: mismo IBMS gana; luego score de metal/acabados', () => {
  const idx = new Map();
  const csvRow = { metalBase: 'Estaño', labels: ['Zinc'], quoteIBMS: 'IB1' };
  const cands = [
    { id: 1, metalBase: 'Cobre', labels: [], quoteIBMS: 'OTRO' },
    { id: 2, metalBase: 'Estaño', labels: ['Zinc'], quoteIBMS: 'IB1' }, // match perfecto + IBMS
  ];
  const ranked = C.rankCandidates(csvRow, cands, [], idx);
  assert.strictEqual(ranked[0].id, 2);
});

test('classifyOnePN Pase 1: IBMS único -> MODIFY al PN correcto', () => {
  const csvRow = { name: 'PN1', quoteIBMS: 'IBMS123', metalBase: '', labels: [] };
  const pns = [{ id: 5, name: 'PN1', quoteIBMS: 'IBMS123', archivedAt: null, customerId: 1, labels: [] }];
  const r = C.classifyOnePN(csvRow, pns, [], new Map());
  assert.strictEqual(r.classification, 'MODIFY');
  assert.strictEqual(r.pase, 1);
  assert.strictEqual(r.targetPnId, 5);
  assert.match(r.confidence, /ibms-exacto/);
});

test('classifyOnePN Pase 1: IBMS múltiple desempata por nombre exacto (fix homónimos 1.4.28)', () => {
  const csvRow = { name: 'PN1', quoteIBMS: 'X', metalBase: '', labels: [] };
  const pns = [
    { id: 5, name: 'PN1 PROYECTO BARRAS', quoteIBMS: 'X', archivedAt: null, customerId: 1, labels: [] },
    { id: 6, name: 'PN1', quoteIBMS: 'X', archivedAt: null, customerId: 1, labels: [] },
  ];
  const r = C.classifyOnePN(csvRow, pns, [], new Map());
  assert.strictEqual(r.targetPnId, 6); // name exacto gana, no el primero del array
  assert.match(r.confidence, /ibms\+name-exacto/);
});

test('classifyOnePN: no truena con window.SteelheadBulkCC disponible y CSV sin acabados (invariante #7)', () => {
  const csvRow = { name: 'PNX', quoteIBMS: '', metalBase: '', labels: [] };
  const pns = [{ id: 9, name: 'PNX', quoteIBMS: '', archivedAt: null, customerId: 1, labels: [] }];
  const r = C.classifyOnePN(csvRow, pns, [], new Map());
  assert.ok(r && typeof r.classification === 'string'); // produce clasificación válida sin lanzar
});

// ── 1.5.21: archivados NO se duplican (se matchean en TODOS los pases) ──

test('rankCandidates: a igualdad de score+ibms, prefiere activo sobre archivado (1.5.21)', () => {
  const csvRow = { metalBase: 'Estaño', labels: ['Zinc'], quoteIBMS: '' };
  const cands = [
    { id: 1, metalBase: 'Estaño', labels: ['Zinc'], quoteIBMS: '', archivedAt: '2026-01-01' }, // archivado
    { id: 2, metalBase: 'Estaño', labels: ['Zinc'], quoteIBMS: '', archivedAt: null },          // activo
  ];
  const ranked = C.rankCandidates(csvRow, cands, [], new Map());
  assert.strictEqual(ranked[0].id, 2); // el activo va primero
});

test('classifyOnePN Pase 3 (labels-match): PN archivado matchea por nombre+acabados -> MODIFY, no NEW (1.5.21)', () => {
  // composite difiere por metalBase, pero nombre+acabados coinciden -> cae a Pase 3
  const csvRow = { name: 'PNL', quoteIBMS: '', metalBase: 'Estaño', labels: ['Zinc'], customerId: 1 };
  const pns = [{ id: 90, name: 'PNL', quoteIBMS: '', archivedAt: '2026-01-01', customerId: 1, metalBase: 'Cobre', labels: ['Zinc'] }];
  const r = C.classifyOnePN(csvRow, pns, [], new Map());
  assert.strictEqual(r.classification, 'MODIFY'); // antes: NEW (duplicaba el archivado)
  assert.strictEqual(r.targetPnId, 90);
  assert.strictEqual(r.wasArchived, true);
  assert.match(r.confidence, /name\+labels-match/);
});

test('classifyOnePN Pase 3 (blank-candidate): archivado sin acabados se completa, no se duplica (1.5.21)', () => {
  const csvRow = { name: 'PN3', quoteIBMS: '', metalBase: '', labels: ['Zinc'], customerId: 1 };
  const pns = [{ id: 88, name: 'PN3', quoteIBMS: '', archivedAt: '2026-01-01', customerId: 1, metalBase: '', labels: [] }];
  const r = C.classifyOnePN(csvRow, pns, [], new Map());
  assert.strictEqual(r.classification, 'MODIFY');
  assert.strictEqual(r.targetPnId, 88);
  assert.strictEqual(r.wasArchived, true);
});

test('classifyOnePN: con activo y archivado del mismo nombre, Pase 2 sigue matcheando (no NEW) (1.5.21)', () => {
  const csvRow = { name: 'DUP', quoteIBMS: '', metalBase: 'Estaño', labels: ['Zinc'], customerId: 1 };
  const pns = [
    { id: 11, name: 'DUP', quoteIBMS: '', archivedAt: null, customerId: 1, metalBase: 'Estaño', labels: ['Zinc'] },          // activo
    { id: 10, name: 'DUP', quoteIBMS: '', archivedAt: '2026-01-01', customerId: 1, metalBase: 'Estaño', labels: ['Zinc'] }, // archivado
  ];
  const r = C.classifyOnePN(csvRow, pns, [], new Map());
  assert.strictEqual(r.classification, 'MODIFY');
  assert.strictEqual(r.targetPnId, 11); // composite find prefiere el activo (primero en el array)
});
