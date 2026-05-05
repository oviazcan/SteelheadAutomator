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
    log('run() llamado — orchestrator pendiente');
    return { error: 'Implementación pendiente (skeleton)' };
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
