// auto-router-batch.js — Modo BATCH: re-rutear varias órdenes a una línea de una vez.
//
// El operador pega los números de orden (idInDomain, los que ve en el Scheduling
// board), elige la línea destino, y el applet resuelve cada orden, calcula el
// mapeo con AutoRouterEngine y aplica todas con concurrencia acotada. Cada orden
// re-lee su árbol JUSTO antes de aplicar (load-before-save) para que el save
// persista, y verifica que el servidor haya creado lo pedido.
//
// Depende de: AutoRouterEngine, AutoRouterAPI. Expone window.AutoRouterBatch.

const AutoRouterBatch = (() => {
  'use strict';

  const Engine = () => window.AutoRouterEngine;
  const API = () => window.AutoRouterAPI;
  const log = (m) => window.SteelheadAPI?.log?.(m) ?? console.log('[AR-Batch]', m);
  const CONCURRENCY = 3;

  let state = fresh();
  function fresh() {
    return { wos: [], candidates: null, destLines: [], destLine: null, busy: false };
  }

  function detectSourceLine(recipeNodes) {
    const lc = Engine().extractLineCode;
    const listo = recipeNodes.find((n) => /listo para procesar/i.test(n.name || '') && n.defaultStation);
    if (listo) { const c = lc(listo.defaultStation.name); if (c) return c; }
    const freq = new Map();
    for (const n of recipeNodes) {
      if (!n.defaultStation || !/-TI\d{2}-/.test(n.defaultStation.name)) continue;
      const c = lc(n.defaultStation.name); if (c) freq.set(c, (freq.get(c) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [c, k] of freq) if (k > n) { best = c; n = k; }
    return best;
  }

  function parseWoNumbers(text) {
    return [...new Set((text || '').split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))];
  }

  // Cuántas tinas se re-rutean (nodos de la línea origen) para una WO+destLine.
  function changedCount(routeData, sourceLine, destLine, candidates) {
    const r = Engine().computeRoutes({
      recipeNodes: routeData.recipeNodes, candidatesByTreatment: candidates,
      sourceLineCode: sourceLine, destLineCode: destLine,
    });
    const lc = Engine().extractLineCode;
    const byNode = new Map(routeData.recipeNodes.map((n) => [n.id, n]));
    let changed = 0;
    for (const rt of r.routes) {
      const n = byNode.get(rt.recipeNodeId);
      if (n && n.defaultStation && lc(n.defaultStation.name) === sourceLine) changed++;
    }
    return { changed, total: r.routes.length, skipped: r.skipped.length };
  }

  // ── concurrencia ────────────────────────────────────────────────────────────
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    }));
    return out;
  }

  // Aplica una orden (load-before-save: re-lee fresco justo antes).
  async function applyOne(wo, destLine, candidates) {
    const fresh2 = await API().fetchWorkOrderRouteData(
      wo.workOrderId, wo.partNumberId, wo.partGroupId ? [wo.partGroupId] : []
    );
    const sourceLine = detectSourceLine(fresh2.recipeNodes) || wo.sourceLine;
    const r = Engine().computeRoutes({
      recipeNodes: fresh2.recipeNodes, candidatesByTreatment: candidates,
      sourceLineCode: sourceLine, destLineCode: destLine,
      partNumberId: wo.partNumberId, workOrderId: wo.workOrderId, partGroupId: wo.partGroupId ?? null,
    });
    const split = Engine().diffRoutes(r.routes, fresh2.activeRoutes);
    const want = split.routesToCreate.length;
    const res = await API().applyRoutes(split.routesToCreate, split.routesToUpdate, split.routesToDelete);
    const created = (res.createdRoutes || []).length;
    if (want > 0 && created === 0) return { ok: false, msg: `creó 0 de ${want} (estado obsoleto)` };
    return { ok: true, created, updated: (res.updatedRoutes || []).length, deleted: (res.deletedRouteIds || []).length };
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-arb-style')) return;
    const css = `
      .sa-arb-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483640;display:flex;
        align-items:center;justify-content:center;}
      .sa-arb{background:#fff;width:min(760px,94vw);max-height:90vh;border-radius:10px;display:flex;
        flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.35);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2430;}
      .sa-arb h2{margin:0;font-size:16px;}
      .sa-arb-hd,.sa-arb-ft{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:10px;}
      .sa-arb-hd{border-bottom:1px solid #e6e9ee;} .sa-arb-ft{border-top:1px solid #e6e9ee;}
      .sa-arb-bd{padding:14px 18px;overflow:auto;}
      .sa-arb-x{border:none;background:none;font-size:22px;cursor:pointer;color:#7a8696;}
      .sa-arb textarea{width:100%;min-height:70px;font-family:ui-monospace,monospace;font-size:13px;
        border:1px solid #c7cdd6;border-radius:6px;padding:8px;box-sizing:border-box;}
      .sa-arb select{font-size:13px;padding:5px 7px;border:1px solid #c7cdd6;border-radius:6px;}
      .sa-arb-btn{border:none;border-radius:7px;padding:9px 15px;font-size:14px;font-weight:600;cursor:pointer;}
      .sa-arb-btn.primary{background:#0b6e4f;color:#fff;} .sa-arb-btn.primary:disabled{background:#9bbcb0;cursor:not-allowed;}
      .sa-arb-btn.ghost{background:#eef1f5;color:#33404f;}
      table.sa-arb-tb{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px;}
      table.sa-arb-tb th,table.sa-arb-tb td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef1f5;}
      table.sa-arb-tb th{color:#7a8696;font-weight:600;}
      .sa-arb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}
      .sa-arb-note{font-size:12px;color:#7a8696;} .sa-arb-warn{color:#9a3412;}
      .sa-arb-st{font-weight:600;} .sa-arb-st.ok{color:#0b6e4f;} .sa-arb-st.err{color:#c0392b;} .sa-arb-st.run{color:#b8860b;}`;
    const s = document.createElement('style'); s.id = 'sa-arb-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of kids || []) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  function shell() {
    document.getElementById('sa-arb-ov')?.remove();
    const ov = el('div', { id: 'sa-arb-ov', class: 'sa-arb-ov' });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov && !state.busy) close(); });
    const p = el('div', { class: 'sa-arb' });
    p.appendChild(el('div', { class: 'sa-arb-hd' }, [
      el('h2', { text: '🔀 Auto-Ruteador · Batch (varias órdenes)' }),
      el('button', { class: 'sa-arb-x', text: '×', onclick: () => { if (!state.busy) close(); } }),
    ]));
    p.appendChild(el('div', { class: 'sa-arb-bd', id: 'sa-arb-bd' }));
    p.appendChild(el('div', { class: 'sa-arb-ft', id: 'sa-arb-ft' }));
    ov.appendChild(p);
    document.body.appendChild(ov);
  }
  const body = (n) => { const b = document.getElementById('sa-arb-bd'); if (b) { b.textContent = ''; b.appendChild(n); } };
  const foot = (...n) => { const f = document.getElementById('sa-arb-ft'); if (f) { f.textContent = ''; for (const x of n) if (x) f.appendChild(x); } };

  function open() {
    injectStyles();
    state = fresh();
    shell();
    renderInput();
  }
  function close() { document.getElementById('sa-arb-ov')?.remove(); state = fresh(); }

  function renderInput() {
    const ta = el('textarea', { id: 'sa-arb-ta', placeholder: 'Números de orden separados por coma o salto de línea\nej.  6260, 8649, 8650' });
    body(el('div', {}, [
      el('div', { class: 'sa-arb-note', text: 'Pega los números de orden (los que ves en el Scheduling board). Resolveré cada una y calcularé el ruteo a la línea destino que elijas.' }),
      el('div', { class: 'sa-arb-row' }, []),
      ta,
    ]));
    foot(
      el('button', { class: 'sa-arb-btn ghost', text: 'Cerrar', onclick: close }),
      el('button', { class: 'sa-arb-btn primary', text: 'Resolver y calcular', onclick: onCompute }),
    );
  }

  async function onCompute() {
    const text = document.getElementById('sa-arb-ta')?.value || '';
    const nums = parseWoNumbers(text);
    if (!nums.length) { body(el('div', { class: 'sa-arb-warn', text: 'No detecté números de orden válidos.' })); return; }
    state.busy = true;
    body(el('div', { class: 'sa-arb-note', text: `Resolviendo ${nums.length} órdenes…` }));
    foot();
    // 1. resolver + cargar árbol de cada orden.
    state.wos = [];
    for (const idd of nums) {
      try {
        const meta = await API().resolveWorkOrder(idd);
        if (meta.partNumberId == null) { state.wos.push({ idInDomain: idd, error: 'sin número de parte' }); continue; }
        const routeData = await API().fetchWorkOrderRouteData(meta.workOrderId, meta.partNumberId, meta.partGroupId ? [meta.partGroupId] : []);
        const sourceLine = detectSourceLine(routeData.recipeNodes);
        state.wos.push({ ...meta, routeData, sourceLine });
      } catch (e) {
        state.wos.push({ idInDomain: idd, error: e.message });
      }
    }
    // 2. candidatas (unión de tratamientos de la sección origen de todas las órdenes).
    const lc = Engine().extractLineCode;
    const tids = new Set();
    for (const wo of state.wos) {
      if (wo.error) continue;
      for (const n of wo.routeData.recipeNodes) {
        if (n.treatmentId != null && n.defaultStation && lc(n.defaultStation.name) === wo.sourceLine) tids.add(n.treatmentId);
      }
    }
    try { state.candidates = await API().fetchCandidatesForTreatments([...tids]); }
    catch (e) { state.busy = false; body(el('div', { class: 'sa-arb-warn', text: `Error cargando tinas: ${e.message}` })); return; }
    // 3. líneas destino disponibles.
    const set = new Set();
    for (const tid of Object.keys(state.candidates)) for (const s of state.candidates[tid]) {
      const c = lc(s.name); if (c) set.add(c);
    }
    const sources = new Set(state.wos.filter((w) => !w.error).map((w) => w.sourceLine));
    state.destLines = [...set].filter((d) => !sources.has(d) || sources.size > 1).sort();
    state.destLine = state.destLines[0] || null;
    state.busy = false;
    renderPreview();
  }

  function renderPreview() {
    const destSel = el('select', { onchange: (e) => { state.destLine = e.target.value; renderPreview(); } },
      state.destLines.map((d) => { const o = el('option', { value: d, text: d }); if (d === state.destLine) o.selected = true; return o; }));
    const ok = state.wos.filter((w) => !w.error);
    const head = el('div', { class: 'sa-arb-row' }, [
      el('span', { text: `${ok.length} órdenes resueltas · línea destino:` }), destSel,
    ]);
    const tb = el('table', { class: 'sa-arb-tb' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Orden' }), el('th', { text: 'Parte' }), el('th', { text: 'Origen→Destino' }),
        el('th', { text: 'Tinas a re-rutear' }), el('th', { text: 'Estado', id: 'x' }),
      ])]),
    ]);
    const tbody = el('tbody');
    for (const wo of state.wos) {
      const tr = el('tr', { id: `sa-arb-r-${wo.idInDomain}` });
      if (wo.error) {
        tr.appendChild(el('td', { text: `#${wo.idInDomain}` }));
        tr.appendChild(el('td', { text: '—' }));
        tr.appendChild(el('td', { text: '—' }));
        tr.appendChild(el('td', { text: '—' }));
        tr.appendChild(el('td', {}, [el('span', { class: 'sa-arb-st err', text: wo.error })]));
      } else {
        const cc = state.destLine ? changedCount(wo.routeData, wo.sourceLine, state.destLine, state.candidates) : { changed: 0, total: 0 };
        tr.appendChild(el('td', { text: `#${wo.idInDomain}` }));
        tr.appendChild(el('td', { text: wo.partNumberName || String(wo.partNumberId) }));
        tr.appendChild(el('td', { text: `${wo.sourceLine || '?'} → ${state.destLine || '?'}` }));
        tr.appendChild(el('td', { text: cc.changed ? `${cc.changed}` : '0 (sin tinas en destino)' }));
        tr.appendChild(el('td', {}, [el('span', { class: 'sa-arb-st', id: `sa-arb-stx-${wo.idInDomain}`, text: 'listo' })]));
      }
      tbody.appendChild(tr);
    }
    tb.appendChild(tbody);
    body(el('div', {}, [head, el('div', { class: 'sa-arb-note', text: 'Cada orden se re-lee justo antes de aplicar (para que el save persista). Las tinas finas se ajustan en el modo individual.' }), tb]));
    const applicable = ok.filter((w) => state.destLine && w.sourceLine && w.sourceLine !== state.destLine);
    const btn = el('button', { class: 'sa-arb-btn primary', text: `Aplicar a ${applicable.length} órdenes`, onclick: applyAll });
    if (!applicable.length || state.busy) btn.disabled = true;
    foot(el('button', { class: 'sa-arb-btn ghost', text: 'Cancelar', onclick: close }), btn);
  }

  function setRow(idInDomain, cls, text) {
    const x = document.getElementById(`sa-arb-stx-${idInDomain}`);
    if (x) { x.className = `sa-arb-st ${cls}`; x.textContent = text; }
  }

  async function applyAll() {
    if (state.busy) return;
    state.busy = true;
    const targets = state.wos.filter((w) => !w.error && state.destLine && w.sourceLine && w.sourceLine !== state.destLine);
    foot(el('span', { class: 'sa-arb-note', id: 'sa-arb-prog', text: `Aplicando 0/${targets.length}…` }));
    let done = 0, okN = 0;
    const results = await pool(targets, CONCURRENCY, async (wo) => {
      setRow(wo.idInDomain, 'run', 'aplicando…');
      try {
        const res = await applyOne(wo, state.destLine, state.candidates);
        done++;
        const prog = document.getElementById('sa-arb-prog'); if (prog) prog.textContent = `Aplicando ${done}/${targets.length}…`;
        if (res.ok) { okN++; setRow(wo.idInDomain, 'ok', `✓ +${res.created} ~${res.updated} -${res.deleted}`); return { wo, res }; }
        setRow(wo.idInDomain, 'err', `⚠️ ${res.msg}`); return { wo, res };
      } catch (e) {
        done++; setRow(wo.idInDomain, 'err', `error: ${e.message}`); return { wo, error: e.message };
      }
    });
    state.busy = false;
    log(`Batch: ${okN}/${targets.length} órdenes ruteadas a ${state.destLine}.`);
    foot(
      el('span', { class: 'sa-arb-note', text: `Listo: ${okN}/${targets.length} órdenes ruteadas a ${state.destLine}.` }),
      el('button', { class: 'sa-arb-btn primary', text: 'Cerrar', onclick: close }),
    );
    void results;
  }

  if (typeof window !== 'undefined') window.AutoRouterBatch = { open, close };
  return { open, close };
})();
