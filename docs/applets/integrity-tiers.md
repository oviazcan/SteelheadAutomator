# `integrity-tiers` — bitácora

Sistema de detección multi-tier de duplicados de PNs en Steelhead. Vive como módulo
puro `remote/scripts/duplicate-tiers.js` (single source of truth) y se consume desde:

- **Applet `auditor`** (`remote/scripts/auditor.js`) — UI inline en la SPA + archivado batch.
- **Tool DevTools** (`tools/audit-incomplete-pns.js`) — flujo standalone con fetch+eval del módulo.

Spec: [`docs/superpowers/specs/2026-05-25-integrity-tiers-design.md`](../superpowers/specs/2026-05-25-integrity-tiers-design.md)
Plan: [`docs/superpowers/plans/2026-05-25-integrity-tiers.md`](../superpowers/plans/2026-05-25-integrity-tiers.md)

## 2026-05-26 — Release inicial 1.5.2 (módulo + auditor + DevTools)

### Versiones publicadas

| Componente | Archivo | Versión / commit |
|---|---|---|
| `duplicate-tiers.js` | `remote/scripts/duplicate-tiers.js` | inicial (md5 `86d54e82…`) |
| `auditor.js` integrity | `remote/scripts/auditor.js` | bump 1.5.2 (md5 `2930306e…`) |
| `host-cleanup-shared.js` | `remote/scripts/host-cleanup-shared.js` | 0.1.0 (nuevo en slot auditor) |
| `audit-incomplete-pns.js` tier scan | `tools/audit-incomplete-pns.js` | fetch+eval del módulo |
| `remote/config.json` | wire módulo + host-cleanup en slot auditor | 1.5.2 |

Branch de desarrollo: `feat/integrity-tiers` → merge `--no-ff` a `main` en `474a524`. Deploy a `gh-pages` en `f0d2048`.

### Los 3 tiers

| Tier | Regla | Acción |
|---|---|---|
| **DURO** | mismo `customInputs.DatosAdicionalesNP.QuoteIBMS` (cross-customer) | candidato a archive **y** delete |
| **MEDIO** | mismo nombre + customer + metalBase canónico + set canónico de finishings | candidato a archive |
| **SUAVE** | mismo nombre + customer, con asimetría de finishings (un subset es ⊆ del otro) | candidato a archive del subset |

**Precedencia DURO > MEDIO > SUAVE** la implementa el caller (`runIntegrityScan` en `auditor.js`):
saca los PNs ya bucketeados como DURO antes de evaluar MEDIO/SUAVE.

### Scoring + winner

`scoreFor(pn, detail, { nonFinishLabelNames })` retorna número (más alto = más reciente / más completo).
Regla bloqueante: si el PN no tiene proceso **o** no tiene spec, score=0 (no puede ganar).
Tiebreakers en `pickWinner`: score desc → id mayor (más reciente).

### Pase 1 + Pase 2

- **Pase 1** (`fetchAllPNsWithArchived`): paginado `AllPartNumbers` 500/página. Sub-pase activos
  primero, luego archivados (si `includeArchived=YES`), de-dup por id activo.
  Sub-pase archivados es opt-in vía toggle "Incluir archivados" en la UI (default ON).
- **Pase 2** (en `runIntegrityScan`): solo a los IDs candidatos detectados por el módulo
  (`hardBuckets` + `mediumBucketsCandidates`). Usa `GetPartNumber` con `usagesLimit:100`,
  pool de concurrencia 6, retry `[0, 1000, 2000]`.
- **Refinamiento** del módulo recibe los detalles y produce buckets finales (`refineMediumBuckets`,
  `refineSoftBuckets`).

### UI inline (modal de integridad en el auditor)

- 3 `<details>` por tier (DUROS rojo `#fca5a5`, MEDIOS amarillo `#fde68a`, SUAVES azul `#bae6fd`).
- Cada bucket tiene: radio buttons por miembro (winner pre-seleccionado), checkbox "Aplicar acción".
- 3 botones de acción: "Archivar TODOS los descartados (N)", "📋 CSV candidatos a DELETE", "💾 JSON audit".
- Archivado: lee selección del DOM por bucket (radio + checkbox), pool de concurrencia 5,
  idempotente (skip miembros ya `archivedAt!=null`), strike-through visual + retry button on failures.

### EJE A + B — memory hardening (1.5.2)

