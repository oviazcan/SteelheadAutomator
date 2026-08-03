// tools/test/schedule-batch-group-core.test.js
// Golden tests del núcleo puro "Agrupar lote en una tarea del programa".
// Run: node --test tools/test/schedule-batch-group-core.test.js
//
// Los dos fixtures son REALES (scan del 2026-07-30, Schedule Board 454 / dominio 344):
//   - schedule-batch-group-board.json    → RelatedSchedulingInformation + SchedulablePartLocations
//   - schedule-batch-group-created.json  → el payload de CreateManyScheduleTasks capturado al
//                                          guardar el Task Builder (1 tarea AGRUPADA, 5 elementos)
// El golden que manda es "reproducir el payload real byte a byte": si el núcleo se desvía del
// que el ERP aceptó, el test se pone rojo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../../remote/scripts/schedule-batch-group-core.js');

const FIX = path.join(__dirname, 'fixtures');
const board = JSON.parse(fs.readFileSync(path.join(FIX, 'schedule-batch-group-board.json'), 'utf8'));
const created = JSON.parse(fs.readFileSync(path.join(FIX, 'schedule-batch-group-created.json'), 'utf8'));

const RELATED = board.relatedSchedulingInformation;
const LOCATIONS = board.schedulablePartLocations.allPartLocations.nodes;

// ───────────────────────── intervalToMinutes ─────────────────────────

test('intervalToMinutes: convierte el Interval de Postgres', () => {
  assert.equal(Core.intervalToMinutes({ hours: 0, minutes: 45, seconds: 0 }), 45);
  assert.equal(Core.intervalToMinutes({ hours: 1, minutes: 30, seconds: 0 }), 90);
  assert.equal(Core.intervalToMinutes({ minutes: 0, seconds: 30 }), 0.5);
  assert.equal(Core.intervalToMinutes({ days: 1 }), 1440);
});

test('intervalToMinutes: null/basura → null (no 0)', () => {
  // 0 significaría "instantáneo" y pasaría los guardas; null significa "no sé".
  assert.equal(Core.intervalToMinutes(null), null);
  assert.equal(Core.intervalToMinutes(undefined), null);
  assert.equal(Core.intervalToMinutes('45'), null);
});

// ───────────────────────── índices de la respuesta ─────────────────────────

test('indexBatchesByWorkOrder: mapea orden → lotes recibidos', () => {
  const idx = Core.indexBatchesByWorkOrder(RELATED);
  assert.deepEqual(idx[1917243], [{ id: 1439287, idInDomain: 17315, name: 'T-2150' }]);
  assert.equal(idx[1913027][0].name, '4501082321');
});

test('indexBatchesByWorkOrder: "T-2150" son lotes DISTINTOS con el mismo nombre', () => {
  // El ERP crea un inventory batch por orden. Agrupar por id sería no agrupar nada:
  // la unidad operativa es el NOMBRE. Este test fija esa lectura.
  const idx = Core.indexBatchesByWorkOrder(RELATED);
  const t2150 = Object.keys(idx)
    .filter((wo) => idx[wo].some((b) => b.name === 'T-2150'))
    .map((wo) => idx[wo].find((b) => b.name === 'T-2150').id);
  assert.equal(t2150.length, 5);
  assert.equal(new Set(t2150).size, 5, 'cada orden tiene su propio id de lote');
});

test('indexSchedulableNodes: solo nodos con tratamiento, con sus tiempos', () => {
  const idx = Core.indexSchedulableNodes(RELATED);
  // Una orden con un solo nodo programable, con tiempos.
  const uno = idx[1917245];
  assert.equal(uno.length, 1);
  assert.equal(uno[0].recipeNodeId, 46956637);
  assert.equal(uno[0].treatmentId, 112623);
  assert.equal(uno[0].treatmentName, 'T204 (PLF)-CU-VARIOS');
  assert.equal(uno[0].type, 'SCANNER_NODE');
  assert.ok(uno[0].times, 'trae tiempos');
});

test('indexSchedulableNodes: DOS nodos = dos tratamientos encadenados, no ambigüedad', () => {
  // Lo confirma el payload real: las mismas 5 piezas salen en 2 tareas (112435 y luego 91495).
  const idx = Core.indexSchedulableNodes(RELATED);
  const dos = idx[1877811];
  assert.equal(dos.length, 2);
  assert.deepEqual(dos.map((n) => n.treatmentId), [112435, 91495]);
});

test('indexSchedulableNodes: orden sin nodo programable → arreglo vacío', () => {
  const idx = Core.indexSchedulableNodes(RELATED);
  assert.deepEqual(idx[1913027] || [], []);
});

