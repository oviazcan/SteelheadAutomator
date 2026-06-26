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

  // Sube el binario una sola vez a Steelhead.
  async function uploadBinary(file) {
    const formData = new FormData();
    formData.append('myfile', file, file.name);
    const resp = await fetch('/api/files', { method: 'POST', credentials: 'include', body: formData });
    if (!resp.ok) throw new Error(`Upload HTTP ${resp.status}`);
    return await resp.json(); // { name: "generated.pdf", originalName: "original.pdf" }
  }

  async function registerFile(generatedName, originalName) {
    const data = await api().query('CreateUserFile', { name: generatedName, originalName });
    return data?.createUserFile?.userFile;
  }

  async function linkToPN(partNumberId, generatedName) {
    const data = await api().query('CreatePartNumberUserFile', { partNumberId, fileName: generatedName });
    return data?.createPartNumberUserFile?.partNumberUserFile;
  }

  // archivedAt: null = desarchivar; timestamp ISO = (re)archivar.
  async function setArchived(partNumberId, archivedAt) {
    await api().query('UpdatePartNumber', { id: partNumberId, archivedAt });
  }

  // Paginación + filtro de exactos, parametrizada por operación (activos vs incluir archivados).
  async function paginateExact(opName, name, extraVars) {
    const PAGE = 50, MAX_PAGES = 6;
    let all = [], truncated = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const data = await api().query(opName, { searchQuery: name, first: PAGE, offset: p * PAGE, orderBy: ['ID_DESC'], ...extraVars });
      const nodes = data?.searchPartNumbers?.nodes || data?.pagedData?.nodes || data?.allPartNumbers?.nodes || [];
      all = all.concat(nodes);
      if (nodes.length < PAGE) break;
      if (p === MAX_PAGES - 1) truncated = true;
    }
    return { matches: core().selectMatchingPNs(all, name), truncated };
  }

  // PNs ACTIVOS con ese nombre exacto (SearchPartNumbers no devuelve archivados).
  const findActivePNs = (name) => paginateExact('SearchPartNumbers', name, {});
  // PNs (incluye archivados) — para hallar los que SearchPartNumbers no ve.
  const findAnyPNs = (name) => paginateExact('AllPartNumbers', name, { includeArchived: 'YES' });

  // GetPartNumber → { archivedAt original, names: set de originalName ya vinculados }.
  async function getPNDetail(pnId) {
    const data = await api().query('GetPartNumber', { partNumberId: pnId, usagesLimit: 10, usagesOffset: 0 });
    const pn = data?.partNumberById || {};
    return { archivedAt: pn.archivedAt || null, names: core().existingOriginalNames(pn) };
  }

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
          await linkToPN(pn.id, gen);
          results.linked++;
          detailById.get(pn.id).names.add(core().norm(file.name));
        }
        log(`  "${file.name}" → ${targets.length} PN(s)`);
      } catch (e) {
        results.errors.push(`"${file.name}": ${String(e).substring(0, 80)}`);
      }
    }
  }

  // Grupo cuyos PNs están ARCHIVADOS: desarchivar → vincular → re-archivar (archivedAt original).
  async function processArchivedGroup(group, pns, results) {
    if (pns.length > 1) results.homonymGroups++;
    const detailById = new Map();
    for (const pn of pns) {
      try { detailById.set(pn.id, await getPNDetail(pn.id)); }
      catch (e) { detailById.set(pn.id, { archivedAt: null, names: new Set() }); results.errors.push(`leer PN ${pn.name}: ${String(e).substring(0, 60)}`); }
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
      uploaded: 0, linked: 0, skipped: 0, homonymGroups: 0, unarchived: 0, rearchived: 0,
      notFound: [], truncated: [], errors: [],
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

    try {
      let gi = 0;
      for (const [pnName, group] of groups) {
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
              catch (e) { detailById.set(pn.id, { archivedAt: null, names: new Set() }); warn(`leer PN ${pn.id}: ${e}`); }
            }
            await linkGroupToPNs(group, active.matches, detailById, results);
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
      }
    } finally {
      showSummaryUI(results); // SIEMPRE muestra el resumen, aunque algo haya tronado
    }
    return results;
  }

  // ── UI (dark mode: regla de diseño — distinguir de pantallas claras de Steelhead) ──
  // Inyecta el CSS dl9 propio: file-uploader corre aislado, y si ningún otro applet
  // (archiver/po-comparator/…) inyectó .dl9-* antes en esta tab, el overlay/resumen
  // quedan SIN estilos = invisibles. Idempotente por id propio.
  function ensureStyles() {
    if (document.getElementById('sa-uploader-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-uploader-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1c2430;color:#e6e9ee;border-radius:12px;padding:28px 32px;max-width:520px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 12px}.dl9-bar{height:10px;background:#0f291a;border-radius:6px;overflow:hidden;margin:14px 0 10px}.dl9-bar-fill{height:100%;width:40%;background:#13a36f;border-radius:6px;animation:saUplSlide 1.1s infinite ease-in-out}@keyframes saUplSlide{0%{margin-left:-40%}100%{margin-left:100%}}.dl9-progress{font-size:13px;color:#cbd5e1}.sa-upl-btn{padding:8px 20px;border:none;border-radius:6px;font-size:13px;cursor:pointer;color:#fff}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function showUploaderUI(msg) {
    ensureStyles();
    let ov = document.getElementById('sa-uploader-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-uploader-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee"><h2 style="color:#13a36f">Cargador de Archivos</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-upl-bar" style="background:#13a36f"></div></div><div class="dl9-progress" id="sa-upl-text"></div></div>`;
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
    ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee;min-width:360px"><h2 style="color:#13a36f">Carga completada</h2><div style="font-size:13px;line-height:1.85">${body}</div>${detail}<div style="display:flex;gap:10px;margin-top:18px"><button id="sa-upl-close" class="sa-upl-btn" style="background:#13a36f">Cerrar</button>${exportBtn}</div></div>`;
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

  return { run };
})();

if (typeof window !== 'undefined') window.FileUploader = FileUploader;
