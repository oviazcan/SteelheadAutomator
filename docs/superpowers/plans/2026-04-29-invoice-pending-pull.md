# Pull activo de facturas pendientes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el detector pasivo (`pendingByInvoiceId` Map que solo crece) por un pull activo que consulta `ActiveInvoicesPaged` con filtro de 7 días y evalúa `needsRegen()` por nodo en cada render del banner.

**Architecture:** Mantener el interceptor de `fetch` para (1) capturar `sha256Hash` y (2) snapshotear variables de `ActiveInvoicesPaged` como template. Agregar `pullPendingCount()` que reusa `_callOp` + paginación con guardrails. Banner consume `lastPullResult` (snapshot fresco, no acumulado). Triggers: init, post-regen, visibilitychange, e interceptor reactivo (todos con throttle salvo post-regen).

**Tech Stack:** JavaScript vanilla en `remote/scripts/invoice-auto-regen.js`. Sin tests automatizados — verificación es manual contra Steelhead UI con apoyo de `console.log` y `window.regenState()`.

**Spec de referencia:** `docs/superpowers/specs/2026-04-29-invoice-pending-pull-design.md`

---

## Task 1: Aprendizaje pasivo de variables de `ActiveInvoicesPaged`

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:111-194` (función `patchFetch`, dentro del interceptor)

**Contexto:** El interceptor ya pasa `bodyObj` para cada request GraphQL. Vamos a cachear el último `variables` observado para `ActiveInvoicesPaged` así `pullPendingCount` (Task 4) tiene un template real para hacer su propio request.

- [ ] **Step 1.1: Agregar el snapshot de variables**

En `patchFetch`, después del bloque que captura el hash (líneas 121-125, donde dice `if (opName && _h) { hashRegistry.set(opName, _h); ... }`), agregar:

```js
// Snapshot de variables de ActiveInvoicesPaged como template para pullPendingCount.
// Se sobreescribe en cada pasada — siempre queremos el template más reciente.
if (opName === 'ActiveInvoicesPaged' && bodyObj?.variables) {
  try {
    window.__autoRegenLastVars = window.__autoRegenLastVars || {};
    // Deep-clone para no compartir referencia con el body del UI
    window.__autoRegenLastVars.ActiveInvoicesPaged = JSON.parse(JSON.stringify(bodyObj.variables));
  } catch (_) { /* shape rara — ignorar */ }
}
```

- [ ] **Step 1.2: Verificar manualmente**

Cargar la extensión, abrir el dashboard de Invoices en Steelhead, abrir DevTools y ejecutar:

```js
window.__autoRegenLastVars?.ActiveInvoicesPaged
```

Expected: un objeto con campos como `pageNumber`, `pageSize`, posiblemente `searchTerm`, `customerId`, `dateFrom`/`writtenAtFrom`, etc.

- [ ] **Step 1.3: Documentar el shape observado**

Una vez visto el shape real, anotarlo en este plan como comentario para Task 4 (qué campos son de filtro de fecha, paginación, etc.). Pegar en este archivo bajo "Shape observado de ActiveInvoicesPaged" para que Task 4 lo use:

```markdown
**Shape observado de ActiveInvoicesPaged:** (pegar aquí lo visto en consola)
```

- [ ] **Step 1.4: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "feat(invoice-auto-regen): snapshot del template de variables de ActiveInvoicesPaged"
```

---

## Task 2: Reducir TTL de `recentlyRegenerated` 24h → 3 min

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:31-32` (constantes RECENT_KEY/RECENT_TTL_MS)

- [ ] **Step 2.1: Cambiar la constante**

Buscar la línea:

```js
const RECENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
```

Reemplazar por:

```js
const RECENT_TTL_MS = 3 * 60 * 1000; // 3 min — solo cubre eventual consistency post-regen
```

- [ ] **Step 2.2: Verificar manualmente**

Cargar la extensión, ejecutar en consola:

```js
localStorage.getItem('sa_autoregen_recently_regenerated')
```

Expected: si había entradas de la sesión anterior, después del próximo `_hydrateRecent()` (que ocurre en `init`) quedan purgadas las que tengan timestamp > 3 min. Si todas son frescas, se mantienen.

- [ ] **Step 2.3: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "fix(invoice-auto-regen): TTL de recentlyRegenerated 24h → 3 min"
```

