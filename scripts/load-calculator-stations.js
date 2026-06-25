/* ============================================================================
 * load-calculator-stations.js — Núcleo PURO del Configurador de Estaciones
 *
 * Construye payloads para los datos maestros de estación del calculador de
 * piezas por carga. SIN DOM ni API. Dual-export browser/Node.
 *
 * REGLA DE ORO (RMW no-destructivo): en Steelhead tanto `customInputs` como el
 * `inputSchema` son REPLACE TOTAL. Estas funciones MERGEAN sobre lo existente:
 * nunca pisan campos/valores ajenos (Capacidad, DivisaManoObra, NombreAnterior…).
 *
 *   - buildStationInputSchema : extiende el schema con los campos del calculador.
 *   - buildUpdateStationInputsVars : payload RMW de `UpdateStationInputs`.
 *
 * Expone `window.LoadCalculatorStations` (browser) y `module.exports` (Node).
 * ========================================================================== */
(function (root) {
  'use strict';

  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  /**
   * Extiende el inputSchema de una estación con los campos del calculador,
   * preservando los existentes. Devuelve {inputSchema, uiSchema} listos para
   * `CreateStationInputSchema`.
   *
   * @param existingSchema  el inputSchema actual de la estación (JSON Schema).
   * @param existingUiOrder  array `ui:order` actual (o vacío).
   * @param fields  objeto { key: { type, title, enum?, enumNames?, ... } } a agregar/actualizar.
   */
  function buildStationInputSchema({ existingSchema, existingUiOrder = [], fields = {} }) {
    const base = clone(existingSchema) || { type: 'object', title: '', required: [], properties: {}, description: '', dependencies: {} };
    base.properties = base.properties || {};
    // Merge no-destructivo: las keys de `fields` se agregan o actualizan; el resto se preserva.
    for (const [key, def] of Object.entries(fields)) {
      base.properties[key] = clone(def);
    }
    // ui:order: existentes primero (deduplicados), luego las keys nuevas que no estuvieran.
    const order = [];
    const seen = new Set();
    for (const k of existingUiOrder) {
      if (!seen.has(k)) { order.push(k); seen.add(k); }
    }
    for (const k of Object.keys(fields)) {
      if (!seen.has(k)) { order.push(k); seen.add(k); }
    }
    return { inputSchema: base, uiSchema: { 'ui:order': order } };
  }

  /**
   * Payload RMW para `UpdateStationInputs`. Mergea `values` sobre los
   * `customInputs` existentes (preserva los que no se tocan).
   */
  function buildUpdateStationInputsVars({ stationId, inputSchemaId, existingCustomInputs, values = {} }) {
    const customInputs = Object.assign({}, clone(existingCustomInputs) || {}, clone(values) || {});
    return { stationId, inputSchemaId, customInputs };
  }

  /** Keys de `fieldKeys` que NO están en `inputSchema.properties` (las que faltan por crear). */
  function schemaMissingFields(inputSchema, fieldKeys = []) {
    const props = (inputSchema && inputSchema.properties) || {};
    return fieldKeys.filter((k) => !(k in props));
  }

  /** Prefijo de línea del nombre de una estación: "T205-TI00-019 Enjuague" → "T205". null si no parsea. */
  function parseStationLine(name) {
    const m = String(name || '').match(/^([A-Za-z]\d{3})/);
    return m ? m[1].toUpperCase() : null;
  }

  /** Agrupa estaciones por línea (parseStationLine). Omite las que no parsean. → { line: [stations] } */
  function groupStationsByLine(stations = []) {
    const out = {};
    for (const s of stations) {
      const line = parseStationLine(s && s.name);
      if (!line) continue;
      (out[line] || (out[line] = [])).push(s);
    }
    return out;
  }

  const api = {
    buildStationInputSchema, buildUpdateStationInputsVars,
    schemaMissingFields, parseStationLine, groupStationsByLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LoadCalculatorStations = api;
})(typeof window !== 'undefined' ? window : globalThis);
