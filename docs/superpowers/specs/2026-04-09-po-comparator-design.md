# Validador OC vs OV — Design Spec

**Fecha:** 2026-04-09
**Applet:** PO Comparator (Comparador de Orden de Compra vs Orden de Venta)

## Contexto

Cuando Ecoplating va a facturar, quien factura necesita verificar que la Orden de Venta (OV) en Steelhead coincida con la Orden de Compra (OC) del cliente. Hoy este proceso es manual: abrir el PDF, abrir la OV, comparar línea por línea. Los errores más comunes son precios incorrectos, cantidades que no coinciden, líneas faltantes, y órdenes de líneas desordenadas. Cuando hay discrepancias, el área de facturación debe notificar a ingeniería (precios), servicio al cliente (OV), o al cliente mismo — pero no corregir directamente, ya que la corrección es responsabilidad de otras áreas.

Adicionalmente, al recibir material hay reportes de discrepancias en los batches de recibo que sirven como referencia durante la validación.

## Terminología Steelhead

- **ReceivedOrder** = Orden de Venta (OV) / Sales Order
- **ReceivedOrderLine** = Línea de la OV
- **ReceivedOrderLineItem (ROLI)** = Item dentro de una línea
- **InventoryBatch** = Batch de recibo (contiene reportes de discrepancia)

## Arquitectura

Nuevo applet dentro de SteelheadAutomator siguiendo la arquitectura existente:
- Script remoto: `remote/scripts/po-comparator.js`
- Entrada en config.json como nuevo app con sus acciones
- Handler en `background.js` para routing de mensajes
- Llamada directa a Claude API desde la extensión (API key en `chrome.storage.local`)

## Hashes nuevos requeridos

Agregar a `remote/config.json` bajo `steelhead.hashes`:

### Queries
| Operación | Hash |
|---|---|
| ActiveReceivedOrders | `4f06f3cb1ba4eabb9c044512b0e54fc8cd29a9630c6004065d38e103aec54b1d` |
| GetReceivedOrder | `c8b31fbcbc14cec18414fb7b9523c4771432279779ee85693cb0d4c2c151e4f7` |
| GetReceivedOrderLine | `1ee61cc2d81d34051b6ebc1c8ec428c1a9565da11afba993475a863599e81156` |
| GetReceivedOrderDocuments | `c2df1330d49c30a52ac64fd5d7ad345f3f2d2b30411315e3311acd7ddba80cdc` |
| RouteReceivedOrders | `fc42311d93a683bec906253aa2cc54ae61931217ff6abf20d2bc335cb55c26d4` |
| CheckDuplicatePO | `94e659bf6eea8d493f8ea67f950fd38371a5cb680d2622145d5df9dc63583b85` |
| GetReceivedOrderCosts | `f7906dc53bcd269dc1d589646a12aa206e83421f316b9197796dc68e646c63d8` |
| ReceivingBatchesQuery | `499a8e1578fc09e785ecb7e6f132520bd6b8ac701e2f70e45e2b89484f0d89c9` |
| GetInventoryBatch | `c69e8870f297c6f93b546ec127c037f7c406fdc5f79afa60a30cc3e839ede041` |
| EmailCustomerContactsByCustomerIds | `6e377769aa06e55915c528c10e2c2f92662a78fdc34ae799610d489abaf983db` |
| GetEmailDefaultByTypeAndSubType | `345b2a71f09fa03768c275cb55267bc6736fefb4e9050ccb668518f61e7d9ca9` |
| GetUserEmailRecipients | `41a4ef4c78acc01384d9932c92721e4446d02118ef6b33429f3eaad2f9818888` |

### Mutations
| Operación | Hash |
|---|---|
| SaveReceivedOrderLinesAndItems | `89c3342878ac89d561a7d4d5dedcd508bb25dcfa1fcf6573b59a134fd32b9bb6` |
| UpdateReceivedOrder | `50bfb5884c167407ad9a8417962da0a56708d8fde031fd0da31893c6eddafe8b` |
| SendEmailChecked | `821bd8f1144fd29bd972a9471a59d036ad04e8c77003f08ea7b1009e8a640beb` |
| CreateEmailLogReceivedOrder | `ccd2065a419aea4a747eca0426bd14ac383323fa0cba1d7d55102f69b08d1163` |

## Flujo de trabajo

### Punto de entrada
El usuario está en la página de **Invoices/Packing Slips** (`/Domains/344/Invoices`), típicamente filtrada por cliente. Hace click en la extensión y selecciona "Validar OC vs OV".

### Paso 1 — Obtener el PDF de la OC

Tres opciones (en orden de prioridad):
1. **PDF adjunto en la OV**: si el usuario ya seleccionó/ingresó una OV y ésta tiene un PDF adjunto (via `GetReceivedOrderDocuments`), ofrecer usarlo directamente
2. **File picker**: el usuario sube el PDF desde su computadora
3. El PDF se lee como base64 para enviar a Claude API

### Paso 2 — Claude extrae datos del PDF

Llamada a Claude API (modelo: claude-sonnet-4-5-20250514) con el PDF como documento adjunto.

Prompt estructurado que pide JSON:
```json
{
  "poNumber": "PO-2026-04821",
  "customer": "ACME INDUSTRIES S.A. DE C.V.",
  "currency": "USD",
  "lines": [
    {
      "lineNumber": 1,
      "partNumber": "ECO-NI-3245",
      "description": "Niquelado electrolítico",
      "quantity": 500,
      "unitPrice": 2.85,
      "total": 1425.00
    }
  ]
}
```

### Paso 3 — Buscar la OV automáticamente

