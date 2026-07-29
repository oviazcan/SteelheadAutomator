// Golden tests del módulo puro wo-spec-params-core.js
// Run: node --test tools/test/wo-spec-params-core.test.js
//
// El fixture es REAL: OT 5769 / NP 80236-167-07, capturado el 2026-07-28. Los conteos de abajo
// se calcularon contra él ANTES de escribir el core. Si un test falla, el sospechoso es el core,
// no el número.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params-core.js'));
const Core = global.window.WoSpecParamsCore;

const FIX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-5769.json'), 'utf8'));

// ── Task 1: índices ──────────────────────────────────────────────────────────

test('rootParamId: usa derivedFrom cuando existe, el propio id si no', () => {
  assert.equal(Core.rootParamId({ id: 34924257, specFieldParamByDerivedFromId: { id: 12533622 } }), 12533622);
  assert.equal(Core.rootParamId({ id: 17544252, specFieldParamByDerivedFromId: null }), 17544252);
  assert.equal(Core.rootParamId(null), null);
  assert.equal(Core.rootParamId({}), null);
});

test('buildPartNumberIndex: solo activos, indexado por specFieldSpecId', () => {
  const idx = Core.buildPartNumberIndex(FIX.partNumber);
  // El Espesor de la spec Estaño (sfs 106115) tiene 3 filas archivadas y 1 activa: gana la activa.
  const espesor = idx.get(106115);
  assert.ok(espesor, 'debe existir entrada para el specFieldSpec 106115');
  assert.equal(espesor.param.id, 33666976);
  assert.equal(espesor.param.name, '5 - 10 µm');
  assert.equal(espesor.ambiguous, false);
  assert.notEqual(espesor.param.id, 28818108, 'el archivado no debe ganar');
});

test('buildPartNumberIndex: marca ambiguo si hay 2+ activos en el mismo specFieldSpec', () => {
  const pn = {
    partNumberSpecFieldParamsByPartNumberId: { nodes: [
      { id: 1, archivedAt: null, specFieldParamBySpecFieldParamId: {
          id: 10, name: 'A', specFieldSpecBySpecFieldSpecId: { id: 500 } } },
      { id: 2, archivedAt: null, specFieldParamBySpecFieldParamId: {
          id: 11, name: 'B', specFieldSpecBySpecFieldSpecId: { id: 500 } } },
    ] }
  };
  assert.equal(Core.buildPartNumberIndex(pn).get(500).ambiguous, true);
});

test('buildCatalogIndex: agrupa por specFieldId y omite specFieldSpecs archivados', () => {
  const idx = Core.buildCatalogIndex(FIX.workOrder);
  const espesor = idx.get(15630);
  assert.ok(espesor && espesor.length >= 1);
  const estano = espesor.find(c => c.specFieldSpecId === 106115);
  assert.ok(estano, 'el specFieldSpec 106115 debe estar');
  assert.equal(estano.pnwosId, 5063398);
  assert.deepEqual(estano.params.map(p => p.id).sort((a, b) => a - b), [12533622, 32594227]);
});

// ── Task 2: resolver el deseado ──────────────────────────────────────────────

test('resolveDesired: el NP manda cuando tiene el campo', () => {
  const cat = Core.buildCatalogIndex(FIX.workOrder);
  const pn = Core.buildPartNumberIndex(FIX.partNumber);
  const r = Core.resolveDesired(15630, cat, pn);
  assert.equal(r.via, 'NP');
  assert.equal(r.writeId, 32594227, 'el id del CATÁLOGO, no el del clon 33666976');
  assert.equal(r.compareId, 32594227);
  assert.equal(r.refName, '5 - 10 µm');
  assert.equal(r.pnwosId, 5063398);
});

