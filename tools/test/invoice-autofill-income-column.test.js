// tools/test/invoice-autofill-income-column.test.js
// Golden tests del reconocedor de la columna "cuenta de ingreso" en el editor de factura.
// Run: node --test tools/test/invoice-autofill-income-column.test.js
//
// REGRESIÓN 2026-08-03 (reporte del operador: "ni intenta encontrar la cuenta de income").
// Steelhead RENOMBRÓ la columna: era "Income Account", hoy es "Income/Liability Account"
// (medido en vivo sobre el editor real, dominio 344, PS #001550). El applet la buscaba con
// /^\s*income\s+account\s*$/i — match EXACTO — así que incomeIdx quedaba en -1, la línea se
// descartaba con `continue`, lines=[] y el panel ni siquiera pintaba la sección "Cuenta por
// línea". Falla SILENCIOSA: el panel se veía sano (cliente, divisa, TC y CXC en verde).
//
// El thead REAL capturado en vivo (11 columnas, la de ingreso es la última):
//   Include | Product | Línea | Departamento | Description | Quantity | Price |
//   Subtotal | Tax Code | Close SO Line | Income/Liability Account
// (`Línea` y `Departamento` también son nuevas — dimensiones contables.)
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/invoice-autofill.js');

// Encabezados REALES del editor, tal como los devolvió textContent.trim() en vivo.
const REAL_HEADERS = [
  'Include', 'Product', 'Línea', 'Departamento', 'Description', 'Quantity',
  'Price', 'Subtotal', 'Tax Code', 'Close SO Line', 'Income/Liability Account'
];
// Qué columnas traen react-select en la fila de datos (medido en vivo):
// Product(1), Línea(2), Departamento(3), Tax Code(8), Income(10).
const REAL_COMBOS = [false, true, true, true, false, false, false, false, true, false, true];

test('el applet exporta el núcleo puro de la columna de ingreso', () => {
  assert.equal(typeof Core.isIncomeAccountHeader, 'function');
  assert.equal(typeof Core.findIncomeAccountColumn, 'function');
});

test('isIncomeAccountHeader reconoce el nombre VIVO "Income/Liability Account"', () => {
  // El caso que rompió producción.
  assert.equal(Core.isIncomeAccountHeader('Income/Liability Account'), true);
});

test('isIncomeAccountHeader sigue reconociendo el nombre LEGADO "Income Account"', () => {
  // No se cambia un anclaje: se AMPLÍA. Si SH revierte el rename, el applet sigue vivo.
  assert.equal(Core.isIncomeAccountHeader('Income Account'), true);
  assert.equal(Core.isIncomeAccountHeader('  income   account  '), true);
  assert.equal(Core.isIncomeAccountHeader('INCOME ACCOUNT'), true);
});

test('isIncomeAccountHeader tolera variantes de la misma columna', () => {
  assert.equal(Core.isIncomeAccountHeader('Income'), true);
  assert.equal(Core.isIncomeAccountHeader('Income/Liability'), true);
  assert.equal(Core.isIncomeAccountHeader('Income / Liability Account'), true);
  assert.equal(Core.isIncomeAccountHeader('Liability/Income Account'), true);
  // Saltos de línea del render (el th puede envolver el texto en dos renglones).
  assert.equal(Core.isIncomeAccountHeader('Income/Liability\nAccount'), true);
});

test('isIncomeAccountHeader reconoce el nombre en ESPAÑOL (la tabla ya viene mezclada)', () => {
  // El mismo thead trae "Línea"/"Departamento" en español: el locale de esa pantalla
  // es mixto, así que el ES no es hipotético. Se exige "cuenta"+"ingreso" (o "pasivo")
  // para no confundir un eventual "Fecha de Ingreso".
  assert.equal(Core.isIncomeAccountHeader('Cuenta de Ingresos'), true);
  assert.equal(Core.isIncomeAccountHeader('Cuenta de Ingreso/Pasivo'), true);
  assert.equal(Core.isIncomeAccountHeader('Cuenta de ingresos/pasivos'), true);
  // Sin acento (por si el render lo pierde) sigue matcheando.
  assert.equal(Core.isIncomeAccountHeader('Cuenta de Ingreso'), true);
});

