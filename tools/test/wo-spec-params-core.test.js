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

// ── Varias specs externas en la misma orden ──────────────────────────────────
// Medido en vivo en la OT 16510 (2026-07-30): trae DOS specs externas —«48053-001-01
// (Deshidrogenado / Endurecido)» con 3 campos y «RC Zn (Zinc)» con 5— y ningún nodo de calidad
// declara los campos de la primera, mientras que `T106-IC00-001 Inspeccionando y Empacando`
// declara los 5 de la segunda. findExternalSpec hacía `return` con la primera que devolviera el
// ERP, así que la orden reportaba «no encuentra el nodo de calidad» —con el nodo a la vista del
// operador— y RC Zn se quedaba sin aplicar. Cuál se atendía dependía del orden de la respuesta.

test('findExternalSpecs: devuelve TODAS, no la primera', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  const externas = wo.partNumberWorkOrderSpecsByWorkOrderId.nodes
    .filter(s => s.partNumberSpecByPartNumberSpecId && !s.archivedAt);
  assert.equal(externas.length, 1, 'el fixture base tiene una sola externa');

  // Se duplica esa spec externa con otros campos: dos externas en la misma orden.
  const otra = JSON.parse(JSON.stringify(externas[0]));
  otra.id = 999001;
  otra.specBySpecId.id = 999002;
  otra.specBySpecId.name = 'RC Zn (Zinc)';
  otra.specBySpecId.specFieldSpecsBySpecId.nodes = [{
    id: 999003, specFieldId: 999004, archivedAt: null,
    specFieldBySpecFieldId: { name: 'Espesor de Zinc' },
    specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 999005, name: '5 - 8 µm' }] }
  }];
  wo.partNumberWorkOrderSpecsByWorkOrderId.nodes.unshift(otra);

  const todas = Core.findExternalSpecs(wo);
  assert.equal(todas.length, 2, 'las dos externas');
  assert.equal(Core.findExternalSpec(wo).specName, 'RC Zn (Zinc)',
    'el wrapper de compatibilidad sigue dando la primera');
  // El conteo se deriva del fixture, no se fija a mano: escribirlo de memoria ya costó un
  // test rojo aquí mismo (la externa del fixture tiene 6 campos, no los 3 que supuse).
  const camposBase = externas[0].specBySpecId.specFieldSpecsBySpecId.nodes
    .filter(f => !f.archivedAt && f.specFieldId != null).length;
  assert.deepEqual(todas.map(s => s.fieldIds.size).sort((a, b) => a - b), [1, camposBase]);
});

test('REGRESIÓN: una externa sin nodo no deja sin atender a la otra', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  const base = wo.partNumberWorkOrderSpecsByWorkOrderId.nodes
    .find(s => s.partNumberSpecByPartNumberSpecId && !s.archivedAt);

  // Una externa cuyos campos NINGÚN nodo declara ni tiene aplicados — como 48053-001-01 en la
  // 16510. Va PRIMERA, que es justo el orden que rompía el caso real.
  const huerfana = JSON.parse(JSON.stringify(base));
  huerfana.id = 999101;
  huerfana.specBySpecId.id = 999102;
  huerfana.specBySpecId.name = '48053-001-01 (Deshidrogenado / Endurecido)';
  huerfana.specBySpecId.specFieldSpecsBySpecId.nodes = [{
    id: 999103, specFieldId: 999104, archivedAt: null,
    specFieldBySpecFieldId: { name: 'Dureza' },
    specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 999105, name: 'HRC 40' }] }
  }];
  wo.partNumberWorkOrderSpecsByWorkOrderId.nodes.unshift(huerfana);

  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: FIX.partNumber });

  // La spec buena conserva su nodo y sus casillas: la huérfana no la arrastra.
  const deLaBuena = r.cells.filter(c => c.scope === 'EXTERNA' && c.specFieldId !== 999104);
  assert.ok(deLaBuena.length > 0, 'la spec con nodo se sigue atendiendo');

  // Y el campo sin destino se reporta diciendo DE QUÉ spec es.
  const sinDestino = r.faltantesSinDestino.find(f => f.specFieldId === 999104);
  assert.ok(sinDestino, 'el campo huérfano se reporta');
  assert.equal(sinDestino.specName, '48053-001-01 (Deshidrogenado / Endurecido)');
  assert.ok(sinDestino.reason, 'y con el motivo, para saber a qué spec reclamarle');
});

