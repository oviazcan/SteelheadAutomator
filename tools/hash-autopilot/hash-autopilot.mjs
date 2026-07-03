// tools/hash-autopilot/hash-autopilot.mjs
// Motor desatendido: abre chromium headless con la cookie de sesión, corre las
// recetas de click-recipes.json, intercepta /graphql y captura los hashes que el
// frontend usa hoy. (Comparación vs config + deploy: Tasks 6-7.)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { installInterceptor, runRecipe } from './recipe-runner.mjs';
import { classifyOp, planDeploy } from './hash-autopilot-core.mjs';
import { readConfigHashes } from './config-io.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../remote/config.json');
const RESULTS_DIR = join(__dirname, '../.hash-autopilot');
// Ops session-sensitive que validate-hashes.py (idp-token) no puede validar bien.
const TARGET_OPS = ['AllCustomers', 'Customer', 'CurrentUser', 'GetPurchaseOrder', 'AllSensorDashboards', 'SensorDashboardQuery'];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const domainArg = args.find((a) => a.startsWith('--domain='));
const DOMAIN = domainArg ? domainArg.split('=')[1] : '344';
const domainNanoArg = args.find((a) => a.startsWith('--domain-nano='));
const DOMAIN_NANO = domainNanoArg ? domainNanoArg.split('=')[1] : '1NFxmF';
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null;
// Fecha inyectable (para tests/reproducibilidad); default hoy.
const dateArg = args.find((a) => a.startsWith('--date='));
const RUN_DATE = dateArg ? dateArg.split('=')[1] : new Date().toISOString().slice(0, 10);

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
  const sink = { hashes: {}, data: {}, responseOk: {} };
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

  // Auth check: si no capturó NADA, la sesión no autenticó (tokens vencidos).
  if (Object.keys(sink.hashes).length === 0) {
    console.log('\n⚠️ 0 capturas — la sesión no autenticó (¿tokens ROCP vencidos? corre steelhead_auth.py).');
    persistResult({ date: RUN_DATE, authFailed: true, results: [], plan: null });
    process.exitCode = 2;
    return;
  }

  // Clasificar cada op target: liveHash capturado vs config; validación por
  // RESPUESTA capturada (responseOk = el frontend obtuvo data sin errors).
  const cfgHashes = readConfigHashes(CONFIG_PATH);
  const results = TARGET_OPS.map((op) => {
    const liveHash = sink.hashes[op] ?? null;
    const cfgHash = cfgHashes[op] ?? null;
    const ok = !!sink.responseOk[op];
    const verdict = classifyOp({ cfgHash, liveHash, http: ok ? 200 : null, shapeOk: ok });
    return { op, cfgHash, liveHash, responseOk: ok, verdict };
  });
  const plan = planDeploy(results, {});

  // Reporte
  console.log(`\n=== hash-autopilot ${RUN_DATE}${DRY ? ' (dry-run)' : ''} ===`);
  for (const r of results) {
    const tag = { vigente: '✓ vigente', rotadoValidado: '🔺 ROTÓ', sospechoso: '⚠️ sospechoso', noCapturado: '· no capturado' }[r.verdict];
    console.log(`  ${r.op.padEnd(22)} ${tag}${r.verdict === 'rotadoValidado' ? `  ${r.cfgHash?.slice(0, 8)}→${r.liveHash?.slice(0, 8)}` : ''}`);
  }
  if (plan.massBrake) console.log(`\n⚠️ ${plan.reason} — NO se deploya nada (revisión humana).`);
  if (plan.toDeploy.length) console.log(`\n🔺 Rotados validados: ${plan.toDeploy.map((r) => r.op).join(', ')}${DRY ? ' (dry-run: no deploya)' : ''}`);
  if (plan.notCaptured.length) console.log(`· No capturados (receta por afinar): ${plan.notCaptured.map((r) => r.op).join(', ')}`);

  persistResult({ date: RUN_DATE, authFailed: false, results, plan });

  // Auto-deploy de los rotados validados (salvo dry-run / freno de masa).
  let deployed = false;
  if (!DRY && plan.toDeploy.length && !plan.massBrake) {
    const pairs = plan.toDeploy.map((r) => `${r.op}=${r.liveHash}`);
    console.log(`\n→ Auto-deploy: ${pairs.join(' ')}`);
    try {
      execFileSync(join(__dirname, 'autopilot-deploy.sh'), pairs, { stdio: 'inherit' });
      deployed = true;
      console.log('✓ deploy OK');
    } catch (e) {
      console.log(`✗ auto-deploy falló (exit ${e.status ?? '?'}) — requiere revisión humana`);
    }
  }
  // Escalamiento (Task 9): recetas que no capturaron → señal para el cron de Claude.
  if (!DRY && plan.notCaptured.length) {
    writeNeedsAttention(plan.notCaptured, recipes, RUN_DATE);
  }

  // Notificación por correo (Task 8) — solo cuando hay algo que reportar.
  if (!DRY) {
    if (deployed) {
      const detalle = plan.toDeploy.map((r) => `• ${r.op}: ${r.cfgHash.slice(0, 8)}… → ${r.liveHash}`).join('\n');
      notify('exito', `${plan.toDeploy.length} hash(es) rotado(s) regenerado(s)`, `hash-autopilot detectó y deployó:\n\n${detalle}\n\nconfig.json bumpeado + gh-pages actualizado.`);
    } else if (plan.massBrake) {
      const rotados = results.filter((r) => r.verdict === 'rotadoValidado').map((r) => r.op).join(', ');
      notify('revision', 'freno de masa — no se deployó', `${plan.reason}.\n\nRotados: ${rotados}\n\nRevisa manualmente antes de deployar (posible captura corrupta o cambio grande de Steelhead).`);
    }
    if (plan.suspicious.length) {
      notify('revision', `${plan.suspicious.length} hash(es) sospechoso(s)`, `Difieren del config pero su respuesta no trajo data OK:\n${plan.suspicious.map((r) => `• ${r.op}`).join('\n')}\n\nRevisa con hash-scanner.`);
    }
    if (plan.notCaptured.length) {
      notify('fallo', `${plan.notCaptured.length} op(s) no capturada(s)`, `Las recetas no dispararon estas ops (posible cambio de UI):\n${plan.notCaptured.map((r) => `• ${r.op}`).join('\n')}\n\nSe dejó señal para re-descubrir la receta.`);
    }
  }
  return { results, plan, deployed };
}

function notify(tipo, asunto, cuerpo) {
  try { execFileSync(join(__dirname, 'autopilot-notify.sh'), [tipo, asunto, cuerpo], { stdio: 'inherit' }); }
  catch (e) { console.log(`(notify falló: ${String(e).slice(0, 80)})`); }
}

function writeNeedsAttention(notCaptured, recipes, date) {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const findRecipe = (op) => Object.entries(recipes).find(([, r]) => (r.captures || []).includes(op));
    const ops = notCaptured.map((r) => {
      const rec = findRecipe(r.op);
      return { op: r.op, recipeTried: rec ? rec[0] : null, steps: rec ? rec[1].steps : null, observed: 'la receta no disparó la op (0 capturas)' };
    });
    writeFileSync(join(RESULTS_DIR, 'needs-attention.json'), JSON.stringify({ date, ops }, null, 2));
    console.log(`  señal de escalamiento escrita (${ops.length} op).`);
  } catch (e) { console.log(`(no se pudo escribir needs-attention: ${String(e).slice(0, 80)})`); }
}

function persistResult(obj) {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${obj.date}.json`), JSON.stringify(obj, null, 2));
  } catch (e) { console.log(`(no se pudo persistir resultado: ${String(e).slice(0, 80)})`); }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
