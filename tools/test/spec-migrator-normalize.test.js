'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const SMN = require('../../remote/scripts/spec-migrator-normalize.js');
const { planFieldNormalization, extractFieldRows, norm } = SMN;

// ── planFieldNormalization ──────────────────────────────────────────────
test('normalize: 1 activa, mismo nombre, distinto id → migrar', () => {
  const rows = [
    { id: '7867561', archivedAt: '2026-05-26T07:30:26Z', processNodeId: 172170, paramId: 'OLD', paramName: 'Sí o No' },
    { id: '7880542', archivedAt: '2026-06-25T23:31:45Z', processNodeId: null, paramId: 'OLD2', paramName: 'Sí o No' },
    { id: '8831137', archivedAt: null, processNodeId: null, paramId: 'ACTIVO_VIEJO', paramName: 'Sí o No' },
  ];
  const r = planFieldNormalization(rows, { newParamId: 'CATALOGO_NUEVO', newParamName: 'Sí o No' });
  assert.equal(r.action, 'normalize');
  assert.equal(r.oldRowId, '8831137');
  assert.equal(r.oldParamId, 'ACTIVO_VIEJO');
});

test('already: la activa YA es el id del catálogo → nada que hacer', () => {
  const rows = [{ id: '9134020', archivedAt: null, processNodeId: null, paramId: 'CAT', paramName: 'Sí o No' }];
  const r = planFieldNormalization(rows, { newParamId: 'CAT', newParamName: 'Sí o No' });
  assert.equal(r.action, 'already');
});

test('non-equivalent: la activa tiene OTRO nombre → NO tocar', () => {
  const rows = [{ id: '111', archivedAt: null, processNodeId: null, paramId: 'X', paramName: 'No aplica' }];
  const r = planFieldNormalization(rows, { newParamId: 'Y', newParamName: 'Sí o No' });
  assert.equal(r.action, 'non-equivalent');
  assert.equal(r.oldRowId, '111');
});

test('no-active: todas archivadas → pendiente real (no falso)', () => {
  const rows = [
    { id: '1', archivedAt: '2026-01-01T00:00:00Z', processNodeId: null, paramId: 'A', paramName: 'Sí o No' },
    { id: '2', archivedAt: '2026-02-01T00:00:00Z', processNodeId: 5, paramId: 'B', paramName: 'Sí o No' },
  ];
  const r = planFieldNormalization(rows, { newParamId: 'C', newParamName: 'Sí o No' });
  assert.equal(r.action, 'no-active');
});

test('ambiguous: 2+ activas → dejar al validador de duplicados', () => {
  const rows = [
    { id: '1', archivedAt: null, processNodeId: null, paramId: 'A', paramName: 'Sí o No' },
    { id: '2', archivedAt: null, processNodeId: null, paramId: 'B', paramName: 'Sí o No' },
  ];
  const r = planFieldNormalization(rows, { newParamId: 'C', newParamName: 'Sí o No' });
  assert.equal(r.action, 'ambiguous');
  assert.deepEqual(r.activeRowIds, ['1', '2']);
});

test('equivalencia tolerante a mayúsculas/espacios', () => {
  const rows = [{ id: '1', archivedAt: null, processNodeId: null, paramId: 'A', paramName: '  Sí o No  ' }];
  const r = planFieldNormalization(rows, { newParamId: 'B', newParamName: 'sí o no' });
  assert.equal(r.action, 'normalize');
});

test('id como number vs string: no re-migra si son el mismo id', () => {
  const rows = [{ id: '1', archivedAt: null, processNodeId: null, paramId: 12345, paramName: 'Sí o No' }];
  const r = planFieldNormalization(rows, { newParamId: '12345', newParamName: 'Sí o No' });
  assert.equal(r.action, 'already');
});

