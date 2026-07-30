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

// ── buildStationLineIndex ─────────────────────────────────────────────────
const STATIONS = fx('surtido-guard-allstations.json');

test('buildStationLineIndex: mapea stationId → código de línea', () => {
  const idx = Core.buildStationLineIndex(STATIONS);
  assert.strictEqual(idx[12090], 'T204');
  assert.strictEqual(idx[12091], 'T205');
  assert.strictEqual(idx[12092], 'T300');
});

test('buildStationLineIndex: una ubicación de almacén NO es una línea', () => {
  // "Proquipa.N1.A1" es donde la pieza está PARADA (lo que filtra el nativo de SH).
  const idx = Core.buildStationLineIndex(STATIONS);
  assert.strictEqual(idx[12093], undefined);
});

test('buildStationLineIndex: nombre null no truena ni entra al índice', () => {
  const idx = Core.buildStationLineIndex(STATIONS);
  assert.strictEqual(idx[12094], undefined);
});

test('buildStationLineIndex: acepta el response con o sin envoltura .data', () => {
  const idx = Core.buildStationLineIndex({ data: STATIONS });
  assert.strictEqual(idx[12090], 'T204');
});

test('buildStationLineIndex: shape inesperado → objeto vacío (fail-safe)', () => {
  assert.deepStrictEqual(Core.buildStationLineIndex(null), {});
  assert.deepStrictEqual(Core.buildStationLineIndex({}), {});
  assert.deepStrictEqual(Core.buildStationLineIndex({ allStations: {} }), {});
});

// ── buildLineCounts ──────────────────────────────────────────────────────
const SCHED = fx('surtido-guard-schedule.json');

test('buildLineCounts: cuenta ÓRDENES por línea desde GetRelatedScheduleData', () => {
  // El fixture tiene 1 tarea en stationId 12090 (T204) con 1 account de la WO 5001.
  const idx = Core.buildStationLineIndex(STATIONS);
  const r = Core.buildLineCounts(SCHED, idx);
  assert.deepStrictEqual(r.byLine, { T204: 1 });
  assert.deepStrictEqual(r.lines, ['T204']);
  assert.strictEqual(r.scheduledOrders, 1);
});

test('buildLineCounts: la misma orden en 2 tareas de la MISMA línea cuenta 1 vez', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 900 }] } } ] } },
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 2, workOrderId: 900 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.byLine, { T204: 1 });
});

test('buildLineCounts: la misma orden en DOS líneas cuenta en las dos', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 900 }] } } ] } },
      { stationId: 12091, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 2, workOrderId: 900 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.byLine, { T204: 1, T205: 1 });
  assert.strictEqual(r.scheduledOrders, 1);
});

test('buildLineCounts: estación desconocida se REPORTA, no se traga en silencio', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 99999, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 900 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.byLine, {});
  assert.deepStrictEqual(r.unknownStationIds, [99999]);
});

test('buildLineCounts: lines viene ORDENADO alfabéticamente (dropdown estable)', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 12092, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 1 }] } } ] } },
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 2, workOrderId: 2 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.lines, ['T204', 'T300']);
});

test('buildLineCounts: sin índice de estaciones → sin líneas, pero no truena', () => {
  const r = Core.buildLineCounts(SCHED, {});
  assert.deepStrictEqual(r.byLine, {});
  assert.deepStrictEqual(r.lines, []);
});

test('buildLineCounts: shape inesperado → estructura vacía completa (fail-safe)', () => {
  const r = Core.buildLineCounts(null, null);
  assert.deepStrictEqual(r, { byLine: {}, lines: [], scheduledOrders: 0, unknownStationIds: [] });
});

// ── cardVisibleUnderFilter ───────────────────────────────────────────────
test('cardVisibleUnderFilter: sin filtro, TODO se ve (incluidas las no programadas)', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter([], null), true);
  assert.strictEqual(Core.cardVisibleUnderFilter([], ''), true);
  assert.strictEqual(Core.cardVisibleUnderFilter(['T204'], null), true);
});

test('cardVisibleUnderFilter: con filtro, coincide si la línea está en el set', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter(['T204'], 'T204'), true);
  assert.strictEqual(Core.cardVisibleUnderFilter(['T205', 'T204'], 'T204'), true);
  assert.strictEqual(Core.cardVisibleUnderFilter(['T205'], 'T204'), false);
});

test('cardVisibleUnderFilter: no programada (sin líneas) se ESCONDE con filtro activo', () => {
  // Decisión del operador 2026-07-29: se esconden como el resto.
  assert.strictEqual(Core.cardVisibleUnderFilter([], 'T204'), false);
});

test('cardVisibleUnderFilter: compara en mayúsculas', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter(['T204'], 't204'), true);
});

test('cardVisibleUnderFilter: entradas basura no truenan', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter(null, 'T204'), false);
  assert.strictEqual(Core.cardVisibleUnderFilter('T204', 'T204'), false);
});

// ── planFilter ───────────────────────────────────────────────────────────
const CARDS3 = [
  { lines: ['T204'] },
  { lines: ['T205'] },
  { lines: [] },
  { lines: [] }
];