test('resolveDesired: cae al catálogo cuando el NP no tiene el campo y hay UNA opción', () => {
  const cat = Core.buildCatalogIndex(FIX.workOrder);
  const pn = Core.buildPartNumberIndex(FIX.partNumber);
  const r = Core.resolveDesired(31018, cat, pn);   // campo de T201-LI, spec de proceso
  assert.equal(r.via, 'CATALOGO');
  assert.equal(r.writeId, 24897078);
});

test('resolveDesired: AMBIGUO si el NP no resuelve y el catálogo ofrece varias', () => {
  const cat = new Map([[999, [{ specFieldSpecId: 1, pnwosId: 7, specName: 'S', fieldName: 'F',
    params: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }]]]);
  assert.equal(Core.resolveDesired(999, cat, new Map()).via, 'AMBIGUO');
});

test('resolveDesired: AMBIGUO si el NP tiene 2+ activos en ese campo', () => {
  const cat = new Map([[999, [{ specFieldSpecId: 500, pnwosId: 7, specName: 'S', fieldName: 'F',
    params: [{ id: 1, name: 'A' }] }]]]);
  const pn = new Map([[500, { param: { id: 10 }, rowId: 1, ambiguous: true }]]);
  assert.equal(Core.resolveDesired(999, cat, pn).via, 'AMBIGUO');
});

test('resolveDesired: SIN_CATALOGO si el campo no vive en ninguna spec de la OT', () => {
  assert.equal(Core.resolveDesired(424242, new Map(), new Map()).via, 'SIN_CATALOGO');
});

// ── Task 3: equivalencia ─────────────────────────────────────────────────────

test('isEquivalent: acierta por raíz de catálogo', () => {
  const applied = { id: 34924257, name: 'x', specFieldParamByDerivedFromId: { id: 12533622 } };
  const r = Core.isEquivalent(applied, { compareId: 12533622, refName: 'otro nombre' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'raiz');
});

test('isEquivalent: acierta por id directo cuando no hay derivedFrom', () => {
  const applied = { id: 17544252, name: 'x', specFieldParamByDerivedFromId: null };
  assert.equal(Core.isEquivalent(applied, { compareId: 17544252, refName: 'y' }).ok, true);
});

test('isEquivalent: la identidad normaliza espacios y mayúsculas, pero NO acentos', () => {
  // 'Si' sin acento no es 'Sí' con acento: en un catálogo de calidad esa diferencia puede ser real
  const r = Core.isEquivalent(
    { id: 1, name: 'Si o  No', specFieldParamByDerivedFromId: { id: 17890459 } },
    { compareId: 17854613, refName: 'sí o no', refParam: null });
  assert.equal(r.ok, false);
  const r2 = Core.isEquivalent(
    { id: 1, name: 'Si o  No', specFieldParamByDerivedFromId: { id: 9 } },
    { compareId: 8, refName: 'SI O NO', refParam: null });
  assert.equal(r2.ok, true);
  assert.equal(r2.via, 'identidad');
});

test('isEquivalent: con refParam compara también los valores numéricos', () => {
  const applied = { id: 1, name: '5 - 10 µm', minimumValue: 5, maximumValue: 8, targetValue: null,
                    unitId: 3974, specFieldParamByDerivedFromId: { id: 111 } };
  const r = Core.isEquivalent(applied, { compareId: 222, refName: '5 - 10 µm',
    refParam: { name: '5 - 10 µm', minimumValue: 5, maximumValue: 10, targetValue: null, unitId: 3974 } });
  assert.equal(r.ok, false, 'mismo nombre pero distinto máximo NO equivale');
});

test('isEquivalent: el caso real de la OT 5769 — 5-8 µm NO equivale a 5-10 µm', () => {
  const applied = { id: 34924257, name: '5 - 8 µm', minimumValue: 5, maximumValue: 8, targetValue: null,
                    unitId: 3974, specFieldParamByDerivedFromId: { id: 12533622 } };
  const desired = { compareId: 32594227, refName: '5 - 10 µm',
    refParam: { name: '5 - 10 µm', minimumValue: 5, maximumValue: 10, targetValue: null, unitId: 3974 } };
  assert.equal(Core.isEquivalent(applied, desired).ok, false);
});

// ── Task 4: los dos universos ────────────────────────────────────────────────

test('findExternalSpec: la externa es la única con partNumberSpecByPartNumberSpecId', () => {
  const ext = Core.findExternalSpec(FIX.workOrder);
  assert.equal(ext.pnwosId, 5063398);
  assert.equal(ext.specName, '40004-014-01 (Estaño)');
  assert.deepEqual([...ext.fieldIds].sort((a, b) => a - b),
                   [15630, 15820, 19445, 22067, 28479, 33579]);
});

test('findInspectionNode: el QA que toca la spec externa', () => {
  const ext = Core.findExternalSpec(FIX.workOrder);
  const r = Core.findInspectionNode(FIX.workOrder, ext);
  assert.equal(r.node.id, 42513391);
  assert.equal(r.node.type, 'QUALITY_ASSURANCE_NODE');
});

test('findInspectionNode: con dos candidatos NO adivina', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  const gemelo = JSON.parse(JSON.stringify(
    wo.recipeNodesByWorkOrderId.nodes.find(n => n.id === 42513391)));
  gemelo.id = 99999; gemelo.name = 'Otro Inspeccionando';
  wo.recipeNodesByWorkOrderId.nodes.push(gemelo);
  const r = Core.findInspectionNode(wo, Core.findExternalSpec(wo));
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates.slice().sort((a, b) => a - b), [99999, 42513391]);
});

