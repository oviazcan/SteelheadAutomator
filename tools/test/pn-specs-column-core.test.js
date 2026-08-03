// Golden tests del módulo puro pn-specs-column-core.js
// Run: node --test tools/test/pn-specs-column-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'pn-specs-column-core.js'));
const Core = global.window.PnSpecsColumnCore;

// ── Fixture fiel al shape real de GetPartNumber (PN con spec "E27550 (Plata)") ──
// Reproduce: params DUPLICADOS (archivado + activo idéntico), tipos mezclados
// (NUMBER/BOOLEAN/DROPDOWN), y una 2ª spec activa para probar agrupación multi-spec.
// valLabel = specFieldParam.name (lo que Steelhead muestra: "5 - 8 µm", "24 hrs.",
// "Sí o No"). Es el criterio de "numérico" (¿trae dígitos?), no el `type`.
function sfParam(fieldName, type, { min = null, max = null, target = null, unit = null, valLabel = null, specId, specName } = {}) {
  return {
    specFieldParamBySpecFieldParamId: {
      name: valLabel,
      minimumValue: min, maximumValue: max, targetValue: target,
      unitByUnitId: unit ? { name: unit } : null,
      specFieldSpecBySpecFieldSpecId: {
        specFieldBySpecFieldId: { name: fieldName, type: type },
        specBySpecId: { id: specId, name: specName },
      },
    },
  };
}
function node(archivedAt, inner) { return Object.assign({ archivedAt: archivedAt }, inner); }

const SPEC_A = { id: 17395, domainId: 344, idInDomain: 49, revisionNumber: 2, name: 'E27550 (Plata)' };
const SPEC_B = { id: 200, domainId: 344, idInDomain: 88, revisionNumber: 1, name: 'N24 (Níquel)' };
const SPEC_ARCH = { id: 999, domainId: 344, idInDomain: 300, revisionNumber: 3, name: 'Spec Vieja (archivada)' };
const UM = 'µm (micrómetro, micra)';

const FIXTURE = {
  data: {
    partNumberById: {
      partNumberSpecsByPartNumberId: {
        nodes: [
          node(null, { specBySpecId: SPEC_A }),
          node(null, { specBySpecId: SPEC_B }),
          node('2026-05-26T12:46:54.668+00:00', { specBySpecId: SPEC_ARCH }), // archivada → fuera
        ],
      },
      partNumberSpecFieldParamsByPartNumberId: {
        nodes: [
          // Spec A — Espesor NUMBER: archivado (duplicado histórico) + activo idéntico.
          node('2026-05-26T12:46:54.668+00:00', sfParam('Espesor', 'NUMBER', { min: 1.27, max: 3.5, unit: UM, specId: SPEC_A.id, specName: SPEC_A.name })),
          node(null, sfParam('Espesor', 'NUMBER', { min: 1.27, max: 3.5, unit: UM, specId: SPEC_A.id, specName: SPEC_A.name })),
          // dedup: un 2º Espesor activo idéntico no debe contar doble.
          node(null, sfParam('Espesor', 'NUMBER', { min: 1.27, max: 3.5, unit: UM, specId: SPEC_A.id, specName: SPEC_A.name })),
          // Spec A — no numéricos: deben excluirse.
          node(null, sfParam('Adherencia', 'BOOLEAN', { specId: SPEC_A.id, specName: SPEC_A.name })),
          node(null, sfParam('Primeras Piezas', 'DROPDOWN', { specId: SPEC_A.id, specName: SPEC_A.name })),
          // Spec B — dos numéricos: uno con min-only, otro con target.
          node(null, sfParam('Espesor Ni', 'NUMBER', { min: 5, unit: UM, specId: SPEC_B.id, specName: SPEC_B.name })),
          node(null, sfParam('Dureza', 'NUMBER', { target: 450, unit: 'HV (Vickers)', specId: SPEC_B.id, specName: SPEC_B.name })),
        ],
      },
    },
  },
};

// ── isPartNumbersIndexPath ───────────────────────────────────────────────────
test('isPartNumbersIndexPath: match del index (no la ficha)', () => {
  assert.strictEqual(Core.isPartNumbersIndexPath('/PartNumbers'), true);
  assert.strictEqual(Core.isPartNumbersIndexPath('/PartNumbers/'), true);
  assert.strictEqual(Core.isPartNumbersIndexPath('/PartNumbers?q=x'), true);
  assert.strictEqual(Core.isPartNumbersIndexPath('/Domains/344/PartNumbers'), true);
});
test('isPartNumbersIndexPath: NO en la ficha /PartNumbers/:id ni otras rutas', () => {
  assert.strictEqual(Core.isPartNumbersIndexPath('/PartNumbers/3631582'), false);
  assert.strictEqual(Core.isPartNumbersIndexPath('/Invoices'), false);
  assert.strictEqual(Core.isPartNumbersIndexPath('/'), false);
  assert.strictEqual(Core.isPartNumbersIndexPath(null), false);
});

// ── parsePartNumberId ────────────────────────────────────────────────────────
test('parsePartNumberId: extrae el id del href de la celda Nombre', () => {
  assert.strictEqual(Core.parsePartNumberId('/PartNumbers/3631582'), 3631582);
  assert.strictEqual(Core.parsePartNumberId('/PartNumbers/3631582/'), 3631582);
  assert.strictEqual(Core.parsePartNumberId('/PartNumbers/3631582?tab=specs'), 3631582);
  assert.strictEqual(Core.parsePartNumberId('https://app.gosteelhead.com/PartNumbers/42'), 42);
});
test('parsePartNumberId: null sin match', () => {
  assert.strictEqual(Core.parsePartNumberId('/PartNumbers'), null);
  assert.strictEqual(Core.parsePartNumberId('/PartNumberGroups/undefined'), null);
  assert.strictEqual(Core.parsePartNumberId(null), null);
});

