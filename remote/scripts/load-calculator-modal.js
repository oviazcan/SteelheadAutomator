/* ============================================================================
 * load-calculator-modal.js — Fase 2a: calculadora dentro del modal de Rack Types
 *
 * autoInject. Intercepta `CreateEditPartsPerRackTypeQuery` (el query que abre el
 * modal "...that can fit on a rack type"), resuelve la LÍNEA del PN → su estación
 * programable (-LI) → params de tina/barriles, lee las dims de la pieza (Geometry
 * Type) y el área DMK del PN, y cuando eliges un Rack Type calcula piezas/carga
 * (BARRIL si el rack está en las Capacidades de barril de la estación; si no RACK
 * = cuadrícula + área) y ofrece **Aplicar** al campo "Parts Per Rack".
 *
 * F2a NO escribe en el PN (solo autollenan el campo del modal; tú das Save nativo).
 * La persistencia (DatosPlanificacion + CC + dims/DMK) es F2b.
 *
 * Depende de window.SteelheadAPI, window.LoadCalculatorEngine, window.LoadCalculatorStations.
 * ========================================================================== */
(function () {
  'use strict';

  const api = () => window.SteelheadAPI;
  const ENG = () => window.LoadCalculatorEngine;
  const ST  = () => window.LoadCalculatorStations;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (...a) => console.log('[load-calc-modal]', ...a);
  const warn = (...a) => console.warn('[load-calc-modal]', ...a);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  let ctx = null;        // contexto del modal abierto
  let modalObserver = null;
  let lastRackName = null;

  // ───────────────────────── fetch intercept ─────────────────────────
  function patchFetch() {
    if (window.__saLoadCalcModalPatched) return;
    window.__saLoadCalcModalPatched = true;
    const orig = window.fetch;
    window.fetch = async function (...args) {
      const [url, opts] = args;
      let op = null, vars = null;
      if (typeof url === 'string' && url.includes('/graphql') && opts && typeof opts.body === 'string') {
        try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
      }
      const resp = await orig.apply(this, args);
      if (op === 'CreateEditPartsPerRackTypeQuery' && vars && vars.partNumberId) {
        const pnId = vars.partNumberId;
        try { resp.clone().json().then(j => onModalData(pnId, j && j.data)).catch(() => {}); } catch (_) {}
      }
      return resp;
    };
    log('fetch intercept activo');
  }

  // ───────────────────────── captura + resolución ─────────────────────────
  async function onModalData(partNumberId, data) {
    try {
      const rackTypes = ((data && data.allRackTypes && data.allRackTypes.nodes) || []).map(n => ({ id: n.id, name: n.name }));
      const conv = (((data && data.partNumberById && data.partNumberById.inventoryItemByPartNumberId
        && data.partNumberById.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId) || {}).nodes) || [];
      const dmkId = cfg()?.steelhead?.domain?.unitIds?.DMK || 3975;
      ctx = {
        partNumberId,
        pnName: (data && data.partNumberById && data.partNumberById.name) || '',
        rackTypes,
        areaPieza_dm2: ENG().pieceAreaDm2FromConversions(conv, dmkId),
        linea: null, pieceDims: null, stationsForLine: [], estacion: null, params: null, result: null,
      };
      showPanel();
      await resolveContext();
      renderPanel();
      observeModal();
    } catch (e) { warn('onModalData', e); }
  }

  async function resolveContext() {
    // GetPartNumber → línea + dims de pieza
    let node = null;
    try {
      const r = await api().query('GetPartNumber', { partNumberId: ctx.partNumberId, usagesLimit: 0 });
      node = r && r.partNumberById;
    } catch (e) { warn('GetPartNumber', e); }

    ctx.linea = await resolveLinea(node).catch(() => null);
    ctx.pieceDims = resolvePieceDims(node);

    // estaciones programables de la línea
    try {
      const stations = await fetchAllStations();
      const code = ST().parseStationLine(ctx.linea) || ST().parseStationLine(ctx.pnName) || null;
      ctx.lineCode = code;
      ctx.stationsForLine = code ? ST().findSchedulableStationsForLine(stations, code) : [];
      ctx.allSchedulable = stations.filter(ST().stationIsSchedulable).map(s => ({ id: s.id, name: s.name }));
      ctx.estacion = ctx.stationsForLine[0] ? { id: ctx.stationsForLine[0].id, name: ctx.stationsForLine[0].name } : null;
      if (ctx.estacion) ctx.params = await loadStationParams(ctx.estacion.id);
    } catch (e) { warn('resolve estación', e); }
  }

  async function resolveLinea(node) {
    if (!node) return null;
    const lineaDimId = cfg()?.steelhead?.domain?.dimensionIds?.linea || 349;
    const sels = (node.acctPnDimensionValueSelectionsByPartNumberId && node.acctPnDimensionValueSelectionsByPartNumberId.nodes) || [];
    const sel = sels.find(s => s.dimensionId === lineaDimId);
    if (!sel || sel.dimensionCustomValueId == null) return null;
    try {
      const dim = await api().query('GetDimension', { id: lineaDimId, includeArchived: 'NO' });
      const vals = (dim && dim.acctDimensionById && dim.acctDimensionById.acctDimensionCustomValuesByDimensionId
        && dim.acctDimensionById.acctDimensionCustomValuesByDimensionId.nodes) || [];
      const v = vals.find(x => x.id === sel.dimensionCustomValueId);
      return v ? String(v.value).trim() : null;
    } catch (e) { warn('GetDimension', e); return null; }
  }

  function resolvePieceDims(node) {
    const dims = (node && node.partNumberDimensionsByPartNumberId && node.partNumberDimensionsByPartNumberId.nodes) || [];
    const active = dims.filter(d => d && !d.archivedAt);
    return ENG().dimsToPieceInches(active, cfg()?.steelhead?.domain?.geometryDimensions);
  }

  async function fetchAllStations() {
    const PAGE = 500; let offset = 0; const out = [];
    while (true) {
      let data;
      try { data = await api().query('AllStations', { orderBy: ['NAME_ASC'], offset, first: PAGE, searchQuery: '' }); }
      catch (e) { warn('AllStations', e); break; }
      const nodes = (data && data.pagedData && data.pagedData.nodes) || [];
      out.push(...nodes);
      if (nodes.length < PAGE) break;
      offset += PAGE; if (offset > 20000) break;
    }
    return out;
  }

  async function loadStationParams(stationId) {
    try {
      const r = await api().query('GetStation', { id: stationId });
      const ci = (r && r.stationById && r.stationById.customInputs) || {};
      return {
        TipoLinea: ci.TipoLinea, TinaLargoMaxCm: ci.TinaLargoMaxCm, TinaAnchoMaxCm: ci.TinaAnchoMaxCm,
        SepColCm: ci.SepColCm, SepFilaCm: ci.SepFilaCm, FactorArea: ci.FactorArea,
        CapacidadesBarril: Array.isArray(ci.CapacidadesBarril) ? ci.CapacidadesBarril : [],
      };
    } catch (e) { warn('GetStation', e); return null; }
  }

  // ───────────────────────── cálculo ─────────────────────────
  function recompute(rackName) {
    ctx.result = null;
    if (!rackName || !ctx.params) return;
    const rt = ctx.rackTypes.find(r => r.name === rackName);
    if (!rt) return;
    const p = ctx.params;
    ctx.result = ENG().computeForRackType({
      rackTypeId: rt.id,
      capacidadesBarril: p.CapacidadesBarril,
      areaPieza_dm2: ctx.areaPieza_dm2,
      piece: ctx.pieceDims ? { largoIn: ctx.pieceDims.largoIn, anchoIn: ctx.pieceDims.anchoIn } : null,
      tina: { largoMaxCm: p.TinaLargoMaxCm, anchoMaxCm: p.TinaAnchoMaxCm, sepColCm: p.SepColCm, sepFilaCm: p.SepFilaCm, factor: p.FactorArea },
    });
    ctx.rackName = rackName;
  }

  // ───────────────────────── DOM del modal ─────────────────────────
  function findModal() {
    const titles = document.querySelectorAll('h2#form-dialog-title, [id="form-dialog-title"]');
    for (const t of titles) {
      if (/rack type/i.test(t.textContent || '')) return t.closest('[role="dialog"]') || t.parentElement;
    }
    return null;
  }
  function readSelectedRackName(modal) {
    const sv = modal && modal.querySelector('.css-b62m3t-container [class*="singleValue"], [class*="-singleValue"]');
    return sv ? (sv.textContent || '').trim() : null;
  }
  function fillPartsPerRack(modal, value) {
    const inp = modal && modal.querySelector('input.MuiOutlinedInput-input');
    if (!inp) return false;
    try {
      if (inp._valueTracker) inp._valueTracker.setValue('');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(inp, String(value)); else inp.value = String(value);
      inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { warn('fill', e); return false; }
  }

  function observeModal() {
    if (modalObserver) modalObserver.disconnect();
    const modal = findModal();
    if (!modal) return;
    const onChange = () => {
      const name = readSelectedRackName(modal);
      if (name && name !== lastRackName) { lastRackName = name; recompute(name); renderPanel(); }
      if (!findModal()) cleanup(); // modal cerrado
    };
    modalObserver = new MutationObserver(onChange);
    modalObserver.observe(modal, { subtree: true, childList: true, characterData: true });
    onChange();
  }

  // ───────────────────────── panel (tema oscuro, esquina) ─────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-lcm-styles')) return;
    const css = `
      .sa-lcm{position:fixed;top:16px;right:16px;z-index:2147483601;width:320px;background:#1e293b;color:#e2e8f0;
        border:1px solid #334155;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px}
      .sa-lcm-h{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #334155}
      .sa-lcm-h b{color:#38bdf8;font-size:14px}
      .sa-lcm-x{border:0;background:#334155;color:#e2e8f0;border-radius:6px;width:24px;height:24px;cursor:pointer}
      .sa-lcm-b{padding:12px 14px;max-height:60vh;overflow:auto}
      .sa-lcm-row{margin:6px 0;color:#cbd5e1}
      .sa-lcm-row b{color:#e2e8f0}
      .sa-lcm-warn{color:#fbbf24}
      .sa-lcm-sel{width:100%;margin-top:4px;padding:6px 8px;background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;font-size:12px}
      .sa-lcm-res{margin-top:10px;border-top:1px dashed #334155;padding-top:10px}
      .sa-lcm-big{font-size:22px;color:#4ade80;font-weight:700}
      .sa-lcm-apply{margin-top:8px;width:100%;border:0;background:#38bdf8;color:#0f172a;font-weight:600;border-radius:7px;padding:8px;cursor:pointer}
      .sa-lcm-apply.alt{background:#334155;color:#e2e8f0;margin-top:6px}`;
    const el = document.createElement('style'); el.id = 'sa-lcm-styles'; el.textContent = css; document.head.appendChild(el);
  }

  function showPanel() {
    injectStyles();
    if (document.getElementById('sa-lcm')) return;
    const d = document.createElement('div');
    d.className = 'sa-lcm'; d.id = 'sa-lcm';
    d.innerHTML = `<div class="sa-lcm-h"><b>🧮 Piezas por carga</b><button class="sa-lcm-x" id="sa-lcm-x">✕</button></div><div class="sa-lcm-b" id="sa-lcm-b">Cargando…</div>`;
    document.body.appendChild(d);
    d.querySelector('#sa-lcm-x').onclick = cleanup;
  }

  function renderPanel() {
    const b = document.getElementById('sa-lcm-b');
    if (!b || !ctx) return;
    const estSel = ctx.allSchedulable && ctx.allSchedulable.length
      ? `<select class="sa-lcm-sel" id="sa-lcm-est">${ctx.allSchedulable.map(s =>
          `<option value="${s.id}" ${ctx.estacion && ctx.estacion.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
      : '<span class="sa-lcm-warn">sin estaciones</span>';

    const area = ctx.areaPieza_dm2 != null ? `${ctx.areaPieza_dm2} dm²` : '<span class="sa-lcm-warn">—</span>';
    const dims = ctx.pieceDims ? `${ctx.pieceDims.largoIn.toFixed(2)}″ × ${ctx.pieceDims.anchoIn.toFixed(2)}″` : '<span class="sa-lcm-warn">sin dims</span>';
    const paramWarn = ctx.params ? '' : '<div class="sa-lcm-row sa-lcm-warn">⚠️ La estación no tiene parámetros cargados (usa el Configurador).</div>';

    let res = '<div class="sa-lcm-res sa-lcm-row">Elige un Rack Type en el modal…</div>';
    const r = ctx.result;
    if (r) {
      if (r.modo === 'BARRIL') {
        res = `<div class="sa-lcm-res"><div class="sa-lcm-row">Modo: <b>Barril</b> (cap ${r.capacidadDMK} dm²)</div>
          <div class="sa-lcm-big">${r.piezasPorCarga ?? '—'}</div>
          ${r.piezasPorCarga != null ? `<button class="sa-lcm-apply" data-v="${r.piezasPorCarga}">Aplicar ${r.piezasPorCarga}</button>` : '<span class="sa-lcm-warn">falta área de pieza</span>'}</div>`;
      } else {
        const g = r.grid && r.grid.piezasPorCarga, a = r.area && r.area.piezasPorCarga;
        res = `<div class="sa-lcm-res"><div class="sa-lcm-row">Modo: <b>Rack</b></div>
          ${g != null ? `<div class="sa-lcm-row">Cuadrícula: <b>${g}</b> (${r.grid.columnas}×${r.grid.filas}) <button class="sa-lcm-apply alt" data-v="${g}">Aplicar</button></div>` : '<div class="sa-lcm-row sa-lcm-warn">Cuadrícula: sin dims de pieza</div>'}
          ${a != null ? `<div class="sa-lcm-row">Área: <b>${a}</b> <button class="sa-lcm-apply alt" data-v="${a}">Aplicar</button></div>` : '<div class="sa-lcm-row sa-lcm-warn">Área: sin área de pieza</div>'}</div>`;
      }
    }

    b.innerHTML = `
      <div class="sa-lcm-row">PN: <b>${esc(ctx.pnName)}</b></div>
      <div class="sa-lcm-row">Línea: <b>${esc(ctx.linea || ctx.lineCode || '—')}</b></div>
      <div class="sa-lcm-row">Estación: ${estSel}</div>
      <div class="sa-lcm-row">Área pieza: <b>${area}</b> · Dims: <b>${dims}</b></div>
      ${paramWarn}${res}`;

    const sel = document.getElementById('sa-lcm-est');
    if (sel) sel.onchange = async () => {
      ctx.estacion = ctx.allSchedulable.find(s => String(s.id) === sel.value) || null;
      ctx.params = ctx.estacion ? await loadStationParams(ctx.estacion.id) : null;
      if (lastRackName) recompute(lastRackName);
      renderPanel();
    };
    b.querySelectorAll('.sa-lcm-apply').forEach(btn => {
      btn.onclick = () => { const modal = findModal(); if (modal && fillPartsPerRack(modal, btn.dataset.v)) { btn.textContent = '✓ Aplicado'; } };
    });
  }

  function cleanup() {
    if (modalObserver) { modalObserver.disconnect(); modalObserver = null; }
    document.getElementById('sa-lcm')?.remove();
    ctx = null; lastRackName = null;
  }

  // ───────────────────────── init ─────────────────────────
  function init() {
    if (window.__saLoadCalcModalInit) return;
    window.__saLoadCalcModalInit = true;
    patchFetch();
    log('listo (Fase 2a — calculadora en modal de Rack Types)');
  }
  init();
})();