// ── extractFieldRows ────────────────────────────────────────────────────
test('extractFieldRows: filtra por specFieldId, incluye activas y archivadas', () => {
  const pnNode = {
    partNumberSpecFieldParamsByPartNumberId: {
      nodes: [
        { id: 'r1', archivedAt: null, processNodeId: null,
          specFieldParamBySpecFieldParamId: { id: 'p1', name: 'Sí o No',
            specFieldSpecBySpecFieldSpecId: { specFieldBySpecFieldId: { id: 'FIELD_A' } } } },
        { id: 'r2', archivedAt: '2026-01-01', processNodeId: 9,
          specFieldParamBySpecFieldParamId: { id: 'p0', name: 'Sí o No',
            specFieldSpecBySpecFieldSpecId: { specFieldBySpecFieldId: { id: 'FIELD_A' } } } },
        { id: 'r3', archivedAt: null, processNodeId: null,
          specFieldParamBySpecFieldParamId: { id: 'pX', name: 'Otro',
            specFieldSpecBySpecFieldSpecId: { specFieldBySpecFieldId: { id: 'FIELD_B' } } } },
        { id: 'r4', archivedAt: null, processNodeId: null, specFieldParamBySpecFieldParamId: null }, // sin param → ignorar
      ]
    }
  };
  const rows = extractFieldRows(pnNode, 'FIELD_A');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.id).sort(), ['r1', 'r2']);
  const active = rows.find(r => r.id === 'r1');
  assert.equal(active.paramId, 'p1');
  assert.equal(active.paramName, 'Sí o No');
  assert.equal(active.archivedAt, null);
});

test('extractFieldRows: pnNode vacío/nulo → []', () => {
  assert.deepEqual(extractFieldRows(null, 'X'), []);
  assert.deepEqual(extractFieldRows({}, 'X'), []);
});

// ── end-to-end: caso real 211394C RC Ni/Adherencia ──────────────────────
test('caso real 211394C: extractFieldRows + plan → normalize', () => {
  const pnNode = {
    partNumberSpecFieldParamsByPartNumberId: {
      nodes: [
        { id: '7867561', archivedAt: '2026-05-26T07:30:26.114+00:00', processNodeId: 172170,
          specFieldParamBySpecFieldParamId: { id: 'sfp_v1', name: 'Sí o No',
            specFieldSpecBySpecFieldSpecId: { specFieldBySpecFieldId: { id: 'FIELD_ADH' } } } },
        { id: '7880542', archivedAt: '2026-06-25T23:31:45.187+00:00', processNodeId: null,
          specFieldParamBySpecFieldParamId: { id: 'sfp_v2', name: 'Sí o No',
            specFieldSpecBySpecFieldSpecId: { specFieldBySpecFieldId: { id: 'FIELD_ADH' } } } },
        { id: '8831137', archivedAt: null, processNodeId: null,
          specFieldParamBySpecFieldParamId: { id: 'sfp_v3', name: 'Sí o No',
            specFieldSpecBySpecFieldSpecId: { specFieldBySpecFieldId: { id: 'FIELD_ADH' } } } },
      ]
    }
  };
  const rows = extractFieldRows(pnNode, 'FIELD_ADH');
  const plan = planFieldNormalization(rows, { newParamId: 'sfp_catalogo', newParamName: 'Sí o No' });
  assert.equal(plan.action, 'normalize');
  assert.equal(plan.oldRowId, '8831137'); // archiva la ACTIVA vieja
});

// ── Liberar nodo forzado (2026-07-29) ───────────────────────────────────────
// Un parámetro del NP con processNodeId forzado hace que Steelhead lo materialice en ESE nodo
// al crear la OT — típicamente el raíz— en vez de dejar que caiga en el nodo que declara el
// specField. Lo escribía bulk-upload antes de la regla 1.4.38 (commit 046ec5b, 2026-05-25):
//     processNodeId: part.processId || pn.defaultProcessNodeId || null
// El fix detuvo la sangría pero los datos quedaron. El deduplicador no los ve por dos razones:
// solo mira SpecFields con 2+ params, y su modo masivo solo archiva (no sabe insertar).

test('planForcedNodeRelease: una sola fila con nodo forzado → archivar y reponer con null', () => {
  const r = SMN.planForcedNodeRelease([
    { id: 5001, processNodeId: 241753, paramId: 8801, paramName: 'Sí o No' },
  ]);
  assert.equal(r.action, 'rewrite');
  assert.deepEqual(r.archiveIds, [5001]);
  assert.equal(r.insertParamId, 8801, 'se repone el MISMO parámetro, solo que sin nodo');
});

test('planForcedNodeRelease: si ya hay una con null, las de nodo solo se archivan', () => {
  const r = SMN.planForcedNodeRelease([
    { id: 5001, processNodeId: 241753, paramId: 8801, paramName: 'Sí o No' },
    { id: 5002, processNodeId: null, paramId: 8801, paramName: 'Sí o No' },
  ]);
  assert.equal(r.action, 'archive-only');
  assert.deepEqual(r.archiveIds, [5001]);
  assert.equal(r.insertParamId, null, 'la fila sin nodo ya cumple: no hay que insertar');
});

