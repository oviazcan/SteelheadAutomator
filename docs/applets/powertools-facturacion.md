# Power Tools `facturacion.ts` — `getInvoicePricing`

Hook low-code que genera las líneas reales de factura de Steelhead (`lowCodeDefaultInvoiceLineItems`) desde `inputs.uiInvoiceLineItems`. Es el primer eslabón del pipeline de facturación; el segundo es `facturacion-pdf.ts` (`getPdfCustomization`), que prepara los datos para la plantilla PDFGeneratorAPI.

## Responsabilidades

1. **Tipo de cambio** desde `domainCustomInputs.TipoCambio` por `invoiceDate` (o `1` si MXN). Bloquea con error si la factura mezcla divisas.
2. **Precio por producto** desde `allProducts[].pricesByProductId.nodes[0].price`.
3. **Cantidad efectiva** sumando `partAccounts[].quantity × conversionFactor(lineUnit)` sobre todos los `partNumberWorkOrders` de la línea.
4. **Cargo de lote mínimo** detectado por conversión `LO Lote` (unit id `5348`). Si `piezasPedidas ≤ piezasPorLote`, re-escala `rate = piezasPorLote × rateUnitario` y fuerza `quantity = 1`. La descripción incluye la subcadena `"Cargo de lote mínimo aplicado"` que el integrador SAT detecta para reconvertir la unidad a Lote oficial.
5. **Descripción CFDI** construida con `construirDescripcionCFDI` respetando los flags `DatosFactura` del cliente (`MostrarNP`, `MostrarAcabado`, `MostrarProducto`, `MostrarPO`, `MostrarOV`, `MostrarOT`, `MostrarLote`, `MostrarPS`, `MultiplicadorLineaOC`). Trunca a 1000 chars (límite SAT). **2026-05-27**: se removió `NotasAdicionales` del bloque 1 — ya no se concatena `" - <NotasAdicionales>"` después del nombre del NP. El campo sigue existiendo en `partNumber.customInputs.NotasAdicionales`, simplemente no se incluye en la descripción de factura.

   **2026-06-03 — Descripción compacta para el SAT (≤60).** `construirDescripcionCFDI`
   se reescribió para el límite de 60 chars del SAT: se quitó el NP (ya viaja en
   `Name`/`NoIdentificacion`), labels comprimidos (`OC `/`OT `/`Ac `/`L `, sin
   `Producto: `), separador de un espacio, colapso de `Lote==OC`, y el PS del cliente
   ya NO va en la descripción del SAT. No se trunca a 60 (la interfaz comparte el
   campo); en su lugar se emite un warning resumido cuando alguna línea supera
   `PRESUPUESTO_AVISO` (≈40, reservando la remisión que Steelhead anexa). El caso
   "Cargo de lote mínimo aplicado" preserva esa subcadena intacta. El path
   consolidado (Schneider) usa el mismo estilo; el listado `NPs(N) …` se conserva.
   Lógica pura verificada en `tools/invoice_description.{mjs,test.mjs}`.
6. **Consolidación Schneider Rojo Gómez** (ver sección dedicada abajo).

## Inputs / Outputs

- **Input clave**: `inputs.uiInvoiceLineItems[]` — el operador marca cuáles SOLIs facturar; cada uno trae `salesOrderLineItemId`, `productId`, `taxCodeId`. El hook completa `quantity`, `rate`, `description`.
- **Output**: `LowCodeResult.lowCodeDefaultInvoiceLineItems[]` (1:1 con `uiInvoiceLineItems` por default) + `customInputs: { exchangeRate }` para que Steelhead pinte el pill "Tipo de Cambio".

## Consolidación por Producto+Unidad (caso Schneider Rojo Gómez, Opción B, 2026-05-21)

Cliente Schneider Electric México planta Rojo Gómez requiere que la factura agrupe las líneas de venta por **Producto + unidad de venta + taxCode**, no por SOLI/NP. Ejemplo: 6 OVs con varios NPs cada una que comparten Producto "Niquelado" en unidad KG se colapsan a UNA sola línea con `quantity = sum(qty)` y `rate = totalAmount / totalQty` (promedio ponderado, equivalente fiscalmente).

### Activación

Flag a nivel **orden de venta**, leído de `salesOrders[i].customInputs.ConsolidarPorProducto`:

```ts
const sos = inputs.salesOrders ?? []
const sosConFlag = sos.filter(so => so.customInputs?.ConsolidarPorProducto === true).length
const consolidarPorProducto = sos.length > 0 && sosConFlag === sos.length
```

**Regla de mezcla**: solo consolida si **todas** las OVs de la factura traen el flag. Si la factura mezcla OVs con y sin flag, **no consolida** y emite warning (`"Factura mezcla OVs con y sin ConsolidarPorProducto (X/Y) — no se consolida. Separa la factura por planta."`).

