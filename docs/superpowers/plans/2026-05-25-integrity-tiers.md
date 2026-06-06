# Integridad multi-tier en el Auditor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar la sección "Integridad" del Auditor de PNs por detección de duplicados con 3 tiers (DURO/MEDIO/SUAVE), desambiguación por score, archivado batch inline y export de candidatos a DELETE.

**Architecture:** Módulo `remote/scripts/duplicate-tiers.js` puro funcional (sin DOM/fetch) como single source of truth. Consumido por el applet `auditor.js` (UI completa, archive inline) y por `tools/audit-incomplete-pns.js` (DevTools tool, mismo flujo con fetch+eval del módulo desde gh-pages). Fetch en dos pases: `AllPartNumbers` paginado para bucketizar; `GetPartNumber` solo a PNs en buckets ≥ 2 para enriquecer score.

**Tech Stack:** JavaScript vanilla, sin frameworks. Persisted queries de Apollo (hashes en `config.json`). Pool de concurrencia + withRetry (patrón del proyecto). Tests con `node:test` + `vm` sandbox.

**Spec:** `docs/superpowers/specs/2026-05-25-integrity-tiers-design.md`

---

## File Structure

**Create:**
- `remote/scripts/duplicate-tiers.js` — módulo puro funcional con la API descrita en el spec
- `tools/test/duplicate-tiers.test.js` — unit tests sobre el módulo
- `docs/applets/integrity-tiers.md` — bitácora del nuevo flow

**Modify:**
- `remote/config.json` — añadir `scripts/duplicate-tiers.js` a `apps[id=auditor].scripts`, bump `version`
- `extension/background.js:56-74` — añadir entry al map `globals`
- `remote/scripts/auditor.js` — reemplazar lógica de `duplicates`/`similar` en CRITERIA, añadir flow de tiers (pases 1+2), UI de bucket cards, archive batch, CSV DELETE, JSON export
- `tools/audit-incomplete-pns.js:49-65` — fetch+eval de `duplicate-tiers.js` después del config fetch
- `tools/audit-incomplete-pns.js:580` — reemplazar botón "🚨 Buscar duplicados QuoteIBMS" por "🔍 Scan integridad (duro/medio/suave)" con nuevo flow

**Deploy:**
- `gh-pages` branch: sync byte-exact con `remote/` siguiendo procedimiento de `CLAUDE.md`

---

## Notas de testing

Los tests viven en `tools/test/*.test.js` y se corren con `node --test tools/test/<file>.test.js`. El patrón estándar del proyecto (ver `tools/test/bulk-upload-helpers.test.js`) es:
1. Cargar el script en vm sandbox con stubs de `window`/`document`/`fetch`/`localStorage`/etc.
2. Extraer el módulo expuesto en `sandbox.window.X`.
3. Testear funciones puras directamente.

Las Tasks 1-9 son TDD-puro (módulo `duplicate-tiers.js` es funcional puro). Las Tasks 10-19 (UI del auditor + tools/) NO tienen cobertura de tests automáticos — son testeables solo en navegador real contra Steelhead. Cada una incluye su test plan manual.

---

### Task 1: Setup — esqueleto del módulo + test harness

**Files:**
- Create: `remote/scripts/duplicate-tiers.js`
- Create: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Crear el esqueleto del módulo**

Escribe `remote/scripts/duplicate-tiers.js` con:

```js
// Steelhead Duplicate Tiers Module
// Bucketización + scoring de duplicados de PNs (DURO/MEDIO/SUAVE).
// Puro funcional: sin DOM, sin fetch, sin dependencias externas.
//
// Spec: docs/superpowers/specs/2026-05-25-integrity-tiers-design.md
//
// API expuesta en window.SADuplicateTiers:
//   • Bucketización (pase 1, solo AllPartNumbers):
//       hardBuckets(pns)
//       mediumBucketsCandidates(pns)
//       softBucketsCandidates(pns)
//   • Refinamiento (pase 2, requiere GetPartNumber detail por PN):
//       refineMediumBuckets(candidates, detailsByPnId, opts)
//       refineSoftBuckets(candidates, detailsByPnId, opts)
//   • Scoring:
//       scoreFor(pn, details)
//       pickWinner(bucket)
//   • Helpers:
//       canonicalMetal(name, metalEquivalents)
//       canonicalFinishings(labels, nonFinishLabelNames)
//       isNonFinishLabel(name, nonFinishLabelNames)
//       computeDeleteCandidates(bucket)

const SADuplicateTiers = (() => {
  'use strict';

  // ─── helpers ───────────────────────────────────────────────────
  // scaffolding: cuerpos se implementan en Task 2
  function isNonFinishLabel(name, nonFinishList) { return false; }
  function canonicalFinishings(labels, nonFinishList) { return ''; }
  function canonicalMetal(metalBase, metalEquivalents) { return ''; }

  // ─── scoring ───────────────────────────────────────────────────
  // scaffolding: cuerpos se implementan en Tasks 3-4
  function scoreFor(pn, details) { return 0; }
  function pickWinner(bucket) { return null; }

  // ─── bucketización (pase 1) ────────────────────────────────────
  // scaffolding: cuerpos se implementan en Tasks 5-7
  function hardBuckets(pns) { return []; }
  function mediumBucketsCandidates(pns) { return []; }
  function softBucketsCandidates(pns) { return []; }

  // ─── refinamiento (pase 2) ─────────────────────────────────────
  // scaffolding: cuerpos se implementan en Tasks 6-7
  function refineMediumBuckets(candidates, detailsByPnId, opts) { return []; }
  function refineSoftBuckets(candidates, detailsByPnId, opts) { return []; }

  // ─── delete candidates ─────────────────────────────────────────
  // scaffolding: cuerpo se implementa en Task 9
  function computeDeleteCandidates(bucket) { return []; }

  return {
    hardBuckets, mediumBucketsCandidates, softBucketsCandidates,
    refineMediumBuckets, refineSoftBuckets,
    scoreFor, pickWinner,
    canonicalMetal, canonicalFinishings, isNonFinishLabel,
    computeDeleteCandidates,
  };
})();

if (typeof window !== 'undefined') window.SADuplicateTiers = SADuplicateTiers;
```

- [ ] **Step 2: Crear el test harness**

Escribe `tools/test/duplicate-tiers.test.js`:

```js
// tools/test/duplicate-tiers.test.js
// Carga remote/scripts/duplicate-tiers.js en un vm con stub window y extrae
// window.SADuplicateTiers para testear funciones puras.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'duplicate-tiers.js');

function loadModule() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'duplicate-tiers.js' });
  if (!sandbox.window.SADuplicateTiers) {
    throw new Error('window.SADuplicateTiers no fue exportado');
  }
  return sandbox.window.SADuplicateTiers;
}

test('harness boots and exports SADuplicateTiers', () => {
  const M = loadModule();
  assert.equal(typeof M, 'object');
  assert.equal(typeof M.hardBuckets, 'function');
  assert.equal(typeof M.scoreFor, 'function');
});

module.exports = { loadModule };
```

- [ ] **Step 3: Correr el harness para verificar que carga**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: 1 pass — "harness boots and exports SADuplicateTiers"

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): esqueleto del módulo + test harness"
```

---

### Task 2: Helpers de canonicalización

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js` (helpers: `isNonFinishLabel`, `canonicalFinishings`, `canonicalMetal`)
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para `isNonFinishLabel`**

Añade a `tools/test/duplicate-tiers.test.js`:

```js
const NON_FINISH = ['SMY', 'STX', 'SXC', 'SRG', 'SCM', 'SQ1', 'SQ2', 'NP desconocido', 'En desarrollo', 'Muestras', 'Lote', 'Obsoleto'];

test('isNonFinishLabel: matchea exact case-sensitive', () => {
  const M = loadModule();
  assert.equal(M.isNonFinishLabel('SMY', NON_FINISH), true);
  assert.equal(M.isNonFinishLabel('NP desconocido', NON_FINISH), true);
  assert.equal(M.isNonFinishLabel('NIQ', NON_FINISH), false);
  assert.equal(M.isNonFinishLabel('smy', NON_FINISH), false); // case-sensitive
  assert.equal(M.isNonFinishLabel('', NON_FINISH), false);
  assert.equal(M.isNonFinishLabel(null, NON_FINISH), false);
  assert.equal(M.isNonFinishLabel(undefined, NON_FINISH), false);
});
```

- [ ] **Step 2: Run tests, verificar que fallan**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: FAIL (la función retorna `undefined` o lanza)

- [ ] **Step 3: Implementar `isNonFinishLabel`**

En `remote/scripts/duplicate-tiers.js`, reemplaza el stub:

```js
function isNonFinishLabel(name, nonFinishList) {
  if (!name) return false;
  return Array.isArray(nonFinishList) && nonFinishList.includes(name);
}
```

- [ ] **Step 4: Run tests, verificar PASS**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS para isNonFinishLabel

- [ ] **Step 5: Tests para `canonicalFinishings`**

Añade a `tools/test/duplicate-tiers.test.js`:

```js
test('canonicalFinishings: filtra nonFinish, deduplica, ordena ASC, joinea con |', () => {
  const M = loadModule();
  assert.equal(M.canonicalFinishings(['NIQ', 'EST', 'SMY'], NON_FINISH), 'EST|NIQ');
  assert.equal(M.canonicalFinishings(['SMY', 'STX'], NON_FINISH), ''); // todos nonFinish
  assert.equal(M.canonicalFinishings([], NON_FINISH), '');
  assert.equal(M.canonicalFinishings(['CROMADO'], NON_FINISH), 'CROMADO');
  assert.equal(M.canonicalFinishings(['NIQ', 'NIQ', 'EST'], NON_FINISH), 'EST|NIQ'); // dedup
  assert.equal(M.canonicalFinishings(['NIQ', null, '', 'EST'], NON_FINISH), 'EST|NIQ');
});
```

- [ ] **Step 6: Implementar `canonicalFinishings`**

```js
function canonicalFinishings(labels, nonFinishList) {
  if (!Array.isArray(labels)) return '';
  const seen = new Set();
  for (const l of labels) {
    if (!l) continue;
    if (isNonFinishLabel(l, nonFinishList)) continue;
    seen.add(l);
  }
  return [...seen].sort().join('|');
}
```

- [ ] **Step 7: Run tests, verificar PASS**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS

- [ ] **Step 8: Tests para `canonicalMetal`**

