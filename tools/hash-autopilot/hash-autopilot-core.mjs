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
  // probeVerdicts: op -> 'stale' | 'vigente' | 'auth' | 'unknown' (probe directo del cfgHash).
  // Es la señal que le faltaba al freno: distingue "el applet YA está roto" de "rotó pero el
  // viejo sigue sirviendo". Ver la reformulación abajo.
  const probe = opts.probeVerdicts || {};
  const rotatedAll = results.filter((r) => r.verdict === 'rotadoValidado');
  // EXTERNOS: capturamos su hash vivo pero la op NO vive en remote/config.json (su
  // hash está en OTRO repo — p.ej. Reportes SH `steelhead_client.py`, PowerTools).
  // writeConfigHashes no las puede escribir (regex sin match) → deployarlas sería un
  // bump+push de gh-pages SIN cambio real, y como su cfgHash sigue null se repetiría
  // en CADA corrida. Se reportan aparte para que el operador sincronice el otro repo.
  const external = rotatedAll.filter((r) => !r.cfgHash);
  const rotated = rotatedAll.filter((r) => r.cfgHash);
  const suspicious = results.filter((r) => r.verdict === 'sospechoso');
  const notCaptured = results.filter((r) => r.verdict === 'noCapturado');
  // ── Freno de masa, reformulado (2026-08-05) ─────────────────────────────────
  // ANTES: contaba rotados y, pasado el umbral, NO deployaba NADA. Medía el costo de
  // ACTUAR y nunca el de NO actuar. El 2026-08-05 el release BB7C5204 rotó 14 queries de
  // golpe; los hashes viejos daban STALE estable en el probe (= applets ROTOS en producción)
  // y el freno mantuvo el config muerto ~5 h repitiendo el mismo correo cada hora.
  //
  // Su premisa declarada ("captura corrupta / cookie de otro dominio") tampoco se sostiene:
  // un hash de persisted query identifica el TEXTO de la query, es GLOBAL al build y no al
  // tenant — una sesión en el dominio equivocado capturaría los MISMOS hashes.
  // Lo que sí protege, y por eso no se elimina, es un BUG DEL PROPIO MOTOR: si el interceptor
  // asociara hashes a operaciones equivocadas, el síntoma sería justo "rotaron N de golpe".
  // Es un circuit breaker contra nosotros, no un detector de anomalías del ERP.
  //
  // AHORA la pregunta no es CUÁNTOS rotaron sino ¿SIGUE VIVO EL HASH QUE TENEMOS?
  //   - cfgHash MUERTO (probe 'stale') ⇒ el applet YA está roto para el operador. Corregir
  //     SIEMPRE: retener no es la opción segura, es la que GARANTIZA el daño. Nunca frena.
  //   - cfgHash VIVO / no concluyente  ⇒ rotación "de futuro": no urge, y si Steelhead
  //     revierte el release nos quedaríamos apuntando a un hash que dejó de existir. Ahí el
  //     conteo sí informa, y el freno actúa.
  // FAIL-SAFE: sin probe (auth caído, red, o probeVerdicts vacío) NADA cuenta como muerto ⇒
  // el freno se comporta EXACTAMENTE como antes. "No sé" jamás habilita un deploy masivo.
  const urgentes = rotated.filter((r) => probe[r.op] === 'stale');
  const futuras = rotated.filter((r) => probe[r.op] !== 'stale');
  if (futuras.length > threshold) {
    return {
      // Aun frenando se deployan las urgentes: el freno viejo era todo-o-nada y elegía
      // "nada", que es la peor mitad cuando hay applets caídos.
      toDeploy: urgentes, suspicious, notCaptured, external, massBrake: true, heldBack: futuras,
      reason: `Freno de masa: ${futuras.length} > ${threshold} rotados cuyo hash viejo SIGUE VIVO`
        + `${urgentes.length ? ` (se deployan aparte ${urgentes.length} con el hash viejo MUERTO)` : ''}`,
    };
  }
  return { toDeploy: rotated, suspicious, notCaptured, external, massBrake: false, heldBack: [], reason: null };
}

