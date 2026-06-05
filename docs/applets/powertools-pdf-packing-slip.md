# Power Tools `getPdfCustomization` — Packing Slip (`pdf/PACKING_SLIP_TEMPLATE.ts`)

Hook low-code de la **remisión**. Hace **dos cosas** desde la v2 (id=10561):

1. **Muta** `inputs.packingSlip.items[].containerIndex` (formato `"i/n"`) por side effect — comportamiento histórico que la plantilla de remisión ya leía. **No cambió.**
2. **Emite `result.additionalPayload.labels[]`** — una entrada por contenedor (item × partTransferAccount × batch) con 11 campos, pensado para alimentar una **plantilla de etiqueta** de PDFGeneratorAPI (aparte del render de la remisión).

> El `additionalPayload.labels` es **aditivo**: agrega keys nuevas sin tocar las que la plantilla de remisión ya consume. Por eso el deploy no altera la remisión existente.

## Versión actual

| Campo | Valor |
|---|---|
| `active_id` | **10626** (2026-06-05) |
| versión previa (rollback) | **10624** (ramas no nulas + fecha fmt, pre-conversión peso) · 10623 (OV+empacador) · 10564 (pre-etiquetas-v2) |
| total versiones del slot | 11 |
| deploy | `lowcode_sync.py push ... pdf:PACKING_SLIP_TEMPLATE` (CreatePdfLowCode) |

## Campos de `additionalPayload.labels[]`

| Campo etiqueta | Key payload | Fuente |
|---|---|---|
| Número de parte | `partNumber` | `partsTransferAccounts[].partNumber.name` |
| Descripción | `description` | `partNumber.descriptionMarkdown` |
| Pzas × caja | `piecesPerContainer` | `item.partCount` ?? `part.partCount` |
| PS (Packing Slip cliente) | `ps` | `receivedBatches[].customInputs.DatosRecibo.PackingSlip` (**confirmado**) |
| Batch name | `batchName` | `receivedBatches[].name` |
| Work order | `workOrder` / `workOrderId` | `partsTransferAccounts[].workOrder.name` / `.idInDomain` |
| **Orden de venta** | `salesOrder` / `salesOrderId` | `partsTransferAccounts[].workOrder.receivedOrder.name` / `.idInDomain` (received_order = OV) |
| **Empacador** | `packedBy` | `inputs.currentUser.name` (constante para todo el embarque; también en la raíz) |
| Fecha de embarque | `shippingDate` (+ `shippingDateSource`) | `packingSlip.shippingDate` → fallback `shippedAt` |
| **Fecha embarque formateada** | `shippingDateFmt` | `shippingDate` → `d/m/Y H:i` (24 h) en `inputs.timezone` vía `Intl.DateTimeFormat`. Imprimir directo `{shippingDateFmt}` (sin `date()` de Twig) |
| Contenedor x de y | `containerIndex` (+ `containerNum`/`containerTotal`) | grupo PN+batch, ordenado por `item.index` |
| **Peso bruto** | `grossWeight` | `item.weight.gross` (convertido a la unidad del cliente) |
| **Peso neto** | `netWeight` (+ `tareWeight`) | `item.weight.net` / `.tare` (convertidos) |
| **Unidad de peso** | `weightUnit` | `"LB"` si el cliente captura en libras (`UnidadMedidaPeso`), si no `"KG"`. También en la raíz |
| **Nombre del contenedor** | `containerName` (+ `containerNameSource`) | `rack.name` → fallback `partGroup.name` |

También: `containerWeightUnit` (de `partGroup.containerWeightUnit.name`, informativo) y en la raíz `totalLabels`, `shippingDate`, `shippingDateSource`.

## Decisiones / gotchas

