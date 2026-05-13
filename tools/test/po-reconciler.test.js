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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
