// tools/test/bulk-upload-helpers.test.js
// Carga remote/scripts/bulk-upload.js en un vm con stub window y extrae
// window.BulkUploadHelpers para testear helpers puros sin tocar DOM/fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload.js');
const CLASSIFY_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload-classify.js');
const CC_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload-cc.js');

function loadHelpers() {
  // Las funciones de clasificación migraron de bulk-upload.js (inline) al módulo
  // puro bulk-upload-classify.js; bulk-upload.js las importa vía
  // `window.SteelheadBulkClassify` (con fallback `|| {}`, por eso salían undefined
  // en el sandbox). Inyectamos ambos módulos para que el export __helpers resuelva
  // TODAS las funciones (extractPNShape sigue inline en bulk-upload.js). Así estos
  // golden tests siguen corriendo contra el código vivo tras el refactor F1.
  const cc = require(CC_PATH);
  const classify = require(CLASSIFY_PATH);
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: { SteelheadBulkClassify: classify, SteelheadBulkCC: cc },
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
  const NON_FINISH = ['SMY', 'STX', 'SXC', 'SRG', 'SCM', 'SQ1', 'SQ2', 'NP desconocido', 'En desarrollo', 'Muestras', 'Lote', 'Obsoleto'];
  assert.equal(H.isNonFinishLabel('SMY', NON_FINISH), true);
  assert.equal(H.isNonFinishLabel('NP desconocido', NON_FINISH), true);
  assert.equal(H.isNonFinishLabel('NIQ', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel('CROMADO', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel('', NON_FINISH), false);
  assert.equal(H.isNonFinishLabel(null, NON_FINISH), false);
  // 1.4.x: el módulo bulk-upload-classify.js normaliza a upper (normLabel) → match
  // CASE-INSENSITIVE. Confirmado por el golden vigente test_bulk_upload_classify.js.
  // (Antes del refactor F1 era case-sensitive; este assert se actualizó con él.)
  assert.equal(H.isNonFinishLabel('smy', NON_FINISH), true);
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

test('classifyOnePN — Caso 1: IBMS exacto, name iguales → Pase 1 MODIFY', () => {
  const H = loadHelpers();
  const NON_FINISH = ['SMY'];
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, NON_FINISH);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.confidence, 'ibms-exacto');
});

test('classifyOnePN — Caso 2: IBMS exacto, name distinto → Pase 1 MODIFY + rename', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'B', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
});

test('classifyOnePN — Caso 3: CSV trae IBMS, PN no, composite match → Pase 2 MODIFY (populate)', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 2);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.confidence, 'composite-exacto-pn-sin-ibms');
});

test('classifyOnePN — Caso 4: CSV sin IBMS, PN con IBMS, composite match → Pase 2 MODIFY (preserva IBMS)', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Y' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 2);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.confidence, 'composite-exacto-csv-sin-ibms');
});

test('classifyOnePN — Caso 5: dos PNs, uno por IBMS y otro por name; gana Pase 1', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'Z', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' }, // matchea por IBMS
    { id: 101, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Y' }, // matchea por composite, IBMS distinto
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
});

test('classifyOnePN — Caso 6: name + etiquetas coinciden, metalBase distinto → Pase 3 MODIFY default al top match', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'AL', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 3);
  assert.equal(r.confidence, 'name+labels-match');
  assert.equal(r.targetPnId, 100);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 100);
});

test('classifyOnePN — Caso 6b: name coincide pero etiquetas distintas → Pase 3 NEW default + candidatos disponibles', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ', 'CRO'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'AL', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, 3);
  assert.equal(r.confidence, 'name-only-labels-differ');
  assert.equal(r.targetPnId, null);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 100);
});

test('classifyOnePN — Caso 6c: name coincide, CSV labels superset del candidato → Pase 3 NEW default', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ', 'CRO', 'EST'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ', 'CRO'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, 3);
  assert.equal(r.candidates.length, 1);
});

test('classifyOnePN — Caso 6d: name coincide, etiquetas iguales ignorando nonFinish → MODIFY top match', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ', 'SMY'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'AL', labels: ['NIQ', 'SXC'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, ['SMY', 'SXC']);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 3);
  assert.equal(r.targetPnId, 100);
});

test('classifyOnePN — Caso 6e (1.2.9): no strict match pero hay candidato sin-etiqueta → MODIFY blank', () => {
  // CSV con etiquetas pero ningún candidato matchea exacto; UN candidato no tiene
  // etiquetas (slate limpia). Default debe ser MODIFY ese blank candidate
  // en vez de NEW — es más seguro completar un PN vacío que duplicar.
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['ANTITARNISH'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['PLATA FLASH', 'ANTITARNISH'], quoteIBMS: '' }, // etiquetas extras
    { id: 200, name: 'A', metalBase: 'AL', labels: ['DECAPADO', 'ESTAÑO'], quoteIBMS: '' },        // etiquetas distintas
    { id: 300, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: '' },                            // blank — éste gana
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 3);
  assert.equal(r.confidence, 'name+blank-candidate');
  assert.equal(r.targetPnId, 300);
  assert.equal(r.candidates.length, 3);
});

