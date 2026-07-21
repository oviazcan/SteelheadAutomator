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

// ¿Hay evidencia suficiente de que el liveHash capturado es VÁLIDO (el server lo
// reconoce) para tratarlo como respuesta-OK en classifyOp? Dos fuentes independientes:
//  (a) responseOk: el frontend re-ejecutó la op y obtuvo `data` sin errors (queries y
//      mutations que devuelven data).
//  (b) abortProbeVigente: para CAPTURA-Y-ABORTA (el request se ABORTA → nunca hay
//      respuesta que inspeccionar), un probe directo del liveHash con variables VACÍAS
//      devolvió un error de validación de variables (classifyProbe → 'vigente') → el hash
//      SÍ está en el registry del server. NO ejecuta la escritura: variables vacías fallan
//      la validación de tipos ANTES del resolver (p.ej. AddPartsToWorkOrders → "$input …
//      was not provided"). Cualquiera de las dos basta para AUTO-DEPLOYAR un hash rotado
//      — el hash es solo el identificador de la persisted query; su validez no depende de
//      las variables que luego pase el applet.
export function isValidatedCapture({ responseOk = false, abortProbeVigente = false } = {}) {
  return !!responseOk || !!abortProbeVigente;
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

// Construye el payload de needs-attention.json (Nivel B). Enriquece cada op con
// la receta vieja COMPLETA (module + steps + captures) para dar al re-descubridor
// un punto de partida. op sin receta → recipeTried/steps null (crear desde cero).
export function buildNeedsAttention(notCaptured, recipes, date) {
  const find = (op) => Object.entries(recipes || {}).find(([, r]) => (r.captures || []).includes(op));
  const ops = (notCaptured || []).map((r) => {
    const rec = find(r.op);
    return {
      op: r.op,
      recipeTried: rec ? rec[0] : null,
      module: rec ? (rec[1].module || null) : null,
      steps: rec ? (rec[1].steps || null) : null,
      captures: rec ? (rec[1].captures || null) : null,
      observed: 'la receta no disparó la op (0 capturas)',
    };
  });
  return { date, ops };
}

// Poda de needs-attention.json: quita las ops que un run posterior YA resolvió (capturó
// ✓ vigente o deployó el rotado). Evita que el Nivel B gaste una corrida confirmando algo
// ya arreglado — el motor escribe needs-attention.json SOLO cuando hay algo que escalar,
// así que si un tick posterior recaptura bien, el archivo VIEJO persistía indefinidamente
// (hallazgo de la corrida real 2026-07-17). Devuelve el payload podado, o null si ya no
// quedan ops (el caller borra el archivo). resolvedOps vacío → payload intacto.
export function pruneNeedsAttention(payload, resolvedOps) {
  if (!payload || !Array.isArray(payload.ops)) return null;
  const resolved = new Set(resolvedOps || []);
  const remaining = payload.ops.filter((o) => o && !resolved.has(o.op));
  if (remaining.length === 0) return null;
  return { ...payload, ops: remaining };
}

// Ops target que ninguna receta captura (huecos del mapa click-recipes.json).
export function missingCoverage(recipes, targetOps) {
  const covered = new Set();
  for (const r of Object.values(recipes || {})) {
    for (const op of (r.captures || [])) covered.add(op);
  }
  return targetOps.filter((op) => !covered.has(op));
}
