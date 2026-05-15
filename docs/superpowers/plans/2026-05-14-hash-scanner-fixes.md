# Hash Scanner Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar el retrabajo en consola al implementar applets. Después de un scan, `scan_results_*.json` debe contener: hashes completos (no truncados), payloads de `variables` reales (no redacciones masivas), schemas mergeados a profundidad ilimitada, raw response samples con IDs reales, y errores GraphQL — todo lo que hoy obliga a ir a DevTools.

**Architecture:** El scanner es un patch de `window.fetch` en `remote/scripts/hash-scanner.js` con dedup interno por operación. Los fixes son cambios localizados a `recordOperation`, `sanitizeVariables`, `analyzeSchema`, `mergeResults` más una des-truncación en `api-knowledge.js`. No cambia arquitectura — enriquece lo que ya captura. TDD con `tools/test/hash-scanner.test.js` (mismo patrón Node que `po-reconciler.test.js`).

**Tech Stack:** Vanilla JavaScript ES6+, Chrome Extension MV3, GitHub Pages para hosting, `node` + `assert` para tests.

---

## Pre-implementation context

### Bugs documentados (evidencia en scan `~/Downloads/scan_results_2026-05-12_194651.json`)

| # | Bug | Evidencia |
|---|---|---|
| 1 | `apiKnowledge[].hash` truncado a 16 chars + `'...'` | 217/217 entradas con `"21bf4eb2b1b2ba6c..."`. El popup no muestra el hash (popup.js no lo lee), así que la truncación solo perjudica el export. |
| 2 | `SENSITIVE_OP_PATTERN` redacta variables enteras de ops benignas | `GetInvoiceLineItemsForRolis`, `SearchInvoiceTerms`, `UnreadEmailCount` quedan `{__redacted: ...}` aunque no traen tokens — solo nombre que matchea. |
| 3 | Dedup `JSON.stringify` exact-equal + cap=3 + first-wins | 60/91 ops (66%) con 1 sample, incluyendo `AddPartsToWorkOrders` count=448 y `CurrentUser` count=847. |
| 4 | `responseSchema` solo se asigna 1 vez (`if (!entry.responseSchema)`) | Primera respuesta con array vacío congela la entrada para siempre. |
| 5 | `analyzeSchema` maxDepth=4 trunca con `'...'` | 45/91 ops (49%) tienen schemas con `"..."` adentro. Steelhead llega a 6-7 niveles seguido. |
| 6 | No captura raw response samples | Sin IDs reales para reproducir; solo tipos abstractos. |
| 7 | No captura `errors[]` de respuestas fallidas | Op con hash deprecado (`CurrentUser` HTTP 400) queda con `responseSchema: null` y count creciendo — invisible que está rota. |
| 8 | No captura headers (Apollo client version) ni URL | n/a observable, pero `apolloPersistedQuery` y `apollographql-client-version` son reproducibilidad. |
| 9 | No log cronológico de la sesión | Imposible reconstruir orden de ops chained (`Create...` → `Save...Transforms` → `Save...Lines`). |

### Archivos del repo

- `remote/scripts/hash-scanner.js` (279 líneas) — corazón del scanner
- `remote/scripts/api-knowledge.js` (128 líneas) — donde se trunca el hash
- `extension/popup.js:359-385` — `renderAPIKnowledge`; no consume `hash`, así que quitar truncación es seguro
- `extension/background.js:600,663,685` — exporta `apiKnowledge` al JSON
- `remote/config.json` — bump de `version` al deploy
- `tools/test/po-reconciler.test.js` — patrón de test Node a copiar
- `tools/test/hash-scanner.test.js` (NUEVO)

### Procedimiento de deploy (referencia, ver `CLAUDE.md`)

