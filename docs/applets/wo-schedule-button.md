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


## Fase 2b — payload CAPTURADO y motor listo (2026-07-28)

El scan del 2026-07-28 20:19 **sí trajo el payload** de `CreateManyScheduleTasks`
(`count=2`, `vars=1`) — el fix del hash-scanner de ese día era lo que faltaba, no el ERP.
Fixture: [`tools/test/fixtures/wo-schedule-create-task.json`](../../tools/test/fixtures/wo-schedule-create-task.json).
`WoScheduleCore.buildScheduleTaskCreateInput` **reproduce ese payload byte a byte** (test golden).

### Lo que la evidencia corrigió respecto a lo que estaba escrito aquí
| Creencia previa | Realidad capturada |
|---|---|
| `rackTypeIdLineage` es un array | es un **STRING** (`"2701"`), y `rackIdLineage` venía **null** |
| `partSetUuid` "¿generado en cliente?" | **UUID v4 del cliente**, confirmado |
| los `times` "sin mapear" | `TreatmentTime.cycleTime` / **`totalTime`** (no `treatmentTime`), como **Interval de Postgres** |
| `recipeNodeId` sin fuente | lo trae `SchedulablePartLocations` directo |

### La fórmula de la duración (lo único que se calcula, no se copia)
```
lotes = ceil(partCount / partsPerBatch)
totalTimeMinutes = treatmentTimeMinutes + (lotes - 1) × cycleTimeMinutes
```
**Validada contra 4 tareas reales independientes:** 13504/1501→9 lotes→45+8×12=**141** (el CREATE
capturado); 9000/1686→6→50+5×50=**300**; 1/120→1→**66**; 12/49→1→**30**.

### `TreatmentTime` es un sistema de OVERRIDES
`possibleTreatmentTimesByRecipeNodeDefaultTreatment` es una **lista**: `partNumberId`,
`stationId`, `processNodeId` y `processNodeOccurrence` son nullable y **null = comodín**. Gana el
que matchea el contexto siendo **más específico**. Eso explica por qué el mismo `treatmentId`
en la misma estación aparece con tiempos distintos según la tarea — depende del PN. Un candidato
cuyo campo *difiere* del contexto se **descarta**, no se aproxima: programar con el tiempo de otra
estación desacomoda el piso. ⚠️ La muestra trae UN solo `TreatmentTime` (todo null), así que el
desempate está implementado pero **no observado**.

### Lo que falta para cablear la UI (y por qué no se cableó a ciegas)
Dos insumos no tienen todavía una consulta **ligera** que los dé desde la ficha:
1. **los tiempos** — hoy solo se han visto dentro de `RelatedSchedulingInformation`, que son
   ~87 MB (la bitácora del auto-router ya lo documenta como el query más pesado del board), y de
   `ScheduleInformationById(scheduleId)`, que los trae **ya resueltos por tarea existente**;
2. **`partsPerBatch`** — la hipótesis `partsPerRack × rackCount` cuadra con el único caso
   capturado (`rackCount=1` ⇒ 1501 = 1501), pero **un caso no distingue el producto de la
   identidad**.

Por eso el motor quedó listo y verificado, pero el 📅 de «Sin programar» **sigue sin escribir**:
teclear un tiempo a mano entra al planificador igual de mal que calcularlo mal. El camino
natural es `ScheduleInformationById` — copiar los tiempos de una tarea real del mismo
treatment+estación y **fail-closed si no existe ninguna**, en vez de inventarlos.


## Datos maestros faltantes: detectar el daño y corregirlo en la fuente (2026-07-28)

Planteado por el operador: los dos huecos reales del piso son **el tratamiento genérico de
Planificación sin tiempos** y **el tipo de rack sin piezas por carga**. El segundo es el
peligroso porque **no falla: calcula**. Sin `partsPerRack` el planificador asume **1 pieza por
carga**, así que 13 504 piezas se vuelven 13 504 cargas y la tarea pasa de **141 minutos a
~112 días** — una duración irreal que entra al programa con cara de dato bueno y desacomoda
todo lo que venga detrás.

**Un dato maestro faltante no se resuelve con un default silencioso.** `diagnoseSchedulingData`
lo nombra, **mide el efecto** (cargas y días concretos, no un "revisa la configuración") y dice
dónde se corrige. `SIN_TIEMPOS` y `SIN_PIEZAS_POR_RACK` **bloquean**; `DURACION_IMPLAUSIBLE`
(> 1 semana en una tina) solo advierte, porque puede ser legítimo.

