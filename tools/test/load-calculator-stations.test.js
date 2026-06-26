// tools/test/load-calculator-stations.test.js
//
// Tests del núcleo PURO del Configurador de Estaciones (`load-calculator`).
// Dos operaciones críticas, ambas NO-DESTRUCTIVAS (lección de RMW del proyecto:
// customInputs y el inputSchema son REPLACE total en SH — hay que mergear sobre
// lo existente, nunca pisar campos ajenos):
//   - buildStationInputSchema: extiende el schema de estación con los campos del
//     calculador preservando los que ya existen (Capacidad/DivisaManoObra/...).
//   - buildUpdateStationInputsVars: arma el payload RMW de UpdateStationInputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'load-calculator-stations.js'));

// Schema REAL capturado de una estación (scan 2026-06-24): los 3 campos "temp".
const EXISTING_SCHEMA = {
  type: 'object', title: '', required: [], description: '', dependencies: {},
  properties: {
    NombreAnterior: { type: 'string', title: 'Nombre Anterior' },
    DivisaManoObra: { enum: ['USD', 'MXN'], type: 'string', title: 'Divisa del Costo de Mano de Obra', enumNames: ['USD - Dólar americano', 'MXN - Peso mexicano'] },
    Capacidad: { type: 'integer', title: 'Capacidad en Litros (temp)' },
  },
};
const EXISTING_UIORDER = ['NombreAnterior', 'DivisaManoObra', 'Capacidad'];

const CALC_FIELDS = {
  TipoLinea: { type: 'string', enum: ['Rack', 'Barril', 'Híbrida', 'Célula'], title: 'Tipo de Línea' },
  TinaLargoCm: { type: 'number', title: 'Largo de Tina (cm)' },
  TinaAnchoCm: { type: 'number', title: 'Ancho de Tina (cm)' },
};

test('buildStationInputSchema agrega los campos del calculador sin perder los existentes', () => {
  const { inputSchema } = S.buildStationInputSchema({ existingSchema: EXISTING_SCHEMA, existingUiOrder: EXISTING_UIORDER, fields: CALC_FIELDS });
  // existentes intactos
  assert.deepEqual(inputSchema.properties.NombreAnterior, EXISTING_SCHEMA.properties.NombreAnterior);
  assert.deepEqual(inputSchema.properties.Capacidad, EXISTING_SCHEMA.properties.Capacidad);
  // nuevos presentes
  assert.deepEqual(inputSchema.properties.TipoLinea, CALC_FIELDS.TipoLinea);
  assert.deepEqual(inputSchema.properties.TinaLargoCm, CALC_FIELDS.TinaLargoCm);
  // total = 3 + 3
  assert.equal(Object.keys(inputSchema.properties).length, 6);
});

test('buildStationInputSchema: ui:order = existentes primero, luego nuevos, sin duplicar', () => {
  const { uiSchema } = S.buildStationInputSchema({ existingSchema: EXISTING_SCHEMA, existingUiOrder: EXISTING_UIORDER, fields: CALC_FIELDS });
  assert.deepEqual(uiSchema['ui:order'], ['NombreAnterior', 'DivisaManoObra', 'Capacidad', 'TipoLinea', 'TinaLargoCm', 'TinaAnchoCm']);
});

test('buildStationInputSchema NO muta el schema de entrada', () => {
  const snapshot = JSON.stringify(EXISTING_SCHEMA);
  S.buildStationInputSchema({ existingSchema: EXISTING_SCHEMA, existingUiOrder: EXISTING_UIORDER, fields: CALC_FIELDS });
  assert.equal(JSON.stringify(EXISTING_SCHEMA), snapshot);
});

test('buildStationInputSchema: un campo ya existente en el schema se actualiza, no se duplica en ui:order', () => {
  const fields = { Capacidad: { type: 'number', title: 'Capacidad (litros, corregido)' }, TinaLargoCm: { type: 'number', title: 'Largo (cm)' } };
  const { inputSchema, uiSchema } = S.buildStationInputSchema({ existingSchema: EXISTING_SCHEMA, existingUiOrder: EXISTING_UIORDER, fields });
  assert.equal(inputSchema.properties.Capacidad.title, 'Capacidad (litros, corregido)'); // actualizado
  // ui:order no duplica Capacidad
  assert.deepEqual(uiSchema['ui:order'], ['NombreAnterior', 'DivisaManoObra', 'Capacidad', 'TinaLargoCm']);
});

test('buildUpdateStationInputsVars hace RMW: preserva customInputs existentes y agrega los nuevos', () => {
  const vars = S.buildUpdateStationInputsVars({
    stationId: 20864, inputSchemaId: 79,
    existingCustomInputs: { Capacidad: 0, DivisaManoObra: 'USD', NombreAnterior: 'N/A' },
    values: { TinaLargoCm: 170, TipoLinea: 'Rack' },
  });
  assert.deepEqual(vars, {
    stationId: 20864, inputSchemaId: 79,
    customInputs: { Capacidad: 0, DivisaManoObra: 'USD', NombreAnterior: 'N/A', TinaLargoCm: 170, TipoLinea: 'Rack' },
  });
});

test('buildUpdateStationInputsVars: un valor nuevo sobre-escribe la key existente', () => {
  const vars = S.buildUpdateStationInputsVars({
    stationId: 1, inputSchemaId: 2,
    existingCustomInputs: { Capacidad: 0 }, values: { Capacidad: 500 },
  });
  assert.equal(vars.customInputs.Capacidad, 500);
});

