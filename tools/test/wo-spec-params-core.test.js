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

// Conteos VERIFICADOS contra el fixture. Recalculados en v0.4.0, cuando la cobertura pasó a
// medirse por ORDEN: los campos externos que viven en el nodo raíz ya NO se vuelven a proponer.
//   15630 Espesor            → DUPLICADO (está en el raíz y en el QA, y ninguno coincide con el NP)
//   33579 Espesor Intermedio → DIFIERE   (en el QA, "0.5 - 1.0" vs "No aplica" del NP)
//   15820/19445/22067/28479  → OK        (viven en el nodo raíz, que los declara: legítimo)
//   31018                    → VACIO     (campo de proceso, nodo 42513364)
test('classifyWorkOrder: sobre el fixture real de la OT 5769', () => {
  const { cells, tally } = Core.classifyWorkOrder(FIX);
  assert.equal(tally.OK, 4);
  assert.equal(tally.VACIO, 1);
  assert.equal(tally.DIFIERE, 1);
  assert.equal(tally.DUPLICADO, 1);
  assert.equal(tally.AMBIGUO, 0);
  assert.equal(tally.SIN_CATALOGO, 0);
  assert.equal(cells.length, 7);
});

test('classifyWorkOrder: los 6 campos externos dan UNA casilla cada uno, vivan donde vivan', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const ext = cells.filter(c => c.scope === 'EXTERNA');
  assert.equal(ext.length, 6, 'una casilla por campo, no una por (campo × nodo)');
  const porCampo = new Set(ext.map(c => c.specFieldId));
  assert.equal(porCampo.size, 6, 'ningún campo debe aparecer dos veces');
});

test('classifyWorkOrder: un campo que ya vive en el nodo raíz sale OK, no VACIO', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const adh = cells.find(c => c.specFieldId === 15820);
  assert.equal(adh.status, 'OK');
  assert.equal(adh.recipeNodeId, 42513351, 'la casilla vive donde está el parámetro');
});

test('classifyWorkOrder: se reporta dónde viven los campos externos fuera del de inspección', () => {
  const { fueraDeInspeccion } = Core.classifyWorkOrder(FIX);
  assert.equal(fueraDeInspeccion.length, 5);
  assert.ok(fueraDeInspeccion.every(f => f.recipeNodeId === 42513351));
});

test('classifyWorkOrder: ya NO hay anomalías por vivir en el nodo raíz', () => {
  const { anomalies } = Core.classifyWorkOrder(FIX);
  assert.equal(anomalies.length, 0,
    'el nodo raíz declara esos campos: tenerlos aplicados es legítimo');
});

test('classifyWorkOrder: sin nodo de inspección, lo que YA existe se sigue evaluando', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  wo.recipeNodesByWorkOrderId.nodes = wo.recipeNodesByWorkOrderId.nodes
    .filter(n => n.type !== 'QUALITY_ASSURANCE_NODE');
  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: FIX.partNumber });
  assert.equal(r.inspectionNode.ambiguous, true);
  // los campos que viven en el nodo raíz siguen dando casilla
  assert.ok(r.cells.some(c => c.scope === 'EXTERNA' && c.status === 'OK'));
  // y los que faltan quedan sin dónde aplicarse, reportados
  assert.ok(r.faltantesSinDestino.length > 0);
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
  // v0.4.0: solo se toca lo que de verdad hace falta — el duplicado de Espesor, el Intermedio
  // que difiere, y el campo de proceso vacío. Lo que ya vive bien en el nodo raíz NO se toca.
  assert.deepEqual(plan.archiveIds.slice().sort((a, b) => a - b),
                   [22341384, 26249942, 26249943]);
  assert.equal(plan.parametersToAdd.length, 3);
  assert.equal(plan.touched, 3);
  // El Espesor se reescribe DONDE YA ESTABA — corregir en su sitio es menos invasivo que
  // moverlo entre nodos en órdenes que ya corren en piso. Si el operador decide que deben
  // migrar al nodo de inspección, eso es una operación aparte (ver fueraDeInspeccion).
  const add = plan.parametersToAdd.find(a => a.specFieldId === 15630);
  assert.ok(add, 'el Espesor debe reescribirse');
  assert.equal(add.specFieldParamId, 32594227, 'con el id del catálogo que señala el NP');
  assert.equal(add.drivenBy, 5063398);
  assert.equal(add.geometryTypeSpecFieldId, null);
  assert.equal(add.locationId, null);
  assert.ok([42513351, 42513391].includes(add.recipeNodeId),
    'se escribe en alguno de los nodos donde el campo ya vivía');
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

test('buildWritePlan: NUNCA propone escribir un campo que ya existe en otro nodo', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  // los 4 campos que viven bien en el nodo raíz no aparecen en ninguna escritura
  const escritos = new Set(plan.parametersToAdd.map(a => a.specFieldId));
  for (const campo of [15820, 19445, 22067, 28479]) {
    assert.equal(escritos.has(campo), false,
      'el campo ' + campo + ' ya existe en el nodo raíz: proponerlo sería duplicarlo');
  }
});

