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
- `GetReceivedOrdersWithReceivedOrderLineItems` — **reparado en config 1.6.32** (`cff4549f…`→`2e98d28d…`, scan `104237`, invoice-autofill).
- `CreateUpdateBill` → **RENOMBRADO por SH a `UpdateBillChecked`** (descubierto 2026-06-04 al guardar un bill; misma shape `billPayload.customInputs.DatosContables`). Reparado en **config 1.6.33** (key+hash `1f3b253a…`) + **`bill-autofill.js`** (el interceptor ahora acepta `UpdateBillChecked` además de `CreateUpdateBill`). bill-autofill **vuelve a inyectar Divisa/TC** al guardar bills.
- `GetReceivedOrderDocuments` — sin uso runtime.
- `UpdateInventoryItemPredictedUsage` / `ArchivePredictedInventoryUsage` — **REMOVIDOS del config en 1.6.35** (deprecados desde el cascade 1.6.28; sin uso runtime). `tools/archive-predictive-dash.js` pendiente de migrar al cascade.

**Estado final de la jornada 2026-06-04: 149 ok / 1 stale / 3 whitelist.** Único stale restante: `GetReceivedOrderDocuments` (deprecado en 1.6.28, reemplazado por `GetReceivedOrder` en po-comparator; sin uso runtime — candidato a remover).

---

## 2026-06-08 10:38 — 3 rotado(s) (config v1.6.47)

**Corrida**: manual (disparada por el usuario; flujo del daily schedule). 147 ok / 3 stale / 3 whitelist / 0 unknown / 0 auth. Elapsed 109.5s.

### Hashes rotados + impacto

| Operación | Usado por | Clase | Acción |
|---|---|---|---|
| `GetDomain` | `bill-autofill` (L413) + `invoice-autofill` (L500) — TipoCambio/TC | **rotación NUEVA, activa y crítica** | Recapturar con hash-scanner |
| `GetReceivedOrdersWithReceivedOrderLineItems` | `invoice-autofill` (L410) — OVs + divisa/linkage | **RE-rotación**: ya reparado el 2026-06-04 en 1.6.32 (`2e98d28d…`); SH lo volvió a rotar | Recapturar con hash-scanner |
| `GetReceivedOrderDocuments` | SPA nativa de Steelhead (count=8 en scan); nuestro po-comparator ya NO lo usa (migró a `GetReceivedOrder` en 1.6.28) | **rotación real** (status:changed, HTTP 200) — NO era huérfano-muerto | Bump hash (se mantuvo en config por si se reusa) |

### Diagnóstico

- **`bill-autofill` (CxP) e `invoice-autofill` afectados** vía `GetDomain`: no podrán resolver el tipo de cambio (TC) hasta recapturar.
- **`invoice-autofill` doblemente afectado**: también `GetReceivedOrdersWithReceivedOrderLineItems` (trae OVs con divisa + linkage de invoice→OV).
- **`bulk-upload` limpio**.
- `GetReceivedOrderDocuments` también rotó de verdad (el scan lo muestra `status:changed`, count=8 disparado por la SPA nativa). No rompe ningún applet nuestro porque po-comparator ya migró a `GetReceivedOrder`; aun así se actualizó el hash para no dejar el config desfasado.

### Reparación (config 1.6.48, mismo día) — scan `2026-06-08_104505`

Las 3 confirmadas como **Caso A (rotación)** del playbook: `previousHash` del scan == hash viejo del config, `hash` nuevo distinto, `lastHttpStatus=200`, `status:changed`.

| Operación | viejo → nuevo |
|---|---|
| `GetDomain` | `774f1f0f…` → `28b65e26…` |
| `GetReceivedOrdersWithReceivedOrderLineItems` | `2e98d28d…` → `8090a9dc…` |
| `GetReceivedOrderDocuments` | `c2df1330…` → `7d74c516…` |

Bump `version` 1.6.47 → **1.6.48** + `lastUpdated` 2026-06-08T10:45.

**Re-validación local (config 1.6.48): 150 ok / 0 stale / 3 whitelist / 0 unknown / 0 auth.** El server acepta los 3 hashes nuevos.

**Pendiente**: deploy a `gh-pages` + recargar extensión en el navegador (Chrome cachea `config.json` ~5 min).

## 2026-06-10 12:36 — 0 rotado(s) (config v1.6.51)

## 2026-06-15 22:14 — 20 rotado(s) (config v1.6.72)

Validación a mano (skill `steelhead-hash-validator`, conectado a SH): **137 ok / 20 stale / 3 whitelist / 0 unknown / 0 auth** en 95.9s. Rotación grande de Steelhead; el usuario ya los está corrigiendo. El cron `hash-validator-daily` no estaba corriendo (última corrida 2026-06-10; `scheduled_tasks.json` ausente, CronList vacío) → recreado en esta sesión.

**Queries rotadas (18):** `GetQuote_v8`, `GetQuote_v71`, `AllProcesses`, `GetPartNumber`, `Customer`, `AllPartNumbers`, `AllWorkOrders`, `SearchInventoryItemBatches`, `CreateEditReceivedOrderDialogQuery`, `GetCustomerInfoForReceivedOrder`, `GetReceivedOrder`, `GetSpec`, `SpecFieldsAndOptions`, `ReceivingBatchesQuery`, `InvoiceByIdInDomain`, `SearchPurchaseOrdersForBill`, `GetPurchaseOrdersDataForBill`, `GetReceivedOrdersWithReceivedOrderLineItems`.

