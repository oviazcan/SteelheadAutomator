# Sensor Status Autofill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build new applet `sensor-status-autofill.js` que recorre Sensor Dashboards de Steelhead y auto-asigna `SpecFieldParam` a los members vía `UpdateSensorDashboardMember`. Soporta scope `current` (default) y `all` (toggle off por default).

**Architecture:** IIFE `SensorStatusAutofill` en `remote/scripts/sensor-status-autofill.js`. Auto-inject en URLs `/sensor-dashboards/<id>` igual que `paros-linea`. Action en popup como entrada alterna. Pull único por dashboard via `SensorDashboardQuery` (candidatos embebidos en `sensor.sensorType.specFieldsBySensorTypeId[].specFieldSpecsBySpecFieldId[].specFieldParamsBySpecFieldSpecId[]`). Mutation `UpdateSensorDashboardMember` secuencial. Modo `all` itera lista de `AllSensorDashboards` (una sola llamada, sin paginación). Sin tests automatizados — proyecto es vanilla JS sin framework de test; validamos con `node -c` syntax + smoke manual en Steelhead.

**Tech Stack:** Vanilla JS (sin frameworks), Chrome Extension MV3, Steelhead GraphQL (Apollo Persisted Queries SHA256 hash-only).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `remote/scripts/sensor-status-autofill.js` | **Create** | Applet completo: IIFE con `init`, `run`, helpers de queries, classifier, UI modales, FAB |
| `remote/config.json` | Modify | Bump `version` 0.5.56 → 0.5.57, agregar 3 hashes (`SensorDashboardQuery`, `AllSensorDashboards`, `UpdateSensorDashboardMember`), nueva action `assign-sensor-status`, nuevo app entry, agregar script al loader |
| `extension/background.js` | Modify | Agregar `'scripts/sensor-status-autofill.js'` al `globals` map (línea 56-67), nuevo `case 'assign-sensor-status'` después del `run-spec-migrator` |

---

## Pre-flight: hashes capturados (resuelto 2026-05-05)

Hashes confirmados desde `~/Downloads/scan_results_2026-05-05_112900.json`:

- `SensorDashboardQuery`: `bde56bd609a24b55ba5394d0ca65e36588b67088b90d0b358dbcac02577d2e5a`
- `AllSensorDashboards`: `432339f25bae0153d88fff64302df0bea1769987af20812c312748eb2babeedf`
- `UpdateSensorDashboardMember`: `b903749ed974d573f6167d93393e76f237634bf64ca483d25fbfaff32616f928`

Variables observadas en el scan:

- `SensorDashboardQuery`: `{ idInDomain: 122, after: "<ISO>", before: "<ISO>", measurementType: "NUMBER" }` — el persisted query requiere las 4 vars. `after`/`before` filtran mediciones, NO afectan el árbol de candidatos.
- `AllSensorDashboards`: `{}` — sin variables. Response: `{ allSensorDashboards: { nodes: [...] } }` plano, sin paginación. Esto simplifica el applet (no hace falta template-learning ni paginación).

---

### Task 1: Crear esqueleto del applet con IIFE y export global

**Files:**
- Create: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Crear archivo con IIFE skeleton**

Crea `remote/scripts/sensor-status-autofill.js` con el contenido:

