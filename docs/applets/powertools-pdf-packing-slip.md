# Power Tools `getPdfCustomization` — Packing Slip (`pdf/PACKING_SLIP_TEMPLATE.ts`)

Hook low-code de la **remisión**. Hace **dos cosas** desde la v2 (id=10561):

1. **Muta** `inputs.packingSlip.items[].containerIndex` (formato `"i/n"`) por side effect — comportamiento histórico que la plantilla de remisión ya leía. **No cambió.**
2. **Emite `result.additionalPayload.labels[]`** — una entrada por contenedor (item × partTransferAccount × batch) con 11 campos, pensado para alimentar una **plantilla de etiqueta** de PDFGeneratorAPI (aparte del render de la remisión).

> El `additionalPayload.labels` es **aditivo**: agrega keys nuevas sin tocar las que la plantilla de remisión ya consume. Por eso el deploy no altera la remisión existente.

## Versión actual

| Campo | Valor |
|---|---|
| `active_id` | **10630** (2026-06-06, fix doble conversión de peso) |
| versión previa (rollback) | **10629** (tara igual entre grupos) · 10628 (reparto peso) · 10627 (fix piezas-grupo) · 10626 (conversión peso) |
| total versiones del slot | 15 |
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
| **Peso bruto** | `grossWeight` | `netWeight + tareWeight` (neto proporcional + tara igual) → unidad del cliente |
| **Peso neto** | `netWeight` | `item.weight.net × wFrac` (proporcional a piezas del grupo) |
| **Peso tara** | `tareWeight` | `item.weight.tare / itemGroups` (igual entre grupos del item) |
| **Pzas × grupo/caja** | `piecesPerContainer` | `part.partCount` (del grupo) ?? `item.partCount` |
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
| **Unidad del peso (KG vs LB) — DOS ejes** | DESTINO = unidad del cliente; ORIGEN = `item.unit`/`packingSlip.unit` (**NO** asumir kg) | **Corregido v10 (2026-06-06).** El comentario previo decía *"`item.weight` SIEMPRE llega en KG"* — **falso, causaba doble conversión**. El input trae la unidad de **ORIGEN** explícita en `item.unit` y `packingSlip.unit` (id **3972 = LBR/libras**, 3969 = KGM/kg). En la remisión **#1090** (Wieland, flujo `partGroup`) `item.weight` venía **ya en LBR** (`{net:923, tare:25, gross:948}`, `item.unit.name="LBR Libra"`) y el hook v6–v9 lo multiplicaba ×2.2046 de todos modos → **duplicaba** (cajón 15 pz: neto 321.29 en vez de 145.74; tara 11.02 en vez de 5.00). **Fix:** `convertWeight(v, sourceIsLb)` con dos ejes — ORIGEN `sourceIsLb = unitIsLb(item.unit) ?? unitIsLb(ps.unit)`; DESTINO `displayInLb = UnidadMedidaPeso` (recursivo, igual que `weight-quick-entry.js`). Matriz: LBR+LB→tal cual · KGM+LB→×2.2046 · LBR+KG→÷2.2046 · KGM+KG→tal cual. La validación previa "confirmado vía DB que llega en KG (caso 1054, báscula 15/2 lb → 6.80/0.91 kg)" era cierta **solo para el flujo báscula**; el flujo `partGroup` entrega LBR. Cliente declara unidad en `customer.custom_input.DatosLogisticos.UnidadMedidaPeso` (`true`=LB; default KG). En TLC+MTY **solo WIELAND** usa LB. Lógica pura + tests en `tools/packing_slip_weight.mjs` (espejo inline en el `.ts`). |
| **gross/net/tare convencionales** | gross = total, net = piezas, tare = contenedor | Validado con la 1054: gross 15 lb = net 13 + tare 2. El binding cruzado en la plantilla (no el hook) hacía ver bruto↔neto invertidos. El mapeo del hook (`grossWeight`←`weight.gross`, etc.) es correcto. |
| **Contenarización (nombre)** | `rack.name` | Trazado en DB (WO 5122): el nombre del contenedor vive en `parts_transfer_account.rack_id` → `rack.name` (ej. `T109-BA01-001`, tipo `T109-BA01`); `super_rack_id` y `part_group` venían null. El hook lee `part.rack.name` → fallback `partGroup.name`. Validado: con **grupos de partes** `containerNameSource="partGroup"` y `partGroup.name` (ej. `03-1694355`). |
| **Grupos de partes vs contenedores físicos** | estructura del Input distinta | **Contenedores (rack):** cada contenedor es un `item` separado con su propio `item.partCount` e `item.weight` → piezas/peso por etiqueta directos. **Grupos de partes (partGroup):** Steelhead manda **1 solo `item`** con N `partsTransferAccounts` (1 por grupo); `item.partCount`/`item.weight` son el **TOTAL**. Por eso: (1) piezas → usar `part.partCount` (por grupo), NO `item.partCount`; (2) peso → `partGroup.containerWeight` viene **null**, solo existe `item.weight` (total) → se **reparte proporcional a piezas** (v8). Confirmado en Test Panel 2026-06-06. |

