# Bulk Uploader Refactor — F3: Panel único expandible + 2 barras + confirmaciones internas + storage .zip

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps usan checkbox.

**Goal:** Unificar la UI en-página (panel de progreso + preview + modales) en UN panel anclado a la derecha que crece (fase preview) y se encoge (fase ejecución), con DOS barras separadas (global + paso) y confirmaciones internas. Quitar "Descargar Plantilla" del menú. Migrar `sa_load_history` a IndexedDB (cierra "todo por DB"). Republicar `.zip` una vez.

**Architecture:** Hoy `#sa-bu-panel` (z-index 100000, fixed top-right 480px) y `.dl9-overlay` (z-index 99999, full-screen) son elementos SEPARADOS. F3: un solo `#sa-bu-panel` con un atributo `data-phase` (menu|preview|running|confirm|done) que controla ancho y contenido vía CSS. Se eliminan `createOverlay`/`dl9-overlay` para preview y confirmaciones (pasan a secciones internas del panel). El menú sigue siendo el popup de Chrome (`extension/popup.html`) — F3 solo le quita una acción vía config.

**Diseño acordado (mockups):**

```
FASE PREVIEW (panel expandido ~75% ancho)         FASE EJECUCIÓN (panel ~420px)
┌ SH ───────┬ Carga Masiva ──────────[▢][x]┐      ┌ Steelhead visible ──┬ Carga Masiva [x]┐
│           │ [22 filas · 0 nuevos · MODIF]│      │                     │ Paso 6/10 Enriq.│
│           │ Paso 1/10 · Clasificación    │      │   (SH visible)      │ Global ███████░ │
│           │ ┌──────────────────────────┐ │      │                     │ Paso   █████░░  │
│           │ │ tabla de decisiones (22) │ │      │                     │ Mem: 340MB      │
│           │ └──────────────────────────┘ │      │                     │ log…            │
│           │     [Cancelar] [Ejecutar ▶] │      │                     │ [Detener]       │
└───────────┴──────────────────────────────┘      └─────────────────────┴─────────────────┘

CONFIRMACIÓN (sección interna, reemplaza contenido temporalmente)
┌ Carga Masiva ─────────────────[x]┐
│ ⚠ Procesos no encontrados (1)    │
│ "Combinación no existente"       │
│ [Cancelar corrida] [Preservar]   │
└──────────────────────────────────┘
```

**Spec:** `docs/superpowers/specs/2026-06-06-bulk-upload-refactor-design.md` (§7).
**Mapa UI:** ensurePanel L867, showPreview L2042, confirmUnresolvedProcesses L2016, showQuoteConflict L3045, showResult L3175, setProgressBar L3022, setPanelProgress L1011. Popup: extension/popup.{html,js}. background.js: view-load-history L347, download-load-csv L359.

---

## Task 1: Quitar "Descargar Plantilla" del menú (config) — solo gh-pages

**Files:** Modify `remote/config.json` (actions de carga-masiva, ~L422)

- [ ] **Step 1:** Eliminar la entrada `{id:"download-template", ...}` del array `actions`. La plantilla queda accesible desde el botón `#sa-bu-dl-v11` del panel. Bump version.
- [ ] **Step 2:** `jq -e .` OK. commit `feat(bulk-upload F3): quitar Descargar Plantilla del menú de operación`.

## Task 2: Panel único — estructura de fases + CSS

**Files:** Modify `remote/scripts/bulk-upload.js` (`ensurePanelStyles` L835, `ensurePanel` L867)

- [ ] **Step 1:** Reescribir `ensurePanelStyles`: agregar reglas por `#sa-bu-panel[data-phase=...]`:
  - `[data-phase=preview]` → `width: min(75vw, 1400px)`
  - `[data-phase=running]`, `[data-phase=done]` → `width: 420px`
  - `[data-phase=confirm]` → `width: 520px`
  - transición `width .25s ease`.
- [ ] **Step 2:** `ensurePanel`: agregar contenedores internos: `#sa-bu-preview-section` (tabla), `#sa-bu-confirm-section` (confirmaciones), `#sa-bu-run-section` (stepper + 2 barras + log). Helper `setPanelPhase2(phase)` que setea `data-phase` y muestra/oculta secciones.
- [ ] **Step 3:** `node --check` + carga simulada. commit.

## Task 3: DOS barras separadas (global + paso)

**Files:** Modify `remote/scripts/bulk-upload.js` (`setProgressBar` L3022, `setPanelProgress` L1011)

