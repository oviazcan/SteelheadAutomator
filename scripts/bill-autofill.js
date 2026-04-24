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
      billFormVisible = false;
      lastDetectedVendor = null;
      lastDetectedDivisa = null;
      lastDetectedInvoiceDate = null;
      lastLineCount = -1;
      scriptSetDivisa = null;
      state = { vendorName: null, currency: null, exchangeRate: null, apAccount: null, lineAccounts: [], ready: false, poDivisa: null, poLineItems: [], existingInputs: null };
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
  let lastDetectedInvoiceDate = null;
  let lastLineCount = -1;
  let autofillRunning = false;
  let scriptSetDivisa = null;

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
        removePanel();
      }
      return;
    }

    if (!billFormVisible) {
      billFormVisible = true;
      if (!lastDetectedVendor) {
        log('Pantalla Bill detectada');
        state = { vendorName: null, currency: null, exchangeRate: null, apAccount: null, lineAccounts: [], ready: false, poDivisa: null, poLineItems: [], existingInputs: null };
        renderPanel();
      }
    }

    const currentVendor = extractVendorFromDOM();
    if (currentVendor && currentVendor !== lastDetectedVendor) {
      lastDetectedVendor = currentVendor;
      lastDetectedDivisa = null;
      lastLineCount = -1;
      scriptSetDivisa = null;
      log(`Vendor detectado/cambiado: ${currentVendor}`);
      state.ready = false;
      runAutofill();
      return;
    } else if (!currentVendor && !lastDetectedVendor) {
      updatePanelStatus('pending', 'Esperando selección de proveedor…');
      return;
    }

    // Monitor divisa changes → update TC and AP inline
    const currentDivisa = extractDivisaFromDOM();
    if (currentDivisa && currentDivisa !== lastDetectedDivisa && lastDetectedVendor) {
      lastDetectedDivisa = currentDivisa;
      log(`Divisa cambiada en form: ${currentDivisa}`);
      if (state.ready) {
        state.currency = currentDivisa;
        state.currencySource = 'form';
        if (currentDivisa === 'MXN') {
          state.exchangeRate = 1;
          state.exchangeRateDate = null;
        } else {
          const invoiceDate = extractInvoiceDateFromDOM();
          const result = findRateForDate(invoiceDate);
          state.exchangeRate = result?.rate ?? null;
          state.exchangeRateDate = result?.date ?? null;
        }
        tryFillTextInput('tipo de cambio|exchange rate', state.exchangeRate);
        renderPanel();
        log(`TC actualizado: ${state.exchangeRate} (divisa → ${currentDivisa})`);
        return;
      }
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

    // Monitor Invoice Date changes → update TC to match that date
    if (lastDetectedVendor && state.ready && state.currency !== 'MXN') {
      const invoiceDate = extractInvoiceDateFromDOM();
      if (invoiceDate && invoiceDate !== lastDetectedInvoiceDate) {
        lastDetectedInvoiceDate = invoiceDate;
        const result = findRateForDate(invoiceDate);
        if (result && result.rate !== state.exchangeRate) {
          log(`Invoice Date: ${invoiceDate} → TC: ${result.rate} (del ${result.date})`);
          state.exchangeRate = result.rate;
          state.exchangeRateDate = result.date;
          tryFillTextInput('tipo de cambio|exchange rate', result.rate);
          renderPanel();
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
        if (lines.length > 0) {
          state.poLineItems = lines;
          log(`PO líneas interceptadas: ${lines.length}`);
          if (state.vendorName) {
            state.ready = false;
            setTimeout(() => runAutofill(), 1500);
          }
        }
        const firstPo = pos[0];
        if (firstPo?.idInDomain && !state.poDivisa) {
          fetchPODivisa(firstPo.idInDomain).then(divisa => {
            if (divisa) {
              state.poDivisa = divisa;
              log(`PO Divisa obtenida: ${divisa}`);
              if (state.vendorName) {
                state.ready = false;
                runAutofill();
              }
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
    try {
      const data = await api().query('GetDomain', {}, 'GetDomain');
      log('GetDomain keys: ' + JSON.stringify(Object.keys(data || {})));
      const tipoCambio = data?.currentSession?.userByUserId?.domainByDomainId?.customInputs?.TipoCambio
        || data?.domain?.customInputs?.TipoCambio
        || data?.domainByDomainId?.customInputs?.TipoCambio
        || [];
      if (!Array.isArray(tipoCambio) || tipoCambio.length === 0) {
        warn('TipoCambio no encontrado — paths revisados: currentSession..., domain..., domainByDomainId...');
        return null;
      }
      log(`TipoCambio: ${tipoCambio.length} entradas, última: ${JSON.stringify(tipoCambio[tipoCambio.length - 1])}`);

      const userId = data?.currentSession?.userByUserId?.id;
      if (userId) state._userId = userId;

      state._tipoCambioArray = tipoCambio;
      const result = findRateForDate(null);
      return result?.rate ?? null;
    } catch (err) {
      warn('fetchExchangeRate error: ' + err.message);
      return null;
    }
  }

  function findRateForDate(dateStr) {
    const arr = state._tipoCambioArray;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const target = dateStr || new Date().toISOString().slice(0, 10);
    const exact = arr.find(e => e.FechaTipoCambio === target);
    if (exact) return { rate: exact.TipoCambio, date: exact.FechaTipoCambio };
    const sorted = [...arr].sort((a, b) => (b.FechaTipoCambio || '').localeCompare(a.FechaTipoCambio || ''));
    const closest = sorted.find(e => (e.FechaTipoCambio || '') <= target);
    const entry = closest || sorted[0];
    return entry ? { rate: entry.TipoCambio, date: entry.FechaTipoCambio } : null;
  }

  async function fetchAccounts() {
    const data = await api().query('GetAccountDataForBill', {}, 'GetAccountDataForBill');
    return data?.allAcctAccounts?.nodes || [];
  }

  async function fetchPODivisa(idInDomain) {
    try {
      const data = await api().query('GetPurchaseOrder', { idInDomain, userIdFilter: state._userId || 0 }, 'GetPurchaseOrder');
      const po = data?.purchaseOrderByIdInDomain;
      const divisa = po?.customInputs?.DatosReferencia?.Divisa || po?.customInputs?.Divisa || null;

      // Alternative exchange rate from PO domain
      if (!state.exchangeRate) {
        const tipoCambio = po?.domainByDomainId?.customInputs?.TipoCambio;
        if (Array.isArray(tipoCambio) && tipoCambio.length > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const entry = tipoCambio.find(e => e.FechaTipoCambio === today) || tipoCambio.sort((a, b) => (b.FechaTipoCambio || '').localeCompare(a.FechaTipoCambio || ''))[0];
          if (entry?.TipoCambio) state.exchangeRate = entry.TipoCambio;
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
      return cat.includes('expense') || cat.includes('asset') || (!cat.includes('payable') && !cat.includes('receivable'));
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

  async function fetchVendorDivisas(vendorName) {
    try {
      const searchData = await api().query('SearchVendors', { searchString: vendorName, first: 5 }, 'SearchVendors');
      const vendors = searchData?.searchVendors?.nodes || [];
      if (vendors.length === 0) return null;
      const match = vendors.find(v => normalizeForMatch(v.name) === normalizeForMatch(vendorName)) || vendors[0];
      const vendorData = await api().query('GetVendor', { idInDomain: match.idInDomain }, 'GetVendor');
      const vendor = vendorData?.vendorByIdInDomain;
      if (!vendor) return null;
      const datos = vendor.customInputs?.DatosContablesProv;
      if (!datos) return null;
      return { mxn: !!datos.DivisaMXN, usd: !!datos.DivisaUSD };
    } catch (err) {
      warn('fetchVendorDivisas error: ' + err.message);
      return null;
    }
  }

  function inferCurrencyFromVendorDivisas(divisas) {
    if (!divisas) return null;
    if (divisas.usd) return 'USD';
    if (divisas.mxn) return 'MXN';
    return null;
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
    // Strategy 1: reverse pattern — find singleValue with currency text, verify "Divisa" label nearby
    const singleValues = document.querySelectorAll('[class*="singleValue"], [class*="SingleValue"]');
    for (const sv of singleValues) {
      if (sv.closest('#sa-bill-autofill-panel')) continue;
      const val = sv.textContent?.trim() || '';
      if (!/mxn|peso|usd|d[oó]lar/i.test(val)) continue;
      let parent = sv.parentElement;
      for (let depth = 0; depth < 8 && parent; depth++) {
        for (const child of parent.children) {
          if (child.contains(sv)) continue;
          const labelText = child.textContent?.trim() || '';
          if (/divisa/i.test(labelText) && labelText.length < 50) {
            return /mxn|peso/i.test(val) ? 'MXN' : 'USD';
          }
        }
        parent = parent.parentElement;
      }
    }

    // Strategy 2: <select> elements near "Divisa"
    for (const select of document.querySelectorAll('select')) {
      if (select.closest('#sa-bill-autofill-panel')) continue;
      const opt = select.options?.[select.selectedIndex];
      const val = opt?.text || select.value || '';
      if (!/mxn|peso|usd|d[oó]lar/i.test(val)) continue;
      let parent = select.parentElement;
      for (let d = 0; d < 6 && parent; d++) {
        if (/divisa/i.test(parent.textContent || '') && parent.textContent.length < 300) {
          return /mxn|peso/i.test(val) ? 'MXN' : 'USD';
        }
        parent = parent.parentElement;
      }
    }

    return null;
  }

  function extractInvoiceDateFromDOM() {
    const inputs = document.querySelectorAll('input[type="date"], input[type="text"], input');
    for (const inp of inputs) {
      if (inp.closest('#sa-bill-autofill-panel')) continue;
      let parent = inp.parentElement;
      for (let d = 0; d < 5 && parent; d++) {
        for (const child of parent.children) {
          if (child.contains(inp)) continue;
          const txt = child.textContent?.trim() || '';
          if (/^invoice\s*date:?$/i.test(txt) || /^fecha.*factura:?$/i.test(txt)) {
            const val = inp.value?.trim();
            if (!val) return null;
            const m = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return m[0];
            const m2 = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (m2) return `${m2[3]}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
            return null;
          }
        }
        parent = parent.parentElement;
      }
    }
    return null;
  }

  function extractLinesFromDOM() {
    const lines = [];
    const lineSection = findLineItemsSection();
    if (!lineSection) return lines;

    // Strategy 1: inputs with name-related attributes
    for (const input of lineSection.querySelectorAll('input')) {
      const n = (input.name || '').toLowerCase();
      const p = (input.placeholder || '').toLowerCase();
      if ((n.includes('name') || p.includes('name') || p.includes('nombre')) && input.value?.trim()) {
        lines.push({ name: input.value.trim(), element: input });
      }
    }
    if (lines.length > 0) return lines;

    // Strategy 2: "Name:" label — find adjacent input (sibling or parent's child)
    for (const el of lineSection.querySelectorAll('label, span, div, td, th')) {
      if (el.closest('#sa-bill-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      if (!/^name:?\s*$/i.test(txt) || txt.length > 10) continue;

      let found = false;
      // Check next siblings first (label and input are typically siblings)
      let sib = el.nextElementSibling;
      for (let i = 0; i < 3 && sib && !found; i++, sib = sib.nextElementSibling) {
        if (sib.tagName === 'INPUT' && sib.value?.trim()) {
          lines.push({ name: sib.value.trim(), element: sib });
          found = true;
        } else {
          const inp = sib.querySelector('input');
          if (inp?.value?.trim()) {
            lines.push({ name: inp.value.trim(), element: inp });
            found = true;
          }
        }
      }
      if (found) continue;

      // Check parent's children (label is child, input is another child)
      const parent = el.parentElement;
      if (parent) {
        for (const child of parent.children) {
          if (child === el || child.contains(el)) continue;
          const inp = child.tagName === 'INPUT' ? child : child.querySelector('input');
          if (inp?.value?.trim()) {
            lines.push({ name: inp.value.trim(), element: inp });
            break;
          }
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

    // Walk up looking for the CLOSEST control — whichever appears first wins.
    // React Select has input[role="combobox"]; RJSF has native <select>.
    let parent = labelEl;
    for (let d = 0; d < 8 && parent; d++) {
      const comboInput = parent.querySelector('input[role="combobox"]');
      if (comboInput) {
        const ctrl = comboInput.closest('[class*="-control"]');
        if (ctrl) return await clickAndSelectOption(ctrl, parent, searchText, targetAccountName);
      }
      const sel = parent.querySelector('select');
      if (sel) return tryFillNativeSelect(sel, searchText, targetAccountName);
      parent = parent.parentElement;
    }

    return { success: false, method: 'fallback', reason: 'control no encontrado' };
  }

  function tryFillNativeSelect(sel, searchText, targetName) {
    const searchNorm = normalizeForMatch(searchText);
    for (const opt of sel.options) {
      const optText = (opt.text || '').trim();
      const norm = normalizeForMatch(optText || opt.value || '');
      if (!norm) continue;
      if (norm.includes(searchNorm) || searchNorm.includes(norm)) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(sel, opt.value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, filled: optText, method: 'native-select' };
      }
    }
    return { success: false, method: 'fallback', reason: 'opcion no encontrada en select nativo' };
  }

  async function clickAndSelectOption(control, container, searchText, targetAccountName) {
    control.click();
    await sleep(300);

    const inputEl = control.querySelector('input');
    if (inputEl) {
      const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeInputSetter) nativeInputSetter.call(inputEl, searchText);
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let options = [];
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const menu = document.querySelector('[class*="menuList"], [class*="MenuList"], [class*="menu-list"]')
        || container.querySelector('[class*="menu"], [class*="Menu"]')
        || document.querySelector('[class*="menu"], [class*="Menu"]');
      if (menu) {
        options = [...menu.querySelectorAll('[class*="option"], [class*="Option"]')];
        if (options.length > 0) break;
      }
    }

    if (options.length === 0) return { success: false, method: 'fallback', reason: 'no hay opciones tras click' };

    return pickBestOption(options, targetAccountName);
  }

  function pickBestOption(options, targetAccountName) {
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
      results.currency = await tryFillCombobox('divisa.*factura|divisa|currency', state.currency, state.currency);
      if (results.currency?.success) scriptSetDivisa = state.currency;
      log(`Fill divisa: ${JSON.stringify(results.currency)}`);
    }

    if (state.exchangeRate != null) {
      results.exchangeRate = await tryFillTextInput('tipo de cambio|exchange rate', state.exchangeRate);
      log(`Fill TC: ${JSON.stringify(results.exchangeRate)}`);
    }

    if (state.apAccount?.account) {
      const acc = state.apAccount.account;
      const search = acc.accountNumber || acc.name?.split(' ')[0] || acc.name;
      results.apAccount = await tryFillCombobox('cuenta.*pagar|accounts?\\s*payable|a/?p\\s*account|vendor\\s*account', search, acc.name);
      log(`Fill AP: ${JSON.stringify(results.apAccount)}`);
    }

    // Expense accounts: find each line's container and fill its Expense Account combobox
    for (let i = 0; i < state.lineAccounts.length; i++) {
      const line = state.lineAccounts[i];
      if (!line.account) continue;
      const acc = line.account;
      const search = acc.accountNumber || acc.name?.split(' ')[0] || acc.name;
      results[`line_${i}`] = await tryFillExpenseInLine(line.name, search, acc.name);
      log(`Fill expense line ${i} "${line.name}": ${JSON.stringify(results[`line_${i}`])}`);
    }

    return results;
  }

  async function tryFillExpenseInLine(lineName, searchText, targetAccountName) {
    const lineNorm = lineName.toLowerCase().trim().replace(/\s+/g, ' ');

    // The Name input is outside the MUI sub-table that has "Expense Account".
    // Strategy: find Name input → walk up to the line item container (ancestor
    // that contains a sub-table with "Expense Account") → find the column index
    // → find the combobox in the corresponding data cell.

    const nameInputs = document.querySelectorAll('input');
    let nameInput = null;

    for (const inp of nameInputs) {
      if (inp.closest('#sa-bill-autofill-panel')) continue;
      if (inp.getAttribute('role') === 'combobox') continue;
      const val = (inp.value || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (!val) continue;
      if (val === lineNorm || val.includes(lineNorm) || lineNorm.includes(val)) {
        nameInput = inp;
        break;
      }
    }

    if (!nameInput) return { success: false, method: 'fallback', reason: `input Name no encontrado para "${lineName}"` };

    // Walk up to find the line item container — the ancestor that contains
    // a sub-table with "Expense Account" header
    let lineContainer = null;
    let targetTable = null;
    let expenseColIdx = -1;
    let parent = nameInput.parentElement;

    for (let d = 0; d < 12 && parent; d++) {
      const tables = parent.querySelectorAll('table');
      for (const table of tables) {
        const allCells = table.querySelectorAll('td, th');
        for (let i = 0; i < allCells.length; i++) {
          const t = allCells[i].textContent?.trim() || '';
          if (/expense\s*account|cuenta.*gasto/i.test(t) && t.length < 30) {
            targetTable = table;
            break;
          }
        }
        if (targetTable) break;
      }
      if (targetTable) { lineContainer = parent; break; }
      parent = parent.parentElement;
    }

    if (!targetTable) return { success: false, method: 'fallback', reason: `sub-tabla con Expense Account no encontrada para "${lineName}"` };

    // Find the "Expense Account" column index in the header row
    const rows = targetTable.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      for (let i = 0; i < cells.length; i++) {
        const t = cells[i].textContent?.trim() || '';
        if (/expense\s*account|cuenta.*gasto/i.test(t) && t.length < 30) {
          expenseColIdx = i;
          break;
        }
      }
      if (expenseColIdx >= 0) break;
    }

    if (expenseColIdx < 0) return { success: false, method: 'fallback', reason: 'columna Expense Account no encontrada en header' };

    // Find the data row that has a combobox in the expense column
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (expenseColIdx >= cells.length) continue;
      const cell = cells[expenseColIdx];
      const comboInput = cell.querySelector('input[role="combobox"]');
      if (!comboInput) continue;
      const control = comboInput.closest('[class*="-control"]');
      if (!control) continue;
      return await clickAndSelectOption(control, cell, searchText, targetAccountName);
    }

    return { success: false, method: 'fallback', reason: 'combobox no encontrado en columna Expense' };
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

    let exchangeData, accountsData, expenseMapping, vendorDivisas;
    try {
      [exchangeData, accountsData, expenseMapping, vendorDivisas] = await Promise.all([
        fetchExchangeRate().catch(err => { warn('fetchExchangeRate catch: ' + err.message); return null; }),
        fetchAccounts().catch(err => { warn('fetchAccounts catch: ' + err.message); return []; }),
        loadExpenseMapping(),
        fetchVendorDivisas(vendorName).catch(err => { warn('fetchVendorDivisas catch: ' + err.message); return null; })
      ]);
    } catch (err) {
      updatePanelStatus('error', 'Error fetching datos: ' + err.message);
      return;
    }

    // Divisa: after first fill trust the DOM (preserves user changes).
    // Before first fill (scriptSetDivisa null), infer from PO/vendor.
    const divisaFromDOM = scriptSetDivisa ? extractDivisaFromDOM() : null;
    const currencyFromPO = state.poDivisa;
    const currencyFromVendor = inferCurrencyFromVendorDivisas(vendorDivisas);
    const currency = divisaFromDOM || currencyFromPO || currencyFromVendor || 'USD';
    const currencySource = divisaFromDOM ? 'form' : currencyFromPO ? 'po' : currencyFromVendor ? 'vendor' : 'default';

    // TC: MXN=1, otherwise from TipoCambio array. Use Invoice Date if available.
    let exchangeRate;
    let exchangeRateDate = null;
    if (currency === 'MXN') {
      exchangeRate = 1;
    } else {
      const invoiceDate = extractInvoiceDateFromDOM();
      if (invoiceDate) {
        const result = findRateForDate(invoiceDate);
        exchangeRate = result?.rate ?? exchangeData;
        exchangeRateDate = result?.date ?? null;
      } else {
        exchangeRate = exchangeData;
        const today = new Date().toISOString().slice(0, 10);
        const result = findRateForDate(today);
        exchangeRateDate = result?.date ?? null;
      }
      if (exchangeRate == null) warn('TC no disponible para ' + currency + ' — verificar hash GetDomain');
    }
    log(`Divisa: ${currency} (${currencySource}), TC: ${exchangeRate}, exchangeData: ${exchangeData}`);
    const apResult = findBestAPAccount(vendorName, currency, accountsData);

    // Lines: DOM first, fallback to intercepted PO data
    let lines = extractLinesFromDOM();
    if (lines.length === 0 && state.poLineItems.length > 0) {
      lines = state.poLineItems.map(item => {
        const name = item.name || item.description
          || item.partNumberByPartNumberId?.name
          || item.partNumber?.name || '';
        return { name: name.trim(), element: null };
      }).filter(l => {
        if (!l.name || l.name.length < 3) return false;
        if (/^\d[\d.,]*$/.test(l.name)) return false;
        if (/^[A-Z_]{2,10}$/.test(l.name)) return false;
        return true;
      });
      if (lines.length > 0) log(`Usando ${lines.length} líneas de PO interceptada`);
    }

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
      exchangeRateDate,
      apAccount: apResult,
      lineAccounts,
      ready: true
    };

    await fillAllFields();

    // Sync lastDetectedDivisa with what the DOM actually shows after fill,
    // so the scan loop divisa monitor detects future user changes correctly.
    const domDivisaAfterFill = extractDivisaFromDOM();
    if (domDivisaAfterFill) lastDetectedDivisa = domDivisaAfterFill;

    renderPanel();
    log(`BillAutofill listo: vendor="${vendorName}" currency=${currency} rate=${exchangeRate} ap="${apResult.account?.name}" domDivisa=${domDivisaAfterFill}`);
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

      const divisaStatus = !state.currency ? 'pending' : state.currencySource === 'default' ? 'warn' : 'done';
      const divisaSources = { form: ' (del form)', po: ' (de PO)', vendor: ' (del vendor)', default: ' (default)' };
      const divisaSuffix = divisaSources[state.currencySource] || '';
      const divisaLabel = state.currency ? `${state.currency}${divisaSuffix}` : '—';
      html += renderRow('Divisa', divisaLabel, divisaStatus);
      const tcLabel = state.exchangeRate != null
        ? `$${Number(state.exchangeRate).toFixed(4)}${state.exchangeRateDate ? ` (${state.exchangeRateDate})` : ''}`
        : '—';
      html += renderRow('Tipo de Cambio', tcLabel, state.exchangeRate != null ? 'done' : 'pending');

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

      html += `<div style="text-align:center;padding-top:8px;border-top:1px solid #334155;margin-top:6px;"><span id="sa-baf-refresh" style="cursor:pointer;color:#64748b;font-size:11px;letter-spacing:.3px;">↻ actualizar</span></div>`;
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
