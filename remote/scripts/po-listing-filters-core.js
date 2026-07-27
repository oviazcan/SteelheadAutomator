// Buscador global de OC + Toggle de empresa — módulo puro (sin DOM ni red).
//
// Resuelve dos huecos de la pantalla /Domains/<d>/Purchasing/PurchaseOrders, ambos
// verificados EN VIVO (dominio 344, 2026-07-27, read-only):
//
//   1) La pantalla está partida en 5 vistas (Draft / Issued·Open / Issued·Closed /
//      Fulfilled·Open / Fulfilled·Closed) y el buscador nativo solo mira la vista actual.
//      Peor: su `searchQuery` NO busca por proveedor — 'ATOTECH' devuelve 0 resultados
//      aunque existe la OC #1873 de "ATOTECH DE MEXICO". Solo matchea el PO#.
//      → El proveedor solo es alcanzable por el filtro `vendorIdFilter`, que es otro control.
//
//   2) El filtro "Dirección de Facturación" es single-select en la UI, así que no deja
//      seleccionar Ecoplating y el dominio de un jalón. PERO la variable
//      `billToLocationIdFilter` es un ARRAY con semántica OR — verificado:
//        [Ecoplating]=0, [Proquipa]=50, [Ecoplating,Proquipa]=50  (la UNIÓN, no la intersección).
//      → La limitación es de la UI, no del backend. Por eso el toggle es viable.
//
// Las direcciones se nombran ANIDADAS por punto ("Ecoplating.N2.A2") y la RAÍZ del path
// define la empresa. NO se hardcodean ids: el glue las descubre en runtime con FilterSearch
// (que topa en 10 resultados por consulta → sondas múltiples) y este módulo las agrupa.
(function () {
  'use strict';

  // ── Gate de pantalla ──
  const PO_URL_RE = /^\/Domains\/\d+\/Purchasing\/PurchaseOrders\/?(?:[?#]|$)/;

  function isPurchaseOrdersUrl(pathname) {
    return PO_URL_RE.test(String(pathname == null ? '' : pathname));
  }

  function domainIdFromPath(pathname) {
    const m = /^\/Domains\/(\d+)\//.exec(String(pathname == null ? '' : pathname));
    return m ? m[1] : null;
  }

  // ── Las 5 vistas ──
  // `queryVars` son las variables EXACTAS que manda el front (capturadas del sniffer).
  // OJO con Draft: manda `issuedAt:true` (no `draftCondition`) — nombre contraintuitivo
  // del backend, significa "sin issuedAt". No lo renombres.
  const PO_CATEGORIES = [
    {
      key: 'draft',
      label: 'Borrador',
      labelEn: 'Draft',
      urlParams: { category: 'Draft' },
      queryVars: { issuedAt: true, fulfilledCondition: false },
    },
    {
      key: 'issued-open',
      label: 'Emitida · Abierta',
      labelEn: 'Issued · Open',
      urlParams: { category: 'Issued' },
      queryVars: { issuedCondition: true, billingOpen: true },
    },
    {
      key: 'issued-closed',
      label: 'Emitida · Cerrada',
      labelEn: 'Issued · Closed',
      urlParams: { category: 'Issued', billing: 'Closed' },
      queryVars: { issuedCondition: true, billingOpen: false },
    },
    {
      key: 'fulfilled-open',
      label: 'Surtida · Abierta',
      labelEn: 'Fulfilled · Open',
      urlParams: { category: 'Fulfilled', billing: 'Open' },
      queryVars: { fulfilledCondition: true, billingOpen: true },
    },
    {
      key: 'fulfilled-closed',
      label: 'Surtida · Cerrada',
      labelEn: 'Fulfilled · Closed',
      urlParams: { category: 'Fulfilled', billing: 'Closed' },
      queryVars: { fulfilledCondition: true, billingOpen: false },
    },
  ];

  function categoryByKey(key) {
    return PO_CATEGORIES.find((c) => c.key === key) || null;
  }

  // ¿En qué vista estoy? Sin `category` la pantalla cae en Draft (verificado en vivo).
  function parseCategoryFromUrl(url) {
    let cat = null;
    let billing = null;
    try {
      const u = new URL(url, 'https://x.invalid');
      cat = u.searchParams.get('category');
      billing = u.searchParams.get('billing');
    } catch (_) { /* url basura → default */ }
    if (!cat || cat === 'Draft') return 'draft';
    const closed = billing === 'Closed';
    if (cat === 'Issued') return closed ? 'issued-closed' : 'issued-open';
    if (cat === 'Fulfilled') return closed ? 'fulfilled-closed' : 'fulfilled-open';
    return 'draft';
  }

  // `new URL(rel, BASE)` necesita una base, pero devolver `u.toString()` PEGA esa base
  // ficticia al resultado y produce enlaces a https://x.invalid/… (bug del deploy 1.7.205:
  // clicar un resultado sacaba al operador de Steelhead a un host muerto). Si la entrada era
  // relativa, el resultado DEBE volver relativo.
  const URL_BASE = 'https://x.invalid';
  function isAbsoluteUrl(url) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url == null ? '' : url));
  }
  function serializeUrl(u, absolute) {
    const s = absolute ? u.toString() : (u.pathname + u.search + u.hash);
    return s.replace(/%2C/gi, ','); // coma literal, como el nativo
  }

  function buildCategoryUrl(baseUrl, categoryKey, extraParams) {
    const cat = categoryByKey(categoryKey);
    const absolute = isAbsoluteUrl(baseUrl);
    const u = new URL(baseUrl, URL_BASE);
    // Limpia los ejes de vista antes de escribir los nuevos (evita ?billing residual).
    u.searchParams.delete('category');
    u.searchParams.delete('billing');
    if (cat) {
      for (const [k, v] of Object.entries(cat.urlParams)) u.searchParams.set(k, v);
    }
    for (const [k, v] of Object.entries(extraParams || {})) {
      if (v == null || v === '') u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    u.searchParams.set('offset', '0');
    return serializeUrl(u, absolute);
  }

  // ── Empresas / direcciones de facturación ──
  const URL_PARAM_BILL_TO = 'billToLocationIdFilter';
  const FILTER_KEY_BILL_TO = 'billToLocationIdFilter';
  const FILTER_KEY_VENDOR = 'vendorIdFilter';
  const FILTER_SEARCH_LIMIT = 10; // tope duro de FilterSearch (devuelve 10 y no pagina)

  // Config por defecto. `dominio` cuenta como Ecoplating: decisión del usuario
  // ("PlantaToluca sería equivalente a dominio, por tanto equivalente a Ecoplating").
  const DEFAULT_COMPANY_CONFIG = {
    ecoplating: ['Ecoplating', 'PlantaToluca'],
    proquipa: ['Proquipa'],
  };

  // 'Ecoplating.N2.A2' → 'Ecoplating'.  Las ubicaciones de Steelhead están ANIDADAS y la
  // raíz del path es la empresa; por eso se corta en el primer punto y no se hace prefix-match
  // ingenuo (que confundiría 'Ecoplating' con un hipotético 'EcoplatingOtra').
  function rootLocationName(display) {
    const s = String(display == null ? '' : display).trim();
    if (!s) return '';
    return s.split('.')[0].trim();
  }

  function normalize(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  // display → 'ecoplating' | 'proquipa' | 'otra'
  function companyOfLocation(display, config) {
    const cfg = config || DEFAULT_COMPANY_CONFIG;
    const root = normalize(rootLocationName(display));
    if (!root) return 'otra';
    for (const company of Object.keys(cfg)) {
      const roots = (cfg[company] || []).map(normalize);
      if (roots.includes(root)) return company;
    }
    return 'otra';
  }

  // items: [{display, identifier}] crudo de FilterSearch (posiblemente de varias sondas).
  // → {ecoplating:[ids], proquipa:[ids], otras:[{display,identifier}], all:[ids]}
  // Dedup por identifier: las sondas múltiples repiten resultados a propósito.
  function groupLocationsByCompany(items, config) {
    const arr = Array.isArray(items) ? items : [];
    const seen = new Set();
    const out = { ecoplating: [], proquipa: [], otras: [], all: [] };
    for (const it of arr) {
      if (!it || it.identifier == null) continue;
      const id = String(it.identifier);
      if (seen.has(id)) continue;
      seen.add(id);
      out.all.push(id);
      const company = companyOfLocation(it.display, config);
      if (company === 'ecoplating') out.ecoplating.push(id);
      else if (company === 'proquipa') out.proquipa.push(id);
      else out.otras.push({ display: it.display, identifier: id });
    }
    return out;
  }

  // ── Estrategia del toggle ──
  // El lado Ecoplating es "todo lo que NO es Proquipa" (las OCs sin dirección cuentan como
  // Ecoplating, por decisión del usuario). `IN (…)` no expresa NULL ni negación, así que la
  // estrategia se DECIDE EN RUNTIME según lo que el glue haya podido medir:
  //
  //   coverage = { allCovered:boolean, nullAccepted:boolean, orphanCount:number|null }
  //
  //   · allCovered   → no hay OCs huérfanas → filtro nativo puro.
  //   · nullAccepted → el server acepta null dentro del array → filtro nativo + null.
  //   · si no        → 'annotate': filtra lo que sabe y AVISA; nunca esconde OCs por un dato
  //                    que no pudo resolver (fail-safe).
  const MODES = { ECOPLATING: 'ecoplating', BOTH: 'both', PROQUIPA: 'proquipa' };

  function planCompanyFilter(mode, groups, coverage) {
    const g = groups || { ecoplating: [], proquipa: [], otras: [], all: [] };
    const cov = coverage || {};

    if (mode === MODES.BOTH) return { kind: 'clear', ids: [] };

    if (mode === MODES.PROQUIPA) {
      // Sin ambigüedad: Proquipa es exactamente sus direcciones.
      if (!g.proquipa.length) return { kind: 'unavailable', reason: 'sin-direcciones-proquipa' };
      return { kind: 'filter', ids: g.proquipa.slice() };
    }

    if (mode === MODES.ECOPLATING) {
      if (!g.ecoplating.length && !cov.allCovered) {
        return { kind: 'unavailable', reason: 'sin-direcciones-ecoplating' };
      }
      if (cov.allCovered) return { kind: 'filter', ids: g.ecoplating.slice() };
      if (cov.nullAccepted) return { kind: 'filter', ids: g.ecoplating.concat([null]) };
      return {
        kind: 'annotate',
        ids: g.ecoplating.slice(),
        hiddenIds: g.proquipa.slice(),
        orphanCount: cov.orphanCount == null ? null : cov.orphanCount,
      };
    }

    return { kind: 'clear', ids: [] };
  }

  // Escribe (o limpia) el parámetro de dirección de facturación. `null` dentro de ids se
  // serializa como la cadena vacía entre comas, que es como el server lo interpreta cuando
  // acepta huérfanas; si no lo acepta, esa rama nunca se elige (ver planCompanyFilter).
  function buildCompanyFilterUrl(currentUrl, ids) {
    const absolute = isAbsoluteUrl(currentUrl);
    const u = new URL(currentUrl, URL_BASE);
    const list = (Array.isArray(ids) ? ids : []).map((x) => (x == null ? '' : String(x)));
    if (list.length) u.searchParams.set(URL_PARAM_BILL_TO, list.join(','));
    else u.searchParams.delete(URL_PARAM_BILL_TO);
    u.searchParams.set('offset', '0');
    return serializeUrl(u, absolute);
  }

  function parseBillToFilter(url) {
    try {
      const u = new URL(url, 'https://x.invalid');
      const v = u.searchParams.get(URL_PARAM_BILL_TO);
      return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  // Refleja el estado del toggle al recargar: compara el parámetro contra los grupos.
  // Sin parámetro → centro. Coincide con Proquipa → derecha. Cualquier otra cosa que
  // incluya alguna de Ecoplating → izquierda. Un set ajeno (filtro puesto a mano) → centro.
  function parseCompanyModeFromUrl(url, groups) {
    const ids = parseBillToFilter(url);
    if (!ids.length) return MODES.BOTH;
    const g = groups || { ecoplating: [], proquipa: [] };
    const setIds = new Set(ids);
    const eco = (g.ecoplating || []).map(String);
    const pro = (g.proquipa || []).map(String);
    const hasEco = eco.some((id) => setIds.has(id));
    const hasPro = pro.some((id) => setIds.has(id));
    if (hasPro && !hasEco) return MODES.PROQUIPA;
    if (hasEco && !hasPro) return MODES.ECOPLATING;
    return MODES.BOTH;
  }

  // ── Clasificación de resultados del buscador global ──
  const RESULT_TYPES = { PO: 'PO', VENDOR: 'VENDOR', BILL: 'BILL' };

  // FilterSearch de vendors devuelve display "#6 - ATOTECH DE MEXICO" (idInDomain + nombre).
  // Se parte para poder mostrar el número aparte sin re-consultar.
  function parseVendorDisplay(display) {
    const s = String(display == null ? '' : display).trim();
    const m = /^#(\d+)\s*-\s*(.*)$/.exec(s);
    if (m) return { idInDomain: m[1], name: m[2].trim() };
    return { idInDomain: null, name: s };
  }

  // raw = { vendors:[{display,identifier}], poByCategory:{<key>:[node]}, bills:[node] }
  // → lista plana ordenada: proveedores, luego OCs (en el orden de PO_CATEGORIES), luego bills.
  function classifyResults(raw) {
    const r = raw || {};
    const out = [];

    for (const v of (r.vendors || [])) {
      if (!v || v.identifier == null) continue;
      const parsed = parseVendorDisplay(v.display);
      out.push({
        type: RESULT_TYPES.VENDOR,
        id: String(v.identifier),
        idInDomain: parsed.idInDomain,
        label: parsed.name,
      });
    }

    for (const cat of PO_CATEGORIES) {
      const nodes = (r.poByCategory || {})[cat.key] || [];
      for (const n of nodes) {
        if (!n) continue;
        out.push({
          type: RESULT_TYPES.PO,
          id: n.id == null ? null : String(n.id),
          idInDomain: n.idInDomain == null ? null : String(n.idInDomain),
          label: 'OC ' + (n.idInDomain == null ? '?' : n.idInDomain),
          vendorName: (n.vendorByVendorId && n.vendorByVendorId.name) || null,
          categoryKey: cat.key,
          categoryLabel: cat.label,
          stage: (n.currentStage && n.currentStage.name) || null,
        });
      }
    }

    for (const b of (r.bills || [])) {
      if (!b) continue;
      out.push({
        type: RESULT_TYPES.BILL,
        id: b.id == null ? null : String(b.id),
        idInDomain: b.idInDomain == null ? null : String(b.idInDomain),
        label: 'Factura ' + (b.idInDomain == null ? '?' : b.idInDomain),
        vendorName: (b.vendorByVendorId && b.vendorByVendorId.name) || null,
        poIdInDomain: b.purchaseOrderByPurchaseOrderId
          ? String(b.purchaseOrderByPurchaseOrderId.idInDomain)
          : null,
      });
    }

    return out;
  }

  // Dedup de OCs que aparecen en varias vistas por el fan-out (no debería pasar — las 5 vistas
  // son disjuntas — pero el fan-out por vendorIdFilter + searchQuery sí puede repetir dentro
  // de la misma vista).
  function dedupeResults(results) {
    const seen = new Set();
    const out = [];
    for (const r of (results || [])) {
      const k = r.type + ':' + (r.id || r.idInDomain || r.label);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  function buildResultHref(result, domainId, baseUrl) {
    if (!result || !domainId) return null;
    if (result.type === RESULT_TYPES.PO) {
      const base = baseUrl || ('/Domains/' + domainId + '/Purchasing/PurchaseOrders');
      return buildCategoryUrl(base, result.categoryKey, { searchQuery: result.idInDomain });
    }
    if (result.type === RESULT_TYPES.BILL) {
      return '/Domains/' + domainId + '/Bills?searchQuery=' + encodeURIComponent(result.idInDomain || '');
    }
    if (result.type === RESULT_TYPES.VENDOR) {
      const base = baseUrl || ('/Domains/' + domainId + '/Purchasing/PurchaseOrders');
      return buildCategoryUrl(base, 'issued-open', { vendorIdFilter: result.id });
    }
    return null;
  }

  // Agrupa la lista plana para el render por secciones.
  function groupResultsForRender(results) {
    const list = dedupeResults(results);
    return {
      vendors: list.filter((r) => r.type === RESULT_TYPES.VENDOR),
      pos: list.filter((r) => r.type === RESULT_TYPES.PO),
      bills: list.filter((r) => r.type === RESULT_TYPES.BILL),
      total: list.length,
    };
  }

  // ── Presupuesto de consultas por búsqueda ──
  //
  // El /graphql de SH se cae alrededor de las 40 requests y NO se recupera recargando:
  // tumba la pantalla nativa completa, no solo al applet (visto en vivo 2026-07-27).
  // Por eso el fan-out está ACOTADO y es un invariante testeado, no una casualidad.
  //
  // Diseño: 5 vistas (searchQuery) + 1 de facturas + 1 de proveedores = 7 por búsqueda.
  // NO se hace un segundo fan-out de 5 vistas por `vendorIdFilter` — eso llevaría a 12 y
  // con 3-4 búsquedas seguidas el operador tumba su propia pantalla. El proveedor se
  // entrega como resultado CLICKEABLE que lleva a sus OCs (buildResultHref), así que el
  // valor se conserva: encuentras al proveedor que el buscador nativo esconde y de un
  // clic ves sus órdenes, pagando 1 consulta en vez de 5.
  const MAX_QUERIES_PER_SEARCH = 7;

  // Plan declarativo de lo que se va a consultar. Devuelve descriptores, no promesas, para
  // que el conteo sea verificable sin red.
  function planSearchQueries(term) {
    const t = String(term == null ? '' : term).trim();
    if (!t) return [];
    const plan = [{ kind: 'vendors', key: FILTER_KEY_VENDOR, term: t }];
    for (const cat of PO_CATEGORIES) plan.push({ kind: 'pos', categoryKey: cat.key, term: t });
    plan.push({ kind: 'bills', term: t });
    return plan;
  }

  // ── Selección de anclajes (reglas puras; el glue les pasa el DOM ya medido) ──
  //
  // El DOM de Steelhead DUPLICA controles en variantes responsive: el botón "New Purchase
  // Order" existe dos veces (css-eabxx0 = solo ícono, oculta en escritorio; css-165nl96 =
  // botón completo, visible), y hay 4 `SearchIcon` en la pantalla (el global del header, el
  // de la tabla, el del chat…). Tomar el PRIMER match del querySelector ancla en el
  // control equivocado — pasó en el deploy 1.7.203 con ambos widgets.
  //
  // cands: [{visible:boolean, width:number, ref:any}] → el primero realmente visible.
  function pickVisibleCandidate(cands) {
    const arr = Array.isArray(cands) ? cands : [];
    const hit = arr.find((c) => c && c.visible && (c.width == null || c.width > 0));
    return hit ? hit.ref : null;
  }

  // cands: [{depth:number|null, ref:any}] → el de MENOR profundidad (el más cercano al
  // hermano de referencia). `depth` null = no comparte contenedor → descartado.
  function pickNearestByDepth(cands) {
    const arr = (Array.isArray(cands) ? cands : []).filter((c) => c && c.depth != null);
    if (!arr.length) return null;
    let best = arr[0];
    for (const c of arr) if (c.depth < best.depth) best = c;
    return best.ref;
  }

  const api = {
    PO_URL_RE, PO_CATEGORIES, MODES, RESULT_TYPES,
    MAX_QUERIES_PER_SEARCH, planSearchQueries,
    pickVisibleCandidate, pickNearestByDepth,
    URL_PARAM_BILL_TO, FILTER_KEY_BILL_TO, FILTER_KEY_VENDOR, FILTER_SEARCH_LIMIT,
    DEFAULT_COMPANY_CONFIG,
    isPurchaseOrdersUrl, domainIdFromPath,
    categoryByKey, parseCategoryFromUrl, buildCategoryUrl,
    rootLocationName, companyOfLocation, groupLocationsByCompany,
    planCompanyFilter, buildCompanyFilterUrl, parseBillToFilter, parseCompanyModeFromUrl,
    parseVendorDisplay, classifyResults, dedupeResults, buildResultHref, groupResultsForRender,
  };
  if (typeof window !== 'undefined') window.POListingFiltersCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
