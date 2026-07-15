# hash-autopilot v2 — Fase B (discovery exhaustivo del catálogo) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poblar `route-catalog.json` con las rutas de las ~113 queries (y preparar las de mutations para Fase C) instrumentando el hash-scanner para que registre pantalla + clicks por op, generando el catálogo semi-automáticamente desde un scan de navegación guiada, y midiendo cobertura para dirigir las pasadas siguientes.

**Architecture:** Se instrumenta `hash-scanner.js` (applet de la extensión) para anexar a cada op capturada su `location.pathname` + un breadcrumb del último click. El operador navega el ERP una vez siguiendo un guion por módulo con el scanner corriendo; el `scan_results` sale con `op → screens[{pathname, breadcrumb}]`. Un generador puro (`catalog-generator.mjs`) convierte ese scan en `route-catalog.json` (agrupando ops por pantalla = economía de clics), y `coverage-report.mjs` lista las queries del config que quedaron sin ruta para dirigir la siguiente pasada.

**Tech Stack:** JS vanilla de navegador (hash-scanner, sin frameworks) + Node ESM puro (`.mjs`) para el generador/cobertura, `node:test`. Deploy del scanner instrumentado vía `tools/deploy.sh` (es un applet remoto).

## Global Constraints

- **Universo de queries a cubrir:** `remote/config.json` → `steelhead.hashes.queries` (113). Mutations (69) se mapean pero su ejecución/sentinela es Fase C — en Fase B solo se registra su ruta/`entityType` si el scan las captura.
- **Formato de `route-catalog.json`** (de Fase A): `{routes: {[id]: {type, module, steps[], captures[], sentinel?}}}`. `selectRoutes` (Fase A) hace set-cover sobre `captures`. El generador debe emitir exactamente esa forma.
- **Sanitización del scanner es sagrada:** el breadcrumb/pathname pasa por el `sanitizeValue` key-level existente (`SENSITIVE_KEY_PATTERN`, `TOKEN_URL_PATTERN`, truncado > 500). Nunca capturar payloads en el breadcrumb — solo selector/rol/texto corto del control.
- **UI DARK MODE** no aplica (el scanner no tiene UI nueva).
- **El scanner es un applet remoto:** cambiarlo requiere **deploy a gh-pages** (`tools/deploy.sh`) para que la extensión lo use en la sesión de discovery.
- **Núcleos puros sin red/DOM** (`catalog-generator.mjs`, `coverage-report.mjs`) testeados con `node:test`, patrón de `tools/test/hash-autopilot-core.test.js`.
- **Economía de clics:** una pantalla dispara varias ops → el generador agrupa por `pathname` (una ruta, múltiples `captures`), no una ruta por op.
- **`missingCoverage(recipes, targetOps)`** ya existe en `tools/hash-autopilot/hash-autopilot-core.mjs` — reutilizar, no reimplementar.

---

### Task 1: Instrumentar `hash-scanner.js` — breadcrumb de clicks + pathname por op

**Files:**
- Modify: `remote/scripts/hash-scanner.js`
- Test: `tools/test/hash-scanner-screens.test.js`

**Interfaces:**
- Consumes: nada nuevo (extiende el módulo existente).
- Produces: cada `discovered[op]` gana `screens: Array<{pathname, breadcrumb, count}>` (dedup por `pathname`, cap 5). `recordOperation` recibe el pathname/breadcrumb vía `meta`. Un listener de click global mantiene `lastClick = {breadcrumb, ts}` (breadcrumb = `${tag}${role?}${textoCorto}` sanitizado, sin payloads). `getResults()` incluye `screens` por op.
- Expuesto en `_internal`: `describeClickTarget(el)` (puro-ish, testeable con un elemento mock) y `recordScreen(entry, pathname, breadcrumb)`.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/hash-scanner-screens.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const HashScanner = require('../../remote/scripts/hash-scanner.js');
const { describeClickTarget, recordScreen } = HashScanner._internal;

test('describeClickTarget: botón con texto → tag+texto corto, sin payload', () => {
  const el = { tagName: 'BUTTON', getAttribute: (a) => (a === 'role' ? null : null), textContent: '  Guardar cambios  ', closest: () => null };
  assert.equal(describeClickTarget(el), 'button:Guardar cambios');
});