test('classifyOnePN — Caso 6f (1.2.9): no strict match, dos blank candidates → toma el primero por ranking (id asc en ties)', () => {
  // Múltiples blanks → escoge el del menor id (rankCandidates tie-breaks por id asc
  // cuando score e ibmsRank empatan).
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 500, name: 'A', metalBase: 'AL', labels: [], quoteIBMS: '' }, // blank id mayor
    { id: 100, name: 'A', metalBase: 'AL', labels: [], quoteIBMS: '' }, // blank id menor
    { id: 200, name: 'A', metalBase: 'CU', labels: ['CRO'], quoteIBMS: '' }, // labeled
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 3);
  assert.equal(r.confidence, 'name+blank-candidate');
  assert.equal(r.targetPnId, 100);
});

test('classifyOnePN — Caso 6g (1.2.9): no strict match y sin blank candidate → NEW', () => {
  // Regresión: cuando ningún candidato es sin-etiqueta, el default sigue siendo NEW
  // (no se hace fallback a un candidato labeled solo porque exista).
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'AL', labels: ['CRO'], quoteIBMS: '' },
    { id: 200, name: 'A', metalBase: 'FE', labels: ['EST', 'DEC'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, 3);
  assert.equal(r.confidence, 'name-only-labels-differ');
  assert.equal(r.targetPnId, null);
  assert.equal(r.candidates.length, 2);
});

test('classifyOnePN — Caso 7: nada parecido → NEW sin candidatos', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'Z', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, null);
  assert.equal(r.targetPnId, null);
  assert.equal(r.candidates.length, 0);
});

test('classifyOnePN — anti-colisión Pase 2: composite match pero ambos IBMS no-vacíos y distintos → cae a Pase 3 con default MODIFY', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Y' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 3);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 100);
});

test('classifyOnePN — Pase 3 devuelve TODOS los matches por nombre (sin cap)', () => {
  // 1.2.8: removimos el cap de 3 candidatos. Antes confundía al operador porque
  // parecía que faltaban PNs cuando en realidad estaban abajo del corte. Ahora
  // el dropdown muestra todos los matches por nombre del cliente.
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 1, name: 'A', metalBase: 'AL', labels: [], quoteIBMS: '' },
    { id: 2, name: 'A', metalBase: 'FE', labels: [], quoteIBMS: '' },
    { id: 3, name: 'A', metalBase: 'ZN', labels: [], quoteIBMS: '' },
    { id: 4, name: 'A', metalBase: 'PB', labels: [], quoteIBMS: '' },
    { id: 5, name: 'A', metalBase: 'NI', labels: [], quoteIBMS: '' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.pase, 3);
  assert.equal(r.candidates.length, 5);
});

test('classifyOnePN — 1.2.12: archivedAt YA NO excluye en Pase 1 (opción B, desarchiva)', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: 'X', archivedAt: '2024-01-01' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.wasArchived, true);
  assert.equal(r.confidence, 'ibms-exacto-desarchiva');
});

test('extractPNShape parsea customInputs como string JSON', () => {
  const H = loadHelpers();
  const node = {
    id: 42,
    name: 'X',
    customInputs: '{"DatosAdicionalesNP":{"BaseMetal":"CU","QuoteIBMS":"Q1"}}',
    partNumberLabelsByPartNumberId: { nodes: [{ labelByLabelId: { name: 'NIQ' } }, { labelByLabelId: { name: 'SMY' } }] },
    archivedAt: null,
    customerByCustomerId: { id: 7 },
  };
  const r = H.extractPNShape(node);
  assert.equal(r.id, 42);
  assert.equal(r.metalBase, 'CU');
  assert.equal(r.quoteIBMS, 'Q1');
  assert.equal(JSON.stringify(r.labels), JSON.stringify(['NIQ', 'SMY']));
  assert.equal(r.customerId, 7);
});

test('extractPNShape tolera customInputs null/undefined sin throw', () => {
  const H = loadHelpers();
  const r = H.extractPNShape({ id: 1, name: 'Y', customInputs: null, partNumberLabelsByPartNumberId: null });
  assert.equal(r.metalBase, '');
  assert.equal(r.quoteIBMS, '');
  assert.equal(JSON.stringify(r.labels), JSON.stringify([]));
});

test('extractPNShape acepta customInputs como objeto plano (shape real del API)', () => {
  const H = loadHelpers();
  const r = H.extractPNShape({ id: 1, name: 'Y', customInputs: { DatosAdicionalesNP: { BaseMetal: 'AL' } } });
  assert.equal(r.metalBase, 'AL');
});

