# Bitácora de validación de hashes

Append-only. Cada corrida del cron `steelhead-hash-validator` (lun-vie 8am)
agrega una entrada con timestamp + diff de hashes rotados.

Si una entrada lista `0 rotado(s)` → todo OK ese día.

Cuando aparece una entrada con rotados:
1. Confirmar en el navegador con el applet `hash-scanner`
2. Bumpear `remote/config.json` con los hashes nuevos + `version`
3. Deploy a `gh-pages` (procedimiento en `CLAUDE.md`)
4. Verificar con re-corrida manual de `tools/validate-hashes.py`

---

## 2026-05-23 — Setup inicial + primera rotación detectada

**Corrida**: manual (cron aún no agendado).

**Resultado**: 152 ok / 0 stale / 2 skipped / 0 unknown / 0 auth (config v1.4.26).

### Hashes rotados (detectados + reparados en la misma sesión)

| Operación | Hash viejo | Hash nuevo | Detectado por | Capturado por |
|---|---|---|---|---|
| `GetReceivedOrder` | `c8b31fbc…c151e4f7` | `a286ac8f…f743b8dd5` | validador (Must provide a query string) | hash-scanner navegador (pantalla Receiver Edit) |
| `GetAddPartsReceivedOrder` | `88063397…cda765467` | `f42b08f4…2134ac9f` | validador (Must provide a query string) | hash-scanner navegador (pantalla Add Parts) |

Deploy: `gh-pages` bump 1.4.26, byte-exact verificado con `tools/check-deploy.sh`.

### Whitelist (falsos positivos confirmados)

- `CurrentUser` → hash idéntico en config y scan; 61 invocaciones browser OK;
  responde "Must provide a query string" sólo a scripts externos.
- `GetPurchaseOrder` → mismo patrón; 12 invocaciones browser OK en pantalla Bills.

Diagnóstico: Steelhead distingue browser-Apollo vs cliente-externo para
estas dos ops sensibles a sesión. La validación confiable de éstas es
sólo vía `hash-scanner` en navegador, no este script.

## 2026-05-25 08:35 — 0 rotado(s) (config v1.4.31)

## 2026-05-26 08:41 — 0 rotado(s) (config v1.5.4)

## 2026-05-27 11:05 — 0 rotado(s) (config v1.6.1)

## 2026-05-28 08:35 — 0 rotado(s) (config v1.6.11)

## 2026-06-01 13:30 — 1 stale + 3 reparados en sesión (config v1.6.23)

**Corrida**: manual, disparada junto al deploy del applet `wo-mover`.

**Resultado validador**: 155 ok / 1 stale / 2 skipped / 0 unknown / 0 auth (~99s).

### Rotaciones reparadas en esta sesión (capturadas vía hash-scanner del flujo wo-mover)

| Operación | Hash viejo | Hash nuevo | Nota |
|---|---|---|---|
| `GetReceivedOrder` | `a286ac8f…f743b8dd5` | `4fa89e55…17a7f2bc` | el nuevo query trae workOrders + partTransforms + partAccountsNotAssignedToReceivedOrder en una pasada; ya no requiere Pass 2 (`GetAddPartsReceivedOrder`) |
| `ActiveReceivedOrders` | `4f06f3cb…03aec54b1d` | `495ddfd6…47914890` | **CAMBIÓ variables**: sin `domainId`; ahora `includeArchived`/`receivedOrderStatusFilter`/`searchQuery`. Root key `pagedData`. Actualizado en `po-reconciler.js` + `ov-operations.js` |
| `AllLabels` | `2b16b142…4aa3073c` | `4323ade0…05bef94e` | variables compatibles, solo hash |

Nuevas queries registradas: `WorkOrderDialogQuery`, `GetPartsTransferAccountAssociationData` (flujo de mover OT / asociar partes).

### STALE pendiente de captura

| Operación | Usado por | Acción |
|---|---|---|
| `GetDomain` | `bill-autofill`, `invoice-autofill` (tipo de cambio: `customInputs.TipoCambio` / `currentExchangeRate`) | Correr hash-scanner en la pantalla de facturación que dispare `GetDomain`, capturar el hash nuevo, actualizar `config.json` + redeploy. **Mientras tanto, el tipo de cambio en facturación puede fallar.** |

---

## 2026-06-03 12:00 — 5 rotado(s) (config v1.6.29)

**Corrida**: manual (pre-carga masiva de 500 NP; validar que `bulk-upload` no use hashes rotados).

**Resultado**: 148 ok / 5 stale / 2 skipped / 0 unknown / 0 auth. Elapsed 111s.

### Hashes rotados detectados

| Operación | Tipo | Usado por | ¿Afecta bulk-upload? |
|---|---|---|---|
| `GetReceivedOrder` | query | wo-mover, po-comparator, po-reconciler, portal-importer, ov-operations | **No** |
| `GetReceivedOrderDocuments` | query | po-comparator (ya deprecado internamente → usa `GetReceivedOrder`) | **No** |
| `GetReceivedOrdersWithReceivedOrderLineItems` | query | invoice-autofill | **No** |
| `UpdateInventoryItemPredictedUsage` | mutation | nadie en runtime (solo comentarios en bulk-upload; reemplazado por cascade 1.6.28) | **No** |
| `ArchivePredictedInventoryUsage` | mutation | `tools/archive-predictive-dash.js` (tool DevTools standalone) | **No** |

