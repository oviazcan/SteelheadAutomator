# Candado de Surtido Programado (`surtido-guard`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nuevo applet de la extensión SteelheadAutomator que **bloquea** mover piezas al siguiente proceso desde el step "Preparando Surtido en Almacén" cuando la WO **no está programada**, y **marca en verde** las tarjetas cuya WO sí está programada.

**Architecture:** Interceptor de `window.fetch` (reusa el patrón de `auto-router.js`) como único punto de enforcement: lee la **respuesta** del query del board para construir un mapa `WO → programada`, e inspecciona el **request** de la mutación de mover para bloquearla (devolviendo un `Response` GraphQL de error sintético) — cubre tanto el modal "Mover Piezas" como el drag silencioso. Encima: una capa cosmética que agrisa los botones del modal, el marcado verde de tarjetas, y un toggle no persistente desde el popup. Lógica de decisión y parseo en un módulo puro `surtido-guard-core.js` con golden tests; el glue DOM/red en `surtido-guard.js` se valida en vivo.

**Tech Stack:** JavaScript vanilla (sin frameworks ni bundlers). `node --test` para los tests del módulo puro. `window.fetch` monkeypatch + `MutationObserver` para el glue. Deploy vía `tools/deploy.sh` a `gh-pages`. Config de dominio en `remote/config.json`.

## Global Constraints

Copiadas verbatim del spec (`docs/superpowers/specs/2026-06-26-surtido-guard-design.md`) y de `CLAUDE.md`. Aplican a **todas** las tareas:

- **JS vanilla**, sin React/frameworks/bundlers. Código y variables en inglés; UI y docs en español.
- **UI propia en DARK MODE** (base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento verde `#13a36f`). Toasts/mensajes nuestros en oscuro; el acento verde sobre tarjetas **nativas** es enriquecimiento del UI de SH (no convertir la tarjeta en UI nuestra).
- **Constantes de dominio** (operationNames, nombre de nodo, claves) van en `config.json` o en constantes nombradas del core, **no** mágicamente esparcidas.
- **Alcance:** solo el nodo **`"Preparando Surtido en Almacén"`** con tipo de transferencia **Paso**. Match por **nombre de nodo** (robusto entre boards). No tocar otros movimientos.
- **Política ante dato faltante = FAIL-SAFE:** si la WO objetivo no está en el mapa, **NO bloquear**. Solo bloquear con evidencia positiva de "no programada".
- **Toggle no persistente:** estado en memoria, **default ON en cada carga**; recargar la página lo regresa a ON. Vive en el popup vía **handler genérico** (`type:"toggle"` + `handler:"message"` + `fn`), **sin tocar `extension/`**.
- **Interceptor de fetch:** latch idempotente propio (`window.__saSurtidoGuardFetchPatched`); encadenar al `window.fetch` previo (otros applets ya lo envuelven; se apilan).
- **Memory hardening** (`memory-hardening-applets`): `MutationObserver` acotado, desconexión al salir del board, mapa bounded, parse-once.
- **Deploy:** `tools/deploy.sh "feat(surtido-guard): …" --check surtido-guard`. Validación en vivo **obligatoria** antes de marcar productivo. NO publicar a usuarios editando solo `remote/` en `main`.
- **NO adivinar DOM/shape:** los selectores y shapes salen de la **Fase 0 (Task 0)**; no iterar deploys a ciegas.

---

### Task 0: Fase 0 — Captura de shapes y fixtures (spike guiado)

Entregable: shapes reales documentados + fixtures en disco. **Bloquea** las tareas que tocan red/DOM (3–7). Requiere al usuario logueado en el board `Preparación de Surtido` (`/Domains/<id>/Workboards/6234`).

**Files:**
- Create: `tools/test/fixtures/surtido-guard-board-query.json` (respuesta real del query de tarjetas, recortada/sanitizada)
- Create: `tools/test/fixtures/surtido-guard-move-modal.json` (operationName + variables del MOVER por modal)
- Create: `tools/test/fixtures/surtido-guard-move-drag.json` (operationName + variables del drag silencioso)
- Create: `tools/test/fixtures/surtido-guard-modal.html` (outerHTML del modal "Mover Piezas")
- Create: `tools/test/fixtures/surtido-guard-card.html` (outerHTML de una tarjeta del step derecho)
- Modify: `docs/superpowers/specs/2026-06-26-surtido-guard-design.md` (añadir sección "## Shapes confirmados (Fase 0)")

