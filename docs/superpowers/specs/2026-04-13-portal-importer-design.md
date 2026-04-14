# Portal Importer — XLS de portales de clientes + refactor OV operations

## Contexto

Además de PDFs de OC, los clientes tienen portales (ej. Hubbell) que exportan layouts XLS con múltiples POs en un solo archivo. Es más rápido y confiable para algunos casos. Este feature agrega un nuevo applet que procesa esos XLS con detección automática de layout, modo single (validar una OV específica) y modo bulk (audit table para procesar varias de golpe).

Aprovechamos la ocasión para refactorizar el PO Comparator: extraer las operaciones de OV a un módulo compartido (`ov-operations.js`) consumido por ambos applets. El refactor se hace ahora porque el PO Comparator aún no se ha probado en producción; probarlo bajo la arquitectura final evita pruebas duplicadas.

## Arquitectura de archivos

```
remote/scripts/
├── steelhead-api.js          (sin cambios)
├── claude-api.js             (sin cambios)
├── ov-operations.js          NUEVO módulo compartido
├── po-comparator.js          REFACTOR: consume OVOperations
├── portal-importer.js        NUEVO applet
└── lib/xlsx.full.min.js      ya existe, se reutiliza
```

`ov-operations.js` expone `window.OVOperations`. Ambos applets lo declaran en su lista `scripts` en `config.json`. Se carga antes de los applets consumidores.

## Categorías en popup

Separar la categoría actual `Inventario & Facturación` en dos:

- **Inventario:** `inventory-reset`
- **Facturación:** `po-comparator`, `cfdi-attacher`, `portal-importer`

## Visor paralelo del archivo fuente

Todos los modales del flujo (preview, candidatos, wizard, comparación, audit table) incluyen un botón flotante **"Ver archivo fuente"** en la esquina superior derecha que abre el archivo original en una ventana emergente.

**Para PDF:** conversión a blob URL, abierto con `window.open` posicionado a la derecha. Chrome renderiza el PDF nativamente.

**Para XLS:** se genera una tabla HTML con los datos parseados, con filas del mismo PO resaltadas con el mismo tinte de fondo y header sticky. Se abre como data URL.

**Persistencia:** la referencia al window se guarda en el estado del applet (ej. `state.sourceFileWindow`). Si el usuario cierra la ventana y vuelve a pulsar el botón, se reabre.

Helper `addSourceFileButton(modal, file, parsedData)` en `ov-operations.js`, reutilizable desde cualquier modal.

## Módulo compartido ov-operations.js

### Funciones públicas en `window.OVOperations`

```
findCandidateOVs(sourceData, customerId)              → [candidates]
showCandidateSelector(candidates, sourceData)         → {action, candidate}|null
uploadAndAttachFile(file, receivedOrderId)            → void
adoptExistingOV(candidate, sourceData, file)          → ovId
fetchCreationData(customerId)                         → creationData
showCreationWizard(sourceData, creationData, custId)  → formData|null
resolvePartNumber(pnName, customerId)                 → {partNumberId, partNumberPriceId, suggestion?}|null
createNewOV(formData, sourceData, file)               → ovId
showNoMatchOptions(sourceData)                        → {action, orderId}|null
showSuggestionsModal(suggestions)                     → [appliedSuggestions]
addSourceFileButton(modal, file, parsedData)          → void
```

### Cambios al extraer

**`uploadAndAttachPDF` se renombra a `uploadAndAttachFile`** — el flujo `/api/files` → `CreateUserFile` → `CreateReceivedOrderUserFile` no depende del tipo de archivo.

**`resolvePartNumber` extraído** como helper reutilizable. Recibe `pnName` + `customerId`, devuelve `{partNumberId, partNumberPriceId}` para match exacto, o `{suggestion: {currentName, suggestedName, partNumberId}}` si solo hay match fuzzy.

**Shape unificado `sourceData`** en lugar de `pdfData`: `{poNumber, customer, currency, lines, sourceType: 'pdf'|'xls', fileName}`. Todas las UIs reciben este shape.

### Refactor en po-comparator.js