// ── unitSymbol ───────────────────────────────────────────────────────────────
test('unitSymbol: primer token corto, conserva acentos', () => {
  assert.strictEqual(Core.unitSymbol('µm (micrómetro, micra)'), 'µm');
  assert.strictEqual(Core.unitSymbol('°C (grados Celsius)'), '°C');
  assert.strictEqual(Core.unitSymbol('HV (Vickers)'), 'HV');
  assert.strictEqual(Core.unitSymbol('mm'), 'mm');
  assert.strictEqual(Core.unitSymbol(null), '');
  assert.strictEqual(Core.unitSymbol('  '), '');
});

// ── formatRange ──────────────────────────────────────────────────────────────
test('formatRange: min–max, min-only, max-only, target, vacío', () => {
  assert.strictEqual(Core.formatRange({ min: 1.27, max: 3.5, unit: 'µm' }), '1.27–3.5 µm');
  assert.strictEqual(Core.formatRange({ min: 5, unit: 'µm' }), '≥ 5 µm');
  assert.strictEqual(Core.formatRange({ max: 3.5, unit: 'µm' }), '≤ 3.5 µm');
  assert.strictEqual(Core.formatRange({ target: 450, unit: 'HV' }), '= 450 HV');
  assert.strictEqual(Core.formatRange({}), '');
});
test('formatRange: target tiene prioridad sobre min/max; unidad opcional', () => {
  assert.strictEqual(Core.formatRange({ min: 1, max: 2, target: 1.5, unit: '°C' }), '= 1.5 °C');
  assert.strictEqual(Core.formatRange({ min: 1.27, max: 3.5 }), '1.27–3.5');
  assert.strictEqual(Core.formatRange({ min: 0, max: 10, unit: 'µm' }), '0–10 µm'); // 0 es límite válido
});

// ── extractSpecsWithNumericParams ────────────────────────────────────────────
test('extract: agrupa numéricos por spec, filtra archivados y no-numéricos', () => {
  const r = Core.extractSpecsWithNumericParams(FIXTURE);
  assert.strictEqual(r.specs.length, 2, 'la spec archivada se excluye');
  assert.strictEqual(r.totalNumericParams, 3, 'Espesor(A) + Espesor Ni(B) + Dureza(B)');

  const a = r.specs.find((s) => s.specId === 17395);
  assert.strictEqual(a.specName, 'E27550 (Plata)');
  assert.strictEqual(Core.specUrl(a), '/Domains/344/Specs/49/Revisions/2', 'URL del link a la spec');
  assert.strictEqual(a.numericParams.length, 1, 'solo Espesor; los cualitativos fuera; dedup del duplicado activo');
  assert.strictEqual(a.numericParams[0].name, 'Espesor');
  assert.strictEqual(a.numericParams[0].value, '1.27–3.5 µm', 'sin valLabel → se reconstruye de min/max');

  const b = r.specs.find((s) => s.specId === 200);
  assert.strictEqual(b.numericParams.length, 2);
  assert.deepStrictEqual(b.numericParams.map((p) => p.name), ['Espesor Ni', 'Dureza']);
  assert.strictEqual(b.numericParams[1].value, '= 450 HV');
});

test('extract: el param archivado (histórico) nunca aparece', () => {
  const r = Core.extractSpecsWithNumericParams(FIXTURE);
  const total = r.specs.reduce((acc, s) => acc + s.numericParams.length, 0);
  assert.strictEqual(total, 3); // 4 params NUMBER en el fixture (1 archivado + 3 activos con 1 dup) → 3
});

test('extract: acepta el `data` completo, `{partNumberById}`, o el nodo directo', () => {
  const direct = FIXTURE.data.partNumberById;
  assert.strictEqual(Core.extractSpecsWithNumericParams(direct).totalNumericParams, 3);
  assert.strictEqual(Core.extractSpecsWithNumericParams({ partNumberById: direct }).totalNumericParams, 3);
  assert.strictEqual(Core.extractSpecsWithNumericParams(FIXTURE).totalNumericParams, 3);
});

test('extract: spec activa SIN params numéricos se incluye vacía', () => {
  const only = {
    partNumberById: {
      partNumberSpecsByPartNumberId: { nodes: [{ archivedAt: null, specBySpecId: { id: 7, name: 'Spec Boolean' } }] },
      partNumberSpecFieldParamsByPartNumberId: {
        nodes: [{ archivedAt: null, specFieldParamBySpecFieldParamId: {
          minimumValue: null, maximumValue: null, targetValue: null, unitByUnitId: null,
          specFieldSpecBySpecFieldSpecId: {
            specFieldBySpecFieldId: { name: 'Aspecto', type: 'BOOLEAN' },
            specBySpecId: { id: 7, name: 'Spec Boolean' } } } }],
      },
    },
  };
  const r = Core.extractSpecsWithNumericParams(only);
  assert.strictEqual(r.specs.length, 1);
  assert.strictEqual(r.specs[0].numericParams.length, 0);
  assert.strictEqual(r.totalNumericParams, 0);
});

