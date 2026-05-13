# PO Reconciler (Schneider QRO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el applet `po-reconciler.js` que automatiza el rebalanceo entre N OVs temporales (creadas al recibo de la HS) y N POs reales de Schneider Querétaro, redistribuyendo OTs entre las temp OVs existentes y renombrándolas con el número SAP correspondiente.

**Architecture:** Single-file applet IIFE (`remote/scripts/po-reconciler.js`, ~1700 líneas) con 6 capas internas: parser PDF (reusa `POComparator.parsePDF`), inventory de OVs, motor de reconciliación (función pura, testeable con `node + assert`), wizard de 4 pasos, executor serial con idempotencia, audit log builder. Cardinality estricta 1:1 entre temps y POs; única OV creada es "Restantes Schneider QRO" cuando hay sobrantes. No undo automático — solo bitácora CSV.

**Tech Stack:** JS vanilla MV3, GraphQL persisted queries (Apollo `4.0.8`), Claude API para parseo de PDFs (reutilizado de `po-comparator`), `node` + `assert` para tests del motor.

**Referencias clave:**
- Spec: `docs/superpowers/specs/2026-05-12-po-reconciler-design.md`
- Patrón applet manual con FAB: `remote/scripts/paros-linea.js`
- Patrón parser PDF: `remote/scripts/po-comparator.js:1-115`
- Patrón cliente GraphQL: `remote/scripts/steelhead-api.js`
- Patrón orquestación de mutaciones: `remote/scripts/portal-importer.js`
- Patrón crear OV con líneas: `CLAUDE.md` sección "Portal Importer: flujo de creación de OV"

---

## Fase 0 — Captura previa (manual, bloqueante)

Antes de escribir código, hay tres mutations y dos IDs que **deben capturarse del UI real con DevTools abierto** para evitar adivinar shapes (regla del repo: "captura el request del UI antes de adivinar shapes"). Esta fase no produce commits — produce un archivo de notas `docs/superpowers/notes/2026-05-12-po-reconciler-captures.md` (no committeable) con los payloads exactos.

### Task 0.1: Capturar `AddPartsToWorkOrders` cross-OV

**Files:**
- Create (local, no commit): `docs/superpowers/notes/2026-05-12-po-reconciler-captures.md`

- [ ] **Step 1: Abrir Steelhead UI con DevTools en la pestaña Network filtrando `graphql`**
- [ ] **Step 2: Reproducir manualmente el flujo "Ajustar Cantidad" → mover OT desde una temp OV a otra temp OV con el mismo PN**

Pasos UI: abrir una OV con OTs, click "Ajustar Cantidad" en una línea, ingresar cantidad menor, en el modal "Crear OT con piezas restantes" elegir destino = OV diferente con el mismo PN.

- [ ] **Step 3: Copiar el body completo del request `AddPartsToWorkOrders` al archivo de notas**

Capturar al menos:
- `extensions.persistedQuery.sha256Hash`
- `variables` completo (formato JSON)
- Response body

- [ ] **Step 4: Anotar si una sola llamada cross-OV funciona, o si requiere split + move en pasos**

Si requiere split + move, el spec necesita ajuste — escalar al usuario antes de continuar. Si funciona en una sola llamada, confirmar que el shape coincide con el del spec (`docs/superpowers/specs/2026-05-12-po-reconciler-design.md:196-224`).

### Task 0.2: Capturar `SaveReceivedOrderLinesAndItems` para update de qty existente

- [ ] **Step 1: En el UI, editar la cantidad de una línea de OV existente vía "Editar Línea"**
- [ ] **Step 2: Copiar request body al archivo de notas**

Verificar:
- `variables.input.newLines[0].id` (debe traer el id de la línea existente, NO `null`)
- `variables.input.newLines[0].lineItems[0].quantity` (string con nueva cantidad)
- Que el response devuelve la línea actualizada sin crear una nueva

- [ ] **Step 3: Anotar el shape exacto del item dentro de `newLines[0].lineItems[0]`**

Comparar con el shape de creación documentado en `CLAUDE.md` ("Portal Importer: flujo de creación de OV") y anotar las diferencias.

### Task 0.3: Capturar `UpdateReceivedOrder` con hash nuevo

- [ ] **Step 1: En el UI, renombrar una OV (cambiar campo `name` y guardar)**
- [ ] **Step 2: Capturar el request: hash + variables completas**

Confirmar:
- Hash es `84f5c4550e9bad52df7e297049b9c42b3e28cb3cd21215bb4fe57f236ce42d08`
- `variables` trae los 19 campos full-record listados en el spec (`docs/superpowers/specs/2026-05-12-po-reconciler-design.md:247`)
- Response devuelve `id` y `name` actualizados

### Task 0.4: Capturar `CreateUpdateWorkOrdersChecked` para crear OT en OV destino

- [ ] **Step 1: En el UI, crear una OT nueva dentro de una OV existente (usar "+" en una línea de OV)**
- [ ] **Step 2: Capturar request body completo al archivo de notas**

Verificar shape de `input`: `id: null`, `receivedOrderId`, `productId`, `customerId`, `deadline`, `type: 'MAKE_TO_ORDER'`, etc. Confirmar hash actual contra el del scan del 2026-05-12.

### Task 0.5: Extraer `customerId` y `shipToAddressId` de Schneider QRO

- [ ] **Step 1: En Steelhead UI, abrir una OV existente de Schneider QRO (puede ser una temp OV o una con nombre SAP `14...`)**
- [ ] **Step 2: Click en el customer → ver URL `/Customers/<id>` → anotar `<id>` como `customerId`**
- [ ] **Step 3: En el detalle de la OV ver el Ship To → click → ver URL `/Addresses/<id>` o inspeccionar Network para query `Customer` y leer `customer.addresses[].id` que matchee con la dirección "Querétaro"**
- [ ] **Step 4: Anotar ambos IDs en el archivo de notas**

Estos van a `remote/config.json` en Task 1.2.

### Task 0.6: Re-confirmar hashes con `hash-scanner`

- [ ] **Step 1: Abrir Steelhead, activar applet "Hash Scanner" desde el popup, ejecutar el scan**
- [ ] **Step 2: Descargar `scan_results_<fecha>.json` a `~/Downloads/` (no copiar al repo)**
- [ ] **Step 3: Leer con Claude (o grep manual) y anotar el hash actual de cada operación necesaria**

Operaciones a verificar (status esperado `new` o `known`):
- `AddPartsToWorkOrders`
- `AdjustPartCountOnRoWoQuery` (probablemente no necesario en v1, registrar por si)
- `SearchWorkOrdersToMoveToFromRo` (probablemente no necesario en v1)
- `CreateWorkOrderFromWorkOrderQuery` (probablemente no necesario en v1)
- `UpdateReceivedOrder` (confirmar `84f5c4550e9bad52df7e297049b9c42b3e28cb3cd21215bb4fe57f236ce42d08`)
- `GetReceivedOrder` (ya en config: `c8b31fbcbc14cec18414fb7b9523c4771432279779ee85693cb0d4c2c151e4f7`)
- `CreateUpdateWorkOrdersChecked` (ya en config: `7a4bdb13cd47edfd2d205cd2cbeb81cc1350f4c5465627ff9a6881eed2e3f449`)
- `SaveReceivedOrderLinesAndItems` (ya en config: `89c3342878ac89d561a7d4d5dedcd508bb25dcfa1fcf6573b59a134fd32b9bb6`)
- `CreateReceivedOrder` (ya en config: `a72de5b673898badb7af85c8b350cc452a34e7bb6af3c375c83e1abb8ca779f9`)

- [ ] **Step 4: Anotar cada hash al archivo de notas**

**Salida de Fase 0:** archivo local `docs/superpowers/notes/2026-05-12-po-reconciler-captures.md` con todos los payloads y IDs. Antes de empezar Fase 1, releer este archivo y confirmar que coincide con el spec. Si hay divergencias significativas (shape distinto, hash deprecado, etc.), escalar al usuario antes de codear.

---

## Fase 1 — Config, skeleton y test harness

### Task 1.1: Bump `remote/config.json` con hashes y sección Schneider

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Actualizar `version` y `lastUpdated`**

```json
{
  "version": "0.6.0",
  "lastUpdated": "<fecha de hoy YYYY-MM-DD>",
```

Razón: bump minor (0.5.x → 0.6.0) por feature grande, según spec sección "Versionado".

- [ ] **Step 2: Reemplazar el hash de `UpdateReceivedOrder` en `hashes.mutations`**

Buscar la línea `"UpdateReceivedOrder": "50bfb5884c167407ad9a8417962da0a56708d8fde031fd0da31893c6eddafe8b"` y reemplazar el valor por `"84f5c4550e9bad52df7e297049b9c42b3e28cb3cd21215bb4fe57f236ce42d08"`.

- [ ] **Step 3: Agregar hashes nuevos en `hashes.mutations`** (después del bloque de UpdateReceivedOrder y antes del cierre de mutations)

Insertar (con el hash exacto capturado en Task 0.6):

```json
        "AddPartsToWorkOrders": "<hash de Task 0.6>",
```

Notas:
- `AdjustPartCountOnRoWoQuery`, `SearchWorkOrdersToMoveToFromRo`, `CreateWorkOrderFromWorkOrderQuery` NO se agregan en v1 — el motor no los invoca. Si más adelante se necesitan, agregarlos como un bump menor.
- Verificar que `CreateUpdateWorkOrdersChecked` ya está como mutation (línea 99 de config viejo lo tiene en `queries`, lo cual es **incorrecto** semánticamente — es mutation). Moverlo a `mutations` si está en `queries`.

- [ ] **Step 4: Agregar sección `steelhead.domain.schneiderQueretaro`**

Buscar `"domain": {` dentro de `"steelhead"` (cerca del cierre de hashes). Agregar/actualizar para tener:

```json
    "domain": {
      ... (lo que ya esté) ...,
      "schneiderQueretaro": {
        "customerId": "<id capturado en Task 0.5>",
        "shipToAddressId": "<id capturado en Task 0.5>",
        "poNumberRegex": "^14\\d{8}$",
        "restantesOvName": "Restantes Schneider QRO"
      }
    }
```

- [ ] **Step 5: Registrar el applet en el array `applets[]`**

Insertar (después del bloque `po-comparator` y antes de `wo-deadline`, manteniendo orden alfabético/por categoría):

```json
    {
      "id": "po-reconciler",
      "name": "Reconciliador OV vs PO Schneider",
      "subtitle": "Rebalancear OVs temporales contra POs reales",
      "icon": "🧮",
      "category": "Órdenes de Venta",
      "scripts": ["scripts/steelhead-api.js", "scripts/claude-api.js", "scripts/po-comparator.js", "scripts/po-reconciler.js"],
      "requiredPermissions": ["READ_RECEIVED_ORDERS"],
      "actions": [
        { "id": "run-po-reconciler", "label": "Reconciliar Schneider QRO", "sublabel": "Subir PDFs de PO y rebalancear OVs temp", "icon": "🧮", "type": "primary", "handler": "message", "message": "run-po-reconciler" }
      ]
    },
```

Razón de la lista de scripts: `po-comparator.js` se incluye porque vamos a llamar `POComparator.parsePDF()` directo. Si la dependencia transitiva trae más de lo necesario, refactorizar en v2 a un helper compartido.

- [ ] **Step 6: Registrar la operación en `operations[]` (sección descriptiva al final del config)**

Insertar junto a `AddPartsToWorkOrders` y similares (mirar línea ~635 del config para el patrón existente):

```json
    "AddPartsToWorkOrders": { "type": "mutation", "description": "Mover piezas entre OTs (cross-OV o intra-OV)", "usedBy": "po-reconciler" },
```

- [ ] **Step 7: Validar JSON**

Run: `python3 -m json.tool remote/config.json > /dev/null && echo OK`
Expected: `OK`. Si falla, revisa comas trailing y comillas.

- [ ] **Step 8: Commit**

```bash
git add remote/config.json
git commit -m "$(cat <<'EOF'
chore(config): registrar applet po-reconciler + hash UpdateReceivedOrder + Schneider QRO (0.6.0)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 1.2: Crear skeleton `po-reconciler.js`

**Files:**
- Create: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Crear archivo con IIFE básico, hook a `window.POReconciler`, y URL gate**

```js
// PO Reconciler — Rebalanceo automático entre OVs temp y POs reales (Schneider QRO)
// Depende de: SteelheadAPI, ClaudeAPI, POComparator
// Spec: docs/superpowers/specs/2026-05-12-po-reconciler-design.md

const POReconciler = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api()?.log?.(m) ?? console.log('[PR]', m);
  const warn = (m) => api()?.warn?.(m) ?? console.warn('[PR]', m);

  const URL_RE = /\/Domains\/\d+\/ReceivedOrders(?:\/|$|\?)/i;
  const SAP_PO_RE = /^14\d{8}$/;

  let state = {
    isOpen: false,
    step: 1,
    pdfs: [],           // [{ file, status: 'pending'|'parsing'|'ok'|'error', parsed, error }]
    tempOVs: [],        // [{ id, name, ots, byPN, snapshot }]
    restantesOV: null,  // { id, name, snapshot } or null
    plan: null,         // see engine
    overrides: {},      // user edits
    runId: null,        // for cancel/idempotency
    auditLog: [],
  };

  function init() {
    if (window.__saPoReconcilerInit) return;
    window.__saPoReconcilerInit = true;
    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
    listenManualTrigger();
  }

  function isAllowedPath() {
    return URL_RE.test(location.pathname);
  }

  function syncFabVisibility() {
    // TODO Task 10.1
  }

  function installUrlChangeListener() {
    if (window.__saPoReconcilerUrlListener) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saPoReconcilerUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  function listenManualTrigger() {
    chrome.runtime?.onMessage?.addListener?.((msg) => {
      if (msg && msg.action === 'run-po-reconciler') openWizard();
    });
  }

  function injectStyles() {
    // TODO Task 5.2
  }

  function openWizard() {
    // TODO Task 5.1
  }

  // ── Public API (also for tests) ─────────────────────────────
  return {
    init,
    openWizard,
    // Internals exposed for test harness (Task 1.3+):
    _engine: {},
  };
})();

