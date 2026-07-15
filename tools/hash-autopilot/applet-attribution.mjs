// tools/hash-autopilot/applet-attribution.mjs
// Núcleo PURO: atribuye cada op de GraphQL a los applets de SteelheadAutomator
// (remote/scripts/*.js) que la referencian — para que el correo de hash-autopilot
// diga QUÉ TRUENA si la op rota/no se captura, no solo el nombre pelón de la op.
// Mismo criterio que tools/hash-stale-report.py: match de la op citada entre
// comillas (como en query('Op', …) / getHash('Op')) — evita falsos positivos en
// comentarios o substrings. Sin red, sin DOM, sin fs → testeable con node:test.

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// appletsForOp(op, scriptSources, knownUsedBy) → [applet, …] ordenado.
//   scriptSources: { 'bulk-upload': '<contenido .js>', … } (nombre = stem del archivo)
//   knownUsedBy:  string de config.knownOperations[op].usedBy (coma-separado) — fallback.
// Prioriza el grep real de los scripts; si NINGÚN script la referencia, cae al
// usedBy declarado en config (útil para ops nativas/huérfanas o helpers minificados).
export function appletsForOp(op, scriptSources, knownUsedBy) {
  const pat = new RegExp(`['"]${escapeRe(op)}['"]`);
  const fromScripts = Object.keys(scriptSources || {})
    .filter((name) => pat.test(scriptSources[name] || ''))
    .sort();
  if (fromScripts.length) return fromScripts;
  return String(knownUsedBy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// annotateOps(ops, scriptSources, knownOperations) → [{ op, applets }].
export function annotateOps(ops, scriptSources, knownOperations) {
  const known = knownOperations || {};
  return (ops || []).map((op) => ({
    op,
    applets: appletsForOp(op, scriptSources, (known[op] || {}).usedBy || ''),
  }));
}

// formatOpLine(op, applets) → línea para el cuerpo del correo.
// Con applets: "Customer — applets: invoice-autofill, create-order-autofill".
// Sin ninguno: marca explícita para no confundir "sin dato" con "sin impacto".
export function formatOpLine(op, applets) {
  const a = applets || [];
  return a.length
    ? `${op} — applets: ${a.join(', ')}`
    : `${op} — (ningún applet lo referencia directo; ¿op nativa/huérfana?)`;
}
