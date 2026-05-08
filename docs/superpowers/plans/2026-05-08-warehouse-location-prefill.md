# warehouse-location-prefill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el applet `warehouse-location-prefill` — combobox de "Ubicación inicial:" en el header del modal Receive Parts con filtro Aduana por default, que sobrescribe el `locationId` de todos los lotes interceptando `CreateReceiverChecked` y deshabilita visualmente los combos per-line.

**Architecture:** Applet vanilla JS estilo "intercept-and-mutate" sobre `window.fetch`. Estructura espejada de `receiver-date-override.js` (mismo patrón de detección de modal vía MutationObserver + `data-sa-wlp-attached`). Combobox custom (no react-select) inyectado como sibling de `.css-xd9ivb`. Disabling de combos per-line vía overlay CSS sobre `.css-qpe0ht-control`. Datos de ubicaciones via `SearchLocationsOnPath` usando `window.SteelheadAPI`.

**Tech Stack:** JavaScript vanilla MV3, `window.SteelheadAPI` (helper interno del proyecto), Chrome storage API para el toggle, `MutationObserver` para detectar modal y nuevas líneas.

---

## File Structure

- **Create**: `remote/scripts/warehouse-location-prefill.js` (~250 líneas, IIFE estilo `ReceiverDateOverride`)
- **Modify**: `remote/config.json` (entrada nueva en `apps[]`, actualizar `apiKnowledge.queries.SearchLocationsOnPath.usedBy`, bump `version` + `lastUpdated`)
- **Modify**: `extension/background.js` (agregar entry en `globals` map + handlers `toggle-warehouse-location-prefill` / `get-warehouse-location-prefill-status`)
- **Modify**: `extension/content.js` (propagar flag `saWarehouseLocationPrefillEnabled` al dataset)
- **Modify**: `CLAUDE.md` (al final, mover el applet de "Próximo planeado" a "Implementado" + lecciones)

---

## Convenciones del applet

- **Log prefix**: `[WLP]`
- **Storage key**: `warehouseLocationPrefillEnabled` (bool, default `true`)
- **Dataset attribute**: `document.documentElement.dataset.saWarehouseLocationPrefillEnabled`
- **Global name**: `WarehouseLocationPrefill`
- **Modal marker**: `data-sa-wlp-attached="true"`
- **Fetch patch guard**: `window.__saWlpFetchPatched`
- **Versión target inicial**: `0.5.69` (cada tarea posterior bumpea minor: `0.5.70`, `0.5.71`, ...)

## Deploy Procedure (referenciado por cada tarea)

Cada tarea termina con un deploy a `gh-pages` para que la extensión recargada vea los cambios. El procedimiento (documentado en `CLAUDE.md`):

1. Bump `remote/config.json` `version` (+1 al patch) y `lastUpdated` a la fecha (`2026-05-08`).
2. `git add <archivos modificados> && git commit -m "<prefix>(warehouse-location-prefill): <descripción> (<version>)"`
3. Sync a `gh-pages`: `git checkout gh-pages`, copiar `remote/scripts/warehouse-location-prefill.js` → `scripts/warehouse-location-prefill.js`, copiar `remote/config.json` → `config.json` (raíz). Si la tarea cambió `extension/`, también bumpear `extensionVersion` y empaquetar el zip.
4. `git add scripts/warehouse-location-prefill.js config.json && git commit -m "deploy: <descripción> + bump <version>"`
5. `git checkout main && git push origin main && git push origin gh-pages`
6. Recargar la extensión en `chrome://extensions` (botón reload del SteelheadAutomator).
7. Verificar en `app.gosteelhead.com` con DevTools abierto: log `[WLP] Inicializado` o el indicador correspondiente al estado de la tarea.

**Para tareas que NO cambien código del applet** (solo docs o CLAUDE.md), el deploy a gh-pages no es necesario — solo commit en main.

---

## Task 1: Esqueleto del applet + integración base

**Files:**
- Create: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (entrada en `apps[]`, actualizar `apiKnowledge`, bump version → `0.5.69`)
- Modify: `extension/background.js` (entry en `globals` map + 2 handlers)
- Modify: `extension/content.js` (propagar flag)

- [ ] **Step 1.1: Crear `remote/scripts/warehouse-location-prefill.js` con shell mínimo**

```js
// Warehouse Location Prefill
// Inyecta un combobox "Ubicación inicial:" en el header del modal Receive Parts
// y, al elegir una ubicación, intercepta CreateReceiverChecked para sobrescribir
// el locationId en todos los receiverBomItems[].inventoryTransferEvent.
// debitAccounts.accounts[]. Deshabilita visualmente los combos per-line via
// overlay CSS mientras hay valor en el header.

const WarehouseLocationPrefill = (() => {
  'use strict';

  const LOG_PREFIX = '[WLP]';
  const api = () => window.SteelheadAPI;
  let observerActive = false;

  // modal element → { selectedLocation, aduanaCache, fullCache, ... }
  const modalStates = new WeakMap();

  function init() {
    const disabled = document.documentElement.dataset.saWarehouseLocationPrefillEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    console.log(LOG_PREFIX, 'Inicializado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WarehouseLocationPrefill = WarehouseLocationPrefill;
  WarehouseLocationPrefill.init();
}
```

- [ ] **Step 1.2: Agregar entry en `apps[]` de `remote/config.json`**

Localizar la sección `apps[]` (antes del cierre `]`), después de la entrada `receiver-date-override`, insertar:

```json
{
  "id": "warehouse-location-prefill",
  "name": "Ubicación de Recibo",
  "subtitle": "Prefil de ubicación inicial en el modal de Receive Parts",
  "icon": "📦",
  "category": "Recibo",
  "scripts": ["scripts/steelhead-api.js", "scripts/warehouse-location-prefill.js"],
  "autoInject": true,
  "requiredPermissions": ["READ_RECEIVING"],
  "actions": [
    { "id": "toggle-warehouse-location-prefill", "label": "Ubicación de Recibo", "sublabel": "Prefil de ubicación inicial al recibir", "icon": "📦", "type": "toggle", "handler": "message", "message": "toggle-warehouse-location-prefill" }
  ]
},
```

(con coma final si hay más apps después; revisar el JSON resultante).

- [ ] **Step 1.3: Actualizar `apiKnowledge.queries.SearchLocationsOnPath.usedBy` en `remote/config.json`**

