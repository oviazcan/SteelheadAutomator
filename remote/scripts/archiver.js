// Steelhead Part Number Archiver
// Archiva/desarchiva PNs por criterios combinables: fecha (opcional), etiquetas (AND/OR), modo.
// Depends on: SteelheadAPI
//
// 2026-06-03 — feat: filtro por etiquetas + modo archivar/desarchivar:
//   * Scan SLIM mode-aware (fetchPNsForMode): archive→activos, unarchive→archivados
//   * Pantalla de filtros por etiqueta (AND/OR) con conteo en vivo antes del preview
//   * Cruce de utilización extraído a filterByUnused (WO+recibos); sin fallback per-PN
//   * runPool concurrencia 3 (UpdatePartNumber); resume via localStorage (sa_archiver_resume_v1), por modo
//   * Preview limita a 500 filas en DOM (resto se procesa al confirmar)

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
        // NOTE: dedup por NOMBRE, no por id. Si dos labels distintos comparten
        // nombre, se colapsan en una entrada. matchesLabels también compara por
        // nombre, así que ambos siguen empatando. Si algún día se hace match por
        // id, actualizar AMBAS funciones juntas.
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

  // Formatea enteros con separador de miles (determinista, sin depender de ICU).
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // Progreso de la fase de carga (scan). total falsy ⇒ indeterminado (fraction null).
  function computeLoadProgress({ processed, total, kept }) {
    if (total && total > 0) {
      const fraction = Math.min(processed / total, 1);
      return { fraction, text: `Cargando PNs... ${fmt(processed)}/${fmt(total)} (${fmt(kept)} del modo)` };
    }
    return { fraction: null, text: `Cargando PNs... ${fmt(kept)}` };
  }

  // Progreso de la fase de ejecución. gerundio = 'Archivando' | 'Desarchivando'.
  function computeExecProgress({ done, total, errors, gerundio }) {
    const fraction = total > 0 ? Math.min(done / total, 1) : 0;
    const errPart = errors > 0 ? ` — ${errors} ${errors === 1 ? 'error' : 'errores'}` : '';
    return { fraction, text: `${gerundio} ${fmt(done)}/${fmt(total)}${errPart}` };
  }

  // ═══════════════════════════════════════════
  // PAGINACIÓN PNs POR MODO
  // ═══════════════════════════════════════════

  // Pagina AllPartNumbers en SLIM. mode 'archive' → conserva activos;
  // 'unarchive' → conserva archivados. Acumula slimPNs (no nodos pesados).
  async function fetchPNsForMode(mode, onProgress, pageSize = 500) {
    const slimPNs = [];
    let offset = 0;
    let total = null;
    while (!stopped) {
      const data = await api().query('AllPartNumbers', {
        orderBy: ['ID_ASC'], offset, first: pageSize, searchQuery: ''
      }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) {
        const tc = data?.pagedData?.totalCount;
        total = (typeof tc === 'number' && tc > 0) ? tc : null;
      }
      for (const n of nodes) {
        const isArchived = !!n.archivedAt;
        const keep = mode === 'unarchive' ? isArchived : !isArchived;
        if (keep) slimPNs.push(slimPN(n));   // SLIM: no guardar nodo pesado
      }
      const processed = offset + nodes.length;
      if (onProgress) onProgress({ processed, total, kept: slimPNs.length });
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return slimPNs;
  }

  // Cruza candidatos vs PNs con OT/recibos; devuelve los SIN uso. Solo modo archive.
  async function filterByUnused(candidates) {
    updateArchiverUI(`Cargando órdenes de trabajo...`);
    const usedPNIds = new Set();
    let woOffset = 0;
    while (!stopped) {
      try {
        const woData = await withRetry(() => api().query('AllWorkOrders', {
          status: null, includeArchived: 'YES', couponWorkOrders: null, computeMargins: false,
          orderBy: ['ID_DESC'], offset: woOffset, first: 500, searchQuery: ''
        }, 'AllWorkOrders'), `AllWorkOrders ${woOffset}`);
        const woNodes = woData?.pagedData?.nodes || [];
        if (!woNodes.length) break;
        for (const wo of woNodes) for (const pnWO of (wo.partNumberWorkOrdersByWorkOrderId?.nodes || [])) {
          const pnId = pnWO.partNumberId || pnWO.partNumberByPartNumberId?.id;
          if (pnId) usedPNIds.add(pnId);
        }
        updateArchiverUI(`OTs: página ${Math.floor(woOffset / 500) + 1}, ${usedPNIds.size} PNs con OT`);
        if (woNodes.length < 500) break;
        woOffset += 500;
      } catch (e) { warn(`AllWorkOrders ${woOffset}: ${String(e).substring(0, 60)}`); break; }
    }
    if (stopped) return candidates;

    updateArchiverUI(`Cargando recibos...`);
    let recOffset = 0;
    while (!stopped) {
      try {
        const recData = await withRetry(() => api().query('AllReceivers', {
          orderBy: ['CREATED_AT_DESC'], offset: recOffset, first: 500, searchQuery: ''
        }, 'AllReceivers'), `AllReceivers ${recOffset}`);
        const recNodes = recData?.pagedData?.nodes || [];
        if (!recNodes.length) break;
        for (const rec of recNodes) for (const item of (rec.receiverBomItemsByReceiverId?.nodes || [])) {
          const pnId = item.partNumberId || item.partNumberByPartNumberId?.id;
          if (pnId) usedPNIds.add(pnId);
        }
        updateArchiverUI(`Recibos: página ${Math.floor(recOffset / 500) + 1}, ${usedPNIds.size} PNs con actividad`);
        if (recNodes.length < 500) break;
        recOffset += 500;
      } catch (e) { warn(`AllReceivers ${recOffset}: ${String(e).substring(0, 60)}`); break; }
    }
    log(`  ${usedPNIds.size} PNs con OT/recibos`);
    if (usedPNIds.size === 0) warn('filterByUnused: 0 PNs con OT/recibos — el cruce de utilización podría no estar filtrando; revisa el conteo en el preview antes de confirmar');
    return candidates.filter(pn => !usedPNIds.has(pn.id));
  }

  // ═══════════════════════════════════════════
  // MAIN ARCHIVE FLOW
  // ═══════════════════════════════════════════

  async function run(options) {
    stopped = false;
    const {
      mode = 'archive',
      useDate = false, cutoffDate = null, dateType = 'creacion', direction = 'before',
      enableValidation = false,
    } = options;
    const DOMAIN = api().getDomain();
    const results = { found: 0, archived: 0, validated: 0, errors: [] };

    // ── Resume previo (solo si coincide el modo) ──
    const prevResume = loadResume();
    if (prevResume?.selectedPNs?.length && prevResume.opts?.mode === mode) {
      const pending = prevResume.selectedPNs.filter(p => !prevResume.completed.includes(p.id));
      const resume = confirm(
        `Hay un ${mode === 'unarchive' ? 'desarchivado' : 'archivado'} previo pendiente:\n` +
        `  ${prevResume.completed.length} ya hechos\n  ${pending.length} pendientes\n\n` +
        `¿Reanudar? (Cancelar = empezar de cero)`
      );
      if (resume) {
        showArchiverUI(`Reanudando: ${pending.length} pendientes...`);
        return await executeArchive(prevResume.selectedPNs, prevResume.opts, prevResume.completed, results, DOMAIN);
      }
      clearResume();
    }

    log(`Archivador: modo=${mode}, useDate=${useDate}${useDate ? ` (${dateType} ${direction} ${cutoffDate})` : ''}, validación=${enableValidation}`);
    setProgress(null, `Buscando números de parte (${mode === 'unarchive' ? 'archivados' : 'activos'})...`);

    // 1. Scan slim por modo
    let slimPNs = await fetchPNsForMode(mode, (p) => {
      const r = computeLoadProgress(p);
      setProgress(r.fraction, r.text);
    }, 500);
    if (stopped) return { ...results, stopped: true };
    log(`  ${slimPNs.length} PNs ${mode === 'unarchive' ? 'archivados' : 'activos'}`);

    // 2. Pre-filtro por fecha (opcional)
    const dateFilter = useDate && cutoffDate
      ? { cutoffISO: new Date(cutoffDate).toISOString(), direction }
      : null;
    if (dateFilter) {
      slimPNs = applyFilters(slimPNs, { dateFilter });
      log(`  ${slimPNs.length} tras filtro de fecha`);
    }

    // 3. Cruce de utilización (solo modo archive + dateType utilizacion)
    if (mode === 'archive' && useDate && dateType === 'utilizacion') {
      slimPNs = await filterByUnused(slimPNs);
      if (stopped) return { ...results, stopped: true };
    }

    if (!slimPNs.length) { showArchiverResult(results, 'No hay PNs que cumplan los criterios base.'); return results; }

    // 4. Pantalla de filtros por etiqueta + conteo en vivo
    const labelCatalog = discoverLabels(slimPNs);
    const picked = await showFilterScreen(slimPNs, mode, labelCatalog);
    if (!picked) { log('Cancelado.'); return { cancelled: true }; }

    // 5. Construir lista para preview (slimPN ya trae name/customer/createdAt)
    const reasonBase = mode === 'unarchive' ? 'Desarchivar' : 'Archivar';
    const toArchive = picked.selected.map(p => ({
      id: p.id, name: p.name, createdAt: p.createdAt, customer: p.customer,
      archivedAt: p.archivedAt, reason: reasonBase, selected: true,
    }));
    results.found = toArchive.length;
    if (!toArchive.length) { showArchiverResult(results, 'Ningún PN tras el filtro de etiquetas.'); return results; }

    const selectedPNs = await showArchiverPreview(toArchive, mode);
    if (!selectedPNs) { log('Cancelado.'); return { cancelled: true }; }

    const opts = { mode, useDate, cutoffDate, dateType, direction, enableValidation };
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

    const isUnarchive = opts.mode === 'unarchive';
    const gerundio = isUnarchive ? 'Desarchivando' : 'Archivando';
    const verbo = isUnarchive ? 'Desarchivar' : 'Archivar';
    const participio = isUnarchive ? 'desarchivados' : 'archivados';
    const pendingCount = totalCount - completed.size;
    updateArchiverUI(`${gerundio} ${pendingCount} PNs (concurrencia 3, ${completed.size} ya OK)...`);

    await runPool(selectedPNs, async (pn) => {
      if (stopped) return;
      if (completed.has(pn.id)) return; // doble-safety — saltar ya procesados
      // Idempotencia: si el PN ya está en el estado destino, no re-mutar.
      if (isInTargetState(pn, opts.mode)) { completed.add(pn.id); return; }

      try {
        const newArchivedAt = isUnarchive ? null : new Date().toISOString();
        await withRetry(() => api().query('UpdatePartNumber', { id: pn.id, archivedAt: newArchivedAt }), `${verbo} ${pn.name}`);
        results.archived++;
      } catch (e) {
        results.errors.push(`${verbo} "${pn.name}": ${String(e?.message || e).substring(0, 80)}`);
        return;
      }

      if (opts.enableValidation && !isUnarchive) {
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
        updateArchiverUI(`${gerundio} ${completed.size}/${totalCount} — ${results.errors.length} errores`);
        saveResume({ selectedPNs, opts, completed: [...completed] });
      }
    }, 3);

    if (stopped) {
      saveResume({ selectedPNs, opts, completed: [...completed] });
      log(`Archivador: detenido — ${completed.size}/${totalCount} completados, resume guardado`);
      showArchiverResult(results, `Detenido. ${completed.size}/${totalCount} ${participio}. Re-ejecuta el applet para reanudar.`);
      return { ...results, stopped: true };
    }

    // Completo OK — limpiar resume
    clearResume();

    log(`\n=== ARCHIVADOR RESULTADO ===`);
    log(`${isUnarchive ? 'Desarchivados' : 'Archivados'}: ${results.archived}/${totalCount}`);
    if (opts.enableValidation && !isUnarchive) log(`Con validación: ${results.validated}`);
    if (results.errors.length) log(`Errores: ${results.errors.length}`);

    showArchiverResult(results, null, isUnarchive);
    return results;
  }

  function stop() { stopped = true; }

  // ═══════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('dl9-styles')) return;
    const s = document.createElement('style'); s.id = 'dl9-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#ef4444;color:white}.dl9-bar{height:10px;background:#0f291a;border-radius:6px;overflow:hidden;margin:14px 0 10px}.dl9-bar-fill{height:100%;width:0;background:#4ade80;border-radius:6px;transition:width .2s ease}.dl9-bar-fill.indet{width:40%;animation:dl9slide 1.1s infinite ease-in-out}@keyframes dl9slide{0%{margin-left:-40%}100%{margin-left:100%}}.dl9-progress{font-size:13px;color:#cbd5e1}`;
    document.head.appendChild(s);
  }

  // Modal de configuración (mudado desde extension/background.js). Devuelve
  // Promise<options | null>. options: {mode, useDate, cutoffDate, dateType, direction, enableValidation}
  function showConfigForm() {
    return new Promise(resolve => {
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';
      md.innerHTML = `
        <h2 style="color:#4ade80">📦 Archivador Masivo de PNs</h2>
        <div style="margin-bottom:14px;display:flex;gap:8px">
          <label style="flex:1;font-size:13px;color:#e2e8f0"><input type="radio" name="sa-mode" value="archive" checked> Archivar</label>
          <label style="flex:1;font-size:13px;color:#e2e8f0"><input type="radio" name="sa-mode" value="unarchive"> Desarchivar</label>
        </div>
        <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="sa-arch-usedate">
          <label for="sa-arch-usedate" style="font-size:13px;color:#e2e8f0">Usar fecha de corte</label>
        </div>
        <div id="sa-arch-datebox" style="display:none">
          <div style="margin-bottom:12px">
            <input type="date" id="sa-arch-date" style="width:100%;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px" value="${new Date().toLocaleDateString('en-CA')}">
          </div>
          <div style="margin-bottom:12px;display:flex;gap:8px">
            <select id="sa-arch-direction" style="flex:1;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
              <option value="before" selected>Antes de la fecha</option>
              <option value="after">Después de la fecha</option>
            </select>
            <select id="sa-arch-type" style="flex:1;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
              <option value="utilizacion" selected>Última utilización</option>
              <option value="creacion">Fecha de creación</option>
              <option value="modificacion">Fecha de modificación</option>
            </select>
          </div>
        </div>
        <div id="sa-arch-valbox" style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="sa-arch-validation">
          <label for="sa-arch-validation" style="font-size:13px;color:#e2e8f0">Activar validación de ingeniería (solo archivar)</label>
        </div>
        <p style="font-size:11px;color:#64748b;margin-bottom:8px">Tras buscar, podrás filtrar por etiquetas y ver el conteo antes de confirmar.</p>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-arch-form-cancel">CANCELAR</button>
          <button class="dl9-btn" id="sa-arch-form-exec" style="background:#4ade80;color:#0f172a">BUSCAR PNs</button>
        </div>`;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const useDateCb = md.querySelector('#sa-arch-usedate');
      const dateBox = md.querySelector('#sa-arch-datebox');
      useDateCb.onchange = () => { dateBox.style.display = useDateCb.checked ? 'block' : 'none'; };
      const valBox = md.querySelector('#sa-arch-valbox');
      md.querySelectorAll('input[name="sa-mode"]').forEach(r => r.onchange = () => {
        valBox.style.display = md.querySelector('input[name="sa-mode"]:checked').value === 'archive' ? 'flex' : 'none';
      });
      valBox.style.display = md.querySelector('input[name="sa-mode"]:checked').value === 'archive' ? 'flex' : 'none';

      md.querySelector('#sa-arch-form-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      md.querySelector('#sa-arch-form-exec').onclick = () => {
        const opts = {
          mode: md.querySelector('input[name="sa-mode"]:checked').value,
          useDate: useDateCb.checked,
          cutoffDate: md.querySelector('#sa-arch-date').value,
          dateType: md.querySelector('#sa-arch-type').value,
          direction: md.querySelector('#sa-arch-direction').value,
          enableValidation: md.querySelector('#sa-arch-validation').checked,
        };
        ov.parentNode.removeChild(ov);
        resolve(opts);
      };
    });
  }

  // Entry point único llamado desde la extensión.
  async function openConfigAndRun() {
    const opts = await showConfigForm();
    if (!opts) return { cancelled: true };
    try { return await run(opts); }
    catch (e) { return { error: e.message }; }
  }

  function showArchiverUI(msg) {
    ensureStyles();
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

  // Pinta progreso reusando el overlay idempotente (showArchiverUI). fraction en
  // [0,1] → barra determinada; fraction null → barra animada (clase 'indet').
  function setProgress(fraction, text) {
    showArchiverUI(text);                 // asegura overlay + setea #sa-arch-text
    const bar = document.getElementById('sa-arch-bar');
    if (!bar) return;
    if (fraction == null) {
      bar.classList.add('indet');
      bar.style.width = '';               // deja que la clase 'indet' controle el ancho
    } else {
      bar.classList.remove('indet');
      const pct = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
      bar.style.width = `${pct}%`;
    }
  }

  function removeArchiverUI() {
    const ov = document.getElementById('sa-archiver-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // Pantalla de filtros: multiselect de etiquetas descubiertas + AND/OR + conteo en vivo.
  // slimPNs: lista ya filtrada por fecha (si aplicaba). Devuelve Promise<{selected:[slimPN]} | null>.
  function showFilterScreen(slimPNs, mode, labelCatalog) {
    const verbo = mode === 'unarchive' ? 'desarchivarán' : 'archivarán';
    return new Promise(resolve => {
      removeArchiverUI();
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';
      md.innerHTML = `
        <h2 style="color:#4ade80">📦 Filtrar por etiquetas</h2>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:8px">
          ${slimPNs.length} PNs en el conjunto base. Elegí etiquetas para acotar (opcional).
        </p>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
          <label style="font-size:12px;color:#e2e8f0">Modo:</label>
          <label style="font-size:12px;color:#e2e8f0"><input type="radio" name="sa-lblmode" value="AND" checked> Todas (AND)</label>
          <label style="font-size:12px;color:#e2e8f0"><input type="radio" name="sa-lblmode" value="OR"> Cualquiera (OR)</label>
        </div>
        <div id="sa-lbl-list" style="max-height:240px;overflow-y:auto;background:#0f172a;border-radius:6px;padding:8px;margin-bottom:12px"></div>
        <div style="font-size:15px;color:#4ade80;margin-bottom:12px">
          <b id="sa-lbl-count">${slimPNs.length}</b> partes se ${verbo}
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-lbl-cancel">CANCELAR</button>
          <button class="dl9-btn" id="sa-lbl-next" style="background:#4ade80;color:#0f172a">CONTINUAR</button>
        </div>`;
      ov.appendChild(md);
      document.body.appendChild(ov);

      // Lista de etiquetas con checkbox (textContent — XSS-safe)
      const listEl = md.querySelector('#sa-lbl-list');
      labelCatalog.forEach((l) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;color:#e2e8f0;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'sa-lbl-cb'; cb.dataset.name = l.name;
        const txt = document.createElement('span');
        txt.textContent = `${l.name} (${l.count})`;
        row.append(cb, txt);
        listEl.appendChild(row);
      });

      const getSelected = () => [...md.querySelectorAll('.sa-lbl-cb:checked')].map(cb => cb.dataset.name);
      const getMode = () => md.querySelector('input[name="sa-lblmode"]:checked').value;
      const recount = () => {
        const filtered = applyFilters(slimPNs, { selectedLabels: getSelected(), labelMode: getMode() });
        md.querySelector('#sa-lbl-count').textContent = filtered.length;
        return filtered;
      };
      md.querySelectorAll('.sa-lbl-cb').forEach(cb => cb.onchange = recount);
      md.querySelectorAll('input[name="sa-lblmode"]').forEach(r => r.onchange = recount);

      md.querySelector('#sa-lbl-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      md.querySelector('#sa-lbl-next').onclick = () => {
        const filtered = recount();
        ov.parentNode.removeChild(ov);
        resolve({ selected: filtered });
      };
    });
  }

  function showArchiverPreview(pns, mode) {
    const MAX_ROWS = 500;
    const trimmed = pns.length > MAX_ROWS;
    const displayed = trimmed ? pns.slice(0, MAX_ROWS) : pns;
    return new Promise(resolve => {
      removeArchiverUI();
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';

      // Construir tabla con DOM API (no innerHTML masivo) — más eficiente y seguro
      const accion = mode === 'unarchive' ? 'Desarchivar' : 'Archivar';
      md.innerHTML = `
        <h2 style="color:#4ade80">📦 ${accion} — Preview</h2>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">${pns.length} PNs seleccionados.</p>
        ${trimmed ? `<p style="color:#fbbf24;font-size:12px;margin-bottom:8px">⚠ Mostrando primeros ${MAX_ROWS} de ${pns.length}. Todos se procesan al confirmar.</p>` : ''}
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input type="checkbox" checked id="sa-arch-selectall">
          <label for="sa-arch-selectall" style="font-size:12px;color:#94a3b8">Seleccionar todos los visibles</label>
          <span style="font-size:12px;color:#4ade80;margin-left:auto" id="sa-arch-count">${pns.length} seleccionados</span>
        </div>
        <div style="max-height:300px;overflow-y:auto">
          <table id="sa-arch-tbl" style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="color:#94a3b8;border-bottom:1px solid #334155"><th style="text-align:left;padding:4px"><input type="checkbox" checked id="sa-arch-th-check"></th><th style="text-align:left;padding:4px">PN</th><th style="text-align:left;padding:4px">Cliente</th><th style="text-align:left;padding:4px">Creado</th><th style="text-align:left;padding:4px">Acción</th></tr></thead>
            <tbody id="sa-arch-tbody"></tbody>
          </table>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-arch-cancel">CANCELAR</button>
          <button class="dl9-btn dl9-btn-exec" id="sa-arch-exec">${accion.toUpperCase()} (<span id="sa-arch-exec-count">${pns.length}</span>)</button>
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

  function showArchiverResult(results, msg, isUnarchive = false) {
    removeArchiverUI();
    ensureStyles();
    const ov = document.createElement('div');
    ov.className = 'dl9-overlay';
    const md = document.createElement('div');
    md.className = 'dl9-modal';
    md.style.background = '#1a2e1a';

    const hasErrors = results.errors && results.errors.length > 0;
    const summary = msg || (
      `<div style="font-size:13px;color:#cbd5e1;line-height:1.7">` +
      `<b>PNs encontrados:</b> ${results.found}<br>` +
      `<b>${isUnarchive ? 'Desarchivados' : 'Archivados'}:</b> ${results.archived}<br>` +
      (results.validated ? `<b>Con validación:</b> ${results.validated}<br>` : '') +
      (hasErrors ? `<b style="color:#fca5a5">Errores:</b> ${results.errors.length}` : '') +
      `</div>` +
      (hasErrors ? `<div id="sa-arch-errbox" style="margin-top:8px;max-height:120px;overflow-y:auto;font-size:11px;color:#fca5a5;background:#0f172a;padding:8px;border-radius:6px"></div>` : '')
    );

    md.innerHTML = `
      <h2 style="color:#4ade80">📦 ${isUnarchive ? 'Desarchivado' : 'Archivado'} completado</h2>
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
    run, stop, openConfigAndRun,
    _internals: { slimPN, discoverLabels, matchesLabels, applyFilters, isInTargetState, computeLoadProgress, computeExecProgress },
  };
})();

if (typeof window !== 'undefined') {
  window.PNArchiver = PNArchiver;
  window.__SAArchiver = PNArchiver._internals;
}
