# wo-schedule-button — Programación INLINE en la ficha de Orden de Trabajo

**Versión:** 0.7.0 — **+ Fase 2a: programación INTENCIONAL desde la ficha** (cada 📅 de una tarea existente abre un modal que fija su hora y la marca intencional, con la escritura VERIFICADA releyendo el programa). Ver §"Fase 2a cableada". **Previo 0.6.0** — **+ auto-impresión INVISIBLE de JobTag (fallback del iframe del listado)** (VIVO 1.7.200, 2026-07-24). En la ficha, si la URL trae `?sa_print=jobtag&sa_dl=1` (la abre el botón 🏷️ del listado SOLO cuando el iframe falla/está bloqueado), `maybeAutoPrintFromParam` **auto-maneja** el modal nativo de etiquetas: `findPrintTrigger` (ancla `data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_PRINT_JOB_TAGS_BUTTON"`, bilingüe/responsive-safe) → click → "Imprimir Regular" (espera dropdown poblado + `sleep(1000)` anti-blanco + `clickButtonRobust`) → **intercepta la respuesta de `GetPdfTemplateOutputV2`** para la share-URL (`patchFetch`, con fallback al `<object>` del preview) → **descarga** `WO<num>.pdf` + `window.close()` best-effort. `autoPrint(type,'download'|'self'|'newtab')`. **NO pone botones en la ficha** (decisión del usuario: el botón vive solo en Acciones del listado). El grueso del flujo vive **duplicado en `wo-listing-columns.driveLabel`** para el iframe (el padre maneja el iframe same-origin; la extensión no inyecta en iframes). Ver [`wo-label-pdf-buttons.md`](wo-label-pdf-buttons.md). Core `wo-schedule-core` **37/37**.
**Previo 0.5.0:** **prioridad de carga #1** del readout de programación (prefetch en init + `wo-schedule-button` al FRENTE de `apps[]`). Readout como **texto que envuelve** + **un 📅 por tarea/estación**. F1 con `WorkOrderSchedule`.

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

**CREATE `CreateManyScheduleTasks`** (hash `9039afe7…`) — PESADO, para crear en OT sin tarea.

> ⚠️ **Esta forma NO viene de un scan.** Barrido de los 122 `scan_results_*.json` (2026-07-28):
> la op aparece en **9**, y en los 9 con `variablesSamples` **vacías**. El shape de abajo se
> documentó de otra fuente (deducción / dictado), así que sirve como mapa pero **no es
> evidencia**: ni los nombres exactos ni los valores están confirmados contra tráfico real.
> Es la razón por la que "programar donde no hay" sigue sin poderse cablear — a diferencia del
> UPDATE, cuyo payload sí está capturado con variables y respuesta reales.

Forma DISTINTA (anidado en `mnScheduleTask`, con ELEMENTOS):
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
### Mapeo de fuentes del CREATE (revisado 2026-07-28 contra las respuestas reales)

`SchedulablePartLocations` resuelve **más de lo que decía esta bitácora**: una llamada por
estación del board devuelve 1107 `partLocations`, cada uno con
`{accountId, partCount, partNumberId, partGroupId, stationId, workOrderId, recipeNodeId,
rackByRackId, recipeNodeByRecipeNodeId, partNumberByPartNumberId.partNumberRackTypesByPartNumberId
[{partsPerRack, rackTypeId}]}`.

| Campo del CREATE | Estado | Fuente |
|---|---|---|
| `recipeNodeId` | ✅ resuelto | `SchedulablePartLocations` (lo trae directo — la bitácora lo daba por no mapeado) |
| `partNumberId`, `partCount`, `stationId` | ✅ resuelto | idem |
| `relatedPartTransferAccounts[].id` | ✅ resuelto | `accountId` de idem (o `WorkOrder.currentPartsTransferAccounts`) |
| `rackIdLineage` / `rackTypeIdLineage` | 🟡 probable | `rackByRackId` + `partNumberRackTypes[].rackTypeId` de idem — falta confirmar la forma de "lineage" |
| `treatmentId` | 🟡 resoluble | árbol `StationTreatmentByWorkOrder`, que ya se parsea por `recipeNode` (lo usa el auto-router) |
| `scheduleId` | ✅ resuelto | `WorkOrderSchedule` / URL del board |
| `expectedStartTime` | ✅ | lo elige el operador |
| `isIntentional:false`, `status:"UNSCHEDULED"` | ✅ | literales |
| **`partSetUuid`** | ❌ **sin resolver** | hipótesis: UUID generado en cliente. **Sin verificar** |
| **`totalTimeMinutes` / `cycleTimeMinutes` / `treatmentTimeMinutes`** | ❌ **sin resolver** | los valores del UPDATE capturado (`5`, `0.000909…` = 1/1100) son claramente **derivados**, no constantes: falta la fórmula |
| **`partsPerBatch`** | ❌ **sin resolver** | relación con `partsPerRack` del rack type, sin confirmar |