### Diagnóstico

- **`bulk-upload` está limpio**: ninguno de los 5 stale se invoca en runtime de la carga masiva. `ChangePredictedInventoryUsagesWithRecipeNodeCascade` (el que usa STEP 6a) salió **ok** → vigente. La carga de 500 NP no tronará por hashes.
- **`GetReceivedOrder` rotó OTRA VEZ** (el `4fa89e55…` capturado el 2026-06-01 ya está stale). Afecta wo-mover / facturación / OV — **deuda separada**, requiere hash-scanner en navegador para capturar el nuevo.
- Los 2 hashes de predictivos (`Update…`/`Archive…`) estaban deprecados desde la rotación 2026-06-01; su staleness es **esperada**. `archive-predictive-dash.js` (DevTools) tronaría si se corre — pendiente migrarlo al cascade.

### Pendiente de captura (no bloquea bulk-upload)

| Operación | Acción |
|---|---|
| `GetReceivedOrder` | hash-scanner en pantalla de OV → actualizar config + redeploy (afecta varios applets de OV/facturación) |

---

## 2026-06-04 — 12 rotado(s) (config v1.6.30)

**Corrida**: manual (revisión diaria). 141 ok / 12 stale / 2 skipped / 0 unknown / 0 auth. Elapsed 108s.

**Otra rotación de Steelhead** (7 nuevos vs el 2026-06-03), concentrada en **Bills (CxP)** y **Mantenimiento**.

### Hashes rotados + impacto

| Operación | Tipo | Applet afectado | ¿bulk-upload? |
|---|---|---|---|
| `GetAccountDataForBill` | query | `bill-autofill` | No |
| `GetBillByIdInDomain` | query | `bill-autofill` | No |
| `SearchPurchaseOrdersForBill` | query | `bill-autofill` | No |
| `GetPurchaseOrdersDataForBill` | query | `bill-autofill` | No |
| `CreateUpdateBill` | mutation | `bill-autofill` | No |
| `OperatorMaintenanceNodeDialogQuery` | query | `paros-linea` | No |
| `CreateMaintenanceNodeEvent` | mutation | `paros-linea` | No |
| `GetReceivedOrder` | query | ov-operations, po-comparator, po-reconciler, portal-importer, wo-mover | No |
| `GetReceivedOrderDocuments` | query | (sin uso runtime) | No |
| `GetReceivedOrdersWithReceivedOrderLineItems` | query | invoice-autofill | No |
| `UpdateInventoryItemPredictedUsage` | mutation | (sin uso runtime — cascade 1.6.28 lo reemplazó) | No |
| `ArchivePredictedInventoryUsage` | mutation | `tools/archive-predictive-dash.js` (DevTools) | No |

### Diagnóstico

- **`bulk-upload` limpio** (cargas masivas no afectadas; sigue en 1.5.18/1.6.30).
- **`bill-autofill` (CxP) roto**: 5 hashes → no podrá buscar/leer/crear bills hasta recapturar.
- **`paros-linea` roto**: 2 hashes (diálogo de mantenimiento + crear evento de nodo).
- OV/facturación: `GetReceivedOrder` + `GetReceivedOrdersWith…` siguen stale del 2026-06-03.

### Pendiente de captura (prioridad alta: bill-autofill)

| Aplet | Pantalla para hash-scanner |
|---|---|
| `bill-autofill` | Pantalla de Bills/CxP (buscar PO, abrir bill, guardar) → captura los 5 hashes |
| `paros-linea` | Diálogo de mantenimiento de nodo |
| OV/facturación | Pantalla de OV (Received Order) |

### Reparación (config 1.6.31, mismo día) — hash-scanner navegador

Capturados nuevos del scan `2026-06-04_102353` → 12 stale ⇒ **6 stale**:

| Operación | viejo → nuevo |
|---|---|
| `GetReceivedOrder` | `4fa89e55…` → `499103ff…` |
| `OperatorMaintenanceNodeDialogQuery` | `b4dcc10b…` → `916178b4…` |
| `GetBillByIdInDomain` | `9a870417…` → `404d9326…` |
| `SearchPurchaseOrdersForBill` | `e29e1afc…` → `37fa487a…` |
| `GetPurchaseOrdersDataForBill` | `6faed5d5…` → `87987ec9…` |
| `CreateMaintenanceNodeEvent` | `6aaef93e…` → `930aa9f6…` |

**`paros-linea` reparado** (2/2). **`bill-autofill`** reparado 3/5 (`GetBillByIdInDomain`, `SearchPurchaseOrdersForBill`, `GetPurchaseOrdersDataForBill`); `GetAccountDataForBill` → **whitelist** (falso positivo, scanCount 75 OK en navegador). `GetReceivedOrder` reparado (OV/wo-mover/po-comparator).

**Siguen stale (no reparados):**
- `CreateUpdateBill` (mutation) — bill-autofill no podrá **guardar** bills; no se disparó en el scan (hay que guardar un bill con el scanner activo).
- `GetReceivedOrdersWithReceivedOrderLineItems` — invoice-autofill; no se disparó.
- `GetReceivedOrderDocuments` — sin uso runtime.
- `UpdateInventoryItemPredictedUsage` / `ArchivePredictedInventoryUsage` — deprecados (cascade 1.6.28 los reemplazó); sin uso runtime.

