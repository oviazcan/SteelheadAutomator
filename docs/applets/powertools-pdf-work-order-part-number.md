# Power Tools `getPdfCustomization` — Etiqueta de WO + PN por contenedor (`pdf/WORK_ORDER_PART_NUMBER_TEMPLATE.ts`)

Hook low-code que genera **N copias** del PDF para etiquetar racks/contenedores físicos. Por cada `receivedBatch`, calcula `numeroContenedores` y empuja N entradas a `pdfsToGenerate[]` (una por contenedor); cada entrada precomputa conversiones de peso/área/longitud y agrupa specs externas.

## ⚠️ Fix de duplicación por partAccounts (consolidación por lote) — 2026-06-08

**Síntoma reportado:** cuando una OT ya se partió en varias `partAccounts` (partGroups), el template duplicaba la cantidad de etiquetas. `numeroContenedores` es atributo del **lote físico** (se captura una vez en `DatosRecibo`): partir la cuenta NO multiplica contenedores, solo reparte cuántos quedan en cada parte. Se necesitan SIEMPRE las etiquetas = contenedores iniciales del lote, consolidadas.

**Root cause:** el loop interno corría `partsForBatch.forEach((partEntry) => { for (numeroContenedores) push })`. Cuando la OT se parte, `allPartsOnWorkOrder` trae **un renglón por partAccount, todos con el mismo `receivedBatch.id`**, así que `partsForBatch` tiene N entradas y cada una emitía `numeroContenedores` etiquetas → `etiquetas = numeroContenedores × #partAccounts`.

**Fix:** dentro de cada lote se agrupa por `partNumber.id` (colapsa las partAccounts del mismo PN), se **suma** la cantidad repartida entre las partes (`partQuantity` = total del lote, decisión del usuario) y se emite `numeroContenedores` etiquetas UNA sola vez por PN distinto. Se agrega `partGroupIds[]` a cada entrada para trazabilidad. PNs genuinamente distintos en un lote NO se colapsan.

**Validación con datos reales (snapshot TLC, `parts_transfer_account` → `inventory_account` → `inventory_batch`):** 19 combos OT×lote con >1 `part_group_id`; **en los 19, `distinct_pn = 1`** (siempre el mismo PN repartido), lo que confirma que consolidar por `partNumber.id` es correcto. Ejemplos: OT 5103 (nc=12, 2 groups → hoy 24, fix 12), OT 262 (nc=8, 35 groups → hoy 280, fix 8), OT 259 (nc=1, 25 groups → hoy 25, fix 1). El split vive en `parts_transfer_account.part_group_id`, NO en `inventory_account` (0 combos ahí).

**Guarda de regresión:** `tools/wo_label_consolidation.mjs` + `tools/wo_label_consolidation.test.mjs` (8 tests, incluye OT 5103 y OT 262). Compila con `tsc --target es2017` vía `lowcode_sync.py push --dry-run` (17408 TS → 12552 JS, sin errores). **Pendiente:** push a producción + verificar en vivo contra OT 5848 (no estaba en el snapshot: TLC corta en id_in_domain 5360 / 2026-06-02).

## Lo que devuelve

```ts
result.additionalPayload = {
  pdfsToGenerate: [
    {
      batchIndex, batchId, batchName,
      containerIndex, containerDisplay: "1/3", label,
      numeroContenedores,
      partInfo: {partName, partId, partDescription, specs, quantity},
      partQuantity,
      convertedQuantities: ["12: KGM", "0.5: CMK", ...],
      partWeightKg, partAreaCmk, partLengthLm,
      workOrderInfo,
      combinedExternalSpecs: {specNamesJoined, fieldNamesJoined, markdown, ...},
      datosRecibo,
    },
    ...
  ]
}
```

La plantilla de PDFGeneratorAPI debe iterar `pdfsToGenerate[]` para emitir N páginas/labels.

## `numeroContenedores`

