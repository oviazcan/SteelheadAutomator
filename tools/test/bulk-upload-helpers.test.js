// tools/test/bulk-upload-helpers.test.js
// Carga remote/scripts/bulk-upload.js en un vm con stub window y extrae
// window.BulkUploadHelpers para testear helpers puros sin tocar DOM/fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload.js');

function loadHelpers() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {},
    document: { getElementById: () => null, head: { appendChild: () => {} }, body: { appendChild: () => {} }, createElement: () => ({ appendChild: () => {}, classList: { add: () => {} } }) },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => { throw new Error('fetch stub in test'); },
    chrome: { runtime: { sendMessage: () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    Blob: function() {},
    TextEncoder, TextDecoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: 'bulk-upload.js' });
  } catch (e) {
    throw new Error(`Failed to load bulk-upload.js in vm: ${e.message}\n${e.stack}`);
  }
  if (!sandbox.window.BulkUploadHelpers) {
    throw new Error('window.BulkUploadHelpers no fue exportado. Agregar exports al final del IIFE en bulk-upload.js.');
  }
  return sandbox.window.BulkUploadHelpers;
}

test('harness boots and exports helpers object', () => {
  const H = loadHelpers();
  assert.equal(typeof H, 'object');
});

test('isNonFinishLabel matches blacklist exactly', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY', 'STX', 'SXC', 'SRG', 'SCM', 'SQR', 'SQ2', 'NP desconocido', 'En desarrollo', 'Muestras', 'Lote', 'Obsoleto'];
  assert.equal(H.isNonFinishLabel('SMY', NON_FINISH), true);
  assert.equal(H.isNonFinishLabel('NP desconocido', NON_FINISH), true);
  assert.equal(H.isNonFinishLabel('NIQ', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel('CROMADO', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel('', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel(null, NON_FINISH), false);
  // Case-sensitive match (igual que vienen en Steelhead)
  assert.equal(H.isNonFinishLabel('smy', NON_FINISH), false);
});

test('acabadosOrdenados filters blacklist, sorts, joins', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY', 'STX', 'NP desconocido'];
  assert.equal(H.acabadosOrdenados(['NIQ', 'EST', 'SMY'], NON_FINISH), 'EST|NIQ');
  assert.equal(H.acabadosOrdenados(['SMY', 'STX'], NON_FINISH), '');
  assert.equal(H.acabadosOrdenados([], NON_FINISH), '');
  assert.equal(H.acabadosOrdenados(['CROMADO'], NON_FINISH), 'CROMADO');
  // labels duplicados se deduplican
  assert.equal(H.acabadosOrdenados(['NIQ', 'NIQ', 'EST'], NON_FINISH), 'EST|NIQ');
  // ignora nulos/vacíos
  assert.equal(H.acabadosOrdenados(['NIQ', null, '', 'EST'], NON_FINISH), 'EST|NIQ');
});

test('buildCompositeKey concatena con separador y normaliza name a uppercase', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY'];
  const k1 = H.buildCompositeKey({ customerId: 42, name: 'ABC-123', metalBase: 'COBRE', labels: ['NIQ', 'SMY'] }, NON_FINISH);
  assert.equal(k1, '42||ABC-123||COBRE||NIQ');

  // Name lowercase se normaliza
  const k2 = H.buildCompositeKey({ customerId: 42, name: 'abc-123', metalBase: 'COBRE', labels: ['NIQ'] }, NON_FINISH);
  assert.equal(k2, '42||ABC-123||COBRE||NIQ');

  // metalBase vacío se mantiene vacío
  const k3 = H.buildCompositeKey({ customerId: 7, name: 'X', metalBase: '', labels: [] }, NON_FINISH);
  assert.equal(k3, '7||X||||');

  // metalBase null se mantiene vacío
  const k4 = H.buildCompositeKey({ customerId: 7, name: 'X', metalBase: null, labels: ['EST', 'NIQ'] }, NON_FINISH);
  assert.equal(k4, '7||X||||EST|NIQ');
});

test('rankCandidates ordena por matchScore desc, IBMS vacío gana en ties, luego id asc', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY'];
  const csvRow = { customerId: 1, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const cands = [
    { id: 10, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q9' }, // match-2 + IBMS distinto
    { id: 5,  name: 'X', metalBase: 'CU', labels: ['EST'], quoteIBMS: '' },   // match-1 + IBMS vacío
    { id: 8,  name: 'X', metalBase: 'AL', labels: [],     quoteIBMS: '' },    // match-0 + IBMS vacío
    { id: 3,  name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },   // match-2 + IBMS vacío
  ];
  const ranked = H.rankCandidates(csvRow, cands, NON_FINISH);
  // Esperado: id 3 (match-2, IBMS vacío) > id 10 (match-2, IBMS distinto) > id 5 (match-1) > id 8 (match-0)
  // JSON.stringify evita fallo cross-realm de assert.deepEqual en Node >= 22 con vm arrays
  assert.equal(JSON.stringify(ranked.map(c => c.id)), JSON.stringify([3, 10, 5, 8]));
});

test('rankCandidates tie-breaker por id ascendente cuando todo lo demás es igual', () => {
  const H = loadHelpers();
  const NON_FINISH = [];
  const csvRow = { customerId: 1, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const cands = [
    { id: 20, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
    { id: 7,  name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
    { id: 15, name: 'X', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const ranked = H.rankCandidates(csvRow, cands, NON_FINISH);
  assert.equal(JSON.stringify(ranked.map(c => c.id)), JSON.stringify([7, 15, 20]));
});

test('rankCandidates returns empty array for empty candidates', () => {
  const H = loadHelpers();
  const ranked = H.rankCandidates({ customerId: 1, name: 'X', metalBase: '', labels: [], quoteIBMS: '' }, [], []);
  assert.equal(ranked.length, 0);
});