```javascript
// Steelhead Sensor Status Autofill
// Auto-asigna SpecFieldParam ("Use for Status") a members de Sensor Dashboards.
// Scope: dashboard actual (default) o todos los del domain (toggle).
// Depends on: SteelheadAPI + window.REMOTE_CONFIG

const SensorStatusAutofill = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api().log(`[sensor-status] ${m}`);
  const warn = (m) => api().warn(`[sensor-status] ${m}`);

  // URL pattern del dashboard: /sensor-dashboards/<idInDomain>
  // Confirmar en implementación con la URL real del browser.
  const DASHBOARD_URL_RE = /\/sensor-dashboards\/(\d+)(?:[/?#]|$)/i;

  let state = {
    fabInstalled: false,
    running: false,
    cancelled: false,
  };

  // ── URL parsing ──
  function parseSensorDashboardFromURL() {
    const m = window.location.href.match(DASHBOARD_URL_RE);
    if (!m) return null;
    return { idInDomain: parseInt(m[1], 10) };
  }

  // ── HTML escape ──
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ── Public API placeholder ──
  async function init() {
    if (window.__saSensorStatusInitDone) return;
    window.__saSensorStatusInitDone = true;
    log(`init (v${cfg()?.version || '?'})`);
    // FAB / URL listener se cablea en Task 4
  }

  async function run() {
    if (state.running) return { error: 'Ya hay una corrida en curso' };
    log('run() llamado — orchestrator pendiente');
    return { error: 'Implementación pendiente (skeleton)' };
  }

  return { init, run };
})();

if (typeof window !== 'undefined') {
  window.SensorStatusAutofill = SensorStatusAutofill;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SensorStatusAutofill.init());
  } else {
    SensorStatusAutofill.init();
  }
}
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js`
Expected: sin output (sintaxis OK).

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): skeleton del applet con IIFE y URL parser"
```

---

### Task 2: Registrar applet en config.json (hashes, action, app entry)

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Bump version y lastUpdated**

Localiza las primeras líneas de `remote/config.json`:

```json
{
  "version": "0.5.56",
  ...
  "lastUpdated": "<fecha-anterior>",
```

Cambia `version` a `"0.5.57"` y `lastUpdated` a `"2026-05-05"`.

- [ ] **Step 2: Agregar los 3 hashes a `hashes.queries` y `hashes.mutations`**

Localiza el bloque `"queries": {` dentro de `"hashes": {`. Agrega (orden alfabético si ya está ordenado, o al final del bloque):

```json
    "AllSensorDashboards": { "type": "query", "description": "Lista plana de Sensor Dashboards del domain. Variables: {} (sin filtros, sin paginación). Response: allSensorDashboards.nodes[].", "usedBy": "sensor-status-autofill", "sha256Hash": "432339f25bae0153d88fff64302df0bea1769987af20812c312748eb2babeedf" },
    "SensorDashboardQuery": { "type": "query", "description": "Detalle de un Sensor Dashboard con members y candidatos embebidos. Variables required: { idInDomain, after, before, measurementType }. Respuesta cuelga de sensorDashboardByIdInDomain. Candidatos en sensor.sensorType.specFieldsBySensorTypeId[].specFieldSpecsBySpecFieldId[].specFieldParamsBySpecFieldSpecId[]. after/before filtran mediciones, NO el arbol de candidatos.", "usedBy": "sensor-status-autofill", "sha256Hash": "bde56bd609a24b55ba5394d0ca65e36588b67088b90d0b358dbcac02577d2e5a" },
```

**Nota:** el formato exacto (`{ "type": ..., "sha256Hash": ... }` vs string plano) depende del formato vigente en el archivo. Antes de editar, lee 3-4 entradas alrededor para copiar el shape exacto. Si las queries son strings planos (`"AllSpecs": "abc..."`), agrégalas como strings; si son objetos como en el ejemplo, usa el shape objeto.

Localiza el bloque `"mutations": {` y agrega:

```json
    "UpdateSensorDashboardMember": { "type": "mutation", "description": "Asigna activeSpecFieldParamId a un SensorDashboardMember. Variables: { id, activeSpecFieldParamId }.", "usedBy": "sensor-status-autofill", "sha256Hash": "b903749ed974d573f6167d93393e76f237634bf64ca483d25fbfaff32616f928" },
```

- [ ] **Step 3: Agregar app entry y action al popup**

Localiza el bloque `"apps": [` y agrega un objeto nuevo (al final del array, antes del `]`):

```json
    {
      "id": "sensor-status-autofill",
      "name": "Auto-asignar status (Sensor Dashboards)",
      "description": "Marca 'Use for Status' en members de un dashboard (o de todos los del domain). Auto-asigna cuando hay un solo candidato; abre modal para elegir cuando hay varios.",
      "icon": "📊",
      "scripts": [
        "scripts/steelhead-api.js",
        "scripts/sensor-status-autofill.js"
      ],
      "requiredPermissions": [],
      "actions": [
        {
          "id": "assign-sensor-status",
          "label": "Asignar status",
          "message": "assign-sensor-status"
        }
      ]
    }
```

**Nota:** el shape exacto (`requiredPermissions`, `actions[].label`, etc.) depende del formato vigente. Lee otra app entry existente (ej. `spec-migrator`) y copia su forma — cada campo debe coincidir con lo que el popup y el background esperan.

- [ ] **Step 4: Validar JSON**

Run: `python3 -m json.tool remote/config.json > /dev/null && echo OK`
Expected: `OK` (JSON válido).

Si falla, abre el archivo y revisa coma faltante o llave mal cerrada en el bloque que agregaste.

- [ ] **Step 5: Commit**

```bash
git add remote/config.json
git commit -m "chore(config): registrar sensor-status-autofill (app, action, hashes) y bump 0.5.57"
```

---

### Task 3: Wirear handler en background.js

**Files:**
- Modify: `extension/background.js:56-67` (globals map en `injectAppScripts`)
- Modify: `extension/background.js:945-958` (después del `case 'run-spec-migrator'`)

- [ ] **Step 1: Agregar entrada al globals map**

Localiza el bloque dentro de `chrome.scripting.executeScript({ ... func: (c, path, version) => { const globals = {` (alrededor de la línea 56-67). Agrega antes del cierre `};`:

```javascript
          'scripts/sensor-status-autofill.js': 'SensorStatusAutofill',
```

El bloque resultante luce así (orden no es crítico):

```javascript
          'scripts/process-canon.js': 'ProcessCanon',
          'scripts/sensor-status-autofill.js': 'SensorStatusAutofill' };
```

- [ ] **Step 2: Agregar el case handler**

Localiza el final del bloque `case 'run-spec-migrator': {`:

```javascript
    case 'run-spec-migrator': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'spec-migrator');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.SpecMigrator) return { error: 'SpecMigrator no disponible' };
          return window.SpecMigrator.run();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }
```

Inmediatamente después de su llave de cierre, inserta:

```javascript
    // ── Sensor Status Autofill ──
    case 'assign-sensor-status': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'sensor-status-autofill');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.SensorStatusAutofill) return { error: 'SensorStatusAutofill no disponible' };
          window.SensorStatusAutofill.run().then(r => console.log('[SA] sensor-status:', r)).catch(e => console.error('[SA]', e));
          return { started: true, message: 'Auto-asignación iniciada. Revisa el modal en Steelhead.' };
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node -c extension/background.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat(background): handler assign-sensor-status + globals map"
```

---

### Task 4: FAB y detección de URL

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

Reemplaza el `init()` actual del skeleton por una versión que muestra/oculta un FAB cuando la URL coincide con un dashboard. Patrón copiado de `paros-linea.js:104-120`.

- [ ] **Step 1: Agregar `injectStyles`**

Después del bloque `let state = {...}`, antes de `parseSensorDashboardFromURL`, inserta:

```javascript
  // ── Styles ──
  function injectStyles() {
    if (document.getElementById('sa-sensor-status-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-sensor-status-styles';
    style.textContent = `
      .sa-sst-fab { position: fixed; bottom: 24px; right: 24px; z-index: 999999;
        background: linear-gradient(135deg,#7c3aed,#5b21b6); color: #fff;
        border: none; border-radius: 999px; padding: 12px 18px; font-size: 13px;
        font-weight: 700; cursor: pointer; box-shadow: 0 6px 18px rgba(124,58,237,0.45);
        font-family: system-ui,-apple-system,sans-serif; display: flex; align-items: center; gap: 8px; }
      .sa-sst-fab:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(124,58,237,0.55); }
      .sa-sst-fab[disabled] { opacity: 0.6; cursor: not-allowed; }

      .sa-sst-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 1000000;
        display: flex; align-items: center; justify-content: center; font-family: system-ui,-apple-system,sans-serif; }
      .sa-sst-modal { background: #1a1a2e; color: #e2e8f0; border-radius: 12px; padding: 24px;
        min-width: 460px; max-width: 720px; box-shadow: 0 20px 60px rgba(0,0,0,0.6); }
      .sa-sst-modal h2 { margin: 0 0 12px 0; font-size: 17px; }
      .sa-sst-btnrow { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
      .sa-sst-btn { padding: 9px 18px; border-radius: 7px; border: none; font-weight: 700;
        font-size: 13px; cursor: pointer; }
      .sa-sst-btn-cancel { background: #475569; color: #f8fafc; }
      .sa-sst-btn-exec { background: #7c3aed; color: #fff; }
      .sa-sst-btn-exec[disabled] { background: #4c1d95; opacity: 0.5; cursor: not-allowed; }
      .sa-sst-progress { background: #0f172a; border-radius: 8px; padding: 14px; margin: 12px 0; }
      .sa-sst-bar { height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden; margin-top: 8px; }
      .sa-sst-bar > div { height: 100%; background: linear-gradient(90deg,#7c3aed,#a78bfa); transition: width 0.2s; }
    `;
    document.head.appendChild(style);
  }
```

- [ ] **Step 2: Reemplazar `init()` por versión que instala FAB + URL listener**

Localiza el `init()` actual (skeleton) y sustitúyelo por:

```javascript
  async function init() {
    if (window.__saSensorStatusInitDone) return;
    window.__saSensorStatusInitDone = true;
    log(`init (v${cfg()?.version || '?'})`);

    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
  }

  function syncFabVisibility() {
    const should = !!parseSensorDashboardFromURL();
    const existing = document.getElementById('sa-sst-fab-dock');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) existing.remove();
  }

  function installUrlChangeListener() {
    if (window.__saSensorStatusUrlListener) {
      window.addEventListener('sa-sst-urlchange', syncFabVisibility);
      return;
    }
    window.__saSensorStatusUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-sst-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-sst-urlchange', syncFabVisibility);
  }

  function renderFloatingButton() {
    const dock = document.createElement('div');
    dock.id = 'sa-sst-fab-dock';
    const btn = document.createElement('button');
    btn.className = 'sa-sst-fab';
    btn.innerHTML = '📊 Auto-asignar status';
    btn.addEventListener('click', () => run().catch(e => warn(`run() falló: ${e?.message || e}`)));
    dock.appendChild(btn);
    document.body.appendChild(dock);
  }
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): FAB + detección de URL del dashboard"
```

---

### Task 5: API helpers — fetchDashboard + updateMember

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Agregar helpers de API**

Inserta inmediatamente después de `escapeHtml` (antes de `init`):

```javascript
  // ── API: fetch a single dashboard ──
  async function fetchDashboard(idInDomain) {
    // El persisted query exige 4 vars (after/before/measurementType filtran
    // mediciones, no el arbol de candidatos). Defaults: ultimos 30 dias, NUMBER.
    const now = new Date();
    const before = now.toISOString();
    const after = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const data = await api().query('SensorDashboardQuery', {
      idInDomain, after, before, measurementType: 'NUMBER'
    }, 'SensorDashboardQuery');
    const dash = data?.sensorDashboardByIdInDomain;
    if (!dash) throw new Error(`Dashboard ${idInDomain} no encontrado`);
    return dash;
  }

  // ── API: update one member (assign activeSpecFieldParamId) ──
  async function updateMember(memberId, activeSpecFieldParamId) {
    return await api().query('UpdateSensorDashboardMember', {
      id: memberId,
      activeSpecFieldParamId
    }, 'UpdateSensorDashboardMember');
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): API helpers fetchDashboard + updateMember"
```

---

### Task 6: API helper — fetchAllSensorDashboards (una sola llamada)

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

El persisted query `AllSensorDashboards` toma `{}` y devuelve toda la lista del domain plana. **No hay paginación, no hay template-learning, no hay interceptor.** (Confirmado en scan_results 2026-05-05.)

- [ ] **Step 1: Agregar `fetchAllSensorDashboards`**

Inserta después de `updateMember`:

```javascript
  // ── API: list all sensor dashboards (single call, no pagination) ──
  async function fetchAllSensorDashboards() {
    const data = await api().query('AllSensorDashboards', {}, 'AllSensorDashboards');
    const nodes = data?.allSensorDashboards?.nodes || [];
    return nodes.map(n => ({
      id: n.id,
      idInDomain: n.idInDomain,
      name: n.name || `#${n.idInDomain || n.id}`,
    }));
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): fetchAllSensorDashboards (una sola llamada)"
```

---

### Task 7: Classifier — clasifica members en already/zero/auto/multi

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Agregar `classifyMembers`**

Inserta después de `fetchAllSensorDashboards`:

```javascript
  // ── Classifier: extrae candidatos y clasifica cada member ──
  function extractCandidates(member) {
    const sensor = member?.sensorBySensorId;
    const specFields = sensor?.sensorTypeBySensorTypeId?.specFieldsBySensorTypeId?.nodes || [];
    const candidates = [];
    for (const sf of specFields) {
      const sfsList = sf?.specFieldSpecsBySpecFieldId?.nodes || [];
      for (const sfs of sfsList) {
        const params = sfs?.specFieldParamsBySpecFieldSpecId?.nodes || [];
        for (const p of params) {
          candidates.push({
            id: p.id,
            name: p.name || `#${p.id}`,
            min: p.minimumValue ?? null,
            max: p.maximumValue ?? null,
            target: p.targetValue ?? null,
            specName: sfs?.specBySpecId?.name || '',
            specRevision: sfs?.specBySpecId?.revisionName || '',
            specFieldName: sfs?.specFieldBySpecFieldId?.name || sf?.specFieldBySpecFieldId?.name || '',
          });
        }
      }
    }
    return candidates;
  }

  function classifyMembers(dashboard) {
    const members = dashboard?.sensorDashboardMembersBySensorDashboardId?.nodes || [];
    const classified = members.map(m => {
      const candidates = extractCandidates(m);
      const activeId = m?.specFieldParamByActiveSpecFieldParamId?.id ?? null;
      let stateName;
      if (activeId != null) stateName = 'already';
      else if (candidates.length === 0) stateName = 'zero';
      else if (candidates.length === 1) stateName = 'auto';
      else stateName = 'multi';
      return {
        memberId: m.id,
        sensorName: m?.sensorBySensorId?.name || `#${m.id}`,
        state: stateName,
        candidates,
        activeId,
      };
    });
    return {
      already: classified.filter(c => c.state === 'already'),
      zero:    classified.filter(c => c.state === 'zero'),
      auto:    classified.filter(c => c.state === 'auto'),
      multi:   classified.filter(c => c.state === 'multi'),
    };
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): classifier de members (already/zero/auto/multi)"
```

---

### Task 8: Modal de scope (Fase 0)

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Agregar `showScopeModal`**

Inserta después de `classifyMembers`:

```javascript
  // ── Modal Fase 0: scope selection ──
  function showScopeModal({ currentRef, currentName }) {
    return new Promise((resolve) => {
      injectStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-sst-overlay';
      const md = document.createElement('div');
      md.className = 'sa-sst-modal';

      const currentLabel = currentRef
        ? `Solo este dashboard${currentName ? ` — ${escapeHtml(currentName)}` : ''}`
        : 'Solo este dashboard (no detectado en la URL)';

      md.innerHTML = `
        <h2 style="color:#a78bfa">📊 Auto-asignar status</h2>
        <p style="font-size:12px;color:#94a3b8;margin:0 0 14px 0">Marca "Use for Status" en members con un único candidato. Para members con varios candidatos abrirá un modal para que tú elijas.</p>

        <div style="margin-bottom:14px">
          <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;padding:10px 12px;background:#0f172a;border-radius:8px;${currentRef ? 'cursor:pointer' : 'opacity:0.5;cursor:not-allowed'}">
            <input type="radio" name="sa-sst-scope" value="current" ${currentRef ? 'checked' : 'disabled'}>
            <div>
              <div style="font-weight:600;color:#e2e8f0">${currentLabel}</div>
              <div style="font-size:11px;color:#94a3b8">Procesa solo el dashboard abierto.</div>
            </div>
          </label>
        </div>

        <div style="margin-bottom:14px">
          <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;padding:10px 12px;background:#0f172a;border-radius:8px;cursor:pointer">
            <input type="checkbox" id="sa-sst-allcheck">
            <div>
              <div style="font-weight:600;color:#fbbf24">Procesar TODOS los dashboards del domain</div>
              <div style="font-size:11px;color:#94a3b8">Puede tardar varios minutos. Off por default.</div>
            </div>
          </label>
        </div>

        <div class="sa-sst-btnrow">
          <button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-cancel">CANCELAR</button>
          <button class="sa-sst-btn sa-sst-btn-exec" id="sa-sst-start">INICIAR</button>
        </div>
      `;

      ov.appendChild(md);
      document.body.appendChild(ov);

      const startBtn = md.querySelector('#sa-sst-start');
      const allCheck = md.querySelector('#sa-sst-allcheck');
      const radioCurrent = md.querySelector('input[name="sa-sst-scope"]');

      const refresh = () => {
        const isAll = allCheck.checked;
        const canStart = isAll || (radioCurrent && radioCurrent.checked && !!currentRef);
        startBtn.disabled = !canStart;
      };
      allCheck.addEventListener('change', refresh);
      if (radioCurrent) radioCurrent.addEventListener('change', refresh);
      refresh();

      md.querySelector('#sa-sst-cancel').addEventListener('click', () => {
        ov.remove();
        resolve({ cancelled: true });
      });
      startBtn.addEventListener('click', () => {
        const isAll = allCheck.checked;
        ov.remove();
        if (isAll) resolve({ scope: 'all' });
        else resolve({ scope: 'current', idInDomain: currentRef.idInDomain });
      });
    });
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): modal de scope (Fase 0)"
```

---

### Task 9: Progress UI

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Agregar `showProgressUI`, `updateProgress`, `removeUI`, cancellation token**

Inserta después de `showScopeModal`:

```javascript
  // ── Progress UI ──
  function showProgressUI(title, subtitle) {
    removeUI();
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-sst-overlay';
    ov.id = 'sa-sst-progress-overlay';
    const md = document.createElement('div');
    md.className = 'sa-sst-modal';
    md.innerHTML = `
      <h2 style="color:#a78bfa" id="sa-sst-progress-title">${escapeHtml(title)}</h2>
      <div class="sa-sst-progress">
        <div id="sa-sst-progress-msg" style="font-size:13px;color:#cbd5e1">${escapeHtml(subtitle || '')}</div>
        <div id="sa-sst-progress-sub" style="font-size:11px;color:#94a3b8;margin-top:4px"></div>
        <div class="sa-sst-bar"><div id="sa-sst-progress-bar" style="width:0%"></div></div>
      </div>
      <div class="sa-sst-btnrow">
        <button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-stop">DETENER</button>
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);
    md.querySelector('#sa-sst-stop').addEventListener('click', () => {
      state.cancelled = true;
      md.querySelector('#sa-sst-stop').disabled = true;
      md.querySelector('#sa-sst-stop').textContent = 'DETENIENDO…';
    });
  }

  function updateProgress({ title, msg, sub, pct }) {
    const t = document.getElementById('sa-sst-progress-title');
    const m = document.getElementById('sa-sst-progress-msg');
    const s = document.getElementById('sa-sst-progress-sub');
    const b = document.getElementById('sa-sst-progress-bar');
    if (t && title != null) t.textContent = title;
    if (m && msg != null) m.textContent = msg;
    if (s && sub != null) s.textContent = sub;
    if (b && pct != null) b.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function removeUI() {
    const ov = document.getElementById('sa-sst-progress-overlay');
    if (ov) ov.remove();
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): progress UI con cancelación"
```

---

### Task 10: Modal asistido (≥2 candidatos)

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Agregar `showCandidatesModal`**

Inserta después de `removeUI`:

```javascript
  // ── Modal asistido para members con ≥2 candidatos ──
  function showCandidatesModal({ member, dashboardName, mode }) {
    return new Promise((resolve) => {
      injectStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-sst-overlay';
      const md = document.createElement('div');
      md.className = 'sa-sst-modal';
      md.style.maxWidth = '720px';

      const radios = member.candidates.map((c, i) => {
        const range = (c.min != null || c.max != null)
          ? `${c.min ?? ''} – ${c.max ?? ''}`
          : (c.target != null ? `target ${c.target}` : '');
        const specSuffix = [c.specName, c.specRevision].filter(Boolean).join(' · ');
        return `
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;padding:8px 10px;background:#0f172a;border-radius:6px;margin-bottom:6px;cursor:pointer">
            <input type="radio" name="sa-sst-cand" value="${c.id}" ${i === 0 ? 'checked' : ''}>
            <div>
              <div style="color:#e2e8f0;font-weight:600">${escapeHtml(c.name)}${range ? ` <span style="color:#94a3b8;font-weight:400;font-size:11px">(${escapeHtml(range)})</span>` : ''}</div>
              ${specSuffix ? `<div style="font-size:11px;color:#94a3b8">${escapeHtml(specSuffix)}</div>` : ''}
            </div>
          </label>
        `;
      }).join('');

      const skipDashboardBtn = mode === 'all'
        ? `<button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-skip-dash" style="background:#78350f;color:#fbbf24">SALTAR RESTO DE ESTE DASHBOARD</button>`
        : '';

      md.innerHTML = `
        <h2 style="color:#fbbf24">🔧 ${escapeHtml(member.sensorName)}</h2>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:12px">Dashboard: ${escapeHtml(dashboardName || '')} · ${member.candidates.length} candidatos</div>
        <div>${radios}</div>
        <div class="sa-sst-btnrow" style="justify-content:space-between">
          <div>${skipDashboardBtn}</div>
          <div style="display:flex;gap:10px">
            <button class="sa-sst-btn sa-sst-btn-cancel" id="sa-sst-skip-member">SALTAR ESTE MEMBER</button>
            <button class="sa-sst-btn sa-sst-btn-exec" id="sa-sst-assign">ASIGNAR</button>
          </div>
        </div>
      `;
      ov.appendChild(md);
      document.body.appendChild(ov);

      md.querySelector('#sa-sst-skip-member').addEventListener('click', () => {
        ov.remove();
        resolve({ action: 'skip-member' });
      });
      const skipDash = md.querySelector('#sa-sst-skip-dash');
      if (skipDash) skipDash.addEventListener('click', () => {
        ov.remove();
        resolve({ action: 'skip-dashboard' });
      });
      md.querySelector('#sa-sst-assign').addEventListener('click', () => {
        const sel = md.querySelector('input[name="sa-sst-cand"]:checked');
        if (!sel) { resolve({ action: 'skip-member' }); ov.remove(); return; }
        ov.remove();
        resolve({ action: 'assign', paramId: parseInt(sel.value, 10) });
      });
    });
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): modal asistido para candidatos múltiples"
```

---

### Task 11: Modal de resumen final

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Agregar `showSummary`**

Inserta después de `showCandidatesModal`:

```javascript
  // ── Resumen final ──
  function showSummary(results) {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-sst-overlay';
    const md = document.createElement('div');
    md.className = 'sa-sst-modal';

    const hasErrors = results.errors.length > 0;
    const icon = hasErrors ? '⚠️' : '✅';
    const iconColor = hasErrors ? '#f59e0b' : '#4ade80';

    let errorsHTML = '';
    if (hasErrors) {
      const items = results.errors.slice(0, 15)
        .map(e => `<div style="font-size:11px;color:#fca5a5;padding:1px 0">${escapeHtml(e)}</div>`)
        .join('');
      errorsHTML = `
        <div style="margin-top:12px">
          <div style="font-size:12px;color:#ef4444;font-weight:600;margin-bottom:4px">Errores (${results.errors.length}):</div>
          ${items}
        </div>`;
    }

    md.innerHTML = `
      <h2 style="color:${iconColor}">${icon} Resumen</h2>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#a78bfa">${results.dashboardsProcessed}</div>
          <div style="font-size:11px;color:#94a3b8">Dashboards</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#4ade80">${results.assigned}</div>
          <div style="font-size:11px;color:#94a3b8">Auto-asignados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#8b5cf6">${results.assisted}</div>
          <div style="font-size:11px;color:#94a3b8">Asistidos</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#64748b">${results.already}</div>
          <div style="font-size:11px;color:#94a3b8">Ya asignados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#f59e0b">${results.skipped}</div>
          <div style="font-size:11px;color:#94a3b8">Saltados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#fb7185">${results.zero}</div>
          <div style="font-size:11px;color:#94a3b8">Sin candidatos</div>
        </div>
      </div>
      ${errorsHTML}
      <div class="sa-sst-btnrow">
        <button class="sa-sst-btn sa-sst-btn-exec" id="sa-sst-close">CERRAR</button>
      </div>
    `;
    ov.appendChild(md);
    document.body.appendChild(ov);
    md.querySelector('#sa-sst-close').addEventListener('click', () => ov.remove());
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): modal de resumen final"
```

---

### Task 12: Orchestrator `run()` — flujo completo

**Files:**
- Modify: `remote/scripts/sensor-status-autofill.js`

- [ ] **Step 1: Sustituir el `run()` skeleton por la versión completa**

Localiza el `run()` actual (skeleton, devuelve `{ error: 'Implementación pendiente (skeleton)' }`) y sustitúyelo por:

```javascript
  async function run() {
    if (state.running) return { error: 'Ya hay una corrida en curso' };
    state.running = true;
    state.cancelled = false;
    try {
      // ─── Fase 0: scope ───
      const currentRef = parseSensorDashboardFromURL();
      let currentName = '';
      if (currentRef) {
        try {
          const dash = await fetchDashboard(currentRef.idInDomain);
          currentName = dash?.name || '';
        } catch (_) { /* nombre opcional, seguimos */ }
      }

      const choice = await showScopeModal({ currentRef, currentName });
      if (choice.cancelled) return { cancelled: true };

      // ─── Resolver dashboards a procesar ───
      let dashboards = [];
      if (choice.scope === 'current') {
        dashboards = [{ idInDomain: choice.idInDomain, name: currentName }];
      } else {
        showProgressUI('Listando dashboards', 'Cargando lista del domain…');
        try {
          const all = await fetchAllSensorDashboards();
          dashboards = all.map(d => ({ idInDomain: d.idInDomain, name: d.name }));
        } catch (e) {
          removeUI();
          return { error: String(e?.message || e) };
        }
      }

      if (!dashboards.length) {
        removeUI();
        return { error: 'No hay dashboards a procesar' };
      }

      // ─── Fase 1: procesar dashboards ───
      const results = {
        dashboardsProcessed: 0, assigned: 0, assisted: 0, already: 0,
        skipped: 0, zero: 0, errors: []
      };

      for (let di = 0; di < dashboards.length; di++) {
        if (state.cancelled) break;
        const d = dashboards[di];
        showProgressUI(
          `Dashboard ${di + 1} de ${dashboards.length}`,
          `${d.name || `#${d.idInDomain}`} — pull…`
        );

        let dashboard;
        try {
          dashboard = await fetchDashboard(d.idInDomain);
        } catch (e) {
          results.errors.push(`Dashboard ${d.name}: ${String(e?.message || e).substring(0, 200)}`);
          continue;
        }

        const groups = classifyMembers(dashboard);
        results.already += groups.already.length;
        results.zero    += groups.zero.length;

        // Auto-asignación
        for (let ai = 0; ai < groups.auto.length; ai++) {
          if (state.cancelled) break;
          const m = groups.auto[ai];
          updateProgress({
            title: `Dashboard ${di + 1} de ${dashboards.length}`,
            msg: `Auto-asignando ${ai + 1} de ${groups.auto.length}: ${m.sensorName}`,
            sub: d.name || '',
            pct: ((ai + 1) / Math.max(groups.auto.length, 1)) * 100
          });
          try {
            await updateMember(m.memberId, m.candidates[0].id);
            results.assigned++;
          } catch (e) {
            results.errors.push(`${m.sensorName}: ${String(e?.message || e).substring(0, 200)}`);
          }
        }
        if (state.cancelled) { removeUI(); break; }

        // Modales asistidos
        let skipRest = false;
        for (let mi = 0; mi < groups.multi.length; mi++) {
          if (state.cancelled || skipRest) break;
          const m = groups.multi[mi];
          removeUI();
          const decision = await showCandidatesModal({
            member: m, dashboardName: d.name, mode: choice.scope
          });
          if (decision.action === 'skip-member') { results.skipped++; continue; }
          if (decision.action === 'skip-dashboard') { skipRest = true; results.skipped += groups.multi.length - mi; break; }
          if (decision.action === 'assign') {
            try {
              await updateMember(m.memberId, decision.paramId);
              results.assisted++;
            } catch (e) {
              results.errors.push(`${m.sensorName}: ${String(e?.message || e).substring(0, 200)}`);
            }
          }
        }

        results.dashboardsProcessed++;
      }

      removeUI();
      log(`run() done: assigned=${results.assigned} assisted=${results.assisted} already=${results.already} zero=${results.zero} skipped=${results.skipped} errors=${results.errors.length}`);
      showSummary(results);
      return results;
    } finally {
      state.running = false;
    }
  }
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c remote/scripts/sensor-status-autofill.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/sensor-status-autofill.js
git commit -m "feat(sensor-status-autofill): orchestrator run() completo"
```

---

### Task 13: Smoke test manual + deploy a gh-pages

**Files:**
- (deploy) `gh-pages` rama

- [ ] **Step 1: Verificar todo el chain de syntax**

Run:
```bash
node -c remote/scripts/sensor-status-autofill.js && \
node -c extension/background.js && \
python3 -m json.tool remote/config.json > /dev/null && \
echo "ALL OK"
```

Expected: `ALL OK`.

- [ ] **Step 2: Commit del bump si quedó algo pendiente**

Si quedaron cambios sin commitear:

```bash
git status
git add -A
git commit -m "chore: ajustes finales sensor-status-autofill 0.5.57"
```

Si `git status` muestra todo limpio, salta este paso.

- [ ] **Step 3: Deploy a gh-pages**

Sigue el procedimiento documentado en `CLAUDE.md`:

```bash
# Desde una checkout de main, asumiendo cwd = repo root
git checkout gh-pages
cp ../<otra-checkout-de-main>/remote/scripts/sensor-status-autofill.js scripts/sensor-status-autofill.js
cp ../<otra-checkout-de-main>/remote/config.json config.json
git add scripts/sensor-status-autofill.js config.json
git commit -m "deploy: sensor-status-autofill applet + bump 0.5.57"
git push origin gh-pages
git checkout main
git push origin main
```

**Nota:** si no tienes una segunda checkout, alternativa con `git show`:

```bash
git checkout gh-pages
git show main:remote/scripts/sensor-status-autofill.js > scripts/sensor-status-autofill.js
git show main:remote/config.json > config.json
git add scripts/sensor-status-autofill.js config.json
git commit -m "deploy: sensor-status-autofill applet + bump 0.5.57"
git push origin gh-pages
git checkout main
git push origin main
```

- [ ] **Step 4: Smoke test en Chrome**

1. Abre `chrome://extensions`, recarga la extensión Steelhead Automator (o reinicia Chrome si cachea agresivo).
2. Navega a un Sensor Dashboard de Steelhead (ej. `/sensor-dashboards/<id>`).
3. Verifica: aparece el FAB morado **📊 Auto-asignar status** abajo a la derecha.
4. Click → debe aparecer el modal de scope con radio "Solo este dashboard" marcado y checkbox "TODOS" off.
5. Click `INICIAR` → procesa el dashboard. Verifica:
   - Members con 1 candidato se auto-asignan (radio "Use for Status" se llena en el UI).
   - Members con ≥2 candidatos abren modal de candidatos. Pick uno y confirma.
   - Members ya asignados se respetan.
   - Resumen final aparece con conteos correctos.
