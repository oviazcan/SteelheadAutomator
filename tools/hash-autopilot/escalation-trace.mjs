// tools/hash-autopilot/escalation-trace.mjs
// Núcleo PURO del trace de re-descubrimiento (Nivel B). Registra cada acción
// intentada para que el operador mejore las heurísticas. Sin red/DOM.

export function newTrace(date) {
  return { date, actions: [] };
}

// addAction(trace, action) → NUEVO trace con la acción añadida (inmutable).
// action = { op, step, action, target, selectorTried, observed, opFired, screenshot }
export function addAction(trace, action) {
  return { ...trace, actions: [...trace.actions, action] };
}

// outcomeByOp(trace) → { op: 'reparada' | 'escalada' }. 'reparada' si ALGUNA
// acción de esa op disparó la op objetivo (opFired true).
export function outcomeByOp(trace) {
  const out = {};
  for (const a of trace.actions || []) {
    if (out[a.op] === 'reparada') continue;
    out[a.op] = a.opFired ? 'reparada' : 'escalada';
  }
  return out;
}

// summarizeForEmail(trace, maxPerOp) → texto legible para el correo. Agrupa por
// op, lista hasta maxPerOp acciones con su resultado y observación, y anota el
// desenlace (reparada/escalada). Es lo que el operador usa para mejorar el sistema.
export function summarizeForEmail(trace, maxPerOp = 8) {
  const byOp = {};
  for (const a of trace.actions || []) (byOp[a.op] || (byOp[a.op] = [])).push(a);
  const outcome = outcomeByOp(trace);
  const blocks = [];
  for (const [op, acts] of Object.entries(byOp)) {
    const mark = outcome[op] === 'reparada' ? '✓ reparada' : '✗ escalada';
    const shown = acts.slice(0, maxPerOp).map((a, i) =>
      `   ${i + 1}. [${a.action}] ${a.target || a.selectorTried || ''} → ${a.opFired ? 'OP DISPARADA' : 'no'} · ${a.observed || ''}`);
    const extra = acts.length > maxPerOp ? `\n   … + ${acts.length - maxPerOp} acciones más` : '';
    blocks.push(`• ${op} (${mark}):\n${shown.join('\n')}${extra}`);
  }
  return blocks.join('\n\n');
}

// Gate del cron de escalación: corre solo si hay señal Y no se intentó hoy
// (idempotencia — el marcador de "intentado hoy" lo pone el wrapper tras correr).
export function shouldRunEscalation(needsAttentionExists, alreadyTriedToday) {
  return !!needsAttentionExists && !alreadyTriedToday;
}
