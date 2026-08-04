/**
 * marcar-usepartcount-productos.js — Tool standalone DevTools (NO es la extensión).
 *
 * QUÉ HACE: marca el check "usePartCountForQuantity" (Usar conteo de piezas para la
 * cantidad) en TODOS los Productos del dominio. One-shot: se pega en la consola, se
 * analiza, se aplica y se cierra. No se deploya ni se instala.
 *
 * CÓMO SE USA:
 *   1. Abre app.gosteelhead.com con tu sesión iniciada. Cualquier pantalla sirve; idealmente
 *      /Products. NO importa en qué dominio estés parado: los Productos son GLOBALES de la
 *      instancia (su ruta es /Products, sin prefijo /Domains/<id>), así que se corre UNA vez.
 *   2. Abre la consola (F12 → Console). Si Chrome pide escribir "allow pasting", hazlo.
 *   3. Pega este archivo COMPLETO y Enter → aparece un panel oscuro abajo a la derecha.
 *   4. Presiona ANALIZAR (dry-run, NO escribe). Revisa el preview.
 *   5. Presiona MARCAR y confirma. Al terminar, revisa el reporte de verificación.
 *   6. Si algo salió mal, DESHACER regresa a `false` SOLO los que este script cambió.
 *
 * MECANISMO (verificado contra el scan del 2026-08-03, ciclo completo capturado en vivo
 * sobre el producto 14501 "Cromado Decorativo": GetProduct dio false → UpdateProduct →
 * GetProduct dio true):
 *   - Inventario:  SearchProductsComprehensive({searchQuery:"", first, offset}) → 83 productos.
 *                  OJO: esta query NO devuelve usePartCountForQuantity, por eso hace falta
 *                  leer producto por producto para saber cuáles ya están marcados.
 *   - Lectura:     GetProduct({id}) → productById.usePartCountForQuantity
 *   - Escritura:   UpdateProduct({id, usePartCountForQuantity:true})  ← mutation PARCIAL,
 *                  solo toca ese campo; no reenvía nombre, precios ni grupo.
 *
 * POR QUÉ VERIFICA RELEYENDO: UpdateProduct responde `{updateProductById:{clientMutationId:null}}`
 *   — ni el valor nuevo ni el id. Un `await` sin excepción NO prueba que se haya escrito
 *   (misma lección que wo-schedule-button 0.7.0). Por eso cada escritura se relee con
 *   GetProduct y el reporte final solo cuenta como OK lo que se leyó en `true`.
 *
 * RITMO: las lecturas van en pool de 3 y las ESCRITURAS EN SERIE, con pausa entre requests.
 *   El /graphql de Steelhead se cuelga bajo ráfaga (~40-45 requests sin espera tumban la
 *   sesión entera, no solo la pestaña — incidente po-listing-filters). No subas CONCURRENCY.
 *
 * REANUDABLE: si la corrida se corta a la mitad, vuelve a pegar el script y presiona
 *   ANALIZAR — el análisis relee el estado REAL de cada producto, así que lo ya marcado sale
 *   como "ya marcado" y MARCAR solo escribe lo que falta. Deliberadamente NO se salta trabajo
 *   por checkpoint: un guard que pregunta "¿ya lo hice?" en vez de "¿sigue siendo cierto?"
 *   conservaría una mentira si alguien desmarcó algo a mano entre corridas. El localStorage
 *   (sa_upcfq_run) se usa solo como registro de lo cambiado, para poder DESHACER.
 *
 * Si algún hash rotó (error "Must provide a query string"), re-escanea con hash-scanner y
 *   actualiza HASHES abajo.
 */
