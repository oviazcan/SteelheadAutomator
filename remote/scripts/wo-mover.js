// WO Mover — Mover OTs (work orders) entre OVs (received orders)
// Mecanismo: editar el ENCABEZADO de la OT (CreateUpdateWorkOrdersChecked con id
//            poblado + receivedOrderId nuevo). Conserva la misma OT.
// ALCANCE v0.2: SOLO reasigna el encabezado. La parte (ReceivedOrderPartTransform /
//            línea de OV) queda en la OV origen y se asocia a mano en Steelhead
//            (la UI no expone esa asociación por API — ver docs/applets/wo-mover.md).
//            v2 futura: cantidad parcial.
// Depende de: SteelheadAPI, OVOperations (window.OVOperations), SteelheadHostCleanup.
// Plan: ~/.claude/plans/necesito-hacer-un-applet-staged-lightning.md

const WOMover = (() => {
  'use strict';

  const VERSION = '0.2.1';

  const api = () => window.SteelheadAPI;
  const ovops = () => window.OVOperations;
  const host = () => window.SteelheadHostCleanup;
  const log = (m) => api()?.log?.(m) ?? console.log('[WM]', m);
  const warn = (m) => api()?.warn?.(m) ?? console.warn('[WM]', m);

  // Detección: estamos parados en el DETALLE de una OV → capturamos el idInDomain.
  // OJO: el número de la URL es el idInDomain (display), NO el id interno.
  const URL_RE = /\/Domains\/\d+\/ReceivedOrders\/(\d+)/i;

  const CANDIDATE_CAP = 100;   // tope de OVs candidatas cargadas (memory hardening)
  const DRAIN_EVERY = 10;      // drenar Apollo cache cada N OVs cargadas

  // Advertencia base: este applet SOLO reasigna el encabezado de la OT. La parte
  // (ReceivedOrderPartTransform / línea) queda en la OV origen y debe asociarse a
  // mano en Steelhead (la UI no expone esa asociación por API — ver bitácora).
  const NOTE_BASE = '⚠️ Solo reasigna el encabezado de la OT. La parte se asocia a la línea de la OV destino manualmente en Steelhead.';

  // ── Estado (se reinicia entero en closePanel) ──
  let state = freshState();
  function freshState() {
    return {
      isOpen: false,
      busy: false,
      sourceOV: null,        // { id, idInDomain, name, customerId, ots[] }
      candidateOVs: [],      // [{ id, idInDomain, name, pnSet:Set<string> }]
      candidatesTruncated: false,
      filterByPN: true,      // toggle: true = solo OVs con el mismo PN
      rows: [],              // [{ ot, destOvId, selected, status, error }]
      auditLog: [],          // [{ ts, woId, sourceOv, destOv, pn, partCount, status }]
      memMonitor: null,
    };
  }

  // ── Helpers de texto ──
  function esc(s) {
    if (ovops()?.escHtml) return ovops().escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function fmtNum(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString('es-MX') : String(n ?? '');
  }
  function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ── Extractors de OV (portados de po-reconciler.js:1236-1263) ──
  function shipToObj(ov) {
    return ov?.customerAddressByShipToAddressId
        ?? ov?.shipToAddressByShipToAddressId
        ?? ov?.shipToAddress
        ?? null;
  }
  function shipToId(ov) {
    return shipToObj(ov)?.id ?? ov?.shipToAddressId ?? null;
  }
  function customerObj(ov) {
    return ov?.customerByCustomerId ?? ov?.customer ?? null;
  }
  function customerIdOf(ov) {
    return customerObj(ov)?.id ?? ov?.customerId ?? null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Init / navegación SPA / FAB contextual (patrón po-reconciler.js:30-80)
  // ───────────────────────────────────────────────────────────────────────────
  function init() {
    if (window.__saWoMoverInit) return;
    window.__saWoMoverInit = true;
    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
    listenManualTrigger();
  }

  function extractIdInDomain() {
    const m = location.pathname.match(URL_RE);
    return m ? parseInt(m[1], 10) : null;
  }
  function isAllowedPath() {
    return extractIdInDomain() != null;
  }

  function syncFabVisibility() {
    const should = isAllowedPath();
    const existing = document.getElementById('sa-wm-fab');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) existing.remove();
  }

  function renderFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'sa-wm-fab';
    btn.className = 'sa-wm-fab';
    btn.title = 'Mover OTs de esta OV a otra';
    btn.textContent = '↔️';
    btn.onclick = openPanel;
    document.body.appendChild(btn);
  }

  function installUrlChangeListener() {
    if (window.__saWoMoverUrlListener) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saWoMoverUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  function listenManualTrigger() {
    chrome.runtime?.onMessage?.addListener?.((msg) => {
      if (msg && msg.action === 'run-wo-mover') openPanel();
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Carga de datos (GraphQL de LECTURA — hashes ya validados)
  // ───────────────────────────────────────────────────────────────────────────

  // GetReceivedOrder (hash rotado 2026-06-01 → 4fa89e55…) requiere idInDomain (Int!).
  // El nuevo query trae TODO en una sola pasada: workOrders, partTransforms (con
  // currentPartsTransferAccounts que ligan workOrderId ↔ partsTransferAccountId),
  // líneas y partAccountsNotAssignedToReceivedOrder. Ya no hace falta el Pass 2.
  async function loadOVDetails(idInDomain) {
    if (idInDomain == null) throw new Error('loadOVDetails requiere idInDomain');
    const data = await api().query('GetReceivedOrder', { idInDomain: parseInt(idInDomain, 10) });
    const ov = data?.receivedOrderByIdInDomain || data?.receivedOrder;
    if (!ov) throw new Error(`GetReceivedOrder(idInDomain=${idInDomain}) devolvió shape inesperado`);

    const lines = ov.receivedOrderLinesByReceivedOrderId?.nodes || ov.receivedOrderLines?.nodes || [];
    const workOrders = ov.workOrdersByReceivedOrderId?.nodes || [];
    const partTransforms = ov.receivedOrderPartTransformsByReceivedOrderId?.nodes || [];
    const unassigned = ov.partAccountsNotAssignedToReceivedOrder?.nodes || [];

    // Index workOrderId → { pt, pta } vía currentPartsTransferAccounts.
    const linkByWoId = {};
    for (const pt of partTransforms) {
      for (const a of (pt.currentPartsTransferAccounts?.nodes || [])) {
        if (a?.workOrderId != null) linkByWoId[a.workOrderId] = { pt, pta: a };
      }
    }

    const ots = [];
    const seen = new Set();
    for (const wo of workOrders) {
      if (seen.has(wo.id)) continue;
      seen.add(wo.id);
      const pnwo = wo.partNumberWorkOrdersByWorkOrderId?.nodes?.[0] || {};
      const recipeNode = wo.recipeNodesByWorkOrderId?.nodes?.[0] || {};
      const { pt = null, pta = null } = linkByWoId[wo.id] || {};
      const partNumberId = pnwo.partNumberId ?? pt?.partNumberId ?? null;
      const partNumber = pt?.partNumberByPartNumberId?.name || findPNStringForPT(lines, pt?.id) || '';
      ots.push({
        id: wo.id,
        idInDomain: wo.idInDomain ?? null,
        name: wo.name || wo.idInDomain || wo.id,
        partCount: Number(pta?.partCount ?? pt?.count ?? 0),
        partNumberId,
        partNumber,
        receivedOrderPartTransformId: pt?.id ?? null,
        partsTransferAccountId: pta?.id ?? null,   // para "Asociar partes"
        recipeNodeId: recipeNode.id ?? null,
        raw: wo,
      });
    }

    return {
      id: ov.id,
      idInDomain: ov.idInDomain,
      name: ov.name,
      customerId: customerIdOf(ov),
      customerName: customerObj(ov)?.name || '',
      shipToAddressId: shipToId(ov),
      lines,
      ots,
      partTransforms,
      unassigned,          // partAccounts que llegaron al mover y faltan asociar
      snapshot: ov,
    };
  }

  // Portado de po-reconciler.js:1547
  function findPNStringForPT(lines, ptId) {
    for (const line of lines) {
      const lineItems = line.receivedOrderLineItemsByReceivedOrderLineId?.nodes || [];
      for (const li of lineItems) {
        const ptAssocs = li.receivedOrderLineItemPartTransformsByReceivedOrderLineItemId?.nodes || [];
        for (const a of ptAssocs) {
          const stub = a.receivedOrderPartTransformByReceivedOrderPartTransformId || a.receivedOrderPartTransform;
          if (stub?.id === ptId) return line.name || '';
        }
      }
    }
    return '';
  }

  // ActiveReceivedOrders (hash rotado 2026-06-01 → 495ddfd6…). El shape de
  // variables CAMBIÓ: ya no usa domainId; ahora includeArchived/receivedOrder
  // StatusFilter/searchQuery. No filtra por cliente server-side → client-side.
  // Root key: pagedData { totalCount, nodes }.
  async function fetchActiveOrdersPage({ first = 100, offset = 0 } = {}) {
    const variables = {
      includeArchived: 'NO',
      computeMargins: false,
      showInvoicedSubtotal: false,
      isBlanketOrder: false,
      orderBy: ['ID_IN_DOMAIN_DESC'],
      offset, first,
      receivedOrderStatusFilter: ['OPEN'],
      searchQuery: '',
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const pd = data?.pagedData;
    if (pd && Array.isArray(pd.nodes)) return { items: pd.nodes, totalCount: pd.totalCount ?? null };
    for (const k of Object.keys(data || {})) {
      const v = data[k];
      if (v && typeof v === 'object' && Array.isArray(v.nodes)) {
        return { items: v.nodes, totalCount: v.totalCount ?? null };
      }
    }
    return { items: [], totalCount: null };
  }

  async function fetchActiveOrders({ first = 100, capPages = 10 } = {}) {
    const items = [];
    let total = null;
    for (let page = 0; page < capPages; page++) {
      const r = await fetchActiveOrdersPage({ first, offset: page * first });
      if (!r.items.length) break;
      items.push(...r.items);
      total = r.totalCount;
      if (total != null && items.length >= total) break;
    }
    return { items, total };
  }

  // Lista OVs candidatas del cliente. Slim: solo {id, idInDomain, name, pnSet}.
  // Si filterByPN, carga las líneas de cada candidata (GetReceivedOrder) para
  // poblar pnSet — con cap, drain periódico de Apollo y reporte de truncado.
  async function loadCandidateOVs(customerId, sourceIdInDomain, onProgress) {
    const { items } = await fetchActiveOrders({ first: 200, capPages: 10 });
    const filtered = items.filter(ov => {
      if (ov.archivedAt) return false;
      if (String(customerIdOf(ov) ?? '') !== String(customerId)) return false;
      if (String(ov.idInDomain) === String(sourceIdInDomain)) return false; // excluir origen
      return true;
    });

    state.candidatesTruncated = filtered.length > CANDIDATE_CAP;
    const capped = filtered.slice(0, CANDIDATE_CAP);

    const drain = host()?.makePeriodicDrain ? host().makePeriodicDrain(DRAIN_EVERY) : () => {};
    const out = [];
    for (let i = 0; i < capped.length; i++) {
      const ov = capped[i];
      const entry = { id: ov.id, idInDomain: ov.idInDomain, name: ov.name, pnSet: new Set() };
      try {
        const data = await api().query('GetReceivedOrder', { idInDomain: parseInt(ov.idInDomain, 10) });
        const full = data?.receivedOrderByIdInDomain || data?.receivedOrder;
        const lines = full?.receivedOrderLinesByReceivedOrderId?.nodes || full?.receivedOrderLines?.nodes || [];
        for (const line of lines) {
          const pn = (line.name || '').trim();
          if (pn) entry.pnSet.add(pn);
        }
      } catch (e) {
        warn(`No pude cargar PNs de OV #${ov.idInDomain}: ${e.message}`);
      }
      out.push(entry);
      drain();
      if (onProgress) onProgress(i + 1, capped.length);
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Propuestas y filtrado
  // ───────────────────────────────────────────────────────────────────────────
  function candidatesForOT(ot) {
    if (state.filterByPN) {
      return state.candidateOVs.filter(c => c.pnSet.has((ot.partNumber || '').trim()));
    }
    return state.candidateOVs;
  }

  function buildProposals() {
    state.rows = state.sourceOV.ots.map(ot => {
      const matches = state.candidateOVs.filter(c => c.pnSet.has((ot.partNumber || '').trim()));
      return {
        ot,
        destOvId: matches[0]?.id ?? '',   // default: primera OV que ya tiene el PN
        selected: false,
        status: 'pending',
        error: null,
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-wm-styles')) return;
    const css = `
      .sa-wm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 999999;
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .sa-wm-modal { background: #fff; width: min(96vw, 1100px); height: min(90vh, 760px);
        border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      .sa-wm-header { display: flex; justify-content: space-between; align-items: center;
        padding: 14px 22px; border-bottom: 1px solid #e5e7eb; }
      .sa-wm-header h2 { margin: 0; font-size: 17px; }
      .sa-wm-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
      .sa-wm-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280; }
      .sa-wm-toolbar { display: flex; align-items: center; gap: 16px; padding: 10px 22px;
        border-bottom: 1px solid #e5e7eb; background: #f9fafb; font-size: 13px; }
      .sa-wm-toolbar label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .sa-wm-mem { margin-left: auto; font-size: 11px; color: #9ca3af; font-variant-numeric: tabular-nums; }
      .sa-wm-body { flex: 1; overflow: auto; padding: 0; }
      .sa-wm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .sa-wm-table th, .sa-wm-table td { padding: 8px 12px; border-bottom: 1px solid #eef0f2; text-align: left; vertical-align: middle; }
      .sa-wm-table th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; z-index: 1; }
      .sa-wm-table tr.sel { background: #eff6ff; }
      .sa-wm-table select { max-width: 320px; padding: 4px 6px; font-size: 12px; }
      .sa-wm-st { font-size: 16px; }
      .sa-wm-st.ok { color: #16a34a; } .sa-wm-st.err { color: #dc2626; } .sa-wm-st.run { color: #2563eb; }
      .sa-wm-footer { display: flex; justify-content: space-between; align-items: center;
        padding: 12px 22px; border-top: 1px solid #e5e7eb; gap: 12px; }
      .sa-wm-footer .sa-wm-note { font-size: 12px; color: #6b7280; }
      .sa-wm-btn { padding: 8px 16px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px;
        cursor: pointer; font-size: 14px; }
      .sa-wm-btn:disabled { opacity: .5; cursor: not-allowed; }
      .sa-wm-btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
      .sa-wm-btn.primary:disabled { background: #93c5fd; border-color: #93c5fd; }
      .sa-wm-placeholder { color: #6b7280; padding: 48px; text-align: center; }
      .sa-wm-warn { color: #d97706; padding: 10px 22px; font-size: 12px; background: #fffbeb; }
      .sa-wm-err { color: #dc2626; padding: 10px 22px; font-size: 13px; }
      .sa-wm-fab { position: fixed; bottom: 24px; right: 88px; width: 56px; height: 56px;
        background: #2563eb; color: #fff; border: none; border-radius: 50%; font-size: 22px;
        cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.25); z-index: 999998; }
    `;
    const s = document.createElement('style');
    s.id = 'sa-wm-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function removeOverlay() {
    document.getElementById('sa-wm-overlay')?.remove();
  }

  function showShell() {
    removeOverlay();
    const ov = document.createElement('div');
    ov.className = 'sa-wm-overlay';
    ov.id = 'sa-wm-overlay';
    ov.innerHTML = `
      <div class="sa-wm-modal" role="dialog" aria-modal="true">
        <div class="sa-wm-header">
          <div>
            <h2>Mover OTs entre OVs</h2>
            <div class="sa-wm-sub" id="sa-wm-srcline">Cargando OV…</div>
          </div>
          <button class="sa-wm-close" id="sa-wm-close" title="Cerrar">✕</button>
        </div>
        <div class="sa-wm-toolbar">
          <label><input type="checkbox" id="sa-wm-filter" checked> Solo OVs con el mismo PN</label>
          <label><input type="checkbox" id="sa-wm-all"> Seleccionar todo</label>
          <span class="sa-wm-mem" id="sa-wm-mem"></span>
        </div>
        <div class="sa-wm-body" id="sa-wm-body">
          <div class="sa-wm-placeholder">Cargando órdenes de trabajo…</div>
        </div>
        <div class="sa-wm-footer">
          <span class="sa-wm-note" id="sa-wm-note">${NOTE_BASE}</span>
          <div>
            <button class="sa-wm-btn" id="sa-wm-cancel">Cerrar</button>
            <button class="sa-wm-btn primary" id="sa-wm-exec" disabled>Ejecutar (0)</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#sa-wm-close').onclick = closePanel;
    ov.querySelector('#sa-wm-cancel').onclick = closePanel;
    ov.querySelector('#sa-wm-filter').onchange = (e) => { state.filterByPN = e.target.checked; renderTable(); };
    ov.querySelector('#sa-wm-all').onchange = (e) => toggleAll(e.target.checked);
    ov.querySelector('#sa-wm-exec').onclick = onExecuteClick;
  }

  function setSourceLine() {
    const el = document.getElementById('sa-wm-srcline');
    if (!el || !state.sourceOV) return;
    const s = state.sourceOV;
    el.textContent = `OV origen: #${s.idInDomain} — ${s.name || ''}  ·  Cliente: ${s.customerName || s.customerId} (id ${s.customerId})  ·  ${s.ots.length} OT(s)`;
  }

  function renderTable() {
    const body = document.getElementById('sa-wm-body');
    if (!body) return;
    if (!state.sourceOV) { body.innerHTML = `<div class="sa-wm-placeholder">Sin OV.</div>`; return; }
    if (!state.sourceOV.ots.length) {
      body.innerHTML = `<div class="sa-wm-placeholder">Esta OV no tiene órdenes de trabajo.</div>`;
      return;
    }

    const warnHtml = state.candidatesTruncated
      ? `<div class="sa-wm-warn">⚠️ El cliente tiene más de ${CANDIDATE_CAP} OVs activas; se cargaron las ${CANDIDATE_CAP} más recientes.</div>`
      : '';

    const rowsHtml = state.rows.map((row, i) => {
      const opts = candidatesForOT(row.ot);
      const optionsHtml = [
        `<option value="">— Sin destino —</option>`,
        ...opts.map(c => `<option value="${c.id}" ${String(c.id) === String(row.destOvId) ? 'selected' : ''}>#${c.idInDomain} · ${esc(truncate(c.name, 40))}</option>`),
        `<option value="__new__" ${row.destOvId === '__new__' ? 'selected' : ''}>➕ Crear OV nueva…</option>`,
      ].join('');
      const stIcon = row.status === 'ok' ? '<span class="sa-wm-st ok">✓</span>'
                   : row.status === 'error' ? `<span class="sa-wm-st err" title="${esc(row.error || '')}">✕</span>`
                   : row.status === 'running' ? '<span class="sa-wm-st run">⏳</span>' : '';
      return `
        <tr class="${row.selected ? 'sel' : ''}" data-i="${i}">
          <td><input type="checkbox" class="sa-wm-rowsel" data-i="${i}" ${row.selected ? 'checked' : ''}></td>
          <td>${esc(row.ot.name)}</td>
          <td>${esc(row.ot.partNumber || '(sin PN)')}</td>
          <td>${fmtNum(row.ot.partCount)}</td>
          <td><select class="sa-wm-dest" data-i="${i}">${optionsHtml}</select></td>
          <td>${stIcon}</td>
        </tr>`;
    }).join('');

    body.innerHTML = `${warnHtml}
      <table class="sa-wm-table">
        <thead><tr>
          <th style="width:34px"></th><th>OT</th><th>PN</th><th>Piezas</th><th>OV destino</th><th style="width:34px"></th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;

    body.querySelectorAll('.sa-wm-rowsel').forEach(cb => {
      cb.onchange = (e) => { state.rows[+e.target.dataset.i].selected = e.target.checked; refreshSelectionUI(); };
    });
    body.querySelectorAll('.sa-wm-dest').forEach(sel => {
      sel.onchange = (e) => { state.rows[+e.target.dataset.i].destOvId = e.target.value; refreshSelectionUI(); };
    });
    refreshSelectionUI();
  }

  function toggleAll(checked) {
    state.rows.forEach(r => r.selected = checked);
    renderTable();
    const all = document.getElementById('sa-wm-all');
    if (all) all.checked = checked;
  }

  function refreshSelectionUI() {
    const n = state.rows.filter(r => r.selected).length;
    const ready = state.rows.filter(r => r.selected && r.destOvId && r.destOvId !== '').length;
    const exec = document.getElementById('sa-wm-exec');
    if (exec && !state.busy) {
      exec.textContent = `Ejecutar (${n})`;
      exec.disabled = !(n > 0 && ready === n);   // habilita si todas las marcadas tienen destino
    }
    document.querySelectorAll('.sa-wm-table tbody tr').forEach((tr) => {
      const i = +tr.dataset.i;
      tr.classList.toggle('sel', !!state.rows[i]?.selected);
    });
    const note = document.getElementById('sa-wm-note');
    if (note && !state.busy) {
      if (n && ready < n) note.textContent = `${n - ready} fila(s) seleccionada(s) sin destino.`;
      else note.innerHTML = NOTE_BASE;
    }
  }

  function onExecuteClick() {
    if (state.busy) return;
    const rows = state.rows.filter(r => r.selected && r.destOvId && r.destOvId !== '');
    if (!rows.length) return;
    const msg = `Vas a reasignar el encabezado de ${rows.length} OT(s) a su OV destino.\n\n`
      + `IMPORTANTE: esto mueve la orden de trabajo, pero la PARTE (demanda/línea) se queda en `
      + `la OV origen. Después tendrás que ASOCIAR la parte a una línea de la OV destino manualmente `
      + `en Steelhead.\n\n¿Continuar?`;
    if (!confirm(msg)) return;
    executeSelectedRows();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ejecución (mutaciones)
  // ───────────────────────────────────────────────────────────────────────────

  // VALIDADO (scan 2026-06-01): editar encabezado = WorkOrderDialogQuery (para
  // traer los campos actuales del encabezado) + CreateUpdateWorkOrdersChecked con
  // `id` poblado + `receivedOrderId` nuevo. La respuesta es [] cuando no hay
  // warnings (= OK). Esto mueve la WO a la OV destino; su parte queda en
  // partAccountsNotAssignedToReceivedOrder hasta que se "Asocie" (paso siguiente).
  async function reassignWOHeader(woId, destReceivedOrderId) {
    const domainId = api().getDomain().id || 344;
    const dlg = await api().query('WorkOrderDialogQuery', {
      workOrderId: parseInt(woId, 10),
      receivedOrderId: -1,
      domainId,
    });
    const wo = dlg?.workOrderById;
    if (!wo) throw new Error(`WorkOrderDialogQuery(${woId}) no devolvió workOrderById`);
    const labelIds = (wo.workOrderLabelsByWorkOrderId?.nodes || [])
      .map(n => n?.labelId ?? n?.id).filter(v => v != null);
    const input = [{
      id: parseInt(woId, 10),
      name: wo.name || '',
      customerId: wo.customerByCustomerId?.id ?? null,
      deadline: wo.deadline ?? null,
      productId: wo.productByProductId?.id ?? null,
      startedAt: wo.startedAt ?? null,
      receivedOrderId: parseInt(destReceivedOrderId, 10),
      description: wo.descriptionMarkdown ?? '',
      externalNotes: wo.externalNotes ?? wo.customerFacingNotes ?? '',
      type: wo.type || 'MAKE_TO_ORDER',
      blockPartialShipments: !!wo.blockPartialShipments,
      labelIds,
    }];
    const data = await api().query('CreateUpdateWorkOrdersChecked', { input });
    const checks = data?.createUpdateWorkOrdersChecked;
    if (Array.isArray(checks) && checks.length) {
      warn(`CreateUpdateWorkOrdersChecked devolvió ${checks.length} warning(s) para WO ${woId}`);
    }
    return data;
  }

  // Crea una OV nueva como destino reusando el wizard de OVOperations.
  // Devuelve el id INTERNO de la OV creada, o null si se canceló.
  // NOTA: createNewOV devuelve idInDomain; resolvemos el id interno con loadOVDetails.
  async function createDestinationOV() {
    const ops = ovops();
    if (!ops?.showCreationWizard || !ops?.fetchCreationData || !ops?.createNewOV) {
      alert('No está disponible el módulo de creación de OV (OVOperations).');
      return null;
    }
    const customerId = state.sourceOV.customerId;
    const creationData = await ops.fetchCreationData(customerId);
    const sourceData = { currency: '', customer: state.sourceOV.customerName || '', lines: [], poNumber: '' };
    const formData = await ops.showCreationWizard(sourceData, creationData, customerId);
    if (!formData) return null;   // el usuario canceló el wizard
    const newIdInDomain = await ops.createNewOV(formData, sourceData, null);
    if (!newIdInDomain) throw new Error('createNewOV no devolvió id');
    const detail = await loadOVDetails(newIdInDomain);
    // Registrar en candidatas para reuso en otras filas + refrescar dropdowns.
    state.candidateOVs.unshift({ id: detail.id, idInDomain: detail.idInDomain, name: detail.name, pnSet: new Set() });
    renderTable();
    return detail.id;
  }

  // Ejecuta una fila: (crea OV destino si "__new__") + reasigna el encabezado de
  // la OT. NO asocia la parte ni reconcilia — eso queda manual (decisión del
  // usuario: la UI de Steelhead no permite asociar por API con lo capturado).
  async function executeMoveRow(row) {
    let destInternalId = row.destOvId;
    if (destInternalId === '__new__') {
      destInternalId = await createDestinationOV();
      if (!destInternalId) return { skipped: true };
      row.destOvId = destInternalId;
    }
    await reassignWOHeader(row.ot.id, destInternalId);
    return { ok: true, destInternalId };
  }

  // Itera las filas seleccionadas con destino, secuencialmente, y lleva bitácora.
  async function executeSelectedRows() {
    const rows = state.rows.filter(r => r.selected && r.destOvId && r.destOvId !== '');
    if (!rows.length) return;
    state.busy = true;
    const exec = document.getElementById('sa-wm-exec');
    if (exec) { exec.disabled = true; exec.textContent = 'Ejecutando…'; }
    let okCount = 0, errCount = 0;
    for (const row of rows) {
      row.status = 'running'; renderTable();
      try {
        const res = await executeMoveRow(row);
        if (res.skipped) { row.status = 'pending'; renderTable(); continue; }
        row.status = 'ok'; okCount++;
        state.auditLog.push({ woId: row.ot.id, woName: row.ot.name, pn: row.ot.partNumber,
          sourceOv: state.sourceOV.idInDomain, destOvInternal: res.destInternalId,
          partCount: row.ot.partCount, status: 'ok' });
        log(`OT ${row.ot.name} (${row.ot.partNumber}) → OV interna ${res.destInternalId}: encabezado reasignado`);
      } catch (e) {
        row.status = 'error'; row.error = e.message; errCount++;
        state.auditLog.push({ woId: row.ot.id, pn: row.ot.partNumber, status: 'error', error: e.message });
        warn(`OT ${row.ot.name}: ${e.message}`);
      }
      renderTable();
    }
    state.busy = false;
    const note = document.getElementById('sa-wm-note');
    if (note) note.innerHTML = `✅ ${okCount} OT(s) movida(s)${errCount ? `, ❌ ${errCount} con error` : ''}. ` +
      `<strong>Falta asociar la parte a la línea de la OV destino en Steelhead (manual).</strong>`;
    refreshSelectionUI();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Apertura / cierre + memory hardening
  // ───────────────────────────────────────────────────────────────────────────
  async function openPanel() {
    if (state.isOpen) return;
    const idInDomain = extractIdInDomain();
    if (idInDomain == null) {
      alert('Abre el detalle de una OV (Received Order) antes de usar este applet.');
      return;
    }
    state = freshState();
    state.isOpen = true;
    showShell();

    // EJE B: detener Datadog + mem monitor con guardrail.
    try { host()?.stopDatadogSessionReplay?.(); } catch (_) {}
    if (host()?.createMemMonitor) {
      state.memMonitor = host().createMemMonitor({
        getElement: () => document.getElementById('sa-wm-mem'),
        onGuardrail: () => {
          const note = document.getElementById('sa-wm-note');
          if (note) note.textContent = '⚠️ Memoria alta — cierra y recarga la pestaña.';
        },
      });
      state.memMonitor.start();
    }

    try {
      state.sourceOV = await loadOVDetails(idInDomain);
      setSourceLine();
      const body = document.getElementById('sa-wm-body');
      if (body) body.innerHTML = `<div class="sa-wm-placeholder">Buscando OVs del cliente…</div>`;

      state.candidateOVs = await loadCandidateOVs(
        state.sourceOV.customerId,
        state.sourceOV.idInDomain,
        (done, total) => {
          const b = document.getElementById('sa-wm-body');
          if (b) b.querySelector('.sa-wm-placeholder') &&
            (b.querySelector('.sa-wm-placeholder').textContent = `Cargando PNs de OVs… ${done}/${total}`);
        }
      );
      buildProposals();
      renderTable();
      log(`OV #${state.sourceOV.idInDomain}: ${state.sourceOV.ots.length} OT(s), ${state.candidateOVs.length} OV(s) candidata(s)`);
    } catch (e) {
      const body = document.getElementById('sa-wm-body');
      if (body) body.innerHTML = `<div class="sa-wm-err">Error al cargar: ${esc(e.message)}</div>`;
      warn(`openPanel error: ${e.message}`);
    }
  }

  function closePanel() {
    try { state.memMonitor?.stop?.(); } catch (_) {}
    removeOverlay();
    state = freshState();   // reset total (EJE A)
  }

  // ── Entry point ──
  if (typeof window !== 'undefined') {
    window.WOMover = { VERSION, init, openPanel, closePanel };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return { VERSION, init, openPanel, closePanel };
})();
