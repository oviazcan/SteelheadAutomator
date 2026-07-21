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
    // 1.5.23: normaliza acentos + mayúsculas — el v10 usa "(seleccione ó escriba)" (ó acentuada),
    // que antes se colaba como valor real. Espeja el `g` local de bulk-upload.js parseRows.
    const ph = v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (ph === '(seleccione)' || ph === '(seleccione o escriba)') return '';
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

  // F5: detección de intención de la corrida (para badge en preview + fast-path SOLO_PRECIO).
  // Opera sobre los `parts` ya parseados (no sobre rows/COLS) — más robusto al layout v10/v11.
  // partHasEnrich = el part trae CUALQUIER columna de enriquecimiento con dato O dash (ambos son
  // intención de cambio de línea; solo el vacío no cuenta). El criterio espeja el de showPreview.
  function partHasEnrich(p) {
    if (!p) return false;
    const arr = (a) => Array.isArray(a) && a.length > 0;
    const dimsHave = p.dims && Object.values(p.dims).some(v => v != null);
    const uc = p.unitConv || {};
    const ucHave = uc.kgm != null || uc.cmk != null || uc.lm != null || uc.minPzasLote != null;
    return arr(p.labels) || arr(p.specs) || arr(p.racks) || arr(p.predictiveUsage) || arr(p.products)
      || dimsHave || ucHave
      || !!p.metalBase || !!p.pnAlterno || !!p.codigoSAT || !!p.procesoOverride
      || (p.validacion1er !== null && p.validacion1er !== undefined);
  }

  // classifyRunIntent — clasifica la corrida completa.
  //   SOLO_PRECIO    : trae precio, NINGÚN enriquecimiento, y todos los PN ya existen → habilita fast-path
  //   AJUSTE_LINEA   : trae enriquecimiento pero NO precio
  //   ENRIQUECIMIENTO: trae enriquecimiento (con o sin precio)
  //   ALTA           : ni precio ni enriquecimiento (típico de PN nuevos sin datos)
  function classifyRunIntent(parts, allExisting) {
    let hasPrice = false, hasEnrich = false;
    for (const p of (parts || [])) {
      if (p && p.precio != null) hasPrice = true;
      if (partHasEnrich(p)) hasEnrich = true;
    }
    if (hasPrice && !hasEnrich && allExisting) return 'SOLO_PRECIO';
    if (hasEnrich && !hasPrice) return 'AJUSTE_LINEA';
    if (hasEnrich) return 'ENRIQUECIMIENTO';
    return 'ALTA';
  }

  // planSoloPrecioFastPath — gate PURO del atajo de solo-precio (feat 1.5.40).
  // Devuelve true SOLO cuando el feature-flag está encendido Y la corrida es exactamente
  // 'SOLO_PRECIO' (todos los PN existen, hay precio, y NINGÚN enriquecimiento — ver
  // classifyRunIntent). Cuando devuelve true, el flujo puede saltar los STEPs de
  // enriquecimiento (specs/params/racks/dims) e ir directo a precios (STEP 7b/8).
  // Con el flag apagado es SIEMPRE false → el pipeline corre idéntico al comportamiento
  // previo (no-regresión). Es puro a propósito: toda la decisión de riesgo es testeable.
  function planSoloPrecioFastPath(runIntent, flagEnabled) {
    return !!flagEnabled && runIntent === 'SOLO_PRECIO';
  }

  // resolveDimSelections — compone el array final de dimensionCustomValueIds que
  // SavePartNumber recibe (semántica REPLACE), preservando por TIPO de dimensión.
  //
  // Contexto: el dominio tiene 2 dimensiones contables (Línea, Departamento). Como
  // v12 ya NO exporta Departamento, una fila con Línea mandaría solo [lineaId] y
  // BORRARÍA el departamento existente (REPLACE). Esta función resuelve cada eje por
  // separado y los recompone, aplicando la regla de negocio del Departamento:
  //   "default Producción si NO tiene dato; si ya tiene, respetar" (altas y edición).
  //
  // Intents por eje: 'value-ok' (CSV trae value válido), 'dash' (borrar explícito),
  // 'none'/'value-missing' (sin dato del CSV → preservar existente).
  //   - Línea:       value-ok→CSV | dash→borrar | else→preservar existente
  //   - Departamento value-ok→CSV | dash→borrar | else→existente ?? default Producción
  // Cualquier dim existente que no sea Línea ni Departamento se preserva tal cual.
  function resolveDimSelections(opts) {
    const {
      lineaIntent, lineaId,
      deptoIntent, deptoId,
      existingDimIds = [],
      lineaValueIdSet, deptoValueIdSet,
      deptoDefaultId = null,
      // Solo inyectar el default cuando SABEMOS que el PN no tiene departamento:
      // alta (nuevo) o con snapshot del PN existente. Si es existente sin snapshot
      // (prefetch falló) NO inyectamos default — no sobreescribir un depto que no
      // pudimos leer.
      applyDeptoDefault = true,
    } = opts || {};
    const inSet = (set, id) => !!(set && typeof set.has === 'function' && set.has(id));

    let effLinea = null;
    if (lineaIntent === 'value-ok') effLinea = lineaId ?? null;
    else if (lineaIntent === 'dash') effLinea = null;
    else effLinea = existingDimIds.find(id => inSet(lineaValueIdSet, id)) ?? null;

    let effDepto = null;
    if (deptoIntent === 'value-ok') effDepto = deptoId ?? null;
    else if (deptoIntent === 'dash') effDepto = null;
    else {
      const existingDepto = existingDimIds.find(id => inSet(deptoValueIdSet, id));
      effDepto = (existingDepto != null) ? existingDepto
        : (applyDeptoDefault ? (deptoDefaultId ?? null) : null);
    }

    const others = existingDimIds.filter(id => !inSet(lineaValueIdSet, id) && !inSet(deptoValueIdSet, id));
    return [effLinea, effDepto, ...others].filter(v => v != null);
  }

  // pickSpecParamId — elige el defaultParamId de un spec field a partir de los
  // segmentos del CSV (cs.param partido por ' | '). El catálogo combina espesor/temp/
  // tiempo como "Nombre | a | b | …"; aquí se matchea POR VALOR (no por posición ni por
  // identificar el field): un field de 1 param se auto-selecciona; uno con varios toma
  // el param cuyo nombre coincida con algún segmento. Compat espesor v10/v11: 1 segmento.
  // Devuelve { id, espesorMiss } — espesorMiss=true cuando es un field "espesor" con
  // varios params y ningún segmento coincide (el caller loguea el error y usa params[0]).
  function pickSpecParamId(params, segs, isEsp) {
    const ps = params || [];
    if (!ps.length) return { id: null, espesorMiss: false };
    if (ps.length === 1) return { id: ps[0].id, espesorMiss: false };
    for (const seg of (segs || [])) {
      const m = ps.find(p => p.name === seg);
      if (m) return { id: m.id, espesorMiss: false };
    }
    return { id: ps[0].id, espesorMiss: !!isEsp };
  }

  // pickSpecParamPositional — elige el param de UN spec field a partir de SU segmento
  // POSICIONAL del CSV (segmento[i] ↔ field[i]). Reemplaza a pickSpecParamId (que buscaba
  // "cualquier segmento que matcheara cualquier param"): eso fallaba cuando dos fields
  // comparten un param con el mismo nombre (p.ej. "No aplica" en 2 temperaturas) — el
  // field equivocado se quedaba con el "No aplica" de otra columna. Incidente 2026-07-06.
  //   - seg vacío/undefined  → null (NO aplicar este field; equivale a dos pipes seguidos)
  //   - seg matchea un param → ese param
  //   - seg no matchea y el field tiene 1 solo param → ese único (compat espesor v10/v11)
  //   - seg no matchea y el field tiene >1 param → null + {unmatched:true} (no aplicar; el
  //     caller loguea el error) para NO aplicar un valor equivocado por default.
  // numSig — firma numérica de un valor tipo "5.0 - 8.0 µm": los números canónicos (float,
  // "5.0"→"5") en orden + la unidad (letras no-numéricas, p.ej. "µm"/"mils"/"°c") para NO
  // cruzar unidades distintas. Devuelve null si no hay números (no comparable numéricamente).
  function numSig(str) {
    const nums = (String(str).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (!nums.length) return null;
    const unit = String(str).replace(/[\d.\s-]+/g, '').toLowerCase();
    return nums.join('|') + '#' + unit;
  }

  function pickSpecParamPositional(params, seg) {
    const ps = params || [];
    const s = (seg == null ? '' : String(seg)).trim();
    if (!ps.length || !s) return { id: null, unmatched: false };
    // 1) exacto tolerante a espacios: trim AMBOS lados. El catálogo de SH a veces guarda el
    //    nombre del parámetro con espacios sobrantes (incidente 20k: BURNDY = " 8 - 12 µm").
    const m = ps.find(p => String(p.name).trim() === s);
    if (m) return { id: m.id, unmatched: false };
    // 2) fallback numérico: mismos números en el mismo orden y misma unidad ("5 - 8 µm" ≡
    //    "5.0 - 8.0 µm"; incidente 20k: ASTM B545). SOLO si UN único param coincide → evita
    //    elegir el equivocado cuando dos params colapsan a la misma firma.
    const key = numSig(s);
    if (key) {
      const hits = ps.filter(p => numSig(String(p.name)) === key);
      if (hits.length === 1) return { id: hits[0].id, unmatched: false };
    }
    if (ps.length === 1) return { id: ps[0].id, unmatched: false };
    return { id: null, unmatched: true };
  }

  const api = {
    toBool, isDash, resolveStr, resolveNum, cell, cellNum, parseCSV, buildDimensions,
    partHasEnrich, classifyRunIntent, planSoloPrecioFastPath, resolveDimSelections, pickSpecParamId, pickSpecParamPositional,
    PRICE_UNIT_MAP, PREDICTIVE_MATERIALS, HEADER_KEYS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