test('extract: NO resucita una spec ARCHIVADA aunque su param siga activo (bug 48186-064-50MO)', () => {
  // Caso real: al archivar la SPEC de un PN, Steelhead NO archiva cada
  // partNumberSpecFieldParam individual → quedan params "huérfanos" activos
  // apuntando a una spec archivada. La fuente de verdad es partNumberSpecs.
  const pn = {
    partNumberById: {
      partNumberSpecsByPartNumberId: { nodes: [
        { archivedAt: null, specBySpecId: { id: 100, name: 'FTR00047 (Plata)' } },
        { archivedAt: '2026-01-01T00:00:00Z', specBySpecId: { id: 200, name: 'RC Ag (Plata)' } },   // archivada
        { archivedAt: '2026-01-02T00:00:00Z', specBySpecId: { id: 300, name: 'ASTM B700 (Plata)' } }, // archivada
      ]},
      partNumberSpecFieldParamsByPartNumberId: { nodes: [
        node(null, sfParam('Espesor', 'NUMBER', { min: 2, max: 4.5, unit: UM, specId: 100, specName: 'FTR00047 (Plata)' })),
        // param ACTIVO de RC Ag (spec ARCHIVADA) → NO debe aparecer
        node(null, sfParam('Espesor', 'NUMBER', { min: 2, max: 6, unit: UM, specId: 200, specName: 'RC Ag (Plata)' })),
      ]},
    },
  };
  const r = Core.extractSpecsWithNumericParams(pn);
  assert.strictEqual(r.specs.length, 1, 'solo la spec activa FTR00047');
  assert.strictEqual(r.specs[0].specName, 'FTR00047 (Plata)');
  assert.strictEqual(r.totalNumericParams, 1, 'el param huérfano de RC Ag no cuenta');
  assert.strictEqual(Core.formatCellText(r), 'FTR00047 (Plata): Espesor 2–4.5 µm');
});

test('extract: criterio "el valor trae números" (PN 3029783 real) — NO por specField.type', () => {
  // Datos reales: params BOOLEAN cuyo VALOR es numérico ("24 hrs." = cámara salina)
  // SÍ deben salir; los cualitativos ("Sí o No", "Elección") NO. El type es irrelevante.
  const SPEC = { id: 500, idInDomain: 111, name: 'RC Cámara Salina' };
  const pn = {
    partNumberById: {
      partNumberSpecsByPartNumberId: { nodes: [{ archivedAt: null, specBySpecId: SPEC }] },
      partNumberSpecFieldParamsByPartNumberId: { nodes: [
        node(null, sfParam('Tiempo s/Corrosión Blanca', 'BOOLEAN', { valLabel: '24 hrs.', specId: SPEC.id, specName: SPEC.name })),
        node(null, sfParam('Tiempo s/Corrosión Roja', 'BOOLEAN', { valLabel: '72 hrs.', specId: SPEC.id, specName: SPEC.name })),
        node(null, sfParam('Temperatura (Deshidrogenado)', 'NUMBER', { valLabel: '176 - 204 °C (375 ± 25 °F)', specId: SPEC.id, specName: SPEC.name })),
        node(null, sfParam('Adherencia', 'BOOLEAN', { valLabel: 'Sí o No', specId: SPEC.id, specName: SPEC.name })),
        node(null, sfParam('Instrumento de Medición', 'DROPDOWN', { valLabel: 'Elección', specId: SPEC.id, specName: SPEC.name })),
      ]},
    },
  };
  const r = Core.extractSpecsWithNumericParams(pn);
  assert.strictEqual(r.totalNumericParams, 3, '2 Tiempo (24/72 hrs.) + Temperatura; Adherencia/Instrumento fuera');
  const names = r.specs[0].numericParams.map((p) => p.name);
  assert.ok(names.includes('Tiempo s/Corrosión Blanca'), 'BOOLEAN "24 hrs." SÍ sale (cámara salina)');
  assert.ok(!names.includes('Adherencia'), '"Sí o No" NO sale');
  assert.ok(!names.includes('Instrumento de Medición'), '"Elección" NO sale');
  assert.strictEqual(r.specs[0].numericParams[0].value, '24 hrs.', 'el valLabel se muestra tal cual');
});

test('specUrl: arma /Domains/<d>/Specs/<idInDomain>/Revisions/<rev>; null si falta lo esencial', () => {
  assert.strictEqual(Core.specUrl({ specDomainId: 344, specIdInDomain: 49, specRevision: 2 }), '/Domains/344/Specs/49/Revisions/2');
  assert.strictEqual(Core.specUrl({ specDomainId: 344, specIdInDomain: 49, specRevision: null }), '/Domains/344/Specs/49/Revisions');
  assert.strictEqual(Core.specUrl({ specDomainId: null, specIdInDomain: 49, specRevision: 2 }), null);
  assert.strictEqual(Core.specUrl({ specDomainId: 344, specIdInDomain: null }), null);
  assert.strictEqual(Core.specUrl(null), null);
});

test('extract: fail-safe ante shape vacío/inesperado', () => {
  assert.deepStrictEqual(Core.extractSpecsWithNumericParams({}), { specs: [], totalNumericParams: 0 });
  assert.deepStrictEqual(Core.extractSpecsWithNumericParams(null), { specs: [], totalNumericParams: 0 });
  assert.deepStrictEqual(Core.extractSpecsWithNumericParams({ data: { partNumberById: null } }), { specs: [], totalNumericParams: 0 });
});

