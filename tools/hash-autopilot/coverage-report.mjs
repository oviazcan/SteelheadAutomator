// tools/hash-autopilot/coverage-report.mjs
// Núcleo PURO: qué queries del config tienen ruta en el catálogo y cuáles no.
import { missingCoverage } from './hash-autopilot-core.mjs';

export function coverageReport(catalog, queryOps) {
  const routes = (catalog && catalog.routes) || {};
  const missing = missingCoverage(routes, queryOps).slice().sort();
  const missingSet = new Set(missing);
  const covered = queryOps.filter((op) => !missingSet.has(op)).slice().sort();
  const pct = queryOps.length === 0 ? 100 : Math.round((covered.length / queryOps.length) * 100);
  // byModule: para las faltantes, no sabemos módulo aún → agrupa bajo '(sin ruta)'.
  const byModule = missing.length ? { '(sin ruta)': missing } : {};
  return { covered, missing, byModule, pct };
}