// ── v0.4.0: la cobertura se mide por ORDEN, no por nodo ──────────────────────
// Bug encontrado en la corrida real del 2026-07-29 (4436 órdenes): el applet proponía
// ~5 cambios por orden cuando en realidad faltaba UNO. Causa: los campos de la spec externa
// pueden vivir repartidos entre varios nodos que los DECLARAN —el nodo raíz y el de
// inspección declaran los mismos campos— y yo solo miraba el de inspección, así que proponía
// duplicar en el QA lo que ya existía en el PROCESS. De 9551 cambios, ~7660 eran duplicados.

// Fixture mínimo con el reparto REAL de la OT 16339, verificado en vivo.
const REPARTIDA = {
  workOrder: {
    id: 1927678, idInDomain: 16339, name: '',
    partNumberWorkOrderSpecsByWorkOrderId: { nodes: [{
      id: 900, archivedAt: null, partNumberSpecByPartNumberSpecId: { id: 77 },
      specBySpecId: { id: 14344, name: '40004-014-01 (Estaño)', revisionNumber: 1,
        specFieldSpecsBySpecId: { nodes: [
          { id: 106115, archivedAt: null, specFieldId: 15630, isGeneric: false,
            specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 32594227, name: '5 - 10 µm' }] },
            specFieldBySpecFieldId: { id: 15630, name: 'Espesor', type: 'NUMBER' } },
          { id: 282984, archivedAt: null, specFieldId: 33579, isGeneric: false,
            specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 32596235, name: 'No aplica' }] },
            specFieldBySpecFieldId: { id: 33579, name: 'Espesor (Intermedio)', type: 'NUMBER' } },
          { id: 106116, archivedAt: null, specFieldId: 15820, isGeneric: false,
            specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 15663320, name: 'Sí o No' }] },
            specFieldBySpecFieldId: { id: 15820, name: 'Adherencia', type: 'BOOLEAN' } },
        ] } } }] },
    recipeNodesByWorkOrderId: { nodes: [
      // el nodo raíz DECLARA Adherencia y la tiene aplicada — legítimo, no anomalía
      { id: 47237739, name: 'T204 (DEC)-CU/BR-VARIOS', type: 'PROCESS', recipeInd: 0,
        recipeNodeSpecFieldsByRecipeNodeId: { nodes: [
          { id: 1, specFieldId: 15820, specFieldBySpecFieldId: { id: 15820, name: 'Adherencia' } } ] },
        partNumberRecipeNodeSpecFieldParamsByRecipeNodeId: { nodes: [
          { id: 5001, archivedAt: null, specFieldId: 15820, recipeNodeId: 47237739,
            partNumberWorkOrderSpecByDrivenBy: { id: 900 },
            specFieldParamBySpecFieldParamId: { id: 8801, name: 'Sí o No',
              specFieldParamByDerivedFromId: { id: 15663320 },
              specFieldSpecBySpecFieldSpecId: { id: 106116 } } } ] } },
      // el de inspección declara los 3 pero solo tiene Espesor
      { id: 47237754, name: 'T204-IC00-001 Inspeccionando y Empacando', type: 'QUALITY_ASSURANCE_NODE', recipeInd: 40,
        recipeNodeSpecFieldsByRecipeNodeId: { nodes: [
          { id: 2, specFieldId: 15630, specFieldBySpecFieldId: { id: 15630, name: 'Espesor' } },
          { id: 3, specFieldId: 15820, specFieldBySpecFieldId: { id: 15820, name: 'Adherencia' } } ] },
        partNumberRecipeNodeSpecFieldParamsByRecipeNodeId: { nodes: [
          { id: 5002, archivedAt: null, specFieldId: 15630, recipeNodeId: 47237754,
            partNumberWorkOrderSpecByDrivenBy: { id: 900 },
            specFieldParamBySpecFieldParamId: { id: 8802, name: '5 - 10 µm',
              specFieldParamByDerivedFromId: { id: 32594227 },
              specFieldSpecBySpecFieldSpecId: { id: 106115 } } } ] } },
    ] }
  },
  partNumber: { id: 3017555, name: '80247-572-20',
    partNumberSpecFieldParamsByPartNumberId: { nodes: [] } }
};

test('v0.4.0: un campo cubierto en OTRO nodo NO se vuelve a proponer', () => {
  const { cells, tally } = Core.classifyWorkOrder(REPARTIDA);
  const adh = cells.filter(c => c.specFieldId === 15820);
  assert.equal(adh.length, 1, 'Adherencia debe dar UNA casilla, no una por nodo');
  assert.equal(adh[0].status, 'OK', 'ya está aplicada en el nodo raíz: no hay nada que hacer');
  assert.equal(tally.VACIO, 1, 'solo Espesor (Intermedio) está realmente vacío');
});

test('v0.4.0: solo se propone lo que falta EN TODA la orden', () => {
  const { cells } = Core.classifyWorkOrder(REPARTIDA);
  const vacias = cells.filter(c => c.status === 'VACIO');
  assert.equal(vacias.length, 1);
  assert.equal(vacias[0].specFieldId, 33579, 'el único faltante es Espesor (Intermedio)');
  assert.equal(vacias[0].recipeNodeId, 47237754, 'se aplica en el nodo de inspección');
  assert.equal(vacias[0].forced, true, 'el nodo no lo declara: va forzado');
});

