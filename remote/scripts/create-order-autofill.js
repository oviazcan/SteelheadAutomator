// Create Order Autofill
// Auto-llena las Entradas Personalizadas del modal de creación de OV. Dos pantallas:
//   1. /Receiving/CustomerParts → "RECEIVE" → "+ / Create"  → título "Crear Orden de Venta" (ES),
//      cliente pre-cargado, expone "Enviar a:" (ship-to).
//   2. /Domains/<id>/SalesOrders → "New Sales Order"          → título "Create Sales Order" (EN),
//      cliente vacío (el operador lo elige a mano), SIN ship-to.
// Mismos IDs RJSF en ambos modales (root_RazonSocialVenta / root_Divisa / root_ConsolidarPorProducto),
// así que el mismo autofill sirve para los dos; solo cambia el gate de URL y el título.
//
// Reglas:
//   - Razón Social  ← customer.customInputs.DatosFactura.RazonSocialVenta (match exacto contra <option>)
//   - Divisa        ← customer.customInputs.DatosFactura.Divisa            (match exacto/substring contra <option>)
//   - Consolidar    ← ship-to-driven: marca checkbox si "Enviar a:" del modal contiene "javier rojo"
//                     (en la pantalla SalesOrders no hay ship-to → Consolidar no aplica, se omite)
//
// Depende de: SteelheadAPI, CreateOrderAutofillCore (create-order-autofill-core.js)
//
// FIX 2026-07-03: la extracción del cliente ya NO depende del label-walk frágil
// (findSingleValueByLabel hacía `return null` al toparse el input[role=combobox]
// del react-select ANTES de hallar el singleValue → "(sin cliente)" → "sin idInDomain"
// para TODOS los clientes). Ahora el cliente se elige por el singleValue que trae el
// badge "(#N)" (único en el modal), y como red de seguridad se resuelve el idInDomain
// por nombre vía CustomerSearchByName si faltara el badge. Ver bitácora + core.