test('indexSchedulableNodes: nodo sin possibleTreatmentTimes → times null (no 0)', () => {
  const idx = Core.indexSchedulableNodes(RELATED);
  assert.equal(idx[1838072][0].treatmentId, 96342);
  assert.equal(idx[1838072][0].times, null, 'sin tiempos NO se inventa un 0');
});

test('indexStations: tratamientos y rack types por estación', () => {
  const sts = Core.indexStations(RELATED);
  const t114 = sts.find((s) => s.stationId === 12093);
  assert.equal(t114.name, 'T114-LI Fosfato de Manganeso (7.1)');
  assert.ok(t114.treatmentIds.includes(99431));
  assert.deepEqual(t114.rackTypes, [{ rackTypeId: 2701, rackTypeName: 'T114-FL01', rackCount: 1, treatmentId: null }]);
  const t116 = sts.find((s) => s.stationId === 12105);
  assert.deepEqual(t116.rackTypes, [], 'estación sin rack types declarados');
});

// ───────────────────────── piezas por lote (partsPerBatch) ─────────────────────────

test('partsPerBatchFor: partsPerRack del PN × rackCount de la estación', () => {
  const sts = Core.indexStations(RELATED);
  const st = { ...sts.find((s) => s.stationId === 12093) };
  // El PN de la WO 1917243 declara T110-FL01 (rackTypeId 2699) = 12 piezas por rack.
  st.rackTypes = [{ rackTypeId: 2699, rackTypeName: 'T110-FL01', rackCount: 2, treatmentId: null }];
  const loc = LOCATIONS.find((l) => l.workOrderId === 1917243);
  const r = Core.partsPerBatchFor({ location: loc, station: st, treatmentId: 112753 });
  assert.equal(r.partsPerBatch, 24, '12 por rack × 2 racks');
  assert.equal(r.rackTypeName, 'T110-FL01');
});

test('partsPerBatchFor: sin rack type en común → null, NUNCA 1', () => {
  // Asumir 1 en silencio es el bug que vuelve 141 min en ~112 días (wo-schedule-button 0.8.0).
  const sts = Core.indexStations(RELATED);
  const st = sts.find((s) => s.stationId === 12105); // sin rackTypes
  const loc = LOCATIONS.find((l) => l.workOrderId === 1917243);
  assert.equal(Core.partsPerBatchFor({ location: loc, station: st, treatmentId: 112753 }), null);
});

// ───────────────────────── la fórmula, contra el payload REAL ─────────────────────────

test('groupedTaskTimes: reproduce las DOS tareas del payload capturado', () => {
  // total = treatment + (Σ ceil(partCount/partsPerBatch) − 1) × cycle
  // Los lotes se SUMAN entre elementos; calcularlos por elemento daría otro número.
  for (const real of created.variables.scheduledTasks.mnScheduleTask) {
    const elements = real.scheduleTaskElementsByScheduleTaskId.nodes.map((e) => ({
      partCount: e.partCount, partsPerBatch: e.partsPerBatch,
    }));
    const t = Core.groupedTaskTimes(elements, {
      cycleTimeMinutes: real.cycleTimeMinutes,
      treatmentTimeMinutes: real.treatmentTimeMinutes,
    });
    assert.equal(t.batches, 41, 'suma de lotes de los 5 elementos');
    assert.equal(t.totalTimeMinutes, real.totalTimeMinutes);
  }
});

test('groupedTaskTimes: un solo lote → dura lo que el tratamiento', () => {
  const t = Core.groupedTaskTimes([{ partCount: 5, partsPerBatch: 10 }],
    { cycleTimeMinutes: 30, treatmentTimeMinutes: 45 });
  assert.equal(t.batches, 1);
  assert.equal(t.totalTimeMinutes, 45);
});

test('groupedTaskTimes: dato faltante → null (no calcula a ciegas)', () => {
  const ok = { cycleTimeMinutes: 30, treatmentTimeMinutes: 45 };
  assert.equal(Core.groupedTaskTimes([], ok), null, 'sin elementos');
  assert.equal(Core.groupedTaskTimes([{ partCount: 5, partsPerBatch: null }], ok), null);
  assert.equal(Core.groupedTaskTimes([{ partCount: 5, partsPerBatch: 0 }], ok), null);
  assert.equal(Core.groupedTaskTimes([{ partCount: null, partsPerBatch: 2 }], ok), null);
  assert.equal(Core.groupedTaskTimes([{ partCount: 5, partsPerBatch: 2 }], null), null);
  assert.equal(Core.groupedTaskTimes([{ partCount: 5, partsPerBatch: 2 }],
    { cycleTimeMinutes: null, treatmentTimeMinutes: 45 }), null);
});

// ───────────────────────── el payload, byte a byte ─────────────────────────