test('planForcedNodeRelease: sin nodo forzado no hay nada que hacer', () => {
  const r = SMN.planForcedNodeRelease([
    { id: 5002, processNodeId: null, paramId: 8801, paramName: 'Sí o No' },
  ]);
  assert.equal(r.action, 'ok');
  assert.deepEqual(r.archiveIds, []);
});

test('planForcedNodeRelease: varias con nodo pero MISMO parámetro → una sola reposición', () => {
  const r = SMN.planForcedNodeRelease([
    { id: 5001, processNodeId: 241753, paramId: 8801, paramName: 'Sí o No' },
    { id: 5003, processNodeId: 999888, paramId: 8801, paramName: 'Sí o No' },
  ]);
  assert.equal(r.action, 'rewrite');
  assert.deepEqual(r.archiveIds.sort((a, b) => a - b), [5001, 5003]);
  assert.equal(r.insertParamId, 8801);
});

test('planForcedNodeRelease: valores DISTINTOS no se deciden solos', () => {
  const r = SMN.planForcedNodeRelease([
    { id: 5001, processNodeId: 241753, paramId: 8801, paramName: '5 - 8 µm' },
    { id: 5003, processNodeId: 999888, paramId: 8802, paramName: '5 - 10 µm' },
  ]);
  assert.equal(r.action, 'ambiguous');
  assert.deepEqual(r.archiveIds, [], 'no se toca nada: elegir el valor no es cosa del applet');
  assert.match(r.reason, /distinto/i);
});

test('planForcedNodeRelease: mismo nombre con id distinto se trata como equivalente', () => {
  // revisión nueva del catálogo: mismo valor, otro specFieldParamId
  const r = SMN.planForcedNodeRelease([
    { id: 5001, processNodeId: 241753, paramId: 8801, paramName: 'Sí o No' },
    { id: 5003, processNodeId: 241753, paramId: 9999, paramName: 'sí o no' },
  ]);
  assert.equal(r.action, 'rewrite');
  assert.equal(r.insertParamId, 9999, 'se repone el más reciente');
});

test('planForcedNodeRelease: entrada vacía no truena', () => {
  assert.equal(SMN.planForcedNodeRelease([]).action, 'ok');
  assert.equal(SMN.planForcedNodeRelease(null).action, 'ok');
});

// ── Candado de shapes (2026-07-29) ──────────────────────────────────────────
// Dos mutations con nombres casi iguales y shapes INCOMPATIBLES:
//   AddParamsToPartNumber                          → input.paramsToApply    (NP)
//   AddParamsToPartNumberRecipeNodeSpecFieldParam  → input.parametersToAdd  (OT)
// Copiar el de la OT al del NP dio HTTP 400 en las 52 reposiciones de GRUPO COLLADO: el
// applet archivó y no repuso. El error no se vio porque el panel murió antes de pintar el
// resumen. Este test ata cada mutation a su campo.
const fsC = require('node:fs');
const pathC = require('node:path');

test('AddParamsToPartNumber usa paramsToApply, NUNCA parametersToAdd', () => {
  const src = fsC.readFileSync(
    pathC.join(__dirname, '..', '..', 'remote', 'scripts', 'spec-migrator.js'), 'utf8');
  const re = /query\('AddParamsToPartNumber'\s*,\s*\{([\s\S]{0,400}?)\}\s*,\s*'AddParamsToPartNumber'\)/g;
  let m, n = 0;
  while ((m = re.exec(src)) !== null) {
    n++;
    assert.ok(m[1].includes('paramsToApply'),
      'la llamada #' + n + ' a AddParamsToPartNumber debe usar paramsToApply');
    assert.ok(!m[1].includes('parametersToAdd'),
      'la llamada #' + n + ' usa parametersToAdd, que es el shape de la mutation de OT');
  }
  assert.ok(n > 0, 'no encontré ninguna llamada a AddParamsToPartNumber');
});

