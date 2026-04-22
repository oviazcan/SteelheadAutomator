# Weight Quick Entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inyectar campos de peso KG/LB en el modal de Receive Parts de Steelhead para registrar mediciones de peso sin clicks adicionales.

**Architecture:** Nuevo script `weight-quick-entry.js` que usa MutationObserver para detectar el modal nativo de Steelhead e inyectar campos DOM con `createElement`. Intercepta fetch para cachear `inventoryItemId` del PN y ejecuta mediciones vía `GetAvailableUnits` + `Create/UpdateInventoryItemUnitConversion`. Auto-inject en page load.

**Tech Stack:** JavaScript vanilla, Chrome Extension MV3, Apollo Persisted Queries (SHA256), DOM MutationObserver

---

## File Structure

| File | Responsibility |
|------|---------------|
| `remote/scripts/weight-quick-entry.js` | **Crear** — Script principal: observer, DOM injection, fetch intercept, GraphQL mutations |
| `remote/config.json` | **Modificar** — Agregar app entry, 3 hashes nuevos (2 mutations + 1 query), 3 knownOperations |
| `extension/background.js` | **Modificar** — Agregar `'scripts/weight-quick-entry.js': 'WeightQuickEntry'` al mapa de globals |

---

### Task 1: Agregar hashes y app a config.json

**Files:**
- Modify: `remote/config.json:13-60` (hashes section)
- Modify: `remote/config.json:386-387` (after last app, before `knownOperations`)
- Modify: `remote/config.json:486-487` (knownOperations, before closing brace)

- [ ] **Step 1: Agregar hashes de mutations**

En `remote/config.json`, dentro de `steelhead.hashes.mutations`, agregar estas dos entradas después de `CreateMaintenanceEventUserFile`:

```json
"CreateInventoryItemUnitConversion": "769411466c537c059cf6fc1721e116dc42ff1d88e3a72879cc94444329a1f334",
"UpdateInventoryItemUnitConversion": "ffc8db6cd8edaa9355b904fac38f8e5fc116ce1d597f076026c38ef09420a16c"
```

- [ ] **Step 2: Agregar hash de query**

En `remote/config.json`, dentro de `steelhead.hashes.queries`, agregar después de `AllPermissionsEditManyPermissions`:

```json
"GetAvailableUnits": "405368babb953708532627a930e5ea1a1ca21e5518a5f0f4d8cd0757880c43c0"
```

- [ ] **Step 3: Agregar app entry**

En `remote/config.json`, dentro del array `apps`, agregar después del último app (`paros-linea`, línea ~386):

```json
{
  "id": "weight-quick-entry",
  "name": "Peso Rápido",
  "subtitle": "Registra peso KG/LB desde el modal de recibo",
  "icon": "⚖️",
  "category": "Recibo",
  "scripts": ["scripts/steelhead-api.js", "scripts/weight-quick-entry.js"],
  "autoInject": true,
  "requiredPermissions": ["READ_RECEIVING"],
  "actions": [
    { "id": "toggle-weight-quick-entry", "label": "Peso Rápido", "sublabel": "Campos de peso en modal de recibo", "icon": "⚖️", "type": "toggle", "handler": "message", "message": "toggle-weight-quick-entry" }
  ]
}
```

- [ ] **Step 4: Agregar knownOperations**

En `remote/config.json`, dentro de `knownOperations`, agregar después de `AllPermissionsEditManyPermissions`:

```json
"GetAvailableUnits": { "type": "query", "description": "Obtener unidades disponibles y conversiones existentes de un inventory item", "usedBy": "weight-quick-entry" },
"CreateInventoryItemUnitConversion": { "type": "mutation", "description": "Crear conversión de unidad nueva para un inventory item (unitId + factor)", "usedBy": "weight-quick-entry" },
"UpdateInventoryItemUnitConversion": { "type": "mutation", "description": "Actualizar factor de conversión existente de un inventory item", "usedBy": "weight-quick-entry" }
```

- [ ] **Step 5: Verificar JSON válido**

Run: `python3 -c "import json; json.load(open('remote/config.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add remote/config.json
git commit -m "feat(weight-quick-entry): agregar hashes, app y knownOperations a config.json"
```

---

### Task 2: Agregar global mapping en background.js

**Files:**
- Modify: `extension/background.js:56-62`

