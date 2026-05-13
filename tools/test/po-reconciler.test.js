// tools/test/po-reconciler.test.js
// Run: node tools/test/po-reconciler.test.js

const assert = require('assert');
const path = require('path');

// Stub the browser-only globals before requiring the applet
global.window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
};
global.chrome = { runtime: {} };
global.document = { readyState: 'complete', addEventListener: () => {} };
global.history = {
  pushState: () => {},
  replaceState: () => {},
};

const POReconciler = require(path.resolve(__dirname, '../../remote/scripts/po-reconciler.js'));
const E = POReconciler._engine;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (err.actual !== undefined) {
      console.log(`    actual:   ${JSON.stringify(err.actual)}`);
      console.log(`    expected: ${JSON.stringify(err.expected)}`);
    }
    failed++;
  }
}

console.log('\n=== po-reconciler engine tests ===\n');

test('harness boots', () => {
  assert.ok(POReconciler, 'POReconciler should be defined');
  assert.ok(typeof POReconciler._engine === 'object', '_engine should be exposed');
});

test('consolidateByPN suma cantidades del mismo PN', () => {
  const result = E.consolidateByPN([
    { partNumber: 'A', quantity: 10 },
    { partNumber: 'B', quantity: 5 },
    { partNumber: 'A', quantity: 7 },
  ]);
  assert.deepStrictEqual(result, { A: 17, B: 5 });
});

test('consolidateByPN ignora líneas sin partNumber', () => {
  const result = E.consolidateByPN([
    { partNumber: 'A', quantity: 10 },
    { partNumber: null, quantity: 100 },
    { partNumber: '', quantity: 50 },
  ]);
  assert.deepStrictEqual(result, { A: 10 });
});

test('consolidateByPN trata quantity falsy como 0', () => {
  const result = E.consolidateByPN([
    { partNumber: 'A', quantity: 5 },
    { partNumber: 'A', quantity: null },
    { partNumber: 'A', quantity: undefined },
  ]);
  assert.deepStrictEqual(result, { A: 5 });
});

test('hungarianMatch elige la asignación diagonal cuando es óptima', () => {
  // costos: i=j es 0, off-diag es 10 → asignación óptima [0,1,2]
  const m = [
    [0, 10, 10],
    [10, 0, 10],
    [10, 10, 0],
  ];
  const result = E.hungarianMatch(m);
  assert.deepStrictEqual(result, { assignment: [0, 1, 2], totalCost: 0 });
});

test('hungarianMatch encuentra asignación no-trivial', () => {
  // costos:
  //   t0 → p0=5, p1=2, p2=3
  //   t1 → p0=1, p1=10, p2=4
  //   t2 → p0=3, p1=2, p2=6
  // óptimo: t0→p2 (3), t1→p0 (1), t2→p1 (2) = 6
  const m = [
    [5, 2, 3],
    [1, 10, 4],
    [3, 2, 6],
  ];
  const result = E.hungarianMatch(m);
  assert.strictEqual(result.totalCost, 6);
  assert.deepStrictEqual(result.assignment, [2, 0, 1]);
});

test('hungarianMatch maneja N=1', () => {
  const result = E.hungarianMatch([[42]]);
  assert.deepStrictEqual(result, { assignment: [0], totalCost: 42 });
});

test('hungarianMatch lanza si la matriz no es cuadrada', () => {
  assert.throws(() => E.hungarianMatch([[1, 2], [3]]), /cuadrada/i);
});

test('assignTempsToPOs asigna 1:1 minimizando piezas movidas', () => {
  const temps = [
    { ovId: 'T1', name: 'Producción',    byPN: { A: 10, B: 5 } },
    { ovId: 'T2', name: 'Kitting',       byPN: { A: 0,  B: 20 } },
  ];
  const pos = [
    { poNumber: '1400395001', byPN: { A: 10, B: 5 } },   // matchea T1
    { poNumber: '1400395002', byPN: { A: 0,  B: 20 } },  // matchea T2
  ];
  const result = E.assignTempsToPOs(temps, pos);
  assert.deepStrictEqual(result.assignment, [
    { tempOvId: 'T1', poNumber: '1400395001' },
    { tempOvId: 'T2', poNumber: '1400395002' },
  ]);
  assert.strictEqual(result.totalDelta, 0);
});

test('assignTempsToPOs cambia el orden si reduce piezas movidas', () => {
  const temps = [
    { ovId: 'T1', byPN: { A: 100 } },
    { ovId: 'T2', byPN: { B: 100 } },
  ];
  const pos = [
    { poNumber: 'PO_B', byPN: { B: 100 } },  // mejor con T2
    { poNumber: 'PO_A', byPN: { A: 100 } },  // mejor con T1
  ];
  const result = E.assignTempsToPOs(temps, pos);
  // Asignación óptima: T1 → PO_A, T2 → PO_B
  const byTemp = Object.fromEntries(result.assignment.map(a => [a.tempOvId, a.poNumber]));
  assert.strictEqual(byTemp.T1, 'PO_A');
  assert.strictEqual(byTemp.T2, 'PO_B');
});