Cambiar:
```json
"SearchLocationsOnPath": { "type": "query", "description": "Buscar ubicaciones de almacén por path (Ecoplating.N3.A3.RJ)", "usedBy": "inventory-reset" },
```

por:
```json
"SearchLocationsOnPath": { "type": "query", "description": "Buscar ubicaciones de almacén por path (Ecoplating.N3.A3.RJ)", "usedBy": "inventory-reset, warehouse-location-prefill" },
```

- [ ] **Step 1.4: Bump version y lastUpdated en `remote/config.json`**

Cambiar `"version": "0.5.68"` → `"version": "0.5.69"` y `"lastUpdated": "2026-05-07"` → `"lastUpdated": "2026-05-08"`.

- [ ] **Step 1.5: Agregar entry en el `globals` map de `extension/background.js`**

Localizar la línea `'scripts/receiver-date-override.js': 'ReceiverDateOverride' };` (cerca de la línea 69) y reemplazarla por:

```js
          'scripts/receiver-date-override.js': 'ReceiverDateOverride',
          'scripts/warehouse-location-prefill.js': 'WarehouseLocationPrefill' };
```

- [ ] **Step 1.6: Agregar handlers en `extension/background.js`**

Localizar el bloque `case 'get-receiver-date-override-status':` (cerca de línea 1046). Después de su cierre `}`, antes del próximo case, insertar:

```js
    // ── Warehouse Location Prefill ──
    case 'toggle-warehouse-location-prefill': {
      const { warehouseLocationPrefillEnabled } = await chrome.storage.local.get('warehouseLocationPrefillEnabled');
      const newState = warehouseLocationPrefillEnabled === false;
      await chrome.storage.local.set({ warehouseLocationPrefillEnabled: newState });
      return { enabled: newState, message: newState ? 'Ubicación de Recibo habilitada' : 'Ubicación de Recibo deshabilitada' };
    }

    case 'get-warehouse-location-prefill-status': {
      const { warehouseLocationPrefillEnabled } = await chrome.storage.local.get('warehouseLocationPrefillEnabled');
      return { enabled: warehouseLocationPrefillEnabled !== false };
    }
```

- [ ] **Step 1.7: Propagar el flag desde `extension/content.js`**

Localizar el bloque que lee `receiverDateOverrideEnabled` (cerca de línea 22). Después de él, añadir:

```js
  // Communicate Warehouse Location Prefill enabled state to MAIN world
  chrome.storage.local.get('warehouseLocationPrefillEnabled', (data) => {
    const enabled = data.warehouseLocationPrefillEnabled !== false;
    document.documentElement.dataset.saWarehouseLocationPrefillEnabled = enabled;
  });
```

Y dentro del listener `chrome.storage.onChanged` (cerca de línea 28), después del bloque `if (changes.receiverDateOverrideEnabled)`, añadir:

```js
    if (changes.warehouseLocationPrefillEnabled) {
      const enabled = changes.warehouseLocationPrefillEnabled.newValue !== false;
      document.documentElement.dataset.saWarehouseLocationPrefillEnabled = enabled;
    }
```

- [ ] **Step 1.8: Test manual — verificar carga del applet**

Aplicar el deploy procedure (sección "Deploy Procedure" arriba). Después:

1. Recargar la extensión.
2. Abrir `app.gosteelhead.com` con DevTools.
3. Verificar que aparezca en consola: `[WLP] Inicializado`.
4. Abrir el popup de la extensión, verificar que el toggle "Ubicación de Recibo" aparece y se puede prender/apagar.
5. Apagar el toggle, recargar la página. Verificar en consola: `[WLP] Deshabilitado`.
6. Volver a prenderlo, recargar, confirmar `[WLP] Inicializado` otra vez.

- [ ] **Step 1.9: Commit + deploy gh-pages**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json extension/background.js extension/content.js
git commit -m "feat(warehouse-location-prefill): esqueleto del applet + integración base (0.5.69)"
```

Sync a `gh-pages` y push (ver Deploy Procedure).

---

## Task 2: Detector del modal Receive Parts

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.70`, `lastUpdated`)

- [ ] **Step 2.1: Agregar el observer y la lógica de detección de modal**

Reemplazar el cuerpo completo de `WarehouseLocationPrefill` IIFE en `remote/scripts/warehouse-location-prefill.js` por:

```js
const WarehouseLocationPrefill = (() => {
  'use strict';

  const LOG_PREFIX = '[WLP]';
  const api = () => window.SteelheadAPI;
  let observerActive = false;

  const modalStates = new WeakMap();

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

  function init() {
    const disabled = document.documentElement.dataset.saWarehouseLocationPrefillEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    let scanTimeout = null;
    const observer = new MutationObserver(() => {
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(scanForReceiveView, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForReceiveView();
  }

  function scanForReceiveView() {
    const candidates = document.querySelectorAll(HEADING_SELECTOR);
    for (const el of candidates) {
      if (!VIEW_REGEX.test(el.textContent?.trim())) continue;
      const container = el.closest('[role="dialog"]')
        || el.closest('.MuiDialog-paper')
        || el.closest('[class*="MuiPaper"]')
        || el.closest('main')
        || el.closest('form')
        || el.parentElement?.parentElement;
      if (container) {
        onModalFound(container);
        return;
      }
    }
  }

  function onModalFound(modal) {
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      fullCache: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    watchModalRemoval(modal);
  }

  function watchModalRemoval(modal) {
    const removalObserver = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        removalObserver.disconnect();
        cleanupModal(modal);
      }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const state = modalStates.get(modal);
    if (state) state.removalObserver = removalObserver;
  }

  function cleanupModal(modal) {
    const state = modalStates.get(modal);
    if (state?.removalObserver) state.removalObserver.disconnect();
    if (state?.rowObserver) state.rowObserver.disconnect();
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WarehouseLocationPrefill = WarehouseLocationPrefill;
  WarehouseLocationPrefill.init();
}
```

- [ ] **Step 2.2: Bump version a `0.5.70` en `remote/config.json`**

- [ ] **Step 2.3: Test manual — abrir el modal Receive Parts**

Aplicar deploy procedure. Después:

1. Recargar extensión, abrir `app.gosteelhead.com`.
2. Navegar a un Domain con receivers y abrir el modal "Receive Parts from Customer" (o "Recibir piezas del cliente" si el UI está en español).
3. Verificar en consola: `[WLP] Modal de recibo detectado`.
4. Cerrar el modal sin guardar.
5. Verificar en consola: `[WLP] Modal cleanup completado`.