test('buildUpdateStationInputsVars NO muta existingCustomInputs', () => {
  const existing = { Capacidad: 0 };
  const snapshot = JSON.stringify(existing);
  S.buildUpdateStationInputsVars({ stationId: 1, inputSchemaId: 2, existingCustomInputs: existing, values: { TinaLargoCm: 10 } });
  assert.equal(JSON.stringify(existing), snapshot);
});

test('buildUpdateStationInputsVars tolera existingCustomInputs null/undefined', () => {
  const vars = S.buildUpdateStationInputsVars({ stationId: 1, inputSchemaId: 2, existingCustomInputs: null, values: { TinaLargoCm: 10 } });
  assert.deepEqual(vars.customInputs, { TinaLargoCm: 10 });
});

test('schemaMissingFields devuelve solo las keys ausentes en el schema', () => {
  assert.deepEqual(
    S.schemaMissingFields(EXISTING_SCHEMA, ['TipoLinea', 'Capacidad', 'TinaLargoCm']),
    ['TipoLinea', 'TinaLargoCm'], // Capacidad ya existe
  );
});

test('schemaMissingFields: schema null → faltan todos', () => {
  assert.deepEqual(S.schemaMissingFields(null, ['A', 'B']), ['A', 'B']);
  assert.deepEqual(S.schemaMissingFields({ properties: {} }, ['A']), ['A']);
});

test('parseStationLine extrae el prefijo de línea del nombre de la estación', () => {
  assert.equal(S.parseStationLine('T205-TI00-019 Enjuague'), 'T205');
  assert.equal(S.parseStationLine('M102-LI Caliente'), 'M102');
  assert.equal(S.parseStationLine('T205'), 'T205');
  assert.equal(S.parseStationLine('Recepción general'), null);
  assert.equal(S.parseStationLine(''), null);
  assert.equal(S.parseStationLine(null), null);
});

test('findSchedulableStationsForLine: estaciones programables de una línea', () => {
  const stations = [
    { id: 1, name: 'T101-LI Pre-Limpiezas', calendarByCalendarId: { id: 9 } },
    { id: 2, name: 'T101-TI00 Enjuague' },                                  // no programable
    { id: 3, name: 'T205-LI Algo', calendarByCalendarId: { id: 9 } },       // otra línea
    { id: 4, name: 'T101-CA01 Cotizable', calendarId: 7 },                  // programable, misma línea
  ];
  const r = S.findSchedulableStationsForLine(stations, 'T101');
  assert.deepEqual(r.map(s => s.id), [1, 4]);
  assert.deepEqual(S.findSchedulableStationsForLine(stations, 't101').map(s => s.id), [1, 4]); // case-insensitive
  assert.deepEqual(S.findSchedulableStationsForLine(stations, 'T999'), []);
});

test('stationIsSchedulable: true sólo si la estación tiene calendario', () => {
  assert.equal(S.stationIsSchedulable({ calendarByCalendarId: { id: 5 } }), true);
  assert.equal(S.stationIsSchedulable({ calendarId: 5 }), true);
  assert.equal(S.stationIsSchedulable({ calendarByCalendarId: null }), false);
  assert.equal(S.stationIsSchedulable({}), false);
  assert.equal(S.stationIsSchedulable(null), false);
});

test('groupStationsByLine agrupa por línea y omite las que no parsean', () => {
  const stations = [
    { id: 1, name: 'T205-A' }, { id: 2, name: 'T205-B' },
    { id: 3, name: 'M102-X' }, { id: 4, name: 'raro sin línea' },
  ];
  const g = S.groupStationsByLine(stations);
  assert.deepEqual(Object.keys(g).sort(), ['M102', 'T205']);
  assert.equal(g.T205.length, 2);
  assert.equal(g.M102.length, 1);
  assert.deepEqual(g.T205.map(s => s.id), [1, 2]);
});

// ── Fase 2b: persistencia en el PN (RMW de customInputs, no-destructivo) ──

test('buildPlanningCustomInputs: RMW de DatosPlanificacion + append ControlCambios, sin pisar lo demás', () => {
  const ci = { DatosFacturacion: { CodigoSAT: 'x' }, DatosPlanificacion: { TiempoEntrega: 5 } };
  const out = S.buildPlanningCustomInputs(ci, { piezasCarga: 87, ccEntry: { Fecha: '2026-06-25', Accion: 'CARGA' } });
  assert.equal(out.DatosPlanificacion.PiezasCarga, 87);
  assert.equal(out.DatosPlanificacion.TiempoEntrega, 5);      // preservado
  assert.equal(out.DatosFacturacion.CodigoSAT, 'x');          // preservado
  assert.equal(out.ControlCambios.length, 1);
  assert.equal(out.ControlCambios[0].Accion, 'CARGA');
  assert.equal(ci.DatosPlanificacion.PiezasCarga, undefined); // NO muta el original
  assert.ok(ci.ControlCambios === undefined);
});

test('buildPlanningCustomInputs: append a ControlCambios existente + crea DatosPlanificacion si falta', () => {
  const ci = { ControlCambios: [{ Accion: 'ALTA' }] };
  const out = S.buildPlanningCustomInputs(ci, { piezasCarga: 10, ccEntry: { Accion: 'CARGA' } });
  assert.equal(out.ControlCambios.length, 2);
  assert.equal(out.DatosPlanificacion.PiezasCarga, 10);
});

test('buildPlanningCustomInputs: sin ccEntry no toca ControlCambios; solo escribe los campos provistos', () => {
  const out = S.buildPlanningCustomInputs({}, { piezasCarga: 5 });
  assert.equal(out.DatosPlanificacion.PiezasCarga, 5);
  assert.ok(out.ControlCambios === undefined);
  assert.ok(!('CargasHora' in out.DatosPlanificacion));
});
