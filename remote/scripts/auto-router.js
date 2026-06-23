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
        // lee la respuesta sin consumir el stream original.
        try {
          const woId = (vars.workOrderIds || [])[0];
          const pnId = (vars.partNumberIds || [])[0] ?? null;
          resp.clone().json().then((j) => {
            if (!j || !j.data) return;
            const routeData = window.AutoRouterAPI.parseRouteData(j.data, woId, pnId);
            captured = { workOrderId: woId, partNumberId: pnId, routeData, capturedAt: Date.now() };
            log(`Contexto capturado: WO ${woId} (idInDomain ${routeData.idInDomain}), ${routeData.recipeNodes.length} nodos`);
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

  function syncFab() {
    const has = !!captured;
    let fab = document.getElementById('sa-ar-fab');
    if (has && !fab) {
      fab = document.createElement('button');
      fab.id = 'sa-ar-fab';
      fab.className = 'sa-ar-fab';
      fab.title = 'Auto-rutear esta orden a otra línea';
      fab.innerHTML = '🔀';
      fab.onclick = openPanel;
      document.body.appendChild(fab);
    } else if (!has && fab) {
      fab.remove();
    }
  }

  function openPanel() {
    if (!window.AutoRouterPanel) { alert('Auto-Ruteador: panel no cargado.'); return; }
    if (!captured) {
      alert('Auto-Ruteador: abre primero el modal de ruteo de una orden (Cambiar estación) para capturar la orden, luego presiona 🔀.');
      return;
    }
    window.AutoRouterPanel.open(captured);
  }

  function listenManualTrigger() {
    try {
      chrome.runtime?.onMessage?.addListener?.((msg) => {
        if (msg && msg.action === 'open-auto-router') openPanel();
      });
    } catch (_) { /* no chrome.runtime en algunos contextos */ }
  }

  function init() {
    if (window.__saAutoRouterInit) return;
    window.__saAutoRouterInit = true;
    const disabled = document.documentElement.dataset.saAutoRouterEnabled === 'false';
    if (disabled) { log('Deshabilitado'); return; }
    injectStyles();
    patchFetch();
    listenManualTrigger();
    window.addEventListener('sa-ar-context', syncFab);
    log(`cargado · v${VERSION}`);
  }

  if (typeof window !== 'undefined') {
    window.AutoRouter = { VERSION, init, openPanel, getContext };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return { VERSION, init, openPanel, getContext };
})();