- [ ] **Step 1: Agregar mapping**

En `extension/background.js`, dentro del objeto `globals` (línea ~62), agregar después de la entrada `'scripts/paros-linea.js': 'ParosLinea'`:

```javascript
'scripts/weight-quick-entry.js': 'WeightQuickEntry'
```

La línea 62 quedará:
```javascript
          'scripts/paros-linea.js': 'ParosLinea',
          'scripts/weight-quick-entry.js': 'WeightQuickEntry' };
```

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat(weight-quick-entry): registrar global WeightQuickEntry en background.js"
```

---

### Task 3: Crear esqueleto del script con init y MutationObserver

**Files:**
- Create: `remote/scripts/weight-quick-entry.js`

- [ ] **Step 1: Crear el archivo con esqueleto funcional**

Crear `remote/scripts/weight-quick-entry.js` con el IIFE completo, init, y MutationObserver que detecta el modal "Receive Parts From Customer":

```javascript
// Weight Quick Entry
// Inyecta campos de peso KG/LB en el modal de Receive Parts
// Ejecuta mediciones via CreateInventoryItemUnitConversion / UpdateInventoryItemUnitConversion
// Depends on: SteelheadAPI

const WeightQuickEntry = (() => {
  'use strict';

  const LOG_PREFIX = '[WQE]';
  const api = () => window.SteelheadAPI;
  let observerActive = false;
  let modalObserver = null;

  // Cache: partNumberId → inventoryItemId (populated by fetch interceptor)
  const inventoryItemCache = new Map();

  // Track injected line instances: DOM node → state object
  const lineStates = new Map();

  function init() {
    const disabled = document.documentElement.dataset.saWeightQuickEntryEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── MutationObserver: detect Receive Parts modal ──

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          checkForReceiveModal(node);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // One-time check for already-present modal
    const existing = document.querySelector('[role="dialog"], .MuiDialog-paper');
    if (existing) checkForReceiveModal(existing);
  }

  function checkForReceiveModal(node) {
    const heading = node.querySelector?.('h2, h3, h4, h5, h6');
    if (heading && /receive\s+parts\s+from\s+customer/i.test(heading.textContent)) {
      onModalFound(node);
      return;
    }
    const dialog = node.querySelector?.('[role="dialog"], .MuiDialog-paper');
    if (dialog) {
      const h = dialog.querySelector('h2, h3, h4, h5, h6');
      if (h && /receive\s+parts\s+from\s+customer/i.test(h.textContent)) {
        onModalFound(dialog);
      }
    }
  }

  function onModalFound(modal) {
    if (modal.dataset.saWqeAttached) return;
    modal.dataset.saWqeAttached = 'true';
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    processExistingLines(modal);
    observeNewLines(modal);
    interceptSaveButtons(modal);
  }

  // ── Placeholder functions (implemented in subsequent tasks) ──

  function patchFetch() {}
  function injectStyles() {}
  function processExistingLines(modal) {}
  function observeNewLines(modal) {}
  function interceptSaveButtons(modal) {}

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WeightQuickEntry = WeightQuickEntry;
  WeightQuickEntry.init();
}
```

- [ ] **Step 2: Verificar que no hay errores de sintaxis**

Run: `node -c remote/scripts/weight-quick-entry.js`
Expected: (no output = syntax OK)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/weight-quick-entry.js
git commit -m "feat(weight-quick-entry): esqueleto con init, observer y detección de modal"
```

---

### Task 4: Implementar fetch interceptor para cachear inventoryItemId

**Files:**
- Modify: `remote/scripts/weight-quick-entry.js` (replace `patchFetch` placeholder)

- [ ] **Step 1: Implementar patchFetch**

Reemplazar la función `patchFetch` placeholder con la implementación completa. Esta función intercepta las respuestas de `ReceivingPartsPartNumbersQuery` para cachear el mapping `partNumberId → inventoryItemId`:

```javascript
  function patchFetch() {
    if (window.__saWqeFetchPatched) return;
    window.__saWqeFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      const response = await origFetch.apply(this, args);

      if (bodyObj?.operationName === 'ReceivingPartsPartNumbersQuery') {
        try {
          const clone = response.clone();
          const json = await clone.json();
          const nodes = json?.data?.allPartNumbers?.nodes || [];
          for (const pn of nodes) {
            const invItem = pn.inventoryItemByPartNumberId;
            if (pn.id && invItem?.id) {
              inventoryItemCache.set(pn.id, invItem.id);
            }
          }
          if (nodes.length > 0) {
            console.log(LOG_PREFIX, `Cacheados ${nodes.length} inventoryItemIds`);
          }
        } catch (err) {
          console.warn(LOG_PREFIX, 'Error cacheando inventoryItemIds:', err);
        }
      }

      return response;
    };
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/weight-quick-entry.js`
Expected: (no output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/weight-quick-entry.js
git commit -m "feat(weight-quick-entry): fetch interceptor para cachear inventoryItemId"
```

---

### Task 5: Implementar estilos CSS inyectados

**Files:**
- Modify: `remote/scripts/weight-quick-entry.js` (replace `injectStyles` placeholder)

- [ ] **Step 1: Implementar injectStyles**

Reemplazar la función `injectStyles` placeholder. Los estilos cubren los 5 estados: vacío, pendiente, ejecutando, registrado, error:

```javascript
  function injectStyles() {
    if (document.getElementById('sa-wqe-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-wqe-styles';
    style.textContent = `
      .sa-wqe-container {
        border: 2px dashed #ccc;
        border-radius: 8px;
        padding: 10px 14px;
        margin-top: 8px;
        background: #fafafa;
        transition: border-color 0.2s, background 0.2s;
      }
      .sa-wqe-container[data-state="pending"] {
        border-color: #e74c3c;
        border-style: dashed;
        background: #fef9f9;
      }
      .sa-wqe-container[data-state="executing"] {
        border-color: #ff9800;
        background: #fff8e1;
        pointer-events: none;
        opacity: 0.7;
      }
      .sa-wqe-container[data-state="done"] {
        border-color: #4CAF50;
        border-style: solid;
        background: #f6fef6;
      }
      .sa-wqe-container[data-state="error"] {
        border-color: #f44336;
        border-style: solid;
        background: #fef0f0;
      }
      .sa-wqe-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .sa-wqe-fields {
        display: flex;
        gap: 12px;
        align-items: flex-end;
      }
      .sa-wqe-field label {
        display: block;
        font-size: 11px;
        color: #666;
        margin-bottom: 3px;
      }
      .sa-wqe-field input {
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 6px 8px;
        width: 80px;
        font-size: 14px;
        font-family: inherit;
      }
      .sa-wqe-field input:disabled {
        background: #f5f5f5;
        color: #999;
      }
      .sa-wqe-field input.sa-wqe-preview {
        color: #999;
        background: #f9f9f9;
      }
      .sa-wqe-btn {
        background: none;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 4px 6px;
        cursor: pointer;
        font-size: 12px;
        color: #e74c3c;
        line-height: 1;
      }
      .sa-wqe-btn:hover { background: #fef0f0; }
      .sa-wqe-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .sa-wqe-hint {
        margin-top: 5px;
        font-size: 10px;
        color: #888;
      }
      .sa-wqe-status {
        font-size: 11px;
        margin-left: 8px;
      }
    `;
    document.head.appendChild(style);
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/weight-quick-entry.js`
Expected: (no output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/weight-quick-entry.js
git commit -m "feat(weight-quick-entry): estilos CSS para estados de campos de peso"
```

---

### Task 6: Implementar detección de líneas y creación de campos DOM

**Files:**
- Modify: `remote/scripts/weight-quick-entry.js` (replace `processExistingLines` and `observeNewLines` placeholders)

- [ ] **Step 1: Implementar funciones de detección e inyección de líneas**

Reemplazar `processExistingLines` y `observeNewLines` placeholders. Además agregar las funciones helper `findQuantitySection`, `injectWeightFields`, y `getCountValue`:

```javascript
  function processExistingLines(modal) {
    const sections = findQuantitySections(modal);
    for (const section of sections) {
      injectWeightFields(section, modal);
    }
  }

  function observeNewLines(modal) {
    if (modalObserver) modalObserver.disconnect();
    modalObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const sections = findQuantitySections(node);
          for (const section of sections) {
            injectWeightFields(section, modal);
          }
        }
      }
    });
    modalObserver.observe(modal, { childList: true, subtree: true });
  }

  function findQuantitySections(container) {
    const results = [];
    // "Quantity" is a column header; each line has Unit + Count under it.
    // We look for labels/text "Count:" followed by an input.
    const labels = container.querySelectorAll('label, span, p, div');
    for (const label of labels) {
      if (label.textContent.trim() !== 'Count:') continue;
      // The Count input is the next sibling or within the same parent
      const parent = label.closest('div') || label.parentElement;
      const input = parent?.querySelector('input[type="text"], input[type="number"], input:not([type])');
      if (input && !input.closest('.sa-wqe-container')) {
        results.push({ countLabel: label, countInput: input, countParent: parent });
      }
    }
    return results;
  }

  function getCountValue(countInput) {
    const val = parseFloat(countInput?.value);
    return isNaN(val) || val <= 0 ? 0 : val;
  }

  function getUnitValue(section) {
    // Walk up to find the Unit dropdown/input near the Count field
    const lineContainer = section.countLabel.closest('[class*="Part"]')
      || section.countLabel.closest('tr')
      || section.countLabel.parentElement?.parentElement?.parentElement;
    if (!lineContainer) return '';
    const unitLabels = lineContainer.querySelectorAll('label, span, p, div');
    for (const ul of unitLabels) {
      if (ul.textContent.trim() !== 'Unit:') continue;
      const unitParent = ul.closest('div') || ul.parentElement;
      const unitInput = unitParent?.querySelector('input');
      return unitInput?.value?.trim() || '';
    }
    return '';
  }

  function getPartNumberId(section) {
    // Walk up to find the PN select/input in the same line
    const lineContainer = section.countLabel.closest('[class*="Part"]')
      || section.countLabel.closest('tr')
      || section.countLabel.parentElement?.parentElement?.parentElement?.parentElement;
    if (!lineContainer) return null;
    // Look for the "View" link which contains the PN name, or the PN select input
    const viewLink = lineContainer.querySelector('a[href*="part-numbers/"]');
    if (viewLink) {
      const match = viewLink.href.match(/part-numbers\/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  function injectWeightFields(section, modal) {
    // Don't inject twice
    if (section.countParent.querySelector('.sa-wqe-container')) return;

    // Don't inject if Unit is not blank/Count (user selected KGM or another unit)
    const unitVal = getUnitValue(section);
    if (unitVal && unitVal !== 'Count') return;

    const container = document.createElement('div');
    container.className = 'sa-wqe-container';
    container.dataset.state = 'empty';

    // Header
    const header = document.createElement('div');
    header.className = 'sa-wqe-header';
    const headerLabel = document.createElement('span');
    headerLabel.style.color = '#e74c3c';
    headerLabel.textContent = '\u26A1 Peso r\u00e1pido';
    const headerSub = document.createElement('span');
    headerSub.style.cssText = 'font-weight:400; color:#999; font-size:10px;';
    headerSub.textContent = '(SteelheadAutomator)';
    header.appendChild(headerLabel);
    header.appendChild(headerSub);

    // Status indicator (appended to header later)
    const statusSpan = document.createElement('span');
    statusSpan.className = 'sa-wqe-status';
    header.appendChild(statusSpan);

    container.appendChild(header);

    // Fields row
    const fieldsRow = document.createElement('div');
    fieldsRow.className = 'sa-wqe-fields';

    // KG field
    const kgField = createWeightField('KG', section, container, statusSpan, modal);
    fieldsRow.appendChild(kgField.wrapper);

    // LB field
    const lbField = createWeightField('LB', section, container, statusSpan, modal);
    fieldsRow.appendChild(lbField.wrapper);

    container.appendChild(fieldsRow);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'sa-wqe-hint';
    hint.textContent = 'Tab para registrar \u00b7 Factor: peso \u00f7 count';
    container.appendChild(hint);

    // Insert after countParent
    section.countParent.insertAdjacentElement('afterend', container);

    // Cross-field interaction: typing in one shows preview in the other
    const KGM_TO_LBR = api()?.getDomain?.()?.conversions?.KGM_TO_LBR || 2.20462;
    kgField.input.addEventListener('input', () => {
      const kgVal = parseFloat(kgField.input.value);
      if (!isNaN(kgVal) && kgVal > 0) {
        lbField.input.value = (kgVal * KGM_TO_LBR).toFixed(2);
        lbField.input.classList.add('sa-wqe-preview');
        lbField.input.disabled = true;
        container.dataset.state = 'pending';
      } else {
        lbField.input.value = '';
        lbField.input.classList.remove('sa-wqe-preview');
        lbField.input.disabled = false;
        if (!kgField.input.value && !lbField.input.value) container.dataset.state = 'empty';
      }
    });

    lbField.input.addEventListener('input', () => {
      const lbVal = parseFloat(lbField.input.value);
      if (!isNaN(lbVal) && lbVal > 0) {
        kgField.input.value = (lbVal / KGM_TO_LBR).toFixed(3);
        kgField.input.classList.add('sa-wqe-preview');
        kgField.input.disabled = true;
        container.dataset.state = 'pending';
      } else {
        kgField.input.value = '';
        kgField.input.classList.remove('sa-wqe-preview');
        kgField.input.disabled = false;
        if (!kgField.input.value && !lbField.input.value) container.dataset.state = 'empty';
      }
    });

    // Store line state
    const state = {
      container,
      kgInput: kgField.input,
      lbInput: lbField.input,
      statusSpan,
      section,
      status: 'empty' // empty | pending | executing | done | error
    };
    lineStates.set(container, state);

    // Watch for Unit dropdown changes (hide if user selects a non-Count unit)
    watchUnitChanges(section, container);

    // Watch for Count changes (invalidate done state)
    section.countInput.addEventListener('input', () => {
      if (state.status === 'done') {
        state.status = 'pending';
        container.dataset.state = 'pending';
        statusSpan.textContent = '\u23F3 Recalcular';
        statusSpan.style.color = '#ff9800';
        kgField.input.readOnly = false;
        lbField.input.readOnly = false;
      }
    });
  }

  function createWeightField(unit, section, container, statusSpan, modal) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sa-wqe-field';

    const label = document.createElement('label');
    label.textContent = `Peso cliente ${unit}:`;
    wrapper.appendChild(label);

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex; align-items:center; gap:4px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = unit === 'KG' ? 'ej: 25' : 'ej: 55';
    input.setAttribute('data-unit', unit);

    // Eager trigger: blur/Tab
    input.addEventListener('blur', () => {
      if (input.value && !input.classList.contains('sa-wqe-preview')) {
        executeMeasurement(container);
      }
    });

    inputRow.appendChild(input);

    // Manual trigger button
    const btn = document.createElement('button');
    btn.className = 'sa-wqe-btn';
    btn.textContent = '\u26A1';
    btn.title = 'Registrar ahora';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      executeMeasurement(container);
    });
    inputRow.appendChild(btn);

    wrapper.appendChild(inputRow);
    return { wrapper, input, btn };
  }

  function watchUnitChanges(section, container) {
    const lineContainer = section.countLabel.closest('[class*="Part"]')
      || section.countLabel.closest('tr')
      || section.countLabel.parentElement?.parentElement?.parentElement;
    if (!lineContainer) return;

    const unitObserver = new MutationObserver(() => {
      const unitVal = getUnitValue(section);
      if (unitVal && unitVal !== 'Count') {
        container.style.display = 'none';
      } else {
        container.style.display = '';
      }
    });
    unitObserver.observe(lineContainer, { childList: true, subtree: true, characterData: true });
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/weight-quick-entry.js`
Expected: (no output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/weight-quick-entry.js
git commit -m "feat(weight-quick-entry): detección de líneas, inyección de campos DOM y cross-field"
```

---

### Task 7: Implementar lógica de ejecución de mediciones (GraphQL)

**Files:**
- Modify: `remote/scripts/weight-quick-entry.js` (add `executeMeasurement` function)

- [ ] **Step 1: Implementar executeMeasurement**

Agregar la función `executeMeasurement` y sus helpers dentro del IIFE, antes del `return { init }`:

```javascript
  async function executeMeasurement(container) {
    const state = lineStates.get(container);
    if (!state) return;
    if (state.status === 'executing' || state.status === 'done') return;

    const count = getCountValue(state.section.countInput);
    if (count <= 0) {
      setStatus(state, 'error', 'Count debe ser > 0');
      return;
    }

    // Determine which field has the primary value (not preview)
    const kgVal = parseFloat(state.kgInput.value);
    const lbVal = parseFloat(state.lbInput.value);
    const kgIsPrimary = !state.kgInput.classList.contains('sa-wqe-preview');

    let weightKG;
    if (kgIsPrimary && !isNaN(kgVal) && kgVal > 0) {
      weightKG = kgVal;
    } else if (!isNaN(lbVal) && lbVal > 0) {
      const KGM_TO_LBR = api()?.getDomain?.()?.conversions?.KGM_TO_LBR || 2.20462;
      weightKG = lbVal / KGM_TO_LBR;
    } else {
      return; // No weight entered, skip silently
    }

    // Get inventoryItemId
    const pnId = getPartNumberId(state.section);
    let inventoryItemId = pnId ? inventoryItemCache.get(pnId) : null;

    if (!inventoryItemId) {
      setStatus(state, 'error', 'PN no resuelto');
      return;
    }

    setStatus(state, 'executing', 'Registrando...');

    try {
      const domain = api().getDomain();
      const KGM_TO_LBR = domain?.conversions?.KGM_TO_LBR || 2.20462;
      const unitIdKGM = domain?.unitIds?.KGM || 3969;
      const unitIdLBR = domain?.unitIds?.LBR || 3972;

      const factorKGM = weightKG / count;
      const factorLBR = (weightKG * KGM_TO_LBR) / count;

      // Get existing conversions
      const unitsData = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
      const existingConversions = unitsData?.inventoryItemById
        ?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];

      // Process KGM
      await upsertConversion(existingConversions, unitIdKGM, inventoryItemId, factorKGM);
      // Process LBR
      await upsertConversion(existingConversions, unitIdLBR, inventoryItemId, factorLBR);

      // Update UI
      state.kgInput.value = weightKG.toFixed(3);
      state.kgInput.readOnly = true;
      const lbEquiv = weightKG * KGM_TO_LBR;
      state.lbInput.value = lbEquiv.toFixed(2);
      state.lbInput.readOnly = true;
      state.lbInput.classList.add('sa-wqe-preview');

      const factorText = `${factorKGM.toFixed(4)} kg/pz \u00b7 ${factorLBR.toFixed(4)} lb/pz`;
      setStatus(state, 'done', factorText);
      console.log(LOG_PREFIX, `Medici\u00f3n registrada: inventoryItem=${inventoryItemId} ${factorText}`);

    } catch (err) {
      console.error(LOG_PREFIX, 'Error registrando medici\u00f3n:', err);
      setStatus(state, 'error', err.message || 'Error de red');
    }
  }

  async function upsertConversion(existingConversions, unitId, inventoryItemId, factor) {
    const existing = existingConversions.find(c => {
      const cUnitId = c.unitByUnitId?.id;
      return cUnitId === unitId;
    });

    if (existing) {
      await api().query('UpdateInventoryItemUnitConversion',
        { id: existing.id, factor },
        'UpdateInventoryItemUnitConversion'
      );
    } else {
      await api().query('CreateInventoryItemUnitConversion',
        { unitId, inventoryItemId, factor },
        'CreateInventoryItemUnitConversion'
      );
    }
  }

  function setStatus(state, status, message) {
    state.status = status;
    state.container.dataset.state = status;
    if (status === 'done') {
      state.statusSpan.textContent = '\u2705 ' + message;
      state.statusSpan.style.color = '#4CAF50';
    } else if (status === 'error') {
      state.statusSpan.textContent = '\u274C ' + message;
      state.statusSpan.style.color = '#f44336';
    } else if (status === 'executing') {
      state.statusSpan.textContent = '\u23F3 ' + message;
      state.statusSpan.style.color = '#ff9800';
    } else if (status === 'pending') {
      state.statusSpan.textContent = '\u23F3 pendiente';
      state.statusSpan.style.color = '#999';
    } else {
      state.statusSpan.textContent = '';
    }
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/weight-quick-entry.js`
Expected: (no output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/weight-quick-entry.js
git commit -m "feat(weight-quick-entry): lógica de ejecución de mediciones GraphQL (create/update)"
```

---

### Task 8: Implementar intercepción de botones SAVE

**Files:**
- Modify: `remote/scripts/weight-quick-entry.js` (replace `interceptSaveButtons` placeholder)

- [ ] **Step 1: Implementar interceptSaveButtons**

Reemplazar la función `interceptSaveButtons` placeholder:

```javascript
  function interceptSaveButtons(modal) {
    const observer = new MutationObserver(() => {
      const buttons = modal.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toUpperCase() || '';
        const isSaveBtn = text.includes('SAVE') && !text.includes('CANCEL');
        if (isSaveBtn && !btn.dataset.saWqeIntercepted) {
          btn.dataset.saWqeIntercepted = 'true';
          btn.addEventListener('click', handleSaveClick, true); // capture phase
        }
      }
    });
    observer.observe(modal, { childList: true, subtree: true });

    // Initial scan
    const buttons = modal.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toUpperCase() || '';
      const isSaveBtn = text.includes('SAVE') && !text.includes('CANCEL');
      if (isSaveBtn && !btn.dataset.saWqeIntercepted) {
        btn.dataset.saWqeIntercepted = 'true';
        btn.addEventListener('click', handleSaveClick, true);
      }
    }
  }

  async function handleSaveClick(e) {
    // Find all pending measurements
    const pending = [];
    for (const [container, state] of lineStates) {
      if (state.status === 'pending') {
        const hasKg = state.kgInput.value && !state.kgInput.classList.contains('sa-wqe-preview');
        const hasLb = state.lbInput.value && !state.lbInput.classList.contains('sa-wqe-preview');
        if (hasKg || hasLb) {
          pending.push(container);
        }
      }
    }

    if (pending.length === 0) return; // Let SAVE proceed normally

    console.log(LOG_PREFIX, `Procesando ${pending.length} mediciones pendientes antes de SAVE`);

    // Execute all pending measurements (don't block SAVE on failure)
    const results = await Promise.allSettled(
      pending.map(container => executeMeasurement(container))
    );

    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      console.warn(LOG_PREFIX, `${failed}/${pending.length} mediciones fallaron, SAVE continúa`);
    }
    // Don't preventDefault — let SAVE continue regardless
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/weight-quick-entry.js`
Expected: (no output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/weight-quick-entry.js
git commit -m "feat(weight-quick-entry): intercepción de botones SAVE para procesar pendientes"
```

---

### Task 9: Bump config version y commit final

**Files:**
- Modify: `remote/config.json:2-3` (version + lastUpdated)

- [ ] **Step 1: Bump version**

En `remote/config.json`, cambiar:
- `"version": "0.4.39"` → `"version": "0.4.40"`
- `"lastUpdated": "2026-04-16"` → `"lastUpdated": "2026-04-21"`

- [ ] **Step 2: Commit**

```bash
git add remote/config.json
git commit -m "chore(config): bump version 0.4.40 para weight-quick-entry"
```

---

### Task 10: Prueba manual end-to-end en Steelhead

**Files:** Ninguno (solo verificación)

- [ ] **Step 1: Recargar extensión**

En Chrome, ir a `chrome://extensions`, buscar SteelheadAutomator, click "Reload".

- [ ] **Step 2: Verificar inyección**

Navegar a Steelhead > Receiving > Customer Parts > RECEIVE. Verificar que:
- El modal "Receive Parts From Customer" aparece normalmente
- Debajo del campo Count se ven los campos "Peso cliente KG" y "Peso cliente LB" con borde punteado gris
- Consola muestra `[WQE] Inicializado` y `[WQE] Modal de recibo detectado`

- [ ] **Step 3: Probar medición eager**

1. Seleccionar un PN conocido
2. Poner Count = 100
3. Poner Peso KG = 25
4. Tab al siguiente campo
5. Verificar: indicador cambia a ✅, muestra "0.2500 kg/pz · 0.5512 lb/pz"
6. Verificar en Steelhead: abrir modal "Define Units" del mismo PN → confirmar que factor KGM ≈ 0.25

- [ ] **Step 4: Probar campo vacío**

Dejar campos de peso vacíos, dar SAVE. Verificar que el recibo se guarda normalmente sin interferencia.

- [ ] **Step 5: Probar + ADD PART**

Click "+ ADD PART", verificar que la nueva línea también tiene campos de peso independientes.

- [ ] **Step 6: Probar SAVE con pendientes**

Poner peso en una línea sin hacer Tab (dejarlo pendiente). Dar SAVE. Verificar en consola que se procesa antes de guardar.

- [ ] **Step 7: Probar Unit no-Count**

Cambiar Unit a "KGM Kilogramo". Verificar que los campos de peso inyectados se ocultan.