const CreateOrderAutofill = (() => {
  'use strict';

  // Fallbacks locales por si el core no cargara (el core va ANTES en el array scripts,
  // así que normalmente se usan sus helpers homónimos vía urlMatches()/headingMatches()).
  const URL_RE = /\/Receiving\/CustomerParts(?:\/|$)|\/Domains\/\d+\/SalesOrders\/?$/;
  const MODAL_HEADING_RE = /^\s*(?:crear\s+orden\s+de\s+venta|create\s+sales\s+order)\s*$/i;
  const RJSF_RAZON_ID = 'root_RazonSocialVenta';
  const RJSF_DIVISA_ID = 'root_Divisa';
  const RJSF_CONSOLIDAR_ID = 'root_ConsolidarPorProducto';
  const ROJO_GOMEZ_RE = /javier\s*rojo/i;

  const api = () => window.SteelheadAPI;
  const core = () => window.CreateOrderAutofillCore;
  const log = (m) => (api()?.log ? api().log(`[create-order-autofill] ${m}`) : console.log('[create-order-autofill]', m));
  const warn = (m) => (api()?.warn ? api().warn(`[create-order-autofill] ${m}`) : console.warn('[create-order-autofill]', m));

  const urlMatches = (p) => {
    const c = core();
    return c?.matchesCreateOrderUrl ? c.matchesCreateOrderUrl(p) : URL_RE.test(p);
  };
  const headingMatches = (t) => {
    const c = core();
    return c?.isCreateOrderModalHeading ? c.isCreateOrderModalHeading(t) : MODAL_HEADING_RE.test(t);
  };

  const _customerCache = new Map();   // idInDomain → customer
  const _nameIdCache = new Map();     // normalizedName → idInDomain|null
  let observerActive = false;
  let debounceTimer = null;
  let state = {
    runId: 0,
    lastSig: null,
    panel: null,
    results: { razon: null, divisa: null, consolidar: null }
  };

  function init() {
    if (window.__saCreateOrderAutofillVersion) return;
    window.__saCreateOrderAutofillVersion = true;
    if (document.documentElement.dataset.saCreateOrderAutofillEnabled === 'false') {
      log('deshabilitado');
      return;
    }
    setupUrlListener();
    log(`init en ${location.pathname} (matches=${urlMatches(location.pathname)})`);
    checkUrl();
  }

  function setupUrlListener() {
    if (window.__saCreateOrderAutofillHistoryPatched) return;
    window.__saCreateOrderAutofillHistoryPatched = true;
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        checkUrl();
        return r;
      };
    });
    window.addEventListener('popstate', checkUrl);
  }

  function checkUrl() {
    if (!urlMatches(location.pathname)) {
      removePanel();
      state.lastSig = null;
      return;
    }
    setupObserver();
  }

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;
    const obs = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanForModal, 350);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    scanForModal();
  }

  // ── Detección del modal ──

  function scanForModal() {
    const razonSel = document.getElementById(RJSF_RAZON_ID);
    const divisaSel = document.getElementById(RJSF_DIVISA_ID);
    const consolidarChk = document.getElementById(RJSF_CONSOLIDAR_ID);
    if (!razonSel || !divisaSel || !consolidarChk) {
      // Modal cerrado o aún no montado
      if (state.lastSig !== null) {
        state.lastSig = null;
        removePanel();
      }
      return;
    }
    if (!isCreateOrderModal()) return;

    const customerName = extractCustomerNameFromModal();
    const shipTo = extractShipToFromModal();
    const sig = `${customerName || '?'}||${shipTo || '?'}`;
    if (sig === state.lastSig) return;
    state.lastSig = sig;
    state.runId++;
    const myRun = state.runId;

    log(`modal detectado | cliente=${customerName || '(sin cliente)'} | shipTo=${shipTo || '(sin shipTo)'}`);

    runAutofill(myRun, { customerName, shipTo, razonSel, divisaSel, consolidarChk })
      .catch(err => warn(`runAutofill: ${err.message}`));
  }

  function isStale(myRun) { return state.runId !== myRun; }

  function isCreateOrderModal() {
    const heads = document.querySelectorAll('h1, h2, h3, h4, [class*="MuiTypography-h"]');
    for (const h of heads) {
      if (headingMatches((h.textContent || '').trim())) return true;
    }
    return false;
  }

  // Subir al paper/contenedor del MUI Dialog que contiene el modal "Crear Orden de
  // Venta" para anclar las búsquedas SOLO dentro del modal (no del wizard padre
  // "Recibir piezas del cliente").
  //
  // FIX 2026-07-03 (v0.1.2): el heading es un <h2 class="...MuiDialogTitle-root...">,
  // cuya clase contiene el substring "MuiDialog". El código viejo arrancaba el match
  // EN el heading con `[class*="MuiDialog"]`, así que devolvía el TÍTULO (vacío) en la
  // iteración 0 → svInRoot=0 → cliente=null → "sin idInDomain" para TODOS. Ahora se
  // sube desde el PADRE del heading y se acepta como root solo el paper/contenedor del
  // diálogo (Core.isDialogRootClass excluye Title/Content/Actions y el paper genérico
  // del accordion RJSF).
  function isDialogRoot(el) {
    if (!el) return false;
    if (el.matches?.('[role="dialog"]')) return true;
    const c = core();
    const cls = String(el.className || '');
    return c
      ? c.isDialogRootClass(cls)
      : (cls.includes('MuiDialog') && !/MuiDialog(Title|Content|Actions|ContentText)/.test(cls));
  }

  function getModalRoot() {
    const heads = document.querySelectorAll('h1, h2, h3, h4, [class*="MuiTypography-h"]');
    for (const h of heads) {
      if (!headingMatches((h.textContent || '').trim())) continue;
      // Arrancamos ARRIBA del heading: su propia clase MuiDialogTitle-root es un cebo.
      let cur = h.parentElement;
      for (let i = 0; i < 14 && cur; i++) {
        if (isDialogRoot(cur)) return cur;
        cur = cur.parentElement;
      }
    }
    // Fallback: ascender desde un campo RJSF hasta el diálogo contenedor. Sube PAST el
    // paper chico del accordion (que no lleva "MuiDialog") y el DialogContent.
    const field = document.getElementById(RJSF_RAZON_ID) || document.getElementById(RJSF_DIVISA_ID);
    if (field) {
      let cur = field.parentElement;
      for (let i = 0; i < 24 && cur; i++) {
        if (isDialogRoot(cur)) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  // ── Extracción dentro del modal ──

  // Junta los textos de todos los react-select singleValue del modal, quitando el
  // avatar/imagen (que se pega al nombre: "C"+"CONTROLES..." → "CCONTROLES...").
  function collectSingleValueTexts(root) {
    const out = [];
    const svs = root.querySelectorAll('[class*="singleValue"], [class*="SingleValue"]');
    for (const sv of svs) {
      const clone = sv.cloneNode(true);
      clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
      const t = (clone.textContent || '').trim();
      if (t) out.push(t);
    }
    return out;
  }

  // Devuelve el nombre del cliente tal como aparece en el modal (con "(#N)" si lo trae).
  // Primario: el singleValue con badge "(#N)" (único del Cliente, label-independiente).
  // Fallback: label-anchored por si algún modal no mostrara el badge.
  function extractCustomerNameFromModal() {
    const root = getModalRoot();
    if (!root) return null;
    const c = core();
    if (c) {
      const picked = c.pickCustomerFromSingleValues(collectSingleValueTexts(root));
      if (picked) return picked.raw;
    }
    const sv = findSingleValueByLabel(root, /^\s*cliente:?\s*$/i);
    if (!sv) return null;
    const clone = sv.cloneNode(true);
    clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
    const raw = (clone.textContent || '').trim();
    return c ? c.cleanCustomerName(raw) : raw;
  }

  function extractShipToFromModal() {
    const root = getModalRoot();
    if (!root) return null;
    const sv = findSingleValueByLabel(root, /^\s*enviar\s+a:?\s*$/i);
    if (!sv) return null;
    return (sv.textContent || '').trim();
  }

  // Localiza un singleValue de react-select por su label de <p>label:</p>.
  // Se prefiere la ÚLTIMA etiqueta que matchea (la del modal, no la del wizard padre)
  // y se buscan singleValues en los siguientes hermanos. NO se hace bail al toparse el
  // input[role=combobox] (ese bail rompía la extracción: el react-select SIEMPRE tiene
  // el combobox junto al singleValue).
  function findSingleValueByLabel(root, labelRe) {
    const candidates = [];
    for (const el of root.querySelectorAll('p, label, span')) {
      const raw = (el.textContent || '').trim();
      if (raw.length === 0 || raw.length > 40) continue;
      const cleaned = raw.replace(/[\s:*]+$/, '').trim();
      if (!labelRe.test(cleaned) && !labelRe.test(raw)) continue;
      if (el.querySelector('input, textarea, button, select')) continue;
      candidates.push(el);
    }
    // De la última a la primera (la del modal suele ser la última en el DOM).
    for (let i = candidates.length - 1; i >= 0; i--) {
      let labelRoot = candidates[i];
      while (labelRoot.parentElement
        && labelRoot.parentElement.children.length === 1
        && labelRoot.parentElement.firstElementChild === labelRoot
        && !['BODY', 'HTML'].includes(labelRoot.parentElement.tagName)) {
        labelRoot = labelRoot.parentElement;
      }
      let cursor = labelRoot.nextElementSibling;
      let hops = 0;
      while (cursor && hops < 8) {
        const sv = cursor.querySelector('[class*="singleValue"], [class*="SingleValue"]');
        if (sv) return sv;
        cursor = cursor.nextElementSibling;
        hops++;
      }
    }
    return null;
  }

  // ── Fetch del customer ──

  async function fetchCustomerCustomInputs(idInDomain) {
    if (idInDomain == null) return null;
    if (_customerCache.has(idInDomain)) return _customerCache.get(idInDomain);
    try {
      const data = await SteelheadAPI.query('Customer', { idInDomain, includeAccountingFields: true });
      const c = data?.customerByIdInDomain || null;
      _customerCache.set(idInDomain, c);
      return c;
    } catch (err) {
      warn(`Customer(idInDomain=${idInDomain}) falló: ${err.message}`);
      _customerCache.set(idInDomain, null);
      return null;
    }
  }

  // Fallback: resolver idInDomain desde el nombre del cliente (sin "(#N)") vía
  // CustomerSearchByName. Solo se usa si el badge "(#N)" no estuviera presente.
  async function resolveIdInDomainByName(rawName) {
    const c = core();
    const clean = (c ? c.cleanCustomerName(rawName) : String(rawName || ''))
      .replace(/\s*\(#\d+\)\s*$/, '').trim();
    if (!clean) return null;
    const key = c ? c.normalizeForMatch(clean) : clean.toLowerCase();
    if (_nameIdCache.has(key)) return _nameIdCache.get(key);
    try {
      const r = await SteelheadAPI.query('CustomerSearchByName', { searchText: clean, name: clean, query: clean, first: 12 });
      const nodes = r?.searchCustomers?.nodes || [];
      let hit = nodes.find(n => (c ? c.normalizeForMatch(n.name) : String(n.name || '').toLowerCase()) === key);
      if (!hit && nodes.length === 1) hit = nodes[0];
      const id = hit ? hit.idInDomain : null;
      _nameIdCache.set(key, id);
      return id;
    } catch (err) {
      warn(`resolveIdInDomainByName("${clean}") falló: ${err.message}`);
      return null;
    }
  }

  // ── Fills ──

  function fillNativeSelectByText(sel, targetText) {
    if (!sel || !targetText) return { success: false, reason: 'sin select o target' };
    const c = core();
    if (!c) return { success: false, reason: 'core no cargado' };
    const targetNorm = c.normalizeForMatch(targetText);
    if (!targetNorm) return { success: false, reason: 'target vacío' };

    // Si ya está en el valor correcto, no tocamos
    const currentOpt = sel.options?.[sel.selectedIndex];
    if (currentOpt && c.normalizeForMatch(currentOpt.text || '') === targetNorm) {
      return { success: true, filled: currentOpt.text, noop: true };
    }

    // Si el operador ya seleccionó algo distinto, NO sobreescribir
    if (sel.dataset.saAutofilled === 'done' && sel.value && sel.value !== '') {
      return { success: false, reason: 'usuario tocó después de autofill' };
    }

    const optionTexts = [...sel.options].map(o => o.text || '');
    const match = c.scoreOptionMatch(optionTexts, targetText);
    if (!match.pass) {
      return { success: false, reason: `sin match (mejor score=${match.score})` };
    }
    const best = sel.options[match.index];

    const tracker = sel._valueTracker;
    if (tracker) tracker.setValue('');
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(sel, best.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dataset.saAutofilled = 'done';
    return { success: true, filled: best.text };
  }

  function setCheckbox(chk, target) {
    if (!chk) return { success: false, reason: 'sin checkbox' };
    if (chk.dataset.saAutofilled === 'done') {
      return { success: true, noop: true, value: chk.checked };
    }
    if (chk.checked === target) {
      chk.dataset.saAutofilled = 'done';
      return { success: true, noop: true, value: chk.checked };
    }
    // RJSF acepta click() en boolean checkboxes
    chk.click();
    chk.dataset.saAutofilled = 'done';
    return { success: true, value: chk.checked };
  }

  // ── Run principal ──

  async function runAutofill(myRun, { customerName, shipTo, razonSel, divisaSel, consolidarChk }) {
    let idInDomain = core() ? core().extractCustomerIdInDomain(customerName) : null;

    // Fallback: si no vino el badge "(#N)", resolver por nombre.
    if (idInDomain == null && customerName) {
      idInDomain = await resolveIdInDomainByName(customerName);
      if (isStale(myRun)) return;
      if (idInDomain != null) log(`idInDomain resuelto por nombre → ${idInDomain}`);
    }

    if (idInDomain == null) {
      // Pantalla SalesOrders: el modal abre SIN cliente (el operador lo elige a mano).
      // No mostramos panel de error mientras no haya cliente — esperamos en silencio a
      // que lo seleccione (la firma cambia y re-dispara el scan). Solo reportamos error
      // si SÍ hay nombre de cliente pero no pudimos resolver su idInDomain.
      if (!customerName) {
        log('modal abierto sin cliente elegido aún — esperando selección');
        removePanel();
        return;
      }
      log(`sin idInDomain (cliente="${customerName}") — no autofill`);
      state.results = { razon: { ok: false, msg: 'sin idInDomain' }, divisa: { ok: false, msg: 'sin idInDomain' }, consolidar: null };
      renderPanel({ customerName, shipTo });
      return;
    }

    const customer = await fetchCustomerCustomInputs(idInDomain);
    if (isStale(myRun)) return;

    const datos = customer?.customInputs?.DatosFactura || {};
    const targetRazon = datos.RazonSocialVenta || null;
    const targetDivisa = datos.Divisa || null;

    // Razón Social
    let razonResult;
    if (!targetRazon) {
      razonResult = { ok: false, msg: 'cliente sin DatosFactura.RazonSocialVenta' };
    } else {
      const r = fillNativeSelectByText(razonSel, targetRazon);
      razonResult = r.success
        ? { ok: true, msg: r.noop ? `ya estaba: ${r.filled}` : `seleccionado: ${r.filled}` }
        : { ok: false, msg: r.reason };
    }

    // Divisa
    let divisaResult;
    if (!targetDivisa) {
      divisaResult = { ok: false, msg: 'cliente sin DatosFactura.Divisa' };
    } else {
      const r = fillNativeSelectByText(divisaSel, targetDivisa);
      divisaResult = r.success
        ? { ok: true, msg: r.noop ? `ya estaba: ${r.filled}` : `seleccionado: ${r.filled}` }
        : { ok: false, msg: r.reason };
    }

    // Consolidar (ship-to-driven, independiente del customer). En la pantalla SalesOrders
    // el modal NO expone "Enviar a:" → sin destino no aplica la regla Rojo Gómez; lo
    // dejamos en el default RJSF (false) y lo marcamos como omitido, no como fallo.
    let consolidarResult;
    if (!shipTo) {
      consolidarResult = { ok: true, msg: 'no aplica (sin destino en esta pantalla)', skipped: true };
    } else if (ROJO_GOMEZ_RE.test(shipTo)) {
      const r = setCheckbox(consolidarChk, true);
      consolidarResult = r.success
        ? { ok: true, msg: r.noop ? 'ya estaba marcado' : 'marcado (Rojo Gómez)' }
        : { ok: false, msg: r.reason };
    } else {
      // No es Rojo Gómez — dejamos el checkbox tal cual (default RJSF=false)
      consolidarResult = { ok: true, msg: 'no aplica (otra planta)', skipped: true };
    }

    state.results = { razon: razonResult, divisa: divisaResult, consolidar: consolidarResult };
    log(`autofill | razon=${razonResult.ok ? 'OK' : 'FAIL'} | divisa=${divisaResult.ok ? 'OK' : 'FAIL'} | consolidar=${consolidarResult.ok ? 'OK' : 'FAIL'}`);

    renderPanel({ customerName, shipTo });
  }

  // ── Panel UI ──

  const STATUS = {
    ok: { color: '#10b981', icon: '✓' },
    fail: { color: '#ef4444', icon: '✗' },
    skip: { color: '#94a3b8', icon: '·' }
  };

  function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function row(label, res) {
    if (!res) return '';
    const tone = res.skipped ? STATUS.skip : (res.ok ? STATUS.ok : STATUS.fail);
    return `
      <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;">
        <span style="color:${tone.color};font-weight:700;min-width:14px;">${tone.icon}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;">${escHtml(label)}</div>
          <div style="color:#e2e8f0;font-size:12px;word-break:break-word;">${escHtml(res.msg || '')}</div>
        </div>
      </div>`;
  }

  function renderPanel({ customerName, shipTo }) {
    let panel = document.getElementById('sa-create-order-autofill-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sa-create-order-autofill-panel';
      panel.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483646;background:#1e293b;color:#e2e8f0;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;font-size:13px;padding:10px 12px;min-width:240px;max-width:320px;';
      document.body.appendChild(panel);
    }
    state.panel = panel;
    const { razon, divisa, consolidar } = state.results;
    const allOk = [razon, divisa, consolidar].every(r => r && (r.ok || r.skipped));
    const headerColor = allOk ? '#10b981' : '#f59e0b';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:700;color:${headerColor};">📝 Crear OV — Autofill</span>
        <button id="sa-coa-close" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1;">×</button>
      </div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">${escHtml(customerName || '(sin cliente)')} → ${escHtml(shipTo || '(sin shipTo)')}</div>
      ${row('Razón Social', razon)}
      ${row('Divisa', divisa)}
      ${row('Consolidar', consolidar)}
      <div style="text-align:right;margin-top:6px;">
        <button id="sa-coa-redo" style="background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;">Re-aplicar</button>
      </div>`;
    panel.querySelector('#sa-coa-close')?.addEventListener('click', () => removePanel());
    panel.querySelector('#sa-coa-redo')?.addEventListener('click', () => {
      // Forzar re-run reseteando las marcas dataset y la firma
      [RJSF_RAZON_ID, RJSF_DIVISA_ID, RJSF_CONSOLIDAR_ID].forEach(id => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.saAutofilled;
      });
      state.lastSig = null;
      scanForModal();
    });

    // Auto-colapsar si todo OK tras 1.8s
    if (allOk) {
      setTimeout(() => {
        if (!state.panel || !document.body.contains(state.panel)) return;
        if (state.lastSig === null) return;
        state.panel.style.opacity = '0.45';
      }, 1800);
    }
  }

  function removePanel() {
    const p = document.getElementById('sa-create-order-autofill-panel');
    if (p) p.remove();
    state.panel = null;
  }

  return { init, scanForModal };
})();

if (typeof window !== 'undefined') {
  window.CreateOrderAutofill = CreateOrderAutofill;
  CreateOrderAutofill.init();
}