test('findInspectionNode: sin ningún candidato tampoco adivina', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  wo.recipeNodesByWorkOrderId.nodes = wo.recipeNodesByWorkOrderId.nodes
    .filter(n => n.type !== 'QUALITY_ASSURANCE_NODE');
  const r = Core.findInspectionNode(wo, Core.findExternalSpec(wo));
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates, []);
});

// Conteos VERIFICADOS contra el fixture antes de escribir el core. NO los ajustes.
//   universo EXTERNA (solo el nodo 42513391): 6 casillas → 2 DIFIERE + 4 VACIO, 1 de ellas forzada
//   universo PROCESO: el nodo 42513364 aporta 1 VACIO (campo 31018 de T201-LI)
//   el nodo raíz 42513351 NO aporta casillas: sus 5 campos son de la spec externa → anomalías
test('classifyWorkOrder: sobre el fixture real de la OT 5769', () => {
  const { cells, tally } = Core.classifyWorkOrder(FIX);
  assert.equal(tally.OK, 0);
  assert.equal(tally.VACIO, 5);
  assert.equal(tally.DIFIERE, 2);
  assert.equal(tally.DUPLICADO, 0);
  assert.equal(tally.AMBIGUO, 0);
  assert.equal(tally.SIN_CATALOGO, 0);
  assert.equal(cells.length, 7);
});

test('classifyWorkOrder: los 6 campos de la spec externa son casillas del nodo de inspección', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const ext = cells.filter(c => c.scope === 'EXTERNA');
  assert.equal(ext.length, 6);
  assert.ok(ext.every(c => c.recipeNodeId === 42513391));
});

test('classifyWorkOrder: el campo que el nodo no declara sale marcado como forzado', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const forced = cells.filter(c => c.forced);
  assert.equal(forced.length, 1);
  assert.equal(forced[0].specFieldId, 33579);        // Espesor (Intermedio)
  assert.equal(forced[0].recipeNodeId, 42513391);
});

test('classifyWorkOrder: el DIFIERE de Espesor archiva la fila vieja y escribe el id del catálogo', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const c = cells.find(x => x.recipeNodeId === 42513391 && x.specFieldId === 15630);
  assert.equal(c.status, 'DIFIERE');
  assert.deepEqual(c.toArchiveIds, [26249942]);
  assert.equal(c.toAddWriteId, 32594227);
  assert.equal(c.pnwosId, 5063398);
});