**Interfaces:**
- Produces (documentado en la sección "Shapes confirmados"): `MOVE_OPERATIONS` (lista de `operationName` que mueven piezas — modal y drag), `BOARD_OPERATION` (operationName que llena las tarjetas), `SCHEDULE_FIELD_PATH` (dónde vive la fecha de programa por WO), `MOVE_VARS_KEYS` (cómo la mutación identifica WO/part-location, nodo origen y tipo "Paso"), `JOIN_KEY` (`workOrderId` | `partLocationId` — clave de cruce board↔mutación), selectores del modal (botones, "Desde Nodo") y de la tarjeta (WO#, part-location).

- [ ] **Step 1: Instrumentar un logger de GraphQL temporal**

Pídele al usuario que abra DevTools → Console en la página del board y pegue este snippet (no se commitea; es solo para capturar):

```js
(() => {
  const of = window.fetch;
  window.__saCap = [];
  window.fetch = async function (...a) {
    const [url, opts] = a;
    let op = null, vars = null;
    if (typeof url === 'string' && url.includes('/graphql') && opts?.body) {
      try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
    }
    const r = await of.apply(this, a);
    if (op) {
      const entry = { op, vars, dir: 'req', t: Date.now() };
      window.__saCap.push(entry);
      r.clone().json().then(j => { entry.dataKeys = j?.data ? Object.keys(j.data) : null; }).catch(() => {});
      console.log('[CAP]', op, vars);
    }
    return r;
  };
  console.log('Logger activo. Haz las acciones y luego copia: JSON.stringify(window.__saCap)');
})();
```

- [ ] **Step 2: Capturar el query del board**

El usuario recarga el board (con el logger activo) o hace scroll para forzar el query de tarjetas. Identifica en `[CAP]` el `operationName` que trae las tarjetas (candidatos: algo tipo `WorkboardCards…`, `RelatedSchedulingInformation`, `SchedulablePartLocations`, o uno específico del workboard). Guarda una **respuesta real recortada** (unas 3–5 tarjetas, incluyendo programadas y no programadas) en `surtido-guard-board-query.json`. Localiza el campo de **fecha de programa** por WO. Sanitiza datos sensibles.

- [ ] **Step 3: Capturar la mutación de mover (modal)**

El usuario abre el modal ⇄ de una tarjeta y presiona **MOVER**. Toma del log el `operationName` + `variables` y guárdalos en `surtido-guard-move-modal.json`. Anota cómo identifica la WO/part-location, el **nodo origen** y el **tipo "Paso"**.

- [ ] **Step 4: Capturar la mutación del drag silencioso**

El usuario arrastra una tarjeta a la derecha en el caso que mueve **sin** reabrir el modal. Captura ese `operationName` + `variables` en `surtido-guard-move-drag.json`. Confirma si es la **misma** operación que el modal o una distinta (define `MOVE_OPERATIONS`).

- [ ] **Step 5: Capturar HTML del modal y de la tarjeta**

Pídele al usuario el `outerHTML` del modal "Mover Piezas" (selecciona el contenedor del diálogo en Elements → Copy → Copy outerHTML) → `surtido-guard-modal.html`; y el `outerHTML` de **una tarjeta** del step derecho → `surtido-guard-card.html`. De aquí salen los selectores de: botones `MOVER`/`IMPRIMIR Y MOVER`, label "Desde Nodo", WO# y part-location de la tarjeta.

- [ ] **Step 6: Documentar shapes en el spec**

Añade al spec una sección `## Shapes confirmados (Fase 0)` con: `MOVE_OPERATIONS`, `BOARD_OPERATION`, `SCHEDULE_FIELD_PATH`, `JOIN_KEY`, los `MOVE_VARS_KEYS`, y los selectores del modal y de la tarjeta. Esta sección es la **fuente de verdad** para las Tasks 2–7.

- [ ] **Step 7: Commit**

```bash
git add tools/test/fixtures/surtido-guard-*.json tools/test/fixtures/surtido-guard-*.html docs/superpowers/specs/2026-06-26-surtido-guard-design.md
git commit -m "chore(surtido-guard): Fase 0 — fixtures y shapes capturados"
```

---

### Task 1: Módulo puro — lógica de decisión (`shouldBlockMove`)

Lógica de bloqueo **independiente del shape** (opera sobre un record normalizado). Testeable sin fixtures reales.

**Files:**
- Create: `remote/scripts/surtido-guard-core.js`
- Test: `tools/test/surtido-guard-core.test.js`

**Interfaces:**
- Produces: `window.SurtidoGuardCore.shouldBlockMove(record, opts)` donde `record = { found: boolean, programada: boolean, woId, fechaPrograma }` y `opts = { enforcementEnabled: boolean }`; retorna `{ block: boolean, reason: string }`. Reglas: si `!opts.enforcementEnabled` → `{block:false, reason:'disabled'}`; si `!record.found` → `{block:false, reason:'unknown-failsafe'}` (FAIL-SAFE); si `record.programada` → `{block:false, reason:'scheduled'}`; si no → `{block:true, reason:'not-scheduled'}`.

- [ ] **Step 1: Write the failing test**

```js
// tools/test/surtido-guard-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
// El core se publica como IIFE sobre window; para test en node lo cargamos con un shim.
global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'surtido-guard-core.js'));
const Core = global.window.SurtidoGuardCore;

test('shouldBlockMove: no bloquea si enforcement está OFF', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false, woId: 1 }, { enforcementEnabled: false });
  assert.deepStrictEqual(r, { block: false, reason: 'disabled' });
});

test('shouldBlockMove: FAIL-SAFE no bloquea si la WO no está en el mapa', () => {
  const r = Core.shouldBlockMove({ found: false }, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'unknown-failsafe');
});

test('shouldBlockMove: no bloquea WO programada', () => {
  const r = Core.shouldBlockMove({ found: true, programada: true, woId: 7 }, { enforcementEnabled: true });
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.reason, 'scheduled');
});

test('shouldBlockMove: bloquea WO no programada', () => {
  const r = Core.shouldBlockMove({ found: true, programada: false, woId: 9 }, { enforcementEnabled: true });
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.reason, 'not-scheduled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/surtido-guard-core.test.js`
Expected: FAIL ("Cannot read properties of undefined" / `SurtidoGuardCore` no definido).

- [ ] **Step 3: Write minimal implementation**

```js
// remote/scripts/surtido-guard-core.js
// Módulo puro (sin DOM ni red) del Candado de Surtido Programado.
// Lógica de decisión + parsers del board query y de la mutación de mover.
(function () {
  'use strict';

  function shouldBlockMove(record, opts) {
    if (!opts || opts.enforcementEnabled !== true) return { block: false, reason: 'disabled' };
    if (!record || record.found !== true) return { block: false, reason: 'unknown-failsafe' };
    if (record.programada === true) return { block: false, reason: 'scheduled' };
    return { block: true, reason: 'not-scheduled' };
  }

  const api = { shouldBlockMove };
  if (typeof window !== 'undefined') window.SurtidoGuardCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/surtido-guard-core.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/surtido-guard-core.js tools/test/surtido-guard-core.test.js
git commit -m "feat(surtido-guard): core shouldBlockMove (fail-safe) + tests"
```

---

### Task 2: Módulo puro — parsers del board y de la mutación (sobre fixtures reales)

Depende de **Task 0** (shapes + fixtures). Implementa el parseo dependiente del shape, probado contra los fixtures reales.

**Files:**
- Modify: `remote/scripts/surtido-guard-core.js`
- Test: `tools/test/surtido-guard-core.test.js`

**Interfaces:**
- Consumes: fixtures de Task 0; constantes `BOARD_OPERATION`, `MOVE_OPERATIONS`, `JOIN_KEY`, `SCHEDULE_FIELD_PATH` de la sección "Shapes confirmados".
- Produces:
  - `SurtidoGuardCore.extractScheduleRecords(boardData)` → `Array<{ woId, partLocationId, programada, fechaPrograma }>` (parsea la respuesta del board query).
  - `SurtidoGuardCore.indexRecords(records)` → `{ [joinKey]: record }` indexado por `JOIN_KEY`.
  - `SurtidoGuardCore.isSurtidoStepMove(op, vars)` → `boolean` (op ∈ `MOVE_OPERATIONS` **y** nodo origen = "Preparando Surtido en Almacén" **y** tipo Paso, según los `MOVE_VARS_KEYS`).
  - `SurtidoGuardCore.moveJoinKey(vars)` → el valor de `JOIN_KEY` que identifica la WO/part-location movida.
  - `SurtidoGuardCore.lookupRecord(index, vars)` → `{ found, programada, woId, fechaPrograma }` (combina `moveJoinKey` + `index`; `found:false` si no está).
  - Constantes exportadas: `SurtidoGuardCore.BOARD_OPERATION`, `SurtidoGuardCore.MOVE_OPERATIONS`, `SurtidoGuardCore.SOURCE_NODE_NAME = 'Preparando Surtido en Almacén'`, `SurtidoGuardCore.JOIN_KEY` (`'workOrderId'` | `'partLocationId'`, usado por Task 7 para indexar la tarjeta).

- [ ] **Step 1: Write the failing test (sobre fixtures de Task 0)**

```js
// añadir a tools/test/surtido-guard-core.test.js
const fs = require('node:fs');
const boardData = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'surtido-guard-board-query.json'), 'utf8'));
const moveModal = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'surtido-guard-move-modal.json'), 'utf8'));

test('extractScheduleRecords: programadas vs no programadas del fixture real', () => {
  const recs = Core.extractScheduleRecords(boardData.data || boardData);
  assert.ok(recs.length > 0, 'debe extraer al menos una tarjeta');
  // El fixture se capturó con AL MENOS una programada y una no programada (Task 0, Step 2).
  assert.ok(recs.some(r => r.programada === true), 'hay al menos una programada');
  assert.ok(recs.some(r => r.programada === false), 'hay al menos una no programada');
});

test('isSurtidoStepMove: reconoce el move real del modal como del nodo objetivo', () => {
  assert.strictEqual(Core.isSurtidoStepMove(moveModal.op, moveModal.vars), true);
});

test('lookupRecord + shouldBlockMove: integración con el move real', () => {
  const index = Core.indexRecords(Core.extractScheduleRecords(boardData.data || boardData));
  const record = Core.lookupRecord(index, moveModal.vars);
  const decision = Core.shouldBlockMove(record, { enforcementEnabled: true });
  assert.ok(['not-scheduled', 'scheduled', 'unknown-failsafe'].includes(decision.reason));
});
```

> Nota: los nombres exactos de campos (`woId`, `partLocationId`, `programada`, ruta de la fecha) se toman de la sección "Shapes confirmados (Fase 0)". Si Task 0 reveló que la clave de cruce es `partLocationId`, ajusta `JOIN_KEY` y los asserts en consecuencia (el comportamiento testeado no cambia).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/surtido-guard-core.test.js`
Expected: FAIL (`extractScheduleRecords` no definido).

- [ ] **Step 3: Write minimal implementation**

Implementa en `surtido-guard-core.js` (rellena las rutas con los shapes de Task 0). Esqueleto exacto a completar:

```js
  const BOARD_OPERATION = '<BOARD_OPERATION de Task 0>';
  const MOVE_OPERATIONS = ['<op del modal>', '<op del drag>']; // dedup si son la misma
  const SOURCE_NODE_NAME = 'Preparando Surtido en Almacén';
  const JOIN_KEY = '<workOrderId|partLocationId>'; // de Task 0

  function extractScheduleRecords(boardData) {
    // Navega boardData según SCHEDULE_FIELD_PATH (Task 0). Por cada tarjeta del board:
    //   woId, partLocationId, fechaPrograma = <campo de fecha>, programada = !!fechaPrograma
    const out = [];
    // ... recorrido concreto según el shape capturado ...
    return out;
  }

  function indexRecords(records) {
    const idx = {};
    for (const r of records) { if (r[JOIN_KEY] != null) idx[r[JOIN_KEY]] = r; }
    return idx;
  }

  function isSurtidoStepMove(op, vars) {
    if (!op || MOVE_OPERATIONS.indexOf(op) === -1 || !vars) return false;
    // Verifica nodo origen = SOURCE_NODE_NAME y tipo "Paso" según MOVE_VARS_KEYS (Task 0).
    return /* sourceNodeName === SOURCE_NODE_NAME && transferType === 'Paso' */ false;
  }

  function moveJoinKey(vars) { /* devuelve vars.<...> según Task 0 */ return null; }

  function lookupRecord(index, vars) {
    const key = moveJoinKey(vars);
    const rec = key != null ? index[key] : null;
    if (!rec) return { found: false };
    return { found: true, programada: rec.programada === true, woId: rec.woId, fechaPrograma: rec.fechaPrograma };
  }
```

Expón todo en el objeto `api` y reexporta las constantes (`BOARD_OPERATION`, `MOVE_OPERATIONS`, `SOURCE_NODE_NAME`, `JOIN_KEY`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/surtido-guard-core.test.js`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/surtido-guard-core.js tools/test/surtido-guard-core.test.js
git commit -m "feat(surtido-guard): parsers board/mutación + golden test sobre fixtures reales"
```

---

### Task 3: Scaffold del applet + alta en config + toggle desde popup

Crea el glue mínimo (sin enforcement aún): init en páginas de Workboard, latches, estado `enforcementEnabled` (default ON), `toggleFromPopup()`, toast dark-mode, y el alta del app en `config.json`. Verificable en vivo: el toggle responde desde el popup.

**Files:**
- Create: `remote/scripts/surtido-guard.js`
- Modify: `remote/config.json` (nuevo objeto en `apps`)

**Interfaces:**
- Consumes: `window.SurtidoGuardCore` (Task 1–2).
- Produces: `window.SurtidoGuard.toggleFromPopup()` → `{ enabled: boolean }`; `window.SurtidoGuard.isEnabled()`; `window.SurtidoGuard.init()`. Estado interno `enforcementEnabled` (default `true`).

- [ ] **Step 1: Crear el scaffold del applet**

```js
// remote/scripts/surtido-guard.js
// Candado de Surtido Programado — bloquea mover piezas no programadas en el
// step "Preparando Surtido en Almacén". Glue DOM/red; lógica en SurtidoGuardCore.
const SurtidoGuard = (() => {
  'use strict';
  const Core = () => window.SurtidoGuardCore;
  const WB_PATH_RE = /^\/Domains\/\d+\/Workboards\/\d+/;

  let enforcementEnabled = true;          // default ON cada carga (no persistente)
  let scheduleIndex = {};                 // JOIN_KEY -> record (lo llena el interceptor, Task 4)

  function isWorkboardPage() { return WB_PATH_RE.test(location.pathname); }
  function isEnabled() { return enforcementEnabled; }

  function toggleFromPopup() {
    enforcementEnabled = !enforcementEnabled;
    toast(enforcementEnabled
      ? '🔒 Candado de Surtido: ACTIVADO'
      : '🔓 Candado de Surtido: DESACTIVADO (hasta recargar)');
    return { enabled: enforcementEnabled };
  }

  function injectStyles() {
    if (document.getElementById('sa-sg-style')) return;
    const css = `
      .sa-sg-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
        z-index:2147483600;background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;
        border-left:4px solid #13a36f;border-radius:10px;padding:12px 18px;font-size:14px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}
      .sa-sg-toast.err{border-left-color:#e8513a;}`;
    const s = document.createElement('style');
    s.id = 'sa-sg-style'; s.textContent = css; document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    injectStyles();
    let el = document.getElementById('sa-sg-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-sg-toast'; document.body.appendChild(el); }
    el.className = 'sa-sg-toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.remove(); }, 4000);
  }

  function init() {
    if (window.__saSurtidoGuardInit) return;
    window.__saSurtidoGuardInit = true;
    if (!isWorkboardPage()) return;
    injectStyles();
    console.log('[SA] SurtidoGuard init en', location.pathname);
    // patchFetch() y observer se agregan en Tasks 4–7.
  }

  return { init, isEnabled, toggleFromPopup,
           _setIndex: (i) => { scheduleIndex = i; }, _getIndex: () => scheduleIndex };
})();

if (typeof window !== 'undefined') {
  window.SurtidoGuard = SurtidoGuard;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SurtidoGuard.init());
  } else {
    SurtidoGuard.init();
  }
}
```

- [ ] **Step 2: Alta del app en `config.json`**

Agrega este objeto al array `apps` de `remote/config.json` (no toques otros apps):

```jsonc
{
  "id": "surtido-guard",
  "name": "Candado de Surtido Programado",
  "subtitle": "Bloquea mover piezas no programadas en Preparación de Surtido",
  "icon": "🔒",
  "category": "Producción",
  "autoInject": true,
  "scripts": [
    "scripts/steelhead-api.js",
    "scripts/surtido-guard-core.js",
    "scripts/surtido-guard.js"
  ],
  "requiredPermissions": [],
  "actions": [
    {
      "id": "toggle-surtido-guard",
      "label": "Candado de Surtido",
      "sublabel": "Bloquear mover piezas no programadas (se reactiva al recargar)",
      "icon": "🔒",
      "type": "toggle",
      "handler": "message",
      "message": "toggle-surtido-guard",
      "fn": "SurtidoGuard.toggleFromPopup"
    }
  ]
}
```

- [ ] **Step 3: Verificar JSON válido**

Run: `python3 -c "import json; json.load(open('remote/config.json')); print('config OK')"`
Expected: `config OK`

- [ ] **Step 4: Deploy dev + smoke en vivo**

Run: `tools/deploy.sh "feat(surtido-guard): scaffold + toggle desde popup" --check surtido-guard`
Luego en Chrome: recargar la extensión, entrar al board `Preparación de Surtido`, abrir el popup → categoría Producción → "Candado de Surtido", presionar el toggle.
Expected: aparece toast "🔒 ACTIVADO" / "🔓 DESACTIVADO" en el board; consola muestra `[SA] SurtidoGuard init`.

- [ ] **Step 5: Commit**

(El deploy ya commiteó `main` + espejo `gh-pages`. Si trabajas en `feat/surtido-guard`, sincroniza/mergea según el flujo del repo; el bump de `config.json` lo hace `deploy.sh`.)

---

### Task 4: Interceptor de fetch — leer el board query → mapa `WO → programada`

Depende de Task 0 (BOARD_OPERATION, shape) y Task 2 (`extractScheduleRecords`/`indexRecords`).

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: `Core().extractScheduleRecords`, `Core().indexRecords`, `Core().BOARD_OPERATION`.
- Produces: `patchFetch()` instalado en `init()`; `scheduleIndex` poblado tras cada respuesta del board query.

- [ ] **Step 1: Implementar `patchFetch` (solo lectura) y llamarlo en `init`**

```js
  function patchFetch() {
    if (window.__saSurtidoGuardFetchPatched) return;
    window.__saSurtidoGuardFetchPatched = true;
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const [url, opts] = args;
      let op = null, vars = null;
      if (typeof url === 'string' && url.includes('/graphql') && opts?.body && typeof opts.body === 'string') {
        try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
      }
      const resp = await origFetch.apply(this, args);
      if (op === Core().BOARD_OPERATION) {
        try {
          resp.clone().json().then((j) => {
            if (!j || !j.data) return;
            const recs = Core().extractScheduleRecords(j.data);
            scheduleIndex = Core().indexRecords(recs);
            console.log('[SA] SurtidoGuard: mapa scheduled =', recs.length, 'WO');
          }).catch(() => {});
        } catch (_) {}
      }
      return resp;
    };
  }
