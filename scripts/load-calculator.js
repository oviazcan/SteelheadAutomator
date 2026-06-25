/* ============================================================================
 * load-calculator.js — Calculadora de Piezas por Carga (applet de la extensión)
 *
 * FASE 1 — Configurador de Estaciones (datos maestros). Se abre desde el popup
 * (`LoadCalculator.openStationConfig`), inyecta un panel en la tab de Steelhead,
 * y permite capturar los parámetros del calculador en `customInputs` de cada
 * estación (por estación individual o en bulk por línea).
 *
 * Depende de:
 *   - window.SteelheadAPI           (steelhead-api.js)
 *   - window.LoadCalculatorEngine   (load-calculator-engine.js)   [fase 2]
 *   - window.LoadCalculatorStations (load-calculator-stations.js) [núcleo puro]
 *
 * Operaciones GraphQL (hashes en config.steelhead.hashes):
 *   AllStations · GetStation · GetStationInputSchema (queries)
 *   CreateStationInputSchema · UpdateStationInputs (mutations)
 *
 * Expone window.LoadCalculator = { openStationConfig }.
 * ========================================================================== */
(function () {
  'use strict';

  const api = () => window.SteelheadAPI;
  const ST  = () => window.LoadCalculatorStations;
  const log = (...a) => console.log('[load-calculator]', ...a);
  const warn = (...a) => console.warn('[load-calculator]', ...a);

  // Campos del calculador (confirmados con el usuario, 2026-06-24). Capturados en cm.
  const CALC_FIELDS = {
    TipoLinea:      { type: 'string', enum: ['Rack', 'Barril', 'Híbrida', 'Célula'], title: 'Tipo de Línea' },
    TinaLargoCm:    { type: 'number',  title: 'Largo de Tina (cm)' },
    TinaAnchoCm:    { type: 'number',  title: 'Ancho de Tina (cm)' },
    SepColCm:       { type: 'number',  title: 'Separación entre columnas (cm)' },
    SepFilaCm:      { type: 'number',  title: 'Separación entre filas (cm)' },
    FactorArea:     { type: 'number',  title: 'Factor de área (def 1.5)' },
    CapacidadDMK:   { type: 'number',  title: 'Capacidad de barril (DMK / dm²)' },
    NumEstaciones:  { type: 'integer', title: 'Número de estaciones/tinas' },
    TiempoCicloMin: { type: 'number',  title: 'Tiempo de ciclo (min)' },
    OEE:            { type: 'number',  title: 'OEE (0 a 1)' },
  };
  const CALC_KEYS = Object.keys(CALC_FIELDS);

  // Estado de la sesión del panel.
  let state = null;
  const freshState = () => ({ stations: [], schema: null, byLine: {}, mode: 'station' });

  // ───────────────────────── estilos + panel ─────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-lc-styles')) return;
    const css = `
      .sa-lc-overlay{position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,42,.55);
        display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
      .sa-lc-modal{background:#fff;width:560px;max-width:94vw;max-height:90vh;border-radius:12px;
        box-shadow:0 24px 60px rgba(0,0,0,.32);display:flex;flex-direction:column;overflow:hidden}
      .sa-lc-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
        padding:16px 20px;border-bottom:1px solid #e5e7eb}
      .sa-lc-header h2{margin:0;font-size:16px;color:#0f172a}
      .sa-lc-sub{font-size:12px;color:#64748b;margin-top:3px}
      .sa-lc-close{border:0;background:#f1f5f9;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:15px;color:#334155}
      .sa-lc-body{padding:16px 20px;overflow:auto}
      .sa-lc-footer{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid #e5e7eb}
      .sa-lc-btn{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px}
      .sa-lc-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
      .sa-lc-btn:disabled{opacity:.5;cursor:not-allowed}
      .sa-lc-row{display:flex;align-items:center;gap:10px;margin:8px 0}
      .sa-lc-row label{flex:0 0 210px;font-size:13px;color:#334155}
      .sa-lc-row input,.sa-lc-row select{flex:1;padding:7px 9px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px}
      .sa-lc-banner{background:#fef3c7;border:1px solid #fcd34d;color:#92400e;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
      .sa-lc-modes{display:flex;gap:16px;margin-bottom:10px;font-size:13px;color:#334155}
      .sa-lc-msg{font-size:13px;margin-top:10px}
      .sa-lc-msg.ok{color:#15803d}.sa-lc-msg.err{color:#b91c1c}
      .sa-lc-grid{margin-top:6px}`;
    const el = document.createElement('style');
    el.id = 'sa-lc-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function removeOverlay() { document.getElementById('sa-lc-overlay')?.remove(); }

  function closePanel() {
    removeOverlay();
    state = null;
  }

  function showShell() {
    removeOverlay();
    const ov = document.createElement('div');
    ov.className = 'sa-lc-overlay';
    ov.id = 'sa-lc-overlay';
    ov.innerHTML = `
      <div class="sa-lc-modal" role="dialog" aria-modal="true">
        <div class="sa-lc-header">
          <div><h2>⚙️ Configurador de Estaciones</h2>
            <div class="sa-lc-sub">Parámetros del calculador de piezas por carga</div></div>
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
      try {
        data = await api().query('AllStations', { orderBy: ['ID_DESC'], offset, first: PAGE, searchQuery: '' });
      } catch (e) { warn(`AllStations offset ${offset}:`, String(e).slice(0, 120)); break; }
      const nodes = data?.pagedData?.nodes || [];
      out.push(...nodes.map(n => ({ id: n.id, name: n.name })));
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 20000) { warn('AllStations: límite de seguridad'); break; }
    }
    return out;
  }

  // Schema de estación vigente = el nodo de id más alto (patrón "latest schema" del proyecto).
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
    return {
      name: s.name,
      customInputs: s.customInputs || {},
      inputSchemaId: s.stationInputSchemaByInputSchemaId?.id ?? null,
    };
  }

  // Extiende el schema con los campos faltantes del calculador y devuelve el id vigente.
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
    latest = await fetchLatestStationSchema(); // re-fetch para el id nuevo
    return latest;
  }

  async function saveStationValues(stationId, inputSchemaId, values) {
    const existing = await loadStation(stationId);
    const vars = ST().buildUpdateStationInputsVars({ stationId, inputSchemaId, existingCustomInputs: existing.customInputs, values });
    await api().query('UpdateStationInputs', vars);
  }

  // ───────────────────────── UI ─────────────────────────
  function fieldInputHtml(key) {
    const def = CALC_FIELDS[key];
    if (def.enum) {
      const opts = ['<option value="">—</option>', ...def.enum.map(v => `<option value="${v}">${v}</option>`)].join('');
      return `<select class="sa-lc-f" data-key="${key}">${opts}</select>`;
    }
    const step = def.type === 'integer' ? '1' : 'any';
    return `<input class="sa-lc-f" data-key="${key}" type="number" step="${step}" placeholder="—">`;
  }

  function renderForm() {
    const missing = ST().schemaMissingFields(state.schema && state.schema.inputSchema, CALC_KEYS);
    const banner = missing.length
      ? `<div class="sa-lc-banner">El esquema de estaciones aún no tiene ${missing.length} campo(s) del calculador.
         <button class="sa-lc-btn" id="sa-lc-extend" style="margin-left:8px">Extender esquema</button></div>` : '';

    const lines = Object.keys(state.byLine).sort();
    const targetSelector = state.mode === 'station'
      ? `<select id="sa-lc-target">${state.stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>`
      : `<select id="sa-lc-target">${lines.map(l => `<option value="${l}">${l} (${state.byLine[l].length} est.)</option>`).join('')}</select>`;

    const fieldsHtml = CALC_KEYS.map(k =>
      `<div class="sa-lc-row"><label>${CALC_FIELDS[k].title}</label>${fieldInputHtml(k)}</div>`).join('');

    $body().innerHTML = `
      ${banner}
      <div class="sa-lc-modes">
        <label><input type="radio" name="sa-lc-mode" value="station" ${state.mode === 'station' ? 'checked' : ''}> Una estación</label>
        <label><input type="radio" name="sa-lc-mode" value="line" ${state.mode === 'line' ? 'checked' : ''}> Toda una línea</label>
      </div>
      <div class="sa-lc-row"><label>${state.mode === 'station' ? 'Estación' : 'Línea'}</label>${targetSelector}</div>
      <div class="sa-lc-grid">${fieldsHtml}</div>
      <div class="sa-lc-msg" id="sa-lc-msg"></div>`;

    // handlers
    $body().querySelectorAll('input[name="sa-lc-mode"]').forEach(r => {
      r.onchange = () => { state.mode = r.value; renderForm(); };
    });
    const ext = document.getElementById('sa-lc-extend');
    if (ext) ext.onclick = onExtendSchema;
    const tgt = document.getElementById('sa-lc-target');
    if (state.mode === 'station' && tgt) {
      tgt.onchange = () => prefillFromStation(Number(tgt.value));
      if (tgt.value) prefillFromStation(Number(tgt.value));
    }
    $save().disabled = missing.length > 0;
    $save().onclick = onSave;
  }

  function collectValues() {
    const values = {};
    $body().querySelectorAll('.sa-lc-f').forEach(el => {
      const raw = el.value;
      if (raw === '' || raw == null) return; // no pisar con vacío
      const def = CALC_FIELDS[el.dataset.key];
      values[el.dataset.key] = def.enum ? raw : Number(raw);
    });
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
    const schemaId = state.schema.id;
    $save().disabled = true;

    try {
      if (state.mode === 'station') {
        const stationId = Number(tgt.value);
        setMsg('Guardando…');
        await saveStationValues(stationId, schemaId, values);
        setMsg('✓ Estación actualizada.', 'ok');
      } else {
        const line = tgt.value;
        const targets = state.byLine[line] || [];
        if (!confirm(`Se aplicarán estos parámetros a ${targets.length} estación(es) de la línea ${line}. ¿Continuar?`)) {
          $save().disabled = false; return;
        }
        let ok = 0;
        for (let i = 0; i < targets.length; i++) {
          setMsg(`Guardando ${i + 1}/${targets.length} (${targets[i].name})…`);
          try { await saveStationValues(targets[i].id, schemaId, values); ok++; }
          catch (e) { warn('bulk save', targets[i].name, e); }
        }
        setMsg(`✓ ${ok}/${targets.length} estaciones actualizadas.`, ok === targets.length ? 'ok' : 'err');
      }
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
    if (document.getElementById('sa-lc-overlay')) return; // ya abierto
    injectStyles();
    state = freshState();
    showShell();
    try {
      const [stations, schema] = await Promise.all([fetchAllStations(), fetchLatestStationSchema()]);
      state.stations = stations;
      state.schema = schema;
      state.byLine = ST().groupStationsByLine(stations);
      if (!stations.length) { $body().innerHTML = '<div class="sa-lc-msg err">No se encontraron estaciones.</div>'; return; }
      renderForm();
    } catch (e) {
      warn('open', e);
      if ($body()) $body().innerHTML = `<div class="sa-lc-msg err">Error: ${String(e).slice(0, 200)}</div>`;
    }
    return { ok: true };
  }

  window.LoadCalculator = Object.assign(window.LoadCalculator || {}, { openStationConfig });
  log('listo (Configurador de Estaciones)');
})();
