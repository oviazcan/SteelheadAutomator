# Unit Auto-Convert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Al editar un Número de Parte en Steelhead, cuando el operador escribe un valor en un campo de unidad y da Tab, calcular y rellenar/crear las demás unidades del mismo tipo físico (peso, longitud, superficie), con un toggle visible default ON.

**Architecture:** Applet remoto `autoInject` (sin tocar `background.js`). Un módulo puro `unit-autoconvert-core.js` (conversión + parseo de etiquetas) con golden tests en Node. El applet `unit-autoconvert.js` engancha un `focusout` delegado: para cada par del grupo, si tiene campo/fila visible lo llena por DOM (setter nativo + `InputEvent`); si no (DMK, o par ausente en Panel B) lo crea/actualiza por API reusando el patrón `upsertConversion` de `weight-quick-entry`, con aviso de recarga.

**Tech Stack:** JavaScript vanilla (sin frameworks/bundlers), Chrome MV3 remote-loader, GraphQL Apollo Persisted Queries, `node:test` para unit tests. Spec fuente: `docs/superpowers/specs/2026-06-16-unit-autoconvert-design.md`.

---

## File Structure

- **Create** `remote/scripts/unit-autoconvert-core.js` — módulo PURO (sin DOM/red): tabla `UNIT_GROUPS`, `computePeers`, `round4`, `getGroup`, `isConvertible`, `unitCodeFromText`, `isReciprocalAdornment`. Dual-export (`window.UnitAutoConvertCore` / `module.exports`).
- **Create** `tools/test/unit-autoconvert-core.test.js` — golden tests del core (`node --test`).
- **Create** `remote/scripts/unit-autoconvert.js` — applet: estado por sesión en `window.__saUac`, fetch interceptor para cachear `inventoryItemId`, `MutationObserver` idempotente para inyectar toggle, `focusout` delegado, identificación DOM (Panel A/B), escritura DOM, upsert por API, aviso de recarga.
- **Modify** `remote/config.json` — entrada en `apps[]` + kill-switch `unitAutoConvertEnabled: true`.
- **Create** `docs/applets/unit-autoconvert.md` — bitácora.
- **Modify** `CLAUDE.md` — fila en el índice de applets (hot file: pasada corta).
- **Deploy** (opcional, tarea final) — sync a `gh-pages` + bump `version`.

**Notas de arquitectura clave:**
- `background.js:47` usa `app.scripts` en orden → el core va ANTES del applet en el array.
- autoInject re-inyecta el script en cada navegación (no está en el `globals` map de `background.js`, por diseño) → **el applet DEBE ser idempotente**: todo el estado vive en `window.__saUac` y los guards usan `dataset.saUacToggle` / latches en `window.__saUac`.
- `api().query(opKey, variables, operationName)` — tercer arg = operationName (igual que `weight-quick-entry.js:726`).

---

## Task 1: Módulo puro de conversión + golden tests

**Files:**
- Create: `remote/scripts/unit-autoconvert-core.js`
- Test: `tools/test/unit-autoconvert-core.test.js`

- [ ] **Step 1: Write the failing test**

Create `tools/test/unit-autoconvert-core.test.js`:

```js
// tools/test/unit-autoconvert-core.test.js
// Golden tests del módulo puro de conversión de unidades.
// Run: node --test tools/test/unit-autoconvert-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/unit-autoconvert-core.js');

test('computePeers: peso KGM → LBR', () => {
  assert.deepEqual(Core.computePeers('KGM', 2.85), [{ code: 'LBR', value: 6.2832 }]);
});

test('computePeers: peso LBR → KGM (round-trip)', () => {
  assert.deepEqual(Core.computePeers('LBR', 6.2832), [{ code: 'KGM', value: 2.85 }]);
});

test('computePeers: superficie CMK → DMK, FTK (orden DMK luego FTK)', () => {
  assert.deepEqual(Core.computePeers('CMK', 760.48), [
    { code: 'DMK', value: 7.6048 },
    { code: 'FTK', value: 0.8186 },
  ]);
});

test('computePeers: superficie DMK → CMK, FTK', () => {
  assert.deepEqual(Core.computePeers('DMK', 7.6048), [
    { code: 'CMK', value: 760.48 },
    { code: 'FTK', value: 0.8186 },
  ]);
});

test('computePeers: longitud LM → FOT', () => {
  assert.deepEqual(Core.computePeers('LM', 0.38), [{ code: 'FOT', value: 1.2467 }]);
});

test('computePeers: LO no pertenece a ningún grupo → []', () => {
  assert.deepEqual(Core.computePeers('LO', 5), []);
});

test('computePeers: código desconocido → []', () => {
  assert.deepEqual(Core.computePeers('XYZ', 5), []);
});

test('computePeers: valores inválidos → []', () => {
  assert.deepEqual(Core.computePeers('KGM', 0), []);
  assert.deepEqual(Core.computePeers('KGM', -1), []);
  assert.deepEqual(Core.computePeers('KGM', NaN), []);
  assert.deepEqual(Core.computePeers('KGM', Infinity), []);
});

test('round4: redondea a 4 decimales y recorta ceros', () => {
  assert.equal(Core.round4(6.283174), 6.2832);
  assert.equal(Core.round4(2.85), 2.85);
  assert.equal(Core.round4(7.60480000), 7.6048);
});

test('unitCodeFromText: primer token en mayúsculas', () => {
  assert.equal(Core.unitCodeFromText('KGM Kilogramo / Part:'), 'KGM');
  assert.equal(Core.unitCodeFromText('CMK Centímetro Cuadrado'), 'CMK');
  assert.equal(Core.unitCodeFromText('  lbr libra '), 'LBR');
  assert.equal(Core.unitCodeFromText(''), '');
  assert.equal(Core.unitCodeFromText(null), '');
});

test('isReciprocalAdornment: detecta "Parts / X"', () => {
  assert.equal(Core.isReciprocalAdornment('Parts / KGM Kilogramo'), true);
  assert.equal(Core.isReciprocalAdornment('KGM Kilogramo / Parts'), false);
  assert.equal(Core.isReciprocalAdornment(''), false);
});

test('isConvertible: solo unidades del roster', () => {
  assert.equal(Core.isConvertible('DMK'), true);
  assert.equal(Core.isConvertible('KGM'), true);
  assert.equal(Core.isConvertible('LO'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/unit-autoconvert-core.test.js`