| Aspecto | Decisión | Notas |
|---|---|---|
| Key del **PS** | `customInputs.DatosRecibo.PackingSlip` (anidado) + fallbacks | **Confirmado** en scans 2026-05 y por el usuario. El mismo `DatosRecibo` también trae `PesoCliente` (string) y `numeroContenedores` (number). La v2 (id=10561) buscaba `["PS"]` plano → daba `ps: null`; corregido en v3 (id=10564). |
| Fallback de fecha | `shippingDate ?? shippedAt` | El Input **no expone `createdAt`** del packing slip; `shippedAt` es lo más cercano. `shippingDateSource` indica cuál se usó. |
| Nombre contenedor | `rack.name ?? partGroup.name` | Usuario confirmó que se usan **ambos** flujos (contenarización vs agrupación de partes). `containerNameSource` (`"rack"`/`"partGroup"`) permite ver cuál domina al validar. |
| Peso bruto/neto | siempre de `item.weight` | `partGroup.containerWeight` es un solo número (≈ tara), no da bruto+neto. `packingSlip.totalWeight` es el total del embarque, no por contenedor. |
| Item multi-parte | etiqueta por cada parte, peso del **bulto completo** | Si un `item` lleva >1 `partsTransferAccount`, `grossWeight/netWeight` son del bulto, no por parte. El hook avisa con chip `info`. |
| Mutación `item.containerIndex` | preservada | No tocar: la remisión actual depende de ella. Riesgo histórico: si Steelhead clonara los `inputs` antes de la plantilla, se perdería sin error. |
| Runtime target | **ES2017** | `??=` (ES2021) revienta con SyntaxError silencioso (ver `powertools-ordendeventa.md`). El body nuevo usa solo checks explícitos (`&&`, ternarios, `!=`). Typecheck `tsc --target es2017 --alwaysStrict` en verde. |
| **Ramas vacías en PDFGeneratorAPI** | `null` → `""` | PDFGeneratorAPI arma el árbol de campos desde la muestra; un campo `null` en TODAS las etiquetas **no genera nodo** → no se puede colocar en la plantilla (ni en blanco). Coercionar `null`/`undefined` → `""` deja la rama siempre presente. Síntoma: `containerName`/`containerNameSource`/`containerWeightUnit` desaparecían del árbol antes de contenarizar. Aplica a cualquier hook de PDF. |
| **Fecha → "array given"** | formatear en el hook | `{% date({shippingDate},...) %}` de Twig truena con `DateTime::__construct(): Argument #1 must be string, array given` (el binding del campo dentro del loop de `labels` llega como arreglo). Solución: el hook emite `shippingDateFmt` ya formateado (`Intl.DateTimeFormat` con `inputs.timezone`); la plantilla imprime el string directo. |
| **Unidad del peso (KG vs LB)** | `item.weight` SIEMPRE llega en KG; convertir | **Confirmado vía DB:** Wieland captura en LBR (tabla `measurement.unit_id=3972`, con `tare`); Steelhead entrega `item.weight` al hook **ya convertido a KG**. Ej. 1054: báscula 15/2 lb → hook recibe 6.80/0.91 kg. El cliente declara su unidad en `customer.custom_input.DatosLogisticos.UnidadMedidaPeso` (bool camelCase: `true`=LB, `false`/null=KG; default **KG**). En TLC+MTY **solo WIELAND** usa LB. **v6**: el hook detecta LB (recursivo, igual que `weight-quick-entry.js`) y convierte `grossWeight`/`netWeight`/`tareWeight` kg→lb (×2.2046226218, redondeo 2 dec) + emite `weightUnit`. Clientes KG: sin cambio. |
| **gross/net/tare convencionales** | gross = total, net = piezas, tare = contenedor | Validado con la 1054: gross 15 lb = net 13 + tare 2. El binding cruzado en la plantilla (no el hook) hacía ver bruto↔neto invertidos. El mapeo del hook (`grossWeight`←`weight.gross`, etc.) es correcto. |
| **Contenarización (nombre)** | `rack.name` | Trazado en DB (WO 5122): el nombre del contenedor vive en `parts_transfer_account.rack_id` → `rack.name` (ej. `T109-BA01-001`, tipo `T109-BA01`); `super_rack_id` y `part_group` venían null. El hook lee `part.rack.name` → fallback `partGroup.name`. **Validar tras contenarizar un embarque real** que el GraphQL pueble `part.rack` (podría filtrarlo por `rackType.isContainer`). |

## Paginación de la remisión con etiquetas append (PDFGeneratorAPI)

Al anexar las etiquetas en el **mismo** PDF de la remisión, `{total_pages}` cuenta todo (remisión + N etiquetas) → el header de la remisión muestra "Página 1 de 3" en vez de "1 de 1".

