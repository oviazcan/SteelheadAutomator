// Invoice Auto-Regenerate
// Detecta facturas timbradas con PDF pre-timbre y ofrece regenerar bajo demanda
// vía botón en el header del dashboard. Para regenerar usa el flujo DOM-driven
// (click programático al icono RestorePageOutlinedIcon + CONFIRMAR + history.back).
//
// Comportamiento:
//   1. Dashboard: detector marca pendientes, muestra banner "N pendientes — Regenerar PDFs"
//      al lado del título Invoices. Click → batch serial con overlay+stop.
//   2. Modal abierto manualmente: si la factura está pendiente, dispara la regen
//      en automático sin cerrar el modal — el usuario está ahí mirando.
//
// Depends on: SteelheadAPI

const InvoiceAutoRegen = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  let enabled = true;
  let _origFetch = null;

  // Registry de sha256Hash por operationName, llenado en tiempo real desde el
  // interceptor. Vive en window para sobrevivir doble-load del script.
  const hashRegistry = window.__autoRegenHashRegistryMap || (window.__autoRegenHashRegistryMap = new Map());

  // ── Estado ──
  // Resultado del último pull activo. Se sobreescribe cada vez — NO se acumula.
  // El banner y startRun leen de aquí. null = "todavía no hay info" o "degraded".
  let lastPullResult = null;        // Array<{invoiceId, idInDomain}> | null
  let lastPullAt = 0;               // ms epoch del último pull exitoso
  let _pullInFlight = null;         // Promise compartido para evitar pulls concurrentes
  let _pullDegraded = false;        // true tras 3 fallos consecutivos
  let _pullConsecFailures = 0;
  const PULL_THROTTLE_MS = 30 * 1000;
  const PULL_WINDOW_DAYS = 7;
  const PULL_PAGE_SIZE = 50;
  const PULL_MAX_PAGES = 5;

  // facturas regeneradas exitosamente — el detector ignora estas aunque
  // ActiveInvoicesPaged siga reportándolas como pendientes (eventual consistency).
  // Persistido en localStorage con TTL para sobrevivir reloads. Map: invoiceId → timestamp(ms).
  const RECENT_KEY = 'sa_autoregen_recently_regenerated';
  const RECENT_TTL_MS = 3 * 60 * 1000; // 3 min — solo cubre eventual consistency post-regen
  const recentlyRegenerated = new Map();
  function _persistRecent() {
    try {
      const obj = {};
      for (const [k, v] of recentlyRegenerated.entries()) obj[k] = v;
      localStorage.setItem(RECENT_KEY, JSON.stringify(obj));
    } catch (_) { /* quota/disabled — silencioso */ }
  }
  function _hydrateRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      let kept = 0, expired = 0;
      // Object.keys() siempre da strings; normalizamos todo el ciclo a string
      // para no desalinear con inv.id (string en GraphQL ID!).
      for (const k of Object.keys(obj)) {
        const ts = Number(obj[k]) || 0;
        if (now - ts < RECENT_TTL_MS) { recentlyRegenerated.set(k, ts); kept++; }
        else { expired++; }
      }
      if (kept || expired) console.log(`[AutoRegen] Set persistido cargado: ${kept} vigentes, ${expired} expiradas`);
      if (expired) _persistRecent();
    } catch (_) { /* corrupto — ignorar */ }
  }
  function markRegenerated(invoiceId) {
    recentlyRegenerated.set(String(invoiceId), Date.now());
    _persistRecent();
  }
  function isRecentlyRegenerated(invoiceId) {
    const key = String(invoiceId);
    const ts = recentlyRegenerated.get(key);
    if (!ts) return false;
    if (Date.now() - ts >= RECENT_TTL_MS) {
      recentlyRegenerated.delete(key);
      _persistRecent();
      return false;
    }
    return true;
  }

  // Estado del run en curso (batch del banner)
  const runState = {
    active: false,
    total: 0,
    index: 0,                 // 1-based
    current: null,            // {invoiceId, idInDomain}
    stopRequested: false
  };

  // Modal-auto-regen en flight (cuando el usuario abre una factura pendiente)
  let modalAutoRegenActive = false;

  // ── Init ──

  function init() {
    enabled = document.documentElement.dataset.saAutoRegenEnabled !== 'false';
    if (!enabled) { console.log('[AutoRegen] Deshabilitado'); return; }
    if (window.__saAutoRegenInitDone) {
      console.log('[AutoRegen] Ya estaba inicializado en esta página — skip (registry compartido)');
      return;
    }
    window.__saAutoRegenInitDone = true;
    _hydrateRecent();
    patchFetch();
    installLock();
    setupBannerObserver();

    // Trigger (c): re-enfocar el tab dispara pull (con throttle propio en pullPendingCount).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (runState.active) return; // no interferir con batch
      pullPendingCount(); // throttle a 30s aplica internamente
    });

    // Trigger (a): primer disparo. Si todavía no hay template aprendido, pullPendingCount
    // imprime un log informativo y retorna null — el siguiente ActiveInvoicesPaged del UI
    // (trigger d) lo activa.
    pullPendingCount();

    console.log('[AutoRegen] Inicializado');
  }

  // ── Fetch Interceptor ──

  function patchFetch() {
    if (window.__saAutoRegenPatched) return;
    window.__saAutoRegenPatched = true;
    _origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return _origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return _origFetch.apply(this, args); }
      const opName = bodyObj?.operationName;

      // Captura sha256Hash de toda op que pasa para tener registry siempre fresco.
      const _h = bodyObj?.extensions?.persistedQuery?.sha256Hash;
      if (opName && _h) {
        hashRegistry.set(opName, _h);
        try { window.__autoRegenHashRegistry = Object.fromEntries(hashRegistry); } catch {}
      }

      // Snapshot de variables de ActiveInvoicesPaged como template para pullPendingCount.
      // Se sobreescribe en cada pasada — siempre queremos el template más reciente.
      if (opName === 'ActiveInvoicesPaged' && bodyObj?.variables) {
        try {
          window.__autoRegenLastVars = window.__autoRegenLastVars || {};
          window.__autoRegenLastVars.ActiveInvoicesPaged = JSON.parse(JSON.stringify(bodyObj.variables));
        } catch (_) { /* shape rara — ignorar */ }
      }

      // Captura payload completo de GetPdfTemplateOutputToUserFile (renderer del PDF).
      // Útil para diagnóstico/dumpManualPair pero no requerido por el flujo DOM-driven.
      if (opName === 'GetPdfTemplateOutputToUserFile') {
        try {
          const doc0 = bodyObj?.variables?.docs?.[0];
          if (doc0?.data) {
            const idInDomain = doc0.data.idInDomain;
            window.__lastManualPdfData = window.__lastManualPdfData || {};
            window.__lastManualPdfData[idInDomain] = doc0.data;
            window.__lastManualPdfDataLatest = doc0.data;
            const rawForId = (window.__lastRawInvoice || {})[idInDomain];
            window.__lastManualPdfPair = window.__lastManualPdfPair || {};
            window.__lastManualPdfPair[idInDomain] = { raw: rawForId || null, pdfData: doc0.data };
          }
        } catch (e) { /* no fatal */ }
      }

      const response = await _origFetch.apply(this, args);

      // Hook para regenViaModal: resolver Promise pendiente al ver CreateInvoicePdf
      if (opName === 'CreateInvoicePdf' && window.__autoRegenPdfWaiter) {
        try {
          const respClone = response.clone();
          respClone.json().then(j => {
            const pdfId = j?.data?.createInvoicePdf?.invoicePdf?.id;
            const w = window.__autoRegenPdfWaiter;
            window.__autoRegenPdfWaiter = null;
            if (!w) return;
            clearTimeout(w.timer);
            if (pdfId) w.resolve({ pdfId, filename: bodyObj?.variables?.filename });
            else w.reject(new Error('CreateInvoicePdf sin invoicePdf.id'));
          }).catch(e => {
            const w = window.__autoRegenPdfWaiter;
            window.__autoRegenPdfWaiter = null;
            if (w) { clearTimeout(w.timer); w.reject(e); }
          });
        } catch (e) { /* no fatal */ }
      }

      if (opName === 'ActiveInvoicesPaged' || opName === 'InvoiceByIdInDomain') {
        try {
          const clone = response.clone();
          const json = await clone.json();

          // Cachear el raw InvoiceByIdInDomain para diagnóstico (dumpManualPair)
          if (opName === 'InvoiceByIdInDomain') {
            const inv = json?.data?.invoiceByIdInDomain;
            if (inv?.idInDomain != null) {
              window.__lastRawInvoice = window.__lastRawInvoice || {};
              window.__lastRawInvoice[inv.idInDomain] = inv;
            }
          }

          if (opName === 'ActiveInvoicesPaged') {
            // Trigger reactivo (d): aprovechamos que el UI ya consultó el server.
            // pullPendingCount aplica su propio throttle de 30s y deduplica via _pullInFlight.
            pullPendingCount();
          } else if (opName === 'InvoiceByIdInDomain') {
            const items = scanSingle(json);
            if (items.length > 0) {
              autoRegenInOpenModal(items[0]);  // no await: corre en background
            }
          }
        } catch (err) {
          console.warn('[AutoRegen] Error procesando', opName, err);
        }
      }
      return response;
    };
  }

  // ── Detector ──

  function maxPdfAt(invoice) {
    const nodes = invoice?.invoicePdfsByInvoiceId?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return 0;
    let max = 0;
    for (const n of nodes) {
      const t = n?.createdAt ? Date.parse(n.createdAt) : 0;
      if (t > max) max = t;
    }
    return max;
  }

  function needsRegen(invoice, opts = {}) {
    if (!invoice) return false;
    const obj = invoice.steelheadObjectByInvoiceId;
    if (!obj) return false;
    const writtenAt = obj.writtenAt ? Date.parse(obj.writtenAt) : 0;
    if (!writtenAt) return false;
    if (invoice.voidedAt) return false;
    if (obj.voidSuccessfulAt) return false;
    if (maxPdfAt(invoice) >= writtenAt) return false;
    if (opts.requireUuid) {
      const uuid = invoice?.createWriteResult?.data?.result?.writeResult?.uuid;
      if (!uuid) return false;
    }
    return true;
  }

  function scanList(json) {
    const nodes = json?.data?.allInvoices?.nodes;
    if (!Array.isArray(nodes)) return [];
    const out = [];
    for (const inv of nodes) {
      if (needsRegen(inv)) out.push({ invoiceId: inv.id, idInDomain: inv.idInDomain });
    }
    return out;
  }

  function scanSingle(json) {
    const inv = json?.data?.invoiceByIdInDomain;
    if (!inv) return [];
    if (!needsRegen(inv, { requireUuid: true })) return [];
    return [{ invoiceId: inv.id, idInDomain: inv.idInDomain }];
  }

  // ── Auto-regen cuando el usuario abre el modal de una pendiente ──

  async function autoRegenInOpenModal(item) {
    if (runState.active) return;                       // no interferir con batch
    if (modalAutoRegenActive) return;                  // ya hay uno corriendo
    if (window.__autoRegenPdfWaiter) return;           // hay otra regen en vuelo
    if (isRecentlyRegenerated(item.invoiceId)) return; // ya la regeneramos hace < 3 min

    modalAutoRegenActive = true;
    console.log(`%c[AutoRegen] Modal abierto en factura pendiente #${item.idInDomain} — auto-regenerando…`, 'color:#0891b2;font-weight:bold');
    try {
      // Esperar a que el icono regenerar esté en el DOM y a React resuelva queries
      const svg = await _waitForElement(REGEN_ICON_SELECTOR, 8000);
      if (!svg) throw new Error('Icono regenerar no apareció');
      await sleep(1500);
      await testRegenInOpenModal(30000);
      markRegenerated(item.invoiceId);
      pullPendingCount({ force: true }); // refresca banner sin bloquear el flujo
      console.log(`%c[AutoRegen] ✓ #${item.idInDomain} regenerada (modal abierto)`, 'color:#16a34a;font-weight:bold');
    } catch (e) {
      console.warn(`[AutoRegen] auto-regen en modal abierto falló para #${item.idInDomain}: ${e.message}`);
    } finally {
      modalAutoRegenActive = false;
      updateBanner();
    }
  }

  // ── Run (batch del banner) ──

  function requestStop() {
    if (!runState.active) return;
    runState.stopRequested = true;
    console.log('[AutoRegen] Stop solicitado por el usuario — terminando item actual…');
    updateBanner();
  }

  async function startRun() {
    if (runState.active) return;
    const items = Array.isArray(lastPullResult) ? [...lastPullResult] : [];
    if (items.length === 0) return;

    runState.active = true;
    runState.total = items.length;
    runState.index = 0;
    runState.current = null;
    runState.stopRequested = false;
    showOverlay();
    updateBanner();
    console.log(`%c[AutoRegen] Iniciando batch de ${items.length} facturas`, 'color:#0891b2;font-weight:bold');

    let ok = 0, failed = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        if (runState.stopRequested) {
          console.log('[AutoRegen] Batch detenido por el usuario');
          break;
        }
        runState.index = i + 1;
        runState.current = items[i];
        updateBanner();
        let success = false, lastErr = null;
        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          if (runState.stopRequested) break;
          try {
            if (attempt > 1) {
              console.log(`[AutoRegen] reintento ${attempt} para #${items[i].idInDomain}`);
              await sleep(2000);
            }
            await regenViaModal(items[i].idInDomain);
            markRegenerated(items[i].invoiceId);
            success = true;
          } catch (e) {
            lastErr = e;
          }
        }
        if (success) ok++;
        else { console.warn(`[AutoRegen] #${items[i].idInDomain} falló tras 2 intentos: ${lastErr?.message}`); failed++; }
        if (i < items.length - 1) await sleep(1000);
      }
    } finally {
      runState.active = false;
      runState.current = null;
      hideOverlay();
      // Trigger (b): post-regen siempre dispara pull fresco para que el banner refleje la realidad.
      pullPendingCount({ force: true }).then(items => {
        const remaining = Array.isArray(items) ? items.length : 0;
        console.log(`%c[AutoRegen] Batch terminado. ✓${ok} ✗${failed}. Pendientes restantes (post-pull): ${remaining}`, 'color:#16a34a;font-weight:bold');
      });
      updateBanner();
    }
  }

  // ── Banner UI ──

  const BANNER_ID = 'sa-regen-banner';

  function _isHeadingLike(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('a, nav, [role="tab"], [role="tablist"], [role="link"], [aria-label*="breadcrumb" i]')) return false;
    if (el.tagName === 'BUTTON' || el.closest('button, [role="button"]')) return false;
    const style = window.getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize) || 0;
    const fontWeight = parseInt(style.fontWeight) || 0;
    return fontSize >= 18 || fontWeight >= 600;
  }
  function _findExactInvoicesNode(root) {
    if (!root) return null;
    const all = root.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, p');
    let best = null, bestSize = 0;
    for (const el of all) {
      if (el.children.length > 0) continue;
      if (el.textContent.trim() !== 'Invoices') continue;
      if (!_isHeadingLike(el)) continue;
      const size = parseFloat(window.getComputedStyle(el).fontSize) || 0;
      if (size > bestSize) { best = el; bestSize = size; }
    }
    return best;
  }
  function findInvoicesHeading() {
    // 1. Heading semántico exacto "Invoices"
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const h of headings) {
      if (h.textContent && h.textContent.trim() === 'Invoices') return h;
    }
    // 2. Anclado al botón "CREAR FACTURA" del panel derecho
    const buttons = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of buttons) {
      const t = (btn.textContent || '').trim().toUpperCase();
      if (t !== 'CREAR FACTURA') continue;
      let node = btn;
      for (let i = 0; i < 8 && node; i++) {
        const found = _findExactInvoicesNode(node);
        if (found) return found;
        node = node.parentElement;
      }
    }
    // 3. Heurística global: cualquier nodo "Invoices" con apariencia de heading
    return _findExactInvoicesNode(document.body);
  }

  let _bannerWarned = false;
  let _headingRef = null;
  function injectBanner() {
    let banner = document.getElementById(BANNER_ID);
    if (banner) return banner;
    // Cache del heading: si sigue en el DOM, no recorremos otra vez.
    let heading = _headingRef && _headingRef.isConnected ? _headingRef : null;
    if (!heading) {
      heading = findInvoicesHeading();
      _headingRef = heading;
    }
    if (!heading) {
      if (!_bannerWarned) {
        console.warn('[AutoRegen] No encontré el título "Invoices" para anclar el banner — reintento con MutationObserver');
        _bannerWarned = true;
      }
      return null;
    }
    _bannerWarned = false;
    banner = document.createElement('span');
    banner.id = BANNER_ID;
    banner.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:16px;vertical-align:middle;font-size:14px;font-weight:500;';
    heading.appendChild(banner);
    return banner;
  }

  function updateBanner() {
    const banner = injectBanner();
    if (!banner) return;
    // Limpiar contenido (sólo nuestro propio chunk)
    while (banner.firstChild) banner.removeChild(banner.firstChild);

    if (runState.active) {
      const text = document.createElement('span');
      const idText = runState.current?.idInDomain ?? '…';
      text.textContent = runState.stopRequested
        ? `Deteniendo… (${runState.index}/${runState.total})`
        : `↻ Regenerando #${idText} (${runState.index}/${runState.total})`;
      text.style.cssText = 'color:#a02020;';
      banner.appendChild(text);

      const stop = document.createElement('button');
      stop.dataset.saRegenStop = '1';
      stop.textContent = runState.stopRequested ? 'Deteniendo…' : 'Detener';
      stop.disabled = runState.stopRequested;
      stop.style.cssText = 'background:#374151;color:#fff;border:0;padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;';
      if (runState.stopRequested) stop.style.opacity = '0.6';
      stop.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); requestStop(); });
      banner.appendChild(stop);

      banner.style.display = 'inline-flex';
      banner.style.position = 'relative';
      banner.style.zIndex = '10000';
    } else if (Array.isArray(lastPullResult) && lastPullResult.length > 0) {
      const btn = document.createElement('button');
      btn.dataset.saRegenStart = '1';
      const n = lastPullResult.length;
      btn.textContent = `↻ ${n} timbrada${n === 1 ? '' : 's'} pendiente${n === 1 ? '' : 's'} — Regenerar PDFs`;
      btn.style.cssText = 'background:#a02020;color:#fff;border:0;padding:6px 14px;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;';
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startRun(); });
      banner.appendChild(btn);
      banner.style.display = 'inline-flex';
      banner.style.position = '';
      banner.style.zIndex = '';
    } else {
      banner.style.display = 'none';
    }
  }

  let bannerObserver = null;
  let bannerCheckScheduled = false;
  function _scheduleBannerCheck() {
    if (bannerCheckScheduled) return;
    bannerCheckScheduled = true;
    setTimeout(() => {
      bannerCheckScheduled = false;
      const needsBanner = (Array.isArray(lastPullResult) && lastPullResult.length > 0) || runState.active;
      if (needsBanner && !document.getElementById(BANNER_ID)) updateBanner();
    }, 500);
  }
  function setupBannerObserver() {
    if (bannerObserver) return;
    // Throttle a 500ms para no pegarle al CPU en cada microtask de React.
    bannerObserver = new MutationObserver(_scheduleBannerCheck);
    bannerObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Overlay + UI Lock ──

  const OVERLAY_ID = 'sa-regen-overlay';

  function showOverlay() {
    let o = document.getElementById(OVERLAY_ID);
    if (!o) {
      o = document.createElement('div');
      o.id = OVERLAY_ID;
      // pointer-events: none para que nuestros clicks programáticos pasen por
      // debajo. El bloqueo de clicks humanos lo hace el lockHandler global por
      // event.isTrusted, no el overlay.
      o.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.35);z-index:9998;pointer-events:none;';
      document.body.appendChild(o);
    }
    o.style.display = 'block';
  }

  function hideOverlay() {
    const o = document.getElementById(OVERLAY_ID);
    if (o) o.style.display = 'none';
  }

  function isInsideStopBtn(target) {
    return target instanceof Element && target.closest('[data-sa-regen-stop]');
  }

  function lockHandler(e) {
    if (!runState.active) return;
    if (!e.isTrusted) return;                      // dejamos pasar clicks programáticos
    if (isInsideStopBtn(e.target)) return;         // botón Detener pasa
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  let lockInstalled = false;
  function installLock() {
    if (lockInstalled) return;
    lockInstalled = true;
    // Sólo los eventos críticos para bloquear interacción real. mousedown/keydown
    // capturan la mayoría de interacciones humanas; submit cubre forms.
    ['click', 'mousedown', 'keydown', 'submit'].forEach(ev => {
      document.addEventListener(ev, lockHandler, true);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Helpers GraphQL ad-hoc (diagnóstico) ──

  async function _callOp(opName, variables) {
    const fromRegistry = hashRegistry.get(opName);
    const fromConfig = api()?.getHash?.(opName);
    const hash = fromRegistry || fromConfig;
    if (!hash) {
      throw new Error(`No hash para ${opName}. Haz un click manual de regenerar primero para que el applet aprenda los hashes.`);
    }
    const body = {
      operationName: opName,
      variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: hash }
      }
    };
    const r = await fetch('https://app.gosteelhead.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} en ${opName}: ${text.substring(0, 300)}`);
    }
    const j = await r.json();
    if (j.errors && !j.data) {
      const msgs = (j.errors || []).map(e => e.message).join('; ');
      throw new Error(`GraphQL ${opName}: ${msgs.substring(0, 300)}`);
    }
    return j.data;
  }

  // ── Pull activo de pendientes ──

  // Inspecciona el template para encontrar el nombre del campo de filtro "desde".
  // Devuelve el path (ej. "writtenAtFrom" o "filter.dateFrom") o null si no existe.
  function _detectDateFromField(template) {
    if (!template || typeof template !== 'object') return null;
    const candidates = ['writtenAtFrom', 'writtenAtStart', 'dateFrom', 'fromDate', 'from', 'startDate'];
    for (const k of candidates) {
      if (k in template) return k;
    }
    for (const key of Object.keys(template)) {
      const v = template[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const k of candidates) {
          if (k in v) return `${key}.${k}`;
        }
      }
    }
    return null;
  }

  function _setNestedField(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // El template viene del UI con search/customer/etc. seleccionados por el usuario.
  // Para nuestro pull global queremos esos filtros en blanco. Mutamos sobre una copia.
  function _sanitizeTemplate(template) {
    const t = JSON.parse(JSON.stringify(template));
    const fieldsToClear = ['searchTerm', 'search', 'customerId', 'customer', 'status', 'tags', 'tagIds'];
    for (const k of fieldsToClear) {
      if (k in t) {
        const v = t[k];
        t[k] = (typeof v === 'string') ? '' : (Array.isArray(v) ? [] : null);
      }
    }
    for (const key of Object.keys(t)) {
      const v = t[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const k of fieldsToClear) {
          if (k in v) {
            const vv = v[k];
            v[k] = (typeof vv === 'string') ? '' : (Array.isArray(vv) ? [] : null);
          }
        }
      }
    }
    return t;
  }

  // Pulls actively from ActiveInvoicesPaged with a 7-day window. Evaluates needsRegen()
  // per node and filters out recentlyRegenerated. Updates lastPullResult/lastPullAt.
  // Coalesces concurrent calls via _pullInFlight.
  async function pullPendingCount({ force = false } = {}) {
    if (_pullInFlight) return _pullInFlight;
    if (!force && Date.now() - lastPullAt < PULL_THROTTLE_MS && lastPullResult !== null) {
      return lastPullResult;
    }

    const template = window.__autoRegenLastVars?.ActiveInvoicesPaged;
    if (!template) {
      console.log('[AutoRegen] pullPendingCount: sin template aprendido todavía — esperando ActiveInvoicesPaged del UI');
      return null;
    }

    _pullInFlight = (async () => {
      const cutoffMs = Date.now() - PULL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const cutoffISO = new Date(cutoffMs).toISOString();
      const dateField = _detectDateFromField(template);
      const baseVars = _sanitizeTemplate(template);
      if (dateField) {
        _setNestedField(baseVars, dateField, cutoffISO);
      }

      const collected = [];
      let stoppedByCutoff = false;

      for (let page = 1; page <= PULL_MAX_PAGES; page++) {
        const vars = JSON.parse(JSON.stringify(baseVars));
        if ('pageNumber' in vars) vars.pageNumber = page;
        else if ('page' in vars) vars.page = page;
        if ('pageSize' in vars) vars.pageSize = PULL_PAGE_SIZE;
        else if ('limit' in vars) vars.limit = PULL_PAGE_SIZE;

        let data;
        try {
          data = await _callOp('ActiveInvoicesPaged', vars);
        } catch (e) {
          throw new Error(`Page ${page}: ${e.message}`);
        }
        const nodes = data?.allInvoices?.nodes || [];
        if (nodes.length === 0) break;

        for (const inv of nodes) {
          if (!dateField && inv?.steelheadObjectByInvoiceId?.writtenAt) {
            const wt = Date.parse(inv.steelheadObjectByInvoiceId.writtenAt);
            if (wt && wt < cutoffMs) { stoppedByCutoff = true; break; }
          }
          if (!needsRegen(inv)) continue;
          if (isRecentlyRegenerated(inv.id)) continue;
          collected.push({ invoiceId: inv.id, idInDomain: inv.idInDomain });
        }

        if (stoppedByCutoff) break;
        if (nodes.length < PULL_PAGE_SIZE) break;
      }

      return collected;
    })();

    try {
      const items = await _pullInFlight;
      lastPullResult = items;
      lastPullAt = Date.now();
      _pullConsecFailures = 0;
      if (_pullDegraded) {
        console.log('[AutoRegen] Recovery: pull volvió a funcionar — banner reactivado');
        _pullDegraded = false;
      }
      console.log(`[AutoRegen] pullPendingCount: ${items.length} pendientes (ventana ${PULL_WINDOW_DAYS}d)`);
      updateBanner();
      return items;
    } catch (e) {
      _pullConsecFailures++;
      const isHashDeprecated = /Must provide a query string|400/.test(e.message);
      console.warn(`[AutoRegen] pullPendingCount falló (${_pullConsecFailures}/3)${isHashDeprecated ? ' — posible deprecación de hash' : ''}:`, e.message);
      if (_pullConsecFailures >= 3) {
        _pullDegraded = true;
        lastPullResult = null;
        console.warn('[AutoRegen] 3 fallos consecutivos — banner oculto. Pull se reactiva al próximo ActiveInvoicesPaged exitoso del UI.');
        updateBanner();
      }
      return lastPullResult;
    } finally {
      _pullInFlight = null;
    }
  }

  // ── Regen DOM-driven ──

  const REGEN_ICON_SELECTOR = 'svg[data-testid="RestorePageOutlinedIcon"]';

  function _waitForElement(selector, timeoutMs = 8000) {
    return new Promise(resolve => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function _waitForElementGone(selector, timeoutMs = 5000) {
    return new Promise(resolve => {
      if (!document.querySelector(selector)) return resolve(true);
      const obs = new MutationObserver(() => {
        if (!document.querySelector(selector)) { obs.disconnect(); resolve(true); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(false); }, timeoutMs);
    });
  }

  function _findRowOpenTarget(idInDomain) {
    const tag = '#' + idInDomain;
    const all = document.querySelectorAll('a, span, div, td');
    for (const el of all) {
      if (el.children.length === 0 && el.textContent && el.textContent.trim() === tag) {
        let cur = el;
        for (let i = 0; i < 8 && cur; i++) {
          if (cur.tagName === 'A' || cur.onclick || cur.getAttribute?.('role') === 'button') return cur;
          cur = cur.parentElement;
        }
        return el;
      }
    }
    return null;
  }

  function _findCloseButton() {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (b.textContent && b.textContent.trim() === 'Close') return b;
    }
    return null;
  }

  function _findButtonByText(textRegex) {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (textRegex.test(t)) return b;
    }
    return null;
  }

  function _waitForButton(textRegex, timeoutMs = 5000) {
    return new Promise(resolve => {
      const found = _findButtonByText(textRegex);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const b = _findButtonByText(textRegex);
        if (b) { obs.disconnect(); resolve(b); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function _waitForCreateInvoicePdf(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (window.__autoRegenPdfWaiter) {
        return reject(new Error('Otro waiter ya está activo'));
      }
      const timer = setTimeout(() => {
        window.__autoRegenPdfWaiter = null;
        reject(new Error(`Timeout ${timeoutMs}ms esperando CreateInvoicePdf`));
      }, timeoutMs);
      window.__autoRegenPdfWaiter = { resolve, reject, timer };
    });
  }

  // Asume modal/página de factura abierta. Click programático al icono regenerar
  // + CONFIRMAR + espera respuesta de CreateInvoicePdf.
  async function testRegenInOpenModal(timeoutMs = 30000) {
    const svg = document.querySelector(REGEN_ICON_SELECTOR);
    if (!svg) throw new Error('No se encontró el icono RestorePageOutlinedIcon — modal cerrado o no es invoice modal');
    const waitPromise = _waitForCreateInvoicePdf(timeoutMs);
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    console.log('[AutoRegen DOM] Click disparado al icono regenerar — esperando submodal de confirmación…');

    const confirmBtn = await _waitForButton(/^confirmar$/i, 5000);
    if (!confirmBtn) {
      const w = window.__autoRegenPdfWaiter;
      if (w) { clearTimeout(w.timer); window.__autoRegenPdfWaiter = null; }
      throw new Error('Botón CONFIRMAR no apareció en 5s tras click al icono regenerar');
    }
    confirmBtn.click();
    console.log('[AutoRegen DOM] CONFIRMAR clickeado — esperando CreateInvoicePdf…');

    const result = await waitPromise;
    console.log(`%c[AutoRegen DOM] ✓ CreateInvoicePdf OK → invoicePdf.id=${result.pdfId}`, 'color:#16a34a;font-weight:bold');
    return result;
  }

  // Flujo completo: abre la factura, regenera, vuelve al dashboard.
  async function regenViaModal(idInDomain, opts = {}) {
    const settleMs = opts.settleMs ?? 1500;
    const openTimeoutMs = opts.openTimeoutMs ?? 8000;
    const regenTimeoutMs = opts.regenTimeoutMs ?? 30000;

    console.log(`%c[AutoRegen DOM] regenViaModal(#${idInDomain}) — abriendo factura…`, 'color:#0891b2;font-weight:bold');
    const urlBefore = location.href;

    const target = _findRowOpenTarget(idInDomain);
    if (!target) throw new Error(`No se encontró fila con texto "#${idInDomain}" en el dashboard`);
    target.click();

    const svg = await _waitForElement(REGEN_ICON_SELECTOR, openTimeoutMs);
    if (!svg) throw new Error(`Vista de factura no abrió en ${openTimeoutMs}ms (icono regenerar no apareció)`);

    await sleep(settleMs);

    const result = await testRegenInOpenModal(regenTimeoutMs);

    // Cerrar: page-mode → history.back; modal-mode → botón Close
    if (location.href !== urlBefore) {
      console.log(`[AutoRegen DOM] page-mode detectado — history.back() al dashboard`);
      history.back();
      await _waitForElementGone(REGEN_ICON_SELECTOR, 5000);
      if (location.href !== urlBefore) {
        console.warn(`[AutoRegen DOM] history.back() no restauró URL exacta. Esperada: ${urlBefore} — actual: ${location.href}`);
      } else {
        console.log(`[AutoRegen DOM] Dashboard restaurado`);
      }
    } else {
      const closeBtn = _findCloseButton();
      if (closeBtn) {
        closeBtn.click();
        await _waitForElementGone(REGEN_ICON_SELECTOR, 3000);
        console.log(`[AutoRegen DOM] Modal cerrado`);
      } else {
        console.warn('[AutoRegen DOM] No se encontró botón Close ni hubo cambio de URL — vista pudo quedar abierta');
      }
    }

    return result;
  }

  async function regenViaModalBatch(idInDomains, opts = {}) {
    const gapMs = opts.gapMs ?? 1000;
    const results = [];
    for (let i = 0; i < idInDomains.length; i++) {
      const id = idInDomains[i];
      console.log(`%c[AutoRegen DOM] [${i+1}/${idInDomains.length}] #${id}`, 'color:#0891b2;font-weight:bold');
      try {
        const r = await regenViaModal(id, opts);
        results.push({ idInDomain: id, ok: true, ...r });
      } catch (e) {
        console.warn(`[AutoRegen DOM] #${id} falló:`, e.message);
        results.push({ idInDomain: id, ok: false, error: e.message });
      }
      if (i < idInDomains.length - 1) await sleep(gapMs);
    }
    console.log(`%c[AutoRegen DOM] Batch completo: ${results.filter(r=>r.ok).length}/${results.length} OK`, 'color:#16a34a;font-weight:bold');
    return results;
  }

  // ── Diagnóstico expuesto por consola ──

  function _state() {
    return {
      pendingCount: Array.isArray(lastPullResult) ? lastPullResult.length : 0,
      pendingIds: Array.isArray(lastPullResult) ? lastPullResult.map(i => i.idInDomain) : [],
      lastPullAt: lastPullAt ? new Date(lastPullAt).toISOString() : null,
      pullDegraded: _pullDegraded,
      pullInFlight: !!_pullInFlight,
      run: { ...runState },
      modalAutoRegenActive
    };
  }

  return {
    init,
    regenViaModal,
    regenViaModalBatch,
    testRegenInOpenModal,
    startRun,
    requestStop,
    pullPendingCount,
    _callOp,
    _state,
    _hashRegistry: hashRegistry,
    _lastPullResult: () => lastPullResult
  };
})();

if (typeof window !== 'undefined') {
  window.InvoiceAutoRegen = InvoiceAutoRegen;

  // DOM-driven: replica el click manual del icono RestorePageOutlinedIcon
  window.regenViaModal = (idInDomain, opts) => InvoiceAutoRegen.regenViaModal(idInDomain, opts);
  window.regenViaModalBatch = (ids, opts) => InvoiceAutoRegen.regenViaModalBatch(ids, opts);
  window.testRegenInOpenModal = (timeoutMs) => InvoiceAutoRegen.testRegenInOpenModal(timeoutMs);
  window.regenStart = () => InvoiceAutoRegen.startRun();
  window.regenStop = () => InvoiceAutoRegen.requestStop();
  window.regenState = () => InvoiceAutoRegen._state();

  // Diagnóstico: copia el último payload de GetPdfTemplateOutputToUserFile capturado.
  window.dumpManualPdfPayload = function (idInDomain) {
    const all = window.__lastManualPdfData || {};
    const data = idInDomain ? all[idInDomain] : window.__lastManualPdfDataLatest;
    if (!data) {
      console.warn(`[AutoRegen] No hay payload capturado${idInDomain ? ` para #${idInDomain}` : ''}.`);
      return null;
    }
    const json = JSON.stringify(data, null, 2);
    try {
      navigator.clipboard.writeText(json).then(() => {
        console.log(`%c[AutoRegen] Payload de #${data.idInDomain} copiado al clipboard (${json.length} chars)`, 'color:#16a34a;font-weight:bold');
      });
    } catch (e) { console.warn('Clipboard falló:', e); }
    return data;
  };

  window.dumpManualPair = function (idInDomain) {
    const all = window.__lastManualPdfPair || {};
    const pair = all[idInDomain];
    if (!pair) {
      console.warn(`[AutoRegen] No hay pair capturado para #${idInDomain}.`);
      return null;
    }
    const json = JSON.stringify(pair, null, 2);
    window.__lastDumpJson = json;
    console.log(`%c[AutoRegen] Pair de #${idInDomain} listo (${json.length} chars).`, 'color:#16a34a;font-weight:bold');
    navigator.clipboard.writeText(json).then(
      () => console.log('%c[AutoRegen] (También copiado al clipboard)', 'color:#16a34a'),
      (e) => console.log(`%c[AutoRegen] (Clipboard automático falló: ${e.message})`, 'color:#6b7280')
    );
    return pair;
  };

  InvoiceAutoRegen.init();
}
