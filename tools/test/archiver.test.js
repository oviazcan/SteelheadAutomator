// tools/test/archiver.test.js
// Carga remote/scripts/archiver.js en un vm con stub window/document.
// El IIFE es síncrono y solo define funciones, así que expone window.__SAArchiver.
// Run: node --test tools/test/archiver.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'archiver.js');

function loadArchiver() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const window = {};
  const sandbox = {
    window,
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }),
                head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, Promise,
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'archiver.js' });
  if (!sandbox.window.__SAArchiver) throw new Error('__SAArchiver no exportado');
  return sandbox.window.__SAArchiver;
}

const A = loadArchiver();

const node = (over = {}) => ({
  id: 1, name: 'PN1', createdAt: '2026-01-01T00:00:00Z', archivedAt: null,
  customerByCustomerId: { id: 9, name: 'ACME' },
  partNumberLabelsByPartNumberId: { nodes: [
    { labelByLabelId: { id: 10, name: 'SQ1', color: '#fff' } },
    { labelByLabelId: { id: 11, name: 'Antitarnish', color: '#000' } },
  ] },
  ...over,
});

test('slimPN reduce el nodo a campos slim + labels', () => {
  const s = A.slimPN(node());
  assert.equal(s.id, 1);
  assert.equal(s.customer, 'ACME');
  assert.deepEqual(s.labels.map(l => l.name), ['SQ1', 'Antitarnish']);
});

test('slimPN tolera customer y labels ausentes', () => {
  const s = A.slimPN({ id: 2, name: 'X', customerByCustomerId: null, partNumberLabelsByPartNumberId: null });
  assert.equal(s.customer, '');
  assert.deepEqual(s.labels, []);
});

test('discoverLabels cuenta y ordena alfabéticamente', () => {
  const pns = [A.slimPN(node()), A.slimPN(node({ partNumberLabelsByPartNumberId: { nodes: [
    { labelByLabelId: { id: 10, name: 'SQ1' } } ] } }))];
  const cat = A.discoverLabels(pns);
  assert.deepEqual(cat, [{ name: 'Antitarnish', count: 1 }, { name: 'SQ1', count: 2 }]);
});

test('matchesLabels AND exige todas (case-insensitive)', () => {
  const pn = A.slimPN(node());
  assert.equal(A.matchesLabels(pn, ['sq1', 'antitarnish'], 'AND'), true);
  assert.equal(A.matchesLabels(pn, ['SQ1', 'SQ2'], 'AND'), false);
});

test('matchesLabels OR exige cualquiera', () => {
  const pn = A.slimPN(node());
  assert.equal(A.matchesLabels(pn, ['SQ2', 'Antitarnish'], 'OR'), true);
  assert.equal(A.matchesLabels(pn, ['SQ2', 'SQ3'], 'OR'), false);
});

test('matchesLabels sin selección no filtra', () => {
  assert.equal(A.matchesLabels(A.slimPN(node()), [], 'AND'), true);
});

test('applyFilters intersecta etiquetas + fecha', () => {
  const a = A.slimPN(node({ id: 1, createdAt: '2025-01-01T00:00:00Z' }));
  const b = A.slimPN(node({ id: 2, createdAt: '2026-06-01T00:00:00Z' }));
  const out = A.applyFilters([a, b], {
    selectedLabels: ['SQ1', 'Antitarnish'], labelMode: 'AND',
    dateFilter: { cutoffISO: '2026-01-01T00:00:00Z', direction: 'before' },
  });
  assert.deepEqual(out.map(p => p.id), [1]);
});

test('isInTargetState idempotencia por modo', () => {
  const active = A.slimPN(node({ archivedAt: null }));
  const arch = A.slimPN(node({ archivedAt: '2026-01-01T00:00:00Z' }));
  assert.equal(A.isInTargetState(active, 'archive'), false);
  assert.equal(A.isInTargetState(arch, 'archive'), true);
  assert.equal(A.isInTargetState(active, 'unarchive'), true);
  assert.equal(A.isInTargetState(arch, 'unarchive'), false);
});