**Por qué a nivel OV y no en otros lados** (descartados con dump 2026-05-22):

| Canal | Estado | Por qué no |
|---|---|---|
| `customer.customInputs` | descartado | Mismo cliente tiene varias plantas; over-dispara |
| `invoiceMetaData.customInputs` | descartado | Write-only desde el hook; el operador no puede marcar algo que el hook lea (dump dió `null`) |
| `inputs.shipToAddress` (root o anidado) | descartado | No expuesto en este hook (sí en `facturacion-pdf.ts`); ningún path candidato lo trajo |
| `salesOrders[i].customInputs` | **elegido** | Sí expuesto; extensible; el operador (o `ordendeventa.ts` auto) lo llena al crear la OV |

**Auto-poblado (pendiente)**: `ordendeventa.ts` (`getReceivedOrderCustomization`) sí tiene acceso a `inputs.shipToAddress.address` para detectar Rojo Gómez. Si ese hook permite escribir en customInputs de la OV, puede empujar `ConsolidarPorProducto: true` automáticamente al crear OVs con destino Rojo Gómez, eliminando la dependencia del operador. Verificar canal de escritura en el `LowCodeResult` del hook (la bitácora actual de `ordendeventa.md` solo confirma `partNumberUpdates.customInputs` para escribir en PN, no en OV).

### Mecánica

1. Durante el loop principal, además del push a `lowCodeDefaultInvoiceLineItems`, se acumula un `LineMetadata` paralelo (NP, acabados, lotes, PS, OTs, OV, productName, lineUnit, taxCodeId, índice).
2. Post-loop, si `consolidarPorProducto`:
   - Las líneas con `loteMinimoCargado === true` y las que no tienen `productId` **no se consolidan** (van tal cual).
   - El resto se agrupa por `${productId}||${lineUnit}||${taxCodeId}`.
   - Por grupo: `totalQty = sum(quantity)`, `totalAmount = sum(quantity × rate)`, `rate = totalAmount / totalQty`.
   - Una sola línea representativa con el `salesOrderLineItemId` del **primer** miembro del grupo.
   - Descripción agregada (formato compacto del 2026-06-03, sin labels largos): `X NPs(N) NP1, NP2 OC SO1, SO2 L L1, L2 Ac A OT WO1, WO2` — el Producto va como valor directo (sin `Producto: `), unido con un espacio y dedupando con `Set` (respetando flags).

### Riesgo conocido — SOLIs huérfanos

Cada `lowCodeDefaultInvoiceLineItem` lleva **un solo `salesOrderLineItemId`**. Al consolidar N líneas en una, los `N-1` SOLIs restantes del grupo quedan sin línea de factura asociada. Steelhead puede marcarlos como "no facturados" en su UI. El hook reporta cuántos SOLIs quedaron sin línea propia en un `info` message: `"Consolidación por Producto: X líneas → Y (Z grupo(s) consolidado(s), W SOLI(s) sin línea propia)"`.

Mitigación pendiente: investigar si Steelhead acepta `salesOrderLineItemIds: number[]` (plural) en `lowCodeDefaultInvoiceLineItems` para vincular múltiples SOLIs a una línea consolidada (similar al patrón `rowKey` documentado en `powertools-ordendeventa.md`).

### Consistencia con `facturacion-pdf.ts`

`facturacion-pdf.ts` expone **ambas vistas** (`invoiceLinesConLotes` per-línea y `lineasConsolidadasPorProducto` agregada) para que la plantilla PDF elija. `facturacion.ts` **decide en el hook** y solo emite una versión, porque el integrador SAT lee de los `lowCodeDefaultInvoiceLineItems` que se persisten en la factura — no hay forma de dejar las dos versiones disponibles.

## Diferencias intencionales vs el flujo per-line

- **Lote mínimo no se consolida**: su `rate` ya está re-escalado a "rate por lote completo". Mezclarlo con líneas normales rompería el promedio ponderado.
- **`productId == null` no se consolida**: sin producto no hay clave de grupo.
- **Descripción consolidada omite `salesOrderLineNumber` y `MultiplicadorLineaOC`**: pierde sentido cuando hay N líneas de origen.

## Flags `DatosFactura` (defaults)

| Flag | Default | Uso |
|---|---|---|
| `MostrarNP` | `true` | Incluir nombre del NP en la descripción |
| `MostrarAcabado` | `true` | Incluir labels del WO (acabados) |
| `MostrarProducto` | `true` | Incluir `Producto: X` |
| `MostrarRemision` | `true` | (Bloqueado: PS de embarque no expuesto en este hook) |
| `MostrarPO` | `true` | Incluir `OC: salesOrderName` |
| `MultiplicadorLineaOC` | `0` | Si `>0`, agrega `-lineNumber*N` al `OC:` |
| `MostrarOV` | `false` | Si `true`, agrega `(salesOrderIdInDomain)` al `OC:` |
| `MostrarOT` | `true` | Incluir `OT: workOrderIdInDomain` |
| `MostrarLote` | `true` | Incluir `Lote(s): X, Y` |
| `MostrarPS` | `true` | Incluir ` PS: A, B` al lado del lote |

