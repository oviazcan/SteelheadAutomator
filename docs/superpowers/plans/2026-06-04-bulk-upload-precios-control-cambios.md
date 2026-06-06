# bulk-upload: actualización de precios + Control de Cambios — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que bulk-upload (1) defaultee a MODIFICAR el PN activo más reciente cuando el upload trae acabados en blanco, y (2) registre cada alta/modificación en `customInputs.ControlCambios` usando el `inputSchemaId` vigente del dominio (3932).

**Architecture:** Lógica pura nueva (decisión de matching, construcción de eventos) vive en un módulo compartido `remote/scripts/bulk-upload-cc.js` con dual-export (browser global `window.SteelheadBulkCC` + `module.exports`), testeado con `node --test`. La integración dentro de `bulk-upload.js` (un IIFE monolítico de ~6900 líneas) se hace por Edits quirúrgicos y se valida con `node --check` + un piloto manual en el navegador (no hay runner DOM).

**Tech Stack:** JavaScript vanilla (sin bundler), Node v25 `node:test`/`node:assert` para los helpers puros, GraphQL persisted queries de Steelhead, deploy vía GitHub Pages (rama `gh-pages`).

**Spec:** `docs/superpowers/specs/2026-06-04-bulk-upload-actualizacion-precios-y-control-cambios-design.md`

---

## Contexto técnico imprescindible (leer antes de empezar)

- **Schema vigente del dominio TLC = `inputSchemaId 3932`** (incluye `ControlCambios`). El `3456` hardcodeado en `config.json` quedó obsoleto. `GetPartNumbersInputSchema` devuelve los schemas del dominio; bulk-upload ya elige el más reciente en `bulk-upload.js:3874` (`latestSchema`).
- **Estructura EXACTA de cada evento de `ControlCambios`** (nombres del schema): `{ Fecha, Usuario, Accion, Detalle, Version }`. `Fecha` es ISO date-time. Orden UI: `[Fecha, Usuario, Accion, Detalle, Version]`.
- **`CurrentUserDetails`** (hash ya en `config.json`, usada por `paros-linea.js`) devuelve el usuario logueado en `data.currentSession.userByUserId.name`.
- **Jerarquía de closures en `bulk-upload.js`:**
  - `execute(csvText)` — top-level, línea 3214. Declara `DOMAIN` en 3215.
  - `enrichWorker` — DENTRO de `execute` (línea 4874). Comparte su closure (ve `DOMAIN`, `currentUserName`, `runtimeInputSchemaId` si se declaran en `execute`).
  - STEP 2a (4079), STEP 5 (4317), cleanup (5889) — dentro de `execute`.
  - `classifyOnePN` (6599), `buildClassifiedRow` (1903), `showPreview` (2053) — top-level, NO comparten closure de `execute`. Solo dependen de `window.SteelheadBulkCC`.
- **REPLACE-semantics de `customInputs`:** `SavePartNumber` reemplaza el objeto completo. `mergeCustomInputs` (1442) hace deep-clone del existente + overlay. El append a `ControlCambios` se hace sobre `mergedCI` ya clonado → preserva historial.
- **Deploy:** editar `remote/` en `main` NO afecta usuarios hasta sincronizar a `gh-pages` (estructura aplanada: `remote/scripts/x.js` → `scripts/x.js`, `remote/config.json` → `config.json`). El `version` de `config.json` es el cache-bust.

---

## File Structure

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `remote/scripts/bulk-upload-cc.js` | **Crear** | Helpers puros: decisión blank-acabados + construcción de eventos de ControlCambios. Dual-export. |
| `tools/test_bulk_upload_cc.js` | **Crear** | Tests `node --test` de los helpers puros. |
| `remote/config.json` | Modificar | Registrar el script nuevo; bump `version` 1.6.36→1.6.37; `inputSchemaId_PN` 3456→3932; `lastUpdated`. |
| `remote/scripts/bulk-upload.js` | Modificar | inputSchemaId dinámico; `currentUserName`; rama A en classifyOnePN; `autoDecided`; enganche CC en enrichWorker; badge en preview; bump VERSION. |
| rama `gh-pages` | Modificar (deploy) | Espejo aplanado de `bulk-upload-cc.js`, `bulk-upload.js`, `config.json`. |

---

## Task 1: Helpers de Feature A (`pickMostRecent`, `decideBlankAcabados`)

**Files:**
- Create: `remote/scripts/bulk-upload-cc.js`
- Test: `tools/test_bulk_upload_cc.js`

- [ ] **Step 1: Escribir el test que falla**

