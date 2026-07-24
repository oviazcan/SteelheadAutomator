// tools/hash-autopilot/sentinel-health.mjs
// Núcleo PURO (sin red/DOM): clasifica los resultados de los ciclos centinela para
// distinguir un centinela ROTO (archivado / renombrado → falla la verificación de
// identidad isSentinel) de un simple "no capturó (sin hash)".
//
// POR QUÉ: un centinela declarado que el operador archiva por accidente hace que el
// ciclo aborte fail-closed en SILENCIO (runMutationCycle devuelve escalated con
// reason de identidad, hoy solo va a consola). Un centinela archivado sale read-only
// → isSentinel=false → nunca se recaptura su op → si esa op rota, se descubre tarde.
// Esto lo convierte en una ALERTA accionable en el correo del motor.

// Razones de runMutationCycle que delatan identidad rota (centinela archivado/movido).
// Ver mutation-runner.runMutationCycle: 'objeto cargado NO es centinela (identidad)'.
const IDENTITY_FAIL = /no es centinela|identidad/i;

// classifyCycleOutcomes(results) → { broken, captured, other }.
// results = [{ op, entityType, captured, escalated, reason }] (uno por ciclo intentado).
//  - broken: abortó por identidad → centinela probablemente ARCHIVADO/renombrado.
//  - captured: capturó el hash (sano).
//  - other: no capturó por otra razón (sin hash, dry-run, gate) → NO es alerta de salud.
export function classifyCycleOutcomes(results) {
  const broken = [], captured = [], other = [];
  for (const r of results || []) {
    if (!r) continue;
    if (r.captured) captured.push(r);
    else if (r.escalated && IDENTITY_FAIL.test(r.reason || '')) broken.push(r);
    else other.push(r);
  }
  return { broken, captured, other };
}

// formatSentinelAlert(broken) → bloque de texto para el correo (o '' si no hay).
export function formatSentinelAlert(broken) {
  if (!broken || !broken.length) return '';
  const lines = broken.map(
    (b) => `   • ${b.op} (centinela ${b.entityType || '?'} #${b.sentinelId ?? '?'}): ${b.reason || 'identidad no verificada'}`
  );
  return `🚨 CENTINELA ROTO/ARCHIVADO (${broken.length}) — el ciclo abortó fail-closed porque el objeto de prueba NO pasó la verificación de identidad (típicamente porque quedó ARCHIVADO → sale read-only, o lo renombraron). Su(s) op(s) dejará(n) de recapturarse hasta repararlo. Acción: DESARCHIVA el centinela y verifica que su nombre contenga "Centinela":\n${lines.join('\n')}`;
}
