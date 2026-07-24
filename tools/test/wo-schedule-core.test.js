// Golden tests del módulo puro wo-schedule-core.js
// Run: node --test tools/test/wo-schedule-core.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-schedule-core.js'));
const Core = global.window.WoScheduleCore;

// ── Rutas ────────────────────────────────────────────────────────────────────
test('isWorkOrdersIndexPath: index sí, ficha no', () => {
  assert.equal(Core.isWorkOrdersIndexPath('/Domains/344/WorkOrders'), true);
  assert.equal(Core.isWorkOrdersIndexPath('/Domains/344/WorkOrders/'), true);
  assert.equal(Core.isWorkOrdersIndexPath('/Domains/344/WorkOrders?foo=1'), true);
  assert.equal(Core.isWorkOrdersIndexPath('/Domains/344/WorkOrders/15194'), false);
  assert.equal(Core.isWorkOrdersIndexPath('/Domains/344/SalesOrders'), false);
  assert.equal(Core.isWorkOrdersIndexPath(null), false);
});

test('isWorkOrderDetailPath + parseWorkOrderIdInDomain', () => {
  assert.equal(Core.isWorkOrderDetailPath('/Domains/344/WorkOrders/15194'), true);
  assert.equal(Core.isWorkOrderDetailPath('/Domains/344/WorkOrders'), false);
  assert.equal(Core.parseWorkOrderIdInDomain('/Domains/344/WorkOrders/15194'), 15194);
  assert.equal(Core.parseWorkOrderIdInDomain('/Domains/344/WorkOrders/15194?tab=x'), 15194);
  // desde un href de fila del listado
  assert.equal(Core.parseWorkOrderIdInDomain('/Domains/344/WorkOrders/15193'), 15193);
  assert.equal(Core.parseWorkOrderIdInDomain('/Domains/344/WorkOrders'), null);
  assert.equal(Core.parseWorkOrderIdInDomain(null), null);
});

test('parseDomainId', () => {
  assert.equal(Core.parseDomainId('/Domains/344/WorkOrders/15194'), 344);
  assert.equal(Core.parseDomainId('/PartNumbers/3781602'), null);
});

// ── Número(s) de Parte ─────────────────────────────────────────────────────────
// Fixture fiel a PartNumbersByWorkOrderIdInDomain (WO 15194 → SGE11074C7 real).
const PN_SINGLE = {
  workOrderByIdInDomain: {
    id: 1911753, idInDomain: 15194, name: '',
    partLocationsByWorkOrderId: {
      nodes: [
        { partNumberByPartNumberId: { id: 3781602, name: 'SGE11074C7', __typename: 'PartNumber' }, partGroupByPartGroupId: null },
      ],
    },
  },
};
const PN_MULTI = {
  data: {
    workOrderByIdInDomain: {
      id: 42, idInDomain: 900,
      partLocationsByWorkOrderId: {
        nodes: [
          { partNumberByPartNumberId: { id: 100, name: 'ABC-1' } },
          { partNumberByPartNumberId: { id: 200, name: 'XYZ-2' } },
          { partNumberByPartNumberId: { id: 100, name: 'ABC-1' } }, // dup → se colapsa
          { partNumberByPartNumberId: { id: 300, name: '' } },      // sin nombre → "PN 300"
        ],
      },
    },
  },
};

test('extractPartNumbers: 1 PN real', () => {
  const pns = Core.extractPartNumbers(PN_SINGLE);
  assert.deepEqual(pns, [{ id: 3781602, name: 'SGE11074C7' }]);
  assert.equal(Core.pnLink(pns[0].id), '/PartNumbers/3781602');
});

test('extractPartNumbers: múltiples PNs + dedup + sin nombre', () => {
  const pns = Core.extractPartNumbers(PN_MULTI);
  assert.deepEqual(pns, [
    { id: 100, name: 'ABC-1' },
    { id: 200, name: 'XYZ-2' },
    { id: 300, name: 'PN 300' },
  ]);
});

test('extractPartNumbers: fail-safe con shape inesperado', () => {
  assert.deepEqual(Core.extractPartNumbers(null), []);
  assert.deepEqual(Core.extractPartNumbers({}), []);
  assert.deepEqual(Core.extractPartNumbers({ workOrderByIdInDomain: {} }), []);
});

test('extractWorkOrderGlobalId: id global desde la respuesta de PN', () => {
  assert.equal(Core.extractWorkOrderGlobalId(PN_SINGLE), 1911753);   // OT 15194 → id global 1911753
  assert.equal(Core.extractWorkOrderGlobalId(PN_MULTI), 42);
  assert.equal(Core.extractWorkOrderGlobalId(null), null);
  assert.equal(Core.extractWorkOrderGlobalId({}), null);
});