// ─── 1.2.10 dedup MODIFY targets ───

function makeRow({ idx, pn, pase, confidence, existingId, candidates = [], status = 'existing', userOverride = null, csvLabels = [], csvMetalBase = '' }) {
  return {
    idx, // sintético para sort estable en helpers (no es el field idx real)
    pn,
    status,
    existingId,
    existingProcessId: null,
    qty: 1, precio: 0, customerId: 7,
    classification: status === 'new' ? 'NEW' : 'MODIFY',
    pase, confidence,
    candidates,
    userOverride,
    targetPnId: existingId,
    csvRowKey: `${pn}|7`,
    csvLabels,
    csvMetalBase,
  };
}

test('dedupModifyTargets — sin conflictos, no muta nada', () => {
  const H = loadHelpers();
  const rows = [
    makeRow({ pn: 'A', pase: 1, confidence: 'ibms-exacto', existingId: 100 }),
    makeRow({ pn: 'B', pase: 1, confidence: 'ibms-exacto', existingId: 200 }),
    makeRow({ pn: 'C', pase: 3, confidence: 'name+labels-match', existingId: 300, candidates: [{ id: 300, labels: [] }, { id: 301, labels: [] }] }),
  ];
  const r = H.dedupModifyTargets(rows);
  assert.equal(r.reassigned, 0);
  assert.equal(r.demoted, 0);
  assert.equal(rows[0].existingId, 100);
  assert.equal(rows[1].existingId, 200);
  assert.equal(rows[2].existingId, 300);
});

test('dedupModifyTargets — Pase 1 gana, Pase 3 con alterno se re-asigna', () => {
  const H = loadHelpers();
  // Row #0 Pase 1 → #500 (autoritativo, sin alternativas)
  // Row #1 Pase 3 strict → #500 (top match)... pero #500 ya tomado por #0
  //   Alternativa en candidates: #501
  const rows = [
    makeRow({ pn: 'X', pase: 1, confidence: 'ibms-exacto', existingId: 500 }),
    makeRow({ pn: 'X', pase: 3, confidence: 'name+labels-match', existingId: 500, candidates: [
      { id: 500, labels: [], defaultProcessNodeId: 11 },
      { id: 501, labels: [], defaultProcessNodeId: 22 },
    ]}),
  ];
  const r = H.dedupModifyTargets(rows);
  assert.equal(r.reassigned, 1);
  assert.equal(r.demoted, 0);
  assert.equal(rows[0].existingId, 500); // ganó
  assert.equal(rows[1].existingId, 501); // re-asignado
  assert.equal(rows[1].dedupReassigned, true);
  assert.equal(rows[1].dedupOriginalTargetPnId, 500);
  assert.equal(rows[1].existingProcessId, 22); // del nuevo target
  assert.equal(rows[1].status, 'existing'); // sigue MODIFY
});

test('dedupModifyTargets — dos Pase 3 con mismo top → loser toma alterno (todos blank con nfList vacío)', () => {
  // Caso real del usuario: dos filas con mismo nombre en el CSV; ambas Pase 3
  // con candidates idénticos cuyos labels filtrados quedan vacíos. El primer
  // row (idx menor) toma el #701; el segundo busca strict-match → ambos blank →
  // toma el #700.
  const H = loadHelpers();
  const candidates = [
    { id: 700, labels: ['NIQ'], defaultProcessNodeId: 11 },
    { id: 701, labels: [], defaultProcessNodeId: 22 },
  ];
  const rows = [
    makeRow({ pn: 'A', pase: 3, confidence: 'name+blank-candidate', existingId: 701, candidates }),
    makeRow({ pn: 'A', pase: 3, confidence: 'name+blank-candidate', existingId: 701, candidates }),
  ];
  // Pasamos 'NIQ' al nonFinishList → ambos candidates colapsan a acabados=''
  // → strict-match acepta #700.
  const r = H.dedupModifyTargets(rows, ['NIQ']);
  assert.equal(r.reassigned, 1);
  assert.equal(r.demoted, 0);
  assert.equal(rows[0].existingId, 701); // primero gana (idx asc)
  assert.equal(rows[1].existingId, 700); // alterno disponible
  assert.equal(rows[1].dedupReassigned, true);
});

