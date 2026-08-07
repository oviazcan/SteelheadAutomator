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
    startDetectPoll();
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

  function resolveContainer(el) {
    return el.closest('[role="dialog"]')
      || el.closest('.MuiDialog-paper')
      || el.closest('[class*="MuiPaper"]')
      || el.closest('main')
      || el.closest('form')
      || el.parentElement?.parentElement
      || null;
  }

  // No se rinde en el PRIMER candidato. Antes hacía `return` en cuanto resolvía un contenedor,
  // montara o no: si el primer heading que matchea resuelve un contenedor equivocado (el
  // `HEADING_SELECTOR` es amplio y el orden de documento no es una garantía), el applet
  // reintentaba eternamente con ESE y nunca llegaba al modal bueno — falla permanente que
  // depende del orden del DOM, o sea intermitente entre equipos. Ahora sigue con los demás.
  function scanForReceiveView() {
    const containers = [];
    for (const el of document.querySelectorAll(HEADING_SELECTOR)) {
      if (!VIEW_REGEX.test(el.textContent?.trim())) continue;
      const c = resolveContainer(el);
      if (c && !containers.includes(c)) containers.push(c);
    }
    const Anchor = window.ReceiveModalAnchorCore;
    return Anchor?.firstMounted
      ? !!Anchor.firstMounted(containers, onModalFound)
      : containers.some(c => onModalFound(c));
  }

  // Red de seguridad: el mismo poll acotado que `weight-quick-entry` corre en ESTE MISMO modal
  // en producción. El `MutationObserver` no es un vigilante continuo — dispara en eventos
  // discretos: medido el 2026-08-07 en las pantallas de esta familia, **0 mutaciones de
  // `childList` en el body durante 6 s** con un modal abierto. Si el único disparo cae cuando
  // el modal está a medio montar (lo normal en un equipo lento: el encabezado se llena tras la
  // respuesta de red), `injectField` falla, correctamente NO pone el latch… y nadie vuelve a
  // llamar. Ése es el "a veces no sale el campo de fecha" que no se reproduce en una máquina
  // rápida, donde el modal se monta entero dentro de la misma ráfaga.
  //
  // El tick es barato a propósito: los diálogos abiertos que aún no llevan nuestro marcador —y
  // casi siempre no hay ninguno, así que se reduce a un querySelectorAll por atributo.
  const DETECT_POLL_MS = 1000;
  let detectPollTimer = null;

  function detectTick() {
    const dialogs = document.querySelectorAll('[role="dialog"]:not([data-sa-rdo-attached="true"])');
    if (!dialogs.length) return;
    for (const dlg of dialogs) {
      for (const el of dlg.querySelectorAll(HEADING_SELECTOR)) {
        if (!VIEW_REGEX.test((el.textContent || '').trim())) continue;
        if (onModalFound(dlg)) return;
        break;   // este diálogo no montó; probamos el siguiente, no otro heading del mismo
      }
    }
  }

  function startDetectPoll() {
    if (detectPollTimer) return;
    detectPollTimer = setInterval(() => {
      try { detectTick(); } catch (err) {
        console.warn(LOG_PREFIX, 'Error en el poll de detección:', err);
      }
    }, DETECT_POLL_MS);
  }

  // Devuelve si el campo quedó MONTADO (no si se intentó): de eso depende que el scan siga
  // probando candidatos y que el poll vuelva a intentarlo en el siguiente tick.
  function onModalFound(modal) {
    if (modal.dataset.saRdoAttached === 'true') return true;
    modalStates.set(modal, {});  // initialize empty state before any downstream code runs
    injectStyles();

    // El latch se pone SÓLO si el campo quedó montado. Antes se ponía aquí arriba, así que
    // un fallo del anclaje se volvía permanente: el observer volvía a pasar, veía el latch y
    // se iba. Eso convirtió el rehash de emotion del 2026-08-03 en "la fecha desapareció"
    // en vez de "la fecha tardó un render en aparecer". Si no montó, se reintenta.
    if (!injectField(modal)) return false;

    modal.dataset.saRdoAttached = 'true';
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    watchModalRemoval(modal);
    return true;
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
          const timeStr = state.timeInput?.value || '12:00';
          const [hh, mm] = timeStr.split(':').map(Number);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            pendingISO = new Date(y, m - 1, d, isNaN(hh) ? 12 : hh, isNaN(mm) ? 0 : mm, 0).toISOString();
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
      .sa-rdo-row-label, .sa-rdo-row-controls {
        margin-top: 12px;
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

  // Devuelve true si el campo quedó montado. El booleano importa: de él depende que el
  // latch de onModalFound no congele un fallo de anclaje (ver ahí).
  function injectField(modal) {
    if (modal.querySelector('[data-sa-rdo-field="true"]')) return true;

    // Se ENTRA por el label "Cliente:" / "Customer:" (ES+EN) y se SUBE por estructura.
    // Hasta el 2026-08-03 aquí decía `p.closest('.css-iyrxkt')`: una clase GENERADA por
    // emotion, que SH rehasheó al pasar el encabezado de grid a flex. Dejó de existir y
    // este `return` se disparaba en silencio — el campo de fecha simplemente no aparecía.
    const Anchor = window.ReceiveModalAnchorCore;
    if (!Anchor) {
      warnOnce(modal, 'Falta receive-modal-anchor-core — no se puede anclar');
      return false;
    }
    const labelNode = Anchor.findLabelNode(modal, Anchor.LABEL_CUSTOMER);
    const anchor = labelNode && Anchor.findHeaderFieldAnchor(labelNode);
    if (!anchor) {
      warnOnce(modal, 'No se localizó el wrapper de Cliente — layout cambió?');
      return false;
    }

    const label = document.createElement('p');
    // La clase se HEREDA del label vecino vivo: así el próximo rehash de emotion nos sigue
    // vistiendo igual que a SH, en vez de dejarnos con un nombre de clase muerto.
    label.className = `${anchor.labelClass} sa-rdo-row-label`.trim();
    label.textContent = 'Fecha real de recibido:';
    label.dataset.saRdoField = 'true';

    const controls = document.createElement('div');
    controls.className = 'sa-rdo-controls sa-rdo-row-controls';
    controls.dataset.saRdoField = 'true';

    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'sa-rdo-input';
    input.value = todayString(0);
    controls.appendChild(input);

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'sa-rdo-input sa-rdo-time';
    timeInput.value = '12:00';
    controls.appendChild(timeInput);

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

    const host = Anchor.mountHeaderField(document, anchor, label, controls);
    if (!host) {
      warnOnce(modal, 'No se pudo montar el campo de fecha');
      return false;
    }
    host.dataset.saRdoField = 'true';

    // Estado por modal
    const state = modalStates.get(modal) || {};
    state.input = input;
    state.timeInput = timeInput;
    state.warningEl = warningEl;
    state.userTouched = false;
    modalStates.set(modal, state);

    // Tracking de intención
    const markTouched = () => { state.userTouched = true; updateWarning(state); };
    input.addEventListener('input', markTouched);
    input.addEventListener('change', markTouched);
    timeInput.addEventListener('input', markTouched);
    timeInput.addEventListener('change', markTouched);

    for (const chip of [chipHoy, chipAyer]) {
      chip.addEventListener('click', () => {
        const offset = parseInt(chip.dataset.offset, 10);
        input.value = todayString(offset);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        markTouched();
      });
    }

    console.log(LOG_PREFIX, 'Campo de fecha inyectado, default=', input.value);
    return true;
  }

  // Un aviso por modal: sin el latch, el observer reintenta en cada mutación y un warn por
  // pasada llenaría la consola justo cuando hace falta leerla para diagnosticar.
  function warnOnce(modal, msg) {
    if (modal.dataset.saRdoWarned === 'true') return;
    modal.dataset.saRdoWarned = 'true';
    console.warn(LOG_PREFIX, msg);
  }

  // `scanForReceiveView`/`detectTick` se exportan para poder DIAGNOSTICAR desde la consola del
  // operador: invocarlos a mano distingue "no se dispara" de "no encuentra el ancla" — que fue
  // exactamente lo que destrabó el caso gemelo de `create-order-autofill`.
  return { init, scanForReceiveView, detectTick };
})();

if (typeof window !== 'undefined') {
  window.ReceiverDateOverride = ReceiverDateOverride;
  ReceiverDateOverride.init();
}
