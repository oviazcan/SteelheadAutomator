# Bulk Uploader Refactor — F1: Módulos puros + golden tests + probe

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraer las funciones puras (parse + classify) de `bulk-upload.js` a módulos testeables, congelar su comportamiento con golden tests (`node --test`), y crear un probe de lectura no destructiva contra el ERP — todo SIN cambiar comportamiento.

**Architecture:** Characterization testing. Se copian las funciones puras tal cual a módulos nuevos con dual-export (browser `window.*` / Node `module.exports`, igual que `bulk-upload-cc.js`); se escriben golden tests que PASAN contra esa copia fiel (capturan el comportamiento actual); luego se cablea `bulk-upload.js` para consumir los módulos y se borran las definiciones internas. El probe Python reutiliza la auth de Reportes SH (`steelhead_auth.get_access_token`) + los hashes de `config.json` para validar shapes de respuesta.

**Tech Stack:** JavaScript vanilla (IIFE, sin bundler), `node --test`, Python 3 (`requests`), Apollo persisted queries.

**Spec:** `docs/superpowers/specs/2026-06-06-bulk-upload-refactor-design.md`

---

## Referencia: firmas exactas (verificadas en el código actual)

```js
// bulk-upload.js:1025-1033
const toBool = (v) => { const s=(v||'').toString().trim().toUpperCase(); return s==='SI'||s==='SÍ'||s==='YES'||s==='1'||s==='TRUE'||s==='V'||s==='VERDADERO'; };
const g  = (row,i) => { const v=(row[i]||'').trim().replace(/\s+/g,' '); if (v==='(seleccione)'||v==='(seleccione o escriba)') return ''; return v; };
const gn = (row,i) => { const v=parseFloat(g(row,i)); return isNaN(v)?null:v; };
// bulk-upload.js:1430-1440
const isDash = (v) => v === '-';
const resolveStr = (raw, existing) => { if (raw===''||raw===undefined) return existing; if (isDash(raw)) return ''; return raw; };
const resolveNum = (raw, existing) => { if (raw===null||raw===undefined) return existing; if (typeof raw==='string'&&isDash(raw)) return null; return raw; };
```

`parseCSV` (L1069-1093), `parseRows` (L1095-~1408), `buildDimensions` (L1420-1427), `resolveUnitId` (L1409),
`PRICE_UNIT_MAP` (L1035), `PREDICTIVE_MATERIALS` (L1038-1048), `HEADER_KEYS` (L1054-1063), COLS v10/v11 (comentados L1101-1132).

Classify (L6510-6996): `normLabel`, `isNonFinishLabel`, `buildEquivIndex`, `equivGroup`, `equivalentValues`,
`acabadosOrdenados`, `acabadosCanonicos`, `metalCanonico`, `buildCompositeKey`, `rankCandidates`,
`classifyOnePN`, `dedupModifyTargets`, `detectCsvDuplicates`, `chunkParts`.

---

## Task 1: Probe de lectura no destructiva (`tools/steelhead_probe.py`)

**Files:**
- Create: `tools/steelhead_probe.py`

- [ ] **Step 1: Escribir el probe**