test('planFilter: sin línea elegida → inactivo, efecto none, nada oculto', () => {
  const p = Core.planFilter({ cards: CARDS3, selectedLine: null, apiScheduledOrders: 2, mountedCount: 4 });
  assert.strictEqual(p.active, false);
  assert.strictEqual(p.effect, 'none');
  assert.strictEqual(p.visible, 4);
  assert.strictEqual(p.hidden, 0);
});

test('planFilter: con línea → esconde y desglosa el motivo de cada oculta', () => {
  const p = Core.planFilter({ cards: CARDS3, selectedLine: 'T204', apiScheduledOrders: 2, mountedCount: 4 });
  assert.strictEqual(p.active, true);
  assert.strictEqual(p.effect, 'hide');
  assert.strictEqual(p.visible, 1);
  assert.strictEqual(p.hidden, 3);
  assert.strictEqual(p.hiddenUnscheduled, 2);
  assert.strictEqual(p.hiddenOtherLine, 1);
});

test('planFilter: GUARDA 1 — pasa el tope de montados → cae a DIM, no a esconder', () => {
  const p = Core.planFilter({
    cards: CARDS3, selectedLine: 'T204', apiScheduledOrders: 2,
    mountedCount: 250, maxMounted: 200
  });
  assert.strictEqual(p.effect, 'dim');
  assert.strictEqual(p.reason, 'too-many-mounted');
});

test('planFilter: GUARDA 2 — señal DOM rota (API dice programadas, ninguna tarjeta revela línea) → no filtra', () => {
  const ciegas = [{ lines: [] }, { lines: [] }];
  const p = Core.planFilter({ cards: ciegas, selectedLine: 'T204', apiScheduledOrders: 7, mountedCount: 2 });
  assert.strictEqual(p.active, false);
  assert.strictEqual(p.effect, 'none');
  assert.strictEqual(p.reason, 'dom-signal-broken');
  assert.strictEqual(p.visible, 2);
});

test('planFilter: sin programadas en la API, cero líneas es NORMAL → sí filtra', () => {
  // No es señal rota: de verdad no hay nada programado. Esconder es correcto y explicable.
  const ciegas = [{ lines: [] }, { lines: [] }];
  const p = Core.planFilter({ cards: ciegas, selectedLine: 'T204', apiScheduledOrders: 0, mountedCount: 2 });
  assert.strictEqual(p.active, true);
  assert.strictEqual(p.effect, 'hide');
  assert.strictEqual(p.visible, 0);
  assert.strictEqual(p.hiddenUnscheduled, 2);
});

test('planFilter: maxMounted default 200', () => {
  const p = Core.planFilter({ cards: CARDS3, selectedLine: 'T204', apiScheduledOrders: 2, mountedCount: 201 });
  assert.strictEqual(p.effect, 'dim');
});

test('planFilter: entrada vacía no truena', () => {
  const p = Core.planFilter({});
  assert.strictEqual(p.active, false);
  assert.strictEqual(p.effect, 'none');
  assert.strictEqual(p.visible, 0);
});

// ── mergeLineCatalog ─────────────────────────────────────────────────────
// Existe por un caso REAL: en el board "Preparación de Surtido Almacén 5" la API no entregó
// GetRelatedScheduleData, así que el dropdown quedaba vacío mientras una tarjeta mostraba T300.
test('mergeLineCatalog: sin API, las líneas del DOM salvan el dropdown', () => {
  const r = Core.mergeLineCatalog({ byLine: {} }, ['T300']);
  assert.deepStrictEqual(r.lines, ['T300']);
  assert.deepStrictEqual(r.domOnly, ['T300']);
  assert.deepStrictEqual(r.byLine, {});
});

test('mergeLineCatalog: con API, el conteo de la API manda y NO se inventa uno del DOM', () => {
  const r = Core.mergeLineCatalog({ byLine: { T204: 6 } }, ['T204']);
  assert.deepStrictEqual(r.lines, ['T204']);
  assert.deepStrictEqual(r.byLine, { T204: 6 });
  assert.deepStrictEqual(r.domOnly, [], 'T204 ya venía de la API: no es domOnly');
});

test('mergeLineCatalog: une ambas fuentes y ordena', () => {
  const r = Core.mergeLineCatalog({ byLine: { T204: 6, T110: 2 } }, ['T300', 'T204']);
  assert.deepStrictEqual(r.lines, ['T110', 'T204', 'T300']);
  assert.deepStrictEqual(r.domOnly, ['T300']);
});

test('mergeLineCatalog: dedup y normalización de las del DOM', () => {
  const r = Core.mergeLineCatalog(null, ['t300', 'T300', 'T205']);
  assert.deepStrictEqual(r.lines, ['T205', 'T300']);
});

test('mergeLineCatalog: entradas basura → catálogo vacío, no truena', () => {
  assert.deepStrictEqual(Core.mergeLineCatalog(null, null), { lines: [], byLine: {}, domOnly: [] });
  assert.deepStrictEqual(Core.mergeLineCatalog(undefined, ['', null, 5]).lines, []);
});