- [ ] **Step 2.4: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): detector del modal Receive Parts (0.5.70)"
```

Sync a `gh-pages` y push.

---

## Task 3: UI shell del combobox del header (visual sin lógica)

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.71`)

- [ ] **Step 3.1: Agregar `injectStyles()` y `injectField(modal)` antes del `return { init };`**

Insertar dentro de la IIFE, antes del `return { init };`:

```js
  function injectStyles() {
    if (document.getElementById('sa-wlp-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-wlp-styles';
    style.textContent = `
      .sa-wlp-wrapper { margin-top: 12px; }
      .sa-wlp-controls {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .sa-wlp-combo {
        position: relative; min-width: 320px;
        border: 1px solid #c4c4c4; border-radius: 4px; background: #fff;
      }
      .sa-wlp-combo-input {
        width: 100%; border: 0; outline: 0; background: transparent;
        padding: 8.5px 32px 8.5px 14px; font: inherit; font-size: 14px;
        color: rgba(0,0,0,0.87);
      }
      .sa-wlp-combo:focus-within {
        outline: 2px solid #1976d2; outline-offset: -1px; border-color: transparent;
      }
      .sa-wlp-combo-clear {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        cursor: pointer; color: #888; font-size: 16px; line-height: 1;
        background: transparent; border: 0; padding: 2px 6px;
      }
      .sa-wlp-combo-clear:hover { color: #1976d2; }
      .sa-wlp-dropdown {
        position: absolute; top: 100%; left: 0; right: 0; z-index: 1500;
        background: #fff; border: 1px solid #c4c4c4; border-radius: 4px;
        max-height: 280px; overflow-y: auto; margin-top: 2px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
      }
      .sa-wlp-dropdown[hidden] { display: none; }
      .sa-wlp-option {
        padding: 8px 14px; cursor: pointer; font-size: 14px;
      }
      .sa-wlp-option:hover, .sa-wlp-option[data-active="true"] {
        background: rgba(25,118,210,0.08);
      }
      .sa-wlp-option-empty {
        padding: 8px 14px; font-size: 13px; color: #888; font-style: italic;
      }
      .sa-wlp-option-sentinel {
        padding: 8px 14px; font-size: 13px; color: #1976d2; font-style: italic;
        cursor: pointer; border-top: 1px solid #eee;
      }
      .sa-wlp-option-sentinel:hover { background: rgba(25,118,210,0.08); }
      .sa-wlp-row-overlay {
        position: absolute; inset: 0; display: flex; align-items: center;
        padding: 0 14px; background: rgba(245,245,245,0.85);
        font-size: 13px; color: rgba(0,0,0,0.65); font-style: italic;
        pointer-events: auto;
      }
    `;
    document.head.appendChild(style);
  }

  function injectField(modal) {
    if (modal.querySelector('[data-sa-wlp-field="true"]')) return;

    // Anclar al wrapper de "Receiver Comments" (el row container .css-xd9ivb del header)
    const labels = modal.querySelectorAll('p');
    let anchorWrapper = null;
    for (const p of labels) {
      if (/^(?:receiver\s+comments|comentarios\s+del\s+receptor):?$/i.test(p.textContent.trim())) {
        anchorWrapper = p.closest('.css-iyrxkt');
        break;
      }
    }
    if (!anchorWrapper) {
      console.warn(LOG_PREFIX, 'No se localizó el wrapper de Receiver Comments — layout cambió?');
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'css-iyrxkt sa-wlp-wrapper';
    wrapper.dataset.saWlpField = 'true';

    const label = document.createElement('p');
    label.className = 'MuiTypography-root MuiTypography-body1 css-9l3uo3';
    label.style.gridColumn = '1';
    label.textContent = 'Ubicación inicial:';
    wrapper.appendChild(label);

    const controls = document.createElement('div');
    controls.style.gridColumn = '2';
    controls.className = 'sa-wlp-controls';

    const combo = document.createElement('div');
    combo.className = 'sa-wlp-combo';
    combo.dataset.saWlpCombo = 'true';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sa-wlp-combo-input';
    input.placeholder = 'Buscar ubicación (filtro: Aduana)';
    input.autocomplete = 'off';
    combo.appendChild(input);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sa-wlp-combo-clear';
    clearBtn.textContent = '✕';
    clearBtn.hidden = true;
    clearBtn.title = 'Limpiar selección';
    combo.appendChild(clearBtn);

    const dropdown = document.createElement('div');
    dropdown.className = 'sa-wlp-dropdown';
    dropdown.hidden = true;
    combo.appendChild(dropdown);

    controls.appendChild(combo);
    wrapper.appendChild(controls);

    // Insertar como sibling del row container (.css-xd9ivb) — debajo del date applet si existe
    const rowContainer = anchorWrapper.parentElement;
    if (rowContainer) {
      // Si el date applet ya inyectó su sibling, insertar después de él
      const dateField = rowContainer.parentElement?.querySelector('[data-sa-rdo-field="true"]');
      if (dateField) {
        dateField.insertAdjacentElement('afterend', wrapper);
      } else {
        rowContainer.insertAdjacentElement('afterend', wrapper);
      }
    } else {
      anchorWrapper.insertAdjacentElement('afterend', wrapper);
    }

    // Stash refs en el state
    const state = modalStates.get(modal) || {};
    state.combo = combo;
    state.input = input;
    state.clearBtn = clearBtn;
    state.dropdown = dropdown;
    modalStates.set(modal, state);

    console.log(LOG_PREFIX, 'Combobox de ubicación inyectado');
  }
```

- [ ] **Step 3.2: Llamar `injectStyles()` y `injectField()` desde `onModalFound`**

Modificar el cuerpo de `onModalFound` para incluir las llamadas:

```js
  function onModalFound(modal) {
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      fullCache: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    watchModalRemoval(modal);
  }
```

- [ ] **Step 3.3: Bump version a `0.5.71`**

- [ ] **Step 3.4: Test manual — verificar el combobox visible**

Deploy + reload. Abrir el modal Receive Parts y verificar:

1. Aparece un renglón "Ubicación inicial:" debajo del campo de fecha (o debajo de Receiver Comments si el date applet está apagado).
2. El input tiene placeholder "Buscar ubicación (filtro: Aduana)".
3. El botón ✕ no aparece todavía (hidden hasta que haya selección).
4. Click en el input no hace nada todavía (dropdown no se abre — se implementa en task siguiente).

- [ ] **Step 3.5: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): UI shell del combobox del header (0.5.71)"
```

Sync a `gh-pages` y push.

---

## Task 4: Carga de ubicaciones via SearchLocationsOnPath

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.72`)

