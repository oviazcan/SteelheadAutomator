# wo-schedule-button — Botón "Programación" en la ficha de Orden de Trabajo

**Versión:** 0.2.0 — **Fase 1 (consulta) CONECTADA con `WorkOrderSchedule`, sin deploy**. Core compartido `wo-schedule-core` 18/18 golden.
**Categoría:** Órdenes de Trabajo · **autoInject:true** · ruta: `/Domains/<d>/WorkOrders/<idInDomain>` (ficha individual)

## Qué hace

En la ficha de una OT inyecta un **botón "📅 Programación"** en el header, **ENTRE "EDITAR DETALLES" y "ABRIR PDF"**, que abre un panel dark-mode con la programación de la OT (cuándo/dónde).

Pedido por producción (2026-07-23): en iPad la tarjeta "Cliente" (que contiene el ícono 📅 nativo) se **colapsa** y deja de verse de inmediato → un botón arriba da acceso inmediato e independiente de esa tarjeta.

## Anclaje (handle semántico estable — sin texto bilingüe)

El header expone `data-steelhead-component-id` estables (mejor ancla posible, idioma-agnóstica). "Abrir PDF" = `WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON`, y es el **primer** elemento del grupo derecho del header; "Editar Detalles" es el último del grupo izquierdo. → Insertar el botón **antes de** `WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON` lo deja exactamente entre ambos:

```js
const pdf = document.querySelector('[data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON"]');
pdf.parentElement.insertBefore(miBoton, pdf);
```

Montaje **idempotente** por `id` + `MutationObserver` (re-monta si React borra el nodo) + parche `pushState/replaceState/popstate` (re-evalúa al navegar entre fichas en la SPA). Verificado contra el HTML real del header (2026-07-23).

## UI (regla de diseño)

- **Botón:** integrado a la barra CLARA nativa, con **acento verde `#13a36f`** (fondo `#eef6f2`, texto `#0d6b49`) → se ve "de la extensión" sin romper la barra.
- **Panel:** **dark-mode** (`#1c2430`/`#e6e9ee`/`#13a36f`, patrón `auto-router-panel.js`) — overlay + cierre por click-fuera / `×` / Esc. `textContent` (no innerHTML de datos).

## Estado por fase

- **FASE 1 (consultar programación) — CONECTADA.** Al abrir el panel: (1) `WorkOrder({idInDomain})` (hash `fc41042e…`) → **workOrderId GLOBAL** (`wo.id`) + nombre + **Fecha Límite** (localizada `es-MX`); (2) `WorkOrderSchedule({domainId, workOrderId})` (hash `7b1b1127…`, capturado 2026-07-23) → **board completo** (todas las tareas del schedule del dominio) → `WoScheduleCore.buildBoardScheduleIndex` → `resolveBoardScheduleForWO(woGlobalId)` → render de tareas: **estación** (nombre embebido en `stationByStationId.name`) · **fecha/hora** local · **estado** (`scheduleStatusLabel`: QUEUED→"En cola", etc.). "Esta OT no está programada" si vacío. Robusto en iPad (no depende de la tarjeta Cliente ni del 📅 nativo).
  - **Nota de peso:** `WorkOrderSchedule` devuelve ~4.6MB (el board entero, no solo la OT — 767 tareas + allCustomers/allStations/allPartLocations). Es 1 llamada al abrir el panel (lo mismo que carga el modal nativo). El link WO→tarea es `element.recipeNodeByRecipeNodeId.workOrderId`.
- **FASE 2 (crear programación — hito aparte):** el panel ganaría modo "crear/editar" (estación + fecha/hora) que dispara la **mutación de creación** (sin capturar aún — terreno virgen). Alta en `hash-autopilot` (sentinela / captura-y-aborta).

## Captura — estado

- **Fase 1: RESUELTA.** `WorkOrderSchedule` capturado (scan 2026-07-23_144219), hash en config, ruta de regeneración en `route-catalog.json` (`workorders-detail` → se dispara al navegar a la ficha).
- **Fase 2: pendiente.** `hash-scanner` sobre una OT **sin programar** → abrir "Programar", agendar de prueba, guardar → capturar la mutación de creación.
- **Descartadas:** `RelatedSchedulingTreatments` (`b4ea3a2c…`) = solo metadata de tratamientos, no la programación; `RelatedSchedulingInformation`/`ScheduleInformationById`/`GetScheduleBoard` quedaron servidas de caché (sin body) — no necesarias, `WorkOrderSchedule` cubre el caso.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/wo-schedule-core.js` | Motor puro **compartido** con `wo-listing-columns`. Aquí usa: `isWorkOrderDetailPath`, `parseWorkOrderIdInDomain`, `parseIsoParts`, y (Fase 1) `buildScheduleIndex`/`resolveByAccountIds`/`stationNameMap`/`formatScheduleCell`. |
| `remote/scripts/wo-schedule-button.js` | Glue DOM: botón en el header, panel dark-mode, fetch de `WorkOrder`, (Fase 1) fetch del board. |
| `tools/test/wo-schedule-core.test.js` | 13 golden tests (índice de programación contra el shape real de `GetRelatedScheduleData`). |

## Plan de validación (pendiente)

- **Core:** 13/13 golden ✓.
- **En vivo (operador, foreground):** ficha `/WorkOrders/15194` → botón entre EDITAR DETALLES y ABRIR PDF → panel con nombre + Fecha Límite. Tras Fase 1: tarea agendada real.
- **Deploy:** `tools/deploy.sh "feat(wo-schedule-button): ..." --check wo-schedule-button`. No deployado aún (se entrega junto con la programación).
