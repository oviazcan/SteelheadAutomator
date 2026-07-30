// Filtrar Lote por Nombre — módulo puro (sin DOM ni red).
// Resuelve el filtro "Lote de Inventario" del Panel de Envío (/Domains/<id>/Shipping)
// para poder seleccionar TODOS los lotes con el MISMO nombre de un jalón, en vez de
// clic-earlos uno por uno (el filtro nativo identifica cada lote por su id de BD, opaco).
//
// Mecanismo confirmado EN VIVO (2026-07-21, Ecoplating TLC dom 344, read-only):
//   · El panel filtra por URL:  ?inventoryBatchIdFilter=<dbId>,<dbId>,...&offset=0
//     → SH deriva los chips ("#<idInDomain> - <name>") y filtra SOLO de la URL.
//   · El mapeo name→dbIds lo da la persisted query FilterSearch:
//       operationName: 'FilterSearch'
//       variables:     { key: 'inventoryBatchIdFilter', searchQuery: <texto> }
//       hash:          1cdd9e39a0ac44d491910f8c1727154d6859fd2eabe49d619f06d54e926d2bc9
//       → data.tableFilterSearch: [{ display, identifier }]
//     donde `identifier` ES el dbId que va a inventoryBatchIdFilter, y
//           `display` = "<idInDomain><name> (<pn>)"  (SIN separador entre idInDomain y name).
//   · FilterSearch limita a 10 resultados y NO pagina (offset ignorado) — mismo tope que
//     el popover nativo. Si devuelve 10, puede haber más → `atLimit` avisa al glue.
//
// El name puede ser NUMÉRICO (p.ej. "487577"), así que NO se puede separar idInDomain del
// name por parseo ingenuo. matchesExactName ancla el name como sufijo precedido de los
// dígitos del idInDomain: /^\d+<name>$/ sobre el display sin el sufijo " (pn)". Eso distingue
// "T-125" de "T-1250" y de substrings. (La colisión residual con nombres puramente numéricos
// es improbable y el glue la mitiga con un preview de confirmación.)
(function () {
  'use strict';

  // ── Constantes de dominio ──
  const FILTER_SEARCH_OP = 'FilterSearch';
  const FILTER_KEY = 'inventoryBatchIdFilter';   // `key` de FilterSearch (texto plano, estable)
  const URL_PARAM = 'inventoryBatchIdFilter';     // parámetro de la URL del panel
  const FILTER_SEARCH_HASH = '1cdd9e39a0ac44d491910f8c1727154d6859fd2eabe49d619f06d54e926d2bc9';
  const FILTER_SEARCH_LIMIT = 10;                 // tope duro de FilterSearch (fuente LEGADA, ver abajo)
  // Fuente PREFERIDA: InventoryBatchViewQuery — pagina de verdad (first/offset, sin tope de 10)
  // y devuelve el `name` ESTRUCTURADO (no concatenado) → matching exacto trivial y robusto.
  // Variables: {includeArchived:'NO', hideCompleted:true, orderBy:['CREATED_AT_DESC'], offset, first, searchQuery}
  //   · hideCompleted:true en producción: en Packing Slips/Scheduling los lotes COMPLETADOS no se
  //     pueden filtrar (no muestran piezas listas), así que traerlos es inútil + menos eficiente.
  //     (La prueba del tope usó hideCompleted:false para ver 18 T-125 vs los 10 de FilterSearch.)
  //   · searchQuery filtra por substring del name → se refina a exacto en cliente (name estructurado).
  // Respuesta: data.pagedData.{ totalCount, nodes:[{ id(=dbId), idInDomain, name }] }.
  const INVENTORY_BATCH_VIEW_OP = 'InventoryBatchViewQuery';
  const INVENTORY_BATCH_VIEW_HASH = 'e4fc4cdf098f41e10881a512e63ce6fb068bcd8d5bd57b8627c86e5fda025d44';
  const INVENTORY_BATCH_VIEW_PAGE = 200;

  // ── LOS DOS UNIVERSOS de `hideCompleted` (medido en vivo 2026-07-29, dominio 344) ──
  // El nombre del parámetro MIENTE. No es "esconder los completados" (con `false` de
  // superconjunto): es un SELECTOR DE UNIVERSO EXCLUYENTE.
  //
  //   hideCompleted:true  → SOLO lotes CON material remanente   →    585 lotes
  //   hideCompleted:false → SOLO lotes AGOTADOS (remaining = 0) → 12 926 lotes
  //   solape medido = 0 · unión = 13 511 = TODO el inventario del dominio
  //
  // Consultar solo con `true` (lo que hacía el applet hasta 0.2.1) esconde el 95.7%
  // de los lotes: el operador teclea un lote que EXISTE —el dropdown nativo de SH sí
  // lo ofrece—, el applet responde «Sin lotes «X»» y Enter no hace nada. El síntoma
  // aparecía con el tiempo, no de golpe: un lote recién creado está en el universo
  // CON MATERIAL y se muda al de AGOTADOS al consumirse, así que el applet solo
  // funcionaba con lotes frescos (por eso su validación del 2026-07-22 pasó).
  // → Se consultan AMBOS y se unen; el preview distingue cuáles están agotados.
  const UNIVERSE_WITH_MATERIAL = true;
  const UNIVERSE_DEPLETED = false;
  const SEARCH_UNIVERSES = [UNIVERSE_WITH_MATERIAL, UNIVERSE_DEPLETED];

  // ── Guardarraíl de volumen ──
  // El `/graphql` de la sesión se CUELGA bajo ráfaga (~40-45 requests, sin 429 ni
  // error, y tumba la pantalla NATIVA del operador — incidente medido en
  // po-listing-filters). Duplicar el universo duplica el tráfico, así que la
  // amplitud de la búsqueda se acota ANTES de tocar la red:
  //   · searchQuery:'T'   → 12 793 lotes (medido) ⇒ mínimo de caracteres.
  //   · searchQuery:'T-1' →  1 009 lotes (medido) ⇒ tope por totalCount.
  const MIN_QUERY_CHARS = 2;
  // El tope nació en 600 y subió a 1600 el 2026-07-29, al entender el modelo de dominio:
  // los lotes VACÍOS no son un residuo raro, se ACUMULAN HISTÓRICAMENTE (todo lote que pasa
  // a OT queda vacío para siempre), así que un nombre reutilizado por años junta cientos y
  // un tope bajo cortaba búsquedas legítimas. 1600 = 8 páginas × 200 por universo ⇒ 16
  // requests en el peor caso, bien por debajo de las ~40-45 que cuelgan la sesión.
  // Sigue habiendo tope porque cuando el substring trae MUCHO más de lo paginable, el
  // subconjunto de nombre exacto queda incompleto de forma IMPREDECIBLE (el orden es
  // CREATED_AT_DESC, no por relevancia) — y un resultado silenciosamente parcial es peor
  // que pedir un nombre más específico.
  const MAX_TOTAL_TO_PAGE = 1600;     // > esto ⇒ tooBroad (no se pagina)
  const MAX_PAGES_PER_UNIVERSE = 8;   // cap duro; si se alcanza se REPORTA (capped)
  const SHIPPING_URL_RE = /^\/Domains\/\d+\/Shipping\/?(?:[?#]|$)/; // Panel de Envío, NO /Shipping/PackingSlips

  function isShippingUrl(pathname) {
    return SHIPPING_URL_RE.test(String(pathname == null ? '' : pathname));
  }

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function dedup(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
    return out;
  }

  // "15326T-125 (80247-566-01)" → "15326T-125"  (quita el ÚLTIMO paréntesis = el pn)
  function stripPnSuffix(display) {
    return String(display == null ? '' : display).replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  // ¿El `display` corresponde a un lote cuyo NAME es EXACTAMENTE targetName?
  // combined = "<idInDomain><name>"; el name es el sufijo tras los dígitos del idInDomain.
  function matchesExactName(display, targetName) {
    const name = String(targetName == null ? '' : targetName).trim();
    if (!name) return false;
    const combined = stripPnSuffix(display);
    if (!combined) return false;
    const re = new RegExp('^\\d+' + escapeRegex(name) + '$', 'i'); // case-insensitive: el operador no recuerda el case exacto
    return re.test(combined);
  }

  // Filtra los items de FilterSearch a los que tienen el name exacto y junta sus dbIds.
  // items: [{ display, identifier }]  (crudo de tableFilterSearch)
  // → { matches:[{display,identifier}], ids:[dbId], count, atLimit }
  function selectExactMatches(items, targetName) {
    const arr = Array.isArray(items) ? items : [];
    const matches = arr.filter((it) => it && matchesExactName(it.display, targetName));
    const ids = dedup(matches.map((m) => String(m.identifier)).filter(Boolean));
    return { matches, ids, count: ids.length, atLimit: arr.length >= FILTER_SEARCH_LIMIT };
  }

  // ── Fuente PREFERIDA (InventoryBatchViewQuery): matching por name ESTRUCTURADO ──
  function normalizeName(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  // ¿El lote está VACÍO (sin material remanente)?  true / false / null(desconocido).
  //
  // OJO CON LA LECTURA: vacío NO es un defecto ni una anomalía. Un lote es un CONTENEDOR y
  // Steelhead lo VACÍA al convertirlo a OT (su contenido pasa a la orden), así que
  // `remaining = 0` es el estado NORMAL de todo lote que ya siguió su curso — y ahí el lote
  // sigue sirviendo como REFERENCIA, que es justo para lo que se busca en el Panel de Envío.
  // Lo EXCEPCIONAL es `false`: conserva material porque no se pasó a OT, o no completo.
  // La UI marca esa excepción, nunca la norma (por eso se retiró el aviso de "todos vacíos").
  //
  // Fail-safe deliberado: si el campo NO viene, se devuelve null — nunca `true`. Dar por
  // vacío un lote cuyo dato falta es afirmar sin evidencia; el mismo error de forma que
  // asumir 1 pieza por carga cuando `partsPerRack` no existe.
  function isDepletedBatch(node) {
    if (!node) return null;
    const v = node.totalRemainingMicroQuantity;
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n === 0;
  }

  function bucket(matches) {
    const ids = dedup(matches.map((m) => String(m.id)).filter(Boolean));
    return { matches, ids, count: ids.length };
  }

  // nodes: pagedData.nodes = [{ id, idInDomain, name, totalRemainingMicroQuantity }]
  // → dbIds de los que tienen name EXACTO.
  // searchQuery ya filtró por substring server-side; aquí exigimos igualdad exacta del name
  // (limpio, sin idInDomain pegado) → sin regex ni colisión numérica.
  // `ids`/`count` son SIEMPRE el total (con material + agotados + desconocidos): el
  // operador aplica lo mismo que podría clic-ear a mano en el dropdown nativo. Los
  // sub-buckets existen para que el PREVIEW diga la verdad, no para recortar el filtro.
  function selectByExactName(nodes, targetName) {
    const empty = { matches: [], ids: [], count: 0 };
    if (!normalizeName(targetName)) {
      return Object.assign({}, empty, { withMaterial: bucket([]), depleted: bucket([]), unknown: bucket([]) });
    }
    const target = normalizeName(targetName);
    const arr = Array.isArray(nodes) ? nodes : [];
    const matches = arr.filter((n) => n && normalizeName(n.name) === target);
    const withMaterial = [], depleted = [], unknown = [];
    for (const m of matches) {
      const d = isDepletedBatch(m);
      (d === true ? depleted : d === false ? withMaterial : unknown).push(m);
    }
    const ids = dedup(matches.map((m) => String(m.id)).filter(Boolean));
    return {
      matches, ids, count: ids.length,
      withMaterial: bucket(withMaterial), depleted: bucket(depleted), unknown: bucket(unknown),
    };
  }

  // (Aquí vivía `shouldWarnAllDepleted`, que alimentaba un aviso «los N están agotados, al
  // aplicar la lista saldrá vacía». Se RETIRÓ el 2026-07-29: anunciaba como problema lo que
  // es el curso NORMAL de un lote —Steelhead lo vacía al convertirlo a OT— y en el Panel de
  // Envío la mayoría de los lotes buscados están así, así que el aviso salía casi siempre.
  // La UI marca ahora la EXCEPCIÓN, el lote que AÚN tiene material. Ver el bloque de
  // isDepletedBatch y la bitácora §0.3.1.)

  // Decisión PURA de si vale la pena tocar la red, antes de hacerlo.
  function planSearch(rawName) {
    const name = String(rawName == null ? '' : rawName).trim();
    if (name.length < MIN_QUERY_CHARS) return { ok: false, reason: 'too-short', name, minChars: MIN_QUERY_CHARS };
    return { ok: true, name, universes: SEARCH_UNIVERSES.slice() };
  }

  // Cuántas páginas pedir para un universo, dado su totalCount. `tooBroad` corta ANTES
  // de paginar; `capped` se REPORTA (truncar en silencio se lee como "los cubrí todos").
  function planPagination(totalCount, pageSize, opts) {
    const o = opts || {};
    const maxTotal = o.maxTotal == null ? MAX_TOTAL_TO_PAGE : o.maxTotal;
    const maxPages = o.maxPages == null ? MAX_PAGES_PER_UNIVERSE : o.maxPages;
    const total = Number(totalCount) || 0;
    const size = Number(pageSize) || INVENTORY_BATCH_VIEW_PAGE;
    if (total <= 0) return { pages: 0, capped: false, tooBroad: false };
    if (total > maxTotal) return { pages: 0, capped: false, tooBroad: true };
    const natural = Math.ceil(total / size);
    return { pages: Math.min(natural, maxPages), capped: natural > maxPages, tooBroad: false };
  }

  // Lee los dbIds actuales del parámetro inventoryBatchIdFilter de una URL.
  function parseInventoryBatchIdFilter(url) {
    try {
      const u = new URL(url);
      const v = u.searchParams.get(URL_PARAM);
      return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  // Construye la URL de filtro. mode 'replace' (default) deja solo dbIds; 'append' hace unión
  // con lo ya filtrado. Siempre resetea offset=0 y preserva los demás parámetros.
  function buildFilterUrl(currentUrl, dbIds, mode) {
    const u = new URL(currentUrl);
    const incoming = (Array.isArray(dbIds) ? dbIds : []).map(String).filter(Boolean);
    const existing = mode === 'append' ? parseInventoryBatchIdFilter(currentUrl) : [];
    const merged = dedup([...existing, ...incoming]);
    if (merged.length) u.searchParams.set(URL_PARAM, merged.join(','));
    else u.searchParams.delete(URL_PARAM);
    u.searchParams.set('offset', '0');
    // Coma literal (como el nativo) en vez de %2C — SH acepta ambas, pero así queda idéntico.
    return u.toString().replace(/%2C/gi, ',');
  }

  // URL para LIMPIAR el filtro de lote (quita el parámetro, resetea offset).
  function buildClearUrl(currentUrl) {
    const u = new URL(currentUrl);
    u.searchParams.delete(URL_PARAM);
    u.searchParams.set('offset', '0');
    return u.toString();
  }

  const api = {
    FILTER_SEARCH_OP, FILTER_KEY, URL_PARAM, FILTER_SEARCH_HASH, FILTER_SEARCH_LIMIT,
    INVENTORY_BATCH_VIEW_OP, INVENTORY_BATCH_VIEW_HASH, INVENTORY_BATCH_VIEW_PAGE,
    UNIVERSE_WITH_MATERIAL, UNIVERSE_DEPLETED, SEARCH_UNIVERSES,
    MIN_QUERY_CHARS, MAX_TOTAL_TO_PAGE, MAX_PAGES_PER_UNIVERSE,
    SHIPPING_URL_RE,
    isShippingUrl, escapeRegex, dedup, stripPnSuffix, matchesExactName, normalizeName,
    isDepletedBatch, planSearch, planPagination,
    selectExactMatches, selectByExactName, parseInventoryBatchIdFilter, buildFilterUrl, buildClearUrl,
  };
  if (typeof window !== 'undefined') window.BatchNameFilterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
