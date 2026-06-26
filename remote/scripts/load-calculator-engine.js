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

  // ── Fase 2: decisión en runtime desde el modal de Rack Types ──

  /** Área de la pieza en dm² desde las unit conversions del PN (factor de la unidad DMK). null si no está. */
  function pieceAreaDm2FromConversions(nodes, dmkUnitId) {
    const id = dmkUnitId || 3975;
    const n = (nodes || []).find(x => x && x.unitByUnitId && x.unitByUnitId.id === id);
    return n ? n.factor : null;
  }

  /** Capacidad DMK del barril si el RackType está configurado como barril en la estación; null si es rack. */
  function selectBarrelCapacity(rackTypeId, capacidadesBarril) {
    const m = (capacidadesBarril || []).find(c => c && String(c.rackTypeId) === String(rackTypeId));
    return m ? m.capacidadDMK : null;
  }

  /**
   * Decide modo y calcula para el RackType elegido en el modal.
   * - Si el RackType está en `capacidadesBarril` de la estación → BARRIL (capacidad / área pieza).
   * - Si no → RACK: cuadrícula (si hay dims de pieza + tina) y área (si hay área de pieza + tina).
   * Tina en cm; pieza en pulgadas; áreas en dm².
   */
  function computeForRackType({ rackTypeId, capacidadesBarril, areaPieza_dm2, piece, tina }) {
    const cap = selectBarrelCapacity(rackTypeId, capacidadesBarril);
    if (cap != null) {
      return { modo: 'BARRIL', capacidadDMK: cap, piezasPorCarga: (areaPieza_dm2 != null ? Math.floor(cap / areaPieza_dm2) : null) };
    }
    const out = { modo: 'RACK', grid: null, area: null };
    if (piece && tina && piece.largoIn != null && piece.anchoIn != null && tina.largoMaxCm != null && tina.anchoMaxCm != null) {
      out.grid = gridPieces({
        tankW_in: cmToIn(tina.largoMaxCm), tankD_in: cmToIn(tina.anchoMaxCm),
        pieceL_in: piece.largoIn, pieceW_in: piece.anchoIn,
        sepCol_in: cmToIn(tina.sepColCm || 0), sepRow_in: cmToIn(tina.sepFilaCm || 0),
      });
    }
    if (areaPieza_dm2 != null && tina && tina.largoMaxCm != null && tina.anchoMaxCm != null) {
      const areaEfectiva = (tina.largoMaxCm * tina.anchoMaxCm / 100) * (tina.factor != null ? tina.factor : 1);
      out.area = { piezasPorCarga: Math.floor(areaEfectiva / areaPieza_dm2), areaEfectiva, areaPieza_dm2 };
    }
    return out;
  }

  /**
   * Convierte las dimensiones de un PN (length/width, en metros) a pulgadas para la cuadrícula.
   * `partNumberDimensions` = [{geometryTypeDimensionTypeId, dimensionValue}]; `geometryDimensions`
   * = config.domain.geometryDimensions ({LENGTH,WIDTH,...} → dimensionTypeId). null si falta largo o ancho.
   */
  function dimsToPieceInches(partNumberDimensions, geometryDimensions) {
    const geo = geometryDimensions || {};
    const byType = {};
    for (const d of (partNumberDimensions || [])) {
      if (d && d.geometryTypeDimensionTypeId != null) byType[d.geometryTypeDimensionTypeId] = d.dimensionValue;
    }
    const lenM = byType[geo.LENGTH];
    const widM = byType[geo.WIDTH];
    if (lenM == null || widM == null) return null;
    return { largoIn: mToIn(lenM), anchoIn: mToIn(widM) };
  }

  // ── Fase 2c: funciones puras de geometría ──

  /**
   * Clasifica el estado de geometría de un PN.
   * @param {number|null} geometryTypeId  id del Geometry Type del PN (o null/undefined si no tiene).
   * @param {number}      genericId       id del Geometry Type genérico (config.domain.geometryGenericaId, usualmente 831).
   * @returns {'SIN_GEOMETRIA'|'GENERICA'|'OTRA'}
   */
  function classifyGeometryState(geometryTypeId, genericId) {
    if (!geometryTypeId) return 'SIN_GEOMETRIA';
    return geometryTypeId === genericId ? 'GENERICA' : 'OTRA';
  }

  /**
   * Extrae las dimensiones físicas de un PN desde los nodos de
   * `partNumberDimensionsByPartNumberId.nodes`.
   * Los valores se almacenan en metros (unitByUnitId.id === MTR = 3971).
   * @param {Array} nodes             array de nodos { geometryTypeDimensionTypeId, dimensionValue, unitByUnitId:{id} }.
   * @param {object} geometryDimensions  config.domain.geometryDimensions ({LENGTH,WIDTH,HEIGHT,...} → typeId).
   * @returns {{lengthM:number, widthM:number, heightM:number|null}|null}
   *   null si no hay nodos o si faltan tanto LENGTH como WIDTH.
   */
  function dimsFromPartNumber(nodes, geometryDimensions) {
    if (!nodes || !nodes.length) return null;
    const geo = geometryDimensions || {};
    const byType = {};
    for (const d of nodes) {
      if (d && d.geometryTypeDimensionTypeId != null) {
        byType[d.geometryTypeDimensionTypeId] = d.dimensionValue;
      }
    }
    const lengthM = byType[geo.LENGTH] != null ? byType[geo.LENGTH] : null;
    const widthM  = byType[geo.WIDTH]  != null ? byType[geo.WIDTH]  : null;
    if (lengthM == null || widthM == null) return null;
    const heightM = byType[geo.HEIGHT] != null ? byType[geo.HEIGHT] : null;
    return { lengthM, widthM, heightM };
  }

  /**
   * Calcula el área de la pieza en dm² a partir de sus dims en metros.
   * Fórmula: (lengthM * 10) * (widthM * 10)  → dm² directamente.
   * Ejemplo: 0.3m × 0.2m → 3dm × 2dm = 6 dm².
   * @param {number} lengthM  largo en metros.
   * @param {number} widthM   ancho en metros.
   * @returns {number} área en dm².
   */
  function areaFromDims(lengthM, widthM) {
    return (lengthM * 10) * (widthM * 10);
  }

  /**
   * Construye las 3 conversiones de área para un PN a partir del área en dm².
   * @param {number} areaDm2      área en dm² (DMK).
   * @param {object} conversions  config.domain.conversions ({CMK_TO_FTK, ...}).
   * @returns {{dmk:number, cmk:number, ftk:number}}
   *   dmk = areaDm2 · cmk = areaDm2 × 100 · ftk = cmk × CMK_TO_FTK.
   */
  function buildAreaConversions(areaDm2, conversions) {
    const cmk = areaDm2 * 100;
    const ftk = cmk * ((conversions && conversions.CMK_TO_FTK) || 0.00107639);
    return { dmk: areaDm2, cmk, ftk };
  }

  /**
   * Indica si las dims capturadas difieren de las existentes en el PN por más de
   * `tolerancePct`% en CUALQUIER dimensión (length o width).
   * Retorna false si cualquiera de los dos objetos es null/undefined (no hay con qué comparar).
   * @param {{lengthM:number,widthM:number}} capturedDims   dims que el usuario capturó.
   * @param {{lengthM:number,widthM:number}|null} existingDims  dims actuales del PN.
   * @param {number} [tolerancePct=1]  porcentaje de tolerancia (default 1%).
   * @returns {boolean}
   */
  function dimsAreDifferent(capturedDims, existingDims, tolerancePct = 1) {
    if (!capturedDims || !existingDims) return false;
    const tol = tolerancePct / 100;
    const checkKeys = ['lengthM', 'widthM'];
    for (const key of checkKeys) {
      const cap = capturedDims[key];
      const ex  = existingDims[key];
      if (cap == null || ex == null) continue;
      // Diferencia relativa vs la referencia existente
      const ref = Math.abs(ex) > 1e-12 ? ex : 1;
      if (Math.abs(cap - ex) / Math.abs(ref) > tol) return true;
    }
    return false;
  }

  const api = {
    M_TO_IN, mToIn, cmToIn, cm2ToDm2,
    gridPieces, areaPieces, barrelPieces, decideMode, loadsPerHour,
    pieceAreaDm2FromConversions, selectBarrelCapacity, computeForRackType, dimsToPieceInches,
    // F2c: geometría
    classifyGeometryState, dimsFromPartNumber, areaFromDims, buildAreaConversions, dimsAreDifferent,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LoadCalculatorEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