- [ ] **Step 1:** Agregar segunda barra en el panel: `#sa-bu-bar-global` (fases del pipeline) y renombrar la existente a `#sa-bu-bar-step` (items del pool).
- [ ] **Step 2:** `setProgressBar(p)` → escribe SOLO `#sa-bu-bar-global` (y un label "Paso N/10"). `setPanelProgress(cur,total)` → escribe SOLO `#sa-bu-bar-step` (y "cur/total"). Ya no se pisan.
- [ ] **Step 3:** Definir el total de pasos del pipeline (10) y un helper `setGlobalStep(n, label)` que calcule `n/10*100`. Reemplazar los `setProgressBar(5/10/15...)` hardcodeados por `setGlobalStep(n, 'Clasificación'|'Creación'|...)`.
- [ ] **Step 4:** `node --check`. commit.

## Task 4: Preview dentro del panel (eliminar dl9-overlay del preview)

**Files:** Modify `remote/scripts/bulk-upload.js` (`showPreview` L2042)

- [ ] **Step 1:** `showPreview` deja de hacer `createOverlay()`; renderiza su tabla en `#sa-bu-preview-section` y setea `setPanelPhase2('preview')`. Mantener TODA la lógica de la tabla (filtros, paginación, decisiones, badges) — solo cambia el contenedor.
- [ ] **Step 2:** Al confirmar (Ejecutar) → `setPanelPhase2('running')` (panel se encoge). Al cancelar → cerrar panel.
- [ ] **Step 3:** `node --check` + carga simulada. commit. **VALIDACIÓN VISUAL con usuario** (gate).

## Task 5: Confirmaciones internas (procesos + conflicto cotización)

**Files:** Modify `remote/scripts/bulk-upload.js` (`confirmUnresolvedProcesses` L2016, `showQuoteConflict` L3045)

- [ ] **Step 1:** Reescribir ambas para renderizar en `#sa-bu-confirm-section` + `setPanelPhase2('confirm')` en vez de `createOverlay()`. Devuelven Promise como antes (resuelven al click). Al resolver, volver a la fase previa (`preview` o `running`).
- [ ] **Step 2:** `showResult` puede quedar como overlay propio (es el final) o pasar a fase `done` del panel. Preferir fase `done`.
- [ ] **Step 3:** `node --check`. commit. Validación visual.

## Task 6: sa_load_history → IndexedDB (toca .zip)

**Files:** Modify `remote/scripts/bulk-upload.js` (historial ~L6437, `migrateLocalStorageToIdb` L525), `extension/background.js` (L347, L359)

- [ ] **Step 1:** bulk-upload.js: reemplazar `localStorage.getItem/setItem('sa_load_history')` por `await saIdbGet/saIdbSet`; quitar workaround QuotaExceededError. Exponer `getLoadHistory()` async en el `return` de BulkUpload.
- [ ] **Step 2:** `migrateLocalStorageToIdb`: copiar `sa_load_history` de localStorage a IDB + removeItem (one-shot).
- [ ] **Step 3:** background.js `view-load-history` y `download-load-csv`: el func inyectado (world MAIN) usa `await window.BulkUpload.getLoadHistory()` en vez de `localStorage.getItem`.
- [ ] **Step 4:** `node --check` ambos. commit.

## Task 7: Deploy F3 (gh-pages + .zip + gate usuario)

- [ ] **Step 1:** Sync a gh-pages vía worktree: `bulk-upload.js`, `config.json`. Byte-exact. Push con OK.
- [ ] **Step 2:** Reconstruir el `.zip` de la extensión (con background.js nuevo). Publicarlo donde corresponda (`extensionZipUrl` en config / Chrome Web Store). Bump `extensionVersion`. El usuario reinstala/actualiza la extensión.
- [ ] **Step 3:** Validación visual completa con el usuario: panel crece en preview, se encoge en ejecución, 2 barras se mueven independientes, confirmaciones internas, Historial de Cargas funciona (lee de IDB).
- [ ] **Step 4:** Bitácora F3.

## Definition of Done F3
- Un solo `#sa-bu-panel` con fases; sin `dl9-overlay` para preview/confirmaciones.
- 2 barras independientes (global + paso).
- "Descargar Plantilla" fuera del menú.
- `sa_load_history` en IndexedDB (bulk-upload + background.js); localStorage del pipeline = 0 residuos.
- Deploy gh-pages + .zip; validación visual del usuario OK.