test('el applet de OTs usa parametersToAdd, NUNCA paramsToApply', () => {
  const src = fsC.readFileSync(
    pathC.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params.js'), 'utf8');
  const i = src.indexOf('AddParamsToPartNumberRecipeNodeSpecFieldParam');
  assert.ok(i > 0);
  const bloque = src.slice(Math.max(0, i - 400), i + 400);
  assert.ok(bloque.includes('parametersToAdd'), 'la mutation de OT usa parametersToAdd');
  assert.equal(bloque.includes('paramsToApply'), false, 'ese es el shape del NP, no el de OT');
});

// ── Atomicidad por grupo (2026-07-29) ───────────────────────────────────────
// El incidente de GRUPO COLLADO fue de 52 parámetros porque el apply archivaba TODO y luego
// reponía TODO: cuando la reposición falló en bloque, quedaron 52 huecos. Si cada grupo se
// archiva y se repone junto, un fallo deja UN hueco, no cincuenta y dos.

test('planApplyUnits: cada unidad lleva su archivado Y su reposición juntos', () => {
  const grupos = [
    { key: 'a', pnId: 1, fieldId: 10, params: [{ rowId: 100 }],
      releasePlan: { action: 'rewrite', archiveIds: [100], insertParamId: 900 } },
    { key: 'b', pnId: 2, fieldId: 20, params: [{ rowId: 200 }],
      releasePlan: { action: 'rewrite', archiveIds: [200], insertParamId: 901 } },
  ];
  const dec = new Map([['a', { winnerRowId: null }], ['b', { winnerRowId: null }]]);
  const u = SMN.planApplyUnits(grupos, k => dec.get(k));
  assert.equal(u.length, 2);
  assert.deepEqual(u[0].archive, [100]);
  assert.equal(u[0].repone.specFieldParamId, 900);
  assert.equal(u[0].pnId, 1);
});

test('planApplyUnits: archive-only no lleva reposición', () => {
  const grupos = [{ key: 'a', pnId: 1, fieldId: 10, params: [{ rowId: 100 }, { rowId: 101 }],
    releasePlan: { action: 'archive-only', archiveIds: [100], insertParamId: null } }];
  const u = SMN.planApplyUnits(grupos, () => ({ winnerRowId: 101 }));
  assert.equal(u[0].repone, null);
  assert.deepEqual(u[0].archive, [100]);
});

test('planApplyUnits: ambiguo NO genera unidad — no se toca', () => {
  const grupos = [{ key: 'a', pnId: 1, fieldId: 10, params: [{ rowId: 100 }],
    releasePlan: { action: 'ambiguous', archiveIds: [], insertParamId: null } }];
  assert.equal(SMN.planApplyUnits(grupos, () => ({ winnerRowId: null })).length, 0);
});

test('planApplyUnits: un grupo ignorado NO genera unidad', () => {
  const grupos = [{ key: 'a', pnId: 1, fieldId: 10, params: [{ rowId: 100 }],
    releasePlan: { action: 'rewrite', archiveIds: [100], insertParamId: 900 } }];
  assert.equal(SMN.planApplyUnits(grupos, () => ({ ignored: true })).length, 0);
});

test('planApplyUnits: duplicado clásico archiva los perdedores sin reponer', () => {
  const grupos = [{ key: 'a', pnId: 1, fieldId: 10,
    params: [{ rowId: 100 }, { rowId: 101 }, { rowId: 102 }],
    releasePlan: { action: 'ok', archiveIds: [], insertParamId: null } }];
  const u = SMN.planApplyUnits(grupos, () => ({ winnerRowId: 101 }));
  assert.deepEqual(u[0].archive.sort((a, b) => a - b), [100, 102]);
  assert.equal(u[0].repone, null);
});

// ── Salud del ERP: frenar antes de tumbarlo ─────────────────────────────────
// Medido el 2026-07-29: tras un día de escaneos, una consulta trivial tardó 24 s y varias
// veces el /graphql dejó de responder. Insistir en ese estado es lo que deja trabajo a medias.

test('erpHealth: con respuestas rápidas mantiene el ritmo', () => {
  const h = SMN.erpHealth([300, 250, 400, 320]);
  assert.equal(h.degradado, false);
  assert.equal(h.pausaMs, 0);
});

test('erpHealth: si las respuestas se disparan, manda pausar', () => {
  const h = SMN.erpHealth([300, 2000, 9000, 15000]);
  assert.equal(h.degradado, true);
  assert.ok(h.pausaMs >= 1000, 'debe pedir una pausa real');
});

test('erpHealth: sin muestras suficientes no opina', () => {
  assert.equal(SMN.erpHealth([500]).degradado, false);
  assert.equal(SMN.erpHealth([]).degradado, false);
});

// ── Barrido autónomo por cliente (2026-07-29) ───────────────────────────────
// El operador: "desarrollo esto para no ser el cuello de botella; cargar cliente a cliente me
// convierte en el cuello de botella". El barrido recorre los clientes solo, con checkpoint,
// para que se lance una vez y se ocupe aunque tarde horas.

test('planCustomerSweep: sin checkpoint, todos los clientes quedan pendientes', () => {
  const cs = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const p = SMN.planCustomerSweep(cs, null);
  assert.deepEqual(p.pendientes.map(c => c.id), [1, 2, 3]);
  assert.equal(p.yaHechos, 0);
});

test('planCustomerSweep: reanuda saltando los que ya se hicieron', () => {
  const cs = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const p = SMN.planCustomerSweep(cs, { done: [1, 3], totales: { archivados: 5, repuestos: 5 } });
  assert.deepEqual(p.pendientes.map(c => c.id), [2]);
  assert.equal(p.yaHechos, 2);
  assert.equal(p.totales.archivados, 5);
});

test('planCustomerSweep: un cliente ya hecho no se repite aunque cambie de orden', () => {
  const p = SMN.planCustomerSweep([{ id: 9, name: 'Z' }, { id: 1, name: 'A' }], { done: [9] });
  assert.deepEqual(p.pendientes.map(c => c.id), [1]);
});

test('planCustomerSweep: lista vacía no truena', () => {
  const p = SMN.planCustomerSweep([], null);
  assert.deepEqual(p.pendientes, []);
  assert.equal(p.yaHechos, 0);
});

test('planCustomerSweep: los totales arrancan en cero si el checkpoint no los trae', () => {
  const p = SMN.planCustomerSweep([{ id: 1 }], { done: [] });
  assert.equal(p.totales.archivados, 0);
  assert.equal(p.totales.repuestos, 0);
  assert.equal(p.totales.errores, 0);
});

test('mergeSweepTotals: acumula lo de cada cliente sin perder lo previo', () => {
  const t = SMN.mergeSweepTotals({ archivados: 10, repuestos: 10, errores: 1, clientes: 2 },
                                 { archivados: 5, repuestos: 4, errores: 2 });
  assert.equal(t.archivados, 15);
  assert.equal(t.repuestos, 14);
  assert.equal(t.errores, 3);
  assert.equal(t.clientes, 3);
});

// ── Reparador de archivados sin reponer (2026-07-30) ────────────────────────
// Una corrida del apply viejo archivó ~21 000 parámetros y las reposiciones fallaron en masa
// contra un ERP que devolvía HTTP 500. Los datos NO se perdieron —están archivados— pero los
// campos quedaron sin parámetro activo. Reponer el MISMO sfp deja el NP como debía quedar.

const CORTE = Date.parse('2026-07-30T03:30:00Z');
const mk = (id, archivedAt, processNodeId, paramId, paramName, fieldId, sfsId) => ({
  id, archivedAt, processNodeId, paramId, paramName, fieldId, sfsId
});

test('planRepairs: campo sin activo y con archivado reciente → reponer ese sfp', () => {
  const filas = [mk(1, '2026-07-30T03:40:00Z', 241753, 900, 'Sí o No', 15820, 500)];
  const r = SMN.planRepairs(filas, CORTE);
  assert.equal(r.length, 1);
  assert.equal(r[0].specFieldId, 15820);
  assert.equal(r[0].specFieldParamId, 900);
  assert.equal(r[0].paramName, 'Sí o No');
});

test('planRepairs: si el campo YA tiene activo, no se toca', () => {
  const filas = [
    mk(1, '2026-07-30T03:40:00Z', 241753, 900, 'Sí o No', 15820, 500),
    mk(2, null, null, 900, 'Sí o No', 15820, 500),      // repuesto correctamente
  ];
  assert.deepEqual(SMN.planRepairs(filas, CORTE), []);
});

test('planRepairs: un archivado VIEJO no se resucita', () => {
  const filas = [mk(1, '2026-05-01T10:00:00Z', 241753, 900, 'Sí o No', 15820, 500)];
  assert.deepEqual(SMN.planRepairs(filas, CORTE), []);
});

test('planRepairs: entre varios archivados recientes del mismo valor, toma el más reciente', () => {
  const filas = [
    mk(1, '2026-07-30T03:40:00Z', 241753, 900, 'Sí o No', 15820, 500),
    mk(2, '2026-07-30T03:45:00Z', 241753, 901, 'Sí o No', 15820, 500),
  ];
  const r = SMN.planRepairs(filas, CORTE);
  assert.equal(r.length, 1);
  assert.equal(r[0].specFieldParamId, 901);
});

test('planRepairs: valores DISTINTOS entre los archivados → no se decide solo', () => {
  const filas = [
    mk(1, '2026-07-30T03:40:00Z', 241753, 900, '5 - 8 µm', 15630, 500),
    mk(2, '2026-07-30T03:45:00Z', 241753, 901, '5 - 10 µm', 15630, 500),
  ];
  const r = SMN.planRepairs(filas, CORTE);
  assert.equal(r.length, 0, 'elegir el valor no le toca al reparador');
});

test('planRepairs: REGRESIÓN — un campo cubierto por OTRA spec del NP no se propone', () => {
  // Caso real (NP 73449-553-04, campo Adherencia 15820): el campo vive en dos specs del mismo
  // NP — sfs=150436 (Níquel) con su parámetro ACTIVO, y sfs=106116 (Estaño) archivado.
  // Agrupando por (campo, sfs) el bucket del Estaño se veía "sin activo" y proponía reponer,
  // aunque el campo YA estaba cubierto. El ERP lo rechazaba con 23P01 —no se corrompió nada—
  // pero el contador sumaba esos intentos como "reparados" e inflaba el total: el operador vio
  // 63 correcciones donde esperaba 11. El criterio correcto es el del ERP: 1 fila viva por
  // specFieldId, sin importar de qué spec venga.
  const filas = [
    mk(1, null, null, 20902273, 'Sí o No', 15820, 150436),                 // ACTIVO, otra spec
    mk(2, '2026-07-30T03:36:19Z', 241753, 28683577, 'Sí o No', 15820, 106116)
  ];
  assert.deepEqual(SMN.planRepairs(filas, CORTE), [],
    'el campo ya tiene parámetro: no hay nada que reparar');
});

test('planRepairs: si NINGUNA spec lo cubre, sí se repara aunque haya varios sfs', () => {
  const filas = [
    mk(1, '2026-07-30T03:36:00Z', 241753, 900, 'Sí o No', 15820, 150436),
    mk(2, '2026-07-30T03:36:19Z', 241753, 901, 'Sí o No', 15820, 106116)
  ];
  const r = SMN.planRepairs(filas, CORTE);
  assert.equal(r.length, 1, 'un solo campo → una sola reposición');
  assert.equal(r[0].specFieldParamId, 901, 'gana el archivado más reciente');
});

test('mergeSweepTotals: acumula yaEstaban aparte de repuestos', () => {
  const t = SMN.mergeSweepTotals({ repuestos: 5, yaEstaban: 40, errores: 1, clientes: 2 },
                                 { repuestos: 3, yaEstaban: 20, errores: 0 });
  assert.equal(t.repuestos, 8, 'reparados = daño realmente corregido');
  assert.equal(t.yaEstaban, 60, 'los rechazados por el ERP no inflan el total');
  assert.equal(t.clientes, 3);
});

// ── Reanudación del reparador: los tres estados ─────────────────────────────
const CLIS = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];

