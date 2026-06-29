// Candado de Surtido Programado — bloquea mover piezas no programadas en el
// step "Preparando Surtido en Almacén" del Workboard "Preparación de Surtido".
// Glue DOM/red; la lógica de decisión y parseo vive en SurtidoGuardCore.
//
// Capas:
//   1. Mapa "programada" + nodos de surtido + puente account→nodo (lee fetch)   — Task 4
//   2. Enforcement: bloquea CreateManyPartsTransfersChecked (modal y drag)        — Task 5
//   3. Capa de modal: agrisa "Mover" / "Imprimir y Mover"                         — Task 6
//   4. Marcado verde de tarjetas programadas (señal DOM "Tareas Programadas:")    — Task 7
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

  let scheduledAccountIds = new Set();  // partsTransferAccountId programados (GetRelatedScheduleData)
  let surtidoNodeIds = new Set();       // recipeNodeId del nodo de surtido (GetRelatedWorkboardData)
  let accountNode = {};                 // accountId -> {recipeNodeId, workOrderId} (vars de move-data)
  let lastModalCtx = null;              // últimas vars de WorkOrderMovePartsData (para la capa de modal)

  function isWorkboardPage() { return WB_PATH_RE.test(location.pathname); }
  function isEnabled() { return isEnforcementEnabled(); }
  function ctx() { return { scheduledAccountIds, accountNode, surtidoNodeIds }; }

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

  // ── Estilos (toast + acento verde + mensaje de modal) ──
  function injectStyles() {
    if (document.getElementById('sa-sg-style')) return;
    const css = [
      '.sa-sg-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);',
      'z-index:2147483600;background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;',
      'border-left:4px solid #13a36f;border-radius:10px;padding:12px 18px;font-size:14px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}',
      '.sa-sg-toast.err{border-left-color:#e8513a;}',
      '.sa-sg-green{box-shadow:inset 5px 0 0 0 #13a36f !important;}',
      '.sa-sg-msg{background:#3a1d1d;color:#f3c2c2;border:1px solid #6b2b2b;border-radius:8px;',
      'padding:10px 12px;margin:10px 0;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
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
            scheduleDecorate(); scheduleModalGuard(); }
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

  function modalShouldBlock() {
    if (!isEnforcementEnabled() || !lastModalCtx) return false;
    const accs = lastModalCtx.partsTransferAccountIds || [];
    const inSurtido = surtidoNodeIds.has(lastModalCtx.fromRecipeNodeId);
    return inSurtido && accs.some((a) => !scheduledAccountIds.has(a));
  }

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
    const blocked = modalShouldBlock();
    dialog.querySelectorAll('button').forEach((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t.indexOf('mover') === 0 || t.indexOf('imprimir y mover') === 0 ||
          t.indexOf('move') === 0 || t.indexOf('print and') === 0) {
        setBtnBlocked(b, blocked);
      }
    });
    let msg = dialog.querySelector('#sa-sg-modal-msg');
    if (blocked && !msg) {
      msg = document.createElement('div');
      msg.id = 'sa-sg-modal-msg';
      msg.className = 'sa-sg-msg';
      msg.textContent = '🔒 No se puede mover: la orden no está programada en producción.';
      const body = dialog.querySelector('.MuiDialogContent-root') || dialog;
      body.insertBefore(msg, body.firstChild);
    } else if (!blocked && msg) {
      msg.remove();
    }
  }

  // ── Marcado verde (heurístico): tarjeta con "Tareas Programadas:" → acento verde ──
  // NOTA: se refina con el HTML real de la tarjeta (selector de contenedor) en validación en vivo.
  function decorateCards() {
    if (!isWorkboardPage()) return;
    const re = /Tareas Programadas:?/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => re.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    let node;
    while ((node = walker.nextNode())) {
      // Sube hasta el contenedor de tarjeta (ancestro que también tenga "Proceso:" o "WO:").
      let card = node.parentElement;
      for (let i = 0; i < 8 && card; i++) {
        const t = card.textContent || '';
        if (/Proceso:/i.test(t) && /WO:/i.test(t)) break;
        card = card.parentElement;
      }
      if (card) card.classList.add('sa-sg-green');
    }
  }

  // ── Scheduling de trabajo del DOM (debounced, idle) ──
  let decoTimer = null, guardTimer = null;
  function scheduleDecorate() {
    if (decoTimer) return;
    decoTimer = setTimeout(() => { decoTimer = null; try { decorateCards(); } catch (_) {} }, 200);
  }
  function scheduleModalGuard() {
    if (guardTimer) return;
    guardTimer = setTimeout(() => { guardTimer = null; try { applyModalGuard(); } catch (_) {} }, 80);
  }

  function observeDom() {
    if (window.__saSurtidoGuardObs) return;
    const obs = new MutationObserver(() => { scheduleModalGuard(); scheduleDecorate(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saSurtidoGuardObs = obs;
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
      if (isWorkboardPage()) { observeDom(); }
      else { teardownOnLeave(); }
    });
  }

  function teardownOnLeave() {
    if (window.__saSurtidoGuardObs) { window.__saSurtidoGuardObs.disconnect(); window.__saSurtidoGuardObs = null; }
    scheduledAccountIds = new Set();
    surtidoNodeIds = new Set();
    accountNode = {};
    lastModalCtx = null;
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
    console.log('[SA] SurtidoGuard activo en', location.pathname);
  }

  return {
    init, isEnabled, toggleFromPopup,
    _getState: () => ({ enforcementEnabled: isEnforcementEnabled(), scheduled: [...scheduledAccountIds], surtido: [...surtidoNodeIds], accounts: Object.keys(accountNode).length })
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