test('classifyWorkOrder: la spec externa en el nodo raíz es ANOMALÍA, no casilla', () => {
  const { cells, anomalies } = Core.classifyWorkOrder(FIX);
  assert.equal(anomalies.length, 5);
  assert.ok(anomalies.every(a => a.recipeNodeId === 42513351));
  assert.deepEqual(anomalies.map(a => a.rowId).sort((x, y) => x - y),
                   [22341384, 22341385, 22341386, 22341387, 22341388]);
  assert.equal(cells.some(c => c.recipeNodeId === 42513351), false,
               'ninguna casilla debe apuntar al nodo raíz');
});

test('classifyWorkOrder: sin nodo de inspección identificable, cero casillas de la spec externa', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  wo.recipeNodesByWorkOrderId.nodes = wo.recipeNodesByWorkOrderId.nodes
    .filter(n => n.type !== 'QUALITY_ASSURANCE_NODE');
  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: FIX.partNumber });
  assert.equal(r.cells.filter(c => c.scope === 'EXTERNA').length, 0);
  assert.equal(r.inspectionNode.ambiguous, true);
  assert.ok(r.cells.some(c => c.scope === 'PROCESO'), 'las de proceso siguen saliendo');
});

test('classifyWorkOrder: una casilla VACÍA solo agrega, no archiva', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const c = cells.find(x => x.recipeNodeId === 42513364);
  assert.equal(c.status, 'VACIO');
  assert.equal(c.scope, 'PROCESO');
  assert.deepEqual(c.toArchiveIds, []);
  assert.ok(c.toAddWriteId > 0);
});

test('classifyWorkOrder: DUPLICADO conserva la equivalente y archiva el resto', () => {
  const wo = {
    id: 1, idInDomain: 1, name: '',
    partNumberWorkOrderSpecsByWorkOrderId: { nodes: [{ id: 70, archivedAt: null,
      partNumberSpecByPartNumberSpecId: null,
      specBySpecId: { id: 5, name: 'S', specFieldSpecsBySpecId: { nodes: [{
        id: 500, archivedAt: null, specFieldId: 900, isGeneric: false,
        specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 111, name: 'Bueno' }] },
        specFieldBySpecFieldId: { id: 900, name: 'Campo', type: 'BOOLEAN' } }] } } }] },
    recipeNodesByWorkOrderId: { nodes: [{ id: 42, name: 'N', type: 'PROCESS', recipeInd: 0,
      recipeNodeSpecFieldsByRecipeNodeId: { nodes: [{ id: 1, specFieldId: 900,
        specFieldBySpecFieldId: { id: 900, name: 'Campo' } }] },
      partNumberRecipeNodeSpecFieldParamsByRecipeNodeId: { nodes: [
        { id: 8001, archivedAt: null, specFieldId: 900, recipeNodeId: 42,
          partNumberWorkOrderSpecByDrivenBy: { id: 70 },
          specFieldParamBySpecFieldParamId: { id: 9001, name: 'Bueno',
            specFieldParamByDerivedFromId: { id: 111 }, specFieldSpecBySpecFieldSpecId: { id: 500 } } },
        { id: 8002, archivedAt: null, specFieldId: 900, recipeNodeId: 42,
          partNumberWorkOrderSpecByDrivenBy: { id: 70 },
          specFieldParamBySpecFieldParamId: { id: 9002, name: 'Sobrante',
            specFieldParamByDerivedFromId: { id: 222 }, specFieldSpecBySpecFieldSpecId: { id: 500 } } },
      ] } }] }
  };
  const { cells, tally } = Core.classifyWorkOrder({ workOrder: wo,
    partNumber: { partNumberSpecFieldParamsByPartNumberId: { nodes: [] } } });
  assert.equal(tally.DUPLICADO, 1);
  assert.deepEqual(cells[0].toArchiveIds, [8002], 'conserva la equivalente 8001');
  assert.equal(cells[0].toAddWriteId, null, 'ya hay una buena viva: no se agrega nada');
});

