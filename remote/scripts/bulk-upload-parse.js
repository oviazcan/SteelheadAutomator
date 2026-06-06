// bulk-upload-parse.js — funciones PURAS de parseo/normalización del CSV de Carga Masiva.
//
// Dual-export: window.SteelheadBulkParse (browser) / module.exports (node --test),
// mismo patrón que bulk-upload-cc.js. SIN dependencias de DOM, API ni closure.
//
// Copia FIEL de las definiciones que vivían en bulk-upload.js (characterization
// refactor: el comportamiento no cambia). resolveUnitId y parseRows NO se extraen
// porque dependen de estado del closure (unitNodes, DOMAIN, warn, config).
(function (root) {
  'use strict';

  // --- Booleano tri-valor ES (bulk-upload.js:1025) ---
  const toBool = (v) => {
    const s = (v || '').toString().trim().toUpperCase();
    return s === 'SI' || s === 'SÍ' || s === 'YES' || s === '1' || s === 'TRUE' || s === 'V' || s === 'VERDADERO';
  };

  // --- Guión (-) comodín: vacío = no tocar, valor = sobrescribir, "-" = borrar (bulk-upload.js:1430) ---
  const isDash = (v) => v === '-';
  const resolveStr = (raw, existing) => {
    if (raw === '' || raw === undefined) return existing; // no tocar
    if (isDash(raw)) return ''; // borrar
    return raw; // sobrescribir
  };
  const resolveNum = (raw, existing) => {
    if (raw === null || raw === undefined) return existing;
    if (typeof raw === 'string' && isDash(raw)) return null;
    return raw;
  };

  // --- Lectura de celda: trim + colapsa espacios; (seleccione) -> vacío (bulk-upload.js:1027) ---
  // En bulk-upload.js se llamaban g/gn; aquí cell/cellNum (nombres explícitos).
  const cell = (row, i) => {
    const v = (row[i] || '').trim().replace(/\s+/g, ' ');
    if (v === '(seleccione)' || v === '(seleccione o escriba)') return '';
    return v;
  };
  const cellNum = (row, i) => { const v = parseFloat(cell(row, i)); return isNaN(v) ? null : v; };

  // --- Constantes de dominio del CSV (bulk-upload.js:1035-1063) ---
  const PRICE_UNIT_MAP = { PZA: null, KGM: 3969, CMK: 4907, FTK: 4797, LM: 5150, LBR: 3972, LO: 5348 };

  const PREDICTIVE_MATERIALS = [
    { col: 53, inventoryItemId: 364506, name: 'Plata Fina' },
    { col: 54, inventoryItemId: 397490, name: 'Estaño Puro' },
    { col: 55, inventoryItemId: 412305, name: 'Níquel Metálico' },
    { col: 56, inventoryItemId: 412805, name: 'Zinc Metálico' },
    { col: 57, inventoryItemId: 412479, name: 'Placa de Cobre Electrolítico' },
    { col: 58, inventoryItemId: 412723, name: 'Sterlingshield S (Antitarnish)' },
    { col: 59, inventoryItemId: 702767, name: 'Epoxy MT' },
    { col: 60, inventoryItemId: 702769, name: 'Epoxica BT' },
    { col: 61, inventoryItemId: 702768, name: 'Epoxica MT Red' },
  ];

  const HEADER_KEYS = {
    'modo': 'modo',
    'nombre cotizacion': 'quoteName', 'nombre cotización': 'quoteName',
    'nombre cotizacion/layout': 'quoteName', 'nombre cotización/layout': 'quoteName',
    'empresa emisora': 'empresaEmisora',
    'notas externas': 'notasExternas',
    'notas internas': 'notasInternas',
    'asignado': 'asignado',
    'valida hasta (dias)': 'validaDias', 'válida hasta (días)': 'validaDias',
  };

  // --- CSV parser (bulk-upload.js:1069) ---
  function parseCSV(t) {
    const rows = []; let i = 0;
    while (i < t.length) {
      const row = [];
      while (i < t.length) {
        if (t[i] === '"') {
          i++; let v = '';
          while (i < t.length) {
            if (t[i] === '"') { if (t[i + 1] === '"') { v += '"'; i += 2; } else { i++; break; } }
            else { v += t[i]; i++; }
          }
          row.push(v);
        } else {
          let v = '';
          while (i < t.length && t[i] !== ',' && t[i] !== '\r' && t[i] !== '\n') { v += t[i]; i++; }
          row.push(v);
        }
        if (t[i] === ',') { i++; continue; } else break;
      }
      if (t[i] === '\r') i++;
      if (t[i] === '\n') i++;
      rows.push(row);
    }
    return rows;
  }

  // --- Construcción de dimensiones (bulk-upload.js:1420); DOMAIN es parámetro -> puro ---
  function buildDimensions(dims, DOMAIN) {
    const out = [];
    const map = [
      ['length', DOMAIN.geometryDimensions.LENGTH], ['width', DOMAIN.geometryDimensions.WIDTH],
      ['height', DOMAIN.geometryDimensions.HEIGHT], ['outerDiam', DOMAIN.geometryDimensions.OUTER_DIAM],
      ['innerDiam', DOMAIN.geometryDimensions.INNER_DIAM],
    ];
    for (const [key, id] of map) {
      if (dims[key] !== null && dims[key] !== undefined) {
        out.push({ geometryTypeDimensionTypeId: id, unitId: DOMAIN.unitIds.MTR, dimensionValue: dims[key] });
      }
    }
    return out;
  }

  const api = {
    toBool, isDash, resolveStr, resolveNum, cell, cellNum, parseCSV, buildDimensions,
    PRICE_UNIT_MAP, PREDICTIVE_MATERIALS, HEADER_KEYS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
