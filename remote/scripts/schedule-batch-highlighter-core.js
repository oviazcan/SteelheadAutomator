// Resaltar Lote en Programación — módulo puro (sin DOM ni red).
// Decide, dado el texto de la celda "Received Batches" de una fila de tarea del Schedule Board,
// si esa fila corresponde al NOMBRE de lote buscado (para resaltarla y marcar su checkbox).
//
// Problema (bug de Steelhead reportado): en el Schedule Board el filtro nativo "Received Batches"
// es client-side y su dropdown solo ofrece UN id por nombre, así que al filtrar por un lote
// homónimo esconde las tareas de los OTROS lotes con el mismo nombre. Este applet NO filtra: en su
// lugar RESALTA (color) las filas cuyo Received Batches coincide con el nombre y marca su checkbox,
// para que el operador las vea de un vistazo recorriendo la lista.
//
// Mecánica confirmada en vivo (2026-07-22, Ecoplating TLC, Schedule Board 453):
//   · El filtro nativo NO cambia la URL ni dispara query (100% estado React) → no reutilizable.
//   · Las tablas de tareas son <table class="MuiTable-root"> (Unscheduled + Scheduled).
//   · La celda "Received Batches" contiene el NOMBRE del lote como link <a> (p.ej. "210726").
//   · El checkbox de la fila está en la 1a celda; un click programático lo alterna (dispara el
//     handler nativo de selección, sin tocar React internals).
//   · La tabla VIRTUALIZA (declara N filas, renderiza solo las visibles) → solo se pueden marcar
//     las filas presentes en el DOM; el resto se marca al hacer scroll (de ahí el aviso de scroll).
(function () {
  'use strict';

  // Gate de URL: /Schedules/<id>/ScheduleBoard/<id>  (con o sin query ?stationId=…)
  const SCHEDULE_BOARD_URL_RE = /^\/Schedules\/\d+\/ScheduleBoard\/\d+\/?(?:[?#]|$)/i;

  function isScheduleBoardUrl(pathname) {
    return SCHEDULE_BOARD_URL_RE.test(String(pathname == null ? '' : pathname));
  }

  function normalizeName(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  // Texto de la celda Received Batches → lista de nombres de lote.
  // Soporta una celda con varios lotes separados por espacios/comas/saltos ("210726 210727").
  function extractBatchNames(cellText) {
    return String(cellText == null ? '' : cellText)
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // ¿La fila (por el texto de su celda Received Batches) corresponde EXACTAMENTE al nombre buscado?
  // Match exacto por nombre → agarra TODOS los lotes homónimos (lo que el filtro nativo no puede).
  function rowMatchesBatchName(cellText, targetName) {
    const target = normalizeName(targetName);
    if (!target) return false;
    return extractBatchNames(cellText).some((n) => normalizeName(n) === target);
  }

  // Dado un arreglo de filas {cellText}, cuenta cuántas coinciden (para el contador del panel).
  function countMatches(rows, targetName) {
    const arr = Array.isArray(rows) ? rows : [];
    return arr.reduce((acc, r) => acc + (rowMatchesBatchName(r && r.cellText, targetName) ? 1 : 0), 0);
  }

  // ── migración de versiones ──
  // Id del nodo que monta la versión ACTUAL (buscador inline en la barra de filtros nativa).
  const ACTIVE_NODE_ID = 'sa-sbh-inline';
  // Ids de nodos que montaron versiones ANTERIORES de este applet y que el glue actual debe LIMPIAR
  // al reinyectarse: en la SPA de larga vida el remote loader recarga el script SIN recargar la página,
  // así que un nodo con id distinto dejado por una versión previa queda HUÉRFANO en el DOM. v0.1.0/0.1.1
  // montaban un panel FLOTANTE 'sa-sbh-panel' (position:fixed) que coexistía con el inline nuevo.
  // Invariante: NUNCA debe contener ACTIVE_NODE_ID (no removernos a nosotros mismos).
  const LEGACY_NODE_IDS = ['sa-sbh-panel'];

  const api = {
    SCHEDULE_BOARD_URL_RE,
    isScheduleBoardUrl,
    normalizeName,
    extractBatchNames,
    rowMatchesBatchName,
    countMatches,
    ACTIVE_NODE_ID,
    LEGACY_NODE_IDS,
  };
  if (typeof window !== 'undefined') window.ScheduleBatchHighlighterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