---

## Task 3: Estado del pull activo (variables de módulo, sin acumular)

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:25-33` (después del bloque de comentario "── Estado ──", antes de `recentlyRegenerated`)

**Contexto:** Estas variables sustituyen a `pendingByInvoiceId`. Se sobreescriben, no se acumulan. Se agregan ahora; el Map viejo se elimina en Task 5 una vez que el resto del código apunta al nuevo estado.

- [ ] **Step 3.1: Agregar variables del pull**

Después del comentario `// ── Estado ──` (línea 25) y antes de `// pendientes que el detector ha visto en esta sesión...`, agregar:

```js
// Resultado del último pull activo. Se sobreescribe cada vez — NO se acumula.
// El banner y startRun leen de aquí. null = "todavía no hay info" o "degraded".
let lastPullResult = null;        // Array<{invoiceId, idInDomain}> | null
let lastPullAt = 0;               // ms epoch del último pull exitoso
let _pullInFlight = null;         // Promise compartido para evitar pulls concurrentes
let _pullDegraded = false;        // true tras 3 fallos consecutivos
let _pullConsecFailures = 0;
const PULL_THROTTLE_MS = 30 * 1000;
const PULL_WINDOW_DAYS = 7;
const PULL_PAGE_SIZE = 50;
const PULL_MAX_PAGES = 5;
```

- [ ] **Step 3.2: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "feat(invoice-auto-regen): variables de estado del pull activo"
```

---

## Task 4: Implementar `pullPendingCount()`

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js` (insertar nueva función después de `_callOp`, sobre la línea 564)

**Contexto:** Esta es la función central. Toma el template de `window.__autoRegenLastVars.ActiveInvoicesPaged` (capturado en Task 1), pagina con filtro de 7 días, evalúa `needsRegen()` por nodo, filtra los que están en `recentlyRegenerated`, y actualiza `lastPullResult`/`lastPullAt`/`_pullDegraded`.

**Decisión sobre filtro de fecha:** después de Task 1.2 sabremos qué nombre tiene el campo de filtro server-side (si existe). Si el shape muestra `writtenAtFrom`, `dateFrom`, `from`, o similar, lo usamos. Si no hay ningún campo de fecha, el fallback es paginar ordenando por `writtenAt DESC` y cortar cuando un nodo cae bajo el cutoff.

- [ ] **Step 4.1: Helper para detectar nombre del campo de filtro de fecha**

Insertar antes de `pullPendingCount`:

```js
// Inspecciona el template para encontrar el nombre del campo de filtro "desde".
// Devuelve el nombre del campo o null si no existe.
function _detectDateFromField(template) {
  if (!template || typeof template !== 'object') return null;
  const candidates = ['writtenAtFrom', 'writtenAtStart', 'dateFrom', 'fromDate', 'from', 'startDate'];
  for (const k of candidates) {
    if (k in template) return k;
  }
  // Búsqueda recursiva 1 nivel: a veces los filtros vienen anidados en {filter: {...}}
  for (const key of Object.keys(template)) {
    const v = template[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of candidates) {
        if (k in v) return `${key}.${k}`;
      }
    }
  }
  return null;
}

// Aplica un valor a una path tipo "filter.dateFrom" sobre un objeto.
function _setNestedField(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
```

- [ ] **Step 4.2: Helper para limpiar filtros del UI del template**

Insertar después de los helpers anteriores:

