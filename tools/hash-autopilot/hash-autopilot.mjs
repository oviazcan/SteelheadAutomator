// tools/hash-autopilot/hash-autopilot.mjs
// Motor desatendido: lee el resultado del validator del día, calcula qué ops hay
// que capturar (route-planner.opsToCapture), planea el set MÍNIMO de rutas de
// route-catalog.json que las cubre (selectRoutes), abre chromium headless con la
// cookie de sesión, corre SOLO esas rutas, intercepta /graphql y captura los
// hashes que el frontend usa hoy. (Comparación vs config + deploy: Tasks 6-7.)
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { installInterceptor, runRecipe } from './recipe-runner.mjs';
import { classifyOp, planDeploy } from './hash-autopilot-core.mjs';
import { readConfigHashes } from './config-io.mjs';
import { selectRoutes, opsToCapture, staleMutations } from './route-planner.mjs';
import { pendingRepairs, journalClose } from './sentinels.mjs';
import { appletsForOp, formatOpLine } from './applet-attribution.mjs';
import { classifyProbe, summarizeProbes, gateByProbe } from './probe-classify.mjs';
import { probeOnPage } from './probe-run.mjs';
import { fetchProductUpdates, formatUpdatesContext } from './product-updates.mjs';

// Fecha YYYY-MM-DD en hora LOCAL — debe coincidir con la que validate-hashes.py
// usa para nombrar tools/.hash-validation/<date>.json (datetime.now(), local). NO
// usar toISOString() (UTC): en UTC-6 de tarde/noche apunta al día siguiente y el
// motor no halla el archivo del validator → descartaría las stale queries.
export function dateStrLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../remote/config.json');
const SCRIPTS_DIR = join(__dirname, '../../remote/scripts');
const RESULTS_DIR = join(__dirname, '../.hash-autopilot');

// Carga el contenido de remote/scripts/*.js (nombre→fuente) para atribuir cada op
// rota/no-capturada a los applets que TRUENAN. Fail-safe: si no hay scripts, {}.
function loadScriptSources() {
  const out = {};
  try {
    for (const f of readdirSync(SCRIPTS_DIR)) {
      if (!f.endsWith('.js')) continue;
      out[f.replace(/\.js$/, '')] = readFileSync(join(SCRIPTS_DIR, f), 'utf8');
    }
  } catch { /* sin carpeta de scripts → sin atribución */ }
  return out;
}
function loadKnownOperations() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).knownOperations || {}; }
  catch { return {}; }
}
// Session-sensitive: el validator (idp-token) no las puede ver → se capturan
// SIEMPRE que haya release. El resto se capturan solo si el validator las marcó stale.
const SESSION_SENSITIVE = ['AllCustomers', 'Customer', 'CurrentUser', 'GetPurchaseOrderDetail', 'AllSensorDashboards', 'SensorDashboardQuery'];

