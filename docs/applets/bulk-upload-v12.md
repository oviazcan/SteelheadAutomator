# Bulk-Upload — Plantilla Carga Masiva v12 (diseño y contrato)

**Fecha:** 2026-06-09 · **Estado:** EN COORDINACIÓN (borrador vivo)
**Relacionado:** [`bulk-upload.md`](bulk-upload.md) (bitácora principal del applet)

Documento de contrato entre la **plantilla `.xlsm`** (que arma el usuario) y el **parser**
de la extensión. Mientras `ExportarCSV` emita el CSV canónico aquí descrito, ajustar la
plantilla NO requiere tocar la extensión.

## Objetivo

- Rediseño de la plantilla de carga masiva a **v12**, en **dos versiones de Excel: 2019 y 2021+**.
- **Meta arquitectónica del usuario:** *ajustar la plantilla sin tocar la extensión*
  (idealmente sin deploy; como mínimo sin re-publicar el `.zip`).

## Arquitectura (DECIDIDA)

- **CSV canónico + parser posicional por versión.** `ExportarCSV` (VBA) emite un CSV **ya
  expandido**. El parser detecta el schema por el header (`V10/V11/V12_COLS`) y luego mapea
  la zona de datos **por POSICIÓN** (no header-driven; ver corrección en el cierre 2026-06-11/12).
  Cambiar el nº de specs u otras columnas SÍ requiere un nuevo `Vxx_COLS` + detección.
- Toda la lógica de UX / combos / catálogos vive en el `.xlsm` (hoja `Upload` + macros +
  hojas `CAT_*`). **El parser NO replica lógica de Excel.**
- Lo único que toca remoto (siempre **sin re-zip**): esquema header-driven (una vez),
  defaults de facturación (`config.json`), validación de colisión de specs, los dos botones
  de descarga y los `templateUrl`.

## Botón de descarga (HECHO — config 1.6.51, deployado)

- Restaurada la acción `download-template` en el **menú de la extensión**; quitado el botón
  redundante del **modal** de corrida. Corrige `a98af15` (había quedado al revés).
- 100% remoto (config + script), **sin re-zip**.
- **Pendiente:** 2 botones (2019 / 2021+) con 2 `templateUrl` versionados (URL con número),
  cuando existan los archivos publicados en gh-pages.

## Contrato del CSV canónico

Hoja `Upload` = **60 columnas visibles** (sin helpers ocultos). `ExportarCSV` **expande los
combos** y emite el CSV canónico. El parser localiza cada campo por encabezado normalizado
(strip `\n`, colapsa espacios).

| Bloque | Visible en hoja | Canónico en CSV (lo que el parser espera) | Quién expande |
|---|---|---|---|
| Params | `Estatus` (combo 4 opc.) + `Forzar duplicado` (combo 3 opc.) | `Archivado`, `Validación`, `Forzar`, `Archivar anterior` (4 bools) | **VBA ExportarCSV** |
| Identificación / Precio | igual | igual | — |
| Etiquetas | `Etiqueta 1..4` + `Etiqueta Planta Schneider` (fórmula) | 5 etiquetas | hoja (fórmula) |
| Proceso | igual | igual | — |
| Productos | `Productos` (1 combo) | `Producto 1..3` + `Precio/Cant/Unidad` (3 grupos) vía `CAT_Productos` | **VBA ExportarCSV** |
| Specs | `Spec 1..4` + `Esp. Spec N (µm)` | 4 slots `[Nombre, Valor]` | hoja (fórmula) |
| Conversiones / Racks / Geometría / Dims / Predictivos / Referencia | igual | igual | — |
| Departamento / Código SAT | **eliminados** | NO van como columna (ver Defaults) | — |

### Mapeo de combos (semántica fija)

- **Estatus** → `{Activo con validación, Activo sin validación, Archivado con validación,
  Archivado sin validación}` → `(Archivado bool, Validación bool)`.
- **Forzar duplicado** → `{Sin forzar duplicado, Forzar duplicado, Forzar duplicado y
  archivar anterior}` → `(Forzar bool, Archivar anterior bool)`.

## Defaults de facturación (NUEVO — parser + config)

Aunque no haya columna, el parser aplica defaults **por PN, solo si el PN NO tiene ya valor**
(no sobrescribe lo existente en Steelhead):

- `Departamento` = **"Producción"**.
- `Código SAT` = **"73181106 - Servicios de enchapado"**.
- `customInputs.DatosFacturacion.UnidadMedidaSAT` = opción **"Unidad del Precio Default"**.

Valores en `config.json` (p.ej. `bulkUpload.billingDefaults`) → ajustables **sin re-zip**.
Requiere resolver el schema del customInput (field id + option id por nombre).

## Validación de colisión de specs (NUEVO — parser preflight)

- Dos specs en el mismo PN **no pueden compartir el mismo campo de especificación**
  (ej. dos "Espesor"); Steelhead solo deja activar el parámetro de una.
