# Catálogo de Power Tools / Low-Code de Steelhead

> **Bitácora viva.** Inventario completo de las APIs GraphQL que Steelhead expone para leer/escribir hooks low-code (`.ts` que pega el operador en el editor). Baseline construida del scan `scan_results_2026-05-25_194005.json` (370 MB, 396 ops, 1278 events). Cuando cambie un hash o aparezca un endpoint nuevo, se actualiza aquí.

## Resumen ejecutivo

Steelhead expone **8 categorías** de Power Tools low-code. Cada categoría tiene:
- Una **query de lectura** (devuelve `nodes[]` con `id`, `code`, `compiled`, `createdAt`, `userByCreatorId`).
- Una **mutation `Create*LowCode`** (sube `code` + `compiled` nuevos — crea versión, no actualiza).
- Acceso opcional vía `GetAllLowCodeConfigs` (catálogo maestro con `isActive`, `pdfTemplateId`, `customerByCustomerId`).

**No existen mutations `Update*`** — Steelhead versiona cada save. **Ni tampoco existe mutation de "activar"**: el último `Create*LowCode` siempre es la versión activa. Si quieres "revertir" una versión vieja, la UI te obliga a copiar-pegar su `code` a la current revision y guardar (= crear una versión nueva idéntica a la vieja). Confirmado en UI por el usuario 2026-05-25.

## Las 8 categorías

| # | Categoría | Read | Write | Discriminador | Hook(s) TS típicos | Estado |
|---|---|---|---|---|---|---|
| 1 | **Received Order** | `ReceivedOrderLowCode` | `CreateReceivedOrderLowCode` | _ninguno (1 slot)_ | `getReceivedOrderCustomization` | tiene `powertools/ordendeventa.ts` |
| 2 | **Invoice** | `InvoiceLowCode` | `CreateInvoiceLowCode` | _ninguno (1 slot)_ | `getInvoicePricing` | tiene `powertools/facturacion.ts` |
| 3 | **PDF** | `PdfLowCode` | `CreatePdfLowCode` | `pdfType` enum | `getPdfCustomization` por template | tiene `powertools/facturacion-pdf.ts` (= `INVOICE_TEMPLATE`); 7+ slots más |
| 4 | **CSV** | `CsvLowCode` | _falta `CreateCsvLowCode`_ | `csvType` enum (sólo `INVOICE_TEMPLATE` visto) | hook de **generación** de CSV de output (no import) | NO usado por la operación; ver §Confusión común |
| 5 | **File Import** | `FileImportLowCode` | `CreateFileImportLowCode` | `fileImportType` enum (`QUOTE_IMPORT` visto) | hook de parseo de archivos de entrada (Excel/CSV → quotes/PNs) | inexplorado en repo; **es lo que la operación llama "CSV de cotizaciones"** |
| 6 | **Inventory Usage** | `InventoryUsageLowCode` | `CreateInventoryUsageLowCode` | _ninguno (1 slot)_ | `getInventoryItemPredictedUsageCustomization` | inexplorado |
| 7 | **Fee** | `FeeLowCode` | `CreateFeeLowCode` | `feeId` (uno por Fee) | `getFeePricing` (agrega líneas a SO) | inexplorado |
| 8 | **Schedule** | `ScheduleLowCode` | `CreateScheduleLowCode` | _ninguno (1 slot)_ | hook de scheduling | inexplorado |

## Hashes confirmados (2026-05-25)