**Mutations rotadas (2):** `SaveManyPNP_Quote`, `SaveManyPNP_PN`.

**No afectados** (relevante para hoy): `GetInventoryItem`, `UpdateInventoryItemInputs` siguen vigentes → `catalog-fetcher` (hoja CAT_Procesos) y `tools/rename-catalog-label.js` operan bien. Ojo: `catalog-fetcher` SÍ usa `AllProcesses` + `SpecFieldsAndOptions` (rotadas) → la hoja Procesos y los combos de specs del "Actualizar Catálogos" fallarán hasta actualizar esos hashes.


## 2026-06-15 22:48 — CORRECCIÓN: deploy config 1.6.73 (22 ops re-capturadas)

Re-captura vía hash-scanner (navegador, same-origin). Las 20 rotadas confirmadas ROTADAS **desde el browser** (no falsos positivos del validador externo), **más `GetAccountDataForBill`** (estaba whitelisted como session-sensitive pero su hash TAMBIÉN rotó: `62fbb91b…` → `4265fbba…`). Total **22 keys** actualizadas (`GetQuote_v8/v71` y `SaveManyPNP_Quote/PN` comparten hash).

Deploy `tools/deploy.sh --set 1.6.73`. **Re-validación: 158 ok / 0 stale / 2 whitelist (`CurrentUser`, `GetPurchaseOrder`).** `GetAccountDataForBill` con el hash nuevo ya pasa desde el validador → **removido de la whitelist**.

`CurrentUser` y `GetPurchaseOrder` NO rotaron (scan == config) → siguen session-sensitive (el front los usa OK; scripts externos / fetch de la extensión reciben "Must provide a query string"). Por eso el gating de `report-regen` se rediseñó (v0.2.0) para NO llamar `CurrentUser` sino interceptar la respuesta del front.

## 2026-06-15 23:28 — 0 rotado(s) (launchd)

## 2026-06-16 10:19 — 1 rotado(s)

- Config version: `1.6.74`
- OK: 157 / 160 · Tiempo: 120.5s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-16.json`

**Rotados:**
- `query GetProcessNode` (hash `fe59624d7a4f...`)

## 2026-06-16 21:19 — 4 rotado(s)

- Config version: `1.6.76`
- OK: 154 / 160 · Tiempo: 129.2s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-16.json`

**Rotados:**
- `query SearchAccounts` (hash `90022de3792f...`)
- `query GetBillByIdInDomain` (hash `404d9326b62e...`)
- `query GetVendor` (hash `326a130b68bf...`)
- `query GetProcessNode` (hash `fe59624d7a4f...`)

## 2026-06-17 09:38 — Reparación: deploy config 1.6.77 (4 ops re-capturadas)

Re-captura vía hash-scanner (navegador, same-origin) — scan `2026-06-17_093448`. Las 4 rotadas confirmadas **Caso A (rotación real)** del playbook: `previousHash` del scan == hash viejo del config, `hash` nuevo distinto, `status:changed`, `lastHttpStatus:200` (el server ya acepta el hash nuevo). No son falsos positivos del validador externo.

| Operación | viejo → nuevo | usedBy |
|---|---|---|
| `SearchAccounts` | `90022de3…` → `4b00b2b2…` | bill-autofill |
| `GetBillByIdInDomain` | `404d9326…` → `161bb5aa…` | bill-autofill |
| `GetVendor` | `326a130b…` → `efb7af01…` | bill-autofill |
| `GetProcessNode` | `fe59624d…` → `fae7d1d1…` | process-canon, process-deep-audit |

Deploy `tools/deploy.sh --check bill-autofill` → bump 1.6.76 → **1.6.77** + `lastUpdated` 2026-06-17T09:38. Publicado en vivo (GitHub Pages, verificado por polling).

**Re-validación local (config 1.6.77): 158 ok / 0 stale / 2 skipped (`CurrentUser`, `GetPurchaseOrder` whitelist) / 0 unknown / 0 auth** en 100.5s.

Cierra issues `#3` (4 rotados) y `#2` (1 rotado — `GetProcessNode`, ya incluido en el set de 4).

## 2026-06-17 11:19 — 1 rotado(s)

- Config version: `1.6.77`
- OK: 157 / 160 · Tiempo: 126.5s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-17.json`

**Rotados:**
- `query GetDomain` (hash `28b65e268c0d...`)

## 2026-06-17 16:04 — Reparación: deploy config 1.6.78 (GetDomain re-capturado)

Re-captura vía hash-scanner (navegador, same-origin) — scan `2026-06-17_160048` (el scan previo `_093448` NO capturó `GetDomain` en vivo: la operación solo se dispara desde `bill-autofill`/`invoice-autofill` al abrir una factura, y no se navegó ahí; aparecía como `source:"documentada"` reflejando el hash viejo). Rotación confirmada **Caso A (rotación real)** del playbook: el server respondió `"Must provide a query string."` al hash viejo, y el scan trae `previousHash` == hash viejo, `hash` nuevo distinto, `status:changed`, `lastHttpStatus:200`. El `responseSchema` del scan incluye `customInputs.TipoCambio` + `currentExchangeRate` → es el `GetDomain` correcto.

| Operación | viejo → nuevo | usedBy |
|---|---|---|
| `GetDomain` | `28b65e26…` → `a7216eb7…` | bill-autofill, invoice-autofill |

Validación puntual del hash nuevo contra el server → **HTTP 200 con data real** antes de editar. Deploy `tools/deploy.sh --check bill-autofill` → bump 1.6.77 → **1.6.78** + `lastUpdated` 2026-06-17T16:04 (commit main `e94887b`, gh-pages `07dcfb7`). Publicado en vivo (GitHub Pages, verificado por polling: `GetDomain live=a7216eb7…`).

**Re-validación local (config 1.6.78): 158 ok / 0 stale / 2 skipped (`CurrentUser`, `GetPurchaseOrder` whitelist) / 0 unknown / 0 auth** en 99.2s.

Cierra issue `#4` (1 rotado — `GetDomain`).

