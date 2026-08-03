# Filtro por Línea Destino (`surtido-guard` v0.3.0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar al Candado de Surtido un filtro que muestre solo las tarjetas cuyo material va a una línea de producción elegida (`T204`, `T300`, …), leyendo el destino de la tabla "Tareas Programadas:" de cada tarjeta.

**Architecture:** Núcleo puro nuevo (`surtido-guard-filter-core.js`) con toda la lógica testeable; el glue en `surtido-guard.js` extrae del DOM, esconde con `display:none` sobre el nodo `[data-item-index]` de react-virtuoso, y pinta un box dark-mode en la barra del header. El filtro **no toca el enforcement** del candado.

**Tech Stack:** JavaScript vanilla (sin frameworks/bundlers), IIFE sobre `window`, `node:test` + `node:assert` para golden tests, fixtures JSON con shapes reales.

**Spec:** [`docs/superpowers/specs/2026-07-29-surtido-guard-line-filter-design.md`](../specs/2026-07-29-surtido-guard-line-filter-design.md) — leerla antes de empezar. Todas las decisiones de DOM ya están **medidas en vivo**, no supuestas.

## Global Constraints

- **Idioma:** código e identificadores en **inglés**; comentarios, UI y docs en **español**.
- **Anclaje:** estructura primero; texto de UI solo como red de seguridad y **siempre ES+EN**.
- **UI propia en DARK MODE:** base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento verde `#13a36f`.
- **El filtro NUNCA toca el enforcement:** prohibido leer/escribir `window.__saSurtidoGuardEnabled`, reenvolver `window.fetch`, o llamar `evaluateMove` desde el código del filtro.
- **Todo el glue del filtro va en `try/catch`:** un error del filtro no puede impedir que el candado se monte.
- **Idempotencia obligatoria:** el `MutationObserver` del applet corre con `subtree:true`; toda escritura al DOM debe poder repetirse sin cambiar el resultado, o entra en bucle.
- **Estado mutable en `window.__sa*`, NO en el closure** — `injectAppScripts` re-evalúa el IIFE en cada acción del popup (lección v0.1.1).
- **Fail-safe:** sin evidencia positiva, **no se esconde**. Un falso oculto esconde trabajo real; un falso visible solo repone el comportamiento de hoy.
- **Correr la suite con:** `tools/run-tests.sh`
- **Nombres de las nuevas columnas de datos medidas:** la celda de estación es `td[1]`, el tratamiento `td[0]`, la fecha `td[2]`.

---

### Task 1: Núcleo — extraer el código de línea de una tarjeta

**Files:**
- Create: `remote/scripts/surtido-guard-filter-core.js`
- Create: `tools/test/surtido-guard-filter-core.test.js`
- Create: `tools/test/fixtures/surtido-guard-filter-cards.json`

**Interfaces:**
- Consumes: nada (primer task).
- Produces: `window.SurtidoGuardFilterCore` con `lineCodeFromStationText(text) → string|null` y `linesFromScheduledRows(rows) → string[]` (códigos únicos, orden de aparición).

- [ ] **Step 1: Crear el fixture con las filas REALES medidas en el board**

Crear `tools/test/fixtures/surtido-guard-filter-cards.json`:

```json
{
  "_comment": "Filas de la tabla 'Tareas Programadas:' capturadas EN VIVO del board /Domains/344/Workboards/6234 (2026-07-29). Cada fila es [tratamiento, estación, fecha] = td[0], td[1], td[2].",
  "programadaCelula": {
    "wo": "16408-ejemplo",
    "rows": [
      ["TR-PRM-001 Antitarnish Manual", "at T300-CE03-002 Célula de Antitarnish", "23/7/2026 - 11:14:20 p.m."]
    ],
    "expectedLines": ["T300"]
  },
  "programadaLinea": {
    "wo": "15246",
    "rows": [
      ["T204 (PLA)-CU/BR-VARIOS", "at T204-LI Plata y Estaño s/Cobre Colgado (16.1)", "24/7/2026 - 5:00:00 p.m."]
    ],
    "expectedLines": ["T204"]
  },
  "multiLinea": {
    "_comment": "Una orden puede correr en varias líneas → la tabla trae N filas.",
    "rows": [
      ["T204 (PLA)-CU/BR-VARIOS", "at T204-LI Plata y Estaño s/Cobre Colgado (16.1)", "24/7/2026 - 5:00:00 p.m."],
      ["T205 (EST)-AL-VARIOS", "at T205-LI Estaño s/Aluminio (16.3)", "25/7/2026 - 8:00:00 a.m."]
    ],
    "expectedLines": ["T204", "T205"]
  },
  "sinCodigoEnEstacion": {
    "_comment": "Estación sin código de línea reconocible → no se puede clasificar.",
    "rows": [
      ["TR-PRM-001 Antitarnish Manual", "at Célula Manual Sin Código", "23/7/2026 - 11:14:20 p.m."]
    ],
    "expectedLines": []
  }
}
```

- [ ] **Step 2: Escribir los tests que fallan**

Crear `tools/test/surtido-guard-filter-core.test.js`:

```js
// Golden tests del módulo puro surtido-guard-filter-core.js (filtro por línea destino).
// Run: node --test tools/test/surtido-guard-filter-core.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'surtido-guard-filter-core.js'));
const Core = global.window.SurtidoGuardFilterCore;

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const CARDS = fx('surtido-guard-filter-cards.json');

// ── lineCodeFromStationText ────────────────────────────────────────────────
test('lineCodeFromStationText: ignora el prefijo "at" (literal EN en UI ES)', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at T204-LI Plata y Estaño s/Cobre Colgado (16.1)'), 'T204');
});

test('lineCodeFromStationText: sirve para CÉLULAS, no solo líneas', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at T300-CE03-002 Célula de Antitarnish'), 'T300');
});

test('lineCodeFromStationText: sin prefijo tambien funciona', () => {
  assert.strictEqual(Core.lineCodeFromStationText('T205-LI Estaño s/Aluminio (16.3)'), 'T205');
});

test('lineCodeFromStationText: NO inventa código en un tratamiento (TR-PRM-001)', () => {
  assert.strictEqual(Core.lineCodeFromStationText('TR-PRM-001 Antitarnish Manual'), null);
});

test('lineCodeFromStationText: normaliza a mayúsculas', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at t204-li algo'), 'T204');
});

test('lineCodeFromStationText: entradas vacías o no-string → null', () => {
  assert.strictEqual(Core.lineCodeFromStationText(''), null);
  assert.strictEqual(Core.lineCodeFromStationText(null), null);
  assert.strictEqual(Core.lineCodeFromStationText(undefined), null);
  assert.strictEqual(Core.lineCodeFromStationText(42), null);
});

test('lineCodeFromStationText: toma el PRIMER código de la celda', () => {
  assert.strictEqual(Core.lineCodeFromStationText('at T204-LI puente a T205'), 'T204');
});

// ── linesFromScheduledRows ────────────────────────────────────────────────
test('linesFromScheduledRows: una fila → una línea (célula real del board)', () => {
  const c = CARDS.programadaCelula;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: una fila → una línea (línea real del board)', () => {
  const c = CARDS.programadaLinea;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: N filas → N líneas (una orden en varias líneas)', () => {
  const c = CARDS.multiLinea;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: estación sin código → lista vacía, no truena', () => {
  const c = CARDS.sinCodigoEnEstacion;
  assert.deepStrictEqual(Core.linesFromScheduledRows(c.rows), c.expectedLines);
});

test('linesFromScheduledRows: lee td[1], NUNCA td[0] — el tratamiento puede traer OTRO código', () => {
  // Caso real: Proceso dice T400, tratamiento sin código, estación T300. Manda la ESTACIÓN.
  const rows = [['T999 tratamiento con codigo enganoso', 'at T300-CE03-002 Célula', 'fecha']];
  assert.deepStrictEqual(Core.linesFromScheduledRows(rows), ['T300']);
});

test('linesFromScheduledRows: dedup preservando orden de aparición', () => {
  const rows = [
    ['t', 'at T205-LI a', 'f'],
    ['t', 'at T204-LI b', 'f'],
    ['t', 'at T205-LI c', 'f']
  ];
  assert.deepStrictEqual(Core.linesFromScheduledRows(rows), ['T205', 'T204']);
});

test('linesFromScheduledRows: sin filas / no-array → []', () => {
  assert.deepStrictEqual(Core.linesFromScheduledRows([]), []);
  assert.deepStrictEqual(Core.linesFromScheduledRows(null), []);
  assert.deepStrictEqual(Core.linesFromScheduledRows('nope'), []);
});

test('linesFromScheduledRows: fila corta (sin td[1]) se ignora sin truenar', () => {
  assert.deepStrictEqual(Core.linesFromScheduledRows([['solo tratamiento']]), []);
});
```

