# Fase C del hash-autopilot — captura headless de mutations por ciclo sentinela

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development o superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan checkbox (`- [ ]`).

**Goal:** Que el motor del hash-autopilot capture y deploye los hashes de mutations rotadas ejecutando ciclos sentinela headless (abrir objeto de prueba → mutar → capturar hash → restaurar), integrado al reporte de un solo correo, sin tocar datos reales.

**Architecture:** El núcleo puro `sentinels.mjs` (máquina de estados, `isSentinel` fail-closed, journal) y el orquestador `mutation-runner.mjs` (`runMutationCycle` con try/finally) ya existen. Falta: (1) un `sentinelsConfig` con los IDs de los sentinelas del usuario; (2) los `deps` headless (`loadObject`/`doMutate`/`doRestore`) por mutación, escritos con el HTML real de cada pantalla; (3) el loop de mutations + reparación en `hash-autopilot.mjs`. Se implementa **una mutación a la vez**, cada una validada en corrida supervisada antes de la siguiente.

**Tech Stack:** Node ESM (`.mjs`), Playwright (navegador headless, ya usado para queries), `node:test` para los núcleos puros, el mismo `autopilot-deploy.sh`/`autopilot-notify.sh` del motor.

## Global Constraints

- Fail-closed absoluto: el runner **nunca** muta si `isSentinel(obj)` es false. La verificación es **doble**: el `sentinelId` viene de config Y el objeto cargado debe pasar `isSentinel`.
- Marcador de sentinela: el nombre del objeto **contiene la palabra "Sentinela"** (decisión del usuario). Se amplía `isSentinel` para reconocerla, además del `__SA_SENTINEL__` existente.
- `doRestore` corre **siempre** (bloque `finally`), aunque la captura falle.
- Blast-radius ≤ 1: un ciclo toca **un** objeto sentinela por vez; el journal bloquea ciclos concurrentes de la misma entidad.
- Sin activar el launchd hasta que cada mutación pase una **corrida supervisada** (el usuario observando) en vivo.
- Un solo correo: los resultados de mutations se integran al reporte consolidado ya existente (secciones `✅ corregidas` / `🔧 mutations`), no se manda un correo aparte.
- `apolloClientVersion` y hashes viven en `remote/config.json`; el deploy usa `autopilot-deploy.sh` (bump + gh-pages + push).

---

## File Structure

- `tools/hash-autopilot/sentinels.mjs` (modificar) — ampliar `isSentinel` para "Sentinela"; añadir estrategia `create-capture-cleanup` para mutations `Create*`.
- `tools/hash-autopilot/sentinels-config.json` (crear) — IDs y entityType de los sentinelas del usuario. Fuera del código (datos).
- `tools/hash-autopilot/mutation-deps.mjs` (crear) — implementación headless de `loadObject`/`doMutate`/`doRestore` por entityType, con Playwright. Un archivo por responsabilidad DOM.
- `tools/hash-autopilot/mutation-runner.mjs` (modificar mínimamente si hace falta soportar `create-capture-cleanup`).
- `tools/hash-autopilot/hash-autopilot.mjs` (modificar) — reparación de journal al inicio; loop que corre `runMutationCycle` por cada mutation stale con ruta+sentinela; alimentar `plan.toDeploy` con los hashes de mutation capturados.
- `tools/test/sentinels-identity.test.js` (modificar) — casos del marcador "Sentinela".
- `tools/test/sentinels-strategy.test.js` (crear) — `strategyFor`/`planMutationCapture` para `Create*`.
- `tools/test/mutation-deps.test.js` (crear) — `doMutate`/`doRestore` con una `page` fake (sin ERP real).

---

## Fase C.0 — Infraestructura (sin ejecutar mutations reales)

### Task 1: Marcador "Sentinela" en `isSentinel`

**Files:**
- Modify: `tools/hash-autopilot/sentinels.mjs:26-38`
- Test: `tools/test/sentinels-identity.test.js`

**Interfaces:**
- Produces: `isSentinel(obj) → bool` — ahora true también si un nombre/tag/customInput contiene `"Sentinela"` (case-insensitive), además de `__SA_SENTINEL__`.