```js
const METAL_EQUIV = [
  ['Estaño', 'Estaño s/Aluminio', 'Estaño s/Cobre'],
  ['Plata', 'Plata Flash'],
];

test('canonicalMetal: colapsa equivalentes al primero del grupo', () => {
  const M = loadModule();
  assert.equal(M.canonicalMetal('Estaño s/Aluminio', METAL_EQUIV), 'Estaño');
  assert.equal(M.canonicalMetal('Estaño s/Cobre', METAL_EQUIV), 'Estaño');
  assert.equal(M.canonicalMetal('Plata Flash', METAL_EQUIV), 'Plata');
  assert.equal(M.canonicalMetal('Cobre', METAL_EQUIV), 'Cobre'); // no en ningún grupo
  assert.equal(M.canonicalMetal('', METAL_EQUIV), '');
  assert.equal(M.canonicalMetal(null, METAL_EQUIV), '');
  assert.equal(M.canonicalMetal('Estaño', []), 'Estaño'); // sin equivalents
});
```

- [ ] **Step 9: Implementar `canonicalMetal`**

```js
function canonicalMetal(metalBase, metalEquivalents) {
  if (!metalBase) return '';
  if (!Array.isArray(metalEquivalents)) return metalBase;
  for (const group of metalEquivalents) {
    if (!Array.isArray(group) || group.length === 0) continue;
    if (group.includes(metalBase)) return group[0];
  }
  return metalBase;
}
```

- [ ] **Step 10: Run tests, verificar PASS**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS en todo el archivo

- [ ] **Step 11: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): helpers de canonicalización (labels, metalBase)"
```

---

### Task 3: Scoring (`scoreFor`)

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js`
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para `scoreFor`**

Añade a `tools/test/duplicate-tiers.test.js`:

```js
// Fixtures
function pnEmpty() {
  return { id: 1, name: 'PN-1', customerId: 100, createdAt: '2026-01-01T00:00:00Z', customInputs: {} };
}
function detailsEmpty() {
  return {
    defaultProcessNodeId: null,
    partNumberSpecsByPartNumberId: { nodes: [] },
    partNumberRackTypesByPartNumberId: { nodes: [] },
    inventoryPredictedUsagesByPartNumberId: { nodes: [] },
    inventoryItemByPartNumberId: { inventoryItemUnitConversionsByInventoryItemId: { nodes: [] } },
    descriptionMarkdown: '',
    partNumberGroupId: null,
    dimensionCustomValueIds: [],
    partNumberPricesByPartNumberId: { nodes: [] },
    customInputs: {},
    partNumberLabelsByPartNumberId: { nodes: [] },
  };
}

test('scoreFor: PN totalmente vacío puntúa 0', () => {
  const M = loadModule();
  assert.equal(M.scoreFor(pnEmpty(), detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 0);
});

test('scoreFor: hasProcess vale 5', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.defaultProcessNodeId = 'proc-1';
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 5);
});

test('scoreFor: specsCount > 0 vale 5 baseline + 1 por spec', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.partNumberSpecsByPartNumberId.nodes = [{}, {}, {}]; // 3 specs
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 5 + 3);
});

test('scoreFor: hasQuoteIBMS vale 2', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { QuoteIBMS: '84531' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: hasQuoteIBMS string vacío NO suma', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { QuoteIBMS: '' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 0);
});

test('scoreFor: hasDefaultPrice vale 2', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.partNumberPricesByPartNumberId.nodes = [{ isDefault: false }, { isDefault: true }];
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: hasNotasAdicionalesIBMS vale 2', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { NotasAdicionales: 'Texto largo de IBMS' };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: finishingsCount filtra nonFinish y suma 1 por finishing', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.partNumberLabelsByPartNumberId.nodes = [
    { labelByLabelId: { name: 'NIQ' } },
    { labelByLabelId: { name: 'EST' } },
    { labelByLabelId: { name: 'SMY' } }, // nonFinish, no cuenta
  ];
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: hasMetalBase vale 1', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { BaseMetal: 'Cobre' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 1);
});

test('scoreFor: hasSat vale 1', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosFacturacion: { CodigoSAT: '25171802' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 1);
});

test('scoreFor: hasDescription, hasGroup, racks/predictives/unitConversions/dimCustomValues cuentan', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.descriptionMarkdown = '  Algo  ';
  d.partNumberGroupId = 'g-1';
  d.partNumberRackTypesByPartNumberId.nodes = [{}];
  d.inventoryPredictedUsagesByPartNumberId.nodes = [{}, {}];
  d.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes = [{}];
  d.dimensionCustomValueIds = ['lin-1', 'lin-2'];
  // 1 desc + 1 group + 1 rack + 2 predict + 1 uc + 2 dim = 8
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 8);
});

test('scoreFor: PN enriquecido completo puntúa ~30+', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = {
    DatosAdicionalesNP: { QuoteIBMS: '84531', BaseMetal: 'Cobre' },
    DatosFacturacion: { CodigoSAT: '25171802' },
    NotasAdicionales: 'IBMS',
  };
  const d = detailsEmpty();
  d.defaultProcessNodeId = 'proc-1';
  d.partNumberSpecsByPartNumberId.nodes = [{}, {}];
  d.partNumberRackTypesByPartNumberId.nodes = [{}];
  d.inventoryPredictedUsagesByPartNumberId.nodes = [{}];
  d.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes = [{}, {}];
  d.partNumberPricesByPartNumberId.nodes = [{ isDefault: true }];
  d.descriptionMarkdown = 'desc';
  d.partNumberGroupId = 'g-1';
  d.dimensionCustomValueIds = ['lin-1'];
  d.partNumberLabelsByPartNumberId.nodes = [{ labelByLabelId: { name: 'NIQ' } }, { labelByLabelId: { name: 'EST' } }];
  // 5 proc + 5 specs(baseline) + 2 specs(count) + 2 quoteibms + 2 defaultPrice + 2 notas
  // + 2 finishings + 1 racks + 1 predict + 2 uc + 1 dim + 1 desc + 1 group + 1 metal + 1 sat
  // = 29
  assert.equal(M.scoreFor(pn, d, { nonFinishLabelNames: NON_FINISH }), 29);
});

test('scoreFor: tolera details null (score parcial con solo AllPartNumbers data)', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { QuoteIBMS: '84531' }, NotasAdicionales: 'IBMS' };
  pn.labels = ['NIQ', 'EST']; // viene de AllPartNumbers
  // Sin details: solo 2 + 2 + 2 finishings = 6
  assert.equal(M.scoreFor(pn, null, { nonFinishLabelNames: NON_FINISH }), 6);
});
```

- [ ] **Step 2: Run tests, verificar FAIL**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: FAIL en todos los `scoreFor` (stub retorna `undefined`)

- [ ] **Step 3: Implementar `scoreFor`**

En `remote/scripts/duplicate-tiers.js`:

```js
function scoreFor(pn, details, opts) {
  const nonFinishList = (opts && opts.nonFinishLabelNames) || [];
  const ci = pn && pn.customInputs || {};
  const da = ci.DatosAdicionalesNP || {};
  const df = ci.DatosFacturacion || {};

  let score = 0;

  // Críticos (5)
  const hasProcess = !!(details && details.defaultProcessNodeId);
  if (hasProcess) score += 5;

  const specsArr = (details && details.partNumberSpecsByPartNumberId && details.partNumberSpecsByPartNumberId.nodes) || [];
  if (specsArr.length > 0) score += 5;

  // Enriquecimiento confiable (2)
  if (da.QuoteIBMS && String(da.QuoteIBMS).trim()) score += 2;

  const prices = (details && details.partNumberPricesByPartNumberId && details.partNumberPricesByPartNumberId.nodes) || [];
  if (prices.some(p => p && p.isDefault)) score += 2;

  if (ci.NotasAdicionales && String(ci.NotasAdicionales).trim()) score += 2;

  // Por cantidad (1 por item)
  // Finishings: prefer details.partNumberLabelsByPartNumberId; fallback a pn.labels (AllPartNumbers shape).
  let labelNames = [];
  if (details && details.partNumberLabelsByPartNumberId && Array.isArray(details.partNumberLabelsByPartNumberId.nodes)) {
    labelNames = details.partNumberLabelsByPartNumberId.nodes.map(n => n && n.labelByLabelId && n.labelByLabelId.name).filter(Boolean);
  } else if (Array.isArray(pn.labels)) {
    labelNames = pn.labels;
  }
  const finishings = labelNames.filter(l => !isNonFinishLabel(l, nonFinishList));
  score += finishings.length;

  score += specsArr.length;
  score += ((details && details.partNumberRackTypesByPartNumberId && details.partNumberRackTypesByPartNumberId.nodes) || []).length;
  score += ((details && details.inventoryPredictedUsagesByPartNumberId && details.inventoryPredictedUsagesByPartNumberId.nodes) || []).length;
  score += ((details && details.inventoryItemByPartNumberId && details.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId && details.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes) || []).length;
  score += ((details && details.dimensionCustomValueIds) || []).length;

  // Otros (1)
  if (details && details.descriptionMarkdown && String(details.descriptionMarkdown).trim()) score += 1;
  if (details && details.partNumberGroupId) score += 1;
  if (da.BaseMetal && String(da.BaseMetal).trim()) score += 1;
  if (df.CodigoSAT && String(df.CodigoSAT).trim()) score += 1;

  return score;
}
```

- [ ] **Step 4: Run tests, verificar PASS**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS en todo

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): scoreFor con regla 'no PN sin proceso/spec'"
```

---

### Task 4: Winner selection (`pickWinner`)

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js`
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para `pickWinner`**

Añade a `tools/test/duplicate-tiers.test.js`:

```js
test('pickWinner: gana el de mayor score', () => {
  const M = loadModule();
  const bucket = {
    members: [
      { id: 10, score: 5, createdAt: '2026-01-01T00:00:00Z' },
      { id: 20, score: 8, createdAt: '2026-01-01T00:00:00Z' },
      { id: 30, score: 3, createdAt: '2026-01-01T00:00:00Z' },
    ],
  };
  assert.equal(M.pickWinner(bucket), 20);
});

test('pickWinner: tiebreak por createdAt más reciente', () => {
  const M = loadModule();
  const bucket = {
    members: [
      { id: 10, score: 5, createdAt: '2026-01-01T00:00:00Z' },
      { id: 20, score: 5, createdAt: '2026-05-01T00:00:00Z' }, // más reciente
      { id: 30, score: 5, createdAt: '2026-03-01T00:00:00Z' },
    ],
  };
  assert.equal(M.pickWinner(bucket), 20);
});

test('pickWinner: tiebreak final por id mayor (más reciente)', () => {
  const M = loadModule();
  const bucket = {
    members: [
      { id: 10, score: 5, createdAt: '2026-05-01T00:00:00Z' },
      { id: 99, score: 5, createdAt: '2026-05-01T00:00:00Z' },
      { id: 50, score: 5, createdAt: '2026-05-01T00:00:00Z' },
    ],
  };
  assert.equal(M.pickWinner(bucket), 99);
});

test('pickWinner: bucket con un solo miembro retorna ese id', () => {
  const M = loadModule();
  assert.equal(M.pickWinner({ members: [{ id: 7, score: 0, createdAt: '2026-01-01' }] }), 7);
});

test('pickWinner: bucket vacío retorna null', () => {
  const M = loadModule();
  assert.equal(M.pickWinner({ members: [] }), null);
});
```