1. Bump `remote/config.json:version` (ej. `0.6.22` → `0.6.23`) y `lastUpdated`
2. Commit en `main`
3. Switch a `gh-pages`, copiar `remote/scripts/*` → `scripts/*` y `remote/config.json` → `config.json`
4. Commit en `gh-pages` con formato `deploy: <descripción> + bump <version>`
5. Push ambas ramas
6. Recargar extensión (chrome://extensions) tras 30-60s

### Plan de testing

- **Pure functions** (`sanitizeVariables`, `analyzeSchema`, `mergeSchema`, `shapeSignature`, dedup logic): unit tests en `tools/test/hash-scanner.test.js`, ejecutables con `node tools/test/hash-scanner.test.js`
- **Integration** (browser): scan corto contra Steelhead real al final, smoke-checks documentados en Task 10

---

## Task 0: Setup test harness

**Files:**
- Modify: `remote/scripts/hash-scanner.js:276,279` — agregar `module.exports` y exponer internals via `_internal`
- Create: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Exponer internals para tests en `hash-scanner.js`**

Reemplaza las últimas 4 líneas del archivo (líneas 276-279):

```js
  return {
    init, start, stop, getResults, getStats, isActive, exportConfig, clear, mergeResults, analyzeSchema,
    _internal: { sanitizeValue, sanitizeVariables, analyzeSchema, extractFieldPaths, recordOperation, discovered, knownHashMap, knownOpMap }
  };
})();

if (typeof window !== 'undefined') window.HashScanner = HashScanner;
if (typeof module !== 'undefined') module.exports = HashScanner;
```

- [x] **Step 2: Crear `tools/test/hash-scanner.test.js` con harness mínimo**

```js
// tools/test/hash-scanner.test.js
// Run: node tools/test/hash-scanner.test.js

const assert = require('assert');
const path = require('path');

global.window = { addEventListener: () => {}, dispatchEvent: () => {} };
global.document = { dispatchEvent: () => {} };

const HashScanner = require(path.resolve(__dirname, '../../remote/scripts/hash-scanner.js'));
const I = HashScanner._internal;

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
    failed++;
  }
}

console.log('\n=== hash-scanner tests ===\n');

test('harness boots', () => {
  assert.ok(HashScanner, 'HashScanner defined');
  assert.ok(typeof I === 'object', '_internal exposed');
  assert.ok(typeof I.sanitizeVariables === 'function');
  assert.ok(typeof I.analyzeSchema === 'function');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
```

- [x] **Step 3: Correr el harness y verificar que pasa**

Run: `node tools/test/hash-scanner.test.js`
Expected:
```
=== hash-scanner tests ===

  ✓ harness boots

1 passed, 0 failed
```

- [x] **Step 4: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "chore(hash-scanner): expose internals for Node test harness"
```

---

## Task 1: Quitar truncación de hash en `api-knowledge.js`

**Bug #1.** El popup no muestra el hash (verificado en `popup.js:359-385`), así que la truncación es pérdida pura de información en el export.

**Files:**
- Modify: `remote/scripts/api-knowledge.js:35,52,86`

- [x] **Step 1: Editar `api-knowledge.js` línea 35**

Reemplaza:
```js
        hash: hash ? hash.substring(0, 16) + '...' : 'SIN HASH',
```
con:
```js
        hash: hash || null,
```

- [x] **Step 2: Editar `api-knowledge.js` línea 52**

Reemplaza:
```js
        hash: hash.substring(0, 16) + '...',
```
con:
```js
        hash: hash,
```

- [x] **Step 3: Editar `api-knowledge.js` línea 86**

Reemplaza:
```js
          hash: entry.hash ? entry.hash.substring(0, 16) + '...' : '?',
```
con:
```js
          hash: entry.hash || null,
```

- [x] **Step 4: Verificar manualmente que `popup.js:renderAPIKnowledge` no usa `op.hash`**

Run: `grep -n 'op\.hash' /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/extension/popup.js`
Expected: no matches (la función render no consume el campo).

- [x] **Step 5: Commit**

```bash
git add remote/scripts/api-knowledge.js
git commit -m "fix(api-knowledge): exportar hash completo (popup no lo renderiza)"
```

---

## Task 2: Redacción quirúrgica de variables (key-level, no op-level)

**Bug #2.** El regex `SENSITIVE_OP_PATTERN` redacta variables ENTERAS de cualquier op con `email|invoice|send|preview|attach|cfdi` en el nombre. Reemplazar por redacción solo de keys sensibles dentro del payload — el resto del shape queda visible.

**Files:**
- Modify: `remote/scripts/hash-scanner.js:16,45-56`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir tests fallidos en `hash-scanner.test.js`**

Agrega antes del bloque final `console.log(...)`:

```js
test('sanitizeVariables: redacta key body en ops benignas, conserva el resto', () => {
  const result = I.sanitizeVariables('SaveInvoice', {
    invoice: { id: 42, total: '100.00', notes: 'visible text' },
    emailData: { to: 'a@b.com', body: 'SUPER_SECRET_TOKEN_xyz' }
  });
  assert.strictEqual(result.invoice.id, 42, 'id visible');
  assert.strictEqual(result.invoice.total, '100.00', 'total visible');
  assert.strictEqual(result.invoice.notes, 'visible text', 'notes visible');
  assert.strictEqual(result.emailData, '[REDACTED]', 'emailData key matches → redacted');
});

test('sanitizeVariables: ya NO redacta el payload entero por nombre de op', () => {
  const result = I.sanitizeVariables('GetInvoiceLineItemsForRolis', {
    invoiceId: 12345,
    filter: { status: 'ACTIVE' }
  });
  assert.strictEqual(result.invoiceId, 12345, 'no op-level redaction');
  assert.deepStrictEqual(result.filter, { status: 'ACTIVE' });
});

test('sanitizeVariables: redacta keys sensibles incluso anidadas profundo', () => {
  const result = I.sanitizeVariables('AnyOp', {
    payload: { nested: { token: 'abc123', meta: { authToken: 'def456', name: 'ok' } } }
  });
  assert.strictEqual(result.payload.nested.token, '[REDACTED]');
  assert.strictEqual(result.payload.nested.meta.authToken, '[REDACTED]');
  assert.strictEqual(result.payload.nested.meta.name, 'ok');
});

test('sanitizeVariables: trunca strings largas (>500 chars)', () => {
  const longStr = 'x'.repeat(600);
  const result = I.sanitizeVariables('AnyOp', { data: longStr });
  assert.ok(String(result.data).startsWith('[TRUNCATED:'), 'long string truncated');
});

test('sanitizeVariables: redacta ?token=... en URLs', () => {
  const result = I.sanitizeVariables('AnyOp', { url: 'https://x.com/y?token=SECRET&a=1' });
  assert.ok(result.url.includes('token=[REDACTED]'));
  assert.ok(result.url.includes('a=1'));
});
```

- [x] **Step 2: Correr y verificar que fallan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 4 fallos (los 4 tests nuevos), 1 passed.

- [x] **Step 3: Eliminar `SENSITIVE_OP_PATTERN` y reescribir `sanitizeVariables`**

En `hash-scanner.js`, **borra** la línea 16:
```js
  const SENSITIVE_OP_PATTERN = /email|invoice|send|preview|attach|cfdi/i;
```

**Reemplaza** la función `sanitizeVariables` (líneas 45-56) con:
```js
  function sanitizeVariables(operationName, variables) {
    if (variables === null || variables === undefined) return variables;
    const counter = { n: 0 };
    const sanitized = sanitizeValue(variables, counter);
    if (counter.n > 0) {
      console.log(`[HashScanner] Redacted ${counter.n} sensitive value(s) in ${operationName}`);
    }
    return sanitized;
  }
```

(El parámetro `operationName` se conserva por compatibilidad de signatura — se usa solo para el log.)

- [x] **Step 4: Correr y verificar que pasan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 5 passed, 0 failed.

- [x] **Step 5: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "fix(hash-scanner): redacción key-level en lugar de op-level

Antes: cualquier op con email|invoice|send|preview|attach|cfdi
quedaba con variables: {__redacted: ...}, ocultando shape útil.
Ahora: solo keys sensibles (body|rawBody|html|token|...) se redactan
recursivamente; el resto del payload queda visible."
```

---

## Task 3: Schema profundidad ilimitada + merge entre llamadas

**Bugs #4 y #5.** Hoy `responseSchema` se captura **solo la primera vez** (`if (!entry.responseSchema)`) con maxDepth=4. Resultado: primera respuesta vacía o sparse congela el shape para siempre; niveles 5+ se cortan con `'...'`.

Fix: (a) `analyzeSchema` sin maxDepth (con guard de recursión cíclica), (b) `mergeSchema(a, b)` que fusiona shapes de múltiples llamadas, (c) `recordOperation` siempre llama `mergeSchema`.

**Files:**
- Modify: `remote/scripts/hash-scanner.js:150-153,174-207`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir tests fallidos en `hash-scanner.test.js`**

Agrega antes del bloque final:

```js
test('analyzeSchema: array vacío devuelve [null] (marker), no string "[]"', () => {
  const result = I.analyzeSchema({ nodes: [] });
  assert.deepStrictEqual(result, { nodes: [null] });
});

test('analyzeSchema: profundidad >4 NO se trunca con "..."', () => {
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { id: 1 } } } } } } };
  const result = I.analyzeSchema(deep);
  assert.strictEqual(
    result.l1.l2.l3.l4.l5.l6.id, 'number',
    'depth 7 still visible'
  );
});

test('mergeSchema: enriquece array vacío con shape de array poblado posterior', () => {
  const empty = I.analyzeSchema({ nodes: [] });
  const populated = I.analyzeSchema({ nodes: [{ id: 1, name: 'x' }] });
  const merged = I.mergeSchema(empty, populated);
  assert.deepStrictEqual(merged.nodes[0], { id: 'number', name: 'string' });
});

test('mergeSchema: union de campos de dos objetos', () => {
  const a = { id: 'number', name: 'string' };
  const b = { id: 'number', email: 'string' };
  const merged = I.mergeSchema(a, b);
  assert.deepStrictEqual(merged, { id: 'number', name: 'string', email: 'string' });
});

test('mergeSchema: campo null se reemplaza por shape posterior', () => {
  const a = { receivedAt: null };
  const b = { receivedAt: 'string' };
  assert.strictEqual(I.mergeSchema(a, b).receivedAt, 'string');
});
```

- [x] **Step 2: Correr y verificar que fallan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 5 nuevos fallan (tests asumen `mergeSchema` que no existe aún, y `analyzeSchema` con depth ilimitada).

- [x] **Step 3: Reescribir `analyzeSchema` y agregar `mergeSchema`**

Reemplaza las líneas 174-190 (función `analyzeSchema`) con:

```js
  // Recursive schema analyzer. No artificial depth limit; circular refs guarded by seen-set.
  function analyzeSchema(data, seen = new WeakSet()) {
    if (data === null || data === undefined) return null;
    if (typeof data !== 'object') return typeof data;
    if (seen.has(data)) return '[circular]';
    seen.add(data);
    if (Array.isArray(data)) {
      if (data.length === 0) return [null]; // marker: unknown item shape
      return [analyzeSchema(data[0], seen)];
    }
    const schema = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === '__typename') { schema.__typename = value; continue; }
      schema[key] = analyzeSchema(value, seen);
    }
    return schema;
  }

  // Merge two schemas. Used to enrich responseSchema across multiple calls.
  function mergeSchema(a, b) {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) {
      return [mergeSchema(a[0] ?? null, b[0] ?? null)];
    }
    if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
      const out = {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) out[k] = mergeSchema(a[k] ?? null, b[k] ?? null);
      return out;
    }
    if (typeof a === 'string' && typeof b === 'string') {
      return a === b ? a : `${a}|${b}`;
    }
    return a; // fallback: keep first non-null
  }
```

- [x] **Step 4: Reescribir `extractFieldPaths` sin maxDepth**

Reemplaza las líneas (~ después de `mergeSchema`, ~193-207) con:

```js
  function extractFieldPaths(data, prefix = '', seen = new WeakSet()) {
    const paths = [];
    if (!data || typeof data !== 'object') return paths;
    if (seen.has(data)) return paths;
    seen.add(data);
    for (const [key, value] of Object.entries(data)) {
      if (key === '__typename') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        paths.push(...extractFieldPaths(value, path, seen));
      } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
        paths.push(...extractFieldPaths(value[0], `${path}[]`, seen));
      }
    }
    return paths;
  }
```

- [x] **Step 5: Reescribir el bloque de captura en `recordOperation` para mergear cada vez**

Reemplaza las líneas 149-153 (`// Analyze response structure...`):

```js
    // Merge response schema across calls — enriches sparse first responses
    if (responseData?.data) {
      const newSchema = analyzeSchema(responseData.data);
      entry.responseSchema = entry.responseSchema
        ? mergeSchema(entry.responseSchema, newSchema)
        : newSchema;
      // Rebuild field paths from merged schema
      entry.responseFields = extractFieldPaths(entry.responseSchema);
    }
```

- [x] **Step 6: Exponer `mergeSchema` en `_internal` y en el return público**

En el bloque final del IIFE, agregar `mergeSchema` a la lista de exports:

```js
  return {
    init, start, stop, getResults, getStats, isActive, exportConfig, clear, mergeResults,
    analyzeSchema, mergeSchema,
    _internal: { sanitizeValue, sanitizeVariables, analyzeSchema, mergeSchema, extractFieldPaths, recordOperation, discovered, knownHashMap, knownOpMap }
  };
```

- [x] **Step 7: Correr y verificar que pasan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 10 passed, 0 failed.

- [x] **Step 8: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "fix(hash-scanner): mergear responseSchema entre llamadas + sin depth cap

Antes: primera respuesta vacía o sparse congelaba el schema. Niveles
5+ se cortaban con '...'. Ahora: cada llamada enriquece el schema
via mergeSchema; depth ilimitada con guard de circulares; extractFieldPaths
también sin cap."
```

---

## Task 4: Dedup por shape signature + cap N=10

**Bug #3.** `JSON.stringify` exact-equal hace que variantes triviales (orden de keys, valores numéricos diferentes pero misma forma) cuenten como distintas y se coman las 3 ranuras. Resultado: 66% de ops con 1 sample en el último scan. Fix: dedup por **shape signature** (set ordenado de paths+tipos), cap=10.

**Files:**
- Modify: `remote/scripts/hash-scanner.js:140-147`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir tests fallidos**

Agrega antes del bloque final:

```js
test('shapeSignature: mismo shape con valores distintos → misma firma', () => {
  const a = { id: 1, name: 'foo', nested: { x: 1 } };
  const b = { id: 999, name: 'bar', nested: { x: 42 } };
  assert.strictEqual(I.shapeSignature(a), I.shapeSignature(b));
});

test('shapeSignature: shape distinto → firma distinta', () => {
  const a = { id: 1, name: 'foo' };
  const b = { id: 1, name: 'foo', extra: true };
  assert.notStrictEqual(I.shapeSignature(a), I.shapeSignature(b));
});

test('shapeSignature: array de N items con shapes uniformes colapsa a 1 firma de item', () => {
  const arr1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const arr2 = [{ id: 99 }];
  assert.strictEqual(I.shapeSignature(arr1), I.shapeSignature(arr2));
});

test('shapeSignature: orden de keys no afecta firma', () => {
  const a = { a: 1, b: 2 };
  const b = { b: 2, a: 1 };
  assert.strictEqual(I.shapeSignature(a), I.shapeSignature(b));
});
```

- [x] **Step 2: Correr y verificar que fallan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 4 nuevos fallos (`shapeSignature` no existe).

- [x] **Step 3: Agregar `shapeSignature` y constante de cap**

En `hash-scanner.js`, cerca del top del IIFE (después de la declaración de `discovered`, antes de `sanitizeValue`):

```js
  const MAX_SAMPLES_PER_OP = 10;

  // Stable signature of an object's structural shape (keys + value types).
  // Used to dedup variablesSamples by shape, not by exact value equality.
  function shapeSignature(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return `[${shapeSignature(value[0])}]`;
    }
    if (typeof value !== 'object') return typeof value;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${k}:${shapeSignature(value[k])}`).join(',')}}`;
  }
