# Spec: PO Reconciler (Schneider Querétaro)

**Fecha:** 2026-05-12
**Estado:** Borrador en revisión
**Applet propuesto:** `remote/scripts/po-reconciler.js`

## Resumen ejecutivo

Applet que automatiza el rebalanceo entre N órdenes de venta (OVs) temporales creadas al recibo de una Hoja de Salida (HS) y N POs reales que el cliente envía después, redistribuyendo líneas de OT entre las temp OVs existentes y renombrándolas con el número de PO real al final. **No crea OVs nuevas excepto** una sola OV persistente "Restantes Schneider QRO" cuando la HS tiene más piezas que las que las POs piden.

### Problema que resuelve

Ecoplating recibe HS con piezas agrupadas operacionalmente (Producción, Kitting, Lote cerrado) y crea OVs temporales con esos nombres. Después, el cliente Schneider Querétaro envía POs reales con numeración SAP (`1400395001`, etc.) que **no respetan los grupos operativos**: redistribuye los mismos números de parte entre POs siguiendo un criterio interno no determinístico. Hoy el equipo busca cada PN manualmente, ajusta cantidades, mueve líneas entre OVs y renombra OVs — proceso lento, manual y altamente propenso a errores.

Detalle completo del problema en `Problema de negocio Consolidación autom.md` en la raíz del repo (no commiteado).

### Naturaleza del problema

Reconciliación y consolidación dinámica. NO es predicción, clasificación, ML o NLP. La unidad mínima confiable es el número de parte; la reconciliación se hace por cantidad consolidada de PN.

## Arquitectura

Single-file applet en `remote/scripts/po-reconciler.js` (~1700 líneas estimadas). Sigue el patrón de `po-comparator` (UI overlay + Claude API para parseo) y `portal-importer` (orquestación de mutaciones multi-paso).

### Capas internas

1. **Parser PDF** — reusa `POComparator.parsePdf()`; nuevo wrapper `parseMultiplePdfs(files)` que dispara N parseos en paralelo (un PDF por PO de Schneider).
2. **OV inventory** — query `ActiveReceivedOrders` filtrada por `customerId = Schneider QRO` + `shipToAddressId = planta QRO` + filtro por nombre que NO matchee `/^14\d{8}$/` (regex de PO SAP).
3. **Reconciliation engine** — función pura `buildPlan({ pos, temps, restantesOV, config })` → devuelve `Plan`. Determinista, testeable sin DOM ni red.
4. **UI controller** — wizard de 4 pasos en un solo overlay.
5. **Executor** — orquesta las mutaciones serial, con idempotencia por paso, retry con backoff para errores transitorios, sin abort global.
6. **Audit log builder** — recolecta cada paso ejecutado → CSV descargable al final.

### Entrypoints

- **FAB flotante** inyectado cuando URL matchea `/Domains/\d+/ReceivedOrders/?` (patrón `paros-linea`).
- **Botón manual en popup de extensión** que dispara la inyección del applet en la pestaña activa.

Ambos convergen en el mismo wizard.

### Dependencias en `config.json`

```jsonc
{
  "schneider": {
    "queretaro": {
      "customerId": <pendiente: extraer en impl>,
      "shipToAddressId": <pendiente>,
      "poNumberRegex": "^14\\d{8}$",
      "restantesOvName": "Restantes Schneider QRO"
    }
  },
  "applets": {
    "poReconciler": { "enabled": true }
  }
}
```

Hashes nuevos a agregar (verificar estado `new` en scan antes de usar):
- `AddPartsToWorkOrders`
- `AdjustPartCountOnRoWoQuery`
- `SearchWorkOrdersToMoveToFromRo`
- `CreateWorkOrderFromWorkOrderQuery`
- `MovePartsToRecipeNodeId` (probablemente no necesario en v1; queda registrado por si acaso)

**Hash a actualizar:** `UpdateReceivedOrder` de `50bfb588…dafe8b` (viejo) a `84f5c4550e9bad52df7e297049b9c42b3e28cb3cd21215bb4fe57f236ce42d08` (capturado el 2026-05-12).

## Flujo de datos

