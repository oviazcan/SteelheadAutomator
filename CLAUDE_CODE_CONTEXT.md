# Steelhead Data Loader — Contexto para Claude Code
## Proyecto de extensión Chrome para carga masiva de cotizaciones y números de parte

**Autor:** Omar Viazcan (oviazcan@gmail.com)  
**Empresa:** Ecoplating SA de CV / Proquipa SA de CV (Toluca, México)  
**Sistema ERP:** Steelhead (app.gosteelhead.com)  
**Última versión funcional:** v8.4 (bookmarklet, 2026-03-27)  
**Siguiente paso:** Migrar de bookmarklet a extensión Chrome

---

## 1. Qué es este proyecto

Un cargador masivo que toma un CSV exportado desde un template Excel y ejecuta una cadena de llamadas GraphQL contra Steelhead para crear cotizaciones con múltiples números de parte, incluyendo precios, labels, specs, productos, racks, dimensiones, predictive usage, y más.

### Evolución
- v1-v7: Scripts separados (importFile.ts + bookmarklet addAll.js)
- v8.0-v8.4: Bookmarklet unificado (un solo archivo JS, ~580 líneas)
- **v9 (target):** Extensión Chrome con UI propia, hash management, y validación en tiempo real

---

## 2. Arquitectura de comunicación con Steelhead

### Endpoint
```
POST https://app.gosteelhead.com/graphql
```

### Apollo Persisted Queries
Steelhead **NO acepta queries GraphQL en texto**. Solo acepta `sha256Hash` de queries pre-registradas (Apollo Persisted Queries). No hay campo `query` en el body — solo `operationName`, `variables`, y `extensions`.

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

### Autenticación
Cookie de sesión httpOnly. No hay header Authorization. El bookmarklet/extensión se ejecuta en el contexto de la página ya autenticada.

### Keep-alive
```
POST https://app.gosteelhead.com/api/session/keep-alive → 204 No Content
```

### Sesión
```json
{
  "user": { "domain_id": 344, "user_id": 11973, "username": "oviazcan@gmail.com" }
}
```

---

## 3. Hashes de Persisted Queries

**ADVERTENCIA CRÍTICA:** Los hashes se rompen con cada deploy de Steelhead. La extensión Chrome debe incluir un mecanismo de detección y actualización de hashes (idealmente via HAR capture automatizado).

### Mutations (probadas y confirmadas 2026-03-27)

| Operación | sha256Hash | Variables confirmadas |
|---|---|---|
| CreateQuote | `ee313e1243e786915d564eee8b005f0a0c2d39525b76467ece84b6debaa3d129` | `{name, assigneeId, customerId, validUntil, followUpDate, customerAddressId, customerContactId, stagesRevisionId:306, lowCodeEnabled:false, autoGenerateLines:false, lowCodeId:null, customInputs, inputSchemaId:659, invoiceTermsId, orderDueAt:null, shipToAddressId}` |
| UpdateQuote | `765fc26af87241f0f614a51fe3583e10d2f1765dafb1426402f69dcc79e33a8e` | `{id, notesMarkdown}` o `{id, internalNotesMarkdown}` |
| SaveQuoteLines | `b227e2f5a5b40021383077e58ab311169da2d5438d566bfe389fd7642e4d1937` | `{input:{quoteId, quoteLines:[...], quoteLinesToDelete:[], quoteLineItemsToDelete:[], quoteLineNumberUpdates:[]}}` |
| CreateQuoteStageChange | `85c945f12f3367a132607ab1ae22d1e3a8a43d78b836c564840d4251f66e4797` | *(no usado actualmente)* |
| SaveManyPNP (Quote ctx) | `af7b81567691854da4b9bbdf473b2732d89e3e6224ba52cbfb3d13dbfa93841b` | `{input:{quoteId, autoGenerateQuoteLines:true, partNumberPrices:[...], partNumberPriceIdsToDelete:[], quotePartNumberPriceLineNumberOnlyUpdates:[]}}` |
| SaveManyPNP (PN ctx) | `bd2db06e8e0b0a66cb65ada5b5433d9c5abe981b4aee4b39b86be4bba077cd05` | Fallback del anterior |
| SavePartNumber | `31a6c7d99c525979acea562cc892fa0968b439f10c79341f4de8748cc4a6cce9` | `{input:[{id, name, customerId, ...}]}` |
| SavePartNumberRackTypes | `087af4e8b489edc1c6ade599da96f368fc3a764f2f16093feae9c57ee81cb363` | `{input:{partNumberRackTypes:[...], partNumberRackTypeIdsToDelete:[]}}` |
| SetPNPricesDefault | `9f89b40ef7d5754e8e94a94b028ce4c54c3cbf53a102098fd4d3cbec28c9e293` | `{partNumberPriceIds:[N]}` |
| UpdatePartNumber | `af584fa8ebb7487fc84de18fa3a5e360e99699a3280185fe98b840c157bbf2c7` | `{id, archivedAt}` |
| CreatePartNumberGroup | `81edc50920e0ab37d470720a29160d74c6856aea6498b02543707dedfc405202` | `{input:{name}}` |

