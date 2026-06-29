# Applet `surtido-guard` — Candado de Surtido Programado

> Versión: **0.1.1** (config 1.7.25). Estado: **toggle VALIDADO en vivo (2026-06-29) ✓; el bloqueo aparece en vivo. Pendiente: validación fina del bloqueo (falsos positivos prog/no-prog), drag silencioso y marcado verde**.
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
4. **Toggle**: apagar desde el popup → permite mover; recargar → vuelve a ON. ✅ **VALIDADO en vivo 2026-06-29** (fix v0.1.1: estado en `window` singleton).
5. **Verde**: tarjetas con "Tareas Programadas:" en verde; afinar el selector de contenedor con el HTML real.

## Portar a iPad (Safari Web Extension)
Decidido portar como **Safari Web Extension** (no PWA) — análisis en
[`docs/architecture/ipad-surtido-guard-decision.md`](../architecture/ipad-surtido-guard-decision.md).
POC en `safari/` (source + plan B + README de Xcode). Riesgo a vigilar: el mapa de programadas
(`buildScheduledAccountSet`) tiene **fail-safe silencioso** ante cambios de schema de `GetRelatedScheduleData`
→ pendiente telemetría cuando el set sale vacío.

## Lecciones

### El estado mutable del applet NO puede vivir en el closure del IIFE (bug del toggle, 2026-06-29)
**Síntoma:** el operador apaga el candado desde el popup → toast "DESACTIVADO" aparece → pero **sigue
bloqueando**; al recargar vuelve a ON.

**Causa raíz:** `background.js` → `injectAppScripts` **re-evalúa los scripts del app en CADA acción del
popup**. El dedup que evita re-evaluar (`if (window[globalName].__saVersion === version) return`) solo aplica
a los scripts listados en el mapa `globals` de `background.js` — **`surtido-guard.js` no está en ese mapa**,
así que cada toggle corre `new Function(código)()` y crea una **instancia nueva** del IIFE. El interceptor de
`window.fetch` está latcheado a la instancia ORIGINAL (`__saSurtidoGuardFetchPatched`) y lee el
`enforcementEnabled` de **su** closure; el toggle mutaba el `enforcementEnabled` de la instancia NUEVA. Toast
sí (la nueva instancia lo dispara), enforcement no (el interceptor lee el flag viejo).

**Fix:** el flag de estado vive en `window.__saSurtidoGuardEnabled` (singleton compartido por todas las
instancias), igual que los latches `__saSurtidoGuard*` que el applet ya usaba para interceptor/observer/init.
Default ON solo en la **primera** carga (`if (window.__saSurtidoGuardEnabled === undefined) … = true`): una
re-inyección NO repisa lo que el operador apagó, y un reload limpia `window` → vuelve a ON (no persistente, por
diseño). Test de regresión: `tools/test/surtido-guard-toggle.test.js` (replica `new Function()` como la
extensión; RED sin fix, GREEN con fix).

**Regla general:** cualquier applet re-inyectable que NO esté en el mapa `globals` de `background.js` debe
guardar su estado mutable en `window.__sa<App>*`, no en variables del closure — o el popup mutará una instancia
distinta a la que tiene los interceptores latcheados.

## Pendientes
- **Validación en vivo del bloqueo real** (arriba). Riesgo a vigilar: **falsos positivos** (bloquear una
  programada) → el operador apaga el toggle y se reporta.
- **HTML fino de la tarjeta**: el marcado verde usa heurística (sube desde "Tareas Programadas:" hasta un
  ancestro con "Proceso:" + "WO:"); capturar el `outerHTML` de una tarjeta del step para un selector exacto
  y, si se quiere, el 🔒 en no programadas.
- **Confirmar** que el drag silencioso efectivamente commitea por `CreateManyPartsTransfersChecked` (lo más
  probable; validar en vivo).