test('dedupModifyTargets — sin alternativas → demota a NEW con conflict marker', () => {
  const H = loadHelpers();
  // Row #0 toma #800. Row #1 Pase 3 con UN solo candidato (#800) que ya está tomado.
  const rows = [
    makeRow({ pn: 'A', pase: 2, confidence: 'composite-exacto-ambos-sin-ibms', existingId: 800 }),
    makeRow({ pn: 'A', pase: 3, confidence: 'name+labels-match', existingId: 800, candidates: [
      { id: 800, labels: ['NIQ'], defaultProcessNodeId: 11 },
    ]}),
  ];
  const r = H.dedupModifyTargets(rows);
  assert.equal(r.reassigned, 0);
  assert.equal(r.demoted, 1);
  assert.equal(rows[0].existingId, 800);
  assert.equal(rows[1].status, 'new');
  assert.equal(rows[1].classification, 'NEW');
  assert.equal(rows[1].existingId, null);
  assert.equal(rows[1].dedupConflict, true);
  assert.equal(rows[1].dedupConflictTargetPnId, 800);
});

test('dedupModifyTargets — Pase 1 vs Pase 1 con mismo id (CSV con dos filas mismo IBMS) → loser demotado', () => {
  const H = loadHelpers();
  // Pase 1 no tiene candidates → no hay alternativas; loser obligado a NEW.
  const rows = [
    makeRow({ pn: 'A', pase: 1, confidence: 'ibms-exacto', existingId: 900 }),
    makeRow({ pn: 'A', pase: 1, confidence: 'ibms-exacto', existingId: 900 }),
  ];
  const r = H.dedupModifyTargets(rows);
  assert.equal(r.demoted, 1);
  assert.equal(rows[1].status, 'new');
  assert.equal(rows[1].dedupConflict, true);
});

test('dedupModifyTargets — orden de precedencia Pase 1 > Pase 2 > Pase 3 strict > Pase 3 blank', () => {
  const H = loadHelpers();
  // Cuatro filas todas apuntan a #1000. Solo la Pase 1 (en idx más alto)
  // debe ganar, las otras se reparten o demotán.
  // Para forzar el orden, las pongo en orden inverso al idx CSV: el Pase 1
  // está en idx 3 (último). Aún así dedup debe darle precedencia por pase.
  const candidatesShared = [
    { id: 1000, labels: [], defaultProcessNodeId: null },
    { id: 1001, labels: [], defaultProcessNodeId: null },
    { id: 1002, labels: [], defaultProcessNodeId: null },
    { id: 1003, labels: [], defaultProcessNodeId: null },
  ];
  const rows = [
    makeRow({ pn: 'A', pase: 3, confidence: 'name+blank-candidate', existingId: 1000, candidates: candidatesShared }),
    makeRow({ pn: 'A', pase: 3, confidence: 'name+labels-match', existingId: 1000, candidates: candidatesShared }),
    makeRow({ pn: 'A', pase: 2, confidence: 'composite-exacto-ambos-sin-ibms', existingId: 1000 }),
    makeRow({ pn: 'A', pase: 1, confidence: 'ibms-exacto', existingId: 1000 }),
  ];
  H.dedupModifyTargets(rows);
  // Pase 1 (idx 3) gana #1000
  assert.equal(rows[3].existingId, 1000);
  assert.equal(!!rows[3].dedupReassigned, false);
  // Pase 2 (idx 2) sin alternativas → demotado
  assert.equal(rows[2].status, 'new');
  assert.equal(rows[2].dedupConflict, true);
  // Pase 3 strict (idx 1) toma siguiente alterno disponible (#1001)
  assert.equal(rows[1].existingId, 1001);
  assert.equal(rows[1].dedupReassigned, true);
  // Pase 3 blank (idx 0) toma el siguiente (#1002)
  assert.equal(rows[0].existingId, 1002);
  assert.equal(rows[0].dedupReassigned, true);
});

test('dedupModifyTargets — rows con status=new no participan', () => {
  const H = loadHelpers();
  const rows = [
    makeRow({ pn: 'A', pase: null, confidence: 'sin-match', existingId: null, status: 'new' }),
    makeRow({ pn: 'B', pase: 3, confidence: 'name+labels-match', existingId: 555, candidates: [{ id: 555, labels: [] }] }),
  ];
  const r = H.dedupModifyTargets(rows);
  assert.equal(r.reassigned, 0);
  assert.equal(r.demoted, 0);
  assert.equal(rows[1].existingId, 555);
});

// ─── 1.2.11 dedup strict-match en alternates ───

