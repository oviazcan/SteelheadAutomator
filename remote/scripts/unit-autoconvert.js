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
    fetchPatched: false, observer: null, focusoutBound: false, _injTimer: null, apiQueue: null,
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

  // Devuelve el elemento MÁS INTERNO cuyo texto cumple el predicado. Con predicados
  // anclados (^...$) evita matchear wrappers grandes (cuyo textContent contiene el
  // título + todos los campos) y aterriza en el <p> real del encabezado.
  function findByText(selector, predicate) {
    const els = document.querySelectorAll(selector);
    let match = null;
    for (const el of els) {
      if (predicate((el.textContent || '').trim())) {
        if (!match || match.contains(el)) match = el; // más profundo gana (hoja real)
      }
    }
    return match;
  }

  function tryInjectToggles() {
    if (killSwitchOff()) return;
    // Panel A: el encabezado es texto EXACTO "Per Part Count Unit Definitions:" (anclado
    // para no agarrar un wrapper). Selector amplio: no dependemos del tag/clase exactos.
    const headingA = findByText('p, span, strong, b, h1, h2, h3, h4, h5, h6, div, label', (t) =>
      /^per part count unit definitions:?\s*$/i.test(t));
    if (headingA) injectToggleNear(headingA, 'after');
    const modoP = findByText('p.MuiTypography-root', (t) => /^(?:modo|mode):?$/i.test(t));
    if (modoP) injectToggleNear(modoP.parentElement, 'before');
  }

  // ── Escritura DOM compatible con React/MUI ──
  function writeInput(input, value) {
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, String(value));
    // InputEvent (no Event) para que React reconcilie el input controlado — convención
    // del repo (proceso-calculator / invoice-autofill / bill-autofill).
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Identificación de contexto del input que disparó focusout ──
  // Devuelve { panel:'A'|'B', code } o null.
  function classifyInput(input) {
    // Panel B: dentro de una fila de tabla con nombre de unidad
    const tr = input.closest('tr.MuiTableRow-root');
    if (tr) {
      const nameP = tr.querySelector('td p.MuiTypography-root');
      if (!nameP) return null;
      // descartar el input recíproco (Parts / X)
      const adorn = (input.closest('td')?.querySelector('.MuiInputAdornment-root')?.textContent) || '';
      if (Core.isReciprocalAdornment(adorn)) return null;
      return { panel: 'B', code: Core.unitCodeFromText(nameP.textContent) };
    }
    // Panel A: label hermano que termina en "/ Part:"
    const fc = input.closest('.MuiFormControl-root');
    if (fc && fc.parentElement) {
      const labelP = fc.parentElement.querySelector(':scope > p.MuiTypography-root');
      if (labelP && /\/\s*parts?:?\s*$/i.test(labelP.textContent.trim())) {
        return { panel: 'A', code: Core.unitCodeFromText(labelP.textContent) };
      }
    }
    return null;
  }

  // Busca el input del par `code` en el panel dado. Null si no tiene campo/fila.
  function findPeerInput(panel, code) {
    if (panel === 'A') {
      const labels = document.querySelectorAll('p.MuiTypography-root');
      for (const p of labels) {
        const t = p.textContent.trim();
        if (/\/\s*parts?:?\s*$/i.test(t) && Core.unitCodeFromText(t) === code) {
          return p.parentElement.querySelector('input');
        }
      }
      return null;
    }
    // Panel B
    const rows = document.querySelectorAll('tr.MuiTableRow-root');
    for (const tr of rows) {
      const nameP = tr.querySelector('td p.MuiTypography-root');
      if (!nameP || Core.unitCodeFromText(nameP.textContent) !== code) continue;
      const inputs = tr.querySelectorAll('input');
      for (const inp of inputs) {
        const adorn = (inp.closest('td')?.querySelector('.MuiInputAdornment-root')?.textContent) || '';
        if (!Core.isReciprocalAdornment(adorn)) return inp; // Unidades/Parts
      }
    }
    return null;
  }

  async function onFocusOut(e) {
    try {
      if (!S.enabled || killSwitchOff()) return;
      const input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.classList.contains('sa-uac-cb')) return; // nuestro propio toggle
      const ctx = classifyInput(input);
      if (!ctx || !Core.isConvertible(ctx.code)) return;
      const value = parseFloat(input.value);
      if (!isFinite(value) || value <= 0) return;

      const peers = Core.computePeers(ctx.code, value);
      if (!peers.length) return;

      const missing = [];
      for (const peer of peers) {
        const peerInput = findPeerInput(ctx.panel, peer.code);
        if (peerInput) writeInput(peerInput, peer.value);
        else missing.push(peer);
      }
      if (missing.length) {
        const { created, updated } = await apiUpsertPeers(missing);
        const n = created + updated;
        if (n > 0) {
          showNotice('Se guardaron ' + n + ' unidad(es) por API (' +
            missing.map((m) => m.code).join(', ') + ') · recarga para verlas');
        }
      }
    } catch (err) {
      console.error(LOG, 'onFocusOut', err);
    }
  }

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

  // ── unitId por código: primero domain.unitIds, luego SearchUnits (cache) ──
  async function resolveUnitId(code) {
    const ids = (api()?.getDomain?.()?.unitIds) || {};
    if (ids[code] != null) return ids[code];
    if (S.unitIdCache && S.unitIdCache[code] != null) return S.unitIdCache[code];
    try {
      const data = await api().query('SearchUnits', {}, 'SearchUnits');
      // shape observado en prod (bulk-upload.js:3521): pagedData.nodes (o searchUnits.nodes).
      const nodes = data?.pagedData?.nodes || data?.searchUnits?.nodes || [];
      S.unitIdCache = S.unitIdCache || {};
      for (const n of nodes) {
        const c = Core.unitCodeFromText(n.name);
        if (c) S.unitIdCache[c] = n.id;
      }
      return S.unitIdCache[code] ?? null;
    } catch (e) {
      console.warn(LOG, 'SearchUnits falló', e);
      return null;
    }
  }

  // inventoryItemId del PN abierto: cache del interceptor, o fallback GetPartNumber por pnId.
  async function resolveInventoryItemId() {
    if (S.invItemId != null) return S.invItemId;
    if (S.pnId != null) {
      try {
        const d = await api().query('GetPartNumber', { id: S.pnId }, 'GetPartNumber');
        const inv = d?.partNumberById?.inventoryItemByPartNumberId?.id
          || d?.partNumber?.inventoryItemByPartNumberId?.id;
        if (inv != null) { S.invItemId = inv; return inv; }
      } catch (e) { console.warn(LOG, 'GetPartNumber fallback falló', e); }
    }
    return null;
  }

  // Serializa las llamadas API: blurs concurrentes (tab-through rápido) no deben crear
  // conversiones duplicadas. La 2ª espera a la 1ª y su GetAvailableUnits ya ve la unidad
  // recién creada → hace UPDATE en vez de un segundo CREATE.
  function apiUpsertPeers(missing) {
    const run = (S.apiQueue || Promise.resolve()).then(() => apiUpsertPeersInner(missing));
    S.apiQueue = run.then(() => {}, () => {}); // mantiene la cola viva aunque una corrida falle
    return run;
  }

  // Crea/actualiza conversiones para los pares sin campo. Devuelve nº creados.
  async function apiUpsertPeersInner(missing) {
    const inventoryItemId = await resolveInventoryItemId();
    if (inventoryItemId == null) {
      console.warn(LOG, 'sin inventoryItemId; no se guardan', missing.map((m) => m.code));
      showNotice('No se pudo resolver el PN — no se guardaron ' + missing.map((m) => m.code).join(', '), true);
      return { created: 0, updated: 0 };
    }
    let created = 0, updated = 0;
    try {
      const data = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
      const existing = data?.inventoryItemById?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];
      for (const peer of missing) {
        const unitId = await resolveUnitId(peer.code);
        if (unitId == null) { console.warn(LOG, 'sin unitId para', peer.code); continue; }
        const hit = existing.find((c) => Number(c.unitByUnitId?.id) === Number(unitId));
        if (hit) {
          await api().query('UpdateInventoryItemUnitConversion', { id: hit.id, factor: peer.value }, 'UpdateInventoryItemUnitConversion');
          updated++;
        } else {
          await api().query('CreateInventoryItemUnitConversion', { unitId, inventoryItemId, factor: peer.value }, 'CreateInventoryItemUnitConversion');
          created++;
        }
      }
    } catch (e) {
      console.error(LOG, 'apiUpsertPeers', e);
      showNotice('Error guardando unidades por API', true);
    }
    return { created, updated };
  }

  // Aviso no bloqueante (toast efímero).
  function showNotice(msg, isError) {
    let el = document.querySelector('.sa-uac-notice');
    if (!el) {
      el = document.createElement('div');
      el.className = 'sa-uac-notice';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:10px 16px;border-radius:8px;font-size:13px;font-family:-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:340px;pointer-events:none;transition:opacity .3s;';
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.background = isError ? '#c13c26' : '#1f2937';
    el.style.color = '#fff';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 6000);
  }

  const Applet = { __saVersion: VERSION, init, _state: S };
  window.UnitAutoConvert = Applet;
  init();
})();
