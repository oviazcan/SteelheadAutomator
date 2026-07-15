// tools/test/route-planner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRoutes } = require('../hash-autopilot/route-planner.mjs');
const { opsToCapture, staleMutations } = require('../hash-autopilot/route-planner.mjs');

const CATALOG = {
  routes: {
    'customers-list':   { module: 'Customers', steps: [{ goto: '/c' }], captures: ['AllCustomers', 'CustomerTags'] },
    'customer-detail':  { module: 'Customers', steps: [{ goto: '/c/1' }], captures: ['Customer'] },
    'app-home':         { module: 'Home',      steps: [{ goto: '/' }],  captures: ['CurrentUser'] },
  },
};

test('selectRoutes: una ruta que cubre 2 ops rotadas se elige una sola vez', () => {
  const r = selectRoutes(['AllCustomers', 'CustomerTags'], CATALOG);
  assert.deepEqual(r.routes.map((x) => x.id), ['customers-list']);
  assert.deepEqual(r.uncovered, []);
});

test('selectRoutes: elige el mínimo de rutas (set-cover) y ordena por cobertura', () => {
  const r = selectRoutes(['AllCustomers', 'Customer', 'CurrentUser'], CATALOG);
  // customers-list cubre 1 (AllCustomers), pero también CustomerTags no está pedido.
  // Se necesitan 3 rutas: customers-list, customer-detail, app-home.
  assert.deepEqual(r.routes.map((x) => x.id).sort(), ['app-home', 'customer-detail', 'customers-list']);
  assert.deepEqual(r.uncovered, []);
});

test('selectRoutes: op sin ruta en el catálogo → uncovered', () => {
  const r = selectRoutes(['AllCustomers', 'GetPurchaseOrder'], CATALOG);
  assert.deepEqual(r.routes.map((x) => x.id), ['customers-list']);
  assert.deepEqual(r.uncovered, ['GetPurchaseOrder']);
});

test('selectRoutes: rotatedOps vacío → sin rutas, sin uncovered', () => {
  const r = selectRoutes([], CATALOG);
  assert.deepEqual(r.routes, []);
  assert.deepEqual(r.uncovered, []);
});

test('selectRoutes: desempate determinista por id alfabético', () => {
  // dos rutas cubren exactamente la misma op → gana la de id menor.
  const cat = { routes: {
    'zeta': { steps: [], captures: ['X'] },
    'alpha': { steps: [], captures: ['X'] },
  } };
  const r = selectRoutes(['X'], cat);
  assert.deepEqual(r.routes.map((x) => x.id), ['alpha']);
});

const SESSION_SENSITIVE = ['AllCustomers', 'Customer', 'CurrentUser', 'GetPurchaseOrder', 'AllSensorDashboards', 'SensorDashboardQuery'];

test('opsToCapture: une stale-queries con session-sensitive, dedup y ordena', () => {
  const vr = { stale: [
    { kind: 'query', operation: 'GetWorkOrder' },
    { kind: 'query', operation: 'AllCustomers' },      // ya en session-sensitive → dedup
    { kind: 'mutation', operation: 'SaveQuoteLines' }, // mutation → excluida de captura
  ] };
  assert.deepEqual(
    opsToCapture(vr, SESSION_SENSITIVE),
    ['AllCustomers', 'AllSensorDashboards', 'CurrentUser', 'Customer', 'GetPurchaseOrder', 'GetWorkOrder', 'SensorDashboardQuery'],
  );
});

test('opsToCapture: sin stale → solo session-sensitive (siempre por release)', () => {
  assert.deepEqual(opsToCapture({ stale: [] }, SESSION_SENSITIVE), [...SESSION_SENSITIVE].sort());
});

test('opsToCapture: validatorResult sin campo stale → solo session-sensitive', () => {
  assert.deepEqual(opsToCapture({}, SESSION_SENSITIVE), [...SESSION_SENSITIVE].sort());
});

test('staleMutations: devuelve solo las mutations stale, ordenadas', () => {
  const vr = { stale: [
    { kind: 'mutation', operation: 'SaveQuoteLines' },
    { kind: 'query', operation: 'GetWorkOrder' },
    { kind: 'mutation', operation: 'ArchivePart' },
  ] };
  assert.deepEqual(staleMutations(vr), ['ArchivePart', 'SaveQuoteLines']);
});
