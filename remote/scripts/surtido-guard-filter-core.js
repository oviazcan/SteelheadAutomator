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

  const api = { LINE_CODE_RE, lineCodeFromStationText, linesFromScheduledRows };
  if (typeof window !== 'undefined') window.SurtidoGuardFilterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
