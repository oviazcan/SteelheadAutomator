// tools/test/probe-classify.test.js
// Núcleo PURO del probe directo de hashes. Fixtures = mensajes REALES observados
// contra app.gosteelhead.com/graphql el 2026-07-10 (dominio 344/TLC).
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProbe, summarizeProbes, buildProbeBody, gateByProbe, isProbeSessionDegraded } = require('../hash-autopilot/probe-classify.mjs');

test('STALE: "Must provide a query string." (SearchUnits real, hash muerto)', () => {
  assert.equal(classifyProbe({ http: 400, message: 'Must provide a query string.' }), 'stale');
});

test('STALE: PersistedQueryNotFound', () => {
  assert.equal(classifyProbe({ http: 200, message: 'PersistedQueryNotFound' }), 'stale');
});

test('VIGENTE: falta variable requerida (AllCustomers real, hash vivo)', () => {
  assert.equal(classifyProbe({ http: 400, message: 'Variable "$includeArchived" of required type "IncludeArchivedOption!" was not provided.' }), 'vigente');
});

test('VIGENTE: falta $idInDomain (Customer/GetPO/SensorDashboard reales, hash vivo)', () => {
  assert.equal(classifyProbe({ http: 400, message: 'Variable "$idInDomain" of required type "Int!" was not provided.' }), 'vigente');
});

test('VIGENTE: la respuesta trajo data (aunque no haya message)', () => {
  assert.equal(classifyProbe({ http: 200, message: null, hasData: true }), 'vigente');
});

test('VIGENTE: got invalid value (validación de variable) → hash existe', () => {
  assert.equal(classifyProbe({ http: 400, message: "Variable \"$x\" got invalid value null" }), 'vigente');
});

test('AUTH: 401 sin message', () => {
  assert.equal(classifyProbe({ http: 401, message: null }), 'auth');
});

test('AUTH: mensaje de no autenticado', () => {
  assert.equal(classifyProbe({ http: 200, message: 'Not authenticated' }), 'auth');
});

test('UNKNOWN: mensaje raro no concluyente', () => {
  assert.equal(classifyProbe({ http: 500, message: 'Internal server error' }), 'unknown');
});

test('UNKNOWN: sin nada', () => {
  assert.equal(classifyProbe({}), 'unknown');
});

test('STALE gana sobre hasData (defensivo: no debería co-ocurrir)', () => {
  assert.equal(classifyProbe({ http: 400, message: 'Must provide a query string.', hasData: true }), 'stale');
});

test('summarizeProbes agrupa y ordena por veredicto', () => {
  const r = summarizeProbes([
    { op: 'SearchUnits', verdict: 'stale' },
    { op: 'Customer', verdict: 'vigente' },
    { op: 'AllCustomers', verdict: 'vigente' },
  ]);
  assert.deepEqual(r.stale, ['SearchUnits']);
  assert.deepEqual(r.vigente, ['AllCustomers', 'Customer']);
  assert.deepEqual(r.auth, []);
  assert.deepEqual(r.unknown, []);
});

test('gateByProbe: stale→escala, vigente→suprime, sin-probe→escala (fail-safe)', () => {
  const g = gateByProbe(['SearchUnits', 'AllCustomers', 'Customer', 'Xotra'], {
    SearchUnits: 'stale', AllCustomers: 'vigente', Customer: 'vigente', // Xotra sin verdict
  });
  assert.deepEqual(g.realStale, ['SearchUnits']);
  assert.deepEqual(g.falseAlarms, ['AllCustomers', 'Customer']);
  assert.deepEqual(g.unconfirmed, ['Xotra']);
});

test('gateByProbe: probe vacío (falló) → todo unconfirmed (fail-open, no suprime)', () => {
  const g = gateByProbe(['A', 'B'], {});
  assert.deepEqual(g.unconfirmed, ['A', 'B']);
  assert.deepEqual(g.realStale, []);
  assert.deepEqual(g.falseAlarms, []);
});

test('gateByProbe: auth/unknown NO se suprimen (se escalan por si acaso)', () => {
  const g = gateByProbe(['A', 'B'], { A: 'auth', B: 'unknown' });
  assert.deepEqual(g.unconfirmed, ['A', 'B']);
  assert.deepEqual(g.falseAlarms, []);
});

test('gateByProbe: lista vacía → todo vacío', () => {
  const g = gateByProbe([], { A: 'stale' });
  assert.deepEqual(g, { realStale: [], falseAlarms: [], unconfirmed: [] });
});

// ── isProbeSessionDegraded — el guard anti-falsa-alarma del Nivel B ────────────
// Caso REAL reproducido: corrida de las 17:23 del 2026-07-31. Las 5 enmascaradas
// probadas dieron auth/unknown (0 vigentes) porque el DNS de la Mac se cayó a media
// corrida; las 2 ÚLTIMAS rutas en orden de ejecución no capturaron y escalaron. Al
// día siguiente ambas capturaron al PRIMER intento con hash == config.

test('degradada: TODAS las probadas auth/unknown → true (la corrida no tiene datos)', () => {
  assert.equal(isProbeSessionDegraded({
    AllCustomers: 'auth', AllSensorDashboards: 'unknown', CurrentUser: 'auth',
    Customer: 'unknown', SensorDashboardQuery: 'unknown',
  }), true);
});

test('degradada: UN solo vigente ya prueba que la sesión responde → false', () => {
  assert.equal(isProbeSessionDegraded({ A: 'auth', B: 'unknown', C: 'vigente' }), false);
});

test('degradada: un stale exige que el server haya contestado → false (no suprime rotaciones)', () => {
  assert.equal(isProbeSessionDegraded({ A: 'auth', B: 'unknown', C: 'stale' }), false);
});

test('degradada: día sano (5/5 vigente) → false', () => {
  assert.equal(isProbeSessionDegraded({ A: 'vigente', B: 'vigente', C: 'vigente' }), false);
});

test('degradada: probe vacío o muy chico → false (fail-open, una muestra no es señal)', () => {
  assert.equal(isProbeSessionDegraded({}), false);
  assert.equal(isProbeSessionDegraded({ A: 'auth' }), false);
  assert.equal(isProbeSessionDegraded({ A: 'auth', B: 'unknown' }), false);
  assert.equal(isProbeSessionDegraded(null), false);
});

test('degradada: minProbed configurable', () => {
  assert.equal(isProbeSessionDegraded({ A: 'auth', B: 'unknown' }, { minProbed: 2 }), true);
});

test('degradada + gateByProbe: se suprime unconfirmed pero NUNCA realStale', () => {
  const verdicts = { A: 'auth', B: 'unknown', C: 'unknown' };
  const g = gateByProbe(['A', 'B', 'C'], verdicts);
  assert.deepEqual(g.unconfirmed, ['A', 'B', 'C']);   // el gate no cambia…
  assert.equal(isProbeSessionDegraded(verdicts), true); // …el guard decide si escalan
});

test('buildProbeBody arma el APQ con hash del config + vars vacías', () => {
  assert.deepEqual(buildProbeBody('SearchUnits', 'abc123'), {
    operationName: 'SearchUnits', variables: {},
    extensions: { persistedQuery: { version: 1, sha256Hash: 'abc123' } },
  });
});
