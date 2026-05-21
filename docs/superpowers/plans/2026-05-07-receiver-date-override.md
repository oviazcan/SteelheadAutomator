# Receiver Date Override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inyectar un campo `Fecha real de recibido:` en el encabezado del modal "Receive Parts from Customer" de Steelhead, para que el usuario pueda editar `receivedAt` desde el mismo modal sin tener que ir después a AllReceivers a corregirlo.

**Architecture:** Applet vanilla JS standalone que (1) detecta el modal vía `MutationObserver` (mismo patrón que `weight-quick-entry`), (2) inyecta un wrapper `.css-iyrxkt` clonando el patrón de Receiver Comments con `<input type="date">` + chips "Hoy"/"Ayer" + warning inline, y (3) intercepta `window.fetch` para swappear `receivedAt` en el body de la mutación `UpdateReceiver` solo si el usuario tocó el campo. Sin llamadas extra a la API.

**Tech Stack:** JavaScript vanilla, Chrome Extension MV3, Apollo Persisted Queries (SHA256 — solo intercept), DOM MutationObserver.

**Spec:** [`docs/superpowers/specs/2026-05-07-receiver-date-override-design.md`](../specs/2026-05-07-receiver-date-override-design.md)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `remote/scripts/receiver-date-override.js` | **Crear** — Script principal: observer, DOM injection del campo + chips + warning, fetch interceptor del UpdateReceiver, cleanup |
| `remote/config.json` | **Modificar** — Bump version a `0.5.64`, agregar app entry `receiver-date-override`, hash de `UpdateReceiver` en `steelhead.hashes.mutations`, entrada en `knownOperations` |
| `extension/background.js` | **Modificar** — Agregar `'scripts/receiver-date-override.js': 'ReceiverDateOverride'` al map de globals + dos handlers (`toggle-receiver-date-override`, `get-receiver-date-override-status`) |
| `extension/content.js` | **Modificar** — Propagar el flag `receiverDateOverrideEnabled` al MAIN world vía `dataset.saReceiverDateOverrideEnabled` (initial + onChanged) |

---

### Task 1: Agregar app, hash y knownOperation a config.json

**Files:**
- Modify: `remote/config.json` — bump `version` y `lastUpdated` arriba; agregar entry en `apps[]`; agregar hash en `steelhead.hashes.mutations`; agregar entry en `knownOperations`

- [ ] **Step 1: Bump `version` y `lastUpdated`**

En `remote/config.json`, cambiar:

```json
"version": "0.5.63",
```
a:
```json
"version": "0.5.64",
```

Y `"lastUpdated"` al string ISO de hoy (`2026-05-07`).

- [ ] **Step 2: Agregar hash de mutation**

Dentro de `steelhead.hashes.mutations`, agregar:

```json
"UpdateReceiver": "005653bae4baad289db47d65857cc4e9fb89fa51e06caa78a1f0946dce7f92ec"
```

(Aunque solo lo interceptamos y nunca lo llamamos directo, lo registramos por si otro applet lo necesita en el futuro.)

- [ ] **Step 3: Agregar app entry**

Dentro del array `apps`, agregar después de la entrada de `weight-quick-entry`:

```json
{
  "id": "receiver-date-override",
  "name": "Fecha de Recibo",
  "subtitle": "Editar fecha real de recibo desde el modal de Receive Parts",
  "icon": "📅",
  "category": "Recibo",
  "scripts": ["scripts/receiver-date-override.js"],
  "autoInject": true,
  "requiredPermissions": ["READ_RECEIVING"],
  "actions": [
    { "id": "toggle-receiver-date-override", "label": "Fecha de Recibo", "sublabel": "Editar fecha real desde el modal", "icon": "📅", "type": "toggle", "handler": "message", "message": "toggle-receiver-date-override" }
  ]
}
```

- [ ] **Step 4: Agregar knownOperation**

Dentro de `knownOperations`, agregar (cerca de las demás Receiver-related si las hay; si no, al final):

