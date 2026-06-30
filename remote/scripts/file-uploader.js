// Steelhead File Uploader
// Sube archivos (fotos/planos) y los vincula a Part Numbers, matcheando por nombre.
// Convención de nombre: <PN>__<descriptor>.<ext>  (ver file-uploader-core.js).
// Flow por archivo: /api/files (binario) → CreateUserFile (registrar) → CreatePartNumberUserFile (vincular).
// PN archivado (SearchPartNumbers no lo ve): se halla con AllPartNumbers(includeArchived:'YES'),
//   se desarchiva → vincula → re-archiva con su archivedAt ORIGINAL (preserva la limpieza de catálogo).
// Inteligencia de matching/dedup en FileUploaderCore (puro + tests).
// Depends on: SteelheadAPI, FileUploaderCore

const FileUploader = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const core = () => window.FileUploaderCore;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── Rate-limit + retry (evita el HTTP 502 por disparar requests sin pausa) ──
  let cancelRun = false;            // lo activa el guardrail de memoria
  let _lastCall = 0;
  const MIN_GAP_MS = 120;           // ~8 req/s: el gateway de Steelhead se satura sin esto
  const RETRY_DELAYS = [0, 1000, 3000, 8000]; // backoff en transitorios (502/429/red)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function gate() {           // espacia las llamadas de red
    const wait = MIN_GAP_MS - (Date.now() - _lastCall);
    if (wait > 0) await sleep(wait);
    _lastCall = Date.now();
  }

  // Throttle + reintento con backoff SOLO en errores transitorios; los de lógica fallan ya.
  async function withRetry(fn, label) {
    let lastErr;
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      if (cancelRun) throw new Error('__sa_cancelado__');
      if (RETRY_DELAYS[i]) await sleep(RETRY_DELAYS[i]);
      await gate();
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        if (i === RETRY_DELAYS.length - 1 || !core().isTransientError(e?.message || e)) throw e;
        warn(`${label}: reintento ${i + 1} · ${String(e?.message || e).substring(0, 50)}`);
      }
    }
    throw lastErr;
  }

  // Sube el binario una sola vez a Steelhead.
  async function uploadBinary(file) {
    return withRetry(async () => {
      const formData = new FormData();
      formData.append('myfile', file, file.name);
      const resp = await fetch('/api/files', { method: 'POST', credentials: 'include', body: formData });
      if (!resp.ok) throw new Error(`Upload HTTP ${resp.status}`);
      return await resp.json(); // { name: "generated.pdf", originalName: "original.pdf" }
    }, `subir ${file.name}`);
  }

  async function registerFile(generatedName, originalName) {
    const data = await withRetry(() => api().query('CreateUserFile', { name: generatedName, originalName }), 'CreateUserFile');
    return data?.createUserFile?.userFile;
  }

  async function linkToPN(partNumberId, generatedName) {
    const data = await withRetry(() => api().query('CreatePartNumberUserFile', { partNumberId, fileName: generatedName }), 'CreatePartNumberUserFile');
    return data?.createPartNumberUserFile?.partNumberUserFile;
  }

  // archivedAt: null = desarchivar; timestamp ISO = (re)archivar.
  async function setArchived(partNumberId, archivedAt) {
    await withRetry(() => api().query('UpdatePartNumber', { id: partNumberId, archivedAt }), 'UpdatePartNumber');
  }

  // Marca la foto principal del PN (la que sale en los tableros). displayImageId
  // = id del vínculo partNumberUserFile. Misma persisted query que archivar.
  async function setDisplayImage(partNumberId, displayImageId) {
    await withRetry(() => api().query('UpdatePartNumber', { id: partNumberId, displayImageId }), 'UpdatePartNumber(displayImage)');
  }

  // Paginación + filtro de exactos, parametrizada por operación (activos vs incluir archivados).
  async function paginateExact(opName, name, extraVars) {
    const PAGE = 50, MAX_PAGES = 6;
    let all = [], truncated = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const data = await withRetry(() => api().query(opName, { searchQuery: name, first: PAGE, offset: p * PAGE, orderBy: ['ID_DESC'], ...extraVars }), opName);
      const nodes = data?.searchPartNumbers?.nodes || data?.pagedData?.nodes || data?.allPartNumbers?.nodes || [];
      all = all.concat(nodes);
      if (nodes.length < PAGE) break;
      if (p === MAX_PAGES - 1) truncated = true;
    }
    // EJE A (slim): retener solo {id,name}; los nodos de AllPartNumbers traen
    // customInputs/labels/relations pesados que no usamos (× miles de PNs = OOM).
    const matches = core().selectMatchingPNs(all, name).map((n) => ({ id: n.id, name: n.name }));
    return { matches, truncated };
  }

  // PNs ACTIVOS con ese nombre exacto (SearchPartNumbers no devuelve archivados).
  const findActivePNs = (name) => paginateExact('SearchPartNumbers', name, {});
  // PNs (incluye archivados) — para hallar los que SearchPartNumbers no ve.
  const findAnyPNs = (name) => paginateExact('AllPartNumbers', name, { includeArchived: 'YES' });

  // GetPartNumber → { archivedAt, names ya vinculados, displayImageId actual,
  //                   fileIdByName: Map<originalName norm → partNumberUserFile.id> }.
  async function getPNDetail(pnId) {
    const data = await withRetry(() => api().query('GetPartNumber', { partNumberId: pnId, usagesLimit: 10, usagesOffset: 0 }), 'GetPartNumber');
    const pn = data?.partNumberById || {};
    const ds = core().readDisplayState(pn);
    return { archivedAt: pn.archivedAt || null, names: core().existingOriginalNames(pn), displayImageId: ds.displayImageId, fileIdByName: ds.fileIdByName };
  }

  // Detail por defecto cuando GetPartNumber falla (no se pierde el shape esperado).
  const emptyDetail = () => ({ archivedAt: null, names: new Set(), displayImageId: null, fileIdByName: new Map() });

  // Vincula los archivos faltantes de un grupo a un conjunto de PNs; sube cada binario 1 sola vez.
  // detailById: Map<pnId, {archivedAt, names}>. Marca dedup en vivo para no re-linkear.
  async function linkGroupToPNs(group, pns, detailById, results) {
    const uploadCache = new Map(); // file.name → generatedName
    for (const file of group) {
      const targets = pns.filter((pn) => !core().isAlreadyLinked(detailById.get(pn.id).names, file.name));
      if (!targets.length) { results.skipped++; continue; }
      try {
        let gen = uploadCache.get(file.name);
        if (!gen) {
          const up = await uploadBinary(file);
          gen = up.name;
          await registerFile(gen, file.name);
          uploadCache.set(file.name, gen);
          results.uploaded++;
        }
        for (const pn of targets) {
          const pnuf = await linkToPN(pn.id, gen);
          results.linked++;
          const d = detailById.get(pn.id);
          d.names.add(core().norm(file.name));
          // Captura el id del vínculo recién creado para resolver display image
          // sin re-leer (si CreatePartNumberUserFile lo devuelve).
          if (pnuf && pnuf.id != null) d.fileIdByName.set(core().norm(file.name), pnuf.id);
        }
        log(`  "${file.name}" → ${targets.length} PN(s)`);
      } catch (e) {
        results.errors.push(`"${file.name}": ${String(e).substring(0, 80)}`);
      }
    }
  }

  // Marca la foto principal en los PNs del grupo que NO tengan display image.
  // Elige la imagen más grande (o la marcada con descriptor de Cowork); respeta
  // la existente. Resuelve el id del vínculo del mapa; si falta, relee GetPartNumber.
  async function markDisplayImages(group, pns, detailById, results) {
    const chosen = core().selectDisplayImage(group);
    if (!chosen) return; // solo planos/PDFs: no hay imagen que poner de portada
    const key = core().norm(chosen.name);
    for (const pn of pns) {
      if (cancelRun) break;
      const d = detailById.get(pn.id);
      if (!d || d.displayImageId != null) continue; // respeta la portada existente
      let fileId = d.fileIdByName.get(key);
      if (fileId == null) {
        // Fallback: la foto ya está vinculada → GetPartNumber la trae con su id.
        try {
          const fresh = await getPNDetail(pn.id);
          if (fresh.displayImageId != null) { d.displayImageId = fresh.displayImageId; continue; }
          fileId = fresh.fileIdByName.get(key);
        } catch (e) { /* cae al guard de abajo */ }
      }
      if (fileId == null) {
        results.errors.push(`display "${chosen.name}" en PN ${pn.name || pn.id}: no resolví el id del archivo`);
        continue;
      }
      try {
        await setDisplayImage(pn.id, fileId);
        d.displayImageId = fileId;
        results.displaySet++;
        log(`  ★ display image de ${pn.name || pn.id} → "${chosen.name}"`);
      } catch (e) {
        results.errors.push(`display PN ${pn.name || pn.id}: ${String(e).substring(0, 60)}`);
      }
    }
  }

  // Grupo cuyos PNs están ARCHIVADOS: desarchivar → vincular → re-archivar (archivedAt original).
  async function processArchivedGroup(group, pns, results) {
    if (pns.length > 1) results.homonymGroups++;
    const detailById = new Map();
    for (const pn of pns) {
      try { detailById.set(pn.id, await getPNDetail(pn.id)); }
      catch (e) { detailById.set(pn.id, emptyDetail()); results.errors.push(`leer PN ${pn.name}: ${String(e).substring(0, 60)}`); }
    }
    // Desarchivar solo los que realmente están archivados y necesitan algún archivo.
    const unarchived = [];
    for (const pn of pns) {
      const d = detailById.get(pn.id);
      const needs = group.some((f) => !core().isAlreadyLinked(d.names, f.name));
      if (d.archivedAt && needs) {
        try { await setArchived(pn.id, null); unarchived.push(pn); results.unarchived++; }
        catch (e) { results.errors.push(`desarchivar ${pn.name}: ${String(e).substring(0, 60)}`); }
      }
    }
    try {
      await linkGroupToPNs(group, pns, detailById, results);
      await markDisplayImages(group, pns, detailById, results); // antes de re-archivar
    } finally {
      // Re-archivar SIEMPRE los que desarchivamos, con su archivedAt ORIGINAL crudo
      // (validado en vivo: el server acepta de vuelta el string de GetPartNumber tal cual).
      for (const pn of unarchived) {
        try {
          await setArchived(pn.id, detailById.get(pn.id).archivedAt);
          results.rearchived++;
        } catch (e) {
          results.errors.push(`⚠️ PN ${pn.name} (id ${pn.id}) QUEDÓ DESARCHIVADO: ${String(e).substring(0, 60)}`);
        }
      }
    }
  }

  // Flujo principal.
  async function run(files) {
    const results = {
      selected: files?.length || 0,
      uploaded: 0, linked: 0, skipped: 0, homonymGroups: 0, unarchived: 0, rearchived: 0, displaySet: 0,
      notFound: [], truncated: [], errors: [], stopped: false,
    };
    if (!files?.length) return { error: 'No se seleccionaron archivos' };
    if (!core()) return { error: 'FileUploaderCore no disponible' };

    // Agrupar por PN: varios archivos (front/back/plano) caen en el mismo PN.
    const groups = new Map();
    for (const f of files) {
      const pnName = core().extractPNName(f.name);
      if (!groups.has(pnName)) groups.set(pnName, []);
      groups.get(pnName).push(f);
    }

    log(`FileUploader: ${files.length} archivos en ${groups.size} PNs`);
    showUploaderUI(`Procesando ${files.length} archivos…`);

    // ── Memory hardening (host SPA): este run puede tocar miles de PNs por minutos. ──
    const HC = window.SteelheadHostCleanup;
    cancelRun = false; // reset del flag de módulo (lo usa withRetry para abortar reintentos)
    HC?.stopDatadogSessionReplay();
    const mem = HC?.createMemMonitor({
      getElement: () => document.getElementById('sa-upl-mem'),
      onGuardrail: (pct) => {
        cancelRun = true;
        results.stopped = true;
        results.errors.push(`⚠️ Memoria al ${pct}%: corrida detenida. Recarga la pestaña y vuelve a correr el lote — la idempotencia continúa donde quedó.`);
      },
    });
    mem?.start();
    const drain = HC?.makePeriodicDrain(50) || (() => {});

    try {
      let gi = 0;
      for (const [pnName, group] of groups) {
        if (cancelRun) break; // guardrail @88% — checkpoint > crash
        gi++;
        const pct = Math.round((gi / groups.size) * 100);
        updateUploaderUI(`${gi}/${groups.size} (${pct}%) — "${pnName}" — ${results.linked} vinculados`);

        try {
          const active = await findActivePNs(pnName);
          if (active.truncated) results.truncated.push(pnName);

          if (active.matches.length) {
            // Caso normal: vincular a todos los PNs activos homónimos.
            if (active.matches.length > 1) results.homonymGroups++;
            const detailById = new Map();
            for (const pn of active.matches) {
              try { detailById.set(pn.id, await getPNDetail(pn.id)); }
              catch (e) { detailById.set(pn.id, emptyDetail()); warn(`leer PN ${pn.id}: ${e}`); }
            }
            await linkGroupToPNs(group, active.matches, detailById, results);
            await markDisplayImages(group, active.matches, detailById, results);
          } else {
            // No hay activos: buscar archivados y desarchivar→vincular→re-archivar.
            const any = await findAnyPNs(pnName);
            if (any.matches.length) {
              await processArchivedGroup(group, any.matches, results);
            } else {
              for (const f of group) results.notFound.push({ fileName: f.name, pnName });
              warn(`PN "${pnName}" no encontrado (${group.length} archivos)`);
            }
          }
        } catch (e) {
          results.errors.push(`grupo "${pnName}": ${String(e).substring(0, 80)}`);
        }
        drain(); // Apollo cache drain cada 50 grupos (no acumular el normalizado del host)
      }
    } finally {
      mem?.stop();
      HC?.apolloCacheDrain();
      groups.clear();
      showSummaryUI(results); // SIEMPRE muestra el resumen, aunque algo haya tronado
    }
    return results;
  }

  // ── BACKFILL: marca portadas de lo YA cargado, desde el CSV de Cowork ─────────
  // El CSV (PN, displayImage, tipo, fuente) ya trae la principal decidida; aquí solo
  // se aplica: busca el PN, ubica el id del archivo displayImage entre sus archivos
  // vinculados y marca display image SI el PN no tiene una. NO sube ni vincula nada.
  // v1: solo PNs ACTIVOS (los archivados/no-encontrados se reportan).
  async function runBackfill(csvText) {
    const results = {
      rows: 0, displaySet: 0, alreadyHad: 0, homonyms: 0, unarchived: 0, rearchived: 0,
      notFound: [], notLinked: [], pdfDisplays: [], errors: [], stopped: false,
    };
    let rows;
    try { rows = core().parseBackfillCsv(csvText); }
    catch (e) { return { error: String(e?.message || e) }; }
    if (!rows.length) return { error: 'El CSV no tiene filas (revisa encabezados PN/displayImage).' };
    results.rows = rows.length;

    log(`Backfill display image: ${rows.length} PNs del CSV`);
    showUploaderUI(`Marcando portadas: ${rows.length} PNs…`);

    const HC = window.SteelheadHostCleanup;
    cancelRun = false;
    HC?.stopDatadogSessionReplay();
    const mem = HC?.createMemMonitor({
      getElement: () => document.getElementById('sa-upl-mem'),
      onGuardrail: (pct) => {
        cancelRun = true;
        results.stopped = true;
        results.errors.push(`⚠️ Memoria al ${pct}%: backfill detenido. Recarga la pestaña y re-corre el CSV — es idempotente (salta los que ya tienen portada).`);
      },
    });
    mem?.start();
    const drain = HC?.makePeriodicDrain(50) || (() => {});

    try {
      let i = 0;
      for (const row of rows) {
        if (cancelRun) break;
        i++;
        if (i % 5 === 0 || i === rows.length) {
          const pct = Math.round((i / rows.length) * 100);
          updateUploaderUI(`${i}/${rows.length} (${pct}%) — "${row.pn}" — ${results.displaySet} marcadas`);
        }
        if (!row.displayImage) { results.notLinked.push({ pn: row.pn, file: '(vacío en CSV)' }); continue; }
        try {
          let pns = (await findActivePNs(row.pn)).matches;
          if (!pns.length) pns = (await findAnyPNs(row.pn)).matches; // incluye archivados
          if (!pns.length) { results.notFound.push(row.pn); drain(); continue; }
          if (pns.length > 1) results.homonyms++;
          const wantKey = core().norm(row.displayImage);
          for (const pn of pns) {
            if (cancelRun) break;
            await applyBackfillToPN(pn, wantKey, row.displayImage, row.pn, results);
          }
        } catch (e) {
          results.errors.push(`fila "${row.pn}": ${String(e).substring(0, 60)}`);
        }
        drain();
      }
    } finally {
      mem?.stop();
      HC?.apolloCacheDrain();
      showBackfillSummary(results);
    }
    return results;
  }

  // Marca la portada de UN PN (si no tiene). Si está archivado: desarchiva →
  // marca → re-archiva con su archivedAt ORIGINAL (re-archivado SIEMPRE, en finally).
  async function applyBackfillToPN(pn, wantKey, displayImage, pnName, results) {
    let detail;
    try { detail = await getPNDetail(pn.id); }
    catch (e) { results.errors.push(`leer PN ${pnName} (${pn.id}): ${String(e).substring(0, 50)}`); return; }
    if (detail.displayImageId != null) { results.alreadyHad++; return; } // respeta la existente
    const fileId = detail.fileIdByName.get(wantKey);
    if (fileId == null) { results.notLinked.push({ pn: pnName, file: displayImage }); return; }

    // Cuenta la marca; si la portada NO es imagen (PDF/plano), la registra aparte
    // para revisión (decisión del usuario: marcar igual pero listarlas).
    const noteMark = () => {
      results.displaySet++;
      if (!core().isImageFile(displayImage)) results.pdfDisplays.push({ pn: pnName, file: displayImage });
    };

    if (!detail.archivedAt) {
      try { await setDisplayImage(pn.id, fileId); noteMark(); log(`  ★ ${pnName} (${pn.id}) → "${displayImage}"`); }
      catch (e) { results.errors.push(`marcar ${pnName} (${pn.id}): ${String(e).substring(0, 50)}`); }
      return;
    }
    // PN archivado: desarchivar → marcar → re-archivar (archivedAt crudo original).
    try { await setArchived(pn.id, null); results.unarchived++; }
    catch (e) { results.errors.push(`desarchivar ${pnName} (${pn.id}): ${String(e).substring(0, 50)}`); return; }
    try {
      await setDisplayImage(pn.id, fileId);
      noteMark();
      log(`  ★ (archivado) ${pnName} (${pn.id}) → "${displayImage}"`);
    } catch (e) {
      results.errors.push(`marcar ${pnName} (${pn.id}): ${String(e).substring(0, 50)}`);
    } finally {
      try { await setArchived(pn.id, detail.archivedAt); results.rearchived++; }
      catch (e) { results.errors.push(`⚠️ PN ${pnName} (${pn.id}) QUEDÓ DESARCHIVADO: ${String(e).substring(0, 50)}`); }
    }
  }

  // Overlay propio (dark) con input del CSV — invocado por el handler genérico `fn`.
  function runBackfillFromPopup() {
    ensureStyles();
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.id = 'sa-uploader-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee;text-align:center;max-width:460px"><h2 style="color:#13a36f">★ Marcar Portadas desde CSV</h2><p style="font-size:13px;color:#cbd5e1;margin:0 0 16px">Sube el CSV de Cowork (columnas <b>PN</b>, <b>displayImage</b>). Marca la foto principal de los PNs que aún no tengan una. No sube ni re-vincula archivos.</p><input type="file" id="sa-bf-input" accept=".csv,text/csv" style="margin-bottom:18px;color:#e6e9ee;font-size:13px"><div style="display:flex;gap:10px;justify-content:center"><button id="sa-bf-cancel" class="sa-upl-btn" style="background:#475569">Cancelar</button></div></div>`;
      document.body.appendChild(ov);
      const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
      document.getElementById('sa-bf-cancel').onclick = () => { close(); resolve({ cancelled: true }); };
      document.getElementById('sa-bf-input').onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        close();
        try { resolve(await runBackfill(await file.text())); }
        catch (err) { resolve({ error: String(err?.message || err) }); }
      };
    });
  }

  // Resumen del backfill (dark, no bloqueante) + export del reporte.
  function showBackfillSummary(r) {
    removeUploaderUI();
    ensureStyles();
    const ov = document.createElement('div');
    ov.id = 'sa-uploader-overlay';
    ov.className = 'dl9-overlay';
    const line = (l, v) => `<div style="display:flex;justify-content:space-between;gap:24px;padding:1px 0"><span>${l}</span><strong>${v}</strong></div>`;
    let body = line('PNs en el CSV', r.rows)
      + line('Portadas marcadas', r.displaySet)
      + line('Ya tenían portada', r.alreadyHad);
    if (r.unarchived) body += line('Desarchivados → re-archivados', `${r.rearchived}/${r.unarchived}`);
    if (r.homonyms) body += line('PNs con homónimos', r.homonyms);
    if (r.pdfDisplays.length) body += line('Portada = PDF/plano (revisar)', r.pdfDisplays.length);
    if (r.notFound.length) body += line('PN no encontrado', r.notFound.length);
    if (r.notLinked.length) body += line('Foto del CSV no vinculada', r.notLinked.length);
    if (r.errors.length) body += line('Errores ⚠️', r.errors.length);

    let detail = '';
    if (r.notFound.length) {
      const sample = r.notFound.slice(0, 10).map(esc).join(', ');
      detail += `<div style="margin-top:12px;font-size:12px;color:#94a3b8;border-top:1px solid #2a3441;padding-top:10px">No encontrados ni activos ni archivados (${r.notFound.length}): ${sample}${r.notFound.length > 10 ? '…' : ''}.</div>`;
    }
    if (r.notLinked.length) {
      const sample = r.notLinked.slice(0, 6).map((x) => esc(`${x.pn}→${x.file}`)).join('<br>');
      detail += `<div style="margin-top:8px;font-size:12px;color:#fcd34d">Foto del CSV no vinculada al PN (${r.notLinked.length}):<br>${sample}${r.notLinked.length > 6 ? '<br>…' : ''}</div>`;
    }
    if (r.errors.length) {
      detail += `<div style="margin-top:8px;font-size:12px;color:#fca5a5">${r.errors.slice(0, 5).map(esc).join('<br>')}${r.errors.length > 5 ? '<br>…' : ''}</div>`;
    }

    const hasReport = r.notFound.length || r.notLinked.length || r.errors.length || r.pdfDisplays.length;
    const exportBtn = hasReport ? `<button id="sa-bf-export" class="sa-upl-btn" style="background:#475569">Exportar reporte</button>` : '';
    const title = r.stopped ? '⚠️ Backfill detenido (memoria)' : 'Backfill completado';
    ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee;min-width:380px"><h2 style="color:${r.stopped ? '#fbbf24' : '#13a36f'}">${title}</h2><div style="font-size:13px;line-height:1.85">${body}</div>${detail}<div style="display:flex;gap:10px;margin-top:18px"><button id="sa-bf-close" class="sa-upl-btn" style="background:#13a36f">Cerrar</button>${exportBtn}</div></div>`;
    document.body.appendChild(ov);
    document.getElementById('sa-bf-close').onclick = () => ov.parentNode.removeChild(ov);
    const eb = document.getElementById('sa-bf-export');
    if (eb) eb.onclick = () => exportBackfillReport(r);
  }

  function exportBackfillReport(r) {
    const rows = ['tipo,pn,detalle'];
    for (const pn of r.notFound) rows.push(`no_encontrado,${csv(pn)},`);
    for (const nl of r.notLinked) rows.push(`foto_no_vinculada,${csv(nl.pn)},${csv(nl.file)}`);
    for (const pd of r.pdfDisplays) rows.push(`portada_pdf,${csv(pd.pn)},${csv(pd.file)}`);
    for (const e of r.errors) rows.push(`error,,${csv(e)}`);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'backfill_portadas_reporte.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── UI (dark mode: regla de diseño — distinguir de pantallas claras de Steelhead) ──
  // Inyecta el CSS dl9 propio: file-uploader corre aislado, y si ningún otro applet
  // (archiver/po-comparator/…) inyectó .dl9-* antes en esta tab, el overlay/resumen
  // quedan SIN estilos = invisibles. Idempotente por id propio.
  function ensureStyles() {
    if (document.getElementById('sa-uploader-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-uploader-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1c2430;color:#e6e9ee;border-radius:12px;padding:28px 32px;max-width:520px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 12px}.dl9-bar{height:10px;background:#0f291a;border-radius:6px;overflow:hidden;margin:14px 0 10px}.dl9-bar-fill{height:100%;width:40%;background:#13a36f;border-radius:6px;animation:saUplSlide 1.1s infinite ease-in-out}@keyframes saUplSlide{0%{margin-left:-40%}100%{margin-left:100%}}.dl9-progress{font-size:13px;color:#cbd5e1}.sa-upl-btn{padding:8px 20px;border:none;border-radius:6px;font-size:13px;cursor:pointer;color:#fff}#sa-upl-mem.sa-mem-warn{color:#fde68a}#sa-upl-mem.sa-mem-crit{color:#fca5a5;font-weight:600}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function showUploaderUI(msg) {
    ensureStyles();
    let ov = document.getElementById('sa-uploader-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-uploader-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee"><h2 style="color:#13a36f">Cargador de Archivos</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-upl-bar" style="background:#13a36f"></div></div><div class="dl9-progress" id="sa-upl-text"></div><div id="sa-upl-mem" style="margin-top:8px;font-family:ui-monospace,monospace;font-size:11px;color:#94a3b8"></div></div>`;
      document.body.appendChild(ov);
    }
    document.getElementById('sa-upl-text').textContent = msg;
  }

  function updateUploaderUI(msg) {
    const el = document.getElementById('sa-upl-text');
    if (el) el.textContent = msg;
  }

  function removeUploaderUI() {
    const ov = document.getElementById('sa-uploader-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // Resumen no bloqueante (reemplaza alert()). Lista los no encontrados y permite exportarlos.
  function showSummaryUI(r) {
    removeUploaderUI();
    ensureStyles();
    const ov = document.createElement('div');
    ov.id = 'sa-uploader-overlay';
    ov.className = 'dl9-overlay';
    const line = (label, val) => `<div style="display:flex;justify-content:space-between;gap:24px;padding:1px 0"><span>${label}</span><strong>${val}</strong></div>`;
    let body = line('Archivos seleccionados', r.selected)
      + line('Archivos subidos', r.uploaded)
      + line('Vínculos creados (PNs)', r.linked)
      + line('Display image marcada', r.displaySet)
      + line('Saltados (ya existían)', r.skipped)
      + line('PNs con homónimos', r.homonymGroups);
    if (r.unarchived) body += line('Desarchivados → re-archivados', `${r.rearchived}/${r.unarchived}`);
    if (r.notFound.length) body += line('PNs no encontrados', r.notFound.length);
    if (r.truncated.length) body += line('Búsquedas truncadas ⚠️', r.truncated.length);
    if (r.errors.length) body += line('Errores ⚠️', r.errors.length);

    let detail = '';
    if (r.notFound.length) {
      const names = [...new Set(r.notFound.map((x) => x.pnName))];
      const sample = names.slice(0, 10).map(esc).join(', ');
      detail += `<div style="margin-top:12px;font-size:12px;color:#94a3b8;border-top:1px solid #2a3441;padding-top:10px">No encontrados (${names.length} PN): ${sample}${names.length > 10 ? '…' : ''}</div>`;
    }
    if (r.errors.length) {
      detail += `<div style="margin-top:8px;font-size:12px;color:#fca5a5">${r.errors.slice(0, 6).map(esc).join('<br>')}${r.errors.length > 6 ? '<br>…' : ''}</div>`;
    }

    const exportBtn = (r.notFound.length || r.errors.length)
      ? `<button id="sa-upl-export" class="sa-upl-btn" style="background:#475569">Exportar no encontrados</button>` : '';
    const title = r.stopped ? '⚠️ Carga detenida (memoria)' : 'Carga completada';
    ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee;min-width:360px"><h2 style="color:${r.stopped ? '#fbbf24' : '#13a36f'}">${title}</h2><div style="font-size:13px;line-height:1.85">${body}</div>${detail}<div style="display:flex;gap:10px;margin-top:18px"><button id="sa-upl-close" class="sa-upl-btn" style="background:#13a36f">Cerrar</button>${exportBtn}</div></div>`;
    document.body.appendChild(ov);
    document.getElementById('sa-upl-close').onclick = () => ov.parentNode.removeChild(ov);
    const eb = document.getElementById('sa-upl-export');
    if (eb) eb.onclick = () => exportReport(r);
  }

  // Descarga un CSV con los no encontrados y errores, para corregir y re-correr.
  function exportReport(r) {
    const rows = ['tipo,detalle,archivo'];
    for (const nf of r.notFound) rows.push(`no_encontrado,${csv(nf.pnName)},${csv(nf.fileName)}`);
    for (const e of r.errors) rows.push(`error,${csv(e)},`);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cargador_no_encontrados.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const csv = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

  return { run, runBackfill, runBackfillFromPopup };
})();

if (typeof window !== 'undefined') window.FileUploader = FileUploader;