## Paginación de la remisión con etiquetas append (PDFGeneratorAPI)

Al anexar las etiquetas en el **mismo** PDF de la remisión, `{total_pages}` cuenta todo (remisión + N etiquetas) → el header de la remisión muestra "Página 1 de 3" en vez de "1 de 1".

- **Fórmula:** `páginas_remisión = total_pages − totalLabels` (cada etiqueta = 1 página; el hook ya expone `totalLabels` en la raíz).
- **Dónde:** `{total_pages}`/`{current_page}` SOLO se evalúan dentro de un componente **Header o Footer** (no en el body). El contador de la remisión ya vive en el header → ahí se puede restar.
- **Expresión** (en el texto del header): `Página {current_page} de {% {total_pages} - ({totalLabels} ?? 0) %}`. Variantes según editor: `{totalpages}` sin guión bajo, o el placeholder sin llaves dentro de `{% %}`.
- **Supuesto frágil:** 1 etiqueta = 1 página. Si una etiqueta ocupa >1 página, el descuento se queda corto (habría que exponer páginas-de-etiqueta reales desde el hook).
- **Plan B** si `total_pages` no resuelve dentro de `{% %}` (se calcula en fase de layout posterior a los datos): generar etiquetas como documento aparte y concatenar, o dejar solo `Página {current_page}`.
- **✅ Resuelto (2026-06-06):** el usuario confirmó que la resta en el header funciona — la remisión muestra "Página 1 de 1" correctamente.

## Consolidar el cuerpo de la remisión por PN (✅ resuelto 2026-06-06)

Al usar grupos de partes/contenedores, cada grupo es un registro y la tabla nativa de la remisión listaba N renglones del mismo PN (ej. 5 × 10 PZA en vez de 1 × 50). **Resuelto** con **Group by** por número de parte en esa tabla: cantidades por-grupo sumadas con `{% sum({grouped_rows::<campo>}) %}`, contenedores con `{% count({grouped_rows}) %}`; los campos comunes (PN, descripción, referencias, cantidad recibida) se muestran sin sumar. El usuario confirmó que quedó consolidado en una sola línea.

## Plan de validación (estado al 2026-06-06)

