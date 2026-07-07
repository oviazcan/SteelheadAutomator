// tools/hash-autopilot/build-catalog.mjs
// Toma un scan instrumentado y (re)genera route-catalog.json + reporta cobertura.
// Uso: node build-catalog.mjs <scan_results.json> [--dry]
//   --dry: imprime el catálogo fusionado + cobertura SIN escribir el archivo.
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateCatalog } from './catalog-generator.mjs';
import { coverageReport } from './coverage-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, 'route-catalog.json');
const CONFIG_PATH = join(__dirname, '../../remote/config.json');

const DRY = process.argv.includes('--dry');
const scanPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!scanPath) { console.error('uso: node build-catalog.mjs <scan_results.json> [--dry]'); process.exit(1); }

const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
// Estructura del scan_results: {exportedAt, scanResults, eventLog, apiKnowledge}
// donde scanResults ES el mapa op→{hash,screens,...} directamente (no scanResults.ops).
// Toleramos ambas formas por robustez.
const sr = scan.scanResults || scan;
const scanOps = (sr.ops && typeof sr.ops === 'object') ? sr.ops : sr;
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const queries = config.steelhead.hashes.queries || {};
const mutations = config.steelhead.hashes.mutations || {};
const opTypeOf = (op) => (op in mutations ? 'mutation' : 'query');

const generated = generateCatalog(scanOps, opTypeOf);

// Fusión: preserva rutas existentes (validadas a mano en Fase A); añade/actualiza las del scan.
const existing = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const mergedRoutes = { ...existing.routes };
for (const [id, route] of Object.entries(generated.routes)) {
  if (mergedRoutes[id] && mergedRoutes[id].captures) {
    // UNIR captures con la ruta existente — una pasada nueva no debe borrar ops que otra capturó.
    const caps = [...new Set([...(mergedRoutes[id].captures || []), ...(route.captures || [])])].sort();
    mergedRoutes[id] = { ...route, captures: caps };
  } else {
    mergedRoutes[id] = route;
  }
}
const orderedRoutes = {};
for (const id of Object.keys(mergedRoutes).sort()) orderedRoutes[id] = mergedRoutes[id];
const merged = { ...existing, routes: orderedRoutes };

if (DRY) {
  console.log(JSON.stringify(merged, null, 1));
} else {
  writeFileSync(CATALOG_PATH, JSON.stringify(merged, null, 2) + '\n');
}

const rep = coverageReport(merged, Object.keys(queries));
console.log(`\nroute-catalog.json ${DRY ? '(dry — no escrito)' : 'actualizado'}: ${Object.keys(orderedRoutes).length} rutas.`);
console.log(`Cobertura de queries: ${rep.covered.length}/${Object.keys(queries).length} (${rep.pct}%).`);
if (rep.missing.length) console.log(`Faltan ruta (${rep.missing.length}): ${rep.missing.join(', ')}`);