test('buildGroupedScheduleTaskInput: reproduce el payload REAL de las 2 tareas', () => {
  const real = created.variables;
  const tasks = real.scheduledTasks.mnScheduleTask.map((t) => ({
    treatmentId: t.treatmentId,
    stationId: t.stationId,
    expectedStartTime: t.expectedStartTime,
    times: { cycleTimeMinutes: t.cycleTimeMinutes, treatmentTimeMinutes: t.treatmentTimeMinutes },
    isIntentional: t.isIntentional,
    elements: t.scheduleTaskElementsByScheduleTaskId.nodes.map((e) => ({
      partSetUuid: e.partSetUuid,
      recipeNodeId: e.recipeNodeId,
      partNumberId: e.partNumberId,
      partCount: e.partCount,
      partsPerBatch: e.partsPerBatch,
      rackIdLineage: e.rackIdLineage,
      rackTypeIdLineage: e.rackTypeIdLineage,
      accounts: e.relatedPartTransferAccounts.map((a) => ({ id: a.id, partCount: a.partCount })),
    })),
  }));
  const out = Core.buildGroupedScheduleTaskInput({ scheduleId: 454, tasks });
  assert.deepEqual(out, real);
});

test('buildGroupedScheduleTaskInput: rechaza lo que no puede escribir bien', () => {
  const base = {
    treatmentId: 112435, stationId: 12099, expectedStartTime: '2026-07-31T01:56:56.974Z',
    times: { cycleTimeMinutes: 30, treatmentTimeMinutes: 45 },
    elements: [{ partSetUuid: 'u1', recipeNodeId: 1, partNumberId: 2, partCount: 4,
                 partsPerBatch: 1, accounts: [{ id: 9, partCount: 4 }] }],
  };
  assert.equal(Core.buildGroupedScheduleTaskInput({ scheduleId: null, tasks: [base] }), null);
  assert.equal(Core.buildGroupedScheduleTaskInput({ scheduleId: 454, tasks: [] }), null);
  assert.equal(Core.buildGroupedScheduleTaskInput({ scheduleId: 454,
    tasks: [{ ...base, elements: [] }] }), null, 'tarea sin elementos');
  assert.equal(Core.buildGroupedScheduleTaskInput({ scheduleId: 454,
    tasks: [{ ...base, elements: [{ ...base.elements[0], accounts: [] }] }] }), null,
    'elemento sin cuenta: no hay material que programar');
  assert.equal(Core.buildGroupedScheduleTaskInput({ scheduleId: 454,
    tasks: [{ ...base, stationId: null }] }), null);
});

// ───────────────────────── armado de grupos ─────────────────────────

const GROUP_ARGS = { relatedInfo: RELATED, partLocations: LOCATIONS };

test('buildBatchGroups: agrupa por NOMBRE de lote y parte por tratamiento', () => {
  // T-2150 son 5 órdenes: 2 van a T110 (112753) y 3 a T204 (112623) → 2 grupos, nunca 1 revuelto.
  const groups = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['T-2150'] });
  assert.equal(groups.length, 2);
  const porTrat = Object.fromEntries(groups.map((g) => [g.treatmentId, g]));
  assert.equal(porTrat[112623].elements.length, 3);
  assert.equal(porTrat[112753].elements.length, 2);
  for (const g of groups) assert.equal(g.batchName, 'T-2150');
});

test('buildBatchGroups: una orden con 2 tratamientos entra en los 2 grupos', () => {
  const groups = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['RG-M379522'] });
  assert.deepEqual(groups.map((g) => g.treatmentId).sort((a, b) => a - b), [91495, 112435]);
  for (const g of groups) assert.equal(g.elements.length, 3, 'las 3 órdenes del lote');
});

test('buildBatchGroups: NUNCA mezcla lotes distintos en un grupo', () => {
  const groups = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['1928-66-1-8272', '1928-66-2-8272'] });
  assert.equal(groups.length, 2, 'mismo tratamiento, pero son lotes distintos');
  assert.deepEqual(groups.map((g) => g.batchName).sort(),
    ['1928-66-1-8272', '1928-66-2-8272']);
  for (const g of groups) assert.equal(g.elements.length, 1);
});

test('buildBatchGroups: sin names = todos los lotes del tablero, uno por lote', () => {
  const groups = Core.buildBatchGroups(GROUP_ARGS);
  const nombres = new Set(groups.map((g) => g.batchName));
  assert.ok(nombres.has('T-2150') && nombres.has('RG-M379522'));
  assert.ok(!nombres.has('4501082321'), 'sin nodo programable no produce grupo');
  for (const g of groups) {
    assert.equal(new Set(g.elements.map((e) => e.batchName || g.batchName)).size, 1);
  }
});

