// Bill Autofill
// Auto-rellena Cuenta AP, Divisa, Tipo de Cambio y Cuentas de Gasto en Create/Edit Bill
// Intercepta GraphQL para capturar datos del PO, infiere cuentas por nombre, aprende de selecciones previas
// Depends on: SteelheadAPI

const BillAutofill = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  const EXPENSE_MAPPING_KEY = 'sa_bill_expense_mapping';
  const BILL_URL_RE = /\/Domains\/\d+\/Bills(?:\/|$)/;

  let debounceTimer = null;
  let state = {
    vendorName: null,
    currency: null,
    exchangeRate: null,
    apAccount: null,
    lineAccounts: [],
    ready: false,
    poDivisa: null,
    poLineItems: [],
    existingInputs: null
  };

  // ── Init ──

  function init() {
    if (window.__saBillAutofillVersion) return;
    window.__saBillAutofillVersion = true;
    if (document.documentElement.dataset.saBillAutofillEnabled === 'false') {
      log('BillAutofill deshabilitado');
      return;
    }
    patchFetch();
    setupUrlListener();
    checkUrl();
    log('BillAutofill inicializado');
  }

  // ── URL Listener ──

  function setupUrlListener() {
    if (window.__saBillAutofillHistoryPatched) return;
    window.__saBillAutofillHistoryPatched = true;
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
    if (!BILL_URL_RE.test(location.pathname)) {
      removePanel();
      return;
    }
    setupPageObserver();
  }

  // ── Page Observer ──

  function setupPageObserver() {
    if (window.__saBillAutofillObserverActive) return;
    window.__saBillAutofillObserverActive = true;

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanForBillPage, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForBillPage();
  }

  let billFormVisible = false;
  let lastDetectedVendor = null;
  let lastDetectedDivisa = null;
  let lastLineCount = -1;
  let autofillRunning = false;

  function scanForBillPage() {
    const headings = document.querySelectorAll('h1, h2, h3, h4, [class*="MuiTypography"], [class*="heading"], [class*="title"]');
    let found = false;
    for (const h of headings) {
      if (/create\s+bill|edit\s+bill/i.test(h.textContent?.trim())) {
        found = true;
        break;
      }
    }

    if (!found) {
      if (billFormVisible) {
        billFormVisible = false;
        lastDetectedVendor = null;
        lastDetectedDivisa = null;
        lastLineCount = -1;
        removePanel();
      }
      return;
    }

    if (!billFormVisible) {
      billFormVisible = true;
      lastDetectedVendor = null;
      lastDetectedDivisa = null;
      lastLineCount = -1;
      log('Pantalla Bill detectada');
      state = { vendorName: null, currency: null, exchangeRate: null, apAccount: null, lineAccounts: [], ready: false, poDivisa: null, poLineItems: [], existingInputs: null };
      renderPanel();
    }

    const currentVendor = extractVendorFromDOM();
    if (currentVendor && currentVendor !== lastDetectedVendor) {
      lastDetectedVendor = currentVendor;
      lastDetectedDivisa = null;
      lastLineCount = -1;
      log(`Vendor detectado/cambiado: ${currentVendor}`);
      state.ready = false;
      runAutofill();
      return;
    } else if (!currentVendor && !lastDetectedVendor) {
      updatePanelStatus('pending', 'Esperando selección de proveedor…');
      return;
    }

    // Monitor divisa changes
    const currentDivisa = extractDivisaFromDOM();
    if (currentDivisa && currentDivisa !== lastDetectedDivisa && lastDetectedVendor) {
      lastDetectedDivisa = currentDivisa;
      log(`Divisa cambiada en form: ${currentDivisa}`);
      state.ready = false;
      runAutofill();
      return;
    }

    // Monitor line item changes
    if (lastDetectedVendor && state.ready) {
      const lines = extractLinesFromDOM();
      if (lines.length !== lastLineCount) {
        lastLineCount = lines.length;
        if (lines.length > 0) {
          log(`Líneas cambiaron: ${lines.length}`);
          state.ready = false;
          runAutofill();
        }
      }
    }
  }

  // ── Fetch Interceptor ──

  function patchFetch() {
    if (window.__saBillAutofillFetchPatched) return;
    window.__saBillAutofillFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      const opName = bodyObj?.operationName;

      // Intercept outgoing CreateUpdateBill — inject missing accounting data
      if (opName === 'CreateUpdateBill' && state.ready) {
        try {
          const bill = bodyObj.variables?.billPayload || bodyObj.variables?.input || bodyObj.variables;
          if (bill) {
            if (!bill.customInputs) bill.customInputs = {};
            if (!bill.customInputs.DatosContables) bill.customInputs.DatosContables = {};
            const ci = bill.customInputs.DatosContables;

            let modified = false;
            if (!ci.Divisa && state.currency) { ci.Divisa = state.currency; modified = true; }
            if (!ci.exchangeRate && state.exchangeRate != null) { ci.exchangeRate = String(state.exchangeRate); modified = true; }
            if (modified) {
              args[1] = { ...opts, body: JSON.stringify(bodyObj) };
              log(`Inyectado: Divisa=${ci.Divisa}, TC=${ci.exchangeRate}`);
            }
          }
        } catch (err) {
          warn('Error modificando CreateUpdateBill: ' + err.message);
        }
      }

      const response = await origFetch.apply(this, args);

      // Intercept incoming responses
      try {
        const clone = response.clone();
        const json = await clone.json();
        handleIncomingResponse(opName, json, bodyObj);
      } catch (_) {}

      return response;
    };
  }

  function handleIncomingResponse(opName, json, bodyObj) {
    if (!json?.data) return;

    if (opName === 'SearchPurchaseOrdersForBill' || opName === 'GetPurchaseOrdersDataForBill') {
      const pos = json.data?.searchPurchaseOrders?.nodes
        || json.data?.allPurchaseOrders?.nodes
        || [];
      if (pos.length > 0) {
        const lines = pos.flatMap(po => po?.purchaseOrderLinesByPurchaseOrderId?.nodes || []);
        if (lines.length > 0) state.poLineItems = lines;
        // These queries don't expose customInputs — extract idInDomain and fetch PO detail
        const firstPo = pos[0];
        if (firstPo?.idInDomain && !state.poDivisa) {
          fetchPODivisa(firstPo.idInDomain).then(divisa => {
            if (divisa) {
              state.poDivisa = divisa;
              log(`PO Divisa obtenida: ${divisa}`);
              if (state.ready) { state.currency = divisa; renderPanel(); }
            }
          });
        }
      }
    }

    if (opName === 'GetBillByIdInDomain') {
      const bill = json.data?.billByIdInDomain;
      if (bill) {
        state.existingInputs = bill.customInputs || null;
        const divisa = bill.customInputs?.DatosContables?.Divisa;
        if (divisa && !state.poDivisa) state.poDivisa = divisa;
      }
    }

    // Learn from successful bill saves — use the SENT payload, not the response
    if (opName === 'CreateUpdateBill' && !json.errors) {
      learnFromSave(bodyObj);
    }
  }

  function learnFromSave(bodyObj) {
    const bill = bodyObj?.variables?.billPayload || bodyObj?.variables?.input || bodyObj?.variables;
    if (!bill) return;

    const billLines = bill?.billLines || [];
    const journal = bill?.journalEntryData?.lines || [];
    if (billLines.length === 0 && journal.length === 0) return;

    // Build a map of accountId → accountName from journal lines
    const accountMap = {};
    for (const jl of journal) {
      if (jl.accountId) accountMap[jl.accountId] = true;
    }

    loadExpenseMapping().then(mapping => {
      let changed = false;
      for (const bl of billLines) {
        const name = bl?.name || '';
        if (!name) continue;

        // Each billLine may have billLineItems with expense info
        for (const item of (bl?.billLineItems || [])) {
          const accountId = item?.expenseAccountId || item?.accountId;
          if (!accountId) continue;

          const key = normalizeForMatch(name);
          const existing = mapping[key];
          if (!existing || existing.accountId !== accountId) {
            mapping[key] = { accountId, accountName: name, count: (existing?.count || 0) + 1, lastUsed: Date.now() };
            changed = true;
          } else {
            mapping[key].count = (existing.count || 0) + 1;
            mapping[key].lastUsed = Date.now();
            changed = true;
          }
        }
      }

      if (changed) {
        saveExpenseMapping(mapping);
        log(`Aprendizaje: ${Object.keys(mapping).length} mapeos guardados`);
      }
    });
  }

  // ── Data Fetching ──

  async function fetchExchangeRate() {
    const data = await api().query('GetDomain', {}, 'GetDomain');
    const tipoCambio = data?.currentSession?.userByUserId?.domainByDomainId?.customInputs?.TipoCambio
      || data?.domain?.customInputs?.TipoCambio
      || [];
    if (!Array.isArray(tipoCambio) || tipoCambio.length === 0) {
      warn('TipoCambio no encontrado en dominio');
      return null;
    }

    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = tipoCambio.find(e => e.fecha === today);
    if (todayEntry) return todayEntry.valor;

    // Most recent entry
    const sorted = [...tipoCambio].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    return sorted[0]?.valor ?? null;
  }

  async function fetchAccounts() {
    const data = await api().query('GetAccountDataForBill', {}, 'GetAccountDataForBill');
    return data?.allAcctAccounts?.nodes || [];
  }

  async function fetchPODivisa(idInDomain) {
    try {
      const data = await api().query('GetPurchaseOrder', { idInDomain, userIdFilter: null }, 'GetPurchaseOrder');
      const po = data?.purchaseOrderByIdInDomain;
      const divisa = po?.customInputs?.DatosReferencia?.Divisa || po?.customInputs?.Divisa || null;

      // Alternative exchange rate from PO domain
      if (!state.exchangeRate) {
        const tipoCambio = po?.domainByDomainId?.customInputs?.TipoCambio;
        if (Array.isArray(tipoCambio) && tipoCambio.length > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const entry = tipoCambio.find(e => e.fecha === today) || tipoCambio.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))[0];
          if (entry?.valor) state.exchangeRate = entry.valor;
        }
      }

      return divisa;
    } catch (err) {
      warn('fetchPODivisa error: ' + err.message);
      return null;
    }
  }

  // ── Expense Mapping Storage (localStorage — runs in MAIN world) ──

  function loadExpenseMapping() {
    return new Promise(resolve => {
      try {
        resolve(JSON.parse(localStorage.getItem(EXPENSE_MAPPING_KEY) || '{}'));
      } catch {
        resolve({});
      }
    });
  }

  function saveExpenseMapping(mapping) {
    try {
      localStorage.setItem(EXPENSE_MAPPING_KEY, JSON.stringify(mapping));
    } catch (_) {}
  }

  // ── Account Matching ──

  function normalizeForMatch(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenOverlapScore(target, candidate) {
    const targetTokens = normalizeForMatch(target).split(' ').filter(t => t.length > 2);
    const candidateNorm = normalizeForMatch(candidate);
    let score = 0;
    for (const token of targetTokens) {
      if (candidateNorm.includes(token)) score += 10;
    }
    return score;
  }

  function findBestAPAccount(vendorName, currency, accounts) {
    const apAccounts = accounts.filter(a => {
      const cat = (a.acctAccountTypeByTypeId?.category || '').toLowerCase();
      return cat.includes('payable') || cat.includes('liability');
    });

    if (apAccounts.length === 0) return { account: null, ambiguous: false };

    const scored = apAccounts.map(a => {
      let score = tokenOverlapScore(vendorName, a.name || '');
      const nameLower = normalizeForMatch(a.name || '');
      const vendorNorm = normalizeForMatch(vendorName);

      if (nameLower.includes(vendorNorm)) score += 20;
      else if (vendorNorm.includes(nameLower) && nameLower.length > 3) score += 15;

      if (currency) {
        const cur = currency.toUpperCase();
        const hasUsd = nameLower.includes('usd') || nameLower.includes('dolar') || nameLower.includes('dollar');
        const hasMxn = nameLower.includes('mxn') || nameLower.includes('peso') || nameLower.includes('nacional');
        if (cur === 'USD' && hasUsd) score += 30;
        if (cur === 'MXN' && hasMxn) score += 30;
        if (cur === 'USD' && hasMxn) score -= 40;
        if (cur === 'MXN' && hasUsd) score -= 40;
      }

      return { account: a, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const ambiguous = scored.length > 1 && (scored[0].score - scored[1].score) <= 5;
    return { account: best.account, ambiguous, score: best.score };
  }

  function findBestExpenseAccount(lineName, accounts) {
    const expAccounts = accounts.filter(a => {
      const cat = (a.acctAccountTypeByTypeId?.category || '').toLowerCase();
      return cat.includes('expense') || (!cat.includes('payable') && !cat.includes('receivable') && !cat.includes('asset'));
    });

    if (expAccounts.length === 0) return null;

    const scored = expAccounts.map(a => {
      let score = tokenOverlapScore(lineName, a.name || '');
      const nameLower = normalizeForMatch(a.name || '');
      const lineNorm = normalizeForMatch(lineName);

      if (nameLower.includes(lineNorm) && lineNorm.length > 3) score += 20;
      else if (lineNorm.includes(nameLower) && nameLower.length > 3) score += 15;

      return { account: a, score };
    });

    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score === 0) return null;
    return scored[0].account;
  }

  function inferCurrency(vendorName) {
    const norm = normalizeForMatch(vendorName);
    for (const hint of ['inc', 'corp', 'llc', 'ltd', 'international', 'usa', 'america']) {
      if (norm.includes(hint)) return 'USD';
    }
    return 'MXN';
  }

  // ── DOM Extraction ──

  function extractVendorFromDOM() {
    // Walk from each singleValue upward looking for a "Vendor" label sibling
    const singleValues = document.querySelectorAll('[class*="singleValue"], [class*="SingleValue"]');
    for (const sv of singleValues) {
      let parent = sv.parentElement;
      for (let depth = 0; depth < 8 && parent; depth++) {
        for (const child of parent.children) {
          if (child.contains(sv)) continue;
          const txt = child.textContent?.trim() || '';
          if (/^vendor:?$/i.test(txt)) {
            const clone = sv.cloneNode(true);
            clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
            const val = clone.textContent?.trim();
            if (val && val.length > 1) return val;
          }
        }
        parent = parent.parentElement;
      }
    }
    return null;
  }

  function extractDivisaFromDOM() {
    for (const el of document.querySelectorAll('label, span, div, p')) {
      if (el.closest('#sa-bill-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      if (!/^divisa/i.test(txt) || txt.length > 30) continue;

      // Strategy 1: next siblings (value is typically right after the label)
      let sib = el.nextElementSibling;
      for (let i = 0; i < 2 && sib; i++, sib = sib.nextElementSibling) {
        const val = sib.textContent?.trim() || '';
        if (!val || val.length > 60) continue;
        if (/mxn|peso/i.test(val)) return 'MXN';
        if (/usd|d[oó]lar/i.test(val)) return 'USD';
      }

      // Strategy 2: parent's children after the label
      const parent = el.parentElement;
      if (!parent) continue;
      let afterLabel = false;
      for (const child of parent.children) {
        if (child === el) { afterLabel = true; continue; }
        if (!afterLabel) continue;
        const val = child.textContent?.trim() || '';
        if (!val || val.length > 60) continue;
        if (/mxn|peso/i.test(val)) return 'MXN';
        if (/usd|d[oó]lar/i.test(val)) return 'USD';
        break;
      }

      // Strategy 3: singleValue inside nearby container
      for (let p = el.parentElement, d = 0; d < 3 && p; d++, p = p.parentElement) {
        const sv = p.querySelector('[class*="singleValue"], [class*="SingleValue"]');
        if (sv && !sv.closest('#sa-bill-autofill-panel')) {
          const val = sv.textContent?.trim() || '';
          if (/mxn|peso/i.test(val)) return 'MXN';
          if (/usd|d[oó]lar/i.test(val)) return 'USD';
        }
      }
    }
    return null;
  }

  function extractLinesFromDOM() {
    const lines = [];
    const lineSection = findLineItemsSection();
    if (!lineSection) return lines;

    const nameFields = lineSection.querySelectorAll('input[name*="name"], input[placeholder*="name"], input[placeholder*="nombre"]');
    for (const input of nameFields) {
      if (input.value?.trim()) lines.push({ name: input.value.trim(), element: input });
    }

    if (lines.length === 0) {
      for (const el of lineSection.querySelectorAll('label, span, div')) {
        if (!/^name:?$/i.test(el.textContent?.trim())) continue;
        const inp = el.closest('div')?.parentElement?.querySelector('input, [class*="singleValue"]');
        if (inp) {
          const val = inp.value || inp.textContent?.trim();
          if (val) lines.push({ name: val.trim(), element: inp });
        }
      }
    }

    return lines;
  }

  function findLineItemsSection() {
    const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div,p');
    for (const h of headings) {
      if (/line\s*items?/i.test(h.textContent?.trim())) {
        return h.closest('section') || h.parentElement?.parentElement || h.parentElement;
      }
    }
    return document.querySelector('main') || document.querySelector('[class*="content"]');
  }

  // ── Combobox Interaction ──

  async function tryFillCombobox(labelText, searchText, targetAccountName) {
    const labelRe = typeof labelText === 'string' ? new RegExp(labelText, 'i') : labelText;
    let container = null;
    let labelEl = null;

    const labels = document.querySelectorAll('label, span, div, p');
    for (const el of labels) {
      if (el.closest('#sa-bill-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      if (txt.length > 40) continue;
      if (!labelRe.test(txt)) continue;
      labelEl = el;
      break;
    }

    if (!labelEl) return { success: false, method: 'fallback', reason: 'label no encontrado' };

    // Walk up from label until we find a parent containing a React Select control
    let parent = labelEl;
    for (let d = 0; d < 8 && parent; d++) {
      const ctrl = parent.querySelector('[class*="control"], [class*="Control"]');
      if (ctrl) { container = parent; break; }
      parent = parent.parentElement;
    }

    if (!container) return { success: false, method: 'fallback', reason: 'control no encontrado' };

    const control = container.querySelector('[class*="control"], [class*="Control"]');

    control.click();
    await sleep(200);

    const inputEl = control.querySelector('input');
    if (!inputEl) return { success: false, method: 'fallback', reason: 'input no encontrado' };

    const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeInputSetter) nativeInputSetter.call(inputEl, searchText);
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait up to 2s for options
    let options = [];
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const menu = container.querySelector('[class*="menu"], [class*="Menu"]')
        || document.querySelector('[class*="menu"], [class*="Menu"]');
      if (menu) {
        options = [...menu.querySelectorAll('[class*="option"], [class*="Option"]')];
        if (options.length > 0) break;
      }
    }

    if (options.length === 0) return { success: false, method: 'fallback', reason: 'no hay opciones' };

    const targetNorm = normalizeForMatch(targetAccountName);
    let best = null;
    let bestScore = -1;

    for (const opt of options) {
      const text = opt.textContent?.trim() || '';
      const norm = normalizeForMatch(text);
      let score = 0;
      if (norm === targetNorm) score = 100;
      else if (norm.includes(targetNorm) || targetNorm.includes(norm)) score = 50;
      else {
        const tokens = targetNorm.split(' ').filter(t => t.length > 2);
        for (const t of tokens) { if (norm.includes(t)) score += 10; }
      }
      if (score > bestScore) { bestScore = score; best = opt; }
    }

    if (!best || bestScore < 10) return { success: false, method: 'fallback', reason: 'opcion no encontrada' };

    best.click();
    return { success: true, filled: targetAccountName, method: 'visual' };
  }

  async function tryFillTextInput(labelText, value) {
    const labelRe = typeof labelText === 'string' ? new RegExp(labelText, 'i') : labelText;
    const labels = document.querySelectorAll('label, span, div, p');

    for (const el of labels) {
      if (el.closest('#sa-bill-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      if (txt.length > 30) continue;
      if (!labelRe.test(txt)) continue;

      // Walk up to find a parent with an input
      let parent = el;
      for (let d = 0; d < 5 && parent; d++) {
        const inp = parent.querySelector('input[type="text"], input[type="number"], input:not([type])');
        if (inp) {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(inp, String(value));
          inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        parent = parent.parentElement;
      }
    }

    return { success: false };
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Fill All Fields ──

  async function fillAllFields() {
    const results = {};

    if (state.currency) {
      results.currency = await tryFillCombobox('divisa|currency', state.currency, state.currency);
    }

    if (state.exchangeRate != null) {
      results.exchangeRate = await tryFillTextInput('tipo de cambio|exchange rate', state.exchangeRate);
    }

    if (state.apAccount?.account) {
      const acc = state.apAccount.account;
      const search = acc.accountNumber || acc.name?.split(' ')[0] || acc.name;
      results.apAccount = await tryFillCombobox('cuenta.*pagar|accounts?\\s*payable|a/?p\\s*account|vendor\\s*account', search, acc.name);
    }

    for (let i = 0; i < state.lineAccounts.length; i++) {
      const line = state.lineAccounts[i];
      if (!line.account) continue;
      const acc = line.account;
      const search = acc.accountNumber || acc.name?.split(' ')[0] || acc.name;
      results[`line_${i}`] = await tryFillCombobox(
        new RegExp(`gasto|expense|account.*line.*${i + 1}|line.*${i + 1}.*account`, 'i'),
        search,
        acc.name
      );
    }

    return results;
  }

  // ── Orchestrator ──

  async function runAutofill() {
    if (autofillRunning) return;
    autofillRunning = true;

    try {
      await _runAutofillInner();
    } finally {
      autofillRunning = false;
    }
  }

  async function _runAutofillInner() {
    updatePanelStatus('pending', 'Analizando...');

    const vendorName = lastDetectedVendor || extractVendorFromDOM();
    if (!vendorName) {
      updatePanelStatus('pending', 'Esperando selección de proveedor…');
      return;
    }

    let exchangeData, accountsData, expenseMapping;
    try {
      [exchangeData, accountsData, expenseMapping] = await Promise.all([
        fetchExchangeRate().catch(() => null),
        fetchAccounts().catch(() => []),
        loadExpenseMapping()
      ]);
    } catch (err) {
      updatePanelStatus('error', 'Error fetching datos: ' + err.message);
      return;
    }

    // Divisa priority: DOM (user-selected) > PO > inferred
    const divisaFromDOM = extractDivisaFromDOM();
    const currencyFromPO = state.poDivisa;
    const currency = divisaFromDOM || currencyFromPO || inferCurrency(vendorName);
    const currencySource = divisaFromDOM ? 'dom' : currencyFromPO ? 'po' : 'inferred';
    lastDetectedDivisa = divisaFromDOM;

    // TC: MXN=1, otherwise from TipoCambio array
    let exchangeRate;
    if (currency === 'MXN') {
      exchangeRate = 1;
    } else {
      exchangeRate = exchangeData ?? state.exchangeRate ?? null;
    }
    const apResult = findBestAPAccount(vendorName, currency, accountsData);
    const lines = extractLinesFromDOM();

    const lineAccounts = lines.map(line => {
      const learned = expenseMapping[normalizeForMatch(line.name)];
      if (learned) {
        const account = accountsData.find(a => a.id === learned.accountId) || { id: learned.accountId, name: learned.accountName };
        return { ...line, account, source: 'learned' };
      }
      const match = findBestExpenseAccount(line.name, accountsData);
      return { ...line, account: match, source: match ? 'inferred' : 'none' };
    });

    state = {
      ...state,
      vendorName,
      currency,
      currencySource,
      exchangeRate,
      apAccount: apResult,
      lineAccounts,
      ready: true
    };

    await fillAllFields();
    renderPanel();
    log(`BillAutofill listo: vendor="${vendorName}" currency=${currency} rate=${exchangeRate} ap="${apResult.account?.name}"`);
  }

  // ── Panel UI ──

  const STATUS_COLORS = { done: '#4CAF50', warn: '#ff9800', error: '#f44336', learned: '#2196F3', pending: '#999' };
  const STATUS_ICONS  = { done: '✓', warn: '~', error: '✗', learned: '★', pending: '…' };
  function getStatusIcon(status) { return STATUS_ICONS[status] || '·'; }

  function renderPanel() {
    let panel = document.getElementById('sa-bill-autofill-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sa-bill-autofill-panel';
      panel.style.cssText = [
        'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:99999', 'background:#1e293b', 'color:#e2e8f0', 'border-radius:10px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)', 'font-family:system-ui,sans-serif',
        'font-size:13px', 'min-width:260px', 'max-width:340px'
      ].join(';');
      document.body.appendChild(panel);
    }

    const collapsed = panel.dataset.collapsed === 'true';

    let html = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #334155;cursor:pointer;" id="sa-baf-header">
        <span style="font-weight:700;font-size:14px;letter-spacing:.3px;">Bill Autofill</span>
        <span style="font-size:16px;color:#94a3b8;">${collapsed ? '▲' : '▼'}</span>
      </div>`;

    if (!collapsed) {
      html += `<div style="padding:12px 14px;">`;

      const divisaStatus = !state.currency ? 'pending' : state.currencySource === 'inferred' ? 'warn' : 'done';
      const divisaSuffix = state.currencySource === 'inferred' ? ' (inferida)' : state.currencySource === 'dom' ? ' (del form)' : '';
      const divisaLabel = state.currency ? `${state.currency}${divisaSuffix}` : '—';
      html += renderRow('Divisa', divisaLabel, divisaStatus);
      html += renderRow('Tipo de Cambio',
        state.exchangeRate != null ? `$${Number(state.exchangeRate).toFixed(4)}` : '—',
        state.exchangeRate != null ? 'done' : 'pending');

      const ap = state.apAccount;
      const apStatus = !ap?.account ? 'error' : ap.ambiguous ? 'warn' : 'done';
      html += renderRow('Cuenta AP', ap?.account?.name || 'No resuelto', apStatus);

      if (state.lineAccounts.length > 0) {
        html += `<div style="border-top:1px solid #334155;margin:8px 0 6px;padding-top:6px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Gastos por línea</div>`;
        for (const line of state.lineAccounts) {
          const status = line.source === 'learned' ? 'learned' : line.account ? 'inferred' : 'error';
          const displayStatus = line.source === 'learned' ? 'learned' : line.account ? 'done' : 'error';
          html += renderRow(line.name || '(sin nombre)', line.account?.name || 'No resuelto', displayStatus);
        }
      }

      html += `<button id="sa-baf-refresh" style="margin-top:10px;width:100%;padding:7px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Actualizar</button>`;
      html += `</div>`;
    }

    panel.innerHTML = html;

    panel.querySelector('#sa-baf-header').addEventListener('click', () => {
      panel.dataset.collapsed = collapsed ? 'false' : 'true';
      renderPanel();
    });

    const refreshBtn = panel.querySelector('#sa-baf-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        state.ready = false;
        runAutofill();
      });
    }
  }

  function renderRow(label, value, status) {
    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
    const icon = getStatusIcon(status);
    return `
      <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;">
        <span style="color:${color};font-weight:700;min-width:14px;">${icon}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;">${escHtml(label)}</div>
          <div style="color:#e2e8f0;font-size:12px;word-break:break-word;">${escHtml(value)}</div>
        </div>
      </div>`;
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function removePanel() {
    const panel = document.getElementById('sa-bill-autofill-panel');
    if (panel) panel.remove();
  }

  function updatePanelStatus(status, message) {
    let panel = document.getElementById('sa-bill-autofill-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sa-bill-autofill-panel';
      panel.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#1e293b;color:#e2e8f0;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;font-size:13px;padding:12px 14px;min-width:220px;';
      document.body.appendChild(panel);
    }
    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
    panel.innerHTML = `<span style="font-weight:700;">Bill Autofill</span> <span style="color:${color};margin-left:8px;">${escHtml(message)}</span>`;
  }

  return { init, runAutofill };
})();

if (typeof window !== 'undefined') {
  window.BillAutofill = BillAutofill;
  BillAutofill.init();
}
