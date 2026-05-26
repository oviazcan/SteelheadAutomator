// tools/test/duplicate-tiers.test.js
// Carga remote/scripts/duplicate-tiers.js en un vm con stub window y extrae
// window.SADuplicateTiers para testear funciones puras.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'duplicate-tiers.js');

function loadModule() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'duplicate-tiers.js' });
  if (!sandbox.window.SADuplicateTiers) {
    throw new Error('window.SADuplicateTiers no fue exportado');
  }
  return sandbox.window.SADuplicateTiers;
}

test('harness boots and exports SADuplicateTiers', () => {
  const M = loadModule();
  assert.equal(typeof M, 'object');
  assert.equal(typeof M.hardBuckets, 'function');
  assert.equal(typeof M.scoreFor, 'function');
});

const NON_FINISH = ['SMY', 'STX', 'SXC', 'SRG', 'SCM', 'SQR', 'SQ2', 'NP desconocido', 'En desarrollo', 'Muestras', 'Lote', 'Obsoleto'];

test('isNonFinishLabel: matchea exact case-sensitive', () => {
  const M = loadModule();
  assert.equal(M.isNonFinishLabel('SMY', NON_FINISH), true);
  assert.equal(M.isNonFinishLabel('NP desconocido', NON_FINISH), true);
  assert.equal(M.isNonFinishLabel('NIQ', NON_FINISH), false);
  assert.equal(M.isNonFinishLabel('smy', NON_FINISH), false); // case-sensitive
  assert.equal(M.isNonFinishLabel('', NON_FINISH), false);
  assert.equal(M.isNonFinishLabel(null, NON_FINISH), false);
  assert.equal(M.isNonFinishLabel(undefined, NON_FINISH), false);
});

test('canonicalFinishings: filtra nonFinish, deduplica, ordena ASC, joinea con |', () => {
  const M = loadModule();
  assert.equal(M.canonicalFinishings(['NIQ', 'EST', 'SMY'], NON_FINISH), 'EST|NIQ');
  assert.equal(M.canonicalFinishings(['SMY', 'STX'], NON_FINISH), ''); // todos nonFinish
  assert.equal(M.canonicalFinishings([], NON_FINISH), '');
  assert.equal(M.canonicalFinishings(['CROMADO'], NON_FINISH), 'CROMADO');
  assert.equal(M.canonicalFinishings(['NIQ', 'NIQ', 'EST'], NON_FINISH), 'EST|NIQ'); // dedup
  assert.equal(M.canonicalFinishings(['NIQ', null, '', 'EST'], NON_FINISH), 'EST|NIQ');
});

const METAL_EQUIV = [
  ['Estaño', 'Estaño s/Aluminio', 'Estaño s/Cobre'],
  ['Plata', 'Plata Flash'],
];

test('canonicalMetal: colapsa equivalentes al primero del grupo', () => {
  const M = loadModule();
  assert.equal(M.canonicalMetal('Estaño s/Aluminio', METAL_EQUIV), 'Estaño');
  assert.equal(M.canonicalMetal('Estaño s/Cobre', METAL_EQUIV), 'Estaño');
  assert.equal(M.canonicalMetal('Plata Flash', METAL_EQUIV), 'Plata');
  assert.equal(M.canonicalMetal('Cobre', METAL_EQUIV), 'Cobre'); // no en ningún grupo
  assert.equal(M.canonicalMetal('', METAL_EQUIV), '');
  assert.equal(M.canonicalMetal(null, METAL_EQUIV), '');
  assert.equal(M.canonicalMetal('Estaño', []), 'Estaño'); // sin equivalents
});

// Fixtures
function pnEmpty() {
  return { id: 1, name: 'PN-1', customerId: 100, createdAt: '2026-01-01T00:00:00Z', customInputs: {} };
}
function detailsEmpty() {
  return {
    defaultProcessNodeId: null,
    partNumberSpecsByPartNumberId: { nodes: [] },
    partNumberRackTypesByPartNumberId: { nodes: [] },
    inventoryPredictedUsagesByPartNumberId: { nodes: [] },
    inventoryItemByPartNumberId: { inventoryItemUnitConversionsByInventoryItemId: { nodes: [] } },
    descriptionMarkdown: '',
    partNumberGroupId: null,
    dimensionCustomValueIds: [],
    partNumberPricesByPartNumberId: { nodes: [] },
    customInputs: {},
    partNumberLabelsByPartNumberId: { nodes: [] },
  };
}

