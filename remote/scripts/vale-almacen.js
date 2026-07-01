// Steelhead Vale de Almacén
// Botón flotante (📦) sobre las pantallas de producción / mantenimiento / sensores /
// inventario que emite un "vale" = evento de mantenimiento sobre un nodo de tipo
// "Surtimiento". El nodo raíz tiene 3 pasos; el paso 0 (los sensores NUMBER) es el
// catálogo de artículos. Cada línea del vale registra una cantidad por artículo y se
// asigna a un usuario; el asignado queda como COMENTARIO ESTRUCTURADO y parseable
// (motor en vale-almacen-engine.js) para reconstruir después la BD de entregas por
// usuario. El campo "Asignado" del evento = la persona que recoge el vale.
//
// Flujo: CreateMaintenanceEvent(raíz) → GetMaintenanceEvent → resolver paso 0
//        → OperatorMaintenanceNodeDialogQuery (sensores = artículos)
//        → CreateMaintenanceNodeEvent(paso 0) → CreateManySensorMeasurements (batch)
//        → CreateMaintenanceEventComment ([VALE]…) → /api/files (evidencia)
//        → UpdateMaintenanceNodeEvent{archivedAt} → UpdateMaintenanceEvent{completedAt}
// Depende de: SteelheadAPI + SteelheadValeEngine + window.REMOTE_CONFIG
const ValeAlmacen = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const engine = () => window.SteelheadValeEngine;

  const STATE_KEY = 'sa_vale_active_event';
  const EQUIP_CACHE_KEY = 'sa_vale_line_equipments_v1';
  const EQUIP_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
  const STEP0_CACHE_KEY = 'sa_vale_step0_map_v1';
  const LAST_LINE_KEY = 'sa_vale_last_line';

  // 4 familias de pantallas pedidas: Producción (Workboards/WorkOrders), Mantenimiento,
  // Tableros de sensores e Inventario. Los segmentos exactos de SH se confirman en vivo.
  const ALLOWED_PATH_RE = /^\/Domains\/\d+\/(Workboards|WorkOrders|Maintenance\w*|SensorDashboards?|Sensors|Inventory\w*)(?:\/|$)/i;
  const SURT_RE = /surtimiento/i;
  // Las RAÍCES de surtimiento empiezan con un código de área en MAYÚSCULAS (SMP/EPP/SGL/MTY/MLA/LIM…)
  // seguido de espacio; los PASOS hijo ("Solicitud…", "Surtimiento de Materia Prima",
  // "Confirmación de Entrega") no. Así separamos raíces de pasos en la query plana.
  const ROOT_CODE_RE = /^[A-Z]{2,4}\s/;

  let lineUidSeq = 1;
  function bumpUidSeq() { for (const l of state.lines) if ((l.uid || 0) >= lineUidSeq) lineUidSeq = l.uid + 1; }

  let state = {
    currentUser: null,
    surtimientoNodes: [],   // [{id, idInDomain, name, lineToken}]
    allEquipments: [],      // [{id, name, idInDomain}]
    catalogsLoaded: false,
    articleCatalog: [],     // sensores NUMBER del paso 0 [{id, name, measurementType, unidad, unidadFull, mustBeInteger}]
    activeEvent: null,      // persistido en localStorage
    lines: [],              // líneas en construcción
    empCache: {},           // userId -> CodigoEmpleado|null
    floatingBtn: null,
  };

  // ── init / FAB ────────────────────────────────────────────────────────────
  async function init() {
    if (window.__saValeAlmacenInitDone) {
      // Cierre re-creado por re-inyección: rehidratar lo esencial y re-sincronizar el FAB.
      state.currentUser = window.__saValeUser || state.currentUser;
      const saved = readActiveEvent();
      if (saved) state.activeEvent = saved;
      injectStyles();
      installUrlChangeListener();
      syncFabVisibility();
      return;
    }
    window.__saValeAlmacenInitDone = true;

    try {
      state.currentUser = await ensureCurrentUser();
    } catch (e) {
      console.warn('[SA] ValeAlmacen: no se pudo obtener usuario actual:', e.message);
    }
    if (state.currentUser && !isAuthorized(state.currentUser)) {
      console.log('[SA] ValeAlmacen: usuario sin permiso — botón omitido');
      return;
    }

    injectStyles();
    const saved = readActiveEvent();
    if (saved) {
      state.activeEvent = saved;
      state.lines = Array.isArray(saved.lines) ? saved.lines.slice() : [];
      bumpUidSeq();
    }
    installUrlChangeListener();
    syncFabVisibility();
  }

  async function ensureCurrentUser() {
    if (state.currentUser) return state.currentUser;
    if (window.__saValeUser) { state.currentUser = window.__saValeUser; return state.currentUser; }
    const u = await fetchCurrentUser();
    state.currentUser = u;
    window.__saValeUser = u;
    return u;
  }

  async function fetchCurrentUser() {
    const data = await api().query('CurrentUserDetails', {}, 'CurrentUserDetails');
    const u = data?.currentSession?.userByUserId;
    if (!u) return null;
    return { id: u.id, name: u.name || null, isAdmin: u.isAdmin === true, managedPermissions: undefined };
  }

  function isAuthorized(user) {
    if (!user) return true;
    if (user.isAdmin) return true;
    const req = cfg()?.apps?.find(a => a.id === 'vale-almacen')?.requiredPermissions || [];
    if (req.length === 0) return true;
    if (!Array.isArray(user.managedPermissions)) return true;
    return req.every(p => user.managedPermissions.includes(p));
  }

  function isAllowedPath() { return ALLOWED_PATH_RE.test(location.pathname); }

  function syncFabVisibility() {
    const should = isAllowedPath() || !!state.activeEvent;
    const existing = document.getElementById('sa-va-fab-dock');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) { existing.remove(); state.floatingBtn = null; }
    else if (should && existing) renderFloatingButton(); // refresca estado activo/inactivo
  }

  function installUrlChangeListener() {
    if (window.__saValeUrlListenerInstalled) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saValeUrlListenerInstalled = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      if (orig.__saValePatched) return;
      const patched = function () { const r = orig.apply(this, arguments); fire(); return r; };
      patched.__saValePatched = true;
      history[m] = patched;
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  function renderFloatingButton() {
    const existing = document.getElementById('sa-va-fab-dock');
    if (existing) existing.remove();

    const active = !!state.activeEvent;
    const dock = document.createElement('div');
    dock.className = 'va-fab-dock';
    dock.id = 'sa-va-fab-dock';

    const btn = document.createElement('button');
    btn.className = 'va-fab' + (active ? ' active' : '');
    btn.id = 'sa-va-fab';
    btn.setAttribute('aria-label', 'Vale de Almacén');
    btn.title = active ? 'Vale en curso — click para continuar' : 'Emitir Vale de Almacén';
    btn.textContent = '📦';
    btn.addEventListener('click', () => { open(); });
    dock.appendChild(btn);

    if (active) {
      const badge = document.createElement('div');
      badge.className = 'va-fab-badge';
      badge.textContent = 'vale en curso';
      dock.appendChild(badge);
    }

    document.body.appendChild(dock);
    state.floatingBtn = btn;
  }

  // ── estilos (dark mode propio) ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('dl9-vale-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl9-vale-styles';
    s.textContent = [
      '.va-fab-dock{position:fixed;bottom:24px;left:110px;z-index:99998;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}',
      '.va-fab-dock>*{pointer-events:auto}',
      '.va-fab{width:64px;height:64px;border-radius:50%;background:#13a36f;color:#fff;border:none;font-size:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease;box-shadow:0 8px 24px rgba(19,163,111,0.5),0 0 0 3px #0f172a}',
      '.va-fab:hover{transform:scale(1.08)}',
      '.va-fab.active{animation:vaPulse 1.6s ease-in-out infinite}',
      '@keyframes vaPulse{0%,100%{box-shadow:0 8px 24px rgba(19,163,111,0.5),0 0 0 3px #0f172a}50%{box-shadow:0 8px 30px rgba(19,163,111,0.85),0 0 0 6px rgba(19,163,111,0.5)}}',
      '@media (prefers-reduced-motion:reduce){.va-fab.active{animation:none}}',
      '.va-fab-badge{font-size:11px;font-weight:700;color:#0f172a;background:#34d399;border-radius:8px;padding:3px 8px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.4)}',
      '.va-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.va-modal{background:#1c2430;color:#e6e9ee;border-radius:18px;padding:28px 32px;width:760px;max-width:95vw;max-height:94vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);box-sizing:border-box}',
      '.va-modal h2{margin:0 0 6px;font-size:24px;color:#f0f3f7;display:flex;align-items:center;gap:10px}',
      '.va-sub{font-size:13px;color:#9aa7b5;margin:0 0 18px}',
      '.va-row{margin-bottom:14px}',
      '.va-label{font-size:11px;color:#9aa7b5;display:block;margin-bottom:6px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}',
      '.va-select,.va-input,.va-textarea{width:100%;padding:11px 13px;border-radius:9px;border:1px solid #3a4757;background:#141a23;color:#e6e9ee;font-size:15px;box-sizing:border-box}',
      '.va-select:disabled,.va-input:disabled{opacity:.55;cursor:not-allowed}',
      '.va-textarea{min-height:60px;resize:vertical;font-family:inherit}',
      '.va-locked{font-size:11px;color:#34d399;margin-top:4px;font-weight:600}',
      '.va-ta{position:relative}',
      '.va-dd{position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:30;max-height:210px;overflow-y:auto;background:#141a23;border:1px solid #3a4757;border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,0.5)}',
      '.va-dd-item{padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #232c38;color:#e6e9ee}',
      '.va-dd-item:last-child{border-bottom:none}',
      '.va-dd-item:hover,.va-dd-item.active{background:#243042}',
      '.va-dd-item small{color:#9aa7b5;margin-left:6px}',
      '.va-dd-empty{padding:9px 12px;font-size:12px;color:#64748b;font-style:italic}',
      '.va-lines{margin-top:6px}',
      '.va-lines-head,.va-line{display:grid;grid-template-columns:1fr 96px 1.1fr 96px 34px;gap:8px;align-items:start}',
      '.va-lines-head{font-size:10px;color:#9aa7b5;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px;padding:0 2px}',
      '.va-line{margin-bottom:8px}',
      '.va-unit-wrap{display:flex;align-items:center}',
      '.va-emp{font-size:12px;color:#9aa7b5;align-self:center;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.va-emp.ok{color:#34d399;font-weight:700}',
      '.va-x{background:#33404f;color:#e6e9ee;border:none;border-radius:8px;height:42px;cursor:pointer;font-size:15px}',
      '.va-x:hover{background:#4a5b6e}',
      '.va-addline{margin-top:4px;background:transparent;color:#34d399;border:1px dashed #2f6b54;border-radius:9px;padding:10px;width:100%;cursor:pointer;font-size:13px;font-weight:700}',
      '.va-addline:hover{background:rgba(19,163,111,0.1)}',
      '.va-divider{height:1px;background:#33404f;margin:18px 0}',
      '.va-btnrow{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap}',
      '.va-btn{padding:12px 22px;border:none;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.3px}',
      '.va-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.va-btn-cancel{background:#33404f;color:#e6e9ee}',
      '.va-btn-ghost{background:transparent;color:#cbd5e1;border:1px solid #3a4757}',
      '.va-btn-primary{background:#13a36f;color:#fff}',
      '.va-btn-primary:hover:not(:disabled){background:#0f8d60}',
      '.va-btn-danger{background:#7f1d1d;color:#fecaca}',
      '.va-error{color:#fecaca;background:#7f1d1d;padding:11px 13px;border-radius:9px;margin-bottom:12px;font-size:14px;white-space:pre-wrap}',
      '.va-warn{color:#fde68a;background:#78350f;padding:10px 13px;border-radius:9px;margin-bottom:12px;font-size:13px}',
      '.va-loading{text-align:center;padding:22px;color:#9aa7b5;font-size:14px}',
      '.va-static{background:#141a23;border:1px solid #33404f;border-radius:9px;padding:10px 12px;font-size:14px}',
      '.va-static strong{display:block;font-size:10px;color:#9aa7b5;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700}',
      '.va-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.va-summary{text-align:center;background:#141a23;border-radius:14px;padding:24px;margin:6px 0}',
      '.va-summary .va-chk{font-size:42px}',
      '.va-summary .va-ttl{font-size:18px;font-weight:800;color:#34d399;margin:6px 0;letter-spacing:.5px}',
      '.va-dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;text-align:left;margin-top:12px;font-size:14px}',
      '.va-dl dt{color:#9aa7b5}',
      '.va-dl dd{margin:0;color:#e6e9ee}',
      '.va-link{color:#5fb0ff;text-decoration:none}',
    ].join('');
    document.head.appendChild(s);
  }

  function removeOverlay() {
    const ov = document.getElementById('sa-va-overlay');
    if (ov) ov.remove();
  }

  function showOverlay(innerHTML) {
    removeOverlay();
    const ov = document.createElement('div');
    ov.className = 'va-overlay';
    ov.id = 'sa-va-overlay';
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) removeOverlay(); });
    const modal = document.createElement('div');
    modal.className = 'va-modal';
    modal.innerHTML = innerHTML;
    ov.appendChild(modal);
    document.body.appendChild(ov);
    return ov;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  function normalizeEs(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  // ── localStorage helpers ───────────────────────────────────────────────────
  function readActiveEvent() { try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch { return null; } }
  function writeActiveEvent(ev) {
    try { if (!ev) localStorage.removeItem(STATE_KEY); else localStorage.setItem(STATE_KEY, JSON.stringify(ev)); } catch (_) {}
  }
  function persistLines() {
    if (!state.activeEvent) return;
    state.activeEvent.lines = state.lines.map(l => ({
      uid: l.uid, articleSensorId: l.articleSensorId, articleName: l.articleName,
      unidad: l.unidad, mustBeInteger: l.mustBeInteger, quantity: l.quantity,
      assigneeId: l.assigneeId, assigneeName: l.assigneeName, employeeNumber: l.employeeNumber,
    }));
    writeActiveEvent(state.activeEvent);
  }
  function readStep0Cache() { try { return JSON.parse(localStorage.getItem(STEP0_CACHE_KEY) || '{}'); } catch { return {}; } }
  function writeStep0Cache(rootId, step0Id) {
    try { const m = readStep0Cache(); m[rootId] = step0Id; localStorage.setItem(STEP0_CACHE_KEY, JSON.stringify(m)); } catch (_) {}
  }

  // ── catálogos ──────────────────────────────────────────────────────────────
  function lineTokenFromName(name) {
    const m = String(name || '').match(/\b(T\d{2,3}[A-Z\-]*)\b/);
    return m ? m[1] : null;
  }

  async function loadCatalogs(force = false) {
    if (state.catalogsLoaded && !force) return;

    const dlg = await api().query('CreateMaintenanceEventDialogQuery', {}, 'CreateMaintenanceEventDialogQuery');
    const allNodes = dlg?.allMaintenanceNodes?.nodes || [];
    const roots = allNodes
      .filter(n => SURT_RE.test(n.name || '') && ROOT_CODE_RE.test(n.name || ''))
      .map(n => ({ id: n.id, idInDomain: n.idInDomain, name: n.name, lineToken: lineTokenFromName(n.name) }));
    if (roots.length === 0) {
      throw new Error('No hay nodos de mantenimiento de "Surtimiento" configurados. Contacta al administrador.');
    }
    roots.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
    state.surtimientoNodes = roots;

    if (!force) {
      const cached = readCachedLineEquipments();
      if (cached && cached.length > 0) {
        state.allEquipments = cached;
        state.catalogsLoaded = true;
        return;
      }
    }
    state.allEquipments = await fetchLineEquipments();
    if (state.allEquipments.length === 0) {
      throw new Error('No se encontraron equipos con etiqueta "Línea" o "Célula" en Steelhead.');
    }
    writeCachedLineEquipments(state.allEquipments);
    state.catalogsLoaded = true;
  }

  function readCachedLineEquipments() {
    try {
      const obj = JSON.parse(localStorage.getItem(EQUIP_CACHE_KEY) || 'null');
      if (!obj || !Array.isArray(obj.equipments)) return null;
      if (Date.now() - (obj.savedAt || 0) > EQUIP_CACHE_TTL_MS) return null;
      return obj.equipments;
    } catch { return null; }
  }
  function writeCachedLineEquipments(equipments) {
    try { localStorage.setItem(EQUIP_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), equipments })); } catch (_) {}
  }

  const LINE_LABEL_RE = /^(?:l[ií]neas?|c[eé]lulas?)$/i;
  async function fetchLineEquipments() {
    const PAGE = 500;
    const matchByLine = (e) => {
      const labels = e?.equipmentLabelsByEquipmentId?.nodes || [];
      return labels.some(l => {
        const nm = l?.labelByLabelId?.name || l?.name;
        return typeof nm === 'string' && LINE_LABEL_RE.test(nm.trim());
      });
    };
    const matched = [];
    let offset = 0, total = null, scanned = 0, safety = 0;
    while (safety++ < 20) {
      const data = await api().query('AllEquipments', {
        fetchEquipmentType: false, fetchStation: false, fetchLabel: true, fetchLocation: false,
        endOfService: true, orderBy: ['NAME_ASC'], offset, first: PAGE, searchQuery: ''
      }, 'AllEquipments');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) total = data?.pagedData?.totalCount ?? null;
      scanned += nodes.length;
      for (const n of nodes) if (matchByLine(n)) matched.push({ id: n.id, name: n.name, idInDomain: n.idInDomain });
      const el = document.getElementById('va-pre');
      if (el && el.classList.contains('va-loading')) {
        el.textContent = 'Cargando equipos… ' + scanned + (total ? '/' + total : '') + ' (líneas: ' + matched.length + ')';
      }
      if (nodes.length < PAGE) break;
      if (total != null && scanned >= total) break;
      offset += PAGE;
    }
    return matched;
  }

  async function inferLinePrefix() {
    const wbMatch = location.pathname.match(/\/Workboards\/(\d+)/);
    if (wbMatch) {
      try {
        const data = await api().query('WorkboardById', { id: parseInt(wbMatch[1], 10) }, 'WorkboardById');
        const name = data?.workboardById?.name;
        if (name) { try { localStorage.setItem(LAST_LINE_KEY, name); } catch (_) {} return name; }
      } catch (_) {}
    }
    const headings = document.querySelectorAll('h1, h2, h3, [class*="breadcrumb"], [class*="Breadcrumb"], [class*="page-title"], [class*="PageTitle"]');
    for (const h of headings) {
      const m = (h.textContent || '').match(/\b(T\d{2,3}[A-Z\-]*)\b/);
      if (m) return m[1];
    }
    try { return localStorage.getItem(LAST_LINE_KEY); } catch { return null; }
  }

  function matchEquipmentByToken(token) {
    if (!token || !state.allEquipments.length) return null;
    const p = token.toUpperCase();
    let m = state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(p));
    if (m) return m;
    const tk = p.match(/^(T\d{2,3})/);
    if (tk) {
      m = state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(tk[1]))
        || state.allEquipments.find(e => (e.name || '').toUpperCase().includes(tk[1]));
      if (m) return m;
    }
    return state.allEquipments.find(e => (e.name || '').toUpperCase().includes(p)) || null;
  }

  async function loadSensorsForNode(nodeId, eventId) {
    const data = await api().query('OperatorMaintenanceNodeDialogQuery',
      { nodeId, maintenanceEventId: eventId || 0 }, 'OperatorMaintenanceNodeDialogQuery');
    const raw = data?.maintenanceNodeById?.maintenanceNodeSensorsByMaintenanceNodeId?.nodes || [];
    return raw.map(s => {
      const sb = s.sensorBySensorId;
      if (!sb) return null;
      const st = sb.sensorTypeBySensorTypeId || {};
      const unit = st.unitByUnitId || {};
      const full = unit.name || '';
      return {
        id: sb.id, name: sb.name || '',
        measurementType: st.sensorMeasurementType || null,
        unidad: full ? String(full).split(/\s+/)[0] : '',
        unidadFull: full,
        mustBeInteger: !!unit.mustBeInteger,
      };
    }).filter(Boolean);
  }

  // Resuelve el paso de artículos (paso 0) de una raíz y devuelve sus sensores NUMBER.
  async function discoverArticleStep(rootNode, eventId, eventIdInDomain) {
    const cache = readStep0Cache();
    if (cache[rootNode.id]) {
      const sensors = await loadSensorsForNode(cache[rootNode.id], eventId);
      const numeric = sensors.filter(s => s.measurementType === 'NUMBER');
      if (numeric.length) return { step0Id: cache[rootNode.id], sensors: numeric };
    }
    const data = await api().query('GetMaintenanceEvent', { idInDomain: eventIdInDomain }, 'GetMaintenanceEvent');
    const rootData = data?.maintenanceEventByIdInDomain?.maintenanceNodeByMaintenanceNodeId;
    const relsRaw = rootData?.descendantRelationships?.nodes || rootData?.descendantRelationships || [];
    const children = (Array.isArray(relsRaw) ? relsRaw : [])
      .filter(r => r && r.maintenanceNodeByFromId && (r.maintenanceNodeByToId == null || r.maintenanceNodeByToId.id === rootNode.id))
      .map(r => ({ childIndex: r.childIndex == null ? 99 : r.childIndex, node: r.maintenanceNodeByFromId }))
      .filter(c => c.node && c.node.id != null)
      .sort((a, b) => a.childIndex - b.childIndex);

    if (!children.length) {
      // Sin hijos: tratar la propia raíz como paso de artículos (fallback).
      const sensors = (await loadSensorsForNode(rootNode.id, eventId)).filter(s => s.measurementType === 'NUMBER');
      writeStep0Cache(rootNode.id, rootNode.id);
      return { step0Id: rootNode.id, sensors };
    }
    for (const c of children) {
      const sensors = (await loadSensorsForNode(c.node.id, eventId)).filter(s => s.measurementType === 'NUMBER');
      if (sensors.length) { writeStep0Cache(rootNode.id, c.node.id); return { step0Id: c.node.id, sensors }; }
    }
    // Ninguno con sensores NUMBER: usar el primer hijo igual (sin artículos).
    writeStep0Cache(rootNode.id, children[0].node.id);
    return { step0Id: children[0].node.id, sensors: [] };
  }

  // ── typeahead genérico ─────────────────────────────────────────────────────
  // fetcher(query) -> Promise<[{key, label, sub, data}]>; onPick(item)
  function wireTypeahead(inputEl, ddEl, fetcher, onPick, opts) {
    const o = opts || {};
    const minChars = o.minChars == null ? 1 : o.minChars;
    const debounceMs = o.debounceMs == null ? 200 : o.debounceMs;
    let timer = null;
    const hide = () => { ddEl.style.display = 'none'; ddEl.innerHTML = ''; };
    const renderItems = (items) => {
      if (!items.length) { ddEl.innerHTML = '<div class="va-dd-empty">Sin resultados</div>'; ddEl.style.display = 'block'; return; }
      ddEl.innerHTML = items.map((it, i) =>
        '<div class="va-dd-item" data-i="' + i + '">' + escapeHtml(it.label) +
        (it.sub ? '<small>' + escapeHtml(it.sub) + '</small>' : '') + '</div>'
      ).join('');
      ddEl.querySelectorAll('.va-dd-item[data-i]').forEach(node => {
        node.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const it = items[parseInt(node.dataset.i, 10)];
          if (!it) return;
          inputEl.value = it.label;
          hide();
          onPick(it.data, it);
        });
      });
      ddEl.style.display = 'block';
    };
    inputEl.addEventListener('input', () => {
      clearTimeout(timer);
      const q = inputEl.value.trim();
      if (q.length < minChars) { hide(); return; }
      timer = setTimeout(async () => {
        try { renderItems((await fetcher(q)) || []); }
        catch (e) { ddEl.innerHTML = '<div class="va-dd-empty">Error: ' + escapeHtml(String(e.message || e).slice(0, 50)) + '</div>'; ddEl.style.display = 'block'; }
      }, debounceMs);
    });
    inputEl.addEventListener('blur', () => setTimeout(hide, 150));
  }

  function articleFetcher(q) {
    const nq = normalizeEs(q);
    const matches = state.articleCatalog
      .filter(a => normalizeEs(a.name).includes(nq))
      .slice(0, 40)
      .map(a => ({ key: a.id, label: a.name, sub: a.unidad || '', data: a }));
    return Promise.resolve(matches);
  }

  async function userFetcher(q) {
    const data = await api().query('SearchUsers', { searchQuery: q, first: 20 }, 'SearchUsers');
    const nodes = data?.searchUsers?.nodes || data?.pagedData?.nodes || [];
    return nodes
      .filter(u => u && (u.name || u.fullName))
      .map(u => ({ key: u.id, label: u.name || u.fullName, data: { id: u.id, name: u.name || u.fullName } }));
  }

  async function fetchEmployeeNumber(userId) {
    if (userId == null) return null;
    if (Object.prototype.hasOwnProperty.call(state.empCache, userId)) return state.empCache[userId];
    let code = null;
    try {
      const domainId = cfg()?.steelhead?.domain?.id;
      const data = await api().query('UserDialogQuery', { domainId, userId }, 'UserDialogQuery');
      code = data?.userById?.customInputs?.DatosLaborales?.CodigoEmpleado ?? null;
    } catch (e) {
      console.warn('[SA] ValeAlmacen: número de empleado no disponible:', e.message);
    }
    state.empCache[userId] = code;
    return code;
  }

  // ── entrada principal ──────────────────────────────────────────────────────
  function open() {
    if (state.activeEvent) return renderLinesPhase();
    return openValeDialog();
  }

  // ── Fase A: encabezado ─────────────────────────────────────────────────────
  async function openValeDialog() {
    showOverlay('<h2>📦 Vale de Almacén</h2><div id="va-pre" class="va-loading">Cargando catálogos…</div>');
    try {
      await ensureCurrentUser();
      await loadCatalogs();
    } catch (e) {
      const pre = document.getElementById('va-pre');
      if (pre) pre.outerHTML = '<div class="va-error">' + escapeHtml(e.message) + '</div>' +
        '<div class="va-btnrow"><button class="va-btn va-btn-cancel" id="va-pre-close">CERRAR</button></div>';
      const c = document.getElementById('va-pre-close'); if (c) c.onclick = removeOverlay;
      return;
    }

    const nodeOpts = state.surtimientoNodes
      .map(n => '<option value="' + n.id + '">' + escapeHtml(n.name) + '</option>').join('');
    const onlyOne = state.surtimientoNodes.length === 1;

    const linePrefix = await inferLinePrefix();
    const ctxEq = matchEquipmentByToken(linePrefix);
    const eqOpts = state.allEquipments
      .map(e => '<option value="' + e.id + '"' + (ctxEq && ctxEq.id === e.id ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>').join('');

    document.querySelector('#sa-va-overlay .va-modal').innerHTML =
      '<h2>📦 Vale de Almacén</h2>' +
      '<p class="va-sub">Surtido de material/equipo a usuarios. Encabezado del vale:</p>' +
      '<div class="va-row">' +
        '<label class="va-label">Tipo de surtimiento</label>' +
        '<select class="va-select" id="va-node"' + (onlyOne ? ' disabled' : '') + '>' +
          (onlyOne ? '' : '<option value="">— Selecciona —</option>') + nodeOpts +
        '</select>' +
      '</div>' +
      '<div class="va-row">' +
        '<label class="va-label">Línea / Equipo *</label>' +
        '<select class="va-select" id="va-eq"><option value="">— Selecciona equipo —</option>' + eqOpts + '</select>' +
        '<div class="va-locked" id="va-eq-locked" style="display:none">🔒 Inferida del tipo de surtimiento</div>' +
      '</div>' +
      '<div class="va-row va-ta">' +
        '<label class="va-label">Asignado — quien recoge el vale *</label>' +
        '<input class="va-input" id="va-pickup" placeholder="Buscar usuario…" autocomplete="off">' +
        '<div class="va-dd" id="va-pickup-dd" style="display:none"></div>' +
      '</div>' +
      '<div class="va-btnrow">' +
        '<button class="va-btn va-btn-cancel" id="va-cancel">CANCELAR</button>' +
        '<button class="va-btn va-btn-primary" id="va-continue" disabled>CARGAR ARTÍCULOS →</button>' +
      '</div>';

    const nodeSel = document.getElementById('va-node');
    const eqSel = document.getElementById('va-eq');
    const eqLocked = document.getElementById('va-eq-locked');
    const pickupInput = document.getElementById('va-pickup');
    const pickupDd = document.getElementById('va-pickup-dd');
    const contBtn = document.getElementById('va-continue');

    let pickup = null; // {id, name}

    const refresh = () => {
      const nodeVal = onlyOne ? String(state.surtimientoNodes[0].id) : nodeSel.value;
      contBtn.disabled = !(nodeVal && eqSel.value && pickup);
    };

    const applyNodeInference = () => {
      const nodeId = parseInt(onlyOne ? state.surtimientoNodes[0].id : nodeSel.value, 10);
      const node = state.surtimientoNodes.find(n => n.id === nodeId);
      eqSel.disabled = false;
      eqLocked.style.display = 'none';
      if (node && node.lineToken) {
        const inferred = matchEquipmentByToken(node.lineToken);
        if (inferred) {
          eqSel.value = String(inferred.id);
          eqSel.disabled = true;
          eqLocked.style.display = 'block';
        }
      }
      refresh();
    };

    if (onlyOne) applyNodeInference();
    nodeSel.addEventListener('change', applyNodeInference);
    eqSel.addEventListener('change', refresh);

    wireTypeahead(pickupInput, pickupDd, userFetcher, (u) => { pickup = u; refresh(); }, { minChars: 2, debounceMs: 300 });
    pickupInput.addEventListener('input', () => { pickup = null; refresh(); });

    document.getElementById('va-cancel').onclick = removeOverlay;
    contBtn.onclick = async () => {
      const nodeId = parseInt(onlyOne ? state.surtimientoNodes[0].id : nodeSel.value, 10);
      const equipmentId = parseInt(eqSel.value, 10);
      const node = state.surtimientoNodes.find(n => n.id === nodeId);
      const eq = state.allEquipments.find(e => e.id === equipmentId);
      if (!node || !eq || !pickup) return;

      contBtn.disabled = true;
      contBtn.textContent = 'Creando vale…';
      try {
        const data = await api().query('CreateMaintenanceEvent', {
          maintenancePlanId: null, maintenanceNodeId: nodeId, equipmentId, assigneeId: pickup.id
        }, 'CreateMaintenanceEvent');
        const ev = data?.createMaintenanceEvent?.maintenanceEvent;
        if (!ev) throw new Error('Respuesta sin maintenanceEvent');

        contBtn.textContent = 'Cargando artículos…';
        const { step0Id, sensors } = await discoverArticleStep(node, ev.id, ev.idInDomain);
        state.articleCatalog = sensors;

        state.activeEvent = {
          id: ev.id, idInDomain: ev.idInDomain,
          nodeId, nodeName: node.name, step0Id,
          equipmentId, equipmentName: eq.name,
          pickupId: pickup.id, pickupName: pickup.name,
          createdAt: Date.now(), lines: [],
        };
        writeActiveEvent(state.activeEvent);
        state.lines = [];
        try { localStorage.setItem(LAST_LINE_KEY, eq.name); } catch (_) {}
        syncFabVisibility();
        renderLinesPhase();
      } catch (e) {
        const modal = document.querySelector('#sa-va-overlay .va-modal');
        const err = document.createElement('div');
        err.className = 'va-error';
        err.textContent = 'Error: ' + e.message;
        modal.insertBefore(err, modal.querySelector('.va-btnrow'));
        contBtn.disabled = false;
        contBtn.textContent = 'CARGAR ARTÍCULOS →';
      }
    };
  }

  // ── Fase B: líneas del vale ────────────────────────────────────────────────
  async function renderLinesPhase() {
    const ev = state.activeEvent;
    if (!ev) return openValeDialog();

    // Reanudación: recargar catálogo de artículos si hace falta.
    if (!state.articleCatalog.length && ev.step0Id) {
      showOverlay('<h2>📦 Vale en curso</h2><div id="va-pre" class="va-loading">Recargando artículos…</div>');
      try {
        await ensureCurrentUser();
        if (!state.catalogsLoaded) await loadCatalogs();
        state.articleCatalog = (await loadSensorsForNode(ev.step0Id, ev.id)).filter(s => s.measurementType === 'NUMBER');
      } catch (e) { console.warn('[SA] ValeAlmacen recargar artículos:', e.message); }
    }
    if (Array.isArray(ev.lines) && ev.lines.length && !state.lines.length) { state.lines = ev.lines.slice(); bumpUidSeq(); }

    showOverlay(
      '<h2>📦 Vale de Almacén <span style="font-size:13px;color:#9aa7b5;font-weight:500">#' + ev.idInDomain + '</span></h2>' +
      '<div class="va-grid2" style="margin-bottom:14px">' +
        '<div class="va-static"><strong>Línea / Equipo</strong>' + escapeHtml(ev.equipmentName || '—') + '</div>' +
        '<div class="va-static"><strong>Recoge</strong>' + escapeHtml(ev.pickupName || '—') + '</div>' +
      '</div>' +
      '<div class="va-static" style="margin-bottom:14px"><strong>Tipo de surtimiento</strong>' + escapeHtml(ev.nodeName || '—') + '</div>' +
      (state.articleCatalog.length ? '' : '<div class="va-warn">No se encontraron artículos (sensores) en el paso de solicitud de este nodo. Verifica la configuración en Steelhead.</div>') +
      '<div class="va-lines-head"><div>Artículo</div><div>Cant.</div><div>Asignado a</div><div>Núm. emp.</div><div></div></div>' +
      '<div class="va-lines" id="va-lines"></div>' +
      '<button class="va-addline" id="va-addline">+ Agregar artículo</button>' +
      '<div class="va-divider"></div>' +
      '<div class="va-row">' +
        '<label class="va-label">Comentario general (opcional)</label>' +
        '<textarea class="va-textarea" id="va-general" placeholder="Notas libres del vale…"></textarea>' +
      '</div>' +
      '<div class="va-row">' +
        '<label class="va-label">Evidencia (fotos / PDF)</label>' +
        '<input type="file" id="va-files" accept="image/*,application/pdf" multiple class="va-input">' +
      '</div>' +
      '<div id="va-submit-msg"></div>' +
      '<div class="va-btnrow">' +
        '<button class="va-btn va-btn-danger" id="va-discard">DESCARTAR</button>' +
        '<button class="va-btn va-btn-ghost" id="va-hide">OCULTAR</button>' +
        '<button class="va-btn va-btn-primary" id="va-submit">EMITIR VALE 📦</button>' +
      '</div>'
    );

    const linesHost = document.getElementById('va-lines');
    state.lines.forEach(l => addLineRow(linesHost, l));
    if (!state.lines.length) addLineRow(linesHost);

    document.getElementById('va-addline').onclick = () => addLineRow(linesHost);
    document.getElementById('va-hide').onclick = removeOverlay;
    document.getElementById('va-discard').onclick = discardVale;
    document.getElementById('va-submit').onclick = () => {
      submitVale().catch(e => showSubmitError('Error: ' + e.message));
    };
  }

  function addLineRow(host, existing) {
    const line = existing || {
      uid: lineUidSeq++, articleSensorId: null, articleName: '', unidad: '', mustBeInteger: false,
      quantity: '', assigneeId: null, assigneeName: '', employeeNumber: null,
    };
    if (!existing) state.lines.push(line);
    if (line.uid == null) line.uid = lineUidSeq++;

    const row = document.createElement('div');
    row.className = 'va-line';
    row.dataset.uid = line.uid;
    const step = line.mustBeInteger ? '1' : 'any';
    row.innerHTML =
      '<div class="va-ta">' +
        '<input class="va-input va-art" placeholder="Buscar artículo…" autocomplete="off" value="' + escapeHtml(line.articleName) + '">' +
        '<div class="va-dd va-art-dd" style="display:none"></div>' +
      '</div>' +
      '<input class="va-input va-qty" type="number" min="0" step="' + step + '" placeholder="0" value="' + escapeHtml(line.quantity) + '">' +
      '<div class="va-ta">' +
        '<input class="va-input va-user" placeholder="Asignar a…" autocomplete="off" value="' + escapeHtml(line.assigneeName) + '">' +
        '<div class="va-dd va-user-dd" style="display:none"></div>' +
      '</div>' +
      '<div class="va-emp' + (line.employeeNumber ? ' ok' : '') + '">' + escapeHtml(line.employeeNumber || '—') + '</div>' +
      '<button class="va-x" title="Quitar">✕</button>';
    host.appendChild(row);

    const artInput = row.querySelector('.va-art');
    const artDd = row.querySelector('.va-art-dd');
    const qtyInput = row.querySelector('.va-qty');
    const userInput = row.querySelector('.va-user');
    const userDd = row.querySelector('.va-user-dd');
    const empBox = row.querySelector('.va-emp');

    wireTypeahead(artInput, artDd, articleFetcher, (a) => {
      line.articleSensorId = a.id;
      line.articleName = a.name;
      line.unidad = a.unidad;
      line.mustBeInteger = a.mustBeInteger;
      qtyInput.step = a.mustBeInteger ? '1' : 'any';
      qtyInput.placeholder = a.unidad ? a.unidad : '0';
      persistLines();
    }, { minChars: 1, debounceMs: 120 });
    artInput.addEventListener('input', () => { line.articleSensorId = null; line.articleName = artInput.value.trim(); });

    qtyInput.addEventListener('input', () => { line.quantity = qtyInput.value; persistLines(); });

    wireTypeahead(userInput, userDd, userFetcher, async (u) => {
      line.assigneeId = u.id;
      line.assigneeName = u.name;
      line.employeeNumber = null;
      empBox.textContent = '…';
      empBox.classList.remove('ok');
      persistLines();
      const code = await fetchEmployeeNumber(u.id);
      line.employeeNumber = code;
      empBox.textContent = code || '?';
      empBox.classList.toggle('ok', !!code);
      persistLines();
    }, { minChars: 2, debounceMs: 300 });
    userInput.addEventListener('input', () => { line.assigneeId = null; line.assigneeName = userInput.value.trim(); line.employeeNumber = null; empBox.textContent = '—'; empBox.classList.remove('ok'); });

    row.querySelector('.va-x').onclick = () => {
      state.lines = state.lines.filter(l => l.uid !== line.uid);
      row.remove();
      persistLines();
      if (!state.lines.length) addLineRow(host);
    };
  }

  function showSubmitError(msg) {
    const box = document.getElementById('va-submit-msg');
    if (box) box.innerHTML = '<div class="va-error">' + escapeHtml(msg) + '</div>';
  }
  function showSubmitWarn(msg) {
    const box = document.getElementById('va-submit-msg');
    if (box) box.innerHTML = '<div class="va-warn">' + escapeHtml(msg) + '</div>';
  }

  async function submitVale() {
    const ev = state.activeEvent;
    if (!ev) return;
    const E = engine();

    // Considerar solo filas con algún dato; validar todas.
    const lines = state.lines.filter(l => l.articleSensorId || l.assigneeId || (l.quantity !== '' && l.quantity != null) || l.articleName);
    if (!lines.length) { showSubmitError('Agrega al menos un artículo al vale.'); return; }

    const errors = [];
    lines.forEach((l, i) => {
      const v = E.validateValeLine(l);
      if (!v.valid) errors.push('Línea ' + (i + 1) + ': ' + v.errors.join(', '));
    });
    if (errors.length) { showSubmitError(errors.join('\n')); return; }

    const submitBtn = document.getElementById('va-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Emitiendo…'; }
    showSubmitWarn('Registrando vale… no cierres esta ventana.');

    const post = (text) => api().query('CreateMaintenanceEventComment', { comment: text, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');

    try {
      // 1. nodeEvent del paso de artículos
      const ne = await api().query('CreateMaintenanceNodeEvent', { maintenanceNodeId: ev.step0Id, maintenanceEventId: ev.id }, 'CreateMaintenanceNodeEvent');
      const nodeEventId = ne?.createMaintenanceNodeEvent?.maintenanceNodeEvent?.id;
      if (!nodeEventId) throw new Error('Respuesta sin maintenanceNodeEvent.id');

      // 2. mediciones (cantidades) en una sola llamada
      await api().query('CreateManySensorMeasurements', {
        input: lines.map(l => ({ sensorId: l.articleSensorId, measurement: Number(l.quantity), maintenanceNodeEventId: nodeEventId }))
      }, 'CreateManySensorMeasurements');

      // 3-5. comentarios (best-effort: no abortan el cierre)
      const nowIso = new Date().toISOString();
      try { await post(E.buildHeaderComment({ fecha: nowIso, equipmentName: ev.equipmentName, nodeName: ev.nodeName, pickupName: ev.pickupName, items: lines.length })); } catch (e) { console.warn('[SA] vale header:', e.message); }
      for (const l of lines) {
        try {
          await post(E.buildLineComment({
            articleName: l.articleName, quantity: l.quantity, unidad: l.unidad,
            assigneeName: l.assigneeName, employeeNumber: l.employeeNumber, equipmentName: ev.equipmentName,
          }));
        } catch (e) { console.warn('[SA] vale línea:', e.message); }
      }
      const general = (document.getElementById('va-general')?.value || '').trim();
      if (general) { try { await post(general); } catch (e) { console.warn('[SA] vale general:', e.message); } }

      // 6. evidencia (best-effort)
      const fileInput = document.getElementById('va-files');
      let filesOk = 0, filesFail = 0;
      if (fileInput?.files?.length) {
        if (submitBtn) submitBtn.textContent = 'Subiendo evidencia…';
        for (const f of fileInput.files) {
          try { await attachEvidence(ev.id, f); filesOk++; } catch (e) { filesFail++; console.error('[SA] evidencia:', e); }
        }
      }

      // 7. cerrar paso + evento
      const completedAt = new Date().toISOString();
      try { await api().query('UpdateMaintenanceNodeEvent', { id: nodeEventId, archivedAt: completedAt }, 'UpdateMaintenanceNodeEvent'); } catch (e) { console.warn('[SA] archivar paso:', e.message); }
      await api().query('UpdateMaintenanceEvent', { id: ev.id, completedAt }, 'UpdateMaintenanceEvent');
      try { await post(E.buildFooterComment({ items: lines.length, completedAt })); } catch (_) {}

      const summary = {
        idInDomain: ev.idInDomain, equipmentName: ev.equipmentName, pickupName: ev.pickupName,
        items: lines.length, filesOk, filesFail,
      };
      clearActive();
      renderSummary(summary);
    } catch (e) {
      showSubmitError('No se pudo emitir el vale: ' + e.message + '\nEl evento #' + ev.idInDomain + ' quedó abierto; puedes reintentar.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'EMITIR VALE 📦'; }
    }
  }

  async function discardVale() {
    const ev = state.activeEvent;
    if (!ev) { removeOverlay(); return; }
    if (!window.confirm('¿Descartar este vale? El evento #' + ev.idInDomain + ' se cerrará sin artículos.')) return;
    const btn = document.getElementById('va-discard');
    if (btn) { btn.disabled = true; btn.textContent = 'Descartando…'; }
    try {
      try {
        await api().query('CreateMaintenanceEventComment', { comment: '[VALE-DESCARTADO] sin artículos', maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
      } catch (_) {}
      await api().query('UpdateMaintenanceEvent', { id: ev.id, completedAt: new Date().toISOString() }, 'UpdateMaintenanceEvent');
    } catch (e) {
      console.warn('[SA] ValeAlmacen descartar:', e.message);
    }
    clearActive();
    removeOverlay();
  }

  function clearActive() {
    state.activeEvent = null;
    state.lines = [];
    state.articleCatalog = [];
    writeActiveEvent(null);
    syncFabVisibility();
  }

  function renderSummary(s) {
    const domainId = cfg()?.steelhead?.domain?.id || '';
    const link = location.origin + '/Domains/' + domainId + '/MaintenanceEvents/' + s.idInDomain;
    showOverlay(
      '<div class="va-summary">' +
        '<div class="va-chk">✅</div>' +
        '<div class="va-ttl">VALE EMITIDO</div>' +
        '<dl class="va-dl">' +
          '<dt>Evento</dt><dd><a class="va-link" href="' + link + '" target="_blank">#' + s.idInDomain + '</a></dd>' +
          '<dt>Línea</dt><dd>' + escapeHtml(s.equipmentName || '—') + '</dd>' +
          '<dt>Recoge</dt><dd>' + escapeHtml(s.pickupName || '—') + '</dd>' +
          '<dt>Artículos</dt><dd>' + s.items + '</dd>' +
          (s.filesOk || s.filesFail ? '<dt>Evidencia</dt><dd>' + s.filesOk + ' adjunto(s)' + (s.filesFail ? ' — ' + s.filesFail + ' fallaron' : '') + '</dd>' : '') +
        '</dl>' +
      '</div>' +
      '<div class="va-btnrow">' +
        '<button class="va-btn va-btn-primary" id="va-sum-close">CERRAR</button>' +
      '</div>'
    );
    document.getElementById('va-sum-close').onclick = removeOverlay;
  }

  async function attachEvidence(maintenanceEventId, file) {
    const formData = new FormData();
    formData.append('myfile', file, file.name);
    const resp = await fetch('/api/files', { method: 'POST', credentials: 'include', body: formData });
    if (!resp.ok) throw new Error('Upload HTTP ' + resp.status);
    const uploaded = await resp.json();
    await api().query('CreateUserFile', { name: uploaded.name, originalName: file.name }, 'CreateUserFile');
    await api().query('CreateMaintenanceEventUserFile', { maintenanceEventId, userFileName: uploaded.name }, 'CreateMaintenanceEventUserFile');
  }

  return { init, open, openValeDialog, renderLinesPhase, submitVale, attachEvidence, _state: () => state };
})();

if (typeof window !== 'undefined') {
  window.ValeAlmacen = ValeAlmacen;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ValeAlmacen.init());
  } else {
    ValeAlmacen.init();
  }
}
