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
