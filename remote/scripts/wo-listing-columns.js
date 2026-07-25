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
  const LOTE_KEY = 'sa_wo_lote_col_enabled';   // persistente, default OFF
  const LABELS_KEY = 'sa_wo_labels_enabled';   // persistente, default OFF (botón 🏷️ en Acciones)
  const MAX_CONC = 4;
  const MIN_GAP_MS = 130;
  const RETRY_BACKOFF = [0, 800, 2500];
  const OBS_DEBOUNCE_MS = 160;

  const COLS = [
    { key: 'pn',    cls: 'sa-wocol-pn',    label: 'Número de Parte', on: isPnOn },
    { key: 'sched', cls: 'sa-wocol-sched', label: 'Programación',    on: isSchedOn },
    { key: 'lote',  cls: 'sa-wocol-lote',  label: 'Lote',            on: isLoteOn },
  ];

  // ── Estado persistente / singleton ─────────────────────────────────────────
  function getFlag(k) { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } }
  function setFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (_) {} }
  function isPnOn() { return getFlag(PN_KEY); }
  function isSchedOn() { return getFlag(SCHED_KEY); }
  function isLoteOn() { return getFlag(LOTE_KEY); }
  function isLabelsOn() { return getFlag(LABELS_KEY); }
  function anyOn() { return isPnOn() || isSchedOn() || isLoteOn() || isLabelsOn(); }
  function isOnFor(kind) { return kind === 'pn' ? isPnOn() : kind === 'sched' ? isSchedOn() : kind === 'lote' ? isLoteOn() : isLabelsOn(); }
  function keyFor(kind) { return kind === 'pn' ? PN_KEY : kind === 'sched' ? SCHED_KEY : kind === 'lote' ? LOTE_KEY : LABELS_KEY; }
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
      'th.sa-wocol-pn,th.sa-wocol-sched,th.sa-wocol-lote{border-left:1px dashed #c7ccd1 !important;white-space:nowrap;}',
      'td.sa-wocol-pn,td.sa-wocol-sched,td.sa-wocol-lote{border-left:1px dashed #c7ccd1 !important;vertical-align:middle;}',
      // Borde derecho punteado en la ÚLTIMA de nuestras columnas → frontera clara con las nativas.
      'th.sa-wocol-edge,td.sa-wocol-edge{border-right:1px dashed #c7ccd1 !important;}',
      'td.sa-wocol-pn{min-width:120px;max-width:280px;}',
      'td.sa-wocol-sched{min-width:150px;max-width:300px;}',
      'td.sa-wocol-lote{min-width:150px;max-width:320px;}',
      '.sa-wocol-lote-item{padding:2px 0;}',
      '.sa-wocol-lote-item + .sa-wocol-lote-item{border-top:1px dashed #e1e5ea;margin-top:3px;padding-top:3px;}',
      'a.sa-wocol-lote-link{color:#0969da;cursor:pointer;text-decoration:none;font-size:12px;font-weight:600;display:inline-block;}',
      'a.sa-wocol-lote-link:hover{text-decoration:underline;}',
      '.sa-wocol-lote-meta{color:#5a6b7a;font-size:11px;display:block;line-height:1.35;}',
      '.sa-wocol-lote-meta b{color:#3a4a58;font-weight:600;}',
      '.sa-wocol-pn-item{margin:0 0 4px 0;}',
      '.sa-wocol-pn-item:last-child{margin-bottom:0;}',
      'a.sa-wocol-pn-link{color:#0969da;cursor:pointer;text-decoration:none;display:inline-block;font-size:12px;font-weight:600;}',
      'a.sa-wocol-pn-link:hover{text-decoration:underline;}',
      '.sa-wocol-chips{display:block;margin-top:2px;line-height:1.5;}',
      '.sa-wocol-chip{display:inline-block;border:1px solid #cfd6dd;border-radius:8px;padding:0 6px;',
      'margin:1px 4px 1px 0;font-size:10px;font-weight:600;white-space:nowrap;vertical-align:middle;}',
      '.sa-wocol-sched-item{padding:2px 0;}',
      '.sa-wocol-sched-item + .sa-wocol-sched-item{border-top:1px dashed #e1e5ea;}',
      '.sa-wocol-sched-st{font-weight:600;color:#0d6b49;font-size:12px;display:block;}',
      '.sa-wocol-sched-meta{color:#5a6b7a;font-size:11px;display:block;}',
      '.sa-wocol-muted{color:#8a97a5;font-style:italic;font-size:12px;}',
      '.sa-wocol-err{color:#b04a3a;font-size:12px;}',
      // Botón 🏷️ en la celda de Acciones (junto a Editar/Archivar nativos). Acento verde = extensión.
      'button.sa-wolabel-btn{display:inline-flex;align-items:center;justify-content:center;',
      'width:26px;height:26px;padding:0;margin-left:2px;border:1px solid #13a36f;border-radius:6px;',
      'background:#fff;color:#0d6b49;font-size:14px;line-height:1;cursor:pointer;vertical-align:middle;}',
      'button.sa-wolabel-btn:hover{background:#e9f7f1;}',
      'button.sa-wolabel-btn:active{background:#d6efe4;}',
      'button.sa-wolabel-btn[disabled]{opacity:.5;cursor:default;}',
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
    const on = isOnFor(kind);
    const wrap = document.createElement('div');
    wrap.className = 'sa-wocol-toggle' + (on ? ' on' : '');
    wrap.id = 'sa-wocol-toggle-' + kind;
    wrap.title = kind === 'pn'
      ? 'Muestra el Número de Parte de cada OT (1 consulta por OT visible).'
      : kind === 'sched'
        ? 'Muestra la programación (estación · fecha · estado) de cada OT (1 consulta del tablero por página).'
        : kind === 'lote'
          ? 'Muestra el Lote de cada OT: nombre (idInDomain), PS Cliente y fecha de recibido (1 consulta por OT visible).'
          : 'Agrega un botón 🏷️ en la columna Acciones que genera el PDF de etiquetas (JobTag) de esa OT en pestaña nueva.';
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
    bar.appendChild(buildToggle('lote', 'Lote', '📦'));
    bar.appendChild(buildToggle('labels', 'Etiquetas', '🏷️'));
    const mem = document.createElement('span'); mem.className = 'sa-wocol-count'; mem.id = 'sa-wocol-mem'; bar.appendChild(mem);
    anchor.parentElement ? anchor.parentElement.insertBefore(bar, anchor) : anchor.insertBefore(bar, anchor.firstChild);
    refreshToggleUI();
  }

  function refreshToggleUI() {
    const tp = document.getElementById('sa-wocol-toggle-pn'); if (tp) tp.classList.toggle('on', isPnOn());
    const ts = document.getElementById('sa-wocol-toggle-sched'); if (ts) ts.classList.toggle('on', isSchedOn());
    const tl = document.getElementById('sa-wocol-toggle-lote'); if (tl) tl.classList.toggle('on', isLoteOn());
    const tb = document.getElementById('sa-wocol-toggle-labels'); if (tb) tb.classList.toggle('on', isLabelsOn());
    updateCount();
  }

  function updateCount() {
    ['pn', 'sched', 'lote'].forEach(function (k) {
      const c = document.getElementById('sa-wocol-count-' + k);
      if (!c) return;
      const on = isOnFor(k);
      if (!on) { c.textContent = ''; return; }
      const total = document.querySelectorAll('td.sa-wocol-' + k).length;
      const done = document.querySelectorAll('td.sa-wocol-' + k + '[data-sa-state="done"]').length;
      const err = document.querySelectorAll('td.sa-wocol-' + k + '[data-sa-state="error"]').length;
      c.textContent = total ? '  ' + (done + err) + '/' + total : '';
    });
    const cb = document.getElementById('sa-wocol-count-labels');
    if (cb) { const n = document.querySelectorAll('.sa-wolabel-btn').length; cb.textContent = isLabelsOn() && n ? '  ' + n : ''; }
  }

  // ── Columnas (siempre al INICIO de la fila, orden canónico [pn, sched]) ───────
  // A diferencia de pn-specs (que van al final), aquí el usuario las quiere al inicio.
  // moveToFront() reordena SOLO si no están ya en su lugar (evita churn/loop del observer).
  function moveToFront(row) {
    const desired = COLS.filter(function (c) { return c.on(); })
      .map(function (c) { return row.querySelector(':scope > .' + c.cls); })
      .filter(Boolean);
    if (!desired.length) return;
    // La última de nuestras columnas lleva el borde derecho (frontera con las nativas).
    desired.forEach(function (c, i) { c.classList.toggle('sa-wocol-edge', i === desired.length - 1); });
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
        const nativeTh = headRow.querySelector('th:not(.sa-wocol-pn):not(.sa-wocol-sched):not(.sa-wocol-lote)');
        th.className = (nativeTh ? nativeTh.className + ' ' : '') + col.cls;
        th.setAttribute('scope', 'col');
        th.textContent = col.label;
        headRow.appendChild(th);   // adjunta al DOM; moveToFront lo reposiciona al inicio
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
      // El cache PartNumbers alimenta SOLO pn+sched. Lote usa su propio pool (WorkOrder).
      if (woIdInDomain && !cached && (isPnOn() || isSchedOn())) toFetch.push(woIdInDomain);

      COLS.forEach(function (col) {
        let td = tr.querySelector(':scope > .' + col.cls);
        if (!col.on()) { if (td) td.remove(); return; }
        if (!td) {
          td = document.createElement('td');
          const nativeTd = tr.querySelector('td:not(.sa-wocol-pn):not(.sa-wocol-sched):not(.sa-wocol-lote)');
          td.className = (nativeTd ? nativeTd.className + ' ' : '') + col.cls;
          if (woIdInDomain != null) td.setAttribute('data-sa-woid', String(woIdInDomain));
          fillCellInitial(col.key, td, woIdInDomain, cached);
          tr.appendChild(td);   // adjunta al DOM; moveToFront lo reposiciona al inicio
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
    } else if (kind === 'sched') {
      if (cached && cached.woGlobalId != null && board().state === 'ready') {
        renderSchedCell(td, Core().resolveBoardScheduleForWO(board().idx, cached.woGlobalId));
      } else { pending(td); }
    } else { // lote (cache propio: WorkOrder por WO)
      const lc = loteCache().get(woIdInDomain);
      if (lc) renderLoteCell(td, lc.batches); else pending(td);
    }
  }

  function pending(td) { td.setAttribute('data-sa-state', 'pending'); td.textContent = ''; const s = document.createElement('span'); s.className = 'sa-wocol-muted'; s.textContent = '⏳'; td.appendChild(s); }
  function markNa(td) { td.setAttribute('data-sa-state', 'na'); td.textContent = ''; const s = document.createElement('span'); s.className = 'sa-wocol-muted'; s.textContent = '—'; td.appendChild(s); }

  function renderPnCell(td, pns) {
    td.setAttribute('data-sa-state', 'done'); td.textContent = '';
    if (!pns || !pns.length) { td.appendChild(mutedSpan('sin PN')); return; }
    pns.forEach(function (pn) {
      const item = document.createElement('div'); item.className = 'sa-wocol-pn-item';
      const a = document.createElement('a'); a.className = 'sa-wocol-pn-link'; a.textContent = pn.name;
      const href = Core().pnLink(pn.id);
      if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
      item.appendChild(a);
      // Chips de etiquetas (2º query ligero GetPartNumberForPartNumberPage; se llenan al resolver).
      const detail = detailCache().get(pn.id);
      if (detail && detail.labels && detail.labels.length) {
        const chips = document.createElement('span'); chips.className = 'sa-wocol-chips';
        detail.labels.forEach(function (l) {
          const c = document.createElement('span'); c.className = 'sa-wocol-chip'; c.textContent = l.name;
          if (l.color && /^#[0-9a-fA-F]{3,8}$/.test(l.color)) {
            c.style.backgroundColor = l.color; c.style.borderColor = l.color; c.style.color = pickTextColor(l.color);
          }
          chips.appendChild(c);
        });
        item.appendChild(chips);
      }
      td.appendChild(item);
    });
  }

  // Blanco o gris oscuro según luminancia del fondo (chips legibles con cualquier color).
  function pickTextColor(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return '#1c2430';
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#1c2430' : '#ffffff';
  }

  function renderSchedCell(td, tasks) {
    td.setAttribute('data-sa-state', 'done'); td.textContent = '';
    if (!tasks || !tasks.length) { td.appendChild(mutedSpan('no programada')); return; }
    // TODAS las tareas apiladas (una OT multi-tratamiento se agenda en varias líneas).
    tasks.forEach(function (t) {
      const item = document.createElement('div'); item.className = 'sa-wocol-sched-item';
      const st = document.createElement('span'); st.className = 'sa-wocol-sched-st';
      st.textContent = t.stationName || ('estación ' + (t.stationId != null ? t.stationId : '?'));
      item.appendChild(st);
      const meta = document.createElement('span'); meta.className = 'sa-wocol-sched-meta';
      meta.textContent = [fmtLocalDateTime(t.expectedStartTime), Core().scheduleStatusLabel(t.status)].filter(Boolean).join(' · ');
      item.appendChild(meta);
      td.appendChild(item);
    });
  }

  function fmtLocalDateTime(iso) {
    if (!iso) return '';
    try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) {}
    return Core().formatShortDateTime(iso);
  }

  // ── Render de la celda Lote (nombre (idInDomain) link · PS Cliente · fecha recibido) ──
  function renderLoteCell(td, batches) {
    td.setAttribute('data-sa-state', 'done'); td.textContent = '';
    if (!batches || !batches.length) { td.appendChild(mutedSpan('sin lote')); return; }
    // Una WO puede ligar varios lotes → apilados (cada uno con su PS y fecha).
    batches.forEach(function (b) {
      const item = document.createElement('div'); item.className = 'sa-wocol-lote-item';
      const a = document.createElement('a'); a.className = 'sa-wocol-lote-link';
      a.textContent = b.name + (b.idInDomain != null ? ' (' + b.idInDomain + ')' : '');
      const href = Core().batchLink(b.idInDomain, b.partNumberId);
      if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
      item.appendChild(a);
      if (b.packingSlip) item.appendChild(loteMeta('PS: ', b.packingSlip));       // textContent → anti-XSS
      if (b.receivedAt) item.appendChild(loteMeta('Recibido: ', fmtLocalDate(b.receivedAt)));
      td.appendChild(item);
    });
  }
  function loteMeta(label, value) {
    const s = document.createElement('span'); s.className = 'sa-wocol-lote-meta';
    const b = document.createElement('b'); b.textContent = label; s.appendChild(b);
    s.appendChild(document.createTextNode(value));
    return s;
  }
  function fmtLocalDate(iso) {
    if (!iso) return '';
    try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) {}
    return Core().formatShortDateTime(iso);
  }

  function renderCellError(td) { td.setAttribute('data-sa-state', 'error'); td.textContent = ''; const e = document.createElement('span'); e.className = 'sa-wocol-err'; e.textContent = '⚠️ error'; td.appendChild(e); }
  function mutedSpan(t) { const s = document.createElement('span'); s.className = 'sa-wocol-muted'; s.textContent = t; return s; }

  function removeColumns() {
    document.querySelectorAll('.sa-wocol-pn, .sa-wocol-sched, .sa-wocol-lote').forEach(function (el) { el.remove(); });
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
        if (isPnOn()) enqueueDetails((rowData.pns || []).map(function (p) { return p.id; }));   // chips de etiquetas
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

  // ── 2º query LIGERO por PN: etiquetas como chips (GetPartNumberForPartNumberPage) ──
  // Sin descripción (esa solo vive en GetPartNumber, 504 campos → mucho peso; decisión
  // del usuario: priorizar chips de etiquetas y dejar la descripción).
  function detailCache() { if (!window.__saWoPnDetail) window.__saWoPnDetail = new Map(); return window.__saWoPnDetail; }
  function detailPool() { if (!window.__saWoPnDetailPool) window.__saWoPnDetailPool = { queue: [], inFlight: 0, lastLaunch: 0 }; return window.__saWoPnDetailPool; }

  function enqueueDetails(pnIds) {
    if (!isPnOn()) return;
    const p = detailPool(); const seen = new Set(p.queue);
    pnIds.forEach(function (id) { if (id != null && !seen.has(id) && !detailCache().has(id)) { p.queue.push(id); seen.add(id); } });
    pumpDetails();
  }
  async function fetchDetail(pnId) {
    const api = window.SteelheadAPI;
    for (let attempt = 0; attempt < RETRY_BACKOFF.length; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, RETRY_BACKOFF[attempt]); });
      try {
        const data = await api.query('GetPartNumberForPartNumberPage', { partNumberId: pnId }, 'GetPartNumberForPartNumberPage');
        return { labels: Core().extractPartNumberDetail(data).labels };   // slim
      } catch (e) { if (attempt === RETRY_BACKOFF.length - 1 || !isTransient(e)) throw e; }
    }
  }
  function pumpDetails() {
    const p = detailPool();
    if (!isPnOn() || !onIndex()) return;
    while (p.inFlight < MAX_CONC && p.queue.length) {
      const wait = p.lastLaunch + MIN_GAP_MS - Date.now();
      if (wait > 0) { setTimeout(pumpDetails, wait + 5); return; }
      const pnId = p.queue.shift(); p.inFlight++; p.lastLaunch = Date.now();
      fetchDetail(pnId).then(function (d) {
        detailCache().set(pnId, d);
        repaintPnCellsWith(pnId);
      }).catch(function (e) {
        if (e && e.persistedQueryRotated) toast('⚠️ El hash de GetPartNumberForPartNumberPage rotó — avísale a Claude.');
        else console.warn('[SA] wo-cols: labels PN ' + pnId + ' falló:', e && e.message);
      }).then(function () {
        p.inFlight--;
        try { if (pool().drain) pool().drain(); } catch (_) {}
        pumpDetails();
      });
    }
  }
  // Re-pinta la celda PN de las WOs cuyo cache incluye este pnId (mete/actualiza los chips).
  function repaintPnCellsWith(pnId) {
    document.querySelectorAll('td.sa-wocol-pn[data-sa-woid]').forEach(function (td) {
      const woIdInDomain = parseInt(td.getAttribute('data-sa-woid'), 10);
      const cached = cache().get(woIdInDomain);
      if (cached && cached.pns && cached.pns.some(function (p) { return p.id === pnId; })) renderPnCell(td, cached.pns);
    });
  }
  // Encola las etiquetas de todos los PN conocidos (al activar el toggle sobre filas ya cacheadas).
  function enqueueKnownDetails() {
    if (!isPnOn()) return;
    const ids = [];
    cache().forEach(function (v) { if (v && v.pns) v.pns.forEach(function (p) { ids.push(p.id); }); });
    if (ids.length) enqueueDetails(ids);
  }

  // ── Query por WO: Lote (WorkOrder → currentPartsTransferAccounts, SLIM) ──────
  // WorkOrder({idInDomain}) es la query de la ficha (1156 campos): pesada. Extraemos
  // SLIM {batches:[{id,idInDomain,name,packingSlip,receivedAt,partNumberId}]} y el raw
  // sale de scope de inmediato (EJE A: slim responses, no guardar el response completo).
  // Pool propio con la misma disciplina de concurrencia que el de PartNumbers.
  function loteCache() { if (!window.__saWoLoteCache) window.__saWoLoteCache = new Map(); return window.__saWoLoteCache; }
  function lotePool() { if (!window.__saWoLotePool) window.__saWoLotePool = { queue: [], inFlight: 0, lastLaunch: 0 }; return window.__saWoLotePool; }

  function enqueueLote(ids) {
    if (!isLoteOn()) return;
    const p = lotePool(); const seen = new Set(p.queue);
    ids.forEach(function (id) { if (id != null && !seen.has(id) && !loteCache().has(id)) { p.queue.push(id); seen.add(id); } });
    pumpLote();
  }
  // Encola los lotes de las filas visibles aún no cacheadas (al activar el toggle o paginar).
  function enqueueVisibleLote() {
    if (!isLoteOn()) return;
    const ids = [];
    document.querySelectorAll('td.sa-wocol-lote[data-sa-woid]').forEach(function (td) {
      const id = parseInt(td.getAttribute('data-sa-woid'), 10);
      if (!isNaN(id) && !loteCache().has(id)) ids.push(id);
    });
    if (ids.length) enqueueLote(ids);
  }
  async function fetchLote(woIdInDomain) {
    const api = window.SteelheadAPI;
    for (let attempt = 0; attempt < RETRY_BACKOFF.length; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, RETRY_BACKOFF[attempt]); });
      try {
        const data = await api.query('WorkOrder', { idInDomain: woIdInDomain }, 'WorkOrder');
        return { batches: Core().extractWorkOrderBatches(data) };   // SLIM; el raw se descarta
      } catch (e) { if (attempt === RETRY_BACKOFF.length - 1 || !isTransient(e)) throw e; }
    }
  }
  function pumpLote() {
    const p = lotePool();
    if (!isLoteOn() || !onIndex()) return;
    while (p.inFlight < MAX_CONC && p.queue.length) {
      const wait = p.lastLaunch + MIN_GAP_MS - Date.now();
      if (wait > 0) { setTimeout(pumpLote, wait + 5); return; }
      const woId = p.queue.shift(); p.inFlight++; p.lastLaunch = Date.now();
      try { if (Cleanup() && !window.__sa_dd_stopped) Cleanup().stopDatadogSessionReplay(); } catch (_) {}
      fetchLote(woId).then(function (slim) {
        loteCache().set(woId, slim);
        fillLoteCells(woId, slim.batches, false);
      }).catch(function (e) {
        fillLoteCells(woId, null, true);
        if (e && e.persistedQueryRotated) toast('⚠️ El hash de WorkOrder rotó — avísale a Claude.');
        else console.warn('[SA] wo-cols: lote ' + woId + ' falló:', e && e.message);
      }).then(function () {
        p.inFlight--;
        try { if (pool().drain) pool().drain(); } catch (_) {}   // Apollo drain tras query pesada
        pumpLote();
      });
    }
  }
  function fillLoteCells(woIdInDomain, batches, isError) {
    document.querySelectorAll('td.sa-wocol-lote[data-sa-woid="' + woIdInDomain + '"]').forEach(function (td) {
      if (isError) renderCellError(td); else renderLoteCell(td, batches);
    });
    updateCount();
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

  // ── Botón 🏷️ Etiquetas en la celda NATIVA de Acciones (por fila) ─────────────
  // NO es una columna nuestra: inyecta un botón en la celda de Acciones (la que tiene
  // Editar/Archivar). Click → abre la ficha en pestaña nueva con ?sa_print=jobtag; ahí
  // wo-schedule-button AUTO-MANEJA el flujo nativo y suelta el PDF (server-side, POR-OT
  // → sin el techo ~16-20 de PDFGeneratorAPI en batch). Re-inyecta en cada sync (idempotente).
  function findActionsCell(tr) {
    // Celda de Acciones = la que tiene el botón Editar/Archivar (testids idioma-agnósticos).
    const icon = tr.querySelector('td svg[data-testid="EditIcon"], td svg[data-testid="ArchiveIcon"]');
    if (icon && icon.closest('td')) return icon.closest('td');
    // Fallback: última td que no sea nuestra.
    const tds = tr.querySelectorAll('td:not(.sa-wocol-pn):not(.sa-wocol-sched):not(.sa-wocol-lote)');
    return tds.length ? tds[tds.length - 1] : null;
  }
  function buildLabelButton(fichaHref) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sa-wolabel-btn';
    b.textContent = '🏷️';
    b.title = 'Generar PDF de etiquetas (JobTag) de esta OT en pestaña nueva';
    b.setAttribute('aria-label', 'Imprimir etiquetas de trabajo');
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      const url = fichaHref + (fichaHref.indexOf('?') >= 0 ? '&' : '?') + 'sa_print=jobtag';
      window.open(url, '_blank', 'noopener');
      toast('🏷️ Abriendo la OT para generar el JobTag (pestaña nueva)…');
    });
    return b;
  }
  function ensureActionButtons(table) {
    if (!isLabelsOn()) return;
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      const link = tr.querySelector('td a[href*="/WorkOrders/"]');
      const href = link ? (link.getAttribute('href') || link.href || '') : '';
      if (!href || Core().parseWorkOrderIdInDomain(href) == null) return;
      const cell = findActionsCell(tr);
      if (!cell || cell.querySelector('.sa-wolabel-btn')) return;   // idempotente por fila
      cell.appendChild(buildLabelButton(href));
    });
  }
  function removeLabelButtons() { document.querySelectorAll('.sa-wolabel-btn').forEach(function (b) { b.remove(); }); }

  function syncColumns() {
    if (!anyOn() || !onIndex()) return;
    ensureToggles();
    const table = getTable(); if (!table) return;
    injectStyles();
    ensureHeaderCells(table);
    const toFetch = ensureBodyCells(table);
    if (toFetch.length) enqueue(toFetch);
    if (isPnOn()) enqueueKnownDetails();   // chips para filas ya cacheadas (p.ej. al activar el toggle)
    if (isSchedOn()) { if (board().state === 'ready') fillAllSchedCells(); else maybeLoadBoard(); }
    if (isLoteOn()) enqueueVisibleLote();
    if (isLabelsOn()) ensureActionButtons(table);
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
    detailPool().queue.length = 0;
    lotePool().queue.length = 0;
    teardownObserver(); stopMonitor(); removeColumns(); removeLabelButtons(); refreshToggleUI();
  }

  function toggle(kind) {
    const key = keyFor(kind);
    const next = !getFlag(key);
    setFlag(key, next);
    refreshToggleUI();
    const label = kind === 'pn' ? '🔩 Núm. de Parte' : kind === 'sched' ? '📅 Programación' : kind === 'lote' ? '📦 Lote' : '🏷️ Etiquetas';
    if (next) {
      toast(label + (kind === 'labels' ? ': ACTIVADO — botón en Acciones' : ': ACTIVADO — cargando…'));
      if (kind === 'sched') { board().state = 'idle'; }  // recarga el board si hace falta
      activate();
    } else {
      toast(label + ': DESACTIVADO');
      if (kind === 'pn') detailPool().queue.length = 0;   // corta la carga de etiquetas
      if (kind === 'lote') lotePool().queue.length = 0;   // corta la carga de lotes
      if (kind === 'labels') removeLabelButtons();        // quita los botones de Acciones
      else removeColumnClass('sa-wocol-' + kind);
      if (!anyOn()) deactivate();
      else { refreshToggleUI(); syncColumns(); }
    }
    return { pn: isPnOn(), sched: isSchedOn(), lote: isLoteOn(), labels: isLabelsOn() };
  }

  function toggleFromPopup() { return toggle('pn'); }
  function toggleSchedFromPopup() { return toggle('sched'); }
  function toggleLoteFromPopup() { return toggle('lote'); }
  function toggleLabelsFromPopup() { return toggle('labels'); }

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
        window.__saWoPnDetail = new Map(); window.__saWoPnDetailPool = { queue: [], inFlight: 0, lastLaunch: 0 };
        window.__saWoLoteCache = new Map(); window.__saWoLotePool = { queue: [], inFlight: 0, lastLaunch: 0 };
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
    init, toggle, toggleFromPopup, toggleSchedFromPopup, toggleLoteFromPopup, toggleLabelsFromPopup,
    _getState: function () {
      const p = pool(), b = board(), lp = lotePool();
      return {
        pn: isPnOn(), sched: isSchedOn(), lote: isLoteOn(), labels: isLabelsOn(), onIndex: onIndex(),
        rows: document.querySelectorAll('td.sa-wocol-pn, td.sa-wocol-sched, td.sa-wocol-lote').length,
        cached: cache().size, queue: p.queue.length, inFlight: p.inFlight, board: b.state,
        loteCached: loteCache().size, loteQueue: lp.queue.length, loteInFlight: lp.inFlight,
        labelBtns: document.querySelectorAll('.sa-wolabel-btn').length,
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
