/* ============================================================================
 * grant-wb-produccion-access.js  —  Script para DevTools (consola del navegador)
 *
 * QUÉ HACE
 *   Inyecta un PANEL flotante en app.gosteelhead.com donde pegas una lista de
 *   nombres (copy-paste) y les das acceso a la etiqueta de workboard
 *   "WB Producción". Por defecto SUMA a los que ya tienen acceso (unión).
 *
 * CÓMO USARLO
 *   1. Abre https://app.gosteelhead.com con tu sesión iniciada (cualquier página).
 *   2. Abre DevTools → pestaña Console.
 *   3. Pega TODO este script y dale Enter. Aparece el panel arriba a la derecha.
 *   4. En el panel: pega los nombres (uno por línea) → "Analizar".
 *   5. Revisa el reporte (nuevos, no encontrados, ambiguos, total final).
 *   6. Si se ve bien, clic en "Aplicar a WB Producción".
 *
 * SEGURIDAD
 *   - La mutación de Steelhead REEMPLAZA la lista completa de la etiqueta.
 *     En modo UNIÓN (default) el script lee el estado en vivo y fusiona, para
 *     que NADIE pierda acceso. El modo "Reemplazar" avisa a quién quitaría.
 *   - Solo manda el input de WB Producción. NO toca WB Ingeniería/Calidad/Almacén.
 *   - "Analizar" nunca escribe. La escritura solo ocurre con "Aplicar".
 * ========================================================================== */

