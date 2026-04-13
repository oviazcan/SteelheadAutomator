# PO Comparator — Crear OV cuando no hay match

## Contexto

Cuando el Validador OC vs OV no encuentra la OV en Steelhead, el usuario debe crearla manualmente y volver a correr el comparador. Este feature agrega la posibilidad de crear la OV directamente desde los datos extraídos del PDF, o "adoptar" una OV existente con nombre provisional.

### Riesgo de duplicados

Es común que partes se reciban antes de que llegue la OC formal. En esos casos alguien crea una OV con nombre provisional (Test999, Prueba, PENDIENTE). Si el comparador no detecta estas OVs, crearía duplicados que inflan el forecast de ventas y generan discrepancias en lotes de inventario.

## Flujo general

```
PDF subido → Claude extrae datos → Búsqueda de OV (ya existe)
                                         │
                                    No match directo
                                         │
                              ┌──── Detección multi-señal ────┐
                              │                                │
                         Candidatas encontradas          Sin candidatas
                              │                                │
                     Lista con indicadores            Gate: "Ninguna existe"
                     de confianza (PNs en              usuario confirma
                     común, nombre sospechoso)              │
                              │                        Wizard Crear OV
                       Usuario elige:                      │
                       ├─ Seleccionar OV ──┐          Formulario completo
                       │  (renombrar con   │          con datos del PDF
                       │   PO real)        │          + defaults cliente
                       │                   │               │
                       └───────────────────┴───── OV lista ─┐
                                                             │
                                              Adjuntar PDF
                                              Ir a comparación normal
```

## Detección multi-señal

Tres capas de búsqueda antes de ofrecer "Crear OV":

### Capa 1 — Nombre (ya existe)

`CheckDuplicatePO` con el PO number del PDF. Si hay match exacto, flujo normal sin cambios.

### Capa 2 — OVs activas del cliente

`ActiveReceivedOrders` filtrado por `customerId`. Se obtiene lista con: id, idInDomain, name, deadline, cantidad de líneas.

Identificación del cliente: se intenta extraer del URL (`customerId` query param). Si no está, se busca por el nombre/RFC del PDF contra el catálogo de clientes.

### Capa 3 — Cruce de PNs

Para cada OV activa del cliente, cargar sus líneas (usando `GetReceivedOrder`). Normalizar PNs (trim + lowercase) y comparar contra los PNs del PDF. Calcular un score de coincidencia: `PNs en común / PNs del PDF`.

### Indicadores en la lista de candidatas

| Señal | Indicador visual |
|-------|-----------------|
| Nombre sospechoso (test/prueba/pendiente) | Etiqueta "Nombre provisional" |
| >= 1 PN en común | Etiqueta "X de Y PNs coinciden" |
| Nombre coincide parcialmente con PO | Etiqueta "Nombre similar" |

Candidatas ordenadas por score de PNs en común (desc), luego por fecha (desc).

### Gate de confirmación

- Si hay candidatas: lista con radio buttons + opcion final "Ninguna — crear OV nueva"
- Si no hay candidatas: directo al wizard con aviso "No se encontraron OVs activas para este cliente"
- El boton "Crear OV nueva" solo aparece si el usuario selecciona esa opcion

## Wizard de creacion de OV

### Queries previos (en paralelo)

- `CreateEditReceivedOrderDialogQuery` — schema de inputs, defaults del dominio
- `GetCustomerInfoForReceivedOrder` — contactos, direcciones, invoice terms, sector, defaults del cliente

### Formulario

Todos los campos de `CreateReceivedOrder`, organizados en grupos:

**Grupo 1 — Identificacion (pre-llenado del PDF)**
- Nombre de OV: PO number del PDF
- Cliente: inferido del PDF o seleccionable con busqueda
- Contacto del cliente: dropdown, pre-selecciona el que sea `isReceivedOrderContact`

**Grupo 2 — Direcciones (pre-llenado de defaults del cliente)**
- Direccion de facturacion: dropdown, pre-selecciona `defaultBillToAddressId`
- Direccion de envio: dropdown, pre-selecciona `defaultShipToAddressId`

