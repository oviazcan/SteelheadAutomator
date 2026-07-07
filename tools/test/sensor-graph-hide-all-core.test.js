// Golden tests del módulo puro sensor-graph-hide-all-core.js
// Run: node --test tools/test/sensor-graph-hide-all-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// El core se publica como IIFE sobre window; para test en node lo cargamos con un shim.
global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'sensor-graph-hide-all-core.js'));
const Core = global.window.SensorGraphHideAllCore;

// ── parseDashboardId / isDashboardPath ──────────────────────────────────────
test('parseDashboardId: extrae idInDomain del path real CamelCase', () => {
  assert.strictEqual(Core.parseDashboardId('/Domains/344/Maintenance/SensorDashboards/117'), '117');
  assert.strictEqual(Core.parseDashboardId('/Domains/344/Maintenance/SensorDashboards/119'), '119');
});

test('parseDashboardId: acepta trailing slash y query string', () => {
  assert.strictEqual(Core.parseDashboardId('/Domains/344/Maintenance/SensorDashboards/117/'), '117');
  assert.strictEqual(Core.parseDashboardId('/Domains/344/Maintenance/SensorDashboards/117?type=BOOLEAN'), '117');
});

test('parseDashboardId: acepta slug con guión (por si rota)', () => {
  assert.strictEqual(Core.parseDashboardId('/domains/1/maintenance/sensor-dashboards/42'), '42');
});

test('parseDashboardId: null fuera de un dashboard', () => {
  assert.strictEqual(Core.parseDashboardId('/Domains/344/Maintenance/SensorDashboards'), null);
  assert.strictEqual(Core.parseDashboardId('/Domains/344/Workboards/9'), null);
  assert.strictEqual(Core.parseDashboardId('/'), null);
  assert.strictEqual(Core.parseDashboardId(null), null);
});

test('isDashboardPath: bool', () => {
  assert.strictEqual(Core.isDashboardPath('/Domains/344/Maintenance/SensorDashboards/117'), true);
  assert.strictEqual(Core.isDashboardPath('/Domains/344/Invoices/5'), false);
});

// ── nextHideStep: máquina de decisión ───────────────────────────────────────
const base = { onDashboard: true, enabled: true, sameEntry: false, toggleCount: 14, visibleCount: 14, attempts: 0, maxAttempts: 8 };

test('nextHideStep: idle fuera de dashboard', () => {
  assert.strictEqual(Core.nextHideStep({ ...base, onDashboard: false }), 'idle');
});

test('nextHideStep: idle si está desactivado', () => {
  assert.strictEqual(Core.nextHideStep({ ...base, enabled: false }), 'idle');
});

test('nextHideStep: done si la entrada ya fue latcheada (no re-esconde)', () => {
  // clave: aunque el operador haya destachado uno (visibleCount>0), NO lo re-esconde.
  assert.strictEqual(Core.nextHideStep({ ...base, sameEntry: true, visibleCount: 1 }), 'done');
});

test('nextHideStep: wait si la tabla aún no renderiza (0 toggles)', () => {
  assert.strictEqual(Core.nextHideStep({ ...base, toggleCount: 0, visibleCount: 0 }), 'wait');
});

test('nextHideStep: hide si hay visibles y quedan intentos', () => {
  assert.strictEqual(Core.nextHideStep({ ...base, visibleCount: 14, attempts: 0 }), 'hide');
  assert.strictEqual(Core.nextHideStep({ ...base, visibleCount: 3, attempts: 7 }), 'hide');
});

test('nextHideStep: latch cuando ya no quedan visibles (todos ocultos)', () => {
  assert.strictEqual(Core.nextHideStep({ ...base, visibleCount: 0, toggleCount: 14 }), 'latch');
});

test('nextHideStep: latch (da por vencido) si se agotan los intentos con visibles atorados', () => {
  assert.strictEqual(Core.nextHideStep({ ...base, visibleCount: 2, attempts: 8, maxAttempts: 8 }), 'latch');
});