```json
"UpdateReceiver": { "type": "mutation", "description": "Actualizar receiver (id, notes, receivedAt, customInputs, inputSchemaId)", "usedBy": "receiver-date-override (intercept-only)" }
```

- [ ] **Step 5: Verificar JSON válido**

Run:
```bash
python3 -c "import json; json.load(open('remote/config.json')); print('OK')"
```
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add remote/config.json
git commit -m "feat(receiver-date-override): agregar app entry, hash y knownOperation a config.json + bump 0.5.64"
```

---

### Task 2: Registrar global y toggle handlers en background.js

**Files:**
- Modify: `extension/background.js:56-68` (objeto `globals`)
- Modify: `extension/background.js:1024-1035` (después del bloque `Weight Quick Entry`, agregar bloque `Receiver Date Override`)

- [ ] **Step 1: Agregar mapping al objeto globals**

En `extension/background.js`, dentro del objeto `globals` (línea ~56-68), agregar después de la línea de `'scripts/sensor-status-autofill.js': 'SensorStatusAutofill'`:

```javascript
'scripts/receiver-date-override.js': 'ReceiverDateOverride'
```

El bloque queda (las últimas 2 entradas y el cierre):

```javascript
          'scripts/sensor-status-autofill.js': 'SensorStatusAutofill',
          'scripts/receiver-date-override.js': 'ReceiverDateOverride' };
```

- [ ] **Step 2: Agregar handlers de toggle y status**

Después del bloque `// ── Weight Quick Entry ──` (línea ~1024-1035), antes del bloque `// ── CFDI Attacher ──`, insertar:

```javascript
    // ── Receiver Date Override ──
    case 'toggle-receiver-date-override': {
      const { receiverDateOverrideEnabled } = await chrome.storage.local.get('receiverDateOverrideEnabled');
      const newState = receiverDateOverrideEnabled === false;
      await chrome.storage.local.set({ receiverDateOverrideEnabled: newState });
      return { enabled: newState, message: newState ? 'Fecha de Recibo habilitado' : 'Fecha de Recibo deshabilitado' };
    }

    case 'get-receiver-date-override-status': {
      const { receiverDateOverrideEnabled } = await chrome.storage.local.get('receiverDateOverrideEnabled');
      return { enabled: receiverDateOverrideEnabled !== false };
    }

```

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat(receiver-date-override): registrar global ReceiverDateOverride + toggle handlers en background.js"
```

---

### Task 3: Propagar flag al MAIN world en content.js

**Files:**
- Modify: `extension/content.js:15-31` (sección de propagación de flags)

- [ ] **Step 1: Agregar propagación inicial**

En `extension/content.js`, después del bloque de `weightQuickEntryEnabled` (líneas 15-19), insertar:

```javascript
  // Communicate Receiver Date Override enabled state to MAIN world
  chrome.storage.local.get('receiverDateOverrideEnabled', (data) => {
    const enabled = data.receiverDateOverrideEnabled !== false;
    document.documentElement.dataset.saReceiverDateOverrideEnabled = enabled;
  });

```

- [ ] **Step 2: Agregar listener de cambios**

Dentro del listener `chrome.storage.onChanged.addListener` (líneas 22-31), agregar después del bloque de `weightQuickEntryEnabled`:

```javascript
    if (changes.receiverDateOverrideEnabled) {
      const enabled = changes.receiverDateOverrideEnabled.newValue !== false;
      document.documentElement.dataset.saReceiverDateOverrideEnabled = enabled;
    }
```

- [ ] **Step 3: Commit**

```bash
git add extension/content.js
git commit -m "feat(receiver-date-override): propagar flag al MAIN world via dataset"
```

---

### Task 4: Crear esqueleto del script con init, observer y detección del modal

**Files:**
- Create: `remote/scripts/receiver-date-override.js`

- [ ] **Step 1: Crear el archivo con el esqueleto completo**

Crear `remote/scripts/receiver-date-override.js`:

```javascript
// Receiver Date Override
// Inyecta un campo "Fecha real de recibido:" en el modal de Receive Parts
// Intercepta UpdateReceiver para swappear receivedAt cuando el usuario toca el campo
// No depende de SteelheadAPI (solo intercept de fetch nativo)

