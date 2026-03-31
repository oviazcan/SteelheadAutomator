---
name: steelhead-hash-scraping
description: Proceso para re-descubrir hashes de persisted queries cuando Steelhead los actualiza
---

# Steelhead Hash Scraping

## Cuándo es necesario
Steelhead actualiza sus hashes de persisted queries periódicamente (sin aviso). Los síntomas son:
- Las operaciones GraphQL devuelven HTTP 400 o "PersistedQueryNotFound"
- El pipeline falla en un paso que antes funcionaba
- Errores tipo "Could not find operation named 'X'"

## Proceso manual (DevTools)
1. Abre `app.gosteelhead.com` y navega a las secciones relevantes
2. Abre DevTools (F12) → Network → filtrar por `/graphql`
3. Realiza las acciones manualmente (crear quote, editar PN, etc.)
4. Para cada request GraphQL, copia:
   - `operationName` del body
   - `sha256Hash` del body → `extensions.persistedQuery.sha256Hash`
5. Actualiza `remote/config.json` con los nuevos hashes

## Páginas a visitar para capturar hashes

| Acción en Steelhead | Operaciones que captura |
|---|---|
| Crear nueva cotización | CreateQuote, GetQuoteRelatedData, CustomerSearchByName, SearchUsers, AllProcesses |
| Editar cotización existente | GetQuote, UpdateQuote, SaveQuoteLines |
| Agregar PN a cotización | SaveManyPartNumberPrices, SearchPartNumbers |
| Editar Part Number | SavePartNumber, GetPartNumber, AllLabels, SearchSpecsForSelect, TempSpecFieldsAndOptions |
| Ver racks en PN | AllRackTypes, SavePartNumberRackTypes |
| Ver productos | SearchProducts |
| Ver unidades | SearchUnits |
| Ver grupos de PN | PartNumberGroupSelect, CreatePartNumberGroup |
| Ver financial de cliente | CustomerFinancialByCustomerId, SearchInvoiceTerms |

## Proceso automatizado (futuro)
Script `hash-scraper.js` que:
1. Intercepta todas las requests a `/graphql` via `chrome.webRequest` o `fetch` override
2. Extrae `operationName` + `sha256Hash` de cada request
3. Compara con hashes actuales en `config.json`
4. Muestra diferencias y permite actualizar con un clic

## Estructura del config.json
```json
{
  "steelhead": {
    "hashes": {
      "mutations": {
        "CreateQuote": "hash...",
        "SavePartNumber": "hash..."
      },
      "queries": {
        "GetQuote_v8": "hash...",
        "CustomerSearchByName": "hash..."
      }
    }
  }
}
```

## Notas
- Los hashes son SHA256 del query text original registrado en Apollo Server
- El `operationName` enviado debe coincidir exactamente con el nombre de la operación registrada
- Algunos operationNames difieren del hashKey en config.json (ej: `SetPartNumberPricesAsDefaultPrice` vs `SetPNPricesDefault`)
- Mantener fallback hashes para operaciones críticas (GetQuote v8/v71, SaveManyPNP Quote/PN)
