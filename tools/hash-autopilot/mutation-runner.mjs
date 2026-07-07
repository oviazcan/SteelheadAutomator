// tools/hash-autopilot/mutation-runner.mjs
// Integración del ciclo sentinela. Los núcleos puros de sentinels.mjs DECIDEN;
// este runner solo ejecuta lo aprobado, con guardias fail-closed y try/finally.
// deps inyecta loadObject/doMutate/doRestore/readJournal/writeJournal → testeable
// sin ERP real.
import { planMutationCapture, isSentinel, journalOpen, journalClose } from './sentinels.mjs';

export async function runMutationCycle(page, route, sentinelsConfig, sink, deps) {
  const op = (route.captures || [])[0];
  const entityType = route.sentinel?.entityType;
  const plan = planMutationCapture(op, sentinelsConfig, entityType);
  if (plan.action !== 'run') return { captured: false, op, escalated: true, reason: plan.reason };

  let journal = deps.readJournal();
  journal = journalOpen(journal, entityType, plan.sentinelId, op, 0);
  deps.writeJournal(journal);

  try {
    // Verificación de identidad ANTES de mutar (fail-closed).
    const obj = await deps.loadObject(page, plan.sentinelId);
    if (!isSentinel(obj)) {
      return { captured: false, op, escalated: true, reason: 'objeto cargado NO es sentinela (identidad)' };
    }
    // Disparar la mutación (el interceptor de sink captura el hash del frontend).
    await deps.doMutate(page, route);
    const hash = sink.hashes[op] || null;
    return { captured: !!hash, op, hash };
  } finally {
    // Restaurar SIEMPRE (aunque falle la captura); luego cerrar journal.
    try { if (deps.doRestore) await deps.doRestore(page, route); } catch (_) {}
    deps.writeJournal(journalClose(deps.readJournal(), entityType));
  }
}