const ReceiverDateOverride = (() => {
  'use strict';

  const LOG_PREFIX = '[RDO]';
  let observerActive = false;

  // modal element → { input, warningEl, userTouched, removalObserver }
  const modalStates = new WeakMap();

  function init() {
    const disabled = document.documentElement.dataset.saReceiverDateOverrideEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── MutationObserver: detect Receive Parts modal ──

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

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
    if (modal.dataset.saRdoAttached) return;
    modal.dataset.saRdoAttached = 'true';
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
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
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  // ── Placeholder functions (implementadas en tareas siguientes) ──

  function patchFetch() {}
  function injectStyles() {}
  function injectField(modal) {}

  return { init };
})();

if (typeof window !== 'undefined') {
  window.ReceiverDateOverride = ReceiverDateOverride;
  ReceiverDateOverride.init();
}
```

- [ ] **Step 2: Verificar sintaxis**

Run:
```bash
node -c remote/scripts/receiver-date-override.js
```
Expected: (sin output = OK)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/receiver-date-override.js
git commit -m "feat(receiver-date-override): esqueleto con init, observer y detección de modal"
```

---

### Task 5: Implementar inyección de estilos

**Files:**
- Modify: `remote/scripts/receiver-date-override.js` (reemplazar placeholder `injectStyles`)

- [ ] **Step 1: Reemplazar placeholder injectStyles**

En `remote/scripts/receiver-date-override.js`, reemplazar:

```javascript
  function injectStyles() {}
```

con:

```javascript
  function injectStyles() {
    if (document.getElementById('sa-rdo-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-rdo-styles';
    style.textContent = `
      .sa-rdo-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .sa-rdo-input {
        border: 1px solid #c4c4c4;
        border-radius: 4px;
        padding: 8.5px 14px;
        font: inherit;
        font-size: 14px;
        background: #fff;
        color: rgba(0,0,0,0.87);
      }
      .sa-rdo-input:focus {
        outline: 2px solid #1976d2;
        outline-offset: -1px;
        border-color: transparent;
      }
      .sa-rdo-chip {
        border: 1px solid rgba(25,118,210,0.5);
        color: #1976d2;
        background: transparent;
        border-radius: 16px;
        padding: 4px 12px;
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
      }
      .sa-rdo-chip:hover {
        background: rgba(25,118,210,0.08);
        border-color: #1976d2;
      }
      .sa-rdo-warning {
        flex-basis: 100%;
        margin-top: 4px;
        font-size: 12px;
        color: #ed6c02;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run:
```bash
node -c remote/scripts/receiver-date-override.js
```
Expected: (sin output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/receiver-date-override.js
git commit -m "feat(receiver-date-override): inyectar estilos del campo, chips y warning"
```

---

### Task 6: Implementar inyección del campo, chips y tracking userTouched

**Files:**
- Modify: `remote/scripts/receiver-date-override.js` (reemplazar placeholder `injectField` y agregar helper `updateWarning` + `todayString`)

- [ ] **Step 1: Agregar helper `todayString` antes del placeholder `injectField`**

En `remote/scripts/receiver-date-override.js`, justo antes de la línea `function injectField(modal) {}`, insertar:

```javascript
  function todayString(offsetDays = 0) {
    const d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function daysDiff(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    if (!y || !m || !d) return null;
    const picked = new Date(y, m - 1, d, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((picked.getTime() - today.getTime()) / 86400000);
  }

  function updateWarning(state) {
    const el = state.warningEl;
    if (!el) return;
    const val = state.input.value;
    if (!val) { el.hidden = true; el.textContent = ''; return; }
    const diff = daysDiff(val);
    if (diff === null) { el.hidden = true; el.textContent = ''; return; }
    if (diff > 0) {
      el.textContent = '⚠️ Fecha de recibo en el futuro';
      el.hidden = false;
    } else if (diff < -7) {
      el.textContent = '⚠️ Fecha real de recibo mayor a una semana';
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }
```

- [ ] **Step 2: Reemplazar placeholder injectField**

Reemplazar:

```javascript
  function injectField(modal) {}
```

con:

```javascript
  function injectField(modal) {
    // Localizar el wrapper de "Receiver Comments:" via su <p>
    const labels = modal.querySelectorAll('p');
    let receiverCommentsWrapper = null;
    for (const p of labels) {
      if (/^receiver\s+comments:?$/i.test(p.textContent.trim())) {
        receiverCommentsWrapper = p.closest('.css-iyrxkt');
        break;
      }
    }
    if (!receiverCommentsWrapper) {
      console.warn(LOG_PREFIX, 'No se localizó el wrapper de Receiver Comments — layout cambió?');
      return;
    }

    // Construir el wrapper nuevo clonando estructura .css-iyrxkt
    const wrapper = document.createElement('div');
    wrapper.className = 'css-iyrxkt sa-rdo-wrapper';
    wrapper.dataset.saRdoField = 'true';

    const label = document.createElement('p');
    label.className = 'MuiTypography-root MuiTypography-body1 css-9l3uo3';
    label.style.gridColumn = '1';
    label.textContent = 'Fecha real de recibido:';
    wrapper.appendChild(label);

    const controls = document.createElement('div');
    controls.style.gridColumn = '2';
    controls.className = 'sa-rdo-controls';

    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'sa-rdo-input';
    input.value = todayString(0);
    controls.appendChild(input);

    const chipHoy = document.createElement('button');
    chipHoy.type = 'button';
    chipHoy.className = 'sa-rdo-chip';
    chipHoy.dataset.offset = '0';
    chipHoy.textContent = 'Hoy';
    controls.appendChild(chipHoy);

    const chipAyer = document.createElement('button');
    chipAyer.type = 'button';
    chipAyer.className = 'sa-rdo-chip';
    chipAyer.dataset.offset = '-1';
    chipAyer.textContent = 'Ayer';
    controls.appendChild(chipAyer);

    const warningEl = document.createElement('div');
    warningEl.className = 'sa-rdo-warning';
    warningEl.hidden = true;
    controls.appendChild(warningEl);

    wrapper.appendChild(controls);
    receiverCommentsWrapper.insertAdjacentElement('afterend', wrapper);

    // Estado por modal
    const state = { input, warningEl, userTouched: false, removalObserver: null };
    modalStates.set(modal, state);

    // Tracking de intención
    const markTouched = () => { state.userTouched = true; updateWarning(state); };
    input.addEventListener('input', markTouched);
    input.addEventListener('change', markTouched);

    for (const chip of [chipHoy, chipAyer]) {
      chip.addEventListener('click', () => {
        const offset = parseInt(chip.dataset.offset, 10);
        input.value = todayString(offset);
        markTouched();
      });
    }

    console.log(LOG_PREFIX, 'Campo de fecha inyectado, default=', input.value);
  }
```

- [ ] **Step 3: Verificar sintaxis**

Run:
```bash
node -c remote/scripts/receiver-date-override.js
```
Expected: (sin output)

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/receiver-date-override.js
git commit -m "feat(receiver-date-override): inyectar campo de fecha, chips Hoy/Ayer y warnings inline"
```

---

### Task 7: Implementar interceptor de UpdateReceiver

**Files:**
- Modify: `remote/scripts/receiver-date-override.js` (reemplazar placeholder `patchFetch`)

- [ ] **Step 1: Reemplazar placeholder patchFetch**

En `remote/scripts/receiver-date-override.js`, reemplazar:

```javascript
  function patchFetch() {}
```

con:

```javascript
  function patchFetch() {
    if (window.__saRdoFetchPatched) return;
    window.__saRdoFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      if (bodyObj?.operationName === 'UpdateReceiver') {
        const modal = document.querySelector('[data-sa-rdo-attached="true"]');
        const state = modal && modalStates.get(modal);
        if (state?.userTouched && state.input.value) {
          const [y, m, d] = state.input.value.split('-').map(Number);
          if (y && m && d) {
            const iso = new Date(y, m - 1, d, 12, 0, 0).toISOString();
            const prev = bodyObj.variables?.receivedAt;
            if (bodyObj.variables) {
              bodyObj.variables.receivedAt = iso;
              opts.body = JSON.stringify(bodyObj);
              console.log(LOG_PREFIX, `receivedAt swapped: ${prev} → ${iso}`);
            }
          }
        }
      }

      return origFetch.apply(this, args);
    };
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run:
```bash
node -c remote/scripts/receiver-date-override.js
```
Expected: (sin output)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/receiver-date-override.js
git commit -m "feat(receiver-date-override): interceptar UpdateReceiver y swappear receivedAt cuando userTouched"
```

---

### Task 8: Smoke tests manuales en navegador

**Pre-requisitos:**
- Cargar la extensión sin deploy a `gh-pages` aún. Para esto, en `chrome://extensions`, recargar la extensión y forzar que use el `main` branch local. Si la extensión productiva fetchea de `gh-pages`, hacer un sideload temporal desde `extension/` apuntado a un servidor local (`python3 -m http.server` en la carpeta de scripts) o, alternativamente, hacer el deploy primero en una rama de prueba y completar el smoke test después. Documentar qué método se usa.

**Casos a probar (todos en consola del navegador con DevTools abierto):**

- [ ] **Caso 1: Smoke — el campo aparece**

1. Abrir `app.gosteelhead.com` y navegar a "Receive Parts from Customer".
2. Verificar en consola: `[RDO] Inicializado`.
3. Verificar en consola: `[RDO] Modal de recibo detectado`.
4. Verificar en consola: `[RDO] Campo de fecha inyectado, default= YYYY-MM-DD` (fecha de hoy).
5. Verificar visualmente que el campo aparece **debajo** de "Receiver Comments:" con label "Fecha real de recibido:" + input fecha + chips "Hoy" "Ayer".

Expected: 5/5 OK.

- [ ] **Caso 2: Save sin tocar el campo**

1. Modal abierto, sin tocar el campo de fecha.
2. Llenar cantidades como en un recibo normal.
3. Click en "Save" (no Save+otra cosa).
4. En consola, verificar que NO aparece `receivedAt swapped`.
5. Después del Save, ir a `/AllReceivers` y abrir el receiver recién creado.
6. Verificar que `Received At` corresponde a hoy + hora exacta del Save (no mediodía).

Expected: receivedAt = ahora exacto (sin swap).

- [ ] **Caso 3: Click chip "Ayer" + Save**

1. Modal abierto, click en chip "Ayer".
2. Verificar que el input muestra fecha de ayer (`YYYY-MM-(DD-1)`).
3. Click "Save".
4. En consola: `[RDO] receivedAt swapped: <iso original> → <iso ayer mediodía local>`.
5. En AllReceivers, abrir el receiver. `Received At` = ayer mediodía local.

Expected: swap exitoso, fecha = ayer.

- [ ] **Caso 4: Picker fecha vieja + warning**

1. Modal abierto, click en input fecha, elegir una fecha de hace 10+ días.
2. Verificar que aparece warning inline: `⚠️ Fecha real de recibo mayor a una semana`.
3. Click "Save". Save debe proceder normal (warning no bloquea).
4. Verificar en consola el swap.
5. En AllReceivers, fecha = la elegida.

Expected: warning visible, save no bloqueado, fecha persistida.

- [ ] **Caso 5: Fecha futura + warning**

1. Modal abierto, elegir una fecha futura (mañana o más).
2. Verificar warning inline: `⚠️ Fecha de recibo en el futuro`.
3. Click "Save". Procede normal.
4. Verificar swap en consola y persistencia en AllReceivers.

Expected: warning visible, save no bloqueado, fecha persistida.

- [ ] **Caso 6: Los 3 botones Save**

Repetir Caso 3 con cada uno de los 3 botones:
- "Save" → swap OK.
- "Save and Add Parts to WO" → swap OK + transición a la siguiente vista.
- "Save and Print all" → swap OK + se imprime el PDF con la fecha correcta.

Expected: los 3 hacen swap.

- [ ] **Caso 7: Convivencia con Weight Quick Entry**

1. Modal abierto.
2. Llenar pesos (Weight Quick Entry) en una o dos líneas.
3. Click chip "Ayer".
4. Click "Save".
5. Verificar logs `[WQE]` y `[RDO]` ambos disparan sin pelearse.
6. En AllReceivers, fecha = ayer; en el detalle del part number, las conversiones de unidad están registradas.

Expected: ambos applets funcionan en el mismo Save.

- [ ] **Caso 8: Cleanup al cerrar modal**

1. Modal abierto, sin guardar, click en "Cancel" o cerrar el modal.
2. En consola: `[RDO] Modal cleanup completado`.
3. Volver a abrir el modal de recibo.
4. Verificar que el campo aparece de nuevo con default = hoy (no quedó pegado al state anterior).

Expected: cleanup limpio + re-inyección OK.

- [ ] **Si algún caso falla:** documentar el síntoma exacto, commit del fix, repetir el caso fallido.

---

### Task 9: Deploy a gh-pages

**Files:**
- Sync: `remote/scripts/receiver-date-override.js` → `gh-pages:scripts/receiver-date-override.js`
- Sync: `remote/config.json` → `gh-pages:config.json`

**Pre-requisito:** todos los casos de Task 8 pasaron en local.

- [ ] **Step 1: Verificar que estamos en `main` con todo committeado**

Run:
```bash
git status
git branch --show-current
```
Expected: `On branch main` + `working tree clean`.

- [ ] **Step 2: Cambiar a `gh-pages` y traer archivos desde `main`**

```bash
git checkout gh-pages
git checkout main -- remote/scripts/receiver-date-override.js
mv remote/scripts/receiver-date-override.js scripts/
git checkout main -- remote/config.json
mv remote/config.json config.json
rmdir remote/scripts remote 2>/dev/null || true
```

Esto materializa los archivos de `main` con la estructura aplanada que `gh-pages` usa (`scripts/foo.js` y `config.json` en root), siguiendo el procedimiento del CLAUDE.md ("el usuario hace switch de rama y copia manualmente").

- [ ] **Step 3: Verificar sync byte-a-byte**

```bash
git diff main:remote/scripts/receiver-date-override.js HEAD:scripts/receiver-date-override.js
git diff main:remote/config.json HEAD:config.json
```
Expected: ambos vacíos (sin diff).

- [ ] **Step 4: Stage, commit y push**

```bash
git add scripts/receiver-date-override.js config.json
git commit -m "deploy: receiver-date-override applet + bump 0.5.64"
git push origin gh-pages
git checkout main
git push origin main
```

- [ ] **Step 5: Esperar publicación de GitHub Pages (~30-60s) y verificar en producción**

1. Esperar 60 segundos.
2. Recargar la extensión: `chrome://extensions` → reload SteelheadAutomator.
3. Recargar Steelhead (`Cmd+R`) en la pestaña.
4. En consola: `[RDO] Inicializado` debe aparecer.
5. Repetir Caso 1 de Task 8 (smoke) en producción para confirmar.

Expected: applet vivo en producción.

---

## Notas operativas

- **No hay tests unitarios automatizados en este proyecto.** Todo el verification es smoke test manual en el navegador (Task 8). Esto es por la naturaleza del applet (DOM injection sobre un app de terceros) y consistente con los demás applets del repo.
- **Si Steelhead cambia las clases CSS** (`.css-iyrxkt`, `.css-9l3uo3`): el `injectField` no encuentra el wrapper de Receiver Comments y registra warning en consola. El comportamiento de Steelhead queda intacto. Fix futuro: re-pedir wrapper HTML al usuario y actualizar el localizador.
- **Si Steelhead cambia el hash de `UpdateReceiver`**: el interceptor sigue funcionando porque filtra por `operationName`, no por hash. Solo fallaría si Steelhead renombrara la operación.
- **No requiere agregar el handler de toggle al popup**: el patrón `autoInject + actions[].handler: "message"` ya genera el toggle automáticamente desde la config (mismo patrón que Weight Quick Entry).