test('assignTempsToPOs devuelve issue fatal si cardinality mismatch', () => {
  const temps = [{ ovId: 'T1', byPN: {} }, { ovId: 'T2', byPN: {} }];
  const pos = [{ poNumber: 'P1', byPN: {} }];
  const result = E.assignTempsToPOs(temps, pos);
  assert.strictEqual(result.assignment, null);
  assert.ok(result.issues.some(i => i.severity === 'fatal' && i.type === 'cardinality_mismatch'));
});

test('computeMovesForPN sin diferencias devuelve []', () => {
  const moves = E.computeMovesForPN('A', { T1: 10, T2: 5 }, { T1: 10, T2: 5 });
  assert.deepStrictEqual(moves, []);
});

test('computeMovesForPN: 1 donor → 1 deficit', () => {
  // T1 sobra 5, T2 falta 5
  const moves = E.computeMovesForPN('A', { T1: 15, T2: 0 }, { T1: 10, T2: 5 });
  assert.deepStrictEqual(moves, [{ pn: 'A', qty: 5, fromOvId: 'T1', toOvId: 'T2' }]);
});

test('computeMovesForPN: 1 donor → 2 deficits', () => {
  // T1 sobra 10, T2 falta 3, T3 falta 7
  const moves = E.computeMovesForPN('A', { T1: 10, T2: 0, T3: 0 }, { T1: 0, T2: 3, T3: 7 });
  // greedy: dona al mayor déficit primero (T3:7), luego al siguiente (T2:3)
  assert.strictEqual(moves.length, 2);
  assert.deepStrictEqual(moves.sort((a,b) => b.qty - a.qty), [
    { pn: 'A', qty: 7, fromOvId: 'T1', toOvId: 'T3' },
    { pn: 'A', qty: 3, fromOvId: 'T1', toOvId: 'T2' },
  ]);
});

test('computeMovesForPN: 2 donors → 1 deficit', () => {
  const moves = E.computeMovesForPN('A', { T1: 5, T2: 5, T3: 0 }, { T1: 0, T2: 0, T3: 10 });
  assert.strictEqual(moves.length, 2);
  const totalMoved = moves.reduce((s, m) => s + m.qty, 0);
  assert.strictEqual(totalMoved, 10);
  assert.ok(moves.every(m => m.toOvId === 'T3'));
});

test('detectIssuesForPN: HS > Σ POs → sobrante', () => {
  const issues = E.detectIssuesForPN('A', 15, 10);
  assert.deepStrictEqual(issues, [{
    severity: 'info', type: 'sobrante', pn: 'A',
    detail: 'HS tiene 15 piezas, Σ POs pide 10. Excedente 5 → OV Restantes.',
    sobrante: 5,
  }]);
});

test('detectIssuesForPN: HS < Σ POs → faltante (warn)', () => {
  const issues = E.detectIssuesForPN('A', 5, 10);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].severity, 'warn');
  assert.strictEqual(issues[0].type, 'faltante');
  assert.strictEqual(issues[0].faltante, 5);
});

test('detectIssuesForPN: PN solo en HS (POs = 0)', () => {
  const issues = E.detectIssuesForPN('A', 7, 0);
  assert.strictEqual(issues[0].type, 'pn_solo_en_hs');
  assert.strictEqual(issues[0].sobrante, 7);
});

test('detectIssuesForPN: PN solo en PO (HS = 0)', () => {
  const issues = E.detectIssuesForPN('A', 0, 8);
  assert.strictEqual(issues[0].type, 'pn_solo_en_po');
  assert.strictEqual(issues[0].faltante, 8);
});

test('detectIssuesForPN: igualdad → sin issues', () => {
  assert.deepStrictEqual(E.detectIssuesForPN('A', 10, 10), []);
});

test('buildPlan: match perfecto → 0 moves, renames listos', () => {
  const plan = E.buildPlan({
    pos: [
      { poNumber: '1400395001', byPN: { A: 10 } },
      { poNumber: '1400395002', byPN: { B: 5 } },
    ],
    temps: [
      { ovId: 'T1', name: 'Producción', byPN: { A: 10 } },
      { ovId: 'T2', name: 'Kitting',    byPN: { B: 5 } },
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.moves, []);
  assert.deepStrictEqual(plan.restantes, []);
  assert.strictEqual(plan.renames.length, 2);
  assert.deepStrictEqual(plan.renames.map(r => r.toName).sort(), ['1400395001', '1400395002']);
  assert.deepStrictEqual(plan.creates, []);
});

test('buildPlan: PN cross-OV requiere 1 move', () => {
  const plan = E.buildPlan({
    pos: [
      { poNumber: 'P1', byPN: { A: 15 } },  // matchea con T1 (A:10) si movemos 5 desde T2
      { poNumber: 'P2', byPN: { B: 10 } },  // matchea con T2 (B:10)
    ],
    temps: [
      { ovId: 'T1', name: 'Producción', byPN: { A: 10, B: 0 } },
      { ovId: 'T2', name: 'Kitting',    byPN: { A: 5,  B: 10 } },
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.strictEqual(plan.moves.length, 1);
  assert.deepStrictEqual(plan.moves[0], { pn: 'A', qty: 5, fromOvId: 'T2', toOvId: 'T1' });
  assert.strictEqual(plan.renames.length, 2);
});

test('buildPlan: sobrante → plan.creates trae OV Restantes si no existe', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 10 } }],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.creates[0].type, 'restantes-ov');
  assert.strictEqual(plan.creates[0].name, 'Restantes Schneider QRO');
  assert.strictEqual(plan.restantes.length, 1);
  assert.deepStrictEqual(plan.restantes[0], { pn: 'A', qty: 5, fromOvId: 'T1', toOvId: '__pending_restantes__' });
});

