/**
 * desmarcar-validacion-ingenieria.js — Tool standalone DevTools (NO es la extensión).
 *
 * QUÉ HACE: desmarca la "Validación de ingeniería / Valid. 1er Recibo" en los números de
 * parte cuyos Id SH pegues. Útil para revertir cargas masivas que la activaron por error.
 *
 * CÓMO SE USA:
 *   1. Abre app.gosteelhead.com con tu sesión iniciada (en el dominio correcto: TLC/MTY).
 *   2. Abre la consola del navegador (F12 → Console).
 *   3. Pega este archivo COMPLETO y Enter. Aparece un panel oscuro abajo a la derecha.
 *   4. Pega los Id SH (uno por línea o separados por espacio/coma), presiona ANALIZAR (dry-run).
 *   5. Revisa el preview. Presiona DESMARCAR para ejecutar. Verifica el reporte.
 *
 * MECANISMO (validado headless contra SH en vivo, 2026-07-15):
 *   La validación de ingeniería = optIns a los processNodeIds 231176 y 231174
 *   (config.steelhead.domain.validacionProcessNodeIds). Desmarcar = borrar esos registros
 *   optInOut con DeleteProcessNodePartNumberOptInOut({id}). Es QUIRÚRGICO: no toca specs,
 *   dims, precios ni otros optIns del PN — solo borra los 2 registros de validación.
 *
 * NOTA: el "Id SH" es el id INTERNO del PN (el mismo número que la carga masiva usa como
 *   partNumberId / columna "Id SH"), no el idInDomain.
 *
 * Si algún hash rotó (error "Must provide a query string"), actualiza HASHES abajo desde
 *   remote/config.json (steelhead.hashes.queries/mutations).
 */
