// tools/test/hash-scanner.test.js
// Run: node tools/test/hash-scanner.test.js

const assert = require('assert');
const path = require('path');

global.window = { addEventListener: () => {}, dispatchEvent: () => {} };
global.document = { dispatchEvent: () => {} };

const HashScanner = require(path.resolve(__dirname, '../../remote/scripts/hash-scanner.js'));
const I = HashScanner._internal;

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

console.log('\n=== hash-scanner tests ===\n');

test('harness boots', () => {
  assert.ok(HashScanner, 'HashScanner defined');
  assert.ok(typeof I === 'object', '_internal exposed');
  assert.ok(typeof I.sanitizeVariables === 'function');
  assert.ok(typeof I.analyzeSchema === 'function');
});

test('init() keeps _internal.knownHashMap reference live', () => {
  const before = I.knownHashMap;
  HashScanner.init({ steelhead: { hashes: { mutations: { Foo: 'h1' }, queries: { Bar: 'h2' } } } });
  assert.strictEqual(I.knownHashMap, before, '_internal.knownHashMap reference is preserved');
  assert.strictEqual(I.knownHashMap['h1'], 'Foo');
  assert.strictEqual(I.knownOpMap['Bar'], 'h2');
  // Re-init clears prior entries in place
  HashScanner.init({ steelhead: { hashes: { mutations: { Baz: 'h3' }, queries: {} } } });
  assert.strictEqual(I.knownHashMap['h1'], undefined);
  assert.strictEqual(I.knownHashMap['h3'], 'Baz');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
