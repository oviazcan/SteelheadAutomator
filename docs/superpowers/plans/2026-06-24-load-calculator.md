# Plan — Applet `load-calculator` (Calculadora de Piezas por Carga / Cargas por Hora)

> **Origen:** recuperado del transcript de la sesión `a908dc41` (2026-06-23). En esa
> sesión se hizo brainstorming + 4 agentes Explore + este plan (`ExitPlanMode`), y se
> lanzó un agente de implementación en background que **se atascó en plan mode y no
> escribió ningún archivo**. Este doc materializa el plan para no volver a perderlo.
>
> **Corrección vs el plan original:** la fórmula de cuadrícula tenía `largo`/`ancho` de
> pieza intercambiados respecto a los golden values reales del `Calculo.xlsx`. La
> orientación que reproduce 87/112/112 es **lado largo de tina × lado corto de pieza =
> columnas**, **lado corto de tina × lado largo de pieza = filas** (ver §Motor). Validado
> a mano contra los 3 golden antes de codear.

## Context

Ingeniería automatiza un cálculo que hoy hacen a mano en `Calculo.xlsx`: **cuántas piezas
caben por carga** (rack colgado o barril) y, con eso, **cargas por hora** y tiempo de
entrega. Hoy el ingeniero abre el Excel, elige un método (cuadrícula o área), captura
dimensiones, calcula, y transcribe el resultado al número de parte en Steelhead
(selecciona el RackType y teclea las piezas/rack), sin rastro de auditoría.

El applet integra ese flujo dentro de Steelhead: se activa con el **modal de Rack Types**
del tablero del número de parte (o por botón de la extensión como calculadora
independiente), calcula piezas/carga con los métodos del Excel, **decide rack vs barril**
según el tipo de línea + unidad de precio, selecciona el RackType y escribe `partsPerRack`,
los campos `DatosPlanificacion.{PiezasCarga, CargasHora, TiempoEntrega}`, y una entrada en
**Control de Cambios**.

Applet hermano de `proceso-calculator` (mismo patrón: autoInject + ícono + RMW de catálogo
en un artículo de inventario). Reutiliza maquinaria de `bulk-upload` (CRUD de racks,
Control de Cambios, escritura de customInputs).

## Decisiones del usuario (cerradas)

| Tema | Decisión |
|---|---|
| Métodos de cálculo | **Cuadrícula** (cols × filas) + **Área** (área tina × factor ÷ área pieza) |
| Barril / KG | Por **superficie (DMK = dm²)**: `piezas = FLOOR(capacidad_DMK_línea / área_pieza_dm²)`. Capacidades por línea editables (en customInputs de "Estaciones"). Semilla: L12/L24/L10=400, L16=200, L15=600, L18=450 DMK. |
| Regla rack vs barril | Tipo de **CAT_Líneas** según la línea del PN: Rack→rack, Barril→barril, Célula→sin rack. **Híbrida**: PZA→rack, KG→barril. |
| Qué persiste | `partsPerRack` del RackType · `DatosPlanificacion.PiezasCarga` · `DatosPlanificacion.CargasHora` (opcional) · `DatosPlanificacion.TiempoEntrega` (opcional) · **Control de Cambios** |
| PN con racks previos (modo independiente) | **Preguntar**: agregar otro rack o sustituir el existente |
| Activación | Auto al detectar el modal de Rack Types **+** botón en el popup (calculadora independiente) |

## Motor de cálculo (módulo puro + golden tests) — `load-calculator-engine.js`

Sin DOM ni API, testeable en Node (patrón F1 de bulk-upload). Dual-export browser/Node.

**Cuadrícula** (orientación fija que reproduce los golden del `Calculo.xlsx`):
```
tankLong  = max(tankA_in, tankB_in)      // lado mayor de la tina
tankShort = min(tankA_in, tankB_in)      // lado menor de la tina
pieceLong  = max(pieceL_in, pieceW_in)   // lado mayor de la pieza
pieceShort = min(pieceL_in, pieceW_in)   // lado menor de la pieza
columnas = FLOOR(tankLong  / (pieceShort + sepCol_in))
filas    = FLOOR(tankShort / (pieceLong  + sepRow_in))
piezasPorCarga = columnas × filas
```
Conversión m→in con `/0.0254`.