### Corregirlo resultó barato: las tres escrituras ya existían

| Corrección | Mutación | Estado |
|---|---|---|
| Piezas por carga (alta) | `CreatePartNumberPerPerRackType` | payload real capturado `{partNumberId, partsPerRack, rackTypeId}` |
| Piezas por carga (corrección) | `UpdatePartNumberPerPerRackType` | **ya en config y en uso por `carga-masiva`** |
| Tiempos de tratamiento | `CreateTreatmentTimesWithExpectedStationCostsUI` | payload real capturado |

Las dos de rack **no son intercambiables**: `SavePartNumberRackTypes` es insert-only y dispara
unique constraint en `(pn, rackType)` — por eso existe la de update, y por eso
`planPartsPerRackFix` elige según el par exista o no. Los tiempos viajan como **Interval de
Postgres** (`{hours, minutes}`), no como minutos: `minutesToInterval` hace la conversión y
`buildTreatmentTimeCreateInput` **rechaza un ciclo mayor que el total** (tarea imposible) antes
de que llegue al ERP.

La lectura para detectar el faltante también estaba: `CreateEditPartsPerRackTypeQuery`
(`{partNumberId}` → `allRackTypes[].partsPerRackDefault`) y `CreateEditTreatmentTimesDialogQuery`
(ya usada por `process-deep-audit`).

**Rutas de regeneración:** `partNumberRackType` cuelga del **PN Centinela 3770957** — que es
justamente el PN de los payloads capturados, así que el flujo ya está confirmado sobre el
centinela. `treatmentTimes` no tiene objeto centinela (es un catálogo global), así que **su
único candado es el abort**; no cambiar de estrategia sin repensarlo. La deuda del trinquete
**bajó de 60 a 59**.


### Las piezas por carga son POR LÍNEA — al re-rutear hay que AGREGAR, no corregir

Precisión del operador, confirmada en datos reales (`SchedulablePartLocations`, scan
2026-07-07): el PN **3015610** tiene **4** piezas por carga en `T204-FL01` y **1** en
`T205-FL01`. Mismo número de parte, distinta línea, distinta carga — porque el dato vive en el
par **(PN, tipo de rack)** y cada línea usa el suyo.

**Consecuencia para el ruteo:** cuando una orden se manda a otra línea, el rack de la estación
destino puede **no estar ligado** al PN. Entonces el dato no está *mal*: **no existe**. Y el
arreglo no es corregir el que hay —que probablemente es correcto para SU línea— sino **agregar
el de la línea nueva**. Confundir los dos casos pisaría un dato bueno.

`resolveRackForStation(stationRackTypes, partNumberRackTypes)` resuelve el rack **de la estación
destino** y devuelve `yaExiste`, que es lo que elige la mutación:

| Caso | Acción | Mutación |
|---|---|---|
| El PN ya tiene ese rack | **CORREGIR** | `UpdatePartNumberPerPerRackType` |
| El PN no tiene ese rack (línea nueva) | **AGREGAR** | `CreatePartNumberPerPerRackType` |
| La estación no tiene rack configurado | ninguna — se reporta aparte (`ESTACION_SIN_RACK`) | — |

No son intercambiables: el alta es insert-only y revienta con unique constraint en
`(pn, rackType)`.

Además devuelve **`alternativas`**: las piezas que el PN sí tiene declaradas en otros racks. Eso
es lo que hace capturable el dato faltante con criterio — *"en T204-FL01 caben 4 y en T205-FL01
cabe 1; ¿cuántas en T114-FL01?"* — en vez de pedir un número al aire. Y si la estación ofrece
varios racks, `opcionesEstacion` los expone para que la UI deje elegir. Los racks **archivados**
nunca son candidatos.


## Fase 2b CABLEADA — crear la tarea y corregir el dato en el acto (2026-07-28)

**Decisión del operador:** captura **quien programa**, no ingeniería. *"Debería pasárselo a
ingeniería, pero como va a estar en piso, que lo verifique directamente."* Eso cambia el diseño:
la captura manual deja de ser un riesgo y pasa a ser **el mecanismo de verificación** — quien
teclea las piezas por carga tiene el rack enfrente.

El 📅 de «Sin programar» ahora abre el modal de creación: paso, fecha/hora, tipo de rack, piezas
por carga y los dos tiempos. **El efecto se recalcula y se muestra mientras tecleas**
(`13504 piezas → 9 cargas → 141 min`), que es lo que sustituye a una fuente automática de datos.
Al crear, se relee el programa y el readout del header se actualiza con lo que quedó de verdad.

