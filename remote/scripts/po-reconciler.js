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
    const should = isAllowedPath();
    const existing = document.getElementById('sa-pr-fab');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) existing.remove();
  }

  function renderFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'sa-pr-fab';
    btn.className = 'sa-pr-fab';
    btn.title = 'Reconciliar OV vs PO Schneider';
    btn.textContent = '🧮';
    btn.onclick = openWizard;
    document.body.appendChild(btn);
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
      .sa-pr-issues { list-style: none; padding: 0; font-size: 13px; }
      .sa-pr-issues li { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; }
      .sa-pr-exec-controls { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
      .sa-pr-btn-primary { padding: 8px 16px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
      .sa-pr-btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
      .sa-pr-exec-list { list-style: none; padding: 0; font-size: 13px; max-height: 400px; overflow: auto; }
      .sa-pr-exec-list li { padding: 6px 12px; border-bottom: 1px solid #f3f4f6; }
      .sa-pr-exec-list li small { color: #6b7280; margin-left: 8px; }
      #sa-pr-progress { margin-left: auto; color: #6b7280; font-size: 13px; }

      @media (prefers-color-scheme: dark) {
        .sa-pr-modal { background: #1f2937; color: #e5e7eb; }
        .sa-pr-header { border-bottom-color: #374151; }
        .sa-pr-close { color: #9ca3af; }
        .sa-pr-close:hover { color: #e5e7eb; }
        .sa-pr-steps { background: #111827; border-bottom-color: #374151; }
        .sa-pr-steps span { color: #6b7280; }
        .sa-pr-steps span.active { color: #f3f4f6; }
        .sa-pr-footer { border-top-color: #374151; }
        .sa-pr-footer button { background: #374151; border-color: #4b5563; color: #e5e7eb; }
        .sa-pr-footer button:hover:not(:disabled) { background: #4b5563; }
        .sa-pr-footer .sa-pr-next { background: #2563eb; color: #fff; border-color: #2563eb; }
        .sa-pr-footer .sa-pr-next:disabled { background: #1e40af; border-color: #1e40af; color: #93c5fd; }
        .sa-pr-placeholder { color: #9ca3af; }
        .sa-pr-drop { border-color: #3b82f6; color: #93c5fd; background: #0f172a; }
        .sa-pr-drop.hover { background: #1e3a8a; }
        .sa-pr-table th { background: #111827; color: #e5e7eb; }
        .sa-pr-table th, .sa-pr-table td { border-bottom-color: #374151; }
        .sa-pr-table td { color: #d1d5db; }
        .sa-pr-table select, .sa-pr-table input { background: #111827; color: #e5e7eb; border: 1px solid #4b5563; border-radius: 4px; padding: 2px 6px; }
        .sa-pr-issue-fatal { color: #f87171; }
        .sa-pr-issue-warn  { color: #fbbf24; }
        .sa-pr-issue-info  { color: #60a5fa; }
        .sa-pr-files-list li, #sa-pr-temps-list .item { border-bottom-color: #374151; }
        .sa-pr-rm { color: #9ca3af; }
        .sa-pr-rm:hover { color: #f87171; }
        .sa-pr-parse-list li { border-bottom-color: #374151; }
        .sa-pr-parse-list button { background: #374151; border-color: #4b5563; color: #e5e7eb; }
        .sa-pr-parse-list button:hover { background: #4b5563; }
        .sa-pr-drawer-inner { background: #1f2937; color: #e5e7eb; }
        .sa-pr-drawer-close { color: #9ca3af; }
        .sa-pr-drawer-close:hover { color: #e5e7eb; }
        .sa-pr-pills span { background: #374151; color: #e5e7eb; }
        .sa-pr-btn { background: #374151; border-color: #4b5563; color: #e5e7eb; }
        .sa-pr-btn:hover { background: #4b5563; }
        .sa-pr-issues li { border-bottom-color: #374151; }
        .sa-pr-exec-list li { border-bottom-color: #374151; }
        .sa-pr-exec-list li small { color: #9ca3af; }
        #sa-pr-progress { color: #9ca3af; }
      }
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
    state = { ...state, isOpen: false, step: 1, pdfs: [], plan: null, overrides: {}, runId: null, runStale: false, auditLog: [] };
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
              <td>${escapeHtml(l.lineNumber)}</td>
              <td>${escapeHtml(l.partNumber)}</td>
              <td>${escapeHtml(l.description || '')}</td>
              <td>${escapeHtml(l.quantity)}</td>
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
                  <select data-temp="${escapeHtml(a.tempOvId)}">
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

  function renderMoves() {
    const el = document.getElementById('sa-pr-moves');
    const moves = state.plan.moves;
    if (moves.length === 0) { el.innerHTML = '<em>Sin movimientos necesarios</em>'; return; }
    const nameOf = (ovId) => state.tempOVs.find(t => t.id === ovId)?.name || ovId;
    el.innerHTML = `
      <table class="sa-pr-table">
        <thead><tr><th>PN</th><th>Qty</th><th>De</th><th>A</th></tr></thead>
        <tbody>
          ${moves.map(m => `<tr>
            <td>${escapeHtml(m.pn)}</td>
            <td>${m.qty}</td>
            <td>${escapeHtml(nameOf(m.fromOvId))}</td>
            <td>${escapeHtml(nameOf(m.toOvId))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  function renderRestantes() {
    const el = document.getElementById('sa-pr-rest');
    const rest = state.plan.restantes;
    if (rest.length === 0) { el.innerHTML = '<em>Sin sobrantes</em>'; return; }
    const nameOf = (ovId) => state.tempOVs.find(t => t.id === ovId)?.name || ovId;
    const restName = state.restantesOV?.name || (api().getDomain().schneiderQueretaro?.restantesOvName || 'Restantes Schneider QRO');
    const willCreate = state.plan.creates.some(c => c.type === 'restantes-ov');
    el.innerHTML = `
      <p>${willCreate ? `<span class="sa-pr-issue-info">↻ Se creará OV "${escapeHtml(restName)}"</span>` : `<span>OV destino: <strong>${escapeHtml(restName)}</strong></span>`}</p>
      <table class="sa-pr-table">
        <thead><tr><th>PN</th><th>Qty</th><th>De</th></tr></thead>
        <tbody>
          ${rest.map(r => `<tr>
            <td>${escapeHtml(r.pn)}</td>
            <td>${r.qty}</td>
            <td>${escapeHtml(nameOf(r.fromOvId))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  function renderIssues() {
    const el = document.getElementById('sa-pr-issues');
    const issues = state.plan.issues;
    if (issues.length === 0) { el.innerHTML = '<em>Sin issues</em>'; return; }
    el.innerHTML = `
      <ul class="sa-pr-issues">
        ${issues.map(i => `<li class="sa-pr-issue-${i.severity}">[${i.severity.toUpperCase()}] ${escapeHtml(i.detail)}</li>`).join('')}
      </ul>
    `;
  }

  function renderStep4(body) {
    body.innerHTML = `
      <div class="sa-pr-exec">
        <div class="sa-pr-exec-controls">
          <button id="sa-pr-run" class="sa-pr-btn-primary">▶ Ejecutar plan</button>
          <button id="sa-pr-cancel" class="sa-pr-btn" disabled>⏸ Cancelar</button>
          <button id="sa-pr-download" class="sa-pr-btn" disabled>⬇ Descargar bitácora (CSV)</button>
          <div id="sa-pr-progress"></div>
        </div>
        <ul id="sa-pr-exec-list" class="sa-pr-exec-list"></ul>
      </div>
    `;
    body.querySelector('#sa-pr-run').onclick = () => runExecutor();
    body.querySelector('#sa-pr-cancel').onclick = () => { state.runStale = true; };
    body.querySelector('#sa-pr-download').onclick = () => downloadAuditCsv();
  }

  function renderExecStep(step) {
    const ul = document.getElementById('sa-pr-exec-list');
    if (!ul) return;
    const icon = { pending: '⋯', running: '⠋', done: '✓', failed: '✗', skipped: '⊘' }[step.status];
    const cls  = { pending: '', running: '', done: 'sa-pr-issue-info', failed: 'sa-pr-issue-fatal', skipped: 'sa-pr-issue-warn' }[step.status];
    let li = ul.querySelector(`[data-step-id="${step.id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.stepId = step.id;
      ul.appendChild(li);
    }
    li.className = cls;
    li.innerHTML = `${icon} <strong>${escapeHtml(step.label)}</strong> ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}`;
  }

  async function runExecutor() {
    const runId = `run-${Date.now()}`;
    state.runId = runId;
    state.runStale = false;
    state.auditLog = [];
    document.getElementById('sa-pr-run').disabled = true;
    document.getElementById('sa-pr-cancel').disabled = false;

    const steps = buildExecutionSteps(state.plan);
    const progress = document.getElementById('sa-pr-progress');
    let done = 0;
    const total = steps.length;
    steps.forEach(s => renderExecStep(s));

    for (const step of steps) {
      if (state.runStale) { step.status = 'skipped'; renderExecStep(step); audit(step, 'cancelled'); continue; }
      step.status = 'running';
      renderExecStep(step);
      try {
        await runStepWithRetry(step);
        step.status = 'done';
        audit(step, 'ok');
      } catch (err) {
        step.status = 'failed';
        step.detail = err.message;
        audit(step, 'failed', err.message);
      }
      renderExecStep(step);
      done++;
      progress.textContent = `${done}/${total}`;
    }
    document.getElementById('sa-pr-cancel').disabled = true;
    document.getElementById('sa-pr-download').disabled = false;

    downloadAuditCsv();
  }

  function buildExecutionSteps(plan) {
    const steps = [];
    for (const c of plan.creates) {
      steps.push({ id: `create-${c.name}`, type: 'create_restantes_ov', label: `Crear OV "${c.name}"`, payload: c, status: 'pending' });
    }
    plan.moves.forEach((m, i) => steps.push({
      id: `move-${i}`, type: 'move', label: `Mover ${m.qty}× ${m.pn}`,
      detail: `${state.tempOVs.find(t=>t.id===m.fromOvId)?.name} → ${state.tempOVs.find(t=>t.id===m.toOvId)?.name}`,
      payload: m, status: 'pending',
    }));
    plan.restantes.forEach((r, i) => steps.push({
      id: `rest-${i}`, type: 'move_to_restantes', label: `Mover ${r.qty}× ${r.pn} → Restantes`,
      detail: state.tempOVs.find(t=>t.id===r.fromOvId)?.name, payload: r, status: 'pending',
    }));
    const touchedOvs = new Set([
      ...plan.moves.flatMap(m => [m.fromOvId, m.toOvId]),
      ...plan.restantes.map(r => r.fromOvId),
    ]);
    touchedOvs.forEach(ovId => {
      steps.push({ id: `recon-${ovId}`, type: 'reconcile_lines', label: `Reconciliar líneas (${state.tempOVs.find(t=>t.id===ovId)?.name || ovId})`, payload: { ovId }, status: 'pending' });
    });
    plan.renames.forEach((r, i) => steps.push({
      id: `rename-${i}`, type: 'rename', label: `Renombrar "${r.fromName}" → "${r.toName}"`,
      payload: r, status: 'pending',
    }));
    return steps;
  }

  async function runStepWithRetry(step) {
    const maxAttempts = 3;
    const backoff = [1000, 2000, 4000];
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await dispatchStep(step);
        return;
      } catch (err) {
        lastErr = err;
        const msg = String(err.message || '');
        const retriable = /502|network|ECONNRESET|Failed to fetch/i.test(msg);
        if (!retriable || attempt === maxAttempts - 1) throw err;
        await new Promise(r => setTimeout(r, backoff[attempt]));
      }
    }
    throw lastErr;
  }

  async function dispatchStep(step) {
    if (step.type === 'create_restantes_ov') {
      const seed = state.tempOVs[0]?.snapshot;
      if (!seed) throw new Error('No hay temp OV seed para crear Restantes');
      const created = await createRestantesOV(seed);
      state.restantesOV = { id: created.id, idInDomain: created.idInDomain, name: created.name };
      state.plan.restantes.forEach(r => { if (r.toOvId === '__pending_restantes__') r.toOvId = created.id; });
      step.detail = `id=${created.id} #${created.idInDomain}`;
    } else if (step.type === 'move' || step.type === 'move_to_restantes') {
      const m = step.payload;
      const fromOv = state.tempOVs.find(t => t.id === m.fromOvId);
      let toOv = state.tempOVs.find(t => t.id === m.toOvId);
      if (!toOv && step.type === 'move_to_restantes') {
        toOv = await loadOVDetails(state.restantesOV.idInDomain);
        state.tempOVs.push(toOv);
      }
      const fromOt = fromOv.ots.find(o => o.partNumber === m.pn);
      if (!fromOt) throw new Error(`No hay OT con PN ${m.pn} en ${fromOv.name}`);
      let toOt = toOv.ots.find(o => o.partNumber === m.pn);
      if (!toOt) {
        const created = await createOTInOV({
          ovId: toOv.id, customerId: toOv.customerId,
          deadline: toOv.snapshot?.deadline, partNumberId: fromOt.partNumberId, hintFromOt: fromOt,
        });
        const fresh = await loadOVDetails(toOv.idInDomain);
        Object.assign(toOv, fresh);
        toOt = toOv.ots.find(o => o.id === created.id) || toOv.ots.find(o => o.partNumber === m.pn);
        if (!toOt) throw new Error(`OT creada (${created.id}) no aparece al recargar OV`);
      }
      await executeMove({
        qty: m.qty,
        fromOt, toOt,
        partNumberId: fromOt.partNumberId,
        toOvId: toOv.id,
        transformCount: toOt.transformCount,
        transformDeadline: toOt.transformDeadline,
        transformPriceId: toOt.transformPriceId,
        lineItemAssocs: toOt.lineItemAssocs,
      });
    } else if (step.type === 'reconcile_lines') {
      await reconcileLineQuantities(step.payload.ovId);
    } else if (step.type === 'rename') {
      const ov = state.tempOVs.find(t => t.id === step.payload.ovId);
      if (!ov?.snapshot) throw new Error(`Sin snapshot para OV ${step.payload.ovId}`);
      if (ov.snapshot.name === step.payload.toName) { step.detail = 'ya renombrada'; return; }
      await renameOV(ov.snapshot, step.payload.toName);
    } else {
      throw new Error(`Tipo de step desconocido: ${step.type}`);
    }
  }

  function audit(step, status, errorMessage) {
    state.auditLog.push({
      timestamp: new Date().toISOString(),
      run_id: state.runId,
      step_type: step.type,
      step_id: step.id,
      status,
      label: step.label,
      detail: step.detail || '',
      payload: JSON.stringify(step.payload || {}).slice(0, 500),
      error_message: errorMessage || '',
    });
  }

  function downloadAuditCsv() {
    if (state.auditLog.length === 0) return;
    const headers = Object.keys(state.auditLog[0]);
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...state.auditLog.map(row => headers.map(h => escape(row[h])).join(',')),
    ].join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliacion-schneider-qro-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function refreshTempOVs() {
    const el = document.getElementById('sa-pr-temps-list');
    if (!el) return;
    el.innerHTML = '<em>Cargando…</em>';
    try {
      const { candidates, totalRaw, pass1Raw, pass2Used, filteredCount, shipTosSeen, customersSeen, pass1Diag, pass2Diag } = await loadCandidateTempOVs();
      if (!candidates.length) {
        const domain = api().getDomain();
        const sch = domain.schneiderQueretaro || {};
        const shipTosHtml = (shipTosSeen || [])
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map(s => `<li><code>${escapeHtml(s.id)}</code> · ${s.count} OV(s) · ${escapeHtml(s.blob || '(sin nombre/dirección)')}</li>`)
          .join('');
        const customersHtml = (customersSeen || [])
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map(c => `<li><code>id=${escapeHtml(c.id)} idInDomain=${escapeHtml(String(c.idInDomain))}</code> · ${c.count} OV(s) · ${escapeHtml(c.name)}</li>`)
          .join('');
        const renderDiag = (d, label) => {
          if (!d) return '';
          const keys = (d.rawKeys || []).join(', ') || '(vacío)';
          const root = d.rootKey || '(ninguno con .nodes)';
          const err = d.error ? `<div style="color:#c00"><strong>ERROR:</strong> ${escapeHtml(d.error)}</div>` : '';
          const sampleKeys = d.sampleNode && typeof d.sampleNode === 'object' ? Object.keys(d.sampleNode).join(', ') : '(sin sample)';
          let sampleJson;
          try { sampleJson = JSON.stringify(d.sampleNode, null, 2).slice(0, 6000); }
          catch { sampleJson = '(no serializable)'; }
          const vars = JSON.stringify(d.variables || {}, null, 2);
          const fetched = d.totalCountFetched != null ? ` · fetched=${d.totalCountFetched}` : '';
          return `
            <details style="margin-top:8px" open><summary><strong>${escapeHtml(label)}</strong> · domainId=${escapeHtml(String(d.domainId))} · root=${escapeHtml(root)} · totalCount=${escapeHtml(String(d.totalCount))}${escapeHtml(fetched)} · keys=${escapeHtml(keys)}</summary>
              ${err}
              <div style="margin-top:6px"><strong>Variables enviadas:</strong></div>
              <pre style="font-size:10px;background:#f4f4f4;padding:6px;border-radius:4px;overflow:auto;max-height:120px">${escapeHtml(vars)}</pre>
              <div style="margin-top:6px"><strong>Sample del primer nodo (keys):</strong> <code>${escapeHtml(sampleKeys)}</code></div>
              <details style="margin-top:6px"><summary>Sample completo (primeros 6000 chars)</summary>
                <pre style="font-size:10px;background:#f4f4f4;padding:6px;border-radius:4px;overflow:auto;max-height:300px">${escapeHtml(sampleJson)}</pre>
              </details>
            </details>
          `;
        };
        el.innerHTML = `
          <div class="sa-pr-issue-warn">
            <strong>No se detectaron OVs temp Schneider QRO.</strong><br>
            <small>config: customerId=${escapeHtml(String(sch.customerId ?? 'n/a'))}, shipToAddressId=${escapeHtml(String(sch.shipToAddressId ?? 'n/a'))}, regex=${escapeHtml(String(sch.shipToAddressNameRegex ?? '(default Vesta|Querétaro|QRO|Colon)'))}<br>
            Pasada 1 (con customerId): ${pass1Raw} OV(s). ${pass2Used ? `Pasada 2 (fallback sin customerId): ${totalRaw} OV(s).` : ''} Descartadas tras filtros: ${filteredCount}.</small>
            ${renderDiag(pass1Diag, 'Diagnóstico Pasada 1')}
            ${renderDiag(pass2Diag, 'Diagnóstico Pasada 2')}
            ${customersHtml ? `<details style="margin-top:8px" ${pass2Used ? 'open' : ''}><summary><strong>Customers vistos</strong> (${customersSeen.length}) — comparte el id correcto de SCHNEIDER ELECTRIC USA</summary><ul style="font-size:11px;padding-left:18px;margin:6px 0">${customersHtml}</ul></details>` : ''}
            ${shipTosHtml ? `<details style="margin-top:8px"><summary>ShipTos vistos (${shipTosSeen.length})</summary><ul style="font-size:11px;padding-left:18px;margin:6px 0">${shipTosHtml}</ul></details>` : ''}
          </div>
        `;
        updateFooter();
        return;
      }
      const details = await Promise.all(candidates.map(c => loadOVDetails(c.idInDomain).catch(e => ({ error: e.message, id: c.id, idInDomain: c.idInDomain, name: c.name }))));
      const errors = details.filter(d => d.error);
      const detailedOk = details.filter(d => !d.error);

      // Filtro por shipTo aplicado AHORA (GetReceivedOrder sí trae el dato).
      const domain2 = api().getDomain();
      const sch2 = domain2.schneiderQueretaro || {};
      const wantShipId = sch2.shipToAddressId ? String(sch2.shipToAddressId) : null;
      const wantNameRe2 = sch2.shipToAddressNameRegex
        ? new RegExp(sch2.shipToAddressNameRegex, 'i')
        : /vesta|quer[eé]taro|qro|colon\b/i;
      const detailShipTos = new Map();
      const filteredByShipTo = [];
      for (const d of detailedOk) {
        const ovRaw = d.snapshot;
        const sId = String(shipToId(ovRaw) ?? 'null');
        const blob = shipToBlob(ovRaw);
        const e = detailShipTos.get(sId) || { id: sId, blob, count: 0, sampleOvName: d.name };
        e.count++;
        detailShipTos.set(sId, e);
        const matchById = wantShipId ? sId === wantShipId : false;
        const matchByName = wantNameRe2.test(blob);
        if (wantShipId && !matchById && !matchByName) continue;
        if (!wantShipId && !matchByName) continue;
        filteredByShipTo.push(d);
      }
      state.tempOVs = filteredByShipTo;
      const droppedByShipTo = detailedOk.length - filteredByShipTo.length;

      if (!filteredByShipTo.length) {
        const shipTosListHtml = [...detailShipTos.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 20)
          .map(s => `<li><code>${escapeHtml(s.id)}</code> · ${s.count} OV(s) · ${escapeHtml(s.blob || '(sin nombre/dirección)')} · ej: ${escapeHtml(s.sampleOvName || '')}</li>`)
          .join('');
        el.innerHTML = `
          <div class="sa-pr-issue-warn">
            <strong>Sin OVs temp después del filtro de shipTo.</strong><br>
            <small>${candidates.length} OV(s) Schneider USA no-SAP cargaron sus detalles, pero ninguna matchea shipToAddressId=${escapeHtml(String(wantShipId ?? 'n/a'))} ni regex.</small>
            <details style="margin-top:8px" open><summary><strong>ShipTos vistos en detalles</strong> (${detailShipTos.size}) — comparte el id de Vesta/Querétaro</summary>
              <ul style="font-size:11px;padding-left:18px;margin:6px 0">${shipTosListHtml}</ul>
            </details>
            ${errors.length ? `<div class="sa-pr-issue-warn">⚠️ ${errors.length} OV(s) fallaron al cargar detalles. Ver consola.</div>` : ''}
          </div>
        `;
        if (errors.length) console.warn('[PR] errores cargando OVs:', errors);
        updateFooter();
        return;
      }

      el.innerHTML = `
        ${state.tempOVs.map(t => `
          <div class="item">
            <span>${escapeHtml(t.name)}</span>
            <small>${t.ots.length} OTs · ${Object.keys(t.byPN).length} PNs</small>
          </div>
        `).join('')}
        ${droppedByShipTo ? `<div style="font-size:11px;color:#666;margin-top:6px">${droppedByShipTo} OV(s) Schneider no-SAP descartadas por shipTo distinto.</div>` : ''}
        ${errors.length ? `<div class="sa-pr-issue-warn">⚠️ ${errors.length} OV(s) fallaron al cargar detalles. Ver consola.</div>` : ''}
      `;
      if (errors.length) console.warn('[PR] errores cargando OVs:', errors);
      updateFooter();
    } catch (err) {
      el.innerHTML = `<div class="sa-pr-issue-fatal">Error: ${escapeHtml(err.message || String(err))}</div>`;
      console.error('[PR] refreshTempOVs falló:', err);
    }
  }

  // ── Steelhead helpers ──────────────────────────────────────

  // Extrae texto descriptivo del shipTo de una OV (combinando los campos más
  // probables que devuelve ActiveReceivedOrders: name, addressLine1, city, etc.).
  // Sirve para matchear por regex (ej. /Vesta/i) sin depender del id exacto.
  // El endpoint usa convención `*By*Id` (Postgraphile-style): shipToAddressByShipToAddressId.
  function shipToObj(ov) {
    return ov?.shipToAddressByShipToAddressId
        ?? ov?.shipToAddress
        ?? null;
  }
  function shipToBlob(ov) {
    const s = shipToObj(ov);
    if (!s) return '';
    return [s.name, s.addressLine1, s.addressLine2, s.line1, s.line2, s.address, s.city, s.state, s.fullAddress, s.description]
      .filter(Boolean)
      .join(' | ');
  }
  function shipToId(ov) {
    return shipToObj(ov)?.id
        ?? ov?.shipToAddressId
        ?? null;
  }
  function customerObj(ov) {
    return ov?.customerByCustomerId
        ?? ov?.customer
        ?? null;
  }
  function customerIdOf(ov) {
    return customerObj(ov)?.id
        ?? ov?.customerId
        ?? null;
  }

  // Shape validado por ov-operations.js:90 (top-level args, no nested filters).
  // OJO: este hash IGNORA `customerId` server-side (visto en producción 2026-05-14:
  // se pidió customerId=176980 y devolvió OVs de NICRO id=188773 mezcladas).
  // Usar este fetcher SIEMPRE sin customerId y filtrar client-side.
  // Root key real: `pagedData` (Postgraphile-style con totalCount + nodes).
  async function fetchActiveOrdersPage({ first = 200, offset = 0 } = {}, label) {
    const domainId = api().getDomain().id || 344;
    const variables = {
      domainId,
      first,
      offset,
      orderBy: ['ID_IN_DOMAIN_DESC'],
      computeMargins: false,
      showInvoicedSubtotal: false,
    };
    const diag = { label, variables, domainId, raw: null, rawKeys: [], rootKey: null, sampleNode: null, totalCount: null, error: null };
    try {
      const data = await api().query('ActiveReceivedOrders', variables);
      diag.raw = data;
      diag.rawKeys = data && typeof data === 'object' ? Object.keys(data) : [];
      let all = [];
      let rootKey = null;
      for (const k of diag.rawKeys) {
        const v = data[k];
        if (v && typeof v === 'object' && Array.isArray(v.nodes)) {
          rootKey = k;
          all = v.nodes;
          diag.totalCount = v.totalCount ?? null;
          break;
        }
      }
      diag.rootKey = rootKey;
      diag.sampleNode = all[0] || null;
      log(`fetchActiveOrdersPage(${label}): ${all.length} OV(s) [domainId=${domainId} root=${rootKey || '(ninguno)'} totalCount=${diag.totalCount} offset=${offset}]`);
      window.__poReconcilerLastFetchDiag = diag;
      return { items: all, diag };
    } catch (e) {
      diag.error = e.message || String(e);
      log(`fetchActiveOrdersPage(${label}): ERROR ${diag.error}`);
      console.error(`[PR] fetchActiveOrdersPage ERROR (${label}):`, e, 'variables=', variables);
      window.__poReconcilerLastFetchDiag = diag;
      return { items: [], diag };
    }
  }

  // Pagina hasta agotar `totalCount` (con cap defensivo). Devuelve { items, diag }
  // donde `diag` es la del primer fetch (para preservar shape de la respuesta cruda).
  async function fetchActiveOrders({ first = 200, capPages = 10 } = {}, label) {
    const items = [];
    let firstDiag = null;
    let total = null;
    for (let page = 0; page < capPages; page++) {
      const offset = page * first;
      const r = await fetchActiveOrdersPage({ first, offset }, `${label} p${page}`);
      if (!page) firstDiag = r.diag;
      if (!r.items.length) break;
      items.push(...r.items);
      total = r.diag.totalCount;
      if (total != null && items.length >= total) break;
    }
    if (firstDiag) firstDiag.totalCountFetched = items.length;
    log(`fetchActiveOrders(${label}): traídas ${items.length} OV(s) (totalCount=${total})`);
    return { items, diag: firstDiag };
  }

  async function loadCandidateTempOVs() {
    const domain = api().getDomain();
    const schneider = domain.schneiderQueretaro || {};
    const sapRe = new RegExp(schneider.poNumberRegex || '^14\\d{8}$');
    const wantId = schneider.shipToAddressId ? String(schneider.shipToAddressId) : null;
    const wantNameRe = schneider.shipToAddressNameRegex
      ? new RegExp(schneider.shipToAddressNameRegex, 'i')
      : /vesta|quer[eé]taro|qro|colon\b/i;

    // Una sola pasada paginada (el server ignora `customerId` en este hash, así
    // que filtramos client-side abajo). Cap 10 páginas × 200 = 2000 OVs activas.
    let all = [];
    let mainDiag = null;
    try {
      const r = await fetchActiveOrders({ first: 200, capPages: 10 }, 'todas activas (paginado)');
      all = r.items;
      mainDiag = r.diag;
    } catch (e) { warn(`Fetch principal falló: ${e.message}`); }
    const pass1Raw = all.length;
    const pass2Used = false;
    const pass1Diag = mainDiag;
    const pass2Diag = null;

    // Diagnóstico: agrupar shipTos vistos
    const shipTosSeen = new Map();
    const customersSeen = new Map();
    for (const ov of all) {
      const sId = String(shipToId(ov) ?? 'null');
      const blob = shipToBlob(ov);
      const sEntry = shipTosSeen.get(sId) || { id: sId, blob, count: 0, sampleOvName: ov.name };
      sEntry.count++;
      shipTosSeen.set(sId, sEntry);
      const c = customerObj(ov);
      const cId = String(customerIdOf(ov) ?? 'null');
      const cName = c?.name || c?.companyName || '(sin nombre)';
      const cIdInDomain = c?.idInDomain ?? 'n/a';
      const cEntry = customersSeen.get(cId) || { id: cId, idInDomain: cIdInDomain, name: cName, count: 0 };
      cEntry.count++;
      customersSeen.set(cId, cEntry);
    }

    // El server ignora `customerId` en este hash de ActiveReceivedOrders →
    // filtramos client-side. OJO: ActiveReceivedOrders NO devuelve shipTo en
    // cada nodo, así que el filtro por shipTo se aplica abajo, sobre los
    // detalles de cada candidata (GetReceivedOrder en loadOVDetails).
    const wantCustomerId = schneider.customerId ? String(schneider.customerId) : null;
    const candidates = all.filter(ov => {
      if (ov.archivedAt) return false;
      if (wantCustomerId && String(customerIdOf(ov) ?? '') !== wantCustomerId) return false;
      const name = String(ov.name || '').trim();
      if (sapRe.test(name)) return false; // ya tiene PO SAP asignado
      return true;
    });
    log(`Temp OVs candidatas: ${candidates.length} (de ${all.length} OV(s) activas, pass2Used=${pass2Used})`);
    if (!candidates.length && all.length) {
      console.info('[PR] ShipTos vistos:', [...shipTosSeen.values()]);
      console.info('[PR] Customers vistos:', [...customersSeen.values()]);
      console.info('[PR] Sample OV:', all[0]);
    }
    return {
      candidates: candidates.map(ov => ({ id: ov.id, idInDomain: ov.idInDomain, name: ov.name, raw: ov })),
      totalRaw: all.length,
      pass1Raw,
      pass2Used,
      filteredCount: all.length - candidates.length,
      shipTosSeen: [...shipTosSeen.values()],
      customersSeen: [...customersSeen.values()],
      pass1Diag,
      pass2Diag,
    };
  }

  // Helper: resuelve idInDomain a partir de id interno usando state caches.
  function resolveIdInDomain(id) {
    const t = state.tempOVs?.find(x => x.id === id);
    if (t?.idInDomain != null) return t.idInDomain;
    if (state.restantesOV?.id === id && state.restantesOV?.idInDomain != null) return state.restantesOV.idInDomain;
    throw new Error(`No puedo resolver idInDomain para id interno=${id}`);
  }

  // GetReceivedOrder requiere idInDomain (Int!) — el id interno NO funciona.
  async function loadOVDetails(idInDomain) {
    if (idInDomain == null) throw new Error('loadOVDetails requiere idInDomain');
    const data = await api().query('GetReceivedOrder', { idInDomain: parseInt(idInDomain, 10) });
    const ov = data?.receivedOrderByIdInDomain || data?.receivedOrder;
    if (!ov) throw new Error(`GetReceivedOrder(idInDomain=${idInDomain}) devolvió shape inesperado`);

    // Líneas y OTs
    const lines = ov.receivedOrderLines?.nodes
                || ov.receivedOrderLinesByReceivedOrderId?.nodes
                || [];

    // Pasada 1: indexar receivedOrderLineItemPartTransforms por PT id.
    // Cada PT puede aparecer asociado a varios lineItems (en distintas líneas).
    // executeMove necesita todos los assocs del PT destino para que la mutación
    // AddPartsToWorkOrders no los null-ee al guardar.
    const ptAssocsByPtId = {};
    for (const line of lines) {
      for (const li of (line.lineItems?.nodes || line.lineItems || [])) {
        for (const ptAssoc of (li.receivedOrderLineItemPartTransforms?.nodes
                            || li.receivedOrderLineItemPartTransforms
                            || [])) {
          const pt = ptAssoc.receivedOrderPartTransform;
          if (!pt?.id) continue;
          const arr = ptAssocsByPtId[pt.id] || (ptAssocsByPtId[pt.id] = []);
          arr.push({
            id: ptAssoc.id,
            receivedOrderPartTransform: {
              id: pt.id,
              partNumberId: pt.partNumberId,
              partNumberPriceId: pt.partNumberPriceId ?? null,
              count: pt.count ?? 0,
              description: pt.description ?? '',
            },
          });
        }
      }
    }

    const ots = [];
    const byPN = {};
    const seenWoIds = new Set();
    for (const line of lines) {
      for (const li of (line.lineItems?.nodes || line.lineItems || [])) {
        for (const ptAssoc of (li.receivedOrderLineItemPartTransforms?.nodes
                            || li.receivedOrderLineItemPartTransforms
                            || [])) {
          const pt = ptAssoc.receivedOrderPartTransform;
          if (!pt) continue;
          for (const wo of (pt.workOrders?.nodes || pt.workOrders || [])) {
            if (seenWoIds.has(wo.id)) continue;  // PT compartido entre líneas: no duplicar OT
            seenWoIds.add(wo.id);
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
              transformCount: pt.count ?? null,
              transformDeadline: pt.deadline ?? null,
              transformPriceId: pt.partNumberPriceId ?? null,
              lineItemAssocs: ptAssocsByPtId[pt.id] || [],
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
      customerId: customerIdOf(ov),
      shipToAddressId: shipToId(ov),
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
    // El server ignora customerId en este hash → traemos todo paginado y
    // filtramos client-side por name + customerId.
    const r = await fetchActiveOrders({ first: 200, capPages: 10 }, 'findRestantes');
    return (r.items || []).find(ov => {
      if (String(ov.name).trim() !== expectedName) return false;
      if (sch.customerId && String(customerIdOf(ov) ?? '') !== String(sch.customerId)) return false;
      return true;
    }) || null;
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
    const fresh = await loadOVDetails(resolveIdInDomain(ovId));
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

  // Schneider QRO PO layout (2026-05-13): líneas tabulares con shape muy regular.
  // Se parsean programáticamente via pdf.js (sin Claude API). Si el PDF no es
  // identificable como Schneider, se cae a Claude (POComparator.parsePDF) como fallback.

  const REMOTE_BASE_URL = 'https://oviazcan.github.io/SteelheadAutomator';
  const PDF_WORKER_PATH = 'scripts/lib/pdf.worker.min.js';

  async function ensurePdfWorker() {
    if (!window.pdfjsLib) throw new Error('pdfjsLib no está cargado (revisa config.scripts del applet)');
    if (window.pdfjsLib.GlobalWorkerOptions.workerSrc) return;
    // Cargar worker como Blob URL para evitar restricciones CSP de cross-origin Web Workers.
    const ver = cfg()?.version || Date.now();
    const url = `${REMOTE_BASE_URL}/${PDF_WORKER_PATH}?v=${ver}`;
    const code = await fetch(url, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} cargando pdf.worker.min.js`);
      return r.text();
    });
    const blob = new Blob([code], { type: 'application/javascript' });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  }

  async function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Error leyendo PDF'));
      r.readAsArrayBuffer(file);
    });
  }

  // Extrae texto del PDF agrupando items por línea visual (coord Y).
  // Devuelve { lines: [string], pageBreaks: [linesIdx] }.
  async function extractPdfTextLines(file) {
    await ensurePdfWorker();
    const buf = await readFileAsArrayBuffer(file);
    const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(buf) });
    const pdf = await loadingTask.promise;
    const lines = [];
    const pageBreaks = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      pageBreaks.push(lines.length);
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      // Agrupar por Y (transform[5]); permitir epsilon para variaciones internas
      const rows = new Map(); // yKey -> [{x, str}]
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = it.transform?.[5];
        const x = it.transform?.[4];
        if (typeof y !== 'number') continue;
        const yKey = Math.round(y * 2) / 2; // 0.5 px bins
        const arr = rows.get(yKey) || [];
        arr.push({ x: typeof x === 'number' ? x : 0, str: it.str });
        rows.set(yKey, arr);
      }
      // Ordenar yKey desc (Y crece hacia arriba en PDF coord), luego items por X asc
      const sortedYs = [...rows.keys()].sort((a, b) => b - a);
      for (const y of sortedYs) {
        const items = rows.get(y).sort((a, b) => a.x - b.x);
        const text = items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
      }
    }
    return { lines, pageBreaks, numPages: pdf.numPages };
  }

  // Detecta si el texto extraído corresponde al layout de Schneider Electric QRO.
  function isSchneiderPo(textLines) {
    const blob = textLines.slice(0, 30).join(' | ');
    return /Schneider\s+Electric/i.test(blob) && /PO\s*Number\s*:/i.test(blob);
  }

  // Parser programático del layout Schneider QRO (validado con 1400399143/331/624).
  function parseSchneiderText({ lines }) {
    const out = { poNumber: null, customer: 'Schneider Electric', currency: 'USD', lines: [] };
    // PO Number
    for (const ln of lines) {
      const m = ln.match(/PO\s*Number\s*:?\s*(\d{10,})/i);
      if (m) { out.poNumber = m[1]; break; }
    }
    // Currency
    for (const ln of lines) {
      const m = ln.match(/Currency\s*:?\s*([A-Z]{3})\b/);
      if (m) { out.currency = m[1]; break; }
    }
    // Líneas tabulares: "<item> <material#> <qty> Piece <DD MMM YYYY>"
    // Ej: "10 SWB-00443791 20 Piece 30 May 2026"
    // Después suele venir: "Gross Price 4.08 USD per 1 PCE 81.60 USD"
    const ITEM_RE = /^\s*(\d{1,4})\s+([A-Z0-9][\w\-./]*)\s+([\d,]+(?:\.\d+)?)\s+(?:Piece|PCS|PZA|Each|EA)\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*$/;
    const PRICE_RE = /Gross\s*Price\s+([\d,]+(?:\.\d+)?)\s+[A-Z]{3}\s+per\s+([\d,]+(?:\.\d+)?)\s+(?:PCE|PCS|EA|PZA)\s+([\d,]+(?:\.\d+)?)\s+[A-Z]{3}/i;

    let pendingItem = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const im = ln.match(ITEM_RE);
      if (im) {
        if (pendingItem) out.lines.push(pendingItem); // emitir el previo si no se encontró Gross Price
        pendingItem = {
          lineNumber: out.lines.length + 1,
          itemNumber: Number(im[1]),
          partNumber: im[2].trim(),
          description: null,
          quantity: Number(im[3].replace(/,/g, '')),
          unitPrice: null,
          total: null,
          deliveryDate: im[4],
        };
        continue;
      }
      if (pendingItem) {
        const pm = ln.match(PRICE_RE);
        if (pm) {
          const unit = Number(pm[1].replace(/,/g, ''));
          const per = Number(pm[2].replace(/,/g, '')) || 1;
          const total = Number(pm[3].replace(/,/g, ''));
          pendingItem.unitPrice = per === 1 ? unit : unit / per;
          pendingItem.total = total;
          out.lines.push(pendingItem);
          pendingItem = null;
        }
      }
    }
    if (pendingItem) out.lines.push(pendingItem);

    if (!out.poNumber) throw new Error('No se encontró PO Number en el PDF');
    if (!out.lines.length) throw new Error('No se encontraron líneas de productos');

    out.sourceType = 'pdf';
    out.parsedBy = 'schneider-local-v1';
    return out;
  }

  async function parseSinglePdf(file) {
    try {
      // Intento 1: parser local (sin Claude). Funciona para Schneider QRO.
      const ext = await extractPdfTextLines(file);
      if (isSchneiderPo(ext.lines)) {
        const parsed = parseSchneiderText(ext);
        log(`PDF "${file.name}" parseado localmente: PO ${parsed.poNumber} · ${parsed.lines.length} líneas`);
        return { status: 'ok', file, parsed, error: null };
      }
      // Fallback: Claude API (otros formatos)
      log(`PDF "${file.name}" no es Schneider — fallback a Claude`);
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

  // ── Public API ──────────────────────────────────────────────
  const publicApi = {
    init,
    openWizard,
    _engine: {
      consolidateByPN,
      hungarianMatch,
      assignTempsToPOs,
      computeMovesForPN,
      detectIssuesForPN,
      buildPlan,
    },
  };
  if (typeof window !== 'undefined' && window.__SA_DEBUG__) {
    publicApi._helpers = { loadCandidateTempOVs, loadOVDetails, findRestantesOV, createRestantesOV, findOTForPN, createOTInOV, executeMove, reconcileLineQuantities, mapToUpdateShape, renameOV, parseSinglePdf, parseMultiplePdfs };
  }
  return publicApi;
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
