// tools/hash-autopilot/probe-config-hashes.mjs
// DETECTOR headless de rotaciones REALES (mitad "detección" del self-heal).
//
// Prueba cada hash de QUERY del config directamente contra /graphql (APQ
// hash-only + variables vacías) desde una sesión chromium ROCP-autenticada
// COMO EL FRONTEND. Clasificación (probe-classify.mjs):
//   · "Must provide a query string"/"PersistedQueryNotFound" → STALE (rotó de verdad)
//   · "Variable $x … was not provided" / data → VIGENTE
//
// Por qué existe (incidente 2026-07-10): SearchUnits rotó (hash del config muerto)
// y NADIE lo detectó — validate-hashes.py (idp-token) da falso-stale para las ops
// session-sensitive, y el motor de captura nunca disparó SearchUnits. Este probe
// SÍ las ve porque usa la misma auth que el front (OAuth bearer del ROCP).
//
// SEGURO: SOLO queries (las mutations NO se prueban — una con vars opcionales
// podría ejecutarse). Read-only, no toca config.json ni deploya. No corre en el
// path de auto-deploy del launchd: es una herramienta de diagnóstico aparte.
//
// Uso:
//   node probe-config-hashes.mjs                 # prueba TODAS las queries del config
//   node probe-config-hashes.mjs --only=SearchUnits
//   node probe-config-hashes.mjs --session-only  # solo las session-sensitive
//   flags: --domain=344 --domain-nano=1NFxmF
// Exit: 0 = ninguna stale · 1 = hay stale · 2 = error fatal (auth/red).
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { loadTokens, makeRocpInit, dateStrLocal } from './hash-autopilot.mjs';
import { classifyProbe, summarizeProbes } from './probe-classify.mjs';

const BASE = 'https://app.gosteelhead.com';
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../remote/config.json');
const RESULTS_DIR = join(__dirname, '../.hash-autopilot');
// Mismo set que el motor: ops que validate-hashes.py NO puede ver bien.
const SESSION_SENSITIVE = ['AllCustomers', 'Customer', 'CurrentUser', 'GetPurchaseOrderDetail', 'AllSensorDashboards', 'SensorDashboardQuery', 'SearchUnits'];

const args = process.argv.slice(2);
const argVal = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
const DOMAIN = argVal('domain', '344');
const DOMAIN_NANO = argVal('domain-nano', '1NFxmF');
const ONLY = argVal('only', null);
const SESSION_ONLY = args.includes('--session-only');

function queryHashes() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return (cfg.steelhead && cfg.steelhead.hashes && cfg.steelhead.hashes.queries) || {};
}

async function main() {
  const tokens = loadTokens(); // lanza si access_token vacío → "corre steelhead_auth.py"
  let entries = Object.entries(queryHashes());
  if (SESSION_ONLY) entries = entries.filter(([op]) => SESSION_SENSITIVE.includes(op));
  if (ONLY) entries = entries.filter(([op]) => op === ONLY);
  if (!entries.length) { console.error('No hay queries que probar (¿--only mal escrito?).'); process.exit(2); }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addInitScript(makeRocpInit(tokens, DOMAIN_NANO), {
    access: tokens.access, refresh: tokens.refresh, expEpoch: tokens.expEpoch, state: randomUUID(), domainNano: DOMAIN_NANO,
  });
  const page = await ctx.newPage();
  // Cargar el home para que el front establezca el contexto de auth del origen.
  await page.goto(`${BASE}/Domains/${DOMAIN}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3500);

  // El probe corre EN LA PAGE (mismo origen que el front) → usa la COOKIE de sesión
  // que el app ya estableció (credentials:'include'), IGUAL que el front y que el
  // probe manual que validamos. NO se manda Authorization: Bearer — el /graphql
  // gateway rechaza el JWT crudo del ROCP con 403 "invalid algorithm" (la cookie es
  // la vía correcta; el bearer solo ensucia). Reintento corto ante blips de red.
  const raw = await page.evaluate(async ({ entries }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const once = async (op, hash) => {
      const r = await fetch('/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'apollographql-client-version': '4.0.8' },
        credentials: 'include',
        body: JSON.stringify({ operationName: op, variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      const j = await r.json().catch(() => ({}));
      return { op, http: r.status, message: (j.errors && j.errors[0] && j.errors[0].message) || null, hasData: !!(j && j.data) };
    };
    const results = [];
    for (const [op, hash] of entries) {
      let res = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { res = await once(op, hash); break; }
        catch (e) { res = { op, http: null, message: String(e).slice(0, 140), hasData: false }; await sleep(300); }
      }
      results.push(res);
    }
    return results;
  }, { entries });
  await browser.close();

  const classified = raw.map((r) => ({ ...r, verdict: classifyProbe(r) }));
  const sum = summarizeProbes(classified);

  // Fail-safe de auth: si NADA salió vigente ni stale, la sesión no autenticó.
  if (sum.vigente.length === 0 && sum.stale.length === 0 && classified.length > 0) {
    console.error('⚠️ 0 vigentes/stale — la sesión no autenticó (¿tokens ROCP vencidos? corre steelhead_auth.py).');
    persist(classified, sum);
    process.exit(2);
  }

  console.log(`\n=== probe directo de hashes (queries) · dominio ${DOMAIN} ===`);
  console.log(`  probadas: ${classified.length}`);
  console.log(`  🔺 STALE (rotó de verdad): ${sum.stale.join(', ') || '(ninguna)'}`);
  console.log(`  ✓ vigentes: ${sum.vigente.length}`);
  if (sum.auth.length || sum.unknown.length) console.log(`  ⚠️ auth/desconocido: ${[...sum.auth, ...sum.unknown].join(', ') || '(ninguno)'}`);
  const p = persist(classified, sum);
  console.log(`\n  resultado → ${p}`);
  process.exitCode = sum.stale.length ? 1 : 0;
}

function persist(classified, sum) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const date = dateStrLocal(new Date());
  const path = join(RESULTS_DIR, `probe-${date}.json`);
  writeFileSync(path, JSON.stringify({ date, domain: DOMAIN, summary: sum, results: classified }, null, 2));
  return path.replace(join(__dirname, '../..') + '/', '');
}

main().catch((e) => { console.error('fatal:', e); process.exit(2); });
