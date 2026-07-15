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

  // El alert nativo que SH dispara ("Error saving price") cuando nuestro bloqueo devuelve un
  // error sintético. Se suprime solo en la ventana posterior a un bloqueo (glue en el guard).
  function isSaveErrorAlert(msg) {
    return /saving\s+price/i.test(String(msg == null ? '' : msg));
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

  // Precio convertido a todas las unidades disponibles del NP. El factor de cada unidad V es
  // "unidades V por pieza" (V/pza). precio_por_pieza = precio × factor_de_la_unidad_capturada;
  // precio_por_V = precio_por_pieza / factor_V. Devuelve [{code, unitPrice, isPriceUnit}] con
  // 'pieza' primero, o [] si el precio o el factor de la unidad capturada no son válidos.
  function buildEquivalences(opts) {
    const o = opts || {};
    const price = Number(o.price);
    const puf = Number(o.priceUnitFactor);
    if (o.price === '' || o.price == null || !Number.isFinite(price)) return [];
    if (!Number.isFinite(puf) || puf <= 0) return [];
    const ppp = price * puf;
    const out = [{ code: 'pieza', unitPrice: ppp, isPriceUnit: o.priceUnitCode === 'pieza' }];
    const factors = o.factorsByCode || {};
    for (const code of Object.keys(factors)) {
      if (code === 'pieza') continue;
      const f = Number(factors[code]);
      if (!Number.isFinite(f) || f <= 0) continue;
      out.push({ code, unitPrice: ppp / f, isPriceUnit: code === o.priceUnitCode });
    }
    return out;
  }

  const api = {
    UNIT_BY_ID,
    extractLines,
    hasDivisa,
    pricesMatch,
    perPieceEquivalent,
    isPerPiece,
    isSaveErrorAlert,
    unitLabel,
    unitCodeFromLabel,
    isPerPartLabel,
    parseLeadingNumber,
    buildEquivalences,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PriceConfirmCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
