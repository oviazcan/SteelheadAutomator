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
  const FILTER_SEARCH_LIMIT = 10;                 // tope duro observado de FilterSearch
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
    SHIPPING_URL_RE,
    isShippingUrl, escapeRegex, dedup, stripPnSuffix, matchesExactName,
    selectExactMatches, parseInventoryBatchIdFilter, buildFilterUrl, buildClearUrl,
  };
  if (typeof window !== 'undefined') window.BatchNameFilterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