test('los campos de TODAS las externas se excluyen del universo PROCESO', () => {
  // extFields es la unión: con una sola spec considerada, los campos de las demás se colaban
  // al universo de proceso y se trataban como parámetros de línea.
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  const base = wo.partNumberWorkOrderSpecsByWorkOrderId.nodes
    .find(s => s.partNumberSpecByPartNumberSpecId && !s.archivedAt);
  const idsPrimera = new Set(base.specBySpecId.specFieldSpecsBySpecId.nodes
    .filter(f => !f.archivedAt).map(f => f.specFieldId));

  const otra = JSON.parse(JSON.stringify(base));
  otra.id = 999201;
  otra.specBySpecId.id = 999202;
  otra.specBySpecId.name = 'Segunda externa';
  wo.partNumberWorkOrderSpecsByWorkOrderId.nodes.unshift(otra);

  const r = Core.classifyWorkOrder({ workOrder: wo, partNumber: FIX.partNumber });
  for (const c of r.cells) {
    if (c.scope === 'PROCESO') {
      assert.ok(!idsPrimera.has(c.specFieldId),
        'un campo externo no puede clasificarse como de proceso');
    }
  }
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

// ── Modo acotado: escribir solo lo que define el Número de Parte ─────────────
// resolveDesired tiene dos vías. La del NP es la fuente de verdad que este applet declara; la
// del catálogo es una INFERENCIA ("el NP no dice nada, pero el catálogo ofrece una sola opción,
// así que debe ser esa"). En la corrida de 194 órdenes del 2026-07-30 esa inferencia era 250 de
// 16 314 casillas, casi todas campos de PROCESO —temperatura de tina, concentración, tiempo de
// centrifugadora— que el NP no define porque son de la receta y no del cliente. Nadie ha
// demostrado que una orden sana los tenga llenos, y una escritura de más en el criterio de
// calidad de una orden EN PISO no se corrige sola en la siguiente corrida.

test('modo acotado: deja fuera la vía CATALOGO y lo reporta', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const completo = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const acotado = Core.buildWritePlan(cls, { partNumberId: 3044551, soloNP: true });

  assert.equal(completo.touched, 3);
  assert.equal(acotado.touched, 2, 'la casilla de vía CATALOGO no se escribe');
  assert.equal(acotado.soloNP, 1, 'y se reporta cuántas quedaron fuera');
  assert.equal(completo.soloNP, 0, 'sin el modo, no se omite nada por esta razón');
});

test('modo acotado: todo lo que escribe viene del Número de Parte', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const acotado = Core.buildWritePlan(cls, { partNumberId: 3044551, soloNP: true });
  const escritas = new Set(acotado.parametersToAdd.map(a => a.specFieldId));
  for (const c of cls.cells) {
    if (escritas.has(c.specFieldId)) {
      assert.equal(c.via, 'NP', 'el campo ' + c.specFieldId + ' se escribió sin respaldo del NP');
    }
  }
});

test('modo acotado: no cambia lo que ya se omitía por AMBIGUO o SIN_CATALOGO', () => {
  // El filtro va DESPUÉS de esos descartes, así que `soloNP` cuenta lo que se dejó de escribir
  // por el modo — no lo que de todos modos no se iba a tocar. Si se mezclaran, el número
  // diría "el modo te ahorró N" incluyendo casillas que nadie pensaba escribir.
  const cls = Core.classifyWorkOrder(FIX);
  const completo = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const acotado = Core.buildWritePlan(cls, { partNumberId: 3044551, soloNP: true });
  const omitidasPorSiempre = completo.skipped.length;
  assert.equal(acotado.skipped.length, omitidasPorSiempre + acotado.soloNP);
});