```
[ N PDFs Schneider ]              [ Steelhead OV listing ]
       │                                   │
       ▼                                   ▼
parseMultiplePdfs()              loadCandidateTempOVs()
   │ Claude API (paralelo)          │ ActiveReceivedOrders + filtros
   │                                │ (customer + shipTo + name NOT ~ /^14\d{8}$/)
   ▼                                ▼
[ pos: [{ poNumber, lines[] }] ]    [ temps: [{ ovId, name, ots[], totalsByPN }] ]
                                    [ restantesOV: lookup or null ]
                  └────────┬─────────┘
                           ▼
                   buildPlan({ pos, temps, restantesOV, config })
                           ▼
   [ Plan {
       assignment: [{ tempOvId, poNumber }],
       moves:      [{ pn, qty, fromOvId, fromOtId, toOvId }],
       restantes:  [{ pn, qty, fromOvId, fromOtId }],
       renames:    [{ ovId, fromName, toName }],
       creates:    [{ type: 'restantes-ov', name, metadata }],  // máx 1
       issues:     [{ severity, type, pn?, detail }],
     } ]
                           ▼
              [ UI: Tabla maestra editable ]
                           ▼
              [ Plan validado ]
                           ▼
              executePlan(plan, onProgress)
                  │  1. Create OV Restantes (si plan.creates lo pide)
                  │  2. Moves entre temp OVs
                  │  3. Moves a OV Restantes
                  │  4. Reconciliación de cantidades en líneas de OV (siempre)
                  │  5. Renames de temp OVs
                  ▼
              buildAuditCsv() → download
```

**Decisiones clave del flujo:**
- Reconciliación de líneas con `SaveReceivedOrderLinesAndItems` es **obligatoria** después de cada batch de moves a una OV — Steelhead no auto-reconcilia `line.quantity` cuando se mueven OTs.
- El plan es el contrato entre UI y executor. Recomputarlo es barato (<50ms en casos reales), así que ediciones del usuario disparan recomputación completa con overrides como constraints (no parchazos).
- Orden de mutaciones es crítico: creates antes que moves antes que renames. Renames al final para que la bitácora muestre nombres viejos en los pasos intermedios.

## Reglas funcionales

### Identificación de temp OVs candidatas
- `customerId = <Schneider QRO>` (en config.json)
- `shipToAddressId = <planta QRO específica>` (en config.json)
- `archivedAt = null` (OV activa)
- `name` NO matchea `/^14\d{8}$/` (regex SAP de Schneider; configurable)

### Asignación temp ↔ PO (matching 1:1)
- Cardinality estricta: `#POs == #temps`. Si difieren → issue fatal, no se ejecuta plan automático.
- Algoritmo: **Hungarian algorithm** sobre matriz de costo `C[i][j] = Σ_pn |temps[i].byPN[pn] − pos[j].byPN[pn]|` (suma de diferencias absolutas por PN). Para N pequeño (≤6): enumerar todas las permutaciones funciona también.
- Resultado: 1:1 entre temp OVs y POs, minimizando piezas a mover globalmente.

### Generación de movimientos
- Por cada PN: distribución actual `{ ovId → qty }` vs. distribución objetivo (vía assignment). Algoritmo greedy: dona del OV con mayor excedente al OV con mayor déficit hasta cuadrar.
- Para N=3 temp OVs, máximo `N-1 = 2` movimientos por PN.

### Manejo de discrepancias

| Caso | Acción del applet |
|---|---|
| `HS > Σ POs` (sobrante por PN) | Mover excedente a OV Restantes. Si la OV Restantes no existe, crearla. |
| `HS < Σ POs` (faltante por PN) | Issue `warn:faltante`, línea excluida del plan automático. Usuario revisa manualmente. |
| `PN solo en HS` | Issue `warn:pn_solo_en_hs`. Las piezas van completas a OV Restantes. |
| `PN solo en PO` | Issue `warn:pn_solo_en_po`. Sin movimiento (no se puede surtir). Línea excluida. |
| `#POs ≠ #temps` | Issue `fatal:cardinality_mismatch`. Plan vacío. Usuario ajusta manualmente fuera del applet. |
| OT con `recipeNodeId` distinto del esperado terminal | Aborto pre-plan: error claro al cargar temp OVs en paso 1. |

