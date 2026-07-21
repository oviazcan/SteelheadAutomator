# Bitácora — `wo-completer` (Completar / Descompletar OTs)

**Versión actual:** 0.1.0 (el applet no tiene constante `VERSION` interna; el estado de deploy se referencia por versión de `config.json`). **Deployado** en config `1.7.38` el 2026-06-30 — app + 3 hashes + 2 scripts en vivo y verificados. **Fix posterior en config `1.7.39`** (2026-06-30, deploy `139b450`, commit feature `e0a83c5`): **pendiente run real**
**Categoría:** Órdenes de Trabajo · **Popup** (`fn: WOCompleter.open`, sin `autoInject`)
**Diseño:** [`docs/superpowers/specs/2026-06-30-wo-completer-design.md`](../superpowers/specs/2026-06-30-wo-completer-design.md)

## Qué hace
Panel dark-mode que toma un **listado pegado de números de OT** (`idInDomain`) y, según el modo:
- **Completar** → cierra la OT creando un *parts transfer* `type:"COMPLETE"` por cada cuenta activa.
- **Descompletar** (revivir) → revierte el/los `COMPLETE` con `type:"REVERT_COMPLETE"`.

Flujo: **Validar** (dry-run, no escribe) → tabla de preview → **Ejecutar** (confirm + progreso).

## Modelo (reverse-engineering del scan real)
Reconstruido de `~/Downloads/scan_results_2026-06-30_210332.json` (corrida en vivo del usuario
completando y luego descompletando una OT). Confirmado byte-a-byte por los golden tests.

### Completar
- **Lee:** `WorkOrder{idInDomain}` → `data.workOrderByIdInDomain`:
  `completedAt`, `currentPartsTransferAccounts.nodes[]` con `id`, `partCount`,
  `receivedOrderPartTransformId`, `locationByLocationId.id`, `recipeNodeByRecipeNodeId.{name,type}`.
- **Escribe:** `AddPartsToWorkOrders(input)` — un evento con un `partsTransfer` por cuenta:
  `{fromAccountId, partCount, toAccount:{receivedOrderPartTransformId, locationId, workOrderId:null,
  stationId:null, recipeNodeId:null}, type:"COMPLETE", fromOperatorInput:{}, partsTransferIdCausingRework:null,
  partsTransferCategoryId:null, comment:null}`.

### Descompletar
- **Lee:** `GetWorkOrderPartsTransfers{idInDomain, includeReverts:true, orderBy:["AT_DESC"], first:200}` →
  `data.workOrderByIdInDomain.workOrderPartsTransfers.nodes[]`. Cada nodo trae `id`, `type`, `partCount`,
  `fromAccountId`, `at`, `revertsPartsTransferId`, `partsTransfersByRevertsPartsTransferId.nodes`.
- **Filtra** COMPLETE aún no revertidos (por sub-conexión de reverts **o** por REVERT_COMPLETE que lo apunte).
- **Escribe:** `CreateManyPartsTransfersChecked(payload)` — `{partCount, revertsPartsTransferId,
  toAccount:{id:fromAccountId}, type:"REVERT_COMPLETE", at:<at del COMPLETE normalizado>}`.

## Lecciones
- **Timestamp del revert (crítico):** el `at` debe ser el `at` del COMPLETE original **normalizado** a
  millis+Z. El ERP devuelve el transfer con microsegundos+offset (`…761946+00:00`) pero la mutación
  espera `…761Z` → `new Date(t.at).toISOString()`. Verificado contra el scan (golden test).
- **`WorkOrder{idInDomain}` trae todo** lo necesario para completar (cuenta+ROPT+location+nodo+`completedAt`):
  no hace falta `MovePartsDialogPartLocation` ni `AllWorkOrders` por separado.
- **`locationId` al completar** = la ubicación **actual** de la cuenta origen (misma `receivedOrderPartTransformId`).
- **Decisión de producto:** se completa **todo lo que la OT tenga en piezas, sin validar el nodo** (el nodo
  igual se muestra en el preview para detectar a simple vista algo a medio proceso).
- **Idempotencia:** completar hace skip si `completedAt`/sin cuentas; descompletar hace skip si no hay COMPLETE vivo.
- **Fix `open()` sin valor de retorno (config `1.7.39`, 2026-06-30):** el handler genérico de `background.js` que invoca `fn: WOCompleter.open` toma el valor de retorno del `fn` como resultado; si es `undefined` lo trata como `{error:'Sin resultado'}` y el popup lanzaba un `alert` espurio aunque el panel sí abría bien. Fix: `open()` ahora retorna `{ok:true}` (o `{ok:true, alreadyOpen:true}` si el panel ya estaba abierto). Deploy `139b450`, commit feature `e0a83c5`.

## Hashes (agregados a `config.steelhead.hashes`)
- queries: `WorkOrder`, `GetWorkOrderPartsTransfers`
- mutations: `CreateManyPartsTransfersChecked`
- Ya existían: `AllWorkOrders`, `AddPartsToWorkOrders`.

## Memory hardening (skill `memory-hardening-applets`)
Aplica (panel persistente + `runPool` + potencialmente cientos de OTs).
- **EJE A:** slim responses (`fetchWorkOrderSlim`/`fetchTransfersSlim` mapean solo los fields usados);
  `state.rows=[]` en `closePanel`.
- **EJE B:** `host-cleanup-shared` importado; `stopDatadogSessionReplay()` al iniciar validar/ejecutar;
  `createMemMonitor({getElement:#woc-mem, onGuardrail})` start/stop en open/closePanel;
  `makePeriodicDrain(25)` en los pools.

## Tests
`tools/test/wo-completer-engine.test.js` — 10/10. Golden byte-a-byte de `AddPartsToWorkOrders` (COMPLETE)
y `CreateManyPartsTransfersChecked` (REVERT_COMPLETE) del scan real, + `parseWoList`,
`pickRevertableCompletes`, skips.

## Pendientes
- [x] **Deploy:** hecho vía `deploy.sh` desde main (config+hashes+2 scripts) → **config `1.7.38` en vivo** (2026-06-30). Nota: el deploy tocaba `config.json` con hashes nuevos, por eso fue `deploy.sh` sobre main (no `wb-deploy.sh`), aplicando las 3 líneas + la app sobre el `1.7.37` actual de main (edición quirúrgica, sin reformatear ni tirar claves duplicadas del original).
- [ ] **Run real:** dry-run primero, luego una OT de prueba (completar + descompletar), luego el listado.
- [ ] Confirmar en vivo que un COMPLETE con partes en **múltiples cuentas** se cierra en un solo evento (asunción).
- [ ] (Opcional) barra de progreso visual y log copiable enriquecido; cancelar en vuelo.