test('buildBatchGroups: el elemento lleva lo que el payload necesita', () => {
  const g = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['T-2150'] })
    .find((x) => x.treatmentId === 112623);
  const el = g.elements.find((e) => e.workOrderId === 1917245);
  assert.equal(el.recipeNodeId, 46956637);
  assert.equal(el.partNumberId, 3014646);
  assert.equal(el.partCount, 1);
  assert.deepEqual(el.accounts, [{ id: 44946612, partCount: 1 }]);
  assert.equal(el.partNumberName, '80095-402-01');
});

test('buildBatchGroups: nombre inexistente → sin grupos, sin ruido', () => {
  assert.deepEqual(Core.buildBatchGroups({ ...GROUP_ARGS, names: ['NO-EXISTE'] }), []);
});

// ───────────────────────── fail-safes: cuándo NO se agrupa ─────────────────────────

test('diagnoseGroup: sin tiempos de tratamiento → bloqueado', () => {
  const g = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['T-2150'] })
    .find((x) => x.treatmentId === 112753); // T110, possibleTreatmentTimes vacío
  const d = Core.diagnoseGroup(g, { stations: Core.indexStations(RELATED) });
  assert.equal(d.canCreate, false);
  assert.match(d.reasons.join(' '), /tiempos/i);
});

test('diagnoseGroup: tratamiento que no corre en este tablero → bloqueado y lo dice', () => {
  const g = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['T-2150'] })
    .find((x) => x.treatmentId === 112623); // T204, el board es T114/T116
  const d = Core.diagnoseGroup(g, { stations: Core.indexStations(RELATED) });
  assert.equal(d.canCreate, false);
  assert.match(d.reasons.join(' '), /tablero|estaci/i);
});

test('diagnoseGroup: sin piezas por carga → bloqueado, no asume 1', () => {
  const g = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['1928-66-1-8272'] })[0];
  const stations = Core.indexStations(RELATED); // T116 no declara rack types
  const d = Core.diagnoseGroup(g, { stations });
  assert.equal(d.canCreate, false);
  assert.match(d.reasons.join(' '), /piezas por carga|partsPerRack|carga/i);
});

test('diagnoseGroup: duración implausible → bloqueado con el número a la vista', () => {
  const g = {
    batchName: 'X', treatmentId: 106154, treatmentName: 'T116 (FZI)-FE/AC-VARIOS',
    times: { cycleTimeMinutes: 12, treatmentTimeMinutes: 45 },
    elements: [{ workOrderId: 1, recipeNodeId: 1, partNumberId: 1, partCount: 13504,
                 partsPerBatch: 1, accounts: [{ id: 1, partCount: 13504 }] }],
  };
  const d = Core.diagnoseGroup(g, {
    stations: [{ stationId: 12105, name: 'T116', treatmentIds: [106154],
                 rackTypes: [{ rackTypeId: 1, rackTypeName: 'r', rackCount: 1, treatmentId: null }] }],
  });
  assert.equal(d.canCreate, false);
  assert.match(d.reasons.join(' '), /d[íi]as|implausible/i);
});

test('diagnoseGroup: cuentas ya programadas → bloqueado (agrupar 2× no duplica)', () => {
  const g = Core.buildBatchGroups({ ...GROUP_ARGS, names: ['T-2150'] })
    .find((x) => x.treatmentId === 112623);
  const yaProgramadas = new Set(g.elements.flatMap((e) => e.accounts.map((a) => a.id)));
  const d = Core.diagnoseGroup(g, {
    stations: Core.indexStations(RELATED),
    scheduledAccountIds: yaProgramadas,
  });
  assert.equal(d.canCreate, false);
  assert.match(d.reasons.join(' '), /ya (est|program)/i);
});

test('diagnoseGroup: camino feliz → canCreate con estación y duración resueltas', () => {
  const g = {
    batchName: 'T-9', treatmentId: 106154, treatmentName: 'T116 (FZI)-FE/AC-VARIOS',
    times: { cycleTimeMinutes: 12, treatmentTimeMinutes: 45 },
    elements: [
      { workOrderId: 1, recipeNodeId: 11, partNumberId: 101, partCount: 20, partsPerBatch: 10,
        accounts: [{ id: 901, partCount: 20 }] },
      { workOrderId: 2, recipeNodeId: 12, partNumberId: 102, partCount: 15, partsPerBatch: 5,
        accounts: [{ id: 902, partCount: 15 }] },
    ],
  };
  const d = Core.diagnoseGroup(g, {
    stations: [{ stationId: 12105, name: 'T116-LI', treatmentIds: [106154],
                 rackTypes: [{ rackTypeId: 1, rackTypeName: 'T116-FL01', rackCount: 1, treatmentId: null }] }],
  });
  assert.equal(d.canCreate, true);
  assert.deepEqual(d.reasons, []);
  assert.equal(d.stationId, 12105);
  assert.equal(d.times.batches, 5, '2 lotes + 3 lotes');
  assert.equal(d.times.totalTimeMinutes, 45 + 4 * 12);
});
