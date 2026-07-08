// Specs en el dashboard de Números de Parte — glue DOM.
// En /PartNumbers agrega una COLUMNA "Specs / Params num." a la tabla y, con un
// TOGGLE persistente en el header, enriquece cada NP visible con sus SPECS y sus
// PARÁMETROS NUMÉRICOS (nombre + rango + unidad). La decisión pura vive en
// PnSpecsColumnCore; aquí solo va el DOM, el fetch y el memory-hardening.
//
// Por qué un 2º query: `AllPartNumbers` (el del dashboard) NO trae specs/params
// (verificado 2026-07-08). Solo `GetPartNumber` los expone → 1 query pesado por NP.
// Por eso el enriquecimiento es OPT-IN (toggle) y con memory-hardening completo.
//
// Auto-inyectado (autoInject:true). Singleton en window.__saPnSpecs* para sobrevivir
// la RE-INYECCIÓN del IIFE (background.js re-evalúa scripts en cada acción del popup).
const PnSpecsColumn = (() => {
  'use strict';

  const Core = () => window.PnSpecsColumnCore;
  const Cleanup = () => window.SteelheadHostCleanup;

  const STORAGE_KEY = 'sa_pn_specs_col_enabled';   // persistente entre sesiones
  const COL_LABEL = 'Specs / Params num.';
  const MAX_CONC = 4;              // GetPartNumber en paralelo (pesado)
  const MIN_GAP_MS = 130;          // ~7 req/s: no saturar el gateway
  const RETRY_BACKOFF = [0, 800, 2500];   // reintentos SOLO en transitorios
  const OBS_DEBOUNCE_MS = 160;

  // ── Estado persistente / singleton ─────────────────────────────────────────
  function isEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
  }
  function setEnabled(v) {
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (_) {}
  }
  function onIndex() { return Core().isPartNumbersIndexPath(location.pathname); }

  // Cache slim por partNumberId: id → { specs, total } (NO el response completo).
  function cache() {
    if (!window.__saPnSpecsCache) window.__saPnSpecsCache = new Map();
    return window.__saPnSpecsCache;
  }

  // ── Estilos (dark-mode para el toggle/toast — regla de diseño; la columna se
  //    integra a la tabla clara de SH pero marcada con el acento verde) ────────
  function injectStyles() {
    if (document.getElementById('sa-pnspec-style')) return;
    const css = [
      // Toggle en el header (UI nuestra → dark-mode; delgado para no abultar la barra)
      '.sa-pnspec-toggle{display:inline-flex;align-items:center;gap:6px;background:#1c2430;',
      'color:#e6e9ee;border:1px solid #2b3645;border-radius:6px;',
      'padding:2px 8px;margin:0 8px;font-size:11px;font-weight:600;cursor:pointer;user-select:none;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;line-height:1.35;}',
      '.sa-pnspec-toggle:hover{border-color:#13a36f;}',
      '.sa-pnspec-sw{position:relative;width:26px;height:14px;border-radius:7px;',
      'background:#394452;transition:background .15s;flex:0 0 auto;}',
      '.sa-pnspec-sw::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;',
      'border-radius:50%;background:#e6e9ee;transition:transform .15s;}',
      '.sa-pnspec-toggle.on .sa-pnspec-sw{background:#13a36f;}',
      '.sa-pnspec-toggle.on .sa-pnspec-sw::after{transform:translateX(12px);}',
      '.sa-pnspec-count{font-weight:400;color:#9aa7b5;font-size:10px;}',
      // Columna: hereda el look nativo de la tabla (el th/td copia la className MUI);
      // aquí solo el separador sutil (gris punteado) y el layout de los chips. NO se
      // fuerza font-weight/color/background del texto → el encabezado se ve igual que
      // los nativos.
      'th.sa-pnspec-cell{border-left:1px dashed #c7ccd1 !important;white-space:nowrap;}',
      'td.sa-pnspec-cell{border-left:1px dashed #c7ccd1 !important;vertical-align:top;min-width:180px;max-width:340px;}',
      '.sa-pnspec-spec{margin:0 0 4px 0;}',
      '.sa-pnspec-spec:last-child{margin-bottom:0;}',
      '.sa-pnspec-spec-name{font-weight:700;color:#0d6b49;display:block;font-size:12px;}',
      'a.sa-pnspec-spec-name{cursor:pointer;text-decoration:none;}',
      'a.sa-pnspec-spec-name:hover{text-decoration:underline;}',
      '.sa-pnspec-param{display:inline-block;background:#eef6f2;border:1px solid #cfe6db;color:#14503a;',
      'border-radius:6px;padding:1px 6px;margin:2px 4px 0 0;font-size:11px;white-space:nowrap;}',
      '.sa-pnspec-muted{color:#8a97a5;font-style:italic;font-size:12px;}',
      '.sa-pnspec-err{color:#b04a3a;font-size:12px;}',
      // Toast (dark-mode)
      '.sa-pnspec-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483600;',
      'background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;border-left:4px solid #13a36f;',
      'border-radius:10px;padding:12px 18px;font-size:14px;max-width:80vw;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);}',
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-pnspec-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg) {
    injectStyles();
    let el = document.getElementById('sa-pnspec-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-pnspec-toast'; el.className = 'sa-pnspec-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { const e = document.getElementById('sa-pnspec-toast'); if (e) e.remove(); }, 4500);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Toggle en el header
  // ════════════════════════════════════════════════════════════════════════
  function findHeaderAnchor() {
    // Ancla natural: el botón "NUEVO NÚMERO DE PARTE" (control propio del dashboard).
    const btn = Array.prototype.slice.call(document.querySelectorAll('button, a'))
      .find(function (b) { return /NUEVO NÚMERO DE PARTE/i.test((b.innerText || '').trim()); });
    if (!btn) return null;
    // Sube hasta el wrapper cuyo padre es la barra de controles (varios hijos).
    let el = btn;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      if (el.parentElement.children.length > 1) return { bar: el.parentElement, before: el };
      el = el.parentElement;
    }
    return { bar: btn.parentElement, before: btn };
  }

  function buildToggle() {
    injectStyles();
    const wrap = document.createElement('div');
    wrap.className = 'sa-pnspec-toggle' + (isEnabled() ? ' on' : '');
    wrap.id = 'sa-pnspec-toggle';
    wrap.title = 'Muestra las specs y parámetros numéricos de cada NP (hace 1 consulta por NP visible).';
    const sw = document.createElement('span'); sw.className = 'sa-pnspec-sw';
    const txt = document.createElement('span'); txt.textContent = '🧪 Specs num.';
    const cnt = document.createElement('span'); cnt.className = 'sa-pnspec-count'; cnt.id = 'sa-pnspec-count';
    const mem = document.createElement('span'); mem.className = 'sa-pnspec-count'; mem.id = 'sa-pnspec-mem'; // el mem monitor escribe aquí
    wrap.appendChild(sw); wrap.appendChild(txt); wrap.appendChild(cnt); wrap.appendChild(mem);
    wrap.addEventListener('click', function () { toggle(); });
    return wrap;
  }

  function ensureToggle() {
    if (!onIndex()) return;
    if (document.getElementById('sa-pnspec-toggle')) return;   // ya está
    const anchor = findHeaderAnchor();
    if (!anchor) return;   // header aún no renderiza: el observer reintenta
    anchor.bar.insertBefore(buildToggle(), anchor.before);
    refreshToggleUI();
  }

  function refreshToggleUI() {
    const t = document.getElementById('sa-pnspec-toggle');
    if (t) t.classList.toggle('on', isEnabled());
    updateCount();
  }

  function updateCount() {
    const c = document.getElementById('sa-pnspec-count');
    if (!c) return;
    if (!isEnabled()) { c.textContent = ''; return; }
    const total = document.querySelectorAll('td.sa-pnspec-cell').length;
    const done = document.querySelectorAll('td.sa-pnspec-cell[data-sa-state="done"]').length;
    const err = document.querySelectorAll('td.sa-pnspec-cell[data-sa-state="error"]').length;
    c.textContent = total ? (done + err) + '/' + total : '';
  }

  // ════════════════════════════════════════════════════════════════════════
  // Columna
  // ════════════════════════════════════════════════════════════════════════
  function getTable() { return document.querySelector('table'); }

  // La columna es SIEMPRE la ÚLTIMA celda de su fila, y se re-posiciona en cada
  // sync. Motivo: al re-render de React (filtrar/paginar), el <th> inyectado
  // "flota" a otra posición mientras los <td> se recrean en la penúltima → se
  // desalineaban (header en una columna, chips en otra). Forzar "última celda"
  // tanto en thead como en cada tr los mantiene siempre alineados, sin importar
  // cómo React reordene sus propias columnas. Idempotente: appendChild solo actúa
  // si la celda no es ya la última, así que en estado estable es no-op.
  function ensureHeaderCell(table) {
    const headRow = table.querySelector('thead tr');
    if (!headRow) return;
    let th = headRow.querySelector(':scope > .sa-pnspec-cell');
    if (!th) {
      th = document.createElement('th');
      // Hereda la className MUI de un th nativo → el texto del encabezado se ve
      // igual que los demás (mismo font/peso/color/padding). Nuestra marca es solo
      // el separador punteado gris de `.sa-pnspec-cell`.
      const nativeTh = headRow.querySelector('th:not(.sa-pnspec-cell)');
      th.className = (nativeTh ? nativeTh.className + ' ' : '') + 'sa-pnspec-cell';
      th.textContent = COL_LABEL;
    }
    if (headRow.lastElementChild !== th) headRow.appendChild(th);   // (re)posiciona al final
  }

  function pendingCell(td) {
    td.setAttribute('data-sa-state', 'pending');
    td.textContent = '';
    const s = document.createElement('span'); s.className = 'sa-pnspec-muted'; s.textContent = '⏳';
    td.appendChild(s);
  }

  function ensureBodyCells(table) {
    const rows = table.querySelectorAll('tbody tr');
    const toFetch = [];
    rows.forEach(function (tr) {
      let td = tr.querySelector(':scope > .sa-pnspec-cell');
      if (!td) {
        const link = tr.querySelector('td a[href*="/PartNumbers/"]');
        const pnId = link ? Core().parsePartNumberId(link.getAttribute('href') || link.href) : null;
        td = document.createElement('td');
        // Hereda la className MUI de una celda nativa (padding/borde/tipografía de fila).
        const nativeTd = tr.querySelector('td:not(.sa-pnspec-cell)');
        td.className = (nativeTd ? nativeTd.className + ' ' : '') + 'sa-pnspec-cell';
        if (pnId) {
          td.setAttribute('data-sa-pnid', String(pnId));
          const cached = cache().get(pnId);
          if (cached) { renderCell(td, cached); }
          else { pendingCell(td); toFetch.push(pnId); }
        } else {
          td.setAttribute('data-sa-state', 'na');
          const s = document.createElement('span'); s.className = 'sa-pnspec-muted'; s.textContent = '—'; td.appendChild(s);
        }
      }
      if (tr.lastElementChild !== td) tr.appendChild(td);   // (re)posiciona al final
    });
    return toFetch;
  }

  // Render seguro (sin innerHTML de datos: textContent → no XSS con nombres de spec).
  function renderCell(td, result) {
    td.setAttribute('data-sa-state', 'done');
    td.textContent = '';
    const specs = (result && result.specs) || [];
    if (!specs.length) { const m = document.createElement('span'); m.className = 'sa-pnspec-muted'; m.textContent = 'sin specs'; td.appendChild(m); return; }
    specs.forEach(function (s) {
      const box = document.createElement('div'); box.className = 'sa-pnspec-spec';
      // Nombre de la spec = link a la spec (nueva pestaña → no pierde el filtro/scroll
      // del dashboard). Si no se puede armar la URL, cae a texto plano.
      const href = Core().specUrl(s);
      const nm = document.createElement(href ? 'a' : 'span');
      nm.className = 'sa-pnspec-spec-name'; nm.textContent = s.specName;
      if (href) { nm.href = href; nm.target = '_blank'; nm.rel = 'noopener'; }
      box.appendChild(nm);
      if (!s.numericParams.length) {
        const none = document.createElement('span'); none.className = 'sa-pnspec-muted'; none.textContent = 'sin params num.';
        box.appendChild(none);
      } else {
        s.numericParams.forEach(function (p) {
          const chip = document.createElement('span'); chip.className = 'sa-pnspec-param';
          chip.textContent = p.value ? p.name + ': ' + p.value : p.name;
          box.appendChild(chip);
        });
      }
      td.appendChild(box);
    });
  }

  function renderError(td) {
    td.setAttribute('data-sa-state', 'error');
    td.textContent = '';
    const e = document.createElement('span'); e.className = 'sa-pnspec-err'; e.textContent = '⚠️ error';
    td.appendChild(e);
  }

  function removeColumn() {
    document.querySelectorAll('.sa-pnspec-cell').forEach(function (el) { el.remove(); });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Enriquecimiento (pool con concurrencia + rate-limit + retry transitorio)
  // ════════════════════════════════════════════════════════════════════════
  function pool() {
    if (!window.__saPnSpecsPool) window.__saPnSpecsPool = { queue: [], inFlight: 0, lastLaunch: 0, active: false, drain: null, count: 0 };
    return window.__saPnSpecsPool;
  }

  function enqueue(ids) {
    const p = pool();
    const seen = new Set(p.queue);
    ids.forEach(function (id) { if (!seen.has(id) && !cache().has(id)) { p.queue.push(id); seen.add(id); } });
    pump();
  }

  function isTransient(err) {
    if (!err) return false;
    if (err.persistedQueryRotated) return false;   // hash rotado: reintentar no sirve
    const m = (err.message || '').toLowerCase();
    return /timeout|network|failed to fetch|50\d|429|aborted/.test(m);
  }

  async function fetchOne(pnId) {
    const api = window.SteelheadAPI;
    for (let attempt = 0; attempt < RETRY_BACKOFF.length; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, RETRY_BACKOFF[attempt]); });
      try {
        const data = await api.query('GetPartNumber', { partNumberId: pnId, usagesLimit: 0, usagesOffset: 0 });
        const res = Core().extractSpecsWithNumericParams(data);
        return { specs: res.specs, total: res.totalNumericParams };   // slim
      } catch (e) {
        if (attempt === RETRY_BACKOFF.length - 1 || !isTransient(e)) throw e;
      }
    }
  }

  function fillCells(pnId, result, isError) {
    document.querySelectorAll('td.sa-pnspec-cell[data-sa-pnid="' + pnId + '"]').forEach(function (td) {
      if (isError) renderError(td); else renderCell(td, result);
    });
    updateCount();
  }

  function pump() {
    const p = pool();
    if (!isEnabled() || !onIndex()) return;
    const now = Date.now();
    while (p.inFlight < MAX_CONC && p.queue.length) {
      // rate-limit: separa los lanzamientos al menos MIN_GAP_MS
      const wait = p.lastLaunch + MIN_GAP_MS - Date.now();
      if (wait > 0) { setTimeout(pump, wait + 5); return; }
      const pnId = p.queue.shift();
      p.inFlight++;
      p.lastLaunch = Date.now();
      // Primer trabajo real del run → detener Datadog session replay (memory).
      try { if (Cleanup() && !window.__sa_dd_stopped) Cleanup().stopDatadogSessionReplay(); } catch (_) {}
      fetchOne(pnId).then(function (result) {
        cache().set(pnId, result);
        fillCells(pnId, result, false);
      }).catch(function (e) {
        fillCells(pnId, null, true);
        if (e && e.persistedQueryRotated) toast('⚠️ El hash de GetPartNumber rotó — avísale a Claude para actualizarlo.');
        else console.warn('[SA] pn-specs: GetPartNumber ' + pnId + ' falló:', e && e.message);
      }).then(function () {
        p.inFlight--;
        p.count++;
        // Drain de Apollo cada N PNs (memory EJE B).
        try { if (p.drain) p.drain(); } catch (_) {}
        pump();
      });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Memory hardening (EJE B): mem monitor + guardrail + periodic drain
  // ════════════════════════════════════════════════════════════════════════
  function startMonitor() {
    const c = Cleanup();
    if (!c) return;
    const p = pool();
    if (!p.drain && typeof c.makePeriodicDrain === 'function') p.drain = c.makePeriodicDrain(25);
    if (window.__saPnSpecsMon || typeof c.createMemMonitor !== 'function') return;
    window.__saPnSpecsMon = c.createMemMonitor({
      getElement: function () { return document.getElementById('sa-pnspec-mem'); },
      onGuardrail: function (pct) {
        // 88%: aborta el enriquecimiento y avisa. Checkpoint > crash.
        const p2 = pool(); p2.queue.length = 0;
        toast('🛑 Memoria alta (' + pct + '%) — enriquecimiento pausado. Recarga la página si notas lentitud.');
      },
    });
    window.__saPnSpecsMon.start();
  }
  function stopMonitor() {
    if (window.__saPnSpecsMon) { try { window.__saPnSpecsMon.stop(); } catch (_) {} window.__saPnSpecsMon = null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Observer de la tabla (React re-renderiza al paginar/ordenar/filtrar)
  // ════════════════════════════════════════════════════════════════════════
  let obsTimer = null;
  function scheduleSync() {
    if (obsTimer) return;
    obsTimer = setTimeout(function () { obsTimer = null; try { syncColumn(); } catch (_) {} }, OBS_DEBOUNCE_MS);
  }

  function syncColumn() {
    if (!isEnabled() || !onIndex()) return;
    ensureToggle();
    const table = getTable();
    if (!table) return;
    injectStyles();
    ensureHeaderCell(table);
    const toFetch = ensureBodyCells(table);
    if (toFetch.length) enqueue(toFetch);
    updateCount();
  }

  function observe() {
    if (window.__saPnSpecsObs) return;
    const obs = new MutationObserver(function () { scheduleSync(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saPnSpecsObs = obs;
  }
  function teardownObserver() {
    if (window.__saPnSpecsObs) { window.__saPnSpecsObs.disconnect(); window.__saPnSpecsObs = null; }
    if (obsTimer) { clearTimeout(obsTimer); obsTimer = null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Activar / desactivar
  // ════════════════════════════════════════════════════════════════════════
  function activate() {
    if (!onIndex()) return;
    injectStyles();
    startMonitor();
    observe();
    syncColumn();   // inyecta columna + encola los visibles
  }

  function deactivate() {
    const p = pool();
    p.queue.length = 0;     // cancela pendientes (in-flight terminan solos, baratos)
    teardownObserver();
    stopMonitor();
    removeColumn();
    refreshToggleUI();
  }

  function toggle() {
    const next = !isEnabled();
    setEnabled(next);
    refreshToggleUI();
    if (next) { toast('🧪 Specs num.: ACTIVADO — cargando specs de los NP visibles…'); activate(); }
    else { toast('🧪 Specs num.: DESACTIVADO'); deactivate(); }
    return { enabled: next };
  }

  // Handler para el popup de la extensión (además del toggle del header).
  function toggleFromPopup() { return toggle(); }

  // ════════════════════════════════════════════════════════════════════════
  // Navegación SPA
  // ════════════════════════════════════════════════════════════════════════
  function installUrlChangeListener() {
    if (!window.__saPnSpecsUrlListener) {
      window.__saPnSpecsUrlListener = true;
      const fire = function () { window.dispatchEvent(new Event('sa-urlchange')); };
      ['pushState', 'replaceState'].forEach(function (m) {
        const orig = history[m];
        history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
      });
      window.addEventListener('popstate', fire);
    }
    window.addEventListener('sa-urlchange', function () {
      if (onIndex()) {
        ensureToggle();
        observe();               // el observer siempre corre en el index (para el toggle)
        if (isEnabled()) activate();
      } else {
        // Salimos del index: limpia todo (memory) — la cache slim se descarta.
        deactivate();
        cache().clear();
      }
    });
  }

  function init() {
    if (window.__saPnSpecsInit) return;
    window.__saPnSpecsInit = true;
    installUrlChangeListener();
    if (onIndex()) {
      ensureToggle();
      observe();                 // corre siempre en el index para mantener el toggle
      if (isEnabled()) activate();
    }
    console.log('[SA] PnSpecsColumn activo (columna de specs/params num. en /PartNumbers)');
  }

  return {
    init, toggleFromPopup, toggle,
    _getState: function () {
      const p = pool();
      return {
        enabled: isEnabled(), onIndex: onIndex(),
        cells: document.querySelectorAll('td.sa-pnspec-cell').length,
        done: document.querySelectorAll('td.sa-pnspec-cell[data-sa-state="done"]').length,
        cached: cache().size, queue: p.queue.length, inFlight: p.inFlight,
      };
    },
  };
})();

if (typeof window !== 'undefined') {
  window.PnSpecsColumn = PnSpecsColumn;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { PnSpecsColumn.init(); });
  } else {
    PnSpecsColumn.init();
  }
}