```
# Reads (queries)
ReceivedOrderLowCode      09d7531d28944684340fdf6449c4f6196253c0a97db37b142c9e8a826b118858
InvoiceLowCode            736c36db4d05b408e0e475b679361f2b91ae28c1737380a6ac7f55a6c44e2438
PdfLowCode                3952791b76693673c2f7e3ae38f1cd880e5591954c484a7b7ba01502be434788
CsvLowCode                0e3f7e4853c277c504f60eac342e7b4f3adba8455f00a83b6eb25d4b0e0eab6c
FileImportLowCode         62c85b627d0346ed842f33f2a6e87357886b5290be6e377d27beec830a3ddb63
InventoryUsageLowCode     06242ff2f943e16c64f7694ccfcad11e2397829154851f745505e0fe53c2705b
FeeLowCode                7ebaf6d6382d4588d828a0fda129bd8c614f7ba48d487e6a02979b28c0d65fb0
ScheduleLowCode           7a69b000ef2d80185bb6a982cbdeeefc89bb8ef4e9015dbd24c4531d6329b24b

# Writes (mutations) — 7 de 8 capturadas (CSV pendiente porque no la usamos hoy)
CreateReceivedOrderLowCode  17ce5facb8d56ff314b20ed800abaffdab684aec9ab4b5803667bdcfc0dbdf36
CreateInvoiceLowCode        0b7ba49b6ad498f225d3f532a27a0ec77d9241eaca18d3f2ea66083cbe733447
CreatePdfLowCode            d62963890dc2ea10df8e5be2dc2b8f85443074969a3ecdb337d7e9459afbd9d4
CreateFileImportLowCode     0be38b3d6c362b5ed516dd71eefcde6f19391a0528ea23ffd49fce6b468a7185
CreateInventoryUsageLowCode cd920bb05f59c398e90eb25bd8142140960a9275e77713d7ecac9936d907e4bf
CreateFeeLowCode            3617aa40398014d64d2f6060cd546f029c363b03c2b92647b87c5a09ea2a4ca7
CreateScheduleLowCode       1aadcd386e8c3a78956d8a2163a5b30590512adb34b59bc58e2699475cc7ab12
# CreateCsvLowCode          — pendiente (categoría no usada por la operación; ver §"Pendientes")

# Catálogo / activación
GetAllLowCodeConfigs            d56b0a4112beeb7d7c7e6bf2b61ca829a870a1527e0de9ec8c5711ad5fcb1a13
GetAllLowCodeConfigsForShipping 61c1daa953e150930c4e4cd0e8a441e81549d3b8827810c6b049360e180e70dd

# Contextual data (los fetch que la UI hace al cargar el editor)
ReceivedOrderLowCodeData  d267076cd67237cce1614afd122f7b03d64363d053d20e856bb241d8ddea70da
InvoiceLowCodeData        319b44ca39d9a1aca0d35a40ff47cee7950eaae41c48ae6336177724e4760d9e
DataForFeeLowCode         4fe62826b43cd951e6bfc40fdab12eabf7826ecd8a1a53bf33dd8af63d53e562
```

## Hashes pendientes de capturar (1)

| Hash faltante | Para qué | Cómo dispararlo |
|---|---|---|
| `CreateCsvLowCode` | Push de hooks CSV (probablemente generación de CSV de output, no import). La operación no lo usa hoy. | Editor de un hook CSV en Steelhead, cambio cosmético, Save |

Notas:
- **No falta mutation de "activar"** — confirmado que no existe (la UI sólo permite reactivar via copy-paste-save → otra `Create*LowCode`).
- **`CreateCsvLowCode` se considera baja prioridad** — los samples sólo muestran `csvType: "INVOICE_TEMPLATE"` (1 slot) y no parece estar en flujo activo de la operación. Se captura cuando aparezca un caso real.

### Confusión común: CSV import ≠ `CsvLowCode`

Lo que la operación edita como "low-code de importación CSV de cotizaciones" es **`FileImportLowCode` con `fileImportType: "QUOTE_IMPORT"`**, NO `CsvLowCode`. Los nombres confunden:

- **`FileImportLowCode`** = hook que parsea archivos de entrada (Excel, CSV, etc.) para crear quotes/PNs/etc. Discriminado por `fileImportType` enum. **Esto es lo que usamos**.
- **`CsvLowCode`** = aparentemente hook que genera CSV de salida (export) para invoices. Discriminado por `csvType` enum. **No usado hoy**.

## Modelo de versionado (clave)

Cada `Create*LowCode` **crea un nodo nuevo** (no actualiza). El servidor mantiene la lista completa de versiones. Una sola está activa a la vez (`isActive: true` en `GetAllLowCodeConfigs.generalConfigs.nodes[]`).

Ejemplo observado para `WORK_ORDER_PART_NUMBER_TEMPLATE`:

```
id   pdfTemplateId  isActive  createdAt              createdBy
12118  1300583       null      2026-03-19  deployment (bot)
11502  1299421       null      2026-02-10  deployment (bot)
10824  1298195       null      2025-12-18  deployment (bot)
 9974  1296783       TRUE      2025-10-29  OMAR FIDEL VIAZCAN GOMEZ
```

→ Las versiones marcadas como `deployment` provienen del pipeline interno de Steelhead. Las nuestras son las marcadas con tu usuario. `isActive=true` es la que el frontend de Steelhead ejecuta.

**Implicación para el bridge Push:**
1. Pull → obtener `id` activo de la versión actual.
2. `Create*LowCode(code, compiled)` → genera nodo nuevo con `id` nuevo.
3. `Activate*` (mutation pendiente) → marca el nuevo como activo y desactiva el viejo.
4. Verificar con `GetAllLowCodeConfigs` que el active flag rotó.

