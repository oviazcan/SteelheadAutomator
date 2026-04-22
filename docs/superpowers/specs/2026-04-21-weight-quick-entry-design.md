# Weight Quick Entry — Spec de diseño

## Estado: Implementado (v0.4.60, 2026-04-21)

## Contexto

En el módulo de recibo de Steelhead (Receiving > Customer Parts > RECEIVE), el proceso de registrar el peso del cliente por lote requiere múltiples clicks: seleccionar unidad KGM, abrir el modal "Define Units", cambiar a pestaña "Measure", ingresar peso, guardar. Esto se repite por cada línea de recibo.

Esta funcionalidad elimina esa fricción inyectando un campo de peso directamente en el modal de recibo, ejecutando la medición automáticamente al salir del campo.

## Objetivo

Inyectar un campo opcional "Peso cliente KG" (o "LB" según preferencia del cliente) debajo del campo Count en cada línea del modal "Receive Parts From Customer", para que el operador capture el peso del lote sin abrir el modal "Define Units". La medición se ejecuta eager (al blur/Tab) y/o al presionar SAVE. Ambas conversiones (KGM + LBR) se registran siempre, independientemente de qué campo se muestre.

## Arquitectura

### Script: `remote/scripts/weight-quick-entry.js`

Patrón: IIFE → `window.WeightQuickEntry` con auto-init
Dependencia: `SteelheadAPI`
Auto-inject: `true` (se activa automáticamente en `app.gosteelhead.com`)

### App en config.json

```json
{
  "id": "weight-quick-entry",
  "name": "Peso Rápido",
  "subtitle": "Registra peso KG/LB desde el modal de recibo",
  "icon": "⚖️",
  "category": "Recibo",
  "scripts": ["scripts/steelhead-api.js", "scripts/weight-quick-entry.js"],
  "autoInject": true,
  "actions": []
}
```

### Hashes GraphQL en config.json

```json
"mutations": {
  "CreateInventoryItemUnitConversion": "769411466c537c059cf6fc1721e116dc42ff1d88e3a72879cc94444329a1f334",
  "UpdateInventoryItemUnitConversion": "ffc8db6cd8edaa9355b904fac38f8e5fc116ce1d597f076026c38ef09420a16c"
},
"queries": {
  "GetAvailableUnits": "405368babb953708532627a930e5ea1a1ca21e5518a5f0f4d8cd0757880c43c0",
  "CustomerSearchByName": "c06fb4c3b770a89c02d00ac51b92be6e1efe98bf5f6f5caccfe753f0570e6f02",
  "Customer": "875fcfec140fa7e4a756d367cfe8c6868ff2eca8f396a97540638493649d317f"
}
```

### Constantes de dominio

- `domain.unitIds.KGM`: 3969
- `domain.unitIds.LBR`: 3972
- `domain.conversions.KGM_TO_LBR`: 2.20462

## Detección de preferencia KG/LB por cliente

### Flujo

1. Extraer nombre del cliente del dropdown "Customer:"/"Cliente:" en el modal
2. `CustomerSearchByName` → obtener `idInDomain`
3. `Customer(idInDomain)` → obtener `customInputs`
4. Buscar `DatosLogisticos.UnidadMedidaPeso === true` → mostrar campo LB; de lo contrario, KG

### Particularidades resueltas

- **Nombre con ID suffix**: el dropdown muestra "WIELAND METAL SERVICES (#8)" → regex `\s*\(#\d+\).*` strip el sufijo antes de buscar
- **Avatar en singleValue**: el dropdown react-select incluye un avatar "W" → `extractCustomerName` clona el nodo y remueve elementos `[class*="avatar"]`, SVG, IMG antes de leer `textContent`
- **Timing**: cuando el usuario selecciona un PN antes del cliente, Steelhead auto-llena el cliente después. `resolveCustomerPreference` programa un retry a 800ms si `lastCustomerId` existe pero el nombre aún no está en el DOM
- **Cambio de cliente**: al detectar un `customerId` nuevo en requests GraphQL, se resetea `customerLbsResolved` y se re-resuelve. Si React destruyó los containers inyectados, `updateFieldUnits` los re-inyecta via `processExistingLines`
- **`customerLbsResolved`**: solo se marca `true` tras resolución exitosa (encontró `customInputs` o confirmó que el cliente no las tiene). Si falla la extracción de nombre, queda `false` para reintentar

### Queries utilizadas

- `CustomerSearchByName({ nameLike: '%nombre%', orderBy: ['NAME_ASC'] })` → `nodes[].{name, idInDomain}`
- `Customer({ idInDomain: Int!, includeAccountingFields: false })` → `customerByIdInDomain.customInputs`
  - `customInputs` es un objeto anidado: `{ DatosLogisticos: { UnidadMedidaPeso: true/false, ... }, ... }`
  - `GetCustomerInfoForReceivedOrder` NO devuelve `customInputs` (no sirve para este caso)

## Flujo de detección e inyección

### 1. MutationObserver