### Override del usuario
- Reasignar temp ↔ PO (cambia `assignment` y recomputa todo).
- Forzar origen de un movimiento (sobrescribe la elección greedy).
- Excluir movimiento (lo mueve a issues `manual`).

### OV Restantes
- Nombre fijo configurable (default `Restantes Schneider QRO`).
- Persistente: una sola por cliente, reutilizada entre corridas.
- Si no existe, el applet la crea heredando metadata de la primera temp OV de la corrida (mismo `customerId`, `shipToAddressId`, `customInputs`, `inputSchemaId`, etc.) y sobrescribe solo `name`.

## UI (wizard de 4 pasos)

### Paso 1 — Cargar PDFs
- Multi-file picker drag-and-drop (acepta `.pdf` solamente).
- Sidebar derecho: lista de OVs temp detectadas del cliente Schneider QRO (auto-cargadas al abrir).
- Botón "Continuar" habilitado cuando hay ≥1 PDF + ≥1 temp OV.

### Paso 2 — Revisar parseo
- Por PDF: status (parseado OK / error / partial) + summary line (PO number, líneas, qty total) + botón "Ver detalle" que abre drawer con tabla cruda.
- Reintento por PDF individual.
- Avanza solo si todos los PDFs están OK (o usuario skip-ea explícitamente los rotos).

### Paso 3 — Plan editable
Secciones:
- **Resumen** (POs ↔ temps, totales de moves/sobrantes/issues/renames).
- **Asignación temp ↔ PO** (1:1, editable con dropdowns).
- **Movimientos** (tabla editable con `[✏]` por fila).
- **Sobrantes → OV Restantes** (sección destacada, avisa si la OV no existe).
- **Issues** (severity-coded, no se ejecutan).
- Filtros (chips) para mostrar solo ciertas secciones.
- Botón "Recalcular plan" (vuelve a correr `buildPlan` con overrides actuales).
- Botón "Ejecutar →" deshabilitado si hay issues `fatal`.

### Paso 4 — Ejecutar
- Stream visual paso a paso (✓ done, ⠋ in progress, ⋯ pending, ✗ failed).
- Progress bar (`X / total`).
- Botón "Cancelar" (no aborta mutación en vuelo; corta antes de la siguiente).
- Al terminar:
  - Botón "Descargar bitácora (CSV)".
  - Si hubo errores: panel rojo + botón "Reintentar fallidos" (idempotente).

## Ejecutor de mutaciones

### Orden global

1. **Create OV Restantes** (0 o 1 mutación) — `CreateReceivedOrder` con metadata clonada de una temp OV.
2. **Moves entre temp OVs** (N mutaciones) — patrón `executeMove()` por movimiento.
3. **Moves a OV Restantes** (M mutaciones) — mismo `executeMove()`.
4. **Reconciliación de líneas** (K mutaciones, siempre) — `SaveReceivedOrderLinesAndItems` para cada OV tocada, ajustando `line.quantity` a la suma real de OTs.
5. **Renames** (N mutaciones) — `UpdateReceivedOrder` full-record replay.

### `executeMove({ pn, qty, fromOvId, fromOtId, toOvId })`

1. Buscar OT destino para `pn` en `toOvId`:
   - Si existe: usar esa.
   - Si no: `CreateUpdateWorkOrdersChecked { id: null, receivedOrderId: toOvId, productId, customerId, deadline, type: 'MAKE_TO_ORDER', ... }` → captura `newOtId`.
2. `AddPartsToWorkOrders` con shape:
   ```js
   {
     inventoryTransferEventGroupsToCreate: [{
       inventoryTransferEvents: [{
         creditAccounts: { accounts: [{ id: fromOt.accountId, microQuantity: qty * 1_000_000 }] },
         debitAccounts:  { accounts: [{ microQuantity: qty * 1_000_000 }] },
         partsTransferEvent: {
           createPartsTransferEvent: {},
           partsTransfers: [{
             partCount: qty,
             toAccount: {
               inventoryAccountId:           toOt.accountId ?? null,
               locationId:                   toOt.locationId,
               receivedOrderPartTransformId: toOt.receivedOrderPartTransformId,
               recipeNodeId:                 toOt.recipeNodeId,
               workOrderId:                  toOt.id,
             },
             type: 'ENTRANCE',
             useUndefinedFieldsFromAccountId: fromOt.accountId,
           }],
         },
         transferType: 'DEPLETE',
       }],
     }],
     partNumberWorkOrders: [{ partNumberId: move.partNumberId, workOrderId: toOt.id }],
     partsTransferEventsPayload: [{ createPartsTransferEvent: {}, partsTransfers: [] }],
     recipeNodePartNumberTreatmentsToCreate: [],
   }
   ```