**Los tres pendientes de verdad son `partSetUuid`, los tiempos y `partsPerBatch`** — y ninguno se
puede deducir sin riesgo: una tarea con tiempos mal calculados entra al planificador y desacomoda
el piso. **Riesgo** de crear tareas malformadas.

**Camino corto:** capturar el payload REAL programando UNA orden desde el tablero con el
hash-scanner encendido. Eso entrega de golpe los tres campos con valores reales, y permite
derivar la fórmula de los tiempos comparándolos contra los datos de esa orden. Es el mismo camino
que hizo trivial la Fase 2a.

**`UpdateManyStationTasks`** (hash `de13ff5f…`) = ventanas de disponibilidad de ESTACIÓN (con `rrule`), parte del reschedule; NO es tarea de WO. **Reschedule** = combinación (más datos) de Create/Update/Delete + UpdateStation; no hay mutación nueva.

### Fasado propuesto
- **Fase 2a — ✅ CABLEADA (2026-07-28, v0.7.0).** Ver §"Fase 2a cableada" abajo.
- **Fase 2b (compleja, riesgo):** CREATE en OT sin tarea → mapear origen de `treatmentId`/`times`/`partSetUuid`, ensamblar elementos desde `SchedulablePartLocations`+`WorkOrder`, validar en vivo. Core `buildScheduleTaskCreateInput` pendiente (hasta mapear fuentes).
- **Fase 2c (destructiva):** reschedule (reacomoda todo) → modal de advertencia. Última.

### Rutas de regeneración (deuda)
Los hashes de mutación (`UpdateManyScheduleTasks`, luego Create/Delete/UpdateStation) van a `config.mutations` **con** ruta en `hash-autopilot` (centinela captura-y-aborta; requiere DOM del calendario/modal nativo). `UpdateManyScheduleTasks` ya está — ver §"Fase 2a cableada".

## Fase 2a cableada — programación intencional desde la ficha (v0.7.0, 2026-07-28)

Cada **📅 de una tarea existente** es clicable → modal dark-mode con la fecha/hora → **fija** esa
tarea y la marca `isIntentional` (STATIC-SCHEDULED: el planificador deja de moverla al reacomodar).
Sin abrir el calendario nativo, que era el paso que se quería ahorrar. Si la tarea ya está fijada,
el modal ofrece además **Quitar fijado**.

**El 📅 de "Sin programar" NO es clicable.** La mutación es update-**por-id**: sin tarea no hay
qué actualizar. Ofrecer un click que no puede escribir es peor que no ofrecerlo — el tooltip
manda al tablero, que es donde se crea la tarea (crear desde aquí es la Fase 2b).

### La escritura se VERIFICA, porque el servidor no confirma nada
`UpdateManyScheduleTasks` responde `{mnUpdateScheduleTaskById:{clientMutationId:null}}`: ni la
fecha, ni el `isIntentional`, ni la tarea. Un `await` sin excepción **no prueba que se aplicó** —
es el mismo modo de fallo que costó el fix *load-before-save* del auto-ruteador (el servidor
acepta la mutación y no hace nada, y la UI canta victoria). Así que al aplicar:
1. se manda la mutación;
2. se **releen** `WorkOrder` + `WorkOrderSchedule` **saltando todos los caches** (el índice que
   capturó el interceptor es la foto anterior: verificar contra él diría "✅" sobre datos viejos);
3. `WoScheduleCore.verifyScheduleTaskApplied` compara la tarea releída con lo pedido — el
   **instante**, no la cadena, porque el servidor normaliza el formato ISO;
