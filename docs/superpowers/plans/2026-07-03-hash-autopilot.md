# hash-autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un job diario headless que captura los hashes que el frontend de Steelhead usa hoy para las ops session-sensitive (whitelisted), los compara contra `config.json`, y auto-regenera+deploya cuando rotan — con escalamiento a Claude si una secuencia de captura se rompe.

**Architecture:** Motor Playwright desatendido (`hash-autopilot.mjs`) que inyecta la cookie de sesión, corre "recetas" de navegación mínimas (`click-recipes.json`) para disparar cada op, intercepta `/graphql` y captura el `sha256Hash`. Un núcleo puro (`hash-autopilot-core.mjs`) clasifica los resultados y decide el deploy con salvaguardas. El caso feliz auto-deploya vía `tools/deploy.sh` y notifica por correo; un fallo de captura escribe una señal que un cron condicional de Claude atiende.

**Tech Stack:** Node.js (ESM `.mjs`), Playwright (chromium headless), `node:test`, bash, launchd, osascript (Mail.app). Reutiliza la técnica de `../steelhead-interceptor/intercept.mjs`.

## Global Constraints

- Auth headless vía `STEELHEAD_COOKIE_STRING` del `.env` de `/Users/oviazcan/Projects/Ecoplating/Reportes SH/` (NUNCA hardcodear ni loguear el valor).
- Deploy SOLO vía `tools/deploy.sh` (bump + espejo gh-pages + push + check); nunca a mano.
- Un hash se deploya solo si: nuevo ≠ config **Y** re-ejecución da HTTP `200` **Y** trae las llaves `expectShape`.
- **Freno de masa:** si rotan **> 6** ops en una corrida → NO deploya nada, correo de revisión humana.
- Respeta el candado de deploy: si hay WIP ajeno en `main:remote/`, stashea o aborta; nunca lo pisa. Respeta el hook `pre-push`.
- Ops target iniciales (whitelisted): `AllCustomers`, `Customer`, `CurrentUser`, `GetPurchaseOrder`, `AllSensorDashboards`, `SensorDashboardQuery`.
- domainId de Ecoplating en URLs: `344` (parametrizable vía `--domain`).
- Resultados de corrida en `tools/.hash-autopilot/` (gitignored). Bitácora commiteada: `docs/api/hash-validation-log.md`.
- Idioma: docs/UI/correos en español; código/variables en inglés.

---

### Task 1: Scaffolding del proyecto hash-autopilot

**Files:**
- Create: `tools/hash-autopilot/package.json`
- Create: `tools/hash-autopilot/click-recipes.json`
- Create: `tools/hash-autopilot/README.md`
- Modify: `.gitignore` (agregar `tools/.hash-autopilot/` y `tools/hash-autopilot/node_modules/` y `tools/hash-autopilot/.browser-state/`)

**Interfaces:**
- Produces: `click-recipes.json` con 2 recetas iniciales conocidas; carpeta lista con playwright instalado.

- [ ] **Step 1: Crear `package.json`**

```json
{
  "name": "hash-autopilot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Validación + regeneración desatendida de hashes session-sensitive de Steelhead",
  "scripts": {
    "start": "node hash-autopilot.mjs",
    "dry-run": "node hash-autopilot.mjs --dry-run",
    "install-browser": "playwright install chromium"
  },
  "dependencies": {
    "playwright": "^1.57.0"
  }
}
```

- [ ] **Step 2: Instalar deps + chromium**

Run:
```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/hash-autopilot && npm install && npx playwright install chromium
```
Expected: instala playwright y descarga el browser sin error.

- [ ] **Step 3: Crear `click-recipes.json` con las 2 recetas ya descubiertas (2026-07-03)**

```json
{
  "_doc": "Secuencias MÍNIMAS de navegación para que el frontend dispare cada op y capturemos su sha256Hash. Organizado por pantalla (una navegación cubre varias ops). captures = ops que la receta debe capturar. validateVars/expectShape = para validar el hash nuevo re-ejecutándolo.",
  "_domainDefault": "344",
  "recipes": {
    "customers-list": {
      "steps": [{ "goto": "/Domains/{domain}/Customers" }],
      "captures": ["AllCustomers"],
      "validateVars": {
        "AllCustomers": { "includeArchived": "NO", "includeAccountingFields": false, "orderBy": ["NAME_ASC"], "offset": 0, "first": 5, "searchQuery": "" }
      },
      "expectShape": { "AllCustomers": ["pagedData.nodes", "pagedData.totalCount"] }
    },
    "customer-detail": {
      "steps": [
        { "goto": "/Domains/{domain}/Customers" },
        { "clickFirst": "a[href*='/Customers/']", "hrefMatches": "/Customers/\\d+" }
      ],
      "captures": ["Customer"],
      "validateVars": { "Customer": {} },
      "expectShape": { "Customer": [] }
    }
  }
}
```

