// Steelhead Paros de Línea
// Skin operador sobre MaintenanceEvent con botón flotante Andon.
// Flujo: CreateMaintenanceEvent (inicio) → UpdateMaintenanceEvent/Comment (durante)
//        → CreateMaintenanceNodeEvent + CreateManySensorMeasurements + UpdateMaintenanceEvent{completedAt} (al detener)
//        → /api/files + CreateUserFile + CreateMaintenanceEventUserFile (evidencia)
// Depende de: SteelheadAPI + window.REMOTE_CONFIG

const ParosLinea = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;

  const STATE_KEY = 'sa_paros_active_event';
  const LAST_LINE_KEY = 'sa_paros_last_line';

  const RESPONSABLE_PREFIXES = {
    PLM: 'Mantenimiento',
    PLP: 'Producción',
    PLO: 'Operaciones',
    PLR: 'Recursos Humanos',
    PLC: 'Calidad',
    PLS: 'Seguridad'
  };

  let state = {
    currentUser: null,
    allNodes: [],
    responsableGroups: {},
    allEquipments: [],
    selectedSensorId: null,
    activeEvent: null,
    timerInterval: null,
    floatingBtn: null,
    catalogsLoaded: false
  };

  async function init() {
    if (window.__saParosLineaInitDone) return;
    window.__saParosLineaInitDone = true;

    try {
      state.currentUser = await fetchCurrentUser();
    } catch (e) {
      console.warn('[SA] ParosLinea: no se pudo obtener usuario actual:', e.message);
      return;
    }
    if (!state.currentUser) return;
    if (!isAuthorized(state.currentUser)) {
      console.log('[SA] ParosLinea: usuario sin rol operador/admin — botón omitido');
      return;
    }

    injectStyles();
    renderFloatingButton();

    const saved = readActiveEvent();
    if (saved) {
      state.activeEvent = saved;
      state.selectedSensorId = saved.selectedSensorId || null;
      loadCatalogs().catch(e => console.warn('[SA] ParosLinea catálogos:', e.message));
      renderRunningView().catch(e => console.warn('[SA] ParosLinea reanudar:', e.message));
    }
  }

  async function fetchCurrentUser() {
    const data = await api().query('CurrentUser', { deviceLocationIds: [] }, 'CurrentUser');
    const u = data?.currentSession?.userByUserId;
    if (!u) return null;
    return { id: u.id, name: u.name, isAdmin: u.isAdmin === true };
  }

  function isAuthorized(user) {
    const roles = cfg()?.permissions?.roles || {};
    const inAdmin = Array.isArray(roles.admin) && roles.admin.includes(user.id);
    const inOperador = Array.isArray(roles.operador) && roles.operador.includes(user.id);
    return inAdmin || inOperador || user.isAdmin;
  }

  function readActiveEvent() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch { return null; }
  }
  function writeActiveEvent(ev) {
    try {
      if (!ev) localStorage.removeItem(STATE_KEY);
      else localStorage.setItem(STATE_KEY, JSON.stringify(ev));
    } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById('dl9-paros-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl9-paros-styles';
    s.textContent = [
      '.pl-fab{position:fixed;bottom:24px;right:24px;z-index:99998;width:72px;height:72px;border-radius:50%;background:#dc2626;color:#fff;border:none;box-shadow:0 6px 20px rgba(220,38,38,0.55);font-size:36px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s ease, box-shadow .15s ease}',
      '.pl-fab:hover{transform:scale(1.08);box-shadow:0 8px 26px rgba(220,38,38,0.75)}',
      '.pl-fab.running{background:#b91c1c;animation:plPulse 1.6s ease-in-out infinite}',
      '@keyframes plPulse{0%,100%{box-shadow:0 6px 20px rgba(220,38,38,0.55)}50%{box-shadow:0 6px 28px rgba(220,38,38,0.95)}}',
      '.pl-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.pl-modal{background:#1e293b;color:#f1f5f9;border-radius:16px;padding:28px 32px;width:560px;max-width:94vw;max-height:94vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);box-sizing:border-box}',
      '.pl-modal.running{width:760px;text-align:center}',
      '.pl-modal h2{margin:0 0 16px;font-size:22px;color:#fecaca}',
      '.pl-row{margin-bottom:14px}',
      '.pl-label{font-size:11px;color:#94a3b8;display:block;margin-bottom:4px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}',
      '.pl-select,.pl-input,.pl-textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#f1f5f9;font-size:14px;box-sizing:border-box}',
      '.pl-select:disabled{opacity:.6}',
      '.pl-textarea{min-height:60px;resize:vertical;font-family:inherit}',
      '.pl-btnrow{display:flex;gap:12px;justify-content:flex-end;margin-top:22px;flex-wrap:wrap}',
      '.pl-btn{padding:12px 22px;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.3px}',
      '.pl-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.pl-btn-cancel{background:#475569;color:#f1f5f9}',
      '.pl-btn-primary{background:#dc2626;color:#fff}',
      '.pl-btn-ghost{background:transparent;color:#cbd5e1;border:1px solid #475569}',
      '.pl-btn-stop{background:#dc2626;color:#fff;font-size:20px;padding:18px 0;width:100%;margin-top:18px}',
      '.pl-btn-stop:hover{background:#b91c1c}',
      '.pl-cone{font-size:96px;line-height:1;margin-bottom:4px}',
      '.pl-title{font-size:26px;font-weight:800;color:#fecaca;letter-spacing:1.5px;margin:6px 0}',
      '.pl-timer{font-size:72px;font-family:"SF Mono","Menlo","Consolas",monospace;font-variant-numeric:tabular-nums;color:#fef3c7;margin:8px 0 18px}',
      '.pl-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:left;margin-top:12px}',
      '.pl-static{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 12px;font-size:14px}',
      '.pl-static strong{display:block;font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px;font-weight:700}',
      '.pl-comment-row{display:flex;gap:8px;margin-top:14px;align-items:flex-start}',
      '.pl-comment-row .pl-textarea{flex:1;min-height:48px}',
      '.pl-summary{text-align:center;background:#0f172a;border-radius:12px;padding:22px;margin:10px 0}',
      '.pl-summary .pl-big{font-size:42px;font-family:"SF Mono","Menlo","Consolas",monospace;color:#86efac;margin:6px 0}',
      '.pl-dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;text-align:left;margin-top:12px;font-size:13px}',
      '.pl-dl dt{color:#94a3b8}',
      '.pl-dl dd{margin:0;color:#f1f5f9}',
      '.pl-error{color:#fecaca;background:#7f1d1d;padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:13px}',
      '.pl-loading{text-align:center;padding:20px;color:#94a3b8}'
    ].join('');
    document.head.appendChild(s);
  }

  function renderFloatingButton() {
    if (document.getElementById('sa-pl-fab')) return;
    const btn = document.createElement('button');
    btn.className = 'pl-fab';
    btn.id = 'sa-pl-fab';
    btn.setAttribute('aria-label', 'Paro de Línea');
    btn.title = 'Paro de Línea';
    btn.textContent = '⚠️';
    if (state.activeEvent) btn.classList.add('running');
    btn.addEventListener('click', () => {
      if (state.activeEvent) renderRunningView();
      else openStopDialog();
    });
    document.body.appendChild(btn);
    state.floatingBtn = btn;
  }

  function updateFabStyle() {
    const btn = document.getElementById('sa-pl-fab');
    if (!btn) return;
    btn.classList.toggle('running', !!state.activeEvent);
  }

  function removeOverlay() {
    const ov = document.getElementById('sa-pl-overlay');
    if (ov) ov.remove();
    if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  }

  function showOverlay(innerHTML, { wide } = {}) {
    removeOverlay();
    const ov = document.createElement('div');
    ov.className = 'pl-overlay';
    ov.id = 'sa-pl-overlay';
    const modal = document.createElement('div');
    modal.className = 'pl-modal' + (wide ? ' running' : '');
    modal.innerHTML = innerHTML;
    ov.appendChild(modal);
    document.body.appendChild(ov);
    return ov;
  }

  async function loadCatalogs(force = false) {
    if (state.catalogsLoaded && !force) return;

    const dlg = await api().query('CreateMaintenanceEventDialogQuery', {},
      'CreateMaintenanceEventDialogQuery');
    const allNodes = dlg?.allMaintenanceNodes?.nodes || [];
    const paroNodes = allNodes.filter(n => /paro de l.nea/i.test(n.name || ''));
    if (paroNodes.length === 0) {
      throw new Error('No hay nodos de mantenimiento con "Paro de Línea" configurados. Contacta al administrador.');
    }
    state.allNodes = paroNodes;

    const groups = {};
    for (const n of paroNodes) {
      const m = (n.name || '').match(/\bPL([A-Z])\b/);
      const code = m ? 'PL' + m[1] : 'PL?';
      const label = RESPONSABLE_PREFIXES[code] || code;
      if (!groups[label]) groups[label] = [];
      groups[label].push(n);
    }
    state.responsableGroups = groups;

    const eq = await api().query('SearchEquipments',
      { searchQuery: '', first: 200 }, 'SearchEquipments');
    const all = eq?.searchEquipments?.nodes || [];

    if (all[0]?.equipmentLabelsByEquipmentId?.nodes?.length) {
      console.log('[SA] ParosLinea sample equipment labels:',
        JSON.stringify(all[0].equipmentLabelsByEquipmentId.nodes));
    }

    const lineaRe = /l[ií]nea/i;
    const hasLineaLabel = (e) => {
      const labels = e?.equipmentLabelsByEquipmentId?.nodes || [];
      return labels.some(l => lineaRe.test(JSON.stringify(l)));
    };
    const filtered = all.filter(hasLineaLabel);

    if (filtered.length > 0) {
      state.allEquipments = filtered;
      console.log('[SA] ParosLinea: ' + filtered.length + ' equipos con etiqueta de línea (de ' + all.length + ')');
    } else {
      console.warn('[SA] ParosLinea: ningún equipo con etiqueta "línea" — mostrando todos como fallback');
      state.allEquipments = all;
    }

    state.catalogsLoaded = true;
  }

  function inferLinePrefix() {
    const headings = document.querySelectorAll('h1, h2, h3, [class*="breadcrumb"], [class*="Breadcrumb"], [class*="page-title"], [class*="PageTitle"]');
    for (const h of headings) {
      const txt = h.textContent || '';
      const m = txt.match(/\b(T\d{2,3})\b/);
      if (m) return m[1];
    }
    try { return localStorage.getItem(LAST_LINE_KEY); } catch { return null; }
  }

  function matchEquipmentByPrefix(prefix) {
    if (!prefix || !state.allEquipments.length) return null;
    const p = prefix.toUpperCase();
    return state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(p))
      || state.allEquipments.find(e => (e.name || '').toUpperCase().includes(p))
      || null;
  }

  function responsableLabelFromNodeName(name) {
    if (!name) return 'Otros';
    const m = name.match(/\bPL([A-Z])\b/);
    const code = m ? 'PL' + m[1] : '';
    return RESPONSABLE_PREFIXES[code] || code || 'Otros';
  }

  async function loadSensorsForNode(nodeId) {
    const data = await api().query('OperatorMaintenanceNodeDialogQuery',
      { nodeId, maintenanceEventId: state.activeEvent?.id || 0 },
      'OperatorMaintenanceNodeDialogQuery');
    const raw = data?.maintenanceNodeById?.maintenanceNodeSensorsByMaintenanceNodeId?.nodes || [];
    return raw
      .map(s => s.sensorBySensorId)
      .filter(Boolean)
      .map(s => ({ id: s.id, name: s.name }));
  }

  async function openStopDialog() {
    if (state.activeEvent) { renderRunningView(); return; }

    const ov = showOverlay(
      '<h2>⚠️ Registrar Paro de Línea</h2>' +
      '<div id="pl-pre-content" class="pl-loading">Cargando catálogos…</div>'
    );

    try {
      await loadCatalogs();
    } catch (e) {
      document.getElementById('pl-pre-content').innerHTML =
        '<div class="pl-error">' + escapeHtml(e.message) + '</div>' +
        '<div class="pl-btnrow"><button class="pl-btn pl-btn-cancel" id="pl-pre-cancel">CERRAR</button></div>';
      document.getElementById('pl-pre-cancel').onclick = removeOverlay;
      return;
    }

    const groupOptions = Object.entries(state.responsableGroups)
      .map(([label, nodes]) => {
        const opts = nodes.map(n => '<option value="' + n.id + '">' + escapeHtml(n.name) + '</option>').join('');
        return '<optgroup label="' + escapeHtml(label) + '">' + opts + '</optgroup>';
      }).join('');

    const linePrefix = inferLinePrefix();
    const defaultEq = matchEquipmentByPrefix(linePrefix);
    const equipmentOptions = state.allEquipments
      .map(e => '<option value="' + e.id + '"' + (defaultEq && defaultEq.id === e.id ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>')
      .join('');

    document.getElementById('pl-pre-content').innerHTML =
      '<div class="pl-row">' +
        '<label class="pl-label">Responsable (categoría)</label>' +
        '<select class="pl-select" id="pl-node-select"><option value="">— Selecciona —</option>' + groupOptions + '</select>' +
      '</div>' +
      '<div class="pl-row">' +
        '<label class="pl-label">Motivo</label>' +
        '<select class="pl-select" id="pl-sensor-select" disabled><option value="">Selecciona responsable primero…</option></select>' +
      '</div>' +
      '<div class="pl-row">' +
        '<label class="pl-label">Línea / Equipo</label>' +
        '<select class="pl-select" id="pl-eq-select"><option value="">— Selecciona equipo —</option>' + equipmentOptions + '</select>' +
      '</div>' +
      '<div class="pl-row">' +
        '<label class="pl-label">Comentario inicial (opcional)</label>' +
        '<textarea class="pl-textarea" id="pl-comment" placeholder="Ej: Falla de agitación en tanque 3"></textarea>' +
      '</div>' +
      '<div class="pl-btnrow">' +
        '<button class="pl-btn pl-btn-cancel" id="pl-cancel">CANCELAR</button>' +
        '<button class="pl-btn pl-btn-primary" id="pl-start" disabled>INICIAR PARO</button>' +
      '</div>';

    const nodeSel = document.getElementById('pl-node-select');
    const sensorSel = document.getElementById('pl-sensor-select');
    const eqSel = document.getElementById('pl-eq-select');
    const startBtn = document.getElementById('pl-start');

    const refreshStartState = () => {
      startBtn.disabled = !(nodeSel.value && sensorSel.value && eqSel.value);
    };

    nodeSel.addEventListener('change', async () => {
      sensorSel.disabled = true;
      sensorSel.innerHTML = '<option value="">Cargando motivos…</option>';
      refreshStartState();
      if (!nodeSel.value) return;
      try {
        const sensors = await loadSensorsForNode(parseInt(nodeSel.value, 10));
        if (!sensors.length) {
          sensorSel.innerHTML = '<option value="">(sin motivos configurados)</option>';
        } else {
          sensorSel.innerHTML = '<option value="">— Selecciona motivo —</option>' +
            sensors.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>').join('');
          sensorSel.disabled = false;
        }
      } catch (e) {
        sensorSel.innerHTML = '<option value="">Error: ' + escapeHtml(e.message.substring(0, 60)) + '</option>';
      }
      refreshStartState();
    });

    sensorSel.addEventListener('change', refreshStartState);
    eqSel.addEventListener('change', refreshStartState);

    document.getElementById('pl-cancel').onclick = removeOverlay;
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'Iniciando…';
      try {
        const nodeId = parseInt(nodeSel.value, 10);
        const equipmentId = parseInt(eqSel.value, 10);
        const sensorId = parseInt(sensorSel.value, 10);
        const node = state.allNodes.find(n => n.id === nodeId);
        const eq = state.allEquipments.find(e => e.id === equipmentId);
        const comment = document.getElementById('pl-comment').value.trim();

        const data = await api().query('CreateMaintenanceEvent', {
          maintenancePlanId: null,
          maintenanceNodeId: nodeId,
          equipmentId,
          assigneeId: state.currentUser.id
        }, 'CreateMaintenanceEvent');

        const ev = data?.createMaintenanceEvent?.maintenanceEvent;
        if (!ev) throw new Error('Respuesta sin maintenanceEvent');

        state.activeEvent = {
          id: ev.id,
          idInDomain: ev.idInDomain,
          nodeId,
          nodeName: node?.name || '',
          equipmentId,
          equipmentName: eq?.name || '',
          responsable: responsableLabelFromNodeName(node?.name),
          createdAt: Date.now(),
          selectedSensorId: sensorId
        };
        state.selectedSensorId = sensorId;
        writeActiveEvent(state.activeEvent);

        if (comment) {
          try {
            await api().query('CreateMaintenanceEventComment',
              { comment, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
          } catch (e) { console.warn('[SA] comentario inicial falló:', e.message); }
        }

        const prefix = (eq?.name || '').split(/[\s-]/)[0];
        if (prefix) { try { localStorage.setItem(LAST_LINE_KEY, prefix); } catch (_) {} }

        updateFabStyle();
        await renderRunningView();
      } catch (e) {
        const modal = ov.querySelector('.pl-modal');
        const err = document.createElement('div');
        err.className = 'pl-error';
        err.textContent = 'Error: ' + e.message;
        const btnrow = modal.querySelector('.pl-btnrow');
        if (btnrow) modal.insertBefore(err, btnrow);
        else modal.appendChild(err);
        startBtn.disabled = false;
        startBtn.textContent = 'INICIAR PARO';
      }
    };
  }

  async function renderRunningView() {
    const ev = state.activeEvent;
    if (!ev) return;

    if (!state.catalogsLoaded) {
      try { await loadCatalogs(); } catch (e) { console.warn('[SA] catálogos:', e.message); }
    }

    let sensors = [];
    try { sensors = await loadSensorsForNode(ev.nodeId); } catch (e) { console.warn('[SA] sensores:', e.message); }

    const eqOptions = state.allEquipments
      .map(e => '<option value="' + e.id + '"' + (e.id === ev.equipmentId ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>')
      .join('');
    const sensorOptions = sensors
      .map(s => '<option value="' + s.id + '"' + (s.id === state.selectedSensorId ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>')
      .join('');

    showOverlay(
      '<div class="pl-cone">⚠️</div>' +
      '<div class="pl-title">PARO DE LÍNEA EN CURSO</div>' +
      '<div class="pl-timer" id="pl-timer">00:00:00</div>' +
      '<div class="pl-grid">' +
        '<div class="pl-static"><strong>Responsable</strong>' + escapeHtml(ev.responsable || '—') + '</div>' +
        '<div class="pl-static"><strong>Evento</strong>#' + ev.idInDomain + '</div>' +
        '<div>' +
          '<label class="pl-label">Línea / Equipo</label>' +
          '<select class="pl-select" id="pl-run-eq">' + eqOptions + '</select>' +
        '</div>' +
        '<div>' +
          '<label class="pl-label">Motivo</label>' +
          '<select class="pl-select" id="pl-run-sensor">' +
            '<option value="">— Selecciona motivo —</option>' + sensorOptions +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="pl-comment-row">' +
        '<textarea class="pl-textarea" id="pl-run-comment" placeholder="Agregar comentario…"></textarea>' +
        '<button class="pl-btn pl-btn-ghost" id="pl-run-addcomment">Añadir</button>' +
      '</div>' +
      '<button class="pl-btn pl-btn-stop" id="pl-run-stop">DETENER PARO</button>' +
      '<div class="pl-btnrow" style="margin-top:10px">' +
        '<button class="pl-btn pl-btn-ghost" id="pl-run-hide">OCULTAR (continuar)</button>' +
      '</div>',
      { wide: true }
    );

    const timerEl = document.getElementById('pl-timer');
    const tick = () => { timerEl.textContent = formatElapsed(Date.now() - ev.createdAt); };
    tick();
    state.timerInterval = setInterval(tick, 1000);

    document.getElementById('pl-run-hide').onclick = removeOverlay;

    const eqSel = document.getElementById('pl-run-eq');
    eqSel.addEventListener('change', async () => {
      const newEqId = parseInt(eqSel.value, 10);
      if (!Number.isFinite(newEqId) || newEqId === ev.equipmentId) return;
      const prevEqName = ev.equipmentName;
      const newEq = state.allEquipments.find(e => e.id === newEqId);
      eqSel.disabled = true;
      try {
        await api().query('UpdateMaintenanceEvent',
          { id: ev.id, equipmentId: newEqId }, 'UpdateMaintenanceEvent');
        ev.equipmentId = newEqId;
        ev.equipmentName = newEq?.name || '';
        writeActiveEvent(ev);
        try {
          await api().query('CreateMaintenanceEventComment', {
            comment: 'Línea cambiada de "' + prevEqName + '" a "' + (newEq?.name || newEqId) + '" por el operador.',
            maintenanceEventId: ev.id
          }, 'CreateMaintenanceEventComment');
        } catch (_) {}
      } catch (e) {
        alert('No se pudo cambiar el equipo: ' + e.message + '\nSe mantiene la línea anterior.');
        eqSel.value = String(ev.equipmentId);
      } finally {
        eqSel.disabled = false;
      }
    });

    const sensorSel = document.getElementById('pl-run-sensor');
    sensorSel.addEventListener('change', () => {
      const sid = parseInt(sensorSel.value, 10);
      state.selectedSensorId = Number.isFinite(sid) ? sid : null;
      ev.selectedSensorId = state.selectedSensorId;
      writeActiveEvent(ev);
    });

    document.getElementById('pl-run-addcomment').onclick = async () => {
      const ta = document.getElementById('pl-run-comment');
      const txt = ta.value.trim();
      if (!txt) return;
      const btn = document.getElementById('pl-run-addcomment');
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api().query('CreateMaintenanceEventComment',
          { comment: txt, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
        ta.value = '';
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'Añadir'; btn.disabled = false; }, 900);
      } catch (e) {
        alert('Error agregando comentario: ' + e.message);
        btn.textContent = 'Añadir';
        btn.disabled = false;
      }
    };

    document.getElementById('pl-run-stop').onclick = () => {
      stopEvent().catch(e => {
        alert('Error al detener: ' + e.message);
        const sb = document.getElementById('pl-run-stop');
        if (sb) { sb.disabled = false; sb.textContent = 'DETENER PARO'; }
      });
    };
  }

  function formatElapsed(ms) {
    if (!(ms >= 0)) ms = 0;
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  async function stopEvent() {
    const ev = state.activeEvent;
    if (!ev) return;
    if (!state.selectedSensorId) {
      alert('Selecciona un motivo antes de detener el paro.');
      return;
    }
    const stopBtn = document.getElementById('pl-run-stop');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = 'Deteniendo…'; }

    const finalCommentEl = document.getElementById('pl-run-comment');
    const finalComment = finalCommentEl?.value.trim();
    const totalMs = Date.now() - ev.createdAt;

    const ne = await api().query('CreateMaintenanceNodeEvent',
      { maintenanceNodeId: ev.nodeId, maintenanceEventId: ev.id }, 'CreateMaintenanceNodeEvent');
    const nodeEventId = ne?.createMaintenanceNodeEvent?.maintenanceNodeEvent?.id;
    if (!nodeEventId) throw new Error('Respuesta sin maintenanceNodeEvent.id');

    await api().query('CreateManySensorMeasurements', {
      input: [{
        sensorId: state.selectedSensorId,
        measurementBoolean: true,
        maintenanceNodeEventId: nodeEventId
      }]
    }, 'CreateManySensorMeasurements');

    if (finalComment) {
      try {
        await api().query('CreateMaintenanceEventComment',
          { comment: finalComment, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
      } catch (e) { console.warn('[SA] comentario final falló:', e.message); }
    }

    const completedAt = new Date().toISOString();
    await api().query('UpdateMaintenanceEvent',
      { id: ev.id, completedAt }, 'UpdateMaintenanceEvent');

    const sensors = await loadSensorsForNode(ev.nodeId).catch(() => []);
    const motivo = sensors.find(s => s.id === state.selectedSensorId)?.name || '(motivo)';

    const stopped = {
      id: ev.id,
      idInDomain: ev.idInDomain,
      totalMs,
      responsable: ev.responsable,
      motivo,
      linea: ev.equipmentName,
      completedAt
    };

    state.activeEvent = null;
    state.selectedSensorId = null;
    writeActiveEvent(null);
    if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
    updateFabStyle();

    renderSummaryView(stopped);
  }

  function renderSummaryView(s) {
    const domainId = cfg()?.steelhead?.domain?.id || '';
    const link = location.origin + '/Domains/' + domainId + '/MaintenanceEvents/' + s.idInDomain;
    showOverlay(
      '<div class="pl-summary">' +
        '<div style="font-size:44px">✅</div>' +
        '<div style="font-size:20px;font-weight:800;color:#86efac;margin:6px 0;letter-spacing:1px">PARO REGISTRADO</div>' +
        '<div class="pl-big">' + formatElapsed(s.totalMs) + '</div>' +
        '<dl class="pl-dl">' +
          '<dt>Responsable</dt><dd>' + escapeHtml(s.responsable || '—') + '</dd>' +
          '<dt>Motivo</dt><dd>' + escapeHtml(s.motivo || '—') + '</dd>' +
          '<dt>Línea</dt><dd>' + escapeHtml(s.linea || '—') + '</dd>' +
          '<dt>Evento</dt><dd><a href="' + link + '" target="_blank" style="color:#60a5fa;text-decoration:none">#' + s.idInDomain + '</a></dd>' +
        '</dl>' +
      '</div>' +
      '<div class="pl-btnrow">' +
        '<button class="pl-btn pl-btn-ghost" id="pl-sum-attach">📎 Adjuntar evidencia</button>' +
        '<button class="pl-btn pl-btn-primary" id="pl-sum-close">CERRAR</button>' +
      '</div>' +
      '<input type="file" id="pl-sum-file" accept="image/*,application/pdf" multiple style="display:none">'
    );

    const fileInput = document.getElementById('pl-sum-file');
    const attachBtn = document.getElementById('pl-sum-attach');
    attachBtn.onclick = () => fileInput.click();
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.length) return;
      attachBtn.disabled = true;
      attachBtn.textContent = 'Subiendo…';
      let ok = 0, fail = 0;
      for (const file of fileInput.files) {
        try { await attachEvidence(s.id, file); ok++; }
        catch (e) { fail++; console.error('[SA] attach', e); }
      }
      attachBtn.disabled = false;
      attachBtn.textContent = '📎 ' + ok + ' adjunto(s)' + (fail ? ' — ' + fail + ' fallaron' : '');
    });
    document.getElementById('pl-sum-close').onclick = removeOverlay;
  }

  async function attachEvidence(maintenanceEventId, file) {
    const formData = new FormData();
    formData.append('myfile', file, file.name);
    const resp = await fetch('/api/files', {
      method: 'POST', credentials: 'include', body: formData
    });
    if (!resp.ok) throw new Error('Upload HTTP ' + resp.status);
    const uploaded = await resp.json();
    await api().query('CreateUserFile',
      { name: uploaded.name, originalName: file.name }, 'CreateUserFile');
    await api().query('CreateMaintenanceEventUserFile',
      { maintenanceEventId, userFileName: uploaded.name }, 'CreateMaintenanceEventUserFile');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { init, openStopDialog, renderRunningView, stopEvent, attachEvidence };
})();

if (typeof window !== 'undefined') {
  window.ParosLinea = ParosLinea;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ParosLinea.init());
  } else {
    ParosLinea.init();
  }
}
