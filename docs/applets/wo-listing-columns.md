# wo-listing-columns — Columnas en el listado de Órdenes de Trabajo

**Versión:** 0.2.0 — **columnas PN + Programación conectadas, sin deploy**. Core compartido `wo-schedule-core` 18/18 golden.
**Categoría:** Órdenes de Trabajo · **autoInject:true** · ruta: `/Domains/<d>/WorkOrders` (index, NO la ficha `/WorkOrders/:id`)

## Qué hace

En el listado `https://app.gosteelhead.com/Domains/<d>/WorkOrders`, agrega **dos columnas opt-in** (dos toggles en una barra dark-mode antes de la tabla; también en el popup):

- **🔩 "Número de Parte"** — cada PN como **link** a su ficha (`/PartNumbers/<id>`, pestaña nueva). Soporta **N PNs** concatenados (hoy 1 por OT).
- **📅 "Programación"** — **estación · fecha/hora local · estado** de la tarea agendada de la OT.

Pedido por producción (2026-07-23): ver el PN directo en el listado (con link a su ficha "como cuando entras a la ficha individual") y la programación de cada OT.

## Decisión de diseño (por qué un 2º query)

`AllWorkOrders` (el query del listado) trae `partNumberWorkOrdersByWorkOrderId.nodes[].partNumberId` (el **id**) pero **NO el nombre del PN** (verificado en el scan real 2026-07-23 + `wo-deadline-changer.js`, que también resuelve el nombre aparte). Por eso se hace un 2º query **ligero** por OT:

- **`PartNumbersByWorkOrderIdInDomain`** (hash `fda9e55c9e2341c17b6974c66407ac8b4306cab86a1c82ffe00c30133bb784d3`, ya en `config.json`), vars `{idInDomain}` → `workOrderByIdInDomain.partLocationsByWorkOrderId.nodes[].partNumberByPartNumberId.{id,name}`. Real: OT 15194 → `{id:3781602, name:"SGE11074C7"}`. Mucho más ligero que `GetPartNumber` (504 campos).
- El `idInDomain` sale del **link de la fila** (`td a[href*="/WorkOrders/<idInDomain>"]`), sin depender de `AllWorkOrders`.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/wo-schedule-core.js` | Motor puro **compartido** con `wo-schedule-button`. Aquí usa: `isWorkOrdersIndexPath`, `parseWorkOrderIdInDomain`, `extractPartNumbers`, `pnLink`. (También trae el índice de programación para la fase siguiente.) |
| `remote/scripts/wo-listing-columns.js` | Glue DOM: toggle persistente, columna en la MUI table, MutationObserver, pool de `PartNumbersByWorkOrderIdInDomain`, memory-hardening. |
| `tools/test/wo-schedule-core.test.js` | 13 golden tests (incluye PN múltiples/dedup/sin nombre + fail-safe). |

- **Toggle persistente:** `localStorage['sa_wo_pn_col_enabled']` (`'1'`/`'0'`, default OFF). Barra dark-mode insertada antes de la tabla + handler de popup `WoListingColumns.toggleFromPopup`.
- **Columna (lección pn-specs):** `<th>`/`<td>` **siempre última celda** (`appendChild`), re-posicionada en cada sync → sobrevive el re-render de React (paginar/ordenar/filtrar) sin desalinearse. Hereda la `className` MUI de una celda nativa. `data-sa-woid` para idempotencia.
- **Render seguro:** `textContent` + `href` (no `innerHTML` de datos → sin XSS con nombres de PN).

## Memory hardening (skill `memory-hardening-applets`)

Importa `host-cleanup-shared.js`. El toggle ON dispara ~1 query por OT visible (~20/página) y se re-dispara al paginar.

- **EJE A (propia):** cache **slim** `idInDomain → [{id,name}]` (`window.__saWoPnCache`); se limpia al salir del index; teardown de columna/observer/pool al desactivar.
- **EJE B (host):** `stopDatadogSessionReplay()` al primer fetch; `createMemMonitor` guardrail @88% → vacía la cola + toast; `makePeriodicDrain(25)`; pool `MAX_CONC=4` + `MIN_GAP_MS=130` (~7 req/s) + retry `[0,800,2500]` solo en transitorios.

## Columna "Programación" (cómo se resuelve)

Fuente: **`WorkOrderSchedule({domainId, workOrderId})`** (hash `7b1b1127…`, capturado 2026-07-23). Aunque se llama por WO, devuelve el **board COMPLETO** (todas las tareas del schedule del dominio, 767 en el board 454) → **UNA sola llamada por página** indexa a todas las filas (no por-fila).

- El `workOrderId` GLOBAL de cada fila sale del mismo fetch de PN (`PartNumbersByWorkOrderIdInDomain` → `workOrderByIdInDomain.id`, vía `extractWorkOrderGlobalId`). Por eso la columna de Programación **comparte** el fetch por-fila con la de PN.
- Al tener el primer `woGlobalId`, se dispara **una** `WorkOrderSchedule` → `WoScheduleCore.buildBoardScheduleIndex` (índice slim `workOrderId→tareas`, con `stationByStationId.name` embebido) → se **descarta el raw (~4.6MB)** y se guarda solo el índice → `fillAllSchedCells()` llena todas las filas. El link WO→tarea es `element.recipeNodeByRecipeNodeId.workOrderId`.
- Render por fila: estación · fecha/hora local (`es-MX`) · estado (`scheduleStatusLabel`). "no programada" si vacío. `(+N)` si hay varias tareas.
- **Peso:** `WorkOrderSchedule` ~4.6MB, pero **1 llamada por página** (opt-in, memory-hardening: se descarta el raw + Apollo drain + guardrail @88%). El índice se libera al salir del listado.

## Plan de validación (pendiente)

- **Core:** 13/13 golden ✓.
- **En vivo (operador, foreground):** `/WorkOrders` → toggle 🔩 → columna PN con links correctos (OT 15194 → `SGE11074C7` → `/PartNumbers/3781602`) + paginación (observer re-inyecta, columna siempre última) + contador `done/total`.
- **Deploy:** `tools/deploy.sh "feat(wo-listing-columns): ..." --check wo-listing-columns` (default OFF → deploy seguro). No deployado aún (se entrega junto con la programación, decisión "todo junto tras captura").

## Hashes / rutas de regeneración

- `PartNumbersByWorkOrderIdInDomain` y `AllStations`: **ya en config**, sin hash nuevo introducido por la columna PN. Ruta de captura: navegar a la ficha `/Domains/<d>/WorkOrders/<id>` (dispara `PartNumbersByWorkOrderIdInDomain`) — verificar/registrar en `route-catalog.json`.
- **Deuda lateral detectada:** `AllWorkOrders` **rotó** — hash vivo `4a1ce04a1e6e94e73c50449834a1307a5847be18a30fddd1fd6ecaee26104240` vs el `aaeb9dc0…` de config. Afecta `wo-deadline-changer`/`archiver`. Correr `steelhead-hash-validator`.