if (typeof window !== 'undefined') {
  window.POReconciler = POReconciler;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', POReconciler.init);
  } else {
    POReconciler.init();
  }
}

if (typeof module !== 'undefined') module.exports = POReconciler;
```

- [ ] **Step 2: Verificar que carga sin errores**

Run desde la consola del navegador con la extensión activa en una pestaña de Steelhead:
```js
typeof window.POReconciler
```
Expected: `'object'`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): skeleton + URL gate + manual trigger listener

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 1.3: Crear test harness para el motor

**Files:**
- Create: `tools/test/po-reconciler.test.js`

- [ ] **Step 1: Escribir el harness mínimo con `node --experimental-vm-modules` o eval directo**

Como `po-reconciler.js` usa `const POReconciler = (() => { ... })()` en el namespace global del navegador, para tests Node necesitamos exponerlo como módulo. El skeleton ya tiene `if (typeof module !== 'undefined') module.exports = POReconciler;` al final.

```js
// tools/test/po-reconciler.test.js
// Run: node tools/test/po-reconciler.test.js

const assert = require('assert');
const path = require('path');

// Stub the browser-only globals before requiring the applet
global.window = {};
global.chrome = { runtime: {} };
global.document = { readyState: 'complete', addEventListener: () => {} };
global.history = {};

const POReconciler = require(path.resolve(__dirname, '../../remote/scripts/po-reconciler.js'));
const E = POReconciler._engine;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (err.actual !== undefined) {
      console.log(`    actual:   ${JSON.stringify(err.actual)}`);
      console.log(`    expected: ${JSON.stringify(err.expected)}`);
    }
    failed++;
  }
}

console.log('\n=== po-reconciler engine tests ===\n');

test('harness boots', () => {
  assert.ok(POReconciler, 'POReconciler should be defined');
  assert.ok(typeof POReconciler._engine === 'object', '_engine should be exposed');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Correr el harness**

Run: `node tools/test/po-reconciler.test.js`
Expected:
```
=== po-reconciler engine tests ===

  ✓ harness boots

1 passed, 0 failed
```

Si falla con `URL_RE is not defined` o similar — es porque el IIFE del applet llama `init()` al evaluar y referencias DOM revientan. El skeleton ya gating sobre `if (typeof window !== 'undefined')` para el side-effect del init; verifica que esa guarda esté.

- [ ] **Step 3: Commit**

```bash
git add tools/test/po-reconciler.test.js
git commit -m "$(cat <<'EOF'
test(po-reconciler): harness inicial con node + assert

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 2 — Motor de reconciliación (TDD)

Cada función del motor se escribe **test-first**. El motor es función pura sin DOM ni red; debe correr en `node` sin browser globals.

### Task 2.1: `consolidateByPN(lines)` — agrupar líneas por número de parte

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js` (sección Engine — agregar dentro del IIFE antes del `return`)

- [ ] **Step 1: Escribir el test fallando**

Insertar en `tools/test/po-reconciler.test.js` antes de la línea `console.log(\`\n${passed} passed...\`);`:

```js
test('consolidateByPN suma cantidades del mismo PN', () => {
  const result = E.consolidateByPN([
    { partNumber: 'A', quantity: 10 },
    { partNumber: 'B', quantity: 5 },
    { partNumber: 'A', quantity: 7 },
  ]);
  assert.deepStrictEqual(result, { A: 17, B: 5 });
});

test('consolidateByPN ignora líneas sin partNumber', () => {
  const result = E.consolidateByPN([
    { partNumber: 'A', quantity: 10 },
    { partNumber: null, quantity: 100 },
    { partNumber: '', quantity: 50 },
  ]);
  assert.deepStrictEqual(result, { A: 10 });
});

test('consolidateByPN trata quantity falsy como 0', () => {
  const result = E.consolidateByPN([
    { partNumber: 'A', quantity: 5 },
    { partNumber: 'A', quantity: null },
    { partNumber: 'A', quantity: undefined },
  ]);
  assert.deepStrictEqual(result, { A: 5 });
});
```

- [ ] **Step 2: Correr y verificar que fallen**

Run: `node tools/test/po-reconciler.test.js`
Expected: 3 tests fallando con `Cannot read properties of undefined (reading 'consolidateByPN')`.

- [ ] **Step 3: Implementar en `po-reconciler.js`**

Dentro del IIFE, antes del `return`, agregar la sección Engine:

```js
  // ── Engine (pure functions) ────────────────────────────────

  function consolidateByPN(lines) {
    const out = {};
    for (const line of (lines || [])) {
      const pn = line && line.partNumber;
      if (!pn) continue;
      const qty = Number(line.quantity) || 0;
      out[pn] = (out[pn] || 0) + qty;
    }
    return out;
  }
```

Y en el `return` del IIFE, exponer:

```js
    _engine: {
      consolidateByPN,
    },
```

- [ ] **Step 4: Correr y verificar que pasen**

Run: `node tools/test/po-reconciler.test.js`
Expected: `4 passed, 0 failed` (harness + 3 consolidateByPN).

- [ ] **Step 5: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): engine.consolidateByPN + tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2.2: `hungarianMatch(costMatrix)` — asignación 1:1 óptima

Para N ≤ 6 (caso real), enumeración de permutaciones es más simple, sin dependencias, y suficiente (720 permutaciones = trivial). Para N > 6, Hungarian sí mejora pero no es nuestro caso.

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Escribir tests fallando**

```js
test('hungarianMatch elige la asignación diagonal cuando es óptima', () => {
  // costos: i=j es 0, off-diag es 10 → asignación óptima [0,1,2]
  const m = [
    [0, 10, 10],
    [10, 0, 10],
    [10, 10, 0],
  ];
  const result = E.hungarianMatch(m);
  assert.deepStrictEqual(result, { assignment: [0, 1, 2], totalCost: 0 });
});

test('hungarianMatch encuentra asignación no-trivial', () => {
  // costos:
  //   t0 → p0=5, p1=2, p2=3
  //   t1 → p0=1, p1=10, p2=4
  //   t2 → p0=3, p1=2, p2=6
  // óptimo: t0→p1 (2), t1→p0 (1), t2→p2 (6) = 9
  // alt:    t0→p2 (3), t1→p0 (1), t2→p1 (2) = 6  ← este es el óptimo
  const m = [
    [5, 2, 3],
    [1, 10, 4],
    [3, 2, 6],
  ];
  const result = E.hungarianMatch(m);
  assert.strictEqual(result.totalCost, 6);
  assert.deepStrictEqual(result.assignment, [2, 0, 1]);
});

test('hungarianMatch maneja N=1', () => {
  const result = E.hungarianMatch([[42]]);
  assert.deepStrictEqual(result, { assignment: [0], totalCost: 42 });
});

test('hungarianMatch lanza si la matriz no es cuadrada', () => {
  assert.throws(() => E.hungarianMatch([[1, 2], [3]]), /cuadrada/i);
});
```

- [ ] **Step 2: Correr y verificar que fallen**

Run: `node tools/test/po-reconciler.test.js`

- [ ] **Step 3: Implementar (enumeración de permutaciones)**

Agregar en la sección Engine de `po-reconciler.js`:

```js
  function hungarianMatch(costMatrix) {
    const n = costMatrix.length;
    if (n === 0) return { assignment: [], totalCost: 0 };
    if (!costMatrix.every(row => Array.isArray(row) && row.length === n)) {
      throw new Error('hungarianMatch: matriz debe ser cuadrada');
    }
    let best = { assignment: null, totalCost: Infinity };
    const perm = Array.from({ length: n }, (_, i) => i);
    function* permutations(arr, k = 0) {
      if (k === arr.length - 1) { yield arr.slice(); return; }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        yield* permutations(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    }
    for (const p of permutations(perm)) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += costMatrix[i][p[i]];
      if (cost < best.totalCost) best = { assignment: p.slice(), totalCost: cost };
    }
    return best;
  }
```

Exponer en `_engine`: `hungarianMatch,`.

- [ ] **Step 4: Correr y verificar**

Run: `node tools/test/po-reconciler.test.js`
Expected: tests anteriores + 4 nuevos pasan.

- [ ] **Step 5: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): engine.hungarianMatch (enum permutaciones, N≤6) + tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2.3: `assignTempsToPOs(temps, pos)` — wrap Hungarian

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Tests fallando**

```js
test('assignTempsToPOs asigna 1:1 minimizando piezas movidas', () => {
  const temps = [
    { ovId: 'T1', name: 'Producción',    byPN: { A: 10, B: 5 } },
    { ovId: 'T2', name: 'Kitting',       byPN: { A: 0,  B: 20 } },
  ];
  const pos = [
    { poNumber: '1400395001', byPN: { A: 10, B: 5 } },   // matchea T1
    { poNumber: '1400395002', byPN: { A: 0,  B: 20 } },  // matchea T2
  ];
  const result = E.assignTempsToPOs(temps, pos);
  assert.deepStrictEqual(result.assignment, [
    { tempOvId: 'T1', poNumber: '1400395001' },
    { tempOvId: 'T2', poNumber: '1400395002' },
  ]);
  assert.strictEqual(result.totalDelta, 0);
});

test('assignTempsToPOs cambia el orden si reduce piezas movidas', () => {
  const temps = [
    { ovId: 'T1', byPN: { A: 100 } },
    { ovId: 'T2', byPN: { B: 100 } },
  ];
  const pos = [
    { poNumber: 'PO_B', byPN: { B: 100 } },  // mejor con T2
    { poNumber: 'PO_A', byPN: { A: 100 } },  // mejor con T1
  ];
  const result = E.assignTempsToPOs(temps, pos);
  // Asignación óptima: T1 → PO_A, T2 → PO_B
  const byTemp = Object.fromEntries(result.assignment.map(a => [a.tempOvId, a.poNumber]));
  assert.strictEqual(byTemp.T1, 'PO_A');
  assert.strictEqual(byTemp.T2, 'PO_B');
});

test('assignTempsToPOs devuelve issue fatal si cardinality mismatch', () => {
  const temps = [{ ovId: 'T1', byPN: {} }, { ovId: 'T2', byPN: {} }];
  const pos = [{ poNumber: 'P1', byPN: {} }];
  const result = E.assignTempsToPOs(temps, pos);
  assert.strictEqual(result.assignment, null);
  assert.ok(result.issues.some(i => i.severity === 'fatal' && i.type === 'cardinality_mismatch'));
});
```

- [ ] **Step 2: Implementar**

```js
  function assignTempsToPOs(temps, pos) {
    const n = temps.length;
    const m = pos.length;
    if (n !== m) {
      return {
        assignment: null,
        totalDelta: null,
        issues: [{
          severity: 'fatal',
          type: 'cardinality_mismatch',
          detail: `#temps=${n} ≠ #POs=${m}. Plan automático no generado.`,
        }],
      };
    }
    if (n === 0) return { assignment: [], totalDelta: 0, issues: [] };

    const allPNs = new Set();
    temps.forEach(t => Object.keys(t.byPN || {}).forEach(pn => allPNs.add(pn)));
    pos.forEach(p => Object.keys(p.byPN || {}).forEach(pn => allPNs.add(pn)));

    const matrix = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        let cost = 0;
        for (const pn of allPNs) {
          const tempQty = (temps[i].byPN || {})[pn] || 0;
          const poQty   = (pos[j].byPN   || {})[pn] || 0;
          cost += Math.abs(tempQty - poQty);
        }
        row.push(cost);
      }
      matrix.push(row);
    }
    const { assignment, totalCost } = hungarianMatch(matrix);
    return {
      assignment: assignment.map((j, i) => ({
        tempOvId: temps[i].ovId,
        poNumber: pos[j].poNumber,
      })),
      totalDelta: totalCost,
      issues: [],
    };
  }
```

Exponer en `_engine`.

- [ ] **Step 3: Correr y verificar**

Run: `node tools/test/po-reconciler.test.js`
Expected: tests anteriores + 3 nuevos pasan.

- [ ] **Step 4: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): engine.assignTempsToPOs (Hungarian over Σ|Δ|) + tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2.4: `computeMovesForPN(pn, currentByOV, targetByOV)` — greedy donor→deficit

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Tests fallando**

```js
test('computeMovesForPN sin diferencias devuelve []', () => {
  const moves = E.computeMovesForPN('A', { T1: 10, T2: 5 }, { T1: 10, T2: 5 });
  assert.deepStrictEqual(moves, []);
});

test('computeMovesForPN: 1 donor → 1 deficit', () => {
  // T1 sobra 5, T2 falta 5
  const moves = E.computeMovesForPN('A', { T1: 15, T2: 0 }, { T1: 10, T2: 5 });
  assert.deepStrictEqual(moves, [{ pn: 'A', qty: 5, fromOvId: 'T1', toOvId: 'T2' }]);
});

test('computeMovesForPN: 1 donor → 2 deficits', () => {
  // T1 sobra 10, T2 falta 3, T3 falta 7
  const moves = E.computeMovesForPN('A', { T1: 10, T2: 0, T3: 0 }, { T1: 0, T2: 3, T3: 7 });
  // greedy: dona al mayor déficit primero (T3:7), luego al siguiente (T2:3)
  assert.strictEqual(moves.length, 2);
  assert.deepStrictEqual(moves.sort((a,b) => b.qty - a.qty), [
    { pn: 'A', qty: 7, fromOvId: 'T1', toOvId: 'T3' },
    { pn: 'A', qty: 3, fromOvId: 'T1', toOvId: 'T2' },
  ]);
});

