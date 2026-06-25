/* ============================================================================
 * load-calculator.js — Calculadora de Piezas por Carga (applet de la extensión)
 *
 * FASE 1 — Configurador de Estaciones (datos maestros). Se abre desde el popup
 * (`LoadCalculator.openStationConfig`), inyecta un panel (tema OSCURO, el que
 * diferencia los modales de la extensión de los de Steelhead) en la tab, y
 * captura los parámetros del calculador en `customInputs` de las estaciones
 * PROGRAMABLES (las que tienen calendario: `-LI` / cotizables).
 *
 * Campos: TipoLinea · Tina largo/ancho MÁX (cm) · Sep col/fila (cm) · FactorArea
 *         · CapacidadesBarril[] (array {RackType, DM²} — una estación procesa
 *           varios barriles con distinta capacidad).
 * (Ciclo y OEE NO se configuran aquí: el ciclo sale del tratamiento genérico del
 *  proceso del NP.)
 *
 * Ops GraphQL: AllStations · GetStation · GetStationInputSchema · AllRackTypes
 *              (queries) · CreateStationInputSchema · UpdateStationInputs (mut).
 *
 * Depende de window.SteelheadAPI y window.LoadCalculatorStations.
 * Expone window.LoadCalculator = { openStationConfig }.
 * ========================================================================== */