// ── formatCellText ───────────────────────────────────────────────────────────
test('formatCellText: texto canónico compacto', () => {
  const r = Core.extractSpecsWithNumericParams(FIXTURE);
  assert.strictEqual(
    Core.formatCellText(r),
    'E27550 (Plata): Espesor 1.27–3.5 µm  |  N24 (Níquel): Espesor Ni ≥ 5 µm · Dureza = 450 HV'
  );
});
test('formatCellText: spec sin numéricos → "—" ; nada → "—"', () => {
  assert.strictEqual(Core.formatCellText({ specs: [{ specName: 'X', numericParams: [] }] }), 'X: —');
  assert.strictEqual(Core.formatCellText({ specs: [] }), '—');
  assert.strictEqual(Core.formatCellText(null), '—');
});

// ════════════════════════════════════════════════════════════════════════════
// COLUMNAS ADICIONALES (metal base · línea · rack types · unidades)
// ════════════════════════════════════════════════════════════════════════════
// FIXTURE REAL capturado en vivo el 2026-07-29 del PN 2300153 "51004727AA"
// (GetPartNumber, hash 5efd689d…, HTTP 200, response de 5.84 MB destilado a lo
// que consume el core). Datos verbatim: metal "Cobre"; línea = dim 349 valor 154
// "T107-LI Plata Colgado Cx (60.0)"; departamento = dim 586 valor 182 "Producción";
// racks T102-RA02→18 y T107-FL01→54; 5 factores de unidad; 1 spec activa (14342)
// con 6 params y 2 params HUÉRFANOS de la spec 16165 ARCHIVADA.
const REAL = {
  data: {
    partNumberById: {
      id: 2300153,
      name: '51004727AA',
      customInputs: { DatosAdicionalesNP: { BaseMetal: 'Cobre', QuoteIBMS: '61292', EstacionIBMS: '4134-1' } },
      acctPnDimensionValueSelectionsByPartNumberId: { nodes: [
        { id: 25703, dimensionId: 349, dimensionCustomValueId: 154, __typename: 'AcctPnDimensionValueSelection' },
        { id: 25704, dimensionId: 586, dimensionCustomValueId: 182, __typename: 'AcctPnDimensionValueSelection' },
      ]},
      // OJO: el orden que devuelve el server NO es alfabético (T107 llega después de
      // T102 aquí, pero no hay garantía) → extractRackTypes ordena.
      partNumberRackTypesByPartNumberId: { nodes: [
        { id: 77051, partsPerRack: 18, partNumberId: 2300153, rackTypeByRackTypeId: { id: 2681, name: 'T102-RA02', unitByPartCountDisplayUnitId: null, __typename: 'RackType' }, __typename: 'PartNumberRackType' },
        { id: 177401, partsPerRack: 54, partNumberId: 2300153, rackTypeByRackTypeId: { id: 2694, name: 'T107-FL01', unitByPartCountDisplayUnitId: null, __typename: 'RackType' }, __typename: 'PartNumberRackType' },
      ]},
      inventoryItemByPartNumberId: { id: 870948, inventoryItemUnitConversionsByInventoryItemId: { nodes: [
        { id: 1, factor: 0.376,        unitByUnitId: { id: 3969, name: 'KGM Kilogramo',            mustBeInteger: false, __typename: 'Unit' } },
        { id: 2, factor: 1.162,        unitByUnitId: { id: 3971, name: 'DMK Decímetro Cuadrado',   mustBeInteger: false, __typename: 'Unit' } },
        { id: 3, factor: 0.82893712,   unitByUnitId: { id: 3970, name: 'LBR Libra',               mustBeInteger: false, __typename: 'Unit' } },
        { id: 4, factor: 120.58,       unitByUnitId: { id: 3972, name: 'CMK Centímetro Cuadrado', mustBeInteger: false, __typename: 'Unit' } },
        { id: 5, factor: 0.1297911062, unitByUnitId: { id: 3973, name: 'FTK Pie Cuadrado',        mustBeInteger: false, __typename: 'Unit' } },
      ]}},
      partNumberSpecsByPartNumberId: { nodes: [
        { archivedAt: null, specBySpecId: { id: 14342, name: 'ABD01030 (Plata Semibrillante)', domainId: 344, idInDomain: 21, revisionNumber: 1 } },
        { archivedAt: '2025-12-08T14:49:02.557+00:00', specBySpecId: { id: 14868, name: 'T107-LI', domainId: 344, idInDomain: 30, revisionNumber: 1 } },
        { archivedAt: '2026-05-22T13:15:20.004+00:00', specBySpecId: { id: 16165, name: 'Inspección Recibo', domainId: 344, idInDomain: 40, revisionNumber: 1 } },
        { archivedAt: '2026-06-18T01:50:38.353+00:00', specBySpecId: { id: 20407, name: 'ASTM B700 (Plata)', domainId: 344, idInDomain: 55, revisionNumber: 1 } },
      ]},
      partNumberSpecFieldParamsByPartNumberId: { nodes: [
        node(null, sfParam('Apariencia Homogénea - Semibrillante', 'BOOLEAN', { valLabel: 'Sí o No', specId: 14342, specName: 'ABD01030 (Plata Semibrillante)' })),
        node(null, sfParam('Adherencia', 'BOOLEAN', { valLabel: 'Sí o No', specId: 14342, specName: 'ABD01030 (Plata Semibrillante)' })),
        node(null, sfParam('Primeras Piezas', 'DROPDOWN', { valLabel: 'Sí o No', specId: 14342, specName: 'ABD01030 (Plata Semibrillante)' })),
        // huérfanos ACTIVOS de una spec ARCHIVADA (16165) → no deben resucitarla
        node(null, sfParam('Condiciones Adecuadas del Material Recibido', 'BOOLEAN', { valLabel: 'Sí o No', specId: 16165, specName: 'Inspección Recibo' })),
        node(null, sfParam('Requiere notificar al cliente', 'DROPDOWN', { valLabel: 'Sí o No', specId: 16165, specName: 'Inspección Recibo' })),
        node(null, sfParam('Instrumento de Medición', 'DROPDOWN', { valLabel: 'Elección', specId: 14342, specName: 'ABD01030 (Plata Semibrillante)' })),
        node(null, sfParam('Espesor', 'NUMBER', { valLabel: '2 - 5 µm', min: 2, max: 5, unit: UM, specId: 14342, specName: 'ABD01030 (Plata Semibrillante)' })),
      ]},
    },
    // Catálogo de dimensiones contables: viaja en el MISMO response, a nivel raíz.
    allAcctDimensions: { nodes: [
      { id: 349, name: 'Línea', type: 'CUSTOM', acctDimensionCustomValuesByDimensionId: { nodes: [
        { id: 154, value: 'T107-LI Plata Colgado Cx (60.0)', __typename: 'AcctDimensionCustomValue' },
        { id: 150, value: 'T101-LI Pre Limpieza (4.0)', __typename: 'AcctDimensionCustomValue' },
        { id: 153, value: 'T205-LI Plata y Estaño (16.3)', __typename: 'AcctDimensionCustomValue' },
      ]}},
      { id: 586, name: 'Departamento', type: 'CUSTOM', acctDimensionCustomValuesByDimensionId: { nodes: [
        { id: 182, value: 'Producción', __typename: 'AcctDimensionCustomValue' },
        { id: 151, value: 'Ingeniería de Procesos', __typename: 'AcctDimensionCustomValue' },
      ]}},
    ]},
  },
};

