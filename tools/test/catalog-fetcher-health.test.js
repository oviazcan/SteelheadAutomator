// tools/test/catalog-fetcher-health.test.js
// Guard de integridad del catalog-fetcher: cuando un persisted-query hash rota
// (p.ej. AllCustomers/Customer el 2026-07-03), la lista viene vacía y —sin este
// guard— la plantilla se generaría con 0 items, borrando las listas buenas al
// correr RefrescarListas. assessCatalogHealth decide block/warn/ok; buildHealthMessage
// arma el aviso al operador. Ambas son PURAS.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  _assessCatalogHealth: assess,
  _buildHealthMessage: buildMsg,
} = require('../../remote/scripts/catalog-fetcher.js');

// Catálogos "sanos" de referencia (todos los críticos con datos).
const healthy = () => ({
  customers: [{ display: 'ACME', id: '1' }],
  processes: ['Niquel'],
  products: ['Prod A'],
  specs: ['SPEC-X'],
  labels: [], users: [], groups: [], geometryTypes: [], catProcesos: [],
  racks: { all: [], linea: [] },
});

test('todo sano, sin issues → ok', () => {
  const h = assess(healthy(), []);
  assert.equal(h.level, 'ok');
  assert.deepEqual(h.empties, []);
  assert.equal(h.hashRotated.length, 0);
});

test('clientes vacíos por hash rotado → block (el caso 2026-07-03)', () => {
  const cat = { ...healthy(), customers: [] };
  const issues = [{ catalog: 'Clientes', op: 'AllCustomers', msg: 'HTTP 400 en AllCustomers: [1] Must provide a query string.', hashRotated: true }];
  const h = assess(cat, issues);
  assert.equal(h.level, 'block');
  assert.deepEqual(h.empties, ['Clientes']);
  assert.equal(h.hashRotated.length, 1);
  const msg = buildMsg(h);
  assert.match(msg, /descarga cancelada/);
  assert.match(msg, /HASH ROTADO/);
  assert.match(msg, /AllCustomers/);
  assert.match(msg, /Clientes/);
  assert.match(msg, /RefrescarListas/);   // explica el riesgo
});

test('cada catálogo crítico vacío se detecta como block', () => {
  for (const key of ['customers', 'processes', 'products', 'specs']) {
    const cat = { ...healthy(), [key]: [] };
    const h = assess(cat, []);
    assert.equal(h.level, 'block', `${key} vacío debe bloquear`);
    assert.equal(h.empties.length, 1);
  }
});

test('críticos con datos + hash rotado en catálogo secundario → warn (no block)', () => {
  const issues = [{ catalog: 'Tipos de Geometría', op: 'AllGeometryTypes', msg: 'Must provide a query string.', hashRotated: true }];
  const h = assess(healthy(), issues);
  assert.equal(h.level, 'warn');
  assert.deepEqual(h.empties, []);
  const msg = buildMsg(h);
  assert.match(msg, /¿Descargar de todos modos\?/);
  assert.match(msg, /AllGeometryTypes/);
});

test('error NO-hash (timeout) en secundario sin vaciar críticos → ok (no molesta)', () => {
  const issues = [{ catalog: 'Grupos', op: 'PNGroupSelect', msg: 'Request timeout (90000ms)', hashRotated: false }];
  const h = assess(healthy(), issues);
  assert.equal(h.level, 'ok');
  assert.equal(h.otherErrors.length, 1);
});

test('crítico vacío + error no-hash → block, y el mensaje lista ambos', () => {
  const cat = { ...healthy(), products: [] };
  const issues = [{ catalog: 'Productos', op: 'SearchProducts', msg: 'GraphQL errors (SearchProducts): boom', hashRotated: false }];
  const h = assess(cat, issues);
  assert.equal(h.level, 'block');
  const msg = buildMsg(h);
  assert.match(msg, /Productos/);
  assert.match(msg, /Otros errores/);
  assert.match(msg, /boom/);
});

test('catalogs undefined / arrays faltantes → block (fail-closed)', () => {
  const h = assess(undefined, []);
  assert.equal(h.level, 'block');
  // los 4 críticos ausentes cuentan como vacíos
  assert.equal(h.empties.length, 4);
});

test('issues no-array no revienta', () => {
  const h = assess(healthy(), null);
  assert.equal(h.level, 'ok');
});