// extractPartNumberDetail: labels (con color, sin archivadas) + descripción.
// Shape canónico partNumberById.partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{name,color}
// (igual en GetPartNumberForPartNumberPage —ligera, sin descriptionMarkdown— y GetPartNumber —pesada—).
test('extractPartNumberDetail: labels activos con color + descripción', () => {
  const heavy = {
    partNumberById: {
      descriptionMarkdown: 'CONECTOR',
      partNumberLabelsByPartNumberId: {
        nodes: [
          { archivedAt: null, labelByLabelId: { name: 'Industrial', color: '#1a237e' } },
          { archivedAt: null, labelByLabelId: { name: 'SRG', color: '#827717' } },
          { archivedAt: '2026-01-01T00:00:00Z', labelByLabelId: { name: 'Vieja', color: '#000' } }, // archivada → fuera
          { archivedAt: null, labelByLabelId: { name: 'Industrial', color: '#1a237e' } },            // dup → colapsa
        ],
      },
    },
  };
  const d = Core.extractPartNumberDetail(heavy);
  assert.equal(d.description, 'CONECTOR');
  assert.deepEqual(d.labels, [{ name: 'Industrial', color: '#1a237e' }, { name: 'SRG', color: '#827717' }]);
});

test('extractPartNumberDetail: query LIGERA sin descripción → description vacía', () => {
  const light = { data: { partNumberById: {
    id: 3631582, name: 'X',
    partNumberLabelsByPartNumberId: { nodes: [{ labelByLabelId: { name: 'Decapado', color: '#795548' } }] },
  } } };
  const d = Core.extractPartNumberDetail(light);
  assert.equal(d.description, '');
  assert.deepEqual(d.labels, [{ name: 'Decapado', color: '#795548' }]);
});

test('extractPartNumberDetail: fail-safe', () => {
  assert.deepEqual(Core.extractPartNumberDetail(null), { description: '', labels: [] });
  assert.deepEqual(Core.extractPartNumberDetail({ partNumberById: {} }), { description: '', labels: [] });
});

