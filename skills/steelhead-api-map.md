---
name: steelhead-api-map
description: Mapa completo de la API GraphQL de Steelhead ERP — 30+ endpoints con hashes, payloads, responses
---

# Steelhead API Map

## Endpoint
POST https://app.gosteelhead.com/graphql
Apollo client version: "4.0.8" (obligatorio)
Auth: cookie de sesión httpOnly
Keep-alive: POST /api/session/keep-alive → 204
File upload: POST /api/files (multipart/form-data, campo "myfile")

## Mutations

| operationName | hashKey | Descripción |
|---|---|---|
| CreateQuote | CreateQuote | Crear cotización con custom inputs |
| UpdateQuote | UpdateQuote | Actualizar notas ext/int |
| SaveQuoteLines | SaveQuoteLines | Asignar productos a líneas |
| SaveManyPartNumberPrices | SaveManyPNP_Quote / SaveManyPNP_PN | Vincular PNs a quote / precios standalone |
| SavePartNumber | SavePartNumber | Crear/enriquecer PNs |
| SavePartNumberRackTypes | SavePartNumberRackTypes | Asignar racks |
| SetPartNumberPricesAsDefaultPrice | SetPNPricesDefault | Marcar precio default |
| UnsetPartNumberPriceAsDefaultPrice | UnsetPartNumberPriceAsDefaultPrice | Quitar precio default |
| UpdatePartNumber | UpdatePartNumber | Archivar/desarchivar |
| CreatePartNumberGroup | CreatePartNumberGroup | Crear grupo PN |
| DeletePartNumberPrice | DeletePartNumberPrice | Borrar precio por ID |
| DeletePartNumberRackType | DeletePartNumberRackType | Borrar rack por ID |
| CreatePartNumberInputSchema | CreatePartNumberInputSchema | Actualizar schema CI (enum Metal Base) |
| CreateUserFile | CreateUserFile | Registrar archivo subido |
| CreatePartNumberUserFile | CreatePartNumberUserFile | Vincular archivo a PN |

## Queries

| operationName | hashKey | Descripción |
|---|---|---|
| GetQuote | GetQuote_v8 / GetQuote_v71 | Cotización completa (fallback) |
| GetQuoteRelatedData | GetQuoteRelatedData | Direcciones/contactos cliente |
| CustomerSearchByName | CustomerSearchByName | Buscar clientes (A-Z, first:500) |
| Customer | Customer | Cliente con direcciones ({idInDomain, includeAccountingFields:true}) |
| CustomerFinancialByCustomerId | CustomerFinancialById | Términos facturación |
| SearchUsers | SearchUsers | Usuarios (first:500) |
| AllProcesses | AllProcesses | Procesos activos (first:500) |
| AllLabels | AllLabels | Etiquetas PN |
| SearchSpecsForSelect | SearchSpecsForSelect | Especificaciones |
| TempSpecFieldsAndOptions | TempSpecFieldsAndOptions | Campos spec (espesor) |
| AllRackTypes | AllRackTypes | Tipos de rack |
| SearchProducts | SearchProducts | Productos (first:500) |
| SearchPartNumbers | SearchPartNumbers | PNs por nombre (first:20) |
| GetPartNumber | GetPartNumber | Detalle completo PN |
| GetDimension | GetDimension | Dimensiones contables |
| AllPartNumbers | AllPartNumbers | Todos PNs (first:500) |
| AllWorkOrders | AllWorkOrders | OTs (createdAtAfter disponible) |
| AllReceivers | AllReceivers | Recibos (first:500) |
| PartNumberGroupSelect | PNGroupSelect | Grupos PN |

## Custom Inputs Schema (inputSchemaId 3456)
```json
{
  "DatosAdicionalesNP": { "BaseMetal": enum, "NumeroParteAlterno": [], "QuoteIBMS": str, "EstacionIBMS": str, "Plano": str },
  "DatosFacturacion": { "CodigoSAT": enum },
  "DatosPlanificacion": { "PiezasCarga": num, "CargasHora": str, "montoMinimo": num, "TiempoEntrega": num },
  "NotasAdicionales": str
}
```

## Domain (Ecoplating)
- ID: 344, inputSchemaId_PN: 3456, inputSchemaId_Quote: 659
- stagesRevisionId: 306, geometryGenericaId: 831
- validacionProcessNodeIds: [231176, 231174]
- dimensionIds: { linea: 349, departamento: 586 }

## Bugs y workarounds
- operationName ≠ hashKey: SetPartNumberPricesAsDefaultPrice, CustomerFinancialByCustomerId, PartNumberGroupSelect
- OptIn requiere AMBOS processNodeIds: [231176, 231174]
- SavePartNumber: retry progresivo sin specs→optIn→predictive si 23505
- SavePartNumberRackTypes: retry uno por uno si duplicate key
- CreatePartNumberGroup: fallback {input:{name}} → {name}
- CustomerSearchByName: límite ~60, paginar A-Z con first:500
- File upload: POST /api/files → CreateUserFile → CreatePartNumberUserFile
- Guión (-) = borrar: aplica a TODOS los campos via resolveStr/isDash
