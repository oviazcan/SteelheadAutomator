// tools/hash-autopilot/hash-autopilot-core.mjs
// Núcleo PURO (sin Playwright, sin red) — testeable con node:test.

// ¿La respuesta trae todas las llaves esperadas? paths tipo "pagedData.nodes".
// paths vacío → true (op sin shape declarado, solo exige HTTP 200).
export function hasShape(dataObj, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  const get = (o, path) => path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), o);
  return paths.every((p) => get(dataObj, p) !== undefined);
}

// Clasifica una op comparando el hash capturado del frontend vs el del config.
//  - noCapturado : la receta no disparó la op (liveHash null)
//  - vigente     : capturado == config
//  - rotadoValidado : distinto + re-ejecución 200 + shape esperado
//  - sospechoso  : distinto pero no valida 200/shape (NO se deploya)
export function classifyOp({ cfgHash, liveHash, http, shapeOk }) {
  if (liveHash == null) return 'noCapturado';
  if (liveHash === cfgHash) return 'vigente';
  if (http === 200 && shapeOk) return 'rotadoValidado';
  return 'sospechoso';
}
