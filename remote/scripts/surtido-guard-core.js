// Candado de Surtido Programado — módulo puro (sin DOM ni red).
// Lógica de decisión de bloqueo + parsers de los queries del board y de la
// mutación de mover. Consumido por surtido-guard.js (glue) y por los tests.
//
// Modelo (shapes confirmados Fase 0, ver spec 2026-06-26):
//   · programada = la pieza (partsTransferAccount) tiene una tarea en el programa.
//   · GetRelatedScheduleData → set de partsTransferAccountId programados.
//   · GetRelatedWorkboardData.allRecipeNodes → recipeNodeId del nodo "Preparando Surtido en Almacén".
//   · Variables de WorkOrderMovePartsData / MoveMultipleFromWorkboardData → puente account→{recipeNodeId,workOrderId}.
//   · Mutación CreateManyPartsTransfersChecked → fromAccountId por transfer "STEP".
//   Bloquea un STEP cuyo fromAccount está en un nodo de surtido y NO está programado. FAIL-SAFE ante falta de datos.
(function () {
  'use strict';

  // ── Constantes de dominio (operationNames + match de nodo) ──
  const SOURCE_NODE_NAME_MATCH = 'preparando surtido en almacen';
  const BOARD_SCHEDULE_OP = 'GetRelatedScheduleData';
  const BOARD_RECIPENODES_OP = 'GetRelatedWorkboardData';
  const MOVE_DATA_OPS = ['WorkOrderMovePartsData', 'MoveMultipleFromWorkboardData'];
  const MOVE_MUTATION_OP = 'CreateManyPartsTransfersChecked';

  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }

  function asNodes(x) {
    if (x && Array.isArray(x.nodes)) return x.nodes;
    return Array.isArray(x) ? x : [];
  }
  function asArray(x) { return Array.isArray(x) ? x : []; }

  // GetRelatedScheduleData.data → Set<partsTransferAccountId> programados.
  function buildScheduledAccountSet(scheduleData) {
    const set = new Set();
    for (const s of asNodes(scheduleData && scheduleData.allSchedules)) {
      for (const t of asNodes(s.validScheduleTasks)) {
        for (const el of asNodes(t.scheduleTaskElementsByScheduleTaskId)) {
          for (const a of asNodes(el.associatedPartsTransferAccounts)) {
            if (a && a.id != null) set.add(a.id);
          }
        }
      }
    }
    return set;
  }

  // GetRelatedWorkboardData.data → Set<recipeNodeId> del nodo "Preparando Surtido en Almacén".
  function buildSurtidoNodeSet(workboardData) {
    const set = new Set();
    for (const n of asNodes(workboardData && workboardData.allRecipeNodes)) {
      if (n && normalize(n.name).includes(SOURCE_NODE_NAME_MATCH)) set.add(n.id);
    }
    return set;
  }

  // Variables de un query de move → mapa accountId → { recipeNodeId, workOrderId }.
  // Acepta WorkOrderMovePartsData (escalares + array de accounts del mismo nodo/WO)
  // y MoveMultipleFromWorkboardData (arrays pareados por índice). Acumula sobre `into`.
  function indexAccountNodeFromMoveVars(op, vars, into) {
    const map = into || {};
    if (!vars) return map;
    if (op === 'WorkOrderMovePartsData') {
      for (const a of asArray(vars.partsTransferAccountIds)) {
        map[a] = { recipeNodeId: vars.fromRecipeNodeId, workOrderId: vars.workOrderId };
      }
    } else if (op === 'MoveMultipleFromWorkboardData') {
      const accs = asArray(vars.partsTransferAccountIds);
      const nodesArr = asArray(vars.fromRecipeNodeIds);
      const wos = asArray(vars.workOrderIds);
      for (let i = 0; i < accs.length; i++) {
        map[accs[i]] = { recipeNodeId: nodesArr[i], workOrderId: wos[i] };
      }
    }
    return map;
  }

  // Variables de CreateManyPartsTransfersChecked → lista de transfers tipo STEP.
  function extractStepTransfers(mutationVars) {
    const out = [];
    const payload = mutationVars && mutationVars.partsTransferEventsPayload;
    for (const ev of asArray(payload && payload.partsTransferEvents)) {
      for (const tr of asArray(ev && ev.partsTransfers)) {
        if (tr && tr.type === 'STEP') out.push(tr);
      }
    }
    return out;
  }

  // Decisión unitaria para un account (Task 1). FAIL-SAFE si !found.
  //   record = { found:boolean, programada:boolean, woId }
  function shouldBlockMove(record, opts) {
    if (!opts || opts.enforcementEnabled !== true) return { block: false, reason: 'disabled' };
    if (!record || record.found !== true) return { block: false, reason: 'unknown-failsafe' };
    if (record.programada === true) return { block: false, reason: 'scheduled' };
    return { block: true, reason: 'not-scheduled' };
  }

  // Decisión para la mutación completa.
  //   ctx  = { scheduledAccountIds:Set, accountNode:{[id]:{recipeNodeId,workOrderId}}, surtidoNodeIds:Set }
  //   opts = { enforcementEnabled }
  // Bloquea si algún transfer STEP sale de un nodo de surtido con account NO programado.
  // FAIL-SAFE: account sin puente o fuera de scope → no se evalúa (no bloquea).
  function evaluateMove(mutationVars, ctx, opts) {
    if (!opts || opts.enforcementEnabled !== true) return { block: false, reason: 'disabled', blocked: [] };
    const scheduled = (ctx && ctx.scheduledAccountIds) || new Set();
    const accountNode = (ctx && ctx.accountNode) || {};
    const surtidoNodes = (ctx && ctx.surtidoNodeIds) || new Set();
    const blocked = [];
    let sawSurtido = false;
    for (const tr of extractStepTransfers(mutationVars)) {
      const info = accountNode[tr.fromAccountId];
      if (!info) continue;                              // sin puente → fail-safe
      if (!surtidoNodes.has(info.recipeNodeId)) continue; // fuera de scope (no es surtido)
      sawSurtido = true;
      const decision = shouldBlockMove(
        { found: true, programada: scheduled.has(tr.fromAccountId), woId: info.workOrderId },
        opts
      );
      if (decision.block) blocked.push({ accountId: tr.fromAccountId, workOrderId: info.workOrderId });
    }
    if (blocked.length > 0) return { block: true, reason: 'not-scheduled', blocked };
    if (sawSurtido) return { block: false, reason: 'scheduled', blocked: [] };
    return { block: false, reason: 'out-of-scope-or-unknown', blocked: [] };
  }

  // ── Marcado de tarjetas del Workboard (capa 4) ──
  // Señal DOM "programada" (única señal visible; anclada BILINGÜE ES+EN). La tarjeta NO programada
  // (sin esta señal) es la que NO se puede mover → se pinta naranja.
  const SCHEDULED_CARD_SIGNAL_RE = /Tareas Programadas:?|Scheduled tasks:?/i;
  function hasScheduledCardSignal(text) { return SCHEDULED_CARD_SIGNAL_RE.test(String(text == null ? '' : text)); }

  // Salvaguarda anti-falsa-alarma: si NINGUNA tarjeta reconoce la señal DOM pero la API SÍ reporta
  // programadas (scheduledApiCount>0), la señal DOM se rompió (locale/HTML no cubierto) → no marcar
  // (evita pintar TODAS de naranja). Con al menos una programada reconocida, o sin programadas en la
  // API, se confía en la señal DOM.
  function isDomSignalBroken(anyCardScheduled, scheduledApiCount) {
    return !anyCardScheduled && (scheduledApiCount || 0) > 0;
  }
  // Marca naranja (no-movible) sii la tarjeta no está programada y la señal DOM no está rota.
  function shouldMarkNotMovable(isScheduled, domSignalBroken) {
    return domSignalBroken ? false : !isScheduled;
  }

  const api = {
    SOURCE_NODE_NAME_MATCH, BOARD_SCHEDULE_OP, BOARD_RECIPENODES_OP, MOVE_DATA_OPS, MOVE_MUTATION_OP,
    normalize,
    buildScheduledAccountSet, buildSurtidoNodeSet, indexAccountNodeFromMoveVars,
    extractStepTransfers, shouldBlockMove, evaluateMove,
    SCHEDULED_CARD_SIGNAL_RE, hasScheduledCardSignal, isDomSignalBroken, shouldMarkNotMovable
  };
  if (typeof window !== 'undefined') window.SurtidoGuardCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
