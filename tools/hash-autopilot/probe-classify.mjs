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