## 2026-06-17 22:19 — 1 rotado(s)

- Config version: `1.6.78`
- OK: 157 / 160 · Tiempo: 121.6s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-17.json`

**Rotados:**
- `query GetDomain` (hash `a7216eb75b65...`)

## 2026-06-17 23:37 — 0 rotado(s) (launchd)

## 2026-06-18 22:42 — 0 rotado(s) (launchd)

## 2026-06-18 23:19 — 1 rotado(s)

- Config version: `1.6.82`
- OK: 157 / 160 · Tiempo: 129.4s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-18.json`

**Rotados:**
- `query GetDomain` (hash `a7216eb75b65...`)

## 2026-06-19 01:39 — Reparación: deploy config 1.6.83 (GetDomain rotó otra vez `a7216eb7` → `5c56c7a0`)

Rotación **REAL** confirmada (3ra de `GetDomain` en ~2 días: `28b65e26…` → `a7216eb7…` → `5c56c7a0…`). Cierra issues **#5** y **#6** (ambos eran este `a7216eb7` muriendo, NO falsos positivos).

**Trampa evitada (la del playbook):** el bloque `apiKnowledge` del scan refleja el hash de **config** (`a7216eb7`), NO la captura en vivo → un diff contra `apiKnowledge` dio "0 mismatches" (engañoso). El dato real vive en `scanResults["GetDomain"]` = `5c56c7a0…`, con `eventLog: {op:GetDomain, ok:true, status:200}` a las 07:21:48Z. El diff correcto (scanResults vs config) destapó la rotación.

| Operación | viejo → nuevo | usedBy |
|---|---|---|
| `GetDomain` | `a7216eb7…` → `5c56c7a0…` | bill-autofill, invoice-autofill |

- **Probe puntual al server antes de editar:** hash viejo `a7216eb7` → **6/6** `"Must provide a query string"` (HTTP 400); hash nuevo `5c56c7a0` → **HTTP 200**.
- El "flapping" previo (`a7216eb7` ok en 17 jun 23:37 y 18 jun 22:42, stale en 22:19/23:19) **NO era bug del validador**: fue el rollout escalonado (canary) del cambio server-side entre nodos. El validador detectó bien la rotación. **NO** se aplicó retry-before-stale ni whitelist a `GetDomain` (habría enmascarado una rotación real).
- Deploy `tools/deploy.sh --check bill-autofill`: 1.6.82 → **1.6.83** (commit main `63a1106`, gh-pages `703ad1b`). Verificado en vivo por polling: GitHub Pages sirve `1.6.83` con `GetDomain=5c56c7a0`.
- **Nota de mantenimiento:** `GetDomain` rota con frecuencia inusual. Si reaparece, re-scanear **navegando a una factura** (la op solo dispara desde `bill-autofill`/`invoice-autofill`) y mirar `scanResults`, NO `apiKnowledge`.

## 2026-06-19 22:54 — 1 rotado(s)

- Config version: `1.6.83`
- OK: 157 / 160 · Tiempo: 1736.1s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-19.json`

**Rotados:**
- `query GetDomain` (hash `5c56c7a00a27...`)

## 2026-06-22 08:44 — 0 rotado(s) (launchd)

## 2026-06-22 15:52 — Reparación: deploy config 1.6.84 (GetDomain rotó otra vez `5c56c7a0` → `c0c242bc`)

Rotación **REAL** confirmada (**4ta** de `GetDomain` en ~5 días: `28b65e26… → a7216eb7… → 5c56c7a0… → c0c242bc…`). Detectada por corrida **manual** del validador (`config 1.6.83`, OK 157/160, 114.9s, resultado `tools/.hash-validation/2026-06-22.json`).

| Operación | viejo → nuevo | usedBy |
|---|---|---|
| `GetDomain` | `5c56c7a0…` → `c0c242bc00a6…` | bill-autofill, invoice-autofill |

- **Flapping intra-día confirmado otra vez:** el launchd de **hoy 08:44 dio 0 rotados** con `5c56c7a0`; a las 15:52 (manual) salió stale 3/3. Consistente con rollout escalonado (canary) del server entre nodos, igual que el 19 jun. No es bug del validador.
- **Probe puntual al server (antes de editar):** hash viejo `5c56c7a0` → **3/3** `"Must provide a query string"` (HTTP 400); hash previo `a7216eb7` → también stale; hash nuevo `c0c242bc` → **HTTP 200 con data** (3/3).
- **Fuente del hash nuevo:** scan del navegador `scan_results_2026-06-22_160230.json` → `scanResults.GetDomain = c0c242bc…` con `eventLog {op:GetDomain, ok:true, status:200}` a las 22:02:24Z. Mirado `scanResults` (tráfico en vivo), NO `apiKnowledge` (la trampa del playbook).
- Deploy `tools/deploy.sh --check bill-autofill`: 1.6.83 → **1.6.84**. NO disparado gh-issue/email/push (corrida manual, usuario presente).
- **Nota de mantenimiento:** `GetDomain` ya rotó 4 veces; es la op más inestable del registry. Si reaparece, re-scanear **navegando a una factura** y mirar `scanResults`, NO `apiKnowledge`.

## 2026-06-22 20:19 — 0 rotado(s) (launchd)

## 2026-06-22 22:35 — 0 rotado(s) (launchd)

## 2026-06-24 10:19 — 3 rotado(s)

- Config version: `1.7.1`
- OK: 160 / 165 · Tiempo: 138.6s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-24.json`