(() => {
  'use strict';

  // ---- Coordenadas de WB Producción (del scan 2026-06-02) ------------------
  const WORKBOARD_FOLDER_ID       = 1469;  // carpeta de workboard (Ecoplating)
  const LABEL_ID                  = 9746;  // etiqueta "WB Producción"
  const WORKBOARD_FOLDER_LABEL_ID = 419;   // registro folder-label ya existente

  // ---- Hashes de persisted queries (del scan) ------------------------------
  const HASHES = {
    usersQuery: '573d0e692ad465821cd39639cf0c1b7d7a3c4e846e18bc31fde52f750fcbba05', // UsersForFolderLabelConfig
    mutation:   'd598e0dd884c9caefaee84a29e4ecd796508f9ed660d7b980821253334de8636', // UpdateWorkboardLabelUsers
  };
  const APOLLO_VERSION = '4.0.8';
  const GRAPHQL_URL = 'https://app.gosteelhead.com/graphql';

  if (!location.host.includes('gosteelhead.com')) {
    alert('Corre este script EN una pestaña de app.gosteelhead.com (usa la cookie de sesión).');
    return;
  }

  // ====================== Lógica de API =====================================
  async function gql(operationName, variables, sha256Hash) {
    const body = {
      operationName, variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
        persistedQuery: { version: 1, sha256Hash },
      },
    };
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} (no-JSON): ${text.slice(0, 300)}`); }
    if (!res.ok || (json.errors && !json.data)) {
      const msg = (json.errors || []).map(e => e.message).join(' | ') || text.slice(0, 300);
      throw new Error(`HTTP ${res.status} en ${operationName}: ${msg}`);
    }
    return json.data;
  }

  const norm = (s) => (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita acentos
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')                         // quita puntuación
    .replace(/\s+/g, ' ').trim();

  function hasLabel(u, labelId) {
    const nodes = u?.workboardLabelUsersByUserId?.nodes || [];
    return nodes.some(n => n?.workboardFolderLabelByWorkboardFolderLabelId?.labelId === labelId);
  }

  async function fetchAllUsers(onProgress) {
    const all = [];
    const PAGE = 100;
    let offset = 0;
    for (let guard = 0; guard < 200; guard++) {           // backstop: 20k usuarios
      const data = await gql('UsersForFolderLabelConfig', { offset }, HASHES.usersQuery);
      const nodes = data?.allUsers?.nodes || [];
      all.push(...nodes);
      if (onProgress) onProgress(all.length);
      if (nodes.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  }

  function suggest(raw, users) {
    const tokens = norm(raw).split(' ').filter(Boolean);
    if (!tokens.length) return [];
    return users
      .filter(u => { const n = norm(u.name); return tokens.every(t => n.includes(t)); })
      .map(u => `${u.name} (id ${u.id})`)
      .slice(0, 5);
  }

  // ====================== Estado ============================================
  const state = { users: null, byName: null, currentIds: [], analysis: null };

  function indexUsers(users) {
    const byName = new Map();
    for (const u of users) {
      const k = norm(u.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(u);
    }
    state.users = users;
    state.byName = byName;
    state.currentIds = users.filter(u => hasLabel(u, LABEL_ID)).map(u => u.id);
  }

  function analyze(rawText, replaceMode) {
    const wanted = rawText.split('\n').map(s => s.trim()).filter(Boolean);
    const resolved = [], notFound = [], ambiguous = [];
    for (const raw of wanted) {
      const hits = state.byName.get(norm(raw)) || [];
      if (hits.length === 0) notFound.push({ raw, suggestions: suggest(raw, state.users) });
      else if (hits.length > 1) ambiguous.push({ raw, ids: hits.map(h => h.id), names: hits.map(h => h.name) });
      else resolved.push({ raw, id: hits[0].id, name: hits[0].name });
    }
    const currentSet = new Set(state.currentIds);
    const resolvedIds = resolved.map(r => r.id);
    const resolvedSet = new Set(resolvedIds);
    const newToAdd = resolved.filter(r => !currentSet.has(r.id));

    let finalIds, willLose = [];
    if (replaceMode) {
      finalIds = [...new Set(resolvedIds)];
      willLose = state.users.filter(u => currentSet.has(u.id) && !resolvedSet.has(u.id))
                            .map(u => ({ name: u.name, id: u.id }));
    } else {
      finalIds = [...new Set([...state.currentIds, ...resolvedIds])];
    }
    return { wanted, resolved, notFound, ambiguous, newToAdd, willLose, finalIds, replaceMode };
  }

  async function commit(finalIds) {
    const input = [{
      workboardFolderLabelId: WORKBOARD_FOLDER_LABEL_ID,
      userIds: finalIds,
      workboardFolderId: WORKBOARD_FOLDER_ID,
      labelId: LABEL_ID,
      selected: true,
    }];
    const data = await gql('UpdateWorkboardLabelUsers', { input }, HASHES.mutation);
    return data?.updateWorkboardLabelUsers === true;
  }

  // ====================== UI ================================================
  const PREV = document.getElementById('wb-prod-panel');
  if (PREV) PREV.remove();

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    if (props.style) n.style.cssText = props.style;
    for (const k of kids) n.append(k);
    return n;
  };

  const panel = el('div', { id: 'wb-prod-panel', style: `
    position:fixed; top:16px; right:16px; width:420px; max-height:88vh; overflow:auto;
    background:#fff; border:1px solid #d0d7de; border-radius:10px; z-index:2147483647;
    box-shadow:0 8px 30px rgba(0,0,0,.25); font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
    color:#1f2328;` });

  const header = el('div', { style:'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#0969da;color:#fff;border-radius:10px 10px 0 0;' },
    el('strong', { textContent:'WB Producción — Dar acceso' }),
    el('span', { textContent:'✕', title:'Cerrar', style:'cursor:pointer;font-size:16px;padding:0 4px;', onclick:() => panel.remove() }));

  const body = el('div', { style:'padding:14px;' });

  const status = el('div', { style:'font-size:12px;color:#57606a;margin-bottom:10px;', textContent:'Cargando usuarios…' });

  const ta = el('textarea', { placeholder:'Pega aquí los nombres, uno por línea…', spellcheck:false, style:`
    width:100%; height:140px; box-sizing:border-box; resize:vertical; padding:8px;
    border:1px solid #d0d7de; border-radius:6px; font:12px/1.4 ui-monospace,Menlo,monospace;` });

  const replaceWrap = el('label', { style:'display:flex;gap:6px;align-items:center;margin:8px 0;font-size:12px;color:#57606a;cursor:pointer;' });
  const replaceCb = el('input', { type:'checkbox' });
  replaceWrap.append(replaceCb, el('span', { textContent:'Reemplazar lista completa (quita a quien no esté). Por defecto: SUMAR.' }));

  const btnRow = el('div', { style:'display:flex;gap:8px;margin:6px 0 12px;' });
  const btnAnalyze = el('button', { textContent:'Analizar', disabled:true, style:`
    flex:1; padding:8px; border:1px solid #1f883d; background:#1f883d; color:#fff; border-radius:6px;
    cursor:pointer; font-weight:600;` });
  const btnApply = el('button', { textContent:'Aplicar a WB Producción', disabled:true, style:`
    flex:1; padding:8px; border:1px solid #bf3989; background:#bf3989; color:#fff; border-radius:6px;
    cursor:pointer; font-weight:600; opacity:.5;` });
  btnRow.append(btnAnalyze, btnApply);

  const results = el('div', {});

  body.append(status, ta, replaceWrap, btnRow, results);
  panel.append(header, body);
  document.body.append(panel);

  // ---- helpers de render (textContent → seguro contra XSS) -----------------
  function chip(text, bg, color) {
    return el('span', { textContent:text, style:`display:inline-block;padding:2px 8px;border-radius:12px;background:${bg};color:${color};font-size:11px;font-weight:600;margin:2px 4px 2px 0;` });
  }
  function table(headers, rows) {
    const t = el('table', { style:'width:100%;border-collapse:collapse;margin:4px 0 10px;font-size:12px;' });
    const thead = el('tr', {});
    headers.forEach(h => thead.append(el('th', { textContent:h, style:'text-align:left;border-bottom:1px solid #d0d7de;padding:4px 6px;color:#57606a;' })));
    t.append(thead);
    rows.forEach(r => {
      const tr = el('tr', {});
      r.forEach(c => tr.append(el('td', { textContent:String(c), style:'border-bottom:1px solid #eaeef2;padding:4px 6px;vertical-align:top;' })));
      t.append(tr);
    });
    return t;
  }
  function section(title, color) {
    return el('div', { style:`font-weight:700;margin:10px 0 4px;color:${color || '#1f2328'};` , textContent:title });
  }

  function renderAnalysis(a) {
    results.replaceChildren();
    const summary = el('div', { style:'margin-bottom:8px;' });
    summary.append(
      chip(`Actual: ${state.currentIds.length}`, '#eaeef2', '#1f2328'),
      chip(`En tu lista: ${a.wanted.length}`, '#eaeef2', '#1f2328'),
      chip(`Nuevos: ${a.newToAdd.length}`, '#dafbe1', '#1a7f37'),
      a.notFound.length ? chip(`No encontrados: ${a.notFound.length}`, '#fff8c5', '#7d4e00') : '',
      a.ambiguous.length ? chip(`Ambiguos: ${a.ambiguous.length}`, '#ffebe9', '#cf222e') : '',
      chip(`TOTAL final: ${a.finalIds.length}`, '#ddf4ff', '#0969da'),
    );
    results.append(summary);

    if (a.replaceMode && a.willLose.length) {
      results.append(section(`⚠️ PERDERÍAN acceso (${a.willLose.length}):`, '#cf222e'));
      results.append(table(['Nombre', 'id'], a.willLose.map(x => [x.name, x.id])));
    }
    if (a.newToAdd.length) {
      results.append(section(`Nuevos a agregar (${a.newToAdd.length}):`, '#1a7f37'));
      results.append(table(['Nombre', 'id'], a.newToAdd.map(x => [x.name, x.id])));
    }
    if (a.notFound.length) {
      results.append(section(`⚠️ No encontrados (revisa typos):`, '#7d4e00'));
      results.append(table(['Buscado', 'Sugerencias'], a.notFound.map(x => [x.raw, x.suggestions.join(' ; ') || '—'])));
    }
    if (a.ambiguous.length) {
      results.append(section(`⚠️ Ambiguos (resuelve por id manualmente):`, '#cf222e'));
      results.append(table(['Buscado', 'ids'], a.ambiguous.map(x => [x.raw, x.ids.join(', ')])));
    }

    const noChange = a.replaceMode
      ? false
      : (a.newToAdd.length === 0);
    btnApply.disabled = noChange;
    btnApply.style.opacity = noChange ? '.5' : '1';
    if (noChange) results.append(el('div', { style:'color:#57606a;margin-top:6px;', textContent:'No hay cambios que aplicar.' }));
  }

  // ---- eventos -------------------------------------------------------------
  btnAnalyze.onclick = () => {
    if (!state.users) return;
    state.analysis = analyze(ta.value, replaceCb.checked);
    renderAnalysis(state.analysis);
  };

  btnApply.onclick = async () => {
    const a = state.analysis;
    if (!a) return;
    const msg = a.replaceMode
      ? `Vas a REEMPLAZAR la lista de WB Producción.\n\nTotal final: ${a.finalIds.length}\nPerderían acceso: ${a.willLose.length}\n\n¿Continuar?`
      : `Vas a SUMAR ${a.newToAdd.length} usuario(s) a WB Producción.\n\nTotal final: ${a.finalIds.length}\n\n¿Continuar?`;
    if (!confirm(msg)) return;
    btnApply.disabled = true; btnApply.textContent = 'Aplicando…';
    try {
      const ok = await commit(a.finalIds);
      status.textContent = ok ? `✅ Listo: WB Producción tiene ${a.finalIds.length} usuarios.` : '❌ El server no devolvió true.';
      status.style.color = ok ? '#1a7f37' : '#cf222e';
      btnApply.textContent = ok ? '✅ Aplicado' : 'Reintentar';
      if (ok) { state.users = null; loadUsers(); }   // refresca estado actual
    } catch (e) {
      status.textContent = '💥 ' + e.message; status.style.color = '#cf222e';
      btnApply.disabled = false; btnApply.textContent = 'Reintentar';
    }
  };

  // ---- carga inicial de usuarios ------------------------------------------
  async function loadUsers() {
    status.textContent = 'Cargando usuarios…'; status.style.color = '#57606a';
    btnAnalyze.disabled = true;
    try {
      const users = await fetchAllUsers(n => { status.textContent = `Cargando usuarios… ${n}`; });
      indexUsers(users);
      status.textContent = `${users.length} usuarios cargados · ${state.currentIds.length} ya en WB Producción.`;
      status.style.color = '#1a7f37';
      btnAnalyze.disabled = false;
    } catch (e) {
      status.textContent = '💥 Error cargando usuarios: ' + e.message; status.style.color = '#cf222e';
    }
  }

  loadUsers();
})();
