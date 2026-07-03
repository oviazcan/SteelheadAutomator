// tools/hash-autopilot/hash-autopilot.mjs
// Motor desatendido: abre chromium headless con la cookie de sesión, corre las
// recetas de click-recipes.json, intercepta /graphql y captura los hashes que el
// frontend usa hoy. (Comparación vs config + deploy: Tasks 6-7.)
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { installInterceptor, runRecipe } from './recipe-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const domainArg = args.find((a) => a.startsWith('--domain='));
const DOMAIN = domainArg ? domainArg.split('=')[1] : '344';
const domainNanoArg = args.find((a) => a.startsWith('--domain-nano='));
const DOMAIN_NANO = domainNanoArg ? domainNanoArg.split('=')[1] : '1NFxmF';
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null;

// Tokens OAuth de Reportes SH (steelhead_auth los mantiene frescos vía refresh).
// El frontend usa react-oauth2-code-pkce → guarda los tokens en localStorage con
// prefijo ROCP_. Inyectándolos, la SPA arranca logueada sin el flujo OAuth
// interactivo (que redirige a auth.gosteelhead.com en un contexto limpio).
const TOKENS_PATH = '/Users/oviazcan/Projects/Ecoplating/Reportes SH/.cache/tokens.json';
function loadTokens() {
  const t = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  if (!t.access_token) throw new Error('access_token vacío en .cache/tokens.json — corre steelhead_auth.py');
  return { access: t.access_token, refresh: t.refresh_token, expEpoch: Number(t.expires_at) };
}

// addInitScript que puebla localStorage ROCP_* ANTES de que la app cargue.
function makeRocpInit(tokens, domainNano) {
  return ({ access, refresh, expEpoch, state, domainNano }) => {
    const q = (s) => JSON.stringify(s); // ROCP guarda tokens como JSON string
    localStorage.setItem('ROCP_token', q(access));
    localStorage.setItem('ROCP_refreshToken', q(refresh));
    localStorage.setItem('ROCP_tokenExpire', String(expEpoch));
    localStorage.setItem('ROCP_refreshTokenExpire', String(expEpoch + 30 * 24 * 3600));
    localStorage.setItem('ROCP_auth_state', state);
    localStorage.setItem('ROCP_loginInProgress', 'false');
    localStorage.setItem('selectedDomainNanoId', domainNano);
  };
}

async function main() {
  const recipesDoc = JSON.parse(readFileSync(join(__dirname, 'click-recipes.json'), 'utf8'));
  const recipes = recipesDoc.recipes;
  const tokens = loadTokens();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(makeRocpInit(tokens, DOMAIN_NANO), {
    access: tokens.access, refresh: tokens.refresh, expEpoch: tokens.expEpoch,
    state: randomUUID(), domainNano: DOMAIN_NANO,
  });
  const page = await context.newPage();
  const sink = { hashes: {}, data: {} };
  await installInterceptor(page, sink);

  for (const [name, recipe] of Object.entries(recipes)) {
    if (ONLY && !(recipe.captures || []).includes(ONLY)) continue;
    try {
      console.log(`→ receta "${name}" (captura: ${(recipe.captures || []).join(', ')})`);
      await runRecipe(page, recipe, DOMAIN, sink);
      const got = (recipe.captures || []).filter((op) => sink.hashes[op]);
      console.log(`   capturó: ${got.length ? got.join(', ') : '(nada aún)'}`);
    } catch (e) {
      console.log(`  ⚠️ receta "${name}" falló: ${String(e).slice(0, 120)}`);
    }
  }

  await browser.close();
  console.log(`\nHashes capturados${DRY ? ' (dry-run)' : ''}:`);
  console.log(JSON.stringify(sink.hashes, null, 2));
  if (Object.keys(sink.hashes).length === 0) {
    console.log('\n⚠️ 0 capturas — la cookie no autenticó o las recetas no dispararon nada.');
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
