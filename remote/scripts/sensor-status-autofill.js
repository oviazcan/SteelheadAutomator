// Steelhead Sensor Status Autofill
// Auto-asigna SpecFieldParam ("Use for Status") a members de Sensor Dashboards.
// Scope: dashboard actual (default) o todos los del domain (toggle).
// Depends on: SteelheadAPI + window.REMOTE_CONFIG

const SensorStatusAutofill = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api()?.log?.(`[sensor-status] ${m}`) ?? console.log(`[SA sensor-status] ${m}`);
  const warn = (m) => api()?.warn?.(`[sensor-status] ${m}`) ?? console.warn(`[SA sensor-status] ${m}`);

  // URL pattern del dashboard: /sensor-dashboards/<idInDomain>
  // Confirmar en implementación con la URL real del browser.
  const DASHBOARD_URL_RE = /\/sensor-dashboards\/(\d+)(?:[/?#]|$)/i;

  let state = {
    fabInstalled: false,
    running: false,
    cancelled: false,
  };

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

  // ── Public API placeholder ──
  async function init() {
    if (window.__saSensorStatusInitDone) return;
    window.__saSensorStatusInitDone = true;
    log(`init (v${cfg()?.version || '?'})`);
    // FAB / URL listener se cablea en Task 4
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