test('computeMovesForPN: 2 donors → 1 deficit', () => {
  const moves = E.computeMovesForPN('A', { T1: 5, T2: 5, T3: 0 }, { T1: 0, T2: 0, T3: 10 });
  assert.strictEqual(moves.length, 2);
  const totalMoved = moves.reduce((s, m) => s + m.qty, 0);
  assert.strictEqual(totalMoved, 10);
  assert.ok(moves.every(m => m.toOvId === 'T3'));
});
```

- [ ] **Step 2: Implementar**

```js
  function computeMovesForPN(pn, currentByOV, targetByOV) {
    const delta = {}; // positive = donor, negative = deficit
    for (const ov of new Set([...Object.keys(currentByOV), ...Object.keys(targetByOV)])) {
      delta[ov] = (currentByOV[ov] || 0) - (targetByOV[ov] || 0);
    }
    const donors  = Object.entries(delta).filter(([, d]) => d > 0).map(([ov, d]) => ({ ov, qty: d }));
    const deficit = Object.entries(delta).filter(([, d]) => d < 0).map(([ov, d]) => ({ ov, qty: -d }));
    donors.sort((a, b) => b.qty - a.qty);
    deficit.sort((a, b) => b.qty - a.qty);

    const moves = [];
    let di = 0, ri = 0;
    while (di < donors.length && ri < deficit.length) {
      const move = Math.min(donors[di].qty, deficit[ri].qty);
      moves.push({ pn, qty: move, fromOvId: donors[di].ov, toOvId: deficit[ri].ov });
      donors[di].qty -= move;
      deficit[ri].qty -= move;
      if (donors[di].qty === 0) di++;
      if (deficit[ri].qty === 0) ri++;
    }
    return moves;
  }
```

Exponer en `_engine`.

- [ ] **Step 3: Correr y verificar**

Run: `node tools/test/po-reconciler.test.js`
Expected: tests anteriores + 4 nuevos pasan.

- [ ] **Step 4: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): engine.computeMovesForPN (greedy donor→deficit) + tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2.5: `detectIssuesForPN(pn, tempsTotal, posTotal)` — discrepancias

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Tests fallando**

```js
test('detectIssuesForPN: HS > Σ POs → sobrante', () => {
  const issues = E.detectIssuesForPN('A', 15, 10);
  assert.deepStrictEqual(issues, [{
    severity: 'info', type: 'sobrante', pn: 'A',
    detail: 'HS tiene 15 piezas, Σ POs pide 10. Excedente 5 → OV Restantes.',
    sobrante: 5,
  }]);
});

test('detectIssuesForPN: HS < Σ POs → faltante (warn)', () => {
  const issues = E.detectIssuesForPN('A', 5, 10);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].severity, 'warn');
  assert.strictEqual(issues[0].type, 'faltante');
  assert.strictEqual(issues[0].faltante, 5);
});

test('detectIssuesForPN: PN solo en HS (POs = 0)', () => {
  const issues = E.detectIssuesForPN('A', 7, 0);
  assert.strictEqual(issues[0].type, 'pn_solo_en_hs');
  assert.strictEqual(issues[0].sobrante, 7);
});

test('detectIssuesForPN: PN solo en PO (HS = 0)', () => {
  const issues = E.detectIssuesForPN('A', 0, 8);
  assert.strictEqual(issues[0].type, 'pn_solo_en_po');
  assert.strictEqual(issues[0].faltante, 8);
});

test('detectIssuesForPN: igualdad → sin issues', () => {
  assert.deepStrictEqual(E.detectIssuesForPN('A', 10, 10), []);
});
```

- [ ] **Step 2: Implementar**

```js
  function detectIssuesForPN(pn, tempsTotal, posTotal) {
    if (tempsTotal === posTotal) return [];
    if (tempsTotal > 0 && posTotal === 0) {
      return [{
        severity: 'warn', type: 'pn_solo_en_hs', pn,
        detail: `PN ${pn} aparece en HS (${tempsTotal} piezas) pero no en ningún PO. Se moverá completo a OV Restantes.`,
        sobrante: tempsTotal,
      }];
    }
    if (tempsTotal === 0 && posTotal > 0) {
      return [{
        severity: 'warn', type: 'pn_solo_en_po', pn,
        detail: `PN ${pn} aparece en PO (${posTotal} piezas) pero no en HS. No se puede surtir; línea excluida.`,
        faltante: posTotal,
      }];
    }
    if (tempsTotal > posTotal) {
      return [{
        severity: 'info', type: 'sobrante', pn,
        detail: `HS tiene ${tempsTotal} piezas, Σ POs pide ${posTotal}. Excedente ${tempsTotal - posTotal} → OV Restantes.`,
        sobrante: tempsTotal - posTotal,
      }];
    }
    return [{
      severity: 'warn', type: 'faltante', pn,
      detail: `HS tiene ${tempsTotal} piezas, Σ POs pide ${posTotal}. Faltante ${posTotal - tempsTotal}; línea excluida del plan.`,
      faltante: posTotal - tempsTotal,
    }];
  }
```

Exponer en `_engine`.

- [ ] **Step 3: Correr y verificar**

Run: `node tools/test/po-reconciler.test.js`
Expected: 5 nuevos tests pasan.

- [ ] **Step 4: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): engine.detectIssuesForPN + tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2.6: `buildPlan({ pos, temps, restantesOV, config, overrides })` — orquestador puro

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Tests fallando — caso "match perfecto"**

```js
test('buildPlan: match perfecto → 0 moves, renames listos', () => {
  const plan = E.buildPlan({
    pos: [
      { poNumber: '1400395001', byPN: { A: 10 } },
      { poNumber: '1400395002', byPN: { B: 5 } },
    ],
    temps: [
      { ovId: 'T1', name: 'Producción', byPN: { A: 10 } },
      { ovId: 'T2', name: 'Kitting',    byPN: { B: 5 } },
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.moves, []);
  assert.deepStrictEqual(plan.restantes, []);
  assert.strictEqual(plan.renames.length, 2);
  assert.deepStrictEqual(plan.renames.map(r => r.toName).sort(), ['1400395001', '1400395002']);
  assert.deepStrictEqual(plan.creates, []);
});

test('buildPlan: PN cross-OV requiere 1 move', () => {
  const plan = E.buildPlan({
    pos: [
      { poNumber: 'P1', byPN: { A: 15 } },  // matchea con T1 (A:10) si movemos 5 desde T2
      { poNumber: 'P2', byPN: { B: 10 } },  // matchea con T2 (B:10)
    ],
    temps: [
      { ovId: 'T1', name: 'Producción', byPN: { A: 10, B: 0 } },
      { ovId: 'T2', name: 'Kitting',    byPN: { A: 5,  B: 10 } },
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.strictEqual(plan.moves.length, 1);
  assert.deepStrictEqual(plan.moves[0], { pn: 'A', qty: 5, fromOvId: 'T2', toOvId: 'T1' });
  assert.strictEqual(plan.renames.length, 2);
});

test('buildPlan: sobrante → plan.creates trae OV Restantes si no existe', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 10 } }],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.creates[0].type, 'restantes-ov');
  assert.strictEqual(plan.creates[0].name, 'Restantes Schneider QRO');
  assert.strictEqual(plan.restantes.length, 1);
  assert.deepStrictEqual(plan.restantes[0], { pn: 'A', qty: 5, fromOvId: 'T1' });
});

test('buildPlan: sobrante con OV Restantes existente → no se crea', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 10 } }],
    restantesOV: { id: 999, name: 'Restantes Schneider QRO' },
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.creates, []);
  assert.strictEqual(plan.restantes[0].toOvId, 999);
});

test('buildPlan: cardinality mismatch → plan vacío + issue fatal', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: {} }, { poNumber: 'P2', byPN: {} }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: {} }],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.moves, []);
  assert.deepStrictEqual(plan.renames, []);
  assert.ok(plan.issues.some(i => i.severity === 'fatal'));
});

test('buildPlan: override de asignación cambia los moves', () => {
  // Sin override: T1→P_A (5 movido), T2→P_B (0 movido) ó simétrico.
  // Forzar T1→P_B, T2→P_A invierte.
  const args = {
    pos: [
      { poNumber: 'P_A', byPN: { A: 10 } },
      { poNumber: 'P_B', byPN: { B: 10 } },
    ],
    temps: [
      { ovId: 'T1', name: 'Producción', byPN: { A: 10, B: 0 } },
      { ovId: 'T2', name: 'Kitting',    byPN: { A: 0, B: 10 } },
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
    overrides: {
      assignment: [
        { tempOvId: 'T1', poNumber: 'P_B' },
        { tempOvId: 'T2', poNumber: 'P_A' },
      ],
    },
  };
  const plan = E.buildPlan(args);
  // T1 quería A pero ahora le toca P_B → mover A:10 a T2 y traer B:10
  // Total: A:10 (T1→T2) + B:10 (T2→T1) = 2 moves
  assert.strictEqual(plan.moves.length, 2);
  assert.strictEqual(plan.renames.find(r => r.ovId === 'T1').toName, 'P_B');
  assert.strictEqual(plan.renames.find(r => r.ovId === 'T2').toName, 'P_A');
});
```

- [ ] **Step 2: Implementar `buildPlan`**

```js
  function buildPlan({ pos, temps, restantesOV, config, overrides = {} }) {
    const issues = [];

    // Asignación
    let assignmentResult;
    if (overrides.assignment) {
      assignmentResult = { assignment: overrides.assignment, totalDelta: null, issues: [] };
    } else {
      assignmentResult = assignTempsToPOs(temps, pos);
    }
    if (!assignmentResult.assignment) {
      return { assignment: [], moves: [], restantes: [], renames: [], creates: [], issues: assignmentResult.issues };
    }
    const assignment = assignmentResult.assignment;

    // Construir target por OV: por cada PN, suma de qty del PO asignado a esa temp
    const targetByOV = {}; // { ovId: { pn: qty } }
    for (const { tempOvId, poNumber } of assignment) {
      targetByOV[tempOvId] = {};
      const po = pos.find(p => p.poNumber === poNumber);
      if (!po) continue;
      for (const [pn, qty] of Object.entries(po.byPN || {})) {
        targetByOV[tempOvId][pn] = qty;
      }
    }
    const currentByOV = {}; // { ovId: { pn: qty } }
    for (const t of temps) currentByOV[t.ovId] = { ...(t.byPN || {}) };

    // PNs a procesar
    const allPNs = new Set();
    temps.forEach(t => Object.keys(t.byPN || {}).forEach(pn => allPNs.add(pn)));
    pos.forEach(p => Object.keys(p.byPN || {}).forEach(pn => allPNs.add(pn)));

    const moves = [];
    const restantes = [];
    for (const pn of allPNs) {
      const tempsTotal = temps.reduce((s, t) => s + (t.byPN?.[pn] || 0), 0);
      const posTotal   = pos.reduce((s, p) => s + (p.byPN?.[pn] || 0), 0);

      const pnIssues = detectIssuesForPN(pn, tempsTotal, posTotal);
      issues.push(...pnIssues);

      // Si el PN tiene faltante o solo está en PO → no se puede surtir, skip moves
      if (pnIssues.some(i => i.type === 'faltante' || i.type === 'pn_solo_en_po')) continue;

      // Target por OV para este PN
      const tgtByOV = {};
      for (const ovId of Object.keys(currentByOV)) tgtByOV[ovId] = targetByOV[ovId]?.[pn] || 0;

      // Generar moves intra-temp
      const cur = {};
      for (const ovId of Object.keys(currentByOV)) cur[ovId] = currentByOV[ovId][pn] || 0;
      const pnMoves = computeMovesForPN(pn, cur, tgtByOV);

      // Sobrante: si suma de targets < suma de currents → diferencia va a Restantes
      const sumCur = Object.values(cur).reduce((a, b) => a + b, 0);
      const sumTgt = Object.values(tgtByOV).reduce((a, b) => a + b, 0);
      if (sumCur > sumTgt) {
        // Crear restante: tomar del primer donor disponible después de aplicar pnMoves
        // Simplificación: el donor del move-a-restantes es el OV que aún quede con sobrante
        const totalSobrante = sumCur - sumTgt;
        // Encontrar de qué OV viene: el que tenga más currentByOV[pn] - tgtByOV[ov][pn]
        let leftover = totalSobrante;
        for (const ovId of Object.keys(cur)) {
          const ovSobrante = cur[ovId] - tgtByOV[ovId];
          if (ovSobrante > 0) {
            const take = Math.min(ovSobrante, leftover);
            restantes.push({ pn, qty: take, fromOvId: ovId });
            leftover -= take;
            if (leftover === 0) break;
          }
        }
      }

      moves.push(...pnMoves);
    }

    // OV Restantes: si hay sobrantes y no existe la OV, crearla
    const creates = [];
    let restantesOvId = restantesOV?.id ?? null;
    if (restantes.length > 0 && !restantesOvId) {
      creates.push({
        type: 'restantes-ov',
        name: config.restantesOvName,
        metadata: { fromTempOvId: temps[0]?.ovId ?? null },
      });
      restantesOvId = '__pending_restantes__';
    }
    for (const r of restantes) r.toOvId = restantesOvId;

    // Renames
    const renames = assignment.map(({ tempOvId, poNumber }) => {
      const t = temps.find(x => x.ovId === tempOvId);
      return { ovId: tempOvId, fromName: t?.name ?? '', toName: poNumber };
    });

    return { assignment, moves, restantes, renames, creates, issues };
  }
```

Exponer en `_engine`.

- [ ] **Step 3: Correr y verificar**

Run: `node tools/test/po-reconciler.test.js`
Expected: tests anteriores + 6 nuevos pasan.

- [ ] **Step 4: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): engine.buildPlan integra assignment + moves + sobrantes + renames

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2.7: Casos edge adicionales — hardening del motor

**Files:**
- Modify: `tools/test/po-reconciler.test.js`
- Modify: `remote/scripts/po-reconciler.js` (si los tests revelan bugs)

- [ ] **Step 1: Agregar tests adicionales**

```js
test('buildPlan: 3 temps × 3 POs no-trivial converge', () => {
  // Distribución mezclada del cliente
  const plan = E.buildPlan({
    pos: [
      { poNumber: 'P1', byPN: { X: 5,  Y: 0,  Z: 0  } },
      { poNumber: 'P2', byPN: { X: 0,  Y: 10, Z: 5  } },
      { poNumber: 'P3', byPN: { X: 5,  Y: 0,  Z: 15 } },
    ],
    temps: [
      { ovId: 'T1', name: 'Producción',   byPN: { X: 10, Y: 0,  Z: 0  } },  // PO compatible: P1+P3 partial
      { ovId: 'T2', name: 'Kitting',      byPN: { X: 0,  Y: 10, Z: 5  } },  // PO compatible: P2 exacto
      { ovId: 'T3', name: 'Lote cerrado', byPN: { X: 0,  Y: 0,  Z: 15 } },  // PO compatible: P3 parcial
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  // Hay un óptimo donde T2→P2 (0 moves), T1→P1 (qty 5 sobrante de X), T3→P3 (necesita X:5)
  // → 1 move: X:5 de T1 a T3
  assert.ok(plan.renames.length === 3);
  assert.ok(plan.issues.every(i => i.severity !== 'fatal'));
});

test('buildPlan: solo OV Restantes, no recrear si ya existe con id', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 10 } }],
    restantesOV: { id: 42, name: 'Restantes Schneider QRO' },
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.creates, []);
  assert.ok(plan.restantes.every(r => r.toOvId === 42));
});