// Construye el payload de needs-attention.json (Nivel B). Enriquece cada op con
// la receta vieja COMPLETA (module + steps + captures) para dar al re-descubridor
// un punto de partida. op sin receta → recipeTried/steps null (crear desde cero).
// `observedByOp` (op → razón real) permite que las MUTATIONS reporten por qué abortó su
// ciclo centinela en vez del genérico de queries: el 2026-07-24 SaveManyPartNumberPrices
// escaló con "la receta no disparó la op" cuando el ciclo había abortado por IDENTIDAD
// (el load no vio el quote centinela) — dos diagnósticos y dos reparaciones distintas, y
// el Nivel B arrancó buscando la equivocada. Sin entrada → el genérico de siempre.
export function buildNeedsAttention(notCaptured, recipes, date, observedByOp = {}) {
  const find = (op) => Object.entries(recipes || {}).find(([, r]) => (r.captures || []).includes(op));
  const ops = (notCaptured || []).map((r) => {
    const rec = find(r.op);
    return {
      op: r.op,
      recipeTried: rec ? rec[0] : null,
      module: rec ? (rec[1].module || null) : null,
      steps: rec ? (rec[1].steps || null) : null,
      captures: rec ? (rec[1].captures || null) : null,
      observed: (observedByOp && observedByOp[r.op]) || 'la receta no disparó la op (0 capturas)',
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
//
// `knownOps` (las ops CON hash en el config de hoy) cubre la segunda puerta del mismo
// cry-wolf: una op cuyo hash se RETIRA por muerta desaparece de `results` para siempre,
// así que NUNCA entra a resolvedOps y el archivo quedaba armado indefinidamente — el cron
// del Nivel B gastaba un `claude -p` DIARIO re-descubriendo la receta de algo que ya no
// existe. Pasó con TempSpecFieldsAndOptions (escaló 19:32, retirada 20:21 en v1.11.87).
// Mismo bug que el de CreateInvoicePdf (2026-07-25), por otra puerta.
// Fail-safe deliberado: knownOps ausente o VACÍO ⇒ NO se poda por retiro. Un mapa vacío es
// "no pude leer el config", no "ninguna op existe"; AUSENTE ≠ VACÍO y perder la señal es
// peor que un tick de más.
export function pruneNeedsAttention(payload, resolvedOps, knownOps = null) {
  if (!payload || !Array.isArray(payload.ops)) return null;
  const resolved = new Set(resolvedOps || []);
  const known = Array.isArray(knownOps) && knownOps.length ? new Set(knownOps) : null;
  const remaining = payload.ops.filter((o) => o && !resolved.has(o.op) && (!known || known.has(o.op)));
  if (remaining.length === 0) return null;
  return { ...payload, ops: remaining };
}

// Base de la señal de atención: de las ops NO capturadas, cuáles de verdad ameritan
// alertar/escalar. Excluye dos clases que NO son "la UI cambió y hay que re-descubrir":
//  (a) knownNoRoute    — hueco conocido sin ruta en el catálogo (estático, Fase B).
//  (b) suppressPending — mutations VIGENTES cuya captura headless es FLAKY y cuya ruta ya
//      se investigó y se descartó como no-automatizable (CreateInvoicePdf: el modal del PDF
//      no abre confiable headless; ver masked-ops.json `_docSuppressPendingReport`).
// Antes (b) solo se silenciaba en pendingMuts, pero la op seguía saliendo en el correo como
// "❓ probe no concluyente" Y escribiendo needs-attention.json → el cron del Nivel B gastaba
// un `claude -p` DIARIO re-descubriendo un callejón sin salida ya documentado (bug
// 2026-07-25, reproducido). No pierde detección: si el intento best-effort SÍ captura un
// hash rotado, la op no pasa por aquí — sale en toDeploy ("CORREGIDA Y DEPLOYADA").
export function escalableNotCaptured(notCaptured, { knownNoRoute = [], suppressPending = [] } = {}) {
  const skip = new Set([...(knownNoRoute || []), ...(suppressPending || [])]);
  return (notCaptured || []).filter((r) => r && !skip.has(r.op));
}

// Ops target que ninguna receta captura (huecos del mapa click-recipes.json).
export function missingCoverage(recipes, targetOps) {
  const covered = new Set();
  for (const r of Object.values(recipes || {})) {
    for (const op of (r.captures || [])) covered.add(op);
  }
  return targetOps.filter((op) => !covered.has(op));
}
