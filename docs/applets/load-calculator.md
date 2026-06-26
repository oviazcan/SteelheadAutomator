# Applet: `load-calculator` — Calculadora de Piezas por Carga

**Versión actual:** 0.2.0 (**Fase 1 validada en vivo** + **Fase 2a/2b**: calculadora en el modal de Rack Types. F2a: intercepta `CreateEditPartsPerRackTypeQuery`, resuelve línea→estación→params+barriles, dims del Geometry Type, área DMK; al elegir Rack Type calcula (BARRIL/RACK) y autollenan "Parts Per Rack". F2b: **Persistir en el PN** = `DatosPlanificacion.PiezasCarga` + Control de Cambios vía **`UpdatePartNumber {id, customInputs}`** (input PARCIAL, no toca acabados/specs/dims/precios — evita el riesgo de `SavePartNumber` completo), con confirmación previa. **Pendiente validación en vivo de F2a/F2b.**)
**Archivos:** `remote/scripts/load-calculator.js` (configurador, popup) · `remote/scripts/load-calculator-modal.js` (F2a/F2b, autoInject) · `remote/scripts/load-calculator-engine.js` (motor puro) · `remote/scripts/load-calculator-stations.js` (núcleo puro)
**Tests:** `tools/test/load-calculator-engine.test.js` (12) · `tools/test/load-calculator-stations.test.js` (18) — 30 verdes
**Global:** `window.LoadCalculator` (`openStationConfig`) · `window.LoadCalculatorEngine` · `window.LoadCalculatorStations` · `window.LoadCalculatorModal` (auto)

## Fase 2 — calculadora en el modal de Rack Types

- **Activación:** app `autoInject`; `load-calculator-modal.js` hace monkey-patch de `window.fetch` e intercepta `CreateEditPartsPerRackTypeQuery` (trae `allRackTypes` + `inventoryItemUnitConversions` con el área DMK del PN). Panel oscuro flotante.
- **Contexto:** `GetPartNumber` → línea (dim 349 vía `acctPnDimensionValueSelections` + `GetDimension`) + dims (`partNumberDimensions` LENGTH/WIDTH metros→pulgadas). Línea → estación `-LI` (`findSchedulableStationsForLine`) → `GetStation.customInputs` (params + `CapacidadesBarril`). Dropdown override.
- **Cálculo (`computeForRackType`):** Rack Type en `CapacidadesBarril` → **BARRIL** (`cap/areaPieza`); si no → **RACK** = cuadrícula + área. **Aplicar** = `fillPartsPerRack` (MUI native setter).
- **Persistencia F2b (`persistToPN`):** `GetPartNumber` → `buildPlanningCustomInputs` (RMW de `DatosPlanificacion.PiezasCarga` + append `ControlCambios`, usuario vía `CurrentUserActiveSegments`) → **`UpdatePartNumber {id, customInputs}`** (parcial). `confirm()` previo.
- **Pendiente F2c:** persistir **dims** (Geometry Type) y **área DMK/CMK/FTK** cuando el PN no las tiene — requiere `SaveGeometryType` + shapes de las mutaciones de unit conversion (o `SavePartNumber` completo). Aquí vive el "registrar en Geometría Genérica (831) avisando".
**Plan/diseño:** [`docs/superpowers/plans/2026-06-24-load-calculator.md`](../superpowers/plans/2026-06-24-load-calculator.md)

## Qué es

Automatiza el cálculo de **piezas por carga** (rack o barril) y **cargas por hora** que ingeniería hace hoy a mano en `Calculo.xlsx`, integrándolo en Steelhead. Se entrega en fases:

- **Fase 1 (esta) — Configurador de Estaciones:** datos maestros. Captura los parámetros de tina/línea (dims, capacidad DMK, factor, # estaciones, ciclo, OEE) en `customInputs` de cada estación. Punto de entrada: popup → `LoadCalculator.openStationConfig`.
- **Fase 2 (pendiente) — Calculadora en el modal de Rack Types:** detecta `CreateEditPartsPerRackTypeQuery`, calcula piezas/carga y autollenan el campo "Parts Per Rack"; persiste partsPerRack + `DatosPlanificacion` + Control de Cambios + dims/área (DMK/CMK/FTK) en el Geometry Type del PN.

## Arquitectura

### Motor de cálculo — `load-calculator-engine.js` (puro, dual-export)
- `gridPieces` (cuadrícula): **orientación fija** lado largo de tina × lado corto de pieza = columnas. Reproduce los golden del Excel (87/112/112). La orientación inversa daría 90 — corregido vs el plan original.
- `areaPieces` (área): `FLOOR(areaTina_dm2 × factor / areaPieza_dm2)`. Golden 47/123/105.
- `barrelPieces` (barril/DMK): `FLOOR(capacidad_DMK / areaPieza_dm2)`.
- `decideMode` (Rack/Barril/Híbrida-PZA→RACK/Híbrida-KG→BARRIL/Célula→NINGUNO), `loadsPerHour`, helpers `mToIn`/`cmToIn`/`cm2ToDm2`.

### Configurador — `load-calculator-stations.js` (puro) + `load-calculator.js` (DOM)
Núcleo puro (RMW **no-destructivo**, lección de oro del proyecto):
- `buildStationInputSchema(existing, fields)` — extiende el schema de estación preservando `NombreAnterior/DivisaManoObra/Capacidad` + `ui:order`.
- `buildUpdateStationInputsVars(...)` — payload RMW de `UpdateStationInputs` (mergea sobre `customInputs` existentes).
- `schemaMissingFields`, `parseStationLine` (`T205-TI00-019…` → `T205`), `groupStationsByLine`.

Applet DOM (`load-calculator.js`): panel flotante (patrón `wo-mover`), modo **estación individual** o **bulk por línea**, banner "Extender esquema" cuando faltan campos, prefill desde `customInputs` de la estación.

### Campos del schema de estación (ronda 2 de feedback en vivo)
`TipoLinea` (enum) · `TinaLargoMaxCm` · `TinaAnchoMaxCm` (largo/ancho **máximos** de tina) · `SepColCm` · `SepFilaCm` · `FactorArea` · **`CapacidadesBarril`** (array `{rackTypeId, rackTypeName, capacidadDMK}` — una estación procesa varios barriles con distinta capacidad; el RackType viene de `AllRackTypes`). Capturados en cm; el motor convierte.

**Quitados** (decisión del usuario): `NumEstaciones`, `TiempoCicloMin` (el ciclo sale del **tratamiento genérico** del proceso del NP, no de aquí), `OEE` (no se configura en customInput). `CapacidadDMK` simple → reemplazado por el array `CapacidadesBarril`.

### Estaciones objetivo = sólo las PROGRAMABLES
El dropdown se filtra a estaciones **con calendario** (`stationIsSchedulable`: `calendarId`/`calendarByCalendarId.id`) — las `-LI` (generales de línea) y cotizables. Sólo en esas vale la pena cargar datos. Se quitó el toggle individual/línea (las `-LI` ya representan la línea).

### UI — tema OSCURO
Panel `#1e293b`/inputs `#0f172a`/título `#38bdf8` (patrón de `proceso-calculator`/`archiver`/`spec-migrator`). El modo oscuro es lo que distingue los modales de la extensión de los de Steelhead. Layout en grid `210px 1fr` con `min-width:0` para que el `<select>` de estación no desborde (fix del corte reportado en v0.1.0).

### Modelo de datos (hashes en `config.steelhead.hashes`)
| Acción | Op | Notas |
|---|---|---|
| Listar estaciones | `AllStations` | `pagedData.nodes[]{id,name}`, paginado offset/first 500 |
| Leer estación | `GetStation {id}` | `stationById.customInputs` + `stationInputSchemaByInputSchemaId.id` |
| Schema vigente | `GetStationInputSchema` | `allStationInputSchemas.nodes[]` → id más alto (latest) |
| Extender schema | `CreateStationInputSchema {inputSchema, uiSchema}` | response solo `clientMutationId` → re-fetch latest para el id nuevo |
| Escribir valores | `UpdateStationInputs {stationId, inputSchemaId, customInputs}` | RMW; valida keys contra el schema → extender ANTES de escribir |

Geometría (fase 2, ya en config): `geometryGenericaId:831`, `geometryDimensions`, `AllGeometryTypes`/`SaveGeometryType`. Unidad **DMK=3975** agregada a `domain.unitIds`. Área de la pieza vive como factor DMK del inventory item del PN (lo trae `CreateEditPartsPerRackTypeQuery`).

## Lecciones
1. **Orientación de cuadrícula:** el plan original tenía largo/ancho de pieza intercambiados; los golden reales (87/112/112) exigen lado-largo-tina × lado-corto-pieza. Validar SIEMPRE contra los 3 golden.
2. **Extender schema ANTES de escribir:** `UpdateStationInputs` valida `customInputs` contra el `inputSchemaId`; hay que crear el schema extendido y usar su id nuevo (re-fetch, no lo devuelve la mutación).
3. **RMW no-destructivo** tanto en schema como en customInputs (REPLACE total en SH).
4. **Bulk por línea = N×GetStation** (para leer cada `customInputs` existente; `AllStations` no trae customInputs). Aceptable para datos maestros; fase 2 podría usar un GetStation slim.

## Plan de validación (pendiente — en vivo)
1. Abrir el popup → "Configurar Estaciones". El panel lista estaciones y detecta si el schema tiene los campos.
2. Clic "Extender esquema" → verificar en SH que el schema de estación ahora tiene los 10 campos (sin perder Capacidad/DivisaManoObra/NombreAnterior).
3. Modo **estación**: elegir una, capturar params, Guardar → `GetStation` confirma `customInputs` con los nuevos valores + los previos intactos.
4. Modo **línea**: elegir una línea, confirmar conteo, Guardar → todas sus estaciones quedan con los params (previos preservados).
5. Re-abrir y elegir la misma estación → el form **prellena** con lo guardado.

## F2c — Lectura y preview de geometría (2026-06-25)

**Estado:** implementado y deployado. Escritura deshabilitada (`F2C_WRITE_ENABLED = false`).

### Qué hace F2c
- **Lectura:** cuando se abre el modal de Rack Types, `resolveGeometryState()` lee del nodo `GetPartNumber` el `geometryTypeByGeometryTypeId.geometryTypeId` y las `partNumberDimensionsByPartNumberId.nodes`.
- **Clasificación:** `classifyGeometryState(geometryTypeId, 831)` → `'SIN_GEOMETRIA'` / `'GENERICA'` / `'OTRA'`.
- **Preview:** muestra dims actuales del PN en cm + área calculada en DMK/CMK/FTK.
- **Aviso:** si las dims capturadas difieren >1% de las registradas, badge naranja (en F2d con dims editables).
- **Botón deshabilitado:** "🔒 Registrar geometría" — tooltip "Pendiente de validación en vivo".

### GAP de escritura segura — por qué F2C_WRITE_ENABLED = false

**El problema con `SavePartNumber` completo:**
`SavePartNumber` es un REPLACE total: si no reconstruyes absolutamente todos los campos del PN
(specs, labels, precios, acabados, grupos, procesos, opt-in/outs, etc.), los datos faltantes
se borran. `bulk-upload-build.js` tiene la maquinaria para esta reconstrucción, pero requiere
leer TODO el PN primero (GetPartNumber completo) y reconstruir cada sub-objeto fielmente. Un
error de reconstrucción borra datos en producción sin rollback.

**Opciones para escritura segura:**

1. **Opción A — Mutaciones quirúrgicas de unit conversion (PREFERIDA):**
   - `CreateInventoryItemUnitConversion` / `UpdateInventoryItemUnitConversion` están en config
     (hashes `769411466c...` / `ffc8db6cd8...`). Solo tocan la conversión de una unidad específica
     del InventoryItem del PN, sin tocar el PN en sí.
   - **Lo que falta para activar:** capturar el shape completo de las variables con el hash-scanner:
     - Abrir un PN en SH → ir a Inventory Item → editar una conversión de unidad (DMK, CMK, FTK)
     - El hash-scanner capturará el `operationName` y el shape de `{inventoryItemId, unitId, factor}`.
   - Para dims: `SaveGeometryType` (hash `45b7a864...`) requiere el shape de
     `{geometryTypeId, name, geometryTypeDimensions:[{geometryTypeDimensionTypeId, unitId, dimensionValue}]}`.
     También falta capturar si se pasa `geometryTypeId=831` o se asigna el type al PN via otro campo.

2. **Opción B — SavePartNumber RMW completo con bulk-upload-build.js:**
   - Leer TODO el PN con GetPartNumber → reconstruir con `decideDims`, `decideLabelIds`, etc.
   - Reutiliza maquinaria existente y probada, pero es costoso (muchos campos) y expone el riesgo
     de que un campo nuevo en SH no esté cubierto por el builder.

3. **Opción C — UpdatePartNumber parcial (SOLO customInputs — ya usada en F2b):**
   - Solo escribe `customInputs`. NO puede escribir dims ni conversiones de área.
   - Irrelevante para registrar geometría.

**Procedimiento para activar F2C_WRITE_ENABLED:**
1. Con el hash-scanner activo, abrir un PN de prueba en SH → ir a su Inventory Item → editar
   (o crear) las conversiones DMK, CMK, FTK → capturar variables de `CreateInventoryItemUnitConversion`
   y `UpdateInventoryItemUnitConversion`.
2. Confirmar que el shape es `{inventoryItemId, unitId, factor}` (o similar).
3. Implementar `persistGeometryToPN()` en `load-calculator-modal.js` usando las mutaciones quirúrgicas:
   - Si el PN ya tiene la conversión DMK → `UpdateInventoryItemUnitConversion`.
   - Si no → `CreateInventoryItemUnitConversion`.
   - Ídem CMK y FTK.
   - Para dims: `SaveGeometryType` con el geometry type genérico 831 + dims en metros.
4. Probar en UN PN de prueba y verificar en SH que las conversiones y dims quedaron correctas.
5. Cambiar `const F2C_WRITE_ENABLED = false;` → `true` en `load-calculator-modal.js` y deployar.

**Funciones puras ya implementadas (listas para usar en F2d/F2e):**
- `classifyGeometryState`, `dimsFromPartNumber`, `areaFromDims`, `buildAreaConversions`, `dimsAreDifferent`
  (en `load-calculator-engine.js`, 19 tests verdes).

## Pendientes
- **Deploy + validación en vivo** (Fase 1 + F2a/F2b/F2c).
- **F2d:** Activar escritura de geometría tras capturar shapes de unit conversion con hash-scanner.
- **Geometry Type genérico (id 831):** flujo de "registrar dims en Geometría Genérica" avisando, detectar geometría existente, check para no sobre-escribir (reutilizar `bulk-upload-build.js`).
- Confirmar fórmulas con el `Calculo.xlsx` real (no está en disco; el motor reproduce los 3 golden conocidos).