- [ ] **Step 2: Run tests, verificar FAIL**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: FAIL

- [ ] **Step 3: Implementar `pickWinner`**

```js
function pickWinner(bucket) {
  const members = (bucket && bucket.members) || [];
  if (!members.length) return null;
  // Orden: score DESC, createdAt DESC, id DESC.
  let winner = members[0];
  for (let i = 1; i < members.length; i++) {
    const m = members[i];
    if (m.score > winner.score) winner = m;
    else if (m.score === winner.score) {
      const t1 = new Date(m.createdAt || 0).getTime();
      const t2 = new Date(winner.createdAt || 0).getTime();
      if (t1 > t2) winner = m;
      else if (t1 === t2 && Number(m.id) > Number(winner.id)) winner = m;
    }
  }
  return winner.id;
}
```

- [ ] **Step 4: Run tests, verificar PASS**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): pickWinner por score + tiebreakers"
```

---

### Task 5: Hard buckets (`hardBuckets`)

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js`
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para `hardBuckets`**

Añade a `tools/test/duplicate-tiers.test.js`:

```js
function pnWith({ id, customerId, name, quoteIBMS, baseMetal, labels, createdAt }) {
  return {
    id,
    name: name || 'PN-X',
    customerByCustomerId: customerId != null ? { id: customerId, name: 'Cust-' + customerId } : null,
    customerId,
    createdAt: createdAt || '2026-01-01T00:00:00Z',
    customInputs: { DatosAdicionalesNP: { QuoteIBMS: quoteIBMS || '', BaseMetal: baseMetal || '' } },
    partNumberLabelsByPartNumberId: { nodes: (labels || []).map(n => ({ labelByLabelId: { name: n } })) },
  };
}

test('hardBuckets: agrupa por QuoteIBMS no vacío, ignora vacíos', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' }),
    pnWith({ id: 2, customerId: 100, quoteIBMS: '84531' }),
    pnWith({ id: 3, customerId: 100, quoteIBMS: '99999' }), // single
    pnWith({ id: 4, customerId: 100, quoteIBMS: '' }),       // empty -> ignored
    pnWith({ id: 5, customerId: 100 }),                       // null -> ignored
  ];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].quoteIBMS, '84531');
  assert.deepEqual(buckets[0].members.map(m => m.id).sort(), [1, 2]);
});

test('hardBuckets: cross-customer agrupa', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' }),
    pnWith({ id: 2, customerId: 200, quoteIBMS: '84531' }), // distinto cliente
  ];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].members.length, 2);
});

test('hardBuckets: bucket de 1 miembro NO se reporta', () => {
  const M = loadModule();
  const pns = [pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' })];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 0);
});

test('hardBuckets: maneja customInputs como string JSON', () => {
  const M = loadModule();
  const pn = pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' });
  pn.customInputs = JSON.stringify(pn.customInputs); // string en vez de objeto
  const pns = [pn, pnWith({ id: 2, customerId: 100, quoteIBMS: '84531' })];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].members.length, 2);
});

test('hardBuckets: QuoteIBMS whitespace-only se ignora', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, quoteIBMS: '   ' }),
    pnWith({ id: 2, customerId: 100, quoteIBMS: '   ' }),
  ];
  assert.equal(M.hardBuckets(pns).length, 0);
});
```

- [ ] **Step 2: Run tests, verificar FAIL**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: FAIL

- [ ] **Step 3: Implementar `hardBuckets` + helper `parseCustomInputs`**

```js
function parseCustomInputs(ci) {
  if (!ci) return {};
  if (typeof ci === 'string') {
    try { return JSON.parse(ci); } catch { return {}; }
  }
  return ci;
}

function hardBuckets(pns) {
  const byKey = new Map();
  for (const pn of pns || []) {
    const ci = parseCustomInputs(pn.customInputs);
    const qibms = ci.DatosAdicionalesNP && ci.DatosAdicionalesNP.QuoteIBMS;
    if (!qibms || !String(qibms).trim()) continue;
    const key = String(qibms).trim();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(pn);
  }
  const result = [];
  for (const [quoteIBMS, members] of byKey) {
    if (members.length >= 2) result.push({ quoteIBMS, members });
  }
  return result;
}
```

- [ ] **Step 4: Run tests, verificar PASS**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): hardBuckets cross-customer por QuoteIBMS"
```

---

### Task 6: Medium buckets (candidates + refinamiento)

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js`
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para `mediumBucketsCandidates`**

```js
test('mediumBucketsCandidates: agrupa por (customerId, nameUpperTrim), excluye buckets de 1', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, name: '  Tornillo 1/4  ' }),
    pnWith({ id: 2, customerId: 100, name: 'TORNILLO 1/4' }),
    pnWith({ id: 3, customerId: 100, name: 'Otro' }), // singleton, skip
    pnWith({ id: 4, customerId: 200, name: 'Tornillo 1/4' }), // distinto cliente, mismo nombre — bucket aparte
    pnWith({ id: 5, customerId: 200, name: 'Tornillo 1/4' }),
  ];
  const buckets = M.mediumBucketsCandidates(pns);
  // Esperado: 2 buckets {customerId 100: [1,2]} y {customerId 200: [4,5]}
  assert.equal(buckets.length, 2);
  const sorted = buckets.sort((a, b) => a.customerId - b.customerId);
  assert.equal(sorted[0].customerId, 100);
  assert.deepEqual(sorted[0].members.map(m => m.id).sort(), [1, 2]);
  assert.equal(sorted[0].name, 'TORNILLO 1/4');
  assert.equal(sorted[1].customerId, 200);
});

test('mediumBucketsCandidates: PNs sin customerId se excluyen', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: null, name: 'X' }),
    pnWith({ id: 2, customerId: null, name: 'X' }),
  ];
  assert.equal(M.mediumBucketsCandidates(pns).length, 0);
});
```

- [ ] **Step 2: Implementar `mediumBucketsCandidates`**

```js
function mediumBucketsCandidates(pns) {
  const byKey = new Map();
  for (const pn of pns || []) {
    const cid = (pn.customerByCustomerId && pn.customerByCustomerId.id) || pn.customerId;
    if (cid == null) continue;
    const name = (pn.name || '').toUpperCase().trim();
    if (!name) continue;
    const key = cid + '||' + name;
    if (!byKey.has(key)) byKey.set(key, { customerId: cid, name, members: [] });
    byKey.get(key).members.push(pn);
  }
  return [...byKey.values()].filter(b => b.members.length >= 2);
}
```

- [ ] **Step 3: Run tests, verificar PASS**

- [ ] **Step 4: Tests para `refineMediumBuckets`**

```js
test('refineMediumBuckets: subgrupa por metalBase canónico + acabados canónicos', () => {
  const M = loadModule();
  const pn1 = pnWith({ id: 1, customerId: 100, name: 'Tornillo', baseMetal: 'Cobre', labels: ['NIQ', 'EST'] });
  const pn2 = pnWith({ id: 2, customerId: 100, name: 'Tornillo', baseMetal: 'Cobre', labels: ['NIQ', 'EST', 'SMY'] }); // SMY nonFinish, mismo acabado canónico
  const pn3 = pnWith({ id: 3, customerId: 100, name: 'Tornillo', baseMetal: 'Cobre', labels: ['CRO'] }); // distinto
  const pn4 = pnWith({ id: 4, customerId: 100, name: 'Tornillo', baseMetal: 'Estaño s/Aluminio', labels: ['NIQ', 'EST'] }); // metal distinto (canónico: Estaño)

  // details por PN: para refine usamos pn.partNumberLabelsByPartNumberId si está, sino pn.labels (de AllPartNumbers)
  const details = {
    1: { partNumberLabelsByPartNumberId: pn1.partNumberLabelsByPartNumberId, customInputs: pn1.customInputs },
    2: { partNumberLabelsByPartNumberId: pn2.partNumberLabelsByPartNumberId, customInputs: pn2.customInputs },
    3: { partNumberLabelsByPartNumberId: pn3.partNumberLabelsByPartNumberId, customInputs: pn3.customInputs },
    4: { partNumberLabelsByPartNumberId: pn4.partNumberLabelsByPartNumberId, customInputs: pn4.customInputs },
  };
  const candidates = [{ customerId: 100, name: 'TORNILLO', members: [pn1, pn2, pn3, pn4] }];
  const refined = M.refineMediumBuckets(candidates, details, { nonFinishLabelNames: NON_FINISH, metalEquivalents: METAL_EQUIV });

  // Esperado: 1 bucket (cobre + EST|NIQ con miembros 1,2). pn3 distinto acabado, pn4 distinto metal → singletons descartados.
  assert.equal(refined.length, 1);
  assert.equal(refined[0].metalBase, 'Cobre');
  assert.equal(refined[0].finishings, 'EST|NIQ');
  assert.deepEqual(refined[0].members.map(m => m.id).sort(), [1, 2]);
});
```

- [ ] **Step 5: Implementar `refineMediumBuckets`**

```js
function refineMediumBuckets(candidates, detailsByPnId, opts) {
  const nonFinishList = (opts && opts.nonFinishLabelNames) || [];
  const metalEquiv = (opts && opts.metalEquivalents) || [];
  const result = [];
  for (const cand of candidates || []) {
    const subByKey = new Map();
    for (const pn of cand.members) {
      const det = detailsByPnId && detailsByPnId[pn.id];
      const ciSrc = (det && det.customInputs) || pn.customInputs;
      const ci = parseCustomInputs(ciSrc);
      const metalRaw = (ci.DatosAdicionalesNP && ci.DatosAdicionalesNP.BaseMetal) || '';
      const metalCanon = canonicalMetal(metalRaw, metalEquiv);
      const labelNodes = (det && det.partNumberLabelsByPartNumberId && det.partNumberLabelsByPartNumberId.nodes)
        || (pn.partNumberLabelsByPartNumberId && pn.partNumberLabelsByPartNumberId.nodes)
        || [];
      const labels = labelNodes.map(n => n && n.labelByLabelId && n.labelByLabelId.name).filter(Boolean);
      const finishings = canonicalFinishings(labels, nonFinishList);
      const subKey = metalCanon + '||' + finishings;
      if (!subByKey.has(subKey)) subByKey.set(subKey, { customerId: cand.customerId, name: cand.name, metalBase: metalCanon, finishings, members: [] });
      subByKey.get(subKey).members.push(pn);
    }
    for (const b of subByKey.values()) if (b.members.length >= 2) result.push(b);
  }
  return result;
}
```

