// tools/test/load-calculator-geometry.test.js
//
// Tests TDD para funciones puras de geometría F2c del load-calculator.
// Se importan desde load-calculator-engine.js una vez implementadas.
// Correr con: node --test tools/test/load-calculator-geometry.test.js
//
// Funciones a testear:
//   classifyGeometryState(geometryTypeId, genericId) → 'SIN_GEOMETRIA'|'GENERICA'|'OTRA'
//   dimsFromPartNumber(nodes, geometryDimensions)     → {lengthM, widthM, heightM}|null
//   areaFromDims(lengthM, widthM)                    → área en dm²
//   buildAreaConversions(areaDm2, conversions)        → {dmk, cmk, ftk}
//   dimsAreDifferent(capturedDims, existingDims, tol) → boolean

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const E = require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'load-calculator-engine.js'));

// ──────────────────────────────────────────────────────────────────
// classifyGeometryState
// ──────────────────────────────────────────────────────────────────

test('classifyGeometryState: null/undefined → SIN_GEOMETRIA', () => {
  assert.equal(E.classifyGeometryState(null, 831), 'SIN_GEOMETRIA');
  assert.equal(E.classifyGeometryState(undefined, 831), 'SIN_GEOMETRIA');
  assert.equal(E.classifyGeometryState(0, 831), 'SIN_GEOMETRIA');
});

test('classifyGeometryState: geometryTypeId === genericId → GENERICA', () => {
  assert.equal(E.classifyGeometryState(831, 831), 'GENERICA');
});

test('classifyGeometryState: otro id → OTRA', () => {
  assert.equal(E.classifyGeometryState(100, 831), 'OTRA');
  assert.equal(E.classifyGeometryState(999, 831), 'OTRA');
});

// ──────────────────────────────────────────────────────────────────
// dimsFromPartNumber
// ──────────────────────────────────────────────────────────────────

// Los nodos de partNumberDimensionsByPartNumberId.nodes tienen:
//   { geometryTypeDimensionTypeId, dimensionValue, unitByUnitId: { id } }
// El unitId de MTR = 3971 (metros). Los valores se almacenan en metros.

const GEO_DIMS = { LENGTH: 1284, WIDTH: 1011, HEIGHT: 1012, OUTER_DIAM: 1013, INNER_DIAM: 1014 };
const MTR_ID = 3971;

test('dimsFromPartNumber: extrae lengthM y widthM de nodos (MTR)', () => {
  const nodes = [
    { geometryTypeDimensionTypeId: 1284, dimensionValue: 0.22, unitByUnitId: { id: MTR_ID } },  // LENGTH 0.22m
    { geometryTypeDimensionTypeId: 1011, dimensionValue: 0.00635, unitByUnitId: { id: MTR_ID } }, // WIDTH 0.00635m
    { geometryTypeDimensionTypeId: 1012, dimensionValue: 0.01, unitByUnitId: { id: MTR_ID } },   // HEIGHT 0.01m
  ];
  const r = E.dimsFromPartNumber(nodes, GEO_DIMS);
  assert.ok(r !== null, 'no debería ser null con nodos válidos');
  assert.ok(Math.abs(r.lengthM - 0.22) < 1e-10, `lengthM=${r.lengthM}`);
  assert.ok(Math.abs(r.widthM - 0.00635) < 1e-10, `widthM=${r.widthM}`);
  assert.ok(Math.abs(r.heightM - 0.01) < 1e-10, `heightM=${r.heightM}`);
});

test('dimsFromPartNumber: sin nodos → null', () => {
  assert.equal(E.dimsFromPartNumber([], GEO_DIMS), null);
  assert.equal(E.dimsFromPartNumber(null, GEO_DIMS), null);
});

test('dimsFromPartNumber: sin LENGTH ni WIDTH → null', () => {
  const nodes = [
    { geometryTypeDimensionTypeId: 1012, dimensionValue: 0.01, unitByUnitId: { id: MTR_ID } }, // solo HEIGHT
  ];
  assert.equal(E.dimsFromPartNumber(nodes, GEO_DIMS), null);
});

test('dimsFromPartNumber: solo LENGTH y WIDTH (sin HEIGHT) → retorna con heightM=null', () => {
  const nodes = [
    { geometryTypeDimensionTypeId: 1284, dimensionValue: 0.3, unitByUnitId: { id: MTR_ID } },
    { geometryTypeDimensionTypeId: 1011, dimensionValue: 0.2, unitByUnitId: { id: MTR_ID } },
  ];
  const r = E.dimsFromPartNumber(nodes, GEO_DIMS);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.lengthM - 0.3) < 1e-10);
  assert.ok(Math.abs(r.widthM - 0.2) < 1e-10);
  assert.equal(r.heightM, null);
});

// ──────────────────────────────────────────────────────────────────
// areaFromDims
// ──────────────────────────────────────────────────────────────────
//
// Fórmula: largo_dm * ancho_dm = (lengthM * 10) * (widthM * 10)
// Verificación: 0.3m × 0.2m → 3dm × 2dm = 6 dm²

