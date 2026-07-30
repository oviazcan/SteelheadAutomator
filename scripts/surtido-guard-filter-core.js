// Filtro por LÍNEA DESTINO del Candado de Surtido — módulo puro (sin DOM ni red).
// La "línea destino" es la línea de la estación donde la orden está PROGRAMADA, que en
// la tarjeta del Workboard vive en la tabla "Tareas Programadas:", celda td[1].
//
// POR QUÉ td[1] Y NO EL TEXTO DE LA TARJETA (medido en vivo 2026-07-29):
//   La tarjeta también dice "Proceso: T400 (ANT)-CU-VARIOS" mientras su estación destino
//   real es "T300-CE03-002". Sacar el código del textContent daría T400 ⇒ surtir material
//   para la línea EQUIVOCADA. El anclaje por posición de celda es obligatorio.
// Y NO td[0]: el tratamiento a veces no trae código ("TR-PRM-001 Antitarnish Manual").
//
// Este módulo es deliberadamente AJENO al candado: no conoce el flag de enforcement, ni la
// mutación de mover, ni la red. Esconder una tarjeta es puramente visual — el bloqueo vive
// en surtido-guard-core.js y opera sobre el payload. Ver surtido-guard-filter-isolation.test.js.
(function () {
  'use strict';

  // Código de línea: letra + 3 dígitos (T204, T300…). SIN anclar al inicio, porque la celda
  // empieza con el literal inglés "at " (la UI de SH mezcla idiomas). Es seguro no anclar
  // PORQUE el ámbito es una sola celda que solo contiene el nombre de la estación.
  const LINE_CODE_RE = /\b([A-Za-z]\d{3})\b/;

  function lineCodeFromStationText(text) {
    if (typeof text !== 'string' || text === '') return null;
    const m = text.match(LINE_CODE_RE);
    return m ? m[1].toUpperCase() : null;
  }

  // Filas de la tabla "Tareas Programadas:" → códigos de línea únicos, en orden de aparición.
  // Cada fila es [td0=tratamiento, td1=estación, td2=fecha]. Solo se lee td[1].
  // N filas ⇒ N líneas: una misma orden puede correr en varias líneas.
  function linesFromScheduledRows(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    const seen = Object.create(null);
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const code = lineCodeFromStationText(row[1]);
      if (!code || seen[code]) continue;
      seen[code] = true;
      out.push(code);
    }
    return out;
  }

  function asNodes(x) {
    if (x && Array.isArray(x.nodes)) return x.nodes;
    return Array.isArray(x) ? x : [];
  }

  // NOTA sobre los objetos-mapa de aquí abajo: se usan literales `{}` (no `Object.create(null)`)
  // porque los tests los comparan con deepStrictEqual, que también compara prototipos. Es seguro:
  // las claves son stationId NUMÉRICOS de la API o códigos de línea ya validados por LINE_CODE_RE
  // (letra + 3 dígitos), así que no puede entrar un `__proto__` desde el dato.

  // AllStations → { stationId: lineCode }. Las estaciones sin código de línea (p.ej. la
  // ubicación de almacén "Proquipa.N1.A1") quedan FUERA del índice a propósito: no son un
  // destino de producción, son dónde la pieza está PARADA (lo que filtra el nativo de SH).
  function buildStationLineIndex(input) {
    const root = (input && input.data) ? input.data : input;
    const map = {};
    for (const s of asNodes(root && root.allStations)) {
      if (!s || s.id == null) continue;
      const code = lineCodeFromStationText(s.name);
      if (code) map[s.id] = code;
    }
    return map;
  }

  // GetRelatedScheduleData + índice → conteo de ÓRDENES por línea.
  // Se cuentan workOrderId ÚNICOS por línea (no accounts): el operador razona en órdenes, y
  // una orden puede tener varias cuentas/tareas en la misma línea. Una orden programada en
  // DOS líneas cuenta en ambas — es material que de verdad va a las dos.
  // Las estaciones que no se pudieron resolver se REPORTAN en unknownStationIds: un conteo
  // que se traga estaciones en silencio haría que el dropdown mienta por omisión.
  function buildLineCounts(scheduleData, stationLineIndex) {
    const idx = stationLineIndex || {};
    const byLineSets = {};
    const allOrders = {};
    const unknown = [];
    const unknownSeen = {};
    for (const s of asNodes(scheduleData && scheduleData.allSchedules)) {
      for (const t of asNodes(s && s.validScheduleTasks)) {
        if (!t) continue;
        const code = idx[t.stationId];
        for (const el of asNodes(t.scheduleTaskElementsByScheduleTaskId)) {
          for (const a of asNodes(el && el.associatedPartsTransferAccounts)) {
            if (!a || a.workOrderId == null) continue;
            allOrders[a.workOrderId] = true;
            if (!code) {
              if (t.stationId != null && !unknownSeen[t.stationId]) {
                unknownSeen[t.stationId] = true;
                unknown.push(t.stationId);
              }
              continue;
            }
            if (!byLineSets[code]) byLineSets[code] = {};
            byLineSets[code][a.workOrderId] = true;
          }
        }
      }
    }
    const byLine = {};
    for (const code of Object.keys(byLineSets)) byLine[code] = Object.keys(byLineSets[code]).length;
    return {
      byLine: byLine,
      lines: Object.keys(byLine).sort(),
      scheduledOrders: Object.keys(allOrders).length,
      unknownStationIds: unknown
    };
  }

  const MAX_MOUNTED_DEFAULT = 200;

  // ¿Esta tarjeta se ve con el filtro puesto?
  // Sin línea elegida: todo se ve. Con línea: solo si esa línea está entre sus destinos.
  // Una tarjeta SIN destinos (no programada) se esconde — decisión del operador 2026-07-29.
  function cardVisibleUnderFilter(cardLines, selectedLine) {
    const sel = (typeof selectedLine === 'string' && selectedLine !== '') ? selectedLine.toUpperCase() : null;
    if (!sel) return true;
    if (!Array.isArray(cardLines)) return false;
    for (const c of cardLines) {
      if (typeof c === 'string' && c.toUpperCase() === sel) return true;
    }
    return false;
  }

  // Plan completo del filtro para el render. Decide EFECTO y arma el desglose del box.
  //   cards = [{ lines:string[] }] (una por tarjeta MONTADA)
  //   apiScheduledOrders = órdenes programadas según GetRelatedScheduleData (árbitro)
  // Guardas (ambas fail-safe: ante duda NO se esconde):
  //   1. too-many-mounted: virtuoso montó demasiado con el filtro puesto → atenuar en vez de
  //      esconder (esconder libera espacio y virtuoso monta más, lo que es lo deseado… hasta
  //      que el filtro deja casi nada y se dispara a montar el board completo).
  //   2. dom-signal-broken: la API reporta programadas pero NINGUNA tarjeta revela línea ⇒ el
  //      anclaje se rompió (layout/locale) → no filtrar, en vez de esconder TODO. Mismo árbitro
  //      que el marcado naranja, y aquí importa más: un color errado se ve, trabajo escondido no.
  function planFilter(opts) {
    const o = opts || {};
    const cards = Array.isArray(o.cards) ? o.cards : [];
    const sel = (typeof o.selectedLine === 'string' && o.selectedLine !== '') ? o.selectedLine.toUpperCase() : null;
    const maxMounted = (typeof o.maxMounted === 'number') ? o.maxMounted : MAX_MOUNTED_DEFAULT;
    const mounted = (typeof o.mountedCount === 'number') ? o.mountedCount : cards.length;
    const apiScheduled = (typeof o.apiScheduledOrders === 'number') ? o.apiScheduledOrders : 0;

    const inactive = function (reason) {
      return {
        active: false, effect: 'none', visible: cards.length, hidden: 0,
        hiddenUnscheduled: 0, hiddenOtherLine: 0, reason: reason
      };
    };
    if (!sel) return inactive('no-selection');

    const anyCardWithLine = cards.some(function (c) {
      return c && Array.isArray(c.lines) && c.lines.length > 0;
    });
    if (!anyCardWithLine && apiScheduled > 0) return inactive('dom-signal-broken');

    let visible = 0, hiddenUnscheduled = 0, hiddenOtherLine = 0;
    cards.forEach(function (c) {
      const lines = (c && Array.isArray(c.lines)) ? c.lines : [];
      if (cardVisibleUnderFilter(lines, sel)) visible++;
      else if (lines.length === 0) hiddenUnscheduled++;
      else hiddenOtherLine++;
    });

    const tooMany = mounted > maxMounted;
    return {
      active: true,
      effect: tooMany ? 'dim' : 'hide',
      visible: visible,
      hidden: hiddenUnscheduled + hiddenOtherLine,
      hiddenUnscheduled: hiddenUnscheduled,
      hiddenOtherLine: hiddenOtherLine,
      reason: tooMany ? 'too-many-mounted' : 'ok'
    };
  }

  const api = {
    LINE_CODE_RE, MAX_MOUNTED_DEFAULT,
    lineCodeFromStationText, linesFromScheduledRows,
    buildStationLineIndex, buildLineCounts,
    cardVisibleUnderFilter, planFilter
  };
  if (typeof window !== 'undefined') window.SurtidoGuardFilterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