// ── Programación ────────────────────────────────────────────────────────────
// Fixture fiel al shape de GetRelatedScheduleData (surtido-guard-capture2.json).
const SCHEDULE = {
  allSchedules: {
    nodes: [
      {
        id: 454, name: 'Programa Diario',
        validScheduleTasks: {
          nodes: [
            {
              stationId: 12090, expectedStartTime: '2026-06-23T22:30:00.154+00:00',
              treatmentId: 98620, totalTimeMinutes: 240,
              scheduleTaskElementsByScheduleTaskId: {
                nodes: [
                  {
                    partCount: 117, recipeNodeId: 43986487, partNumberId: 3616247,
                    associatedPartsTransferAccounts: { nodes: [{ id: 42006947, workOrderId: 1810189 }] },
                  },
                ],
              },
            },
            {
              stationId: 12091, expectedStartTime: '2026-06-24T08:00:00.000+00:00',
              treatmentId: 98621, totalTimeMinutes: 120,
              scheduleTaskElementsByScheduleTaskId: {
                nodes: [
                  {
                    partCount: 50, recipeNodeId: 43986490, partNumberId: 3616247,
                    // MISMA WO, 2º paso más tarde → debe quedar DESPUÉS por orden temporal
                    associatedPartsTransferAccounts: { nodes: [{ id: 42006948, workOrderId: 1810189 }] },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};

test('buildScheduleIndex + resolveByWorkOrderId: ordena por fecha ascendente', () => {
  const idx = Core.buildScheduleIndex(SCHEDULE);
  const entries = Core.resolveByWorkOrderId(idx, 1810189);
  assert.equal(entries.length, 2);
  // la más próxima primero (23/06 antes que 24/06)
  assert.equal(entries[0].expectedStartTime, '2026-06-23T22:30:00.154+00:00');
  assert.equal(entries[0].stationId, 12090);
  assert.equal(entries[0].scheduleName, 'Programa Diario');
  assert.equal(entries[0].accountId, 42006947);
  assert.equal(entries[1].stationId, 12091);
});

test('resolveByWorkOrderId: WO no programada → []', () => {
  const idx = Core.buildScheduleIndex(SCHEDULE);
  assert.deepEqual(Core.resolveByWorkOrderId(idx, 999999), []);
});

test('resolveByAccountIds: cruza por account de la WO (dedup)', () => {
  const idx = Core.buildScheduleIndex(SCHEDULE);
  const entries = Core.resolveByAccountIds(idx, [42006947, 42006948, 42006947]);
  assert.equal(entries.length, 2);
});

test('buildScheduleIndex: fail-safe', () => {
  const idx = Core.buildScheduleIndex(null);
  assert.deepEqual(Core.resolveByWorkOrderId(idx, 1), []);
});

// ── Estaciones ────────────────────────────────────────────────────────────────
test('stationNameMap + stationName', () => {
  const map = Core.stationNameMap({ allStations: { nodes: [{ id: 12090, name: 'T204 Plateado' }, { id: 12091, name: 'T205 Antiguo' }] } });
  assert.equal(Core.stationName(map, 12090), 'T204 Plateado');
  assert.equal(Core.stationName(map, 99999), 'Estación 99999'); // fallback
  assert.equal(Core.stationName(map, null), '');
});

// ── Formateo ──────────────────────────────────────────────────────────────────
test('parseIsoParts + formatShortDateTime (TZ-agnóstico, componentes crudos)', () => {
  assert.deepEqual(Core.parseIsoParts('2026-06-23T22:30:00.154+00:00'), { y: 2026, mo: 6, d: 23, h: 22, mi: 30 });
  assert.equal(Core.formatShortDateTime('2026-06-23T22:30:00.154+00:00'), '23/06 22:30');
  assert.equal(Core.formatShortDateTime('nope'), '');
});

test('formatScheduleCell: 1 tarea, N tareas, vacío', () => {
  const idx = Core.buildScheduleIndex(SCHEDULE);
  const stations = { 12090: 'T204 Plateado', 12091: 'T205 Antiguo' };
  const entries = Core.resolveByWorkOrderId(idx, 1810189);
  assert.equal(Core.formatScheduleCell(entries, stations), 'T204 Plateado · 23/06 22:30 · Programa Diario  (+1)');
  assert.equal(Core.formatScheduleCell([entries[0]], stations), 'T204 Plateado · 23/06 22:30 · Programa Diario');
  assert.equal(Core.formatScheduleCell([], stations), '—');
});

// ── WorkOrderSchedule (query REAL de la ficha — board completo) ────────────────
// Fixture fiel al scan 2026-07-23: estación con nombre embebido, status, y el link
// a la WO por element.recipeNodeByRecipeNodeId.workOrderId (workOrderId GLOBAL).
function wosTask(id, iso, stationId, stationName, status, woIds, pn) {
  return {
    id: id, expectedStartTime: iso, stationId: stationId, status: status,
    isIntentional: false, treatmentId: 91420, totalTimeMinutes: 66,
    stationByStationId: { id: stationId, name: stationName },
    scheduleTaskElementsByScheduleTaskId: {
      nodes: woIds.map(function (w) {
        return { partCount: 1, recipeNodeByRecipeNodeId: { workOrderId: w }, partNumberByPartNumberId: { name: pn } };
      }),
    },
  };
}
const WOS = {
  allSchedules: {
    nodes: [
      {
        id: 454,
        validScheduleTasks: {
          nodes: [
            // WO 1878577: dos pasos (el más tarde debe quedar 2º)
            wosTask(83688, '2026-07-15T21:15:00+00:00', 12088, 'T108-LI Níquel Electroless (13)', 'QUEUED', [1878577], 'S2U7408B02'),
            wosTask(90001, '2026-07-16T06:00:00+00:00', 12090, 'T204 Plateado', 'SCHEDULED', [1878577], 'S2U7408B02'),
            // WO 1810189: un paso
            wosTask(90002, '2026-07-14T10:00:00+00:00', 12091, 'T205 Antiguo', 'IN_PROGRESS', [1810189], 'ABC-9'),
          ],
        },
      },
    ],
  },
};

test('buildBoardScheduleIndex: indexa por workOrderId global (via recipeNode) + ordena por fecha', () => {
  const idx = Core.buildBoardScheduleIndex(WOS);
  const t = Core.resolveBoardScheduleForWO(idx, 1878577);
  assert.equal(t.length, 2);
  assert.equal(t[0].taskId, 83688);                          // 15/07 antes que 16/07
  assert.equal(t[0].stationName, 'T108-LI Níquel Electroless (13)');
  assert.equal(t[0].status, 'QUEUED');
  assert.equal(t[1].taskId, 90001);
  // otra WO
  const t2 = Core.resolveBoardScheduleForWO(idx, 1810189);
  assert.equal(t2.length, 1);
  assert.equal(t2[0].stationName, 'T205 Antiguo');
  // no programada
  assert.deepEqual(Core.resolveBoardScheduleForWO(idx, 999999), []);
});

test('buildBoardScheduleIndex: fail-safe', () => {
  assert.deepEqual(Core.resolveBoardScheduleForWO(Core.buildBoardScheduleIndex(null), 1), []);
  assert.deepEqual(Core.resolveBoardScheduleForWO(Core.buildBoardScheduleIndex({}), 1), []);
});

test('scheduleStatusLabel: ES + desconocido', () => {
  assert.equal(Core.scheduleStatusLabel('QUEUED'), 'En cola');
  assert.equal(Core.scheduleStatusLabel('IN_PROGRESS'), 'En proceso');
  assert.equal(Core.scheduleStatusLabel('COMPLETED'), 'Completada');
  assert.equal(Core.scheduleStatusLabel('WEIRD_STATE'), 'WEIRD_STATE'); // desconocido → tal cual
  assert.equal(Core.scheduleStatusLabel(''), '');
});

test('formatScheduleTaskLine + formatBoardScheduleCell', () => {
  const idx = Core.buildBoardScheduleIndex(WOS);
  const t = Core.resolveBoardScheduleForWO(idx, 1878577);
  assert.equal(Core.formatScheduleTaskLine(t[0]), 'T108-LI Níquel Electroless (13) · 15/07 21:15 · En cola');
  assert.equal(Core.formatBoardScheduleCell(t), 'T108-LI Níquel Electroless (13) · 15/07 21:15 · En cola  (+1)');
  assert.equal(Core.formatBoardScheduleCell([]), '—');
});

// ── FASE 2: input de UpdateManyScheduleTasks (programación intencional) ────────
// Fiel al payload REAL capturado (button:Update en la ficha, scan 2026-07-23_185855).
test('buildScheduleTaskUpdateInput: echo de campos + override fecha + isIntentional:true', () => {
  const task = {
    taskId: 86745, scheduleId: 454, stationId: 12101,
    expectedStartTime: '2026-07-22T20:00:00.000Z',
    totalTimeMinutes: 5, cycleTimeMinutes: 0.0009090909090909091, treatmentTimeMinutes: 0.0009090909090909705,
    isIntentional: false, stationName: 'X', status: 'QUEUED',
  };
  const input = Core.buildScheduleTaskUpdateInput(task, { expectedStartTime: '2026-07-22T22:00:00.000Z' });
  assert.deepEqual(input, {
    scheduledTasks: [{
      id: 86745, scheduleId: 454, stationId: 12101,
      expectedStartTime: '2026-07-22T22:00:00.000Z',
      totalTimeMinutes: 5, cycleTimeMinutes: 0.0009090909090909091, treatmentTimeMinutes: 0.0009090909090909705,
      isIntentional: true,
    }],
  });
});

test('buildScheduleTaskUpdateInput: sin override usa la fecha actual; puede des-intencionalizar', () => {
  const task = { taskId: 1, scheduleId: 454, stationId: 9, expectedStartTime: '2026-07-01T00:00:00.000Z', totalTimeMinutes: 5, cycleTimeMinutes: 1, treatmentTimeMinutes: 1 };
  const a = Core.buildScheduleTaskUpdateInput(task, {});
  assert.equal(a.scheduledTasks[0].expectedStartTime, '2026-07-01T00:00:00.000Z');
  assert.equal(a.scheduledTasks[0].isIntentional, true);
  const b = Core.buildScheduleTaskUpdateInput(task, { isIntentional: false });
  assert.equal(b.scheduledTasks[0].isIntentional, false);
});

test('buildScheduleTaskUpdateInput: null si falta taskId', () => {
  assert.equal(Core.buildScheduleTaskUpdateInput(null, {}), null);
  assert.equal(Core.buildScheduleTaskUpdateInput({ scheduleId: 1 }, {}), null);
});

test('buildBoardScheduleIndex: incluye cycle/treatmentTimeMinutes (para el update)', () => {
  const wos = { allSchedules: { nodes: [{ id: 454, validScheduleTasks: { nodes: [{
    id: 5, expectedStartTime: '2026-07-15T21:15:00+00:00', stationId: 12088, status: 'QUEUED',
    totalTimeMinutes: 66, cycleTimeMinutes: 2.05, treatmentTimeMinutes: 3.1,
    stationByStationId: { id: 12088, name: 'T108' },
    scheduleTaskElementsByScheduleTaskId: { nodes: [{ recipeNodeByRecipeNodeId: { workOrderId: 999 } }] },
  }] } }] } };
  const t = Core.resolveBoardScheduleForWO(Core.buildBoardScheduleIndex(wos), 999)[0];
  assert.equal(t.cycleTimeMinutes, 2.05);
  assert.equal(t.treatmentTimeMinutes, 3.1);
});