test('scoreFor: PN totalmente vacío puntúa 0', () => {
  const M = loadModule();
  assert.equal(M.scoreFor(pnEmpty(), detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 0);
});

test('scoreFor: hasProcess vale 5', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.defaultProcessNodeId = 'proc-1';
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 5);
});

test('scoreFor: specsCount > 0 vale 5 baseline + 1 por spec', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.partNumberSpecsByPartNumberId.nodes = [{}, {}, {}]; // 3 specs
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 5 + 3);
});

test('scoreFor: hasQuoteIBMS vale 2', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { QuoteIBMS: '84531' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: hasQuoteIBMS string vacío NO suma', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { QuoteIBMS: '' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 0);
});

test('scoreFor: hasDefaultPrice vale 2', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.partNumberPricesByPartNumberId.nodes = [{ isDefault: false }, { isDefault: true }];
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: hasNotasAdicionalesIBMS vale 2', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { NotasAdicionales: 'Texto largo de IBMS' };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: finishingsCount filtra nonFinish y suma 1 por finishing', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.partNumberLabelsByPartNumberId.nodes = [
    { labelByLabelId: { name: 'NIQ' } },
    { labelByLabelId: { name: 'EST' } },
    { labelByLabelId: { name: 'SMY' } }, // nonFinish, no cuenta
  ];
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 2);
});

test('scoreFor: hasMetalBase vale 1', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { BaseMetal: 'Cobre' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 1);
});

test('scoreFor: hasSat vale 1', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosFacturacion: { CodigoSAT: '25171802' } };
  assert.equal(M.scoreFor(pn, detailsEmpty(), { nonFinishLabelNames: NON_FINISH }), 1);
});

test('scoreFor: hasDescription, hasGroup, racks/predictives/unitConversions/dimCustomValues cuentan', () => {
  const M = loadModule();
  const d = detailsEmpty();
  d.descriptionMarkdown = '  Algo  ';
  d.partNumberGroupId = 'g-1';
  d.partNumberRackTypesByPartNumberId.nodes = [{}];
  d.inventoryPredictedUsagesByPartNumberId.nodes = [{}, {}];
  d.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes = [{}];
  d.dimensionCustomValueIds = ['lin-1', 'lin-2'];
  // 1 desc + 1 group + 1 rack + 2 predict + 1 uc + 2 dim = 8
  assert.equal(M.scoreFor(pnEmpty(), d, { nonFinishLabelNames: NON_FINISH }), 8);
});

test('scoreFor: PN enriquecido completo puntúa ~30+', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = {
    DatosAdicionalesNP: { QuoteIBMS: '84531', BaseMetal: 'Cobre' },
    DatosFacturacion: { CodigoSAT: '25171802' },
    NotasAdicionales: 'IBMS',
  };
  const d = detailsEmpty();
  d.defaultProcessNodeId = 'proc-1';
  d.partNumberSpecsByPartNumberId.nodes = [{}, {}];
  d.partNumberRackTypesByPartNumberId.nodes = [{}];
  d.inventoryPredictedUsagesByPartNumberId.nodes = [{}];
  d.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes = [{}, {}];
  d.partNumberPricesByPartNumberId.nodes = [{ isDefault: true }];
  d.descriptionMarkdown = 'desc';
  d.partNumberGroupId = 'g-1';
  d.dimensionCustomValueIds = ['lin-1'];
  d.partNumberLabelsByPartNumberId.nodes = [{ labelByLabelId: { name: 'NIQ' } }, { labelByLabelId: { name: 'EST' } }];
  // 5 proc + 5 specs(baseline) + 2 specs(count) + 2 quoteibms + 2 defaultPrice + 2 notas
  // + 2 finishings + 1 racks + 1 predict + 2 uc + 1 dim + 1 desc + 1 group + 1 metal + 1 sat
  // = 29
  assert.equal(M.scoreFor(pn, d, { nonFinishLabelNames: NON_FINISH }), 29);
});

test('scoreFor: tolera details null (score parcial con solo AllPartNumbers data)', () => {
  const M = loadModule();
  const pn = pnEmpty();
  pn.customInputs = { DatosAdicionalesNP: { QuoteIBMS: '84531' }, NotasAdicionales: 'IBMS' };
  pn.labels = ['NIQ', 'EST']; // viene de AllPartNumbers
  // Sin details: solo 2 + 2 + 2 finishings = 6
  assert.equal(M.scoreFor(pn, null, { nonFinishLabelNames: NON_FINISH }), 6);
});

