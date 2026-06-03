# Power Tools `getPdfCustomization` — preparación de payload para plantilla PDFGeneratorAPI (`facturacion-pdf.ts`)

Hook low-code que **NO** genera el PDF. Solo precomputa valores y enriquece el shape que llegará a la plantilla de PDFGeneratorAPI como `additionalPayload` (queda disponible al lado de `inputs` originales).

## Estructura del hook

```
getPdfCustomization(inputs, helpers)
  → result.additionalPayload = {
      zipCode,                 // 5-dig o ZIP+4 extraído de billToAddress
      xmlDecodificado,         // CFDI XML reindentado (debug / leyenda)
      lotesPorLinea,           // { "<lineNumber>": [LoteResumen, ...] }
      invoiceLinesConLotes,    // invoiceLine[] enriquecido con `.lotes`
    }
```

`LoteResumen` = `{ batchId, name, packingSlip }`.

## Bloque 1 — ZIP code

Se lee `inputs.billToAddress.address` (NO Ship To ni Drop Ship). Regex `\b\d{5}(?:-\d{4})?\b` captura ZIPs estilo US; en MX también pega CPs de 5 dígitos. Heurística: si la dirección **arranca** con un ZIP-like, ese es número exterior y se descarta. Si quedan 2+, se toma el segundo (suele ser el CP real cuando hay número de calle + CP en el mismo string). Si queda 1, ese. Si no, `null`.

> Gotcha: direcciones con suite/floor que mezclen 5 dígitos pueden devolver el ZIP equivocado. Si pasa, hay que reforzar la heurística mirando posición (último match) o validar contra una tabla de CPs.

## Bloque 2 — XML CFDI

`inputs.createWriteResult.data.result.writeResult.XmlBase64File` viene en Base64. Se decodifica con `atob` y se reindenta con `formatXml` (helper interno). Si `atob` truena, se emite warning (no error) — el PDF se puede generar sin la sección XML.

> Cuidado con el **shadowing**: dentro del `.map(line => { const result = ... })` la variable interna `result` sombrea a la del hook. Funciona porque el map retorna y nunca asigna al de afuera, pero si se refactoriza hay que renombrar para evitar el bug clásico.

## Bloque 3 — Join `partAccounts` ↔ `invoiceLines`

**Problema de negocio:** la plantilla muestra una tabla de `invoiceLines`, pero el dato de lote (`receivedBatches[].name`) y su PackingSlip (`receivedBatches[].customInputs.DatosRecibo.PackingSlip`) vive en `partAccounts[]` — otro array a nivel raíz. PDFGeneratorAPI no resuelve joins desde la plantilla; hay que dejarle los datos ya unidos.

**Llave:**

```
partAccounts[].invoiceLineNumbers[].line  ==  invoiceLines[].invoiceLine.lineNumber
```

**Cardinalidad:**

| Lado | Cardinalidad | Notas |
|---|---|---|
| `invoiceLine` ↔ `partAccount` | 1 : N | varios PAs por línea de factura (caso normal) |
| `partAccount` ↔ `invoiceLineNumbers` | 1 : N | mismo PA repartido entre líneas (raro pero el shape lo permite) |
| `partAccount` ↔ `receivedBatches` | 1 : N | lotes físicos recibidos |

**Estrategia (implementada):**

1. Construir `Map<lineNumber, LoteResumen[]>` iterando los 3 niveles (PA → invoiceLineNumbers → receivedBatches).
2. Dedup por `batchId` dentro de cada línea — si el mismo lote llega vía dos PAs distintos a la misma línea, no se duplica.
3. Exponer **dos formas** para que el template tome la más cómoda:
   - `lotesPorLinea: Record<string, LoteResumen[]>` — lookup por lineNumber desde el loop original de `invoiceLines` (`{{lotesPorLinea.[lineNumber]}}`).
   - `invoiceLinesConLotes: (invoiceLine & {lotes, lotesConPsStr, descripcionHtml})[]` — array ya enriquecido, iterable directo.
     - `lotesConPsStr`: cada lote pegado a su PS en formato `"nameLote (PS PackingSlip), ..."`. Si un lote no tiene PS, o si `name === packingSlip` (caso común en Steelhead, donde el lote se nombra igual al PS de origen), se muestra solo el nombre sin sufijo `(PS …)`.
     - `descripcionHtml`: HTML enriquecido por línea de factura, equivalente al expression language del template de PDFGeneratorAPI. Ver bloque **"Descripción HTML"** más abajo.
     - `npHtml`: HTML del nombre/descripción del NP por línea (`<b>{name}</b><br>{description} {partNumber.description}` + opcional `<br><b>Acabado: </b>{labels}`). Replica el expression de la celda de "Descripción del NP" del template. Acota `partAccounts.partNumber.*` por `lineNumber` (el expression original lo usaba global). Cascada de fallback (en orden):
       1. `name` vacío → mensaje rojo `<b>Favor de configurar Cliente {customer.name} en SH</b>` (independiente de DatosFactura — cubre datos rotos).
       2. DatosFactura ausente pero `name` presente → `<b>{name}</b>` solo (el aviso completo de DatosFactura ya sale en `descripcionHtml`).
       3. DatosFactura presente con `MostrarNP === false` → `""` (cliente decidió ocultar la columna; respeta la decisión).
       4. Caso normal → render completo.

