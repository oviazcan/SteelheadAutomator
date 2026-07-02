# Gestor de ciclo de vida de PNs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar el applet `archiver` en un gestor de ciclo de vida de PNs con 4 acciones (marcar/quitar validación de ingeniería, desarchivar, archivar=Borrado definitivo) y filtros ricos (cliente, proceso, línea, depto, metal, etiquetas, fecha, duplicados) resueltos en una sola pasada del listado.

**Architecture:** Motor puro testeable (parse/filtros/dedup/payloads) en módulos separados + capa de scan/ejecución sobre `SteelheadAPI` + UI dark-mode de 4 pantallas. Reusa `bulk-upload-classify.js` para dedup y `host-cleanup-shared.js` para memory-hardening. Mutaciones granulares de opt-in; `SavePartNumber` reconstruido solo para el label de archivado.

**Tech Stack:** JavaScript vanilla (sin frameworks/bundlers), persisted queries GraphQL, `node --test` con sandbox `vm` para helpers puros.

## Global Constraints
- JS vanilla; UI y docs en español; código/variables en inglés (regla del repo).
- Toda UI inyectada en **DARK MODE** (base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento `#13a36f`).
- Persisted queries: `clientLibrary {name:'@apollo/client', version:'4.0.8'}` + `persistedQuery {version:1, sha256Hash}`. Vía `window.SteelheadAPI.query(op, vars, hashKey)`.
- Dominio TLC: `validacionProcessNodeIds = [231176, 231174]`; `Borrado definitivo` = labelId **15646**.
- Batching/concurrencia 3 en mutaciones (`runPool`); dry-run + confirm obligatorio antes de mutar; idempotencia; verificación post-mutación.
- Memory-hardening: invocar skill `memory-hardening-applets`; usar `window.SteelheadHostCleanup`.
- NO re-implementar dedup: reusar `remote/scripts/bulk-upload-classify.js` (`buildCompositeKey`, `acabadosCanonicos`, `metalCanonico`, `buildEquivIndex`).
- Hashes nuevos (registrar en `config.json` `steelhead.hashes.mutations`):
  - `DeleteProcessNodePartNumberOptInOut`: `4a0773339315f1a52a9c08c249c5b3540c13def2b0d320e0e16ad9cb75b4d823`
  - `UpdateProcessNodePartNumberOptInOut`: `4556e5710f068e129fadc74cbce1f9a5e7cc42113f4e8e1808976b4e4f4cd2a6`
  - `CreateProcessNodePartNumberOptInout`: `f6fe26e4494c8c91d076975a8d7e89ed2f90a487d05f8bc021c2e296f3d6124f`

---

## File Structure
- **Create** `remote/scripts/pn-lifecycle-core.js` — helpers PUROS: `slimPN(node)`, `applyFilters(pns, filters)`, `discoverFacets(pns)`, `isInTargetState(pn, action)`, `selectDuplicates(pns, classifyDeps)`. Dual-export (browser `window.SteelheadPNLifecycleCore` / node `module.exports`).
- **Create** `remote/scripts/pn-lifecycle.js` — applet: scan (`fetchPNsForAction`), ejecución (`executeAction`), UI (config/filtros/preview/result), entry `openConfigAndRun()`. Depende de `SteelheadAPI`, `SteelheadHostCleanup`, `SteelheadBulkClassify`, `SteelheadPNLifecycleCore`.
- **Create** `tools/test/pn-lifecycle.test.js` — node --test de los helpers puros + payloads.
- **Modify** `remote/config.json` — registrar 3 hashes; agregar app `pn-lifecycle` a `apps[]` con `scripts:[host-cleanup-shared.js, steelhead-api.js, bulk-upload-cc.js, bulk-upload-classify.js, pn-lifecycle-core.js, pn-lifecycle.js]`; bump version.
- **Modify** `extension/background.js` — case `run-pn-lifecycle` → inyecta scripts + `window.PNLifecycle.openConfigAndRun()` (cambio único; el resto por deploy a gh-pages).
- **Reuse** `remote/scripts/bulk-upload-classify.js`, `remote/scripts/bulk-upload-cc.js`, `remote/scripts/host-cleanup-shared.js`, `remote/scripts/steelhead-api.js`.

---

## Task 1: Core puro — `slimPN` (parse del nodo enriquecido)

**Files:**
- Create: `remote/scripts/pn-lifecycle-core.js`
- Test: `tools/test/pn-lifecycle.test.js`

**Interfaces:**
- Produces: `slimPN(node, archivedOverride?) -> {id, name, customer:{id,name}, labels:[{id,name}], metal, proceso, linea, departamento, createdAt, quoteIBMS, archived}`

- [ ] **Step 1: Write the failing test**