test('isIncomeAccountHeader NO matchea las otras columnas del thead real', () => {
  for (const h of REAL_HEADERS.slice(0, 10)) {
    assert.equal(Core.isIncomeAccountHeader(h), false, `no debe matchear "${h}"`);
  }
});

test('isIncomeAccountHeader NO matchea columnas parecidas de otras tablas', () => {
  // "Cuenta" sola no basta: la cuenta CXC vive en otro control.
  assert.equal(Core.isIncomeAccountHeader('Cuenta'), false);
  assert.equal(Core.isIncomeAccountHeader('Account'), false);
  assert.equal(Core.isIncomeAccountHeader('AR Account'), false);
  assert.equal(Core.isIncomeAccountHeader('Cuenta CXC'), false);
  assert.equal(Core.isIncomeAccountHeader('Fecha de Ingreso'), false); // ingreso sin cuenta
  assert.equal(Core.isIncomeAccountHeader(''), false);
  assert.equal(Core.isIncomeAccountHeader(null), false);
  assert.equal(Core.isIncomeAccountHeader(undefined), false);
});

test('findIncomeAccountColumn da el índice 10 sobre el thead REAL, por texto', () => {
  const got = Core.findIncomeAccountColumn(REAL_HEADERS, REAL_COMBOS);
  assert.deepEqual(got, { index: 10, by: 'text' });
});

test('findIncomeAccountColumn sobre el layout LEGADO (sin Línea/Departamento)', () => {
  const legacy = ['Include', 'Product', 'Description', 'Quantity', 'Price',
    'Subtotal', 'Tax Code', 'Close SO Line', 'Income Account'];
  const combos = [false, true, false, false, false, false, true, false, true];
  assert.deepEqual(Core.findIncomeAccountColumn(legacy, combos), { index: 8, by: 'text' });
});

test('findIncomeAccountColumn cae a la ÚLTIMA columna si el texto ya no se reconoce', () => {
  // Red de seguridad para el PRÓXIMO rename: en los dos layouts observados la cuenta de
  // ingreso es la última columna Y trae react-select. El fallback exige AMBAS cosas.
  const renamed = ['Include', 'Product', 'Description', 'Quantity', 'GL Posting Target'];
  const combos = [false, true, false, false, true];
  assert.deepEqual(Core.findIncomeAccountColumn(renamed, combos), { index: 4, by: 'last-column' });
});

test('findIncomeAccountColumn NO adivina si la última columna no tiene combobox', () => {
  // Escribir la cuenta contable en la columna equivocada es peor que no escribirla:
  // sin evidencia POSITIVA de que ahí va un select, se rinde.
  const renamed = ['Include', 'Product', 'GL Target', 'Notes'];
  const combos = [false, true, true, false];
  assert.deepEqual(Core.findIncomeAccountColumn(renamed, combos), { index: -1, by: null });
});

test('findIncomeAccountColumn: el texto GANA sobre la posición', () => {
  // Si SH agrega una columna DESPUÉS de la de ingreso, el fallback apuntaría mal;
  // por eso el match por texto se intenta primero y el fallback sólo cubre su ausencia.
  const headers = ['Include', 'Income/Liability Account', 'Comentarios'];
  const combos = [false, true, true];
  assert.deepEqual(Core.findIncomeAccountColumn(headers, combos), { index: 1, by: 'text' });
});

test('findIncomeAccountColumn tolera entradas degeneradas sin reventar', () => {
  assert.deepEqual(Core.findIncomeAccountColumn([], []), { index: -1, by: null });
  assert.deepEqual(Core.findIncomeAccountColumn(null, null), { index: -1, by: null });
  // combos de largo distinto al de headers → no se usa el fallback (no se sabe alinear).
  assert.deepEqual(
    Core.findIncomeAccountColumn(['A', 'B', 'C'], [true]),
    { index: -1, by: null }
  );
});
