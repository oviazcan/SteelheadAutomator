# Applet `wo-mover` — Mover OTs entre OVs

## Qué es
Estando parado en el detalle de una OV (`/Domains/{d}/ReceivedOrders/{idInDomain}`), detecta sus órdenes de trabajo (OTs), busca otras OVs del mismo cliente, propone destino (priorizando las que ya tienen el mismo PN) y **reasigna el encabezado** de las OTs seleccionadas a la OV destino, en lote desde una tabla.

- FAB `↔️` (autoInject) visible solo en el detalle de una OV.
- Toggle "Solo OVs con el mismo PN" (default ON) / todas las del cliente.
- Destino: OV existente o **crear OV nueva** (reusa `OVOperations.showCreationWizard`).

## Versión actual
**0.2.0** — **publicado en producción 2026-06-01** (gh-pages, cache-bust con ext config `1.6.27`). Alcance: **solo reasigna el encabezado de la OT**.

## Mecanismo y el hallazgo clave (scan 2026-06-01)
"Mover una OT a otra OV editando el encabezado" = mutación **`CreateUpdateWorkOrdersChecked`** con el `id` de la WO **poblado** + `receivedOrderId` nuevo. Los campos del encabezado se traen con **`WorkOrderDialogQuery`** (`{workOrderId, receivedOrderId:-1, domainId}`) → `workOrderById` (name, customerByCustomerId.id, deadline, productByProductId.id, startedAt, type, blockPartialShipments, labelIds). La respuesta `createUpdateWorkOrdersChecked: []` = sin warnings = OK.

**Limitación de modelo (validada con datos):** editar el encabezado mueve la **WorkOrder** (ejecución) a la OV destino, pero el **`ReceivedOrderPartTransform`** (la demanda/línea) **se queda en la OV origen**. Evidencia del scan (cuenta `40096616`, PN `S20A5467A2`): `workOrderByWorkOrderId.receivedOrder` → OV #700 (destino), `receivedOrderPartTransform.receivedOrder` → OV #671 (origen). La parte queda huérfana.

**`partAccountsNotAssignedToReceivedOrder`** del nuevo `GetReceivedOrder` lista justo esas partes huérfanas en la OV destino.

### Por qué v0.2 no asocia automáticamente
La asociación ("Asociar partes" / "Add Parts" en la UI) **no se pudo capturar como mutación**: en 3 scans (13:07, 15:28×2) el operador abrió los modales pero **ningún guardado disparó una mutación** — la UI no permite ejecutar la re-asociación en ese estado (`GetPartsTransferAccountAssociationData`, `AddReceivedPartsQuery`, `CreateReceivedOrderPartTransformQuery` son todas **queries** de diálogo). Decisión del usuario (2026-06-01): el applet **solo mueve el encabezado** y la asociación de la parte se hace **manualmente** en Steelhead. El applet lo advierte en el footer y en el `confirm()` previo a ejecutar.

## Hashes (descubiertos/validados en el scan 2026-06-01)
| Operación | Hash | Nota |
|---|---|---|
| `GetReceivedOrder` | `4fa89e55…17a7f2bc` | **rotado**; el nuevo trae workOrders + partTransforms (con `currentPartsTransferAccounts`) + `partAccountsNotAssignedToReceivedOrder` en una pasada → loadOVDetails ya no usa Pass 2 |
| `ActiveReceivedOrders` | `495ddfd6…47914890` | **rotado + nuevas variables** (`includeArchived`/`receivedOrderStatusFilter`/`searchQuery`, sin `domainId`). Root `pagedData` |
| `WorkOrderDialogQuery` | `4d745ead…11958829` | nuevo registro |
| `GetPartsTransferAccountAssociationData` | `396607b6…d4fc86686` | nuevo (query del modal "Asociar partes") |
| `CreateUpdateWorkOrdersChecked` | `7a4bdb13…` | sin cambio (update con id poblado acepta `receivedOrderId`) |

## Memory hardening (EJE A + B aplicados)
- Slim: candidatas guardan solo `{id, idInDomain, name, pnSet}`.
- Cap de 100 candidatas con aviso si hay más.
- `makePeriodicDrain(10)` en `loadCandidateOVs`; `stopDatadogSessionReplay()` + `createMemMonitor` con guardrail @88% al abrir; reset total de `state` en `closePanel`.

## Plan de validación pendiente
1. En una OV de prueba: seleccionar 1 OT → OV existente; ejecutar; verificar en Steelhead que la WO aparece en la OV destino (y recordar asociar la parte a mano).
2. Probar destino "Crear OV nueva" (wizard de OVOperations) y mover una OT ahí.
3. Probar lote 3-5 OTs → distintos destinos; revisar estados ok/error de la tabla.
4. Memoria: abrir/cerrar panel ~5 veces con cliente de 50+ OVs.

## Pendientes / futuro
- **Asociación de partes por API**: si en algún momento se captura la mutación real (en el contexto correcto donde la UI sí la dispara), agregar `associatePartsToDestLine` + reconciliación de la línea origen y quitar el paso manual.
- **v2**: cantidad parcial (partir la OT) reusando `AddPartsToWorkOrders` del `po-reconciler`.

## Estado de cierre (sesión 2026-06-01)

### Hecho y en producción
- [x] `wo-mover` 0.2.0 publicado en gh-pages (config 1.6.27). Recargar extensión para tomarlo.
- [x] Hashes rotados reparados: `GetReceivedOrder`, `ActiveReceivedOrders`, `AllLabels`, `GetDomain` (+ ~20 más reparados por la sesión paralela en la rotación masiva del 2026-06-01). `po-reconciler.js` y `ov-operations.js` migrados al nuevo shape de `ActiveReceivedOrders`.
- [x] Validador diario de hashes corrido (155 ok / 1 stale = `GetDomain`, ya reparado). Bitácora en `docs/api/hash-validation-log.md`.

### Pendiente del lado del usuario (acción manual)
- [ ] **Probar `wo-mover` end-to-end** en una OV no productiva (no se pudo probar en sesión: requiere navegador + sesión Steelhead). Ver "Plan de validación pendiente" arriba.
- [ ] **Asociar la parte a mano** en Steelhead tras cada movimiento (mientras no exista la mutación por API).
- [ ] Opcional: **re-agendar el cron de validación diaria de hashes** — sin corridas desde 2026-05-28; el `steelhead-hash-validator` se auto-expira a 7 días (renovar cada lunes).

### Mejora técnica detectada (no bloqueante)
- `po-reconciler.js` aún usa Pass 2 (`GetAddPartsReceivedOrder`); el nuevo `GetReceivedOrder` ya trae `workOrders` + `partTransforms` + `partAccountsNotAssignedToReceivedOrder` en una pasada (como ya hace `wo-mover`). Se puede simplificar `loadOVDetails` de `po-reconciler` a una sola query.
