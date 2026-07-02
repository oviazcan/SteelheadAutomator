// price-confirm-core.js — funciones PURAS del Candado de Confirmación de Precio.
//
// Dual-export: window.PriceConfirmCore (browser) / module.exports (node --test).
// SIN dependencias de DOM, API ni closure. Opera sobre las `variables` de la mutación
// SaveManyPartNumberPrices (modal nativo "Part Number Price") y valida la reconfirmación.
(function (root) {
  'use strict';

  // Espejo de PRICE_UNIT_MAP de bulk-upload-parse.js (PZA → null se omite; el resto invertido).
  // Refleja config.steelhead.domain.unitIds. Es fallback de display: el guard puede leer el
  // label real del react-select del modal nativo.
  const UNIT_BY_ID = {
    3969: 'KGM',
    3972: 'LBR',
    5150: 'LM',
    4907: 'CMK',
    4797: 'FTK',
    5348: 'LO',
  };

  // Aplana el payload a una fila por cada partNumberPriceLineItem (una unidad de reconfirmación).
  function extractLines(variables) {
    const pps = variables && variables.input && variables.input.partNumberPrices;
    if (!Array.isArray(pps)) return [];
    const out = [];
    pps.forEach((pp, ppIndex) => {
      const items = pp && pp.partNumberPriceLineItems;
      if (!Array.isArray(items)) return;
      const divisa =
        (pp.customInputs && pp.customInputs.DatosPrecio && pp.customInputs.DatosPrecio.Divisa) || '';
      items.forEach((li, liIndex) => {
        out.push({
          ppIndex,
          liIndex,
          partNumberId: pp.partNumberId,
          title: (li && li.title) || '',
          price: li && li.price,
          divisa,
          unitId: pp.unitId != null ? pp.unitId : null,
          priceName: pp.priceName || '',
        });
      });
    });
    return out;
  }

  function hasDivisa(line) {
    return !!(line && typeof line.divisa === 'string' && line.divisa.trim() !== '');
  }

  // Normaliza y compara numéricamente. Cadena vacía / no numérica nunca hace match.
  // El input de reconfirmación usa punto decimal (como el modal nativo), no coma.
  function pricesMatch(original, reconfirmRaw) {
    const raw = String(reconfirmRaw == null ? '' : reconfirmRaw).trim();
    if (raw === '') return false;
    const a = Number(original);
    const b = Number(raw);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a === b;
  }

  // price × factor. factor debe ser finito > 0; price finito. Si no, null (sin equivalente).
  function perPieceEquivalent(price, factor) {
    if (price == null || factor == null || price === '' || factor === '') return null;
    const p = Number(price);
    const f = Number(factor);
    if (!Number.isFinite(p) || !Number.isFinite(f) || f <= 0) return null;
    return p * f;
  }

  function isPerPiece(unitId) {
    return unitId == null;
  }

  function unitLabel(unitId) {
    if (isPerPiece(unitId)) return 'pieza';
    return UNIT_BY_ID[unitId] || 'unidad #' + unitId;
  }

  // Parsing del factor desde el DOM (glue en el guard):
  //  - Panel A (modal Edit Part Number): labels "KGM Kilogramo / Part:" + input value.
  //  - Tabla Units (página del NP): "1 KGM Kilogramos / part".
  function unitCodeFromLabel(text) {
    if (!text) return '';
    return String(text).trim().split(/\s+/)[0].toUpperCase();
  }
  function isPerPartLabel(text) {
    return /\/\s*part:?\s*$/i.test(String(text || '').trim());
  }
  function parseLeadingNumber(text) {
    const n = parseFloat(String(text == null ? '' : text).trim());
    return Number.isFinite(n) ? n : null;
  }

  const api = {
    UNIT_BY_ID,
    extractLines,
    hasDivisa,
    pricesMatch,
    perPieceEquivalent,
    isPerPiece,
    unitLabel,
    unitCodeFromLabel,
    isPerPartLabel,
    parseLeadingNumber,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PriceConfirmCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
