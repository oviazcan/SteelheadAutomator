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
  function fmtNum(n) {
    if (n == null || n === '') return '';
    const num = Number(n);
    if (!isFinite(num)) return String(n);
    // Redondea a 6 significativos y quita ceros de cola.
    let s = num.toPrecision(6);
    if (s.indexOf('.') !== -1) s = s.replace(/\.?0+$/, '');
    // toPrecision puede meter notación científica para magnitudes extremas: acéptala.
    return s;
  }

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

  const api = {
    PN_INDEX_RE,
    PN_ID_RE,
    isPartNumbersIndexPath,
    parsePartNumberId,
    unitSymbol,
    fmtNum,
    formatRange,
    extractSpecsWithNumericParams,
    formatCellText,
    specUrl,
  };
  if (typeof window !== 'undefined') window.PnSpecsColumnCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
