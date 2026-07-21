# Applet: `pn-lifecycle` (Gestor de ciclo de vida de PNs)

## Qué hace
Rediseño del `archiver`. Sobre un conjunto de PNs, ejecuta una de **4 acciones** de ciclo de vida.
Hay **dos orígenes** para armar el conjunto (selector en la pantalla de configuración):
- **Escanear dominio con filtros** (original) — trae TODOS los PNs (`AllPartNumbers` paginado) y se acotan con **filtros ricos**.
- **Pegar IDs de PN** (v0.2.0) — el operador pega los **Id SH (numéricos)** y va **directo al preview**, sin escanear el dominio ni filtrar. Resolución dirigida `GetPartNumber(id)` por cada Id (pool conc. 4 + drain), leyendo `archivedAt` para el estado real (sirve para pegar mezclas activo+archivado). Evita revisar todos los NP antes de poner filtros cuando ya se tiene la lista (p.ej. de un reporte/DuckDB). Renglones no numéricos e Id no resueltos se avisan en el preview y quedan en el JSON de resultado.

Las **4 acciones**:
1. **Marcar validación de ingeniería** (default) — opt-in a `validacionProcessNodeIds` vía mutación granular `CreateProcessNodePartNumberOptInout` (idempotente: tolera duplicado).
2. **Desarchivar** — `UpdatePartNumber {archivedAt:null}`; opción "marcar validación al vuelo".
3. **Quitar validación** — `GetPartNumber` → `DeleteProcessNodePartNumberOptInOut {id}` solo por los opt-ins de validación (granular, no destructivo).
4. **Archivar = Borrado definitivo** — `GetPartNumber` → `SavePartNumber` reconstruido (+labelId 15646, REPLACE-safe preservando labels/defaults/optInOuts/customInputs/FKs) → `UpdatePartNumber {archivedAt:now}`.

**Motivación:** al producir un NP archivado, Steelhead lo duplica. Por eso se prioriza **marcar validación** (mantener activo) sobre archivar; se archiva solo lo que no se requiere nunca.

## Versión / estado
0.2.0 — **modo "Pegar IDs"** (origen alterno por Id SH, salta filtros). **28/28 tests** puros (`tools/test/pn-lifecycle.test.js`). Suite repo completa verde (706/706).
0.1.0 — implementado con subagent-driven-development (plan `docs/superpowers/plans/2026-07-01-pn-lifecycle-manager.md`, spec `docs/superpowers/specs/2026-07-01-pn-lifecycle-manager-design.md`). **21/21 tests** puros. Review final sin Critical. **Pendiente: piloto en vivo** por acción (dry-run → 1-2 PNs) antes de uso masivo — el applet tiene dry-run + confirm obligatorios, así que el deploy solo lo pone disponible.

## Arquitectura
- **`remote/scripts/pn-lifecycle-core.js`** — helpers PUROS (dual-export browser/node): `slimPN` (parse enriquecido), `applyFilters`, `discoverFacets`, `selectDuplicates` (dedup canónica reusando `bulk-upload-classify.js`), `isInTargetState`, `buildValidationVars`, `optInsToDelete`, `buildArchiveInput`, `INCLUDE_FOR_ACTION`, `fetchPNsForAction`, **`parsePastedIds`** (parseo puro de la lista pegada: cualquier separador, dedup, ints positivos vs `invalid`), **`fetchPNsByIds`** (resolución dirigida `GetPartNumber(id)` en pool acotado, slim con `archived=archivedAt!=null`, devuelve `{found, notFound}`), `runOneItem`.
- **`remote/scripts/pn-lifecycle.js`** — applet UI dark-mode (config con **selector de origen** → [scan → filtros] ó [resolución de IDs] → preview/ejecutar) + orquestación (`runPool` concurrencia 3, resume, memory-hardening). En modo paste el preview muestra avisos de Id no encontrados / renglones ignorados. Entry `window.PNLifecycle.openConfigAndRun()`.
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
- **Modo "Pegar IDs" (v0.2.0):** `GetPartNumber(id)` trae el mismo shape que `AllPartNumbers` PERO expone `archivedAt` (el nodo de `AllPartNumbers` no) → en paste el `archived` del slim es el estado REAL, más preciso que el override que infiere el scan del `includeArchived`. Por eso se puede pegar una mezcla de activos y archivados y cada acción (incl. archive/unarchive con su `isInTargetState`) se comporta bien por-PN. `includeArchivedToo` no aplica en paste (el operador ya dio los IDs exactos). El resume opera sobre PNs YA resueltos, así que es agnóstico al origen (paste o scan).

## Safari / iPad (bundle v0.5.8)
Integrado al bundle Safari como **con-popup** (no tiene FAB): se lanza desde el popup
(`run-pn-lifecycle` → `PNLifecycle.openConfigAndRun`, cableado en `safari/extension/popup.js`
LAUNCHERS + `safari/sa-dispatcher.js` LAUNCH_FN). El operador de iPad usa el **modo Pegar IDs**
(ligero); el modo Escanear existe pero es pesado (tiene guardrail de memoria). **Limitación iOS:**
la descarga del JSON de resultado no opera en Safari/iPad — el resultado igual se ve en pantalla
(la descarga es marginal, el flujo core no depende de ella). Recompilar en Xcode tras el rebuild.

## Pendientes / fase 2 (no bloqueantes)
- Piloto en vivo por acción.
- Filtro por QuoteIBMS (el slim lo trae; `applyFilters`/UI aún no lo exponen — YAGNI por ahora).
- Cobertura de tests: rutas archive/unarchive/catch de `runOneItem` (validate/unvalidate/archive-gate ya cubiertas).
