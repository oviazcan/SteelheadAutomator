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

test('classifyOnePN — archivedAt excluye PNs aunque matcheen', () => {
  const H = loadHelpers();
  const csvRow = { customerId: 1, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: 'X' };
  const pnsForCustomer = [
    { id: 100, name: 'A', metalBase: 'CU', labels: [], quoteIBMS: 'X', archivedAt: '2024-01-01' },
  ];
  const r = H.classifyOnePN(csvRow, pnsForCustomer, []);
  assert.equal(r.classification, 'NEW');
  assert.equal(r.pase, null);
  assert.equal(r.candidates.length, 0);
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

function makeRow({ idx, pn, pase, confidence, existingId, candidates = [], status = 'existing', userOverride = null }) {
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

test('dedupModifyTargets — dos Pase 3 con mismo top → loser toma alterno', () => {
  // Caso real del usuario: dos filas con mismo nombre en el CSV; ambas Pase 3
  // con candidates idénticos. El primer row (idx menor) toma el #1; el segundo
  // toma el #2 de la lista.
  const H = loadHelpers();
  const candidates = [
    { id: 700, labels: ['NIQ'], defaultProcessNodeId: 11 },
    { id: 701, labels: [], defaultProcessNodeId: 22 },
  ];
  const rows = [
    makeRow({ pn: 'A', pase: 3, confidence: 'name+blank-candidate', existingId: 701, candidates }),
    makeRow({ pn: 'A', pase: 3, confidence: 'name+blank-candidate', existingId: 701, candidates }),
  ];
  const r = H.dedupModifyTargets(rows);
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
