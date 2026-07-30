// Candado de Surtido Programado — bloquea mover piezas no programadas en el
// step "Preparando Surtido en Almacén" del Workboard "Preparación de Surtido".
// Glue DOM/red; la lógica de decisión y parseo vive en SurtidoGuardCore.
//
// Capas:
//   1. Mapa "programada" + nodos de surtido + puente account→nodo (lee fetch)   — Task 4
//   2. Enforcement: bloquea CreateManyPartsTransfersChecked (modal y drag)        — Task 5
//   3. Capa de modal: agrisa "Mover" / "Imprimir y Mover"                         — Task 6
//   4. Marcado naranja de tarjetas NO movibles (sin "Tareas Programadas:"/"Scheduled tasks:") — Task 7
//   5. Toggle no persistente desde el popup (default ON cada carga)               — Task 3
//   6. Memory hardening: observer debounced + teardown al salir del board         — Task 8
const SurtidoGuard = (() => {
  'use strict';

  const Core = () => window.SurtidoGuardCore;
  const WB_PATH_RE = /^\/Domains\/\d+\/Workboards\/\d+/;

  // Estado del candado: vive en `window` (singleton), NO en el closure. background.js
  // → injectAppScripts RE-EVALÚA este IIFE en cada acción del popup (surtido-guard.js
  // no está en el mapa `globals` de dedup), creando una instancia nueva. Si el flag
  // viviera en el closure, el toggle mutaría la instancia nueva mientras el interceptor
  // de fetch —latcheado a la instancia ORIGINAL vía __saSurtidoGuardFetchPatched—
  // seguiría leyendo el flag viejo → "Desactivado" sin efecto real. El singleton lo
  // comparten todas las instancias. Default ON solo en la PRIMERA carga (si está sin
  // definir): así una re-inyección no repisa lo que el operador apagó, y un reload
  // limpia window → vuelve a ON (no persistente, por diseño).
  if (window.__saSurtidoGuardEnabled === undefined) window.__saSurtidoGuardEnabled = true;
  function isEnforcementEnabled() { return window.__saSurtidoGuardEnabled === true; }
  function setEnforcementEnabled(v) { window.__saSurtidoGuardEnabled = !!v; }

  let scheduledAccountIds = new Set();  // programados según GetRelatedScheduleData — sólo AFIRMA (ver abajo)
  // Fuente BUENA de "programada": accountId -> boolean, desde GetPartsInProcessNode4 (la query
  // que el board ya pide para pintar las tarjetas). GetRelatedScheduleData viene filtrada por
  // las stationIds del WORKBOARD y en un board de almacén devuelve SIEMPRE vacío —las tareas
  // viven en estaciones de línea—, así que su Set no puede negar nada. Medido 2026-07-30 en el
  // board 10922: 0 programadas por esa vía vs 20 de 127 por ésta.
  let accountScheduled = new Map();
  let surtidoNodeIds = new Set();       // recipeNodeId del nodo de surtido (GetRelatedWorkboardData)
  let accountNode = {};                 // accountId -> {recipeNodeId, workOrderId} (vars de move-data)
  let lastModalCtx = null;              // últimas vars de WorkOrderMovePartsData (para la capa de modal)

  // ── Capa 6: filtro por LÍNEA DESTINO (v0.3.0) ──
  // Estado en `window` por la MISMA razón que el flag del candado (lección v0.1.1):
  // injectAppScripts re-evalúa este IIFE en cada acción del popup, y un estado en el closure
  // quedaría desincronizado del que leen los handlers ya montados.
  // `null` = sin filtro. NO persiste entre recargas, por diseño: un filtro pegado que esconde
  // trabajo hace creer que no hay pendientes.
  if (window.__saSurtidoGuardLine === undefined) window.__saSurtidoGuardLine = null;
  function getSelectedLine() { return window.__saSurtidoGuardLine || null; }
  function setSelectedLine(v) { window.__saSurtidoGuardLine = v || null; }

  const FilterCore = () => window.SurtidoGuardFilterCore;
  const CARD_LINK_SEL = '[data-steelhead-component-id="WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK"]';

  let stationLineIndex = {};   // stationId → 'T204' (de AllStations)
  let lineCounts = null;       // { byLine, lines, scheduledOrders, unknownStationIds }
  let lastScheduleData = null; // último GetRelatedScheduleData.data (para recontar líneas)
  let seenLines = [];          // líneas vistas en ESTE board (ACUMULATIVO — ver accumulateSeenLines)
  let boardLines = [];         // líneas del board según la API (COMPLETO, no depende de lo montado)
  // 'idle' (aún no se pidió) | 'loading' | 'ready' | 'error'. Alimenta el indicador animado:
  // mientras no sea 'ready', el dropdown está INCOMPLETO y hay que decirlo.
  let boardCatalogState = 'idle';

  function isWorkboardPage() { return WB_PATH_RE.test(location.pathname); }
  function isEnabled() { return isEnforcementEnabled(); }
  function ctx() { return { scheduledAccountIds, accountScheduled, accountNode, surtidoNodeIds }; }
  // Cuentas que SABEMOS programadas (cualquiera de las dos fuentes). Alimenta el árbitro del
  // marcado naranja: con el conteo viejo (sólo el Set legado, que sale vacío) ese árbitro nunca
  // se activaba.
  function scheduledKnownCount() {
    let n = scheduledAccountIds.size;
    accountScheduled.forEach((v, k) => { if (v === true && !scheduledAccountIds.has(k)) n++; });
    return n;
  }

  // Entrada desde el popup (background llama window.SurtidoGuard.toggleFromPopup).
  function toggleFromPopup() {
    setEnforcementEnabled(!isEnforcementEnabled());
    const on = isEnforcementEnabled();
    toast(on
      ? '🔒 Candado de Surtido: ACTIVADO'
      : '🔓 Candado de Surtido: DESACTIVADO (hasta recargar)');
    scheduleDecorate();
    return { enabled: on };
  }

  // ── Estilos (toast + acento naranja + mensaje de modal) ──
  function injectStyles() {
    if (document.getElementById('sa-sg-style')) return;
    const css = [
      '.sa-sg-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);',
      'z-index:2147483600;background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;',
      'border-left:4px solid #13a36f;border-radius:10px;padding:12px 18px;font-size:14px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}',
      '.sa-sg-toast.err{border-left-color:#e8513a;}',
      // Naranja EDGE-TO-EDGE: fondo naranja claro SÓLIDO sobre el cuerpo blanco de la tarjeta
      // NO movible (sin tarea programada). Sólido (no rgba) para que se vea parejo aunque SH
      // tenga un fondo detrás. Señal de advertencia: "esta pieza no se puede mover".
      '.sa-sg-orange{background:#fdd9a8 !important;}',
      '.sa-sg-msg{background:#3a1d1d;color:#f3c2c2;border:1px solid #6b2b2b;border-radius:8px;',
      'padding:10px 12px;margin:10px 0;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      // Ámbar = "no pude verificar", distinto del rojo = "está bloqueado". No se deja pasar en
      // silencio: el operador tiene que saber que aquí el candado NO lo está cuidando.
      '.sa-sg-msg.warn{background:#3a2f14;color:#f3dfae;border-color:#6b551f;}',
      // Box del filtro por línea destino (capa 6). DARK MODE deliberado: debe distinguirse a
      // simple vista del filtro NATIVO de estación de SH, que responde OTRA pregunta (dónde
      // está PARADA la pieza, no a dónde va). Confundirlos surte material a la línea equivocada.
      '.sa-sg-filter{display:flex;align-items:center;gap:8px;background:#1c2430;color:#e6e9ee;',
      'border:1px solid #2b3645;border-radius:10px;padding:8px 12px;margin:0 10px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;}',
      '.sa-sg-filter label{font-weight:600;white-space:nowrap;}',
      '.sa-sg-filter select{background:#141a23;color:#e6e9ee;border:1px solid #2b3645;',
      'border-radius:6px;padding:5px 8px;font-size:13px;font-family:inherit;}',
      '.sa-sg-filter .sa-sg-count{color:#9aa7b8;white-space:nowrap;}',
      '.sa-sg-filter .sa-sg-count.sa-sg-warn{color:#f0b429;}',
      '.sa-sg-filter button{background:transparent;color:#9aa7b8;border:1px solid #2b3645;',
      'border-radius:6px;padding:4px 8px;cursor:pointer;font-family:inherit;font-size:12px;}',
      '.sa-sg-filter button:hover{color:#e6e9ee;border-color:#13a36f;}',
      // Indicador de "el catálogo aún no está completo". El catálogo bueno viene de la API y
      // tarda (2 llamadas + ~4.6MB); mientras tanto el dropdown solo puede ofrecer las líneas
      // de las tarjetas montadas. Sin este aviso el operador ve 3 líneas, las toma por todas y
      // se confunde cuando después aparecen más — que es justo lo que pasó en piso.
      // La animación es CSS pura: el DOM no muta mientras gira, así que NO re-dispara el
      // MutationObserver (que corre con subtree:true).
      '.sa-sg-filter .sa-sg-load{display:inline-flex;align-items:center;gap:6px;color:#9aa7b8;',
      'white-space:nowrap;}',
      '.sa-sg-filter .sa-sg-ring{display:inline-block;width:12px;height:12px;border:2px solid #2b3645;',
      'border-top-color:#13a36f;border-radius:50%;animation:sa-sg-rot .8s linear infinite;}',
      '@keyframes sa-sg-rot{to{transform:rotate(360deg);}}',
      // Respeta a quien pidió menos movimiento en el sistema.
      '@media (prefers-reduced-motion: reduce){.sa-sg-filter .sa-sg-ring{animation-duration:2.4s;}}'
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-sg-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    injectStyles();
    let el = document.getElementById('sa-sg-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-sg-toast'; document.body.appendChild(el); }
    el.className = 'sa-sg-toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { const e = document.getElementById('sa-sg-toast'); if (e) e.remove(); }, 5000);
  }

  // ── Interceptor de fetch (lee board, construye puente, bloquea la mutación) ──
  function patchFetch() {
    if (window.__saSurtidoGuardFetchPatched) return;
    window.__saSurtidoGuardFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      let op = null, vars = null;
      if (typeof url === 'string' && url.includes('/graphql') && opts && typeof opts.body === 'string') {
        try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
      }

      // (a) Puente account→nodo desde las VARIABLES de los queries de move (modal/drag).
      if (op && Core().MOVE_DATA_OPS.indexOf(op) !== -1 && vars) {
        Core().indexAccountNodeFromMoveVars(op, vars, accountNode);
        if (op === 'WorkOrderMovePartsData') { lastModalCtx = vars; scheduleModalGuard(); }
      }

      // (b) Enforcement: bloquear la mutación de mover ANTES de mandarla al servidor.
      if (op === Core().MOVE_MUTATION_OP && vars) {
        const decision = Core().evaluateMove(vars, ctx(), { enforcementEnabled: isEnforcementEnabled() });
        if (decision.block) {
          const wos = decision.blocked.map((b) => '#' + b.workOrderId).join(', ');
          toast('🔒 Bloqueado: la WO ' + wos + ' no está programada. No se puede mover al siguiente proceso.', true);
          console.warn('[SA] SurtidoGuard: BLOQUEADO move de', decision.blocked);
          return new Response(
            JSON.stringify({ errors: [{ message: 'Bloqueado por extensión: la orden no está programada en producción.' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      const resp = await origFetch.apply(this, args);

      // (c) Lectura de las RESPUESTAS del board → sets de programados y de nodos de surtido.
      if (op === Core().BOARD_SCHEDULE_OP) {
        try { resp.clone().json().then((j) => {
          if (j && j.data) { scheduledAccountIds = Core().buildScheduledAccountSet(j.data);
            console.log('[SA] SurtidoGuard: programadas =', scheduledAccountIds.size, 'accounts');
            // El MISMO response trae el stationId de cada tarea → alimenta el filtro por
            // línea destino sin una consulta extra (capa 6).
            lastScheduleData = j.data;
            try { recomputeLineCounts(); } catch (_) {}
            scheduleDecorate(); scheduleModalGuard(); }
        }).catch(() => {}); } catch (_) {}
      }
      // (c-bis) FUENTE BUENA de "programada", por cuenta. Es la query que el board ya dispara
      // para pintar las tarjetas, así que no cuesta ninguna consulta extra. Llega por lotes →
      // el mapa ACUMULA (el último dato de cada cuenta gana).
      if (Core().isPartsInProcessOp(op)) {
        try { resp.clone().json().then((j) => {
          if (j && j.data) {
            Core().buildAccountScheduleMap(j.data, accountScheduled);
            console.log('[SA] SurtidoGuard: cuentas con estado de programación =', accountScheduled.size,
                        '| programadas =', scheduledKnownCount());
            scheduleDecorate(); scheduleModalGuard();
          }
        }).catch(() => {}); } catch (_) {}
      }
      // Catálogo de estaciones → índice stationId→línea. Si el front ya lo pide, sale gratis.
      if (op === 'AllStations') {
        try { resp.clone().json().then((j) => {
          const core = FilterCore();
          if (!core || !j) return;
          stationLineIndex = core.buildStationLineIndex(j);
          recomputeLineCounts();
          scheduleDecorate();
        }).catch(() => {}); } catch (_) {}
      }
      if (op === Core().BOARD_RECIPENODES_OP) {
        try { resp.clone().json().then((j) => {
          if (j && j.data) { surtidoNodeIds = Core().buildSurtidoNodeSet(j.data);
            console.log('[SA] SurtidoGuard: nodos de surtido =', [...surtidoNodeIds]); }
        }).catch(() => {}); } catch (_) {}
      }

      return resp;
    };
  }

  // ── Capa de modal: agrisa "Mover" / "Imprimir y Mover" si la pieza no está programada ──
  function findMoveDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], .MuiDialog-paper');
    for (const d of dialogs) {
      const t = d.textContent || '';
      if ((/Desde Nodo:/i.test(t) || /From Node:/i.test(t)) && (/Mover Piezas/i.test(t) || /Move Parts/i.test(t))) return d;
    }
    return null;
  }

  // Veredicto del modal: 'block' | 'unverified' | null.
  // Mismo criterio que el interceptor (una sola fuente de verdad): sólo se bloquea con evidencia
  // POSITIVA de que la cuenta no está programada. 'unverified' es el caso en que el candado se
  // queda sin datos: no frena —eso pararía el piso— pero lo DICE, porque un candado que se apaga
  // callado es peor que uno que no existe (lección price-confirm-guard 0.1.5).
  function modalVerdict() {
    if (!isEnforcementEnabled() || !lastModalCtx) return null;
    if (!surtidoNodeIds.has(lastModalCtx.fromRecipeNodeId)) return null;
    const accs = lastModalCtx.partsTransferAccountIds || [];
    const c = ctx();
    let algunoSinDato = false;
    for (const a of accs) {
      const st = Core().resolveAccountSchedule(a, c);
      if (!st.found) { algunoSinDato = true; continue; }
      if (!st.programada) return 'block';
    }
    return algunoSinDato ? 'unverified' : null;
  }
  function modalShouldBlock() { return modalVerdict() === 'block'; }

  function setBtnBlocked(btn, blocked) {
    if (blocked) {
      btn.setAttribute('disabled', 'true');
      btn.style.opacity = '0.45';
      btn.style.filter = 'grayscale(1)';
      btn.style.pointerEvents = 'none';
      btn.dataset.saBlocked = '1';
    } else if (btn.dataset.saBlocked) {
      btn.removeAttribute('disabled');
      btn.style.opacity = '';
      btn.style.filter = '';
      btn.style.pointerEvents = '';
      delete btn.dataset.saBlocked;
    }
  }

  function applyModalGuard() {
    const dialog = findMoveDialog();
    if (!dialog) return;
    const verdict = modalVerdict();
    const blocked = verdict === 'block';
    dialog.querySelectorAll('button').forEach((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t.indexOf('mover') === 0 || t.indexOf('imprimir y mover') === 0 ||
          t.indexOf('move') === 0 || t.indexOf('print and') === 0) {
        setBtnBlocked(b, blocked);
      }
    });
    const texto = blocked
      ? '🔒 No se puede mover: la orden no está programada en producción.'
      : (verdict === 'unverified'
          ? '⚠️ El candado no pudo verificar la programación de esta orden — no se bloquea, verifica a mano.'
          : null);
    let msg = dialog.querySelector('#sa-sg-modal-msg');
    if (texto) {
      if (!msg) {
        msg = document.createElement('div');
        msg.id = 'sa-sg-modal-msg';
        const body = dialog.querySelector('.MuiDialogContent-root') || dialog;
        body.insertBefore(msg, body.firstChild);
      }
      // Idempotente: el observer corre con subtree:true, así que sólo se escribe lo que cambió.
      const cls = 'sa-sg-msg' + (blocked ? '' : ' warn');
      if (msg.className !== cls) msg.className = cls;
      if (msg.textContent !== texto) msg.textContent = texto;
    } else if (msg) {
      msg.remove();
    }
  }

  // ── Marcado naranja (heurístico): tarjeta SIN "Tareas Programadas:"/"Scheduled tasks:" → NO
  //    movible → acento naranja. Las movibles (programadas) quedan blancas (sin marca).
  // NOTA: se refina con el HTML real de la tarjeta (selector de contenedor) en validación en vivo.
  function decorateCards() {
    if (!isWorkboardPage()) return;
    const core = Core();
    // ── Anclaje idioma-indep: cada tarjeta del Workboard expone el link de OV con
    //    data-steelhead-component-id estable. Subimos a la RAÍZ de la tarjeta y tintamos su
    //    CUERPO BLANCO (span completo) → el naranja queda EDGE-TO-EDGE y parejo (sa-sg-orange usa
    //    fondo naranja SÓLIDO, no una barra ni semitransparente que se encimaba con el borde nativo).
    // Scan de TODO el documento: el Workboard tiene VARIAS secciones de step (cada una su
    // propia lista virtualizada), así que no se puede acotar a una sola. Es un atributo
    // específico sobre un DOM virtualizado (pocas tarjetas montadas) + rAF → barato.
    const soLinks = document.querySelectorAll(
      '[data-steelhead-component-id="WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK"]'
    );
    // Pase 1: resuelve (body, isScheduled) por tarjeta usando la señal DOM bilingüe.
    const cards = [];
    soLinks.forEach((soLink) => {
      const cardRoot = soLink.closest('[data-item-index], [data-index]');
      const scope = cardRoot || soLink.closest('div[style*="flex: 1 1"]');
      if (!scope) return;
      // Cuerpo blanco de la tarjeta (1er div con fondo blanco = full-width). Fallback al div de
      // contenido si SH cambia el formato del inline-style.
      const body = (cardRoot && cardRoot.querySelector('div[style*="background: rgb(255, 255, 255)"]'))
                || soLink.closest('div[style*="flex: 1 1"]');
      if (!body) return;
      cards.push({ body, isScheduled: core.hasScheduledCardSignal(scope.textContent || '') });
    });
    if (!cards.length) return;   // sin tarjetas resueltas por component-id → fail-safe: no marcar
    // Pase 2: árbitro anti-falsa-alarma con el set de programadas de la API (GetRelatedScheduleData).
    const anyScheduled = cards.some((c) => c.isScheduled);
    const domSignalBroken = core.isDomSignalBroken(anyScheduled, scheduledKnownCount());
    cards.forEach(({ body, isScheduled }) => {
      body.classList.toggle('sa-sg-orange', core.shouldMarkNotMovable(isScheduled, domSignalBroken));
      body.classList.remove('sa-sg-green');   // limpia el verde legado si una versión previa lo dejó
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Capa 6 — Filtro por LÍNEA DESTINO
  // ══════════════════════════════════════════════════════════════════════════
  // Tarjetas MONTADAS con su set de líneas destino. El nodo que se esconde es el item de
  // react-virtuoso ([data-item-index]): ocultarlo hace que virtuoso re-mida y encoja el scroll
  // sin dejar huecos (medido 2026-07-29: scrollHeight 1034→524, rects contiguos).
  // La línea sale de la celda td[1] ("at T300-CE03-002 …") de la tabla que sigue a
  // "Tareas Programadas:", NUNCA del textContent (que trae "Proceso: T400 …", otro código).
  function readMountedCards() {
    const core = FilterCore();
    if (!core) return [];
    const out = [];
    document.querySelectorAll(CARD_LINK_SEL).forEach((link) => {
      const item = link.closest('[data-item-index]');
      if (!item) return;
      const table = item.querySelector('table.MuiTable-root');
      const rows = table
        ? [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
        : [];
      out.push({ item: item, lines: core.linesFromScheduledRows(rows) });
    });
    return out;
  }

  function currentPlan(cards) {
    const core = FilterCore();
    if (!core) return null;
    return core.planFilter({
      cards: cards,
      selectedLine: getSelectedLine(),
      apiScheduledOrders: lineCounts ? lineCounts.scheduledOrders : 0,
      mountedCount: document.querySelectorAll('[data-item-index]').length
    });
  }

  // Aplica el plan al DOM. IDEMPOTENTE: el observer corre con subtree:true, así que una
  // escritura que no verifique su estado previo se re-dispararía en bucle.
  // NO desmonta nodos (display:none) → decorateCards sigue viendo TODAS las tarjetas y su
  // árbitro del naranja (anyScheduled) no se altera.
  function applyFilter() {
    const core = FilterCore();
    if (!core) return null;
    const cards = readMountedCards();
    const plan = currentPlan(cards);
    if (!plan) return null;
    const sel = getSelectedLine();
    cards.forEach(({ item, lines }) => {
      const show = !plan.active || core.cardVisibleUnderFilter(lines, sel);
      // Solo se toca lo que ESTE applet marcó, para no pelear con un display/opacity de SH.
      const marked = item.dataset.saSgFiltered === '1';
      if (!show && plan.effect === 'hide') {
        if (!marked || item.style.display !== 'none') {
          item.dataset.saSgFiltered = '1';
          item.style.display = 'none';
          item.style.opacity = '';
          item.style.filter = '';
        }
      } else if (!show && plan.effect === 'dim') {
        if (!marked || item.style.opacity !== '0.25') {
          item.dataset.saSgFiltered = '1';
          item.style.display = '';
          item.style.opacity = '0.25';
          item.style.filter = 'grayscale(1)';
        }
      } else if (marked) {
        delete item.dataset.saSgFiltered;
        item.style.display = '';
        item.style.opacity = '';
        item.style.filter = '';
      }
    });
    return plan;
  }

  // Recalcula los conteos por línea cuando cambia cualquiera de sus dos insumos.
  function recomputeLineCounts() {
    const core = FilterCore();
    if (!core || !lastScheduleData) return;
    lineCounts = core.buildLineCounts(lastScheduleData, stationLineIndex);
    if (lineCounts.unknownStationIds.length) {
      console.warn('[SA] SurtidoGuard: estaciones sin código de línea', lineCounts.unknownStationIds);
    }
  }

  // Catálogo COMPLETO de líneas del board, desde la API. UNA vez por carga.
  //
  // Por qué no basta con el DOM (bug reportado 2026-07-30): el board virtualiza — de 142 órdenes
  // monta ~8 — así que el dropdown arrancaba con 3 líneas y CRECÍA conforme el operador filtraba,
  // porque esconder tarjetas hace que virtuoso monte otras. El catálogo se descubría por accidente.
  //
  // `WorkOrderSchedule` devuelve el schedule COMPLETO del dominio (no solo el de la WO que se le
  // pasa), con el nombre de la estación en cada tarea. Cuesta 2 llamadas —hay que resolver el
  // workOrderId GLOBAL primero— y su respuesta pesa ~4.6MB, así que se **destila de inmediato** a
  // una lista de códigos y el crudo se descarta sin guardarse en ningún lado.
  function ensureBoardLineCatalog() {
    if (window.__saSurtidoGuardBoardAsked) return;
    const link = document.querySelector(CARD_LINK_SEL);
    if (!link) return;                       // aún no hay tarjetas montadas: se reintenta luego
    const item = link.closest('[data-item-index]');
    const woHref = item && item.querySelector('a[href*="/WorkOrders/"]');
    const m = woHref && (woHref.getAttribute('href') || '').match(/\/WorkOrders\/(\d+)/);
    const domainMatch = location.pathname.match(/\/Domains\/(\d+)/);
    if (!m || !domainMatch) return;
    window.__saSurtidoGuardBoardAsked = true;   // se latchea SOLO cuando de verdad se va a pedir
    boardCatalogState = 'loading';
    const woIdInDomain = parseInt(m[1], 10);
    const domainId = parseInt(domainMatch[1], 10);
    const api = window.SteelheadAPI;
    if (!api || typeof api.query !== 'function') { boardCatalogState = 'error'; return; }
    api.query('WorkOrder', { idInDomain: woIdInDomain }, 'WorkOrder').then((data) => {
      const wo = data && data.workOrderByIdInDomain;
      if (!wo || wo.id == null) return null;
      return api.query('WorkOrderSchedule', { domainId: domainId, workOrderId: wo.id }, 'WorkOrderSchedule');
    }).then((raw) => {
      const core = FilterCore();
      if (!core || !raw) return;
      boardLines = core.linesFromBoardSchedule(raw);   // destila…
      raw = null;                                      // …y suelta los ~4.6MB
      boardCatalogState = 'ready';
      console.log('[SA] SurtidoGuard: líneas del board (API) =', boardLines.join(', ') || '(ninguna)');
      scheduleDecorate();
    }).catch(() => {
      // Falla o hash rotado: el filtro SIGUE sirviendo con las líneas del DOM, pero se dice que
      // el catálogo puede estar incompleto en vez de fingir que ya está todo.
      boardCatalogState = 'error';
      scheduleDecorate();
    });
  }

  // Si el front NO pidió AllStations, lo pedimos UNA vez (catálogo, ~775 estaciones).
  // Una sola llamada por carga de board: el /graphql de la sesión se cuelga con ráfagas.
  function ensureStationCatalog() {
    if (window.__saSurtidoGuardStationsAsked) return;
    window.__saSurtidoGuardStationsAsked = true;
    const api = window.SteelheadAPI;
    if (!api || typeof api.query !== 'function') return;
    // query() devuelve result.data ya desenvuelto (steelhead-api.js:77).
    api.query('AllStations', {}).then((data) => {
      const core = FilterCore();
      if (!core || !data) return;
      stationLineIndex = core.buildStationLineIndex(data);
      recomputeLineCounts();
      scheduleDecorate();
    }).catch(() => {});
  }

  // Barra de acciones del header del board. Sin data-steelhead-component-id en esa zona, el
  // mejor anclaje es subir desde uno de sus botones (texto ES+EN) hasta el contenedor flex.
  // Ese contenedor tiene overflow:visible (medido) → no hace falta position:fixed.
  const HEADER_BTN_RE = /NUEVA TARJETA|NEW CARD|ESCANEAR ETIQUETA|SCAN JOB TAG/i;
  function findHeaderBar() {
    const btns = [...document.querySelectorAll('button')];
    for (const b of btns) {
      if (!HEADER_BTN_RE.test(b.textContent || '')) continue;
      let n = b.parentElement;
      for (let i = 0; i < 4 && n; i++) {
        if (getComputedStyle(n).display === 'flex' && n.children.length >= 3) return n;
        n = n.parentElement;
      }
    }
    return null;
  }

  function onFilterChanged() {
    try { applyFilter(); renderFilterBox(); } catch (_) {}
  }

  // Pinta/actualiza el box. IDEMPOTENTE: reusa el nodo si ya existe y solo reescribe lo que
  // cambió (recrearlo re-dispararía el observer con subtree:true en bucle).
  function renderFilterBox() {
    if (!isWorkboardPage()) return;
    const core = FilterCore();
    if (!core) return;
    const bar = findHeaderBar();
    if (!bar) return;

    let box = document.getElementById('sa-sg-filter');
    if (!box) {
      injectStyles();
      box = document.createElement('div');
      box.id = 'sa-sg-filter';
      box.className = 'sa-sg-filter';
      const label = document.createElement('label');
      label.textContent = '🔒 → Línea destino:';   // la flecha lo distingue del filtro NATIVO
      const sel = document.createElement('select');
      sel.id = 'sa-sg-filter-sel';
      sel.addEventListener('change', () => { setSelectedLine(sel.value || null); onFilterChanged(); });
      const count = document.createElement('span');
      count.id = 'sa-sg-filter-count';
      count.className = 'sa-sg-count';
      // Indicador de catálogo incompleto: anillo animado + texto. Se crea una vez y solo se
      // muestra/oculta, para no recrear nodos en cada sync (el observer corre con subtree:true).
      const load = document.createElement('span');
      load.id = 'sa-sg-filter-load';
      load.className = 'sa-sg-load';
      const ring = document.createElement('span');
      ring.className = 'sa-sg-ring';
      const loadTxt = document.createElement('span');
      loadTxt.id = 'sa-sg-filter-loadtxt';
      load.append(ring, loadTxt);
      const clear = document.createElement('button');
      clear.id = 'sa-sg-filter-clear';
      clear.textContent = '✕';
      clear.title = 'Quitar el filtro de línea destino';
      clear.addEventListener('click', () => {
        setSelectedLine(null);
        const s = document.getElementById('sa-sg-filter-sel');
        if (s) s.value = '';
        onFilterChanged();
      });
      box.append(label, sel, load, count, clear);
      bar.appendChild(box);
    } else if (box.parentElement !== bar) {
      bar.appendChild(box);            // React repintó el header → recolocar, no recrear
    }

    // Opciones: "Todas" + una por línea del board.
    // El catálogo UNE la API (completa, con conteo de órdenes) con las líneas que las tarjetas
    // montadas revelan. Sin esa unión, un board donde GetRelatedScheduleData no llega deja el
    // dropdown SOLO con "Todas" aunque haya tarjetas con destino visible — medido en vivo
    // 2026-07-30 y era un filtro inutilizable. Las que solo vio el DOM van SIN número: dar el
    // conteo de lo montado como si fuera el total sería mentir justo en el dato que se usa
    // para decidir.
    // seenLines es ACUMULATIVO y esa es la parte que importa: al esconder tarjetas, virtuoso
    // desmonta las de otras líneas, así que un catálogo hecho con lo montado AHORA se reduciría
    // a la línea ya elegida y no habría forma de saltar a otra sin quitar el filtro (bug
    // reportado en vivo 2026-07-30). Se limpia en el teardown, no antes.
    const cards = readMountedCards();
    seenLines = FilterCore().accumulateSeenLines(seenLines, cards);
    // boardLines (API, completo) PRIMERO; seenLines solo agrega lo que la API no haya visto.
    const catalog = FilterCore().mergeLineCatalog(lineCounts, boardLines.concat(seenLines));
    const lines = catalog.lines;
    const sel = box.querySelector('#sa-sg-filter-sel');
    const wanted = ['', ...lines.map((c) => c + ':' + (catalog.byLine[c] != null ? catalog.byLine[c] : ''))].join('|');
    if (sel.dataset.saOpts !== wanted) {
      sel.dataset.saOpts = wanted;
      sel.textContent = '';
      const all = document.createElement('option');
      all.value = '';
      all.textContent = 'Todas';
      sel.appendChild(all);
      lines.forEach((code) => {
        const o = document.createElement('option');
        o.value = code;
        const n = catalog.byLine[code];
        o.textContent = (n != null) ? (code + ' (' + n + ')') : code;
        sel.appendChild(o);
      });
    }
    const cur = getSelectedLine() || '';
    if (sel.value !== cur) sel.value = cur;

    // Contador SIEMPRE a la vista con filtro activo, con el desglose de por qué falta gente.
    // Sin esto un board recortado se lee como "no hay trabajo" (lección batch-name-filter).
    const plan = currentPlan(cards);
    const count = box.querySelector('#sa-sg-filter-count');
    let txt = '', warn = false;
    if (!plan) {
      txt = '';
    } else if (!plan.active && plan.reason === 'dom-signal-broken') {
      txt = '⚠️ no pude leer la línea de las tarjetas — filtro apagado';
      warn = true;
    } else if (!plan.active) {
      txt = lines.length
        ? (lines.length + (lines.length === 1 ? ' línea' : ' líneas') + ' en el board')
        : 'sin órdenes programadas';
    } else {
      const partes = [plan.visible + (plan.visible === 1 ? ' visible' : ' visibles')];
      if (plan.hiddenUnscheduled) partes.push(plan.hiddenUnscheduled + ' sin programar ocultas');
      if (plan.hiddenOtherLine) partes.push(plan.hiddenOtherLine + ' de otras líneas');
      if (plan.effect === 'dim') { partes.push('(atenuadas: demasiadas tarjetas)'); warn = true; }
      txt = partes.join(' · ');
    }
    if (count.textContent !== txt) count.textContent = txt;
    const cls = 'sa-sg-count' + (warn ? ' sa-sg-warn' : '');
    if (count.className !== cls) count.className = cls;

    // Indicador: mientras el catálogo de la API no esté 'ready', el dropdown está INCOMPLETO.
    // El operador reportó justo esto: abría rápido, veía 3 líneas, las tomaba por todas, y
    // segundos después aparecían las demás. Ahora se dice mientras pasa.
    const load = box.querySelector('#sa-sg-filter-load');
    const loadTxt = box.querySelector('#sa-sg-filter-loadtxt');
    if (load && loadTxt) {
      const st = boardCatalogState;
      const mostrar = (st === 'idle' || st === 'loading' || st === 'error');
      const t2 = (st === 'error') ? 'catálogo incompleto (solo lo visible)' : 'buscando líneas…';
      if (loadTxt.textContent !== t2) loadTxt.textContent = t2;
      const disp = mostrar ? 'inline-flex' : 'none';
      if (load.style.display !== disp) load.style.display = disp;
      // En 'error' el anillo deja de girar: no está cargando, terminó mal.
      const ringEl = load.querySelector('.sa-sg-ring');
      if (ringEl) {
        const anim = (st === 'error') ? 'none' : '';
        if (ringEl.style.animation !== anim) ringEl.style.animation = anim;
        const bc = (st === 'error') ? '#f0b429' : '';
        if (ringEl.style.borderTopColor !== bc) ringEl.style.borderTopColor = bc;
      }
    }
  }

  // ── Scheduling de trabajo del DOM (debounced, idle) ──
  let decoTimer = null, guardTimer = null;
  // Coalesce por FRAME (rAF) en vez de 200ms: al desplazar, la tarjeta nace blanca y se pinta
  // en el siguiente frame (~16ms) en vez de 200ms después → casi imperceptible. decorateCards
  // es idempotente y solo toca el fondo (no dispara este observer, que es childList).
  function scheduleDecorate() {
    if (decoTimer) return;
    const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    decoTimer = raf(() => {
      decoTimer = null;
      try { decorateCards(); } catch (_) {}
      // El filtro va en su PROPIO try/catch: es comodidad, no puede tumbar el naranja ni el
      // candado si algo del DOM cambia bajo sus pies.
      try { ensureBoardLineCatalog(); } catch (_) {}
      try { applyFilter(); renderFilterBox(); } catch (_) {}
    });
  }
  function scheduleModalGuard() {
    if (guardTimer) return;
    guardTimer = setTimeout(() => { guardTimer = null; try { applyModalGuard(); } catch (_) {} }, 80);
  }

  // Selectores del contenedor de diálogo (el modal "Mover Piezas" se portalea a body).
  const DLG_ADD_SEL = '.MuiDialog-root, .MuiModal-root, [role="dialog"], [role="presentation"]';
  let _dlgOpen = false;

  function observeDom() {
    if (window.__saSurtidoGuardObs) return;
    const obs = new MutationObserver((muts) => {
      // Modal: chequeo SHALLOW (n.matches) de nodos AÑADIDOS/QUITADOS — NO recorremos el
      // subárbol de cada tarjeta en el scroll (eso era el costo: querySelector por tarjeta).
      let addedDlg = false, removedDlg = false;
      for (const m of muts) {
        for (const n of m.addedNodes)   if (n.nodeType === 1 && n.matches && n.matches(DLG_ADD_SEL)) { addedDlg = true; break; }
        for (const n of m.removedNodes) if (n.nodeType === 1 && n.matches && n.matches(DLG_ADD_SEL)) { removedDlg = true; break; }
        if (addedDlg && removedDlg) break;
      }
      if (addedDlg) _dlgOpen = true;
      // El candado del modal SOLO corre mientras hay un modal abierto (donde el board detrás no
      // scrollea) → 0 querySelectorAll de documento durante el scroll normal de tarjetas.
      if (_dlgOpen) scheduleModalGuard();
      if (removedDlg && !document.querySelector('[role="dialog"], .MuiDialog-paper')) _dlgOpen = false;
      scheduleDecorate();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saSurtidoGuardObs = obs;
  }

  // Pinta el naranja de INMEDIATO + reintentos escalonados. Sin esto, el primer decorate solo
  // ocurría cuando el MutationObserver detectaba un cambio; en un Workboard virtualizado (que
  // monta las tarjetas progresivamente) eso tardaba mucho en aparecer. decorateCards es
  // idempotente (toggle), así que reintentar es seguro.
  function kickDecorate() {
    [0, 150, 400, 900, 1800, 3000].forEach((ms) => setTimeout(() => { try { decorateCards(); } catch (_) {} }, ms));
  }

  // ── Memory hardening: teardown al salir del board ──
  function installUrlChangeListener() {
    if (!window.__saSurtidoGuardUrlListener) {
      window.__saSurtidoGuardUrlListener = true;
      const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
      ['pushState', 'replaceState'].forEach((m) => {
        const orig = history[m];
        history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
      });
      window.addEventListener('popstate', fire);
    }
    window.addEventListener('sa-urlchange', () => {
      if (isWorkboardPage()) { injectStyles(); observeDom(); kickDecorate(); }
      else { teardownOnLeave(); }
    });
  }

  function teardownOnLeave() {
    if (window.__saSurtidoGuardObs) { window.__saSurtidoGuardObs.disconnect(); window.__saSurtidoGuardObs = null; }
    scheduledAccountIds = new Set();
    accountScheduled = new Map();
    surtidoNodeIds = new Set();
    accountNode = {};
    lastModalCtx = null;
    // Capa 6: suelta el estado del filtro y DESHACE lo que escondió. Salir del board con
    // tarjetas ocultas dejaría el DOM mintiendo si React reusa los nodos.
    setSelectedLine(null);
    stationLineIndex = {};
    lineCounts = null;
    lastScheduleData = null;
    seenLines = [];
    boardLines = [];
    boardCatalogState = 'idle';
    window.__saSurtidoGuardBoardAsked = false;
    document.querySelectorAll('[data-sa-sg-filtered]').forEach((el) => {
      delete el.dataset.saSgFiltered;
      el.style.display = ''; el.style.opacity = ''; el.style.filter = '';
    });
    const box = document.getElementById('sa-sg-filter'); if (box) box.remove();
    const t = document.getElementById('sa-sg-toast'); if (t) t.remove();
  }

  function init() {
    if (window.__saSurtidoGuardInit) return;
    window.__saSurtidoGuardInit = true;
    patchFetch();                  // siempre (latch idempotente); solo actúa sobre ops objetivo
    installUrlChangeListener();
    if (!isWorkboardPage()) return;
    injectStyles();
    observeDom();
    kickDecorate();                // pinta el naranja ya, sin esperar al primer MutationObserver
    try { ensureStationCatalog(); } catch (_) {}   // capa 6: catálogo de líneas del dropdown
    console.log('[SA] SurtidoGuard activo en', location.pathname);
  }

  return {
    init, isEnabled, toggleFromPopup,
    // Capa 6 expuesta para operar/depurar el filtro desde la consola en la validación en vivo.
    setLine: (code) => { setSelectedLine(code); onFilterChanged(); return getSelectedLine(); },
    _getState: () => ({
      enforcementEnabled: isEnforcementEnabled(),
      scheduled: [...scheduledAccountIds],
      // Fuente buena: cuántas cuentas tienen estado conocido y cuántas están programadas.
      // `accountsWithState === 0` es la señal de "el candado NO tiene datos" (no bloquea + avisa).
      accountsWithState: accountScheduled.size,
      scheduledKnown: scheduledKnownCount(),
      hasEvidence: Core().hasScheduleEvidence(ctx()),
      surtido: [...surtidoNodeIds],
      accounts: Object.keys(accountNode).length,
      line: getSelectedLine(),
      lineCounts: lineCounts,
      seenLines: seenLines,
      boardLines: boardLines,
      boardCatalogState: boardCatalogState,
      mountedCards: (() => { try { return readMountedCards().map((c) => c.lines); } catch (_) { return null; } })(),
      plan: (() => { try { return currentPlan(readMountedCards()); } catch (_) { return null; } })()
    })
  };
})();

if (typeof window !== 'undefined') {
  window.SurtidoGuard = SurtidoGuard;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SurtidoGuard.init());
  } else {
    SurtidoGuard.init();
  }
}
