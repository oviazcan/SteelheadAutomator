// tools/hash-autopilot/mutation-runner.mjs
// Integración del ciclo sentinela. Los núcleos puros de sentinels.mjs DECIDEN;
// este runner solo ejecuta lo aprobado, con guardias fail-closed y try/finally.
// deps inyecta loadObject/doMutate/doRestore/readJournal/writeJournal → testeable
// sin ERP real.
import { planMutationCapture, isSentinel, journalOpen, journalClose } from './sentinels.mjs';

// El POST de la mutation es async: el frontend la envía tras la acción DOM y el
// interceptor la registra unos ms después. Poll sink.hashes[op] hasta timeout.
async function waitForHash(sink, op, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (sink.hashes[op]) return sink.hashes[op];
    await new Promise((r) => setTimeout(r, 200));
  }
  return sink.hashes[op] || null;
}

export async function runMutationCycle(page, route, sentinelsConfig, sink, deps) {
  const op = (route.captures || [])[0];
  const entityType = route.sentinel?.entityType;
  const plan = planMutationCapture(op, sentinelsConfig, entityType);
  if (plan.action !== 'run') return { captured: false, op, escalated: true, reason: plan.reason };

  let journal = deps.readJournal();
  journal = journalOpen(journal, entityType, plan.sentinelId, op, 0);
  deps.writeJournal(journal);

  // ¿Pasó la verificación de identidad? SOLO entonces restauramos: un restore que muta
  // (p.ej. receivedOrderEdit hace SAVE) NUNCA debe correr sobre un objeto NO verificado
  // como sentinela — el fail-closed del mutate sería inútil si el finally muta igual.
  let verified = false;
  try {
    // Verificación de identidad ANTES de mutar (fail-closed).
    const obj = await deps.loadObject(page, plan.sentinelId);
    if (!isSentinel(obj)) {
      return { captured: false, op, escalated: true, reason: 'objeto cargado NO es sentinela (identidad)' };
    }
    verified = true;
    // Disparar la mutación (el interceptor de sink captura el hash del frontend).
    await deps.doMutate(page, route);
    const hash = await waitForHash(sink, op, 8000);
    return { captured: !!hash, op, hash };
  } finally {
    // Restaurar SOLO si verificamos la identidad (nunca tocar un objeto no-sentinela);
    // luego cerrar journal.
    if (verified) { try { if (deps.doRestore) await deps.doRestore(page, route); } catch (_) {} }
    deps.writeJournal(journalClose(deps.readJournal(), entityType));
  }
}