### Queries (probadas y confirmadas)

| Operación | sha256Hash | Variables |
|---|---|---|
| GetQuote v8 | `15db7a9b0325c45c181d7be61e223d1dbede8179433a25db36ebc9699097acb6` | `{idInDomain, revisionNumber:1}` |
| GetQuote v7.1 | `083046b3bca84f1bc8039145b40bdb10625194735ff18ce0c3815d83600ecd99` | Fallback del anterior |
| GetQuoteRelatedData | `04cc75ea43a2860a31e3f5043bb00e83d4c67a8b49b1d86c59cf65b72583f480` | `{customerId}` |
| CustomerSearchByName | `c06fb4c3b770a89c02d00ac51b92be6e1efe98bf5f6f5caccfe753f0570e6f02` | `{nameLike:"%X%", orderBy:["NAME_ASC"]}` |
| CustomerFinancialById | `7ea934f4e057c922f5ea1fbf832fd5b301a34784efc563e964abe4467689d1b9` | `{id: customerId}` (⚠️ NO `{customerId}`) |
| SearchInvoiceTerms | `26f2915bfe50e633829a1d85f58ff6578a31c2e22901094d2a92a9a71e222dca` | `{termsLike:"%%"}` (⚠️ NO `{}`) |
| SearchUsers | `6a422f35513d85386355f874c14cfb5d80ab38f46210e54c4d3a56ba764ddaa3` | `{searchQuery:"...", first:50}` (⚠️ requiere `first`) |
| AllProcesses | `b66651f7c159e7fdef35d67fe27048ea68f1f206531a31256fc8663f52707092` | `{includeArchived:"NO", processNodeTypes:["PROCESS"], searchQuery:"%X%", first:50}` |
| AllLabels | `2b16b142d01daddf7cf4b29efc7754161a414afdd22630daa6494d894aa3073c` | `{condition:{forPartNumber:true}}` |
| SearchSpecsForSelect | `8e7723b3a4cf3e7b692999e45d20b7299952253089c7bf146d36ff2872507e2b` | `{like:"%%", locationIds:[], alreadySelectedSpecs:[], orderBy:["NAME_ASC"]}` |
| TempSpecFieldsAndOptions | `c881d971a4c9fcd3849129e27fcc21546ad8eca732f6248ea523c3fbd89502ea` | `{specId: N}` |
| AllRackTypes | `7d601c396bb27a5534424582bcc9e44262781414cbb3e60c09413922775eaef3` | `{}` |
| SearchUnits | `b0750f8a59b649944906b1a6275bfbe562b3eb79836292807f760b3b5b425428` | `{}` |
| SearchProducts | `b835021eff4113acd5529f63fa742a9b70373c62a5d9cb39f4203fe2bbba9f8a` | `{searchQuery:"%%", first:200}` |
| SearchPartNumbers | `63ba50ed71fbf40476f1844b841351766eefbb147613b51b33919b4f4b2d4d91` | `{searchQuery:"X", first:20, offset:0, orderBy:["ID_DESC"]}` |
| GetPartNumber | `55bf9e21d5d1e1c9dbb7ddb4d993005a7f0ae1f75fe556e63300d43754a412d0` | `{partNumberId:N, usagesLimit:10, usagesOffset:0}` |
| PNGroupSelect | `da00a1e356e8a3d1e1020fd64c0b6b26f989650a2d4177fb5485629b11ef7e4c` | `{partNumberGroupLike:"%%"}` |
| PNCreatableSelect | `723dbb599905cf895d306707fc01ed232486ad8190b1cf2649166f57b137d83f` | `{hideCustomerPartsWhenNoCustomerIdFilter:true, name:"%", searchQuery:"", customerId:N}` |

