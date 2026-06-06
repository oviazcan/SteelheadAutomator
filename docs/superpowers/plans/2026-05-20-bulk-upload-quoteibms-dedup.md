# bulk-upload — Dedup por QuoteIBMS + composite con override manual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reescribir la fase de dedup de `bulk-upload.js` para que clasifique cada fila CSV en 3 pases (QuoteIBMS autoritativo → composite exacto con regla anti-colisión → near-match con override manual del usuario), agregue UI de decisiones pendientes con links a candidatos, persista el override entre páginas y crashes, y produzca un reporte XLSX al final de la corrida.

**Architecture:** Refactor in-place del applet `remote/scripts/bulk-upload.js`. Helpers de clasificación se extraen como funciones puras expuestas vía `window.BulkUploadHelpers` para ser testables con un harness mínimo en Node. La query `AllPartNumbers` cambia de "una llamada por nombre" a "prefetch paginado por cliente" para amortizar costo. El UI de preview existente (post-Fix 4 de 1.0.0) gana un header con contador de decisiones pendientes, un dropdown por fila Pase 3 con tres links a fichas de PN, y persistencia de override en `state.classifications`. El resume schema en `localStorage` se extiende para incluir `classifications` y sobrevivir crashes. Al final del run se genera un XLSX con SheetJS con 3 hojas (Resumen, Decisiones Pase 3, Errores).

**Tech Stack:** JavaScript vanilla (sin frameworks), DOM nativo, Apollo Persisted Queries vs Steelhead GraphQL, SheetJS (`xlsx.full.min.js`) ya cargado por otros applets, `localStorage` para resume, Node test harness (`node:test` + `node:vm`) para helpers puros.

**Prerequisitos verificables al arranque:**
- El usuario debe haber corrido recientemente el flujo de bulk-upload con `hash-scanner` activo, dejando un `~/Downloads/scan_results_*.json` que contenga `AllPartNumbers` y `SavePartNumber` con `lastHttpStatus: 200`. Si no existe ese scan, Task 0 lo solicita explícitamente al usuario antes de continuar.

---

## File Structure

| Archivo | Cambio | Responsabilidad |
|---|---|---|
| `remote/scripts/bulk-upload.js` | Modify | Applet principal: clasificación, preview UI, enrich, resume, XLSX |
| `remote/config.json` | Modify | Bump version 1.0.0→1.1.0; agregar `nonFinishLabelNames` |
| `tools/test/bulk-upload-helpers.test.js` | Create | Tests Node de helpers puros (`acabadosOrdenados`, `classifyOnePN`, etc.) |
| `docs/superpowers/specs/2026-05-20-bulk-upload-quoteibms-dedup-design.md` | Reference only | Diseño aprobado, no se modifica |

Los helpers se exportan via `window.BulkUploadHelpers` en `bulk-upload.js` (al final del IIFE) para ser cargables por el test harness con `vm.runInNewContext`.

---

## Task 0: Verificación previa de shapes de GraphQL

**Files:**
- Lectura: `~/Downloads/scan_results_*.json` (más reciente que contenga AllPartNumbers + SavePartNumber)

- [ ] **Step 1: Listar scans recientes y elegir el más reciente con las ops requeridas**

Run:
```bash
for f in $(ls -t ~/Downloads/scan_results_*.json 2>/dev/null | head -10); do
  echo "=== $f ==="
  jq '.scanResults | keys | map(select(. == "AllPartNumbers" or . == "SavePartNumber"))' "$f"
done
```
Expected: al menos un archivo lista `["AllPartNumbers", "SavePartNumber"]`.

**Si ningún scan tiene esas ops:** detener. Pedir al usuario que abra Steelhead, active hash-scanner (popup de la extensión → "Iniciar scan"), corra el preview de bulk-upload con un CSV cualquiera (basta con que llegue al preview, no confirmar), exporte el scan a `~/Downloads`, y vuelva a correr Task 0.

- [ ] **Step 2: Confirmar response shape de `AllPartNumbers`**

Run (sustituye `<SCAN>` por la ruta elegida):
```bash
jq '.scanResults.AllPartNumbers | {hash, lastHttpStatus, sampleKeys: (.responseSamples[0].pagedData.nodes[0] // null | keys // []), inputKeys: (.variablesSamples[0] // null | keys // [])}' <SCAN>
```
Expected:
- `lastHttpStatus: 200`
- `sampleKeys` contiene mínimo `["id", "name", "archivedAt", "customerByCustomerId", "customInputs", "partNumberLabelsByPartNumberId", "processNodeByDefaultProcessNodeId"]`.
- `inputKeys` contiene `customerIdFilter` (o variante: `customerIdsFilter`, `customerFilter`). El nombre exacto se usará en Task 7.

**Si `customInputs` NO viene en el response shape**: anotar en CLAUDE.md y abrir issue — Task 7 step 2 (`extractPNShape`) requerirá un follow-up `GetPartNumber` por candidato, lo que aumenta el costo del prefetch.

**Si `partNumberLabelsByPartNumberId` NO viene**: idem, follow-up necesario.

**Si `customerIdFilter` NO está en `inputKeys`**: identificar el nombre real del parámetro probando variantes en consola de DevTools:
```js
window.steelheadDispatchQuery('AllPartNumbers', { orderBy: ['ID_DESC'], offset: 0, first: 5, customerIdFilter: [<id_conocido>] })
```
Si falla: probar `customerIdsFilter`, `customerFilter`, `condition: { customerId: <id> }`. Reemplazar `customerIdFilter` en el código de Task 7 step 2 por el nombre real. Documentar el nombre en este step antes de continuar.

- [ ] **Step 3: Confirmar input shape de `SavePartNumber`**

Run:
```bash
jq '.scanResults.SavePartNumber | {hash, lastHttpStatus, inputKeys: (.variablesSamples[0].input[0] // null | keys // [])}' <SCAN>
```
Expected: `lastHttpStatus: 200`, `inputKeys` contiene mínimo `["id", "name", "customerId", "labelIds", "customInputs", "inputSchemaId"]`.

Confirma que MODIFY puede pisar `name` y `labelIds` con el mismo input shape (sí lo hace hoy, líneas 1899-1902). **No code change si confirma.**

- [ ] **Step 4: Anotar hashes vivos vs los de config**

Run:
```bash
echo "Hash en scan:"
jq '.scanResults.AllPartNumbers.hash, .scanResults.SavePartNumber.hash' <SCAN>
echo "Hash en config:"
jq '.steelhead.queries.AllPartNumbers.hash, .steelhead.queries.SavePartNumber.hash' remote/config.json
```
Expected: hashes iguales (200 OK). Si difieren, aplicar el playbook 60-segundos de CLAUDE.md (rotación silenciosa) ANTES de continuar — actualizar hashes en `remote/config.json` y bumpear version en commit separado.

---

## Task 1: Setup test harness mínimo para helpers puros

**Files:**
- Create: `tools/test/bulk-upload-helpers.test.js`

- [ ] **Step 1: Crear el archivo de test con el loader vm**

```js
// tools/test/bulk-upload-helpers.test.js
// Carga remote/scripts/bulk-upload.js en un vm con stub window y extrae
// window.BulkUploadHelpers para testear helpers puros sin tocar DOM/fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload.js');

function loadHelpers() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {},
    document: { getElementById: () => null, head: { appendChild: () => {} }, body: { appendChild: () => {} }, createElement: () => ({ appendChild: () => {}, classList: { add: () => {} } }) },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => { throw new Error('fetch stub in test'); },
    chrome: { runtime: { sendMessage: () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    Blob: function() {},
    TextEncoder, TextDecoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: 'bulk-upload.js' });
  } catch (e) {
    throw new Error(`Failed to load bulk-upload.js in vm: ${e.message}\n${e.stack}`);
  }
  if (!sandbox.window.BulkUploadHelpers) {
    throw new Error('window.BulkUploadHelpers no fue exportado. Agregar exports al final del IIFE en bulk-upload.js.');
  }
  return sandbox.window.BulkUploadHelpers;
}

test('harness boots and exports helpers object', () => {
  const H = loadHelpers();
  assert.equal(typeof H, 'object');
});
```

