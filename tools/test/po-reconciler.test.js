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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
