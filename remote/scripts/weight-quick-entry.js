// Weight Quick Entry
// Inyecta campos de peso KG/LB en el modal de Receive Parts
// Ejecuta mediciones via CreateInventoryItemUnitConversion / UpdateInventoryItemUnitConversion
// Depends on: SteelheadAPI

const WeightQuickEntry = (() => {
  'use strict';

  const LOG_PREFIX = '[WQE]';
  const api = () => window.SteelheadAPI;
  let observerActive = false;
  let modalObserver = null;

  const inventoryItemCache = new Map();
  const lineStates = new Map();
  const unitObservers = [];

  function init() {
    const disabled = document.documentElement.dataset.saWeightQuickEntryEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── Fetch Interceptor ──

  function patchFetch() {
    if (window.__saWqeFetchPatched) return;
    window.__saWqeFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      const response = await origFetch.apply(this, args);

      if (bodyObj?.operationName === 'ReceivingPartsPartNumbersQuery') {
        try {
          const clone = response.clone();
          const json = await clone.json();
          const nodes = json?.data?.allPartNumbers?.nodes || [];
          for (const pn of nodes) {
            const invItem = pn.inventoryItemByPartNumberId;
            if (pn.id && invItem?.id) {
              inventoryItemCache.set(pn.id, invItem.id);
            }
          }
          if (nodes.length > 0) {
            console.log(LOG_PREFIX, `Cacheados ${nodes.length} inventoryItemIds`);
          }
        } catch (err) {
          console.warn(LOG_PREFIX, 'Error cacheando inventoryItemIds:', err);
        }
      }

      return response;
    };
  }

  // ── MutationObserver: detect Receive Parts view ──

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
    if (modal.dataset.saWqeAttached) return;
    modal.dataset.saWqeAttached = 'true';
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    processExistingLines(modal);
    observeNewLines(modal);
    interceptSaveButtons(modal);
    watchModalRemoval(modal);
  }

  // ── Modal Cleanup ──

  function watchModalRemoval(modal) {
    const removalObserver = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        removalObserver.disconnect();
        cleanupModal(modal);
      }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
  }

  function cleanupModal(modal) {
    if (modalObserver) { modalObserver.disconnect(); modalObserver = null; }
    if (modal._saWqeSaveObserver) { modal._saWqeSaveObserver.disconnect(); }
    for (const obs of unitObservers) obs.disconnect();
    unitObservers.length = 0;
    for (const [container] of lineStates) {
      if (modal.contains(container)) lineStates.delete(container);
    }
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  // ── Styles ──

  function injectStyles() {
    if (document.getElementById('sa-wqe-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-wqe-styles';
    style.textContent = `
      .sa-wqe-container {
        border: 2px dashed #ccc;
        border-radius: 8px;
        padding: 10px 14px;
        margin-top: 8px;
        background: #fafafa;
        transition: border-color 0.2s, background 0.2s;
      }
      .sa-wqe-container[data-state="pending"] {
        border-color: #e74c3c;
        border-style: dashed;
        background: #fef9f9;
      }
      .sa-wqe-container[data-state="executing"] {
        border-color: #ff9800;
        background: #fff8e1;
        pointer-events: none;
        opacity: 0.7;
      }
      .sa-wqe-container[data-state="done"] {
        border-color: #4CAF50;
        border-style: solid;
        background: #f6fef6;
      }
      .sa-wqe-container[data-state="error"] {
        border-color: #f44336;
        border-style: solid;
        background: #fef0f0;
      }
      .sa-wqe-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .sa-wqe-fields {
        display: flex;
        gap: 12px;
        align-items: flex-end;
      }
      .sa-wqe-field label {
        display: block;
        font-size: 11px;
        color: #666;
        margin-bottom: 3px;
      }
      .sa-wqe-field input {
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 6px 8px;
        width: 80px;
        font-size: 14px;
        font-family: inherit;
      }
      .sa-wqe-field input:disabled {
        background: #f5f5f5;
        color: #999;
      }
      .sa-wqe-field input.sa-wqe-preview {
        color: #999;
        background: #f9f9f9;
      }
      .sa-wqe-btn {
        background: none;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 4px 6px;
        cursor: pointer;
        font-size: 12px;
        color: #e74c3c;
        line-height: 1;
      }
      .sa-wqe-btn:hover { background: #fef0f0; }
      .sa-wqe-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .sa-wqe-hint {
        margin-top: 5px;
        font-size: 10px;
        color: #888;
      }
      .sa-wqe-status {
        font-size: 11px;
        margin-left: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Line Detection & DOM Injection ──

  function processExistingLines(modal) {
    const sections = findQuantitySections(modal);
    for (const section of sections) {
      injectWeightFields(section, modal);
    }
  }

  function observeNewLines(modal) {
    if (modalObserver) modalObserver.disconnect();
    let debounceTimeout = null;
    modalObserver = new MutationObserver(() => {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        const sections = findQuantitySections(modal);
        for (const section of sections) {
          injectWeightFields(section, modal);
        }
      }, 200);
    });
    modalObserver.observe(modal, { childList: true, subtree: true });
  }

  function findQuantitySections(container) {
    const results = [];
    const table = container.querySelector('table.MuiTable-root') || container.querySelector('table');
    if (!table) {
      const ancestor = container.closest?.('table.MuiTable-root') || container.closest?.('table');
      if (ancestor) return findQuantitySectionsInTable(ancestor);
      return results;
    }
    return findQuantitySectionsInTable(table);
  }

  function findQuantitySectionsInTable(table) {
    const results = [];
    const headers = table.querySelectorAll('thead th');
    let colIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      if (/cantidad|quantity/i.test(headers[i].textContent.trim())) {
        colIdx = i;
        break;
      }
    }
    if (colIdx < 0) return results;

    const rows = table.querySelectorAll('tbody > tr');
    for (const row of rows) {
      const cells = row.querySelectorAll(':scope > td');
      const cell = cells[colIdx];
      if (!cell || cell.querySelector('.sa-wqe-container')) continue;

      const inputs = cell.querySelectorAll('input');
      if (inputs.length === 0) continue;

      const countInput = inputs[inputs.length - 1];
      results.push({ countInput, countParent: cell, row, cell });
    }
    return results;
  }

  function getCountValue(countInput) {
    const val = parseFloat(countInput?.value);
    return isNaN(val) || val <= 0 ? 0 : val;
  }

  function getUnitValue(section) {
    const cell = section.cell || section.countParent;
    const inputs = cell.querySelectorAll('input');
    if (inputs.length > 1) {
      return inputs[0].value?.trim() || '';
    }
    return '';
  }

  function getPartNumberId(section) {
    const row = section.row || section.countParent?.closest('tr');
    if (!row) return null;
    const viewLink = row.querySelector('a[href*="part-numbers/"]');
    if (viewLink) {
      const match = viewLink.href.match(/part-numbers\/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  function injectWeightFields(section, modal) {
    if (section.countParent.querySelector('.sa-wqe-container')) return;

    const unitVal = getUnitValue(section);
    if (unitVal && unitVal !== 'Count' && unitVal !== 'Conteo') return;

    const container = document.createElement('div');
    container.className = 'sa-wqe-container';
    container.dataset.state = 'empty';

    const header = document.createElement('div');
    header.className = 'sa-wqe-header';
    const headerLabel = document.createElement('span');
    headerLabel.style.color = '#e74c3c';
    headerLabel.textContent = '\u26A1 Peso r\u00e1pido';
    const headerSub = document.createElement('span');
    headerSub.style.cssText = 'font-weight:400; color:#999; font-size:10px;';
    headerSub.textContent = '(SteelheadAutomator)';
    header.appendChild(headerLabel);
    header.appendChild(headerSub);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'sa-wqe-status';
    header.appendChild(statusSpan);

    container.appendChild(header);

    const fieldsRow = document.createElement('div');
    fieldsRow.className = 'sa-wqe-fields';

    const kgField = createWeightField('KG', section, container, statusSpan, modal);
    fieldsRow.appendChild(kgField.wrapper);

    const lbField = createWeightField('LB', section, container, statusSpan, modal);
    fieldsRow.appendChild(lbField.wrapper);

    container.appendChild(fieldsRow);

    const hint = document.createElement('div');
    hint.className = 'sa-wqe-hint';
    hint.textContent = 'Tab para registrar \u00b7 Factor: peso \u00f7 count';
    container.appendChild(hint);

    section.countParent.appendChild(container);

    const KGM_TO_LBR = api()?.getDomain?.()?.conversions?.KGM_TO_LBR || 2.20462;

    kgField.input.addEventListener('input', () => {
      const kgVal = parseFloat(kgField.input.value);
      const st = lineStates.get(container);
      if (kgField.input.value !== '' && !isNaN(kgVal) && kgVal >= 0) {
        lbField.input.value = (kgVal * KGM_TO_LBR).toFixed(2);
        lbField.input.classList.add('sa-wqe-preview');
        lbField.input.disabled = true;
        container.dataset.state = 'pending';
        if (st) st.status = 'pending';
      } else {
        lbField.input.value = '';
        lbField.input.classList.remove('sa-wqe-preview');
        lbField.input.disabled = false;
        container.dataset.state = 'empty';
        if (st) st.status = 'empty';
      }
    });

    lbField.input.addEventListener('input', () => {
      const lbVal = parseFloat(lbField.input.value);
      const st = lineStates.get(container);
      if (lbField.input.value !== '' && !isNaN(lbVal) && lbVal >= 0) {
        kgField.input.value = (lbVal / KGM_TO_LBR).toFixed(3);
        kgField.input.classList.add('sa-wqe-preview');
        kgField.input.disabled = true;
        container.dataset.state = 'pending';
        if (st) st.status = 'pending';
      } else {
        kgField.input.value = '';
        kgField.input.classList.remove('sa-wqe-preview');
        kgField.input.disabled = false;
        container.dataset.state = 'empty';
        if (st) st.status = 'empty';
      }
    });

    const state = {
      container,
      kgInput: kgField.input,
      lbInput: lbField.input,
      statusSpan,
      section,
      status: 'empty'
    };
    lineStates.set(container, state);

    watchUnitChanges(section, container);

    section.countInput.addEventListener('input', () => {
      if (state.status === 'done') {
        state.status = 'pending';
        container.dataset.state = 'pending';
        statusSpan.textContent = '\u23F3 Recalcular';
        statusSpan.style.color = '#ff9800';
        kgField.input.readOnly = false;
        lbField.input.readOnly = false;
      }
    });
  }

  function createWeightField(unit, section, container, statusSpan, modal) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sa-wqe-field';

    const label = document.createElement('label');
    label.textContent = `Peso cliente ${unit}:`;
    wrapper.appendChild(label);

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex; align-items:center; gap:4px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = unit === 'KG' ? 'ej: 25' : 'ej: 55';
    input.setAttribute('data-unit', unit);

    input.addEventListener('blur', () => {
      if (input.value && !input.classList.contains('sa-wqe-preview')) {
        executeMeasurement(container);
      }
    });

    inputRow.appendChild(input);

    const btn = document.createElement('button');
    btn.className = 'sa-wqe-btn';
    btn.textContent = '\u26A1';
    btn.title = 'Registrar ahora';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      executeMeasurement(container);
    });
    inputRow.appendChild(btn);

    wrapper.appendChild(inputRow);
    return { wrapper, input, btn };
  }

  function watchUnitChanges(section, container) {
    const cell = section.cell || section.countParent;
    if (!cell) return;

    const unitObserver = new MutationObserver(() => {
      const unitVal = getUnitValue(section);
      if (unitVal && unitVal !== 'Count' && unitVal !== 'Conteo') {
        container.style.display = 'none';
      } else {
        container.style.display = '';
      }
    });
    unitObserver.observe(cell, { childList: true, subtree: true, characterData: true, attributes: true });
    unitObservers.push(unitObserver);
  }

  // ── Measurement Execution ──

  async function executeMeasurement(container) {
    const state = lineStates.get(container);
    if (!state) return;
    if (state.status === 'executing' || state.status === 'done') return;

    const count = getCountValue(state.section.countInput);
    if (count <= 0) {
      setStatus(state, 'error', 'Count debe ser > 0');
      return;
    }

    const kgVal = parseFloat(state.kgInput.value);
    const lbVal = parseFloat(state.lbInput.value);
    const kgIsPrimary = !state.kgInput.classList.contains('sa-wqe-preview');

    let weightKG;
    if (kgIsPrimary && state.kgInput.value !== '' && !isNaN(kgVal) && kgVal >= 0) {
      weightKG = kgVal;
    } else if (state.lbInput.value !== '' && !isNaN(lbVal) && lbVal >= 0) {
      const KGM_TO_LBR = api()?.getDomain?.()?.conversions?.KGM_TO_LBR || 2.20462;
      weightKG = lbVal / KGM_TO_LBR;
    } else {
      return;
    }

    const pnId = getPartNumberId(state.section);
    let inventoryItemId = pnId ? inventoryItemCache.get(pnId) : null;

    if (!inventoryItemId) {
      setStatus(state, 'error', 'PN no resuelto');
      return;
    }

    setStatus(state, 'executing', 'Registrando...');

    try {
      const domain = api()?.getDomain?.();
      const KGM_TO_LBR = domain?.conversions?.KGM_TO_LBR || 2.20462;
      const unitIdKGM = domain?.unitIds?.KGM || 3969;
      const unitIdLBR = domain?.unitIds?.LBR || 3972;

      const factorKGM = weightKG / count;
      const factorLBR = (weightKG * KGM_TO_LBR) / count;

      const unitsData = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
      const existingConversions = unitsData?.inventoryItemById
        ?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];

      await upsertConversion(existingConversions, unitIdKGM, inventoryItemId, factorKGM);
      await upsertConversion(existingConversions, unitIdLBR, inventoryItemId, factorLBR);

      state.kgInput.value = weightKG.toFixed(3);
      state.kgInput.readOnly = true;
      const lbEquiv = weightKG * KGM_TO_LBR;
      state.lbInput.value = lbEquiv.toFixed(2);
      state.lbInput.readOnly = true;
      state.lbInput.classList.add('sa-wqe-preview');

      const factorText = `${factorKGM.toFixed(4)} kg/pz \u00b7 ${factorLBR.toFixed(4)} lb/pz`;
      setStatus(state, 'done', factorText);
      console.log(LOG_PREFIX, `Medici\u00f3n registrada: inventoryItem=${inventoryItemId} ${factorText}`);

    } catch (err) {
      console.error(LOG_PREFIX, 'Error registrando medici\u00f3n:', err);
      setStatus(state, 'error', err.message || 'Error de red');
    }
  }

  async function upsertConversion(existingConversions, unitId, inventoryItemId, factor) {
    const existing = existingConversions.find(c => {
      return Number(c.unitByUnitId?.id) === Number(unitId);
    });

    if (existing) {
      await api().query('UpdateInventoryItemUnitConversion',
        { id: existing.id, factor },
        'UpdateInventoryItemUnitConversion'
      );
    } else {
      await api().query('CreateInventoryItemUnitConversion',
        { unitId, inventoryItemId, factor },
        'CreateInventoryItemUnitConversion'
      );
    }
  }

  function setStatus(state, status, message) {
    state.status = status;
    state.container.dataset.state = status;
    if (status === 'done') {
      state.statusSpan.textContent = '\u2705 ' + message;
      state.statusSpan.style.color = '#4CAF50';
    } else if (status === 'error') {
      state.statusSpan.textContent = '\u274C ' + message;
      state.statusSpan.style.color = '#f44336';
    } else if (status === 'executing') {
      state.statusSpan.textContent = '\u23F3 ' + message;
      state.statusSpan.style.color = '#ff9800';
    } else if (status === 'pending') {
      state.statusSpan.textContent = '\u23F3 pendiente';
      state.statusSpan.style.color = '#999';
    } else {
      state.statusSpan.textContent = '';
    }
  }

  // ── SAVE Button Interception ──

  function interceptSaveButtons(modal) {
    const attachToSaveButtons = () => {
      const buttons = modal.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toUpperCase() || '';
        const isSaveBtn = text === 'SAVE' || text.startsWith('SAVE +') || text.startsWith('SAVE &')
          || text === 'GUARDAR' || text.startsWith('GUARDAR +') || text.startsWith('GUARDAR Y');
        if (isSaveBtn && !btn.dataset.saWqeIntercepted) {
          btn.dataset.saWqeIntercepted = 'true';
          btn.addEventListener('click', handleSaveClick, true);
        }
      }
    };

    const observer = new MutationObserver(attachToSaveButtons);
    observer.observe(modal, { childList: true, subtree: true });
    modal._saWqeSaveObserver = observer;

    attachToSaveButtons();
  }

  function handleSaveClick(e) {
    const btn = e.currentTarget;
    if (btn.dataset.saWqeBypass) return;

    const pending = [];
    for (const [container, state] of lineStates) {
      if (state.status === 'pending') {
        const hasKg = state.kgInput.value && !state.kgInput.classList.contains('sa-wqe-preview');
        const hasLb = state.lbInput.value && !state.lbInput.classList.contains('sa-wqe-preview');
        if (hasKg || hasLb) {
          pending.push(container);
        }
      }
    }

    if (pending.length === 0) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    console.log(LOG_PREFIX, `Procesando ${pending.length} mediciones pendientes antes de SAVE`);

    Promise.allSettled(pending.map(c => executeMeasurement(c))).then(results => {
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(LOG_PREFIX, `${failed}/${pending.length} mediciones fallaron, SAVE contin\u00faa`);
      }
      btn.dataset.saWqeBypass = 'true';
      btn.click();
      delete btn.dataset.saWqeBypass;
    });
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WeightQuickEntry = WeightQuickEntry;
  WeightQuickEntry.init();
}
