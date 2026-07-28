// tools/hash-autopilot/cleanup-sentinela-ovs.mjs  (nombre de archivo heredado; el objeto es "Centinela")
// Archiva TODAS las OV "Centinela" activas que un ciclo de CreateReceivedOrder
// haya dejado sin archivar (p.ej. cuando el dashboard no hidrató a tiempo en el
// restore). Reusa la auth del motor (ROCP) + el doRestore de receivedOrder de
// mutation-deps. Idempotente y no-destructivo (solo toca objetos con nombre
// "Centinela"). Uso: SA_DBG=1 node cleanup-sentinela-ovs.mjs [--domain-nano=1NFxmF]
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadTokens, makeRocpInit } from './hash-autopilot.mjs';
import { makeDeps } from './mutation-deps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const nanoArg = args.find((a) => a.startsWith('--domain-nano='));
const DOMAIN_NANO = nanoArg ? nanoArg.split('=')[1] : '1NFxmF';
const sentinelsConfig = JSON.parse(readFileSync(join(__dirname, 'sentinels-config.json'), 'utf8'));

const tokens = loadTokens();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(makeRocpInit(tokens, DOMAIN_NANO), {
  access: tokens.access, refresh: tokens.refresh, expEpoch: tokens.expEpoch,
  state: randomUUID(), domainNano: DOMAIN_NANO,
});
const page = await context.newPage();
const deps = makeDeps(sentinelsConfig, { hashes: {}, data: {}, responseOk: {} });
console.log('→ archivando OV "Centinela" activas…');
await deps.doRestore(page, { sentinel: { entityType: 'receivedOrder' } });
await browser.close();
console.log('✓ cleanup hecho');