test('1.2.11 dedup — alternate strict-match (acabados iguales al CSV) se acepta', () => {
  const H = loadHelpers();
  // CSV labels: [NIQ, CRO] → acabados ordenados: 'CRO-NIQ'
  // Row 0 toma #800 (strict-match top).
  // Row 1 también quiere #800; alterno #801 tiene mismos acabados (strict) → re-asigna.
  const candidates = [
    { id: 800, labels: ['NIQ', 'CRO'], defaultProcessNodeId: 10 },
    { id: 801, labels: ['CRO', 'NIQ'], defaultProcessNodeId: 20 }, // mismo set, distinto orden
    { id: 802, labels: ['NIQ'], defaultProcessNodeId: 30 },        // distinto
  ];
  const rows = [
    makeRow({ pn: 'P', pase: 3, confidence: 'name+labels-match', existingId: 800, candidates, csvLabels: ['NIQ', 'CRO'] }),
    makeRow({ pn: 'P', pase: 3, confidence: 'name+labels-match', existingId: 800, candidates, csvLabels: ['NIQ', 'CRO'] }),
  ];
  const r = H.dedupModifyTargets(rows, []);
  assert.equal(r.reassigned, 1);
  assert.equal(r.demoted, 0);
  assert.equal(rows[0].existingId, 800);
  assert.equal(rows[1].existingId, 801); // strict-match con CSV
  assert.equal(rows[1].dedupReassigned, true);
  assert.equal(rows[1].confidence, 'name+labels-match');
  assert.equal(rows[1].existingProcessId, 20);
});

test('1.2.11 dedup — alternate sin strict-match pero blank disponible → usa blank', () => {
  const H = loadHelpers();
  // CSV labels: [NIQ] → csvAcabados='NIQ'
  // Candidates: #900 ['NIQ'] (strict-match top), #901 ['CRO'] (no strict), #902 [] (blank).
  // Row 0 toma #900. Row 1 quiere #900; no hay strict-match alterno → cae a blank #902.
  const candidates = [
    { id: 900, labels: ['NIQ'], defaultProcessNodeId: 11 },
    { id: 901, labels: ['CRO'], defaultProcessNodeId: 22 },
    { id: 902, labels: [], defaultProcessNodeId: 33 },
  ];
  const rows = [
    makeRow({ pn: 'Q', pase: 3, confidence: 'name+labels-match', existingId: 900, candidates, csvLabels: ['NIQ'] }),
    makeRow({ pn: 'Q', pase: 3, confidence: 'name+labels-match', existingId: 900, candidates, csvLabels: ['NIQ'] }),
  ];
  const r = H.dedupModifyTargets(rows, []);
  assert.equal(r.reassigned, 1);
  assert.equal(r.demoted, 0);
  assert.equal(rows[0].existingId, 900);
  assert.equal(rows[1].existingId, 902); // blank fallback
  assert.equal(rows[1].dedupReassigned, true);
  assert.equal(rows[1].confidence, 'name+blank-candidate');
  assert.equal(rows[1].existingProcessId, 33);
});

test('1.2.11 dedup — alternate sin strict-match y sin blank → demota a NEW (caso Image #10)', () => {
  const H = loadHelpers();
  // Caso del screenshot Image #10:
  // - CSV PN 80360-046-03 con labels [Antitarnish, SRG], metalBase Cobre.
  //   SRG es nonFinish → csvAcabados='Antitarnish'.
  // - Candidates: #2868691 ['Antitarnish'] (strict-match top), #2868692 ['Antitarnish', 'Plata Flash'].
  //   acabados de #2868692 = 'Antitarnish-Plata Flash' ≠ 'Antitarnish'.
  // - Row 0 toma #2868691.
  // - Row 1 quiere #2868691; no hay strict-match (solo #2868692 con acabados distintos)
  //   ni blank (no hay candidato sin acabados) → DEMOTA a NEW.
  const candidates = [
    { id: 2868691, labels: ['Antitarnish'], defaultProcessNodeId: 100 },
    { id: 2868692, labels: ['Antitarnish', 'Plata Flash'], defaultProcessNodeId: 200 },
  ];
  const rows = [
    makeRow({ pn: '80360-046-03', pase: 3, confidence: 'name+labels-match', existingId: 2868691, candidates, csvLabels: ['Antitarnish', 'SRG'], csvMetalBase: 'CU' }),
    makeRow({ pn: '80360-046-03', pase: 3, confidence: 'name+labels-match', existingId: 2868691, candidates, csvLabels: ['Antitarnish', 'SRG'], csvMetalBase: 'CU' }),
  ];
  const r = H.dedupModifyTargets(rows, ['SRG']);
  assert.equal(r.reassigned, 0);
  assert.equal(r.demoted, 1);
  assert.equal(rows[0].existingId, 2868691); // primero gana
  assert.equal(rows[1].status, 'new');
  assert.equal(rows[1].classification, 'NEW');
  assert.equal(rows[1].existingId, null);
  assert.equal(rows[1].targetPnId, null);
  assert.equal(rows[1].dedupConflict, true);
  assert.equal(rows[1].dedupConflictTargetPnId, 2868691);
});

test('PNStatus post-override mantiene shape compatible con enrichWorker', () => {
  const simulatedStatus = {
    pn: 'X',
    status: 'existing',
    existingId: 100,
    existingProcessId: null,
    qty: 1,
    precio: 0,
    customerId: 7,
    classification: 'NEW',
    pase: 3,
    confidence: 'near-match-name',
    candidates: [{ id: 100, name: 'X', metalBase: 'CU', labels: [], quoteIBMS: '', defaultProcessNodeId: null }],
    userOverride: 100,
    targetPnId: null,
    csvRowKey: 'X|7',
  };
  assert.equal(simulatedStatus.status, 'existing');
  assert.equal(simulatedStatus.existingId, 100);
});