test('planRepairResume: REGRESIÓN — todo revisado y con fallos NO es "reanudar"', () => {
  // El bug (2026-07-30): el checkpoint solo se borraba si la corrida terminaba sin errores,
  // así que una corrida COMPLETA con fallos quedaba "a medias" para siempre. Al aceptar
  // reanudar, la lista de pendientes salía vacía, el bucle no corría y el panel repintaba el
  // resumen viejo en rojo: "me regresa al error anterior y se queda parado".
  const ck = { done: [1, 2, 3], fallidos: [2], totales: { repuestos: 19898, errores: 11 } };
  const p = SMN.planRepairResume(CLIS, ck);
  assert.equal(p.modo, 'reintentar', 'debe ofrecer reintentar, no reanudar en vacío');
  assert.deepEqual(p.pendientes.map(c => c.id), [2], 'solo el que falló');
  assert.equal(p.fallidos, 1);
});

test('planRepairResume: todo revisado y sin fallos → completo, sin pendientes', () => {
  const p = SMN.planRepairResume(CLIS, { done: [1, 2, 3], fallidos: [], totales: {} });
  assert.equal(p.modo, 'completo');
  assert.deepEqual(p.pendientes, []);
});

test('planRepairResume: quedan clientes sin ver → reanudar con los que faltan', () => {
  const p = SMN.planRepairResume(CLIS, { done: [1], fallidos: [], totales: { repuestos: 7 } });
  assert.equal(p.modo, 'reanudar');
  assert.deepEqual(p.pendientes.map(c => c.id), [2, 3]);
  assert.equal(p.totales.repuestos, 7, 'conserva lo acumulado');
});