- Comportamiento: **bloquear el PN y reportarlo** en el preflight, indicando el campo culpable.
- Fuente del "campo": metadata de la spec (catálogo / customInputs vía API).
- Mitigación de diseño: nombrar campos distintos (ej. `Espesor` (Estaño) vs
  `Espesor intermedio` (Cobre)).

## Specs Temperatura / Tiempo (#3) — PENDIENTE diseño

El bloque de specs **asume parámetro = Espesor en µm** (col `Esp. Spec N (µm)` + fórmula que
parsea `Nombre | rango µm/mils`). Specs cuyo parámetro sea **Temperatura / Tiempo / Duración**
no encajan en ese encoding ni en el header "(µm)". **Generalizar** el encoding del valor o
diferenciar por tipo de spec.

## 2019 vs 2021+

- **Mismo contrato CSV** (idéntico byte a byte desde ambas versiones).
- Difiere solo la **implementación de fórmulas**: `CAT_Specs` usa `FILTER / LET / TEXTJOIN`
  (solo 365/2021+) para filtrar specs por acabado → la versión 2019 necesita equivalentes
  sin spill (INDEX/MATCH + columnas auxiliares). La `IFS` de Planta Schneider **sí** corre en 2019.

## División de trabajo

- **Usuario (`.xlsm`):** hoja `Upload`, macros `ExportarCSV` (incl. expansión de Productos por
  CAT_Productos y de los 2 combos de params) y `RefrescarListas`, hojas `CAT_*`, fórmulas, y
  las 2 versiones (2019 / 2021+).
- **Claude (remoto, sin re-zip):** parser v12 header-driven, defaults de facturación
  (config + backfill no-overwrite), validación de colisión de specs, 2 botones de descarga,
  bump de `templateUrl`.

## Hallazgos de validación (#7)

- ✅ Cambios #1, #2, #4, #5 ya implementados en la hoja `Upload`.
- ⚠️ **Planta Schneider:** header dice "Etiqueta Planta Schneider" (¿quitar "Etiqueta"?);
  devuelve **código corto** (SQ2/SXC/SRG/STX/SMY/SQ1/SCM) — confirmar que Steelhead espera el
  código y no el nombre largo; edge case "Querétaro 2" caería en SQ1 en vez de SQ2.
- ⚠️ **Specs Temp/Tiempo:** ver sección dedicada.
- ⚠️ **Productos:** expansión vive en `CAT_Productos`, materializada en VBA al exportar.
- ℹ️ Ahora hay **2 empresas emisoras** (ECOPLATING, PROQUIPA).

## Macro de exportación (`ExportarCSV` v15)

`vbas/Module1.txt` — versión definitiva v12 del `ExportarCSV` del usuario (reescrito, no parche).
Conserva sus validaciones (modo, PN↔Cliente, cliente único, aviso >2000) y el orden
determinista por (Cliente, PN) para el runKey (ahora quicksort en memoria, sin libro temporal).
Corrige posiciones a v12 (PN col 5, Cliente col 4) y metadata **label-driven** (robusto a
posiciones). Cambia el `SaveAs` crudo por **build canónico**: transforma solo `Estatus`/
`Forzar duplicado`/`Productos` (resto 1:1), desambigua headers duplicados (racks), lee `.Value`
raw (sin el truco "General" de v14), emite metadata como bloque limpio + header canónico + filas,
y guarda UTF-8 sin BOM. Departamento/SAT/UnidadMedidaSAT NO salen (los pone el parser).

### Estructura del CSV emitido
1. Fila modo pelado (`COTIZACIÓN+NP` / `SOLO_PN`).
2. Bloque metadata `Label,Valor` (Empresa Emisora, Nombre Cotización/Layout, Notas Ext/Int,
   Asignado, Válida Hasta) — labels ASCII (el parser normaliza acentos).
3. Fila de encabezados canónicos.
4. Filas de datos canónicas.

## Pendientes (usuario)