- Quita funciones movidas (findCandidateOVs, showCandidateSelector, uploadAndAttachPDF, adoptExistingOV, fetchCreationData, showCreationWizard, createNewOV, showNoMatchOptions).
- Llama a `window.OVOperations.xxx` en su lugar.
- Adapta el objeto `pdfData` a `sourceData` agregando `sourceType: 'pdf'` y `fileName`.
- Reduce de ~2000 líneas a ~1200.

## Layout detection

Cada layout se define en `config.json` bajo `portalLayouts`:

```json
"portalLayouts": {
  "hubbell": {
    "name": "Hubbell Portal",
    "detection": {
      "requiredColumns": [
        "number", "status", "lineItem.itemNumber",
        "lineItem.materialCodeBuyer", "lineItem.materialDescription",
        "lineItem.netPrice", "lineItem.priceUnit",
        "lineItem.targetQuantity", "lineItem.schedule.deliveryDate"
      ],
      "minMatchRatio": 0.9
    },
    "mapping": {
      "poNumber": "number",
      "status": "status",
      "customer": "customerAddressName",
      "currency": "currency",
      "date": "date",
      "lineNumber": "lineItem.itemNumber",
      "buyerCode": "lineItem.materialCodeBuyer",
      "description": "lineItem.materialDescription",
      "netPrice": "lineItem.netPrice",
      "priceUnit": "lineItem.priceUnit",
      "quantity": "lineItem.targetQuantity",
      "deliveryDate": "lineItem.schedule.deliveryDate",
      "unit": "lineItem.unit"
    },
    "pnExtractor": {
      "type": "regex",
      "source": "description",
      "patterns": [
        "(?:Catalog|CATALOGO|CAT)\\s*[:=]\\s*(\\S+)",
        "(?:Material\\s*Number|MATERIAL)\\s*[:=]\\s*(\\S+)"
      ]
    },
    "statusFilter": { "activeValues": ["Nuevo"] },
    "unitPriceFormula": "netPrice / priceUnit"
  }
}
```

### Flujo de detección

1. Parseo del XLS con SheetJS
2. Extracción de headers de la primera fila
3. Para cada layout en `portalLayouts`: calcular `matched / requiredColumns.length`; el que supere `minMatchRatio` gana
4. Modal de confirmación: "Detectamos layout **Hubbell Portal**. ¿Es correcto? [Sí, procesar] [No, usar detección con Claude]"
5. Si no hay layout o usuario rechaza → Claude infiere el mapping con headers + 3-5 filas de muestra; resultado se muestra para confirmación antes de procesar

## Mapping table buyer code → PN Steelhead

Almacenada en `chrome.storage.local` con clave `sa_pn_mapping`:

```json
{
  "185166-hubbell": {
    "50077184": "KSU31P4",
    "02104459": "YA2C2TC38P1"
  }
}
```

**Key format:** `{customerId}-{layoutId}`. Permite que el mismo buyer code apunte a distintos PNs por cliente/layout.

### Resolución por línea

Para cada línea del XLS:

1. **Cache hit:** buscar en mapping table por `{customerId}-{layoutId}` → `buyerCode`. Si existe, usar ese PN.
2. **Extractor del layout:** aplicar regex o extractor Claude definido en el layout sobre la descripción.
3. **Fallback Claude** si el regex no extrae nada (solo si el layout lo permite).
4. **Resolver en Steelhead:** `resolvePartNumber(extractedPN, customerId)`.
5. **Guardar en mapping table** tras éxito para reutilizar.

### UI para gestionar mapping table

Sub-modal "Ver mapeos guardados" en el portal importer. Lista por cliente/layout con opción editar o borrar entradas.

## Fuzzy match + sugerencia de corrección de PN

Durante `resolvePartNumber`, después de no encontrar match exacto:

1. **Normalización agresiva:** quitar guiones, espacios, puntos; comparar lowercase.
2. Si el PN normalizado del cliente matchea un PN existente → `suggestion` en lugar de match directo.

### Guardrails

- Solo sugerir, nunca renombrar sin confirmación.
- No sugerir si el match normalizado es ambiguo (>1 PN en Steelhead produce la misma forma normalizada) — marcar para revisión manual.
- Skip automático si el PN normalizado del cliente tiene < 4 caracteres — evita falsos positivos con nombres cortos.

