# Quote Chunking en bulk-upload (1.2.13 → 1.3.0)

**Goal:** Partir corridas grandes de COTIZACIÓN+NP en varias cotizaciones de `chunkSize` líneas (default 250) para que abrir cada una en Steelhead no tarde minutos.

**Architecture:** Después de `partsByCustomer`, por cada cliente dividimos sus filas en chunks contiguos. Cada chunk corre el pipeline completo `CreateQuote → SaveManyPNP → GetQuote → SaveQuoteLines → UpdateQuote` con un nombre derivado: `<quoteName> 01`, `<quoteName> 02`, …, salvo cuando hay un solo chunk (nombre intacto). El resume guarda `completedChunks: { [customerId]: number[] }`; restart fresco entra al modal modify/skip/create por chunk.

**Tech Stack:** JS vanilla en `remote/scripts/bulk-upload.js`. Tests con `node --test` en `tools/test/bulk-upload-helpers.test.js`.

---

## Decisiones lockeadas

1. **Default 250** (editable en preview).
2. **Sufijo**: 1 chunk → sin sufijo; >1 → ` ${String(i+1).padStart(2, '0')}` (espacio + 2 dígitos, padStart deja 3+ si pasamos 99).
3. **Chunks contiguos puros** (slicing simple por orden de `custParts`).
4. **Resume**: salta chunks completos (skip por `completedChunks[cid]`). **Restart fresco**: cada chunk dispara findExistingQuote y modal modify/skip/create normal.

---

## Tareas

### T1. Helpers + tests

**Files:**
- Modify: `remote/scripts/bulk-upload.js` (helpers cerca de top, exponer en `__helpers`)
- Modify: `tools/test/bulk-upload-helpers.test.js` (+6 tests)

Helpers:
```js
function chunkParts(arr, chunkSize) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const size = Math.max(1, chunkSize | 0);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function makeChunkQuoteName(originalName, chunkIndex, totalChunks) {
  if (totalChunks <= 1) return originalName;
  return `${originalName} ${String(chunkIndex + 1).padStart(2, '0')}`;
}
```

Tests:
- `chunkParts([], 250)` → `[]`
- `chunkParts([1,2,3], 250)` → `[[1,2,3]]`
- `chunkParts([1..251], 250)` → `[[1..250], [251]]` (longs 250 + 1)
- `chunkParts([1..500], 250)` → 2 chunks de 250
- `makeChunkQuoteName("Q", 0, 1)` → `"Q"`
- `makeChunkQuoteName("Q", 0, 5)` → `"Q 01"`
- `makeChunkQuoteName("Q", 4, 5)` → `"Q 05"`
- `makeChunkQuoteName("Q", 99, 100)` → `"Q 100"` (3 dígitos OK con padStart)

### T2. Config defaults

**Files:**
- Modify: `remote/config.json` (sección `steelhead.domain.bulkUpload.chunking.defaultChunkSize: 250`)

### T3. Preview UI: input editable

**Files:**
- Modify: `remote/scripts/bulk-upload.js:showPreview` (insertar después del `<p class="dl9-sub">` con conteos, solo si `!isSoloPN`)

```html
<div class="dl9-chunk-cfg">
  <label>Tamaño de chunk: <input type="number" id="dl9-chunksize" min="10" step="10" value="${defaultChunkSize}"></label>
  <span id="dl9-chunkpreview"></span>
</div>
```

Listener: al cambiar, recalcular `Math.ceil(parts.length / size)` por cliente y mostrar `"X cliente(s), Y cotización(es) total"`.

Al confirmar: `state.chunkSize = +document.getElementById('dl9-chunksize').value`.

### T4. Chunk loop en execute()

**Files:**
- Modify: `remote/scripts/bulk-upload.js:2745-2922` (envolver el cuerpo del `for (const [cid, custParts] of partsByCustomer)` en un loop de chunks)

Pseudocódigo:
```js
for (const [cid, custParts] of partsByCustomer) {
  const cust = ...;
  const chunkSize = resumeState?.chunkSize || state.chunkSize || bulkCfg().chunking?.defaultChunkSize || 250;
  const chunks = chunkParts(custParts, chunkSize);
  log(`Cliente ${cust.name}: ${custParts.length} líneas → ${chunks.length} chunk(s) de hasta ${chunkSize}`);

  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    if (resumeState?.completedChunks?.[cid]?.includes(cIdx)) {
      log(`  Chunk ${cIdx+1}/${chunks.length} ya completado — saltando`);
      continue;
    }
    const chunkSlice = chunks[cIdx];
    const thisQuoteName = makeChunkQuoteName(quoteName, cIdx, chunks.length);
    // ...current pipeline (CreateQuote / findExisting / modify / SaveManyPNP / GetQuote / SaveQuoteLines / UpdateQuote)
    // operando sobre `chunkSlice` en vez de `custParts`...

    if (resumeState) {
      if (!resumeState.completedChunks) resumeState.completedChunks = {};
      if (!resumeState.completedChunks[cid]) resumeState.completedChunks[cid] = [];
      resumeState.completedChunks[cid].push(cIdx);
      await persistResumeState();
    }
  }
}
```

### T5. Resume schema extension

**Files:**
- Modify: `remote/scripts/bulk-upload.js:2217` (resumeState inicial)

Agregar:
- `chunkSize: state.chunkSize`
- `completedChunks: {}` (mapa cid → number[])

### T6. VERSION bump

**Files:**
- Modify: `remote/scripts/bulk-upload.js:49` (`'1.2.13'` → `'1.3.0'`)
- Modify: `remote/config.json` (`version: 1.2.13 → 1.3.0`)

### T7. Bitácora

**Files:**
- Modify: `CLAUDE.md` (nueva entrada `bulk-upload 1.3.0: Quote Chunking`)

### T8. Deploy

Stash .xlsm → checkout gh-pages → cp scripts/config → commit → push → restore main → push main. Verificar byte-exact.
