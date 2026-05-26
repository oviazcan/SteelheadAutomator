# `spec-migrator` (bundle "Ajuste Masivo de Specs")

Bundle del menú **Ajuste Masivo de Specs** (icono 🔀, categoría "Números de Parte"). Concentra acciones que **ajustan o validan** specs ya aplicadas a PNs — distinto del bundle `spec-params-bulk` (Calidad), que **edita parámetros** vía XLSX.

Scripts: `steelhead-api.js` + `spec-migrator.js`. Sin VERSION constant exportado; las versiones se trackean por acción en este doc.

## Acciones

| Acción | Función | Origen |
|---|---|---|
| `run-spec-migrator` (Migrar Specs) | `SpecMigrator.run` | original 2024 |
| `assign-pending-params` (Asignar Params Pendientes) | `SpecMigrator.assignPendingParams` | original 2024 |
| `resolve-conflicts` (Resolver Conflictos) | `SpecMigrator.resolveConflicts` | original 2024 |
| `validate-duplicate-params` (Validar params duplicados) | `SpecMigrator.runDuplicateParamsValidator` | **0.4.0 — 2026-05-25, bump config 1.4.35** |

---

# `validate-duplicate-params` 0.4.0 (2026-05-25, bump config 1.4.35)

Detecta y limpia PNs con >1 param activo para el mismo `(partNumberSpecId, specFieldId)` — el caso "espesor con 3 parámetros, uno con processNode default y dos sin" que aparece después de cargas masivas mal dedupeadas.

**Ubicación correcta** (corrección del usuario): vive en el bundle `spec-migrator` (Ajuste Masivo de Specs), NO en `spec-params-bulk` (Carga masiva Spec Params). La regla: ajuste + validación van en spec-migrator; edición de parámetros en spec-params-bulk.

**Flujo:**
1. **Filtros opcionales** — `cliente` (substring uppercase, contra `customerByCustomerId.name`) y/o `spec` (substring lowercase, contra `specBySpecId.name`). Vacío = todos los PNs activos.
2. **Fase 1: `AllPartNumbers` paginado** (`first:500`, `NAME_ASC`) con `dupWithRetry`. Filtra archivedAt y aplica filtro cliente al vuelo.
3. **Fase 2: `dupRunPool(allPNs, GetPartNumber, 6)`** con `usagesLimit:0`. Por cada PN:
   - Construye `psMap: partNumberSpecId → {specId, specName, specIdInDomain}` solo con specs activas.
   - Si hay `specFilter` y ninguna spec activa matchea, descarta el PN.
   - Agrupa `partNumberSpecFieldParamsByPartNumberId.nodes` activos por `(partNumberSpecId, specFieldId)`.
   - Flagea grupos con `length >= 2`. Resuelve `fieldName` cruzando `pnSpecs[].specBySpecId.specFieldSpecsBySpecId.nodes`.
   - Default winner = mayor `id` (más reciente). Persiste en `dupState.decisions` como `Map<groupKey, {winnerRowId, ignored}>`.
4. **Tabla interactiva** (DOM API + `textContent`, cero `innerHTML` para datos) con stats bar: PNs revisados, PNs con duplicados, grupos, params a archivar.
   - Por grupo: PN | Cliente | Spec | SpecField | Radios (1 por param, preselecciona winner, muestra `row#…·sfp#…·pn#…·más reciente`) | Checkbox **Ignorar**.
   - Cambiar radio re-pinta loser/winner colors; toggle ignorar grisea fila y la excluye del contador del footer.
5. **Aplicar fix** — `confirm()` defensivo, luego `dupRunPool(tasks, UpdatePartNumberSpecParam{archivedAt:nowISO}, 3)` con `dupWithRetry`. Bitácora XLSX descargable (hojas **Detectados** con decisión por fila, **Aplicadas**, **Errores**). También se puede descargar el snapshot pre-aplicación desde la tabla.

**Decisiones del usuario (cerradas antes de implementar):**
- Universo de escaneo: todos los PN activos + filtro cliente + filtro spec, ambos opcionales y combinables.
- Default winner: mayor `id` (más reciente).
- Modo fix: archivar (reversible) vía `UpdatePartNumberSpecParam{id, archivedAt: ISO}` — el mismo mecanismo que `archiveParam(paramId)` en `spec-migrator.js:130`, reversible con `archivedAt: null`.

**Wiring:**
- `remote/scripts/spec-migrator.js` — bloque al final del IIFE (helpers `dup*` con CSS namespace `sa-specm-dup-*`, tema púrpura `#8b5cf6`). Helpers renombrados con prefijo `dup` para no colisionar con identificadores existentes del módulo.
- `remote/config.json` (línea ~495) — 4ª acción del bundle con label "🧹 Validar params duplicados".
- `extension/background.js` — case dedicado `validate-duplicate-params` que inyecta XLSX library + bundle de spec-migrator y llama `SpecMigrator.runDuplicateParamsValidator()`.

**Cancelación:**
- Estado local `dupState.runId` (no usa la infraestructura `bailIfStale` del bulk-upload — spec-migrator no la tiene). Cada función async guarda `myRunId = dupState.runId` al entrar; vuelve a comparar antes de re-pintar UI o aplicar mutaciones. Cerrar el panel hace `dupState.runId++` y aborta in-flight.

**Lecciones:**
- **No reusar el dedup del propio migrator** — `spec-migrator.js` (la sección original de conflicts) colapsa con `new Set(activeParams.map(p => p.specFieldParamBySpecFieldParamId.id))`, lo que silenciosamente esconde duplicados que difieren por `processNodeId`. Este validador usa el shape correcto: `(partNumberSpecId, specFieldId)` como key, sin colapsar por sfpId — así un grupo de 3 espesores con processNode null/default/A se ve como 3 rows, no 1.
- **`UpdatePartNumberSpecParam` es la mutation más simple para archivar un row individual** — el migrator ya usa este patrón en `archiveParam(paramId)`. Confirma que `archivedAt: ISOString` archiva, `archivedAt: null` revierte. Reversible operativamente.
- **DOM API en lugar de `innerHTML` para tabla con datos del usuario.** Los nombres de PN/cliente/spec pueden venir con caracteres especiales. La tabla se arma con `createElement` + `textContent`. Coherente con el pendiente XSS del audit (#2 medio): esta action lo hace bien desde el inicio.
- **XLSX library debe inyectarse explícitamente** — el bundle de spec-migrator no la cargaba (las 3 acciones originales no la necesitan). El case nuevo de background.js la inyecta antes del bundle para tener `window.XLSX` disponible al descargar la bitácora.

**Plan de validación pendiente:**
- [ ] Correr scan con filtro `cliente=BRP` y verificar que aparecen los grupos conocidos (espesor x3).
- [ ] Aplicar fix sobre un grupo controlado (PN de prueba), confirmar que el row queda archivado en Steelhead UI.
- [ ] Re-correr scan y confirmar que el grupo ya no aparece.
- [ ] Revertir manualmente con `UpdatePartNumberSpecParam{id, archivedAt:null}` para confirmar reversibilidad.
