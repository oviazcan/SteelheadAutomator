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

test('analyzeSchema: array vacío devuelve [null] (marker), no string "[]"', () => {
  const result = I.analyzeSchema({ nodes: [] });
  assert.deepStrictEqual(result, { nodes: [null] });
});

test('analyzeSchema: profundidad >4 NO se trunca con "..."', () => {
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { id: 1 } } } } } } };
  const result = I.analyzeSchema(deep);
  assert.strictEqual(
    result.l1.l2.l3.l4.l5.l6.id, 'number',
    'depth 7 still visible'
  );
});

test('mergeSchema: enriquece array vacío con shape de array poblado posterior', () => {
  const empty = I.analyzeSchema({ nodes: [] });
  const populated = I.analyzeSchema({ nodes: [{ id: 1, name: 'x' }] });
  const merged = I.mergeSchema(empty, populated);
  assert.deepStrictEqual(merged.nodes[0], { id: 'number', name: 'string' });
});

test('mergeSchema: union de campos de dos objetos', () => {
  const a = { id: 'number', name: 'string' };
  const b = { id: 'number', email: 'string' };
  const merged = I.mergeSchema(a, b);
  assert.deepStrictEqual(merged, { id: 'number', name: 'string', email: 'string' });
});

test('mergeSchema: campo null se reemplaza por shape posterior', () => {
  const a = { receivedAt: null };
  const b = { receivedAt: 'string' };
  assert.strictEqual(I.mergeSchema(a, b).receivedAt, 'string');
});

test('shapeSignature: mismo shape con valores distintos → misma firma', () => {
  const a = { id: 1, name: 'foo', nested: { x: 1 } };
  const b = { id: 999, name: 'bar', nested: { x: 42 } };
  assert.strictEqual(I.shapeSignature(a), I.shapeSignature(b));
});

test('shapeSignature: shape distinto → firma distinta', () => {
  const a = { id: 1, name: 'foo' };
  const b = { id: 1, name: 'foo', extra: true };
  assert.notStrictEqual(I.shapeSignature(a), I.shapeSignature(b));
});

test('shapeSignature: array de N items con shapes uniformes colapsa a 1 firma de item', () => {
  const arr1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const arr2 = [{ id: 99 }];
  assert.strictEqual(I.shapeSignature(arr1), I.shapeSignature(arr2));
});

test('shapeSignature: orden de keys no afecta firma', () => {
  const a = { a: 1, b: 2 };
  const b = { b: 2, a: 1 };
  assert.strictEqual(I.shapeSignature(a), I.shapeSignature(b));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