## Inventario tras primer pull (2026-05-25)

`tools/lowcode_sync.py pull` materializó **17 slots activos** del dominio TLC en `powertools/synced/`. Distribución:

| Categoría | Slots | LIVE (body con lógica) | SOLO TYPEDEFS (body = `return result;`) |
|---|---|---|---|
| received-order | 1 | 1 | 0 |
| invoice | 1 | 1 | 0 |
| inventory-usage | 1 | 0 | **1** |
| schedule | 1 | 1 | 0 |
| file-import | 1 (`QUOTE_IMPORT`) | 1 | 0 |
| pdf | 12 | 6 | **6** |
| **Total** | **17** | **10** | **7** |

> **Aclaración importante sobre "SOLO TYPEDEFS"**: estos hooks SÍ tienen contenido (entre 2,877 y 41,010 chars). El editor de Steelhead pre-puebla todos los low-code con un esqueleto que incluye `interface Inputs {...}` enorme, enums (ej. códigos SAT), y firma de la función. Lo que está **vacío es el body de la función** — sólo `return result;`. Cuando abres uno en la UI de Steelhead ves cientos de líneas de typedefs y crees que "tiene código", pero la lógica de transformación está vacía y Steelhead cae al template default del PDF.
>
> **Origen de los 7 esqueletos en TLC**: confirmado 2026-05-25 — todos los slots SOLO-TYPEDEFS tienen una sola versión histórica creada entre 01:11–02:02 UTC del 2026-05-26, attribute al usuario OMAR, en el rango exacto del scan `scan_results_2026-05-25_194005.json` (19:40 hora MX). El hash-scanner al navegar por cada editor de Power Tool disparó un `Create*LowCode` automático con el seed que Steelhead pre-puebla. Hooks LIVE como `INVOICE_TEMPLATE` también ganaron una entrada nueva en ese rango, pero su historial profundo (11+ versiones desde 2025-10-22) está intacto. **No hubo pérdida de lógica** — esos 7 hooks nunca tuvieron body custom escrito.

### Detalle por slot

| Slot | Archivo | Líneas | Estado | Rol / dato clave |
|---|---|---:|---|---|
| received-order | `received-order/received-order.ts` | 796 | LIVE | `getReceivedOrderCustomization` — lote mínimo, NP Desconocido, Schneider+JR, mensajes por severidad. Ver `powertools-ordendeventa.md` |
| invoice | `invoice/invoice.ts` | 606 | LIVE | `getInvoicePricing` — construcción de descripción CFDI por SAT (NP+acabados+OV+OT+lote), parser de `partAccounts[].receivedBatch`, flags `DatosFacturaFlags` |
| inventory-usage | `inventory-usage/inventory-usage.ts` | 139 | **SOLO-TYPEDEFS** | `getInventoryItemPredictedUsageCustomization` — esqueleto. Inputs traen `partNumber.customInputs.DatosFiscales`, `Densidad`, `selectedTreatments`, `inventoryTransforms` (toda la info para inferir consumo predictivo) |
| schedule | `schedule/schedule.ts` | 122 | LIVE | Reordena tasks `UNSCHEDULED` priorizando `accountId ∈ [1, 5]` (TLC y MTY) y reasigna `expectedStartTime` para que la cuenta prioritaria salte la cola |
| file-import:QUOTE_IMPORT | `file-import/QUOTE_IMPORT.ts` | 263 | LIVE | Plantilla v7.1 — parser CSV (semi/coma auto), fix UTF-8→Latin-1, multi-idioma (en/es), crea Quote Lines con PN + proceso + UUID si hay colisión PN+process |
| pdf:INVOICE_TEMPLATE | `pdf/INVOICE_TEMPLATE.ts` | 917 | LIVE | Payload para plantilla PDFGeneratorAPI de factura — limpia direcciones, formatea XML, agrupa lotes y PS |
| pdf:CERTIFICATION_TEMPLATE | `pdf/CERTIFICATION_TEMPLATE.ts` | 809 | LIVE | CoC — agrupa specs por treatment |
| pdf:WORK_ORDER_PART_NUMBER_TEMPLATE | `pdf/WORK_ORDER_PART_NUMBER_TEMPLATE.ts` | 588 | LIVE | Etiqueta WO×PN — formatea spec params como `name: paramList` |
| pdf:RACK_TEMPLATE | `pdf/RACK_TEMPLATE.ts` | 517 | LIVE | Etiqueta rack — busca rack actual, filtra por mismo WO y tipo, ordena por `rackId` |
| pdf:PACKING_SLIP_TEMPLATE | `pdf/PACKING_SLIP_TEMPLATE.ts` | 388 | LIVE | Remisión — construye `additionalPayload` |
| pdf:PART_NUMBER_TEMPLATE | `pdf/PART_NUMBER_TEMPLATE.ts` | 244 | LIVE | Etiqueta PN — flatMap de `partNumberProcessNodes[].treatment.specFieldParams` |
| pdf:BILL_OF_LADING_TEMPLATE | `pdf/BILL_OF_LADING_TEMPLATE.ts` | 187 | **SOLO-TYPEDEFS** | BOL — template default |
| pdf:QMS_CAR_TEMPLATE | `pdf/QMS_CAR_TEMPLATE.ts` | 203 | **SOLO-TYPEDEFS** | QMS Corrective Action Request — template default |
| pdf:QUOTE_UNIT_PRICE_TEMPLATE | `pdf/QUOTE_UNIT_PRICE_TEMPLATE.ts` | 1050 | **SOLO-TYPEDEFS** | Cotización ("Híbrida") — template default. Llamativo porque es uno de los PDFs más usados |
| pdf:RECEIVER_TEMPLATE | `pdf/RECEIVER_TEMPLATE.ts` | 164 | **SOLO-TYPEDEFS** | Receptor (remisión de entrada) — template default |
| pdf:VENDOR_SHIPPER_TEMPLATE | `pdf/VENDOR_SHIPPER_TEMPLATE.ts` | 102 | **SOLO-TYPEDEFS** | Embarque a maquila — template default |
| pdf:WORK_ORDER_TEMPLATE | `pdf/WORK_ORDER_TEMPLATE.ts` | 177 | **SOLO-TYPEDEFS** | Orden de trabajo (vista "general") — template default. La operación trabaja con `WORK_ORDER_PART_NUMBER_TEMPLATE` (LIVE) |

