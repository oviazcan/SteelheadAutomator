# Applet `surtido-guard` — Candado de Surtido Programado

> Versión: **0.1.0** (config 1.7.24). Estado: **deployado, pendiente validación en vivo (bloqueo real)**.
> Spec: [`docs/superpowers/specs/2026-06-26-surtido-guard-design.md`](../superpowers/specs/2026-06-26-surtido-guard-design.md) ·
> Plan: [`docs/superpowers/plans/2026-06-26-surtido-guard.md`](../superpowers/plans/2026-06-26-surtido-guard.md)

## Qué resuelve
En el Workboard **"Preparación de Surtido"** (`/Domains/<id>/Workboards/<n>`), step
**"Preparando Surtido en Almacén"**, evita que el operador mueva piezas al siguiente proceso si la
**orden de trabajo no está programada** en producción, y marca en **verde** las tarjetas que sí lo están.

**Programada = la pieza tiene una tarea en el programa** (la tarjeta muestra la sección
"Tareas Programadas:" con tratamiento + estación + fecha-hora). El color del calendario rojo/verde es
la **fecha de entrega** (deadline), NO la señal de programación.

## Arquitectura (5 capas)
Glue en `surtido-guard.js`; lógica pura + parsers en `surtido-guard-core.js` (golden tests).
El corazón es un **interceptor de `window.fetch`** (patrón `auto-router.js`) que cubre las dos rutas
de movimiento con un solo punto de enforcement:

1. **Mapa de programadas** — lee la respuesta de `GetRelatedScheduleData` → `Set<partsTransferAccountId>` programados.
2. **Enforcement** — intercepta el **request** de `CreateManyPartsTransfersChecked`; si un transfer `type:"STEP"`
   sale de un nodo de surtido con account **no** programado → no lo reenvía, responde error GraphQL sintético
   (`{errors:[{message}]}`) + toast. **Cubre el modal MOVER y el drag silencioso** (ambos disparan esa mutación).
3. **Capa de modal** — agrisa los botones **Mover** / **Imprimir y Mover** (match por texto) + mensaje inline.
4. **Marcado verde** — tarjetas con "Tareas Programadas:" reciben acento verde (señal DOM directa).
5. **Toggle** — en el popup (`toggle-surtido-guard` → `SurtidoGuard.toggleFromPopup`), no persistente,
   **default ON cada carga**; se reactiva al recargar. El verde no se ve afectado por el toggle.

**Política FAIL-SAFE:** ante dato faltante (account sin puente, set no cargado) **no bloquea**.

## Shapes confirmados (Fase 0, tráfico real 2026-06-26/29)
| Operación | Tipo | Rol |
|---|---|---|
| `CreateManyPartsTransfersChecked` | mutación | **El move.** `partsTransferEventsPayload.partsTransferEvents[].partsTransfers[].{fromAccountId, type:"STEP", toAccount:{recipeNodeId}}`. NO trae workOrderId. |
| `WorkOrderMovePartsData` | query (modal) | `{workOrderId, fromRecipeNodeId, partsTransferAccountIds:[...]}` → puente account→{nodo,WO}. |
| `MoveMultipleFromWorkboardData` | query (drag) | `{workOrderIds:[...], fromRecipeNodeIds:[...], partsTransferAccountIds:[...]}` pareados por índice. |
| `GetRelatedScheduleData` | query (board) | `allSchedules.nodes[].validScheduleTasks.nodes[].scheduleTaskElementsByScheduleTaskId.nodes[].associatedPartsTransferAccounts.nodes[].{id, workOrderId}` → set de programados. |
| `GetRelatedWorkboardData` | query (board) | `allRecipeNodes.nodes[].{id, name}` → nodo "Preparando Surtido en Almacén" (match normalizado por inclusión). |

**Cruce:** `fromAccountId` de la mutación ↔ `id` de `associatedPartsTransferAccounts` (programado). Scope:
el `fromRecipeNodeId` del move (de las vars del query) debe ser un nodo cuyo nombre incluye
"preparando surtido en almacen".

> `CreateInventoryTransferEventGroups` (ya en config) **NO** es el move (es "carga inicial de lotes",
> usedBy `inventory-reset`).

## Componentes
- `remote/scripts/surtido-guard-core.js` — puro: `buildScheduledAccountSet`, `buildSurtidoNodeSet`,
  `indexAccountNodeFromMoveVars`, `extractStepTransfers`, `shouldBlockMove`, `evaluateMove`.
  Tests: `tools/test/surtido-guard-core.test.js` (13/13) + fixtures `tools/test/fixtures/surtido-guard-*.json`.
- `remote/scripts/surtido-guard.js` — glue: interceptor, capa modal, marcado verde, toggle, memory hardening.
- `remote/config.json` — app `surtido-guard` (`autoInject`, scripts, toggle action).

## Plan de validación en vivo (pendiente)
1. **Mapa**: en el board, `window.SurtidoGuard._getState()` debe mostrar `scheduled`>0 y `surtido` con el/los recipeNodeId.
2. **Bloqueo modal**: abrir ⇄ de una WO **no programada** + MOVER → no se mueve, toast rojo, botones grises.
   Una WO **programada** → se mueve normal (cuidar falsos positivos).
3. **Bloqueo drag**: arrastrar una no programada → bloqueado igual.
4. **Toggle**: apagar desde el popup → permite mover; recargar → vuelve a ON.
5. **Verde**: tarjetas con "Tareas Programadas:" en verde; afinar el selector de contenedor con el HTML real.

## Pendientes
- **Validación en vivo del bloqueo real** (arriba). Riesgo a vigilar: **falsos positivos** (bloquear una
  programada) → el operador apaga el toggle y se reporta.
- **HTML fino de la tarjeta**: el marcado verde usa heurística (sube desde "Tareas Programadas:" hasta un
  ancestro con "Proceso:" + "WO:"); capturar el `outerHTML` de una tarjeta del step para un selector exacto
  y, si se quiere, el 🔒 en no programadas.
- **Confirmar** que el drag silencioso efectivamente commitea por `CreateManyPartsTransfersChecked` (lo más
  probable; validar en vivo).
