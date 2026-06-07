# Bulk-Upload — Auditoría Técnica Exhaustiva

**Versión auditada:** 1.5.16  
**Fecha de audit:** 2026-05-31  
**Script:** `remote/scripts/bulk-upload.js` (6874 líneas)  
**Bitácora oficial:** `docs/applets/bulk-upload.md`

---

## Índice

1. [Arquitectura end-to-end](#1-arquitectura-end-to-end)
2. [Esquema CSV V10 / V11](#2-esquema-csv-v10--v11)
3. [Semántica campo a campo](#3-semántica-campo-a-campo)
4. [Mapa de llamadas API](#4-mapa-de-llamadas-api)
5. [Clasificación y deduplicación](#5-clasificación-y-deduplicación)
6. [Robustez y defensivos](#6-robustez-y-defensivos)
7. [Roadmap de optimización](#7-roadmap-de-optimización)
8. [Glosario y referencias](#8-glosario-y-referencias)

---

## 1. Arquitectura end-to-end

### 1.1 Diagrama narrativo del pipeline

```
CSV / XLSX
    │
    ▼
[parseRows] → parts[] + header{}
    │
    ▼ (validate mode, detect schema V10/V11)
[detectCsvDuplicates] → isCsvDuplicate flags
    │
    ▼
[showPreview] → usuario revisa/cancela/ajusta archiveGlobal
    │
    ▼
[execute()]
    │
    ├─ Catalogs load (AllLabels, AllSpecs, AllProcesses,
    │   AllRackTypes, AllGeometryTypes, AllUnits...)
    │
    ├─ Customer resolution (per cliente unico)
    │
    ├─ Process name resolution (confirmUnresolvedProcesses si hay missing)
    │
    ├─ Preflight: prefetchPNsByCustomer / classifyPNsMassive
    │     └─ P0 idsh-direct (bypass) / P1 ibms / P2 composite / P3 near-match / NEW
    │           └─ dedupModifyTargets
    │
    ├─ STEP 1 (COTIZACIÓN+NP): CreateQuote / UpdateQuote + chunk splitting
    │
    ├─ STEP 2 (ambos): SavePartNumber Call A (identifiers)
    │      = name, customerId, labelIds, customInputs, groupId
    │      → persiste identifierEnrichDone[]
    │
    ├─ STEP 3 (COTIZACIÓN+NP): SaveManyPNP + SaveQuoteLines
    │      batch de 20 PNs por cotización
    │
    ├─ STEP 4 (ambos): SaveManyPNP_PN (precios standalone)
    │
    ├─ STEP 5 (COTIZACIÓN+NP): Sentinel pre-quote archive
    │      specs no-en-CSV archivadas antes de la cotización
    │      (previene unique_constraint en enrich)
    │
    ├─ STEP 6/enrichWorker (ambos): SavePartNumber Call B (full shape)
    │      + conflictingExtras (spec-collision split)
    │      + predictive pre-fetch existentes
    │
    ├─ STEP 6a (ambos): Predictive materials
    │      orden obligatorio: unarchive → update → archive
    │
    ├─ STEP 6b (ambos): Sync params spec (AddParamsToPartNumber)
    │      + cleanup duplicates por SpecField (regla 1.4.38)
    │
    ├─ STEP 7 (ambos): RackTypes (SavePartNumberRackTypes, batch 50)
    │      + STEP 7b: Delete prices (guión en precio)
    │
    ├─ STEP 8 (ambos): Archive/Unarchive PNs + Default price
    │      archiveGlobal toggle + per-row override
    │
    └─ STEP 9: Historia (localStorage) + XLSX report + showResult
```

### 1.2 Modos de operación

| Aspecto | SOLO_PN | COTIZACIÓN+NP |
|---|---|---|
| Header CSV | `modo: SOLO_PN` | `modo: COTIZACIÓN+NP` |
| Pasos totales | 5 | 9 |
| Cotización | No | Sí (CreateQuote, chunking) |
| SaveManyPNP | Solo PN prices standalone | También linkea PNs a cotización |
| Sentinel STEP 5 | No | Sí |
| STEP 6 enrich | Sí | Sí |
| Prefetch previo | classifyPNsMassive (AllPartNumbers batch) o classifyPNsOnDemand | Igual |
| Precios | SaveManyPNP_PN directo | SaveManyPNP_Quote + opcionalmente también PN |

### 1.3 Estados del panel por fase

| Paso | Label visible | Barra % | Concurrencia |
|---|---|---|---|
| Carga catálogos | `Cargando catálogos...` | 5 | Secuencial |
| Resolución clientes | `Resolviendo clientes (N)` | 10 | Secuencial |
| Resolución procesos | `Resolviendo procesos (N)` | 15 | Secuencial |
| Dims contables | `Cargando dimensiones contables (N)` | 18 | Secuencial |
| Specs cache | `Cargando definiciones de specs (N)` | 20 | Secuencial |
| Prefetch PNs | `Prefetching PNs...` | 25-35 | 2 passes AllPartNumbers |
| Clasificación | `Clasificando...` | 40 | N/A |
| Preview | (modal bloqueante) | — | Usuario |
| STEP 1 | `Paso 1/9: Creando cotización` | 45 | — |
| STEP 2 (enrich Call A) | `Paso 2/9: ...` | 50 | savePartNumber=8 |
| STEP 3 | `Paso 3/9: Creando/reanudando cotizaciones (N)` | 55 | — |
| STEP 4 | `Paso 4/9: Precios standalone` | 60 | savePartNumber=8 |
| STEP 5 | `Paso 5/9: Archive sentinel...` | 65 | sentinelPreQuoteArchive=3 |
| STEP 6 (enrich CB) | `Paso 6/9: Enriqueciendo PNs (pool N)` | 70 | savePartNumber=8 |
| STEP 6a | `Paso 6a/9: Predictivos (N)` | 74 | — |
| STEP 6b | `Paso 6b/9: Sync params spec... (pool N)` | 76 | savePartNumber=8 |
| STEP 7 | `Paso 7/9: Racks...` | 78 | batch 50 |
| STEP 8 | `Paso 8/9: Archivando N / Desarchivando M (pool N)` | 85-98 | archive=8 |
| Done | `Completado.` | 100 | — |

### 1.4 Variables de estado globales

`state` (en `execute()`) contiene:
- `counters: {ok, errors, retried}` — acumulan durante toda la corrida
- `cancelled` — flag de cancelación (lee `bailIfStale`)
- `archiveGlobal` — toggle UI del preview
- `runId` — entero incremental, cambia en cada `cancelRun()` — mecanismo principal de stale-check

`resumeState` (persistido en IndexedDB bajo `sa_bulk_resume_*`):
- `phase` — checkpoint de fase ('enrich', 'sync-done', 'racks-done', 'done')
- `completedPNs` — keys `idx|pn|customerId` de PNs exitosos en STEP 6
- `identifierEnrichDone` — keys de Call A exitosos
- `archivedSentinelsPreQuote` — pnIds con sentinel completado en STEP 5
- `syncParamsCompletedPNs` — keys de STEP 6b completados
- `classifications` — shape completo para fast-path de resume (skip prefetch global)

---

## 2. Esquema CSV V10 / V11

### 2.1 Detección automática de versión

```js
// Lee filas hasta encontrar la fila "Archivado"
// Luego examina col[4]:
if (row[4] === 'Id SH') → V11
if (row[4] === 'Cliente') → V10
```

Si ninguna coincide, el parser lanza error visible. La detección es frágil ante cambios de orden de la fila de encabezado.

### 2.2 Tabla de columnas V10 (69 cols, índices 0-68)

| Idx | Nombre campo | Tipo | Req? | Semántica dash |
|---|---|---|---|---|
| 0 | archivado | bool (checkbox) | No | — |
| 1 | (vacío / forzarDuplicado) | bool | No | — |
| 2 | validacion1er | bool | No | — |
| 3 | archivarAnterior | bool | No | — |
| 4 | cliente | string | Sí | error si vacío |
| 5 | pn | string | Sí | error si vacío |
| 6 | descripcion | string | No | vacío → '' |
| 7 | pnAlterno | string | No | vacío → '' |
| 8 | pnGroup | string | No | vacío → heredar existente |
| 9 | qty | number | No | 0 si vacío |
| 10 | precio | number/dash | No | dash → borrar precios |
| 11 | unidadPrecio | string | No | 'PZA' default |
| 12 | divisa | string | No | 'MXN' default |
| 13 | precioDefault | bool | No | false |
| 14 | metalBase | string | No | vacío → sin metal |
| 15-19 | labels[0-4] | string | No | vacío → sin label |
| 20 | proceso | string | No | vacío → proceso existente |
| 21-24 | productos[0][0-3] | string | No | vacío → sin producto |
| 25-28 | productos[1][0-3] | string | No | vacío → sin producto |
| 29-32 | productos[2][0-3] | string | No | vacío → sin producto |
| 33-34 | spec[0] (name, param) | string | No | dash → skip spec |
| 35-36 | spec[1] (name, param) | string | No | dash → skip spec |
| 37 | kgm | number | No | 0 si vacío |
| 38 | cmk | number | No | 0 si vacío |
| 39 | lm | number | No | 0 si vacío |
| 40 | minPzasLote | number | No | 0 si vacío |
| 41-42 | rackLinea[0] (name, ppr) | string/number | No | dash → borrar racks |
| 43-44 | rackSec[0] (name, ppr) | string/number | No | dash → borrar racks |
| 45 | dims.length | number | No | vacío → sin dim |
| 46 | dims.width | number | No | vacío → sin dim |
| 47 | dims.height | number | No | vacío → sin dim |
| 48 | dims.outerDiam | number | No | vacío → sin dim |
| 49 | dims.innerDiam | number | No | vacío → sin dim |
| 50 | linea | string | No | vacío → heredar |
| 51 | departamento | string | No | vacío → heredar |
| 52 | codigoSAT | string | No | vacío → heredar |
| 53-61 | predictives[0-8] | number/dash | No | dash → archivar material |
| 62 | quoteIBMS | string | No | vacío → sin IBMS |
| 63 | estacionIBMS | string | No | vacío → sin estacion |
| 64 | plano | string | No | vacío → sin plano |
| 65 | piezasCarga | number | No | vacío → sin dato |
| 66 | cargasHora | number | No | vacío → sin dato |
| 67 | tiempoEntrega | number | No | vacío → sin dato |
| 68 | notasAdicionalesPN | string | No | vacío → sin notas |

**Materiales predictivos (V10 cols 53-61):**
PlataFina, EstanoPuro, Niquel, Zinc, Cobre, Sterlingshield_S, Epoxy_MT, Epoxica_BT, Epoxica_MT_Red

### 2.3 Tabla de columnas V11 (71 cols, diferencias respecto a V10)

| Cambio | Columna V10 | Columna V11 | Descripción |
|---|---|---|---|
| NUEVA: `idSh` | — | col 4 | ID directo de Steelhead; activa Pase 0 (bypass clasificador) |
| MOVED: `linea` | col 50 | col 15 | Se movió antes de metalBase |
| NUEVA: `tipoGeometria` | — | col 47 | Nombre de geometría para lookup dinámico |
| Resto desplazado | cols 5-68 | cols 6-70 | Offset +1 para todo lo posterior a col 4 |

V11 desplaza todos los índices a partir de la nueva col `idSh` (V11 col 4). La columna `linea` también se movió de col 50 a col 15.

### 2.4 Diferencias funcionales V10 → V11

1. **Pase 0 idsh-direct**: V11 permite anclar una fila a un PN específico por ID de Steelhead, eliminando la clasificación heurística. Cuando `idSh` está poblado, `classifyPNsMassive` la bypasea completamente y devuelve `{pase:0, confidence:'idsh-direct', userDecided:true}`.

2. **tipoGeometria dinámica**: En V10 la geometría siempre usaba `geometryGenericaId=831`. V11 permite lookup por nombre (`AllGeometryTypes` query) y resolución dinámica.

3. **linea en col 15 (V11)**: El desplazamiento temprano facilita leer el campo antes de leer metalBase, lo cual es relevante para clasificación compuesta donde el campo `linea` (dimensión contable) puede diferenciar PNs de diferentes líneas de negocio.

### 2.5 Cabecera del CSV

Las primeras filas antes de `Archivado` contienen metadatos de la corrida:

| Fila | Campo | V10 | V11 |
|---|---|---|---|
| 0 | modo | col 1 | col 1 |
| 1 | empresaEmisora | col 1 | col 1 |
| 2 | quoteName | col 1 | col 1 |
| 3 | asignado | col 1 | col 1 |
| 4 | validaDias | col 1 | col 1 |
| 5 | notasExternas | col 1 | col 1 |
| 6 | notasInternas | col 1 | col 1 |

Si `header.modo` no es `'COTIZACIÓN+NP'` se activa `isSoloPN = true`.

---

## 3. Semántica campo a campo

### 3.1 `pn` (nombre del número de parte)

- **Presente**: se usa como clave principal de clasificación (Pase 3 near-match exact name).
- **Vacío**: error de parseo — la fila se descarta.
- **Dash**: no aplica (el campo es requerido).
- **REPLACE risk**: ninguno — es campo escalar de identidad, no array.
- **Historial**: sin fixes directos; indirectamente afectado por 1.4.28 (homónimos con mismo IBMS).

### 3.2 `idSh` (solo V11)

- **Presente**: activa Pase 0. `classifyPNsMassive` mapea `part.idSh → existingId` directamente sin AllPartNumbers query, marcando `userDecided:true`. El operador es el responsable de la precisión — no hay verificación de consistencia nombre/cliente.
- **Vacío**: flujo normal P1/P2/P3.
- **Riesgo**: si el idSh apunta al PN equivocado, **no hay red de seguridad** — el script sobreescribe el PN indicado sin cuestionar. Es el único campo con `userDecided:true` que bypasea la deduplicación.

### 3.3 `cliente`

- **Presente**: se resuelve contra `AllCustomers` (por nombre exacto) y se almacena como `part.customerId`. El caché `customerCache` evita lookups repetidos.
- **Vacío**: error — la fila se descarta.
- **Riesgo REPLACE**: `customerId` es un scalar que en `GetPartNumber` llega siempre `null` (bug del persisted query). Desde 1.5.16 se usa FK-fallback: `(pnNode.customerByCustomerId?.id ?? pnNode.customerId) || part.customerId`. Sin este fallback, la STEP 6b cleanup mandaba `customerId: null` y SH desvinculaba el cliente.

### 3.4 `labels` (cols 15-19 en V10, 17-21 en V11)

- **Presente**: se mapea a IDs via `labelByName`. Se concatenan hasta 5 labels. En `SavePartNumber` se envían como `labelIds: [...]`.
- **Vacío**: el label en esa posición se omite; los demás siguen.
- **REPLACE semantics CRÍTICO**: `SavePartNumber` hace REPLACE completo de `labelIds`. Si la fila CSV trae 0 labels, el PN existente pierde todos sus labels. El script no tiene protección de "si vacío, preservar existentes" para este campo — envía el array construido desde CSV aunque sea `[]`.
- **Historial**: 1.5.6 fix — en STEP 6b cleanup se re-lee el array existente de labels del PN para no sobreescribir con `[]` al archivar specFieldParams duplicados. Pero en el enrich principal (Call B) los labels **siempre vienen del CSV**.
- **Recomendación**: si el CSV lleva una fila sin labels y el PN en SH tiene labels, se borran. El operador debe llenar el CSV completo o usar dash explícito en el campo metalBase para indicar "no cambiar acabados" — pero eso no existe para labels individualmente.

### 3.5 `metalBase`

- **Presente**: se mapea a labelId via `labelByName` (metal es un label de tipo metal en SH). Se agrega al array `labelIds` junto con los otros labels.
- **Vacío**: sin metal — el label de metal no se incluye.
- **Semántica clasificación**: `metalCanonico()` en el clasificador colapsa sinónimos via `metalEquivalents` de `config.json`. Permite que "Estaño" y "Estaño s/Aluminio" matcheen en Pase 2/3.
- **REPLACE risk**: igual que `labels`. Si el CSV no lleva metalBase pero el PN tenía uno, se pierde.

### 3.6 `precio`

- **Presente**: se crea via `SaveManyPartNumberPrices`. En COTIZACIÓN+NP se linkea a la cotización. En SOLO_PN se crea standalone.
- **Vacío**: sin precio — no se crea.
- **Dash (`-`)**: **BORRA** todos los precios existentes del PN via `DeletePartNumberPrice` (loop en STEP 7b).
- **`precioDefault: true`**: marca el precio nuevo como default via `SetPartNumberPricesAsDefaultPrice`. En SOLO_PN requiere releer el PN con `GetPartNumber` para obtener el ID del precio recién creado (el `SaveManyPNP_PN` no devuelve IDs).

### 3.7 `proceso`

- **Presente**: se resuelve via `processNodeByName` (proceso canónico de 9 nodos). Se envía como `defaultProcessNodeId` en `SavePartNumber`.
- **Vacío**: vacío → se preserva el proceso existente del PN (no se envía `null`).
- **Unresolved**: desde 1.5.12, si hay nombres de proceso que no se pueden resolver, se muestra modal `confirmUnresolvedProcesses` — el operador puede continuar sin ese proceso (se omite) o cancelar. Antes se hacía `throw`, bloqueando toda la corrida.
- **REPLACE risk**: `defaultProcessNodeId` es scalar — no hay REPLACE array. Pero en 1.5.16 el FK-fallback es crítico: `(pnNode.processNodeByDefaultProcessNodeId?.id ?? pnNode.defaultProcessNodeId) || part.processId`.

### 3.8 `specs` (2 slots, cols 33-36 en V10, 35-38 en V11)

- **Presente**: se resuelve via `specByName`. El slot incluye `name` y opcionalmente `param` (para specs de espesor con múltiples `defaultValues`).
- **Vacío**: el slot se omite.
- **Dash en `name`**: el slot se skipea.
- **Comportamiento en Call B**: specs se envían como `specsToApply` array. `SavePartNumber` aplica specs en REPLACE semantics de specs (no de params). Los params se sincronizan en STEP 6b.
- **Spec collision split (1.5.7)**: si 2 specs del mismo CSV row tienen el mismo `specFieldId`, las specs "perdedoras" se envían en calls individuales separados para que SH devuelva error visible en vez de hacer rollback silencioso.
- **REPLACE risk ALTO**: si el CSV trae 0 specs para un PN que tenía specs en SH, **las specs NO se borran** (ese es el comportamiento correcto — el script no archiva specs que no están en el CSV a menos que sea sentinel STEP 5). PERO los params de specs no-en-CSV que sí están en SH **podrían quedar huérfanos** si no pasan por STEP 6b.

### 3.9 `dims` (length, width, height, outerDiam, innerDiam)

- **Presente**: se construye via `buildDimensions()`, mapeando cada valor a `{geometryTypeDimensionTypeId, dimensionValue, unitId: MTR}`. Se envía en `partNumberDimensions` array.
- **Vacío**: la dimensión se omite del array.
- **REPLACE risk CRÍTICO**: `partNumberDimensions` es array con REPLACE semantics. Si el CSV trae 0 dims, el PN pierde todas sus dimensiones físicas.
- **Bug 1.5.15**: el filter+map en STEP 6b cleanup usaba `d.dimensionId` y `d.unitId` (nombres incorrectos) en vez de `d.geometryTypeDimensionTypeId` y `d.unitByUnitId?.id`. El filter retornaba `[]` siempre → SH borraba los dims. Fix: usar los nombres reales del response de `GetPartNumber`.
- **Bug 1.5.14**: mismo error en Call B preserve dims path.

### 3.10 `predictiveUsage` (materials predictivos, 9 slots)

- **Presente (número)**: crea/actualiza `UpdateInventoryItemPredictedUsage`.
- **Dash (`-`)**: archiva el item predictivo via `ArchivePredictedInventoryUsage`.
- **Vacío**: sin acción sobre ese material.
- **Orden de operaciones CRÍTICO (1.4.30)**: `unarchive → update → archive`. Invertir el orden causa pérdida de datos: si se archiva primero y luego se intenta update, el item ya no existe. Fix 1.4.31 (JJ/KK) — el orden se fija como: primero unarchive los que van a recibir update, luego update, luego archive los que tienen dash.
- **Pre-fetch**: antes del enrichWorker en corridas existentes, se pre-fetcha `predictedInventoryUsages` de cada PN para comparar contra CSV y determinar los 3 buckets.

### 3.11 `customInputs` (codigoSAT, metalBase, quoteIBMS, piezasCarga, etc.)

- **Presente**: `mergeCustomInputs()` hace deep-clone del CI existente del PN y overlaya los campos del CSV. Los campos se distribuyen en sub-objetos: `DatosFacturacion`, `DatosAdicionalesNP`, `DatosPlanificacion`, `NotasAdicionales`.
- **Bug crítico 1.5.9**: `extractPNShape` NO incluía `customInputs: ci || null`. En la corrida de recovery v104, los ~13,000 PNs perdieron todos sus customInputs porque el enrich no tenía los existentes como base para el merge. Fix: agregar `customInputs: ci || null` al shape.
- **Vacío**: si el resultado del merge es un objeto vacío, `mergeCustomInputs` retorna `null` (no manda objeto vacío a SH).

### 3.12 `pnGroup`

- **Presente**: lookup o creación via `resolveGroupId()` → `CreatePartNumberGroup` si no existe. Se envía como `partNumberGroupId`.
- **Dash**: `isDash(part.pnGroup)` → se envía `partNumberGroupId: null` (desvincula el grupo).
- **Vacío**: se preserva el grupo existente del PN. En STEP 6b cleanup (1.5.7): `isDash(part.pnGroup) ? null : (part.pnGroup ? await resolveGroupId(part.pnGroup) : FK-fallback)`.
- **FK-fallback (1.5.16)**: `(pnNode.partNumberGroupByPartNumberGroupId?.id ?? pnNode.partNumberGroupId) || null`.

### 3.13 `racks` (rackLinea, rackSec)

- **Presente**: `{name, ppr}`. Se acumula en `rackIn[]` con dedup intra-corrida por `rackTypeId|partNumberId`.
- **Dash en el nombre del rack**: agrega `pnId` a `racksToDelete` → STEP 7 borra todos los racks del PN via `DeletePartNumberRackType`.
- **ppr no entero (Fix M 1.4.2)**: `Math.floor(rk.ppr)` — fórmulas Excel con resultado decimal generaban HTTP 400 en el batch de 50.
- **Duplicate key upsert**: `SavePartNumberRackTypes` falla con `duplicate_key` si el (rackType, PN) ya existe → fallback a `UpdatePartNumberPerPerRackType` (nótese el typo "PerPer" en el nombre real de la mutación).
- **Fallback batch→individual (1.4.16)**: si cualquier batch de 50 falla (no solo duplicate), cada rack se reintenta individualmente.

### 3.14 `optInOuts` (tri-state, desde 1.5.13)

- **`true`**: activar el optIn/Out (enviar en `optInOuts` con `value:true`).
- **`false`**: desactivar.
- **`null`**: preservar — no se incluye en el array enviado a SH.
- **Antes de 1.5.13**: se enviaba siempre, lo que sobreescribía el state existente incluso cuando el CSV no especificaba nada.

### 3.15 `archivado`, `archivarAnterior`, `forzarDuplicado`

- **`archivado: true`**: el PN nuevo/modificado se archiva en STEP 8 via `UpdatePartNumber`.
- **`archivarAnterior: true`** (+ `archiveGlobal: true`): el PN anterior (`status.existingId` en `forceDup`) se archiva.
- **`archiveGlobal: false`** (toggle UI): ninguna fila archiva anterior, independientemente de lo que diga el CSV. `archiveOverride: true` en la fila puede forzar archivo aun con `archiveGlobal: false`.
- **`forzarDuplicado: true`**: fuerza `status: 'forceDup'` — crea PN nuevo incluso si el clasificador diría MODIFY.

---

## 4. Mapa de llamadas API

### 4.1 Queries de prefetch (una vez por corrida, no por PN)

| Query | Frecuencia | Descripción | Costo |
|---|---|---|---|
| `AllLabels` | 1× | Carga todos los labels del dominio | ~50-200 registros |
| `AllSpecs` | 1× | Carga todas las specs (con `specFieldSpecsBySpecId`) | ~100-500 registros |
| `AllProcesses` | 1× | Nodos de proceso canónicos | ~50-200 |
| `AllRackTypes` | 1× | Tipos de rack | ~20-50 |
| `AllGeometryTypes` | 1× | Tipos de geometría (solo si V11) | ~20-50 |
| `SearchUnits` | 1× | Unidades de medida | ~50-100 |
| `AllPartNumbers` (prefetch) | 2 passes × (N clientes) | PNs por cliente: primero `includeArchived:false`, luego `true` | **ALTO**: puede ser 22k + 24k = 46k PNs |

### 4.2 Queries por PN (enrich pipeline)

| Query | Cuando | Frecuencia |
|---|---|---|
| `SavePartNumber` Call A | Cada NEW o MODIFY en STEP 2 | 1× por PN |
| `SavePartNumber` Call B | Cada NEW o MODIFY en STEP 6 | 1× por PN |
| `SavePartNumber` conflictingExtras | Solo si hay spec-collision (≥2 specs con mismo specFieldId) | 0-N× por PN |
| `SavePartNumber` STEP 6b cleanup | Si hay specFieldParams duplicados (STEP 6b) | 0-1× por PN |
| `GetPartNumber` STEP 6b | Para cada PN en step6bCandidates que no está en cache | 1× por PN (con cache) |
| `AddParamsToPartNumber` | Por cada spec con params faltantes | 0-N× por spec por PN |

### 4.3 Queries por corrida (no por PN)

| Query | Cuando | Frecuencia |
|---|---|---|
| `CreateQuote` | COTIZACIÓN+NP, 1 por chunk | 1× por chunk |
| `UpdateQuote` | COTIZACIÓN+NP | 1× por chunk |
| `SaveManyPNP_Quote` | COTIZACIÓN+NP, batch 20 | ceil(N/20) por chunk |
| `SaveManyPNP_PN` | Precios standalone | ceil(N/20) |
| `SaveQuoteLines` | COTIZACIÓN+NP | 1 por línea con productos |
| `SavePartNumberRackTypes` | Si hay racks | ceil(rackIn/50) + fallbacks |
| `UpdatePartNumberPerPerRackType` | Solo en duplicate-key | 0-N |
| `DeletePartNumberRackType` | Si hay racks a borrar | N× (secuencial) |
| `DeletePartNumberPrice` | Si hay precios con dash | N× (secuencial) |
| `SetPartNumberPricesAsDefaultPrice` | Si hay precioDefault | 1 por batch |
| `UnsetPartNumberPriceAsDefaultPrice` | Para defaults anteriores | 1 por PN |
| `UpdatePartNumber` | Archive/unarchive STEP 8 | N× pool=8 |
| `ArchivePredictedInventoryUsage` | Predictivos: unarchive + archive | N× |
| `UpdateInventoryItemPredictedUsage` | Predictivos update | ceil(N/20) |

### 4.4 Análisis N+1 y patrones críticos

#### N+1 confirmado: `GetPartNumber` en STEP 6b

```
Para cada PN en step6bCandidates (puede ser todos los N existentes):
  → GetPartNumber (si no está en existingPnFullCache)
  → si hay idsToArchive: SavePartNumber (cleanup)
  → para cada spec: AddParamsToPartNumber (1 por param missing)
```

Un CSV con 3000 PNs existentes y 2 specs cada uno puede generar:
- 3000× GetPartNumber
- hasta 3000× SavePartNumber cleanup
- hasta 6000× AddParamsToPartNumber

**Total teórico**: ~12,000 llamadas API solo en STEP 6b.

#### N+1 confirmado: GetPartNumber en STEP 7b y STEP 8 (SOLO_PN)

Para borrar precios (STEP 7b): 1 `GetPartNumber` por PN con precio dash.
Para default price en SOLO_PN (STEP 8): 1 `GetPartNumber` por PN con `precioDefault` o `existing`.

En una corrida de 1500 PNs SOLO_PN con todos `precioDefault: true`: 1500 GetPartNumber secuenciales antes de 1.4.4, ahora en runPool pero aún son 1500 llamadas extra.

#### Consolidación posible: Call A + Call B

`SavePartNumber` se llama dos veces por PN (Call A: identifiers; Call B: full shape). La razón es garantizar que los identifiers estén persistidos antes de crear la cotización (STEP 3 necesita que el PN exista en SH). El split Call A/B fue introducido en 1.4.11.

**Propuesta**: en SOLO_PN mode, donde no hay cotización, se podría consolidar en un solo `SavePartNumber`. Ahorro: ~50% de las llamadas de enrich. Riesgo: el resume pierde granularidad (ya no hay `identifierEnrichDone` como checkpoint intermedio).

#### AllPartNumbers prefetch: el mayor costo de startup

La prefetch de clasificación carga **todos** los PNs del dominio por cliente (2 passes: activos + archivados). Con 46k PNs esto puede consumir ~200-300 MB de RAM y 30-60s de tiempo de red. Si el CSV solo toca 50 clientes de 500, se pre-fetcha todo igualmente.

**Optimización existente**: la columna `idSh` (V11, Pase 0) permite bypassear la prefetch para PNs conocidos. El fast-path de resume (1.4.23 fix) también permite saltarse la prefetch si las clasificaciones ya están en IndexedDB.

### 4.5 Total de llamadas API en una corrida típica

Para N=500 PNs en COTIZACIÓN+NP con 2 specs y 1 rack cada uno:

| Fase | Llamadas estimadas |
|---|---|
| Catalogs + prefetch | ~10 fijas + 2 AllPartNumbers |
| Call A (enrich identifiers) | 500 |
| SaveManyPNP + SaveQuoteLines | ~30 (batch 20) |
| Call B (enrich full) | 500 |
| STEP 6b GetPartNumber | 500 |
| STEP 6b AddParamsToPartNumber | ~1000 |
| STEP 7 Racks | ~10 (batch 50) |
| STEP 8 Archive | ~50-100 |
| **Total aprox.** | **~2700 llamadas** |

Para N=3000: ~16,000+ llamadas. A 8 workers concurrentes con ~300ms promedio por call, STEP 6b solo toma ~200 min de tiempo de CPU si no hay parallelismo extra.

---

## 5. Clasificación y deduplicación

### 5.1 `classifyPNsMassive` vs `classifyPNsOnDemand`

| Aspecto | Massive | OnDemand |
|---|---|---|
| Prefetch | AllPartNumbers global (todos los clientes) | AllPartNumbers por PN individual |
| Costo startup | Alto (46k PNs → ~200MB) | Bajo |
| Costo por PN | O(1) (ya en memoria) | 2 queries por PN |
| Cuándo se usa | Corridas grandes o cuando config.massive=true | Fallback o corridas pequeñas |
| Reanudación | Fast-path (skip prefetch si `classifications` en resume) | No aplica |

### 5.2 Pases de clasificación

#### Pase 0 — idSh-direct (solo V11)

Requiere que `part.idSh` esté poblado. Retorna inmediatamente `{pase:0, confidence:'idsh-direct', userDecided:true}`. No hay verificación de consistencia nombre/cliente contra el ID. El operador asume toda la responsabilidad.

#### Pase 1 — QuoteIBMS autoritativo

```
csvIbms == '' → saltar Pase 1

byIbmsAll = allPns.filter(p => p.quoteIBMS === csvIbms)
  if (byIbmsAll.length === 1) → MODIFY ese PN, confidence='ibms-exacto'
  if (byIbmsAll.length > 1):
    byIbmsExactName = find exacto por nombre
    if found → MODIFY ese, confidence='ibms+name-exacto'
    else → CAER A PASE 2 (ambigüedad — no escoge ciegamente)
```

**Caso real (1.4.28)**: en SCHNEIDER ELECTRIC había 22 grupos de PNs con mismo IBMS recreados bajo nombres ligeramente distintos. El `find()` ciego pre-1.4.28 elegía el primero del array (orden ID_DESC de AllPartNumbers) y asignaba al PN equivocado.

#### Pase 2 — Composite key exacto

```
compositeKey = `${customerId}||${name.upper}||${metalCanonico}||${acabadosCanonicos}`
byComposite = allPns.find(p => buildCompositeKey(p) === csvCompositeKey)
  if found:
    colision = csvIbms && pnIbms && pnIbms !== csvIbms
    if !colision → MODIFY ese PN, confidence='composite-exacto-*'
    else → CAER A PASE 3 (el PN existe pero tiene diferente IBMS → no es el mismo)
```

**Equivalencias semánticas (1.4.3)**: `metalEquivalents` y los grupos de `acabadosCanonicos` colapsan sinónimos a un token `__G<n>` antes de comparar. Permite que "Estaño" y "Estaño s/Aluminio" cuenten como el mismo acabado.

#### Pase 3 — Near-match por nombre

```
nameCandidates = activePns.filter(p => p.name.upper === csvRow.name.upper)
if (nameCandidates.length > 0):
  ranked = rankCandidates(csvRow, nameCandidates)
  labelsMatchFull = acabadosCanonicos(ranked[0]) === acabadosCanonicos(csvRow)
  if labelsMatchFull → MODIFY ranked[0], confidence='name+labels-match'
  else:
    blankCandidate = ranked.find(c => acabados(c) === '')
    if blankCandidate → MODIFY ese, confidence='name+blank-candidate'
    else → NEW, confidence='name-only-labels-differ'
```

`rankCandidates` ordena por: metal match → labels match → IBMS match → id ascendente.

**Nota crítica**: Pase 3 solo ve **activos** (`activePns = allPns.filter(p => !p.archivedAt)`). Pases 1 y 2 ven archivados también (pueden trigger desarchivado en STEP 8 via `pnsToUnarchive`).

#### Sin match → NEW

```
return {
  classification: 'NEW',
  pase: null,
  confidence: 'sin-match',
  targetPnId: null
}
```

### 5.3 `dedupModifyTargets`

Dos filas del CSV no pueden MODIFY el mismo PN existente. La función:

1. Ordena claimers por precedencia: Pase 1 < 2 < 3 strict < 3 blank, luego idx ascendente.
2. El primer claimer "gana" (su `existingId` queda en `used`).
3. Los "perdedores":
   - Si tienen `candidates` con alternate de acabados iguales al CSV → reasignan al alternate. `dedupReassigned=true`, `dedupOriginalTargetPnId` guarda el id original.
   - Si tienen alternate sin acabados (blank) → reasignan con `confidence='name+blank-candidate'`.
   - Si no hay alternate → se demoten a NEW. `dedupConflict=true`, `dedupConflictTargetPnId` guarda el id que no se pudo usar.

**El incidente de 2,391 NEWs**: en una corrida con CSV de ~2,400 PNs donde todos tenían el mismo IBMS y el catálogo tenía 1 PN con ese IBMS, el Pase 1 asignó el mismo `existingId` a las 2,400 filas. `dedupModifyTargets` demotó 2,399 a NEW (solo 1 puede ser MODIFY al mismo PN). Los 2,399 NEWs crearon duplicados en SH. Solución: V11 con `idSh` para anclar filas individualmente.

### 5.4 `detectCsvDuplicates`

Detecta filas con mismo `(pn.upper, customerId)` dentro del CSV. Marca `isCsvDuplicate`, `csvDuplicateIndex`, `csvDuplicateGroupSize` en `parts[]`. NO fuerza status — solo informa. El clasificador opera independientemente; `dedupModifyTargets` maneja los conflictos de IDs.

### 5.5 `buildEquivIndex` y helpers de canonicalización

```js
buildEquivIndex(groups) → Map<normLabel, groupId>
// groups viene de config.json metalEquivalents (array de arrays de sinónimos)

metalCanonico(metal, equivIndex) → '__M<groupId>' | normLabel
acabadosCanonicos(labels, nonFinishList, equivIndex) → 'TOKEN1|TOKEN2|...' ordenado
acabadosOrdenados(labels, nonFinishList) → 'NORM1|NORM2|...' ordenado (sin equiv)
```

`nonFinishList` es la lista de labels que NO son acabados (ej. labels de línea de negocio, configuración interna). Se excluyen del composite key para que no rompan el match por decoradores no-semánticos.

### 5.6 Problema: clasificación asimétrica entre corridas

Si en corrida 1 un PN se clasifica como MODIFY+Pase2 y en corrida 2 se carga el mismo CSV pero el catálogo tiene un PN nuevo con el mismo nombre y metal, el Pase 2 podría resolver a un PN diferente. El `idSh` (V11) es la única solución definitiva para anclar la intención.

---

## 6. Robustez y defensivos

### 6.1 Cancelación y stale-check

```js
let runId = 0; // entero global
function cancelRun() { runId++; state.cancelled = true; }
function bailIfStale(myRunIdLocal) {
  if (myRunIdLocal !== runId || state.cancelled) throw new BailError();
}
function isBail(e) { return e instanceof BailError || e?.name === 'BailError'; }
```

Cada worker recibe `myRunId = runId` al iniciar. En cada boundary async llama `bailIfStale(myRunId)`. Si el usuario presiona "Detener", `cancelRun()` incrementa `runId` → todos los workers en vuelo lanzan `BailError` en su próximo boundary → el `catch` del `execute()` detecta `isBail(e)` y limpia. El `runPool` propagará el BailError sin tragárselo.

**Boundary coverage**: el código auditado tiene `bailIfStale` en cada `await` que involucra red. Hay un gap potencial en loops de archivado de racks (`racksToDelete`) que son secuenciales sin `bailIfStale` inter-iteración.

### 6.2 `withRetry`

```js
withRetry(fn, label, runId, retries=[1000,2000,4000])
  → retries en 429 / 503 / network error
  → NO retry en unique_constraint (23505 / 23P01)
  → bailIfStale entre retries
```

Backoff exponencial fijo: 1s, 2s, 4s. Sin jitter. En corridas con 8 workers concurrentes que todos fallen simultáneamente, los 8 reintentan al mismo segundo → thundering herd potencial si el servidor ya está saturado.

**Pendiente**: agregar jitter (`delay * (0.8 + Math.random() * 0.4)`) para distribuir los reintentos.

### 6.3 `runPool`

Semáforo de N workers concurrentes sobre un array de índices. Implementación:

```js
async function runPool(items, workerFn, concurrency, onProgress, runId) {
  // Dispatcher + worker slots vía Promise.race
  // BailError se propaga inmediatamente, cancela todos los workers
}
```

No hay timeout por worker individual — un worker colgado bloquea ese slot indefinidamente. Si SH tarda >2min en responder (sin timeout en `fetch`), el slot queda ocupado y el pool efectivamente reduce concurrencia.

**Recomendación**: agregar `AbortController` con timeout de 30s por llamada API. En `steelhead-api.js` el `api().query()` no tiene timeout hoy.

### 6.4 Sistema de resume (IndexedDB)

Desde 1.4.27, el estado de resume vive en IndexedDB (migrado desde localStorage que tenía cuota de 5-10MB). Estructura:

```
IndexedDB: sa-bulk-upload
  store: resume
    key: sa_bulk_resume_<hash_del_csv>
    value: {
      phase, completedPNs, identifierEnrichDone,
      archivedSentinelsPreQuote, syncParamsCompletedPNs,
      classifications, timestamp
    }
  store: index
    key: sa_bulk_resume_index
    value: [array de hashes activos]
```

El hash del CSV se computa al parsear (probablemente checksum del contenido). Las entradas se auto-purgan después de TTL.

**Gap identificado (bitácora pendiente)**: STEP 7 (Racks) y STEP 8 (archive) no persisten progreso. Si un crash ocurre a mitad de STEP 8 con 500 PNs a archivar, el resume reinicia STEP 8 desde 0 — benigno (archivar 2× es idempotente via `UpdatePartNumber`) pero ineficiente.

### 6.5 Memory management

**Capa 1: `stopDatadogSessionReplay()`**
Detiene Datadog RUM SDK, monkey-patchea fetch/sendBeacon/XHR para bloquear requests a Datadog. Idempotente via `window.__sa_dd_stopped`. Evita que el SDK grabe las ~46k responses del prefetch en su buffer de replay (que crecía a ~3.5× el heap esperado).

**Capa 2: `createMemMonitor` (del shared host-cleanup)**
Polling cada 2s de `performance.memory`. En ≥70%: `stopDatadogSessionReplay()` re-aplicado. En ≥88%: `triggerMemoryGuardrail()`.

**Capa 3: `triggerMemoryGuardrail` (88%)**
```js
function triggerMemoryGuardrail() {
  persistResumeState(); // Checkpoint
  cancelRun();          // BailError en todos los workers
  showOOMModal();       // "Recarga la tab para reanudar"
}
```
Convierte crash impredecible en checkpoint limpio. El operador recarga y reanuda desde donde quedó.

**Capa 4: `makePeriodicDrain(everyN)`**
`apolloCacheDrain()` cada N PNs. Llama `clearStore()` o `cache.reset()` en el Apollo Client del SPA host. Previene crecimiento lineal del cache Apollo con los responses de `GetPartNumber`.

**Capa 5: `existingPnFullCache.delete(entry.pn.id)` en finally de step6bWorker**
Libera el pnNode (~25KB) inmediatamente al terminar el PN en STEP 6b. Sin esto: 3692 × 25KB = ~92MB acumulados.

**Capa 6: `log ring buffer` (200 entries)**
El panel de log está limitado a 200 entradas para no crecer el DOM indefinidamente.

**Punto débil identificado**: el prefetch global (`AllPartNumbers`, 2 passes) carga y mantiene todos los PNs en `pnsByCustomer` Map durante toda la corrida. Para 46k PNs × ~1KB/PN = ~46MB solo de la estructura de clasificación. Esta memoria no se libera hasta que `execute()` termina. Si el clasificador fast-path de resume se activa, esta memoria no se carga — pero en corridas frescas siempre paga este costo.

### 6.6 Sanitización y XSS

El applet construye HTML via `innerHTML` en varios lugares (showPreview, showResult, panel de log). Los datos interpolados vienen de:
- `part.pn` (nombre del PN — input del usuario via CSV)
- `stats.*` (contadores numéricos — seguros)
- `errors[]` (mensajes de error de API — pueden contener HTML si SH devuelve HTML en error response)

**Riesgo identificado (pendiente de seguridad `#2` en CLAUDE.md)**: un nombre de PN con `<script>` o `<img onerror=...>` podría ejecutar código en la tab de Steelhead. La app está autenticada con las cookies del usuario → código arbitrario tiene acceso a todos los endpoints que el usuario puede ver.

**Recomendación**: helper `escapeHtml(s)` para todas las interpolaciones de datos externos en innerHTML.

### 6.7 Error handling y visibilidad

- Todos los workers tienen `try/catch` con `errors.push(msg)`. Los errores se muestran en el panel y se incluyen en el reporte XLSX.
- `BailError` siempre se re-lanza (nunca se traga).
- `unique_constraint` errors en `AddParamsToPartNumber` se silencian (ya está presente — race condition o retry).
- `unarchive` errors se silencian (puede que no estuviera archivado).
- `SetDefaultPrice` errors se loggean pero no abortan la corrida.

**Gap**: errores en `SaveManyPNP_PN` (precios standalone SOLO_PN) — pre-1.4.13 el bloque tenía un `ReferenceError` que el catch tragaba y los precios no se guardaban sin log visible. Fix en 1.4.13 (Fix X1).

### 6.8 `sa_load_history` aún en localStorage

A pesar de la migración del resume a IndexedDB en 1.4.27, el historial de corridas (`sa_load_history`) sigue en `localStorage` con cap de 20 entradas. Con corridas de 1500 PNs, una entrada puede pesar ~1MB → 20 entradas = ~20MB que puede superar la cuota de 5-10MB en Chrome. El código tiene manejo de `QuotaExceededError` (reduce el array a la mitad iterativamente), pero es un workaround. El fix correcto es migrar `sa_load_history` a IndexedDB también (pendiente en bitácora desde 1.4.27).

---

## 7. Roadmap de optimización

### Prioridad CRÍTICA (correctitud, no solo rendimiento)

#### O1: Migrar `sa_load_history` a IndexedDB

**Impacto**: evita pérdida silenciosa del historial en corridas pesadas.  
**Esfuerzo**: bajo — misma API IDB ya disponible, solo cambiar el read/write del historial.  
**Riesgo**: bajo — migración one-way, forward-only.  
**Constraint**: respetar la regla "nunca ignorar nada que suba" — el historial es el único log persistente de qué se procesó.

#### O2: FK-fallback en todos los usos de `pnNode.*`

**Impacto**: previene que SH borre campos al enviar scalars null.  
**Esfuerzo**: medio — auditoría de todos los lugares donde se usa `pnNode.customerId`, `pnNode.defaultProcessNodeId`, `pnNode.geometryTypeId`, `pnNode.partNumberGroupId` sin FK-fallback.  
**Riesgo**: bajo — el patrón ya está implementado en 4 lugares; extenderlo a cualquier otro uso es mecánico.  
**Señal de alerta**: buscar `pnNode.customerId` (sin `.customerByCustomerId?.id ??`) en el código.

#### O3: Sanitizar `innerHTML` con `escapeHtml`

**Impacto**: previene XSS en la tab autenticada de Steelhead.  
**Esfuerzo**: bajo — función helper de 5 líneas + reemplazar todas las interpolaciones en showPreview, showResult, panel log.  
**Riesgo**: bajo — el cambio es aditivo.  
**Constraint**: no cambiar el comportamiento — solo escapar, no eliminar funcionalidad.

### Prioridad ALTA (rendimiento en corridas grandes)

#### O4: Timeout por llamada API (AbortController)

**Impacto**: workers colgados no bloquean slots del pool indefinidamente. En corridas de 3000+ PNs, un worker colgado a los 30min puede hacer que la corrida dure 2× más del esperado.  
**Esfuerzo**: medio — modificar `steelhead-api.js` para acepar `signal` de `AbortController` y pasar un timeout de 30s.  
**Riesgo**: bajo — los workers ya tienen retry con `withRetry`; un timeout simplemente convierte un hang en un error retriable.

#### O5: Jitter en `withRetry`

**Impacto**: evita thundering herd cuando los 8 workers concurrentes fallan simultáneamente y reintentan al mismo segundo.  
**Esfuerzo**: mínimo — una línea: `delay = delay * (0.75 + Math.random() * 0.5)`.  
**Riesgo**: mínimo.

#### O6: Consolidar Call A + Call B en SOLO_PN

**Impacto**: reduce ~50% de las llamadas `SavePartNumber` en corridas SOLO_PN (sin cotización).  
**Esfuerzo**: medio — el split existe por razón válida en COTIZACIÓN+NP (PN debe existir antes del SaveManyPNP). En SOLO_PN esa restricción no aplica.  
**Riesgo**: medio — perder el checkpoint de `identifierEnrichDone` como granularidad de resume. Mitigación: el resume puede usar solo `completedPNs` (Call B completo) como único checkpoint.  
**Constraint**: "nunca ignorar nada que suba" — si Call B falla, el PN no debe quedar en `completedPNs` (ya garantizado por `pnSucceeded` flag de 1.4.13).

#### O7: Persistir progreso en STEP 7 (racks) y STEP 8 (archive)

**Impacto**: resume desde donde quedó si hay OOM durante el archivado masivo.  
**Esfuerzo**: bajo — mismo patrón que `syncParamsCompletedPNs`.  
**Riesgo**: bajo — idempotente: archivar 2× un PN ya archivado es no-op en SH.

### Prioridad MEDIA (calidad del código)

#### O8: Renumerar pasos del pipeline

**Impacto**: el operador ve "Paso 1/9, 2/9, 3/9..." sin huecos ni decimales.  
**Estado actual**: la numeración tiene huecos: 1, 2, 3, 4.5, 5, 6, 6a, 6b, 7, 8, sin "9/9". Los pasos 4.5, 6a, 6b son sub-pasos opcionales.  
**Propuesta**: unificar en 1-10 con sub-índices opcionales, o simplemente añadir "Paso 9/9: Generando reporte..." al final.

#### O9: Prefetch parcial por cliente en `classifyPNsMassive`

**Impacto**: en corridas con 50 clientes de un catálogo de 500, solo prefetchear los 50 en el CSV.  
**Esfuerzo**: medio — filtrar el prefetch por `uniqueCustomerIds` del CSV.  
**Riesgo**: medio — el clasificador asume que `pnsByCustomer` contiene TODOS los PNs del cliente para detectar duplicados. Un prefetch parcial por cliente sigue siendo completo para ese cliente.  
**Nota**: el prefetch ya está segmentado por cliente (`AllPartNumbers` con `customerId`). La optimización es solo no fetchear clientes que no están en el CSV.

#### O10: Separar la lógica de clasificación en módulo independiente

**Impacto**: testeable en aislamiento sin cargar el entorno de SH. Los helpers ya están exportados en `window.BulkUploadHelpers` (línea 6864), pero los tests deben mockearse contra la API.  
**Esfuerzo**: alto — requiere separar `classifyOnePN`, `dedupModifyTargets`, helpers en un archivo `classifier.js` independiente.  
**Riesgo**: bajo si se hace con exports compatibles.

### Prioridad BAJA (deuda técnica)

#### O11: Cerrar el gap `bailIfStale` en delete loops secuenciales

En el loop `racksToDelete` (STEP 7, borrado de racks) y el loop de borrado de precios (STEP 7b), las iteraciones son secuenciales sin `bailIfStale` entre iteraciones. Si hay 200 PNs con racks a borrar y el usuario presiona "Detener", el loop continúa hasta terminar.  
**Fix**: agregar `bailIfStale(myRunId)` al inicio de cada iteración del loop.

#### O12: Limitar `sa_load_history` parts[] en corridas muy grandes

Una corrida de 3692 PNs serializa `parts[]` como ~3MB por entrada. Con `cap=20`, localStorage puede intentar guardar ~60MB. El manejo de `QuotaExceededError` recorta el array, pero es mejor no llegar ahí: cap `parts` a las primeras 500 filas en el historial, o mover a IDB (O1).

#### O13: Revisar el triple `SavePartNumber` en spec-collision escenario

Cuando hay N specs con el mismo `specFieldId` en una fila CSV, el applet genera:
- Call A (identifiers)
- Call B (specs normales)
- 1 call extra por cada spec "perdedora" (conflictingExtras)

Para una fila con 5 specs y 3 colisiones: 1+1+3 = 5 llamadas por PN. Costo alto y difícil de diagnosticar. **Investigar** si SH tiene una API para hacer batch de specs sin restricción de unicidad por specField, o si el STEP 6b cleanup es suficiente y conflictingExtras puede eliminarse.

---

## 8. Glosario y referencias

### Términos del dominio

| Término | Definición | Referencias |
|---|---|---|
| **PN / Part Number** | Número de parte en Steelhead. Entidad central del applet. | Todo el pipeline |
| **Cotización / Quote** | `CreateReceivedOrder` + líneas. Solo en COTIZACIÓN+NP mode. | STEPs 1, 3 |
| **IBMS** | Código de identificación interna del cliente (QuoteIBMS). Clave autoritativa en Pase 1. | `classifyOnePN`, campo `quoteIBMS` |
| **Label** | Etiqueta de clasificación del PN (acabado, metal, etc.). Array con REPLACE semantics. | `SavePartNumber.labelIds` |
| **Spec / SpecField / SpecFieldParam** | Especificación técnica del PN y sus parámetros jerárquicos. | STEP 6b, `AddParamsToPartNumber` |
| **Composite key** | `customerId||name||metalCanonico||acabadosCanonicos` — clave de clasificación Pase 2. | `buildCompositeKey` |
| **REPLACE semantics** | `SavePartNumber` hace REPLACE (no MERGE) en arrays (`labelIds`, `partNumberDimensions`, etc.). Mandar `[]` borra el contenido. | Secciones 3.4, 3.9 |
| **FK-fallback** | Patrón `(pnNode.XByX?.id ?? pnNode.X) || part.X` para compensar el bug del persisted query `GetPartNumber` que devuelve scalars null. | 1.5.16, STEP 6b cleanup |
| **Sentinel pre-quote** | Archivo de specs no-en-CSV antes de crear la cotización (STEP 5). Previene `unique_constraint` en `SavePartNumber` durante enrich. | STEP 5, 1.4.8 |
| **Call A / Call B split** | `SavePartNumber` dividido en dos calls: Call A (identifiers para que exista en SH antes de la cotización) y Call B (full shape con todos los campos). | 1.4.11 |
| **dedupModifyTargets** | Función que resuelve conflictos cuando 2+ filas CSV apuntan al mismo PN existente. Ganador por precedencia de pase, perdedor busca alterno o se demota a NEW. | `dedupModifyTargets()` |
| **BailError** | Error marcador para cancelación limpia. Se detecta con `isBail(e)` y se re-lanza siempre (nunca se traga). | `bailIfStale`, `runPool` |
| **runPool** | Pool de N workers concurrentes sobre array de índices. El pool se cancela propagando `BailError`. | Todo el pipeline |
| **withRetry** | Wrapper de retries con backoff [1s, 2s, 4s] para 429/503/network. No reintenta `unique_constraint`. | Todo el pipeline |
| **pnLookup** | Map `rowIdx → {pn: {id, ...}, pnp: {id, ...}}` construido progresivamente durante el enrich. Es la estructura central que conecta filas CSV con entidades SH. | STEP 6, 6a, 6b, 7, 8 |
| **resumeState** | Objeto serializado en IndexedDB que permite reanudar corridas interrumpidas. Incluye checkpoints por fase y listas de PNs completados. | 1.4.27 |
| **optInOuts tri-state** | `true`=activar, `false`=desactivar, `null`=preservar. Antes 1.5.13 se enviaba siempre true/false, sobreescribiendo sin querer. | 1.5.13 |
| **tipoGeometria** | Solo V11. Nombre de geometría para lookup dinámico en `AllGeometryTypes`. V10 usaba siempre `geometryGenericaId=831`. | V11_COLS, STEP 6 |
| **chunking** | División del CSV en bloques de hasta `defaultChunkSize` (250) filas para crear múltiples cotizaciones. Solo en COTIZACIÓN+NP. | `chunkParts`, 1.3.0 |

### Versiones históricas clave

| Versión | Cambio principal | Lección |
|---|---|---|
| **1.5.16** | FK-fallback para scalars bugged en `GetPartNumber` | `GetPartNumber` persisted query siempre devuelve null en scalars (`customerId`, etc.); usar FK relacional |
| **1.5.15** | Fix field names en STEP 6b cleanup (`geometryTypeDimensionTypeId` vs `dimensionId`) | Los nombres del response de `GetPartNumber` difieren de los nombres del input de `SavePartNumber` |
| **1.5.9** | `extractPNShape` no incluía `customInputs` → pérdida masiva de customInputs | El shape del prefetch debe incluir TODOS los campos que el enrich necesita para merge |
| **1.5.7** | Spec-collision split — specs con mismo specFieldId en calls individuales | SH hace rollback silencioso cuando 2 specs del mismo SpecField van en el mismo Save |
| **1.5.6** | STEP 6b preserve labels/dims antes de archivar specFieldParams duplicados | REPLACE semantics afecta TODO el Save, no solo los campos que quieres cambiar |
| **1.4.38** | STEP 6b — regla: 1 row por SpecField con processNodeId=null | SH solo soporta 1 row activo por SpecField; múltiples rows generan conflictos exclusion constraint |
| **1.4.30** | Fix orden predictivos: unarchive → update → archive | El orden importa: archivar primero destruye el item que quieres actualizar |
| **1.4.28** | Homónimos en Pase 1 IBMS — no escoge ciegamente con múltiples IDs | `find()` en array sin desempate → resultado no-determinístico por orden de API |
| **1.4.27** | localStorage → IndexedDB para resume state | localStorage tiene cuota de 5-10MB; corridas de 3000+ PNs la revientan |
| **1.4.23** | Fast-path resume — skip prefetch si classifications en IDB | El comparador del fast-path usaba `parts[i].csvRowKey` (undefined) — nunca se aplicaba |
| **1.4.13** | `pnSucceeded` flag — no marcar completed si falló | Sin la flag, PNs fallidos por red intermitente se marcaban completed y se saltaban en el resume |
| **1.4.11** | Split Call A / Call B | Necesario para garantizar que el PN existe en SH antes de SaveManyPNP de la cotización |
| **1.4.4** | `runPool` para prefetch de default prices (SOLO_PN) | Loop secuencial de 1500 GetPartNumber = 10-20 min; con pool=8: 2-3 min |
| **1.4.2** | `Math.floor(ppr)` para partsPerRack | Valores decimales en Excel generan HTTP 400 en GraphQL Int field |
| **1.3.0** | Chunking de corridas grandes en múltiples cotizaciones | SH tiene límite de líneas por cotización; chunking a 250 es el default |
| **1.2.12** | Pases 1/2 incluyen archivados (autodesarchivado) | Pase 3 solo activos para no contaminar el dropdown con históricos |
| **1.2.11** | `dedupModifyTargets` con 3-level fallback (strict, blank, demote) | El incidente de 2,391 NEWs por colisión de targets motivó el diseño actual |

### Archivos relacionados

| Archivo | Descripción |
|---|---|
| `remote/scripts/bulk-upload.js` | Script principal (6874 líneas, VERSION='1.5.16') |
| `remote/scripts/host-cleanup-shared.js` | Helpers de memory management: stopDatadog, apolloCacheDrain, createMemMonitor, makePeriodicDrain |
| `remote/scripts/steelhead-api.js` | Cliente HTTP para Apollo Persisted Queries. api().query(operationName, vars) |
| `remote/config.json` | Hashes SHA256 de persisted queries, domain constants (geometryGenericaId, dimensionIds, etc.), concurrencies, retry config |
| `docs/applets/bulk-upload.md` | Bitácora completa de versiones (1.0.0 → 1.5.16) con lecciones y planes de validación |
| `docs/api/persisted-queries-playbook.md` | Diagnóstico de hashes rotados vs deprecados |

### Hashes de persisted queries usados (config.json, 2026-05-30)

Las operaciones críticas del pipeline están en `config.json.hashes`. Los nombres clave:

- `SavePartNumber` — mutación central. Se usa en Call A, Call B, conflictingExtras, STEP 5 sentinel, STEP 6b cleanup.
- `GetPartNumber` — fetch de un PN completo. Se usa en STEP 6b, STEP 7b delete prices, STEP 8 default price SOLO_PN.
- `AllPartNumbers` — prefetch masivo. Puede retornar 50,000 registros con `massiveMaxResults`.
- `AddParamsToPartNumber` — agrega specFieldParams a un PN. Falla con exclusion constraint si ya existe (silenciado).
- `UpdatePartNumber` — archive/unarchive (solo `archivedAt` field).
- `SaveManyPartNumberPrices` (`SaveManyPNP_Quote`, `SaveManyPNP_PN`) — crea precios, batch de 20.
- `ArchivePredictedInventoryUsage` / `UpdateInventoryItemPredictedUsage` — gestión de materiales predictivos.
- `SavePartNumberRackTypes` / `UpdatePartNumberPerPerRackType` / `DeletePartNumberRackType` — gestión de racks.

Los hashes rotan cuando Steelhead actualiza. Si una llamada falla con HTTP 400 `"Must provide a query string."`, el hash expiró. Ver `docs/api/persisted-queries-playbook.md`.

---

*Documento generado en 2026-05-31. Versión auditada: bulk-upload.js 1.5.16. Para actualizar este audit ante una nueva versión, comparar los cambios del changelog en `docs/applets/bulk-upload.md` contra las secciones afectadas de este documento.*
