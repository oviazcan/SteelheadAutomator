// tools/test/sentinel-health.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCycleOutcomes, formatSentinelAlert } = require('../hash-autopilot/sentinel-health.mjs');

test('classifyCycleOutcomes: separa broken (identidad) / captured / other', () => {
  const results = [
    { op: 'UpdateReceivedOrder', entityType: 'receivedOrderEdit', captured: false, escalated: true, reason: 'objeto cargado NO es centinela (identidad)' },
    { op: 'CreateMaintenanceEvent', entityType: 'maintenanceNode', captured: true },
    { op: 'AddPartsToWorkOrders', entityType: 'workOrderPartCount', captured: false, reason: 'sin hash' },
  ];
  const { broken, captured, other } = classifyCycleOutcomes(results);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].op, 'UpdateReceivedOrder');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].op, 'CreateMaintenanceEvent');
  assert.equal(other.length, 1);
  assert.equal(other[0].op, 'AddPartsToWorkOrders');
});

test('classifyCycleOutcomes: "identidad" en el reason también cuenta como broken', () => {
  const { broken } = classifyCycleOutcomes([
    { op: 'X', escalated: true, reason: 'falló la verificación de identidad' },
  ]);
  assert.equal(broken.length, 1);
});

test('classifyCycleOutcomes: escalated por OTRA razón (no identidad) NO es broken', () => {
  const { broken, other } = classifyCycleOutcomes([
    { op: 'DeleteThing', escalated: true, reason: 'destructiva (ephemeral no soportado en v1)' },
  ]);
  assert.equal(broken.length, 0, 'una escalación no-identidad no es un centinela roto');
  assert.equal(other.length, 1);
});

test('classifyCycleOutcomes: tolera null / vacío', () => {
  const { broken, captured, other } = classifyCycleOutcomes([null, undefined]);
  assert.equal(broken.length + captured.length + other.length, 0);
  assert.deepEqual(classifyCycleOutcomes(null), { broken: [], captured: [], other: [] });
});

test('formatSentinelAlert: vacío → cadena vacía (sin sección en el correo)', () => {
  assert.equal(formatSentinelAlert([]), '');
  assert.equal(formatSentinelAlert(null), '');
});

test('formatSentinelAlert: incluye op, entityType, id y la acción de desarchivar', () => {
  const txt = formatSentinelAlert([
    { op: 'UpdateReceivedOrder', entityType: 'receivedOrderEdit', sentinelId: 1594, reason: 'objeto cargado NO es centinela (identidad)' },
  ]);
  assert.match(txt, /CENTINELA ROTO\/ARCHIVADO \(1\)/);
  assert.match(txt, /UpdateReceivedOrder/);
  assert.match(txt, /receivedOrderEdit #1594/);
  assert.match(txt, /DESARCHIVA/);
});
