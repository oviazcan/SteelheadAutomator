# `bulk-upload` — Documentación end-to-end

> **Versión auditada:** 1.5.14  
> **Fecha de auditoría:** 2026-05-30  
> **Archivo fuente:** `remote/scripts/bulk-upload.js` (6 850 líneas)  
> **Bitácora de cambios:** `docs/applets/bulk-upload.md`  
> **Regla maestra de negocio:** El applet NUNCA debe ignorar silenciosamente algo que el CSV trae. Si hay un valor, debe aplicarse o generar un error visible. Preservar-on-missing (solo cuando el CSV NO trae el campo) es correcto.

---

## Índice

1. [Parte 1 — Mapeo CSV → GraphQL por campo](#parte-1--mapeo-csv--graphql-por-campo)  
   a. [Layout de columnas (v10 / v11)](#1a-layout-de-columnas-v10--v11)  
   b. [Tabla de mapeo campo por campo](#1b-tabla-de-mapeo-campo-por-campo)  
2. [Parte 2 — Pipeline completo](#parte-2--pipeline-completo)  
   a. [Fases en orden](#2a-fases-en-orden)  
   b. [Qué se persiste en resume](#2b-qué-se-persiste-en-resume)  
   c. [Fallos silenciosos vs visibles](#2c-fallos-silenciosos-vs-visibles)  
3. [Parte 3 — Lista de skips silenciosos](#parte-3--lista-de-skips-silenciosos)  
4. [Parte 4 — Diagnóstico del piloto Fisher (2026-05-30)](#parte-4--diagnóstico-del-piloto-fisher-2026-05-30)  
5. [Parte 5 — Plan de refactor](#parte-5--plan-de-refactor)  
6. [Parte 6 — Plan de validación del funcionamiento real](#parte-6--plan-de-validación-del-funcionamiento-real)

---

## Parte 1 — Mapeo CSV → GraphQL por campo

### 1a. Layout de columnas (v10 / v11)

El parser detecta el esquema leyendo la fila `Archivado` (col A) y chequeando col E:

| Esquema | Col E | Total cols | Diffs principales |
|---|---|---|---|
| **v10** (legacy) | `"Cliente"` | 69 (A..BQ) | Sin `Id SH`, sin `Tipo Geometría`. `Línea` en col AY=50. |
| **v11** (actual) | `"Id SH"` | 71 (A..BS) | +`Id SH` (E=4), +`Tipo Geometría` (AV=47). `Línea` movida a P=15. Predictivos en BD..BL=55..63. `Notas Adicionales` en col BS=70 (v11), col BQ=68 (v10). |

Si col E no es ninguno de los dos valores esperados: warn + default v11 (`bulk-upload.js:1214`).

**Importante:** el campo `linea` en v10 está en `COLS.linea = 50` pero en v11 está en `COLS.linea = 15`. El código v10 NO define `COLS.departamento` en el mismo índice que v11. Esto causa que en v10 el `departamento` esté en col 51 (AB) y en v11 en col 53 (BB).

---

### 1b. Tabla de mapeo campo por campo

Las funciones auxiliares usadas en la tabla:
- `g(row, col)` → string trimmed o `''`
- `gn(row, col)` → número o `null`
- `toBool(str)` → `'V'/'1'/'true'/'yes'/'x' → true`, el resto → `false`
- `isDash(v)` → `v === '-'`
- `resolveStr(raw, existing)` → si raw es vacío/undefined devuelve `existing`; si es `'-'` devuelve `''`; si no devuelve `raw`

**Semántica de dash (`-`):** borrar el campo (REPLACE semántico). Vacío = no tocar (preserve-on-missing). Valor explícito = sobrescribir.

---

#### Grupo 1 — Campos de control (no van a SH directamente)

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | Condición de skip | Observaciones |
|---|---|---|---|---|---|
| Archivado | A=0/0 | `toBool(g(row, 0))` | `part.archivado` → `UpdatePartNumber(archivedAt)` en STEP 8 | Solo cuando `part.archivado=true` (o false para desarchivar existentes). Si `null`, no aplica | No REPLACE-semantics en este campo |
| Validacion | B=1/1 | tri-state: vacío→`null`, valor→`toBool` | `part.validacion1er` → `optInOuts[]` en Call B | `null` → preserve existing. `false` → `[]` (desactiva). `true` → activa | Bug pre-1.5.13: `toBool('')=false` desactivaba silenciosamente |
| Forzar duplicado | C=2/2 | `toBool(g(row, 2))` | `part.forzarDuplicado` → `pnStatus.status='forceDup'` | No va a SH como campo — afecta clasificación | |
| Archivar anterior | D=3/3 | `toBool(g(row, 3))` | `part.archivarAnterior` → `archiveOps` en STEP 8 | Solo con `forceDup` | |
| Id SH | E=N/A / E=4 | `idShRaw.trim()` o `null` | Saltar `classifyOnePN`, match directo → `status='existing'` | Solo v11. Inválido + sin PN → `status='error'` | Bypass directo de pases 1/2/3 (`bulk-upload.js:1696-1710`) |

---

#### Grupo 2 — Identificadores del PN

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino GraphQL | Campo SH (SavePartNumber) | Condición de skip / preserve | REPLACE-semantics |
|---|---|---|---|---|---|---|
| Cliente | E=4 / F=5 | `g(row, COLS.cliente)` → split por `—`/`-` → `customerCache.get(nombre)` | `part.customerId` → `id` de SavePartNumber | `customerId` | Falla si nombre no existe en caché (error visible) | N/A |
| PN | F=5 / G=6 | `g(row, COLS.pn)` | `part.pn` → `name` en todos los inputs | `name` | Fila se ignora si vacío Y `idSh` también vacío | No (upsert por id) |
| Descripcion | G=6 / H=7 | `g(row, COLS.descripcion)` | `part.descripcion` → `resolveStr(part.descripcion, existingPnNode?.descriptionMarkdown)` | `descriptionMarkdown` | Vacío → preserve existing. `'-'` → `''` | No (upsert) |
| PN alterno | H=7 / I=8 | `g(row, COLS.pnAlterno)` | `part.pnAlterno` → `ci.DatosAdicionalesNP.NumeroParteAlterno` vía `mergeCustomInputs` | `customInputs.DatosAdicionalesNP.NumeroParteAlterno` | Vacío → preserve. `'-'` → `[]` | Dentro de `customInputs` (REPLACE del obj completo) |
| Grupo | I=8 / J=9 | `g(row, COLS.pnGroup)` | `resolveGroupId(part.pnGroup)` → `partNumberGroupId` | `partNumberGroupId` | Vacío → preserve existingPnNode. `'-'` → `null` | No (upsert) |

---

#### Grupo 3 — Precio y cotización (solo modo COTIZACIÓN+NP)

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino GraphQL | Condición de skip | REPLACE | Notas |
|---|---|---|---|---|---|---|
| Cantidad | J=9 / K=10 | `gn(row, COLS.qty)` | `SaveManyPartNumberPrices` → `partNumberPriceLineItems[0].qty` | Fila sin cantidad ni precio en SOLO_PN se ignora para precio | No | |
| Precio | K=10 / L=11 | `gn(row, COLS.precio)` | `SaveManyPartNumberPrices` | `null` → no se crea línea de precio standalone | No | |
| Unidad precio | L=11 / M=12 | `.toUpperCase()` → `PRICE_UNIT_MAP` | `unitId` en SaveManyPNP | Sin match → `null` (SH usa su default) | No | Skip silencioso si unidad no está en `PRICE_UNIT_MAP` |
| Divisa | M=12 / N=13 | `v !== '-' ? v.toUpperCase() : 'USD'` | `customInputs.DatosPrecio.Divisa` en precio | `'-'` → `'USD'` (no `null`) | No | |
| Precio default | N=13 / O=14 | `toBool(g(...))` | `SetPNPricesDefault` / `UnsetPartNumberPriceAsDefaultPrice` en STEP 8 | En SOLO_PN: requiere releer precios via `GetPartNumber` | No | |

---

#### Grupo 4 — Etiquetas y clasificación

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino GraphQL | REPLACE | Notas críticas |
|---|---|---|---|---|---|
| Línea | AY=50 / P=15 | `g(row, COLS.linea)` → `dimValueMap.get(valor)` → `dimensionCustomValueIds[]` | `dimensionCustomValueIds` en Call A y Call B | SÍ (REPLACE-semantics) | Vacío → preserve existing (desde `existingPnNode`). Bug pre-1.5.5: mandaba `[]` → borraba línea |
| Metal Base | O=14 / Q=16 | `g(row, COLS.metalBase)` → fuzzy match vs enum SH | `customInputs.DatosAdicionalesNP.BaseMetal` | Dentro de obj `customInputs` | Fuzzy: si no matchea exacto pero sí normalizado → corrige. Si totalmente nuevo → `confirm()` al usuario |
| Etq1..Etq5 | P-T=15-19 / R-V=17-21 | `COLS.labels.map(c=>g(row,c)).filter(Boolean)` → `labelByName.get(n)` → `labelIds[]` | `labelIds` en Call A y Call B | SÍ (REPLACE-semantics) | Vacío → preserve existing. `'-'` como primer label → borrar todo. Desconocido → error en `errors[]` pero no aborta |
| Departamento | AZ=51 / BB=53 | Igual que Línea | `dimensionCustomValueIds` | SÍ | Mismo mecanismo que Línea. Mismo preserve-on-missing |

---

#### Grupo 5 — Proceso

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino GraphQL | REPLACE | Notas críticas |
|---|---|---|---|---|---|
| Proceso | U=20 / W=22 | `g(row, COLS.proceso)` → `AllProcesses(searchQuery='%nombre%', first=50)` → `name.toUpperCase()===pname.toUpperCase()` | `defaultProcessNodeId` en Call A, Call B, STEP 5 | No (upsert) | Vacío → preserve existing (`st.existingProcessId`). `'-'` → borrar (null + `clearDefaultProcess=true`). No encontrado → `unresolvedNames` → modal `confirmUnresolvedProcesses` |

**Nota de arquitectura crítica:** `clearDefaultProcess: true` se setea en `part` (`bulk-upload.js:3842`) pero **no se usa en ningún input de SavePartNumber**. El campo `defaultProcessNodeId` se pone en `null` como consecuencia, pero `clearDefaultProcess` propiamente dicho es un flag muerto que no se transfiere al payload GraphQL. Esto no es un bug funcional (null en `defaultProcessNodeId` borra el proceso) pero el flag es engañoso para futuros mantenedores.

---

#### Grupo 6 — Productos (insumos de cotización)

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | REPLACE | Notas |
|---|---|---|---|---|---|
| Prod1 nombre | V=21 / X=23 | `g(row, COLS.prods[0][0])` | `products[0].name` → `SaveQuoteLines` como line item | No aplica (append) | Solo en modo COTIZACIÓN+NP |
| Prod1 precio | W=22 / Y=24 | `gn(row, ...)` → default `0` | `products[0].price` | No | |
| Prod1 cantidad | X=23 / Z=25 | `gn(row, ...)` → default `1` | `products[0].qty` | No | |
| Prod1 unidad | Y=24 / AA=26 | `g(row, ...)` | `products[0].unit` → `resolveUnitId` | No | |
| (Prod2 y Prod3 son idénticos) | | | | | |

---

#### Grupo 7 — Specs

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | REPLACE | Notas |
|---|---|---|---|---|---|
| Spec1 | AH=33 / AJ=35 | `g(row, COLS.specs[0][0])`. Si contiene ` \| ` → `{name, param}`. De lo contrario `{name, param:''}` | `specsToApply[]` en Call B | No (add-only en specsToApply). Params: REPLACE en STEP 6b | `'-'` como nombre → `hasArchiveSentinel=true` → archiva specs vigentes en STEP 5 |
| Spec1 UM | AI=34 / AK=36 | `g(row, COLS.specs[0][1])` → va embebido en `spec.param` | Param dentro de `specsToApply` | | Unidad de medida del espesor en STEP 6b |
| (Spec2 ídem) | | | | | |

---

#### Grupo 8 — Unidades de conversión (inventario)

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | REPLACE | Notas |
|---|---|---|---|---|---|
| KGM | AL=37 / AN=39 | `gn(row, COLS.kgm)` | `inventoryItemInput.unitConversions[]` via `unitIds.KGM + KGM_TO_LBR` | SÍ (REPLACE del obj `inventoryItemInput`) | Vacío → preserve existing (desde `existingPnNode.inventoryItemByPartNumberId`). `'-'` en cualquier UC → `inventoryItemInput=null` (borra UCs) |
| CMK | AM=38 / AO=40 | `gn(row, COLS.cmk)` | Igual | | |
| LM | AN=39 / AP=41 | `gn(row, COLS.lm)` | Igual | | |
| Min Pzas Lote | AO=40 / AQ=42 | `gn(row, COLS.minPzasLote)` | `inventoryItemInput.defaultLeadTime` (¿o mínimo lote?) — **pendiente de verificar campo exacto** | | |

---

#### Grupo 9 — Racks

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | REPLACE | Notas |
|---|---|---|---|---|---|
| Rack Linea | AP=41 / AR=43 | `g(row, COLS.rackLinea[0])` | `SavePartNumberRackTypes` en STEP 7 | No (upsert) | `'-'` como nombre → `racksToDelete.add(pnId)` → borra todos los racks del PN |
| Pzas R.L. | AQ=42 / AS=44 | `Math.floor(gn(row, ...))` | `partsPerRack` | | `ppr=null` → se salta la fila de rack |
| Rack Sec | AR=43 / AT=45 | Igual | | | |
| Pzas R.S. | AS=44 / AU=46 | Igual | | | |

---

#### Grupo 10 — Tipo de geometría y dimensiones físicas

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | REPLACE | Notas |
|---|---|---|---|---|---|
| Tipo Geometría | N/A / AV=47 | `g(row, COLS.tipoGeometria) \|\| null` | `resolveGeometryTypeId(name)` → `geometryTypeId` en Call A y Call B | No (upsert) | v10 no tiene este campo → fallback: si `hasDims` → `DOMAIN.geometryGenericaId`. Auto-crea si no existe |
| Long | AT=45 / AW=48 | `gn(row, COLS.dims.length)` | `buildDimensions({length,...})` → `{geometryTypeDimensionTypeId: DOMAIN.geometryDimensions.LENGTH, unitId: DOMAIN.unitIds.MTR, dimensionValue: val}` | SÍ (REPLACE del array `partNumberDimensions`) | `'-'` en Long → `dimsAreDash=true` → `dims=[]` → borra dims. Vacío → preserve existing desde `existingPnNode` (fix 1.5.14) |
| Ancho | AU=46 / AX=49 | `gn(...)` | Igual | | |
| Alto | AV=47 / AY=50 | `gn(...)` | Igual | | |
| D.Ext | AW=48 / AZ=51 | `gn(...)` | Igual | | |
| D.Int | AX=49 / BA=52 | `gn(...)` | Igual | | |

---

#### Grupo 11 — Campos de planificación y notas (vía customInputs)

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino GraphQL | REPLACE | Notas |
|---|---|---|---|---|---|
| Codigo SAT | BA=52 / BC=54 | `g(row, COLS.codigoSAT)` | `customInputs.DatosFacturacion.CodigoSAT` | Dentro del obj REPLACE | Vacío → preserve existing |
| PiezasCarga | BN=65 / BP=67 | `gn(...)` | `customInputs.DatosPlanificacion.PiezasCarga` | Dentro del obj REPLACE | `null` → no se toca. `'-'` → `null` |
| CargasHora | BO=66 / BQ=68 | `g(...)` | `customInputs.DatosPlanificacion.CargasHora` | | Vacío → preserve |
| TiempoEntrega | BP=67 / BR=69 | `gn(...)` | `customInputs.DatosPlanificacion.TiempoEntrega` | | |
| Notas Adicionales | BQ=68 / BS=70 | `g(row, COLS.notas)` | `customInputs.NotasAdicionales` | | Vacío → preserve |
| QuoteIBMS | BK=62 / BM=64 | `g(...)` | `customInputs.DatosAdicionalesNP.QuoteIBMS` | | |
| EstacionIBMS | BL=63 / BN=65 | `g(...)` | `customInputs.DatosAdicionalesNP.EstacionIBMS` | | |
| Plano | BM=64 / BO=66 | `g(...)` | `customInputs.DatosAdicionalesNP.Plano` | | |

**Nota REPLACE para customInputs:** Steelhead aplica REPLACE-semantics al objeto `customInputs` completo. La función `mergeCustomInputs` hace deep clone del objeto existente y solo sobreescribe los sub-campos que el CSV trae explícitamente. Esto evita borrar campos no mencionados en el CSV.

---

#### Grupo 12 — Predictivos (inventario)

| Columna CSV | Índice v10/v11 | Cómo se parsea | Destino | REPLACE | Notas |
|---|---|---|---|---|---|
| Plata (BD=55/BD=55) | 53/55 | `raw==='-'` → `{usagePerPart:'-'}` / `gn()>0` → `{usagePerPart: String(val)}` / vacío → skip | `inventoryPredictedUsages[]` en Call B (solo nuevos). Existentes → `UpdateInventoryItemPredictedUsage` batch-20 en STEP 6a | No (upsert individual) | Vacío → no tocar. `'-'` → `ArchivePredictedInventoryUsage`. Valor numerico → upsert/update |
| Estano .. Epox.MTR | Análogo (9 materiales) | Igual | Igual | | Bug pre-VBA v14: CSV truncaba a 4 decimales → `microQuantityPerPart` impreciso |

---

### Resumen de campos que NO van a SH en v11

Los siguientes campos del CSV existen en el parser pero sus valores pueden no llegar a SH:

- **`validaDias`** (header del CSV, no por PN): va a `UpdateQuote` como duración de cotización. No aplica a SOLO_PN.
- **`notasInternas`** (header): va a `UpdateQuote.internalNotesMarkdown`. No aplica a SOLO_PN.
- **`asignado`** (header): busca el usuario en SH para assignar la cotización. No aplica a SOLO_PN.
- **Columnas `PARÁMETROS`/encabezado**: filtradas por `isHeaderRow=true` antes de llegar a `parts[]`.

---

## Parte 2 — Pipeline completo

### 2a. Fases en orden

```
CSV FILE
  │
  ▼
[parseCSV + parseRows]
  Detecta schema (v10/v11), parsea header-metadata y filas de datos.
  Output: { header, parts[] }
  └── Filtros: filas sin PN ni idSh → drop silencioso

[Catálogos: customers, labels, groups, specs, racks, units, geometry]
  AllClassifications, AllLabels, PNGroupSelect, AllSpecs, AllRackTypes, SearchUnits
  AllGeometryTypes (solo v11)
  Output: caches en memoria (labelByName, specByName, groupByName, rackTypeByName…)

[Resolver processes]
  AllProcesses(%nombre%, first=50) por cada nombre único del CSV.
  Output: processCache (nombre→id) + unresolvedNames
  Si unresolvedNames: modal confirmUnresolvedProcesses → preserve (vaciar) o abort

[Annotate parts con processId y customerId]
  p.processId = processCache.get(nombre) o null
  p.customerId = customerCache.get(nombre).id

[classifyPNs]  ← PASO CLAVE
  Si parts.length > 1000: classifyPNsMassive (prefetch global)
  Si no: classifyPNsOnDemand (on-demand por nombre)
  Output: pnStatus[] con {status, existingId, existingProcessId, ...}

[Post-process proceso vacío/dash]
  Resolver vacío → heredar existingProcessId o null (con warn)
  Resolver '-' → null + clearDefaultProcess flag (semántico, no enviado)

[Validaciones preflight: Metal Base, Grupos, Labels no encontradas]
  confirm() al usuario si Metal Base o Grupos nuevos
  warn() si labels no encontradas en catálogo

[showPreview]
  Modal con lista de MODIFY/NEW/ERROR por pase y clasificación.
  Usuario puede ajustar overrides o cancelar.
  Output: selectedIndices[] (filas que el usuario aprobó)

[STEP 1: LoadCatalogData]  ← ya hecho arriba (inline en execute)

[STEP 2a: Crear PNs nuevos (NEW/forceDup)]
  SavePartNumber con payload MÍNIMO:
    {id:null, name, customerId, defaultProcessNodeId:processId,
     customInputs:{}, labelIds:[], dims:[], specsToApply:[], ...}
  Output: newPnIds Map(idx→id)

[STEP 3: Cotizaciones — solo COTIZACIÓN+NP]
  CreateQuote / SaveQuoteLines / SaveManyPartNumberPrices
  Chunk loop por cliente × chunkSize (default 250)
  Output: pnLookup Map(idx→{pn, qpnp, ql})

[STEP 1/solo: Construir pnLookup — solo SOLO_PN]
  Mapa idx→{pn sintético: {id, name, customerId, processId, customInputs:{}, geometryTypeId:null, ...}}
  Precio standalone: SaveManyPartNumberPrices(quoteId:null)

[STEP 4.5: Desarchivar PNs que llegaban archivados]
  UpdatePartNumber(archivedAt:null) para wasArchived=true

[STEP 5: Archive specs sentinel pre-cotización — solo COTIZACIÓN+NP]
  Para PNs existing con specs '-' → SavePartNumber que archiva spec vigente
  Preserva labels/dims existentes del pnNode

[STEP 6: enrichWorker en pool (concurrency=8 por default)]
  Por cada PN (existing y new):
    1. Fetch existingPnNode via GetPartNumber (si existing o forced fetch)
    2. Calcular labelIdsToSend con preserve-on-missing
    3. Calcular dimValueIdsToSend (Línea/Depto) con preserve-on-missing
    4. Call A (identifier-enrich):
         SavePartNumber con: name, customerId, descriptionMarkdown, customerFacingNotes,
           customInputs (mergedCI), labelIds, partNumberGroupId, defaultProcessNodeId,
           geometryTypeId, dimensionCustomValueIds
         (specsToApply=[], dims=[], optInOuts=[] — solo identificadores)
    5. Calcular dims con preserve-on-missing (fix 1.5.14)
    6. Calcular geometryTypeId (v11: resolveGeometryTypeId; v10: DOMAIN.geometryGenericaId si hasDims)
    7. Calcular inventoryItemInput con preserve-on-missing
    8. Calcular optInOuts tri-state (fix 1.5.13)
    9. Call B (full-enrich):
         SavePartNumber con TODOS los campos incluyendo specs, dims, proceso, predictive
         Si duplicate-key: strip1 (sin specs/optInOuts) → strip2 (mínimo)
    10. Calls dedicados para specs colisionantes (specField compartido)
    11. Persistencia resume incremental cada 50 PNs

[STEP 6a: Actualizar predictivos existentes]
  Unarchive primero (Fix JJ), luego UpdateInventoryItemPredictedUsage batch-20
  ArchivePredictedInventoryUsage para '-' granular

[STEP 6b: Sync params spec en PNs existentes]
  GetPartNumber → analizar specFieldParams activos vs wanted (regla 1.4.38)
  SavePartNumber con partNumberSpecFieldParamsToArchive (duplicados)
  AddParamsToPartNumber para params faltantes

[STEP 7: RackTypes]
  DeletePartNumberRackType para racksToDelete
  SavePartNumberRackTypes batch-50

[STEP 8: Default price + Archivar/Desarchivar]
  SetPNPricesDefault / UnsetPartNumberPriceAsDefaultPrice
  UpdatePartNumber(archivedAt) para PNs a archivar/desarchivar

[Reporte XLSX]
  Hoja Resumen + Hoja Decisiones Pase 3 + Hoja Errores

[Cleanup]
  closePanel libera listeners. existingPnFullCache.clear().
```

---

### 2b. Qué se persiste en resume

El resume vive en **IndexedDB** (`sa_storage` DB, `kv` store) desde 1.4.27. El schema del objeto `resumeState` es:

| Campo | Tipo | Qué contiene |
|---|---|---|
| `runId` | string | Hash de la corrida (SHA de CSV+headers) |
| `phase` | string | Última fase completada: `'idle'` / `'enrich-done'` / `'sync-done'` |
| `completedPNs` | `string[]` | `"idx\|pn\|customerId"` de PNs que completaron Call B (STEP 6) |
| `identifierEnrichDone` | `string[]` | `"idx\|pn\|customerId"` de PNs que completaron Call A |
| `archivedSentinelsPreQuote` | `number[]` | pnIds cuyas specs sentinel ya se archivaron en STEP 5 |
| `syncParamsCompletedPNs` | `string[]` | Keys de PNs que completaron STEP 6b |
| `classifications` | `object[]` | pnStatus serializado (sin candidates/csvLabels para ahorrar espacio) |
| `userOverride` | `object` | Overrides manuales del usuario en el preview |
| `chunkSize` | `number` | Chunk elegido por el usuario en preview |

**Qué se persiste y cuándo:**
- `completedPNs`: cada 50 PNs completados en STEP 6 (`bulk-upload.js:5519-5524`)
- `identifierEnrichDone`: cada 50 Call A completados (`bulk-upload.js:5239-5243`)
- `archivedSentinelsPreQuote`: al final del STEP 5 (`bulk-upload.js:4387-4390`)
- `syncParamsCompletedPNs`: cada 50 en STEP 6b (`bulk-upload.js:5900-5905`)
- `phase`: al terminar STEP 6 (`'enrich-done'`) y STEP 6b (`'sync-done'`)

**Lo que NO se persiste:** `existingPnNode` (se re-fetcha), el pnLookup completo, `errors[]` de la corrida.

---

### 2c. Fallos silenciosos vs visibles

| Situación | ¿Visible? | Mecanismo |
|---|---|---|
| PN sin entry en pnLookup (SaveManyPNP falló) | SÍ (desde 1.5.11) | `errors.push(...)` + `state.counters.errors++` |
| Etiqueta desconocida en CSV | SÍ (desde 1.2.10) | `errors.push(...)` |
| RackType no encontrado | SÍ | `errors.push(...)` |
| Spec no encontrada en catálogo | SÍ (warn) | `warn(...)` — no errors[] |
| SavePartNumber Call B falla tras 3 retries | SÍ | `errors.push(...)` |
| `AddParamsToPartNumber` exclusion-constraint | NO (skip silencioso) | `bulk-upload.js:5876-5878` |
| `UnsetPartNumberPriceAsDefaultPrice` falla | NO | `/* silencioso */` `bulk-upload.js:6197` |
| Dims malformados en STEP 6b cleanup (filtrados) | NO (filtro defensivo) | `filter(d => d.dimensionId && d.unitId != null)` |
| Pre-fetch predictivos falla | NO | `catch(_) {}` en `bulk-upload.js:4834` |
| GetPartNumber para default-price falla en STEP 8 | NO | `// silencioso — el default no se aplicará` `bulk-upload.js:6176-6179` |
| schema v11 indeterminado | WARN parcial | `warn(...)` + asume v11 |

---

## Parte 3 — Lista de skips silenciosos

Esta es la lista exhaustiva de lugares donde un valor del CSV puede no llegar a SH sin que el usuario se entere. Ordenada por severidad.

### Skip 1 — `AddParamsToPartNumber` exclusion-constraint (`bulk-upload.js:5876-5878`)

```js
if (msg.includes('exclusion constraint') || msg.includes('conflicting key') || msg.includes('23P01')) {
  // Skip silencioso — ya presente (race con otro worker o un retry).
}
```

**Impacto:** Si dos workers concurrentes intentan insertar el mismo specFieldParam para el mismo PN, el segundo se descarta sin error visible. El usuario no sabe si el param quedó en SH o no. En corridas con concurrency 8 y muchos PNs con la misma spec, la probabilidad de race no es trivial.

**Diagnóstico:** Este skip asume "ya presente = idempotente", lo cual es verdad en el happy path. Pero si el primer worker falló por otro motivo (network timeout) y el segundo también entra a este path, el param puede no estar en SH y nadie lo sabrá.

---

### Skip 2 — Pre-fetch predictivos: `catch(_) {}` (`bulk-upload.js:4834`)

```js
try {
  const pnData = await api().query('GetPartNumber', { partNumberId: target.pnId });
  // ...
} catch (_) {}
```

**Impacto:** Si `GetPartNumber` falla para un PN (network error, hash rotado, timeout), `existingPredictedMap` no tendrá entrada para ese PN. En STEP 6, `SavePartNumber` intentará insertar los predictivos sin saber cuáles existen → `unique_constraint` → `strip2` (retry mínimo sin predictivos) → **los predictivos del CSV se pierden silenciosamente**.

**Mecanismo de daño:** La secuencia es: catch silencioso → `existingPredictedMap.get(pnId)=undefined` → `pnInput.inventoryPredictedUsages = finalPredictive.filter(pu => !existingPredictedMap.get(pn.id)?.has(...))` → todos los predictivos del PN pasan al filtro → si ya existen en SH → `unique_constraint` → `strip2` → sin predictivos en el retry.

---

### Skip 3 — Default price read en STEP 8a falla silenciosamente (`bulk-upload.js:6176-6179`)

```js
} catch (e) {
  if (isBail(e)) throw e;
  // silencioso — el default no se aplicará pero no rompemos el flujo
}
```

**Impacto:** Si `GetPartNumber` falla para un PN al releer precios, `precioDefault=true` no se aplica. El usuario no recibe ningún aviso. Para PNs que cobran por precio default, esto puede afectar cotizaciones futuras.

---

### Skip 4 — `UnsetPartNumberPriceAsDefaultPrice` silencioso (`bulk-upload.js:6195-6198`)

```js
for (const priceId of priceIdsToUnsetDefault) {
  try { await api().query('UnsetPartNumberPriceAsDefaultPrice', { id: priceId }); ... }
  catch (e) { /* silencioso — puede que no fuera default */ }
}
```

**Impacto:** Si un PN tenía `precioDefault=true` en SH y el CSV trae `precioDefault=false`, el unset puede fallar sin que el usuario lo sepa. El PN queda con precio default incorrecto.

---

### Skip 5 — Schema v11 indeterminado: warn + fallback silencioso (`bulk-upload.js:1213-1216`)

```js
} else {
  warn('parseRows: schema indeterminado (col E de la fila Archivado no es "Id SH" ni "Cliente"), asumiendo v11');
  COLS = V11_COLS; schemaVersion = 'v11';
}
```

**Impacto:** Si el CSV tiene una variante no reconocida (por ejemplo, columnas corridas por error de pegado), todos los datos se parsean con los índices incorrectos. Los valores de PNs y clientes pueden ser completamente erróneos. El `warn` va al log del panel pero no bloquea la corrida. **No hay un validate-schema-before-execute.**

---

### Skip 6 — `resolveUnitId` devuelve null silenciosamente (`bulk-upload.js:1416-1417`)

```js
warn(`Unit "${abbr}" no encontrada.`);
return null;
```

**Impacto:** Si la columna `Unidad precio` tiene una abreviatura no reconocida (ej: `PZA` en lugar de `PZS`), el precio se crea con `unitId=null`. SH puede usar su default o rechazarlo sin error claro al usuario. El warn va al log pero no a `errors[]`.

---

### Skip 7 — Spec no encontrada: warn, no error (`bulk-upload.js:3653`)

```js
const si = specByName.get(sn);
if (!si) { warn(`Spec "${sn}" no encontrada.`); ... continue; }
```

**Impacto:** Una spec del CSV que no exista en el catálogo de SH simplemente se ignora. El usuario solo ve un `warn` en el panel. La spec nunca se aplica al PN. Nota: esto es diferente a las etiquetas (que sí van a `errors[]`).

---

### Skip 8 — `partNumberLocations` siempre vacío (`bulk-upload.js:5220, 5387, 5842`)

```js
partNumberLocations: [],
```

En todos los calls a SavePartNumber (Call A, Call B, STEP 5, STEP 6b cleanup), `partNumberLocations` se manda como array vacío. Si un PN tenía ubicaciones en SH, se borran con REPLACE. **No hay ningún preserve-on-missing para locations.** Este es el único campo de SH que tiene REPLACE-semantics y que nunca se preserva.

---

### Skip 9 — `clearDefaultProcess` no se envía a SH (`bulk-upload.js:3842`)

```js
p.processId = null;
p.clearDefaultProcess = true;  // ← se setea pero nunca se lee
```

El flag `clearDefaultProcess` se setea cuando el CSV trae `'-'` en Proceso. En el payload de Call A y Call B, el campo `defaultProcessNodeId` se pone en `null` (via `pnProcessId = part.processId = null`). El flag en sí es letra muerta — no hay ningún `if (part.clearDefaultProcess)` en los builders de input. Funcionalmente esto es correcto (null limpia el proceso), pero el flag engañoso puede confundir a futuros mantenedores.

---

### Skip 10 — Grupo de PN cancelado por el usuario sin error (`bulk-upload.js:3929-3935`)

```js
if (!createGroups) {
  for (const part of parts) {
    if (newGroups.has(part.pnGroup)) part.pnGroup = '';
  }
  log('  Grupos nuevos cancelados por usuario');
}
```

Cuando el usuario rechaza crear grupos nuevos, el campo `pnGroup` se silencia para esas filas. El PN se crea/modifica sin grupo. No hay error en `errors[]` ni advertencia por fila.

---

## Parte 4 — Diagnóstico del piloto Fisher (2026-05-30)

### Contexto del piloto

- **3 PNs Fisher** (S12B7026A1, S14B8644A1, S16A1367A1) en modo **SOLO_PN**, CSV `fisher_pilot_v23.csv`.
- **Resultados conocidos:** labels, descriptionMarkdown, customerFacingNotes, customInputs: OK. `defaultProcessNodeId` (siguió null), `partNumberDimensions` (0 dims), `geometryTypeId` (null): NO aplicados.
- El usuario confirmó que el proceso existe en SH.

### Hipótesis evaluadas

#### H1 — Caracteres especiales rompen `AllProcesses` searchQuery

**Código auditado (`bulk-upload.js:3544`):**
```js
const pd = await api().query('AllProcesses', {
  includeArchived: 'NO',
  processNodeTypes: ['PROCESS'],
  searchQuery: `%${pname}%`,
  first: 50
});
const pr = pn2.find(p => p.name?.toUpperCase() === pname.toUpperCase())
         || pn2.find(p => p.name?.toUpperCase().includes(pname.toUpperCase()));
```

El proceso Fisher tiene nombre `"T104 (ZIN)-T104 (CTR)-FE/AC-VARIOS (6.0)"`. Este nombre contiene: paréntesis `()`, guión `-`, barra `/`, punto `.`.

**Análisis:** El `searchQuery` con `%` es un ILIKE de PostgreSQL. Los caracteres `(`, `)`, `-`, `/`, `.` son seguros en ILIKE (no son metacaracteres de LIKE, que solo son `%` y `_`). Sin embargo:
- El guión `-` aparece en el nombre del proceso. Si hay espacios alrededor o no hay, el ILIKE puede o no matchear según el índice de SH.
- El problema más probable: la `searchQuery` se construye con el nombre **completo** como `%T104 (ZIN)-T104 (CTR)-FE/AC-VARIOS (6.0)%`. Si SH trunca nombres en la API o usa collation sensible a acentos, puede devolver 0 resultados.

**Diagnóstico más específico:** En el piloto v23, la columna Proceso viene de una fórmula Excel que concatena subcadenas de la matriz de procesos. Si la fórmula produjo un valor con espacios adicionales al inicio/fin, `ILIKE '%nombre%'` falla porque `toUpperCase()` no strip whitespace.

**Evidencia de código:** El parser hace `g(row, COLS.proceso)` → `g(row,col) = (row[col]||'').trim()`. El trim ocurre a nivel de celda CSV, pero si la fórmula Excel embebió espacios dentro del nombre (no solo al inicio/fin), trim no ayuda.

**¿Qué pasó en el piloto?** Hay dos posibilidades concretas:

**H1a (MÁS PROBABLE):** `AllProcesses` devuelve 0 nodos → `unresolvedNames.add(pname)` → modal `confirmUnresolvedProcesses` → el usuario eligió **Preservar** → `p.procesoOverride = ''` → en post-process, `st.status !== 'new'` y el PN existente tenía `existingProcessId = null` → `p.processId = null` → warn `"Proceso vacío y existente sin defaultProcessNodeId — queda sin proceso"` → Call B manda `defaultProcessNodeId: null`.

**H1b (ALTERNATIVA):** `AllProcesses` devuelve resultados pero ninguno matchea `name.toUpperCase() === pname.toUpperCase()` por whitespace o encoding → mismo path de `unresolvedNames`.

---

#### H2 — Match falla por whitespace, tildes o caracteres invisibles

**Código (`bulk-upload.js:3546`):**
```js
const pr = pn2.find(p => p.name?.toUpperCase() === pname.toUpperCase())
         || pn2.find(p => p.name?.toUpperCase().includes(pname.toUpperCase()));
```

**Análisis:** `toUpperCase()` no normaliza Unicode ni strip whitespace. Si el nombre en SH tiene espacios no-breaking (` `) o la fórmula Excel produjo caracteres de ancho cero, el match falla. El fallback `.includes()` mitiga pero no cubre diferencias de whitespace al inicio/fin del nombre de SH.

**Ejemplo concreto:** Si el catálogo de SH tiene `"T104 (ZIN)- T104 (CTR)-FE/AC-VARIOS (6.0)"` (espacio después del guión) y el CSV tiene `"T104 (ZIN)-T104 (CTR)-FE/AC-VARIOS (6.0)"` (sin espacio), el `===` falla y el `.includes()` falla porque el nombre del CSV no está contenido en el nombre de SH (el de SH es más largo).

---

#### H3 — El usuario eligió "Preservar" en el modal sin darse cuenta

**Código (`bulk-upload.js:3556-3574`):**
```js
if (unresolvedNames.size) {
  const choice = await confirmUnresolvedProcesses([...unresolvedNames]);
  if (choice === 'abort') throw new Error(...);
  // 'preserve': limpiar procesoOverride
  for (const p of parts) {
    if (p.procesoOverride && unresolvedNames.has(p.procesoOverride)) {
      p.procesoOverride = '';
    }
  }
}
```

Si el proceso no se resolvió (H1/H2) Y el piloto ejecutó con la versión 1.5.12+ (que introduce el modal), el usuario vio el modal y eligió "Preservar". Dado que:
- Los 3 PNs Fisher son **existentes** en SH.
- Sus `existingProcessId` era `null` antes del piloto (confirmado por el gap analysis: 100% de Fisher PNs sin `defaultProcessNodeId`).
- El post-process (`bulk-upload.js:3854-3856`) encontró `!st.existingProcessId` → `p.processId = null` + `warn`.

**Resultado:** Call B manda `defaultProcessNodeId: null`. SH no cambia el proceso del PN (ya era null). El warn es solo en el log del panel, no en `errors[]`.

---

#### H4 — Call B falló silenciosamente

**Análisis:** Si Call B hubiera fallado, `state.counters.errors` habría subido y el reporte XLSX habría mostrado el error. Además, `customInputs` sí se aplicó (confirmado por el usuario: "preserve funcionó"). `customInputs` solo va en Call A. Si Call A + Call B hubieran fallado, `customInputs` tampoco habría cambiado. Por lo tanto Call B **sí ejecutó**, pero con `defaultProcessNodeId=null` y `dims=[]`.

**H4 descartada** como causa raíz. Call B ejecutó, pero con los valores correctos (null) según la lógica del código.

---

#### H5 — SOLO_PN: pn sintético tiene `defaultProcessNodeId: part.processId`

**Código (`bulk-upload.js:4712`):**
```js
pn: { id: pnId, name: part.pn, customerId: part.customerId,
      defaultProcessNodeId: part.processId,  // ← viene de la resolución
      customInputs: {}, ... }
```

Si `part.processId = null` (porque el resolver falló), el pn sintético ya nace con `defaultProcessNodeId: null`. En Call B (`bulk-upload.js:5375`):
```js
defaultProcessNodeId: pnProcessId,  // = part.processId = null
```

Esto confirma H5 como consecuencia de H1/H2/H3: la cadena es resolver→null→sintético→null→Call B→null.

---

#### H4b — Dims: ¿por qué tampoco se aplicaron?

Para dims, el CSV Fisher trae Long/Ancho/Alto (3 valores). `buildDimensions` debería crear `csvDims` con 3 elementos. `csvHasDims = true` → `dims = csvDims`. Call B manda `partNumberDimensions: dims`.

**Pero los 3 PNs siguieron con 0 dims después del piloto.** Posibles causas:

1. **Los valores de Long/Ancho/Alto venían `null` del parser** — `gn(row, col)` devuelve `null` para celdas vacías o no-numéricas. Si las columnas de dims en el CSV v23 estaban vacías para esos 3 PNs, `buildDimensions` devuelve `[]` → `csvHasDims = false` → preserve-on-missing (existingPnNode dims, que eran 0) → `dims=[]` → SH no cambia nada (REPLACE de `[]` da `[]`).

2. **Los valores venían en unidades incorrectas** — `buildDimensions` hardcodea `unitId: DOMAIN.unitIds.MTR`. Si SH esperaba una unidad diferente y rechazó silenciosamente (no HTTP 400 pero sí ignoró el campo), los dims no quedarían. Sin embargo, el schema GraphQL debería rechazar un unitId inválido con error.

**Hipótesis dominante para dims:** Los valores de dimensiones en el CSV `fisher_pilot_v23.csv` para esos 3 PNs eran `null` o vacíos (las celdas de Long/Ancho/Alto no tenían valor). Esto hace que `csvHasDims = false` → preserve-on-missing → `dims` se reconstruye desde `existingPnNode` que tenía 0 dims → `partNumberDimensions: []`.

---

### Conclusión del diagnóstico

**Hipótesis ganadora: H1 + H3 + H5 (cadena completa)**

1. **H1a/H2:** El resolver de procesos `AllProcesses` con `searchQuery='%T104 (ZIN)-T104 (CTR)-FE/AC-VARIOS (6.0)%'` devolvió 0 resultados O devolvió resultados que no matchearon por whitespace/encoding. El nombre fue a `unresolvedNames`.

2. **H3:** El modal `confirmUnresolvedProcesses` apareció. El usuario eligió "Preservar". Los 3 PNs Fisher tenían `existingProcessId=null` en SH → post-process resultó en `p.processId=null`.

3. **H5:** El pn sintético en SOLO_PN se construyó con `defaultProcessNodeId: null`. Call B mandó `defaultProcessNodeId: null`. SH no cambió el proceso.

4. **Para dims:** El CSV v23 muy probablemente traía celdas de dimensiones vacías para esos 3 PNs específicos → `csvHasDims=false` → preserve-on-missing sobre `existingPnNode` con 0 dims → resultado: 0 dims.

**Acción correctiva recomendada:**
- Verificar con el usuario si apareció el modal de proceso no encontrado durante el piloto.
- Agregar `trim()` explícito al `pname` antes del `searchQuery` y al comparar con `p.name` (aunque `g()` ya hace trim del CSV, el nombre en SH puede tener whitespace).
- Normalizar ambos lados con `normalize('NFD')` + strip diacríticos + collapse spaces múltiples antes del match.
- Para dims: el CSV v23 debe tener Long/Ancho/Alto con valores. Verificar que las columnas correctas (AW/AX/AY en v11 = índices 48/49/50) tengan datos.

---

## Parte 5 — Plan de refactor

### 5a. Cero ignores silenciosos (regla maestra)

**Prioridad: ALTA**

**Cambios necesarios:**

| Skip | Acción correctiva | Esfuerzo |
|---|---|---|
| Skip 1: `AddParamsToPartNumber` exclusion-constraint silencioso | Cambiar a `warn()` + contador en `errors[]` con label `[race-omitido]` para distinguirlo de errores reales | 0.5 días |
| Skip 2: Pre-fetch predictivos `catch(_){}` | Agregar al `errors[]` con mensaje `"Pre-fetch predictivos pnId=${id} falló: …"` | 0.25 días |
| Skip 3: Default price read silencioso | `errors.push(...)` con mensaje `"Default price: GetPartNumber '${pnName}' falló — precio default no aplicado"` | 0.25 días |
| Skip 4: UnsetDefault price silencioso | `warn(...)` (es menos crítico — ya tenía precio default antes) | 0.25 días |
| Skip 5: Schema indeterminado | Agregar validación explícita del schema y bloquear la corrida si el CSV no reconoce ningún layout (`throw new Error`) | 0.5 días |
| Skip 6: `resolveUnitId` warn → error | Mover de `warn` a `errors.push()` con label por fila | 0.25 días |
| Skip 7: Spec no encontrada warn → error | Mover de `warn` a `errors.push()` (ya se hace para labels; misma consistencia) | 0.25 días |
| Skip 8: `partNumberLocations` siempre vacío | Agregar preserve-on-missing desde `existingPnNode.partNumberLocationsByPartNumberId` — mismo patrón que dims (1.5.14) | 1 día |
| Skip 10: Grupo cancelado sin error | Agregar `warn()` por fila afectada en `errors[]` | 0.25 días |

**Total Parte 5a: ~3 días**

---

### 5b. Modularidad

**Prioridad: MEDIA**

El archivo tiene ~6850 líneas en un solo IIFE. La deuda arquitectónica es enorme. Propuesta de división en módulos (cada uno en un archivo separado bajo `remote/scripts/`):

| Módulo | Responsabilidad | Tamaño estimado | Dependencias |
|---|---|---|---|
| `bulk-upload-parser.js` | `parseCSV`, `parseRows`, constantes `V10_COLS`/`V11_COLS`, `HEADER_KEYS`, `PREDICTIVE_MATERIALS` | ~400 líneas | Ninguna |
| `bulk-upload-resolvers.js` | `resolveUnitId`, `resolveGroupId`, `resolveGeometryTypeId`, resolver de procesos (prefetch + match), `classifyPNs` / `classifyPNsMassive` / `classifyPNsOnDemand`, `buildClassifiedRow`, `dedupModifyTargets` | ~1200 líneas | `steelhead-api.js` |
| `bulk-upload-builders.js` | `buildDimensions`, `mergeCustomInputs`, `extractPNShape`, `resolveStr`, `resolveNum`, `isDash`, `buildEquivIndex`, `detectCsvDuplicates` | ~250 líneas | Ninguna (pure functions) |
| `bulk-upload-pipeline.js` | `execute()` con todas las STEPs (1–8), `prefetchPNsByCustomer`, `enrichWorker`, `step6bWorker`, `archiveWorker` | ~3000 líneas | Todos los anteriores |
| `bulk-upload-memory.js` | `stopDatadogSessionReplay`, `triggerMemoryGuardrail`, `startMemoryGauge` — o migrar a `host-cleanup-shared.js` | ~150 líneas | `host-cleanup-shared.js` |
| `bulk-upload-ui.js` | `showPreview`, `showPanel`, `addPanelLog`, `setPanelPhase`, `setPanelProgress`, modales (`confirmUnresolvedProcesses`, `createOverlay`) | ~1500 líneas | Ninguna (DOM puro) |
| `bulk-upload-resume.js` | `saIdb`, `saIdbGet/Set/Del`, `loadResumeStateByKey`, `saveResumeIndex`, `persistResumeState` | ~200 líneas | IndexedDB |

**Esfuerzo estimado:** 5–8 días (refactor + tests de regresión)

**Restricción:** El loader de la extensión espera un array `scripts[]` en `config.json`. Habría que agregar todos los módulos en orden de dependencia. El namespace `BulkUpload` central puede quedar en `bulk-upload-pipeline.js` e importar de los demás vía `window.BulkUploadParser`, etc.

---

### 5c. Test harness

**Prioridad: MEDIA**

Ya existe `tools/test/bulk-upload-helpers.test.js` (introducido en 1.1.0) para helpers puros. Extender:

**Tier 1 — Unit tests (Node.js, pure functions):**
- `buildDimensions`: input con null/undefined/valores → output array correcto
- `mergeCustomInputs`: deep merge, preserve-on-missing, dash semántico
- `extractPNShape`: distintos shapes de nodo SH
- `resolveStr`, `resolveNum`, `isDash`
- `parseCSV` + `parseRows`: fixtures CSV v10 y v11 completos

**Tier 2 — Integration tests (mock de API):**
- Un mock de `window.SteelheadAPI` con respuestas pre-programadas
- Fixture: CSV con 3 PNs, resolver proceso = OK, 2 existentes + 1 nuevo
- Verificar que `pnInput` (Call B) tenga los campos correctos antes de `api().query`

**Tier 3 — Smoke tests de regresión (manual, checklist):**
Ver Parte 6c.

**Esfuerzo estimado:** 3–4 días para Tier 1 + Tier 2 básico

---

### 5d. Idempotencia

**Prioridad: ALTA**

Campos con REPLACE-semantics en SH que pueden tener inconsistencias entre corridas:

| Campo | Riesgo de idempotencia | Mitigación actual | Gap |
|---|---|---|---|
| `labelIds` | Segunda corrida con CSV vacío → preserve (OK desde 1.5.5) | Preserve-on-missing | Ninguno (ya correcto) |
| `partNumberDimensions` | Segunda corrida con CSV sin dims → preserve (OK desde 1.5.14) | Preserve-on-missing | Ninguno |
| `customInputs` | Segunda corrida con CSV parcial → merge correcto (OK desde 1.5.9) | `mergeCustomInputs` | Ninguno |
| `dimensionCustomValueIds` | Segunda corrida con CSV sin Línea/Depto → preserve (OK desde 1.5.5) | Preserve-on-missing | Ninguno |
| `optInOuts` | Segunda corrida con CSV sin Val1 → null → preserve (OK desde 1.5.13) | Tri-state | Ninguno |
| `inventoryItemInput` | Segunda corrida con CSV sin KGM/CMK/LM → preserve (OK desde 1.5.13) | Preserve-on-missing | Ninguno |
| `partNumberLocations` | Segunda corrida → `[]` → **borra locations** | Ninguno | **Gap activo (Skip 8)** |
| `specsToApply` | Idempotente — add-only y STEP 6b maneja duplicados | 1.4.38 | OK |
| `inventoryPredictedUsages` | Idempotente — usa id existente del `existingPredictedMap` | Fix JJ 1.4.30 | OK si pre-fetch no falla |

**Acción:** Implementar preserve-on-missing para `partNumberLocations` (mismo patrón que dims). Costo: 1 día.

---

### 5e. Observabilidad

**Prioridad: MEDIA**

Actualmente el log del panel tiene cap de 500 líneas (ring buffer, `bulk-upload.js:447`). El reporte XLSX tiene Hoja Errores pero no una "Hoja de decisiones campo por campo".

**Propuesta:**

1. **Decision log por PN:** Para cada PN procesado, emitir un objeto estructurado con las decisiones tomadas:
   ```js
   {
     pn: "S12B7026A1",
     step: "enrichWorker",
     decisions: {
       processo: { csv: "T104 (ZIN)...", resolved: null, reason: "unresolved→preserved→existingNull" },
       dims: { csvHasDims: false, preserve: "[]", reason: "csv vacío→preserve→existingNode tenía 0" },
       labels: { csv: ["ZIN", "CTR"], resolved: [12345, 67890], action: "REPLACE" },
       customInputs: { merged: {...}, delta: ["BaseMetal", "QuoteIBMS"] }
     }
   }
   ```
2. **Agregar hoja "Decisiones campo x campo"** al reporte XLSX. Una fila por PN × campo con: valor CSV, valor previo en SH, valor enviado, razón si se preservó o ignoró.
3. **Separar `warn` de `errors[]`:** Actualmente muchos warns deberían ser rows en la hoja de decisiones (ej: "Proceso heredado del PN existente"). El reporte XLSX debería tener esta hoja separada de los errores duros.

**Esfuerzo estimado:** 3–5 días

---

### Resumen de esfuerzo total del refactor

| Parte | Prioridad | Días |
|---|---|---|
| 5a — Cero skips silenciosos | ALTA | 3 |
| 5b — Modularidad | MEDIA | 6 |
| 5c — Test harness | MEDIA | 4 |
| 5d — Idempotencia (`partNumberLocations`) | ALTA | 1 |
| 5e — Observabilidad | MEDIA | 4 |
| **Total** | | **~18 días** |

**Top prioridad para la próxima sprint:** 5a (3 días) + 5d (1 día) = **4 días** cubren los riesgos más altos con el menor esfuerzo.

---

## Parte 6 — Plan de validación del funcionamiento real

### 6a. Test suite de fixtures

Para cada fixture: estado pre esperado → ejecutar CSV short → estado post esperado → query de verificación.

#### Fixture 1 — Solo Proceso (proceso → aplicar)

```
CSV: 1 PN existente, Proceso = "T104 (ZIN)-T104 (CTR)-FE/AC-VARIOS (6.0)", resto vacío
Pre: PN existente en SH con defaultProcessNodeId=null
Post esperado: PN con defaultProcessNodeId={id del proceso Fisher en SH}
Verificar: GetPartNumber(partNumberId) → partNumberById.processNodeByDefaultProcessNodeId.id == id_esperado
```

#### Fixture 2 — Solo Proceso dash (borrar proceso)

```
CSV: 1 PN existente, Proceso = "-", resto vacío
Pre: PN con defaultProcessNodeId={algún id}
Post: PN con defaultProcessNodeId=null
Verificar: GetPartNumber → processNodeByDefaultProcessNodeId == null
```

#### Fixture 3 — Solo Val1 = 'V' (activar validación 1er artículo)

```
CSV: 1 PN existente, Val1 = 'V', resto vacío
Pre: PN sin optInOuts (validación desactivada)
Post: PN con processNodePartNumberOptInoutsByPartNumberId.nodes[0].processNodeId ∈ DOMAIN.validacionProcessNodeIds
Verificar: GetPartNumber → processNodePartNumberOptInoutsByPartNumberId
```

#### Fixture 4 — Val1 vacío (preserve optInOuts)

```
CSV: 1 PN existente con validación activa, Val1 vacío
Pre: PN con optInOut activo
Post: PN con mismo optInOut activo (no cambió)
Verificar: GetPartNumber → processNodePartNumberOptInoutsByPartNumberId = igual al pre
```

#### Fixture 5 — Solo dimensiones

```
CSV: 1 PN existente, Long=100, Ancho=50, Alto=30, resto vacío
Pre: PN con 0 partNumberDimensions
Post: PN con 3 partNumberDimensions {LENGTH=100, WIDTH=50, HEIGHT=30, unitId=MTR}
Verificar: GetPartNumber → partNumberDimensionsByPartNumberId.nodes.length == 3
```

#### Fixture 6 — Dimensiones vacías (preserve dims existentes)

```
CSV: 1 PN existente, Long/Ancho/Alto vacíos, resto vacío
Pre: PN con 3 partNumberDimensions
Post: PN con mismas 3 partNumberDimensions (sin cambio)
Verificar: GetPartNumber → partNumberDimensionsByPartNumberId.nodes = mismo que pre
```

#### Fixture 7 — customInputs parcial (preserve campos no tocados)

```
CSV: 1 PN existente, solo BaseMetal="Cobre", resto vacío
Pre: PN con customInputs={DatosAdicionalesNP:{BaseMetal:"Fierro", QuoteIBMS:"Q-001"}, DatosFacturacion:{CodigoSAT:"73181106..."}}
Post: PN con customInputs={DatosAdicionalesNP:{BaseMetal:"Cobre", QuoteIBMS:"Q-001"}, DatosFacturacion:{CodigoSAT:"73181106..."}}
Verificar: GetPartNumber → customInputs (QuoteIBMS y CodigoSAT no cambiaron)
```

#### Fixture 8 — Labels desconocidas (error visible, no borrar existentes)

```
CSV: 1 PN existente, Etq1="TYPO_QUE_NO_EXISTE", resto vacío
Pre: PN con 2 labels reales en SH
Post: PN con mismas 2 labels. errors[] contiene "Etiqueta(s) no encontrada(s)..."
Verificar: GetPartNumber → partNumberLabelsByPartNumberId.nodes = mismo que pre. Reporte XLSX hoja Errores tiene la fila.
```

#### Fixture 9 — Predictivo nuevo vs existente

```
CSV: 1 PN existente, Plata=0.00015, Zinc="-", Cobre vacío
Pre: PN con predictivo Zinc activo (id=X), sin Plata, Cobre existente
Post: PN con predictivo Plata insertado nuevo, Zinc archivado, Cobre sin cambio
Verificar: predictedInventoryUsagesByPartNumberId (Plata con usagePerPart≈0.00015, Zinc con archivedAt, Cobre igual)
```

#### Fixture 10 — SOLO_PN nuevo PN completo

```
CSV: 1 PN nuevo (no existe en SH), con Proceso válido, 3 dims, 2 labels, customInputs, KGM=2.5
Post: PN creado con todos los campos correctos
Verificar: GetPartNumber → shape completo matchea el CSV
```

---

### 6b. Validación en cliente real (piloto controlado)

**Para el siguiente piloto Fisher (5–10 PNs):**

Checklist campo por campo:

- [ ] **Proceso:** Antes del run, confirmar con `AllProcesses(searchQuery='%T104%')` que el proceso existe y tiene `name` byte-exact al del CSV. Después del run: `GetPartNumber → processNodeByDefaultProcessNodeId.name == nombre_esperado`.
- [ ] **Dims:** Confirmar que el CSV v23 tiene valores en Long/Ancho/Alto para esos PNs. Después del run: `GetPartNumber → partNumberDimensionsByPartNumberId.nodes.length == n_esperado`.
- [ ] **geometryTypeId:** Confirmar que la columna TipoGeometría (AV=47) tiene valor en el CSV (o que `hasDims=true` → usa `geometryGenericaId`). Después: `GetPartNumber → geometryTypeId != null`.
- [ ] **customInputs:** Tomar snapshot pre con `GetPartNumber`. Después del run, comparar campo por campo que los campos del CSV se aplicaron Y los no-CSV se preservaron.
- [ ] **Labels:** Listar labels esperadas del CSV. Después: `GetPartNumber → partNumberLabelsByPartNumberId.nodes[].labelByLabelId.name` = set esperado.
- [ ] **Predictivos:** Si CSV trae predictivos, verificar `predictedInventoryUsagesByPartNumberId` post-run.
- [ ] **Errores en reporte XLSX:** Verificar que la hoja Errores está vacía (cero errores inesperados).
- [ ] **partNumberLocations:** Verificar PRE y POST que el campo no cambió (actualmente siempre se manda `[]` — Skip 8 activo).

---

### 6c. Smoke test de regresión (checklist mínimo por release)

Antes de cada deploy a `gh-pages`, ejecutar estos 5 tests mínimos contra un PN de staging:

1. **Test preserve-customInputs:** CSV con solo BaseMetal. Verificar que QuoteIBMS y demás campos del PN no cambiaron.
2. **Test dims en SOLO_PN:** CSV con 3 dims. Verificar que el PN tiene 3 `partNumberDimensions` después.
3. **Test proceso resolve:** CSV con proceso real. Verificar que `defaultProcessNodeId` se aplicó.
4. **Test labels preserve:** CSV sin labels para PN con 2 labels. Verificar que las 2 labels permanecen.
5. **Test optInOuts preserve:** CSV con Val1 vacío para PN con optInOut activo. Verificar que sigue activo.

**Script de referencia:** `pilot_validate.py` en el repo (ya existente) puede extenderse para cubrir estos 5 checks automatizados comparando snapshot pre/post.

---

## Notas de deuda técnica pendiente

1. **`partNumberLocations` REPLACE sin preserve** (Skip 8): cualquier PN con ubicaciones pierde sus locations en cada corrida de bulk-upload. No hay workaround actual.
2. **`clearDefaultProcess` flag muerto** (Skip 9): el flag en `part.clearDefaultProcess` no se usa en ningún builder. Es confuso pero no buggy (null en `defaultProcessNodeId` tiene el mismo efecto).
3. **Migración a `host-cleanup-shared.js`**: `stopDatadogSessionReplay` está inline en el applet. Pendiente de tarea #113 del audit.
4. **El `processName` del extractPNShape** (`bulk-upload.js:1630`) solo lo usa la clasificación (`classifyOnePN` para mostrar info en preview). Si en el futuro se usa para reconciliación, hay que asegurar que viene de `processNodeByDefaultProcessNodeId.name` (que ya hace).
5. **`minPzasLote` destino real en SH no documentado** — el campo se parsea como `unitConv.minPzasLote` pero su destino en `inventoryItemInput` no es claro en el código (no se ve en `buildInventoryInput` ni en los inputs de SavePartNumber auditados). Requiere verificación.

---

*Documento generado por auditoría 2026-05-30. Para actualizar, ver `docs/applets/bulk-upload.md` (bitácora de cambios).*
