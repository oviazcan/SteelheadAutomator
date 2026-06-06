# Bulk Uploader Refactor — F4: Pipeline consolidado (worker per-PN) — velocidad

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps usan checkbox.
> ⚠️ **FASE DE MAYOR RIESGO.** Toca `buildPreserveInput` + los 16 invariantes. Un error borra datos
> en producción (procesos/labels/dims/ubicaciones). NO deployar sin validar contra el sandbox.

**Goal:** Reducir las llamadas por PN (GetPartNumber ~4→1, SavePartNumber hasta 5→2-3, AddParams/SaveQuoteLines/UpdateQuote a batch) consolidando el enriquecimiento en un worker per-PN, sin romper ningún invariante. Es donde se gana la velocidad real en corridas grandes.

**Architecture:** Hoy STEP 6/6a/6b/7/7b/8 son fases separadas, cada una iterando sobre todos los PN con su propio `GetPartNumber`. F4 las colapsa en un `pnWorker(pn)` que hace UN `GetPartNumber` (seed slim ampliado), todas las mutaciones del PN, y `cache.delete()` en finally → peak memoria O(concurrency), no O(N). El bloque cotización (crear PN → sentinels → CreateQuote → precios batch → SaveQuoteLines batch → UpdateQuote) precede al bloque enriquecimiento (respeta el orden obligado: la línea referencia el PN activo). `buildPreserveInput(part, seed, runtimeInputSchemaId)` centraliza TODA la semántica blank/dash/data + FK-fallback + REPLACE-safe (hoy dispersa en Call A/B/STEP5/6b).

**Spec:** `docs/superpowers/specs/2026-06-06-bulk-upload-refactor-design.md` (§2, §5).
**Probe confirmó:** FK escalares no se piden (solo relacionales `XByX.id`); detail de 1 PN ≈14.8MB → seed slim obligatorio.

---

## Orden actual (a colapsar) — del análisis forense
```
STEP 6 pre: prefetch predictivos (runPool GetPartNumber)   ← 1er GetPartNumber/PN
STEP 6: enrichWorker (GetPartNumber + SavePartNumber A/B)   ← 2do GetPartNumber/PN
STEP 6 post: specs colisionantes (SavePartNumber dedicado)
STEP 6a: predictivos cascade
STEP 6b: step6bWorker (GetPartNumber + AddParams uno-a-uno) ← 3er GetPartNumber/PN
STEP 7: racks (GetPartNumber + rack mutations)
STEP 7b: delete prices (GetPartNumber)                      ← 4to GetPartNumber/PN
STEP 8: archive + default price (GetPartNumber SOLO_PN)
```

## Task 1: `buildPreserveInput` puro + golden tests (NO toca el pipeline)

**Files:** Create/extend `remote/scripts/bulk-upload-classify.js` o nuevo `bulk-upload-build.js`; tests en `tools/`.

- [ ] **Step 1:** Leer EXACTAMENTE cómo se arma hoy el input de SavePartNumber en `enrichWorker` (Call A/B), STEP 5 sentinel, STEP 6b cleanup. Documentar el shape completo (labelIds, partNumberDimensions, optInOuts, customInputs, specsToApply, partNumberSpecFieldParamsToArchive, partNumberLocations, defaultProcessNodeId, customerId, groupId, geometryTypeId, inputSchemaId).
- [ ] **Step 2:** Extraer `buildPreserveInput(part, seed, runtimeInputSchemaId, opts)` PURO que reproduzca byte-a-byte la lógica actual: blank→preservar (del seed), dash→borrar, dato→escribir; FK-fallback (`seed.customerByCustomerId?.id ?? seed.customerId`); REPLACE-safe (arrays completos del seed cuando el CSV no trae columna); locations preserve-on-missing (fix Skip 8).
- [ ] **Step 3:** Golden tests exhaustivos (un caso por invariante): labels blank/dash/dato; dims; optInOuts tri-state; customInputs merge; proceso all-missing/at-least-one/dash; FK-fallback de los 4 escalares; locations preserve. Comparar la salida contra el shape que produce el código actual (capturar el actual con un fixture).
- [ ] **Step 4:** `node --test` verde. commit. **Sin tocar el pipeline aún.**