**Grupo 3 — Terminos (pre-llenado de defaults del cliente)**
- Invoice terms: dropdown, pre-selecciona `defaultInvoiceTermsId`
- Ship via: pre-llena con default del cliente o "Flete Propio"
- Tipo de orden: dropdown (MAKE_TO_ORDER, etc.), pre-selecciona `defaultOrderType`
- Plazo de entrega: date picker, default = hoy + `defaultLeadTime` del cliente

**Grupo 4 — Custom inputs (inferidos del PDF, editables)**
- Divisa: dropdown (USD/MXN), inferida del PDF
- Razon Social Venta: dropdown de opciones del schema, inferida del PDF con fuzzy match
- Verificado por: texto libre o dropdown

**Grupo 5 — Otros (defaults)**
- Sector: pre-llenado de `sectorBySectorId` del cliente
- Input Schema ID: 559 (fijo, del dominio)
- Bloquear envios parciales: checkbox, default false
- Orden abierta (blanket): checkbox, default false

### Secuencia de creacion

1. `CreateReceivedOrder` — obtiene `receivedOrderId` + `idInDomain`
2. `SaveReceivedOrderLinesAndItems` — agrega lineas del PDF (PN, qty, precio)
3. Upload PDF: `POST /api/files` → `CreateUserFile` → `CreateReceivedOrderUserFile`
4. Carga la OV recien creada y pasa a comparacion normal

### Manejo de errores

- Si `CreateReceivedOrder` falla: mostrar error, no avanzar
- Si las lineas o el upload fallan: mostrar warning pero permitir continuar (la OV ya existe, el usuario puede completar manualmente)

## Adopcion de OV existente

Cuando el usuario selecciona una candidata de la lista en lugar de crear nueva.

### Acciones automaticas

1. **Renombrar** — `UpdateReceivedOrder` con `name: poNumber` del PDF
2. **Adjuntar PDF** — `/api/files` → `CreateUserFile` → `CreateReceivedOrderUserFile`

### Acciones que NO se hacen automaticamente

- No se modifica divisa ni razon social (se comparan en meta-datos, usuario decide)
- No se agregan lineas faltantes (la comparacion las muestra como "Faltante en OV", usuario decide)

### Flujo post-adopcion

Continua a la comparacion normal con la OV renombrada. El usuario ve:
- Meta-datos (divisa, razon social) con indicadores de match/mismatch
- Lineas que ya existian se comparan normal
- Lineas del PDF que no estan en la OV aparecen como "Faltante en OV"
- Lineas de la OV que no estan en el PDF aparecen como "Extra en OV"

## Hashes nuevos para config.json

| Operacion | Tipo | Hash | Proposito |
|-----------|------|------|-----------|
| CreateReceivedOrder | mutation | `a72de5b673898badb7af85c8b350cc452a34e7bb6af3c375c83e1abb8ca779f9` | Crear OV nueva |
| CreateEditReceivedOrderDialogQuery | query | `b4a8ae722ac336d4a2e474f860c8bd129d8e652a1ea61382fe1bb5cb35fb5aa1` | Schema inputs + defaults dominio |
| GetCustomerInfoForReceivedOrder | query | `12ae26c6507ef68dfe676e6964cea1efbf921a89ab1660b3db097a095c6de8c6` | Contactos, direcciones, terms cliente |
| CreateUserFile | mutation | `9028f6b729fe0cd253b1d47d5f27d84cc15293bbc12381225a7c00a402849ec9` | Registrar archivo subido |
| CreateReceivedOrderUserFile | mutation | `5896851dd3ee71e025bd59be3a0a3795d2ccf177636ee1bb45b10084f1541f57` | Enlazar archivo a OV |

`SaveReceivedOrderLinesAndItems`, `UpdateReceivedOrder` y `ActiveReceivedOrders` ya estan en config.json.

## Dependencias

No se agregan scripts nuevos. Todo va dentro de `po-comparator.js`, que ya depende de `steelhead-api.js` y `claude-api.js`. El upload usa `fetch('/api/files')` directo (mismo patron que `file-uploader.js` y `cfdi-attacher.js`).

## Estimacion de cambios

- `po-comparator.js`: ~300-400 lineas nuevas (deteccion multi-senal, wizard UI, adopcion, upload)
- `config.json`: 5 hashes nuevos
