// PO Reconciler — Rebalanceo automático entre OVs temp y POs reales (Schneider QRO)
// Depende de: SteelheadAPI, ClaudeAPI, POComparator
// Spec: docs/superpowers/specs/2026-05-12-po-reconciler-design.md

const POReconciler = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api()?.log?.(m) ?? console.log('[PR]', m);
  const warn = (m) => api()?.warn?.(m) ?? console.warn('[PR]', m);

  const URL_RE = /\/Domains\/\d+\/ReceivedOrders(?:\/|$|\?)/i;
  const SAP_PO_RE = /^14\d{8}$/;

  let state = {
    isOpen: false,
    step: 1,
    pdfs: [],           // [{ file, status: 'pending'|'parsing'|'ok'|'error', parsed, error }]
    tempOVs: [],        // [{ id, name, ots, byPN, snapshot }]
    restantesOV: null,  // { id, name, snapshot } or null
    plan: null,         // see engine
    overrides: {},      // user edits
    runId: null,        // for cancel/idempotency
    auditLog: [],
  };

  function init() {
    if (window.__saPoReconcilerInit) return;
    window.__saPoReconcilerInit = true;
    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
    listenManualTrigger();
  }

  function isAllowedPath() {
    return URL_RE.test(location.pathname);
  }

  function syncFabVisibility() {
    // TODO Task 10.1
  }

  function installUrlChangeListener() {
    if (window.__saPoReconcilerUrlListener) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saPoReconcilerUrlListener = true;
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
      if (msg && msg.action === 'run-po-reconciler') openWizard();
    });
  }

  function injectStyles() {
    if (document.getElementById('sa-pr-styles')) return;
    const css = `
      .sa-pr-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.5);
        z-index: 999999; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .sa-pr-modal {
        background: #fff; width: min(95vw, 1200px); height: min(90vh, 800px);
        border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 10px 40px rgba(0,0,0,.3);
      }
      .sa-pr-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 16px 24px; border-bottom: 1px solid #e5e7eb;
      }
      .sa-pr-header h2 { margin: 0; font-size: 18px; }
      .sa-pr-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280; }
      .sa-pr-steps {
        display: flex; gap: 24px; padding: 12px 24px; border-bottom: 1px solid #e5e7eb;
        background: #f9fafb; font-size: 13px;
      }
      .sa-pr-steps span { color: #9ca3af; }
      .sa-pr-steps span.active { color: #1f2937; font-weight: 600; }
      .sa-pr-body { flex: 1; overflow: auto; padding: 24px; }
      .sa-pr-footer {
        display: flex; justify-content: space-between; padding: 16px 24px;
        border-top: 1px solid #e5e7eb;
      }
      .sa-pr-footer button {
        padding: 8px 16px; border: 1px solid #d1d5db; background: #fff;
        border-radius: 6px; cursor: pointer; font-size: 14px;
      }
      .sa-pr-footer button:disabled { opacity: .5; cursor: not-allowed; }
      .sa-pr-footer .sa-pr-next { background: #2563eb; color: #fff; border-color: #2563eb; }
      .sa-pr-footer .sa-pr-next:disabled { background: #93c5fd; border-color: #93c5fd; }
      .sa-pr-placeholder { color: #6b7280; padding: 40px; text-align: center; }
      .sa-pr-drop { border: 2px dashed #93c5fd; border-radius: 8px; padding: 40px; text-align: center; color: #2563eb; cursor: pointer; }
      .sa-pr-drop.hover { background: #eff6ff; }
      .sa-pr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .sa-pr-table th, .sa-pr-table td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; }
      .sa-pr-table th { background: #f9fafb; font-weight: 600; }
      .sa-pr-issue-fatal { color: #dc2626; font-weight: 600; }
      .sa-pr-issue-warn  { color: #d97706; }
      .sa-pr-issue-info  { color: #2563eb; }
      .sa-pr-fab {
        position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px;
        background: #2563eb; color: #fff; border: none; border-radius: 50%;
        font-size: 24px; cursor: pointer; z-index: 999998;
        box-shadow: 0 4px 12px rgba(37,99,235,.4);
      }
      .sa-pr-fab:hover { background: #1d4ed8; }
      .sa-pr-step1 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; height: 100%; }
      .sa-pr-step1 h3 { font-size: 14px; margin: 0 0 12px; }
      .sa-pr-files-list, #sa-pr-temps-list { list-style: none; padding: 0; margin: 12px 0 0; font-size: 13px; }
      .sa-pr-files-list li, #sa-pr-temps-list .item { display: flex; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid #f3f4f6; }
      .sa-pr-rm { background: none; border: none; color: #6b7280; cursor: pointer; }
      .sa-pr-parse-list { list-style: none; padding: 0; }
      .sa-pr-parse-list li { display: grid; grid-template-columns: 1fr 1fr auto; padding: 8px; border-bottom: 1px solid #f3f4f6; align-items: center; gap: 8px; }
      .sa-pr-parse-list .actions { display: flex; gap: 4px; }
      .sa-pr-parse-list button { padding: 4px 8px; font-size: 12px; border-radius: 4px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
      .sa-pr-drawer { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 1000000; display: flex; justify-content: flex-end; }
      .sa-pr-drawer-inner { background: #fff; width: 600px; height: 100%; padding: 20px; overflow: auto; }
      .sa-pr-drawer-inner header { display: flex; justify-content: space-between; align-items: center; }
      .sa-pr-drawer-close { background: none; border: none; font-size: 20px; cursor: pointer; }
      .sa-pr-pills { display: flex; gap: 12px; font-size: 13px; flex-wrap: wrap; }
      .sa-pr-pills span { background: #f3f4f6; padding: 4px 10px; border-radius: 12px; }
      .sa-pr-plan-section { margin-top: 24px; }
      .sa-pr-plan-section h3 { font-size: 14px; margin: 0 0 8px; }
      .sa-pr-btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; margin-top: 16px; }
    `;
    const style = document.createElement('style');
    style.id = 'sa-pr-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── UI Wizard ──────────────────────────────────────────────

  function openWizard() {
    if (state.isOpen) return;
    state.isOpen = true;
    state.step = 1;
    const root = document.createElement('div');
    root.id = 'sa-pr-root';
    root.className = 'sa-pr-overlay';
    root.innerHTML = `
      <div class="sa-pr-modal">
        <header class="sa-pr-header">
          <h2>Reconciliador OV vs PO Schneider QRO</h2>
          <button class="sa-pr-close" aria-label="Cerrar">✕</button>
        </header>
        <nav class="sa-pr-steps">
          <span data-step="1" class="active">1. Cargar</span>
          <span data-step="2">2. Parseo</span>
          <span data-step="3">3. Plan</span>
          <span data-step="4">4. Ejecutar</span>
        </nav>
        <main class="sa-pr-body"></main>
        <footer class="sa-pr-footer">
          <button class="sa-pr-back" disabled>← Atrás</button>
          <button class="sa-pr-next" disabled>Continuar →</button>
        </footer>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('.sa-pr-close').onclick = closeWizard;
    root.querySelector('.sa-pr-back').onclick = () => goToStep(state.step - 1);
    root.querySelector('.sa-pr-next').onclick = () => goToStep(state.step + 1);
    renderStep();
  }

  function closeWizard() {
    document.getElementById('sa-pr-root')?.remove();
    state = { ...state, isOpen: false, step: 1, pdfs: [], plan: null, overrides: {} };
  }

  function goToStep(n) {
    if (n < 1 || n > 4) return;
    state.step = n;
    document.querySelectorAll('#sa-pr-root .sa-pr-steps span').forEach(s => {
      s.classList.toggle('active', Number(s.dataset.step) === n);
    });
    renderStep();
  }

  function renderStep() {
    const body = document.querySelector('#sa-pr-root .sa-pr-body');
    if (!body) return;
    body.innerHTML = '';
    if (state.step === 1) renderStep1(body);
    else if (state.step === 2) renderStep2(body);
    else if (state.step === 3) renderStep3(body);
    else if (state.step === 4) renderStep4(body);
    updateFooter();
  }

  function updateFooter() {
    const back = document.querySelector('#sa-pr-root .sa-pr-back');
    const next = document.querySelector('#sa-pr-root .sa-pr-next');
    if (!back || !next) return;
    back.disabled = state.step === 1;
    next.textContent = state.step === 4 ? 'Cerrar' : 'Continuar →';
    next.disabled = !canAdvanceFromStep(state.step);
  }

  function canAdvanceFromStep(step) {
    if (step === 1) return state.pdfs.length > 0 && state.tempOVs.length > 0;
    if (step === 2) return state.pdfs.every(p => p.status === 'ok' || p.status === 'skipped');
    if (step === 3) return state.plan && !state.plan.issues.some(i => i.severity === 'fatal');
    if (step === 4) return true;
    return false;
  }

  async function renderStep1(body) {
    body.innerHTML = `
      <div class="sa-pr-step1">
        <div class="sa-pr-step1-left">
          <h3>1) PDFs de POs Schneider</h3>
          <div id="sa-pr-drop" class="sa-pr-drop">
            <p>Arrastra archivos .pdf aquí o haz click para elegir</p>
            <input type="file" multiple accept="application/pdf" hidden id="sa-pr-files">
          </div>
          <ul id="sa-pr-files-list" class="sa-pr-files-list"></ul>
        </div>
        <div class="sa-pr-step1-right">
          <h3>2) OVs temp Schneider QRO detectadas</h3>
          <div id="sa-pr-temps-list">Cargando…</div>
        </div>
      </div>
    `;
    const drop = body.querySelector('#sa-pr-drop');
    const input = body.querySelector('#sa-pr-files');
    drop.onclick = () => input.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hover'); };
    drop.ondragleave = () => drop.classList.remove('hover');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('hover');
      addPdfs([...e.dataTransfer.files].filter(f => f.type === 'application/pdf'));
    };
    input.onchange = () => addPdfs([...input.files]);

    refreshFilesList();
    await refreshTempOVs();
  }

  function addPdfs(files) {
    for (const f of files) {
      if (!state.pdfs.some(p => p.file.name === f.name && p.file.size === f.size)) {
        state.pdfs.push({ status: 'pending', file: f, parsed: null, error: null });
      }
    }
    refreshFilesList();
    updateFooter();
  }

  function refreshFilesList() {
    const ul = document.getElementById('sa-pr-files-list');
    if (!ul) return;
    ul.innerHTML = state.pdfs.map((p, i) => `
      <li>
        ${escapeHtml(p.file.name)} (${(p.file.size/1024).toFixed(1)} KB)
        <button data-i="${i}" class="sa-pr-rm">✕</button>
      </li>
    `).join('');
    ul.querySelectorAll('.sa-pr-rm').forEach(btn => btn.onclick = () => {
      state.pdfs.splice(Number(btn.dataset.i), 1);
      refreshFilesList();
      updateFooter();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  async function renderStep2(body) {
    body.innerHTML = `
      <h3>Parseando POs…</h3>
      <ul id="sa-pr-parse-list" class="sa-pr-parse-list"></ul>
    `;
    const ul = body.querySelector('#sa-pr-parse-list');

    const renderList = () => {
      ul.innerHTML = state.pdfs.map((p, i) => {
        const icon = { pending: '⠋', parsing: '⠋', ok: '✓', error: '✗', skipped: '⊘' }[p.status] || '?';
        const cls  = { pending: '', parsing: '', ok: 'sa-pr-issue-info', error: 'sa-pr-issue-fatal', skipped: 'sa-pr-issue-warn' }[p.status] || '';
        const summary = p.parsed
          ? `PO ${escapeHtml(p.parsed.poNumber || '?')} · ${p.parsed.lines?.length || 0} líneas · ${escapeHtml(p.parsed.currency || '?')}`
          : (p.error ? escapeHtml(p.error) : '');
        return `
          <li class="${cls}">
            <span>${icon} ${escapeHtml(p.file.name)}</span>
            <small>${summary}</small>
            <span class="actions">
              ${p.status === 'error' ? `<button data-i="${i}" class="sa-pr-retry">↻</button>` : ''}
              ${p.status === 'error' ? `<button data-i="${i}" class="sa-pr-skip">Omitir</button>` : ''}
              ${p.status === 'ok'    ? `<button data-i="${i}" class="sa-pr-view">Ver</button>` : ''}
            </span>
          </li>
        `;
      }).join('');
      ul.querySelectorAll('.sa-pr-retry').forEach(b => b.onclick = () => retryOne(Number(b.dataset.i), renderList));
      ul.querySelectorAll('.sa-pr-skip').forEach(b => b.onclick = () => { state.pdfs[Number(b.dataset.i)].status = 'skipped'; renderList(); updateFooter(); });
      ul.querySelectorAll('.sa-pr-view').forEach(b => b.onclick = () => showPdfDetail(Number(b.dataset.i)));
    };

    renderList();
    const pending = state.pdfs.map((p, i) => ({ p, i })).filter(x => x.p.status === 'pending');
    for (const { p, i } of pending) {
      p.status = 'parsing';
      renderList();
      const r = await parseSinglePdf(p.file);
      state.pdfs[i] = r;
      renderList();
      updateFooter();
    }
  }

  async function retryOne(i, renderList) {
    state.pdfs[i].status = 'parsing';
    state.pdfs[i].error = null;
    renderList();
    const r = await parseSinglePdf(state.pdfs[i].file);
    state.pdfs[i] = r;
    renderList();
    updateFooter();
  }

  function showPdfDetail(i) {
    const p = state.pdfs[i];
    if (!p?.parsed) return;
    const drawer = document.createElement('div');
    drawer.className = 'sa-pr-drawer';
    drawer.innerHTML = `
      <div class="sa-pr-drawer-inner">
        <header><h4>${escapeHtml(p.file.name)}</h4><button class="sa-pr-drawer-close">✕</button></header>
        <p>PO: <strong>${escapeHtml(p.parsed.poNumber)}</strong> · ${p.parsed.lines.length} líneas · ${escapeHtml(p.parsed.currency || '?')}</p>
        <table class="sa-pr-table">
          <thead><tr><th>#</th><th>PN</th><th>Desc</th><th>Qty</th></tr></thead>
          <tbody>
            ${p.parsed.lines.map(l => `<tr>
              <td>${l.lineNumber}</td>
              <td>${escapeHtml(l.partNumber)}</td>
              <td>${escapeHtml(l.description || '')}</td>
              <td>${l.quantity}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
    document.body.appendChild(drawer);
    drawer.querySelector('.sa-pr-drawer-close').onclick = () => drawer.remove();
  }

  async function renderStep3(body) {
    body.innerHTML = `<div class="sa-pr-placeholder">Calculando plan…</div>`;
    const pos   = state.pdfs.filter(p => p.status === 'ok').map(p => ({
      poNumber: p.parsed.poNumber,
      byPN: consolidateByPN(p.parsed.lines),
      rawLines: p.parsed.lines,
    }));
    const temps = state.tempOVs.map(t => ({ ovId: t.id, name: t.name, byPN: t.byPN, raw: t }));
    state.restantesOV = await findRestantesOV();
    const sch = api().getDomain().schneiderQueretaro || {};
    state.plan = buildPlan({
      pos, temps, restantesOV: state.restantesOV,
      config: { restantesOvName: sch.restantesOvName || 'Restantes Schneider QRO' },
      overrides: state.overrides,
    });
    renderStep3Body(body);
    updateFooter();
  }

  function renderStep3Body(body) {
    const p = state.plan;
    body.innerHTML = `
      <section class="sa-pr-plan-summary">
        <h3>Resumen</h3>
        <div class="sa-pr-pills">
          <span>${p.assignment.length} asignaciones</span>
          <span>${p.moves.length} movimientos</span>
          <span>${p.restantes.length} sobrantes → Restantes</span>
          <span>${p.creates.length} OVs nuevas</span>
          <span class="sa-pr-issue-warn">${p.issues.filter(i => i.severity === 'warn').length} warnings</span>
          <span class="sa-pr-issue-fatal">${p.issues.filter(i => i.severity === 'fatal').length} fatales</span>
        </div>
      </section>
      <section class="sa-pr-plan-section"><h3>Asignación temp ↔ PO</h3><div id="sa-pr-asgn"></div></section>
      <section class="sa-pr-plan-section"><h3>Movimientos</h3><div id="sa-pr-moves"></div></section>
      <section class="sa-pr-plan-section"><h3>Sobrantes → OV Restantes</h3><div id="sa-pr-rest"></div></section>
      <section class="sa-pr-plan-section"><h3>Issues</h3><div id="sa-pr-issues"></div></section>
      <button id="sa-pr-recompute" class="sa-pr-btn">↻ Recalcular plan</button>
    `;
    renderAssignment();
    renderMoves();
    renderRestantes();
    renderIssues();
    document.getElementById('sa-pr-recompute').onclick = async () => {
      await renderStep3(body);
    };
  }

  function renderAssignment() {
    const el = document.getElementById('sa-pr-asgn');
    const poNumbers = [...new Set(state.pdfs.filter(p => p.status === 'ok').map(p => p.parsed.poNumber))];
    el.innerHTML = `
      <table class="sa-pr-table">
        <thead><tr><th>Temp OV</th><th>PO asignado</th></tr></thead>
        <tbody>
          ${state.plan.assignment.map(a => {
            const t = state.tempOVs.find(x => x.id === a.tempOvId);
            return `
              <tr>
                <td>${escapeHtml(t?.name || a.tempOvId)}</td>
                <td>
                  <select data-temp="${a.tempOvId}">
                    ${poNumbers.map(pn => `<option value="${escapeHtml(pn)}" ${pn === a.poNumber ? 'selected' : ''}>${escapeHtml(pn)}</option>`).join('')}
                  </select>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    el.querySelectorAll('select').forEach(sel => {
      sel.onchange = () => {
        const tempId = sel.dataset.temp;
        const newPo = sel.value;
        const oldAssgn = state.overrides.assignment || state.plan.assignment.map(a => ({ ...a }));
        const swap = oldAssgn.find(a => a.poNumber === newPo && a.tempOvId !== tempId);
        const me   = oldAssgn.find(a => a.tempOvId === tempId);
        if (!me) return;
        if (swap) swap.poNumber = me.poNumber;
        me.poNumber = newPo;
        state.overrides.assignment = oldAssgn;
        document.getElementById('sa-pr-recompute').click();
      };
    });
  }

  // Stubs — implementadas en Task 8.3
  function renderMoves()      { document.getElementById('sa-pr-moves').innerHTML = '<em>TODO</em>'; }
  function renderRestantes()  { document.getElementById('sa-pr-rest').innerHTML  = '<em>TODO</em>'; }
  function renderIssues()     { document.getElementById('sa-pr-issues').innerHTML = '<em>TODO</em>'; }

  // Stub — implementada en Phase 9
  function renderStep4(body) { body.innerHTML = '<div class="sa-pr-placeholder">Paso 4 (Phase 9 — pendiente)</div>'; }

  async function refreshTempOVs() {
    const el = document.getElementById('sa-pr-temps-list');
    if (!el) return;
    el.innerHTML = '<em>Cargando…</em>';
    try {
      const candidates = await loadCandidateTempOVs();
      const details = await Promise.all(candidates.map(c => loadOVDetails(c.id).catch(e => ({ error: e.message, id: c.id, name: c.name }))));
      state.tempOVs = details.filter(d => !d.error);
      const errors = details.filter(d => d.error);
      el.innerHTML = `
        ${state.tempOVs.map(t => `
          <div class="item">
            <span>${escapeHtml(t.name)}</span>
            <small>${t.ots.length} OTs · ${Object.keys(t.byPN).length} PNs</small>
          </div>
        `).join('')}
        ${errors.length ? `<div class="sa-pr-issue-warn">⚠️ ${errors.length} OVs fallaron al cargar (ver consola)</div>` : ''}
      `;
      if (errors.length) console.warn('[PR] errores cargando OVs:', errors);
      updateFooter();
    } catch (err) {
      el.innerHTML = `<div class="sa-pr-issue-fatal">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ── Steelhead helpers ──────────────────────────────────────

  async function loadCandidateTempOVs() {
    const domain = api().getDomain();
    const schneider = domain.schneiderQueretaro || {};
    if (!schneider.customerId || !schneider.shipToAddressId) {
      throw new Error('Falta config Schneider QRO (customerId / shipToAddressId)');
    }
    const sapRe = new RegExp(schneider.poNumberRegex || '^14\\d{8}$');
    const variables = {
      filters: { customerId: schneider.customerId, archivedAt: null },
      first: 100,
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const all = data?.activeReceivedOrders?.nodes || data?.receivedOrders?.nodes || [];
    const candidates = all.filter(ov => {
      if (ov.archivedAt) return false;
      const ship = (ov.shipToAddress?.id ?? ov.shipToAddressId);
      if (String(ship) !== String(schneider.shipToAddressId)) return false;
      const name = String(ov.name || '').trim();
      if (sapRe.test(name)) return false;
      return true;
    });
    log(`Temp OVs candidatas: ${candidates.length}`);
    return candidates.map(ov => ({ id: ov.id, idInDomain: ov.idInDomain, name: ov.name, raw: ov }));
  }

  async function loadOVDetails(ovId) {
    const data = await api().query('GetReceivedOrder', { id: ovId });
    const ov = data?.receivedOrder || data?.receivedOrderByIdInDomain;
    if (!ov) throw new Error(`GetReceivedOrder(${ovId}) devolvió shape inesperado`);

    // Líneas y OTs
    const lines = ov.receivedOrderLines?.nodes
                || ov.receivedOrderLinesByReceivedOrderId?.nodes
                || [];

    const ots = [];
    const byPN = {};
    for (const line of lines) {
      for (const li of (line.lineItems?.nodes || line.lineItems || [])) {
        for (const ptAssoc of (li.receivedOrderLineItemPartTransforms?.nodes
                            || li.receivedOrderLineItemPartTransforms
                            || [])) {
          const pt = ptAssoc.receivedOrderPartTransform;
          if (!pt) continue;
          for (const wo of (pt.workOrders?.nodes || pt.workOrders || [])) {
            const pnId = pt.partNumberId;
            const pnString = pt.partNumber?.partNumberString || pt.partNumber?.string || '';
            const qty = Number(wo.partCount || wo.count || 0);
            ots.push({
              id: wo.id,
              partCount: qty,
              partNumberId: pnId,
              partNumber: pnString,
              receivedOrderPartTransformId: pt.id,
              recipeNodeId: wo.recipeNodeId ?? null,
              locationId: wo.locationId ?? null,
              accountId: wo.inventoryAccountId ?? wo.accountId ?? null,
              line: { id: line.id, name: line.name, quantity: Number(li.quantity || 0) },
              raw: wo,
            });
            byPN[pnString] = (byPN[pnString] || 0) + qty;
          }
        }
      }
    }

    return {
      id: ov.id,
      idInDomain: ov.idInDomain,
      name: ov.name,
      customerId: ov.customerId,
      shipToAddressId: ov.shipToAddressId,
      lines,
      ots,
      byPN,
      snapshot: ov, // full record for rename replay
    };
  }

  async function findRestantesOV() {
    const domain = api().getDomain();
    const sch = domain.schneiderQueretaro || {};
    const expectedName = sch.restantesOvName || 'Restantes Schneider QRO';
    const variables = {
      filters: { customerId: sch.customerId, archivedAt: null, searchString: expectedName },
      first: 20,
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const all = data?.activeReceivedOrders?.nodes || data?.receivedOrders?.nodes || [];
    return all.find(ov => String(ov.name).trim() === expectedName) || null;
  }

  async function createRestantesOV(seed) {
    const domain = api().getDomain();
    const expectedName = domain.schneiderQueretaro?.restantesOvName || 'Restantes Schneider QRO';
    const input = {
      name: expectedName,
      customerId: seed.customerId,
      shipToAddressId: seed.shipToAddressId,
      customerContactId: seed.customerContactId ?? null,
      billToAddressId: seed.billToAddressId ?? null,
      invoiceTermsId: seed.invoiceTermsId ?? null,
      customInputs: seed.customInputs ?? [],
      inputSchemaId: seed.inputSchemaId ?? null,
      shipVia: seed.shipVia ?? null,
      shipMethodId: seed.shipMethodId ?? null,
      type: seed.type ?? 'STANDARD',
      blockPartialShipments: seed.blockPartialShipments ?? false,
      sectorId: seed.sectorId ?? null,
      isBlanketOrder: false,
      deadline: seed.deadline ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const data = await api().query('CreateReceivedOrder', { input });
    const created = data?.createReceivedOrder?.receivedOrder || data?.createReceivedOrder;
    if (!created?.id) throw new Error('CreateReceivedOrder: respuesta sin id');
    log(`OV Restantes creada: ${created.id} (#${created.idInDomain})`);
    return created;
  }

  function findOTForPN(ov, pnId) {
    return ov.ots.find(ot => String(ot.partNumberId) === String(pnId)) || null;
  }

  async function createOTInOV({ ovId, customerId, deadline, partNumberId, hintFromOt }) {
    const variables = {
      input: [{
        id: null,
        name: '',
        customerId,
        deadline,
        productId: hintFromOt?.raw?.productId ?? null,
        startedAt: new Date().toISOString(),
        receivedOrderId: ovId,
        description: '',
        customerFacingNotes: '',
        type: 'MAKE_TO_ORDER',
        blockPartialShipments: false,
        labelIds: [],
        partNumberId,
        recipeNodeId: hintFromOt?.recipeNodeId ?? null,
      }],
    };
    const data = await api().query('CreateUpdateWorkOrdersChecked', variables);
    const wo = data?.createUpdateWorkOrdersChecked?.workOrders?.[0]
            || data?.workOrder
            || data?.workOrders?.[0];
    if (!wo?.id) throw new Error('CreateUpdateWorkOrdersChecked: no devolvió OT');
    return wo;
  }

  async function executeMove({
    qty,
    fromOt,
    toOt,
    partNumberId,
    toOvId,
    transformCount,
    transformDeadline,
    transformPriceId,
    lineItemAssocs,
  }) {
    if (!fromOt?.accountId) throw new Error('executeMove: falta fromOt.accountId');
    if (!toOt?.id || !toOt?.recipeNodeId) throw new Error('executeMove: falta toOt.id / recipeNodeId');
    if (!toOt?.receivedOrderPartTransformId) throw new Error('executeMove: falta toOt.receivedOrderPartTransformId');
    const variables = {
      input: {
        receivedOrderPartTransforms: [{
          id: toOt.receivedOrderPartTransformId,
          receivedOrderId: toOvId,
          description: null,
          count: transformCount ?? toOt.partCount ?? qty,
          deadline: transformDeadline ?? null,
          partNumberId,
          partNumberPriceId: transformPriceId ?? null,
          partsTransferEvents: [{
            createPartsTransferEvent: {},
            partsTransfers: [{
              fromAccountId: fromOt.accountId,
              toAccount: {
                recipeNodeId: toOt.recipeNodeId,
                workOrderId: toOt.id,
                stationId: null,
                locationId: toOt.locationId ?? null,
                partNumberId,
                receivedOrderPartTransformId: toOt.receivedOrderPartTransformId,
                materialConversionId: null,
              },
              partCount: qty,
              type: 'TRANSFER',
              comment: null,
            }],
          }],
          inventoryTransferEvents: [],
          receivedOrderLineItemPartTransforms: lineItemAssocs ?? [],
        }],
        partsTransferEventsPayload: [{
          createPartsTransferEvent: {},
          partsTransfers: [],
        }],
        billedLaborTimeSegments: {},
      },
    };
    return await api().query('AddPartsToWorkOrders', variables);
  }

  async function reconcileLineQuantities(ovId) {
    const fresh = await loadOVDetails(ovId);
    const newLines = [];

    for (const line of fresh.lines) {
      const lineItemsRaw = line.lineItems?.nodes || line.lineItems || [];
      const li = lineItemsRaw[0];
      if (!li) continue;

      // Suma de partCount de todas las OTs asociadas a esta línea
      let sumOts = 0;
      const assocs = li.receivedOrderLineItemPartTransforms?.nodes
                  || li.receivedOrderLineItemPartTransforms
                  || [];
      for (const ptAssoc of assocs) {
        const pt = ptAssoc.receivedOrderPartTransform;
        for (const wo of (pt?.workOrders?.nodes || pt?.workOrders || [])) {
          sumOts += Number(wo.partCount || wo.count || 0);
        }
      }
      const currentLineQty = Number(li.quantity || 0);
      if (currentLineQty === sumOts) continue;

      newLines.push({
        id: line.id,
        name: line.name,
        description: line.description ?? null,
        lineItems: [{
          id: li.id,
          archive: !!li.archive,
          description: li.description ?? '',
          quantity: String(sumOts),
          price: String(li.price ?? '0'),
          productId: li.productId ?? null,
          unitId: li.unitId ?? null,
          quoteLineItemId: li.quoteLineItemId ?? null,
          receivedOrderLineItemPartTransforms: assocs.map(a => ({
            id: a.id,
            receivedOrderPartTransform: {
              id: a.receivedOrderPartTransform?.id,
              partNumberId: a.receivedOrderPartTransform?.partNumberId,
              partNumberPriceId: a.receivedOrderPartTransform?.partNumberPriceId ?? null,
              count: a.receivedOrderPartTransform?.count ?? 0,
              description: a.receivedOrderPartTransform?.description ?? '',
            },
          })),
        }],
      });
    }

    if (newLines.length === 0) {
      log(`Reconcile ${ovId}: sin cambios`);
      return { changed: 0 };
    }

    const variables = { input: { receivedOrderId: ovId, newLines } };
    await api().query('SaveReceivedOrderLinesAndItems', variables);
    log(`Reconcile ${ovId}: ${newLines.length} líneas ajustadas`);
    return { changed: newLines.length };
  }

  function mapToUpdateShape(ov) {
    return {
      id: ov.id,
      name: ov.name,
      customerId: ov.customerId,
      deadline: ov.deadline,
      customerContactId: ov.customerContactId ?? null,
      billToAddressId: ov.billToAddressId ?? null,
      shipToAddressId: ov.shipToAddressId,
      invoiceTermsId: ov.invoiceTermsId ?? null,
      customInputs: ov.customInputs ?? null,
      inputSchemaId: ov.inputSchemaId ?? null,
      shipVia: ov.shipVia ?? null,
      shipMethodId: ov.shipMethodId ?? null,
      type: ov.type,
      blockPartialShipments: ov.blockPartialShipments ?? false,
      sectorId: ov.sectorId ?? null,
      isBlanketOrder: ov.isBlanketOrder ?? false,
      productionStartDate: ov.productionStartDate ?? null,
      contractualDeadline: ov.contractualDeadline ?? null,
      defaultSignOffRecipeId: ov.defaultSignOffRecipeId ?? null,
    };
  }

  async function renameOV(snapshot, toName) {
    const variables = { ...mapToUpdateShape(snapshot), name: toName };
    const data = await api().query('UpdateReceivedOrder', variables);
    return data?.updateReceivedOrder?.receivedOrder || data?.updateReceivedOrder || data;
  }

  // ── Engine (pure functions) ────────────────────────────────

  function consolidateByPN(lines) {
    const out = {};
    for (const line of (lines || [])) {
      const pn = line && line.partNumber;
      if (!pn) continue;
      const qty = Number(line.quantity) || 0;
      out[pn] = (out[pn] || 0) + qty;
    }
    return out;
  }

  function hungarianMatch(costMatrix) {
    const n = costMatrix.length;
    if (n === 0) return { assignment: [], totalCost: 0 };
    if (!costMatrix.every(row => Array.isArray(row) && row.length === n)) {
      throw new Error('hungarianMatch: matriz debe ser cuadrada');
    }
    let best = { assignment: null, totalCost: Infinity };
    const perm = Array.from({ length: n }, (_, i) => i);
    function* permutations(arr, k = 0) {
      if (k === arr.length - 1) { yield arr.slice(); return; }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        yield* permutations(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    }
    for (const p of permutations(perm)) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += costMatrix[i][p[i]];
      if (cost < best.totalCost) best = { assignment: p.slice(), totalCost: cost };
    }
    return best;
  }

  function assignTempsToPOs(temps, pos) {
    const n = temps.length;
    const m = pos.length;
    if (n !== m) {
      return {
        assignment: null,
        totalDelta: null,
        issues: [{
          severity: 'fatal',
          type: 'cardinality_mismatch',
          detail: `#temps=${n} ≠ #POs=${m}. Plan automático no generado.`,
        }],
      };
    }
    if (n === 0) return { assignment: [], totalDelta: 0, issues: [] };

    const allPNs = new Set();
    temps.forEach(t => Object.keys(t.byPN || {}).forEach(pn => allPNs.add(pn)));
    pos.forEach(p => Object.keys(p.byPN || {}).forEach(pn => allPNs.add(pn)));

    const matrix = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        let cost = 0;
        for (const pn of allPNs) {
          const tempQty = (temps[i].byPN || {})[pn] || 0;
          const poQty   = (pos[j].byPN   || {})[pn] || 0;
          cost += Math.abs(tempQty - poQty);
        }
        row.push(cost);
      }
      matrix.push(row);
    }
    const { assignment, totalCost } = hungarianMatch(matrix);
    return {
      assignment: assignment.map((j, i) => ({
        tempOvId: temps[i].ovId,
        poNumber: pos[j].poNumber,
      })),
      totalDelta: totalCost,
      issues: [],
    };
  }

  function computeMovesForPN(pn, currentByOV, targetByOV) {
    const delta = {}; // positive = donor, negative = deficit
    for (const ov of new Set([...Object.keys(currentByOV), ...Object.keys(targetByOV)])) {
      delta[ov] = (currentByOV[ov] || 0) - (targetByOV[ov] || 0);
    }
    const donors  = Object.entries(delta).filter(([, d]) => d > 0).map(([ov, d]) => ({ ov, qty: d }));
    const deficit = Object.entries(delta).filter(([, d]) => d < 0).map(([ov, d]) => ({ ov, qty: -d }));
    donors.sort((a, b) => b.qty - a.qty);
    deficit.sort((a, b) => b.qty - a.qty);

    const moves = [];
    let di = 0, ri = 0;
    while (di < donors.length && ri < deficit.length) {
      const move = Math.min(donors[di].qty, deficit[ri].qty);
      moves.push({ pn, qty: move, fromOvId: donors[di].ov, toOvId: deficit[ri].ov });
      donors[di].qty -= move;
      deficit[ri].qty -= move;
      if (donors[di].qty === 0) di++;
      if (deficit[ri].qty === 0) ri++;
    }
    return moves;
  }

  function detectIssuesForPN(pn, tempsTotal, posTotal) {
    if (tempsTotal === posTotal) return [];
    if (tempsTotal > 0 && posTotal === 0) {
      return [{
        severity: 'warn', type: 'pn_solo_en_hs', pn,
        detail: `PN ${pn} aparece en HS (${tempsTotal} piezas) pero no en ningún PO. Se moverá completo a OV Restantes.`,
        sobrante: tempsTotal,
      }];
    }
    if (tempsTotal === 0 && posTotal > 0) {
      return [{
        severity: 'warn', type: 'pn_solo_en_po', pn,
        detail: `PN ${pn} aparece en PO (${posTotal} piezas) pero no en HS. No se puede surtir; línea excluida.`,
        faltante: posTotal,
      }];
    }
    if (tempsTotal > posTotal) {
      return [{
        severity: 'info', type: 'sobrante', pn,
        detail: `HS tiene ${tempsTotal} piezas, Σ POs pide ${posTotal}. Excedente ${tempsTotal - posTotal} → OV Restantes.`,
        sobrante: tempsTotal - posTotal,
      }];
    }
    return [{
      severity: 'warn', type: 'faltante', pn,
      detail: `HS tiene ${tempsTotal} piezas, Σ POs pide ${posTotal}. Faltante ${posTotal - tempsTotal}; línea excluida del plan.`,
      faltante: posTotal - tempsTotal,
    }];
  }

  function buildPlan({ pos, temps, restantesOV, config, overrides = {} }) {
    const issues = [];

    // Asignación
    let assignmentResult;
    if (overrides.assignment) {
      assignmentResult = { assignment: overrides.assignment, totalDelta: null, issues: [] };
    } else {
      assignmentResult = assignTempsToPOs(temps, pos);
    }
    if (!assignmentResult.assignment) {
      return { assignment: [], moves: [], restantes: [], renames: [], creates: [], issues: assignmentResult.issues };
    }
    const assignment = assignmentResult.assignment;

    // Construir target por OV: por cada PN, suma de qty del PO asignado a esa temp
    const targetByOV = {}; // { ovId: { pn: qty } }
    for (const { tempOvId, poNumber } of assignment) {
      targetByOV[tempOvId] = {};
      const po = pos.find(p => p.poNumber === poNumber);
      if (!po) continue;
      for (const [pn, qty] of Object.entries(po.byPN || {})) {
        targetByOV[tempOvId][pn] = qty;
      }
    }
    const currentByOV = {}; // { ovId: { pn: qty } }
    for (const t of temps) currentByOV[t.ovId] = { ...(t.byPN || {}) };

    // PNs a procesar
    const allPNs = new Set();
    temps.forEach(t => Object.keys(t.byPN || {}).forEach(pn => allPNs.add(pn)));
    pos.forEach(p => Object.keys(p.byPN || {}).forEach(pn => allPNs.add(pn)));

    const moves = [];
    const restantes = [];
    for (const pn of allPNs) {
      const tempsTotal = temps.reduce((s, t) => s + (t.byPN?.[pn] || 0), 0);
      const posTotal   = pos.reduce((s, p) => s + (p.byPN?.[pn] || 0), 0);

      const pnIssues = detectIssuesForPN(pn, tempsTotal, posTotal);
      issues.push(...pnIssues);

      // Si el PN tiene faltante o solo está en PO → no se puede surtir, skip moves
      if (pnIssues.some(i => i.type === 'faltante' || i.type === 'pn_solo_en_po')) continue;

      // Target por OV para este PN
      const tgtByOV = {};
      for (const ovId of Object.keys(currentByOV)) tgtByOV[ovId] = targetByOV[ovId]?.[pn] || 0;

      // Generar moves intra-temp
      const cur = {};
      for (const ovId of Object.keys(currentByOV)) cur[ovId] = currentByOV[ovId][pn] || 0;
      const pnMoves = computeMovesForPN(pn, cur, tgtByOV);

      // Sobrante: si suma de targets < suma de currents → diferencia va a Restantes
      const sumCur = Object.values(cur).reduce((a, b) => a + b, 0);
      const sumTgt = Object.values(tgtByOV).reduce((a, b) => a + b, 0);
      if (sumCur > sumTgt) {
        // Crear restante: tomar del primer donor disponible después de aplicar pnMoves
        // Simplificación: el donor del move-a-restantes es el OV que aún quede con sobrante
        const totalSobrante = sumCur - sumTgt;
        // Encontrar de qué OV viene: el que tenga más currentByOV[pn] - tgtByOV[ov][pn]
        let leftover = totalSobrante;
        for (const ovId of Object.keys(cur)) {
          const ovSobrante = cur[ovId] - tgtByOV[ovId];
          if (ovSobrante > 0) {
            const take = Math.min(ovSobrante, leftover);
            restantes.push({ pn, qty: take, fromOvId: ovId });
            leftover -= take;
            if (leftover === 0) break;
          }
        }
      }

      moves.push(...pnMoves);
    }

    // OV Restantes: si hay sobrantes y no existe la OV, crearla
    const creates = [];
    let restantesOvId = restantesOV?.id ?? null;
    if (restantes.length > 0 && !restantesOvId) {
      creates.push({
        type: 'restantes-ov',
        name: config.restantesOvName,
        metadata: { fromTempOvId: temps[0]?.ovId ?? null },
      });
      restantesOvId = '__pending_restantes__';
    }
    for (const r of restantes) r.toOvId = restantesOvId;

    // Renames
    const renames = assignment.map(({ tempOvId, poNumber }) => {
      const t = temps.find(x => x.ovId === tempOvId);
      return { ovId: tempOvId, fromName: t?.name ?? '', toName: poNumber };
    });

    return { assignment, moves, restantes, renames, creates, issues };
  }

  // ── PDF parsing ────────────────────────────────────────────

  async function parseSinglePdf(file) {
    try {
      const parsed = await window.POComparator.parsePDF(file);
      return { status: 'ok', file, parsed, error: null };
    } catch (err) {
      return { status: 'error', file, parsed: null, error: err.message || String(err) };
    }
  }

  async function parseMultiplePdfs(files, onProgress) {
    const results = files.map(f => ({ status: 'pending', file: f, parsed: null, error: null }));
    onProgress?.(results);
    const promises = files.map((file, idx) =>
      parseSinglePdf(file).then(r => {
        results[idx] = r;
        onProgress?.(results);
        return r;
      })
    );
    await Promise.all(promises);
    return results;
  }

  // ── Public API (also for tests) ─────────────────────────────
  return {
    init,
    openWizard,
    // Internals exposed for test harness (Task 1.3+):
    _engine: {
      consolidateByPN,
      hungarianMatch,
      assignTempsToPOs,
      computeMovesForPN,
      detectIssuesForPN,
      buildPlan,
    },
    _helpers: { loadCandidateTempOVs, loadOVDetails, findRestantesOV, createRestantesOV, findOTForPN, createOTInOV, executeMove, reconcileLineQuantities, mapToUpdateShape, renameOV, parseSinglePdf, parseMultiplePdfs },
  };
})();

if (typeof window !== 'undefined') {
  window.POReconciler = POReconciler;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', POReconciler.init);
  } else {
    POReconciler.init();
  }
}

if (typeof module !== 'undefined') module.exports = POReconciler;
