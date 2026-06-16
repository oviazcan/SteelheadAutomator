// unit-autoconvert.js — Auto-conversión de unidades al editar un NP.
// Tab en un campo de unidad → calcula los pares del mismo tipo (peso/longitud/superficie).
// Campos presentes → DOM (setter nativo + InputEvent). Sin campo (DMK, pares ausentes) → API.
// Toggle visible default ON (por sesión). Depende de SteelheadAPI + UnitAutoConvertCore.
(function () {
  'use strict';
  const VERSION = '0.1.0';
  const LOG = '[SA unit-autoconvert]';
  const Core = window.UnitAutoConvertCore;
  const api = () => window.SteelheadAPI;

  // Estado en window para sobrevivir re-inyección (autoInject re-corre el IIFE).
  // enabled = por sesión: arranca ON; se resetea a ON solo en recarga dura (window nuevo).
  const S = window.__saUac || (window.__saUac = {
    enabled: true, invItemId: null, pnId: null, unitIdCache: null,
    fetchPatched: false, observer: null, focusoutBound: false, _injTimer: null,
  });

  function killSwitchOff() {
    const cfg = window.REMOTE_CONFIG;
    return !!(cfg && cfg.unitAutoConvertEnabled === false);
  }

  // ── Interceptor de fetch: cachea inventoryItemId del PN abierto ──
  // El modal carga el PN vía GraphQL; capturamos inventoryItemByPartNumberId.id.
  function installInterceptor() {
    const orig = window.fetch;
    if (!orig || orig.__saUacPatched) return;
    const patched = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        const url = (args[0] && args[0].url) || args[0];
        if (typeof url === 'string' && url.includes('/graphql')) {
          res.clone().json().then((json) => {
            try { scanForInventoryItem(json); } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return res;
    };
    patched.__saUacPatched = true;
    window.fetch = patched;
  }

  // Busca recursivamente inventoryItemByPartNumberId.id en una respuesta GraphQL.
  function scanForInventoryItem(node, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 8) return;
    if (node.inventoryItemByPartNumberId && node.inventoryItemByPartNumberId.id != null) {
      S.invItemId = node.inventoryItemByPartNumberId.id;
      if (node.id != null) S.pnId = node.id;
      return; // match encontrado: corta el subárbol (evita last-wins y trabajo de más)
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') scanForInventoryItem(v, (depth || 0) + 1);
    }
  }

  // ── Toggle UI ──
  function buildToggle() {
    const wrap = document.createElement('label');
    wrap.className = 'sa-uac-toggle';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:8px 0;font-size:13px;color:#444;cursor:pointer;user-select:none;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'sa-uac-cb';
    cb.checked = S.enabled;
    cb.style.cssText = 'cursor:pointer;';
    cb.addEventListener('change', () => {
      S.enabled = cb.checked;
      document.querySelectorAll('input.sa-uac-cb').forEach((other) => { other.checked = S.enabled; });
    });
    const txt = document.createElement('span');
    txt.textContent = 'Auto-conversión de unidades';
    wrap.appendChild(cb);
    wrap.appendChild(txt);
    return wrap;
  }

  function injectToggleNear(anchorEl, position) {
    if (!anchorEl) return;
    const host = anchorEl.parentElement || anchorEl;
    // Guard idempotente auto-sanador: si el toggle ya cuelga de host, no re-inyecta;
    // si React lo barrió en un re-render, se vuelve a inyectar (sin flag dataset pegajoso).
    if (host.querySelector(':scope > .sa-uac-toggle')) return;
    const toggle = buildToggle();
    if (position === 'after') anchorEl.insertAdjacentElement('afterend', toggle);
    else host.insertBefore(toggle, host.firstChild);
  }

  function findByText(selector, predicate) {
    const els = document.querySelectorAll(selector);
    for (const el of els) { if (predicate(el.textContent.trim())) return el; }
    return null;
  }

  function tryInjectToggles() {
    if (killSwitchOff()) return;
    const headingA = findByText('p.MuiTypography-root, strong, h6, span', (t) =>
      /per part count unit definitions/i.test(t));
    if (headingA) injectToggleNear(headingA, 'after');
    const modoP = findByText('p.MuiTypography-root', (t) => /^modo:?$/i.test(t));
    if (modoP) injectToggleNear(modoP.parentElement, 'before');
  }

  // placeholder rellenado en Tasks 4–6
  function onFocusOut() {}

  // ── init idempotente ──
  function init() {
    if (killSwitchOff()) { console.log(LOG, 'kill-switch off'); return; }
    if (!Core) { console.warn(LOG, 'UnitAutoConvertCore no cargado'); return; }
    if (!S.fetchPatched) { installInterceptor(); S.fetchPatched = true; }
    if (!S.observer) {
      // debounce: el SPA dispara cientos de mutaciones por navegación (patrón hermano:
      // proceso-calculator / weight-quick-entry usan clearTimeout + setTimeout ~300ms).
      S.observer = new MutationObserver(() => {
        clearTimeout(S._injTimer);
        S._injTimer = setTimeout(tryInjectToggles, 300);
      });
      S.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
    if (!S.focusoutBound) {
      document.addEventListener('focusout', onFocusOut, true);
      S.focusoutBound = true;
    }
    tryInjectToggles();
    console.log(LOG, 'init', VERSION);
  }

  const Applet = { __saVersion: VERSION, init, _state: S };
  window.UnitAutoConvert = Applet;
  init();
})();