// ────────────────────────────────────────────────────────────────────
// 1.2.11 H7: detectCsvDuplicates + integridad de keys por rowIdx
// ────────────────────────────────────────────────────────────────────

test('1.2.11 H1 detectCsvDuplicates — sin duplicados marca todo limpio', () => {
  const H = loadHelpers();
  const parts = [
    { pn: 'A-001', customerId: 7 },
    { pn: 'B-002', customerId: 7 },
    { pn: 'A-001', customerId: 99 }, // mismo nombre pero distinto cliente — no es dup
  ];
  const { dupGroups, dupRows } = H.detectCsvDuplicates(parts);
  assert.equal(dupGroups, 0);
  assert.equal(dupRows, 0);
  for (const p of parts) {
    assert.equal(!!p.isCsvDuplicate, false);
    assert.equal(p.csvDuplicateIndex || null, null);
    assert.equal(p.csvDuplicateGroupSize || null, null);
  }
});

test('1.2.11 H1 detectCsvDuplicates — dos filas mismo (PN, cliente) marca ambas y reporta 1 grupo / 1 fila extra', () => {
  const H = loadHelpers();
  const parts = [
    { pn: 'A-001', customerId: 7 },
    { pn: 'A-001', customerId: 7 },
  ];
  const { dupGroups, dupRows } = H.detectCsvDuplicates(parts);
  assert.equal(dupGroups, 1);
  assert.equal(dupRows, 1); // n filas dup, extras = n - 1
  assert.equal(parts[0].isCsvDuplicate, true);
  assert.equal(parts[0].csvDuplicateIndex, 1);
  assert.equal(parts[0].csvDuplicateGroupSize, 2);
  assert.equal(parts[1].isCsvDuplicate, true);
  assert.equal(parts[1].csvDuplicateIndex, 2);
  assert.equal(parts[1].csvDuplicateGroupSize, 2);
});

test('1.2.11 H1 detectCsvDuplicates — 3 grupos mezclados, conteos correctos', () => {
  const H = loadHelpers();
  const parts = [
    { pn: 'A', customerId: 1 },         // grupo A/1: 3 filas
    { pn: 'B', customerId: 1 },         // grupo B/1: 1 fila (unique)
    { pn: 'A', customerId: 1 },
    { pn: 'C', customerId: 2 },         // grupo C/2: 2 filas
    { pn: 'A', customerId: 1 },
    { pn: 'C', customerId: 2 },
    { pn: 'B', customerId: 2 },         // grupo B/2: 1 fila (unique, distinto cliente)
  ];
  const { dupGroups, dupRows } = H.detectCsvDuplicates(parts);
  assert.equal(dupGroups, 2); // A/1 y C/2
  assert.equal(dupRows, (3 - 1) + (2 - 1)); // 3 filas extra
  // A/1 → 3 filas, todas marcadas
  assert.equal(parts[0].csvDuplicateGroupSize, 3);
  assert.equal(parts[2].csvDuplicateGroupSize, 3);
  assert.equal(parts[4].csvDuplicateGroupSize, 3);
  assert.equal(parts[0].csvDuplicateIndex, 1);
  assert.equal(parts[2].csvDuplicateIndex, 2);
  assert.equal(parts[4].csvDuplicateIndex, 3);
  // C/2 → 2 filas, ambas marcadas
  assert.equal(parts[3].csvDuplicateGroupSize, 2);
  assert.equal(parts[5].csvDuplicateGroupSize, 2);
  // B/1 y B/2 quedan limpias
  assert.equal(!!parts[1].isCsvDuplicate, false);
  assert.equal(!!parts[6].isCsvDuplicate, false);
});

test('1.2.11 H1 detectCsvDuplicates — case-insensitive del nombre', () => {
  const H = loadHelpers();
  const parts = [
    { pn: 'abc-123', customerId: 7 },
    { pn: 'ABC-123', customerId: 7 },
    { pn: 'AbC-123', customerId: 7 },
  ];
  const { dupGroups, dupRows } = H.detectCsvDuplicates(parts);
  assert.equal(dupGroups, 1);
  assert.equal(dupRows, 2);
  for (const p of parts) {
    assert.equal(p.isCsvDuplicate, true);
    assert.equal(p.csvDuplicateGroupSize, 3);
  }
});