- [ ] **Step 4.1: Agregar `fetchAduanaLocations()` y `fetchAllLocations()` antes de `injectField()`**

```js
  async function fetchAduanaLocations() {
    if (!api()) {
      console.warn(LOG_PREFIX, 'SteelheadAPI no disponible');
      return [];
    }
    try {
      const data = await api().query('SearchLocationsOnPath', {
        fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
        path: '', searchText: '%Aduana%', offset: 0, first: 100,
        subpathOffset: 0, searchTextLast: '%Aduana%',
        archivedIsNull: true, isEmpty: false, includeTypes: true
      }, 'SearchLocationsOnPath');
      return data?.searchLocationsOnPath?.nodes || [];
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error cargando ubicaciones Aduana:', err);
      throw err;
    }
  }

  async function fetchAllLocations(offset = 0, first = 200) {
    if (!api()) {
      console.warn(LOG_PREFIX, 'SteelheadAPI no disponible');
      return [];
    }
    try {
      const data = await api().query('SearchLocationsOnPath', {
        fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
        path: '', searchText: '', offset, first,
        subpathOffset: 0, searchTextLast: '',
        archivedIsNull: true, isEmpty: false, includeTypes: true
      }, 'SearchLocationsOnPath');
      return data?.searchLocationsOnPath?.nodes || [];
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error cargando catálogo completo de ubicaciones:', err);
      throw err;
    }
  }
```

- [ ] **Step 4.2: Cargar `aduanaCache` al detectar el modal**

Modificar `onModalFound` para disparar la carga inicial:

```js
  function onModalFound(modal) {
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      fullCache: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    watchModalRemoval(modal);
    preloadAduana(modal);
  }

  async function preloadAduana(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    try {
      const nodes = await fetchAduanaLocations();
      state.aduanaCache = nodes;
      console.log(LOG_PREFIX, `Aduana precargada: ${nodes.length} ubicaciones`);
    } catch {
      state.aduanaCache = [];
    }
  }
```

- [ ] **Step 4.3: Bump version a `0.5.72`**

- [ ] **Step 4.4: Test manual — verificar la carga**

Deploy + reload. Abrir el modal Receive Parts y verificar en consola:

1. `[WLP] Modal de recibo detectado`
2. Pocos segundos después: `[WLP] Aduana precargada: N ubicaciones` (con N > 0 si Ecoplating tiene ubicaciones Aduana, lo cual debería).
3. Inspeccionar el WeakMap con: en consola, ejecutar `Array.from(document.querySelectorAll('[data-sa-wlp-attached="true"]'))[0]` para ver el modal element. (No podemos inspeccionar el WeakMap directamente, pero el log confirma la carga.)

- [ ] **Step 4.5: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): precarga de ubicaciones Aduana al abrir modal (0.5.72)"
```

Sync a `gh-pages` y push.

---

## Task 5: Dropdown del combobox + typeahead + selección

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.73`)

- [ ] **Step 5.1: Agregar `wireCombobox(modal)` y helpers de render del dropdown**

Insertar dentro de la IIFE, antes de `return { init };`:

```js
  function renderDropdown(state) {
    const dd = state.dropdown;
    dd.innerHTML = '';
    const cache = state.aduanaFilterActive ? state.aduanaCache : state.fullCache;
    const search = (state.input.value || '').trim().toLowerCase();

    if (!cache) {
      const empty = document.createElement('div');
      empty.className = 'sa-wlp-option-empty';
      empty.textContent = 'Cargando ubicaciones…';
      dd.appendChild(empty);
      return;
    }

    const filtered = search
      ? cache.filter(loc => (loc.path || '').toLowerCase().includes(search)
                         || (loc.name || '').toLowerCase().includes(search))
      : cache.slice();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sa-wlp-option-empty';
      empty.textContent = state.aduanaFilterActive
        ? "No se encontraron ubicaciones con 'Aduana'"
        : 'Sin matches';
      dd.appendChild(empty);
    } else {
      for (const loc of filtered) {
        const opt = document.createElement('div');
        opt.className = 'sa-wlp-option';
        opt.textContent = loc.path || loc.name || `(id ${loc.id})`;
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectLocation(state, loc);
        });
        dd.appendChild(opt);
      }
    }

    if (state.aduanaFilterActive) {
      const sentinel = document.createElement('div');
      sentinel.className = 'sa-wlp-option-sentinel';
      sentinel.textContent = '🔄 Mostrar todas las ubicaciones';
      sentinel.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        state.aduanaFilterActive = false;
        if (!state.fullCache) {
          state.input.placeholder = 'Cargando catálogo completo…';
          try {
            state.fullCache = await fetchAllLocations();
          } catch {
            state.fullCache = [];
          }
          state.input.placeholder = 'Buscar ubicación';
        }
        renderDropdown(state);
      });
      dd.appendChild(sentinel);
    }
  }

  function selectLocation(state, loc) {
    state.selectedLocation = { id: loc.id, path: loc.path || loc.name };
    state.input.value = state.selectedLocation.path;
    state.clearBtn.hidden = false;
    state.dropdown.hidden = true;
    console.log(LOG_PREFIX, `Ubicación seleccionada: id=${loc.id} path=${loc.path}`);
    onSelectionChange(state);
  }

  function clearSelection(state) {
    state.selectedLocation = null;
    state.input.value = '';
    state.clearBtn.hidden = true;
    state.aduanaFilterActive = true;
    state.input.placeholder = 'Buscar ubicación (filtro: Aduana)';
    console.log(LOG_PREFIX, 'Ubicación limpiada');
    onSelectionChange(state);
  }

  // Stub — se implementa en Task 6 (disabling de combos per-line)
  function onSelectionChange(state) {
    // Hook para Task 6 — por ahora no-op
  }

  function wireCombobox(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    const { input, clearBtn, dropdown, combo } = state;

    input.addEventListener('focus', () => {
      dropdown.hidden = false;
      renderDropdown(state);
    });
    input.addEventListener('input', () => {
      if (state.selectedLocation) {
        // El usuario está editando — invalidar selección
        state.selectedLocation = null;
        clearBtn.hidden = true;
      }
      dropdown.hidden = false;
      renderDropdown(state);
    });
    input.addEventListener('blur', () => {
      // Pequeño delay para permitir click en option (mousedown corre antes que blur)
      setTimeout(() => { dropdown.hidden = true; }, 150);
    });
    clearBtn.addEventListener('click', () => clearSelection(state));

    // Cerrar dropdown si click fuera — guardamos el listener para cleanup
    const docClickHandler = (e) => {
      if (!combo.contains(e.target)) dropdown.hidden = true;
    };
    document.addEventListener('mousedown', docClickHandler);
    state.docClickHandler = docClickHandler;
  }
```