### Guardar el dato maestro es un botón APARTE
No es efecto lateral de programar. El botón cambia de texto según el caso —**«Agregar piezas por
carga»** cuando el rack de la línea destino no está ligado al PN, **«Corregir»** cuando ya
existe— y pide confirmación que dice explícitamente que **aplica a todas las órdenes de ese PN en
ese rack, no solo a ésta**. Es la diferencia entre arreglar el dato y parchear la tarea: la
próxima vez que alguien programe ese PN en esa línea, el dato ya está.

### Qué queda sin validar en vivo
- **Ninguna corrida real de creación.** El payload se reproduce byte a byte contra el capturado y
  el motor tiene 80 tests, pero crear una tarea escribe en el planificador: primer uso sobre una
  orden de prueba.
- **`partsPerBatch = partsPerRack × rackCount`** sigue siendo hipótesis de un solo caso. En el
  modal el campo es editable y el resultado se ve antes de confirmar, así que un valor equivocado
  se nota en pantalla (cargas y horas) antes de escribir.
- El modal asume **rackCount = 1**; cuando la estación declare varios racks hay que leer
  `stationTreatmentRackTypes` de esa estación (hoy solo se ha visto dentro de
  `RelatedSchedulingInformation`, que son ~87 MB).


## Correcciones del primer uso en vivo (2026-07-28, v0.9.0)

Cuatro cosas del feedback con captura sobre la OT 16154. La primera no era un ajuste: era el
**modelo de dominio mal entendido**.

### 1. No se programa tina por tina — se programa por tratamiento ANCLA
La v1 ofrecía en un select **todas** las tinas de la receta (en la captura: *"T109 Recibo de
Orden · T109-EN00-001 Carga de Barril"*, que no es programable). El operador lo corrigió: solo
son programables los nodos cuyo tratamiento corre en una **estación con calendario de
planificación** — los *"Listo para procesar" / "Listo para niquelar"* y las **estaciones
satélite**. Y no se programa un paso: se programa **la orden completa** contemplando el o los
tratamientos ancla, porque **una misma orden puede correr en varias líneas**.

El marcador es el **grupo de tratamiento «Planificación» (2344)**, el mismo que el auto-ruteador
ya usa para las stations `-LI`. Confirmado con datos: en ese grupo caen `T110 (PLA)-CU-VARIOS`,
`T202 (PLA)-CU-VARIOS`, `T206 (EST)-BI-BIMETALES`; una tina normal como
`TR-PRM-001 Antitarnish Manual` cae en otro. **El árbol de la receta NO trae el grupo**, así que
se pide con `RelatedSchedulingTreatments({treatmentIds})` — una query chica.

El modal ya no tiene select de pasos: lista los **anclas encontrados con checkbox** (todos
marcados), y **crea una tarea por ancla**. Si la orden no tiene ninguno, lo dice y no deja seguir
en vez de ofrecer una tina cualquiera.

### 2. El rack default sigue a la LÍNEA, no al PN
Programando en **T109** el modal ofrecía **`T111-RA01`**. Causa: precargaba `pnRacks[0]`, o sea
*el primer rack que el PN tuviera ligado* — que puede ser de otra línea. `pickRackForLine` ahora
elige el rack cuyo nombre abre con el código de línea del ancla (`T109-RA01`), prefiriendo entre
los de esa línea el que ya tenga piezas declaradas. Al cambiar de ancla, el rack se reevalúa.

### 3. Contraste
Solo el `datetime-local` tenía estilo oscuro; los `select` e `input` salían con el blanco nativo
del navegador. Ahora **todos** los campos son oscuros (`#141a23` / `#dfe5ec`), con foco verde.

### 4. 🔀 antes del 📅
*"En ocasiones primero tengo que rutear a otra línea antes de programar."* El readout lleva ahora
un **🔀 delante del 📅** — ese es el orden real del trabajo. Abre el panel de pistas, cuya primera
fila es **«📋 Toda la orden»**, que es el equivalente a rutear la orden completa. Va una sola vez
por readout, no uno por tarea.

**Respuesta a la duda del operador** («no estoy seguro si por default va a tomar el modo orden
completa»): el panel de pistas **siempre** trae la pista global «Toda la orden» como primera fila,
y todas las pistas arrancan en «— pendiente —», así que nada se mueve hasta elegir una línea. No
hay riesgo de que rutee un grupo por accidente.