```js
// tools/test/pn-lifecycle.test.js
const test = require('node:test');
const assert = require('node:assert');
const { slimPN } = require('../../remote/scripts/pn-lifecycle-core.js');

const NODE = {
  id: 5, name: 'ABC-1', createdAt: '2026-01-02T00:00:00Z',
  customerByCustomerId: { id: 9, name: 'Fisher' },
  customInputs: { DatosAdicionalesNP: { BaseMetal: 'Cobre', QuoteIBMS: '558' } },
  processNodeByDefaultProcessNodeId: { id: 7, name: 'T204 (EST)' },
  partNumberLabelsByPartNumberId: { nodes: [ { labelByLabelId: { id: 3, name: 'Plata' } } ] },
  acctPnDimensionValueSelectionsByPartNumberId: { nodes: [
    { dimensionId: 349, acctDimensionCustomValueByDimensionCustomValueId: { value: 'L1' } },
    { dimensionId: 586, acctDimensionCustomValueByDimensionCustomValueId: { value: 'D3' } },
  ] },
};
test('slimPN extrae campos enriquecidos', () => {
  const s = slimPN(NODE, true);
  assert.equal(s.id, 5);
  assert.equal(s.customer.name, 'Fisher');
  assert.equal(s.metal, 'Cobre');
  assert.equal(s.quoteIBMS, '558');
  assert.equal(s.proceso, 'T204 (EST)');
  assert.deepEqual(s.labels, [{ id: 3, name: 'Plata' }]);
  assert.equal(s.linea, 'L1');
  assert.equal(s.departamento, 'D3');
  assert.equal(s.archived, true);
});
test('slimPN tolera nodo vacío', () => {
  const s = slimPN({ id: 1, name: 'X' }, false);
  assert.equal(s.metal, ''); assert.equal(s.proceso, ''); assert.deepEqual(s.labels, []);
  assert.equal(s.linea, ''); assert.equal(s.archived, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: FAIL ("Cannot find module '../../remote/scripts/pn-lifecycle-core.js'").

- [ ] **Step 3: Write minimal implementation**

```js
// remote/scripts/pn-lifecycle-core.js
(function (root) {
  'use strict';
  const LINEA_DIM = 349, DEPTO_DIM = 586;

  function slimPN(node, archivedOverride) {
    const ci = node.customInputs || {};
    const dan = ci.DatosAdicionalesNP || {};
    const labels = (node.partNumberLabelsByPartNumberId?.nodes || [])
      .map(n => n.labelByLabelId).filter(Boolean).map(l => ({ id: l.id, name: l.name }));
    const acct = node.acctPnDimensionValueSelectionsByPartNumberId?.nodes || [];
    const dimVal = (dimId) => {
      const hit = acct.find(a => a.dimensionId === dimId);
      return hit?.acctDimensionCustomValueByDimensionCustomValueId?.value || '';
    };
    return {
      id: node.id, name: node.name || '',
      customer: { id: node.customerByCustomerId?.id ?? null, name: node.customerByCustomerId?.name || '' },
      labels,
      metal: dan.BaseMetal || '',
      proceso: node.processNodeByDefaultProcessNodeId?.name || '',
      linea: dimVal(LINEA_DIM), departamento: dimVal(DEPTO_DIM),
      createdAt: node.createdAt || null,
      quoteIBMS: dan.QuoteIBMS || '',
      archived: archivedOverride === true,
    };
  }

  const api = { slimPN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SteelheadPNLifecycleCore = api;
})(typeof window !== 'undefined' ? window : null);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/pn-lifecycle-core.js tools/test/pn-lifecycle.test.js
git commit -m "feat(pn-lifecycle): slimPN parse enriquecido + tests"
```

---

## Task 2: Core puro — `applyFilters` + `discoverFacets`

**Files:**
- Modify: `remote/scripts/pn-lifecycle-core.js`
- Test: `tools/test/pn-lifecycle.test.js`

**Interfaces:**
- Consumes: `slimPN` output.
- Produces:
  - `applyFilters(pns, filters) -> pns[]` con `filters = { customers:[id], labels:{names:[],mode:'AND'|'OR'}, metals:[], procesos:[], lineas:[], departamentos:[], dateFilter:{cutoffISO,direction:'before'|'after'}|null }`. Criterios vacíos = no filtran. Intersección AND entre criterios.
  - `discoverFacets(pns) -> { customers:[{name,count}], metals:[...], procesos:[...], lineas:[...], departamentos:[...], labels:[{name,count}] }` ordenado por nombre.

- [ ] **Step 1: Write the failing test**

```js
const { applyFilters, discoverFacets } = require('../../remote/scripts/pn-lifecycle-core.js');
const P = [
  { id:1, name:'A', customer:{id:9,name:'Fisher'}, labels:[{id:3,name:'Plata'}], metal:'Cobre', proceso:'T204', linea:'L1', departamento:'D3', createdAt:'2026-01-01T00:00:00Z' },
  { id:2, name:'B', customer:{id:8,name:'Hubbell'}, labels:[{id:4,name:'Zinc'}], metal:'Acero', proceso:'T106', linea:'L2', departamento:'D3', createdAt:'2026-03-01T00:00:00Z' },
  { id:3, name:'C', customer:{id:9,name:'Fisher'}, labels:[{id:3,name:'Plata'},{id:5,name:'Decapado'}], metal:'Cobre', proceso:'T204', linea:'L1', departamento:'D9', createdAt:'2026-05-01T00:00:00Z' },
];
test('applyFilters: cliente', () => {
  assert.deepEqual(applyFilters(P, { customers:[9] }).map(x=>x.id), [1,3]);
});
test('applyFilters: proceso + metal (AND entre criterios)', () => {
  assert.deepEqual(applyFilters(P, { procesos:['T204'], metals:['Cobre'] }).map(x=>x.id), [1,3]);
});
test('applyFilters: etiquetas AND vs OR', () => {
  assert.deepEqual(applyFilters(P, { labels:{names:['Plata','Decapado'],mode:'AND'} }).map(x=>x.id), [3]);
  assert.deepEqual(applyFilters(P, { labels:{names:['Plata','Zinc'],mode:'OR'} }).map(x=>x.id), [1,2,3]);
});
test('applyFilters: fecha before', () => {
  assert.deepEqual(applyFilters(P, { dateFilter:{cutoffISO:'2026-02-01T00:00:00Z',direction:'before'} }).map(x=>x.id), [1]);
});
test('applyFilters: sin criterios = todos', () => {
  assert.equal(applyFilters(P, {}).length, 3);
});
test('discoverFacets: conteos por cliente y proceso', () => {
  const f = discoverFacets(P);
  assert.deepEqual(f.customers.find(c=>c.name==='Fisher'), {name:'Fisher',count:2});
  assert.equal(f.procesos.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: FAIL ("applyFilters is not a function").

- [ ] **Step 3: Write minimal implementation** (agregar a `pn-lifecycle-core.js` antes del export)

```js
  function matchesLabels(pn, sel) {
    const names = (sel?.names || []).map(s => String(s).toUpperCase());
    if (!names.length) return true;
    const have = new Set((pn.labels || []).map(l => String(l.name || '').toUpperCase()));
    return sel.mode === 'OR' ? names.some(n => have.has(n)) : names.every(n => have.has(n));
  }
  function applyFilters(pns, filters) {
    const f = filters || {};
    const inSet = (arr, v) => !arr || !arr.length || arr.includes(v);
    return (pns || []).filter(pn => {
      if (!inSet(f.customers, pn.customer?.id)) return false;
      if (!inSet(f.metals, pn.metal)) return false;
      if (!inSet(f.procesos, pn.proceso)) return false;
      if (!inSet(f.lineas, pn.linea)) return false;
      if (!inSet(f.departamentos, pn.departamento)) return false;
      if (!matchesLabels(pn, f.labels)) return false;
      if (f.dateFilter?.cutoffISO) {
        if (!pn.createdAt) return false;
        const d = new Date(pn.createdAt), cut = new Date(f.dateFilter.cutoffISO);
        if (f.dateFilter.direction === 'after' ? !(d > cut) : !(d < cut)) return false;
      }
      return true;
    });
  }
  function discoverFacets(pns) {
    const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
    const cust = new Map(), metal = new Map(), proc = new Map(), lin = new Map(), dep = new Map(), lbl = new Map();
    for (const pn of pns || []) {
      if (pn.customer?.name) cust.set(pn.customer.name, { id: pn.customer.id, count: (cust.get(pn.customer.name)?.count || 0) + 1 });
      bump(metal, pn.metal); bump(proc, pn.proceso); bump(lin, pn.linea); bump(dep, pn.departamento);
      for (const l of pn.labels || []) bump(lbl, l.name);
    }
    const toArr = (m) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return {
      customers: [...cust.entries()].map(([name, v]) => ({ name, id: v.id, count: v.count })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
      metals: toArr(metal), procesos: toArr(proc), lineas: toArr(lin), departamentos: toArr(dep), labels: toArr(lbl),
    };
  }
```
Y agregar `applyFilters, discoverFacets, matchesLabels` al objeto `api`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/pn-lifecycle-core.js tools/test/pn-lifecycle.test.js
git commit -m "feat(pn-lifecycle): applyFilters + discoverFacets + tests"
```

---

## Task 3: Core puro — `selectDuplicates` (dedup canónica reusando bulk-upload-classify)

**Files:**
- Modify: `remote/scripts/pn-lifecycle-core.js`
- Test: `tools/test/pn-lifecycle.test.js`

**Interfaces:**
- Consumes: `buildCompositeKey(pn, nonFinishList, equivIndex)` y `buildEquivIndex(groups)` de `bulk-upload-classify.js`; el slim expone `pn.customer.id`→`customerId`, `pn.metal`→`metalBase`, `pn.labels[].name`, `pn.name`.
- Produces: `selectDuplicates(pns, {classify, nonFinishList, equivGroups, scoreFn}) -> { toTag:[id], keep:[id] }`. Regla: agrupa por `buildCompositeKey`; grupos con >1 → si hay activo, todos los archivados van a `toTag`; si solo archivados, conserva el de mayor `scoreFn` (default: spec>proceso>#labels>id) y el resto a `toTag`.

- [ ] **Step 1: Write the failing test**

```js
const classify = require('../../remote/scripts/bulk-upload-classify.js');
const { selectDuplicates, adaptForClassify } = require('../../remote/scripts/pn-lifecycle-core.js');
const NF = ['Muestras','Lote'];
const EQ = [['Plata','Plata Flash']];
const G = [
  { id:1, name:'X', customer:{id:9}, metal:'Cobre', labels:[{name:'Plata'}], archived:false },      // activo
  { id:2, name:'X', customer:{id:9}, metal:'Cobre', labels:[{name:'Plata Flash'}], archived:true },  // dup del activo (Plata≈Plata Flash)
  { id:3, name:'Y', customer:{id:9}, metal:'Cobre', labels:[{name:'Zinc'}], archived:true },          // solo archivado, único
  { id:4, name:'Z', customer:{id:8}, metal:'Acero', labels:[{name:'Zinc'}], archived:true },          // par archivado
  { id:5, name:'Z', customer:{id:8}, metal:'Acero', labels:[{name:'Zinc'}], archived:true },          // par archivado
];
test('selectDuplicates: dup de activo + entre-archivados', () => {
  const r = selectDuplicates(G, { classify, nonFinishList: NF, equivGroups: EQ, scoreFn: (pn)=>pn.id });
  assert.ok(r.toTag.includes(2));            // dup del activo
  assert.ok(!r.toTag.includes(1) && !r.toTag.includes(3)); // activo y único no
  // par Z: conserva mayor score (id 5), marca 4
  assert.ok(r.toTag.includes(4) && !r.toTag.includes(5));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: FAIL ("selectDuplicates is not a function").

- [ ] **Step 3: Write minimal implementation**

```js
  // adapta el slim al shape que espera buildCompositeKey (customerId, metalBase, labels[].name)
  function adaptForClassify(pn) {
    return { customerId: pn.customer?.id, name: pn.name, metalBase: pn.metal, labels: (pn.labels || []).map(l => l.name) };
  }
  function selectDuplicates(pns, deps) {
    const { classify, nonFinishList, equivGroups, scoreFn } = deps;
    const equivIndex = classify.buildEquivIndex(equivGroups || []);
    const groups = new Map();
    for (const pn of pns || []) {
      const k = classify.buildCompositeKey(adaptForClassify(pn), nonFinishList || [], equivIndex);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pn);
    }
    const score = scoreFn || ((pn) => pn.id);
    const toTag = [], keep = [];
    for (const g of groups.values()) {
      if (g.length < 2) { keep.push(...g.map(p => p.id)); continue; }
      const activos = g.filter(p => !p.archived);
      const arch = g.filter(p => p.archived);
      if (activos.length) { toTag.push(...arch.map(p => p.id)); keep.push(...activos.map(p => p.id)); }
      else {
        const sorted = [...arch].sort((a, b) => score(b) - score(a));
        keep.push(sorted[0].id); toTag.push(...sorted.slice(1).map(p => p.id));
      }
    }
    return { toTag, keep };
  }
```
Agregar `selectDuplicates, adaptForClassify` al `api`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/pn-lifecycle-core.js tools/test/pn-lifecycle.test.js
git commit -m "feat(pn-lifecycle): selectDuplicates (dedup canónica reusando bulk-upload-classify) + tests"
```

---

## Task 4: Core puro — `isInTargetState` + builders de payload de mutación

**Files:**
- Modify: `remote/scripts/pn-lifecycle-core.js`
- Test: `tools/test/pn-lifecycle.test.js`

**Interfaces:**
- Produces:
  - `isInTargetState(pn, action, validacionNodeIds, optInNodeIds?) -> bool`. `action ∈ {'validate','unvalidate','unarchive','archive'}`. Para validate/unvalidate se pasa `optInNodeIds` (los nodes de validación que el PN ya tiene, de GetPartNumber).
  - `buildValidationVars(partNumberId, nodeId) -> {partNumberId, processNodeId, processNodeOccurrence:1, cancelOthers:false}`.
  - `buildArchiveInput(pnNode, labelId) -> input` (reconstrucción REPLACE-safe: labelIds existentes + labelId, preservando defaults/optInOuts/customInputs/FKs/inventory). Copia FIEL del patrón validado en `docs/operations/2026-07-01-...md` (mismo shape que `tag_pns.py:build_input`).
  - `optInsToDelete(pnNode, validacionNodeIds) -> [optInId]` (ids de opt-in records cuyos `processNodeId ∈ validacionNodeIds`).

- [ ] **Step 1: Write the failing test**

```js
const { isInTargetState, buildValidationVars, optInsToDelete, buildArchiveInput } = require('../../remote/scripts/pn-lifecycle-core.js');
const VNODES = [231176, 231174];
test('isInTargetState validate/unvalidate', () => {
  assert.equal(isInTargetState({}, 'validate', VNODES, [231176,231174]), true);   // ya tiene ambos
  assert.equal(isInTargetState({}, 'validate', VNODES, [231176]), false);          // falta uno
  assert.equal(isInTargetState({}, 'unvalidate', VNODES, []), true);               // ya no tiene ninguno
});
test('isInTargetState archive/unarchive por pn.archived', () => {
  assert.equal(isInTargetState({archived:true}, 'unarchive', VNODES), false);
  assert.equal(isInTargetState({archived:false}, 'unarchive', VNODES), true);
});
test('buildValidationVars', () => {
  assert.deepEqual(buildValidationVars(5, 231174), {partNumberId:5, processNodeId:231174, processNodeOccurrence:1, cancelOthers:false});
});
test('optInsToDelete filtra por processNodeId de validación', () => {
  const node = { processNodePartNumberOptInoutsByPartNumberId: { nodes: [
    {id:100, processNodeId:231174}, {id:101, processNodeId:999}, {id:102, processNodeId:231176} ] } };
  assert.deepEqual(optInsToDelete(node, VNODES).sort(), [100,102]);
});
test('buildArchiveInput agrega label preservando labels existentes', () => {
  const node = { id:5, name:'A', partNumberLabelsByPartNumberId:{nodes:[{labelByLabelId:{id:3}}]},
                 customerByCustomerId:{id:9}, inputSchemaId:3223 };
  const inp = buildArchiveInput(node, 15646);
  assert.deepEqual(inp.labelIds.sort(), [3,15646]);
  assert.equal(inp.customerId, 9); assert.equal(inp.id, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation** (portar `build_input` de `tag_pns.py` a JS, ver bitácora de la operación)

```js
  function isInTargetState(pn, action, vnodes, optInNodeIds) {
    if (action === 'unarchive') return pn.archived === false;
    if (action === 'archive')   return pn.archived === true && (pn.labels || []).some(l => l.id === 15646);
    if (action === 'validate')   return (vnodes || []).every(n => (optInNodeIds || []).includes(n));
    if (action === 'unvalidate') return !(vnodes || []).some(n => (optInNodeIds || []).includes(n));
    return false;
  }
  const buildValidationVars = (partNumberId, processNodeId) => ({ partNumberId, processNodeId, processNodeOccurrence: 1, cancelOthers: false });
  function optInsToDelete(node, vnodes) {
    return (node.processNodePartNumberOptInoutsByPartNumberId?.nodes || [])
      .filter(o => (vnodes || []).includes(o.processNodeId)).map(o => o.id);
  }
  function buildArchiveInput(node, addLabelId) {
    const nds = (p) => { let c = node; for (const k of p.split('.')) c = c?.[k]; return c; };
    const fk = (rel) => node[rel]?.id ?? null;
    const list = (p) => nds(p) || [];
    const existing = (node.partNumberLabelsByPartNumberId?.nodes || []).map(l => l.labelByLabelId?.id).filter(x => x != null);
    const labelIds = [...new Set([...existing, addLabelId])];
    const opt = (node.processNodePartNumberOptInoutsByPartNumberId?.nodes || [])
      .filter(o => o.processNodeId != null).map(o => ({ processNodeId: o.processNodeId, processNodeOccurrence: o.processNodeOccurrence ?? 1, cancelOthers: !!o.cancelOthers }));
    const dfl = (node.partNumberProcessNodeDefaultsByPartNumberId?.nodes || [])
      .filter(d => d.treatmentByTreatmentId?.id && d.processNodeId).map(d => ({ treatmentId: d.treatmentByTreatmentId.id, processNodeId: d.processNodeId, processNodeOccurrence: d.processNodeOccurrence ?? 1 }));
    const inv = node.inventoryItemByPartNumberId; let inventoryItemInput = null;
    if (inv) {
      const ucs = (inv.inventoryItemUnitConversionsByInventoryItemId?.nodes || [])
        .filter(u => u.unitByUnitId?.id && u.factor != null).map(u => ({ unitId: u.unitByUnitId.id, factor: u.factor }));
      inventoryItemInput = { materialId: inv.materialByMaterialId?.id ?? null, purchasable: false,
        sourceMaterialConversionType: inv.sourceMaterialConversionType ?? null, providedMaterialConversionType: inv.providedMaterialConversionType ?? null,
        defaultLeadTime: inv.defaultLeadTime ?? null, unitConversions: ucs, inventoryItemVendors: [] };
    }
    return {
      id: node.id, name: node.name, shortName: node.shortName ?? null,
      customerId: fk('customerByCustomerId'), defaultProcessNodeId: fk('processNodeByDefaultProcessNodeId'),
      geometryTypeId: fk('geometryTypeByGeometryTypeId'), partNumberGroupId: fk('partNumberGroupByPartNumberGroupId'),
      inputSchemaId: node.inputSchemaId, customInputs: node.customInputs || {},
      glAccountId: fk('glAccountByGlAccountId'), taxCodeId: fk('taxCodeByTaxCodeId'), certPdfTemplateId: node.certPdfTemplateId ?? null,
      userFileName: null, inventoryItemInput, isOneOff: false, isTemplatePartNumber: !!node.isTemplate, isCoupon: !!node.isCoupon, shipDisassembled: false,
      descriptionMarkdown: node.descriptionMarkdown || '', customerFacingNotes: node.customerFacingNotes || '',
      labelIds, ownerIds: [], optInOuts: opt, defaults: dfl,
      inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
      partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [], partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
      partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: [],
      partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [], defaultSourceConversionItemId: null,
    };
  }
```
Agregar los 4 al `api`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/pn-lifecycle-core.js tools/test/pn-lifecycle.test.js
git commit -m "feat(pn-lifecycle): isInTargetState + payload builders (validación/archive) + tests"
```

---

## Task 5: Scan — `fetchPNsForAction` (paginación slim + includeArchived por acción)

**Files:**
- Create: `remote/scripts/pn-lifecycle.js`
- Test: `tools/test/pn-lifecycle.test.js`

**Interfaces:**
- Consumes: `slimPN`; `window.SteelheadAPI.query('AllPartNumbers', {orderBy:['ID_ASC'],offset,first,searchQuery:'',includeArchived}, 'AllPartNumbers')` → `{pagedData:{nodes,totalCount}}`.
- Produces (en `pn-lifecycle.js`, expuesto vía `window.PNLifecycle._internals`): `fetchPNsForAction(action, api, onProgress, pageSize=500) -> pns[]`. Mapea acción→includeArchived: `validate|unvalidate|archive`→`'NO'`; `unarchive`→`'EXCLUSIVELY'`. `archive` con opción `includeArchivedToo`→ segunda pasada `'EXCLUSIVELY'`. Dedup por `seenIds`.

- [ ] **Step 1: Write the failing test** (mock de `api`)

```js
const { INCLUDE_FOR_ACTION, fetchPNsForAction } = require('../../remote/scripts/pn-lifecycle-core.js');
test('mapa acción → includeArchived', () => {
  assert.equal(INCLUDE_FOR_ACTION.validate, 'NO');
  assert.equal(INCLUDE_FOR_ACTION.unarchive, 'EXCLUSIVELY');
});
test('fetchPNsForAction pagina y hace slim', async () => {
  const page = (nodes, total) => ({ pagedData: { nodes, totalCount: total } });
  const api = { query: async (op, v) => v.offset === 0
      ? page([{id:1,name:'A'},{id:2,name:'B'}], 3)
      : page([{id:3,name:'C'}], 3) };
  const pns = await fetchPNsForAction('validate', api, null, 2);
  assert.deepEqual(pns.map(p=>p.id), [1,2,3]);
  assert.equal(pns[0].archived, false); // 'NO' => activos
});
```

Nota: `INCLUDE_FOR_ACTION` y `fetchPNsForAction` viven en `pn-lifecycle-core.js` (dual-export, ya testeable), recibiendo `api` por parámetro. `pn-lifecycle.js` las consume desde `SteelheadPNLifecycleCore` pasando `window.SteelheadAPI`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation** (en `pn-lifecycle-core.js`)

```js
  const INCLUDE_FOR_ACTION = { validate: 'NO', unvalidate: 'NO', archive: 'NO', unarchive: 'EXCLUSIVELY' };
  async function pageAll(api, includeArchived, archivedFlag, onProgress, pageSize, seen, out, step, steps) {
    let offset = 0, total = null;
    for (;;) {
      const data = await api.query('AllPartNumbers', { orderBy:['ID_ASC'], offset, first:pageSize, searchQuery:'', includeArchived }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) { const tc = data?.pagedData?.totalCount; total = (typeof tc==='number'&&tc>0)?tc:null; }
      for (const n of nodes) { if (seen.has(n.id)) continue; seen.add(n.id); out.push(slimPN(n, archivedFlag)); }
      if (onProgress) onProgress({ processed: offset + nodes.length, total, kept: out.length, step, steps });
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
  }
  async function fetchPNsForAction(action, api, onProgress, pageSize = 500, opts = {}) {
    const inc = INCLUDE_FOR_ACTION[action] || 'NO';
    const archivedFlag = inc === 'EXCLUSIVELY';
    const seen = new Set(), out = [];
    await pageAll(api, inc, archivedFlag, onProgress, pageSize, seen, out, 1, opts.includeArchivedToo ? 2 : 1);
    if (action === 'archive' && opts.includeArchivedToo) {
      await pageAll(api, 'EXCLUSIVELY', true, onProgress, pageSize, seen, out, 2, 2);
    }
    return out;
  }
```
Agregar `INCLUDE_FOR_ACTION, fetchPNsForAction` al `api`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/pn-lifecycle-core.js tools/test/pn-lifecycle.test.js
git commit -m "feat(pn-lifecycle): fetchPNsForAction (scan por acción) + tests"
```

---

## Task 6: Ejecución — `executeAction` (runPool + idempotencia + verificación)

**Files:**
- Modify: `remote/scripts/pn-lifecycle-core.js` (lógica pura de un item) + `remote/scripts/pn-lifecycle.js` (orquestación con api real)
- Test: `tools/test/pn-lifecycle.test.js`

**Interfaces:**
- Produces: `runOneItem(pn, action, api, deps) -> {id, status}` donde `deps={validacionNodeIds, labelId}`. Ejecuta las mutaciones de la Sección 2 del spec con retry, tolerando duplicado en `CreateProcessNodePartNumberOptInout`. Para `archive`/`unvalidate` hace `GetPartNumber` primero. Idempotente vía `isInTargetState`.
- `runPool(items, worker, concurrency=3)` (portar de `archiver.js:28-50`).

- [ ] **Step 1: Write the failing test** (mock api con contador de llamadas)

```js
const { runOneItem } = require('../../remote/scripts/pn-lifecycle-core.js');
test('validate: crea opt-in por cada node; tolera duplicado', async () => {
  const calls = [];
  const api = { query: async (op, v) => { calls.push([op, v.processNodeId ?? v.id ?? null]);
    if (op === 'CreateProcessNodePartNumberOptInout' && v.processNodeId === 231174) throw new Error('unique constraint'); return {}; } };
  const r = await runOneItem({ id:5 }, 'validate', api, { validacionNodeIds:[231176,231174], labelId:15646 });
  assert.equal(r.status, 'ok');
  assert.equal(calls.filter(c=>c[0]==='CreateProcessNodePartNumberOptInout').length, 2);
});
test('unvalidate: GetPartNumber luego Delete por opt-in de validación', async () => {
  const api = { query: async (op, v) => {
    if (op === 'GetPartNumber') return { partNumberById: { processNodePartNumberOptInoutsByPartNumberId: { nodes: [{id:100,processNodeId:231174},{id:101,processNodeId:999}] } } };
    return {}; } };
  const deleted = [];
  const api2 = { query: async (op, v) => { if (op==='GetPartNumber') return api.query(op,v); if (op==='DeleteProcessNodePartNumberOptInOut') deleted.push(v.id); return {}; } };
  const r = await runOneItem({ id:5 }, 'unvalidate', api2, { validacionNodeIds:[231176,231174], labelId:15646 });
  assert.deepEqual(deleted, [100]);   // solo el opt-in de validación (100), no el 101
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```js
  const DUP_RE = /duplicate|unique|already|exists|violat|constraint/i;
  async function runOneItem(pn, action, api, deps) {
    const V = deps.validacionNodeIds, LABEL = deps.labelId;
    try {
      if (action === 'validate') {
        for (const node of V) {
          try { await api.query('CreateProcessNodePartNumberOptInout', buildValidationVars(pn.id, node)); }
          catch (e) { if (!DUP_RE.test(String(e))) throw e; }
        }
        return { id: pn.id, status: 'ok' };
      }
      if (action === 'unarchive') {
        await api.query('UpdatePartNumber', { id: pn.id, archivedAt: null });
        if (deps.alsoValidate) for (const node of V) { try { await api.query('CreateProcessNodePartNumberOptInout', buildValidationVars(pn.id, node)); } catch (e) { if (!DUP_RE.test(String(e))) throw e; } }
        return { id: pn.id, status: 'ok' };
      }
      if (action === 'unvalidate') {
        const data = await api.query('GetPartNumber', { partNumberId: pn.id });
        for (const oid of optInsToDelete(data?.partNumberById || {}, V)) await api.query('DeleteProcessNodePartNumberOptInOut', { id: oid });
        return { id: pn.id, status: 'ok' };
      }
      if (action === 'archive') {
        const data = await api.query('GetPartNumber', { partNumberId: pn.id });
        await api.query('SavePartNumber', { input: [buildArchiveInput(data?.partNumberById || { id: pn.id, name: pn.name }, LABEL)] });
        if (!pn.archived) await api.query('UpdatePartNumber', { id: pn.id, archivedAt: new Date().toISOString() });
        return { id: pn.id, status: 'ok' };
      }
      return { id: pn.id, status: 'noop' };
    } catch (e) { return { id: pn.id, status: 'error', error: String(e?.message || e).slice(0, 160) }; }
  }
```
Agregar `runOneItem, DUP_RE` al `api`. (Nota: en `runOneItem` se usan `buildValidationVars`, `optInsToDelete`, `buildArchiveInput` ya definidos en Task 4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/pn-lifecycle-core.js tools/test/pn-lifecycle.test.js
git commit -m "feat(pn-lifecycle): runOneItem por acción (granular + idempotente) + tests"
```

---

## Task 7: UI + orquestación en `pn-lifecycle.js`

**Files:**
- Create/complete: `remote/scripts/pn-lifecycle.js`

**Interfaces:**
- Consumes: todo `SteelheadPNLifecycleCore`; `SteelheadHostCleanup`; `SteelheadBulkClassify`; `config.steelhead.domain.{validacionProcessNodeIds, bulkUpload.{nonFinishLabelNames, metalEquivalents}}`.
- Produces: `window.PNLifecycle.openConfigAndRun()`.

- [ ] **Step 1:** Implementar el shell del applet siguiendo FIELMENTE el patrón de `remote/scripts/archiver.js` (overlay dark-mode idempotente `showUI`, `setProgress`, `runPool` concurrencia 3, resume `sa_pnlifecycle_resume_v1`, `startHostGuards`/`stopMemMonitor`, `withRetry`). Pantallas:
  - `showConfigForm()` → radios de **acción** (Marcar validación [default] / Desarchivar / Quitar validación / Archivar) + checkbox "marcar validación al desarchivar" (solo unarchive) + checkbox "incluir ya archivados" (solo archive). Devuelve `{action, ...opts}`.
  - `showFilterScreen(pns, facets)` → multiselect de cliente/proceso/línea/depto/metal (de `discoverFacets`), etiquetas AND/OR, fecha, y toggle **"solo duplicados genuinos"** (llama `selectDuplicates` con `nonFinishLabelNames`+`metalEquivalents` del config; cuando está activo, restringe a `toTag`). Conteo en vivo con `applyFilters`.
  - `showPreview(pns, action)` → tabla (cap 500, DOM API/textContent XSS-safe: PN, cliente, proceso, metal, acabados), confirm, botón acción-color.
  - `showResult(stats, action)`.
- [ ] **Step 2:** `run(opts)`: `startHostGuards()` → `fetchPNsForAction(action, api, progress)` → `discoverFacets` → `showFilterScreen` → `applyFilters`(+dedup) → `showPreview` → `executeAction` (`runPool(3)` de `runOneItem`, idempotencia con `isInTargetState`, `saveResume` cada 5, `drainPerPN=makePeriodicDrain(50)`, verificación post con re-`GetPartNumber` opcional) → `showResult` + descarga `pn_lifecycle_results.json`. `finally { stopMemMonitor() }`.
- [ ] **Step 3:** Verificar sintaxis:

Run: `node --check remote/scripts/pn-lifecycle.js`
Expected: sin salida (OK).

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/pn-lifecycle.js
git commit -m "feat(pn-lifecycle): applet UI + orquestación (4 acciones, filtros, dedup, dry-run)"
```

---

## Task 8: Config + extensión + deploy

**Files:**
- Modify: `remote/config.json`, `extension/background.js`

- [ ] **Step 1:** En `remote/config.json` → `steelhead.hashes.mutations`, agregar los 3 hashes (verbatim de Global Constraints). Verificar que `GetPartNumber` vivo (`804dd8f7…`) esté registrado; si difiere del de config, actualizar (coordinar hot file).
- [ ] **Step 2:** Agregar app a `config.apps[]`:
```json
{ "id": "pn-lifecycle", "label": "Ciclo de vida de PNs", "icon": "♻️",
  "message": "run-pn-lifecycle",
  "scripts": ["scripts/host-cleanup-shared.js","scripts/steelhead-api.js","scripts/bulk-upload-cc.js","scripts/bulk-upload-classify.js","scripts/pn-lifecycle-core.js","scripts/pn-lifecycle.js"] }
```
- [ ] **Step 3:** En `extension/background.js`, case `run-pn-lifecycle`: inyectar los scripts de la app y llamar `window.PNLifecycle.openConfigAndRun()` (patrón idéntico a `run-archiver`).
- [ ] **Step 4:** Correr toda la suite:

Run: `node --test tools/test/pn-lifecycle.test.js`
Expected: PASS (todas).

- [ ] **Step 5: Deploy** (desde workbench): `SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh pn-lifecycle-core "feat(pn-lifecycle): core" ` y luego el resto de scripts; o coordinar en `main` con `tools/deploy.sh` si se tocan hashes de `config.json` (hot file). Verificar con `tools/deploy-status.sh`.
- [ ] **Step 6:** Piloto en vivo por acción sobre un filtro pequeño (dry-run → 1-2 PNs) antes de uso masivo. Registrar en `docs/applets/` bitácora nueva `pn-lifecycle.md`.

---

## Self-Review (cobertura del spec)
- Acciones (4): Tasks 4/6 (payloads + runOneItem) + Task 7 (UI). ✓
- Filtros (cliente/proceso/línea/depto/metal/etiquetas/fecha): Task 2. ✓
- Dedup canónica: Task 3 (reusa `bulk-upload-classify`). ✓
- Slim enriquecido en 1 pasada: Tasks 1 + 5. ✓
- Mutaciones granulares + hashes: Global Constraints + Tasks 6/8. ✓
- Memory-hardening: Task 7. ✓ · Testing: Tasks 1-6. ✓ · Deploy: Task 8. ✓
- Idempotencia (`isInTargetState`): Task 4 + aplicada en Task 7 orquestación. ✓