- [ ] **Step 5.2: Actualizar `cleanupModal` para remover el listener de `document`**

Reemplazar la función `cleanupModal` definida en Task 2 por:

```js
  function cleanupModal(modal) {
    const state = modalStates.get(modal);
    if (state?.removalObserver) state.removalObserver.disconnect();
    if (state?.rowObserver) state.rowObserver.disconnect();
    if (state?.docClickHandler) document.removeEventListener('mousedown', state.docClickHandler);
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }
```

- [ ] **Step 5.3: Llamar `wireCombobox(modal)` desde `onModalFound`**

```js
  function onModalFound(modal) {
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      fullCache: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    wireCombobox(modal);
    watchModalRemoval(modal);
    preloadAduana(modal);
  }
```

- [ ] **Step 5.4: Bump version a `0.5.73`**

- [ ] **Step 5.5: Test manual — UX completa del combobox**

Deploy + reload. Abrir modal Receive Parts y probar:

1. Click en el input → dropdown se abre, muestra ubicaciones Aduana + sentinel "Mostrar todas".
2. Escribir "Toluca" (o el substring que sea) → filtra client-side.
3. Click en una opción → input muestra el path completo, ✕ aparece, dropdown se cierra. Console: `[WLP] Ubicación seleccionada: id=N path=...`.
4. Click en ✕ → input se limpia, ✕ se oculta, placeholder vuelve. Console: `[WLP] Ubicación limpiada`.
5. Re-click en input → dropdown reabre con filtro Aduana otra vez (estado reseteado).
6. Click en sentinel "Mostrar todas" → dropdown muestra el catálogo completo, sentinel desaparece. Si el catálogo es grande puede tardar 1-2s mientras carga.
7. Click fuera del combobox → dropdown se cierra.

- [ ] **Step 5.6: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): dropdown con typeahead + sentinel Mostrar todas (0.5.73)"
```

Sync a `gh-pages` y push.

---

## Task 6: Disabling de los combos per-line via overlay CSS

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.74`)

- [ ] **Step 6.1: Agregar `findLocationCombos`, `disableCombo`, `enableCombo`**

Insertar dentro de la IIFE, antes de `wireCombobox`:

```js
  function findLocationCombos(modal) {
    const combos = [];
    const placeholders = modal.querySelectorAll('[id^="react-select-"][id$="-placeholder"]');
    for (const p of placeholders) {
      const txt = p.textContent?.trim() || '';
      if (/^(?:search\s+locations|buscar\s+ubicaciones)/i.test(txt)) {
        const control = p.closest('[class*="-control"]');
        if (control) combos.push(control);
      }
    }
    return combos;
  }

  function disableCombo(control, locationPath) {
    if (control.dataset.saWlpDisabled === 'true') {
      // Ya disabled — actualizar overlay text si la ubicación cambió
      const existing = control.querySelector('.sa-wlp-row-overlay');
      if (existing) existing.textContent = locationPath;
      return;
    }
    control.dataset.saWlpDisabled = 'true';
    control.style.pointerEvents = 'none';
    control.style.opacity = '0.55';
    control.style.position = 'relative';

    const overlay = document.createElement('div');
    overlay.className = 'sa-wlp-row-overlay';
    overlay.textContent = locationPath;
    overlay.title = 'Heredada del header. Limpia el campo de arriba para editar este renglón.';
    control.appendChild(overlay);
  }

  function enableCombo(control) {
    if (control.dataset.saWlpDisabled !== 'true') return;
    control.dataset.saWlpDisabled = 'false';
    control.style.pointerEvents = '';
    control.style.opacity = '';
    control.querySelector('.sa-wlp-row-overlay')?.remove();
  }

  function applyDisableState(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    const combos = findLocationCombos(modal);
    if (state.selectedLocation) {
      combos.forEach(c => disableCombo(c, state.selectedLocation.path));
    } else {
      combos.forEach(enableCombo);
    }
  }
```

- [ ] **Step 6.2: Reemplazar el stub `onSelectionChange` por la implementación real**

Reemplazar el cuerpo de `onSelectionChange`:

```js
  function onSelectionChange(state) {
    // Encontrar el modal asociado a este state buscando en el DOM
    const modal = document.querySelector('[data-sa-wlp-attached="true"]');
    if (!modal || modalStates.get(modal) !== state) return;
    applyDisableState(modal);
  }
```

- [ ] **Step 6.3: Agregar MutationObserver del tbody para líneas nuevas**

Agregar función `watchLineRows(modal)`:

```js
  function watchLineRows(modal) {
    const tbody = modal.querySelector('tbody.MuiTableBody-root');
    if (!tbody) {
      console.warn(LOG_PREFIX, 'No se encontró tbody.MuiTableBody-root — observer de líneas no instalado');
      return;
    }
    const observer = new MutationObserver(() => {
      // Re-aplicar el estado cuando cambian las líneas (add/remove)
      applyDisableState(modal);
    });
    observer.observe(tbody, { childList: true, subtree: true });
    const state = modalStates.get(modal);
    if (state) state.rowObserver = observer;
  }
```

Y llamarlo desde `onModalFound`:

```js
  function onModalFound(modal) {
    if (modal.dataset.saWlpAttached === 'true') return;
    modal.dataset.saWlpAttached = 'true';
    modalStates.set(modal, {
      selectedLocation: null,
      aduanaFilterActive: true,
      aduanaCache: null,
      fullCache: null,
    });
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    wireCombobox(modal);
    watchModalRemoval(modal);
    watchLineRows(modal);
    preloadAduana(modal);
  }
```

(`cleanupModal` ya disconectaba `state.rowObserver` desde Task 2.)