test('1.2.11 H1 detectCsvDuplicates — ignora filas sin pn o sin customerId', () => {
  const H = loadHelpers();
  const parts = [
    { pn: '', customerId: 7 },
    { pn: null, customerId: 7 },
    { pn: 'A-001', customerId: null },
    { pn: 'A-001', customerId: undefined },
    { pn: 'A-001', customerId: 7 }, // este solo no aparea con nada → unique
  ];
  const { dupGroups, dupRows } = H.detectCsvDuplicates(parts);
  assert.equal(dupGroups, 0);
  assert.equal(dupRows, 0);
});

test('1.2.11 H2 — Map<rowIdx,...> no colapsa duplicados aunque compartan (name, customerId)', () => {
  // Modelo simplificado del refactor H2: lo crítico es que la clave de los
  // maps `newPnIds` y `pnLookup` sea el origIdx (índice en parts[]) y NO
  // `${name}|${customerId}`. Tests previos a 1.2.11 perdían silenciosamente
  // la última escritura cuando dos filas compartían (name, cust).
  const parts = [
    { pn: 'A', customerId: 7 },
    { pn: 'A', customerId: 7 },
    { pn: 'B', customerId: 7 },
  ];
  // Simula creación: cada fila tiene su pn.id distinto en Steelhead
  const createdIds = [1001, 1002, 1003];
  const newPnIds = new Map();
  for (let i = 0; i < parts.length; i++) {
    newPnIds.set(i, createdIds[i]);
  }
  // Las dos filas duplicadas se preservan con su propio id
  assert.equal(newPnIds.get(0), 1001);
  assert.equal(newPnIds.get(1), 1002);
  assert.equal(newPnIds.get(2), 1003);
  assert.equal(newPnIds.size, 3, 'Map por rowIdx no debe colapsar duplicados');

  // pnLookup paralelo: misma key strategy
  const pnLookup = new Map();
  for (let i = 0; i < parts.length; i++) {
    pnLookup.set(i, { pnId: createdIds[i], rowIdx: i });
  }
  assert.equal(pnLookup.size, 3);
  // Cada fila resuelve a su propio pn.id (no last-write-wins de las duplicadas)
  assert.equal(pnLookup.get(0).pnId, 1001);
  assert.equal(pnLookup.get(1).pnId, 1002);
  assert.equal(pnLookup.get(2).pnId, 1003);
});

test('1.2.11 H2 contraste — Map<"name|cust",...> SÍ colapsa (el bug que arreglamos)', () => {
  // Test de regresión: documentar el comportamiento ANTERIOR para que si
  // alguien futuro vuelve a usar la key compuesta vea por qué falla.
  const parts = [
    { pn: 'A', customerId: 7 },
    { pn: 'A', customerId: 7 },
    { pn: 'B', customerId: 7 },
  ];
  const createdIds = [1001, 1002, 1003];
  const buggyMap = new Map();
  for (let i = 0; i < parts.length; i++) {
    const key = `${String(parts[i].pn).toUpperCase()}|${parts[i].customerId}`;
    buggyMap.set(key, createdIds[i]);
  }
  // Esto es lo que rompía pnLookup en 1.2.10: last-write-wins, las dos filas
  // duplicadas terminan apuntando al mismo id (1002), y la fila 0 (1001)
  // se pierde del map → SaveManyPNP / SaveQuoteLines no la encuentran.
  assert.equal(buggyMap.size, 2);
  assert.equal(buggyMap.get('A|7'), 1002, 'last-write-wins: fila 0 (1001) se perdió');
  assert.equal(buggyMap.get('B|7'), 1003);
});

test('1.2.11 H5 — flags isCsvDuplicate/Index/GroupSize están en el shape esperado por la UI', () => {
  // El preview lee r.isCsvDuplicate, r.csvDuplicateIndex y r.csvDuplicateGroupSize
  // para renderear el chip "🔄 DUP n/m". Aseguramos que detectCsvDuplicates
  // los popula con tipos correctos (boolean / number / number) para que el
  // template de chip los pueda interpolar sin coerciones implícitas.
  const H = loadHelpers();
  const parts = [
    { pn: 'X', customerId: 1 },
    { pn: 'X', customerId: 1 },
  ];
  H.detectCsvDuplicates(parts);
  assert.equal(typeof parts[0].isCsvDuplicate, 'boolean');
  assert.equal(typeof parts[0].csvDuplicateIndex, 'number');
  assert.equal(typeof parts[0].csvDuplicateGroupSize, 'number');
  assert.ok(parts[0].csvDuplicateIndex >= 1);
  assert.ok(parts[0].csvDuplicateGroupSize >= 2);
});

// ── 1.2.12: Pase 1/2 ven archivados (opción B) ──

test('1.2.12 Pase 1 IBMS — matchea PN archivado → MODIFY con wasArchived=true y suffix -desarchiva', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1', archivedAt: '2026-05-20T10:00:00Z' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.wasArchived, true);
  assert.equal(r.confidence, 'ibms-exacto-desarchiva');
});