```js
// El template viene del UI con search/customer/etc. seleccionados por el usuario.
// Para nuestro pull global queremos esos filtros en blanco.
// Mutamos in-place sobre una copia.
function _sanitizeTemplate(template) {
  const t = JSON.parse(JSON.stringify(template));
  const fieldsToClear = ['searchTerm', 'search', 'customerId', 'customer', 'status', 'tags', 'tagIds'];
  // Top-level
  for (const k of fieldsToClear) {
    if (k in t) {
      const v = t[k];
      t[k] = (typeof v === 'string') ? '' : (Array.isArray(v) ? [] : null);
    }
  }
  // Anidado en `filter` u objeto similar (1 nivel)
  for (const key of Object.keys(t)) {
    const v = t[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of fieldsToClear) {
        if (k in v) {
          const vv = v[k];
          v[k] = (typeof vv === 'string') ? '' : (Array.isArray(vv) ? [] : null);
        }
      }
    }
  }
  return t;
}
```

- [ ] **Step 4.3: Implementar `pullPendingCount`**

Insertar después de los helpers:

```js
// Pulls actively from ActiveInvoicesPaged with a 7-day window. Evaluates needsRegen()
// per node and filters out recentlyRegenerated. Updates lastPullResult/lastPullAt.
// Coalesces concurrent calls via _pullInFlight.
async function pullPendingCount({ force = false } = {}) {
  if (_pullInFlight) return _pullInFlight;
  if (!force && Date.now() - lastPullAt < PULL_THROTTLE_MS && lastPullResult !== null) {
    return lastPullResult;
  }

  const template = window.__autoRegenLastVars?.ActiveInvoicesPaged;
  if (!template) {
    console.log('[AutoRegen] pullPendingCount: sin template aprendido todavía — esperando ActiveInvoicesPaged del UI');
    return null;
  }

  _pullInFlight = (async () => {
    const cutoffMs = Date.now() - PULL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const cutoffISO = new Date(cutoffMs).toISOString();
    const dateField = _detectDateFromField(template);
    const baseVars = _sanitizeTemplate(template);
    if (dateField) {
      _setNestedField(baseVars, dateField, cutoffISO);
    }

    const collected = [];
    let stoppedByCutoff = false;

    for (let page = 1; page <= PULL_MAX_PAGES; page++) {
      const vars = JSON.parse(JSON.stringify(baseVars));
      // Asignación tolerante: si template usa pageNumber/pageSize, los reescribimos;
      // si usa otros nombres comunes, también.
      if ('pageNumber' in vars) vars.pageNumber = page;
      else if ('page' in vars) vars.page = page;
      if ('pageSize' in vars) vars.pageSize = PULL_PAGE_SIZE;
      else if ('limit' in vars) vars.limit = PULL_PAGE_SIZE;

      let data;
      try {
        data = await _callOp('ActiveInvoicesPaged', vars);
      } catch (e) {
        throw new Error(`Page ${page}: ${e.message}`);
      }
      const nodes = data?.allInvoices?.nodes || [];
      if (nodes.length === 0) break;

      for (const inv of nodes) {
        // Sin filtro server-side de fecha: cortamos cuando vemos timbre bajo el cutoff.
        if (!dateField && inv?.steelheadObjectByInvoiceId?.writtenAt) {
          const wt = Date.parse(inv.steelheadObjectByInvoiceId.writtenAt);
          if (wt && wt < cutoffMs) { stoppedByCutoff = true; break; }
        }
        if (!needsRegen(inv)) continue;
        if (isRecentlyRegenerated(inv.id)) continue;
        collected.push({ invoiceId: inv.id, idInDomain: inv.idInDomain });
      }

      if (stoppedByCutoff) break;
      if (nodes.length < PULL_PAGE_SIZE) break;
    }

    return collected;
  })();

  try {
    const items = await _pullInFlight;
    lastPullResult = items;
    lastPullAt = Date.now();
    _pullConsecFailures = 0;
    if (_pullDegraded) {
      console.log('[AutoRegen] Recovery: pull volvió a funcionar — banner reactivado');
      _pullDegraded = false;
    }
    console.log(`[AutoRegen] pullPendingCount: ${items.length} pendientes (ventana ${PULL_WINDOW_DAYS}d)`);
    updateBanner();
    return items;
  } catch (e) {
    _pullConsecFailures++;
    const isHashDeprecated = /Must provide a query string|400/.test(e.message);
    console.warn(`[AutoRegen] pullPendingCount falló (${_pullConsecFailures}/3)${isHashDeprecated ? ' — posible deprecación de hash' : ''}:`, e.message);
    if (_pullConsecFailures >= 3) {
      _pullDegraded = true;
      lastPullResult = null;
      console.warn('[AutoRegen] 3 fallos consecutivos — banner oculto. Pull se reactiva al próximo ActiveInvoicesPaged exitoso del UI.');
      updateBanner();
    }
    return lastPullResult;
  } finally {
    _pullInFlight = null;
  }
}
```

