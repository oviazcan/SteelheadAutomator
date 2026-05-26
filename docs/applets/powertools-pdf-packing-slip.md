# Power Tools `getPdfCustomization` — Packing Slip (`pdf/PACKING_SLIP_TEMPLATE.ts`)

Hook low-code que **muta** `inputs.packingSlip.items[].containerIndex` por side effect. El template de PDFGeneratorAPI lee `item.containerIndex` (formato `"i/n"`) para imprimir en cada renglón qué contenedor representa dentro del grupo (PN + lote recibido).

## Lo que hace

1. Agrupa items por llave `${partNumber.id}-${receivedBatch.id}`.
2. Para cada item, recorre `partsTransferAccounts[]` y, para cada `receivedBatches[]`, lo pushea al grupo correspondiente (un item con N receivedBatches aparece en N grupos).
3. Ordena cada grupo por `item.index` (orden original del packing slip).
4. Asigna `(item as any).containerIndex = "${idx+1}/${total}"` por side effect.
5. Regresa `additionalPayload: {}` (lo importante ya quedó mutado en `inputs`).

## Decisiones / gotchas

| Aspecto | Decisión actual | Notas |
|---|---|---|
| `result.additionalPayload` queda vacío | Plantilla NO debe leer additionalPayload, lee `inputs.packingSlip.items[].containerIndex` directo | Patrón inusual: el resto de hooks llena `additionalPayload`. Aquí muta. |
| Mismo item en varios grupos | Solo conserva el ÚLTIMO `containerIndex` asignado | Si un item tiene 2 receivedBatches y cae en 2 grupos distintos, el output muestra solo el segundo `i/n`. |
| Items sin `partNumber.id` o sin `receivedBatches` | Skip silencioso | No tendrán `containerIndex` y la plantilla debe defender contra undefined. |
| `batch.id` faltante | Skip silencioso | Mismo caso. |

## Mutación por side effect — riesgos

- El hook depende de que el runtime de Power Tools **NO** clone defensivamente los `inputs` antes de pasarlos a la plantilla. Si Steelhead introdujera un deep-clone (legítimo desde su lado), `containerIndex` desaparecería del payload sin error.
- Más limpio sería emitir `additionalPayload.containerIndexByItemId: Record<itemId, string>` y que la plantilla haga lookup. Pendiente como refactor.

## Plan de validación pendiente

1. Packing slip con 3 items del mismo PN + mismo lote: confirmar `1/3`, `2/3`, `3/3` en el PDF.
2. Item con 2 receivedBatches distintos: confirmar qué `containerIndex` queda (es el del segundo grupo procesado — aceptable o no según el cliente).
3. Item sin `partNumber.id`: confirmar que el PDF lo imprime sin `containerIndex` sin tronar.

## Oportunidades

- Migrar la mutación a un objeto en `additionalPayload` (más explícito y resistente a deep-clones futuros).
- Decidir comportamiento determinístico cuando un item participa en varios grupos (primero, último, o lista).