test('planRepairResume: un fallo con clientes pendientes NO adelanta el reintento', () => {
  // Primero hay que terminar de recorrer; reintentar antes dejaría clientes sin ver.
  const p = SMN.planRepairResume(CLIS, { done: [1], fallidos: [1], totales: {} });
  assert.equal(p.modo, 'reanudar');
  assert.deepEqual(p.pendientes.map(c => c.id), [2, 3]);
  assert.equal(p.fallidos, 1, 'pero el fallo sigue contado');
});

test('planRepairResume: sin checkpoint es una corrida nueva', () => {
  for (const vacio of [null, undefined, {}, { done: [] }]) {
    const p = SMN.planRepairResume(CLIS, vacio);
    assert.equal(p.modo, 'nuevo');
    assert.equal(p.pendientes.length, 3);
  }
});

test('planRepairResume: un checkpoint viejo SIN campo fallidos no truena', () => {
  // Los checkpoints escritos antes de este fix no traen la lista de fallidos. Sin ella no se
  // puede saber quién falló, así que se da por completo y se limpia: es preferible a dejarlo
  // atorado, y volver a correr desde cero siempre es seguro (reponer lo puesto da 23P01).
  const p = SMN.planRepairResume(CLIS, { done: [1, 2, 3], totales: { errores: 11 } });
  assert.equal(p.modo, 'completo');
});

