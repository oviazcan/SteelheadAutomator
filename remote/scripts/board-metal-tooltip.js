// board-metal-tooltip.js — Tooltip de "Metal base" al pasar el mouse por un PN en
// el Scheduling board. El metal base es un customInput de la parte
// (customInputs.DatosAdicionalesNP.BaseMetal) que las queries del board NO traen,
// así que se pide bajo demanda con GetPartNumber {partNumberId, usagesLimit:0}
// (ligero, mismo patrón que auditor.js) y se cachea por parte.
//
// Depende de: SteelheadAPI. Expone window.BoardMetalTooltip.

const BoardMetalTooltip = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cache = new Map(); // partNumberId -> metalBase string | Promise<string>
  let tipEl = null;
  let hoverTimer = null;
  let hideTimer = null;
  let currentPn = null;

  function isBoardPage() {
    return /\/Schedules\/\d+\/ScheduleBoard\/\d+/i.test(location.pathname);
  }

  function injectStyles() {
    if (document.getElementById('sa-bmt-style')) return;
    const s = document.createElement('style');
    s.id = 'sa-bmt-style';
    s.textContent = `
      .sa-bmt-tip{position:fixed;z-index:2147483646;background:#1c2430;color:#fff;
        font:600 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:5px 9px;
        border-radius:6px;box-shadow:0 3px 10px rgba(0,0,0,.35);pointer-events:none;
        white-space:nowrap;opacity:0;transition:opacity .1s;max-width:280px;}
      .sa-bmt-tip.show{opacity:1;}
      .sa-bmt-tip b{color:#8fd3b6;font-weight:700;}`;
    document.head.appendChild(s);
  }

  function tip() {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'sa-bmt-tip'; document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(x, y, html) {
    const t = tip();
    t.innerHTML = html; // contenido controlado (no datos crudos sin escapar — ver setMetal)
    t.style.left = Math.round(x) + 'px';
    t.style.top = Math.round(y + 6) + 'px';
    t.classList.add('show');
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('show'); currentPn = null; }

  // Escape mínimo (el metal base viene de datos de Steelhead).
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function metalFromCustomInputs(ci) {
    let obj = ci;
    if (typeof ci === 'string') { try { obj = JSON.parse(ci); } catch { obj = {}; } }
    return (obj && obj.DatosAdicionalesNP && obj.DatosAdicionalesNP.BaseMetal) || '';
  }

  function getMetal(pnId) {
    if (cache.has(pnId)) return cache.get(pnId);
    const p = api().query('GetPartNumber', { partNumberId: Number(pnId), usagesLimit: 0, usagesOffset: 0 })
      .then((d) => { const m = metalFromCustomInputs(d?.partNumberById?.customInputs); cache.set(pnId, m); return m; })
      .catch(() => { cache.set(pnId, ''); return ''; });
    cache.set(pnId, p);
    return p;
  }

  function pnLinkFrom(target) {
    const a = target && target.closest && target.closest('a[href*="/PartNumbers/"]');
    if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/\/PartNumbers\/(\d+)/);
    return m ? { a, pnId: m[1] } : null;
  }

  function onOver(e) {
    if (!isBoardPage()) return;
    const hit = pnLinkFrom(e.target);
    if (!hit) return;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    currentPn = hit.pnId;
    // pequeño delay para no disparar al pasar de largo.
    hoverTimer = setTimeout(() => {
      const r = hit.a.getBoundingClientRect();
      showTip(r.left, r.bottom, 'Metal base: <b>…</b>');
      const pn = hit.pnId;
      Promise.resolve(getMetal(pn)).then((metal) => {
        if (currentPn !== pn) return; // ya se movió a otra parte
        const r2 = hit.a.getBoundingClientRect();
        showTip(r2.left, r2.bottom, `Metal base: <b>${metal ? esc(metal) : '(sin dato)'}</b>`);
      });
    }, 220);
  }

  function onOut(e) {
    if (pnLinkFrom(e.target)) {
      clearTimeout(hoverTimer);
      hideTimer = setTimeout(hideTip, 120);
    }
  }

  function init() {
    if (window.__saBmtInit) return;
    window.__saBmtInit = true;
    const disabled = document.documentElement.dataset.saAutoRouterEnabled === 'false';
    if (disabled) return;
    injectStyles();
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
  }

  if (typeof window !== 'undefined') {
    window.BoardMetalTooltip = { init };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  return { init };
})();
