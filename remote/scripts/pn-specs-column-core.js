// Specs en el dashboard de Números de Parte — módulo puro (sin DOM ni red).
// Extrae, del response de `GetPartNumber`, las SPECS asociadas al NP y, bajo cada
// una, sus PARÁMETROS NUMÉRICOS (specField.type === 'NUMBER') con rango y unidad.
// Consumido por pn-specs-column.js (glue DOM) y por los golden tests.
//
// Por qué GetPartNumber y no AllPartNumbers (verificado 2026-07-08 contra los
// payloads reales `docs/api/Payload: *.txt`): `AllPartNumbers` (el query del
// dashboard) NO trae specs ni parámetros — sus 98 "SPEC" son texto libre en
// customInputs.NotasAdicionales. Solo `GetPartNumber` expone el árbol de specs.
// Son persisted queries (el shape lo fija el server) → sí o sí un 2º query por PN.
//
// Shapes (confirmados en el payload real, PN con spec "E27550 (Plata)"):
//   data.partNumberById
//     .partNumberSpecsByPartNumberId.nodes[]            ← specs asociadas
//        { archivedAt, specBySpecId: { id, name } }
//     .partNumberSpecFieldParamsByPartNumberId.nodes[]  ← parámetros
//        { archivedAt,                                    (node: histórico si !=null)
//          specFieldParamBySpecFieldParamId: {
//            minimumValue, maximumValue, targetValue,
//            unitByUnitId: { name },                      ("µm (micrómetro, micra)")
//            specFieldSpecBySpecFieldSpecId: {
//              specFieldBySpecFieldId: { name, type },    (type: NUMBER|BOOLEAN|DROPDOWN|TEXT)
//              specBySpecId:      { id, name } } } }
//
// GOTCHA CLAVE — archivedAt: los params vienen DUPLICADOS (5 archivados + 5 activos
// idénticos en el PN de referencia). Filtramos `node.archivedAt == null`; eso además
// deduplica. Dedup extra defensivo por (specId, fieldName, min, max, target).
(function () {
  'use strict';

  // ── Ruta: index de Part Numbers (NO la ficha /PartNumbers/:id) ──────────────
  // El index es exactamente /PartNumbers (con o sin trailing slash / query).
  // La ficha individual es /PartNumbers/<id> → ahí NO va la columna.
  const PN_INDEX_RE = /(?:^|\/)PartNumbers\/?(?:[?#]|$)/i;
  const PN_ID_RE = /\/PartNumbers\/(\d+)(?:[/?#]|$)/i;

  function isPartNumbersIndexPath(pathname) {
    if (typeof pathname !== 'string') return false;
    return PN_INDEX_RE.test(pathname);
  }

  // Extrae el partNumberId del href del link de la celda "Nombre" (/PartNumbers/<id>).
  function parsePartNumberId(href) {
    if (typeof href !== 'string') return null;
    const m = href.match(PN_ID_RE);
    return m ? parseInt(m[1], 10) : null;
  }

  // Símbolo corto de unidad: "µm (micrómetro, micra)" → "µm". Toma el primer token
  // antes de un espacio o paréntesis; conserva casing/acentos. "" si no hay unidad.
  function unitSymbol(unitName) {
    if (unitName == null) return '';
    const s = String(unitName).trim();
    if (!s) return '';
    const m = s.match(/^[^\s(]+/);
    return m ? m[0] : s;
  }

  // Número "bonito": recorta ceros de coma flotante binaria sin romper enteros.
  // `sig` = dígitos significativos (default 6). Los FACTORES de unidad usan 10 porque
  // son dato maestro y hay que verlos completos: 0.1297911062 no puede volverse 0.129791.
  // Con 10 sig también se limpia la basura de float binario (6.3933979999999995 → 6.393398).
  function fmtNum(n, sig) {
    if (n == null || n === '') return '';
    const num = Number(n);
    if (!isFinite(num)) return String(n);
    let s = num.toPrecision(sig || 6);
    if (s.indexOf('.') !== -1) s = s.replace(/\.?0+$/, '');
    // toPrecision puede meter notación científica para magnitudes extremas: acéptala.
    return s;
  }

  // Factor de unidad: mismo formateo pero con 10 significativos (ver fmtNum).
  function fmtFactor(n) { return fmtNum(n, 10); }

  // Rango legible de un parámetro numérico a partir de min/max/target + unidad.
  //   target        → "= t u"      (objetivo puntual)
  //   min && max    → "lo–hi u"
  //   min solo      → "≥ lo u"
  //   max solo      → "≤ hi u"
  //   nada          → "" (sin límites capturados)
  function formatRange(param) {
    const u = param && param.unit ? ' ' + param.unit : '';
    const has = (v) => v !== null && v !== undefined && v !== '';
    if (param && has(param.target)) return '= ' + fmtNum(param.target) + u;
    if (param && has(param.min) && has(param.max)) return fmtNum(param.min) + '–' + fmtNum(param.max) + u;
    if (param && has(param.min)) return '≥ ' + fmtNum(param.min) + u;
    if (param && has(param.max)) return '≤ ' + fmtNum(param.max) + u;
    return '';
  }

  // ── Extracción principal ────────────────────────────────────────────────────
  // Dado el response de GetPartNumber (objeto `data` o el `partNumberById` directo),
  // devuelve:
  //   { specs: [ { specId, specName, numericParams: [ { name, min, max, target, unit, range } ] } ],
  //     totalNumericParams }
  // - Solo specs ACTIVAS (node.archivedAt == null).
  // - Solo params ACTIVOS y type === 'NUMBER'.
  // - Params agrupados bajo su spec; specs sin params numéricos se incluyen vacías
  //   (el usuario quiere VER la spec aunque no tenga numéricos).
  // Fail-safe: shape inesperado → { specs: [], totalNumericParams: 0 }.
  function extractSpecsWithNumericParams(input) {
    const pn = (input && input.partNumberById) ? input.partNumberById
             : (input && input.data && input.data.partNumberById) ? input.data.partNumberById
             : input;
    if (!pn || typeof pn !== 'object') return { specs: [], totalNumericParams: 0 };

    // 1) Specs asociadas activas → mapa specId → { specId, specName, numericParams:[] }
    const specMap = new Map();
    const order = [];
    const specNodes = (pn.partNumberSpecsByPartNumberId && pn.partNumberSpecsByPartNumberId.nodes) || [];
    specNodes.forEach(function (n) {
      if (!n || n.archivedAt != null) return;                 // histórico → fuera
      const sp = n.specBySpecId; if (!sp) return;
      const id = sp.id;
      if (specMap.has(id)) return;
      // domainId + idInDomain + revisionNumber → URL de la spec (ver specUrl()).
      specMap.set(id, {
        specId: id,
        specDomainId: sp.domainId != null ? sp.domainId : null,
        specIdInDomain: sp.idInDomain != null ? sp.idInDomain : null,
        specRevision: sp.revisionNumber != null ? sp.revisionNumber : null,
        specName: sp.name || '(spec)',
        numericParams: [],
      });
      order.push(id);
    });

    // 2) Parámetros con VALOR NUMÉRICO, agrupados por spec.
    const seen = new Set();
    let total = 0;
    const paramNodes = (pn.partNumberSpecFieldParamsByPartNumberId && pn.partNumberSpecFieldParamsByPartNumberId.nodes) || [];
    paramNodes.forEach(function (n) {
      if (!n || n.archivedAt != null) return;                 // histórico → fuera
      const sfp = n.specFieldParamBySpecFieldParamId; if (!sfp) return;
      const sfs = sfp.specFieldSpecBySpecFieldSpecId; if (!sfs) return;
      const field = sfs.specFieldBySpecFieldId; if (!field) return;

      // CRITERIO (verificado con datos reales, PN 3029783): el parámetro es "numérico"
      // si su VALOR trae números — NO por el specField.type. El valLabel (specFieldParam
      // .name, lo que Steelhead muestra: "5 - 8 µm", "24 hrs.", "176 - 204 °C") contiene
      // un dígito, o hay min/max/target. Así "Tiempo s/Corrosión Blanca" (BOOLEAN, valor
      // "24 hrs." = cámara salina) SÍ sale, y "Adherencia" ("Sí o No") NO.
      const valLabel = (sfp.name || '').trim();
      const hasDigit = /\d/.test(valLabel);
      const hasNumFields = sfp.minimumValue != null || sfp.maximumValue != null || sfp.targetValue != null;
      if (!hasDigit && !hasNumFields) return;

      const spec = sfs.specBySpecId || {};
      const specId = spec.id;

      // Valor a mostrar: el valLabel legible de Steelhead cuando trae número; si no,
      // se reconstruye de min/max/target + unidad.
      const value = hasDigit ? valLabel : formatRange({
        min: sfp.minimumValue, max: sfp.maximumValue, target: sfp.targetValue,
        unit: unitSymbol(sfp.unitByUnitId && sfp.unitByUnitId.name),
      });

      const key = specId + '|' + (field.name || '') + '|' + value;
      if (seen.has(key)) return;                              // dedup
      seen.add(key);

      // FUENTE DE VERDAD = partNumberSpecs (paso 1). Si la spec del param NO está
      // en el mapa de specs ACTIVAS, el param es "huérfano" de una spec archivada
      // (Steelhead no archiva cada partNumberSpecFieldParam al archivar la spec) →
      // se ignora. Sin esto, un param activo resucitaba una spec archivada
      // (bug 48186-064-50MO: "RC Ag" archivada reaparecía por su Espesor activo).
      const bucket = specMap.get(specId);
      if (!bucket) return;

      bucket.numericParams.push({ name: field.name || '(parámetro)', value: value });
      total++;
    });

    return { specs: order.map(function (id) { return specMap.get(id); }), totalNumericParams: total };
  }

  // Texto plano compacto para la celda (fallback / tooltip / tests). El glue DOM
  // puede renderizar más rico, pero este es el contrato canónico verificable.
  //   "E27550 (Plata): Espesor 1.27–3.5 µm"
  //   varios params → separados por " · " ; varias specs → por "  |  "
  //   spec sin numéricos → "E27550 (Plata): —"
  //   nada → "—"
  function formatCellText(result) {
    const specs = (result && result.specs) || [];
    if (!specs.length) return '—';
    return specs.map(function (s) {
      const head = s.specName;
      if (!s.numericParams.length) return head + ': —';
      const parts = s.numericParams.map(function (p) {
        return p.value ? p.name + ' ' + p.value : p.name;
      });
      return head + ': ' + parts.join(' · ');
    }).join('  |  ');
  }

  // URL de la spec en Steelhead: /Domains/<domainId>/Specs/<idInDomain>/Revisions/<rev>
  // (verificado en vivo — el href real de las specs en la app; NO es /Specs/<id>).
  // Devuelve null si faltan domainId o idInDomain (→ el glue cae a texto plano).
  function specUrl(spec) {
    if (!spec || spec.specDomainId == null || spec.specIdInDomain == null) return null;
    let u = '/Domains/' + spec.specDomainId + '/Specs/' + spec.specIdInDomain + '/Revisions';
    if (spec.specRevision != null) u += '/' + spec.specRevision;
    return u;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Columnas adicionales del NP — todas salen del MISMO response de GetPartNumber
  // (verificado en vivo 2026-07-29 contra el hash 5efd689d…, PN 2300153, HTTP 200).
  // Cero consultas extra: el response pesa ~5.8 MB y ya lo estamos pagando.
  //
  //   METAL BASE   partNumberById.customInputs.DatosAdicionalesNP.BaseMetal
  //   LÍNEA        acctPnDimensionValueSelectionsByPartNumberId.nodes[]
  //                  { dimensionId: 349, dimensionCustomValueId: 154 }
  //                → el LABEL se resuelve con allAcctDimensions (nivel raíz del
  //                  response): nodes[] { id, name, type,
  //                  acctDimensionCustomValuesByDimensionId.nodes[] { id, value } }.
  //                OJO: la selección NO trae el objeto anidado
  //                `acctDimensionCustomValueByDimensionCustomValueId` (ese shape sí
  //                existe en `searchPartNumbers`, de donde lo lee pn-lifecycle-core).
  //                Aquí solo llega el id → hay que cruzarlo contra el catálogo.
  //                `load-calculator-modal` gasta un `GetDimension` extra para esto:
  //                NO hace falta, el catálogo viaja en el mismo response (30 valores
  //                de la dim 349 verificados).
  //   RACK TYPES   partNumberRackTypesByPartNumberId.nodes[]
  //                  { id, partsPerRack, rackTypeByRackTypeId { id, name,
  //                    unitByPartCountDisplayUnitId } }
  //                NO tiene campo `archivedAt` (verificado: las llaves del nodo son
  //                nodeId/id/partsPerRack/rackTypeByRackTypeId/partNumberId) → no se
  //                filtra por archivado, no existe tal estado aquí.
  //   UNIDADES     inventoryItemByPartNumberId
  //                  .inventoryItemUnitConversionsByInventoryItemId.nodes[]
  //                  { factor, unitByUnitId { id, name, mustBeInteger } }
  //                `factor` = unidades de ESA unidad por 1 PIEZA (es el mismo número
  //                que el operador captura como "X / Part" en el modal de unidades —
  //                ver unit-autoconvert-core). Comprobado: KGM 0.376 × 2.20462 =
  //                0.828937 = LBR; CMK 120.58 × 0.00107639 = 0.129791 = FTK.
  // ════════════════════════════════════════════════════════════════════════════

  const LINEA_DIM_ID_DEFAULT = 349;
  // Red de seguridad SOLO aditiva: si el id del config no aparece en el catálogo, se
  // busca la dimensión por nombre ES+EN. La estructura (el id) manda; el texto amplía.
  const LINEA_DIM_NAME_RE = /^\s*(l[ií]nea|line)\s*$/i;

  function pnRoot(input) {
    return (input && input.partNumberById) ? input.partNumberById
         : (input && input.data && input.data.partNumberById) ? input.data.partNumberById
         : input;
  }
  function dataRoot(input) {
    if (input && input.allAcctDimensions) return input;
    if (input && input.data && input.data.allAcctDimensions) return input.data;
    return input && input.data ? input.data : input;
  }

  // Metal base del NP (customInputs). '' si no está capturado.
  function extractMetalBase(input) {
    const pn = pnRoot(input);
    const ci = (pn && pn.customInputs) || {};
    const dan = ci.DatosAdicionalesNP || {};
    const v = dan.BaseMetal;
    return v == null ? '' : String(v).trim();
  }

  // Catálogo de dimensiones contables del response: [{ id, name, type, values: {id: label} }].
  function buildAcctDimensionCatalog(input) {
    const d = dataRoot(input);
    const nodes = (d && d.allAcctDimensions && d.allAcctDimensions.nodes) || [];
    return nodes.map(function (n) {
      const values = {};
      const vals = (n && n.acctDimensionCustomValuesByDimensionId && n.acctDimensionCustomValuesByDimensionId.nodes) || [];
      vals.forEach(function (v) { if (v && v.id != null) values[v.id] = v.value == null ? '' : String(v.value); });
      return { id: n && n.id, name: (n && n.name) || '', type: (n && n.type) || '', values: values };
    });
  }

  // Valor (label) de una dimensión contable para este NP. '' si el NP no la tiene
  // seleccionada o si el label no está en el catálogo (fail-safe: nunca inventa).
  function extractDimensionValue(input, dimId, nameRe) {
    const pn = pnRoot(input);
    const sels = (pn && pn.acctPnDimensionValueSelectionsByPartNumberId && pn.acctPnDimensionValueSelectionsByPartNumberId.nodes) || [];
    if (!sels.length) return '';
    const catalog = buildAcctDimensionCatalog(input);
    // 1) por ID (estructura). 2) por nombre ES+EN, solo si el id no está en el catálogo.
    let dim = catalog.find(function (c) { return c.id === dimId; });
    if (!dim && nameRe) dim = catalog.find(function (c) { return nameRe.test(c.name); });
    const targetId = dim ? dim.id : dimId;
    const sel = sels.find(function (s) { return s && s.dimensionId === targetId; });
    if (!sel || sel.dimensionCustomValueId == null) return '';
    if (dim && Object.prototype.hasOwnProperty.call(dim.values, sel.dimensionCustomValueId)) {
      return String(dim.values[sel.dimensionCustomValueId]).trim();
    }
    // El shape anidado existe en otros queries (searchPartNumbers) — si llega, úsalo.
    const nested = sel.acctDimensionCustomValueByDimensionCustomValueId;
    if (nested && nested.value != null) return String(nested.value).trim();
    return '';
  }

  function extractLinea(input, dimId) {
    return extractDimensionValue(input, dimId == null ? LINEA_DIM_ID_DEFAULT : dimId, LINEA_DIM_NAME_RE);
  }

  // Rack types del NP con su cantidad de piezas por carga. Ordenados por nombre para
  // que la celda sea estable entre corridas (el server no garantiza orden).
  //   → [ { rackTypeId, name, partsPerRack, unit } ]
  // `unit` = unidad de conteo del rack type (`unitByPartCountDisplayUnitId`); casi
  // siempre null → el consumidor asume piezas.
  function extractRackTypes(input) {
    const pn = pnRoot(input);
    const nodes = (pn && pn.partNumberRackTypesByPartNumberId && pn.partNumberRackTypesByPartNumberId.nodes) || [];
    const seen = new Set();
    const out = [];
    nodes.forEach(function (n) {
      if (!n) return;
      const rt = n.rackTypeByRackTypeId || {};
      const name = (rt.name == null ? '' : String(rt.name)).trim();
      const key = (rt.id != null ? rt.id : name) + '|' + n.partsPerRack;
      if (seen.has(key)) return;
      seen.add(key);
      const u = rt.unitByPartCountDisplayUnitId;
      out.push({
        rackTypeId: rt.id != null ? rt.id : null,
        name: name || '(rack)',
        partsPerRack: n.partsPerRack == null ? null : Number(n.partsPerRack),
        unit: u && u.name ? unitSymbol(u.name) : '',
      });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
    return out;
  }

  // Factores de unidad registrados en el item de inventario del NP.
  //   → [ { unitId, name, code, factor, mustBeInteger } ]
  // `code` = primer token del label ("KGM Kilogramo" → "KGM"). Se preservan TODOS los
  // registrados (el usuario los quiere completos); orden por código para estabilidad.
  function extractUnitFactors(input) {
    const pn = pnRoot(input);
    const ii = pn && pn.inventoryItemByPartNumberId;
    const nodes = (ii && ii.inventoryItemUnitConversionsByInventoryItemId && ii.inventoryItemUnitConversionsByInventoryItemId.nodes) || [];
    const seen = new Set();
    const out = [];
    nodes.forEach(function (n) {
      if (!n) return;
      const u = n.unitByUnitId || {};
      const name = (u.name == null ? '' : String(u.name)).trim();
      const code = unitSymbol(name);
      const id = u.id != null ? u.id : null;
      const key = (id != null ? id : code) + '';
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        unitId: id,
        name: name,
        code: code,
        factor: n.factor == null ? null : Number(n.factor),
        mustBeInteger: u.mustBeInteger === true,
      });
    });
    out.sort(function (a, b) { return a.code.localeCompare(b.code, 'es'); });
    return out;
  }

  // Extracción única por NP: un solo recorrido del response para TODAS las columnas.
  // `opts.lineaDimId` viene de config.steelhead.domain.dimensionIds.linea.
  function extractPnRow(input, opts) {
    const o = opts || {};
    const specs = extractSpecsWithNumericParams(input);
    return {
      specs: specs.specs,
      totalNumericParams: specs.totalNumericParams,
      metal: extractMetalBase(input),
      linea: extractLinea(input, o.lineaDimId),
      rackTypes: extractRackTypes(input),
      units: extractUnitFactors(input),
    };
  }

  // Contratos de texto plano (celda / tooltip / tests).
  //   "T102-RA02: 18 · T107-FL01: 54"   → cantidad = piezas por carga
  function formatRackTypesText(racks) {
    const list = racks || [];
    if (!list.length) return '—';
    return list.map(function (r) {
      const qty = r.partsPerRack == null ? '?' : fmtNum(r.partsPerRack);
      const u = r.unit ? ' ' + r.unit : '';
      return r.name + ': ' + qty + u;
    }).join(' · ');
  }

  //   "CMK: 120.58 · KGM: 0.376"   → factor = unidades por PIEZA
  function formatUnitFactorsText(units) {
    const list = units || [];
    if (!list.length) return '—';
    return list.map(function (u) {
      return (u.code || u.name) + ': ' + (u.factor == null ? '?' : fmtFactor(u.factor));
    }).join(' · ');
  }

  const api = {
    PN_INDEX_RE,
    PN_ID_RE,
    LINEA_DIM_ID_DEFAULT,
    LINEA_DIM_NAME_RE,
    isPartNumbersIndexPath,
    parsePartNumberId,
    unitSymbol,
    fmtNum,
    fmtFactor,
    formatRange,
    extractSpecsWithNumericParams,
    formatCellText,
    specUrl,
    extractMetalBase,
    buildAcctDimensionCatalog,
    extractDimensionValue,
    extractLinea,
    extractRackTypes,
    extractUnitFactors,
    extractPnRow,
    formatRackTypesText,
    formatUnitFactorsText,
  };
  if (typeof window !== 'undefined') window.PnSpecsColumnCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
