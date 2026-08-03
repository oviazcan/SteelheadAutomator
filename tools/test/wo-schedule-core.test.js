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

// ── Lote(s) de la WO (extractWorkOrderBatches + batchLink) ─────────────────────
// Fixture fiel al response de WorkOrder({idInDomain}): un lote real (RG-M377597 / 11169)
// con Packing Slip del cliente + receptor con receivedAt.
const WO_BATCH_SINGLE = {
  workOrderByIdInDomain: {
    id: 1911753, idInDomain: 15194,
    currentPartsTransferAccounts: {
      nodes: [
        {
          inventoryAccountByInventoryAccountId: {
            inventoryBatchByInventoryBatchId: {
              id: 500123, idInDomain: 11169, name: 'RG-M377597',
              customInputs: { DatosRecibo: { PackingSlip: 'PS-8842', numeroContenedores: 3 } },
              inventoryItemByInventoryItemId: { partNumberByPartNumberId: { id: 3781602, name: 'SGE11074C7' } },
            },
            receiverBomItemByReceiverBomItemId: {
              receiverByReceiverId: { id: 77, idInDomain: 12, receivedAt: '2026-07-18T15:30:00+00:00', createdAt: '2026-07-20T09:00:00+00:00' },
            },
          },
        },
      ],
    },
  },
};

test('extractWorkOrderBatches: un lote con PS + fecha de recibido + pnId', () => {
  const b = Core.extractWorkOrderBatches(WO_BATCH_SINGLE);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], {
    id: 500123, idInDomain: 11169, name: 'RG-M377597',
    packingSlip: 'PS-8842', receivedAt: '2026-07-18T15:30:00+00:00', partNumberId: 3781602,
  });
});

test('extractWorkOrderBatches: receivedAt viene del receptor, NO de createdAt', () => {
  const b = Core.extractWorkOrderBatches(WO_BATCH_SINGLE);
  assert.equal(b[0].receivedAt, '2026-07-18T15:30:00+00:00'); // receivedAt, no createdAt
});

test('extractWorkOrderBatches: multi-lote, dedup por batch id, envuelto en data', () => {
  const input = { data: { workOrderByIdInDomain: { currentPartsTransferAccounts: { nodes: [
    { inventoryAccountByInventoryAccountId: { inventoryBatchByInventoryBatchId: { id: 1, idInDomain: 10, name: 'L-A', customInputs: {} }, receiverBomItemByReceiverBomItemId: null } },
    { inventoryAccountByInventoryAccountId: { inventoryBatchByInventoryBatchId: { id: 2, idInDomain: 20, name: 'L-B', customInputs: {} } } },
    { inventoryAccountByInventoryAccountId: { inventoryBatchByInventoryBatchId: { id: 1, idInDomain: 10, name: 'L-A', customInputs: {} } } }, // dup → colapsa
  ] } } } };
  const b = Core.extractWorkOrderBatches(input);
  assert.equal(b.length, 2);
  assert.deepEqual(b.map(x => x.name), ['L-A', 'L-B']);
  assert.equal(b[0].packingSlip, ''); // sin PS
  assert.equal(b[0].receivedAt, null); // sin receptor
  assert.equal(b[0].partNumberId, null); // sin inventoryItem
});

test('extractWorkOrderBatches: customInputs como STRING JSON', () => {
  const input = { workOrderByIdInDomain: { currentPartsTransferAccounts: { nodes: [
    { inventoryAccountByInventoryAccountId: { inventoryBatchByInventoryBatchId: {
      id: 9, idInDomain: 90, name: 'L-STR',
      customInputs: JSON.stringify({ DatosRecibo: { PackingSlip: 'PS-STR' } }),
    } } },
  ] } } };
  assert.equal(Core.extractWorkOrderBatches(input)[0].packingSlip, 'PS-STR');
});

test('extractWorkOrderBatches: sin nombre → "Lote <id>"; PS vacío → ""', () => {
  const input = { workOrderByIdInDomain: { currentPartsTransferAccounts: { nodes: [
    { inventoryAccountByInventoryAccountId: { inventoryBatchByInventoryBatchId: {
      id: 7, idInDomain: 70, name: '', customInputs: { DatosRecibo: { PackingSlip: '' } },
    } } },
  ] } } };
  const b = Core.extractWorkOrderBatches(input)[0];
  assert.equal(b.name, 'Lote 7');
  assert.equal(b.packingSlip, '');
});

test('extractWorkOrderBatches: fail-safe (shape inesperado / cuenta sin lote → [])', () => {
  assert.deepEqual(Core.extractWorkOrderBatches(null), []);
  assert.deepEqual(Core.extractWorkOrderBatches({}), []);
  assert.deepEqual(Core.extractWorkOrderBatches({ workOrderByIdInDomain: {} }), []);
  // cuenta sin inventoryAccount, y cuenta sin batch → se ignoran
  assert.deepEqual(Core.extractWorkOrderBatches({ workOrderByIdInDomain: { currentPartsTransferAccounts: { nodes: [
    { inventoryAccountByInventoryAccountId: null },
    { inventoryAccountByInventoryAccountId: { inventoryBatchByInventoryBatchId: null } },
  ] } } }), []);
});

test('batchLink: anidado con pnId, bare sin pnId, null sin idInDomain', () => {
  assert.equal(Core.batchLink(11169, 3781602), '/PartNumbers/3781602/Inventory/Batches/11169');
  assert.equal(Core.batchLink(11169, null), '/Inventory/Batches/11169');
  assert.equal(Core.batchLink(11169), '/Inventory/Batches/11169');
  assert.equal(Core.batchLink(null, 3781602), null);
});