test('classifyWorkOrder: una fila de proceso sin campo declarado es huérfana y se reporta', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  const node = wo.recipeNodesByWorkOrderId.nodes.find(n => n.id === 42513364);
  node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes.push({
    id: 7777, archivedAt: null, specFieldId: 99999, recipeNodeId: 42513364,
    specFieldBySpecFieldId: { id: 99999, name: 'Campo fantasma' },
    partNumberWorkOrderSpecByDrivenBy: { id: 5063402 },
    specFieldParamBySpecFieldParamId: { id: 1, name: 'X', specFieldSpecBySpecFieldSpecId: { id: 1 } }
  });
  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: FIX.partNumber });
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].rowId, 7777);
  assert.equal(r.orphans[0].specFieldId, 99999);
});

test('classifyWorkOrder: AMBIGUO no propone ninguna escritura', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  for (const c of cells) {
    if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') {
      assert.deepEqual(c.toArchiveIds, []);
      assert.equal(c.toAddWriteId, null);
    }
  }
});

// ── Task 5: plan de escritura ────────────────────────────────────────────────

test('buildWritePlan: arma el payload con la forma exacta de AddParams', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  // el nodo raíz NO entra: sus filas son anomalías, no casillas
  assert.deepEqual(plan.archiveIds.slice().sort((a, b) => a - b), [26249942, 26249943]);
  assert.equal(plan.parametersToAdd.length, 7);   // 5 vacías + 2 que difieren
  assert.equal(plan.touched, 7);
  const add = plan.parametersToAdd.find(a => a.specFieldId === 15630 && a.recipeNodeId === 42513391);
  assert.deepEqual(add, {
    specFieldId: 15630, specFieldParamId: 32594227, recipeNodeId: 42513391,
    geometryTypeSpecFieldId: null, locationId: null, drivenBy: 5063398
  });
});

test('buildWritePlan: Espesor (Intermedio) escribe "No aplica", que es lo que dice el NP', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const add = plan.parametersToAdd.find(a => a.specFieldId === 33579);
  assert.equal(add.specFieldParamId, 32596235);
});

test('buildWritePlan: no incluye AMBIGUO ni SIN_CATALOGO, y los reporta en skipped', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  for (const s of plan.skipped) {
    assert.ok(s.status === 'AMBIGUO' || s.status === 'SIN_CATALOGO');
  }
  const ids = new Set(plan.parametersToAdd.map(a => a.specFieldId + ':' + a.recipeNodeId));
  for (const c of cls.cells) {
    if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') {
      assert.equal(ids.has(c.specFieldId + ':' + c.recipeNodeId), false);
    }
  }
});

test('buildWritePlan: una clasificación toda OK no propone ninguna escritura', () => {
  const plan = Core.buildWritePlan({ cells: [
    { status: 'OK', toArchiveIds: [], toAddWriteId: null }
  ], tally: {}, orphans: [], anomalies: [] }, { partNumberId: 1 });
  assert.equal(plan.archiveIds.length, 0);
  assert.equal(plan.parametersToAdd.length, 0);
  assert.equal(plan.touched, 0);
});

test('buildWritePlan: sin partNumberId no arma nada (fail-safe)', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, {});
  assert.equal(plan.parametersToAdd.length, 0);
  assert.equal(plan.archiveIds.length, 0);
});

test('buildWritePlan: NUNCA propone escribir sobre una anomalía', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const anomalyRowIds = new Set(cls.anomalies.map(a => a.rowId));
  for (const id of plan.archiveIds) {
    assert.equal(anomalyRowIds.has(id), false, 'la fila ' + id + ' es una anomalía y no se toca');
  }
  for (const a of plan.parametersToAdd) {
    assert.notEqual(a.recipeNodeId, 42513351, 'no se escribe en el nodo raíz');
  }
});