**Rotados:**
- `query GetSpec` (hash `6945af196c6e...`)
- `query GetSpecFieldSpec` (hash `4da5a5785f6a...`)
- `query InvoiceByIdInDomain` (hash `b98519554b2b...`)

## 2026-06-24 12:48 — 4 rotado(s) + reparación parcial + deploy config 1.7.2

**Corrida**: manual (agente de mantenimiento, skill `steelhead-hash-validator`).

**Resultado pre-reparación**: 159 ok / 4 stale / 2 skipped / 0 unknown / 0 auth. Elapsed: 121.6s.

**Stale detectado adicional vs la corrida de las 10:19:** `GetReceivedOrdersWithReceivedOrderLineItems` — rotó de nuevo (el hash `f3bf00a3…` capturado el 2026-06-15 ya está stale; no hay captura nueva en los scans de hoy).

### Hashes reparados (confirmados HTTP 200 contra el server antes de editar)

| Operación | viejo → nuevo | usedBy | Fuente del hash nuevo |
|---|---|---|---|
| `GetSpec` | `6945af19…` → `73c17957…` | spec-migrator | scan `2026-06-24_122857` + confirmado en `_124125` (status:changed, 622 capturas browser) |
| `InvoiceByIdInDomain` | `b98519554b2b…` → `f18f1274…` | invoice-autofill (cfdi-attacher) | scan `2026-06-24_122857` (status:changed, 5 capturas browser) |

**Probe puntual al server (antes de editar):** ambos hashes nuevos respondieron HTTP 400 con "Variable ... of required type ... was not provided" (sin "Must provide a query string" ni "PersistedQueryNotFound") → hash existe en el registry de Apollo, servidor intentó ejecutar la query. Hashes válidos.

Deploy `tools/deploy.sh --set 1.7.2 --check invoice-autofill` → **config 1.7.2** + `lastUpdated 2026-06-24T12:50` (commit main `f5ec71d`, gh-pages `00afb0d`). Publicado en vivo (GitHub Pages, polling hasta confirmar `version:1.7.2` en `oviazcan.github.io`).

**Re-validación post-deploy (config 1.7.2): 161 ok / 2 stale / 2 skipped / 0 unknown / 0 auth.** `GetSpec` e `InvoiceByIdInDomain` ya no aparecen stale.

### Pendientes sin reparar

| Operación | Hash viejo | Motivo | Acción |
|---|---|---|---|
| `GetSpecFieldSpec` | `4da5a578…` | **Steelhead dividió la operación** — ya no existe con ese nombre. Ver diagnóstico abajo. | Refactor de spec-migrator (task separada) |
| `GetReceivedOrdersWithReceivedOrderLineItems` | `f3bf00a3…` | Rotó de nuevo; no se capturó en ningún scan de hoy (no se navegó a la pantalla de facturas con el hash-scanner activo) | Correr hash-scanner navegando a pantalla de Facturas/OVs |

### Diagnóstico: GetSpecFieldSpec dividida en varias queries

Steelhead **partió** la operación `GetSpecFieldSpec` en al menos 5 queries nuevas (capturadas en scan `2026-06-24_124125`):

| Query nueva | Hash | Variables | Responde |
|---|---|---|---|
| `GetSpecFieldSpecDetails` | `6e58ad71…` | `{specFieldSpecId}` | `specFieldSpecById.{isGeneric, requiresGeometryType, isExternal, specFieldBySpecFieldId.{id,name,...}, defaultValues}` |
| `GetSpecFieldPartNumbers` | `0e49e0ee…` | `{specFieldSpecId, partNumberUnassignedActive, partNumberSpecFieldParamActive, first, offset, orderBy, searchQuery}` | `pagedData.{totalCount, nodes[].{id,name,conflictingParams,...}}` |
| `GetSpecFieldTreatments` | `5ec54d95…` | `{specFieldSpecId, treatmentUnassignedActive, treatmentSpecFieldParamActive, first, offset, orderBy, searchQuery}` | `pagedData.{totalCount, nodes[]}` |
| `GetSpecFieldWorkOrders` | `5867a197…` | `{specFieldSpecId, partNumberWorkOrderUnassignedActive, partNumberWorkOrderSpecFieldParamActive, first, offset, orderBy, searchQuery}` | `pagedData.{totalCount, nodes[]}` |
| `GetSpecFieldSpecData` | `719539b5…` | `{id}` (id de spec, NO specFieldSpecId) | `specById.{id,name,type,specFieldSpecsBySpecId.nodes[].{id,specFieldId,archivedAt}}` |

**Impacto en spec-migrator.js:** usa `GetSpecFieldSpec` en `spec-migrator.js:46-69` con variable `specFieldSpecId` para obtener en una sola llamada:
1. `searchPartNumbers.{totalCount, nodes[].{id,name}}` — ahora en **`GetSpecFieldPartNumbers`** (mismas variables de paginación)
2. `specFieldSpecById.{defaultValues.nodes[].{id,name,isDefault}, isGeneric, specFieldBySpecFieldId.id}` — ahora en **`GetSpecFieldSpecDetails`** (solo `{specFieldSpecId}`)