- [ ] **Step 1: Test que falla** — añadir a `sentinels-identity.test.js`:
```javascript
test('isSentinel: reconoce la palabra "Sentinela" en el nombre (marcador del usuario)', () => {
  assert.equal(isSentinel({ name: 'PN Sentinela QA' }), true);
  assert.equal(isSentinel({ name: 'sentinela' }), true);       // case-insensitive
  assert.equal(isSentinel({ name: 'Cliente Real 123' }), false);
  assert.equal(isSentinel(null), false);                        // fail-closed
});
```
- [ ] **Step 2: Correr y ver fallar** — `node --test tools/test/sentinels-identity.test.js` → FAIL en el caso "Sentinela".
- [ ] **Step 3: Implementar** — en `sentinels.mjs`, cambiar el helper `hay`:
```javascript
export function isSentinel(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const hay = (s) => typeof s === 'string' && (s.includes(SENTINEL_MARKER) || /sentinela/i.test(s));
  if (hay(obj.name) || hay(obj.displayName)) return true;
  if (Array.isArray(obj.tags) && obj.tags.some(hay)) return true;
  if (obj.customInputs && typeof obj.customInputs === 'object') {
    for (const v of Object.values(obj.customInputs)) {
      if (hay(v)) return true;
      if (v && typeof v === 'object') for (const vv of Object.values(v)) if (hay(vv)) return true;
    }
  }
  return false;
}
```
- [ ] **Step 4: Correr y ver pasar** — `node --test tools/test/sentinels-identity.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add tools/hash-autopilot/sentinels.mjs tools/test/sentinels-identity.test.js && git commit -m "feat(sentinels): isSentinel reconoce el marcador 'Sentinela'"`

### Task 2: `sentinels-config.json` con los sentinelas del usuario

**Files:**
- Create: `tools/hash-autopilot/sentinels-config.json`

**Interfaces:**
- Produces: JSON `{ entities: { <entityType>: { id, screenPath, marker } } }` que `planMutationCapture` lee vía `sentinelsConfig.entities[entityType]`.

- [ ] **Step 1: Crear el archivo** con los sentinelas que el usuario confirme (IDs reales). Estructura de ejemplo (reemplazar IDs por los reales antes de correr):
```json
{
  "_doc": "Objetos de prueba (nombre contiene 'Sentinela') sobre los que el autopilot ejecuta ciclos de captura de mutations. NUNCA apuntar a datos reales.",
  "entities": {
    "partNumber": { "id": 0, "screenPath": "/Domains/{domain}/PartNumbers/{id}", "marker": "Sentinela" },
    "quote":      { "id": 0, "screenPath": "/Domains/{domain}/Quotes/{id}", "marker": "Sentinela" },
    "maintenanceNode": { "id": 0, "screenPath": "/Maintenance/Nodes/{id}", "marker": "Sentinela", "archived": true, "opsGroup": ["CreateMaintenanceEvent", "CreateMaintenanceEventComment", "UpdateMaintenanceEvent"], "_pendiente": "crear nodo sentinela dedicado ARCHIVADO (ciclo anidado — ver Fase C.5)" }
  }
}
```
- [ ] **Step 2: Validar JSON** — `node -e "JSON.parse(require('fs').readFileSync('tools/hash-autopilot/sentinels-config.json'))" && echo ok`
- [ ] **Step 3: Commit** — `git add tools/hash-autopilot/sentinels-config.json && git commit -m "feat(hash-autopilot): sentinels-config con IDs de objetos sentinela"`

> **Prerequisito de datos:** el usuario provee los `id` reales de cada sentinela. Para `maintenanceNode`, primero crear un nodo dedicado con "Sentinela" en el nombre (el scan previo usó uno existente).

