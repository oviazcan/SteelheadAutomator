// Weight Quick Entry
// Inyecta campo de peso (KG o LB segun preferencia del cliente) en el modal de Receive Parts
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

  let customerUseLbs = false;
  let lastCustomerId = null;

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

      const reqCid = bodyObj?.variables?.customerId;
      if (reqCid && reqCid !== lastCustomerId) {
        lastCustomerId = reqCid;
      }

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
              const pnStr = pn.stringValue || pn.name || pn.partNumber || '';
              if (pnStr) inventoryItemCache.set('str:' + pnStr.trim().toUpperCase(), invItem.id);
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

  // ── Customer LBS Preference ──

  let customerLbsResolved = false;

  async function resolveCustomerPreference(modal) {
    if (customerLbsResolved) return;
    customerLbsResolved = true;

    const name = extractCustomerName(modal);
    if (!name || name.length < 2) {
      console.log(LOG_PREFIX, 'No se encontro nombre de cliente en modal');
      return;
    }

    try {
      const data = await api().query('CustomerSearchByName',
        { nameLike: `%${name}%`, orderBy: ['NAME_ASC'] }, 'CustomerSearchByName');
      const nodes = data?.searchCustomers?.nodes || data?.allCustomers?.nodes || [];
      const found = nodes.find(c => c.name?.toUpperCase().includes(name.toUpperCase()));

      if (!found) {
        console.log(LOG_PREFIX, `Cliente "${name}" no encontrado en busqueda`);
        return;
      }

      console.log(LOG_PREFIX, `Cliente encontrado: ${found.name}, keys:`, Object.keys(found));

      if (found.customInputs) {
        customerUseLbs = checkLbsPreference(found.customInputs);
        console.log(LOG_PREFIX, `usarLBS=${customerUseLbs} (via SearchByName)`);
        return;
      }

      const displayId = found.idInDomain ?? found.displayId;
      if (displayId != null) {
        try {
          const data2 = await api().query('Customer',
            { idInDomain: parseInt(displayId, 10), includeAccountingFields: false }, 'Customer');
          const cust = data2?.customerByIdInDomain || data2?.customerById;
          if (cust?.customInputs) {
            customerUseLbs = checkLbsPreference(cust.customInputs);
            console.log(LOG_PREFIX, `usarLBS=${customerUseLbs} (via Customer idInDomain=${displayId})`);
            return;
          }
          console.log(LOG_PREFIX, `Customer(${displayId}) sin customInputs, keys:`, cust ? Object.keys(cust) : 'null');
        } catch (err) {
          console.warn(LOG_PREFIX, 'Customer query fallida:', err.message || err);
        }
      } else {
        console.log(LOG_PREFIX, 'CustomerSearchByName no devolvio idInDomain');
      }
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error en resolveCustomerPreference:', err.message || err);
    }
  }

  function checkLbsPreference(customInputs) {
    if (Array.isArray(customInputs)) {
      return customInputs.some(ci => {
        const name = (ci.name || ci.fieldName || ci.label || '').toLowerCase();
        return name.includes('lbs') && (ci.value === true || ci.value === 'true' || ci.textValue === 'true');
      });
    }
    if (typeof customInputs === 'object' && customInputs !== null) {
      return searchObjForLbs(customInputs);
    }
    return false;
  }

  function searchObjForLbs(obj) {
    for (const [key, val] of Object.entries(obj)) {
      const k = key.toLowerCase();
      if (k.includes('lbs') || (k.includes('usar') && k.includes('lb'))) {
        if (val === true || val === 'true') return true;
      }
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        if (searchObjForLbs(val)) return true;
      }
    }
    return false;
  }

  function extractCustomerName(modal) {
    const singleValues = modal.querySelectorAll('[class*="singleValue"]');
    for (const sv of singleValues) {
      const text = sv.textContent?.trim();
      if (text && text.length > 2) return text;
    }
    return null;
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
    interceptSaveButtons(modal);
    watchModalRemoval(modal);

    const ready = resolveCustomerPreference(modal);

    ready.then(() => {
      console.log(LOG_PREFIX, `Inyectando campos (unidad: ${customerUseLbs ? 'LB' : 'KG'})`);
      processExistingLines(modal);
      observeNewLines(modal);
    });
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
    customerLbsResolved = false;
    customerUseLbs = false;
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
        width: 100px;
        font-size: 14px;
        font-family: inherit;
      }
      .sa-wqe-field input:read-only {
        background: #f5f5f5;
        color: #666;
      }
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
    const viewLink = row.querySelector('a[href*="part-numbers/"], a[href*="PartNumbers/"]');
    if (viewLink) {
      const match = viewLink.href.match(/(?:part-numbers|PartNumbers)\/(\d+)/i);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  function resolveInventoryItemId(section) {
    const row = section.row || section.countParent?.closest('tr');

    const pnId = getPartNumberId(section);
    if (pnId) {
      const invId = inventoryItemCache.get(pnId);
      if (invId) return { pnId, inventoryItemId: invId };
      return { pnId, inventoryItemId: null };
    }

    if (row) {
      const firstCell = row.querySelector('td');
      if (firstCell) {
        const pnText = extractPnText(firstCell);
        if (pnText) {
          const invId = inventoryItemCache.get('str:' + pnText.toUpperCase());
          if (invId) {
            console.log(LOG_PREFIX, `Resuelto por texto PN: "${pnText}"`);
            return { pnId: null, inventoryItemId: invId };
          }
        }
      }
    }

    const pnEntries = [];
    for (const [k, v] of inventoryItemCache) {
      if (typeof k === 'string' && k.startsWith('str:')) continue;
      pnEntries.push([k, v]);
    }
    if (pnEntries.length === 1) {
      console.log(LOG_PREFIX, 'Usando unico inventoryItemId cacheado:', pnEntries[0][1]);
      return { pnId: pnEntries[0][0], inventoryItemId: pnEntries[0][1] };
    }

    console.warn(LOG_PREFIX, 'resolveInventoryItemId fallo. Cache keys:', [...inventoryItemCache.keys()]);
    return { pnId: null, inventoryItemId: null };
  }

  function extractPnText(cell) {
    const links = cell.querySelectorAll('a');
    for (const link of links) {
      const text = link.textContent?.trim();
      if (text) {
        const match = text.match(/ver\s+'([^']+)'/i) || text.match(/view\s+'([^']+)'/i);
        if (match) return match[1].trim();
      }
    }
    const singleValue = cell.querySelector('[class*="singleValue"], [class*="SingleValue"]');
    if (singleValue) {
      const text = singleValue.textContent?.trim();
      if (text) return text;
    }
    const inputs = cell.querySelectorAll('input');
    for (const inp of inputs) {
      const val = inp.value?.trim();
      if (val && val.length > 1) return val;
    }
    return null;
  }

  // ── Weight Field Injection ──

  function injectWeightFields(section, modal) {
    if (section.countParent.querySelector('.sa-wqe-container')) return;

    const unitVal = getUnitValue(section);
    if (unitVal && unitVal !== 'Count' && unitVal !== 'Conteo') return;

    const weightUnit = customerUseLbs ? 'LB' : 'KG';

    const container = document.createElement('div');
    container.className = 'sa-wqe-container';
    container.dataset.state = 'empty';

    const header = document.createElement('div');
    header.className = 'sa-wqe-header';
    const headerLabel = document.createElement('span');
    headerLabel.style.color = '#e74c3c';
    headerLabel.textContent = '\u26A1 Peso r\u00e1pido (' + weightUnit + ')';
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

    const weightInput = document.createElement('div');
    weightInput.className = 'sa-wqe-field';
    const label = document.createElement('label');
    label.textContent = `Peso cliente ${weightUnit}:`;
    weightInput.appendChild(label);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = weightUnit === 'KG' ? 'ej: 25' : 'ej: 55';
    input.addEventListener('blur', () => {
      const val = parseFloat(input.value);
      if (input.value && !isNaN(val) && val >= 0) {
        executeMeasurement(container);
      }
    });
    weightInput.appendChild(input);
    fieldsRow.appendChild(weightInput);
    container.appendChild(fieldsRow);

    const hint = document.createElement('div');
    hint.className = 'sa-wqe-hint';
    hint.textContent = 'Tab para registrar \u00b7 Registra KG + LB autom\u00e1ticamente';
    container.appendChild(hint);

    section.countParent.appendChild(container);

    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      const st = lineStates.get(container);
      if (input.value !== '' && !isNaN(val) && val >= 0) {
        container.dataset.state = 'pending';
        if (st) st.status = 'pending';
      } else {
        container.dataset.state = 'empty';
        if (st) st.status = 'empty';
      }
    });

    const state = {
      container,
      weightInput: input,
      weightUnit,
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
        input.readOnly = false;
      }
    });
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

    const inputVal = parseFloat(state.weightInput.value);
    if (state.weightInput.value === '' || isNaN(inputVal) || inputVal < 0) return;

    const KGM_TO_LBR = api()?.getDomain?.()?.conversions?.KGM_TO_LBR || 2.20462;
    const weightKG = state.weightUnit === 'KG' ? inputVal : inputVal / KGM_TO_LBR;

    const resolved = resolveInventoryItemId(state.section);
    let inventoryItemId = resolved.inventoryItemId;
    const pnId = resolved.pnId;

    if (!inventoryItemId && pnId) {
      try {
        setStatus(state, 'executing', 'Buscando PN...');
        const pnData = await api().query('GetPartNumber', { id: pnId }, 'GetPartNumber');
        const invId = pnData?.partNumberById?.inventoryItemByPartNumberId?.id
          || pnData?.partNumber?.inventoryItemByPartNumberId?.id;
        if (invId) {
          inventoryItemCache.set(pnId, invId);
          inventoryItemId = invId;
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Fallback GetPartNumber fallido:', err);
      }
    }

    if (!inventoryItemId) {
      console.warn(LOG_PREFIX, 'No se pudo resolver inventoryItemId. Cache:', [...inventoryItemCache.entries()]);
      setStatus(state, 'error', 'PN no resuelto');
      return;
    }

    setStatus(state, 'executing', 'Registrando...');

    try {
      const domain = api()?.getDomain?.();
      const unitIdKGM = domain?.unitIds?.KGM || 3969;
      const unitIdLBR = domain?.unitIds?.LBR || 3972;

      const factorKGM = weightKG / count;
      const factorLBR = (weightKG * KGM_TO_LBR) / count;

      const unitsData = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
      const existingConversions = unitsData?.inventoryItemById
        ?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];

      await upsertConversion(existingConversions, unitIdKGM, inventoryItemId, factorKGM);
      await upsertConversion(existingConversions, unitIdLBR, inventoryItemId, factorLBR);

      state.weightInput.readOnly = true;
      const factorText = `${factorKGM.toFixed(4)} kg/pz \u00b7 ${factorLBR.toFixed(4)} lb/pz`;
      setStatus(state, 'done', factorText);
      console.log(LOG_PREFIX, `Medicion registrada: inventoryItem=${inventoryItemId} ${factorText}`);

    } catch (err) {
      console.error(LOG_PREFIX, 'Error registrando medicion:', err);
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
      if (state.status === 'pending' && state.weightInput.value) {
        pending.push(container);
      }
    }

    if (pending.length === 0) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    console.log(LOG_PREFIX, `Procesando ${pending.length} mediciones pendientes antes de SAVE`);

    Promise.allSettled(pending.map(c => executeMeasurement(c))).then(results => {
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(LOG_PREFIX, `${failed}/${pending.length} mediciones fallaron, SAVE continua`);
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