- [ ] **Step 3: Correr los tests para verificar que fallan**

Run: `node --test tools/test/surtido-guard-filter-core.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'lineCodeFromStationText')` (el módulo aún no existe).

- [ ] **Step 4: Implementar el núcleo mínimo**

Crear `remote/scripts/surtido-guard-filter-core.js`:

```js
// Filtro por LÍNEA DESTINO del Candado de Surtido — módulo puro (sin DOM ni red).
// La "línea destino" es la línea de la estación donde la orden está PROGRAMADA, que en
// la tarjeta del Workboard vive en la tabla "Tareas Programadas:", celda td[1].
//
// POR QUÉ td[1] Y NO EL TEXTO DE LA TARJETA (medido en vivo 2026-07-29):
//   La tarjeta también dice "Proceso: T400 (ANT)-CU-VARIOS" mientras su estación destino
//   real es "T300-CE03-002". Sacar el código del textContent daría T400 ⇒ surtir material
//   para la línea EQUIVOCADA. El anclaje por posición de celda es obligatorio.
// Y NO td[0]: el tratamiento a veces no trae código ("TR-PRM-001 Antitarnish Manual").
(function () {
  'use strict';

  // Código de línea: letra + 3 dígitos (T204, T300…). SIN anclar al inicio, porque la celda
  // empieza con el literal inglés "at " (la UI de SH mezcla idiomas). Es seguro no anclar
  // PORQUE el ámbito es una sola celda que solo contiene el nombre de la estación.
  const LINE_CODE_RE = /\b([A-Za-z]\d{3})\b/;

  function lineCodeFromStationText(text) {
    if (typeof text !== 'string' || text === '') return null;
    const m = text.match(LINE_CODE_RE);
    return m ? m[1].toUpperCase() : null;
  }

  // Filas de la tabla "Tareas Programadas:" → códigos de línea únicos, en orden de aparición.
  // Cada fila es [td0=tratamiento, td1=estación, td2=fecha]. Solo se lee td[1].
  // N filas ⇒ N líneas: una misma orden puede correr en varias líneas.
  function linesFromScheduledRows(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    const seen = Object.create(null);
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const code = lineCodeFromStationText(row[1]);
      if (!code || seen[code]) continue;
      seen[code] = true;
      out.push(code);
    }
    return out;
  }

  const api = { LINE_CODE_RE, lineCodeFromStationText, linesFromScheduledRows };
  if (typeof window !== 'undefined') window.SurtidoGuardFilterCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `node --test tools/test/surtido-guard-filter-core.test.js`
Expected: PASS — 17 tests.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/surtido-guard-filter-core.js tools/test/surtido-guard-filter-core.test.js tools/test/fixtures/surtido-guard-filter-cards.json
git commit -m "feat(surtido-guard): núcleo del filtro por línea destino (lee td[1] de Tareas Programadas)"
```

---

### Task 2: Núcleo — catálogo de líneas desde la API

**Files:**
- Modify: `remote/scripts/surtido-guard-filter-core.js` (agregar funciones al final, antes del `const api`)
- Modify: `tools/test/surtido-guard-filter-core.test.js` (agregar tests al final)
- Create: `tools/test/fixtures/surtido-guard-allstations.json`

**Interfaces:**
- Consumes: `lineCodeFromStationText` (Task 1).
- Produces: `buildStationLineIndex(allStationsData) → {[stationId]: lineCode}` y `buildLineCounts(scheduleData, stationLineIndex) → { byLine: {[code]: number}, lines: string[], scheduledOrders: number, unknownStationIds: number[] }`. `byLine` cuenta **órdenes únicas** (`workOrderId`), no accounts.

- [ ] **Step 1: Crear el fixture de AllStations**

Crear `tools/test/fixtures/surtido-guard-allstations.json`:

```json
{
  "_comment": "Recorte de AllStations (hash 834516258e… ya en config) → stationId → name. Nombres con la forma real observada: líneas '-LI' y células '-CExx-xxx'.",
  "allStations": {
    "nodes": [
      { "id": 12090, "name": "T204-LI Plata y Estaño s/Cobre Colgado (16.1)" },
      { "id": 12091, "name": "T205-LI Estaño s/Aluminio (16.3)" },
      { "id": 12092, "name": "T300-CE03-002 Célula de Antitarnish" },
      { "id": 12093, "name": "Proquipa.N1.A1" },
      { "id": 12094, "name": null }
    ]
  }
}
```

- [ ] **Step 2: Escribir los tests que fallan**

Agregar al final de `tools/test/surtido-guard-filter-core.test.js`:

```js
// ── buildStationLineIndex ─────────────────────────────────────────────────
const STATIONS = fx('surtido-guard-allstations.json');

test('buildStationLineIndex: mapea stationId → código de línea', () => {
  const idx = Core.buildStationLineIndex(STATIONS);
  assert.strictEqual(idx[12090], 'T204');
  assert.strictEqual(idx[12091], 'T205');
  assert.strictEqual(idx[12092], 'T300');
});

test('buildStationLineIndex: una ubicación de almacén NO es una línea', () => {
  // "Proquipa.N1.A1" es donde la pieza está PARADA (lo que filtra el nativo de SH).
  const idx = Core.buildStationLineIndex(STATIONS);
  assert.strictEqual(idx[12093], undefined);
});

test('buildStationLineIndex: nombre null no truena ni entra al índice', () => {
  const idx = Core.buildStationLineIndex(STATIONS);
  assert.strictEqual(idx[12094], undefined);
});

test('buildStationLineIndex: acepta el response con o sin envoltura .data', () => {
  const idx = Core.buildStationLineIndex({ data: STATIONS });
  assert.strictEqual(idx[12090], 'T204');
});

test('buildStationLineIndex: shape inesperado → objeto vacío (fail-safe)', () => {
  assert.deepStrictEqual(Core.buildStationLineIndex(null), {});
  assert.deepStrictEqual(Core.buildStationLineIndex({}), {});
  assert.deepStrictEqual(Core.buildStationLineIndex({ allStations: {} }), {});
});

// ── buildLineCounts ──────────────────────────────────────────────────────
const SCHED = fx('surtido-guard-schedule.json');

test('buildLineCounts: cuenta ÓRDENES por línea desde GetRelatedScheduleData', () => {
  // El fixture tiene 1 tarea en stationId 12090 (T204) con 1 account de la WO 5001.
  const idx = Core.buildStationLineIndex(STATIONS);
  const r = Core.buildLineCounts(SCHED, idx);
  assert.deepStrictEqual(r.byLine, { T204: 1 });
  assert.deepStrictEqual(r.lines, ['T204']);
  assert.strictEqual(r.scheduledOrders, 1);
});

test('buildLineCounts: la misma orden en 2 tareas de la MISMA línea cuenta 1 vez', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 900 }] } } ] } },
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 2, workOrderId: 900 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.byLine, { T204: 1 });
});

test('buildLineCounts: la misma orden en DOS líneas cuenta en las dos', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 900 }] } } ] } },
      { stationId: 12091, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 2, workOrderId: 900 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.byLine, { T204: 1, T205: 1 });
  assert.strictEqual(r.scheduledOrders, 1);
});

test('buildLineCounts: estación desconocida se REPORTA, no se traga en silencio', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 99999, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 900 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.byLine, {});
  assert.deepStrictEqual(r.unknownStationIds, [99999]);
});

test('buildLineCounts: lines viene ORDENADO alfabéticamente (dropdown estable)', () => {
  const data = {
    allSchedules: { nodes: [{ validScheduleTasks: { nodes: [
      { stationId: 12092, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 1, workOrderId: 1 }] } } ] } },
      { stationId: 12090, scheduleTaskElementsByScheduleTaskId: { nodes: [
        { associatedPartsTransferAccounts: { nodes: [{ id: 2, workOrderId: 2 }] } } ] } }
    ] } }] }
  };
  const r = Core.buildLineCounts(data, Core.buildStationLineIndex(STATIONS));
  assert.deepStrictEqual(r.lines, ['T204', 'T300']);
});

test('buildLineCounts: sin índice de estaciones → sin líneas, pero no truena', () => {
  const r = Core.buildLineCounts(SCHED, {});
  assert.deepStrictEqual(r.byLine, {});
  assert.deepStrictEqual(r.lines, []);
});

test('buildLineCounts: shape inesperado → estructura vacía completa (fail-safe)', () => {
  const r = Core.buildLineCounts(null, null);
  assert.deepStrictEqual(r, { byLine: {}, lines: [], scheduledOrders: 0, unknownStationIds: [] });
});
```

- [ ] **Step 3: Correr los tests para verificar que fallan**

Run: `node --test tools/test/surtido-guard-filter-core.test.js`
Expected: FAIL — `Core.buildStationLineIndex is not a function`.

- [ ] **Step 4: Implementar**

En `remote/scripts/surtido-guard-filter-core.js`, agregar antes de `const api = {`:

```js
  function asNodes(x) {
    if (x && Array.isArray(x.nodes)) return x.nodes;
    return Array.isArray(x) ? x : [];
  }

  // AllStations → { stationId: lineCode }. Las estaciones sin código de línea (p.ej. la
  // ubicación de almacén "Proquipa.N1.A1") quedan FUERA del índice a propósito.
  function buildStationLineIndex(input) {
    const root = (input && input.data) ? input.data : input;
    const map = Object.create(null);
    for (const s of asNodes(root && root.allStations)) {
      if (!s || s.id == null) continue;
      const code = lineCodeFromStationText(s.name);
      if (code) map[s.id] = code;
    }
    return map;
  }

  // GetRelatedScheduleData + índice → conteo de ÓRDENES por línea.
  // Se cuentan workOrderId ÚNICOS por línea (no accounts): el operador razona en órdenes,
  // y una orden puede tener varias cuentas/tareas en la misma línea.
  // Una orden programada en DOS líneas cuenta en ambas (es material que va a las dos).
  function buildLineCounts(scheduleData, stationLineIndex) {
    const idx = stationLineIndex || {};
    const byLineSets = Object.create(null);
    const allOrders = Object.create(null);
    const unknown = [];
    const unknownSeen = Object.create(null);
    for (const s of asNodes(scheduleData && scheduleData.allSchedules)) {
      for (const t of asNodes(s && s.validScheduleTasks)) {
        if (!t) continue;
        const code = idx[t.stationId];
        for (const el of asNodes(t.scheduleTaskElementsByScheduleTaskId)) {
          for (const a of asNodes(el && el.associatedPartsTransferAccounts)) {
            if (!a || a.workOrderId == null) continue;
            allOrders[a.workOrderId] = true;
            if (!code) {
              if (t.stationId != null && !unknownSeen[t.stationId]) {
                unknownSeen[t.stationId] = true;
                unknown.push(t.stationId);
              }
              continue;
            }
            if (!byLineSets[code]) byLineSets[code] = Object.create(null);
            byLineSets[code][a.workOrderId] = true;
          }
        }
      }
    }
    const byLine = Object.create(null);
    for (const code of Object.keys(byLineSets)) byLine[code] = Object.keys(byLineSets[code]).length;
    return {
      byLine: byLine,
      lines: Object.keys(byLine).sort(),
      scheduledOrders: Object.keys(allOrders).length,
      unknownStationIds: unknown
    };
  }
```

Y extender el export:

```js
  const api = {
    LINE_CODE_RE, lineCodeFromStationText, linesFromScheduledRows,
    buildStationLineIndex, buildLineCounts
  };
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `node --test tools/test/surtido-guard-filter-core.test.js`
Expected: PASS — 28 tests.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/surtido-guard-filter-core.js tools/test/surtido-guard-filter-core.test.js tools/test/fixtures/surtido-guard-allstations.json
git commit -m "feat(surtido-guard): catálogo de líneas del board desde AllStations + GetRelatedScheduleData"
```

---

### Task 3: Núcleo — decisión de visibilidad, resumen y guardas

**Files:**
- Modify: `remote/scripts/surtido-guard-filter-core.js`
- Modify: `tools/test/surtido-guard-filter-core.test.js`

**Interfaces:**
- Consumes: nada de tasks previos (funciones independientes).
- Produces:
  - `cardVisibleUnderFilter(cardLines, selectedLine) → boolean`
  - `planFilter({ cards, selectedLine, apiScheduledOrders, mountedCount, maxMounted }) → { active, effect, visible, hidden, hiddenUnscheduled, hiddenOtherLine, reason }` donde `effect` ∈ `'none'|'hide'|'dim'`, `cards` es `[{ lines: string[] }]`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tools/test/surtido-guard-filter-core.test.js`:

```js
// ── cardVisibleUnderFilter ───────────────────────────────────────────────
test('cardVisibleUnderFilter: sin filtro, TODO se ve (incluidas las no programadas)', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter([], null), true);
  assert.strictEqual(Core.cardVisibleUnderFilter([], ''), true);
  assert.strictEqual(Core.cardVisibleUnderFilter(['T204'], null), true);
});

test('cardVisibleUnderFilter: con filtro, coincide si la línea está en el set', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter(['T204'], 'T204'), true);
  assert.strictEqual(Core.cardVisibleUnderFilter(['T205', 'T204'], 'T204'), true);
  assert.strictEqual(Core.cardVisibleUnderFilter(['T205'], 'T204'), false);
});

test('cardVisibleUnderFilter: no programada (sin líneas) se ESCONDE con filtro activo', () => {
  // Decisión del operador 2026-07-29: se esconden como el resto.
  assert.strictEqual(Core.cardVisibleUnderFilter([], 'T204'), false);
});

test('cardVisibleUnderFilter: compara en mayúsculas', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter(['T204'], 't204'), true);
});

test('cardVisibleUnderFilter: entradas basura no truenan', () => {
  assert.strictEqual(Core.cardVisibleUnderFilter(null, 'T204'), false);
  assert.strictEqual(Core.cardVisibleUnderFilter('T204', 'T204'), false);
});

// ── planFilter ───────────────────────────────────────────────────────────
const CARDS3 = [
  { lines: ['T204'] },
  { lines: ['T205'] },
  { lines: [] },
  { lines: [] }
];