### Reconciliación de líneas (paso 4)

Después de los moves, para cada OV tocada:
1. `GetReceivedOrder(ovId)` → obtener líneas actuales.
2. Por cada línea: suma de qtys de OTs asociadas vs `line.quantity`.
3. Si difieren: `SaveReceivedOrderLinesAndItems { input: { receivedOrderId: ovId, newLines: [{ id: line.id, ... quantity: newQty ... }] } }`.

### Rename (paso 5)

`UpdateReceivedOrder` requiere full-record replay (no acepta `{id, name}` solo). Patrón:
```js
const current = snapshotByOvId[rename.ovId]; // snapshot tomado en paso 1, no nuevo GET
await SteelheadAPI.updateReceivedOrder({
  ...mapToUpdateShape(current),
  id: current.id,
  name: rename.toName,
});
```

Campos del shape (capturados el 2026-05-12):
`id, name, customerId, deadline, customerContactId, billToAddressId, shipToAddressId, invoiceTermsId, customInputs, inputSchemaId, shipVia, shipMethodId, type, blockPartialShipments, sectorId, isBlanketOrder, productionStartDate, contractualDeadline, defaultSignOffRecipeId`.

### Idempotencia

Cada paso verifica estado deseado antes de actuar:
- **Move:** `toOt.partCount` vs. snapshot. Skip si delta ya aplicado.
- **Rename:** `ov.name` actual vs. `toName`. Skip si ya está renombrada.
- **Create restantes:** lookup por nombre antes de crear. Skip si ya existe.

Permite reintentar el plan completo sin duplicación.

### Manejo de errores

| Tipo | Acción |
|---|---|
| 502 / network error | Retry con backoff `[1s, 2s, 4s]` hasta 3 intentos |
| 4xx validación | No retry, marcar `failed`, continuar al siguiente paso |
| `UNIQUE_CONSTRAINT` | Marcar `already_done` (idempotencia), continuar |
| Inesperado | Marcar `failed` + log completo, continuar |

**Defecto: no cascadear aborts.** Si una OT falla, las demás OTs y los renames siguen. La bitácora muestra qué falló; usuario decide próximo paso.

### Cancelación

Botón "Cancelar" setea `runStale = true`. El executor revisa el flag entre pasos (no a media mutación — se dejan terminar para no dejar estado inconsistente).

## Bitácora CSV

Columnas:
```
timestamp, run_id, step_type, step_index, status, ov_id, ov_name_before, ov_name_after,
ot_id, part_number, qty_moved, from_ov, to_ov, mutation_op, error_message
```

Filename: `reconciliacion-schneider-qro-YYYY-MM-DD-HHMMSS.csv`.

Descarga automática al terminar (o al cancelarse) la corrida.

## Testing

### Unit tests del motor

Archivo: `tools/test/po-reconciler.test.js`. Sin framework, solo `node` + `assert`. Casos:
1. Match perfecto → 0 moves.
2. PN repartido cross-OV consolidado en 1 PO → 1 move.
3. Sobrante (HS > Σ POs) → plan.restantes > 0; create de OV Restantes si no existe.
4. Faltante (HS < Σ POs) → issue warn, línea excluida.
5. PN solo en HS → mover a Restantes.
6. PN solo en PO → issue warn, sin movimiento.
7. Cardinality mismatch → issue fatal, plan vacío en moves/renames.
8. Override de asignación → recomputa moves con constraint.
9. Hungarian no trivial (3 temps qtys distintos vs 3 POs) → asignación óptima global.

Comando: `node tools/test/po-reconciler.test.js`. Manual antes de cada deploy (no hay CI).

