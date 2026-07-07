// tools/test/coverage-report.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { coverageReport } = require('../hash-autopilot/coverage-report.mjs');

const catalog = { routes: {
  'customers-list': { module: 'Customers', captures: ['AllCustomers', 'CustomerTags'] },
  'bills-detail': { module: 'Bills', captures: ['GetBillByIdInDomain'] },
} };

test('coverageReport: separa cubiertas de faltantes y calcula pct', () => {
  const r = coverageReport(catalog, ['AllCustomers', 'CustomerTags', 'GetBillByIdInDomain', 'GetProcessNode', 'GetPurchaseOrder']);
  assert.deepEqual(r.covered.sort(), ['AllCustomers', 'CustomerTags', 'GetBillByIdInDomain'].sort());
  assert.deepEqual(r.missing.sort(), ['GetProcessNode', 'GetPurchaseOrder'].sort());
  assert.equal(r.pct, 60); // 3 de 5
});

test('coverageReport: todas cubiertas → pct 100, missing vacío', () => {
  const r = coverageReport(catalog, ['AllCustomers']);
  assert.equal(r.pct, 100);
  assert.deepEqual(r.missing, []);
});

test('coverageReport: catálogo vacío → pct 0, todas missing', () => {
  const r = coverageReport({ routes: {} }, ['A', 'B']);
  assert.equal(r.pct, 0);
  assert.deepEqual(r.missing.sort(), ['A', 'B']);
});
