// Warehouse Location Prefill
// Inyecta un combobox "Ubicación inicial:" en el header del modal Receive Parts
// y, al elegir una ubicación, intercepta CreateReceiverChecked para sobrescribir
// el locationId en todos los receiverBomItems[].inventoryTransferEvent.
// debitAccounts.accounts[]. Deshabilita visualmente los combos per-line via
// overlay CSS mientras hay valor en el header.
//
// 0.6.0 — CANDADO DE UBICACIÓN: el pie del modal no permite guardar hasta que TODOS los
// renglones tengan ubicación inicial (por el combo del encabezado o uno por uno), y dice
// CUÁL renglón falta. Dos capas independientes (ver warehouse-location-guard-core.js):
//   · DOM  → tapa los 3 botones de guardar, tooltip con las líneas pendientes, contador en
//            el pie y marca en naranja el combo de cada renglón que falta.
//   · fetch → si el payload de CreateReceiverChecked llega con accounts sin locationId, la
//            mutación NO sale (Response sintética con errors). Es la red que sobrevive a un
//            cambio de layout o de idioma: convierte una falla silenciosa en ruidosa.

const WarehouseLocationPrefill = (() => {
  'use strict';

  // Gate de ruido en consola (audit #5): sombrea `console` local — log/info se suprimen
  // salvo localStorage.sa_debug==='1'; warn/error siempre visibles.
  const _saDebug = () => { try { return localStorage.getItem('sa_debug') === '1'; } catch (_) { return false; } };
  const console = {
    log:   (...a) => { if (_saDebug()) window.console.log(...a); },
    info:  (...a) => { if (_saDebug()) window.console.info(...a); },
    debug: (...a) => { if (_saDebug()) window.console.debug(...a); },
    warn:  (...a) => window.console.warn(...a),
    error: (...a) => window.console.error(...a),
  };
  const LOG_PREFIX = '[WLP]';
  const api = () => window.SteelheadAPI;
  // Núcleo puro del candado. Si el script no cargó, TODO el candado queda apagado
  // (fail-open) y el applet sigue prellenando como siempre.
  const guard = () => window.WarehouseLocationGuardCore;
  let observerActive = false;

  const modalStates = new WeakMap();

  // Estado compartido entre modal y fetch patch (singleton)
  let pendingLocationId = null;
  let pendingLocationOwner = null;

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;
  const RECEIVER_OP = 'CreateReceiverChecked';
  // Cada cuánto se re-evalúa el candado como red del MutationObserver. Existe porque los
  // cambios que importan (elegir ubicación, teclear el lote) no siempre mutan el DOM que
  // observamos, y porque React puede re-crear el pie y borrar nuestro aviso.
  const GATE_POLL_MS = 900;

  function patchFetch() {
    if (window.__saWlpFetchPatched) return;
    window.__saWlpFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body || typeof opts.body !== 'string') {
        return origFetch.apply(this, args);
      }

      // Bypass baratísimo: si el body ni menciona la mutación, no se parsea.
      if (!opts.body.includes(RECEIVER_OP)) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      if (bodyObj?.operationName !== RECEIVER_OP) {
        return origFetch.apply(this, args);
      }

      // (1) Inyectar el locationId del encabezado, si hay selección.
      let injected = 0;
      if (pendingLocationId) {
        try {
          injected = injectHeaderLocation(bodyObj, pendingLocationId);
          if (injected === 0) {
            console.warn(LOG_PREFIX, 'locationId seleccionado pero el payload no tiene accounts mutables — locationId no aplicado');
          }
        } catch (err) {
          console.warn(LOG_PREFIX, 'Error mutando payload:', err);
          injected = 0;
        }
      }

      // (2) CANDADO. Se juzga el payload YA mutado — o sea lo que de verdad se va a escribir.
      // Solo aplica con NUESTRO modal montado: fuera de él (p.ej. la entrada de recepción con
      // IA) el operador no tiene los combos a la vista y frenarlo lo dejaría sin salida.
      try {
        const G = guard();
        const modal = document.querySelector('[data-sa-wlp-attached="true"]');
        if (G && modal) {
          const verdict = G.payloadMissingLocations(bodyObj);
          if (verdict.checked && verdict.missing.length > 0) {
            const msg = `Bloqueado por la extensión: ${verdict.missing.length} de ${verdict.total} `
              + 'piezas van sin ubicación inicial. Elige la ubicación en cada línea, o usa '
              + '«Ubicación inicial» del encabezado para aplicarla a todas.';
            console.warn(LOG_PREFIX, 'Guardado BLOQUEADO —', verdict.missing.length, 'de', verdict.total, 'accounts sin locationId');
            toast('⛔ ' + msg, true);
            try { evaluateSaveGate(modal); } catch (_) {}
            return new Response(
              JSON.stringify({ errors: [{ message: msg }] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
        }
      } catch (err) {
        // Fail-open a propósito: un error del candado no debe impedir un recibo legítimo.
        console.warn(LOG_PREFIX, 'Error evaluando el candado de ubicación (se deja pasar):', err);
      }

      if (injected > 0) {
        opts.body = JSON.stringify(bodyObj);
        console.log(LOG_PREFIX, `locationId=${pendingLocationId} inyectado en ${injected} accounts`);
        return origFetch.apply(this, [url, opts]);
      }
      return origFetch.apply(this, args);
    };
  }

  // Sobrescribe locationId en todos los debitAccounts del payload. Devuelve cuántos tocó.
  // Se separa del interceptor para que "calcular la mutación" y "commitear opts.body" sigan
  // siendo pasos distintos: si esto truena, el opts original queda intacto.
  function injectHeaderLocation(bodyObj, locationId) {
    const items = bodyObj?.variables?.receiverPayload?.receiverBomItems;
    if (!Array.isArray(items)) return 0;
    let totalAccounts = 0;
    for (const item of items) {
      const accounts = item?.inventoryTransferEvent?.debitAccounts?.accounts;
      if (!Array.isArray(accounts)) continue;
      for (const account of accounts) {
        if (account && typeof account === 'object') {
          account.locationId = locationId;
          totalAccounts++;
        }
      }
    }
    return totalAccounts;
  }

  function init() {
    const disabled = document.documentElement.dataset.saWarehouseLocationPrefillEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

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
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      aduanaError: null,
      fullCache: null,
      fullCacheOffset: 0,
      fullCacheExhausted: false,
      fullCacheLoading: false,
      unusedEnabled: { partGroups: false, container: false },
      gateTimer: null,
      lastGate: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    wireCombobox(modal);
    watchModalRemoval(modal);
    watchLineRows(modal);
    applyUnusedFieldStatesWithRetry(modal);
    // El loader nuevo baja los scripts con un pool de concurrencia, así que el núcleo puede
    // llegar DESPUÉS de este applet: se avisa diferido para no dar una falsa alarma. El poll
    // del candado se instala igual y lo activa en cuanto el núcleo aparece.
    setTimeout(() => {
      if (!guard() && modal.isConnected) {
        console.warn(LOG_PREFIX, 'warehouse-location-guard-core.js no cargó — el candado de guardado queda APAGADO');
      }
    }, 3000);
    evaluateSaveGate(modal);
    startGatePoll(modal);
    preloadAduana(modal);
  }

  async function preloadAduana(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    state.aduanaError = null;
    if (state.dropdown && !state.dropdown.hidden) renderDropdown(state);
    try {
      const nodes = await fetchAduanaLocations();
      state.aduanaCache = nodes;
      console.log(LOG_PREFIX, `Aduana precargada: ${nodes.length} ubicaciones`);
    } catch (err) {
      state.aduanaCache = [];
      state.aduanaError = err;
      console.warn(LOG_PREFIX, 'Error precargando Aduana:', err);
    }
    // Re-render si el dropdown está visible
    if (state.dropdown && !state.dropdown.hidden) renderDropdown(state);
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
    if (state?.rowObserver) state.rowObserver.disconnect();
    if (state?.clearRowTimeout) state.clearRowTimeout();
    if (state?.gateTimer) { clearInterval(state.gateTimer); state.gateTimer = null; }
    if (state?.docClickHandler) document.removeEventListener('mousedown', state.docClickHandler);
    document.getElementById('sa-wlp-gatetip')?.remove();
    modalStates.delete(modal);
    pendingLocationId = null;
    pendingLocationOwner = null;
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  async function fetchAduanaLocations() {
    if (!api()) {
      console.warn(LOG_PREFIX, 'SteelheadAPI no disponible');
      return [];
    }
    try {
      const data = await api().query('SearchLocationsOnPath', {
        fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
        path: '', searchText: '%Aduana%', offset: 0, first: 100,
        subpathOffset: 0, searchTextLast: '%Aduana%',
        archivedIsNull: true, isEmpty: false, includeTypes: true
      }, 'SearchLocationsOnPath');
      return data?.searchLocationsOnPath?.nodes || [];
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error cargando ubicaciones Aduana:', err);
      throw err;
    }
  }

  async function fetchAllLocations(offset = 0, first = 200) {
    if (!api()) {
      console.warn(LOG_PREFIX, 'SteelheadAPI no disponible');
      return [];
    }
    try {
      const data = await api().query('SearchLocationsOnPath', {
        fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
        path: '', searchText: '%', offset, first,
        subpathOffset: 0, searchTextLast: '%',
        archivedIsNull: true, isEmpty: false, includeTypes: true
      }, 'SearchLocationsOnPath');
      return data?.searchLocationsOnPath?.nodes || [];
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error cargando catálogo completo de ubicaciones:', err);
      throw err;
    }
  }

  // Versión del <style>: el remote loader puede reinyectar el script SIN recargar la SPA, y
  // un <style> viejo con el mismo id se quedaría sin las reglas nuevas. Se compara y se
  // escribe el MISMO número (el bug de pn-specs-column 0.3.1 fue subirlo en un solo lado).
  const STYLE_VERSION = '2';

  function injectStyles() {
    const existing = document.getElementById('sa-wlp-styles');
    if (existing) {
      if (existing.dataset.saV === STYLE_VERSION) return;
      existing.remove();
    }
    const style = document.createElement('style');
    style.id = 'sa-wlp-styles';
    style.dataset.saV = STYLE_VERSION;
    style.textContent = `
      .sa-wlp-row-label, .sa-wlp-row-controls { margin-top: 12px; }
      .sa-wlp-controls {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .sa-wlp-combo {
        position: relative; min-width: 320px;
        border: 1px solid #c4c4c4; border-radius: 4px; background: #fff;
      }
      .sa-wlp-combo-input {
        width: 100%; border: 0; outline: 0; background: transparent;
        padding: 8.5px 32px 8.5px 14px; font: inherit; font-size: 14px;
        color: rgba(0,0,0,0.87);
      }
      .sa-wlp-combo:focus-within {
        outline: 2px solid #1976d2; outline-offset: -1px; border-color: transparent;
      }
      .sa-wlp-combo-clear {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        cursor: pointer; color: #888; font-size: 16px; line-height: 1;
        background: transparent; border: 0; padding: 2px 6px;
      }
      .sa-wlp-combo-clear:hover { color: #1976d2; }
      .sa-wlp-dropdown {
        position: absolute; top: 100%; left: 0; right: 0; z-index: 1500;
        background: #fff; border: 1px solid #c4c4c4; border-radius: 4px;
        max-height: 280px; overflow-y: auto; margin-top: 2px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
      }
      .sa-wlp-dropdown[hidden] { display: none; }
      .sa-wlp-option {
        padding: 8px 14px; cursor: pointer; font-size: 14px;
      }
      .sa-wlp-option:hover, .sa-wlp-option[data-active="true"] {
        background: rgba(25,118,210,0.08);
      }
      .sa-wlp-option-empty {
        padding: 8px 14px; font-size: 13px; color: #888; font-style: italic;
      }
      .sa-wlp-option-sentinel {
        padding: 8px 14px; font-size: 13px; color: #1976d2; font-style: italic;
        cursor: pointer; border-top: 1px solid #eee;
      }
      .sa-wlp-option-sentinel:hover { background: rgba(25,118,210,0.08); }
      .sa-wlp-row-overlay {
        position: absolute; inset: 0; display: flex; align-items: center;
        padding: 0 14px; background: rgba(245,245,245,0.92);
        font-size: 13px; color: rgba(0,0,0,0.65); font-style: italic;
        pointer-events: auto; cursor: not-allowed; z-index: 10;
      }
      /* ── Candado de guardado ─────────────────────────────────────────────
         Las reglas cuelgan de atributos NUESTROS (data-sa-wlp-*), no de la
         className del nodo: el className de los botones y de los combos lo
         pinta React y lo reescribiría en el siguiente render. */
      button[data-sa-wlp-blocked="true"] {
        opacity: 0.45 !important; cursor: not-allowed !important;
        filter: grayscale(1);
      }
      [data-sa-wlp-missing="true"] {
        outline: 2px solid #f08c2e !important; outline-offset: 1px;
        border-radius: 4px; background: rgba(240,140,46,0.08) !important;
      }
      .sa-wlp-gate-note {
        display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
        margin-right: auto; padding: 6px 10px; border-radius: 6px;
        background: rgba(240,140,46,0.12); border: 1px solid #f08c2e;
        color: #8a4b06; font-size: 13px; font-weight: 600; line-height: 1.2;
        max-width: 46%;
      }
      .sa-wlp-gate-note:hover { background: rgba(240,140,46,0.22); }
      /* Tooltip propio: DARK MODE porque es UI de la extensión, no de Steelhead
         (regla de diseño del repo — que el operador distinga de un vistazo). */
      #sa-wlp-gatetip {
        position: fixed; z-index: 2147483000; max-width: 460px;
        background: #1c2430; color: #e6e9ee; border: 1px solid #2c3746;
        border-radius: 8px; padding: 10px 12px; font-size: 12.5px;
        line-height: 1.45; white-space: pre-wrap; pointer-events: none;
        box-shadow: 0 10px 28px rgba(0,0,0,0.45); font-family: inherit;
      }
      #sa-wlp-gatetip[hidden] { display: none; }
      #sa-wlp-toast {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        z-index: 2147483000; max-width: 620px;
        background: #1c2430; color: #e6e9ee; border: 1px solid #2c3746;
        border-left: 4px solid #13a36f; border-radius: 8px;
        padding: 12px 16px; font-size: 13px; line-height: 1.45;
        box-shadow: 0 10px 28px rgba(0,0,0,0.45);
      }
      #sa-wlp-toast.err { border-left-color: #e5534b; }
    `;
    document.head.appendChild(style);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    injectStyles();
    let el = document.getElementById('sa-wlp-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-wlp-toast'; document.body.appendChild(el); }
    el.className = isErr ? 'err' : '';
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { document.getElementById('sa-wlp-toast')?.remove(); }, 9000);
  }

  function injectField(modal) {
    if (modal.querySelector('[data-sa-wlp-field="true"]')) return;

    // Anclar dentro del .css-iyrxkt de "Receiver Comments" como rows extra del grid
    const labels = modal.querySelectorAll('p');
    let anchorWrapper = null;
    for (const p of labels) {
      if (/^(?:receiver\s+comments|comentarios\s+del\s+receptor):?$/i.test(p.textContent.trim())) {
        anchorWrapper = p.closest('.css-iyrxkt');
        break;
      }
    }
    if (!anchorWrapper) {
      console.warn(LOG_PREFIX, 'No se localizó el wrapper de Receiver Comments — layout cambió?');
      return;
    }

    const label = document.createElement('p');
    label.className = 'MuiTypography-root MuiTypography-body1 css-9l3uo3 sa-wlp-row-label';
    label.style.gridColumn = '1';
    label.textContent = 'Ubicación inicial:';
    label.dataset.saWlpField = 'true';

    const controls = document.createElement('div');
    controls.style.gridColumn = '2';
    controls.className = 'sa-wlp-controls sa-wlp-row-controls';
    controls.dataset.saWlpField = 'true';

    const combo = document.createElement('div');
    combo.className = 'sa-wlp-combo';
    combo.dataset.saWlpCombo = 'true';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sa-wlp-combo-input';
    input.placeholder = 'Buscar ubicación (filtro: Aduana)';
    input.autocomplete = 'off';
    combo.appendChild(input);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sa-wlp-combo-clear';
    clearBtn.textContent = '✕';
    clearBtn.hidden = true;
    clearBtn.title = 'Limpiar selección';
    combo.appendChild(clearBtn);

    const dropdown = document.createElement('div');
    dropdown.className = 'sa-wlp-dropdown';
    dropdown.hidden = true;
    combo.appendChild(dropdown);

    controls.appendChild(combo);

    anchorWrapper.appendChild(label);
    anchorWrapper.appendChild(controls);

    // Fila extra con checkboxes para re-habilitar Grupo de Piezas / Contenedor
    const toggles = document.createElement('div');
    toggles.style.gridColumn = '2';
    toggles.style.display = 'flex';
    toggles.style.gap = '14px';
    toggles.style.flexWrap = 'wrap';
    toggles.style.marginTop = '6px';
    toggles.style.fontSize = '12px';
    toggles.style.color = 'rgba(0,0,0,0.75)';
    toggles.dataset.saWlpField = 'true';
    toggles.className = 'sa-wlp-unused-toggles';

    for (const cfg of UNUSED_FIELDS) {
      const lab = document.createElement('label');
      lab.style.cursor = 'pointer';
      lab.style.userSelect = 'none';
      lab.style.display = 'inline-flex';
      lab.style.alignItems = 'center';
      lab.style.gap = '4px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = false;
      cb.dataset.saWlpToggleKey = cfg.key;
      cb.style.cursor = 'pointer';
      cb.style.margin = '0';
      cb.addEventListener('change', () => {
        const st = modalStates.get(modal);
        if (!st || !st.unusedEnabled) return;
        st.unusedEnabled[cfg.key] = cb.checked;
        applyUnusedFieldStates(modal);
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' Habilitar ' + cfg.displayLabel));
      toggles.appendChild(lab);
    }
    anchorWrapper.appendChild(toggles);

    // Stash refs en el state
    const state = modalStates.get(modal) || {};
    state.combo = combo;
    state.input = input;
    state.clearBtn = clearBtn;
    state.dropdown = dropdown;
    modalStates.set(modal, state);

    console.log(LOG_PREFIX, 'Combobox de ubicación inyectado');
  }

  function renderDropdown(state) {
    const dd = state.dropdown;
    dd.innerHTML = '';
    const cache = state.aduanaFilterActive ? state.aduanaCache : state.fullCache;
    const search = (state.input.value || '').trim().toLowerCase();

    if (!cache) {
      const empty = document.createElement('div');
      empty.className = 'sa-wlp-option-empty';
      empty.textContent = 'Cargando ubicaciones…';
      dd.appendChild(empty);
      return;
    }

    // Bloque de error con retry (solo en modo Aduana)
    if (state.aduanaFilterActive && state.aduanaError) {
      const errDiv = document.createElement('div');
      errDiv.className = 'sa-wlp-option-empty';
      errDiv.textContent = 'Error al cargar ubicaciones Aduana.';
      dd.appendChild(errDiv);

      const retrySentinel = document.createElement('div');
      retrySentinel.className = 'sa-wlp-option-sentinel';
      retrySentinel.textContent = '🔄 Reintentar';
      retrySentinel.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const modal = findModalForState(state);
        if (modal) preloadAduana(modal);
      });
      dd.appendChild(retrySentinel);
      return;
    }

    const filtered = search
      ? cache.filter(loc => (loc.path || '').toLowerCase().includes(search)
                         || (loc.name || '').toLowerCase().includes(search))
      : cache.slice();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sa-wlp-option-empty';
      empty.textContent = state.aduanaFilterActive
        ? "No se encontraron ubicaciones con 'Aduana'"
        : 'Sin matches';
      dd.appendChild(empty);
    } else {
      for (const loc of filtered) {
        const opt = document.createElement('div');
        opt.className = 'sa-wlp-option';
        opt.textContent = loc.path || loc.name || `(id ${loc.id})`;
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectLocation(state, loc);
        });
        dd.appendChild(opt);
      }
    }

    if (state.aduanaFilterActive) {
      const sentinel = document.createElement('div');
      sentinel.className = 'sa-wlp-option-sentinel';
      sentinel.textContent = '🔄 Mostrar todas las ubicaciones';
      sentinel.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        state.aduanaFilterActive = false;
        if (!state.fullCache) {
          state.input.placeholder = 'Cargando catálogo completo…';
          try {
            const nodes = await fetchAllLocations(0, 200);
            state.fullCache = nodes;
            state.fullCacheOffset = nodes.length;
            state.fullCacheExhausted = nodes.length < 200;
          } catch {
            state.fullCache = [];
            state.fullCacheOffset = 0;
            state.fullCacheExhausted = true;
          }
          state.input.placeholder = 'Buscar ubicación';
        }
        renderDropdown(state);
      });
      dd.appendChild(sentinel);
    } else if (!state.fullCacheExhausted) {
      // Paginación lazy: "Cargar más" solo en modo catálogo completo con más páginas disponibles
      const loadMoreSentinel = document.createElement('div');
      loadMoreSentinel.className = 'sa-wlp-option-sentinel';
      loadMoreSentinel.textContent = '⬇️ Cargar más';
      loadMoreSentinel.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        if (state.fullCacheLoading) return;
        state.fullCacheLoading = true;
        loadMoreSentinel.textContent = 'Cargando…';
        try {
          const next = await fetchAllLocations(state.fullCacheOffset || 0, 200);
          state.fullCache = (state.fullCache || []).concat(next);
          state.fullCacheOffset = state.fullCache.length;
          state.fullCacheExhausted = next.length < 200;
        } catch {
          state.fullCacheExhausted = true;
        } finally {
          state.fullCacheLoading = false;
        }
        renderDropdown(state);
      });
      dd.appendChild(loadMoreSentinel);
    }
  }

  function selectLocation(state, loc) {
    state.selectedLocation = { id: loc.id, path: loc.path || loc.name };
    state.input.value = state.selectedLocation.path;
    state.clearBtn.hidden = false;
    state.dropdown.hidden = true;
    // Actualizar canal modal → fetch patch
    pendingLocationId = loc.id;
    pendingLocationOwner = findModalForState(state);
    console.log(LOG_PREFIX, `Ubicación seleccionada: id=${loc.id} path=${loc.path}`);
    onSelectionChange(state);
  }

  function clearSelection(state) {
    state.selectedLocation = null;
    state.input.value = '';
    state.clearBtn.hidden = true;
    state.aduanaFilterActive = true;
    state.input.placeholder = 'Buscar ubicación (filtro: Aduana)';
    // Limpiar canal modal → fetch patch
    pendingLocationId = null;
    pendingLocationOwner = null;
    console.log(LOG_PREFIX, 'Ubicación limpiada');
    onSelectionChange(state);
  }

  function findLocationCombos(modal) {
    const combos = [];
    const placeholders = modal.querySelectorAll('[id^="react-select-"][id$="-placeholder"]');
    for (const p of placeholders) {
      const txt = p.textContent?.trim() || '';
      if (/^(?:search\s+locations|buscar\s+ubicaciones)/i.test(txt)) {
        const control = p.closest('[class*="-control"]');
        if (control) combos.push(control);
      }
    }
    return combos;
  }

  function disableCombo(control, text, title) {
    title = title || 'Heredada del header. Limpia el campo de arriba para editar este renglón.';
    if (control.dataset.saWlpDisabled === 'true') {
      // Ya disabled — actualizar overlay text/title si cambió
      const existing = control.querySelector('.sa-wlp-row-overlay');
      if (existing) { existing.textContent = text; existing.title = title; }
      return;
    }
    control.dataset.saWlpDisabled = 'true';
    control.style.pointerEvents = 'none';
    control.style.opacity = '0.55';
    control.style.position = 'relative';

    const overlay = document.createElement('div');
    overlay.className = 'sa-wlp-row-overlay';
    overlay.textContent = text;
    overlay.title = title;
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    overlay.addEventListener('mousedown', swallow, true);
    overlay.addEventListener('click', swallow, true);
    overlay.addEventListener('focus', swallow, true);
    control.appendChild(overlay);
  }

  const UNUSED_FIELD_TITLE = 'Campo deshabilitado: marca el check del header para habilitarlo.';
  const UNUSED_FIELD_TEXT = '— Bloqueado —';
  const UNUSED_FIELDS = [
    { key: 'partGroups', displayLabel: 'Grupo de Piezas', label: /^(?:part\s+groups?|grupo\s+de\s+(?:piezas|partes))\s*:?$/i },
    { key: 'container', displayLabel: 'Contenedor', label: /^(?:container|contenedor)\s*:?$/i },
  ];

  function findHeaderComboByLabel(modal, labelRegex) {
    // El text node del label vive dentro de un .css-xd9ivb que suele ser
    // SIBLING (no ancestor) del control react-select, así que iteramos
    // wrappers .css-iyrxkt y para cada uno checamos (a) algún .css-xd9ivb
    // descendiente con text node directo que matchee el label y (b) un
    // [class*="-control"] descendiente. Preferimos el wrapper más profundo
    // (más específico, evita matches espurios cuando hay anidación).
    const wrappers = modal.querySelectorAll('.css-iyrxkt');
    let best = null;
    let bestDepth = -1;
    for (const w of wrappers) {
      const labelBlocks = w.querySelectorAll('.css-xd9ivb');
      let hasLabel = false;
      for (const block of labelBlocks) {
        for (const node of block.childNodes) {
          if (node.nodeType === 3) {
            const t = node.textContent.trim();
            if (t && labelRegex.test(t)) { hasLabel = true; break; }
          }
        }
        if (hasLabel) break;
      }
      if (!hasLabel) continue;
      const control = w.querySelector('[class*="-control"]');
      if (!control) continue;
      let depth = 0; let cur = w;
      while (cur && cur !== modal) { depth++; cur = cur.parentElement; }
      if (depth > bestDepth) { best = control; bestDepth = depth; }
    }
    return best;
  }

  function applyUnusedFieldStates(modal) {
    const state = modalStates.get(modal);
    if (!state || !state.unusedEnabled) return 0;
    let pending = 0;
    for (const cfg of UNUSED_FIELDS) {
      const control = findHeaderComboByLabel(modal, cfg.label);
      if (!control) { pending++; continue; }
      if (state.unusedEnabled[cfg.key]) {
        enableCombo(control);
      } else {
        disableCombo(control, UNUSED_FIELD_TEXT, UNUSED_FIELD_TITLE);
      }
    }
    return pending;
  }

  function applyUnusedFieldStatesWithRetry(modal, attempt = 0) {
    const pending = applyUnusedFieldStates(modal);
    if (pending === 0) return;
    if (attempt >= 8) {
      console.warn(LOG_PREFIX, 'Campos del header no detectados tras retries:', pending);
      return;
    }
    const delay = [100, 200, 400, 800, 1200, 1600, 2000, 2500][attempt] || 2500;
    setTimeout(() => {
      if (modal.isConnected) applyUnusedFieldStatesWithRetry(modal, attempt + 1);
    }, delay);
  }

  function enableCombo(control) {
    if (control.dataset.saWlpDisabled !== 'true') return;
    control.dataset.saWlpDisabled = 'false';
    control.style.pointerEvents = '';
    control.style.opacity = '';
    control.querySelector('.sa-wlp-row-overlay')?.remove();
  }

  function applyDisableState(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    const combos = findLocationCombos(modal);
    if (state.selectedLocation) {
      combos.forEach(c => disableCombo(c, state.selectedLocation.path));
    } else {
      combos.forEach(enableCombo);
    }
    // Re-aplicar estado de campos del header (sobrevive re-renders)
    applyUnusedFieldStates(modal);
  }

  function findModalForState(state) {
    const modal = document.querySelector('[data-sa-wlp-attached="true"]');
    return (modal && modalStates.get(modal) === state) ? modal : null;
  }

  function onSelectionChange(state) {
    const modal = findModalForState(state);
    if (!modal) return;
    applyDisableState(modal);
    evaluateSaveGate(modal);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CANDADO DE GUARDADO — capa DOM
  // Nada aquí escribe si el valor ya es el correcto: el MutationObserver del tbody corre con
  // subtree, así que una escritura incondicional se re-dispararía a sí misma en bucle.
  // ═══════════════════════════════════════════════════════════════════════════

  function setAttrIfNeeded(el, name, value) {
    if (!el) return;
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  // El combo de ubicación VACÍO de un renglón, o null si ya tiene valor. react-select sustituye
  // el placeholder por un singleValue al elegir, así que la presencia del placeholder ES la
  // señal de "vacío" (verificado en vivo con los dos estados).
  function findEmptyLocationCombo(row) {
    const G = guard();
    if (!G) return null;
    for (const ph of row.querySelectorAll('[id$="-placeholder"]')) {
      if (G.isLocationPlaceholder(ph.textContent)) {
        return ph.closest('[class*="-control"]') || ph.parentElement;
      }
    }
    return null;
  }

  // Nombre del número de parte del renglón (best-effort: sirve para NOMBRAR, no para decidir).
  function rowPartName(row) {
    const cell = row.children && row.children[0];
    if (!cell) return null;
    const sv = cell.querySelector('[class*="singleValue"]');
    return sv ? (sv.textContent || '').trim() : null;
  }

  // Nombre del lote recibido. El placeholder real es «ej. LOTE#: 12345»; el "12345" hace el
  // anclaje independiente del idioma y "lot#" cubre el locale inglés.
  function rowBatchName(row) {
    for (const inp of row.querySelectorAll('input')) {
      const ph = inp.placeholder || '';
      if (/lote\s*#|lot\s*#|12345/i.test(ph)) return (inp.value || '').trim() || null;
    }
    return null;
  }

  function collectRowInfo(modal) {
    const rows = [...modal.querySelectorAll('tbody.MuiTableBody-root tr')];
    return rows.map((row, i) => {
      const emptyCombo = findEmptyLocationCombo(row);
      return {
        index: i + 1,
        hasLocation: !emptyCombo,
        part: rowPartName(row),
        batch: rowBatchName(row),
        el: row,
        emptyCombo,
      };
    });
  }

  // Veredicto FRESCO del candado. Devuelve null si el núcleo puro no cargó (candado apagado).
  function computeGate(modal) {
    const G = guard();
    if (!G) return null;
    const state = modalStates.get(modal);
    const rows = collectRowInfo(modal);
    const gate = G.decideSaveGate({
      headerLocation: state?.selectedLocation?.path || null,
      rows,
    });
    gate.rows = rows;
    return gate;
  }

  function evaluateSaveGate(modal) {
    if (!modal || !modal.isConnected) return null;
    const gate = computeGate(modal);
    if (!gate) return null;
    const state = modalStates.get(modal);
    if (state) state.lastGate = gate;
    try { markMissingRows(gate); } catch (err) { console.warn(LOG_PREFIX, 'markMissingRows:', err); }
    try { applyButtonGate(modal, gate); } catch (err) { console.warn(LOG_PREFIX, 'applyButtonGate:', err); }
    try { syncGateNote(modal, gate); } catch (err) { console.warn(LOG_PREFIX, 'syncGateNote:', err); }
    return gate;
  }

  // Se resalta la EXCEPCIÓN (el renglón que FALTA), no la norma — misma lección que
  // surtido-guard 0.2.0: marcar todo deja de ser señal.
  function markMissingRows(gate) {
    for (const row of gate.rows) {
      if (!row || !row.emptyCombo) continue;
      const mark = gate.blocked && !row.hasLocation;
      setAttrIfNeeded(row.emptyCombo, 'data-sa-wlp-missing', mark ? 'true' : null);
    }
  }

  // El pie del modal. Se ancla en el botón de Cancelar y se sube hasta el contenedor que
  // agrupa varios botones: el pie no expone data-steelhead-component-id (verificado en vivo).
  function findFooter(modal) {
    const G = guard();
    if (!G) return null;
    const cancel = [...modal.querySelectorAll('button')].find(b => G.isCancelButtonText(b.textContent));
    let node = cancel ? cancel.parentElement : null;
    for (let i = 0; node && node !== modal && i < 5; i++) {
      const withText = [...node.querySelectorAll('button')].filter(b => (b.textContent || '').trim());
      if (withText.length >= 2) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findSaveButtons(modal) {
    const G = guard();
    if (!G) return [];
    // Sin pie reconocible se acota al modal: es preferible cubrir un botón de más que
    // dejar pasar el guardado (el candado del payload atrapa lo que se escape, igual).
    const scope = findFooter(modal) || modal;
    return [...scope.querySelectorAll('button')].filter(b => G.isSaveButtonText(b.textContent));
  }

  function applyButtonGate(modal, gate) {
    for (const btn of findSaveButtons(modal)) {
      // Si React ya lo tiene deshabilitado (p.ej. falta el cliente), no hay nada que tapar:
      // el motivo es de Steelhead y no debemos atribuirnoslo.
      if (gate.blocked && !btn.disabled) blockSaveButton(btn, gate);
      else unblockSaveButton(btn);
    }
  }

  function blockSaveButton(btn, gate) {
    if (btn.dataset.saWlpTip !== gate.tooltip) btn.dataset.saWlpTip = gate.tooltip;
    // `title` como red de seguridad: si nuestro tooltip no llegara a montarse, el nativo
    // dice lo mismo. Se retira mientras el cursor está encima para no duplicarlos.
    if (btn.dataset.saWlpHover !== 'true' && btn.title !== gate.tooltip) btn.title = gate.tooltip;
    if (btn.dataset.saWlpBlocked === 'true') return;
    btn.dataset.saWlpBlocked = 'true';
    btn.setAttribute('aria-disabled', 'true');
    // Capture EN EL BOTÓN: React escucha en el contenedor raíz durante la fase de burbuja,
    // así que un stopPropagation aquí llega antes y su onClick nunca se dispara. No se usa
    // el atributo `disabled` porque React lo reescribiría en el siguiente render.
    btn.addEventListener('mousedown', swallowSaveEvent, true);
    btn.addEventListener('mouseup', swallowSaveEvent, true);
    btn.addEventListener('click', swallowSaveEvent, true);
    btn.addEventListener('keydown', swallowSaveKey, true);
    btn.addEventListener('mouseenter', onGateHover);
    btn.addEventListener('mouseleave', onGateLeave);
    btn.addEventListener('focus', onGateHover, true);
    btn.addEventListener('blur', onGateLeave, true);
  }

  function unblockSaveButton(btn) {
    if (btn.dataset.saWlpBlocked !== 'true') return;
    delete btn.dataset.saWlpBlocked;
    delete btn.dataset.saWlpTip;
    delete btn.dataset.saWlpHover;
    delete btn.dataset.saWlpTitleHidden;
    btn.removeAttribute('aria-disabled');
    if (btn.title) btn.removeAttribute('title');
    btn.removeEventListener('mousedown', swallowSaveEvent, true);
    btn.removeEventListener('mouseup', swallowSaveEvent, true);
    btn.removeEventListener('click', swallowSaveEvent, true);
    btn.removeEventListener('keydown', swallowSaveKey, true);
    btn.removeEventListener('mouseenter', onGateHover);
    btn.removeEventListener('mouseleave', onGateLeave);
    btn.removeEventListener('focus', onGateHover, true);
    btn.removeEventListener('blur', onGateLeave, true);
    hideGateTip();
  }

  // Antes de tragar el evento se re-mide: si en este instante ya no falta nada, el candado
  // está obsoleto y el clic debe pasar. Vale más un candado que se abre solo que uno que
  // deja al operador atorado con un veredicto viejo.
  function swallowSaveEvent(e) {
    const modal = document.querySelector('[data-sa-wlp-attached="true"]');
    const gate = modal ? computeGate(modal) : null;
    if (!gate || !gate.blocked) {
      if (modal) evaluateSaveGate(modal);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    if (e.type === 'click') {
      showGateTip(e.currentTarget, gate);
      toast('⛔ ' + gate.summary.replace(/^⛔\s*/, '') + '. Elige la ubicación en cada línea, o usa «Ubicación inicial» del encabezado para aplicarla a todas.', true);
    }
  }

  function swallowSaveKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    swallowSaveEvent(e);
  }

  function onGateHover(e) {
    const btn = e.currentTarget;
    btn.dataset.saWlpHover = 'true';
    if (btn.title) { btn.dataset.saWlpTitleHidden = '1'; btn.removeAttribute('title'); }
    const modal = document.querySelector('[data-sa-wlp-attached="true"]');
    const gate = modal ? computeGate(modal) : null;
    if (!gate || !gate.blocked) {
      hideGateTip();
      if (modal) evaluateSaveGate(modal);
      return;
    }
    showGateTip(btn, gate);
  }

  function onGateLeave(e) {
    const btn = e.currentTarget;
    delete btn.dataset.saWlpHover;
    if (btn.dataset.saWlpTitleHidden) {
      delete btn.dataset.saWlpTitleHidden;
      if (btn.dataset.saWlpBlocked === 'true' && btn.dataset.saWlpTip) btn.title = btn.dataset.saWlpTip;
    }
    hideGateTip();
  }

  function showGateTip(btn, gate) {
    if (!btn || !gate?.tooltip) return;
    injectStyles();
    let tip = document.getElementById('sa-wlp-gatetip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'sa-wlp-gatetip';
      document.body.appendChild(tip);
    }
    tip.hidden = false;
    if (tip.textContent !== gate.tooltip) tip.textContent = gate.tooltip;
    // Medir DESPUÉS de escribir el texto, o la altura es la del contenido anterior.
    const r = btn.getBoundingClientRect();
    const th = tip.offsetHeight;
    const tw = tip.offsetWidth;
    let top = r.top - th - 10;
    if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - th - 8);
    let left = r.left + (r.width / 2) - (tw / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    tip.style.top = Math.max(8, top) + 'px';
    tip.style.left = left + 'px';
  }

  function hideGateTip() {
    const tip = document.getElementById('sa-wlp-gatetip');
    if (tip && !tip.hidden) tip.hidden = true;
  }

  // Aviso en el pie: el tooltip requiere hover, y un botón gris sin explicación a la vista
  // se lee como una falla de la extensión. El aviso vive junto a los botones porque ahí es
  // donde el operador mira cuando quiere guardar.
  function syncGateNote(modal, gate) {
    const footer = findFooter(modal);
    if (!footer) return;
    let note = footer.querySelector('.sa-wlp-gate-note');
    if (!gate.blocked) { note?.remove(); return; }
    if (!note) {
      note = document.createElement('div');
      note.className = 'sa-wlp-gate-note';
      note.dataset.saWlpField = 'true';
      note.addEventListener('click', () => scrollToFirstMissing());
      footer.insertBefore(note, footer.firstChild);
    }
    const text = gate.summary + ' · ir a la primera';
    if (note.textContent !== text) note.textContent = text;
    if (note.title !== gate.tooltip) note.title = gate.tooltip;
  }

  function scrollToFirstMissing() {
    const modal = document.querySelector('[data-sa-wlp-attached="true"]');
    if (!modal) return;
    const gate = computeGate(modal);
    const first = gate?.missing?.[0];
    if (!first) return;
    const target = first.emptyCombo || first.el;
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function startGatePoll(modal) {
    const state = modalStates.get(modal);
    if (!state || state.gateTimer) return;
    state.gateTimer = setInterval(() => {
      if (!modal.isConnected) {
        clearInterval(state.gateTimer);
        state.gateTimer = null;
        return;
      }
      evaluateSaveGate(modal);
    }, GATE_POLL_MS);
  }

  function watchLineRows(modal) {
    const tbody = modal.querySelector('tbody.MuiTableBody-root');
    if (!tbody) {
      console.warn(LOG_PREFIX, 'No se encontró tbody.MuiTableBody-root — observer de líneas no instalado');
      return;
    }
    // subtree:true porque el candado necesita ver cuándo un combo PASA de placeholder a
    // singleValue (eso pasa DENTRO del renglón, no en la lista de renglones). Va con debounce
    // y todas las escrituras del candado son idempotentes: si no, se re-dispararía solo.
    let rowTimeout = null;
    const observer = new MutationObserver(() => {
      if (rowTimeout) clearTimeout(rowTimeout);
      rowTimeout = setTimeout(() => {
        if (!modal.isConnected) return;
        applyDisableState(modal);
        evaluateSaveGate(modal);
      }, 150);
    });
    observer.observe(tbody, { childList: true, subtree: true });
    const state = modalStates.get(modal);
    if (state) {
      state.rowObserver = observer;
      state.clearRowTimeout = () => { if (rowTimeout) clearTimeout(rowTimeout); };
    }
  }

  function wireCombobox(modal) {
    const state = modalStates.get(modal);
    if (!state?.input) return;
    const { input, clearBtn, dropdown, combo } = state;

    input.addEventListener('focus', () => {
      dropdown.hidden = false;
      renderDropdown(state);
    });
    input.addEventListener('input', () => {
      if (state.selectedLocation) {
        // El usuario está editando — invalidar selección y limpiar canal de intercepción
        state.selectedLocation = null;
        clearBtn.hidden = true;
        pendingLocationId = null;
        pendingLocationOwner = null;
        const m = findModalForState(state);
        applyDisableState(m);
        if (m) evaluateSaveGate(m);
      }
      dropdown.hidden = false;
      renderDropdown(state);
    });
    input.addEventListener('blur', () => {
      // Pequeño delay para permitir click en option (mousedown corre antes que blur)
      setTimeout(() => { dropdown.hidden = true; }, 150);
    });
    clearBtn.addEventListener('click', () => clearSelection(state));

    // Cerrar dropdown si click fuera — guardamos el listener para cleanup
    const docClickHandler = (e) => {
      if (!combo.contains(e.target)) dropdown.hidden = true;
    };
    document.addEventListener('mousedown', docClickHandler);
    state.docClickHandler = docClickHandler;
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WarehouseLocationPrefill = WarehouseLocationPrefill;
  WarehouseLocationPrefill.init();
}
