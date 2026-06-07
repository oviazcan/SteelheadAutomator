// Golden tests de bulk-upload-parse.js — congelan los invariantes nucleares
// blank/dash/data ANTES de refactorizar el pipeline. Correr: node --test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../remote/scripts/bulk-upload-parse.js');

test('isDash', () => {
  assert.strictEqual(P.isDash('-'), true);
  assert.strictEqual(P.isDash(''), false);
  assert.strictEqual(P.isDash('x'), false);
  assert.strictEqual(P.isDash('--'), false);
});

test('resolveStr: vacío preserva, dash borra, dato sobrescribe (invariante #1)', () => {
  assert.strictEqual(P.resolveStr('', 'viejo'), 'viejo');        // vacío -> no tocar
  assert.strictEqual(P.resolveStr(undefined, 'viejo'), 'viejo'); // undefined -> no tocar
  assert.strictEqual(P.resolveStr('-', 'viejo'), '');            // dash -> borrar
  assert.strictEqual(P.resolveStr('nuevo', 'viejo'), 'nuevo');   // dato -> sobrescribir
  assert.strictEqual(P.resolveStr('nuevo', undefined), 'nuevo'); // dato sin existente
});

test('resolveNum: null/undefined preserva, dash borra, número sobrescribe (invariante #1)', () => {
  assert.strictEqual(P.resolveNum(null, 5), 5);
  assert.strictEqual(P.resolveNum(undefined, 5), 5);
  assert.strictEqual(P.resolveNum('-', 5), null);   // dash string -> borrar
  assert.strictEqual(P.resolveNum(7, 5), 7);        // número -> sobrescribir
  assert.strictEqual(P.resolveNum(0, 5), 0);        // cero es dato válido, no preserva
});

test('cell: trim, colapsa espacios internos, (seleccione) -> vacío', () => {
  assert.strictEqual(P.cell(['  a   b  '], 0), 'a b');
  assert.strictEqual(P.cell(['(seleccione)'], 0), '');
  assert.strictEqual(P.cell(['(seleccione o escriba)'], 0), '');
  assert.strictEqual(P.cell([], 0), '');
  assert.strictEqual(P.cell([undefined], 0), '');
  assert.strictEqual(P.cell(['  -  '], 0), '-'); // dash sobrevive al trim (lo resuelve resolveStr)
});

test('cellNum: parseFloat de cell, NaN -> null', () => {
  assert.strictEqual(P.cellNum(['  12.5 '], 0), 12.5);
  assert.strictEqual(P.cellNum(['abc'], 0), null);
  assert.strictEqual(P.cellNum(['(seleccione)'], 0), null);
  assert.strictEqual(P.cellNum([''], 0), null);
});

test('toBool: variantes ES verdaderas y falsas', () => {
  for (const t of ['SI', 'Sí', 'sí', 'yes', '1', 'true', 'TRUE', 'V', 'verdadero']) {
    assert.strictEqual(P.toBool(t), true, `"${t}" debe ser true`);
  }
  for (const f of ['', 'no', '0', 'false', 'x', undefined, null]) {
    assert.strictEqual(P.toBool(f), false, `"${f}" debe ser false`);
  }
});

test('parseCSV: comillas, comas embebidas, comillas escapadas, CRLF', () => {
  const rows = P.parseCSV('a,b\r\n"x,y","z""q"\n');
  assert.deepStrictEqual(rows[0], ['a', 'b']);
  assert.deepStrictEqual(rows[1], ['x,y', 'z"q']);
});

test('parseCSV: celdas vacías y líneas preservadas', () => {
  const rows = P.parseCSV('a,,c\n,b,\n');
  assert.deepStrictEqual(rows[0], ['a', '', 'c']);
  assert.deepStrictEqual(rows[1], ['', 'b', '']);
});

