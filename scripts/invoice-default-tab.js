// Invoice Default Tab
// Cuando el usuario entra a /Domains/{N}/Invoices SIN un parámetro `mode=` en la
// URL (típicamente: link directo, reload, o entrada por menú), navega
// automáticamente al tab "Packing Slips". Si después navega manualmente a otro
// tab (Sales Orders, Shipments, etc.), Steelhead añade `?mode=…` y este applet
// respeta esa elección.

const InvoiceDefaultTab = (() => {
  'use strict';

  const INVOICES_PATH_RE = /\/Domains\/\d+\/Invoices\/?$/;
  const TAB_LABEL_RE = /^\s*packing\s*slips\s*$/i;
  let enabled = true;

  function shouldRedirect() {
    if (!INVOICES_PATH_RE.test(location.pathname)) return false;
    const params = new URLSearchParams(location.search);
    if (params.get('mode')) return false;
    return true;
  }

  function findPackingSlipsTab() {
    const candidates = document.querySelectorAll('button, [role="tab"], a');
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (TAB_LABEL_RE.test(txt)) return el;
    }
    return null;
  }

  function clickWhenReady() {
    if (!shouldRedirect()) return;
    const tab = findPackingSlipsTab();
    if (tab) { tab.click(); return; }

    // El DOM se hidrata async — observar y reintentar hasta 5 s.
    const start = Date.now();
    const obs = new MutationObserver(() => {
      if (!shouldRedirect()) { obs.disconnect(); return; }
      if (Date.now() - start > 5000) { obs.disconnect(); return; }
      const t = findPackingSlipsTab();
      if (t) { t.click(); obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 5000);
  }

  function patchHistoryNav() {
    if (window.__saInvoiceDefaultTabHistoryPatched) return;
    window.__saInvoiceDefaultTabHistoryPatched = true;
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function () {
      _push.apply(this, arguments);
      setTimeout(clickWhenReady, 50);
    };
    history.replaceState = function () {
      _replace.apply(this, arguments);
      setTimeout(clickWhenReady, 50);
    };
    window.addEventListener('popstate', () => setTimeout(clickWhenReady, 50));
  }

  function init() {
    enabled = document.documentElement.dataset.saInvoiceDefaultTabEnabled !== 'false';
    if (!enabled) { console.log('[InvoiceDefaultTab] Deshabilitado'); return; }
    if (window.__saInvoiceDefaultTabInitDone) {
      console.log('[InvoiceDefaultTab] Ya inicializado — skip');
      return;
    }
    window.__saInvoiceDefaultTabInitDone = true;
    patchHistoryNav();
    clickWhenReady();
    console.log('[InvoiceDefaultTab] Inicializado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.InvoiceDefaultTab = InvoiceDefaultTab;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => InvoiceDefaultTab.init());
  } else {
    InvoiceDefaultTab.init();
  }
}
