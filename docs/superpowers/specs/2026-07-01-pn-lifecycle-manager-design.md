# Diseño: Gestor de ciclo de vida de PNs (rediseño del `archiver`)

**Fecha:** 2026-07-01 · **Applet:** `archiver` → rediseño (mismo entry point, alcance ampliado) · **Dominio:** TLC (id 344)

## Contexto y motivación
El `archiver` actual archiva/desarchiva PNs por etiquetas + fecha. La estrategia de "archivar lo no usado"
tiene un problema de negocio: **cuando Producción produce un NP archivado, Steelhead duplica el NP**. Por eso
se pivota:
- **No archivar** por defecto → **marcar validación de ingeniería** (opt-in) y mantener el PN activo.
- **Archivar + `Borrado definitivo`** SOLO lo que no se requiere nunca (basura + duplicados genuinos).

Además, en la operación del 2026-07-01 (ver `docs/operations/2026-07-01-desarchivado-masivo-validacion.md`)
se descubrieron capacidades que este rediseño incorpora: mutaciones granulares de opt-in, `includeArchived:'EXCLUSIVELY'`,
la regla de dedup canónica del bulk-upload, y que el listado `AllPartNumbers` **sí** trae proceso + dimensiones contables.

## Objetivo
Un applet que, sobre un conjunto de PNs acotado por **filtros ricos**, ejecute una de **4 acciones** de ciclo de vida,
con dry-run, idempotencia y memory-hardening.

## Arquitectura (flujo de 4 pantallas)
Reescritura de `remote/scripts/archiver.js` conservando el patrón de overlay dark-mode + `runPool` + resume.
1. **Config** — elegir **acción** (determina `includeArchived` del scan) + opciones de la acción.
2. **Scan** — 1 pasada de `AllPartNumbers` (slim enriquecido), memory-hardening (`host-cleanup-shared`), progreso.
3. **Filtros** — panel con conteo en vivo (intersección AND). Incluye toggle de dedup.
4. **Preview + Ejecutar** — tabla (cap 500 filas en DOM), confirm, `runPool` concurrencia 3, resume, verificación post-mutación, descarga de resultados.

Helpers puros testeables (node --test): construcción del slim, filtros, dedup (`buildCompositeKey`), idempotencia.

## Slim enriquecido (por PN, desde el listado — 1 pasada)
```
{ id, name, customer{id,name}, labels[{id,name}], metal, proceso, linea, departamento,
  createdAt, quoteIBMS, estado /* activo|archivado, inferido por includeArchived */ }
```
Fuentes en el node de `AllPartNumbers` (verificadas 2026-07-01):
- proceso ← `processNodeByDefaultProcessNodeId.name`
- línea/departamento ← `acctPnDimensionValueSelectionsByPartNumberId.nodes` (2/PN; mapear dimension_id→valor)
- metal ← `customInputs.DatosAdicionalesNP.BaseMetal` · quoteIBMS ← `customInputs.DatosAdicionalesNP.QuoteIBMS`
- customer ← `customerByCustomerId` · labels ← `partNumberLabelsByPartNumberId.nodes[].labelByLabelId`
- `archivedAt` NO viene a nivel PN → el estado se infiere por el `includeArchived` usado (`NO`=activo, `EXCLUSIVELY`=archivado).

## Acciones y mutaciones
| Acción | Scan (`includeArchived`) | Mutación | Costo |
|---|---|---|---|
| **Marcar validación** (default) | `NO` (activos) | `CreateProcessNodePartNumberOptInout {partNumberId, processNodeId, processNodeOccurrence:1, cancelOthers:false}` × `validacionProcessNodeIds` (idempotente: tolera error de duplicado = "ya marcado") | barato |
| **Desarchivar** | `EXCLUSIVELY` | `UpdatePartNumber {id, archivedAt:null}` + opción "marcar validación al vuelo" | barato |
| **Quitar validación** | `NO` (o los que la tengan) | `GetPartNumber` → por cada opt-in cuyo `processNodeId ∈ validacionProcessNodeIds`: `DeleteProcessNodePartNumberOptInOut {id}` (**granular, no destructivo**) | medio (1 GetPartNumber/PN) |
| **Archivar = Borrado definitivo** | `NO` (activos) por default; toggle "incluir ya archivados" (`YES`) para re-etiquetar los archivados que aún no tengan el label | `GetPartNumber` → `SavePartNumber` reconstruido (+labelId 15646, preservando labels/defaults/optInOuts/customInputs/FKs) → `UpdatePartNumber {id, archivedAt:now}` (si ya está archivado, solo el label) | caro (label sin granular) |

Idempotencia por acción: saltar si el PN ya está en el estado destino (ya validado / ya archivado con label / ya activo / ya sin validación).

## Filtros (intersección AND, conteo en vivo, todos desde el slim)
- **Cliente** (multi-select con conteos) · **Etiquetas/acabados** (AND/OR) · **Metal base** · **Proceso default** · **Línea** · **Departamento** · **Fecha** (creación; corte antes/después) · **QuoteIBMS**.
- **Toggle "solo duplicados genuinos"**: reusa `remote/scripts/bulk-upload-classify.js` (`buildCompositeKey` = `customerId||NOMBRE||metalCanónico||acabadosCanónicos`, con `config.steelhead.domain.bulkUpload.nonFinishLabelNames` + `metalEquivalents`). Preselecciona los archivados dup-de-activo + entre-archivados (conserva el más enriquecido: spec > proceso > #etiquetas). Pensado para la acción **Archivar**.

## Config (nuevos hashes a registrar en `config.json`)
```
DeleteProcessNodePartNumberOptInOut : 4a0773339315f1a52a9c08c249c5b3540c13def2b0d320e0e16ad9cb75b4d823
UpdateProcessNodePartNumberOptInOut : 4556e5710f068e129fadc74cbce1f9a5e7cc42113f4e8e1808976b4e4f4cd2a6
CreateProcessNodePartNumberOptInout : f6fe26e4494c8c91d076975a8d7e89ed2f90a487d05f8bc021c2e296f3d6124f
```
Ya en config: `AllPartNumbers`, `UpdatePartNumber`, `SavePartNumber`, `GetPartNumber` (verificar hash de GetPartNumber vivo: `804dd8f7…`), `AllLabels`. Dominio: `validacionProcessNodeIds:[231176,231174]`, `Borrado definitivo`=labelId 15646.

## Memory hardening
`startHostGuards()` (Datadog stop + `createMemMonitor` guardrail 88%), `makePeriodicDrain(50)` en el worker, `drainHostCache()` entre páginas del scan. Invocar skill `memory-hardening-applets`. Resume por acción (llave `sa_pnlifecycle_resume_v1`), coherente con el modo.

## Testing
`tools/test/pn-lifecycle.test.js` (node --test, sandbox vm): slim parse, filtros (cliente/proceso/línea/metal/fecha/etiquetas AND-OR), dedup vía `buildCompositeKey` (con equivalencias Estaño/Plata), idempotencia por acción, construcción de payloads de cada mutación (golden). Reusar `bulk-upload-classify.js` para dedup (no re-implementar).

## Deploy
`tools/deploy.sh` (o `wb-deploy.sh` desde workbench) — bump `config.json`, espejo gh-pages. Requiere registrar los 2 hashes nuevos en config (hot file → coordinar). Validación en vivo: piloto por acción sobre un filtro pequeño antes de uso masivo.

## Fuera de alcance (YAGNI)
- Filtro por grupo de parte (no pedido).
- Batch multi-dominio (solo TLC).
- Captura de mutación granular de label (no existe; se usa SavePartNumber reconstruido para el label, ya validado).
