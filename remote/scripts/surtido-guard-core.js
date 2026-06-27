// Candado de Surtido Programado — módulo puro (sin DOM ni red).
// Lógica de decisión de bloqueo + (Task 2) parsers del board query y de la
// mutación de mover. Consumido por surtido-guard.js (glue) y por los tests.
(function () {
  'use strict';

  // Decide si un movimiento de piezas debe bloquearse.
  //   record = { found:boolean, programada:boolean, woId, fechaPrograma }
  //   opts   = { enforcementEnabled:boolean }
  // Política FAIL-SAFE: si la WO no está en el mapa (found:false) NO se bloquea
  // (no frenar operación legítima por un dato que aún no cargó). Solo se bloquea
  // con evidencia positiva de "no programada".
  function shouldBlockMove(record, opts) {
    if (!opts || opts.enforcementEnabled !== true) return { block: false, reason: 'disabled' };
    if (!record || record.found !== true) return { block: false, reason: 'unknown-failsafe' };
    if (record.programada === true) return { block: false, reason: 'scheduled' };
    return { block: true, reason: 'not-scheduled' };
  }

  const api = { shouldBlockMove };
  if (typeof window !== 'undefined') window.SurtidoGuardCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