- [ ] **Step 6.4: Bump version a `0.5.74`**

- [ ] **Step 6.5: Test manual — disabling de combos per-line**

Deploy + reload. Abrir modal Receive Parts con al menos 2 lotes:

1. Verificar que cada lote tiene un combobox "Initial Location:" / "Search Locations..." editable.
2. En el header, elegir una ubicación. Verificar:
   - Cada combo per-line se ve atenuado (opacity 0.55).
   - Cada combo per-line muestra un overlay con el path elegido (ej. `Ecoplating.N3.A3.Aduana.Toluca`).
   - Hover sobre el overlay muestra el tooltip "Heredada del header. ...".
   - Click en cualquier combo per-line ya no abre dropdown (pointer-events: none).
3. Click en "Add Row" / "+" del modal para agregar una línea nueva. Verificar que el nuevo combo per-line también queda disabled con el overlay.
4. Click en el ✕ del combo del header. Verificar que TODOS los combos per-line vuelven a estar editables (overlay desaparece, opacity normal).
5. Re-elegir una ubicación distinta en el header. Verificar que los overlays se actualizan al nuevo path.
6. Click en "Delete Row" de un lote. El observer no debe fallar (no hay errores en consola).

- [ ] **Step 6.6: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): disabling visual de combos per-line via overlay (0.5.74)"
```

Sync a `gh-pages` y push.

---

## Task 7: Validación del shape del payload (instrumentación temporal)

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.75`)

**Objetivo:** ANTES de mutar el payload, instrumentar para capturar un dump real del body de `CreateReceiverChecked`. Confirmar el path exacto a `locationId`. Esta tarea termina con un dump compartido con el usuario, NO con un commit del código de mutación.

- [ ] **Step 7.1: Agregar `patchFetch()` con instrumentación SIN mutación**

Insertar dentro de la IIFE, antes de `return { init };`:

```js
  function patchFetch() {
    if (window.__saWlpFetchPatched) return;
    window.__saWlpFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body || typeof opts.body !== 'string') {
        return origFetch.apply(this, args);
      }

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      if (bodyObj?.operationName !== 'CreateReceiverChecked') {
        return origFetch.apply(this, args);
      }

      // Instrumentación temporal — capturar shape sin mutar
      try {
        window.__saWlpLastPayload = JSON.parse(JSON.stringify(bodyObj));
        const items = bodyObj.variables?.receiverPayload?.receiverBomItems || [];
        const summary = items.map((it, idx) => {
          const accs = it?.inventoryTransferEvent?.debitAccounts?.accounts || [];
          return {
            idx,
            accountsCount: accs.length,
            accountKeys: accs[0] ? Object.keys(accs[0]) : [],
            hasLocationId: accs.some(a => a && 'locationId' in a),
          };
        });
        console.log(LOG_PREFIX, 'CreateReceiverChecked interceptado — shape:', summary);
        console.log(LOG_PREFIX, 'Payload completo en window.__saWlpLastPayload');
      } catch (err) {
        console.warn(LOG_PREFIX, 'Error inspeccionando payload:', err);
      }

      return origFetch.apply(this, args);
    };
  }
```

- [ ] **Step 7.2: Llamar `patchFetch()` desde `init`**

```js
  function init() {
    const disabled = document.documentElement.dataset.saWarehouseLocationPrefillEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }
```

- [ ] **Step 7.3: Bump version a `0.5.75`**

- [ ] **Step 7.4: Deploy + ejecutar un recibo real**

Aplicar deploy procedure. Después:

1. Recargar extensión + abrir Steelhead.
2. Crear un receiver real de prueba (uno con al menos 2 lotes) usando el modal Receive Parts. **NO elegir ubicación en el header de WLP** (queremos que el shape llegue intacto al server).
3. Antes de hacer click en Save, abrir DevTools.
4. Click en Save y observar la consola.
5. Verificar el log `[WLP] CreateReceiverChecked interceptado — shape:` con el array de summaries (uno por lote).
6. Inspeccionar `window.__saWlpLastPayload` en consola: ejecutar `JSON.stringify(window.__saWlpLastPayload.variables.receiverPayload.receiverBomItems[0].inventoryTransferEvent.debitAccounts.accounts, null, 2)`.

- [ ] **Step 7.5: Compartir el dump con el usuario para validar el path**

Pedir al usuario que pegue el resultado del comando del step 7.4.6. Validar que:

- Cada `account` tiene una key llamada `locationId` (exactamente ese nombre).
- El valor actual es un número o `null`.
- No hay nesting adicional inesperado (ej. `account.location.id` en vez de `account.locationId`).

**Si el shape coincide:** continuar a Task 8.

**Si el shape difiere:**
- Documentar el path real (ej. `inventoryTransferEvent.creditAccounts.accounts[].locationId`, o `transferEvent.accounts[].location.id`).
- Ajustar el Task 8 al path correcto antes de implementar la mutación.
- NO commitear el código de Task 8 hasta confirmar.

- [ ] **Step 7.6: Commit la instrumentación**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "chore(warehouse-location-prefill): instrumentación temporal de payload shape (0.5.75)"
```

Sync a `gh-pages` y push.

---

## Task 8: Interceptor real (mutación del payload)

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.76`)

**Pre-requisito:** Task 7 completada y el path del payload confirmado contra el dump real. Si el path es distinto al asumido, ajustar las líneas marcadas con `⚠️` abajo.

- [ ] **Step 8.1: Reemplazar `patchFetch()` por la versión con mutación efectiva**

Reemplazar la implementación de `patchFetch()` por:

```js
  function patchFetch() {
    if (window.__saWlpFetchPatched) return;
    window.__saWlpFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body || typeof opts.body !== 'string') {
        return origFetch.apply(this, args);
      }

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      if (bodyObj?.operationName !== 'CreateReceiverChecked') {
        return origFetch.apply(this, args);
      }

      // Buscar la selección actual del header
      let targetLocationId = null;
      try {
        const modal = document.querySelector('[data-sa-wlp-attached="true"]');
        const state = modal && modalStates.get(modal);
        if (state?.selectedLocation?.id != null) {
          targetLocationId = state.selectedLocation.id;
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Error leyendo state del modal — paso through:', err);
      }

      if (targetLocationId == null) {
        return origFetch.apply(this, args);
      }

      // Mutar el payload — ⚠️ confirmar path vs dump real (Task 7)
      let mutated = 0;
      try {
        const items = bodyObj.variables?.receiverPayload?.receiverBomItems || [];
        for (const item of items) {
          const accounts = item?.inventoryTransferEvent?.debitAccounts?.accounts || [];
          for (const acc of accounts) {
            if (acc && 'locationId' in acc) {
              acc.locationId = targetLocationId;
              mutated++;
            }
          }
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Error mutando payload — paso through sin tocar:', err);
        return origFetch.apply(this, args);
      }

      if (mutated > 0) {
        const newOpts = { ...opts, body: JSON.stringify(bodyObj) };
        console.log(LOG_PREFIX, `Override de ubicación: ${mutated} accounts → ${targetLocationId}`);
        return origFetch.call(this, url, newOpts);
      }

      console.warn(LOG_PREFIX, 'Header con valor pero no se encontró locationId mutable en el payload');
      return origFetch.apply(this, args);
    };
  }
```

- [ ] **Step 8.2: Bump version a `0.5.76`**

- [ ] **Step 8.3: Test manual — E2E completo**

Deploy + reload. Crear un receiver real de prueba con varios lotes:

1. Abrir modal Receive Parts con 2-3 lotes.
2. En el header WLP, elegir una ubicación Aduana (ej. la primera que aparezca).
3. Verificar que los combos per-line muestran el overlay con esa ubicación.
4. Click en Save (o "Save and Add Parts to WO" / "Save and Print all").
5. Verificar en consola: `[WLP] Override de ubicación: N accounts → <id>`.
6. Esperar que el modal se cierre.
7. Navegar al receiver recién creado (en "All Receivers" o el redirect).
8. Verificar que cada lote del receiver tiene la ubicación correcta (ej. `Aduana.Toluca`) en su Initial Location.
9. **Caso negativo:** crear otro receiver SIN tocar el campo del header WLP. Verificar que cada lote tiene la ubicación que originalmente eligió Steelhead (probablemente vacía o default), confirmando que el interceptor no interfiere cuando el header está vacío.

- [ ] **Step 8.4: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): interceptor de CreateReceiverChecked con override real (0.5.76)"
```

Sync a `gh-pages` y push.

---

## Task 9: Edge cases — error de carga + paginación lazy

**Files:**
- Modify: `remote/scripts/warehouse-location-prefill.js`
- Modify: `remote/config.json` (bump → `0.5.77`)

- [ ] **Step 9.1: Mostrar mensaje de error con retry si `SearchLocationsOnPath` falla**

Modificar `preloadAduana` para guardar el error en el state:

```js
  async function preloadAduana(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    state.aduanaError = null;
    try {
      const nodes = await fetchAduanaLocations();
      state.aduanaCache = nodes;
      console.log(LOG_PREFIX, `Aduana precargada: ${nodes.length} ubicaciones`);
    } catch (err) {
      state.aduanaCache = [];
      state.aduanaError = err;
    }
    // Re-render si el dropdown está visible
    if (state.dropdown && !state.dropdown.hidden) renderDropdown(state);
  }
```

Y modificar `renderDropdown` para mostrar error con retry:

```js
  function renderDropdown(state) {
    const dd = state.dropdown;
    dd.innerHTML = '';
    const cache = state.aduanaFilterActive ? state.aduanaCache : state.fullCache;
    const search = (state.input.value || '').trim().toLowerCase();

    if (state.aduanaFilterActive && state.aduanaError) {
      const errEl = document.createElement('div');
      errEl.className = 'sa-wlp-option-empty';
      errEl.textContent = 'Error cargando ubicaciones';
      dd.appendChild(errEl);
      const retry = document.createElement('div');
      retry.className = 'sa-wlp-option-sentinel';
      retry.textContent = '🔄 Reintentar';
      retry.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        const modal = document.querySelector('[data-sa-wlp-attached="true"]');
        if (modal) await preloadAduana(modal);
      });
      dd.appendChild(retry);
      return;
    }

    if (!cache) {
      const empty = document.createElement('div');
      empty.className = 'sa-wlp-option-empty';
      empty.textContent = 'Cargando ubicaciones…';
      dd.appendChild(empty);
      return;
    }

    const filtered = search
      ? cache.filter(loc => (loc.path || '').toLowerCase().includes(search)
                         || (loc.name || '').toLowerCase().includes(search))
      : cache.slice();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sa-wlp-option-empty';
      empty.textContent = state.aduanaFilterActive
        ? "No se encontraron ubicaciones con 'Aduana'"
        : 'Sin matches';
      dd.appendChild(empty);
    } else {
      for (const loc of filtered) {
        const opt = document.createElement('div');
        opt.className = 'sa-wlp-option';
        opt.textContent = loc.path || loc.name || `(id ${loc.id})`;
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectLocation(state, loc);
        });
        dd.appendChild(opt);
      }
    }

    if (state.aduanaFilterActive) {
      const sentinel = document.createElement('div');
      sentinel.className = 'sa-wlp-option-sentinel';
      sentinel.textContent = '🔄 Mostrar todas las ubicaciones';
      sentinel.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        state.aduanaFilterActive = false;
        if (!state.fullCache) {
          state.input.placeholder = 'Cargando catálogo completo…';
          try {
            state.fullCache = await fetchAllLocations();
          } catch {
            state.fullCache = [];
          }
          state.input.placeholder = 'Buscar ubicación';
        }
        renderDropdown(state);
      });
      dd.appendChild(sentinel);
    }
  }
```

- [ ] **Step 9.2: Paginación lazy del catálogo completo**

Modificar la rama del sentinel para implementar paginación cuando `fullCache` ya alcanzó 200 nodos:

(Reemplazar la sección del sentinel con la siguiente, manteniendo el resto del `renderDropdown`):

```js
    if (state.aduanaFilterActive) {
      const sentinel = document.createElement('div');
      sentinel.className = 'sa-wlp-option-sentinel';
      sentinel.textContent = '🔄 Mostrar todas las ubicaciones';
      sentinel.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        state.aduanaFilterActive = false;
        if (!state.fullCache) {
          state.input.placeholder = 'Cargando catálogo completo…';
          try {
            state.fullCache = await fetchAllLocations(0, 200);
            state.fullCacheOffset = state.fullCache.length;
            state.fullCacheExhausted = state.fullCache.length < 200;
          } catch {
            state.fullCache = [];
            state.fullCacheExhausted = true;
          }
          state.input.placeholder = 'Buscar ubicación';
        }
        renderDropdown(state);
      });
      dd.appendChild(sentinel);
    } else if (!state.fullCacheExhausted) {
      const more = document.createElement('div');
      more.className = 'sa-wlp-option-sentinel';
      more.textContent = '⬇️ Cargar más';
      more.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        try {
          const next = await fetchAllLocations(state.fullCacheOffset || 0, 200);
          state.fullCache = (state.fullCache || []).concat(next);
          state.fullCacheOffset = state.fullCache.length;
          state.fullCacheExhausted = next.length < 200;
        } catch {
          state.fullCacheExhausted = true;
        }
        renderDropdown(state);
      });
      dd.appendChild(more);
    }
