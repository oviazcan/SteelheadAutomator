// Agrupar Lote en Programación — glue (DOM + red). Consume schedule-batch-group-core.js.
//
// Monta un botón 📦 dentro del widget 🏷️ de schedule-batch-highlighter (que solo RESALTA) y cierra
// el paso que hoy queda a mano: juntar las órdenes de un lote en UNA tarea del programa, como hace
// el Task Builder nativo.
//
// ── Por qué NO se agrupa "lo resaltado" ──
// El resaltado matchea el TEXTO de la celda y la tabla VIRTUALIZA: solo alcanza las filas montadas.
// Para pintar eso basta; para escribir el programa no — agrupar lo que alcanzaste a scrollear
// crearía una tarea INCOMPLETA en silencio, que es el peor modo de falla porque se ve exitosa.
// Por eso los grupos salen de los DATOS del tablero, no del DOM.
//
// ── De dónde salen los datos: cero consultas nuevas ──
// El board ya dispara RelatedSchedulingInformation (orden → lotes recibidos, nodos programables con
// su tratamiento y tiempos) y SchedulablePartLocations (el material programable, con sus cuentas y
// las piezas por rack del PN). Se INTERCEPTAN sus respuestas, como surtido-guard con la query que
// pinta las tarjetas. Ambas llegan por lotes → los índices ACUMULAN.
//
// ── Lo que se escribe ──
// CreateManyScheduleTasks con una tarea (treatment, station) de N elementos. `expectedStartTime` es
// el instante actual con status UNSCHEDULED e isIntentional:false — igual que el nativo: no fijamos
// hora, el planificador la acomoda. Fijarla es otra decisión (📅 de wo-schedule-button).
(function () {
  'use strict';

  const Core = window.ScheduleBatchGroupCore;
  const HLCore = window.ScheduleBatchHighlighterCore;
  if (!Core || !HLCore) { console.warn('[schedule-batch-group] core ausente'); return; }

  const BTN_ID = 'sa-sbg-btn';
  const MODAL_ID = 'sa-sbg-modal';
  const STYLE_ID = 'sa-sbg-style';
  const INLINE_ID = HLCore.ACTIVE_NODE_ID;   // widget del highlighter donde nos colgamos

  const RELATED_OP = 'RelatedSchedulingInformation';
  const LOCATIONS_OP = 'SchedulablePartLocations';
  const CREATE_OP = 'CreateManyScheduleTasks';

  // Estado singleton: injectAppScripts re-evalúa el IIFE en cada acción del popup, y si el estado
  // viviera en el closure el interceptor quedaría latcheado a una instancia distinta de la que ve
  // el botón (la lección de surtido-guard 0.1.1).
  const S = (window.__saSBG = window.__saSBG || {
    workOrders: new Map(),    // workOrderId → nodo de allWorkOrders (acumulado)
    stations: new Map(),      // stationId  → nodo de allStations (acumulado)
    locations: new Map(),     // accountId  → part location (acumulado)
    scheduleId: null,
    justScheduled: new Set(), // cuentas que YA agrupamos en esta sesión (anti doble-agrupado)
    obs: null,
    busy: false,
  });

  // ───────────────────────── interceptor ─────────────────────────

  function patchFetch() {
    if (window.__saSBGFetchPatched) return;
    window.__saSBGFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      let op = null, vars = null;
      if (typeof url === 'string' && url.includes('/graphql') && opts && typeof opts.body === 'string') {
        try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
      }
      if (vars && vars.scheduleId != null) S.scheduleId = vars.scheduleId;

      const resp = await origFetch.apply(this, args);

      if (op === RELATED_OP) {
        try { resp.clone().json().then((j) => { absorbRelated(j && j.data); }).catch(() => {}); } catch (_) {}
      }
      if (op === LOCATIONS_OP) {
        try { resp.clone().json().then((j) => { absorbLocations(j && j.data); }).catch(() => {}); } catch (_) {}
      }
      return resp;
    };
  }

  function absorbRelated(data) {
    if (!data) return;
    for (const w of ((data.allWorkOrders && data.allWorkOrders.nodes) || [])) {
      if (w && w.id != null) S.workOrders.set(w.id, w);
    }
    for (const s of ((data.allStations && data.allStations.nodes) || [])) {
      if (s && s.id != null) S.stations.set(s.id, s);
    }
    renderCount();
  }

  function absorbLocations(data) {
    if (!data) return;
    // Reemplaza el material de las órdenes que vengan en esta respuesta: si una cuenta ya se
    // programó, el ERP deja de listarla y el índice tiene que reflejar la baja, no conservarla.
    const tocadas = new Set();
    const nuevos = [];
    for (const n of ((data.allPartLocations && data.allPartLocations.nodes) || [])) {
      if (!n || n.accountId == null) continue;
      tocadas.add(n.workOrderId);
      nuevos.push(n);
    }
    if (tocadas.size) {
      for (const [acct, loc] of S.locations) {
        if (tocadas.has(loc.workOrderId)) S.locations.delete(acct);
      }
    }
    for (const n of nuevos) S.locations.set(n.accountId, n);
    renderCount();
  }

  // Vista de los datos con la forma que espera el núcleo.
  function snapshot() {
    return {
      relatedInfo: {
        allWorkOrders: { nodes: Array.from(S.workOrders.values()) },
        allStations: { nodes: Array.from(S.stations.values()) },
      },
      partLocations: Array.from(S.locations.values()),
    };
  }

  function currentScheduleId() {
    if (S.scheduleId != null) return S.scheduleId;
    const m = /^\/Schedules\/(\d+)\//.exec(location.pathname);
    return m ? Number(m[1]) : null;
  }

  // Grupos + diagnóstico, listos para pintar.
  function computeGroups(names) {
    const snap = snapshot();
    const stations = Core.indexStations(snap.relatedInfo);
    const groups = Core.buildBatchGroups({
      relatedInfo: snap.relatedInfo,
      partLocations: snap.partLocations,
      names: names && names.length ? names : null,
    });
    return groups.map((g) => ({
      group: g,
      dx: Core.diagnoseGroup(g, { stations, scheduledAccountIds: S.justScheduled }),
    })).sort((a, b) => {
      if (a.dx.canCreate !== b.dx.canCreate) return a.dx.canCreate ? -1 : 1;
      return String(a.group.batchName).localeCompare(String(b.group.batchName));
    });
  }

  // ───────────────────────── botón en el widget ─────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    // El modal va en DARK MODE (regla del repo): que se distinga de un vistazo de una pantalla
    // nativa de Steelhead, que son claras. El botón sí es claro, porque vive dentro del widget
    // inline que se integra a la barra de filtros nativa.
    st.textContent = `
      #${BTN_ID}{cursor:pointer;border:1.5px solid #13a36f;background:#fff;color:#0e8659;
        border-radius:6px;padding:2px 7px;font-size:12px;font-weight:700;line-height:1.4;
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;white-space:nowrap;}
      #${BTN_ID}:hover:not(:disabled){background:#eafaf3;}
      #${BTN_ID}:disabled{opacity:.45;cursor:not-allowed;}
      #${MODAL_ID}{position:fixed;inset:0;z-index:2147483000;background:rgba(8,12,18,.62);
        display:flex;align-items:center;justify-content:center;
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
      #${MODAL_ID} .sa-sbg-card{background:#1c2430;color:#e6e9ee;border-radius:12px;
        width:min(760px,94vw);max-height:86vh;display:flex;flex-direction:column;
        box-shadow:0 18px 48px rgba(0,0,0,.5);}
      #${MODAL_ID} h3{margin:0;padding:16px 20px 12px;font-size:16px;font-weight:700;
        border-bottom:1px solid #2b3644;}
      #${MODAL_ID} .sa-sbg-sub{padding:10px 20px 0;font-size:12px;color:#9aa7b5;line-height:1.5;}
      #${MODAL_ID} .sa-sbg-body{overflow:auto;padding:12px 20px 4px;}
      #${MODAL_ID} .sa-sbg-row{border:1px solid #2b3644;border-radius:8px;padding:10px 12px;
        margin-bottom:9px;background:#141a23;}
      #${MODAL_ID} .sa-sbg-row.ok{border-color:#13a36f;}
      #${MODAL_ID} .sa-sbg-row.no{opacity:.9;border-color:#3a4453;}
      #${MODAL_ID} .sa-sbg-head{display:flex;align-items:center;gap:9px;}
      #${MODAL_ID} .sa-sbg-name{font-weight:700;font-size:13px;}
      #${MODAL_ID} .sa-sbg-trat{font-size:12px;color:#9aa7b5;}
      #${MODAL_ID} .sa-sbg-meta{margin-top:5px;font-size:12px;color:#c3ccd8;line-height:1.6;}
      #${MODAL_ID} .sa-sbg-why{margin-top:6px;font-size:12px;color:#f0b46b;line-height:1.55;}
      #${MODAL_ID} .sa-sbg-pns{margin-top:5px;font-size:11px;color:#7f8b99;line-height:1.5;}
      #${MODAL_ID} .sa-sbg-foot{display:flex;gap:9px;justify-content:flex-end;align-items:center;
        padding:13px 20px;border-top:1px solid #2b3644;}
      #${MODAL_ID} button.sa-sbg-act{border:0;border-radius:7px;padding:8px 15px;font-size:13px;
        font-weight:700;cursor:pointer;background:#13a36f;color:#fff;}
      #${MODAL_ID} button.sa-sbg-act:disabled{opacity:.45;cursor:not-allowed;}
      #${MODAL_ID} button.sa-sbg-cancel{background:transparent;color:#9aa7b5;border:1px solid #3a4453;}
      #${MODAL_ID} .sa-sbg-status{margin-right:auto;font-size:12px;color:#9aa7b5;}
      #${MODAL_ID} .sa-sbg-status.err{color:#ef8a80;}
      #${MODAL_ID} .sa-sbg-status.ok{color:#5fd3a3;}
    `;
    document.head.appendChild(st);
  }

  function ensureButton() {
    if (!HLCore.isScheduleBoardUrl(location.pathname)) return;
    if (document.getElementById(BTN_ID)) return;
    const widget = document.getElementById(INLINE_ID);
    if (!widget) return;   // el highlighter aún no montó su barra
    injectStyles();
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = '📦';
    b.title = 'Agrupar los lotes del tablero en tareas del programa';
    b.addEventListener('click', (e) => { e.preventDefault(); openModal(); });
    const x = widget.querySelector('.sa-sbh-x');
    if (x) widget.insertBefore(b, x); else widget.appendChild(b);
    renderCount();
  }

  // El botón dice cuántos lotes se pueden agrupar AHORA. Cuando no hay ninguno queda deshabilitado
  // con el motivo en el tooltip: un botón que no responde y no explica se lee como falla nuestra.
  function renderCount() {
    const b = document.getElementById(BTN_ID);
    if (!b) return;
    if (!S.workOrders.size || !S.locations.size) {
      b.textContent = '📦';
      b.disabled = true;
      b.title = 'Cargando los datos del tablero… (los trae el propio tablero; desplázate o recarga si tarda)';
      return;
    }
    let n = 0;
    try { n = computeGroups(null).filter((r) => r.dx.canCreate).length; } catch (_) {}
    b.disabled = false;
    b.textContent = n ? `📦 ${n}` : '📦';
    b.title = n
      ? `Agrupar: ${n} lote(s) se pueden juntar en una tarea del programa`
      : 'Agrupar lotes — ninguno se puede agrupar ahora; ábrelo para ver por qué';
  }

  // ───────────────────────── modal ─────────────────────────

  function closeModal() {
    const m = document.getElementById(MODAL_ID);
    if (m) m.remove();
  }

  function openModal() {
    closeModal();
    injectStyles();
    const rows = computeGroups(currentQuery());
    const scheduleId = currentScheduleId();

    const back = document.createElement('div');
    back.id = MODAL_ID;
    back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });

    const card = document.createElement('div');
    card.className = 'sa-sbg-card';

    const h = document.createElement('h3');
    h.textContent = '📦 Agrupar lotes en tareas del programa';
    card.appendChild(h);

    const sub = document.createElement('div');
    sub.className = 'sa-sbg-sub';
    sub.textContent = 'Cada lote seleccionado se crea como UNA tarea con todas sus órdenes dentro. '
      + 'Un lote que pasa por dos tratamientos sale en dos tareas. La hora la acomoda el planificador.';
    card.appendChild(sub);

    const body = document.createElement('div');
    body.className = 'sa-sbg-body';

    const seleccion = new Set();
    if (!rows.length) {
      const p = document.createElement('div');
      p.className = 'sa-sbg-meta';
      p.textContent = S.workOrders.size
        ? 'No hay lotes con material programable en este tablero.'
        : 'Todavía no llegan los datos del tablero. Desplaza la lista o recarga la página.';
      body.appendChild(p);
    }

    for (const r of rows) {
      const { group, dx } = r;
      const row = document.createElement('div');
      row.className = 'sa-sbg-row ' + (dx.canCreate ? 'ok' : 'no');

      const head = document.createElement('div');
      head.className = 'sa-sbg-head';
      if (dx.canCreate) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        seleccion.add(r);
        cb.addEventListener('change', () => {
          if (cb.checked) seleccion.add(r); else seleccion.delete(r);
          syncFoot();
        });
        head.appendChild(cb);
      } else {
        const lock = document.createElement('span');
        lock.textContent = '🔒';
        head.appendChild(lock);
      }
      const nm = document.createElement('span');
      nm.className = 'sa-sbg-name';
      nm.textContent = group.batchName;
      head.appendChild(nm);
      const tr = document.createElement('span');
      tr.className = 'sa-sbg-trat';
      tr.textContent = '· ' + (group.treatmentName || ('tratamiento ' + group.treatmentId));
      head.appendChild(tr);
      row.appendChild(head);

      const piezas = group.elements.reduce((a, e) => a + (Number(e.partCount) || 0), 0);
      const meta = document.createElement('div');
      meta.className = 'sa-sbg-meta';
      const partes = [`${group.elements.length} orden(es)`, `${piezas} pieza(s)`];
      if (group.batchIds.length > 1) partes.push(`${group.batchIds.length} lotes con este nombre`);
      if (dx.stationName) partes.push(dx.stationName);
      if (dx.times) partes.push(`${dx.times.batches} carga(s) · ${fmtDur(dx.times.totalTimeMinutes)}`);
      meta.textContent = partes.join(' · ');
      row.appendChild(meta);

      const pns = document.createElement('div');
      pns.className = 'sa-sbg-pns';
      const nombres = group.elements.map((e) => e.partNumberName || e.partNumberId);
      pns.textContent = nombres.slice(0, 6).join(', ') + (nombres.length > 6 ? ` …y ${nombres.length - 6} más` : '');
      row.appendChild(pns);

      if (dx.reasons.length) {
        const why = document.createElement('div');
        why.className = 'sa-sbg-why';
        why.textContent = dx.reasons.join(' ');
        row.appendChild(why);
      }
      body.appendChild(row);
    }
    card.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'sa-sbg-foot';
    const status = document.createElement('span');
    status.className = 'sa-sbg-status';
    foot.appendChild(status);
    const cancel = document.createElement('button');
    cancel.className = 'sa-sbg-act sa-sbg-cancel';
    cancel.textContent = 'Cerrar';
    cancel.addEventListener('click', closeModal);
    foot.appendChild(cancel);
    const go = document.createElement('button');
    go.className = 'sa-sbg-act';
    foot.appendChild(go);
    card.appendChild(foot);

    function syncFoot() {
      go.textContent = `Crear ${seleccion.size} tarea(s)`;
      go.disabled = !seleccion.size || scheduleId == null || S.busy;
      if (scheduleId == null) status.textContent = 'No identifico el programa (scheduleId) de este tablero.';
    }
    syncFoot();

    go.addEventListener('click', async () => {
      if (!seleccion.size || S.busy) return;
      S.busy = true; syncFoot();
      status.className = 'sa-sbg-status';
      status.textContent = 'Creando…';
      try {
        const res = await createTasks(Array.from(seleccion), scheduleId);
        status.className = 'sa-sbg-status ok';
        status.textContent = `✅ ${res.creadas} tarea(s) creada(s). `
          + 'Actualiza el tablero para verlas y programarlas.';
        go.disabled = true;
        renderCount();
      } catch (err) {
        status.className = 'sa-sbg-status err';
        status.textContent = '❌ ' + (err && err.message ? err.message : String(err));
        S.busy = false; syncFoot();
      }
      S.busy = false;
    });

    back.appendChild(card);
    document.body.appendChild(back);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', esc); }
    });
  }

  function currentQuery() {
    const inp = document.querySelector('#' + INLINE_ID + ' .sa-sbh-inp');
    const v = inp && inp.value ? inp.value.trim() : '';
    return v ? HLCore.extractBatchNames(v) : null;
  }

  function fmtDur(min) {
    if (min == null) return '—';
    if (min < 60) return `${Math.round(min)} min`;
    const h = min / 60;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(min / 1440).toFixed(1)} días`;
  }

  // ───────────────────────── escritura ─────────────────────────

  function uuidv4() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  async function createTasks(rows, scheduleId) {
    const api = window.SteelheadAPI;
    if (!api) throw new Error('SteelheadAPI no disponible.');
    const ahora = new Date().toISOString();

    const tasks = rows.map(({ group, dx }) => ({
      treatmentId: group.treatmentId,
      stationId: dx.stationId,
      expectedStartTime: ahora,
      isIntentional: false,
      times: { cycleTimeMinutes: dx.times.cycleTimeMinutes, treatmentTimeMinutes: dx.times.treatmentTimeMinutes },
      elements: dx.elements.map((e) => ({ ...e, partSetUuid: uuidv4() })),
    }));

    const variables = Core.buildGroupedScheduleTaskInput({ scheduleId, tasks });
    if (!variables) throw new Error('No pude armar la mutación con estos datos (falta algún dato).');

    const data = await api.query(CREATE_OP, variables);
    const creadas = (data && (data.createManyScheduledTasks || data.createManyScheduleTasks)) || [];
    if (!Array.isArray(creadas) || !creadas.length) {
      throw new Error('El servidor no devolvió ninguna tarea creada.');
    }

    // Las cuentas agrupadas quedan marcadas para que un segundo clic no las duplique aunque el
    // tablero todavía no se haya refrescado.
    for (const { dx } of rows) {
      for (const e of dx.elements) for (const a of (e.accounts || [])) S.justScheduled.add(a.id);
    }
    return { creadas: creadas.length };
  }

  // ───────────────────────── ciclo de vida ─────────────────────────

  function startObserver() {
    if (S.obs) return;
    S.obs = new MutationObserver(() => {
      if (!HLCore.isScheduleBoardUrl(location.pathname)) return;
      ensureButton();
    });
    S.obs.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() { if (S.obs) { S.obs.disconnect(); S.obs = null; } }

  function onUrlChange() {
    if (HLCore.isScheduleBoardUrl(location.pathname)) { ensureButton(); startObserver(); }
    else { stopObserver(); closeModal(); const b = document.getElementById(BTN_ID); if (b) b.remove(); }
  }

  function init() {
    patchFetch();
    if (!window.__saSBGUrlPatched) {
      window.__saSBGUrlPatched = true;
      for (const m of ['pushState', 'replaceState']) {
        const orig = history[m];
        history[m] = function () { const r = orig.apply(this, arguments); window.dispatchEvent(new Event('sa-sbg-url')); return r; };
      }
      window.addEventListener('popstate', () => window.dispatchEvent(new Event('sa-sbg-url')));
      window.addEventListener('sa-sbg-url', onUrlChange);
    }
    onUrlChange();
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);

  window.ScheduleBatchGroup = { openModal, ensureButton, computeGroups, snapshot };
})();