- [ ] **Step 6: Run tests, verificar PASS**

- [ ] **Step 7: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): mediumBuckets (candidates + refine canónico)"
```

---

### Task 7: Soft buckets (candidates + refinamiento asimétrico)

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js`
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para `softBucketsCandidates` y `refineSoftBuckets`**

```js
test('softBucketsCandidates: misma agrupación que medium (customer + name)', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, name: 'X' }),
    pnWith({ id: 2, customerId: 100, name: 'X' }),
  ];
  const buckets = M.softBucketsCandidates(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].members.length, 2);
});

test('refineSoftBuckets: bucket asimétrico (uno con acabados, otro sin) ES candidato', () => {
  const M = loadModule();
  const pn1 = pnWith({ id: 1, customerId: 100, name: 'X', labels: ['NIQ'] });
  const pn2 = pnWith({ id: 2, customerId: 100, name: 'X', labels: [] });
  const cands = [{ customerId: 100, name: 'X', members: [pn1, pn2] }];
  const details = { 1: { partNumberLabelsByPartNumberId: pn1.partNumberLabelsByPartNumberId }, 2: { partNumberLabelsByPartNumberId: pn2.partNumberLabelsByPartNumberId } };
  const refined = M.refineSoftBuckets(cands, details, { nonFinishLabelNames: NON_FINISH });
  assert.equal(refined.length, 1);
});

test('refineSoftBuckets: todos con acabados (distintos) NO es candidato', () => {
  const M = loadModule();
  const pn1 = pnWith({ id: 1, customerId: 100, name: 'X', labels: ['NIQ'] });
  const pn2 = pnWith({ id: 2, customerId: 100, name: 'X', labels: ['EST'] });
  const cands = [{ customerId: 100, name: 'X', members: [pn1, pn2] }];
  const details = { 1: { partNumberLabelsByPartNumberId: pn1.partNumberLabelsByPartNumberId }, 2: { partNumberLabelsByPartNumberId: pn2.partNumberLabelsByPartNumberId } };
  assert.equal(M.refineSoftBuckets(cands, details, { nonFinishLabelNames: NON_FINISH }).length, 0);
});

test('refineSoftBuckets: todos vacíos NO es candidato', () => {
  const M = loadModule();
  const pn1 = pnWith({ id: 1, customerId: 100, name: 'X', labels: [] });
  const pn2 = pnWith({ id: 2, customerId: 100, name: 'X', labels: ['SMY'] }); // SMY nonFinish → cuenta como vacío
  const cands = [{ customerId: 100, name: 'X', members: [pn1, pn2] }];
  const details = { 1: { partNumberLabelsByPartNumberId: pn1.partNumberLabelsByPartNumberId }, 2: { partNumberLabelsByPartNumberId: pn2.partNumberLabelsByPartNumberId } };
  assert.equal(M.refineSoftBuckets(cands, details, { nonFinishLabelNames: NON_FINISH }).length, 0);
});
```

- [ ] **Step 2: Implementar `softBucketsCandidates`**

```js
function softBucketsCandidates(pns) {
  // mismo agrupado que medium — la regla de asimetría se aplica en refine
  return mediumBucketsCandidates(pns);
}
```

- [ ] **Step 3: Implementar `refineSoftBuckets`**

```js
function refineSoftBuckets(candidates, detailsByPnId, opts) {
  const nonFinishList = (opts && opts.nonFinishLabelNames) || [];
  const result = [];
  for (const cand of candidates || []) {
    let withFin = 0, withoutFin = 0;
    for (const pn of cand.members) {
      const det = detailsByPnId && detailsByPnId[pn.id];
      const labelNodes = (det && det.partNumberLabelsByPartNumberId && det.partNumberLabelsByPartNumberId.nodes)
        || (pn.partNumberLabelsByPartNumberId && pn.partNumberLabelsByPartNumberId.nodes)
        || [];
      const labels = labelNodes.map(n => n && n.labelByLabelId && n.labelByLabelId.name).filter(Boolean);
      const finishings = canonicalFinishings(labels, nonFinishList);
      if (finishings) withFin++;
      else withoutFin++;
    }
    if (withFin >= 1 && withoutFin >= 1) {
      result.push({ customerId: cand.customerId, name: cand.name, members: cand.members });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests, verificar PASS**

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): softBuckets con regla asimetría de acabados"
```

---

### Task 8: Precedencia (DURO > MEDIO > SUAVE) + DELETE candidates

**Files:**
- Modify: `remote/scripts/duplicate-tiers.js`
- Modify: `tools/test/duplicate-tiers.test.js`

- [ ] **Step 1: Tests para precedencia**

```js
test('precedencia: PN clasificado DURO no aparece en MEDIO/SUAVE', () => {
  const M = loadModule();
  // pn1 y pn2 comparten QuoteIBMS — DURO
  // pn1 y pn3 además comparten (customer, name, metalBase, finishings) — MEDIO si no fuera por precedencia
  const pn1 = pnWith({ id: 1, customerId: 100, name: 'X', quoteIBMS: '84531', baseMetal: 'Cobre', labels: ['NIQ'] });
  const pn2 = pnWith({ id: 2, customerId: 200, name: 'X', quoteIBMS: '84531', baseMetal: 'Plomo', labels: ['EST'] }); // duro cross-customer
  const pn3 = pnWith({ id: 3, customerId: 100, name: 'X', quoteIBMS: '99999', baseMetal: 'Cobre', labels: ['NIQ'] }); // candidato medio con pn1
  const pns = [pn1, pn2, pn3];

  const hard = M.hardBuckets(pns);
  assert.equal(hard.length, 1);
  assert.deepEqual(hard[0].members.map(m => m.id).sort(), [1, 2]);

  // Excluir PNs ya en DURO
  const usedIds = new Set();
  for (const b of hard) for (const m of b.members) usedIds.add(m.id);
  const remaining = pns.filter(p => !usedIds.has(p.id));
  assert.deepEqual(remaining.map(p => p.id), [3]);

  const medCands = M.mediumBucketsCandidates(remaining);
  // pn3 solo → no bucket
  assert.equal(medCands.length, 0);
});
```

- [ ] **Step 2: Verificar que el test pasa con la API actual**

Run: `node --test tools/test/duplicate-tiers.test.js`
Expected: PASS (no necesita código nuevo — la precedencia es responsabilidad del orchestrator/caller, no del módulo).

Nota: La documentación del módulo y el spec ya describen este patrón. El orchestrator (auditor.js y audit-incomplete-pns.js) hará la exclusión. El módulo no encadena explícitamente para mantenerse simple y reusable.

- [ ] **Step 3: Tests para `computeDeleteCandidates`**

```js
test('computeDeleteCandidates DURO: todos los perdedores van al CSV', () => {
  const M = loadModule();
  const bucket = { tier: 'DURO', members: [{ id: 1, quoteIBMS: '84531' }, { id: 2, quoteIBMS: '84531' }, { id: 3, quoteIBMS: '84531' }], winnerId: 2 };
  const dc = M.computeDeleteCandidates(bucket);
  assert.deepEqual(dc.sort(), [1, 3]);
});

test('computeDeleteCandidates MEDIO con ≥1 sin QuoteIBMS: perdedores van', () => {
  const M = loadModule();
  const bucket = { tier: 'MEDIO', members: [{ id: 1, quoteIBMS: '84531' }, { id: 2, quoteIBMS: '' }], winnerId: 1 };
  assert.deepEqual(M.computeDeleteCandidates(bucket), [2]);
});

test('computeDeleteCandidates MEDIO con todos QuoteIBMS distinto no-vacío: vacío', () => {
  const M = loadModule();
  const bucket = { tier: 'MEDIO', members: [{ id: 1, quoteIBMS: '84531' }, { id: 2, quoteIBMS: '99999' }], winnerId: 1 };
  assert.deepEqual(M.computeDeleteCandidates(bucket), []);
});

test('computeDeleteCandidates SUAVE con todos vacíos NO debería existir (caller filtró)', () => {
  // SUAVE solo se crea con asimetría → al menos uno tiene finishings, no necesariamente quoteIBMS.
  // Regla del CSV: si TODOS tienen quoteIBMS distinto no-vacío → vacío. Else → perdedores.
  const M = loadModule();
  const bucket = { tier: 'SUAVE', members: [{ id: 1, quoteIBMS: '' }, { id: 2, quoteIBMS: '' }], winnerId: 1 };
  assert.deepEqual(M.computeDeleteCandidates(bucket), [2]);
});
```

- [ ] **Step 4: Implementar `computeDeleteCandidates`**

```js
function computeDeleteCandidates(bucket) {
  if (!bucket || !Array.isArray(bucket.members)) return [];
  const members = bucket.members;
  const winnerId = bucket.winnerId;
  const losers = members.filter(m => m.id !== winnerId).map(m => m.id);
  if (bucket.tier === 'DURO') return losers;
  // MEDIO/SUAVE: vacío si todos tienen quoteIBMS distinto no-vacío
  const quotes = members.map(m => (m.quoteIBMS || '').trim()).filter(Boolean);
  if (quotes.length === members.length) {
    const allDistinct = new Set(quotes).size === quotes.length;
    if (allDistinct) return [];
  }
  return losers;
}
```

- [ ] **Step 5: Run tests, verificar PASS**

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/duplicate-tiers.js tools/test/duplicate-tiers.test.js
git commit -m "feat(duplicate-tiers): precedencia (responsabilidad del caller) + computeDeleteCandidates"
```

---

### Task 9: Config + background.js — wire up del módulo

**Files:**
- Modify: `remote/config.json`
- Modify: `extension/background.js:56-74`

- [ ] **Step 1: Bump `version` y añadir `duplicate-tiers.js` a `apps[auditor].scripts`**

Lee `remote/config.json` y haz dos cambios:

1. Bump `version`: si actual es `1.4.40`, ponlo `1.5.0` (minor bump por feature nuevo).
2. En el bloque `apps`, encuentra el objeto `{ "id": "auditor", ... }` y modifica `scripts`:

```json
"scripts": ["scripts/steelhead-api.js", "scripts/duplicate-tiers.js", "scripts/auditor.js"],
```

- [ ] **Step 2: Añadir entry al map `globals` en background.js**

En `extension/background.js`, dentro del objeto literal `globals` (línea 56-74), añade:

```js
'scripts/duplicate-tiers.js': 'SADuplicateTiers',
```

Ubicación sugerida: al lado de `'scripts/spec-shared.js': 'SpecShared'`. El orden no importa funcionalmente.

- [ ] **Step 3: Verificar manualmente que la carga en chrome funciona**

Test manual (la prueba automatizada requiere browser):
1. Recarga la extensión en `chrome://extensions`.
2. Abre `app.gosteelhead.com`, abre DevTools console.
3. Dispara el applet Auditor (popup → Auditor de PNs → Auditar PNs).
4. En la consola escribe `window.SADuplicateTiers` y verifica que aparece el objeto con `hardBuckets`, `scoreFor`, etc.
5. Verifica que `window.SADuplicateTiers.__saVersion === '1.5.0'` (o el valor actual del bump).

