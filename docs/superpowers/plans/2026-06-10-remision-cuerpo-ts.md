# Remisión — cuerpo en TS + rojo OV pendiente — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: usar superpowers:subagent-driven-development o
> superpowers:executing-plans. Steps con checkbox (`- [ ]`).

**Goal:** Migrar el cuerpo de la remisión (4 columnas) a `additionalPayload.bodyRows[]` en el hook
`PACKING_SLIP_TEMPLATE.ts`, consolidado por PN, con rojo `isPending` en OC(OV) y todos los bugs de
la fórmula nativa corregidos.

**Architecture:** Lógica pura en `tools/packing_slip_body.mjs` (testeable con `node --test`),
**espejo inline** ES2017-safe en `PACKING_SLIP_TEMPLATE.ts` (los hooks no admiten imports — misma
convención que `packing_slip_weight.mjs`). El hook emite `bodyRows[]` (aditivo: no rompe `labels[]`
ni la remisión actual hasta que el usuario re-apunte la tabla del template).

**Tech Stack:** JS ESM puro + `node:test`; TypeScript ES2017 (sin `?.`/`??`); `lowcode_sync.py` para deploy.

Spec: `docs/superpowers/specs/2026-06-10-remision-cuerpo-ts-migracion-design.md`.

---

## Reglas de oro (de la auditoría)

- **ES2017-safe en TODO** (`.mjs` y `.ts`): nada de `?.` ni `??`; solo `!= null` y ternarios. Así el
  espejo `.ts` es copia literal del `.mjs`. Check: `grep -nE '\?\.|\?\?' archivo`.
- **Agrupar por `pn.id`** iterando `items → partsTransferAccounts` (NO expandir por batch para
  cantidades; cada PTA cuenta una vez).
- **billablePartCount es por PN×WO**: dedupear por `workOrder.idInDomain` (no sumar PTAs del mismo WO).
- Toda rama que no aplica → `""`; booleanos como `'1'`/`'0'` (PDFGeneratorAPI no crea nodo para `false`).

## Estructura de archivos

- **Create** `tools/packing_slip_body.mjs` — lógica pura: helpers (`escapeHtml`, `mdToHtml`,
  `isPendingName`, `pluralContenedor`) + `buildBodyRows(inputs)`.
- **Create** `tools/packing_slip_body.test.mjs` — tests `node:test`.
- **Modify** `powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts` — `try/catch` global, espejo inline de
  `buildBodyRows`, emitir `result.additionalPayload.bodyRows`, sumar `inventoryAccountsByInventoryBatchId`
  + `initialAmount` al typedef (campo opcional para el COALESCE futuro).
- **Reuse** `tools/packing_slip_weight.mjs` (`unitIsLb`, `convertWeight`) — importar en el `.mjs`;
  inline ya presente en el `.ts`.

---

## Task 1: Helpers de string (TDD)

**Files:** Create `tools/packing_slip_body.mjs`, `tools/packing_slip_body.test.mjs`.

- [ ] **Step 1 — tests que fallan** (`escapeHtml`, `mdToHtml`, `isPendingName`):

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, mdToHtml, isPendingName, pluralContenedor } from './packing_slip_body.mjs'

test('escapeHtml: < > & se escapan', () => {
  assert.equal(escapeHtml('Acero <1040> & Co'), 'Acero &lt;1040&gt; &amp; Co')
})
test('escapeHtml: null → ""', () => { assert.equal(escapeHtml(null), '') })