- [ ] **Step 4.4: Verificar en consola**

Cargar la extensión, asegurarse de que el dashboard de Invoices ya disparó al menos un `ActiveInvoicesPaged` (template aprendido), y ejecutar:

```js
await InvoiceAutoRegen.pullPendingCount?.({ force: true })
```

Nota: si el método aún no está expuesto, ejecutar directamente con su nombre sobre el módulo. Para esta verificación, exponer temporalmente `pullPendingCount` en el `return` del IIFE (se confirma en Task 7).

Expected: array de `{invoiceId, idInDomain}` con las facturas que deberían aparecer; consola muestra `[AutoRegen] pullPendingCount: N pendientes (ventana 7d)`.

- [ ] **Step 4.5: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "feat(invoice-auto-regen): pullPendingCount con paginación + filtro de 7 días"
```

---

## Task 5: Eliminar `pendingByInvoiceId` y `recordPending`

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:27` (declaración del Map)
- Modify: `remote/scripts/invoice-auto-regen.js:180-187` (branch del interceptor que llama recordPending)
- Modify: `remote/scripts/invoice-auto-regen.js:242-257` (función recordPending)

- [ ] **Step 5.1: Eliminar la declaración del Map**

Borrar la línea:

```js
const pendingByInvoiceId = new Map(); // invoiceId → {invoiceId, idInDomain}
```

(y el comentario inmediato anterior que la describe)

- [ ] **Step 5.2: Reemplazar el branch del interceptor**

En `patchFetch`, dentro del `if (opName === 'ActiveInvoicesPaged' || opName === 'InvoiceByIdInDomain')` (línea 166), localizar el bloque:

```js
const items = (opName === 'ActiveInvoicesPaged') ? scanList(json) : scanSingle(json);
if (items.length > 0) {
  recordPending(items);
  // Si vino del modal abierto manualmente → auto-regen sin cerrar
  if (opName === 'InvoiceByIdInDomain') {
    autoRegenInOpenModal(items[0]);  // no await: corre en background
  }
}
```

Reemplazarlo por:

```js
if (opName === 'ActiveInvoicesPaged') {
  // Trigger reactivo (d): aprovechamos que el UI ya consultó el server.
  // No leemos los nodos directamente — disparamos pull propio (throttled, mismo
  // throttle del bucket) para tener visibilidad global más allá de la página actual.
  pullPendingCount();
} else if (opName === 'InvoiceByIdInDomain') {
  const items = scanSingle(json);
  if (items.length > 0) {
    autoRegenInOpenModal(items[0]);  // no await: corre en background
  }
}
```

- [ ] **Step 5.3: Eliminar `recordPending`**

Borrar la función completa (líneas ~242-257):

```js
function recordPending(items) {
  let added = 0, suppressed = 0;
  for (const it of items) {
    if (isRecentlyRegenerated(it.invoiceId)) { suppressed++; continue; }
    if (!pendingByInvoiceId.has(it.invoiceId)) {
      pendingByInvoiceId.set(it.invoiceId, it);
      added++;
    }
  }
  if (added > 0) {
    console.log(`[AutoRegen] +${added} pendientes (total ${pendingByInvoiceId.size})${suppressed ? ` — ignoradas ${suppressed} ya regeneradas` : ''}`);
  }
  updateBanner();
}
```