- [ ] **Step 4: Commit**

```bash
git add remote/config.json extension/background.js
git commit -m "chore(config): wire duplicate-tiers.js al applet auditor + bump 1.5.0"
```

---

### Task 10: Auditor.js — refactor de CRITERIA y stub del flow nuevo

**Files:**
- Modify: `remote/scripts/auditor.js:65-106` (CRITERIA + carga del módulo)

- [ ] **Step 1: Reemplazar entries de Integridad en CRITERIA**

En `remote/scripts/auditor.js`, ubica el array `CRITERIA` (línea 65). Reemplaza los tres entries de Integridad existentes:

```js
// REMOVE:
{ id: 'duplicates', group: 'Integridad', label: 'PNs duplicados (nombre exacto)', check: null },
{ id: 'similar', group: 'Integridad', label: 'PNs duplicados por similitud (~80%)', check: null },
{ id: 'no-customer', group: 'Integridad', label: 'Sin cliente asignado', check: f => !f.customerId },
```

Por:

```js
// Integridad — tier-based duplicate detection (handled in runIntegrityScan)
{ id: 'dup-hard',   group: 'Integridad', label: 'PNs duplicados — DUROS (mismo QuoteIBMS)', check: null },
{ id: 'dup-medium', group: 'Integridad', label: 'PNs duplicados — MEDIOS (mismo metalBase + acabados + cliente)', check: null },
{ id: 'dup-soft',   group: 'Integridad', label: 'PNs duplicados — SUAVES (mismo nombre + cliente, acabados asimétricos)', check: null },
{ id: 'no-customer', group: 'Integridad', label: 'Sin cliente asignado', check: f => !f.customerId },
{ id: 'similar', group: 'Integridad', label: 'PNs por similitud de nombre (~80%)', check: null }, // ortogonal, conservado
```

(El criterio `similar` se mantiene tal cual su lógica actual — solo se mueve a la lista nueva sin cambiar la implementación.)

- [ ] **Step 2: Test manual de la UI**

Test manual:
1. Recarga la extensión.
2. Dispara el applet Auditor.
3. Verifica que los nuevos labels aparecen en la sección Integridad de la UI de criterios.
4. NO chequear ningún tier todavía — la lógica viene en Task 11.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): refactor de criterios Integridad a 3 tiers (sin lógica)"
```

---

### Task 11: Auditor.js — implementar pase 1 (AllPartNumbers paginado activos+archivados)

**Files:**
- Modify: `remote/scripts/auditor.js` — añadir `fetchAllPNsWithArchived` y un wrapper `runIntegrityScan` que orquesta los pases

- [ ] **Step 1: Añadir helper `fetchAllPNsWithArchived`**

Inserta una función después de `extractAuditFlags` (línea ~183):

```js
const ARCHIVED_SENTINEL = '__archived__';

// Paginated fetch of all PNs (active + archived) por dos pasadas de AllPartNumbers
// con includeArchived 'NO' y 'YES'. Patrón de bulk-upload.js:1180.
async function fetchAllPNsWithArchived(opts) {
  const { customerFilter, searchQuery, includeArchived, onProgress } = opts;
  const all = [];
  const activeIds = new Set();
  const seenIds = new Set();
  const pageSize = 500;

  // Pasada 1: activos
  let offset = 0;
  while (!stopped) {
    const vars = { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: searchQuery || '', includeArchived: 'NO' };
    const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
    const nodes = data?.pagedData?.nodes || [];
    for (const n of nodes) {
      activeIds.add(n.id);
      if (matchesCustomer(n, customerFilter) && !seenIds.has(n.id)) {
        seenIds.add(n.id);
        all.push({ ...n, archivedAt: null });
      }
    }
    onProgress && onProgress(`Pase 1 (activos): ${all.length} PNs · offset ${offset}`);
    if (nodes.length < pageSize) break;
    offset += pageSize;
  }
  if (stopped) return all;

  // Pasada 2: archivados (solo si toggle ON)
  if (includeArchived) {
    offset = 0;
    while (!stopped) {
      const vars = { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: searchQuery || '', includeArchived: 'YES' };
      const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (activeIds.has(n.id)) continue; // ya añadido por pasada 1
        if (matchesCustomer(n, customerFilter) && !seenIds.has(n.id)) {
          seenIds.add(n.id);
          all.push({ ...n, archivedAt: ARCHIVED_SENTINEL });
        }
      }
      onProgress && onProgress(`Pase 1 (archivados): ${all.length} PNs · offset ${offset}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
  }
  return all;
}

function matchesCustomer(node, customerFilter) {
  if (!customerFilter) return true;
  const cn = node.customerByCustomerId?.name || '';
  return cn.toUpperCase().includes(customerFilter.toUpperCase());
}
```

- [ ] **Step 2: Test manual del fetch**

Test manual: invoca este helper desde la console después de cargar el auditor para verificar shape:
```js
await window.PNAuditor.__test_fetchAllPNsWithArchived({ customerFilter: 'SCHNEIDER', includeArchived: true, onProgress: (s) => console.log(s) });
```

(Si `__test_fetchAllPNsWithArchived` no está expuesto, expónlo temporalmente en el `return` del IIFE o testea via DevTools después del flow completo en Task 12.)

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): fetchAllPNsWithArchived (pase 1 dos sub-pasadas)"
```

---

### Task 12: Auditor.js — orquestación de tiers + pase 2 (GetPartNumber a candidatos)

**Files:**
- Modify: `remote/scripts/auditor.js`

- [ ] **Step 1: Añadir `runIntegrityScan` que orquesta los pases**

Añade después de `fetchAllPNsWithArchived`:

```js
async function runIntegrityScan(options) {
  const { selectedTiers, customerFilter, searchQuery, includeArchived, config } = options;
  const tiersMod = window.SADuplicateTiers;
  if (!tiersMod) throw new Error('SADuplicateTiers no cargado');

  const nonFinishList = config.apps?.find(a => a.id === 'carga-masiva')?.config?.nonFinishLabelNames || [];
  const metalEquiv = config.apps?.find(a => a.id === 'carga-masiva')?.config?.metalEquivalents || [];

  // ── Pase 1 ──
  updateAuditorUI('Pase 1: cargando PNs (activos+archivados)...');
  const allPNs = await fetchAllPNsWithArchived({
    customerFilter, searchQuery, includeArchived,
    onProgress: (msg) => updateAuditorUI(msg)
  });
  if (stopped) return { stopped: true };
  log(`Pase 1: ${allPNs.length} PNs cargados`);

  // ── Bucketización pase 1 ──
  const hard = selectedTiers.includes('dup-hard') ? tiersMod.hardBuckets(allPNs) : [];
  const usedIds = new Set();
  for (const b of hard) for (const m of b.members) usedIds.add(m.id);

  const remainingForMedSoft = allPNs.filter(p => !usedIds.has(p.id));
  const medCands = (selectedTiers.includes('dup-medium') || selectedTiers.includes('dup-soft'))
    ? tiersMod.mediumBucketsCandidates(remainingForMedSoft)
    : [];

  // ── Pase 2: GetPartNumber a candidatos únicos ──
  const candidateIds = new Set();
  for (const b of hard) for (const m of b.members) candidateIds.add(m.id);
  for (const b of medCands) for (const m of b.members) candidateIds.add(m.id);

  log(`Pase 2: ${candidateIds.size} candidatos a enriquecer (de ${allPNs.length} totales)`);
  updateAuditorUI(`Pase 2: enriqueciendo ${candidateIds.size} candidatos...`, true);

  const detailsByPnId = {};
  const failedIds = new Set();
  let processed = 0;
  await runPool([...candidateIds], async (pnId) => {
    if (stopped) return;
    try {
      const d = await withRetry(
        () => api().query('GetPartNumber', { partNumberId: pnId, usagesLimit: 100, usagesOffset: 0 }),
        `audit-tier ${pnId}`
      );
      detailsByPnId[pnId] = d?.partNumberById || null;
    } catch (e) {
      if (e?.message === '__sa_aborted__') return;
      failedIds.add(pnId);
      warn(`GetPartNumber ${pnId}: ${String(e).substring(0, 80)}`);
    }
    processed++;
    if (processed % 10 === 0 || processed === candidateIds.size) {
      updateAuditorUI(`Pase 2: ${processed}/${candidateIds.size} (${failedIds.size} fallaron)`, true);
    }
  }, 6);
  if (stopped) return { stopped: true, partialDetails: detailsByPnId };

  // ── Refinamiento + scoring + winners ──
  const allPnsById = {};
  for (const p of allPNs) allPnsById[p.id] = p;

  function buildBucketWithScores(rawBucket, tier) {
    const members = rawBucket.members.map(pn => {
      const det = detailsByPnId[pn.id];
      const score = tiersMod.scoreFor(pn, det, { nonFinishLabelNames: nonFinishList });
      const ci = (() => { try { return typeof pn.customInputs === 'string' ? JSON.parse(pn.customInputs) : (pn.customInputs || {}); } catch { return {}; } })();
      return {
        id: pn.id,
        name: pn.name,
        customer: pn.customerByCustomerId?.name || '',
        customerId: pn.customerByCustomerId?.id || null,
        quoteIBMS: ci.DatosAdicionalesNP?.QuoteIBMS || '',
        metalBase: ci.DatosAdicionalesNP?.BaseMetal || '',
        createdAt: pn.createdAt,
        archived: !!pn.archivedAt,
        score,
        scoreParcial: !det && failedIds.has(pn.id),
        details: det,
      };
    });
    const bucket = { tier, ...rawBucket, members };
    bucket.winnerId = tiersMod.pickWinner(bucket);
    bucket.deleteCandidates = tiersMod.computeDeleteCandidates(bucket);
    return bucket;
  }

  const hardBuckets = hard.map(b => buildBucketWithScores(b, 'DURO'));

  const medium = selectedTiers.includes('dup-medium')
    ? tiersMod.refineMediumBuckets(medCands, detailsByPnId, { nonFinishLabelNames: nonFinishList, metalEquivalents: metalEquiv })
    : [];
  const mediumIds = new Set();
  for (const b of medium) for (const m of b.members) mediumIds.add(m.id);
  const mediumBuckets = medium.map(b => buildBucketWithScores(b, 'MEDIO'));

  const softCandsRemaining = selectedTiers.includes('dup-soft')
    ? medCands
        .map(c => ({ ...c, members: c.members.filter(m => !mediumIds.has(m.id)) }))
        .filter(c => c.members.length >= 2)
    : [];
  const softRefined = selectedTiers.includes('dup-soft')
    ? tiersMod.refineSoftBuckets(softCandsRemaining, detailsByPnId, { nonFinishLabelNames: nonFinishList })
    : [];
  const softBuckets = softRefined.map(b => buildBucketWithScores(b, 'SUAVE'));

  return { hardBuckets, mediumBuckets, softBuckets, totalPNs: allPNs.length, failedIds: [...failedIds] };
}
```

- [ ] **Step 2: Wire `run(options)` para llamar `runIntegrityScan` cuando algún tier está seleccionado**

Modifica la función `run(options)` (línea 188). Antes de `Per-PN criteria`, añade:

```js
const tierCriteria = ['dup-hard', 'dup-medium', 'dup-soft'];
const selectedTierCrit = selectedCriteria.filter(c => tierCriteria.includes(c));
let integrityResult = null;
if (selectedTierCrit.length > 0) {
  integrityResult = await runIntegrityScan({
    selectedTiers: selectedTierCrit,
    customerFilter,
    searchQuery,
    includeArchived: options.includeArchived !== false, // default ON
    config,
  });
  if (integrityResult?.stopped) {
    return { ...results, stopped: true, integrity: integrityResult };
  }
  results.integrity = integrityResult;
  for (const c of selectedTierCrit) {
    const key = c === 'dup-hard' ? 'hardBuckets' : c === 'dup-medium' ? 'mediumBuckets' : 'softBuckets';
    const buckets = integrityResult[key] || [];
    results.criteria[c].count = buckets.reduce((acc, b) => acc + b.members.length, 0);
    // tarjetas detalladas se renderizan separadas en Task 13; aquí solo el conteo
  }
}
```

Y declara `let config` accesible (pásalo via `options` o `window.REMOTE_CONFIG`).

Como `run(options)` no recibía `config` antes, agrégalo a las `options` en el caller. Si el caller no lo tiene, usa fallback: `options.config || window.REMOTE_CONFIG || (await chrome.storage.local.get('config')).config`.

- [ ] **Step 3: Test manual end-to-end**

Test manual:
1. Recarga extensión, abre popup → Auditor.
2. Marca solo `PNs duplicados — DUROS`.
3. Filtra por un cliente con duplicados conocidos (ej. `SCHNEIDER ELECTRIC MEXICO` — tiene 22 buckets DURO según `audit-incomplete-pns.md:178`).
4. Ejecuta. Verifica en `window.PNAuditor.__lastResults` (o lo que expongas) que `integrity.hardBuckets.length === 22` o similar.
5. Si falla: revisar console.log en cada pase, comparar con resultados del DevTools tool actual.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): runIntegrityScan con pase 2 GetPartNumber a candidatos"
```

---

### Task 13: Auditor.js — UI de bucket cards

**Files:**
- Modify: `remote/scripts/auditor.js`

- [ ] **Step 1: Añadir renderer de tarjetas**

Añade después de `removeAuditorUI` una función:

```js
function renderIntegrityResults(integrity) {
  if (!integrity) return '';
  const tiers = [
    { key: 'hardBuckets', label: '🚨 DUROS (mismo QuoteIBMS)', color: '#fca5a5' },
    { key: 'mediumBuckets', label: '⚠ MEDIOS (mismo metalBase + acabados + cliente)', color: '#fde68a' },
    { key: 'softBuckets', label: 'ⓘ SUAVES (asimetría de acabados)', color: '#bae6fd' },
  ];
  let html = '';
  for (const t of tiers) {
    const buckets = integrity[t.key] || [];
    if (!buckets.length) continue;
    html += `<details open style="margin-top:14px"><summary style="color:${t.color};cursor:pointer;font-weight:600">${t.label} — ${buckets.length} buckets · ${buckets.reduce((a, b) => a + b.members.length, 0)} PNs</summary>`;
    for (const b of buckets) {
      html += renderBucketCard(b);
    }
    html += '</details>';
  }
  // Botonera global
  const totalLosers = sumLosers(integrity);
  const totalDelete = sumDelete(integrity);
  html += `<div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="sa-aud-btn" id="sa-int-archive-all" style="background:#16a34a;color:white">Archivar TODOS los descartados (${totalLosers})</button>
    <button class="sa-aud-btn" id="sa-int-csv-delete" style="background:#dc2626;color:white">📋 CSV candidatos a DELETE (${totalDelete})</button>
    <button class="sa-aud-btn" id="sa-int-json-full" style="background:#475569;color:white">💾 JSON audit</button>
  </div>`;
  return html;
}

function renderBucketCard(b) {
  const bucketKey = bucketKeyForCSV(b);
  const headerExtra = b.deleteCandidates.length ? `<span style="color:#fca5a5">🚨 ${b.deleteCandidates.length} candidato(s) a DELETE</span>` : '';
  const rows = b.members.map(m => {
    const isWinner = m.id === b.winnerId;
    const ageDays = m.createdAt ? Math.floor((Date.now() - new Date(m.createdAt).getTime()) / 86400000) : '?';
    const status = m.archived ? '<span style="color:#fca5a5">archivado</span>' : '<span style="color:#86efac">activo</span>';
    const partial = m.scoreParcial ? '<span title="datos incompletos (GetPartNumber falló)" style="color:#fde68a">⚠ parcial</span>' : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:${isWinner ? '#1e293b' : 'transparent'};border-radius:4px">
      <input type="radio" name="winner-${b.tier}-${escapeAttr(bucketKey)}" value="${m.id}" ${isWinner ? 'checked' : ''}>
      <code style="color:#cbd5e1">PN-${m.id}</code>
      <span>${escapeHtml(m.name)}</span>
      <span style="color:#94a3b8">${escapeHtml(m.customer)}</span>
      <span style="color:#a5b4fc">score ${m.score}</span>
      ${status}
      <span style="color:#94a3b8">${ageDays}d</span>
      ${partial}
    </label>`;
  }).join('');
  return `<div class="sa-int-bucket" data-bucket-key="${escapeAttr(bucketKey)}" data-tier="${b.tier}" style="border:1px solid #334155;border-radius:6px;padding:10px;margin-top:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
      <div style="color:#e2e8f0"><b>${b.tier}</b> · ${escapeHtml(humanBucketKey(b))} ${headerExtra}</div>
      <label style="font-size:11px;color:#94a3b8"><input type="checkbox" class="sa-int-apply" checked> Aplicar acción</label>
    </div>
    ${rows}
  </div>`;
}