test('mdToHtml: **negrita** y _cursiva_ y \\n', () => {
  assert.equal(mdToHtml('**Hola** _mundo_\nfin'), '<b>Hola</b> <i>mundo</i><br>fin')
})
test('mdToHtml: NO crea cursiva en part_number_id (underscore intra-palabra)', () => {
  assert.equal(mdToHtml('part_number_id'), 'part_number_id')
})
test('mdToHtml: escapa HTML antes de formatear', () => {
  assert.equal(mdToHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;')
})

test('isPendingName: "Pending"/"PEN"/"." → true; trim; null/normal → false', () => {
  assert.equal(isPendingName('Pending'), true)
  assert.equal(isPendingName('  .  '), true)
  assert.equal(isPendingName('4507'), false)
  assert.equal(isPendingName(null), false)
})

test('pluralContenedor: 1 → contenedor; 2 → contenedores', () => {
  assert.equal(pluralContenedor(1), 'contenedor')
  assert.equal(pluralContenedor(2), 'contenedores')
})
```

- [ ] **Step 2 — correr y ver fallar:** `node --test tools/packing_slip_body.test.mjs` → FAIL (módulo no existe).
- [ ] **Step 3 — implementar** los helpers en `packing_slip_body.mjs` (ES2017-safe). `mdToHtml`:
  escapar primero, `**x**`→`<b>`, cursiva solo en borde de palabra
  (`/(^|[\s(>])_([^_\s][^_]*?)_(?=[\s).,;:<]|$)/g`), `\n`→`<br>`.
- [ ] **Step 4 — correr y ver pasar.**
- [ ] **Step 5 — commit:** `feat(remision): helpers de string para el cuerpo (escape/md/pending)`.

## Task 2: Agrupación por PN + cantidades (TDD)

**Files:** Modify ambos.

- [ ] **Step 1 — test:** `buildBodyRows` agrupa por `pn.id`, suma `embarcada = Σ part.partCount`,
  `recibida = Σ billable dedup por WO`. Fixtures: (a) 1 PN en 2 items → 1 fila, suma; (b) 1 PN con 2
  PTAs del mismo WO (50 y 0, mismo `partNumberWorkOrder.billablePartCount=50`) → recibida **50** (no 100);
  (c) 1 PN con 2 WOs distintas (billable 50 y 30) → recibida **80**.

```js
test('grupo: 2 PTAs mismo WO no duplican billable', () => {
  const rows = buildBodyRows(fx.mismaWO) // emb 50+0, billable 50 ambos
  assert.equal(rows.length, 1)
  assert.match(rows[0].cantidadEmbarcadaHtml, /50 PZA/)
  assert.match(rows[0].cantidadRecibidaHtml, /50 PZA/)  // no 100
})
test('grupo: 2 WOs distintas suman billable', () => {
  const rows = buildBodyRows(fx.dosWO) // billable 50 + 30
  assert.match(rows[0].cantidadRecibidaHtml, /80 PZA/)
})
```

- [ ] **Step 2 — fail.**
- [ ] **Step 3 — implementar** el esqueleto de `buildBodyRows`: guard `ps && Array.isArray(ps.items)`;
  `Map<pnId, grupo>`; por PTA `if (!pn || pn.id == null) continue`. Cantidades:
  - `embarcada += pta.partCount` (guard `!= null`).
  - `recibida`: `Map<woId, billable>`; `woId = wo && wo.idInDomain != null ? wo.idInDomain : 'pta-'+pta.id`;
    si `pta.partNumberWorkOrder != null && billablePartCount != null` → `set(woId, billable)`; al final `Σ values`.
  - COALESCE initialAmount: leer (ES2017-safe) `pta.receivedBatches[].inventoryAccountsByInventoryBatchId[].initialAmount`;
    si hay alguno no-null → `recibida = Σ initialAmount` (dedup por cuenta); si no → la suma de billable.
- [ ] **Step 4 — pasar.** **Step 5 — commit.**

## Task 3: Cantidad Recibida HTML completa (TDD)

- [ ] **Step 1 — test:** formato `"N PZA<br><small>(P {LBS|KGM})<br>M contenedor(es)</small>"`.
  - peso teórico = `recibida × factor` con `factor` buscado en `pn.unitConversions[]` por unidad
    destino (LBR si `displayInLb`, si no KGM), `factor > 0`; convertido con `convertWeight`. Sin
    conversión válida → **omitir** el bloque de peso (sin `(Sin factor)` colgante).
  - contenedores = `Σ DatosRecibo.numeroContenedores` de batches únicos (parse `Number`, guard);
    `>=1` → `"M contenedor(es)"`; 0/null → omitir.
  - Caso cliente LB (`UnidadMedidaPeso`) → `LBS`; default `KGM`.
- [ ] **Steps 2-5** TDD + commit `feat(remision): columna Cantidad Recibida`.

## Task 4: Descripción HTML (TDD)

- [ ] **Step 1 — test:** `<b>name</b> {mdDesc} {grupo}` + `<br><b>Acabados: </b>…` (union dedup de
  `(pn).labels` de todos los PTAs; omitido si vacío) + `<br><b>Especificación: </b>…` (specs EXTERNAL,
  optional-chaining manual, dedup por `spec.name` normalizado, omitido si vacío) + bloque Espesor/Grano
  (omitido si vacío, sin `<br>` colgante). Casos null: `labels` undefined, `specFieldParameters` null,
  `spec` null, `spec.name` null → sin `"null:"` ni etiquetas vacías.
- [ ] **Steps 2-5** TDD + commit `feat(remision): columna Descripción (md + acabados + spec)`.

## Task 5: Referencias HTML + rojo (TDD)

- [ ] **Step 1 — test:** líneas, cada una omitida si sin dato:
  - **OC (OV)**: `Set` de `{name,idInDomain}` de `pta.workOrder.receivedOrder` (guard) de todos los
    PTAs, dedup por `idInDomain` (fallback name). `anyPending = some(isPendingName)`. Si pending →
    `<span style="color:red; font-size:14pt;"><b>OC (OV): </b>${ovStr}</span>`, si no sin span. `ovStr` = join `, `.
  - **OT**: dedup `workOrder.idInDomain`; sufijo `" - name"` solo si única y `name.trim()`.
  - **Lote**: dedup `batch.name`.
  - **PS Cliente**: por lote `readPS(batch.customInputs)` + sufijo Schneider individual
    (`isSchneider && batch.name.trim().substring(0,4)==='RG-M' ? 'VM' : 'VE'`), join `, `; solo los que tengan PS.
  - **Cotización**: `quote.quoteId != null` (incluye 0), dedup.
  - Tests clave: OV pendiente → `color:red`; 3 OVs (una pendiente, dups) → dedup + rojo; receivedOrder
    null → sin línea OC; quoteId=0 → se muestra.
- [ ] **Steps 2-5** TDD + commit `feat(remision): columna Referencias + rojo OV pendiente`.

## Task 6: Cantidad Embarcada HTML + Estatus/Balance (TDD)

- [ ] **Step 1 — test:** `"N PZA<br><small>(P {unit})<br>M contenedor(es)<br><b>Estatus: </b>…</small>"`.
  - peso neto = Σ neto de los PTAs del grupo, repartido por `wFrac` (mirror del `.ts` de etiquetas) y
    convertido por unidad de **origen** (`item.unit`/`ps.unit`, fix #1090); fallback a bruto; `"Sin peso"`
    solo si null real (no si 0).
  - contenedores = `parseInt(comment.trim().split(/\s+/)[0],10)` || 1.
  - **Estatus**: `emb === recibida`→`Completa`; `emb < recibida`→`Parcial`+`Balance: ${recibida-emb} PZA`;
    `emb > recibida`→`Excedente`+`Balance: +${emb-recibida} PZA`.
  - Tests: multi-PTA no infla; origen LBR cliente LB no duplica; status 3 ramas.
- [ ] **Steps 2-5** TDD + commit `feat(remision): columna Cantidad Embarcada + Estatus/Balance`.

## Task 7: Orquestación, placeholder, coerción (TDD)

- [ ] **Step 1 — test:** `buildBodyRows` arma cada fila `{pnId, partNumber, cantidadRecibidaHtml,
  descripcionHtml, referenciasHtml, cantidadEmbarcadaHtml, anyPending:'1'|'0', _placeholder:''}`;
  `null`→`''` por campo; si `items` vacío → **1 fila placeholder** (`_placeholder:'1'`, demás `''`).
- [ ] **Steps 2-5** TDD + commit `feat(remision): orquestación bodyRows + placeholder`.

## Task 8: Integrar en PACKING_SLIP_TEMPLATE.ts (espejo inline)

**Files:** Modify `powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts`.

- [ ] **Step 1:** envolver el cuerpo del hook (tras los guards) en `try/catch` global (espejo
  `INVOICE_TEMPLATE.ts:47,801-806`): en error `addErrorMessage({severity:'error',…})` + `return result`.
- [ ] **Step 2:** pegar el **espejo inline** de `buildBodyRows` + helpers (idéntico al `.mjs`,
  ES2017-safe), reusando `convertWeight`/`unitIsLb` ya presentes.
- [ ] **Step 3:** `result.additionalPayload.bodyRows = buildBodyRows(inputs)` (junto a `labels`, etc.).
- [ ] **Step 4:** sumar al typedef `Inputs` el campo opcional en `receivedBatches`:
  `inventoryAccountsByInventoryBatchId?: { initialAmount: number | null; partNumber: { id: number | null } | null }[]`.
- [ ] **Step 5:** verificación:
  - `grep -nE '\?\.|\?\?' powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts` → **sin hits** en el código nuevo.
  - typecheck ES2017 (ver Task 9).
- [ ] **Step 6 — commit:** `feat(remision): emitir bodyRows[] en el hook (espejo inline + try/catch)`.

## Task 9: Verificación final (typecheck + tests + paridad espejo)

- [ ] **Step 1:** `node --test tools/packing_slip_body.test.mjs` → todo verde.
- [ ] **Step 2:** typecheck ES2017 del hook:
  `npx tsc --noEmit --target es2017 --strict --alwaysStrict --skipLibCheck powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts`
  (si truena por tipos del runtime, castear a `any` puntual como hace INVOICE_TEMPLATE.ts). → verde.
- [ ] **Step 3:** paridad espejo: la lógica inline del `.ts` debe ser idéntica al `.mjs` (revisar diff manual).
- [ ] **Step 4 — commit** si hubo ajustes.

## Task 10: Deploy a producción (aditivo)

- [ ] **Step 1 — dry-run:** `python3 tools/lowcode_sync.py push powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts pdf:PACKING_SLIP_TEMPLATE --dry-run`.
- [ ] **Step 2 — push:** mismo sin `--dry-run` → nueva versión activa (CreatePdfLowCode). Anotar el nuevo `active_id`.
- [ ] **Step 3:** actualizar `PACKING_SLIP_TEMPLATE.meta.json` (lo hace el pull) + changelog en
  `docs/applets/powertools-pdf-packing-slip.md`.
- [ ] **Step 4 — commit:** `feat(remision): deploy bodyRows[] productivo (pdf #<id>)`.
- [ ] **Step 5 — handoff:** el usuario (a) verifica `bodyRows` en Test Panel, (b) re-apunta la tabla del
  cuerpo a `additionalPayload.bodyRows` y cada celda a su `*Html`, (c) valida una remisión real.

## Self-review (cobertura del spec)

- ① consolidación Group-by-PN → Tasks 2,5,6. ② peso #1090 → Tasks 3,6. ③ ramas/null → Tasks 3,4,5,6.
  ④ robustez (try/catch, sin `??`, placeholder) → Tasks 7,8,9. ⑤ rojo isPending → Task 5.
- Decisiones #1-9 del spec mapeadas. initialAmount = COALESCE (Task 2, activo billable hoy).
