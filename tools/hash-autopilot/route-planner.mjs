// tools/hash-autopilot/route-planner.mjs
// Núcleo PURO (sin Playwright, sin red) — planifica el conjunto MÍNIMO de rutas
// que capturan las ops rotadas. Set-cover greedy determinista.

// selectRoutes(rotatedOps, catalog) → { routes, uncovered }.
// En cada vuelta elige la ruta que cubre más ops pendientes; desempata por id
// alfabético. Para cuando ninguna ruta cubre alguna pendiente restante.
export function selectRoutes(rotatedOps, catalog) {
  const pending = new Set(rotatedOps || []);
  const entries = Object.entries((catalog && catalog.routes) || {})
    .map(([id, r]) => ({ id, module: r.module, steps: r.steps || [], captures: r.captures || [] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = [];
  while (pending.size > 0) {
    let best = null;
    let bestCover = 0;
    for (const route of entries) {
      if (chosen.includes(route)) continue;
      const cover = route.captures.filter((op) => pending.has(op)).length;
      if (cover > bestCover) { best = route; bestCover = cover; }
    }
    if (!best || bestCover === 0) break;
    chosen.push(best);
    for (const op of best.captures) pending.delete(op);
  }
  return { routes: chosen, uncovered: [...pending] };
}

// Ops a capturar esta corrida: queries stale detectadas por el validator
// UNIÓN las session-sensitive (que el validator no puede ver → siempre por release).
// Las mutations stale NO se capturan en Fase A (no hay ciclo centinela); se
// reportan aparte con staleMutations().
export function opsToCapture(validatorResult, sessionSensitive) {
  const stale = (validatorResult && validatorResult.stale) || [];
  const staleQueries = stale.filter((s) => s.kind !== 'mutation').map((s) => s.operation);
  const set = new Set([...(sessionSensitive || []), ...staleQueries]);
  return [...set].sort();
}

export function staleMutations(validatorResult) {
  const stale = (validatorResult && validatorResult.stale) || [];
  return stale.filter((s) => s.kind === 'mutation').map((s) => s.operation).sort();
}

// Normaliza el JSON de masked-ops.json a listas defensivas. Una op es
// "enmascarada" (session-sensitive) cuando el validador Python NO la puede
// validar → el motor headless la recaptura SIEMPRE.
export function maskedQueries(maskedOps) {
  return [...new Set((maskedOps && maskedOps.queries) || [])].sort();
}
export function maskedMutations(maskedOps) {
  return [...new Set((maskedOps && maskedOps.mutations) || [])].sort();
}

// Mutations a capturar por ciclo centinela esta corrida. Las mutations se capturan
// EJECUTÁNDOLAS sobre un centinela (aunque sea con captura-y-aborta) → tienen costo y
// un riesgo residual > queries. Por eso:
//  - modo masked-only (cada tick, cada hora): NO captura mutations — solo queries
//    enmascaradas (baratas, cero efecto). Evita ejecutar el ciclo de escritura 24×/día.
//  - modo completo (por release, poco frecuente): las enmascaradas (el validador las
//    skipea, solo el centinela las cubre) UNIÓN las stale del validador.
// El caller filtra luego por "centinela activo" (id real ≠ 0). Determinista.
export function mutationsToCapture(validatorResult, masked, { maskedOnly = false } = {}) {
  if (maskedOnly) return [];
  const m = masked || [];
  return [...new Set([...m, ...staleMutations(validatorResult)])].sort();
}