(function () {
  'use strict';

  if (window.__saDesmarcarValidacion) {
    try { window.__saDesmarcarValidacion.scrollIntoView(); } catch (_) {}
    console.warn('[desmarcar-validacion] El panel ya está abierto.');
    return;
  }

  // ── Config verificada ──
  const VALIDACION_NODE_IDS = [231176, 231174];
  const HASHES = {
    GetPartNumber: '5efd689d8d92151ea510256828f17cbe10b815dd8dce2bd1dd51ef55bb9a0faf',
    DeleteProcessNodePartNumberOptInOut: '4a0773339315f1a52a9c08c249c5b3540c13def2b0d320e0e16ad9cb75b4d823',
  };
  const APOLLO_VERSION = '4.0.8';
  const CONCURRENCY = 5;

  // ── API ──
  async function gql(operationName, variables) {
    const body = {
      operationName, variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
        persistedQuery: { version: 1, sha256Hash: HASHES[operationName] },
      },
    };
    const res = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json;
    try { json = await res.json(); }
    catch (e) { throw new Error(`${operationName}: respuesta no-JSON (HTTP ${res.status})`); }
    if (json.errors && json.errors.length) {
      throw new Error(`${operationName}: ${json.errors[0].message || JSON.stringify(json.errors[0])}`);
    }
    return json.data;
  }

  // Lee un PN y devuelve los optIns de validación (con su id de registro) + conteo de otros optIns.
  async function inspect(pnId) {
    const d = await gql('GetPartNumber', { partNumberId: pnId, usagesLimit: 0, usagesOffset: 0 });
    const pn = d && (d.partNumberById || d.partNumber);
    if (!pn) return { found: false, pnId };
    const nodes = (pn.processNodePartNumberOptInoutsByPartNumberId && pn.processNodePartNumberOptInoutsByPartNumberId.nodes) || [];
    const val = nodes.filter((o) => VALIDACION_NODE_IDS.indexOf(o.processNodeId) !== -1);
    return { found: true, pnId, name: pn.name || '(sin nombre)', optInIds: val.map((o) => o.id), otros: nodes.length - val.length };
  }

  async function deleteOptIn(id) {
    return gql('DeleteProcessNodePartNumberOptInOut', { id });
  }

  // Pool de concurrencia acotada. Nunca rechaza; cada item devuelve {ok,value|error}.
  async function pool(items, fn, onProgress) {
    const results = new Array(items.length);
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < items.length) {
        const idx = cursor++;
        try { results[idx] = { ok: true, value: await fn(items[idx], idx) }; }
        catch (e) { results[idx] = { ok: false, error: String((e && e.message) || e) }; }
        done++; if (onProgress) onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length || 1) }, worker));
    return results;
  }

  function parseIds(text) {
    const seen = new Set(); const out = [];
    (text || '').split(/[\s,;]+/).forEach((tok) => {
      const t = tok.trim(); if (!t) return;
      const n = parseInt(t, 10);
      if (!Number.isFinite(n) || String(n) !== t.replace(/^0+(?=\d)/, '')) {
        // token no-entero (o con basura): lo ignoramos pero lo anotamos
        if (!/^\d+$/.test(t)) { out.push({ raw: t, bad: true }); return; }
      }
      if (/^\d+$/.test(t)) { const id = parseInt(t, 10); if (!seen.has(id)) { seen.add(id); out.push({ id }); } }
    });
    return out;
  }

  // ── UI (dark-mode: distingue de las pantallas claras de Steelhead) ──
  const C = { bg: '#1c2430', card: '#141a23', ink: '#e6e9ee', mut: '#94a3b8', line: '#2b3646', acc: '#13a36f', red: '#f87171', amber: '#fbbf24' };
  const wrap = document.createElement('div');
  window.__saDesmarcarValidacion = wrap;
  wrap.style.cssText = `position:fixed;right:16px;bottom:16px;width:520px;max-height:80vh;z-index:2147483647;background:${C.bg};color:${C.ink};border:1px solid ${C.line};border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;overflow:hidden`;

  const head = document.createElement('div');
  head.style.cssText = `padding:12px 14px;border-bottom:1px solid ${C.line};display:flex;align-items:center;gap:8px`;
  const h = document.createElement('div'); h.style.cssText = 'font-weight:700;flex:1'; h.textContent = '🧹 Desmarcar Validación de Ingeniería';
  const xBtn = document.createElement('button'); xBtn.textContent = '✕'; xBtn.title = 'Cerrar';
  xBtn.style.cssText = `background:none;border:none;color:${C.mut};font-size:16px;cursor:pointer`;
  xBtn.onclick = () => { wrap.remove(); delete window.__saDesmarcarValidacion; };
  head.appendChild(h); head.appendChild(xBtn);

  const body = document.createElement('div');
  body.style.cssText = 'padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px';

  const lbl = document.createElement('div'); lbl.style.cssText = `color:${C.mut};font-size:12px`;
  lbl.textContent = 'Pega los Id SH (id interno del PN), uno por línea o separados por espacio/coma:';
  const ta = document.createElement('textarea');
  ta.style.cssText = `width:100%;height:120px;box-sizing:border-box;background:${C.card};color:${C.ink};border:1px solid ${C.line};border-radius:8px;padding:8px;font:12px/1.4 ui-monospace,Menlo,monospace;resize:vertical`;
  ta.placeholder = '3663678\n3663679\n...';

  const btnRow = document.createElement('div'); btnRow.style.cssText = 'display:flex;gap:8px';
  const mkBtn = (txt, bg) => { const b = document.createElement('button'); b.textContent = txt; b.style.cssText = `flex:1;padding:9px;border:none;border-radius:8px;font-weight:600;cursor:pointer;background:${bg};color:#fff`; return b; };
  const dryBtn = mkBtn('🔍 Analizar (dry-run)', '#2b6cb0');
  const runBtn = mkBtn('🧹 Desmarcar', C.acc); runBtn.disabled = true; runBtn.style.opacity = '.45'; runBtn.style.cursor = 'not-allowed';

  const status = document.createElement('div'); status.style.cssText = `font-size:12px;color:${C.mut};min-height:16px`;
  const preview = document.createElement('div'); preview.style.cssText = `font-size:12px;max-height:32vh;overflow:auto;border:1px solid ${C.line};border-radius:8px;display:none`;
  const logBox = document.createElement('pre'); logBox.style.cssText = `margin:0;background:${C.card};border:1px solid ${C.line};border-radius:8px;padding:8px;max-height:22vh;overflow:auto;font:11px/1.4 ui-monospace,Menlo,monospace;color:${C.mut};white-space:pre-wrap;display:none`;

  body.appendChild(lbl); body.appendChild(ta); body.appendChild(btnRow);
  btnRow.appendChild(dryBtn); btnRow.appendChild(runBtn);
  body.appendChild(status); body.appendChild(preview); body.appendChild(logBox);
  wrap.appendChild(head); wrap.appendChild(body); document.body.appendChild(wrap);

  const logLines = [];
  function log(msg) { const line = `[${new Date().toLocaleTimeString()}] ${msg}`; logLines.push(line); logBox.style.display = 'block'; logBox.textContent = logLines.join('\n'); logBox.scrollTop = logBox.scrollHeight; }
  function setStatus(msg, color) { status.textContent = msg; status.style.color = color || C.mut; }

  let plan = null; // resultado del dry-run: { toDelete:[{pnId,name,ids}], clean:[], missing:[], bad:[] }

  function renderPreview(p) {
    preview.style.display = 'block';
    const rows = [];
    rows.push(`<div style="display:grid;grid-template-columns:1fr 2.2fr .8fr;gap:4px;padding:6px 8px;position:sticky;top:0;background:${C.bg};border-bottom:1px solid ${C.line};font-weight:600"><span>Id SH</span><span>PN</span><span style="text-align:right">Borrar</span></div>`);
    p.toDelete.forEach((r) => { rows.push(`<div style="display:grid;grid-template-columns:1fr 2.2fr .8fr;gap:4px;padding:5px 8px;border-bottom:1px solid ${C.line}"><span>${r.pnId}</span><span style="color:${C.ink};overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span style="text-align:right;color:${C.acc};font-weight:600">${r.ids.length}${r.otros ? ` <span style="color:${C.mut};font-weight:400">(+${r.otros} otros)</span>` : ''}</span></div>`); });
    preview.innerHTML = rows.join('');
    // nombres vía textContent (evita inyección de nombres con < >)
    const nameCells = preview.querySelectorAll('div > span:nth-child(2)');
    p.toDelete.forEach((r, i) => { if (nameCells[i + 1]) nameCells[i + 1].textContent = r.name; }); // +1 por el header
  }

  dryBtn.onclick = async () => {
    const parsed = parseIds(ta.value);
    const ids = parsed.filter((x) => x.id).map((x) => x.id);
    const bad = parsed.filter((x) => x.bad).map((x) => x.raw);
    if (!ids.length) { setStatus('No hay Id SH válidos (deben ser enteros).', C.red); return; }
    dryBtn.disabled = true; runBtn.disabled = true; runBtn.style.opacity = '.45';
    logLines.length = 0; log(`Dry-run: ${ids.length} Id SH únicos${bad.length ? ` (${bad.length} tokens inválidos ignorados: ${bad.slice(0, 5).join(', ')})` : ''}.`);
    setStatus('Analizando…', C.amber);
    const res = await pool(ids, (id) => inspect(id), (d, t) => setStatus(`Analizando ${d}/${t}…`, C.amber));
    const toDelete = [], clean = [], missing = [], errors = [];
    res.forEach((r, i) => {
      if (!r.ok) { errors.push({ pnId: ids[i], error: r.error }); return; }
      const v = r.value;
      if (!v.found) { missing.push(v.pnId); return; }
      if (v.optInIds.length) toDelete.push({ pnId: v.pnId, name: v.name, ids: v.optInIds, otros: v.otros });
      else clean.push({ pnId: v.pnId, name: v.name });
    });
    plan = { toDelete, clean, missing, errors };
    const totalOptIns = toDelete.reduce((a, r) => a + r.ids.length, 0);
    log(`→ ${toDelete.length} PN con validación (${totalOptIns} optIns a borrar) · ${clean.length} ya limpios · ${missing.length} no encontrados · ${errors.length} errores.`);
    missing.forEach((id) => log(`  ⚠️ Id SH ${id}: PN no encontrado.`));
    errors.forEach((e) => log(`  ❌ Id SH ${e.pnId}: ${e.error}`));
    renderPreview(plan);
    dryBtn.disabled = false;
    if (toDelete.length) { runBtn.disabled = false; runBtn.style.opacity = '1'; runBtn.style.cursor = 'pointer'; setStatus(`Listo: ${toDelete.length} PN a desmarcar (${totalOptIns} optIns). Revisa y presiona DESMARCAR.`, C.acc); }
    else { setStatus('Nada que desmarcar (todos limpios / no encontrados).', C.mut); }
  };

  runBtn.onclick = async () => {
    if (!plan || !plan.toDelete.length) return;
    const totalOptIns = plan.toDelete.reduce((a, r) => a + r.ids.length, 0);
    if (!window.confirm(`Vas a borrar ${totalOptIns} optIns de validación en ${plan.toDelete.length} PN.\n\nEs quirúrgico (no toca specs/dims/precios ni otros optIns) y reversible (se puede re-activar).\n\n¿Continuar?`)) return;
    dryBtn.disabled = true; runBtn.disabled = true; runBtn.style.opacity = '.45'; runBtn.style.cursor = 'not-allowed';
    log(`\n=== EJECUTANDO: ${plan.toDelete.length} PN, ${totalOptIns} optIns ===`);
    setStatus('Desmarcando…', C.amber);
    let okPn = 0, failPn = 0;
    // Procesa por PN (borra sus 1-2 optIns en serie) para poder verificar cada PN.
    const res = await pool(plan.toDelete, async (r) => {
      for (const id of r.ids) await deleteOptIn(id);
      // Verificación post-borrado: releer y confirmar 0 optIns de validación.
      const after = await inspect(r.pnId);
      if (after.found && after.optInIds.length) throw new Error(`quedan ${after.optInIds.length} optIns de validación tras borrar`);
      return true;
    }, (d, t) => setStatus(`Desmarcando ${d}/${t} PN…`, C.amber));
    res.forEach((r, i) => {
      const pnId = plan.toDelete[i].pnId;
      if (r.ok) { okPn++; log(`  ✓ ${pnId} (${plan.toDelete[i].name}) desmarcado y verificado.`); }
      else { failPn++; log(`  ❌ ${pnId}: ${r.error}`); }
    });
    log(`\n=== RESULTADO: ${okPn} desmarcados OK · ${failPn} con error ===`);
    setStatus(`Terminado: ${okPn} desmarcados · ${failPn} errores. Verifica en Steelhead.`, failPn ? C.amber : C.acc);
    dryBtn.disabled = false;
    // Copiar log
    const copyBtn = mkBtn('📋 Copiar log', '#475569'); copyBtn.onclick = () => { navigator.clipboard.writeText(logLines.join('\n')).then(() => setStatus('Log copiado.', C.acc)); };
    body.appendChild(copyBtn);
  };

  console.log('%c[desmarcar-validacion] Panel listo. Pega los Id SH y presiona ANALIZAR.', 'color:#13a36f;font-weight:bold');
})();