## Task 2: Sandbox "Pruebas Claude" + validación de escritura de `buildPreserveInput`

**Files:** `tools/steelhead_probe.py` (extender a un writer controlado), o un script dedicado.

- [ ] **Step 1:** Crear el NP "Pruebas Claude" (un SavePartNumber mínimo) en TLC vía un script de escritura controlado (autorizado por el usuario). Registrar su id.
- [ ] **Step 2:** Para cada caso de invariante: leer estado actual (GetPartNumber) → aplicar un SavePartNumber con el payload de `buildPreserveInput` → releer → confirmar que el efecto es el esperado (blank preserva, dash borra, dato escribe, locations no se borran). Documentar resultados.
- [ ] **Step 3:** Validar el bug Skip 8: poner ubicaciones al sandbox → correr un MODIFY sin columna locations → confirmar que NO se borran (con el fix) vs que SÍ se borran (sin el fix). Confirma el bug y el fix.

## Task 3: Worker per-PN consolidado (1 GetPartNumber)

**Files:** Modify `remote/scripts/bulk-upload.js` (`execute`, `enrichWorker`, `step6bWorker`, STEP 6a/7/7b/8).

- [ ] **Step 1:** Pre-fetch consolidado: el runPool de "STEP 6 pre" guarda un **seed slim ampliado** (no el detail): `{id, FK-relacionales, labelIds, dims, customInputs, specIds, specFieldParamIds, prices[id,amount,isDefault], locationIds, predictivos}`. Un solo GetPartNumber/PN.
- [ ] **Step 2:** `pnWorker(pn)`: lee del seed (sin re-fetch) → `buildPreserveInput` → SavePartNumber enrich (Call A+B consolidados donde aplique) → specs colisión split → params (AddParams batch x PN) → predictivos (ver nota cascade) → racks → delete-price/default desde seed → archive → `seed.delete()` + `periodicDrain()` en finally. Peak O(concurrency).
- [ ] **Step 3:** Validar contra sandbox (corrida de N PNs de prueba) + mem monitor (peak O(concurrency), no O(N)). Golden tests verdes.
- [ ] **Step 4:** commit.

## Task 4: Batches (AddParams, SaveQuoteLines, UpdateQuote)

**Files:** Modify `remote/scripts/bulk-upload.js`.

- [ ] **Step 1:** `AddParamsToPartNumber`: acumular params faltantes del PN → 1 llamada; retry param-por-param solo si exclusion-constraint.
- [ ] **Step 2:** `SaveQuoteLines`: agrupar por cotización → 1 llamada con array; error handling por línea.
- [ ] **Step 3:** `UpdateQuote`: combinar notas ext+int en 1 llamada cuando ambas presentes.
- [ ] **Step 4:** `Promise.all([CurrentUserDetails, GetPartNumbersInputSchema])`; `buildEquivIndex` 1× en init.
- [ ] **Step 5:** Validar sandbox + golden tests. commit.

## Task 5: Deploy F4 (gate usuario + validación con corrida real)

- [ ] Sync gh-pages vía worktree; byte-exact; push con OK.
- [ ] **Validación crítica:** el usuario corre un CSV REAL mediano (no 1 PN) y confirma: resultados correctos en Steelhead (procesos/labels/dims/precios/ubicaciones intactos donde deben), y mejora de velocidad medible. Comparar # de llamadas (DevTools network) antes/después.
- [ ] Bitácora F4 con métricas.

## Definition of Done F4
- `buildPreserveInput` puro + golden tests de los 16 invariantes; validado contra sandbox (incl. Skip 8).
- 1 GetPartNumber/PN; SavePartNumber 2-3; AddParams/SaveQuoteLines/UpdateQuote en batch.
- Peak memoria O(concurrency) confirmado con mem monitor.
- Corrida real validada por el usuario (correctitud + velocidad).