**Nota**: `ConsolidarPorProducto` NO va aquí. Vive en `salesOrders[i].customInputs` (a nivel orden de venta, no cliente), porque el mismo cliente puede tener múltiples plantas con regímenes distintos.

## Plan de validación pendiente

- [x] Confirmar dónde vive el flag accesible al hook. Dump 2026-05-22 mostró: `invoiceMetaData.customInputs` null (write-only); shipTo no expuesto; `salesOrders[i].customInputs` sí accesible y extensible (ya trae `Divisa, RazonSocialVenta`).
- [ ] Configurar el customInput `ConsolidarPorProducto: boolean` en el schema del ReceivedOrder en Steelhead.
- [ ] Pegar el hook en el editor con una factura cuyas OVs traigan todas `ConsolidarPorProducto: true` y verificar que `lowCodeDefaultInvoiceLineItems.length < uiInvoiceLineItems.length`.
- [ ] Confirmar que el total facturado (`sum(quantity × rate)`) coincide bit-a-bit antes y después de la consolidación.
- [ ] Verificar que la línea consolidada se persiste en Steelhead al guardar la factura (sin error de SOLI duplicado o faltante).
- [ ] Revisar comportamiento de SOLIs huérfanos en la UI de Steelhead — ¿quedan visibles como "no facturados"? ¿el operador puede facturarlos en otra factura después?
- [ ] Probar factura SIN el flag en ninguna OV (otra planta de Schneider) para confirmar comportamiento 1:1.
- [ ] Probar factura **mixta** (algunas OVs con flag, otras sin) — debe emitir warning y NO consolidar.
- [ ] Probar con líneas mixtas: algunas en KG (consolidables), una con lote mínimo (no consolidable) — confirmar que la de lote mínimo sale aparte.

### Descripción compacta para el SAT (2026-06-03) — DESPLEGADO a productivo 2026-06-09

**Desplegado a productivo 2026-06-09** vía `tools/lowcode_sync.py push` (la operación valida
directo en productivo, no en sandbox):

- `invoice` (`getInvoicePricing`) → versión activa **#5304** (antes #5278, que aún traía `Producto: `).
- `pdf:INVOICE_TEMPLATE` (`getPdfCustomization`) → versión activa **#10682** (quita `<b>Producto: </b>` del bloque 1 del PDF).

La versión anterior de cada slot queda en el historial de Steelhead para rollback
(`python3 tools/lowcode_sync.py pull <slug> --all-versions`). Tras el push, `diff invoice`
y `diff pdf:INVOICE_TEMPLATE` dan **local == server** (0 diferencias).

Los hooks `.ts` no se prueban localmente; la lógica pura de strings está cubierta por
`tools/invoice_description.{mjs,test.mjs}` (8 casos verde). **Validación en productivo** (pendiente
de confirmar con factura real):

- [ ] Factura del ejemplo (NP `02104484`, OC `4507414828-10`) → `description == "Estañado OC 4507414828-10 OT 5086"`.
- [ ] Caso con `Lote ≠ OC` → aparece el bloque `L …`.
- [ ] Caso lote mínimo → la subcadena `"Cargo de lote mínimo aplicado"` está completa y el integrador SAT la reconoce.
- [ ] Factura con líneas largas → se emite **un** warning resumido y la `description` **no** sale truncada a 60 (la corta el XML).
- [ ] Factura consolidada (Schneider) → el warning cuenta las descripciones finales (post-consolidación), sin doble conteo.

## Pendientes derivados

- Considerar exponer un mensaje al operador listando los SOLIs huérfanos para que decida qué hacer con ellos.
- Si Steelhead expone `salesOrderLineItemIds: number[]` plural en algún momento, migrar para evitar SOLIs huérfanos.
- El `MostrarRemision` está deshabilitado en este hook porque `packing_slip_id` no está en el schema del Power Invoicing. Feature request pendiente a Steelhead.
- Investigar si Steelhead permite **defaults** en `invoiceMetaData.customInputs` por ship-to o por cliente (para que `ConsolidarPorProducto` se prepople al elegir el ship-to Rojo Gómez y el operador no tenga que marcarlo cada vez). Si existe, configurar el default desde la UI de Steelhead y dejar el hook tal cual (sigue leyendo el mismo campo).
- Sincronizar el mismo flag con `facturacion-pdf.ts` si es necesario que el PDF también respete una decisión por factura (hoy el PDF usa su propio detector basado en `shipToAddress`).