### Hashes adicionales (capturados pero no usados en v8.4)

```
AllQuotes                      778d2eaf3ecde091815b264facc2797baabf2151ccb434312cd6ee9a374629a8
GetQuoteSecondary              546aa58c4f63f2b4be2703dc5c8482a07f01e8b96176171bfa9e978ac605458d
RouteQuotes                    1d352f1f612f4197113d12d1d395017f2812623bfe6625254e634cd6d26589d6
QuotePartNumberInfo            59bfbd894f593ca864c3aa1670c4d7f081a6cf47bd49a5459ba4b8d07b9e47ea
QuoteProcessNodeInfo           b75d4e7b194a40623917a3c6ed599fbdf7d65dd21291caccb1223721d818c7b7
GetDefaultProcessNode          b44bdc7b0a9264f1d2e8ec16cc1040128e5ca57653502cd03175cdaaef78a5bf
GetFullTreatmentDataForQuote   36576553326af78e9c295a07d515e859b15dfbea5fb5f44ac4005a12c1f8bd0e
AllPartNumbers                 7e3e96166d1ee3ac25323ee9c83bce1a228ee64f14f78c79f05ba25a9102f18e
GetPartNumberForPartNumberPage 8cda2296a59317a1ee4827946ef8e315a5d4312e4d43af5e58059f78ea44a75b
GetPartNumberPriceById         47c080e3e277c30bfe72c58bbc222fdbd184a9a9f64ac9ca65ee2ea6cda2a4b2
CreateEditPartNumberDialogQuery 5438bc7c18e11057a474b07f84f14dc1f4b3aa354a8846b2ce26eb73b57213a3
PartNumberDialogProcessQuery   01d7d09423a65ca3772be469cb87aa7b7703064a7e4931f1b90a7622cd0f94b2
UpdatePartNumberInputs         283e3cfe4f07dd843e8fb40655e158e588ddf8c8cf901f754982988a74c4622e
GeometryTypeSelect             2de8aaa4c6e5e21d78bd2e754182025ee011d113a1a8e62439c19487d18f16c4
SearchInventoryItems           b49500cf5fefd7115bd94f5d33bd108cf91b75c47166bb56c7adc08daa0f8432
SearchPartNumbersForSelect     cbdd5eb9c9d256c076f8658417dcd9f23d97b4caac01c1d372d91ace392e963d
GetCustomerNameById            bd6d1893e434c5390373ba2b2446fcac7ce5f7d229eeba47634f9120f83ca4c8
SearchTaxCodes                 88760b546a40f2b4a0cb310bbdd82c324015915968ffdd3bc3f8123200490af0
```

---

## 4. Constantes del dominio Ecoplating