**Área**:
```
areaTina_dm2  = (tankL_cm × tankW_cm) / 100
areaEfectiva  = areaTina_dm2 × factor        // factor típico 1.5
areaPieza_dm2 = areaPieza_cm2 / 100
piezasPorCarga = FLOOR(areaEfectiva / areaPieza_dm2)
```

**Barril (superficie / DMK)** — Área con la capacidad del barril como área efectiva (factor 1):
```
piezasPorCarga = FLOOR(capacidad_DMK_linea / areaPieza_dm2)
```

**Cargas/hora** (opcional, pre-llena pero editable):
```
cargasPorHora = (60 / tiempo_ciclo_min) × n_estaciones × OEE
```

**Decisión de modo**:
```
modo = tipo==='Rack'   ? 'RACK'
     : tipo==='Barril' ? 'BARRIL'
     : tipo==='Célula' ? 'NINGUNO'
     : /* Híbrida */ (unidadPrecio==='PZA' ? 'RACK' : 'BARRIL')
```

**Golden tests** (tina 1.7m×0.9m, sep 2/2 · pantalla 90×170 cm, factor 1.5):

| Pieza | dims (in) | área (cm²) | Cuadrícula | Área |
|---|---|---|---|---|
| 31104868001 | 0.25 × 8.66 | 487.805 | **87** (29×3) | **47** |
| HB_P5778 | 0.375 × 5.75 | 185.807 | **112** (28×4) | **123** |
| P6028 | 0.375 × 6.75 | 216.532 | **112** (28×4) | **105** |

(Validado a mano: 1.7m=66.929in, 0.9m=35.433in; areaTina=153 dm², areaEfectiva=229.5 dm².)

## Persistencia (reutiliza maquinaria existente)

1. **Resolver `partNumberId` interno** — del payload interceptado del modal, o `GetPartNumber`/`AllPartNumbers` por nombre (modo independiente).
2. **RackType** (`bulk-upload.js:6427-6478`):
   - `SavePartNumberRackTypes { input:{ partNumberRackTypes:[{rackTypeId, partNumberId, partsPerRack}], partNumberRackTypeIdsToDelete:[] } }`
   - Si **duplicate key** → `UpdatePartNumberPerPerRackType { partNumberId, rackTypeId, partsPerRack }` (el typo `PerPer` es real en el API).
   - `partsPerRack = Math.floor(...)` (es `Int`).
   - **Sustituir**: `GetPartNumber` → `DeletePartNumberRackType { id }` de los existentes → insertar.
3. **Campos personalizados** — RMW de `customInputs` (REPLACE total: deep-clone primero):
   - `ci.DatosPlanificacion.PiezasCarga` (number), `.CargasHora` (string opc.), `.TiempoEntrega` (number opc.)
   - `inputSchemaId` **dinámico**: `GetPartNumbersInputSchema` → nodo de id más alto (nunca hardcodear 3932).
   - Preferir `UpdatePartNumberInputs` (solo customInputs; verificar hash vigente) sobre `SavePartNumber` (RMW completo, arriesga borrar labels/specs/dims).
4. **Control de Cambios** — reusar `window.SteelheadBulkCC` (`bulk-upload-cc.js`): `buildControlCambiosEntry` + `appendControlCambios` (append no-destructivo, schema 3932). Usuario vía `CurrentUserActiveSegments`.

## Catálogo de líneas ("Estaciones") — datos maestros editables

Tipo (Rack/Barril/Híbrida/Célula), dims de tina, # estaciones, tiempo de ciclo, OEE,
factor de área y **capacidad DMK de barril**. En `customInputs` de un **artículo de
inventario dedicado** (patrón `CatProcesos` item 900192). Semilla de `CAT_Líneas` del
`.xlsm` + capacidades DMK + params de tina del `Calculo.xlsx`. Mientras se decide el item
id, la semilla puede vivir en `config.json` bajo `domain` como fallback.

Línea del PN en runtime: `dimensionId=349` (`dimensionIds.linea`). Unidad de precio:
`partNumberPricesByPartNumberId.nodes[].unitByUnitId.id` vs `PRICE_UNIT_MAP` (`KGM=3969`; `PZA→null`).