- [ ] **Step 4: Crear `README.md` breve** (qué es, cómo correr `npm run dry-run`, dónde ver resultados, cómo se agenda). Contenido mínimo:

```markdown
# hash-autopilot
Job desatendido que valida y regenera los hashes session-sensitive de Steelhead
(los que `validate-hashes.py` no puede validar desde Python). Ver diseño:
`docs/superpowers/specs/2026-07-03-hash-autopilot-design.md`.

- Correr manual (sin deployar): `npm run dry-run`
- Correr real: `npm start`
- Resultados: `tools/.hash-autopilot/YYYY-MM-DD.json`
- Recetas de navegación: `click-recipes.json`
```

- [ ] **Step 5: Actualizar `.gitignore`**

Agregar:
```
tools/.hash-autopilot/
tools/hash-autopilot/node_modules/
tools/hash-autopilot/.browser-state/
```

- [ ] **Step 6: Commit**

```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
git add tools/hash-autopilot/package.json tools/hash-autopilot/click-recipes.json tools/hash-autopilot/README.md .gitignore
git commit -m "feat(hash-autopilot): scaffolding + recetas iniciales AllCustomers/Customer"
```

---

### Task 2: Núcleo puro — clasificación de veredictos (TDD)

**Files:**
- Create: `tools/hash-autopilot/hash-autopilot-core.mjs`
- Test: `tools/test/hash-autopilot-core.test.js`

**Interfaces:**
- Produces:
  - `classifyOp({ cfgHash, liveHash, http, shapeOk }) → 'vigente'|'rotadoValidado'|'sospechoso'|'noCapturado'`
  - `hasShape(dataObj, paths) → boolean` (paths tipo `"pagedData.nodes"`; `[]` → siempre true)

- [ ] **Step 1: Escribir el test que falla**

```js
// tools/test/hash-autopilot-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOp, hasShape } = require('../hash-autopilot/hash-autopilot-core.mjs');

test('classifyOp: capturado igual al config → vigente', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'aaa', http: 200, shapeOk: true }), 'vigente');
});
test('classifyOp: distinto + 200 + shape ok → rotadoValidado', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 200, shapeOk: true }), 'rotadoValidado');
});
test('classifyOp: distinto pero http 400 → sospechoso (no se deploya)', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 400, shapeOk: false }), 'sospechoso');
});
test('classifyOp: distinto + 200 pero sin shape → sospechoso', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 200, shapeOk: false }), 'sospechoso');
});
test('classifyOp: no capturado (liveHash null) → noCapturado', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: null, http: null, shapeOk: false }), 'noCapturado');
});

test('hasShape: todas las llaves presentes → true', () => {
  assert.equal(hasShape({ pagedData: { nodes: [], totalCount: 3 } }, ['pagedData.nodes', 'pagedData.totalCount']), true);
});
test('hasShape: llave ausente → false', () => {
  assert.equal(hasShape({ pagedData: {} }, ['pagedData.nodes']), false);
});
test('hasShape: paths vacío → true (op sin shape declarado)', () => {
  assert.equal(hasShape({ anything: 1 }, []), true);
});
```

- [ ] **Step 2: Correr el test → debe fallar**

Run: `node --test tools/test/hash-autopilot-core.test.js`
Expected: FAIL ("Cannot find module ...hash-autopilot-core.mjs" o export undefined).

- [ ] **Step 3: Implementar el mínimo**

```js
// tools/hash-autopilot/hash-autopilot-core.mjs
// Núcleo PURO (sin Playwright, sin red) — testeable con node:test.

export function hasShape(dataObj, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  const get = (o, path) => path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), o);
  return paths.every((p) => get(dataObj, p) !== undefined);
}

export function classifyOp({ cfgHash, liveHash, http, shapeOk }) {
  if (liveHash == null) return 'noCapturado';
  if (liveHash === cfgHash) return 'vigente';
  if (http === 200 && shapeOk) return 'rotadoValidado';
  return 'sospechoso';
}
```

- [ ] **Step 4: Correr el test → debe pasar**

Run: `node --test tools/test/hash-autopilot-core.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/hash-autopilot-core.mjs tools/test/hash-autopilot-core.test.js
git commit -m "feat(hash-autopilot): núcleo classifyOp + hasShape con tests"
```

---