- Confirmar lista del combo `Estatus` (4 opciones) y si "Planta Schneider" pierde el prefijo "Etiqueta".
- ✅ ~~Subir la plantilla `.xlsm` v12 (moderna, Excel 2021+)~~ — HECHO (config 1.6.62, botón "Descargar Plantilla v12 (Excel 2021+)", `templateUrl` → v12).
- **PENDIENTE — `Module5` v17 en la plantilla MODERNA.** La moderna publicada (`templates/Plantilla_CargaMasiva_v12.xlsm`, 1.6.62) lleva `Module5` **v16** (solo restaura Proceso). Hay que actualizarla a **v17** (restaura TODAS las columnas calculadas) y **re-subir el `.xlsm` a `gh-pages`** (sin cambiar el botón ni la URL; solo reemplazar el archivo + bump config). El v17 ya está en `vbas/Module5.txt` y validado en la de compatibilidad. ⚠️ El VBA del `.xlsm` solo se edita en Excel (openpyxl rompe data validations) — lo aplica el usuario y me pasa el archivo.
- **PENDIENTE (BUG) — 5ta etiqueta no debe contar para el Proceso.** El string de etiquetas que resuelve el Proceso se arma con 5 columnas (P:T) pero **T = "Etiqueta Planta Schneider"** es de planta, no de acabado; el catálogo de procesos no la tiene (0/1580) → toda fila con Schneider da "Combinación no existente". Fix: usar P:S (4 etiquetas) en 3 fórmulas — `Upload!U` (`P9:T9`→`P9:S9`), `CAT_Procesos!L2` y `CAT_Specs!E2` (quitar el 5º bloque del TEXTJOIN/$T). **Afecta AMBAS plantillas** (moderna y compatibilidad, las 2 ya publicadas con el bug). Doc con fórmulas corregidas en `~/Downloads/Fix_5ta_etiqueta_Schneider.md`. Lo aplica el usuario en Excel; luego re-subo ambas.
- **PENDIENTE — Subir la "Versión de compatibilidad (Excel 2019)".** `Plantilla_CargaMasiva_v12_compatibilidad.xlsm` ya validado (2026-06-12): 0 funciones modernas, VBAs Module1 v15 / Module2 v12 / Module4 v13 / Module5 v17, Proceso col U con SUMAPRODUCTO+TEXTJOIN (sin FILTER/LET). Falta subirlo a `gh-pages/templates/` + agregar 2º botón "Versión de compatibilidad (Excel 2019)" (100% config, URL literal). Conversión 2019 hecha por Ernesto; doc de portado en `~/Downloads/Portado_v12_Excel2019_ESPANOL.md`.

## Cierre de sesión 2026-06-11/12 — parser v12 + billing + specs combos (DEPLOYADO 1.6.60)

**Corrección importante al diseño:** la zona de DATOS del parser NO es header-driven, es
**posicional** (`V12_COLS`). El header solo se usa para DETECTAR el schema. (El header-driven
real solo aplica a la metadata superior vía `HEADER_KEYS`.)

- **`V12_COLS`** (`bulk-upload.js`): el CSV canónico de `ExportarCSV v15` coincide con v11
  hasta las specs, pero v12 trae **4 specs (vs 2)** → corre **+4** todo lo posterior
  (KGM/racks/dims/predictivos/CargasHora). Mapa de 73 cols. Detección de schema:
  `E='Cliente'`→v10 · `E='Id SH'` + **≥3 headers `Spec N`**→v12 · else v11. `parseRows` ya
  itera `COLS.specs`/`prods` → sin cambios en el loop. Golden test: 34 asserts.
- **Billing defaults** (Producción id 182 / SAT `73181106 - Servicios de enchapado`):
  v12 ya no exporta Departamento/SAT → se inyectan aguas abajo con regla *"default si
  vacío; si ya tiene, respeta"* (altas y edición). `resolveDimSelections` (parse.js)
  recompone Línea+Depto por eje (REPLACE-safe) y **arregla bug latente**: fila v12 con
  Línea (sin Depto en CSV) borraba el depto existente. SAT en `mergeCustomInputs`.
  `applyDeptoDefault/applyDefault=false` en existentes sin snapshot (prefetch falló).
  Config: `steelhead.domain.billingDefaults`. 11 tests.
- **Specs combos Temp/Tiempo** (`catalog-fetcher`): generaliza a cualquier `EXTERNAL` spec
  con fields espesor/temp/tiempo (no hardcode; el catálogo puede crecer). Producto
  cartesiano `Nombre | espesor | temp | tiempo` (orden canónico), tope `COMBO_CAP=500`.
  Deshidrogenado (`48053-001-01`): Temperatura `177-205 °C` × Duración Horneado (TIMER)
  `>=3/2/1 hrs.` = 3 entries. Detección por nombre + type TIMER. Funciones puras
  `_comboFieldRank`/`_buildSpecComboEntries`.
- **Match-por-valor en uploader** (`pickSpecParamId` en parse.js): cada spec field elige su
  param matcheando POR VALOR contra los segmentos del CSV (split ` | `), sin asumir orden ni
  identificar el field. **Arregla bug**: field con >1 param no-espesor caía a `params[0]`
  (ignoraba la Duración elegida). Compat espesor v10/v11 intacta.
- **Migración CargasHora**: 100% (13,008 PNs; 9 transitorios 502/timeout reintentados y
  verificados, todos string + schema 3955).
- **VBA** `Module5` v16: Cantidad=1 constante, Cliente=`(seleccione)`, Grupo=`(seleccione o escriba)`.

Tests: `bulk-upload-v12-parse`, `bulk-upload-dims`, `catalog-fetcher-specs`,
`bulk-upload-specs-param` (todos verdes).