6. Recarga el dashboard y verifica que las asignaciones persisten (no se perdieron).

Si hay errores en el modal de resumen, copia el log de la consola del browser y diagnostica.

- [ ] **Step 5: Smoke test del modo `all`**

1. Desde un dashboard cualquiera, abre el FAB, marca el checkbox "TODOS" → click `INICIAR`. (No hace falta visitar la lista primero — `AllSensorDashboards` toma `{}`.)
2. Verifica progreso de dos niveles (`Dashboard X de N` + `Member Y de M`).
3. Prueba `SALTAR RESTO DE ESTE DASHBOARD` en un member multi → confirma que pasa al siguiente dashboard sin atender más asistidos del actual.
4. Prueba `DETENER` a media corrida → resumen muestra parcial.

- [ ] **Step 6: Commit final si hay ajustes post-smoke**

Si los smoke tests pidieron tweaks (ej. URL regex equivocada, hash de query mal capturado, shape de respuesta distinta), aplícalos en commits separados con prefijo `fix(sensor-status-autofill): ...` y re-deploya:

```bash
git push origin main
# Repetir Step 3 (sync a gh-pages)
```

Bumpea `version` cada vez que toques `remote/` para que la extensión recargue scripts (`0.5.57` → `0.5.58`, etc.).

---