**Ejemplo (datos del usuario):**

- 3 partAccounts, 2 invoiceLines.
- `partAccounts[0]` con `invoiceLineNumbers: [{line: 1}]` y 1 batch (id=1221404, name="8798", PackingSlip="8798") → contribuye al lineNumber 1.
- Resultado esperado en `invoiceLinesConLotes[0]` (lineNumber 1):
  ```
  { ...invoiceLine,
    lotes: [{ batchId: 1221404, name: "8798", packingSlip: "8798" }, ...otros PAs que apunten a la línea 1],
    lotesConPsStr: "8798 (PS 8798), ..." }
  ```

## Descripción HTML (`descripcionHtml`)

Traducción a TS del expression language de PDFGeneratorAPI que vive en el template original. Se calcula por línea y queda en `invoiceLinesConLotes[].descripcionHtml`.

### Flags de cliente (`billToAddress.customer.customInputs.DatosFactura`)

| Flag | Efecto |
|---|---|
| `MostrarNP` | Renderiza `npHtml` (nombre + descripción del invoice line + descripción del PN). Si está apagado, `npHtml === ""` |
| `MostrarAcabado` | Sufijo `<br><b>Acabado: </b>{labels}` en `npHtml` |
| `MostrarProducto` | Antepone `<b>Producto: </b>{name}<br>` |
| `MostrarRemision` | `<b>Remisión: </b>{join(packingSlip.idInDomain)}<br>` |
| `MostrarPO` | Bloque `OC (OV)` (con o sin span rojo) |
| `MostrarLineaPO` | Sufijo `-{salesOrderLineNumber * MultiplicadorLineaOC}` después del PO |
| `MostrarOV` | Sufijo ` ({salesOrder.idInDomain})` después del PO |
| `MostrarOT` | `<b>Orden de Trabajo: </b>{ids}<br>` |
| `MostrarLote` | `<b>Lote: </b>{nombres}` + opcional descripción del batch |
| `MostrarPS` | Sufijo `<b>PS: </b>{packingSlips}` + sufijo Schneider (VM/VE) |
| `MultiplicadorLineaOC` | Numérico (default 1 si null) |

### Top-level guard

Si `inputs.totalPriceUSD < 0` (notas de crédito), se regresa `invoiceLine.description` cruda y se salta todo el enriquecimiento. Replica el branch top-level del expression.

### Fallback cuando falta DatosFactura

Si `billToAddress.customer.customInputs.DatosFactura` es `null`, `undefined` o `{}` (objeto vacío), cada `descripcionHtml` se reemplaza por:

```
<span style="color:red;"><b>Favor de configurar DatosFactura del Cliente {customer.name} en SH</b></span>
```

Adicionalmente:

- Se emite `helpers.addErrorMessage({severity:'warning', ...})` para que el operador lo vea en el panel de Test del Power Tool.
- `additionalPayload.datosFacturaConfigurado` (boolean) y `additionalPayload.datosFacturaMensajeFaltante` (string|null) se exponen sueltos para que el template pueda mostrar el aviso en el header en lugar de (o además de) en cada fila.

**Distinción importante:** "no configurado" (objeto ausente o vacío) NO es lo mismo que "todos los flags en false". Si el cliente decide a propósito ocultar todo, `DatosFactura: {MostrarProducto: false, ...}` sí cuenta como configurado y el `descripcionHtml` queda casi vacío (sin disparar el fallback).