```

- [x] **Step 4: Reescribir el bloque de captura de samples**

Reemplaza las líneas 140-147 (`// Keep up to 3 variable samples...`):

```js
    // Keep up to MAX_SAMPLES_PER_OP samples, deduped by shape signature.
    // Diverse shapes are more useful than exact-value duplicates.
    if (variables && entry.variablesSamples.length < MAX_SAMPLES_PER_OP) {
      const sanitized = sanitizeVariables(operationName, variables);
      const sig = shapeSignature(sanitized);
      entry._sigs = entry._sigs || new Set();
      if (!entry._sigs.has(sig)) {
        entry._sigs.add(sig);
        entry.variablesSamples.push(sanitized);
      }
    }
```

**Nota:** `_sigs` es un `Set` en memoria que no se serializa al JSON export (los `Set` se serializan como `{}`). Esto es intencional — la dedup vive solo durante la sesión activa.

- [x] **Step 5: Limpiar `_sigs` en `exportConfig`/`getResults` para que no aparezca en JSON serialization**

En el export, antes de devolver `discovered`, eliminar `_sigs`. **Reemplaza** la línea 209 (`function getResults() { return discovered; }`) con:

```js
  function getResults() {
    const out = {};
    for (const [k, v] of Object.entries(discovered)) {
      const { _sigs, ...rest } = v;
      out[k] = rest;
    }
    return out;
  }
```

