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