Aplicado tras invocar el skill `memory-hardening-applets` antes del push.

**EJE B (módulo compartido):**
- `remote/config.json:453` registra `scripts/host-cleanup-shared.js` en slot auditor.
- `auditor.js` llama `SteelheadHostCleanup.stopDatadogSessionReplay()` al inicio de `run()` (UNA vez, no en load).
- `createMemMonitor` con span `#sa-aud-mem` en modal del auditor (warn 70%, crit 85%, guardrail 88%).
- `onGuardrail` → `stopped=true` + `alert()` pidiendo reload de la tab.
- `makePeriodicDrain(50)` invocado en cada worker de los 3 `runPool`: pase 2 GetPartNumber,
  per-PN criteria, y `archiveLosers`.
- `monitor.stop()` en todos los return paths de `run()` y dentro de `stop()`.

**EJE A (memoria propia):**
- `buildBucketWithScores` ya **no retiene** `details: det` en los members. El `detail` del response
  de `GetPartNumber` (con relations + processNodes anidados) pesaba MB por bucket grande, y ningún
  consumer (`renderBucketCard`, `buildDeleteCSV`, `archiveLosers`) lo lee.
- Antes del return de `runIntegrityScan`: `for k in keys(detailsByPnId): det[k]=null` + `candidateIds.clear()`.

**Pendiente conocido (deuda):**
- Pase 1 sigue haciendo `allPNs.push({ ...n, archivedAt })` reteniendo el nodo full de AllPartNumbers.
  Aceptable hoy (solo 500 KB-ish por 5k PNs), pero candidato a slim si crece la base.
- Cleanup explícito al cerrar el modal de integridad (vive en `extension/background.js`) no implementado;
  el caso común es scan once → archive → cerrar tab.

### DevTools tool (`audit-incomplete-pns.js`)

- Fetch+eval de `duplicate-tiers.js` desde `https://oviazcan.github.io/SteelheadAutomator/scripts/duplicate-tiers.js?v=<config.version>` con cache-bust.
- UI: input cliente + checkbox "Incluir archivados" + botón "🔍 Scan integridad (duro/medio/suave)".
- `runTierScan({customerFilter, includeArchived})` orquesta pase 1 + 2 idéntico al applet, pero invocando `SADuplicateTiers` directamente.
- Render en panel propio (`renderTierResultsInPanel`) — `SYNCED WITH remote/scripts/auditor.js renderIntegrityResults v1`; cualquier cambio en el applet debe replicarse aquí.
- Reemplaza el viejo botón "QuoteIBMS dup scan" y `onStandaloneDupScan` (eliminados como dead code).

### Plan de validación pendiente

- [ ] Corrida controlada en producción con cliente de N=200-500 PNs y captura del `#sa-aud-mem` para validar que mem monitor reporta y no escala.
- [ ] Verificar idempotencia del archive batch: re-correr scan después de archivar → no debe re-proponer los mismos IDs.
- [ ] Test cross-customer DURO: dos PNs en clientes distintos con mismo QuoteIBMS deben aparecer en un solo bucket DURO.
- [ ] CSV delete: importar a Excel y validar que las 14 columnas se parsean (separador, comillas, escapado).

### Pendientes derivados

1. **Slim pase 1** (deuda EJE A): pasar de `{...n, archivedAt}` a `{id, name, customerByCustomerId, customInputs, createdAt, archivedAt}` antes de meter en `allPNs`.
2. **Cleanup en closePanel** del modal de integridad (lo hospeda `background.js`).
3. **Migrar `audit-incomplete-pns.js` Datadog stop inline** al módulo `host-cleanup-shared.js` (la copia inline data de bulk-upload v1.4.20).
4. Actualizar tabla de adopción del skill `memory-hardening-applets`: marcar `auditor` como ✅ EJE A + ✅ EJE B.

### Commits clave

- `36bddcc` docs(specs): integridad multi-tier en Auditor (duro/medio/suave)
- `b207244` docs(plans): plan 20 tasks TDD
- `7428a54..0b4c752` feat(duplicate-tiers): módulo (tasks 1-8)
- `2cc492b` chore(config): wire módulo al applet auditor + bump 1.5.0
- `dd028aa..a68d92e` feat(auditor): tasks 10-16 (refactor criterios, pase 1, pase 2, UI, archive, CSV/JSON, toggle)
- `8ad4906`, `699dcfc` feat(audit-incomplete-pns): tasks 17-18
- `474a524` merge feat→main
- `d4acc21` perf(auditor): memory hardening EJE A+B + bump 1.5.2
- `f0d2048` deploy: gh-pages 1.5.2 con host-cleanup-shared.js

