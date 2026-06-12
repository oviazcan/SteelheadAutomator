// tools/test/bulk-upload-dims.test.js
// Tests de resolveDimSelections — recomposición de dimensionCustomValueIds por eje
// (Línea / Departamento) con preserve-on-missing + default Producción.
//
// El dominio tiene 2 dimensiones: Línea (ids del set L) y Departamento (set D).
// SavePartNumber hace REPLACE en el array, así que el array final DEBE incluir cada
// eje resuelto. La regla de negocio del Departamento: "default si el PN no tiene; si
// ya tiene, respetar" (altas y edición). Caso clave que estos tests blindan: una fila
// v12 trae Línea pero NUNCA trae Departamento → no debe borrar el depto existente.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDimSelections } = require('../../remote/scripts/bulk-upload-parse.js');

const L = new Set([349001, 349002, 349003]); // ids de Línea
const D = new Set([586_182, 586_188, 586_200]); // ids de Departamento (182=Producción)
const PRODUCCION = 586_182;
const base = { lineaValueIdSet: L, deptoValueIdSet: D, deptoDefaultId: PRODUCCION };

const eq = (got, want, msg) => assert.deepEqual(got, want, msg);

test('alta sin línea ni depto → solo default Producción', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'none', deptoIntent: 'none', existingDimIds: [] }),
    [PRODUCCION]);
});

test('alta con línea, sin depto → línea + default Producción', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'value-ok', lineaId: 349002, deptoIntent: 'none', existingDimIds: [] }),
    [349002, PRODUCCION]);
});

test('v12 (línea en CSV, depto NO en CSV) sobre PN con depto existente → NO borra el depto', () => {
  // existing: línea 349001 + depto 586_188. CSV trae nueva línea 349003, sin depto.
  eq(resolveDimSelections({ ...base, lineaIntent: 'value-ok', lineaId: 349003, deptoIntent: 'none', existingDimIds: [349001, 586_188] }),
    [349003, 586_188]); // línea nueva, depto preservado (NO Producción, NO vacío)
});

test('edición sin nada en CSV → preserva línea + depto existentes', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'none', deptoIntent: 'none', existingDimIds: [349001, 586_188] }),
    [349001, 586_188]);
});

test('edición de PN sin depto, CSV con línea → aplica default Producción', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'value-ok', lineaId: 349002, deptoIntent: 'none', existingDimIds: [349001] }),
    [349002, PRODUCCION]);
});

test('depto explícito en CSV (value-ok) gana sobre default y existente', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'none', deptoIntent: 'value-ok', deptoId: 586_200, existingDimIds: [349001, 586_188] }),
    [349001, 586_200]);
});

test('dash en depto → borra depto (no default), preserva línea', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'none', deptoIntent: 'dash', existingDimIds: [349001, 586_188] }),
    [349001]);
});

test('dash en línea → borra línea, depto preservado', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'dash', deptoIntent: 'none', existingDimIds: [349001, 586_188] }),
    [586_188]);
});

test('applyDeptoDefault=false (prefetch falló, sin depto conocido) → NO inyecta default', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'value-ok', lineaId: 349002, deptoIntent: 'none', existingDimIds: [], applyDeptoDefault: false }),
    [349002]);
});

test('preserva dimensiones de otros tipos (no línea ni depto)', () => {
  const otra = 999999;
  eq(resolveDimSelections({ ...base, lineaIntent: 'none', deptoIntent: 'none', existingDimIds: [349001, 586_188, otra] }),
    [349001, 586_188, otra]);
});

test('value-missing (typo en línea) preserva la línea existente', () => {
  eq(resolveDimSelections({ ...base, lineaIntent: 'value-missing', deptoIntent: 'none', existingDimIds: [349001, 586_188] }),
    [349001, 586_188]);
});
