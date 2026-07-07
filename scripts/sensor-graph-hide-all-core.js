// Auto-ocultar Sensores en la Gráfica — módulo puro (sin DOM ni red).
// Detección de la página de Sensor Dashboard + máquina de decisión "esconder-una-
// vez-por-entrada". Consumido por sensor-graph-hide-all.js (glue) y por los tests.
//
// Modelo (shapes confirmados en vivo 2026-07-07, dashboard /SensorDashboards/117):
//   · El ojito de cada sensor en "Current Values" togglea si el sensor se plotea en
//     la gráfica. Es PURO estado de React (0 mutaciones GraphQL) → se resetea a
//     "todos visibles" en cada carga. Por eso hace falta re-esconder al entrar.
//   · Botón visible  = <button aria-label="Hide this sensor in the graph.">  (svg VisibilityIcon)
//   · Botón oculto   = <button aria-label="Show this sensor in the graph.">  (svg VisibilityOffIcon)
//   · URL real: /Domains/<id>/Maintenance/SensorDashboards/<idInDomain>  (CamelCase).
//
// Contrato "una vez por entrada": se esconde todo al ENTRAR a un dashboard (cuando la
// tabla ya renderizó). Una vez latcheada la entrada, NO se vuelve a pelear con el
// operador: si destacha uno para verlo, o si le da Refresh Data, se respeta. Se
// re-arma solo al navegar a otra entrada (otro pathname).
(function () {
  'use strict';

  // URL de Sensor Dashboard. Acepta el slug con guión por si Steelhead lo rota
  // (lección sensor-status-autofill: el path es CamelCase, sin guión, hoy).
  const DASHBOARD_URL_RE = /\/sensor-?dashboards\/(\d+)(?:[/?#]|$)/i;

  function parseDashboardId(pathname) {
    if (typeof pathname !== 'string') return null;
    const m = pathname.match(DASHBOARD_URL_RE);
    return m ? m[1] : null;
  }

  function isDashboardPath(pathname) {
    return parseDashboardId(pathname) !== null;
  }

  // Máquina de decisión del poll de entrada. Devuelve el siguiente paso:
  //   'idle'  → no aplica (fuera de dashboard o desactivado): detener poll.
  //   'done'  → esta entrada ya fue latcheada: no tocar (respeta al operador).
  //   'wait'  → en dashboard, entrada nueva, tabla aún no renderiza: seguir esperando.
  //   'hide'  → hay sensores visibles y quedan intentos: clic para esconderlos.
  //   'latch' → ya no quedan visibles (o se agotaron intentos): registrar y detener.
  // s: { onDashboard, enabled, sameEntry, toggleCount, visibleCount, attempts, maxAttempts }
  function nextHideStep(s) {
    if (!s.onDashboard || !s.enabled) return 'idle';
    if (s.sameEntry) return 'done';
    if (!s.toggleCount) return 'wait';
    if (s.visibleCount > 0 && s.attempts < s.maxAttempts) return 'hide';
    return 'latch';
  }

  const api = {
    DASHBOARD_URL_RE,
    parseDashboardId,
    isDashboardPath,
    nextHideStep,
  };
  if (typeof window !== 'undefined') window.SensorGraphHideAllCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