```

- [ ] **Step 9.3: Bump version a `0.5.77`**

- [ ] **Step 9.4: Test manual — edge cases**

Deploy + reload. Probar:

1. **Error simulado:** en DevTools, en la pestaña Network, agregar un block para `/graphql` (o desactivar el internet brevemente). Abrir el modal Receive Parts y click en el input del combobox. Verificar que aparece "Error cargando ubicaciones" + botón "🔄 Reintentar". Click en Reintentar después de restaurar la conexión → carga las ubicaciones.

2. **Paginación lazy:** click en sentinel "Mostrar todas". Si el catálogo total > 200 ubicaciones, verificar que aparece un sentinel "⬇️ Cargar más" al final del dropdown. Click en él → carga la siguiente página y agrega al dropdown.

3. **Catálogo pequeño:** si el catálogo es ≤200 ubicaciones, verificar que NO aparece "Cargar más" (porque `fullCacheExhausted = true`).

- [ ] **Step 9.5: Commit + deploy**

```bash
git add remote/scripts/warehouse-location-prefill.js remote/config.json
git commit -m "feat(warehouse-location-prefill): error retry + paginación lazy del catálogo (0.5.77)"
```

Sync a `gh-pages` y push.

---

## Task 10: Update CLAUDE.md + final commit

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 10.1: Mover el applet de "Próximo planeado" a "Implementado"**

En `CLAUDE.md`, eliminar la sección completa "## Próximo applet planeado: `warehouse-location-prefill`" (con todo el sub-contenido). En su lugar, agregar una nueva sub-sección a la documentación de applets implementados, después de la sección de `receiver-date-override`, con el siguiente contenido:

```markdown
### `warehouse-location-prefill`: lecciones 0.5.69 → 0.5.77
Applet hermano de `receiver-date-override` que inyecta un combobox "Ubicación inicial:" en el header del modal Receive Parts. Al elegir una ubicación, **intercepta `CreateReceiverChecked` y sobrescribe `locationId` en todos los `receiverBomItems[].inventoryTransferEvent.debitAccounts.accounts[]`** antes de enviar al server. Default del combobox filtra solo ubicaciones con "Aduana" en el path; sentinel "Mostrar todas" da escape al catálogo completo con paginación lazy.

- **Disabling visual de combos per-line via overlay CSS**, no `disabled` attribute. React-select re-renderea agresivamente y pierde el `disabled` en el next render; un overlay sobre `.css-qpe0ht-control` con `pointer-events: none` + opacity sobrevive ciclos de React. Limita clicks pero no impide cambios programáticos — la garantía dura es el interceptor del payload.
- **Identificación de combos per-line por placeholder text, no por adjacencia DOM ni por `aria-label`.** El placeholder `Search Locations...` es bilingüe-tolerante (regex `/^(?:search\s+locations|buscar\s+ubicaciones)/i`) y descarta automáticamente los otros combos del lote (Sales Order, Quote, Part Group, Container Type) que tienen placeholders distintos.
- **Patrón "intercept-and-mutate" puro** (a diferencia de `receiver-date-override` que requiere follow-up `UpdateReceiver` porque el server siempre setea `receivedAt = NOW()`). Aquí el server SÍ acepta `locationId` en el create, así que la mutación va en el body original, sin follow-up. Más limpio y atómico.
- **Coexistencia con `receiver-date-override`**: cada applet patcha `window.fetch` con su propio guard (`window.__saWlpFetchPatched`). Como modifican campos distintos del mismo body (`receivedAt` vs `locationId`), se cadenan sin chocar. El último que parchó es el primero en correr, ambos llaman `origFetch` al final, un solo POST al server.
- **Validación del shape del payload con instrumentación temporal antes de la mutación real (Task 7 del plan).** Capturé `window.__saWlpLastPayload` en una corrida real para confirmar que `variables.receiverPayload.receiverBomItems[].inventoryTransferEvent.debitAccounts.accounts[].locationId` existe con ese nombre exacto antes de hardcodearlo en el interceptor. Lección reforzada del ciclo `process-canon` (0.5.52-56): no escribir mutaciones a ciegas — capturar el shape con un log + dump primero.
- **Combobox custom (vanilla HTML/CSS), no react-select.** Las lecciones de `invoice-autofill` son claras: react-select pelea contra programmatic value setters y requiere keystroke-by-keystroke con cancellation tokens. Para un combobox que controlamos nosotros desde cero, mucho más simple es construirlo a mano con `<input>` + `<div class="dropdown">` y manejar el state explícito.
```

- [ ] **Step 10.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): warehouse-location-prefill — mover de planeado a implementado + lecciones"
```

Push a `main` (no requiere deploy a `gh-pages` porque CLAUDE.md no afecta runtime).

---

## Self-review checklist (al terminar todas las tareas)

- [ ] Ejecutar el caso completo: abrir modal con 5 lotes, elegir Aduana, agregar línea nueva, cambiar Aduana, eliminar línea, guardar. Confirmar en el receiver creado que TODOS los lotes (incluyendo los modificados) tienen la ubicación final.
- [ ] Verificar coexistencia con `receiver-date-override`: ambos applets ON, llenar fecha custom Y ubicación, guardar, confirmar en el receiver que ambos overrides aplicaron.
- [ ] Verificar que apagar el toggle WLP desde el popup deshabilita el applet en cargas posteriores (recargar la página). Mientras un modal ya está abierto, los rows ya disabled quedan disabled hasta que se cierre — comportamiento aceptado documentado.
- [ ] Verificar que el toggle de `receiver-date-override` sigue funcionando independientemente.
- [ ] No hay errores ni warnings de WLP en consola durante uso normal.
