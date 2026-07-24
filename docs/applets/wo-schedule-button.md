# wo-schedule-button — Programación INLINE en la ficha de Orden de Trabajo

**Versión:** 0.5.0 — **prioridad de carga #1**: el fetch de programación arranca lo antes posible (prefetch en init + `wo-schedule-button` movido al FRENTE de `apps[]` para que su interceptor se instale antes que paro-de-línea/vale-de-almacén). Readout como **texto que envuelve** (no caja/botón) + **un 📅 por tarea/estación** (accionable en Fase 2). F1 conectada con `WorkOrderSchedule`. Core compartido `wo-schedule-core` 21/21 golden.

## Prioridad de carga (v0.5.0)

El supervisor típicamente escanea un QR en piso → entra a la ficha de la OT → quiere ver **a qué hora está programada**. Ese dato es el **#1**, más que hacer un vale de almacén o registrar un paro de línea. Por eso:
- **`wo-schedule-button` va PRIMERO en `apps[]`** (index 0). El loader (`background.js`) inyecta los `autoInject` **secuencialmente en orden de `apps[]`** (`for (const app of autoApps) await injectAppScripts`), así que ir primero = su `patchFetch` se instala antes de que la ficha dispare la `WorkOrderSchedule` nativa → el interceptor la **cacha** (sin doble fetch) y se pinta apenas llega.
- **Prefetch en `init()`**: dispara el fetch (`WorkOrder`→id global + `WorkOrderSchedule`) **sin esperar a que renderice el header**. `ensureResolved` memoiza + dedupe en-vuelo, así el prefetch temprano y el render on-mount comparten UN solo fetch (nunca doble). El readout se pinta en cuanto el header aparece (o antes, si ya resolvió).
**Categoría:** Órdenes de Trabajo · **autoInject:true** · ruta: `/Domains/<d>/WorkOrders/<idInDomain>` (ficha individual)

## Qué hace

En la ficha de una OT muestra, **DIRECTO en el header** (entre "EDITAR DETALLES" y "ABRIR PDF"), un readout **"📅 &lt;estación · fecha/hora local · estado&gt;"** de la programación de la OT. **NO requiere click** — la info sale sola al entrar a la ficha. "Sin programar" si no hay tarea.

Pedido por producción (2026-07-23): en iPad la tarjeta "Cliente" (que contiene el ícono 📅 nativo) se **colapsa** y deja de verse → este readout arriba la muestra siempre, sin depender de esa tarjeta ni de un click.

**Decisión de UX (a pedido del usuario):** a diferencia del diseño inicial (botón → modal), la Fase 1 es un **readout pasivo inline** con el 📅 al inicio. **Fase 2:** cuando se pueda PROGRAMAR desde aquí, el 📅 se vuelve **clicable** y abrirá el modal de programación intencional.

## Anclaje (handle semántico estable — sin texto bilingüe)

`data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON"` (idioma-agnóstico). "Abrir PDF" es el 1er elemento del grupo derecho del header; "Editar Detalles" el último del izquierdo. → Insertar el readout **antes de** `WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON` lo deja exactamente entre ambos. Montaje idempotente por `id` + `MutationObserver` (re-monta si React borra el nodo) + parche `pushState/replaceState/popstate` (re-evalúa al navegar entre fichas). Verificado contra el HTML real del header (2026-07-23).

## Datos + interceptor (evita el doble fetch de 4.6MB)

- `WorkOrder({idInDomain})` (hash `fc41042e…`) → **workOrderId GLOBAL** (`wo.id`).
- Índice del board: `WorkOrderSchedule({domainId, workOrderId})` (hash `7b1b1127…`) → board COMPLETO → `WoScheduleCore.buildBoardScheduleIndex` (índice slim, con `stationByStationId.name` embebido) → `resolveBoardScheduleForWO(woGlobalId)`. El link WO→tarea es `element.recipeNodeByRecipeNodeId.workOrderId`.
- **Interceptor:** la propia ficha dispara `WorkOrderSchedule` al cargar (~4.6MB). Un patch de `window.fetch` (guard `__saWoSchedFetchPatched`, world MAIN) **captura esa respuesta** (clone → `buildBoardScheduleIndex`), la guarda con TTL (120s) y evita el fetch propio. Si no aparece en una ventana corta (6×300ms), se hace fetch propio como **fallback**. Solo se guarda el índice slim; el raw se descarta. Estilo `board-metal-tooltip`/`surtido-guard` (interceptor pasivo).
- Render: estación · fecha/hora local (`es-MX`) · estado (`scheduleStatusLabel`: QUEUED→"En cola", etc.). **Multi-tratamiento:** si la OT se agenda en varias líneas, se muestran **TODAS las tareas apiladas** (clase `sa-wosched-multi`), ordenadas por fecha; tooltip con la lista numerada.

## UI (v0.4.0 — texto + 📅 por tarea)

Ya **no es una caja/chip**: es **texto plano** que envuelve (`overflow-wrap:anywhere`, sin ellipsis → se ve completo), con **una fila por tarea = `📅` + texto** (`estación · fecha · estado`). El **📅 es el elemento accionable**: hay **uno por cada estación/paso** donde la OT está programada, y en **Fase 2** su click abrirá el modal para programar **ese** paso (por eso cada 📅 guarda `data-sa-station-id`/`data-sa-schedule-id`/`data-sa-task-id`). Fase 1: `cursor:default` + tooltip "próximamente". `max-width:min(46vw,460px)`, apilado vertical. Estados: cargando/sin-programar (gris itálica), error (rojo). `textContent` (no innerHTML). Sin programar → **1 📅** como entrada para programar en Fase 2. **Motivo del cambio (usuario):** la chip truncaba el texto ("…") y no se veía completa; y debe haber tantos 📅 como estaciones.

## Fase 2 (hito aparte — crear programación)

El 📅 se vuelve clicable → modal dark-mode de programación intencional (estación + fecha/hora) que dispara la **mutación de creación** (sin capturar aún — terreno virgen). Captura con `hash-scanner` sobre una OT sin programar → agendar de prueba → guardar. Alta en `hash-autopilot` (centinela / captura-y-aborta).

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/wo-schedule-core.js` | Motor puro **compartido** con `wo-listing-columns`: `isWorkOrderDetailPath`, `parseWorkOrderIdInDomain`, `parseDomainId`, `extractWorkOrderGlobalId`, `buildBoardScheduleIndex`, `resolveBoardScheduleForWO`, `scheduleStatusLabel`, `formatShortDateTime`. |
| `remote/scripts/wo-schedule-button.js` | Glue DOM: readout inline en el header, interceptor de `WorkOrderSchedule`, fetch de `WorkOrder` + fallback. |
| `tools/test/wo-schedule-core.test.js` | 18 golden tests. |

## Plan de validación

- **Core:** 18/18 golden ✓.
- **En vivo (operador):** ficha `/WorkOrders/<id>` → readout 📅 entre EDITAR DETALLES y ABRIR PDF con la programación real (o "Sin programar"). Confirmar que el interceptor evita el doble fetch (una sola `WorkOrderSchedule` en la red).