// ── Avance DENTRO de un cliente grande ──────────────────────────────────────
// El checkpoint tenía al cliente como unidad mínima. SCHNEIDER ELECTRIC MEXICO tiene 17 716
// NPs: a esa escala una corrida sin un solo error es prácticamente imposible, así que el
// cliente quedaba fallido y el reintento volvía a empezar por el primero. Nunca terminaba.
// Los NPs se piden con ID_DESC, así que "ya hecho" es exactamente id >= hastaId.
const pnsDesc = (n, desde) => Array.from({ length: n }, (_, i) => ({ id: desde - i, name: 'PN' + (desde - i) }));

test('planCustomerChunk: sin avance previo, procesa todos', () => {
  const t = SMN.planCustomerChunk(pnsDesc(5, 100), null);
  assert.equal(t.pendientes.length, 5);
  assert.equal(t.yaHechos, 0);
});

test('planCustomerChunk: REGRESIÓN — retoma donde quedó, no desde el principio', () => {
  // 17 716 NPs, se completaron hasta el id 9000: solo faltan los menores.
  const todos = pnsDesc(17716, 20000);
  const t = SMN.planCustomerChunk(todos, { hastaId: 9000, fallidos: [] });
  assert.equal(t.pendientes.length, todos.filter(p => p.id < 9000).length);
  assert.ok(t.pendientes.every(p => p.id < 9000), 'nada por encima del cursor');
  assert.ok(t.yaHechos > 11000, 'el grueso ya no se repite');
});

test('planCustomerChunk: los NPs que fallaron se reintentan aunque estén sobre el cursor', () => {
  const todos = pnsDesc(10, 100);           // ids 100..91
  const t = SMN.planCustomerChunk(todos, { hastaId: 95, fallidos: [98, 97] });
  const ids = t.pendientes.map(p => p.id).sort((a, b) => b - a);
  assert.deepEqual(ids, [98, 97, 94, 93, 92, 91], 'los fallidos vuelven, el resto sigue hecho');
  assert.equal(t.reintentos, 2);
});

test('planCustomerChunk: un NP nuevo (id mayor) queda fuera del reintento', () => {
  // Nació después del daño: no necesita reparación, y meterlo desalinearía el cursor.
  const todos = [{ id: 30000 }].concat(pnsDesc(5, 100));
  const t = SMN.planCustomerChunk(todos, { hastaId: 98, fallidos: [] });
  assert.ok(!t.pendientes.some(p => p.id === 30000));
});

