// PO Reconciler — Rebalanceo automático entre OVs temp y POs reales (Schneider QRO)
// Depende de: SteelheadAPI, ClaudeAPI, POComparator
// Spec: docs/superpowers/specs/2026-05-12-po-reconciler-design.md

const POReconciler = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api()?.log?.(m) ?? console.log('[PR]', m);
  const warn = (m) => api()?.warn?.(m) ?? console.warn('[PR]', m);

  const URL_RE = /\/Domains\/\d+\/ReceivedOrders(?:\/|$|\?)/i;
  const SAP_PO_RE = /^14\d{8}$/;

  let state = {
    isOpen: false,
    step: 1,
    pdfs: [],           // [{ file, status: 'pending'|'parsing'|'ok'|'error', parsed, error }]
    tempOVs: [],        // [{ id, name, ots, byPN, snapshot }]
    restantesOV: null,  // { id, name, snapshot } or null
    plan: null,         // see engine
    overrides: {},      // user edits
    runId: null,        // for cancel/idempotency
    auditLog: [],
  };

  function init() {
    if (window.__saPoReconcilerInit) return;
    window.__saPoReconcilerInit = true;
    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
    listenManualTrigger();
  }

  function isAllowedPath() {
    return URL_RE.test(location.pathname);
  }

  function syncFabVisibility() {
    // TODO Task 10.1
  }

  function installUrlChangeListener() {
    if (window.__saPoReconcilerUrlListener) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saPoReconcilerUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  function listenManualTrigger() {
    chrome.runtime?.onMessage?.addListener?.((msg) => {
      if (msg && msg.action === 'run-po-reconciler') openWizard();
    });
  }

  function injectStyles() {
    // TODO Task 5.2
  }

  function openWizard() {
    // TODO Task 5.1
  }

  // ── Public API (also for tests) ─────────────────────────────
  return {
    init,
    openWizard,
    // Internals exposed for test harness (Task 1.3+):
    _engine: {},
  };
})();

if (typeof window !== 'undefined') {
  window.POReconciler = POReconciler;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', POReconciler.init);
  } else {
    POReconciler.init();
  }
}

if (typeof module !== 'undefined') module.exports = POReconciler;
