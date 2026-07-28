// tools/test/route-planner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRoutes } = require('../hash-autopilot/route-planner.mjs');
const { opsToCapture, staleMutations } = require('../hash-autopilot/route-planner.mjs');
const { maskedQueries, maskedMutations, mutationsToCapture } = require('../hash-autopilot/route-planner.mjs');

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

// ── masked-ops (session-sensitive unificadas) ──────────────────────────────
const MASKED = {
  queries: ['AllCustomers', 'Customer', 'CurrentUser', 'AllSensorDashboards', 'SensorDashboardQuery'],
  mutations: ['SaveManyPartNumberPrices'],
};

test('maskedQueries/maskedMutations: extraen, dedup y ordenan; defensivos ante undefined', () => {
  assert.deepEqual(maskedQueries(MASKED), ['AllCustomers', 'AllSensorDashboards', 'CurrentUser', 'Customer', 'SensorDashboardQuery']);
  assert.deepEqual(maskedMutations(MASKED), ['SaveManyPartNumberPrices']);
  assert.deepEqual(maskedQueries(undefined), []);
  assert.deepEqual(maskedMutations({}), []);
});

test('opsToCapture con masked-only: validatorResult vacío + maskedQueries → solo enmascaradas', () => {
  // El modo masked-only reusa opsToCapture pasando stale vacío → devuelve exactamente
  // las queries enmascaradas (ignora cualquier stale del validador).
  assert.deepEqual(opsToCapture({ stale: [] }, maskedQueries(MASKED)), maskedQueries(MASKED));
});

test('mutationsToCapture modo completo: enmascaradas UNIÓN stale del validador, dedup+orden', () => {
  const vr = { stale: [
    { kind: 'mutation', operation: 'UpdateReceivedOrder' },
    { kind: 'mutation', operation: 'SaveManyPartNumberPrices' }, // ya enmascarada → dedup
    { kind: 'query', operation: 'GetWorkOrder' },                 // query → no cuenta
  ] };
  assert.deepEqual(
    mutationsToCapture(vr, maskedMutations(MASKED)),
    ['SaveManyPartNumberPrices', 'UpdateReceivedOrder'],
  );
});

test('mutationsToCapture modo masked-only: NO captura mutations (solo queries cada tick)', () => {
  // Las mutations se ejecutan sobre el centinela (costo + riesgo residual) → NO en cada
  // tick horario; se recapturan en el escaneo completo (por release).
  const vr = { stale: [{ kind: 'mutation', operation: 'UpdateReceivedOrder' }] };
  assert.deepEqual(mutationsToCapture(vr, maskedMutations(MASKED), { maskedOnly: true }), []);
});

test('mutationsToCapture: sin enmascaradas ni stale → []', () => {
  assert.deepEqual(mutationsToCapture({ stale: [] }, []), []);
});