### Tests de integración

Manuales contra Steelhead de prueba (no hay framework). Casos 1-9 documentados en sección 6 del brainstorming. Setup: 3 OVs temp `TEST-Producción/Kitting/Lote cerrado` con PNs comunes; 1-3 PDFs de prueba.

### Captura de mutations antes del primer deploy (bloqueante)

1. **`AddPartsToWorkOrders`** — verificar si una sola llamada mueve cross-OV o si requiere split + move en pasos. Hacer un split manual desde la UI con DevTools abierto y capturar el body real.
2. **`SaveReceivedOrderLinesAndItems` para update de qty** — verificar que mandar `id` existente con `quantity` distinta efectivamente actualiza (sin crear línea nueva).
3. **`UpdateReceivedOrder` con hash nuevo `84f5c455…`** — verificar que el nuevo hash está vivo y que con `name` distinto efectivamente renombra.

### Datos a extraer del entorno antes de codear

- `schneider.queretaro.customerId` — extraer del customer en Steelhead.
- `schneider.queretaro.shipToAddressId` — extraer del shipTo "planta Querétaro".
- Hashes vivos de `AddPartsToWorkOrders`, `AdjustPartCountOnRoWoQuery`, `SearchWorkOrdersToMoveToFromRo`, `CreateWorkOrderFromWorkOrderQuery` — todos `status: new` en el scan del 2026-05-12, hay que re-confirmar antes de incluir en config.json.
- Confirmar nombre exacto de la OV Restantes con el usuario antes del primer deploy (default `Restantes Schneider QRO`).

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Steelhead deprecate un hash (como pasó con `CurrentUser` en 2026-04-27) | Mutations vía helper `SteelheadAPI.<op>()`; actualizar config.json en un solo lugar |
| Race condition: usuario modifica OV en otra pestaña a media corrida | Snapshot inicial + reconciliación post-move detecta drift; warning operativo en UI de no abrir otras pestañas |
| Claude API falla parseando un PDF | Paso 2 permite reintento por PDF individual; fallback CSV bypass queda para v2 |
| OT en estado distinto a "Listo para Embarcar" | Pre-check en paso 1: si `recipeNodeId` no es el esperado, abort con error claro |
| OV Restantes acumula demasiadas piezas | Decisión operativa, no del applet. Umbral de alerta posible en v2 |

## Scope fuera de v1

- Soporte multi-cliente (refactor para v2; config-driven).
- Undo automático (descartado).
- OTs en proceso productivo (descartado; asunción: todo en nodo terminal).
- Cardinality mismatch auto-resolución (queda como fatal en v1).
- Crear OVs nuevas para POs adicionales (descartado; solo OV Restantes se crea).
- Bulk `partsTransfers` en una sola mutation (mantenemos serial; optimizable en v2).

## Dependencias y archivos a tocar

- `extension/manifest.json` — sin cambios.
- `extension/background.js` — handler para inyectar `po-reconciler` cuando lo dispara el popup.
- `extension/popup.html` + `popup.js` — botón "Reconciliar PO Schneider".
- `remote/config.json` — agregar hashes nuevos + actualizar `UpdateReceivedOrder` + sección `schneider.queretaro` + `applets.poReconciler`.
- `remote/scripts/po-reconciler.js` — archivo nuevo (~1700 líneas estimadas).
- `tools/test/po-reconciler.test.js` — suite de unit tests del motor.

## Versionado

Bump `config.json.version` de `0.5.86` actual a `0.6.0` en el primer commit del applet (major-minor bump por introducción de feature grande). Bug fixes posteriores: `0.6.1`, `0.6.2`, etc.

## Tamaño estimado

| Componente | Líneas estimadas |
|---|---|
| Motor de reconciliación | 250 |
| Wizard UI (4 pasos) | 600 |
| Ejecutor + helpers de mutaciones | 400 |
| Bitácora CSV builder | 80 |
| Estilos CSS internos | 200 |
| Boilerplate (init, FAB, URL gate, glue) | 150 |
| **Total** | **~1700** |

Si crece arriba de 2500: extraer el motor a `remote/scripts/lib/po-reconciler-engine.js`.