4. si no coincide, el modal lo dice con todas sus letras y manda a revisar el tablero.

### La conversión de hora va en el núcleo puro
El servidor habla ISO en UTC y el `<input type="datetime-local">` habla hora local sin zona. Ahí
un error **no truena: solo programa la OT a otra hora**. Por eso `isoToLocalInput` /
`localInputToIso` son puras, con el **offset explícito** (convención `getTimezoneOffset`), y el
glue calcula ese offset **para la fecha en cuestión** (no para "ahora") con una segunda pasada si
el valor cae del otro lado de un cambio de horario — así el DST lo resuelve el navegador y no una
constante nuestra. Tests: round-trip ISO→local→ISO en 4 husos, cruce de medianoche y basura.

### Ruta de regeneración — declarada, BLOQUEADA POR DATOS
Entidad `workOrderScheduleFix` (OT Centinela 11677, captura-y-aborta). El disparador se
**verificó en vivo** (2026-07-28): 📅 del header = `button` con
`svg[data-testid="CalendarMonthIcon"]` (`aria-label="View Schedule"`) → modal con un
**FullCalendar** (`.fc-*`) de las tareas de esa OT → clic en el evento → botón `Update`.

**Pero la OT Centinela no tiene ninguna tarea programada** (calendario vacío, verificado), así que
hoy el ciclo no puede disparar nada. El `load` lo detecta y devuelve `name:''` → el ciclo **no
corre**, en vez de clicar a ciegas en una pantalla de programación. Para habilitarlo basta
**programar la OT Centinela** en el tablero (una tarea, estación cualquiera, fecha lejana). Lo
único no verificado de la ruta es el DOM del formulario del evento; su botón se ancla por texto
EN+ES.

### Hallazgo lateral: la OT Centinela se llama «Sentinela»
El objeto real en Steelhead es **"Work Order Sentinela - 11677"** — errata (S inglesa +
terminación española); en español correcto es **«Centinela»**. El gate del autopilot
(`loadWorkOrderSentinel` → `/Centinela/i` sobre todo el `body`) **pasa por accidente**: lo salvan
otros tres links de la ficha que sí dicen "Centinela" con C (el PN y el cliente centinela), no el
nombre de la OT. Si esos links cambiaran, las **tres** rutas que cuelgan de esa OT
(`workOrderRoutes`, `partGroupCreate`, `partsSplitTransfer`) se apagarían fail-closed en silencio.
Renombrar la OT a «Centinela» cierra las dos cosas de un golpe.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/wo-schedule-core.js` | Motor puro **compartido** con `wo-listing-columns`: `isWorkOrderDetailPath`, `parseWorkOrderIdInDomain`, `parseDomainId`, `extractWorkOrderGlobalId`, `buildBoardScheduleIndex`, `resolveBoardScheduleForWO`, `scheduleStatusLabel`, `formatShortDateTime`. |
| `remote/scripts/wo-schedule-button.js` | Glue DOM: readout inline en el header, interceptor de `WorkOrderSchedule`, fetch de `WorkOrder` + fallback. |
| `tools/test/wo-schedule-core.test.js` | 18 golden tests. |

## Plan de validación

- **Core:** 18/18 golden ✓.
- **En vivo (operador):** ficha `/WorkOrders/<id>` → readout 📅 entre EDITAR DETALLES y ABRIR PDF con la programación real (o "Sin programar"). Confirmar que el interceptor evita el doble fetch (una sola `WorkOrderSchedule` en la red).


## Safari / iPad (bundle v0.6.0, 2026-07-27)

Integrado al bundle del iPad. El scanner (`tools/safari-bundle-scan.py`) lo clasificaba
**NO-APLICA** por detectar `a.download`, pero esa descarga es la **generación del PDF**: una
función **lateral y opt-in**, no el flujo core del applet. La regla correcta es *NO-APLICA solo
cuando el FLUJO CORE es la descarga* (auditor, carga-masiva, file-uploader…); si es una función
más, el applet sí va al bundle y en iOS simplemente esa función no opera.

Recordatorio: el bundle es **estático** (Apple 2.5.2 prohíbe código remoto) — editar
`remote/scripts` NO llega al iPad hasta correr `tools/build-safari.sh` y **recompilar en Xcode**.
