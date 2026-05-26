# Power Tools `getPdfCustomization` — Etiqueta de WO + PN por contenedor (`pdf/WORK_ORDER_PART_NUMBER_TEMPLATE.ts`)

Hook low-code que genera **N copias** del PDF para etiquetar racks/contenedores físicos. Por cada `receivedBatch`, calcula `numeroContenedores` y empuja N entradas a `pdfsToGenerate[]` (una por contenedor); cada entrada precomputa conversiones de peso/área/longitud y agrupa specs externas.

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

## Oportunidades

- Externalizar IDs `[3969, 3972, 5150, 4907]` a `customInputs` de dominio o a una constante por env (TLC vs MTY).
- Cambiar `parseInt` por `Number()` + redondeo explícito para no truncar silenciosamente decimales.
- Estricto en skip patterns: comparar `fieldName === "Primeras Piezas"` en vez de `.includes`.
