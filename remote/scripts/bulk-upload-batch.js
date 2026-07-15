// bulk-upload-batch.js — funciones PURAS de planeación de lotes (troceo SOLO_PN).
//
// Dual-export: window.SteelheadBulkBatch (browser) / module.exports (node --test),
// mismo patrón que bulk-upload-parse.js / bulk-upload-cc.js. SIN dependencias de
// DOM, API ni closure.
//
// Motivación (2026-07-13): en modo SOLO_PN una carga real trae ~8862 filas en UNA
// corrida monolítica de 13+ min. El gauge de heap (usedJSHeapSize) se mantiene bajo
// (36–46%) pero el RSS del proceso (DOM/C++/buffers) crece sin que lo veamos, y el
// navegador puede matar la tab. Troceando la EJECUCIÓN en lotes de ~N filas con
// drain de Apollo + checkpoint entre lotes, el RSS se recicla cada lote.
//
// INVARIANTE DE NO-REGRESIÓN: cuando NO aplica troceo (size falsy, size inválido,
// o total <= size) `planBatchRanges` devuelve EXACTAMENTE UN rango [[0, total]].
// Así el caller corre el bloque de ejecución en UNA sola iteración byte-idéntica al
// comportamiento actual (COTIZACIÓN+NP y SOLO_PN chico quedan intactos).
(function (root) {
  'use strict';

  // ¿`size` es un tamaño de lote válido y positivo? (entero finito > 0)
  function isValidSize(size) {
    return typeof size === 'number' && isFinite(size) && size > 0 && Math.floor(size) === size;
  }

  // planBatchRanges(total, size) -> Array<[start, end]>  (half-open [start, end))
  //
  // · total inválido/<=0        → [[0, 0]]        (una iteración no-op; preserva
  //                                                 la semántica de "corre el bloque
  //                                                 una vez" aunque no haya filas)
  // · size inválido | total<=size → [[0, total]]  (NO trocear = 1 rango completo)
  // · total > size (size válido)  → chunks contiguos de `size`, el último parcial
  //
  // Los rangos son contiguos, cubren [0, total) sin huecos ni traslapes, y ninguno
  // es vacío (salvo el caso total=0).
  function planBatchRanges(total, size) {
    const n = (typeof total === 'number' && isFinite(total)) ? Math.floor(total) : 0;
    if (n <= 0) return [[0, 0]];
    if (!isValidSize(size) || n <= size) return [[0, n]];
    const ranges = [];
    for (let start = 0; start < n; start += size) {
      ranges.push([start, Math.min(start + size, n)]);
    }
    return ranges;
  }

  // Etiqueta 1-based para el panel: batchLabel(0, 9) -> "Lote 1/9".
  function batchLabel(index, count) {
    return `Lote ${index + 1}/${count}`;
  }

  // describeBatchPlan(total, size) -> { total, size, batches, ranges, sizes, willBatch }
  // Resumen para el preview: cuántos lotes y de qué tamaño. `willBatch` es false
  // cuando cae en el path de un solo rango (no se trocea de verdad).
  function describeBatchPlan(total, size) {
    const ranges = planBatchRanges(total, size);
    const sizes = ranges.map(([s, e]) => e - s);
    const n = (typeof total === 'number' && isFinite(total)) ? Math.floor(total) : 0;
    return {
      total: n,
      size: isValidSize(size) ? size : null,
      batches: ranges.length,
      ranges,
      sizes,
      willBatch: isValidSize(size) && n > size,
    };
  }

  const api = { isValidSize, planBatchRanges, batchLabel, describeBatchPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkBatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