**Plan de refactor** (no ejecutar hasta revisión del usuario):
1. Reemplazar la llamada única a `GetSpecFieldSpec` por **dos llamadas paralelas**: `GetSpecFieldSpecDetails` + `GetSpecFieldPartNumbers`.
2. `GetSpecFieldSpecDetails` devuelve `isGeneric` + `specFieldBySpecFieldId.id` + `defaultValues` → mismos campos que antes.
3. `GetSpecFieldPartNumbers` devuelve `pagedData.{totalCount,nodes[].{id,name}}` — cambio de root key: antes era `searchPartNumbers`, ahora `pagedData`. Requiere ajustar spec-migrator.js en el mapeo de la respuesta.
4. Agregar las 2 nuevas keys (+ hashes) a `config.json` antes del refactor.
5. **NO agregar** `GetSpecFieldSpec` viejo a la whitelist — está genuinamente muerto, quitarlo del config en la misma sesión del refactor.

Nota: `GetSpecFieldTreatments` y `GetSpecFieldWorkOrders` cubren los tabs de Treatments y WorkOrders de la misma pantalla; `spec-migrator.js` no los usa (solo lee el tab de PartNumbers). `GetSpecFieldSpecData` (variable `id` de spec, no specFieldSpecId) parece ser el selector inicial de spec → no relevante para el flujo actual de spec-migrator.

## 2026-06-24 13:19 — 1 rotado(s)

- Config version: `1.7.2`
- OK: 162 / 165 · Tiempo: 124.0s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-24.json`

**Rotados:**
- `query GetSpecFieldSpec` (hash `4da5a5785f6a...`)

## 2026-06-24 22:19 — 7 rotado(s)

- Config version: `1.7.12`
- OK: 164 / 173 · Tiempo: 144.6s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-24.json`

**Rotados:**
- `query GetQuoteRelatedData` (hash `572c489092ca...`)
- `query AllPartNumbers` (hash `571d2028b068...`)
- `query CreateEditReceivedOrderDialogQuery` (hash `1625daf1fab9...`)
- `query GetCustomerInfoForReceivedOrder` (hash `efc55dec5cef...`)
- `query WorkOrderDialogQuery` (hash `4d745ead94ba...`)
- `query ProcessesComponentQuery` (hash `e04ec51b9301...`)
- `query ProcessesWithTag` (hash `01c772451a17...`)

## 2026-06-25 — 6 rotado(s) corregidos (scan manual)

**Corrida**: manual (agente de corrección de hashes). Fuente: `~/Downloads/scan_results_2026-06-25_114954.json`.

Los 6 hashes detectados como ROTADOS en el scan del navegador (same-origin, Caso A del playbook):

| Operación | viejo (8 chars) | nuevo (8 chars) | usedBy |
|---|---|---|---|
| `AllPartNumbers` | `571d2028` | `827be681` | bulk-upload, auditor |
| `CreateEditReceivedOrderDialogQuery` | `1625daf1` | `5b01210e` | portal-importer, carga-masiva |
| `GetCustomerInfoForReceivedOrder` | `efc55dec` | `be7c8dbe` | portal-importer |
| `GetPartNumber` | `4f36e940` | `804dd8f7` | bulk-upload, proceso-calculator |
| `ProcessesComponentQuery` | `e04ec51b` | `c6941779` | process-deep-audit, auto-router |
| `ProcessesWithTag` | `01c77245` | `2d83c581` | process-deep-audit, process-canon |

Deploy `tools/deploy.sh "fix(hashes): rotación 6 ops (scan 2026-06-25)" --check load-calculator-modal`: 1.7.12 → **1.7.13** + `lastUpdated 2026-06-25T11:57` (commit main `559b1cd`, gh-pages `64729a3`). Publicado en vivo (GitHub Pages, verificado por polling: `version:1.7.13`).

## 2026-06-25 23:21 — 2 rotado(s)