### OC (OV) — span rojo

Si `salesOrder.name` matchea `/pen/i` o es `"."`, se envuelve en `<span style="color:red; font-size:14pt;">...</span>` para marcarlo como pendiente. Replica el `matches '/pen/i'` del expression.

### Sufijo Schneider (VM/VE)

Si `customer.name.substring(0, 3) === "SCH"` y el flag MostrarPS está activo, se agrega `"VM"` o `"VE"` al final del bloque de lote:

- `"VM"` si el primer lote de la línea empieza con `"RG-M"`.
- `"VE"` en cualquier otro caso.

Aplicado una sola vez por línea (no por lote), igual que el expression original.

### Diferencias intencionales respecto al expression original

| Aspecto | Expression del template | Implementación TS | Razón |
|---|---|---|---|
| OT y Lote/PS | `partAccounts.workOrder.idInDomain` / `partAccounts.receivedBatches` **globales** | Filtrado por `lineNumber` usando el join | Lo global hacía que cada línea de la factura mostrara los WOs/lotes de TODAS las líneas. Bug del template; aquí se acota. |
| NP (npHtml) | `partAccounts.partNumber.description` y `partAccounts.partNumber.labels` **globales** | Filtrado por `lineNumber` y dedupeado por id de PN / id de label | Mismo bug del template original. Si una línea tiene varios PAs apuntando al mismo PN, sin dedup la descripción y los labels se duplicaban. |
| Encabezado "Batch:" | Parseaba `invoiceLineItems[0].description` con `str_replace + split + split + [1][1]` para extraer el número de batch | Reemplazado por `join(", ", lotes.name)` directo del join | El parseo era frágil (depende del texto exacto que Steelhead inyecta en `description`) y redundante porque ya tenemos los nombres reales del lote vía join. |
| PS===Lote | Imprimía `<b>Lote: </b>X <b>PS: </b>X` (duplicado) | Solo `<b>Lote: </b>X` (omite el bloque PS cuando son iguales) | Pedido del usuario: evita repetir información cuando el lote se nombra igual al PS. |
| Dedup de PS de Remisión | join directo sin dedup | `Set` antes del join | Mismo PS referenciado por múltiples lineItems aparecía repetido. |

Si alguna de estas decisiones rompe el output esperado en producción, son los puntos a revertir primero.

**2026-06-03 — Fusión PO/Lote/PS.** Cuando `salesOrder.name` (PO), los nombres de
lote y los packing slips de la línea comparten el mismo valor base, los bloques
"OC (OV)" y "Lote+PS" se fusionan en un solo `<b>PO/Lote/PS: </b>{base} {sufijo}`.
El sufijo del PS (ej. la descripción del NP, "ZAPATA") se anexa. Si solo coinciden
PO y Lote, se emite `PO/Lote: {base}` y el PS se muestra aparte. Si no hay
coincidencia, render separado como antes. El `(OV)` interno no participa en la
comparación. Lógica pura en `tools/pdf_description_fusion.{mjs,test.mjs}`.

## Lecciones (pendientes de validar al subir al editor de Power Tools)

- `helpers.log` puede no imprimir en el panel "Test" según el flujo (igual que en `ordendeventa.ts`). Si no salen los logs, dumpear a `addErrorMessage({severity:'info', message: JSON.stringify(...)})` temporalmente.
- `customInputs` no está tipado, hay que castear a `any` para llegar a `DatosRecibo.PackingSlip` — patrón ya usado en `facturacion.ts`.
- Si una `invoiceLine` no tiene PAs apuntándole, `invoiceLinesConLotes[i].lotes` queda `[]` (no `null`). Las versiones `*Str` quedan como string vacío.
- Para PDFGeneratorAPI: si la plantilla itera por `additionalPayload.invoiceLinesConLotes`, ya no necesita tocar `inputs.invoiceLines`. Si itera por `inputs.invoiceLines`, hace lookup con `additionalPayload.lotesPorLinea[lineNumber]`.

## Plan de validación pendiente

1. Pegar `facturacion-pdf.ts` al editor de Power Tools de Steelhead (hook `getPdfCustomization`).
2. Correr Test con la factura del usuario (3 PAs, 2 invoiceLines).
3. Verificar en el output del test:
   - `additionalPayload.lotesPorLinea["1"]` contiene los 2 PAs que apuntan a la línea 1.
   - `additionalPayload.lotesPorLinea["2"]` contiene el PA restante.
   - `additionalPayload.invoiceLinesConLotes[0].lotesNombresStr` muestra los nombres concatenados.
