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

// ── Fase 2: combo ───────────────────────────────────────────────────────────
test('normalizeName: colapsa espacios de más y baja a minúsculas', () => {
  assert.strictEqual(Core.normalizeName(' T203-TI00-011 Concentración  de Plata Metálica'), 't203-ti00-011 concentración de plata metálica');
  assert.strictEqual(Core.normalizeName(null), '');
  assert.strictEqual(Core.normalizeName('  A  B  '), 'a b');
});

test('filterNumericSensors: solo NUMBER, excluye BOOLEAN/TEXT', () => {
  const sensors = [
    { name: 'a', measurementType: 'NUMBER' },
    { name: 'b', measurementType: 'BOOLEAN' },
    { name: 'c', measurementType: 'NUMBER' },
    { name: 'd', measurementType: 'TEXT' },
  ];
  assert.deepStrictEqual(Core.filterNumericSensors(sensors).map(s => s.name), ['a', 'c']);
  assert.deepStrictEqual(Core.filterNumericSensors(null), []);
});

test('sensorLabel: prefiere la estación, fallback al nombre', () => {
  assert.strictEqual(Core.sensorLabel({ name: 'T203-TI00-011 Concentración', station: 'T203-TI00-011 Plata Silvrex (B-1)' }), 'T203-TI00-011 Plata Silvrex (B-1)');
  assert.strictEqual(Core.sensorLabel({ name: 'Solo Nombre', station: '' }), 'Solo Nombre');
  assert.strictEqual(Core.sensorLabel({ name: '', station: null }), '(sensor)');
});

test('deriveComboValue: NONE / ALL / un sensor / mezcla', () => {
  const all = ['s1', 's2', 's3'];
  const num = ['s1', 's2', 's3'];
  assert.strictEqual(Core.deriveComboValue({ visibleNames: [], allNames: all, numericNames: num }), 'NONE');
  assert.strictEqual(Core.deriveComboValue({ visibleNames: ['s1', 's2', 's3'], allNames: all, numericNames: num }), 'ALL');
  assert.strictEqual(Core.deriveComboValue({ visibleNames: ['s2'], allNames: all, numericNames: num }), 's2');
  assert.strictEqual(Core.deriveComboValue({ visibleNames: ['s1', 's2'], allNames: all, numericNames: num }), '');
  // 1 visible pero NO numérico (boolean) → placeholder, no lo ofrece el combo
  assert.strictEqual(Core.deriveComboValue({ visibleNames: ['b1'], allNames: all.concat('b1'), numericNames: num }), '');
  assert.strictEqual(Core.deriveComboValue({ visibleNames: [], allNames: [], numericNames: [] }), '');
});

test('planIsolation: ALL / NONE / aislar uno', () => {
  const all = ['s1', 's2', 's3'];
  assert.deepStrictEqual(Core.planIsolation('ALL', all), { show: ['s1', 's2', 's3'], hide: [] });
  assert.deepStrictEqual(Core.planIsolation('NONE', all), { show: [], hide: ['s1', 's2', 's3'] });
  assert.deepStrictEqual(Core.planIsolation('s2', all), { show: ['s2'], hide: ['s1', 's3'] });
  assert.deepStrictEqual(Core.planIsolation('', all), { show: [], hide: ['s1', 's2', 's3'] });
});

// Fixture con la forma REAL de SensorDashboardQuery (confirmada en scan 2026-07-07),
// mezclando NUMBER y BOOLEAN para verificar parse + filtro end-to-end.
const SDQ_RESPONSE = {
  data: {
    sensorDashboardByIdInDomain: {
      name: 'Concentración de Plata',
      sensorDashboardMembersBySensorDashboardId: {
        nodes: [
          { sensorBySensorId: { name: ' T203-TI00-011 Concentración de Plata Metálica',
            sensorTypeBySensorTypeId: { sensorMeasurementType: 'NUMBER' },
            stationByStationId: { name: 'T203-TI00-011 Plata Silvrex (B-1)' } } },
          { sensorBySensorId: { name: 'T204-TI00-017 Concentración de Plata Metálica',
            sensorTypeBySensorTypeId: { sensorMeasurementType: 'NUMBER' },
            stationByStationId: { name: 'T204-TI00-017 Plata Silversene (S-1) Flash' } } },
          { sensorBySensorId: { name: 'EPP-01 Guantes puestos',
            sensorTypeBySensorTypeId: { sensorMeasurementType: 'BOOLEAN' },
            stationByStationId: { name: 'T203-TI00-011 Plata Silvrex (B-1)' } } },
        ],
      },
    },
  },
};

test('parseSensorDashboard: extrae name/station/type de la forma real', () => {
  const list = Core.parseSensorDashboard(SDQ_RESPONSE);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list[0], {
    name: ' T203-TI00-011 Concentración de Plata Metálica',
    station: 'T203-TI00-011 Plata Silvrex (B-1)',
    measurementType: 'NUMBER',
  });
  assert.strictEqual(list[2].measurementType, 'BOOLEAN');
});

test('parseSensorDashboard: null si el shape no matchea (fail-safe)', () => {
  assert.strictEqual(Core.parseSensorDashboard(null), null);
  assert.strictEqual(Core.parseSensorDashboard({}), null);
  assert.strictEqual(Core.parseSensorDashboard({ data: {} }), null);
});

test('pipeline parse→filterNumeric→label: solo NUMBER, etiqueta por estación', () => {
  const list = Core.parseSensorDashboard(SDQ_RESPONSE);
  const nums = Core.filterNumericSensors(list);
  assert.strictEqual(nums.length, 2);   // excluye el BOOLEAN
  assert.strictEqual(Core.sensorLabel(nums[0]), 'T203-TI00-011 Plata Silvrex (B-1)');
  assert.strictEqual(Core.normalizeName(nums[0].name), 't203-ti00-011 concentración de plata metálica');
});