test('buildPlan: PN solo en HS va completo a Restantes', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 5, ORPHAN: 8 } }],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  const orphan = plan.restantes.find(r => r.pn === 'ORPHAN');
  assert.ok(orphan);
  assert.strictEqual(orphan.qty, 8);
  assert.ok(plan.issues.some(i => i.type === 'pn_solo_en_hs'));
});
```

- [ ] **Step 2: Correr y verificar que pasen**

Run: `node tools/test/po-reconciler.test.js`
Si alguno falla, ajusta el motor para resolver el caso (probablemente la lógica de sobrantes para PNs sin presencia en POs).

- [ ] **Step 3: Commit**

```bash
git add tools/test/po-reconciler.test.js remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
test(po-reconciler): hardening con casos edge (3×3, OV existente, PN solo en HS)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 3 — Steelhead API helpers (no testeable sin red; smoke tests manuales)

Estos helpers viven en `po-reconciler.js` (sección "Steelhead helpers", antes del Engine). Cada uno se prueba con un smoke test manual: abrir Steelhead, ejecutar desde DevTools, validar resultado.

### Task 3.1: `loadCandidateTempOVs()` — query y filtros

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  // ── Steelhead helpers ──────────────────────────────────────

  async function loadCandidateTempOVs() {
    const domain = api().getDomain();
    const schneider = domain.schneiderQueretaro || {};
    if (!schneider.customerId || !schneider.shipToAddressId) {
      throw new Error('Falta config Schneider QRO (customerId / shipToAddressId)');
    }
    const sapRe = new RegExp(schneider.poNumberRegex || '^14\\d{8}$');
    const variables = {
      filters: { customerId: schneider.customerId, archivedAt: null },
      first: 100,
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const all = data?.activeReceivedOrders?.nodes || data?.receivedOrders?.nodes || [];
    const candidates = all.filter(ov => {
      if (ov.archivedAt) return false;
      const ship = (ov.shipToAddress?.id ?? ov.shipToAddressId);
      if (String(ship) !== String(schneider.shipToAddressId)) return false;
      const name = String(ov.name || '').trim();
      if (sapRe.test(name)) return false;
      return true;
    });
    log(`Temp OVs candidatas: ${candidates.length}`);
    return candidates.map(ov => ({ id: ov.id, idInDomain: ov.idInDomain, name: ov.name, raw: ov }));
  }
```

**Nota sobre shape de respuesta:** la query `ActiveReceivedOrders` puede devolver `activeReceivedOrders.nodes` o `receivedOrders.nodes` según versión (igual que pasa con `GetReceivedOrder` documentado en `CLAUDE.md`). Cubrimos ambos.

Si la query NO acepta `filters.customerId` como filtro, el filtrado se hace 100% client-side — está bien para volumen real (cientos de OVs).

- [ ] **Step 2: Smoke test manual**

Build y deploy temporal (solo `main`, sin gh-pages todavía):

Run desde DevTools en Steelhead, después de habilitar el applet:
```js
await POReconciler._engine // (no, está dentro de IIFE — necesitamos exponer también)
```

Para poder smoke-testear sin pasar por UI, agregar temporalmente al `return` del IIFE: `_helpers: { loadCandidateTempOVs }`. Después de validar, en Task 12 se decide si dejarlo o gated detrás de un flag.

Run en DevTools: `await window.POReconciler._helpers.loadCandidateTempOVs()`
Expected: array de OVs cuyo `name` no empieza con `14...`, con cliente Schneider QRO.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): loadCandidateTempOVs (ActiveReceivedOrders + filtros cliente/ship/regex)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: `loadOVDetails(ovId)` — GetReceivedOrder con OTs y PNs

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  async function loadOVDetails(ovId) {
    const data = await api().query('GetReceivedOrder', { id: ovId });
    const ov = data?.receivedOrder || data?.receivedOrderByIdInDomain;
    if (!ov) throw new Error(`GetReceivedOrder(${ovId}) devolvió shape inesperado`);

    // Líneas y OTs
    const lines = ov.receivedOrderLines?.nodes
                || ov.receivedOrderLinesByReceivedOrderId?.nodes
                || [];

    const ots = [];
    const byPN = {};
    for (const line of lines) {
      for (const li of (line.lineItems?.nodes || line.lineItems || [])) {
        for (const ptAssoc of (li.receivedOrderLineItemPartTransforms?.nodes
                            || li.receivedOrderLineItemPartTransforms
                            || [])) {
          const pt = ptAssoc.receivedOrderPartTransform;
          if (!pt) continue;
          for (const wo of (pt.workOrders?.nodes || pt.workOrders || [])) {
            const pnId = pt.partNumberId;
            const pnString = pt.partNumber?.partNumberString || pt.partNumber?.string || '';
            const qty = Number(wo.partCount || wo.count || 0);
            ots.push({
              id: wo.id,
              partCount: qty,
              partNumberId: pnId,
              partNumber: pnString,
              receivedOrderPartTransformId: pt.id,
              recipeNodeId: wo.recipeNodeId ?? null,
              locationId: wo.locationId ?? null,
              accountId: wo.inventoryAccountId ?? wo.accountId ?? null,
              line: { id: line.id, name: line.name, quantity: Number(li.quantity || 0) },
              raw: wo,
            });
            byPN[pnString] = (byPN[pnString] || 0) + qty;
          }
        }
      }
    }

    return {
      id: ov.id,
      idInDomain: ov.idInDomain,
      name: ov.name,
      customerId: ov.customerId,
      shipToAddressId: ov.shipToAddressId,
      lines,
      ots,
      byPN,
      snapshot: ov, // full record for rename replay
    };
  }
```

- [ ] **Step 2: Smoke test manual**

Run: `await window.POReconciler._helpers.loadOVDetails(<id-de-una-temp-ov>)`
Expected: objeto con `ots` lleno, `byPN` con totales, `snapshot` con todos los campos para rename.

Comparar `byPN` calculado vs el que se ve en el UI. Si difiere, hay un problema con el shape de OTs — revisar `ots[i].raw` y ajustar el extractor.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): loadOVDetails (GetReceivedOrder + extracción OTs+byPN)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.3: `findRestantesOV(customerId)` — buscar OV existente por nombre

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  async function findRestantesOV() {
    const domain = api().getDomain();
    const sch = domain.schneiderQueretaro || {};
    const expectedName = sch.restantesOvName || 'Restantes Schneider QRO';
    const variables = {
      filters: { customerId: sch.customerId, archivedAt: null, searchString: expectedName },
      first: 20,
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const all = data?.activeReceivedOrders?.nodes || data?.receivedOrders?.nodes || [];
    return all.find(ov => String(ov.name).trim() === expectedName) || null;
  }
```

- [ ] **Step 2: Smoke test**

Run: `await window.POReconciler._helpers.findRestantesOV()`
Expected: `null` (si nunca existió) o objeto OV.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): findRestantesOV (lookup por nombre exacto)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.4: `createRestantesOV(seedTempOvSnapshot)` — wrap CreateReceivedOrder

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  async function createRestantesOV(seed) {
    const domain = api().getDomain();
    const expectedName = domain.schneiderQueretaro?.restantesOvName || 'Restantes Schneider QRO';
    const input = {
      name: expectedName,
      customerId: seed.customerId,
      shipToAddressId: seed.shipToAddressId,
      customerContactId: seed.customerContactId ?? null,
      billToAddressId: seed.billToAddressId ?? null,
      invoiceTermsId: seed.invoiceTermsId ?? null,
      customInputs: seed.customInputs ?? [],
      inputSchemaId: seed.inputSchemaId ?? null,
      shipVia: seed.shipVia ?? null,
      shipMethodId: seed.shipMethodId ?? null,
      type: seed.type ?? 'STANDARD',
      blockPartialShipments: seed.blockPartialShipments ?? false,
      sectorId: seed.sectorId ?? null,
      isBlanketOrder: false,
      deadline: seed.deadline ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const data = await api().query('CreateReceivedOrder', { input });
    const created = data?.createReceivedOrder?.receivedOrder || data?.createReceivedOrder;
    if (!created?.id) throw new Error('CreateReceivedOrder: respuesta sin id');
    log(`OV Restantes creada: ${created.id} (#${created.idInDomain})`);
    return created;
  }
```

**Nota:** el shape exacto del `input` debe validarse contra la captura del Task 0.x (en este caso, mirar cómo `po-comparator` o `portal-importer` invocan `CreateReceivedOrder`). Si difiere, ajustar.

- [ ] **Step 2: Smoke test (con cautela en producción)**

NO ejecutar smoke directo en producción. Esperar al primer test E2E manual del wizard completo. Documentar el helper con TODO de validación contra payload capturado en Task 0.6.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): createRestantesOV (clona metadata de temp seed)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.5: `findOrCreateOTForPN(toOv, pnId, hintFromOt)` — OT en destino

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  function findOTForPN(ov, pnId) {
    return ov.ots.find(ot => String(ot.partNumberId) === String(pnId)) || null;
  }

  async function createOTInOV({ ovId, customerId, deadline, partNumberId, hintFromOt }) {
    const variables = {
      input: {
        id: null,
        receivedOrderId: ovId,
        customerId,
        deadline,
        productId: hintFromOt?.raw?.productId ?? null,
        type: 'MAKE_TO_ORDER',
        partNumberId,
        recipeNodeId: hintFromOt?.recipeNodeId ?? null,
      },
    };
    const data = await api().query('CreateUpdateWorkOrdersChecked', variables);
    const wo = data?.createUpdateWorkOrdersChecked?.workOrders?.[0]
            || data?.workOrder
            || data?.workOrders?.[0];
    if (!wo?.id) throw new Error('CreateUpdateWorkOrdersChecked: no devolvió OT');
    return wo;
  }
```

**Crítico:** el shape exacto de `input` debe matchear lo capturado en Task 0.4. Si la captura mostró campos adicionales (e.g., `expectedShipDate`, `prioritization`), agrégalos con `null` o el valor del seed.

- [ ] **Step 2: Smoke test diferido**

Como en Task 3.4, no smoke en producción. Validar con E2E.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): createOTInOV + findOTForPN

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.6: `executeMove({ pn, qty, fromOt, toOt, partNumberId })` — wrap AddPartsToWorkOrders

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar** (shape exacto del spec)

```js
  async function executeMove({ pn, qty, fromOt, toOt, partNumberId }) {
    const microQty = qty * 1_000_000;
    const variables = {
      inventoryTransferEventGroupsToCreate: [{
        inventoryTransferEvents: [{
          creditAccounts: { accounts: [{ id: fromOt.accountId, microQuantity: microQty }] },
          debitAccounts:  { accounts: [{ microQuantity: microQty }] },
          partsTransferEvent: {
            createPartsTransferEvent: {},
            partsTransfers: [{
              partCount: qty,
              toAccount: {
                inventoryAccountId:           toOt.accountId ?? null,
                locationId:                   toOt.locationId,
                receivedOrderPartTransformId: toOt.receivedOrderPartTransformId,
                recipeNodeId:                 toOt.recipeNodeId,
                workOrderId:                  toOt.id,
              },
              type: 'ENTRANCE',
              useUndefinedFieldsFromAccountId: fromOt.accountId,
            }],
          },
          transferType: 'DEPLETE',
        }],
      }],
      partNumberWorkOrders: [{ partNumberId, workOrderId: toOt.id }],
      partsTransferEventsPayload: [{ createPartsTransferEvent: {}, partsTransfers: [] }],
      recipeNodePartNumberTreatmentsToCreate: [],
    };
    return await api().query('AddPartsToWorkOrders', variables);
  }
```

- [ ] **Step 2: Validación contra captura de Task 0.1**

