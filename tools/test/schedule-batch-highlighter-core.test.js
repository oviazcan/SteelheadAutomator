// tools/test/schedule-batch-highlighter-core.test.js
// Golden tests del módulo puro "Resaltar Lote en Programación".
// Run: node --test tools/test/schedule-batch-highlighter-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/schedule-batch-highlighter-core.js');

// ---------- isScheduleBoardUrl (gate) ----------

test('isScheduleBoardUrl: acepta el Schedule Board (con y sin query)', () => {
  assert.equal(Core.isScheduleBoardUrl('/Schedules/454/ScheduleBoard/453'), true);
  assert.equal(Core.isScheduleBoardUrl('/Schedules/454/ScheduleBoard/453?stationId=12093'), true);
  assert.equal(Core.isScheduleBoardUrl('/Schedules/1/ScheduleBoard/2/'), true);
});

test('isScheduleBoardUrl: rechaza otras rutas', () => {
  assert.equal(Core.isScheduleBoardUrl('/Schedules/454'), false);
  assert.equal(Core.isScheduleBoardUrl('/Domains/344/Shipping'), false);
  assert.equal(Core.isScheduleBoardUrl('/Schedules/454/ScheduleBoardFoo/453'), false);
});

// ---------- extractBatchNames ----------

test('extractBatchNames: un solo lote', () => {
  assert.deepEqual(Core.extractBatchNames('210726'), ['210726']);
});

test('extractBatchNames: varios lotes separados por espacio/coma', () => {
  assert.deepEqual(Core.extractBatchNames('210726 210727'), ['210726', '210727']);
  assert.deepEqual(Core.extractBatchNames('210726, 210727'), ['210726', '210727']);
});

test('extractBatchNames: vacío → lista vacía', () => {
  assert.deepEqual(Core.extractBatchNames(''), []);
  assert.deepEqual(Core.extractBatchNames(null), []);
  assert.deepEqual(Core.extractBatchNames('   '), []);
});

// ---------- rowMatchesBatchName ----------

test('rowMatchesBatchName: nombre numérico exacto (caso real "210726")', () => {
  assert.equal(Core.rowMatchesBatchName('210726', '210726'), true);
});

test('rowMatchesBatchName: NO matchea substrings ni superstrings', () => {
  assert.equal(Core.rowMatchesBatchName('2107260', '210726'), false); // superstring
  assert.equal(Core.rowMatchesBatchName('21072', '210726'), false);   // substring
  assert.equal(Core.rowMatchesBatchName('1210726', '210726'), false); // prefijo extra
});

test('rowMatchesBatchName: celda con varios lotes matchea si alguno coincide exacto', () => {
  assert.equal(Core.rowMatchesBatchName('210726 999999', '210726'), true);
  assert.equal(Core.rowMatchesBatchName('999999 210726', '210726'), true);
  assert.equal(Core.rowMatchesBatchName('999999 888888', '210726'), false);
});

test('rowMatchesBatchName: case-insensitive + tolera espacios del input', () => {
  assert.equal(Core.rowMatchesBatchName('T-125', 't-125'), true);
  assert.equal(Core.rowMatchesBatchName('210726', '  210726  '), true);
});

test('rowMatchesBatchName: nombre vacío nunca matchea', () => {
  assert.equal(Core.rowMatchesBatchName('210726', ''), false);
  assert.equal(Core.rowMatchesBatchName('210726', '   '), false);
});

// ---------- countMatches ----------

test('countMatches: cuenta las filas coincidentes (caso del bug: varias homónimas)', () => {
  const rows = [
    { cellText: '210726' }, // FE-GM
    { cellText: '210726' }, // FE-GM (2a)
    { cellText: '210726' }, // FE-PISTON (la que el filtro nativo escondía)
    { cellText: '999999' },
  ];
  assert.equal(Core.countMatches(rows, '210726'), 3);
});

test('countMatches: entrada no-array → 0', () => {
  assert.equal(Core.countMatches(null, '210726'), 0);
  assert.equal(Core.countMatches([], '210726'), 0);
});
