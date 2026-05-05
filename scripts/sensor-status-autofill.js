// Steelhead Sensor Status Autofill
// Auto-asigna SpecFieldParam ("Use for Status") a members de Sensor Dashboards.
// Scope: dashboard actual (default) o todos los del domain (toggle).
// Depends on: SteelheadAPI + window.REMOTE_CONFIG

const SensorStatusAutofill = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api().log(`[sensor-status] ${m}`);
  const warn = (m) => api().warn(`[sensor-status] ${m}`);

  // URL pattern del dashboard: /sensor-dashboards/<idInDomain>
  // Confirmar en implementación con la URL real del browser.
  const DASHBOARD_URL_RE = /\/sensor-dashboards\/(\d+)(?:[/?#]|$)/i;

  let state = {
    running: false,
    cancelled: false,
  };

  // ── Styles ──
  function injectStyles() {
    if (document.getElementById('sa-sensor-status-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-sensor-status-styles';
    style.textContent = `
      .sa-sst-fab { position: fixed; bottom: 24px; right: 24px; z-index: 999999;
        background: linear-gradient(135deg,#7c3aed,#5b21b6); color: #fff;
        border: none; border-radius: 999px; padding: 12px 18px; font-size: 13px;
        font-weight: 700; cursor: pointer; box-shadow: 0 6px 18px rgba(124,58,237,0.45);
        font-family: system-ui,-apple-system,sans-serif; display: flex; align-items: center; gap: 8px; }
      .sa-sst-fab:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(124,58,237,0.55); }
      .sa-sst-fab[disabled] { opacity: 0.6; cursor: not-allowed; }

      .sa-sst-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 1000000;
        display: flex; align-items: center; justify-content: center; font-family: system-ui,-apple-system,sans-serif; }
      .sa-sst-modal { background: #1a1a2e; color: #e2e8f0; border-radius: 12px; padding: 24px;
        min-width: 460px; max-width: 720px; box-shadow: 0 20px 60px rgba(0,0,0,0.6); }
      .sa-sst-modal h2 { margin: 0 0 12px 0; font-size: 17px; }
      .sa-sst-btnrow { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
      .sa-sst-btn { padding: 9px 18px; border-radius: 7px; border: none; font-weight: 700;
        font-size: 13px; cursor: pointer; }
      .sa-sst-btn-cancel { background: #475569; color: #f8fafc; }
      .sa-sst-btn-exec { background: #7c3aed; color: #fff; }
      .sa-sst-btn-exec[disabled] { background: #4c1d95; opacity: 0.5; cursor: not-allowed; }
      .sa-sst-progress { background: #0f172a; border-radius: 8px; padding: 14px; margin: 12px 0; }
      .sa-sst-bar { height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden; margin-top: 8px; }
      .sa-sst-bar > div { height: 100%; background: linear-gradient(90deg,#7c3aed,#a78bfa); transition: width 0.2s; }
    `;
    document.head.appendChild(style);
  }

  // ── URL parsing ──
  function parseSensorDashboardFromURL() {
    const m = window.location.href.match(DASHBOARD_URL_RE);
    if (!m) return null;
    return { idInDomain: parseInt(m[1], 10) };
  }

  // ── HTML escape ──
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ── API: fetch a single dashboard ──
  async function fetchDashboard(idInDomain) {
    // El persisted query exige 4 vars (after/before/measurementType filtran
    // mediciones, no el arbol de candidatos). Defaults: ultimos 30 dias, NUMBER.
    const now = new Date();
    const before = now.toISOString();
    const after = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const data = await api().query('SensorDashboardQuery', {
      idInDomain, after, before, measurementType: 'NUMBER'
    }, 'SensorDashboardQuery');
    const dash = data?.sensorDashboardByIdInDomain;
    if (!dash) throw new Error(`Dashboard ${idInDomain} no encontrado`);
    return dash;
  }

  // ── API: update one member (assign activeSpecFieldParamId) ──
  async function updateMember(memberId, activeSpecFieldParamId) {
    return await api().query('UpdateSensorDashboardMember', {
      id: memberId,
      activeSpecFieldParamId
    }, 'UpdateSensorDashboardMember');
  }

  // ── API: list all sensor dashboards (single call, no pagination) ──
  async function fetchAllSensorDashboards() {
    const data = await api().query('AllSensorDashboards', {}, 'AllSensorDashboards');
    const nodes = data?.allSensorDashboards?.nodes || [];
    return nodes.map(n => ({
      id: n.id,
      idInDomain: n.idInDomain,
      name: n.name || `#${n.idInDomain || n.id}`,
    }));
  }

  // ── Classifier: extrae candidatos y clasifica cada member ──
  function extractCandidates(member) {
    const sensor = member?.sensorBySensorId;
    const specFields = sensor?.sensorTypeBySensorTypeId?.specFieldsBySensorTypeId?.nodes || [];
    const candidates = [];
    for (const sf of specFields) {
      const sfsList = sf?.specFieldSpecsBySpecFieldId?.nodes || [];
      for (const sfs of sfsList) {
        const params = sfs?.specFieldParamsBySpecFieldSpecId?.nodes || [];
        for (const p of params) {
          candidates.push({
            id: p.id,
            name: p.name || `#${p.id}`,
            min: p.minimumValue ?? null,
            max: p.maximumValue ?? null,
            target: p.targetValue ?? null,
            specName: sfs?.specBySpecId?.name || '',
            specRevision: sfs?.specBySpecId?.revisionName || '',
            specFieldName: sfs?.specFieldBySpecFieldId?.name || sf?.specFieldBySpecFieldId?.name || '',
          });
        }
      }
    }
    return candidates;
  }

  function classifyMembers(dashboard) {
    const members = dashboard?.sensorDashboardMembersBySensorDashboardId?.nodes || [];
    const classified = members.map(m => {
      const candidates = extractCandidates(m);
      const activeId = m?.specFieldParamByActiveSpecFieldParamId?.id ?? null;
      let stateName;
      if (activeId != null) stateName = 'already';
      else if (candidates.length === 0) stateName = 'zero';
      else if (candidates.length === 1) stateName = 'auto';
      else stateName = 'multi';
      return {
        memberId: m.id,
        sensorName: m?.sensorBySensorId?.name || `#${m.id}`,
        state: stateName,
        candidates,
        activeId,
      };
    });
    return {
      already: classified.filter(c => c.state === 'already'),
      zero:    classified.filter(c => c.state === 'zero'),
      auto:    classified.filter(c => c.state === 'auto'),
      multi:   classified.filter(c => c.state === 'multi'),
    };
  }

  // ── Modal Fase 0: scope selection ──
  function showScopeModal({ currentRef, currentName }) {
    return new Promise((resolve) => {
      injectStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-sst-overlay';
      const md = document.createElement('div');
      md.className = 'sa-sst-modal';

      const currentLabel = currentRef
        ? `Solo este dashboard${currentName ? ` — ${escapeHtml(currentName)}` : ''}`
        : 'Solo este dashboard (no detectado en la URL)';

      md.innerHTML = `
        <h2 style="color:#a78bfa">📊 Auto-asignar status</h2>
        <p style="font-size:12px;color:#94a3b8;margin:0 0 14px 0">Marca "Use for Status" en members con un único candidato. Para members con varios candidatos abrirá un modal para que tú elijas.</p>

        <div style="margin-bottom:14px">
          <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;padding:10px 12px;background:#0f172a;border-radius:8px;${currentRef ? 'cursor:pointer' : 'opacity:0.5;cursor:not-allowed'}">
            <input type="radio" name="sa-sst-scope" value="current" ${currentRef ? 'checked' : 'disabled'}>
            <div>
              <div style="font-weight:600;color:#e2e8f0">${currentLabel}</div>
              <div style="font-size:11px;color:#94a3b8">Procesa solo el dashboard abierto.</div>
            </div>
          </label>
        </div>

        <div style="margin-bottom:14px">
          <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;padding:10px 12px;background:#0f172a;border-radius:8px;cursor:pointer">
            <input type="checkbox" id="sa-sst-allcheck">
            <div>
              <div style="font-weight:600;color:#fbbf24">Procesar TODOS los dashboards del domain</div>
              <div style="font-size:11px;color:#94a3b8">Puede tardar varios minutos. Off por default.</div>
            </div>
          </label>
        </div>

        <div class="sa-sst-btnrow">
          <button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-cancel">CANCELAR</button>
          <button class="sa-sst-btn sa-sst-btn-exec" id="sa-sst-start">INICIAR</button>
        </div>
      `;

      ov.appendChild(md);
      document.body.appendChild(ov);

      const startBtn = md.querySelector('#sa-sst-start');
      const allCheck = md.querySelector('#sa-sst-allcheck');
      const radioCurrent = md.querySelector('input[name="sa-sst-scope"]');

      const refresh = () => {
        const isAll = allCheck.checked;
        const canStart = isAll || (radioCurrent && radioCurrent.checked && !!currentRef);
        startBtn.disabled = !canStart;
      };
      allCheck.addEventListener('change', refresh);
      if (radioCurrent) radioCurrent.addEventListener('change', refresh);
      refresh();

      md.querySelector('#sa-sst-cancel').addEventListener('click', () => {
        ov.remove();
        resolve({ cancelled: true });
      });
      startBtn.addEventListener('click', () => {
        const isAll = allCheck.checked;
        ov.remove();
        if (isAll) resolve({ scope: 'all' });
        else resolve({ scope: 'current', idInDomain: currentRef.idInDomain });
      });
    });
  }

  // ── Progress UI ──
  function showProgressUI(title, subtitle) {
    removeUI();
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-sst-overlay';
    ov.id = 'sa-sst-progress-overlay';
    const md = document.createElement('div');
    md.className = 'sa-sst-modal';
    md.innerHTML = `
      <h2 style="color:#a78bfa" id="sa-sst-progress-title">${escapeHtml(title)}</h2>
      <div class="sa-sst-progress">
        <div id="sa-sst-progress-msg" style="font-size:13px;color:#cbd5e1">${escapeHtml(subtitle || '')}</div>
        <div id="sa-sst-progress-sub" style="font-size:11px;color:#94a3b8;margin-top:4px"></div>
        <div class="sa-sst-bar"><div id="sa-sst-progress-bar" style="width:0%"></div></div>
      </div>
      <div class="sa-sst-btnrow">
        <button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-stop">DETENER</button>
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);
    md.querySelector('#sa-sst-stop').addEventListener('click', () => {
      state.cancelled = true;
      md.querySelector('#sa-sst-stop').disabled = true;
      md.querySelector('#sa-sst-stop').textContent = 'DETENIENDO…';
    });
  }

  function updateProgress({ title, msg, sub, pct }) {
    const t = document.getElementById('sa-sst-progress-title');
    const m = document.getElementById('sa-sst-progress-msg');
    const s = document.getElementById('sa-sst-progress-sub');
    const b = document.getElementById('sa-sst-progress-bar');
    if (t && title != null) t.textContent = title;
    if (m && msg != null) m.textContent = msg;
    if (s && sub != null) s.textContent = sub;
    if (b && pct != null) b.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function removeUI() {
    const ov = document.getElementById('sa-sst-progress-overlay');
    if (ov) ov.remove();
  }

  // ── Modal asistido para members con ≥2 candidatos ──
  function showCandidatesModal({ member, dashboardName, mode }) {
    return new Promise((resolve) => {
      injectStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-sst-overlay';
      const md = document.createElement('div');
      md.className = 'sa-sst-modal';
      md.style.maxWidth = '720px';

      const radios = member.candidates.map((c, i) => {
        const range = (c.min != null || c.max != null)
          ? `${c.min ?? ''} – ${c.max ?? ''}`
          : (c.target != null ? `target ${c.target}` : '');
        const specSuffix = [c.specName, c.specRevision].filter(Boolean).join(' · ');
        return `
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;padding:8px 10px;background:#0f172a;border-radius:6px;margin-bottom:6px;cursor:pointer">
            <input type="radio" name="sa-sst-cand" value="${c.id}" ${i === 0 ? 'checked' : ''}>
            <div>
              <div style="color:#e2e8f0;font-weight:600">${escapeHtml(c.name)}${range ? ` <span style="color:#94a3b8;font-weight:400;font-size:11px">(${escapeHtml(range)})</span>` : ''}</div>
              ${specSuffix ? `<div style="font-size:11px;color:#94a3b8">${escapeHtml(specSuffix)}</div>` : ''}
            </div>
          </label>
        `;
      }).join('');

      const skipDashboardBtn = mode === 'all'
        ? `<button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-skip-dash" style="background:#78350f;color:#fbbf24">SALTAR RESTO DE ESTE DASHBOARD</button>`
        : '';

      md.innerHTML = `
        <h2 style="color:#fbbf24">🔧 ${escapeHtml(member.sensorName)}</h2>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:12px">Dashboard: ${escapeHtml(dashboardName || '')} · ${member.candidates.length} candidatos</div>
        <div>${radios}</div>
        <div class="sa-sst-btnrow" style="justify-content:space-between">
          <div>${skipDashboardBtn}</div>
          <div style="display:flex;gap:10px">
            <button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-skip-member">SALTAR ESTE MEMBER</button>
            <button class="sa-sst-btn sa-sst-btn-exec" id="sa-sst-assign">ASIGNAR</button>
          </div>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#sa-sst-skip-member').addEventListener('click', () => {
        ov.remove();
        resolve({ action: 'skip-member' });
      });
      const skipDash = md.querySelector('#sa-sst-skip-dash');
      if (skipDash) skipDash.addEventListener('click', () => {
        ov.remove();
        resolve({ action: 'skip-dashboard' });
      });
      md.querySelector('#sa-sst-assign').addEventListener('click', () => {
        const sel = md.querySelector('input[name="sa-sst-cand"]:checked');
        if (!sel) { resolve({ action: 'skip-member' }); ov.remove(); return; }
        ov.remove();
        resolve({ action: 'assign', paramId: parseInt(sel.value, 10) });
      });
    });
  }

  // ── Resumen final ──
  function showSummary(results) {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-sst-overlay';
    const md = document.createElement('div');
    md.className = 'sa-sst-modal';

    const hasErrors = results.errors.length > 0;
    const icon = hasErrors ? '⚠️' : '✅';
    const iconColor = hasErrors ? '#f59e0b' : '#4ade80';

    let errorsHTML = '';
    if (hasErrors) {
      const items = results.errors.slice(0, 15)
        .map(e => `<div style="font-size:11px;color:#fca5a5;padding:1px 0">${escapeHtml(e)}</div>`)
        .join('');
      errorsHTML = `
        <div style="margin-top:12px">
          <div style="font-size:12px;color:#ef4444;font-weight:600;margin-bottom:4px">Errores (${results.errors.length}):</div>
          ${items}
        </div>`;
    }

    md.innerHTML = `
      <h2 style="color:${iconColor}">${icon} Resumen</h2>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#a78bfa">${results.dashboardsProcessed}</div>
          <div style="font-size:11px;color:#94a3b8">Dashboards</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#4ade80">${results.assigned}</div>
          <div style="font-size:11px;color:#94a3b8">Auto-asignados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#8b5cf6">${results.assisted}</div>
          <div style="font-size:11px;color:#94a3b8">Asistidos</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#64748b">${results.already}</div>
          <div style="font-size:11px;color:#94a3b8">Ya asignados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#f59e0b">${results.skipped}</div>
          <div style="font-size:11px;color:#94a3b8">Saltados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#fb7185">${results.zero}</div>
          <div style="font-size:11px;color:#94a3b8">Sin candidatos</div>
        </div>
      </div>
      ${errorsHTML}
      <div class="sa-sst-btnrow">
        <button class="sa-sst-btn sa-sst-btn-exec" id="sa-sst-close">CERRAR</button>
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);
    md.querySelector('#sa-sst-close').addEventListener('click', () => ov.remove());
  }

  // ── Init + FAB ──
  async function init() {
    if (window.__saSensorStatusInitDone) return;
    window.__saSensorStatusInitDone = true;
    log(`init (v${cfg()?.version || '?'})`);

    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
  }

  function syncFabVisibility() {
    const should = !!parseSensorDashboardFromURL();
    const existing = document.getElementById('sa-sst-fab-dock');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) existing.remove();
  }

  function installUrlChangeListener() {
    if (window.__saSensorStatusUrlListener) {
      window.addEventListener('sa-sst-urlchange', syncFabVisibility);
      return;
    }
    window.__saSensorStatusUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-sst-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-sst-urlchange', syncFabVisibility);
  }

  function renderFloatingButton() {
    const dock = document.createElement('div');
    dock.id = 'sa-sst-fab-dock';
    const btn = document.createElement('button');
    btn.className = 'sa-sst-fab';
    btn.innerHTML = '📊 Auto-asignar status';
    btn.addEventListener('click', () => run().catch(e => warn(`run() falló: ${e?.message || e}`)));
    dock.appendChild(btn);
    document.body.appendChild(dock);
  }

  async function run() {
    if (state.running) return { error: 'Ya hay una corrida en curso' };
    state.running = true;
    state.cancelled = false;
    try {
      // ─── Fase 0: scope ───
      const currentRef = parseSensorDashboardFromURL();
      let currentName = '';
      if (currentRef) {
        try {
          const dash = await fetchDashboard(currentRef.idInDomain);
          currentName = dash?.name || '';
        } catch (_) { /* nombre opcional, seguimos */ }
      }

      const choice = await showScopeModal({ currentRef, currentName });
      if (choice.cancelled) return { cancelled: true };

      // ─── Resolver dashboards a procesar ───
      let dashboards = [];
      if (choice.scope === 'current') {
        dashboards = [{ idInDomain: choice.idInDomain, name: currentName }];
      } else {
        showProgressUI('Listando dashboards', 'Cargando lista del domain…');
        try {
          const all = await fetchAllSensorDashboards();
          dashboards = all.map(d => ({ idInDomain: d.idInDomain, name: d.name }));
        } catch (e) {
          removeUI();
          return { error: String(e?.message || e) };
        }
      }

      if (!dashboards.length) {
        removeUI();
        return { error: 'No hay dashboards a procesar' };
      }

      // ─── Fase 1: procesar dashboards ───
      const results = {
        dashboardsProcessed: 0, assigned: 0, assisted: 0, already: 0,
        skipped: 0, zero: 0, errors: []
      };

      for (let di = 0; di < dashboards.length; di++) {
        if (state.cancelled) break;
        const d = dashboards[di];
        showProgressUI(
          `Dashboard ${di + 1} de ${dashboards.length}`,
          `${d.name || `#${d.idInDomain}`} — pull…`
        );

        let dashboard;
        try {
          dashboard = await fetchDashboard(d.idInDomain);
        } catch (e) {
          results.errors.push(`Dashboard ${d.name}: ${String(e?.message || e).substring(0, 200)}`);
          continue;
        }

        const groups = classifyMembers(dashboard);
        results.already += groups.already.length;
        results.zero    += groups.zero.length;

        // Auto-asignación
        for (let ai = 0; ai < groups.auto.length; ai++) {
          if (state.cancelled) break;
          const m = groups.auto[ai];
          updateProgress({
            title: `Dashboard ${di + 1} de ${dashboards.length}`,
            msg: `Auto-asignando ${ai + 1} de ${groups.auto.length}: ${m.sensorName}`,
            sub: d.name || '',
            pct: ((ai + 1) / Math.max(groups.auto.length, 1)) * 100
          });
          try {
            await updateMember(m.memberId, m.candidates[0].id);
            results.assigned++;
          } catch (e) {
            results.errors.push(`${m.sensorName}: ${String(e?.message || e).substring(0, 200)}`);
          }
        }
        if (state.cancelled) { removeUI(); break; }

        // Modales asistidos
        let skipRest = false;
        for (let mi = 0; mi < groups.multi.length; mi++) {
          if (state.cancelled || skipRest) break;
          const m = groups.multi[mi];
          removeUI();
          const decision = await showCandidatesModal({
            member: m, dashboardName: d.name, mode: choice.scope
          });
          if (decision.action === 'skip-member') { results.skipped++; continue; }
          if (decision.action === 'skip-dashboard') { skipRest = true; results.skipped += groups.multi.length - mi; break; }
          if (decision.action === 'assign') {
            try {
              await updateMember(m.memberId, decision.paramId);
              results.assisted++;
            } catch (e) {
              results.errors.push(`${m.sensorName}: ${String(e?.message || e).substring(0, 200)}`);
            }
          }
        }

        results.dashboardsProcessed++;
      }

      removeUI();
      log(`run() done: assigned=${results.assigned} assisted=${results.assisted} already=${results.already} zero=${results.zero} skipped=${results.skipped} errors=${results.errors.length}`);
      showSummary(results);
      return results;
    } finally {
      state.running = false;
    }
  }

  return { init, run };
})();

if (typeof window !== 'undefined') {
  window.SensorStatusAutofill = SensorStatusAutofill;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SensorStatusAutofill.init());
  } else {
    SensorStatusAutofill.init();
  }
}