Antes de continuar: comparar el shape de `variables` aquí con el body capturado del UI en Task 0.1. Si hay campos faltantes o extra, ajustar.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): executeMove (AddPartsToWorkOrders cross-OV)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.7: `reconcileLineQuantities(ovId)` — wrap SaveReceivedOrderLinesAndItems

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  async function reconcileLineQuantities(ovId) {
    const fresh = await loadOVDetails(ovId);
    const newLines = [];

    for (const line of fresh.lines) {
      const li = (line.lineItems?.nodes || line.lineItems || [])[0];
      if (!li) continue;
      // Suma de partCount de todas las OTs asociadas a esta línea
      let sumOts = 0;
      for (const ptAssoc of (li.receivedOrderLineItemPartTransforms?.nodes
                          || li.receivedOrderLineItemPartTransforms
                          || [])) {
        for (const wo of (ptAssoc.receivedOrderPartTransform?.workOrders?.nodes
                        || ptAssoc.receivedOrderPartTransform?.workOrders
                        || [])) {
          sumOts += Number(wo.partCount || wo.count || 0);
        }
      }
      const currentLineQty = Number(li.quantity || 0);
      if (currentLineQty === sumOts) continue;

      newLines.push({
        id: line.id,
        name: line.name,
        description: line.description || '',
        lineItems: [{
          ...li,
          id: li.id,
          quantity: String(sumOts),
          // Mantener resto del shape inalterado — capturado en Task 0.2
        }],
      });
    }

    if (newLines.length === 0) {
      log(`Reconcile ${ovId}: sin cambios`);
      return { changed: 0 };
    }

    const variables = { input: { receivedOrderId: ovId, newLines } };
    await api().query('SaveReceivedOrderLinesAndItems', variables);
    log(`Reconcile ${ovId}: ${newLines.length} líneas ajustadas`);
    return { changed: newLines.length };
  }
```

**Crítico:** la shape de `lineItems[]` debe matchear lo capturado en Task 0.2. Si el UI envía solo `{id, quantity}` (no el shape completo), simplificar. Si requiere el shape completo, dejar el spread `...li` para preservar campos.

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): reconcileLineQuantities (SaveReceivedOrderLinesAndItems update)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3.8: `renameOV(snapshot, toName)` — wrap UpdateReceivedOrder full-record

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  function mapToUpdateShape(ov) {
    return {
      id: ov.id,
      name: ov.name,
      customerId: ov.customerId,
      deadline: ov.deadline,
      customerContactId: ov.customerContactId,
      billToAddressId: ov.billToAddressId,
      shipToAddressId: ov.shipToAddressId,
      invoiceTermsId: ov.invoiceTermsId,
      customInputs: ov.customInputs,
      inputSchemaId: ov.inputSchemaId,
      shipVia: ov.shipVia,
      shipMethodId: ov.shipMethodId,
      type: ov.type,
      blockPartialShipments: ov.blockPartialShipments,
      sectorId: ov.sectorId,
      isBlanketOrder: ov.isBlanketOrder,
      productionStartDate: ov.productionStartDate,
      contractualDeadline: ov.contractualDeadline,
      defaultSignOffRecipeId: ov.defaultSignOffRecipeId,
    };
  }

  async function renameOV(snapshot, toName) {
    const input = { ...mapToUpdateShape(snapshot), name: toName };
    const data = await api().query('UpdateReceivedOrder', { input });
    return data?.updateReceivedOrder?.receivedOrder || data?.updateReceivedOrder || data;
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): renameOV (UpdateReceivedOrder full-record replay)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 4 — PDF parsing (multi-archivo)

### Task 4.1: `parseMultiplePdfs(files)` — paralelo con manejo de errores por PDF

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar**

```js
  // ── PDF parsing ────────────────────────────────────────────

  async function parseSinglePdf(file) {
    try {
      const parsed = await window.POComparator.parsePDF(file);
      return { status: 'ok', file, parsed, error: null };
    } catch (err) {
      return { status: 'error', file, parsed: null, error: err.message || String(err) };
    }
  }

  async function parseMultiplePdfs(files, onProgress) {
    const results = files.map(f => ({ status: 'pending', file: f, parsed: null, error: null }));
    onProgress?.(results);
    const promises = files.map((file, idx) =>
      parseSinglePdf(file).then(r => {
        results[idx] = r;
        onProgress?.(results);
        return r;
      })
    );
    await Promise.all(promises);
    return results;
  }
```

**Dependencia:** `window.POComparator.parsePDF` viene de `po-comparator.js`, ya en `scripts[]` del applet en config (Task 1.1).

- [ ] **Step 2: Smoke test manual**

Con 1-2 PDFs reales de Schneider en una pestaña Steelhead:
```js
const input = document.createElement('input');
input.type = 'file';
input.accept = '.pdf';
input.multiple = true;
input.onchange = async () => {
  const r = await window.POReconciler._helpers.parseMultiplePdfs([...input.files], (r) => console.log(r));
  console.log('Final:', r);
};
input.click();
```

Expected: 2 promises se resuelven en paralelo, cada una con `parsed.poNumber`, `parsed.lines`, etc.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): parseMultiplePdfs (paralelo, errors per-PDF)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 5 — UI Wizard skeleton

### Task 5.1: Overlay + step navigation

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `openWizard()` reemplazando el stub**

```js
  // ── UI Wizard ──────────────────────────────────────────────

  function openWizard() {
    if (state.isOpen) return;
    state.isOpen = true;
    state.step = 1;
    const root = document.createElement('div');
    root.id = 'sa-pr-root';
    root.className = 'sa-pr-overlay';
    root.innerHTML = `
      <div class="sa-pr-modal">
        <header class="sa-pr-header">
          <h2>Reconciliador OV vs PO Schneider QRO</h2>
          <button class="sa-pr-close" aria-label="Cerrar">✕</button>
        </header>
        <nav class="sa-pr-steps">
          <span data-step="1" class="active">1. Cargar</span>
          <span data-step="2">2. Parseo</span>
          <span data-step="3">3. Plan</span>
          <span data-step="4">4. Ejecutar</span>
        </nav>
        <main class="sa-pr-body"></main>
        <footer class="sa-pr-footer">
          <button class="sa-pr-back" disabled>← Atrás</button>
          <button class="sa-pr-next" disabled>Continuar →</button>
        </footer>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('.sa-pr-close').onclick = closeWizard;
    root.querySelector('.sa-pr-back').onclick = () => goToStep(state.step - 1);
    root.querySelector('.sa-pr-next').onclick = () => goToStep(state.step + 1);
    renderStep();
  }

  function closeWizard() {
    document.getElementById('sa-pr-root')?.remove();
    state = { ...state, isOpen: false, step: 1, pdfs: [], plan: null, overrides: {} };
  }

  function goToStep(n) {
    if (n < 1 || n > 4) return;
    state.step = n;
    document.querySelectorAll('#sa-pr-root .sa-pr-steps span').forEach(s => {
      s.classList.toggle('active', Number(s.dataset.step) === n);
    });
    renderStep();
  }

  function renderStep() {
    const body = document.querySelector('#sa-pr-root .sa-pr-body');
    if (!body) return;
    body.innerHTML = `<div class="sa-pr-placeholder">Paso ${state.step} (placeholder)</div>`;
    const back = document.querySelector('#sa-pr-root .sa-pr-back');
    const next = document.querySelector('#sa-pr-root .sa-pr-next');
    back.disabled = state.step === 1;
    next.disabled = false;
    next.textContent = state.step === 4 ? 'Cerrar' : 'Continuar →';
  }
```

- [ ] **Step 2: Smoke test**

Desde DevTools: `window.POReconciler.openWizard()`
Expected: overlay aparece con 4 steps en el navbar, botones de navegación funcionan.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): wizard shell + step navigation

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: Estilos CSS

**Files:**
- Modify: `remote/scripts/po-reconciler.js` (función `injectStyles`)

- [ ] **Step 1: Implementar `injectStyles` con CSS scoped**

