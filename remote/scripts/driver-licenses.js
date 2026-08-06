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

  let state = { files: [], published: null, hookSource: '', hookCompiled: '', busy: false, exhausted: false };

  const log = (m) => { try { api().log('[driver-licenses] ' + m); } catch (e) { /* noop */ } };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── Miniatura ─────────────────────────────────────────────────────────────
  //
  // Sirve para contestar de un vistazo «¿la foto corresponde al chofer?», que hoy exige abrir
  // cada liga. `/api/files` entrega la imagen ORIGINAL —no hay thumbnails del lado del
  // servidor— así que va `loading="lazy"`: sólo baja lo que entra en pantalla.
  // Las identificaciones son APAISADAS (INE, licencia federal): un cuadro de 44px las
  // recortaba tanto que no se distinguía a la persona, que es justo para lo que sirve.
  const THUMB_W = 132, THUMB_H = 84;

  // Un archivo que no es imagen (o cuyo nombre no se pudo leer) NO se disfraza de foto rota:
  // se dibuja un marcador que dice qué pasa.
  function thumbPlaceholder(title, glyph) {
    return `<div title="${esc(title)}" style="width:${THUMB_W}px;height:${THUMB_H}px;`
      + `border:1px dashed ${C_LINE};border-radius:6px;display:flex;align-items:center;`
      + `justify-content:center;color:${C_MUTED};font-size:18px">${glyph}</div>`;
  }

  // ⚠️ NADA de HTML dentro de un atributo. El `onerror` inline llevaba el placeholder
  // completo —con sus comillas DOBLES— y cerraba el atributo antes de tiempo: el resto
  // (`'">`) caía al DOM como texto visible bajo CADA miniatura, cargara o no la imagen.
  // El handler se cablea con addEventListener después de pintar (`wireThumbs`).
  function thumbCell(fileName) {
    if (!fileName) return thumbPlaceholder('Sin archivo en la carpeta', '—');
    if (!CORE.isImageFile(fileName)) return thumbPlaceholder('El archivo no es una imagen', '📄');
    const url = CORE.buildLicenseUrl(fileName, location.origin);
    if (!url) return thumbPlaceholder('No se pudo armar la liga', '—');
    return `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" data-dl-thumb="1"
      style="width:${THUMB_W}px;height:${THUMB_H}px;object-fit:cover;border-radius:6px;
             border:1px solid ${C_LINE};background:${C_INPUT};display:block"
      title="${esc(fileName)}">`;
  }

  // Degradación de la miniatura, construida con DOM (no con strings): si la descarga falla,
  // se sustituye por el marcador en vez de dejar el icono de imagen rota del navegador.
  function wireThumbs(root) {
    const imgs = (root || document).querySelectorAll('img[data-dl-thumb]');
    imgs.forEach(function (img) {
      img.addEventListener('error', function onErr() {
        img.removeEventListener('error', onErr);
        const ph = document.createElement('div');
        ph.title = 'La imagen no cargó';
        ph.style.cssText = 'width:' + THUMB_W + 'px;height:' + THUMB_H + 'px;border:1px dashed '
          + C_LINE + ';border-radius:6px;display:flex;align-items:center;justify-content:center;'
          + 'color:' + C_MUTED + ';font-size:18px';
        ph.textContent = '⚠';
        if (img.parentNode) img.parentNode.replaceChild(ph, img);
      }, { once: true });
    });
  }

  // ── Red ───────────────────────────────────────────────────────────────────

  // Dos pasadas: `fetchFolderless` es excluyente. Con false llegan las que están EN carpeta
  // (las que se subieron a mano); con true, las sueltas — que son las que sube este applet,
  // porque CreateUserFile no puede asignar carpeta. El filtro real lo hace el core.
  //
  // ⚠️ EL FILTRO LO HACE EL SERVIDOR, con `searchQuery`. Antes se paginaba el catálogo
  // COMPLETO (23,147 archivos ⇒ ~460 peticiones) y eso TUMBABA LA SESIÓN del ERP: el
  // `/graphql` se cuelga a las ~40-45 y el límite es por SESIÓN, así que ni recargar salva
  // —y se caen también las pantallas nativas—. Ver CLAUDE.md §API de Steelhead.
  async function fetchLicenseFiles(publishedCatalog, onProgress) {
    const byName = new Map();
    const page = 100;
    let requests = 0;
    let exhausted = false;

    // Presupuesto DURO. Se prefiere una lista incompleta —dicha en voz alta— a dejar al
    // operador sin ERP: pasarse del límite no da error, cuelga la sesión completa.
    // `exact` = el término es el nombre completo de un archivo. En cuanto aparece se corta:
    // la segunda pasada (`fetchFolderless` es excluyente) ya no puede aportar nada, y cada
    // petición ahorrada es margen contra el límite por sesión. Medido: las de la carpeta
    // salen en la pasada `false`, así que el ahorro es real, no teórico.
    async function search(term, exact) {
      for (const folderless of [false, true]) {
        if (exact && byName.has(term)) return;
        for (let p = 0; p < CORE.MAX_PAGES; p++) {
          if (requests >= CORE.MAX_REQUESTS) { exhausted = true; return; }
          const data = await api().query('SearchUserFilesQuery', {
            includeArchived: 'NO', fetchCustomer: false, fetchCreator: false,
            fetchPartNumber: false, fetchReceivedOrder: false, fetchWorkOrder: false,
            fetchVendor: false, offset: p * page, first: page,
            orderBy: ['CREATED_AT_DESC'], searchQuery: term, fetchFolderless: folderless
          });
          requests++;
          if (onProgress) onProgress(requests, byName.size);
          const nodes = (data && data.searchUserFiles && data.searchUserFiles.nodes) || [];
          nodes.forEach((n) => { if (n && n.name && !byName.has(n.name)) byName.set(n.name, n); });
          if (nodes.length < page) break;   // última página de este término
        }
      }
    }

    // 1) El prefijo trae todas las que siguen la convención (las altas nuevas, siempre).
    await search(CORE.buildSearchTerms(null)[0]);
    // 2) Sólo lo publicado que NO apareció: las 8 viejas, subidas sin prefijo. Este
    //    número no crece con el catálogo, porque toda alta nueva cae en el paso 1.
    const missing = CORE.missingPublishedFiles(Array.from(byName.keys()), publishedCatalog);
    if (onProgress) onProgress(requests, byName.size, missing.length);
    for (let i = 0; i < missing.length && !exhausted; i++) await search(missing[i], true);

    log('archivos: ' + byName.size + ' en ' + requests + ' peticiones'
        + (exhausted ? ' — PRESUPUESTO AGOTADO, la lista puede estar incompleta' : ''));
    if (exhausted) {
      console.warn('[driver-licenses] se agotó el presupuesto de ' + CORE.MAX_REQUESTS
                   + ' peticiones; la lista puede estar incompleta.');
    }
    const all = Array.from(byName.values());
    all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { files: CORE.selectLicenseFiles(all, FOLDER_NAME), exhausted: exhausted };
  }

  async function fetchHook() {
    // `PdfLowCode` es un LISTADO paginado de versiones: `$first`/`$offset` son `Int!` y sin
    // ellos el ERP responde HTTP 400. La elección de la versión ACTIVA (la más reciente por
    // createdAt) vive en el core, testeada — publicar sobre una versión vieja no da error.
    const data = await api().query('PdfLowCode', CORE.hookQueryVariables(PDF_TYPE));
    const found = CORE.pickActiveHook(data);
    if (!found) {
      throw new Error('No se pudo leer el hook de embarques del servidor.');
    }
    return { code: found.code, compiled: found.compiled };
  }

  // Archiva la identificación en Steelhead. El patch SIEMPRE lleva la PK (`name`): sin ella
  // el ERP rechaza, y con ella escribe — por eso lo arma el core, no esta función.
  async function archiveFile(fileName) {
    const patch = CORE.buildArchivePatch(fileName, new Date().toISOString());
    if (!patch) throw new Error('No se pudo identificar el archivo a archivar.');
    return await api().query('UpdateMultipleUserFilesByName', { mnUserFilePatch: [patch] });
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
    state = { files: [], published: null, hookSource: '', hookCompiled: '', busy: false, exhausted: false };
  }

  function shell() {
    closePanel();
    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;
    wrap.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:820px', 'max-width:100vw', 'height:100vh',
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

  // ── Archivar (con confirmación) ───────────────────────────────────────────
  //
  // Archivar el ARCHIVO y quitarlo del CATÁLOGO son dos cosas distintas: si la licencia está
  // publicada, el hook la sigue pidiendo hasta que se publique de nuevo. El modal lo dice.
  function showArchiveConfirm(key, fileName) {
    const aviso = CORE.archiveWarning(key, state.published);
    setBody(`
      <div style="font-weight:600;margin-bottom:10px">Archivar «${esc(key)}»</div>
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px">
        ${thumbCell(fileName)}
        <div style="color:${C_MUTED};font-size:12px;line-height:1.6">
          Se archivará el archivo <b style="color:${C_FG}">${esc(fileName)}</b> en Steelhead.<br>
          Deja de aparecer en Uploaded Files; <b>no se borra</b> y se puede desarchivar desde el ERP.
        </div>
      </div>
      ${aviso ? `<div style="border:1px solid ${C_AMBER};border-radius:8px;padding:12px 14px;color:${C_AMBER}">
          <b>Ojo.</b> ${esc(aviso)}
        </div>` : ''}
      <div id="dl-arch-msg" style="margin-top:12px;font-size:12px"></div>`);
    setFoot(`${btn('dl-arch-cancel', 'Cancelar', '')}${btn('dl-arch-go', 'Sí, archivar', 'primary')}`);
    document.getElementById('dl-arch-cancel').onclick = render;
    document.getElementById('dl-arch-go').onclick = () => doArchive(key, fileName);
  }

  async function doArchive(key, fileName) {
    if (state.busy) return;
    state.busy = true;
    setFoot(`<span style="color:${C_MUTED}">Archivando…</span>`);
    try {
      await archiveFile(fileName);
      // La mutation no devuelve el registro: se RELEE. Si el archivo sigue apareciendo entre
      // los NO archivados, no se archivó — y decirlo importa más que aparentar que sí.
      const listed = await fetchLicenseFiles(state.published);
      const sigue = (listed.files || []).some((f) => f && f.name === fileName);
      state.files = listed.files;
      state.exhausted = listed.exhausted;
      log((sigue ? 'archivar NO se reflejó: ' : 'archivada: ') + fileName);
      setBody(`
        <div style="border:1px solid ${sigue ? C_AMBER : C_ACCENT};border-radius:8px;padding:14px;
                    color:${sigue ? C_AMBER : C_ACCENT}">
          ${sigue
            ? `<b>Se mandó, pero sigue apareciendo.</b> No pude confirmar que «${esc(key)}» quedara archivada.`
            : `<b>«${esc(key)}» quedó archivada</b> y verificada releyendo del servidor.`}
        </div>
        ${CORE.archiveWarning(key, state.published)
          ? `<div style="margin-top:12px;border:1px solid ${C_AMBER};border-radius:8px;padding:12px 14px;color:${C_AMBER}">
               Falta <b>publicar</b> para que deje de salir en la lista de embarque.
             </div>` : ''}`);
      setFoot(btn('dl-arch-back', 'Volver al listado', 'primary'));
      document.getElementById('dl-arch-back').onclick = render;
    } catch (e) {
      setBody(`<div style="border:1px solid ${C_RED};border-radius:8px;padding:14px;color:${C_RED}">
        <b>No se archivó.</b><br>${esc(e.message || e)}</div>`);
      setFoot(btn('dl-arch-back', 'Volver', ''));
      document.getElementById('dl-arch-back').onclick = render;
      log('ERROR archivar: ' + (e.message || e));
    } finally {
      state.busy = false;
    }
  }

  // ── Vista principal ───────────────────────────────────────────────────────

  // Progreso REAL, no un spinner decorativo: el denominador es el presupuesto de peticiones,
  // que es el techo verdadero. Sigue tardando aunque ya no sean ~460 llamadas, y el operador
  // necesita ver que avanza — un panel quieto se lee como colgado, que es justo lo que pasaba.
  function setProgress(step, total, note) {
    const pct = Math.max(4, Math.min(100, Math.round((step / Math.max(1, total)) * 100)));
    setBody(`
      <div style="color:${C_MUTED};margin-bottom:10px">Leyendo licencias y catálogo publicado…</div>
      <div style="height:6px;background:${C_INPUT};border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${C_ACCENT};transition:width .18s ease"></div>
      </div>
      <div style="margin-top:8px;color:${C_MUTED};font-size:12px">
        ${esc(note || (step + ' de ' + total + ' consultas'))}
      </div>`);
  }

  async function render() {
    setProgress(0, CORE.MAX_REQUESTS, 'Leyendo el hook de embarques…');
    setFoot('');
    try {
      // EN SERIE, no en paralelo: el catálogo publicado dice qué archivos buscar por
      // nombre exacto (los que no llevan el prefijo). Sin él la búsqueda los perdería.
      const hook = await fetchHook();
      state.hookSource = hook.code;
      state.hookCompiled = hook.compiled;
      state.published = CORE.parseBlockCatalog(hook.code);
      setProgress(1, CORE.MAX_REQUESTS, 'Buscando las identificaciones…');
      const listed = await fetchLicenseFiles(state.published, function (done, found, pending) {
        setProgress(done + 1, CORE.MAX_REQUESTS,
          done + ' consulta(s) · ' + found + ' archivo(s)'
          + (pending ? ' · faltan ' + pending + ' por nombre' : ''));
      });
      state.files = listed.files;
      state.exhausted = listed.exhausted;
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
        <td style="padding:7px 4px;width:${THUMB_W}px">${thumbCell(r.file)}</td>
        <td style="padding:7px 4px;font-weight:600">${esc(r.key)}</td>
        <td style="padding:7px 4px;color:${C_MUTED};font-size:11px">${esc(r.file)}</td>
        <td style="padding:7px 4px;color:${color};text-align:right;white-space:nowrap">${label}</td>
        <td style="padding:7px 4px;text-align:right;white-space:nowrap">
          <button data-dl-archive="${esc(r.key)}" data-dl-file="${esc(r.file)}"
            title="Archivar esta identificación en Steelhead"
            style="background:transparent;border:1px solid ${C_LINE};color:${C_MUTED};
                   padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px">Archivar</button>
        </td>
      </tr>`;
    }).join('');

    // Se marca la EXCEPCIÓN, no la norma: sólo se pinta el bloque de huérfanas si las hay.
    const orphanBlock = inv.orphans.length ? `
      <div style="margin-top:14px;border:1px solid ${C_AMBER};border-radius:8px;padding:10px 12px;color:${C_AMBER}">
        <b>${inv.orphans.length} licencia(s) publicada(s) sin archivo:</b>
        ${esc(inv.orphans.map((o) => o.key).join(', '))}.<br>
        <span style="color:${C_MUTED}">Se siguen imprimiendo con una liga que ya nadie administra. Vuelve a subirlas o publica para quitarlas.</span>
      </div>` : '';

    // Un presupuesto agotado significa «puede faltar gente en esta lista». Eso se DICE:
    // si no, el operador lee la ausencia de un chofer como «no está dado de alta».
    const budgetBlock = state.exhausted ? `
      <div style="margin-top:14px;border:1px solid ${C_AMBER};border-radius:8px;padding:10px 12px;color:${C_AMBER}">
        <b>Esta lista puede estar incompleta.</b> Se alcanzó el tope de consultas al ERP
        (${CORE.MAX_REQUESTS}) antes de terminar de buscar.<br>
        <span style="color:${C_MUTED}">Si falta un chofer que sí existe, vuelve a abrir el panel.
        No publiques hasta confirmarlo: publicarías un catálogo sin él.</span>
      </div>` : '';

    const warnBlock = inv.warnings.length ? `
      <div style="margin-top:14px;border:1px solid ${C_AMBER};border-radius:8px;padding:10px 12px;color:${C_AMBER}">
        ${inv.warnings.map((w) => esc(w)).join('<br>')}
      </div>` : '';

    setBody(`
      <div style="margin-bottom:18px;border-bottom:1px solid ${C_LINE};padding-bottom:16px">
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
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <b style="flex:1">${inv.rows.length} licencia(s)</b>
        <span style="color:${diff.isEmpty ? C_MUTED : C_AMBER}">
          ${diff.isEmpty ? 'catálogo publicado al día' : 'hay cambios sin publicar'}
        </span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="color:${C_MUTED};font-size:11px;text-align:left">
          <th style="padding:0 4px 6px;width:${THUMB_W}px">Foto</th>
          <th style="padding:0 4px 6px">Se nombra así en el embarque</th>
          <th style="padding:0 4px 6px">Archivo</th>
          <th style="padding:0 4px 6px;text-align:right">Estado</th>
          <th style="padding:0 4px 6px"></th>
        </tr>
        ${rows || `<tr><td colspan="5" style="padding:12px 4px;color:${C_MUTED}">Todavía no hay licencias cargadas.</td></tr>`}
      </table>
      ${budgetBlock}${orphanBlock}${warnBlock}
      </div>`);

    // CANDADO: no encontrar NINGÚN archivo teniendo catálogo publicado no es «las dieron de
    // baja», es una lectura que falló. Publicar ahí borraría el catálogo entero en silencio.
    const suspect = CORE.looksLikeFailedSearch(state.files, state.published);

    setFoot(`
      <span style="flex:1;color:${suspect ? C_RED : C_MUTED};font-size:12px">
        ${suspect ? 'Publicación bloqueada: no se leyó ninguna licencia y sí hay catálogo publicado.'
          : (diff.isEmpty ? 'No hay nada que publicar.'
          : `${diff.added.length} alta(s) · ${diff.changed.length} cambio(s) · ${diff.removed.length} baja(s)`)}
      </span>
      ${btn('dl-publish', 'Revisar y publicar…', (diff.isEmpty || suspect) ? '' : 'primary')}`);

    wireThumbs(document.getElementById('dl-body'));
    document.querySelectorAll('#dl-body button[data-dl-archive]').forEach(function (b) {
      b.onclick = () => showArchiveConfirm(b.getAttribute('data-dl-archive'),
                                           b.getAttribute('data-dl-file'));
    });
    document.getElementById('dl-upload').onclick = onUpload;
    const pub = document.getElementById('dl-publish');
    pub.onclick = () => showPublishConfirm(next, diff);
    pub.disabled = diff.isEmpty || suspect;
    if (pub.disabled) pub.style.opacity = '.5';
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

      // `CreatePdfLowCode` responde {clientMutationId:null}: ni el id ni el valor. Un `await`
      // sin excepción NO prueba que se escribió — y esto publica CÓDIGO PRODUCTIVO. Se RELEE
      // del servidor y se compara el catálogo que quedó VIVO contra el que se mandó.
      let verified = false;
      let verifyNote = '';
      try {
        const after = await fetchHook();
        const live = CORE.parseBlockCatalog(after.code);
        if (!live) {
          verifyNote = 'El bloque del servidor no se pudo releer para confirmarlo.';
        } else if (!CORE.diffCatalogs(live, next).isEmpty) {
          verifyNote = 'Lo que quedó vivo en el servidor NO coincide con lo que se mandó.';
        } else {
          verified = true;
        }
      } catch (ve) {
        verifyNote = 'No se pudo releer para confirmar: ' + (ve && ve.message ? ve.message : ve);
      }
      log((verified ? 'publicado y VERIFICADO: ' : 'publicado SIN verificar: ')
          + Object.keys(next).length + ' entradas');

      // No tener la confirmación no es «falló»: es «no sé». Va en ámbar, distinto del rojo
      // de bloqueo, y dice qué hacer — nunca en verde, que afirmaría lo que no se midió.
      const head = verified
        ? `<div style="border:1px solid ${C_ACCENT};border-radius:8px;padding:14px;color:${C_ACCENT}">
             <b>Catálogo publicado y verificado</b> con ${Object.keys(next).length} licencia(s)
             en este dominio. Se releyó del servidor y coincide.
           </div>`
        : `<div style="border:1px solid ${C_AMBER};border-radius:8px;padding:14px;color:${C_AMBER}">
             <b>Se mandó, pero no pude verificarlo.</b> ${esc(verifyNote)}<br>
             <span style="color:${C_MUTED}">Vuelve a abrir el panel y revisa el listado antes de
             darlo por bueno: puede haberse publicado, o no.</span>
           </div>`;

      setBody(`
        ${head}
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
