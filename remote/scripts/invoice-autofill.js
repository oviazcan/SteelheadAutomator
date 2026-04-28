// Invoice Autofill
// Auto-rellena Cuenta CXC, Divisa, Tipo de Cambio y Cuentas de Ingreso/Descuento en Create/Edit Invoice
// Reglas:
//   - AR (CXC): customer.customInputs.DatosContables.CuentasContables filtrado por DivisaContable, mayor numeración
//   - Ingreso/Descuento por línea: salesTaxable × signo × prefijo (0401-0001 / 0401-0004 / 0402-0001 / 0402-0002)
//   - Divisa+TC: solo si la factura es manual (sin packing slip ni OV)
// Depends on: SteelheadAPI

const InvoiceAutofill = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  const INVOICE_URL_RE = /\/Domains\/\d+\/Invoices(?:\/|$)/;

  // Matriz de prefijos contables
  // [salesTaxBySalesTaxId.name=general] × [credit-note=false] → 0401-0001 (Ventas Tasa General)
  // [salesTaxBySalesTaxId.name=general] × [credit-note=true]  → 0402-0001 (Devoluciones/Descuentos Tasa General)
  // [salesTaxBySalesTaxId.name=exenta]  × [credit-note=false] → 0401-0004 (Ventas Tasa 0%)
  // [salesTaxBySalesTaxId.name=exenta]  × [credit-note=true]  → 0402-0002 (Devoluciones/Descuentos Tasa 0%)
  const PREFIX_VENTAS_GENERAL = '0401-0001';
  const PREFIX_VENTAS_CERO    = '0401-0004';
  const PREFIX_DESC_GENERAL   = '0402-0001';
  const PREFIX_DESC_CERO      = '0402-0002';

  let debounceTimer = null;
  let state = {
    customerId: null,
    customerName: null,
    customer: null,                  // objeto crudo de InvoiceLowCodeData / GetReceivedOrders…
    currency: null,
    currencySource: null,            // 'so' | 'invoice' | 'customer' | 'form' | 'default'
    exchangeRate: null,
    exchangeRateDate: null,
    arAccount: null,                 // { account, ambiguous, candidates, reason }
    lineAccounts: [],                // [{name, expected, productSuggested, source, mismatch, isCredit, account}]
    ready: false,
    receivedOrderDivisa: null,
    hasOrderLinkage: false,          // true si la factura está atada a packing slip / OV
    isInvoiceCreditNote: false,      // bandera global por DatosNotaCredito
    invoiceDate: null,
    allAccounts: [],
    productAccountConfigs: []
  };

  // ── Init ──

  function init() {
    if (window.__saInvoiceAutofillVersion) return;
    window.__saInvoiceAutofillVersion = true;
    if (document.documentElement.dataset.saInvoiceAutofillEnabled === 'false') {
      log('InvoiceAutofill deshabilitado');
      return;
    }
    patchFetch();
    setupUrlListener();
    log(`InvoiceAutofill inicializado en ${location.pathname} (matches=${INVOICE_URL_RE.test(location.pathname)})`);
    checkUrl();
  }

  // ── URL Listener ──

  function setupUrlListener() {
    if (window.__saInvoiceAutofillHistoryPatched) return;
    window.__saInvoiceAutofillHistoryPatched = true;
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
    if (!INVOICE_URL_RE.test(location.pathname)) {
      removePanel();
      invoiceFormVisible = false;
      resetInvoiceState();
      return;
    }
    setupPageObserver();
  }

  // ── Page Observer ──

  function setupPageObserver() {
    if (window.__saInvoiceAutofillObserverActive) return;
    window.__saInvoiceAutofillObserverActive = true;

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanForInvoicePage, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForInvoicePage();
  }

  let invoiceFormVisible = false;
  let lastDetectedCustomer = null;
  let lastDetectedDivisa = null;
  let lastDetectedInvoiceDate = null;
  let lastLineCount = -1;
  let autofillRunning = false;
  let scriptSetDivisa = null;
  let headingLostAt = 0;
  let diagLoggedForUrl = null;

  // Heading detection: matchea variantes Create/Edit/New Invoice, "Invoice #123",
  // versiones en español ("Nueva/Editar Factura"), o solo "Invoice" como h1
  const HEADING_RE = /(?:create|edit|new|view)\s+invoice|^\s*invoice(?:\s|$|#|·|\d|-)|nueva\s+factura|editar\s+factura|^\s*factura(?:\s|$|#|·|\d|-)/i;

  const RJSF_DIVISA_ID = 'root_DatosContables_Divisa';
  const RJSF_TC_ID = 'root_DatosContables_exchangeRate';

  function resetInvoiceState() {
    // Reset conservador: NO borra los datos capturados por queries
    // (customer, allAccounts, productAccountConfigs, receivedOrderDivisa,
    // hasOrderLinkage, _tipoCambioArray) porque las queries pasan antes
    // de que el form RJSF se monte y el reset las perdería.
    // Solo resetea los flags de UI y los derivados (currency, exchangeRate,
    // arAccount, lineAccounts) que se recalculan en runAutofill.
    lastDetectedCustomer = null;
    lastDetectedDivisa = null;
    lastDetectedInvoiceDate = null;
    lastLineCount = -1;
    scriptSetDivisa = null;
    state.currency = null;
    state.currencySource = null;
    state.exchangeRate = null;
    state.exchangeRateDate = null;
    state.arAccount = null;
    state.lineAccounts = [];
    state.ready = false;
    state.invoiceDate = null;
    state.isInvoiceCreditNote = false;
  }

  function fillTCById(rate) {
    const inp = document.getElementById(RJSF_TC_ID);
    if (!inp) return false;
    if (inp.value === String(rate)) return true;
    const tracker = inp._valueTracker;
    if (tracker) tracker.setValue('');
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(inp, String(rate));
    inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function installDivisaListener() {
    const sel = document.getElementById(RJSF_DIVISA_ID);
    if (!sel || sel.dataset.saInvDivisaListener) return;
    sel.dataset.saInvDivisaListener = 'true';
    sel.addEventListener('change', onDivisaChange);
    log('Divisa listener instalado (invoice)');
  }

  function onDivisaChange() {
    const sel = document.getElementById(RJSF_DIVISA_ID);
    if (!sel) return;
    const val = sel.options[sel.selectedIndex]?.text || sel.value || '';
    const divisa = /mxn|peso/i.test(val) ? 'MXN' : /usd|d[oó]l/i.test(val) ? 'USD' : null;
    if (!divisa || divisa === state.currency) return;

    log(`Divisa change event (invoice): ${divisa}`);
    lastDetectedDivisa = divisa;
    state.currency = divisa;
    state.currencySource = 'form';

    if (divisa === 'MXN') {
      state.exchangeRate = 1;
      state.exchangeRateDate = null;
    } else {
      const invoiceDate = extractInvoiceDateFromDOM();
      const result = findRateForDate(invoiceDate);
      state.exchangeRate = result?.rate ?? null;
      state.exchangeRateDate = result?.date ?? null;
    }

    // Re-resolver AR (depende de divisa)
    if (state.customer && state.allAccounts.length > 0) {
      state.arAccount = findBestARAccount(state.customer, divisa, state.allAccounts);
    }

    renderPanel();

    if (!state.hasOrderLinkage) {
      const rate = state.exchangeRate;
      fillTCById(rate);
      setTimeout(() => fillTCById(rate), 300);
      setTimeout(() => fillTCById(rate), 800);
      setTimeout(() => fillTCById(rate), 1500);
    }
  }

  function scanForInvoicePage() {
    // Detección por presencia del form RJSF (Steelhead no muestra heading con "Invoice"/"Factura"
    // en el editor; el nav lateral lo dice pero no sirve como ancla porque está siempre presente).
    // Heurística: hay form activo si existen inputs con id="root_DatosContables_*" o varios "root_*".
    const divisaInput = document.getElementById(RJSF_DIVISA_ID);
    const tcInput = document.getElementById(RJSF_TC_ID);
    const datosContablesAny = document.querySelector('[id^="root_DatosContables"]');
    const rjsfInputs = document.querySelectorAll('[id^="root_"]');
    const found = !!(divisaInput || tcInput || datosContablesAny || rjsfInputs.length >= 5);

    if (!found) {
      if (diagLoggedForUrl !== location.pathname) {
        diagLoggedForUrl = location.pathname;
        log(`InvoiceAutofill: form RJSF no detectado en ${location.pathname} (root_* inputs=${rjsfInputs.length}). Esperando que abras Create/Edit Invoice.`);
      }
      if (invoiceFormVisible) {
        invoiceFormVisible = false;
        headingLostAt = Date.now();
        removePanel();
      }
      return;
    }
    if (diagLoggedForUrl !== null) {
      log(`InvoiceAutofill: form RJSF detectado (root_* inputs=${rjsfInputs.length}, divisaInput=${!!divisaInput}, tcInput=${!!tcInput})`);
    }
    diagLoggedForUrl = null;

    if (!invoiceFormVisible) {
      invoiceFormVisible = true;
      const elapsed = Date.now() - headingLostAt;
      if (!lastDetectedCustomer || elapsed > 3000) {
        resetInvoiceState();
        log('Pantalla Invoice detectada');
      }
      renderPanel();
    }

    installDivisaListener();

    const currentCustomer = extractCustomerFromDOM();
    if (currentCustomer && currentCustomer !== lastDetectedCustomer) {
      lastDetectedCustomer = currentCustomer;
      lastDetectedDivisa = null;
      lastLineCount = -1;
      scriptSetDivisa = null;
      log(`Customer detectado/cambiado: ${currentCustomer}`);
      state.ready = false;
      runAutofill();
      return;
    } else if (!currentCustomer && !lastDetectedCustomer) {
      updatePanelStatus('pending', 'Esperando selección de cliente…');
      return;
    }

    // Fallback divisa monitor
    const currentDivisa = extractDivisaFromDOM();
    if (currentDivisa && currentDivisa !== lastDetectedDivisa && lastDetectedCustomer) {
      lastDetectedDivisa = currentDivisa;
      if (state.ready && currentDivisa !== state.currency) {
        log(`Divisa scan fallback (invoice): ${currentDivisa}`);
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
        if (state.customer && state.allAccounts.length > 0) {
          state.arAccount = findBestARAccount(state.customer, currentDivisa, state.allAccounts);
        }
        renderPanel();
        if (!state.hasOrderLinkage) {
          const rate = state.exchangeRate;
          fillTCById(rate);
          setTimeout(() => fillTCById(rate), 300);
          setTimeout(() => fillTCById(rate), 800);
          setTimeout(() => fillTCById(rate), 1500);
        }
        return;
      }
    }

    // Monitor line item changes
    if (lastDetectedCustomer && state.ready) {
      const lines = extractLinesFromDOM();
      if (lines.length !== lastLineCount) {
        lastLineCount = lines.length;
        if (lines.length > 0) {
          log(`Líneas cambiaron (invoice): ${lines.length}`);
          state.ready = false;
          runAutofill();
        }
      }
    }

    // Monitor Invoice Date changes — solo si la factura es manual
    if (lastDetectedCustomer && state.ready && !state.hasOrderLinkage && state.currency !== 'MXN') {
      const invoiceDate = extractInvoiceDateFromDOM();
      if (invoiceDate && invoiceDate !== lastDetectedInvoiceDate) {
        lastDetectedInvoiceDate = invoiceDate;
        const result = findRateForDate(invoiceDate);
        if (result && result.rate !== state.exchangeRate) {
          log(`Invoice Date: ${invoiceDate} → TC: ${result.rate} (del ${result.date})`);
          state.exchangeRate = result.rate;
          state.exchangeRateDate = result.date;
          fillTCById(result.rate);
          renderPanel();
        }
      }
    }
  }

  // ── Fetch Interceptor ──
  // v1: solo captura inbound, no inyecta outbound

  function patchFetch() {
    if (window.__saInvoiceAutofillFetchPatched) return;
    window.__saInvoiceAutofillFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      const opName = bodyObj?.operationName;
      const response = await origFetch.apply(this, args);

      try {
        const clone = response.clone();
        const json = await clone.json();
        handleIncomingResponse(opName, json);
      } catch (_) {}

      return response;
    };
  }

  function handleIncomingResponse(opName, json) {
    if (!json?.data) return;

    if (opName === 'InvoiceLowCodeData') {
      // Carga única que trae customer + accounts + product configs + TipoCambio
      const customer = json.data?.customerById
        || json.data?.customer
        || json.data?.invoiceLowCodeData?.customer
        || json.data?.invoiceLowCodeData?.customerById
        || null;
      if (customer && typeof customer === 'object') {
        state.customer = customer;
        state.customerId = customer.id || customer.customerId || null;
        state.customerName = customer.name || customer.shortName || customer.customerName || null;
        const customInputsKeys = Object.keys(customer.customInputs || {}).slice(0, 30).join(',');
        const hasCuentas = !!customer.customInputs?.DatosContables?.CuentasContables;
        const cuentasCount = customer.customInputs?.DatosContables?.CuentasContables?.length || 0;
        const taxName = customer?.salesTaxBySalesTaxId?.name || '(no en query)';
        const ruleResolved = resolveSalesTaxRule(customer);
        log(`InvoiceLowCodeData: customer hasCuentasContables=${hasCuentas} (n=${cuentasCount}) salesTax="${taxName}" → rule=${ruleResolved} customInputs.keys=[${customInputsKeys}]`);
      } else {
        const rootKeys = Object.keys(json.data || {}).slice(0, 20).join(', ');
        log(`InvoiceLowCodeData: customer no encontrado. data keys=[${rootKeys}]`);
      }
      const accounts = json.data?.allAcctAccounts?.nodes;
      if (Array.isArray(accounts)) state.allAccounts = accounts;
      const productConfigs = json.data?.allAcctProductAccountConfigs?.nodes;
      if (Array.isArray(productConfigs)) state.productAccountConfigs = productConfigs;
      // TipoCambio puede venir bajo varios paths
      const tipoCambio = json.data?.domainCustomInputs?.userByUserId?.domainByDomainId?.customInputs?.TipoCambio
        || json.data?.currentSession?.userByUserId?.domainByDomainId?.customInputs?.TipoCambio
        || [];
      if (Array.isArray(tipoCambio) && tipoCambio.length > 0) {
        state._tipoCambioArray = tipoCambio;
      }
      if (lastDetectedCustomer) {
        state.ready = false;
        setTimeout(() => runAutofill(), 800);
      }
    }

    if (opName === 'GetReceivedOrdersWithReceivedOrderLineItems') {
      const orders = json.data?.searchReceivedOrders?.nodes || [];
      if (orders.length > 0) {
        state.hasOrderLinkage = true;
        // Divisa canónica de la primera OV
        const firstDivisa = orders[0]?.customInputs?.divisa
          || orders[0]?.customInputs?.Divisa
          || null;
        if (firstDivisa) {
          state.receivedOrderDivisa = firstDivisa.toUpperCase();
          log(`SO Divisa: ${state.receivedOrderDivisa}`);
        }
      }
      // Esta query trae customer con salesTaxBySalesTaxId.name + idInDomain
      // (InvoiceLowCodeData NO los trae). Mergeamos siempre.
      const customer = json.data?.customerById;
      if (customer) {
        if (!state.customer) {
          state.customer = customer;
          state.customerId = customer.id || null;
          state.customerName = customer.name || customer.shortName || null;
        } else {
          if (customer.salesTaxBySalesTaxId) state.customer.salesTaxBySalesTaxId = customer.salesTaxBySalesTaxId;
          if (typeof customer.salesTaxable === 'boolean') state.customer.salesTaxable = customer.salesTaxable;
          if (customer.idInDomain != null && state.customer.idInDomain == null) state.customer.idInDomain = customer.idInDomain;
          if (customer.id != null && state.customer.id == null) state.customer.id = customer.id;
          if (customer.name && !state.customerName) state.customerName = customer.name;
        }
        log(`GetReceivedOrders: customer.salesTax="${customer?.salesTaxBySalesTaxId?.name || '?'}" idInDomain=${customer.idInDomain}`);
      }
      const accounts = json.data?.allAcctAccounts?.nodes;
      if (Array.isArray(accounts) && state.allAccounts.length === 0) state.allAccounts = accounts;
      const productConfigs = json.data?.allAcctProductAccountConfigs?.nodes;
      if (Array.isArray(productConfigs) && state.productAccountConfigs.length === 0) state.productAccountConfigs = productConfigs;
      if (lastDetectedCustomer) {
        state.ready = false;
        setTimeout(() => runAutofill(), 800);
      }
    }

    if (opName === 'PackingSlipsForInvoicing') {
      // Tener packing slips listados implica linkage; la divisa real sale de la OV vinculada
      const ps = json.data?.allPackingSlips?.nodes || [];
      if (ps.length > 0) state.hasOrderLinkage = true;
    }

    if (opName === 'InvoiceByIdInDomain') {
      const inv = json.data?.invoiceByIdInDomain;
      if (inv) {
        // Linkage: si tiene partsTransferEvent o relatedWorkOrders, está atada a OV/PS
        if (inv.partsTransferEventByInvoiceId
            || (inv.relatedWorkOrders?.nodes?.length > 0)) {
          state.hasOrderLinkage = true;
        }
        // Credit note: si trae DatosNotaCredito poblado, marca global
        const dnc = inv.customInputs?.DatosNotaCredito;
        if (dnc && Object.keys(dnc).length > 0) {
          state.isInvoiceCreditNote = true;
        }
        // Customer en InvoiceByIdInDomain (shape distinto: anidado bajo customerAddress)
        const cust = inv.customerAddressByCustomerAddressShipToId?.customerByCustomerId
          || inv.customerAddressByCustomerAddressBillToId?.customerByCustomerId
          || null;
        if (cust && !state.customer) {
          state.customer = cust;
          state.customerId = cust.id || null;
          state.customerName = cust.name || cust.shortName || null;
        }
        // exchangeRate ya guardado en customInputs
        const er = inv.customInputs?.exchangeRate;
        if (er && state.exchangeRate == null) state.exchangeRate = parseFloat(er);
        const dateStr = inv.invoicedAtAsDate;
        if (dateStr && !state.invoiceDate) state.invoiceDate = dateStr;
        // TipoCambio del dominio
        const tc = inv.domainByDomainId?.customInputs?.TipoCambio;
        if (Array.isArray(tc) && tc.length > 0 && !state._tipoCambioArray) {
          state._tipoCambioArray = tc;
        }
      }
    }
  }

  // ── Data Fetching (fallbacks si no se interceptó) ──

  async function fetchExchangeRate() {
    if (state._tipoCambioArray && state._tipoCambioArray.length > 0) {
      const r = findRateForDate(null);
      return r?.rate ?? null;
    }
    try {
      const data = await api().query('GetDomain', {}, 'GetDomain');
      const tipoCambio = data?.currentSession?.userByUserId?.domainByDomainId?.customInputs?.TipoCambio
        || data?.domain?.customInputs?.TipoCambio
        || data?.domainByDomainId?.customInputs?.TipoCambio
        || [];
      if (!Array.isArray(tipoCambio) || tipoCambio.length === 0) {
        warn('TipoCambio no encontrado (invoice)');
        return null;
      }
      state._tipoCambioArray = tipoCambio;
      const r = findRateForDate(null);
      return r?.rate ?? null;
    } catch (err) {
      warn('fetchExchangeRate (invoice) error: ' + err.message);
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

  async function fetchAllAccounts() {
    if (state.allAccounts.length > 0) return state.allAccounts;
    try {
      const data = await api().query('SearchAccounts', { searchQuery: '%%' }, 'SearchAccounts');
      const accounts = data?.searchAcctAccounts?.nodes || [];
      state.allAccounts = accounts;
      return accounts;
    } catch (err) {
      warn('fetchAllAccounts error: ' + err.message);
      return [];
    }
  }

  // ── Account Resolution ──

  function normalizeForMatch(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Resolución determinística de cuenta CXC:
  //   1. cuentas[] del customer.DatosContables filtradas por DivisaContable === currency
  //   2. orden descendente por CuentaContable (numeración más alta = más reciente)
  //   3. resolver id numérico vía allAccounts.accountNumber
  // TODO: filtro por EmpresaEmisora cuando aparezca un caso real con dos emisoras
  // Resolver de cuenta CXC contra el catálogo consolidado `allAcctAccounts`.
  //
  // `customer.customInputs.DatosContables.CuentasContables` es LEGACY del sistema
  // anterior (antes de consolidar las 3 razones sociales en un solo catálogo).
  // No se usa: escribir esos números en el react-select dispara "Create Account".
  //
  // Convención del catálogo consolidado (homologado entre razones sociales):
  // las cuentas AR terminan su `name` con la divisa, ej. "Clientes Generales USD",
  // "Clientes Generales MXN". Filtramos por categoría receivable y match por
  // sufijo `\bDIVISA\s*$` en el name. Los prefijos numéricos varían (0103-, 0105-)
  // por carga histórica — no se usan para filtrar.
  function findBestARAccount(_customer, currency, allAccounts) {
    const cur = String(currency || '').toUpperCase().trim();
    if (!cur) return { account: null, ambiguous: false, candidates: [], reason: 'sin_divisa' };

    const all = Array.isArray(allAccounts) ? allAccounts : [];
    const arPool = all.filter(a => /receivable/i.test(String(a?.acctAccountTypeByTypeId?.category || '')));
    // Si el shape no expone category (parser sin esa relación), usar todo el pool —
    // el match por sufijo de divisa es suficientemente específico.
    const pool = arPool.length > 0 ? arPool : all;
    if (pool.length === 0) {
      return { account: null, ambiguous: false, candidates: [], reason: 'allAcctAccounts_vacio' };
    }

    const re = new RegExp(`\\b${cur}\\s*$`, 'i');
    const matches = pool.filter(a => re.test(String(a?.name || '')));

    if (matches.length === 0) {
      return {
        account: null,
        ambiguous: false,
        candidates: arPool.map(a => ({ id: a.id, accountNumber: a.accountNumber, name: a.name })),
        reason: `sin_cuenta_AR_para_${cur}`,
        currencyHint: cur
      };
    }

    // Tie-break por accountNumber más alto si quedaron duplicados históricos.
    matches.sort((a, b) => String(b.accountNumber || '').localeCompare(String(a.accountNumber || '')));
    const winner = matches[0];
    return {
      account: { id: winner.id, accountNumber: winner.accountNumber, name: winner.name },
      ambiguous: matches.length > 1,
      candidates: matches.map(m => ({ id: m.id, accountNumber: m.accountNumber, name: m.name })),
      reason: null,
      currencyHint: cur
    };
  }

  // El flag relevante NO es `customer.salesTaxable` (siempre true: indica que el cliente
  // tiene un impuesto asignado), sino *cuál* impuesto del catálogo está asignado:
  // `customer.salesTaxBySalesTaxId.name` viene del catálogo de SalesTaxes del dominio.
  // Convenciones del dominio Ecoplating:
  //   - "Ventas Nacionales con Impuestos" → general (IVA 16%, prefijo 0401-0001 / 0402-0001)
  //   - "Ventas Exentas sin impuestos"   → exenta (Tasa 0%, prefijo 0401-0004 / 0402-0002)
  // Devuelve 'general' | 'exenta' | null (null = no se pudo determinar).
  function resolveSalesTaxRule(customer) {
    if (!customer) return null;
    const taxName = customer?.salesTaxBySalesTaxId?.name
      || customer?.customerAddressesByCustomerId?.nodes?.[0]?.salesTaxBySalesTaxId?.name
      || null;
    if (typeof taxName !== 'string' || !taxName.trim()) return null;
    const s = taxName.toLowerCase();
    if (/exent|sin\s*impuest|tasa\s*0|cero|0\s*%|export/.test(s)) return 'exenta';
    if (/nacional|general|gravad|con\s*impuest|iva|16\s*%/.test(s)) return 'general';
    return null;
  }

  // Cuenta de ingreso/descuento por línea
  function resolveLineAccount({ lineAmount, customer, productId, allAccounts, productConfigs, isCreditNoteGlobal }) {
    const rule = resolveSalesTaxRule(customer);
    const isCredit = isCreditNoteGlobal || (typeof lineAmount === 'number' && lineAmount < 0);

    if (rule === null) {
      // Sin regla determinada no proponemos cuenta para evitar default silencioso.
      return {
        account: null,
        expected: null,
        productSuggested: null,
        mismatch: false,
        isCredit,
        targetPrefix: null,
        source: 'unresolved',
        reason: 'sin_salesTax_en_query'
      };
    }
    const isGeneral = rule === 'general';

    let targetPrefix;
    if (isCredit) {
      targetPrefix = isGeneral ? PREFIX_DESC_GENERAL : PREFIX_DESC_CERO;
    } else {
      targetPrefix = isGeneral ? PREFIX_VENTAS_GENERAL : PREFIX_VENTAS_CERO;
    }

    const expected = allAccounts.find(a => String(a.accountNumber || '').startsWith(targetPrefix));

    let productSuggested = null;
    if (productId != null) {
      const pc = (productConfigs || []).find(c =>
        c.productId === productId
        && (isCredit ? c.context === 'INVOICE_DISCOUNT' : c.context === 'INVOICE_INCOME')
      );
      if (pc) {
        productSuggested = allAccounts.find(a => a.id === pc.acctAccountId) || null;
      }
    }

    const mismatch = !!(productSuggested && expected && productSuggested.id !== expected.id);

    return {
      account: expected || productSuggested || null,
      expected,
      productSuggested,
      mismatch,
      isCredit,
      targetPrefix,
      source: !expected ? 'unresolved' : (mismatch ? 'override' : (productSuggested ? 'product-default' : 'rule'))
    };
  }

  // ── DOM Extraction ──

  function extractCustomerFromDOM() {
    // 1. Heading principal: "Creating Invoice for X" / "Editing Invoice for X"
    //    El h1/h2 puede contener botones anexos ("View Customer Custom Inputs",
    //    "Edit Power Tools", "Total: $X"). Usamos el primer text node directo
    //    del heading (pre-children) para obtener solo "Creating Invoice for X".
    const headings = document.querySelectorAll('h1, h2, h3, h4, [class*="MuiTypography-h"], [class*="heading"]');
    for (const h of headings) {
      let txt = '';
      // Concatenar solo text nodes directos (no descender en buttons/spans inline)
      for (const node of h.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          txt += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // Aceptar spans inline que parezcan parte del título (no buttons/links)
          const tag = node.tagName?.toLowerCase();
          if (tag === 'span' || tag === 'em' || tag === 'strong' || tag === 'b') {
            txt += ' ' + (node.textContent || '');
          } else {
            break;
          }
        }
      }
      txt = txt.trim();
      // Fallback: si no hubo text nodes directos, usa textContent y luego corta
      // en separadores conocidos
      if (!txt) txt = h.textContent?.trim() || '';
      const m = txt.match(/^(?:creating|editing|create|edit|new)\s+invoice\s+for\s+(.+?)$/i);
      if (m && m[1]) {
        let name = m[1].trim();
        // Si vemos botones contaminando ("MOGULView Customer..."), insertar espacios
        // en boundaries CamelCase y luego split por keywords de botones
        if (/View\s*Customer|Edit\s*Power|Power\s*Tools|Total\s*:|\$\d/i.test(name)) {
          name = name
            .replace(/([a-z])([A-Z])/g, '$1 $2')          // mogULView → mogUL View
            .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');    // MOGULView → MOGUL View
          name = name.split(/\bView\b|\bEdit\b|\bPower\s+Tools|\bTotal\s*:|\$\d/i)[0].trim();
        }
        if (name.length > 1 && name.length < 200) return name;
      }
    }
    // 2. Fallback: Select con label "Customer:"/"Cliente:" (raro en invoice; suele venir
    //    pre-cargado del SO, no editable)
    const singleValues = document.querySelectorAll('[class*="singleValue"], [class*="SingleValue"]');
    for (const sv of singleValues) {
      let parent = sv.parentElement;
      for (let depth = 0; depth < 8 && parent; depth++) {
        for (const child of parent.children) {
          if (child.contains(sv)) continue;
          const txt = child.textContent?.trim() || '';
          if (/^customer:?$|^cliente:?$/i.test(txt)) {
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

  // Extrae el customer.idInDomain de un link "View Customer" / "Customer Custom Inputs"
  // cercano al heading. La URL canon es /Domains/{N}/Customers/{idInDomain}/...
  function extractCustomerIdInDomainFromDOM() {
    const anchors = document.querySelectorAll('a[href*="/Customers/"]');
    for (const a of anchors) {
      const m = a.getAttribute('href')?.match(/\/Domains\/\d+\/Customers\/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // Fetch del customer vía persisted query "Customer" para obtener salesTaxable.
  // Cacheado por idInDomain para evitar refetch en cada runAutofill.
  const _customerCache = new Map();
  async function fetchCustomerSalesTaxable(idInDomain) {
    if (idInDomain == null) return null;
    if (_customerCache.has(idInDomain)) return _customerCache.get(idInDomain);
    try {
      const data = await SteelheadAPI.query('Customer', { idInDomain, includeAccountingFields: true });
      const c = data?.customerByIdInDomain || null;
      _customerCache.set(idInDomain, c);
      return c;
    } catch (err) {
      warn(`Customer query falló (idInDomain=${idInDomain}): ${err.message}`);
      _customerCache.set(idInDomain, null);
      return null;
    }
  }

  function extractDivisaFromDOM() {
    const singleValues = document.querySelectorAll('[class*="singleValue"], [class*="SingleValue"]');
    for (const sv of singleValues) {
      if (sv.closest('#sa-invoice-autofill-panel')) continue;
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
    for (const select of document.querySelectorAll('select')) {
      if (select.closest('#sa-invoice-autofill-panel')) continue;
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
      if (inp.closest('#sa-invoice-autofill-panel')) continue;
      let parent = inp.parentElement;
      for (let d = 0; d < 5 && parent; d++) {
        for (const child of parent.children) {
          if (child.contains(inp)) continue;
          const txt = child.textContent?.trim() || '';
          if (/^invoice\s*date:?$/i.test(txt) || /^fecha.*factura:?$/i.test(txt) || /^invoiced\s*at:?$/i.test(txt)) {
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

  function findLineItemsSection() {
    const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div,p');
    for (const h of headings) {
      if (/line\s*items?|invoice\s*lines|l[ií]neas/i.test(h.textContent?.trim())) {
        return h.closest('section') || h.parentElement?.parentElement || h.parentElement;
      }
    }
    return document.querySelector('main') || document.querySelector('[class*="content"]');
  }

  // Cada línea de invoice se renderiza como un bloque cuyo encabezado dice
  // "Line #N - PN  Description: …  Total: $X". Encontramos esos encabezados,
  // de cada uno subimos al contenedor de la línea (el ancestor más bajo que
  // contenga el React Select "INCOME"), y dentro extraemos PN y total.
  function extractLinesFromDOM() {
    const lines = [];
    const seen = new Set();
    const candidates = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div');
    for (const el of candidates) {
      if (el.closest('#sa-invoice-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      // Filtrar elementos demasiado grandes (descendientes envueltos)
      if (txt.length > 400) continue;
      // PNs son alfanuméricos en mayúsculas; el regex permisivo capturaba el header
      // "Description:" pegado al PN (sin whitespace en textContent). Restringir a [A-Z0-9].
      const m = txt.match(/Line\s*#(\d+)\s*-\s*([A-Z0-9._\-/]+)/);
      if (!m) continue;
      const lineNum = parseInt(m[1], 10);
      const pn = m[2];
      // Container de la línea: ancestor más bajo que contenga la subtítulo "INCOME"
      // (cada línea tiene su propio Income Account select).
      let container = el.parentElement;
      let incomeLabel = null;
      for (let d = 0; d < 12 && container; d++) {
        incomeLabel = [...container.querySelectorAll('p,span,div,label')].find(p => {
          if (p.closest('#sa-invoice-autofill-panel')) return false;
          const t = p.textContent?.trim() || '';
          return /^income$/i.test(t);
        });
        if (incomeLabel) break;
        container = container.parentElement;
      }
      if (!container || !incomeLabel) continue;
      const key = `${lineNum}-${pn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Total: monto en el heading o cercano, formato "$1,234.56"
      const totalMatch = container.textContent.match(/Total:\s*\$?\s*(-?[\d,]+(?:\.\d+)?)/i);
      const amount = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : null;
      lines.push({ name: pn, lineNumber: lineNum, container, incomeLabel, amount });
    }
    return lines;
  }

  // Intenta inferir el monto de la línea a partir de quantity × price del row más cercano
  function extractLineAmount(nameInput) {
    let row = nameInput.closest('tr') || nameInput.closest('[role="row"]');
    if (!row) {
      let p = nameInput.parentElement;
      for (let d = 0; d < 8 && p; d++) {
        if (p.querySelectorAll('input[type="number"]').length >= 2) { row = p; break; }
        p = p.parentElement;
      }
    }
    if (!row) return null;
    const numInputs = [...row.querySelectorAll('input[type="number"], input')]
      .filter(i => i !== nameInput && i.value?.trim() && /^-?\d+([.,]\d+)?$/.test(i.value.trim()));
    if (numInputs.length < 2) return null;
    const nums = numInputs.map(i => parseFloat(i.value.replace(',', '.')));
    // Heurística simple: producto de los dos primeros valores numéricos válidos
    if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
      return nums[0] * nums[1];
    }
    return null;
  }

  // ── Combobox Interaction (idéntico a bill-autofill) ──

  async function tryFillCombobox(labelText, searchText, targetAccountName) {
    const labelRe = typeof labelText === 'string' ? new RegExp(labelText, 'i') : labelText;
    let labelEl = null;

    const labels = document.querySelectorAll('label, span, div, p');
    for (const el of labels) {
      if (el.closest('#sa-invoice-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      if (txt.length > 40) continue;
      if (!labelRe.test(txt)) continue;
      labelEl = el;
      break;
    }

    if (!labelEl) return { success: false, method: 'fallback', reason: 'label no encontrado' };

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
        const tracker = sel._valueTracker;
        if (tracker) tracker.setValue('');
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
      // CRITICAL: Steelhead muestra "Create…" como opción cuando no hay match.
      // Clickearla abre el modal "Create Account" y registra basura. Nunca elegirla.
      if (/^\s*(create|crear|nuev[oa])\b/i.test(text) || /create\s+new/i.test(text)) continue;
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
      if (el.closest('#sa-invoice-autofill-panel')) continue;
      const txt = el.textContent?.trim() || '';
      if (txt.length > 30) continue;
      if (!labelRe.test(txt)) continue;

      let parent = el;
      for (let d = 0; d < 5 && parent; d++) {
        const inp = parent.querySelector('input[type="text"], input[type="number"], input:not([type])');
        if (inp) {
          const tracker = inp._valueTracker;
          if (tracker) tracker.setValue('');
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

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Fill: cuenta de ingreso/descuento por línea ──

  // El layout no es <table>: cada línea tiene un sub-grid donde el Income Account
  // se identifica por una <p>INCOME</p> italic adyacente al React Select.
  // Localizamos el control subiendo del label "INCOME" hasta encontrar un control
  // de react-select.
  async function tryFillIncomeInLine(line, searchText, targetAccountName) {
    const incomeLabel = line.incomeLabel;
    const container = line.container;
    if (!incomeLabel || !container) {
      return { success: false, method: 'fallback', reason: `container/incomeLabel ausente para "${line.name}"` };
    }
    // El subtítulo INCOME suele estar dentro o debajo del campo. Subimos hasta
    // encontrar un ancestor que tenga input[role="combobox"] (el control del select).
    let host = incomeLabel.parentElement;
    let control = null;
    for (let d = 0; d < 8 && host; d++) {
      const combo = host.querySelector('input[role="combobox"]');
      if (combo) {
        control = combo.closest('[class*="-control"]') || combo.parentElement;
        break;
      }
      host = host.parentElement;
    }
    if (!control) {
      return { success: false, method: 'fallback', reason: `combobox de Income no encontrado para "${line.name}"` };
    }
    return await clickAndSelectOption(control, host, searchText, targetAccountName);
  }

  // ── Fill: cuenta AR por subtítulo italic <p>ACCOUNTS_RECEIVABLE</p> ──

  // El label visible "AR Account:" agarra el primer combobox del DOM (Terms/BillTo)
  // cuando se sube por el árbol. Steelhead renderiza un subtítulo italic
  // <p>ACCOUNTS_RECEIVABLE</p> debajo del react-select específico de AR — usamos eso
  // como ancla precisa, igual que <p>INCOME</p> para líneas.
  async function tryFillARBySubtitle(searchText, targetAccountName) {
    const subtitle = [...document.querySelectorAll('p,span,div,label')].find(p => {
      if (p.closest('#sa-invoice-autofill-panel')) return false;
      const t = p.textContent?.trim() || '';
      return /^accounts?_?receivable$/i.test(t);
    });
    if (!subtitle) {
      return { success: false, method: 'fallback', reason: 'subtítulo ACCOUNTS_RECEIVABLE no encontrado' };
    }
    let host = subtitle.parentElement;
    let control = null;
    for (let d = 0; d < 8 && host; d++) {
      const combo = host.querySelector('input[role="combobox"]');
      if (combo) {
        control = combo.closest('[class*="-control"]') || combo.parentElement;
        break;
      }
      host = host.parentElement;
    }
    if (!control) {
      return { success: false, method: 'fallback', reason: 'combobox AR no encontrado bajo subtítulo' };
    }
    return await clickAndSelectOption(control, host, searchText, targetAccountName);
  }

  // ── Fill All Fields ──

  async function fillAllFields() {
    const results = {};

    // Divisa+TC: solo si la factura es manual (sin OV/packing slip)
    if (!state.hasOrderLinkage) {
      if (state.currency) {
        results.currency = await tryFillCombobox('divisa.*factura|divisa|currency', state.currency, state.currency);
        if (results.currency?.success) scriptSetDivisa = state.currency;
        log(`Fill divisa (invoice): ${JSON.stringify(results.currency)}`);
      }
      if (state.exchangeRate != null) {
        results.exchangeRate = await tryFillTextInput('tipo de cambio|exchange rate', state.exchangeRate);
        log(`Fill TC (invoice): ${JSON.stringify(results.exchangeRate)}`);
      }
    } else {
      log('Factura con linkage a OV/PS — divisa y TC respetados, no se tocan');
    }

    // Cuenta CXC: solo si pudimos resolverla contra `allAcctAccounts` por sufijo
    // de divisa. El search es el accountNumber (más específico para el filtro
    // del react-select, que matchea contra el texto "0105-... · Clientes USD").
    if (state.arAccount?.account?.accountNumber) {
      const acc = state.arAccount.account;
      const search = acc.accountNumber || acc.name;
      results.arAccount = await tryFillARBySubtitle(search, acc.name || acc.accountNumber);
      if (!results.arAccount?.success) {
        log(`Fill AR (subtitle path): ${JSON.stringify(results.arAccount)} — fallback a label`);
        results.arAccount = await tryFillCombobox(
          'cuenta.*cobrar|accounts?\\s*receivable|a\\/?r\\s*account|cuenta.*recibir',
          search, acc.name || acc.accountNumber
        );
      }
      log(`Fill AR: ${JSON.stringify(results.arAccount)}`);
    }

    // Cuentas de ingreso/descuento por línea
    for (let i = 0; i < state.lineAccounts.length; i++) {
      const line = state.lineAccounts[i];
      if (!line.account) continue;
      const acc = line.account;
      const search = acc.accountNumber || acc.name?.split(' ')[0] || acc.name;
      results[`line_${i}`] = await tryFillIncomeInLine(line, search, acc.name || acc.accountNumber);
      log(`Fill income line ${i} "${line.name}": ${JSON.stringify(results[`line_${i}`])}`);
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
    updatePanelStatus('pending', 'Analizando…');

    const customerName = lastDetectedCustomer || extractCustomerFromDOM();
    if (!customerName) {
      updatePanelStatus('pending', 'Esperando selección de cliente…');
      return;
    }

    // salesTaxBySalesTaxId.name no viene en InvoiceLowCodeData. Si tampoco vino por
    // GetReceivedOrders (factura manual sin OV), disparamos la persisted query "Customer".
    if (resolveSalesTaxRule(state.customer) === null) {
      const idInDomain = state.customer?.idInDomain || extractCustomerIdInDomainFromDOM();
      if (idInDomain != null) {
        log(`Fetching Customer(idInDomain=${idInDomain}) para resolver salesTax`);
        const fetched = await fetchCustomerSalesTaxable(idInDomain);
        if (fetched) {
          if (!state.customer) state.customer = fetched;
          else {
            if (fetched.salesTaxBySalesTaxId) state.customer.salesTaxBySalesTaxId = fetched.salesTaxBySalesTaxId;
            if (typeof fetched.salesTaxable === 'boolean') state.customer.salesTaxable = fetched.salesTaxable;
            if (state.customer.idInDomain == null) state.customer.idInDomain = fetched.idInDomain;
            // CuentasContables del Customer query es más completo si InvoiceLowCodeData no las trajo
            if (!state.customer.customInputs?.DatosContables?.CuentasContables
                && fetched.customInputs?.DatosContables?.CuentasContables) {
              state.customer.customInputs = state.customer.customInputs || {};
              state.customer.customInputs.DatosContables = fetched.customInputs.DatosContables;
            }
          }
          log(`Customer query resuelto: salesTax="${fetched?.salesTaxBySalesTaxId?.name || '?'}" → rule=${resolveSalesTaxRule(fetched)}`);
        }
      } else {
        log('No se pudo determinar customer.idInDomain — salesTax queda pendiente');
      }
    }

    // Asegurar TC y accounts (preferir intercepted, fallback a fetch)
    let exchangeData;
    let accountsData = state.allAccounts;
    try {
      [exchangeData, accountsData] = await Promise.all([
        fetchExchangeRate().catch(err => { warn('fetchExchangeRate (invoice) catch: ' + err.message); return null; }),
        accountsData.length > 0 ? Promise.resolve(accountsData) : fetchAllAccounts()
      ]);
    } catch (err) {
      updatePanelStatus('error', 'Error fetching datos: ' + err.message);
      return;
    }
    state.allAccounts = accountsData;

    // Divisa: prioridad post-fill DOM → SO → DOM (pre-fill) → customer flags → default
    const divisaPostFill = scriptSetDivisa ? extractDivisaFromDOM() : null;
    const currencyFromSO = state.receivedOrderDivisa;
    const divisaPreFill = !divisaPostFill && !currencyFromSO ? extractDivisaFromDOM() : null;
    const currencyFromCustomer = inferCurrencyFromCustomer(state.customer);
    const currency = divisaPostFill || currencyFromSO || divisaPreFill || currencyFromCustomer || 'USD';
    const currencySource = divisaPostFill ? 'form'
      : currencyFromSO ? 'so'
      : divisaPreFill ? 'form'
      : currencyFromCustomer ? 'customer'
      : 'default';

    // TC
    let exchangeRate;
    let exchangeRateDate = null;
    if (currency === 'MXN') {
      exchangeRate = 1;
    } else {
      const invoiceDate = state.invoiceDate || extractInvoiceDateFromDOM();
      if (invoiceDate) {
        const result = findRateForDate(invoiceDate);
        exchangeRate = result?.rate ?? exchangeData;
        exchangeRateDate = result?.date ?? null;
      } else {
        exchangeRate = exchangeData;
        const today = new Date().toISOString().slice(0, 10);
        const r = findRateForDate(today);
        exchangeRateDate = r?.date ?? null;
      }
    }
    log(`Divisa (invoice): ${currency} (${currencySource}), TC: ${exchangeRate}`);

    // AR account
    const arResult = findBestARAccount(state.customer, currency, accountsData);

    // Lines + cuenta de ingreso/descuento por línea
    const lines = extractLinesFromDOM();
    const lineAccounts = lines.map(line => {
      const resolved = resolveLineAccount({
        lineAmount: line.amount,
        customer: state.customer,
        productId: null,           // v1: no enlazamos a productId del DOM (la regla por prefijo gana igual)
        allAccounts: accountsData,
        productConfigs: state.productAccountConfigs,
        isCreditNoteGlobal: state.isInvoiceCreditNote
      });
      return { ...line, ...resolved };
    });

    state = {
      ...state,
      customerName,
      currency,
      currencySource,
      exchangeRate,
      exchangeRateDate,
      arAccount: arResult,
      lineAccounts,
      ready: true
    };

    await fillAllFields();

    const domDivisaAfterFill = extractDivisaFromDOM();
    if (domDivisaAfterFill) lastDetectedDivisa = domDivisaAfterFill;

    renderPanel();
    log(`InvoiceAutofill listo: customer="${customerName}" currency=${currency} rate=${exchangeRate} ar="${arResult.account?.accountNumber}" lines=${lineAccounts.length}`);
  }

  function inferCurrencyFromCustomer(customer) {
    if (!customer) return null;
    const dc = customer.customInputs?.DatosContables;
    if (!dc) return null;
    if (dc.DivisaUSD && !dc.DivisaMXN) return 'USD';
    if (dc.DivisaMXN && !dc.DivisaUSD) return 'MXN';
    return null;
  }

  // ── Panel UI ──

  const STATUS_COLORS = { done: '#4CAF50', warn: '#ff9800', error: '#f44336', learned: '#2196F3', pending: '#999' };
  const STATUS_ICONS  = { done: '✓', warn: '~', error: '✗', learned: '★', pending: '…' };

  function renderPanel() {
    let panel = document.getElementById('sa-invoice-autofill-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sa-invoice-autofill-panel';
      panel.style.cssText = [
        'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:99999', 'background:#1e293b', 'color:#e2e8f0', 'border-radius:10px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)', 'font-family:system-ui,sans-serif',
        'font-size:13px', 'min-width:260px', 'max-width:360px'
      ].join(';');
      document.body.appendChild(panel);
    }

    const collapsed = panel.dataset.collapsed === 'true';

    let html = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #334155;cursor:pointer;" id="sa-iaf-header">
        <span style="font-weight:700;font-size:14px;letter-spacing:.3px;">Invoice Autofill</span>
        <span style="font-size:16px;color:#94a3b8;">${collapsed ? '▲' : '▼'}</span>
      </div>`;

    if (!collapsed) {
      html += `<div style="padding:12px 14px;">`;

      const customerStatus = state.customerName ? 'done' : 'pending';
      html += renderRow('Cliente', state.customerName || '—', customerStatus);

      const linkageLabel = state.hasOrderLinkage ? 'OV/Packing Slip' : 'Manual / Nota de Crédito';
      html += renderRow('Tipo de factura', linkageLabel, 'done');

      const divisaStatus = !state.currency ? 'pending' : state.currencySource === 'default' ? 'warn' : 'done';
      const divisaSources = { form: ' (del form)', so: ' (de OV)', customer: ' (del cliente)', default: ' (default)' };
      const divisaSuffix = divisaSources[state.currencySource] || '';
      const divisaLabel = state.currency ? `${state.currency}${divisaSuffix}` : '—';
      html += renderRow('Divisa', divisaLabel, divisaStatus);

      const tcLabel = state.exchangeRate != null
        ? `$${Number(state.exchangeRate).toFixed(4)}${state.exchangeRateDate ? ` (${state.exchangeRateDate})` : ''}`
        : '—';
      html += renderRow('Tipo de Cambio', tcLabel, state.exchangeRate != null ? 'done' : 'pending');

      const ar = state.arAccount;
      let arLabel = '—';
      let arStatus = 'pending';
      if (ar?.account?.accountNumber) {
        arLabel = `${ar.account.accountNumber} · ${ar.account.name || ''}`.trim();
        if (ar.ambiguous) arLabel += ` (${ar.candidates.length} candidatas, mayor #)`;
        arStatus = ar.ambiguous ? 'warn' : 'done';
      } else if (ar?.reason) {
        arLabel = `No resuelto: ${ar.reason}`;
        arStatus = 'error';
      }
      html += renderRow('Cuenta CXC', arLabel, arStatus);

      if (state.lineAccounts.length > 0) {
        html += `<div style="border-top:1px solid #334155;margin:8px 0 6px;padding-top:6px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Cuenta por línea</div>`;
        for (const line of state.lineAccounts) {
          const status = !line.account ? 'warn' : 'done';
          let lbl;
          if (line.account) {
            lbl = line.account.name || line.account.accountNumber;
          } else if (line.reason === 'sin_salesTax_en_query') {
            lbl = 'Pendiente: salesTax del cliente no resuelto';
          } else if (line.targetPrefix) {
            lbl = `No resuelto (${line.targetPrefix})`;
          } else {
            lbl = 'No resuelto';
          }
          if (line.mismatch && line.productSuggested) {
            const from = line.productSuggested.accountNumber || line.productSuggested.name;
            const to = line.expected?.accountNumber || line.expected?.name;
            lbl += ` (corregido: ${from} → ${to})`;
          }
          if (line.isCredit && line.account) lbl += ' [NC]';
          html += renderRow(line.name || '(sin nombre)', lbl, status);
        }
      }

      html += `<div style="text-align:center;padding-top:8px;border-top:1px solid #334155;margin-top:6px;"><span id="sa-iaf-refresh" style="cursor:pointer;color:#64748b;font-size:11px;letter-spacing:.3px;">↻ actualizar</span></div>`;
      html += `</div>`;
    }

    panel.innerHTML = html;

    panel.querySelector('#sa-iaf-header').addEventListener('click', () => {
      panel.dataset.collapsed = collapsed ? 'false' : 'true';
      renderPanel();
    });

    const refreshBtn = panel.querySelector('#sa-iaf-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        state.ready = false;
        runAutofill();
      });
    }
  }

  function renderRow(label, value, status) {
    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
    const icon = STATUS_ICONS[status] || '·';
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
    const panel = document.getElementById('sa-invoice-autofill-panel');
    if (panel) panel.remove();
  }

  function updatePanelStatus(status, message) {
    let panel = document.getElementById('sa-invoice-autofill-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sa-invoice-autofill-panel';
      panel.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#1e293b;color:#e2e8f0;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;font-size:13px;padding:12px 14px;min-width:220px;';
      document.body.appendChild(panel);
    }
    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
    panel.innerHTML = `<span style="font-weight:700;">Invoice Autofill</span> <span style="color:${color};margin-left:8px;">${escHtml(message)}</span>`;
  }

  return { init, runAutofill };
})();

if (typeof window !== 'undefined') {
  window.InvoiceAutofill = InvoiceAutofill;
  InvoiceAutofill.init();
}