test('metal base: sale de customInputs.DatosAdicionalesNP.BaseMetal', () => {
  assert.strictEqual(Core.extractMetalBase(REAL), 'Cobre');
  assert.strictEqual(Core.extractMetalBase(REAL.data.partNumberById), 'Cobre', 'acepta el partNumberById directo');
  assert.strictEqual(Core.extractMetalBase({ partNumberById: { customInputs: {} } }), '', 'sin grupo → vacío, no "undefined"');
  assert.strictEqual(Core.extractMetalBase({ partNumberById: { customInputs: { DatosAdicionalesNP: { BaseMetal: '  Acero  ' } } } }), 'Acero', 'trim');
  assert.strictEqual(Core.extractMetalBase(null), '');
});

test('línea: cruza la selección (dim 349) contra allAcctDimensions del MISMO response', () => {
  assert.strictEqual(Core.extractLinea(REAL), 'T107-LI Plata Colgado Cx (60.0)');
  // el id se puede parametrizar desde config.steelhead.domain.dimensionIds
  assert.strictEqual(Core.extractDimensionValue(REAL, 586), 'Producción', 'mismo mecanismo para Departamento');
});

test('línea: vacío (NO inventa) cuando el NP no la tiene seleccionada o falta el catálogo', () => {
  const sinLinea = JSON.parse(JSON.stringify(REAL));
  sinLinea.data.partNumberById.acctPnDimensionValueSelectionsByPartNumberId.nodes =
    sinLinea.data.partNumberById.acctPnDimensionValueSelectionsByPartNumberId.nodes.filter((s) => s.dimensionId !== 349);
  assert.strictEqual(Core.extractLinea(sinLinea), '', 'PN sin línea → vacío (caso real: PN 3631582)');

  const sinCatalogo = JSON.parse(JSON.stringify(REAL));
  delete sinCatalogo.data.allAcctDimensions;
  assert.strictEqual(Core.extractLinea(sinCatalogo), '', 'sin catálogo no se adivina el label a partir del id');

  const idDesconocido = JSON.parse(JSON.stringify(REAL));
  idDesconocido.data.partNumberById.acctPnDimensionValueSelectionsByPartNumberId.nodes[0].dimensionCustomValueId = 999999;
  assert.strictEqual(Core.extractLinea(idDesconocido), '', 'valor fuera del catálogo → vacío');
});

test('línea: si el ID del config no está en el catálogo, cae al nombre ES+EN (solo AMPLÍA)', () => {
  const renumerado = JSON.parse(JSON.stringify(REAL));
  renumerado.data.allAcctDimensions.nodes[0].id = 777;               // el dominio renumeró la dim
  renumerado.data.partNumberById.acctPnDimensionValueSelectionsByPartNumberId.nodes[0].dimensionId = 777;
  assert.strictEqual(Core.extractLinea(renumerado), 'T107-LI Plata Colgado Cx (60.0)', 'match por nombre "Línea"');

  const enIngles = JSON.parse(JSON.stringify(renumerado));
  enIngles.data.allAcctDimensions.nodes[0].name = 'Line';
  assert.strictEqual(Core.extractLinea(enIngles), 'T107-LI Plata Colgado Cx (60.0)', 'UI en inglés: "Line"');

  const otraDim = JSON.parse(JSON.stringify(renumerado));
  otraDim.data.allAcctDimensions.nodes[0].name = 'Centro de Costos';
  assert.strictEqual(Core.extractLinea(otraDim), '', 'no matchea por nombre → NO agarra otra dimensión');
});

test('rack types: nombre + piezas por carga, ordenados y sin duplicados', () => {
  const racks = Core.extractRackTypes(REAL);
  assert.deepStrictEqual(racks, [
    { rackTypeId: 2681, name: 'T102-RA02', partsPerRack: 18, unit: '' },
    { rackTypeId: 2694, name: 'T107-FL01', partsPerRack: 54, unit: '' },
  ]);
  assert.strictEqual(Core.formatRackTypesText(racks), 'T102-RA02 (18 pz) · T107-FL01 (54 pz)');
  assert.strictEqual(Core.formatRackTypesText([]), '—');
  assert.deepStrictEqual(Core.extractRackTypes({ partNumberById: {} }), [], 'sin racks → []');
});

