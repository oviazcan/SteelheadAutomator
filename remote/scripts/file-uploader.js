// Steelhead File Uploader
// Uploads files to PNs matching by filename
// Flow: /api/files (binary) → CreateUserFile (register) → CreatePartNumberUserFile (link to PN)
// Depends on: SteelheadAPI

const FileUploader = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // Upload a single file binary to Steelhead
  async function uploadBinary(file) {
    const formData = new FormData();
    formData.append('myfile', file, file.name);

    const resp = await fetch('/api/files', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });

    if (!resp.ok) throw new Error(`Upload HTTP ${resp.status}`);
    const result = await resp.json();
    return result; // { name: "generated.pdf", originalName: "original.pdf" }
  }

  // Register file in Steelhead's file system
  async function registerFile(generatedName, originalName) {
    const data = await api().query('CreateUserFile', {
      name: generatedName,
      originalName: originalName
    });
    return data?.createUserFile?.userFile;
  }

  // Link file to a Part Number
  async function linkToPN(partNumberId, generatedName) {
    const data = await api().query('CreatePartNumberUserFile', {
      partNumberId: partNumberId,
      fileName: generatedName
    });
    return data?.createPartNumberUserFile?.partNumberUserFile;
  }

  // Search PN by name to get ID
  async function findPNByName(name) {
    const data = await api().query('SearchPartNumbers', {
      searchQuery: name, first: 20, offset: 0, orderBy: ['ID_DESC']
    });
    const nodes = data?.searchPartNumbers?.nodes || data?.pagedData?.nodes || [];
    // Exact match (case insensitive, trimmed)
    const match = nodes.find(n => n.name?.toUpperCase().trim() === name.toUpperCase().trim());
    return match || null;
  }

  // Main flow: upload multiple files
  async function run(files) {
    const results = { uploaded: 0, linked: 0, notFound: [], errors: [] };

    if (!files?.length) return { error: 'No se seleccionaron archivos' };

    log(`FileUploader: ${files.length} archivos seleccionados`);
    showUploaderUI(`Procesando ${files.length} archivos...`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Extract PN name from filename (without extension)
      const pnName = file.name.replace(/\.[^.]+$/, '').trim();
      const pct = Math.round((i / files.length) * 100);
      updateUploaderUI(`${i + 1}/${files.length} (${pct}%) — "${pnName}" — ${results.linked} vinculados`);

      // Find PN
      const pn = await findPNByName(pnName);
      if (!pn) {
        results.notFound.push({ fileName: file.name, pnName });
        warn(`PN "${pnName}" no encontrado para "${file.name}"`);
        continue;
      }

      try {
        // 1. Upload binary
        const uploadResult = await uploadBinary(file);
        results.uploaded++;
        log(`  "${file.name}" → ${uploadResult.name}`);

        // 2. Register in Steelhead
        await registerFile(uploadResult.name, file.name);

        // 3. Link to PN
        await linkToPN(pn.id, uploadResult.name);
        results.linked++;
        log(`  Vinculado a PN "${pn.name}" (id:${pn.id})`);
      } catch (e) {
        results.errors.push(`"${file.name}": ${String(e).substring(0, 80)}`);
      }
    }

    removeUploaderUI();

    const summary = `Carga de archivos completada:\n\n` +
      `${results.uploaded} archivos subidos\n` +
      `${results.linked} vinculados a PNs\n` +
      (results.notFound.length ? `${results.notFound.length} PNs no encontrados: ${results.notFound.map(f => f.pnName).slice(0, 10).join(', ')}${results.notFound.length > 10 ? '...' : ''}\n` : '') +
      (results.errors.length ? `${results.errors.length} errores\n` : '');

    alert(summary);
    return results;
  }

  // ── UI ──
  function showUploaderUI(msg) {
    let ov = document.getElementById('sa-uploader-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-uploader-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#2e1a2e"><h2 style="color:#c084fc">Cargador de Archivos</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-upl-bar" style="background:#c084fc"></div></div><div class="dl9-progress" id="sa-upl-text"></div></div>`;
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

  return { run };
})();

if (typeof window !== 'undefined') window.FileUploader = FileUploader;
