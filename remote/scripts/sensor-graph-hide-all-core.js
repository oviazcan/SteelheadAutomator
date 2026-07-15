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

  // ── Fase 2: combo para aislar UN sensor ────────────────────────────────────
  // Normaliza nombres de sensor para hacer match robusto entre la respuesta de
  // SensorDashboardQuery y el texto del DOM (los nombres traen espacios de más:
  // p.ej. " T203-TI00-011 Concentración  de Plata Metálica").
  function normalizeName(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Solo sensores NUMBER (excluye BOOLEAN/TEXT — no tienen sentido en la gráfica
  // de línea). `sensors`: [{ name, station, measurementType }].
  function filterNumericSensors(sensors) {
    return (sensors || []).filter(function (s) { return s && s.measurementType === 'NUMBER'; });
  }

  // Colapsa espacios (los nombres del API traen espacios de más / iniciales)
  // PRESERVANDO el casing — a diferencia de normalizeName, esto es para mostrar.
  function collapseSpaces(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  // Cola de la ESTACIÓN sin el prefijo de tokens que ya comparte con el NOMBRE del
  // sensor (típicamente el código, p.ej. "T203-TI00-011"), para no repetirlo en la
  // etiqueta. Compara token a token, case-insensitive, y devuelve el resto de la
  // estación con su casing original. `name`/`station` ya vienen con espacios colapsados.
  function stationTail(name, station) {
    const nameToks = name ? name.split(' ') : [];
    const stToks = station ? station.split(' ') : [];
    let i = 0;
    while (i < nameToks.length && i < stToks.length &&
      nameToks[i].toLowerCase() === stToks[i].toLowerCase()) i++;
    return stToks.slice(i).join(' ').trim();
  }

  // Etiqueta legible para el combo: el NOMBRE del sensor y, entre paréntesis, la
  // ESTACIÓN — quitándole el prefijo (código) que ya aparece en el nombre para no
  // duplicarlo. Ej.: name="T203-TI00-011 Concentración de Plata Metálica",
  // station="T203-TI00-011 Plata Silvrex (B-1)"
  //   → "T203-TI00-011 Concentración de Plata Metálica (Plata Silvrex (B-1))".
  // Fallbacks: sin estación → solo el nombre; sin nombre → la estación; nada → "(sensor)".
  function sensorLabel(sensor) {
    if (!sensor) return '';
    const name = collapseSpaces(sensor.name);
    const station = collapseSpaces(sensor.station);
    if (!name) return station || '(sensor)';
    if (!station) return name;
    const tail = stationTail(name, station);
    return tail ? name + ' (' + tail + ')' : name;
  }

  // Deriva el valor que debe mostrar el combo a partir del estado real de los
  // ojitos (para sincronizar los combos entre sí y con toggles manuales).
  //   0 visibles → 'NONE' · todos visibles → 'ALL' · exactamente 1 (numérico) → su nombre
  //   cualquier otra mezcla → '' (placeholder)
  // Nombres YA normalizados. `numericNames` = set de nombres numéricos (normalizados).
  function deriveComboValue(state) {
    const vis = state.visibleNames || [];
    const all = state.allNames || [];
    const num = state.numericNames || [];
    if (all.length === 0) return '';
    if (vis.length === 0) return 'NONE';
    if (vis.length === all.length) return 'ALL';
    if (vis.length === 1 && num.indexOf(vis[0]) !== -1) return vis[0];
    return '';
  }

  // Parsea la respuesta de SensorDashboardQuery → [{ name, station, measurementType }].
  // Shape (confirmado en scan 2026-07-07): data.sensorDashboardByIdInDomain
  //   .sensorDashboardMembersBySensorDashboardId.nodes[].sensorBySensorId
  //   { name, sensorTypeBySensorTypeId.sensorMeasurementType, stationByStationId.name }.
  // Devuelve null si el shape no matchea (fail-safe → el combo queda en "cargando…").
  function parseSensorDashboard(json) {
    const root = json && json.data && json.data.sensorDashboardByIdInDomain;
    if (!root) return null;
    const conn = root.sensorDashboardMembersBySensorDashboardId;
    const nodes = (conn && conn.nodes) || [];
    const list = [];
    nodes.forEach(function (m) {
      const s = m && m.sensorBySensorId; if (!s) return;
      const st = s.sensorTypeBySensorTypeId || {};
      const station = s.stationByStationId || {};
      list.push({ name: s.name, station: station.name, measurementType: st.sensorMeasurementType });
    });
    return list;
  }

  // Plan de aislamiento: qué ojitos mostrar y cuáles esconder para una selección.
  //   target: 'ALL' | 'NONE' | nombre-normalizado. `allNames` = todos los nombres (normalizados).
  function planIsolation(target, allNames) {
    const all = allNames || [];
    if (target === 'ALL') return { show: all.slice(), hide: [] };
    if (target === 'NONE' || !target) return { show: [], hide: all.slice() };
    return {
      show: all.filter(function (n) { return n === target; }),
      hide: all.filter(function (n) { return n !== target; }),
    };
  }

  const api = {
    DASHBOARD_URL_RE,
    parseDashboardId,
    isDashboardPath,
    nextHideStep,
    normalizeName,
    filterNumericSensors,
    collapseSpaces,
    stationTail,
    sensorLabel,
    deriveComboValue,
    planIsolation,
    parseSensorDashboard,
  };
  if (typeof window !== 'undefined') window.SensorGraphHideAllCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
