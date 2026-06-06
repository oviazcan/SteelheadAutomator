# Bulk Uploader Refactor — F2: Memory hardening (módulo compartido) + storage 100% DB + robustez

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps usan checkbox (`- [ ]`).

**Goal:** Adoptar `host-cleanup-shared.js` (en vez de la copia inline), migrar `sa_load_history` de localStorage a IndexedDB, y endurecer la red (jitter en retry, AbortController por llamada) — sin cambiar el comportamiento funcional del pipeline.

**Architecture:** Reemplazar el bloque inline de memory hardening (`bulk-upload.js:216-350` + `startMemoryGauge`/`stopMemoryGauge`) por llamadas a `window.SteelheadHostCleanup.*` con guardia de transición (`if (window.SteelheadHostCleanup) … else fallback inline`), preservando los latches (`__sa_dd_stopped`, etc.) y el guardrail 88%. Migrar el único residuo de localStorage (`sa_load_history`) reusando los helpers `saIdb*` ya existentes.

**Tech Stack:** JS vanilla, IndexedDB, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-06-bulk-upload-refactor-design.md` (§9, §10, §11).

**NOTA de corrección al spec:** `clearDefaultProcess` **NO es flag muerto** — se lee en los builders (`bulk-upload.js:4607,4741,5396`). El mapeo del workflow se equivocó. **NO tocarlo en F2.**

---

## Task 1: Jitter en `withRetry` (anti thundering-herd) — bajo riesgo

**Files:** Modify `remote/scripts/bulk-upload.js:765`

- [ ] **Step 1:** Cambiar `const delay = delays[attempt];` por:

```js
        // F2: jitter ±25% para que los 8 workers concurrentes que fallan al mismo
        // tiempo no reintenten en el mismo milisegundo exacto (thundering herd).
        const delay = Math.round(delays[attempt] * (0.75 + Math.random() * 0.5));
```

- [ ] **Step 2:** `node --check remote/scripts/bulk-upload.js` → OK.
- [ ] **Step 3:** commit `fix(bulk-upload F2): jitter en withRetry`.

## Task 2: Fix tooltip localStorage→IndexedDB — bajo riesgo

**Files:** Modify `remote/scripts/bulk-upload.js:2789`

- [ ] **Step 1:** Cambiar el texto del chip (resume ya vive en IndexedDB desde 1.4.27):

```js
                chip.title = 'Decisión persistida en IndexedDB; al recargar y elegir REANUDAR vuelve aplicada.';
```

- [ ] **Step 2:** `node --check` → OK. commit `fix(bulk-upload F2): tooltip resume dice IndexedDB`.

## Task 3: Migrar `sa_load_history` localStorage → IndexedDB

**Files:** Modify `remote/scripts/bulk-upload.js` (bloque ~6435-6450 del historial de cargas)

- [ ] **Step 1:** Leer el bloque actual completo (lectura + escritura de `sa_load_history`, con el manejo de `QuotaExceededError`).
- [ ] **Step 2:** Reemplazar `localStorage.getItem/setItem('sa_load_history', …)` por los helpers IDB ya existentes (`saIdbGet('sa_load_history')` / `saIdbSet('sa_load_history', history)`). Como IDB no tiene cuota de 5MB, eliminar el workaround de recorte por `QuotaExceededError` (o subir el cap de entradas). Mantener el cap de 20 entradas por higiene.
- [ ] **Step 3:** Migración one-shot: en `migrateLocalStorageToIdb()` (o junto a él), copiar `sa_load_history` de localStorage a IDB si existe, y `localStorage.removeItem`. Idempotente.
- [ ] **Step 4:** Verificar carga simulada (window mock) no truena; `node --check` OK.
- [ ] **Step 5:** commit `feat(bulk-upload F2): sa_load_history a IndexedDB (storage 100% DB)`.

## Task 4: Adoptar `host-cleanup-shared.js` (el delicado)

**Files:** Modify `remote/scripts/bulk-upload.js` (`stopDatadogSessionReplay` 216-323, `triggerMemoryGuardrail` 325, `startMemoryGauge` 948, `stopMemoryGauge` 975), `remote/config.json` (scripts array).

El API de `host-cleanup-shared.js` es **idéntico** al inline (verificado: vino de 1.4.42). Reemplazo con guardia de transición para no romper si el script no cargó.

- [ ] **Step 1:** `config.json`: agregar `"scripts/host-cleanup-shared.js"` al array `scripts` de carga-masiva y al global, **después de steelhead-api.js y antes de bulk-upload-cc.js**. Bump version.
- [ ] **Step 2:** En `bulk-upload.js`, al inicio del IIFE, definir alias con guardia:

```js
  const HostCleanup = window.SteelheadHostCleanup || null;
  function stopDatadogSessionReplay() {
    if (HostCleanup) return HostCleanup.stopDatadogSessionReplay();
    /* fallback inline (se conserva durante la transición) */
    return _inlineStopDatadog();
  }
```

  Renombrar la función inline actual a `_inlineStopDatadog` (mantenerla como fallback). Igual para `apolloCacheDrain` si se usa directo.
- [ ] **Step 3:** `startMemoryGauge`: si `HostCleanup`, usar `HostCleanup.createMemMonitor({ getElement: () => document.getElementById('<id del span de mem>'), onGuardrail: triggerMemoryGuardrail, warnPct:70, critPct:85, guardrailPct:88 })` guardando la instancia; `.start()`. `stopMemoryGauge` → `.stop()`. Conservar el gauge inline como fallback si `!HostCleanup`.
- [ ] **Step 4:** Activar `makePeriodicDrain(50)`: crear `const periodicDrain = HostCleanup ? HostCleanup.makePeriodicDrain(50) : () => {};` e invocar `periodicDrain()` al final del worker del pool de enrich (donde hoy NO se drena).
- [ ] **Step 5:** Verificar latches intactos: `node --check` + carga simulada (window mock con SteelheadHostCleanup stub) confirmando que `stopDatadogSessionReplay` delega y el guardrail dispara una vez.
- [ ] **Step 6:** commit `refactor(bulk-upload F2): adoptar host-cleanup-shared + makePeriodicDrain`.

## Task 5: AbortController 30s por llamada API

**Files:** Modify `remote/scripts/steelhead-api.js` (función `query`)

- [ ] **Step 1:** En `query()`, envolver el `fetch` con `AbortController` + timeout configurable (default 30s desde config). Limpiar el timer en `finally`. Mapear `AbortError` a un error retryable para que `withRetry` lo reintente.
- [ ] **Step 2:** `node --check` ambos archivos. commit `feat(api F2): AbortController 30s por llamada (workers colgados)`.

## Task 6: Deploy F2 (gate usuario)

- [ ] Sync a gh-pages vía worktree temporal (no tocar working tree): `host-cleanup-shared.js` (ya existe en gh-pages? verificar), `bulk-upload.js`, `steelhead-api.js`, `config.json`. Verificar byte-exact. Push con OK del usuario.
- [ ] Validación usuario: correr una carga real y confirmar que el gauge de memoria pinta, el guardrail no dispara falso, y el resume sigue funcionando.
- [ ] Anotar bitácora F2.

## Definition of Done F2
- `host-cleanup-shared.js` en el array scripts; inline reemplazado con guardia; `makePeriodicDrain(50)` activo.
- `sa_load_history` en IndexedDB; localStorage sin residuos del pipeline.
- jitter en retry; AbortController por llamada.
- `node --check` OK; carga simulada OK; deploy byte-exact; push con OK del usuario.