```javascript
const DOMAIN = {
  id: 344,  // Toluca (Ecoplating). Monterrey (Proquipa) = 390
  inputSchemaId_PN: 3456,
  inputSchemaId_Quote: 659,
  stagesRevisionId: 306,
  geometryGenericaId: 831,
  unitMTR: 3971,
  validacionProcessNodeId: 231176,

  unitIds: { KGM:3969, LBR:3972, FTK:4797, CMK:4907, FOT:5148, LM:5150, LO:5348 },
  conversions: { KGM_TO_LBR:2.20462, CMK_TO_FTK:1/929.0304, LM_TO_FOT:3.28084 },
  geomDims: { LENGTH:1284, WIDTH:1011, HEIGHT:1012, OUTER_DIAM:1013, INNER_DIAM:1014 },

  empresas: {
    ECO: 'ECO030618BR4 - ECOPLATING SA DE CV, Primero de Mayo 1803, Zona Industrial Toluca, Santa Ana Tlapaltitlán Toluca, Estado de México 50071 México',
    PRO: 'PRO800417TDA - PROQUIPA SA DE CV, Primero de Mayo 1801, Zona Industrial Toluca, Santa Ana Tlapaltitlán Toluca, Estado de México 50071 México',
  },

  defaultQuoteCI: {
    Comentarios: { CargosFletes:true, CotizacionSujetaPruebas:true, ReferirNumeroCotizacion:true, ModificacionRequiereRecotizar:true },
    DatosAdicionales: { Divisa:'USD', Decimales:'2', EmpresaEmisora:'', MostrarProceso:false, MostrarTotales:true },
    Autorizacion: {},
    CondicionesComerciales: {},
  },
};

const PREDICTIVE_MATERIALS = [
  { col:51, inventoryItemId:364506, name:'Plata Fina', purchaseUnit:'KGM' },
  { col:52, inventoryItemId:397490, name:'Estaño Puro', purchaseUnit:'KGM' },
  { col:53, inventoryItemId:412305, name:'Níquel Metálico', purchaseUnit:'KGM' },
  { col:54, inventoryItemId:412805, name:'Zinc Metálico', purchaseUnit:'KGM' },
  { col:55, inventoryItemId:412479, name:'Placa de Cobre Electrolítico', purchaseUnit:'KGM' },
  { col:56, inventoryItemId:412723, name:'Sterlingshield S (Antitarnish)', purchaseUnit:'LTS' },
  { col:57, inventoryItemId:702767, name:'Epoxy MT', purchaseUnit:'LBR' },
  { col:58, inventoryItemId:702769, name:'Epoxica BT', purchaseUnit:'LBR' },
  { col:59, inventoryItemId:702768, name:'Epoxica MT Red', purchaseUnit:'LBR' },
];

const PRICE_UNIT_MAP = { PZA:null, KGM:3969, CMK:4907, FTK:4797, LM:5150, LBR:3972, LO:5348 };

const DIVISA_SCHEMA = {
  type:"object", title:"", required:["DatosPrecio"],
  properties:{ DatosPrecio:{ type:"object", title:"Datos del Precio", required:["Divisa"],
    properties:{ Divisa:{ enum:["USD","MXN"], type:"string", title:"Divisa",
      enumNames:["USD - Dolar americano","MXN - Peso mexicano"] }},
    dependencies:{} }},
  dependencies:{}
};
const DIVISA_UI = { "ui:order":["DatosPrecio"], DatosPrecio:{ "ui:order":["Divisa"], Divisa:{"ui:title":"Divisa"} }};
```

---

## 5. Flujo de ejecución actual (v8.4)