- Config version: `1.7.16`
- OK: 169 / 173 · Tiempo: 156.6s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-25.json`

**Rotados:**
- `query GetQuoteRelatedData` (hash `572c489092ca...`)
- `query WorkOrderDialogQuery` (hash `4d745ead94ba...`)

## 2026-06-26 11:49 — corrección (1 de 2 rotados resuelto)

**Corrida**: manual (agente de corrección de hashes). Fuente: `~/Downloads/scan_results_2026-06-26_114407.json`. Validación previa: `tools/.hash-validation/2026-06-26.json` (config 1.7.19, 2 stale).

| Operación | viejo (8 chars) | nuevo (8 chars) | usedBy | estado |
|---|---|---|---|---|
| `WorkOrderDialogQuery` | `4d745ead` | `5b7f7153` | wo-mover | ✅ corregido + verificado en server (HTTP 400 `$workOrderId` required → hash existe) |
| `GetQuoteRelatedData` | `572c489` | — | carga-masiva (catalog-fetcher, bulk-upload) | ⏳ **pendiente** — el scan no capturó la operación en vivo; el único hash previo en vivo (`04cc75ea`, jun-1) también está rotado |

Deploy `tools/deploy.sh "fix(hashes): WorkOrderDialogQuery rotó (scan 2026-06-26) → 5b7f7153" --check wo-mover`: 1.7.19 → **1.7.20** + `lastUpdated 2026-06-26T11:49` (commit main `f2924e1`, gh-pages `ab5b35b`). Publicado en vivo (GitHub Pages, verificado por polling: `version:1.7.20`; invariante byte-a-byte OK).

Re-validación post-deploy (config 1.7.20): **OK 170 / 173 · STALE 1** (`GetQuoteRelatedData`) · SKIPPED 2 (whitelist: `CurrentUser`, `GetPurchaseOrder`).

**Pendiente `GetQuoteRelatedData`:** correr el hash-scanner abriendo una **cotización (Quote)** en Steelhead (carga de direcciones/contactos del cliente) para que el front nativo dispare la operación y el scanner capture el hash nuevo. Luego repetir bump+deploy.

## 2026-06-26 11:57 — `GetQuoteRelatedData` resuelto (0 rotados)

Scan nuevo `~/Downloads/scan_results_2026-06-26_115519.json` capturó la operación en vivo (status `changed`, HTTP 200):

| Operación | viejo (8 chars) | nuevo (8 chars) | usedBy | estado |
|---|---|---|---|---|
| `GetQuoteRelatedData` | `572c489` | `02b8cf87` | carga-masiva (catalog-fetcher, bulk-upload) | ✅ corregido + verificado en server (HTTP 400 `$customerId` required → hash existe) |

Deploy `tools/deploy.sh "fix(hashes): GetQuoteRelatedData rotó (scan 2026-06-26) → 02b8cf87" --check bulk-upload`: 1.7.20 → **1.7.21** + `lastUpdated 2026-06-26T11:57` (commit main `402544e` gh-pages). Publicado en vivo (polling: `version:1.7.21`; invariante byte-a-byte OK).

Re-validación final (config 1.7.21): **OK 171 / 173 · STALE 0** · SKIPPED 2 (whitelist: `CurrentUser`, `GetPurchaseOrder`). ✅ **Ambas rotaciones del 2026-06-25 resueltas.**

## 2026-06-26 16:51 — 0 rotado(s) (launchd)

## 2026-06-26 22:20 — 2 rotado(s)

- Config version: `1.7.23`
- OK: 169 / 173 · Tiempo: 177.6s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-26.json`

**Rotados:**
- `query GetPurchaseOrdersDataForBill` (hash `ad098de458c4...`)
- `mutation CreateInventoryTransferEventGroups` (hash `21bf4eb2b1b2...`)

## 2026-06-28 03:19 — 2 rotado(s)

- Config version: `1.7.23`
- OK: 169 / 173 · Tiempo: 172.2s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-28.json`

**Rotados:**
- `query GetPurchaseOrdersDataForBill` (hash `ad098de458c4...`)
- `mutation CreateInventoryTransferEventGroups` (hash `21bf4eb2b1b2...`)

## 2026-06-29 08:27 — 0 rotado(s) (launchd)

## 2026-06-29 14:19 — Reparación: deploy config 1.7.26 (2 rotados re-capturados del scan)

**Corrida**: manual (sesión de la feature `file-uploader` display-image, skill `steelhead-hash-validator`). El usuario pidió corregir de paso los rotados aprovechando el scan de hoy.

**Resultado pre-reparación (config 1.7.25): 169 ok / 2 stale / 2 skipped / 0 unknown / 0 auth** en 102.1s. Resultado `tools/.hash-validation/2026-06-29.json`.

| Operación | viejo → nuevo | usedBy | Fuente del hash nuevo |
|---|---|---|---|
| `GetPurchaseOrdersDataForBill` (query) | `ad098de4…` → `a94f4396…` | bill-autofill | scan `2026-06-29_135728` (`scanResults`, no `apiKnowledge`) |
| `CreateInventoryTransferEventGroups` (mutation) | `21bf4eb2…` → `901d61bf…` | inventory-reset | scan `2026-06-29_135728` (`scanResults`) |

- **Probe puntual al server (antes de editar):** ambos hashes viejos → `"Must provide a query string"` (STALE 1/1); ambos nuevos → HTTP 400 de variables (hash existe en el registry, OK).
- **Discrepancia con launchd:** la entrada `2026-06-29 08:27 — 0 rotado(s) (launchd)` reportó 0 con el **mismo** config 1.7.25; la corrida manual de las 14:00 detectó 2 stale, confirmados con probe. Consistente con flapping/rollout escalonado (canary) del server, como `GetDomain` el 19/22 jun — NO bug del validador. (Estos 2 ya venían reportados stale el 26 y 28 jun, sin reparar hasta hoy.)
- **`AllSensorDashboards` NO se tocó:** el scan trae un hash distinto al de config, pero el validador en vivo lo da **OK** (el server aún acepta el del config; el front migró a otro hash sin rotar el viejo). `sensor-status-autofill` no está roto. Sin cambio — defensa contra falsos positivos del diff scan-vs-config.
- Deploy `tools/deploy.sh --check bill-autofill`: 1.7.25 → **1.7.26** (commit main `3500b8d`, gh-pages `e80fe8c`). Publicado en vivo (GitHub Pages sirve config 1.7.26 con ambos hashes nuevos, verificado por curl).

## 2026-06-29 21:19 — 0 rotado(s) (launchd)

## 2026-06-29 23:30 — 0 rotado(s) (launchd)

## 2026-06-30 22:19 — 2 rotado(s)

- Config version: `1.7.37`
- OK: 172 / 176 · Tiempo: 128.4s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-30.json`

