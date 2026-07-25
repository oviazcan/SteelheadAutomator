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
      // Readout como TEXTO (no caja/botón): una fila por tarea = 📅 + texto que envuelve.
      // El 📅 es el elemento accionable (Fase 2: click → programar ESE paso de la OT).
      '#' + INLINE_ID + '{display:inline-flex;flex-direction:column;gap:2px;margin:0 8px;',
      'max-width:min(46vw,460px);vertical-align:middle;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '#' + INLINE_ID + ' .sa-wosched-row2{display:flex;align-items:flex-start;gap:5px;font-size:12.5px;line-height:1.3;}',
      // 📅 accionable (Fase 1: informativo; Fase 2: cursor:pointer + click).
      '#' + INLINE_ID + ' .sa-wosched-cal{flex:0 0 auto;font-size:14px;line-height:1.25;cursor:default;user-select:none;}',
      // Texto plano que ENVUELVE (sin ellipsis, sin truncar) → se ve completo.
      '#' + INLINE_ID + ' .sa-wosched-txt2{white-space:normal;overflow-wrap:anywhere;color:#243244;font-weight:500;}',
      '#' + INLINE_ID + ' .sa-wosched-txt2.muted{color:#6b7280;font-style:italic;font-weight:400;}',
      '#' + INLINE_ID + ' .sa-wosched-txt2.err{color:#b04a3a;font-weight:500;}',
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
    renderLoading(el);
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

  // Una fila = 📅 + texto. El 📅 es el elemento accionable (Fase 2: al capturar la
  // mutación, su click programará ESE paso de la OT). Guarda la tarea en data-attrs.
  function addRow(el, text, opts) {
    opts = opts || {};
    const row = document.createElement('div'); row.className = 'sa-wosched-row2';
    const cal = document.createElement('span'); cal.className = 'sa-wosched-cal'; cal.textContent = '📅';
    cal.title = opts.calTitle || 'Programación intencional (crear/editar): próximamente (Fase 2).';
    if (opts.task) {
      const t = opts.task;
      if (t.stationId != null) cal.setAttribute('data-sa-station-id', String(t.stationId));
      if (t.scheduleId != null) cal.setAttribute('data-sa-schedule-id', String(t.scheduleId));
      if (t.taskId != null) cal.setAttribute('data-sa-task-id', String(t.taskId));
    }
    const txt = document.createElement('span');
    txt.className = 'sa-wosched-txt2' + (opts.muted ? ' muted' : '') + (opts.err ? ' err' : '');
    txt.textContent = text;
    row.appendChild(cal); row.appendChild(txt);
    el.appendChild(row);
  }
  function renderLoading(el) { if (!el) return; el.textContent = ''; el.title = 'Programación de esta OT'; addRow(el, 'Programación…', { muted: true }); }
  function renderError(el, msg) { if (!el) return; el.textContent = ''; el.title = msg; addRow(el, msg, { err: true }); }

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
    el.textContent = '';
    if (!tasks || !tasks.length) {
      el.title = 'Esta OT no está programada.';
      addRow(el, 'Sin programar', { muted: true, calTitle: 'Programar esta OT: próximamente (Fase 2).' });
      return;
    }
    // Un 📅 por tarea/estación (Fase 2: cada 📅 programa ESE paso de la OT).
    tasks.forEach(function (t) { addRow(el, taskText(t), { task: t }); });
    el.title = tasks.map(function (t, i) { return (i + 1) + ') ' + taskText(t); }).join('\n');
  }

  // ── Carga de datos ───────────────────────────────────────────────────────────
  // Resuelve las tareas de la OT UNA sola vez (memoizado + dedupe en-vuelo) → así el
  // PREFETCH temprano (en init, sin esperar al header) y el render on-mount comparten el
  // mismo fetch (nunca doble). Es el dato #1: arranca lo antes posible.
  function inflight() { if (!window.__saWoSchedInflight) window.__saWoSchedInflight = new Map(); return window.__saWoSchedInflight; }
  function ensureResolved(woIdInDomain) {
    if (resolvedCache().has(woIdInDomain)) return Promise.resolve(resolvedCache().get(woIdInDomain));
    if (inflight().has(woIdInDomain)) return inflight().get(woIdInDomain);
    const p = (async function () {
      const api = window.SteelheadAPI;
      const domainId = Core().parseDomainId(location.pathname);
      const data = await api.query('WorkOrder', { idInDomain: woIdInDomain }, 'WorkOrder');
      let woGlobalId = Core().extractWorkOrderGlobalId(data);
      if (woGlobalId == null && data && data.workOrderByIdInDomain) woGlobalId = data.workOrderByIdInDomain.id;
      if (woGlobalId == null) { resolvedCache().set(woIdInDomain, []); return []; }
      const idx = await ensureBoardIndex(domainId, woGlobalId);
      const tasks = Core().resolveBoardScheduleForWO(idx, woGlobalId);
      resolvedCache().set(woIdInDomain, tasks);
      return tasks;
    })();
    inflight().set(woIdInDomain, p);
    const done = function () { inflight().delete(woIdInDomain); };
    p.then(done, done);
    return p;
  }

  // Dispara el fetch YA (sin esperar al header). Si el readout ya está montado, lo pinta.
  function prefetch(woIdInDomain) {
    if (woIdInDomain == null) return;
    ensureResolved(woIdInDomain).then(function (tasks) {
      if (currentWoIdInDomain() !== woIdInDomain) return;
      const el = document.getElementById(INLINE_ID);
      if (el) renderInline(el, tasks);
    }).catch(function () { /* el render on-mount reintenta y muestra el error */ });
  }

  async function loadInline(woIdInDomain, el) {
    let tasks;
    try { tasks = await ensureResolved(woIdInDomain); }
    catch (e) {
      renderError(el, (e && e.persistedQueryRotated)
        ? 'El hash de WorkOrderSchedule/WorkOrder rotó — avísale a Claude.'
        : 'No se pudo cargar la programación: ' + (e && e.message ? e.message : 'error'));
      return;
    }
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
  // Gauge de /graphql en vuelo (para saber cuándo la ficha "se calmó" antes de imprimir).
  function gql() { if (!window.__saGqlGauge) window.__saGqlGauge = { inflight: 0, lastChange: Date.now() }; return window.__saGqlGauge; }
  function waitForGraphqlIdle(idleMs, maxWaitMs) {
    idleMs = idleMs || 1200; maxWaitMs = maxWaitMs || 12000;
    return new Promise(function (resolve) {
      const t0 = Date.now();
      (function tick() {
        const g = gql();
        if (g.inflight <= 0 && (Date.now() - g.lastChange) >= idleMs) return resolve(true);
        if (Date.now() - t0 > maxWaitMs) return resolve(false);
        setTimeout(tick, 200);
      })();
    });
  }

  function patchFetch() {
    if (window.__saWoSchedFetchPatched) return;
    window.__saWoSchedFetchPatched = true;
    const orig = window.fetch;
    window.fetch = function (input, init) {
      let isWos = false, domainId = null, isGql = false, isPdfOut = false;
      try {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        const body = (init && typeof init.body === 'string') ? init.body : '';
        const hay = body || url;   // POST → body; GET APQ → url (?operationName=…)
        if (url.indexOf('/graphql') !== -1) isGql = true;
        if (hay.indexOf('GetPdfTemplateOutputV2') !== -1 || hay.indexOf('GetPdfTemplateOutputToUserFile') !== -1) isPdfOut = true;
        if (hay.indexOf('WorkOrderSchedule') !== -1) {
          isWos = true;
          const dm = hay.match(/domainId(?:"\s*:\s*|=)(\d+)/);
          domainId = dm ? parseInt(dm[1], 10) : Core().parseDomainId(location.pathname);
        }
      } catch (_) {}
      if (isGql) { const g = gql(); g.inflight++; g.lastChange = Date.now(); }
      const p = orig.apply(this, arguments);
      if (isGql) { const settle = function () { const g = gql(); g.inflight = Math.max(0, g.inflight - 1); g.lastChange = Date.now(); }; p.then(settle, settle); }
      // Intercepta la respuesta del renderizador → share-URL del PDF (sin depender del preview DOM).
      if (isPdfOut) {
        p.then(function (resp) {
          try {
            resp.clone().text().then(function (txt) {
              try {
                const clean = String(txt).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
                const m = clean.match(/\/api\/pdf\/share\/\d+\/[a-z0-9]+(?:\?[^"'\\<> ]*)?/i);
                if (m) {
                  let u = m[0]; if (u.indexOf('http') !== 0) u = location.origin + u;
                  window.__saLastPdfShare = { url: u, at: Date.now() };
                  PLOG('GetPdfTemplateOutputV2 respondió → ' + u);
                } else { PLOG('GetPdfTemplateOutputV2 respondió pero SIN /api/pdf/share/ (¿error?)'); }
              } catch (_) {}
            }).catch(function () {});
          } catch (_) {}
        }).catch(function () {});
      }
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
    inflight().delete(woId);
    loadInline(woId, el);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Impresión de PDFs (JobTag / Verbose) — AUTO-MANEJO del flujo nativo
  // ══════════════════════════════════════════════════════════════════════════
  // El `data` del renderizador lo arma el front (blob gigante, no reconstruible). Así que
  // dejamos que SH haga TODO (fetch + ensamblado + render server-side) y solo:
  //   1) click "Imprimir Etiquetas de Trabajo" (header)  → modal de selección
  //   2) click "Imprimir Regular"/"Detallado" (por tipo) → SH renderiza → modal preview
  //   3) tomamos la share-URL del <object data="…/api/pdf/share/…"> y la abrimos
  //   4) cerramos los modales (sin mostrar el preview)
  // Por-OT (una a la vez) → sin el techo de merge de PDFGeneratorAPI (~16-20 en batch).
  // NO-destructivo (genera el mismo PDF que el flujo nativo). Fail-safe: ante cualquier
  // fallo, deja el modal nativo abierto para que el operador termine a mano.
  // Texto del botón del header — BILINGÜE (SH muestra locale mixto: header en EN "Print Job Tags"
  // aunque el resto esté en ES). Solo confirma; el anclaje primario es el data-steelhead-component-id.
  const PRINT_TRIGGER_RE = /imprimir\s+etiquetas\s+de\s+trabajo|print\s+(?:multiple\s+)?job\s+tags/i;
  const PRINT_ANCHOR = '[data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_PRINT_JOB_TAGS_BUTTON"]';
  const PRINT_POLL_MS = 250, PRINT_TIMEOUT_MS = 12000;
  function isVisible(el) { return !!(el && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length))); }
  function PLOG(m) { try { console.log('[SA][print]', m); } catch (_) {} }

  function btnText(b) { return (b && b.textContent ? b.textContent : '').replace(/\s+/g, ' ').trim(); }

  // Espera a que `fn()` devuelva algo truthy; resuelve con ese valor o rechaza por timeout.
  function waitFor(fn, timeoutMs) {
    timeoutMs = timeoutMs || PRINT_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
      const t0 = Date.now();
      (function tick() {
        let v = null; try { v = fn(); } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout'));
        setTimeout(tick, PRINT_POLL_MS);
      })();
    });
  }

  // Botón nativo del header que abre el modal de impresión. Anclaje PRIMARIO por el
  // data-steelhead-component-id (idioma- y responsive-agnóstico = el mejor anclaje). Dentro
  // del ancla, elige el elemento VISIBLE clicable: el <button> (vista normal) o la versión
  // ICONO-solo (span con aria-label + QrCode2Icon, vista chica). Fallback legacy sin el ancla.
  function findPrintTrigger() {
    const anchor = document.querySelector(PRINT_ANCHOR);
    if (anchor) {
      const btn = Array.prototype.slice.call(anchor.querySelectorAll('button')).find(isVisible);
      if (btn) return btn;
      // vista chica: icono-solo (span aria-label con el QrCode2Icon, cursor:pointer)
      const icon = Array.prototype.slice.call(anchor.querySelectorAll('[aria-label]'))
        .find(function (e) { return isVisible(e) && e.querySelector && e.querySelector('svg[data-testid="QrCode2Icon"]'); });
      if (icon) return icon;
      if (isVisible(anchor)) return anchor;   // último recurso: el propio contenedor (click bubbling)
    }
    // FALLBACK legacy (sin el ancla): botón outlined con QrCode2Icon, o texto bilingüe.
    const btns = document.querySelectorAll('button');
    let byStruct = null;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!b.querySelector('svg[data-testid="QrCode2Icon"]')) continue;
      if (PRINT_TRIGGER_RE.test(btnText(b))) return b;
      if (/MuiButton-outlined/.test(b.className || '') && !byStruct) byStruct = b;
    }
    return byStruct;
  }
  // Diagnóstico: vuelca el estado del ancla/botones si el trigger no aparece (para ver por qué).
  function dumpTriggerCandidates() {
    try {
      const anchor = document.querySelector(PRINT_ANCHOR);
      PLOG('ancla ' + (anchor ? ('presente, visible=' + isVisible(anchor)) : 'AUSENTE') +
        ' · botones QrCode2Icon en página: ' + document.querySelectorAll('button svg[data-testid="QrCode2Icon"]').length);
    } catch (_) {}
  }
  // El modal de selección de plantilla (dialog con sus 2 MuiButton-contained de impresión).
  function findPrintDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (let i = 0; i < dialogs.length; i++) {
      const d = dialogs[i];
      const heading = d.querySelector('h2,h6,[id="form-dialog-title"]');
      const contained = d.querySelectorAll('button.MuiButton-contained');
      if (contained.length >= 1 && (Core().isPrintDialogHeading(btnText(heading)) || contained.length >= 2)) {
        // confirma que es el de impresión: algún contained trae QrCode2Icon
        for (let k = 0; k < contained.length; k++) if (contained[k].querySelector('svg[data-testid="QrCode2Icon"]')) return d;
      }
    }
    return null;
  }
  // El modal de impresión aunque esté en "Cargando…" (por su encabezado o sus botones).
  function findAnyPrintDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (let i = 0; i < dialogs.length; i++) {
      const d = dialogs[i];
      const heading = d.querySelector('h2,h6,[id="form-dialog-title"]');
      if (Core().isPrintDialogHeading(btnText(heading))) return d;
      if (d.querySelector('button.MuiButton-contained svg[data-testid="QrCode2Icon"]')) return d;
    }
    return null;
  }
  // Botón "Imprimir Regular/Detallado" del modal para el tipo pedido (texto ES → fallback orden).
  function findModalPrintButton(dialog, typeKey) {
    const t = Core().printType(typeKey); if (!dialog || !t) return null;
    const btns = Array.prototype.slice.call(dialog.querySelectorAll('button.MuiButton-contained'))
      .filter(function (b) { return b.querySelector('svg[data-testid="QrCode2Icon"]'); });
    // 1) por texto exacto ES; 2) fallback por orden (0=Regular, 1=Detallado)
    const byText = btns.find(function (b) { return btnText(b).toLowerCase() === t.buttonTextEs.toLowerCase(); });
    if (byText) return byText;
    return btns[t.order] || null;
  }
  // Descarga el PDF a la carpeta Descargas (sin navegar) — la share-URL es same-origin, así que
  // el atributo `download` fuerza la descarga con nombre. Funciona aun en pestaña de 2º plano.
  function downloadPdf(url, typeKey) {
    try {
      const parsed = Core().parsePdfShareUrl(url);
      const name = (parsed && parsed.downloadName) ? parsed.downloadName : Core().buildPdfFilename(typeKey, currentWoIdInDomain());
      // La URL INTERCEPTADA de GetPdfTemplateOutputV2 NO trae ?downloadName= (el <object> del
      // preview sí lo agrega); el server nombra el archivo por ESE param → si falta, baja con el
      // TOKEN como nombre. Reponemos el param con el nombre correcto. a.download es respaldo.
      const dlUrl = url.split('?')[0] + '?downloadName=' + encodeURIComponent(name);
      const a = document.createElement('a');
      a.href = dlUrl; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      PLOG('descarga disparada: ' + name);
    } catch (e) { PLOG('descarga falló → navego: ' + (e && e.message)); try { location.href = url; } catch (_) {} }
  }
  // Share-URL interceptada de GetPdfTemplateOutputV2, si es MÁS reciente que el click actual.
  function freshPdfUrl(sinceMs) {
    const s = window.__saLastPdfShare;
    return (s && s.at >= sinceMs && Core().isPdfShareUrl(s.url)) ? s.url : null;
  }
  // Share-URL del PDF en el modal de preview (o cualquier <object>/<a> que la traiga).
  function findShareUrl() {
    const nodes = document.querySelectorAll('object[data*="/api/pdf/share/"], a[href*="/api/pdf/share/"], iframe[src*="/api/pdf/share/"]');
    for (let i = 0; i < nodes.length; i++) {
      const u = nodes[i].getAttribute('data') || nodes[i].getAttribute('href') || nodes[i].getAttribute('src') || '';
      if (Core().isPdfShareUrl(u)) return u.indexOf('http') === 0 ? u : (location.origin + u);
    }
    return null;
  }
  // Cierra los modales de impresión/preview (botón Cerrar/Cancelar, o Escape).
  function closePrintDialogs() {
    document.querySelectorAll('[role="dialog"]').forEach(function (d) {
      const heading = d.querySelector('h2,h6');
      if (Core().isPrintPreviewHeading(btnText(heading)) || Core().isPrintDialogHeading(btnText(heading)) || d.querySelector('object[data*="/api/pdf/share/"]')) {
        const closeBtn = d.querySelector('button svg[data-testid="CloseIcon"]');
        const cancel = Array.prototype.slice.call(d.querySelectorAll('button')).find(function (b) { return /cancelar|cerrar|close|cancel/i.test(btnText(b)); });
        const b = (closeBtn && closeBtn.closest('button')) || cancel;
        if (b) { try { b.click(); } catch (_) {} }
      }
    });
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
  }

  // Click robusto para botones MUI/React: secuencia de eventos de puntero + click nativo.
  // (`.click()` solo a veces no dispara el handler; la secuencia completa cubre onMouseDown/
  // onPointerDown/onClick.) Un solo evento 'click' al final → no doble-dispara el render.
  function clickButtonRobust(b) {
    try { if (b.focus) b.focus(); } catch (_) {}
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      try { b.dispatchEvent(new MouseEvent(type, opts)); } catch (_) {}
    });
    try { b.click(); } catch (_) {}
  }

  // Orquestador. openTarget: 'newtab' (gesto del usuario) | 'self' (auto-disparo remoto).
  // Devuelve la share-URL. En 'newtab' preserva el gesto abriendo la pestaña YA.
  async function autoPrint(typeKey, openTarget) {
    const t = Core().printType(typeKey);
    if (!t) return null;
    // Abre la pestaña ANTES de los awaits (preserva el user-gesture → no lo bloquea el popup blocker).
    let win = null;
    if (openTarget === 'newtab') { try { win = window.open('', '_blank'); } catch (_) {} }
    const fail = function (msg) {
      if (win) { try { win.close(); } catch (_) {} }
      printToast('⚠️ ' + msg + ' — abrí el modal nativo y termina a mano.');
    };
    try {
      // Hasta 2 intentos: el modal a veces se queda en "Cargando…" si se abre mientras la
      // ficha aún baja datos → cerramos y reabrimos con la red ya calmada.
      let pbtn = null;
      for (let attempt = 0; attempt < 2 && !pbtn; attempt++) {
        if (!findAnyPrintDialog()) {
          const trigger = findPrintTrigger();
          if (!trigger) { fail('No encontré el botón "Imprimir Etiquetas de Trabajo"'); return null; }
          PLOG('abro modal (intento ' + (attempt + 1) + ')'); trigger.click();
        } else { PLOG('modal ya abierto (intento ' + (attempt + 1) + ')'); }
        // Espera a que el modal esté LISTO: sin "Cargando…", con el dropdown de plantilla YA
        // poblado (si no, "Imprimir Regular" no tiene plantilla → no-op) y el botón habilitado.
        pbtn = await waitFor(function () {
          const d = findAnyPrintDialog(); if (!d) return null;
          if (/cargando|loading/i.test(d.textContent || '')) return null;   // aún cargando su contenido
          const val = d.querySelector('[class*="singleValue"]');
          if (val && !btnText(val)) return null;                            // dropdown existe pero SIN valor → esperar
          const b = findModalPrintButton(d, typeKey);
          return (b && !b.disabled) ? b : null;
        }, 12000).catch(function () { return null; });
        if (!pbtn && attempt === 0) {
          PLOG('modal en "Cargando…" tras 11s → cierro, espero red-idle y reintento');
          closePrintDialogs(); await sleep(900); await waitForGraphqlIdle(1000, 8000);
        }
      }
      if (!pbtn) { fail('El modal se quedó en "Cargando…" o el dropdown de plantilla no cargó'); return null; }
      await sleep(350);   // deja que React termine de cablear el onClick del botón
      const clickAt = Date.now();
      PLOG('click "' + t.buttonTextEs + '" (dropdown OK, disabled=' + !!pbtn.disabled + ')');
      clickButtonRobust(pbtn);
      // Toma la share-URL de la respuesta INTERCEPTADA de GetPdfTemplateOutputV2 (robusto, apenas
      // el server responde) O del <object> del preview (fallback DOM). Hasta 40s (render server-side).
      let url;
      try { url = await waitFor(function () { return freshPdfUrl(clickAt) || findShareUrl(); }, 40000); }
      catch (e) {
        const fired = window.__saLastPdfShare && window.__saLastPdfShare.at >= clickAt;
        fail(fired ? 'El render respondió pero no traía la URL del PDF' : 'El render (GetPdfTemplateOutputV2) no respondió tras el click');
        return null;
      }
      PLOG('PDF listo: ' + url);
      if (openTarget === 'download') {
        downloadPdf(url, typeKey);
        setTimeout(closePrintDialogs, 300);
        setTimeout(function () { try { window.close(); } catch (_) {} }, 2000);   // cierra la pestaña de 2º plano (best-effort)
      } else {
        if (win) { try { win.location.href = url; } catch (_) { window.open(url, '_blank'); } }
        else if (openTarget === 'self') { location.href = url; }
        else { window.open(url, '_blank'); }
        setTimeout(closePrintDialogs, 400);   // deja que el <object> exista antes de cerrar
        printToast('🏷️ PDF ' + t.key + ' generado.');
      }
      return url;
    } catch (e) {
      fail('No pude generar el PDF (' + (e && e.message ? e.message : 'error') + ')');
      return null;
    }
  }

  // Auto-disparo remoto: /WorkOrders/<id>?sa_print=jobtag → genera y navega al PDF (una vez).
  // Espera a que la ficha CARGUE del todo (readyState + red /graphql calmada) antes de abrir el
  // modal — abrirlo durante la carga pesada (WorkOrderSchedule 4.6MB) lo deja en "Cargando…".
  function maybeAutoPrintFromParam() {
    if (!onDetail()) return;
    const typeKey = Core().parsePrintParam(location.search);
    if (!typeKey || window.__saWoPrintFired) return;
    window.__saWoPrintFired = true;
    const dl = /[?&]sa_dl=1/i.test(location.search);   // modo DESCARGA (pestaña de 2º plano)
    PLOG('auto-disparo remoto: ' + typeKey + (dl ? ' [descarga]' : '') + ' visible=' + document.visibilityState);
    (async function run() {
      try {
        PLOG('run(): esperando el botón "Imprimir Etiquetas" del header…');
        // La pestaña se abre en 2º PLANO (para lanzar varias en paralelo): los timers se
        // estrangulan → damos MUCHA paciencia. El render y la descarga corren igual en 2º plano.
        try { await waitFor(findPrintTrigger, 6000); }
        catch (_) { dumpTriggerCandidates(); await waitFor(findPrintTrigger, 90000); }
        PLOG('trigger encontrado → espero red-idle');
        await waitForGraphqlIdle(1000, 15000);
        await sleep(400);
        PLOG('página lista → auto-imprimo ' + typeKey);
        autoPrint(typeKey, dl ? 'download' : 'self');
      } catch (e) {
        PLOG('auto-disparo no completó (' + (e && e.message) + ')');
        dumpTriggerCandidates();
        openModalForManual(typeKey);
      }
    })();
  }
  // Fallback: si el auto-manejo no completa, deja el modal nativo abierto para el último clic.
  async function openModalForManual(typeKey) {
    try {
      if (!findAnyPrintDialog()) { const trg = findPrintTrigger(); if (trg) trg.click(); }
      const t = Core().printType(typeKey);
      printToast('🏷️ Abrí el modal de etiquetas — dale clic a "' + (t ? t.buttonTextEs : 'Imprimir Regular') + '".');
    } catch (_) {}
  }

  let printToastTimer = null;
  function printToast(msg) {
    let el = document.getElementById('sa-woprint-toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'sa-woprint-toast';
      el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483600;' +
        'background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;border-left:4px solid #13a36f;border-radius:10px;' +
        'padding:12px 18px;font-size:14px;max-width:80vw;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    if (printToastTimer) clearTimeout(printToastTimer);
    printToastTimer = setTimeout(function () { const e = document.getElementById('sa-woprint-toast'); if (e) e.remove(); }, 4500);
  }

  // NOTA: la impresión NO pone botones en la ficha (decisión del usuario 2026-07-24: el
  // botón vive SOLO en la columna Acciones del listado). Aquí el auto-manejo es INVISIBLE:
  // se dispara por el parámetro ?sa_print= (maybeAutoPrintFromParam) cuando el botón del
  // listado abre la ficha en pestaña nueva. `autoPrint` queda expuesto para ese disparo.

  // ── Montaje idempotente + observer + navegación SPA ──────────────────────────
  let obsTimer = null;
  function scheduleEnsure() {
    if (obsTimer) return;
    obsTimer = setTimeout(function () {
      obsTimer = null;
      try {
        const el = ensureInline();
        if (el && !el.getAttribute('data-sa-loading')) {   // carga una vez por montaje
          const woId = currentWoIdInDomain();
          // PRIORIDAD: la programación es el dato #1 (supervisor escanea QR → "¿a qué hora
          // está programada?"). Arranca YA, sin diferir ni esperar idle.
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
      removeInline();                    // se re-crea para la nueva ficha
      window.__saWoPrintFired = false;   // permite auto-disparo en la nueva ficha (?sa_print=)
      if (onDetail()) { prefetch(currentWoIdInDomain()); scheduleEnsure(); maybeAutoPrintFromParam(); }
    });
  }

  function init() {
    if (window.__saWoSchedInit) return;
    window.__saWoSchedInit = true;
    patchFetch();               // ANTES de que la ficha dispare la nativa
    installUrlChangeListener();
    observe();
    // Dato #1: dispara el fetch de programación YA en init (sin esperar al header),
    // para que sea de lo primero que carga (antes que vale-almacén / paro-de-línea).
    if (onDetail()) { prefetch(currentWoIdInDomain()); scheduleEnsure(); maybeAutoPrintFromParam(); }
    console.log('[SA] WoScheduleButton activo (readout de programación + impresión en la ficha de OT)');
  }

  // Popup: informa el estado (no abre modal en Fase 1).
  function openFromPopup() {
    if (!onDetail()) return { ok: false, reason: 'No estás en la ficha de una OT.' };
    scheduleEnsure();
    return { ok: true, note: 'La programación se muestra inline en el header (📅). El modal de programación intencional llega en la Fase 2.' };
  }

  return { init, openFromPopup, autoPrint: autoPrint };
})();

if (typeof window !== 'undefined') {
  window.WoScheduleButton = WoScheduleButton;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { WoScheduleButton.init(); });
  } else {
    WoScheduleButton.init();
  }
}
