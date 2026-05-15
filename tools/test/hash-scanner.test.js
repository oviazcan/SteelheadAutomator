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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
