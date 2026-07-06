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
