// Programación INLINE en la ficha de Orden de Trabajo — glue DOM.
// En /Domains/<d>/WorkOrders/<idInDomain> muestra, DIRECTO en el header (entre "EDITAR
// DETALLES" y "ABRIR PDF"), la programación de la OT: "📅 <estación · fecha · estado>".
// NO requiere click: la info sale sola al entrar a la ficha. Motivo: en iPad la tarjeta
// "Cliente" (con el ícono 📅 nativo) se colapsa; este readout arriba la muestra siempre.
//
// FASE 2 (a futuro): cuando se pueda PROGRAMAR desde aquí, el 📅 se vuelve clicable y
// abrirá un modal de programación intencional (por eso el elemento ya lleva el 📅 al inicio).
//
// Datos: WorkOrder({idInDomain}) → workOrderId GLOBAL; WorkOrderSchedule({domainId,
// workOrderId}) → board COMPLETO → WoScheduleCore.buildBoardScheduleIndex → tareas de la OT.
// Para NO bajar ~4.6MB por ficha, se INTERCEPTA la WorkOrderSchedule que la propia ficha
// dispara (patrón surtido-guard); solo se hace fetch propio como fallback si no aparece.
//
// Auto-inyectado (autoInject:true). Singleton en window.__saWoSched* para sobrevivir la
// re-inyección del IIFE.
const WoScheduleButton = (() => {
  'use strict';

  const Core = () => window.WoScheduleCore;

  const INLINE_ID = 'sa-wosched-inline';
  const PDF_ANCHOR = '[data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON"]';
  const BOARD_TTL_MS = 120000;    // frescura del índice de programación capturado/fetcheado
  const WAIT_STEPS = 6, WAIT_MS = 300;   // ventana para que el interceptor capture la nativa

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function onDetail() { return Core().isWorkOrderDetailPath(location.pathname); }
  function currentWoIdInDomain() { return Core().parseWorkOrderIdInDomain(location.pathname); }

  // Índice de programación del board (compartido; capturado por el interceptor o fetcheado).
  function boardState() {
    if (!window.__saWoSchedBoard) window.__saWoSchedBoard = { idx: null, at: 0, domainId: null };
    return window.__saWoSchedBoard;
  }
  function boardFresh(domainId) {
    const b = boardState();
    return b.idx && b.domainId === domainId && (Date.now() - b.at) < BOARD_TTL_MS;
  }
  function setBoard(idx, domainId) {
    const b = boardState(); b.idx = idx; b.domainId = domainId; b.at = Date.now();
  }
  // cache de tareas resueltas por idInDomain (para no recomputar al re-render/nav)
  function resolvedCache() { if (!window.__saWoSchedResolved) window.__saWoSchedResolved = new Map(); return window.__saWoSchedResolved; }

  // ── Estilos ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-wosched-style')) return;
    const css = [
      // Readout inline integrado a la barra clara nativa, con acento verde (= UI de la extensión).
      '#' + INLINE_ID + '{display:inline-flex;align-items:center;gap:6px;',
      'border:1px solid #13a36f;border-radius:6px;background:#eef6f2;color:#0d6b49;',
      'font-weight:600;font-size:12.5px;padding:4px 10px;margin:0 6px;white-space:nowrap;',
      'max-width:340px;overflow:hidden;text-overflow:ellipsis;flex-shrink:1;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.2;}',
      '#' + INLINE_ID + ' .sa-wosched-ico{flex:0 0 auto;}',
      '#' + INLINE_ID + ' .sa-wosched-txt{overflow:hidden;text-overflow:ellipsis;}',
      '#' + INLINE_ID + '.sa-wosched-none{border-color:#c7ccd1;background:#f3f4f6;color:#6b7280;}',
      '#' + INLINE_ID + '.sa-wosched-loading{border-color:#c7ccd1;background:#f3f4f6;color:#8a97a5;font-style:italic;}',
      '#' + INLINE_ID + '.sa-wosched-err{border-color:#e0b4ab;background:#fbeeeb;color:#b04a3a;}',
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-wosched-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Elemento inline en el header ─────────────────────────────────────────────
  function buildInline() {
    injectStyles();
    const el = document.createElement('div');
    el.id = INLINE_ID;
    el.className = 'sa-wosched-loading';
    el.title = 'Programación de esta Orden de Trabajo';
    const ico = document.createElement('span'); ico.className = 'sa-wosched-ico'; ico.textContent = '📅';
    const txt = document.createElement('span'); txt.className = 'sa-wosched-txt'; txt.textContent = 'Programación…';
    el.appendChild(ico); el.appendChild(txt);
    return el;
  }

  function ensureInline() {
    if (!onDetail()) return null;
    let el = document.getElementById(INLINE_ID);
    if (el) return el;
    const pdf = document.querySelector(PDF_ANCHOR);
    if (!pdf || !pdf.parentElement) return null;   // header aún no renderiza: observer reintenta
    el = buildInline();
    pdf.parentElement.insertBefore(el, pdf);
    return el;
  }

  function removeInline() { const el = document.getElementById(INLINE_ID); if (el) el.remove(); }

  function setInlineText(el, cls, text, title) {
    if (!el) return;
    el.className = cls;
    const txt = el.querySelector('.sa-wosched-txt');
    if (txt) txt.textContent = text;
    el.title = title || 'Programación de esta Orden de Trabajo';
  }

  // Fecha/hora local (glue usa Date; el core da el fallback determinista).
  function fmtLocal(iso) {
    if (!iso) return '';
    try { const d = new Date(iso); if (!isNaN(d.getTime())) return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) {}
    return Core().formatShortDateTime(iso);
  }
  function taskText(t) {
    const parts = [];
    if (t.stationName) parts.push(t.stationName);
    const w = fmtLocal(t.expectedStartTime); if (w) parts.push(w);
    const s = Core().scheduleStatusLabel(t.status); if (s) parts.push(s);
    return parts.join(' · ') || '(programada)';
  }

  function renderInline(el, tasks) {
    if (!el) return;
    if (!tasks || !tasks.length) { setInlineText(el, 'sa-wosched-none', 'Sin programar', 'Esta OT no está programada.'); return; }
    let text = taskText(tasks[0]);
    if (tasks.length > 1) text += '  (+' + (tasks.length - 1) + ')';
    // tooltip con todas las tareas
    const title = tasks.map(function (t, i) { return (i + 1) + ') ' + taskText(t); }).join('\n');
    setInlineText(el, '', text, title);
  }

  // ── Carga de datos ───────────────────────────────────────────────────────────
  async function loadInline(woIdInDomain, el) {
    const cachedTasks = resolvedCache().get(woIdInDomain);
    if (cachedTasks) { renderInline(el, cachedTasks); return; }

    const api = window.SteelheadAPI;
    const domainId = Core().parseDomainId(location.pathname);
    let woGlobalId = null;
    try {
      const data = await api.query('WorkOrder', { idInDomain: woIdInDomain }, 'WorkOrder');
      woGlobalId = Core().extractWorkOrderGlobalId(data);
      if (woGlobalId == null && data && data.workOrderByIdInDomain) woGlobalId = data.workOrderByIdInDomain.id;
    } catch (e) {
      setInlineText(el, 'sa-wosched-err', 'Error', 'No se pudo cargar la OT: ' + (e && e.message ? e.message : 'error'));
      return;
    }
    if (woGlobalId == null) { setInlineText(el, 'sa-wosched-none', 'Sin programar'); return; }

    let idx;
    try { idx = await ensureBoardIndex(domainId, woGlobalId); }
    catch (e) {
      setInlineText(el, 'sa-wosched-err', 'Error', (e && e.persistedQueryRotated)
        ? 'El hash de WorkOrderSchedule rotó — avísale a Claude.'
        : 'No se pudo cargar la programación: ' + (e && e.message ? e.message : 'error'));
      return;
    }
    const tasks = Core().resolveBoardScheduleForWO(idx, woGlobalId);
    resolvedCache().set(woIdInDomain, tasks);
    // el DOM pudo cambiar (SPA nav) mientras esperábamos → re-ancla si sigue en la misma ficha
    const live = (currentWoIdInDomain() === woIdInDomain) ? (document.getElementById(INLINE_ID) || el) : null;
    if (live) renderInline(live, tasks);
  }

  // Devuelve el índice del board: usa el capturado (interceptor) si está fresco; si no,
  // le da una ventana corta al interceptor (la ficha suele dispararlo) y, en última
  // instancia, hace fetch propio.
  async function ensureBoardIndex(domainId, woGlobalId) {
    if (boardFresh(domainId)) return boardState().idx;
    for (let i = 0; i < WAIT_STEPS; i++) { await sleep(WAIT_MS); if (boardFresh(domainId)) return boardState().idx; }
    const api = window.SteelheadAPI;
    const data = await api.query('WorkOrderSchedule', { domainId: domainId, workOrderId: woGlobalId }, 'WorkOrderSchedule');
    const idx = Core().buildBoardScheduleIndex(data);
    setBoard(idx, domainId);   // el raw (~4.6MB) se descarta al salir de scope; solo queda el índice slim
    return idx;
  }

  // ── Interceptor de la WorkOrderSchedule nativa (evita el doble fetch de 4.6MB) ──
  function patchFetch() {
    if (window.__saWoSchedFetchPatched) return;
    window.__saWoSchedFetchPatched = true;
    const orig = window.fetch;
    window.fetch = function (input, init) {
      let isWos = false, domainId = null;
      try {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        const body = (init && typeof init.body === 'string') ? init.body : '';
        const hay = body || url;   // POST → body; GET APQ → url (?operationName=…)
        if (hay.indexOf('WorkOrderSchedule') !== -1) {
          isWos = true;
          const dm = hay.match(/domainId(?:"\s*:\s*|=)(\d+)/);
          domainId = dm ? parseInt(dm[1], 10) : Core().parseDomainId(location.pathname);
        }
      } catch (_) {}
      const p = orig.apply(this, arguments);
      if (isWos) {
        p.then(function (resp) {
          try {
            resp.clone().json().then(function (j) {
              try {
                const data = (j && j.data) ? j.data : j;
                if (data && data.allSchedules) { setBoard(Core().buildBoardScheduleIndex(data), domainId); refreshCurrent(); }
              } catch (_) {}
            }).catch(function () {});
          } catch (_) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // Re-render del readout de la ficha actual cuando el interceptor captura datos nuevos.
  function refreshCurrent() {
    if (!onDetail()) return;
    const woId = currentWoIdInDomain();
    if (woId == null) return;
    const b = boardState();
    if (!b.idx) return;
    const el = document.getElementById(INLINE_ID); if (!el) return;
    // resolvemos con el índice fresco (necesitamos el woGlobalId; si ya está en cache, re-render directo)
    // si no lo tenemos, loadInline lo obtendrá (y usará el board fresco).
    resolvedCache().delete(woId);
    loadInline(woId, el);
  }

  // ── Montaje idempotente + observer + navegación SPA ──────────────────────────
  let obsTimer = null;
  function scheduleEnsure() {
    if (obsTimer) return;
    obsTimer = setTimeout(function () {
      obsTimer = null;
      try {
        const el = ensureInline();
        if (el && el.className.indexOf('sa-wosched-loading') !== -1 && !el.getAttribute('data-sa-loading')) {
          const woId = currentWoIdInDomain();
          if (woId != null) { el.setAttribute('data-sa-loading', '1'); loadInline(woId, el); }
        }
      } catch (_) {}
    }, 120);
  }

  function observe() {
    if (window.__saWoSchedObs) return;
    const obs = new MutationObserver(function () { if (onDetail()) scheduleEnsure(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saWoSchedObs = obs;
  }

  function installUrlChangeListener() {
    if (window.__saWoSchedUrlListener) return;
    window.__saWoSchedUrlListener = true;
    const fire = function () { window.dispatchEvent(new Event('sa-wosched-urlchange')); };
    ['pushState', 'replaceState'].forEach(function (m) { const orig = history[m]; history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; }; });
    window.addEventListener('popstate', fire);
    window.addEventListener('sa-wosched-urlchange', function () {
      removeInline();   // se re-crea para la nueva ficha (evita mostrar datos de la anterior)
      if (onDetail()) scheduleEnsure();
    });
  }

  function init() {
    if (window.__saWoSchedInit) return;
    window.__saWoSchedInit = true;
    patchFetch();               // ANTES de que la ficha dispare la nativa
    installUrlChangeListener();
    observe();
    if (onDetail()) scheduleEnsure();
    console.log('[SA] WoScheduleButton activo (readout de programación inline en la ficha de OT)');
  }

  // Popup: informa el estado (no abre modal en Fase 1).
  function openFromPopup() {
    if (!onDetail()) return { ok: false, reason: 'No estás en la ficha de una OT.' };
    scheduleEnsure();
    return { ok: true, note: 'La programación se muestra inline en el header (📅). El modal de programación intencional llega en la Fase 2.' };
  }

  return { init, openFromPopup };
})();

if (typeof window !== 'undefined') {
  window.WoScheduleButton = WoScheduleButton;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { WoScheduleButton.init(); });
  } else {
    WoScheduleButton.init();
  }
}