### Task 3: Reparación de journal al inicio del motor

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs` (al arranque de la corrida, antes de capturar)
- Test: `tools/test/sentinels-journal.test.js` (ya existe — verificar `pendingRepairs`)

**Interfaces:**
- Consumes: `pendingRepairs(journal) → [{entityType, sentinelId, op}]` de `sentinels.mjs`.
- Produces: si hay ciclos sucios de una corrida previa interrumpida, el motor los restaura (o escala) ANTES de abrir nuevos ciclos.

- [ ] **Step 1: Test que falla** — en `sentinels-journal.test.js`, confirmar que `pendingRepairs` lista entradas no-`base`:
```javascript
test('pendingRepairs: lista ciclos sucios pendientes de reparar', () => {
  const j = { partNumber: { state: 'dirty', sentinelId: 5, op: 'UpdatePartNumber' } };
  assert.deepEqual(pendingRepairs(j), [{ entityType: 'partNumber', sentinelId: 5, op: 'UpdatePartNumber' }]);
});
```
- [ ] **Step 2: Correr y ver pasar/fallar** — `node --test tools/test/sentinels-journal.test.js`.
- [ ] **Step 3: Implementar en el motor** — al inicio de la corrida (tras cargar `page`), leer el journal; para cada `pendingRepairs`, intentar `doRestore` con los deps; si falla, escalar esa entidad (añadir a la sección `🔧` del reporte) y NO abrir ciclos nuevos de esa entidad.
- [ ] **Step 4: Commit** — `git add tools/hash-autopilot/hash-autopilot.mjs && git commit -m "feat(hash-autopilot): repara ciclos sentinela sucios al inicio"`

---

## Fase C.1 — Primera mutación: `UpdatePartNumber` (archived-mutate-restore)

> **PREREQUISITO (obligatorio antes de escribir código DOM):** pedir al usuario el **wrapper HTML completo** de la pantalla de edición de un PartNumber (el bloque que contiene el campo editable + el botón Guardar). Sin ese HTML no se escriben selectores (regla del CLAUDE.md). El `doMutate` hace un cambio **idempotente y reversible** (p. ej. togglear un campo de texto a un valor conocido y de vuelta).

### Task 4: `deps` de `partNumber` en `mutation-deps.mjs`

**Files:**
- Create: `tools/hash-autopilot/mutation-deps.mjs`
- Test: `tools/test/mutation-deps.test.js`

**Interfaces:**
- Produces: `makeDeps(sentinelsConfig, sink) → { readJournal, writeJournal, loadObject, doMutate, doRestore }` consumido por `runMutationCycle`.
  - `loadObject(page, sentinelId) → obj` — navega a `screenPath`, extrae `{name, ...}` para `isSentinel`.
  - `doMutate(page, route)` — hace el cambio reversible en la UI (dispara la mutation; el `sink` de Playwright captura el hash).
  - `doRestore(page, route)` — deshace el cambio (vuelve al valor original).

- [ ] **Step 1: Test con `page` fake** (sin ERP) — `mutation-deps.test.js`:
```javascript
test('loadObject: extrae el objeto para verificación de identidad', async () => {
  const page = { goto: async () => {}, evaluate: async () => ({ name: 'PN Sentinela QA', id: 42 }) };
  const deps = makeDeps({ entities: { partNumber: { id: 42, screenPath: '/x/{id}' } } }, { hashes: {} });
  const obj = await deps.loadObject(page, 42);
  assert.equal(obj.name, 'PN Sentinela QA');
});
```
- [ ] **Step 2: Correr y ver fallar** — `node --test tools/test/mutation-deps.test.js` → FAIL (makeDeps no existe).
- [ ] **Step 3: Implementar `makeDeps`** con `readJournal`/`writeJournal` (leyendo/escribiendo `tools/hash-autopilot/.state/journal.json`), `loadObject` (goto + evaluate extrayendo el nombre del DOM — **selectores del HTML que provea el usuario**), `doMutate`/`doRestore` para `partNumber` (togglear un campo reversible — **con el HTML real**).
- [ ] **Step 4: Correr y ver pasar** — `node --test tools/test/mutation-deps.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add tools/hash-autopilot/mutation-deps.mjs tools/test/mutation-deps.test.js && git commit -m "feat(hash-autopilot): deps headless de partNumber (loadObject/doMutate/doRestore)"`

### Task 5: Loop de mutations en el motor + `UpdatePartNumber` en dry-run

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs`

**Interfaces:**
- Consumes: `runMutationCycle(page, route, sentinelsConfig, sink, deps)`, `staleMutations(validatorResult)`, `route.sentinel.entityType`.
- Produces: por cada mutation stale con ruta+sentinela, un `{op, hash, captured}`; los capturados se suman a `plan.toDeploy` (mismo pipeline de deploy que las queries).

- [ ] **Step 1:** Añadir `route.sentinel = { entityType: 'partNumber' }` a la ruta de `UpdatePartNumber` en `route-catalog.json` (o mapa op→entityType en config).
- [ ] **Step 2: Implementar el loop** — tras las queries: para cada `op` en `staleMuts` que tenga sentinela declarado, correr `runMutationCycle`; acumular resultados. En `--dry-run`, NO deployar ni mutar de verdad (solo loguear el plan).
- [ ] **Step 3: Correr dry-run** — `node hash-autopilot.mjs --dry-run` → debe listar `UpdatePartNumber` como candidata a ciclo sin ejecutar nada. Expected: log "ciclo planeado (dry): UpdatePartNumber sobre sentinela partNumber #<id>".
- [ ] **Step 4: Commit** — `git add ... && git commit -m "feat(hash-autopilot): loop de mutations (dry-run) integrado al motor"`