1. **Fecha**: `shippingDate` → `shippedAt` fallback. Se entrega además `shippingDateFmt` (`d/m/Y H:i`). ✅ Validado en remisión real.
2. **Piezas por grupo**: ✅ `piecesPerContainer` = `part.partCount` (no `item.partCount`). Confirmado en Test Panel (20/25 por grupo, no 95).
3. **rack vs partGroup**: ✅ con grupos de partes `containerNameSource="partGroup"`, `partGroup.name` (ej. `03-1694355`). `rack`/`super_rack`/`containerWeight` venían null.
4. **Peso por grupo**: ✅ reparto (neto proporcional + tara igual). Steelhead **no** expone peso por grupo (`partGroup.containerWeight=null`); se reparte `item.weight`.
5. **Unidad de peso**: ✅ conversión **por unidad de ORIGEN real** (`item.unit`/`packingSlip.unit`, id 3972=LBR) hacia el destino del cliente (`UnidadMedidaPeso`). **v10** corrige la doble conversión cuando `item.weight` ya viene en LBR (flujo `partGroup`, #1090). Verificado end-to-end con el dump real: 5 grupos suman neto 923.01 / bruto 948.01 (= `totalWeight`).
6. **Paginación + consolidación de la remisión**: ✅ resueltas en plantilla (ver secciones arriba).

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

- **v10 (2026-06-06, id=10630)**: **fix doble conversión de peso**. El hook asumía `item.weight` SIEMPRE en KG y multiplicaba ×2.2046 para clientes LB; pero el input trae la unidad de **ORIGEN** explícita en `item.unit`/`packingSlip.unit` (id 3972=LBR). En #1090 (Wieland, `partGroup`) `item.weight` venía en **LBR** → se **duplicaba** (cajón 15 pz: neto 321.29 en vez de 145.74; tara 11.02 en vez de 5.00). Ahora `convertWeight(v, sourceIsLb)` con dos ejes: ORIGEN `unitIsLb(item.unit) ?? unitIsLb(ps.unit)` vs DESTINO `UnidadMedidaPeso`. **Verificado end-to-end** con el dump real de #1090: 5 grupos suman neto 923.01 / bruto 948.01 (= `totalWeight` 923/948 ✓). Lógica pura + 15 tests `node:test` en `tools/packing_slip_weight.mjs` (espejo inline en el `.ts`). Typecheck `tsc --target es2017 --strict` verde. **Deployado** vía `lowcode_sync.py push ... pdf:PACKING_SLIP_TEMPLATE` → id=10630.
- **v9 (2026-06-06, id=10629)**: **tara igual entre grupos** (decisión del usuario). El empaque no escala con piezas → la **tara** se reparte igual entre los grupos del item (`item.weight.tare / itemGroups`, `itemGroups` = filas por item); el **neto** sigue proporcional a piezas (`× wFrac`); el **bruto** = neto + tara. Suma de grupos reconstituye el total. Verificado: tara 13 kg → 5.73 LB igual en los 5 grupos; suma cuadra. `shareW` eliminado.
- **v8 (2026-06-06, id=10628)**: **reparto proporcional del peso por grupo** — confirmado en Test Panel que con grupos de partes Steelhead manda 1 `item` con N PTAs, `partGroup.containerWeight` viene **null** y solo hay `item.weight` (total). Se reparte el peso del item entre los grupos proporcional a `part.partCount` (`wFrac = part.partCount / item.partCount`); válido porque el PN es uniforme. Para contenedores físicos (1 PTA/item) `wFrac=1` → sin cambio. `conv` ahora redondea siempre a 2 dec. Verificado: 948/935/13 kg → grupos 440/550/… LB, suma cuadra con el total. Chip multi-parte actualizado.
- **v7 (2026-06-06, id=10627)**: **fix piezas con grupos de partes** — `piecesPerContainer` ahora prioriza `part.partCount` (piezas del PTA/grupo) sobre `item.partCount` (total del item). Con flujo de **grupos de partes** (no contenedores físicos) Steelhead manda 1 `item` con N PTAs, y `item.partCount` es el total → mostraba el 100% en cada etiqueta. (Peso por grupo resuelto en v8/v9: reparto proporcional + tara igual.)
- **v6 (2026-06-05, id=10626)**: **conversión de peso por cliente** — `item.weight` llega en KG; si el cliente captura en libras (`UnidadMedidaPeso`, detección recursiva igual que `weight-quick-entry.js`) se convierte `grossWeight`/`netWeight`/`tareWeight` kg→lb (×2.2046226218, 2 dec) y se emite `weightUnit` (`"LB"`/`"KG"`, también en raíz). Clientes KG sin cambio. Verificado: 6.80/5.90/0.91 kg → 15/13/2 LB. Confirmado en DB que Wieland captura en LBR y el mapeo gross/net/tare del hook es convencional (el cruce que veía el usuario era binding de plantilla). Typecheck es2017 verde.
- **v5 (2026-06-05, id=10624)**: (1) **null → "" en todas las ramas** del label (y raíz) — PDFGeneratorAPI **no crea nodo** para campos `null` en toda la muestra, así que `containerName`/`containerNameSource`/`containerWeightUnit` (vacíos hasta contenarizar) no se podían colocar en la plantilla. Coerción `Object.keys(label).forEach(k => if null → "")`. (2) + `shippingDateFmt`: fecha de embarque ya formateada `d/m/Y H:i` (24 h) en `inputs.timezone` (`Intl.DateTimeFormat`, fallback regex sin TZ) — la plantilla imprime `{shippingDateFmt}` sin la función `date()` de Twig (que tronaba con `DateTime::__construct(): array given`). Verificado en Node: `2026-06-05T20:36:03+00:00` → `05/06/2026 14:36`. Typecheck es2017 verde.
- **v4 (2026-06-05, id=10623)**: + `salesOrder`/`salesOrderId` por etiqueta (de `workOrder.receivedOrder.name`/`.idInDomain` = OV) y `packedBy` (de `inputs.currentUser.name`, también en la raíz del payload). Nuevo diagnóstico `missingSO` (chip warning) + empacador en el `log`. Typecheck `tsc --target es2017 --strict --alwaysStrict` en verde. **Aditivo**: no toca campos previos ni la remisión.
- **v3 (2026-06-01, id=10564)**: fix lector de PS — `customInputs.DatosRecibo.PackingSlip` (anidado) en vez de `["PS"]` plano. La v2 daba `ps: null`.
- **v2 (2026-06-01, id=10561)**: + `additionalPayload.labels[]` con 11 campos para etiqueta por contenedor (PN, descripción, pzas/caja, PS, batch, WO, fecha embarque, contenedor x/y, peso bruto/neto, nombre de contenedor rack/partGroup) + diagnóstico (chips de PS/nombre/peso/multi-parte). Preserva mutación `containerIndex`. Aditivo: no altera la remisión.
- **v1 (id=10477)**: solo mutaba `item.containerIndex`, `additionalPayload` vacío.
