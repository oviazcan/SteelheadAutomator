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

  // ── Engine (pure functions) ────────────────────────────────

  function consolidateByPN(lines) {
    const out = {};
    for (const line of (lines || [])) {
      const pn = line && line.partNumber;
      if (!pn) continue;
      const qty = Number(line.quantity) || 0;
      out[pn] = (out[pn] || 0) + qty;
    }
    return out;
  }

  function hungarianMatch(costMatrix) {
    const n = costMatrix.length;
    if (n === 0) return { assignment: [], totalCost: 0 };
    if (!costMatrix.every(row => Array.isArray(row) && row.length === n)) {
      throw new Error('hungarianMatch: matriz debe ser cuadrada');
    }
    let best = { assignment: null, totalCost: Infinity };
    const perm = Array.from({ length: n }, (_, i) => i);
    function* permutations(arr, k = 0) {
      if (k === arr.length - 1) { yield arr.slice(); return; }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        yield* permutations(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    }
    for (const p of permutations(perm)) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += costMatrix[i][p[i]];
      if (cost < best.totalCost) best = { assignment: p.slice(), totalCost: cost };
    }
    return best;
  }

  // ── Public API (also for tests) ─────────────────────────────
  return {
    init,
    openWizard,
    // Internals exposed for test harness (Task 1.3+):
    _engine: {
      consolidateByPN,
      hungarianMatch,
    },
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