- [ ] **Step 5.4: Verificar que no haya más referencias**

```bash
grep -n "pendingByInvoiceId\|recordPending" remote/scripts/invoice-auto-regen.js
```

Expected: aparecen referencias en `autoRegenInOpenModal`, `startRun`, `_state`, `_pending` export, y `updateBanner`. **No commit todavía** — esas se arreglan en Tasks 6-9. Quedará el archivo "roto" temporalmente.

- [ ] **Step 5.5: Commit (WIP)**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "refactor(invoice-auto-regen): wip — quitar recordPending; consumers se actualizan en siguientes commits"
```

---

## Task 6: Adaptar `updateBanner` a `lastPullResult`

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:422-463` (`updateBanner`)

- [ ] **Step 6.1: Reemplazar referencias a `pendingByInvoiceId.size`**

En `updateBanner`, localizar el bloque que dice:

```js
} else if (pendingByInvoiceId.size > 0) {
  const btn = document.createElement('button');
  btn.dataset.saRegenStart = '1';
  const n = pendingByInvoiceId.size;
  btn.textContent = `↻ ${n} timbrada${n === 1 ? '' : 's'} pendiente${n === 1 ? '' : 's'} — Regenerar PDFs`;
```

Reemplazar por:

```js
} else if (Array.isArray(lastPullResult) && lastPullResult.length > 0) {
  const btn = document.createElement('button');
  btn.dataset.saRegenStart = '1';
  const n = lastPullResult.length;
  btn.textContent = `↻ ${n} timbrada${n === 1 ? '' : 's'} pendiente${n === 1 ? '' : 's'} — Regenerar PDFs`;
```

- [ ] **Step 6.2: Actualizar `_scheduleBannerCheck`**

Localizar (líneas ~467-475):

```js
const needsBanner = pendingByInvoiceId.size > 0 || runState.active;
```

Reemplazar por:

```js
const needsBanner = (Array.isArray(lastPullResult) && lastPullResult.length > 0) || runState.active;
```

- [ ] **Step 6.3: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "refactor(invoice-auto-regen): banner consume lastPullResult"
```

---

## Task 7: Adaptar `startRun` y `autoRegenInOpenModal`

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:261-284` (`autoRegenInOpenModal`)
- Modify: `remote/scripts/invoice-auto-regen.js:295-346` (`startRun`)

- [ ] **Step 7.1: `autoRegenInOpenModal` — guard por `recentlyRegenerated` en lugar de Map**

Localizar las primeras líneas de la función:

```js
async function autoRegenInOpenModal(item) {
  if (runState.active) return;                       // no interferir con batch
  if (modalAutoRegenActive) return;                  // ya hay uno corriendo
  if (window.__autoRegenPdfWaiter) return;           // hay otra regen en vuelo
  if (!pendingByInvoiceId.has(item.invoiceId)) return;
```

Reemplazar la última línea por:

```js
  if (isRecentlyRegenerated(item.invoiceId)) return; // ya la regeneramos hace < 3 min
```

- [ ] **Step 7.2: Eliminar la línea de delete dentro del try**

Más abajo, dentro del `try` de la misma función, hay:

```js
markRegenerated(item.invoiceId);
pendingByInvoiceId.delete(item.invoiceId);
```

Reemplazar por:

```js
markRegenerated(item.invoiceId);
pullPendingCount({ force: true }); // refresca banner sin bloquear el flujo
```

- [ ] **Step 7.3: `startRun` — iterar sobre `lastPullResult`**

Localizar:

```js
async function startRun() {
  if (runState.active) return;
  const items = Array.from(pendingByInvoiceId.values());
  if (items.length === 0) return;
```

Reemplazar la línea de `items` por:

