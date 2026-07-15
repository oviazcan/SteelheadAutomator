# hash-autopilot v2 — Fase A (fusión + selectividad de queries) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fusionar validator + autopilot en un solo job desatendido que, ante un release, detecta qué queries rotaron, corre **solo** las rutas headless necesarias, autocorrige y manda **un** correo consolidado.

**Architecture:** `validate-hashes.py` (ya existe) detecta las ops stale → `route-planner.mjs` (nuevo, puro) resuelve el conjunto mínimo de rutas por set-cover sobre `captures` → `hash-autopilot.mjs` (modificado) corre solo esas rutas con el `recipe-runner` existente, clasifica con `hash-autopilot-core` (ya existe) y auto-deploya con `autopilot-deploy.sh` (ya existe). El wrapper `run-hash-autopilot.sh` orquesta el job único y el validator viejo se descarga.

**Tech Stack:** Node ESM (`.mjs`), Playwright (ya instalado en `tools/hash-autopilot/node_modules`), `node:test` para los puros, bash + launchd para orquestación.

## Global Constraints

- **Universo de ops:** `remote/config.json` → `steelhead.hashes.queries` (113) + `.mutations` (69). Fase A cubre **solo queries**.
- **Session-sensitive (6, siempre por release):** `CurrentUser`, `GetPurchaseOrder`, `Customer`, `AllCustomers`, `AllSensorDashboards`, `SensorDashboardQuery`. El validator las reporta en `skipped` (whitelist), no en `stale`.
- **Freno de masa:** `planDeploy` NO deploya si > 6 ops rotan en una corrida (`massBrakeThreshold: 6`). No cambiar sin razón.
- **Deploy solo desde `main` sin WIP ajeno** (salvaguarda de `autopilot-deploy.sh`). Fuera de main → avisa, no deploya.
- **Gate por release:** el job sale en un `curl` si `code-id` de `/version.json` no cambió. No tocar.
- **Núcleos puros sin red/Playwright**, testeados con `node:test` (patrón de `tools/test/hash-autopilot-core.test.js`).
- **Correo solo cuando hay algo que reportar** (deployado / sospechoso / no capturado / stale-sin-ruta). Nunca "todo ok".

---

### Task 1: `route-planner.mjs` — `selectRoutes` (set-cover determinista)

**Files:**
- Create: `tools/hash-autopilot/route-planner.mjs`
- Test: `tools/test/route-planner.test.js`

**Interfaces:**
- Consumes: nada (núcleo puro).
- Produces:
  - `selectRoutes(rotatedOps: string[], catalog: {routes: {[id]: {module?: string, steps: object[], captures: string[]}}}): {routes: Array<{id: string, module?: string, steps: object[], captures: string[]}>, uncovered: string[]}`
  - Set-cover greedy determinista: en cada vuelta elige la ruta que cubre MÁS ops pendientes; desempate por `id` alfabético. Termina cuando no queda ruta que cubra alguna pendiente; las pendientes restantes van a `uncovered`.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/route-planner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRoutes } = require('../hash-autopilot/route-planner.mjs');

const CATALOG = {
  routes: {
    'customers-list':   { module: 'Customers', steps: [{ goto: '/c' }], captures: ['AllCustomers', 'CustomerTags'] },
    'customer-detail':  { module: 'Customers', steps: [{ goto: '/c/1' }], captures: ['Customer'] },
    'app-home':         { module: 'Home',      steps: [{ goto: '/' }],  captures: ['CurrentUser'] },
  },
};

test('selectRoutes: una ruta que cubre 2 ops rotadas se elige una sola vez', () => {
  const r = selectRoutes(['AllCustomers', 'CustomerTags'], CATALOG);
  assert.deepEqual(r.routes.map((x) => x.id), ['customers-list']);
  assert.deepEqual(r.uncovered, []);
});

