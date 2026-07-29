# Reaplicar Parámetros en OTs — Fase 1

> **Para trabajadores agénticos:** SUB-SKILL REQUERIDA: usa `superpowers:subagent-driven-development` (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos usan casillas (`- [ ]`).

**Goal:** Un modo nuevo del bundle "Ajuste Masivo de Specs" que alinea los parámetros de las specs de una Orden de Trabajo con los de su Número de Parte, sobre una OT abierta en pantalla o sobre una lista de OTs pegada.

**Architecture:** Núcleo puro (`wo-spec-params-core.js`) que recibe las respuestas crudas de dos consultas y devuelve un plan de escritura, sin red ni DOM — todo testeable con `node --test`. Un glue (`wo-spec-params.js`) que consulta, dibuja el panel dark-mode, pide confirmación y escribe. La clasificación se hace por **casilla** = par `(recipeNodeId, specFieldId)`.

**Tech Stack:** JavaScript vanilla (sin frameworks, sin bundlers), `node --test` + `node:assert/strict`, GraphQL con persisted queries sobre `app.gosteelhead.com`.

**Spec:** [`docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md`](../specs/2026-07-28-wo-spec-params-reapply-design.md) — léelo antes de empezar. Todo aquí deriva de ahí y **está verificado en vivo** (§8).

## Global Constraints

- **JavaScript vanilla.** Sin React, sin frameworks, sin bundlers, sin dependencias npm nuevas.
- **Código e identificadores en inglés; comentarios, UI y documentación en español.** Con acentos correctos.
- **UI propia en tema oscuro**: base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento verde `#13a36f`. Es la señal de que no es pantalla nativa de Steelhead.
- **Nunca `innerHTML` con datos que vengan de GraphQL o del usuario** (nombres de spec, de campo, de NP). Usa `textContent` o escapa.
- **Anclaje: estructura antes que texto.** Si hay que anclar por texto de la UI de Steelhead, bilingüe ES+EN, y solo como red que amplía el match.
- **La UI de entrada se monta siempre que la ruta aplique**, nunca detrás del gate de estado del applet.
- **Los hashes van en `remote/config.json`**, jamás incrustados en el script.
- Suite completa: `node --test tools/test/`. Debe quedar verde antes de cada commit.
- Rama de trabajo: `workbench`. **No deployar** en esta fase.

## Contrato de datos (verificado en vivo)

```js
// Fila aplicada en la OT (partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes[])
{ id, archivedAt, partNumberId, specFieldId, recipeNodeId,
  partNumberWorkOrderSpecByDrivenBy: { id },        // el drivenBy de las escrituras
  specFieldParamBySpecFieldParamId: {
    id, name, isDefault, minimumValue, maximumValue, targetValue, unitId,
    specFieldParamByDerivedFromId: { id, name },     // el id del CATÁLOGO del que desciende
    specFieldSpecBySpecFieldSpecId: { id, specBySpecId: {id,name}, specFieldBySpecFieldId: {id,name} } } }

// Catálogo (partNumberWorkOrderSpecsByWorkOrderId.nodes[].specBySpecId.specFieldSpecsBySpecId.nodes[])
{ id, archivedAt, specFieldId, isGeneric,
  specFieldParamsBySpecFieldSpecId: { nodes: [{ id, name }] },   // ojo: SOLO id y name
  specFieldBySpecFieldId: { id, name, type } }

// Parámetro del NP (partNumberSpecFieldParamsByPartNumberId.nodes[]) — mismo shape que la fila aplicada,
// sin recipeNodeId ni drivenBy.
```

**Los tres ids que no hay que confundir:**
| | Qué es | Para qué sirve |
|---|---|---|
| `fila.id` | id del `PartNumberRecipeNodeSpecFieldParam` | lo que se **archiva** |
| `specFieldParamBySpecFieldParamId.id` | el clon | no se manda nunca |
| `specFieldParamByDerivedFromId.id` | el id del **catálogo** | lo que se **escribe** y con lo que se **compara** |

---

### Task 1: Índices — mapa del NP y catálogo de la OT

**Files:**
- Create: `remote/scripts/wo-spec-params-core.js`
- Test: `tools/test/wo-spec-params-core.test.js`
- Usa (ya existe): `tools/test/fixtures/wo-spec-params-5769.json`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `rootParamId(specFieldParam) -> number|null` — el id del catálogo del que desciende (`derivedFromId ?? id`)
  - `buildPartNumberIndex(partNumber) -> Map<specFieldSpecId, {param, rowId, ambiguous}>`
  - `buildCatalogIndex(workOrder) -> Map<specFieldId, Array<{specFieldSpecId, pnwosId, specName, specId, fieldName, params:[{id,name}]}>>`

- [ ] **Step 1: Escribe el test que falla**

```js
// tools/test/wo-spec-params-core.test.js
// Golden tests del módulo puro wo-spec-params-core.js
// Run: node --test tools/test/wo-spec-params-core.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params-core.js'));
const Core = global.window.WoSpecParamsCore;

const FIX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-5769.json'), 'utf8'));

test('rootParamId: usa derivedFrom cuando existe, el propio id si no', () => {
  assert.equal(Core.rootParamId({ id: 34924257, specFieldParamByDerivedFromId: { id: 12533622 } }), 12533622);
  assert.equal(Core.rootParamId({ id: 17544252, specFieldParamByDerivedFromId: null }), 17544252);
  assert.equal(Core.rootParamId(null), null);
  assert.equal(Core.rootParamId({}), null);
});

test('buildPartNumberIndex: solo activos, indexado por specFieldSpecId', () => {
  const idx = Core.buildPartNumberIndex(FIX.partNumber);
  // 13 filas, 3 archivadas → 10 activas, pero dos comparten specFieldSpec distinto
  // El Espesor de la spec Estaño (sfs 106115) tiene 3 archivadas y 1 activa: gana la activa.
  const espesor = idx.get(106115);
  assert.ok(espesor, 'debe existir entrada para el specFieldSpec 106115');
  assert.equal(espesor.param.id, 33666976);
  assert.equal(espesor.param.name, '5 - 10 µm');
  assert.equal(espesor.ambiguous, false);
  // el archivado 28818108 NO debe ganar
  assert.notEqual(espesor.param.id, 28818108);
});

test('buildPartNumberIndex: marca ambiguo si hay 2+ activos en el mismo specFieldSpec', () => {
  const pn = {
    partNumberSpecFieldParamsByPartNumberId: { nodes: [
      { id: 1, archivedAt: null, specFieldParamBySpecFieldParamId: {
          id: 10, name: 'A', specFieldSpecBySpecFieldSpecId: { id: 500 } } },
      { id: 2, archivedAt: null, specFieldParamBySpecFieldParamId: {
          id: 11, name: 'B', specFieldSpecBySpecFieldSpecId: { id: 500 } } },
    ] }
  };
  const idx = Core.buildPartNumberIndex(pn);
  assert.equal(idx.get(500).ambiguous, true);
});

test('buildCatalogIndex: agrupa por specFieldId y omite specFieldSpecs archivados', () => {
  const idx = Core.buildCatalogIndex(FIX.workOrder);
  const espesor = idx.get(15630);
  assert.ok(espesor && espesor.length >= 1);
  const estano = espesor.find(c => c.specFieldSpecId === 106115);
  assert.ok(estano, 'el specFieldSpec 106115 debe estar');
  assert.equal(estano.pnwosId, 5063398);
  assert.deepEqual(estano.params.map(p => p.id).sort(), [12533622, 32594227]);
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'rootParamId')`, porque el core no existe.

- [ ] **Step 3: Escribe la implementación mínima**

```js
// remote/scripts/wo-spec-params-core.js
// Reaplicar parámetros a las specs de una Orden de Trabajo — módulo PURO (sin DOM ni red).
//
// Problema: Steelhead copia los parámetros del Número de Parte a la OT cuando la crea, y esa
// copia no se refresca. Las OTs generadas antes de una corrección masiva de NP conservan el
// criterio viejo.
//
// La unidad de decisión es la CASILLA = (recipeNodeId, specFieldId). Una sola fila viva por
// casilla (lección de bulk-upload 1.4.38: el SpecField agrupa, no el SpecFieldParam).
//
// OJO — el ERP CLONA el parámetro al aplicarlo: pides el id del catálogo y queda un clon nuevo
// que guarda su origen en specFieldParamByDerivedFromId. Por eso todo se normaliza con
// rootParamId() antes de comparar. Verificado en vivo el 2026-07-28; ver
// docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md
(function () {
  'use strict';

  // El id del catálogo del que desciende un specFieldParam. Es lo que se compara y lo que se
  // escribe — nunca el id del clon.
  function rootParamId(specFieldParam) {
    if (!specFieldParam) return null;
    const df = specFieldParam.specFieldParamByDerivedFromId;
    if (df && df.id != null) return df.id;
    return specFieldParam.id != null ? specFieldParam.id : null;
  }

  // Parámetros ACTIVOS del NP, indexados por specFieldSpecId (= "este campo de esta spec").
  // Si un specFieldSpec tiene 2+ activos el deseado es indeterminado: se marca ambiguo y el
  // consumidor no debe adivinar (ver spec §5.4).
  function buildPartNumberIndex(partNumber) {
    const out = new Map();
    const nodes = (partNumber
      && partNumber.partNumberSpecFieldParamsByPartNumberId
      && partNumber.partNumberSpecFieldParamsByPartNumberId.nodes) || [];
    for (const row of nodes) {
      if (!row || row.archivedAt) continue;
      const sfp = row.specFieldParamBySpecFieldParamId;
      if (!sfp) continue;
      const sfs = sfp.specFieldSpecBySpecFieldSpecId;
      if (!sfs || sfs.id == null) continue;
      const prev = out.get(sfs.id);
      if (prev) { prev.ambiguous = true; continue; }
      out.set(sfs.id, { param: sfp, rowId: row.id, ambiguous: false });
    }
    return out;
  }

  // Catálogo de la OT: specFieldId → candidatos (uno por spec viva que declare ese campo).
  function buildCatalogIndex(workOrder) {
    const out = new Map();
    const specs = (workOrder
      && workOrder.partNumberWorkOrderSpecsByWorkOrderId
      && workOrder.partNumberWorkOrderSpecsByWorkOrderId.nodes) || [];
    for (const pnwos of specs) {
      if (!pnwos || pnwos.archivedAt) continue;
      const spec = pnwos.specBySpecId;
      if (!spec) continue;
      const fields = (spec.specFieldSpecsBySpecId && spec.specFieldSpecsBySpecId.nodes) || [];
      for (const f of fields) {
        if (!f || f.archivedAt) continue;
        if (f.specFieldId == null) continue;
        if (!out.has(f.specFieldId)) out.set(f.specFieldId, []);
        out.get(f.specFieldId).push({
          specFieldSpecId: f.id,
          pnwosId: pnwos.id,
          specId: spec.id,
          specName: spec.name || '',
          fieldName: (f.specFieldBySpecFieldId && f.specFieldBySpecFieldId.name) || '',
          isGeneric: !!f.isGeneric,
          params: ((f.specFieldParamsBySpecFieldSpecId && f.specFieldParamsBySpecFieldSpecId.nodes) || [])
            .map(p => ({ id: p.id, name: p.name || '' }))
        });
      }
    }
    return out;
  }

  window.WoSpecParamsCore = { rootParamId, buildPartNumberIndex, buildCatalogIndex };
})();
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-spec-params-core.js tools/test/wo-spec-params-core.test.js tools/test/fixtures/wo-spec-params-5769.json
git commit -m "feat(wo-spec-params): índices de NP y catálogo — el id que importa es el del catálogo, no el del clon"
```

---

### Task 2: Resolver el parámetro deseado de una casilla

**Files:**
- Modify: `remote/scripts/wo-spec-params-core.js`
- Test: `tools/test/wo-spec-params-core.test.js`

**Interfaces:**
- Consumes: `buildPartNumberIndex`, `buildCatalogIndex` (Task 1)
- Produces: `resolveDesired(specFieldId, catalogIndex, pnIndex) -> {writeId, compareId, refParam|null, refName, via:'NP'|'CATALOGO', pnwosId, specFieldSpecId} | {via:'AMBIGUO'|'SIN_CATALOGO', reason}`

La cascada (spec §4): el NP manda; si no resuelve y el catálogo ofrece **una sola** opción, esa; si no, ambiguo.

- [ ] **Step 1: Escribe el test que falla**

```js
test('resolveDesired: el NP manda cuando tiene el campo', () => {
  const cat = Core.buildCatalogIndex(FIX.workOrder);
  const pn = Core.buildPartNumberIndex(FIX.partNumber);
  const r = Core.resolveDesired(15630, cat, pn);   // Espesor
  assert.equal(r.via, 'NP');
  assert.equal(r.writeId, 32594227);               // el id del CATÁLOGO, no el clon 33666976
  assert.equal(r.compareId, 32594227);
  assert.equal(r.refName, '5 - 10 µm');
  assert.equal(r.pnwosId, 5063398);
});

test('resolveDesired: cae al catálogo cuando el NP no tiene el campo y hay UNA opción', () => {
  const cat = Core.buildCatalogIndex(FIX.workOrder);
  const pn = Core.buildPartNumberIndex(FIX.partNumber);
  const r = Core.resolveDesired(22547, cat, pn);   // Condiciones Adecuadas — spec de proceso
  assert.equal(r.via, 'CATALOGO');
  assert.equal(r.writeId, 17854613);
  assert.equal(r.refName, 'Sí o No');
});

test('resolveDesired: AMBIGUO si el NP no resuelve y el catálogo ofrece varias', () => {
  const cat = new Map([[999, [{ specFieldSpecId: 1, pnwosId: 7, specName: 'S', fieldName: 'F',
    params: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }]]]);
  const r = Core.resolveDesired(999, cat, new Map());
  assert.equal(r.via, 'AMBIGUO');
});

test('resolveDesired: AMBIGUO si el NP tiene 2+ activos en ese campo', () => {
  const cat = new Map([[999, [{ specFieldSpecId: 500, pnwosId: 7, specName: 'S', fieldName: 'F',
    params: [{ id: 1, name: 'A' }] }]]]);
  const pn = new Map([[500, { param: { id: 10 }, rowId: 1, ambiguous: true }]]);
  const r = Core.resolveDesired(999, cat, pn);
  assert.equal(r.via, 'AMBIGUO');
});

test('resolveDesired: SIN_CATALOGO si el campo no vive en ninguna spec de la OT', () => {
  const r = Core.resolveDesired(424242, new Map(), new Map());
  assert.equal(r.via, 'SIN_CATALOGO');
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: FAIL — `Core.resolveDesired is not a function`.

- [ ] **Step 3: Escribe la implementación**

```js
  // Qué parámetro DEBERÍA tener una casilla. Cascada: el NP manda; si no resuelve y el catálogo
  // ofrece exactamente una opción, esa; si no, ambiguo (y no se toca).
  function resolveDesired(specFieldId, catalogIndex, pnIndex) {
    const candidates = catalogIndex.get(specFieldId) || [];
    if (!candidates.length) return { via: 'SIN_CATALOGO', reason: 'el campo no vive en ninguna spec viva de la OT' };

    for (const c of candidates) {
      const hit = pnIndex.get(c.specFieldSpecId);
      if (!hit) continue;
      if (hit.ambiguous) {
        return { via: 'AMBIGUO', reason: 'el Número de Parte tiene más de un parámetro activo en este campo' };
      }
      const root = rootParamId(hit.param);
      return {
        via: 'NP', writeId: root, compareId: root,
        refParam: hit.param, refName: hit.param.name || '',
        pnwosId: c.pnwosId, specFieldSpecId: c.specFieldSpecId,
        specName: c.specName, fieldName: c.fieldName
      };
    }

    const all = [];
    for (const c of candidates) for (const p of c.params) all.push({ p, c });
    if (all.length === 1) {
      const { p, c } = all[0];
      return {
        via: 'CATALOGO', writeId: p.id, compareId: p.id,
        refParam: null, refName: p.name || '',
        pnwosId: c.pnwosId, specFieldSpecId: c.specFieldSpecId,
        specName: c.specName, fieldName: c.fieldName
      };
    }
    return {
      via: 'AMBIGUO',
      reason: all.length === 0
        ? 'el catálogo de la spec no ofrece ningún parámetro para este campo'
        : 'el Número de Parte no define este campo y el catálogo ofrece ' + all.length + ' opciones'
    };
  }
```

Y agrégala al export: `window.WoSpecParamsCore = { rootParamId, buildPartNumberIndex, buildCatalogIndex, resolveDesired };`

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-spec-params-core.js tools/test/wo-spec-params-core.test.js
git commit -m "feat(wo-spec-params): cascada del deseado — el NP manda, el catálogo decide solo si es unívoco"
```

---

### Task 3: Equivalencia — la cascada que solo puede absolver

**Files:**
- Modify: `remote/scripts/wo-spec-params-core.js`
- Test: `tools/test/wo-spec-params-core.test.js`

**Interfaces:**
- Consumes: `rootParamId` (Task 1)
- Produces: `isEquivalent(appliedParam, desired) -> {ok:boolean, via:'raiz'|'idDirecto'|'identidad'|null}`

**Por qué importa medido en vivo:** de 136 aciertos reales, 132 salieron por identidad y 4 por raíz. Un diseño que confiara solo en la raíz marcaría 134 falsos `DIFIERE` y reescribiría casi toda la orden. Ningún escalón puede declarar `DIFIERE`; solo agotarlos lo hace.

- [ ] **Step 1: Escribe el test que falla**

```js
test('isEquivalent: acierta por raíz de catálogo', () => {
  const applied = { id: 34924257, name: 'x', specFieldParamByDerivedFromId: { id: 12533622 } };
  const r = Core.isEquivalent(applied, { compareId: 12533622, refName: 'otro nombre' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'raiz');
});

test('isEquivalent: acierta por id directo cuando no hay derivedFrom', () => {
  const applied = { id: 17544252, name: 'x', specFieldParamByDerivedFromId: null };
  const r = Core.isEquivalent(applied, { compareId: 17544252, refName: 'y' });
  assert.equal(r.ok, true);
});

test('isEquivalent: acierta por identidad de nombre normalizado (espacios y mayúsculas)', () => {
  const applied = { id: 1, name: 'Si o  No', specFieldParamByDerivedFromId: { id: 17890459 } };
  const r = Core.isEquivalent(applied, { compareId: 17854613, refName: 'sí o no' , refParam: null});
  // OJO: 'Si' sin acento NO es 'Sí' con acento — deben diferir
  assert.equal(r.ok, false);
  const r2 = Core.isEquivalent({ id: 1, name: 'Si o  No', specFieldParamByDerivedFromId: { id: 9 } },
                               { compareId: 8, refName: 'SI O NO', refParam: null });
  assert.equal(r2.ok, true);
  assert.equal(r2.via, 'identidad');
});

test('isEquivalent: con refParam compara también los valores numéricos', () => {
  const applied = { id: 1, name: '5 - 10 µm', minimumValue: 5, maximumValue: 8, targetValue: null, unitId: 3974,
                    specFieldParamByDerivedFromId: { id: 111 } };
  // mismo nombre pero distinto máximo → NO equivale
  const r = Core.isEquivalent(applied, { compareId: 222, refName: '5 - 10 µm',
    refParam: { name: '5 - 10 µm', minimumValue: 5, maximumValue: 10, targetValue: null, unitId: 3974 } });
  assert.equal(r.ok, false);
});

test('isEquivalent: el caso real de la OT 5769 — 5-8 µm NO equivale a 5-10 µm', () => {
  const applied = { id: 34924257, name: '5 - 8 µm', minimumValue: 5, maximumValue: 8, targetValue: null,
                    unitId: 3974, specFieldParamByDerivedFromId: { id: 12533622 } };
  const desired = { compareId: 32594227, refName: '5 - 10 µm',
    refParam: { name: '5 - 10 µm', minimumValue: 5, maximumValue: 10, targetValue: null, unitId: 3974 } };
  assert.equal(Core.isEquivalent(applied, desired).ok, false);
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: FAIL — `Core.isEquivalent is not a function`.

- [ ] **Step 3: Escribe la implementación**

```js
  // Normaliza un nombre para comparar: colapsa espacios, recorta y baja a minúsculas.
  // NO quita acentos a propósito: "Si" y "Sí" son cadenas distintas y en un catálogo de
  // calidad esa diferencia puede ser real.
  function normalizeName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function sameNumber(a, b) {
    const na = (a === undefined || a === null) ? null : a;
    const nb = (b === undefined || b === null) ? null : b;
    return na === nb;
  }

  // ¿El parámetro aplicado equivale al deseado? Tres escalones, y CADA UNO SOLO PUEDE ABSOLVER.
  // Solo agotarlos los tres declara que difiere.
  //
  // El escalón de identidad es el que más trabaja (132 de 136 aciertos medidos en la OT 5769):
  // el catálogo de una spec evoluciona, así que un parámetro aplicado puede descender de una
  // versión ya reemplazada y su raíz no coincide con la vigente aunque el valor sea el mismo.
  function isEquivalent(appliedParam, desired) {
    if (!appliedParam || !desired) return { ok: false, via: null };

    const appliedRoot = rootParamId(appliedParam);
    if (appliedRoot != null && desired.compareId != null && appliedRoot === desired.compareId) {
      return { ok: true, via: 'raiz' };
    }
    if (appliedParam.id != null && desired.compareId != null && appliedParam.id === desired.compareId) {
      return { ok: true, via: 'idDirecto' };
    }
    if (normalizeName(appliedParam.name) === normalizeName(desired.refName)) {
      const ref = desired.refParam;
      if (!ref) return { ok: true, via: 'identidad' };   // del catálogo solo hay nombre, y basta:
                                                          // esa vía exige que el catálogo sea unívoco
      const sameValues = sameNumber(appliedParam.minimumValue, ref.minimumValue)
        && sameNumber(appliedParam.maximumValue, ref.maximumValue)
        && sameNumber(appliedParam.targetValue, ref.targetValue)
        && sameNumber(appliedParam.unitId, ref.unitId);
      if (sameValues) return { ok: true, via: 'identidad' };
    }
    return { ok: false, via: null };
  }
```

Agrégalas al export: `normalizeName`, `isEquivalent`.

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-spec-params-core.js tools/test/wo-spec-params-core.test.js
git commit -m "feat(wo-spec-params): equivalencia en cascada — ningún escalón puede condenar, solo absolver"
```

---

### Task 4: Clasificar las casillas de una OT

**Files:**
- Modify: `remote/scripts/wo-spec-params-core.js`
- Test: `tools/test/wo-spec-params-core.test.js`

**Interfaces:**
- Consumes: todo lo anterior
- Produces: `classifyWorkOrder({workOrder, partNumber}) -> {cells:[Cell], tally:{OK,VACIO,DIFIERE,DUPLICADO,AMBIGUO,SIN_CATALOGO}, orphans:[Orphan]}`
  - `Cell = {recipeNodeId, recipeNodeName, specFieldId, fieldName, specName, status, via, desired, appliedRows, toArchiveIds:[number], toAddWriteId:number|null, pnwosId, reason}`
  - `Orphan = {recipeNodeId, recipeNodeName, specFieldId, fieldName, rowId, paramName}`

**Las huérfanas.** El universo de casillas sale de `recipeNodeSpecFields` — lo que el nodo *declara*. Pero puede haber filas aplicadas de un campo que el nodo **no** declara. Ese caso apareció al construir el fixture, y es real: cuando aplicas un parámetro de un campo nuevo, el ERP declara el campo en el nodo, así que un snapshot tomado entre ambos momentos las muestra descolgadas.

**No generan casilla y no se tocan** — tocarlas sería escribir sobre algo que el modelo de la orden ya no reconoce. Pero **sí se reportan**: son parámetros vivos que nadie está mirando, y el operador debe saber que existen.

- [ ] **Step 1: Escribe el test que falla**

```js
// Conteos VERIFICADOS contra el fixture antes de escribir el plan. Si no cuadran, el core está
// mal — no toques estos números.
//   nodo 42513351: 6 campos... 1 DIFIERE (Espesor 5-8 vs 5-10) + 4 OK
//   nodo 42513364: 1 campo sin parámetro → 1 VACIO
//   nodo 42513391: 6 campos, 2 con parámetro que difiere del NP, 4 vacíos
test('classifyWorkOrder: sobre el fixture real de la OT 5769', () => {
  const { cells, tally } = Core.classifyWorkOrder(FIX);
  assert.equal(tally.OK, 4);
  assert.equal(tally.VACIO, 5);
  assert.equal(tally.DIFIERE, 3);
  assert.equal(tally.DUPLICADO, 0);
  assert.equal(tally.AMBIGUO, 0);
  assert.equal(tally.SIN_CATALOGO, 0);
  assert.equal(cells.length, 12);
});

test('classifyWorkOrder: el DIFIERE de Espesor archiva la fila vieja y escribe el id del catálogo', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const c = cells.find(x => x.recipeNodeId === 42513391 && x.specFieldId === 15630);
  assert.equal(c.status, 'DIFIERE');
  assert.deepEqual(c.toArchiveIds, [26249942]);   // la fila aplicada
  assert.equal(c.toAddWriteId, 32594227);          // el id del CATÁLOGO que el NP señala
  assert.equal(c.pnwosId, 5063398);
});

test('classifyWorkOrder: el mismo campo en otro nodo también difiere, con su propia fila', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const c = cells.find(x => x.recipeNodeId === 42513351 && x.specFieldId === 15630);
  assert.equal(c.status, 'DIFIERE');
  assert.deepEqual(c.toArchiveIds, [22341384]);
  assert.equal(c.toAddWriteId, 32594227);
});

test('classifyWorkOrder: una fila aplicada a un campo que el nodo NO declara es huérfana y se ignora', () => {
  const wo = JSON.parse(JSON.stringify(FIX.workOrder));
  const node = wo.recipeNodesByWorkOrderId.nodes.find(n => n.id === 42513391);
  // quitamos la declaración del campo 33579 pero dejamos su fila aplicada
  node.recipeNodeSpecFieldsByRecipeNodeId.nodes =
    node.recipeNodeSpecFieldsByRecipeNodeId.nodes.filter(f => f.specFieldId !== 33579);
  const { cells, tally, orphans } = Core.classifyWorkOrder({ workOrder: wo, partNumber: FIX.partNumber });
  assert.equal(cells.length, 11);          // una casilla menos
  assert.equal(tally.DIFIERE, 2);          // el DIFIERE de Espesor (Intermedio) desaparece
  assert.equal(orphans.length, 1);         // pero se REPORTA
  assert.equal(orphans[0].specFieldId, 33579);
  assert.equal(orphans[0].rowId, 26249943);
});

test('classifyWorkOrder: una casilla VACÍA solo agrega, no archiva', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  const c = cells.find(x => x.recipeNodeId === 42513364);
  assert.equal(c.status, 'VACIO');
  assert.deepEqual(c.toArchiveIds, []);
  assert.ok(c.toAddWriteId > 0);
});

test('classifyWorkOrder: DUPLICADO conserva la equivalente y archiva el resto', () => {
  const wo = {
    id: 1, idInDomain: 1, name: '',
    partNumberWorkOrderSpecsByWorkOrderId: { nodes: [{ id: 70, archivedAt: null,
      specBySpecId: { id: 5, name: 'S', specFieldSpecsBySpecId: { nodes: [{
        id: 500, archivedAt: null, specFieldId: 900, isGeneric: false,
        specFieldParamsBySpecFieldSpecId: { nodes: [{ id: 111, name: 'Bueno' }] },
        specFieldBySpecFieldId: { id: 900, name: 'Campo', type: 'BOOLEAN' } }] } } }] },
    recipeNodesByWorkOrderId: { nodes: [{ id: 42, name: 'N', type: 'PROCESS', recipeInd: 0,
      recipeNodeSpecFieldsByRecipeNodeId: { nodes: [{ id: 1, specFieldId: 900,
        specFieldBySpecFieldId: { id: 900, name: 'Campo' } }] },
      partNumberRecipeNodeSpecFieldParamsByRecipeNodeId: { nodes: [
        { id: 8001, archivedAt: null, specFieldId: 900, recipeNodeId: 42,
          partNumberWorkOrderSpecByDrivenBy: { id: 70 },
          specFieldParamBySpecFieldParamId: { id: 9001, name: 'Bueno',
            specFieldParamByDerivedFromId: { id: 111 }, specFieldSpecBySpecFieldSpecId: { id: 500 } } },
        { id: 8002, archivedAt: null, specFieldId: 900, recipeNodeId: 42,
          partNumberWorkOrderSpecByDrivenBy: { id: 70 },
          specFieldParamBySpecFieldParamId: { id: 9002, name: 'Sobrante',
            specFieldParamByDerivedFromId: { id: 222 }, specFieldSpecBySpecFieldSpecId: { id: 500 } } },
      ] } }] }
  };
  const { cells, tally } = Core.classifyWorkOrder({ workOrder: wo, partNumber: { partNumberSpecFieldParamsByPartNumberId: { nodes: [] } } });
  assert.equal(tally.DUPLICADO, 1);
  assert.deepEqual(cells[0].toArchiveIds, [8002]);   // conserva la equivalente 8001
  assert.equal(cells[0].toAddWriteId, null);          // ya hay una buena viva: no se agrega nada
});

test('classifyWorkOrder: AMBIGUO no propone ninguna escritura', () => {
  const { cells } = Core.classifyWorkOrder(FIX);
  for (const c of cells) {
    if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') {
      assert.deepEqual(c.toArchiveIds, []);
      assert.equal(c.toAddWriteId, null);
    }
  }
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: FAIL — `Core.classifyWorkOrder is not a function`.

- [ ] **Step 3: Escribe la implementación**

```js
  // Clasifica TODAS las casillas de una OT. El universo sale de recipeNodeSpecFields — la única
  // fuente que dice qué DEBERÍA estar lleno; lo aplicado solo dice qué hay.
  function classifyWorkOrder(input) {
    const workOrder = input && input.workOrder;
    const partNumber = input && input.partNumber;
    const cells = [];
    const orphans = [];
    const tally = { OK: 0, VACIO: 0, DIFIERE: 0, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 0 };
    if (!workOrder) return { cells, tally, orphans };

    const catalogIndex = buildCatalogIndex(workOrder);
    const pnIndex = buildPartNumberIndex(partNumber);
    const nodes = (workOrder.recipeNodesByWorkOrderId && workOrder.recipeNodesByWorkOrderId.nodes) || [];

    for (const node of nodes) {
      if (!node) continue;
      const appliedByField = new Map();
      const applied = (node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId
        && node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes) || [];
      for (const a of applied) {
        if (!a || a.archivedAt) continue;
        if (!appliedByField.has(a.specFieldId)) appliedByField.set(a.specFieldId, []);
        appliedByField.get(a.specFieldId).push(a);
      }
      const fields = (node.recipeNodeSpecFieldsByRecipeNodeId
        && node.recipeNodeSpecFieldsByRecipeNodeId.nodes) || [];

      // Filas aplicadas a un campo que el nodo NO declara: no son casillas, así que no se tocan.
      // Se reportan porque son parámetros vivos fuera del modelo de la orden.
      const declared = new Set(fields.map(f => f && f.specFieldId).filter(x => x != null));
      for (const [fieldId, rows] of appliedByField) {
        if (declared.has(fieldId)) continue;
        for (const r of rows) {
          const sfp = r.specFieldParamBySpecFieldParamId || {};
          orphans.push({
            recipeNodeId: node.id,
            recipeNodeName: node.name || '',
            specFieldId: fieldId,
            fieldName: (r.specFieldBySpecFieldId && r.specFieldBySpecFieldId.name) || '',
            rowId: r.id,
            paramName: sfp.name || ''
          });
        }
      }

      for (const f of fields) {
        if (!f || f.specFieldId == null) continue;
        const rows = appliedByField.get(f.specFieldId) || [];
        const desired = resolveDesired(f.specFieldId, catalogIndex, pnIndex);
        const base = {
          recipeNodeId: node.id,
          recipeNodeName: node.name || '',
          specFieldId: f.specFieldId,
          fieldName: (f.specFieldBySpecFieldId && f.specFieldBySpecFieldId.name) || desired.fieldName || '',
          specName: desired.specName || '',
          via: desired.via,
          desired,
          appliedRows: rows,
          toArchiveIds: [],
          toAddWriteId: null,
          pnwosId: desired.pnwosId || null,
          reason: desired.reason || ''
        };

        if (desired.via === 'SIN_CATALOGO' || desired.via === 'AMBIGUO') {
          base.status = desired.via;
          tally[desired.via]++;
          cells.push(base);
          continue;
        }

        if (rows.length === 0) {
          base.status = 'VACIO';
          base.toAddWriteId = desired.writeId;
          tally.VACIO++;
          cells.push(base);
          continue;
        }

        const matches = rows.filter(r => isEquivalent(r.specFieldParamBySpecFieldParamId, desired).ok);

        if (rows.length > 1) {
          base.status = 'DUPLICADO';
          if (matches.length > 0) {
            // conserva la primera equivalente, archiva todas las demás
            const keep = matches[0].id;
            base.toArchiveIds = rows.filter(r => r.id !== keep).map(r => r.id);
          } else {
            // ninguna sirve: archiva todas y escribe la deseada
            base.toArchiveIds = rows.map(r => r.id);
            base.toAddWriteId = desired.writeId;
          }
          tally.DUPLICADO++;
          cells.push(base);
          continue;
        }

        if (matches.length === 1) {
          base.status = 'OK';
          tally.OK++;
        } else {
          base.status = 'DIFIERE';
          base.toArchiveIds = [rows[0].id];
          base.toAddWriteId = desired.writeId;
          tally.DIFIERE++;
        }
        cells.push(base);
      }
    }
    return { cells, tally, orphans };
  }
```

Agrégala al export.

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: PASS, 21 tests.

Si los conteos del primer test no cuadran, **no ajustes el test para que pase** — imprime `cells` y averigua por qué el core discrepa del cruce verificado en vivo (spec §8.3). El fixture es dato real; si el core no lo reproduce, el core está mal.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-spec-params-core.js tools/test/wo-spec-params-core.test.js
git commit -m "feat(wo-spec-params): clasificación de casillas contra el fixture real de la OT 5769"
```

---

### Task 5: Plan de escritura agrupado por lote

**Files:**
- Modify: `remote/scripts/wo-spec-params-core.js`
- Test: `tools/test/wo-spec-params-core.test.js`

**Interfaces:**
- Consumes: `classifyWorkOrder` (Task 4)
- Produces: `buildWritePlan(classification, {partNumberId}) -> {archiveIds:[number], parametersToAdd:[{specFieldId, specFieldParamId, recipeNodeId, geometryTypeSpecFieldId:null, locationId:null, drivenBy}], touched:number, skipped:[Cell]}`

El payload sale exactamente con la forma verificada en el scan (spec §2.2).

- [ ] **Step 1: Escribe el test que falla**

```js
// Valores VERIFICADOS contra el fixture. No los ajustes: si no cuadran, el core está mal.
test('buildWritePlan: arma el payload con la forma exacta de AddParams', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  assert.deepEqual(plan.archiveIds.slice().sort((a, b) => a - b),
                   [22341384, 26249942, 26249943]);
  assert.equal(plan.parametersToAdd.length, 8);   // 5 vacías + 3 que difieren
  assert.equal(plan.touched, 8);
  const add = plan.parametersToAdd.find(a => a.specFieldId === 15630 && a.recipeNodeId === 42513391);
  assert.deepEqual(add, {
    specFieldId: 15630, specFieldParamId: 32594227, recipeNodeId: 42513391,
    geometryTypeSpecFieldId: null, locationId: null, drivenBy: 5063398
  });
});

test('buildWritePlan: Espesor (Intermedio) escribe "No aplica", que es lo que dice el NP', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const add = plan.parametersToAdd.find(a => a.specFieldId === 33579);
  assert.equal(add.specFieldParamId, 32596235);
});

test('buildWritePlan: no incluye AMBIGUO ni SIN_CATALOGO, y los reporta en skipped', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  for (const s of plan.skipped) {
    assert.ok(s.status === 'AMBIGUO' || s.status === 'SIN_CATALOGO');
  }
  const ids = new Set(plan.parametersToAdd.map(a => a.specFieldId + ':' + a.recipeNodeId));
  for (const c of cls.cells) {
    if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') {
      assert.equal(ids.has(c.specFieldId + ':' + c.recipeNodeId), false);
    }
  }
});

test('buildWritePlan: una clasificación toda OK no propone ninguna escritura', () => {
  const plan = Core.buildWritePlan({ cells: [
    { status: 'OK', toArchiveIds: [], toAddWriteId: null }
  ], tally: {}, orphans: [] }, { partNumberId: 1 });
  assert.equal(plan.archiveIds.length, 0);
  assert.equal(plan.parametersToAdd.length, 0);
  assert.equal(plan.touched, 0);
});

test('buildWritePlan: sin partNumberId no arma nada (fail-safe)', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, {});
  assert.equal(plan.parametersToAdd.length, 0);
  assert.equal(plan.archiveIds.length, 0);
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: FAIL — `Core.buildWritePlan is not a function`.

- [ ] **Step 3: Escribe la implementación**

```js
  // Convierte la clasificación en las dos escrituras: qué archivar y qué agregar.
  // Fail-safe: sin partNumberId no arma nada — el payload de AddParams lo exige y mandar uno
  // incompleto escribiría sobre el NP equivocado.
  function buildWritePlan(classification, opts) {
    const out = { archiveIds: [], parametersToAdd: [], touched: 0, skipped: [] };
    const partNumberId = opts && opts.partNumberId;
    const cells = (classification && classification.cells) || [];
    if (!partNumberId) return out;

    for (const c of cells) {
      if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') { out.skipped.push(c); continue; }
      if (c.status === 'OK') continue;

      let changed = false;
      for (const id of (c.toArchiveIds || [])) { out.archiveIds.push(id); changed = true; }
      if (c.toAddWriteId != null && c.pnwosId != null) {
        out.parametersToAdd.push({
          specFieldId: c.specFieldId,
          specFieldParamId: c.toAddWriteId,
          recipeNodeId: c.recipeNodeId,
          geometryTypeSpecFieldId: null,
          locationId: null,
          drivenBy: c.pnwosId
        });
        changed = true;
      }
      if (changed) out.touched++;
    }
    return out;
  }
```

Agrégala al export.

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-core.test.js`
Expected: PASS, 27 tests.

- [ ] **Step 5: Corre la suite completa**

Run: `node --test tools/test/`
Expected: todo verde. Si algo más se puso rojo, lo rompiste tú.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/wo-spec-params-core.js tools/test/wo-spec-params-core.test.js
git commit -m "feat(wo-spec-params): plan de escritura con el payload exacto de AddParams"
```

---

### Task 6: Registrar hashes y la acción en config.json

**Files:**
- Modify: `remote/config.json`
- Test: `tools/test/wo-spec-params-config.test.js` (crear)

**Interfaces:**
- Produces: entradas `knownOperations` y la 5ª acción de la app `spec-migrator`.

**CUIDADO:** `remote/config.json` es *hot file* (ver `CLAUDE.md` §"Trabajo paralelo"). Haz este cambio en una pasada corta: leer → editar → commit. **No bumpees `version`** — esta fase no se deploya.

- [ ] **Step 1: Escribe el test que falla**

```js
// tools/test/wo-spec-params-config.test.js
// Ata el applet a su declaración en config.json: si alguien renombra el fn o borra un hash,
// esto se pone rojo antes que el operador lo descubra en producción.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const cfg = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'remote', 'config.json'), 'utf8'));

test('config: las 3 operaciones del applet están declaradas', () => {
  for (const op of ['GetPartNumberWorkOrderSpecsInfo',
                    'ArchivePartNumberRecipeNodeSpecFieldParams',
                    'AddParamsToPartNumberRecipeNodeSpecFieldParam']) {
    assert.ok(cfg.knownOperations[op], 'falta knownOperations.' + op);
  }
});

test('config: la app spec-migrator carga el core y el glue del applet nuevo', () => {
  const app = cfg.apps.find(a => a.id === 'spec-migrator');
  assert.ok(app, 'no existe la app spec-migrator');
  assert.ok(app.scripts.includes('scripts/wo-spec-params-core.js'));
  assert.ok(app.scripts.includes('scripts/wo-spec-params.js'));
  // el core debe cargarse ANTES que el glue
  assert.ok(app.scripts.indexOf('scripts/wo-spec-params-core.js')
          < app.scripts.indexOf('scripts/wo-spec-params.js'));
});

test('config: la acción del popup está cableada con fn (si no, nace inalcanzable)', () => {
  const app = cfg.apps.find(a => a.id === 'spec-migrator');
  const act = app.actions.find(a => a.id === 'reapply-wo-params');
  assert.ok(act, 'falta la acción reapply-wo-params');
  assert.equal(act.handler, 'message');
  assert.equal(act.fn, 'WoSpecParams.openFromPopup');
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-config.test.js`
Expected: FAIL — faltan las entradas.

- [ ] **Step 3: Edita `remote/config.json`**

En `knownOperations`, agrega (respetando el orden alfabético del bloque):

```json
"AddParamsToPartNumberRecipeNodeSpecFieldParam": {
  "type": "mutation",
  "description": "Aplicar parámetros a los nodos de receta de una OT. input.parametersToAdd[]={specFieldId,specFieldParamId,recipeNodeId,geometryTypeSpecFieldId:null,locationId:null,drivenBy}. drivenBy=id del PartNumberWorkOrderSpec. CRÍTICO: specFieldParamId es el id del CATÁLOGO de la spec — el server CLONA y el registro queda con otro id, encadenado por derivedFromId",
  "usedBy": "wo-spec-params"
},
"ArchivePartNumberRecipeNodeSpecFieldParams": {
  "type": "mutation",
  "description": "Archivar filas de PartNumberRecipeNodeSpecFieldParam por id. Acepta lote: {partNumberRecipeNodeSpecFieldParamIds:[Int],archivedAt:ISO}",
  "usedBy": "wo-spec-params"
},
"GetPartNumberWorkOrderSpecsInfo": {
  "type": "query",
  "description": "Specs de una OT + sus nodos de receta con los parámetros aplicados. Vars {partNumberId,workOrderId} (ambos ids GLOBALES, no idInDomain). PESADA: ~0.87 MB por (OT × NP) — destilar y descartar el crudo",
  "usedBy": "wo-spec-params"
}
```

En el objeto de hashes que la extensión consume (busca dónde viven los demás hashes, p.ej. `cfg.steelhead.hashes` — replica la estructura existente):

```
GetPartNumberWorkOrderSpecsInfo             0d77c6496b506be62b92c1d821b2e0ec115838cb404ef3ab1cffe2270ddeb827
ArchivePartNumberRecipeNodeSpecFieldParams  7d33b66bb244910a9065c631630bceb15f01ca282ac208b16fecf85df36937a4
AddParamsToPartNumberRecipeNodeSpecFieldParam 8e8b0ab50c0404a01985ec894d0c91d3eab4159c6360f923b9920b8e344aaef0
```

En `apps[] → id: "spec-migrator"`, agrega los dos scripts al arreglo `scripts` (el core **antes** del glue) y esta 5ª acción:

```json
{
  "id": "reapply-wo-params",
  "label": "Reaplicar Params en OTs",
  "sublabel": "Alinea las specs de las órdenes con su Número de Parte",
  "icon": "🔧",
  "handler": "message",
  "message": "reapply-wo-params",
  "fn": "WoSpecParams.openFromPopup"
}
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-config.test.js && node --test tools/test/popup-actions-wired.test.js`
Expected: PASS. El segundo es el trinquete que exige `fn` en toda acción `handler:"message"` — si no lo pusiste, el botón nacería inalcanzable (lección `auto-router` 0.3.1).

- [ ] **Step 5: Commit**

```bash
git add remote/config.json tools/test/wo-spec-params-config.test.js
git commit -m "chore(config): declara las 3 ops de wo-spec-params y cablea su acción del popup"
```

---

### Task 7: Glue — consultas y el ciclo de una OT

**Files:**
- Create: `remote/scripts/wo-spec-params.js`
- Test: `tools/test/wo-spec-params-glue.test.js` (crear)

**Interfaces:**
- Consumes: `window.WoSpecParamsCore` (Tasks 1-5), `window.SteelheadAPI`
- Produces: `window.WoSpecParams = { openFromPopup, open, analyzeWorkOrder, parsePastedWorkOrders, isWorkOrderDetailPath, parseWorkOrderIdInDomain }`

`analyzeWorkOrder` recibe un `deps` inyectable para poder testear sin red.

- [ ] **Step 1: Escribe el test que falla**

```js
// tools/test/wo-spec-params-glue.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params-core.js'));
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params.js'));
const G = global.window.WoSpecParams;
const FIX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-5769.json'), 'utf8'));

test('parsePastedWorkOrders: acepta comas, saltos de línea, espacios y # inicial', () => {
  const r = G.parsePastedWorkOrders('5769, 5770\n5771\n\n #5772  \n5769');
  assert.deepEqual(r.ids, [5769, 5770, 5771, 5772]);   // dedup, en orden de aparición
  assert.equal(r.ignored, 0);
});

test('parsePastedWorkOrders: cuenta los renglones que no son números', () => {
  const r = G.parsePastedWorkOrders('5769\nABC\n\n5770\nxx-1');
  assert.deepEqual(r.ids, [5769, 5770]);
  assert.equal(r.ignored, 2);
});

test('parsePastedWorkOrders: entrada vacía no truena', () => {
  assert.deepEqual(G.parsePastedWorkOrders('').ids, []);
  assert.deepEqual(G.parsePastedWorkOrders(null).ids, []);
});

test('isWorkOrderDetailPath / parseWorkOrderIdInDomain', () => {
  assert.equal(G.isWorkOrderDetailPath('/Domains/344/WorkOrders/5769'), true);
  assert.equal(G.isWorkOrderDetailPath('/Domains/344/WorkOrders'), false);
  assert.equal(G.parseWorkOrderIdInDomain('/Domains/344/WorkOrders/5769?x=1'), 5769);
  assert.equal(G.parseWorkOrderIdInDomain('/Domains/344/WorkOrders'), null);
});

test('analyzeWorkOrder: cruza las dos consultas y devuelve el plan, sin tocar la red', async () => {
  const calls = [];
  const deps = {
    getWorkOrderIds: async (idInDomain) => { calls.push(['wo', idInDomain]); return { id: 1756468, partNumberIds: [3044551] }; },
    getSpecsInfo: async (partNumberId, workOrderId) => { calls.push(['specs', partNumberId, workOrderId]); return FIX.workOrder; },
    getPartNumber: async (id) => { calls.push(['pn', id]); return FIX.partNumber; },
  };
  const res = await G.analyzeWorkOrder(5769, deps);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 1);
  const r = res.results[0];
  assert.equal(r.partNumberId, 3044551);
  assert.equal(r.tally.DIFIERE, 2);
  assert.equal(r.plan.parametersToAdd.length > 0, true);
  assert.deepEqual(calls[0], ['wo', 5769]);
});

test('analyzeWorkOrder: si una OT no resuelve su NP, reporta y no revienta', async () => {
  const deps = {
    getWorkOrderIds: async () => ({ id: 1, partNumberIds: [] }),
    getSpecsInfo: async () => { throw new Error('no debería llamarse'); },
    getPartNumber: async () => { throw new Error('no debería llamarse'); },
  };
  const res = await G.analyzeWorkOrder(5769, deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /número de parte/i);
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-glue.test.js`
Expected: FAIL — el archivo no existe.

- [ ] **Step 3: Escribe la implementación**

Crea `remote/scripts/wo-spec-params.js` con esta estructura. El panel va en la Task 8; aquí solo la lógica de orquestación y las consultas.

```js
// Reaplicar parámetros a las specs de Órdenes de Trabajo — glue (red + DOM).
// La decisión vive en wo-spec-params-core.js; aquí solo se consulta, se dibuja y se escribe.
// Ver docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md
(function () {
  'use strict';

  const WO_DETAIL_RE = /\/Domains\/(\d+)\/WorkOrders\/(\d+)(?:[/?#]|$)/i;
  function isWorkOrderDetailPath(p) { return typeof p === 'string' && WO_DETAIL_RE.test(p); }
  function parseWorkOrderIdInDomain(p) {
    if (typeof p !== 'string') return null;
    const m = p.match(WO_DETAIL_RE);
    return m ? parseInt(m[2], 10) : null;
  }

  // Pega números de OT: acepta comas, saltos de línea, espacios y un '#' inicial.
  // Deduplica conservando el orden de aparición y cuenta los renglones ilegibles.
  function parsePastedWorkOrders(text) {
    const ids = [];
    const seen = new Set();
    let ignored = 0;
    const raw = String(text == null ? '' : text);
    for (const tok of raw.split(/[\s,;]+/)) {
      const t = tok.trim().replace(/^#/, '');
      if (!t) continue;
      if (!/^\d+$/.test(t)) { ignored++; continue; }
      const n = parseInt(t, 10);
      if (seen.has(n)) continue;
      seen.add(n);
      ids.push(n);
    }
    return { ids, ignored };
  }

  function api() { return window.SteelheadAPI; }

  // ── Consultas reales (se inyectan en analyzeWorkOrder para poder testear sin red) ──────────
  const realDeps = {
    // idInDomain → { id (global), partNumberIds[] }
    async getWorkOrderIds(idInDomain) {
      const d = await api().query('PartNumbersByWorkOrderIdInDomain', { idInDomain },
                                  'PartNumbersByWorkOrderIdInDomain');
      const wo = d && d.workOrderByIdInDomain;
      if (!wo) return { id: null, partNumberIds: [] };
      const locs = (wo.partLocationsByWorkOrderId && wo.partLocationsByWorkOrderId.nodes) || [];
      const ids = [];
      const seen = new Set();
      for (const l of locs) {
        const pn = l && l.partNumberByPartNumberId;
        if (pn && pn.id != null && !seen.has(pn.id)) { seen.add(pn.id); ids.push(pn.id); }
      }
      return { id: wo.id, partNumberIds: ids };
    },
    async getSpecsInfo(partNumberId, workOrderId) {
      const d = await api().query('GetPartNumberWorkOrderSpecsInfo', { partNumberId, workOrderId },
                                  'GetPartNumberWorkOrderSpecsInfo');
      return d && d.workOrderById;
    },
    async getPartNumber(partNumberId) {
      const d = await api().query('GetPartNumber', { partNumberId }, 'GetPartNumber');
      return d && d.partNumberById;
    }
  };

  // Analiza UNA orden. Devuelve un resultado por cada NP de la orden.
  // Destila y descarta: la respuesta de getSpecsInfo pesa ~0.87 MB y NO se guarda.
  async function analyzeWorkOrder(idInDomain, deps) {
    const D = deps || realDeps;
    const Core = window.WoSpecParamsCore;
    let ids;
    try {
      ids = await D.getWorkOrderIds(idInDomain);
    } catch (e) {
      return { ok: false, idInDomain, error: 'No pude leer la orden: ' + (e && e.message ? e.message : e) };
    }
    if (!ids || !ids.id) return { ok: false, idInDomain, error: 'No encontré la orden ' + idInDomain };
    if (!ids.partNumberIds.length) {
      return { ok: false, idInDomain, error: 'La orden ' + idInDomain + ' no tiene número de parte asociado' };
    }

    const results = [];
    for (const partNumberId of ids.partNumberIds) {
      try {
        const workOrder = await D.getSpecsInfo(partNumberId, ids.id);
        const partNumber = await D.getPartNumber(partNumberId);
        if (!workOrder) { results.push({ partNumberId, error: 'sin datos de specs' }); continue; }
        const classification = Core.classifyWorkOrder({ workOrder, partNumber });
        const plan = Core.buildWritePlan(classification, { partNumberId });
        results.push({
          partNumberId,
          partNumberName: (partNumber && partNumber.name) || String(partNumberId),
          workOrderId: ids.id,
          idInDomain,
          tally: classification.tally,
          cells: classification.cells,
          plan
        });
      } catch (e) {
        results.push({ partNumberId, error: (e && e.message) ? e.message : String(e) });
      }
    }
    return { ok: true, idInDomain, workOrderId: ids.id, results };
  }

  window.WoSpecParams = {
    isWorkOrderDetailPath, parseWorkOrderIdInDomain, parsePastedWorkOrders,
    analyzeWorkOrder, _realDeps: realDeps
  };
})();
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-glue.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-spec-params.js tools/test/wo-spec-params-glue.test.js
git commit -m "feat(wo-spec-params): orquestación por OT con dependencias inyectables"
```

---

### Task 8: Panel, preview y escritura confirmada

**Files:**
- Modify: `remote/scripts/wo-spec-params.js`
- Test: `tools/test/wo-spec-params-glue.test.js`

**Interfaces:**
- Consumes: `analyzeWorkOrder` (Task 7)
- Produces: `open(opts)`, `openFromPopup()`, `applyPlan(result, deps) -> {archived, added, errors[]}`, `summarize(results) -> {ordenes, casillas, aCorregir, omitidas}`

**Reglas que no se negocian aquí:**
- El preview se muestra **siempre** antes de escribir. Nada se aplica sin que el operador confirme un conteo.
- `textContent` para todo lo que venga de GraphQL. Cero `innerHTML` con nombres.
- Tema oscuro (`#1c2430` / `#e6e9ee` / `#141a23` / `#13a36f`).
- Se archiva **antes** de agregar, en ese orden — es el orden que hace el ERP nativo (spec §2, eventLog).

- [ ] **Step 1: Escribe el test que falla**

```js
test('summarize: agrega los conteos de varias órdenes', () => {
  const s = G.summarize([
    { tally: { OK: 5, VACIO: 4, DIFIERE: 2, DUPLICADO: 0, AMBIGUO: 1, SIN_CATALOGO: 0 },
      plan: { archiveIds: [1, 2], parametersToAdd: [{}, {}, {}], touched: 6, skipped: [{}] } },
    { tally: { OK: 1, VACIO: 0, DIFIERE: 1, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 2 },
      plan: { archiveIds: [3], parametersToAdd: [{}], touched: 1, skipped: [{}, {}] } },
  ]);
  assert.equal(s.casillas, 16);
  assert.equal(s.aCorregir, 7);
  assert.equal(s.omitidas, 3);
  assert.equal(s.aArchivar, 3);
  assert.equal(s.aAgregar, 4);
});

test('applyPlan: archiva ANTES de agregar y respeta el orden', async () => {
  const order = [];
  const deps = {
    archive: async (ids) => { order.push('archive:' + ids.join(',')); return ids; },
    addParams: async (partNumberId, params) => { order.push('add:' + params.length); return params; },
  };
  const res = await G.applyPlan({ partNumberId: 3044551,
    plan: { archiveIds: [10, 11], parametersToAdd: [{ specFieldId: 1 }] } }, deps);
  assert.deepEqual(order, ['archive:10,11', 'add:1']);
  assert.equal(res.archived, 2);
  assert.equal(res.added, 1);
  assert.equal(res.errors.length, 0);
});

test('applyPlan: si el archivado falla NO agrega (dejaría dos filas vivas en la casilla)', async () => {
  const deps = {
    archive: async () => { throw new Error('boom'); },
    addParams: async () => { throw new Error('no debería llamarse'); },
  };
  const res = await G.applyPlan({ partNumberId: 1,
    plan: { archiveIds: [10], parametersToAdd: [{ specFieldId: 1 }] } }, deps);
  assert.equal(res.added, 0);
  assert.equal(res.errors.length, 1);
});

test('applyPlan: plan vacío no llama a nada', async () => {
  let called = false;
  const deps = { archive: async () => { called = true; }, addParams: async () => { called = true; } };
  const res = await G.applyPlan({ partNumberId: 1, plan: { archiveIds: [], parametersToAdd: [] } }, deps);
  assert.equal(called, false);
  assert.equal(res.archived, 0);
  assert.equal(res.added, 0);
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-glue.test.js`
Expected: FAIL — `G.summarize is not a function`.

- [ ] **Step 3: Escribe `summarize` y `applyPlan`**

```js
  function summarize(results) {
    const s = { ordenes: 0, casillas: 0, aCorregir: 0, omitidas: 0, aArchivar: 0, aAgregar: 0 };
    for (const r of (results || [])) {
      if (!r || !r.tally) continue;
      s.ordenes++;
      for (const k of ['OK', 'VACIO', 'DIFIERE', 'DUPLICADO', 'AMBIGUO', 'SIN_CATALOGO']) {
        s.casillas += (r.tally[k] || 0);
      }
      s.aCorregir += (r.plan && r.plan.touched) || 0;
      s.omitidas += (r.plan && r.plan.skipped ? r.plan.skipped.length : 0);
      s.aArchivar += (r.plan && r.plan.archiveIds ? r.plan.archiveIds.length : 0);
      s.aAgregar += (r.plan && r.plan.parametersToAdd ? r.plan.parametersToAdd.length : 0);
    }
    return s;
  }

  // Aplica el plan de UNA orden. Archiva primero y solo entonces agrega: si el archivado falla
  // y agregáramos igual, la casilla quedaría con DOS filas vivas — el estado que este applet
  // existe para evitar.
  async function applyPlan(result, deps) {
    const D = deps || writeDeps;
    const out = { archived: 0, added: 0, errors: [] };
    const plan = result && result.plan;
    if (!plan) return out;
    const archiveIds = plan.archiveIds || [];
    const toAdd = plan.parametersToAdd || [];
    if (!archiveIds.length && !toAdd.length) return out;

    if (archiveIds.length) {
      try {
        await D.archive(archiveIds);
        out.archived = archiveIds.length;
      } catch (e) {
        out.errors.push('Archivar: ' + ((e && e.message) ? e.message : String(e)));
        return out;   // sin archivar, no se agrega
      }
    }
    if (toAdd.length) {
      try {
        await D.addParams(result.partNumberId, toAdd);
        out.added = toAdd.length;
      } catch (e) {
        out.errors.push('Agregar: ' + ((e && e.message) ? e.message : String(e)));
      }
    }
    return out;
  }

  const writeDeps = {
    async archive(ids) {
      return api().query('ArchivePartNumberRecipeNodeSpecFieldParams',
        { partNumberRecipeNodeSpecFieldParamIds: ids, archivedAt: new Date().toISOString() },
        'ArchivePartNumberRecipeNodeSpecFieldParams');
    },
    async addParams(partNumberId, parametersToAdd) {
      return api().query('AddParamsToPartNumberRecipeNodeSpecFieldParam',
        { input: { partNumberId, parametersToAdd } },
        'AddParamsToPartNumberRecipeNodeSpecFieldParam');
    }
  };
```

Expórtalas en `window.WoSpecParams`.

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-glue.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Escribe el panel**

Agrega a `wo-spec-params.js` la UI. Requisitos concretos:

1. `open({ mode })` con dos modos: `'pantalla'` (toma el idInDomain de `location.pathname`) y `'pegar'` (textarea).
2. Modal centrado, `position:fixed`, `z-index` alto, fondo `#1c2430`, texto `#e6e9ee`, borde `1px solid #2a3543`, radio 10px.
3. Título: `🔧 Reaplicar parámetros · OT <n>`.
4. Fase 1 — captura: en modo `'pegar'`, un `<textarea>` (`#141a23`, texto claro) con el rótulo *"Pega los números de orden, uno por renglón"* y un botón `Analizar` verde `#13a36f`.
5. Fase 2 — preview **obligatorio**: tabla con una fila por casilla que cambie, columnas *Orden · Nodo · Campo · Tiene · Quedará · Origen*. Usa `textContent` en cada celda. Encima, el resumen de `summarize()` en palabras: *"N órdenes · N casillas · **N por corregir** · N omitidas"*. Las omitidas (`AMBIGUO`/`SIN_CATALOGO`) van en una sección aparte, en ámbar `#e0a341`, con su `reason` — son las que el operador tiene que resolver a mano.
6. Botón `Aplicar` **deshabilitado si `aCorregir === 0`**, con el conteo en la etiqueta: `Aplicar (N cambios)`. Botón `Cancelar` que cierra sin escribir.
7. Al aplicar: barra de avance por orden, y al terminar un resumen con `archived`/`added`/`errors` y un botón `Descargar reporte` que baja un CSV con una fila por casilla tocada (orden, nodo, campo, id archivado, id escrito, origen).
8. `closePanel()` que quita el nodo y libera los listeners.

- [ ] **Step 6: Corre la suite completa**

Run: `node --test tools/test/`
Expected: todo verde.

- [ ] **Step 7: Commit**

```bash
git add remote/scripts/wo-spec-params.js tools/test/wo-spec-params-glue.test.js
git commit -m "feat(wo-spec-params): panel dark-mode con preview obligatorio y escritura confirmada"
```

---

### Task 9: Entradas — botón en la ficha y acción del popup

**Files:**
- Modify: `remote/scripts/wo-spec-params.js`
- Test: `tools/test/wo-spec-params-glue.test.js`

**Interfaces:**
- Produces: `openFromPopup()`, `init()`

**Regla del repo:** la UI de entrada se monta **siempre que la ruta aplique**, nunca detrás del gate de estado del applet. Y `openFromPopup` debe **devolver de inmediato** y diferir la apertura — si bloquea (por ejemplo con un `prompt()`), cuelga el `executeScript` del popup (lección `auto-router` 0.3.1).

- [ ] **Step 1: Escribe el test que falla**

```js
test('openFromPopup: devuelve de inmediato y difiere la apertura', () => {
  let abierto = false;
  const original = G.open;
  G.open = () => { abierto = true; };
  const r = G.openFromPopup();
  assert.equal(r, true, 'debe devolver algo serializable de inmediato');
  assert.equal(abierto, false, 'no debe abrir de forma síncrona (colgaría el popup)');
  G.open = original;
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `node --test tools/test/wo-spec-params-glue.test.js`
Expected: FAIL — `G.openFromPopup is not a function`.

- [ ] **Step 3: Escribe la implementación**

```js
  // El popup ejecuta esto con executeScript en el mundo MAIN. Tiene que devolver YA:
  // si bloquea, el popup se queda colgado.
  function openFromPopup() {
    setTimeout(() => {
      try {
        const id = parseWorkOrderIdInDomain(location.pathname);
        window.WoSpecParams.open({ mode: id ? 'pantalla' : 'pegar' });
      } catch (e) {
        console.warn('[wo-spec-params] no pude abrir el panel:', e);
      }
    }, 0);
    return true;
  }

  // Monta el botón de entrada en la ficha de una OT. Se llama SIEMPRE que la ruta aplique.
  function init() {
    if (window.__saWoSpecParamsInit) return;
    window.__saWoSpecParamsInit = true;
    // el botón se monta con un MutationObserver que NO depende del estado del applet
    // (el DOM puede no estar pintado cuando corre init)
  }
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `node --test tools/test/wo-spec-params-glue.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Monta el botón en la ficha**

En `init()`, con `MutationObserver` (el DOM puede no estar pintado al correr):
- Ancla estructural: el header de la ficha, junto a `data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON"` — el mismo que ya usa `wo-schedule-button.js`. Cópialo de ahí, no lo reinventes.
- Botón `🔧` con `title="Reaplicar parámetros de specs desde el Número de Parte"`.
- Idempotente: si ya existe el nodo por id, no lo dupliques.
- El observer **no** debe estar capado por ningún gate de estado.

- [ ] **Step 6: Corre la suite completa y commitea**

```bash
node --test tools/test/
git add remote/scripts/wo-spec-params.js tools/test/wo-spec-params-glue.test.js
git commit -m "feat(wo-spec-params): entradas por ficha de OT y por popup"
```

---

### Task 10: Rutas de regeneración de hash

**Files:**
- Modify: `tools/hash-autopilot/route-catalog.json`
- Modify: `tools/hash-autopilot/sentinels-config.json`
- Modify: `tools/test/hash-regen-coverage.test.js` (bajar la línea base)

**Por qué:** regla dura del repo — un hash sin ruta de regeneración es deuda, y hay un test trinquete que la mide. Este applet mete 3 operaciones; sin ruta, la deuda **sube** y el trinquete se pone rojo.

- [ ] **Step 1: Corre el trinquete y mira dónde está la línea base**

Run: `node --test tools/test/hash-regen-coverage.test.js`
Anota el número actual de huérfanas (al escribir este plan: **60 de 188**).

- [ ] **Step 2: Registra la query en `route-catalog.json`**

`GetPartNumberWorkOrderSpecsInfo` se dispara al abrir *Editar Especificaciones* en la ficha de una OT. Ruta: `goto` la OT Centinela → `clickButton` el botón de editar especificaciones.

**Ancla por estructura, no por texto**: esa pantalla mezcla idiomas. Si necesitas texto, ES+EN (*"Editar Especificaciones"* / *"Edit Specifications"*), y solo como red que amplía.

Lee `tools/hash-autopilot/README.md` para el formato exacto y copia el estilo de una entrada vecina.

- [ ] **Step 3: Registra las dos mutations en `sentinels-config.json`**

Ambas son escrituras que **no deben persistir** → **captura-y-aborta** (`sink.abortOps`), sobre la OT Centinela. Copia el patrón de las 3 entidades centinela que ya usa `auto-router` para `CreateUpdateDeleteRoutes`.

**Ojo con un detalle conocido:** la OT Centinela se llama **«Sentinela»** en el ERP (errata: S inglesa con terminación española). El gate `/Centinela/i` del autopilot pasa por accidente gracias a otros enlaces de la ficha. No dependas de esa casualidad: verifica el ancla que uses.

- [ ] **Step 4: Verifica que la cobertura BAJÓ y actualiza la línea base**

Run: `node --test tools/test/hash-regen-coverage.test.js`
Expected: el test exige actualizar la línea base cuando baja. Bájala en el mismo commit — así la deuda solo puede ir hacia abajo.

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/route-catalog.json tools/hash-autopilot/sentinels-config.json tools/test/hash-regen-coverage.test.js
git commit -m "chore(hash-autopilot): rutas de regeneración de las 3 ops de wo-spec-params"
```

---

### Task 11: Bitácora y registro

**Files:**
- Create: `docs/applets/wo-spec-params.md`
- Modify: `CLAUDE.md` (índice de applets)

**CUIDADO:** `CLAUDE.md` es *hot file*. Pasada corta: leer → editar → commit.

- [ ] **Step 1: Escribe la bitácora**

`docs/applets/wo-spec-params.md` con: qué resuelve, las 3 operaciones y sus hashes, el modelo de casilla, **los tres ids que no hay que confundir**, la cascada de equivalencia con el dato medido (132 de 136 por identidad), el resultado del cruce en vivo de la OT 5769, el estado de validación y los pendientes (fases 2 y 3).

- [ ] **Step 2: Agrega la fila al índice de `CLAUDE.md`**

En la tabla "Índice de applets", una fila para `wo-spec-params` con versión `0.1.0`, resumen de una o dos frases y el enlace a la bitácora.

- [ ] **Step 3: Corre la suite completa**

Run: `node --test tools/test/`
Expected: todo verde, incluido `applet-attribution.test.js` si exige que cada applet esté registrado.

- [ ] **Step 4: Commit**

```bash
git add docs/applets/wo-spec-params.md CLAUDE.md
git commit -m "docs(wo-spec-params): bitácora y registro en el índice"
```

---

### Task 12: Validación en vivo — la corrida de escritura (spec §8.4)

**No hay código en esta tarea.** Es la prueba que decide si la fase 1 sirve.

**Precondición:** todo lo anterior verde y deployado a `gh-pages` **solo si el operador lo autoriza** (esta fase no contemplaba deploy; coordina antes — `remote/config.json` y `gh-pages` son recursos compartidos, y solo una sesión deploya a la vez).

- [ ] **Step 1: Dry-run sobre la OT 5769**

Abre `/Domains/344/WorkOrders/5769`, dispara el panel y **compara el preview contra esto**, que es el cruce verificado el 2026-07-28:

```
OK 136 · VACÍO 13 · DIFIERE 2 · DUPLICADO 0 · AMBIGUO 0 · SIN_CATÁLOGO 0
los 2 que difieren, ambos en el nodo "T201-IC00-001 Inspeccionando y Empacando":
  Espesor              OT "5 - 8 µm"     → NP "5 - 10 µm"   (escribe 32594227, archiva 26249942)
  Espesor (Intermedio) OT "0.5 - 1.0 µm" → NP "No aplica"   (escribe 32596235, archiva 26249943)
```

Si el preview **no** reproduce esos números, para. El core discrepa de la realidad y hay que averiguar por qué antes de escribir nada.

- [ ] **Step 2: Aplica sobre esa única orden**

Confirma en el panel. Anota lo que reporte: archivados, agregados, errores.

- [ ] **Step 3: Relee y verifica que el ERP quedó como el preview prometió**

Vuelve a analizar la misma orden. Esperado: `DIFIERE 0`, `VACÍO 0`, y las casillas antes vacías ahora con su parámetro.

**No confíes en que la mutación no lanzó excepción.** Verifica releyendo — la lección del `wo-schedule-button` 0.7.0 es que el ERP puede responder `{clientMutationId: null}` sin confirmar nada, y un `await` sin error no prueba que se escribió.

- [ ] **Step 4: Registra el resultado en la bitácora**

Con fecha, la orden usada, los conteos antes y después, y cualquier sorpresa. Si algo falló, el diagnóstico va ahí antes de intentar el arreglo.

---

## Fuera de alcance de la fase 1

Van en fases posteriores del spec, **no** las implementes aquí:

- **Origen por Número de Parte** (fase 2): dar los NP corregidos y buscar sus OTs.
- **Escaneo total de las 1000+ órdenes abiertas** (fase 3): exige troceo, checkpoint reanudable en IndexedDB, monitor de memoria con guardrail al 88%, `host-cleanup-shared`, y pool de 3 por el límite de sesión del `/graphql`.
- Reaplicar specs completas que falten en la OT.
- Editar los valores de un parámetro (mínimo, máximo, objetivo) — eso es `spec-params-bulk`.
