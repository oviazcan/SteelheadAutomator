// Agrupar Lote en Programación — módulo puro (sin DOM ni red).
// Decide qué órdenes de un LOTE pueden juntarse en UNA tarea del programa, calcula su duración y
// arma el payload de CreateManyScheduleTasks. Complemento de schedule-batch-highlighter-core.js,
// que solo resalta.
//
// ── Modelo, confirmado contra el payload REAL capturado (scan 2026-07-30, board 454) ──
// Una tarea agrupada es (treatmentId, stationId) + N elementos, cada elemento
// (recipeNodeId, partNumberId, partCount, partsPerBatch, relatedPartTransferAccounts[]).
// El payload capturado trae 1 tarea con 5 elementos de 4 partNumbers distintos: agrupar es
// meter varias ÓRDENES en la misma tarea, no varias tareas juntas.
//
// Duración — verificada dos veces contra ese payload, no inferida:
//   total = treatmentTime + (Σ ceil(partCount_i / partsPerBatch_i) − 1) × cycleTime
//   #1: 45 + (41−1)×30 = 1245 (real 1245)   #2: 45 + (41−1)×15 = 645 (real 645)
// Los lotes se SUMAN entre elementos. Calcularlos por elemento da otro número.
//
// ── Tres cosas que la evidencia corrigió ──
// 1. "T-2150" NO es un lote: son 21 inventory batches DISTINTOS con el mismo nombre (el ERP crea
//    uno por orden). La unidad de agrupación es el NOMBRE; por id no se agruparía nada. Es el mismo
//    hecho que hace inútil al filtro nativo, cuyo dropdown solo ofrece un id por nombre.
// 2. Una orden con DOS nodos programables no es un caso ambiguo: pasa por dos tratamientos y el
//    Task Builder nativo crea DOS tareas encadenadas (el payload real es exactamente eso: las
//    mismas 5 piezas en treatment 112435 y luego 91495).
// 3. El tratamiento y sus tiempos ya viajan en RelatedSchedulingInformation, que el board dispara
//    solo. RackingRecipeNodes (340 KB) no hace falta.
//
// ── Regla de seguridad que gobierna todo el módulo ──
// Esto escribe en el programa de producción. Ante un dato ausente NO se completa con un default:
// sin partsPerRack, partsPerBatch caería a 1 y una tarea de 141 min se vuelve de ~112 días
// (medido en wo-schedule-button 0.8.0). Un falso "no puedo agrupar" cuesta un clic manual; un falso
// "sí puedo" ocupa una tina de producción por días. Por eso todo devuelve null en vez de adivinar.
(function () {
  'use strict';

  // Arriba de esto, una tarea es casi seguro un error de dato maestro y no un lote enorme.
  const DURACION_IMPLAUSIBLE_MIN = 60 * 24 * 7; // 7 días

  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeName(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  // Interval de Postgres → minutos. Devuelve null (no 0) si no es un Interval: un 0 significaría
  // "instantáneo" y pasaría los guardas de más abajo.
  function intervalToMinutes(iv) {
    if (!iv || typeof iv !== 'object' || Array.isArray(iv)) return null;
    const partes = [
      ['years', 525600], ['months', 43200], ['days', 1440],
      ['hours', 60], ['minutes', 1], ['seconds', 1 / 60],
    ];
    let total = 0;
    let visto = false;
    for (const [k, factor] of partes) {
      if (iv[k] == null) continue;
      const n = num(iv[k]);
      if (n == null) return null;
      total += n * factor;
      visto = true;
    }
    return visto ? total : null;
  }

  function nodesOf(conn) {
    return (conn && Array.isArray(conn.nodes)) ? conn.nodes : [];
  }

  // ───────────────────────── índices de RelatedSchedulingInformation ─────────────────────────

  // orden → lotes recibidos [{id, idInDomain, name}]
  function indexBatchesByWorkOrder(relatedInfo) {
    const out = {};
    for (const w of nodesOf(relatedInfo && relatedInfo.allWorkOrders)) {
      if (!w || w.id == null) continue;
      out[w.id] = nodesOf(w.receivedBatches)
        .filter((b) => b && b.name)
        .map((b) => ({ id: b.id, idInDomain: b.idInDomain, name: String(b.name) }));
    }
    return out;
  }

  // orden → nodos PROGRAMABLES (los que declaran tratamiento), con sus tiempos ya en minutos.
  // `times` queda en null cuando el nodo no trae possibleTreatmentTimes: sin tiempos no se puede
  // calcular la duración, y eso debe frenar la creación, no rellenarse.
  function indexSchedulableNodes(relatedInfo) {
    const out = {};
    for (const w of nodesOf(relatedInfo && relatedInfo.allWorkOrders)) {
      if (!w || w.id == null) continue;
      const lista = [];
      for (const n of nodesOf(w.incompleteRecipeNodesByWorkOrderId)) {
        if (!n || n.treatmentId == null) continue;
        lista.push({
          workOrderId: w.id,
          recipeNodeId: n.id,
          type: n.type || '',
          name: n.name || '',
          treatmentId: n.treatmentId,
          treatmentName: (n.treatmentByTreatmentId && n.treatmentByTreatmentId.name) || '',
          times: pickTreatmentTimes(n),
        });
      }
      out[w.id] = lista;
    }
    return out;
  }

  // De possibleTreatmentTimes se toma el primero que traiga AMBOS tiempos. Ojo con el nombre:
  // el tiempo del tratamiento es `totalTime`, no un campo llamado treatmentTime (mismo hallazgo
  // que wo-schedule-core); `cycleTime` es el ciclo entre lotes.
  function pickTreatmentTimes(node) {
    for (const t of nodesOf(node && node.possibleTreatmentTimesByRecipeNodeDefaultTreatment)) {
      const cycle = intervalToMinutes(t && t.cycleTime);
      const treatment = intervalToMinutes(t && t.totalTime);
      if (cycle == null || treatment == null) continue;
      return { cycleTimeMinutes: cycle, treatmentTimeMinutes: treatment, timeType: t.timeType || null };
    }
    return null;
  }

  // Estaciones del tablero, con los tratamientos que corren ahí y sus rack types.
  function indexStations(relatedInfo) {
    return nodesOf(relatedInfo && relatedInfo.allStations)
      .filter((s) => s && s.id != null)
      .map((s) => ({
        stationId: s.id,
        name: s.name || '',
        treatmentIds: nodesOf(s.stationTreatmentsByStationId)
          .map((t) => t && t.treatmentId).filter((t) => t != null),
        rackTypes: nodesOf(s.stationTreatmentRackTypesByStationId).map((r) => ({
          rackTypeId: r.rackTypeId != null ? r.rackTypeId : null,
          rackTypeName: (r.rackTypeByRackTypeId && r.rackTypeByRackTypeId.name) || '',
          rackCount: r.rackCount != null ? r.rackCount : null,
          treatmentId: r.treatmentId != null ? r.treatmentId : null,
        })),
      }));
  }

  // ───────────────────────── piezas por lote ─────────────────────────

  // partsPerBatch = piezas por rack del PN (para el rack type de la estación) × racks de la estación.
  // Las piezas por carga son POR LÍNEA: el mismo PN lleva 4 en T204-FL01 y 1 en T205-FL01, así que
  // el rack type tiene que salir de la estación destino y no del primero que declare el PN.
  // Sin coincidencia devuelve null — nunca 1 (ver la regla de seguridad del encabezado).
  function partsPerBatchFor(input) {
    input = input || {};
    const loc = input.location;
    const station = input.station;
    if (!loc || !station) return null;
    const treatmentId = input.treatmentId != null ? Number(input.treatmentId) : null;
    const pnRacks = nodesOf(loc.partNumberByPartNumberId
      && loc.partNumberByPartNumberId.partNumberRackTypesByPartNumberId);
    if (!pnRacks.length) return null;

    // Los rack types de la estación pueden venir atados a un tratamiento o aplicar a todos (null).
    const candidatos = (station.rackTypes || []).filter(
      (r) => r.treatmentId == null || treatmentId == null || Number(r.treatmentId) === treatmentId);
    for (const r of candidatos) {
      const rackCount = num(r.rackCount);
      if (rackCount == null || rackCount <= 0) continue;
      const pnr = pnRacks.find((x) => x && Number(x.rackTypeId) === Number(r.rackTypeId));
      const perRack = pnr ? num(pnr.partsPerRack) : null;
      if (perRack == null || perRack <= 0) continue;
      return {
        partsPerBatch: perRack * rackCount,
        partsPerRack: perRack,
        rackCount,
        rackTypeId: r.rackTypeId,
        rackTypeName: r.rackTypeName,
      };
    }
    return null;
  }

  // ───────────────────────── duración de la tarea agrupada ─────────────────────────

  function groupedTaskTimes(elements, times) {
    const arr = Array.isArray(elements) ? elements : [];
    if (!arr.length || !times) return null;
    const cycle = num(times.cycleTimeMinutes);
    const treatment = num(times.treatmentTimeMinutes);
    if (cycle == null || treatment == null) return null;

    let batches = 0;
    for (const e of arr) {
      const pc = num(e && e.partCount);
      const ppb = num(e && e.partsPerBatch);
      if (pc == null || pc <= 0) return null;
      if (ppb == null || ppb <= 0) return null;
      batches += Math.ceil(pc / ppb);
    }
    if (!batches) return null;
    return {
      batches,
      cycleTimeMinutes: cycle,
      treatmentTimeMinutes: treatment,
      totalTimeMinutes: treatment + (batches - 1) * cycle,
    };
  }

  // ───────────────────────── armado de grupos ─────────────────────────

  // Junta las órdenes de cada lote que van al MISMO tratamiento. La clave es
  // (nombre de lote, treatmentId): dos lotes distintos nunca caen en la misma tarea aunque
  // compartan tratamiento, y un lote con dos tratamientos produce dos grupos.
  function buildBatchGroups(input) {
    input = input || {};
    const relatedInfo = input.relatedInfo;
    const locations = Array.isArray(input.partLocations) ? input.partLocations : [];
    const wanted = (Array.isArray(input.names) ? input.names : [])
      .map(normalizeName).filter(Boolean);
    const batchIdx = indexBatchesByWorkOrder(relatedInfo);
    const nodeIdx = indexSchedulableNodes(relatedInfo);

    const groups = new Map();
    for (const loc of locations) {
      if (!loc || loc.workOrderId == null) continue;
      const lotes = batchIdx[loc.workOrderId] || [];
      const nodos = nodeIdx[loc.workOrderId] || [];
      if (!lotes.length || !nodos.length) continue;

      for (const lote of lotes) {
        if (wanted.length && !wanted.includes(normalizeName(lote.name))) continue;
        for (const nodo of nodos) {
          const key = normalizeName(lote.name) + ' ' + nodo.treatmentId;
          let g = groups.get(key);
          if (!g) {
            g = {
              batchName: lote.name,
              batchIds: [],
              treatmentId: nodo.treatmentId,
              treatmentName: nodo.treatmentName,
              times: nodo.times,
              elements: [],
            };
            groups.set(key, g);
          }
          if (!g.batchIds.includes(lote.id)) g.batchIds.push(lote.id);
          // Si el nodo de alguna orden trae tiempos y el del grupo no, nos quedamos con los que hay.
          if (!g.times && nodo.times) g.times = nodo.times;
          const pn = loc.partNumberByPartNumberId || {};
          g.elements.push({
            workOrderId: loc.workOrderId,
            recipeNodeId: nodo.recipeNodeId,
            partNumberId: loc.partNumberId,
            partNumberName: pn.name || '',
            partCount: loc.partCount,
            partGroupId: loc.partGroupId != null ? loc.partGroupId : null,
            partsPerBatch: null,   // lo resuelve diagnoseGroup con la estación destino
            accounts: loc.accountId != null
              ? [{ id: loc.accountId, partCount: loc.partCount }] : [],
            location: loc,
          });
        }
      }
    }
    return Array.from(groups.values());
  }

  // ───────────────────────── diagnóstico: ¿se puede crear esta tarea? ─────────────────────────

  // Devuelve { canCreate, reasons[], stationId, times, elements } con los elementos ya completos
  // (partsPerBatch resuelto). `reasons` va vacío solo cuando se puede escribir.
  function diagnoseGroup(group, ctx) {
    ctx = ctx || {};
    const reasons = [];
    if (!group || !Array.isArray(group.elements) || !group.elements.length) {
      return { canCreate: false, reasons: ['El grupo no tiene órdenes.'], stationId: null, times: null, elements: [] };
    }
    const stations = Array.isArray(ctx.stations) ? ctx.stations : [];

    // 1. ¿Hay estación en ESTE tablero que corra el tratamiento?
    const aptas = stations.filter((s) => (s.treatmentIds || []).some(
      (t) => Number(t) === Number(group.treatmentId)));
    const station = aptas[0] || null;
    if (!station) {
      reasons.push(`El tratamiento «${group.treatmentName || group.treatmentId}» no corre en ninguna `
        + 'estación de este tablero: hay que agruparlo desde el tablero de su línea.');
    }

    // 2. ¿Tenemos los tiempos del tratamiento?
    if (!group.times) {
      reasons.push(`El tratamiento «${group.treatmentName || group.treatmentId}» no tiene tiempos `
        + 'registrados (ciclo y tratamiento), así que no se puede calcular cuánto duraría la tarea.');
    }

    // 3. ¿Sabemos las piezas por carga de cada orden?
    const elements = [];
    const sinCarga = [];
    for (const e of group.elements) {
      // Si el elemento ya trae resueltas sus piezas por carga, se respetan: recalcularlas exigiría
      // el `location` crudo y volvería a este diagnóstico inservible sobre grupos ya destilados.
      const yaResuelto = num(e.partsPerBatch);
      const ppb = (yaResuelto != null && yaResuelto > 0)
        ? { partsPerBatch: yaResuelto, rackTypeId: e.rackTypeIdLineage != null ? e.rackTypeIdLineage : null }
        : (station
          ? partsPerBatchFor({ location: e.location, station, treatmentId: group.treatmentId })
          : null);
      if (!ppb) sinCarga.push(e.partNumberName || e.partNumberId);
      elements.push({
        workOrderId: e.workOrderId,
        recipeNodeId: e.recipeNodeId,
        partNumberId: e.partNumberId,
        partNumberName: e.partNumberName,
        partCount: e.partCount,
        partsPerBatch: ppb ? ppb.partsPerBatch : null,
        rackTypeIdLineage: ppb && ppb.rackTypeId != null ? String(ppb.rackTypeId) : null,
        rackIdLineage: null,
        accounts: e.accounts,
      });
    }
    if (station && sinCarga.length) {
      reasons.push('Sin piezas por carga para ' + sinCarga.length + ' número(s) de parte ('
        + sinCarga.slice(0, 3).join(', ') + (sinCarga.length > 3 ? '…' : '')
        + `) en ${station.name || 'la estación'}: hay que capturarlas antes de programar.`);
    }

    // 4. ¿El material ya está en una tarea? Agrupar dos veces duplicaría piezas en el programa.
    const yaProgramadas = ctx.scheduledAccountIds;
    if (yaProgramadas && typeof yaProgramadas.has === 'function') {
      const dup = [];
      for (const e of group.elements) {
        for (const a of (e.accounts || [])) {
          if (yaProgramadas.has(a.id)) dup.push(e.partNumberName || e.partNumberId);
        }
      }
      if (dup.length) {
        reasons.push('Ya está programado el material de ' + dup.length + ' orden(es) de este lote: '
          + 'agrupar otra vez lo duplicaría en el programa.');
      }
    }

    // 5. Duración: se calcula al final porque necesita los partsPerBatch de arriba.
    const times = groupedTaskTimes(elements, group.times);
    if (group.times && station && !sinCarga.length && !times) {
      reasons.push('No se pudo calcular la duración con los datos disponibles.');
    }
    if (times && times.totalTimeMinutes > DURACION_IMPLAUSIBLE_MIN) {
      reasons.push(`La tarea duraría ${Math.round(times.totalTimeMinutes)} min `
        + `(~${(times.totalTimeMinutes / 1440).toFixed(1)} días), lo que casi siempre significa que `
        + 'faltan las piezas por carga del número de parte.');
    }

    return {
      canCreate: reasons.length === 0 && !!times,
      reasons,
      stationId: station ? station.stationId : null,
      stationName: station ? station.name : '',
      times: times || null,
      elements,
    };
  }

  // ───────────────────────── payload de CreateManyScheduleTasks ─────────────────────────

  // Reproduce el payload capturado, incluidos los tipos que sorprenden: `rackTypeIdLineage` es un
  // STRING (no un array) y `rackIdLineage` venía en null. El envoltorio es {mnScheduleTask:[…]} y
  // lleva `scheduleIdFilter`. El `partSetUuid` entra COMO PARÁMETRO (el núcleo no toca fuentes de
  // aleatoriedad y el test lo puede fijar).
  function buildGroupedScheduleTaskInput(input) {
    input = input || {};
    const scheduleId = num(input.scheduleId);
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    if (scheduleId == null || !tasks.length) return null;

    const mn = [];
    for (const t of tasks) {
      if (!t) return null;
      const treatmentId = num(t.treatmentId);
      const stationId = num(t.stationId);
      const elements = Array.isArray(t.elements) ? t.elements : [];
      if (treatmentId == null || stationId == null) return null;
      if (!t.expectedStartTime) return null;
      if (!elements.length) return null;
      const times = groupedTaskTimes(elements, t.times);
      if (!times) return null;

      const nodes = [];
      for (const e of elements) {
        const cuentas = (e.accounts || [])
          .filter((a) => a && a.id != null)
          .map((a) => ({ id: Number(a.id), partCount: Number(a.partCount) || 0 }));
        if (!cuentas.length) return null;   // sin cuenta no hay material que programar
        if (!e.partSetUuid) return null;
        nodes.push({
          partSetUuid: String(e.partSetUuid),
          recipeNodeId: Number(e.recipeNodeId),
          partNumberId: Number(e.partNumberId),
          rackIdLineage: e.rackIdLineage != null ? String(e.rackIdLineage) : null,
          rackTypeIdLineage: e.rackTypeIdLineage != null ? String(e.rackTypeIdLineage) : null,
          partCount: Number(e.partCount),
          partsPerBatch: Number(e.partsPerBatch),
          relatedPartTransferAccounts: cuentas,
        });
      }

      mn.push({
        scheduleId,
        treatmentId,
        stationId,
        expectedStartTime: String(t.expectedStartTime),
        totalTimeMinutes: times.totalTimeMinutes,
        cycleTimeMinutes: times.cycleTimeMinutes,
        treatmentTimeMinutes: times.treatmentTimeMinutes,
        isIntentional: !!t.isIntentional,
        status: 'UNSCHEDULED',
        scheduleTaskElementsByScheduleTaskId: { nodes },
      });
    }

    return {
      scheduledTasks: { mnScheduleTask: mn },
      scheduleIdFilter: { equalTo: scheduleId },
    };
  }

  const api = {
    DURACION_IMPLAUSIBLE_MIN,
    intervalToMinutes,
    normalizeName,
    indexBatchesByWorkOrder,
    indexSchedulableNodes,
    indexStations,
    partsPerBatchFor,
    groupedTaskTimes,
    buildBatchGroups,
    diagnoseGroup,
    buildGroupedScheduleTaskInput,
  };
  if (typeof window !== 'undefined') window.ScheduleBatchGroupCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
