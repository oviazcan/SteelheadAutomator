// Candado de Confirmación de Precio — intercepta el guardado del modal nativo
// "Part Number Price" (SaveManyPartNumberPrices) y exige reconfirmar el precio
// (estilo password) + divisa obligatoria, antes de dejar pasar la mutación.
// La lógica pura vive en PriceConfirmCore. Glue DOM/red aquí.
//
// Gate: solo actúa si el modal nativo "Part Number Price" está abierto → NO intercepta
// la carga masiva de bulk-upload (que dispara la misma mutación sin ese modal).
const PriceConfirmGuard = (() => {
  'use strict';

  const Core = () => window.PriceConfirmCore;
  const api = () => window.SteelheadAPI;

  const SAVE_OP = 'SaveManyPartNumberPrices';
  const MODAL_TITLE_RE = /Part\s*Number\s*Price/i;

  // Estado del candado en `window` (singleton), NO en el closure: background.js re-evalúa
  // este IIFE en cada acción del popup, y el interceptor de fetch queda latcheado a la
  // instancia original. Un flag en closure haría el toggle inefectivo (lección surtido-guard).
  if (window.__saPriceGuardEnabled === undefined) window.__saPriceGuardEnabled = true;
  function isEnabled() { return window.__saPriceGuardEnabled === true; }
  function setEnabled(v) { window.__saPriceGuardEnabled = !!v; }

  // ── estilos dark-mode (prefijo sa-pcg-) ──
  function injectStyles() {
    if (document.getElementById('sa-pcg-style')) return;
    // Modo OSCURO a propósito: los modales de Steelhead son claros; así el operador ve
    // de un vistazo que este modal es de la extensión y no una pantalla nativa.
    const css = `
      .sa-pcg-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483641;display:flex;
        align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
      .sa-pcg{background:#1c2430;width:min(560px,94vw);max-height:90vh;border-radius:12px;display:flex;
        flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.6);color:#e6e9ee;border:1px solid #33404f;}
      .sa-pcg-hd{padding:14px 18px;border-bottom:1px solid #33404f;display:flex;align-items:center;justify-content:space-between;gap:10px;}
      .sa-pcg-hd h2{margin:0;font-size:16px;color:#f0f3f7;}
      .sa-pcg-x{border:none;background:none;font-size:22px;cursor:pointer;color:#9aa7b5;line-height:1;}
      .sa-pcg-x:hover{color:#e6e9ee;}
      .sa-pcg-bd{padding:8px 18px 14px;overflow:auto;}
      .sa-pcg-ft{padding:14px 18px;border-top:1px solid #33404f;display:flex;align-items:center;justify-content:flex-end;gap:10px;}
      .sa-pcg-row{border:1px solid #2b3645;border-radius:10px;padding:12px 14px;margin:12px 0;background:#19212c;}
      .sa-pcg-title{font-weight:600;color:#f0f3f7;font-size:14px;}
      .sa-pcg-sub{font-size:12px;color:#9aa7b5;margin-top:2px;}
      .sa-pcg-meta{display:flex;gap:18px;margin:10px 0 6px;flex-wrap:wrap;}
      .sa-pcg-meta b{color:#f0f3f7;}
      .sa-pcg-chip{display:inline-block;padding:3px 9px;border-radius:20px;background:#141a23;border:1px solid #3a4757;font-size:13px;}
      .sa-pcg-chip.cur{border-color:#13a36f;color:#7ee0b8;}
      .sa-pcg-lbl{font-size:12px;color:#c3ccd6;margin:8px 0 4px;}
      .sa-pcg-in{width:100%;box-sizing:border-box;background:#141a23;color:#e6e9ee;border:1px solid #3a4757;
        border-radius:8px;padding:9px 11px;font-size:15px;}
      .sa-pcg-in::placeholder{color:#6f7c8b;}
      .sa-pcg-in.ok{border-color:#13a36f;} .sa-pcg-in.bad{border-color:#e8513a;}
      .sa-pcg-mark{margin-left:8px;font-weight:700;font-size:14px;}
      .sa-pcg-mark.ok{color:#5fd0a0;} .sa-pcg-mark.bad{color:#ff7a7a;}
      .sa-pcg-calc{margin-top:10px;padding-top:10px;border-top:1px dashed #2b3645;}
      .sa-pcg-calc .r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
      .sa-pcg-fin{width:120px;background:#141a23;color:#e6e9ee;border:1px solid #3a4757;border-radius:8px;padding:7px 9px;font-size:14px;}
      .sa-pcg-eq{font-weight:700;color:#7ee0b8;font-size:15px;}
      .sa-pcg-nodiv{background:#3a1d1d;color:#f3c2c2;border:1px solid #6b2b2b;border-radius:8px;padding:9px 11px;margin:8px 0;font-size:13px;}
      .sa-pcg-btn{border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;}
      .sa-pcg-btn.primary{background:#13a36f;color:#fff;} .sa-pcg-btn.primary:disabled{background:#3a5247;color:#8fa99c;cursor:not-allowed;}
      .sa-pcg-btn.ghost{background:#33404f;color:#dfe5ec;}
      .sa-pcg-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483600;
        background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;border-left:4px solid #13a36f;border-radius:10px;
        padding:12px 18px;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}
      .sa-pcg-toast.err{border-left-color:#e8513a;}`;
    const s = document.createElement('style');
    s.id = 'sa-pcg-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of kids || []) if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    injectStyles();
    let t = document.getElementById('sa-pcg-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sa-pcg-toast'; document.body.appendChild(t); }
    t.className = 'sa-pcg-toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { const e = document.getElementById('sa-pcg-toast'); if (e) e.remove(); }, 5000);
  }

  // ── detección del modal nativo "Part Number Price" abierto ──
  // Devuelve el elemento del dialog (paper) que matchea, o null. Último match = topmost.
  function getNativePriceModal() {
    const dialogs = document.querySelectorAll('[role="dialog"], .MuiDialog-paper');
    let found = null;
    for (const d of dialogs) {
      const titleEl = d.querySelector('.MuiDialogTitle-root');
      const t = (titleEl ? titleEl.textContent : d.textContent) || '';
      if (MODAL_TITLE_RE.test(t)) found = d;
    }
    return found;
  }
  function nativePriceModalOpen() { return !!getNativePriceModal(); }

  function money(x) { return '$' + Number(x).toFixed(2); }

  // ── factor de conversión unidad→pieza: API-first (GetAvailableUnits) ──
  async function resolveFactor(partNumberId, unitId) {
    if (!api() || partNumberId == null || unitId == null) return null;
    try {
      const pnData = await api().query('GetPartNumber', { id: partNumberId }, 'GetPartNumber');
      const invId = pnData?.partNumberById?.inventoryItemByPartNumberId?.id
        || pnData?.partNumber?.inventoryItemByPartNumberId?.id;
      if (!invId) return null;
      const unitsData = await api().query('GetAvailableUnits', { inventoryItemId: invId }, 'GetAvailableUnits');
      const nodes = unitsData?.inventoryItemById?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];
      const conv = nodes.find((c) => Number(c.unitByUnitId?.id) === Number(unitId));
      const f = conv ? Number(conv.factor) : null;
      return Number.isFinite(f) && f > 0 ? f : null;
    } catch (e) {
      console.warn('[SA] PriceGuard: no se pudo obtener el factor guardado:', e && e.message);
      return null;
    }
  }

  // ── modal de confirmación → Promise<'proceed'|'block'> ──
  function openConfirmModal(lines) {
    injectStyles();
    return new Promise((resolve) => {
      document.getElementById('sa-pcg-ov')?.remove();
      let done = false;
      const rows = [];

      const finish = (result) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        document.getElementById('sa-pcg-ov')?.remove();
        resolve(result);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish('block'); } };
      document.addEventListener('keydown', onKey, true);

      const confirmBtn = el('button', {
        class: 'sa-pcg-btn primary', text: 'Confirmar y guardar', disabled: 'true',
        onclick: () => { if (!confirmBtn.disabled) finish('proceed'); },
      });

      function recompute() {
        let allOk = true;
        for (const r of rows) {
          const hasDiv = Core().hasDivisa(r.line);
          const val = r.input ? r.input.value : '';
          const okPrice = hasDiv && Core().pricesMatch(r.line.price, val);
          if (r.input) {
            const typed = String(val).trim() !== '';
            r.input.classList.toggle('ok', okPrice);
            r.input.classList.toggle('bad', typed && !okPrice);
            r.mark.className = 'sa-pcg-mark' + (okPrice ? ' ok' : (typed ? ' bad' : ''));
            r.mark.textContent = okPrice ? '✔ coincide' : (typed ? '✖ no coincide' : '');
          }
          if (r.equivSpan) {
            // valores crudos (string): el core rechaza vacío/no-numérico → '—' hasta que teclee.
            const eq = Core().perPieceEquivalent(val, r.factorInput.value);
            r.equivSpan.textContent = eq == null ? '—' : (money(eq) + ' ' + (r.line.divisa || '') + ' / pieza');
          }
          if (!(hasDiv && okPrice)) allOk = false;
        }
        confirmBtn.disabled = !allOk;
      }

      const bd = el('div', { class: 'sa-pcg-bd' });

      lines.forEach((line) => {
        const row = el('div', { class: 'sa-pcg-row' });
        const r = { line, input: null, mark: null, factorInput: null, equivSpan: null };
        rows.push(r);

        row.appendChild(el('div', { class: 'sa-pcg-title', text: line.title || ('PN ' + line.partNumberId) }));
        const subBits = [];
        if (line.priceName) subBits.push('Precio: ' + line.priceName);
        if (line.partNumberId != null) subBits.push('PN ' + line.partNumberId);
        if (subBits.length) row.appendChild(el('div', { class: 'sa-pcg-sub', text: subBits.join('  ·  ') }));

        const unitLbl = Core().unitLabel(line.unitId);
        const meta = el('div', { class: 'sa-pcg-meta' }, [
          el('span', {}, ['Divisa: ', el('span', { class: 'sa-pcg-chip cur', text: line.divisa || '(ninguna)' })]),
          el('span', {}, ['Unidad: ', el('span', { class: 'sa-pcg-chip', text: unitLbl })]),
        ]);
        row.appendChild(meta);

        if (!Core().hasDivisa(line)) {
          row.appendChild(el('div', {
            class: 'sa-pcg-nodiv',
            text: '⚠ Sin divisa seleccionada. No se puede guardar: cancela, selecciona la divisa en Steelhead y vuelve a guardar.',
          }));
        } else {
          row.appendChild(el('div', { class: 'sa-pcg-lbl', text: 'Vuelve a capturar el precio (' + line.divisa + ' / ' + unitLbl + '):' }));
          const wrap = el('div', { class: 'sa-pcg-calc r' });
          const input = el('input', {
            class: 'sa-pcg-in', type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off',
            oninput: recompute,
          });
          input.style.flex = '1';
          const mark = el('span', { class: 'sa-pcg-mark' });
          r.input = input; r.mark = mark;
          wrap.appendChild(input); wrap.appendChild(mark);
          row.appendChild(wrap);

          // Calculadora de equivalente por pieza (solo si NO es por pieza).
          if (!Core().isPerPiece(line.unitId)) {
            const calc = el('div', { class: 'sa-pcg-calc' });
            calc.appendChild(el('div', { class: 'sa-pcg-lbl', text: 'Equivalente por pieza (para validar el orden de magnitud):' }));
            const factorInput = el('input', {
              class: 'sa-pcg-fin', type: 'text', inputmode: 'decimal', placeholder: unitLbl + '/pza', autocomplete: 'off',
              oninput: recompute,
            });
            const equivSpan = el('span', { class: 'sa-pcg-eq', text: '—' });
            r.factorInput = factorInput; r.equivSpan = equivSpan;
            calc.appendChild(el('div', { class: 'r' }, [
              el('span', { class: 'sa-pcg-sub', text: 'Factor:' }), factorInput,
              el('span', { class: 'sa-pcg-sub', text: unitLbl + ' por pieza' }),
              el('span', { text: '→' }), equivSpan,
            ]));
            const hint = el('div', { class: 'sa-pcg-sub', text: 'Buscando factor guardado…' });
            calc.appendChild(hint);
            row.appendChild(calc);
            // API-first: rellena el factor si está guardado; si no, queda editable (manual).
            resolveFactor(line.partNumberId, line.unitId).then((f) => {
              if (f != null && factorInput.value.trim() === '') { factorInput.value = String(f); }
              hint.textContent = f != null
                ? 'Factor guardado: ' + f + ' ' + unitLbl + '/pza (editable).'
                : 'Sin factor guardado. Captura el factor manualmente si quieres el equivalente.';
              recompute();
            });
          }
        }
        bd.appendChild(row);
      });

      const ov = el('div', { id: 'sa-pcg-ov', class: 'sa-pcg-ov' });
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish('block'); });
      const panel = el('div', { class: 'sa-pcg' }, [
        el('div', { class: 'sa-pcg-hd' }, [
          el('h2', { text: '🔒 Confirma el precio antes de guardar' }),
          el('button', { class: 'sa-pcg-x', text: '×', onclick: () => finish('block') }),
        ]),
        bd,
        el('div', { class: 'sa-pcg-ft' }, [
          el('button', { class: 'sa-pcg-btn ghost', text: 'Cancelar', onclick: () => finish('block') }),
          confirmBtn,
        ]),
      ]);
      ov.appendChild(panel);
      // Montar DENTRO del contenedor del dialog nativo: el MuiDialog aplica focus-trap +
      // inert/aria-hidden a todo lo externo, y en document.body el input no recibe teclado.
      // Dentro del contenedor (dentro del trap, no-inert) el foco y el tecleo funcionan.
      const modal = getNativePriceModal();
      const mount = (modal && (modal.closest('.MuiDialog-container') || modal.parentElement)) || document.body;
      mount.appendChild(ov);
      const first = bd.querySelector('input.sa-pcg-in');
      if (first) first.focus();
      recompute();
    });
  }

  // ── interceptor de fetch: gate asíncrono sobre el guardado ──
  function patchFetch() {
    if (window.__saPriceGuardFetchPatched) return;
    window.__saPriceGuardFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      let op = null, vars = null;
      if (typeof url === 'string' && url.includes('/graphql') && opts && typeof opts.body === 'string') {
        try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
      }

      if (op === SAVE_OP && isEnabled() && nativePriceModalOpen()) {
        let decision = 'block';
        try {
          const lines = Core().extractLines(vars);
          if (!lines.length) {
            decision = 'proceed'; // nada que confirmar (no debería pasar con el modal abierto)
          } else {
            decision = await openConfirmModal(lines);
          }
        } catch (e) {
          console.error('[SA] PriceGuard: error en la confirmación, fail-closed:', e);
          decision = 'block';
        }
        if (decision !== 'proceed') {
          toast('🔒 Guardado cancelado: la confirmación del precio no coincidió o falta divisa.', true);
          console.warn('[SA] PriceGuard: BLOQUEADO SaveManyPartNumberPrices');
          return new Response(
            JSON.stringify({ errors: [{ message: 'Guardado cancelado por el Candado de Confirmación de Precio.' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        toast('✅ Precio confirmado. Guardando…');
      }

      return origFetch.apply(this, args);
    };
  }

  // ── toggle desde el popup ──
  function toggleFromPopup() {
    setEnabled(!isEnabled());
    const on = isEnabled();
    toast(on ? '🔒 Candado de Precio: ACTIVADO' : '🔓 Candado de Precio: DESACTIVADO (hasta recargar)');
    return { enabled: on };
  }

  function init() {
    if (window.__saPriceGuardInit) return;
    window.__saPriceGuardInit = true;
    patchFetch(); // latch idempotente; solo actúa sobre SaveManyPartNumberPrices con el modal abierto
    console.log('[SA] PriceConfirmGuard activo (default', isEnabled() ? 'ON' : 'OFF', ')');
  }

  return {
    init, isEnabled, toggleFromPopup,
    _getState: () => ({ enabled: isEnabled(), patched: !!window.__saPriceGuardFetchPatched }),
  };
})();

if (typeof window !== 'undefined') {
  window.PriceConfirmGuard = PriceConfirmGuard;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PriceConfirmGuard.init());
  } else {
    PriceConfirmGuard.init();
  }
}