test('modo acotado: es una decisión explícita, no el comportamiento por omisión', () => {
  // Un applet que en silencio escribiera menos de lo que muestra el preview sería peor que uno
  // que escribe de más: el operador confirma un conteo y espera que ese conteo se cumpla.
  const cls = Core.classifyWorkOrder(FIX);
  for (const opts of [{ partNumberId: 3044551 },
                      { partNumberId: 3044551, soloNP: false },
                      { partNumberId: 3044551, soloNP: undefined }]) {
    assert.equal(Core.buildWritePlan(cls, opts).touched, 3);
  }
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

// ── El caso GDE1214700 Antitarnish (OT 10837, reportado en piso 2026-08-03) ──
//
// La orden nació el 2026-07-02 copiando una receta cuyo nodo de calidad
// «Inspeccionando y  Empacando Antitarnish» AÚN NO declaraba los campos de la spec del
// cliente; el nodo maestro (processNode 268059) se corrigió el 2026-07-07, cinco días
// DESPUÉS. La copia de la orden no se refresca, así que su nodo quedó con
// `recipeNodeSpecFields: []` para siempre.
//
// Consecuencia medida en vivo: los 3 parámetros del NP van sin nodo forzado, ningún nodo
// declara sus specFields y —por la regla de herencia del ERP— quedaron FUERA de la orden.
// La spec entra DOS veces (por el NP y por el tratamiento TR-PRM-001), que es el «choque»
// que reportó el operador, pero ése no es el motivo: la orden de control 2472 también la
// trae doble y sí aplicó. El motivo es que ningún nodo la declara.
const ANTITARNISH = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-10837.json'), 'utf8'));

test('OT 10837: la spec del cliente entra dos veces —por NP y por tratamiento—', () => {
  const specs = ANTITARNISH.workOrder.partNumberWorkOrderSpecsByWorkOrderId.nodes
    .filter(s => (s.specBySpecId || {}).id === 18452);
  assert.equal(specs.length, 2, 'la misma spec 18452 llega por dos caminos');
  assert.equal(specs.filter(s => s.partNumberSpecByPartNumberSpecId).length, 1);
  assert.equal(specs.filter(s => s.treatmentSpecByTreatmentSpecId).length, 1);
});

test('OT 10837: ningún nodo declara los campos de Antitarnish', () => {
  const CAMPOS = [20570, 25415, 22546];
  for (const n of ANTITARNISH.workOrder.recipeNodesByWorkOrderId.nodes) {
    const decl = ((n.recipeNodeSpecFieldsByRecipeNodeId || {}).nodes || []).map(f => f.specFieldId);
    for (const c of CAMPOS) {
      assert.equal(decl.includes(c), false,
        `el nodo ${n.id} no debería declarar ${c} en esta orden congelada`);
    }
  }
});

test('OT 10837: sin nodo que la toque, la spec externa queda SIN DESTINO y no se escribe', () => {
  const r = Core.classifyWorkOrder(ANTITARNISH);
  assert.equal(r.inspectionNode.ambiguous, true);
  assert.deepEqual(r.inspectionNode.candidates, []);
  assert.equal(r.faltantesSinDestino.length, 3,
    'los 3 campos de GDE1214700 quedan sin colocar');
  const plan = Core.buildWritePlan(r, { partNumberId: 3016541 });
  assert.equal(plan.touched, 0, 'no se adivina un nodo: escribir criterios de calidad ' +
    'en la etapa equivocada es peor que no escribirlos');
});

test('OT 10837: migrarAInspeccion tampoco inventa un destino', () => {
  const r = Core.classifyWorkOrder(ANTITARNISH, { migrarAInspeccion: true });
  assert.equal(Core.buildWritePlan(r, { partNumberId: 3016541 }).touched, 0);
});

// ── Rescate por RECETA MAESTRA (0.6.0) ──────────────────────────────────────
//
// La OT 10837 no se puede reparar mirando sólo la orden: su copia congelada no declara los
// campos en ningún nodo. Pero el processNode MAESTRO del que deriva su nodo de calidad
// (268059) SÍ los declara — se corrigió el 2026-07-07, cinco días después de que nacieran
// las órdenes. Eso da un destino con evidencia ESTRUCTURAL, no una adivinanza: no se elige
// «el nodo que suena parecido», se elige el nodo de la orden cuyo maestro declara el campo.
//
// La regla de seguridad no cambia: si no resuelve a EXACTAMENTE UN nodo, no se toca nada.
const MASTERS = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-masters.json'), 'utf8'));

// masterFields: Map<processNodeId(maestro), Set<specFieldId>>
function masterFieldsFrom(ids) {
  const m = new Map();
  for (const id of ids) m.set(Number(id), Core.masterDeclaredFields(MASTERS[String(id)]));
  return m;
}

test('masterDeclaredFields: saca los specFieldId del nodo maestro', () => {
  const s = Core.masterDeclaredFields(MASTERS['268059']);
  assert.deepEqual([...s].sort((a, b) => a - b), [20570, 22546, 25415]);
});

test('masterDeclaredFields: tolera un maestro nulo o sin declaraciones', () => {
  assert.equal(Core.masterDeclaredFields(null).size, 0);
  assert.equal(Core.masterDeclaredFields({}).size, 0);
});

test('rescate: con la receta maestra, la OT 10837 SÍ encuentra su nodo de calidad', () => {
  const es = Core.findExternalSpecs(ANTITARNISH.workOrder)[0];
  const r = Core.findInspectionNode(ANTITARNISH.workOrder, es,
                                    { masterFields: masterFieldsFrom([268059]) });
  assert.ok(r.node, 'debe resolver a un nodo');
  assert.equal(r.node.id, 44947411, 'el nodo que deriva del maestro 268059');
  assert.equal(r.viaMaster, true, 'y debe quedar marcado como rescatado por receta');
});

test('rescate: sin la receta maestra sigue siendo ambiguo (no hay regresión)', () => {
  const es = Core.findExternalSpecs(ANTITARNISH.workOrder)[0];
  assert.equal(Core.findInspectionNode(ANTITARNISH.workOrder, es).ambiguous, true);
});

test('rescate: si el maestro no declara los campos de ESTA spec, no rescata', () => {
  const es = Core.findExternalSpecs(ANTITARNISH.workOrder)[0];
  const m = new Map([[268059, new Set([99999])]]);   // declara otra cosa
  assert.equal(Core.findInspectionNode(ANTITARNISH.workOrder, es, { masterFields: m }).ambiguous,
    true, 'un maestro que declara otros campos no es destino de esta spec');
});

test('rescate: si DOS nodos de la orden derivan de maestros que declaran, no se toca nada', () => {
  const wo = JSON.parse(JSON.stringify(ANTITARNISH.workOrder));
  const qa = wo.recipeNodesByWorkOrderId.nodes.filter(n => n.type === 'QUALITY_ASSURANCE_NODE');
  qa[0].processNodeByDerivedFrom = { id: 268059, name: 'otro' };   // ahora hay dos
  const es = Core.findExternalSpecs(wo)[0];
  const r = Core.findInspectionNode(wo, es, { masterFields: masterFieldsFrom([268059]) });
  assert.equal(r.ambiguous, true, 'dos destinos posibles = no se adivina');
});

test('rescate: con destino resuelto, la OT 10837 aplica sus 3 campos', () => {
  const r = Core.classifyWorkOrder(ANTITARNISH, { masterFields: masterFieldsFrom([268059]) });
  assert.equal(r.faltantesSinDestino.length, 0, 'ya no quedan campos huérfanos');
  const plan = Core.buildWritePlan(r, { partNumberId: 3016541 });
  assert.equal(plan.parametersToAdd.length, 3, 'los 3 criterios del cliente se escriben');
  assert.equal(plan.archiveIds.length, 0, 'no había nada que archivar: las casillas estaban vacías');
  for (const a of plan.parametersToAdd) {
    assert.equal(a.recipeNodeId, 44947411, 'todos al nodo de calidad de Antitarnish');
  }
});

test('rescate: los campos rescatados quedan marcados como FORZADOS', () => {
  const r = Core.classifyWorkOrder(ANTITARNISH, { masterFields: masterFieldsFrom([268059]) });
  const tocadas = r.cells.filter(c => c.status === 'VACIO');
  assert.equal(tocadas.length, 3);
  assert.ok(tocadas.every(c => c.forced),
    'el nodo de la ORDEN no los declara: cada uno es un forzado y debe reportarse como tal');
});

// ── El «choque» SÍ tenía efecto, pero no el que se creía ─────────────────────
//
// La spec `GDE1214700 (Antitarnish)` entra a la OT 10837 dos veces —por el NP y por el
// tratamiento— con el MISMO specId y los MISMOS specFieldSpec. `buildCatalogIndex` recorre
// las `partNumberWorkOrderSpecs` una por una, así que cada campo salía con DOS candidatos
// idénticos (`specFieldSpecId` 149308 en ambos) y `resolveDesired` los contaba como dos
// opciones distintas → `AMBIGUO: el catálogo ofrece 2 opciones` → no se escribía nada.
//
// No son dos opciones: es la misma opción contada dos veces. La dedup va por
// `specFieldSpecId` y NO por specId — dos specs DISTINTAS que declaren el mismo campo sí son
// alternativas reales y ahí el AMBIGUO es correcto.
//
// Aquí la vía del NP tampoco salva el caso: sus 3 parámetros vienen con
// `specFieldSpecBySpecFieldSpecId: null` (medido — en la OT 5769 los 10 sí lo traen), así que
// `buildPartNumberIndex` no puede indexarlos y la resolución cae al catálogo.

test('choque: la misma spec por dos vías no son dos opciones del catálogo', () => {
  const cat = Core.buildCatalogIndex(ANTITARNISH.workOrder);
  for (const fid of [20570, 25415, 22546]) {
    const c = cat.get(fid) || [];
    assert.equal(c.length, 1,
      `el campo ${fid} debe ofrecer UN candidato, no uno por cada vía de entrada`);
  }
});

test('choque: dos specs DISTINTAS con el mismo campo siguen siendo dos opciones', () => {
  const wo = JSON.parse(JSON.stringify(ANTITARNISH.workOrder));
  const dup = wo.partNumberWorkOrderSpecsByWorkOrderId.nodes
    .find(s => (s.specBySpecId || {}).id === 18452 && !s.partNumberSpecByPartNumberSpecId);
  dup.specBySpecId = JSON.parse(JSON.stringify(dup.specBySpecId));
  dup.specBySpecId.id = 99999;                       // otra spec…
  dup.specBySpecId.name = 'OTRA SPEC';
  for (const f of dup.specBySpecId.specFieldSpecsBySpecId.nodes) f.id = f.id + 500000;  // …con su propio specFieldSpec
  const cat = Core.buildCatalogIndex(wo);
  assert.equal((cat.get(20570) || []).length, 2,
    'dos specs distintas declarando el mismo campo SON dos opciones reales');
});

test('choque: deduplicado, la OT 10837 resuelve por catálogo y escribe sus 3 campos', () => {
  const r = Core.classifyWorkOrder(ANTITARNISH, { masterFields: masterFieldsFrom([268059]) });
  assert.equal(r.tally.AMBIGUO, 0, 'ya no hay ambigüedad artificial');
  const plan = Core.buildWritePlan(r, { partNumberId: 3016541 });
  assert.equal(plan.parametersToAdd.length, 3);
});

test('OT 10837: lo que se escribiría es lo MISMO que tiene la orden de control 2472', () => {
  // La validación que importa no es el conteo ni el id, sino el CRITERIO que queda escrito.
  // La OT 2472 corre otro proceso pero la MISMA spec de Antitarnish y sí la aplicó.
  //
  // Ojo con el id: la vía NP gana sobre el catálogo y lo que se escribe es la RAÍZ del
  // parámetro del NP (`derivedFrom ?? id`), que puede ser una revisión más nueva que la que
  // ofrece el catálogo de la orden — medido en vivo el 2026-08-03: el NP trae 28985361 con
  // derivedFrom 28878284 mientras el catálogo ofrece 17824087, y AMBOS se llaman «Sí o No».
  // Por eso el test compara nombres y no ids: el id correcto depende de qué revisión esté
  // vigente, el criterio de calidad no.
  const ESPERADO = {
    20570: 'Sí o No',                    // Protección - Sulfuro de sodio al 2.5%
    25415: 'Sí o No',                    // Apariencia Homogénea - Antitarnish
    22546: 'Sí o No (ambos pasan)'       // Primeras Piezas Antitarnish
  };
  const r = Core.classifyWorkOrder(ANTITARNISH, { masterFields: masterFieldsFrom([268059]) });
  const plan = Core.buildWritePlan(r, { partNumberId: 3016541 });
  assert.equal(plan.parametersToAdd.length, 3);

  // nombre del parámetro que quedará, por la vía que lo haya resuelto
  const porCampo = new Map();
  for (const c of r.cells) if (c.scope === 'EXTERNA') porCampo.set(c.specFieldId, c);
  for (const add of plan.parametersToAdd) {
    const cell = porCampo.get(add.specFieldId);
    assert.ok(cell, `debe haber celda para el campo ${add.specFieldId}`);
    const nombre = (cell.desired && (cell.desired.refName
      || (cell.desired.refParam && cell.desired.refParam.name))) || '';
    assert.equal(nombre, ESPERADO[add.specFieldId],
      `campo ${add.specFieldId}: el criterio debe quedar igual que en la orden de control`);
  }
});

test('OT 10837: con el NP real la vía es NP, y se escribe la RAÍZ de catálogo', () => {
  // Regresión de un error propio: el primer fixture tomó `partNumberById` de
  // GetPartNumberWorkOrderSpecsInfo, que trae los params SIN `specFieldSpec` — con eso
  // `buildPartNumberIndex` sale vacío y parecía que la vía NP no podía resolver nunca.
  // El applet usa GetPartNumber, que sí los trae. El fixture ya viene de ahí.
  const pnIndex = Core.buildPartNumberIndex(ANTITARNISH.partNumber);
  assert.ok(pnIndex.size > 0, 'el NP del fixture debe ser indexable (viene de GetPartNumber)');
  const r = Core.classifyWorkOrder(ANTITARNISH, { masterFields: masterFieldsFrom([268059]) });
  for (const c of r.cells) {
    if (c.scope !== 'EXTERNA') continue;
    assert.equal(c.via, 'NP', `campo ${c.specFieldId}: el NP manda sobre el catálogo`);
  }
});