```python
#!/usr/bin/env python3
"""steelhead_probe.py — Lecturas NO DESTRUCTIVAS contra Steelhead /graphql.

Reutiliza la auth de Reportes SH (steelhead_auth.get_access_token) y los hashes
de persisted queries del extension (remote/config.json). SOLO operaciones de
lectura — nunca mutaciones. Sirve para validar shapes de respuesta sin tocar datos.

Uso:
  python3 tools/steelhead_probe.py GetPartNumber '{"id": 123}'
  python3 tools/steelhead_probe.py AllSpecs '{"first": 5, "offset": 0}'
  python3 tools/steelhead_probe.py CurrentUserDetails '{}'
"""
import json, sys, pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
REPORTES = pathlib.Path.home() / "Projects/Ecoplating/Reportes SH"
sys.path.insert(0, str(REPORTES / "scripts"))

import requests  # noqa: E402
from steelhead_auth import get_access_token  # noqa: E402

GRAPHQL_URL = "https://app.gosteelhead.com/graphql"

# Operaciones de lectura permitidas (allowlist defensiva — el probe NUNCA muta).
READ_ONLY = {
    "GetPartNumber", "AllPartNumbers", "AllSpecs", "SpecFieldsAndOptions",
    "GetQuote_v8", "GetQuote_v71", "GetQuoteRelatedData", "CurrentUserDetails",
    "GetPartNumbersInputSchema", "AllLabels", "AllRackTypes", "AllProcesses",
    "PNGroupSelect", "SearchPartNumberPrices", "CustomerSearchByName",
}

def load_hashes():
    cfg = json.loads((REPO / "remote/config.json").read_text())
    h = cfg["steelhead"]["hashes"]
    return {**h.get("queries", {}), **h.get("mutations", {})}

def probe(operation, variables):
    if operation not in READ_ONLY:
        raise SystemExit(f"BLOQUEADO: '{operation}' no está en la allowlist de lectura.")
    hashes = load_hashes()
    if operation not in hashes:
        raise SystemExit(f"Sin hash para '{operation}' en config.json.")
    token = get_access_token()
    payload = {
        "operationName": operation,
        "variables": variables,
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": hashes[operation]}},
    }
    headers = {
        "content-type": "application/json",
        "apollographql-client-name": "steelhead-web",
        "apollographql-client-version": "1.0.0",
        "x-steelhead-idp-token": token,
    }
    r = requests.post(GRAPHQL_URL, json=payload, headers=headers, timeout=30)
    r.raise_for_status()
    return r.json()

if __name__ == "__main__":
    op = sys.argv[1] if len(sys.argv) > 1 else "CurrentUserDetails"
    vars_ = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(json.dumps(probe(op, vars_), indent=2, ensure_ascii=False))
```

- [ ] **Step 2: Probar contra el ERP (lectura real)**

Run: `python3 tools/steelhead_probe.py CurrentUserDetails '{}'`
Expected: JSON con `data.currentUserDetails` (o el shape que devuelva), sin `errors`. Si da 401/403 → invocar skill `steelhead-auth`.

- [ ] **Step 3: Validar shape de GetPartNumber (clave para el seed)**

