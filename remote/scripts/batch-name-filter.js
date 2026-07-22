// Filtrar Lote por Nombre — glue (DOM + red). Consume batch-name-filter-core.js.
// Inyecta un cuadro de búsqueda dark-mode en el header del Panel de Envío
// (/Domains/<id>/Shipping) que, dado un NOMBRE de lote, selecciona de un jalón TODOS
// los lotes con ese nombre exacto vía el parámetro de URL inventoryBatchIdFilter.
//
// UX (definida con el usuario): mientras escribe se muestra un preview en vivo de los
// lotes que coinciden; al dar ENTER se aplica automático (modo REEMPLAZAR el filtro).
//
// Fuente de datos: persisted query InventoryBatchViewQuery (searchQuery + paginación real,
// hideCompleted:true). Devuelve el `name` estructurado → matching exacto robusto y SIN el tope
// de 10 de FilterSearch. En Packing Slips/Scheduling los lotes completados no se filtran, así
// que hideCompleted:true es además lo correcto y más eficiente.
//
// Estado singleton en window.__saBNF (no en el closure) porque injectAppScripts re-evalúa
// el IIFE en cada acción del popup (lección surtido-guard/price-guard).
(function () {
  'use strict';

  const Core = window.BatchNameFilterCore;
  if (!Core) { console.warn('[batch-name-filter] core ausente'); return; }
  function api() { return window.SteelheadAPI; }

  const BOX_ID = 'sa-bnf-box';
  const STYLE_ID = 'sa-bnf-style';
  const PANEL_ID = 'sa-bnf-panel';
  const DEBOUNCE_MS = 300;

  const S = (window.__saBNF = window.__saBNF || { seq: 0, lastQuery: '', lastResult: null });

  // ── estilos dark-mode (una vez) ──
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #${BOX_ID}{position:relative;display:flex;align-items:center;gap:6px;margin:0 8px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
      #${BOX_ID} .sa-bnf-inp{background:#141a23;color:#e6e9ee;border:1px solid #3a4757;border-radius:6px;padding:5px 8px;font-size:12px;width:150px;outline:none;}
      #${BOX_ID} .sa-bnf-inp:focus{border-color:#13a36f;}
      #${BOX_ID} .sa-bnf-inp::placeholder{color:#7f8b99;}
      #${BOX_ID} .sa-bnf-clear{background:#1c2430;color:#9aa7b5;border:1px solid #33404f;border-radius:6px;padding:4px 7px;font-size:12px;cursor:pointer;line-height:1;}
      #${BOX_ID} .sa-bnf-clear:hover{color:#e6e9ee;border-color:#13a36f;}
      #${PANEL_ID}{position:fixed;min-width:260px;max-width:360px;background:#1c2430;color:#e6e9ee;border:1px solid #33404f;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:2147483600;padding:8px;font-size:12px;}
      #${PANEL_ID} .sa-bnf-head{color:#f0f3f7;font-weight:600;margin-bottom:6px;}
      #${PANEL_ID} .sa-bnf-hint{color:#9aa7b5;font-size:11px;margin-top:6px;}
      #${PANEL_ID} .sa-bnf-warn{background:#3a2a1c;border:1px solid #6b4a2e;color:#f0a35e;border-radius:6px;padding:5px 7px;margin-top:6px;font-size:11px;}
      #${PANEL_ID} ul{list-style:none;margin:0;padding:0;max-height:220px;overflow-y:auto;}
      #${PANEL_ID} li{padding:3px 4px;border-bottom:1px solid #263140;color:#cfd6de;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #${PANEL_ID} li:last-child{border-bottom:none;}
      #${PANEL_ID} .sa-bnf-acc{color:#13a36f;}
    `;
    document.head.appendChild(st);
  }

  // ── encontrar el header del panel y el hijo del toggle KGM/LBR ──
  function getHeader() {
    const cands = document.querySelectorAll('div.MuiPaper-root');
    for (const el of cands) {
      const t = el.textContent || '';
      if (/KGM/.test(t) && /LBR/.test(t) && el.children.length <= 10) {
        try { if (getComputedStyle(el).display === 'flex') return el; } catch (_) { return el; }
      }
    }
    return null;
  }
  function getKgmChild(header) {
    return Array.from(header.children).find((c) => /KGM/.test(c.textContent || '') && /LBR/.test(c.textContent || ''));
  }

  // ── render del preview ──
  function positionPanel(box, p) {
    const inp = box.querySelector('.sa-bnf-inp');
    if (!inp) return;
    const r = inp.getBoundingClientRect();
    p.style.top = (r.bottom + 4) + 'px';
    p.style.left = r.left + 'px';
  }
  // El panel vive en document.body (position:fixed) porque el header MuiPaper tiene
  // overflow-y:hidden y recortaría un panel absolute anclado dentro del box.
  function ensurePanel(box) {
    let p = document.getElementById(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; document.body.appendChild(p); }
    positionPanel(box, p);
    return p;
  }
  function hidePanel() { const p = document.getElementById(PANEL_ID); if (p) p.remove(); }

  function renderPreview(box, name, result) {
    const p = ensurePanel(box);
    p.textContent = '';
    const head = document.createElement('div');
    head.className = 'sa-bnf-head';
    if (!result) { head.textContent = 'Buscando…'; p.appendChild(head); return; }
    const { matches, count, capped } = result;
    if (count === 0) {
      head.textContent = `Sin lotes «${name}»`;
      p.appendChild(head);
      return;
    }
    head.innerHTML = '';
    head.appendChild(document.createTextNode(`Aplicar `));
    const acc = document.createElement('span'); acc.className = 'sa-bnf-acc'; acc.textContent = `${count} lote${count === 1 ? '' : 's'} «${name}»`;
    head.appendChild(acc);
    p.appendChild(head);
    const ul = document.createElement('ul');
    matches.slice(0, 30).forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m.display;               // textContent → sin XSS
      li.title = m.display;
      ul.appendChild(li);
    });
    p.appendChild(ul);
    if (capped) {
      const w = document.createElement('div'); w.className = 'sa-bnf-warn';
      w.textContent = '⚠️ Muchísimos lotes con este nombre; se aplican los primeros encontrados.';
      p.appendChild(w);
    }
    const hint = document.createElement('div'); hint.className = 'sa-bnf-hint';
    hint.textContent = 'Enter para aplicar · reemplaza el filtro de lote actual';
    p.appendChild(hint);
  }

  // ── InventoryBatchViewQuery paginada (sin tope de 10; name estructurado) ──
  // Trae los lotes NO-completados cuyo name contiene `name` (searchQuery, substring server-side).
  async function fetchBatchesByName(name) {
    const PAGE = Core.INVENTORY_BATCH_VIEW_PAGE;
    const all = [];
    let offset = 0;
    let capped = false;
    for (let guard = 0; guard < 25; guard++) { // cap duro 25*PAGE por seguridad
      const data = await api().query('InventoryBatchViewQuery', {
        includeArchived: 'NO', hideCompleted: true, orderBy: ['CREATED_AT_DESC'],
        offset, first: PAGE, searchQuery: name,
      }, 'InventoryBatchViewQuery');
      const pd = data && data.pagedData;
      const nodes = (pd && pd.nodes) || [];
      all.push(...nodes);
      const total = pd && pd.totalCount;
      offset += PAGE;
      if (nodes.length < PAGE) break;
      if (total != null && all.length >= total) break;
      if (guard === 24) capped = true;
    }
    return { nodes: all, capped };
  }

  // debounced, con token de secuencia
  async function runSearch(box, name) {
    const seq = ++S.seq;
    renderPreview(box, name, null); // "Buscando…"
    let res;
    try {
      res = await fetchBatchesByName(name);
    } catch (e) {
      if (seq !== S.seq) return;
      const p = ensurePanel(box); p.textContent = '';
      const h = document.createElement('div'); h.className = 'sa-bnf-head'; h.textContent = 'Error al buscar (¿hash rotado?)';
      p.appendChild(h);
      return;
    }
    if (seq !== S.seq) return; // llegó una búsqueda más nueva
    const result = Core.selectByExactName(res.nodes, name);
    result.capped = res.capped;
    S.lastQuery = name; S.lastResult = result;
    renderPreview(box, name, result);
  }

  // ── aplicar (Enter) ──
  function applyCurrent() {
    const r = S.lastResult;
    if (!r || !r.ids.length) return;
    const url = Core.buildFilterUrl(location.href, r.ids, 'replace');
    window.location.assign(url); // recarga la SPA con el filtro (pushState no re-filtra fiable)
  }
  function clearFilter() {
    window.location.assign(Core.buildClearUrl(location.href));
  }

  // ── inyección del box ──
  function injectBox() {
    if (!Core.isShippingUrl(location.pathname)) return;
    if (document.getElementById(BOX_ID)) return;
    const header = getHeader();
    if (!header) return;
    injectStyles();

    const box = document.createElement('div');
    box.id = BOX_ID;

    const inp = document.createElement('input');
    inp.className = 'sa-bnf-inp';
    inp.type = 'text';
    inp.placeholder = 'Lote por nombre…';
    inp.setAttribute('aria-label', 'Filtrar lote de inventario por nombre');

    let timer = null;
    inp.addEventListener('input', () => {
      const name = inp.value.trim();
      if (timer) clearTimeout(timer);
      S.seq++; // invalida búsquedas en vuelo
      if (!name) { hidePanel(); S.lastResult = null; return; }
      timer = setTimeout(() => runSearch(box, name), DEBOUNCE_MS);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyCurrent(); }
      else if (e.key === 'Escape') { hidePanel(); }
    });
    inp.addEventListener('blur', () => { setTimeout(hidePanel, 150); });

    const clear = document.createElement('button');
    clear.className = 'sa-bnf-clear';
    clear.type = 'button';
    clear.title = 'Quitar el filtro de lote';
    clear.textContent = '✕ lote';
    clear.addEventListener('click', clearFilter);

    box.appendChild(inp);
    box.appendChild(clear);

    const anchor = getKgmChild(header);
    if (anchor) header.insertBefore(box, anchor);
    else header.appendChild(box);
  }

  // ── observer (se AUTO-DESCONECTA al inyectar) + gate por URL ──
  // Un observer permanente sobre body.subtree es caro en el Panel de Envío (re-renderiza
  // mucho). Solo observamos mientras esperamos que monte el header; al inyectar el box,
  // desconectamos. Se reactiva en cada cambio de URL hacia Shipping.
  let obs = null;
  function stopObs() { if (obs) { obs.disconnect(); obs = null; } }
  function startObs() {
    if (obs) return;
    obs = new MutationObserver(() => {
      if (!Core.isShippingUrl(location.pathname)) { stopObs(); return; }
      injectBox();
      if (document.getElementById(BOX_ID)) stopObs();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  function onUrlChange() {
    if (Core.isShippingUrl(location.pathname)) {
      injectBox();
      if (!document.getElementById(BOX_ID)) startObs();
    } else {
      stopObs();
      const b = document.getElementById(BOX_ID); if (b) b.remove();
    }
  }
  function patchHistory() {
    if (window.__saBNFHistoryPatched) return;
    window.__saBNFHistoryPatched = true;
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); window.dispatchEvent(new Event('sa-bnf-url')); return r; };
    }
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('sa-bnf-url')));
    window.addEventListener('sa-bnf-url', onUrlChange);
  }

  function init() {
    patchHistory();
    onUrlChange(); // inyecta el box o arranca el observer según la URL actual
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);

  window.BatchNameFilter = { injectBox, applyCurrent, clearFilter };
})();
