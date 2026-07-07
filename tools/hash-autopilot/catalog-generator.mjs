// tools/hash-autopilot/catalog-generator.mjs
// Núcleo PURO: convierte un scan instrumentado (op→screens) en route-catalog.json.
// Agrupa ops por pantalla (economía de clics). Sin red, sin DOM.

// Módulo a partir del pathname: el segmento tras /Domains/{id}/, o el primer
// segmento, o 'Home' para la raíz.
export function moduleFromPath(pathname) {
  if (!pathname || pathname === '/') return 'Home';
  const parts = pathname.split('/').filter(Boolean);
  const di = parts.indexOf('Domains');
  if (di >= 0 && parts[di + 2]) return parts[di + 2];
  return parts[0] || 'Home';
}

// ¿El último segmento es un id numérico? (indica pantalla de detalle → listado+click)
function splitDetail(pathname) {
  const parts = pathname.split('/');
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) return { list: parts.slice(0, -1).join('/'), isDetail: true };
  return { list: pathname, isDetail: false };
}

// id de ruta estable a partir del módulo + (detalle|list).
function routeId(module, isDetail) {
  return `${module.toLowerCase()}${isDetail ? '-detail' : '-list'}`;
}

export function generateCatalog(scanOps, opTypeOf) {
  // Agrupar ops por el pathname dominante (mayor count).
  const byPath = {}; // pathname → { ops:Set, hadClick:bool }
  for (const [op, entry] of Object.entries(scanOps || {})) {
    const screens = entry && entry.screens ? entry.screens : [];
    if (!screens.length) continue;
    const dom = screens.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0];
    const g = byPath[dom.pathname] || (byPath[dom.pathname] = { ops: new Set(), hadClick: false });
    g.ops.add(op);
    if (dom.breadcrumb) g.hadClick = true;
  }

  const routes = {};
  for (const [pathname, g] of Object.entries(byPath)) {
    const module = moduleFromPath(pathname);
    const { list, isDetail } = splitDetail(pathname);
    const id = routeId(module, isDetail);
    const steps = [{ goto: isDetail ? list : pathname }];
    if (isDetail || g.hadClick) steps.push({ clickFirst: 'a[href]', hrefMatches: '\\d' });
    if (routes[id]) {
      // Colisión de id: varios objetos de detalle del mismo módulo (cada uno con pathname
      // único /Módulo/{id} pero mismo routeId). UNIR captures — no perder ops de los otros.
      for (const op of g.ops) if (!routes[id].captures.includes(op)) routes[id].captures.push(op);
    } else {
      routes[id] = { type: 'query', module, steps, captures: [...g.ops] };
    }
  }
  // Tras unir colisiones: ordenar captures + calcular type; reordenar por id (determinista).
  for (const r of Object.values(routes)) {
    r.captures.sort();
    r.type = r.captures.every((op) => opTypeOf(op) === 'query') ? 'query'
      : r.captures.every((op) => opTypeOf(op) === 'mutation') ? 'mutation' : 'mixed';
  }
  const ordered = {};
  for (const id of Object.keys(routes).sort()) ordered[id] = routes[id];
  return { routes: ordered };
}