### Interpretación

- **"SOLO-TYPEDEFS" = el body devuelve `result` sin asignar → `undefined` → Steelhead cae al template por defecto del PDF**. No es un bug; es opt-out explícito por inacción. Riesgo: cualquier edición que toque `return result;` mal puede empezar a romper el render del PDF si se asigna inválido.
- **Templates LIVE concentrados en docs de operación corriente**: factura, remisión, etiqueta PN, etiqueta WO×PN, etiqueta rack, CoC. Son los PDF que el operador ve a diario.
- **PDFs sin body custom = oportunidad de optimización**. Cada uno representa un canal donde podríamos añadir información (campos calculados, totales, validaciones) sin esperar cambio de plantilla por parte de Steelhead.

## Oportunidades de optimización detectadas

| Hook | Oportunidad | Por qué ahora |
|---|---|---|
| `inventory-usage` (vacío) | Pre-calcular consumo predictivo por treatment usando `partsToWhole` + `Densidad` + `inventoryTransforms`. Inputs ya traen todo; nadie escribe el hook hoy. | Operación pide "control e información" — predicción de consumos químicos por OV evita compras reactivas. |
| `pdf:QUOTE_UNIT_PRICE_TEMPLATE` (vacío) | Agregar al PDF de cotización: validación visual de "lote mínimo aplicado" o nota cuando el PN ya tiene proceso default. | Mismas validaciones que ya viven en `received-order` pueden visualizarse en cotización. |
| `pdf:RECEIVER_TEMPLATE` (vacío) | Hook puede leer `partGroup.labels` + `containerWeight` para imprimir códigos de bodega o checklist físico. | Hoy hay `warehouse-location-prefill` (extensión) que sólo prellena UI; el PDF imprime sólo el default. |
| `schedule` (LIVE, hardcoded) | Externalizar `priorityAccountIds = [1, 5]` a `customInputs` del cliente. Hoy un cambio de prioridad requiere editar TS. | El hook ya está vivo; con un guard por `customInputs.PrioridadCola` el operador puede mover prioridades sin tocar código. |
| `received-order` y `invoice` | Auditar `console.log`/`helpers.log` en producción. La bitácora `powertools-ordendeventa.md` ya advierte del `??=` ES2021 silencioso — hace falta una lista de "anti-patrones de runtime" centralizada. | Cada hook re-aprende los mismos gotchas (ES2017 target, `result` con 6 keys obligatorias, etc.). |
| Catálogo completo | Falta un `diff` periódico vs prod. Cuando el pipeline `deployment` (bot) inyecta versiones, no vemos qué cambió. | El bridge ya tiene `pull` y `diff`; basta crear un cron semanal local + alertar si hay nuevas versiones `deployment` con diff ≠ nuestro fork. |

## Cómo se compila el TS

