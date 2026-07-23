// Columnas en el listado de Órdenes de Trabajo — glue DOM.
// En /Domains/<d>/WorkOrders agrega dos columnas opt-in (dos toggles):
//   🔩 "Número de Parte"  — cada PN = link a /PartNumbers/<id> (soporta N PNs).
//   📅 "Programación"      — estación · fecha/hora · estado de la tarea agendada.
// La decisión pura vive en WoScheduleCore; aquí solo va el DOM, el fetch y el
// memory-hardening. Molde: pn-specs-column.js.
//
// Fetch:
//   - Por FILA: PartNumbersByWorkOrderIdInDomain({idInDomain}) → {pns, woGlobalId}
//     (AllWorkOrders NO trae el nombre del PN; esta query es ligera). Da también el
//     workOrderId GLOBAL, necesario para cruzar contra la programación.
//   - Por PÁGINA (una sola vez): WorkOrderSchedule({domainId, workOrderId}) → board
//     COMPLETO (todas las tareas del schedule) → índice slim workOrderId→tareas → llena
//     todas las celdas de Programación. Es ~4.6MB pero UNA llamada; el raw se descarta
//     tras indexar (solo se guarda el índice slim).
//
// Auto-inyectado (autoInject:true). Singleton en window.__saWoCols* para sobrevivir la
// re-inyección del IIFE.
const WoListingColumns = (() => {
  'use strict';

  const Core = () => window.WoScheduleCore;
  const Cleanup = () => window.SteelheadHostCleanup;

  const PN_KEY = 'sa_wo_pn_col_enabled';       // persistente, default OFF
  const SCHED_KEY = 'sa_wo_sched_col_enabled'; // persistente, default OFF
  const MAX_CONC = 4;
  const MIN_GAP_MS = 130;
  const RETRY_BACKOFF = [0, 800, 2500];
  const OBS_DEBOUNCE_MS = 160;

  const COLS = [
    { key: 'pn',    cls: 'sa-wocol-pn',    label: 'Número de Parte', on: isPnOn },
    { key: 'sched', cls: 'sa-wocol-sched', label: 'Programación',    on: isSchedOn },
  ];

  // ── Estado persistente / singleton ─────────────────────────────────────────
  function getFlag(k) { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } }
  function setFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (_) {} }
  function isPnOn() { return getFlag(PN_KEY); }
  function isSchedOn() { return getFlag(SCHED_KEY); }
  function anyOn() { return isPnOn() || isSchedOn(); }
  function onIndex() { return Core().isWorkOrdersIndexPath(location.pathname); }

  // Cache slim por idInDomain: { pns:[{id,name}], woGlobalId }.
  function cache() {
    if (!window.__saWoRowCache) window.__saWoRowCache = new Map();
    return window.__saWoRowCache;
  }
  // Índice de programación slim (byWorkOrderId) — se guarda el índice, NO el raw de 4.6MB.
  function board() {
    if (!window.__saWoBoard) window.__saWoBoard = { idx: null, state: 'idle' }; // idle|loading|ready|error
    return window.__saWoBoard;
  }

  // ── Estilos ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-wocol-style')) return;
    const css = [
      '.sa-wocol-bar{display:flex;align-items:center;flex-wrap:wrap;gap:0;margin:6px 0;}',
      '.sa-wocol-toggle{display:inline-flex;align-items:center;gap:6px;background:#1c2430;',
      'color:#e6e9ee;border:1px solid #2b3645;border-radius:6px;',
      'padding:3px 10px;margin:0 8px 4px 0;font-size:11px;font-weight:600;cursor:pointer;user-select:none;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;line-height:1.35;}',
      '.sa-wocol-toggle:hover{border-color:#13a36f;}',
      '.sa-wocol-sw{position:relative;width:26px;height:14px;border-radius:7px;',
      'background:#394452;transition:background .15s;flex:0 0 auto;}',
      '.sa-wocol-sw::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;',
      'border-radius:50%;background:#e6e9ee;transition:transform .15s;}',
      '.sa-wocol-toggle.on .sa-wocol-sw{background:#13a36f;}',
      '.sa-wocol-toggle.on .sa-wocol-sw::after{transform:translateX(12px);}',
      '.sa-wocol-count{font-weight:400;color:#9aa7b5;font-size:10px;}',
      'th.sa-wocol-pn,th.sa-wocol-sched{border-left:1px dashed #c7ccd1 !important;white-space:nowrap;}',
      'td.sa-wocol-pn,td.sa-wocol-sched{border-left:1px dashed #c7ccd1 !important;vertical-align:middle;}',
      'td.sa-wocol-pn{min-width:120px;max-width:280px;}',
      'td.sa-wocol-sched{min-width:150px;max-width:300px;}',
      'a.sa-wocol-pn-link{color:#0969da;cursor:pointer;text-decoration:none;display:inline-block;margin:1px 6px 1px 0;font-size:12px;}',
      'a.sa-wocol-pn-link:hover{text-decoration:underline;}',
      '.sa-wocol-sched-st{font-weight:600;color:#0d6b49;font-size:12px;display:block;}',
      '.sa-wocol-sched-meta{color:#5a6b7a;font-size:11px;}',
      '.sa-wocol-muted{color:#8a97a5;font-style:italic;font-size:12px;}',
      '.sa-wocol-err{color:#b04a3a;font-size:12px;}',
      '.sa-wocol-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483600;',
      'background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;border-left:4px solid #13a36f;',
      'border-radius:10px;padding:12px 18px;font-size:14px;max-width:80vw;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);}',
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-wocol-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg) {
    injectStyles();
    let el = document.getElementById('sa-wocol-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-wocol-toast'; el.className = 'sa-wocol-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { const e = document.getElementById('sa-wocol-toast'); if (e) e.remove(); }, 4500);
  }

  // ── Toggles (barra propia antes de la tabla) ────────────────────────────────
  function getTable() { return document.querySelector('table.MuiTable-root, table'); }

  function buildToggle(kind, label, icon) {
    const on = kind === 'pn' ? isPnOn() : isSchedOn();
    const wrap = document.createElement('div');
    wrap.className = 'sa-wocol-toggle' + (on ? ' on' : '');
    wrap.id = 'sa-wocol-toggle-' + kind;
    wrap.title = kind === 'pn'
      ? 'Muestra el Número de Parte de cada OT (1 consulta por OT visible).'
      : 'Muestra la programación (estación · fecha · estado) de cada OT (1 consulta del tablero por página).';
    const sw = document.createElement('span'); sw.className = 'sa-wocol-sw';
    const txt = document.createElement('span'); txt.textContent = icon + ' ' + label;
    const cnt = document.createElement('span'); cnt.className = 'sa-wocol-count'; cnt.id = 'sa-wocol-count-' + kind;
    wrap.appendChild(sw); wrap.appendChild(txt); wrap.appendChild(cnt);
    wrap.addEventListener('click', function () { toggle(kind); });
    return wrap;
  }

  function ensureToggles() {
    if (!onIndex()) return;
    if (document.getElementById('sa-wocol-bar')) return;
    const table = getTable();
    if (!table) return;
    injectStyles();
    const anchor = table.parentElement || table;
    const bar = document.createElement('div');
    bar.className = 'sa-wocol-bar';
    bar.id = 'sa-wocol-bar';
    bar.appendChild(buildToggle('pn', 'Núm. de Parte', '🔩'));
    bar.appendChild(buildToggle('sched', 'Programación', '📅'));
    const mem = document.createElement('span'); mem.className = 'sa-wocol-count'; mem.id = 'sa-wocol-mem'; bar.appendChild(mem);
    anchor.parentElement ? anchor.parentElement.insertBefore(bar, anchor) : anchor.insertBefore(bar, anchor.firstChild);
    refreshToggleUI();
  }

  function refreshToggleUI() {
    const tp = document.getElementById('sa-wocol-toggle-pn'); if (tp) tp.classList.toggle('on', isPnOn());
    const ts = document.getElementById('sa-wocol-toggle-sched'); if (ts) ts.classList.toggle('on', isSchedOn());
    updateCount();
  }

  function updateCount() {
    ['pn', 'sched'].forEach(function (k) {
      const c = document.getElementById('sa-wocol-count-' + k);
      if (!c) return;
      const on = k === 'pn' ? isPnOn() : isSchedOn();
      if (!on) { c.textContent = ''; return; }
      const total = document.querySelectorAll('td.sa-wocol-' + k).length;
      const done = document.querySelectorAll('td.sa-wocol-' + k + '[data-sa-state="done"]').length;
      const err = document.querySelectorAll('td.sa-wocol-' + k + '[data-sa-state="error"]').length;
      c.textContent = total ? '  ' + (done + err) + '/' + total : '';
    });
  }

  // ── Columnas (siempre al INICIO de la fila, orden canónico [pn, sched]) ───────
  // A diferencia de pn-specs (que van al final), aquí el usuario las quiere al inicio.
  // moveToFront() reordena SOLO si no están ya en su lugar (evita churn/loop del observer).
  function moveToFront(row) {
    const desired = COLS.filter(function (c) { return c.on(); })
      .map(function (c) { return row.querySelector(':scope > .' + c.cls); })
      .filter(Boolean);
    if (!desired.length) return;
    let ok = true;
    for (let i = 0; i < desired.length; i++) { if (row.children[i] !== desired[i]) { ok = false; break; } }
    if (ok) return;
    for (let i = desired.length - 1; i >= 0; i--) row.insertBefore(desired[i], row.firstChild);
  }

  function ensureHeaderCells(table) {
    const headRow = table.querySelector('thead tr');
    if (!headRow) return;
    COLS.forEach(function (col) {
      let th = headRow.querySelector(':scope > .' + col.cls);
      if (!col.on()) { if (th) th.remove(); return; }
      if (!th) {
        th = document.createElement('th');
        const nativeTh = headRow.querySelector('th:not(.sa-wocol-pn):not(.sa-wocol-sched)');
        th.className = (nativeTh ? nativeTh.className + ' ' : '') + col.cls;
        th.setAttribute('scope', 'col');
        th.textContent = col.label;
      }
    });
    moveToFront(headRow);
  }

  function ensureBodyCells(table) {
    const rows = table.querySelectorAll('tbody tr');
    const toFetch = [];
    rows.forEach(function (tr) {
      const link = tr.querySelector('td a[href*="/WorkOrders/"]');
      const woIdInDomain = link ? Core().parseWorkOrderIdInDomain(link.getAttribute('href') || link.href) : null;
      const cached = woIdInDomain ? cache().get(woIdInDomain) : null;
      if (woIdInDomain && !cached && anyOn()) toFetch.push(woIdInDomain);

      COLS.forEach(function (col) {
        let td = tr.querySelector(':scope > .' + col.cls);
        if (!col.on()) { if (td) td.remove(); return; }
        if (!td) {
          td = document.createElement('td');
          const nativeTd = tr.querySelector('td:not(.sa-wocol-pn):not(.sa-wocol-sched)');
          td.className = (nativeTd ? nativeTd.className + ' ' : '') + col.cls;
          if (woIdInDomain != null) td.setAttribute('data-sa-woid', String(woIdInDomain));
          fillCellInitial(col.key, td, woIdInDomain, cached);
        }
      });
      moveToFront(tr);   // reposiciona al INICIO, en orden [pn, sched]
    });
    return toFetch;
  }

  function fillCellInitial(kind, td, woIdInDomain, cached) {
    if (woIdInDomain == null) { markNa(td); return; }
    if (kind === 'pn') {
      if (cached) renderPnCell(td, cached.pns); else pending(td);
    } else { // sched
      if (cached && cached.woGlobalId != null && board().state === 'ready') {
        renderSchedCell(td, Core().resolveBoardScheduleForWO(board().idx, cached.woGlobalId));
      } else { pending(td); }
    }
  }

  function pending(td) { td.setAttribute('data-sa-state', 'pending'); td.textContent = ''; const s = document.createElement('span'); s.className = 'sa-wocol-muted'; s.textContent = '⏳'; td.appendChild(s); }
  function markNa(td) { td.setAttribute('data-sa-state', 'na'); td.textContent = ''; const s = document.createElement('span'); s.className = 'sa-wocol-muted'; s.textContent = '—'; td.appendChild(s); }

  function renderPnCell(td, pns) {
    td.setAttribute('data-sa-state', 'done'); td.textContent = '';
    if (!pns || !pns.length) { td.appendChild(mutedSpan('sin PN')); return; }
    pns.forEach(function (pn) {
      const a = document.createElement('a'); a.className = 'sa-wocol-pn-link'; a.textContent = pn.name;
      const href = Core().pnLink(pn.id);
      if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
      td.appendChild(a);
    });
  }

  function renderSchedCell(td, tasks) {
    td.setAttribute('data-sa-state', 'done'); td.textContent = '';
    if (!tasks || !tasks.length) { td.appendChild(mutedSpan('no programada')); return; }
    const t = tasks[0];
    const st = document.createElement('span'); st.className = 'sa-wocol-sched-st';
    st.textContent = t.stationName || ('estación ' + (t.stationId != null ? t.stationId : '?'));
    td.appendChild(st);
    const meta = document.createElement('span'); meta.className = 'sa-wocol-sched-meta';
    const when = fmtLocalDateTime(t.expectedStartTime);
    const status = Core().scheduleStatusLabel(t.status);
    let m = [when, status].filter(Boolean).join(' · ');
    if (tasks.length > 1) m += '  (+' + (tasks.length - 1) + ')';
    meta.textContent = m;
    td.appendChild(meta);
  }

  function fmtLocalDateTime(iso) {
    if (!iso) return '';
    try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) {}
    return Core().formatShortDateTime(iso);
  }

  function renderCellError(td) { td.setAttribute('data-sa-state', 'error'); td.textContent = ''; const e = document.createElement('span'); e.className = 'sa-wocol-err'; e.textContent = '⚠️ error'; td.appendChild(e); }
  function mutedSpan(t) { const s = document.createElement('span'); s.className = 'sa-wocol-muted'; s.textContent = t; return s; }

  function removeColumns() {
    document.querySelectorAll('.sa-wocol-pn, .sa-wocol-sched').forEach(function (el) { el.remove(); });
  }
  function removeColumnClass(cls) { document.querySelectorAll('.' + cls).forEach(function (el) { el.remove(); }); }

  // ── Enriquecimiento por fila (PartNumbersByWorkOrderIdInDomain) ──────────────
  function pool() {
    if (!window.__saWoPool) window.__saWoPool = { queue: [], inFlight: 0, lastLaunch: 0, drain: null, count: 0 };
    return window.__saWoPool;
  }
  function enqueue(ids) {
    const p = pool();
    const seen = new Set(p.queue);
    ids.forEach(function (id) { if (!seen.has(id) && !cache().has(id)) { p.queue.push(id); seen.add(id); } });
    pump();
  }
  function isTransient(err) {
    if (!err) return false;
    if (err.persistedQueryRotated) return false;
    const m = (err.message || '').toLowerCase();
    return /timeout|network|failed to fetch|50\d|429|aborted/.test(m);
  }
  async function fetchRow(woIdInDomain) {
    const api = window.SteelheadAPI;
    for (let attempt = 0; attempt < RETRY_BACKOFF.length; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, RETRY_BACKOFF[attempt]); });
      try {
        const data = await api.query('PartNumbersByWorkOrderIdInDomain', { idInDomain: woIdInDomain }, 'PartNumbersByWorkOrderIdInDomain');
        return { pns: Core().extractPartNumbers(data), woGlobalId: Core().extractWorkOrderGlobalId(data) };
      } catch (e) {
        if (attempt === RETRY_BACKOFF.length - 1 || !isTransient(e)) throw e;
      }
    }
  }
  function fillRow(woIdInDomain, rowData, isError) {
    document.querySelectorAll('td.sa-wocol-pn[data-sa-woid="' + woIdInDomain + '"]').forEach(function (td) {
      if (isError) renderCellError(td); else renderPnCell(td, rowData.pns);
    });
    document.querySelectorAll('td.sa-wocol-sched[data-sa-woid="' + woIdInDomain + '"]').forEach(function (td) {
      if (isError) { renderCellError(td); return; }
      if (board().state === 'ready' && rowData.woGlobalId != null) {
        renderSchedCell(td, Core().resolveBoardScheduleForWO(board().idx, rowData.woGlobalId));
      }
      // si el board aún no está listo, la celda queda ⏳ hasta fillAllSchedCells()
    });
    updateCount();
  }
  function pump() {
    const p = pool();
    if (!anyOn() || !onIndex()) return;
    while (p.inFlight < MAX_CONC && p.queue.length) {
      const wait = p.lastLaunch + MIN_GAP_MS - Date.now();
      if (wait > 0) { setTimeout(pump, wait + 5); return; }
      const woId = p.queue.shift();
      p.inFlight++;
      p.lastLaunch = Date.now();
      try { if (Cleanup() && !window.__sa_dd_stopped) Cleanup().stopDatadogSessionReplay(); } catch (_) {}
      fetchRow(woId).then(function (rowData) {
        cache().set(woId, rowData);
        fillRow(woId, rowData, false);
        if (isSchedOn()) maybeLoadBoard();   // ya tenemos un woGlobalId → dispara el board
      }).catch(function (e) {
        fillRow(woId, null, true);
        if (e && e.persistedQueryRotated) toast('⚠️ El hash de PartNumbersByWorkOrderIdInDomain rotó — avísale a Claude.');
        else console.warn('[SA] wo-cols: fila ' + woId + ' falló:', e && e.message);
      }).then(function () {
        p.inFlight--; p.count++;
        try { if (p.drain) p.drain(); } catch (_) {}
        pump();
      });
    }
  }

  // ── Índice de programación del board (UNA sola llamada por página) ───────────
  function firstWoGlobalId() {
    let found = null;
    cache().forEach(function (v) { if (found == null && v && v.woGlobalId != null) found = v.woGlobalId; });
    return found;
  }
  function maybeLoadBoard() {
    if (!isSchedOn() || !onIndex()) return;
    const b = board();
    if (b.state === 'loading' || b.state === 'ready') return;
    const woGlobal = firstWoGlobalId();
    if (woGlobal == null) return;   // aún no hay ninguna fila resuelta; se reintenta al resolver
    const domainId = Core().parseDomainId(location.pathname);
    b.state = 'loading';
    const api = window.SteelheadAPI;
    api.query('WorkOrderSchedule', { domainId: domainId, workOrderId: woGlobal }, 'WorkOrderSchedule')
      .then(function (data) {
        // Guarda SOLO el índice slim; el raw (~4.6MB) se descarta al salir de scope.
        b.idx = Core().buildBoardScheduleIndex(data);
        b.state = 'ready';
        try { if (pool().drain) pool().drain(); } catch (_) {}   // Apollo drain tras el fetch pesado
        fillAllSchedCells();
      })
      .catch(function (e) {
        b.state = 'error';
        document.querySelectorAll('td.sa-wocol-sched[data-sa-state="pending"]').forEach(renderCellError);
        if (e && e.persistedQueryRotated) toast('⚠️ El hash de WorkOrderSchedule rotó — avísale a Claude.');
        else console.warn('[SA] wo-cols: WorkOrderSchedule falló:', e && e.message);
      });
  }
  function fillAllSchedCells() {
    const b = board();
    if (b.state !== 'ready') return;
    document.querySelectorAll('td.sa-wocol-sched[data-sa-woid]').forEach(function (td) {
      const woIdInDomain = parseInt(td.getAttribute('data-sa-woid'), 10);
      const cached = cache().get(woIdInDomain);
      if (cached && cached.woGlobalId != null) renderSchedCell(td, Core().resolveBoardScheduleForWO(b.idx, cached.woGlobalId));
    });
    updateCount();
  }

  // ── Memory hardening (EJE B) ────────────────────────────────────────────────
  function startMonitor() {
    const c = Cleanup(); if (!c) return;
    const p = pool();
    if (!p.drain && typeof c.makePeriodicDrain === 'function') p.drain = c.makePeriodicDrain(25);
    if (window.__saWoColsMon || typeof c.createMemMonitor !== 'function') return;
    window.__saWoColsMon = c.createMemMonitor({
      getElement: function () { return document.getElementById('sa-wocol-mem'); },
      onGuardrail: function (pct) { pool().queue.length = 0; toast('🛑 Memoria alta (' + pct + '%) — enriquecimiento pausado. Recarga si notas lentitud.'); },
    });
    window.__saWoColsMon.start();
  }
  function stopMonitor() { if (window.__saWoColsMon) { try { window.__saWoColsMon.stop(); } catch (_) {} window.__saWoColsMon = null; } }

  // ── Observer + sync ──────────────────────────────────────────────────────────
  let obsTimer = null;
  function scheduleSync() { if (obsTimer) return; obsTimer = setTimeout(function () { obsTimer = null; try { syncColumns(); } catch (_) {} }, OBS_DEBOUNCE_MS); }

  function syncColumns() {
    if (!anyOn() || !onIndex()) return;
    ensureToggles();
    const table = getTable(); if (!table) return;
    injectStyles();
    ensureHeaderCells(table);
    const toFetch = ensureBodyCells(table);
    if (toFetch.length) enqueue(toFetch);
    if (isSchedOn()) { if (board().state === 'ready') fillAllSchedCells(); else maybeLoadBoard(); }
    updateCount();
  }

  function observe() {
    if (window.__saWoColsObs) return;
    const obs = new MutationObserver(function () { scheduleSync(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saWoColsObs = obs;
  }
  function teardownObserver() { if (window.__saWoColsObs) { window.__saWoColsObs.disconnect(); window.__saWoColsObs = null; } if (obsTimer) { clearTimeout(obsTimer); obsTimer = null; } }

  // ── Activar / desactivar ──────────────────────────────────────────────────────
  function activate() {
    if (!onIndex()) return;
    injectStyles(); startMonitor(); observe(); syncColumns();
  }
  function deactivate() {
    const p = pool(); p.queue.length = 0;
    teardownObserver(); stopMonitor(); removeColumns(); refreshToggleUI();
  }

  function toggle(kind) {
    const key = kind === 'pn' ? PN_KEY : SCHED_KEY;
    const next = !getFlag(key);
    setFlag(key, next);
    refreshToggleUI();
    const label = kind === 'pn' ? '🔩 Núm. de Parte' : '📅 Programación';
    if (next) {
      toast(label + ': ACTIVADO — cargando…');
      if (kind === 'sched') { board().state = 'idle'; }  // recarga el board si hace falta
      activate();
    } else {
      toast(label + ': DESACTIVADO');
      removeColumnClass(kind === 'pn' ? 'sa-wocol-pn' : 'sa-wocol-sched');
      if (!anyOn()) deactivate();
      else { refreshToggleUI(); syncColumns(); }
    }
    return { pn: isPnOn(), sched: isSchedOn() };
  }

  function toggleFromPopup() { return toggle('pn'); }
  function toggleSchedFromPopup() { return toggle('sched'); }

  // ── Navegación SPA ─────────────────────────────────────────────────────────
  function installUrlChangeListener() {
    if (!window.__saWoColsUrlListener) {
      window.__saWoColsUrlListener = true;
      const fire = function () { window.dispatchEvent(new Event('sa-wocol-urlchange')); };
      ['pushState', 'replaceState'].forEach(function (m) { const orig = history[m]; history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; }; });
      window.addEventListener('popstate', fire);
    }
    window.addEventListener('sa-wocol-urlchange', function () {
      if (onIndex()) { ensureToggles(); observe(); if (anyOn()) activate(); }
      else {
        deactivate(); cache().clear();
        window.__saWoBoard = { idx: null, state: 'idle' };   // libera el índice al salir
        const bar = document.getElementById('sa-wocol-bar'); if (bar) bar.remove();
      }
    });
  }

  function init() {
    if (window.__saWoColsInit) return;
    window.__saWoColsInit = true;
    installUrlChangeListener();
    if (onIndex()) { ensureToggles(); observe(); if (anyOn()) activate(); }
    console.log('[SA] WoListingColumns activo (columnas Núm. de Parte + Programación en /WorkOrders)');
  }

  return {
    init, toggle, toggleFromPopup, toggleSchedFromPopup,
    _getState: function () {
      const p = pool(), b = board();
      return {
        pn: isPnOn(), sched: isSchedOn(), onIndex: onIndex(),
        rows: document.querySelectorAll('td.sa-wocol-pn, td.sa-wocol-sched').length,
        cached: cache().size, queue: p.queue.length, inFlight: p.inFlight, board: b.state,
      };
    },
  };
})();

if (typeof window !== 'undefined') {
  window.WoListingColumns = WoListingColumns;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { WoListingColumns.init(); });
  } else {
    WoListingColumns.init();
  }
}