```
USUARIO: Abre CSV → Bookmarklet lee archivo

FASE PRE-EJECUCIÓN:
  1. Parse CSV (61 cols, header key-value + data rows)
  2. Resolve cliente (CustomerSearchByName)
  3. Resolve datos relacionados (GetQuoteRelatedData, CustomerFinancial, SearchInvoiceTerms)
  4. Resolve asignado (SearchUsers)
  5. Resolve proceso (AllProcesses o por ID directo)
  6. Cargar catálogos en paralelo:
     - AllLabels, SearchSpecsForSelect, AllRackTypes, SearchUnits, SearchProducts, PNGroupSelect
  7. Cache spec fields (TempSpecFieldsAndOptions por cada spec única)
  8. Verificar existencia PNs (SearchPartNumbers por cada nombre único)
  9. Mostrar modal PREVIEW (nuevo/existente/forzar duplicado)
  10. Usuario confirma → EJECUTAR

FASE EJECUCIÓN (9 pasos):
  Step 1: CreateQuote → obtener quoteId
  Step 2a: SavePartNumber(id:null) para PNs nuevos → obtener partNumberIds
  Step 2b: SaveManyPartNumberPrices (todos con partNumberId) → vincular a quote
  Step 3: GetQuote → re-leer quote para obtener QPNPs y QuoteLines auto-generadas
  Step 4: SaveQuoteLines → asignar productos a cada línea
  Step 5: UpdateQuote → notas externas/internas
  Step 6: SavePartNumber (enrich) → labels, specs, unitConv, CI, dims, predictive, optIn
  Step 7: SavePartNumberRackTypes → asignar racks
  Step 8: SetPNPricesDefault + UpdatePartNumber(archive) → precio default y archivar
  Step 9: Modal resultado con stats y errores
```

### Descubrimientos críticos (bugs corregidos)

| Bug | Causa raíz | Fix |
|---|---|---|
| SaveManyPNP 400 error | `newPartNumber` no existe en el schema `SavePartNumberPriceInput` | Crear PNs nuevos primero via `SavePartNumber(id:null)`, luego usar `partNumberId` |
| QuoteLines no encontradas | `autoGenerateQuoteLines: false` | Cambiar a `true` |
| Empresa Emisora en blanco | Acentos incorrectos en string constante | `Tlapaltitlán`, `México` |
| CSV truncado a 41 cols | VBA `ExportarCSV` borraba cols 42+ | Cambiar a 61/62 |
| SearchPartNumbers sin customerId | API no retorna `customerId` en la respuesta | Match por nombre exacto + no archivado |
| CustomerFinancial variable | Esperaba `{customerId}`, requiere `{id}` | Fix variable name |
| SearchInvoiceTerms variable | Esperaba `{}`, requiere `{termsLike:"%%"}` | Fix variables |
| SearchUsers variable | No incluía `first`, API lo requiere | Agregar `first:50` |

---

## 6. Layout CSV — 61 columnas (A-BI)

### Header (filas 3-17, key en col A, valor en col C)

```
Fila 3:  Modo             → COTIZACIÓN+NP / SOLO_PN
Fila 4:  Nombre Cotización → quoteName
Fila 5:  Cliente           → customer (NOMBRE — DIRECCIÓN)
Fila 6:  Etiquetas Cliente → (auto IFERROR/INDEX)
Fila 7:  Customer IdInDomain → (auto)
Fila 8:  Proceso (default) → processName
Fila 9:  ID Proceso        → processId (auto VLOOKUP)
Fila 10: Divisa (precios línea) → USD/MXN
Fila 11: Empresa Emisora   → ECO/PRO
Fila 12: Divisa Cotización  → USD/MXN
Fila 13: Notas Externas    → texto
Fila 14: Notas Internas    → texto
Fila 15: Asignado          → nombre vendedor
Fila 16: Válida Hasta (días) → 30
```

### Datos (fila 22+, 61 columnas)