(function () {
  'use strict';

  if (window.__saUpcfqPanel) {
    try { window.__saUpcfqPanel.scrollIntoView(); } catch (_) {}
    console.warn('[usepartcount] El panel ya está abierto.');
    return;
  }

  // ── Config verificada (scan_results_2026-08-03_122131) ──
  const HASHES = {
    SearchProductsComprehensive: 'b3e2b9c63285487866fe098c936cd37e60ffff373a9fa9e30296574cffcfbba0',
    GetProduct:                  '6793c31b4b4875e57fb7de47764b233e7c23dfd825c1d21757cdc98f12a0bc0b',
    UpdateProduct:               '112b85d79559a83a07ea11f43048369ecf51289166bc708fa9a63d0fb697a870',
  };
  const APOLLO_VERSION = '4.0.8';
  const FIELD = 'usePartCountForQuantity';
  const PAGE_SIZE = 500;
  const READ_CONCURRENCY = 3;   // lecturas
  const REQUEST_GAP_MS = 120;   // pausa entre requests (anti-ráfaga)
  const WRITE_GAP_MS = 250;     // pausa extra entre escrituras (van en serie)
  const MAX_RETRIES = 3;
  const CKPT_KEY = 'sa_upcfq_run';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── API ──
  async function gqlOnce(operationName, variables) {
    const hash = HASHES[operationName];
    if (!hash) throw new Error(`Sin hash para ${operationName}`);
    const res = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        operationName,
        variables,
        extensions: {
          clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
          persistedQuery: { version: 1, sha256Hash: hash },
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      if (/must provide a query string|persistedquerynotfound/i.test(text)) {
        const e = new Error(`HASH ROTADO en ${operationName} — re-escanea con hash-scanner y actualiza HASHES.`);
        e.fatal = true; throw e;
      }
      const e = new Error(`HTTP ${res.status} en ${operationName}: ${text.slice(0, 300)}`);
      e.retryable = (res.status === 429 || res.status >= 500);
      throw e;
    }
    let json;
    try { json = JSON.parse(text); }
    catch (_) { throw new Error(`Respuesta no-JSON en ${operationName}`); }
    if (Array.isArray(json.errors) && json.errors.length) {
      throw new Error(`GraphQL ${operationName}: ` + json.errors.map(e => e?.message || JSON.stringify(e)).join(' | '));
    }
    return json.data;
  }

  async function gql(operationName, variables) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const d = await gqlOnce(operationName, variables);
        await sleep(REQUEST_GAP_MS);
        return d;
      } catch (e) {
        if (e.fatal) throw e;
        lastErr = e;
        const net = (e instanceof TypeError) || /failed to fetch|network/i.test(e.message || '');
        if (!e.retryable && !net) break;                 // error de negocio: no reintentar
        if (attempt < MAX_RETRIES) await sleep(700 * attempt * attempt);  // backoff
      }
    }
    throw lastErr;
  }

  async function runPool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ── Datos ──
  async function fetchAllProducts(onProgress) {
    const all = [];
    let offset = 0, total = null;
    while (true) {
      const d = await gql('SearchProductsComprehensive', { searchQuery: '', first: PAGE_SIZE, offset });
      const sp = d?.searchProducts || {};
      const nodes = sp.nodes || [];
      if (total == null) total = sp.totalCount ?? nodes.length;
      all.push(...nodes);
      onProgress?.(all.length, total);
      if (!nodes.length || all.length >= total) break;
      offset += PAGE_SIZE;
      if (offset > 20000) break; // cinturón contra un totalCount mentiroso
    }
    return { products: all, total };
  }

  async function readFlag(id) {
    const d = await gql('GetProduct', { id });
    const p = d?.productById;
    if (!p) throw new Error(`GetProduct(${id}) vino vacío`);
    return { id, name: p.name, archivedAt: p.archivedAt, value: p[FIELD] };
  }

  // ── Checkpoint ──
  function loadCkpt() {
    try { return JSON.parse(localStorage.getItem(CKPT_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveCkpt(c) {
    try { localStorage.setItem(CKPT_KEY, JSON.stringify(c)); } catch (_) {}
  }

  // ── Estado ──
  const S = {
    analyzed: null,   // {products, needChange:[], already:[], archived:[], errors:[]}
    running: false,
    lines: [],
  };

  // ── UI (dark mode: es UI nuestra, no de Steelhead) ──
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const panel = document.createElement('div');
  window.__saUpcfqPanel = panel;
  panel.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'width:560px', 'max-height:78vh',
    'background:#1c2430', 'color:#e6e9ee', 'z-index:2147483647', 'border-radius:10px',
    'box-shadow:0 10px 40px rgba(0,0,0,.5)', 'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif',
    'display:flex', 'flex-direction:column', 'overflow:hidden',
  ].join(';');

  panel.innerHTML = `
    <div style="padding:12px 14px;background:#141a23;display:flex;align-items:center;gap:8px">
      <strong style="flex:1">☑️ Marcar «${esc(FIELD)}» en Productos</strong>
      <button data-act="close" style="background:transparent;border:0;color:#8b95a5;font-size:18px;cursor:pointer;line-height:1">✕</button>
    </div>
    <div style="padding:10px 14px;border-bottom:1px solid #2a3440">
      <label style="display:flex;gap:6px;align-items:center;color:#b9c2cf;cursor:pointer">
        <input type="checkbox" data-act="incArch"> Incluir productos archivados
      </label>
    </div>
    <div data-el="body" style="padding:12px 14px;overflow:auto;flex:1;min-height:90px">
      <div style="color:#8b95a5">Presiona <b>ANALIZAR</b> para revisar el estado actual. No escribe nada.</div>
    </div>
    <div style="padding:10px 14px;background:#141a23;display:flex;gap:8px;flex-wrap:wrap">
      <button data-act="scan"   style="flex:1;min-width:120px;background:#13a36f;border:0;color:#fff;padding:9px;border-radius:6px;font-weight:600;cursor:pointer">ANALIZAR</button>
      <button data-act="apply"  style="flex:1;min-width:120px;background:#2a3440;border:0;color:#6b7787;padding:9px;border-radius:6px;font-weight:600;cursor:not-allowed" disabled>MARCAR</button>
      <button data-act="revert" style="background:#3a2530;border:0;color:#d98a9a;padding:9px 12px;border-radius:6px;cursor:pointer" title="Regresa a false SOLO los productos que este script cambió">DESHACER</button>
      <button data-act="copy"   style="background:#2a3440;border:0;color:#b9c2cf;padding:9px 12px;border-radius:6px;cursor:pointer">📋</button>
    </div>`;
  document.body.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const body = $('[data-el="body"]');
  const btnScan = $('[data-act="scan"]');
  const btnApply = $('[data-act="apply"]');
  const btnRevert = $('[data-act="revert"]');

  function setBody(html) { body.innerHTML = html; }
  function note(msg) {
    S.lines.push(msg);
    console.log('[usepartcount] ' + msg);
  }
  function enableApply(on) {
    btnApply.disabled = !on;
    btnApply.style.background = on ? '#13a36f' : '#2a3440';
    btnApply.style.color = on ? '#fff' : '#6b7787';
    btnApply.style.cursor = on ? 'pointer' : 'not-allowed';
  }
  function busy(on) {
    S.running = on;
    [btnScan, btnRevert].forEach(b => { b.disabled = on; b.style.opacity = on ? .5 : 1; });
    if (on) enableApply(false);
  }

  // ── ANALIZAR (dry-run) ──
  async function doScan() {
    busy(true);
    S.lines = [];
    S.analyzed = null;   // un análisis fallido NO debe dejar habilitado el MARCAR del anterior
    const includeArchived = $('[data-act="incArch"]').checked;
    try {
      setBody('<div style="color:#8b95a5">Bajando el inventario de productos…</div>');
      const { products, total } = await fetchAllProducts((n, t) =>
        setBody(`<div style="color:#8b95a5">Inventario: ${n}/${t} productos…</div>`));

      const archived = products.filter(p => p.archivedAt);
      const target = includeArchived ? products : products.filter(p => !p.archivedAt);
      note(`Inventario: ${products.length} productos (totalCount=${total}), ${archived.length} archivados.`);

      const already = [], needChange = [], errors = [];
      let done = 0;
      await runPool(target, READ_CONCURRENCY, async (p) => {
        try {
          const r = await readFlag(p.id);
          (r.value === true ? already : needChange).push(r);
        } catch (e) {
          errors.push({ id: p.id, name: p.name, error: e.message });
        }
        done++;
        if (done % 5 === 0 || done === target.length) {
          setBody(`<div style="color:#8b95a5">Leyendo estado actual: ${done}/${target.length}…</div>`);
        }
      });

      needChange.sort((a, b) => a.id - b.id);
      S.analyzed = { products, needChange, already, archived, errors, includeArchived };

      const rows = needChange.map(r => `
        <tr><td style="padding:2px 8px 2px 0;color:#8b95a5">${r.id}</td>
            <td style="padding:2px 0">${esc(r.name)}</td>
            <td style="padding:2px 0;color:#8b95a5">${r.value === null ? 'null' : String(r.value)} → true</td></tr>`).join('');

      setBody(`
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px">
          <div><b style="color:#13a36f;font-size:20px">${needChange.length}</b><br><span style="color:#8b95a5">por marcar</span></div>
          <div><b style="font-size:20px">${already.length}</b><br><span style="color:#8b95a5">ya marcados</span></div>
          <div><b style="font-size:20px">${archived.length}</b><br><span style="color:#8b95a5">archivados ${includeArchived ? '(incluidos)' : '(excluidos)'}</span></div>
          ${errors.length ? `<div><b style="color:#d98a9a;font-size:20px">${errors.length}</b><br><span style="color:#8b95a5">no se pudieron leer</span></div>` : ''}
        </div>
        ${errors.length ? `<div style="background:#3a2530;color:#d98a9a;padding:8px;border-radius:6px;margin-bottom:10px">
           ⚠️ ${errors.length} producto(s) no se pudieron leer; quedan FUERA del marcado. Vuelve a analizar para reintentarlos.</div>` : ''}
        ${needChange.length
          ? `<div style="color:#b9c2cf;margin-bottom:6px">Se escribirá <b>solo</b> en estos ${needChange.length}:</div>
             <table style="width:100%;border-collapse:collapse;font-size:12px">${rows}</table>`
          : `<div style="color:#13a36f">✅ Nada que hacer: todos los productos ya tienen el check marcado.</div>`}`);

      note(`Análisis: ${needChange.length} por marcar, ${already.length} ya marcados, ${errors.length} con error.`);
      enableApply(needChange.length > 0);
    } catch (e) {
      setBody(`<div style="background:#3a2530;color:#d98a9a;padding:10px;border-radius:6px">❌ ${esc(e.message)}</div>`);
      note('ERROR en análisis: ' + e.message);
    } finally {
      busy(false);
      if (S.analyzed?.needChange?.length) enableApply(true);
    }
  }

  // ── MARCAR (escribe) ──
  async function doApply() {
    const a = S.analyzed;
    if (!a || !a.needChange.length) return;
    const n = a.needChange.length;
    if (!confirm(
      `Vas a marcar «${FIELD}» = true en ${n} producto(s) del ERP EN PRODUCCIÓN.\n\n` +
      `Es un cambio de dato maestro que afecta cómo se calculan las cantidades.\n` +
      `Los ${a.already.length} que ya estaban marcados NO se tocan.\n\n` +
      `El botón DESHACER puede revertir SOLO lo que esta corrida cambie.\n\n¿Continuar?`)) return;

    busy(true);
    const ckpt = loadCkpt() || {};
    const previous = ckpt.previous || {};
    const doneIds = new Set(ckpt.doneIds || []);
    const ok = [], failed = [];

    for (let i = 0; i < a.needChange.length; i++) {
      const r = a.needChange[i];
      setBody(`<div style="color:#8b95a5">Marcando ${i + 1}/${n}… <span style="color:#e6e9ee">${esc(r.name)}</span>
               <div style="margin-top:6px">✅ ${ok.length} &nbsp; ❌ ${failed.length}</div></div>`);
      try {
        await gql('UpdateProduct', { id: r.id, [FIELD]: true });
        await sleep(WRITE_GAP_MS);
        // La respuesta trae solo clientMutationId:null → hay que RELEER para saber si pegó.
        const after = await readFlag(r.id);
        if (after.value !== true) throw new Error(`escribió pero relectura dio ${String(after.value)}`);
        previous[r.id] = r.value;                 // para DESHACER
        doneIds.add(r.id);
        saveCkpt({ startedAt: ckpt.startedAt || new Date().toISOString(), previous, doneIds: [...doneIds] });
        ok.push(r);
      } catch (e) {
        failed.push({ ...r, error: e.message });
        note(`FALLÓ ${r.id} ${r.name}: ${e.message}`);
        if (e.fatal) break;
      }
    }

    const failRows = failed.map(f =>
      `<tr><td style="padding:2px 8px 2px 0;color:#8b95a5">${f.id}</td><td>${esc(f.name)}</td><td style="color:#d98a9a">${esc(f.error)}</td></tr>`).join('');
    setBody(`
      <div style="display:flex;gap:14px;margin-bottom:10px">
        <div><b style="color:#13a36f;font-size:20px">${ok.length}</b><br><span style="color:#8b95a5">marcados y verificados</span></div>
        ${failed.length ? `<div><b style="color:#d98a9a;font-size:20px">${failed.length}</b><br><span style="color:#8b95a5">fallaron</span></div>` : ''}
      </div>
      ${failed.length
        ? `<div style="color:#b9c2cf;margin-bottom:6px">Fallidos (no quedaron marcados):</div>
           <table style="width:100%;border-collapse:collapse;font-size:12px">${failRows}</table>
           <div style="color:#8b95a5;margin-top:8px">Vuelve a ANALIZAR y MARCAR para reintentar solo esos.</div>`
        : `<div style="color:#13a36f">✅ Los ${ok.length} quedaron marcados y verificados releyendo cada uno.</div>`}`);
    note(`Aplicado: ${ok.length} OK, ${failed.length} fallidos.`);
    busy(false);
    enableApply(failed.length > 0);
  }

  // ── DESHACER ──
  async function doRevert() {
    const ckpt = loadCkpt();
    const ids = ckpt?.doneIds || [];
    if (!ids.length) { alert('No hay nada que deshacer: este script no ha cambiado ningún producto en esta máquina.'); return; }
    if (!confirm(`Vas a regresar «${FIELD}» a su valor anterior en ${ids.length} producto(s).\n\nSolo se tocan los que ESTE script cambió.\n\n¿Continuar?`)) return;

    busy(true);
    const ok = [], failed = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const prev = ckpt.previous?.[id];
      const target = (prev === true);   // si antes era null o false → false
      setBody(`<div style="color:#8b95a5">Revirtiendo ${i + 1}/${ids.length}…</div>`);
      try {
        await gql('UpdateProduct', { id, [FIELD]: target });
        await sleep(WRITE_GAP_MS);
        const after = await readFlag(id);
        if (after.value !== target) throw new Error(`relectura dio ${String(after.value)}`);
        ok.push(id);
      } catch (e) { failed.push({ id, error: e.message }); }
    }
    if (!failed.length) localStorage.removeItem(CKPT_KEY);
    setBody(`<div style="color:${failed.length ? '#d98a9a' : '#13a36f'}">
       Revertidos ${ok.length}/${ids.length}${failed.length ? ` — ${failed.length} fallaron, el checkpoint se conserva.` : ' — checkpoint limpiado.'}</div>`);
    note(`Revert: ${ok.length} OK, ${failed.length} fallidos.`);
    busy(false);
  }

  // ── Eventos ──
  panel.addEventListener('click', (ev) => {
    const act = ev.target?.dataset?.act;
    if (!act || S.running && act !== 'close') return;
    if (act === 'close') { panel.remove(); window.__saUpcfqPanel = null; }
    else if (act === 'scan') doScan();
    else if (act === 'apply') doApply();
    else if (act === 'revert') doRevert();
    else if (act === 'copy') {
      navigator.clipboard.writeText(S.lines.join('\n')).then(
        () => note('Reporte copiado.'), () => alert('No pude copiar; el reporte está en la consola.'));
    }
  });

  console.log('[usepartcount] Panel listo. ANALIZAR primero (dry-run, no escribe).');
})();