## Decisiones implícitas y cosas que quedan claras al implementar

- **Permission gating:** el spec no exige rol específico (a diferencia de `paros-linea` que filtra operadores). Si en smoke aparece que cualquier usuario lo puede ver y eso es un problema, se agrega gating en init similar a `paros-linea.js:67-70` consultando `CurrentUserDetails`.
- **URL regex:** el plan asume `/sensor-dashboards/<id>`. Si el path real difiere (ej. `/Domains/<n>/SensorDashboards/<id>`), ajusta `DASHBOARD_URL_RE` en Task 1 antes de correr smoke.
- **Shape de respuesta de `AllSensorDashboards`:** el helper en Task 6 hace best-effort buscando `pagedData.nodes`, `allSensorDashboards.nodes`, o el objeto plano con `nodes`. Si la respuesta real cuelga de otra ruta, ajusta `Task 6 Step 3` con la ruta confirmada por scan/devtools.
- **Cancelación durante mutation en vuelo:** el flag `state.cancelled` se chequea entre members; una mutation ya iniciada termina antes de salir. No se rompe la atomicidad — la mutation o pasa o falla, sin estado intermedio que limpiar.
- **Member sin sensor:** el classifier maneja `sensorBySensorId == null` devolviendo `candidates = []` → cae en `zero`, mensaje informativo en resumen.