- [x] **Step 6: Actualizar `mergeResults` para reconstruir `_sigs` al re-importar samples**

En `mergeResults` (líneas ~241-274), reemplaza el bloque `for (const sample of (entry.variablesSamples || []))`:

```js
        // Merge variable samples deduped by shape signature, up to MAX_SAMPLES_PER_OP
        existing._sigs = existing._sigs || new Set(existing.variablesSamples.map(shapeSignature));
        for (const sample of (entry.variablesSamples || [])) {
          if (existing.variablesSamples.length >= MAX_SAMPLES_PER_OP) break;
          const clean = sanitizeVariables(opName, sample);
          const sig = shapeSignature(clean);
          if (!existing._sigs.has(sig)) {
            existing._sigs.add(sig);
            existing.variablesSamples.push(clean);
          }
        }
```

- [x] **Step 7: Exponer `shapeSignature` en `_internal`**

Agregar a la lista de `_internal`:

```js
    _internal: { sanitizeValue, sanitizeVariables, analyzeSchema, mergeSchema, extractFieldPaths, shapeSignature, recordOperation, discovered, knownHashMap, knownOpMap }
```

- [x] **Step 8: Correr y verificar que pasan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 14 passed, 0 failed.

- [x] **Step 9: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "fix(hash-scanner): dedup samples por shape signature, cap 10