## 2026-05-26 — Hotfix 1.5.3 (slim detail + buckets parciales + render stopped)

### Síntoma reportado (test 1.5.2)

> "se saturó la búsqueda y se bloqueó, pero aún así me dijo que no había
> duplicados, esto no es correcto. Además no me dijo cuántos de cuántos
> procesó. Por otro lado, si está deteniendo las sesiones datadog y apollo
> no debería saturarse tanto!"

3 bugs distintos saliendo del mismo run de prueba.

### Diagnóstico (root cause de cada uno)

| Bug | Causa | Fix |
|---|---|---|
| Falso "✓ Sin duplicados" al abortar | `runIntegrityScan` retornaba `{stopped, partialDetails}` sin armar buckets; `renderIntegrityResults` recibía `integrity = null` → cae al branch "sin duplicados" | Quitar early return: aunque `stopped=true`, refinar buckets con los details que sí se alcanzaron. Banner condicional en `renderIntegrityResults`. |
| Summary no decía progreso pase 2 | `background.js` solo mostraba contadores de audit per-PN (`results.totalAudited`); el `processedInPass2` no se trackeaba | `runIntegrityScan` ahora retorna `processedInPass2 / totalCandidatesPass2`. `background.js` summary los muestra + flag `⏸ ABORTADO POR MEMORIA` cuando aplica. |
| Saturación de memoria pese a stops | `detailsByPnId[pnId] = d?.partNumberById` retenía detail FULL (~30-80 KB × N candidatos = 150-400 MB). Apollo cache drain NO toca objetos JS plain — drena solo el store normalizado de Apollo | `slimDetail(raw)` extrae únicamente los ~12 fields que `duplicate-tiers.js` consume (customInputs, defaultProcessNodeId, descriptionMarkdown, partNumberGroupId, dimensionCustomValueIds, contadores `.nodes.length` y slim de `partNumberLabels` + `partNumberPrices`). ~1-2 KB por PN. `slimPass1Node(n)` análogo para `fetchAllPNsWithArchived`. |

### Cambios en código

- `auditor.js`:
  - `slimDetail(raw)` — preserva la shape nested (`.nodes`, `.length`) sin retener el objeto completo del response.
  - `slimPass1Node(n, archivedAtOverride)` — slim del pase 1 (sustituye `{...n, archivedAt}`, cierra deuda EJE A pendiente).
  - Pase 2 worker: `detailsByPnId[pnId] = slimDetail(d?.partNumberById)`.
  - Eliminado el early return en pase 2 cuando `stopped=true` — flujo continúa a refinement con detalles parciales.
  - `runIntegrityScan` return: `{ ..., stopped: wasStoppedInPass2, processedInPass2, totalCandidatesPass2 }`.
  - `run()` ya no early-returns en `integrityResult?.stopped`; setea `results.stopped` y continúa.
  - `renderIntegrityResults`: banner naranja "⏸ Run abortado por memoria. Procesados X/Y" cuando `integrity.stopped=true`; cuando además no hay buckets, mensaje específico "El resto quedó sin verificar".
  - Audit per-PN pase 1 slim (solo `{id, name, customerByCustomerId}`).

- `background.js`:
  - Summary diferenciado `Auditoría completada` vs `Auditoría DETENIDA (parcial)`.
  - Línea adicional `Integridad — pase 2: X/Y candidatos enriquecidos` + flag `⏸ ABORTADO POR MEMORIA`.

- `config.json`: bump `1.5.2 → 1.5.3`.

### Validación

- `node --check` sobre `auditor.js` y `background.js`: OK.
- `node --test tools/test/duplicate-tiers.test.js`: 39/39 pass (contrato del módulo intacto — `slimDetail` mantiene la shape que el módulo lee).
- `git diff HEAD:remote/scripts/auditor.js gh-pages:scripts/auditor.js`: vacío.
- `git diff HEAD:remote/config.json gh-pages:config.json`: vacío.

### Commits

- `c9c452a` perf(auditor): 1.5.3 — slim detail + buckets parciales + render stopped
- `9c5779a` deploy: auditor 1.5.3 slim detail + buckets parciales + bump 1.5.3