test('planFilter: sin línea elegida → inactivo, efecto none, nada oculto', () => {
  const p = Core.planFilter({ cards: CARDS3, selectedLine: null, apiScheduledOrders: 2, mountedCount: 4 });
  assert.strictEqual(p.active, false);
  assert.strictEqual(p.effect, 'none');
  assert.strictEqual(p.visible, 4);
  assert.strictEqual(p.hidden, 0);
});

test('planFilter: con línea → esconde y desglosa el motivo de cada oculta', () => {
  const p = Core.planFilter({ cards: CARDS3, selectedLine: 'T204', apiScheduledOrders: 2, mountedCount: 4 });
  assert.strictEqual(p.active, true);
  assert.strictEqual(p.effect, 'hide');
  assert.strictEqual(p.visible, 1);
  assert.strictEqual(p.hidden, 3);
  assert.strictEqual(p.hiddenUnscheduled, 2);
  assert.strictEqual(p.hiddenOtherLine, 1);
});

test('planFilter: GUARDA 1 — pasa el tope de montados → cae a DIM, no a esconder', () => {
  const p = Core.planFilter({
    cards: CARDS3, selectedLine: 'T204', apiScheduledOrders: 2,
    mountedCount: 250, maxMounted: 200
  });
  assert.strictEqual(p.effect, 'dim');
  assert.strictEqual(p.reason, 'too-many-mounted');
});

test('planFilter: GUARDA 2 — señal DOM rota (API dice programadas, ninguna tarjeta revela línea) → no filtra', () => {
  const ciegas = [{ lines: [] }, { lines: [] }];
  const p = Core.planFilter({ cards: ciegas, selectedLine: 'T204', apiScheduledOrders: 7, mountedCount: 2 });
  assert.strictEqual(p.active, false);
  assert.strictEqual(p.effect, 'none');
  assert.strictEqual(p.reason, 'dom-signal-broken');
  assert.strictEqual(p.visible, 2);
});

test('planFilter: sin programadas en la API, cero líneas es NORMAL → sí filtra', () => {
  // No es señal rota: de verdad no hay nada programado. Esconder es correcto y explicable.
  const ciegas = [{ lines: [] }, { lines: [] }];
  const p = Core.planFilter({ cards: ciegas, selectedLine: 'T204', apiScheduledOrders: 0, mountedCount: 2 });
  assert.strictEqual(p.active, true);
  assert.strictEqual(p.effect, 'hide');
  assert.strictEqual(p.visible, 0);
  assert.strictEqual(p.hiddenUnscheduled, 2);
});

test('planFilter: maxMounted default 200', () => {
  const p = Core.planFilter({ cards: CARDS3, selectedLine: 'T204', apiScheduledOrders: 2, mountedCount: 201 });
  assert.strictEqual(p.effect, 'dim');
});

