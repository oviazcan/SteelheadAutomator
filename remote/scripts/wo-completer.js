// Completar / Descompletar OTs — orquestador + panel (dark-mode).
// Se abre desde el popup de la extensión (fn: WOCompleter.open). Pega una lista de
// números de OT (idInDomain), valida en dry-run y ejecuta:
//   COMPLETAR    -> AddPartsToWorkOrders (transfer type COMPLETE por cada cuenta activa)
//   DESCOMPLETAR -> CreateManyPartsTransfersChecked (REVERT_COMPLETE por cada COMPLETE vivo)
//
// Motor puro y golden tests: wo-completer-engine.js / tools/test/wo-completer-engine.test.js
// Diseño: docs/superpowers/specs/2026-06-30-wo-completer-design.md
// Depende de: SteelheadAPI + SteelheadWOCompleterEngine + SteelheadHostCleanup
const WOCompleter = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const engine = () => window.SteelheadWOCompleterEngine;
  const hostCleanup = () => window.SteelheadHostCleanup;

  const CONCURRENCY = 5;

  const state = {
    mode: 'complete', // 'complete' | 'revert'
    rows: [],
    running: false,
    cancel: false,
    memMonitor: null,
    overlay: null,
  };

  // ── API layer (slim responses — EJE A) ─────────────────────────────────────
  async function fetchWorkOrderSlim(idInDomain) {
    const data = await api().query('WorkOrder', { idInDomain }, 'WorkOrder');
    const wo = data && data.workOrderByIdInDomain;
    if (!wo) return null;
    const nodes = ((wo.currentPartsTransferAccounts && wo.currentPartsTransferAccounts.nodes) || [])
      .map((a) => ({
        id: a.id,
        partCount: a.partCount,
        receivedOrderPartTransformId: a.receivedOrderPartTransformId,
        locationByLocationId: a.locationByLocationId ? { id: a.locationByLocationId.id } : null,
        nodeName: a.recipeNodeByRecipeNodeId ? a.recipeNodeByRecipeNodeId.name : null,
        nodeType: a.recipeNodeByRecipeNodeId ? a.recipeNodeByRecipeNodeId.type : null,
      }));
    return {
      idInDomain: wo.idInDomain,
      id: wo.id,
      name: wo.name,
      completedAt: wo.completedAt,
      currentPartsTransferAccounts: { nodes },
    };
  }

  async function fetchTransfersSlim(idInDomain) {
    const vars = {
      idInDomain, first: 200, offset: 0, orderBy: ['AT_DESC'], includeReverts: true,
      searchPartNumberName: null, searchCreatorName: null, searchStationName: null,
      searchRackName: null, searchPartGroupName: null, searchWorkOrderName: null,
      searchWorkOrderIdInDomain: null, searchMaterialConversionIds: null,
    };
    const data = await api().query('GetWorkOrderPartsTransfers', vars, 'GetWorkOrderPartsTransfers');
    const wo = data && data.workOrderByIdInDomain;
    if (!wo) return null;
    const nodes = (wo.workOrderPartsTransfers && wo.workOrderPartsTransfers.nodes) || [];
    return nodes.map((t) => ({
      id: t.id,
      type: t.type,
      partCount: t.partCount,
      fromAccountId: t.fromAccountId,
      at: t.at,
      revertsPartsTransferId: t.revertsPartsTransferId,
      partsTransfersByRevertsPartsTransferId: {
        nodes: ((t.partsTransfersByRevertsPartsTransferId &&
          t.partsTransfersByRevertsPartsTransferId.nodes) || []).map((n) => ({ id: n.id })),
      },
    }));
  }

  async function runComplete(input) {
    return api().query('AddPartsToWorkOrders', { input }, 'AddPartsToWorkOrders');
  }
  async function runRevert(payload) {
    return api().query('CreateManyPartsTransfersChecked', payload, 'CreateManyPartsTransfersChecked');
  }

  // ── Pool de concurrencia ───────────────────────────────────────────────────
  async function runPool(items, worker, concurrency, onTick) {
    const results = new Array(items.length);
    let i = 0;
    async function lane() {
      while (i < items.length && !state.cancel) {
        const idx = i++;
        try { results[idx] = await worker(items[idx], idx); }
        catch (e) { results[idx] = { _poolError: e && e.message ? e.message : String(e) }; }
        if (onTick) onTick();
      }
    }
    const lanes = Array.from({ length: Math.min(concurrency, items.length || 1) }, lane);
    await Promise.all(lanes);
    return results;
  }

  // ── Validación (dry-run, no escribe) ───────────────────────────────────────
  async function validate() {
    if (state.running) return;
    const txt = (byId('woc-input') || {}).value || '';
    const ids = engine().parseWoList(txt);
    if (!ids.length) { setStatus('Pega al menos un número de OT.', true); return; }

    state.cancel = false;
    setRunning(true);
    hostCleanup() && hostCleanup().stopDatadogSessionReplay && hostCleanup().stopDatadogSessionReplay();
    const drain = (hostCleanup() && hostCleanup().makePeriodicDrain) ? hostCleanup().makePeriodicDrain(25) : () => {};

    let done = 0;
    const tick = () => { done++; setStatus(`Validando ${done}/${ids.length}…`); };

    const rows = await runPool(ids, async (idInDomain) => {
      if (state.mode === 'complete') {
        const wo = await fetchWorkOrderSlim(idInDomain);
        drain();
        if (!wo) return { idInDomain, status: 'notfound' };
        const accts = wo.currentPartsTransferAccounts.nodes;
        const built = engine().buildCompletePayload(wo);
        return {
          idInDomain, name: wo.name || '', completedAt: wo.completedAt,
          accountsCount: accts.length,
          parts: accts.reduce((s, a) => s + (a.partCount || 0), 0),
          nodes: [...new Set(accts.map((a) => a.nodeName).filter(Boolean))],
          built,
          status: built.skip ? 'skip' : 'ready',
          skipReason: built.skip ? built.reason : null,
        };
      }
      const transfers = await fetchTransfersSlim(idInDomain);
      drain();
      if (!transfers) return { idInDomain, status: 'notfound' };
      const completes = engine().pickRevertableCompletes(transfers);
      return {
        idInDomain,
        accountsCount: completes.length,
        parts: completes.reduce((s, t) => s + (t.partCount || 0), 0),
        nodes: [],
        payloads: completes.map((t) => ({ transfer: t, payload: engine().buildRevertPayload(t) })),
        status: completes.length ? 'ready' : 'skip',
        skipReason: completes.length ? null : 'sin COMPLETE por revertir',
      };
    }, CONCURRENCY, tick);

    state.rows = rows.map((r, idx) => (r && !r._poolError)
      ? r
      : { idInDomain: ids[idx], status: 'error', error: (r && r._poolError) || 'sin resultado' });

    setRunning(false);
    renderPreview();
    const readyCount = state.rows.filter((r) => r.status === 'ready').length;
    setStatus(`Listo: ${readyCount} OT(s) accionables de ${ids.length}. Revisa y ejecuta.`);
    setExecuteEnabled(readyCount > 0);
  }

  // ── Ejecución (escribe al ERP) ─────────────────────────────────────────────
  async function execute() {
    if (state.running) return;
    const ready = state.rows.filter((r) => r.status === 'ready');
    if (!ready.length) return;

    const parts = ready.reduce((s, r) => s + (r.parts || 0), 0);
    const verb = state.mode === 'complete' ? 'COMPLETAR' : 'DESCOMPLETAR';
    const detail = state.mode === 'complete'
      ? `${ready.length} OTs (${ready.reduce((s, r) => s + (r.accountsCount || 0), 0)} cuentas, ${parts.toLocaleString()} piezas)`
      : `${ready.length} OTs (${ready.reduce((s, r) => s + (r.accountsCount || 0), 0)} transfers, ${parts.toLocaleString()} piezas)`;
    if (!window.confirm(`Vas a ${verb} ${detail}.\n\nEsto ESCRIBE en Steelhead. ¿Continuar?`)) return;

    state.cancel = false;
    setRunning(true);
    hostCleanup() && hostCleanup().stopDatadogSessionReplay && hostCleanup().stopDatadogSessionReplay();
    const drain = (hostCleanup() && hostCleanup().makePeriodicDrain) ? hostCleanup().makePeriodicDrain(25) : () => {};

    let done = 0; let ok = 0; let fail = 0;
    await runPool(ready, async (r) => {
      try {
        if (state.mode === 'complete') {
          await runComplete(r.built.input);
        } else {
          for (const p of r.payloads) {
            if (state.cancel) break;
            await runRevert(p.payload);
          }
        }
        r.status = 'done'; r.result = 'ok'; ok++;
      } catch (e) {
        r.status = 'failed'; r.result = 'error'; r.error = (e && e.message) ? e.message : String(e); fail++;
      }
      drain();
      done++;
      setStatus(`Ejecutando ${done}/${ready.length} · ${ok} OK · ${fail} error`);
      renderRowResult(r);
    }, 4);

    setRunning(false);
    setStatus(`Terminado: ${ok} OK, ${fail} con error, de ${ready.length}.`, fail > 0);
    setExecuteEnabled(false);
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }

  function ensureStyles() {
    if (byId('woc-styles')) return;
    const css = [
      '.woc-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.woc-modal{background:#1c2430;color:#e6e9ee;border-radius:18px;padding:24px 28px;width:860px;max-width:96vw;max-height:94vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);box-sizing:border-box}',
      '.woc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}',
      '.woc-title{font-size:19px;font-weight:700;display:flex;align-items:center;gap:9px}',
      '.woc-x{background:none;border:none;color:#93a1b3;font-size:24px;cursor:pointer;line-height:1}',
      '.woc-mem{font-size:11px;color:#6b7a8d;font-variant-numeric:tabular-nums;margin-left:8px}',
      '.woc-modes{display:inline-flex;background:#141a23;border:1px solid #33404f;border-radius:10px;padding:3px;margin-bottom:14px}',
      '.woc-mode{padding:8px 18px;border:none;background:none;color:#aeb9c6;font-size:14px;font-weight:600;cursor:pointer;border-radius:8px}',
      '.woc-mode.active{background:#13a36f;color:#fff}',
      '.woc-mode.active.rev{background:#c2410c}',
      '.woc-label{font-size:13px;color:#aeb9c6;margin:8px 0 6px}',
      '.woc-textarea{width:100%;min-height:120px;padding:11px 13px;border-radius:9px;border:1px solid #3a4757;background:#141a23;color:#e6e9ee;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box;resize:vertical}',
      '.woc-actions{display:flex;gap:10px;margin:14px 0}',
      '.woc-btn{padding:10px 18px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer}',
      '.woc-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.woc-btn-secondary{background:#2a3646;color:#e6e9ee}',
      '.woc-btn-primary{background:#13a36f;color:#fff}',
      '.woc-btn-danger{background:#c2410c;color:#fff}',
      '.woc-status{font-size:13px;color:#cbd5e1;min-height:18px;margin:6px 0}',
      '.woc-status.err{color:#f0a58a}',
      '.woc-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}',
      '.woc-table th{text-align:left;color:#93a1b3;font-weight:600;padding:6px 8px;border-bottom:1px solid #33404f;position:sticky;top:0;background:#1c2430}',
      '.woc-table td{padding:6px 8px;border-bottom:1px solid #263140;vertical-align:top}',
      '.woc-tag{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:700}',
      '.woc-tag.ready{background:#0f3d2e;color:#5ee0a8}',
      '.woc-tag.skip{background:#3a2f10;color:#e6c06a}',
      '.woc-tag.notfound{background:#3a1520;color:#f0a58a}',
      '.woc-tag.error,.woc-tag.failed{background:#3a1520;color:#f0a58a}',
      '.woc-tag.done{background:#123a5a;color:#7cc4f5}',
      '.woc-node{color:#8fa0b3;font-size:12px}',
      '.woc-tablewrap{max-height:46vh;overflow-y:auto;border:1px solid #263140;border-radius:9px;margin-top:6px}',
    ].join('\n');
    const s = document.createElement('style');
    s.id = 'woc-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function setStatus(msg, isErr) {
    const el = byId('woc-status');
    if (el) { el.textContent = msg; el.classList.toggle('err', !!isErr); }
  }
  function setRunning(v) {
    state.running = v;
    const val = byId('woc-validate'); const exe = byId('woc-execute');
    if (val) val.disabled = v;
    if (exe && v) exe.disabled = true;
  }
  function setExecuteEnabled(v) {
    const exe = byId('woc-execute');
    if (exe) exe.disabled = !v || state.running;
  }

  function setMode(mode) {
    state.mode = mode;
    state.rows = [];
    const cBtn = byId('woc-mode-complete'); const rBtn = byId('woc-mode-revert');
    if (cBtn) cBtn.classList.toggle('active', mode === 'complete');
    if (rBtn) { rBtn.classList.toggle('active', mode === 'revert'); rBtn.classList.toggle('rev', mode === 'revert'); }
    const exe = byId('woc-execute');
    if (exe) {
      exe.textContent = mode === 'complete' ? 'Completar' : 'Descompletar';
      exe.className = 'woc-btn ' + (mode === 'complete' ? 'woc-btn-primary' : 'woc-btn-danger');
      exe.disabled = true;
    }
    renderPreview();
    setStatus('');
  }

  function statusTag(row) {
    const map = {
      ready: 'listo', skip: 'omitir', notfound: 'no existe',
      error: 'error', failed: 'error', done: 'hecho',
    };
    return `<span class="woc-tag ${row.status}">${map[row.status] || row.status}</span>`;
  }

  function renderPreview() {
    const wrap = byId('woc-preview');
    if (!wrap) return;
    if (!state.rows.length) { wrap.innerHTML = ''; return; }
    const unit = state.mode === 'complete' ? 'cuentas' : 'transfers';
    const rowsHtml = state.rows.map((r) => {
      const detail = r.status === 'notfound' ? 'OT no encontrada'
        : r.status === 'error' || r.status === 'failed' ? (r.error || '—')
        : r.status === 'skip' ? (r.skipReason || (r.completedAt ? 'ya completada' : '—'))
        : `${r.accountsCount} ${unit} · ${(r.parts || 0).toLocaleString()} pzs`;
      const nodes = (r.nodes && r.nodes.length) ? `<div class="woc-node">${escapeHtml(r.nodes.join(', '))}</div>` : '';
      return `<tr id="woc-row-${r.idInDomain}"><td><b>${r.idInDomain}</b></td><td>${statusTag(r)}</td><td>${escapeHtml(detail)}${nodes}</td></tr>`;
    }).join('');
    wrap.innerHTML =
      `<div class="woc-tablewrap"><table class="woc-table"><thead><tr>` +
      `<th>OT</th><th>Estado</th><th>Detalle</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
  }

  function renderRowResult(r) {
    const tr = byId(`woc-row-${r.idInDomain}`);
    if (!tr) return;
    const tds = tr.querySelectorAll('td');
    if (tds[1]) tds[1].innerHTML = statusTag(r);
    if (tds[2] && r.status === 'failed') tds[2].textContent = r.error || 'error';
    if (tds[2] && r.status === 'done') tds[2].textContent = state.mode === 'complete' ? 'completada' : 'revertida';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function closePanel() {
    if (state.memMonitor) { try { state.memMonitor.stop(); } catch (_) {} state.memMonitor = null; }
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    state.overlay = null;
    state.rows = [];
    state.running = false;
    state.cancel = true;
  }

  function open() {
    // El handler genérico de la extensión toma el valor de retorno del fn como
    // resultado; si es undefined muestra "Error: Sin resultado". Devolvemos un
    // objeto serializable truthy para que el popup no lo trate como error.
    if (byId('woc-overlay')) return { ok: true, alreadyOpen: true }; // ya abierto
    ensureStyles();
    const overlay = document.createElement('div');
    overlay.className = 'woc-overlay';
    overlay.id = 'woc-overlay';
    overlay.innerHTML = `
      <div class="woc-modal" id="woc-modal">
        <div class="woc-head">
          <div class="woc-title">✅ Completar / Descompletar OTs <span class="woc-mem" id="woc-mem"></span></div>
          <button class="woc-x" id="woc-close" title="Cerrar">×</button>
        </div>
        <div class="woc-modes">
          <button class="woc-mode active" id="woc-mode-complete">Completar</button>
          <button class="woc-mode" id="woc-mode-revert">Descompletar</button>
        </div>
        <div class="woc-label">Números de OT (uno por línea; se toleran comas/tabs para pegar una columna de Excel):</div>
        <textarea class="woc-textarea" id="woc-input" placeholder="5119&#10;5436&#10;10515"></textarea>
        <div class="woc-actions">
          <button class="woc-btn woc-btn-secondary" id="woc-validate">Validar</button>
          <button class="woc-btn woc-btn-primary" id="woc-execute" disabled>Completar</button>
        </div>
        <div class="woc-status" id="woc-status"></div>
        <div id="woc-preview"></div>
      </div>`;
    document.body.appendChild(overlay);
    state.overlay = overlay;

    byId('woc-close').addEventListener('click', closePanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
    byId('woc-mode-complete').addEventListener('click', () => setMode('complete'));
    byId('woc-mode-revert').addEventListener('click', () => setMode('revert'));
    byId('woc-validate').addEventListener('click', () => { validate().catch((e) => setStatus(e.message, true)); });
    byId('woc-execute').addEventListener('click', () => { execute().catch((e) => setStatus(e.message, true)); });

    // Memory monitor (EJE B) — arranca al abrir, se detiene en closePanel.
    if (hostCleanup() && hostCleanup().createMemMonitor) {
      state.memMonitor = hostCleanup().createMemMonitor({
        getElement: () => byId('woc-mem'),
        onGuardrail: (pct) => {
          state.cancel = true;
          setStatus(`Memoria al ${pct}% — corrida cancelada. Recarga la pestaña antes de continuar.`, true);
        },
      });
      state.memMonitor.start();
    }
    setMode('complete');
    return { ok: true };
  }

  return { open, close: closePanel, _validate: validate, _execute: execute };
})();

if (typeof window !== 'undefined') window.WOCompleter = WOCompleter;
