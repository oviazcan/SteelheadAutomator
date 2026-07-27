// Buscador global de OC + Toggle de empresa — glue (DOM + red).
// Consume po-listing-filters-core.js. Pantalla: /Domains/<d>/Purchasing/PurchaseOrders
//
// Widget A — buscador global: va entre el buscador nativo y los filtros ("Creado Por"…).
//   Busca a la vez en las 5 vistas + proveedores + facturas, y etiqueta cada hallazgo
//   (OC / PROVEEDOR / FACTURA) diciendo en qué vista vive. Resuelve que el `searchQuery`
//   nativo NO busca por proveedor ('ATOTECH' → 0 resultados) y que obliga a adivinar la vista.
//
// Widget B — toggle triple de empresa: va después del botón "New Purchase Order".
//   Izquierda=Ecoplating (incluye dominio), centro=ambos (default), derecha=Proquipa.
//   Aplica `billToLocationIdFilter` (array, semántica OR verificada en vivo) por URL.
//
// FRUGALIDAD OBLIGATORIA: el /graphql de SH deja de responder tras ~40-45 requests seguidas
// (las peticiones quedan colgadas, sin 429 ni error, y no se recuperan al recargar). De ahí
// el pool de 2, el debounce, `first` chico y el AbortController con timeout.
//
// Estado singleton en window.__saPOF (no en el closure): injectAppScripts re-evalúa el IIFE
// en cada acción del popup (lección surtido-guard/price-confirm-guard).
(function () {
  'use strict';

  const Core = window.POListingFiltersCore;
  if (!Core) { console.warn('[po-listing-filters] core ausente'); return; }
  function api() { return window.SteelheadAPI; }

  const SEARCH_ID = 'sa-pof-search';
  const TOGGLE_ID = 'sa-pof-toggle';
  const PANEL_ID = 'sa-pof-panel';
  const STYLE_ID = 'sa-pof-style';
  const DEBOUNCE_MS = 350;
  const PER_CATEGORY = 5;   // `first` por vista: el panel es un atajo, no un reporte
  const POOL = 2;           // concurrencia máxima (ver FRUGALIDAD arriba)
  const TIMEOUT_MS = 12000;

  const S = (window.__saPOF = window.__saPOF || {
    seq: 0, locations: null, groups: null, coverage: {}, discovering: false, lastResults: null,
  });

  // ── estilos ──
  // El panel flotante es UI NUESTRA → dark-mode (regla del repo). Los controles inline
  // heredan el look de la barra nativa y se marcan con el acento verde #13a36f
  // (precedente schedule-batch-highlighter): el verde es lo que dice "esto es de la
  // extensión", porque el Steelhead de este dominio corre en tema oscuro.
  function injectStyles() {
    const prev = document.getElementById(STYLE_ID);
    if (prev) prev.remove();
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #${SEARCH_ID}{display:inline-flex;align-items:center;gap:6px;margin:0 10px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
      #${SEARCH_ID} .sa-pof-inp{background:transparent;color:inherit;border:1px solid #13a36f;border-radius:6px;padding:5px 8px;font-size:12px;width:190px;outline:none;}
      #${SEARCH_ID} .sa-pof-inp:focus{box-shadow:0 0 0 2px rgba(19,163,111,.25);}
      #${SEARCH_ID} .sa-pof-inp::placeholder{opacity:.6;}
      #${TOGGLE_ID}{display:inline-flex;align-items:center;gap:0;margin:0 10px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:11px;border:1px solid #13a36f;border-radius:14px;overflow:hidden;}
      #${TOGGLE_ID} button{background:transparent;color:inherit;border:0;padding:4px 10px;font-size:11px;cursor:pointer;line-height:1.6;font-family:inherit;}
      #${TOGGLE_ID} button+button{border-left:1px solid rgba(19,163,111,.45);}
      #${TOGGLE_ID} button[aria-pressed="true"]{background:#13a36f;color:#fff;font-weight:600;}
      #${TOGGLE_ID} button[disabled]{opacity:.4;cursor:not-allowed;}
      #${PANEL_ID}{position:fixed;min-width:340px;max-width:520px;background:#1c2430;color:#e6e9ee;border:1px solid #33404f;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:2147483600;padding:10px;font-size:12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
      #${PANEL_ID} .sa-pof-sec{color:#7f8b99;font-size:10px;letter-spacing:.06em;text-transform:uppercase;margin:8px 0 4px;}
      #${PANEL_ID} .sa-pof-sec:first-child{margin-top:0;}
      #${PANEL_ID} ul{list-style:none;margin:0;padding:0;max-height:150px;overflow-y:auto;}
      #${PANEL_ID} li{padding:4px 5px;border-radius:4px;color:#cfd6de;cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;}
      #${PANEL_ID} li:hover{background:#26313f;}
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

  // Pool secuencial con concurrencia acotada. Un fallo NO tumba a los demás (resultado null).
  async function runPool(tasks, limit) {
    const out = new Array(tasks.length).fill(null);
    let i = 0;
    async function worker() {
      while (i < tasks.length) {
        const idx = i++;
        try { out[idx] = await tasks[idx](); }
        catch (e) { out[idx] = null; if (e && e.persistedQueryRotated) S.rotated = e.rotatedOp; }
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
    }, cat.queryVars, extraVars || {});
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

  // ── cobertura: ¿hay OCs sin dirección? ──
  // Decide qué rama usa planCompanyFilter. Se mide UNA vez, en la vista actual, con first:1
  // (solo interesan los totalCount). Si algo falla, se queda en la rama conservadora
  // ('annotate'), que nunca esconde OCs.
  async function measureCoverage(categoryKey, groups) {
    if (S.coverage.measured) return S.coverage;
    const cov = { measured: true, allCovered: false, nullAccepted: false, orphanCount: null };
    try {
      const [todas, conDir] = await runPool([
        () => queryPOsCount(categoryKey, {}),
        () => queryPOsCount(categoryKey, { billToLocationIdFilter: groups.all }),
      ], POOL);
      if (todas != null && conDir != null) {
        cov.orphanCount = todas - conDir;
        cov.allCovered = cov.orphanCount === 0;
        if (!cov.allCovered) {
          // Sonda única: ¿el server acepta null dentro del array (= incluir huérfanas)?
          const conNull = await queryPOsCount(categoryKey, {
            billToLocationIdFilter: groups.ecoplating.concat([null]),
          });
          const soloEco = await queryPOsCount(categoryKey, {
            billToLocationIdFilter: groups.ecoplating,
          });
          cov.nullAccepted = conNull != null && soloEco != null && conNull > soloEco;
        }
      }
    } catch (_) { /* se queda conservador */ }
    S.coverage = cov;
    return cov;
  }

  function queryPOsCount(categoryKey, extraVars) {
    const cat = Core.categoryByKey(categoryKey);
    if (!cat) return Promise.resolve(null);
    const vars = Object.assign({
      includeArchived: 'NO', filterDraftStageById: null, purchaseOrderStatusIdFilter: null,
      orderBy: ['ID_IN_DOMAIN_DESC'], offset: 0, first: 1, searchQuery: '',
    }, cat.queryVars, extraVars || {});
    return withTimeout(api().query('PurchaseOrders', vars, 'PurchaseOrders'), TIMEOUT_MS)
      .then((d) => (d && d.pagedData && d.pagedData.totalCount != null ? d.pagedData.totalCount : null))
      .catch(() => null);
  }

  // ── búsqueda global ──
  async function runSearch(term) {
    const seq = ++S.seq;
    const raw = { vendors: [], poByCategory: {}, bills: [] };

    // 1) proveedores primero: sus ids alimentan el fan-out de OCs, que es lo que el
    //    searchQuery nativo no sabe hacer.
    let vendorIds = [];
    try {
      const vendors = await filterSearch(Core.FILTER_KEY_VENDOR, term);
      if (seq !== S.seq) return;
      raw.vendors = vendors;
      vendorIds = vendors.map((v) => v.identifier).filter(Boolean);
      renderPanel(term, raw, true);
    } catch (_) { /* sigue sin proveedores */ }

    // 2) OCs: por texto en las 5 vistas, y por proveedor si hubo match.
    const tasks = [];
    for (const cat of Core.PO_CATEGORIES) {
      tasks.push(() => queryPOs(cat.key, { searchQuery: term }).then((n) => [cat.key, n]));
    }
    if (vendorIds.length) {
      for (const cat of Core.PO_CATEGORIES) {
        tasks.push(() => queryPOs(cat.key, { vendorIdFilter: vendorIds }).then((n) => [cat.key, n]));
      }
    }
    tasks.push(() => queryBills(term).then((n) => ['__bills__', n]));

    const results = await runPool(tasks, POOL);
    if (seq !== S.seq) return;
    for (const r of results) {
      if (!r) continue;
      const [key, nodes] = r;
      if (key === '__bills__') raw.bills = nodes;
      else raw.poByCategory[key] = (raw.poByCategory[key] || []).concat(nodes);
    }
    S.lastResults = raw;
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
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; document.body.appendChild(p); }
    positionPanel(anchor, p);
    return p;
  }
  function hidePanel() { const p = document.getElementById(PANEL_ID); if (p) p.remove(); }

  function mkRow(result, domainId) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = 'sa-pof-badge ' + (
      result.type === Core.RESULT_TYPES.PO ? 'sa-pof-b-po'
        : result.type === Core.RESULT_TYPES.VENDOR ? 'sa-pof-b-vendor' : 'sa-pof-b-bill');
    badge.textContent = result.type === Core.RESULT_TYPES.PO ? 'OC'
      : result.type === Core.RESULT_TYPES.VENDOR ? 'PROV' : 'FACT';
    li.appendChild(badge);

    const main = document.createElement('span');
    main.className = 'sa-pof-main';
    // textContent SIEMPRE: los nombres de proveedor vienen de la API (vector cross-user).
    let txt = result.label;
    if (result.vendorName) txt += ' · ' + result.vendorName;
    if (result.type === Core.RESULT_TYPES.BILL && result.poIdInDomain) txt += ' · OC ' + result.poIdInDomain;
    main.textContent = txt;
    main.title = txt;
    li.appendChild(main);

    const meta = document.createElement('span');
    meta.className = 'sa-pof-meta';
    meta.textContent = result.categoryLabel || (result.idInDomain ? '#' + result.idInDomain : '');
    li.appendChild(meta);

    const href = Core.buildResultHref(result, domainId);
    if (href) li.addEventListener('mousedown', (e) => { e.preventDefault(); window.location.assign(href); });
    return li;
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
    head.textContent = partial ? `Buscando «${term}»…` : `${g.total} resultado${g.total === 1 ? '' : 's'} para «${term}»`;
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
      n.textContent = 'Busca en las 5 vistas a la vez · clic para ir';
      p.appendChild(n);
    }
  }

  // ── anclajes DOM (bilingües ES+EN donde dependen de texto) ──
  const NEW_PO_LABEL_RE = /new purchase order|nueva orden de compra/i;

  // El buscador nativo se ancla por su ícono (data-testid, idioma-agnóstico), no por el
  // placeholder, que sí cambia con el locale.
  //
  // OJO: hay 4 `SearchIcon` en la pantalla (el global del header de SH, el de la tabla, el
  // del chat…). El de la tabla se identifica porque COMPARTE CONTENEDOR con el botón de
  // exportar CSV (`DownloadForOfflineOutlinedIcon`) al nivel más cercano — anclaje
  // estructural, sin depender de textos ni de clases generadas.
  const EXPORT_ICON_SEL = 'svg[data-testid="DownloadForOfflineOutlinedIcon"]';

  function findNativeSearchBox() {
    const icons = Array.from(document.querySelectorAll('svg[data-testid="SearchIcon"]'));
    const cands = icons.map((icon) => {
      // contenedor del input al que pertenece este ícono
      let box = null;
      let el = icon.parentElement;
      for (let i = 0; i < 5 && el; i++) {
        if (el.querySelector('input')) { box = el; break; }
        el = el.parentElement;
      }
      if (!box) return { depth: null, ref: null };
      // ¿a qué distancia comparte ancestro con el botón de exportar?
      let depth = null;
      let anc = icon.parentElement;
      for (let k = 0; k < 6 && anc; k++) {
        if (anc.querySelector(EXPORT_ICON_SEL)) { depth = k; break; }
        anc = anc.parentElement;
      }
      return { depth, ref: box };
    });
    const hit = Core.pickNearestByDepth(cands);
    if (hit) return hit;
    // Fallback: el primero visible que no esté pegado al tope de la ventana (header de SH).
    return Core.pickVisibleCandidate(icons.map((icon) => {
      let el = icon.parentElement;
      for (let i = 0; i < 5 && el; i++) { if (el.querySelector('input')) break; el = el.parentElement; }
      const r = el ? el.getBoundingClientRect() : null;
      return { visible: !!(el && el.offsetParent !== null && r && r.top > 80), width: r ? r.width : 0, ref: el };
    }));
  }

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

  // ── inyección: buscador ──
  function injectSearch() {
    if (document.getElementById(SEARCH_ID)) return true;
    const nativeBox = findNativeSearchBox();
    if (!nativeBox || !nativeBox.parentElement) return false;

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
      if (!term) { hidePanel(); return; }
      timer = setTimeout(() => runSearch(term), DEBOUNCE_MS);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePanel(); });
    inp.addEventListener('blur', () => setTimeout(hidePanel, 200));
    inp.addEventListener('focus', () => { if (inp.value.trim() && S.lastResults) renderPanel(inp.value.trim(), S.lastResults, false); });

    box.appendChild(inp);
    // Va DESPUÉS del buscador nativo → queda antes de los filtros ("Creado Por"…).
    nativeBox.parentElement.insertBefore(box, nativeBox.nextSibling);
    return true;
  }

  // ── inyección: toggle ──
  function injectToggle() {
    if (document.getElementById(TOGGLE_ID)) return true;
    const anchor = findNewPoButton();
    if (!anchor || !anchor.parentElement) return false;

    const wrap = document.createElement('div');
    wrap.id = TOGGLE_ID;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Filtrar órdenes de compra por empresa');

    const defs = [
      [Core.MODES.ECOPLATING, 'Ecoplating'],
      [Core.MODES.BOTH, 'Ambos'],
      [Core.MODES.PROQUIPA, 'Proquipa'],
    ];
    for (const [mode, label] of defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.mode = mode;
      b.setAttribute('aria-pressed', 'false');
      b.disabled = true; // se habilita al descubrir las direcciones
      b.addEventListener('click', () => applyMode(mode));
      wrap.appendChild(b);
    }
    anchor.parentElement.insertBefore(wrap, anchor.nextSibling);

    // Descubrimiento diferido: no bloquea la inyección ni la carga de la pantalla.
    discoverLocations().then((groups) => {
      const el = document.getElementById(TOGGLE_ID);
      if (!el) return;
      if (!groups || (!groups.ecoplating.length && !groups.proquipa.length)) {
        // Sin direcciones no se filtra a ciegas: se deja deshabilitado y se dice por qué.
        el.title = 'No se pudieron leer las direcciones de facturación; el filtro por empresa no está disponible.';
        return;
      }
      const current = Core.parseCompanyModeFromUrl(location.href, groups);
      Array.from(el.querySelectorAll('button')).forEach((b) => {
        b.disabled = false;
        b.setAttribute('aria-pressed', String(b.dataset.mode === current));
      });
      el.title = S.capped
        ? 'Aviso: puede haber direcciones de facturación sin descubrir (el filtro de Steelhead devuelve máximo 10 por consulta).'
        : `Ecoplating: ${groups.ecoplating.length} direcciones · Proquipa: ${groups.proquipa.length}`;
    });
    return true;
  }

  async function applyMode(mode) {
    const groups = S.groups || await discoverLocations();
    if (!groups) return;
    const categoryKey = Core.parseCategoryFromUrl(location.href);
    let coverage = S.coverage;
    if (mode === Core.MODES.ECOPLATING && !coverage.measured) {
      coverage = await measureCoverage(categoryKey, groups);
    }
    const plan = Core.planCompanyFilter(mode, groups, coverage);

    if (plan.kind === 'unavailable') {
      alertNote('No hay direcciones de facturación de esa empresa en este dominio.');
      return;
    }
    if (plan.kind === 'annotate') {
      // Fail-safe: no se puede expresar "sin dirección" en el filtro nativo, así que se
      // avisa en vez de esconder OCs que el usuario espera ver.
      const n = plan.orphanCount;
      const ok = window.confirm(
        'Steelhead no permite filtrar las OCs que no tienen dirección de facturación asignada' +
        (n != null ? ` (${n} en esta vista)` : '') + '.\n\n' +
        'Si continúo, se filtra por las direcciones de Ecoplating y esas OCs NO se van a ver.\n\n' +
        '¿Aplico el filtro de todas formas?'
      );
      if (!ok) return;
      window.location.assign(Core.buildCompanyFilterUrl(location.href, plan.ids));
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
    const a = injectSearch();
    const b = injectToggle();
    return a && b;
  }

  function removeAll() {
    for (const id of [SEARCH_ID, TOGGLE_ID, PANEL_ID]) {
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

  window.POListingFilters = { injectAll, removeAll, runSearch, applyMode, discoverLocations };
})();