test('pickWinner: gana el de mayor score', () => {
  const M = loadModule();
  const bucket = {
    members: [
      { id: 10, score: 5, createdAt: '2026-01-01T00:00:00Z' },
      { id: 20, score: 8, createdAt: '2026-01-01T00:00:00Z' },
      { id: 30, score: 3, createdAt: '2026-01-01T00:00:00Z' },
    ],
  };
  assert.equal(M.pickWinner(bucket), 20);
});

test('pickWinner: tiebreak por createdAt más reciente', () => {
  const M = loadModule();
  const bucket = {
    members: [
      { id: 10, score: 5, createdAt: '2026-01-01T00:00:00Z' },
      { id: 20, score: 5, createdAt: '2026-05-01T00:00:00Z' }, // más reciente
      { id: 30, score: 5, createdAt: '2026-03-01T00:00:00Z' },
    ],
  };
  assert.equal(M.pickWinner(bucket), 20);
});

test('pickWinner: tiebreak final por id mayor (más reciente)', () => {
  const M = loadModule();
  const bucket = {
    members: [
      { id: 10, score: 5, createdAt: '2026-05-01T00:00:00Z' },
      { id: 99, score: 5, createdAt: '2026-05-01T00:00:00Z' },
      { id: 50, score: 5, createdAt: '2026-05-01T00:00:00Z' },
    ],
  };
  assert.equal(M.pickWinner(bucket), 99);
});

test('pickWinner: bucket con un solo miembro retorna ese id', () => {
  const M = loadModule();
  assert.equal(M.pickWinner({ members: [{ id: 7, score: 0, createdAt: '2026-01-01' }] }), 7);
});

test('pickWinner: bucket vacío retorna null', () => {
  const M = loadModule();
  assert.equal(M.pickWinner({ members: [] }), null);
});

function pnWith({ id, customerId, name, quoteIBMS, baseMetal, labels, createdAt }) {
  return {
    id,
    name: name || 'PN-X',
    customerByCustomerId: customerId != null ? { id: customerId, name: 'Cust-' + customerId } : null,
    customerId,
    createdAt: createdAt || '2026-01-01T00:00:00Z',
    customInputs: { DatosAdicionalesNP: { QuoteIBMS: quoteIBMS || '', BaseMetal: baseMetal || '' } },
    partNumberLabelsByPartNumberId: { nodes: (labels || []).map(n => ({ labelByLabelId: { name: n } })) },
  };
}

test('hardBuckets: agrupa por QuoteIBMS no vacío, ignora vacíos', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' }),
    pnWith({ id: 2, customerId: 100, quoteIBMS: '84531' }),
    pnWith({ id: 3, customerId: 100, quoteIBMS: '99999' }), // single
    pnWith({ id: 4, customerId: 100, quoteIBMS: '' }),       // empty -> ignored
    pnWith({ id: 5, customerId: 100 }),                       // null -> ignored
  ];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].quoteIBMS, '84531');
  const ids = buckets[0].members.map(m => m.id).sort();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], 1);
  assert.equal(ids[1], 2);
});

test('hardBuckets: cross-customer agrupa', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' }),
    pnWith({ id: 2, customerId: 200, quoteIBMS: '84531' }), // distinto cliente
  ];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].members.length, 2);
});

test('hardBuckets: bucket de 1 miembro NO se reporta', () => {
  const M = loadModule();
  const pns = [pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' })];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 0);
});

test('hardBuckets: maneja customInputs como string JSON', () => {
  const M = loadModule();
  const pn = pnWith({ id: 1, customerId: 100, quoteIBMS: '84531' });
  pn.customInputs = JSON.stringify(pn.customInputs); // string en vez de objeto
  const pns = [pn, pnWith({ id: 2, customerId: 100, quoteIBMS: '84531' })];
  const buckets = M.hardBuckets(pns);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].members.length, 2);
});

test('hardBuckets: QuoteIBMS whitespace-only se ignora', () => {
  const M = loadModule();
  const pns = [
    pnWith({ id: 1, customerId: 100, quoteIBMS: '   ' }),
    pnWith({ id: 2, customerId: 100, quoteIBMS: '   ' }),
  ];
  assert.equal(M.hardBuckets(pns).length, 0);
});

module.exports = { loadModule, pnWith };
