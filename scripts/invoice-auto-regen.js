// Invoice Auto-Regenerate
// Detecta facturas timbradas con PDF pre-timbre y dispara CreateInvoicePdf en background.
// Intercepta ActiveInvoicesPaged (dashboard) e InvoiceByIdInDomain (modal).
// Depends on: SteelheadAPI

const InvoiceAutoRegen = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  let enabled = true;
  let _origFetch = null;

  // Estado en memoria (vida = pestaña)
  const completedSet = new Set(); // invoiceIds ya regenerados con éxito
  const state = new Map();        // invoiceId → 'pending' | 'running' | 'done' | 'error'
  const queueArr = [];            // FIFO de {invoiceId, idInDomain}
  let processing = false;

  // ── Init ──

  function init() {
    enabled = document.documentElement.dataset.saAutoRegenEnabled !== 'false';
    if (!enabled) { console.log('[AutoRegen] Deshabilitado'); return; }
    patchFetch();

    // Cablear UI
    on('enqueued', item => { paintRow(item.idInDomain, 'pending'); paintModal('pending'); });
    on('started',  item => { paintRow(item.idInDomain, 'running'); paintModal('running'); });
    on('done',     item => { paintRow(item.idInDomain, 'done');    paintModal('done'); });
    on('error',    item => { paintRow(item.idInDomain, 'error');   paintModal('error'); });

    setupRowObserver();
    console.log('[AutoRegen] Inicializado');
  }

  // ── Fetch Interceptor (placeholder, llenado en Task 7) ──

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

      // DEBUG: capturar body real de CreateInvoicePdf cuando Steelhead lo dispara (click manual)
      if (opName === 'CreateInvoicePdf') {
        console.log('[AutoRegen DEBUG] outgoing CreateInvoicePdf body:', JSON.stringify(bodyObj, null, 2));
      }

      const response = await _origFetch.apply(this, args);

      if (opName === 'ActiveInvoicesPaged' || opName === 'InvoiceByIdInDomain') {
        // Clonar y procesar en el siguiente tick para no bloquear el caller
        try {
          const clone = response.clone();
          const json = await clone.json();

          // DEBUG: shape relevante para diagnóstico
          if (opName === 'InvoiceByIdInDomain') {
            const inv = json?.data?.invoiceByIdInDomain;
            console.log('[AutoRegen DEBUG] InvoiceByIdInDomain', {
              idInDomain: inv?.idInDomain,
              hasSteelheadObject: !!inv?.steelheadObjectByInvoiceId,
              writtenAt: inv?.steelheadObjectByInvoiceId?.writtenAt,
              voidedAt: inv?.voidedAt,
              voidSuccessfulAt: inv?.steelheadObjectByInvoiceId?.voidSuccessfulAt,
              pdfsCount: inv?.invoicePdfsByInvoiceId?.nodes?.length,
              pdfDates: inv?.invoicePdfsByInvoiceId?.nodes?.map(n => n.createdAt),
              uuid: inv?.createWriteResult?.data?.result?.writeResult?.uuid,
              keysAtRoot: inv ? Object.keys(inv) : null
            });
          } else {
            const nodes = json?.data?.allInvoices?.nodes || [];
            console.log('[AutoRegen DEBUG] ActiveInvoicesPaged total=', nodes.length);
            if (nodes.length > 0) {
              const sample = nodes[0];
              console.log('[AutoRegen DEBUG] sample[0]', {
                idInDomain: sample.idInDomain,
                hasSteelheadObject: !!sample.steelheadObjectByInvoiceId,
                writtenAt: sample.steelheadObjectByInvoiceId?.writtenAt,
                pdfsCount: sample.invoicePdfsByInvoiceId?.nodes?.length,
                keysAtRoot: Object.keys(sample)
              });
            }
          }

          const items = (opName === 'ActiveInvoicesPaged') ? scanList(json) : scanSingle(json);
          console.log(`[AutoRegen DEBUG] ${opName} items detectados:`, items.length);
          if (items.length > 0) {
            for (const it of items) rememberItem(it);
            enqueue(items);
          }
        } catch (err) {
          console.warn('[AutoRegen] Error procesando', opName, err);
        }
      }
      return response;
    };
  }

  // ── Detector ──

  // Devuelve max(createdAt) en ms, o 0 si no hay PDFs.
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

  // Aplica el criterio sobre un objeto Invoice (común a dashboard y modal).
  // Retorna true si la factura está timbrada con PDF pre-timbre.
  function needsRegen(invoice, opts = {}) {
    if (!invoice) return false;
    const obj = invoice.steelheadObjectByInvoiceId;
    if (!obj) return false;
    const writtenAt = obj.writtenAt ? Date.parse(obj.writtenAt) : 0;
    if (!writtenAt) return false;
    if (invoice.voidedAt) return false;
    if (obj.voidSuccessfulAt) return false;
    if (maxPdfAt(invoice) >= writtenAt) return false;

    // Confirmación extra (modal): exigir uuid del SAT en createWriteResult
    if (opts.requireUuid) {
      const uuid = invoice?.createWriteResult?.data?.result?.writeResult?.uuid;
      if (!uuid) return false;
    }
    return true;
  }

  // Escanea respuesta de ActiveInvoicesPaged → array de candidatos
  function scanList(json) {
    const nodes = json?.data?.allInvoices?.nodes;
    if (!Array.isArray(nodes)) return [];
    const out = [];
    for (const inv of nodes) {
      if (needsRegen(inv)) {
        out.push({ invoiceId: inv.id, idInDomain: inv.idInDomain });
      }
    }
    return out;
  }

  // Escanea respuesta de InvoiceByIdInDomain → 0 o 1 candidato
  function scanSingle(json) {
    const inv = json?.data?.invoiceByIdInDomain;
    if (!inv) return [];
    if (!needsRegen(inv, { requireUuid: true })) return [];
    return [{ invoiceId: inv.id, idInDomain: inv.idInDomain }];
  }

  // ── Queue ──

  // Eventos: 'enqueued' | 'started' | 'done' | 'error'
  const listeners = { enqueued: [], started: [], done: [], error: [] };
  function on(event, fn) { listeners[event]?.push(fn); }
  function emit(event, payload) {
    for (const fn of (listeners[event] || [])) {
      try { fn(payload); } catch (e) { console.warn('[AutoRegen] listener error:', e); }
    }
  }

  function enqueue(items) {
    for (const item of items) {
      const id = item.invoiceId;
      if (completedSet.has(id)) continue;          // ya regenerada esta sesión
      if (state.has(id)) continue;                  // ya en flight (pending/running/error)
      state.set(id, 'pending');
      queueArr.push(item);
      emit('enqueued', item);
    }
    if (!processing) processNext();
  }

  async function processNext() {
    if (processing) return;
    processing = true;
    try {
      while (queueArr.length > 0) {
        const item = queueArr.shift();
        state.set(item.invoiceId, 'running');
        emit('started', item);
        try {
          await runRegenerate(item);                // definida en Task 4
          state.set(item.invoiceId, 'done');
          completedSet.add(item.invoiceId);
          emit('done', item);
        } catch (err) {
          console.warn(`[AutoRegen] Error regenerando factura #${item.idInDomain} (id=${item.invoiceId}):`, err?.message || err);
          state.set(item.invoiceId, 'error');
          emit('error', { ...item, error: err });
        }
        await sleep(200);                            // espaciado serial
      }
    } finally {
      processing = false;
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Regenerator ──

  async function runRegenerate(item) {
    if (!api()) throw new Error('SteelheadAPI no disponible');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const data = await Promise.race([
        api().query('CreateInvoicePdf', { invoiceId: item.invoiceId }, 'CreateInvoicePdf'),
        new Promise((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('Timeout 15s en CreateInvoicePdf')));
        })
      ]);
      const pdfId = data?.createInvoicePdf?.invoicePdf?.id;
      if (!pdfId) throw new Error('Respuesta sin invoicePdf.id');
      console.log(`[AutoRegen] Factura #${item.idInDomain} regenerada → invoicePdf.id=${pdfId}`);
      return pdfId;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Row UI ──

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    pending: '<path d="M8 4v4l2.5 2.5" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5"/>',
    running: '<circle cx="8" cy="8" r="6" stroke-dasharray="20" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle>',
    done:    '<path d="M3 8.5l3.5 3.5L13 5" stroke-linecap="round" stroke-linejoin="round"/>',
    error:   '<path d="M8 4v5M8 11.5v.5" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5"/>'
  };
  const COLORS = { pending: '#6b7280', running: '#2563eb', done: '#16a34a', error: '#dc2626' };
  const TIPS = {
    pending: 'En cola para regenerar',
    running: 'Regenerando factura…',
    done:    'Regenerada',
    error:   'Error al regenerar (click reintenta)'
  };

  function buildBadge(state) {
    const wrap = document.createElement('span');
    wrap.className = 'sa-auto-regen-badge';
    wrap.dataset.saRegenState = state;
    wrap.title = TIPS[state] || '';
    wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:4px;vertical-align:middle;cursor:default;';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', COLORS[state]);
    svg.setAttribute('stroke-width', '1.6');
    // Rellenar SVG con el path correcto via temporary container (parser-safe)
    const tmp = document.createElementNS(SVG_NS, 'g');
    tmp.innerHTML = ICONS[state];
    while (tmp.firstChild) svg.appendChild(tmp.firstChild);
    wrap.appendChild(svg);
    return wrap;
  }

  // Encuentra la fila del dashboard correspondiente al idInDomain
  // Steelhead pinta cada fila con texto "#<idInDomain>" visible.
  // Buscamos el span/link con ese texto y subimos al row contenedor.
  function findDashboardRow(idInDomain) {
    const tag = `#${idInDomain}`;
    // Match exacto del texto del nodo
    const all = document.querySelectorAll('a, span, div');
    for (const el of all) {
      if (el.children.length === 0 && el.textContent && el.textContent.trim() === tag) {
        // Subir hasta el contenedor de la fila (heurística: buscar ancestro con varios hijos)
        let cur = el.parentElement;
        for (let i = 0; cur && i < 8; i++, cur = cur.parentElement) {
          if (cur.children.length >= 4) return cur;  // fila tiene varios elementos
        }
        return el.parentElement;
      }
    }
    return null;
  }

  // Inyecta o actualiza el badge en la fila. Si no existe la fila, no-op.
  function paintRow(idInDomain, state) {
    const row = findDashboardRow(idInDomain);
    if (!row) return;
    let badge = row.querySelector('.sa-auto-regen-badge');
    const newBadge = buildBadge(state);
    if (badge) {
      badge.replaceWith(newBadge);
    } else {
      // Insertar al inicio de la fila
      row.insertBefore(newBadge, row.firstChild);
    }
    if (state === 'done') {
      // Fade-out a 40% opacidad después de 5s
      setTimeout(() => {
        if (newBadge.isConnected) newBadge.style.opacity = '0.4';
      }, 5000);
    }
  }

  // Re-pinta los badges activos cuando Steelhead re-renderiza la tabla.
  let observer = null;
  function setupRowObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      for (const [invoiceId, st] of state.entries()) {
        if (st === 'done' && completedSet.has(invoiceId)) continue;  // ya pintada
        // Buscar item por invoiceId no es directo; usamos el set inverso
        const item = _itemByInvoiceId.get(invoiceId);
        if (!item) continue;
        const row = findDashboardRow(item.idInDomain);
        if (row && !row.querySelector('.sa-auto-regen-badge')) {
          paintRow(item.idInDomain, st);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Cache para encontrar idInDomain rápidamente al re-pintar
  const _itemByInvoiceId = new Map();
  function rememberItem(item) { _itemByInvoiceId.set(item.invoiceId, item); }

  // ── Modal Badge ──

  // Encuentra el header "Invoice History" en el modal abierto
  function findInvoiceHistoryHeader() {
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="heading"], [class*="title"]');
    for (const h of headings) {
      if (h.textContent && /invoice\s+history/i.test(h.textContent.trim())) return h;
    }
    return null;
  }

  function paintModal(state) {
    const header = findInvoiceHistoryHeader();
    if (!header) return;
    let badge = header.querySelector('.sa-auto-regen-badge');
    const newBadge = buildBadge(state);
    newBadge.style.marginLeft = '8px';
    if (badge) {
      badge.replaceWith(newBadge);
    } else {
      header.appendChild(newBadge);
    }
    if (state === 'done') {
      setTimeout(() => { if (newBadge.isConnected) newBadge.style.opacity = '0.4'; }, 5000);
    }
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.InvoiceAutoRegen = InvoiceAutoRegen;
  InvoiceAutoRegen.init();
}