```js
  const items = Array.isArray(lastPullResult) ? [...lastPullResult] : [];
  if (items.length === 0) return;
```

- [ ] **Step 7.4: `startRun` — eliminar la línea de delete dentro del loop**

Más abajo, dentro del `for` loop:

```js
await regenViaModal(items[i].idInDomain);
markRegenerated(items[i].invoiceId);
pendingByInvoiceId.delete(items[i].invoiceId);
success = true;
```

Reemplazar por:

```js
await regenViaModal(items[i].idInDomain);
markRegenerated(items[i].invoiceId);
success = true;
```

- [ ] **Step 7.5: `startRun` — refresh post-batch en el `finally`**

En el bloque `finally` de `startRun`, localizar:

```js
} finally {
  runState.active = false;
  runState.current = null;
  hideOverlay();
  updateBanner();
  console.log(`%c[AutoRegen] Batch terminado. ✓${ok} ✗${failed}. Pendientes restantes: ${pendingByInvoiceId.size}`, 'color:#16a34a;font-weight:bold');
}
```

Reemplazar el log y agregar el pull explícito:

```js
} finally {
  runState.active = false;
  runState.current = null;
  hideOverlay();
  // Trigger (b): post-regen siempre dispara pull fresco para que el banner refleje la realidad.
  pullPendingCount({ force: true }).then(items => {
    const remaining = Array.isArray(items) ? items.length : 0;
    console.log(`%c[AutoRegen] Batch terminado. ✓${ok} ✗${failed}. Pendientes restantes (post-pull): ${remaining}`, 'color:#16a34a;font-weight:bold');
  });
  updateBanner();
}
```

- [ ] **Step 7.6: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "refactor(invoice-auto-regen): startRun y autoRegenInOpenModal usan pull fresco"
```

---

## Task 8: Wire-up de triggers `init` y `visibilitychange`

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:89-102` (`init`)

- [ ] **Step 8.1: Agregar listener de `visibilitychange` y disparo inicial**

Localizar la función `init` y reemplazarla por:

```js
function init() {
  enabled = document.documentElement.dataset.saAutoRegenEnabled !== 'false';
  if (!enabled) { console.log('[AutoRegen] Deshabilitado'); return; }
  if (window.__saAutoRegenInitDone) {
    console.log('[AutoRegen] Ya estaba inicializado en esta página — skip (registry compartido)');
    return;
  }
  window.__saAutoRegenInitDone = true;
  _hydrateRecent();
  patchFetch();
  installLock();
  setupBannerObserver();

  // Trigger (c): re-enfocar el tab dispara pull (con throttle propio en pullPendingCount).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (runState.active) return; // no interferir con batch
    pullPendingCount(); // throttle a 30s aplica internamente
  });

  // Trigger (a): primer disparo. Si todavía no hay template aprendido, pullPendingCount
  // imprime un log informativo y retorna null — el siguiente ActiveInvoicesPaged del UI
  // (trigger d) lo activa.
  pullPendingCount();

  console.log('[AutoRegen] Inicializado');
}
```

- [ ] **Step 8.2: Verificar manualmente (smoke test)**

Recargar la extensión, abrir Steelhead Invoices, esperar a que el UI dispare un `ActiveInvoicesPaged`. La consola debería mostrar:

```
[AutoRegen] Inicializado
[AutoRegen] pullPendingCount: sin template aprendido todavía — esperando ActiveInvoicesPaged del UI
[AutoRegen] pullPendingCount: N pendientes (ventana 7d)
```

(El primer "sin template" es por el `init`; el segundo es disparado por el interceptor cuando llega el primer `ActiveInvoicesPaged` del UI.)