// Lee el JSON del validator del día (lo escribe validate-hashes.py). Si no existe
// (no corrió, o corrió sin stale), devuelve {stale:[]} → solo session-sensitive.
function loadValidatorResult(date) {
  try {
    const p = join(__dirname, '../.hash-validation', `${date}.json`);
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return { stale: [] }; }
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_DEPLOY = args.includes('--no-deploy'); // ejecuta los ciclos pero NO deploya (validación supervisada)
const domainArg = args.find((a) => a.startsWith('--domain='));
const DOMAIN = domainArg ? domainArg.split('=')[1] : '344';
const domainNanoArg = args.find((a) => a.startsWith('--domain-nano='));
const DOMAIN_NANO = domainNanoArg ? domainNanoArg.split('=')[1] : '1NFxmF';
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null;
// Fecha inyectable (para tests/reproducibilidad); default hoy.
const dateArg = args.find((a) => a.startsWith('--date='));
const RUN_DATE = dateArg ? dateArg.split('=')[1] : dateStrLocal(new Date());

// Tokens OAuth de Reportes SH (steelhead_auth los mantiene frescos vía refresh).
// El frontend usa react-oauth2-code-pkce → guarda los tokens en localStorage con
// prefijo ROCP_. Inyectándolos, la SPA arranca logueada sin el flujo OAuth
// interactivo (que redirige a auth.gosteelhead.com en un contexto limpio).
const TOKENS_PATH = '/Users/oviazcan/Projects/Ecoplating/Reportes SH/.cache/tokens.json';
export function loadTokens() {
  const t = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  if (!t.access_token) throw new Error('access_token vacío en .cache/tokens.json — corre steelhead_auth.py');
  return { access: t.access_token, refresh: t.refresh_token, expEpoch: Number(t.expires_at) };
}

// addInitScript que puebla localStorage ROCP_* ANTES de que la app cargue.
export function makeRocpInit(tokens, domainNano) {
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
  const catalog = JSON.parse(readFileSync(join(__dirname, 'route-catalog.json'), 'utf8'));
  const validatorResult = loadValidatorResult(RUN_DATE);
  const wantOps = opsToCapture(validatorResult, SESSION_SENSITIVE);
  const plan0 = selectRoutes(wantOps, catalog);
  const staleMuts = staleMutations(validatorResult);
  // Fase C: mutations stale con sentinela declarado (entidad con la op en _para/opsGroup + id real).
  const sentinelsConfig = JSON.parse(readFileSync(join(__dirname, 'sentinels-config.json'), 'utf8'));
  const mutEntityType = (op) => {
    for (const [type, e] of Object.entries(sentinelsConfig.entities || {})) {
      if (e && e.id && ((e._para || []).includes(op) || (e.opsGroup || []).includes(op))) return type;
    }
    return null;
  };
  const capturableMuts = staleMuts.filter((op) => mutEntityType(op));
  console.log(`Ops a capturar (${wantOps.length}): ${wantOps.join(', ')}`);
  console.log(`Rutas seleccionadas (${plan0.routes.length}): ${plan0.routes.map((r) => r.id).join(', ') || '(ninguna)'}`);
  if (plan0.uncovered.length) console.log(`⚠️ Queries stale SIN ruta en catálogo: ${plan0.uncovered.join(', ')} (Fase B)`);
  if (staleMuts.length) console.log(`⚠️ Mutations stale (Fase C — ciclo sentinela): ${staleMuts.join(', ')}`);

  // Ops que sabemos que aún NO tienen ruta (session-sensitive sin cobertura en el
  // catálogo) → hueco conocido pendiente de Fase B. Se loguean pero NO generan
  // correo cada release (evita ruido que entrena a ignorar las alertas reales).
  const catalogCaptures = new Set(Object.values(catalog.routes).flatMap((r) => r.captures || []));
  const knownNoRoute = new Set(SESSION_SENSITIVE.filter((op) => !catalogCaptures.has(op)));
  if (knownNoRoute.size) console.log(`(hueco conocido sin ruta, Fase B — no se alerta: ${[...knownNoRoute].join(', ')})`);

  const tokens = loadTokens();
  // Import dinámico de playwright: deja el módulo importable SIN la dependencia
  // (tests puros de dateStrLocal, o entornos sin node_modules) — playwright solo
  // se resuelve cuando main() realmente abre el navegador.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(makeRocpInit(tokens, DOMAIN_NANO), {
    access: tokens.access, refresh: tokens.refresh, expEpoch: tokens.expEpoch,
    state: randomUUID(), domainNano: DOMAIN_NANO,
  });
  const page = await context.newPage();
  const sink = { hashes: {}, data: {}, responseOk: {} };
  await installInterceptor(page, sink);

  // Contexto ANTES de auto-corregir: leer /ProductUpdates para PISTAS de qué cambió
  // en Steelhead (ayuda a entender/atribuir una rotación). Fail-safe: si truena,
  // sigue sin contexto.
  let productUpdates = { entries: [], snippet: '', title: '', url: '' };
  try {
    productUpdates = await fetchProductUpdates(page);
    const nEnt = (productUpdates.entries || []).length;
    console.log(`\n=== ProductUpdates (contexto) === ${nEnt} entrada(s) | bodyLen=${productUpdates.bodyLen || 0} | "${productUpdates.title || ''}" | ${productUpdates.url || ''}`);
    if (nEnt) console.log(`   e.g.: ${(productUpdates.entries[0] || '').slice(0, 120)}`);
  } catch (e) { console.log(`(ProductUpdates falló: ${String(e).slice(0, 80)} — sin contexto)`); }

  for (const route of plan0.routes) {
    if (ONLY && !(route.captures || []).includes(ONLY)) continue;
    try {
      console.log(`→ ruta "${route.id}" (captura: ${(route.captures || []).join(', ')})`);
      await runRecipe(page, route, DOMAIN, sink);
      const got = (route.captures || []).filter((op) => sink.hashes[op]);
      console.log(`   capturó: ${got.length ? got.join(', ') : '(nada aún)'}`);
    } catch (e) {
      console.log(`  ⚠️ ruta "${route.id}" falló: ${String(e).slice(0, 120)}`);
    }
  }

  // ── Fase C: capturar mutations stale vía ciclos sentinela headless ──────────
  if (capturableMuts.length) {
    const { runMutationCycle } = await import('./mutation-runner.mjs');
    const { makeDeps } = await import('./mutation-deps.mjs');
    const deps = makeDeps(sentinelsConfig, sink);
    // Reparar ciclos sucios de una corrida previa interrumpida ANTES de abrir nuevos.
    for (const rep of pendingRepairs(deps.readJournal())) {
      console.log(`  ⚠️ ciclo sentinela sucio previo: ${rep.entityType}/${rep.op} — restaurando`);
      try {
        await deps.doRestore(page, { sentinel: { entityType: rep.entityType } });
        deps.writeJournal(journalClose(deps.readJournal(), rep.entityType));
      } catch (e) { console.log(`     no se pudo restaurar ${rep.entityType}: ${String(e).slice(0, 80)}`); }
    }
    for (const op of capturableMuts) {
      if (ONLY && op !== ONLY) continue;
      const entityType = mutEntityType(op);
      if (DRY) { console.log(`→ (dry) ciclo mutation "${op}" sobre sentinela ${entityType} #${sentinelsConfig.entities[entityType].id}`); continue; }
      const route = { captures: [op], sentinel: { entityType } };
      try {
        console.log(`→ ciclo mutation "${op}" sobre sentinela ${entityType}`);
        const res = await runMutationCycle(page, route, sentinelsConfig, sink, deps);
        console.log(`   ${res.captured ? 'capturó ' + op : 'no capturó (' + (res.reason || 'sin hash') + ')'}`);
      } catch (e) {
        console.log(`  ⚠️ ciclo "${op}" falló: ${String(e).slice(0, 120)}`);
        await page.screenshot({ path: `/tmp/sa-cycle-fail-${op}.png`, fullPage: true }).catch(() => {});
      }
      if (process.env.SA_DBG) console.log(`   [dbg] sink tras ciclo: ${JSON.stringify(Object.keys(sink.hashes))}`);
    }
  }

  // ── Probe directo: señal PRIMARIA de rotación real ──────────────────────────
  // Prueba el hash DEL CONFIG de cada op target directo contra /graphql (cookie de
  // sesión, en la page ya autenticada). "Must provide a query string" = STALE de
  // verdad. Distingue rotación real de "el page.goto no disparó la op" (falsa
  // alarma que hacía llorar al correo). Fail-open si truena → gating desactivado.
  let probeVerdicts = {};
  try {
    // CLAVE: quitar el interceptor ANTES de probar. Si sigue activo, captura las
    // requests del propio probe (que llevan el hash DEL CONFIG) y contamina
    // sink.hashes → classifyOp creería "capturado==config==vigente" en todas y el
    // gating se quedaría sin notCaptured. El unroute deja la captura ya hecha intacta.
    await page.unroute('**/*graphql*').catch(() => {});
    // Estabilizar la page antes de probar: ir a un app page conocido (una receta
    // pudo dejarla a media navegación fallida → "Execution context destroyed").
    await page.goto(`https://app.gosteelhead.com/Domains/${DOMAIN}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    const cfgForProbe = readConfigHashes(CONFIG_PATH);
    const probeEntries = [...new Set([...wantOps, ...plan0.uncovered])]
      .filter((op) => cfgForProbe[op]).map((op) => [op, cfgForProbe[op]]);
    if (probeEntries.length) {
      const rawProbe = await probeOnPage(page, probeEntries);
      const classified = rawProbe.map((r) => ({ op: r.op, verdict: classifyProbe(r) }));
      for (const c of classified) probeVerdicts[c.op] = c.verdict;
      const psum = summarizeProbes(classified);
      console.log(`\n=== probe directo (señal primaria de rotación) ===`);
      console.log(`  🔺 STALE real: ${psum.stale.join(', ') || '(ninguna)'} | ✓ vigentes: ${psum.vigente.length} | ⚠️ auth/unknown: ${psum.auth.length + psum.unknown.length}`);
    }
  } catch (e) { console.log(`(probe falló: ${String(e).slice(0, 80)} — fail-open, sin gating)`); probeVerdicts = {}; }

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
  const results = [...wantOps, ...capturableMuts].map((op) => {
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

  persistResult({ date: RUN_DATE, authFailed: false, results, plan, probeVerdicts, productUpdates: { entries: productUpdates.entries || [], url: productUpdates.url || '' } });

  // Auto-deploy de los rotados validados (salvo dry-run / freno de masa).
  let deployed = false;
  if (!DRY && !NO_DEPLOY && plan.toDeploy.length && !plan.massBrake) {
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
  // Excluye los huecos conocidos (SESSION_SENSITIVE sin ruta) de la señal de
  // escalamiento y de la notificación — son estáticos, no un cambio de UI nuevo.
  const notCapturedNew = plan.notCaptured.filter((r) => !knownNoRoute.has(r.op));

  // Gating por probe (señal primaria): de las no-capturadas, separa rotación REAL
  // (probe 'stale') de FALSA ALARMA (probe 'vigente' = el hash del config vive; el
  // page.goto solo no disparó la op). Las vigentes se SUPRIMEN (fin del "cry wolf");
  // stale + no-concluyentes (auth/unknown/sin probe) se escalan. probeVerdicts vacío
  // = fail-open (todo se escala como antes). Las 'stale' que no capturamos son las
  // ROTACIONES REALES que urge atender (habrían cazado SearchUnits/GetInventoryItem).
  const gate = gateByProbe(notCapturedNew.map((r) => r.op), probeVerdicts);
  const escalateSet = new Set([...gate.realStale, ...gate.unconfirmed]);
  const notCapturedEscalate = notCapturedNew.filter((r) => escalateSet.has(r.op));
  const realStaleRows = notCapturedNew.filter((r) => gate.realStale.includes(r.op));
  const unconfirmedRows = notCapturedNew.filter((r) => gate.unconfirmed.includes(r.op));
  if (gate.falseAlarms.length) console.log(`  (falsas alarmas suprimidas — probe=vigente: ${gate.falseAlarms.join(', ')})`);

  // Mutations stale que el ciclo sentinela NO resolvió (sin handler DOM, o el ciclo
  // no capturó el hash) → siguen requiriendo captura manual. Las que Fase C SÍ
  // capturó/deployó ya salen en "CORREGIDAS Y DEPLOYADAS" y NO deben reportarse
  // como pendientes (bug 2026-07-09: antes se listaban TODAS las staleMuts → el
  // correo se contradecía "deployadas 2" vs "pendientes 3" y el asunto inflaba el
  // conteo de pendientes).
  const mutVerdict = (op) => (results.find((r) => r.op === op) || {}).verdict;
  const pendingMuts = staleMuts.filter((op) => {
    const v = mutVerdict(op);
    return !v || v === 'noCapturado';
  });

  // Escalamiento (Task 9): rutas que no capturaron → señal para el cron de Claude.
  // Solo las escalables (rotación real + no-concluyentes); las falsas alarmas
  // (probe=vigente) NO gastan el cron.
  if (!DRY && notCapturedEscalate.length) {
    writeNeedsAttention(notCapturedEscalate, catalog.routes, RUN_DATE);
  }

  // Notificación por correo — UN solo correo con el reporte completo de éxito/fallo.
  // (Antes se mandaban hasta 6 correos separados; ahora se consolida en un reporte único.)
  const uncoveredNew = plan0.uncovered.filter((op) => !knownNoRoute.has(op));
  if (!DRY) {
    // Atribución op→applet: qué applets de remote/scripts truenan si la op rota/no
    // se captura. Se resuelve por grep de los .js (fallback: config.knownOperations.usedBy).
    const scriptSources = loadScriptSources();
    const knownOps = loadKnownOperations();
    const appletsOf = (op) => appletsForOp(op, scriptSources, (knownOps[op] || {}).usedBy || '');
    const line = (op) => `   • ${formatOpLine(op, appletsOf(op))}`;
    const sec = [];
    if (deployed && plan.toDeploy.length) {
      sec.push(`✅ CORREGIDAS Y DEPLOYADAS (${plan.toDeploy.length}):\n${plan.toDeploy.map((r) => `   • ${r.op}: ${r.cfgHash.slice(0, 8)}… → ${r.liveHash.slice(0, 8)}… — applets: ${appletsOf(r.op).join(', ') || '—'}`).join('\n')}`);
    }
    if (plan.massBrake) {
      const rotados = results.filter((r) => r.verdict === 'rotadoValidado').map((r) => r.op).join(', ');
      sec.push(`⚠️ FRENO DE MASA — NO se deployó (${plan.reason}):\n   Rotados detectados: ${rotados}\n   Revisa manualmente (posible captura corrupta o cambio grande de Steelhead).`);
    }
    if (plan.suspicious.length) {
      sec.push(`⚠️ SOSPECHOSOS (${plan.suspicious.length}) — difieren del config pero su respuesta no trajo data OK:\n${plan.suspicious.map((r) => line(r.op)).join('\n')}`);
    }
    if (realStaleRows.length) {
      sec.push(`🔺 ROTACIONES REALES SIN CAPTURAR (${realStaleRows.length}) — el probe confirma el hash del config MUERTO y el motor no capturó el nuevo (captura pendiente por scan/receta). URGE:\n${realStaleRows.map((r) => line(r.op)).join('\n')}`);
    }
    if (unconfirmedRows.length) {
      sec.push(`❓ NO CAPTURADAS, PROBE NO CONCLUYENTE (${unconfirmedRows.length}) — ni se capturó ni el probe pudo confirmar (auth/red). Revisar:\n${unconfirmedRows.map((r) => line(r.op)).join('\n')}`);
    }
    // Las falsas alarmas (probe=vigente) NO van al correo — son el ruido que
    // causaba el "cry wolf". Quedan solo en el log de consola (arriba).
    if (uncoveredNew.length) {
      sec.push(`❌ QUERIES SIN RUTA (${uncoveredNew.length}) — stale sin ruta en route-catalog.json:\n${uncoveredNew.map((op) => line(op)).join('\n')}`);
    }
    if (pendingMuts.length) {
      sec.push(`🔧 MUTATIONS ROTADAS SIN CAPTURAR (${pendingMuts.length}) — el ciclo sentinela no las resolvió (sin handler DOM o el ciclo no capturó el hash); requieren captura manual:\n${pendingMuts.map((op) => line(op)).join('\n')}`);
    }
    if (sec.length) {
      const nCorregidas = deployed ? plan.toDeploy.length : 0;
      const nPendientes = notCapturedEscalate.length + uncoveredNew.length + pendingMuts.length + plan.suspicious.length;
      const tipo = plan.massBrake ? 'revision' : nPendientes === 0 ? 'exito' : nCorregidas > 0 ? 'revision' : 'fallo';
      const asunto = `hash-autopilot: ${nCorregidas} corregida(s), ${nPendientes} pendiente(s)`;
      const ctx = formatUpdatesContext(productUpdates);
      const cuerpo = `=== hash-autopilot · ${RUN_DATE} ===\n\n${sec.join('\n\n')}${ctx ? '\n\n' + ctx : ''}\n${deployed ? '\nconfig.json bumpeado + gh-pages actualizado.' : ''}`;
      // Correo SOLO en corrida productiva. En modo prueba (--dry-run/--no-deploy/--only)
      // no se notifica: son corridas de depuración y el reporte es parcial/engañoso.
      if (DRY || NO_DEPLOY || ONLY) {
        console.log(`  (correo suprimido — modo prueba. Asunto habría sido: "${asunto}")`);
      } else {
        notify(tipo, asunto, cuerpo);
      }
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error('fatal:', e); process.exit(1); });
