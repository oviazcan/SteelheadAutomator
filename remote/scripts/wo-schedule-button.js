// Botón "Programación" en la ficha individual de Orden de Trabajo — glue DOM.
// En /Domains/<d>/WorkOrders/<idInDomain> inyecta un botón en el header, ENTRE
// "EDITAR DETALLES" y "ABRIR PDF", que abre un panel dark-mode con la programación de
// la OT (cuándo/dónde). Motivo: en iPad la tarjeta "Cliente" (con el ícono 📅 nativo)
// se colapsa y deja de verse; el botón arriba da acceso inmediato e independiente.
//
// Anclaje: handle semántico ESTABLE `data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON"`
// (idioma-agnóstico; "Abrir PDF" es el 1er elemento del grupo derecho del header, así
// que insertar ANTES de él lo deja justo entre "Editar Detalles" y "Abrir PDF").
//
// Estado FASE 1 (consulta): el panel muestra el resumen de la OT (nombre + fecha límite,
// vía el query `WorkOrder` ya en config) y la programación real (cuándo/dónde). La LECTURA
// de la tarea agendada está detrás de SCHEDULE_READ_ENABLED hasta capturar la query del
// board que mapea workOrderId→tarea (ver bitácora). FASE 2 (crear programación) es aparte.
//
// Auto-inyectado (autoInject:true). Singleton en window.__saWoSchedBtn* para sobrevivir la
// re-inyección del IIFE.
const WoScheduleButton = (() => {
  'use strict';

  const Core = () => window.WoScheduleCore;

  const BTN_ID = 'sa-wosched-btn';
  const PDF_ANCHOR = '[data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON"]';

  // Lectura de programación ACTIVA: query `WorkOrderSchedule({domainId, workOrderId})`
  // (hash en config) → board completo → WoScheduleCore.buildBoardScheduleIndex → tareas
  // de la WO. Shape confirmado en scan real 2026-07-23.
  const SCHEDULE_READ_ENABLED = true;

  function onDetail() { return Core().isWorkOrderDetailPath(location.pathname); }
  function currentWoIdInDomain() { return Core().parseWorkOrderIdInDomain(location.pathname); }

  // ── Estilos ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-wosched-style')) return;
    const css = [
      // Botón integrado a la barra clara nativa, pero con acento verde (= UI de la extensión).
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:6px;cursor:pointer;',
      'border:1px solid #13a36f;border-radius:6px;background:#eef6f2;color:#0d6b49;',
      'font-weight:600;font-size:13px;padding:5px 12px;margin:0 6px;white-space:nowrap;flex-shrink:0;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.2;}',
      '#' + BTN_ID + ':hover{background:#e0f0e8;border-color:#0d6b49;}',
      // Panel dark-mode (UI propia — regla de diseño).
      '.sa-wosched-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483640;',
      'display:flex;align-items:center;justify-content:center;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.sa-wosched-panel{background:#1c2430;color:#e6e9ee;border:1px solid #33404f;border-radius:10px;',
      'max-width:520px;width:92%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 14px 44px rgba(0,0,0,.55);}',
      '.sa-wosched-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #2b3645;}',
      '.sa-wosched-head h2{margin:0;font-size:16px;font-weight:700;color:#e6e9ee;}',
      '.sa-wosched-x{cursor:pointer;color:#9aa7b5;font-size:22px;line-height:1;border:none;background:none;padding:0 4px;}',
      '.sa-wosched-x:hover{color:#e6e9ee;}',
      '.sa-wosched-body{padding:16px 18px;overflow-y:auto;font-size:13.5px;line-height:1.5;}',
      '.sa-wosched-row{display:flex;gap:8px;margin:0 0 8px 0;}',
      '.sa-wosched-k{color:#9aa7b5;min-width:120px;flex:0 0 auto;}',
      '.sa-wosched-v{color:#e6e9ee;font-weight:600;}',
      '.sa-wosched-sched{margin-top:12px;padding:12px;border-radius:8px;background:#141a23;border:1px solid #2b3645;}',
      '.sa-wosched-sched .lbl{color:#13a36f;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px;}',
      '.sa-wosched-muted{color:#8a97a5;font-style:italic;}',
      '.sa-wosched-task{padding:6px 0;border-top:1px dashed #2b3645;}',
      '.sa-wosched-task:first-of-type{border-top:none;}',
      '.sa-wosched-err{color:#e08a7a;}',
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-wosched-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Botón en el header ───────────────────────────────────────────────────────
  function buildButton() {
    injectStyles();
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Ver la programación de esta Orden de Trabajo';
    const ico = document.createElement('span'); ico.textContent = '📅';
    const txt = document.createElement('span'); txt.textContent = 'Programación';
    btn.appendChild(ico); btn.appendChild(txt);
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel(); });
    return btn;
  }

  function ensureButton() {
    if (!onDetail()) return;
    if (document.getElementById(BTN_ID)) return;   // idempotente
    const pdf = document.querySelector(PDF_ANCHOR);
    if (!pdf || !pdf.parentElement) return;        // header aún no renderiza: observer reintenta
    pdf.parentElement.insertBefore(buildButton(), pdf);
  }

  function removeButton() {
    const b = document.getElementById(BTN_ID); if (b) b.remove();
  }

  // ── Panel dark-mode ──────────────────────────────────────────────────────────
  function closePanel() {
    const ov = document.getElementById('sa-wosched-ov'); if (ov) ov.remove();
  }

  function openPanel() {
    injectStyles();
    closePanel();
    const woId = currentWoIdInDomain();
    const ov = document.createElement('div');
    ov.className = 'sa-wosched-ov'; ov.id = 'sa-wosched-ov';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closePanel(); });

    const panel = document.createElement('div'); panel.className = 'sa-wosched-panel';
    const head = document.createElement('div'); head.className = 'sa-wosched-head';
    const h2 = document.createElement('h2'); h2.textContent = 'Programación — OT ' + (woId != null ? woId : '');
    const x = document.createElement('button'); x.className = 'sa-wosched-x'; x.textContent = '×';
    x.addEventListener('click', closePanel);
    head.appendChild(h2); head.appendChild(x);

    const body = document.createElement('div'); body.className = 'sa-wosched-body'; body.id = 'sa-wosched-body';
    const loading = document.createElement('div'); loading.className = 'sa-wosched-muted'; loading.textContent = 'Cargando…';
    body.appendChild(loading);

    panel.appendChild(head); panel.appendChild(body);
    ov.appendChild(panel);
    document.body.appendChild(ov);

    // ESC cierra.
    const onKey = function (e) { if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    loadPanel(woId, body);
  }

  async function loadPanel(woIdInDomain, body) {
    const api = window.SteelheadAPI;
    let wo = null;
    try {
      const data = await api.query('WorkOrder', { idInDomain: woIdInDomain }, 'WorkOrder');
      wo = (data && data.workOrderByIdInDomain) || null;
    } catch (e) {
      renderPanelError(body, e);
      return;
    }
    const schedBox = renderPanel(body, woIdInDomain, wo);
    // Programación real: WorkOrderSchedule necesita el workOrderId GLOBAL (wo.id), no idInDomain.
    if (SCHEDULE_READ_ENABLED && schedBox && wo && wo.id != null) {
      loadSchedule(schedBox, wo.id);
    }
  }

  // Fetch del board + filtrado a la WO + render. Errores aquí NO tumban el panel (el
  // resumen de la OT ya se mostró).
  async function loadSchedule(box, woGlobalId) {
    const api = window.SteelheadAPI;
    const domainId = Core().parseDomainId(location.pathname);
    try {
      const data = await api.query('WorkOrderSchedule', { domainId: domainId, workOrderId: woGlobalId }, 'WorkOrderSchedule');
      const idx = Core().buildBoardScheduleIndex(data);
      const tasks = Core().resolveBoardScheduleForWO(idx, woGlobalId);
      renderScheduleTasks(box, tasks);
    } catch (e) {
      box.textContent = '';
      const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = 'Programación (cuándo / dónde)'; box.appendChild(lbl);
      const err = document.createElement('div'); err.className = 'sa-wosched-err';
      err.textContent = (e && e.persistedQueryRotated)
        ? '⚠️ El hash de WorkOrderSchedule rotó — avísale a Claude.'
        : '⚠️ No se pudo cargar la programación: ' + (e && e.message ? e.message : 'error');
      box.appendChild(err);
    }
  }

  function renderPanelError(body, e) {
    body.textContent = '';
    const err = document.createElement('div'); err.className = 'sa-wosched-err';
    err.textContent = (e && e.persistedQueryRotated)
      ? '⚠️ El hash de WorkOrder rotó — avísale a Claude para actualizarlo.'
      : '⚠️ No se pudo cargar la OT: ' + (e && e.message ? e.message : 'error');
    body.appendChild(err);
  }

  function row(k, v) {
    const r = document.createElement('div'); r.className = 'sa-wosched-row';
    const kk = document.createElement('div'); kk.className = 'sa-wosched-k'; kk.textContent = k;
    const vv = document.createElement('div'); vv.className = 'sa-wosched-v'; vv.textContent = (v != null && v !== '') ? String(v) : '—';
    r.appendChild(kk); r.appendChild(vv);
    return r;
  }

  // Fecha legible localizada (glue puede usar Date; el core da el fallback determinista).
  function fmtDeadline(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (!isNaN(d.getTime())) return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (_) {}
    const p = Core().parseIsoParts(iso);
    return p ? (p.d + '/' + p.mo + '/' + p.y) : iso;
  }

  // Devuelve el <div> del bloque de programación (para que loadSchedule lo llene).
  function renderPanel(body, woIdInDomain, wo) {
    body.textContent = '';
    body.appendChild(row('Orden de Trabajo', woIdInDomain));
    if (wo) {
      if (wo.name) body.appendChild(row('Nombre', wo.name));
      body.appendChild(row('Fecha Límite', fmtDeadline(wo.deadline)));
    }

    // Bloque de PROGRAMACIÓN (cuándo/dónde).
    const box = document.createElement('div'); box.className = 'sa-wosched-sched';
    const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = 'Programación (cuándo / dónde)';
    box.appendChild(lbl);
    const m = document.createElement('div'); m.className = 'sa-wosched-muted'; m.textContent = 'Buscando programación…';
    box.appendChild(m);
    body.appendChild(box);
    return box;
  }

  // Fecha/hora localizada (glue usa Date; el core da el fallback determinista).
  function fmtLocalDateTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (!isNaN(d.getTime())) return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) {}
    return Core().formatShortDateTime(iso);
  }

  function renderScheduleTasks(box, tasks) {
    box.textContent = '';
    const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = 'Programación (cuándo / dónde)';
    box.appendChild(lbl);
    if (!tasks || !tasks.length) {
      const m = document.createElement('div'); m.className = 'sa-wosched-muted'; m.textContent = 'Esta OT no está programada.';
      box.appendChild(m);
      return;
    }
    tasks.forEach(function (t) {
      const item = document.createElement('div'); item.className = 'sa-wosched-task';
      const est = document.createElement('div');
      est.appendChild(mk('sa-wosched-v', t.stationName || '(estación ' + (t.stationId != null ? t.stationId : '?') + ')'));
      item.appendChild(est);
      const meta = document.createElement('div'); meta.className = 'sa-wosched-muted';
      const when = fmtLocalDateTime(t.expectedStartTime);
      const status = Core().scheduleStatusLabel(t.status);
      meta.textContent = [when, status].filter(Boolean).join(' · ');
      item.appendChild(meta);
      box.appendChild(item);
    });
  }

  function mk(cls, text) {
    const s = document.createElement('span'); s.className = cls; s.textContent = text; return s;
  }

  // ── Montaje idempotente + observer acotado + navegación SPA ───────────────────
  let obsTimer = null;
  function scheduleEnsure() {
    if (obsTimer) return;
    obsTimer = setTimeout(function () { obsTimer = null; try { ensureButton(); } catch (_) {} }, 120);
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
    ['pushState', 'replaceState'].forEach(function (m) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('sa-wosched-urlchange', function () {
      closePanel();
      if (onDetail()) { ensureButton(); } else { removeButton(); }
    });
  }

  function init() {
    if (window.__saWoSchedInit) return;
    window.__saWoSchedInit = true;
    installUrlChangeListener();
    observe();
    if (onDetail()) ensureButton();
    console.log('[SA] WoScheduleButton activo (botón Programación en la ficha de OT)');
  }

  // Handler de popup (además del botón del header): abre el panel si estamos en una ficha.
  function openFromPopup() {
    if (!onDetail()) { return { ok: false, reason: 'No estás en la ficha de una OT.' }; }
    openPanel();
    return { ok: true };
  }

  return { init, openFromPopup, _openPanel: openPanel };
})();

if (typeof window !== 'undefined') {
  window.WoScheduleButton = WoScheduleButton;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { WoScheduleButton.init(); });
  } else {
    WoScheduleButton.init();
  }
}
