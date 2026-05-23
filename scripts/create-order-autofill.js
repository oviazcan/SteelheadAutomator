// Create Order Autofill
// Auto-llena las 3 Entradas Personalizadas del modal "Crear Orden de Venta"
// que sale en /Receiving/CustomerParts → "RECEIVE" → "+ / Create".
//
// Reglas:
//   - Razón Social  ← customer.customInputs.DatosFactura.RazonSocialVenta (match exacto contra <option>)
//   - Divisa        ← customer.customInputs.DatosFactura.Divisa            (match exacto contra <option>)
//   - Consolidar    ← ship-to-driven: marca checkbox si "Enviar a:" del modal contiene "javier rojo"
//
// Depende de: SteelheadAPI

const CreateOrderAutofill = (() => {
  'use strict';

  const URL_RE = /\/Receiving\/CustomerParts(?:\/|$)/;
  const MODAL_HEADING_RE = /^\s*crear\s+orden\s+de\s+venta\s*$/i;
  const RJSF_RAZON_ID = 'root_RazonSocialVenta';
  const RJSF_DIVISA_ID = 'root_Divisa';
  const RJSF_CONSOLIDAR_ID = 'root_ConsolidarPorProducto';
  const ROJO_GOMEZ_RE = /javier\s*rojo/i;

  const api = () => window.SteelheadAPI;
  const log = (m) => (api()?.log ? api().log(`[create-order-autofill] ${m}`) : console.log('[create-order-autofill]', m));
  const warn = (m) => (api()?.warn ? api().warn(`[create-order-autofill] ${m}`) : console.warn('[create-order-autofill]', m));

  const _customerCache = new Map();
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
    log(`init en ${location.pathname} (matches=${URL_RE.test(location.pathname)})`);
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
    if (!URL_RE.test(location.pathname)) {
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
      if (MODAL_HEADING_RE.test((h.textContent || '').trim())) return true;
    }
    return false;
  }

  // Subir al MuiDialog/Paper que contiene el heading "Crear Orden de Venta"
  // para anclar las búsquedas de cliente/shipTo SOLO dentro del modal y no del
  // wizard padre "Recibir piezas del cliente" (que también trae un combo Cliente).
  function getModalRoot() {
    const heads = document.querySelectorAll('h1, h2, h3, h4, [class*="MuiTypography-h"]');
    for (const h of heads) {
      if (!MODAL_HEADING_RE.test((h.textContent || '').trim())) continue;
      let cur = h;
      for (let i = 0; i < 12 && cur; i++) {
        if (cur.matches?.('[role="dialog"], [class*="MuiDialog"], [class*="MuiPaper"]')) return cur;
        cur = cur.parentElement;
      }
      return h.closest('[role="dialog"], [class*="MuiPaper"]') || h.parentElement;
    }
    return null;
  }

  // ── Extracción dentro del modal ──

  function extractCustomerNameFromModal() {
    const root = getModalRoot();
    if (!root) return null;
    const sv = findSingleValueByLabel(root, /^\s*cliente:?\s*$/i);
    if (!sv) return null;
    const clone = sv.cloneNode(true);
    clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
    return cleanCustomerName((clone.textContent || '').trim());
  }

  function extractShipToFromModal() {
    const root = getModalRoot();
    if (!root) return null;
    const sv = findSingleValueByLabel(root, /^\s*enviar\s+a:?\s*$/i);
    if (!sv) return null;
    return (sv.textContent || '').trim();
  }

  // El singleValue del react-select absorbe badges sin whitespace
  // ("SCHNEIDER ELECTRIC MEXICO (#1)Industrial"). Cortamos tras "(#N)".
  function cleanCustomerName(raw) {
    if (!raw) return raw;
    const m = raw.match(/^(.+?\(#\d+\))/);
    if (m) return m[1].trim();
    return raw.trim();
  }

  function extractCustomerIdInDomain(rawName) {
    const m = (rawName || '').match(/\(#(\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Localiza un singleValue de react-select por su label de <p>label:</p>.
  // Patrón replicado de invoice-autofill.findFieldContainerByPLabel: subimos al
  // labelRoot (ancestro hijo único) y caminamos siblings hasta encontrar uno
  // con [class*=singleValue] o con un combobox vacío (placeholder).
  function findSingleValueByLabel(root, labelRe) {
    const candidates = root.querySelectorAll('p, label, span');
    for (const el of candidates) {
      const raw = (el.textContent || '').trim();
      if (raw.length === 0 || raw.length > 40) continue;
      const cleaned = raw.replace(/[\s:*]+$/, '').trim();
      if (!labelRe.test(cleaned) && !labelRe.test(raw)) continue;
      if (el.querySelector('input, textarea, button, select')) continue;

      // Ascender al labelRoot (mientras sea hijo único)
      let labelRoot = el;
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
        if (cursor.querySelector('input[role="combobox"]')) return null;
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

  // ── Fills ──

  function normalizeForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fillNativeSelectByText(sel, targetText) {
    if (!sel || !targetText) return { success: false, reason: 'sin select o target' };
    const targetNorm = normalizeForMatch(targetText);
    if (!targetNorm) return { success: false, reason: 'target vacío' };

    // Si ya está en el valor correcto, no tocamos
    const currentOpt = sel.options?.[sel.selectedIndex];
    if (currentOpt && normalizeForMatch(currentOpt.text || '') === targetNorm) {
      return { success: true, filled: currentOpt.text, noop: true };
    }

    // Si el operador ya seleccionó algo distinto, NO sobreescribir
    if (sel.dataset.saAutofilled === 'done' && sel.value && sel.value !== '') {
      return { success: false, reason: 'usuario tocó después de autofill' };
    }

    let best = null, bestScore = -1;
    for (const opt of sel.options) {
      const txt = (opt.text || '').trim();
      if (!txt) continue;
      const norm = normalizeForMatch(txt);
      let score = 0;
      if (norm === targetNorm) score = 100;
      else if (norm.includes(targetNorm) || targetNorm.includes(norm)) score = 60;
      else {
        const tokens = targetNorm.split(' ').filter(t => t.length > 2);
        for (const t of tokens) { if (norm.includes(t)) score += 8; }
      }
      if (score > bestScore) { bestScore = score; best = opt; }
    }
    if (!best || bestScore < 60) {
      return { success: false, reason: `sin match (mejor score=${bestScore})` };
    }

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
    const idInDomain = extractCustomerIdInDomain(customerName);
    if (!idInDomain) {
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

    // Consolidar (ship-to-driven, independiente del customer)
    let consolidarResult;
    if (!shipTo) {
      consolidarResult = { ok: false, msg: 'sin shipTo visible' };
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