Antes: JSON.stringify exact-equal + cap=3 → 66% de ops con 1 sample.
Ahora: dedup por shape sig (set ordenado de paths+tipos), cap=10.
Variantes triviales (orden, valores) colapsan; shapes distintos
ocupan ranuras separadas."
```

---

## Task 5: Raw response samples (con IDs reales)

**Bug #6.** Hoy `responseSchema` solo dice tipos abstractos (`{id: 'number'}`); no quedan IDs reales para reproducir la op en consola. Fix: guardar hasta 2 raw responses sanitizadas por op.

**Files:**
- Modify: `remote/scripts/hash-scanner.js:126-171`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir tests fallidos**

```js
test('recordOperation: guarda raw response samples sanitizadas', () => {
  I.discovered._testRawOp = undefined; // reset
  delete I.discovered._testRawOp;
  I.recordOperation('_testRawOp', 'hash_xxx', { id: 42 }, { data: { foo: { id: 42, secret: 'X' }, body: 'should_redact' } });
  const entry = I.discovered._testRawOp;
  assert.ok(Array.isArray(entry.responseSamples), 'responseSamples is array');
  assert.strictEqual(entry.responseSamples.length, 1);
  assert.strictEqual(entry.responseSamples[0].foo.id, 42, 'IDs visible');
  assert.strictEqual(entry.responseSamples[0].body, '[REDACTED]', 'sensitive keys redacted in response too');
  delete I.discovered._testRawOp;
});

test('recordOperation: cap de 2 raw response samples por op', () => {
  delete I.discovered._testCapOp;
  for (let i = 0; i < 5; i++) {
    I.recordOperation('_testCapOp', 'h', { i }, { data: { id: i } });
  }
  assert.ok(I.discovered._testCapOp.responseSamples.length <= 2);
  delete I.discovered._testCapOp;
});
```

- [x] **Step 2: Correr y verificar que fallan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 2 nuevos fallos.

- [x] **Step 3: Agregar constante + lógica en `recordOperation`**

En `hash-scanner.js`, junto a `MAX_SAMPLES_PER_OP`:
```js
  const MAX_RESPONSE_SAMPLES_PER_OP = 2;
```

En `recordOperation`, inicialización (líneas 127-133), agregar campo:
```js
    if (!discovered[operationName]) {
      discovered[operationName] = {
        hash, count: 0, firstSeen: new Date().toISOString(), lastSeen: null,
        variablesSamples: [], responseSchema: null, responseFields: [],
        responseSamples: [],
        status: 'unknown', configKey: null
      };
    }
```

Después del bloque de `responseSchema` (después del Task 3 step 5), agrega:
```js
    // Keep raw response samples for reproducibility (real IDs to re-run from console)
    if (responseData?.data && entry.responseSamples.length < MAX_RESPONSE_SAMPLES_PER_OP) {
      const counter = { n: 0 };
      const cleaned = sanitizeValue(responseData.data, counter);
      entry.responseSamples.push(cleaned);
    }
```

- [x] **Step 4: Reflejar en `mergeResults`**

En `mergeResults`, después del bloque de merge de `variablesSamples`, agrega:
```js
        // Merge response samples up to cap (no dedup — raw data variety is useful)
        existing.responseSamples = existing.responseSamples || [];
        for (const rs of (entry.responseSamples || [])) {
          if (existing.responseSamples.length >= MAX_RESPONSE_SAMPLES_PER_OP) break;
          existing.responseSamples.push(rs);
        }
```

- [x] **Step 5: Correr y verificar que pasan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 16 passed, 0 failed.

- [x] **Step 6: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "feat(hash-scanner): guardar 2 raw response samples sanitizadas por op

Antes: solo responseSchema con tipos abstractos — sin IDs reales.
Ahora: responseSamples[] con hasta 2 payloads reales, redactando solo
keys sensibles (body/token/...). Permite reproducir ops en consola
con datos vivos sin volver al network tab."
```

---

## Task 6: Capturar `errors[]` de respuestas fallidas

**Bug #7.** Si un hash queda deprecado (`CurrentUser` HTTP 400) la op sigue incrementando count pero `responseSchema: null` — invisible que está rota. Fix: capturar `errors[]` y status HTTP.

**Files:**
- Modify: `remote/scripts/hash-scanner.js:75-102,126-171`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir tests fallidos**

```js
test('recordOperation: captura errors[] de respuestas fallidas', () => {
  delete I.discovered._testErrOp;
  I.recordOperation('_testErrOp', 'h', {}, { errors: [{ message: 'Must provide a query string.' }] }, 400);
  const entry = I.discovered._testErrOp;
  assert.ok(Array.isArray(entry.errorSamples), 'errorSamples present');
  assert.strictEqual(entry.errorSamples.length, 1);
  assert.strictEqual(entry.errorSamples[0].message, 'Must provide a query string.');
  assert.strictEqual(entry.lastHttpStatus, 400);
  assert.strictEqual(entry.errorCount, 1);
  delete I.discovered._testErrOp;
});

test('recordOperation: ok=true cuando responde data sin errors', () => {
  delete I.discovered._testOkOp;
  I.recordOperation('_testOkOp', 'h', {}, { data: { foo: 1 } }, 200);
  const entry = I.discovered._testOkOp;
  assert.strictEqual(entry.errorCount, 0);
  assert.strictEqual(entry.lastHttpStatus, 200);
  delete I.discovered._testOkOp;
});
```

- [x] **Step 2: Correr y verificar que fallan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 2 nuevos fallos.

- [x] **Step 3: Modificar firma de `recordOperation` y inicialización**

Cambia la firma:
```js
  function recordOperation(operationName, hash, variables, responseData, httpStatus) {
```