test('v0.4.0: un parámetro en un nodo que SÍ declara el campo no es anomalía', () => {
  const { anomalies } = Core.classifyWorkOrder(REPARTIDA);
  assert.equal(anomalies.length, 0,
    'el nodo raíz declara Adherencia, así que tenerla aplicada es legítimo');
});

test('v0.4.0: se reporta qué campos viven fuera del nodo de inspección', () => {
  const r = Core.classifyWorkOrder(REPARTIDA);
  assert.equal(r.fueraDeInspeccion.length, 1);
  assert.equal(r.fueraDeInspeccion[0].specFieldId, 15820);
  assert.equal(r.fueraDeInspeccion[0].recipeNodeId, 47237739);
});

test('v0.4.0: un campo externo aplicado donde el nodo no lo declara TAMPOCO se duplica', () => {
  // Que un nodo no declare el campo es justo lo que significa "forzado", y forzar es algo que
  // este applet hace a propósito. Así que un forzado preexistente cuenta como cubierto: no es
  // anomalía ni se vuelve a proponer.
  const wo = JSON.parse(JSON.stringify(REPARTIDA.workOrder));
  wo.recipeNodesByWorkOrderId.nodes[0].recipeNodeSpecFieldsByRecipeNodeId.nodes = [];
  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: REPARTIDA.partNumber });
  assert.equal(r.anomalies.length, 0);
  const adh = r.cells.filter(c => c.specFieldId === 15820);
  assert.equal(adh.length, 1);
  assert.equal(adh[0].status, 'OK', 'sigue cubierta: no hay nada que escribir');
});

test('v0.4.0: el plan de la orden repartida propone UN solo cambio', () => {
  const cls = Core.classifyWorkOrder(REPARTIDA);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3017555 });
  assert.equal(plan.touched, 1, 'esperaba 1 cambio, no 3');
  assert.equal(plan.archiveIds.length, 0, 'nada que archivar: no se pisa lo que ya existe');
  assert.equal(plan.parametersToAdd.length, 1);
  assert.equal(plan.parametersToAdd[0].specFieldId, 33579);
});

// ── v0.5.0: MIGRAR al nodo de inspección ────────────────────────────────────
// Decisión del operador (2026-07-29): los parámetros que hoy viven en el nodo raíz deben
// quedar en el de Inspección y Empaque. Migrar = archivar en el raíz + aplicar en el QA.

test('v0.5.0: sin migrar, un campo que vive en el nodo raíz se deja quieto', () => {
  const { cells } = Core.classifyWorkOrder(REPARTIDA);
  const adh = cells.find(c => c.specFieldId === 15820);
  assert.equal(adh.status, 'OK');
  assert.deepEqual(adh.toArchiveIds, []);
});

test('v0.5.0: con migrar, el campo del nodo raíz se archiva y se repone en el de inspección', () => {
  const { cells } = Core.classifyWorkOrder(REPARTIDA, { migrarAInspeccion: true });
  const adh = cells.find(c => c.specFieldId === 15820);
  assert.equal(adh.status, 'MIGRAR');
  assert.deepEqual(adh.toArchiveIds, [5001], 'archiva la fila del nodo raíz');
  assert.equal(adh.recipeNodeId, 47237754, 'la reposición va al nodo de inspección');
  assert.ok(adh.toAddWriteId > 0);
});

test('v0.5.0: migrar NO toca lo que ya está en el nodo de inspección', () => {
  const { cells } = Core.classifyWorkOrder(REPARTIDA, { migrarAInspeccion: true });
  const esp = cells.find(c => c.specFieldId === 15630);   // ya vive en el QA
  assert.equal(esp.status, 'OK');
  assert.deepEqual(esp.toArchiveIds, []);
});

test('v0.5.0: sin nodo de inspección identificable, migrar no hace nada', () => {
  const wo = JSON.parse(JSON.stringify(REPARTIDA.workOrder));
  wo.recipeNodesByWorkOrderId.nodes = wo.recipeNodesByWorkOrderId.nodes
    .filter(n => n.type !== 'QUALITY_ASSURANCE_NODE');
  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: REPARTIDA.partNumber },
                                   { migrarAInspeccion: true });
  assert.equal(r.cells.some(c => c.status === 'MIGRAR'), false,
    'sin destino seguro no se mueve material de sitio');
});

test('v0.5.0: el plan de migración archiva en el raíz y escribe en el de inspección', () => {
  const cls = Core.classifyWorkOrder(REPARTIDA, { migrarAInspeccion: true });
  const plan = Core.buildWritePlan(cls, { partNumberId: 3017555 });
  assert.ok(plan.archiveIds.includes(5001));
  const add = plan.parametersToAdd.find(a => a.specFieldId === 15820);
  assert.ok(add, 'debe reponer Adherencia');
  assert.equal(add.recipeNodeId, 47237754);
});