### Task 6: Corrida SUPERVISADA de `UpdatePartNumber` (no launchd)

- [ ] **Step 1:** Con el usuario observando, correr `node hash-autopilot.mjs` (no dry) **solo** con `UpdatePartNumber` habilitada (las demás mutations aún escalan).
- [ ] **Step 2:** Verificar en el ERP que el PN sentinela quedó **restaurado** (valor original) y que se capturó el hash. Confirmar el diff de `config.json` = solo `UpdatePartNumber`.
- [ ] **Step 3:** Si el hash capturado ≠ config → deploy vía `autopilot-deploy.sh`. Verificar `tools/deploy-status.sh`.
- [ ] **Step 4:** Confirmar el correo consolidado incluye `UpdatePartNumber` en `✅ corregidas`.

---

## Fase C.2 — `UpdateQuote` (archived-mutate-restore)

Repite Fase C.1 para la entidad `quote`:
- [ ] **Task 7:** Pedir el wrapper HTML de la edición de una cotización → implementar `doMutate`/`doRestore` de `quote` en `mutation-deps.mjs` (mismo patrón que `partNumber`, valor reversible) + test con `page` fake.
- [ ] **Task 8:** `route.sentinel = { entityType: 'quote' }` para `UpdateQuote`; dry-run; corrida supervisada; verificar restauración + deploy + correo.

---

## Fase C.3 — `CreateReceivedOrder` (create-capture-cleanup, estrategia nueva)

> `Create*` NO encaja en archived-mutate-restore: crea un objeto nuevo en vez de mutar uno existente. Se añade la estrategia `create-capture-cleanup`: crear → capturar hash → **archivar/borrar** el objeto creado. La limpieza (archivar la OV creada) es el "restore".

### Task 9: Estrategia `create-capture-cleanup` en `sentinels.mjs`

**Files:**
- Modify: `tools/hash-autopilot/sentinels.mjs:42-82`
- Test: `tools/test/sentinels-strategy.test.js` (crear)

**Interfaces:**
- Produces: `strategyFor('CreateReceivedOrder') → 'create-capture-cleanup'`; `planMutationCapture` con `action:'run'` para esa estrategia si hay sentinela (aquí el "sentinela" es la config de la OV de prueba a crear + cómo limpiarla).

- [ ] **Step 1: Test que falla** — `sentinels-strategy.test.js`:
```javascript
test('strategyFor: Create* → create-capture-cleanup', () => {
  assert.equal(strategyFor('CreateReceivedOrder'), 'create-capture-cleanup');
});
test('planMutationCapture: create-capture-cleanup corre si hay entidad', () => {
  const cfg = { entities: { receivedOrder: { id: 0, createTemplate: {} } } };
  assert.equal(planMutationCapture('CreateReceivedOrder', cfg, 'receivedOrder').action, 'run');
});
```
- [ ] **Step 2: Correr y ver fallar** — `node --test tools/test/sentinels-strategy.test.js`.
- [ ] **Step 3: Implementar** — en `strategyFor`, mover `Create` a `create-capture-cleanup`; en `planMutationCapture`, aceptar esa estrategia (ya no escalar `Create`).
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit.**

### Task 10: `deps` de `receivedOrder` + limpieza

- [ ] **Task 10:** Con el HTML del flujo de crear OV: `doMutate` crea una OV de prueba (marcada "Sentinela"); `doRestore` la **archiva/borra**. Test con `page` fake. Corrida supervisada: verificar que la OV creada quedó archivada (no en producción activa) + hash capturado + deploy + correo.

---

## Fase C.5 — Nodo de mantenimiento (ciclo anidado "desarchivar-padre")

> **Aclaración del usuario:** el nodo de mantenimiento **"Sentinela" vive ARCHIVADO**, y su ciclo es de **dos niveles**: `desarchivar el nodo → crear el evento → crear comentarios / actualizar el evento → archivar el evento → archivar el nodo`. Es la estrategia más rica: captura **varias mutations en un solo ciclo** (`CreateMaintenanceEvent`, `CreateMaintenanceEventComment`, `UpdateMaintenanceEvent`), y todo lo creado (evento) + el objeto padre (nodo) vuelven a estado archivado.

> **PREREQUISITO:** crear un **nodo de mantenimiento dedicado** con "Sentinela" en el nombre y dejarlo **archivado**. (El scan manual previo usó un nodo existente; para automatizar se necesita uno sentinela propio, desechable.)

### Task 12: Estrategia `nested-unarchive` en `sentinels.mjs`