Inicialización del entry:
```js
    if (!discovered[operationName]) {
      discovered[operationName] = {
        hash, count: 0, firstSeen: new Date().toISOString(), lastSeen: null,
        variablesSamples: [], responseSchema: null, responseFields: [],
        responseSamples: [],
        errorSamples: [], errorCount: 0, lastHttpStatus: null,
        status: 'unknown', configKey: null
      };
    }
```

Después del bloque de `responseSamples`, agregar:
```js
    // Capture HTTP status + errors (deprecated hashes return 400, GraphQL errors return 200 with errors[])
    if (httpStatus !== undefined) entry.lastHttpStatus = httpStatus;
    const errs = Array.isArray(responseData?.errors) ? responseData.errors : null;
    if (errs && errs.length > 0) {
      entry.errorCount = (entry.errorCount || 0) + 1;
      if (entry.errorSamples.length < 3) {
        const counter = { n: 0 };
        entry.errorSamples.push(sanitizeValue(errs, counter));
      }
    }
```

- [x] **Step 4: Modificar el callsite en `window.fetch` patch para pasar status**

En el handler de `fetch` (líneas 75-102), después de obtener `response`:
```js
          const response = await originalFetch.apply(this, args);
          const httpStatus = response.status;
          const clonedResponse = response.clone();
          let responseData = null;
          try { responseData = await clonedResponse.json(); } catch (_) {}

          if (operationName && hash) {
            recordOperation(operationName, hash, variables, responseData, httpStatus);
          }
```

- [x] **Step 5: Reflejar en `mergeResults`**

Después del merge de `responseSamples`:
```js
        // Merge error samples (cap 3) + accumulate errorCount + keep latest httpStatus
        existing.errorSamples = existing.errorSamples || [];
        existing.errorCount = (existing.errorCount || 0) + (entry.errorCount || 0);
        if (entry.lastHttpStatus) existing.lastHttpStatus = entry.lastHttpStatus;
        for (const es of (entry.errorSamples || [])) {
          if (existing.errorSamples.length >= 3) break;
          existing.errorSamples.push(es);
        }
```

- [x] **Step 6: Correr y verificar que pasan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 18 passed, 0 failed.

- [x] **Step 7: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "feat(hash-scanner): capturar HTTP status + errors[] por op