```

En `init()`, tras `injectStyles()`, añade: `patchFetch();`

- [ ] **Step 2: Deploy dev + verificación en vivo**

Run: `tools/deploy.sh "feat(surtido-guard): interceptor lee board query → mapa scheduled" --check surtido-guard`
En el board: recargar, hacer scroll para forzar el query.
Expected: consola muestra `[SA] SurtidoGuard: mapa scheduled = N WO` con N>0; `window.SurtidoGuard._getIndex()` devuelve el índice poblado con `programada` correcto vs lo que se ve en el board.

- [ ] **Step 3: Commit** — lo hace `deploy.sh`.

---

### Task 5: Enforcement — bloquear la mutación de mover (modal + drag)

Depende de Task 2 (`isSurtidoStepMove`, `lookupRecord`, `MOVE_OPERATIONS`) y Task 4 (`scheduleIndex`). Este es el corazón del candado.

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: `Core().isSurtidoStepMove`, `Core().lookupRecord`, `Core().shouldBlockMove`, `Core().MOVE_OPERATIONS`, `scheduleIndex`, `enforcementEnabled`.
- Produces: el wrapper de `fetch` ahora devuelve un `Response` GraphQL de error sintético cuando `shouldBlockMove` ⇒ block; no llama a `origFetch`.

- [ ] **Step 1: Agregar el bloque de bloqueo ANTES de `origFetch` en `patchFetch`**

Dentro de `window.fetch`, justo después de parsear `op`/`vars` y **antes** de `const resp = await origFetch...`:

```js
      if (op && Core().MOVE_OPERATIONS.indexOf(op) !== -1 && Core().isSurtidoStepMove(op, vars)) {
        const record = Core().lookupRecord(scheduleIndex, vars);
        const decision = Core().shouldBlockMove(record, { enforcementEnabled });
        if (decision.block) {
          const wo = record.woId ? ('#' + record.woId) : 'seleccionada';
          toast('🔒 Bloqueado: la WO ' + wo + ' no está programada. No se puede mover.', true);
          console.warn('[SA] SurtidoGuard: BLOQUEADO move de WO', record.woId, '(no programada)');
          return new Response(
            JSON.stringify({ errors: [{ message: 'Bloqueado por extensión: la orden no está programada.' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
```

- [ ] **Step 2: Deploy dev + verificación en vivo (caso modal)**

Run: `tools/deploy.sh "feat(surtido-guard): enforcement — bloquea mutación de mover" --check surtido-guard`
En el board: abre el modal ⇄ de una WO **no programada** y presiona MOVER.
Expected: el movimiento **no** ocurre; aparece toast rojo "🔒 Bloqueado…"; la pieza sigue en el step. Con una WO **programada**: el movimiento procede normal.

- [ ] **Step 3: Verificación en vivo (caso drag silencioso)**

Arrastra una WO **no programada** a la derecha (el caso que antes movía en silencio).
Expected: queda bloqueado igual (toast rojo, sin moverse). WO programada: drag procede.

- [ ] **Step 4: Verificación del toggle**

Con el popup, apaga el candado (toggle OFF). Repite el move de una no programada.
Expected: ahora **sí** se mueve (enforcement OFF). Recargar la página → vuelve a ON.

- [ ] **Step 5: Commit** — lo hace `deploy.sh`.

---

### Task 6: Capa de modal — agrisar botones + mensaje inline

Depende de Task 0 (HTML del modal), Task 4 (`scheduleIndex`). Cosmético: el enforcement de Task 5 ya es el respaldo real.

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: selectores del modal (Task 0), `scheduleIndex`, `Core().lookupRecord`/`shouldBlockMove`, `enforcementEnabled`.
- Produces: `observeModal()` instalado en `init()`; al abrir el modal de una WO no programada, agrisa `MOVER`/`IMPRIMIR Y MOVER` + inserta mensaje.

- [ ] **Step 1: Capturar el contexto de la tarjeta al click en ⇄**

Para asociar el modal a una WO concreta (el PN no es único), añade un listener delegado que, al hacer click en el botón ⇄ de una tarjeta del step, guarda `lastCardContext = { woId, partLocationId }` leído del DOM de la tarjeta (selectores de Task 0). Código a completar con los selectores reales:

```js
  let lastCardContext = null;
  function installCardClickCapture() {
    document.addEventListener('click', (e) => {
      const moveBtn = e.target.closest('<selector del botón ⇄ de la tarjeta — Task 0>');
      if (!moveBtn) return;
      const card = moveBtn.closest('<selector de la tarjeta — Task 0>');
      if (!card) return;
      lastCardContext = readCardContext(card); // { woId, partLocationId } — selectores Task 0
    }, true);
  }
```

- [ ] **Step 2: Observar el modal y agrisar botones**

```js
  function observeModal() {
    const obs = new MutationObserver(() => applyModalGuard());
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saSurtidoGuardModalObs = obs; // para cleanup (Task 8)
  }

  function applyModalGuard() {
    const modal = document.querySelector('<selector del modal "Mover Piezas" — Task 0>');
    if (!modal) return;
    // Confirmar "Desde Nodo: Preparando Surtido en Almacén" (selector Task 0).
    if (!modalIsSurtidoStep(modal)) return;
    const record = Core().lookupRecord(scheduleIndex, ctxToVars(lastCardContext));
    const decision = Core().shouldBlockMove(record, { enforcementEnabled });
    const moverBtn = modal.querySelector('<selector botón MOVER — Task 0>');
    const printBtn = modal.querySelector('<selector botón IMPRIMIR Y MOVER — Task 0>');
    [moverBtn, printBtn].forEach((b) => { if (b) setBlocked(b, decision.block); });
    setModalMessage(modal, decision.block);
  }

  function setBlocked(btn, blocked) {
    if (blocked) { btn.setAttribute('disabled', 'true'); btn.style.opacity = '0.45'; btn.style.filter = 'grayscale(1)'; btn.style.pointerEvents = 'none'; btn.dataset.saBlocked = '1'; }
    else if (btn.dataset.saBlocked) { btn.removeAttribute('disabled'); btn.style.opacity = ''; btn.style.filter = ''; btn.style.pointerEvents = ''; delete btn.dataset.saBlocked; }
  }

  function setModalMessage(modal, blocked) {
    let msg = modal.querySelector('#sa-sg-modal-msg');
    if (blocked && !msg) {
      msg = document.createElement('div');
      msg.id = 'sa-sg-modal-msg';
      msg.style.cssText = 'background:#3a1d1d;color:#f3c2c2;border:1px solid #6b2b2b;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px;';
      msg.textContent = '🔒 No se puede mover: la orden de trabajo no está programada.';
      (modal.querySelector('<contenedor de botones — Task 0>') || modal).prepend(msg);
    } else if (!blocked && msg) { msg.remove(); }
  }
```

`modalIsSurtidoStep`, `ctxToVars`, `readCardContext` se completan con selectores/claves de Task 0. En `init()` añade `installCardClickCapture(); observeModal();`.

- [ ] **Step 3: Deploy dev + verificación en vivo**

Run: `tools/deploy.sh "feat(surtido-guard): capa modal — agrisa botones + mensaje" --check surtido-guard`
Abre el modal ⇄ de una WO **no programada**.
Expected: `MOVER` e `IMPRIMIR Y MOVER` salen grises/disabled, con el mensaje rojo "🔒 No se puede mover…". `CANCELAR` funciona. WO programada: botones normales. Toggle OFF: botones normales.

- [ ] **Step 4: Commit** — lo hace `deploy.sh`.

---

### Task 7: Marcado verde de tarjetas programadas (+ 🔒 en no programadas)

Depende de Task 0 (HTML de tarjeta) y Task 4 (`scheduleIndex`). Independiente del toggle (siempre activo).

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: selectores de tarjeta (Task 0), `scheduleIndex`, `readCardContext` (Task 6).
- Produces: `decorateCards()` invocado por el observer; re-aplica al re-render del board.

- [ ] **Step 1: Implementar `decorateCards`**

```js
  function decorateCards() {
    if (!isWorkboardPage()) return;
    const cards = document.querySelectorAll('<selector de tarjetas del step — Task 0>');
    cards.forEach((card) => {
      const ctx = readCardContext(card);
      const rec = ctx && scheduleIndex[ctx[Core().JOIN_KEY]];
      const programada = !!(rec && rec.programada);
      card.classList.toggle('sa-sg-green', programada);
      card.classList.toggle('sa-sg-locked', rec && !programada);
      markLockBadge(card, rec && !programada);
    });
  }
```

Añade al CSS de `injectStyles()`:

```css
.sa-sg-green{box-shadow:inset 4px 0 0 0 #13a36f;background:rgba(19,163,111,.06)!important;}
.sa-sg-locked{box-shadow:inset 4px 0 0 0 #6b7280;}
.sa-sg-lock-badge{position:absolute;top:6px;right:6px;font-size:13px;opacity:.8;}
```

`markLockBadge(card, show)` agrega/quita un `<span class="sa-sg-lock-badge">🔒</span>` (asegura `position:relative` en la tarjeta si hace falta).

- [ ] **Step 2: Disparar `decorateCards` desde el observer y tras poblar el mapa**

En `observeModal()`/el observer general, llama también `decorateCards()` (debounced ~150ms). Tras poblar `scheduleIndex` en `patchFetch` (Task 4), llama `decorateCards()`.

- [ ] **Step 3: Deploy dev + verificación en vivo**

Run: `tools/deploy.sh "feat(surtido-guard): marcado verde + lock en tarjetas" --check surtido-guard`
Expected: las tarjetas programadas muestran acento verde; las no programadas, 🔒 gris. Hacer scroll (virtualización) → el marcado se re-aplica. El verde permanece con el toggle OFF.

- [ ] **Step 4: Commit** — lo hace `deploy.sh`.

---

### Task 8: Memory hardening + cleanup al salir del board

Aplica el skill `memory-hardening-applets`. El applet mantiene `MutationObserver` + wrap de fetch en una página de larga vida.

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: listener de cambios de URL del SPA (patrón de `paros-linea.js`).
- Produces: `teardownOnLeave()` desconecta el observer y limpia `scheduleIndex`/`lastCardContext` al salir de `/Workboards/`; `decorateCards` debounced; el observer filtra mutaciones irrelevantes.

- [ ] **Step 1: Invocar el skill y aplicar checklist**

Invoca `memory-hardening-applets`. Aplica: (a) `scheduleIndex` bounded (re-asignar, no acumular — ya se reemplaza por completo en cada board query); (b) observer con `requestIdleCallback`/debounce y early-return si no hay nodos relevantes; (c) `teardownOnLeave()`.

- [ ] **Step 2: Implementar el listener de URL + teardown (patrón `paros-linea`)**

```js
  function installUrlChangeListener() {
    if (window.__saSurtidoGuardUrlListener) return;
    window.__saSurtidoGuardUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('sa-urlchange', () => {
      if (!isWorkboardPage()) teardownOnLeave();
    });
  }

  function teardownOnLeave() {
    if (window.__saSurtidoGuardModalObs) { window.__saSurtidoGuardModalObs.disconnect(); window.__saSurtidoGuardModalObs = null; }
    scheduleIndex = {}; lastCardContext = null;
    const t = document.getElementById('sa-sg-toast'); if (t) t.remove();
  }
```

Llama `installUrlChangeListener()` en `init()`. (El wrap de `fetch` se deja instalado — su latch lo hace idempotente y es barato; solo actúa sobre ops objetivo.)

- [ ] **Step 3: Deploy dev + verificación en vivo**

Run: `tools/deploy.sh "chore(surtido-guard): memory hardening + teardown al salir del board" --check surtido-guard`
Navega fuera del board y regresa. Revisa en consola que el observer se desconecta y se reinstala; sin fugas de listeners duplicados (latches respetados).
Expected: sin acumulación; el applet sigue funcionando al volver.

- [ ] **Step 4: Commit** — lo hace `deploy.sh`.

---

### Task 9: Bitácora del applet + alta en índice + validación final

**Files:**
- Create: `docs/applets/surtido-guard.md`
- Modify: `CLAUDE.md` (fila nueva en "Índice de applets")

**Interfaces:**
- Consumes: todo lo anterior + resultados de la validación en vivo.
- Produces: bitácora (versión, lecciones, shapes, plan de validación) + fila en el índice.

- [ ] **Step 1: Escribir `docs/applets/surtido-guard.md`**

Incluye: qué resuelve, arquitectura (5 capas), shapes confirmados (Task 0), `MOVE_OPERATIONS`/`BOARD_OPERATION`/`JOIN_KEY`, regla fail-safe, comportamiento del toggle, lecciones del run real, y pendientes.

- [ ] **Step 2: Alta en el índice de `CLAUDE.md`**

Agrega a la tabla "Índice de applets":

```
| `surtido-guard` (Candado de Surtido Programado) | 0.1.0 (bloquea mover piezas no programadas en el step "Preparando Surtido en Almacén" vía interceptor de fetch — cubre modal y drag silencioso; agrisa botones del modal; marca verde las programadas; toggle no persistente en popup, default ON; fail-safe ante dato faltante) | [`docs/applets/surtido-guard.md`](docs/applets/surtido-guard.md) |
```

> `CLAUDE.md` es **hot file** (regla de trabajo paralelo): edítalo en una pasada corta read→edit→commit→push, coordinando que no haya otra sesión tocándolo.

- [ ] **Step 3: Correr el test del core una última vez**

Run: `node --test tools/test/surtido-guard-core.test.js`
Expected: PASS (todos).

- [ ] **Step 4: Verificar deploy en vivo**

Run: `tools/deploy-status.sh`
Expected: versión de `gh-pages` == EN VIVO; invariante byte-a-byte OK; `surtido-guard.js` y `surtido-guard-core.js` presentes en el sitio publicado.

- [ ] **Step 5: Commit**

```bash
git add docs/applets/surtido-guard.md CLAUDE.md
git commit -m "docs(surtido-guard): bitácora del applet + alta en índice"
```

---

## Notas de ejecución

- **Tasks 1 y 3** no dependen de Task 0 (lógica pura de decisión + scaffold + toggle); pueden hacerse en paralelo a la captura para tener feedback temprano del toggle.
- **Tasks 2, 4–7** dependen de los shapes/selectores reales de **Task 0** — no escribir selectores ni rutas de campos a ciegas (regla `CLAUDE.md`).
- **Cada deploy** publica a usuarios (gh-pages); valida en vivo antes de avanzar. Si hay otra sesión de Claude activa, coordina `config.json`/`CLAUDE.md`/`gh-pages` (hot files).
- **Rama:** todo el trabajo va en `feat/surtido-guard` (el spec ya está commiteado ahí). El merge a `main` y la danza de `gh-pages` los maneja `deploy.sh`; coordina según el flujo del repo.