test('planCustomerChunk: un cursor basura no esconde trabajo', () => {
  for (const malo of [{ hastaId: null }, { hastaId: 'x' }, {}]) {
    assert.equal(SMN.planCustomerChunk(pnsDesc(4, 50), malo).pendientes.length, 4);
  }
});

test('avanzarCursor: toma el MENOR completado y nunca retrocede', () => {
  assert.equal(SMN.avanzarCursor(null, [500, 480, 495]), 480);
  assert.equal(SMN.avanzarCursor(480, [470, 475]), 470, 'avanza hacia abajo');
  assert.equal(SMN.avanzarCursor(470, [900, 880]), 470, 'un id alto no lo hace retroceder');
});

test('avanzarCursor: sin completados conserva el cursor', () => {
  assert.equal(SMN.avanzarCursor(300, []), 300);
  assert.equal(SMN.avanzarCursor(null, []), null);
});

test('avanzarCursor: usa completados REALES, no el índice del bucle', () => {
  // Con pool 3 hay NPs en vuelo al guardar. Si el cursor se tomara del índice, esos quedarían
  // dados por hechos y su daño no se repararía nunca. Repetirlos no cuesta: reponer un
  // parámetro ya puesto lo rechaza el ERP con 23P01.
  assert.equal(SMN.avanzarCursor(null, [500, 498]), 498,
    'el 499 sigue en vuelo: el cursor no lo rebasa');
});

test('planRepairs: campos distintos se reparan por separado', () => {
  const filas = [
    mk(1, '2026-07-30T03:40:00Z', 241753, 900, 'Sí o No', 15820, 500),
    mk(2, '2026-07-30T03:40:00Z', 241753, 910, 'Elección', 28479, 501),
  ];
  assert.equal(SMN.planRepairs(filas, CORTE).length, 2);
});

test('planRepairs: sin filas no truena', () => {
  assert.deepEqual(SMN.planRepairs([], CORTE), []);
  assert.deepEqual(SMN.planRepairs(null, CORTE), []);
});

test('planRepairs: la reposición NUNCA lleva nodo forzado', () => {
  const filas = [mk(1, '2026-07-30T03:40:00Z', 241753, 900, 'Sí o No', 15820, 500)];
  const r = SMN.planRepairs(filas, CORTE);
  assert.equal(r[0].processNodeId, null, 'el punto de todo esto es dejarlo sin nodo');
});

// ── El checkpoint tiene que sobrevivir a un ERP caído (2026-07-30) ──────────
// Reporte del operador: "pasó varios clientes, pero aún así me bota el error de nuevo".
// El listado de clientes iba ANTES de leer el checkpoint, así que un fallo transitorio al
// listar mataba la corrida y dejaba el avance guardado pero inalcanzable.

test('resolveCustomerList: si el checkpoint trae la lista, no hace falta pedirla', () => {
  const ck = { done: [1], clientes: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };
  const r = SMN.resolveCustomerList(ck, null);
  assert.equal(r.origen, 'checkpoint');
  assert.equal(r.clientes.length, 2);
});

test('resolveCustomerList: sin checkpoint usa la lista recién traída', () => {
  const r = SMN.resolveCustomerList(null, [{ id: 5, name: 'X' }]);
  assert.equal(r.origen, 'servidor');
  assert.equal(r.clientes.length, 1);
});

test('resolveCustomerList: la lista fresca gana si es más completa', () => {
  const ck = { done: [], clientes: [{ id: 1, name: 'A' }] };
  const r = SMN.resolveCustomerList(ck, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  assert.equal(r.origen, 'servidor');
  assert.equal(r.clientes.length, 2);
});

test('resolveCustomerList: si el servidor falla pero hay checkpoint, se sigue con lo guardado', () => {
  const ck = { done: [1], clientes: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };
  const r = SMN.resolveCustomerList(ck, []);      // el listado falló → arreglo vacío
  assert.equal(r.origen, 'checkpoint');
  assert.equal(r.clientes.length, 2);
});

test('resolveCustomerList: sin checkpoint y sin servidor no hay nada que hacer', () => {
  const r = SMN.resolveCustomerList(null, []);
  assert.equal(r.clientes.length, 0);
  assert.equal(r.origen, 'ninguno');
});