```
Idx  Col  Campo                          Sección
0    A    Archivado (Sí/No)             PARÁMETROS
1    B    Validación 1er recibo (Sí/No)
2    C    Forzar duplicar (Sí/No)
3    D    Archivar anterior (Sí/No)
4    E    Número de parte (REQUERIDO)    IDENTIFICACIÓN
5    F    PN alterno (texto, comas)
6    G    Grupo (texto)
7    H    Cantidad (REQUERIDO)
8    I    Precio
9    J    Unidad precio (PZA/KGM/CMK/FTK/LM/LBR/LO)
10   K    Precio default (Sí/No)
11   L    Descripción
12   M    Metal base (desp.)             ACABADOS
13   N    Etiqueta 1 (desp.)
14   O    Etiqueta 2
15   P    Etiqueta 3
16   Q    Etiqueta 4
17   R    Proceso (desp.)                PROCESO
18   S    ID Proceso (auto VLOOKUP)
19   T    Producto 1                     PRODUCTOS ×3
20   U    Precio P1
21   V    Cant P1
22   W    Unidad P1
23   X    Producto 2
24   Y    Precio P2
25   Z    Cant P2
26   AA   Unidad P2
27   AB   Producto 3
28   AC   Precio P3
29   AD   Cant P3
30   AE   Unidad P3
31   AF   Spec 1 ("Nombre | Param")      SPECS ×2
32   AG   Esp. Spec 1 (µm)
33   AH   Spec 2
34   AI   Esp. Spec 2 (µm)
35   AJ   KGM (kg/pza)                   CONV. UNIDADES
36   AK   CMK (cm²/pza)
37   AL   LM (m/pza)
38   AM   Mín Pzas Lote
39   AN   Rack Línea                     RACKS ×2
40   AO   Pzas/Rack Línea
41   AP   Rack Sec.
42   AQ   Pzas/Rack Sec.
43   AR   Longitud (m)                   DIMENSIONES ×5
44   AS   Ancho (m)
45   AT   Alto (m)
46   AU   Diám.Ext (m)
47   AV   Diám.Int (m)
48   AW   Línea (Fase 2)                 ASIG. CONTABLE
49   AX   Departamento (Fase 2)
50   AY   Código SAT (desp.)
51   AZ   Plata (kg/pza)                 PREDICTIVE USAGE ×9
52   BA   Estaño (kg/pza)
53   BB   Níquel (kg/pza)
54   BC   Zinc (kg/pza)
55   BD   Cobre (kg/pza)
56   BE   Antitarnish (L/pza)
57   BF   Epóx. MT (lb/pza)
58   BG   Epóx. BT (lb/pza)
59   BH   Epóx. MT Roja (lb/pza)
60   BI   Total línea (fórmula)          CHECK
```

---

## 7. Payloads de referencia (estructuras completas)

### SavePartNumber (crear nuevo, id:null)

```json
{
  "input": [{
    "id": null,
    "name": "SEC11000-H02-1/4",
    "customerId": 166246,
    "defaultProcessNodeId": 213861,
    "inputSchemaId": 3456,
    "customInputs": {
      "DatosFacturacion": { "CodigoSAT": "73181106 - Servicios de enchapado" },
      "DatosAdicionalesNP": { "BaseMetal": "Cobre", "NumeroParteAlterno": ["7348022308"] }
    },
    "geometryTypeId": 831,
    "labelIds": [10807, 10701],
    "partNumberGroupId": null,
    "descriptionMarkdown": "",
    "customerFacingNotes": "",
    "inventoryItemInput": {
      "materialId": null, "purchasable": false,
      "unitConversions": [
        { "unitId": 3969, "factor": 1.2 },
        { "unitId": 3972, "factor": 2.645 }
      ],
      "inventoryItemVendors": []
    },
    "inventoryPredictedUsages": [
      { "inventoryItemId": 364506, "usagePerPart": "0.34", "lowCodeId": null }
    ],
    "specsToApply": [{
      "specId": 123, "classificationSetId": null, "classificationIds": [],
      "defaultSelections": [{ "defaultParamId": 456, "processNodeId": 162045, "processNodeOccurrence": 1, "locationId": null, "geometryTypeSpecFieldId": null }],
      "genericSelections": []
    }],
    "optInOuts": [{ "processNodeId": 231176, "processNodeOccurrence": 1, "cancelOthers": false }],
    "partNumberDimensions": [
      { "geometryTypeDimensionTypeId": 1284, "unitId": 3971, "dimensionValue": 0.4 }
    ],
    "dimensionCustomValueIds": [],
    "defaults": [], "ownerIds": [], "paramsToApply": [],
    "partNumberLocations": [],
    "partNumberSpecsToArchive": [], "partNumberSpecsToUnarchive": [],
    "partNumberSpecFieldParamsToArchive": [], "partNumberSpecFieldParamsToUnarchive": [],
    "partNumberSpecClassificationsToUpdate": [],
    "partNumberSpecFieldParamUpdates": [], "specFieldParamUpdates": [],
    "glAccountId": null, "taxCodeId": null, "certPdfTemplateId": null,
    "userFileName": null,
    "isOneOff": false, "isTemplatePartNumber": false, "isCoupon": false
  }]
}
```