test('buildPlan: sobrante con OV Restantes existente → no se crea', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 10 } }],
    restantesOV: { id: 999, name: 'Restantes Schneider QRO' },
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.creates, []);
  assert.strictEqual(plan.restantes[0].toOvId, 999);
});

test('buildPlan: cardinality mismatch → plan vacío + issue fatal', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: {} }, { poNumber: 'P2', byPN: {} }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: {} }],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.moves, []);
  assert.deepStrictEqual(plan.renames, []);
  assert.ok(plan.issues.some(i => i.severity === 'fatal'));
});

test('buildPlan: override de asignación cambia los moves', () => {
  // Sin override: T1→P_A (5 movido), T2→P_B (0 movido) ó simétrico.
  // Forzar T1→P_B, T2→P_A invierte.
  const args = {
    pos: [
      { poNumber: 'P_A', byPN: { A: 10 } },
      { poNumber: 'P_B', byPN: { B: 10 } },
    ],
    temps: [
      { ovId: 'T1', name: 'Producción', byPN: { A: 10, B: 0 } },
      { ovId: 'T2', name: 'Kitting',    byPN: { A: 0, B: 10 } },
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
    overrides: {
      assignment: [
        { tempOvId: 'T1', poNumber: 'P_B' },
        { tempOvId: 'T2', poNumber: 'P_A' },
      ],
    },
  };
  const plan = E.buildPlan(args);
  // T1 quería A pero ahora le toca P_B → mover A:10 a T2 y traer B:10
  // Total: A:10 (T1→T2) + B:10 (T2→T1) = 2 moves
  assert.strictEqual(plan.moves.length, 2);
  assert.strictEqual(plan.renames.find(r => r.ovId === 'T1').toName, 'P_B');
  assert.strictEqual(plan.renames.find(r => r.ovId === 'T2').toName, 'P_A');
});

test('buildPlan: 3 temps × 3 POs no-trivial converge', () => {
  // Distribución mezclada del cliente
  const plan = E.buildPlan({
    pos: [
      { poNumber: 'P1', byPN: { X: 5,  Y: 0,  Z: 0  } },
      { poNumber: 'P2', byPN: { X: 0,  Y: 10, Z: 5  } },
      { poNumber: 'P3', byPN: { X: 5,  Y: 0,  Z: 15 } },
    ],
    temps: [
      { ovId: 'T1', name: 'Producción',   byPN: { X: 10, Y: 0,  Z: 0  } },  // PO compatible: P1+P3 partial
      { ovId: 'T2', name: 'Kitting',      byPN: { X: 0,  Y: 10, Z: 5  } },  // PO compatible: P2 exacto
      { ovId: 'T3', name: 'Lote cerrado', byPN: { X: 0,  Y: 0,  Z: 15 } },  // PO compatible: P3 parcial
    ],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  // Hay un óptimo donde T2→P2 (0 moves), T1→P1 (qty 5 sobrante de X), T3→P3 (necesita X:5)
  // → 1 move: X:5 de T1 a T3
  assert.ok(plan.renames.length === 3);
  assert.ok(plan.issues.every(i => i.severity !== 'fatal'));
});

test('buildPlan: solo OV Restantes, no recrear si ya existe con id', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 10 } }],
    restantesOV: { id: 42, name: 'Restantes Schneider QRO' },
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  assert.deepStrictEqual(plan.creates, []);
  assert.ok(plan.restantes.every(r => r.toOvId === 42));
});

test('buildPlan: PN solo en HS va completo a Restantes', () => {
  const plan = E.buildPlan({
    pos:   [{ poNumber: 'P1', byPN: { A: 5 } }],
    temps: [{ ovId: 'T1', name: 'Producción', byPN: { A: 5, ORPHAN: 8 } }],
    restantesOV: null,
    config: { restantesOvName: 'Restantes Schneider QRO' },
  });
  const orphan = plan.restantes.find(r => r.pn === 'ORPHAN');
  assert.ok(orphan);
  assert.strictEqual(orphan.qty, 8);
  assert.ok(plan.issues.some(i => i.type === 'pn_solo_en_hs'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