test('selectRoutes: elige el mínimo de rutas (set-cover) y ordena por cobertura', () => {
  const r = selectRoutes(['AllCustomers', 'Customer', 'CurrentUser'], CATALOG);
  // customers-list cubre 1 (AllCustomers), pero también CustomerTags no está pedido.
  // Se necesitan 3 rutas: customers-list, customer-detail, app-home.
  assert.deepEqual(r.routes.map((x) => x.id).sort(), ['app-home', 'customer-detail', 'customers-list']);
  assert.deepEqual(r.uncovered, []);
});

test('selectRoutes: op sin ruta en el catálogo → uncovered', () => {
  const r = selectRoutes(['AllCustomers', 'GetPurchaseOrder'], CATALOG);
  assert.deepEqual(r.routes.map((x) => x.id), ['customers-list']);
  assert.deepEqual(r.uncovered, ['GetPurchaseOrder']);
});

test('selectRoutes: rotatedOps vacío → sin rutas, sin uncovered', () => {
  const r = selectRoutes([], CATALOG);
  assert.deepEqual(r.routes, []);
  assert.deepEqual(r.uncovered, []);
});

test('selectRoutes: desempate determinista por id alfabético', () => {
  // dos rutas cubren exactamente la misma op → gana la de id menor.
  const cat = { routes: {
    'zeta': { steps: [], captures: ['X'] },
    'alpha': { steps: [], captures: ['X'] },
  } };
  const r = selectRoutes(['X'], cat);
  assert.deepEqual(r.routes.map((x) => x.id), ['alpha']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/route-planner.test.js`
Expected: FAIL — `Cannot find module '../hash-autopilot/route-planner.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/route-planner.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/route-planner.mjs tools/test/route-planner.test.js
git commit -m "feat(hash-autopilot): route-planner selectRoutes (set-cover selectivo) + tests"
```

---

### Task 2: `route-planner.mjs` — `opsToCapture` (stale ∪ session-sensitive)

**Files:**
- Modify: `tools/hash-autopilot/route-planner.mjs` (añadir export)
- Test: `tools/test/route-planner.test.js` (añadir casos)

**Interfaces:**
- Consumes: el JSON que escribe `validate-hashes.py` en `tools/.hash-validation/<date>.json`, con forma `{stale: [{kind, operation, hash}], skipped: [{operation}], ...}`.
- Produces:
  - `opsToCapture(validatorResult: {stale?: {operation: string}[]}, sessionSensitive: string[]): string[]` — unión deduplicada de `stale[].operation` (solo las `kind === 'query'` se capturan en Fase A; ver nota) + `sessionSensitive`. Orden: alfabético (determinista).
  - **Nota Fase A:** las mutations stale se **excluyen** de la captura (no hay ciclo sentinela aún) pero se devuelven aparte vía `staleMutations(validatorResult)` para reportarlas en el correo.
  - `staleMutations(validatorResult): string[]` — `stale[]` con `kind === 'mutation'`, alfabético.

- [ ] **Step 1: Write the failing test**

```javascript
// añadir a tools/test/route-planner.test.js
const { opsToCapture, staleMutations } = require('../hash-autopilot/route-planner.mjs');

const SESSION_SENSITIVE = ['AllCustomers', 'Customer', 'CurrentUser', 'GetPurchaseOrder', 'AllSensorDashboards', 'SensorDashboardQuery'];

test('opsToCapture: une stale-queries con session-sensitive, dedup y ordena', () => {
  const vr = { stale: [
    { kind: 'query', operation: 'GetWorkOrder' },
    { kind: 'query', operation: 'AllCustomers' },      // ya en session-sensitive → dedup
    { kind: 'mutation', operation: 'SaveQuoteLines' }, // mutation → excluida de captura
  ] };
  assert.deepEqual(
    opsToCapture(vr, SESSION_SENSITIVE),
    ['AllCustomers', 'AllSensorDashboards', 'CurrentUser', 'Customer', 'GetPurchaseOrder', 'GetWorkOrder', 'SensorDashboardQuery'],
  );
});

test('opsToCapture: sin stale → solo session-sensitive (siempre por release)', () => {
  assert.deepEqual(opsToCapture({ stale: [] }, SESSION_SENSITIVE), [...SESSION_SENSITIVE].sort());
});

test('opsToCapture: validatorResult sin campo stale → solo session-sensitive', () => {
  assert.deepEqual(opsToCapture({}, SESSION_SENSITIVE), [...SESSION_SENSITIVE].sort());
});

test('staleMutations: devuelve solo las mutations stale, ordenadas', () => {
  const vr = { stale: [
    { kind: 'mutation', operation: 'SaveQuoteLines' },
    { kind: 'query', operation: 'GetWorkOrder' },
    { kind: 'mutation', operation: 'ArchivePart' },
  ] };
  assert.deepEqual(staleMutations(vr), ['ArchivePart', 'SaveQuoteLines']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/route-planner.test.js`
Expected: FAIL — `opsToCapture is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// añadir a tools/hash-autopilot/route-planner.mjs

// Ops a capturar esta corrida: queries stale detectadas por el validator
// UNIÓN las session-sensitive (que el validator no puede ver → siempre por release).
// Las mutations stale NO se capturan en Fase A (no hay ciclo sentinela); se
// reportan aparte con staleMutations().
export function opsToCapture(validatorResult, sessionSensitive) {
  const stale = (validatorResult && validatorResult.stale) || [];
  const staleQueries = stale.filter((s) => s.kind !== 'mutation').map((s) => s.operation);
  const set = new Set([...(sessionSensitive || []), ...staleQueries]);
  return [...set].sort();
}

export function staleMutations(validatorResult) {
  const stale = (validatorResult && validatorResult.stale) || [];
  return stale.filter((s) => s.kind === 'mutation').map((s) => s.operation).sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/route-planner.test.js`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/route-planner.mjs tools/test/route-planner.test.js
git commit -m "feat(hash-autopilot): opsToCapture + staleMutations (union stale∪session-sensitive)"
```

---

### Task 3: `route-catalog.json` — evolución del click-recipes

**Files:**
- Create: `tools/hash-autopilot/route-catalog.json`

**Interfaces:**
- Produces: el catálogo que `selectRoutes` consume. Estructura `{routes: {[id]: {type, module, steps, captures}}}`.
- Fase A siembra el catálogo con las 4 rutas de queries ya validadas en `click-recipes.json` (migradas 1:1). El discovery exhaustivo (Fase B) lo llena.

- [ ] **Step 1: Crear el catálogo con las 4 rutas actuales migradas**

```json
{
  "_doc": "Mapa de rutas op→pantalla/clicks. selectRoutes() hace set-cover sobre captures. type=query|mutation. sentinel (Fase C) solo para mutations. Fase A: solo las 4 rutas de queries ya validadas; Fase B llena el resto vía discovery instrumentado.",
  "_domainDefault": "344",
  "routes": {
    "app-home": {
      "type": "query",
      "module": "Home",
      "steps": [{ "goto": "/Domains/{domain}" }],
      "captures": ["CurrentUser"]
    },
    "customers-list": {
      "type": "query",
      "module": "Customers",
      "steps": [{ "goto": "/Domains/{domain}/Customers" }],
      "captures": ["AllCustomers"]
    },
    "customer-detail": {
      "type": "query",
      "module": "Customers",
      "steps": [
        { "goto": "/Domains/{domain}/Customers" },
        { "clickFirst": "a[href*='/Customers/']", "hrefMatches": "/Customers/\\d+" }
      ],
      "captures": ["Customer"]
    },
    "sensor-dashboards": {
      "type": "query",
      "module": "Sensors",
      "steps": [
        { "goto": "/Dashboards" },
        { "clickFirst": "a[href*='ashboard']", "hrefMatches": "\\d" }
      ],
      "captures": ["AllSensorDashboards"]
    }
  }
}
```

- [ ] **Step 2: Validar que el JSON parsea y el planner lo consume**

Run:
```bash
node -e "const {selectRoutes}=require('./tools/hash-autopilot/route-planner.mjs'); const c=require('./tools/hash-autopilot/route-catalog.json'); console.log(JSON.stringify(selectRoutes(['AllCustomers','Customer','GetPurchaseOrder'], c)))"
```
Expected: imprime `{"routes":[{"id":"customer-detail",...},{"id":"customers-list",...}],"uncovered":["GetPurchaseOrder"]}` (AllCustomers y Customer cubiertas; GetPurchaseOrder sin ruta → uncovered).

- [ ] **Step 3: Commit**

```bash
git add tools/hash-autopilot/route-catalog.json
git commit -m "feat(hash-autopilot): route-catalog.json inicial (4 rutas de queries migradas)"
```

---

### Task 4: Orquestación selectiva en `hash-autopilot.mjs`

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs`

**Interfaces:**
- Consumes: `selectRoutes`, `opsToCapture`, `staleMutations` (Tasks 1-2); `route-catalog.json` (Task 3); resultado del validator en `tools/.hash-validation/<date>.json`.
- Produces: mismo `persistResult` + correo, pero corriendo **solo** las rutas de `selectRoutes`, y con el correo consolidando: deployadas, sospechosas, no-capturadas (ruta falló), stale-sin-ruta (query stale sin entrada en catálogo), y stale-mutations (Fase C pendiente).

- [ ] **Step 1: Cambiar imports y fuente de recetas**

En `tools/hash-autopilot/hash-autopilot.mjs`, reemplazar la línea 11-13:
```javascript
import { installInterceptor, runRecipe } from './recipe-runner.mjs';
import { classifyOp, planDeploy } from './hash-autopilot-core.mjs';
import { readConfigHashes } from './config-io.mjs';
```
por:
```javascript
import { installInterceptor, runRecipe } from './recipe-runner.mjs';
import { classifyOp, planDeploy } from './hash-autopilot-core.mjs';
import { readConfigHashes } from './config-io.mjs';
import { selectRoutes, opsToCapture, staleMutations } from './route-planner.mjs';
```

- [ ] **Step 2: Añadir lectura del resultado del validator y la lista session-sensitive**

Reemplazar la constante `TARGET_OPS` (línea 18-19) por:
```javascript
// Session-sensitive: el validator (idp-token) no las puede ver → se capturan
// SIEMPRE que haya release. El resto se capturan solo si el validator las marcó stale.
const SESSION_SENSITIVE = ['AllCustomers', 'Customer', 'CurrentUser', 'GetPurchaseOrder', 'AllSensorDashboards', 'SensorDashboardQuery'];

// Lee el JSON del validator del día (lo escribe validate-hashes.py). Si no existe
// (no corrió, o corrió sin stale), devuelve {stale:[]} → solo session-sensitive.
function loadValidatorResult(date) {
  try {
    const p = join(__dirname, '../.hash-validation', `${date}.json`);
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return { stale: [] }; }
}
```

- [ ] **Step 3: Reemplazar el bucle "correr todas las recetas" por selección**

Reemplazar el bloque `main()` desde `const recipesDoc = ...` (línea 59-60) hasta el cierre del `for` de recetas (línea 83), por:
```javascript
  const catalog = JSON.parse(readFileSync(join(__dirname, 'route-catalog.json'), 'utf8'));
  const validatorResult = loadValidatorResult(RUN_DATE);
  const wantOps = opsToCapture(validatorResult, SESSION_SENSITIVE);
  const plan0 = selectRoutes(wantOps, catalog);
  const staleMuts = staleMutations(validatorResult);
  console.log(`Ops a capturar (${wantOps.length}): ${wantOps.join(', ')}`);
  console.log(`Rutas seleccionadas (${plan0.routes.length}): ${plan0.routes.map((r) => r.id).join(', ') || '(ninguna)'}`);
  if (plan0.uncovered.length) console.log(`⚠️ Queries stale SIN ruta en catálogo: ${plan0.uncovered.join(', ')} (Fase B)`);
  if (staleMuts.length) console.log(`⚠️ Mutations stale (Fase C pendiente): ${staleMuts.join(', ')}`);

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

  await browser.close();
```
(Se eliminó el `TOKENS_PATH`/`loadTokens` NO — esos siguen arriba sin cambios. Solo cambió la fuente de rutas de `recipes` a `plan0.routes`.)

- [ ] **Step 4: Ajustar la clasificación para usar `wantOps` en vez de `TARGET_OPS`**

Reemplazar la línea 98 `const results = TARGET_OPS.map((op) => {` por:
```javascript
  const results = wantOps.map((op) => {
```

- [ ] **Step 5: Consolidar el correo (añadir stale-sin-ruta y stale-mutations)**

Al final del bloque de notificaciones (después de la línea 151, antes del `return`), añadir:
```javascript
    if (plan0.uncovered.length) {
      notify('fallo', `${plan0.uncovered.length} query(s) stale sin ruta`, `El validator marcó estas queries rotadas pero no hay ruta en route-catalog.json (pendiente Fase B):\n${plan0.uncovered.map((op) => `• ${op}`).join('\n')}`);
    }
    if (staleMuts.length) {
      notify('revision', `${staleMuts.length} mutation(s) rotada(s)`, `El validator marcó estas MUTATIONS rotadas. Fase C (ciclo sentinela) aún no implementada — captura manual por ahora:\n${staleMuts.map((op) => `• ${op}`).join('\n')}`);
    }
```

- [ ] **Step 6: Smoke test en dry-run (sin deploy, sin correo real)**

Run:
```bash
cd tools/hash-autopilot && node hash-autopilot.mjs --dry-run --date=2026-07-06 2>&1 | head -40
```
Expected: imprime "Ops a capturar (6): ..." (las 6 session-sensitive, porque sin validator del día `stale=[]`), "Rutas seleccionadas (…)", clasifica las capturadas, y NO deploya (dry-run). Si los tokens ROCP vencieron: sale con "0 capturas — corre steelhead_auth.py" (exit 2) — es el fail-safe esperado, no un bug del plan.

- [ ] **Step 7: Commit**

```bash
git add tools/hash-autopilot/hash-autopilot.mjs
git commit -m "feat(hash-autopilot): orquestación selectiva (validator→planner→rutas) + correo consolidado"
```

---

### Task 5: Fusión del wrapper `run-hash-autopilot.sh`

**Files:**
- Modify: `tools/run-hash-autopilot.sh`

**Interfaces:**
- Consumes: `validate-hashes.py` (escribe `.hash-validation/<date>.json`), `hash-autopilot.mjs` (lo lee).
- Produces: un job único gateado por release que corre validator → motor, y deja rastro de bitácora como hoy hace el validator.

- [ ] **Step 1: Insertar la corrida del validator antes del motor**

En `tools/run-hash-autopilot.sh`, después de la línea `echo "$(date '+%F %T') Release nuevo (${CUR_CODEID:0:8}) — corriendo hash-autopilot…"` y antes de `cd "$AUTOPILOT_DIR"`, insertar:
```bash
# ── Fase A: primero el validator (detecta stale de las 176 detectables) ──
# Escribe tools/.hash-validation/<date>.json que el motor lee para planificar.
echo "$(date '+%F %T') Corriendo validate-hashes.py (detección)…"
"$PYTHON" "$REPO_ROOT/tools/validate-hashes.py" || echo "$(date '+%F %T') validate-hashes.py exit $? (stale o auth; el motor decide)"
```

- [ ] **Step 2: Verificar el flujo completo en seco (sin release nuevo → skip)**

Run: `REPO_ROOT="$(pwd)" tools/run-hash-autopilot.sh 2>&1 | head -10`
Expected: como el `code-id` no cambió desde la última corrida, imprime "Sin release nuevo … skip." y sale 0 (no corre ni validator ni motor). Confirma que el gate por release sigue intacto.

- [ ] **Step 3: Commit**

```bash
git add tools/run-hash-autopilot.sh
git commit -m "feat(hash-autopilot): fusión — el wrapper corre validate-hashes.py antes del motor (1 job)"
```

---

### Task 6: Descargar el validator viejo + documentar (activación diferida)

**Files:**
- Modify: `tools/hash-autopilot/README.md`
- Modify: `docs/api/hash-validation-log.md` (nota de corte)
- Modify: `CLAUDE.md` (índice: nota de que v2 fusiona ambos jobs)

**Interfaces:** ninguna de código; es operación + docs. **NO ejecutar el unload/load hasta estar en `main` sin WIP ajeno** (salvaguarda de deploy). Documentar el procedimiento para hacerlo tras el merge.

- [ ] **Step 1: Documentar el corte en el README del autopilot**

Añadir al final de `tools/hash-autopilot/README.md` una sección:
```markdown
## v2 — job único (Fase A)

Desde v2 este job **subsume** al `hash-validator`: `run-hash-autopilot.sh` corre
`validate-hashes.py` (detección) y luego el motor (captura selectiva + deploy),
con un solo correo. Al activar v2, **descargar el validator viejo** para no tener
dos jobs:
```bash
launchctl unload ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-validator.plist
rm ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-validator.plist
# y cargar el autopilot (si no estaba):
cp tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-autopilot.plist
launchctl list | grep -E 'hash-autopilot|hash-validator'   # debe quedar SOLO autopilot
```
**Prerrequisito:** repo en `main` sin WIP ajeno (salvaguarda de auto-deploy).
```

- [ ] **Step 2: Nota de corte en la bitácora**

Añadir a `docs/api/hash-validation-log.md`:
```markdown

## 2026-07-06 — hash-autopilot v2 Fase A: fusión validator+autopilot en 1 job

Desde v2, `run-hash-autopilot.sh` corre validate-hashes.py (detección) + motor
(captura selectiva de las queries rotadas vía route-planner/route-catalog) con un
solo correo. El `hash-validator` viejo se descarga al activar (ver README del
autopilot). Mutations rotadas: se reportan pero aún NO se autocorrigen (Fase C).
```

- [ ] **Step 3: Correr toda la suite de tests puros**

Run: `node --test tools/test/route-planner.test.js tools/test/hash-autopilot-core.test.js`
Expected: PASS (14 tests: 9 planner + 5 core… nota: core tiene 12; ajustar conteo al real). Todos verdes.

- [ ] **Step 4: Commit**

```bash
git add tools/hash-autopilot/README.md docs/api/hash-validation-log.md CLAUDE.md
git commit -m "docs(hash-autopilot): v2 Fase A — procedimiento de corte del validator viejo + bitácora"
```

---

## Self-Review

**Spec coverage (§ del spec 2026-07-06):**
- §4 flujo detectar→planificar→ejecutar→validar→deploy→notificar → Tasks 1-5 ✓
- §5.2 route-planner set-cover puro → Task 1 ✓
- §5.1 route-catalog.json → Task 3 ✓ (Fase A: 4 rutas; Fase B llena)
- §6 detección selectiva + session-sensitive siempre → Task 2 (`opsToCapture`) ✓
- §5 fusión 1 job + 1 correo → Tasks 4-5 ✓
- §9 Fase A alcance (queries, descargar validator) → Tasks 4-6 ✓
- §7 sentinela/mutations → **fuera de Fase A** (Fase C; Task 4 solo reporta stale-mutations) ✓ (intencional)
- §8 discovery → **Fase B** (plan aparte) ✓ (intencional)

**Placeholder scan:** Sin TBD/TODO en pasos ejecutables. El conteo de tests en Task 6 Step 3 se anota "ajustar al real" — el ejecutor corre y ve el número; no es un placeholder de diseño.

**Type consistency:** `selectRoutes(rotatedOps, catalog)→{routes,uncovered}`, `opsToCapture(validatorResult, sessionSensitive)→string[]`, `staleMutations(validatorResult)→string[]` usados consistentemente en Tasks 1-2-4. El catálogo `{routes:{id:{type,module,steps,captures}}}` (Task 3) coincide con lo que `selectRoutes` espera (Task 1). `runRecipe(page, route, ...)` recibe un objeto con `steps`/`captures` — las rutas de `plan0.routes` los tienen (Task 1 los propaga). ✓

**Notas de riesgo para el ejecutor:**
- Task 4 Step 6 y Task 5 Step 2 dependen de tokens ROCP frescos y de que haya release; si no, el fail-safe (exit 2 / skip) es el comportamiento esperado, no un fallo del plan.
- Task 6 es de activación operativa: NO correr unload/load hasta estar en `main` sin WIP ajeno.
