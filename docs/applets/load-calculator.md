# Applet: `load-calculator` — Calculadora de Piezas por Carga

**Versión actual:** 0.1.0 (Fase 1: **Configurador de Estaciones**, datos maestros. Motor de cálculo y configurador con núcleo puro + golden tests. **Pendiente validación en vivo + deploy.**)
**Archivos:** `remote/scripts/load-calculator.js` (applet DOM) · `remote/scripts/load-calculator-engine.js` (motor puro) · `remote/scripts/load-calculator-stations.js` (núcleo puro del configurador)
**Tests:** `tools/test/load-calculator-engine.test.js` (8) · `tools/test/load-calculator-stations.test.js` (12)
**Global:** `window.LoadCalculator` (`openStationConfig`) · `window.LoadCalculatorEngine` · `window.LoadCalculatorStations`
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

### Campos del schema de estación (confirmados con el usuario)
`TipoLinea` (enum) · `TinaLargoCm` · `TinaAnchoCm` · `SepColCm` · `SepFilaCm` · `FactorArea` · `CapacidadDMK` · `NumEstaciones` · `TiempoCicloMin` · `OEE`. Capturados en cm; el motor convierte.

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

## Pendientes
- **Deploy + validación en vivo** (Fase 1).
- **Fase 2:** calculadora en el modal de Rack Types (intercept `CreateEditPartsPerRackTypeQuery`, autollenan Parts Per Rack, persistir partsPerRack + DatosPlanificacion + CC + Geometry Type con dims/DMK/CMK/FTK). DOM del modal ya capturado (ver plan).
- **Geometry Type genérico (id 831):** flujo de "registrar dims en Geometría Genérica" avisando, detectar geometría existente, check para no sobre-escribir (reutilizar `bulk-upload-build.js`).
- Confirmar fórmulas con el `Calculo.xlsx` real (no está en disco; el motor reproduce los 3 golden conocidos).