test('rack types: partsPerRack null se marca "?" (no se inventa 0 ni 1)', () => {
  const r = Core.extractRackTypes({ partNumberById: { partNumberRackTypesByPartNumberId: { nodes: [
    { partsPerRack: null, rackTypeByRackTypeId: { id: 9, name: 'T900-XX01' } },
  ]}}});
  assert.strictEqual(r[0].partsPerRack, null);
  assert.strictEqual(Core.formatRackTypesText(r), 'T900-XX01 (? pz)',
    'un dato faltante NO puede leerse como "1 pieza por carga" (ese supuesto multiplica duraciones por miles — ver wo-schedule-button)');
});

test('rack types: si el rack type trae unidad de conteo, se muestra', () => {
  const r = Core.extractRackTypes({ partNumberById: { partNumberRackTypesByPartNumberId: { nodes: [
    { partsPerRack: 12, rackTypeByRackTypeId: { id: 7, name: 'T300-BA01', unitByPartCountDisplayUnitId: { name: 'KGM Kilogramo' } } },
  ]}}});
  assert.strictEqual(r[0].unit, 'KGM');
  assert.strictEqual(Core.formatRackTypesText(r), 'T300-BA01 (12 KGM)');
});

test('unidades: TODOS los factores registrados, con su código y sin perder precisión', () => {
  const units = Core.extractUnitFactors(REAL);
  assert.strictEqual(units.length, 5, 'los 5 registrados, ninguno filtrado');
  assert.deepStrictEqual(units.map((u) => u.code), ['KGM', 'LBR', 'DMK', 'FTK', 'CMK'],
    'orden del ERP: peso → superficie (ver UNIT_ORDER)');
  const byCode = {}; units.forEach((u) => { byCode[u.code] = u; });
  assert.strictEqual(byCode.KGM.factor, 0.376);
  assert.strictEqual(byCode.KGM.name, 'KGM Kilogramo');
  assert.strictEqual(byCode.KGM.unitId, 3969);
  // El TEXTO de celda usa 3 decimales (0.3.1); el valor exacto vive en fmtFactor/el hover.
  assert.strictEqual(Core.formatUnitFactorsText(units),
    'KGM 0.376 · LBR 0.829 · DMK 1.162 · FTK 0.130 · CMK 120.580');
  assert.strictEqual(Core.fmtFactor(byCode.FTK.factor), '0.1297911062', 'el dato NO se pierde');
  assert.strictEqual(Core.formatUnitFactorsText([]), '—');
});

test('unidades: fmtFactor limpia el ruido binario SIN truncar el dato maestro', () => {
  // valor real que devolvió el server para LBR del PN 3631582
  assert.strictEqual(Core.fmtFactor(6.3933979999999995), '6.393398');
  assert.strictEqual(Core.fmtFactor(0.1297911062), '0.1297911062', '10 significativos: NO se recorta');
  assert.strictEqual(Core.fmtNum(0.1297911062), '0.129791', 'fmtNum sigue en 6 sig (no se cambió el default)');
  assert.strictEqual(Core.fmtFactor(120.58), '120.58');
  assert.strictEqual(Core.fmtFactor(null), '');
});

test('unidades: sin item de inventario → [] (fail-safe, no truena)', () => {
  assert.deepStrictEqual(Core.extractUnitFactors({ partNumberById: { inventoryItemByPartNumberId: null } }), []);
  assert.deepStrictEqual(Core.extractUnitFactors({}), []);
  assert.deepStrictEqual(Core.extractUnitFactors(null), []);
});

test('extractPnRow: una pasada, todas las columnas, sobre el fixture REAL', () => {
  const row = Core.extractPnRow(REAL, { lineaDimId: 349 });
  assert.strictEqual(row.metal, 'Cobre');
  assert.strictEqual(row.linea, 'T107-LI Plata Colgado Cx (60.0)');
  assert.strictEqual(row.rackTypes.length, 2);
  assert.strictEqual(row.units.length, 5);
  // specs: solo la ACTIVA (14342) y solo su param con valor numérico (Espesor)
  assert.strictEqual(row.specs.length, 1, 'las 3 specs archivadas quedan fuera');
  assert.strictEqual(row.specs[0].specName, 'ABD01030 (Plata Semibrillante)');
  assert.strictEqual(row.totalNumericParams, 1, '"Sí o No"/"Elección" no cuentan');
  assert.deepStrictEqual(row.specs[0].numericParams, [{ name: 'Espesor', value: '2 - 5 µm' }]);
});

test('extractPnRow: los params HUÉRFANOS de la spec archivada 16165 no la resucitan', () => {
  const row = Core.extractPnRow(REAL, { lineaDimId: 349 });
  const names = row.specs.map((s) => s.specName);
  assert.ok(!names.includes('Inspección Recibo'),
    'tiene 2 params ACTIVOS pero su partNumberSpec está archivada (bug 0.1.1)');
});

test('extractPnRow: response vacío → fila vacía sin excepciones', () => {
  const row = Core.extractPnRow({}, {});
  assert.deepStrictEqual(row, { specs: [], totalNumericParams: 0, metal: '', descripcion: '', linea: '', rackTypes: [], units: [] });
  assert.doesNotThrow(() => Core.extractPnRow(null, null));
});

