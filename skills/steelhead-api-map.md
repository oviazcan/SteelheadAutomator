---
name: steelhead-api-map
description: Mapa completo de la API GraphQL de Steelhead ERP — endpoints, hashes, payloads, responses
---

# Steelhead API Map

## Endpoint
```
POST https://app.gosteelhead.com/graphql
```

## Formato de Request (Apollo Persisted Queries)
Steelhead NO acepta queries GraphQL en texto. Solo acepta `sha256Hash` de queries pre-registradas.

```json
{
  "operationName": "NombreOperacion",
  "variables": { ... },
  "extensions": {
    "clientLibrary": { "name": "@apollo/client", "version": "4.0.8" },
    "persistedQuery": { "version": 1, "sha256Hash": "abc123..." }
  }
}
```

**IMPORTANTE**: La versión de Apollo client DEBE ser exactamente `"4.0.8"`.

## Autenticación
Cookie de sesión httpOnly. No hay header Authorization. Los scripts se ejecutan en el contexto de la página ya autenticada.

## Keep-alive
```
POST https://app.gosteelhead.com/api/session/keep-alive → 204 No Content
```

## Mutations

| operationName | hashKey en config | sha256Hash | Variables |
|---|---|---|---|
| CreateQuote | CreateQuote | `ee313e12...` | `{name, assigneeId, customerId, validUntil, followUpDate, customerAddressId, customerContactId, stagesRevisionId:306, customInputs, inputSchemaId:659, invoiceTermsId}` |
| UpdateQuote | UpdateQuote | `765fc26a...` | `{id, notesMarkdown}` o `{id, internalNotesMarkdown}` |
| SaveQuoteLines | SaveQuoteLines | `b227e2f5...` | `{input:{quoteId, quoteLines:[...], quoteLinesToDelete:[], quoteLineItemsToDelete:[], quoteLineNumberUpdates:[]}}` |
| SaveManyPartNumberPrices | SaveManyPNP_Quote | `af7b8156...` | `{input:{quoteId, autoGenerateQuoteLines:true, partNumberPrices:[...], partNumberPriceIdsToDelete:[]}}` |
| SaveManyPartNumberPrices | SaveManyPNP_PN | `bd2db06e...` | Fallback del anterior |
| SavePartNumber | SavePartNumber | `31a6c7d9...` | `{input:[{id, name, customerId, defaultProcessNodeId, ...}]}` |
| SavePartNumberRackTypes | SavePartNumberRackTypes | `087af4e8...` | `{input:{partNumberRackTypes:[...], partNumberRackTypeIdsToDelete:[]}}` |
| SetPartNumberPricesAsDefaultPrice | SetPNPricesDefault | `9f89b40e...` | `{partNumberPriceIds:[N]}` |
| UpdatePartNumber | UpdatePartNumber | `af584fa8...` | `{id, archivedAt}` |
| CreatePartNumberGroup | CreatePartNumberGroup | `81edc509...` | `{input:{name}}` o `{name}` (schema puede variar) |

**NOTA**: `operationName` y `hashKey` pueden diferir. El `operationName` es lo que se envía a GraphQL. El `hashKey` es la clave en config.json para buscar el hash.

## Queries

| operationName | hashKey en config | Variables |
|---|---|---|
| GetQuote | GetQuote_v8 | `{idInDomain, revisionNumber:1}` |
| GetQuote | GetQuote_v71 | Fallback del anterior |
| GetQuoteRelatedData | GetQuoteRelatedData | `{customerId}` |
| CustomerSearchByName | CustomerSearchByName | `{nameLike:"%X%", orderBy:["NAME_ASC"]}` |
| CustomerFinancialByCustomerId | CustomerFinancialById | `{id: customerId}` |
| SearchInvoiceTerms | SearchInvoiceTerms | `{termsLike:"%%"}` |
| SearchUsers | SearchUsers | `{searchQuery, first:50}` |
| AllProcesses | AllProcesses | `{includeArchived:"NO", processNodeTypes:["PROCESS"], searchQuery, first:50}` |
| AllLabels | AllLabels | `{condition:{forPartNumber:true}}` |
| SearchSpecsForSelect | SearchSpecsForSelect | `{like:"%%", locationIds:[], alreadySelectedSpecs:[], orderBy:["NAME_ASC"]}` |
| TempSpecFieldsAndOptions | TempSpecFieldsAndOptions | `{specId}` |
| AllRackTypes | AllRackTypes | `{}` |
| SearchUnits | SearchUnits | `{}` |
| SearchProducts | SearchProducts | `{searchQuery:"%%", first:200}` |
| SearchPartNumbers | SearchPartNumbers | `{searchQuery, first:20, offset:0, orderBy:["ID_DESC"]}` |
| PartNumberGroupSelect | PNGroupSelect | `{partNumberGroupLike:"%%"}` |
| GetPartNumber | GetPartNumber | `{partNumberId}` |

## Constantes de Dominio (Ecoplating)

```json
{
  "id": 344,
  "inputSchemaId_PN": 3456,
  "inputSchemaId_Quote": 659,
  "stagesRevisionId": 306,
  "geometryGenericaId": 831,
  "validacionProcessNodeIds": [231176, 231174],
  "unitIds": { "KGM": 3969, "LBR": 3972, "FTK": 4797, "CMK": 4907, "FOT": 5148, "LM": 5150, "LO": 5348, "MTR": 3971 },
  "conversions": { "KGM_TO_LBR": 2.20462, "CMK_TO_FTK": 0.00107639, "LM_TO_FOT": 3.28084 },
  "empresas": { "ECO": "ECO030618BR4 - ECOPLATING SA DE CV...", "PRO": "PRO800417TDA - PROQUIPA SA DE CV..." }
}
```

## Bugs conocidos y workarounds
- `SaveManyPNP` NO acepta `newPartNumber` — PNs nuevos se crean primero via `SavePartNumber(id:null)`
- `CustomerFinancialByCustomerId` requiere `{id}` no `{customerId}`
- `SearchInvoiceTerms` requiere `{termsLike:"%%"}` no `{}`
- `SearchUsers` requiere `first:50`
- `SetPartNumberPricesAsDefaultPrice` es el operationName real (no `SetPNPricesDefault`)
- OptIn Validación de Ingeniería requiere AMBOS processNodeIds: `[231176, 231174]`
- SavePartNumber enrich: si falla por `unique_constraint`, reintentar sin `specsToApply`
- `CreatePartNumberGroup`: payload puede ser `{input:{name}}` o `{name}` — usar fallback