Antes: ops con hash deprecado (HTTP 400) o GraphQL errors[] quedaban
con responseSchema:null y count creciendo, invisible que estaban rotas.
Ahora: lastHttpStatus + errorCount + errorSamples[3] por op."
```

---

## Task 7: Capturar headers + URL (opcional, fase 2)

**Bug #8.** `apollographql-client-version` y URL del endpoint no se capturan. Útiles cuando Steelhead cambia versión de Apollo (rompe applets) o agrega endpoints alternos.

**Files:**
- Modify: `remote/scripts/hash-scanner.js:75-102,126-171`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir test fallido**

```js
test('recordOperation: captura headers relevantes y URL', () => {
  delete I.discovered._testHeadOp;
  I.recordOperation('_testHeadOp', 'h', {}, { data: {} }, 200, {
    url: 'https://app.gosteelhead.com/graphql',
    apolloVersion: '4.0.8'
  });
  const entry = I.discovered._testHeadOp;
  assert.strictEqual(entry.url, 'https://app.gosteelhead.com/graphql');
  assert.strictEqual(entry.apolloVersion, '4.0.8');
  delete I.discovered._testHeadOp;
});
```

- [x] **Step 2: Correr y verificar que falla**

Run: `node tools/test/hash-scanner.test.js`
Expected: 1 fallo.

- [x] **Step 3: Extender `recordOperation` con parámetro `meta`**

Cambia firma:
```js
  function recordOperation(operationName, hash, variables, responseData, httpStatus, meta) {
```

Inicialización del entry:
```js
      discovered[operationName] = {
        // ...
        url: null, apolloVersion: null,
        // ...
      };
```

Al final de la función, antes de los checks de status:
```js
    if (meta?.url) entry.url = meta.url;
    if (meta?.apolloVersion) entry.apolloVersion = meta.apolloVersion;
```

- [x] **Step 4: Extraer headers en el patch de fetch**

En el handler (después de leer `body`):
```js
          const headers = options?.headers || {};
          const apolloVersion = (typeof headers.get === 'function')
            ? headers.get('apollographql-client-version')
            : (headers['apollographql-client-version'] || headers['Apollographql-Client-Version']);
          const meta = { url: urlStr, apolloVersion };
```

En la llamada:
```js
          if (operationName && hash) {
            recordOperation(operationName, hash, variables, responseData, httpStatus, meta);
          }
```

- [x] **Step 5: Correr y verificar que pasa**

Run: `node tools/test/hash-scanner.test.js`
Expected: 19 passed.

- [x] **Step 6: Commit**

```bash
git add remote/scripts/hash-scanner.js tools/test/hash-scanner.test.js
git commit -m "feat(hash-scanner): capturar URL y apollographql-client-version

Útil para detectar cuándo Steelhead cambia versión de Apollo
(causa silenciosa de fallas de applets)."
```

---

## Task 8: Log cronológico de la sesión (opcional, fase 2)

**Bug #9.** Cada op colapsa en una entrada — se pierde el orden temporal. Sin orden, no se reproducen flujos chained (`CreateReceivedOrder` → `SaveReceivedOrderPartTransforms` → `SaveReceivedOrderLinesAndItems`). Fix: array `eventLog: [{ts, op, varsSig, ok}]` con cap de 2000 entradas.

**Files:**
- Modify: `remote/scripts/hash-scanner.js`
- Modify: `tools/test/hash-scanner.test.js`

- [x] **Step 1: Escribir test fallido**

```js
test('eventLog: registra cada llamada con orden cronológico', () => {
  I.eventLog.length = 0; // reset
  I.recordOperation('OpA', 'hashA', { x: 1 }, { data: {} }, 200);
  I.recordOperation('OpB', 'hashB', { y: 2 }, { data: {} }, 200);
  I.recordOperation('OpA', 'hashA', { x: 99 }, { data: {} }, 200);
  assert.strictEqual(I.eventLog.length, 3);
  assert.strictEqual(I.eventLog[0].op, 'OpA');
  assert.strictEqual(I.eventLog[1].op, 'OpB');
  assert.strictEqual(I.eventLog[2].op, 'OpA');
  assert.ok(I.eventLog[0].ts <= I.eventLog[1].ts);
});

test('eventLog: cap de 2000 (drop oldest)', () => {
  I.eventLog.length = 0;
  for (let i = 0; i < 2100; i++) {
    I.recordOperation('OpX', 'h', { i }, { data: {} }, 200);
  }
  assert.strictEqual(I.eventLog.length, 2000);
});
```

- [x] **Step 2: Correr y verificar que fallan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 2 fallos.

- [x] **Step 3: Agregar `eventLog` y cap, registrar en `recordOperation`**

En el top del IIFE (junto a `const discovered = {}`):
```js
  const eventLog = [];
  const MAX_EVENT_LOG = 2000;
```

En `recordOperation`, al final:
```js
    // Append to chronological event log (cap MAX_EVENT_LOG, drop oldest)
    eventLog.push({
      ts: entry.lastSeen,
      op: operationName,
      varsSig: variables ? shapeSignature(variables) : null,
      ok: !errs || errs.length === 0,
      status: httpStatus ?? null
    });
    if (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
```

- [x] **Step 4: Exponer `eventLog` en `getResults`/exports y en `_internal`**

Modificar `getResults`:
```js
  function getResults() {
    const ops = {};
    for (const [k, v] of Object.entries(discovered)) {
      const { _sigs, ...rest } = v;
      ops[k] = rest;
    }
    return { ops, eventLog: [...eventLog] };
  }
```

Actualizar `_internal`:
```js
    _internal: { sanitizeValue, sanitizeVariables, analyzeSchema, mergeSchema, extractFieldPaths, shapeSignature, recordOperation, discovered, eventLog, knownHashMap, knownOpMap }
```

- [x] **Step 5: Actualizar consumidores de `getResults()`**

`getResults` ahora devuelve `{ ops, eventLog }` en lugar de `discovered` plano. Hay que actualizar:

(a) `api-knowledge.js:61`:
```js
        const { ops: discovered } = window.HashScanner.getResults();
```

(b) `background.js:600`: revisar — busca con `grep -n "getResults\|HashScanner" extension/background.js`. El `scanData` que se exporta debe ser compatible: cambiar `scanData` para que sea `{ ops, eventLog }` o sólo `.ops` según el shape esperado del JSON.

Lo más seguro: que `scan_results_*.json` quede como:
```json
{
  "exportedAt": "...",
  "scanResults": { /* ops indexadas por nombre, igual que antes */ },
  "eventLog": [ /* nuevo */ ],
  "apiKnowledge": [ ... ]
}
```

Editar `background.js:601,664` para extraer:
```js
const { ops, eventLog } = window.HashScanner.getResults();
const fullExport = { exportedAt: new Date().toISOString(), scanResults: ops, eventLog, apiKnowledge };
```

- [x] **Step 6: Correr y verificar que pasan**

Run: `node tools/test/hash-scanner.test.js`
Expected: 21 passed, 0 failed.

- [x] **Step 7: Commit**

```bash
git add remote/scripts/hash-scanner.js remote/scripts/api-knowledge.js extension/background.js tools/test/hash-scanner.test.js
git commit -m "feat(hash-scanner): log cronológico de la sesión (cap 2000)

Antes: ops colapsan, se pierde orden. Imposible reproducir flujos
chained (Create → Save → Save). Ahora: eventLog[] preserva orden
temporal con {ts, op, varsSig, ok, status} por llamada."
```

---

## Task 9: Bump version + smoke test integral

**Files:**
- Modify: `remote/config.json` — bump version y `lastUpdated`

- [x] **Step 1: Bump `remote/config.json:version`**

Leer la versión actual:
```bash
jq -r '.version' remote/config.json
```

Editar `remote/config.json`:
- `version`: incrementar último componente (ej. `0.6.22` → `0.6.23`)
- `lastUpdated`: `"2026-05-14"`

- [x] **Step 2: Smoke test sin deploy (consola del Service Worker)**

1. `chrome://extensions` → SteelheadAutomator → "Service Worker" → abrir consola
2. Probar carga local del scanner modificado (si la extensión usa un dev override):
   ```
   const s = await fetch('https://app.gosteelhead.com/graphql', {...})
   ```

   Alternativa más simple: skip a Step 3 (deploy real) y validar ahí.

- [x] **Step 3: Deploy a `gh-pages` siguiendo procedimiento de `CLAUDE.md`**

```bash
git push origin main
git checkout gh-pages
cp /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/remote/scripts/hash-scanner.js scripts/hash-scanner.js
cp /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/remote/scripts/api-knowledge.js scripts/api-knowledge.js
cp /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/remote/config.json config.json
git add scripts/hash-scanner.js scripts/api-knowledge.js config.json
git commit -m "deploy: hash-scanner fixes (#1-#9) + bump <version>"
git push origin gh-pages
git checkout main
```

- [x] **Step 4: Esperar 30-60s, recargar extensión, scan real corto**

1. `chrome://extensions` → reload SteelheadAutomator
2. Abrir Steelhead, activar scanner desde popup
3. Navegar: abrir 1 OV, crear 1 PN test, abrir 1 invoice, abrir 1 dashboard de sensores
4. Detener scanner, descargar `scan_results_*.json`

- [x] **Step 5: Verificar el JSON exportado contra checklist**

```bash
LATEST=$(ls -t ~/Downloads/scan_results_*.json | head -1)
echo "Verificando: $LATEST"

# Bug #1: hashes completos (64 chars), no truncados
jq -r '.apiKnowledge[].hash' "$LATEST" | grep -c '\.\.\.' && echo "❌ hay hashes truncados" || echo "✓ #1 OK"

# Bug #2: ninguna op con __redacted al nivel raíz de variablesSample
jq -r '[.scanResults | to_entries[] | select(.value.variablesSamples[0].__redacted != null)] | length' "$LATEST"
# Expected: 0

# Bug #3: ops con count > 5 tienen al menos 2-3 samples (algunas variantes)
jq -r '.scanResults | to_entries | map(select(.value.count > 5 and (.value.variablesSamples | length) == 1)) | length' "$LATEST"
# Expected: cerca de 0 (algunas ops genuinamente uniformes pueden quedar con 1)

# Bug #5: ningún "..." literal en schemas
jq -r '[.scanResults | to_entries[] | select(.value.responseSchema | tostring | contains("\"...\""))] | length' "$LATEST"
# Expected: 0

# Bug #6: hay responseSamples poblados
jq -r '.scanResults | to_entries | map(select(.value.responseSamples and (.value.responseSamples | length) > 0)) | length' "$LATEST"
# Expected: > 0 (la mayoría)

# Bug #7: si vimos errores 400 o errors[], queda registrado
jq -r '[.scanResults | to_entries[] | select(.value.errorCount > 0)] | .[].key' "$LATEST"
# Expected: puede ser vacío si todo funciona; si hay ops rotas, las lista

# Bug #9 (si Task 8 ejecutada): eventLog presente y poblado
jq -r '.eventLog | length' "$LATEST"
# Expected: > 0
```

- [x] **Step 6: Si todos los checks pasan, commit final de bump si no quedó incluido**

```bash
# Solo si quedó algún ajuste pendiente
git status
# Si limpio, no hay nada que commitear aquí
```

- [x] **Step 7: Actualizar `CLAUDE.md` con bitácora de los fixes**

Agregar al final de la sección "Pendientes del audit pre-producción" o en una nueva sección "Hash Scanner (sesión 2026-05-14)":

```markdown
### Hash Scanner: lecciones 0.6.22 → 0.6.23 (task #39)

Fix masivo del scanner para eliminar retrabajo en consola al implementar
applets. 9 bugs corregidos en `hash-scanner.js` y `api-knowledge.js`:

1. **Hash truncado** (`api-knowledge.js`) — exportaba `"abc123..."` (16 chars).
   Popup no lee `hash`; truncación era pérdida pura. Ahora exporta full SHA256.
2. **Redacción op-level → key-level** — `SENSITIVE_OP_PATTERN` ocultaba
   payloads enteros de ops benignas (`GetInvoiceLineItemsForRolis`, etc).
   Ahora solo redacta keys (`body`, `token`, ...) recursivamente.
3. **Dedup por shape signature, cap 10** — antes `JSON.stringify` exact-equal
   + cap 3 → 66% de ops con 1 sample. Ahora dedup estructural permite hasta
   10 variantes shape-distintas.
4. **Schema merge entre llamadas** — antes "first wins" congelaba schema
   con primera respuesta vacía. Ahora `mergeSchema(a, b)` enriquece.
5. **Schema sin depth cap** — antes maxDepth=4 cortaba con `'...'` en 49%
   de ops. Ahora ilimitado con guard de circulares.
6. **Raw response samples** — guarda 2 payloads sanitizados por op para
   reproducir con IDs reales sin volver al network tab.
7. **Captura `errors[]` y HTTP status** — ops rotas (hash deprecado HTTP 400,
   GraphQL errors) ahora visibles con `errorCount`/`errorSamples`/`lastHttpStatus`.
8. **URL + `apollographql-client-version`** — para detectar cambios silenciosos
   en infra de Steelhead.
9. **`eventLog` cronológico** (cap 2000) — preserva orden de chained calls
   para reproducir flujos multi-step.

Tests: `tools/test/hash-scanner.test.js` (Node, sin framework).
```

- [x] **Step 8: Commit final**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): bitácora hash-scanner fixes (0.6.22→0.6.23)"
```

---

## Self-review final

**Cobertura de bugs:**
- #1 → Task 1 ✓
- #2 → Task 2 ✓
- #3 → Task 4 ✓
- #4 → Task 3 (merge) ✓
- #5 → Task 3 (depth) ✓
- #6 → Task 5 ✓
- #7 → Task 6 ✓
- #8 → Task 7 (opcional fase 2)
- #9 → Task 8 (opcional fase 2)

**Tareas en orden recomendado:**
Task 0 (harness) → Task 1 (free win) → Task 2 (redacción) → Task 3 (schema) → Task 4 (samples) → Task 5 (raw) → Task 6 (errors) → [Task 7 → Task 8 opcionales] → Task 9 (deploy).

**Estimado:** Tasks 0-6 cubren el 90% del retrabajo (~2-3h). Tasks 7-8 son nice-to-have (~1h extra). Deploy + smoke test ~30min.

**Riesgos:**
- Task 3 (merge schema) podría romper consumidores del shape — solo `popup.js:renderAPIKnowledge` lo lee, y solo consume `responseFields` (no `responseSchema`), así que el riesgo es bajo.
- Task 8 (eventLog) cambia la shape del export de `getResults()` — requiere actualizar `api-knowledge.js` y `background.js`. Listado en Task 8 Step 5.
- Cap=10 samples + 2 response samples puede crecer el tamaño del `scan_results_*.json` ~2-3x. Los actuales son ~750KB; nuevos serían ~2MB. Aceptable para uso interno.