// ════════════════════════════════════════════════════════════════════════════
// v0.3.1 — formato compacto (el ancho es el recurso escaso)
// ════════════════════════════════════════════════════════════════════════════

test('fmtQty3: 3 decimales, miles con coma, decimal con punto', () => {
  assert.strictEqual(Core.fmtQty3(0.376), '0.376');
  assert.strictEqual(Core.fmtQty3(120.58), '120.580', 'rellena a 3 para que los puntos queden en columna');
  assert.strictEqual(Core.fmtQty3(0.82893712), '0.829');
  assert.strictEqual(Core.fmtQty3(0.1297911062), '0.130');
  assert.strictEqual(Core.fmtQty3(1234.5678), '1,234.568', 'miles con coma');
  assert.strictEqual(Core.fmtQty3(1234567), '1,234,567.000');
  assert.strictEqual(Core.fmtQty3(0), '0.000');
  assert.strictEqual(Core.fmtQty3(-1234.5), '-1,234.500');
  assert.strictEqual(Core.fmtQty3(null), '');
  assert.strictEqual(Core.fmtQty3(''), '');
});

test('fmtQty3: un factor chico NO se muestra como cero', () => {
  // "0.000" se leería como "esta unidad no aplica" y sería mentira sobre el dato.
  assert.strictEqual(Core.fmtQty3(0.0004), '<0.001');
  assert.strictEqual(Core.fmtQty3(0.0000001), '<0.001');
  assert.strictEqual(Core.fmtQty3(-0.0004), '>-0.001');
  assert.strictEqual(Core.fmtQty3(0.0005), '0.001', 'el umbral redondea normal, no cae al literal');
  assert.strictEqual(Core.fmtQty3(0), '0.000', 'un cero REAL sí se muestra como cero');
});

test('fmtFactor sigue dando el valor exacto (es lo que va en el hover)', () => {
  assert.strictEqual(Core.fmtFactor(0.1297911062), '0.1297911062');
  assert.strictEqual(Core.fmtQty3(0.1297911062), '0.130', 'lo que se PINTA son 3 decimales');
});

test('formatRackChip: "nombre (cantidad unidad)"', () => {
  assert.strictEqual(Core.formatRackChip({ name: 'T102-RA02', partsPerRack: 18, unit: '' }), 'T102-RA02 (18 pz)');
  assert.strictEqual(Core.formatRackChip({ name: 'T300-BA01', partsPerRack: 12, unit: 'KGM' }), 'T300-BA01 (12 KGM)');
  assert.strictEqual(Core.formatRackChip({ name: 'T900-XX01', partsPerRack: null, unit: '' }), 'T900-XX01 (? pz)',
    'sin dato sigue siendo "?", nunca 1');
  assert.strictEqual(Core.formatRackChip(null), '');
});

test('formatRackTypesText / formatUnitFactorsText usan el formato nuevo', () => {
  const row = Core.extractPnRow(REAL, { lineaDimId: 349 });
  assert.strictEqual(Core.formatRackTypesText(row.rackTypes), 'T102-RA02 (18 pz) · T107-FL01 (54 pz)');
  assert.strictEqual(Core.formatUnitFactorsText(row.units),
    'KGM 0.376 · LBR 0.829 · DMK 1.162 · FTK 0.130 · CMK 120.580',
    'sin "/pz" por renglón: ese sufijo vive en el encabezado de la columna');
});

test('descripción: se toma de descriptionMarkdown y se limpia el markdown', () => {
  assert.strictEqual(Core.extractDescription({ partNumberById: { descriptionMarkdown: 'CONECTOR' } }), 'CONECTOR');
  assert.strictEqual(Core.extractDescription({ partNumberById: { descriptionMarkdown: '**CONECTOR**' } }), 'CONECTOR',
    'el campo admite markdown: los asteriscos no se pintan');
  assert.strictEqual(Core.extractDescription({ partNumberById: { descriptionMarkdown: '## Título\nsegunda línea' } }), 'Título · segunda línea',
    'multilínea se aplana: la celda del nombre es de un renglón');
  assert.strictEqual(Core.extractDescription({ partNumberById: { descriptionMarkdown: 'ver [ficha](http://x/y)' } }), 'ver ficha');
  assert.strictEqual(Core.extractDescription({ partNumberById: { descriptionMarkdown: '  BASE  ' } }), 'BASE');
  assert.strictEqual(Core.extractDescription({ partNumberById: { descriptionMarkdown: null } }), '');
  assert.strictEqual(Core.extractDescription({}), '');
  assert.strictEqual(Core.extractDescription(null), '');
});

test('formatNameInfo: "descripción · metal", y vacío si no hay ninguno', () => {
  assert.strictEqual(Core.formatNameInfo({ descripcion: 'CONECTOR', metal: 'Cobre' }), 'CONECTOR · Cobre');
  assert.strictEqual(Core.formatNameInfo({ descripcion: 'CONECTOR', metal: '' }), 'CONECTOR');
  assert.strictEqual(Core.formatNameInfo({ descripcion: '', metal: 'Cobre' }), 'Cobre');
  assert.strictEqual(Core.formatNameInfo({ descripcion: '', metal: '' }), '',
    'vacío ⇒ el glue no inyecta nada en la celda nativa');
  assert.strictEqual(Core.formatNameInfo(null), '');
});

