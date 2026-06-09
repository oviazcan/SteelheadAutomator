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

- **CSV canónico + parser header-driven.** `ExportarCSV` (VBA) emite un CSV **ya expandido**;
  el parser lo lee **mapeando por NOMBRE de encabezado** (tolerante a columnas: agregar/
  reordenar/crecer columnas no rompe el parseo).
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

## Macro de exportación

`tools/ExportarCSV_v12.bas` — módulo VBA que emite el CSV canónico desde la hoja `Upload`.
Header-driven del lado Upload (lee fila 7), transforma solo `Estatus`/`Forzar duplicado`/
`Productos`, desambigua encabezados duplicados (racks), salida UTF-8 sin BOM. Departamento/
SAT/UnidadMedidaSAT NO salen (los pone el parser). Importar en el editor VBA y ejecutar
`ExportarCSV_v12`.

## Pendientes (usuario)

- Encoding de specs Temperatura/Tiempo/Duración.
- Confirmar lista del combo `Estatus` (4 opciones) y si "Planta Schneider" pierde el prefijo "Etiqueta".
- **CSV de muestra** exportado por `ExportarCSV` v12 (para construir y probar el parser contra datos reales).
