# Diseño — Applet `wo-completer` ("Completar / Descompletar OTs")

**Fecha:** 2026-06-30
**Estado:** Aprobado (diseño). Pendiente implementación.
**Origen:** Necesidad de completar masivamente un listado (Excel) de órdenes de trabajo y
"revivir" (descompletar) algunas que ya fueron completadas.

## Contexto / reverse-engineering

Reconstruido desde `~/Downloads/scan_results_2026-06-30_210332.json` (el usuario capturó en vivo
una corrida de **completar** una OT y luego **descompletarla**). Modelo confirmado byte-a-byte contra
los payloads reales del scan.

### Completar una OT
Una OT se completa creando un *parts transfer* `type:"COMPLETE"` por cada **cuenta de piezas activa**
(`currentPartsTransferAccounts`) con `partCount > 0`. El destino de cada transfer es la misma
`receivedOrderPartTransformId` + `locationId` (ubicación actual) de la cuenta origen.

- **Lectura:** query `WorkOrder{idInDomain}` → `currentPartsTransferAccounts.nodes[]`, cada nodo trae:
  `id` (partsTransferAccountId), `partCount`, `partCountCompleted`, `scrapCount`, `partNumberId`,
  `receivedOrderPartTransformId`, `recipeNodeByRecipeNodeId` (name/type/recipeInd — solo para mostrar),
  `locationByLocationId.id`. La OT trae además `completedAt` (null = no completada).
- **Escritura:** mutación `AddPartsToWorkOrders(input)` (hash ya existe en config).

### Descompletar (revivir) una OT
Se revierte el/los transfer(s) `COMPLETE` con un transfer `type:"REVERT_COMPLETE"`.

- **Lectura:** query `GetWorkOrderPartsTransfers{idInDomain, includeReverts:true}` → filtrar
  `type==="COMPLETE"` que aún no tengan su REVERT correspondiente. De cada uno: `id`, `partCount`,
  `fromAccountId`, `at`.
- **Escritura:** mutación `CreateManyPartsTransfersChecked(payload)`.

### Hashes (persisted queries)
Ya presentes en `config.steelhead.hashes`: `AllWorkOrders` (query), `AddPartsToWorkOrders` (mutation).
**A agregar:**
- queries: `WorkOrder` = `14578a2f6b953fde230fc4f32bd7129992032ae31459019c93d64f9865ae0667`
- queries: `GetWorkOrderPartsTransfers` = `da4e8740973139bb23f3f0d37a0ea83a05b6d67cdab2c1bea1e154dff37aa284`
- mutations: `CreateManyPartsTransfersChecked` = `fc7438932552bb02202dfcecc4e0bf826fd5097db6e6559c3c7b99186ceff9ed`

## Decisiones de producto (confirmadas con el usuario)

1. **Entrada:** panel con **toggle de modo** (Completar / Descompletar). Se pega/sube la lista de
   números de OT y se corre el modo activo. (No un Excel con columna de acción, no dos archivos.)
2. **Alcance al completar:** completar **todas las cuentas activas tal cual** (todo lo que tenga en
   piezas), **sin validar el nodo**. El nodo actual igual se **muestra** en el preview para que el
   operador detecte a simple vista algo a medio proceso.