test('extractPnRow incluye la descripción; la línea se sigue extrayendo aunque ya no se pinte', () => {
  const conDesc = JSON.parse(JSON.stringify(REAL));
  conDesc.data.partNumberById.descriptionMarkdown = 'CONECTOR';
  const row = Core.extractPnRow(conDesc, { lineaDimId: 349 });
  assert.strictEqual(row.descripcion, 'CONECTOR');
  assert.strictEqual(Core.formatNameInfo(row), 'CONECTOR · Cobre');
  assert.strictEqual(row.linea, 'T107-LI Plata Colgado Cx (60.0)',
    'la columna se retiró por duplicada con la nativa, pero la extracción queda disponible');
});

// ════════════════════════════════════════════════════════════════════════════
// v0.3.2 — orden de unidades igual al del ERP
// ════════════════════════════════════════════════════════════════════════════

test('unidades: se ordenan por MAGNITUD como el modal de Steelhead, no alfabéticamente', () => {
  // Orden capturado del modal "Per Part Count Unit Definitions" del NP:
  // peso (KGM, LBR) → superficie (DMK, FTK, CMK) → longitud (FOT, LM) → lote (LO).
  const input = { partNumberById: { inventoryItemByPartNumberId: { inventoryItemUnitConversionsByInventoryItemId: { nodes: [
    { factor: 1, unitByUnitId: { id: 1, name: 'LO Lote' } },
    { factor: 2, unitByUnitId: { id: 2, name: 'CMK Centímetro Cuadrado' } },
    { factor: 3, unitByUnitId: { id: 3, name: 'KGM Kilogramo' } },
    { factor: 4, unitByUnitId: { id: 4, name: 'LM Metro Lineal' } },
    { factor: 5, unitByUnitId: { id: 5, name: 'FTK Pie Cuadrado' } },
    { factor: 6, unitByUnitId: { id: 6, name: 'LBR Libra' } },
    { factor: 7, unitByUnitId: { id: 7, name: 'FOT ft Pie' } },
    { factor: 8, unitByUnitId: { id: 8, name: 'DMK Decímetro Cuadrado' } },
  ]}}}};
  assert.deepStrictEqual(
    Core.extractUnitFactors(input).map((u) => u.code),
    ['KGM', 'LBR', 'DMK', 'FTK', 'CMK', 'FOT', 'LM', 'LO']
  );
});

test('unidades: "KG" (sin M) se ordena junto al kilogramo, no al final', () => {
  const input = { partNumberById: { inventoryItemByPartNumberId: { inventoryItemUnitConversionsByInventoryItemId: { nodes: [
    { factor: 1, unitByUnitId: { id: 1, name: 'LBR Libra' } },
    { factor: 2, unitByUnitId: { id: 2, name: 'KG Kilogramo' } },
  ]}}}};
  assert.deepStrictEqual(Core.extractUnitFactors(input).map((u) => u.code), ['KG', 'LBR']);
  assert.ok(Core.unitOrderIndex('KG') < Core.unitOrderIndex('LBR'));
});

test('unidades: una unidad DESCONOCIDA cae al final y no descoloca a las conocidas', () => {
  const input = { partNumberById: { inventoryItemByPartNumberId: { inventoryItemUnitConversionsByInventoryItemId: { nodes: [
    { factor: 1, unitByUnitId: { id: 1, name: 'ZZZ Unidad Nueva' } },
    { factor: 2, unitByUnitId: { id: 2, name: 'AAA Otra Nueva' } },
    { factor: 3, unitByUnitId: { id: 3, name: 'KGM Kilogramo' } },
  ]}}}};
  assert.deepStrictEqual(Core.extractUnitFactors(input).map((u) => u.code), ['KGM', 'AAA', 'ZZZ'],
    'las nuevas al final, alfabéticas entre sí');
  assert.strictEqual(Core.unitOrderIndex('QQQ'), Core.UNIT_ORDER.length);
});

test('unidades del fixture REAL salen en el orden del ERP', () => {
  const row = Core.extractPnRow(REAL, { lineaDimId: 349 });
  assert.deepStrictEqual(row.units.map((u) => u.code), ['KGM', 'LBR', 'DMK', 'FTK', 'CMK']);
  assert.strictEqual(Core.formatUnitFactorsText(row.units),
    'KGM 0.376 · LBR 0.829 · DMK 1.162 · FTK 0.130 · CMK 120.580');
});

// ---------- isStaleNode: el nodo inyectado que quedó de OTRO número de parte ----------
// Bug reportado en piso (2026-07-31): al archivar un NP, su renglón seguía mostrando la spec
// del archivado —nombre de un NP, columnas de otro— y solo recargando se recomponía. React
// recicla el <tr>; nuestra celda inyectada sobrevivía porque el glue solo miraba si EXISTÍA.

test('isStaleNode: el id cambió → hay que reconstruir', () => {
  assert.equal(Core.isStaleNode('123', 456), true);
  assert.equal(Core.isStaleNode(123, 456), true);
});

test('isStaleNode: mismo id → se conserva (compara como texto, no por tipo)', () => {
  assert.equal(Core.isStaleNode('456', 456), false);
  assert.equal(Core.isStaleNode(456, '456'), false);
});

test('isStaleNode: nodo nuestro sin dueño → reconstruir', () => {
  // Un nodo con nuestra clase pero sin data-sa-pnid no se puede confiar: no sabemos de quién es.
  assert.equal(Core.isStaleNode(null, 456), true);
  assert.equal(Core.isStaleNode('', 456), true);
});

test('isStaleNode: fila sin id resuelto NO se reconstruye', () => {
  // Sin link de NP la fila no está reciclada: todavía no resuelve. Reconstruir ahí borraría
  // celdas buenas en cada sync y el observer entraría en bucle.
  assert.equal(Core.isStaleNode('123', null), false);
  assert.equal(Core.isStaleNode(null, null), false);
});
