// tools/hash-autopilot/deploy-verify-core.mjs
// Núcleo PURO (sin red/git): decide si un deploy del autopilot REALMENTE llegó al
// sitio EN VIVO, y cómo gritarlo si no.
//
// POR QUÉ EXISTE (incidente 2026-08-05, descubierto A MANO por el operador):
// tres deploys del autopilot quedaron atorados sin llegar a producción — el sitio
// servía `config 1.11.77` mientras `main` iba en `1.11.80`. Causa: otra sesión publicó
// documentación en `gh-pages` (rama COMPARTIDA por los deploys de la extensión y los 3
// paquetes de docs) y el `git push` del autopilot salió rechazado por non-fast-forward.
// Consecuencia: `InvoiceByIdInDomain` (applet `cfdi-attacher`), `GetStation` y
// `WorkboardById` quedaron CORREGIDOS EN EL REPO pero ROTOS EN VIVO.
//
// LOS TRES AGUJEROS QUE LO HICIERON INVISIBLE (verificados leyendo el código):
//
//  1. El motor no gritaba: se CALLABA. El correo nunca dijo "corregida" en falso — la
//     sección "CORREGIDAS Y DEPLOYADAS" está detrás de `if (deployed && …)`. El problema
//     es el opuesto y es peor: con el deploy fallido NO se empujaba NINGUNA sección, y
//     como el correo sólo se manda `if (sec.length)`, un fallo de deploy con todo lo
//     demás sano producía CERO correo. El fallo vivía en un `console.log` del log de
//     launchd que nadie lee. Un vigilante que se calla cuando falla es peor que uno que
//     miente: no hay nada que contradecir.
//
//  2. `main` SÍ se pusheó (`deploy.sh` hace `push origin main` ANTES que
//     `push origin gh-pages`). Así que a la corrida siguiente `classifyOp` comparaba el
//     `cfgHash` DEL REPO LOCAL —ya con el hash nuevo— contra el `liveHash` capturado:
//     IGUALES => veredicto `vigente` => la op DESAPARECÍA DEL RADAR, mientras el sitio
//     seguía sirviendo el viejo. El sistema se auto-convence de que está sano. Ése es el
//     mecanismo por el que "lleva tiempo pasando sin que nadie se entere", y el que
//     obliga a que la verificación mire el SITIO, no el REPO.
//
//  3. `deploy-status.sh` compara la rama `gh-pages` LOCAL (`git show gh-pages:…`), no
//     `origin/gh-pages`. Con el push rechazado, local va adelante y el sitio atrás: el
//     reporte sale "Desalineado … vivo=X", que SE LEE IGUAL que un lag de propagación
//     del CDN. Se leyó así en esta misma sesión antes de mirar el push. Una señal
//     ambigua ante dos causas de gravedad opuesta no es una señal.
//
// REGLA DE FONDO: todo el aparato de vigilancia medía el REPO, y lo que los operadores
// ejecutan es el SITIO. El heartbeat prueba que el autopilot CORRIÓ; el validador prueba
// que el REPO está bien; nadie probaba que el SITIO sirve lo correcto. "Commiteé" no es
// "publiqué", y sólo lo segundo le consta al operador.

// Marca de rechazo por non-fast-forward en la salida de `git push`. Es el caso COMÚN, no
// el excepcional: `gh-pages` la comparten los deploys de la extensión y los tres paquetes
// de documentación, y el `pre-push` EXIME los push "solo-docs" (no les exige bump), así
// que un push de docs puede adelantarse al del autopilot en cualquier momento.
const NON_FF = /non-fast-forward|fetch first|Updates were rejected/i;

// classifyPushError(text) -> 'non-fast-forward' | 'other'
// Fail-closed hacia 'other': sólo el rechazo que sabemos resolver con rebase se clasifica
// como tal. Texto vacío/nulo NO es non-ff — no inventamos permiso para reescribir
// historia a partir de una causa que no leímos.
export function classifyPushError(text) {
  if (typeof text !== 'string' || !text) return 'other';
  return NON_FF.test(text) ? 'non-fast-forward' : 'other';
}

