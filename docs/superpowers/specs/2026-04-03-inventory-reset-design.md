# Reinicio de Inventario — Spec

## Objetivo

Nueva app en la extension que permite:
1. Seleccionar tipos de inventario
2. Archivar todos los lotes activos con cantidad restante de esos tipos
3. Crear nuevos lotes desde un CSV para "arrancar de cero"

## Flujo

### Fase 1 — Seleccion de tipos de inventario

- Query `AllInventoryTypes` (hash: `c8df929b...`) para obtener todos los tipos
- UI: checkboxes con nombre de cada tipo, pre-seleccionados: Materia Prima, Materia Prima P, Metales
- Boton para subir CSV (NAME, CANTIDAD) — se parsea aqui
- El usuario confirma para iniciar

### Fase 2 — Archivado masivo

Para cada tipo seleccionado:
1. Paginar items con `SearchInventoryTypeItems` (hash: `83964a4a...`)
   - Variables: `{ inventoryTypeId, searchString: "", offset, first: 50, orderBy: ["ID_ASC"], fetch*: false }`
2. Para cada item, buscar lotes activos con `SearchInventoryItemBatches` (hash: `d0c8079c...`)
   - Variables: `{ id: itemId, archivedOption: "NO", offset: 0, notCompleted: true, first: 100, orderBy: ["ID_ASC"] }`
3. Filtrar lotes con `totalRemainingMicroQuantity > "0"` (viene como string)
4. Archivar con `UpdateInventoryBatchesChecked` (hash: `4981b6dc...`)
   - Variables: `{ batches: [{ id: batchId, archive: true }] }`
   - Batching: hasta 20 lotes por llamada

### Fase 3 — Carga inicial desde CSV

1. Parsear CSV: columnas NAME y CANTIDAD
2. Match por nombre exacto (case-insensitive, trim) contra items cargados en Fase 2
3. Reportar no-matches en UI antes de continuar (no bloquea ejecucion)
4. Buscar locationId de "Ecoplating.N3.A3.RJ" via `SearchLocationsOnPath` (hash: pendiente de config)
   - Variables: `{ path: "", searchText: "%RJ%", ... }`
   - Cachear resultado — una sola llamada
5. Obtener `defaultBatchStatusId` del tipo de inventario (viene en `CreateEditInventoryBatchDialogQuery` response)
6. Crear lotes con `CreateInventoryTransferEventGroups` (hash: `21bf4eb2...`)
   - Un lote por item, secuencial para evitar rate limiting
   - Payload por lote:
     ```json
     {
       "inventoryTransferEventGroups": [{
         "inventoryTransferEvents": [{
           "debitAccounts": {
             "createInventoryBatch": {
               "name": "Carga Inicial",
               "inventoryItemId": <itemId>,
               "descriptionMarkdown": "Carga inicial desde: <nombre_archivo.csv>",
               "statusId": <defaultBatchStatusId>,
               "customInputs": {},
               "inputSchemaId": <del inventoryType o generic>
             },
             "accounts": [{
               "microQuantity": <cantidad * 1000000>,
               "locationId": <locationId de RJ>
             }]
           },
           "creditAccounts": {
             "accounts": [{ "microQuantity": <cantidad * 1000000> }]
           },
           "transferType": "CREATE"
         }]
       }]
     }
     ```
   - `unitCostMicroDollars`: omitido; si la API rechaza, retry con valor `0`
   - `vendorId`: omitido
   - `expiration`: omitido

## Arquitectura

### Archivos nuevos
- `remote/scripts/inventory-reset.js` — logica principal (IIFE `InventoryReset`)

### Archivos modificados
- `remote/config.json` — nueva app entry + hashes de inventario
- `extension/background.js` — handler para `run-inventory-reset` + registro de global en inject

### Hashes a agregar en config.json

```
queries:
  AllInventoryTypes: c8df929bb155369cf5ee7c7939697cde53a939b644b9bd220bde662522537d4d
  SearchInventoryTypeItems: 83964a4ab84b6fae39d781127dd7b08d0a0dd852a3e3f85a812bbeda627a6c9a
  SearchInventoryItemBatches: d0c8079c928e46305bb3cbd8e10642b195e7bbc7b5417e7f88960912c229f926
  AllInventoryBatchStatuses: 37ef2266975d34d4318858553f68e56638c25ebff9bb4f16d080589c213cef09
  CreateEditInventoryBatchDialogQuery: 25c91344eb1e8c12c47da2e65dea36b743a5af2f614fb514b4f12e84894f5b81
  SearchLocationsOnPath: 65e13310e4b971aba5dce7a130c6e9259f9e1f556b79543ca5a1e414f593e29f

mutations:
  UpdateInventoryBatchesChecked: 4981b6dcbb240d5f9ab763a3b0cedde1fc5bd22c4735e8a33fc717b1ef5e7ea0
  CreateInventoryTransferEventGroups: 21bf4eb2b1b2ba6c95325a9e15ceb0a51c49715df020517b579f20ad634bb8d9
```

### UI

Modal inyectado en la pagina de Steelhead (mismo patron que archiver/auditor):
- Paso 1: Checkboxes de tipos + file picker para CSV
- Paso 2: Progreso en tiempo real (fase archivado + fase creacion)
- Paso 3: Resumen final con conteos y lista de errores/no-matches

### Manejo de errores

- Items del CSV sin match: listar en resumen, no detener
- Fallos de API: registrar error por item, continuar con siguiente
- Resumen final: lotes archivados, lotes creados, items sin match, errores

### Resultado final

Objeto con:
```json
{
  "archived": { "total": N, "errors": [] },
  "created": { "total": N, "errors": [], "noMatch": ["item1", "item2"] },
  "csvFilename": "INVENTARIO 02 ABRIL 2026.csv"
}
```