### UI de sugerencias

Al terminar el batch de resolución, modal con lista de sugerencias:

```
Se encontraron 3 PNs con variaciones menores.
Corregirlos en Steelhead evita futuras discrepancias.

Cliente dice:    KSU31P4
Steelhead tiene: KSU-31-P4  (PN #3028747)
[ ] Renombrar en Steelhead a "KSU31P4"

Cliente dice:    YA2C2TC38P1
Steelhead tiene: YA2C2TC38-P1
[ ] Renombrar en Steelhead a "YA2C2TC38P1"

[Saltar todas] [Aplicar seleccionadas]
```

### Aplicación

Al aplicar las seleccionadas, `UpdatePartNumber` con `{id, name: newName}` por cada una.

### Posición en el flujo

- **Single:** se dispara durante creación o adopción, antes de agregar líneas.
- **Bulk:** se acumulan todas las sugerencias de todos los POs y se resuelven en un solo modal al inicio del batch.

## Portal Importer UI

### Entrada

Popup → "Importador de Portales" → filepicker `.xls, .xlsx`.

### Flujo inicial

1. Parseo con SheetJS
2. Detección de layout + confirmación (o fallback a Claude)
3. Agrupación por `poNumber`
4. Modal selector de modo:
   - **Validar una OV específica** (single)
   - **Auditoría en batch** (bulk)

### Modo single

Lista de POs del archivo con filtro de status (default solo "Nuevo"). Al elegir uno:

1. Se construye `sourceData` unificado para ese PO
2. Se delega al flujo del PO Comparator (search → candidates → adopt/create → comparison)
3. Botón "Ver archivo fuente" muestra el XLS filtrado a ese PO

### Modo bulk — Audit table

| PO | Líneas | Total | Estado Steelhead | Acción |
|----|--------|-------|------------------|--------|
| 4507361313 | 20 | $12k | Existe (OV #1064521) | Skip |
| 4507361450 | 8 | $3k | Candidata: OV "PENDIENTE" | Adoptar |
| 4507361512 | 15 | $8k | No existe | Crear |
| 4507361600 | 5 | $2k | No existe | Skip |

### Acciones por fila

Dropdown: `Skip`, `Crear`, `Adoptar candidata`, `Validar manualmente` (pausa el bulk y abre flujo single).

### Defaults inteligentes

- **Existe:** default `Skip`
- **Candidata detectada:** default `Adoptar candidata`
- **No existe:** default `Crear`

### Ejecución bulk

1. **Pre-check:** resolver todos los PNs de todos los POs seleccionados → modal de sugerencias
2. Por cada PO:
   - `Crear`: usa defaults del cliente sin wizard
   - `Adoptar`: rename + attach CSV filtrado
   - `Validar manualmente`: pausa, abre flujo single, al terminar continúa
3. Progress bar con contador
4. Resumen final con enlaces a las OVs creadas/adoptadas y reporte de errores

### Attachment en bulk

Para cada PO procesado, se genera un CSV filtrado con solo las líneas de ese PO y se adjunta a la OV. Nombre: `{poNumber}-{originalFilename}.csv`. Evita adjuntar el XLS multi-PO completo a cada OV.

## Hashes y config

### Hashes

Solo se usa `UpdatePartNumber` para las sugerencias de corrección — ya existe en `config.json`. No se agregan hashes nuevos.

### config.json cambios

- Sección nueva `portalLayouts` con definición de Hubbell
- Nuevo app entry `portal-importer`
- Categorías separadas: `inventory-reset` a "Inventario"; `po-comparator`, `cfdi-attacher`, `portal-importer` a "Facturación"

### Storage

- `chrome.storage.local` clave `sa_pn_mapping` para mapping table persistente

## Estimación de cambios

| Archivo | Tipo | Delta |
|---------|------|-------|
| `config.json` | Modify | +~80 líneas |
| `ov-operations.js` | Create | +~500 líneas |
| `portal-importer.js` | Create | +~700 líneas |
| `po-comparator.js` | Modify | -~800 líneas (refactor) |
| `extension/popup.js` | Verify | Probablemente sin cambios |
