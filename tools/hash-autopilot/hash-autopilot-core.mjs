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

// Decide qué se deploya a partir de los results clasificados. Freno de masa:
// si > massBrakeThreshold ops rotaron en una corrida, NO deploya nada (defiende
// contra captura corrupta / cookie de otro dominio) y pide revisión humana.
export function planDeploy(results, opts = {}) {
  const threshold = opts.massBrakeThreshold ?? 6;
  const rotated = results.filter((r) => r.verdict === 'rotadoValidado');
  const suspicious = results.filter((r) => r.verdict === 'sospechoso');
  const notCaptured = results.filter((r) => r.verdict === 'noCapturado');
  if (rotated.length > threshold) {
    return {
      toDeploy: [], suspicious, notCaptured, massBrake: true,
      reason: `Freno de masa: ${rotated.length} > ${threshold} rotados en una corrida`,
    };
  }
  return { toDeploy: rotated, suspicious, notCaptured, massBrake: false, reason: null };
}

// Ops target que ninguna receta captura (huecos del mapa click-recipes.json).
export function missingCoverage(recipes, targetOps) {
  const covered = new Set();
  for (const r of Object.values(recipes || {})) {
    for (const op of (r.captures || [])) covered.add(op);
  }
  return targetOps.filter((op) => !covered.has(op));
}
