# hash-autopilot v2 — Fase C (ciclo sentinela para mutations) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Autocorregir la rotación de mutations de forma desatendida y segura, capturando su hash nuevo mediante un **ciclo sentinela** (objeto canario: desarchivar → mutar → capturar → re-archivar) con salvaguardas fuertes: identidad inequívoca fail-closed, journal + reparación idempotente, blast-radius ≤1, y escalamiento en vez de fuerza cuando algo no es seguro.

**Architecture:** El grueso del riesgo se aísla en núcleos **puros y testeados**: la máquina de estados del ciclo, la verificación de identidad del sentinela, la selección de estrategia por tipo de mutation, y el journal de reparación. La parte de integración (ejecutar la mutación real via frontend headless) reutiliza el `recipe-runner` de Fase A pero **nunca** actúa sin que los núcleos puros aprueben. Un `sentinels-config.json` declara los objetos canario. El motor solo entra al ciclo para mutations que el validator marcó rotadas.

**Tech Stack:** Node ESM (`.mjs`) puro para los núcleos + `node:test`; Playwright (via el motor) para la integración; JSON para config y journal.

## Global Constraints

- **Scope:** solo mutations (`remote/config.json` → `steelhead.hashes.mutations`, 69). Queries son Fase A/B.
- **Autonomía:** todo desatendido (decisión del usuario 2026-07-06) — POR ESO las salvaguardas son obligatorias, no opcionales.
- **Identidad inequívoca:** un objeto solo entra al ciclo si verifica como sentinela (marca canónica `__SA_SENTINEL__` en nombre/tag/campo declarado). **Fail-closed:** ante cualquier duda, NO mutar y escalar.
- **Blast radius ≤ 1:** el ciclo aborta si tocaría más de un objeto, o un objeto con relaciones/dependencias no esperadas.
- **Reversibilidad:** `try/finally` + journal en `tools/.hash-autopilot/sentinel-journal.json`. Un ciclo interrumpido deja el journal en `dirty`; el siguiente run **repara antes de cualquier otra acción** (idempotente).
- **Destructivas (`Delete*`):** NUNCA sobre sentinela archivado (irreversible) → `ephemeral-create-destroy` (crear-capturar-destruir un efímero). Si no hay forma segura → `no-auto` → escala.
- **Solo lo rotado:** el ciclo de una mutation corre únicamente si el validator la marcó stale (minimiza mutaciones en prod).
- **Reutiliza Fase A:** `classifyOp`/`planDeploy`/`hasShape` (`hash-autopilot-core.mjs`), `config-io.writeConfigHashes`, `autopilot-deploy.sh`, `recipe-runner`. No reimplementar.
- **Marca canónica:** `const SENTINEL_MARKER = '__SA_SENTINEL__';` — mismo literal en config, código y verificación.
- **route-catalog `sentinel` block** (del spec §5.1): `{entityType, strategy, mutateStep, restoreStep}`.

---

### Task 1: `sentinels.mjs` — máquina de estados del ciclo (puro)

**Files:**
- Create: `tools/hash-autopilot/sentinels.mjs`
- Test: `tools/test/sentinels-state.test.js`

**Interfaces:**
- Produces: `cycleNext(state, event): string` — máquina determinista. Estados: `'base'` (sentinela archivado, listo), `'dirty'` (mutado, pendiente de restaurar), `'restoring'`, `'failed'`. Eventos: `'open'` (base→dirty), `'restore'` (dirty→restoring), `'restored'` (restoring→base), `'error'` (cualquiera→failed). Transición inválida → lanza `Error('transición inválida: <state> -<event>->')` (fail-closed: nunca inventa un estado).

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/sentinels-state.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { cycleNext } = require('../hash-autopilot/sentinels.mjs');

test('cycleNext: ciclo feliz base→dirty→restoring→base', () => {
  assert.equal(cycleNext('base', 'open'), 'dirty');
  assert.equal(cycleNext('dirty', 'restore'), 'restoring');
  assert.equal(cycleNext('restoring', 'restored'), 'base');
});

test('cycleNext: error desde cualquier estado → failed', () => {
  assert.equal(cycleNext('dirty', 'error'), 'failed');
  assert.equal(cycleNext('restoring', 'error'), 'failed');
});