4. Actualizar la plantilla de PDFGeneratorAPI para consumir `lotesPorLinea` o `invoiceLinesConLotes`.

## Pendientes derivados

- Confirmar que el PackingSlip a mostrar es `receivedBatches[].customInputs.DatosRecibo.PackingSlip` y no `partAccounts[].packingSlip.idInDomain` (el PA también tiene un objeto `packingSlip` con `idInDomain`; semánticamente distinto — uno es el PS del lote físico recibido, el otro es el PS de embarque generado al facturar). En esta primera versión usamos el del lote (como en `facturacion.ts`).
- Si más adelante hay que mostrar también `idInDomain` del PS de embarque, agregar un campo paralelo en `LoteResumen`.

## Fecha de recibo del lote — NO viaja en el payload del INVOICE (investigado 2026-05-29)

**Pregunta de negocio:** mostrar en la factura la fecha de recibo del lote (la que en otros documentos —Job Tag— se navega como `{receivedBatches::receivers::receivedDate}`). Aproximación aceptable: la fecha de creación del batch (`createdAt`).

**Conclusión: el documento INVOICE no expone esa fecha por ningún lado.** Validado con 3 dumps independientes en el panel Test (vía `helpers.addErrorMessage({severity:'info', ...})`, porque `helpers.log` no siempre imprime):

1. `Object.keys(receivedBatch)` → `["id","name","descriptionMarkdown","customInputs","partNumberOnBatch"]`. Sin `createdAt`, `receivers`, `receivedDate` ni `receivedAt`.
2. `JSON.stringify(receivedBatch)` completo → confirma que no hay campo escondido (una respuesta GraphQL es data plana y enumerable; si viniera, `JSON.stringify` la sacaría). El `customInputs.DatosRecibo` es folder gestionado por el cliente (`TipoVale`, `PackingSlip`, `numeroContenedores`) y **no** maneja fecha.
3. `Object.keys(inputs)` top-level → `idInDomain, invoiceTerms, terms, createdAt, createWriteResult, voidWriteResult, domain, paymentLinkUrl, shipDate(+AsDate), shipVia, notes, location, totalPriceUSD, invoicedAt(+AsDate), dueAt(+AsDate), paid, openBalance, salesTax, taxRates, salesTaxUSD, customerContact, completedPartsTransfers, customInputs, logoUrl, timezone, billToAddress, shipToAddress, dropShipToAddress, partAccounts, invoiceLines`. **No hay nodo `receivers`/`receivedOrders`/`batches` suelto** que se pueda cruzar por `batchId`. Los únicos nodos con datos de lote son `partAccounts` (sin fecha en el batch) y `completedPartsTransfers` (sin fecha de recibo ni `batchId`).

**Por qué el truco del Job Tag no aplica:** dos resolvers distintos.
- El expression nativo de Steelhead (`{a::b::c}`) navega el grafo del modelo en runtime — por eso el Job Tag llega a `{receivedBatches::receivers::receivedDate}`.
- El INVOICE-PDF usa **PDFGeneratorAPI** con `additionalPayload` precomputado por este hook. El hook solo ve lo que la query GraphQL del INVOICE trae (el objeto `Inputs`, ya resuelto y serializado). No hay forma de "forzar" un campo que la query no pidió, ni de lanzar una query extra: `Helpers` no expone red, y el sandbox no da `fetch`/auth/hash de persisted query.

**Workaround vigente (decisión del usuario):** usar `partAccounts[].workOrder.createdAt` (fecha de OT) como aproximación de la fecha de recibo. Ya implementado en la plantilla por el usuario; **no** se agregó al `LoteResumen` del hook. Cuidado: NO usar `packingSlip.createdAt` ni `billOfLading.createdAt` — son fechas de embarque/salida, no de recibo.

**Pendiente con Steelhead (ticket abierto por el usuario):** agregar `receivedBatches { createdAt }` o el join `receivers { receivedDate }` a la query del documento INVOICE PDF. El modelo de datos ya lo soporta (el Job Tag lo navega); es solo cuestión de que la query del INVOICE lo pida. Cuando llegue, aparecerá en el dump y se engancha al `LoteResumen` en dos líneas (sustituyendo el proxy de OT).