Crear `tools/test_bulk_upload_cc.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const CC = require('../remote/scripts/bulk-upload-cc.js');

test('pickMostRecent: array vacío o no-array → null', () => {
  assert.strictEqual(CC.pickMostRecent([]), null);
  assert.strictEqual(CC.pickMostRecent(null), null);
  assert.strictEqual(CC.pickMostRecent(undefined), null);
});

test('pickMostRecent: devuelve el de id más alto', () => {
  assert.deepStrictEqual(CC.pickMostRecent([{ id: 5 }]), { id: 5 });
  assert.deepStrictEqual(CC.pickMostRecent([{ id: 5 }, { id: 9 }, { id: 3 }]), { id: 9 });
});

test('decideBlankAcabados: sin candidatos → null', () => {
  assert.strictEqual(CC.decideBlankAcabados([]), null);
  assert.strictEqual(CC.decideBlankAcabados(null), null);
});

test('decideBlankAcabados: 1 candidato → auto', () => {
  assert.deepStrictEqual(CC.decideBlankAcabados([{ id: 5 }]), { targetPnId: 5, autoDecided: true });
});

test('decideBlankAcabados: 2+ candidatos → más reciente, requiere confirmar', () => {
  assert.deepStrictEqual(
    CC.decideBlankAcabados([{ id: 5 }, { id: 9 }, { id: 3 }]),
    { targetPnId: 9, autoDecided: false }
  );
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: FAIL — `Cannot find module '../remote/scripts/bulk-upload-cc.js'`

- [ ] **Step 3: Crear el módulo con la implementación mínima**

Crear `remote/scripts/bulk-upload-cc.js`:

```js
// bulk-upload-cc.js — Helpers puros del applet bulk-upload (Control de Cambios +
// decisión de matching con acabados en blanco). Dual-export: en el browser expone
// window.SteelheadBulkCC; en Node (tests) exporta vía module.exports.
//
// Versión 1.0.0 (2026-06-04): extracción inicial para Feature A (blank-acabados)
// y Feature B (footprint en customInputs.ControlCambios).
(function (root) {
  'use strict';

  // Elige el candidato con id más alto (= el más reciente; los ids de Steelhead
  // son autoincrement). Devuelve null si no hay candidatos.
  function pickMostRecent(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    let best = candidates[0];
    for (const c of candidates) {
      if ((c && c.id ? c.id : 0) > (best && best.id ? best.id : 0)) best = c;
    }
    return best;
  }

  // Feature A: con acabados vacíos en el upload, decide el PN destino y si la
  // decisión es automática (1 candidato) o requiere confirmación (2+).
  // Devuelve null si no hay candidatos por nombre (la regla no aplica).
  function decideBlankAcabados(nameCandidates) {
    if (!Array.isArray(nameCandidates) || nameCandidates.length === 0) return null;
    const recent = pickMostRecent(nameCandidates);
    return { targetPnId: recent.id, autoDecided: nameCandidates.length === 1 };
  }

  const api = { pickMostRecent, decideBlankAcabados, VERSION: '1.0.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkCC = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload-cc.js tools/test_bulk_upload_cc.js
git commit -m "feat(bulk-upload-cc): helpers pickMostRecent + decideBlankAcabados (Feature A)"
```

---

## Task 2: Helpers de contenido (`computeAccion`, `buildDetalle`)

**Files:**
- Modify: `remote/scripts/bulk-upload-cc.js`
- Modify: `tools/test_bulk_upload_cc.js`

- [ ] **Step 1: Agregar tests que fallan**

Agregar al final de `tools/test_bulk_upload_cc.js`:

```js
test('computeAccion: combina tokens en orden ALTA, PRECIO, ENRIQUECIMIENTO', () => {
  assert.strictEqual(CC.computeAccion({ isNew: true }), 'ALTA');
  assert.strictEqual(CC.computeAccion({ hasPrice: true }), 'PRECIO');
  assert.strictEqual(CC.computeAccion({ hasEnrich: true }), 'ENRIQUECIMIENTO');
  assert.strictEqual(CC.computeAccion({ isNew: true, hasPrice: true }), 'ALTA, PRECIO');
  assert.strictEqual(CC.computeAccion({ hasPrice: true, hasEnrich: true }), 'PRECIO, ENRIQUECIMIENTO');
  assert.strictEqual(CC.computeAccion({}), '');
});

test('buildDetalle: ALTA', () => {
  assert.strictEqual(CC.buildDetalle({ accion: 'ALTA' }), 'PN creado vía carga masiva');
});

test('buildDetalle: PRECIO sin anterior → solo el nuevo', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'PRECIO', precioNuevo: 13.8, divisa: 'USD', precioAnterior: null }),
    '13.8 USD'
  );
});

test('buildDetalle: PRECIO con anterior → ant → nvo', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'PRECIO', precioAnterior: 12.5, precioNuevo: 13.8, divisa: 'USD' }),
    '12.5 → 13.8 USD'
  );
});

test('buildDetalle: ENRIQUECIMIENTO lista campos', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'ENRIQUECIMIENTO', enrichFields: ['specs', 'proceso'] }),
    'Enriquecimiento: specs, proceso'
  );
});