- Fuente: `batch.customInputs.DatosRecibo.numeroContenedores` (string en el shape).
- `parseInt(numeroRaw, 10)`; si es NaN o ≤ 0 → fallback a `1` + `helpers.addErrorMessage({severity:'warning', message:'⚠️ Batch X: Number Of Containers Is Null - Defaulting To 1 Container'})`.
- **Patrón de "valor frágil con default loud"**: defaultea para no bloquear el PDF, pero deja chip de warning para que operador note y corrija `DatosRecibo`.

## Conversiones unitarias

Lookup ordenado: primero en `part.partNumberUnitConversions`, luego fallback a `inputs.partNumber.unitConversions`. Match exacto por `unit.name`:

| Unidad | Campo en `pdfsToGenerate` |
|---|---|
| `KGM` | `partWeightKg = qty × factor` |
| `CMK` | `partAreaCmk = qty × factor` |
| `LM` | `partLengthLm = qty × factor` |

`convertedQuantities[]` filtra por **IDs de unidad** hardcoded: `[3969, 3972, 5150, 4907]` (KGM, CMK, LM, otra). Los IDs son del dominio TLC; no portar a MTY sin verificar el mapping.

## Specs externas (`combinedExternalSpecs`)

Solo `specs[].type === "EXTERNAL"`. Por cada spec field:

- **Skip** si `paramName === "Sí o No"` o `"Cumple o No Cumple"` (checks que no aportan valor en etiqueta).
- **Skip** si el `name` del field contiene `"Primeras Piezas"`, `"Diagonal"` o `"Instrumento"` (campos de validación interna, no de spec del producto).
- Agrupa por `fieldName`, dedupea `paramName` con `Set`.

Resultado:
- `specNamesJoined`: nombres de specs únicos, join con `, `.
- `fieldNamesJoined`: `${fieldName}: ${paramList}` o solo `${fieldName}` si paramList vacío, join con `, `.
- `markdown`: 2 líneas → primera = specs, segunda = fields.
- `fieldGroups`: `Record<fieldName, paramName[]>` para consumo programático en la plantilla.

## Gotchas

- **IDs de unidad hardcoded** (`3969, 3972, 5150, 4907`): si Steelhead/MTY tiene IDs distintos, `convertedQuantities` quedará vacío sin error. Externalizar a constante de dominio.
- **Default `1` silencioso si `parseInt("3.5")`**: `parseInt` corta en el primer no-dígito, así que `"3.5"` queda `3`. Si el operador puso decimal, se pierde silenciosamente; el warning solo dispara si el resultado es NaN o ≤ 0.
- **Fallback `inputs.partNumber.unitConversions` asume singular**: si el WO toca varios PNs (multi-PN WO), `inputs.partNumber` es solo uno. Para conversiones específicas del part en loop, prefiere `part.partNumberUnitConversions` (la del PN concreto del loop).
- **Skip patterns por substring**: `fieldName.includes("Primeras Piezas")` puede eliminar fields legítimos cuyo nombre contenga esa frase como parte de un nombre más largo. Aceptable hoy, fragil mañana.

## Plan de validación pendiente

1. WO con un batch + `numeroContenedores = 3`: confirmar 3 entradas en `pdfsToGenerate`.
2. WO con batch sin `DatosRecibo.numeroContenedores`: confirmar warning chip + fallback a 1 contenedor.
3. PN con conversión KGM, CMK y LM: confirmar los 3 campos calculados y `convertedQuantities` con 3 strings.
4. WO con specs externas que incluyen "Primeras Piezas": confirmar que NO aparecen en `combinedExternalSpecs`.
5. **OT partida (5848 u otra con partAccounts):** confirmar que el conteo de etiquetas = `numeroContenedores` del lote (NO × #partAccounts) y que `partQuantity` muestra la suma de las partes. Leer el log del template: `📦 Batch X: N Containers` debe casar con `✅ Generated N PDF entries` (antes del fix: `Generated N×#partAccounts`).

## Oportunidades

- Externalizar IDs `[3969, 3972, 5150, 4907]` a `customInputs` de dominio o a una constante por env (TLC vs MTY).
- Cambiar `parseInt` por `Number()` + redondeo explícito para no truncar silenciosamente decimales.
- Estricto en skip patterns: comparar `fieldName === "Primeras Piezas"` en vez de `.includes`.