**Files:**
- Modify: `tools/hash-autopilot/sentinels.mjs`
- Test: `tools/test/sentinels-strategy.test.js`

**Interfaces:**
- Produces: `strategyFor` reconoce el grupo de mantenimiento como `nested-unarchive`; `planMutationCapture` acepta un **grupo** de ops (`opsGroup`) bajo un padre archivado, devolviendo `{action:'run', strategy:'nested-unarchive', parentId, ops}`.

- [ ] **Step 1: Test que falla** — en `sentinels-strategy.test.js`:
```javascript
test('planMutationCapture: grupo de mantenimiento → nested-unarchive', () => {
  const cfg = { entities: { maintenanceNode: { id: 0, opsGroup: ['CreateMaintenanceEvent','CreateMaintenanceEventComment','UpdateMaintenanceEvent'] } } };
  const p = planMutationCapture('CreateMaintenanceEvent', cfg, 'maintenanceNode');
  assert.equal(p.strategy, 'nested-unarchive');
  assert.deepEqual(p.ops, ['CreateMaintenanceEvent','CreateMaintenanceEventComment','UpdateMaintenanceEvent']);
});
```
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar** — en `planMutationCapture`, si la entidad declara `opsGroup`, devolver `{action:'run', strategy:'nested-unarchive', entityType, parentId: ent.id, ops: ent.opsGroup}`.
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit.**

### Task 13: deps de mantenimiento (ciclo anidado, orden inverso al restaurar)

**Files:**
- Modify: `tools/hash-autopilot/mutation-deps.mjs`
- Modify: `tools/hash-autopilot/mutation-runner.mjs` (soportar `nested-unarchive`: capturar múltiples ops en un ciclo)
- Test: `tools/test/mutation-deps.test.js`

**Interfaces:**
- `loadObject(page, parentId) → nodo` — verificar `isSentinel` (nombre "Sentinela").
- `doMutate` (nested): `unarchiveNode(parentId) → createEvent → createComment → updateEvent`, capturando del `sink` los hashes de las 3 ops.
- `doRestore` (nested, **orden inverso, SIEMPRE en finally**): `archiveEvent → archiveNode`.

- [ ] **Step 1: Test con `page` fake** — el ciclo desarchiva, crea, y al final deja llamadas de `archiveEvent`+`archiveNode` registradas:
```javascript
test('doMutate/doRestore de mantenimiento: desarchiva, opera, y restaura en orden inverso', async () => {
  const calls = [];
  const page = { goto: async () => {}, evaluate: async () => ({ name: 'Nodo Sentinela' }),
    click: async (sel) => calls.push(sel) };
  // ... makeDeps con la entidad maintenanceNode; correr doMutate luego doRestore
  // assert: calls incluye unarchive antes de create, y archiveEvent antes de archiveNode en restore
});
```
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar** con el **HTML real** del flujo de mantenimiento (desarchivar nodo, crear evento, comentar, actualizar, archivar evento, archivar nodo). `doRestore` archiva evento y nodo en `finally`, en orden inverso a la creación.
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Corrida SUPERVISADA** — verificar en el ERP que el nodo Y el evento quedaron **archivados** al final, y que se capturaron los 3 hashes. Deploy de los que difieran + correo consolidado.
- [ ] **Step 6: Commit.**

## Fase C.4 — Activación al launchd

### Task 11: Habilitar Fase C en el ciclo automático

- [ ] **Step 1:** Solo tras C.1–C.3 supervisadas exitosas: quitar el gate manual, permitir que el launchd corra el loop de mutations con todas las entidades declaradas.
- [ ] **Step 2:** Primera corrida automática **monitoreada** (revisar el correo + `deploy-status.sh` + estado de los sentinelas).
- [ ] **Step 3:** Documentar en `docs/applets/hash-scanner.md` / bitácora del autopilot: estrategias soportadas, sentinelas, cómo añadir una mutation nueva.
- [ ] **Step 4: Commit** de la doc.

---

## Notas de seguridad (recordatorio permanente)

- Ninguna mutación corre sin: sentinela declarado en config **y** `isSentinel(obj)` true tras cargar el objeto real.
- `doRestore` en `finally` — el objeto vuelve a su estado aunque falle la captura.
- El journal bloquea ciclos concurrentes y permite reparar una corrida interrumpida.
- Destructivas puras (`Delete*`) siguen escalando (no auto) — fuera de alcance de este plan.
- Cada mutación se valida supervisada antes de confiarla al launchd.