El editor de Steelhead envía siempre **dos campos**: `code` (TS fuente) y `compiled` (JS ya transpilado por la UI antes de mandar). El backend ejecuta `compiled`. Esto significa:

- Si pusheamos vía API, **tenemos que generar el `compiled`** localmente. Opciones:
  - Usar `typescript` (tsc) localmente con el mismo `tsconfig` que Steelhead.
  - O capturar el compilado de la última versión activa y mandar siempre `code + compiled` que matchee (con `tsc --target es2017` parece ser suficiente — el bug del `??=` documentado en `powertools-ordendeventa.md` confirma que el target es **ES2017 o menor**).
- El `compiled` capturado en scans está truncado a ~13-22k chars; el `code` a ~22-32k chars. El factor ~1.4x sugiere transpilación + comment-strip, nada exótico.

## Bridge `tools/lowcode_sync.py` — estado

Implementado y verificado contra TLC el 2026-05-25:

| Comando | Estado | Notas |
|---|---|---|
| `list [--category X]` | ✅ | Cruzando `GetAllLowCodeConfigs` con multi-slot enums (12 PDF + 2 FileImport + 1 CSV) descubrió los 17 slots. |
| `pull [--category X]` | ✅ | Escribe `.ts` + `.meta.json` (id, createdAt, createdBy, chars, hash) por slot en `powertools/synced/<categoria>/`. |
| `pull --all-versions` | ✅ | Trae historial completo (no sólo el activo). |
| `diff <archivo.ts>` | ✅ | Diff unified vs el activo en servidor. |
| `show <slot>` | ✅ | Imprime el código actual sin escribirlo. |
| **`push <archivo.ts>`** | ❌ pendiente | Bloqueado por: (a) generar `compiled` JS desde `code` TS con `tsc --target es2017`, (b) `CreateCsvLowCode` falta (no urgente). |

Bridge reusa `SteelheadClient` de `~/Projects/Ecoplating/Reportes SH/scripts/steelhead_client.py` vía `sys.path` injection (mismo patrón que `tools/validate-hashes.py`). Hashes en `PERSISTED_QUERIES_LOWCODE` dentro del propio script (no en `remote/config.json` — son sólo para uso local de mantenimiento, no para la extensión).

## Lecciones del scan grande (2026-05-25)

- **`GetAllLowCodeConfigs` es el endpoint más solicitado** (1242 veces en 20 min de scan). La UI de Steelhead lo dispara repetidamente. Para el bridge, cachear durante un mismo run.
- **Hash-scanner trunca `code`/`compiled` a ~13-32k chars** (limitador de tamaño de archivo). Para recuperar fuente completa hay que ejecutar la query con el bridge — no se puede reconstruir desde scans.
- **`eventLog` no trae payloads**, sólo `{ts, op, varsSig, ok, status}`. Útil para frecuencias, no para forensia.
- **Hay un `GetAllLowCodeConfigsForShipping` aparte** que no aparecía antes — probablemente porque la UI tiene una pestaña separada para shipping. Existe pero no la hemos explorado.

## Próximos pasos

Completado:
1. ✅ Captura de hashes (8 reads + 7 writes + catálogo).
2. ✅ Bridge `tools/lowcode_sync.py` con `list`, `pull`, `diff`, `show`.
3. ✅ Pull inicial — 17 slots materializados en `powertools/synced/`.
4. ✅ Catálogo enriquecido con clasificación LIVE vs SOLO-TYPEDEFS + oportunidades.

Pendientes:
1. **Bridge `push`**: implementar compilación local (`tsc --target es2017`) + `Create*LowCode`. Sin esto, todo edit sigue siendo copy-paste manual al editor de Steelhead.
2. **Sub-bitácoras**: arrancar con los 6 PDFs LIVE menos documentados (`CERTIFICATION_TEMPLATE`, `RACK_TEMPLATE`, `PART_NUMBER_TEMPLATE`, `PACKING_SLIP_TEMPLATE`, `WORK_ORDER_PART_NUMBER_TEMPLATE`, `INVOICE_TEMPLATE`). El user decide orden según prioridad operativa.
3. **Implementar oportunidades**: en orden de mayor impacto, abrir el hook vacío `inventory-usage` (predicción consumos químicos) o externalizar `priorityAccountIds` del `schedule`.
4. **Cron de drift**: `lowcode_sync.py list --remote-only` comparado con local cada semana, alertar si llegó nueva versión `deployment` con `code` distinto.
5. **`CreateCsvLowCode`**: capturar cuando aparezca caso real (no urgente — categoría sin uso operativo).
