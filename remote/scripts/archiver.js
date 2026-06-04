// Steelhead Part Number Archiver
// Archives PNs based on inactivity date criteria
// Depends on: SteelheadAPI
//
// 2026-05-25 — refactor:
//   * runPool concurrencia 6 (fallback GetPartNumber) y 3 (archive UpdatePartNumber)
//   * Resume del archive loop via localStorage (sa_archiver_resume_v1)
//   * Preview limita a 500 filas en DOM (resto se ve por CSV / "mostrar todo")

const PNArchiver = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let stopped = false;
  const RESUME_KEY = 'sa_archiver_resume_v1';

  // ═══════════════════════════════════════════
  // POOL + RETRY (patrón de process-deep-audit.js)
  // ═══════════════════════════════════════════

  async function runPool(items, worker, concurrency) {
    const queue = items.slice();
    let active = 0, done = 0, idx = 0;
    return new Promise((resolve) => {
      function next() {
        if (stopped) { if (active === 0) resolve(); return; }
        while (active < concurrency && idx < queue.length) {
          const myIdx = idx++;
          const item = queue[myIdx];
          active++;
          Promise.resolve().then(() => worker(item, myIdx))
            .catch(err => { if (err?.message !== '__sa_aborted__') warn(`runPool[${myIdx}]: ${String(err?.message || err).substring(0, 120)}`); })
            .finally(() => {
              active--; done++;
              if (stopped && active === 0) { resolve(); return; }
              if (done >= queue.length && active === 0) resolve();
              else next();
            });
        }
      }
      if (!queue.length) resolve(); else next();
    });
  }

  async function withRetry(fn, label, delays = [0, 1000, 2000]) {
    let lastErr = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (stopped) throw new Error('__sa_aborted__');
      if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (attempt < delays.length - 1) warn(`${label}: intento ${attempt + 1}/${delays.length} falló · ${String(err?.message || err).substring(0, 80)}`);
      }
    }
    throw lastErr || new Error(`${label}: agotó reintentos`);
  }

  // ═══════════════════════════════════════════
  // RESUME helpers (localStorage)
  // ═══════════════════════════════════════════

  function loadResume() {
    try { const raw = localStorage.getItem(RESUME_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  function saveResume(state) {
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function clearResume() {
    try { localStorage.removeItem(RESUME_KEY); } catch (_) {}
  }

  // ═══════════════════════════════════════════
  // HELPERS PUROS DE FILTRADO (testeables)
  // ═══════════════════════════════════════════

  // Reduce un nodo pesado de AllPartNumbers a lo mínimo necesario (memoria).
  function slimPN(node) {
    const labels = (node.partNumberLabelsByPartNumberId?.nodes || [])
      .map(n => n.labelByLabelId)
      .filter(Boolean)
      .map(l => ({ id: l.id, name: l.name }));
    return {
      id: node.id,
      name: node.name,
      createdAt: node.createdAt || null,
      archivedAt: node.archivedAt || null,
      customer: node.customerByCustomerId?.name || '',
      labels,
    };
  }

  // Catálogo de etiquetas descubiertas con conteo, ordenado por nombre.
  // slimPNs: [{labels:[{id,name}]}] → [{name, count}]
  function discoverLabels(slimPNs) {
    const counts = new Map();
    for (const pn of slimPNs) {
      for (const l of pn.labels || []) {
        if (!l.name) continue;
        counts.set(l.name, (counts.get(l.name) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // ¿El PN cumple el filtro de etiquetas? mode: 'AND' | 'OR'.
  // selectedNames vacío => no filtra (true). Case-insensitive por name.
  function matchesLabels(pn, selectedNames, mode) {
    if (!selectedNames || selectedNames.length === 0) return true;
    const have = new Set((pn.labels || []).map(l => String(l.name || '').toUpperCase()));
    const want = selectedNames.map(s => String(s).toUpperCase());
    return mode === 'OR'
      ? want.some(w => have.has(w))
      : want.every(w => have.has(w));
  }

  // Aplica todos los filtros opcionales (intersección AND entre criterios).
  // filters: { selectedLabels:[name], labelMode:'AND'|'OR',
  //            dateFilter?: { cutoffISO, direction:'before'|'after' } }
  // Devuelve el subconjunto que pasa TODOS los filtros activos.
  function applyFilters(slimPNs, filters) {
    const { selectedLabels = [], labelMode = 'AND', dateFilter = null } = filters || {};
    return slimPNs.filter(pn => {
      if (!matchesLabels(pn, selectedLabels, labelMode)) return false;
      if (dateFilter && dateFilter.cutoffISO) {
        if (!pn.createdAt) return false;
        const d = new Date(pn.createdAt);
        const cut = new Date(dateFilter.cutoffISO);
        if (dateFilter.direction === 'after' ? !(d > cut) : !(d < cut)) return false;
      }
      return true;
    });
  }

  // Idempotencia: ¿el PN ya está en el estado destino para el modo dado?
  // mode 'archive': ya archivado. mode 'unarchive': ya activo.
  function isInTargetState(pn, mode) {
    return mode === 'unarchive' ? pn.archivedAt == null : pn.archivedAt != null;
  }

  // ═══════════════════════════════════════════
  // PAGINACIÓN PNs ACTIVOS
  // ═══════════════════════════════════════════

  async function fetchAllActivePNs(onProgress, pageSize = 500) {
    const allPNs = [];
    let offset = 0;
    while (!stopped) {
      const data = await api().query('AllPartNumbers', {
        orderBy: ['ID_ASC'], offset, first: pageSize, searchQuery: ''
      }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) if (!n.archivedAt) allPNs.push(n);
      if (onProgress) onProgress(`Cargando PNs... ${allPNs.length}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return allPNs;
  }

  // ═══════════════════════════════════════════
  // MAIN ARCHIVE FLOW
  // ═══════════════════════════════════════════

  async function run(options) {
    stopped = false;
    const { cutoffDate, dateType, direction = 'before', enableValidation } = options;
    const DOMAIN = api().getDomain();
    const cutoff = new Date(cutoffDate);
    const isBefore = direction === 'before';
    const compareDate = (d) => isBefore ? new Date(d) < cutoff : new Date(d) > cutoff;
    const dirLabel = isBefore ? 'antes de' : 'después de';
    const results = { found: 0, archived: 0, validated: 0, errors: [] };

    // ── Resume previo? ──
    const prevResume = loadResume();
    if (prevResume?.selectedPNs?.length) {
      const pending = prevResume.selectedPNs.filter(p => !prevResume.completed.includes(p.id));
      const resume = confirm(
        `Hay un archivado previo pendiente:\n` +
        `  ${prevResume.completed.length} ya archivados\n` +
        `  ${pending.length} pendientes\n\n` +
        `¿Reanudar? (Cancelar = empezar de cero)`
      );
      if (resume) {
        log(`Archivador: reanudando — ${pending.length} pendientes (de ${prevResume.selectedPNs.length} totales)`);
        showArchiverUI(`Reanudando archivado: ${pending.length} pendientes...`);
        return await executeArchive(prevResume.selectedPNs, prevResume.opts, prevResume.completed, results, DOMAIN);
      }
      clearResume();
    }

    log(`Archivador: ${dirLabel} ${cutoffDate}, tipo: ${dateType}, validación: ${enableValidation}`);
    showArchiverUI('Buscando números de parte activos...');

    // Fetch all active PNs
    const allPNs = await fetchAllActivePNs((msg) => updateArchiverUI(msg), 500);
    if (stopped) return { ...results, stopped: true };
    log(`  ${allPNs.length} PNs activos encontrados`);
    updateArchiverUI(`${allPNs.length} PNs activos. Analizando actividad...`);

    // Pre-filter por fecha
    const candidates = [];
    for (const pn of allPNs) {
      if (pn.createdAt && compareDate(pn.createdAt)) candidates.push(pn);
    }
    log(`  ${candidates.length} PNs creados ${dirLabel} ${cutoffDate}`);

    const toArchive = [];

    if (dateType === 'utilizacion') {
      // Batch: WO + REC. Extraer solo pnIds (no acumular nodos)
      updateArchiverUI(`Cargando órdenes de trabajo...`);
      const woPNIds = new Set();
      let woOffset = 0;
      while (!stopped) {
        try {
          const woData = await withRetry(() => api().query('AllWorkOrders', {
            status: null, includeArchived: 'YES', couponWorkOrders: null, computeMargins: false,
            orderBy: ['ID_DESC'], offset: woOffset, first: 500, searchQuery: ''
          }, 'AllWorkOrders'), `AllWorkOrders ${woOffset}`);
          const woNodes = woData?.pagedData?.nodes || [];
          if (!woNodes.length) break;
          for (const wo of woNodes) {
            const pnWOs = wo.partNumberWorkOrdersByWorkOrderId?.nodes || [];
            for (const pnWO of pnWOs) {
              const pnId = pnWO.partNumberId || pnWO.partNumberByPartNumberId?.id;
              if (pnId) woPNIds.add(pnId);
            }
          }
          updateArchiverUI(`OTs: página ${Math.floor(woOffset / 500) + 1}, ${woPNIds.size} PNs con OT encontrados`);
          if (woNodes.length < 500) break;
          woOffset += 500;
        } catch (e) { warn(`AllWorkOrders offset ${woOffset}: ${String(e).substring(0, 60)}`); break; }
      }
      log(`  ${woPNIds.size} PNs con órdenes de trabajo`);

      if (stopped) return { ...results, stopped: true };

      updateArchiverUI(`Cargando recibos...`);
      const recPNIds = new Set();
      let recOffset = 0;
      while (!stopped) {
        try {
          const recData = await withRetry(() => api().query('AllReceivers', {
            orderBy: ['CREATED_AT_DESC'], offset: recOffset, first: 500, searchQuery: ''
          }, 'AllReceivers'), `AllReceivers ${recOffset}`);
          const recNodes = recData?.pagedData?.nodes || [];
          if (!recNodes.length) break;
          for (const rec of recNodes) {
            const bomItems = rec.receiverBomItemsByReceiverId?.nodes || [];
            for (const item of bomItems) {
              const pnId = item.partNumberId || item.partNumberByPartNumberId?.id;
              if (pnId) recPNIds.add(pnId);
            }
          }
          updateArchiverUI(`Recibos: página ${Math.floor(recOffset / 500) + 1}, ${recPNIds.size} PNs con recibos`);
          if (recNodes.length < 500) break;
          recOffset += 500;
        } catch (e) { warn(`AllReceivers offset ${recOffset}: ${String(e).substring(0, 60)}`); break; }
      }
      log(`  ${recPNIds.size} PNs con recibos`);

      if (stopped) return { ...results, stopped: true };

      const usedPNIds = new Set([...woPNIds, ...recPNIds]);

      if (usedPNIds.size === 0 && candidates.length > 0) {
        // Fallback: GetPartNumber por PN en pool concurrente
        log('  WARN: Batch approach returned 0 PNs used — fallback runPool concurrencia 6');
        updateArchiverUI(`Verificación individual (batch no disponible)...`);
        let processed = 0;
        await runPool(candidates, async (pn) => {
          if (stopped) return;
          try {
            const detail = await withRetry(() => api().query('GetPartNumber', { partNumberId: pn.id, usagesLimit: 1, usagesOffset: 0 }), `GetPartNumber ${pn.name}`);
            const pnData = detail?.partNumberById;
            if (!pnData) return;
            const hasWO = (pnData.workOrderPartNumberTreatmentStationsByPartNumberId?.nodes?.length || 0) > 0;
            if (!hasWO) {
              toArchive.push({ id: pn.id, name: pn.name, createdAt: pn.createdAt, customer: pn.customerByCustomerId?.name || '', reason: 'Sin OTs ni recibos', selected: true });
            }
          } catch (_) {}
          processed++;
          if (processed % 10 === 0 || processed === candidates.length) {
            const pct = Math.round((processed / candidates.length) * 100);
            updateArchiverUI(`Verificando ${processed}/${candidates.length} (${pct}%) — ${toArchive.length} sin uso`);
          }
        }, 6);
      } else {
        updateArchiverUI(`Cruzando datos: ${candidates.length} candidatos vs ${usedPNIds.size} PNs con actividad...`);
        for (const pn of candidates) {
          if (!usedPNIds.has(pn.id)) {
            toArchive.push({ id: pn.id, name: pn.name, createdAt: pn.createdAt, customer: pn.customerByCustomerId?.name || '', reason: 'Sin OTs ni recibos', selected: true });
          }
        }
      }
    } else {
      for (const pn of candidates) {
        toArchive.push({ id: pn.id, name: pn.name, createdAt: pn.createdAt, customer: pn.customerByCustomerId?.name || '',
          reason: dateType === 'creacion' ? `Creado ${dirLabel} ${cutoffDate}` : `${dirLabel} ${cutoffDate}`, selected: true });
      }
    }

    if (stopped) return { ...results, stopped: true };

    log(`  ${toArchive.length} PNs para archivar (de ${candidates.length} candidatos)`);
    results.found = toArchive.length;

    if (!toArchive.length) {
      showArchiverResult(results, 'No se encontraron PNs para archivar.');
      return results;
    }

    const selectedPNs = await showArchiverPreview(toArchive, cutoffDate, dateType, direction, enableValidation);
    if (!selectedPNs) { log('Cancelado.'); return { cancelled: true }; }

    const opts = { cutoffDate, dateType, direction, enableValidation };
    return await executeArchive(selectedPNs, opts, [], results, DOMAIN);
  }

  // ═══════════════════════════════════════════
  // ARCHIVE EXECUTION — runPool concurrencia 3 + resume
  // ═══════════════════════════════════════════

  // selectedPNs = lista TOTAL original (no pre-filtrada). alreadyCompleted = IDs ya OK
  // de reanudaciones previas. El loop salta los completed para evitar doble-archivado.
  async function executeArchive(selectedPNs, opts, alreadyCompleted, results, DOMAIN) {
    const completed = new Set(alreadyCompleted);
    const totalCount = selectedPNs.length;
    results.found = totalCount;
    saveResume({ selectedPNs, opts, completed: [...completed] });

    const pendingCount = totalCount - completed.size;
    updateArchiverUI(`Archivando ${pendingCount} PNs (concurrencia 3, ${completed.size} ya OK)...`);

    await runPool(selectedPNs, async (pn) => {
      if (stopped) return;
      if (completed.has(pn.id)) return; // doble-safety — saltar ya archivados

      try {
        await withRetry(() => api().query('UpdatePartNumber', { id: pn.id, archivedAt: new Date().toISOString() }), `Archive ${pn.name}`);
        results.archived++;
      } catch (e) {
        results.errors.push(`Archivar "${pn.name}": ${String(e?.message || e).substring(0, 80)}`);
        return;
      }

      if (opts.enableValidation) {
        try {
          const nodeIds = DOMAIN.validacionProcessNodeIds || [];
          const optInOuts = nodeIds.map(id => ({ processNodeId: id, processNodeOccurrence: 1, cancelOthers: false }));
          await withRetry(() => api().query('SavePartNumber', { input: [{
            id: pn.id, name: pn.name, optInOuts,
            specsToApply: [], paramsToApply: [], partNumberDimensions: [], partNumberLocations: [],
            dimensionCustomValueIds: [], partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
            partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
            partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [],
            specFieldParamUpdates: [], labelIds: [], ownerIds: [], defaults: [],
            inventoryPredictedUsages: []
          }] }), `Validation ${pn.name}`);
          results.validated++;
        } catch (e) {
          warn(`Validación "${pn.name}": ${String(e).substring(0, 80)}`);
        }
      }

      completed.add(pn.id);
      if (completed.size % 5 === 0 || completed.size === totalCount) {
        updateArchiverUI(`Archivando ${completed.size}/${totalCount} — ${results.errors.length} errores`);
        saveResume({ selectedPNs, opts, completed: [...completed] });
      }
    }, 3);

    if (stopped) {
      saveResume({ selectedPNs, opts, completed: [...completed] });
      log(`Archivador: detenido — ${completed.size}/${totalCount} completados, resume guardado`);
      showArchiverResult(results, `Detenido. ${completed.size}/${totalCount} archivados. Re-ejecuta el applet para reanudar.`);
      return { ...results, stopped: true };
    }

    // Completo OK — limpiar resume
    clearResume();

    log(`\n=== ARCHIVADOR RESULTADO ===`);
    log(`Archivados: ${results.archived}/${totalCount}`);
    if (opts.enableValidation) log(`Con validación: ${results.validated}`);
    if (results.errors.length) log(`Errores: ${results.errors.length}`);

    showArchiverResult(results);
    return results;
  }

  function stop() { stopped = true; }

  // ═══════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════

  function showArchiverUI(msg) {
    let ov = document.getElementById('sa-archiver-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-archiver-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#1a2e1a"><h2 style="color:#4ade80">Archivador Masivo</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-arch-bar" style="background:#4ade80"></div></div><div class="dl9-progress" id="sa-arch-text"></div><button id="sa-arch-stop" class="dl9-btn" style="background:#ef4444;color:white;margin-top:10px;padding:8px 16px;font-size:12px">⏹ Detener</button></div>`;
      document.body.appendChild(ov);
      document.getElementById('sa-arch-stop').onclick = () => { stopped = true; const b = document.getElementById('sa-arch-stop'); if (b) { b.textContent = 'Deteniendo...'; b.disabled = true; } };
    }
    document.getElementById('sa-arch-text').textContent = msg;
  }

  function updateArchiverUI(msg) {
    const el = document.getElementById('sa-arch-text');
    if (el) el.textContent = msg;
  }

  function removeArchiverUI() {
    const ov = document.getElementById('sa-archiver-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  function showArchiverPreview(pns, cutoffDate, dateType, direction, enableValidation) {
    const isBefore = direction === 'before';
    const MAX_ROWS = 500;
    const trimmed = pns.length > MAX_ROWS;
    const displayed = trimmed ? pns.slice(0, MAX_ROWS) : pns;
    return new Promise(resolve => {
      removeArchiverUI();
      if (!document.getElementById('dl9-styles')) {
        const s = document.createElement('style'); s.id = 'dl9-styles';
        s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#ef4444;color:white}`;
        document.head.appendChild(s);
      }

      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';

      const dateLabel = dateType === 'creacion' ? 'creación' : dateType === 'modificacion' ? 'modificación' : 'utilización';

      // Construir tabla con DOM API (no innerHTML masivo) — más eficiente y seguro
      md.innerHTML = `
        <h2 style="color:#4ade80">Archivador Masivo — Preview</h2>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">
          ${pns.length} PNs con fecha de ${dateLabel} ${isBefore ? 'anterior' : 'posterior'} a ${cutoffDate}
          ${enableValidation ? ' + activar validación de ingeniería' : ''}
        </p>
        ${trimmed ? `<p style="color:#fbbf24;font-size:12px;margin-bottom:8px">⚠ Mostrando primeros ${MAX_ROWS} de ${pns.length}. Todos serán archivados al confirmar.</p>` : ''}
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input type="checkbox" checked id="sa-arch-selectall">
          <label for="sa-arch-selectall" style="font-size:12px;color:#94a3b8">Seleccionar todos los visibles</label>
          <span style="font-size:12px;color:#4ade80;margin-left:auto" id="sa-arch-count">${pns.length} seleccionados</span>
        </div>
        <div style="max-height:300px;overflow-y:auto">
          <table id="sa-arch-tbl" style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="color:#94a3b8;border-bottom:1px solid #334155"><th style="text-align:left;padding:4px"><input type="checkbox" checked id="sa-arch-th-check"></th><th style="text-align:left;padding:4px">PN</th><th style="text-align:left;padding:4px">Cliente</th><th style="text-align:left;padding:4px">Creado</th><th style="text-align:left;padding:4px">Razón</th></tr></thead>
            <tbody id="sa-arch-tbody"></tbody>
          </table>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-arch-cancel">CANCELAR</button>
          <button class="dl9-btn dl9-btn-exec" id="sa-arch-exec">ARCHIVAR (<span id="sa-arch-exec-count">${pns.length}</span>)</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      // Construir filas via DOM API (textContent, no innerHTML) — XSS-safe + más rápido
      const tbody = md.querySelector('#sa-arch-tbody');
      const frag = document.createDocumentFragment();
      displayed.forEach((p, i) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #1e293b';
        const tdCheck = document.createElement('td'); tdCheck.style.padding = '3px';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.className = 'sa-arch-check'; cb.dataset.idx = i;
        tdCheck.appendChild(cb);
        const tdName = document.createElement('td'); tdName.style.padding = '3px'; tdName.textContent = p.name || '';
        const tdCust = document.createElement('td'); tdCust.style.cssText = 'padding:3px;color:#94a3b8;font-size:11px'; tdCust.textContent = p.customer || '';
        const tdDate = document.createElement('td'); tdDate.style.cssText = 'padding:3px;color:#94a3b8;font-size:11px'; tdDate.textContent = p.createdAt ? new Date(p.createdAt).toLocaleDateString('es-MX') : '?';
        const tdReason = document.createElement('td'); tdReason.style.cssText = 'padding:3px;color:#4ade80;font-size:11px'; tdReason.textContent = p.reason || '';
        tr.append(tdCheck, tdName, tdCust, tdDate, tdReason);
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);

      const updateCount = () => {
        const checked = md.querySelectorAll('.sa-arch-check:checked').length;
        // Si trimmed: el contador real = checked + (pns.length - MAX_ROWS) porque los no-visibles se asumen seleccionados
        const realCount = trimmed ? checked + (pns.length - MAX_ROWS) : checked;
        document.getElementById('sa-arch-count').textContent = `${realCount} seleccionados`;
        document.getElementById('sa-arch-exec-count').textContent = realCount;
      };

      md.querySelector('#sa-arch-selectall').onchange = (e) => {
        md.querySelectorAll('.sa-arch-check').forEach(cb => { cb.checked = e.target.checked; });
        updateCount();
      };
      md.querySelectorAll('.sa-arch-check').forEach(cb => { cb.onchange = updateCount; });

      document.getElementById('sa-arch-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      document.getElementById('sa-arch-exec').onclick = () => {
        const selectedIdx = new Set();
        md.querySelectorAll('.sa-arch-check:checked').forEach(cb => selectedIdx.add(parseInt(cb.dataset.idx)));
        const selected = [];
        // Visibles seleccionados
        displayed.forEach((p, i) => { if (selectedIdx.has(i)) selected.push(p); });
        // Si trimmed: agregar TODOS los no-visibles (la UI no permite deseleccionarlos individualmente)
        if (trimmed) for (let i = MAX_ROWS; i < pns.length; i++) selected.push(pns[i]);
        ov.parentNode.removeChild(ov);
        resolve(selected);
      };
    });
  }

  function showArchiverResult(results, msg) {
    removeArchiverUI();
    if (!document.getElementById('dl9-styles')) {
      const s = document.createElement('style'); s.id = 'dl9-styles';
      s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:520px;width:92%;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 12px}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 20px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}`;
      document.head.appendChild(s);
    }
    const ov = document.createElement('div');
    ov.className = 'dl9-overlay';
    const md = document.createElement('div');
    md.className = 'dl9-modal';
    md.style.background = '#1a2e1a';

    const hasErrors = results.errors && results.errors.length > 0;
    const summary = msg || (
      `<div style="font-size:13px;color:#cbd5e1;line-height:1.7">` +
      `<b>PNs encontrados:</b> ${results.found}<br>` +
      `<b>Archivados:</b> ${results.archived}<br>` +
      (results.validated ? `<b>Con validación:</b> ${results.validated}<br>` : '') +
      (hasErrors ? `<b style="color:#fca5a5">Errores:</b> ${results.errors.length}` : '') +
      `</div>` +
      (hasErrors ? `<div id="sa-arch-errbox" style="margin-top:8px;max-height:120px;overflow-y:auto;font-size:11px;color:#fca5a5;background:#0f172a;padding:8px;border-radius:6px"></div>` : '')
    );

    md.innerHTML = `
      <h2 style="color:#4ade80">📦 Archivador completado</h2>
      ${summary}
      <div class="dl9-btnrow">
        <button class="dl9-btn" id="sa-arch-close" style="background:#475569;color:#e2e8f0">CERRAR</button>
        <button class="dl9-btn" id="sa-arch-reload" style="background:#4ade80;color:#0f172a">CERRAR Y RECARGAR</button>
      </div>`;

    // Insertar errores como texto seguro (no innerHTML)
    if (hasErrors && !msg) {
      const errBox = md.querySelector('#sa-arch-errbox');
      if (errBox) {
        results.errors.slice(0, 10).forEach((line, i) => {
          if (i > 0) errBox.appendChild(document.createElement('br'));
          errBox.appendChild(document.createTextNode(line));
        });
      }
    }

    ov.appendChild(md);
    document.body.appendChild(ov);

    document.getElementById('sa-arch-close').onclick = () => ov.parentNode.removeChild(ov);
    document.getElementById('sa-arch-reload').onclick = () => {
      ov.parentNode.removeChild(ov);
      window.location.reload();
    };
  }

  return {
    run, stop,
    _internals: { slimPN, discoverLabels, matchesLabels, applyFilters, isInTargetState },
  };
})();

if (typeof window !== 'undefined') {
  window.PNArchiver = PNArchiver;
  window.__SAArchiver = PNArchiver._internals;
}
