# Mapeo mutations → entidad (priorización de centinelas, Fase C)

Análisis del `config.steelhead.hashes.mutations` (69 mutations) para priorizar **qué centinelas sembrar**. Cada centinela de una entidad cubre TODAS las mutations reversibles de esa entidad → sembrar por entidad, empezando por las de mayor cobertura.

## Resumen
- **58 reversibles** (`Save/Update/Archive/Set/Create/Add`) → cubribles por centinela v1.
- **11 no cubiertas** por v1 → **escalan** por correo (seguro): 5 destructivas (`Delete/Remove`) + 6 de prefijo no estándar.

## Reversibles agrupadas por entidad (orden = prioridad de sembrado)

| Prioridad | Entidad (centinela) | # muts | Ejemplos clave |
|---|---|---|---|
| 1 | **PartNumber** | **12** | SavePartNumber, UpdatePartNumber, AddParamsToPartNumber, ArchivePartNumberSpecAndParams |
| 2 | **ReceivedOrder** | 6 | CreateReceivedOrder, SaveReceivedOrderLinesAndItems, SaveReceivedOrderPartTransforms |
| 3 | **Quote** | 5 | CreateQuote, SaveQuoteLines, UpdateQuote, SaveManyPNP_Quote |
| 4 | **MaintenanceEvent** | 4 | CreateMaintenanceEvent, UpdateMaintenanceEvent |
| 5 | **InventoryItem** | 3 | UpdateInventoryItemInputs, CreateInventoryItemUnitConversion |
| 6 | **WorkOrder** | 3 | CreateUpdateWorkOrdersChecked, AddPartsToWorkOrders, CreateWorkOrderLabel |
| 7 | Station | 2 | CreateStationInputSchema, UpdateStationInputs |
| 7 | Invoice | 2 | CreateInvoiceEmailLog, CreateInvoicePdf |
| 7 | Report | 2 | ArchiveReport, CreateUpdateReportWithPermissions |
| 7 | MaintenanceNode | 2 | CreateMaintenanceNodeEvent, UpdateMaintenanceNodeEvent |
| 7 | ProcessNode | 2 | CreateProcessNode, UpdateProcessNode |
| 8 | Route, Spec, User, InventoryBatch, Inventory, Bill, Part, PartsTransfer | 1 c/u | — |

**ROI:** los **6 primeros** centinelas (PartNumber…WorkOrder) cubren **33 de 58** (57%). Los 11 siguientes (entidades con 2) suman +10 → 43/58 (74%). El resto son colas de 1.

## Reversibles sin entidad clara (7 — requieren clasificación manual)
Estas son reversibles por prefijo pero su entidad no salió del heurístico de nombre; hay que asignarles entidad al sembrar:
- `CreateManySensorMeasurements` → **Sensor / SensorMeasurement**
- `UpdateSensorDashboardMember` → **SensorDashboard**
- `CreateReceiverChecked`, `UpdateReceiver` → **Receiver**
- `SaveGeometryType` → **GeometryType**
- `SaveManyPNP_PN`, `SetPNPricesDefault` → **PartNumberPrice** (relacionadas a PN)

## No cubiertas por v1 (11 — escalan por correo, seguro)
- **Destructivas (5)** — `Delete*/Remove*`: escalan por diseño (no hay re-archivado seguro). Captura manual si rotan.
- **Prefijo no estándar (6)** — mutations que no empiezan por un verbo reconocido → `no-auto` → escalan. Revisar caso por caso si alguna es reversible con otro nombre.

## Recomendación de arranque
Sembrar en este orden y medir: **PartNumber → ReceivedOrder → Quote → MaintenanceEvent → InventoryItem → WorkOrder**. Con esos 6 objetos canario (bien archivados, marcados `__SA_SENTINEL__`, sin dependencias) Fase C autocorregiría el 57% de las mutations; el resto escala sin riesgo hasta sembrar más.

> El ciclo por entidad solo corre si esa mutation **rotó** (lo marca el validator). Sembrar un centinela no dispara nada por sí mismo — solo habilita la captura segura cuando haga falta.