test('buildDimensions: solo emite las dims presentes; usa MTR e ids del DOMAIN', () => {
  const DOMAIN = {
    geometryDimensions: { LENGTH: 1, WIDTH: 2, HEIGHT: 3, OUTER_DIAM: 4, INNER_DIAM: 5 },
    unitIds: { MTR: 99 },
  };
  const out = P.buildDimensions({ length: 10, width: null, height: 30 }, DOMAIN);
  assert.strictEqual(out.length, 2); // width null se omite
  assert.deepStrictEqual(out[0], { geometryTypeDimensionTypeId: 1, unitId: 99, dimensionValue: 10 });
  assert.deepStrictEqual(out[1], { geometryTypeDimensionTypeId: 3, unitId: 99, dimensionValue: 30 });
  assert.deepStrictEqual(P.buildDimensions({}, DOMAIN), []);
});

test('constantes de dominio intactas', () => {
  assert.strictEqual(P.PRICE_UNIT_MAP.KGM, 3969);
  assert.strictEqual(P.PRICE_UNIT_MAP.PZA, null);
  assert.strictEqual(P.PREDICTIVE_MATERIALS.length, 9);
  assert.strictEqual(P.PREDICTIVE_MATERIALS[0].inventoryItemId, 364506);
  assert.strictEqual(P.HEADER_KEYS['notas externas'], 'notasExternas');
  assert.strictEqual(P.HEADER_KEYS['válida hasta (días)'], 'validaDias');
});

// ─── F5: detección de intención de la corrida ───
const emptyPart = () => ({ precio: null, labels: [], specs: [], racks: [], dims: {}, unitConv: {}, predictiveUsage: [], products: [], metalBase: '', pnAlterno: '', codigoSAT: '', procesoOverride: '', validacion1er: null });

test('partHasEnrich: detecta cualquier columna de enriquecimiento (dato O dash)', () => {
  assert.strictEqual(P.partHasEnrich(emptyPart()), false);
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), labels: ['Estaño'] }), true);
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), labels: ['-'] }), true); // dash = intención (borrar)
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), dims: { length: 10 } }), true);
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), unitConv: { kgm: 0.5 } }), true);
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), metalBase: 'Cobre' }), true);
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), procesoOverride: 'T301' }), true);
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), validacion1er: false }), true);  // desactivar = intención
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), validacion1er: null }), false);  // no especificado
  assert.strictEqual(P.partHasEnrich({ ...emptyPart(), specs: [{ name: 'X' }] }), true);
});

test('classifyRunIntent: SOLO_PRECIO requiere precio + sin enrich + todos existentes', () => {
  const soloPrecio = [{ ...emptyPart(), precio: 13.8 }, { ...emptyPart(), precio: 9.5 }];
  assert.strictEqual(P.classifyRunIntent(soloPrecio, true), 'SOLO_PRECIO');
  assert.strictEqual(P.classifyRunIntent(soloPrecio, false), 'ALTA'); // hay PN nuevos → no fast-path (precio sin enrich, no existentes)
});

test('classifyRunIntent: AJUSTE_LINEA = enrich sin precio', () => {
  const ajuste = [{ ...emptyPart(), labels: ['Estaño'] }];
  assert.strictEqual(P.classifyRunIntent(ajuste, true), 'AJUSTE_LINEA');
});

test('classifyRunIntent: ENRIQUECIMIENTO = enrich con precio', () => {
  const enriq = [{ ...emptyPart(), precio: 5, labels: ['Estaño'] }];
  assert.strictEqual(P.classifyRunIntent(enriq, true), 'ENRIQUECIMIENTO');
});

test('classifyRunIntent: ALTA = ni precio ni enrich', () => {
  assert.strictEqual(P.classifyRunIntent([emptyPart()], false), 'ALTA');
});

test('classifyRunIntent: una sola fila con enrich basta para NO ser SOLO_PRECIO', () => {
  const mixed = [{ ...emptyPart(), precio: 5 }, { ...emptyPart(), precio: 6, dims: { length: 3 } }];
  assert.strictEqual(P.classifyRunIntent(mixed, true), 'ENRIQUECIMIENTO');
});
