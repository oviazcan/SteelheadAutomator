# Operación: desarchivado masivo + validación de ingeniería (TLC, 2026-07-01)

## Objetivo
Desarchivar en bloque los números de parte archivados del dominio **TLC** (domain id 344),
**excepto** los que no se requieren nunca, y marcarles el **check de validación de ingeniería**.
La protección de "no desarchivar" se materializa con la etiqueta **`Borrado definitivo`** (labelId **15646**).

## Estrategia (motivación del rediseño)
La idea original era **archivar** lo que no se usa. Problema: cuando Producción **produce un NP
archivado**, Steelhead **duplica** el NP (crea copia). Por eso se pivotó a:
- **NO archivar** por defecto → solo **marcar validación de ingeniería** (opt-in) y desarchivar.
- **Archivar (dejar con `Borrado definitivo`)** SOLO lo que de plano no se requiere nunca (basura + duplicados genuinos).

## Resultado
| | |
|---|---|
| Archivados al inicio | ~2,790 |
| **Protegidos `Borrado definitivo` (quedaron archivados)** | **674** (75 previos + 599 esta sesión) |
| **Desarchivados + validación de ingeniería** | **2,119** |
| Errores de desarchivado | 0 · Errores de validación | 1 (3022005, reintentado OK) |
| Archivados sin proteger al cierre | **0** |

## Criterios de "Borrado definitivo" (los que quedaron archivados)
Aplicados y **validados con el usuario** uno a uno:
1. **Basura por nombre**: cliente `Steelhead Manufacturing` (demos: FPN123, New Part, NP999…), nombres con `test`/`assembly`, `prueba/demo`, `NO USAR`, teclazos (`ABC-123`, `ZX-9`, `Hola`, `¿Cómo`, `FAKE PART OMAR`), nombres vacíos / de 1 carácter.
2. **`RG-` (vale de cliente embebido)** en el nombre (ej. `48182-806-01 RG-M314787`) — 144.
3. **Flexset-Silver** (Sanmina) — 14.
4. **Creador = Francis Elizabeth Hernández Reyes** (userId 12936, alta de PNs de Monterrey) — 11.
5. **Deduplicación genuina** (350) — ver abajo.

### Descartados (falsos criterios, verificados y NO aplicados)
- `cargo` / `tiempo extra` / `retrabajo` / `rework`: **no existen** como PN en TLC (el `cargo` que aparece es el verbo "se cargó" en notas). `vale` = subcadena de "tri**vale**nte".
- **Location = Monterrey**: `partNumberLocations` (Manage Locations) está **vacío** en los 46 archivados de Monterrey/Sanmina; la planta física `PlantaMonterrey.*` se archivó (feb-2026) sin PNs ligados. No sirvió como criterio.
- **Etiquetas archivadas** organizacionales (Monterrey, MTY *, Rojo Gómez, Min Lot Charge, Example): **desasignadas** de los PNs (0–1 candidatos).

## Deduplicación (criterio central) — regla CANÓNICA del bulk-upload
Clave de duplicado = `buildCompositeKey` de `remote/scripts/bulk-upload-classify.js`:
```
customerId || NOMBRE(upper) || metalBase(canónico) || acabados(canónico)
```
- **no-acabado** (ignoradas en la clave): `SMY, STX, SXC, SRG, SCM, SQ1, SQ2, NP desconocido, En desarrollo, Muestras, Lote, Obsoleto` (`config.steelhead.domain.bulkUpload.nonFinishLabelNames`).
- **equivalencias**: `[Estaño, Estaño s/Aluminio, Estaño s/Cobre]`, `[Plata, Plata Flash]` (`…bulkUpload.metalEquivalents`).
- **Con activo**: si la clave tiene un PN activo → los archivados de esa clave se marcan (el activo es el bueno).
- **Entre archivados** (sin activo): se **conserva el más enriquecido** (prioridad **spec > proceso default > #etiquetas**, desempate por id desc = más reciente) y se marcan los demás.

### Corrección importante (lección)
El primer intento de dedup agrupó por **QuoteIBMS + nombre SIN verificar acabado/metal** → infló **302 falsos positivos**
(mismo NP+cliente pero **acabado distinto** = PN legítimamente distinto; ej. `80255-105-01` Cobre existe en
`Decapado|Plata Flash`, `Antitarnish`, `Decapado|Estaño Brillante`… cada acabado es un PN válido). Se **revirtieron los 302**
(des-etiquetado, preservando todo el PN) y se re-aplicó la regla canónica. **Un QuoteIBMS puede tener varios items;
"mismo quote" ≠ "mismo NP".** La verificación del usuario (metal base + acabado idéntico) fue la que atrapó el error.

## API / mutaciones usadas (dominio TLC, vía persisted queries)
| Operación | Hash | Uso |
|---|---|---|
| `AllPartNumbers` | `827be6…cfe09` | Scan; **`includeArchived:'EXCLUSIVELY'`** = solo archivados (1 pasada). `NO`=activos, `YES`=ambos. |
| `GetPartNumber` | `804dd8…7eec` | Leer PN completo para reconstruir input. |
| `SavePartNumber` | `27adc1…365f40` | **REPLACE** — usado para agregar/quitar la etiqueta reconstruyendo el input completo (preserva labels+15646, defaults, optInOuts, customInputs, FKs). No existe mutación granular de etiquetado de PN; la UI misma usa SavePartNumber. |
| `UpdatePartNumber` | `af584f…bbf2c7` | Desarchivar: `{id, archivedAt:null}`. |
| `CreateProcessNodePartNumberOptInout` | `f6fe26…6124f` | **Validación de ingeniería** (granular, NO destructivo): `{partNumberId, processNodeId, processNodeOccurrence:1, cancelOthers:false}` por cada node de `config.steelhead.domain.validacionProcessNodeIds` = **[231176, 231174]**. |

**`AllLabels`** (`4323ad…ef94e`, vars `{forPartNumber:true}`) → `Borrado definitivo` = labelId **15646**.

## Cómo se ejecutó
- Auth: `steelhead_auth.py` del proyecto **Reportes SH** (idp-token en `/graphql`).
- Análisis: cruces con el snapshot **DuckDB** de Reportes SH (catálogo, custom_input `$.DatosAdicionalesNP.BaseMetal`/`QuoteIBMS`, `part_number_label`+`label`, `part_number_price`+`unit`, `part_number_spec`).
- Etiquetado/desarchivado: scripts **one-shot en el scratchpad de la sesión** (NO versionados; contienen datos de producción). Idempotentes, con retry y concurrencia 3.
- Herramienta de consola equivalente versionada: **`tools/unarchive-by-label.js`** (desarchiva por ausencia de `Borrado definitivo` + marca validación; dry-run + botón rojo).

## Pendientes derivados
- **Rediseñar el archivador/desarchivador** (task en `docs/applets/archiver.md`): priorizar marcar **validación de ingeniería** sobre archivar; permitir **filtros por cliente, proceso, línea, etc.**; migrar `enableValidation` a la mutación granular `CreateProcessNodePartNumberOptInout` (el `SavePartNumber`+`optInOuts:[]` actual es REPLACE y borra datos).
