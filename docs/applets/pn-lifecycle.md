# Applet: `pn-lifecycle` (Gestor de ciclo de vida de PNs)

## Qué hace
Rediseño del `archiver`. Sobre un conjunto de PNs acotado por **filtros ricos**, ejecuta una de **4 acciones** de ciclo de vida:
1. **Marcar validación de ingeniería** (default) — opt-in a `validacionProcessNodeIds` vía mutación granular `CreateProcessNodePartNumberOptInout` (idempotente: tolera duplicado).
2. **Desarchivar** — `UpdatePartNumber {archivedAt:null}`; opción "marcar validación al vuelo".
3. **Quitar validación** — `GetPartNumber` → `DeleteProcessNodePartNumberOptInOut {id}` solo por los opt-ins de validación (granular, no destructivo).
4. **Archivar = Borrado definitivo** — `GetPartNumber` → `SavePartNumber` reconstruido (+labelId 15646, REPLACE-safe preservando labels/defaults/optInOuts/customInputs/FKs) → `UpdatePartNumber {archivedAt:now}`.

**Motivación:** al producir un NP archivado, Steelhead lo duplica. Por eso se prioriza **marcar validación** (mantener activo) sobre archivar; se archiva solo lo que no se requiere nunca.

## Versión / estado
0.1.0 — implementado con subagent-driven-development (plan `docs/superpowers/plans/2026-07-01-pn-lifecycle-manager.md`, spec `docs/superpowers/specs/2026-07-01-pn-lifecycle-manager-design.md`). **21/21 tests** puros (`tools/test/pn-lifecycle.test.js`). Review final sin Critical. **Pendiente: piloto en vivo** por acción (dry-run → 1-2 PNs) antes de uso masivo — el applet tiene dry-run + confirm obligatorios, así que el deploy solo lo pone disponible.

## Arquitectura
- **`remote/scripts/pn-lifecycle-core.js`** — helpers PUROS (dual-export browser/node): `slimPN` (parse enriquecido), `applyFilters`, `discoverFacets`, `selectDuplicates` (dedup canónica reusando `bulk-upload-classify.js`), `isInTargetState`, `buildValidationVars`, `optInsToDelete`, `buildArchiveInput`, `INCLUDE_FOR_ACTION`, `fetchPNsForAction`, `runOneItem`.
- **`remote/scripts/pn-lifecycle.js`** — applet UI dark-mode de 4 pantallas (config → scan → filtros con conteo en vivo → preview/ejecutar) + orquestación (`runPool` concurrencia 3, resume, memory-hardening). Entry `window.PNLifecycle.openConfigAndRun()`.
- **`extension/background.js`** — case `run-pn-lifecycle`.

## Scan enriquecido en 1 pasada
`AllPartNumbers` (verificado 2026-07-01) trae **poblados** proceso (`processNodeByDefaultProcessNodeId`), línea/depto (`acctPnDimensionValueSelectionsByPartNumberId`, dims 349/586), metal (`customInputs.DatosAdicionalesNP.BaseMetal`), quoteIBMS, cliente, labels. `includeArchived`: `NO`=activos, `EXCLUSIVELY`=solo archivados, `YES`=ambos. Estado archivado se infiere del `includeArchived` (el nodo PN no expone `archivedAt`).

## Filtros
Intersección AND, conteo en vivo: cliente (por id) · etiquetas AND/OR · metal · proceso · línea · departamento · fecha · toggle **"solo duplicados genuinos"** (dedup canónica: `customerId||NOMBRE||metalCanónico||acabadosCanónicos`, con `bulkUpload.nonFinishLabelNames` + `metalEquivalents`; entre-archivados conserva el más enriquecido: proceso > #etiquetas > id).

## Mutaciones / config
Hashes en `steelhead.hashes.mutations`: `CreateProcessNodePartNumberOptInout` `f6fe26e4…`, `DeleteProcessNodePartNumberOptInOut` `4a077333…`, `UpdateProcessNodePartNumberOptInOut` `4556e571…`. Dominio: `validacionProcessNodeIds=[231176,231174]`, `Borrado definitivo`=labelId 15646.

## Lecciones
- **No existe mutación granular de label de PN**: el label de archivado va por `SavePartNumber` (REPLACE) reconstruyendo el input completo (patrón validado en `docs/operations/2026-07-01-desarchivado-masivo-validacion.md`). Opt-ins SÍ tienen mutaciones granulares (Create/Delete/Update).
- **Idempotencia**: `isInTargetState` pre-check SOLO para archive/unarchive (su estado está en el slim); validate/unvalidate son idempotentes por sí mismas en `runOneItem` (el slim no trae los opt-ins actuales).
- Dedup por QuoteIBMS+nombre SIN acabado infla falsos positivos (mismo NP, acabado distinto = PN distinto). La regla canónica exige cliente+nombre+metal+acabado.

## Pendientes / fase 2 (no bloqueantes)
- Piloto en vivo por acción.
- Filtro por QuoteIBMS (el slim lo trae; `applyFilters`/UI aún no lo exponen — YAGNI por ahora).
- Cobertura de tests: rutas archive/unarchive/catch de `runOneItem` (validate/unvalidate/archive-gate ya cubiertas).
