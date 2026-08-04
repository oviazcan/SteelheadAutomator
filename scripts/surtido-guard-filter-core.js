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

  // Código base: letra + 3 dígitos (T204, T300…), seguido OPCIONALMENTE de `-<segmento>` pegado.
  // SIN anclar al inicio, porque la celda empieza con el literal inglés "at " (la UI de SH mezcla
  // idiomas). Es seguro no anclar PORQUE el ámbito es una sola celda que solo contiene el nombre
  // de la estación.
  const LINE_CODE_RE = /\b([A-Za-z]\d{3})\b(?:-([A-Za-z0-9]+))?/;

  // Un código TXY0…0 terminado en "00" NO es una línea: es un ÁREA que agrupa destinos
  // independientes entre sí. Medido sobre los nombres reales de estación del dominio —las líneas
  // de producción son T101…T120, T201…T208, T301, T302, T401, T501 y NINGUNA termina en 00—:
  //   T300-CE03 Antitarnish · T300-CE05 Limpieza Especial · T300-IC00 Inspección y Empaque
  //   T100-SA01 Sandblast   · T100-IC00 Inspección/Empaque · T100-HO01 Horno
  //   T000-SPR Surtimiento  · T000-MA00 Maquila TT         · T000-VC01 Vehículo
  // Cortar a 3 dígitos mete Antitarnish y Limpieza Especial en el MISMO renglón del dropdown y el
  // operador ya no puede saber a dónde va el material (reportado en piso 2026-08-04). Para una
  // línea real el corte a 3 dígitos SÍ es el correcto: sus TI00/EN00/SE00/IC00 son PASOS de esa
  // misma línea, no destinos rivales — partirla ahí llenaría el dropdown de ruido.
  //
  // La MISMA regla vive en auto-router-engine.extractLineCode (2026-08-04). Son dos
  // implementaciones a propósito —los regex base difieren: allá anclado al inicio y con T\d{2,4},
  // aquí sin anclar porque la celda trae el prefijo "at "— atadas por
  // tools/test/line-code-area-parity.test.js para que no puedan derivar en silencio.
  const AREA_CODE_RE = /^[A-Z]\d00$/;

  function lineCodeFromStationText(text) {
    if (typeof text !== 'string' || text === '') return null;
    const m = text.match(LINE_CODE_RE);
    if (!m) return null;
    const base = m[1].toUpperCase();
    // El guion debe venir PEGADO al código: "T100 (LMC)-CU/BR-VARIOS" es un nombre de PROCESO, no
    // una estación, y ahí el segmento no significa un destino. Sin él se degrada al área — perder
    // granularidad es tolerable; inventar un destino que no existe no lo es.
    if (!AREA_CODE_RE.test(base) || !m[2]) return base;
    return base + '-' + m[2].toUpperCase();
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

  // Une el catálogo de la API con las líneas efectivamente VISTAS en las tarjetas montadas.
  //
  // Por qué existe (medido en vivo 2026-07-30, board "Preparación de Surtido Almacén 5"):
  // el catálogo de la API es COMPLETO cuando llega, pero **puede no llegar** — ahí
  // `GetRelatedScheduleData` no se disparó (ni por recarga ni navegando dentro de la SPA), así
  // que `lineCounts` salía vacío y el dropdown se quedaba SOLO con "Todas"… mientras una tarjeta
  // mostraba claramente su destino T300. Un filtro cuyo dropdown está vacío es INUTILIZABLE
  // aunque su lógica sea correcta.
  //
  // Las líneas que solo vio el DOM van SIN conteo: dar un número de tarjetas montadas como si
  // fuera el total de órdenes sería mentir, y aquí el número es lo que el operador usa para
  // decidir. Mejor sin número que con un número falso.
  function mergeLineCatalog(apiCounts, domLines) {
    const byLine = {};
    const api = (apiCounts && apiCounts.byLine) ? apiCounts.byLine : {};
    for (const k of Object.keys(api)) byLine[k] = api[k];
    const domOnly = [];
    const seenDom = {};
    (Array.isArray(domLines) ? domLines : []).forEach(function (code) {
      if (typeof code !== 'string' || code === '') return;
      const c = code.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(byLine, c) || seenDom[c]) return;
      seenDom[c] = true;
      domOnly.push(c);
    });
    return {
      lines: Object.keys(byLine).concat(domOnly).sort(),
      byLine: byLine,
      domOnly: domOnly
    };
  }

  // Acumula las líneas vistas en el board. El catálogo NO puede depender de lo que está
  // montado AHORA.
  //
  // Por qué (bug reportado por el operador 2026-07-30): al esconder las tarjetas de otras
  // líneas, react-virtuoso **las desmonta** — el scroll se encogió y salen del viewport. Si el
  // dropdown se arma con las tarjetas montadas en ese instante, después de filtrar por T300 se
  // queda SOLO con T300 y ya no puedes saltar a T204: tendrías que quitar el filtro primero.
  // O sea, el propio filtro se comía su catálogo.
  //
  // Acumular es correcto además con la virtualización normal: al scrollear aparecen líneas
  // nuevas y se SUMAN, nunca se pierden. Se limpia al salir del board (teardown).
  function accumulateSeenLines(prevSeen, cards) {
    const out = [];
    const seen = {};
    const push = function (code) {
      if (typeof code !== 'string' || code === '') return;
      const c = code.toUpperCase();
      if (seen[c]) return;
      seen[c] = true;
      out.push(c);
    };
    (Array.isArray(prevSeen) ? prevSeen : []).forEach(push);
    (Array.isArray(cards) ? cards : []).forEach(function (c) {
      if (c && Array.isArray(c.lines)) c.lines.forEach(push);
    });
    return out.sort();
  }

  // Líneas del board desde `WorkOrderSchedule`, que devuelve el schedule COMPLETO del dominio
  // (no solo el de la WO consultada) con `stationByStationId.name` en cada tarea.
  //
  // Por qué hace falta (bug reportado 2026-07-30): sin esto el catálogo dependía de las tarjetas
  // MONTADAS, y el board virtualiza — de 142 órdenes monta ~8. Resultado: el dropdown arrancaba
  // con 3 líneas y **crecía conforme filtrabas**, porque esconder tarjetas hace que virtuoso monte
  // otras y aparezcan líneas nuevas. El operador veía el catálogo descubrirse por accidente.
  //
  // Devuelve SOLO las líneas, sin conteos, y es deliberado: esta query cubre el dominio entero,
  // así que sus números NO son los de este workboard. Un conteo inflado en el dropdown es peor
  // que ningún conteo — es el dato con el que se decide.
  function linesFromBoardSchedule(input) {
    const root = (input && input.allSchedules) ? input
               : (input && input.data && input.data.allSchedules) ? input.data
               : null;
    const seen = {};
    const out = [];
    for (const sch of asNodes(root && root.allSchedules)) {
      for (const task of asNodes(sch && sch.validScheduleTasks)) {
        if (!task) continue;
        const st = task.stationByStationId || {};
        const code = lineCodeFromStationText(st.name);
        if (!code || seen[code]) continue;
        seen[code] = true;
        out.push(code);
      }
    }
    return out.sort();
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
    buildStationLineIndex, buildLineCounts, mergeLineCatalog, accumulateSeenLines, linesFromBoardSchedule,
    cardVisibleUnderFilter, planFilter
  };
  if (typeof window !== 'undefined') window.SurtidoGuardFilterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
