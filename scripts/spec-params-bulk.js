// SpecParamsBulk — applet de carga masiva de SpecParam
// MVP 2026-05-18 (v0.9.0). Dos acciones:
//   - runDownload(): panel selector → fetch detalles → XLSX con columnas *_NUEVO editables
//   - runUpload():   file-picker → parsea XLSX → diff preview → SaveMultipleSpecFieldParams en batches
//
// Depende de: window.SteelheadAPI, window.SpecShared, window.XLSX (SheetJS)
//
// Patrones reutilizados de process-deep-audit / invoice-autofill:
//   - Cancellation token via state.runId monotónico + isStale(myRunId).
//   - Pool concurrente con semáforo manual.
//   - Retry exponencial.

const SpecParamsBulk = (() => {
  'use strict';

  const VERSION = '0.10.0';
  const PANEL_ID = 'sa-spb-panel';
  const STYLE_ID = 'sa-spb-style';

  const api = () => window.SteelheadAPI;
  const PS = () => window.SpecShared;
  const log = (m) => api()?.log(`[SPB] ${m}`);
  const warn = (m) => api()?.warn(`[SPB] ${m}`);

  // ── Estado global ───────────────────────────────────────
  const state = {
    runId: 0,
    panelEl: null,
    fileInput: null
  };

  const cfg = () => api()?.getDomain()?.specParamsBulk || {};
  const fetchConcurrency = () => cfg()?.concurrency?.fetchDetails || 5;
  const editConcurrency = () => cfg()?.concurrency?.editShape || 10;
  const batchSize = () => cfg()?.batchSize || 50;
  const retryDelays = () => cfg()?.retryDelaysMs || [1000, 2000, 4000];

  // ── Cancellation + pool ─────────────────────────────────
  function nextRunId() { return ++state.runId; }
  function isStale(myRunId) { return state.runId !== myRunId; }
  function bailIfStale(myRunId) { if (isStale(myRunId)) throw new Error('Run cancelado'); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function runPool(items, worker, concurrency, onProgress, myRunId) {
    const results = new Array(items.length);
    let idx = 0;
    let done = 0;
    const workers = new Array(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
      while (true) {
        if (isStale(myRunId)) return;
        const i = idx++;
        if (i >= items.length) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (e) {
          results[i] = { __error: e?.message || String(e) };
        }
        done++;
        if (onProgress) {
          try { onProgress(done, items.length); } catch (_) {}
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function withRetry(fn, label, myRunId) {
    const delays = retryDelays();
    let lastErr = null;
    for (let i = 0; i <= delays.length; i++) {
      bailIfStale(myRunId);
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i === delays.length) throw e;
        warn(`${label} falló intento ${i + 1}/${delays.length + 1}: ${e?.message || e}; retry en ${delays[i]}ms`);
        await sleep(delays[i]);
      }
    }
    throw lastErr;
  }

  // ── Estilos ─────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${PANEL_ID} { position: fixed; right: 18px; bottom: 18px; width: 520px; max-height: 78vh;
        background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.4); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px; z-index: 2147483647; display: flex; flex-direction: column; }
      #${PANEL_ID} .spb-hdr { padding: 10px 12px; background: #111827; border-bottom: 1px solid #374151;
        display: flex; align-items: center; justify-content: space-between; border-radius: 10px 10px 0 0; }
      #${PANEL_ID} .spb-hdr h3 { margin: 0; font-size: 14px; color: #f9fafb; }
      #${PANEL_ID} .spb-body { padding: 10px 12px; overflow-y: auto; flex: 1; }
      #${PANEL_ID} .spb-ftr { padding: 10px 12px; border-top: 1px solid #374151; background: #111827;
        border-radius: 0 0 10px 10px; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
      #${PANEL_ID} .spb-btn { background: #2563eb; color: white; border: none; padding: 6px 12px; border-radius: 6px;
        cursor: pointer; font-size: 12px; }
      #${PANEL_ID} .spb-btn:hover:not(:disabled) { background: #1d4ed8; }
      #${PANEL_ID} .spb-btn:disabled { background: #4b5563; cursor: not-allowed; opacity: 0.6; }
      #${PANEL_ID} .spb-btn-ghost { background: transparent; color: #9ca3af; border: 1px solid #374151; }
      #${PANEL_ID} .spb-btn-ghost:hover { color: #e5e7eb; border-color: #6b7280; }
      #${PANEL_ID} .spb-btn-danger { background: #dc2626; }
      #${PANEL_ID} .spb-btn-danger:hover:not(:disabled) { background: #b91c1c; }
      #${PANEL_ID} .spb-filter-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
      #${PANEL_ID} label { font-size: 12px; color: #d1d5db; }
      #${PANEL_ID} input[type=text], #${PANEL_ID} input[type=search] {
        background: #0f172a; color: #e5e7eb; border: 1px solid #334155; padding: 4px 8px; border-radius: 4px;
        font-size: 12px; flex: 1; }
      #${PANEL_ID} input[type=text]:focus, #${PANEL_ID} input[type=search]:focus { outline: 1px solid #2563eb; }
      #${PANEL_ID} .spb-counter { font-size: 11px; color: #9ca3af; }
      #${PANEL_ID} .spb-list { max-height: 50vh; overflow-y: auto; border: 1px solid #374151; border-radius: 6px;
        padding: 4px 0; background: #0f172a; }
      #${PANEL_ID} .spb-row { display: flex; align-items: center; gap: 8px; padding: 4px 10px;
        border-bottom: 1px solid #1f2937; cursor: pointer; }
      #${PANEL_ID} .spb-row:hover { background: #111827; }
      #${PANEL_ID} .spb-row:last-child { border-bottom: none; }
      #${PANEL_ID} .spb-row .spb-name { flex: 1; }
      #${PANEL_ID} .spb-row .spb-tag { font-size: 10px; padding: 1px 6px; border-radius: 10px;
        background: #374151; color: #d1d5db; }
      #${PANEL_ID} .spb-row .spb-tag-mp { background: #7c2d12; color: #fed7aa; }
      #${PANEL_ID} .spb-progress { margin: 8px 0; font-size: 12px; color: #93c5fd; }
      #${PANEL_ID} .spb-progress .spb-bar { height: 4px; background: #1f2937; border-radius: 2px; overflow: hidden;
        margin-top: 4px; }
      #${PANEL_ID} .spb-progress .spb-bar div { height: 100%; background: #3b82f6; transition: width 0.2s; }
      #${PANEL_ID} table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
      #${PANEL_ID} th, #${PANEL_ID} td { border: 1px solid #374151; padding: 3px 6px; text-align: left; }
      #${PANEL_ID} th { background: #111827; color: #f9fafb; }
      #${PANEL_ID} .spb-tab-hdr { display: flex; gap: 4px; margin-bottom: 8px; }
      #${PANEL_ID} .spb-tab { padding: 4px 10px; cursor: pointer; background: #111827; border: 1px solid #374151;
        border-radius: 6px 6px 0 0; font-size: 12px; }
      #${PANEL_ID} .spb-tab.active { background: #2563eb; color: white; border-color: #2563eb; }
      #${PANEL_ID} .spb-error { color: #f87171; font-size: 12px; padding: 6px; background: #7f1d1d33;
        border: 1px solid #7f1d1d; border-radius: 4px; }
      #${PANEL_ID} .spb-success { color: #6ee7b7; font-size: 12px; padding: 6px; background: #14532d33;
        border: 1px solid #14532d; border-radius: 4px; }
      #${PANEL_ID} .spb-diff-old { color: #fca5a5; text-decoration: line-through; }
      #${PANEL_ID} .spb-diff-new { color: #6ee7b7; }
      /* Duplicate-params validator */
      #${PANEL_ID}.spb-wide { width: 880px; }
      #${PANEL_ID} .spb-dup-stats { display:flex; gap:14px; font-size:11px; color:#cbd5e1;
        background:#0f172a; padding:6px 10px; border-radius:6px; margin-bottom:8px; flex-wrap:wrap; }
      #${PANEL_ID} .spb-dup-stats b { color:#f9fafb; }
      #${PANEL_ID} .spb-dup-table { width:100%; border-collapse:collapse; font-size:11px; }
      #${PANEL_ID} .spb-dup-table thead th { position:sticky; top:0; background:#111827;
        z-index:1; padding:5px 6px; border:1px solid #374151; text-align:left; color:#f9fafb; font-size:11px; }
      #${PANEL_ID} .spb-dup-table td { border:1px solid #1f2937; padding:5px 6px; vertical-align:top; }
      #${PANEL_ID} .spb-dup-table .pname { color:#93c5fd; font-weight:600; }
      #${PANEL_ID} .spb-dup-table .pmeta { font-size:10px; color:#9ca3af; }
      #${PANEL_ID} .spb-dup-table .spb-radio-row { display:flex; align-items:center; gap:6px;
        padding:2px 0; cursor:pointer; }
      #${PANEL_ID} .spb-dup-table .spb-radio-row.winner { color:#6ee7b7; }
      #${PANEL_ID} .spb-dup-table .spb-radio-row.loser { color:#fca5a5; }
      #${PANEL_ID} .spb-dup-table tr.ignored td { opacity:0.45; }
      #${PANEL_ID} .spb-dup-table tr.ignored .spb-radio-row { color:#9ca3af !important; }
      #${PANEL_ID} .spb-dup-table .spb-mini { font-size:10px; color:#cbd5e1; background:#1f2937;
        padding:1px 5px; border-radius:8px; margin-left:4px; }
    `;
    document.head.appendChild(s);
  }

  function closePanel() {
    if (state.panelEl && state.panelEl.parentNode) state.panelEl.parentNode.removeChild(state.panelEl);
    state.panelEl = null;
  }

  function ensurePanel(title) {
    closePanel();
    ensureStyles();
    const el = document.createElement('div');
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="spb-hdr">
        <h3>${title}</h3>
        <button class="spb-btn spb-btn-ghost" data-act="close">✕</button>
      </div>
      <div class="spb-body"></div>
      <div class="spb-ftr"></div>
    `;
    document.body.appendChild(el);
    state.panelEl = el;
    el.querySelector('[data-act=close]').addEventListener('click', () => {
      nextRunId(); // cancela cualquier run en curso
      closePanel();
    });
    return el;
  }

  function setBody(html) {
    if (!state.panelEl) return;
    state.panelEl.querySelector('.spb-body').innerHTML = html;
  }
  function setFooter(html) {
    if (!state.panelEl) return;
    state.panelEl.querySelector('.spb-ftr').innerHTML = html;
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ════════════════════════════════════════════════════════
  //  DOWNLOAD FLOW
  // ════════════════════════════════════════════════════════

  async function runDownload() {
    const myRunId = nextRunId();
    ensurePanel('Descargar Spec Params (XLSX)');
    setBody('<div class="spb-progress">Cargando catálogo de specs…</div>');

    let allSpecs;
    try {
      await PS().loadSpecCatalog();
      bailIfStale(myRunId);
      allSpecs = [...PS().getSpecCatalog().values()];
    } catch (e) {
      setBody(`<div class="spb-error">No se pudo cargar el catálogo: ${escHtml(e.message)}</div>`);
      return;
    }
    log(`Catálogo cargado: ${allSpecs.length} specs activas`);
    renderSelectorPanel(allSpecs, myRunId);
  }

  // Estado local del selector
  const selector = {
    typeFilter: 'ALL',          // 'ALL' | 'INTERNAL' | 'EXTERNAL'
    excludeMP: true,
    search: '',
    selectedIds: new Set()       // Set<idInDomain>
  };

  function renderSelectorPanel(allSpecs, myRunId) {
    // Reset selector state on each open
    selector.typeFilter = 'ALL';
    selector.excludeMP = true;
    selector.search = '';
    selector.selectedIds = new Set();

    setBody(`
      <div class="spb-filter-row">
        <label>Tipo:
          <select data-ctrl="type" style="background:#0f172a;color:#e5e7eb;border:1px solid #334155;padding:3px 6px;border-radius:4px;font-size:12px">
            <option value="ALL">Todas</option>
            <option value="INTERNAL">Internas</option>
            <option value="EXTERNAL">Externas</option>
          </select>
        </label>
        <label><input type="checkbox" data-ctrl="mp" checked> Excluir MP</label>
      </div>
      <div class="spb-filter-row">
        <input type="search" data-ctrl="search" placeholder="Buscar por nombre o #" autocomplete="off">
        <span class="spb-counter" data-ctrl="counter">0 / 0</span>
      </div>
      <div class="spb-list" data-ctrl="list"></div>
    `);
    setFooter(`
      <span class="spb-counter" data-ctrl="sel-counter">0 seleccionadas</span>
      <div style="display:flex;gap:6px">
        <button class="spb-btn spb-btn-ghost" data-act="select-visible">Seleccionar visibles</button>
        <button class="spb-btn spb-btn-ghost" data-act="clear">Limpiar</button>
        <button class="spb-btn" data-act="download" disabled>Descargar XLSX (0)</button>
      </div>
    `);

    const root = state.panelEl;
    const listEl = root.querySelector('[data-ctrl=list]');
    const counterEl = root.querySelector('[data-ctrl=counter]');
    const selCounterEl = root.querySelector('[data-ctrl=sel-counter]');
    const downloadBtn = root.querySelector('[data-act=download]');

    function visibleSpecs() {
      const q = selector.search.trim().toLowerCase();
      return allSpecs.filter(s => {
        if (selector.typeFilter !== 'ALL' && s.type !== selector.typeFilter) return false;
        if (selector.excludeMP && PS().isMPSpec(s)) return false;
        if (q) {
          const hay = `${s.idInDomain} ${s.name || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function renderList() {
      const vis = visibleSpecs();
      counterEl.textContent = `${vis.length} / ${allSpecs.length}`;
      // Soft-cap visual: render solo los primeros 800 para que el DOM no se ahogue.
      // El usuario puede refinar con buscador o seleccionar todos con el botón.
      const RENDER_CAP = 800;
      const slice = vis.slice(0, RENDER_CAP);
      const rows = slice.map(s => {
        const isMP = PS().isMPSpec(s);
        const checked = selector.selectedIds.has(s.idInDomain) ? 'checked' : '';
        const typeBadge = s.type === 'INTERNAL' ? 'INT' : 'EXT';
        return `<label class="spb-row">
          <input type="checkbox" data-id="${s.idInDomain}" ${checked}>
          <span class="spb-tag">#${s.idInDomain}</span>
          <span class="spb-tag">${typeBadge}</span>
          ${isMP ? '<span class="spb-tag spb-tag-mp">MP</span>' : ''}
          <span class="spb-name">${escHtml(s.name || '(sin nombre)')}</span>
        </label>`;
      }).join('');
      const overflow = vis.length > RENDER_CAP
        ? `<div style="padding:6px 10px;font-size:11px;color:#9ca3af">Mostrando ${RENDER_CAP} de ${vis.length}. Refina con buscador o usa Seleccionar visibles.</div>`
        : '';
      listEl.innerHTML = rows + overflow;
      listEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const id = Number(e.target.dataset.id);
          if (e.target.checked) selector.selectedIds.add(id);
          else selector.selectedIds.delete(id);
          updateSelCounter();
        });
      });
    }

    function updateSelCounter() {
      const n = selector.selectedIds.size;
      selCounterEl.textContent = `${n} seleccionadas`;
      downloadBtn.textContent = `Descargar XLSX (${n})`;
      downloadBtn.disabled = n === 0;
    }

    root.querySelector('[data-ctrl=type]').addEventListener('change', (e) => {
      selector.typeFilter = e.target.value;
      renderList();
    });
    root.querySelector('[data-ctrl=mp]').addEventListener('change', (e) => {
      selector.excludeMP = e.target.checked;
      renderList();
    });
    root.querySelector('[data-ctrl=search]').addEventListener('input', (e) => {
      selector.search = e.target.value || '';
      renderList();
    });
    root.querySelector('[data-act=select-visible]').addEventListener('click', () => {
      visibleSpecs().forEach(s => selector.selectedIds.add(s.idInDomain));
      renderList(); // re-render para reflejar checked
      updateSelCounter();
    });
    root.querySelector('[data-act=clear]').addEventListener('click', () => {
      selector.selectedIds.clear();
      renderList();
      updateSelCounter();
    });
    downloadBtn.addEventListener('click', async () => {
      const selected = [...selector.selectedIds].map(id => PS().getSpecByIdInDomain(id)).filter(Boolean);
      if (!selected.length) return;
      await runDownloadFor(selected, myRunId);
    });

    renderList();
  }

  async function runDownloadFor(specs, parentRunId) {
    const myRunId = nextRunId();
    void parentRunId; // el cambio de runId ya cancela cualquier render anterior
    setBody(`<div class="spb-progress">
      Descargando detalles de ${specs.length} specs…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="spb-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    setFooter(`<button class="spb-btn spb-btn-danger" data-act="cancel">Cancelar</button>`);
    state.panelEl.querySelector('[data-act=cancel]')?.addEventListener('click', () => {
      nextRunId(); // cancela
      closePanel();
    });
    const progMsg = state.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar = state.panelEl.querySelector('[data-ctrl=prog-bar]');

    try {
      // Fase 1: GetSpec por cada spec seleccionada
      const details = await runPool(specs, async (s) => {
        return await withRetry(
          () => PS().getSpecDetail(s.idInDomain, s.revisionNumber),
          `GetSpec(${s.idInDomain},r${s.revisionNumber})`,
          myRunId
        );
      }, fetchConcurrency(), (done, total) => {
        if (progMsg) progMsg.textContent = `Fase 1 (detalles): ${done}/${total}`;
        if (progBar) progBar.style.width = `${(done / total) * 50}%`;
      }, myRunId);
      bailIfStale(myRunId);

      // Aplanar a filas de SpecParam, recolectar paramId+specFieldId para fase 2
      const rows = [];
      const editTasks = [];
      details.forEach((d, i) => {
        if (!d || d.__error) {
          warn(`Spec ${specs[i].idInDomain} sin detalle: ${d?.__error || 'null'}`);
          return;
        }
        const flat = PS().flattenSpecToParams(d);
        for (const r of flat) {
          rows.push(r);
          editTasks.push({ paramId: r.paramId, specFieldId: r.fieldId, rowRef: r });
        }
      });
      log(`Fase 1 OK: ${rows.length} params en ${details.filter(d => d && !d.__error).length} specs`);

      // Fase 2: enriquecer con GetSpecFieldParamToEdit por param
      await runPool(editTasks, async (t) => {
        const shape = await withRetry(
          () => PS().getSpecFieldParamToEdit(t.paramId, t.specFieldId),
          `GetSpecFieldParamToEdit(${t.paramId})`,
          myRunId
        );
        PS().enrichRowFromEditShape(t.rowRef, shape);
        return true;
      }, editConcurrency(), (done, total) => {
        if (progMsg) progMsg.textContent = `Fase 2 (campos editables): ${done}/${total}`;
        if (progBar) progBar.style.width = `${50 + (done / total) * 50}%`;
      }, myRunId);
      bailIfStale(myRunId);

      // Build XLSX
      buildAndDownloadXlsx(rows);
      setBody(`<div class="spb-success">XLSX descargado: ${rows.length} params en ${specs.length} specs.</div>`);
      setFooter(`<button class="spb-btn" data-act="close-ok">Cerrar</button>`);
      state.panelEl.querySelector('[data-act=close-ok]')?.addEventListener('click', () => closePanel());
    } catch (e) {
      if (e?.message === 'Run cancelado') return;
      setBody(`<div class="spb-error">Error en descarga: ${escHtml(e.message)}</div>`);
      setFooter(`<button class="spb-btn" data-act="close-err">Cerrar</button>`);
      state.panelEl.querySelector('[data-act=close-err]')?.addEventListener('click', () => closePanel());
    }
  }

  // ── Layout XLSX ─────────────────────────────────────────
  // Headers fijos. Las columnas *_NUEVO son las EDITABLES; las otras son contexto.
  const XLSX_HEADERS = [
    'SpecType', 'SpecID', 'SpecIdInDomain', 'SpecName', 'SpecRev',
    'FieldID', 'FieldName', 'FieldType',
    'ParamID', 'ParamName', 'ParamName_NUEVO',
    'Min', 'Min_NUEVO',
    'Max', 'Max_NUEVO',
    'Target', 'Target_NUEVO',
    'SampleCount', 'SampleCount_NUEVO',
    'SamplingIntervalMin', 'SamplingIntervalMin_NUEVO',
    'SensorValidDurationMin', 'SensorValidDurationMin_NUEVO',
    'SensorWarningThresholdMin', 'SensorWarningThresholdMin_NUEVO',
    'InputRequired', 'InputRequired_NUEVO',
    'InputRequested', 'InputRequested_NUEVO',
    'MustBePassing', 'MustBePassing_NUEVO',
    'FailingRequiresResolution', 'FailingRequiresResolution_NUEVO',
    'RequestDocument', 'RequestDocument_NUEVO',
    'OneAtATime', 'OneAtATime_NUEVO',
    'DrivesCoupons', 'DrivesCoupons_NUEVO',
    'DescriptionMarkdown', 'DescriptionMarkdown_NUEVO',
    'IsDefault', 'DerivedFromID', 'SpecFieldSpecID', 'UnitID', 'SampleSetID', 'ClassificationSetID',
    'Labels', 'EsMP'
  ];

  function rowToAOA(r) {
    const b = (v) => v == null ? '' : (v ? 'TRUE' : 'FALSE');
    const n = (v) => (v == null || v === '') ? '' : Number(v);
    return [
      r.specType, r.specId, r.specIdInDomain, r.specName, r.specRevision,
      r.fieldId, r.fieldName, r.fieldType,
      r.paramId, r.paramName, '',
      n(r.minimumValue), '',
      n(r.maximumValue), '',
      n(r.targetValue), '',
      n(r.sampleCount), '',
      n(r.samplingIntervalMinutes), '',
      n(r.sensorValidDurationMinutes), '',
      n(r.sensorWarningThresholdMinutes), '',
      b(r.inputRequired), '',
      b(r.inputRequested), '',
      b(r.mustBePassing), '',
      b(r.failingRequiresResolution), '',
      b(r.requestDocument), '',
      b(r.oneAtATime), '',
      b(r.drivesCoupons), '',
      r.descriptionMarkdown || '', '',
      b(r.isDefault), r.derivedFromId ?? '', r.specFieldSpecId ?? '',
      r.unitId ?? '', r.sampleSetId ?? '', r.classificationSetId ?? '',
      r.labels || '', r.esMP || ''
    ];
  }

  function buildAndDownloadXlsx(rows) {
    if (!window.XLSX) {
      alert('XLSX (SheetJS) no cargado. Recarga la extensión.');
      throw new Error('XLSX no cargado');
    }
    const wb = window.XLSX.utils.book_new();
    const now = new Date().toISOString().slice(0, 10);
    const title = `Plantilla Spec Params · ${rows.length} params · ${now}`;

    // Hoja Params
    const aoa = [
      [title],
      XLSX_HEADERS,
      ...rows.map(rowToAOA)
    ];
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: XLSX_HEADERS.length - 1 } }];
    ws['!autofilter'] = { ref: `A2:${window.XLSX.utils.encode_col(XLSX_HEADERS.length - 1)}2` };
    // Anchos razonables
    ws['!cols'] = XLSX_HEADERS.map(h => ({ wch: h.length >= 24 ? 22 : Math.max(10, h.length + 2) }));
    window.XLSX.utils.book_append_sheet(wb, ws, 'Params');

    // Hoja Leyenda
    const leyenda = buildLeyendaRows();
    const leyHeaders = ['Columna', 'Descripción', 'Editable', 'Tipo', 'Ejemplo'];
    const leyAoa = [
      ['Leyenda — qué editar y cómo'],
      leyHeaders,
      ...leyenda.map(r => leyHeaders.map(h => r[h] ?? ''))
    ];
    const wsLey = window.XLSX.utils.aoa_to_sheet(leyAoa);
    wsLey['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: leyHeaders.length - 1 } }];
    wsLey['!cols'] = [{ wch: 28 }, { wch: 60 }, { wch: 10 }, { wch: 14 }, { wch: 24 }];
    window.XLSX.utils.book_append_sheet(wb, wsLey, 'Leyenda');

    // Append reglas como aoa al final de Leyenda
    const reglas = [
      [],
      ['Reglas de uso'],
      ['1. Editar SOLO las columnas con sufijo _NUEVO. Las demás son contexto/lookup.'],
      ['2. _NUEVO vacío → conserva el valor actual de esa columna.'],
      ['3. Booleans: TRUE / FALSE (mayúsculas). Cualquier otra cosa se trata como FALSE.'],
      ['4. Numéricos nulos: deja la celda vacía (no escribas "null").'],
      ['5. Filas con ParamID vacío o desconocido se ignoran al cargar.'],
      ['6. NO agregar filas nuevas — esta plantilla solo edita params existentes.'],
      ['7. Para descartar cambios en una fila, borra todos sus _NUEVO.']
    ];
    window.XLSX.utils.sheet_add_aoa(wsLey, reglas, { origin: -1 });

    const wbOut = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spec-params-${now}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log(`XLSX descargado: ${rows.length} params`);
  }

  function buildLeyendaRows() {
    const num = 'Numérico (minutos / cantidad)';
    const bool = 'Boolean (TRUE/FALSE)';
    const str = 'Texto';
    return [
      { Columna: 'SpecType', Descripción: 'INTERNAL o EXTERNAL', Editable: 'NO', Tipo: 'Lookup', Ejemplo: 'INTERNAL' },
      { Columna: 'SpecID', Descripción: 'ID interno de la spec', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '20697' },
      { Columna: 'SpecIdInDomain', Descripción: 'Número de spec visible en UI', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '341' },
      { Columna: 'SpecName', Descripción: 'Nombre de la spec', Editable: 'NO', Tipo: 'Lookup', Ejemplo: 'T104-LI (6)' },
      { Columna: 'SpecRev', Descripción: 'Revisión activa más reciente', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '1' },
      { Columna: 'FieldID', Descripción: 'ID del SpecField', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '26749' },
      { Columna: 'FieldName', Descripción: 'Nombre del field', Editable: 'NO', Tipo: 'Lookup', Ejemplo: 'Concentración' },
      { Columna: 'FieldType', Descripción: 'SENSOR / TIMER / etc.', Editable: 'NO', Tipo: 'Lookup', Ejemplo: 'SENSOR' },
      { Columna: 'ParamID', Descripción: 'ID del SpecParam (NO TOCAR — clave del match)', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '19938651' },
      { Columna: 'ParamName / ParamName_NUEVO', Descripción: 'Nombre del param mostrado en UI', Editable: 'SÍ', Tipo: str, Ejemplo: '20 - 62 g/L' },
      { Columna: 'Min / Min_NUEVO', Descripción: 'Valor mínimo aceptable', Editable: 'SÍ', Tipo: num, Ejemplo: '20' },
      { Columna: 'Max / Max_NUEVO', Descripción: 'Valor máximo aceptable', Editable: 'SÍ', Tipo: num, Ejemplo: '62' },
      { Columna: 'Target / Target_NUEVO', Descripción: 'Valor target', Editable: 'SÍ', Tipo: num, Ejemplo: '' },
      { Columna: 'SampleCount / *_NUEVO', Descripción: 'Cantidad de muestras requeridas', Editable: 'SÍ', Tipo: num, Ejemplo: '1' },
      { Columna: 'SamplingIntervalMin / *_NUEVO', Descripción: 'Intervalo entre muestras (min)', Editable: 'SÍ', Tipo: num, Ejemplo: '' },
      { Columna: 'SensorValidDurationMin / *_NUEVO', Descripción: 'Vigencia del sensor (min). 1440=24h, 5760=4 días', Editable: 'SÍ', Tipo: num, Ejemplo: '5760' },
      { Columna: 'SensorWarningThresholdMin / *_NUEVO', Descripción: 'Umbral de advertencia previo al vencimiento (min)', Editable: 'SÍ', Tipo: num, Ejemplo: '5700' },
      { Columna: 'InputRequired / *_NUEVO', Descripción: 'Input obligatorio', Editable: 'SÍ', Tipo: bool, Ejemplo: 'FALSE' },
      { Columna: 'InputRequested / *_NUEVO', Descripción: 'Input solicitado (no obligatorio)', Editable: 'SÍ', Tipo: bool, Ejemplo: 'TRUE' },
      { Columna: 'MustBePassing / *_NUEVO', Descripción: 'Debe estar pasando para avanzar', Editable: 'SÍ', Tipo: bool, Ejemplo: 'FALSE' },
      { Columna: 'FailingRequiresResolution / *_NUEVO', Descripción: 'Si falla, requiere resolución antes de avanzar', Editable: 'SÍ', Tipo: bool, Ejemplo: 'TRUE' },
      { Columna: 'RequestDocument / *_NUEVO', Descripción: 'Pedir documento adjunto al capturar', Editable: 'SÍ', Tipo: bool, Ejemplo: 'FALSE' },
      { Columna: 'OneAtATime / *_NUEVO', Descripción: 'Capturar de a una pieza', Editable: 'SÍ', Tipo: bool, Ejemplo: 'FALSE' },
      { Columna: 'DrivesCoupons / *_NUEVO', Descripción: 'Dispara cupones de muestreo', Editable: 'SÍ', Tipo: bool, Ejemplo: 'FALSE' },
      { Columna: 'DescriptionMarkdown / *_NUEVO', Descripción: 'Descripción en formato markdown', Editable: 'SÍ', Tipo: str, Ejemplo: '' },
      { Columna: 'IsDefault', Descripción: 'Indica si este param es el default del field', Editable: 'NO', Tipo: bool, Ejemplo: 'TRUE' },
      { Columna: 'DerivedFromID', Descripción: 'ID del param padre (si fue derivado)', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '' },
      { Columna: 'SpecFieldSpecID', Descripción: 'FK al SpecFieldSpec (clave para la mutación)', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '173321' },
      { Columna: 'UnitID', Descripción: 'Unidad asociada', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '' },
      { Columna: 'SampleSetID', Descripción: 'Set de muestras asociado', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '' },
      { Columna: 'ClassificationSetID', Descripción: 'Set de clasificación asociado', Editable: 'NO', Tipo: 'Lookup', Ejemplo: '' },
      { Columna: 'Labels', Descripción: 'Etiquetas de la spec (separadas por ; )', Editable: 'NO', Tipo: 'Lookup', Ejemplo: 'MP; Materia Prima' },
      { Columna: 'EsMP', Descripción: 'TRUE si la spec es de Materia Prima', Editable: 'NO', Tipo: bool, Ejemplo: 'FALSE' }
    ];
  }

  // ════════════════════════════════════════════════════════
  //  UPLOAD FLOW
  // ════════════════════════════════════════════════════════

  async function runUpload() {
    const myRunId = nextRunId();
    ensurePanel('Cargar Spec Params editado (XLSX)');
    setBody(`<div style="padding:8px 0">
      Selecciona el XLSX exportado y editado.<br>
      <span style="font-size:11px;color:#9ca3af">El applet solo lee filas con ParamID válido y aplica diffs de columnas *_NUEVO.</span>
    </div>
    <input type="file" data-ctrl="file" accept=".xlsx,.xls"
      style="margin-top:6px;color:#e5e7eb;background:#0f172a;padding:6px;border:1px solid #334155;border-radius:4px;font-size:12px;width:100%">
    `);
    setFooter(`<button class="spb-btn spb-btn-ghost" data-act="cancel">Cancelar</button>`);
    state.panelEl.querySelector('[data-act=cancel]')?.addEventListener('click', () => closePanel());
    state.panelEl.querySelector('[data-ctrl=file]')?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        await handleUploadFile(f, myRunId);
      } catch (err) {
        if (err?.message === 'Run cancelado') return;
        setBody(`<div class="spb-error">${escHtml(err.message)}</div>`);
        setFooter(`<button class="spb-btn" data-act="close-err">Cerrar</button>`);
        state.panelEl.querySelector('[data-act=close-err]')?.addEventListener('click', () => closePanel());
      }
    });
  }

  async function handleUploadFile(file, myRunId) {
    setBody(`<div class="spb-progress">Leyendo XLSX…</div>`);
    setFooter('');
    if (!window.XLSX) throw new Error('XLSX (SheetJS) no cargado');

    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: 'array' });
    // Buscar hoja "Params" — si no, primera hoja
    const sheetName = wb.SheetNames.includes('Params') ? 'Params' : wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) throw new Error(`El XLSX no tiene la hoja "${sheetName}"`);

    // Leer como AOA con header en row 2 (row 1 es título mergeado)
    const aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!aoa.length) throw new Error('La hoja está vacía');

    // Detectar fila de headers: la primera que contenga "ParamID"
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(aoa.length, 5); i++) {
      if (aoa[i].some(c => String(c).trim() === 'ParamID')) { headerRowIdx = i; break; }
    }
    if (headerRowIdx < 0) throw new Error('No se encontró la fila de headers con ParamID');

    const headers = aoa[headerRowIdx].map(h => String(h).trim());
    const dataRows = aoa.slice(headerRowIdx + 1).filter(r => r.some(c => c !== '' && c != null));
    log(`XLSX leído: ${dataRows.length} filas, ${headers.length} columnas`);

    // Convertir a objetos { header → value }
    const parsedRows = dataRows.map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });

    bailIfStale(myRunId);
    setBody(`<div class="spb-progress">
      Fetcheando shape actual de ${parsedRows.length} params…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="spb-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    setFooter(`<button class="spb-btn spb-btn-danger" data-act="cancel">Cancelar</button>`);
    state.panelEl.querySelector('[data-act=cancel]')?.addEventListener('click', () => {
      nextRunId();
      closePanel();
    });

    const progMsg = state.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar = state.panelEl.querySelector('[data-ctrl=prog-bar]');

    // Validar y enriquecer cada fila con el shape actual del server
    const valid = [];
    const omitted = [];
    for (const r of parsedRows) {
      const pid = Number(r.ParamID);
      const sfid = Number(r.FieldID);
      if (!pid || !Number.isFinite(pid)) { omitted.push({ row: r, motivo: 'ParamID vacío' }); continue; }
      if (!sfid || !Number.isFinite(sfid)) { omitted.push({ row: r, motivo: 'FieldID vacío (no se puede consultar shape actual)' }); continue; }
      valid.push({ pid, sfid, row: r });
    }

    // Pool concurrente para fetchear shape actual
    const fetched = await runPool(valid, async (v) => {
      try {
        const shape = await withRetry(
          () => PS().getSpecFieldParamToEdit(v.pid, v.sfid),
          `GetSpecFieldParamToEdit(${v.pid})`,
          myRunId
        );
        if (!shape) return { __error: 'paramId desconocido' };
        return shape;
      } catch (e) {
        return { __error: e?.message || String(e) };
      }
    }, editConcurrency(), (done, total) => {
      if (progMsg) progMsg.textContent = `${done}/${total} fetcheados`;
      if (progBar) progBar.style.width = `${(done / total) * 100}%`;
    }, myRunId);
    bailIfStale(myRunId);

    // Construir diff
    const changes = [];
    const noChange = [];
    fetched.forEach((shape, i) => {
      const v = valid[i];
      if (!shape || shape.__error) {
        omitted.push({ row: v.row, motivo: shape?.__error || 'shape vacío' });
        return;
      }
      const currentRow = buildCurrentRowFromShape(shape, v.row);
      const updates = extractUpdates(v.row, currentRow);
      if (!updates.changes.length) {
        noChange.push({ paramId: v.pid, name: currentRow.paramName });
        return;
      }
      const inputShape = PS().paramToInputShape(currentRow, updates.values);
      changes.push({
        paramId: v.pid,
        specName: currentRow.specName,
        fieldName: currentRow.fieldName,
        paramName: currentRow.paramName,
        diff: updates.changes,
        input: inputShape
      });
    });

    log(`Diff: ${changes.length} cambios, ${noChange.length} sin cambio, ${omitted.length} omitidas`);
    renderDiffPreview(changes, noChange, omitted, myRunId);
  }

  // Reconstruye la fila "actual" desde el shape de GetSpecFieldParamToEdit.
  // Toma campos del shape + fallbacks del row del XLSX (SpecName, FieldName, etc. que no vienen en el shape).
  function buildCurrentRowFromShape(shape, xlsxRow) {
    const specFieldSpec = shape.specFieldSpecBySpecFieldSpecId || {};
    const field = shape.specFieldById || specFieldSpec.specFieldBySpecFieldId || {};
    return {
      specType: xlsxRow.SpecType || '',
      specId: xlsxRow.SpecID || null,
      specIdInDomain: xlsxRow.SpecIdInDomain || null,
      specName: xlsxRow.SpecName || '',
      specRevision: xlsxRow.SpecRev || null,
      specFieldSpecId: extractIdFromNodeId(specFieldSpec.nodeId) || Number(xlsxRow.SpecFieldSpecID) || null,
      fieldId: field.id || Number(xlsxRow.FieldID) || null,
      fieldName: field.name || xlsxRow.FieldName || '',
      fieldType: field.type || xlsxRow.FieldType || '',
      paramId: shape.id,
      paramName: shape.name || '',
      descriptionMarkdown: shape.descriptionMarkdown || '',
      minimumValue: PS().numOrNull(shape.minimumValue),
      maximumValue: PS().numOrNull(shape.maximumValue),
      targetValue: PS().numOrNull(shape.targetValue),
      sampleCount: PS().numOrNull(shape.sampleCount),
      samplingRate: PS().numOrNull(shape.samplingRate),
      samplingIntervalMinutes: PS().numOrNull(shape.samplingIntervalMinutes),
      sensorValidDurationMinutes: PS().numOrNull(shape.sensorValidDurationMinutes),
      sensorWarningThresholdMinutes: PS().numOrNull(shape.sensorWarningThresholdMinutes),
      inputRequired: !!shape.inputRequired,
      inputRequested: !!shape.inputRequested,
      mustBePassing: !!shape.mustBePassing,
      failingRequiresResolution: !!shape.failingRequiresResolution,
      requestDocument: !!shape.requestDocument,
      oneAtATime: !!shape.oneAtATime,
      drivesCoupons: !!shape.drivesCoupons,
      isDefault: !!shape.isDefault,
      derivedFromId: shape.specFieldParamByDerivedFromId?.id ?? null,
      specFieldParamDropdownId: shape.specFieldParamDropdownBySpecFieldParamDropdownId?.id ?? null,
      unitId: shape.unitByUnitId?.id ?? null,
      sampleSetId: shape.sampleSetBySampleSetId?.id ?? null,
      classificationSetId: shape.classificationSetByClassificationSetId?.id ?? null
    };
  }

  // El nodeId de Steelhead es base64 de un array tipo ["spec_field_specs", 173321].
  // Decodificarlo para extraer el id numérico es más seguro que castear el campo
  // 'SpecFieldSpecID' del XLSX (que puede haber sido editado por accidente).
  function extractIdFromNodeId(nodeId) {
    if (!nodeId) return null;
    try {
      const decoded = atob(nodeId);
      const arr = JSON.parse(decoded);
      if (Array.isArray(arr) && typeof arr[1] === 'number') return arr[1];
    } catch (_) {}
    return null;
  }

  // Mapeo header XLSX → campo del row interno.
  const XLSX_FIELD_MAP = [
    { col: 'ParamName_NUEVO', field: 'paramName', kind: 'str' },
    { col: 'Min_NUEVO', field: 'minimumValue', kind: 'num' },
    { col: 'Max_NUEVO', field: 'maximumValue', kind: 'num' },
    { col: 'Target_NUEVO', field: 'targetValue', kind: 'num' },
    { col: 'SampleCount_NUEVO', field: 'sampleCount', kind: 'num' },
    { col: 'SamplingIntervalMin_NUEVO', field: 'samplingIntervalMinutes', kind: 'num' },
    { col: 'SensorValidDurationMin_NUEVO', field: 'sensorValidDurationMinutes', kind: 'num' },
    { col: 'SensorWarningThresholdMin_NUEVO', field: 'sensorWarningThresholdMinutes', kind: 'num' },
    { col: 'InputRequired_NUEVO', field: 'inputRequired', kind: 'bool' },
    { col: 'InputRequested_NUEVO', field: 'inputRequested', kind: 'bool' },
    { col: 'MustBePassing_NUEVO', field: 'mustBePassing', kind: 'bool' },
    { col: 'FailingRequiresResolution_NUEVO', field: 'failingRequiresResolution', kind: 'bool' },
    { col: 'RequestDocument_NUEVO', field: 'requestDocument', kind: 'bool' },
    { col: 'OneAtATime_NUEVO', field: 'oneAtATime', kind: 'bool' },
    { col: 'DrivesCoupons_NUEVO', field: 'drivesCoupons', kind: 'bool' },
    { col: 'DescriptionMarkdown_NUEVO', field: 'descriptionMarkdown', kind: 'str' }
  ];

  // Compara cada columna *_NUEVO contra el valor actual; emite diff si difieren.
  function extractUpdates(xlsxRow, currentRow) {
    const changes = [];
    const values = {};
    for (const m of XLSX_FIELD_MAP) {
      const raw = xlsxRow[m.col];
      if (raw === undefined || raw === '' || raw === null) continue;
      let newVal;
      if (m.kind === 'num') {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        newVal = n;
      } else if (m.kind === 'bool') {
        newVal = PS().toBool(raw);
      } else {
        newVal = String(raw);
      }
      const oldVal = currentRow[m.field];
      if (valuesEqual(oldVal, newVal, m.kind)) continue;
      changes.push({ field: m.field, label: m.col.replace('_NUEVO', ''), oldVal, newVal });
      values[m.field] = newVal;
    }
    return { changes, values };
  }

  function valuesEqual(a, b, kind) {
    if (kind === 'bool') return !!a === !!b;
    if (kind === 'num') {
      if (a == null && b == null) return true;
      if (a == null || b == null) return false;
      return Number(a) === Number(b);
    }
    return (a ?? '') === (b ?? '');
  }

  function renderDiffPreview(changes, noChange, omitted, parentRunId) {
    void parentRunId;
    const myRunId = state.runId; // sigue el mismo run
    setBody(`
      <div style="margin-bottom:8px">
        <strong style="color:#6ee7b7">${changes.length}</strong> cambios ·
        <strong style="color:#9ca3af">${noChange.length}</strong> sin cambio ·
        <strong style="color:#fca5a5">${omitted.length}</strong> omitidas
      </div>
      <div class="spb-tab-hdr">
        <div class="spb-tab active" data-tab="cambios">Cambios (${changes.length})</div>
        <div class="spb-tab" data-tab="sin">Sin cambio (${noChange.length})</div>
        <div class="spb-tab" data-tab="omit">Omitidas (${omitted.length})</div>
      </div>
      <div data-tab-body="cambios">${renderChangesTable(changes)}</div>
      <div data-tab-body="sin" style="display:none">${renderNoChangeTable(noChange)}</div>
      <div data-tab-body="omit" style="display:none">${renderOmittedTable(omitted)}</div>
    `);
    setFooter(`
      <span class="spb-counter">Batches de ${batchSize()} · retry ${retryDelays().join('/')} ms</span>
      <div style="display:flex;gap:6px">
        <button class="spb-btn spb-btn-ghost" data-act="cancel">Cancelar</button>
        <button class="spb-btn" data-act="confirm" ${changes.length === 0 ? 'disabled' : ''}>
          Aplicar ${changes.length} cambios
        </button>
      </div>
    `);
    const root = state.panelEl;
    root.querySelectorAll('.spb-tab').forEach(t => {
      t.addEventListener('click', () => {
        root.querySelectorAll('.spb-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        root.querySelectorAll('[data-tab-body]').forEach(b => {
          b.style.display = b.dataset.tabBody === t.dataset.tab ? '' : 'none';
        });
      });
    });
    root.querySelector('[data-act=cancel]').addEventListener('click', () => closePanel());
    root.querySelector('[data-act=confirm]').addEventListener('click', async () => {
      if (!changes.length) return;
      await applyMutations(changes, omitted, myRunId);
    });
  }

  function renderChangesTable(changes) {
    if (!changes.length) return '<div style="color:#9ca3af;font-size:12px">Sin cambios para aplicar.</div>';
    const max = 200;
    const slice = changes.slice(0, max);
    const rows = slice.map(c => {
      const diff = c.diff.map(d =>
        `<div style="font-size:11px;line-height:1.4">
          ${escHtml(d.label)}: <span class="spb-diff-old">${escHtml(fmtVal(d.oldVal))}</span>
          → <span class="spb-diff-new">${escHtml(fmtVal(d.newVal))}</span>
        </div>`
      ).join('');
      return `<tr>
        <td>${c.paramId}</td>
        <td>${escHtml(c.specName)}</td>
        <td>${escHtml(c.fieldName)}</td>
        <td>${escHtml(c.paramName)}</td>
        <td>${diff}</td>
      </tr>`;
    }).join('');
    const overflow = changes.length > max
      ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px">Mostrando ${max} de ${changes.length}. Todos se aplicarán al confirmar.</div>`
      : '';
    return `<table>
      <thead><tr><th>ParamID</th><th>Spec</th><th>Field</th><th>Param</th><th>Diff</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${overflow}`;
  }

  function renderNoChangeTable(rows) {
    if (!rows.length) return '<div style="color:#9ca3af;font-size:12px">—</div>';
    const max = 200;
    const slice = rows.slice(0, max);
    return `<table>
      <thead><tr><th>ParamID</th><th>Nombre</th></tr></thead>
      <tbody>${slice.map(r => `<tr><td>${r.paramId}</td><td>${escHtml(r.name)}</td></tr>`).join('')}</tbody>
    </table>${rows.length > max ? `<div style="font-size:11px;color:#9ca3af">${rows.length - max} más…</div>` : ''}`;
  }

  function renderOmittedTable(rows) {
    if (!rows.length) return '<div style="color:#9ca3af;font-size:12px">—</div>';
    const max = 200;
    const slice = rows.slice(0, max);
    return `<table>
      <thead><tr><th>ParamID</th><th>SpecName</th><th>Motivo</th></tr></thead>
      <tbody>${slice.map(r => `<tr>
        <td>${escHtml(r.row.ParamID ?? '')}</td>
        <td>${escHtml(r.row.SpecName ?? '')}</td>
        <td>${escHtml(r.motivo)}</td>
      </tr>`).join('')}</tbody>
    </table>${rows.length > max ? `<div style="font-size:11px;color:#9ca3af">${rows.length - max} más…</div>` : ''}`;
  }

  function fmtVal(v) {
    if (v == null || v === '') return '∅';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  async function applyMutations(changes, omitted, myRunId) {
    setBody(`<div class="spb-progress">
      Aplicando ${changes.length} cambios en batches de ${batchSize()}…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="spb-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    setFooter(`<button class="spb-btn spb-btn-danger" data-act="cancel">Cancelar</button>`);
    state.panelEl.querySelector('[data-act=cancel]')?.addEventListener('click', () => {
      nextRunId();
      closePanel();
    });
    const progMsg = state.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar = state.panelEl.querySelector('[data-ctrl=prog-bar]');

    const applied = [];
    const errors = [];
    const bsz = batchSize();
    const totalBatches = Math.ceil(changes.length / bsz);

    for (let bi = 0; bi < totalBatches; bi++) {
      if (isStale(myRunId)) break;
      const batch = changes.slice(bi * bsz, (bi + 1) * bsz);
      const inputs = batch.map(c => c.input);
      if (progMsg) progMsg.textContent = `Batch ${bi + 1}/${totalBatches} (${batch.length} params)…`;
      try {
        await withRetry(
          () => api().query('SaveMultipleSpecFieldParams', { input: { specFieldParams: inputs } }),
          `SaveMultipleSpecFieldParams batch ${bi + 1}`,
          myRunId
        );
        batch.forEach(c => applied.push({ paramId: c.paramId, specName: c.specName, paramName: c.paramName, diff: c.diff }));
        log(`Batch ${bi + 1}/${totalBatches} OK (${batch.length} params)`);
      } catch (e) {
        if (e?.message === 'Run cancelado') break;
        warn(`Batch ${bi + 1}/${totalBatches} ERROR: ${e?.message || e}`);
        batch.forEach(c => errors.push({ paramId: c.paramId, specName: c.specName, paramName: c.paramName, error: e?.message || String(e) }));
      }
      if (progBar) progBar.style.width = `${((bi + 1) / totalBatches) * 100}%`;
    }

    const cancelled = isStale(myRunId);
    log(`Aplicación terminada: ${applied.length} OK, ${errors.length} errores${cancelled ? ' (CANCELADO)' : ''}`);

    // Construir bitácora XLSX
    buildAndDownloadResultXlsx(applied, errors, omitted, cancelled);

    setBody(`
      <div class="${errors.length ? 'spb-error' : 'spb-success'}">
        ${cancelled ? '[CANCELADO PARCIAL] ' : ''}
        Aplicados: ${applied.length} · Errores: ${errors.length} · Omitidas: ${omitted.length}
      </div>
      <div style="margin-top:8px;font-size:12px;color:#9ca3af">Bitácora descargada como XLSX.</div>
    `);
    setFooter(`<button class="spb-btn" data-act="close">Cerrar</button>`);
    state.panelEl.querySelector('[data-act=close]')?.addEventListener('click', () => closePanel());
  }

  function buildAndDownloadResultXlsx(applied, errors, omitted, cancelled) {
    if (!window.XLSX) return;
    const wb = window.XLSX.utils.book_new();
    const now = new Date().toISOString().slice(0, 10);
    const titleSuffix = cancelled ? ' · CANCELADO_PARCIAL' : '';

    const aplicadasRows = applied.map(a => ({
      ParamID: a.paramId,
      SpecName: a.specName,
      ParamName: a.paramName,
      Diff: a.diff.map(d => `${d.label}: ${fmtVal(d.oldVal)} → ${fmtVal(d.newVal)}`).join(' | ')
    }));
    addSheetGeneric(wb, 'Aplicadas', `Aplicadas · ${applied.length} params · ${now}${titleSuffix}`, aplicadasRows,
      ['ParamID', 'SpecName', 'ParamName', 'Diff']);

    const erroresRows = errors.map(e => ({
      ParamID: e.paramId, SpecName: e.specName, ParamName: e.paramName, Error: e.error
    }));
    addSheetGeneric(wb, 'Errores', `Errores · ${errors.length} params · ${now}`, erroresRows,
      ['ParamID', 'SpecName', 'ParamName', 'Error']);

    const omitidasRows = omitted.map(o => ({
      ParamID: o.row?.ParamID ?? '', SpecName: o.row?.SpecName ?? '', Motivo: o.motivo
    }));
    addSheetGeneric(wb, 'Omitidas', `Omitidas · ${omitted.length} filas · ${now}`, omitidasRows,
      ['ParamID', 'SpecName', 'Motivo']);

    const wbOut = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spec-params-bitacora-${now}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function addSheetGeneric(wb, name, title, rows, headers) {
    const data = rows.length
      ? rows.map(r => headers.map(h => r[h] ?? ''))
      : [headers.map(() => '')];
    const aoa = [[title], headers, ...data];
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
    window.XLSX.utils.book_append_sheet(wb, ws, name);
  }

  // ════════════════════════════════════════════════════════
  //  DUPLICATE-PARAMS VALIDATOR
  //  Detecta PNs con >1 param activo por (Spec, SpecField), permite elegir
  //  cuál conservar y archivar el resto vía UpdatePartNumberSpecParam.
  // ════════════════════════════════════════════════════════

  // Estado del validador
  const dupState = {
    customerFilter: '',
    specFilter: '',
    groups: [],            // [{ key, pnId, pnName, customer, specName, specIdInDomain, fieldName, fieldId, partNumberSpecId, params: [{id,name,sfpId,sfpName,processNodeId,isWinner,...}] }]
    decisions: new Map(),  // key → { winnerParamRowId, ignored: bool }
  };

  async function runDuplicateParamsValidator() {
    const myRunId = nextRunId();
    ensurePanel('Validar params duplicados por SpecField');
    state.panelEl?.classList.add('spb-wide');

    dupState.customerFilter = '';
    dupState.specFilter = '';
    dupState.groups = [];
    dupState.decisions = new Map();

    renderDupFilterPanel(myRunId);
  }

  function renderDupFilterPanel(myRunId) {
    setBody(`
      <div style="font-size:12px;color:#cbd5e1;margin-bottom:8px">
        Escanea PNs activos y detecta &gt;1 param activo por (Spec, SpecField).
        Puedes filtrar por cliente, spec, ambos o ninguno (vacío = todos los PNs activos).
      </div>
      <div class="spb-filter-row">
        <label style="flex:1">Cliente (contiene):
          <input type="text" data-ctrl="dup-cust" placeholder="Ej. JABIL — vacío = todos" autocomplete="off">
        </label>
      </div>
      <div class="spb-filter-row">
        <label style="flex:1">Spec (nombre contiene):
          <input type="text" data-ctrl="dup-spec" placeholder="Ej. NIQUEL — vacío = todas" autocomplete="off">
        </label>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:6px">
        Aviso: escanear sin filtros revisa todos los PNs activos (puede tardar varios minutos).
      </div>
    `);
    setFooter(`
      <span class="spb-counter">Listo</span>
      <div style="display:flex;gap:6px">
        <button class="spb-btn spb-btn-ghost" data-act="dup-cancel">Cerrar</button>
        <button class="spb-btn" data-act="dup-start">Escanear</button>
      </div>
    `);
    state.panelEl.querySelector('[data-act=dup-cancel]')?.addEventListener('click', () => closePanel());
    state.panelEl.querySelector('[data-act=dup-start]')?.addEventListener('click', async () => {
      dupState.customerFilter = state.panelEl.querySelector('[data-ctrl=dup-cust]')?.value?.trim() || '';
      dupState.specFilter = state.panelEl.querySelector('[data-ctrl=dup-spec]')?.value?.trim() || '';
      try {
        await runDupScan(myRunId);
      } catch (e) {
        if (e?.message === 'Run cancelado') return;
        setBody(`<div class="spb-error">Error en escaneo: ${escHtml(e.message)}</div>`);
        setFooter(`<button class="spb-btn" data-act="dup-close-err">Cerrar</button>`);
        state.panelEl.querySelector('[data-act=dup-close-err]')?.addEventListener('click', () => closePanel());
      }
    });
  }

  async function runDupScan(myRunId) {
    setBody(`<div class="spb-progress">
      Fase 1/2: cargando PNs…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="spb-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    setFooter(`<button class="spb-btn spb-btn-danger" data-act="dup-cancel-run">Cancelar</button>`);
    state.panelEl.querySelector('[data-act=dup-cancel-run]')?.addEventListener('click', () => {
      nextRunId();
      closePanel();
    });
    const progMsg = state.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar = state.panelEl.querySelector('[data-ctrl=prog-bar]');

    // ── Fase 1: AllPartNumbers paginado, filtro cliente cliente-side
    const allPNs = [];
    let offset = 0;
    const PAGE = 500;
    const custFilter = dupState.customerFilter.toUpperCase();
    while (true) {
      bailIfStale(myRunId);
      const data = await withRetry(
        () => api().query('AllPartNumbers',
          { orderBy: ['NAME_ASC'], offset, first: PAGE, searchQuery: '' },
          'AllPartNumbers'),
        `AllPartNumbers offset=${offset}`, myRunId
      );
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (n.archivedAt) continue;
        if (custFilter && !(n.customerByCustomerId?.name || '').toUpperCase().includes(custFilter)) continue;
        allPNs.push(n);
      }
      if (progMsg) progMsg.textContent = `${allPNs.length} PNs cargados (offset ${offset})`;
      if (nodes.length < PAGE) break;
      offset += PAGE;
    }

    if (!allPNs.length) {
      setBody(`<div class="spb-error">No se encontraron PNs activos${dupState.customerFilter ? ` para cliente "${escHtml(dupState.customerFilter)}"` : ''}.</div>`);
      setFooter(`<button class="spb-btn" data-act="dup-close-empty">Cerrar</button>`);
      state.panelEl.querySelector('[data-act=dup-close-empty]')?.addEventListener('click', () => closePanel());
      return;
    }

    log(`[SPB-dup] Fase 1 OK: ${allPNs.length} PNs activos${custFilter ? ` (cliente ${dupState.customerFilter})` : ''}`);

    // ── Fase 2: GetPartNumber con runPool 6, detectar grupos
    setBody(`<div class="spb-progress">
      Fase 2/2: revisando ${allPNs.length} PNs (concurrencia 6)…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="spb-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    const progMsg2 = state.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar2 = state.panelEl.querySelector('[data-ctrl=prog-bar]');

    const specFilterLow = dupState.specFilter.toLowerCase();
    const groups = [];
    const fetchErrors = [];

    await runPool(allPNs, async (pn) => {
      let detail = null;
      try {
        const data = await withRetry(
          () => api().query('GetPartNumber', { partNumberId: pn.id, usagesLimit: 0, usagesOffset: 0 }),
          `GetPartNumber ${pn.id}`, myRunId
        );
        detail = data?.partNumberById;
      } catch (e) {
        fetchErrors.push({ pnId: pn.id, pnName: pn.name, error: e?.message || String(e) });
        return;
      }
      if (!detail) return;

      const pnSpecs = detail.partNumberSpecsByPartNumberId?.nodes || [];
      const allParams = detail.partNumberSpecFieldParamsByPartNumberId?.nodes || [];

      // Lookup: partNumberSpecId → { specId, specName, specIdInDomain }
      const psMap = new Map();
      for (const ps of pnSpecs) {
        if (ps.archivedAt) continue;
        const sp = ps.specBySpecId || {};
        psMap.set(ps.id, {
          specId: sp.id,
          specName: sp.name || '',
          specIdInDomain: sp.idInDomain || ps.id,
        });
      }

      // Si hay filtro de spec, descartar PN si ninguna spec activa matchea
      if (specFilterLow) {
        const anyMatch = [...psMap.values()].some(s => (s.specName || '').toLowerCase().includes(specFilterLow));
        if (!anyMatch) return;
      }

      // Agrupar params activos por (partNumberSpecId, specFieldId)
      const buckets = new Map();
      for (const p of allParams) {
        if (p.archivedAt) continue;
        if (!p.specFieldParamBySpecFieldParamId) continue;
        const psId = p.partNumberSpecId;
        const sfId = p.specFieldId;
        if (!psId || !sfId) continue;
        // Solo grupos pertenecientes a una spec ACTIVA del PN
        if (!psMap.has(psId)) continue;
        const key = `${psId}|${sfId}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(p);
      }

      // Filtrar buckets con >1, además respetar filtro de spec en grupo
      for (const [key, params] of buckets) {
        if (params.length < 2) continue;
        const [psIdStr, sfIdStr] = key.split('|');
        const psInfo = psMap.get(Number(psIdStr));
        if (specFilterLow && !(psInfo.specName || '').toLowerCase().includes(specFilterLow)) continue;

        // Resolver nombre del SpecField vía el primer spec match en pnSpecs
        let fieldName = '';
        for (const ps of pnSpecs) {
          if (ps.id !== Number(psIdStr)) continue;
          const sfs = ps.specBySpecId?.specFieldSpecsBySpecId?.nodes || [];
          const f = sfs.find(sf => sf.specFieldBySpecFieldId?.id === Number(sfIdStr));
          if (f) { fieldName = f.specFieldBySpecFieldId?.name || ''; break; }
        }

        // Ordenar params por id desc (winner default = mayor id = más reciente)
        const sorted = [...params].sort((a, b) => Number(b.id) - Number(a.id));
        const winnerRowId = sorted[0].id;

        groups.push({
          key: `${pn.id}-${key}`,
          pnId: pn.id,
          pnName: pn.name || '',
          customer: pn.customerByCustomerId?.name || '',
          partNumberSpecId: Number(psIdStr),
          specName: psInfo.specName,
          specIdInDomain: psInfo.specIdInDomain,
          fieldId: Number(sfIdStr),
          fieldName,
          params: sorted.map(p => ({
            rowId: p.id,
            sfpId: p.specFieldParamBySpecFieldParamId?.id ?? null,
            sfpName: p.specFieldParamBySpecFieldParamId?.name || '(sin nombre)',
            processNodeId: p.processNodeId || null,
          })),
        });

        dupState.decisions.set(`${pn.id}-${key}`, {
          winnerRowId,
          ignored: false,
        });
      }
    }, 6, (done, total) => {
      if (progMsg2) progMsg2.textContent = `${done}/${total} PNs revisados — ${groups.length} grupos duplicados`;
      if (progBar2) progBar2.style.width = `${(done / total) * 100}%`;
    }, myRunId);

    bailIfStale(myRunId);
    dupState.groups = groups;

    log(`[SPB-dup] Fase 2 OK: ${groups.length} grupos duplicados en ${new Set(groups.map(g => g.pnId)).size} PNs (${fetchErrors.length} errores de fetch)`);

    if (!groups.length) {
      setBody(`<div class="spb-success">
        ✓ Sin duplicados detectados en ${allPNs.length} PNs revisados.
        ${fetchErrors.length ? `<br><span style="color:#fbbf24">⚠ ${fetchErrors.length} PNs no pudieron consultarse</span>` : ''}
      </div>`);
      setFooter(`<button class="spb-btn" data-act="dup-close-ok">Cerrar</button>`);
      state.panelEl.querySelector('[data-act=dup-close-ok]')?.addEventListener('click', () => closePanel());
      return;
    }

    renderDupTable(myRunId, allPNs.length, fetchErrors);
  }

  function renderDupTable(myRunId, scannedCount, fetchErrors) {
    const groups = dupState.groups;
    const uniquePNs = new Set(groups.map(g => g.pnId)).size;
    const totalParams = groups.reduce((s, g) => s + g.params.length, 0);
    const losersCount = groups.reduce((s, g) => s + (g.params.length - 1), 0);

    // Construir DOM (textContent, sin innerHTML para datos)
    const body = state.panelEl.querySelector('.spb-body');
    body.innerHTML = '';

    // Stats bar
    const stats = document.createElement('div');
    stats.className = 'spb-dup-stats';
    const mk = (lbl, val) => {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = String(val);
      span.appendChild(document.createTextNode(`${lbl}: `));
      span.appendChild(b);
      return span;
    };
    stats.appendChild(mk('PNs revisados', scannedCount));
    stats.appendChild(mk('PNs con duplicados', uniquePNs));
    stats.appendChild(mk('Grupos', groups.length));
    stats.appendChild(mk('Params a archivar', losersCount));
    if (fetchErrors.length) stats.appendChild(mk('Errores fetch', fetchErrors.length));
    body.appendChild(stats);

    // Tabla
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-height:55vh;overflow-y:auto;border:1px solid #374151;border-radius:6px';
    const table = document.createElement('table');
    table.className = 'spb-dup-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['PN', 'Cliente', 'Spec', 'SpecField', 'Params (conservar)', 'Ignorar'].forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const g of groups) {
      const tr = document.createElement('tr');
      tr.dataset.key = g.key;

      const tdPn = document.createElement('td');
      const pname = document.createElement('div');
      pname.className = 'pname';
      pname.textContent = g.pnName;
      const pmeta = document.createElement('div');
      pmeta.className = 'pmeta';
      pmeta.textContent = `#${g.pnId}`;
      tdPn.appendChild(pname);
      tdPn.appendChild(pmeta);
      tr.appendChild(tdPn);

      const tdCust = document.createElement('td');
      tdCust.textContent = g.customer;
      tr.appendChild(tdCust);

      const tdSpec = document.createElement('td');
      tdSpec.textContent = g.specName || `(spec ${g.specIdInDomain})`;
      tr.appendChild(tdSpec);

      const tdField = document.createElement('td');
      tdField.textContent = g.fieldName || `(field ${g.fieldId})`;
      tr.appendChild(tdField);

      const tdParams = document.createElement('td');
      const initialWinner = dupState.decisions.get(g.key)?.winnerRowId;
      g.params.forEach((p, idx) => {
        const lbl = document.createElement('label');
        lbl.className = 'spb-radio-row';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `dup-${g.key}`;
        radio.value = String(p.rowId);
        if (p.rowId === initialWinner) radio.checked = true;
        radio.addEventListener('change', () => {
          const dec = dupState.decisions.get(g.key) || {};
          dec.winnerRowId = p.rowId;
          dupState.decisions.set(g.key, dec);
          refreshRadioStyles(tr, g);
          updateDupFooter();
        });
        lbl.appendChild(radio);
        const txt = document.createElement('span');
        txt.textContent = p.sfpName;
        lbl.appendChild(txt);
        const mini = document.createElement('span');
        mini.className = 'spb-mini';
        mini.textContent = `row#${p.rowId} · sfp#${p.sfpId}${p.processNodeId ? ` · pn#${p.processNodeId}` : ' · sin proceso'}${idx === 0 ? ' · más reciente' : ''}`;
        lbl.appendChild(mini);
        tdParams.appendChild(lbl);
      });
      tr.appendChild(tdParams);

      const tdIgn = document.createElement('td');
      tdIgn.style.textAlign = 'center';
      const ignCb = document.createElement('input');
      ignCb.type = 'checkbox';
      ignCb.addEventListener('change', () => {
        const dec = dupState.decisions.get(g.key) || {};
        dec.ignored = ignCb.checked;
        dupState.decisions.set(g.key, dec);
        tr.classList.toggle('ignored', ignCb.checked);
        updateDupFooter();
      });
      tdIgn.appendChild(ignCb);
      tr.appendChild(tdIgn);

      refreshRadioStyles(tr, g);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    // Footer
    setFooter(`
      <span class="spb-counter" data-ctrl="dup-foot-stats"></span>
      <div style="display:flex;gap:6px">
        <button class="spb-btn spb-btn-ghost" data-act="dup-back">← Filtros</button>
        <button class="spb-btn spb-btn-ghost" data-act="dup-download-bit">Descargar XLSX</button>
        <button class="spb-btn spb-btn-danger" data-act="dup-apply">Aplicar fix</button>
      </div>
    `);
    state.panelEl.querySelector('[data-act=dup-back]')?.addEventListener('click', () => {
      nextRunId();
      runDuplicateParamsValidator();
    });
    state.panelEl.querySelector('[data-act=dup-download-bit]')?.addEventListener('click', () => {
      buildAndDownloadDupBitacora('preview', null);
    });
    state.panelEl.querySelector('[data-act=dup-apply]')?.addEventListener('click', async () => {
      if (!confirm('Esto archivará los params no seleccionados (reversible vía UpdatePartNumberSpecParam con archivedAt:null). ¿Continuar?')) return;
      await runDupApply(myRunId);
    });
    updateDupFooter();
  }

  function refreshRadioStyles(tr, g) {
    const winnerRowId = dupState.decisions.get(g.key)?.winnerRowId;
    tr.querySelectorAll('.spb-radio-row').forEach((lbl) => {
      const rb = lbl.querySelector('input[type=radio]');
      const isWin = Number(rb.value) === Number(winnerRowId);
      lbl.classList.toggle('winner', isWin);
      lbl.classList.toggle('loser', !isWin);
    });
  }

  function updateDupFooter() {
    const ftr = state.panelEl?.querySelector('[data-ctrl=dup-foot-stats]');
    if (!ftr) return;
    let toArchive = 0, ignored = 0;
    for (const g of dupState.groups) {
      const dec = dupState.decisions.get(g.key);
      if (!dec) continue;
      if (dec.ignored) { ignored++; continue; }
      toArchive += (g.params.length - 1);
    }
    ftr.textContent = `${toArchive} params a archivar — ${ignored} grupos ignorados`;
  }

  async function runDupApply(parentRunId) {
    const myRunId = nextRunId();
    void parentRunId;

    // Construir lista de archivos a ejecutar
    const tasks = [];
    for (const g of dupState.groups) {
      const dec = dupState.decisions.get(g.key);
      if (!dec || dec.ignored) continue;
      for (const p of g.params) {
        if (p.rowId === dec.winnerRowId) continue;
        tasks.push({
          group: g,
          paramRowId: p.rowId,
          sfpName: p.sfpName,
        });
      }
    }

    if (!tasks.length) {
      alert('No hay nada que archivar (todos los grupos están ignorados o solo tienen 1 param).');
      return;
    }

    setBody(`<div class="spb-progress">
      Archivando ${tasks.length} params (concurrencia 3)…
      <div data-ctrl="prog-msg">0/${tasks.length}</div>
      <div class="spb-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    setFooter(`<button class="spb-btn spb-btn-danger" data-act="dup-stop">Cancelar</button>`);
    state.panelEl.querySelector('[data-act=dup-stop]')?.addEventListener('click', () => {
      nextRunId();
      closePanel();
    });
    const pm = state.panelEl.querySelector('[data-ctrl=prog-msg]');
    const pb = state.panelEl.querySelector('[data-ctrl=prog-bar]');

    const okRows = [];
    const errRows = [];
    let processed = 0;

    await runPool(tasks, async (t) => {
      try {
        await withRetry(
          () => api().query('UpdatePartNumberSpecParam',
            { id: t.paramRowId, archivedAt: new Date().toISOString() },
            'UpdatePartNumberSpecParam'),
          `archiveParam ${t.paramRowId}`, myRunId
        );
        okRows.push({ group: t.group, paramRowId: t.paramRowId, sfpName: t.sfpName });
      } catch (e) {
        errRows.push({ group: t.group, paramRowId: t.paramRowId, sfpName: t.sfpName, error: e?.message || String(e) });
      }
      processed++;
      if (pm) pm.textContent = `${processed}/${tasks.length} (${okRows.length} OK, ${errRows.length} err)`;
      if (pb) pb.style.width = `${(processed / tasks.length) * 100}%`;
    }, 3, null, myRunId);

    log(`[SPB-dup] Fix aplicado: ${okRows.length} OK, ${errRows.length} errores`);

    // Resumen
    const body = state.panelEl.querySelector('.spb-body');
    body.innerHTML = '';
    const sum = document.createElement('div');
    sum.className = okRows.length && !errRows.length ? 'spb-success' : 'spb-error';
    sum.textContent = `Resultado: ${okRows.length} archivados, ${errRows.length} errores. Reversible vía UpdatePartNumberSpecParam con archivedAt:null (usa los rowId del XLSX).`;
    body.appendChild(sum);

    if (errRows.length) {
      const ul = document.createElement('ul');
      ul.style.cssText = 'font-size:11px;color:#fca5a5;max-height:200px;overflow-y:auto;margin-top:8px';
      for (const r of errRows.slice(0, 50)) {
        const li = document.createElement('li');
        li.textContent = `row#${r.paramRowId} (${r.sfpName}) — ${r.error}`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    setFooter(`
      <span class="spb-counter">${okRows.length} OK · ${errRows.length} errores</span>
      <div style="display:flex;gap:6px">
        <button class="spb-btn spb-btn-ghost" data-act="dup-download-final">Descargar XLSX</button>
        <button class="spb-btn" data-act="dup-final-close">Cerrar</button>
      </div>
    `);
    state.panelEl.querySelector('[data-act=dup-download-final]')?.addEventListener('click', () => {
      buildAndDownloadDupBitacora('applied', { okRows, errRows });
    });
    state.panelEl.querySelector('[data-act=dup-final-close]')?.addEventListener('click', () => closePanel());

    // Auto-descargar bitácora al terminar
    buildAndDownloadDupBitacora('applied', { okRows, errRows });
  }

  // mode = 'preview' (sin aplicar) | 'applied' (post-fix con okRows/errRows)
  function buildAndDownloadDupBitacora(mode, applied) {
    if (!window.XLSX) {
      alert('XLSX (SheetJS) no cargado.');
      return;
    }
    const wb = window.XLSX.utils.book_new();
    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Hoja 1: Detected (todos los grupos detectados + decisión)
    const detRows = [];
    for (const g of dupState.groups) {
      const dec = dupState.decisions.get(g.key) || {};
      for (const p of g.params) {
        const isWinner = p.rowId === dec.winnerRowId;
        detRows.push({
          PNID: g.pnId,
          PNName: g.pnName,
          Cliente: g.customer,
          SpecIdInDomain: g.specIdInDomain,
          SpecName: g.specName,
          FieldID: g.fieldId,
          FieldName: g.fieldName,
          ParamRowID: p.rowId,
          SpecFieldParamID: p.sfpId,
          ParamName: p.sfpName,
          ProcessNodeID: p.processNodeId || '',
          Decisión: dec.ignored ? 'IGNORADO' : (isWinner ? 'CONSERVAR' : 'ARCHIVAR'),
        });
      }
    }
    addSheetGeneric(wb, 'Detectados', `Detectados · ${detRows.length} filas · ${now}`,
      detRows,
      ['PNID','PNName','Cliente','SpecIdInDomain','SpecName','FieldID','FieldName',
       'ParamRowID','SpecFieldParamID','ParamName','ProcessNodeID','Decisión']);

    if (mode === 'applied' && applied) {
      const okRows = (applied.okRows || []).map(r => ({
        PNID: r.group.pnId, PNName: r.group.pnName,
        SpecIdInDomain: r.group.specIdInDomain, SpecName: r.group.specName,
        FieldName: r.group.fieldName,
        ParamRowID: r.paramRowId, ParamName: r.sfpName,
      }));
      addSheetGeneric(wb, 'Aplicadas', `Archivadas OK · ${okRows.length} · ${now}`,
        okRows,
        ['PNID','PNName','SpecIdInDomain','SpecName','FieldName','ParamRowID','ParamName']);

      const errRows = (applied.errRows || []).map(r => ({
        PNID: r.group.pnId, PNName: r.group.pnName,
        SpecIdInDomain: r.group.specIdInDomain, SpecName: r.group.specName,
        FieldName: r.group.fieldName,
        ParamRowID: r.paramRowId, ParamName: r.sfpName, Error: r.error,
      }));
      addSheetGeneric(wb, 'Errores', `Errores · ${errRows.length} · ${now}`,
        errRows,
        ['PNID','PNName','SpecIdInDomain','SpecName','FieldName','ParamRowID','ParamName','Error']);
    }

    const wbOut = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dup-params-${mode}-${now}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { VERSION, runDownload, runUpload, runDuplicateParamsValidator };
})();

if (typeof window !== 'undefined') window.SpecParamsBulk = SpecParamsBulk;