Run: `python3 tools/steelhead_probe.py AllPartNumbers '{"first": 1, "offset": 0}'` para obtener un id real, luego `python3 tools/steelhead_probe.py GetPartNumber '{"id": <id>}'`
Expected: confirmar que existen los campos del seed: `customerByCustomerId.id`, `defaultProcessNodeId`/`processNodeBy...`, `partNumberLabelsByPartNumberId.nodes`, `partNumberDimensionsByPartNumberId.nodes`, `partNumberPricesByPartNumberId.nodes`, `partNumberLocationsByPartNumberId.nodes`, `customInputs`. Anotar en `docs/applets/bulk-upload.md` qué FK escalares llegan `null` (confirma invariante #3).

- [ ] **Step 4: Commit**

```bash
git add tools/steelhead_probe.py
git commit -m "feat(bulk-upload F1): probe de lectura no destructiva contra SH"
```

---

## Task 2: Extraer parser puro (`bulk-upload-parse.js`)

**Files:**
- Create: `remote/scripts/bulk-upload-parse.js`
- Reference: `remote/scripts/bulk-upload-cc.js` (patrón dual-export)

- [ ] **Step 1: Crear el módulo con dual-export y las funciones puras (copia fiel)**

Copiar EXACTAMENTE desde `bulk-upload.js`: `toBool` (L1025), `g`/`gn` (L1027-1033) — adaptadas a `g(row,i)` puras —, `isDash`/`resolveStr`/`resolveNum` (L1430-1440), `buildDimensions` (L1420-1427), `resolveUnitId` (L1409), `parseCSV` (L1069-1093), `parseRows` (L1095-fin), y las constantes `PRICE_UNIT_MAP`, `PREDICTIVE_MATERIALS`, `HEADER_KEYS`. Estructura:

```js
// bulk-upload-parse.js — funciones PURAS de parseo/normalización del CSV.
// Dual-export: window.SteelheadBulkParse (browser) / module.exports (node --test).
(function (root) {
  'use strict';

  const toBool = (v) => { const s=(v||'').toString().trim().toUpperCase(); return s==='SI'||s==='SÍ'||s==='YES'||s==='1'||s==='TRUE'||s==='V'||s==='VERDADERO'; };
  const isDash = (v) => v === '-';
  const resolveStr = (raw, existing) => { if (raw===''||raw===undefined) return existing; if (isDash(raw)) return ''; return raw; };
  const resolveNum = (raw, existing) => { if (raw===null||raw===undefined) return existing; if (typeof raw==='string'&&isDash(raw)) return null; return raw; };
  const cell = (row, i) => { const v=(row[i]||'').trim().replace(/\s+/g,' '); if (v==='(seleccione)'||v==='(seleccione o escriba)') return ''; return v; };
  const cellNum = (row, i) => { const v=parseFloat(cell(row,i)); return isNaN(v)?null:v; };

  // ... (parseCSV, buildDimensions, PRICE_UNIT_MAP, PREDICTIVE_MATERIALS, HEADER_KEYS
  //      copiados fielmente desde bulk-upload.js)

  // Detección de columnas presentes + intención de corrida (NUEVO, ver Task 3 Step 1).

  const api = { toBool, isDash, resolveStr, resolveNum, cell, cellNum, parseCSV, buildDimensions,
    PRICE_UNIT_MAP, PREDICTIVE_MATERIALS, HEADER_KEYS /*, detectColumns, classifyIntent */ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SteelheadBulkParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

Nota: `parseRows` depende de `DOMAIN`/config en runtime; en F1 se deja `parseRows` en `bulk-upload.js` (no es puro) y solo se extraen las funciones genuinamente puras de arriba. `detectColumns`/`classifyIntent` se agregan en Task 3.

- [ ] **Step 2: Commit (módulo sin cablear todavía)**

```bash
git add remote/scripts/bulk-upload-parse.js
git commit -m "feat(bulk-upload F1): módulo puro de parseo (copia fiel, sin cablear)"
```

---

## Task 3: Golden tests del parser + detección de intención

**Files:**
- Create: `tools/test_bulk_upload_parse.js`
- Modify: `remote/scripts/bulk-upload-parse.js` (agregar `detectColumns`/`classifyIntent`)

- [ ] **Step 1: Agregar `detectColumns` y `classifyIntent` a `bulk-upload-parse.js`**

```js
// Detecta qué grupos de columnas traen datos (scan de las filas de datos).
// rows: matriz post-parseCSV; layout: 'v10'|'v11' (índices de COLS).
function detectColumns(rows, dataStartIdx, COLS) {
  const has = { price: false, labels: false, dims: false, process: false,
    predictives: false, specs: false, racks: false, identifiers: false };
  for (let r = dataStartIdx; r < rows.length; r++) {
    const row = rows[r]; if (!row || !cell(row, COLS.pn)) continue;
    if (cell(row, COLS.precio)) has.price = true;
    for (const i of COLS.labels) if (cell(row, i)) has.labels = true;
    for (const i of COLS.dims) if (cell(row, i)) has.dims = true;
    if (cell(row, COLS.proceso)) has.process = true;
    for (const i of COLS.predictives) if (cell(row, i)) has.predictives = true;
    for (const i of COLS.specs) if (cell(row, i)) has.specs = true;
    for (const i of COLS.racks) if (cell(row, i)) has.racks = true;
  }
  return has;
}

// Clasifica la intención de la corrida a partir de las columnas con datos.
function classifyIntent(has, allExisting) {
  const enrich = has.labels || has.dims || has.process || has.predictives || has.specs || has.racks;
  if (has.price && !enrich && allExisting) return 'SOLO_PRECIO';
  if (enrich && !has.price) return 'AJUSTE_LINEA';
  if (enrich) return 'ENRIQUECIMIENTO';
  return 'ALTA';
}
```

Exportar ambas en `api`.

- [ ] **Step 2: Escribir los golden tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const P = require('../remote/scripts/bulk-upload-parse.js');

test('isDash', () => {
  assert.strictEqual(P.isDash('-'), true);
  assert.strictEqual(P.isDash(''), false);
  assert.strictEqual(P.isDash('x'), false);
});

test('resolveStr: vacío preserva, dash borra, dato sobrescribe', () => {
  assert.strictEqual(P.resolveStr('', 'viejo'), 'viejo');       // no tocar
  assert.strictEqual(P.resolveStr(undefined, 'viejo'), 'viejo');// no tocar
  assert.strictEqual(P.resolveStr('-', 'viejo'), '');           // borrar
  assert.strictEqual(P.resolveStr('nuevo', 'viejo'), 'nuevo');  // sobrescribir
});

test('resolveNum: null preserva, dash borra, número sobrescribe', () => {
  assert.strictEqual(P.resolveNum(null, 5), 5);
  assert.strictEqual(P.resolveNum(undefined, 5), 5);
  assert.strictEqual(P.resolveNum('-', 5), null);
  assert.strictEqual(P.resolveNum(7, 5), 7);
});

test('cell: trim, colapsa espacios, (seleccione) -> vacío', () => {
  assert.strictEqual(P.cell(['  a   b  '], 0), 'a b');
  assert.strictEqual(P.cell(['(seleccione)'], 0), '');
  assert.strictEqual(P.cell(['(seleccione o escriba)'], 0), '');
  assert.strictEqual(P.cell([], 0), '');
});

test('toBool: variantes ES', () => {
  for (const t of ['SI','Sí','yes','1','true','V','verdadero']) assert.strictEqual(P.toBool(t), true);
  for (const f of ['','no','0','false','x']) assert.strictEqual(P.toBool(f), false);
});

test('parseCSV: comillas, comas embebidas, CRLF', () => {
  const rows = P.parseCSV('a,b\r\n"x,y","z""q"\n');
  assert.deepStrictEqual(rows[0], ['a','b']);
  assert.deepStrictEqual(rows[1], ['x,y','z"q']);
});

test('classifyIntent: SOLO_PRECIO requiere precio + sin enrich + todos existentes', () => {
  assert.strictEqual(P.classifyIntent({price:true,labels:false,dims:false,process:false,predictives:false,specs:false,racks:false}, true), 'SOLO_PRECIO');
  assert.strictEqual(P.classifyIntent({price:true,labels:true}, true), 'ENRIQUECIMIENTO');
  assert.strictEqual(P.classifyIntent({price:true,labels:false}, false), 'ENRIQUECIMIENTO'); // un PN nuevo => no SOLO_PRECIO
  assert.strictEqual(P.classifyIntent({price:false,labels:true}, true), 'AJUSTE_LINEA');
  assert.strictEqual(P.classifyIntent({price:false,labels:false}, true), 'ALTA');
});
```

- [ ] **Step 3: Correr los tests**

Run: `node --test tools/test_bulk_upload_parse.js`
Expected: PASS (todos). Los de blank/dash/data congelan los invariantes #1.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/bulk-upload-parse.js tools/test_bulk_upload_parse.js
git commit -m "test(bulk-upload F1): golden tests del parser + detección de intención"
```

---

## Task 4: Extraer clasificador puro (`bulk-upload-classify.js`)

**Files:**
- Create: `remote/scripts/bulk-upload-classify.js`

- [ ] **Step 1: Crear el módulo con dual-export (copia fiel desde L6510-6996)**

Copiar EXACTAMENTE: `normLabel`, `isNonFinishLabel`, `buildEquivIndex`, `equivGroup`, `equivalentValues`, `acabadosOrdenados`, `acabadosCanonicos`, `metalCanonico`, `buildCompositeKey`, `rankCandidates`, `classifyOnePN`, `dedupModifyTargets`, `detectCsvDuplicates`, `chunkParts`. Mismo wrapper dual-export que Task 2, exportando como `root.SteelheadBulkClassify`. Verificar que ninguna referencia a `bulkCfg()`/`state`/DOM quede dentro; si alguna función las usa, pasar esos valores como parámetros (no extraerla si no es realmente pura — anotarlo).

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/bulk-upload-classify.js
git commit -m "feat(bulk-upload F1): módulo puro de clasificación (copia fiel, sin cablear)"
```

---

## Task 5: Golden tests del clasificador

**Files:**
- Create: `tools/test_bulk_upload_classify.js`

- [ ] **Step 1: Escribir golden tests de equivalencias y matching**

```js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../remote/scripts/bulk-upload-classify.js');

test('buildEquivIndex + equivalentValues: metales equivalentes', () => {
  const idx = C.buildEquivIndex([['Estaño','Estaño s/Aluminio','Estaño s/Cobre'],['Plata','Plata Flash']]);
  assert.strictEqual(C.equivalentValues(idx, 'Estaño', 'Estaño s/Cobre'), true);
  assert.strictEqual(C.equivalentValues(idx, 'Plata', 'Plata Flash'), true);
  assert.strictEqual(C.equivalentValues(idx, 'Estaño', 'Plata'), false);
});

test('isNonFinishLabel: etiquetas no-acabado del config', () => {
  const nf = ['SMY','En desarrollo','Muestras'];
  assert.strictEqual(C.isNonFinishLabel('SMY', nf), true);
  assert.strictEqual(C.isNonFinishLabel('Estaño', nf), false);
});

test('chunkParts: trocea respetando tamaño', () => {
  assert.deepStrictEqual(C.chunkParts([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
});

test('detectCsvDuplicates: detecta filas duplicadas por PN+cliente', () => {
  const parts = [{pn:'A',cliente:'X'},{pn:'A',cliente:'X'},{pn:'B',cliente:'X'}];
  const { dupRows } = C.detectCsvDuplicates(parts);
  assert.ok(dupRows.length >= 1);
});
```

Ajustar las firmas/inputs a las reales tras leer cada función (los nombres de campo de `parts[]` salen de `parseRows`). Agregar al menos un test de `classifyOnePN` con un candidato y un CSV row que ejercite blank-acabados (invariante #7) y la preferencia de id más alto.

- [ ] **Step 2: Correr los tests**

Run: `node --test tools/test_bulk_upload_classify.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tools/test_bulk_upload_classify.js
git commit -m "test(bulk-upload F1): golden tests del clasificador"
```

---

## Task 6: Cablear los módulos en `bulk-upload.js`

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (borrar definiciones internas, consumir de los módulos)
- Modify: `remote/config.json` (array `scripts` de `carga-masiva` + `scripts` global + bump `version`)

- [ ] **Step 1: Importar del módulo al inicio del IIFE de `bulk-upload.js`**

Justo después de `const api = () => window.SteelheadAPI;` (L189), agregar:

```js
  const Parse = window.SteelheadBulkParse;
  const Classify = window.SteelheadBulkClassify;
  const { toBool, isDash, resolveStr, resolveNum, buildDimensions, parseCSV } = Parse;
```

- [ ] **Step 2: Borrar las definiciones internas duplicadas**

Eliminar de `bulk-upload.js`: `toBool` (L1025), `isDash`/`resolveStr`/`resolveNum` (L1430-1440), `buildDimensions` (L1420-1427), `parseCSV` (L1069-1093), y las definiciones de las funciones de classify ahora en `Classify.*` (reemplazar llamadas internas `classifyOnePN(...)` por `Classify.classifyOnePN(...)`, etc.). Mantener `g`/`gn` si `parseRows` las usa internamente (o reapuntar a `Parse.cell`/`Parse.cellNum`). NO tocar la lógica de `parseRows` ni del pipeline.

- [ ] **Step 3: Actualizar `config.json`**

En `apps[].scripts` de `carga-masiva` y en el `scripts` global de top-level, agregar `"scripts/bulk-upload-parse.js"` y `"scripts/bulk-upload-classify.js"` ANTES de `"scripts/bulk-upload.js"`. Bump `version` (ej. `1.6.38` → `1.6.39`) y `lastUpdated` a `2026-06-06`.

- [ ] **Step 4: Verificar que el module-level export no rompe el browser**

Run: `node -e "global.window={}; require('./remote/scripts/bulk-upload-parse.js'); require('./remote/scripts/bulk-upload-classify.js'); console.log(Object.keys(window.SteelheadBulkParse||{}).length, Object.keys(window.SteelheadBulkClassify||{}).length)"`
Expected: imprime dos números > 0 (los módulos se auto-registran en `window` cuando no hay `module.exports` consumidor... en este check sí hay require, así que validar via `module.exports`). Ajustar el check a `const P=require(...); console.log(Object.keys(P).length)`.

- [ ] **Step 5: Re-correr TODOS los golden tests**

Run: `node --test tools/test_bulk_upload_parse.js tools/test_bulk_upload_classify.js tools/test_bulk_upload_cc.js`
Expected: PASS (todo verde). Confirma que la extracción no alteró comportamiento.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/bulk-upload.js remote/scripts/bulk-upload-parse.js remote/scripts/bulk-upload-classify.js remote/config.json
git commit -m "refactor(bulk-upload F1): cablear módulos puros + bump config"
```

---

## Task 7: Deploy F1 (con gate de validación)

**Files:**
- Modify: rama `gh-pages` (mirror aplanado)

- [ ] **Step 1: Verificar carga en navegador (manual, con el usuario)**

Pedir al usuario recargar la extensión y abrir Carga Masiva con un CSV de prueba pequeño SIN ejecutar — solo confirmar que el preview se construye igual que antes (la extracción no cambió comportamiento). Gate: no continuar sin OK.

- [ ] **Step 2: Sync a gh-pages (procedimiento de CLAUDE.md)**

```bash
git checkout gh-pages
git show main:remote/scripts/bulk-upload-parse.js > scripts/bulk-upload-parse.js
git show main:remote/scripts/bulk-upload-classify.js > scripts/bulk-upload-classify.js
git show main:remote/scripts/bulk-upload.js > scripts/bulk-upload.js
git show main:remote/config.json > config.json
git add scripts/bulk-upload-parse.js scripts/bulk-upload-classify.js scripts/bulk-upload.js config.json
git commit -m "deploy: módulos puros bulk-upload F1 + bump 1.6.39"
git checkout main
```

- [ ] **Step 3: Verificar byte-exact**

Run: `tools/check-deploy.sh bulk-upload-parse.js && tools/check-deploy.sh bulk-upload-classify.js && tools/check-deploy.sh bulk-upload.js`
Expected: OK byte-exact en los tres.

- [ ] **Step 4: Push (solo con OK del usuario)**

Run: `git push origin main && git push origin gh-pages`
Expected: ambas ramas actualizadas. NO ejecutar sin que el usuario lo pida.

---

## Definition of Done F1

- `tools/steelhead_probe.py` valida shapes de lectura contra el ERP real (no destructivo).
- `bulk-upload-parse.js` y `bulk-upload-classify.js` existen con dual-export.
- Golden tests verdes (`node --test`) congelan invariantes #1 (blank/dash/data), #7 (blank-acabados), equivalencias.
- `bulk-upload.js` consume los módulos; sin definiciones duplicadas; comportamiento idéntico.
- `config.json` bumpeado; deploy verificado byte-exact (push con OK del usuario).
- Bitácora `docs/applets/bulk-upload.md` anotada con: shapes confirmados del probe, FK escalares null, versión F1.