3. **Identificador:** el número del listado es el **`idInDomain`** de la OT (el # que ve el operador).
   Se resuelve directo con `WorkOrder{idInDomain}` — sin búsqueda por nombre.

## Arquitectura

Nuevo applet en `config.apps`, `category:"Órdenes de Trabajo"` (junto a `wo-deadline`/`wo-mover`),
`icon:"✅"`, **sin `autoInject`** — se abre desde el popup de la extensión (patrón `wo-deadline`).
Acción `handler:"message"` → `fn:"WOCompleter.open"`. `requiredPermissions:["READ_WORK_ORDER"]`.

### Módulos (nuevos, bajo `remote/scripts/`)

| Archivo | Rol | Depende de |
|---|---|---|
| `wo-completer-engine.js` | **Motor puro** (sin DOM/red). UMD: `module.exports` + `root.SteelheadWOCompleterEngine`. | — |
| `wo-completer.js` | Orquestador: API (`SteelheadAPI.query`), panel UI dark-mode, pool de concurrencia, progreso, cleanup. | `steelhead-api.js`, `host-cleanup-shared.js`, engine |

`scripts` del app: `["scripts/steelhead-api.js","scripts/host-cleanup-shared.js","scripts/wo-completer-engine.js","scripts/wo-completer.js"]`.

### Motor puro — API pública

```
parseWoList(text) -> number[]
  // Split por líneas/comas/tabs/espacios; toma enteros; dedup; ordena. Ignora vacíos y no-numéricos.

buildCompletePayload(workOrder) -> { input } | { skip:true, reason }
  // Itera workOrder.currentPartsTransferAccounts.nodes con partCount>0.
  // skip si completedAt != null  -> reason "ya completada"
  // skip si no hay cuentas con partCount>0 -> reason "sin piezas activas"
  // Cada cuenta -> partsTransfers[]:
  //   { fromAccountId: acc.id, partCount: acc.partCount,
  //     toAccount: { workOrderId:null, stationId:null, recipeNodeId:null,
  //                  receivedOrderPartTransformId: acc.receivedOrderPartTransformId,
  //                  locationId: acc.locationByLocationId.id },
  //     fromOperatorInput:{}, type:"COMPLETE",
  //     partsTransferIdCausingRework:null, partsTransferCategoryId:null, comment:null }
  // Envuelve en el input completo (arrays vacíos + billedLaborTimeSegments vacío).

pickRevertableCompletes(transfers) -> transfer[]
  // De GetWorkOrderPartsTransfers: type==="COMPLETE" cuyo id NO aparece como
  // revertsPartsTransferId de ningún transfer type==="REVERT_COMPLETE" en la lista.

buildRevertPayload(transfer) -> { payload }
  // { partCount: t.partCount, revertsPartsTransferId: t.id,
  //   toAccount:{ id: t.fromAccountId }, type:"REVERT_COMPLETE",
  //   at: new Date(t.at).toISOString() }   // NORMALIZA microsegundos+00:00 -> millis+Z
  // Envuelve en partsTransferEventsPayload.partsTransferEvents[0].partsTransfers[] + billedLaborTimeSegments:{}
```

**Lección de timestamp (crítica):** el `at` del revert debe ser el `at` del COMPLETE original pero
**normalizado**: `"2026-07-01T03:03:06.761946+00:00"` → `"2026-07-01T03:03:06.761Z"` vía
`new Date(at).toISOString()`. Verificado contra el scan.

### Flujo de ejecución

**Completar:** `parseWoList` → por OT (pool ~5): `WorkOrder{idInDomain}` (slim) →
`buildCompletePayload` → preview. Ejecutar = `AddPartsToWorkOrders(input)` por OT (skip los `skip:true`).

**Descompletar:** `parseWoList` → por OT: `GetWorkOrderPartsTransfers{idInDomain, includeReverts:true, first:100}`
→ `pickRevertableCompletes` → `buildRevertPayload` por transfer → preview. Ejecutar =
`CreateManyPartsTransfersChecked(payload)` por transfer.

Una llamada de escritura por OT/transfer (no hay batch multi-OT nativo). Pool de concurrencia moderado
(~5) para no saturar / rate-limit.

### UI (panel dark-mode — regla de diseño del repo)

Base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento `#13a36f` (para distinguir de las pantallas
CLARAS de SH). Toggle Completar/Descompletar; textarea (pegar columna de Excel; dedup); **Validar**
(dry-run, no escribe) → tabla de preview `#OT · encontrada? · completada? · #cuentas · piezas · nodo(s) ·
acción`; **Ejecutar** (habilitado solo tras Validar) → confirm con conteos → progreso + OK/ERROR por OT +
log copiable.

### Guardrails

- **Dry-run obligatorio** antes de Ejecutar; confirm "Vas a COMPLETAR N OTs (X cuentas, Y piezas)".
- **Idempotencia:** completar hace skip si `completedAt` o sin cuentas; descompletar hace skip si no hay
  COMPLETE vivo (evita doble acción).
- **Sin validación de nodo** (decisión del usuario) pero el nodo se muestra en el preview.
- **Memory hardening** (skill `memory-hardening-applets`): slim responses, `clear()` de Maps en
  `closePanel`, `host-cleanup-shared` (Datadog stop + Apollo drain). El panel queda abierto y corre un
  pool → aplica el eje host + eje propio.

## Tests

`tools/test/wo-completer-engine.test.js` (`node --test`). **Golden** contra los payloads reales del scan:

- `buildCompletePayload` a partir de una cuenta `{id:40404463, partCount:136000,
  receivedOrderPartTransformId:2405324, locationByLocationId:{id:24907}}` (OT completada 5436) debe
  reproducir **exactamente** el `AddPartsToWorkOrders.input` capturado.
- `buildRevertPayload` a partir del transfer `{id:47311391, partCount:136000, fromAccountId:40404463,
  at:"2026-07-01T03:03:06.761946+00:00"}` debe reproducir **exactamente** el
  `CreateManyPartsTransfersChecked` capturado (incluida la normalización del `at` a `…761Z`).
- `parseWoList`: comas/tabs/saltos, dedup, no-numéricos ignorados.
- `pickRevertableCompletes`: un COMPLETE ya revertido no se re-lista.
- Skips: `buildCompletePayload` de OT ya completada / sin cuentas.

## Deploy

- Scripts nuevos → `SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh <script> "msg"` (un script por corrida).
- **Los hashes/config NO los cubre wb-deploy** → `config.json` (app nueva + 3 hashes) se hace en el
  worktree de `main` con `tools/deploy.sh`, coordinando que no haya WIP ajeno en `main`.
- Bitácora nueva `docs/applets/wo-completer.md` + fila en el índice de `CLAUDE.md`.
- Validación en vivo con el usuario: **dry-run primero**, luego una OT de prueba, luego el listado.

## Fuera de alcance (YAGNI)

- Sin columna de acción por fila ni carga de archivo (solo pegar + toggle).
- Sin validación/gating por nodo.
- Sin batch multi-OT (no existe en la API; una llamada por OT).
- Sin edición de piezas parciales por cuenta (se completa el `partCount` remanente tal cual).