1. Extraer `customerId` de la URL de Invoices (query param)
2. Usar `CheckDuplicatePO` con el `poNumber` extraído + `customerId` → busca OVs por nombre
3. **1 match exacto** → continuar automáticamente
4. **Varios matches / fuzzy** → mostrar lista, usuario elige
5. **Sin match** → campo de texto con:
   - Botón "Pegar" (lee clipboard automáticamente)
   - Typeahead contra `ActiveReceivedOrders` filtrado por `customerId`
   - Opción "Crear OV nueva" (flujo alternativo futuro)

### Paso 4 — Leer datos de la OV

Con el ID de la OV encontrada:
1. `GetReceivedOrder` → líneas, precios, cantidades, customInputs (Divisa, RazonSocialVenta)
2. `ReceivingBatchesQuery` o `GetInventoryBatch` → discrepancias reportadas en batches de recibo (cantidad recibida vs esperada)

### Paso 5 — Comparación

**Match de líneas:** por Part Number (case-insensitive, trimmed). Si no hay match exacto, intentar fuzzy (Levenshtein o substring).

**Comparación de encabezado:**
- Razón social: OC vs `customInputs.RazonSocialVenta`
- Divisa: OC vs `customInputs.Divisa`

**Comparación por línea:**
| Estado | Condición |
|---|---|
| ✓ OK | PN, precio y cantidad coinciden |
| ⚠ Parcial | Cantidad OV < cantidad OC (envío parcial), precio coincide |
| ✗ Precio | Precio no coincide |
| ✗ Cantidad | Cantidad no coincide (y no es parcial) |
| ⚪ Faltante en OV | Línea del PDF sin match en OV |
| ⚫ Extra en OV | Línea en OV sin match en PDF |

**Columna de referencia "Recibo":** cantidad reportada en discrepancias de batches de recibo, cuando exista. Sirve como contexto adicional.

### Paso 6a — Reordenar líneas (botón independiente)

Si las líneas de la OV están en orden distinto al PDF, el botón "Reordenar líneas" usa `SaveReceivedOrderLinesAndItems` para reordenar las líneas de la OV según el orden del PDF.

### Paso 6b — Notificar discrepancias por email

Antes de enviar, el usuario clasifica cada discrepancia como "Error nuestro" o "Error del cliente".

**Error nuestro:**
- Email via `SendEmailChecked` (tipo: `SALES_ORDER`)
- Destinatarios: ingeniería (si precio) y/o servicio al cliente (si OV/cantidad)
- Contenido: tabla de discrepancias con links directos a la OV y PNs en Steelhead
- Se registra con `CreateEmailLogReceivedOrder` para auditoría

**Error del cliente:**
- Email via `SendEmailChecked` a servicio al cliente
- Contenido: resumen de lo que el cliente debe corregir

**Abrir lado a lado:** Botón para abrir el PDF (blob URL) y la OV en Steelhead en dos tabs nuevas. El usuario puede usar "Tab to the side" (Chrome 131+) o Split Screen (Edge) para ver ambas.

## UI

Overlay modal estilo `dl9-*` (tema oscuro) consistente con los demás applets. Ver mockup en `.superpowers/brainstorm/64669-1775762445/content/comparison-report-v2.html`.

### Componentes principales:
1. **Encabezado**: # OC, cliente, # OV vinculada
2. **Meta-comparación**: razón social y divisa con indicador match/mismatch
3. **Stats grid**: conteo por tipo de resultado
4. **Filter chips**: filtrar tabla por tipo
5. **Tabla comparativa**: columnas OC (morado) | OV (azul) | Recibo/Disc. (naranja) | Estado
6. **Clasificador de discrepancias**: toggle "Error nuestro" / "Error cliente" por discrepancia
7. **Botones de acción**: Reordenar, Email interno, Email serv. al cliente, Cerrar, Abrir lado a lado

## Indicador de consumo Claude API

Cada vez que se llama a Claude API:
- Mostrar ícono animado del logo de Claude (spinner/pulso) mientras procesa
- Al completar, mostrar tokens consumidos (input + output) y costo estimado en USD
- La API de Claude devuelve `usage.input_tokens` y `usage.output_tokens` en cada response
- Costo se calcula con las tarifas del modelo usado (claude-sonnet-4-5-20250514: $3/MTok input, $15/MTok output)
- Al final del flujo completo, mostrar un resumen de costo total de la transacción (todas las llamadas a Claude sumadas) en el footer del modal de resultados
- Formato: "Claude: 12,450 tokens · $0.04 USD"

## Almacenamiento de API Key

La API key de Claude se guarda en `chrome.storage.local` bajo la clave `sa_claude_api_key`. Se configura una sola vez desde un campo en el popup de la extensión (o en settings). No se sincroniza (no usar `chrome.storage.sync` para no exponer en otros dispositivos).

## Fix del Hash-Scanner (mejora relacionada)

Cambiar en `background.js` el naming de archivos de scan:
1. **Timezone**: `new Date().toLocaleDateString('en-CA')` en vez de `.toISOString().slice(0,10)`
2. **Serialización**: agregar hora local → `scan_results_2026-04-09_183042.json`
3. Aplicar en las 3 ubicaciones: scan results export, config export, CSV downloads

## Verificación

1. Subir un PDF de OC real → verificar que Claude extrae correctamente los datos
2. Buscar OV por # OC → verificar match automático
3. Comparar líneas → verificar semáforo correcto para cada tipo de discrepancia
4. Reordenar líneas → verificar que el orden en Steelhead cambia
5. Enviar email → verificar que llega con contenido correcto y se registra en historial de OV
6. Probar desde Invoices page con y sin `customerId` en URL
7. Probar flujo cuando no hay match de OV (fallback a campo de texto)
8. Probar con PDF adjunto en OV (descargar y usar directamente)