- [ ] **Step 8.3: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "feat(invoice-auto-regen): triggers init y visibilitychange"
```

---

## Task 9: Actualizar `_state` y exports de diagnóstico

**Files:**
- Modify: `remote/scripts/invoice-auto-regen.js:741-761` (`_state` y return del IIFE)

- [ ] **Step 9.1: Reescribir `_state`**

Localizar:

```js
function _state() {
  return {
    pending: pendingByInvoiceId.size,
    pendingIds: Array.from(pendingByInvoiceId.values()).map(i => i.idInDomain),
    run: { ...runState },
    modalAutoRegenActive
  };
}
```

Reemplazar por:

```js
function _state() {
  return {
    pendingCount: Array.isArray(lastPullResult) ? lastPullResult.length : 0,
    pendingIds: Array.isArray(lastPullResult) ? lastPullResult.map(i => i.idInDomain) : [],
    lastPullAt: lastPullAt ? new Date(lastPullAt).toISOString() : null,
    pullDegraded: _pullDegraded,
    pullInFlight: !!_pullInFlight,
    run: { ...runState },
    modalAutoRegenActive
  };
}
```

- [ ] **Step 9.2: Actualizar el `return` del IIFE**

Localizar el bloque `return { init, regenViaModal, ... };` (línea ~750) y reemplazar:

```js
  return {
    init,
    regenViaModal,
    regenViaModalBatch,
    testRegenInOpenModal,
    startRun,
    requestStop,
    _callOp,
    _state,
    _hashRegistry: hashRegistry,
    _pending: pendingByInvoiceId
  };
```

Por:

```js
  return {
    init,
    regenViaModal,
    regenViaModalBatch,
    testRegenInOpenModal,
    startRun,
    requestStop,
    pullPendingCount,
    _callOp,
    _state,
    _hashRegistry: hashRegistry,
    _lastPullResult: () => lastPullResult
  };
```

- [ ] **Step 9.3: Verificar que no quede ninguna referencia a `pendingByInvoiceId`**

```bash
grep -n "pendingByInvoiceId\|recordPending\|_pending" remote/scripts/invoice-auto-regen.js
```

Expected: salida vacía (excepto comentarios pre-existentes que mencionen el cambio histórico, si los hubiera).

- [ ] **Step 9.4: Commit**

```bash
git add remote/scripts/invoice-auto-regen.js
git commit -m "refactor(invoice-auto-regen): _state y exports apuntan a lastPullResult"
```

---

## Task 10: Smoke test integral en Steelhead

**Contexto:** Sin tests automatizados, validamos manualmente los 8 escenarios del spec.

- [ ] **Step 10.1: Cargar el dashboard limpio**

Reload de la extensión. Limpiar `localStorage` de `sa_autoregen_recently_regenerated` para empezar fresco. Abrir el dashboard. Esperar 2-3 s.

Expected: banner aparece con número de pendientes correctas (verificar contra la realidad de la cuenta — comparar con el número que el usuario ve manualmente). Console muestra `[AutoRegen] pullPendingCount: N pendientes (ventana 7d)`.

- [ ] **Step 10.2: Regenerar 1 factura y verificar decrement**

Click en el banner. El batch debe correr con 1 factura. Al terminar, banner refresca con N-1 pendientes. Console muestra el log post-batch con el conteo nuevo.

- [ ] **Step 10.3: Cerrar y reabrir el tab**

Cerrar tab. Abrir nuevo tab en la misma URL. Banner debe aparecer con el mismo número (no acumulado, no inflado). Si todo está OK, **no debe haber crecimiento misterioso**.

- [ ] **Step 10.4: Inducir falla de pull**

En consola, ejecutar:

```js
window.__autoRegenLastVars.ActiveInvoicesPaged.__broken = 'force-error';
```

(O modificar el hash en `config.json` localmente a algo inválido si es necesario.) Disparar 3 pulls (`InvoiceAutoRegen.pullPendingCount({force:true})` x3). Tras el 3er fallo, banner se oculta. Console muestra el warning de degraded.

- [ ] **Step 10.5: Recovery**

Disparar un `ActiveInvoicesPaged` real desde el UI (paginar o filtrar). El interceptor reactiva el template. Próximo `pullPendingCount` exitoso resetea `_pullDegraded` y banner reaparece.

- [ ] **Step 10.6: visibilitychange**

Mantener el tab > 30 s. Cambiar a otra pestaña, esperar 5 s, volver. Console debe mostrar log de `pullPendingCount`.

- [ ] **Step 10.7: Modal-auto-regen aún funciona**

Abrir manualmente una factura pendiente (click en `#XXX` en la lista). El modal debe disparar la regen automáticamente (`autoRegenInOpenModal`). Tras success, banner refresca.

