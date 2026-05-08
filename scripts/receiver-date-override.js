// Receiver Date Override
// Inyecta un campo "Fecha real de recibido:" en el modal de Receive Parts.
// Intercepta CreateReceiverChecked y, cuando el usuario tocó el campo,
// dispara un follow-up UpdateReceiver con el receivedAt elegido (server
// no acepta receivedAt en el create — siempre lo setea a NOW).
// No depende de SteelheadAPI (solo intercept de fetch nativo).

const ReceiverDateOverride = (() => {
  'use strict';

  const LOG_PREFIX = '[RDO]';
  let observerActive = false;
  let modalObserver = null;

  // modal element → { input, warningEl, userTouched, removalObserver }
  const modalStates = new WeakMap();

  function init() {
    const disabled = document.documentElement.dataset.saReceiverDateOverrideEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── MutationObserver: detect Receive Parts modal ──

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    let scanTimeout = null;
    const observer = new MutationObserver(() => {
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(scanForReceiveView, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForReceiveView();
  }

  function scanForReceiveView() {
    const candidates = document.querySelectorAll(HEADING_SELECTOR);
    for (const el of candidates) {
      if (!VIEW_REGEX.test(el.textContent?.trim())) continue;
      const container = el.closest('[role="dialog"]')
        || el.closest('.MuiDialog-paper')
        || el.closest('[class*="MuiPaper"]')
        || el.closest('main')
        || el.closest('form')
        || el.parentElement?.parentElement;
      if (container) {
        onModalFound(container);
        return;
      }
    }
  }

  function onModalFound(modal) {
    if (modal.dataset.saRdoAttached === 'true') return;
    modal.dataset.saRdoAttached = 'true';
    modalStates.set(modal, {});  // initialize empty state before any downstream code runs
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    watchModalRemoval(modal);
  }

  function watchModalRemoval(modal) {
    const removalObserver = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        removalObserver.disconnect();
        cleanupModal(modal);
      }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const state = modalStates.get(modal);
    if (state) state.removalObserver = removalObserver;
  }

  function cleanupModal(modal) {
    const state = modalStates.get(modal);
    if (state?.removalObserver) state.removalObserver.disconnect();
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  // ── Placeholder functions (implementadas en tareas siguientes) ──

  const UPDATE_RECEIVER_HASH = '005653bae4baad289db47d65857cc4e9fb89fa51e06caa78a1f0946dce7f92ec';

  function patchFetch() {
    if (window.__saRdoFetchPatched) return;
    window.__saRdoFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body || typeof opts.body !== 'string') {
        return origFetch.apply(this, args);
      }

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      if (bodyObj?.operationName !== 'CreateReceiverChecked') {
        return origFetch.apply(this, args);
      }

      // Capturar intent ANTES de enviar (el modal se desmonta tras Save)
      let pendingISO = null;
      let pendingPayload = null;
      try {
        const modal = document.querySelector('[data-sa-rdo-attached="true"]');
        const state = modal && modalStates.get(modal);
        if (state?.userTouched && state.input?.value) {
          const [y, m, d] = state.input.value.split('-').map(Number);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            pendingISO = new Date(y, m - 1, d, 12, 0, 0).toISOString();
            const rp = bodyObj.variables?.receiverPayload || {};
            pendingPayload = {
              notes: rp.notes ?? '',
              customInputs: rp.customInputs ?? {},
              inputSchemaId: rp.inputSchemaId ?? null,
            };
            state.userTouched = false;
          }
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Error capturando intent del modal — paso through:', err);
      }

      const response = await origFetch.apply(this, args);
      if (!pendingISO) return response;

      // Inspeccionar response sin consumirla
      let receiverId = null;
      try {
        const cloned = response.clone();
        const json = await cloned.json();
        if (json?.errors?.length) {
          console.warn(LOG_PREFIX, 'CreateReceiverChecked devolvió errors — sin follow-up:', json.errors);
          return response;
        }
        receiverId = json?.data?.createReceiverChecked?.id ?? null;
      } catch (err) {
        console.warn(LOG_PREFIX, 'No se pudo parsear response de CreateReceiverChecked:', err);
        return response;
      }

      if (!receiverId) {
        console.warn(LOG_PREFIX, 'CreateReceiverChecked sin id en response — skip follow-up');
        return response;
      }

      // Disparar follow-up UpdateReceiver (no awaiteamos para no bloquear el UI)
      const updateBody = {
        operationName: 'UpdateReceiver',
        variables: {
          id: receiverId,
          notes: pendingPayload.notes,
          receivedAt: pendingISO,
          customInputs: pendingPayload.customInputs,
          inputSchemaId: pendingPayload.inputSchemaId,
        },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: UPDATE_RECEIVER_HASH },
        },
      };

      origFetch.call(this, url, {
        method: 'POST',
        credentials: opts.credentials || 'include',
        headers: opts.headers || { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      }).then(r => r.json()).then(j => {
        if (j?.errors?.length) {
          console.warn(LOG_PREFIX, `UpdateReceiver follow-up con errors (id=${receiverId}):`, j.errors);
        } else {
          console.log(LOG_PREFIX, `UpdateReceiver follow-up OK: id=${receiverId} receivedAt=${pendingISO}`);
        }
      }).catch(err => {
        console.warn(LOG_PREFIX, `UpdateReceiver follow-up falló (id=${receiverId}):`, err);
      });

      return response;
    };
  }
  function injectStyles() {
    if (document.getElementById('sa-rdo-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-rdo-styles';
    style.textContent = `
      .sa-rdo-wrapper {
        grid-column: 1 / -1;
        flex-basis: 100%;
      }
      .sa-rdo-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .sa-rdo-input {
        border: 1px solid #c4c4c4;
        border-radius: 4px;
        padding: 8.5px 14px;
        font: inherit;
        font-size: 14px;
        background: #fff;
        color: rgba(0,0,0,0.87);
      }
      .sa-rdo-input:focus {
        outline: 2px solid #1976d2;
        outline-offset: -1px;
        border-color: transparent;
      }
      .sa-rdo-chip {
        border: 1px solid rgba(25,118,210,0.5);
        color: #1976d2;
        background: transparent;
        border-radius: 16px;
        padding: 4px 12px;
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
      }
      .sa-rdo-chip:hover {
        background: rgba(25,118,210,0.08);
        border-color: #1976d2;
      }
      .sa-rdo-warning {
        flex-basis: 100%;
        margin-top: 4px;
        font-size: 12px;
        color: #ed6c02;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }
  function todayString(offsetDays = 0) {
    const d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function daysDiff(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    const picked = new Date(y, m - 1, d, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((picked.getTime() - today.getTime()) / 86400000);
  }

  function updateWarning(state) {
    const el = state.warningEl;
    if (!el) return;
    const val = state.input.value;
    if (!val) { el.hidden = true; el.textContent = ''; return; }
    const diff = daysDiff(val);
    if (diff === null) { el.hidden = true; el.textContent = ''; return; }
    if (diff > 0) {
      el.textContent = '⚠️ Fecha de recibo en el futuro';
      el.hidden = false;
    } else if (diff < -7) {
      el.textContent = '⚠️ Fecha real de recibo mayor a una semana';
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function injectField(modal) {
    // Localizar el wrapper de "Receiver Comments:" via su <p>
    const labels = modal.querySelectorAll('p');
    let receiverCommentsWrapper = null;
    for (const p of labels) {
      if (/^receiver\s+comments:?$/i.test(p.textContent.trim())) {
        receiverCommentsWrapper = p.closest('.css-iyrxkt');
        break;
      }
    }
    if (!receiverCommentsWrapper) {
      console.warn(LOG_PREFIX, 'No se localizó el wrapper de Receiver Comments — layout cambió?');
      return;
    }

    // Construir el wrapper nuevo clonando estructura .css-iyrxkt
    const wrapper = document.createElement('div');
    wrapper.className = 'css-iyrxkt sa-rdo-wrapper';
    wrapper.dataset.saRdoField = 'true';

    const label = document.createElement('p');
    label.className = 'MuiTypography-root MuiTypography-body1 css-9l3uo3';
    label.style.gridColumn = '1';
    label.textContent = 'Fecha real de recibido:';
    wrapper.appendChild(label);

    const controls = document.createElement('div');
    controls.style.gridColumn = '2';
    controls.className = 'sa-rdo-controls';

    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'sa-rdo-input';
    input.value = todayString(0);
    controls.appendChild(input);

    const chipHoy = document.createElement('button');
    chipHoy.type = 'button';
    chipHoy.className = 'sa-rdo-chip';
    chipHoy.dataset.offset = '0';
    chipHoy.textContent = 'Hoy';
    controls.appendChild(chipHoy);

    const chipAyer = document.createElement('button');
    chipAyer.type = 'button';
    chipAyer.className = 'sa-rdo-chip';
    chipAyer.dataset.offset = '-1';
    chipAyer.textContent = 'Ayer';
    controls.appendChild(chipAyer);

    const warningEl = document.createElement('div');
    warningEl.className = 'sa-rdo-warning';
    warningEl.hidden = true;
    controls.appendChild(warningEl);

    wrapper.appendChild(controls);
    receiverCommentsWrapper.insertAdjacentElement('afterend', wrapper);

    // Estado por modal
    const state = modalStates.get(modal) || {};
    state.input = input;
    state.warningEl = warningEl;
    state.userTouched = false;
    modalStates.set(modal, state);

    // Tracking de intención
    const markTouched = () => { state.userTouched = true; updateWarning(state); };
    input.addEventListener('input', markTouched);
    input.addEventListener('change', markTouched);

    for (const chip of [chipHoy, chipAyer]) {
      chip.addEventListener('click', () => {
        const offset = parseInt(chip.dataset.offset, 10);
        input.value = todayString(offset);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        markTouched();
      });
    }

    console.log(LOG_PREFIX, 'Campo de fecha inyectado, default=', input.value);
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.ReceiverDateOverride = ReceiverDateOverride;
  ReceiverDateOverride.init();
}
