// Golden tests del módulo puro surtido-guard-filter-core.js (filtro por línea destino).
// Run: node --test tools/test/surtido-guard-filter-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'surtido-guard-filter-core.js'));
const Core = global.window.SurtidoGuardFilterCore;

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const CARDS = fx('surtido-guard-filter-cards.json');

// ── lineCodeFromStationText ────────────────────────────────────────────────
test('lineCodeFromStationText: ignora el prefijo "at" (literal EN en UI ES)', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at T204-LI Plata y Estaño s/Cobre Colgado (16.1)'), 'T204');
});

test('lineCodeFromStationText: sirve para CÉLULAS, no solo líneas', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at T300-CE03-002 Célula de Antitarnish'), 'T300');
});

test('lineCodeFromStationText: sin prefijo también funciona', () => {
  assert.strictEqual(Core.lineCodeFromStationText('T205-LI Estaño s/Aluminio (16.3)'), 'T205');
});

test('lineCodeFromStationText: NO inventa código en un tratamiento (TR-PRM-001)', () => {
  assert.strictEqual(Core.lineCodeFromStationText('TR-PRM-001 Antitarnish Manual'), null);
});

test('lineCodeFromStationText: normaliza a mayúsculas', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at t204-li algo'), 'T204');
});

test('lineCodeFromStationText: entradas vacías o no-string → null', () => {
  assert.strictEqual(Core.lineCodeFromStationText(''), null);
  assert.strictEqual(Core.lineCodeFromStationText(null), null);
  assert.strictEqual(Core.lineCodeFromStationText(undefined), null);
  assert.strictEqual(Core.lineCodeFromStationText(42), null);
});

test('lineCodeFromStationText: toma el PRIMER código de la celda', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at T204-LI puente a T205'), 'T204');
});

// ── linesFromScheduledRows ────────────────────────────────────────────────
test('linesFromScheduledRows: una fila → una línea (célula real del board)', () => {
  const c = CARDS.programadaCelula;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: una fila → una línea (línea real del board)', () => {
  const c = CARDS.programadaLinea;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: N filas → N líneas (una orden en varias líneas)', () => {
  const c = CARDS.multiLinea;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: estación sin código → lista vacía, no truena', () => {
  const c = CARDS.sinCodigoEnEstacion;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: lee td[1], NUNCA td[0] — el tratamiento puede traer OTRO código', () => {
  // Caso real: Proceso dice T400, tratamiento sin código, estación T300. Manda la ESTACIÓN.
  const rows = [['T999 tratamiento con codigo enganoso', 'at T300-CE03-002 Célula', 'fecha']];
  assert.deepStrictEqual(Core.linesFromScheduledRows(rows), ['T300']);
});

test('linesFromScheduledRows: dedup preservando orden de aparición', () => {
  const rows = [
    ['t', 'at T205-LI a', 'f'],
    ['t', 'at T204-LI b', 'f'],
    ['t', 'at T205-LI c', 'f']
  ];
  assert.deepStrictEqual(Core.linesFromScheduledRows(rows), ['T205', 'T204']);
});

test('linesFromScheduledRows: sin filas / no-array → []', () => {
  assert.deepStrictEqual(Core.linesFromScheduledRows([]), []);
  assert.deepStrictEqual(Core.linesFromScheduledRows(null), []);
  assert.deepStrictEqual(Core.linesFromScheduledRows('nope'), []);
});

test('linesFromScheduledRows: fila corta (sin td[1]) se ignora sin truenar', () => {
  assert.deepStrictEqual(Core.linesFromScheduledRows([['solo tratamiento']]), []);
});
