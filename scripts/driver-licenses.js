// Licencias de Choferes — panel de administración (UI + red).
//
// Administra las identificaciones de los choferes EXTERNOS y publica el catálogo al hook
// low-code `pdf:SHIPMENT_TEMPLATE`, que pinta la licencia en la lista de embarque cuando el
// nombre del chofer aparece en las notas o en el nombre del embarque.
//
// La lógica pura (llaves, catálogo, bloque, diff, validaciones) vive en
// `driver-licenses-core.js` con tests en `tools/test/driver-licenses-core.test.js`.
// Aquí sólo hay DOM y red.
//
// ⚠ ESTE APPLET PUBLICA CÓDIGO PRODUCTIVO. Por eso la publicación:
//   · relee el hook del servidor (nunca una copia local),
//   · muestra el diff de catálogo Y el diff de código,
//   · exige confirmación explícita,
//   · aborta si los marcadores faltan o están duplicados,
//   · verifica que `code` y `compiled` queden byte-idénticos antes de mandar.
// Contrato: SteelheadPowerTools/docs/specs/2026-08-05-applet-licencias-choferes.md
//
// Bitácora: docs/applets/driver-licenses.md
(function () {
  'use strict';

  const CORE = window.DriverLicensesCore;
  const api = () => window.SteelheadAPI;

  const PANEL_ID = 'sa-driver-licenses-panel';
  const FOLDER_NAME = 'Licencias';
  const PDF_TYPE = 'SHIPMENT_TEMPLATE';

  // Paleta de la extensión (UI propia SIEMPRE en dark, para que el operador distinga de un
  // vistazo que no es una pantalla nativa de Steelhead).
  const C_BG = '#1c2430', C_FG = '#e6e9ee', C_INPUT = '#141a23', C_ACCENT = '#13a36f';
  const C_MUTED = '#8b97a8', C_AMBER = '#e0a33e', C_RED = '#e06c60', C_LINE = '#2b3644';

  let state = { files: [], published: null, hookSource: '', hookCompiled: '', busy: false };

  const log = (m) => { try { api().log('[driver-licenses] ' + m); } catch (e) { /* noop */ } };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── Red ───────────────────────────────────────────────────────────────────

  // Dos pasadas: `fetchFolderless` es excluyente. Con false llegan las que están EN carpeta
  // (las que se subieron a mano); con true, las sueltas — que son las que sube este applet,
  // porque CreateUserFile no puede asignar carpeta. El filtro real lo hace el core.
  async function fetchLicenseFiles() {
    const byName = new Map();
    for (const folderless of [false, true]) {
      let offset = 0;
      const page = 100;
      for (;;) {
        const data = await api().query('SearchUserFilesQuery', {
          includeArchived: 'NO', fetchCustomer: false, fetchCreator: false,
          fetchPartNumber: false, fetchReceivedOrder: false, fetchWorkOrder: false,
          fetchVendor: false, offset, first: page,
          orderBy: ['CREATED_AT_DESC'], searchQuery: '', fetchFolderless: folderless
        });
        const nodes = (data && data.searchUserFiles && data.searchUserFiles.nodes) || [];
        nodes.forEach((n) => { if (n && n.name && !byName.has(n.name)) byName.set(n.name, n); });
        if (nodes.length < page) break;
        offset += page;
      }
    }
    const all = Array.from(byName.values());
    all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return CORE.selectLicenseFiles(all, FOLDER_NAME);
  }

  async function fetchHook() {
    const data = await api().query('PdfLowCode', { pdfType: PDF_TYPE });
    // El shape varía según la forma del slot; se busca el nodo que traiga `code`.
    const node = data && (data.pdfLowCode || data.PdfLowCode || data);
    const found = node && (node.code ? node : (node.nodes && node.nodes[0]));
    if (!found || typeof found.code !== 'string') {
      throw new Error('No se pudo leer el hook de embarques del servidor.');
    }
    return { code: found.code, compiled: found.compiled || '' };
  }

  async function uploadBinary(file) {
    const fd = new FormData();
    fd.append('myfile', file, file.name);
    const resp = await fetch('/api/files', { method: 'POST', credentials: 'include', body: fd });
    if (!resp.ok) throw new Error('La subida falló (HTTP ' + resp.status + ').');
    return await resp.json(); // { name, originalName }
  }

  // El `originalName` que se REGISTRA no es el del archivo de origen: es el nombre con el que
  // el operador quiere que se le nombre en el embarque, con el prefijo del applet.
  async function registerFile(generatedName, registeredName) {
    const data = await api().query('CreateUserFile', {
      name: generatedName, originalName: registeredName
    });
    return data && data.createUserFile && data.createUserFile.userFile;
  }

  async function publishHook(code, compiled) {
    return await api().query('CreatePdfLowCode', { code, compiled, pdfType: PDF_TYPE });
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  function closePanel() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    // Libera el estado: el panel puede abrirse muchas veces en una sesión larga y estos
    // arreglos traen nodos completos del ERP.
    state = { files: [], published: null, hookSource: '', hookCompiled: '', busy: false };
  }

  function shell() {
    closePanel();
    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;
    wrap.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:640px', 'max-width:100vw', 'height:100vh',
      'background:' + C_BG, 'color:' + C_FG, 'z-index:2147483000', 'display:flex',
      'flex-direction:column', 'box-shadow:-8px 0 32px rgba(0,0,0,.45)',
      'font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif'
    ].join(';');
    wrap.innerHTML = `
      <div style="padding:14px 18px;border-bottom:1px solid ${C_LINE};display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">🪪</span>
        <div style="flex:1">
          <div style="font-weight:600">Licencias de Choferes</div>
          <div style="color:${C_MUTED};font-size:11px">Identificaciones de choferes externos para la lista de embarque</div>
        </div>
        <button id="dl-close" style="background:none;border:none;color:${C_MUTED};font-size:20px;cursor:pointer">×</button>
      </div>
      <div id="dl-body" style="flex:1;overflow:auto;padding:16px 18px"></div>
      <div id="dl-foot" style="padding:12px 18px;border-top:1px solid ${C_LINE};display:flex;gap:8px;align-items:center"></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#dl-close').onclick = closePanel;
    return wrap;
  }

  function setBody(html) {
    const b = document.getElementById('dl-body');
    if (b) b.innerHTML = html;
  }
  function setFoot(html) {
    const f = document.getElementById('dl-foot');
    if (f) f.innerHTML = html;
  }

  function btn(id, label, kind) {
    const bg = kind === 'primary' ? C_ACCENT : 'transparent';
    const bd = kind === 'primary' ? C_ACCENT : C_LINE;
    const fg = kind === 'primary' ? '#04140d' : C_FG;
    return `<button id="${id}" style="background:${bg};border:1px solid ${bd};color:${fg};
      padding:7px 14px;border-radius:6px;cursor:pointer;font-weight:${kind === 'primary' ? 600 : 400}">${esc(label)}</button>`;
  }

  // ── Vista principal ───────────────────────────────────────────────────────

  async function render() {
    setBody(`<div style="color:${C_MUTED}">Leyendo licencias y catálogo publicado…</div>`);
    setFoot('');
    try {
      const [files, hook] = await Promise.all([fetchLicenseFiles(), fetchHook()]);
      state.files = files;
      state.hookSource = hook.code;
      state.hookCompiled = hook.compiled;
      state.published = CORE.parseBlockCatalog(hook.code);
    } catch (e) {
      setBody(`<div style="color:${C_RED}">No se pudo cargar: ${esc(e.message || e)}</div>`);
      setFoot(btn('dl-retry', 'Reintentar', 'primary'));
      const r = document.getElementById('dl-retry'); if (r) r.onclick = render;
      return;
    }

    // AUSENTE ≠ VACÍO: si el bloque no se pudo leer, se dice; no se asume catálogo vacío
    // (publicar sobre esa suposición borraría todas las licencias).
    if (state.published === null) {
      setBody(`<div style="border:1px solid ${C_RED};border-radius:8px;padding:14px;color:${C_RED}">
        <b>El hook de embarques no tiene los marcadores del catálogo.</b><br>
        Fue editado a mano. No se puede publicar desde aquí hasta restaurarlos
        (<code>${esc(CORE.MARK_START)}</code> … <code>${esc(CORE.MARK_END)}</code>).
      </div>`);
      setFoot(btn('dl-retry', 'Reintentar', ''));
      const r = document.getElementById('dl-retry'); if (r) r.onclick = render;
      return;
    }

    const inv = CORE.buildInventory(state.files, state.published);
    const next = CORE.buildCatalog(state.files).catalog;
    const diff = CORE.diffCatalogs(state.published, next);

    const rows = inv.rows.map((r) => {
      const color = r.status === 'publicado' ? C_ACCENT : (r.status === 'desactualizado' ? C_AMBER : C_MUTED);
      const label = r.status === 'publicado' ? 'publicada'
        : (r.status === 'desactualizado' ? 'cambió, falta publicar' : 'falta publicar');
      return `<tr style="border-top:1px solid ${C_LINE}">
        <td style="padding:7px 4px;font-weight:600">${esc(r.key)}</td>
        <td style="padding:7px 4px;color:${C_MUTED};font-size:11px">${esc(r.file)}</td>
        <td style="padding:7px 4px;color:${color};text-align:right;white-space:nowrap">${label}</td>
      </tr>`;
    }).join('');

    // Se marca la EXCEPCIÓN, no la norma: sólo se pinta el bloque de huérfanas si las hay.
    const orphanBlock = inv.orphans.length ? `
      <div style="margin-top:14px;border:1px solid ${C_AMBER};border-radius:8px;padding:10px 12px;color:${C_AMBER}">
        <b>${inv.orphans.length} licencia(s) publicada(s) sin archivo:</b>
        ${esc(inv.orphans.map((o) => o.key).join(', '))}.<br>
        <span style="color:${C_MUTED}">Se siguen imprimiendo con una liga que ya nadie administra. Vuelve a subirlas o publica para quitarlas.</span>
      </div>` : '';

    const warnBlock = inv.warnings.length ? `
      <div style="margin-top:14px;border:1px solid ${C_AMBER};border-radius:8px;padding:10px 12px;color:${C_AMBER}">
        ${inv.warnings.map((w) => esc(w)).join('<br>')}
      </div>` : '';

    setBody(`
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <b style="flex:1">${inv.rows.length} licencia(s)</b>
        <span style="color:${diff.isEmpty ? C_MUTED : C_AMBER}">
          ${diff.isEmpty ? 'catálogo publicado al día' : 'hay cambios sin publicar'}
        </span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="color:${C_MUTED};font-size:11px;text-align:left">
          <th style="padding:0 4px 6px">Se nombra así en el embarque</th>
          <th style="padding:0 4px 6px">Archivo</th>
          <th style="padding:0 4px 6px;text-align:right">Estado</th>
        </tr>
        ${rows || `<tr><td colspan="3" style="padding:12px 4px;color:${C_MUTED}">Todavía no hay licencias cargadas.</td></tr>`}
      </table>
      ${orphanBlock}${warnBlock}
      <div style="margin-top:18px;border-top:1px solid ${C_LINE};padding-top:14px">
        <div style="font-weight:600;margin-bottom:8px">Subir una licencia</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="dl-file" type="file" accept="image/*"
            style="background:${C_INPUT};color:${C_FG};border:1px solid ${C_LINE};border-radius:6px;padding:6px;flex:1;min-width:200px">
          <input id="dl-name" type="text" placeholder="Nombre en el embarque (ej. Fernando)"
            style="background:${C_INPUT};color:${C_FG};border:1px solid ${C_LINE};border-radius:6px;padding:7px 10px;flex:1;min-width:200px">
        </div>
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px;color:${C_MUTED};font-size:12px">
          <input id="dl-replace" type="checkbox"> Reemplazar si ya existe ese nombre
        </label>
        <div id="dl-upload-msg" style="margin-top:8px;font-size:12px"></div>
        <div style="margin-top:10px">${btn('dl-upload', 'Subir licencia', '')}</div>
        <div style="margin-top:10px;color:${C_MUTED};font-size:11px;line-height:1.5">
          Sube <b>foto y nombre</b>, no la credencial completa: la liga queda dentro de un PDF que
          se manda al cliente y <b>se puede abrir sin contraseña</b>. El gafete de la transportista
          es el documento adecuado; la credencial de elector no.
        </div>
      </div>`);

    setFoot(`
      <span style="flex:1;color:${C_MUTED};font-size:12px">
        ${diff.isEmpty ? 'No hay nada que publicar.'
          : `${diff.added.length} alta(s) · ${diff.changed.length} cambio(s) · ${diff.removed.length} baja(s)`}
      </span>
      ${btn('dl-publish', 'Revisar y publicar…', diff.isEmpty ? '' : 'primary')}`);

    document.getElementById('dl-upload').onclick = onUpload;
    const pub = document.getElementById('dl-publish');
    pub.onclick = () => showPublishConfirm(next, diff);
    pub.disabled = diff.isEmpty;
    if (diff.isEmpty) pub.style.opacity = '.5';
  }

  // ── Subir ─────────────────────────────────────────────────────────────────

  async function onUpload() {
    if (state.busy) return;
    const msg = document.getElementById('dl-upload-msg');
    const fileEl = document.getElementById('dl-file');
    const nameEl = document.getElementById('dl-name');
    const replace = document.getElementById('dl-replace').checked;
    const file = fileEl.files && fileEl.files[0];

    const say = (text, color) => { msg.style.color = color || C_MUTED; msg.textContent = text; };

    if (!file) return say('Elige el archivo de la licencia.', C_AMBER);
    if (!CORE.isImageFile(file.name)) {
      return say('Tiene que ser una imagen (PNG o JPG): un PDF no se puede pintar en el PDF de embarque.', C_AMBER);
    }
    const current = CORE.buildCatalog(state.files).catalog;
    const check = CORE.validateDriverName(nameEl.value, current, { allowReplace: replace });
    if (!check.ok) return say(check.message, C_AMBER);

    state.busy = true;
    try {
      say('Subiendo…');
      const uploaded = await uploadBinary(file);
      const registeredName = CORE.buildUploadName(check.key, file.name);
      await registerFile(uploaded.name, registeredName);
      say('Listo: «' + check.key + '» quedó cargada. Falta publicar el catálogo.', C_ACCENT);
      nameEl.value = '';
      fileEl.value = '';
      log('subida ' + registeredName + ' → ' + uploaded.name);
      await render();
    } catch (e) {
      say('No se pudo subir: ' + (e.message || e), C_RED);
      log('ERROR subida: ' + (e.message || e));
    } finally {
      state.busy = false;
    }
  }

  // ── Publicar: aviso + diff + confirmación ─────────────────────────────────

  function showPublishConfirm(next, diff) {
    const lines = [];
    diff.added.forEach((k) => lines.push(`<div style="color:${C_ACCENT}">+ alta: <b>${esc(k)}</b></div>`));
    diff.changed.forEach((c) => lines.push(
      `<div style="color:${C_AMBER}">~ cambia: <b>${esc(c.key)}</b> <span style="font-size:11px">(${esc(c.from)} → ${esc(c.to)})</span></div>`));
    diff.removed.forEach((k) => lines.push(`<div style="color:${C_RED}">− baja: <b>${esc(k)}</b></div>`));

    let block, codeDiff;
    try {
      block = CORE.renderBlock(next, FOLDER_NAME);
      codeDiff = block;
    } catch (e) {
      setBody(`<div style="color:${C_RED}">${esc(e.message || e)}</div>`);
      return;
    }

    setBody(`
      <div style="border:1px solid ${C_AMBER};border-radius:8px;padding:12px 14px;color:${C_AMBER};margin-bottom:14px">
        <b>⚠ Esto publica una versión nueva del CÓDIGO del hook de listas de embarque.</b><br>
        <span style="color:${C_FG}">La versión actual queda en el historial y se puede volver a ella.
        Se publica en <b>el dominio donde estás ahora</b>; el otro dominio queda pendiente.</span>
      </div>
      <div style="font-weight:600;margin-bottom:6px">Qué cambia</div>
      <div style="background:${C_INPUT};border:1px solid ${C_LINE};border-radius:8px;padding:10px 12px;margin-bottom:14px">
        ${lines.join('') || `<span style="color:${C_MUTED}">Sin cambios.</span>`}
      </div>
      <div style="font-weight:600;margin-bottom:6px">Bloque que se va a escribir</div>
      <pre style="background:${C_INPUT};border:1px solid ${C_LINE};border-radius:8px;padding:10px 12px;
        overflow:auto;max-height:240px;font-size:11px;margin:0">${esc(codeDiff)}</pre>`);

    setFoot(`${btn('dl-cancel', 'Cancelar', '')}<span style="flex:1"></span>${btn('dl-confirm', 'Publicar el catálogo', 'primary')}`);
    document.getElementById('dl-cancel').onclick = render;
    document.getElementById('dl-confirm').onclick = () => doPublish(next);
  }

  async function doPublish(next) {
    if (state.busy) return;
    state.busy = true;
    setFoot(`<span style="color:${C_MUTED}">Publicando…</span>`);
    try {
      // Se RELEE del servidor: entre que se abrió el panel y ahora, alguien más pudo publicar.
      const fresh = await fetchHook();
      const block = CORE.renderBlock(next, FOLDER_NAME);
      const newCode = CORE.replaceBlock(fresh.code, block);
      const newCompiled = fresh.compiled ? CORE.replaceBlock(fresh.compiled, block) : '';

      if (!newCompiled) {
        throw new Error('El hook del servidor no trae el JS compilado; no se publicó nada.');
      }
      // Red de seguridad: si los dos bloques no quedaron idénticos, el hook publicado correría
      // un catálogo distinto al que dice su fuente.
      if (!CORE.blocksMatch(newCode, newCompiled)) {
        throw new Error('El bloque quedó distinto en el código y en el compilado; no se publicó nada.');
      }

      await publishHook(newCode, newCompiled);
      log('publicado: ' + Object.keys(next).length + ' entradas');

      setBody(`
        <div style="border:1px solid ${C_ACCENT};border-radius:8px;padding:14px;color:${C_ACCENT}">
          <b>Catálogo publicado</b> con ${Object.keys(next).length} licencia(s) en este dominio.
        </div>
        <div style="margin-top:14px;border:1px solid ${C_AMBER};border-radius:8px;padding:12px 14px;color:${C_AMBER}">
          <b>Falta el otro dominio.</b> Este applet publica donde estás ahora. Para dejar TLC y MTY
          iguales, abre el otro dominio y publica de nuevo desde aquí.<br>
          <span style="color:${C_MUTED}">Mientras tanto los dos dominios están desalineados.</span>
        </div>`);
      setFoot(btn('dl-back', 'Volver al listado', ''));
      document.getElementById('dl-back').onclick = render;
    } catch (e) {
      setBody(`<div style="border:1px solid ${C_RED};border-radius:8px;padding:14px;color:${C_RED}">
        <b>No se publicó nada.</b><br>${esc(e.message || e)}</div>`);
      setFoot(btn('dl-back', 'Volver', ''));
      document.getElementById('dl-back').onclick = render;
      log('ERROR publicar: ' + (e.message || e));
    } finally {
      state.busy = false;
    }
  }

  // ── Entrada ───────────────────────────────────────────────────────────────

  async function open() {
    if (!CORE) { alert('No cargó el núcleo de Licencias de Choferes.'); return; }
    shell();
    await render();
  }

  window.DriverLicenses = { open, close: closePanel };
})();
