// tools/test/recipe-runner-button.test.js
// Matcher PURO del paso `clickButton` (bloqueador #2 del self-heal): el motor headless
// corre en INGLÉS, pero el patrón debe ser BILINGÜE ES+EN por si el operador lo ve en
// español. Sin Playwright — solo el matching de texto de botón.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buttonTextMatches, shouldAbortAndCapture } = require('../hash-autopilot/recipe-runner.mjs');

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

// ── captura-y-aborta (sentinela de precios: capturar el hash de una MUTATION de
//    escritura sin ejecutarla → cero persistencia) ──────────────────────────────
const priceReq = { operationName: 'SaveManyPartNumberPrices', extensions: { persistedQuery: { version: 1, sha256Hash: 'abc123' } } };

test('shouldAbortAndCapture: op en abortOps → abort + captura su hash', () => {
  const r = shouldAbortAndCapture(priceReq, new Set(['SaveManyPartNumberPrices']));
  assert.equal(r.abort, true);
  assert.deepEqual(r.captures, { SaveManyPartNumberPrices: 'abc123' });
});

test('shouldAbortAndCapture: op NO en abortOps → no aborta (deja pasar normal)', () => {
  const r = shouldAbortAndCapture(priceReq, new Set(['OtraMutation']));
  assert.equal(r.abort, false);
  assert.deepEqual(r.captures, {});
});

test('shouldAbortAndCapture: abortOps vacío/undefined → nunca aborta (fail-safe)', () => {
  assert.equal(shouldAbortAndCapture(priceReq, new Set()).abort, false);
  assert.equal(shouldAbortAndCapture(priceReq, undefined).abort, false);
});

test('shouldAbortAndCapture: batch (array) — aborta si alguna op del batch está marcada', () => {
  const batch = [{ operationName: 'GetX', extensions: {} }, priceReq];
  const r = shouldAbortAndCapture(batch, new Set(['SaveManyPartNumberPrices']));
  assert.equal(r.abort, true);
  assert.equal(r.captures.SaveManyPartNumberPrices, 'abc123');
});

test('shouldAbortAndCapture: op marcada pero sin hash (persistedQuery ausente) → aborta igual, sin captura', () => {
  // Defensa: aunque falte el hash, si es una op de escritura marcada NO debe llegar al server.
  const r = shouldAbortAndCapture({ operationName: 'SaveManyPartNumberPrices' }, new Set(['SaveManyPartNumberPrices']));
  assert.equal(r.abort, true);
  assert.deepEqual(r.captures, {});
});
