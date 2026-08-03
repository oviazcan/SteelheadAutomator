// tools/hash-autopilot/probe-classify.mjs
// Núcleo PURO: clasifica la respuesta de un PROBE DIRECTO del hash del config
// contra /graphql. Es la señal PRIMARIA de "¿el hash del config sigue registrado?".
//
// Por qué existe (incidente 2026-07-10): el motor infería rotación por
// "hash del front ≠ hash del config". Eso da FALSOS POSITIVOS — el servidor de
// Apollo mantiene registrados AMBOS hashes (el viejo del config y el nuevo del
// front), así que un diff NO implica que el hash del config esté muerto. Peor:
// SearchUnits SÍ había rotado (su hash del config devolvía "Must provide a query
// string") y el motor nunca lo supo porque su receta no lo capturaba.
//
// La señal correcta y directa: POSTear el hash DEL CONFIG con variables vacías.
//   - "Must provide a query string" / "PersistedQueryNotFound" → el hash ya NO
//     está en el registry → STALE (rotó de verdad; algún applet truena).
//   - "Variable $x of required type … was not provided" (u otra validación de
//     variables) o `data` presente → el hash SÍ existe → VIGENTE.
//
// OJO auth: este probe debe correr con la MISMA auth que usa el frontend
// (OAuth bearer del token ROCP). El idp-token del cliente externo
// (validate-hashes.py) da FALSO-stale para estas ops session-sensitive — por eso
// el probe va aquí, en el contexto autenticado como el front, no en Python.

const STALE_RE = /PersistedQueryNotFound|Must provide a query string/i;
// Errores que PRUEBAN que el hash existe (el server lo resolvió y falló al validar
// variables / ejecutar), no que el hash falte.
const VIGENTE_ERR_RE = /Variable ["'$].* of required type|was not provided|got invalid value|Expected (type|value)|Cannot return null|non-nullable|argument .* required/i;
const AUTH_RE = /unauthorized|forbidden|not authenticated|authentication required|invalid token|jwt (expired|malformed)/i;

// classifyProbe({ http, message, hasData }) → 'stale' | 'vigente' | 'auth' | 'unknown'.
//   http:     status HTTP (number|null)
//   message:  errors[0].message (string|null)
//   hasData:  la respuesta trajo `data` no-nula (boolean)
export function classifyProbe({ http = null, message = null, hasData = false } = {}) {
  const msg = (message == null ? '' : String(message));
  if (STALE_RE.test(msg)) return 'stale';
  if (hasData) return 'vigente';
  if (VIGENTE_ERR_RE.test(msg)) return 'vigente';
  if (http === 401 || http === 403 || (msg && AUTH_RE.test(msg))) return 'auth';
  return 'unknown';
}

// summarizeProbes(results) → { stale, vigente, auth, unknown } con arrays de op ordenadas.
// results: [{ op, verdict }]  (verdict de classifyProbe).
export function summarizeProbes(results) {
  const out = { stale: [], vigente: [], auth: [], unknown: [] };
  for (const r of results || []) (out[r.verdict] || out.unknown).push(r.op);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// Cuerpo del probe: hash del config + variables vacías. El operationName ayuda al
// server a dar el mensaje de validación correcto (y es inocuo si el hash no existe).
export function buildProbeBody(op, cfgHash) {
  return { operationName: op, variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: cfgHash } } };
}

// gateByProbe(notCapturedOps, probeVerdicts) → { realStale, falseAlarms, unconfirmed }.
// El motor usa esto para ESCALAR bien: de las ops que no capturó,
//   · probe 'stale'   → ROTACIÓN REAL sin capturar → ESCALAR (urgente).
//   · probe 'vigente' → FALSA ALARMA (el hash del config vive; el page.goto solo no
//     disparó la op) → SUPRIMIR (no llorar).
//   · sin probe / 'auth' / 'unknown' → no concluir → ESCALAR por si acaso (fail-safe).
// probeVerdicts: { op: 'stale'|'vigente'|'auth'|'unknown' }. Vacío = fail-open
// (todo cae a unconfirmed → se escala como antes, sin suprimir nada).
export function gateByProbe(notCapturedOps, probeVerdicts) {
  const v = probeVerdicts || {};
  const realStale = [], falseAlarms = [], unconfirmed = [];
  for (const op of notCapturedOps || []) {
    const verd = v[op];
    if (verd === 'stale') realStale.push(op);
    else if (verd === 'vigente') falseAlarms.push(op);
    else unconfirmed.push(op);
  }
  return { realStale: realStale.sort(), falseAlarms: falseAlarms.sort(), unconfirmed: unconfirmed.sort() };
}

// isProbeSessionDegraded(probeVerdicts, {minProbed}) → true si NINGUNA op probada dio
// veredicto concluyente (todas 'auth'/'unknown'). Eso NO dice "las recetas se rompieron":
// dice "esta corrida no tiene datos" — la red/sesión se cayó a media corrida.
//
// Por qué existe (2026-07-28 y 2026-07-31, el MISMO falso positivo dos veces): el Nivel B
// gastó dos `claude -p` completos re-descubriendo recetas que estaban SANAS. El 07-31 el
// motor de las 17:23 capturó las 3 primeras rutas y falló las 2 ÚLTIMAS en orden de corrida
// (maintenance-sensordashboards-detail, sensordashboards-list), con el probe en 0 vigentes /
// 5 auth-unknown; minutos después validate-hashes.py registraba NameResolutionError de DNS
// contra app.gosteelhead.com (59 unknown) y el refresh ROCP ya había tronado a las 15:27.
// Al día siguiente esas dos recetas capturaron al PRIMER intento, con hash == config.
//
// La regla es la misma que el repo ya pagó en surtido-guard 0.4.0 y report-regen 0.3.2:
// **«no tengo el dato» no es «no existe el dato»**. Con la sesión caída, `unconfirmed` no es
// evidencia de nada, y el motor corre CADA HORA: una rotación real sobrevive al siguiente
// tick, un blip de red no. Suprimir aquí no pierde detección, la aplaza 60 minutos.
//
// Acotada a propósito: exige un mínimo de ops probadas (una sola muestra no es señal) y
// NO toca 'stale' — un 'stale' requiere que el server conteste "Must provide a query string",
// o sea que la sesión SÍ respondió. El correo sigue reportando las no concluyentes; lo único
// que se suprime es la escalación cara.
export function isProbeSessionDegraded(probeVerdicts, { minProbed = 3 } = {}) {
  const vals = Object.values(probeVerdicts || {});
  if (vals.length < minProbed) return false;
  return vals.every((v) => v === 'auth' || v === 'unknown');
}