// ── Impresión de PDFs (parsePrintParam / parsePdfShareUrl / filenames / headings) ──
test('parsePrintParam: jobtag/verbose válidos, resto null', () => {
  assert.equal(Core.parsePrintParam('?sa_print=jobtag'), 'jobtag');
  assert.equal(Core.parsePrintParam('?foo=1&sa_print=verbose'), 'verbose');
  assert.equal(Core.parsePrintParam('?sa_print=JOBTAG'), 'jobtag'); // case-insensitive
  assert.equal(Core.parsePrintParam('?sa_print=otro'), null);
  assert.equal(Core.parsePrintParam('?x=1'), null);
  assert.equal(Core.parsePrintParam(null), null);
});

test('isPdfShareUrl + parsePdfShareUrl: share-URL real de Steelhead', () => {
  const url = 'https://app.gosteelhead.com/api/pdf/share/14798/7a01757b490e10c69927ad290707e98a?downloadName=work-order-part-number-15550.pdf';
  assert.equal(Core.isPdfShareUrl(url), true);
  assert.deepEqual(Core.parsePdfShareUrl(url), {
    shareId: '14798', token: '7a01757b490e10c69927ad290707e98a',
    downloadName: 'work-order-part-number-15550.pdf',
  });
  // sin downloadName
  const u2 = 'https://app.gosteelhead.com/api/pdf/share/14798/2cd434c5c44a9e586a8b35c479621fb8';
  assert.equal(Core.parsePdfShareUrl(u2).downloadName, '');
  // no-share
  assert.equal(Core.isPdfShareUrl('https://app.gosteelhead.com/api/files/123.jpg'), false);
  assert.equal(Core.parsePdfShareUrl('nope'), null);
});

test('buildPdfFilename: "WO<idInDomain>.pdf" corto; verbose con sufijo', () => {
  assert.equal(Core.buildPdfFilename('jobtag', 15550), 'WO15550.pdf');
  assert.equal(Core.buildPdfFilename('verbose', 15550), 'WO15550-verbose.pdf');
  assert.equal(Core.buildPdfFilename('desconocido', 9), 'WO9.pdf');
  assert.equal(Core.buildPdfFilename('jobtag', null), 'WO.pdf');
});

test('printType / printTypeList: config de tipos', () => {
  assert.equal(Core.printType('jobtag').order, 0);
  assert.equal(Core.printType('verbose').order, 1);
  assert.equal(Core.printType('nope'), null);
  assert.equal(Core.printTypeList().length, 2);
});