- **Fórmula:** `páginas_remisión = total_pages − totalLabels` (cada etiqueta = 1 página; el hook ya expone `totalLabels` en la raíz).
- **Dónde:** `{total_pages}`/`{current_page}` SOLO se evalúan dentro de un componente **Header o Footer** (no en el body). El contador de la remisión ya vive en el header → ahí se puede restar.
- **Expresión** (en el texto del header): `Página {current_page} de {% {total_pages} - ({totalLabels} ?? 0) %}`. Variantes según editor: `{totalpages}` sin guión bajo, o el placeholder sin llaves dentro de `{% %}`.
- **Supuesto frágil:** 1 etiqueta = 1 página. Si una etiqueta ocupa >1 página, el descuento se queda corto (habría que exponer páginas-de-etiqueta reales desde el hook).
- **Plan B** si `total_pages` no resuelve dentro de `{% %}` (se calcula en fase de layout posterior a los datos): generar etiquetas como documento aparte y concatenar, o dejar solo `Página {current_page}`.
- **Pendiente validar** en el editor real (cuál variante del placeholder evalúa la resta).

## Plan de validación pendiente (en producción, post-deploy 10564)

1. **Fecha**: confirmar si `shippedAt` sirve como "fecha de creación de la packing slip" cuando `shippingDate` viene null.
2. **1 `item` = 1 contenedor**: validar con embarque real que `piecesPerContainer` y `grossWeight/netWeight` calzan por caja.
3. **rack vs partGroup**: ver qué `containerNameSource` domina en embarques reales.
4. **Remisión intacta**: confirmar que el PDF de remisión (containerIndex `i/n`) sigue idéntico.
5. **PS poblado**: confirmar en Test Panel que `ps` ya trae el valor de `DatosRecibo.PackingSlip` (resuelto en v3, validar con dato real).

## Bonus disponible (no pedido aún, ya en el Input)

`customInputs.DatosRecibo` del batch también expone `PesoCliente` (string) y `numeroContenedores` (number). Este último es el total de contenedores capturado al recibo — alternativa al "x de y" actual (que cuenta items reales del embarque). Si se prefiere esa semántica, es un cambio de una línea.

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

- **v6 (2026-06-05, id=10626)**: **conversión de peso por cliente** — `item.weight` llega en KG; si el cliente captura en libras (`UnidadMedidaPeso`, detección recursiva igual que `weight-quick-entry.js`) se convierte `grossWeight`/`netWeight`/`tareWeight` kg→lb (×2.2046226218, 2 dec) y se emite `weightUnit` (`"LB"`/`"KG"`, también en raíz). Clientes KG sin cambio. Verificado: 6.80/5.90/0.91 kg → 15/13/2 LB. Confirmado en DB que Wieland captura en LBR y el mapeo gross/net/tare del hook es convencional (el cruce que veía el usuario era binding de plantilla). Typecheck es2017 verde.
- **v5 (2026-06-05, id=10624)**: (1) **null → "" en todas las ramas** del label (y raíz) — PDFGeneratorAPI **no crea nodo** para campos `null` en toda la muestra, así que `containerName`/`containerNameSource`/`containerWeightUnit` (vacíos hasta contenarizar) no se podían colocar en la plantilla. Coerción `Object.keys(label).forEach(k => if null → "")`. (2) + `shippingDateFmt`: fecha de embarque ya formateada `d/m/Y H:i` (24 h) en `inputs.timezone` (`Intl.DateTimeFormat`, fallback regex sin TZ) — la plantilla imprime `{shippingDateFmt}` sin la función `date()` de Twig (que tronaba con `DateTime::__construct(): array given`). Verificado en Node: `2026-06-05T20:36:03+00:00` → `05/06/2026 14:36`. Typecheck es2017 verde.
- **v4 (2026-06-05, id=10623)**: + `salesOrder`/`salesOrderId` por etiqueta (de `workOrder.receivedOrder.name`/`.idInDomain` = OV) y `packedBy` (de `inputs.currentUser.name`, también en la raíz del payload). Nuevo diagnóstico `missingSO` (chip warning) + empacador en el `log`. Typecheck `tsc --target es2017 --strict --alwaysStrict` en verde. **Aditivo**: no toca campos previos ni la remisión.
- **v3 (2026-06-01, id=10564)**: fix lector de PS — `customInputs.DatosRecibo.PackingSlip` (anidado) en vez de `["PS"]` plano. La v2 daba `ps: null`.
- **v2 (2026-06-01, id=10561)**: + `additionalPayload.labels[]` con 11 campos para etiqueta por contenedor (PN, descripción, pzas/caja, PS, batch, WO, fecha embarque, contenedor x/y, peso bruto/neto, nombre de contenedor rack/partGroup) + diagnóstico (chips de PS/nombre/peso/multi-parte). Preserva mutación `containerIndex`. Aditivo: no altera la remisión.
- **v1 (id=10477)**: solo mutaba `item.containerIndex`, `additionalPayload` vacío.