test('1.2.12 Pase 2 composite — matchea PN archivado → MODIFY con wasArchived=true y suffix -desarchiva', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '', archivedAt: '2026-05-20T10:00:00Z' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 2);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.wasArchived, true);
  assert.ok(r.confidence.endsWith('-desarchiva'));
});

test('1.2.12 Pase 1 — IBMS match con PN activo no marca wasArchived', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' /* sin archivedAt */ },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.pase, 1);
  assert.equal(r.wasArchived, false);
  assert.equal(r.confidence, 'ibms-exacto');
});

test('1.5.21 Pase 3 — archivados SÍ se consideran candidatos (revierte 1.2.12; se matchean para no duplicar)', () => {
  const H = loadHelpers();
  // mismo name y labels pero distinto metalBase → Pase 3 (no composite).
  // 1.5.21 cambió la política de 1.2.12: los archivados YA NO se ignoran; se
  // matchean en todos los pases (MODIFY para desarchivar) para no crear duplicados.
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: '' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'AL', labels: ['NIQ'], quoteIBMS: '', archivedAt: '2026-05-20T10:00:00Z' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'MODIFY');
  assert.equal(r.pase, 3);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.wasArchived, true);
});

test('1.2.12 Pase 1 vs Pase 3 — IBMS archivado gana sobre name+labels activo (regresión loop auto-archive)', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1' };
  const pnsForCustomer = [
    { id: 100, name: 'A-LEGACY', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q1', archivedAt: '2026-05-20T10:00:00Z' }, // archivado pero IBMS coincide
    { id: 101, name: 'A', metalBase: 'CU', labels: ['NIQ'], quoteIBMS: 'Q2' }, // activo pero IBMS distinto
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  // Pase 1 IBMS gana sobre cualquier otro; el archivado se desarchiva en STEP 8
  assert.equal(r.pase, 1);
  assert.equal(r.targetPnId, 100);
  assert.equal(r.wasArchived, true);
});

// === 1.3.0 chunking helpers ===

test('1.3.0 chunkParts — array vacío devuelve []', () => {
  const H = loadHelpers();
  const r = H.chunkParts([], 250);
  assert.equal(r.length, 0);
});

test('1.3.0 chunkParts — array más chico que chunkSize devuelve un solo chunk', () => {
  const H = loadHelpers();
  const r = H.chunkParts([1, 2, 3], 250);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], [1, 2, 3]);
});

test('1.3.0 chunkParts — 251 elementos con chunkSize 250 devuelve [250, 1]', () => {
  const H = loadHelpers();
  const arr = Array.from({ length: 251 }, (_, i) => i + 1);
  const r = H.chunkParts(arr, 250);
  assert.equal(r.length, 2);
  assert.equal(r[0].length, 250);
  assert.equal(r[1].length, 1);
  assert.equal(r[1][0], 251);
});

test('1.3.0 chunkParts — 500 elementos con chunkSize 250 devuelve 2 chunks de 250', () => {
  const H = loadHelpers();
  const arr = Array.from({ length: 500 }, (_, i) => i + 1);
  const r = H.chunkParts(arr, 250);
  assert.equal(r.length, 2);
  assert.equal(r[0].length, 250);
  assert.equal(r[1].length, 250);
  assert.equal(r[0][0], 1);
  assert.equal(r[1][0], 251);
});

test('1.3.0 chunkParts — chunkSize 0 o inválido defaultea a 1', () => {
  const H = loadHelpers();
  assert.equal(H.chunkParts([1, 2, 3], 0).length, 3);
  assert.equal(H.chunkParts([1, 2, 3], -5).length, 3);
  assert.equal(H.chunkParts([1, 2, 3], NaN).length, 3);
});

test('1.3.0 makeChunkQuoteName — un solo chunk no agrega sufijo', () => {
  const H = loadHelpers();
  assert.equal(H.makeChunkQuoteName('MyQuote', 0, 1), 'MyQuote');
});

test('1.3.0 makeChunkQuoteName — múltiples chunks padStart 2 dígitos', () => {
  const H = loadHelpers();
  assert.equal(H.makeChunkQuoteName('MyQuote', 0, 5), 'MyQuote 01');
  assert.equal(H.makeChunkQuoteName('MyQuote', 4, 5), 'MyQuote 05');
  assert.equal(H.makeChunkQuoteName('MyQuote', 9, 100), 'MyQuote 10');
});

test('1.3.0 makeChunkQuoteName — >99 chunks devuelve 3 dígitos sin truncar', () => {
  const H = loadHelpers();
  assert.equal(H.makeChunkQuoteName('MyQuote', 99, 100), 'MyQuote 100');
  assert.equal(H.makeChunkQuoteName('MyQuote', 999, 1000), 'MyQuote 1000');
});