test('describeClickTarget: link con role y texto largo → trunca a 40 chars', () => {
  const long = 'X'.repeat(80);
  const el = { tagName: 'A', getAttribute: (a) => (a === 'role' ? 'link' : null), textContent: long, closest: () => null };
  const out = describeClickTarget(el);
  assert.match(out, /^a\[link\]:X+$/);
  assert.ok(out.length <= 'a[link]:'.length + 40);
});

test('describeClickTarget: elemento nulo → "(desconocido)"', () => {
  assert.equal(describeClickTarget(null), '(desconocido)');
});

test('recordScreen: agrega pathname+breadcrumb nuevo, dedup por pathname', () => {
  const entry = { screens: [] };
  recordScreen(entry, '/Domains/344/Customers', 'a:Ver cliente');
  recordScreen(entry, '/Domains/344/Customers', 'a:Otro');   // mismo pathname → no duplica, sube count
  recordScreen(entry, '/Domains/344/Bills', 'button:Buscar'); // pathname nuevo
  assert.deepEqual(entry.screens.map((s) => s.pathname), ['/Domains/344/Customers', '/Domains/344/Bills']);
  assert.equal(entry.screens[0].count, 2);
});

test('recordScreen: cap de 5 pathnames distintos', () => {
  const entry = { screens: [] };
  for (let i = 0; i < 8; i++) recordScreen(entry, `/p/${i}`, 'x');
  assert.equal(entry.screens.length, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/hash-scanner-screens.test.js`
Expected: FAIL — `describeClickTarget is not a function` (aún no exportado).

- [ ] **Step 3: Write minimal implementation**

En `remote/scripts/hash-scanner.js`, dentro del IIFE:

(a) Añadir estado + listener de click (después de `let knownOpMap = {};`):
```javascript
  const MAX_SCREENS_PER_OP = 5;
  let lastClick = null; // { breadcrumb, ts }
  let clickListener = null;

  // Descripción corta y NO sensible del control clickeado: tag[role]:textoCorto.
  // Trunca el texto a 40 chars; nunca incluye value/payloads.
  function describeClickTarget(el) {
    if (!el) return '(desconocido)';
    const tag = (el.tagName || '').toLowerCase();
    const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
    const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const text = rawText.slice(0, 40);
    return `${tag}${role ? `[${role}]` : ''}${text ? `:${text}` : ''}`;
  }

  // Anexa {pathname, breadcrumb} a entry.screens, dedup por pathname (sube count),
  // cap MAX_SCREENS_PER_OP. Es la evidencia op→pantalla para el generador de catálogo.
  function recordScreen(entry, pathname, breadcrumb) {
    entry.screens = entry.screens || [];
    const hit = entry.screens.find((s) => s.pathname === pathname);
    if (hit) { hit.count++; return; }
    if (entry.screens.length >= MAX_SCREENS_PER_OP) return;
    entry.screens.push({ pathname, breadcrumb, count: 1 });
  }
```

(b) En `start()`, tras `isScanning = true;`, registrar el listener (captura fase para no perder clicks que hagan stopPropagation):
```javascript
    clickListener = (ev) => {
      try { lastClick = { breadcrumb: describeClickTarget(ev.target), ts: Date.now() }; } catch (_) {}
    };
    document.addEventListener('click', clickListener, true);
```

(c) En `stop()`, tras restaurar fetch:
```javascript
    if (clickListener) { document.removeEventListener('click', clickListener, true); clickListener = null; }
```

(d) En el interceptor de `start()` donde se arma `meta` (línea del `const meta = { url: urlStr, apolloVersion };`), añadir pathname + breadcrumb reciente (< 5s):
```javascript
          const pathname = (typeof location !== 'undefined' && location.pathname) ? location.pathname : null;
          const recentClick = (lastClick && Date.now() - lastClick.ts < 5000) ? lastClick.breadcrumb : null;
          const meta = { url: urlStr, apolloVersion, pathname, breadcrumb: recentClick };
```

(e) En `recordOperation`, tras `if (meta?.apolloVersion) entry.apolloVersion = meta.apolloVersion;`:
```javascript
    if (meta?.pathname) {
      const counter = { n: 0 };
      const bc = meta.breadcrumb ? sanitizeValue(meta.breadcrumb, counter) : null;
      recordScreen(entry, meta.pathname, bc);
    }
```

(f) En la inicialización de `discovered[operationName]` (el objeto literal), añadir `screens: [],`.

(g) En `getResults()`, `screens` ya viaja porque se hace `const { _sigs, ...rest } = v;` — `screens` queda en `rest`. Sin cambio.

(h) Exponer en `_internal`: añadir `describeClickTarget, recordScreen` al objeto `_internal`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/hash-scanner-screens.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Deploy del scanner instrumentado**

El hash-scanner es un applet remoto; para usarlo en la sesión de discovery hay que publicarlo:
```bash
tools/deploy.sh "feat(hash-scanner): captura pantalla+breadcrumb por op (Fase B discovery)" --check hash-scanner
```
Verificar con `tools/deploy-status.sh` que la versión EN VIVO subió.

- [ ] **Step 6: Commit** (deploy.sh ya commitea; este step confirma)

Run: `git log --oneline -2` — debe mostrar el bump de config + el cambio de hash-scanner.js.

---

### Task 2: `catalog-generator.mjs` — generar route-catalog desde el scan

**Files:**
- Create: `tools/hash-autopilot/catalog-generator.mjs`
- Test: `tools/test/catalog-generator.test.js`

**Interfaces:**
- Consumes: el `scan_results_*.json` instrumentado (`{scanResults: {ops: {[op]: {status, screens:[{pathname, breadcrumb, count}], ...}}}}`) + el mapa `configHashes` (op→hash de `readConfigHashes`) para saber tipo (query/mutation) y cuáles son del config.
- Produces:
  - `generateCatalog(scanOps, opTypeOf): {routes: {[id]: {type, module, steps, captures}}}` — agrupa ops por `pathname` dominante (el de mayor `count`); una ruta por pathname con `captures` = todas las ops de ese pathname; `module` derivado del pathname (`moduleFromPath`); `steps` = `[{goto: pathname}]` (+ `{clickFirst}` si el breadcrumb indica que hubo click). Determinista: rutas ordenadas por id, captures ordenados alfabéticamente.
  - `moduleFromPath(pathname): string` — segmento de módulo del path (`/Domains/{d}/Customers/123` → `Customers`; `/Dashboards` → `Dashboards`).
  - `opTypeOf` es una función `op → 'query'|'mutation'` (el motor la construye desde config; en tests se mockea).

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/catalog-generator.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCatalog, moduleFromPath } = require('../hash-autopilot/catalog-generator.mjs');

const typeOf = (op) => (/^(Create|Update|Save|Delete|Archive|Add|Remove|Set)/.test(op) ? 'mutation' : 'query');

test('moduleFromPath: extrae el módulo tras /Domains/{id}/', () => {
  assert.equal(moduleFromPath('/Domains/344/Customers/123'), 'Customers');
  assert.equal(moduleFromPath('/Domains/344/Customers'), 'Customers');
  assert.equal(moduleFromPath('/Dashboards'), 'Dashboards');
  assert.equal(moduleFromPath('/'), 'Home');
});

test('generateCatalog: agrupa ops de la misma pantalla en UNA ruta (economía de clics)', () => {
  const scanOps = {
    AllCustomers: { status: 'known', screens: [{ pathname: '/Domains/344/Customers', breadcrumb: null, count: 3 }] },
    CustomerTags: { status: 'known', screens: [{ pathname: '/Domains/344/Customers', breadcrumb: null, count: 1 }] },
    GetBillByIdInDomain: { status: 'known', screens: [{ pathname: '/Domains/344/Bills/9', breadcrumb: 'a:Abrir', count: 2 }] },
  };
  const cat = generateCatalog(scanOps, typeOf);
  // Una ruta para /Customers cubriendo 2 ops, otra para /Bills.
  const customersRoute = Object.values(cat.routes).find((r) => r.module === 'Customers');
  assert.deepEqual(customersRoute.captures, ['AllCustomers', 'CustomerTags']); // ordenado
  assert.deepEqual(customersRoute.steps, [{ goto: '/Domains/344/Customers' }]);
  assert.equal(customersRoute.type, 'query');
});

test('generateCatalog: pathname con click → añade paso clickFirst genérico', () => {
  const scanOps = { GetBillByIdInDomain: { status: 'known', screens: [{ pathname: '/Domains/344/Bills/9', breadcrumb: 'a:Abrir bill', count: 2 }] } };
  const cat = generateCatalog(scanOps, typeOf);
  const r = Object.values(cat.routes)[0];
  assert.equal(r.steps[0].goto, '/Domains/344/Bills'); // sube al listado (quita el id final)
  assert.ok(r.steps.some((s) => s.clickFirst)); // hay un click para abrir el detalle
});

test('generateCatalog: op sin screens se omite (no hay ruta que inferir)', () => {
  const scanOps = { OrphanOp: { status: 'known', screens: [] } };
  const cat = generateCatalog(scanOps, typeOf);
  assert.deepEqual(Object.keys(cat.routes), []);
});

test('generateCatalog: determinista — rutas ordenadas por id', () => {
  const scanOps = {
    ZebraQuery: { status: 'known', screens: [{ pathname: '/Domains/344/Zebra', count: 1 }] },
    AlphaQuery: { status: 'known', screens: [{ pathname: '/Domains/344/Alpha', count: 1 }] },
  };
  const ids = Object.keys(generateCatalog(scanOps, typeOf).routes);
  assert.deepEqual(ids, [...ids].sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/catalog-generator.test.js`
Expected: FAIL — `Cannot find module '../hash-autopilot/catalog-generator.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
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
    const captures = [...g.ops].sort();
    const type = captures.every((op) => opTypeOf(op) === 'query') ? 'query'
      : captures.every((op) => opTypeOf(op) === 'mutation') ? 'mutation' : 'mixed';
    const steps = [{ goto: isDetail ? list : pathname }];
    if (isDetail || g.hadClick) steps.push({ clickFirst: 'a[href]', hrefMatches: '\\d' });
    routes[id] = { type, module, steps, captures };
  }
  // Reordenar por id para salida determinista.
  const ordered = {};
  for (const id of Object.keys(routes).sort()) ordered[id] = routes[id];
  return { routes: ordered };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/catalog-generator.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/catalog-generator.mjs tools/test/catalog-generator.test.js
git commit -m "feat(hash-autopilot): catalog-generator — scan instrumentado → route-catalog (Fase B)"
```

---

### Task 3: `coverage-report.mjs` — medir queries sin ruta

**Files:**
- Create: `tools/hash-autopilot/coverage-report.mjs`
- Test: `tools/test/coverage-report.test.js`

**Interfaces:**
- Consumes: `missingCoverage` de `./hash-autopilot-core.mjs` (ya existe), el catálogo, y la lista de queries del config.
- Produces:
  - `coverageReport(catalog, queryOps): {covered: string[], missing: string[], byModule: {[module]: string[]}, pct: number}` — qué queries tienen ruta vs no, agrupadas por módulo inferido, y el % cubierto. Determinista.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/coverage-report.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { coverageReport } = require('../hash-autopilot/coverage-report.mjs');

const catalog = { routes: {
  'customers-list': { module: 'Customers', captures: ['AllCustomers', 'CustomerTags'] },
  'bills-detail': { module: 'Bills', captures: ['GetBillByIdInDomain'] },
} };

test('coverageReport: separa cubiertas de faltantes y calcula pct', () => {
  const r = coverageReport(catalog, ['AllCustomers', 'CustomerTags', 'GetBillByIdInDomain', 'GetProcessNode', 'GetPurchaseOrder']);
  assert.deepEqual(r.covered.sort(), ['AllCustomers', 'CustomerTags', 'GetBillByIdInDomain'].sort());
  assert.deepEqual(r.missing.sort(), ['GetProcessNode', 'GetPurchaseOrder'].sort());
  assert.equal(r.pct, 60); // 3 de 5
});

test('coverageReport: todas cubiertas → pct 100, missing vacío', () => {
  const r = coverageReport(catalog, ['AllCustomers']);
  assert.equal(r.pct, 100);
  assert.deepEqual(r.missing, []);
});

test('coverageReport: catálogo vacío → pct 0, todas missing', () => {
  const r = coverageReport({ routes: {} }, ['A', 'B']);
  assert.equal(r.pct, 0);
  assert.deepEqual(r.missing.sort(), ['A', 'B']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/coverage-report.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write minimal implementation**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/coverage-report.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/coverage-report.mjs tools/test/coverage-report.test.js
git commit -m "feat(hash-autopilot): coverage-report — queries sin ruta + pct (Fase B)"
```

---

### Task 4: Guion de navegación por módulo (deliverable de discovery)

**Files:**
- Create: `docs/api/hash-fase-b-guion-navegacion.md`

**Interfaces:** documento operativo, sin código. Es el guion que el operador sigue con el scanner corriendo. Se deriva de: los módulos que usan queries hoy (los applets del índice de `CLAUDE.md`) + los módulos del ERP conocidos (Customers, Received Orders/OV, Bills/CxP, Work Orders, Inventory, Sensors/Dashboards, Processes, Reports, Maintenance).

- [ ] **Step 1: Escribir el guion**

Crear `docs/api/hash-fase-b-guion-navegacion.md` con una checklist ordenada por módulo. Cada ítem = una acción de navegación mínima que dispara queries, con la casilla para marcar. Estructura (rellenar con los módulos reales derivados del config + applets):
```markdown
# Guion de navegación — Fase B discovery (hash-autopilot v2)

Corre el applet **hash-scanner** (Iniciar captura), navega esta lista SIN prisa
(deja cargar cada pantalla ~3s para que dispare sus queries), y al terminar
**Detener + Descargar** el scan. Luego pásale el `scan_results_*.json` a Claude.

## Cómo empezar
1. Abre app.gosteelhead.com, entra a tu dominio.
2. Popup de la extensión → hash-scanner → **Iniciar captura**.

## Recorrido por módulo (marca cada uno)
- [ ] **Home / Dominio** — abre `/Domains/{tu-dominio}` (dispara CurrentUser, layout)
- [ ] **Clientes** — abre la lista de Clientes; abre 1 cliente
- [ ] **Órdenes Recibidas (OV)** — abre la lista; abre 1 OV; abre sus partes/PT
- [ ] **Órdenes de Trabajo (OT)** — abre la lista; abre 1 OT; abre su ruteo
- [ ] **Bills / CxP** — busca una PO; abre 1 bill
- [ ] **Inventario** — abre la lista de lotes/inventario; abre 1 lote
- [ ] **Sensores / Dashboards** — abre Dashboards; abre 1 dashboard
- [ ] **Procesos** — abre un proceso; abre su árbol
- [ ] **Reportes** — abre la lista de reportes; abre 1 reporte
- [ ] **Mantenimiento** — abre un nodo de mantenimiento
- [ ] **Facturación** — abre una factura; abre su detalle

## Al terminar
- Detener captura → Descargar `scan_results_*.json` → entregar a Claude.
```
**Nota:** el guion se afina en la segunda pasada con las queries que `coverage-report` reporte como faltantes (dirigidas al módulo específico).

- [ ] **Step 2: Commit**

```bash
git add docs/api/hash-fase-b-guion-navegacion.md
git commit -m "docs(hash-autopilot): guion de navegación Fase B (discovery por módulo)"
```

---

### Task 5: Runbook de la sesión de discovery (orquestación end-to-end)

**Files:**
- Create: `tools/hash-autopilot/build-catalog.mjs`
- Test: manual (integración con un scan real)

**Interfaces:**
- Consumes: un `scan_results_*.json` real (de `~/Downloads`), `route-catalog.json` actual, `remote/config.json`.
- Produces: `build-catalog.mjs <scan.json>` — lee el scan, construye `opTypeOf` desde `config.steelhead.hashes`, corre `generateCatalog`, **fusiona** con el `route-catalog.json` existente (no pisa rutas ya validadas a mano — las del scan solo añaden/actualizan), escribe el catálogo, e imprime el `coverageReport` (pct + faltantes por módulo). NO deploya (el operador revisa el diff del catálogo antes).

- [ ] **Step 1: Escribir el orquestador**

```javascript
// tools/hash-autopilot/build-catalog.mjs
// Toma un scan instrumentado y (re)genera route-catalog.json + reporta cobertura.
// Uso: node build-catalog.mjs /ruta/scan_results_*.json
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateCatalog } from './catalog-generator.mjs';
import { coverageReport } from './coverage-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, 'route-catalog.json');
const CONFIG_PATH = join(__dirname, '../../remote/config.json');

const scanPath = process.argv[2];
if (!scanPath) { console.error('uso: node build-catalog.mjs <scan_results.json>'); process.exit(1); }

const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
const scanOps = scan.scanResults?.ops || scan.ops || {};
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const queries = config.steelhead.hashes.queries || {};
const mutations = config.steelhead.hashes.mutations || {};
const opTypeOf = (op) => (op in mutations ? 'mutation' : 'query');

const generated = generateCatalog(scanOps, opTypeOf);

// Fusión: preserva rutas existentes (validadas a mano en Fase A); añade/actualiza las del scan.
const existing = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const mergedRoutes = { ...existing.routes };
for (const [id, route] of Object.entries(generated.routes)) mergedRoutes[id] = route;
const orderedRoutes = {};
for (const id of Object.keys(mergedRoutes).sort()) orderedRoutes[id] = mergedRoutes[id];
const merged = { ...existing, routes: orderedRoutes };
writeFileSync(CATALOG_PATH, JSON.stringify(merged, null, 2) + '\n');

const rep = coverageReport(merged, Object.keys(queries));
console.log(`route-catalog.json actualizado: ${Object.keys(orderedRoutes).length} rutas.`);
console.log(`Cobertura de queries: ${rep.covered.length}/${Object.keys(queries).length} (${rep.pct}%).`);
if (rep.missing.length) console.log(`Faltan ruta (${rep.missing.length}): ${rep.missing.join(', ')}`);
```

- [ ] **Step 2: Verificación con el scan de discovery real**

Tras la sesión de navegación (Task 4), correr:
```bash
cd tools/hash-autopilot && node build-catalog.mjs ~/Downloads/scan_results_<fecha>.json
```
Expected: imprime el % de cobertura y las queries faltantes. Revisar el `git diff` de `route-catalog.json` (rutas nuevas coherentes; no pisó las 4 de Fase A). Iterar Task 4 (segunda pasada dirigida a las faltantes) hasta un pct aceptable (meta ≥ 80% de las queries activas).

- [ ] **Step 3: Commit del catálogo poblado**

```bash
git add tools/hash-autopilot/build-catalog.mjs tools/hash-autopilot/route-catalog.json
git commit -m "feat(hash-autopilot): build-catalog + route-catalog poblado desde discovery (Fase B)"
```

- [ ] **Step 4: Deploy no aplica** — `route-catalog.json` y los `.mjs` son del motor local (no del bundle de la extensión); solo el scanner (Task 1) se deployó. Confirmar que `run-hash-autopilot.sh` selecciona ahora más rutas con un dry-run:
```bash
node hash-autopilot.mjs --dry-run --date=<hoy> 2>&1 | grep "Rutas seleccionadas"
```

---

## Self-Review

**Spec coverage (§ del spec 2026-07-06):**
- §8 instrumentar hash-scanner (pathname + breadcrumb) → Task 1 ✓
- §8 guion de navegación por módulo → Task 4 ✓
- §8 auto-generar route-catalog del scan → Task 2 + Task 5 ✓
- §8 medir cobertura (missingCoverage) → Task 3 + Task 5 ✓
- §8 segunda pasada dirigida → Task 5 Step 2 (iterar) ✓
- §9 Fase B completar las 113 queries → Tasks 1-5 (mutations solo se registran; su ejecución es Fase C) ✓

**Placeholder scan:** El guion (Task 4) tiene módulos concretos derivados del ERP; se afina con datos reales en la 2ª pasada (declarado, no un TBD de diseño). Sin otros placeholders.

**Type consistency:** `generateCatalog(scanOps, opTypeOf)→{routes}`, `moduleFromPath(pathname)→string`, `coverageReport(catalog, queryOps)→{covered,missing,byModule,pct}`, `describeClickTarget(el)→string`, `recordScreen(entry, pathname, breadcrumb)`. El `{routes:{id:{type,module,steps,captures}}}` que emite `generateCatalog` (Task 2) coincide con el que `selectRoutes` (Fase A) consume y con `route-catalog.json` (Task 3/5). `build-catalog.mjs` (Task 5) consume `generateCatalog` + `coverageReport` con esas firmas. ✓

**Riesgos para el ejecutor:**
- Task 1 requiere **deploy** del scanner (applet remoto) — coordinar el bump de `config.json` (hot file) con las otras sesiones (regla de trabajo paralelo).
- El breadcrumb depende de que el click preceda a la op por < 5s; queries disparadas por navegación pura (goto sin click) quedan con `breadcrumb: null` y el generador usa solo `goto` — correcto.
- La calidad del catálogo depende de la sesión de navegación; `coverage-report` es el termómetro para saber cuándo parar.