function bucketKeyForCSV(b) {
  if (b.tier === 'DURO') return 'quoteIBMS=' + b.quoteIBMS;
  if (b.tier === 'MEDIO') return [b.name, b.customerId, b.metalBase, b.finishings].join('||');
  return [b.name, b.customerId].join('||');
}
function humanBucketKey(b) {
  if (b.tier === 'DURO') return 'QuoteIBMS ' + b.quoteIBMS;
  if (b.tier === 'MEDIO') return `${b.name} · cust ${b.customerId} · ${b.metalBase || '∅'} · [${b.finishings || '∅'}]`;
  return `${b.name} · cust ${b.customerId}`;
}
function sumLosers(integ) {
  return [...(integ.hardBuckets || []), ...(integ.mediumBuckets || []), ...(integ.softBuckets || [])]
    .reduce((a, b) => a + b.members.filter(m => m.id !== b.winnerId).length, 0);
}
function sumDelete(integ) {
  return [...(integ.hardBuckets || []), ...(integ.mediumBuckets || []), ...(integ.softBuckets || [])]
    .reduce((a, b) => a + (b.deleteCandidates || []).length, 0);
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
```

- [ ] **Step 2: Pintar el resultado en el DOM después del scan**

En el caller del auditor (donde se imprime el resumen actual de criterios), añade un panel HTML con `renderIntegrityResults(results.integrity)`. Ubicación: dentro del modal de resultados del auditor (busca dónde se muestra el resumen "Auditor terminado" — el sitio exacto depende del UI host del applet; probablemente en `popup.html` o en un modal inyectado por `auditor.js`).

Lo más simple: añadir un `<div id="sa-int-panel">` y poblarlo con `panel.innerHTML = renderIntegrityResults(results.integrity)`.

- [ ] **Step 3: Test manual de UI**

1. Re-deploy a chrome (recarga extensión + re-pegar config si caching).
2. Corre scan con DUROS sobre SCHNEIDER ELECTRIC MEXICO.
3. Verifica que las tarjetas aparecen con radio buttons, score visible, status (active/archived) coloreado.
4. Verifica que el ganador (radio marcado) tiene fondo highlight.
5. Verifica que `Detener` sigue funcionando mid-scan.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): UI de bucket cards (3 tiers con radio + checkbox por bucket)"
```

---

### Task 14: Auditor.js — archivar batch + reintentar fallidos

**Files:**
- Modify: `remote/scripts/auditor.js`

- [ ] **Step 1: Añadir helper `archiveLosers`**

```js
async function archiveLosers(integrity, onProgress) {
  const tasks = [];
  for (const tierKey of ['hardBuckets', 'mediumBuckets', 'softBuckets']) {
    for (const b of (integrity[tierKey] || [])) {
      // Lee selección actualizada del DOM
      const card = document.querySelector(`.sa-int-bucket[data-bucket-key="${cssEscape(bucketKeyForCSV(b))}"]`);
      if (!card) continue;
      if (!card.querySelector('.sa-int-apply').checked) continue;
      const chosenWinner = Number(card.querySelector('input[type=radio]:checked')?.value);
      const winnerId = isNaN(chosenWinner) ? b.winnerId : chosenWinner;
      for (const m of b.members) {
        if (m.id === winnerId) continue;
        if (m.archived) {
          tasks.push({ id: m.id, name: m.name, skip: true, reason: 'already-archived' });
          continue;
        }
        tasks.push({ id: m.id, name: m.name });
      }
    }
  }
  let ok = 0, skipped = 0, failed = 0;
  const failures = [];
  await runPool(tasks, async (t) => {
    if (t.skip) { skipped++; onProgress(ok, skipped, failed, tasks.length); return; }
    try {
      await withRetry(
        () => api().query('UpdatePartNumber', { id: t.id, archivedAt: new Date().toISOString() }, 'UpdatePartNumber'),
        `archive ${t.name}`
      );
      ok++;
    } catch (e) {
      failed++;
      failures.push({ id: t.id, name: t.name, error: String(e).substring(0, 120) });
    }
    onProgress(ok, skipped, failed, tasks.length);
  }, 5);
  return { ok, skipped, failed, failures, totalAttempted: tasks.length };
}

function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-z0-9_-]/gi, '\\$&'); }
```

- [ ] **Step 2: Wire el botón `sa-int-archive-all`**

Después de pintar el panel, attach event listener:

```js
document.getElementById('sa-int-archive-all')?.addEventListener('click', async () => {
  const btn = document.getElementById('sa-int-archive-all');
  btn.disabled = true; btn.textContent = 'Archivando...';
  const result = await archiveLosers(results.integrity, (ok, skipped, failed, total) => {
    btn.textContent = `Archivando... ${ok + skipped + failed}/${total}`;
  });
  btn.textContent = `✓ ${result.ok} archivados · ⏭ ${result.skipped} ya estaban · ✗ ${result.failed} fallaron`;
  // Para fallos: mostrar en consola y abrir botón de reintento
  if (result.failures.length) {
    console.warn('[SA] Archivo fallos:', result.failures);
    const retryBtn = document.createElement('button');
    retryBtn.textContent = `Reintentar ${result.failures.length} fallidos`;
    retryBtn.onclick = async () => {
      // Re-correr sobre los failures
      // (implementación: filtrar integrity para que solo queden los failed IDs)
      // ... simple approach: dejarle al usuario
      alert('Re-correr el scan para reintentar — los archivados con éxito se saltarán por idempotencia.');
    };
    btn.parentNode.appendChild(retryBtn);
  }
  // Rayar visualmente los archivados con éxito
  // (implementación: añadir clase `sa-archived-now` a labels cuyo id está en losers exitosos)
});
```

- [ ] **Step 3: Test manual del archivado**

1. Corre scan, verifica tarjetas.
2. En un bucket de DURO con 2 miembros, deja el ganador sugerido y dale `Archivar TODOS los descartados`.
3. Verifica que el contador progresa y termina con `✓ 1 archivados`.
4. Refresca la página Steelhead manualmente y verifica que el PN perdedor quedó archivado.
5. Re-corre el scan con `Incluir archivados` ON — el PN archivado debe aparecer pero marcado.
6. Re-corre el archive — debe contarlo como `⏭ ya estaba`.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): archiveLosers batch + idempotencia + reintento"
```

---

### Task 15: Auditor.js — CSV "candidatos a DELETE" + JSON export

**Files:**
- Modify: `remote/scripts/auditor.js`

- [ ] **Step 1: Helper `buildDeleteCSV`**

```js
function buildDeleteCSV(integrity) {
  const rows = [[
    'tier', 'bucketKey', 'pnId', 'pnName', 'customer', 'customerId',
    'quoteIBMS', 'metalBase', 'finishings', 'status',
    'createdAt', 'score', 'winnerPnId', 'razon'
  ].join(',')];
  for (const tierKey of ['hardBuckets', 'mediumBuckets', 'softBuckets']) {
    for (const b of (integrity[tierKey] || [])) {
      for (const id of (b.deleteCandidates || [])) {
        const m = b.members.find(x => x.id === id);
        if (!m) continue;
        const razon = b.tier === 'DURO'
          ? `DURO: comparte QuoteIBMS ${b.quoteIBMS}`
          : `${b.tier} sin QuoteIBMS: bucket ${humanBucketKey(b)}`;
        const status = m.archived ? 'archived' : 'active';
        const finishings = b.finishings || '';
        rows.push([
          b.tier,
          q(bucketKeyForCSV(b)),
          m.id,
          q(m.name),
          q(m.customer),
          m.customerId ?? '',
          q(m.quoteIBMS || ''),
          q(m.metalBase || ''),
          q(finishings),
          status,
          q(m.createdAt || ''),
          m.score,
          b.winnerId,
          q(razon),
        ].join(','));
      }
    }
  }
  function q(s) { return `"${String(s ?? '').replace(/"/g, '""')}"`; }
  return rows.join('\n');
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob(['﻿' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Wire los botones**

```js
document.getElementById('sa-int-csv-delete')?.addEventListener('click', () => {
  const csv = buildDeleteCSV(results.integrity);
  downloadBlob(csv, `pn_delete_candidates_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
});

document.getElementById('sa-int-json-full')?.addEventListener('click', () => {
  const json = JSON.stringify({
    timestamp: new Date().toISOString(),
    customerFilter: options.customerFilter,
    integrity: results.integrity,
  }, null, 2);
  downloadBlob(json, `audit_integridad_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
});
```

- [ ] **Step 3: Test manual de exportes**

1. Corre scan con DUROS sobre cliente con duplicados.
2. Click CSV — verifica que descarga con N filas == sumDelete().
3. Abre el CSV en Excel, verifica columnas y razon.
4. Click JSON — verifica shape del dump.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): CSV DELETE + JSON export para tiers"
```

---

### Task 16: Auditor.js — toggle "Incluir archivados"

**Files:**
- Modify: `remote/scripts/auditor.js`

- [ ] **Step 1: Añadir checkbox en la UI de criterios**

En el bloque de UI que pinta los criterios (busca dónde se renderiza la sección "Integridad" — probablemente en un template que el applet genera al lanzar el modal de configuración), añade después de los checkboxes de Integridad:

```html
<label style="display:block;margin-top:6px;color:#94a3b8;font-size:12px">
  <input type="checkbox" id="sa-int-include-archived" checked> Incluir archivados en el scan
</label>
```

- [ ] **Step 2: Pasar el flag al `run(options)`**

En el handler del botón "Auditar" (que llama `PNAuditor.run({...})`), recoge el valor:

```js
const includeArchived = document.getElementById('sa-int-include-archived')?.checked !== false;
PNAuditor.run({ ..., includeArchived });
```

- [ ] **Step 3: Test manual**

1. Apaga toggle, corre scan: solo activos en pase 1, scan más rápido.
2. Prende toggle, corre scan: incluye archivados.
3. Verifica conteo difiere.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/auditor.js
git commit -m "feat(auditor): toggle 'Incluir archivados' en UI"
```

---

### Task 17: Audit-incomplete-pns.js — fetch+eval del módulo

**Files:**
- Modify: `tools/audit-incomplete-pns.js:49-65`

- [ ] **Step 1: Añadir fetch del módulo después del config fetch**

Lee `tools/audit-incomplete-pns.js` líneas 40-70 para entender el flow actual. Después del bloque que setea `config = await r.json();` (línea ~54), añade:

```js
// Cargar módulo SADuplicateTiers desde gh-pages
const tiersUrl = `https://oviazcan.github.io/SteelheadAutomator/scripts/duplicate-tiers.js?v=${config.version || Date.now()}`;
try {
  const tr = await fetch(tiersUrl, { cache: 'no-cache' });
  if (!tr.ok) throw new Error('HTTP ' + tr.status);
  const tiersCode = await tr.text();
  new Function(tiersCode)();
  if (!window.SADuplicateTiers) throw new Error('SADuplicateTiers no se expuso');
} catch (e) {
  alert('No se pudo cargar duplicate-tiers.js: ' + e.message);
  return;
}
```

- [ ] **Step 2: Test manual**

1. Pega el script actualizado en DevTools sobre `app.gosteelhead.com`.
2. Verifica que `window.SADuplicateTiers` queda disponible.
3. Verifica que el flujo CSV-driven existente sigue funcionando (carga un CSV pequeño conocido).

- [ ] **Step 3: Commit**

```bash
git add tools/audit-incomplete-pns.js
git commit -m "feat(audit-incomplete-pns): fetch+eval de duplicate-tiers.js desde gh-pages"
```

---

### Task 18: Audit-incomplete-pns.js — reemplazar botón QuoteIBMS por scan integridad

**Files:**
- Modify: `tools/audit-incomplete-pns.js:580` (botón) y el handler asociado

- [ ] **Step 1: Reemplazar texto del botón y su handler**

Lee `tools/audit-incomplete-pns.js` alrededor de línea 580 y del handler del button (busca `sa-audit-dup-scan`). Reemplaza:

```js
// ANTES (línea ~580)
<button class="sa-audit-btn sa-audit-secondary" id="sa-audit-dup-scan" title="...">🚨 Buscar duplicados QuoteIBMS</button>

// DESPUÉS
<button class="sa-audit-btn sa-audit-secondary" id="sa-audit-tier-scan" title="Scan completo del dominio con 3 tiers de duplicados (DURO/MEDIO/SUAVE) + acciones de archivado y CSV DELETE">🔍 Scan integridad (duro/medio/suave)</button>
```

- [ ] **Step 2: Implementar el handler nuevo**

Reemplaza el listener de `sa-audit-dup-scan` por uno de `sa-audit-tier-scan` que orqueste el mismo flow que `auditor.js`:

```js
document.getElementById('sa-audit-tier-scan').addEventListener('click', async () => {
  const customerFilter = prompt('Filtro por cliente (nombre parcial UPPERCASE), vacío para todo el dominio:') || '';
  const includeArchived = confirm('¿Incluir PNs archivados? (recomendado: Sí)');
  // Reusar las helpers del auditor: paginate, GetPartNumber pool, SADuplicateTiers
  // Implementación: copiar el flow de runIntegrityScan adaptado al gql() local del DevTools tool
  // (no podemos cargar auditor.js aquí — vive en la extensión).
  await runTierScan({ customerFilter, includeArchived });
});

async function runTierScan({ customerFilter, includeArchived }) {
  const tiersMod = window.SADuplicateTiers;
  const nonFinishList = config.steelhead?.domain?.nonFinishLabelNames
    || config.apps?.find(a => a.id === 'carga-masiva')?.config?.nonFinishLabelNames || [];
  const metalEquiv = config.apps?.find(a => a.id === 'carga-masiva')?.config?.metalEquivalents || [];

  log('Pase 1: cargando PNs...');
  const allPNs = [];
  const seenIds = new Set();
  const activeIds = new Set();
  const pageSize = 500;

  // pase 1 activos
  let offset = 0;
  while (true) {
    const d = await withRetry(
      () => gql('AllPartNumbers', { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: '', includeArchived: 'NO' }),
      `AllPartNumbers (NO) offset=${offset}`
    );
    const nodes = d?.pagedData?.nodes || [];
    for (const n of nodes) {
      activeIds.add(n.id);
      if (matchesCustomer(n, customerFilter) && !seenIds.has(n.id)) {
        seenIds.add(n.id);
        allPNs.push({ ...n, archivedAt: null });
      }
    }
    log(`Pase 1 (activos): ${allPNs.length}`);
    if (nodes.length < pageSize) break;
    offset += pageSize;
  }
  // pase 1 archivados
  if (includeArchived) {
    offset = 0;
    while (true) {
      const d = await withRetry(
        () => gql('AllPartNumbers', { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: '', includeArchived: 'YES' }),
        `AllPartNumbers (YES) offset=${offset}`
      );
      const nodes = d?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (activeIds.has(n.id)) continue;
        if (matchesCustomer(n, customerFilter) && !seenIds.has(n.id)) {
          seenIds.add(n.id);
          allPNs.push({ ...n, archivedAt: '__archived__' });
        }
      }
      log(`Pase 1 (archivados): ${allPNs.length}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
  }

  // bucketización
  const hard = tiersMod.hardBuckets(allPNs);
  const usedIds = new Set();
  for (const b of hard) for (const m of b.members) usedIds.add(m.id);
  const medCands = tiersMod.mediumBucketsCandidates(allPNs.filter(p => !usedIds.has(p.id)));

  // pase 2
  const candidateIds = new Set();
  for (const b of hard) for (const m of b.members) candidateIds.add(m.id);
  for (const b of medCands) for (const m of b.members) candidateIds.add(m.id);
  log(`Pase 2: ${candidateIds.size} candidatos`);

  const detailsByPnId = {};
  let processed = 0;
  await runPool([...candidateIds], async (pnId) => {
    try {
      const d = await withRetry(
        () => gql('GetPartNumber', { partNumberId: pnId, usagesLimit: 100, usagesOffset: 0 }),
        `GetPartNumber ${pnId}`
      );
      detailsByPnId[pnId] = d?.partNumberById || null;
    } catch (e) { /* ignored, scoreFor tolerates null */ }
    processed++;
    if (processed % 20 === 0) log(`Pase 2: ${processed}/${candidateIds.size}`);
  }, 6);

  // refinamiento + scoring
  function buildBucket(rawBucket, tier) {
    const members = rawBucket.members.map(pn => {
      const det = detailsByPnId[pn.id];
      const score = tiersMod.scoreFor(pn, det, { nonFinishLabelNames: nonFinishList });
      const ci = (() => { try { return typeof pn.customInputs === 'string' ? JSON.parse(pn.customInputs) : (pn.customInputs || {}); } catch { return {}; } })();
      return {
        id: pn.id, name: pn.name,
        customer: pn.customerByCustomerId?.name || '',
        customerId: pn.customerByCustomerId?.id || null,
        quoteIBMS: ci.DatosAdicionalesNP?.QuoteIBMS || '',
        metalBase: ci.DatosAdicionalesNP?.BaseMetal || '',
        createdAt: pn.createdAt,
        archived: !!pn.archivedAt,
        score, scoreParcial: !det,
      };
    });
    const bucket = { tier, ...rawBucket, members };
    bucket.winnerId = tiersMod.pickWinner(bucket);
    bucket.deleteCandidates = tiersMod.computeDeleteCandidates(bucket);
    return bucket;
  }

  const hardBuckets = hard.map(b => buildBucket(b, 'DURO'));
  const medium = tiersMod.refineMediumBuckets(medCands, detailsByPnId, { nonFinishLabelNames: nonFinishList, metalEquivalents: metalEquiv });
  const mediumIds = new Set();
  for (const b of medium) for (const m of b.members) mediumIds.add(m.id);
  const mediumBuckets = medium.map(b => buildBucket(b, 'MEDIO'));
  const softCands = medCands.map(c => ({ ...c, members: c.members.filter(m => !mediumIds.has(m.id)) })).filter(c => c.members.length >= 2);
  const soft = tiersMod.refineSoftBuckets(softCands, detailsByPnId, { nonFinishLabelNames: nonFinishList });
  const softBuckets = soft.map(b => buildBucket(b, 'SUAVE'));

  const integrity = { hardBuckets, mediumBuckets, softBuckets, totalPNs: allPNs.length };
  window.__lastIntegrityScan = integrity;
  log(`DURO: ${hardBuckets.length}, MEDIO: ${mediumBuckets.length}, SUAVE: ${softBuckets.length} buckets.`);
  log(`Inspecciona window.__lastIntegrityScan para los detalles.`);

  // Render UI mínima en el panel — copia simplificada de auditor.js Task 13
  renderTierResultsInPanel(integrity);
}
```

Y añade un `renderTierResultsInPanel` que es la versión copy-paste del renderer de `auditor.js` Task 13 (mismo HTML/CSS string, mismo bucketKey, mismo flow de botones). Esto cumple la decisión "Opción 1 — UI duplicada con comentario `// SYNCED WITH auditor.js bucket card v1`".

Añade el comentario:
```js
// SYNCED WITH remote/scripts/auditor.js renderIntegrityResults v1 (2026-05-25)
function renderTierResultsInPanel(integrity) { /* ... mismo HTML que auditor.js ... */ }
```

- [ ] **Step 2: Wire botones de archivar y CSV en el DevTools tool**

Mismo patrón que Task 14/15 pero usando `gql()` del DevTools en vez de `api().query()`:

```js
// archive del DevTools
async function archiveLosersDevtools(integrity, onProgress) {
  // ... mismo flow pero con gql('UpdatePartNumber', {id, archivedAt: new Date().toISOString()}) ...
}
```

- [ ] **Step 3: Test manual end-to-end del DevTools tool**

1. Pega el script en DevTools.
2. Click `🔍 Scan integridad`.
3. Filtra por SCHNEIDER ELECTRIC MEXICO, incluye archivados.
4. Verifica que aparecen ~22 DURO buckets (mismo número que el dup-scan-by-customer viejo daba).
5. Compara con `window.__lastIntegrityScan`.

- [ ] **Step 4: Commit**

```bash
git add tools/audit-incomplete-pns.js
git commit -m "feat(audit-incomplete-pns): scan integridad 3-tier (reemplaza botón QuoteIBMS)"
```

---

### Task 19: Deploy a gh-pages

**Files:**
- Sync `remote/` → `gh-pages` byte-exact

- [ ] **Step 1: Confirmar bump de version**

Verifica que `remote/config.json` tiene la `version` bumped (Task 9) y `lastUpdated` actualizado.

- [ ] **Step 2: Stash si hay archivos sin commit**

```bash
git status
```

Si hay archivos modificados sin commit que no son parte de este plan, `git stash`.

- [ ] **Step 3: Sync a gh-pages siguiendo procedimiento de CLAUDE.md**

```bash
git checkout gh-pages
git show main:remote/scripts/duplicate-tiers.js > scripts/duplicate-tiers.js
git show main:remote/scripts/auditor.js > scripts/auditor.js
git show main:remote/config.json > config.json
git add scripts/duplicate-tiers.js scripts/auditor.js config.json
git commit -m "deploy: integridad multi-tier en Auditor + bump <version>"
```

- [ ] **Step 4: Push ambas ramas**

```bash
git push origin main
git push origin gh-pages
```

- [ ] **Step 5: Esperar 30-60s y correr verificación byte-exact**

```bash
git checkout main
tools/check-deploy.sh duplicate-tiers
tools/check-deploy.sh auditor
```

Expected: ambos `OK` byte-exact.

- [ ] **Step 6: Test end-to-end en chrome**

1. `chrome://extensions` → reload extensión.
2. Abre `app.gosteelhead.com`.
3. Popup → Auditor de PNs → marca DUROS → Auditar.
4. Verifica que el flow funciona end-to-end con tarjetas, archive y CSV.

---

### Task 20: Bitácora del nuevo flow

**Files:**
- Create: `docs/applets/integrity-tiers.md`
- Modify: `CLAUDE.md` (añadir al índice de applets)

- [ ] **Step 1: Crear bitácora**

Escribe `docs/applets/integrity-tiers.md`:

```markdown
# `integrity-tiers` — bitácora

Detección de duplicados de PNs en 3 tiers (DURO/MEDIO/SUAVE) dentro del applet
Auditor de PNs (`remote/scripts/auditor.js`). Lógica algorítmica en
`remote/scripts/duplicate-tiers.js` (single source of truth, también consumida
por el DevTools tool `tools/audit-incomplete-pns.js`).

Spec: `docs/superpowers/specs/2026-05-25-integrity-tiers-design.md`

## YYYY-MM-DD — release inicial 1.5.0

### Cambios
- Nuevo módulo `duplicate-tiers.js` con API pura funcional.
- Auditor: reemplazo de `duplicates` (nombre exacto) por 3 tiers; `similar`
  (Levenshtein) se conserva.
- Archivado batch inline + CSV "candidatos a DELETE" + JSON export.
- Toggle "Incluir archivados" (default ON).

### Lecciones
(rellenar después del primer uso en producción)

## Pendientes derivados
- [ ] Resume del scan (localStorage o IndexedDB) — alineado con el pendiente de
      `audit-incomplete-pns.md:55`.
- [ ] Integridad SHA-256 del módulo antes de evaluar — pendiente del audit
      pre-producción (`CLAUDE.md:115`).
- [ ] Promover renderer de tarjetas a `duplicate-tiers-ui.js` si la divergencia
      visual entre applet y DevTools tool eventualmente duele.
```

- [ ] **Step 2: Añadir entry al índice en CLAUDE.md**

En `CLAUDE.md`, sección "Índice de applets", añade la fila:

```markdown
| `integrity-tiers` (Auditor de PNs) | 1.5.0 | [`docs/applets/integrity-tiers.md`](docs/applets/integrity-tiers.md) |
```

- [ ] **Step 3: Commit**

```bash
git add docs/applets/integrity-tiers.md CLAUDE.md
git commit -m "docs(integrity-tiers): bitácora inicial + entry en índice"
```

---

## Self-review pos-plan

**Spec coverage check:**
- Single source of truth en `duplicate-tiers.js` → Task 1 (esqueleto) + Tasks 2-8 (implementación)
- 3 tiers con reglas exactas → Tasks 5, 6, 7
- Scoring con regla "no PN sin proceso/spec" → Task 3
- Tiebreakers → Task 4
- DELETE candidates rule → Task 8
- Precedencia DURO > MEDIO > SUAVE → Task 8 (en el orchestrator, no en el módulo)
- Pase 1 + pase 2 → Tasks 11 + 12
- UI bucket cards + radios + checkbox por bucket → Task 13
- Archivado batch inline → Task 14
- CSV DELETE + JSON export → Task 15
- Toggle archivados → Task 16
- DevTools tool integration → Tasks 17 + 18
- Deploy → Task 19
- Bitácora → Task 20

**Tareas que cubren la spec completamente. Sin gaps identificados.**

**Ambigüedades resueltas:**
- "UI compartida": Opción 1 (duplicada con comentario `// SYNCED`) explícita en Task 18 Step 1.
- "where to display the integrity panel": Task 13 Step 2 reconoce que el sitio exacto depende del UI host; instrucción concreta: añadir `<div id="sa-int-panel">` y poblarlo.