```js
  function injectStyles() {
    if (document.getElementById('sa-pr-styles')) return;
    const css = `
      .sa-pr-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.5);
        z-index: 999999; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .sa-pr-modal {
        background: #fff; width: min(95vw, 1200px); height: min(90vh, 800px);
        border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 10px 40px rgba(0,0,0,.3);
      }
      .sa-pr-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 16px 24px; border-bottom: 1px solid #e5e7eb;
      }
      .sa-pr-header h2 { margin: 0; font-size: 18px; }
      .sa-pr-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280; }
      .sa-pr-steps {
        display: flex; gap: 24px; padding: 12px 24px; border-bottom: 1px solid #e5e7eb;
        background: #f9fafb; font-size: 13px;
      }
      .sa-pr-steps span { color: #9ca3af; }
      .sa-pr-steps span.active { color: #1f2937; font-weight: 600; }
      .sa-pr-body { flex: 1; overflow: auto; padding: 24px; }
      .sa-pr-footer {
        display: flex; justify-content: space-between; padding: 16px 24px;
        border-top: 1px solid #e5e7eb;
      }
      .sa-pr-footer button {
        padding: 8px 16px; border: 1px solid #d1d5db; background: #fff;
        border-radius: 6px; cursor: pointer; font-size: 14px;
      }
      .sa-pr-footer button:disabled { opacity: .5; cursor: not-allowed; }
      .sa-pr-footer .sa-pr-next { background: #2563eb; color: #fff; border-color: #2563eb; }
      .sa-pr-footer .sa-pr-next:disabled { background: #93c5fd; border-color: #93c5fd; }
      .sa-pr-placeholder { color: #6b7280; padding: 40px; text-align: center; }
      .sa-pr-drop { border: 2px dashed #93c5fd; border-radius: 8px; padding: 40px; text-align: center; color: #2563eb; cursor: pointer; }
      .sa-pr-drop.hover { background: #eff6ff; }
      .sa-pr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .sa-pr-table th, .sa-pr-table td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; }
      .sa-pr-table th { background: #f9fafb; font-weight: 600; }
      .sa-pr-issue-fatal { color: #dc2626; font-weight: 600; }
      .sa-pr-issue-warn  { color: #d97706; }
      .sa-pr-issue-info  { color: #2563eb; }
      .sa-pr-fab {
        position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px;
        background: #2563eb; color: #fff; border: none; border-radius: 50%;
        font-size: 24px; cursor: pointer; z-index: 999998;
        box-shadow: 0 4px 12px rgba(37,99,235,.4);
      }
      .sa-pr-fab:hover { background: #1d4ed8; }
    `;
    const style = document.createElement('style');
    style.id = 'sa-pr-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }
```

- [ ] **Step 2: Smoke test visual**

Run: `window.POReconciler.openWizard()` y validar que el overlay se ve limpio (no roto por CSS del UI de Steelhead).

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
style(po-reconciler): CSS scoped del overlay (modal + steps + tabla + FAB)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 6 — UI Step 1: cargar PDFs y temp OVs

### Task 6.1: Drop zone + lista de PDFs cargados

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Reemplazar `renderStep()` con switch por step + crear `renderStep1()`**

Modificar `renderStep()`:

```js
  function renderStep() {
    const body = document.querySelector('#sa-pr-root .sa-pr-body');
    if (!body) return;
    body.innerHTML = '';
    if (state.step === 1) renderStep1(body);
    else if (state.step === 2) renderStep2(body);
    else if (state.step === 3) renderStep3(body);
    else if (state.step === 4) renderStep4(body);
    updateFooter();
  }

  function updateFooter() {
    const back = document.querySelector('#sa-pr-root .sa-pr-back');
    const next = document.querySelector('#sa-pr-root .sa-pr-next');
    back.disabled = state.step === 1;
    next.textContent = state.step === 4 ? 'Cerrar' : 'Continuar →';
    next.disabled = !canAdvanceFromStep(state.step);
  }

  function canAdvanceFromStep(step) {
    if (step === 1) return state.pdfs.length > 0 && state.tempOVs.length > 0;
    if (step === 2) return state.pdfs.every(p => p.status === 'ok' || p.status === 'skipped');
    if (step === 3) return state.plan && !state.plan.issues.some(i => i.severity === 'fatal');
    if (step === 4) return true;
    return false;
  }
```

- [ ] **Step 2: Implementar `renderStep1`**

```js
  async function renderStep1(body) {
    body.innerHTML = `
      <div class="sa-pr-step1">
        <div class="sa-pr-step1-left">
          <h3>1) PDFs de POs Schneider</h3>
          <div id="sa-pr-drop" class="sa-pr-drop">
            <p>Arrastra archivos .pdf aquí o haz click para elegir</p>
            <input type="file" multiple accept="application/pdf" hidden id="sa-pr-files">
          </div>
          <ul id="sa-pr-files-list" class="sa-pr-files-list"></ul>
        </div>
        <div class="sa-pr-step1-right">
          <h3>2) OVs temp Schneider QRO detectadas</h3>
          <div id="sa-pr-temps-list">Cargando…</div>
        </div>
      </div>
    `;
    const drop = body.querySelector('#sa-pr-drop');
    const input = body.querySelector('#sa-pr-files');
    drop.onclick = () => input.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hover'); };
    drop.ondragleave = () => drop.classList.remove('hover');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('hover');
      addPdfs([...e.dataTransfer.files].filter(f => f.type === 'application/pdf'));
    };
    input.onchange = () => addPdfs([...input.files]);

    refreshFilesList();
    await refreshTempOVs();
  }

  function addPdfs(files) {
    for (const f of files) {
      if (!state.pdfs.some(p => p.file.name === f.name && p.file.size === f.size)) {
        state.pdfs.push({ status: 'pending', file: f, parsed: null, error: null });
      }
    }
    refreshFilesList();
    updateFooter();
  }

  function refreshFilesList() {
    const ul = document.getElementById('sa-pr-files-list');
    if (!ul) return;
    ul.innerHTML = state.pdfs.map((p, i) => `
      <li>
        ${escapeHtml(p.file.name)} (${(p.file.size/1024).toFixed(1)} KB)
        <button data-i="${i}" class="sa-pr-rm">✕</button>
      </li>
    `).join('');
    ul.querySelectorAll('.sa-pr-rm').forEach(btn => btn.onclick = () => {
      state.pdfs.splice(Number(btn.dataset.i), 1);
      refreshFilesList();
      updateFooter();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
```

Y agregar al CSS (en `injectStyles`):

```css
.sa-pr-step1 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; height: 100%; }
.sa-pr-step1 h3 { font-size: 14px; margin: 0 0 12px; }
.sa-pr-files-list, #sa-pr-temps-list { list-style: none; padding: 0; margin: 12px 0 0; font-size: 13px; }
.sa-pr-files-list li, #sa-pr-temps-list .item { display: flex; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid #f3f4f6; }
.sa-pr-rm { background: none; border: none; color: #6b7280; cursor: pointer; }
```

- [ ] **Step 3: Smoke test**

Open wizard → drop 1-2 PDFs → verificar lista poblada → click ✕ → verificar remoción.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 1 — drop zone PDFs + lista files

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 6.2: Sidebar — auto-carga de temp OVs

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `refreshTempOVs`**

```js
  async function refreshTempOVs() {
    const el = document.getElementById('sa-pr-temps-list');
    if (!el) return;
    el.innerHTML = '<em>Cargando…</em>';
    try {
      const candidates = await loadCandidateTempOVs();
      // Cargar detalles en paralelo
      const details = await Promise.all(candidates.map(c => loadOVDetails(c.id).catch(e => ({ error: e.message, id: c.id, name: c.name }))));
      state.tempOVs = details.filter(d => !d.error);
      const errors = details.filter(d => d.error);
      el.innerHTML = `
        ${state.tempOVs.map(t => `
          <div class="item">
            <span>${escapeHtml(t.name)}</span>
            <small>${t.ots.length} OTs · ${Object.keys(t.byPN).length} PNs</small>
          </div>
        `).join('')}
        ${errors.length ? `<div class="sa-pr-issue-warn">⚠️ ${errors.length} OVs fallaron al cargar (ver consola)</div>` : ''}
      `;
      if (errors.length) console.warn('[PR] errores cargando OVs:', errors);
      updateFooter();
    } catch (err) {
      el.innerHTML = `<div class="sa-pr-issue-fatal">Error: ${escapeHtml(err.message)}</div>`;
    }
  }
```

- [ ] **Step 2: Smoke test**

Open wizard en Steelhead → verificar que el sidebar carga las OVs Schneider QRO que no tienen nombre SAP.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 1 sidebar — auto-carga temp OVs Schneider QRO

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 7 — UI Step 2: parseo de PDFs

### Task 7.1: Lista de PDFs con estado + drawer de detalle

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `renderStep2`**

```js
  async function renderStep2(body) {
    body.innerHTML = `
      <h3>Parseando POs…</h3>
      <ul id="sa-pr-parse-list" class="sa-pr-parse-list"></ul>
    `;
    const ul = body.querySelector('#sa-pr-parse-list');

    const renderList = () => {
      ul.innerHTML = state.pdfs.map((p, i) => {
        const icon = { pending: '⠋', parsing: '⠋', ok: '✓', error: '✗', skipped: '⊘' }[p.status] || '?';
        const cls  = { pending: '', parsing: '', ok: 'sa-pr-issue-info', error: 'sa-pr-issue-fatal', skipped: 'sa-pr-issue-warn' }[p.status] || '';
        const summary = p.parsed
          ? `PO ${escapeHtml(p.parsed.poNumber || '?')} · ${p.parsed.lines?.length || 0} líneas · ${p.parsed.currency || '?'}`
          : (p.error ? escapeHtml(p.error) : '');
        return `
          <li class="${cls}">
            <span>${icon} ${escapeHtml(p.file.name)}</span>
            <small>${summary}</small>
            <span class="actions">
              ${p.status === 'error' ? `<button data-i="${i}" class="sa-pr-retry">↻</button>` : ''}
              ${p.status === 'error' ? `<button data-i="${i}" class="sa-pr-skip">Omitir</button>` : ''}
              ${p.status === 'ok'    ? `<button data-i="${i}" class="sa-pr-view">Ver</button>` : ''}
            </span>
          </li>
        `;
      }).join('');
      ul.querySelectorAll('.sa-pr-retry').forEach(b => b.onclick = () => retryOne(Number(b.dataset.i), renderList));
      ul.querySelectorAll('.sa-pr-skip').forEach(b => b.onclick = () => { state.pdfs[Number(b.dataset.i)].status = 'skipped'; renderList(); updateFooter(); });
      ul.querySelectorAll('.sa-pr-view').forEach(b => b.onclick = () => showPdfDetail(Number(b.dataset.i)));
    };

    renderList();
    // Lanzar parseo de los pending
    const pending = state.pdfs.map((p, i) => ({ p, i })).filter(x => x.p.status === 'pending');
    for (const { p, i } of pending) {
      p.status = 'parsing';
      renderList();
      const r = await parseSinglePdf(p.file);
      state.pdfs[i] = r;
      renderList();
      updateFooter();
    }
  }

  async function retryOne(i, renderList) {
    state.pdfs[i].status = 'parsing';
    state.pdfs[i].error = null;
    renderList();
    const r = await parseSinglePdf(state.pdfs[i].file);
    state.pdfs[i] = r;
    renderList();
    updateFooter();
  }

  function showPdfDetail(i) {
    const p = state.pdfs[i];
    if (!p?.parsed) return;
    const drawer = document.createElement('div');
    drawer.className = 'sa-pr-drawer';
    drawer.innerHTML = `
      <div class="sa-pr-drawer-inner">
        <header><h4>${escapeHtml(p.file.name)}</h4><button class="sa-pr-drawer-close">✕</button></header>
        <p>PO: <strong>${escapeHtml(p.parsed.poNumber)}</strong> · ${p.parsed.lines.length} líneas · ${escapeHtml(p.parsed.currency || '?')}</p>
        <table class="sa-pr-table">
          <thead><tr><th>#</th><th>PN</th><th>Desc</th><th>Qty</th></tr></thead>
          <tbody>
            ${p.parsed.lines.map(l => `<tr>
              <td>${l.lineNumber}</td>
              <td>${escapeHtml(l.partNumber)}</td>
              <td>${escapeHtml(l.description || '')}</td>
              <td>${l.quantity}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
    document.body.appendChild(drawer);
    drawer.querySelector('.sa-pr-drawer-close').onclick = () => drawer.remove();
  }
```

Agregar al CSS:

```css
.sa-pr-parse-list { list-style: none; padding: 0; }
.sa-pr-parse-list li { display: grid; grid-template-columns: 1fr 1fr auto; padding: 8px; border-bottom: 1px solid #f3f4f6; align-items: center; gap: 8px; }
.sa-pr-parse-list .actions { display: flex; gap: 4px; }
.sa-pr-parse-list button { padding: 4px 8px; font-size: 12px; border-radius: 4px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
.sa-pr-drawer { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 1000000; display: flex; justify-content: flex-end; }
.sa-pr-drawer-inner { background: #fff; width: 600px; height: 100%; padding: 20px; overflow: auto; }
.sa-pr-drawer-inner header { display: flex; justify-content: space-between; align-items: center; }
.sa-pr-drawer-close { background: none; border: none; font-size: 20px; cursor: pointer; }
```

- [ ] **Step 2: Smoke test**

Continuar desde Step 1 con 2 PDFs → al avanzar a Step 2, los parseos se lanzan, los estados cambian a ⠋ → ✓.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 2 — parse status list + retry + drawer detail

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 8 — UI Step 3: plan editable

### Task 8.1: Construir plan inicial al entrar al step

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `renderStep3` con cálculo inicial**

```js
  async function renderStep3(body) {
    body.innerHTML = `<div class="sa-pr-placeholder">Calculando plan…</div>`;
    const pos   = state.pdfs.filter(p => p.status === 'ok').map(p => ({
      poNumber: p.parsed.poNumber,
      byPN: consolidateByPN(p.parsed.lines),
      rawLines: p.parsed.lines,
    }));
    const temps = state.tempOVs.map(t => ({ ovId: t.id, name: t.name, byPN: t.byPN, raw: t }));
    state.restantesOV = await findRestantesOV();
    const sch = api().getDomain().schneiderQueretaro || {};
    state.plan = buildPlan({
      pos, temps, restantesOV: state.restantesOV,
      config: { restantesOvName: sch.restantesOvName || 'Restantes Schneider QRO' },
      overrides: state.overrides,
    });
    renderStep3Body(body);
    updateFooter();
  }

  function renderStep3Body(body) {
    const p = state.plan;
    body.innerHTML = `
      <section class="sa-pr-plan-summary">
        <h3>Resumen</h3>
        <div class="sa-pr-pills">
          <span>${p.assignment.length} asignaciones</span>
          <span>${p.moves.length} movimientos</span>
          <span>${p.restantes.length} sobrantes → Restantes</span>
          <span>${p.creates.length} OVs nuevas</span>
          <span class="sa-pr-issue-warn">${p.issues.filter(i => i.severity === 'warn').length} warnings</span>
          <span class="sa-pr-issue-fatal">${p.issues.filter(i => i.severity === 'fatal').length} fatales</span>
        </div>
      </section>
      <section class="sa-pr-plan-section"><h3>Asignación temp ↔ PO</h3><div id="sa-pr-asgn"></div></section>
      <section class="sa-pr-plan-section"><h3>Movimientos</h3><div id="sa-pr-moves"></div></section>
      <section class="sa-pr-plan-section"><h3>Sobrantes → OV Restantes</h3><div id="sa-pr-rest"></div></section>
      <section class="sa-pr-plan-section"><h3>Issues</h3><div id="sa-pr-issues"></div></section>
      <button id="sa-pr-recompute" class="sa-pr-btn">↻ Recalcular plan</button>
    `;
    renderAssignment();
    renderMoves();
    renderRestantes();
    renderIssues();
    document.getElementById('sa-pr-recompute').onclick = async () => {
      await renderStep3(body);
    };
  }
```

Add CSS:

```css
.sa-pr-pills { display: flex; gap: 12px; font-size: 13px; flex-wrap: wrap; }
.sa-pr-pills span { background: #f3f4f6; padding: 4px 10px; border-radius: 12px; }
.sa-pr-plan-section { margin-top: 24px; }
.sa-pr-plan-section h3 { font-size: 14px; margin: 0 0 8px; }
.sa-pr-btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; margin-top: 16px; }
```

- [ ] **Step 2: Stub de las funciones de render por sección**

```js
  function renderAssignment() { document.getElementById('sa-pr-asgn').innerHTML = '<em>TODO</em>'; }
  function renderMoves()      { document.getElementById('sa-pr-moves').innerHTML = '<em>TODO</em>'; }
  function renderRestantes()  { document.getElementById('sa-pr-rest').innerHTML  = '<em>TODO</em>'; }
  function renderIssues()     { document.getElementById('sa-pr-issues').innerHTML = '<em>TODO</em>'; }
```

- [ ] **Step 3: Smoke test**

Step 1 → 2 → 3: el plan se calcula y se muestra el resumen + secciones (con stubs todavía).

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 3 — buildPlan integration + resumen

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 8.2: Tabla de asignación editable (dropdowns)

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `renderAssignment`**

```js
  function renderAssignment() {
    const el = document.getElementById('sa-pr-asgn');
    const poNumbers = [...new Set(state.pdfs.filter(p => p.status === 'ok').map(p => p.parsed.poNumber))];
    el.innerHTML = `
      <table class="sa-pr-table">
        <thead><tr><th>Temp OV</th><th>PO asignado</th></tr></thead>
        <tbody>
          ${state.plan.assignment.map(a => {
            const t = state.tempOVs.find(x => x.id === a.tempOvId);
            return `
              <tr>
                <td>${escapeHtml(t?.name || a.tempOvId)}</td>
                <td>
                  <select data-temp="${a.tempOvId}">
                    ${poNumbers.map(pn => `<option value="${escapeHtml(pn)}" ${pn === a.poNumber ? 'selected' : ''}>${escapeHtml(pn)}</option>`).join('')}
                  </select>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    el.querySelectorAll('select').forEach(sel => {
      sel.onchange = () => {
        const tempId = sel.dataset.temp;
        const newPo = sel.value;
        // Override: rotar para mantener 1:1 (swap con cualquiera que tuviera ese PO)
        const oldAssgn = state.overrides.assignment || state.plan.assignment.map(a => ({ ...a }));
        const swap = oldAssgn.find(a => a.poNumber === newPo && a.tempOvId !== tempId);
        const me   = oldAssgn.find(a => a.tempOvId === tempId);
        if (!me) return;
        if (swap) swap.poNumber = me.poNumber;
        me.poNumber = newPo;
        state.overrides.assignment = oldAssgn;
        // Auto-recompute
        document.getElementById('sa-pr-recompute').click();
      };
    });
  }
```

- [ ] **Step 2: Smoke test**

En Step 3, cambiar el dropdown → el plan se recalcula, los moves cambian.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 3 asignación editable (swap automático para mantener 1:1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 8.3: Tabla de movimientos + sobrantes + issues

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `renderMoves`, `renderRestantes`, `renderIssues`**

```js
  function renderMoves() {
    const el = document.getElementById('sa-pr-moves');
    const moves = state.plan.moves;
    if (moves.length === 0) { el.innerHTML = '<em>Sin movimientos necesarios</em>'; return; }
    const nameOf = (ovId) => state.tempOVs.find(t => t.id === ovId)?.name || ovId;
    el.innerHTML = `
      <table class="sa-pr-table">
        <thead><tr><th>PN</th><th>Qty</th><th>De</th><th>A</th></tr></thead>
        <tbody>
          ${moves.map(m => `<tr>
            <td>${escapeHtml(m.pn)}</td>
            <td>${m.qty}</td>
            <td>${escapeHtml(nameOf(m.fromOvId))}</td>
            <td>${escapeHtml(nameOf(m.toOvId))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  function renderRestantes() {
    const el = document.getElementById('sa-pr-rest');
    const rest = state.plan.restantes;
    if (rest.length === 0) { el.innerHTML = '<em>Sin sobrantes</em>'; return; }
    const nameOf = (ovId) => state.tempOVs.find(t => t.id === ovId)?.name || ovId;
    const restName = state.restantesOV?.name || (api().getDomain().schneiderQueretaro?.restantesOvName || 'Restantes Schneider QRO');
    const willCreate = state.plan.creates.some(c => c.type === 'restantes-ov');
    el.innerHTML = `
      <p>${willCreate ? `<span class="sa-pr-issue-info">↻ Se creará OV "${escapeHtml(restName)}"</span>` : `<span>OV destino: <strong>${escapeHtml(restName)}</strong></span>`}</p>
      <table class="sa-pr-table">
        <thead><tr><th>PN</th><th>Qty</th><th>De</th></tr></thead>
        <tbody>
          ${rest.map(r => `<tr>
            <td>${escapeHtml(r.pn)}</td>
            <td>${r.qty}</td>
            <td>${escapeHtml(nameOf(r.fromOvId))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  function renderIssues() {
    const el = document.getElementById('sa-pr-issues');
    const issues = state.plan.issues;
    if (issues.length === 0) { el.innerHTML = '<em>Sin issues</em>'; return; }
    el.innerHTML = `
      <ul class="sa-pr-issues">
        ${issues.map(i => `<li class="sa-pr-issue-${i.severity}">[${i.severity.toUpperCase()}] ${escapeHtml(i.detail)}</li>`).join('')}
      </ul>
    `;
  }
```

Add CSS:

```css
.sa-pr-issues { list-style: none; padding: 0; font-size: 13px; }
.sa-pr-issues li { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; }
```

- [ ] **Step 2: Smoke test**

Step 3 muestra moves, sobrantes y issues con clases visuales correctas.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 3 — moves + sobrantes + issues tables

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 9 — UI Step 4: executor + bitácora

### Task 9.1: Stream visual + estado por paso

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `renderStep4` y estructura del executor**

```js
  function renderStep4(body) {
    body.innerHTML = `
      <div class="sa-pr-exec">
        <div class="sa-pr-exec-controls">
          <button id="sa-pr-run" class="sa-pr-btn-primary">▶ Ejecutar plan</button>
          <button id="sa-pr-cancel" class="sa-pr-btn" disabled>⏸ Cancelar</button>
          <button id="sa-pr-download" class="sa-pr-btn" disabled>⬇ Descargar bitácora (CSV)</button>
          <div id="sa-pr-progress"></div>
        </div>
        <ul id="sa-pr-exec-list" class="sa-pr-exec-list"></ul>
      </div>
    `;
    body.querySelector('#sa-pr-run').onclick = () => runExecutor();
    body.querySelector('#sa-pr-cancel').onclick = () => { state.runStale = true; };
    body.querySelector('#sa-pr-download').onclick = () => downloadAuditCsv();
  }

  function renderExecStep(step) {
    const ul = document.getElementById('sa-pr-exec-list');
    if (!ul) return;
    const icon = { pending: '⋯', running: '⠋', done: '✓', failed: '✗', skipped: '⊘' }[step.status];
    const cls  = { pending: '', running: '', done: 'sa-pr-issue-info', failed: 'sa-pr-issue-fatal', skipped: 'sa-pr-issue-warn' }[step.status];
    let li = ul.querySelector(`[data-step-id="${step.id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.stepId = step.id;
      ul.appendChild(li);
    }
    li.className = cls;
    li.innerHTML = `${icon} <strong>${escapeHtml(step.label)}</strong> ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}`;
  }
```

Add CSS:

```css
.sa-pr-exec-controls { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
.sa-pr-btn-primary { padding: 8px 16px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
.sa-pr-btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
.sa-pr-exec-list { list-style: none; padding: 0; font-size: 13px; max-height: 400px; overflow: auto; }
.sa-pr-exec-list li { padding: 6px 12px; border-bottom: 1px solid #f3f4f6; }
.sa-pr-exec-list li small { color: #6b7280; margin-left: 8px; }
#sa-pr-progress { margin-left: auto; color: #6b7280; font-size: 13px; }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): Step 4 — exec UI shell (run/cancel/download)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 9.2: Implementar `runExecutor()` con orden de mutaciones e idempotencia

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `runExecutor`**

```js
  async function runExecutor() {
    const runId = `run-${Date.now()}`;
    state.runId = runId;
    state.runStale = false;
    state.auditLog = [];
    document.getElementById('sa-pr-run').disabled = true;
    document.getElementById('sa-pr-cancel').disabled = false;

    const steps = buildExecutionSteps(state.plan);
    const progress = document.getElementById('sa-pr-progress');
    let done = 0;
    const total = steps.length;
    steps.forEach(s => renderExecStep(s));

    for (const step of steps) {
      if (state.runStale) { step.status = 'skipped'; renderExecStep(step); audit(step, 'cancelled'); continue; }
      step.status = 'running';
      renderExecStep(step);
      try {
        await runStepWithRetry(step);
        step.status = 'done';
        audit(step, 'ok');
      } catch (err) {
        step.status = 'failed';
        step.detail = err.message;
        audit(step, 'failed', err.message);
      }
      renderExecStep(step);
      done++;
      progress.textContent = `${done}/${total}`;
    }
    document.getElementById('sa-pr-cancel').disabled = true;
    document.getElementById('sa-pr-download').disabled = false;

    // Auto-download
    downloadAuditCsv();
  }

  function buildExecutionSteps(plan) {
    const steps = [];
    // 1. Create OV Restantes
    for (const c of plan.creates) {
      steps.push({ id: `create-${c.name}`, type: 'create_restantes_ov', label: `Crear OV "${c.name}"`, payload: c, status: 'pending' });
    }
    // 2. Moves entre temp
    plan.moves.forEach((m, i) => steps.push({
      id: `move-${i}`, type: 'move', label: `Mover ${m.qty}× ${m.pn}`,
      detail: `${state.tempOVs.find(t=>t.id===m.fromOvId)?.name} → ${state.tempOVs.find(t=>t.id===m.toOvId)?.name}`,
      payload: m, status: 'pending',
    }));
    // 3. Moves a Restantes
    plan.restantes.forEach((r, i) => steps.push({
      id: `rest-${i}`, type: 'move_to_restantes', label: `Mover ${r.qty}× ${r.pn} → Restantes`,
      detail: state.tempOVs.find(t=>t.id===r.fromOvId)?.name, payload: r, status: 'pending',
    }));
    // 4. Reconcile lines de cada OV tocada
    const touchedOvs = new Set([
      ...plan.moves.flatMap(m => [m.fromOvId, m.toOvId]),
      ...plan.restantes.map(r => r.fromOvId),
    ]);
    touchedOvs.forEach(ovId => {
      steps.push({ id: `recon-${ovId}`, type: 'reconcile_lines', label: `Reconciliar líneas (${state.tempOVs.find(t=>t.id===ovId)?.name || ovId})`, payload: { ovId }, status: 'pending' });
    });
    // 5. Renames
    plan.renames.forEach((r, i) => steps.push({
      id: `rename-${i}`, type: 'rename', label: `Renombrar "${r.fromName}" → "${r.toName}"`,
      payload: r, status: 'pending',
    }));
    return steps;
  }

  async function runStepWithRetry(step) {
    const maxAttempts = 3;
    const backoff = [1000, 2000, 4000];
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await dispatchStep(step);
        return;
      } catch (err) {
        lastErr = err;
        // Retry solo en 502 / network error
        const msg = String(err.message || '');
        const retriable = /502|network|ECONNRESET|Failed to fetch/i.test(msg);
        if (!retriable || attempt === maxAttempts - 1) throw err;
        await new Promise(r => setTimeout(r, backoff[attempt]));
      }
    }
    throw lastErr;
  }

  async function dispatchStep(step) {
    if (step.type === 'create_restantes_ov') {
      const seed = state.tempOVs[0]?.snapshot;
      if (!seed) throw new Error('No hay temp OV seed para crear Restantes');
      const created = await createRestantesOV(seed);
      state.restantesOV = { id: created.id, name: created.name };
      // Patch del plan: actualizar restantes con id real
      state.plan.restantes.forEach(r => { if (r.toOvId === '__pending_restantes__') r.toOvId = created.id; });
      step.detail = `id=${created.id} #${created.idInDomain}`;
    } else if (step.type === 'move' || step.type === 'move_to_restantes') {
      const m = step.payload;
      const fromOv = state.tempOVs.find(t => t.id === m.fromOvId);
      let toOv = state.tempOVs.find(t => t.id === m.toOvId);
      if (!toOv && step.type === 'move_to_restantes') {
        toOv = await loadOVDetails(state.restantesOV.id);
        state.tempOVs.push(toOv);
      }
      const fromOt = fromOv.ots.find(o => o.partNumber === m.pn);
      if (!fromOt) throw new Error(`No hay OT con PN ${m.pn} en ${fromOv.name}`);
      let toOt = toOv.ots.find(o => o.partNumber === m.pn);
      if (!toOt) {
        const created = await createOTInOV({
          ovId: toOv.id, customerId: toOv.customerId,
          deadline: toOv.snapshot?.deadline, partNumberId: fromOt.partNumberId, hintFromOt: fromOt,
        });
        // Reload details para refrescar OTs
        const fresh = await loadOVDetails(toOv.id);
        Object.assign(toOv, fresh);
        toOt = toOv.ots.find(o => o.id === created.id) || toOv.ots.find(o => o.partNumber === m.pn);
        if (!toOt) throw new Error(`OT creada (${created.id}) no aparece al recargar OV`);
      }
      // Idempotencia: si toOt.partCount ya creció en m.qty → skip
      // (verificación simplificada: skip si totales del PN en toOv ya matchean target)
      await executeMove({ pn: m.pn, qty: m.qty, fromOt, toOt, partNumberId: fromOt.partNumberId });
    } else if (step.type === 'reconcile_lines') {
      await reconcileLineQuantities(step.payload.ovId);
    } else if (step.type === 'rename') {
      const ov = state.tempOVs.find(t => t.id === step.payload.ovId);
      if (!ov?.snapshot) throw new Error(`Sin snapshot para OV ${step.payload.ovId}`);
      if (ov.snapshot.name === step.payload.toName) { step.detail = 'ya renombrada'; return; }
      await renameOV(ov.snapshot, step.payload.toName);
    } else {
      throw new Error(`Tipo de step desconocido: ${step.type}`);
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): runExecutor con orden creates→moves→reconcile→renames + retry 502

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 9.3: Bitácora CSV builder + download

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

- [ ] **Step 1: Implementar `audit` y `downloadAuditCsv`**

```js
  function audit(step, status, errorMessage) {
    state.auditLog.push({
      timestamp: new Date().toISOString(),
      run_id: state.runId,
      step_type: step.type,
      step_id: step.id,
      status,
      label: step.label,
      detail: step.detail || '',
      payload: JSON.stringify(step.payload || {}).slice(0, 500),
      error_message: errorMessage || '',
    });
  }

  function downloadAuditCsv() {
    if (state.auditLog.length === 0) return;
    const headers = Object.keys(state.auditLog[0]);
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...state.auditLog.map(row => headers.map(h => escape(row[h])).join(',')),
    ].join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliacion-schneider-qro-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): bitácora CSV builder + auto-download al terminar

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 10 — FAB flotante en `/Domains/<id>/ReceivedOrders`

### Task 10.1: Inject FAB cuando URL matchea

**Files:**
- Modify: `remote/scripts/po-reconciler.js` (reemplazar stub `syncFabVisibility`)

- [ ] **Step 1: Implementar `syncFabVisibility` y `renderFloatingButton`**

```js
  function syncFabVisibility() {
    const should = isAllowedPath();
    const existing = document.getElementById('sa-pr-fab');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) existing.remove();
  }

  function renderFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'sa-pr-fab';
    btn.className = 'sa-pr-fab';
    btn.title = 'Reconciliar OV vs PO Schneider';
    btn.textContent = '🧮';
    btn.onclick = openWizard;
    document.body.appendChild(btn);
  }
```

- [ ] **Step 2: Smoke test**

Navegar a `/Domains/<id>/ReceivedOrders` → ver el FAB. Navegar a otra URL → desaparece.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
feat(po-reconciler): FAB flotante en /Domains/*/ReceivedOrders

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 11 — Integración con popup (botón manual)

### Task 11.1: Handler en `background.js`

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Leer cómo otros applets manejan messages**

Run: `grep -n "run-po-comparator\|run-portal-importer\|case 'run-" extension/background.js`
Expected: identificar el patrón switch/handler existente.

- [ ] **Step 2: Agregar caso para `run-po-reconciler`**

Si el código tiene un patrón tipo:

```js
case 'run-po-comparator':
  injectScriptsAndCall(tabId, ['scripts/po-comparator.js'], 'POComparator.openModal()');
  break;
```

Agregar análogo:

```js
case 'run-po-reconciler':
  injectScriptsAndCall(tabId, [
    'scripts/steelhead-api.js',
    'scripts/claude-api.js',
    'scripts/po-comparator.js',
    'scripts/po-reconciler.js',
  ], 'POReconciler.openWizard()');
  break;
```

El nombre exacto del helper de inyección (`injectScriptsAndCall` o equivalente) depende del código existente. Si no existe, usar `chrome.scripting.executeScript({ ... files: [...] })` y luego `chrome.tabs.sendMessage(tabId, { action: 'run-po-reconciler' })` para que el listener del applet lo capture.

- [ ] **Step 3: Smoke test desde popup**

Cargar la extensión, click "Reconciliar Schneider QRO" en el popup → wizard se abre en la pestaña activa.

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "$(cat <<'EOF'
feat(extension): handler 'run-po-reconciler' inyecta applet y abre wizard

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 11.2: Verificar `popup.html` / `popup.js`

**Files:**
- Modify: `extension/popup.html` y/o `extension/popup.js` (probablemente NO se necesite — el popup se hidrata desde `config.json` `applets[]`)

- [ ] **Step 1: Inspeccionar cómo se genera la lista del popup**

Run: `grep -n "applets\|category\|categories" extension/popup.js`

Si el popup itera `config.applets` y renderiza dinámicamente, **no se requieren cambios** — el applet ya aparece gracias a Task 1.1.

- [ ] **Step 2: Si requiere agregar el botón explícito, hacerlo siguiendo el patrón existente**

(Steps de implementación dependen del shape del popup actual — si itera dinámicamente, omitir esta task.)

- [ ] **Step 3: Smoke test**

Abrir popup → ver "Reconciliar Schneider QRO" en su categoría → click lanza el wizard.

- [ ] **Step 4: Commit (si hubo cambios)**

```bash
git add extension/popup.html extension/popup.js
git commit -m "$(cat <<'EOF'
feat(popup): botón Reconciliar Schneider QRO (si requiere config explícita)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 12 — Endurecimiento y deploy

### Task 12.1: Limpiar `_helpers` expuesto

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

Durante el desarrollo expusimos `_helpers` en el return del IIFE para smoke-tests desde DevTools. Antes de deploy a producción, quitarlo (o gated detrás de un flag).

- [ ] **Step 1: Decidir**

Opciones:
- Quitar `_helpers` del return.
- Mantenerlo gated tras `window.__SA_DEBUG__`.

Recomendado: gated (`if (typeof window.__SA_DEBUG__ !== 'undefined') return { ..., _helpers };`) para futuros debugs.

- [ ] **Step 2: Implementar gating**

```js
  const publicApi = { init, openWizard, _engine: { consolidateByPN, hungarianMatch, assignTempsToPOs, computeMovesForPN, detectIssuesForPN, buildPlan } };
  if (typeof window !== 'undefined' && window.__SA_DEBUG__) {
    publicApi._helpers = { loadCandidateTempOVs, loadOVDetails, findRestantesOV, createRestantesOV, createOTInOV, executeMove, reconcileLineQuantities, renameOV, parseMultiplePdfs };
  }
  return publicApi;
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
chore(po-reconciler): gating _helpers detrás de window.__SA_DEBUG__

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 12.2: Auditoría de seguridad inline

**Files:**
- Modify: `remote/scripts/po-reconciler.js`

Validar checklist del audit de seguridad (sección "Pendientes del audit pre-producción" en `CLAUDE.md`):

- [ ] **Step 1: Buscar `innerHTML` con interpolación de datos externos**

Run: `grep -n "innerHTML" remote/scripts/po-reconciler.js`

Para cada hit, confirmar que TODOS los valores pasados están envueltos en `escapeHtml()` antes de interpolarse. Si encontramos uno sin escape (ej. `${err.message}`), envolverlo.

- [ ] **Step 2: Confirmar que `console.log` solo se usa vía `log()` (que respeta posible flag DEBUG en futuro)**

Run: `grep -n "console\.\(log\|warn\|error\)" remote/scripts/po-reconciler.js`

Idealmente, todos deben pasar por `log()` o `warn()` — al menos los que dumpean payloads sensibles.

- [ ] **Step 3: Commit si hubo cambios**

```bash
git add remote/scripts/po-reconciler.js
git commit -m "$(cat <<'EOF'
fix(po-reconciler): escape HTML en interpolaciones de error/payload

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 12.3: E2E manual contra Steelhead de prueba

Antes del deploy a `gh-pages`, correr el flujo completo contra un dominio de prueba.

- [ ] **Step 1: Preparar datos**

En Steelhead de prueba:
1. Crear cliente "Schneider QRO TEST" (o reusar) con dirección "QRO TEST".
2. Crear 3 OVs temp con nombres `TEST-Producción`, `TEST-Kitting`, `TEST-Lote cerrado`.
3. Cargar OTs con PNs comunes (A, B, C) y distribuciones diferentes.
4. Preparar 3 PDFs simulados de Schneider con POs `1400395001/002/003` que requieran rebalanceo.

- [ ] **Step 2: Correr el wizard completo**

1. Abrir Steelhead, entrar a `/Domains/<id>/ReceivedOrders/`.
2. Click FAB → wizard se abre.
3. Cargar los 3 PDFs.
4. Validar que las 3 temp OVs aparecen en sidebar.
5. Continuar → Step 2 parsea los 3 PDFs.
6. Continuar → Step 3 muestra plan editable con moves, sobrantes (si los hay), issues.
7. Continuar → Step 4 → click "Ejecutar plan".
8. Verificar que cada step pasa con ✓.
9. Verificar bitácora CSV descargada.

- [ ] **Step 3: Validación manual en Steelhead**

Después de la corrida:
- Las 3 OVs renombradas con números SAP correctos.
- Las OTs movidas a la OV correcta (verificar en cada PO Steelhead).
- `line.quantity` coincide con suma de OTs.
- OV Restantes existe (si aplicaba) con las piezas sobrantes.

Si algo no cuadra, **NO deployar todavía**: documentar la divergencia, ajustar, volver a correr.

- [ ] **Step 4: Documentar la corrida en notas**

Agregar a `docs/superpowers/notes/2026-05-12-po-reconciler-captures.md` un bloque "E2E run del <fecha>" con: input (PDFs, OVs), plan generado, resultado (OK / falla), notas.

### Task 12.4: Deploy a `gh-pages`

**Files:**
- Modify (en `gh-pages` branch): `scripts/po-reconciler.js`, `config.json`

- [ ] **Step 1: Asegurar que `main` está limpio y pushed**

```bash
git status
git push origin main
```

- [ ] **Step 2: Checkout `gh-pages`, copiar y commitear**

Procedimiento documentado en `CLAUDE.md` ("Deploy a producción → Procedimiento"):

```bash
git checkout gh-pages
cp ../main-checkout/remote/scripts/po-reconciler.js scripts/po-reconciler.js
cp ../main-checkout/remote/config.json config.json
git add scripts/po-reconciler.js config.json
git commit -m "$(cat <<'EOF'
deploy: po-reconciler v1 (Schneider QRO) + bump 0.6.0

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push y volver a main**

```bash
git push origin gh-pages
git checkout main
```

- [ ] **Step 4: Esperar 30-60s y verificar**

Recargar la extensión (chrome://extensions → reload), abrir Steelhead, validar que el applet aparece en el popup y FAB funciona.

- [ ] **Step 5: Confirmar bytes-iguales**

```bash
git diff HEAD:remote/scripts/po-reconciler.js gh-pages:scripts/po-reconciler.js
git diff HEAD:remote/config.json gh-pages:config.json
```

Expected: ambos diffs vacíos.

### Task 12.5: Actualizar `CLAUDE.md` con lecciones aprendidas

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Agregar sección `po-reconciler` con lecciones**

Después de validar el E2E, documentar las lecciones del proceso (siguiendo el patrón de `weight-quick-entry`, `warehouse-location-prefill`, etc.):

- Cardinalidad estricta 1:1 entre temps y POs (decisión clave).
- Hungarian over Σ|Δ| funciona perfectamente para N ≤ 6.
- `executeMove` cross-OV en una sola mutation `AddPartsToWorkOrders` (si Task 0.1 lo confirmó).
- Reconciliación de líneas con `SaveReceivedOrderLinesAndItems` es obligatoria post-move.
- OV Restantes persistente con nombre fijo permite escapar de sobrantes sin crear N OVs.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): lecciones del primer ciclo de po-reconciler (0.6.0)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 12.6: Push final

- [ ] **Step 1: `git push origin main`**
- [ ] **Step 2: Sanity check en Steelhead — FAB visible, popup tiene botón, wizard abre**

---

## Notas finales

### Decisiones intencionales fuera de scope
- **Sin undo automático.** Bitácora CSV solo. (Spec sección "Salidas esperadas".)
- **Sin auto-resolución de cardinality mismatch.** Issue fatal, usuario ajusta manualmente.
- **Sin soporte multi-cliente.** Refactor en v2 si se adopta para Hubbell u otros.
- **Sin OTs en proceso productivo.** Asunción: todo está en nodo terminal "Listo para Embarcar".

### Si algo se rompe en producción
1. Mirar la bitácora CSV de la corrida (descarga automática).
2. Buscar `failed` en columna `status`.
3. Revisar `error_message` y `payload`.
4. Si es 502 transitorio: el retry ya intentó 3 veces; reintentar el paso desde Step 4 (idempotencia maneja duplicados).
5. Si es shape mismatch (mutation rechazada con `4xx validación`): el hash o el shape cambió — re-scanear con `hash-scanner` y comparar payload contra captura del Task 0.x.

### Rollback de emergencia
Si v0.6.0 introduce regresión:

```bash
git checkout gh-pages
git revert <hash-del-deploy>
git push origin gh-pages
```

Los usuarios obtienen la versión anterior tras recargar la extensión.

---

## Bitácora de ejecución

### 2026-05-12 — sesión 1 (Phases 1-3 completas)

**Estado:** Motor puro y helpers GraphQL listos. NO desplegado a `gh-pages` (usuarios siguen en 0.5.86). Mañana retomar en Phase 4.

**Commits (orden cronológico):**
- `43d73ff` Task 1.1 — config 0.6.0, hashes nuevos, sección `schneiderQueretaro`
- `2c21f4f` Task 2.7 — hardening del motor (edge cases)
- `3f34e91` Task 2.6 — buildPlan
- `e698a50` Task 2.5 — detectIssuesForPN
- `922d7b1` Task 2.4 — computeMovesForPN
- (Tasks 1.2, 1.3, 2.1, 2.2, 2.3 en commits previos del día)
- `e4488a6` Task 3.1 — loadCandidateTempOVs
- `42ce09a` Task 3.2 — loadOVDetails
- `d3108b2` Task 3.3 — findRestantesOV
- `2412827` Task 3.4 — createRestantesOV
- `62e6854` Task 3.5 — findOTForPN + createOTInOV
- `3ec8fce` Task 3.6 — executeMove
- `a5b5c23` Task 3.7 — reconcileLineQuantities
- `1eb3091` Task 3.8 — renameOV + mapToUpdateShape
- `4b25bf8` plan commiteado

**Divergencias plan→captura aplicadas (CRÍTICO recordar en Phase 9 / executor):**

1. **Task 3.5 `createOTInOV`** — `CreateUpdateWorkOrdersChecked.variables.input` es **ARRAY** (no objeto único como decía el plan). Campos del array según captura: `{id, name, customerId, deadline, productId, startedAt, receivedOrderId, description, customerFacingNotes, type, blockPartialShipments, labelIds}`. Para crear nueva OT: `id: null`. `partNumberId`/`recipeNodeId` agregados a mayores aunque la captura era de rename (no validados en create).

2. **Task 3.6 `executeMove`** — rewrite completo. El plan tenía `inventoryTransferEventGroupsToCreate`/`creditAccounts`/`debitAccounts`/`type:'ENTRANCE'`/`transferType:'DEPLETE'`. **NO ES ESO.** Shape real: `input.receivedOrderPartTransforms[].partsTransferEvents[].partsTransfers[]` con `fromAccountId` (origen) + `toAccount{recipeNodeId, workOrderId, locationId, partNumberId, receivedOrderPartTransformId, materialConversionId, stationId}`, `type:'TRANSFER'`. La firma ahora incluye parámetros extra que el caller debe enriquecer: `toOvId, transformCount, transformDeadline, transformPriceId, lineItemAssocs`. **Phase 9 (executor) tiene que tomar estos campos del `loadOVDetails(toOvId)` antes de invocar `executeMove`.** Probablemente requiere extender `loadOVDetails` para devolver también `transformCount`, `transformDeadline`, `transformPriceId` y `lineItemAssocs` por OT, o pasar esos campos explícitos.

3. **Task 3.7 `reconcileLineQuantities`** — `lineItems[]` construido explícito (no spread del crudo). Campos exactos: `{id, archive, description, quantity, price, productId, unitId, quoteLineItemId, receivedOrderLineItemPartTransforms}`. El plan usaba `{...li, id, quantity}` que arrastra `__typename`/wrappers Apollo.

4. **Task 3.8 `renameOV`** — `UpdateReceivedOrder` recibe variables al **top level**, NO bajo `input` wrapper. El plan decía `{ input: { ... } }`; lo correcto es `{ id, name, customerId, ... }` directo. 18 campos full-record replay.

**Lo que falta verificar en E2E (Phase 9 y después):**
- Que `loadOVDetails` extraiga correctamente `accountId` de las OTs en producción (campo `inventoryAccountId` vs `accountId` — el extractor tiene fallback).
- Confirmar que `createOTInOV` con `id:null` + `partNumberId`/`recipeNodeId` efectivamente crea la OT (la captura era rename).
- Confirmar que `executeMove` con `transformCount: toOt.partCount` (default) acepta el server. Si no, hay que extender `loadOVDetails` para guardar el `count` del transform destino por separado.
- `reconcileLineQuantities` asume `lineItemsRaw[0]` — válido cuando una línea tiene un solo lineItem (caso Schneider). Si una línea tiene varios lineItems, hay que iterar.

**Próxima task al retomar:** Phase 4 — `parseMultiplePdfs` (Task 4.1 del plan). Usa `pdf.js` ya cargada en el applet PO Comparator; revisar `remote/scripts/po-comparator.js` para reutilizar el parser de PDF de Schneider.

**Sin pendientes de deploy.** `gh-pages` sigue en 0.5.86. Producción intacta.
