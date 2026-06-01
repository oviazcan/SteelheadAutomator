# Power Tools `getPdfCustomization` — Packing Slip (`pdf/PACKING_SLIP_TEMPLATE.ts`)

Hook low-code de la **remisión**. Hace **dos cosas** desde la v2 (id=10561):

1. **Muta** `inputs.packingSlip.items[].containerIndex` (formato `"i/n"`) por side effect — comportamiento histórico que la plantilla de remisión ya leía. **No cambió.**
2. **Emite `result.additionalPayload.labels[]`** — una entrada por contenedor (item × partTransferAccount × batch) con 11 campos, pensado para alimentar una **plantilla de etiqueta** de PDFGeneratorAPI (aparte del render de la remisión).

> El `additionalPayload.labels` es **aditivo**: agrega keys nuevas sin tocar las que la plantilla de remisión ya consume. Por eso el deploy no altera la remisión existente.

## Versión actual

| Campo | Valor |
|---|---|
| `active_id` | **10561** (2026-06-01) |
| versión previa (rollback) | **10477** |
| total versiones del slot | 7 |
| deploy | `lowcode_sync.py push ... pdf:PACKING_SLIP_TEMPLATE` (CreatePdfLowCode) |

## Campos de `additionalPayload.labels[]`

| Campo etiqueta | Key payload | Fuente |
|---|---|---|
| Número de parte | `partNumber` | `partsTransferAccounts[].partNumber.name` |
| Descripción | `description` | `partNumber.descriptionMarkdown` |
| Pzas × caja | `piecesPerContainer` | `item.partCount` ?? `part.partCount` |
| PS | `ps` | `receivedBatches[].customInputs[PS]` (lookup flexible, ver gotchas) |
| Batch name | `batchName` | `receivedBatches[].name` |
| Work order | `workOrder` / `workOrderId` | `partsTransferAccounts[].workOrder.name` / `.idInDomain` |
| Fecha de embarque | `shippingDate` (+ `shippingDateSource`) | `packingSlip.shippingDate` → fallback `shippedAt` |
| Contenedor x de y | `containerIndex` (+ `containerNum`/`containerTotal`) | grupo PN+batch, ordenado por `item.index` |
| **Peso bruto** | `grossWeight` | `item.weight.gross` |
| **Peso neto** | `netWeight` (+ `tareWeight`) | `item.weight.net` / `.tare` |
| **Nombre del contenedor** | `containerName` (+ `containerNameSource`) | `rack.name` → fallback `partGroup.name` |

También: `containerWeightUnit` (de `partGroup.containerWeightUnit.name`, informativo) y en la raíz `totalLabels`, `shippingDate`, `shippingDateSource`.

## Decisiones / gotchas

| Aspecto | Decisión | Notas |
|---|---|---|
| Key del **PS** | `PS_KEYS = ["PS"]` + respaldo `/^ps$/i` sobre `customInputs` plano | **No confirmada con dato real.** Si está anidada (como `DatosRecibo.*` en el WO×PN), el lookup plano NO la encuentra → `ps: null` + warning. Pendiente clave. |
| Fallback de fecha | `shippingDate ?? shippedAt` | El Input **no expone `createdAt`** del packing slip; `shippedAt` es lo más cercano. `shippingDateSource` indica cuál se usó. |
| Nombre contenedor | `rack.name ?? partGroup.name` | Usuario confirmó que se usan **ambos** flujos (contenarización vs agrupación de partes). `containerNameSource` (`"rack"`/`"partGroup"`) permite ver cuál domina al validar. |
| Peso bruto/neto | siempre de `item.weight` | `partGroup.containerWeight` es un solo número (≈ tara), no da bruto+neto. `packingSlip.totalWeight` es el total del embarque, no por contenedor. |
| Item multi-parte | etiqueta por cada parte, peso del **bulto completo** | Si un `item` lleva >1 `partsTransferAccount`, `grossWeight/netWeight` son del bulto, no por parte. El hook avisa con chip `info`. |
| Mutación `item.containerIndex` | preservada | No tocar: la remisión actual depende de ella. Riesgo histórico: si Steelhead clonara los `inputs` antes de la plantilla, se perdería sin error. |
| Runtime target | **ES2017** | `??=` (ES2021) revienta con SyntaxError silencioso (ver `powertools-ordendeventa.md`). El body nuevo usa solo checks explícitos (`&&`, ternarios, `!=`). Typecheck `tsc --target es2017 --alwaysStrict` en verde. |

## Plan de validación pendiente (en producción, post-deploy 10561)

1. **Key del PS**: abrir Test Panel; si `ps: null` + chip `⚠️ sin customInput "PS"`, capturar la key real (puede estar anidada) → ajustar `PS_KEYS` y re-push.
2. **Fecha**: confirmar si `shippedAt` sirve como "fecha de creación de la packing slip" cuando `shippingDate` viene null.
3. **1 `item` = 1 contenedor**: validar con embarque real que `piecesPerContainer` y `grossWeight/netWeight` calzan por caja.
4. **rack vs partGroup**: ver qué `containerNameSource` domina en embarques reales.
5. **Remisión intacta**: confirmar que el PDF de remisión (containerIndex `i/n`) sigue idéntico.

## Rollback

Versión previa = **10477**. Restaurar:

```bash
python3 tools/lowcode_sync.py pull --all-versions
python3 tools/lowcode_sync.py push <ruta a 10477.ts en .versions/> pdf:PACKING_SLIP_TEMPLATE
```

## Oportunidades

- Migrar también la mutación `item.containerIndex` a un objeto explícito en `additionalPayload` (resistente a deep-clones futuros).
- Si el PS vive anidado, generalizar `readPS` a path configurable.

## Changelog

- **v2 (2026-06-01, id=10561)**: + `additionalPayload.labels[]` con 11 campos para etiqueta por contenedor (PN, descripción, pzas/caja, PS, batch, WO, fecha embarque, contenedor x/y, peso bruto/neto, nombre de contenedor rack/partGroup) + diagnóstico (chips de PS/nombre/peso/multi-parte). Preserva mutación `containerIndex`. Aditivo: no altera la remisión.
- **v1 (id=10477)**: solo mutaba `item.containerIndex`, `additionalPayload` vacío.