**Rotados:**
- `query InvoiceByIdInDomain` (hash `f18f1274740a...`)
- `query GetVendor` (hash `efb7af012290...`)

## 2026-06-30 23:19 — 2 rotado(s)

- Config version: `1.7.39`
- OK: 175 / 179 · Tiempo: 144.8s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-06-30.json`

**Rotados:**
- `query InvoiceByIdInDomain` (hash `f18f1274740a...`)
- `query GetVendor` (hash `efb7af012290...`)

## 2026-07-01 00:18 — 2 resueltos (fix manual + deploy)

- Rotación detectada el 2026-06-30 en `InvoiceByIdInDomain` (usedBy `cfdi-attacher`) y `GetVendor`.
- Hashes nuevos recuperados del scan `~/Downloads/scan_results_2026-06-30_233100.json`
  (`previousHash` = hash viejo del config en ambos, `status: changed`, `lastHttpStatus: 200`):
  - `InvoiceByIdInDomain`: `f18f1274740a…` → **`5844a41c37db…`**
  - `GetVendor`: `efb7af012290…` → **`87ad05379932…`**
- Deploy `tools/deploy.sh`: 1.7.43 → **1.7.44** (commit main `21e45a5`, gh-pages `340d915`).
  El otro agente había avanzado 1.7.39→1.7.43 con el applet `vale-almacen` (ortogonal, sin tocar hashes).
- Post-deploy: validador `177 ok / 0 stale / 2 skipped` (whitelist `CurrentUser`, `GetPurchaseOrder`), exit 0.
- Safari/iPad: **NO requiere rebundle.** La advertencia de `deploy.sh` (`build-safari.sh --check`) es un falso positivo para cambios de solo-hash: `bridge.js` fetchea `config.json` de gh-pages en runtime y `sa-bootstrap.js` → `SteelheadAPI.init()` re-instala los hashes en caliente (ver `safari/sa-bootstrap.js:5` — "REFRESCA con el config en vivo (hashes que rotaron)"). El bundle solo se rehornea cuando cambia el **código** de un applet (`remote/scripts/`), no cuando solo rotan hashes en `config.json`. Verificado en vivo por el usuario (2026-07-01).

## 2026-07-01 22:00 — 3 rotado(s)

- Config version: `1.7.46`
- OK: 161 / 179 · Tiempo: 2022.5s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-07-01.json`

**Rotados:**
- `query AllCustomers` (hash `66e271f6a8a2...`)
- `query AllSensorDashboards` (hash `432339f25bae...`)
- `query SensorDashboardQuery` (hash `bde56bd609a2...`)

## 2026-07-01 23:19 — 4 rotado(s)

