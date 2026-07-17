// tools/test/product-updates.test.js — parte PURA del contexto de ProductUpdates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUpdatesContext, stripUpdateBoilerplate } = require('../hash-autopilot/product-updates.mjs');

test('stripUpdateBoilerplate: quita "PRODUCT ENHANCEMENT HIGHLIGHTS" del cuerpo', () => {
  const e = 'JULY 15, 2026: PRODUCT ENHANCEMENT HIGHLIGHTS AI RECEIVING UNIT CONVERSIONS AI receiving now pre-fills…';
  const out = stripUpdateBoilerplate(e);
  assert.ok(!/PRODUCT ENHANCEMENT HIGHLIGHTS/i.test(out));
  assert.match(out, /^JULY 15, 2026: AI RECEIVING/);
});
test('stripUpdateBoilerplate: sin boilerplate → intacto (colapsa espacios)', () => {
  assert.equal(stripUpdateBoilerplate('JULY 7, 2026: New quotes page'), 'JULY 7, 2026: New quotes page');
  assert.equal(stripUpdateBoilerplate(''), '');
  assert.equal(stripUpdateBoilerplate(null), '');
});
test('formatUpdatesContext: limpia el boilerplate de cada entrada', () => {
  const out = formatUpdatesContext({ entries: ['JULY 14, 2026: PRODUCT ENHANCEMENT HIGHLIGHTS AUTO-INVOICE EXCLUSIONS A new checkbox…'] });
  assert.ok(!/PRODUCT ENHANCEMENT HIGHLIGHTS/i.test(out));
  assert.match(out, /AUTO-INVOICE EXCLUSIONS/);
});

test('formatUpdatesContext: enlista entradas (hasta el máximo)', () => {
  const out = formatUpdatesContext({ entries: ['Nueva pantalla de Customers', 'Cambios en Inventory'] }, 5);
  assert.match(out, /ProductUpdates/);
  assert.match(out, /Nueva pantalla de Customers/);
  assert.match(out, /Cambios en Inventory/);
});

test('formatUpdatesContext: recorta entradas larguísimas', () => {
  const long = 'x'.repeat(400);
  const out = formatUpdatesContext({ entries: [long] });
  assert.ok(out.includes('…'));
  assert.ok(out.length < 400 + 100);
});

test('formatUpdatesContext: respeta maxEntries', () => {
  const out = formatUpdatesContext({ entries: ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)] }, 2);
  assert.ok(out.includes('a'.repeat(30)));
  assert.ok(out.includes('b'.repeat(30)));
  assert.ok(!out.includes('c'.repeat(30)));
});

test('formatUpdatesContext: sin entries cae al snippet', () => {
  const out = formatUpdatesContext({ entries: [], snippet: 'Resumen general del changelog' });
  assert.match(out, /extracto/);
  assert.match(out, /Resumen general/);
});

test('formatUpdatesContext: sin nada → cadena vacía', () => {
  assert.equal(formatUpdatesContext({ entries: [], snippet: '' }), '');
  assert.equal(formatUpdatesContext(null), '');
});
