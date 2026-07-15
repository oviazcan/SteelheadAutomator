# Audit de memory-hardening por applet (#113) — 2026-07-15

Barrido de adopción de `host-cleanup-shared.js` (`window.SteelheadHostCleanup`:
`stopDatadogSessionReplay`, `apolloCacheDrain`, `createMemMonitor`, `makePeriodicDrain`)
en los applets de larga duración. Cierra el task #113.

Método: revisión de los arrays `scripts` en `remote/config.json` + grep de uso real del
helper + inspección de higiene propia (closePanel, resetState, Maps con TTL).

## Estado por applet

| Applet | ¿shared en config? | ¿usa SteelheadHostCleanup? | Estado |
|---|---|---|---|
| bulk-upload | ✅ | ✅ 4 helpers + `makePeriodicDrain(50)` | **ADOPTADO** |
| archiver | ✅ | ✅ 4 helpers | **ADOPTADO** |
| auditor (incl. audit-incomplete-pns / integrity-tiers) | ✅ | ✅ 4 helpers (`hc()`) | **ADOPTADO** |
| spec-migrator | ✅ | ✅ 4 helpers (reemplazó inline) | **ADOPTADO** |
| pn-lifecycle | ✅ | ✅ 3 helpers + pool 3 + resume | **ADOPTADO** |
| pn-specs-column | ✅ | ✅ + guardas idempotencia propias | **ADOPTADO** |
| wo-completer | ✅ | ✅ 4 helpers + `makePeriodicDrain(25)` | **ADOPTADO** |
| wo-mover | ✅ | ✅ 4 helpers | **ADOPTADO** |
| file-uploader | ✅ | ✅ `HC?.` completo | **ADOPTADO** |
| spec-params-bulk | ❌ | ❌ | **PARCIAL** — `runPool(5)` + `closePanel()` limpia; sin Datadog/Apollo/heap |
| process-canon / process-deep-audit | ❌ | ❌ | **PARCIAL** — varios `runPool`; runId/isStale/resetState propio; sin shared |
| po-reconciler | ❌ | ❌ | **PARCIAL** — 2308 líneas, `Promise.all` pools; runId + reset propio |
| invoice-auto-regen | ❌ | ❌ | **PARCIAL** — poller de fondo, pool 5 paginado + Map con TTL propio |
| auto-router (batch) | ❌ | ❌ (comentario corregido 2026-07-15) | **PARCIAL** — pool propio 3, `state=fresh()`; sin shared |
| **portal-importer** | ❌ | ❌ | **NO-ADOPTADO** — 1356 líneas, itera POs con `await` secuencial; solo `removeOverlay()` |
| **po-comparator** | ❌ | ❌ | **NO-ADOPTADO** — 1647 líneas, wizard PDF-por-PDF; cero hardening |
| load-calculator | ❌ | ❌ | **N-A** — 3 fetches puntuales, sub-segundo |

**Resumen:** 9 ADOPTADO · 5 PARCIAL · 2 NO-ADOPTADO · 1 N-A · **0 INLINE-DUP** (no hay
copias del patrón que rompan latches — el riesgo es de *omisión*, no de duplicación).

## Follow-up priorizado (adopción pendiente)

Ninguno es urgente (todos tienen algo de higiene propia). Orden sugerido cuando se retome:

1. **portal-importer** y **po-comparator** (NO-ADOPTADO) — los de mayor superficie sin
   ningún hardening de host. Procesan listas de POs/PDFs con panel abierto. Agregar
   `host-cleanup-shared.js` a su array `scripts` en config + `stopDatadogSessionReplay` al
   abrir + `makePeriodicDrain` en el loop + `apolloCacheDrain` en cleanup.
2. **invoice-auto-regen** (PARCIAL) — poller de FONDO (corre en cada carga de facturas):
   el que más se beneficia de `stopDatadogSessionReplay` + drain periódico por ser continuo.
3. **auto-router batch** (PARCIAL) — solo si "Rutear TODAS" (cap 60 WOs) presiona memoria.
4. **po-reconciler**, **process-deep-audit**, **spec-params-bulk** (PARCIAL) — ya tienen
   reset/runId; adoptar el shared es defensa en profundidad.

> Regla al adoptar (del skill `memory-hardening-applets`): importar el shared vía el array
> `scripts` de config.json y usar `window.SteelheadHostCleanup.*` — **NO** copiar el patrón
> inline (rompe los latches `window.__sa_dd_stopped` y la idempotencia entre co-residentes).