**Response:**
```json
{ "data": { "savePartNumbers": [{ "id": 3426260, "name": "SEC11000-H02-1/4", ... }] } }
```

### SaveManyPartNumberPrices (en contexto Quote)

```json
{
  "input": {
    "quoteId": 287209,
    "autoGenerateQuoteLines": true,
    "partNumberPrices": [{
      "partNumberId": 3426260,
      "processId": 162045,
      "customInputs": { "DatosPrecio": { "Divisa": "USD" } },
      "inputSchema": "<<DIVISA_SCHEMA>>",
      "uiSchema": "<<DIVISA_UI>>",
      "partNumberPriceLineItems": [{ "title": "", "price": 1.5, "productId": null, "quoteInventoryItemId": null }],
      "usePartNumberDescription": true,
      "treatmentSelections": [], "priceBuilders": [],
      "informationalPriceDisplayItems": [], "priceTiers": [],
      "unitId": 3969,
      "partNumberCustomInputs": null,
      "quotePartNumberPrice": { "savedQuotePartNumberPriceId": null, "quoteId": 287209, "quantityPerParent": 100, "lineNumber": 1 }
    }],
    "partNumberPriceIdsToDelete": [],
    "quotePartNumberPriceLineNumberOnlyUpdates": []
  }
}
```

**⚠️ IMPORTANTE:** `newPartNumber` NO existe en el schema. Siempre usar `partNumberId`. PNs nuevos se crean primero via `SavePartNumber(id:null)`.

---

## 8. Modelo de entidades Quote

```
Quote
  ├── customInputs (inputSchemaId: 659)
  │     ├── Comentarios (flags booleanos)
  │     ├── DatosAdicionales (Divisa, EmpresaEmisora, etc.)
  │     ├── Autorizacion
  │     └── CondicionesComerciales
  ├── Customer → CustomerAddress, CustomerContact
  ├── InvoiceTerm
  ├── Assignee (User)
  ├── QuoteStageRevision (306)
  └── QuoteLines[]
        └── QuoteLine
              ├── QuoteLineItems[]
              │     ├── Product (categoría contable: Plateado, Empacado, etc.)
              │     └── QuotePartNumberPrice → PartNumberPrice → PartNumber
              └── autoGeneratedFromQuotePartNumberPriceId (link inverso)
```

---

## 9. Fórmulas de consumo (Predictive Usage)

```
Metales (kg/pza): densidad × área(cm²) × espesor(µm) / 10,000,000
  Densidades: Ag=10.5, Sn=7.3, Ni=8.9, Zn=7.13, Cu=8.96
  Espesor se rutea automáticamente via keyword SEARCH en nombre de Spec

Antitarnish (L/pza): 0.0012 × cobre_kg
  Solo si labels contienen "Antitarnish"

Epóx MT (lb/pza): 1069.98 × LM / 453.592
Epóx BT (lb/pza): 165.60 × LM / 453.592
Epóx MT Roja (lb/pza): MT × 1.07
  Solo si labels contienen "Epóx"/"Epox"/"Barniz"
```

---

## 10. Hash discovery (steelhead-interceptor)

Existe un proyecto local Node.js con Playwright (`steelhead-interceptor`) que automatiza la captura de tráfico GraphQL via HAR files para descubrir nuevos hashes cuando Steelhead despliega actualizaciones.

### Uso con Claude Code
Claude Code puede abrir Chrome con `--remote-debugging-port` y usar CDP (Chrome DevTools Protocol) para:
1. Interceptar requests a `/graphql`
2. Extraer `operationName` + `sha256Hash` de cada request
3. Comparar contra hashes conocidos
4. Alertar sobre hashes nuevos o rotos

