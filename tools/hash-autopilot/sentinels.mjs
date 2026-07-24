// tools/hash-autopilot/sentinels.mjs
// Núcleos PUROS del ciclo centinela (sin red/DOM). La integración headless los
// consume pero nunca actúa sin su aprobación. Fail-closed por diseño.

export const SENTINEL_MARKER = '__SA_SENTINEL__';

// ── Máquina de estados del ciclo (Task 1) ──────────────────────────────────
// Determinista y fail-closed: una transición no declarada lanza, nunca produce
// un estado inventado. base=archivado listo, dirty=mutado pendiente de restaurar,
// restoring=restaurando, failed=algo salió mal.
const TRANSITIONS = {
  base: { open: 'dirty' },
  dirty: { restore: 'restoring', error: 'failed' },
  restoring: { restored: 'base', error: 'failed' },
};
export function cycleNext(state, event) {
  if (event === 'error' && (state === 'dirty' || state === 'restoring')) return 'failed';
  const next = TRANSITIONS[state] && TRANSITIONS[state][event];
  if (!next) throw new Error(`transición inválida: ${state} -${event}->`);
  return next;
}

// ── Identidad + estrategia (Task 2) ────────────────────────────────────────
// Fail-closed: solo true si la marca aparece de forma reconocible. Datos raros/
// nulos → false (no mutar).
export function isSentinel(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // el marcador visible del objeto es "Centinela" (español correcto). Fail-closed: datos raros → false.
  const hay = (s) => typeof s === 'string' && (s.includes(SENTINEL_MARKER) || /centinela/i.test(s));
  if (hay(obj.name) || hay(obj.displayName)) return true;
  if (Array.isArray(obj.tags) && obj.tags.some(hay)) return true;
  if (obj.customInputs && typeof obj.customInputs === 'object') {
    for (const v of Object.values(obj.customInputs)) {
      if (hay(v)) return true;
      if (v && typeof v === 'object') for (const vv of Object.values(v)) if (hay(vv)) return true;
    }
  }
  return false;
}

// Estrategia por prefijo del nombre de la mutation. Destructivas → efímero;
// reversibles → archivar/restaurar; lo demás → escala (no-auto).
export function strategyFor(mutationOp) {
  if (/^(Delete|Remove)/.test(mutationOp)) return 'ephemeral-create-destroy';
  if (/^(Save|Update|Archive|Set|Create|Add)/.test(mutationOp)) return 'archived-mutate-restore';
  return 'no-auto';
}

// ── Journal + reparación idempotente (Task 3) ──────────────────────────────
// Mapa entityType → {state, sentinelId, op, ts}. Funciones puras que devuelven un
// NUEVO journal (el caller lo persiste). Una entidad con entrada presente está
// "sucia" (ciclo sin cerrar) y bloquea nuevos ciclos suyos.
export function journalOpen(journal, entityType, sentinelId, op, ts) {
  const cur = journal[entityType];
  if (cur && (cur.state === 'dirty' || cur.state === 'restoring')) {
    throw new Error(`ciclo en curso (dirty) para ${entityType} — reparar antes`);
  }
  return { ...journal, [entityType]: { state: 'dirty', sentinelId, op, ts } };
}
export function journalClose(journal, entityType) {
  const { [entityType]: _drop, ...rest } = journal;
  return rest;
}
export function pendingRepairs(journal) {
  return Object.entries(journal || {})
    .filter(([, e]) => e && e.state !== 'base')
    .map(([entityType, e]) => ({ entityType, sentinelId: e.sentinelId, op: e.op }))
    .sort((a, b) => (a.entityType < b.entityType ? -1 : a.entityType > b.entityType ? 1 : 0));
}

// ── Gate de seguridad: ¿se puede capturar esta mutation? (Task 5) ───────────
// v1 soporta SOLO archived-mutate-restore con centinela declarado; ephemeral
// (destructivas) escala.
export function planMutationCapture(mutationOp, sentinelsConfig, entityType) {
  const ent = sentinelsConfig?.entities?.[entityType];
  // CAPTURA-Y-ABORTA declarada en la entidad (_estrategia: 'capture-abort'): el handler marca
  // la op en sink.abortOps ANTES de disparar y el interceptor ABORTA el request → CERO efecto
  // SIEMPRE (no persiste), aunque la op sea destructiva (Delete…) o de prefijo desconocido
  // (Generate…). El gate por prefijo (strategyFor) asume EJECUCIÓN real; para capture-abort NO
  // aplica — el hash es solo el identificador de la persisted query y nunca se ejecuta la escritura.
  if (ent && ent._estrategia === 'capture-abort') {
    if (!ent.id) return { action: 'escalate', reason: `capture-abort sin id declarado para ${entityType}` };
    return { action: 'run', strategy: 'capture-abort', entityType, sentinelId: ent.id };
  }
  const strategy = strategyFor(mutationOp);
  if (strategy === 'no-auto') return { action: 'escalate', reason: `estrategia no-auto para ${mutationOp}` };
  if (strategy === 'ephemeral-create-destroy') {
    return { action: 'escalate', reason: `destructiva (ephemeral no soportado en v1): ${mutationOp}` };
  }
  if (!ent) return { action: 'escalate', reason: `sin centinela declarado para entidad ${entityType}` };
  return { action: 'run', strategy, entityType, sentinelId: ent.id };
}
