// Buscador global de OC + Toggle de empresa — glue (DOM + red).
// Consume po-listing-filters-core.js. Pantalla: /Domains/<d>/Purchasing/PurchaseOrders
//
// Widget A — buscador global: va en el HEADER, junto al toggle, tras "New Purchase Order".
//   Busca a la vez en las 5 vistas + proveedores + facturas, y etiqueta cada hallazgo
//   (OC / PROVEEDOR / FACTURA) diciendo en qué vista vive. Resuelve que el `searchQuery`
//   nativo NO busca por proveedor ('ATOTECH' → 0 resultados) y que obliga a adivinar la vista.
//   Cada renglón tiene además una flechita ↗ que abre la FICHA en pestaña aparte.
//   Al clicar un PROVEEDOR salta a la primera sección con resultados (Draft → Issued All →
//   Fulfilled All), siempre a la variante "All". Una OC concreta va a SU vista exacta.
//
// Widget B — toggle "Sólo Proquipa": mismo contenedor (#sa-pof-bar), a la izquierda del
//   buscador. Los dos JUNTOS y en dark-mode para que no se confundan con la UI nativa.
//   Binario, no triple: el lado Ecoplating NO es expresable porque sus OC llevan la
//   dirección del dominio y el filtro nativo no la acepta (bug de SH, ticket abierto por el
//   operador 2026-07-27). Aplica `billToLocationIdFilter` (array, semántica OR) por URL.
//
// FRUGALIDAD OBLIGATORIA: el /graphql de SH deja de responder tras ~40-45 requests seguidas
// (las peticiones quedan colgadas, sin 429 ni error, y no se recuperan al recargar) y eso
// tumba también la pantalla NATIVA. De ahí el fan-out acotado a 7, el debounce y el timeout.
// El pool es de 4 porque el límite castiga el VOLUMEN acumulado, no la concurrencia puntual.
//
// Estado singleton en window.__saPOF (no en el closure): injectAppScripts re-evalúa el IIFE
// en cada acción del popup (lección surtido-guard/price-confirm-guard).
(function () {
  'use strict';

  const Core = window.POListingFiltersCore;
  if (!Core) { console.warn('[po-listing-filters] core ausente'); return; }
  function api() { return window.SteelheadAPI; }

  const BAR_ID = 'sa-pof-bar';   // contenedor común de ambos widgets, en el header
  const SEARCH_ID = 'sa-pof-search';
  const TOGGLE_ID = 'sa-pof-toggle';
  const PANEL_ID = 'sa-pof-panel';
  const STYLE_ID = 'sa-pof-style';
  const DEBOUNCE_MS = 220;  // el fan-out está acotado a 7, así que no hace falta esperar tanto
  const PER_CATEGORY = 5;   // `first` por vista: el panel es un atajo, no un reporte
  // Concurrencia: el rate-limit de SH castiga el VOLUMEN acumulado (~40 requests), no la
  // concurrencia puntual. Con un fan-out fijo de 7, un pool de 4 lo resuelve en 2 rondas en
  // vez de 4 — la mitad del tiempo, mismo volumen total. No subir de aquí: 7/4 ya deja el
  // pool ocioso en la segunda ronda.
  const POOL = 4;
  const TIMEOUT_MS = 9000;  // si una vista no respondió en 9s, mejor mostrar el resto

  const S = (window.__saPOF = window.__saPOF || {
    seq: 0, locations: null, groups: null, discovering: false, lastResults: null,
    active: -1,   // índice del resultado activo por teclado (-1 = ninguno)
    cache: null,  // { term, raw } de la última búsqueda completada (evita re-consultar)
  });

  // ── estilos ──
  // TODO va en dark-mode (regla del repo), incluidos los controles del header: el operador
  // confundía el buscador con el universal de SH cuando heredaba el look nativo. Fondo
  // #141a23, texto #e6e9ee, acento #13a36f — se lee de un vistazo como UI de la extensión.
  function injectStyles() {
    const prev = document.getElementById(STYLE_ID);
    if (prev) prev.remove();
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #${BAR_ID}{display:inline-flex;align-items:center;gap:6px;margin:0 8px;flex:0 0 auto;white-space:nowrap;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;vertical-align:middle;}
      #${SEARCH_ID}{display:inline-flex;align-items:center;gap:6px;}
      #${SEARCH_ID} .sa-pof-inp{background:#141a23;color:#e6e9ee;border:1px solid #3a4757;border-radius:6px;padding:5px 9px;font-size:12px;width:168px;outline:none;font-family:inherit;}
      #${SEARCH_ID} .sa-pof-inp:focus{border-color:#13a36f;box-shadow:0 0 0 2px rgba(19,163,111,.25);}
      #${SEARCH_ID} .sa-pof-inp::placeholder{color:#7f8b99;}
      #${TOGGLE_ID}{display:inline-flex;align-items:center;gap:0;font-family:inherit;font-size:11px;border:1px solid #3a4757;border-radius:14px;overflow:hidden;background:#141a23;}
      #${TOGGLE_ID} button{background:transparent;color:#cfd6de;border:0;padding:4px 9px;font-size:11px;cursor:pointer;line-height:1.6;font-family:inherit;}
      #${TOGGLE_ID} button[aria-pressed="true"]{background:#13a36f;color:#fff;font-weight:600;}
      #${TOGGLE_ID} button[disabled]{opacity:.45;cursor:not-allowed;}
      #${PANEL_ID}{position:fixed;min-width:340px;max-width:520px;background:#1c2430;color:#e6e9ee;border:1px solid #33404f;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:2147483600;padding:10px;font-size:12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
      #${PANEL_ID} .sa-pof-sec{color:#7f8b99;font-size:10px;letter-spacing:.06em;text-transform:uppercase;margin:8px 0 4px;}
      #${PANEL_ID} .sa-pof-sec:first-child{margin-top:0;}
      #${PANEL_ID} ul{list-style:none;margin:0;padding:0;max-height:150px;overflow-y:auto;}
      #${PANEL_ID} li{border-radius:4px;overflow:hidden;display:flex;align-items:center;gap:2px;}
      #${PANEL_ID} .sa-pof-arrow{flex:0 0 auto;color:#7f8b99;text-decoration:none;padding:4px 6px;border-radius:4px;font-size:13px;line-height:1;}
      #${PANEL_ID} .sa-pof-arrow:hover{color:#13a36f;background:#26313f;}
      #${PANEL_ID} .sa-pof-arrow:focus-visible{outline:2px solid #13a36f;}
      #${PANEL_ID} .sa-pof-link{flex:1 1 auto;min-width:0;padding:4px 5px;border-radius:4px;color:#cfd6de;cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;text-decoration:none;}
      #${PANEL_ID} .sa-pof-link:hover,#${PANEL_ID} .sa-pof-link.sa-pof-active{background:#26313f;color:#f0f3f7;}
      #${PANEL_ID} .sa-pof-link.sa-pof-active{outline:1px solid #13a36f;outline-offset:-1px;}
      #${PANEL_ID} .sa-pof-link:focus-visible{outline:2px solid #13a36f;}
      #${PANEL_ID} .sa-pof-badge{flex:0 0 auto;font-size:9px;padding:1px 5px;border-radius:8px;font-weight:600;letter-spacing:.03em;}
      #${PANEL_ID} .sa-pof-b-po{background:#1d4b6e;color:#8ecbff;}
      #${PANEL_ID} .sa-pof-b-vendor{background:#134d3a;color:#6fe0b0;}
      #${PANEL_ID} .sa-pof-b-bill{background:#5a3a1c;color:#f0b878;}
      #${PANEL_ID} .sa-pof-main{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}
      #${PANEL_ID} .sa-pof-meta{flex:0 0 auto;color:#7f8b99;font-size:10px;}
      #${PANEL_ID} .sa-pof-head{color:#f0f3f7;font-weight:600;margin-bottom:6px;}
      #${PANEL_ID} .sa-pof-note{color:#9aa7b5;font-size:11px;margin-top:8px;border-top:1px solid #263140;padding-top:6px;}
      #${PANEL_ID} .sa-pof-warn{background:#3a2a1c;border:1px solid #6b4a2e;color:#f0a35e;border-radius:6px;padding:5px 7px;margin-top:8px;font-size:11px;white-space:normal;}
    `;
    document.head.appendChild(st);
  }

  // ── red ──
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  // Pool con concurrencia acotada. Un fallo NO tumba a los demás (resultado null).
  // `onEach` se invoca en cuanto CADA tarea termina → permite render incremental de verdad:
  // el panel se repinta con lo que ya llegó en vez de esperar a la última consulta.
  async function runPool(tasks, limit, onEach) {
    const out = new Array(tasks.length).fill(null);
    let i = 0;
    async function worker() {
      while (i < tasks.length) {
        const idx = i++;
        try { out[idx] = await tasks[idx](); }
        catch (e) { out[idx] = null; if (e && e.persistedQueryRotated) S.rotated = e.rotatedOp; }
        if (onEach) { try { onEach(out[idx], idx); } catch (_) { /* el render no debe romper el pool */ } }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return out;
  }

  function filterSearch(key, searchQuery) {
    return withTimeout(
      api().query('FilterSearch', { key, searchQuery: searchQuery || '' }, 'FilterSearch'),
      TIMEOUT_MS
    ).then((d) => (d && d.tableFilterSearch) || []);
  }

  // Los filtros de id van como ENTERO por GraphQL (el schema los declara [Int] y no
  // coacciona; FilterSearch los entrega como string). Ver toIdList en el core.
  function coerceIdFilters(extraVars) {
    const v = Object.assign({}, extraVars || {});
    for (const k of ['vendorIdFilter', 'billToLocationIdFilter', 'purchaseOrderStatusIdFilter']) {
      if (v[k] != null) v[k] = Core.toIdList(v[k]);
    }
    return v;
  }

  function queryPOs(categoryKey, extraVars) {
    const cat = Core.categoryByKey(categoryKey);
    if (!cat) return Promise.resolve([]);
    const vars = Object.assign({
      includeArchived: 'NO',
      filterDraftStageById: null,
      purchaseOrderStatusIdFilter: null,
      orderBy: ['ID_IN_DOMAIN_DESC'],
      offset: 0,
      first: PER_CATEGORY,
      searchQuery: '',
    }, cat.queryVars, coerceIdFilters(extraVars));
    return withTimeout(api().query('PurchaseOrders', vars, 'PurchaseOrders'), TIMEOUT_MS)
      .then((d) => (d && d.pagedData && d.pagedData.nodes) || []);
  }

  function queryBills(searchQuery) {
    return withTimeout(api().query('SearchBills', {
      includeArchived: 'NO', orderBy: ['ID_DESC'], offset: 0, first: PER_CATEGORY,
      searchQuery: searchQuery || '',
    }, 'SearchBills'), TIMEOUT_MS).then((d) => {
      // El shape exacto de SearchBills no se pudo confirmar en la captura (rate-limit);
      // se localiza el nodo paginado de forma defensiva en vez de asumir la ruta.
      if (!d) return [];
      for (const v of Object.values(d)) {
        if (v && typeof v === 'object' && Array.isArray(v.nodes)) return v.nodes;
      }
      return [];
    });
  }

  // ── descubrimiento de direcciones (una vez por carga) ──
  // FilterSearch topa en 10 resultados y no pagina → varias sondas y unión de resultados.
  // Si el tope se alcanza en TODAS las sondas, quedan direcciones sin descubrir: eso lo
  // refleja `capped` y el toggle lo advierte en vez de filtrar creyendo que lo sabe todo.
  const PROBES = ['', 'a', 'e', 'i', 'o', 'n', 'Eco', 'Pro', 'Planta', '.'];

  async function discoverLocations() {
    if (S.groups || S.discovering) return S.groups;
    S.discovering = true;
    try {
      const tasks = PROBES.map((p) => () => filterSearch(Core.FILTER_KEY_BILL_TO, p));
      const results = await runPool(tasks, POOL);
      const ok = results.filter(Boolean);
      if (!ok.length) return null;
      const merged = ok.flat();
      S.capped = ok.every((a) => a.length >= Core.FILTER_SEARCH_LIMIT);
      S.locations = merged;
      S.groups = Core.groupLocationsByCompany(merged);
      return S.groups;
    } finally {
      S.discovering = false;
    }
  }

  // Conteo puro de una vista/sección (solo interesa totalCount, por eso first:1).
  // Lo usa la resolución de sección al clicar un proveedor.
  function queryPOsCount(categoryKey, extraVars) {
    const cat = Core.categoryByKey(categoryKey);
    if (!cat) return Promise.resolve(null);
    const vars = Object.assign({
      includeArchived: 'NO', filterDraftStageById: null, purchaseOrderStatusIdFilter: null,
      orderBy: ['ID_IN_DOMAIN_DESC'], offset: 0, first: 1, searchQuery: '',
    }, cat.queryVars, coerceIdFilters(extraVars));
    return withTimeout(api().query('PurchaseOrders', vars, 'PurchaseOrders'), TIMEOUT_MS)
      .then((d) => (d && d.pagedData && d.pagedData.totalCount != null ? d.pagedData.totalCount : null))
      .catch(() => null);
  }

  // ── búsqueda global ──
  async function runSearch(term) {
    const seq = ++S.seq;

    // Caché de un slot: volver al mismo término (borrar y reescribir, o re-enfocar) no
    // vuelve a consultar. Barato y quita la espera en el caso más común.
    if (S.cache && S.cache.term === term) {
      S.lastResults = S.cache.raw;
      renderPanel(term, S.cache.raw, false);
      return;
    }

    const raw = { vendors: [], poByCategory: {}, bills: [] };

    // El plan viene del core y está ACOTADO a MAX_QUERIES_PER_SEARCH (ver allá el porqué:
    // el endpoint se cae ~40 requests y tumba la pantalla nativa completa). El proveedor
    // NO dispara un segundo fan-out de 5 vistas: se entrega clickeable y lleva a sus OCs.
    // La vista ACTUAL va primero, así el resultado más probable aparece antes.
    const plan = Core.planSearchQueries(term, Core.parseCategoryFromUrl(location.href));

    renderPanel(term, raw, true); // "Buscando…" inmediato, sin esperar la primera respuesta

    // TODAS las consultas van al mismo pool (antes los proveedores se esperaban en serie
    // ANTES de arrancar las demás, y eso costaba un round-trip completo de latencia).
    const tasks = plan.map((p) => {
      if (p.kind === 'vendors') return () => filterSearch(p.key, p.term).then((v) => ['__vendors__', v]);
      if (p.kind === 'bills') return () => queryBills(p.term).then((n) => ['__bills__', n]);
      return () => queryPOs(p.categoryKey, { searchQuery: p.term }).then((n) => [p.categoryKey, n]);
    });

    // Render incremental REAL: cada consulta que vuelve repinta el panel.
    const absorb = (r) => {
      if (!r) return;
      const [key, nodes] = r;
      if (key === '__vendors__') raw.vendors = nodes;
      else if (key === '__bills__') raw.bills = nodes;
      else raw.poByCategory[key] = (raw.poByCategory[key] || []).concat(nodes);
    };

    await runPool(tasks, POOL, (r) => {
      if (seq !== S.seq) return; // llegó una búsqueda más nueva: no pintes lo viejo
      absorb(r);
      renderPanel(term, raw, true);
    });

    if (seq !== S.seq) return;
    S.lastResults = raw;
    S.cache = { term, raw };
    renderPanel(term, raw, false);
  }

  // ── panel ──
  function positionPanel(anchor, p) {
    const r = anchor.getBoundingClientRect();
    p.style.top = (r.bottom + 4) + 'px';
    p.style.left = r.left + 'px';
  }
  function ensurePanel(anchor) {
    let p = document.getElementById(PANEL_ID);
    if (!p) {
      p = document.createElement('div');
      p.id = PANEL_ID;
      // Un mousedown DENTRO del panel no debe quitarle el foco al input: si lo quita, el
      // blur programa hidePanel y el panel puede desaparecer antes de que el clic complete.
      // Con esto el <a> recibe su clic con el panel todavía montado.
      p.addEventListener('mousedown', (e) => e.preventDefault());
      document.body.appendChild(p);
    }
    positionPanel(anchor, p);
    return p;
  }
  function hidePanel() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    S.active = -1;
  }

  function currentLinks() {
    const p = document.getElementById(PANEL_ID);
    return p ? Array.from(p.querySelectorAll('a.sa-pof-link')) : [];
  }

  function highlightActive(links) {
    const list = links || currentLinks();
    list.forEach((a, i) => {
      const on = i === S.active;
      a.classList.toggle('sa-pof-active', on);
      if (on && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    });
  }

  // Cada renglón es un <a href> REAL, no un <li> con listener de mousedown.
  //
  // El patrón mousedown+preventDefault era frágil: dependía de que el panel siguiera vivo
  // entre mousedown y la navegación (el render incremental RECREA los renglones cuando
  // llegan las OCs), competía con el hidePanel del blur, no funcionaba con teclado y no
  // dejaba abrir en pestaña nueva. Un <a href> lo maneja el navegador: sobrevive al
  // re-render, soporta ⌘/ctrl+clic y clic medio, y es accesible.
  function mkRow(result, domainId) {
    const li = document.createElement('li');
    const href = Core.buildResultHref(result, domainId);
    const row = document.createElement(href ? 'a' : 'span');
    if (href) { row.href = href; row.className = 'sa-pof-link'; }
    // Al clicar un PROVEEDOR se resuelve a qué sección mandarlo (la primera con
    // resultados). El href ya apunta a 'issued-all', así que si la resolución falla o
    // tarda, el enlace sigue sirviendo — por eso se intercepta en vez de generar el href
    // de forma asíncrona.
    if (href && result.type === Core.RESULT_TYPES.VENDOR) {
      row.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // respeta pestaña nueva
        e.preventDefault();
        goToVendorBestSection(result, domainId, href);
      });
    }
    const badge = document.createElement('span');
    badge.className = 'sa-pof-badge ' + (
      result.type === Core.RESULT_TYPES.PO ? 'sa-pof-b-po'
        : result.type === Core.RESULT_TYPES.VENDOR ? 'sa-pof-b-vendor' : 'sa-pof-b-bill');
    badge.textContent = result.type === Core.RESULT_TYPES.PO ? 'OC'
      : result.type === Core.RESULT_TYPES.VENDOR ? 'PROV' : 'FACT';
    row.appendChild(badge);

    const main = document.createElement('span');
    main.className = 'sa-pof-main';
    // textContent SIEMPRE: los nombres de proveedor vienen de la API (vector cross-user).
    let txt = result.label;
    if (result.vendorName) txt += ' · ' + result.vendorName;
    if (result.type === Core.RESULT_TYPES.BILL && result.poIdInDomain) txt += ' · OC ' + result.poIdInDomain;
    main.textContent = txt;
    main.title = txt;
    row.appendChild(main);

    const meta = document.createElement('span');
    meta.className = 'sa-pof-meta';
    meta.textContent = result.categoryLabel || (result.idInDomain ? '#' + result.idInDomain : '');
    row.appendChild(meta);

    li.appendChild(row);

    // Flechita ↗ — abre la FICHA del documento en pestaña aparte, sin perder la búsqueda.
    // Sin idInDomain no se pinta: mejor sin flechita que una que abra otro documento.
    const detail = Core.buildDetailHref(result, domainId);
    if (detail) {
      const arrow = document.createElement('a');
      arrow.className = 'sa-pof-arrow';
      arrow.href = detail;
      arrow.target = '_blank';
      arrow.rel = 'noopener noreferrer';
      arrow.textContent = '↗';
      const que = result.type === Core.RESULT_TYPES.PO ? 'la orden de compra'
        : result.type === Core.RESULT_TYPES.VENDOR ? 'el proveedor' : 'la factura';
      arrow.title = `Abrir ${que} en una pestaña nueva`;
      arrow.setAttribute('aria-label', arrow.title);
      li.appendChild(arrow);
    }
    return li;
  }

  // Manda al proveedor a la PRIMERA sección con resultados (Draft → Issued All →
  // Fulfilled All), siempre a la variante "All" — nunca a Open ni a Closed.
  // Son 3 consultas de conteo, y solo las paga quien hace clic.
  async function goToVendorBestSection(result, domainId, fallbackHref) {
    const counts = {};
    try {
      const tasks = Core.PO_NAV_SECTIONS.map((s) => () =>
        queryPOsCount(s.key, { vendorIdFilter: [result.id] }).then((n) => [s.key, n]));
      const res = await runPool(tasks, POOL);
      for (const r of res) if (r) counts[r[0]] = r[1];
    } catch (_) { /* se cae al fallback */ }
    const section = Core.resolveFirstSectionWithResults(counts);
    const href = section
      ? Core.buildResultHref(result, domainId, section)
      : fallbackHref; // ninguna sección respondió o todas vacías → el href por defecto
    window.location.assign(href);
  }

  function renderPanel(term, raw, partial) {
    const box = document.getElementById(SEARCH_ID);
    if (!box) return;
    const p = ensurePanel(box);
    p.textContent = '';
    const domainId = Core.domainIdFromPath(location.pathname);

    const head = document.createElement('div');
    head.className = 'sa-pof-head';
    const g = Core.groupResultsForRender(Core.classifyResults(raw));
    // En parcial se muestra lo que YA llegó, no solo "Buscando…": con render incremental el
    // operador ve crecer el contador y puede clicar el primer resultado sin esperar el resto.
    head.textContent = partial
      ? (g.total ? `Buscando… ${g.total} hasta ahora` : `Buscando «${term}»…`)
      : `${g.total} resultado${g.total === 1 ? '' : 's'} para «${term}»`;
    p.appendChild(head);

    if (S.rotated) {
      const w = document.createElement('div');
      w.className = 'sa-pof-warn';
      w.textContent = `⚠️ No se pudo consultar «${S.rotated}» (hash rotado). Los resultados están incompletos.`;
      p.appendChild(w);
    }

    const secs = [
      ['Proveedor', g.vendors],
      ['Órdenes de compra', g.pos],
      ['Facturas', g.bills],
    ];
    let any = false;
    for (const [title, items] of secs) {
      if (!items.length) continue;
      any = true;
      const h = document.createElement('div');
      h.className = 'sa-pof-sec';
      h.textContent = title;
      p.appendChild(h);
      const ul = document.createElement('ul');
      items.forEach((r) => ul.appendChild(mkRow(r, domainId)));
      p.appendChild(ul);
    }

    if (!any && !partial) {
      const n = document.createElement('div');
      n.className = 'sa-pof-note';
      n.textContent = 'Sin coincidencias en las 5 vistas, proveedores ni facturas.';
      p.appendChild(n);
    } else if (!partial) {
      const n = document.createElement('div');
      n.className = 'sa-pof-note';
      n.textContent = 'Busca en las 5 vistas a la vez · ↑↓ y Enter, o clic';
      p.appendChild(n);
    }

    // El render incremental RECREA los renglones; hay que reponer el resaltado sobre los
    // nuevos nodos y recortar el índice si ahora hay menos resultados que antes.
    const links = currentLinks();
    if (S.active >= links.length) S.active = links.length ? links.length - 1 : -1;
    if (S.active >= 0) highlightActive(links);
  }

  // ── anclajes DOM (bilingües ES+EN donde dependen de texto) ──
  const NEW_PO_LABEL_RE = /new purchase order|nueva orden de compra/i;

  // El botón "New Purchase Order" está DUPLICADO en dos variantes responsive: css-eabxx0
  // (solo ícono, oculta en escritorio) y css-165nl96 (botón completo, visible). Hay que
  // quedarse con la VISIBLE — anclar en la oculta mete el toggle en un contenedor de
  // ancho 0 (bug del deploy 1.7.203: el toggle se inyectaba pero no se veía).
  function findNewPoButton() {
    const cands = [];
    for (const b of document.querySelectorAll('button, [aria-label]')) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      if (!NEW_PO_LABEL_RE.test(label)) continue;
      // El aria-label vive en un <span> que envuelve al botón; se sube al contenedor
      // que sí está en el flujo del header.
      const ref = b.closest('span[aria-label]') || b;
      const r = ref.getBoundingClientRect();
      cands.push({ visible: ref.offsetParent !== null, width: r.width, ref });
    }
    return Core.pickVisibleCandidate(cands);
  }

  // ── contenedor común de los dos widgets ──
  // Ambos viven JUNTOS en el header, después de "New Purchase Order". El buscador estaba
  // antes en la barra de filtros de la tabla, pegado al buscador nativo, y el operador lo
  // confundía con el universal: dos cajas de búsqueda contiguas y casi idénticas. Aquí,
  // agrupado con el toggle y en dark-mode, se lee de un vistazo como UI de la extensión.
  // El botón vive envuelto en varios spans (`css-165nl96` es su wrapper responsive, de ancho
  // fijo). Insertar ahí dentro mete la barra DENTRO del botón y se dibuja encima del header
  // — bug del deploy 1.7.210. Hay que subir hasta el hijo DIRECTO del MuiPaper del header y
  // ponerse como su hermano.
  function headerRowChild(node) {
    let el = node;
    for (let i = 0; i < 6 && el && el.parentElement; i++) {
      if (el.parentElement.classList && el.parentElement.classList.contains('MuiPaper-root')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function getBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    const anchor = findNewPoButton();
    if (!anchor) return null;
    const sibling = headerRowChild(anchor);
    if (!sibling || !sibling.parentElement) return null;
    bar = document.createElement('div');
    bar.id = BAR_ID;
    sibling.parentElement.insertBefore(bar, sibling.nextSibling);
    return bar;
  }

  // ── inyección: buscador ──
  function injectSearch() {
    if (document.getElementById(SEARCH_ID)) return true;
    const bar = getBar();
    if (!bar) return false;

    const box = document.createElement('div');
    box.id = SEARCH_ID;
    const inp = document.createElement('input');
    inp.className = 'sa-pof-inp';
    inp.type = 'text';
    inp.placeholder = 'OC, proveedor o factura…';
    inp.setAttribute('aria-label', 'Buscar orden de compra, proveedor o factura en todas las vistas');

    let timer = null;
    inp.addEventListener('input', () => {
      const term = inp.value.trim();
      if (timer) clearTimeout(timer);
      S.seq++;
      S.rotated = null;
      S.active = -1; // término nuevo → la selección anterior ya no aplica
      if (!term) { hidePanel(); return; }
      timer = setTimeout(() => runSearch(term), DEBOUNCE_MS);
    });
    // Teclado: ↑/↓ recorren los resultados, Enter abre el activo, Esc cierra.
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hidePanel(); return; }
      const links = currentLinks();
      if (!links.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        S.active = Core.moveActiveIndex(S.active, links.length, e.key === 'ArrowDown' ? 1 : -1);
        highlightActive(links);
      } else if (e.key === 'Enter') {
        const a = links[S.active];
        if (a) { e.preventDefault(); window.location.assign(a.getAttribute('href')); }
      }
    });
    // Sin timeout-race: el mousedown del panel ya evita este blur, así que cuando el blur
    // SÍ ocurre es porque el foco se fue de verdad y el panel debe cerrarse.
    inp.addEventListener('blur', hidePanel);
    inp.addEventListener('focus', () => { if (inp.value.trim() && S.lastResults) renderPanel(inp.value.trim(), S.lastResults, false); });

    box.appendChild(inp);
    bar.appendChild(box); // tras el toggle (que se inyecta primero)
    return true;
  }

  // ── inyección: toggle ──
  function injectToggle() {
    if (document.getElementById(TOGGLE_ID)) return true;
    const bar = getBar();
    if (!bar) return false;

    const wrap = document.createElement('div');
    wrap.id = TOGGLE_ID;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Filtrar órdenes de compra por empresa');

    // Binario, no triple: el lado Ecoplating no es expresable con el filtro nativo
    // (bug de SH con ticket abierto). Ver planProquipaFilter en el core.
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Sólo Proquipa';
    b.dataset.mode = Core.MODES.PROQUIPA;
    b.setAttribute('aria-pressed', 'false');
    b.disabled = true; // se habilita al descubrir las direcciones
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      applyProquipa(!on);
    });
    wrap.appendChild(b);
    bar.appendChild(wrap);

    // Descubrimiento diferido: no bloquea la inyección ni la carga de la pantalla.
    discoverLocations().then((groups) => {
      const el = document.getElementById(TOGGLE_ID);
      if (!el) return;
      if (!groups || (!groups.ecoplating.length && !groups.proquipa.length)) {
        // Sin direcciones no se filtra a ciegas: se deja deshabilitado y se dice por qué.
        el.title = 'No se pudieron leer las direcciones de facturación; el filtro por empresa no está disponible.';
        return;
      }
      const on = Core.isProquipaFilterActive(location.href, groups);
      const btn = el.querySelector('button');
      if (btn) { btn.disabled = false; btn.setAttribute('aria-pressed', String(on)); }
      el.title = S.capped
        ? 'Aviso: puede haber direcciones sin descubrir (el filtro de Steelhead devuelve máximo 10 por consulta).'
        : `Filtra las ${groups.proquipa.length} direcciones de Proquipa a la vez. `
          + 'Ecoplating no se puede filtrar: sus OC llevan la dirección del dominio y el filtro '
          + 'nativo de Steelhead no la acepta (ticket de soporte abierto).';
    });
    return true;
  }

  async function applyProquipa(enabled) {
    const groups = S.groups || await discoverLocations();
    if (!groups) return;
    const plan = Core.planProquipaFilter(enabled, groups);
    if (plan.kind === 'unavailable') {
      alertNote('No hay direcciones de facturación de Proquipa en este dominio.');
      return;
    }
    window.location.assign(Core.buildCompanyFilterUrl(location.href, plan.ids));
  }

  function alertNote(msg) {
    const el = document.getElementById(TOGGLE_ID);
    if (el) el.title = msg;
    console.warn('[po-listing-filters] ' + msg);
  }

  // ── ciclo de vida ──
  function injectAll() {
    if (!Core.isPurchaseOrdersUrl(location.pathname)) return false;
    injectStyles();
    const b = injectToggle();   // primero el toggle…
    const a = injectSearch();   // …y el buscador a su derecha
    return a && b;
  }

  function removeAll() {
    for (const id of [SEARCH_ID, TOGGLE_ID, PANEL_ID, BAR_ID]) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  }

  // Observer que se auto-desconecta al inyectar (la tabla de OCs re-renderiza mucho;
  // un observer permanente sobre body.subtree sale caro).
  let obs = null;
  function stopObs() { if (obs) { obs.disconnect(); obs = null; } }
  function startObs() {
    if (obs) return;
    obs = new MutationObserver(() => {
      if (!Core.isPurchaseOrdersUrl(location.pathname)) { stopObs(); return; }
      if (injectAll()) stopObs();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function onUrlChange() {
    if (Core.isPurchaseOrdersUrl(location.pathname)) {
      if (!injectAll()) startObs();
    } else {
      stopObs();
      removeAll();
    }
  }

  function patchHistory() {
    if (window.__saPOFHistoryPatched) return;
    window.__saPOFHistoryPatched = true;
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        window.dispatchEvent(new Event('sa-pof-url'));
        return r;
      };
    }
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('sa-pof-url')));
    window.addEventListener('sa-pof-url', onUrlChange);
  }

  function init() { patchHistory(); onUrlChange(); }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);

  window.POListingFilters = { injectAll, removeAll, runSearch, applyProquipa, discoverLocations };
})();