- [ ] **Step 2: Correr el test (debe fallar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: FAIL con `Error: window.BulkUploadHelpers no fue exportado.` (porque aún no agregamos el export). **Eso confirma que el harness carga sin crashear.**

Si falla con otro error (e.g., `ReferenceError` por algún global inesperado), agregar el stub correspondiente al sandbox y reintentar.

- [ ] **Step 3: Exportar objeto vacío en bulk-upload.js**

Edit `remote/scripts/bulk-upload.js` línea final (actualmente `if (typeof window !== 'undefined') window.BulkUpload = BulkUpload;`):

```js
if (typeof window !== 'undefined') {
  window.BulkUpload = BulkUpload;
  window.BulkUploadHelpers = BulkUpload.__helpers || {};
}
```

Y dentro del IIFE, antes del `return { ... }` final, agregar (placeholder, llenamos en tareas siguientes):

```js
const __helpers = {};  // poblado en Task 2-5
```

Y al return del IIFE agregar `__helpers,` a las propiedades exportadas.

- [ ] **Step 4: Correr el test (debe pasar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: PASS. `harness boots and exports helpers object`.

- [ ] **Step 5: Commit**

```bash
git add tools/test/bulk-upload-helpers.test.js remote/scripts/bulk-upload.js
git commit -m "$(cat <<'EOF'
test(bulk-upload): harness mínimo de tests Node para helpers puros via vm

Carga remote/scripts/bulk-upload.js en un vm con stub window/document/etc.
y extrae window.BulkUploadHelpers para testear funciones puras sin DOM
ni fetch. Primer test confirma que el harness boota; los helpers se
añaden en tareas siguientes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Helper `isNonFinishLabel` + `acabadosOrdenados`

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (agregar funciones al IIFE, exportar via `__helpers`)
- Modify: `tools/test/bulk-upload-helpers.test.js` (agregar tests)

- [ ] **Step 1: Escribir tests fallidos**

Agregar al final de `tools/test/bulk-upload-helpers.test.js`:

```js
test('isNonFinishLabel matches blacklist exactly', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY', 'STX', 'SXC', 'SRG', 'SCM', 'SQ1', 'SQ2', 'NP desconocido', 'En desarrollo', 'Muestras', 'Lote', 'Obsoleto'];
  assert.equal(H.isNonFinishLabel('SMY', NON_FINISH), true);
  assert.equal(H.isNonFinishLabel('NP desconocido', NON_FINISH), true);
  assert.equal(H.isNonFinishLabel('NIQ', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel('CROMADO', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel('', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel(null, NON_FINISH), false);
  // Case-sensitive match (igual que vienen en Steelhead)
  assert.equal(H.isNonFinishLabel('smy', NON_FINISH), false);
});

test('acabadosOrdenados filters blacklist, sorts, joins', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY', 'STX', 'NP desconocido'];
  assert.equal(H.acabadosOrdenados(['NIQ', 'EST', 'SMY'], NON_FINISH), 'EST|NIQ');
  assert.equal(H.acabadosOrdenados(['SMY', 'STX'], NON_FINISH), '');
  assert.equal(H.acabadosOrdenados([], NON_FINISH), '');
  assert.equal(H.acabadosOrdenados(['CROMADO'], NON_FINISH), 'CROMADO');
  // labels duplicados se deduplican
  assert.equal(H.acabadosOrdenados(['NIQ', 'NIQ', 'EST'], NON_FINISH), 'EST|NIQ');
  // ignora nulos/vacíos
  assert.equal(H.acabadosOrdenados(['NIQ', null, '', 'EST'], NON_FINISH), 'EST|NIQ');
});
```

- [ ] **Step 2: Correr tests (deben fallar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 2 nuevos tests fallan con `TypeError: H.isNonFinishLabel is not a function`.

- [ ] **Step 3: Implementar las funciones en bulk-upload.js**

Dentro del IIFE de `BulkUpload`, en la sección `// HELPERS` (alrededor de la línea 578), agregar:

```js
  // ─── Helpers de clasificación (puros, exportados a window.BulkUploadHelpers) ───

  function isNonFinishLabel(name, nonFinishList) {
    if (!name || typeof name !== 'string') return false;
    return nonFinishList.includes(name);
  }

  function acabadosOrdenados(labels, nonFinishList) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    const acabados = [];
    for (const l of labels) {
      if (!l || typeof l !== 'string') continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      if (seen.has(l)) continue;
      seen.add(l);
      acabados.push(l);
    }
    return acabados.sort().join('|');
  }
```

En la declaración `const __helpers = {};` (de Task 1), reemplazar por:

```js
  const __helpers = { isNonFinishLabel, acabadosOrdenados };
```

(En tareas siguientes iremos agregando funciones a este objeto.)

- [ ] **Step 4: Correr tests (deben pasar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js tools/test/bulk-upload-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): helpers isNonFinishLabel + acabadosOrdenados con tests

Funciones puras para filtrar etiquetas no-acabado (plantas SMY/STX/etc.
y status NP desconocido/En desarrollo/etc.) y producir el string canónico
ordenado de acabados que será parte del composite key de dedup.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Helper `buildCompositeKey`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`
- Modify: `tools/test/bulk-upload-helpers.test.js`

- [ ] **Step 1: Escribir tests fallidos**

Agregar al test file:

```js
test('buildCompositeKey concatena con separador y normaliza name a uppercase', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY'];
  const k1 = H.buildCompositeKey({ customerId: 42, name: 'ABC-123', metalBase: 'COBRE', labels: ['NIQ', 'SMY'] }, NON_FINISH);
  assert.equal(k1, '42||ABC-123||COBRE||NIQ');

  // Name lowercase se normaliza
  const k2 = H.buildCompositeKey({ customerId: 42, name: 'abc-123', metalBase: 'COBRE', labels: ['NIQ'] }, NON_FINISH);
  assert.equal(k2, '42||ABC-123||COBRE||NIQ');

  // metalBase vacío se mantiene vacío
  const k3 = H.buildCompositeKey({ customerId: 7, name: 'X', metalBase: '', labels: [] }, NON_FINISH);
  assert.equal(k3, '7||X||||');

  // metalBase null se mantiene vacío
  const k4 = H.buildCompositeKey({ customerId: 7, name: 'X', metalBase: null, labels: ['EST', 'NIQ'] }, NON_FINISH);
  assert.equal(k4, '7||X||||EST|NIQ');
});
```

- [ ] **Step 2: Correr tests (deben fallar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: nuevo test falla con `TypeError: H.buildCompositeKey is not a function`.

- [ ] **Step 3: Implementar la función**

Agregar después de `acabadosOrdenados`:

```js
  function buildCompositeKey(pn, nonFinishList) {
    const customerId = pn.customerId != null ? String(pn.customerId) : '';
    const name = (pn.name || '').toUpperCase();
    const metalBase = pn.metalBase ? String(pn.metalBase) : '';
    const acabados = acabadosOrdenados(pn.labels || [], nonFinishList);
    return `${customerId}||${name}||${metalBase}||${acabados}`;
  }
```

Agregar a `__helpers`: `buildCompositeKey,`

- [ ] **Step 4: Correr tests (deben pasar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js tools/test/bulk-upload-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): helper buildCompositeKey con tests

Llave composite (customerId, name uppercase, metalBase, acabados ordenados)
que el Pase 2 del nuevo dedup usa para match exacto.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Helper `rankCandidates`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`
- Modify: `tools/test/bulk-upload-helpers.test.js`

- [ ] **Step 1: Escribir tests fallidos**

Agregar al test file:

```js
test('rankCandidates ordena por matchScore desc, IBMS vacío gana en ties, luego id asc', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY'];
  const csvRow = { customerId: 1, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const cands = [
    { id: 10, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q9' }, // match-2 + IBMS distinto
    { id: 5,  name: 'X', metalBase: 'CU', labels: ['EST'], quoteIBMS: '' },   // match-1 + IBMS vacío
    { id: 8,  name: 'X', metalBase: 'AL', labels: [],     quoteIBMS: '' },    // match-0 + IBMS vacío
    { id: 3,  name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },   // match-2 + IBMS vacío
  ];
  const ranked = H.rankCandidates(csvRow, cands, NON_FINISH);
  // Esperado: id 3 (match-2, IBMS vacío) > id 10 (match-2, IBMS distinto) > id 5 (match-1) > id 8 (match-0)
  assert.deepEqual(ranked.map(c => c.id), [3, 10, 5, 8]);
});

test('rankCandidates tie-breaker por id ascendente cuando todo lo demás es igual', () => {
  const H = loadHelpers();
  const NON_FINISH = [];
  const csvRow = { customerId: 1, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const cands = [
    { id: 20, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
    { id: 7,  name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
    { id: 15, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const ranked = H.rankCandidates(csvRow, cands, NON_FINISH);
  assert.deepEqual(ranked.map(c => c.id), [7, 15, 20]);
});

test('rankCandidates returns empty array for empty candidates', () => {
  const H = loadHelpers();
  const ranked = H.rankCandidates({ customerId: 1, name: 'X', metalBase: '', labels: [], quoteIBMS: '' }, [], []);
  assert.deepEqual(ranked, []);
});
```

- [ ] **Step 2: Correr tests (deben fallar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 3 nuevos tests fallan con `TypeError: H.rankCandidates is not a function`.

- [ ] **Step 3: Implementar la función**

Agregar después de `buildCompositeKey`:

```js
  function rankCandidates(csvRow, candidates, nonFinishList) {
    const csvMetal = csvRow.metalBase || '';
    const csvAcabados = acabadosOrdenados(csvRow.labels || [], nonFinishList);
    const csvIbms = csvRow.quoteIBMS || '';

    function score(c) {
      let s = 0;
      if ((c.metalBase || '') === csvMetal) s++;
      if (acabadosOrdenados(c.labels || [], nonFinishList) === csvAcabados) s++;
      return s;
    }

    function ibmsRank(c) {
      const ibms = c.quoteIBMS || '';
      if (csvIbms && ibms === csvIbms) return 0; // mismo IBMS gana
      if (!ibms) return 1;                       // IBMS vacío segundo
      return 2;                                  // IBMS distinto último
    }

    return [...candidates].sort((a, b) => {
      const sd = score(b) - score(a);
      if (sd !== 0) return sd;
      const id = ibmsRank(a) - ibmsRank(b);
      if (id !== 0) return id;
      return (a.id || 0) - (b.id || 0);
    });
  }
```

Agregar a `__helpers`: `rankCandidates,`

- [ ] **Step 4: Correr tests (deben pasar)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js tools/test/bulk-upload-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): helper rankCandidates con tests

Ordena candidatos de Pase 3 por (campos coincidentes desc, IBMS vacío
gana sobre IBMS distinto, id ascendente como tie-breaker). El top 3 se
ofrece al usuario en el dropdown del preview.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Helper `classifyOnePN` orquestador puro

**Files:**
- Modify: `remote/scripts/bulk-upload.js`
- Modify: `tools/test/bulk-upload-helpers.test.js`

- [ ] **Step 1: Escribir tests fallidos cubriendo los 7 casos de §10 del spec**

Agregar al test file:

```js
test('classifyOnePN — Caso 1: IBMS exacto, name iguales → Pase 1 MODIFY', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY'];
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, NON_FINISH);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.confidence, 'ibms-exacto');
});

test('classifyOnePN — Caso 2: IBMS exacto, name distinto → Pase 1 MODIFY + rename', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'B', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
});

test('classifyOnePN — Caso 3: CSV trae IBMS, PN no, composite match → Pase 2 MODIFY (populate)', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 2);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.confidence, 'composite-exacto-pn-sin-ibms');
});

test('classifyOnePN — Caso 4: CSV sin IBMS, PN con IBMS, composite match → Pase 2 MODIFY (preserva IBMS)', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Y' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 2);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.confidence, 'composite-exacto-csv-sin-ibms');
});

test('classifyOnePN — Caso 5: dos PNs, uno por IBMS y otro por name; gana Pase 1', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'Z', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' }, // matchea por IBMS
    { id: 101, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Y' }, // matchea por composite, IBMS distinto
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
});

test('classifyOnePN — Caso 6: name coincide, metalBase distinto → Pase 3 NEW default con candidato', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'AL', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, 3);
  assert.equal(r.targetPnId, null);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 100);
});

test('classifyOnePN — Caso 7: nada parecido → NEW sin candidatos', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'Z', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, null);
  assert.equal(r.targetPnId, null);
  assert.equal(r.candidates.length, 0);
});

test('classifyOnePN — anti-colisión Pase 2: composite match pero ambos IBMS no-vacíos y distintos → cae a Pase 3', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Y' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, 3);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 100);
});

test('classifyOnePN — Pase 3 top 3 cap aunque haya más candidatos', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 1, name: 'A', metalBase: 'AL', labels: [], quoteIBMS: '' },
    { id: 2, name: 'A', metalBase: 'FE', labels: [], quoteIBMS: '' },
    { id: 3, name: 'A', metalBase: 'ZN', labels: [], quoteIBMS: '' },
    { id: 4, name: 'A', metalBase: 'PB', labels: [], quoteIBMS: '' },
    { id: 5, name: 'A', metalBase: 'NI', labels: [], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.pase, 3);
  assert.equal(r.candidates.length, 3);
});

test('classifyOnePN — archivedAt excluye PNs aunque matcheen', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: 'X', archivedAt: '2024-01-01' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, null);
  assert.equal(r.candidates.length, 0);
});
```

- [ ] **Step 2: Correr tests (deben fallar todos los nuevos)**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 9 nuevos tests fallan con `TypeError: H.classifyOnePN is not a function`.

- [ ] **Step 3: Implementar la función**

Agregar después de `rankCandidates`:

```js
  function classifyOnePN(csvRow, pnsForCustomer, nonFinishList) {
    const activePns = (pnsForCustomer || []).filter(p => !p.archivedAt);
    const csvIbms = csvRow.quoteIBMS || '';
    const csvCompositeKey = buildCompositeKey(csvRow, nonFinishList);

    // ── Pase 1: QuoteIBMS autoritativo ──
    if (csvIbms) {
      const byIbms = activePns.find(p => (p.quoteIBMS || '') === csvIbms);
      if (byIbms) {
        return {
          classification: 'MODIFY',
          pase: 1,
          confidence: 'ibms-exacto',
          targetPnId: byIbms.id,
          candidates: [],
        };
      }
    }

    // ── Pase 2: composite exacto con regla anti-colisión ──
    const byComposite = activePns.find(p => buildCompositeKey(p, nonFinishList) === csvCompositeKey);
    if (byComposite) {
      const pnIbms = byComposite.quoteIBMS || '';
      const colision = csvIbms && pnIbms && pnIbms !== csvIbms;
      if (!colision) {
        let confSuffix;
        if (!pnIbms && !csvIbms) confSuffix = 'ambos-sin-ibms';
        else if (!pnIbms) confSuffix = 'pn-sin-ibms';
        else if (!csvIbms) confSuffix = 'csv-sin-ibms';
        else confSuffix = 'ibms-coincide';
        return {
          classification: 'MODIFY',
          pase: 2,
          confidence: `composite-exacto-${confSuffix}`,
          targetPnId: byComposite.id,
          candidates: [],
        };
      }
      // colision → cae a Pase 3 (el PN aparecerá como candidato)
    }

    // ── Pase 3: near-match por nombre ──
    const nameUpper = (csvRow.name || '').toUpperCase();
    const nameCandidates = activePns.filter(p => (p.name || '').toUpperCase() === nameUpper);
    if (nameCandidates.length > 0) {
      const ranked = rankCandidates(csvRow, nameCandidates, nonFinishList).slice(0, 3);
      return {
        classification: 'NEW',
        pase: 3,
        confidence: 'near-match-name',
        targetPnId: null,
        candidates: ranked,
      };
    }

    // ── Sin candidatos en ningún pase ──
    return {
      classification: 'NEW',
      pase: null,
      confidence: 'sin-match',
      targetPnId: null,
      candidates: [],
    };
  }
```

Agregar a `__helpers`: `classifyOnePN,`

- [ ] **Step 4: Correr todos los tests**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 16/16 PASS.

Si alguno falla, debug del caso y arreglar. NO seguir hasta tener todos verdes.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js tools/test/bulk-upload-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): classifyOnePN puro con tests para los 7 casos del spec

Orquestador de los 3 pases del nuevo dedup. Recibe un csvRow + todos los
PNs del cliente (prefetcheados) y devuelve ClassificationResult con
classification, pase, targetPnId y candidates ranked top 3. Anti-colisión
del Pase 2 implementada: si csv.IBMS y pn.IBMS son ambos no-vacíos y
distintos, no matchea (cae a Pase 3).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Bump de config (nonFinishLabelNames + version 1.0.0→1.1.0)

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Leer la sección actual de bulkUpload**

Run:
```bash
jq '.steelhead.domain.bulkUpload' remote/config.json
```
Expected: el objeto con `concurrency`, `retry`, `paging`, `preview`, `resume` (definidos en 1.0.0).

- [ ] **Step 2: Agregar `nonFinishLabelNames` a `steelhead.domain.bulkUpload`**

Edit `remote/config.json`: dentro de `steelhead.domain.bulkUpload`, agregar al final del objeto:

```json
,
"nonFinishLabelNames": [
  "SMY", "STX", "SXC", "SRG", "SCM", "SQ1", "SQ2",
  "NP desconocido", "En desarrollo", "Muestras", "Lote", "Obsoleto"
]
```

(JSON exacto — sin trailing comma fuera del array.)

- [ ] **Step 3: Bump `version` y `lastUpdated`**

Edit `remote/config.json`:
- `"version": "1.0.0"` → `"version": "1.1.0"`
- `"lastUpdated": "2026-05-18"` (o lo que esté) → `"lastUpdated": "2026-05-20"`

- [ ] **Step 4: Validar JSON**

Run: `jq '.' remote/config.json > /dev/null && echo "JSON OK"`
Expected: `JSON OK`. Si falla, fix syntax error (probablemente coma de más o de menos).

Run: `jq '.steelhead.domain.bulkUpload.nonFinishLabelNames | length' remote/config.json`
Expected: `12`.

- [ ] **Step 5: Commit (sin push todavía)**

```bash
git add remote/config.json
git commit -m "$(cat <<'EOF'
chore(config): nonFinishLabelNames + bump bulk-upload 1.0.0 → 1.1.0

Blacklist de etiquetas no-acabado (plantas SMY/STX/etc. y status NP
desconocido/En desarrollo/etc.) consumida por bulk-upload para construir
el composite key del Pase 2 del nuevo dedup.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Prefetch paginado de PNs por cliente

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (sección donde vive `checkPNExistence`, líneas 652-721)

- [ ] **Step 1: Leer la implementación actual de `checkPNExistence` para preservar la estructura del panel/log/runPool**

Run:
```bash
sed -n '652,721p' remote/scripts/bulk-upload.js
```
Tomar nota de cómo se invocan `setPanelPhase`, `setPanelProgress`, `withRetry`, `api().query`, `runPool`, `bailIfStale`. La nueva función reutiliza todo eso.

- [ ] **Step 2: Implementar `prefetchPNsByCustomer` como función nueva en el mismo bloque (antes de `checkPNExistence`)**

Insertar en `bulk-upload.js` justo antes de la línea 652 (`async function checkPNExistence`):

```js
  // ─── Prefetch paginado de PNs por cliente ───
  // Reemplaza el patrón previo "una llamada de AllPartNumbers por nombre" con
  // un prefetch por cliente único en el CSV. Para cada customerId, pagina hasta
  // agotar (o hasta hitCap) y devuelve la lista de PNs con shape mínimo
  // requerido por classifyOnePN: { id, name, metalBase, labels, quoteIBMS, archivedAt }.
  // Usa runPool con concurrencia para paralelizar páginas del MISMO cliente
  // cuando el catálogo es grande, pero los clientes se procesan secuencialmente
  // para que el log/panel sea legible.
  async function prefetchPNsByCustomer(customerIds, myRunId) {
    const cfg = bulkCfg();
    const pageSize = cfg.paging?.allPartNumbers?.first || 200;
    const maxResults = cfg.paging?.allPartNumbers?.maxResults || 50000;
    const result = new Map(); // customerId → [pn, ...]
    let custIdx = 0;
    for (const cid of customerIds) {
      if (myRunId != null) bailIfStale(myRunId);
      custIdx++;
      setPanelPhase(`Prefetch PNs cliente ${custIdx}/${customerIds.length}`);
      const pns = [];
      let offset = 0;
      while (offset < maxResults) {
        if (myRunId != null) bailIfStale(myRunId);
        const d = await withRetry(
          () => api().query('AllPartNumbers', {
            orderBy: ['ID_DESC'], offset, first: pageSize,
            customerIdFilter: [cid],
          }),
          `AllPartNumbers customerId=${cid} offset=${offset}`,
          myRunId
        );
        const nodes = d?.pagedData?.nodes || [];
        for (const n of nodes) {
          pns.push(extractPNShape(n));
        }
        setPanelProgress(pns.length, Math.min(d?.pagedData?.totalCount || pns.length, maxResults));
        if (nodes.length < pageSize) break;
        offset += pageSize;
      }
      log(`  cliente ${cid}: prefetch ${pns.length} PNs`);
      result.set(cid, pns);
    }
    return result;
  }

  // Extrae el shape mínimo de un nodo de AllPartNumbers.
  // Si el shape vivo no trae customInputs/labels, este punto es donde habría
  // que hacer follow-up con GetPartNumber (ver Task 0 step 2).
  function extractPNShape(n) {
    let ci = null;
    if (typeof n.customInputs === 'string') {
      try { ci = JSON.parse(n.customInputs); } catch { ci = null; }
    } else if (n.customInputs && typeof n.customInputs === 'object') {
      ci = n.customInputs;
    }
    const metalBase = ci?.DatosAdicionalesNP?.BaseMetal || '';
    const quoteIBMS = ci?.DatosAdicionalesNP?.QuoteIBMS || '';
    const labels = (n.partNumberLabelsByPartNumberId?.nodes || [])
      .map(x => x?.labelByLabelId?.name)
      .filter(Boolean);
    return {
      id: n.id,
      name: n.name,
      customerId: n.customerByCustomerId?.id || n.customerId,
      metalBase,
      quoteIBMS,
      labels,
      archivedAt: n.archivedAt || null,
      defaultProcessNodeId: n.processNodeByDefaultProcessNodeId?.id || n.defaultProcessNodeId || null,
    };
  }
```

- [ ] **Step 3: Exportar `extractPNShape` a `__helpers` y agregar test rápido**

Agregar `extractPNShape,` a `__helpers`.

Agregar al test file:

```js
test('extractPNShape parses customInputs JSON string', () => {
  const H = loadHelpers();
  const node = {
    id: 42,
    name: 'X',
    customInputs: '{"DatosAdicionalesNP":{"BaseMetal":"CU","QuoteIBMS":"Q1"}}',
    partNumberLabelsByPartNumberId: { nodes: [{ labelByLabelId: { name: 'NIQ' } }, { labelByLabelId: { name: 'SMY' } }] },
    archivedAt: null,
    customerByCustomerId: { id: 7 },
  };
  const r = H.extractPNShape(node);
  assert.equal(r.id, 42);
  assert.equal(r.metalBase, 'CU');
  assert.equal(r.quoteIBMS, 'Q1');
  assert.deepEqual(r.labels, ['NIQ', 'SMY']);
  assert.equal(r.customerId, 7);
});

test('extractPNShape handles missing/null customInputs gracefully', () => {
  const H = loadHelpers();
  const r = H.extractPNShape({ id: 1, name: 'Y', customInputs: null, partNumberLabelsByPartNumberId: null });
  assert.equal(r.metalBase, '');
  assert.equal(r.quoteIBMS, '');
  assert.deepEqual(r.labels, []);
});

test('extractPNShape accepts customInputs as object (not JSON string)', () => {
  const H = loadHelpers();
  const r = H.extractPNShape({ id: 1, name: 'Y', customInputs: { DatosAdicionalesNP: { BaseMetal: 'AL' } } });
  assert.equal(r.metalBase, 'AL');
});
```

- [ ] **Step 4: Correr tests**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 19/19 PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js tools/test/bulk-upload-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): prefetch paginado de PNs por cliente + extractPNShape

prefetchPNsByCustomer reemplaza el loop "una query por nombre" con un
prefetch por customerId único (orderBy ID_DESC, paging first=200,
maxResults=50000 default) y devuelve Map<customerId, PN[]>.
extractPNShape parsea customInputs (acepta JSON string u objeto) y
labels desde el nodo de AllPartNumbers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Refactor `checkPNExistence` → `classifyPNs` (orquestador con compatibilidad)

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Reescribir el cuerpo de `checkPNExistence`**

Reemplazar las líneas 652-721 (la totalidad de `async function checkPNExistence(parts, myRunId)`) por:

```js
  // ─── classifyPNs (reemplaza checkPNExistence) ───
  // Para cada parte del CSV:
  //   1. Prefetch PNs activos del cliente (cacheado por customerId).
  //   2. Invoca classifyOnePN puro.
  //   3. Construye un PNStatus retro-compatible con el resto del applet:
  //      - status === 'existing' cuando classification === 'MODIFY'
  //      - status === 'new'      cuando classification === 'NEW'
  //      - status === 'forceDup' cuando part.forzarDuplicado === true (overrides MODIFY)
  //   4. Embeds toda la info nueva (classification, pase, candidates, userOverride)
  //      en el mismo objeto para que el preview UI y el reporte XLSX la consuman.
  async function classifyPNs(parts, myRunId) {
    const cfg = bulkCfg();
    const nonFinishList = cfg.nonFinishLabelNames || [];
    const customerIds = [...new Set(parts.map(p => p.customerId).filter(Boolean))];
    setPanelPhase(`Clasificación: prefetch de ${customerIds.length} clientes`);
    const pnsByCustomer = await prefetchPNsByCustomer(customerIds, myRunId);

    setPanelPhase(`Clasificación: evaluando ${parts.length} filas`);
    const out = parts.map(p => {
      const csvRow = {
        customerId: p.customerId,
        name: p.pn,
        metalBase: p.metalBase || '',
        labels: p.labels || [],
        quoteIBMS: p.quoteIBMS || '',
      };
      const pnsForCustomer = pnsByCustomer.get(p.customerId) || [];
      const cls = classifyOnePN(csvRow, pnsForCustomer, nonFinishList);

      // Retro-compat: derivar status para que enrichWorker y demás sigan funcionando
      let status;
      if (p.forzarDuplicado && cls.classification === 'MODIFY') status = 'forceDup';
      else if (cls.classification === 'MODIFY') status = 'existing';
      else status = 'new';

      // Si forceDup pero NO hay target → degradar a 'new' (forzarDuplicado con NEW no tiene sentido)
      if (status === 'forceDup' && !cls.targetPnId) status = 'new';

      const pnTarget = cls.targetPnId ? pnsForCustomer.find(x => x.id === cls.targetPnId) : null;

      return {
        // Campos retro-compat (consumidos por código existente)
        pn: p.pn,
        status,
        existingId: cls.targetPnId,
        existingProcessId: pnTarget?.defaultProcessNodeId || null,
        qty: p.qty,
        precio: p.precio,
        customerId: p.customerId,

        // Campos nuevos del refactor
        classification: cls.classification,
        pase: cls.pase,
        confidence: cls.confidence,
        candidates: cls.candidates,
        userOverride: null,         // poblado en preview UI (Task 11)
        targetPnId: cls.targetPnId, // alias canónico de existingId
        csvRowKey: `${p.pn.toUpperCase()}|${p.customerId}`,
      };
    });

    log(`Clasificación: ${out.length} filas — Pase 1: ${out.filter(s => s.pase === 1).length}, Pase 2: ${out.filter(s => s.pase === 2).length}, Pase 3: ${out.filter(s => s.pase === 3).length}, NEW limpios: ${out.filter(s => s.pase === null).length}`);
    return out;
  }

  // Alias retro-compat: cualquier sitio que invoque checkPNExistence cae aquí.
  const checkPNExistence = classifyPNs;
```

- [ ] **Step 2: Verificar que el callsite (línea 1314) no necesita cambios**

Run: `grep -n "checkPNExistence\|classifyPNs" remote/scripts/bulk-upload.js`
Expected: la línea 1314 sigue diciendo `await checkPNExistence(parts, myRunId)` — el alias hace que funcione sin modificar la llamada.

- [ ] **Step 3: Smoke test del harness vm**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 19/19 PASS. El harness debe seguir cargando sin errores (no debe haber referencias rotas en bulk-upload.js).

Si falla con `ReferenceError: api is not defined` o similar al cargar: el alias está fuera del IIFE o referencia algo del scope externo. Mover dentro.

- [ ] **Step 4: Validación sintáctica con node**

Run:
```bash
node --check remote/scripts/bulk-upload.js
```
Expected: sin output (válido). Si falla, fix syntax.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "$(cat <<'EOF'
refactor(bulk-upload): classifyPNs reemplaza checkPNExistence con 3 pases

Orquestador que prefetchea PNs por cliente y llama classifyOnePN por
fila. Mantiene compatibilidad con el shape viejo de pnStatus (status:
new|existing|forceDup, existingId, existingProcessId) y agrega los
campos nuevos (classification, pase, candidates, userOverride,
csvRowKey) consumidos por el preview UI y el reporte XLSX.

Alias checkPNExistence = classifyPNs para no romper el callsite.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Preview UI — header de decisiones pendientes + filtro

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (función `showPreview`, alrededor de línea 737-1066)

- [ ] **Step 1: Localizar el bloque donde se construyen los chips/stats del preview**

Run: `grep -n "dl9-stats\|dl9-stat\b\|countByStatus\|new:\|exist:" remote/scripts/bulk-upload.js | head -20`

Anotar la línea donde se renderizan los conteos agregados (`X nuevas, Y existentes, Z forzadas`).

- [ ] **Step 2: Calcular conteo de decisiones pendientes y inyectar chip**

En `showPreview`, antes del primer render del modal, agregar el cálculo:

```js
      const pendingDecisions = pnStatus.filter(s => s.pase === 3);
      const pendingCount = pendingDecisions.length;
```

En el bloque de stats (probablemente dentro del innerHTML del modal o construido con `createElement`), agregar un chip nuevo:

```js
      // Chip de decisiones pendientes (Pase 3)
      const pendingChipHtml = pendingCount > 0
        ? `<div class="dl9-stat dl9-pending"><b>${pendingCount}</b> decisiones pendientes <button id="dl9-toggle-pending" class="dl9-btn dl9-btn-mini">Solo pendientes</button></div>`
        : '';
```

Y agregarlo en el HTML del header del modal donde están los demás `dl9-stat`.

CSS: en la regla `dl9-styles` (línea ~730) agregar:

```css
.dl9-pending{background:#7c2d12;color:#fed7aa}
.dl9-pending b{color:#fdba74}
.dl9-btn-mini{padding:2px 8px;font-size:11px;margin-left:8px;background:#9a3412;color:#fff}
.dl9-row-pending{background:rgba(124,45,18,0.15)}
```

- [ ] **Step 3: Implementar el toggle "Solo pendientes"**

Donde el preview tiene el rebind de filtros, agregar:

```js
      let filterPendingOnly = false;
      const pendingBtn = document.getElementById('dl9-toggle-pending');
      if (pendingBtn) {
        pendingBtn.addEventListener('click', () => {
          filterPendingOnly = !filterPendingOnly;
          pendingBtn.textContent = filterPendingOnly ? 'Mostrar todas' : 'Solo pendientes';
          rerender(); // función existente que repinta la página actual del preview
        });
      }
```

Y dentro de la función `rerender` (o equivalente — buscar donde se aplica el filtro de status/cliente), agregar el filtro nuevo:

```js
        let visibleRows = allRows;
        if (filterPendingOnly) {
          visibleRows = visibleRows.filter(r => pnStatus[r.idx]?.pase === 3);
        }
        // ... resto de filtros existentes
```

(El nombre exacto de las variables `allRows`, `r.idx`, `rerender` depende de la implementación actual de Fix 4. Adaptar al patrón existente.)

- [ ] **Step 4: Marcar filas Pase 3 con clase CSS distintiva**

En el render de cada `<tr>` del preview, agregar:

```js
        const isPending = pnStatus[i].pase === 3;
        const rowCls = isPending ? 'dl9-row-pending' : '';
        // ... en el <tr class="${rowCls}">
```

- [ ] **Step 5: Smoke test sintáctico**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin output.

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 19/19 PASS (los tests son sobre helpers puros, no UI; debe seguir verde).

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): preview UI con chip de decisiones pendientes + filtro

Cuenta filas Pase 3 (NEW por default con candidatos cercanos), las pinta
con background tenue, y agrega botón "Solo pendientes" que filtra la
tabla del preview a esas filas.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Preview UI — dropdown por fila Pase 3 con 3 links a candidatos

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (renderer de filas en `showPreview`)

- [ ] **Step 1: Localizar el render del `<td>` de status en el preview**

Run: `grep -n "dl9-new\|dl9-exist\|dl9-dup\|status.status\|class=\"dl9-" remote/scripts/bulk-upload.js | head -20`

Identificar la línea donde se renderiza el badge "Nuevo / Existente / Duplicado" en cada fila.

- [ ] **Step 2: Construir helper `renderStatusCell` que genere el dropdown en Pase 3**

Agregar dentro del IIFE de `BulkUpload` (no necesariamente exportado a `__helpers` porque toca DOM):

```js
  function renderStatusCell(pnStatusRow, csvRowIdx) {
    // Filas no-Pase 3: badge plano como hoy
    if (pnStatusRow.pase !== 3) {
      if (pnStatusRow.status === 'new') return '<span class="dl9-new">Nuevo</span>';
      if (pnStatusRow.status === 'forceDup') return '<span class="dl9-dup">Duplicado forzado</span>';
      return '<span class="dl9-exist">Modificar</span>';
    }
    // Pase 3: dropdown con default NEW y candidatos como opciones
    const options = ['<option value="">Crear nuevo</option>'];
    for (const c of pnStatusRow.candidates) {
      const safeMetal = (c.metalBase || '—').replace(/"/g, '&quot;');
      const safeAcabados = (c.labels || []).join(', ').replace(/"/g, '&quot;');
      const safeIbms = (c.quoteIBMS || '—').replace(/"/g, '&quot;');
      const tip = `metalBase: ${safeMetal} | acabados: ${safeAcabados} | IBMS: ${safeIbms}`;
      options.push(`<option value="${c.id}" title="${tip}">Modificar #${c.id}</option>`);
    }
    const linksHtml = pnStatusRow.candidates.map(c =>
      `<a href="https://app.gosteelhead.com/PartNumbers/${c.id}" target="_blank" rel="noopener" class="dl9-cand-link" title="Abrir ficha de PN #${c.id} en nueva pestaña">🔗</a>`
    ).join('');
    const selVal = pnStatusRow.userOverride != null ? String(pnStatusRow.userOverride) : '';
    return `
      <select class="dl9-cls-select" data-row-idx="${csvRowIdx}">
        ${options.map(opt => opt.replace(/value="([^"]*)"/, (m, v) => v === selVal ? `${m} selected` : m)).join('')}
      </select>
      <span class="dl9-cand-links">${linksHtml}</span>
    `;
  }
```

- [ ] **Step 3: Llamar `renderStatusCell` desde el row renderer existente**

Reemplazar el código existente que produce el badge de status (probablemente algo como `const statusHtml = s.status === 'new' ? '<span class="dl9-new">Nuevo</span>' : ...`) por:

```js
        const statusHtml = renderStatusCell(pnStatus[r.idx], r.idx);
```

- [ ] **Step 4: Wire up el `change` listener del dropdown para persistir override**

En la parte del `showPreview` que rebindea eventos después de cada `rerender()` (similar al patrón del toggle "Solo pendientes" de Task 9):

```js
      modal.querySelectorAll('.dl9-cls-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.rowIdx, 10);
          const val = e.target.value;
          if (val === '') {
            pnStatus[idx].userOverride = null;
            pnStatus[idx].status = 'new';
            pnStatus[idx].existingId = null;
          } else {
            const newTargetId = parseInt(val, 10);
            pnStatus[idx].userOverride = newTargetId;
            pnStatus[idx].status = 'existing';
            pnStatus[idx].existingId = newTargetId;
            // existingProcessId: lookup en candidates (si existe) o null
            const cand = pnStatus[idx].candidates.find(c => c.id === newTargetId);
            pnStatus[idx].existingProcessId = cand?.defaultProcessNodeId || null;
          }
          // Recomputar stats del header (Nuevo/Existente/etc.)
          updateHeaderStats();
        });
      });
```

Donde `updateHeaderStats` es la función existente que repinta los chips del header (buscar nombre real en el código actual de Fix 4 — debe existir para soportar filtros).

CSS extra en `dl9-styles`:

```css
.dl9-cls-select{background:#1e293b;color:#e2e8f0;border:1px solid #475569;padding:2px 6px;border-radius:4px;font-size:12px;max-width:160px}
.dl9-cand-links{display:inline-flex;gap:4px;margin-left:6px}
.dl9-cand-link{color:#38bdf8;text-decoration:none;font-size:14px}
.dl9-cand-link:hover{color:#7dd3fc}
```

- [ ] **Step 5: Smoke test sintáctico**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin output.

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 19/19 PASS.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): dropdown Pase 3 con links a fichas de candidatos

Cada fila Pase 3 muestra un dropdown con "Crear nuevo" (default) +
hasta 3 candidatos "Modificar #<id>". A la derecha del dropdown, links
🔗 que abren https://app.gosteelhead.com/PartNumbers/<id> en pestaña
nueva. El override se persiste en pnStatus[idx].userOverride y dispara
recompute de stats del header.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Persistencia del override entre páginas del preview + aplicación al confirmar

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Verificar que el render re-aplica el `selected` correcto al paginar**

En el dropdown render (Task 10 step 2), la lógica ya lee `pnStatus[idx].userOverride` para marcar la opción seleccionada. Solo confirmar que al cambiar de página del preview, el render se ejecuta de nuevo y respeta esa selección.

Localizar la función de paginación (probablemente `goToPage(n)` o `rerender(pageIdx)`) y confirmar que invoca el row renderer.

- [ ] **Step 2: Localizar el código de confirmación del preview**

Run: `grep -n "selectedIndices\|Aplicar\|Iniciar carga\|dl9-btn-exec\|resolve(selectedIndices)" remote/scripts/bulk-upload.js | head -20`

- [ ] **Step 3: Confirmar que el applet ya respeta el `existingId` modificado**

El handler del botón "Iniciar carga" (línea ~1434 según el grep previo) hace:
```js
const selectedIndices = await showPreview(...)
// luego filtra parts y pnStatus por selectedIndices
```

El `pnStatus[i].existingId` modificado en Task 10 step 4 es lo que `enrichWorker` lee (líneas 1814+) para decidir MODIFY vs CREATE. **Por lo tanto no hace falta cambio adicional en el código de confirmación.** Solo verificar.

- [ ] **Step 4: Agregar test manual smoke en el archivo de tests para documentar el flow esperado**

Agregar al test file (no es un test real, es un test que valida la SHAPE del PNStatus post-override):

```js
test('PNStatus post-override mantiene shape compatible con enrichWorker', () => {
  // Este test no llama código del applet; documenta el shape esperado.
  const simulatedStatus = {
    pn: 'X',
    status: 'existing',           // post-override en Pase 3
    existingId: 100,              // = userOverride
    existingProcessId: null,
    qty: 1,
    precio: 0,
    customerId: 7,
    classification: 'NEW',         // ojo: classification NO cambia con override
    pase: 3,
    confidence: 'near-match-name',
    candidates: [{ id: 100, name: 'X', metalBase: 'CU', labels: [], quoteIBMS: '', defaultProcessNodeId: null }],
    userOverride: 100,
    targetPnId: null,              // sigue null; el "target final" se deriva de existingId
    csvRowKey: 'X|7',
  };
  // enrichWorker mira status === 'existing' && existingId — debe entrar en MODIFY
  assert.equal(simulatedStatus.status, 'existing');
  assert.equal(simulatedStatus.existingId, 100);
});
```

- [ ] **Step 5: Correr tests**

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 20/20 PASS.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/bulk-upload.js tools/test/bulk-upload-helpers.test.js
git commit -m "$(cat <<'EOF'
test(bulk-upload): documentar shape de PNStatus post-override

El override del dropdown Pase 3 modifica status/existingId/existingProcessId
en-place; el handler de confirmación del preview ya filtra por
selectedIndices sin requerir cambios. Test de shape protege contra
regresiones donde alguien renombre los campos retro-compat.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Extender resume schema con `classifications`

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (sección de resume, líneas 71-180 aprox.)

- [ ] **Step 1: Localizar el schema actual del resume**

Run:
```bash
sed -n '115,160p' remote/scripts/bulk-upload.js
```
Identificar la estructura `{ runKey, phase, completedPNs, failedPNs, quoteId, quoteAction, lastUpdatedAt, ... }` del resume snapshot.

- [ ] **Step 2: Agregar campo `classifications` al snapshot inicial**

Localizar el bloque que crea `resumeState = { ... }` (línea ~1146 según el grep previo). Agregar:

```js
        resumeState = {
          // ... campos existentes ...
          classifications: null, // se llena tras el classifyPNs, antes del preview
        };
```

- [ ] **Step 3: Persistir `classifications` después del `classifyPNs` y antes del preview**

En la línea 1314 después del `const pnStatus = await checkPNExistence(parts, myRunId);`, agregar:

```js
      // Persist classifications para sobrevivir crash + resume
      if (resumeState) {
        resumeState.classifications = pnStatus.map(s => ({
          csvRowKey: s.csvRowKey,
          classification: s.classification,
          pase: s.pase,
          targetPnId: s.targetPnId,
          userOverride: s.userOverride,
          candidates: s.candidates.map(c => c.id), // solo ids para keep snapshot pequeño
        }));
        await persistResumeState();
      }
```

- [ ] **Step 4: Persistir cambios de `userOverride` cada vez que el usuario cambia el dropdown**

En el `change` listener del dropdown (Task 10 step 4), después de actualizar `pnStatus[idx]`, agregar:

```js
          // Persist override en resume (best-effort, no awaitear)
          if (resumeState) {
            const slot = resumeState.classifications?.[idx];
            if (slot) slot.userOverride = pnStatus[idx].userOverride;
            persistResumeState().catch(() => {});
          }
```

- [ ] **Step 5: Restaurar overrides al reanudar (resume path)**

Localizar el bloque que restaura `resumeState = prev` (línea ~1136). Después de invocar `classifyPNs`, agregar lógica de re-aplicar overrides:

```js
      // Restaurar userOverrides desde resume si existen
      if (resumeState?.classifications) {
        for (let i = 0; i < pnStatus.length; i++) {
          const prevSlot = resumeState.classifications.find(c => c.csvRowKey === pnStatus[i].csvRowKey);
          if (prevSlot?.userOverride != null) {
            pnStatus[i].userOverride = prevSlot.userOverride;
            pnStatus[i].existingId = prevSlot.userOverride;
            pnStatus[i].status = 'existing';
            // existingProcessId se queda como null hasta que el usuario re-abra el preview
            // (el resume restaura la decisión, no los datos cacheados del candidato)
          }
        }
      }
```

- [ ] **Step 6: Validación sintáctica**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin output.

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 20/20 PASS.

- [ ] **Step 7: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): persistir classifications + userOverride en resume

Extiende el snapshot de localStorage con classifications[] (csvRowKey,
classification, pase, targetPnId, userOverride, candidate ids). Se
persiste tras el classifyPNs y se actualiza cada vez que el usuario
cambia un dropdown del Pase 3. Al reanudar, los overrides se re-aplican
sobre el pnStatus fresh; los datos cacheados de candidates no se
restauran (el usuario re-abre preview si necesita ver detalles).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Reporte XLSX `generateRunReport`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`
- (Posible) Modify: `extension/background.js` (asegurar que xlsx.full.min.js se inyecta antes de bulk-upload)

- [ ] **Step 1: Verificar que XLSX está disponible cuando bulk-upload corre**

Run:
```bash
grep -n "xlsx.full.min\|window.XLSX\|injectXLSX\|case 'run-csv'" extension/background.js
```
Expected: encontrar el handler `case 'run-csv'` y verificar si ya inyecta XLSX. Probablemente no.

Si no inyecta XLSX, agregar al handler de `case 'run-csv'`:

```js
      case 'run-csv': {
        // Inyectar XLSX si no está presente (para el reporte de bulk-upload 1.1.0+)
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function() {
            return typeof window.XLSX !== 'undefined';
          }
        }).then(async (results) => {
          if (!results?.[0]?.result) {
            const xlsxCode = await fetchScriptCode('scripts/lib/xlsx.full.min.js');
            await chrome.scripting.executeScript({
              target: { tabId: sender.tab.id },
              world: 'MAIN',
              func: function(code) { new Function(code)(); },
              args: [xlsxCode],
            });
          }
        });
        // ... resto del handler existente
      }
```

(Adaptar al patrón exacto del código actual; ver `case 'run-process-deep-audit'` como ejemplo.)

- [ ] **Step 2: Implementar `generateRunReport` en bulk-upload.js**

Insertar antes de `showResult` (línea ~1067) la función:

```js
  // ─── Reporte XLSX del run ───
  function generateRunReport(state, pnStatus, stats, errors) {
    if (typeof window.XLSX === 'undefined') {
      warn('XLSX no disponible; reporte saltado.');
      return null;
    }
    const wb = window.XLSX.utils.book_new();

    // ── Hoja Resumen ──
    const counts = {
      total: pnStatus.length,
      newClean: pnStatus.filter(s => s.classification === 'NEW' && s.pase === null).length,
      pase1: pnStatus.filter(s => s.pase === 1).length,
      pase2: pnStatus.filter(s => s.pase === 2).length,
      pase3Default: pnStatus.filter(s => s.pase === 3 && s.userOverride == null).length,
      pase3Override: pnStatus.filter(s => s.pase === 3 && s.userOverride != null).length,
      errors: errors.length,
      omitidas: stats?.omitidas || 0,
    };
    const resumenAoa = [
      ['Métrica', 'Conteo'],
      ['PNs procesados', counts.total],
      ['NEW limpios (sin candidatos)', counts.newClean],
      ['MODIFY Pase 1 (IBMS)', counts.pase1],
      ['MODIFY Pase 2 (composite)', counts.pase2],
      ['NEW Pase 3 (default)', counts.pase3Default],
      ['MODIFY Pase 3 (override)', counts.pase3Override],
      ['Errores', counts.errors],
      ['Omitidas', counts.omitidas],
    ];
    const wsResumen = window.XLSX.utils.aoa_to_sheet(resumenAoa);
    window.XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // ── Hoja Decisiones Pase 3 ──
    const pase3Headers = [
      'CSVRow', 'PN', 'Cliente', 'QuoteIBMS_CSV', 'MetalBase_CSV', 'Acabados_CSV',
      'DecisionFinal', 'CandidatoElegido', 'CandidatoLink',
      'Candidato1', 'Candidato2', 'Candidato3',
    ];
    const pase3Rows = [pase3Headers];
    pnStatus.forEach((s, i) => {
      if (s.pase !== 3) return;
      const decision = s.userOverride != null ? 'MODIFY' : 'NEW';
      const chosen = s.userOverride || '';
      const link = s.userOverride ? `https://app.gosteelhead.com/PartNumbers/${s.userOverride}` : '';
      pase3Rows.push([
        i + 1, s.pn, s.customerId, '', '', '',  // QuoteIBMS_CSV, MetalBase_CSV, Acabados_CSV se rellenan desde parts (ver step 3)
        decision, chosen, link,
        s.candidates[0]?.id || '',
        s.candidates[1]?.id || '',
        s.candidates[2]?.id || '',
      ]);
    });
    const wsPase3 = window.XLSX.utils.aoa_to_sheet(pase3Rows);
    window.XLSX.utils.book_append_sheet(wb, wsPase3, 'Decisiones Pase 3');

    // ── Hoja Errores ──
    const erroresAoa = [['Mensaje']].concat(errors.map(e => [e]));
    const wsErrores = window.XLSX.utils.aoa_to_sheet(erroresAoa);
    window.XLSX.utils.book_append_sheet(wb, wsErrores, 'Errores');

    // Descargar
    const runKey = state?.runKey || resumeState?.runKey || 'no-key';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fname = `bulk-upload-report-${runKey.slice(0, 8)}-${ts}.xlsx`;
    const wbout = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    log(`Reporte XLSX descargado: ${fname}`);
    return fname;
  }
```

- [ ] **Step 3: Enriquecer la hoja Pase 3 con datos del CSV (`parts`)**

Para que las columnas `QuoteIBMS_CSV`, `MetalBase_CSV`, `Acabados_CSV` se llenen, pasar `parts` a `generateRunReport`:

Cambiar firma: `function generateRunReport(state, pnStatus, parts, stats, errors)`.

Y dentro del loop de `pase3Rows.push`, sustituir los strings vacíos por:
```js
        parts[i]?.quoteIBMS || '',
        parts[i]?.metalBase || '',
        (parts[i]?.labels || []).join(','),
```

- [ ] **Step 4: Invocar `generateRunReport` antes de `showResult`**

En `execute()`, justo antes de `showResult(stats, quoteUrl, errors, quoteUrlLabel);` (línea ~2401):

```js
      try {
        generateRunReport(state, pnStatus, parts, stats, errors);
      } catch (e) {
        warn(`Reporte XLSX falló: ${e.message}`);
      }
```

- [ ] **Step 5: Smoke test sintáctico**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin output.

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 20/20 PASS.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/bulk-upload.js extension/background.js
git commit -m "$(cat <<'EOF'
feat(bulk-upload): reporte XLSX al final del run con 3 hojas

generateRunReport produce un .xlsx con Resumen (conteos por pase),
Decisiones Pase 3 (una fila por candidato evaluado con links a la ficha
del PN elegido) y Errores. Se inyecta XLSX en el handler run-csv de
background.js si no estaba ya cargado (mismo patrón que process-deep-audit).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Bump VERSION del applet a 1.1.0 + ajustes finales

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Bumpear VERSION**

En la línea 15:
```js
  const VERSION = '1.0.0';
```
→
```js
  const VERSION = '1.1.0';
```

- [ ] **Step 2: Actualizar el header del archivo con bitácora 1.1.0**

En las líneas 1-11 del archivo (comentarios de cabecera), agregar antes del bloque de Fixes:

```js
//
// Version 1.1.0 (2026-05-20): Dedup por QuoteIBMS + composite con override manual
//   - Pase 1 IBMS autoritativo, Pase 2 composite exacto con regla anti-colisión,
//     Pase 3 near-match con dropdown en preview + links a candidatos
//   - Blacklist nonFinishLabelNames en config para distinguir acabados vs plantas/status
//   - Prefetch paginado por cliente (reemplaza loop "una query por nombre")
//   - Reporte XLSX al final del run (Resumen + Decisiones Pase 3 + Errores)
//   - Resume schema extendido con classifications + userOverride
//   - Tests Node de helpers puros en tools/test/bulk-upload-helpers.test.js
```

- [ ] **Step 3: Validación final**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin output.

Run: `node --test tools/test/bulk-upload-helpers.test.js`
Expected: 20/20 PASS.

Run: `jq '.steelhead.scripts."bulk-upload".version' remote/config.json 2>/dev/null || jq '.version' remote/config.json`
Expected: `"1.1.0"`.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "$(cat <<'EOF'
chore(bulk-upload): bump VERSION 1.0.0 → 1.1.0 + bitácora en header

Cierre del refactor de dedup por QuoteIBMS + composite + override manual.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Smoke test manual contra Steelhead staging

**Files:** ninguno (validación manual)

> **Important:** Esta tarea es manual y requiere acceso al Steelhead live del usuario. La realiza el usuario, NO un subagent. El subagent debe DETENERSE aquí y pedir al usuario que ejecute los pasos.

- [ ] **Step 1: Indicar al usuario que recargue la extensión en Chrome**

Mensaje al usuario:
> "Va a hacer falta tu mano. Abre `chrome://extensions/` → busca SteelheadAutomator → click en el ícono de reload. Después, abre Steelhead y verifica que el panel del applet bulk-upload muestre 'v1.1.0' en algún lado del modal (puede estar en el log inicial)."

- [ ] **Step 2: Pedir al usuario que prepare CSV de 10 filas**

Mensaje:
> "Prepara un CSV de prueba con 10 filas representando casos del spec §10:
> - 2 filas con QuoteIBMS conocido y exactamente igual a un PN existente (Caso 1)
> - 2 filas con QuoteIBMS pero PN target tiene QuoteIBMS distinto, composite también (Pase 3 con candidato)
> - 2 filas SIN QuoteIBMS pero composite exacto con PN existente (Caso 4)
> - 2 filas con name conocido pero metalBase distinto (Caso 6, Pase 3)
> - 2 filas con name nuevo, sin matches (Caso 7)
> Usa una cotización TEST temporal para que no contamine producción."

- [ ] **Step 3: Validar visualmente el preview**

Mensaje:
> "Lanza la carga, llega al preview, y confirma:
> - El chip 'X decisiones pendientes' aparece arriba con el número correcto (4 si hiciste el CSV de arriba).
> - Las filas Pase 3 tienen un dropdown 'Crear nuevo / Modificar #ID' con hasta 3 candidatos.
> - Cada candidato tiene un link 🔗 al lado que abre la ficha del PN en pestaña nueva.
> - El toggle 'Solo pendientes' filtra la tabla a esas 4 filas y vuelve a mostrar todas al apagarlo.
> - Cambiar el dropdown de NEW a Modificar #ID re-pinta el chip (Existente sube en 1, Pendientes baja en 1)."

- [ ] **Step 4: Validar resume tras crash**

Mensaje:
> "Selecciona overrides en 2-3 filas Pase 3. Cierra la tab de Chrome a propósito (NO confirmar la carga aún). Vuelve a abrir Steelhead, recarga el applet, vuelve a subir el MISMO CSV. Debe aparecer modal de reanudación. Acepta. Verifica que llegas al preview con los mismos overrides ya seleccionados."

- [ ] **Step 5: Ejecutar la carga real y validar XLSX**

Mensaje:
> "Confirma 'Iniciar carga'. Al terminar, debe descargarse automáticamente `bulk-upload-report-XXXX.xlsx`. Ábrelo en Excel y verifica:
> - Hoja Resumen tiene los 9 conteos con números que cuadren con tu CSV de 10.
> - Hoja 'Decisiones Pase 3' tiene 4 filas con sus links clickeables.
> - Hoja Errores está vacía (o con los esperados si rompiste algo a propósito)."

- [ ] **Step 6: Validar en UI nativo de Steelhead**

Mensaje:
> "Abre 2-3 PNs random del run en `https://app.gosteelhead.com/PartNumbers/<id>` y confirma que:
> - El name, metalBase, etiquetas y QuoteIBMS quedaron exactamente como el CSV.
> - Los PNs que clasificaste como NEW efectivamente se crearon.
> - Los PNs que clasificaste con override 'Modificar #ID' pisaron al PN target (revisa que el name/IBMS del PN existente ahora son los del CSV)."

> **STOP**: si el smoke test pasa, continuar a Task 16. Si falla, abrir nueva sesión con screenshot del error + XLSX descargado.

---

## Task 16: Deploy a gh-pages

**Files:**
- N/A (operación de git)

> **Important:** Tarea ejecutada por el usuario o supervisada paso a paso. Sigue el procedimiento de CLAUDE.md → "Deploy a producción".

- [ ] **Step 1: Confirmar que `main` está limpio post-smoke**

Run: `git status -s`
Expected: working tree clean.

Run: `git log --oneline -10`
Expected: últimos commits son los del refactor 1.1.0.

- [ ] **Step 2: Sync a `gh-pages` siguiendo el patrón "stash + checkout + cp"**

Run (en orden, NO en paralelo):
```bash
# Si hay cambios pendientes en .xlsm o similar, stashearlos
git stash push -u -m "wip-deploy" -- Plantilla_Cotizaciones_y_NP_v84_1.xlsm 2>/dev/null || true

# Capturar SHA del main para verificación posterior
MAIN_SHA=$(git rev-parse HEAD)
echo "main SHA: $MAIN_SHA"

# Switch a gh-pages
git checkout gh-pages

# Copiar artefactos desde el checkout de main (worktree mental: ../main-checkout/ o lo que use el usuario)
# En este repo, las copias vienen del HEAD de main vía git show:
git show ${MAIN_SHA}:remote/scripts/bulk-upload.js > scripts/bulk-upload.js
git show ${MAIN_SHA}:remote/config.json > config.json

# Validar byte-exact
diff <(git show ${MAIN_SHA}:remote/scripts/bulk-upload.js) scripts/bulk-upload.js && echo "bulk-upload.js OK"
diff <(git show ${MAIN_SHA}:remote/config.json) config.json && echo "config.json OK"
```
Expected: ambos diffs sin output (idénticos).

- [ ] **Step 3: Commit en `gh-pages`**

```bash
git add scripts/bulk-upload.js config.json
git commit -m "deploy: bulk-upload 1.1.0 — dedup por QuoteIBMS + composite + override + reporte XLSX + bump 1.1.0"
```

- [ ] **Step 4: Push ambas ramas**

```bash
git push origin gh-pages
git checkout main
git stash pop 2>/dev/null || true
# NO pushear main automáticamente — el usuario decide cuándo
echo "Listo. Pushea main manualmente cuando quieras: git push origin main"
```

- [ ] **Step 5: Esperar 30-60s a que GitHub Pages publique + reload extensión**

Mensaje al usuario:
> "Espera 30-60 segundos. Después, en `chrome://extensions/` recarga SteelheadAutomator. Si Chrome tiene cacheado el config viejo, reinicia Chrome completo.
> Para validar que el applet en producción es 1.1.0, abre Steelhead → corre el applet de bulk-upload con cualquier CSV → verifica en el log inicial que dice `VERSION 1.1.0`."

- [ ] **Step 6: Update CLAUDE.md con bitácora del deploy**

Agregar a `CLAUDE.md` una nueva sección bajo "## API de Steelhead" siguiendo el patrón de las secciones `bulk-upload 1.0.0` y `spec-params-bulk 0.9.0`:

```markdown
### `bulk-upload` 1.1.0: dedup por QuoteIBMS + composite + override manual (2026-05-20, deploy `<SHA_main>` main / `<SHA_gh-pages>` gh-pages, validación en prod PENDIENTE)
... (resumen de cambios, files tocados, lecciones del ciclo) ...
```

Run:
```bash
git add CLAUDE.md
git commit -m "docs(claude): bitácora bulk-upload 1.1.0 dedup refactor"
```

---

## Self-Review

**1. Spec coverage:**
| Sección spec | Task(s) |
|---|---|
| §1 Problema | Cubierto por refactor de checkPNExistence (T8) |
| §2 Objetivo | Cubierto por T2-T8 (los 3 pases) |
| §3 Algoritmo (Pase 1) | T5 (classifyOnePN) + T8 (integración) |
| §3 Algoritmo (Pase 2 con anti-colisión) | T5 + T8 |
| §3 Algoritmo (Pase 3) | T5, T10 (dropdown), T11 (persistencia) |
| §3 acabadosOrdenados | T2 |
| §4 Blacklist config | T6 |
| §5 Modo MODIFY pisa todo | Sin cambio nuevo — el applet ya pisa name+labelIds+CI (T0 step 3 confirma). |
| §6.1 Header decisiones pendientes | T9 |
| §6.2 Filtro "Solo pendientes" | T9 |
| §6.3 Dropdown + links | T10 |
| §6.4 Persistencia override | T11 + T12 (resume) |
| §7 Reporte XLSX | T13 |
| §8 Cambios concretos | Distribuidos en T7-T14 |
| §9 Shape ClassificationResult | T5 (definido), T8 (integrado en pnStatus) |
| §10 Cobertura 7 casos | T5 (tests) + T15 (smoke manual) |
| §11 Tradeoffs | Documentado en CLAUDE.md post-deploy (T16 step 6) |
| §12 Fuera de alcance | N/A (explícitamente no se implementa) |
| §13 Plan de pruebas | T15 (smoke manual) |

**2. Placeholder scan:** No "TODO", "TBD", "implement later". Todos los steps tienen código completo o comandos exactos.

**3. Type consistency:**
- `pnStatus[i].existingId` (campo legacy) y `pnStatus[i].targetPnId` (campo nuevo): ambos coexisten en el shape (T8). Documentado en T11 step 4. **Consistente.**
- `userOverride` siempre es `number | null` (id del PN, no string). Verificado en T10 step 4 (`parseInt(val, 10)`) y T11 step 4. **Consistente.**
- `nonFinishLabelNames` siempre es `string[]`. Verificado en T2, T6, T8. **Consistente.**
- `customerIds` en `prefetchPNsByCustomer` es `number[]`, viene de `Set` de `parts.map(p => p.customerId)`. **Consistente.**

**4. Risks not yet mitigated:**
- Si `AllPartNumbers` con `customerIdFilter: [cid]` no es un parámetro válido del shape vivo (T0 no lo verifica explícitamente; solo verifica el response shape), Task 7 fallará en runtime. **Mitigación**: Task 0 step 2 debe ampliarse para capturar el `inputKeys` de `AllPartNumbers.variablesSamples[0]` y validar que `customerIdFilter` exista. Si no, fallback a paginar por nombre solo cuando aplique.

Aplicar el fix inline:

---

## Execution Handoff

Plan completo y guardado en `docs/superpowers/plans/2026-05-20-bulk-upload-quoteibms-dedup.md`. Dos opciones de ejecución:

**1. Subagent-Driven (recomendado)** — Despacho un subagent fresco por cada tarea, reviso entre tareas, iteración rápida.

**2. Inline Execution** — Ejecuto las tareas en esta sesión usando executing-plans, batches con checkpoints para review.

¿Cuál prefieres?