- [ ] **Step 10.8: No hay console errors inesperados**

Filtrar console por `[AutoRegen]` y por errores genéricos. Solo deben aparecer logs informativos. Si hay TypeError o ReferenceError, capturar y arreglar antes de continuar.

---

## Task 11: Bump versión y deploy a `gh-pages`

**Files:**
- Modify: `remote/config.json` (top: `version`, `lastUpdated`)

- [ ] **Step 11.1: Bump version**

Editar `remote/config.json`:

```json
"version": "0.5.35",
"lastUpdated": "2026-04-29",
```

- [ ] **Step 11.2: Commit del bump**

```bash
git add remote/config.json
git commit -m "$(cat <<'EOF'
fix(invoice-auto-regen): pull activo de pendientes en lugar de set acumulado en memoria (0.5.35)

Reemplaza el detector pasivo (Map en memoria que solo crecía) por una query
GraphQL fresca con filtro de 7 días, evaluada con needsRegen() en cada render
del banner. TTL de recentlyRegenerated baja a 3 min (solo cubre eventual
consistency post-regen). Triggers: init, post-regen, visibilitychange,
interceptor reactivo. Sin polling.

Resuelve la queja de que el contador "se acumula eternamente" — ahora el
banner refleja exactamente lo que el backend reporta como pendiente.
EOF
)"
```

- [ ] **Step 11.3: Sync a `gh-pages` siguiendo el procedimiento de CLAUDE.md**

Seguir el patrón documentado en `CLAUDE.md` sección "Procedimiento". Resumen:

```bash
# Desde el directorio main, asumiendo current branch=main, tree limpio
git push origin main

# Switch a gh-pages, copiar archivos modificados desde el commit de main
git checkout gh-pages
git checkout main -- remote/scripts/invoice-auto-regen.js remote/config.json
# La estructura de gh-pages es aplanada: scripts/ y config.json al raíz, no remote/...
mv remote/scripts/invoice-auto-regen.js scripts/invoice-auto-regen.js
mv remote/config.json config.json
rm -rf remote
git add scripts/invoice-auto-regen.js config.json
git commit -m "deploy: invoice-auto-regen pull activo + bump 0.5.35"
git push origin gh-pages
git checkout main
```

- [ ] **Step 11.4: Verificar publicación**

Esperar 30-60 s. Visitar `https://oviazcan.github.io/SteelheadAutomator/scripts/invoice-auto-regen.js` y confirmar que el contenido refleja el cambio (buscar `pullPendingCount`).

Recargar la extensión en Chrome (`chrome://extensions` → reload). Abrir Steelhead Invoices y observar consola. Banner debe mostrar el número correcto.

- [ ] **Step 11.5: Verificar byte-a-byte sync**

```bash
git diff main:remote/scripts/invoice-auto-regen.js gh-pages:scripts/invoice-auto-regen.js
git diff main:remote/config.json gh-pages:config.json
```

Expected: ambos diff vacíos.

---

## Self-review checklist

- [x] Spec coverage: cada decisión del spec (eliminar Map, 7 días, TTL 3 min, triggers a-d, manejo de errores 3-fallos, _state cambia) tiene Task asignada.
- [x] No placeholders: todos los Steps muestran código exacto, no "implementar lo correspondiente".
- [x] Type consistency: `lastPullResult` es `Array<{invoiceId, idInDomain}> | null` en todas las Tasks; `pullPendingCount` retorna ese tipo o null.
- [x] Bump y deploy descritos siguiendo CLAUDE.md.