test('planFilter: entrada vacía no truena', () => {
  const p = Core.planFilter({});
  assert.strictEqual(p.active, false);
  assert.strictEqual(p.effect, 'none');
  assert.strictEqual(p.visible, 0);
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `node --test tools/test/surtido-guard-filter-core.test.js`
Expected: FAIL — `Core.cardVisibleUnderFilter is not a function`.

- [ ] **Step 3: Implementar**

En `remote/scripts/surtido-guard-filter-core.js`, antes de `const api = {`:

```js
  const MAX_MOUNTED_DEFAULT = 200;

  // ¿Esta tarjeta se ve con el filtro puesto?
  // Sin línea elegida: todo se ve. Con línea: solo si esa línea está entre sus destinos.
  // Una tarjeta SIN destinos (no programada) se esconde — decisión del operador.
  function cardVisibleUnderFilter(cardLines, selectedLine) {
    const sel = (typeof selectedLine === 'string' && selectedLine !== '') ? selectedLine.toUpperCase() : null;
    if (!sel) return true;
    if (!Array.isArray(cardLines)) return false;
    for (const c of cardLines) {
      if (typeof c === 'string' && c.toUpperCase() === sel) return true;
    }
    return false;
  }

  // Plan completo del filtro para el render. Decide EFECTO y arma el desglose del box.
  //   cards = [{ lines:string[] }] (una por tarjeta MONTADA)
  //   apiScheduledOrders = órdenes programadas según GetRelatedScheduleData (árbitro)
  // Guardas (ambas fail-safe: ante duda NO se esconde):
  //   1. too-many-mounted: virtuoso montó demasiado con el filtro puesto → atenuar.
  //   2. dom-signal-broken: la API reporta programadas pero NINGUNA tarjeta revela línea
  //      ⇒ el anclaje se rompió (layout/locale) → no filtrar, en vez de esconder todo.
  function planFilter(opts) {
    const o = opts || {};
    const cards = Array.isArray(o.cards) ? o.cards : [];
    const sel = (typeof o.selectedLine === 'string' && o.selectedLine !== '') ? o.selectedLine.toUpperCase() : null;
    const maxMounted = (typeof o.maxMounted === 'number') ? o.maxMounted : MAX_MOUNTED_DEFAULT;
    const mounted = (typeof o.mountedCount === 'number') ? o.mountedCount : cards.length;
    const apiScheduled = (typeof o.apiScheduledOrders === 'number') ? o.apiScheduledOrders : 0;

    const inactive = function (reason) {
      return {
        active: false, effect: 'none', visible: cards.length, hidden: 0,
        hiddenUnscheduled: 0, hiddenOtherLine: 0, reason: reason
      };
    };
    if (!sel) return inactive('no-selection');

    const anyCardWithLine = cards.some(function (c) {
      return c && Array.isArray(c.lines) && c.lines.length > 0;
    });
    if (!anyCardWithLine && apiScheduled > 0) return inactive('dom-signal-broken');

    let visible = 0, hiddenUnscheduled = 0, hiddenOtherLine = 0;
    cards.forEach(function (c) {
      const lines = (c && Array.isArray(c.lines)) ? c.lines : [];
      if (cardVisibleUnderFilter(lines, sel)) visible++;
      else if (lines.length === 0) hiddenUnscheduled++;
      else hiddenOtherLine++;
    });

    return {
      active: true,
      effect: (mounted > maxMounted) ? 'dim' : 'hide',
      visible: visible,
      hidden: hiddenUnscheduled + hiddenOtherLine,
      hiddenUnscheduled: hiddenUnscheduled,
      hiddenOtherLine: hiddenOtherLine,
      reason: (mounted > maxMounted) ? 'too-many-mounted' : 'ok'
    };
  }
```

Y extender el export:

```js
  const api = {
    LINE_CODE_RE, MAX_MOUNTED_DEFAULT,
    lineCodeFromStationText, linesFromScheduledRows,
    buildStationLineIndex, buildLineCounts,
    cardVisibleUnderFilter, planFilter
  };
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `node --test tools/test/surtido-guard-filter-core.test.js`
Expected: PASS — 40 tests.

- [ ] **Step 5: Correr la suite completa (nada más se rompió)**

Run: `tools/run-tests.sh`
Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/surtido-guard-filter-core.js tools/test/surtido-guard-filter-core.test.js
git commit -m "feat(surtido-guard): decisión de visibilidad del filtro + guardas (tope de montados, señal DOM rota)"
```

---

### Task 3b: Test de AISLAMIENTO — el filtro no puede tocar el candado

**Files:**
- Create: `tools/test/surtido-guard-filter-isolation.test.js`

**Interfaces:**
- Consumes: `surtido-guard-filter-core.js` (Tasks 1-3) y `surtido-guard-core.js` (existente).
- Produces: nada de runtime; fija el invariante de seguridad del spec §3.

**Por qué existe:** el spec exige que esconder sea *puramente visual*. Este test pone en rojo cualquier
intento futuro de meter lógica del candado dentro del filtro (o al revés), que es el riesgo real de
haber puesto comodidad y seguridad en el mismo applet.

- [ ] **Step 1: Escribir el test que debe pasar de una (es un candado, no un TDD de feature)**

Crear `tools/test/surtido-guard-filter-isolation.test.js`:

```js
// INVARIANTE DE SEGURIDAD: el filtro por línea destino es PURAMENTE VISUAL.
// Esconder una tarjeta no puede relajar el candado, que bloquea sobre el PAYLOAD de la
// mutación. Este test fija el aislamiento entre los dos módulos.
// Run: node --test tools/test/surtido-guard-filter-isolation.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const filterSrc = fs.readFileSync(path.join(ROOT, 'remote', 'scripts', 'surtido-guard-filter-core.js'), 'utf8');

global.window = {};
require(path.join(ROOT, 'remote', 'scripts', 'surtido-guard-core.js'));
require(path.join(ROOT, 'remote', 'scripts', 'surtido-guard-filter-core.js'));
const Guard = global.window.SurtidoGuardCore;
const Filter = global.window.SurtidoGuardFilterCore;

test('el core del filtro NO menciona el estado del candado', () => {
  assert.ok(!/__saSurtidoGuardEnabled/.test(filterSrc), 'el filtro no debe leer el flag del candado');
  assert.ok(!/enforcementEnabled/.test(filterSrc), 'el filtro no debe conocer enforcementEnabled');
});

test('el core del filtro NO toca la red ni la mutación de mover', () => {
  assert.ok(!/\bfetch\b/.test(filterSrc), 'el filtro es puro: sin fetch');
  assert.ok(!/CreateManyPartsTransfersChecked/.test(filterSrc), 'el filtro no conoce la mutación');
  assert.ok(!/evaluateMove/.test(filterSrc), 'el filtro no decide bloqueos');
});

test('los dos módulos son objetos distintos y no comparten API', () => {
  assert.notStrictEqual(Guard, Filter);
  const shared = Object.keys(Filter).filter((k) => Object.prototype.hasOwnProperty.call(Guard, k));
  assert.deepStrictEqual(shared, [], 'no debe haber nombres compartidos: ' + shared.join(','));
});

test('el veredicto del candado NO depende del filtro (mismo input → mismo bloqueo)', () => {
  const vars = {
    partsTransferEventsPayload: {
      partsTransferEvents: [{ partsTransfers: [{ fromAccountId: 1002, type: 'STEP' }] }]
    }
  };
  const ctx = {
    scheduledAccountIds: new Set([1001]),
    accountNode: { 1002: { recipeNodeId: 7001, workOrderId: 5002 } },
    surtidoNodeIds: new Set([7001])
  };
  const antes = Guard.evaluateMove(vars, ctx, { enforcementEnabled: true });
  // Se "aplica" un filtro que escondería esa misma tarjeta…
  assert.strictEqual(Filter.cardVisibleUnderFilter([], 'T204'), false);
  // …y el veredicto del candado es idéntico: la orden no programada sigue bloqueada.
  const despues = Guard.evaluateMove(vars, ctx, { enforcementEnabled: true });
  assert.strictEqual(antes.block, true);
  assert.deepStrictEqual(antes, despues);
});
```

- [ ] **Step 2: Correr el test**

Run: `node --test tools/test/surtido-guard-filter-isolation.test.js`
Expected: PASS — 4 tests. **Si falla el de "no menciona el estado del candado", el core del filtro
tiene acoplamiento que hay que quitar** (no relajar el test).

- [ ] **Step 3: Commit**

```bash
git add tools/test/surtido-guard-filter-isolation.test.js
git commit -m "test(surtido-guard): fija el aislamiento entre el filtro y el candado"
```

---

### Task 4: Glue — leer el destino de cada tarjeta y esconderlas

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: `window.SurtidoGuardFilterCore` (Tasks 1-3).
- Produces (dentro del IIFE, expuesto en el objeto de retorno para depurar): `readMountedCards() → [{ item, lines }]`, `applyFilter()`, y estado `window.__saSurtidoGuardLine` (línea elegida, `null` = todas).

**Contexto medido (spec §1.1/§5), no re-descubrir:**
- Punto de entrada por tarjeta: `[data-steelhead-component-id="WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK"]`.
- Nodo a esconder: `closest('[data-item-index]')` (item de react-virtuoso). **Existe** — verificado.
- Tabla del destino: `table.MuiTable-root` dentro de ese item; filas `tr`, celdas `td`.
- Hay **varios** `[data-testid="virtuoso-item-list"]`; los `data-item-index` **se repiten** entre ellos ⇒ operar por nodo, nunca por índice.

- [ ] **Step 1: Agregar el estado singleton y el lector de tarjetas**

En `remote/scripts/surtido-guard.js`, después del bloque de `setEnforcementEnabled` (línea ~29), agregar:

```js
  // ── Filtro por LÍNEA DESTINO (v0.3.0) ──
  // Estado en `window` por la MISMA razón que el flag del candado: injectAppScripts
  // re-evalúa este IIFE en cada acción del popup y el closure quedaría desincronizado.
  // `null` = sin filtro (se ven todas). NO persiste entre recargas, por diseño: un filtro
  // pegado que esconde trabajo hace creer que no hay pendientes.
  if (window.__saSurtidoGuardLine === undefined) window.__saSurtidoGuardLine = null;
  function getSelectedLine() { return window.__saSurtidoGuardLine || null; }
  function setSelectedLine(v) { window.__saSurtidoGuardLine = v || null; }

  const FilterCore = () => window.SurtidoGuardFilterCore;
  const CARD_LINK_SEL = '[data-steelhead-component-id="WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK"]';

  let stationLineIndex = {};   // stationId → 'T204' (de AllStations)
  let lineCounts = null;       // { byLine, lines, scheduledOrders, unknownStationIds }

  // Tarjetas MONTADAS con su set de líneas destino. El nodo que se esconde es el item de
  // react-virtuoso ([data-item-index]); ocultarlo hace que virtuoso re-mida y encoja el
  // scroll sin dejar huecos (medido 2026-07-29: scrollHeight 1034→524, rects contiguos).
  function readMountedCards() {
    const core = FilterCore();
    if (!core) return [];
    const out = [];
    document.querySelectorAll(CARD_LINK_SEL).forEach((link) => {
      const item = link.closest('[data-item-index]');
      if (!item) return;
      const table = item.querySelector('table.MuiTable-root');
      const rows = table
        ? [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
        : [];
      out.push({ item: item, lines: core.linesFromScheduledRows(rows) });
    });
    return out;
  }
```

- [ ] **Step 2: Agregar el aplicador del filtro (idempotente)**

Justo después de `readMountedCards`, agregar:

```js
  // Aplica el plan al DOM. IDEMPOTENTE: el observer corre con subtree:true, así que una
  // escritura que no verifique su estado previo se re-dispara en bucle.
  // NO desmonta nodos (display:none) → decorateCards sigue viendo todas las tarjetas y su
  // árbitro del naranja (anyScheduled) no se altera.
  function applyFilter() {
    const core = FilterCore();
    if (!core) return null;
    const cards = readMountedCards();
    const plan = core.planFilter({
      cards: cards,
      selectedLine: getSelectedLine(),
      apiScheduledOrders: lineCounts ? lineCounts.scheduledOrders : 0,
      mountedCount: document.querySelectorAll('[data-item-index]').length
    });
    const sel = getSelectedLine();
    cards.forEach(({ item, lines }) => {
      const show = !plan.active || core.cardVisibleUnderFilter(lines, sel);
      const wantHide = !show && plan.effect === 'hide';
      const wantDim = !show && plan.effect === 'dim';
      // Solo se toca lo que ESTE applet marcó (data-sa-sg-filtered), para no pelear con
      // ningún display/opacity que venga de SH o de React.
      const marked = item.dataset.saSgFiltered === '1';
      if (wantHide) {
        if (!marked || item.style.display !== 'none') {
          item.dataset.saSgFiltered = '1';
          item.style.display = 'none';
          item.style.opacity = '';
        }
      } else if (wantDim) {
        if (!marked || item.style.opacity !== '0.25') {
          item.dataset.saSgFiltered = '1';
          item.style.display = '';
          item.style.opacity = '0.25';
          item.style.filter = 'grayscale(1)';
        }
      } else if (marked) {
        delete item.dataset.saSgFiltered;
        item.style.display = '';
        item.style.opacity = '';
        item.style.filter = '';
      }
    });
    return plan;
  }
```

- [ ] **Step 3: Enganchar al ciclo de decorado y al teardown**

En `scheduleDecorate` (línea ~240), cambiar el cuerpo del callback para que corra también el filtro, **sin que un error del filtro tumbe el naranja ni el candado**:

```js
  function scheduleDecorate() {
    if (decoTimer) return;
    const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    decoTimer = raf(() => {
      decoTimer = null;
      try { decorateCards(); } catch (_) {}
      // El filtro va en su PROPIO try/catch: es comodidad, no puede afectar al candado.
      try { applyFilter(); renderFilterBox(); } catch (_) {}
    });
  }
```

En `teardownOnLeave` (línea ~301), agregar antes del `const t = document.getElementById('sa-sg-toast')`:

```js
    // Suelta el estado del filtro al salir del board (memory hardening) y limpia el DOM.
    setSelectedLine(null);
    stationLineIndex = {};
    lineCounts = null;
    document.querySelectorAll('[data-sa-sg-filtered]').forEach((el) => {
      delete el.dataset.saSgFiltered;
      el.style.display = ''; el.style.opacity = ''; el.style.filter = '';
    });
    const box = document.getElementById('sa-sg-filter'); if (box) box.remove();
```

- [ ] **Step 4: Exponer en `_getState` para poder depurar en vivo**

En el objeto de retorno (línea ~324), reemplazar `_getState` por:

```js
    _getState: () => ({
      enforcementEnabled: isEnforcementEnabled(),
      scheduled: [...scheduledAccountIds],
      surtido: [...surtidoNodeIds],
      accounts: Object.keys(accountNode).length,
      line: getSelectedLine(),
      lineCounts: lineCounts,
      mountedCards: (() => { try { return readMountedCards().map((c) => c.lines); } catch (_) { return null; } })()
    }),
```

- [ ] **Step 5: Verificar que la suite sigue verde**

Run: `tools/run-tests.sh`
Expected: todos verdes (este task no agrega tests: el glue DOM se valida en vivo, según la convención del repo — no hay jsdom).

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/surtido-guard.js
git commit -m "feat(surtido-guard): glue del filtro — lee td[1] por tarjeta y esconde el item de virtuoso"
```

---

### Task 5: Glue — el box del filtro en el header

**Files:**
- Modify: `remote/scripts/surtido-guard.js`

**Interfaces:**
- Consumes: `applyFilter`, `getSelectedLine`, `setSelectedLine`, `lineCounts` (Task 4).
- Produces: `renderFilterBox()` (idempotente; ya referenciada en `scheduleDecorate` del Task 4).

**Contexto medido (spec §4):** la barra del header es el `div[display:flex]` que contiene el título del board y los botones `ESCANEAR ETIQUETA DE TRABAJO` / `GESTIONAR INVENTARIO` / `CONFIGURACIÓN DE ETIQUETAS` / `NUEVA TARJETA`. Tiene `overflow: visible` ⇒ se inyecta en flujo, **sin** `position:fixed`.

- [ ] **Step 1: Agregar los estilos del box**

En `injectStyles()` (línea ~52), agregar al array `css` antes del `].join('')`:

```js
      // Box del filtro por línea destino. DARK MODE: debe distinguirse a simple vista del
      // filtro NATIVO de estación de SH, que responde otra pregunta (dónde está PARADA la
      // pieza, no a dónde va). Confundirlos surte material a la línea equivocada.
      '.sa-sg-filter{display:flex;align-items:center;gap:8px;background:#1c2430;color:#e6e9ee;',
      'border:1px solid #2b3645;border-radius:10px;padding:8px 12px;margin:0 10px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;}',
      '.sa-sg-filter label{font-weight:600;white-space:nowrap;}',
      '.sa-sg-filter select{background:#141a23;color:#e6e9ee;border:1px solid #2b3645;',
      'border-radius:6px;padding:5px 8px;font-size:13px;font-family:inherit;}',
      '.sa-sg-filter .sa-sg-count{color:#9aa7b8;white-space:nowrap;}',
      '.sa-sg-filter .sa-sg-warn{color:#f0b429;}',
      '.sa-sg-filter button{background:transparent;color:#9aa7b8;border:1px solid #2b3645;',
      'border-radius:6px;padding:4px 8px;cursor:pointer;font-family:inherit;font-size:12px;}',
      '.sa-sg-filter button:hover{color:#e6e9ee;border-color:#13a36f;}',
```

- [ ] **Step 2: Agregar el localizador del header y el render del box**

Antes de `scheduleDecorate` (línea ~240), agregar:

```js
  // Barra de acciones del header del board. Sin data-steelhead-component-id en esa zona, el
  // mejor anclaje es subir desde uno de sus botones (texto ES+EN) hasta el contenedor flex.
  // Ese contenedor tiene overflow:visible (medido) → no hace falta position:fixed.
  const HEADER_BTN_RE = /NUEVA TARJETA|NEW CARD|ESCANEAR ETIQUETA|SCAN JOB TAG/i;
  function findHeaderBar() {
    const btns = [...document.querySelectorAll('button')];
    for (const b of btns) {
      if (!HEADER_BTN_RE.test(b.textContent || '')) continue;
      let n = b.parentElement;
      for (let i = 0; i < 4 && n; i++) {
        if (getComputedStyle(n).display === 'flex' && n.children.length >= 3) return n;
        n = n.parentElement;
      }
    }
    return null;
  }

  // Pinta/actualiza el box. IDEMPOTENTE: reusa el nodo si ya existe y solo reescribe lo que
  // cambió (el observer con subtree:true re-dispararía en bucle si recreara el box).
  function renderFilterBox() {
    if (!isWorkboardPage()) return;
    const core = FilterCore();
    if (!core) return;
    const bar = findHeaderBar();
    if (!bar) return;

    let box = document.getElementById('sa-sg-filter');
    if (!box) {
      injectStyles();
      box = document.createElement('div');
      box.id = 'sa-sg-filter';
      box.className = 'sa-sg-filter';
      const label = document.createElement('label');
      label.textContent = '🔒 → Línea destino:';   // la flecha distingue del filtro NATIVO
      const sel = document.createElement('select');
      sel.id = 'sa-sg-filter-sel';
      sel.addEventListener('change', () => {
        setSelectedLine(sel.value || null);
        try { applyFilter(); renderFilterBox(); } catch (_) {}
      });
      const count = document.createElement('span');
      count.id = 'sa-sg-filter-count';
      count.className = 'sa-sg-count';
      const clear = document.createElement('button');
      clear.id = 'sa-sg-filter-clear';
      clear.textContent = '✕';
      clear.title = 'Quitar el filtro de línea destino';
      clear.addEventListener('click', () => {
        setSelectedLine(null);
        const s = document.getElementById('sa-sg-filter-sel'); if (s) s.value = '';
        try { applyFilter(); renderFilterBox(); } catch (_) {}
      });
      box.append(label, sel, count, clear);
      bar.appendChild(box);
    } else if (box.parentElement !== bar) {
      bar.appendChild(box);            // React repintó el header → recolocar, no recrear
    }

    // Opciones: "Todas" + una por línea del board, con su conteo de órdenes (API).
    const sel = box.querySelector('#sa-sg-filter-sel');
    const lines = (lineCounts && lineCounts.lines) || [];
    const wanted = ['', ...lines].join('|');
    if (sel.dataset.saOpts !== wanted) {
      sel.dataset.saOpts = wanted;
      sel.textContent = '';
      const all = document.createElement('option');
      all.value = ''; all.textContent = 'Todas';
      sel.appendChild(all);
      lines.forEach((code) => {
        const o = document.createElement('option');
        o.value = code;
        o.textContent = code + ' (' + lineCounts.byLine[code] + ')';
        sel.appendChild(o);
      });
    }
    const cur = getSelectedLine() || '';
    if (sel.value !== cur) sel.value = cur;

    // Contador: SIEMPRE a la vista con filtro activo, y el desglose de por qué falta gente.
    // Sin esto, un board recortado se lee como "no hay trabajo" (lección batch-name-filter).
    const plan = core.planFilter({
      cards: readMountedCards(),
      selectedLine: getSelectedLine(),
      apiScheduledOrders: lineCounts ? lineCounts.scheduledOrders : 0,
      mountedCount: document.querySelectorAll('[data-item-index]').length
    });
    const count = box.querySelector('#sa-sg-filter-count');
    let txt = '', warn = false;
    if (!plan.active && plan.reason === 'dom-signal-broken') {
      txt = '⚠️ no pude leer la línea de las tarjetas — filtro apagado';
      warn = true;
    } else if (!plan.active) {
      txt = lines.length ? (lines.length + ' líneas en el board') : 'sin órdenes programadas';
    } else {
      const partes = [plan.visible + ' visible' + (plan.visible === 1 ? '' : 's')];
      if (plan.hiddenUnscheduled) partes.push(plan.hiddenUnscheduled + ' sin programar ocultas');
      if (plan.hiddenOtherLine) partes.push(plan.hiddenOtherLine + ' de otras líneas');
      if (plan.effect === 'dim') { partes.push('(atenuadas: demasiadas tarjetas)'); warn = true; }
      txt = partes.join(' · ');
    }
    if (count.textContent !== txt) count.textContent = txt;
    count.className = 'sa-sg-count' + (warn ? ' sa-sg-warn' : '');
  }
```

- [ ] **Step 3: Traer el catálogo de líneas — interceptar `AllStations` y pedirlo si no llega**

En `patchFetch()`, dentro del bloque de lectura de respuestas (después del bloque de `BOARD_RECIPENODES_OP`, línea ~133), agregar:

```js
      // Catálogo de estaciones → índice stationId→línea. Si el front ya lo pide, sale gratis.
      if (op === 'AllStations') {
        try { resp.clone().json().then((j) => {
          const core = FilterCore(); if (!core || !j) return;
          stationLineIndex = core.buildStationLineIndex(j);
          recomputeLineCounts();
          scheduleDecorate();
        }).catch(() => {}); } catch (_) {}
      }
```

Y en el bloque existente de `BOARD_SCHEDULE_OP`, después de `scheduleDecorate(); scheduleModalGuard();`, agregar `lastScheduleData = j.data; recomputeLineCounts();`. Declarar arriba (junto a `lineCounts`):

```js
  let lastScheduleData = null;  // último GetRelatedScheduleData.data (para recontar líneas)
```

Y agregar la función, antes de `renderFilterBox`:

```js
  // Recalcula los conteos por línea cuando cambia cualquiera de sus dos insumos.
  function recomputeLineCounts() {
    const core = FilterCore();
    if (!core || !lastScheduleData) return;
    lineCounts = core.buildLineCounts(lastScheduleData, stationLineIndex);
    if (lineCounts.unknownStationIds.length) {
      console.warn('[SA] SurtidoGuard: estaciones sin código de línea', lineCounts.unknownStationIds);
    }
  }

  // Si el front NO pidió AllStations, lo pedimos UNA vez (catálogo, ~775 estaciones).
  // Una sola llamada por carga de board: el /graphql de la sesión se cuelga con ráfagas.
  function ensureStationCatalog() {
    if (window.__saSurtidoGuardStationsAsked) return;
    window.__saSurtidoGuardStationsAsked = true;
    try {
      const api = window.SteelheadAPI;
      if (!api || typeof api.query !== 'function') return;
      api.query('AllStations', {}).then((j) => {
        const core = FilterCore(); if (!core || !j) return;
        stationLineIndex = core.buildStationLineIndex(j);
        recomputeLineCounts();
        scheduleDecorate();
      }).catch(() => {});
    } catch (_) {}
  }
```

En `init()`, después de `kickDecorate();`, agregar:

```js
    try { ensureStationCatalog(); } catch (_) {}
```

> **Firma ya verificada (no hace falta re-checar):** `steelhead-api.js:77` declara
> `async function query(operationName, variables = {}, hashKey)` y **devuelve `result.data`**
> (ya desenvuelto, sin la capa `{data:...}`). `buildStationLineIndex` acepta las dos formas
> (con y sin `.data`), así que la llamada del Step 3 es correcta tal cual está escrita.

- [ ] **Step 4: Verificar que la suite sigue verde**

Run: `tools/run-tests.sh`
Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/surtido-guard.js
git commit -m "feat(surtido-guard): box dark-mode del filtro en el header + catálogo de líneas"
```

---

### Task 6: Registrar en `config.json` y en el popup

**Files:**
- Modify: `remote/config.json`
- Create: `tools/test/surtido-guard-filter-config.test.js`

**Interfaces:**
- Consumes: el script de Task 1.
- Produces: `scripts/surtido-guard-filter-core.js` en el array `scripts` del app `surtido-guard`, antes de `scripts/surtido-guard.js`.

> ⚠️ **`remote/config.json` es hot file** (§Trabajo paralelo). Antes de editarlo, verificar que no haya otra sesión con WIP ahí: `git status --short remote/config.json`. Hacerlo en pasada corta (read → edit → commit).

- [ ] **Step 1: Escribir el test de contrato que falla**

Crear `tools/test/surtido-guard-filter-config.test.js`:

```js
// Contrato config ↔ scripts del filtro por línea destino.
// El orden IMPORTA: el core debe cargar antes del glue, o FilterCore() sale undefined.
// Run: node --test tools/test/surtido-guard-filter-config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote', 'config.json'), 'utf8'));
const app = config.apps.find((a) => a.id === 'surtido-guard');

test('el app surtido-guard existe', () => {
  assert.ok(app, 'no se encontró el app surtido-guard en config.apps');
});

test('el core del filtro está declarado en scripts', () => {
  assert.ok(app.scripts.includes('scripts/surtido-guard-filter-core.js'));
});

test('el core del filtro carga ANTES del glue', () => {
  const iCore = app.scripts.indexOf('scripts/surtido-guard-filter-core.js');
  const iGlue = app.scripts.indexOf('scripts/surtido-guard.js');
  assert.ok(iCore >= 0 && iGlue >= 0);
  assert.ok(iCore < iGlue, 'surtido-guard-filter-core.js debe ir antes de surtido-guard.js');
});

test('todo script declarado existe en el repo', () => {
  app.scripts.forEach((rel) => {
    const p = path.join(ROOT, 'remote', rel);
    assert.ok(fs.existsSync(p), 'falta el archivo declarado en config: ' + rel);
  });
});

test('AllStations tiene hash en config (lo usa el catálogo de líneas)', () => {
  assert.ok(config.steelhead.hashes.queries.AllStations, 'falta el hash de AllStations');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tools/test/surtido-guard-filter-config.test.js`
Expected: FAIL en "el core del filtro está declarado en scripts".

- [ ] **Step 3: Editar `remote/config.json`**

En el app `surtido-guard`, cambiar el array `scripts` a:

```json
  "scripts": [
    "scripts/steelhead-api.js",
    "scripts/surtido-guard-core.js",
    "scripts/surtido-guard-filter-core.js",
    "scripts/surtido-guard.js"
  ],
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tools/test/surtido-guard-filter-config.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Correr la suite completa**

Run: `tools/run-tests.sh`
Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add remote/config.json tools/test/surtido-guard-filter-config.test.js
git commit -m "feat(surtido-guard): registra el core del filtro en config (antes del glue)"
```

---

### Task 7: Bitácora + índice de applets

**Files:**
- Modify: `docs/applets/surtido-guard.md`
- Modify: `CLAUDE.md` (fila de `surtido-guard` en el índice de applets)

> ⚠️ **`CLAUDE.md` es hot file.** Verificar con `git status --short CLAUDE.md` y hacerlo en pasada corta.

- [ ] **Step 1: Actualizar la bitácora del applet**

En `docs/applets/surtido-guard.md`, cambiar la línea de versión del encabezado a `0.3.0` y agregar, después de la sección "Arquitectura (5 capas)", una sección nueva:

```markdown
## Capa 6 — Filtro por LÍNEA DESTINO (v0.3.0)

Filtra las tarjetas del step por la **línea a la que va** el material (`T204`, `T300`…), que es
la línea de la estación donde la orden está **programada**. Complementa —no duplica— el filtro
**nativo** de SH, que filtra por la estación donde la pieza está **parada**
(`Estación: Proquipa.N1.A1`). Etiqueta con flecha (`→ Línea destino`) + dark-mode para que no se
confundan: aquí escoger mal surte material a la línea equivocada.

- **Fuente del destino:** celda `td[1]` de la tabla que sigue a `Tareas Programadas:` en la
  tarjeta. **NO** el `textContent` — la tarjeta también dice `Proceso: T400 …` mientras su
  estación destino real es `T300` (medido en vivo: habría filtrado a la línea equivocada en el
  primer caso real del board). **NO** `td[0]` — el tratamiento a veces no trae código
  (`TR-PRM-001 Antitarnish Manual`).
- **Catálogo del dropdown:** `GetRelatedScheduleData` (ya interceptado) + `AllStations` → conteo
  de **órdenes** por línea. Viene de la API para que sea **completo**: el board está virtualizado
  y solo monta ~8 tarjetas.
- **Esconder es seguro con react-virtuoso** (medido 2026-07-29): `display:none` sobre el nodo
  `[data-item-index]` hace que virtuoso re-mida (`scrollHeight` 1034→524) sin huecos ni
  tarjetas encimadas.
- **Dos guardas fail-safe:** si virtuoso pasa de 200 items montados con filtro puesto → atenúa en
  vez de esconder; si la API reporta programadas pero **ninguna** tarjeta revela línea, el filtro
  **se apaga solo** y lo avisa (mismo árbitro que el naranja: esconder trabajo real no se nota).
- **No persiste** entre recargas, igual que el candado.
- **No toca el enforcement:** esconder es puramente visual; el candado bloquea sobre el payload de
  la mutación, así que una tarjeta oculta sigue igual de bloqueada.
- Núcleo puro: `surtido-guard-filter-core.js` (40 golden tests).
```

- [ ] **Step 2: Actualizar la fila del índice en `CLAUDE.md`**

En la tabla "Índice de applets", en la fila de `surtido-guard`, cambiar `0.2.0` por `0.3.0` y agregar al inicio de la celda de descripción:

```
0.3.0 (**v0.3.0 2026-07-29: FILTRO POR LÍNEA DESTINO** — filtra las tarjetas del step por la línea a la que VA el material, complementando el filtro nativo de SH que filtra por dónde está PARADA (`Estación: Proquipa.N1.A1`). **La trampa que casi entra: el destino NO está en el `textContent`** — la tarjeta dice `Proceso: T400 …` mientras su estación programada real es `T300`, así que el código se lee de la celda `td[1]` de la tabla de `Tareas Programadas:` (medido en vivo; `td[0]`, el tratamiento, a veces no trae código: `TR-PRM-001 Antitarnish Manual`). Catálogo del dropdown desde la API (`GetRelatedScheduleData` ya interceptado + `AllStations`) porque el board está **virtualizado con react-virtuoso** y solo monta ~8 tarjetas — un dropdown armado del DOM nacería incompleto. **Esconder SÍ es seguro con virtuoso** (medido: `display:none` sobre `[data-item-index]` → re-mide, `scrollHeight` 1034→524, rects contiguos, cero huecos). Dos guardas: >200 items montados → atenúa; y si la API reporta programadas pero ninguna tarjeta revela línea, **se apaga solo** (esconder trabajo real no se nota, a diferencia de un color errado). No persiste, no toca el enforcement. Core 40/40)
```

- [ ] **Step 3: Verificar que la suite sigue verde**

Run: `tools/run-tests.sh`
Expected: todos verdes.

- [ ] **Step 4: Commit**

```bash
git add docs/applets/surtido-guard.md CLAUDE.md
git commit -m "docs(surtido-guard): bitácora del filtro por línea destino (v0.3.0)"
```

---

## Validación en vivo (después del deploy — NO es opcional)

El glue DOM no tiene tests automáticos (el repo no usa jsdom), así que esto **es** su verificación.

Deploy: `tools/deploy.sh "feat(surtido-guard): filtro por línea destino" --check surtido-guard`

Luego, en el board `/Domains/<d>/Workboards/<n>` de Preparación de Surtido:

- [ ] `window.SurtidoGuard._getState()` muestra `lineCounts.lines` con las líneas del board y `mountedCards` con los sets por tarjeta.
- [ ] El box aparece en la barra del header, **dark-mode**, y no se confunde con el filtro nativo.
- [ ] El dropdown ofrece `Todas` + las líneas con su conteo de órdenes.
- [ ] Elegir una línea deja solo sus tarjetas; **el layout no queda con huecos** y el scroll se acorta.
- [ ] El contador dice `N visible · M sin programar ocultas` y **el número cuadra** con lo que se ve.
- [ ] `✕` repone todas las tarjetas.
- [ ] **Invariante del candado:** sin filtro, mover una orden **no programada** sigue **bloqueado** (toast rojo).
- [ ] Scrollear con filtro puesto: las tarjetas que virtuoso monta después **también** se filtran.
- [ ] Salir del board y volver: el filtro arranca en `Todas` (no persiste) y no quedan tarjetas ocultas.
- [ ] Guarda de señal rota: en consola, `window.SurtidoGuardFilterCore.linesFromScheduledRows = () => []` y forzar un re-render ⇒ el box avisa `⚠️ no pude leer la línea` y **no esconde nada**.

## iPad (Safari) — después de validar en escritorio

- [ ] Agregar `surtido-guard-filter-core.js` al bundle: `build-safari.sh` expande `config.apps[].scripts`, así que basta bump + rebuild.
- [ ] `tools/build-safari.sh` y verificar **en el artefacto** (no en el log): `grep -c "linesFromScheduledRows\|sa-sg-filter" safari/extension/main-bundle.js` debe ser > 0 (y era 0 antes del rebuild).
- [ ] Sincronizar a `Resources/` y **recompilar en Xcode**.
