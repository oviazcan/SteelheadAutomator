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

## Fase 2 — programación intencional desde la ficha (hallazgos + estado)

Objetivo: cada **📅** clicable → modal dark-mode → programar/fijar **sin abrir el calendario nativo** (el paso que el usuario quiere ahorrar). Diseño acordado: **dos botones de confirmación** — (1) fijar/mover a **intencional** con fecha/hora (esta tarea); (2) además **reacomodar** (reschedule, DESTRUCTIVO → modal de advertencia de que el resto del schedule se recorre).

### Mutaciones (scan 2026-07-23, ScheduleBoard 454 + ficha OT 14983)

| Mutación | Hash | Estado | Notas |
|---|---|---|---|
| **`UpdateManyScheduleTasks`** | `14c097944a…` | **payload CAPTURADO** (button:Update en la ficha) | Input chico (~245B): `{scheduledTasks:[{id, scheduleId, stationId, expectedStartTime, totalTimeMinutes, cycleTimeMinutes, treatmentTimeMinutes, isIntentional}]}`. Resp 98B `{mnUpdateScheduleTaskById}`. **UPDATE por id** (`…ById`) → NO crea; la tarea debe existir. `isIntentional:true` = STATIC-SCHEDULED. |
| `CreateManyScheduleTasks` | `9039afe7…` | **payload PENDIENTE** (nunca capturado, vars vacías) | Para crear en OT sin tareas. El usuario proveerá el payload. |
| `DeleteManyScheduleTasks` | `ecfa83fe…` | payload pendiente | Parte del reschedule. |
| `UpdateManyStationTasks` | `de13ff5f…` | payload pendiente | Parte del reschedule. |

**Deducción (¿el Update crea?): NO.** Evidencia observada: el Save del board dispara **Create + Update + Delete por SEPARADO** (si el Update fuera upsert, no existiría un Create aparte) + la resp `…ById` = update-por-id. No se hizo write-test a ciegas (riesgo de tarea fantasma en prod). → Para crear hace falta `CreateManyScheduleTasks`.

**Reschedule (botón 2, destructivo):** = la combinación `Create+Update+Delete+UpdateStation` que dispara el Save del board (reacomoda todo). Payloads aún sin capturar. Requiere **modal de advertencia**. Hito posterior.

### Listo (base segura, SIN escrituras ni deploy)
- Core `WoScheduleCore.buildScheduleTaskUpdateInput(task, {expectedStartTime, isIntentional})` → arma el input del update (echo de todos los campos + override fecha + `isIntentional:true`), **fiel al payload real**. Tests golden.
- El extractor `buildBoardScheduleIndex` ya guarda `cycleTimeMinutes`/`treatmentTimeMinutes` (necesarios para el update).
- Cada 📅 del readout ya guarda `data-sa-task-id`/`data-sa-schedule-id`/`data-sa-station-id`.

### Payloads capturados (scan 2026-07-23_185855, ScheduleBoard 454)

**UPDATE `UpdateManyScheduleTasks`** (hash `14c097944a…`) — LIGERO, para FIJAR una tarea existente:
```
{ scheduledTasks: [{ id, scheduleId, stationId, expectedStartTime,
  totalTimeMinutes, cycleTimeMinutes, treatmentTimeMinutes, isIntentional }] }
```
Resp `{mnUpdateScheduleTaskById}`. Es update-por-id (echo de todos los campos + cambia fecha + `isIntentional`).

**CREATE `CreateManyScheduleTasks`** (hash `9039afe7…`) — PESADO, para crear en OT sin tarea. Forma DISTINTA (anidado en `mnScheduleTask`, con ELEMENTOS):
```
{ scheduledTasks: { mnScheduleTask: [{
    scheduleId, treatmentId, stationId, expectedStartTime,
    totalTimeMinutes, cycleTimeMinutes, treatmentTimeMinutes,
    isIntentional:false, status:"UNSCHEDULED",
    scheduleTaskElementsByScheduleTaskId: { nodes: [{
      partSetUuid, recipeNodeId, partNumberId, rackIdLineage, rackTypeIdLineage,
      partCount, partsPerBatch, relatedPartTransferAccounts:[{ id, partCount }]
    }] } }] },
  scheduleIdFilter: { equalTo: <scheduleId> } }
```
Requiere ENSAMBLAR por WO: `treatmentId`, `recipeNodeId`, `partNumberId`, `partSetUuid`, `partCount`, `partsPerBatch`, `relatedPartTransferAccounts.id` (el account del paso). Fuentes: `SchedulablePartLocations` (recipeNodeId/partNumberId/stationId), `WorkOrder.currentPartsTransferAccounts` (account). **Sin mapear aún:** origen de `treatmentId`, los `times`, y `partSetUuid` (¿generado en cliente?). **Riesgo** de crear tareas malformadas.

**`UpdateManyStationTasks`** (hash `de13ff5f…`) = ventanas de disponibilidad de ESTACIÓN (con `rrule`), parte del reschedule; NO es tarea de WO. **Reschedule** = combinación (más datos) de Create/Update/Delete + UpdateStation; no hay mutación nueva.

### Fasado propuesto
- **Fase 2a (LISTA para cablear, bajo riesgo):** 📅 clicable → modal dark-mode (fecha/hora) → **UpdateManyScheduleTasks** (`isIntentional:true`) sobre una tarea EXISTENTE. Cubre el caso común (OT ya auto-agendada). Core `buildScheduleTaskUpdateInput` ✔ + tests. Falta: hash a config + regen route + UI + confirmación + refresh.
- **Fase 2b (compleja, riesgo):** CREATE en OT sin tarea → mapear origen de `treatmentId`/`times`/`partSetUuid`, ensamblar elementos desde `SchedulablePartLocations`+`WorkOrder`, validar en vivo. Core `buildScheduleTaskCreateInput` pendiente (hasta mapear fuentes).
- **Fase 2c (destructiva):** reschedule (reacomoda todo) → modal de advertencia. Última.

### Rutas de regeneración (deuda)
Los hashes de mutación (`UpdateManyScheduleTasks`, luego Create/Delete/UpdateStation) van a `config.mutations` **con** ruta en `hash-autopilot` (centinela captura-y-aborta; requiere DOM del calendario/modal nativo). Deuda hasta cablear.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/wo-schedule-core.js` | Motor puro **compartido** con `wo-listing-columns`: `isWorkOrderDetailPath`, `parseWorkOrderIdInDomain`, `parseDomainId`, `extractWorkOrderGlobalId`, `buildBoardScheduleIndex`, `resolveBoardScheduleForWO`, `scheduleStatusLabel`, `formatShortDateTime`. |
| `remote/scripts/wo-schedule-button.js` | Glue DOM: readout inline en el header, interceptor de `WorkOrderSchedule`, fetch de `WorkOrder` + fallback. |
| `tools/test/wo-schedule-core.test.js` | 18 golden tests. |

## Plan de validación

- **Core:** 18/18 golden ✓.
- **En vivo (operador):** ficha `/WorkOrders/<id>` → readout 📅 entre EDITAR DETALLES y ABRIR PDF con la programación real (o "Sin programar"). Confirmar que el interceptor evita el doble fetch (una sola `WorkOrderSchedule` en la red).