Expected: FAIL — `Cannot find module '../../remote/scripts/unit-autoconvert-core.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `remote/scripts/unit-autoconvert-core.js`:

```js
// unit-autoconvert-core.js — funciones PURAS de conversión de unidades por parte.
//
// Dual-export: window.UnitAutoConvertCore (browser) / module.exports (node --test).
// SIN dependencias de DOM, API ni closure. El valor "X / Part" que el usuario
// escribe ES el factor per-part de esa unidad (mismo número que guarda la API).
(function (root) {
  'use strict';

  // factor = (unidades de esta unidad) por 1 unidad base. Conversión lineal sin offset.
  const UNIT_GROUPS = [
    { type: 'peso',       units: { KGM: 1, LBR: 2.2046226218 } },
    { type: 'longitud',   units: { LM: 1, FOT: 3.280839895 } },
    { type: 'superficie', units: { CMK: 1, DMK: 0.01, FTK: 0.001076391041670972 } },
  ];

  const CONVERTIBLE = new Set(UNIT_GROUPS.flatMap((g) => Object.keys(g.units)));

  function round4(x) {
    return Number(Number(x).toFixed(4));
  }

  function getGroup(code) {
    return UNIT_GROUPS.find((g) =>
      Object.prototype.hasOwnProperty.call(g.units, code)
    ) || null;
  }

  function isConvertible(code) {
    return CONVERTIBLE.has(code);
  }

  // Dado (code, value) devuelve [{code, value}] de los demás pares del grupo.
  function computePeers(code, value) {
    const v = Number(value);
    if (!isFinite(v) || v <= 0) return [];
    const g = getGroup(code);
    if (!g) return [];
    const base = v / g.units[code];
    const out = [];
    for (const peer of Object.keys(g.units)) {
      if (peer === code) continue;
      out.push({ code: peer, value: round4(base * g.units[peer]) });
    }
    return out;
  }

  // Primer token (código de unidad) de "KGM Kilogramo / Part:" → "KGM".
  function unitCodeFromText(text) {
    if (!text) return '';
    return String(text).trim().split(/\s+/)[0].toUpperCase();
  }

  // El adorno recíproco del Panel B empieza con "Parts /".
  function isReciprocalAdornment(text) {
    return /^\s*parts\s*\//i.test(String(text || ''));
  }

  const api = {
    UNIT_GROUPS, CONVERTIBLE, round4, getGroup, isConvertible,
    computePeers, unitCodeFromText, isReciprocalAdornment,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UnitAutoConvertCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/unit-autoconvert-core.test.js`
Expected: PASS — `pass 12  fail 0` (12 bloques `test()`).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/unit-autoconvert-core.js tools/test/unit-autoconvert-core.test.js
git commit -m "feat(unit-autoconvert): módulo puro de conversión + golden tests"
```

---

## Task 2: Registrar el applet en config.json

**Files:**
- Modify: `remote/config.json` (array `apps[]` + flag raíz `unitAutoConvertEnabled`)

- [ ] **Step 1: Agregar el kill-switch global**

En `remote/config.json`, junto a las otras flags raíz (mismo nivel que `version`/`lastUpdated`), agregar:

```json
"unitAutoConvertEnabled": true,
```

- [ ] **Step 2: Agregar la entrada de la app en `apps[]`**

Agregar al array `apps` (mismo formato que `weight-quick-entry`):

```json
{
  "id": "unit-autoconvert",
  "name": "Auto-conversión de Unidades",
  "subtitle": "Calcula las demás unidades del mismo tipo al editar un NP",
  "icon": "📐",
  "category": "Números de Parte",
  "autoInject": true,
  "scripts": ["scripts/steelhead-api.js", "scripts/unit-autoconvert-core.js", "scripts/unit-autoconvert.js"],
  "requiredPermissions": []
}
```

- [ ] **Step 3: Validar que el JSON sigue siendo válido**

Run: `node -e "JSON.parse(require('fs').readFileSync('remote/config.json','utf8')); console.log('config.json OK')"`
Expected: `config.json OK`

- [ ] **Step 4: Validar que la entrada quedó bien formada**

Run:
```bash
node -e "const c=JSON.parse(require('fs').readFileSync('remote/config.json','utf8')); const a=c.apps.find(x=>x.id==='unit-autoconvert'); console.log(JSON.stringify({killSwitch:c.unitAutoConvertEnabled, scripts:a.scripts, autoInject:a.autoInject}))"
```
Expected: `{"killSwitch":true,"scripts":["scripts/steelhead-api.js","scripts/unit-autoconvert-core.js","scripts/unit-autoconvert.js"],"autoInject":true}`

- [ ] **Step 5: Commit**

```bash
git add remote/config.json
git commit -m "feat(unit-autoconvert): registra app autoInject + kill-switch en config"
```

> ⚠️ `config.json` es hot file (ver CLAUDE.md §"Trabajo paralelo"): NO bumpear `version` aquí todavía — el bump va junto con el deploy a `gh-pages` (Task 7).

---

## Task 3: Applet — scaffold, estado por sesión, interceptor de `inventoryItemId`, observer + toggle

**Files:**
- Create: `remote/scripts/unit-autoconvert.js`

Esta tarea construye el applet hasta dejar el **toggle visible inyectado** en ambos paneles. La lógica de conversión (Tasks 4–6) se agrega al mismo archivo. Validación en vivo al final (no hay jsdom en el repo; los DOM applets se validan en vivo, ver bitácoras).

- [ ] **Step 1: Crear el archivo con scaffold + estado + interceptor**

Create `remote/scripts/unit-autoconvert.js`:

```js
// unit-autoconvert.js — Auto-conversión de unidades al editar un NP.
// Tab en un campo de unidad → calcula los pares del mismo tipo (peso/longitud/superficie).
// Campos presentes → DOM (setter nativo + InputEvent). Sin campo (DMK, pares ausentes) → API.
// Toggle visible default ON (por sesión). Depende de SteelheadAPI + UnitAutoConvertCore.
(function () {
  'use strict';
  const VERSION = '0.1.0';
  const LOG = '[SA unit-autoconvert]';
  const Core = window.UnitAutoConvertCore;
  const api = () => window.SteelheadAPI;

  // Estado en window para sobrevivir re-inyección (autoInject re-corre el IIFE).
  // enabled = por sesión: arranca ON; se resetea a ON solo en recarga dura (window nuevo).
  const S = window.__saUac || (window.__saUac = {
    enabled: true, invItemId: null, pnId: null, unitIdCache: null,
    fetchPatched: false, observer: null,
  });

  function killSwitchOff() {
    const cfg = window.REMOTE_CONFIG;
    return !!(cfg && cfg.unitAutoConvertEnabled === false);
  }

  // ── Interceptor de fetch: cachea inventoryItemId del PN abierto ──
  // El modal carga el PN vía GraphQL; capturamos inventoryItemByPartNumberId.id.
  function installInterceptor() {
    const orig = window.fetch;
    if (!orig || orig.__saUacPatched) return;
    const patched = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        const url = (args[0] && args[0].url) || args[0];
        if (typeof url === 'string' && url.includes('/graphql')) {
          res.clone().json().then((json) => {
            try { scanForInventoryItem(json); } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return res;
    };
    patched.__saUacPatched = true;
    window.fetch = patched;
  }

  // Busca recursivamente inventoryItemByPartNumberId.id en una respuesta GraphQL.
  function scanForInventoryItem(node, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 8) return;
    if (node.inventoryItemByPartNumberId && node.inventoryItemByPartNumberId.id != null) {
      S.invItemId = node.inventoryItemByPartNumberId.id;
      if (node.id != null) S.pnId = node.id;
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') scanForInventoryItem(v, (depth || 0) + 1);
    }
  }

  // ── init idempotente ──
  function init() {
    if (killSwitchOff()) { console.log(LOG, 'kill-switch off'); return; }
    if (!Core) { console.warn(LOG, 'UnitAutoConvertCore no cargado'); return; }
    if (!S.fetchPatched) { installInterceptor(); S.fetchPatched = true; }
    if (!S.observer) {
      S.observer = new MutationObserver(() => { tryInjectToggles(); });
      S.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    // listener delegado (se registra una sola vez por window)
    if (!S.focusoutBound) {
      document.addEventListener('focusout', onFocusOut, true);
      S.focusoutBound = true;
    }
    tryInjectToggles();
    console.log(LOG, 'init', VERSION);
  }

  // placeholders rellenados en Tasks 4–6
  function tryInjectToggles() {}
  function onFocusOut() {}

  const Applet = { __saVersion: VERSION, init, _state: S };
  window.UnitAutoConvert = Applet;
  init();
})();
```

- [ ] **Step 2: Implementar el toggle UI + inyección idempotente en ambos paneles**

Reemplazar la línea `function tryInjectToggles() {}` por:

```js
  // ── Toggle UI ──
  function buildToggle() {
    const wrap = document.createElement('label');
    wrap.className = 'sa-uac-toggle';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:8px 0;font-size:13px;color:#444;cursor:pointer;user-select:none;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'sa-uac-cb';
    cb.checked = S.enabled;
    cb.style.cssText = 'cursor:pointer;';
    cb.addEventListener('change', () => {
      S.enabled = cb.checked;
      // sincroniza cualquier otro toggle inyectado
      document.querySelectorAll('input.sa-uac-cb').forEach((other) => { other.checked = S.enabled; });
    });
    const txt = document.createElement('span');
    txt.textContent = 'Auto-conversión de unidades';
    wrap.appendChild(cb);
    wrap.appendChild(txt);
    return wrap;
  }

  function injectToggleNear(anchorEl, position) {
    if (!anchorEl) return;
    // contenedor donde marcamos idempotencia
    const host = anchorEl.parentElement || anchorEl;
    if (host.querySelector(':scope > .sa-uac-toggle') || host.dataset.saUacToggle) return;
    host.dataset.saUacToggle = '1';
    const toggle = buildToggle();
    if (position === 'after') anchorEl.insertAdjacentElement('afterend', toggle);
    else host.insertBefore(toggle, host.firstChild);
  }

  function findByText(selector, predicate) {
    const els = document.querySelectorAll(selector);
    for (const el of els) { if (predicate(el.textContent.trim())) return el; }
    return null;
  }

  function tryInjectToggles() {
    if (killSwitchOff()) return;
    // Panel A: encabezado "Per Part Count Unit Definitions"
    const headingA = findByText('p.MuiTypography-root, strong, h6, span', (t) =>
      /per part count unit definitions/i.test(t));
    if (headingA) injectToggleNear(headingA, 'after');
    // Panel B: header "Modo:" del modal Definir Unidades
    const modoP = findByText('p.MuiTypography-root', (t) => /^modo:?$/i.test(t));
    if (modoP) injectToggleNear(modoP.parentElement, 'before');
  }
```

- [ ] **Step 3: Validación en vivo (manual)**

1. Recargar la extensión (`chrome://extensions` → reload) y abrir un NP en `app.gosteelhead.com`.
2. Abrir el modal **Edit Part Number → FACTORES Y PRECIO**. Verificar: aparece el toggle "Auto-conversión de unidades" (checkbox marcado) junto al título "Per Part Count Unit Definitions". Una sola vez (no duplicado al re-render).
3. Abrir el modal **Definir Unidades** (desde la sección Units → DEFINE NEW/editar). Verificar: aparece el toggle junto a "Modo:".
4. Consola: `[SA unit-autoconvert] init 0.1.0`. Sin errores.
5. `window.__saUac.enabled === true`.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/unit-autoconvert.js
git commit -m "feat(unit-autoconvert): scaffold + interceptor de inventoryItemId + toggle en ambos paneles"
```

---

## Task 4: Conversión por DOM en Panel A (campos presentes)

**Files:**
- Modify: `remote/scripts/unit-autoconvert.js`

Agrega la identificación de campos del Panel A, la escritura por DOM y el cableado del `focusout`. En esta tarea, los pares SIN campo (DMK) se **ignoran** (se completan en Task 5).

- [ ] **Step 1: Implementar helpers de DOM y la escritura por setter nativo**

Insertar estas funciones dentro del IIFE (antes de `const Applet = ...`):

```js
  // ── Escritura DOM compatible con React/MUI ──
  function writeInput(input, value) {
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Identificación de contexto del input que disparó focusout ──
  // Devuelve { panel:'A'|'B', code } o null.
  function classifyInput(input) {
    // Panel B: dentro de una fila de tabla con nombre de unidad
    const tr = input.closest('tr.MuiTableRow-root');
    if (tr) {
      const nameP = tr.querySelector('td p.MuiTypography-root');
      if (!nameP) return null;
      // descartar el input recíproco (Parts / X)
      const adorn = (input.closest('td')?.querySelector('.MuiInputAdornment-root')?.textContent) || '';
      if (Core.isReciprocalAdornment(adorn)) return null;
      return { panel: 'B', code: Core.unitCodeFromText(nameP.textContent) };
    }
    // Panel A: label hermano que termina en "/ Part:"
    const fc = input.closest('.MuiFormControl-root');
    if (fc && fc.parentElement) {
      const labelP = fc.parentElement.querySelector(':scope > p.MuiTypography-root');
      if (labelP && /\/\s*part:?\s*$/i.test(labelP.textContent.trim())) {
        return { panel: 'A', code: Core.unitCodeFromText(labelP.textContent) };
      }
    }
    return null;
  }

  // Busca el input del par `code` en el panel dado. Null si no tiene campo/fila.
  function findPeerInput(panel, code) {
    if (panel === 'A') {
      const labels = document.querySelectorAll('p.MuiTypography-root');
      for (const p of labels) {
        const t = p.textContent.trim();
        if (/\/\s*part:?\s*$/i.test(t) && Core.unitCodeFromText(t) === code) {
          return p.parentElement.querySelector('input');
        }
      }
      return null;
    }
    // Panel B
    const rows = document.querySelectorAll('tr.MuiTableRow-root');
    for (const tr of rows) {
      const nameP = tr.querySelector('td p.MuiTypography-root');
      if (!nameP || Core.unitCodeFromText(nameP.textContent) !== code) continue;
      const inputs = tr.querySelectorAll('input');
      for (const inp of inputs) {
        const adorn = (inp.closest('td')?.querySelector('.MuiInputAdornment-root')?.textContent) || '';
        if (!Core.isReciprocalAdornment(adorn)) return inp; // Unidades/Parts
      }
    }
    return null;
  }
```

- [ ] **Step 2: Implementar el handler `onFocusOut` (solo DOM por ahora)**

Reemplazar `function onFocusOut() {}` por:

```js
  async function onFocusOut(e) {
    try {
      if (!S.enabled || killSwitchOff()) return;
      const input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.classList.contains('sa-uac-cb')) return; // nuestro propio toggle
      const ctx = classifyInput(input);
      if (!ctx || !Core.isConvertible(ctx.code)) return;
      const value = parseFloat(input.value);
      if (!isFinite(value) || value <= 0) return;

      const peers = Core.computePeers(ctx.code, value);
      if (!peers.length) return;

      const missing = [];
      for (const peer of peers) {
        const peerInput = findPeerInput(ctx.panel, peer.code);
        if (peerInput) writeInput(peerInput, peer.value);
        else missing.push(peer);
      }
      // missing → API en Task 5 (por ahora se ignoran)
      if (missing.length) console.log(LOG, 'pares sin campo (pendiente API):', missing);
    } catch (err) {
      console.error(LOG, 'onFocusOut', err);
    }
  }
```

- [ ] **Step 3: Re-correr los golden tests del core (no deben romperse)**

Run: `node --test tools/test/unit-autoconvert-core.test.js`
Expected: PASS — `pass 12  fail 0` (el core no cambió; sanity check).

- [ ] **Step 4: Validación en vivo (Panel A, pares con campo)**

En **Edit Part Number → FACTORES Y PRECIO** (toggle ON):
1. Escribir `2.85` en **KGM** → Tab → **LBR** se llena `6.2832`.
2. Escribir `0.38` en **LM** → Tab → **FOT** se llena `1.2467`.
3. Escribir `760.48` en **CMK** → Tab → **FTK** se llena `0.8186`. (DMK aún no; consola loguea "pares sin campo (pendiente API): [{code:'DMK'...}]").
4. Sobrescritura: cambiar KGM a `1` → Tab → LBR pasa a `2.2046`.
5. Toggle OFF → escribir KGM → Tab → no cambia LBR. Toggle ON de nuevo → vuelve a calcular.
6. Valor vacío/`0`/texto → Tab → no toca nada.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/unit-autoconvert.js
git commit -m "feat(unit-autoconvert): conversión por DOM en Panel A (pares con campo)"
```

---

## Task 5: Crear pares sin campo por API (DMK) + resolución de inventoryItemId + aviso

**Files:**
- Modify: `remote/scripts/unit-autoconvert.js`

- [ ] **Step 1: Implementar resolución de `unitId` (incl. DMK vía SearchUnits) y de `inventoryItemId`**

Insertar dentro del IIFE (antes de `const Applet = ...`):

```js
  // ── unitId por código: primero domain.unitIds, luego SearchUnits (cache) ──
  async function resolveUnitId(code) {
    const ids = (api()?.getDomain?.()?.unitIds) || {};
    if (ids[code] != null) return ids[code];
    if (S.unitIdCache && S.unitIdCache[code] != null) return S.unitIdCache[code];
    try {
      const data = await api().query('SearchUnits', {}, 'SearchUnits');
      const nodes = data?.pagedData?.nodes || data?.searchUnits?.nodes || [];
      S.unitIdCache = S.unitIdCache || {};
      for (const n of nodes) {
        const c = Core.unitCodeFromText(n.name);
        if (c) S.unitIdCache[c] = n.id;
      }
      return S.unitIdCache[code] ?? null;
    } catch (e) {
      console.warn(LOG, 'SearchUnits falló', e);
      return null;
    }
  }

  // inventoryItemId del PN abierto: cache del interceptor, o fallback GetPartNumber por pnId.
  async function resolveInventoryItemId() {
    if (S.invItemId != null) return S.invItemId;
    if (S.pnId != null) {
      try {
        const d = await api().query('GetPartNumber', { id: S.pnId }, 'GetPartNumber');
        const inv = d?.partNumberById?.inventoryItemByPartNumberId?.id
          || d?.partNumber?.inventoryItemByPartNumberId?.id;
        if (inv != null) { S.invItemId = inv; return inv; }
      } catch (e) { console.warn(LOG, 'GetPartNumber fallback falló', e); }
    }
    return null;
  }
```

- [ ] **Step 2: Implementar el upsert por API y el aviso de recarga**

Insertar dentro del IIFE (antes de `const Applet = ...`):

```js
  // Crea/actualiza conversiones para los pares sin campo. Devuelve nº creados.
  async function apiUpsertPeers(missing) {
    const inventoryItemId = await resolveInventoryItemId();
    if (inventoryItemId == null) {
      console.warn(LOG, 'sin inventoryItemId; no se crean', missing.map((m) => m.code));
      showNotice('No se pudo resolver el PN — no se crearon ' + missing.map((m) => m.code).join(', '), true);
      return 0;
    }
    let created = 0;
    try {
      const data = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
      const existing = data?.inventoryItemById?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];
      for (const peer of missing) {
        const unitId = await resolveUnitId(peer.code);
        if (unitId == null) { console.warn(LOG, 'sin unitId para', peer.code); continue; }
        const hit = existing.find((c) => Number(c.unitByUnitId?.id) === Number(unitId));
        if (hit) {
          await api().query('UpdateInventoryItemUnitConversion', { id: hit.id, factor: peer.value }, 'UpdateInventoryItemUnitConversion');
        } else {
          await api().query('CreateInventoryItemUnitConversion', { unitId, inventoryItemId, factor: peer.value }, 'CreateInventoryItemUnitConversion');
          created++;
        }
      }
    } catch (e) {
      console.error(LOG, 'apiUpsertPeers', e);
      showNotice('Error creando unidades por API', true);
    }
    return created;
  }

  // Aviso no bloqueante (toast efímero).
  function showNotice(msg, isError) {
    let el = document.querySelector('.sa-uac-notice');
    if (!el) {
      el = document.createElement('div');
      el.className = 'sa-uac-notice';
      el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:10px 16px;border-radius:8px;font-size:13px;font-family:-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:340px;';
      document.body.appendChild(el);
    }
    el.style.background = isError ? '#c13c26' : '#1f2937';
    el.style.color = '#fff';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 6000);
  }
```

- [ ] **Step 3: Conectar el upsert en `onFocusOut`**

Reemplazar el bloque final de `onFocusOut`:

```js
      // missing → API en Task 5 (por ahora se ignoran)
      if (missing.length) console.log(LOG, 'pares sin campo (pendiente API):', missing);
```

por:

```js
      if (missing.length) {
        const created = await apiUpsertPeers(missing);
        if (created > 0) {
          showNotice('Se crearon ' + created + ' unidad(es) por API (' +
            missing.map((m) => m.code).join(', ') + ') · recarga para verlas');
        }
      }
```

- [ ] **Step 4: Validación en vivo (DMK por API)**

⚠️ **Probar PRIMERO el riesgo #1 del spec** (semántica del SAVE del modal):
1. En FACTORES Y PRECIO, escribir `760.48` en **CMK** → Tab. Verificar: **FTK** = `0.8186` (DOM) y aparece toast "Se crearon 1 unidad(es) por API (DMK) · recarga para verlas".
2. En consola/Network: `CreateInventoryItemUnitConversion` 200, sin `errors`.
3. **Recargar** y abrir el modal Definir Unidades → confirmar que **DMK** existe con `7.6048`.
4. **Prueba de SAVE:** repetir (CMK→Tab crea DMK por API) y esta vez dar **SAVE** al modal. Recargar y verificar si **DMK sobrevive** (merge) o **desaparece** (replace). Documentar el resultado en la bitácora (Task 6). Si es replace → registrar como hallazgo y ajustar UX (recomendar recargar antes de guardar).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/unit-autoconvert.js
git commit -m "feat(unit-autoconvert): crea pares sin campo por API (DMK) + aviso de recarga"
```

---

## Task 6: Validar Panel B + cerrar bitácora e índice

**Files:**
- Modify: `remote/scripts/unit-autoconvert.js` (solo si la validación revela ajustes)
- Create: `docs/applets/unit-autoconvert.md`
- Modify: `CLAUDE.md`

El código del Panel B ya está cubierto por `classifyInput`/`findPeerInput` (rama `'B'`). Esta tarea lo valida en vivo y documenta.

- [ ] **Step 1: Validación en vivo (Panel B — modal "Definir Unidades")**

Con filas presentes (p. ej. KGM, CMK, LM) y toggle ON:
1. En la fila **KGM**, cambiar `Unidades/Parts` y dar Tab. Si **LBR** es fila → se llena por DOM y su `Parts/Unit` recíproco se recalcula solo. Si **LBR** NO es fila → se crea por API + toast de recarga.
2. En **CMK** → Tab: si DMK/FTK son filas, se llenan por DOM; los que falten, por API.
3. Confirmar que escribir en la columna `Parts/Unit` (recíproco) NO dispara conversión (la rama `classifyInput` la descarta por `isReciprocalAdornment`).
4. Toggle OFF → no calcula.

Si algún selector falla (p. ej. el adorno del recíproco no matchea), ajustar `classifyInput`/`findPeerInput` y re-commitear. Capturar el `outerHTML` real de la fila si hay discrepancia (regla del repo).

- [ ] **Step 2: Escribir la bitácora**

Create `docs/applets/unit-autoconvert.md`:

```markdown
# Applet: `unit-autoconvert` — Auto-conversión de Unidades

**Versión actual:** 0.1.0
**Archivo:** `remote/scripts/unit-autoconvert.js` (+ `unit-autoconvert-core.js` puro)
**Global:** `window.UnitAutoConvert` · estado en `window.__saUac`

## Qué es
Al editar un NP, Tab en un campo de unidad → calcula los demás pares del mismo tipo físico:
- **Peso:** KGM ↔ LBR · **Longitud:** LM ↔ FOT · **Superficie:** CMK ↔ DMK ↔ FTK · (LO se ignora).

Híbrido: pares con campo/fila visible → DOM (setter nativo + InputEvent); pares sin campo
(DMK, o ausentes en Panel B) → API (`CreateInventoryItemUnitConversion`/`Update…`, reusando
el patrón de `weight-quick-entry`) + aviso de recarga.

## Pantallas
- **Panel A:** modal Edit Part Number → FACTORES Y PRECIO → "Per Part Count Unit Definitions"
  (7 campos default: KGM, LBR, FTK, CMK, FOT, LM, LO; **DMK no tiene campo** → solo por API).
- **Panel B:** modal "Definir Unidades Para <PN>" (tabla Unidad | Unidades/Parts | Parts/Unit).

## Decisiones
- Sobrescribe siempre · 4 decimales (trim) · toggle visible default ON **por sesión**
  (`window.__saUac.enabled`) · kill-switch global `config.unitAutoConvertEnabled`.

## DOM (selectores verificados)
- Panel A: input dentro de `.MuiFormControl-root`; `<p>` hermano termina en "/ Part:" → código = primer token.
- Panel B: `<tr.MuiTableRow-root>`; `td[0] p` = nombre (primer token = código); input Unidades/Parts
  = el del `<td>` cuyo adorno NO empieza con "Parts /".

## API
- `factor` de la conversión = valor "Unidades / Parts" (number). Hashes en `config.json`:
  `GetAvailableUnits`, `CreateInventoryItemUnitConversion`, `UpdateInventoryItemUnitConversion`,
  `SearchUnits` (para resolver id de DMK; no está en `domain.unitIds`).
- `inventoryItemId`: cacheado por interceptor de fetch (scan de `inventoryItemByPartNumberId.id`),
  fallback `GetPartNumber` por pnId.

## Riesgo validado
- **SAVE del modal vs conversiones sin campo (DMK creado por API):** <RESULTADO de la prueba
  Task 5 Step 4: merge o replace> — <acción tomada>.

## Pendientes
- Pinear `DMK` en `config.steelhead.domain.unitIds` (id confirmado: <PENDIENTE confirmar>).
- Confirmar permisos: operador no-admin escribiendo `CreateInventoryItemUnitConversion`.
- Deploy a `gh-pages` + bump `config.version`.
```

> Rellenar `<RESULTADO…>` y el id de DMK con lo observado en la validación antes de commitear.

- [ ] **Step 3: Agregar la fila al índice de `CLAUDE.md`**

En la tabla "Índice de applets" de `CLAUDE.md`, agregar (pasada corta — hot file):

```markdown
| `unit-autoconvert` | 0.1.0 | [`docs/applets/unit-autoconvert.md`](docs/applets/unit-autoconvert.md) |
```

- [ ] **Step 4: Commit**

```bash
git add docs/applets/unit-autoconvert.md CLAUDE.md remote/scripts/unit-autoconvert.js
git commit -m "docs(unit-autoconvert): bitácora + índice; valida Panel B"
```

---

## Task 7 (opcional): Deploy a `gh-pages`

> Solo cuando la validación en vivo esté aprobada. Sigue CLAUDE.md §"Deploy a producción".

- [ ] **Step 1: Bump de versión en config**

En `remote/config.json`: subir `version` (cache-bust) y `lastUpdated` a la fecha. Commit en `main`/rama de trabajo:

```bash
git add remote/config.json && git commit -m "chore(config): bump version (deploy unit-autoconvert)"
```

- [ ] **Step 2: Sync a gh-pages (estructura aplanada)**

```bash
git stash --include-untracked   # si hay .xlsm/WIP
git checkout gh-pages
git show main:remote/scripts/unit-autoconvert-core.js > scripts/unit-autoconvert-core.js
git show main:remote/scripts/unit-autoconvert.js > scripts/unit-autoconvert.js
git show main:remote/config.json > config.json
git add scripts/unit-autoconvert-core.js scripts/unit-autoconvert.js config.json
git commit -m "deploy: unit-autoconvert + bump <version>"
git checkout main && git stash pop || true
```

- [ ] **Step 3: Push y verificación byte-exact**

```bash
git push origin main && git push origin gh-pages
tools/check-deploy.sh unit-autoconvert
tools/check-deploy.sh unit-autoconvert-core
```
Expected: byte-exact OK. Tras ~30–60s, recargar la extensión y re-validar Tasks 4–6 en vivo.

---

## Self-Review (hecho por el autor del plan)

**Spec coverage:**
- Grupos/factores/roster → Task 1 (`UNIT_GROUPS`, golden tests). ✓
- Sobrescribe siempre / 4 decimales → Task 1 (`round4`, `computePeers`) + Task 4 (`writeInput` siempre escribe). ✓
- Toggle visible default ON por sesión → Task 3 (`buildToggle`, `S.enabled` en `window.__saUac`). ✓
- Kill-switch global → Task 2 + Task 3 (`killSwitchOff`). ✓
- Panel A DOM + identificación por label "/ Part:" → Task 4. ✓
- Panel B fila + adorno "Parts /" → Task 4 (`classifyInput`/`findPeerInput`) + Task 6 (validación). ✓
- DMK/pares sin campo por API + resolución de unitId/inventoryItemId + aviso recarga → Task 5. ✓
- Setter nativo + InputEvent → Task 4 (`writeInput`). ✓
- Memory: applet puntual, sin host-cleanup; inputs propios con clase `sa-uac-*` excluidos del handler (`sa-uac-cb` skip) → Task 3/4. ✓
- Riesgo #1 (SAVE merge/replace) → Task 5 Step 4 (probar primero) + Task 6 (documentar). ✓
- autoInject sin tocar background.js + idempotencia → Task 2 + Task 3 (`window.__saUac`, dataset guards). ✓

**Placeholder scan:** los `<RESULTADO…>`/`<PENDIENTE…>` en la bitácora (Task 6) son campos a rellenar DURANTE la validación en vivo (datos observables), no placeholders de implementación. Todo el código de tasks está completo.

**Type consistency:** `computePeers`→`[{code,value}]` usado igual en `onFocusOut`/`apiUpsertPeers`; `classifyInput`→`{panel,code}`; `S` (window.__saUac) con campos consistentes (`enabled,invItemId,pnId,unitIdCache,fetchPatched,observer,focusoutBound`); `api().query(opKey,vars,opName)` uniforme. ✓
