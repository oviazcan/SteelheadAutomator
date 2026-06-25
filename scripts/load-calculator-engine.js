/* ============================================================================
 * load-calculator-engine.js — Motor PURO de la Calculadora de Piezas por Carga
 *
 * Sin DOM ni API: solo aritmética. Dual-export browser/Node (patrón F1 de
 * bulk-upload), testeable con `node --test tools/test/load-calculator-engine.test.js`.
 *
 * Replica los cálculos del `Calculo.xlsx` de ingeniería:
 *   - Cuadrícula : columnas × filas (empaque rectangular en la tina).
 *   - Área       : área efectiva de la tina ÷ área de la pieza.
 *   - Barril     : capacidad (DMK = dm²) ÷ área de la pieza.
 *   - Cargas/hora: (60 / ciclo) × estaciones × OEE.
 *   - Decisión de modo (RACK / BARRIL / NINGUNO) por tipo de línea + unidad de precio.
 *
 * Expone `window.LoadCalculatorEngine` (browser) y `module.exports` (Node).
 * ========================================================================== */
(function (root) {
  'use strict';

  const M_TO_IN = 1 / 0.0254; // 39.37007874...

  const mToIn   = (m)   => m * M_TO_IN;
  const cmToIn  = (cm)  => cm / 2.54;
  const cm2ToDm2 = (cm2) => cm2 / 100;

  /**
   * Cuadrícula — empaque rectangular con orientación FIJA: el lado largo de la
   * tina se llena con el lado corto de la pieza (columnas) y el lado corto de la
   * tina con el lado largo de la pieza (filas). Reproduce los golden del Excel.
   * Todas las dimensiones en pulgadas.
   */
  function gridPieces({ tankW_in, tankD_in, pieceL_in, pieceW_in, sepCol_in = 0, sepRow_in = 0 }) {
    const tankLong   = Math.max(tankW_in, tankD_in);
    const tankShort  = Math.min(tankW_in, tankD_in);
    const pieceLong  = Math.max(pieceL_in, pieceW_in);
    const pieceShort = Math.min(pieceL_in, pieceW_in);
    const columnas = Math.floor(tankLong  / (pieceShort + sepCol_in));
    const filas    = Math.floor(tankShort / (pieceLong  + sepRow_in));
    return { columnas, filas, piezasPorCarga: columnas * filas };
  }

  /**
   * Área — piezas = FLOOR(areaTina_dm2 × factor / areaPieza_dm2).
   * Dimensiones de tina en cm; área de pieza en cm².
   */
  function areaPieces({ tankL_cm, tankW_cm, factor = 1, pieceArea_cm2 }) {
    const areaTina_dm2  = (tankL_cm * tankW_cm) / 100;
    const areaEfectiva  = areaTina_dm2 * factor;
    const areaPieza_dm2 = pieceArea_cm2 / 100;
    const piezasPorCarga = Math.floor(areaEfectiva / areaPieza_dm2);
    return { areaTina_dm2, areaEfectiva, areaPieza_dm2, piezasPorCarga };
  }

  /**
   * Barril (superficie / DMK) — variante de Área con la capacidad del barril
   * como área efectiva (factor implícito 1). Capacidad en DMK (dm²).
   */
  function barrelPieces({ capacityDMK, pieceArea_cm2 }) {
    const areaPieza_dm2 = pieceArea_cm2 / 100;
    return { areaPieza_dm2, piezasPorCarga: Math.floor(capacityDMK / areaPieza_dm2) };
  }

  /**
   * Decisión de modo según el tipo de CAT_Líneas + unidad de precio (para Híbrida).
   * Rack→RACK · Barril→BARRIL · Célula→NINGUNO · Híbrida: PZA→RACK, KG→BARRIL.
   */
  function decideMode({ lineType, priceUnit }) {
    const t = String(lineType || '').trim().toLowerCase();
    if (t.startsWith('rack')) return 'RACK';
    if (t.startsWith('barr')) return 'BARRIL';          // barril / barrel
    if (t.startsWith('cél') || t.startsWith('cel')) return 'NINGUNO'; // célula / celula
    // Híbrida (o desconocido): decide por unidad de precio.
    return String(priceUnit || '').toUpperCase() === 'PZA' ? 'RACK' : 'BARRIL';
  }

  /** Cargas por hora = (60 / ciclo_min) × estaciones × OEE. Ciclo inválido → 0. */
  function loadsPerHour({ cycleMin, stations = 1, oee = 1 }) {
    if (!cycleMin || cycleMin <= 0) return 0;
    return (60 / cycleMin) * stations * oee;
  }

  const api = {
    M_TO_IN, mToIn, cmToIn, cm2ToDm2,
    gridPieces, areaPieces, barrelPieces, decideMode, loadsPerHour,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LoadCalculatorEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
