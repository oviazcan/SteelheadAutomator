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

  // ── Secciones de NAVEGACIÓN (distintas de las 5 vistas de arriba) ──
  //
  // El eje de facturación tiene un tercer estado, "All" (`?billing=All`), que simplemente
  // OMITE `billingOpen` en la query — verificado en vivo: Issued·All manda
  // {issuedCondition:true} a secas.
  //
  // Al saltar desde un PROVEEDOR se navega SIEMPRE a la variante All, nunca a Open ni a
  // Closed: el operador quiere ver todas sus OCs, no la mitad. Se elige la PRIMERA sección
  // que traiga resultados, en este orden. (Una OC concreta es otra cosa: esa vive en UNA
  // vista específica y ahí se manda — ver buildResultHref.)
  const PO_NAV_SECTIONS = [
    { key: 'draft', label: 'Borrador', urlParams: { category: 'Draft' }, queryVars: { issuedAt: true, fulfilledCondition: false } },
    { key: 'issued-all', label: 'Emitidas (todas)', urlParams: { category: 'Issued', billing: 'All' }, queryVars: { issuedCondition: true } },
    { key: 'fulfilled-all', label: 'Surtidas (todas)', urlParams: { category: 'Fulfilled', billing: 'All' }, queryVars: { fulfilledCondition: true } },
  ];

  function categoryByKey(key) {
    return PO_CATEGORIES.find((c) => c.key === key)
      || PO_NAV_SECTIONS.find((c) => c.key === key)
      || null;
  }

  // counts: { draft:n, 'issued-all':n, 'fulfilled-all':n } → key de la PRIMERA sección con
  // resultados, respetando el orden de PO_NAV_SECTIONS. null si ninguna trae nada.
  // Un conteo desconocido (null/undefined) NO cuenta como resultado: mandar al operador a
  // una sección vacía es peor que dejarlo donde está.
  function resolveFirstSectionWithResults(counts) {
    const c = counts || {};
    for (const s of PO_NAV_SECTIONS) {
      const n = c[s.key];
      if (typeof n === 'number' && n > 0) return s.key;
    }
    return null;
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

  // ── Toggle de empresa: SOLO Proquipa (binario) ──
  //
  // Nació como toggle triple (Ecoplating | ambos | Proquipa), pero el lado Ecoplating NO es
  // expresable: las OCs del dominio llevan la dirección del dominio, que es la MISMA que la
  // asignada a la ubicación "Ecoplating", y el filtro nativo no la acepta (por eso 79 de 129
  // OCs no matchean ninguna de las 10 direcciones). Es un **bug de Steelhead**, con ticket
  // de soporte levantado por el operador el 2026-07-27.
  //
  // Mientras tanto el toggle es binario: **solo Proquipa**, que es lo único filtrable de
  // forma confiable. Cuando Steelhead corrija el filtro, reponer el lado Ecoplating es
  // agregar un modo aquí — el descubrimiento y la agrupación por raíz ya existen y siguen
  // clasificando ambas empresas.
  const MODES = { OFF: 'off', PROQUIPA: 'proquipa' };

  function planProquipaFilter(enabled, groups) {
    const g = groups || { proquipa: [] };
    if (!enabled) return { kind: 'clear', ids: [] };
    if (!g.proquipa.length) return { kind: 'unavailable', reason: 'sin-direcciones-proquipa' };
    return { kind: 'filter', ids: g.proquipa.slice() };
  }

  // Escribe (o limpia) el parámetro de dirección de facturación.
  function buildCompanyFilterUrl(currentUrl, ids) {
    const absolute = isAbsoluteUrl(currentUrl);
    const u = new URL(currentUrl, URL_BASE);
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
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

  // ¿El toggle debe verse encendido al recargar? Solo si el filtro de la URL es
  // exactamente el de Proquipa. Un filtro puesto a mano (o que incluya otras direcciones)
  // NO enciende el toggle: mentiría sobre lo que está aplicado.
  function isProquipaFilterActive(url, groups) {
    const ids = parseBillToFilter(url);
    if (!ids.length) return false;
    const pro = ((groups || {}).proquipa || []).map(String);
    if (!pro.length) return false;
    const setIds = new Set(ids);
    const setPro = new Set(pro);
    return ids.length === pro.length && pro.every((id) => setIds.has(id)) && ids.every((id) => setPro.has(id));
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

  // ── Facturas: de dónde sale cada dato y POR QUÉ matchean ──
  //
  // `SearchBills.searchQuery` busca en VARIOS campos a la vez y no dice en cuál pegó, así
  // que buscar "1841" devuelve facturas que a simple vista no tienen nada que ver (caso real
  // reportado por el operador). Con los datos del nodo se puede explicar cada una:
  //
  //   Bill #1841  A&N FORWARDING     invoiceNumber 262034          PO 1617  → pegó el Bill #
  //   Bill #2018  REACTOR AD         invoiceNumber 1841            PO 1790  → pegó el folio
  //   Bill #2080  NORA LIZ PINEDA    invoiceNumber PO1841          PO 1841  → pegó la OC ★
  //   Bill #1822  COMPUTO CONTABLE   invoiceNumber 260708121841049 PO 1597  → substring del folio
  //
  // La #2080 es la que el operador realmente buscaba. Mostrar el motivo convierte ruido
  // aparente en información, y `MATCH_PO` permite subirla al principio.
  const BILL_MATCH = { PO: 'po', INVOICE: 'invoice', BILL_ID: 'bill-id', OTHER: 'other' };

  // El PO# de una factura vive en sus LÍNEAS (`purchaseOrderName`), no en el nodo raíz.
  function extractBillPOs(bill) {
    const nodes = (bill && bill.billLinesByBillId && bill.billLinesByBillId.nodes) || [];
    const seen = new Set();
    const out = [];
    for (const l of nodes) {
      const name = l && l.purchaseOrderName;
      if (name == null || name === '') continue;
      const s = String(name);
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
  }

  // ¿Por qué esta factura salió en la búsqueda? Se evalúa en orden de relevancia: coincidir
  // por OC es lo más informativo, luego el folio exacto, luego el propio Bill #.
  function billMatchReason(bill, term) {
    const t = String(term == null ? '' : term).trim().toLowerCase();
    if (!t || !bill) return BILL_MATCH.OTHER;
    if (extractBillPOs(bill).some((p) => p.toLowerCase() === t)) return BILL_MATCH.PO;
    const inv = bill.invoiceNumber == null ? '' : String(bill.invoiceNumber).toLowerCase();
    if (inv === t) return BILL_MATCH.INVOICE;
    if (String(bill.idInDomain) === t) return BILL_MATCH.BILL_ID;
    if (inv.includes(t)) return BILL_MATCH.INVOICE; // substring del folio (el caso 1822)
    return BILL_MATCH.OTHER;
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

    // Las facturas que coinciden por OC van PRIMERO: son las que el operador buscaba cuando
    // teclea un número de orden. El resto conserva el orden del server.
    const bills = (r.bills || []).filter(Boolean).map((b) => {
      const pos = extractBillPOs(b);
      return {
        type: RESULT_TYPES.BILL,
        id: b.id == null ? null : String(b.id),
        idInDomain: b.idInDomain == null ? null : String(b.idInDomain),
        label: 'Factura ' + (b.idInDomain == null ? '?' : b.idInDomain),
        vendorName: (b.vendorByVendorId && b.vendorByVendorId.name) || null,
        invoiceNumber: b.invoiceNumber == null ? null : String(b.invoiceNumber),
        poNames: pos,
        poIdInDomain: pos.length === 1 ? pos[0] : null,
        matchReason: billMatchReason(b, r.term),
      };
    });
    const porOC = bills.filter((b) => b.matchReason === BILL_MATCH.PO);
    const resto = bills.filter((b) => b.matchReason !== BILL_MATCH.PO);
    out.push(...porOC, ...resto);

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

  // Salto al LISTADO filtrado.
  //  · OC   → su vista exacta (una OC vive en UNA sola de las 5), filtrada por su PO#.
  //  · PROV → listado por `vendorIdFilter`. `sectionKey` decide la sección; por defecto
  //           'issued-all' (la más poblada) para que el <a href> sirva aunque los conteos
  //           no se hayan podido consultar — el glue lo afina al clicar.
  //  · FACT → listado de facturas filtrado.
  function buildResultHref(result, domainId, sectionKey, baseUrl) {
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
      return buildCategoryUrl(base, sectionKey || 'issued-all', { vendorIdFilter: result.id });
    }
    return null;
  }

  // Salto a la FICHA del documento (la flechita ↗, que abre en pestaña aparte).
  // Las tres rutas usan `idInDomain`, NO el id de BD — verificado en vivo:
  //   · OC     /Domains/<d>/Purchasing/PurchaseOrders/1897  (1897 = el PO# visible)
  //   · PROV   /Domains/<d>/Vendors/6                       (6 = el "#6" del display;
  //                                                          /Vendors/6 abre ATOTECH DE MEXICO)
  //   · FACT   /Domains/<d>/Bills/<idInDomain>
  // Sin `idInDomain` no se inventa link: mejor sin flechita que una flechita que abre otro
  // documento.
  function buildDetailHref(result, domainId) {
    if (!result || !domainId || !result.idInDomain) return null;
    const id = encodeURIComponent(result.idInDomain);
    if (result.type === RESULT_TYPES.PO) return '/Domains/' + domainId + '/Purchasing/PurchaseOrders/' + id;
    if (result.type === RESULT_TYPES.VENDOR) return '/Domains/' + domainId + '/Vendors/' + id;
    if (result.type === RESULT_TYPES.BILL) return '/Domains/' + domainId + '/Bills/' + id;
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
  //
  // `currentCategoryKey` (la vista abierta) se consulta PRIMERO entre las 5: es donde el
  // operador tiene más probabilidad de encontrar lo que busca, y con render incremental eso
  // se traduce en que el resultado útil aparece antes aunque el total tarde lo mismo.
  function planSearchQueries(term, currentCategoryKey) {
    const t = String(term == null ? '' : term).trim();
    if (!t) return [];
    const plan = [{ kind: 'vendors', key: FILTER_KEY_VENDOR, term: t }];
    const cats = PO_CATEGORIES.slice();
    const i = cats.findIndex((c) => c.key === currentCategoryKey);
    if (i > 0) cats.unshift(cats.splice(i, 1)[0]); // la vista actual al frente
    for (const cat of cats) plan.push({ kind: 'pos', categoryKey: cat.key, term: t });
    plan.push({ kind: 'bills', term: t });
    return plan;
  }

  // ── Ids: string en la URL, ENTERO en GraphQL ──
  //
  // `FilterSearch` devuelve `identifier` como STRING ("89855"), y en la URL los filtros
  // viajan como texto — ambas cosas están bien. Pero el schema declara estos filtros como
  // listas de Int y GraphQL NO coacciona: mandar ["89855"] revienta con
  //   Variable "$vendorIdFilter" got invalid value …
  // y la consulta falla ENTERA (HTTP 400). Pasó en el deploy 1.7.208: los 3 conteos que
  // resuelven a qué sección mandar al proveedor fallaban todos, así que siempre caía al
  // fallback (Issued All) — mandando al operador a una vista vacía aunque el proveedor
  // tuviera 35 OC en Fulfilled.
  //
  // Descarta lo que no sea numérico en vez de mandar NaN, que rompería igual.
  function toIdList(ids) {
    return (Array.isArray(ids) ? ids : [])
      .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
      .filter((n) => Number.isInteger(n));
  }

  // ── Navegación por teclado del panel ──
  // Índice activo con wrap-around. -1 = nada seleccionado (estado inicial: el primer ↓
  // debe caer en el 0, y el primer ↑ en el último).
  function moveActiveIndex(current, total, delta) {
    const n = Math.max(0, Number(total) || 0);
    if (!n) return -1;
    const cur = Number.isInteger(current) ? current : -1;
    if (cur < 0) return delta > 0 ? 0 : n - 1;
    return ((cur + delta) % n + n) % n;
  }

  // ── Selección de anclajes (reglas puras; el glue les pasa el DOM ya medido) ──
  //
  // El DOM de Steelhead DUPLICA controles en variantes responsive: el botón "New Purchase
  // Order" existe dos veces (css-eabxx0 = solo ícono, OCULTA en escritorio; css-165nl96 =
  // botón completo, visible). Tomar el PRIMER match del querySelector ancla en la oculta y
  // el widget se inyecta con ancho 0, invisible — pasó en el deploy 1.7.203.
  //
  // cands: [{visible:boolean, width:number, ref:any}] → el primero realmente visible.
  function pickVisibleCandidate(cands) {
    const arr = Array.isArray(cands) ? cands : [];
    const hit = arr.find((c) => c && c.visible && (c.width == null || c.width > 0));
    return hit ? hit.ref : null;
  }

  const api = {
    PO_URL_RE, PO_CATEGORIES, PO_NAV_SECTIONS, MODES, RESULT_TYPES,
    MAX_QUERIES_PER_SEARCH, planSearchQueries, moveActiveIndex, toIdList,
    pickVisibleCandidate,
    resolveFirstSectionWithResults, buildDetailHref,
    planProquipaFilter, isProquipaFilterActive,
    URL_PARAM_BILL_TO, FILTER_KEY_BILL_TO, FILTER_KEY_VENDOR, FILTER_SEARCH_LIMIT,
    DEFAULT_COMPANY_CONFIG,
    isPurchaseOrdersUrl, domainIdFromPath,
    categoryByKey, parseCategoryFromUrl, buildCategoryUrl,
    rootLocationName, companyOfLocation, groupLocationsByCompany,
    buildCompanyFilterUrl, parseBillToFilter,
    parseVendorDisplay, classifyResults, dedupeResults, buildResultHref, groupResultsForRender,
    BILL_MATCH, extractBillPOs, billMatchReason,
  };
  if (typeof window !== 'undefined') window.POListingFiltersCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
