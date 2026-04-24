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
    console.log('[AutoRegen] Inicializado');
  }

  // ── Fetch Interceptor (placeholder, llenado en Task 7) ──

  function patchFetch() {
    if (window.__saAutoRegenPatched) return;
    window.__saAutoRegenPatched = true;
    _origFetch = window.fetch;
    // Cableado real en Task 7 (controller)
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

  // Stub: implementación real en Task 4
  async function runRegenerate(item) {
    throw new Error('runRegenerate not implemented yet');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.InvoiceAutoRegen = InvoiceAutoRegen;
  InvoiceAutoRegen.init();
}
