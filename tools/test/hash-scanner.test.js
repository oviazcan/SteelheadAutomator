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

test('sanitizeVariables: redacta key body en ops benignas, conserva el resto', () => {
  const result = I.sanitizeVariables('SaveInvoice', {
    invoice: { id: 42, total: '100.00', notes: 'visible text' },
    emailData: { to: 'a@b.com', body: 'SUPER_SECRET_TOKEN_xyz' }
  });
  assert.strictEqual(result.invoice.id, 42, 'id visible');
  assert.strictEqual(result.invoice.total, '100.00', 'total visible');
  assert.strictEqual(result.invoice.notes, 'visible text', 'notes visible');
  assert.strictEqual(result.emailData, '[REDACTED]', 'emailData key matches → redacted');
});

test('sanitizeVariables: ya NO redacta el payload entero por nombre de op', () => {
  const result = I.sanitizeVariables('GetInvoiceLineItemsForRolis', {
    invoiceId: 12345,
    filter: { status: 'ACTIVE' }
  });
  assert.strictEqual(result.invoiceId, 12345, 'no op-level redaction');
  assert.deepStrictEqual(result.filter, { status: 'ACTIVE' });
});

test('sanitizeVariables: redacta keys sensibles incluso anidadas profundo', () => {
  const result = I.sanitizeVariables('AnyOp', {
    payload: { nested: { token: 'abc123', meta: { authToken: 'def456', name: 'ok' } } }
  });
  assert.strictEqual(result.payload.nested.token, '[REDACTED]');
  assert.strictEqual(result.payload.nested.meta.authToken, '[REDACTED]');
  assert.strictEqual(result.payload.nested.meta.name, 'ok');
});

test('sanitizeVariables: trunca strings largas (>500 chars)', () => {
  const longStr = 'x'.repeat(600);
  const result = I.sanitizeVariables('AnyOp', { data: longStr });
  assert.ok(String(result.data).startsWith('[TRUNCATED:'), 'long string truncated');
});

test('sanitizeVariables: redacta ?token=... en URLs', () => {
  const result = I.sanitizeVariables('AnyOp', { url: 'https://x.com/y?token=SECRET&a=1' });
  assert.ok(result.url.includes('token=[REDACTED]'));
  assert.ok(result.url.includes('a=1'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
