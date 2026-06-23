// auto-router.js — Orquestador del autoruteador.
//
// · Intercepta StationTreatmentByWorkOrder (la query que dispara el modal de
//   ruteo nativo de Steelhead) para capturar GRATIS el contexto de la orden:
//   workOrderId, partNumberId y el árbol completo de recipeNodes. El modal nativo
//   funciona como "selector de orden" — el applet no necesita pedir IDs internos.
// · Muestra un FAB 🔀 cuando hay contexto capturado y abre el panel de preview.
// · Atiende el mensaje 'open-auto-router' del popup.
//
// Depende de: SteelheadAPI, AutoRouterAPI, AutoRouterEngine, AutoRouterPanel,
//             ProcessShared (opcional), SteelheadHostCleanup (panel).

const AutoRouter = (() => {
  'use strict';

  const VERSION = '0.1.0';
  const LOG = '[AR]';
  const api = () => window.SteelheadAPI;
  const log = (m) => api()?.log?.(m) ?? console.log(LOG, m);

  // Último contexto de ruteo capturado del modal nativo.
  // { workOrderId, partNumberId, routeData, capturedAt }
  let captured = null;

  // Selección RASTREADA del Scheduling board (idInDomain de cada orden marcada).
  // La lista del board es virtualizada (solo renderiza filas visibles), así que en
  // vez de leer el DOM al momento, acumulamos la selección conforme el usuario
  // marca/desmarca — así sobrevive el scroll. Se limpia al cambiar de board (path).
  const boardSelection = new Set();
  let lastPath = typeof location !== 'undefined' ? location.pathname : '';

  function getContext() { return captured; }

  function patchFetch() {
    if (window.__saAutoRouterFetchPatched) return;
    window.__saAutoRouterFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      let op = null;
      let vars = null;
      if (isGraphql && opts?.body && typeof opts.body === 'string') {
        try {
          const b = JSON.parse(opts.body);
          op = b.operationName;
          vars = b.variables;
        } catch (_) { /* no-json body */ }
      }

      const resp = await origFetch.apply(this, args);

      if (op === 'StationTreatmentByWorkOrder' && vars) {
        // lee la respuesta sin consumir el stream original. Soporta 1 o N órdenes
        // (multi-selección del board → workOrderIds:[…] + partNumberIds:[…]).
        try {
          resp.clone().json().then((j) => {
            if (!j || !j.data) return;
            const wos = window.AutoRouterAPI.parseAllRouteData(j.data, vars);
            if (!wos.length) return;
            captured = { wos, capturedAt: Date.now() };
            log(`Contexto capturado: ${wos.length} orden(es) — #${wos.map((w) => w.idInDomain).join(', #')}`);
            window.dispatchEvent(new Event('sa-ar-context'));
          }).catch(() => {});
        } catch (_) { /* swallow */ }
      }
      return resp;
    };
  }

  // ── FAB ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-ar-style')) return;
    const css = `
      .sa-ar-fab{position:fixed;bottom:20px;right:20px;z-index:2147483600;
        width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;
        background:#0b6e4f;color:#fff;font-size:24px;box-shadow:0 3px 10px rgba(0,0,0,.3);
        display:flex;align-items:center;justify-content:center;transition:transform .12s;}
      .sa-ar-fab:hover{transform:scale(1.08);background:#0d8a63;}
      .sa-ar-fab .sa-ar-badge{position:absolute;top:-4px;right:-4px;background:#e8513a;
        color:#fff;font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;
        display:flex;align-items:center;justify-content:center;padding:0 4px;}`;
    const s = document.createElement('style');
    s.id = 'sa-ar-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Scheduling board: rutear directo desde la selección, sin abrir el modal ──
  function isBoardPage() {
    return /\/Schedules\/\d+\/ScheduleBoard\/\d+/i.test(location.pathname);
  }

  // idInDomain de la orden de una fila (del link /Domains/N/WorkOrders/<id>).
  function woIdFromRow(tr) {
    const a = tr && tr.querySelector('a[href*="/WorkOrders/"]');
    const m = a && (a.getAttribute('href') || '').match(/\/WorkOrders\/(\d+)/);
    return m ? m[1] : null;
  }

  // Selección completa: la rastreada (boardSelection, sobrevive el scroll) UNIDA con
  // las filas visibles marcadas ahora mismo (por si alguna no quedó rastreada).
  function readBoardSelection() {
    const out = new Set(boardSelection);
    document.querySelectorAll('tr input[type="checkbox"]:checked').forEach((cb) => {
      const id = woIdFromRow(cb.closest('tr'));
      if (id) out.add(id);
    });
    return [...out];
  }

  function fabCount() {
    if (isBoardPage()) return readBoardSelection().length;
    return captured && captured.wos ? captured.wos.length : 0;
  }

  function syncFab() {
    const onBoard = isBoardPage();
    const show = onBoard || (captured && captured.wos && captured.wos.length > 0);
    let fab = document.getElementById('sa-ar-fab');
    if (show && !fab) {
      fab = document.createElement('button');
      fab.id = 'sa-ar-fab';
      fab.className = 'sa-ar-fab';
      fab.onclick = onFab;
      document.body.appendChild(fab);
    } else if (!show && fab) {
      fab.remove();
      return;
    }
    if (fab) {
      const n = fabCount();
      fab.title = onBoard
        ? (n ? `Rutear ${n} orden(es) seleccionada(s)` : 'Selecciona órdenes en el board y presiona 🔀')
        : (n > 1 ? `Auto-rutear ${n} órdenes a otra línea` : 'Auto-rutear esta orden a otra línea');
      fab.textContent = '🔀';
      if (n > 0) {
        const b = document.createElement('span');
        b.className = 'sa-ar-badge';
        b.textContent = String(n);
        fab.appendChild(b);
      }
    }
  }

  function onFab() {
    if (isBoardPage()) {
      const nums = readBoardSelection();
      if (!nums.length) {
        alert('Auto-Ruteador: selecciona órdenes en el board (checkbox de la columna "Selected") y vuelve a presionar 🔀.\n(Solo lee las filas visibles — si seleccionaste muchas, no scrollees fuera de vista.)');
        return;
      }
      if (!window.AutoRouterBatch) { alert('Auto-Ruteador: módulo batch no cargado.'); return; }
      window.AutoRouterBatch.openWithNumbers(nums);
      return;
    }
    openPanel();
  }

  function openPanel() {
    if (!captured || !captured.wos || !captured.wos.length) {
      alert('Auto-Ruteador: abre primero el modal de ruteo de una orden (o selecciona varias en el board y abre el ruteo) para capturarlas, luego presiona 🔀.');
      return;
    }
    if (captured.wos.length > 1) {
      if (!window.AutoRouterBatch) { alert('Auto-Ruteador: módulo batch no cargado.'); return; }
      window.AutoRouterBatch.open(captured.wos.map((w) => ({
        idInDomain: w.idInDomain, workOrderId: w.workOrderId, partNumberId: w.partNumberId,
        partGroupId: null, routeData: w,
      })));
    } else {
      if (!window.AutoRouterPanel) { alert('Auto-Ruteador: panel no cargado.'); return; }
      const w = captured.wos[0];
      window.AutoRouterPanel.open({ workOrderId: w.workOrderId, partNumberId: w.partNumberId, routeData: w });
    }
  }

  function openBatch() {
    if (!window.AutoRouterBatch) { alert('Auto-Ruteador: módulo batch no cargado.'); return; }
    // Modo manual (sin contexto capturado): pegar números de orden.
    window.AutoRouterBatch.open();
  }

  function listenManualTrigger() {
    try {
      chrome.runtime?.onMessage?.addListener?.((msg) => {
        if (!msg) return;
        if (msg.action === 'open-auto-router') openPanel();
        else if (msg.action === 'open-auto-router-batch') openBatch();
      });
    } catch (_) { /* no chrome.runtime en algunos contextos */ }
  }

  function installUrlListener() {
    if (window.__saAutoRouterUrlListener) return;
    window.__saAutoRouterUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-ar-url'));
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  function init() {
    if (window.__saAutoRouterInit) return;
    window.__saAutoRouterInit = true;
    const disabled = document.documentElement.dataset.saAutoRouterEnabled === 'false';
    if (disabled) { log('Deshabilitado'); return; }
    injectStyles();
    patchFetch();
    listenManualTrigger();
    installUrlListener();
    window.addEventListener('sa-ar-context', syncFab);
    window.addEventListener('sa-ar-url', () => {
      if (location.pathname !== lastPath) { lastPath = location.pathname; boardSelection.clear(); } // nuevo board → resetea
      syncFab();
    });
    // Rastreo de selección del board + badge en vivo: al marcar/desmarcar un checkbox,
    // acumula/quita el idInDomain de esa fila (sobrevive la virtualización del scroll).
    document.addEventListener('change', (e) => {
      if (!isBoardPage()) return;
      const t = e.target;
      if (!t || typeof t.matches !== 'function' || !t.matches('input[type="checkbox"]')) return;
      const id = woIdFromRow(t.closest('tr'));
      if (id) { if (t.checked) boardSelection.add(id); else boardSelection.delete(id); }
      syncFab();
    }, true);
    syncFab();
    log(`cargado · v${VERSION}`);
  }

  if (typeof window !== 'undefined') {
    window.AutoRouter = { VERSION, init, openPanel, openBatch, getContext };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return { VERSION, init, openPanel, getContext };
})();
