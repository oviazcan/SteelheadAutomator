// auto-router-panel.js — Panel de preview + aplicación (modo single-order, API-direct).
//
// Recibe el contexto capturado del modal nativo (workOrderId, partNumberId, árbol
// de recipeNodes), deja elegir la línea destino, calcula el mapeo con
// AutoRouterEngine, muestra un preview EDITABLE (una tina destino por nodo, con
// override manual), y al aprobar dispara CreateUpdateDeleteRoutes.
//
// Depende de: AutoRouterEngine, AutoRouterAPI, (ProcessShared opcional).
// Expone window.AutoRouterPanel.

const AutoRouterPanel = (() => {
  'use strict';

  const LOG = '[AR-Panel]';
  const Engine = () => window.AutoRouterEngine;
  const ARAPI = () => window.AutoRouterAPI;
  const log = (m) => window.SteelheadAPI?.log?.(m) ?? console.log(LOG, m);

  let state = fresh();
  function fresh() {
    return {
      ctx: null,
      sourceLine: null,
      destLine: null,
      candidates: null,      // { [treatmentId]: [{id,name}] }
      destLines: [],         // líneas destino disponibles
      result: null,          // salida del motor
      overrides: new Map(),  // recipeNodeId -> stationId (ediciones manuales)
      busy: false,
    };
  }

  // ── Detección de línea origen ──────────────────────────────────────────────
  function detectSourceLine(recipeNodes) {
    const lc = Engine().extractLineCode;
    // 1) por el nodo "Listo para Procesar" (ancla de la sección de línea).
    const listo = recipeNodes.find(
      (n) => /listo para procesar/i.test(n.name || '') && n.defaultStation
    );
    if (listo) {
      const code = lc(listo.defaultStation.name);
      if (code) return code;
    }
    // 2) fallback: línea más frecuente entre las tinas default (excluye satélites
    //    T300/T100 si hay una línea de proceso dominante TI00).
    const freq = new Map();
    for (const n of recipeNodes) {
      if (!n.defaultStation) continue;
      if (!/-TI\d{2}-/.test(n.defaultStation.name)) continue; // solo tinas de proceso húmedo
      const code = lc(n.defaultStation.name);
      if (code) freq.set(code, (freq.get(code) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [code, n] of freq) if (n > bestN) { best = code; bestN = n; }
    return best;
  }

  // Líneas destino candidatas: códigos de línea presentes en las candidatas de los
  // tratamientos de la sección origen, distintos de la línea origen.
  function computeDestLines(candidates, sourceLine) {
    const lc = Engine().extractLineCode;
    const set = new Set();
    for (const tId of Object.keys(candidates)) {
      for (const s of candidates[tId]) {
        const code = lc(s.name);
        if (code && code !== sourceLine) set.add(code);
      }
    }
    return [...set].sort();
  }

  function compute() {
    const { ctx, sourceLine, destLine, candidates } = state;
    if (!destLine) { state.result = null; return; }
    state.result = Engine().computeRoutes({
      recipeNodes: ctx.routeData.recipeNodes,
      candidatesByTreatment: candidates,
      sourceLineCode: sourceLine,
      destLineCode: destLine,
      partNumberId: ctx.partNumberId,
      workOrderId: ctx.workOrderId,
    });
    state.overrides.clear();
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-arp-style')) return;
    const css = `
      .sa-arp-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483640;
        display:flex;align-items:center;justify-content:center;}
      .sa-arp{background:#fff;width:min(880px,94vw);max-height:90vh;border-radius:10px;
        display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.35);
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2430;}
      .sa-arp h2{margin:0;font-size:17px;}
      .sa-arp-hd{padding:16px 20px;border-bottom:1px solid #e6e9ee;display:flex;
        align-items:center;justify-content:space-between;gap:12px;}
      .sa-arp-x{border:none;background:none;font-size:22px;cursor:pointer;color:#7a8696;}
      .sa-arp-bd{padding:16px 20px;overflow:auto;}
      .sa-arp-ft{padding:14px 20px;border-top:1px solid #e6e9ee;display:flex;
        align-items:center;justify-content:space-between;gap:12px;}
      .sa-arp-row{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;}
      .sa-arp-row label{font-size:13px;color:#55606e;}
      .sa-arp select,.sa-arp .sa-arp-rowsel{font-size:13px;padding:5px 7px;border:1px solid #c7cdd6;
        border-radius:6px;background:#fff;max-width:340px;}
      .sa-arp-btn{border:none;border-radius:7px;padding:9px 16px;font-size:14px;font-weight:600;
        cursor:pointer;}
      .sa-arp-btn.primary{background:#0b6e4f;color:#fff;}
      .sa-arp-btn.primary:disabled{background:#9bbcb0;cursor:not-allowed;}
      .sa-arp-btn.ghost{background:#eef1f5;color:#33404f;}
      table.sa-arp-tb{width:100%;border-collapse:collapse;font-size:12.5px;}
      table.sa-arp-tb th,table.sa-arp-tb td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef1f5;
        vertical-align:middle;}
      table.sa-arp-tb th{color:#7a8696;font-weight:600;position:sticky;top:0;background:#fff;}
      .sa-arp-tag{font-size:10.5px;padding:1px 6px;border-radius:9px;font-weight:700;}
      .sa-arp-tag.chg{background:#e6f4ee;color:#0b6e4f;}
      .sa-arp-tag.keep{background:#eef1f5;color:#7a8696;}
      .sa-arp-warn{background:#fdeee9;border:1px solid #f3c4b6;color:#9a3412;padding:10px 12px;
        border-radius:7px;font-size:13px;margin-bottom:12px;}
      .sa-arp-note{font-size:12px;color:#7a8696;}`;
    const s = document.createElement('style');
    s.id = 'sa-arp-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of children || []) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  function removeOverlay() {
    document.getElementById('sa-arp-ov')?.remove();
  }

  function open(ctx) {
    injectStyles();
    state = fresh();
    state.ctx = ctx;
    state.sourceLine = detectSourceLine(ctx.routeData.recipeNodes);
    renderShell();
    void loadAndCompute();
  }

  function close() {
    removeOverlay();
    state = fresh();
  }

  function renderShell() {
    removeOverlay();
    const ov = el('div', { id: 'sa-arp-ov', class: 'sa-arp-ov' });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    const panel = el('div', { class: 'sa-arp' });
    panel.appendChild(el('div', { class: 'sa-arp-hd' }, [
      el('h2', { text: `🔀 Auto-Ruteador · WO ${state.ctx.routeData.idInDomain ?? state.ctx.workOrderId}` }),
      el('button', { class: 'sa-arp-x', text: '×', onclick: close }),
    ]));
    panel.appendChild(el('div', { class: 'sa-arp-bd', id: 'sa-arp-bd' }));
    panel.appendChild(el('div', { class: 'sa-arp-ft', id: 'sa-arp-ft' }));
    ov.appendChild(panel);
    document.body.appendChild(ov);
    renderBody(el('div', { class: 'sa-arp-note', text: 'Cargando tinas posibles…' }));
  }

  function renderBody(node) {
    const bd = document.getElementById('sa-arp-bd');
    if (!bd) return;
    bd.textContent = '';
    bd.appendChild(node);
  }
  function renderFooter(...nodes) {
    const ft = document.getElementById('sa-arp-ft');
    if (!ft) return;
    ft.textContent = '';
    for (const n of nodes) if (n) ft.appendChild(n);
  }

  async function loadAndCompute() {
    const rn = state.ctx.routeData.recipeNodes;
    if (!state.sourceLine) {
      renderBody(el('div', { class: 'sa-arp-warn', text: 'No se pudo detectar la línea origen de esta orden.' }));
      return;
    }
    // tratamientos de la sección origen (los que se van a re-rutear).
    const lc = Engine().extractLineCode;
    const tids = [...new Set(rn
      .filter((n) => n.treatmentId != null && n.defaultStation && lc(n.defaultStation.name) === state.sourceLine)
      .map((n) => n.treatmentId))];
    try {
      state.candidates = await ARAPI().fetchCandidatesForTreatments(tids);
    } catch (e) {
      renderBody(el('div', { class: 'sa-arp-warn', text: `Error cargando tinas: ${e.message}` }));
      return;
    }
    state.destLines = computeDestLines(state.candidates, state.sourceLine);
    state.destLine = state.destLines[0] || null;
    compute();
    renderPreview();
  }

  function destCandidatesFor(treatmentId) {
    const lc = Engine().extractLineCode;
    return (state.candidates[treatmentId] || [])
      .filter((s) => lc(s.name) === state.destLine)
      .map((s) => ({ id: s.id, name: s.name, pos: Engine().physPos(s.name) }))
      .sort((a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9));
  }

  function renderPreview() {
    const rn = state.ctx.routeData.recipeNodes;
    const nodeById = new Map(rn.map((n) => [n.id, n]));
    const lc = Engine().extractLineCode;

    // Selector de línea destino.
    const destSel = el('select', {
      class: 'sa-arp-rowsel',
      onchange: (e) => { state.destLine = e.target.value; compute(); renderPreview(); },
    }, state.destLines.map((d) => {
      const o = el('option', { value: d, text: d });
      if (d === state.destLine) o.selected = true;
      return o;
    }));

    const controls = el('div', { class: 'sa-arp-row' }, [
      el('label', { text: `Origen: ${state.sourceLine}  →  Destino:` }),
      destSel,
      el('span', { class: 'sa-arp-note', text: `PN ${state.ctx.partNumberId ?? '—'} · ${rn.length} nodos` }),
    ]);

    const container = el('div', {}, [controls]);

    // Idempotencia: si la orden ya tiene ruteo activo, se actualiza/borra en vez de duplicar.
    const nActive = (state.ctx.routeData.activeRoutes || []).length;
    if (nActive) {
      container.appendChild(el('div', { class: 'sa-arp-note',
        text: `Esta orden ya tiene ${nActive} ruta(s) activa(s): se actualizarán/eliminarán las que cambien (sin duplicar).` }));
    }

    if (!state.destLine || !state.result) {
      container.appendChild(el('div', { class: 'sa-arp-warn', text: 'No hay líneas destino con tinas compatibles para esta orden.' }));
      renderBody(container);
      renderFooter(el('button', { class: 'sa-arp-btn ghost', text: 'Cerrar', onclick: close }));
      return;
    }

    // Tabla de rutas.
    const tb = el('table', { class: 'sa-arp-tb' });
    tb.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Paso del proceso' }),
      el('th', { text: 'Tina origen' }),
      el('th', { text: 'Tina destino' }),
      el('th', { text: '' }),
    ])]));
    const tbody = el('tbody');
    let changed = 0;
    const stationName = new Map(); // id -> name (para mostrar origen)
    for (const n of rn) if (n.defaultStation) stationName.set(n.defaultStation.id, n.defaultStation.name);

    for (const r of state.result.routes) {
      const n = nodeById.get(r.recipeNodeId);
      const inSource = n && n.defaultStation && lc(n.defaultStation.name) === state.sourceLine;
      const tr = el('tr');
      tr.appendChild(el('td', { text: n ? n.name : `nodo ${r.recipeNodeId}` }));
      tr.appendChild(el('td', { text: n && n.defaultStation ? n.defaultStation.name : '—' }));

      if (inSource) {
        changed++;
        const opts = destCandidatesFor(r.treatmentId);
        const chosen = state.overrides.get(r.recipeNodeId) ?? r.stationId;
        const sel = el('select', {
          class: 'sa-arp-rowsel',
          onchange: (e) => { state.overrides.set(r.recipeNodeId, Number(e.target.value)); refreshFooter(); },
        }, opts.map((o) => {
          const opt = el('option', { value: String(o.id), text: o.name });
          if (o.id === chosen) opt.selected = true;
          return opt;
        }));
        tr.appendChild(el('td', {}, [sel]));
        tr.appendChild(el('td', {}, [el('span', { class: 'sa-arp-tag chg', text: state.sourceLine + '→' + state.destLine })]));
      } else {
        tr.appendChild(el('td', { text: stationName.get(r.stationId) || `station ${r.stationId}` }));
        tr.appendChild(el('td', {}, [el('span', { class: 'sa-arp-tag keep', text: 'sin cambio' })]));
      }
      tbody.appendChild(tr);
    }
    tb.appendChild(tbody);

    if (state.result.skipped.length) {
      container.appendChild(el('div', { class: 'sa-arp-note',
        text: `${state.result.skipped.length} nodo(s) sin tina destino se omiten (globales/sin estación).` }));
    }
    container.appendChild(el('div', { class: 'sa-arp-note',
      text: `${changed} tinas re-ruteadas a ${state.destLine}. Revisa y ajusta cualquiera antes de aplicar.` }));
    container.appendChild(tb);
    renderBody(container);
    refreshFooter();
  }

  function refreshFooter() {
    let label = 'Aplicar ruteo';
    if (state.result && !state.busy) {
      const split = Engine().diffRoutes(desiredRoutes(), state.ctx.routeData.activeRoutes);
      const c = split.routesToCreate.length, u = split.routesToUpdate.length, d = split.routesToDelete.length;
      label = (c + u + d) === 0 ? 'Sin cambios que aplicar' : `Aplicar ruteo (+${c} ~${u} -${d})`;
    } else if (state.busy) {
      label = 'Aplicando…';
    }
    const applyBtn = el('button', { class: 'sa-arp-btn primary', text: label, onclick: apply });
    if (state.busy || !state.result) applyBtn.disabled = true;
    renderFooter(
      el('button', { class: 'sa-arp-btn ghost', text: 'Cancelar', onclick: close }),
      applyBtn,
    );
  }

  // Estado final deseado (rutas del motor + ediciones del operador).
  function desiredRoutes() {
    return state.result.routes.map((r) => ({
      ...r,
      stationId: state.overrides.has(r.recipeNodeId) ? state.overrides.get(r.recipeNodeId) : r.stationId,
    }));
  }

  async function apply() {
    if (state.busy || !state.result) return;
    state.busy = true;
    refreshFooter();
    try {
      // Re-carga el contexto JUSTO antes de aplicar. Steelhead exige una lectura
      // reciente del árbol de ruteo (StationTreatmentByWorkOrder) para que el save
      // persista: con el modal nativo abierto esa lectura está "fresca" y graba;
      // si el modal se cerró hace rato, la lectura quedó vieja y el servidor acepta
      // la mutación pero NO crea las rutas (rechazo silencioso). Re-fetchear aquí
      // replica la condición de "modal abierto" y refresca activeRoutes para el diff.
      let activeRoutes = state.ctx.routeData.activeRoutes;
      try {
        const fresh = await ARAPI().fetchWorkOrderRouteData(state.ctx.workOrderId, state.ctx.partNumberId);
        state.ctx.routeData = fresh;
        activeRoutes = fresh.activeRoutes;
      } catch (e) {
        log(`re-fetch previo a aplicar falló (uso contexto capturado): ${e.message}`);
      }

      const split = Engine().diffRoutes(desiredRoutes(), activeRoutes);
      const wantC = split.routesToCreate.length, wantU = split.routesToUpdate.length, wantD = split.routesToDelete.length;
      const want = wantC + wantU + wantD;
      if (want === 0) {
        renderBody(el('div', {}, [el('div', { class: 'sa-arp-row' }, [el('h2', { text: 'Sin cambios que aplicar' })])]));
        renderFooter(el('button', { class: 'sa-arp-btn primary', text: 'Cerrar', onclick: close }));
        return;
      }

      const res = await ARAPI().applyRoutes(split.routesToCreate, split.routesToUpdate, split.routesToDelete);
      const created = (res.createdRoutes || []).length;
      const updated = (res.updatedRoutes || []).length;
      const deleted = (res.deletedRouteIds || []).length;
      log(`CreateUpdateDeleteRoutes: pedí +${wantC} ~${wantU} -${wantD}; servidor +${created} ~${updated} -${deleted}.`);
      const woLabel = state.ctx.routeData.idInDomain ?? state.ctx.workOrderId;

      // Verificación honesta: el servidor debe haber CREADO lo que pedimos.
      // (update/delete no devuelven conteo confiable en todos los casos; el create
      // vacío con wantC>0 es la firma del rechazo silencioso por estado obsoleto.)
      if (wantC > 0 && created === 0) {
        renderBody(el('div', {}, [
          el('div', { class: 'sa-arp-row' }, [el('h2', { text: '⚠️ No se guardó el ruteo' })]),
          el('div', { class: 'sa-arp-warn',
            text: `El servidor aceptó la mutación pero creó 0 de ${wantC} rutas (estado obsoleto). Abre el modal de ruteo de la orden, déjalo abierto, y vuelve a presionar Aplicar.` }),
        ]));
        renderFooter(
          el('button', { class: 'sa-arp-btn ghost', text: 'Cerrar', onclick: close }),
          el('button', { class: 'sa-arp-btn primary', text: 'Reintentar', onclick: () => { state.busy = false; apply(); } }),
        );
        state.busy = false;
        return;
      }

      renderBody(el('div', {}, [
        el('div', { class: 'sa-arp-row' }, [el('h2', { text: '✅ Ruteo aplicado' })]),
        el('div', { class: 'sa-arp-note',
          text: `WO ${woLabel}: ${created} creadas, ${updated} actualizadas, ${deleted} eliminadas. Recarga el modal de ruteo para verlas.` }),
      ]));
      renderFooter(el('button', { class: 'sa-arp-btn primary', text: 'Cerrar', onclick: close }));
    } catch (e) {
      state.busy = false;
      log(`Error aplicando ruteo: ${e.message}`);
      const bd = document.getElementById('sa-arp-bd');
      if (bd) bd.insertBefore(el('div', { class: 'sa-arp-warn', text: `Error al aplicar: ${e.message}` }), bd.firstChild);
      refreshFooter();
    }
  }

  if (typeof window !== 'undefined') {
    window.AutoRouterPanel = { open, close };
  }
  return { open, close };
})();
