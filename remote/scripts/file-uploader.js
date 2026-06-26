// Steelhead File Uploader
// Sube archivos (fotos/planos) y los vincula a Part Numbers, matcheando por nombre.
// Convención de nombre: <PN>__<descriptor>.<ext>  (ver file-uploader-core.js).
// Flow por archivo: /api/files (binario) → CreateUserFile (registrar) → CreatePartNumberUserFile (vincular).
// Inteligencia de matching/dedup en FileUploaderCore (puro + tests).
// Depends on: SteelheadAPI, FileUploaderCore

const FileUploader = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const core = () => window.FileUploaderCore;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // Sube el binario una sola vez a Steelhead.
  async function uploadBinary(file) {
    const formData = new FormData();
    formData.append('myfile', file, file.name);
    const resp = await fetch('/api/files', { method: 'POST', credentials: 'include', body: formData });
    if (!resp.ok) throw new Error(`Upload HTTP ${resp.status}`);
    return await resp.json(); // { name: "generated.pdf", originalName: "original.pdf" }
  }

  // Registra el archivo en el sistema de archivos de Steelhead.
  async function registerFile(generatedName, originalName) {
    const data = await api().query('CreateUserFile', { name: generatedName, originalName });
    return data?.createUserFile?.userFile;
  }

  // Vincula un archivo ya registrado a un PN.
  async function linkToPN(partNumberId, generatedName) {
    const data = await api().query('CreatePartNumberUserFile', { partNumberId, fileName: generatedName });
    return data?.createPartNumberUserFile?.partNumberUserFile;
  }

  // TODOS los PNs cuyo nombre coincide EXACTO con `name`.
  // Pagina SearchPartNumbers (búsqueda difusa) y filtra exactos en el core:
  // first:20 a secas deja fuera exactos de id bajo cuando hay ruido de substrings.
  async function findAllPNsByName(name) {
    const PAGE = 50, MAX_PAGES = 6;
    let all = [], truncated = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const data = await api().query('SearchPartNumbers', {
        searchQuery: name, first: PAGE, offset: p * PAGE, orderBy: ['ID_DESC'],
      });
      const nodes = data?.searchPartNumbers?.nodes || data?.pagedData?.nodes || [];
      all = all.concat(nodes);
      if (nodes.length < PAGE) break;       // última página
      if (p === MAX_PAGES - 1) truncated = true;
    }
    return { matches: core().selectMatchingPNs(all, name), truncated };
  }

  // Archivos que el PN YA tiene (set de originalName normalizados).
  // Lee SOLO partNumberUserFilesByPartNumberId; ignora buckets de nodo/instrucciones.
  async function existingNamesForPN(pnId) {
    const data = await api().query('GetPartNumber', { partNumberId: pnId, usagesLimit: 10, usagesOffset: 0 });
    return core().existingOriginalNames(data?.partNumberById || {});
  }

  // Flujo principal.
  async function run(files) {
    const results = {
      uploaded: 0, linked: 0, skipped: 0, homonymGroups: 0,
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

    let gi = 0;
    for (const [pnName, group] of groups) {
      gi++;
      const pct = Math.round((gi / groups.size) * 100);
      updateUploaderUI(`${gi}/${groups.size} (${pct}%) — "${pnName}" — ${results.linked} vinculados`);

      const { matches, truncated } = await findAllPNsByName(pnName);
      if (truncated) results.truncated.push(pnName);
      if (!matches.length) {
        for (const f of group) results.notFound.push({ fileName: f.name, pnName });
        warn(`PN "${pnName}" no encontrado (${group.length} archivos)`);
        continue;
      }
      if (matches.length > 1) results.homonymGroups++;

      // Archivos existentes por cada PN homónimo (se descarta al cambiar de grupo → no acumula).
      const existing = new Map();
      for (const pn of matches) {
        try { existing.set(pn.id, await existingNamesForPN(pn.id)); }
        catch (e) { existing.set(pn.id, new Set()); warn(`No se pudieron leer archivos de PN ${pn.id}: ${e}`); }
      }

      for (const file of group) {
        // PNs homónimos que AÚN no tienen este archivo (idempotencia: no duplicar/encimar).
        const targets = matches.filter((pn) => !core().isAlreadyLinked(existing.get(pn.id), file.name));
        if (!targets.length) { results.skipped++; continue; }
        try {
          const up = await uploadBinary(file);
          results.uploaded++;
          await registerFile(up.name, file.name);
          for (const pn of targets) {
            await linkToPN(pn.id, up.name);
            results.linked++;
            existing.get(pn.id)?.add(core().norm(file.name));
          }
          log(`  "${file.name}" → ${targets.length} PN(s)`);
        } catch (e) {
          results.errors.push(`"${file.name}": ${String(e).substring(0, 80)}`);
        }
      }
    }

    showSummaryUI(results);
    return results;
  }

  // ── UI (dark mode: regla de diseño — distinguir de pantallas claras de Steelhead) ──
  function showUploaderUI(msg) {
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

  // Resumen no bloqueante (reemplaza alert()).
  function showSummaryUI(r) {
    removeUploaderUI();
    const ov = document.createElement('div');
    ov.id = 'sa-uploader-overlay';
    ov.className = 'dl9-overlay';
    const line = (label, val) => `<div style="display:flex;justify-content:space-between;gap:24px"><span>${label}</span><strong>${val}</strong></div>`;
    let body = line('Archivos subidos', r.uploaded)
      + line('Vínculos creados (PNs)', r.linked)
      + line('Saltados (ya existían)', r.skipped)
      + line('PNs con homónimos', r.homonymGroups);
    if (r.notFound.length) body += line('PNs no encontrados', r.notFound.length);
    if (r.truncated.length) body += line('Búsquedas truncadas ⚠️', r.truncated.length);
    if (r.errors.length) body += line('Errores', r.errors.length);
    ov.innerHTML = `<div class="dl9-modal" style="background:#1c2430;color:#e6e9ee;min-width:340px"><h2 style="color:#13a36f">Carga completada</h2><div style="font-size:13px;line-height:1.9;margin:8px 0 16px">${body}</div><button id="sa-upl-close" style="padding:8px 20px;border:none;border-radius:6px;background:#13a36f;color:#fff;font-size:13px;cursor:pointer">Cerrar</button></div>`;
    document.body.appendChild(ov);
    document.getElementById('sa-upl-close').onclick = () => ov.parentNode.removeChild(ov);
  }

  return { run };
})();

if (typeof window !== 'undefined') window.FileUploader = FileUploader;