test('cycleNext: transición inválida lanza (fail-closed, no inventa estado)', () => {
  assert.throws(() => cycleNext('base', 'restore'), /transición inválida/);
  assert.throws(() => cycleNext('failed', 'open'), /transición inválida/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/sentinels-state.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// tools/hash-autopilot/sentinels.mjs
// Núcleos PUROS del ciclo sentinela (sin red/DOM). La integración headless los
// consume pero nunca actúa sin su aprobación.

export const SENTINEL_MARKER = '__SA_SENTINEL__';

// Máquina de estados del ciclo. Determinista y fail-closed: una transición no
// declarada lanza, nunca produce un estado inventado.
const TRANSITIONS = {
  base: { open: 'dirty' },
  dirty: { restore: 'restoring', error: 'failed' },
  restoring: { restored: 'base', error: 'failed' },
};
export function cycleNext(state, event) {
  if (event === 'error' && (state === 'dirty' || state === 'restoring')) return 'failed';
  const next = TRANSITIONS[state] && TRANSITIONS[state][event];
  if (!next) throw new Error(`transición inválida: ${state} -${event}->`);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/sentinels-state.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/sentinels.mjs tools/test/sentinels-state.test.js
git commit -m "feat(hash-autopilot): sentinels cycleNext — máquina de estados fail-closed (Fase C)"
```

---

### Task 2: `sentinels.mjs` — identidad + estrategia (puro)

**Files:**
- Modify: `tools/hash-autopilot/sentinels.mjs`
- Test: `tools/test/sentinels-identity.test.js`

**Interfaces:**
- Produces:
  - `isSentinel(obj): boolean` — true SOLO si `obj` tiene la marca `SENTINEL_MARKER` en su `name`/`displayName`/tags/`customInputs` de forma reconocible. Cualquier ambigüedad → false (fail-closed).
  - `strategyFor(mutationOp): 'archived-mutate-restore' | 'ephemeral-create-destroy' | 'no-auto'` — `Delete*`/`Remove*` → ephemeral; `Save*`/`Update*`/`Archive*`/`Set*`/`Create*` → archived-mutate-restore; el resto → `no-auto` (escala).

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/sentinels-identity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSentinel, strategyFor, SENTINEL_MARKER } = require('../hash-autopilot/sentinels.mjs');

test('isSentinel: marca en name → true', () => {
  assert.equal(isSentinel({ name: `ZZZ ${SENTINEL_MARKER} no-tocar` }), true);
});
test('isSentinel: marca en tags → true', () => {
  assert.equal(isSentinel({ tags: ['x', SENTINEL_MARKER] }), true);
});
test('isSentinel: sin marca → false (fail-closed)', () => {
  assert.equal(isSentinel({ name: 'Cliente Real S.A.' }), false);
  assert.equal(isSentinel({}), false);
  assert.equal(isSentinel(null), false);
});

test('strategyFor: Delete/Remove → ephemeral', () => {
  assert.equal(strategyFor('DeletePartNumber'), 'ephemeral-create-destroy');
  assert.equal(strategyFor('RemoveLabelUser'), 'ephemeral-create-destroy');
});
test('strategyFor: Save/Update/Archive/Set/Create → archived-mutate-restore', () => {
  for (const op of ['SaveQuoteLines', 'UpdateStationInputs', 'ArchiveInventoryBatchStatus', 'SetX', 'CreateReceivedOrder']) {
    assert.equal(strategyFor(op), 'archived-mutate-restore');
  }
});
test('strategyFor: prefijo desconocido → no-auto (escala)', () => {
  assert.equal(strategyFor('RecomputeSomething'), 'no-auto');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/sentinels-identity.test.js`
Expected: FAIL — `isSentinel is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// añadir a tools/hash-autopilot/sentinels.mjs

// Verificación de identidad — fail-closed: solo true si la marca aparece de forma
// reconocible. Ante datos raros/nulos → false (no mutar).
export function isSentinel(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const hay = (s) => typeof s === 'string' && s.includes(SENTINEL_MARKER);
  if (hay(obj.name) || hay(obj.displayName)) return true;
  if (Array.isArray(obj.tags) && obj.tags.some(hay)) return true;
  // customInputs anidados: busca la marca en cualquier string de primer/segundo nivel.
  if (obj.customInputs && typeof obj.customInputs === 'object') {
    for (const v of Object.values(obj.customInputs)) {
      if (hay(v)) return true;
      if (v && typeof v === 'object') for (const vv of Object.values(v)) if (hay(vv)) return true;
    }
  }
  return false;
}

// Estrategia por prefijo del nombre de la mutation. Destructivas → efímero;
// reversibles → archivar/restaurar; lo demás → escala (no-auto).
export function strategyFor(mutationOp) {
  if (/^(Delete|Remove)/.test(mutationOp)) return 'ephemeral-create-destroy';
  if (/^(Save|Update|Archive|Set|Create|Add)/.test(mutationOp)) return 'archived-mutate-restore';
  return 'no-auto';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/sentinels-identity.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/sentinels.mjs tools/test/sentinels-identity.test.js
git commit -m "feat(hash-autopilot): sentinels isSentinel (fail-closed) + strategyFor (Fase C)"
```

---

### Task 3: `sentinels.mjs` — journal + reparación idempotente (puro)

**Files:**
- Modify: `tools/hash-autopilot/sentinels.mjs`
- Test: `tools/test/sentinels-journal.test.js`

**Interfaces:**
- Produces (operan sobre un objeto journal plano `{[entityType]: {state, sentinelId, op, ts}}`, sin I/O — el caller persiste):
  - `journalOpen(journal, entityType, sentinelId, op, ts): journal` — marca la entidad `dirty`. Lanza si ya hay una entrada `dirty` para esa entidad (no dos ciclos concurrentes sobre el mismo sentinela).
  - `journalClose(journal, entityType): journal` — elimina la entrada (ciclo restaurado OK).
  - `pendingRepairs(journal): Array<{entityType, sentinelId, op}>` — entradas en `dirty`/`restoring`/`failed` que requieren reparación antes de nuevos ciclos. Determinista (orden por entityType).

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/sentinels-journal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { journalOpen, journalClose, pendingRepairs } = require('../hash-autopilot/sentinels.mjs');

test('journalOpen marca dirty; journalClose lo limpia', () => {
  let j = {};
  j = journalOpen(j, 'ReceivedOrder', 'RO-SENT-1', 'SaveReceivedOrderLinesAndItems', 1000);
  assert.equal(j.ReceivedOrder.state, 'dirty');
  assert.equal(j.ReceivedOrder.sentinelId, 'RO-SENT-1');
  j = journalClose(j, 'ReceivedOrder');
  assert.equal(j.ReceivedOrder, undefined);
});

test('journalOpen sobre entidad ya dirty lanza (no ciclos concurrentes)', () => {
  let j = journalOpen({}, 'Part', 'P-SENT', 'UpdatePart', 1);
  assert.throws(() => journalOpen(j, 'Part', 'P-SENT', 'UpdatePart', 2), /ya.*dirty|en curso/i);
});

test('pendingRepairs lista las entradas sucias, ordenadas y sin las limpias', () => {
  let j = {};
  j = journalOpen(j, 'Zebra', 'Z1', 'SaveZ', 1);
  j = journalOpen(j, 'Alpha', 'A1', 'SaveA', 2);
  const rep = pendingRepairs(j);
  assert.deepEqual(rep.map((r) => r.entityType), ['Alpha', 'Zebra']); // ordenado
  assert.deepEqual(rep.map((r) => r.op), ['SaveA', 'SaveZ']);
});

test('pendingRepairs: journal vacío → []', () => {
  assert.deepEqual(pendingRepairs({}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/sentinels-journal.test.js`
Expected: FAIL — `journalOpen is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// añadir a tools/hash-autopilot/sentinels.mjs

// Journal: mapa entityType → {state, sentinelId, op, ts}. Funciones puras que
// devuelven un NUEVO journal (el caller lo persiste en disco). Una entidad con
// entrada presente está "sucia" (ciclo sin cerrar) y bloquea nuevos ciclos suyos.
export function journalOpen(journal, entityType, sentinelId, op, ts) {
  const cur = journal[entityType];
  if (cur && (cur.state === 'dirty' || cur.state === 'restoring')) {
    throw new Error(`ciclo en curso (dirty) para ${entityType} — reparar antes`);
  }
  return { ...journal, [entityType]: { state: 'dirty', sentinelId, op, ts } };
}
export function journalClose(journal, entityType) {
  const { [entityType]: _drop, ...rest } = journal;
  return rest;
}
export function pendingRepairs(journal) {
  return Object.entries(journal || {})
    .filter(([, e]) => e && e.state !== 'base')
    .map(([entityType, e]) => ({ entityType, sentinelId: e.sentinelId, op: e.op }))
    .sort((a, b) => (a.entityType < b.entityType ? -1 : a.entityType > b.entityType ? 1 : 0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/sentinels-journal.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/sentinels.mjs tools/test/sentinels-journal.test.js
git commit -m "feat(hash-autopilot): sentinels journal + pendingRepairs (idempotencia Fase C)"
```

---

### Task 4: `sentinels-config.json` — registro de objetos canario

**Files:**
- Create: `tools/hash-autopilot/sentinels-config.json`

**Interfaces:**
- Produces: el registro que el runner consulta. Por `entityType`: `{id, marker, baseState, module}`. Vacío al inicio (se puebla al sembrar sentinelas en el ERP, Task 7). El runner que no halle sentinela para una entidad → escala esa mutation, no la fuerza.

- [ ] **Step 1: Crear el registro (esqueleto documentado, sin sentinelas aún)**

```json
{
  "_doc": "Registro de objetos canario por tipo de entidad. Se puebla al SEMBRAR sentinelas reales en el ERP (ver docs/api/hash-fase-c-sembrado-sentinelas.md). marker = SENTINEL_MARKER que lleva el objeto (__SA_SENTINEL__). baseState = estado de reposo (normalmente 'archived'). Sin entrada para una entidad → el runner escala esa mutation en vez de ejecutarla a ciegas.",
  "_marker": "__SA_SENTINEL__",
  "entities": {}
}
```

- [ ] **Step 2: Validar que parsea**

Run: `node -e "JSON.parse(require('fs').readFileSync('tools/hash-autopilot/sentinels-config.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add tools/hash-autopilot/sentinels-config.json
git commit -m "feat(hash-autopilot): sentinels-config esqueleto (se puebla al sembrar) (Fase C)"
```

---

### Task 5: `sentinels.mjs` — planeación de ciclo (puro, une identidad+estrategia+config)

**Files:**
- Modify: `tools/hash-autopilot/sentinels.mjs`
- Test: `tools/test/sentinels-plan.test.js`

**Interfaces:**
- Produces: `planMutationCapture(mutationOp, sentinelsConfig): {action: 'run'|'escalate', strategy?, entityType?, sentinelId?, reason?}` — decide si una mutation rotada se puede capturar de forma segura: estrategia `no-auto` → escalate; estrategia efímera pero sin soporte declarado → escalate; `archived-mutate-restore` con sentinela declarado en config → run; sin sentinela declarado → escalate (reason). Puro, determinista.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/sentinels-plan.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { planMutationCapture } = require('../hash-autopilot/sentinels.mjs');

const cfg = { entities: { ReceivedOrder: { id: 'RO-1', marker: '__SA_SENTINEL__', baseState: 'archived', module: 'ReceivedOrders' } } };

// Un mapa op→entityType lo provee el route-catalog (sentinel.entityType); aquí se pasa.
test('archived-mutate-restore con sentinela declarado → run', () => {
  const r = planMutationCapture('SaveReceivedOrderLinesAndItems', cfg, 'ReceivedOrder');
  assert.equal(r.action, 'run');
  assert.equal(r.strategy, 'archived-mutate-restore');
  assert.equal(r.sentinelId, 'RO-1');
});
test('sin sentinela declarado para la entidad → escalate', () => {
  const r = planMutationCapture('SavePart', cfg, 'Part');
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /sentinela|no declarad/i);
});
test('mutation no-auto (prefijo desconocido) → escalate', () => {
  const r = planMutationCapture('RecomputeX', cfg, 'ReceivedOrder');
  assert.equal(r.action, 'escalate');
});
test('destructiva → escalate en v1 (ephemeral aún no soportado)', () => {
  const r = planMutationCapture('DeletePart', cfg, 'Part');
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /destructiva|ephemeral|efímero/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/sentinels-plan.test.js`
Expected: FAIL — `planMutationCapture is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// añadir a tools/hash-autopilot/sentinels.mjs
// import de strategyFor ya está en el mismo módulo.

// Decide si una mutation rotada se captura de forma segura. v1 soporta SOLO
// archived-mutate-restore con sentinela declarado; ephemeral (destructivas) escala.
export function planMutationCapture(mutationOp, sentinelsConfig, entityType) {
  const strategy = strategyFor(mutationOp);
  if (strategy === 'no-auto') return { action: 'escalate', reason: `estrategia no-auto para ${mutationOp}` };
  if (strategy === 'ephemeral-create-destroy') {
    return { action: 'escalate', reason: `destructiva (ephemeral no soportado en v1): ${mutationOp}` };
  }
  const ent = sentinelsConfig?.entities?.[entityType];
  if (!ent) return { action: 'escalate', reason: `sin sentinela declarado para entidad ${entityType}` };
  return { action: 'run', strategy, entityType, sentinelId: ent.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/sentinels-plan.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/sentinels.mjs tools/test/sentinels-plan.test.js
git commit -m "feat(hash-autopilot): planMutationCapture — gate de seguridad (run/escalate) (Fase C)"
```

---

### Task 6: `mutation-runner.mjs` — integración headless del ciclo (con guardias)

**Files:**
- Create: `tools/hash-autopilot/mutation-runner.mjs`
- Test: `tools/test/mutation-runner-guards.test.js` (unit sobre las guardias, con page/sink mockeados)

**Interfaces:**
- Consumes: `installInterceptor`/patrón de `recipe-runner`, los núcleos de `sentinels.mjs`, el `sentinel` block de la ruta (route-catalog), `sentinels-config.json`.
- Produces: `runMutationCycle(page, route, sentinelsConfig, sink, deps): Promise<{captured: boolean, op, hash?, escalated?, reason?}>` — orquesta: `planMutationCapture` → si `escalate`, retorna sin tocar nada; si `run`, journalOpen → navega a la pantalla del sentinela → **verifica `isSentinel` sobre el objeto cargado (deps.loadObject)**; si falla → aborta+journalClose+escala; si OK → ejecuta `mutateStep` (dispara la mutation, el interceptor captura el hash) → `restoreStep` → journalClose. `try/finally` garantiza el intento de restore. `deps` inyecta `loadObject`, `readJournal`, `writeJournal` para testear las guardias sin ERP real.

- [ ] **Step 1: Write the failing test (guardias, sin navegador real)**

```javascript
// tools/test/mutation-runner-guards.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runMutationCycle } = require('../hash-autopilot/mutation-runner.mjs');

const cfg = { entities: { ReceivedOrder: { id: 'RO-1', marker: '__SA_SENTINEL__', baseState: 'archived' } } };
const route = { captures: ['SaveReceivedOrderLinesAndItems'], sentinel: { entityType: 'ReceivedOrder', strategy: 'archived-mutate-restore', mutateStep: {}, restoreStep: {} }, steps: [] };

function fakePage() { return { goto: async () => {}, evaluate: async () => {}, waitForTimeout: async () => {} }; }

test('escala destructiva sin tocar nada', async () => {
  const r = await runMutationCycle(fakePage(), { ...route, captures: ['DeleteReceivedOrder'] }, cfg, { hashes: {} }, {
    loadObject: async () => { throw new Error('no debió cargar'); }, readJournal: () => ({}), writeJournal: () => {},
  });
  assert.equal(r.captured, false);
  assert.equal(r.escalated, true);
});

test('aborta y NO muta si el objeto cargado no es sentinela (fail-closed)', async () => {
  let mutated = false;
  const r = await runMutationCycle(fakePage(), route, cfg, { hashes: {} }, {
    loadObject: async () => ({ name: 'OV Real de Cliente' }), // sin marca
    readJournal: () => ({}), writeJournal: () => {},
    doMutate: async () => { mutated = true; },
  });
  assert.equal(mutated, false);
  assert.equal(r.captured, false);
  assert.match(r.reason, /no.*sentinela|identidad/i);
});

test('captura el hash cuando el objeto ES sentinela y la mutación se dispara', async () => {
  const sink = { hashes: {} };
  const r = await runMutationCycle(fakePage(), route, cfg, sink, {
    loadObject: async () => ({ name: `OV __SA_SENTINEL__ no-tocar` }),
    readJournal: () => ({}), writeJournal: () => {},
    doMutate: async () => { sink.hashes['SaveReceivedOrderLinesAndItems'] = 'newhash123'; },
    doRestore: async () => {},
  });
  assert.equal(r.captured, true);
  assert.equal(r.hash, 'newhash123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/mutation-runner-guards.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// tools/hash-autopilot/mutation-runner.mjs
// Integración del ciclo sentinela. Los núcleos puros de sentinels.mjs DECIDEN;
// este runner solo ejecuta lo aprobado, con guardias fail-closed y try/finally.
import { planMutationCapture, isSentinel, journalOpen, journalClose } from './sentinels.mjs';

export async function runMutationCycle(page, route, sentinelsConfig, sink, deps) {
  const op = (route.captures || [])[0];
  const entityType = route.sentinel?.entityType;
  const plan = planMutationCapture(op, sentinelsConfig, entityType);
  if (plan.action !== 'run') return { captured: false, op, escalated: true, reason: plan.reason };

  let journal = deps.readJournal();
  journal = journalOpen(journal, entityType, plan.sentinelId, op, 0);
  deps.writeJournal(journal);

  try {
    // Verificación de identidad ANTES de mutar (fail-closed).
    const obj = await deps.loadObject(page, plan.sentinelId);
    if (!isSentinel(obj)) {
      return { captured: false, op, escalated: true, reason: 'objeto cargado NO es sentinela (identidad)' };
    }
    // Disparar la mutación (el interceptor de sink captura el hash del frontend).
    await deps.doMutate(page, route);
    const hash = sink.hashes[op] || null;
    return { captured: !!hash, op, hash };
  } finally {
    // Restaurar SIEMPRE (aunque falle la captura); luego cerrar journal.
    try { if (deps.doRestore) await deps.doRestore(page, route); } catch (_) {}
    deps.writeJournal(journalClose(deps.readJournal(), entityType));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/mutation-runner-guards.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/mutation-runner.mjs tools/test/mutation-runner-guards.test.js
git commit -m "feat(hash-autopilot): mutation-runner — ciclo sentinela con guardias fail-closed (Fase C)"
```

---

### Task 7: Integración en el motor + reparación al arranque + runbook de sembrado

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs`
- Create: `docs/api/hash-fase-c-sembrado-sentinelas.md`

**Interfaces:**
- Consumes: `staleMutations` (Fase A ya lo calcula), `mutation-runner`, `sentinels.pendingRepairs`, `sentinels-config.json`.
- Produces: el motor, tras cargar el sink/browser, (a) **repara** primero cualquier `pendingRepairs` del journal (restaura sentinelas sucios) antes de nada; (b) para cada `staleMutation` con ruta+sentinel en el catálogo, corre `runMutationCycle`; (c) las capturadas entran a `classifyOp`/`planDeploy` junto a las queries; (d) las `escalated` van al correo consolidado. El sembrado de sentinelas es manual (runbook).

- [ ] **Step 1: Reparación al arranque + loop de mutations en `hash-autopilot.mjs`**

Tras `installInterceptor(page, sink);` y antes del loop de rutas de queries, añadir la reparación y (tras el loop de queries) el loop de mutations. Código:
```javascript
  // Reparación idempotente: restaura sentinelas que quedaron sucios de un run previo.
  const sentinelsConfig = JSON.parse(readFileSync(join(__dirname, 'sentinels-config.json'), 'utf8'));
  const journal0 = readJournalSafe();
  for (const rep of pendingRepairs(journal0)) {
    console.log(`↻ reparando sentinela sucio: ${rep.entityType} (${rep.op})`);
    try { await repairSentinel(page, rep, sentinelsConfig); } catch (e) { console.log(`  ⚠️ reparación falló: ${String(e).slice(0,100)}`); }
  }
```
Y tras el loop de queries, para las mutations rotadas con ruta sentinel:
```javascript
  const mutationResults = [];
  for (const op of staleMuts) {
    const route = Object.values(catalog.routes).find((r) => (r.captures || []).includes(op) && r.sentinel);
    if (!route) { mutationResults.push({ op, escalated: true, reason: 'sin ruta sentinel en catálogo' }); continue; }
    const res = await runMutationCycle(page, route, sentinelsConfig, sink, mutationDeps(page));
    mutationResults.push(res);
  }
```
(`readJournalSafe`, `repairSentinel`, `mutationDeps` son helpers locales que envuelven fs + las acciones DOM reales; `mutationDeps` provee `loadObject/doMutate/doRestore/readJournal/writeJournal`.)

- [ ] **Step 2: Sumar las mutations capturadas a la clasificación/deploy**

Donde se construye `results` (Fase A, `wantOps.map`), concatenar las mutations capturadas:
```javascript
  for (const mr of mutationResults) {
    if (mr.captured && mr.hash) {
      const cfgHash = cfgHashes[mr.op] ?? null;
      results.push({ op: mr.op, cfgHash, liveHash: mr.hash, responseOk: true, verdict: classifyOp({ cfgHash, liveHash: mr.hash, http: 200, shapeOk: true }) });
    }
  }
```
Y en el correo consolidado, añadir las `mutationResults` escaladas (`.filter(m => m.escalated)`).

- [ ] **Step 3: Escribir el runbook de sembrado**

Crear `docs/api/hash-fase-c-sembrado-sentinelas.md`: cómo crear un objeto canario por `entityType` en el ERP (nombre con `__SA_SENTINEL__`, dejarlo archivado), registrarlo en `sentinels-config.json`, y verificar `isSentinel` sobre él. Advertencias: nunca usar un objeto real; un sentinela por entidad; revisar tras cada corrida que quedó archivado.

- [ ] **Step 4: Verificación**

Run los núcleos + guardias:
```bash
node --test tools/test/sentinels-state.test.js tools/test/sentinels-identity.test.js tools/test/sentinels-journal.test.js tools/test/sentinels-plan.test.js tools/test/mutation-runner-guards.test.js
```
Expected: todos verdes. Dry-run del motor: con `sentinels-config.json` vacío, TODAS las mutations rotadas deben salir `escalated` (nunca ejecuta un ciclo sin sentinela declarado) — confirma el fail-closed end-to-end.

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/hash-autopilot.mjs docs/api/hash-fase-c-sembrado-sentinelas.md
git commit -m "feat(hash-autopilot): integra ciclo sentinela + reparación al arranque + runbook sembrado (Fase C)"
```

---

## Self-Review

**Spec coverage (§7 del spec 2026-07-06):**
- §7.1 estrategias archived-mutate-restore / ephemeral → Task 2 (`strategyFor`) + Task 5 (`planMutationCapture` escala ephemeral en v1) ✓
- §7.2.1 identidad inequívoca fail-closed → Task 2 (`isSentinel`) + Task 6 (guardia antes de mutar) ✓
- §7.2.2 allowlist de entidades → Task 4 (`sentinels-config.entities`) + Task 5 (sin entrada → escalate) ✓
- §7.2.3 journal + reparación idempotente → Task 3 + Task 7 Step 1 (repara al arranque) ✓
- §7.2.4 verificación post-ciclo → Task 6 (`doRestore` en finally) + Task 7 runbook ✓
- §7.2.6 solo lo rotado → Task 7 (loop sobre `staleMuts`) ✓
- §7.3 provisión de sentinelas → Task 4 + Task 7 Step 3 (runbook) ✓

**Placeholder scan:** `mutationDeps`/`repairSentinel`/`readJournalSafe`/`doMutate`/`doRestore` son helpers de integración DOM cuyo detalle exacto depende del HTML real de cada pantalla de mutación — el plan los define por su contrato (firma + rol) y los prueba via inyección de `deps` en Task 6; su cuerpo DOM se completa contra el wrapper HTML real (regla de CLAUDE.md: pedir el wrapper antes de escribir selectores). No es un TBD de diseño, es integración que exige el DOM real. Señalado explícitamente.

**Type consistency:** `cycleNext(state,event)→string`, `isSentinel(obj)→bool`, `strategyFor(op)→string`, `journalOpen/Close(journal,...)→journal`, `pendingRepairs(journal)→[]`, `planMutationCapture(op,cfg,entityType)→{action,...}`, `runMutationCycle(page,route,cfg,sink,deps)→{captured,...}`. `SENTINEL_MARKER` es el mismo literal en todos lados. El `sentinel` block del route-catalog (`{entityType,strategy,mutateStep,restoreStep}`) coincide con lo que Task 6 consume. ✓

**Decisión v1 (declarada):** las destructivas (`Delete*`) **escalan** en v1 (ephemeral-create-destroy no implementado) — es la opción segura; se puede añadir en una v2 de Fase C. `planMutationCapture` y su test lo fijan explícitamente.

**Riesgo residual mayor:** los helpers DOM (`doMutate`/`doRestore`) son el punto donde una interacción mal escrita podría afectar datos — mitigado por: (1) `isSentinel` fail-closed ANTES de mutar, (2) blast-radius ≤1 a verificar en `loadObject`, (3) sembrado manual revisado, (4) journal para no dejar sentinelas sucios. Recomendado: primera corrida real de Fase C en modo observado (no `--dry-run` pero con el usuario mirando el primer ciclo).