### Alternativa: La extensión Chrome misma puede interceptar
Con `chrome.webRequest.onBeforeRequest` la extensión puede capturar todos los requests GraphQL del SPA de Steelhead y auto-actualizar su tabla de hashes.

---

## 11. Pendientes para extensión Chrome v9

### Prioridad 1: Core funcional
- [ ] Migrar lógica de bookmarklet a content script / background worker
- [ ] UI panel lateral (side panel) o popup con preview y controles
- [ ] Gestión de hashes (storage sync, auto-detect broken hashes)
- [ ] CSV file picker nativo (no prompt)

### Prioridad 2: Features faltantes
- [ ] Modo SOLO_PN (sin crear cotización)
- [ ] Centinela: vacío = no tocar, guión(-) = borrar dato
- [ ] Discrepancias: comparar datos existentes vs CSV antes de sobreescribir
- [ ] dimensionCustomValueIds (Línea, Departamento) — requiere capturar IDs de AcctDimension

### Prioridad 3: Robustez
- [ ] Validación pre-envío (campos requeridos, formatos)
- [ ] Detección de hash expirado + re-discovery automático
- [ ] Retry inteligente con backoff
- [ ] Exportar/importar configuración de hashes

### Prioridad 4: Catalog Refresher
- [ ] Bookmarklet/panel separado que descarga catálogos de SH y genera Excel actualizado
- [ ] Reemplaza el proceso manual de copiar reportes

---

## 12. Reglas de desarrollo

1. **No hay queries GraphQL en texto** — solo persisted queries con sha256Hash
2. **Apollo client version** en extensions debe ser exactamente `"4.0.8"`
3. **Steelhead backend silently strips** campos no reconocidos del output de scripts
4. **formatXml y helpers** deben ser `const` arrow functions, no `function` declarations
5. **Entrega archivos completos** para cada cambio, no diffs parciales
6. **Archiva PNs de prueba** entre iteraciones para evitar constraint errors de duplicados
7. **`usagePerPart`** en predictive usage es `String`, no `Number`
8. **Empresa Emisora** strings deben tener acentos exactos (Tlapaltitlán, México)
9. **URL de cotización:** `/Domains/{domainId}/Quotes/{idInDomain}` — domainId se auto-detecta de `window.location.pathname` (344=Toluca, 390=Monterrey)

---

## 13. Archivos del proyecto

| Archivo | Descripción | Estado |
|---|---|---|
| `dataLoader_v84.js` | Bookmarklet principal, 580 líneas | ACTIVO |
| `instalar_bookmarklet_v84.html` | Installer HTML con TextDecoder para UTF-8 | ACTIVO |
| `Plantilla_Cotizaciones_y_NP_v84.xlsx` | Template Excel, 61 cols, sin macros | ACTIVO |
| `VBA_Module1_v84.txt` | ExportarCSV (61 cols) — pegar en Excel | ACTIVO |
| `VBA_Module2_RefrescarListas.bas` | RefrescarListas — importar en Excel | ACTIVO |
| `SPEC_v8_DataLoader.md` | Spec original del proyecto | Referencia |
| `steelhead-quote-api-reference.md` | API reference Quotes | Referencia |
| `steelhead-pn-api-reference.md` | API reference Part Numbers | Referencia |
| `steelhead-pn-optins-dimensions-api-reference.md` | API reference OptIns/Dims | Referencia |

---

## 14. DuckDB (reporting DB)

Steelhead expone una base DuckDB de solo lectura para reportes:
- DB: `reporting`, schema: `main`, ~150 tablas
- Version: 1.2.2, extensions: `core_functions`, `icu`, `json`
- Read-only: usar CTEs en un solo `SELECT` (no `CREATE TABLE`)
- Refresh: nightly
- Referencia: `Tablas_y_Campos_SH_DuckDB.csv` (1,557 rows)

Tablas relevantes: `part_number`, `quote`, `quote_line`, `customer`, `invoice`, `work_order`, `inventory_item`, `spec`, `label`, `rack_type`, `product`, `user`, etc.