Detecta la vista "Receive Parts From Customer" / "Recibir piezas del cliente" observando `document.body` con `{ childList: true, subtree: true }`. Identifica el modal buscando headings (h1-h6, MuiTypography) que matcheen el regex.

### 2. Detección de líneas

Busca la tabla MUI, identifica la columna "Quantity"/"Cantidad" por el header del `<thead>`, e inyecta en la celda correspondiente de cada `<tbody> tr`. El observer detecta:
- Líneas existentes al abrir el modal
- Líneas nuevas añadidas con "+ ADD PART" (via MutationObserver en el modal)

### 3. Condición de inyección

Solo inyectar campo de peso cuando el campo Unit está vacío o muestra "Count"/"Conteo". Si el usuario cambia Unit a KGM u otra unidad, ocultar el campo inyectado (Steelhead ya muestra Gross Qty nativo). Un `MutationObserver` por celda maneja el show/hide dinámico.

### 4. DOM inyectado

Un solo campo (KG o LB según preferencia del cliente):

```
┌─────────────────────────────────────────┐
│ ⚡ Peso rápido (KG)  (SteelheadAutomator) │
│                                           │
│ Peso cliente KG: [____]                   │
│                                           │
│ Tab para registrar · Registra KG + LB     │
│ automáticamente                           │
└───────────────────────────────────────────┘
```

Estados visuales:
- **Vacío**: borde gris punteado, sin indicador
- **Pendiente**: borde rojo punteado `#e74c3c`, ícono ⏳
- **Ejecutando**: borde naranja, opacity 0.7, pointer-events none
- **Registrado**: borde verde sólido `#4CAF50`, ícono ✅, muestra factor calculado (ej: "0.25 kg/pz · 0.551 lb/pz"), campo readonly
- **Error**: borde rojo sólido, mensaje de error, campo editable para reintentar

## Flujo de ejecución de medición

### Trigger 1: Blur/Tab del campo de peso (eager)

1. Usuario llena "Peso KG" con `25` (Count es `100`)
2. Al hacer Tab o blur:
   a. Resolver `inventoryItemId` (3 estrategias: link href → texto PN en cache → único en cache)
   b. Si no resuelve: fallback `GetPartNumber({ id: pnId })`
3. Calcular factores:
   - Si campo es KG: `factorKGM = peso / count`, `factorLBR = (peso × 2.20462) / count`
   - Si campo es LB: `weightKG = peso / 2.20462`, luego factores normales
4. `GetAvailableUnits({ inventoryItemId })` → buscar conversiones existentes
5. Para cada unidad (KGM, LBR): upsert (Create o Update)
6. Actualizar UI a estado ✅

### Trigger 2: Interceptar SAVE nativo

Intercepta clicks en botones SAVE/GUARDAR del footer del modal. Busca líneas con peso pendiente, ejecuta mediciones en paralelo (`Promise.allSettled`), luego permite que el SAVE nativo continúe (incluso si alguna medición falla).

### Fetch interceptor

Monkey-patch de `window.fetch` para:
1. Cachear `inventoryItemId` de respuestas `ReceivingPartsPartNumbersQuery` (por `pnId` y por string PN uppercase)
2. Detectar `customerId` en variables de cualquier request → trigger `resolveCustomerPreference`
3. Tras `ReceivingPartsPartNumbersQuery`, intentar resolver preferencia si aún no está resuelta

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `remote/scripts/weight-quick-entry.js` | Nuevo — script principal (~540 líneas) |
| `remote/config.json` | App, hashes (5), knownOperations (5), domain constants |
| `extension/background.js` | Global mapping `'scripts/weight-quick-entry.js': 'WeightQuickEntry'` |
| `extension/content.js` | Comunicar estado enabled via `dataset.saWeightQuickEntryEnabled` |

## Lecciones aprendidas (bugs resueltos durante implementación)

1. **React-select no usa `<a>` tags**: el modal de Receive Parts usa react-select para PNs — sin links con href. Resuelto con multi-strategy `resolveInventoryItemId`
2. **IDs de GraphQL son strings**: `typeof id === 'number'` falla. Usar string prefix filtering
3. **`Customer` query necesita `idInDomain`**: NO es lo mismo que `id` (interno). Flujo: `CustomerSearchByName` → `idInDomain` → `Customer`
4. **`GetCustomerInfoForReceivedOrder` sin `customInputs`**: la persisted query no incluye ese campo
5. **Campo `UnidadMedidaPeso`**: el nombre en API no contiene "lbs" ni "usar" — es `DatosLogisticos.UnidadMedidaPeso`
6. **Avatar "W" en singleValue**: `textContent` concatena avatar + nombre → "WWIELAND". Clonar y strip avatars
7. **PN capturado como nombre de cliente**: buscar singleValue solo junto al label "Customer:"/"Cliente:"
8. **React destruye containers al cambiar cliente**: `updateFieldUnits` limpia `lineStates` y re-inyecta
9. **Timing de auto-fill**: cuando PN se selecciona antes del cliente, retry a 800ms