(function () {
  'use strict';

  const api = () => window.SteelheadAPI;
  const ST  = () => window.LoadCalculatorStations;
  const log = (...a) => console.log('[load-calculator]', ...a);
  const warn = (...a) => console.warn('[load-calculator]', ...a);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Campos del calculador. CapacidadesBarril es un ARRAY {rackTypeId, rackTypeName, capacidadDMK}.
  const CALC_FIELDS = {
    TipoLinea:         { type: 'string', enum: ['Rack', 'Barril', 'Híbrida', 'Célula'], title: 'Tipo de Línea' },
    TinaLargoMaxCm:    { type: 'number', title: 'Largo máximo de tina (cm)' },
    TinaAnchoMaxCm:    { type: 'number', title: 'Ancho máximo de tina (cm)' },
    SepColCm:          { type: 'number', title: 'Separación entre columnas (cm)' },
    SepFilaCm:         { type: 'number', title: 'Separación entre filas (cm)' },
    FactorArea:        { type: 'number', title: 'Factor de área (def 1.5)' },
    CapacidadesBarril: { type: 'array', title: 'Capacidades de barril (por Rack Type, DM²)',
      items: { type: 'object', properties: { rackTypeId: { type: 'integer' }, rackTypeName: { type: 'string' }, capacidadDMK: { type: 'number' } } } },
  };
  const CALC_KEYS = Object.keys(CALC_FIELDS);
  const SIMPLE_KEYS = CALC_KEYS.filter(k => k !== 'CapacidadesBarril');

  let state = null;
  const freshState = () => ({ schedulable: [], schema: null, rackTypes: [], barril: [] });

  // ───────────────────────── estilos (tema OSCURO) ─────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-lc-styles')) return;
    const css = `
      .sa-lc-overlay{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.6);
        display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
      .sa-lc-modal{background:#1e293b;color:#e2e8f0;width:640px;max-width:94vw;max-height:90vh;border-radius:12px;
        box-shadow:0 12px 48px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden}
      .sa-lc-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
        padding:18px 22px;border-bottom:1px solid #334155}
      .sa-lc-header h2{margin:0;font-size:17px;color:#38bdf8}
      .sa-lc-sub{font-size:12px;color:#94a3b8;margin-top:3px}
      .sa-lc-close{border:0;background:#334155;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:15px;color:#e2e8f0}
      .sa-lc-body{padding:18px 22px;overflow:auto}
      .sa-lc-footer{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid #334155}
      .sa-lc-btn{border:1px solid #475569;background:#334155;color:#e2e8f0;border-radius:8px;padding:8px 16px;cursor:pointer;font-size:13px}
      .sa-lc-btn.primary{background:#38bdf8;border-color:#38bdf8;color:#0f172a;font-weight:600}
      .sa-lc-btn:disabled{opacity:.45;cursor:not-allowed}
      .sa-lc-row{display:grid;grid-template-columns:210px 1fr;gap:12px;align-items:center;margin:9px 0}
      .sa-lc-row label{font-size:13px;color:#cbd5e1}
      .sa-lc-row input,.sa-lc-row select,.sa-lc-fullsel{min-width:0;width:100%;box-sizing:border-box;padding:8px 10px;
        border:1px solid #475569;border-radius:7px;font-size:13px;background:#0f172a;color:#e2e8f0}
      .sa-lc-banner{background:#422006;border:1px solid #a16207;color:#fde68a;border-radius:8px;padding:11px 13px;font-size:13px;margin-bottom:14px;
        display:flex;align-items:center;justify-content:space-between;gap:10px}
      .sa-lc-section{margin-top:14px;border-top:1px dashed #334155;padding-top:12px}
      .sa-lc-section h3{margin:0 0 8px;font-size:13px;color:#7dd3fc}
      .sa-lc-brow{display:grid;grid-template-columns:1fr 130px 32px;gap:8px;align-items:center;margin:6px 0}
      .sa-lc-brow input,.sa-lc-brow select{min-width:0;width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #475569;border-radius:7px;background:#0f172a;color:#e2e8f0;font-size:13px}
      .sa-lc-xbtn{border:0;background:#7f1d1d;color:#fecaca;border-radius:6px;height:32px;cursor:pointer}
      .sa-lc-addbtn{margin-top:6px;border:1px dashed #475569;background:transparent;color:#7dd3fc;border-radius:7px;padding:6px 12px;cursor:pointer;font-size:12px}
      .sa-lc-msg{font-size:13px;margin-top:12px}
      .sa-lc-msg.ok{color:#4ade80}.sa-lc-msg.err{color:#f87171}`;
    const el = document.createElement('style');
    el.id = 'sa-lc-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function removeOverlay() { document.getElementById('sa-lc-overlay')?.remove(); }
  function closePanel() { removeOverlay(); state = null; }

  function showShell() {
    removeOverlay();
    const ov = document.createElement('div');
    ov.className = 'sa-lc-overlay';
    ov.id = 'sa-lc-overlay';
    ov.innerHTML = `
      <div class="sa-lc-modal" role="dialog" aria-modal="true">
        <div class="sa-lc-header">
          <div><h2>⚙️ Configurador de Estaciones</h2>
            <div class="sa-lc-sub">Parámetros del calculador de piezas por carga (estaciones programables)</div></div>
          <button class="sa-lc-close" id="sa-lc-close" title="Cerrar">✕</button>
        </div>
        <div class="sa-lc-body" id="sa-lc-body"><div class="sa-lc-sub">Cargando estaciones…</div></div>
        <div class="sa-lc-footer">
          <button class="sa-lc-btn" id="sa-lc-cancel">Cerrar</button>
          <button class="sa-lc-btn primary" id="sa-lc-save" disabled>Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#sa-lc-close').onclick = closePanel;
    ov.querySelector('#sa-lc-cancel').onclick = closePanel;
  }

  const $body = () => document.getElementById('sa-lc-body');
  const $save = () => document.getElementById('sa-lc-save');

  // ───────────────────────── data layer ─────────────────────────
  async function fetchAllStations() {
    const PAGE = 500;
    let offset = 0; const out = [];
    while (true) {
      let data;
      try { data = await api().query('AllStations', { orderBy: ['NAME_ASC'], offset, first: PAGE, searchQuery: '' }); }
      catch (e) { warn(`AllStations offset ${offset}:`, String(e).slice(0, 120)); break; }
      const nodes = data?.pagedData?.nodes || [];
      out.push(...nodes);
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 20000) { warn('AllStations: límite de seguridad'); break; }
    }
    return out;
  }

  async function fetchRackTypes() {
    try {
      const data = await api().query('AllRackTypes', {});
      const nodes = data?.pagedData?.nodes || data?.allRackTypes?.nodes || [];
      return nodes.map(n => ({ id: n.id, name: n.name })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { warn('AllRackTypes', e); return []; }
  }

  async function fetchLatestStationSchema() {
    const data = await api().query('GetStationInputSchema', {});
    const nodes = data?.allStationInputSchemas?.nodes || [];
    if (!nodes.length) return null;
    const latest = nodes.reduce((a, b) => (b.id > a.id ? b : a));
    return { id: latest.id, inputSchema: latest.inputSchema, uiOrder: (latest.uiSchema && latest.uiSchema['ui:order']) || [] };
  }

  async function loadStation(id) {
    const data = await api().query('GetStation', { id });
    const s = data?.stationById || {};
    return { name: s.name, customInputs: s.customInputs || {}, inputSchemaId: s.stationInputSchemaByInputSchemaId?.id ?? null };
  }

  async function ensureSchemaHasCalcFields() {
    let latest = await fetchLatestStationSchema();
    const missing = ST().schemaMissingFields(latest && latest.inputSchema, CALC_KEYS);
    if (!missing.length) return latest;
    const fields = {};
    for (const k of missing) fields[k] = CALC_FIELDS[k];
    const { inputSchema, uiSchema } = ST().buildStationInputSchema({
      existingSchema: latest && latest.inputSchema, existingUiOrder: latest && latest.uiOrder, fields,
    });
    await api().query('CreateStationInputSchema', { inputSchema, uiSchema });
    return await fetchLatestStationSchema();
  }

  async function saveStationValues(stationId, inputSchemaId, values) {
    const existing = await loadStation(stationId);
    const vars = ST().buildUpdateStationInputsVars({ stationId, inputSchemaId, existingCustomInputs: existing.customInputs, values });
    await api().query('UpdateStationInputs', vars);
  }

  // ───────────────────────── UI ─────────────────────────
  function simpleInputHtml(key) {
    const def = CALC_FIELDS[key];
    if (def.enum) {
      return `<select class="sa-lc-f" data-key="${key}">${['<option value="">—</option>', ...def.enum.map(v => `<option value="${esc(v)}">${esc(v)}</option>`)].join('')}</select>`;
    }
    return `<input class="sa-lc-f" data-key="${key}" type="number" step="any" placeholder="—">`;
  }

  function barrelRowHtml(row) {
    const opts = ['<option value="">— Rack Type —</option>', ...state.rackTypes.map(rt =>
      `<option value="${rt.id}" ${String(row.rackTypeId) === String(rt.id) ? 'selected' : ''}>${esc(rt.name)}</option>`)].join('');
    return `<div class="sa-lc-brow">
      <select class="sa-lc-brt">${opts}</select>
      <input class="sa-lc-bcap" type="number" step="any" placeholder="DM²" value="${row.capacidadDMK ?? ''}">
      <button class="sa-lc-xbtn" title="Quitar">✕</button></div>`;
  }

  function renderBarrels() {
    const cont = document.getElementById('sa-lc-barrels');
    if (!cont) return;
    cont.innerHTML = state.barril.map(barrelRowHtml).join('') || '<div class="sa-lc-sub">Sin capacidades de barril. Agrega una si la estación procesa barriles.</div>';
    cont.querySelectorAll('.sa-lc-brow').forEach((rowEl, i) => {
      rowEl.querySelector('.sa-lc-brt').onchange = (e) => { state.barril[i].rackTypeId = e.target.value ? Number(e.target.value) : null; state.barril[i].rackTypeName = e.target.selectedOptions[0]?.textContent || ''; };
      rowEl.querySelector('.sa-lc-bcap').oninput = (e) => { state.barril[i].capacidadDMK = e.target.value === '' ? null : Number(e.target.value); };
      rowEl.querySelector('.sa-lc-xbtn').onclick = () => { state.barril.splice(i, 1); renderBarrels(); };
    });
  }

  function renderForm() {
    const missing = ST().schemaMissingFields(state.schema && state.schema.inputSchema, CALC_KEYS);
    const banner = missing.length
      ? `<div class="sa-lc-banner"><span>El esquema de estaciones aún no tiene ${missing.length} campo(s) del calculador.</span>
         <button class="sa-lc-btn" id="sa-lc-extend">Extender esquema</button></div>` : '';

    const stationOpts = state.schedulable.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const simpleRows = SIMPLE_KEYS.map(k =>
      `<div class="sa-lc-row"><label>${esc(CALC_FIELDS[k].title)}</label>${simpleInputHtml(k)}</div>`).join('');

    $body().innerHTML = `
      ${banner}
      <div class="sa-lc-row"><label>Estación programable</label><select id="sa-lc-target" class="sa-lc-fullsel">${stationOpts}</select></div>
      ${simpleRows}
      <div class="sa-lc-section">
        <h3>${esc(CALC_FIELDS.CapacidadesBarril.title)}</h3>
        <div id="sa-lc-barrels"></div>
        <button class="sa-lc-addbtn" id="sa-lc-addbarrel">+ Agregar barril</button>
      </div>
      <div class="sa-lc-msg" id="sa-lc-msg"></div>`;

    const ext = document.getElementById('sa-lc-extend');
    if (ext) ext.onclick = onExtendSchema;
    const tgt = document.getElementById('sa-lc-target');
    tgt.onchange = () => prefillFromStation(Number(tgt.value));
    document.getElementById('sa-lc-addbarrel').onclick = () => { state.barril.push({ rackTypeId: null, rackTypeName: '', capacidadDMK: null }); renderBarrels(); };
    renderBarrels();
    $save().disabled = missing.length > 0;
    $save().onclick = onSave;
    if (tgt.value) prefillFromStation(Number(tgt.value));
  }

  function collectValues() {
    const values = {};
    $body().querySelectorAll('.sa-lc-f').forEach(el => {
      const raw = el.value;
      if (raw === '' || raw == null) return;
      const def = CALC_FIELDS[el.dataset.key];
      values[el.dataset.key] = def.enum ? raw : Number(raw);
    });
    const barril = state.barril.filter(b => b.rackTypeId != null && b.capacidadDMK != null);
    if (barril.length) values.CapacidadesBarril = barril;
    return values;
  }

  async function prefillFromStation(stationId) {
    try {
      const st = await loadStation(stationId);
      const ci = st.customInputs || {};
      $body().querySelectorAll('.sa-lc-f').forEach(el => {
        const v = ci[el.dataset.key];
        el.value = (v === undefined || v === null) ? '' : v;
      });
      state.barril = Array.isArray(ci.CapacidadesBarril) ? ci.CapacidadesBarril.map(b => ({ ...b })) : [];
      renderBarrels();
    } catch (e) { warn('prefill', e); }
  }

  function setMsg(text, kind) {
    const m = document.getElementById('sa-lc-msg');
    if (m) { m.textContent = text; m.className = 'sa-lc-msg ' + (kind || ''); }
  }

  async function onExtendSchema() {
    const ext = document.getElementById('sa-lc-extend');
    if (ext) { ext.disabled = true; ext.textContent = 'Extendiendo…'; }
    try {
      state.schema = await ensureSchemaHasCalcFields();
      renderForm();
      setMsg('Esquema extendido. Ya puedes capturar parámetros.', 'ok');
    } catch (e) {
      warn('extend schema', e);
      setMsg('Error al extender el esquema: ' + String(e).slice(0, 160), 'err');
      if (ext) { ext.disabled = false; ext.textContent = 'Extender esquema'; }
    }
  }

  async function onSave() {
    const values = collectValues();
    if (!Object.keys(values).length) { setMsg('No capturaste ningún valor.', 'err'); return; }
    if (!state.schema || !state.schema.id) { setMsg('Esquema no disponible.', 'err'); return; }
    const tgt = document.getElementById('sa-lc-target');
    const stationId = Number(tgt.value);
    $save().disabled = true;
    try {
      setMsg('Guardando…');
      await saveStationValues(stationId, state.schema.id, values);
      setMsg('✓ Estación actualizada.', 'ok');
    } catch (e) {
      warn('save', e);
      setMsg('Error al guardar: ' + String(e).slice(0, 160), 'err');
    } finally {
      $save().disabled = false;
    }
  }

  // ───────────────────────── entry point ─────────────────────────
  async function openStationConfig() {
    if (!api() || typeof api().query !== 'function') { alert('SteelheadAPI no disponible. Recarga la página de Steelhead.'); return; }
    if (!ST()) { alert('Módulo load-calculator-stations no cargado.'); return; }
    if (document.getElementById('sa-lc-overlay')) return;
    injectStyles();
    state = freshState();
    showShell();
    try {
      const [stations, schema, rackTypes] = await Promise.all([fetchAllStations(), fetchLatestStationSchema(), fetchRackTypes()]);
      state.schedulable = stations.filter(ST().stationIsSchedulable).map(s => ({ id: s.id, name: s.name }));
      state.schema = schema;
      state.rackTypes = rackTypes;
      if (!state.schedulable.length) { $body().innerHTML = '<div class="sa-lc-msg err">No se encontraron estaciones programables (con calendario).</div>'; return; }
      renderForm();
    } catch (e) {
      warn('open', e);
      if ($body()) $body().innerHTML = `<div class="sa-lc-msg err">Error: ${esc(String(e).slice(0, 200))}</div>`;
    }
    return { ok: true };
  }

  window.LoadCalculator = Object.assign(window.LoadCalculator || {}, { openStationConfig });
  log('listo (Configurador de Estaciones)');
})();