- Config version: `1.7.47`
- OK: 173 / 179 · Tiempo: 140.5s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-07-01.json`

**Rotados:**
- `query Customer` (hash `96b214b5632d...`)
- `query AllCustomers` (hash `66e271f6a8a2...`)
- `query AllSensorDashboards` (hash `432339f25bae...`)
- `query SensorDashboardQuery` (hash `bde56bd609a2...`)

## 2026-07-02 00:55 — 4 "rotado(s)" DIAGNOSTICADOS COMO FALSOS POSITIVOS (whitelist)

- Config version: `1.7.49` · Validador: 173 ok / 4 "stale" / 2 skipped (antes de whitelist).
- Ops marcadas: `Customer`, `AllCustomers`, `AllSensorDashboards`, `SensorDashboardQuery`.
  Todas con reason `Must provide a query string` (3 corridas consecutivas, consistente).

### Diagnóstico: NO hay rotación. Hashes de `config.json` correctos. **No se tocó config ni se deployó.**

Evidencia (investigación 2026-07-02):
1. **Estabilidad histórica**: `AllCustomers`/`AllSensorDashboards`/`SensorDashboardQuery`
   tienen el MISMO hash en los 75 scans desde 2026-05-05 (2 meses). `Customer` estable
   desde 2026-06-25 (`875f…`→`96b2…`, rotación real de ese día). Ningún scan post-alerta
   trae un hash nuevo → no existe hash de reemplazo.
2. **Prueba en vivo (scan `scan_results_2026-07-02_003120.json`, tomado DESPUÉS de la alerta)**:
   las 4 ops ejecutaron exitosamente en el navegador con los MISMOS hashes de config —
   `Customer` scanCount=50 / 655 responseFields, `AllCustomers` scanCount=30 / 489,
   `AllSensorDashboards` 93 responseFields, `SensorDashboardQuery` 147 + variablesSample real.
3. **Probe hash-only externo consistente** (6/6 "Must provide") vs control `GetVendor`
   (6/6 resuelve "Variable $idInDomain…") → no es LRU intermitente.
4. **Root cause**: el validador es un **cliente externo** (Python + `x-steelhead-idp-token`).
   Steelhead responde `Must provide a query string` a clientes que no son el frontend Apollo
   del browser para ciertas ops sensibles a sesión. Nuestros applets corren **in-page**
   (`fetch` `credentials:'include'`, mismo origen) → funcionan. Mismo patrón exacto que
   `CurrentUser` y `GetPurchaseOrder` (ya en whitelist desde 2026-05-23).

### Acciones
- **Whitelist ampliada** (`tools/hash-validator-whitelist.json`): +`Customer`, +`AllCustomers`,
  +`AllSensorDashboards`, +`SensorDashboardQuery` con la evidencia del scan y `verifiedOn:2026-07-02`.
  Post-whitelist el validador da **173 ok / 0 stale / 6 skipped → exit 0**.
  ⚠️ Nota en la entrada de `Customer`: SÍ rota de verdad ocasionalmente — si un scan futuro
  muestra hash DISTINTO con `status:changed`+`lastHttpStatus:200`, es rotación real, quitar de whitelist.
- **Notificación enriquecida**: `tools/notify-stale-hashes.sh` + nuevo `tools/hash-stale-report.py`.
  Ahora el issue/email/bitácora listan, por op rotada, **qué applets truenan** (grep de op citada
  en `remote/scripts/*.js` + `knownOperations.usedBy`) y una sección **"cómo recuperar (acciones en
  el scan)"** que distingue rotación real (`status:changed`+`lastHttpStatus:200`, hash distinto) de
  falso positivo (hash igual + `responseFields`/`scanCount>0` → whitelist, no tocar config).

## 2026-07-02 23:04 — 0 rotado(s) (launchd)

## 2026-07-02 23:19 — 1 rotado(s)

- Config version: `1.7.55`
- OK: 175 / 182 · Tiempo: 137.4s
- Resultado: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-validation/2026-07-02.json`

**Rotados — applets que truenan:**

#### ⚠️ `query GetDomain` · hash `c0c242bcac01…`
- **Applets que truenan:** bill-autofill, invoice-autofill
- **usedBy (config):** bill-autofill
- **Qué hace:** Obtener dominio con customInputs.TipoCambio (array de {fecha, valor}) y currentExchangeRate

## 2026-07-03 00:00 — RESUELTO: rotación `GetDomain`

- **Op:** `query GetDomain` · applets afectados: `bill-autofill`, `invoice-autofill`
- **Hash viejo:** `c0c242bcac011a6e72087bd0d0698dde5cf2fe8b247a51e4eb3b08c36299c866`
- **Hash nuevo:** `86652dafed0174bb91b95e11cf8867ca13fb7303fd211471c221ead70ac8b1e1`
- **Fuente:** `scan_results_2026-07-02_235711.json` (`scanResults.GetDomain.hash`; `previousHash` == hash viejo del config → rotación real confirmada)
- **Deploy:** `config.json` 1.7.55 → 1.7.56 vía `tools/deploy.sh` (commit `9bb7313` main / `160c1d1` gh-pages); invariante gh-pages↔main:remote/ byte-a-byte OK.
- **Bundle Safari:** no requiere rebundle — el bridge refresca `config.json` en runtime (rotación de hash no toca applets del bundle).

## 2026-07-03 08:20 — 0 rotado(s) (launchd)

## 2026-07-03 13:16 — RESUELTO: rotación `AllCustomers` + `Customer` (NO detectada por el validador — whitelist)

- **Síntoma reportado por el operador:** carga masiva traía **0 clientes**.
- **Ops rotadas:** `query AllCustomers` (catalog-fetcher / portal-importer, carga-masiva) y `query Customer` (invoice-autofill, create-order-autofill, weight-quick-entry).
  - **AllCustomers:** viejo `66e271f6a8a2…` → nuevo `8d4dfe69d3050a16ad802015e6d14b6458db5266e62c67a2321d23b440086037` (validado in-page HTTP 200, 80 clientes).
  - **Customer:** viejo `96b214b5632d…` → nuevo `12d69cd18ff3ba1ac2174f2260cfdcfe1de894f9546ca531711a1c4010ebb257`.
- **Cómo se detectó:** el `validate-hashes.py` de esta mañana (08:20) dio **`0 rotado(s)`** porque **ambas ops están en `hash-validator-whitelist.json`** (falsos-positivos session-sensitive verificados el 2026-07-02). La rotación se confirmó **capturando el `sha256Hash` que el frontend envía in-page** (interceptor de `fetch` en la tab de Steelhead) y comparándolo con el config — el método del hash-scanner. El test `400 "Must provide a query string"` in-page **NO discrimina** para estas ops (da 400 aun con el hash viejo whitelisted); la señal fiable es el hash capturado ≠ config.
- **Deploy:** `config.json` 1.7.56 → 1.7.57 vía `tools/deploy.sh` (commit `73e5503` main / `dfb2728` gh-pages); invariante gh-pages↔main:remote/ byte-a-byte OK. También se publicó el **guard de lista vacía** del `catalog-fetcher` (bloquea la descarga si un catálogo crítico viene vacío por hash rotado, en vez de sobrescribir las listas buenas con vacíos al correr `RefrescarListas`). Tests: `tools/test/catalog-fetcher-health.test.js`.
- **Bundle Safari:** no requiere rebundle — el bridge refresca `config.json` en runtime.
- **⚠️ Lección / gap del validador:** **2 de 6 ops whitelisted rotaron el mismo día y el validador las skipeó → reportó `0 rotado`.** La whitelist enmascara rotaciones reales de ops session-sensitive. **Pendiente:** que el validador re-verifique periódicamente las whitelisted vía hash-scanner (no puede desde Python) o emita un recordatorio para escanearlas. Las 4 restantes (`CurrentUser`, `GetPurchaseOrder`, `AllSensorDashboards`, `SensorDashboardQuery`) quedaron **sin verificar** esta sesión (sus applets no reportan fallas; probablemente vigentes).

## 2026-07-03 17:16 — 0 rotado(s) (launchd)

## 2026-07-03 19:48 — 0 rotado(s) (launchd)