## Activación (dual)

- **Auto (modal Rack Types)**: monkey-patch de `window.fetch` (patrón `auto-router.js:34-70`)
  para interceptar el `operationName` que abre el modal → captura `partNumberId` + racks
  actuales → inyecta botón calculadora + panel. En paralelo `MutationObserver` + `ensureIcon()`
  (patrón `proceso-calculator.js:485-518`).
- **Botón popup (independiente)**: action con `fn:"LoadCalculator.openFromPopup"` (handler
  genérico `background.js:1357-1398`, no toca `extension/`). Pide el PN, lo resuelve, muestra
  racks existentes, permite **agregar o sustituir**.

## Archivos

**Nuevos** (`remote/scripts/`): `load-calculator-engine.js` (motor puro) · `load-calculator.js` (applet).
**Nuevos** (`tools/test/`): `load-calculator-engine.test.js` (golden + decisión de modo).
**Modificar**: `remote/config.json` (entry en `apps[]` + semilla catálogo de líneas) · `CLAUDE.md` (índice) · `docs/applets/load-calculator.md` (bitácora).
**Reutilizar tal cual**: `bulk-upload-cc.js`, rack CRUD de `bulk-upload.js`, `steelhead-api.js`. `host-cleanup-shared.js` no se requiere (un solo PN, no acumula).

## Prerrequisitos a capturar antes de la fase DOM/API (no bloquean el motor)

1. **DOM del modal de Rack Types** — pedir al usuario el **wrapper HTML completo** (regla de `CLAUDE.md`).
2. **`operationName` + hash que abre el modal** (Network / hash-scanner). Candidatos: `GetPartNumber` (en config) o `GetPartNumberForPartNumberPage` (hash capturado, no en config).
3. **Item de inventario para el catálogo "Estaciones"** — id existente o crear uno (como 900192).
4. **Verificar `UpdatePartNumberInputs`** (solo customInputs) vs `SavePartNumber` RMW completo.
5. **`Calculo.xlsx`** — no está en disco. Confirmaría la orientación de cuadrícula y las capacidades DMK semilla. El motor ya reproduce los 3 golden conocidos; revalidar con el Excel o más casos.

## Hallazgos de la captura DOM/API (2026-06-24)

### Modal de Rack Types — DOM real
Título `h2#form-dialog-title`: **"Create setting for number of {PN} that can fit on a rack type"**
(el nombre del PN va en el título). Contenido (`div.MuiDialogContent-root`):
- **Rack Type** (label `div.css-1eltb40`) → **react-select** (`.css-b62m3t-container`, input `react-select-NN-input`, placeholder "Select...").
- **Parts Per Rack** (label `div.css-xd9ivb`) → **MUI OutlinedInput** nativo `input.MuiOutlinedInput-input` (`type=text`, value inicial "1"). Autollenar con el native value setter + `input`/`change` events (ver `dom-patterns.md`).
- Acciones (`div.MuiDialogActions-root`): botón **Cancel** (outlined, `data-testid="CloseIcon"`) y **Save** (contained, `data-testid="SaveIcon"`).

### Query que abre el modal — `CreateEditPartsPerRackTypeQuery`
Hash `59defeb5a1b2530737b04c32ca7857a03d16ba8ba531567eb8366eadb3b5f380`, vars `{partNumberId}`. Devuelve:
- `allRackTypes.nodes[]` — TODOS los rack types del dominio: `{id, name, partsPerRackDefault, availableRacks, unitByPartCountDisplayUnitId}`. Los **barriles** traen `unitByPartCountDisplayUnitId = {id:3969, name:"KGM Kilogramo"}`; los racks lo traen `null`. Nombre codifica **línea-tipoNN** (`T205-RA01`, `T106-BA01`, `M102-FL01 FlyBar Cobre`, `T114-CA01 Canastilla`).
- `partNumberById.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes[]` — **conversiones de unidad del PN**, incluyendo **`DMK Decímetro Cuadrado` (factor `0.1341`)** = superficie de UNA pieza en dm². → **el área de la pieza ya vive en SH**; alimenta directo Área/Barril sin capturar dimensiones. (También `CMK`=13.41 cm², `KGM`, `LBR`, `FTK`.)