// verifyLiveDeploy(liveConfig, expected) -> { ok, missing, reason }
//   liveConfig: el objeto YA parseado que sirve GitHub Pages (o null si no se pudo leer)
//   expected:   [{op, liveHash}] — los pares que el deploy dijo haber publicado
//
// FAIL-CLOSED: sin config en vivo legible NO se declara éxito. "No pude verificar" y
// "verifiqué que está bien" son estados distintos y sólo uno permite cerrar en verde;
// confundirlos es exactamente lo que produjo el incidente.
export function verifyLiveDeploy(liveConfig, expected = []) {
  const pairs = (expected || []).filter((e) => e && e.op && e.liveHash);
  if (!liveConfig || typeof liveConfig !== 'object') {
    return {
      ok: false,
      missing: pairs.map((e) => ({ op: e.op, expected: e.liveHash, live: null })),
      reason: 'no se pudo leer el config EN VIVO',
    };
  }
  const q = liveConfig?.steelhead?.hashes?.queries || {};
  const m = liveConfig?.steelhead?.hashes?.mutations || {};
  const missing = [];
  for (const { op, liveHash } of pairs) {
    const served = q[op] ?? m[op] ?? null;
    if (served !== liveHash) missing.push({ op, expected: liveHash, live: served });
  }
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length ? 'el sitio EN VIVO no sirve el/los hash(es) deployado(s)' : null,
  };
}

// detectLiveDrift(localConfig, liveConfig) -> { drift, version, liveVersion, ops }
// Compara el config del REPO contra el SERVIDO para cazar en CADA corrida un drift que
// venga de una corrida anterior (agujero 2: sin esto el motor sólo se enteraría en la
// corrida que deploya, y después olvida). Sólo reporta ops presentes en AMBOS y
// distintas: una op nueva que aún no propaga es lag, no drift.
export function detectLiveDrift(localConfig, liveConfig) {
  if (!localConfig || !liveConfig) return { drift: false, version: null, liveVersion: null, ops: [] };
  const pick = (c) => ({ ...(c?.steelhead?.hashes?.queries || {}), ...(c?.steelhead?.hashes?.mutations || {}) });
  const L = pick(localConfig), V = pick(liveConfig);
  const ops = [];
  for (const [op, hash] of Object.entries(L)) {
    if (V[op] !== undefined && V[op] !== hash) ops.push({ op, repo: hash, live: V[op] });
  }
  ops.sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));
  return {
    drift: ops.length > 0,
    version: localConfig.version ?? null,
    liveVersion: liveConfig.version ?? null,
    ops,
  };
}

// formatDeployNotLiveAlert(missing, meta) -> bloque de texto para el correo (o '').
// Redacción deliberada: nombra el estado REAL ("corregido en el repo, ROTO en vivo") en
// vez de un genérico "el deploy falló", porque la acción del operador depende de esa
// diferencia — el commit y el tag SÍ existen; lo que falta es que el sitio los sirva.
export function formatDeployNotLiveAlert(missing, meta = {}) {
  if (!missing || !missing.length) return '';
  const { version, liveVersion, pushError } = meta;
  const filas = missing.map((m) => {
    const applets = (m.applets || []).join(', ');
    const live = m.live ? String(m.live).slice(0, 8) + '…' : '(ausente)';
    return `   • ${m.op}: el repo dice ${String(m.expected).slice(0, 8)}… pero el sitio sirve ${live}${applets ? ` — applets: ${applets}` : ''}`;
  });
  const ver = (version || liveVersion)
    ? `\n   Versión: repo=${version ?? '?'} · EN VIVO=${liveVersion ?? '(no responde)'}`
    : '';
  const causa = pushError ? `\n   Causa del push: ${String(pushError).split('\n')[0].slice(0, 160)}` : '';
  return `🚨 DEPLOY NO LLEGÓ A PRODUCCIÓN (${missing.length}) — el hash quedó CORREGIDO EN EL REPO pero el sitio EN VIVO sigue sirviendo el viejo: los applets SIGUEN ROTOS para el operador.${ver}${causa}\n${filas.join('\n')}\n   Causa típica: push a gh-pages rechazado (non-fast-forward) porque otra sesión publicó docs.\n   Acción: git fetch origin gh-pages → rebase → re-push; o corre tools/deploy-status.sh para ver el estado real.`;
}