test('buildDetalle: combinado une segmentos con " · "', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'PRECIO, ENRIQUECIMIENTO', precioNuevo: 13.8, divisa: 'USD', enrichFields: ['specs'] }),
    '13.8 USD · Enriquecimiento: specs'
  );
});

test('buildDetalle: accion vacía → string vacío', () => {
  assert.strictEqual(CC.buildDetalle({ accion: '' }), '');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: FAIL — `CC.computeAccion is not a function`.

- [ ] **Step 3: Implementar las funciones**

En `remote/scripts/bulk-upload-cc.js`, agregar estas funciones antes de la línea `const api = {`:

```js
  // Construye el token de Accion combinando lo que cambió, en orden canónico.
  function computeAccion(flags) {
    const tokens = [];
    if (flags && flags.isNew) tokens.push('ALTA');
    if (flags && flags.hasPrice) tokens.push('PRECIO');
    if (flags && flags.hasEnrich) tokens.push('ENRIQUECIMIENTO');
    return tokens.join(', ');
  }

  // Detalle legible del evento. Best-effort en precio anterior.
  function buildDetalle(opts) {
    const accion = (opts && opts.accion) || '';
    const segs = [];
    if (accion.indexOf('ALTA') !== -1) segs.push('PN creado vía carga masiva');
    if (accion.indexOf('PRECIO') !== -1) {
      const div = (opts.divisa || '').trim();
      const nuevo = opts.precioNuevo;
      const ant = opts.precioAnterior;
      if (ant != null && ant !== '') {
        segs.push(`${ant} → ${nuevo} ${div}`.trim());
      } else {
        segs.push(`${nuevo} ${div}`.trim());
      }
    }
    if (accion.indexOf('ENRIQUECIMIENTO') !== -1) {
      const fields = (opts.enrichFields && opts.enrichFields.length) ? opts.enrichFields.join(', ') : 'campos';
      segs.push(`Enriquecimiento: ${fields}`);
    }
    return segs.join(' · ');
  }
```

Y agregar `computeAccion, buildDetalle,` al objeto `api`:

```js
  const api = { pickMostRecent, decideBlankAcabados, computeAccion, buildDetalle, VERSION: '1.0.0' };
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: PASS — 12 tests passing.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload-cc.js tools/test_bulk_upload_cc.js
git commit -m "feat(bulk-upload-cc): computeAccion + buildDetalle (Feature B contenido)"
```

---

## Task 3: Helpers de evento (`buildControlCambiosEntry`, `appendControlCambios`)

**Files:**
- Modify: `remote/scripts/bulk-upload-cc.js`
- Modify: `tools/test_bulk_upload_cc.js`

- [ ] **Step 1: Agregar tests que fallan**

Agregar al final de `tools/test_bulk_upload_cc.js`:

```js
test('buildControlCambiosEntry: nombres exactos del schema', () => {
  const e = CC.buildControlCambiosEntry({
    accion: 'PRECIO', detalle: '12.5 → 13.8 USD', usuario: 'OMAR FIDEL VIAZCAN GOMEZ',
    version: '1.6.37', nowIso: '2026-06-04T18:22:00.000Z',
  });
  assert.deepStrictEqual(e, {
    Fecha: '2026-06-04T18:22:00.000Z',
    Usuario: 'OMAR FIDEL VIAZCAN GOMEZ',
    Accion: 'PRECIO',
    Detalle: '12.5 → 13.8 USD',
    Version: '1.6.37',
  });
});

test('buildControlCambiosEntry: usuario faltante → (desconocido)', () => {
  const e = CC.buildControlCambiosEntry({ accion: 'ALTA', detalle: '', usuario: null, version: '1.6.37', nowIso: 'x' });
  assert.strictEqual(e.Usuario, '(desconocido)');
});

test('appendControlCambios: crea el array si no existe', () => {
  const ci = { NotasAdicionales: 'hola' };
  CC.appendControlCambios(ci, { Accion: 'ALTA' });
  assert.deepStrictEqual(ci.ControlCambios, [{ Accion: 'ALTA' }]);
  assert.strictEqual(ci.NotasAdicionales, 'hola');
});

test('appendControlCambios: preserva historial previo', () => {
  const ci = { ControlCambios: [{ Accion: 'prueba' }] };
  CC.appendControlCambios(ci, { Accion: 'PRECIO' });
  assert.deepStrictEqual(ci.ControlCambios, [{ Accion: 'prueba' }, { Accion: 'PRECIO' }]);
});

test('appendControlCambios: ci null no rompe', () => {
  assert.strictEqual(CC.appendControlCambios(null, { Accion: 'ALTA' }), null);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: FAIL — `CC.buildControlCambiosEntry is not a function`.

- [ ] **Step 3: Implementar las funciones**

En `remote/scripts/bulk-upload-cc.js`, agregar antes de `const api = {`:

```js
  // Arma una entrada del Control de Cambios con los nombres EXACTOS del schema 3932.
  function buildControlCambiosEntry(opts) {
    return {
      Fecha: (opts && opts.nowIso) || '',
      Usuario: (opts && opts.usuario) || '(desconocido)',
      Accion: (opts && opts.accion) || '',
      Detalle: (opts && opts.detalle) || '',
      Version: (opts && opts.version) || '',
    };
  }

  // Append no-destructivo a ci.ControlCambios. Crea el array si no existe.
  // Devuelve ci (o null si ci no es objeto).
  function appendControlCambios(ci, entry) {
    if (!ci || typeof ci !== 'object') return ci;
    if (!Array.isArray(ci.ControlCambios)) ci.ControlCambios = [];
    ci.ControlCambios.push(entry);
    return ci;
  }
```

Y actualizar el objeto `api`:

```js
  const api = {
    pickMostRecent, decideBlankAcabados, computeAccion, buildDetalle,
    buildControlCambiosEntry, appendControlCambios, VERSION: '1.0.0',
  };
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: PASS — 17 tests passing.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload-cc.js tools/test_bulk_upload_cc.js
git commit -m "feat(bulk-upload-cc): buildControlCambiosEntry + appendControlCambios"
```

---

## Task 4: Registrar el módulo y bumps en `config.json`

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Agregar el script `bulk-upload-cc.js` antes de `bulk-upload.js` en cada lista de scripts**

El módulo helper debe cargarse ANTES de `bulk-upload.js` en TODA lista donde aparezca `bulk-upload.js` (orden de carga = orden del array). Hay (al menos) dos: el array `scripts` del applet `"id": "carga-masiva"` y el array `scripts` top-level del config. Sus formatos de whitespace pueden diferir, así que NO uses un solo `replace_all` a ciegas.

Procedimiento:

1. Localizar todas las ocurrencias:
   Run: `grep -n '"scripts/bulk-upload.js"' remote/config.json`
   (anota cada línea — debería haber 2)
2. Para CADA ocurrencia, leer la línea exacta y hacer un Edit que inserte `"scripts/bulk-upload-cc.js", ` inmediatamente antes de `"scripts/bulk-upload.js"`. Ejemplo (línea del applet carga-masiva):

   old_string:
   ```
   "scripts/steelhead-api.js", "scripts/bulk-upload.js", "scripts/catalog-fetcher.js"
   ```
   new_string:
   ```
   "scripts/steelhead-api.js", "scripts/bulk-upload-cc.js", "scripts/bulk-upload.js", "scripts/catalog-fetcher.js"
   ```
   Si las dos ocurrencias resultan tener EXACTAMENTE ese mismo substring, un `replace_all: true` sobre `"scripts/steelhead-api.js", "scripts/bulk-upload.js"` → `"scripts/steelhead-api.js", "scripts/bulk-upload-cc.js", "scripts/bulk-upload.js"` las cubre ambas de una. Si difieren (p. ej. multilínea), hacer un Edit por ocurrencia leyendo el contexto real primero.

- [ ] **Step 2: Bump version + lastUpdated**

Edit:
old_string: `  "version": "1.6.36",`
new_string: `  "version": "1.6.37",`

Edit (ajustar el valor real de lastUpdated que tenga el archivo; localizar la clave `"lastUpdated"` y ponerle `"2026-06-04"`).

- [ ] **Step 3: Bump inputSchemaId_PN a 3932**

Edit:
old_string: `      "inputSchemaId_PN": 3456,`
new_string: `      "inputSchemaId_PN": 3932,`

- [ ] **Step 4: Verificar que el JSON sigue siendo válido**

Run: `python3 -c "import json; d=json.load(open('remote/config.json')); print('OK', d['version'], d['steelhead']['inputSchemaId_PN'] if 'inputSchemaId_PN' in str(d) else '?')"`
Expected: imprime `OK 1.6.37` sin excepción. Si la ruta del print falla, basta con que `json.load` no lance.

Run: `grep -c "bulk-upload-cc.js" remote/config.json`
Expected: `2`

- [ ] **Step 5: Commit**

```bash
git add remote/config.json
git commit -m "chore(config 1.6.37): registrar bulk-upload-cc.js + inputSchemaId_PN 3932"
```

---

## Task 5: `inputSchemaId` dinámico en `bulk-upload.js`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Declarar `runtimeInputSchemaId` en `execute` con default**

Edit (línea 3215-3217). old_string:
```
  async function execute(csvText) {
    const DOMAIN = api().getDomain();
    const errors = [];
```
new_string:
```
  async function execute(csvText) {
    const DOMAIN = api().getDomain();
    // 1.5.20: inputSchemaId vigente del dominio (3932 en TLC). Default al hardcoded
    // de config; se sobreescribe con latestSchema.id tras GetPartNumbersInputSchema.
    let runtimeInputSchemaId = DOMAIN.inputSchemaId_PN;
    const errors = [];
```

- [ ] **Step 2: Asignar `runtimeInputSchemaId` desde `latestSchema`**

Edit (línea 3875-3880). old_string:
```
        if (latestSchema) {
          const schemaProps = latestSchema.inputSchema?.properties || {};
          metalBaseEnum = schemaProps.DatosAdicionalesNP?.properties?.BaseMetal?.enum || [];
          satEnum = schemaProps.DatosFacturacion?.properties?.CodigoSAT?.enum || [];
          log(`  Schema loaded: ${metalBaseEnum.length} metales, ${satEnum.length} SAT`);
        }
```
new_string:
```
        if (latestSchema) {
          if (latestSchema.id) runtimeInputSchemaId = latestSchema.id;
          const schemaProps = latestSchema.inputSchema?.properties || {};
          metalBaseEnum = schemaProps.DatosAdicionalesNP?.properties?.BaseMetal?.enum || [];
          satEnum = schemaProps.DatosFacturacion?.properties?.CodigoSAT?.enum || [];
          log(`  Schema loaded: id=${runtimeInputSchemaId}, ${metalBaseEnum.length} metales, ${satEnum.length} SAT`);
        }
```

- [ ] **Step 3: Reemplazar las 5 ocurrencias de `DOMAIN.inputSchemaId_PN`**

Aplicar 5 Edits independientes (cada `old_string` es único por su contexto):

Edit A (4081):
old_string: `          inputSchemaId: DOMAIN.inputSchemaId_PN, customInputs: {},`
new_string: `          inputSchemaId: runtimeInputSchemaId, customInputs: {},`

Edit B (4322):
old_string:
```
                defaultProcessNodeId: (pnNode.processNodeByDefaultProcessNodeId?.id ?? pnNode.defaultProcessNodeId) || target.part.processId,
                inputSchemaId: DOMAIN.inputSchemaId_PN,
```
new_string:
```
                defaultProcessNodeId: (pnNode.processNodeByDefaultProcessNodeId?.id ?? pnNode.defaultProcessNodeId) || target.part.processId,
                inputSchemaId: runtimeInputSchemaId,
```

Edit C (5231):
old_string:
```
            customInputs: mergedCI || existingPnNode?.customInputs || pn.customInputs || {},
            inputSchemaId: DOMAIN.inputSchemaId_PN,
            labelIds: labelIdsToSend,
```
new_string:
```
            customInputs: mergedCI || existingPnNode?.customInputs || pn.customInputs || {},
            inputSchemaId: runtimeInputSchemaId,
            labelIds: labelIdsToSend,
```

Edit D (5416):
old_string: `          customInputs: mergedCI || existingPnNode?.customInputs || pn.customInputs || {}, inputSchemaId: DOMAIN.inputSchemaId_PN, labelIds: labelIdsToSend,`
new_string: `          customInputs: mergedCI || existingPnNode?.customInputs || pn.customInputs || {}, inputSchemaId: runtimeInputSchemaId, labelIds: labelIdsToSend,`

Edit E (5894):
old_string:
```
              defaultProcessNodeId: (pnNode.processNodeByDefaultProcessNodeId?.id ?? pnNode.defaultProcessNodeId) || part.processId,
              inputSchemaId: DOMAIN.inputSchemaId_PN,
```
new_string:
```
              defaultProcessNodeId: (pnNode.processNodeByDefaultProcessNodeId?.id ?? pnNode.defaultProcessNodeId) || part.processId,
              inputSchemaId: runtimeInputSchemaId,
```

(La línea 5518 usa `pnInput.inputSchemaId` por referencia — hereda `runtimeInputSchemaId` automáticamente, no se toca.)

- [ ] **Step 4: Verificar sintaxis y que no quede ningún `DOMAIN.inputSchemaId_PN` de PN**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin salida (sintaxis OK).

Run: `grep -n "DOMAIN.inputSchemaId_PN" remote/scripts/bulk-upload.js`
Expected: **sin resultados** (las 5 se reemplazaron; `inputSchemaId_Quote` no usa esta constante).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "fix(bulk-upload): inputSchemaId dinámico (latestSchema.id) — deja de degradar PNs a 3456"
```

---

## Task 6: `currentUserName` vía `CurrentUserDetails`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Capturar el usuario logueado al inicio de `execute`**

Edit (sobre el bloque ya modificado en Task 5 Step 1). old_string:
```
    // 1.5.20: inputSchemaId vigente del dominio (3932 en TLC). Default al hardcoded
    // de config; se sobreescribe con latestSchema.id tras GetPartNumbersInputSchema.
    let runtimeInputSchemaId = DOMAIN.inputSchemaId_PN;
    const errors = [];
```
new_string:
```
    // 1.5.20: inputSchemaId vigente del dominio (3932 en TLC). Default al hardcoded
    // de config; se sobreescribe con latestSchema.id tras GetPartNumbersInputSchema.
    let runtimeInputSchemaId = DOMAIN.inputSchemaId_PN;
    // 1.5.20: identidad para el footprint de ControlCambios. Best-effort: si falla,
    // se estampa "(desconocido)" y la corrida continúa.
    let currentUserName = '(desconocido)';
    try {
      const cuData = await api().query('CurrentUserDetails', {}, 'CurrentUserDetails');
      currentUserName = cuData?.currentSession?.userByUserId?.name || '(desconocido)';
    } catch (_) {}
    const errors = [];
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin salida.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "feat(bulk-upload): capturar currentUserName (CurrentUserDetails) para footprint"
```

---

## Task 7: Feature A — rama blank-acabados + `autoDecided`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Insertar la rama nueva en `classifyOnePN` Pase 3**

Edit (entre el cierre del `if (labelsMatchFull)` y el comentario del blankCandidate). old_string:
```
          candidates: ranked,
        };
      }
      // 1.2.9: fallback a candidato sin-etiqueta si existe.
      const blankCandidate = ranked.find(c => acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === '');
```
new_string:
```
          candidates: ranked,
        };
      }
      // 1.5.20 (Feature A): si el upload NO trae acabados (csvAcabados === ''),
      // no es señal de "quiero nuevo" — defaultear a MODIFICAR el PN activo más
      // reciente. Auto si hay 1 candidato; requiere confirmar si hay 2+. Si el
      // upload trae acabados no vacíos que difieren, NO entra acá (sigue a NEW).
      if (csvAcabados === '' && typeof window !== 'undefined' && window.SteelheadBulkCC) {
        const decision = window.SteelheadBulkCC.decideBlankAcabados(nameCandidates);
        if (decision) {
          return {
            classification: 'MODIFY',
            pase: 3,
            confidence: 'name+blank-csv-recent',
            targetPnId: decision.targetPnId,
            wasArchived: false,
            candidates: ranked,
            autoDecided: decision.autoDecided,
          };
        }
      }
      // 1.2.9: fallback a candidato sin-etiqueta si existe.
      const blankCandidate = ranked.find(c => acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === '');
```

- [ ] **Step 2: Respetar `autoDecided` en `buildClassifiedRow`**

Edit (línea 1965-1971). old_string:
```
      userOverride: null,
      // 1.4.5: separar "el operador ya validó esta fila" de "el operador eligió
      // algo distinto al default". Antes usábamos userOverride!=null para ambos,
      // pero re-seleccionar el default propuesto resetea userOverride a null y la
      // fila vuelve a aparecer como pendiente — UX confusa.
      userDecided: false,
      targetPnId: cls.targetPnId,
```
new_string:
```
      userOverride: null,
      // 1.4.5: separar "el operador ya validó esta fila" de "el operador eligió
      // algo distinto al default". Antes usábamos userOverride!=null para ambos,
      // pero re-seleccionar el default propuesto resetea userOverride a null y la
      // fila vuelve a aparecer como pendiente — UX confusa.
      // 1.5.20: blank-acabados con 1 candidato auto-valida (cls.autoDecided===true);
      // con 2+ queda en false para que el operador confirme en el dropdown.
      userDecided: cls.autoDecided === true,
      targetPnId: cls.targetPnId,
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin salida.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "feat(bulk-upload): Feature A — acabados vacíos defaultean a MODIFY del más reciente"
```

---

## Task 8: Feature B — enganche de ControlCambios en `enrichWorker`

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Cambiar `const mergedCI` a `let mergedCI`**

Edit (línea 5179). old_string:
```
        const mergedCI = mergeCustomInputs(existingPnNode?.customInputs ?? pn.customInputs, part);
```
new_string:
```
        let mergedCI = mergeCustomInputs(existingPnNode?.customInputs ?? pn.customInputs, part);
```

- [ ] **Step 2: Insertar el bloque de ControlCambios justo antes de `const pnInput` (Call B)**

Edit (línea 5411-5412). old_string:
```
        // 1.5.16: FK fallback en customerId (scalar bugged). Ver nota en línea ~4305.
        const pnInput = {
```
new_string:
```
        // 1.5.20 (Feature B): footprint en customInputs.ControlCambios. Se engancha
        // ACÁ (no en línea 5179) porque specsToApplyFiltered/dims/labelIdsToSend/
        // pnProcessId ya están resueltos. Solo se appendea si hubo cambio real.
        // mergedCI se modifica por referencia → Call B (pnInput, abajo) lo lleva.
        if (typeof window !== 'undefined' && window.SteelheadBulkCC) {
          // typeof-guards: estas variables se definen más arriba en enrichWorker,
          // pero el guard evita un ReferenceError si alguna rama no las hubiera
          // declarado en este punto. part.* es siempre seguro (part siempre existe).
          const ccIsNew = !existingPnNode;
          const ccHasPrice = part.precio != null && !isDash(part.precio);
          const ccEnrichFields = [];
          if (typeof specsToApplyFiltered !== 'undefined' && specsToApplyFiltered && specsToApplyFiltered.length) ccEnrichFields.push('specs');
          if (typeof dims !== 'undefined' && dims && dims.length) ccEnrichFields.push('dims');
          if (typeof labelIdsToSend !== 'undefined' && labelIdsToSend && labelIdsToSend.length) ccEnrichFields.push('labels');
          if (part.metalBase && !isDash(part.metalBase)) ccEnrichFields.push('metal');
          if (typeof pnProcessId !== 'undefined' && pnProcessId) ccEnrichFields.push('proceso');
          const ccAccion = window.SteelheadBulkCC.computeAccion({
            isNew: ccIsNew, hasPrice: ccHasPrice, hasEnrich: ccEnrichFields.length > 0,
          });
          if (ccAccion) {
            if (!mergedCI) mergedCI = {};
            const ccDetalle = window.SteelheadBulkCC.buildDetalle({
              accion: ccAccion, precioAnterior: null, precioNuevo: part.precio,
              divisa: part.divisa, enrichFields: ccEnrichFields,
            });
            const ccEntry = window.SteelheadBulkCC.buildControlCambiosEntry({
              accion: ccAccion, detalle: ccDetalle, usuario: currentUserName,
              version: bulkCfg().version || VERSION, nowIso: new Date().toISOString(),
            });
            window.SteelheadBulkCC.appendControlCambios(mergedCI, ccEntry);
          }
        }
        // 1.5.16: FK fallback en customerId (scalar bugged). Ver nota en línea ~4305.
        const pnInput = {
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin salida.

Run: `grep -n "appendControlCambios\|let mergedCI" remote/scripts/bulk-upload.js`
Expected: una ocurrencia de `let mergedCI` y una de `appendControlCambios`.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "feat(bulk-upload): Feature B — append a customInputs.ControlCambios si hubo cambio real"
```

---

## Task 9: Badge en el preview + bump VERSION del applet

**Files:**
- Modify: `remote/scripts/bulk-upload.js`

- [ ] **Step 1: Insertar el chip "auto: NP más reciente" en `showPreview`**

Edit (línea 2373-2375). old_string:
```
          const pnNameSpan = document.createElement('span');
          pnNameSpan.textContent = r.pn;
          tdPN.appendChild(pnNameSpan);
```
new_string:
```
          const pnNameSpan = document.createElement('span');
          pnNameSpan.textContent = r.pn;
          tdPN.appendChild(pnNameSpan);
          // 1.5.20 (Feature A): badge para filas defaulteadas al PN más reciente por
          // acabados vacíos. Estilo inline para no depender de clases CSS.
          if (r.confidence === 'name+blank-csv-recent') {
            const ccChip = document.createElement('span');
            ccChip.textContent = 'auto: NP más reciente';
            ccChip.title = 'Acabados vacíos en el upload → se defaulteó al PN activo más reciente. Puedes cambiarlo en el dropdown.';
            ccChip.style.cssText = 'margin-left:6px;padding:1px 6px;border-radius:8px;background:#1e3a5f;color:#7dd3fc;font-size:10px;font-family:sans-serif;white-space:nowrap;';
            tdPN.appendChild(ccChip);
          }
```

- [ ] **Step 2: Bump VERSION del applet**

Edit (línea 188). old_string: `  const VERSION = '1.5.19';`
new_string: `  const VERSION = '1.5.20';`

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check remote/scripts/bulk-upload.js`
Expected: sin salida.

- [ ] **Step 4: Re-correr los tests de helpers (regresión)**

Run: `node --test tools/test_bulk_upload_cc.js`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/bulk-upload.js
git commit -m "feat(bulk-upload 1.5.20): badge 'auto: NP más reciente' en preview + bump VERSION"
```

---

## Task 10: Deploy a `gh-pages`

**Files:**
- Modify: rama `gh-pages` (`scripts/bulk-upload-cc.js`, `scripts/bulk-upload.js`, `config.json`)

- [ ] **Step 1: Guardar WIP no relacionado y cambiar a gh-pages**

```bash
git stash push -u -- "Plantilla_Cotizaciones*.xlsm" 2>/dev/null || true
git checkout gh-pages
```
(Si `git checkout` se queja por el `.xlsm` modificado, hacer `git stash` general primero. NO tocar el worktree de otra sesión.)

- [ ] **Step 2: Sincronizar los 3 archivos desde main (estructura aplanada)**

```bash
git show main:remote/scripts/bulk-upload-cc.js > scripts/bulk-upload-cc.js
git show main:remote/scripts/bulk-upload.js   > scripts/bulk-upload.js
git show main:remote/config.json              > config.json
git add scripts/bulk-upload-cc.js scripts/bulk-upload.js config.json
git commit -m "deploy: bulk-upload 1.5.20 (precios + ControlCambios + inputSchemaId dinámico) + bump 1.6.37"
```

- [ ] **Step 3: Push ambas ramas**

```bash
git checkout main
git push origin main && git push origin gh-pages
```

- [ ] **Step 4: Verificar byte-exact tras ~30-60s**

Run: `tools/check-deploy.sh bulk-upload.js`
Expected: reporta sync OK para bulk-upload.js.

Run: `git diff main:remote/scripts/bulk-upload-cc.js gh-pages:scripts/bulk-upload-cc.js`
Expected: sin diferencias.

---

## Task 11: Piloto de validación (manual, en el navegador)

**No automatizable** (requiere la SPA de Steelhead + sesión). Ejecutar con el usuario.

- [ ] **Step 1: Recargar la extensión**

`chrome://extensions` → reload de SteelheadAutomator (o reiniciar Chrome). Confirmar en consola que `config.version === '1.6.37'` y que `window.SteelheadBulkCC` existe tras abrir el applet carga-masiva.

- [ ] **Step 2: Caso solo-precio sin labels (Feature A)**

Subir un CSV con 3-5 PNs existentes (cliente Tipsa o Schneider), solo NP + precio, sin acabados. En el preview:
- Verificar que NO sugiere "CREAR NUEVO".
- Con 1 candidato por nombre: fila con badge "auto: NP más reciente", chip "✓ validada".
- Con 2+ candidatos: dropdown preseleccionado al más reciente, exige confirmar.

- [ ] **Step 3: Ejecutar y verificar preserve-on-missing + precio**

Tras la corrida, consultar el PN (GetPartNumber) y verificar:
- Proceso, specs, dims, NotasAdicionales y demás customInputs intactos (nada blanqueado).
- `inputSchemaId === 3932`.
- Precio actualizado; default price correcto.

Comando de consulta (desde el proyecto Reportes SH):
```bash
cd "/Users/oviazcan/Projects/Ecoplating/Reportes SH" && python3 - <<'PY'
import sys, json, warnings; warnings.filterwarnings("ignore")
sys.path.insert(0, "scripts"); import steelhead_client as sc
sc.PERSISTED_QUERIES["GetPartNumber"] = "60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2"
c = sc.client_from_env(domain="tlc")
pn = c.call("GetPartNumber", {"partNumberId": <PN_ID>, "usagesLimit": 0, "usagesOffset": 0})["partNumberById"]
ci = pn["customInputs"]; ci = json.loads(ci) if isinstance(ci, str) else ci
print("inputSchemaId:", pn["inputSchemaId"])
print("ControlCambios:", json.dumps(ci.get("ControlCambios"), indent=2, ensure_ascii=False))
PY
```

- [ ] **Step 4: Verificar ControlCambios**

En el resultado anterior:
- Hay una entrada nueva con `Accion: "PRECIO"`, `Detalle` con el precio, `Usuario` correcto, `Version: "1.6.37"`.
- Se preservaron las entradas previas (el historial NO se borró).

- [ ] **Step 5: Caso de migración de schema viejo**

Tomar un PN que esté en `inputSchemaId 3456` (PN viejo), subirlo con un cambio. Verificar que tras la corrida queda en `3932` y que el guardado no falla por el `required: ['BaseMetal']` del schema nuevo.

- [ ] **Step 6: Actualizar la bitácora del applet**

Documentar en `docs/applets/bulk-upload.md` la versión 1.5.20 (Feature A + Feature B + inputSchemaId dinámico), resultados del piloto y la nota de fallback MTY (el hardcoded 3932 es de TLC; en MTY el runtime usa el vigente del dominio, pero el fallback ante query-fail sería impreciso). Actualizar el índice en `CLAUDE.md`.

---

## Riesgos y notas

- **Fallback MTY:** `inputSchemaId_PN: 3932` en config es de TLC. El `runtimeInputSchemaId` dinámico resuelve el correcto por dominio; el hardcoded solo se usa si `GetPartNumbersInputSchema` falla, en cuyo caso en MTY sería impreciso. Aceptable: el piloto es TLC y la query rara vez falla.
- **`required: ['BaseMetal']` en 3932:** migrar PNs viejos sin BaseMetal — el backend tolera (validación required es solo UI/RJSF). Validar en Task 11 Step 5.
- **Call A vs Call B:** la entrada de ControlCambios se appendea antes de Call B; Call A (que corre antes) no la lleva, pero Call B hace REPLACE de `customInputs` y deja el estado final correcto.
- **Degradación segura:** si `window.SteelheadBulkCC` no cargó (deploy incompleto), Feature A cae al comportamiento actual (NEW) y Feature B no escribe — sin romper la corrida.
- **Precio anterior:** se deja `precioAnterior: null` (best-effort). Mejora futura: leerlo de `existingPnNode.partNumberPricesByPartNumberId`.