### Task 3: Núcleo puro — decisión de deploy + freno de masa + cobertura (TDD)

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot-core.mjs`
- Modify: `tools/test/hash-autopilot-core.test.js`

**Interfaces:**
- Consumes: `classifyOp` (Task 2).
- Produces:
  - `planDeploy(results, { massBrakeThreshold = 6 }) → { toDeploy, suspicious, notCaptured, massBrake, reason }` donde `results` es `[{ op, verdict, cfgHash, liveHash }]`.
  - `missingCoverage(recipes, targetOps) → string[]` (ops sin receta que las capture).

- [ ] **Step 1: Escribir los tests que fallan**

```js
// añadir a tools/test/hash-autopilot-core.test.js
const { planDeploy, missingCoverage } = require('../hash-autopilot/hash-autopilot-core.mjs');

const R = (op, verdict) => ({ op, verdict, cfgHash: 'old', liveHash: verdict === 'vigente' ? 'old' : 'new' });

test('planDeploy: solo rotadoValidado va a toDeploy', () => {
  const res = [R('A', 'rotadoValidado'), R('B', 'vigente'), R('C', 'sospechoso'), R('D', 'noCapturado')];
  const p = planDeploy(res, {});
  assert.deepEqual(p.toDeploy.map(x => x.op), ['A']);
  assert.deepEqual(p.suspicious.map(x => x.op), ['C']);
  assert.deepEqual(p.notCaptured.map(x => x.op), ['D']);
  assert.equal(p.massBrake, false);
});
test('planDeploy: >6 rotados dispara freno de masa (no deploya nada)', () => {
  const res = Array.from({ length: 7 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, true);
  assert.deepEqual(p.toDeploy, []);
  assert.match(p.reason, />6|freno|masa/i);
});
test('planDeploy: exactamente 6 rotados NO dispara freno', () => {
  const res = Array.from({ length: 6 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, false);
  assert.equal(p.toDeploy.length, 6);
});

test('missingCoverage: detecta ops target sin receta', () => {
  const recipes = { r1: { captures: ['AllCustomers'] }, r2: { captures: ['Customer'] } };
  const target = ['AllCustomers', 'Customer', 'CurrentUser'];
  assert.deepEqual(missingCoverage(recipes, target), ['CurrentUser']);
});
test('missingCoverage: todo cubierto → []', () => {
  const recipes = { r1: { captures: ['A', 'B'] } };
  assert.deepEqual(missingCoverage(recipes, ['A', 'B']), []);
});
```

- [ ] **Step 2: Correr → falla**

Run: `node --test tools/test/hash-autopilot-core.test.js`
Expected: FAIL (planDeploy/missingCoverage undefined).

- [ ] **Step 3: Implementar**

```js
// añadir a tools/hash-autopilot/hash-autopilot-core.mjs

export function planDeploy(results, opts = {}) {
  const threshold = opts.massBrakeThreshold ?? 6;
  const rotated = results.filter((r) => r.verdict === 'rotadoValidado');
  const suspicious = results.filter((r) => r.verdict === 'sospechoso');
  const notCaptured = results.filter((r) => r.verdict === 'noCapturado');
  if (rotated.length > threshold) {
    return { toDeploy: [], suspicious, notCaptured, massBrake: true,
             reason: `Freno de masa: ${rotated.length} > ${threshold} rotados en una corrida` };
  }
  return { toDeploy: rotated, suspicious, notCaptured, massBrake: false, reason: null };
}

export function missingCoverage(recipes, targetOps) {
  const covered = new Set();
  for (const r of Object.values(recipes || {})) {
    for (const op of (r.captures || [])) covered.add(op);
  }
  return targetOps.filter((op) => !covered.has(op));
}
```

- [ ] **Step 4: Correr → pasa**

Run: `node --test tools/test/hash-autopilot-core.test.js`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/hash-autopilot-core.mjs tools/test/hash-autopilot-core.test.js
git commit -m "feat(hash-autopilot): planDeploy con freno de masa >6 + missingCoverage"
```

---

### Task 4: Motor Playwright — auth por cookie + interceptor + ejecutar receta

**Files:**
- Create: `tools/hash-autopilot/hash-autopilot.mjs`
- Create: `tools/hash-autopilot/recipe-runner.mjs`

**Interfaces:**
- Consumes: `click-recipes.json`, `STEELHEAD_COOKIE_STRING`.
- Produces:
  - `recipe-runner.mjs` export `runRecipe(page, recipe, domain) → { capturedHashes: {op:hash}, capturedData: {op:responseData} }`
  - `hash-autopilot.mjs` CLI: `node hash-autopilot.mjs [--dry-run] [--domain=344] [--only=AllCustomers]` que abre chromium headless con cookie, corre todas las recetas, imprime lo capturado. (Comparación/deploy vienen en Tasks 6-7.)

- [ ] **Step 1: Implementar `recipe-runner.mjs`** (instala interceptor en la page, ejecuta pasos, recoge hashes)

```js
// tools/hash-autopilot/recipe-runner.mjs
const BASE = 'https://app.gosteelhead.com';

// Instala un interceptor de /graphql en la page que registra op→{hash,data}.
export async function installInterceptor(page, sink) {
  await page.route('**/*graphql*', async (route) => {
    const req = route.request();
    let body = null;
    try { body = req.postDataJSON(); } catch { try { body = JSON.parse(req.postData() || '{}'); } catch { body = null; } }
    const resp = await route.fetch();
    let json = null;
    try { json = await resp.json(); } catch { json = null; }
    await route.fulfill({ response: resp });
    const ops = Array.isArray(body) ? body : [body];
    const datas = Array.isArray(json) ? json : [json];
    ops.forEach((op, i) => {
      const name = op && op.operationName;
      const hash = op && op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
      if (name && hash) {
        sink.hashes[name] = hash;
        const d = (datas[i] || datas[0] || {});
        if (d && d.data) sink.data[name] = d.data;
      }
    });
  });
}

// Corre una receta: navega los pasos, espera a que capture sus `captures` (o timeout).
export async function runRecipe(page, recipe, domain, timeoutMs = 12000) {
  const url = (p) => BASE + p.replace('{domain}', String(domain));
  for (const step of recipe.steps) {
    if (step.goto) {
      await page.goto(url(step.goto), { waitUntil: 'domcontentloaded' });
    } else if (step.clickFirst) {
      // esperar a que aparezcan links y clickear el primero que matchee hrefMatches
      await page.waitForTimeout(1500);
      const sel = step.clickFirst;
      const re = step.hrefMatches ? new RegExp(step.hrefMatches) : null;
      const handle = await page.evaluateHandle(({ sel, reSrc }) => {
        const re = reSrc ? new RegExp(reSrc) : null;
        const els = [...document.querySelectorAll(sel)];
        return els.find((a) => !re || re.test(a.getAttribute('href') || '')) || null;
      }, { sel, reSrc: step.hrefMatches || null });
      const el = handle.asElement();
      if (el) { await el.click(); }
    }
    // esperar a que caigan las capturas o venza el paso
    await page.waitForTimeout(2500);
  }
  return; // el sink lo llena el interceptor
}
```

- [ ] **Step 2: Implementar `hash-autopilot.mjs` (CLI que abre browser con cookie y corre recetas)**

```js
// tools/hash-autopilot/hash-autopilot.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { installInterceptor, runRecipe } from './recipe-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://app.gosteelhead.com';
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const domainArg = args.find(a => a.startsWith('--domain='));
const DOMAIN = domainArg ? domainArg.split('=')[1] : '344';
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null;

// Lee STEELHEAD_COOKIE_STRING del .env de Reportes SH sin exponerlo.
function loadCookieString() {
  const envPath = '/Users/oviazcan/Projects/Ecoplating/Reportes SH/.env';
  const line = readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('STEELHEAD_COOKIE_STRING='));
  if (!line) throw new Error('STEELHEAD_COOKIE_STRING no está en el .env de Reportes SH');
  return line.slice('STEELHEAD_COOKIE_STRING='.length).trim().replace(/^["']|["']$/g, '');
}

// Convierte "k=v; k2=v2" en cookies de Playwright para el dominio.
function parseCookies(cookieStr) {
  return cookieStr.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: 'app.gosteelhead.com', path: '/' };
  });
}

async function main() {
  const recipesDoc = JSON.parse(readFileSync(join(__dirname, 'click-recipes.json'), 'utf8'));
  const recipes = recipesDoc.recipes;
  const cookieStr = loadCookieString();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(parseCookies(cookieStr));
  const page = await context.newPage();
  const sink = { hashes: {}, data: {} };
  await installInterceptor(page, sink);

  for (const [name, recipe] of Object.entries(recipes)) {
    if (ONLY && !(recipe.captures || []).includes(ONLY)) continue;
    try {
      console.log(`→ receta "${name}" (captura: ${(recipe.captures || []).join(', ')})`);
      await runRecipe(page, recipe, DOMAIN);
    } catch (e) {
      console.log(`  ⚠️ receta "${name}" falló: ${String(e).slice(0, 120)}`);
    }
  }

  console.log('\nHashes capturados:');
  console.log(JSON.stringify(sink.hashes, null, 2));
  await browser.close();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
```

- [ ] **Step 3: Prueba en vivo — dry-run del motor contra las 2 recetas conocidas**

Run:
```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/hash-autopilot && node hash-autopilot.mjs --dry-run
```
Expected: imprime `AllCustomers: 8d4dfe69...` y `Customer: 12d69cd1...` (los hashes vigentes deployados hoy). Si la cookie no autentica, verás 0 capturas → ir a Task 4b (validar cookie) antes de seguir.

> **Nota de verificación (no es paso de commit):** este es el momento crítico donde se prueba que la cookie headless funciona. Si captura los 2 hashes, la hipótesis central del diseño (auth desatendida) queda confirmada. Si no, evaluar `.browser-state` persistente o refresh de cookie antes de avanzar.

- [ ] **Step 4: Commit**

```bash
git add tools/hash-autopilot/recipe-runner.mjs tools/hash-autopilot/hash-autopilot.mjs
git commit -m "feat(hash-autopilot): motor Playwright headless con auth por cookie + interceptor"
```

---

### Task 5: Descubrir las 4 recetas faltantes (en vivo) y anotarlas

**Files:**
- Modify: `tools/hash-autopilot/click-recipes.json`

**Interfaces:**
- Consumes: el motor de Task 4 + navegación asistida (como el 2026-07-03).
- Produces: recetas para `CurrentUser`, `GetPurchaseOrder`, `AllSensorDashboards`, `SensorDashboardQuery` con `captures`, `validateVars`, `expectShape`.

- [ ] **Step 1: Descubrir la secuencia por op navegando en vivo**

Para cada op, con el interceptor puesto (browser abierto en Steelhead con sesión), encontrar la MÍNIMA navegación que la dispara y anotar el `sha256Hash` + `variables` reales que manda el frontend:
- `CurrentUser`: se dispara en el cold-load de la app / pantalla de perfil. Receta candidata: `{ goto: "/Domains/{domain}/Profile" }` o recargar `/`.
- `GetPurchaseOrder`: se dispara en el flujo de Bills → asociar/ver PO. Receta candidata: `{ goto: "/Domains/{domain}/Bills" }` → abrir un bill con PO → panel de PO.
- `AllSensorDashboards` + `SensorDashboardQuery`: `{ goto: "/Dashboards" }` → abrir un dashboard de sensores (cuidar el freeze de render observado el 2026-07-03; usar `waitForLoadState('networkidle')` con timeout).

Método exacto (reproducible): abrir la tab, `window.__cap={}` + patch de `window.fetch` que guarda `op→sha256Hash` (el snippet ya validado el 2026-07-03), navegar por SPA, leer `window.__cap`.

- [ ] **Step 2: Anotar cada receta en `click-recipes.json`**

Formato (rellenar con lo descubierto — ejemplo con placeholders reales que se sustituyen por lo capturado):

```jsonc
"sensor-dashboards": {
  "steps": [{ "goto": "/Dashboards" }, { "clickFirst": "a[href*='ashboard']", "hrefMatches": "\\d+" }],
  "captures": ["AllSensorDashboards", "SensorDashboardQuery"],
  "validateVars": { "AllSensorDashboards": {}, "SensorDashboardQuery": { /* vars reales capturadas */ } },
  "expectShape": { "AllSensorDashboards": [], "SensorDashboardQuery": [] }
}
```

- [ ] **Step 3: Verificar cobertura con el core**

Run:
```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
node -e "const {missingCoverage}=require('./tools/hash-autopilot/hash-autopilot-core.mjs'); const d=require('./tools/hash-autopilot/click-recipes.json'); console.log('faltan:', missingCoverage(d.recipes, ['AllCustomers','Customer','CurrentUser','GetPurchaseOrder','AllSensorDashboards','SensorDashboardQuery']))"
```
Expected: `faltan: []`

- [ ] **Step 4: Prueba en vivo — el motor captura las 6**

Run: `cd tools/hash-autopilot && node hash-autopilot.mjs --dry-run`
Expected: imprime los 6 hashes (los 4 nuevos coinciden con el config actual → vigentes; si alguno difiere, es rotación real).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/click-recipes.json
git commit -m "feat(hash-autopilot): recetas CurrentUser/GetPurchaseOrder/AllSensorDashboards/SensorDashboardQuery"
```

---

### Task 6: Comparación vs config + validación del hash nuevo + persistir resultado

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs`
- Create: `tools/hash-autopilot/config-io.mjs`

**Interfaces:**
- Consumes: `classifyOp`, `hasShape`, `planDeploy` (core); `sink.hashes`, `sink.data`.
- Produces:
  - `config-io.mjs`: `readConfigHashes(configPath) → {op:hash}` y `writeConfigHashes(configPath, {op:newHash}, {bump:true}) → newVersion`.
  - `hash-autopilot.mjs`: para cada op target, arma `results[]` con verdict (re-ejecuta el hash nuevo con `validateVars` in-page para obtener `http` + `shapeOk`), escribe `tools/.hash-autopilot/YYYY-MM-DD.json`.

- [ ] **Step 1: Implementar `config-io.mjs` (solo lectura por ahora)**

```js
// tools/hash-autopilot/config-io.mjs
import { readFileSync } from 'fs';

// Devuelve un mapa op→hash a partir de config.json (busca en persistedQueries).
export function readConfigHashes(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const out = {};
  const walk = (o) => {
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
        else walk(v);
      }
    }
  };
  walk(cfg);
  return out;
}
```

- [ ] **Step 2: Añadir a `hash-autopilot.mjs` la re-ejecución/validación in-page**

```js
// helper: re-ejecuta un hash nuevo con sus validateVars → { http, shapeOk }
async function validateNewHash(page, op, hash, vars, shapePaths) {
  const { http, data } = await page.evaluate(async ({ op, hash, vars }) => {
    const body = { operationName: op, variables: vars || {}, extensions: { clientLibrary: { name: '@apollo/client', version: '4.0.8' }, persistedQuery: { version: 1, sha256Hash: hash } } };
    const r = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { http: r.status, data: j && j.data };
  }, { op, hash, vars });
  // hasShape se importa del core
  return { http, shapeOk: hasShapeImported(data || {}, shapePaths || []) };
}
```
(importar `hasShape as hasShapeImported` desde `./hash-autopilot-core.mjs`).

- [ ] **Step 3: Armar `results[]` y persistir**

Tras correr recetas: para cada op target, con `cfgHash = configHashes[op]`, `liveHash = sink.hashes[op] ?? null`; si `liveHash && liveHash !== cfgHash` → `validateNewHash` para `http`+`shapeOk`, si no `http=null, shapeOk=false`; `verdict = classifyOp(...)`. Escribir a `tools/.hash-autopilot/<fecha>.json` (usar fecha del sistema pasada por env `AUTOPILOT_DATE` o `new Date` en el runtime real — en tests no aplica). Imprimir tabla.

- [ ] **Step 4: Prueba en vivo**

Run: `node hash-autopilot.mjs --dry-run`
Expected: imprime `results` con los 6 ops en `vigente` (post-deploy de hoy) y escribe el JSON de resultado.

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/config-io.mjs tools/hash-autopilot/hash-autopilot.mjs
git commit -m "feat(hash-autopilot): comparación vs config + validación 200/shape del hash nuevo"
```

---

### Task 7: Auto-deploy con salvaguardas

**Files:**
- Modify: `tools/hash-autopilot/config-io.mjs` (agregar `writeConfigHashes`)
- Create: `tools/hash-autopilot/autopilot-deploy.sh`
- Modify: `tools/hash-autopilot/hash-autopilot.mjs` (invocar deploy cuando `!DRY` y hay `toDeploy`)

**Interfaces:**
- Consumes: `planDeploy` (core), `results[]`.
- Produces: `autopilot-deploy.sh <op1=hash1> <op2=hash2> ...` que verifica candado, edita config vía node, corre `tools/deploy.sh`, append bitácora.

- [ ] **Step 1: `writeConfigHashes` en `config-io.mjs`** (reemplaza cada `"op": "<hash>"` por el nuevo, todas las ocurrencias)

```js
import { writeFileSync } from 'fs';
export function writeConfigHashes(configPath, updates) {
  let text = readFileSync(configPath, 'utf8');
  for (const [op, newHash] of Object.entries(updates)) {
    const re = new RegExp(`("${op}"\\s*:\\s*")[0-9a-f]{64}(")`, 'g');
    text = text.replace(re, `$1${newHash}$2`);
  }
  writeFileSync(configPath, text);
}
```

- [ ] **Step 2: `autopilot-deploy.sh`** (candado + edición + deploy.sh + bitácora)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."   # → raíz del repo
REPO="$(pwd)"
# 1. candado: no pisar WIP ajeno en remote/
AJENO="$(git status --porcelain remote/ | grep -v 'config.json' || true)"
if [ -n "$AJENO" ]; then echo "ABORT: WIP ajeno en remote/:"; echo "$AJENO"; exit 3; fi
# 2. editar config con node (recibe pares op=hash)
node -e "
const {writeConfigHashes}=require('./tools/hash-autopilot/config-io.mjs');
const upd=Object.fromEntries(process.argv.slice(1).map(a=>a.split('=')));
writeConfigHashes('./remote/config.json', upd);
console.log('config actualizado:', Object.keys(upd).join(', '));
" "$@"
# 3. deploy oficial (bump + espejo + push + check)
tools/deploy.sh "fix(hashes): rotación auto-detectada ($*) [hash-autopilot]" --check catalog-fetcher
```

Marcar ejecutable: `chmod +x tools/hash-autopilot/autopilot-deploy.sh`.

- [ ] **Step 3: En `hash-autopilot.mjs`, cuando `!DRY`**: `const plan = planDeploy(results, {})`. Si `plan.massBrake` → NO deploya, marca para correo de revisión. Si `plan.toDeploy.length` → `child_process.execFileSync('tools/hash-autopilot/autopilot-deploy.sh', plan.toDeploy.map(r => \`${r.op}=${r.liveHash}\`))`. Append a `docs/api/hash-validation-log.md`.

- [ ] **Step 4: Prueba controlada (dry-run NO deploya; forzar un caso)** — test de humo con un config temporal:

Run:
```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
cp remote/config.json /tmp/cfg-test.json
# romper a mano el hash de AllCustomers en la copia y verificar que writeConfigHashes lo repara
node -e "const {writeConfigHashes,readConfigHashes}=require('./tools/hash-autopilot/config-io.mjs'); writeConfigHashes('/tmp/cfg-test.json',{AllCustomers:'8d4dfe69d3050a16ad802015e6d14b6458db5266e62c67a2321d23b440086037'}); console.log('AllCustomers=',readConfigHashes('/tmp/cfg-test.json').AllCustomers)"
```
Expected: imprime el hash nuevo → `writeConfigHashes` funciona sin tocar el config real.

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/config-io.mjs tools/hash-autopilot/autopilot-deploy.sh tools/hash-autopilot/hash-autopilot.mjs
git commit -m "feat(hash-autopilot): auto-deploy con candado + freno de masa + bitácora"
```

---

### Task 8: Notificación por correo (éxito / fallo / revisión)

**Files:**
- Create: `tools/hash-autopilot/autopilot-notify.sh`
- Modify: `tools/hash-autopilot/hash-autopilot.mjs` (llamar al notify según el resultado)

**Interfaces:**
- Produces: `autopilot-notify.sh <tipo> <asunto> <cuerpo>` (tipo ∈ `exito|fallo|revision`) que manda correo a `oviazcan@gmail.com` vía osascript Mail.app (mismo patrón que `notify-stale-hashes.sh`).

- [ ] **Step 1: `autopilot-notify.sh`** (reutilizar el osascript de `notify-stale-hashes.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
TIPO="${1:?tipo}"; ASUNTO="${2:?asunto}"; CUERPO="${3:?cuerpo}"
osascript <<OSA
tell application "Mail"
  set nuevoCorreo to make new outgoing message with properties {subject:"[hash-autopilot ${TIPO}] ${ASUNTO}", content:"${CUERPO}", visible:false}
  tell nuevoCorreo to make new to recipient at end of to recipients with properties {address:"oviazcan@gmail.com"}
  send nuevoCorreo
end tell
OSA
```

- [ ] **Step 2: En `hash-autopilot.mjs`** llamar notify según caso:
  - `toDeploy.length && deploy OK` → `exito` ("rotó y regeneré: A (old→new), config vX").
  - `massBrake` → `revision` (">6 rotados, no deployé, revisa").
  - `suspicious.length` → `revision` ("hash distinto pero no valida 200/shape").
  - `notCaptured.length` → `fallo` + escribir señal (Task 9).
  - auth caída (0 capturas totales) → `revision` ("repega STEELHEAD_COOKIE_STRING").

- [ ] **Step 3: Prueba de humo del notify** (sin mandar spam real — usar asunto de prueba)

Run:
```bash
bash tools/hash-autopilot/autopilot-notify.sh exito "PRUEBA — ignorar" "Correo de prueba de hash-autopilot."
```
Expected: llega un correo de prueba a oviazcan@gmail.com. (Confirmar con el usuario y luego borrarlo.)

- [ ] **Step 4: Commit**

```bash
chmod +x tools/hash-autopilot/autopilot-notify.sh
git add tools/hash-autopilot/autopilot-notify.sh tools/hash-autopilot/hash-autopilot.mjs
git commit -m "feat(hash-autopilot): notificación por correo (éxito/fallo/revisión)"
```

---

### Task 9: Escalamiento a Claude ante fallo de captura (señal + cron condicional)

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs` (escribir `needs-attention.json`)
- Create: `tools/hash-autopilot/ESCALATION.md` (el prompt del cron condicional, documentado)

**Interfaces:**
- Produces: `tools/.hash-autopilot/needs-attention.json` con `{ date, ops:[{op, recipeTried, observed}] }`; un cron de Claude Code (CronCreate durable) que lo atiende.

- [ ] **Step 1: En `hash-autopilot.mjs`**, si hay `notCaptured`, escribir `tools/.hash-autopilot/needs-attention.json` con la op, la receta intentada y qué se observó (0 capturas de esa op).

- [ ] **Step 2: Documentar el prompt del cron en `ESCALATION.md`** (para crear el CronCreate):

```markdown
# Escalamiento hash-autopilot → Claude
Cron condicional (corre ~30 min después del launchd de hash-autopilot, durable):

PROMPT:
"Revisa si existe `tools/.hash-autopilot/needs-attention.json` en SteelheadAutomator.
Si NO existe → termina sin hacer nada (no gastes tokens).
Si existe: invoca la skill steelhead-hash-validator. Para cada op listada, abre
Steelhead (claude-in-chrome), instala el interceptor de fetch, y re-descubre la
MÍNIMA secuencia de navegación que dispara esa op (1 intento acotado). Si la
encuentras: actualiza tools/hash-autopilot/click-recipes.json con la receta nueva,
corre `node hash-autopilot.mjs` (sin --dry-run) para que regenere/deploye, y manda
correo 'reparado'. Si NO la encuentras: manda correo 'necesito ayuda: cambió el
shape/UI de X'. Borra needs-attention.json al terminar en ambos casos."
```

- [ ] **Step 3: Crear el cron condicional** (CronCreate durable) usando el prompt de arriba. Verificar con CronList que quedó agendado.

- [ ] **Step 4: Prueba** — escribir un `needs-attention.json` de mentira y correr el cron a mano una vez (o esperar el disparo) para ver que detecta la señal y (con una op ya conocida) re-captura sin romper.

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/hash-autopilot.mjs tools/hash-autopilot/ESCALATION.md
git commit -m "feat(hash-autopilot): escalamiento a Claude (señal + cron condicional)"
```

---

### Task 10: Scheduling launchd + doc + skill update

**Files:**
- Create: `tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist`
- Create: `tools/run-hash-autopilot.sh`
- Modify: `docs/api/hash-validation-log.md` (nota del sistema nuevo)
- Modify: skill `steelhead-hash-validator/SKILL.md` (referencia a hash-autopilot para las whitelisted)

**Interfaces:**
- Produces: job agendado diario ~8:30am (después del validador Python de las 8:03).

- [ ] **Step 1: `run-hash-autopilot.sh`** (wrapper: cd, node, log a `tools/.hash-autopilot/launchd.log`)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/hash-autopilot
/usr/local/bin/node hash-autopilot.mjs >> ../.hash-autopilot/launchd.log 2>&1
```
(ajustar path de node según `which node`).

- [ ] **Step 2: `com.ecoplating.steelhead-hash-autopilot.plist`** (StartCalendarInterval 8:30 lun-vie, mismo patrón que el validador). Copiar la estructura de `com.ecoplating.steelhead-hash-validator.plist` y cambiar Label + ProgramArguments a `run-hash-autopilot.sh` + Hour 8 Minute 30.

- [ ] **Step 3: Cargar el launchd**

Run:
```bash
cp tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-autopilot.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-autopilot.plist
launchctl list | grep hash-autopilot
```
Expected: aparece el job cargado.

- [ ] **Step 4: Actualizar docs** — nota en `hash-validation-log.md` ("desde 2026-07-xx las whitelisted las cubre hash-autopilot, no validate-hashes.py") y en `SKILL.md` de `steelhead-hash-validator` (sección "para whitelisted usa hash-autopilot").

- [ ] **Step 5: Prueba end-to-end** — disparar el job a mano (`launchctl start ...`) y revisar `launchd.log` + que escriba el JSON de resultado del día con los 6 en `vigente`.

- [ ] **Step 6: Commit**

```bash
git add tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist tools/run-hash-autopilot.sh docs/api/hash-validation-log.md
git commit -m "feat(hash-autopilot): launchd diario + docs + skill update"
```

---

## Self-Review (cobertura del spec)

- ✅ Motor Playwright headless + auth cookie → Task 4.
- ✅ Mapa de secuencias económicas (click-recipes.json, por pantalla) → Tasks 1, 5.
- ✅ Comparación vs config + validación 200/shape → Task 6.
- ✅ Auto-deploy con salvaguardas (candado, freno de masa >6, validación, idempotencia por regex) → Tasks 3, 7.
- ✅ Notificación éxito/fallo/revisión → Task 8.
- ✅ Escalamiento a Claude (señal + cron condicional, auto-reparación) → Task 9.
- ✅ launchd diario → Task 10.
- ✅ Cobertura inicial de las 6 whitelisted (2 conocidas + 4 por descubrir) → Tasks 1, 5.
- ✅ Testing: núcleo puro con node:test (Tasks 2, 3), dry-run en vivo (Tasks 4, 6), humo de deploy/notify (Tasks 7, 8).
- ⚠️ Riesgo abierto (documentado en spec): estabilidad de la cookie headless se prueba empíricamente en Task 4 Step 3 — es el punto de decisión de viabilidad.
```

Auth caída, dominio TLC/MTY parametrizable (`--domain`), y rollback por git: cubiertos por Global Constraints + Tasks 7/8.