test('areaFromDims: 0.3m × 0.2m → 6 dm²', () => {
  assert.ok(Math.abs(E.areaFromDims(0.3, 0.2) - 6) < 1e-9, `got ${E.areaFromDims(0.3, 0.2)}`);
});

test('areaFromDims: valores golden del Calculo.xlsx (0.22m × 0.00635m)', () => {
  // 0.22m = 2.2dm; 0.00635m = 0.0635dm → 2.2 × 0.0635 = 0.1397 dm²
  const r = E.areaFromDims(0.22, 0.00635);
  assert.ok(Math.abs(r - 0.1397) < 1e-4, `got ${r}`);
});

test('areaFromDims: 1m × 1m → 100 dm²', () => {
  assert.ok(Math.abs(E.areaFromDims(1, 1) - 100) < 1e-9);
});

// ──────────────────────────────────────────────────────────────────
// buildAreaConversions
// ──────────────────────────────────────────────────────────────────
//
// conversions = { CMK_TO_FTK: 0.00107639, ... } (de config.domain.conversions)
// dmk  = areaDm2 (dm² == DMK directamente)
// cmk  = areaDm2 * 100 (1 dm² = 100 cm²)
// ftk  = cmk * CMK_TO_FTK

const CONVERSIONS = { CMK_TO_FTK: 0.00107639 };

test('buildAreaConversions: 1 dm² → dmk=1, cmk=100, ftk≈0.10764', () => {
  const r = E.buildAreaConversions(1, CONVERSIONS);
  assert.equal(r.dmk, 1);
  assert.equal(r.cmk, 100);
  assert.ok(Math.abs(r.ftk - 0.107639) < 1e-6, `ftk=${r.ftk}`);
});

test('buildAreaConversions: 6 dm² → dmk=6, cmk=600, ftk≈0.64583', () => {
  const r = E.buildAreaConversions(6, CONVERSIONS);
  assert.equal(r.dmk, 6);
  assert.equal(r.cmk, 600);
  assert.ok(Math.abs(r.ftk - 0.645834) < 1e-4, `ftk=${r.ftk}`);
});

test('buildAreaConversions: 0.1341 dm² (area real de pieza HB_P5778 aprox)', () => {
  const r = E.buildAreaConversions(0.1341, CONVERSIONS);
  assert.ok(Math.abs(r.dmk - 0.1341) < 1e-10);
  assert.ok(Math.abs(r.cmk - 13.41) < 1e-9);
  assert.ok(Math.abs(r.ftk - 0.01443) < 1e-4, `ftk=${r.ftk}`);
});

// ──────────────────────────────────────────────────────────────────
// dimsAreDifferent
// ──────────────────────────────────────────────────────────────────
//
// capturedDims y existingDims son objetos { lengthM, widthM } (heightM opcional).
// Diferencia > tolerancePct% en CUALQUIER dim → true.

test('dimsAreDifferent: iguales → false', () => {
  const a = { lengthM: 0.3, widthM: 0.2 };
  assert.equal(E.dimsAreDifferent(a, a), false);
  assert.equal(E.dimsAreDifferent({ lengthM: 0.3, widthM: 0.2 }, { lengthM: 0.3, widthM: 0.2 }), false);
});

test('dimsAreDifferent: difieren más del 1% → true', () => {
  const cap = { lengthM: 0.3, widthM: 0.2 };
  const ex  = { lengthM: 0.32, widthM: 0.2 };  // 6.67% de diferencia en length
  assert.equal(E.dimsAreDifferent(cap, ex), true);
});

test('dimsAreDifferent: difieren menos del 1% (ruido de conversión) → false', () => {
  const cap = { lengthM: 0.300, widthM: 0.200 };
  const ex  = { lengthM: 0.3001, widthM: 0.200 };  // 0.033% → dentro de 1%
  assert.equal(E.dimsAreDifferent(cap, ex), false);
});

test('dimsAreDifferent: tolerancia personalizada 5%', () => {
  const cap = { lengthM: 0.3, widthM: 0.2 };
  const ex  = { lengthM: 0.314, widthM: 0.2 };  // 4.67% → dentro del 5%
  assert.equal(E.dimsAreDifferent(cap, ex, 5), false);
  const ex2 = { lengthM: 0.32, widthM: 0.2 };   // 6.67% → fuera del 5%
  assert.equal(E.dimsAreDifferent(cap, ex2, 5), true);
});

test('dimsAreDifferent: existingDims null → false (no hay con qué comparar)', () => {
  assert.equal(E.dimsAreDifferent({ lengthM: 0.3, widthM: 0.2 }, null), false);
});

test('dimsAreDifferent: capturedDims null → false', () => {
  assert.equal(E.dimsAreDifferent(null, { lengthM: 0.3, widthM: 0.2 }), false);
});