test('isPrintDialogHeading / isPrintPreviewHeading: ES confirmado', () => {
  assert.equal(Core.isPrintDialogHeading('Imprimir Etiqueta de Trabajo'), true);
  assert.equal(Core.isPrintPreviewHeading('Vista Previa de Etiqueta de Trabajo'), true);
  assert.equal(Core.isPrintDialogHeading('Otra cosa'), false);
  assert.equal(Core.isPrintPreviewHeading(null), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Fase 2a — programación intencional desde la ficha
// ══════════════════════════════════════════════════════════════════════════
// La conversión ISO↔input local es el punto donde un error NO se ve: no truena,
// solo programa la OT a otra hora. Offset explícito en minutos, convención de
// Date.getTimezoneOffset() (positivo al oeste: UTC-6 ⇒ 360).

test('isoToLocalInput: UTC → hora local del input (CDMX, UTC-6)', () => {
  // el payload real capturado: 22:00Z = 16:00 en CDMX
  assert.equal(Core.isoToLocalInput('2026-07-22T22:00:00.000Z', 360), '2026-07-22T16:00');
});

test('isoToLocalInput: cruzar la medianoche cambia el DÍA, no solo la hora', () => {
  assert.equal(Core.isoToLocalInput('2026-07-23T04:00:00.000Z', 360), '2026-07-22T22:00');
  assert.equal(Core.isoToLocalInput('2026-07-22T20:00:00.000Z', -360), '2026-07-23T02:00');
});

test('isoToLocalInput: UTC (offset 0) se queda igual, y basura da ""', () => {
  assert.equal(Core.isoToLocalInput('2026-01-05T07:05:00.000Z', 0), '2026-01-05T07:05');
  assert.equal(Core.isoToLocalInput('no-es-fecha', 360), '');
  assert.equal(Core.isoToLocalInput(null, 360), '');
});

test('localInputToIso: input local → ISO UTC', () => {
  assert.equal(Core.localInputToIso('2026-07-22T16:00', 360), '2026-07-22T22:00:00.000Z');
  assert.equal(Core.localInputToIso('2026-07-22T22:00', 360), '2026-07-23T04:00:00.000Z');
});

test('localInputToIso: rechaza lo que no parsea (no inventa una hora)', () => {
  assert.equal(Core.localInputToIso('', 360), null);
  assert.equal(Core.localInputToIso('22/07/2026 16:00', 360), null);
  assert.equal(Core.localInputToIso(null, 360), null);
});

test('ISO → local → ISO es identidad (el round-trip no corre la hora)', () => {
  for (const iso of ['2026-07-22T22:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:00.000Z']) {
    for (const off of [360, 0, -330, 240]) {
      assert.equal(Core.localInputToIso(Core.isoToLocalInput(iso, off), off), iso,
        `round-trip roto para ${iso} @ offset ${off}`);
    }
  }
});

test('buildScheduleTaskUpdateInput reproduce el payload real capturado', () => {
  // scan_results_2026-07-23_185855, ScheduleBoard 454 — echo de todos los campos.
  const task = {
    taskId: 86745, scheduleId: 454, stationId: 12101,
    expectedStartTime: '2026-07-20T10:00:00.000Z',
    totalTimeMinutes: 5,
    cycleTimeMinutes: 0.0009090909090909091,
    treatmentTimeMinutes: 0.0009090909090909705,
  };
  const out = Core.buildScheduleTaskUpdateInput(task, {
    expectedStartTime: '2026-07-22T22:00:00.000Z', isIntentional: true,
  });
  assert.deepEqual(out, {
    scheduledTasks: [{
      id: 86745, scheduleId: 454, stationId: 12101,
      expectedStartTime: '2026-07-22T22:00:00.000Z',
      totalTimeMinutes: 5,
      cycleTimeMinutes: 0.0009090909090909091,
      treatmentTimeMinutes: 0.0009090909090909705,
      isIntentional: true,
    }],
  });
});

test('buildScheduleTaskUpdateInput: sin taskId no arma nada (la mutación es por id)', () => {
  assert.equal(Core.buildScheduleTaskUpdateInput({ scheduleId: 1 }, {}), null);
  assert.equal(Core.buildScheduleTaskUpdateInput(null, {}), null);
});

// La respuesta de UpdateManyScheduleTasks no confirma NADA de lo pedido
// (`{mnUpdateScheduleTaskById:{clientMutationId:null}}`), así que la única prueba
// de que se aplicó es releer la tarea. Mismo modo de fallo que el load-before-save
// del auto-ruteador: el servidor acepta y no aplica, y la UI canta victoria.
test('verifyScheduleTaskApplied: la tarea releída coincide → ok', () => {
  const r = Core.verifyScheduleTaskApplied(
    { expectedStartTime: '2026-07-22T22:00:00.000Z', isIntentional: true },
    { expectedStartTime: '2026-07-22T22:00:00.000Z', isIntentional: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test('verifyScheduleTaskApplied: compara el INSTANTE, no la cadena', () => {
  // el servidor normaliza el formato ISO; sin milisegundos sigue siendo la misma hora
  const r = Core.verifyScheduleTaskApplied(
    { expectedStartTime: '2026-07-22T22:00:00Z', isIntentional: true },
    { expectedStartTime: '2026-07-22T22:00:00.000Z', isIntentional: true });
  assert.equal(r.ok, true);
});

test('verifyScheduleTaskApplied: si NO se aplicó, lo dice', () => {
  const r = Core.verifyScheduleTaskApplied(
    { expectedStartTime: '2026-07-20T10:00:00.000Z', isIntentional: false },
    { expectedStartTime: '2026-07-22T22:00:00.000Z', isIntentional: true });
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 2);
});

test('verifyScheduleTaskApplied: tarea que desapareció no es un éxito', () => {
  const r = Core.verifyScheduleTaskApplied(null, { expectedStartTime: '2026-07-22T22:00:00.000Z' });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /ya no aparece/i);
});

// ══════════════════════════════════════════════════════════════════════════
// Fase 2b — CREAR una tarea donde no hay
// ══════════════════════════════════════════════════════════════════════════
// Todo esto sale del payload REAL capturado el 2026-07-28 (Schedule Board 454,
// programar una orden sin tarea). El fixture es la evidencia; estos tests son el
// candado que impide que el ensamblado se aleje de ella.
const FX = require('./fixtures/wo-schedule-create-task.json');

test('buildScheduleTaskCreateInput reproduce el payload REAL byte a byte', () => {
  const real = FX.variables;
  const t = real.scheduledTasks.mnScheduleTask[0];
  const n = t.scheduleTaskElementsByScheduleTaskId.nodes[0];
  const out = Core.buildScheduleTaskCreateInput({
    scheduleId: t.scheduleId, treatmentId: t.treatmentId, stationId: t.stationId,
    expectedStartTime: t.expectedStartTime,
    cycleTimeMinutes: t.cycleTimeMinutes, treatmentTimeMinutes: t.treatmentTimeMinutes,
    isIntentional: t.isIntentional,
    partSetUuid: n.partSetUuid, recipeNodeId: n.recipeNodeId, partNumberId: n.partNumberId,
    rackIdLineage: n.rackIdLineage, rackTypeIdLineage: n.rackTypeIdLineage,
    partCount: n.partCount, partsPerBatch: n.partsPerBatch,
    relatedPartTransferAccounts: n.relatedPartTransferAccounts,
  });
  assert.deepEqual(out, real);
});

test('los tipos que sorprenden se respetan: rackTypeIdLineage es STRING', () => {
  const n = FX.variables.scheduledTasks.mnScheduleTask[0].scheduleTaskElementsByScheduleTaskId.nodes[0];
  assert.equal(typeof n.rackTypeIdLineage, 'string', 'el capturado es string, no array ni número');
  assert.equal(n.rackIdLineage, null);
  // y el ensamblado no lo "arregla" a número
  const out = Core.buildScheduleTaskCreateInput({
    scheduleId: 1, treatmentId: 2, stationId: 3, expectedStartTime: 'x',
    cycleTimeMinutes: 1, treatmentTimeMinutes: 1, partCount: 1, partsPerBatch: 1,
    partSetUuid: 'u', recipeNodeId: 4, partNumberId: 5, rackTypeIdLineage: 2701,
    relatedPartTransferAccounts: [{ id: 9, partCount: 1 }],
  });
  assert.strictEqual(out.scheduledTasks.mnScheduleTask[0]
    .scheduleTaskElementsByScheduleTaskId.nodes[0].rackTypeIdLineage, '2701');
});

// La fórmula del total es lo único que el applet CALCULA en vez de copiar, así que se
// fija contra las 4 tareas reales que la validaron. Si alguien la "simplifica", truena.
test('scheduleTaskTimes: total = tratamiento + (lotes-1) × ciclo — 4 casos reales', () => {
  const casos = [
    { partCount: 13504, partsPerBatch: 1501, treatmentTimeMinutes: 45, cycleTimeMinutes: 12, batches: 9, total: 141 },
    { partCount: 9000,  partsPerBatch: 1686, treatmentTimeMinutes: 50, cycleTimeMinutes: 50, batches: 6, total: 300 },
    { partCount: 1,     partsPerBatch: 120,  treatmentTimeMinutes: 66, cycleTimeMinutes: 60, batches: 1, total: 66 },
    { partCount: 12,    partsPerBatch: 49,   treatmentTimeMinutes: 30, cycleTimeMinutes: 30, batches: 1, total: 30 },
  ];
  for (const c of casos) {
    const r = Core.scheduleTaskTimes(c);
    assert.equal(r.batches, c.batches, `lotes mal para ${c.partCount}/${c.partsPerBatch}`);
    assert.equal(r.totalTimeMinutes, c.total, `total mal para ${c.partCount}/${c.partsPerBatch}`);
  }
});

test('scheduleTaskTimes: un lote exacto NO cobra ciclo de más', () => {
  // 100/100 = 1 lote justo: el borde donde un ceil mal puesto agrega un ciclo fantasma
  assert.equal(Core.scheduleTaskTimes({ partCount: 100, partsPerBatch: 100,
    treatmentTimeMinutes: 30, cycleTimeMinutes: 10 }).totalTimeMinutes, 30);
  // 101/100 = 2 lotes
  assert.equal(Core.scheduleTaskTimes({ partCount: 101, partsPerBatch: 100,
    treatmentTimeMinutes: 30, cycleTimeMinutes: 10 }).totalTimeMinutes, 40);
});

test('scheduleTaskTimes: datos inservibles → null (no una tarea de 0 minutos)', () => {
  assert.equal(Core.scheduleTaskTimes({ partCount: 0, partsPerBatch: 10, treatmentTimeMinutes: 1, cycleTimeMinutes: 1 }), null);
  assert.equal(Core.scheduleTaskTimes({ partCount: 10, partsPerBatch: 0, treatmentTimeMinutes: 1, cycleTimeMinutes: 1 }), null);
  assert.equal(Core.scheduleTaskTimes({ partCount: 10, partsPerBatch: 5, treatmentTimeMinutes: null, cycleTimeMinutes: 1 }), null);
});

test('intervalToMinutes: los tiempos viajan como Interval de Postgres', () => {
  const iv = FX._treatmentTimeEjemplo.nodo.cycleTime;
  assert.equal(Core.intervalToMinutes(iv), 20);
  assert.equal(Core.intervalToMinutes(FX._treatmentTimeEjemplo.nodo.totalTime), 30);
  assert.equal(Core.intervalToMinutes({ hours: 2, minutes: 5 }), 125);
  assert.equal(Core.intervalToMinutes({ days: 1 }), 1440);
  assert.equal(Core.intervalToMinutes({ minutes: 1, seconds: 30 }), 1.5);
  assert.equal(Core.intervalToMinutes(null), null);
});

// El TreatmentTime aplicable es un override por especificidad: null = comodín.
// Elegir el equivocado programa con el tiempo de otra estación → desacomoda el piso.
test('pickTreatmentTime: gana el más específico que MATCHEE el contexto', () => {
  const times = [
    { cycleTime: { minutes: 20 }, totalTime: { minutes: 30 }, timeType: 'BATCH',
      partNumberId: null, stationId: null },
    { cycleTime: { minutes: 12 }, totalTime: { minutes: 45 }, timeType: 'BATCH',
      partNumberId: 3027539, stationId: null },
    { cycleTime: { minutes: 99 }, totalTime: { minutes: 99 }, timeType: 'BATCH',
      partNumberId: null, stationId: 99999 },
  ];
  const r = Core.pickTreatmentTime(times, { partNumberId: 3027539, stationId: 12093 });
  assert.equal(r.cycleTimeMinutes, 12, 'debe ganar el override del PN, no el comodín');
  assert.equal(r.treatmentTimeMinutes, 45, 'treatmentTimeMinutes sale de totalTime');
});

test('pickTreatmentTime: un override de OTRA estación se descarta, no se aproxima', () => {
  const times = [{ cycleTime: { minutes: 99 }, totalTime: { minutes: 99 }, stationId: 99999 }];
  assert.equal(Core.pickTreatmentTime(times, { stationId: 12093 }), null);
  assert.equal(Core.pickTreatmentTime([], { stationId: 1 }), null);
});

test('pickTreatmentTime: el comodín aplica cuando no hay override', () => {
  const r = Core.pickTreatmentTime([FX._treatmentTimeEjemplo.nodo], { partNumberId: 1, stationId: 2 });
  assert.equal(r.cycleTimeMinutes, 20);
  assert.equal(r.treatmentTimeMinutes, 30);
  assert.equal(r.timeType, 'BATCH');
});

test('buildScheduleTaskCreateInput: sin cuenta de piezas NO arma payload', () => {
  const base = {
    scheduleId: 454, treatmentId: 99431, stationId: 12093, expectedStartTime: 'x',
    cycleTimeMinutes: 12, treatmentTimeMinutes: 45, partCount: 10, partsPerBatch: 5,
    partSetUuid: 'u', recipeNodeId: 1, partNumberId: 2,
  };
  assert.equal(Core.buildScheduleTaskCreateInput({ ...base, relatedPartTransferAccounts: [] }), null);
  // y sin los campos obligatorios tampoco
  assert.equal(Core.buildScheduleTaskCreateInput({ ...base, stationId: null,
    relatedPartTransferAccounts: [{ id: 1, partCount: 10 }] }), null);
});

test('partsPerBatchFrom: piezas por rack × racks de la estación', () => {
  assert.equal(Core.partsPerBatchFrom(1501, 1), 1501);   // el caso capturado
  assert.equal(Core.partsPerBatchFrom(120, 4), 480);
  assert.equal(Core.partsPerBatchFrom(50, null), 50);    // sin rackCount → 1 rack
  assert.equal(Core.partsPerBatchFrom(0, 3), null);
});

// El CREATE sí devuelve la tarea creada — a diferencia del UPDATE, que no confirma nada.
test('parseCreatedScheduleTasks lee la confirmación real del servidor', () => {
  const r = Core.parseCreatedScheduleTasks(FX.respuesta);
  assert.equal(r.length, 1);
  assert.equal(r[0].taskId, 88629);
  assert.equal(r[0].stationId, 12093);
  assert.equal(r[0].status, 'QUEUED');
  assert.equal(r[0].totalTimeMinutes, 141);
  assert.equal(r[0].cycleTimeMinutes, 12);
});

test('parseCreatedScheduleTasks: respuesta vacía o rara → [] (no truena)', () => {
  assert.deepEqual(Core.parseCreatedScheduleTasks({}), []);
  assert.deepEqual(Core.parseCreatedScheduleTasks(null), []);
});

// ══════════════════════════════════════════════════════════════════════════
// Datos maestros faltantes — detectar el daño y corregirlo en la fuente
// ══════════════════════════════════════════════════════════════════════════
// El caso que reportó el operador: el tratamiento genérico de Planificación sin tiempos,
// o el rack type sin piezas por carga. El segundo NO falla, CALCULA: asume 1 pieza por
// carga y la duración se vuelve irreal. Ese es el modo de fallo peligroso, porque entra
// al planificador con cara de dato bueno.

const TT_OK = { cycleTimeMinutes: 12, treatmentTimeMinutes: 45 };

test('SIN piezas por rack: se detecta y se MIDE el disparate', () => {
  const d = Core.diagnoseSchedulingData({ partCount: 13504, partsPerRack: null, treatmentTime: TT_OK });
  assert.equal(d.ok, false, 'debe bloquear: 1 pieza por carga no es un default aceptable');
  const p = d.problemas.find((x) => x.codigo === 'SIN_PIEZAS_POR_RACK');
  assert.ok(p);
  assert.equal(p.lotes, 13504, 'a 1 pieza por carga, tantas cargas como piezas');
  // 45 + 13503*12 = 162081 min ≈ 112.6 días — el número que hace obvio el problema
  assert.equal(p.minutos, 45 + 13503 * 12);
  assert.match(p.efecto, /días/);
  assert.ok(p.donde, 'debe decir DÓNDE se corrige');
});

test('SIN tiempos de tratamiento: bloquea (no hay con qué calcular)', () => {
  const d = Core.diagnoseSchedulingData({ partCount: 100, partsPerRack: 50, treatmentTime: null });
  assert.equal(d.ok, false);
  assert.equal(d.problemas[0].codigo, 'SIN_TIEMPOS');
});

test('con los datos completos no estorba', () => {
  const d = Core.diagnoseSchedulingData({ partCount: 13504, partsPerRack: 1501, rackCount: 1, treatmentTime: TT_OK });
  assert.equal(d.ok, true);
  assert.deepEqual(d.problemas, []);
});

test('una pieza sola NO se reporta como rack faltante', () => {
  // con partCount 1 el rack da igual: 1 carga de todos modos, no hay disparate que avisar
  const d = Core.diagnoseSchedulingData({ partCount: 1, partsPerRack: null, treatmentTime: TT_OK });
  assert.equal(d.problemas.some((p) => p.codigo === 'SIN_PIEZAS_POR_RACK'), false);
});

test('duración desbocada AVISA aunque los datos estén presentes', () => {
  // datos completos pero absurdos: 10000 piezas de a 1 por carga "declarada"
  const d = Core.diagnoseSchedulingData({ partCount: 10000, partsPerRack: 1, rackCount: 1, treatmentTime: TT_OK });
  const p = d.problemas.find((x) => x.codigo === 'DURACION_IMPLAUSIBLE');
  assert.ok(p, 'más de una semana en una tina merece freno');
  assert.equal(p.bloquea, false, 'avisa, pero puede ser legítimo → no bloquea');
  assert.equal(d.ok, true);
});

// ── Corregir el dato en la fuente ────────────────────────────────────────────
test('planPartsPerRackFix elige CREATE o UPDATE — no son intercambiables', () => {
  // SavePartNumberRackTypes es insert-only y revienta con unique constraint en (pn,rack):
  // por eso la corrección de un par que YA existe tiene que ir por la de update.
  const nuevo = Core.planPartsPerRackFix({ partNumberId: 3770957, rackTypeId: 3049, partsPerRack: 1 });
  assert.equal(nuevo.op, 'CreatePartNumberPerPerRackType');
  assert.deepEqual(nuevo.variables, { partNumberId: 3770957, partsPerRack: 1, rackTypeId: 3049 });

  const existente = Core.planPartsPerRackFix({ partNumberId: 3770957, rackTypeId: 3049, partsPerRack: 2, yaExiste: true });
  assert.equal(existente.op, 'UpdatePartNumberPerPerRackType');
  assert.deepEqual(existente.variables, { partNumberId: 3770957, partsPerRack: 2, rackTypeId: 3049 });
});

test('planPartsPerRackFix rechaza valores que volverían a romper el cálculo', () => {
  const base = { partNumberId: 1, rackTypeId: 2 };
  assert.equal(Core.planPartsPerRackFix({ ...base, partsPerRack: 0 }).valid, false);
  assert.equal(Core.planPartsPerRackFix({ ...base, partsPerRack: -3 }).valid, false);
  assert.equal(Core.planPartsPerRackFix({ ...base, partsPerRack: 2.5 }).valid, false);
  assert.equal(Core.planPartsPerRackFix({ ...base, partsPerRack: '' }).valid, false);
  assert.equal(Core.planPartsPerRackFix({ partsPerRack: 5 }).valid, false);
});

test('minutesToInterval: el server habla Interval, no minutos', () => {
  assert.deepEqual(Core.minutesToInterval(7), { hours: 0, minutes: 7 });   // el capturado
  assert.deepEqual(Core.minutesToInterval(141), { hours: 2, minutes: 21 });
  assert.deepEqual(Core.minutesToInterval(0), { hours: 0, minutes: 0 });
  assert.deepEqual(Core.minutesToInterval(1.5), { hours: 0, minutes: 1, seconds: 30 });
  assert.equal(Core.minutesToInterval(-1), null);
});

test('buildTreatmentTimeCreateInput reproduce el payload capturado', () => {
  const out = Core.buildTreatmentTimeCreateInput({
    treatmentId: 88795, stationId: 12098, cycleTimeMinutes: 7, totalTimeMinutes: 7, timeType: 'BATCH',
  });
  assert.deepEqual(out, { input: { treatmentTimesToCreate: [{
    treatmentId: 88795, stationId: 12098, processNodeOccurrence: null,
    cycleTime: { hours: 0, minutes: 7 }, totalTime: { hours: 0, minutes: 7 }, timeType: 'BATCH',
  }] } });
});

test('buildTreatmentTimeCreateInput: un ciclo mayor que el total es imposible → null', () => {
  assert.equal(Core.buildTreatmentTimeCreateInput({
    treatmentId: 1, stationId: 2, cycleTimeMinutes: 30, totalTimeMinutes: 10 }), null);
  assert.equal(Core.buildTreatmentTimeCreateInput({ treatmentId: 1, cycleTimeMinutes: 1, totalTimeMinutes: 2 }), null);
});

// ══════════════════════════════════════════════════════════════════════════
// El rack depende de la ESTACIÓN: re-rutear cambia cuántas piezas caben
// ══════════════════════════════════════════════════════════════════════════
// Datos REALES (SchedulablePartLocations, scan 2026-07-07): el PN 3015610 tiene 4 piezas
// por carga en T204-FL01 y 1 en T205-FL01. Mismo número de parte, distinta línea, distinta
// carga. Por eso al re-rutear el dato de la línea nueva puede NO EXISTIR — y entonces no se
// corrige el que hay (que está bien para SU línea): se AGREGA el que falta.
const PN_RACKS_REAL = [
  { partNumberId: 3015610, partsPerRack: 1, rackTypeId: 2706, rackTypeByRackTypeId: { id: 2706, name: 'T205-FL01', archivedAt: null } },
  { partNumberId: 3015610, partsPerRack: 4, rackTypeId: 2705, rackTypeByRackTypeId: { id: 2705, name: 'T204-FL01', archivedAt: null } },
];
const estacionCon = (rackTypeId, name, rackCount = 1) => ([
  { stationId: 1, rackCount: rackCount, rackTypeId: rackTypeId, rackTypeByRackTypeId: { id: rackTypeId, name: name, archivedAt: null } },
]);

test('resolveRackForStation: la línea que YA tiene el dato lo usa', () => {
  const r = Core.resolveRackForStation({
    stationRackTypes: estacionCon(2705, 'T204-FL01'), partNumberRackTypes: PN_RACKS_REAL });
  assert.equal(r.rackTypeId, 2705);
  assert.equal(r.partsPerRack, 4, 'T204-FL01 → 4 piezas por carga');
  assert.equal(r.yaExiste, true, 'existe → la corrección sería UPDATE');
});

test('resolveRackForStation: la otra línea tiene OTRO valor, no el mismo', () => {
  const r = Core.resolveRackForStation({
    stationRackTypes: estacionCon(2706, 'T205-FL01'), partNumberRackTypes: PN_RACKS_REAL });
  assert.equal(r.partsPerRack, 1, 'T205-FL01 → 1 pieza por carga, no 4');
  assert.equal(r.yaExiste, true);
});

test('re-rutear a una línea SIN el dato → hay que AGREGAR, no corregir', () => {
  // T114-FL01 (rack 2701, el de la station 12093 del payload real) no está ligado al PN
  const r = Core.resolveRackForStation({
    stationRackTypes: estacionCon(2701, 'T114-FL01'), partNumberRackTypes: PN_RACKS_REAL });
  assert.equal(r.rackTypeId, 2701);
  assert.equal(r.partsPerRack, null, 'no existe el par (PN, T114-FL01)');
  assert.equal(r.yaExiste, false, 'debe ir por CREATE: el insert-only no puede pisar nada');
  // y ofrece las otras líneas como referencia para capturar con criterio
  assert.deepEqual(r.alternativas.map((a) => [a.rackTypeName, a.partsPerRack]).sort(),
    [['T204-FL01', 4], ['T205-FL01', 1]]);
});

test('el diagnóstico DISTINGUE agregar de corregir, y nombra el rack', () => {
  const rack = Core.resolveRackForStation({
    stationRackTypes: estacionCon(2701, 'T114-FL01'), partNumberRackTypes: PN_RACKS_REAL });
  const d = Core.diagnoseSchedulingData({ partCount: 13504, partsPerRack: rack.partsPerRack,
    rack: rack, treatmentTime: TT_OK });
  const p = d.problemas.find((x) => x.codigo === 'SIN_PIEZAS_POR_RACK');
  assert.equal(p.accion, 'AGREGAR', 'el dato de T204/T205 está bien: falta el de T114');
  assert.match(p.que, /T114-FL01/, 'debe nombrar el rack de la estación destino');
  assert.equal(p.rackTypeId, 2701);
  assert.equal(p.alternativas.length, 2, 'muestra lo que sí tiene como referencia');
});

test('planPartsPerRackFix se alimenta del resolve: agrega sin pisar lo existente', () => {
  const rack = Core.resolveRackForStation({
    stationRackTypes: estacionCon(2701, 'T114-FL01'), partNumberRackTypes: PN_RACKS_REAL });
  const plan = Core.planPartsPerRackFix({ partNumberId: 3015610, rackTypeId: rack.rackTypeId,
    partsPerRack: 1501, yaExiste: rack.yaExiste });
  assert.equal(plan.op, 'CreatePartNumberPerPerRackType');
  assert.deepEqual(plan.variables, { partNumberId: 3015610, partsPerRack: 1501, rackTypeId: 2701 });
});

test('resolveRackForStation: rack ARCHIVADO no es candidato', () => {
  const r = Core.resolveRackForStation({
    stationRackTypes: [{ rackCount: 1, rackTypeId: 9, rackTypeByRackTypeId: { id: 9, name: 'Viejo', archivedAt: '2025-01-01' } }],
    partNumberRackTypes: PN_RACKS_REAL });
  assert.equal(r.sinRackEnEstacion, true);
});

test('estación sin ningún rack configurado se reporta aparte', () => {
  const rack = Core.resolveRackForStation({ stationRackTypes: [], partNumberRackTypes: PN_RACKS_REAL });
  const d = Core.diagnoseSchedulingData({ partCount: 100, partsPerRack: null, rack: rack, treatmentTime: TT_OK });
  assert.equal(d.problemas.some((p) => p.codigo === 'ESTACION_SIN_RACK'), true);
  assert.equal(d.problemas.some((p) => p.codigo === 'SIN_PIEZAS_POR_RACK'), false,
    'no culpa al PN de un rack que la estación no tiene');
  assert.equal(d.ok, false);
});

test('la estación con varios racks respeta el pedido', () => {
  const dos = estacionCon(2705, 'T204-FL01').concat(estacionCon(2706, 'T205-FL01'));
  const r = Core.resolveRackForStation({ stationRackTypes: dos, partNumberRackTypes: PN_RACKS_REAL,
    rackTypeIdPreferido: 2706 });
  assert.equal(r.rackTypeId, 2706);
  assert.equal(r.partsPerRack, 1);
  assert.equal(r.opcionesEstacion.length, 2, 'la UI necesita ofrecer las dos');
});

// ══════════════════════════════════════════════════════════════════════════
// Qué se puede programar: los tratamientos ANCLA (corrección del operador)
// ══════════════════════════════════════════════════════════════════════════
// La v1 del modal ofrecía TODAS las tinas — mal. Solo se programa la orden completa
// contemplando el/los tratamiento(s) ancla: los que corren en estación CON CALENDARIO
// ("Listo para procesar", satélites). El marcador es el grupo de tratamiento 2344
// (Planificación), confirmado con datos reales de RelatedSchedulingTreatments.
const GRUPOS_REAL = {          // salida real: 2344 = Planificación, 2346 = tina normal
  82789: { groupId: 2344, name: 'T110 (PLA)-CU-VARIOS' },
  82801: { groupId: 2344, name: 'T202 (PLA)-CU-VARIOS' },
  82877: { groupId: 2346, name: 'TR-PRM-001 Antitarnish Manual' },
};

test('parseTreatmentGroups lee el grupo de cada tratamiento', () => {
  const g = Core.parseTreatmentGroups({ allTreatments: { nodes: [
    { id: 82789, name: 'T110 (PLA)-CU-VARIOS', treatmentGroupByTreatmentGroupId: { id: 2344 } },
    { id: 82877, name: 'TR-PRM-001 Antitarnish Manual', treatmentGroupByTreatmentGroupId: { id: 2346 } },
  ] } });
  assert.equal(g[82789].groupId, Core.PLANNING_TREATMENT_GROUP_ID);
  assert.equal(g[82877].groupId, 2346);
});

test('pickAnchorSteps deja SOLO los anclas — no las tinas', () => {
  const nodos = [
    { id: 1, name: 'T110 Listo para Procesar', treatmentId: 82789, defaultStation: { id: 100, name: 'T110-LI Plata Colgado (26)' } },
    { id: 2, name: 'Antitarnish', treatmentId: 82877, defaultStation: { id: 200, name: 'T110-TI00-007 Antitarnish' } },
    { id: 3, name: 'Enjuague', treatmentId: 82877, defaultStation: { id: 201, name: 'T110-TI00-008 Enjuague' } },
  ];
  const anclas = Core.pickAnchorSteps(nodos, GRUPOS_REAL, {});
  assert.equal(anclas.length, 1, 'una tina normal NO es programable');
  assert.equal(anclas[0].recipeNodeId, 1);
  assert.equal(anclas[0].lineCode, 'T110');
});

test('una orden en DOS líneas da dos anclas (se programa en las dos)', () => {
  const nodos = [
    { id: 1, name: 'T110 Listo', treatmentId: 82789, defaultStation: { id: 100, name: 'T110-LI Plata Colgado (26)' } },
    { id: 5, name: 'T202 Listo', treatmentId: 82801, defaultStation: { id: 300, name: 'T202-LI Plata Selectiva (16.2)' } },
  ];
  const anclas = Core.pickAnchorSteps(nodos, GRUPOS_REAL, {});
  assert.deepEqual(anclas.map((a) => a.lineCode), ['T110', 'T202']);
});

test('pickAnchorSteps respeta la RUTA ACTIVA sobre la estación default', () => {
  const nodos = [{ id: 1, name: 'Listo', treatmentId: 82789, defaultStation: { id: 100, name: 'T110-LI' } }];
  const anclas = Core.pickAnchorSteps(nodos, GRUPOS_REAL, { 1: 999 });
  assert.equal(anclas[0].stationId, 999, 'si ya se ruteó, se programa donde quedó');
});

test('un ancla sin estación no se ofrece', () => {
  const nodos = [{ id: 1, name: 'Listo', treatmentId: 82789, defaultStation: null }];
  assert.deepEqual(Core.pickAnchorSteps(nodos, GRUPOS_REAL, {}), []);
});

// ── El rack default sigue a la LÍNEA que se programa ─────────────────────────
// Caso reportado con captura: programando en T109, el modal ofrecía T111-RA01 — el primer
// rack ligado al PN, que es de otra línea.
const CATALOGO = [
  { id: 2657, name: 'T111-RA01', partsPerRackDefault: 45 },
  { id: 2701, name: 'T109-RA01', partsPerRackDefault: 60 },
  { id: 2705, name: 'T204-FL01', partsPerRackDefault: 4 },
];

test('el rack default es el de la LÍNEA que se programa, no el primero del PN', () => {
  const pnRacks = [{ rackTypeId: 2657, partsPerRack: 45 }];   // el PN solo tiene el de T111
  const r = Core.pickRackForLine(CATALOGO, pnRacks, 'T109');
  assert.equal(r.rackTypeName, 'T109-RA01', 'programando en T109 no puede ofrecer T111-RA01');
  assert.equal(r.yaExiste, false, 'y avisa que hay que AGREGAR las piezas por carga');
  assert.equal(r.partsPerRack, null);
});

test('si el PN ya tiene piezas en un rack DE ESA línea, se prefiere ése', () => {
  const cat = CATALOGO.concat([{ id: 2702, name: 'T109-RA02', partsPerRackDefault: 30 }]);
  const pnRacks = [{ rackTypeId: 2702, partsPerRack: 33 }];
  const r = Core.pickRackForLine(cat, pnRacks, 'T109');
  assert.equal(r.rackTypeName, 'T109-RA02');
  assert.equal(r.partsPerRack, 33);
  assert.equal(r.yaExiste, true);
});

test('sin rack de esa línea cae a lo que el PN use (y no truena sin catálogo)', () => {
  const r = Core.pickRackForLine(CATALOGO, [{ rackTypeId: 2705, partsPerRack: 4 }], 'T999');
  assert.equal(r.rackTypeName, 'T204-FL01');
  assert.equal(Core.pickRackForLine([], [], 'T109'), null);
});

test('lineCodeOf saca la línea de estaciones y de tratamientos', () => {
  assert.equal(Core.lineCodeOf('T109-EN00-001 Carga de Barril'), 'T109');
  assert.equal(Core.lineCodeOf('T110 (PLA)-CU-VARIOS'), 'T110');
  assert.equal(Core.lineCodeOf('TR-PRM-001 Antitarnish'), null);
  assert.equal(Core.lineCodeOf(null), null);
});

// ---------- isStaleNode: la celda inyectada que quedó de OTRA orden ----------
// React recicla los <tr> al filtrar/ordenar/paginar. El glue solo miraba si nuestra celda
// EXISTÍA, así que sobrevivía con el dato de la orden anterior — el mismo bug que se reportó
// en piso el 2026-07-31 sobre el applet hermano pn-specs-column (al archivar un NP).

test('isStaleNode: el id cambió → reconstruir', () => {
  assert.equal(Core.isStaleNode('15074', 15075), true);
});

test('isStaleNode: mismo id → conservar (compara como texto, no por tipo)', () => {
  assert.equal(Core.isStaleNode('15074', 15074), false);
  assert.equal(Core.isStaleNode(15074, '15074'), false);
});

test('isStaleNode: celda nuestra sin data-sa-woid → reconstruir', () => {
  // En wo-listing-columns la celda podía nacer sin atributo (fila que aún no resolvía su link)
  // y, sin revalidación, quedarse huérfana mostrando "—" para siempre.
  assert.equal(Core.isStaleNode(null, 15074), true);
  assert.equal(Core.isStaleNode('', 15074), true);
});

test('isStaleNode: fila sin id resuelto NO se reconstruye', () => {
  // No está reciclada: todavía no resuelve. Reconstruir ahí borraría celdas buenas en cada sync
  // y el MutationObserver entraría en bucle.
  assert.equal(Core.isStaleNode('15074', null), false);
  assert.equal(Core.isStaleNode(null, null), false);
});

test('isStaleNode: la gemela de pn-specs-column NO diverge', () => {
  // Vive en los dos cores porque son applets de rutas distintas que no comparten core. La
  // duplicación solo es aceptable mientras se comporten igual: este test lo obliga.
  const Pn = require('../../remote/scripts/pn-specs-column-core.js');
  const casos = [['1', 2], ['2', 2], [2, '2'], [null, 2], ['', 2], ['1', null], [null, null],
                 [undefined, 5], ['0', 0], [0, '0']];
  for (const [attr, id] of casos) {
    assert.equal(Core.isStaleNode(attr, id), Pn.isStaleNode(attr, id),
      `divergen en (${JSON.stringify(attr)}, ${JSON.stringify(id)})`);
  }
});
