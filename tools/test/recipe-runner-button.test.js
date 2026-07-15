// tools/test/recipe-runner-button.test.js
// Matcher PURO del paso `clickButton` (bloqueador #2 del self-heal): el motor headless
// corre en INGLÉS, pero el patrón debe ser BILINGÜE ES+EN por si el operador lo ve en
// español. Sin Playwright — solo el matching de texto de botón.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buttonTextMatches } = require('../hash-autopilot/recipe-runner.mjs');

// Los patrones REALES del route-catalog (textos EN validados headless 2026-07-14).
const EDIT = 'edit sales order|editar orden de venta';
const ADD = 'add parts \\(table\\)|agregar piezas \\(tabla\\)';

test('buttonTextMatches: EN headless (MAYÚSCULAS por text-transform) matchea', () => {
  assert.ok(buttonTextMatches('EDIT SALES ORDER', EDIT), 'EDIT SALES ORDER → CreateEditReceivedOrderDialogQuery');
  assert.ok(buttonTextMatches('ADD PARTS (TABLE)', ADD), 'ADD PARTS (TABLE) → GetAddPartsReceivedOrder');
});

test('buttonTextMatches: ES matchea el MISMO patrón (bilingüe)', () => {
  assert.ok(buttonTextMatches('Editar Orden de Venta', EDIT));
  assert.ok(buttonTextMatches('Agregar Piezas (Tabla)', ADD));
});

test('buttonTextMatches: NO matchea botones ajenos del mismo detalle (precisión)', () => {
  assert.ok(!buttonTextMatches('EDIT', EDIT), '"EDIT" genérico NO debe disparar edit-sales-order');
  assert.ok(!buttonTextMatches('SALES ORDER', EDIT));
  assert.ok(!buttonTextMatches('ADD LINE', ADD));
  assert.ok(!buttonTextMatches('ADD PART TO SALES ORDER', ADD), 'distinto del botón de tabla');
  assert.ok(!buttonTextMatches('ADD RECEIVED PARTS', ADD));
});

test('buttonTextMatches: robusto a espacios colapsables y entradas vacías', () => {
  assert.ok(buttonTextMatches('  EDIT   SALES    ORDER ', EDIT));
  assert.ok(!buttonTextMatches('', EDIT));
  assert.ok(!buttonTextMatches('EDIT SALES ORDER', ''));
  assert.ok(!buttonTextMatches(null, EDIT));
});