### Modelo de catálogo — CORRECCIÓN al plan: va en la ESTACIÓN, no en un artículo
Los parámetros de línea/tina/barril se guardan en **`customInputs` de cada estación** (no en un artículo de inventario). Hashes:
- **`GetStation {id}`** `912beb134cb89f78cf22fdfbe3fd6e59bc5160e11bdffde5d398506492831d41` → `stationById.customInputs` (valores planos) + `stationById.stationInputSchemaByInputSchemaId.inputSchema` (schema).
- **`GetStationInputSchema`** `c6ecbaae2df073010d5a667875037a132ae4eadb369fbd0798bb991a01a93dce` → `allStationInputSchemas.nodes[].inputSchema`.
- **`CreateStationInputSchema {inputSchema, uiSchema}`** `2abe86f7d8205cfd3c356e4cfeea91d857ee7820567fb82ecd9fa2688cabfa00` — extiende el schema (patrón idéntico a `CreatePartNumberInputSchema`).
- **`AllStations {orderBy, offset, first, searchQuery}`** `5bd4ae33ce18fa881fb447217b831b9492176319ffc14520333acbf014117d3b` → `pagedData.nodes[]{id,name,capacityMicroQuantity,unitByCapacityUnitId,currentOperationRate,...}`.
- **Schema de estación HOY** (insuficiente, "temp"): `NombreAnterior`, `DivisaManoObra` (enum USD/MXN), `Capacidad` (integer, litros). **Faltan** los campos del calculador (dims de tina cm, capacidad DMK barril, factor área, #estaciones, OEE, ciclo) → extender con `CreateStationInputSchema`.
- **Escribir valores de estación** (gap cerrado, scan 17:50): **`UpdateStationInputs {stationId, inputSchemaId, customInputs}`** `0237bbca4a0f168b800483bd21b6146829a11f158e033e00eef7c00ce53bb112` — RMW idéntico a `UpdatePartNumberInputs`/`UpdateInventoryItemInputs`. Ej: `{stationId:20864, inputSchemaId:79, customInputs:{Capacidad:0, DivisaManoObra:"USD", NombreAnterior:"N/A"}}`. **Modelo de estación COMPLETO end-to-end** (leer · extender schema · escribir).

### Hashes de escritura a nivel PN (ya conocidos/confirmados)
| Acción | Op | Hash |
|---|---|---|
| Asignar rack(s) a PN | `SavePartNumberRackTypes` | `087af4e8b489edc1c6ade599da96f368fc3a764f2f16093feae9c57ee81cb363` |
| Update partsPerRack (rack ya ligado) | `UpdatePartNumberPerPerRackType` | `fb6e7902d18ce00c831873c8dd32153e7bb6e2dfa44936c85a4ef67575b07de3` |
| Borrar rack de PN | `DeletePartNumberRackType` | `4cec965c46a9c30c1db64eee1b24566229b6b73f6fe69bf206253c63ac97bbd4` |
| Schema de PN (para DatosPlanificacion) | `GetPartNumbersInputSchema` / `CreatePartNumberInputSchema` | `c56b972e…` / `b1622525…` |

Scan fuente: `~/Downloads/scan_results_2026-06-24_174421.json` + `…_175007.json` (NO copiar al repo).

## Decisiones del usuario — ronda 2 (2026-06-24)

1. **Dims de pieza → Geometry Type.** Es **requisito** que la pieza tenga un Geometry Type (aunque sea genérico) para calcular. La calculadora puede **registrar los datos en la "Geometría Genérica"** avisando explícitamente ("estos datos se registrarán en Geometría Genérica"). Si el PN **ya tiene otra geometría**, mencionarla. Si los datos capturados **difieren** de los que ya trae la pieza, por **default actualizarlos**, con un **check para dejarlos como están** (desmarcable).
2. **Qué persiste:** Parts/Rack + `DatosPlanificacion.{PiezasCarga,CargasHora,TiempoEntrega}` + Control de Cambios, **y además** las **dimensiones** (si se cuenta con ellas) y el **factor de área en DMK, CMK y FTK** (las 3 conversiones de unidad del PN).
3. **Primer entregable:** **Configurador de Estaciones** (datos maestros) antes que la calculadora del modal.

### Geometría — reutilizar maquinaria de `bulk-upload` (NO reinventar)
- `config.domain.geometryGenericaId = 831` · `geometryDimensions = {LENGTH:1284, WIDTH:1011, HEIGHT:1012, OUTER_DIAM:1013, INNER_DIAM:1014}`.
- `bulk-upload-build.js:105` `resolveGeometryTypeId(existingPnNode, pn)` (lee `geometryTypeByGeometryTypeId.geometryTypeId`); `:125` construye `geometryTypeDimensions[{geometryTypeDimensionTypeId, unitId, dimensionValue}]`.
- `bulk-upload-parse.js:100` mapea length/width/height/outerDiam/innerDiam → dimensionTypeId con `unitId: MTR`.
- `catalog-fetcher.js:429` `fetchGeometryTypes()` vía `AllGeometryTypes`. Mutación: `SaveGeometryType` (`45b7a864…`, en config).
- **`unitIds` en config:** `KGM:3969, LBR:3972, FTK:4797, CMK:4907, FOT, LM, LO, MTR:3971`. **Falta `DMK:3975`** (el query del modal lo trae) → agregar al config para persistir el área en DMK.

## Diseño — Configurador de Estaciones (PRIMER entregable)

Flujo: extender el schema de estación **una vez** (no-destructivo) + UI para capturar params por estación + persistir por estación.
- **Leer** schema vigente + valores: `GetStation {id}` (o `GetStationInputSchema` para el schema, `AllStations` para la lista).
- **Extender schema** (merge no-destructivo, preservar `NombreAnterior/DivisaManoObra/Capacidad` + `ui:order`): `CreateStationInputSchema {inputSchema, uiSchema}`.
- **Escribir valores** (RMW, preservar customInputs existentes): `UpdateStationInputs {stationId, inputSchemaId, customInputs}`.

**Campos propuestos del calculador** (a CONFIRMAR con el usuario — son datos maestros, no adivinar):

| Key | Tipo | Para |
|---|---|---|
| `TipoLinea` | enum Rack/Barril/Híbrida/Célula | decisión de modo |
| `TinaLargoCm` | number | cuadrícula + área |
| `TinaAnchoCm` | number | cuadrícula + área |
| `SepColCm` / `SepFilaCm` | number | cuadrícula |
| `FactorArea` | number (def 1.5) | área |
| `CapacidadDMK` | number | barril |
| `NumEstaciones` | integer | piezas totales + cargas/hora |
| `TiempoCicloMin` | number | cargas/hora |
| `OEE` | number 0..1 | cargas/hora |

**Módulos puros testeables** (TDD, siguiente paso): `buildStationInputSchema(existing, calcFields)` (merge no-destructivo) · `buildUpdateStationInputsVars(station, schemaId, values)` (RMW de customInputs).

## Estado de implementación

- [x] Plan materializado (este doc) + hallazgos DOM/API consolidados.
- [x] Motor puro `load-calculator-engine.js` + golden tests (8/8 verdes).
- [ ] **Decisiones de alcance/UX** (fuente de dims de pieza · params de estación · qué persiste) — pendiente confirmar con el usuario.
- [ ] Applet `load-calculator.js` (capa DOM/API).
- [ ] Entry en `config.json` + bitácora + índice CLAUDE.md.
- [x] Mutación de escritura de estación capturada (`UpdateStationInputs`). Pendiente: extender schema + alta de params por estación.
- [ ] Validación en vivo.

## Verificación

1. **Unit/golden** (sin navegador): `node --test tools/test/load-calculator-engine.test.js` → cuadrícula y área dan exactamente 87/47, 112/123, 112/105; decisión de modo cubre los 5 casos.
2. **Deploy a un PN de prueba** + abrir modal de Rack Types real: ícono/botón aparece, calcula, selecciona RackType, teclea piezas/rack; al guardar verificar `partsPerRack`, `DatosPlanificacion.*` y entrada de Control de Cambios.
3. **Modo independiente**: desde popup, PN con racks → confirmar pregunta agregar vs sustituir.
4. **Barril/híbrida-KG**: PN en línea barril → usa `capacidad_DMK / área_pieza`; capacidad editada se persiste.
