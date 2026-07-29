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
