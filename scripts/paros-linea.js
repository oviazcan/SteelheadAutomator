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
  const EQUIP_CACHE_KEY = 'sa_paros_line_equipments_v1';
  const EQUIP_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

  const RESPONSABLE_AREAS = {
    PLM: { label: 'Mantenimiento',          icon: '🔧' },
    PLP: { label: 'Producción',             icon: '🏭' },
    PLO: { label: 'Operaciones',            icon: '⚙️' },
    PLR: { label: 'Recursos Humanos',       icon: '👥' },
    PLC: { label: 'Calidad',                icon: '✅' },
    PLS: { label: 'Seguridad',              icon: '🛡️' },
    PLA: { label: 'Almacén',                icon: '📦' },
    PLI: { label: 'Ingeniería',             icon: '🛠️' },
    PLL: { label: 'Laboratorio y Procesos', icon: '🧪' },
    PLN: { label: 'Planeación',             icon: '📅' },
    PLT: { label: 'TI (Sistemas)',          icon: '💻' }
  };
  const DEFAULT_AREA_ICON = '📌';

  function normalizeEs(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }

  const LINE_LABEL_RE = /^(?:l[ií]neas?|c[eé]lulas?)$/i;
  const ALLOWED_PATH_RE = /^\/Domains\/\d+\/(Workboards|WorkOrders)(?:\/|$)/;

  let state = {
    currentUser: null,
    allNodes: [],
    responsableOptions: [],
    allEquipments: [],
    selectedSensorId: null,
    activeEvent: null,
    timerInterval: null,
    fabTimerInterval: null,
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

    const saved = readActiveEvent();
    if (saved) {
      state.activeEvent = saved;
      state.selectedSensorId = saved.selectedSensorId || null;
    }

    installUrlChangeListener();
    syncFabVisibility();

    if (saved) {
      loadCatalogs().catch(e => console.warn('[SA] ParosLinea catálogos:', e.message));
      renderRunningView().catch(e => console.warn('[SA] ParosLinea reanudar:', e.message));
    }
  }

  function isAllowedPath() {
    return ALLOWED_PATH_RE.test(location.pathname);
  }

  function syncFabVisibility() {
    const should = isAllowedPath() || !!state.activeEvent;
    const existing = document.getElementById('sa-pl-fab-dock');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) {
      existing.remove();
      stopFabTimer();
      state.floatingBtn = null;
    }
  }

  function installUrlChangeListener() {
    if (window.__saParosUrlListenerInstalled) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saParosUrlListenerInstalled = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  async function fetchCurrentUser() {
    const data = await api().query('CurrentUser', { deviceLocationIds: [] }, 'CurrentUser');
    const u = data?.currentSession?.userByUserId;
    if (!u) return null;
    return {
      id: u.id, name: u.name, isAdmin: u.isAdmin === true,
      managedPermissions: Array.isArray(u.currentManagedPermissions) ? u.currentManagedPermissions : []
    };
  }

  function isAuthorized(user) {
    if (user.isAdmin) return true;
    const req = cfg()?.apps?.find(a => a.id === 'paros-linea')?.requiredPermissions || [];
    if (req.length === 0) return true;
    if (!Array.isArray(user.managedPermissions)) return true;
    return req.every(p => user.managedPermissions.includes(p));
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

  function pushComment(ev, { text, author, auto = false, at }) {
    if (!ev) return;
    if (!Array.isArray(ev.comments)) ev.comments = [];
    ev.comments.push({
      at: at || Date.now(),
      text: String(text || '').trim(),
      author: author || (state.currentUser?.name || 'Operador'),
      auto: !!auto
    });
    writeActiveEvent(ev);
    renderCommentsList();
  }

  function renderCommentsList() {
    const host = document.getElementById('pl-comments-list');
    if (!host) return;
    const comments = (state.activeEvent?.comments || []).slice().reverse();
    if (!comments.length) {
      host.innerHTML = '<div class="pl-comments-empty">Aún no hay comentarios en este paro.</div>';
      return;
    }
    host.innerHTML = comments.map(c => {
      const t = new Date(c.at);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const meta = escapeHtml(c.author || 'Operador') + ' · ' + hh + ':' + mm + ':' + ss +
        (c.auto ? ' · automático' : '');
      return '<div class="pl-comment' + (c.auto ? ' auto' : '') + '">' +
        '<div class="pl-comment-meta">' + meta + '</div>' +
        '<div class="pl-comment-text">' + escapeHtml(c.text) + '</div>' +
      '</div>';
    }).join('');
  }

  function injectStyles() {
    if (document.getElementById('dl9-paros-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl9-paros-styles';
    s.textContent = [
      '.pl-fab-dock{position:fixed;bottom:24px;left:24px;z-index:99998;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none}',
      '.pl-fab-dock > *{pointer-events:auto}',
      '.pl-fab-ring{display:flex;align-items:center;justify-content:center;border-radius:50%;padding:10px;box-shadow:0 8px 24px rgba(220,38,38,0.55)}',
      '.pl-fab-dock.running .pl-fab-ring{background:repeating-linear-gradient(45deg,#dc2626 0 14px,#facc15 14px 28px);animation:plStripeScroll 1.4s linear infinite}',
      '.pl-fab{width:76px;height:76px;border-radius:50%;background:#dc2626;color:#fff;border:none;font-size:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease;box-shadow:0 2px 8px rgba(0,0,0,0.3) inset, 0 0 0 3px #0f172a}',
      '.pl-fab:not(.running):hover{transform:scale(1.08)}',
      '.pl-fab.running{animation:plIconPulse 0.95s ease-in-out infinite}',
      '@keyframes plIconPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}',
      '.pl-fab-timer-wrap{padding:5px;border-radius:12px;background:repeating-linear-gradient(45deg,#dc2626 0 10px,#facc15 10px 20px);animation:plStripeScroll 1.4s linear infinite;box-shadow:0 6px 18px rgba(0,0,0,0.55)}',
      '.pl-fab-timer{font-family:"SF Mono","Menlo","Consolas",monospace;font-variant-numeric:tabular-nums;font-size:22px;font-weight:800;color:#fef3c7;background:#0f172a;border-radius:8px;padding:8px 16px;letter-spacing:1.5px;white-space:nowrap;text-align:center;line-height:1}',
      '@media (prefers-reduced-motion:reduce){.pl-fab.running,.pl-fab-dock.running .pl-fab-ring,.pl-fab-timer-wrap{animation:none}}',
      '.pl-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.pl-modal{background:#1e293b;color:#f1f5f9;border-radius:18px;padding:32px 36px;width:620px;max-width:94vw;max-height:94vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);box-sizing:border-box}',
      '.pl-modal.running{width:840px;text-align:center}',
      '.pl-modal h2{margin:0 0 18px;font-size:26px;color:#fecaca}',
      '.pl-row{margin-bottom:16px}',
      '.pl-label{font-size:12px;color:#94a3b8;display:block;margin-bottom:6px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}',
      '.pl-select,.pl-input,.pl-textarea{width:100%;padding:12px 14px;border-radius:9px;border:1px solid #475569;background:#0f172a;color:#f1f5f9;font-size:16px;box-sizing:border-box}',
      '.pl-select:disabled{opacity:.6}',
      '.pl-textarea{min-height:68px;resize:vertical;font-family:inherit}',
      '.pl-btnrow{display:flex;gap:12px;justify-content:flex-end;margin-top:24px;flex-wrap:wrap}',
      '.pl-btn{padding:14px 26px;border:none;border-radius:9px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:.3px}',
      '.pl-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.pl-btn-cancel{background:#475569;color:#f1f5f9}',
      '.pl-btn-primary{background:#dc2626;color:#fff}',
      '.pl-btn-ghost{background:transparent;color:#cbd5e1;border:1px solid #475569}',
      '.pl-btn-stop{background:#dc2626;color:#fff;font-size:24px;padding:22px 0;width:100%;margin-top:20px}',
      '.pl-btn-stop:hover{background:#b91c1c}',
      '.pl-cone{font-size:112px;line-height:1;margin-bottom:6px}',
      '.pl-title{font-size:32px;font-weight:800;color:#fecaca;letter-spacing:1.5px;margin:8px 0}',
      '.pl-timer{font-size:88px;font-family:"SF Mono","Menlo","Consolas",monospace;font-variant-numeric:tabular-nums;color:#fef3c7;margin:10px 0 22px}',
      '.pl-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;text-align:left;margin-top:14px}',
      '.pl-static{background:#0f172a;border:1px solid #334155;border-radius:9px;padding:12px 14px;font-size:16px}',
      '.pl-static strong{display:block;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px;font-weight:700}',
      '.pl-comment-row{display:flex;gap:10px;margin-top:16px;align-items:flex-start}',
      '.pl-comment-row .pl-textarea{flex:1;min-height:56px}',
      '.pl-comments{margin-top:14px;text-align:left;background:#0f172a;border:1px solid #334155;border-radius:10px;padding:10px 12px;max-height:220px;overflow-y:auto}',
      '.pl-comments-title{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:8px}',
      '.pl-comments-empty{font-size:13px;color:#64748b;font-style:italic;padding:4px 0}',
      '.pl-comment{padding:8px 10px;background:#1e293b;border-left:3px solid #60a5fa;border-radius:6px;margin-bottom:6px;font-size:14px;line-height:1.35}',
      '.pl-comment.auto{border-left-color:#a78bfa;opacity:.9}',
      '.pl-comment .pl-comment-meta{font-size:11px;color:#94a3b8;margin-bottom:3px}',
      '.pl-comment .pl-comment-text{color:#f1f5f9;white-space:pre-wrap;word-break:break-word}',
      '.pl-summary{text-align:center;background:#0f172a;border-radius:14px;padding:26px;margin:10px 0}',
      '.pl-summary .pl-big{font-size:50px;font-family:"SF Mono","Menlo","Consolas",monospace;color:#86efac;margin:8px 0}',
      '.pl-dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;text-align:left;margin-top:14px;font-size:15px}',
      '.pl-dl dt{color:#94a3b8}',
      '.pl-dl dd{margin:0;color:#f1f5f9}',
      '.pl-error{color:#fecaca;background:#7f1d1d;padding:12px 14px;border-radius:9px;margin-bottom:14px;font-size:15px}',
      '.pl-loading{text-align:center;padding:22px;color:#94a3b8;font-size:15px}',
      '.pl-striped-frame{padding:26px;border-radius:28px;background:repeating-linear-gradient(45deg,#dc2626 0 22px,#facc15 22px 44px);background-size:200% 200%;box-shadow:0 25px 70px rgba(0,0,0,0.7);max-width:96vw;max-height:96vh;box-sizing:border-box;display:flex;animation:plStripeScroll 1.4s linear infinite}',
      '.pl-striped-frame > .pl-modal.running{box-shadow:none;max-width:100%;max-height:calc(96vh - 52px)}',
      '@keyframes plStripeScroll{0%{background-position:0 0}100%{background-position:62.23px 0}}',
      '@media (prefers-reduced-motion:reduce){.pl-striped-frame{animation:none}}'
    ].join('');
    document.head.appendChild(s);
  }

  function renderFloatingButton() {
    const existing = document.getElementById('sa-pl-fab-dock');
    if (existing) existing.remove();
    stopFabTimer();

    const running = !!state.activeEvent;
    const dock = document.createElement('div');
    dock.className = 'pl-fab-dock' + (running ? ' running' : '');
    dock.id = 'sa-pl-fab-dock';

    const ring = document.createElement('div');
    ring.className = 'pl-fab-ring';

    const btn = document.createElement('button');
    btn.className = 'pl-fab' + (running ? ' running' : '');
    btn.id = 'sa-pl-fab';
    btn.setAttribute('aria-label', 'Paro de Línea');
    btn.title = running ? 'Paro de Línea en curso — click para ver' : 'Registrar Paro de Línea';
    btn.textContent = '⚠️';
    btn.addEventListener('click', () => {
      if (state.activeEvent) renderRunningView();
      else openStopDialog();
    });
    ring.appendChild(btn);
    dock.appendChild(ring);

    if (running) {
      const wrap = document.createElement('div');
      wrap.className = 'pl-fab-timer-wrap';
      const chip = document.createElement('div');
      chip.className = 'pl-fab-timer';
      chip.id = 'sa-pl-fab-timer';
      chip.textContent = formatElapsed(Date.now() - state.activeEvent.createdAt);
      wrap.appendChild(chip);
      dock.appendChild(wrap);
    }

    document.body.appendChild(dock);
    state.floatingBtn = btn;

    if (running) startFabTimer();
  }

  function updateFabStyle() {
    const should = isAllowedPath() || !!state.activeEvent;
    const existing = document.getElementById('sa-pl-fab-dock');
    if (existing) existing.remove();
    stopFabTimer();
    state.floatingBtn = null;
    if (should) renderFloatingButton();
  }

  function startFabTimer() {
    stopFabTimer();
    const tick = () => {
      const chip = document.getElementById('sa-pl-fab-timer');
      if (!chip || !state.activeEvent) { stopFabTimer(); return; }
      chip.textContent = formatElapsed(Date.now() - state.activeEvent.createdAt);
    };
    tick();
    state.fabTimerInterval = setInterval(tick, 1000);
  }

  function stopFabTimer() {
    if (state.fabTimerInterval) {
      clearInterval(state.fabTimerInterval);
      state.fabTimerInterval = null;
    }
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
    if (wide) {
      const frame = document.createElement('div');
      frame.className = 'pl-striped-frame';
      frame.appendChild(modal);
      ov.appendChild(frame);
    } else {
      ov.appendChild(modal);
    }
    document.body.appendChild(ov);
    return ov;
  }

  function areaForNode(node) {
    const m = (node?.name || '').match(/\bPL([A-Z])\b/);
    const code = m ? 'PL' + m[1] : '';
    return RESPONSABLE_AREAS[code] || { label: code || 'Otros', icon: DEFAULT_AREA_ICON };
  }

  function buildResponsableOptions(paroNodes) {
    const items = paroNodes.map(n => {
      const area = areaForNode(n);
      const suffix = (n.name || '')
        .replace(/paro\s+de\s+l[ií]nea\s*/gi, '')
        .replace(/PL[A-Z]\s*[\-:]?\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const sameAsArea = suffix && normalizeEs(suffix) === normalizeEs(area.label);
      const label = (suffix && !sameAsArea) ? area.label + ' — ' + suffix : area.label;
      return { id: n.id, name: n.name, area, display: area.icon + ' ' + label, sortKey: area.label + ' ' + suffix };
    });
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'es'));
    return items;
  }

  function extractLabelMeta(rawLabel) {
    if (!rawLabel || typeof rawLabel !== 'object') return { ids: [], names: [] };
    const ids = [];
    const names = [];
    const candidates = [rawLabel, rawLabel.labelByLabelId, rawLabel.label];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      if (typeof c.id === 'number' || typeof c.id === 'string') ids.push(c.id);
      if (typeof c.name === 'string') names.push(c.name);
    }
    if (rawLabel.labelId != null) ids.push(rawLabel.labelId);
    if (typeof rawLabel.labelName === 'string') names.push(rawLabel.labelName);
    return { ids, names };
  }

  async function fetchLineLabelIds() {
    const conditions = [{ forEquipment: true }, {}];
    for (const condition of conditions) {
      try {
        const data = await api().query('AllLabels', { condition }, 'AllLabels');
        const nodes = data?.allLabels?.nodes || [];
        const matched = nodes.filter(l =>
          typeof l?.name === 'string' && LINE_LABEL_RE.test(l.name.trim())
        );
        const ids = matched.map(l => l.id).filter(id => id != null);
        if (nodes.length > 0) {
          if (matched.length === 0) {
            console.warn('[SA] ParosLinea: AllLabels devolvió ' + nodes.length +
              ' etiquetas pero ninguna coincide con Líneas/Células — ejemplos:',
              nodes.slice(0, 12).map(l => l?.name).join(' | '));
          } else {
            console.log('[SA] ParosLinea: etiquetas objetivo encontradas:',
              matched.map(l => l.name + '(' + l.id + ')').join(', '));
          }
          return new Set(ids);
        }
      } catch (e) {
        console.warn('[SA] ParosLinea AllLabels (' + JSON.stringify(condition) + '):', e.message);
      }
    }
    return new Set();
  }

  function readCachedLineEquipments() {
    try {
      const raw = localStorage.getItem(EQUIP_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.equipments)) return null;
      if (Date.now() - (obj.savedAt || 0) > EQUIP_CACHE_TTL_MS) return null;
      return obj.equipments;
    } catch { return null; }
  }
  function writeCachedLineEquipments(equipments) {
    try {
      localStorage.setItem(EQUIP_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(), equipments
      }));
    } catch (_) {}
  }
  function clearCachedLineEquipments() {
    try { localStorage.removeItem(EQUIP_CACHE_KEY); } catch (_) {}
  }

  async function fetchAllLineEquipments(targetLabelIds, onProgress) {
    const PAGE = 500;
    const matchByLine = (e) => {
      const labels = e?.equipmentLabelsByEquipmentId?.nodes || [];
      for (const l of labels) {
        const meta = extractLabelMeta(l);
        if (targetLabelIds.size && meta.ids.some(id => targetLabelIds.has(id))) return true;
        if (meta.names.some(n => LINE_LABEL_RE.test(String(n).trim()))) return true;
      }
      return false;
    };

    const matched = [];
    let offset = 0;
    let total = null;
    let scanned = 0;
    let safety = 0;
    while (safety++ < 20) {
      const data = await api().query('AllEquipments', {
        fetchEquipmentType: false,
        fetchStation: false,
        fetchLabel: true,
        fetchLocation: false,
        endOfService: true,
        orderBy: ['NAME_ASC'],
        offset,
        first: PAGE,
        searchQuery: ''
      }, 'AllEquipments');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) total = data?.pagedData?.totalCount ?? null;
      scanned += nodes.length;
      for (const n of nodes) {
        if (matchByLine(n)) matched.push({ id: n.id, name: n.name, idInDomain: n.idInDomain });
      }
      if (typeof onProgress === 'function') onProgress(scanned, total, matched.length);
      if (nodes.length < PAGE) break;
      if (total != null && scanned >= total) break;
      offset += PAGE;
    }
    return { matched, scanned, total };
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
    state.responsableOptions = buildResponsableOptions(paroNodes);

    if (!force) {
      const cached = readCachedLineEquipments();
      if (cached && cached.length > 0) {
        state.allEquipments = cached;
        console.log('[SA] ParosLinea: ' + cached.length + ' líneas/células desde caché');
        state.catalogsLoaded = true;
        return;
      }
    }

    const targetLabelIds = await fetchLineLabelIds();
    const onProgress = (scanned, total, found) => {
      const el = document.getElementById('pl-pre-content');
      if (el && el.classList.contains('pl-loading')) {
        el.textContent = 'Cargando catálogo de equipos… ' + scanned +
          (total ? '/' + total : '') + ' (líneas/células: ' + found + ')';
      }
    };
    const { matched, scanned, total } = await fetchAllLineEquipments(targetLabelIds, onProgress);
    console.log('[SA] ParosLinea: ' + matched.length + ' equipos con etiqueta Líneas/Células (de ' + scanned + (total ? '/' + total : '') + ')');

    if (matched.length === 0) {
      throw new Error('No se encontraron equipos con etiqueta "Línea" o "Célula". Revisa que estén etiquetados en Steelhead.');
    }
    state.allEquipments = matched;
    writeCachedLineEquipments(matched);
    state.catalogsLoaded = true;
  }

  async function inferLinePrefix() {
    const wbMatch = location.pathname.match(/\/Workboards\/(\d+)/);
    if (wbMatch) {
      try {
        const data = await api().query('WorkboardById',
          { id: parseInt(wbMatch[1], 10) }, 'WorkboardById');
        const name = data?.workboardById?.name;
        if (name) {
          try { localStorage.setItem(LAST_LINE_KEY, name); } catch (_) {}
          console.log('[SA] ParosLinea: workboard activo =', name);
          return name;
        }
      } catch (e) {
        console.warn('[SA] ParosLinea: WorkboardById falló:', e.message);
      }
    }
    const headings = document.querySelectorAll('h1, h2, h3, [class*="breadcrumb"], [class*="Breadcrumb"], [class*="page-title"], [class*="PageTitle"]');
    for (const h of headings) {
      const txt = h.textContent || '';
      const m = txt.match(/\b(T\d{2,3}[A-Z\-]*)\b/);
      if (m) return m[1];
    }
    try { return localStorage.getItem(LAST_LINE_KEY); } catch { return null; }
  }

  function matchEquipmentByPrefix(prefix) {
    if (!prefix || !state.allEquipments.length) return null;
    const p = prefix.toUpperCase();
    let match = state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(p));
    if (match) return match;
    const tokenMatch = p.match(/^(T\d{2,3})/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      match = state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(token))
        || state.allEquipments.find(e => (e.name || '').toUpperCase().includes(token));
      if (match) return match;
    }
    return state.allEquipments.find(e => (e.name || '').toUpperCase().includes(p)) || null;
  }

  function responsableLabelFromNodeName(name) {
    const area = areaForNode({ name });
    return area.icon + ' ' + area.label;
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

    const responsableOptionsHtml = (state.responsableOptions || [])
      .map(o => '<option value="' + o.id + '">' + escapeHtml(o.display) + '</option>')
      .join('');

    const linePrefix = await inferLinePrefix();
    const defaultEq = matchEquipmentByPrefix(linePrefix);
    const equipmentOptions = state.allEquipments
      .map(e => '<option value="' + e.id + '"' + (defaultEq && defaultEq.id === e.id ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>')
      .join('');

    document.getElementById('pl-pre-content').innerHTML =
      '<div class="pl-row">' +
        '<label class="pl-label">Responsable (categoría)</label>' +
        '<select class="pl-select" id="pl-node-select"><option value="">— Selecciona —</option>' + responsableOptionsHtml + '</select>' +
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
          selectedSensorId: sensorId,
          comments: []
        };
        state.selectedSensorId = sensorId;
        writeActiveEvent(state.activeEvent);

        if (comment) {
          try {
            await api().query('CreateMaintenanceEventComment',
              { comment, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
            pushComment(state.activeEvent, { text: comment });
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
      '<div class="pl-comments">' +
        '<div class="pl-comments-title">Historial de comentarios</div>' +
        '<div id="pl-comments-list"></div>' +
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

    renderCommentsList();

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
        const autoText = 'Línea cambiada de "' + prevEqName + '" a "' + (newEq?.name || newEqId) + '" por el operador.';
        try {
          await api().query('CreateMaintenanceEventComment', {
            comment: autoText, maintenanceEventId: ev.id
          }, 'CreateMaintenanceEventComment');
          pushComment(ev, { text: autoText, auto: true });
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
        pushComment(ev, { text: txt });
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
        pushComment(ev, { text: finalComment });
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
