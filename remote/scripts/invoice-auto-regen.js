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

  // ── Estado (vida = pestaña) ──
  // pendientes que el detector ha visto en esta sesión y no han sido regeneradas
  const pendingByInvoiceId = new Map(); // invoiceId → {invoiceId, idInDomain}
  // facturas regeneradas exitosamente en esta sesión — el detector ignora estas
  // aunque ActiveInvoicesPaged siga reportándolas como pendientes por eventual
  // consistency del backend (la query trae el PDF viejo todavía durante un rato).
  const recentlyRegeneratedSet = new Set();

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
    patchFetch();
    installLock();
    setupBannerObserver();
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

          const items = (opName === 'ActiveInvoicesPaged') ? scanList(json) : scanSingle(json);
          if (items.length > 0) {
            recordPending(items);
            // Si vino del modal abierto manualmente → auto-regen sin cerrar
            if (opName === 'InvoiceByIdInDomain') {
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

  function recordPending(items) {
    let added = 0, suppressed = 0;
    for (const it of items) {
      // Ignorar las que ya regeneramos en esta sesión: la query trae el PDF
      // viejo todavía por eventual consistency, pero ya hicimos el trabajo.
      if (recentlyRegeneratedSet.has(it.invoiceId)) { suppressed++; continue; }
      if (!pendingByInvoiceId.has(it.invoiceId)) {
        pendingByInvoiceId.set(it.invoiceId, it);
        added++;
      }
    }
    if (added > 0) {
      console.log(`[AutoRegen] +${added} pendientes (total ${pendingByInvoiceId.size})${suppressed ? ` — ignoradas ${suppressed} ya regeneradas` : ''}`);
    }
    updateBanner();
  }

  // ── Auto-regen cuando el usuario abre el modal de una pendiente ──

  async function autoRegenInOpenModal(item) {
    if (runState.active) return;                       // no interferir con batch
    if (modalAutoRegenActive) return;                  // ya hay uno corriendo
    if (window.__autoRegenPdfWaiter) return;           // hay otra regen en vuelo
    if (!pendingByInvoiceId.has(item.invoiceId)) return;

    modalAutoRegenActive = true;
    console.log(`%c[AutoRegen] Modal abierto en factura pendiente #${item.idInDomain} — auto-regenerando…`, 'color:#0891b2;font-weight:bold');
    try {
      // Esperar a que el icono regenerar esté en el DOM y a React resuelva queries
      const svg = await _waitForElement(REGEN_ICON_SELECTOR, 8000);
      if (!svg) throw new Error('Icono regenerar no apareció');
      await sleep(1500);
      await testRegenInOpenModal(30000);
      recentlyRegeneratedSet.add(item.invoiceId);
      pendingByInvoiceId.delete(item.invoiceId);
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
    const items = Array.from(pendingByInvoiceId.values());
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
        try {
          await regenViaModal(items[i].idInDomain);
          recentlyRegeneratedSet.add(items[i].invoiceId);
          pendingByInvoiceId.delete(items[i].invoiceId);
          ok++;
        } catch (e) {
          console.warn(`[AutoRegen] #${items[i].idInDomain} falló: ${e.message}`);
          failed++;
        }
        if (i < items.length - 1) await sleep(1000);
      }
    } finally {
      runState.active = false;
      runState.current = null;
      hideOverlay();
      updateBanner();
      console.log(`%c[AutoRegen] Batch terminado. ✓${ok} ✗${failed}. Pendientes restantes: ${pendingByInvoiceId.size}`, 'color:#16a34a;font-weight:bold');
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
  function injectBanner() {
    let banner = document.getElementById(BANNER_ID);
    if (banner) return banner;
    const heading = findInvoicesHeading();
    if (!heading) {
      if (!_bannerWarned) {
        console.warn('[AutoRegen] No encontré el título "Invoices" para anclar el banner — reintento con MutationObserver');
        _bannerWarned = true;
      }
      return null;
    }
    _bannerWarned = false;
    console.log('[AutoRegen] Banner anclado a:', heading.tagName, heading);
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
    } else if (pendingByInvoiceId.size > 0) {
      const btn = document.createElement('button');
      btn.dataset.saRegenStart = '1';
      const n = pendingByInvoiceId.size;
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
  function setupBannerObserver() {
    if (bannerObserver) return;
    bannerObserver = new MutationObserver(() => {
      const needsBanner = pendingByInvoiceId.size > 0 || runState.active;
      if (needsBanner && !document.getElementById(BANNER_ID)) {
        updateBanner();
      }
    });
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
    ['click', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keypress', 'keyup', 'submit'].forEach(ev => {
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
      pending: pendingByInvoiceId.size,
      pendingIds: Array.from(pendingByInvoiceId.values()).map(i => i.idInDomain),
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
    _callOp,
    _state,
    _hashRegistry: hashRegistry,
    _pending: pendingByInvoiceId
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
