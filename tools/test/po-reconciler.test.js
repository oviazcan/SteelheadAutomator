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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
