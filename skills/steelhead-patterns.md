---
name: steelhead-patterns
description: Patrones de automatización de Steelhead — auth, batching, fallbacks, custom inputs, pipeline
---

# Steelhead Automation Patterns

## Autenticación
- Cookie de sesión httpOnly — no headers de Authorization
- La extensión Chrome corre en contexto de página autenticada
- `fetch('/graphql', { credentials: 'include' })` hereda las cookies
- Keep-alive: `POST /api/session/keep-alive` cada ~5 min para evitar timeout

## Batching
- `SaveManyPartNumberPrices`: máximo 20 PNs por batch
- `SavePartNumberRackTypes`: máximo 50 racks por batch
- PNs nuevos se crean uno por uno via `SavePartNumber(id:null)` antes de vincular a quote

## Fallback de Hashes
Steelhead actualiza hashes periódicamente. Implementar fallback con dos hashes:
```javascript
// GetQuote: intenta v8, si falla usa v7.1
queryWithFallback('GetQuote', 'GetQuote_v8', 'GetQuote_v71', vars)
// SaveManyPNP: intenta Quote context, si falla usa PN context
queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN', vars)
```

## Pipeline de Carga Masiva (COTIZACIÓN+NP)
1. Parse CSV (61 columnas, header key-value + data rows)
2. Resolve cliente → `CustomerSearchByName` + `GetQuoteRelatedData` + `CustomerFinancialByCustomerId`
3. Resolve asignado → `SearchUsers`
4. Resolve proceso → `AllProcesses` o por ID directo
5. Cargar catálogos en paralelo: Labels, Specs, Racks, Units, Products, Groups
6. Verificar PNs existentes → `SearchPartNumbers` (exact name + not archived)
7. Preview modal → usuario confirma
8. **Step 1**: `CreateQuote` con custom inputs (Comentarios, DatosAdicionales, Autorizacion, CondicionesComerciales)
9. **Step 2a**: `SavePartNumber(id:null)` para PNs nuevos → obtener IDs
10. **Step 2b**: `SaveManyPartNumberPrices` con `autoGenerateQuoteLines:true` → vincular a quote
11. **Step 3**: `GetQuote` → re-leer para obtener QPNPs y QuoteLines auto-generadas
12. **Step 4**: `SaveQuoteLines` → asignar productos a cada línea
13. **Step 5**: `UpdateQuote` → notas externas/internas
14. **Step 6**: `SavePartNumber(enrich)` → labels, specs, unitConv, CI, dims, predictive, optIn
15. **Step 7**: `SavePartNumberRackTypes` → asignar racks
16. **Step 8**: `SetPartNumberPricesAsDefaultPrice` + `UpdatePartNumber(archive)`
17. **Step 9**: Modal resultado con stats y errores

## Pipeline SOLO_PN (sin cotización)
Omite steps 1, 2b, 3, 4, 5, 8(default price). Solo:
1. Crear PNs nuevos (`SavePartNumber id:null`)
2. Enriquecer todos (`SavePartNumber enrich`)
3. Racks (`SavePartNumberRackTypes`)
4. Archivar si aplica (`UpdatePartNumber`)

## Custom Inputs de Cotización
```json
{
  "Comentarios": { "CargosFletes": true, "CotizacionSujetaPruebas": true, "ReferirNumeroCotizacion": true, "ModificacionRequiereRecotizar": true },
  "DatosAdicionales": { "Divisa": "USD", "Decimales": "2", "EmpresaEmisora": "ECO030618BR4 - ...", "MostrarProceso": false, "MostrarTotales": true },
  "Autorizacion": {},
  "CondicionesComerciales": {}
}
```

## Custom Inputs de PN
```json
{
  "DatosFacturacion": { "CodigoSAT": "73181106 - Servicios de enchapado" },
  "DatosAdicionalesNP": { "BaseMetal": "Cobre", "NumeroParteAlterno": ["ALT1", "ALT2"] }
}
```

## Specs con Espesor
El formato del spec en la plantilla es: `"SpecName | paramValue"`
- Si contiene ` | `, se busca el campo "espesor" en los spec fields y se selecciona el param que coincida
- Si no contiene ` | `, se aplica el spec sin parámetro específico de espesor

## Unit Conversions
```
KGM → también crear LBR (factor × 2.20462)
CMK → también crear FTK (factor × 0.00107639)
LM  → también crear FOT (factor × 3.28084)
Min Pzas Lote → crear LO (factor = 1/minPzas)
```

## Predictive Usage
9 materiales con inventoryItemIds fijos. `usagePerPart` es String, no Number.

## OptIn Validación de Ingeniería
Requiere enviar AMBOS processNodeIds: `[231176, 231174]` con `cancelOthers: false`.
Solo enviar uno no activa el checkbox en la UI de Steelhead.

## Notas sobre Excel
- xlwings en Mac no escribe fórmulas complejas de forma confiable
- xlwings lee/escribe fórmulas en INGLÉS (formato interno de Excel) — NO traducir a español
- SheetJS destruye formato, macros, botones al reconstruir .xlsm — no usarlo para modificar la plantilla
- Para catálogos: generar archivo separado .xlsx, la macro VBA lee de ahí
