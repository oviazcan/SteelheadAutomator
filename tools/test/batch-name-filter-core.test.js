// tools/test/batch-name-filter-core.test.js
// Golden tests del módulo puro "Filtrar Lote por Nombre".
// Run: node --test tools/test/batch-name-filter-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/batch-name-filter-core.js');

// Fixture REAL: tableFilterSearch de FilterSearch({key:'inventoryBatchIdFilter', searchQuery:'T-125'})
// capturado en vivo 2026-07-21 (Ecoplating TLC dom 344). 10 items, todos name "T-125".
const T125_ITEMS = [
  { display: '15326T-125 (80247-566-01)', identifier: '1412144' },
  { display: '15325T-125 (SWB-00496773)', identifier: '1412143' },
  { display: '16394T-125 (SWB-00496189)', identifier: '1422384' },
  { display: '16393T-125 (SWB-00496202)', identifier: '1422383' },
  { display: '15355T-125 (80247-572-16)', identifier: '1412290' },
  { display: '15354T-125 (SWB-00496344)', identifier: '1412289' },
  { display: '15335T-125 (SWB-00386105)', identifier: '1412153' },
  { display: '15334T-125 (SWB-00496193)', identifier: '1412152' },
  { display: '15333T-125 (80255-147-01)', identifier: '1412151' },
  { display: '15332T-125 (80255-144-01)', identifier: '1412150' },
];

// ---------- stripPnSuffix ----------

test('stripPnSuffix: quita el sufijo " (pn)" y deja idInDomain+name', () => {
  assert.equal(Core.stripPnSuffix('15326T-125 (80247-566-01)'), '15326T-125');
  assert.equal(Core.stripPnSuffix('16511487577 (48121-190-08)'), '16511487577');
});

test('stripPnSuffix: sin paréntesis lo deja igual', () => {
  assert.equal(Core.stripPnSuffix('15326T-125'), '15326T-125');
});

// ---------- matchesExactName: caso alfanumérico (T-125) ----------

test('matchesExactName: "T-125" matchea los displays reales de T-125', () => {
  for (const it of T125_ITEMS) {
    assert.equal(Core.matchesExactName(it.display, 'T-125'), true, it.display);
  }
});

test('matchesExactName: "T-125" NO matchea un superstring "T-1250"', () => {
  assert.equal(Core.matchesExactName('99999T-1250 (PN-1)', 'T-125'), false);
});

test('matchesExactName: "T-125" NO matchea "T-1256" ni "XT-125"', () => {
  assert.equal(Core.matchesExactName('12345T-1256 (PN)', 'T-125'), false);
  assert.equal(Core.matchesExactName('12345XT-125 (PN)', 'T-125'), false);
});

test('matchesExactName: case-insensitive (t-125 == T-125)', () => {
  assert.equal(Core.matchesExactName('15326T-125 (PN)', 't-125'), true);
});

test('matchesExactName: tolera espacios alrededor del nombre tecleado', () => {
  assert.equal(Core.matchesExactName('15326T-125 (PN)', '  T-125  '), true);
});

// ---------- matchesExactName: caso NUMÉRICO (el motivo por el que A no servía) ----------

test('matchesExactName: name numérico "487577" matchea "16511487577 (pn)"', () => {
  assert.equal(Core.matchesExactName('16511487577 (48121-190-08)', '487577'), true);
});

test('matchesExactName: LIMITACIÓN documentada — nombre numérico puede colisionar como sufijo', () => {
  // Como el display concatena idInDomain+name sin separador y no conocemos el boundary,
  // buscar "87577" trae un lote cuyo name REAL es "487577" (…487577 termina en 87577).
  // Colisión residual improbable con datos reales; el glue la mitiga con el preview de
  // confirmación. Se afirma como comportamiento ESPERADO (no bug) para que quede visible.
  assert.equal(Core.matchesExactName('16511487577 (pn)', '87577'), true);
  // Un display cuyo combinado NO termina en el nombre pedido sí queda fuera:
  assert.equal(Core.matchesExactName('16511487576 (pn)', '87577'), false);
});

test('matchesExactName: requiere al menos un dígito de idInDomain antes del nombre', () => {
  assert.equal(Core.matchesExactName('T-125 (pn)', 'T-125'), false); // sin idInDomain numérico
});

test('matchesExactName: nombre vacío nunca matchea', () => {
  assert.equal(Core.matchesExactName('15326T-125 (pn)', ''), false);
  assert.equal(Core.matchesExactName('15326T-125 (pn)', '   '), false);
});

// ---------- selectExactMatches ----------

test('selectExactMatches: los 10 T-125 reales → 10 ids, atLimit=true (tope de FilterSearch)', () => {
  const r = Core.selectExactMatches(T125_ITEMS, 'T-125');
  assert.equal(r.count, 10);
  assert.equal(r.atLimit, true);
  assert.deepEqual(r.ids, [
    '1412144', '1412143', '1422384', '1422383', '1412290',
    '1412289', '1412153', '1412152', '1412151', '1412150',
  ]);
});

test('selectExactMatches: excluye superstrings mezclados en la lista', () => {
  const mixed = [
    { display: '15326T-125 (a)', identifier: '1' },
    { display: '15327T-1250 (b)', identifier: '2' }, // superstring → fuera
    { display: '15328T-125 (c)', identifier: '3' },
  ];
  const r = Core.selectExactMatches(mixed, 'T-125');
  assert.deepEqual(r.ids, ['1', '3']);
  assert.equal(r.atLimit, false); // 3 items < 10
});

test('selectExactMatches: dedup de identifiers repetidos', () => {
  const dup = [
    { display: '15326T-125 (a)', identifier: '1' },
    { display: '15326T-125 (a)', identifier: '1' },
  ];
  assert.deepEqual(Core.selectExactMatches(dup, 'T-125').ids, ['1']);
});

test('selectExactMatches: entrada no-array → vacío seguro', () => {
  const r = Core.selectExactMatches(null, 'T-125');
  assert.deepEqual(r.ids, []);
  assert.equal(r.atLimit, false);
});

// ---------- parseInventoryBatchIdFilter ----------

test('parseInventoryBatchIdFilter: lee los ids del parámetro', () => {
  const url = 'https://app.gosteelhead.com/Domains/344/Shipping?inventoryBatchIdFilter=1412144,1412143&offset=0';
  assert.deepEqual(Core.parseInventoryBatchIdFilter(url), ['1412144', '1412143']);
});

test('parseInventoryBatchIdFilter: sin parámetro → vacío', () => {
  assert.deepEqual(Core.parseInventoryBatchIdFilter('https://app.gosteelhead.com/Domains/344/Shipping'), []);
});

// ---------- buildFilterUrl ----------

const BASE = 'https://app.gosteelhead.com/Domains/344/Shipping';

test('buildFilterUrl: replace (default) deja solo los nuevos ids + offset=0', () => {
  const out = Core.buildFilterUrl(BASE + '?inventoryBatchIdFilter=999&offset=40', ['1412144', '1412143']);
  const u = new URL(out);
  assert.equal(u.searchParams.get('inventoryBatchIdFilter'), '1412144,1412143');
  assert.equal(u.searchParams.get('offset'), '0');
});

test('buildFilterUrl: append hace unión con lo ya filtrado (sin duplicar)', () => {
  const out = Core.buildFilterUrl(BASE + '?inventoryBatchIdFilter=999,1412144&offset=0', ['1412144', '1412143'], 'append');
  const u = new URL(out);
  assert.equal(u.searchParams.get('inventoryBatchIdFilter'), '999,1412144,1412143');
});

test('buildFilterUrl: usa coma literal (no %2C)', () => {
  const out = Core.buildFilterUrl(BASE, ['1412144', '1412143']);
  assert.ok(out.includes('1412144,1412143'), out);
  assert.ok(!/%2C/i.test(out), out);
});

test('buildFilterUrl: sin ids → borra el parámetro', () => {
  const out = Core.buildFilterUrl(BASE + '?inventoryBatchIdFilter=999&offset=0', []);
  assert.equal(new URL(out).searchParams.get('inventoryBatchIdFilter'), null);
});

test('buildFilterUrl: preserva otros parámetros del query', () => {
  const out = Core.buildFilterUrl(BASE + '?foo=bar&offset=20', ['1']);
  const u = new URL(out);
  assert.equal(u.searchParams.get('foo'), 'bar');
  assert.equal(u.searchParams.get('offset'), '0');
});

// ---------- buildClearUrl ----------

test('buildClearUrl: quita el filtro de lote y resetea offset', () => {
  const out = Core.buildClearUrl(BASE + '?inventoryBatchIdFilter=1,2,3&offset=10&foo=bar');
  const u = new URL(out);
  assert.equal(u.searchParams.get('inventoryBatchIdFilter'), null);
  assert.equal(u.searchParams.get('offset'), '0');
  assert.equal(u.searchParams.get('foo'), 'bar');
});

// ---------- isShippingUrl (gate) ----------

test('isShippingUrl: acepta el Panel de Envío (con y sin query)', () => {
  assert.equal(Core.isShippingUrl('/Domains/344/Shipping'), true);
  assert.equal(Core.isShippingUrl('/Domains/344/Shipping?inventoryBatchIdFilter=1'), true);
  assert.equal(Core.isShippingUrl('/Domains/1/Shipping/'), true);
});

test('isShippingUrl: rechaza /Shipping/PackingSlips (ese es de invoice-autofill) y otras', () => {
  assert.equal(Core.isShippingUrl('/Domains/344/Shipping/PackingSlips'), false);
  assert.equal(Core.isShippingUrl('/Domains/344/PartNumbers'), false);
  assert.equal(Core.isShippingUrl('/Domains/344/ShippingFoo'), false);
});

// ---------- selectByExactName (fuente InventoryBatchViewQuery — name estructurado) ----------

// Fixture REAL: pagedData.nodes de InventoryBatchViewQuery(searchQuery:'T-125', hideCompleted:false)
// capturado en vivo 2026-07-22 → 18 lotes T-125 (FilterSearch solo daba 10 = supera el tope).
const IBV_T125 = [
  1422384, 1422383, 1412290, 1412289, 1412143, 1412153, 1412152, 1412151, 1412150,
  1412149, 1412148, 1412147, 1412146, 1412145, 1412142, 1412141, 1412140, 1397259,
].map((id, i) => ({ id, idInDomain: 16000 + i, name: 'T-125' }));

test('selectByExactName: 18 lotes T-125 reales → 18 ids (supera el tope de 10 de FilterSearch)', () => {
  const r = Core.selectByExactName(IBV_T125, 'T-125');
  assert.equal(r.count, 18);
  assert.deepEqual(r.ids, IBV_T125.map((n) => String(n.id)));
});

test('selectByExactName: name estructurado excluye superstrings y otros names (case-insensitive)', () => {
  const nodes = [
    { id: 1, idInDomain: 1, name: 'T-125' },
    { id: 2, idInDomain: 2, name: 'T-1250' },   // superstring → fuera
    { id: 3, idInDomain: 3, name: '210726' },   // otro → fuera
    { id: 4, idInDomain: 4, name: 't-125' },    // case-insensitive → dentro
  ];
  assert.deepEqual(Core.selectByExactName(nodes, 'T-125').ids, ['1', '4']);
});

test('selectByExactName: name numérico EXACTO sin colisión (name limpio, no concatenado)', () => {
  const nodes = [
    { id: 10, idInDomain: 100, name: '487577' },
    { id: 11, idInDomain: 101, name: '4875' },     // otro → fuera
    { id: 12, idInDomain: 102, name: '1487577' },  // superstring → fuera
  ];
  assert.deepEqual(Core.selectByExactName(nodes, '487577').ids, ['10']);
});

test('selectByExactName: dedup + entrada no-array + nombre vacío seguros', () => {
  assert.deepEqual(Core.selectByExactName([{ id: 5, name: 'X' }, { id: 5, name: 'X' }], 'X').ids, ['5']);
  assert.deepEqual(Core.selectByExactName(null, 'X').ids, []);
  assert.deepEqual(Core.selectByExactName([{ id: 5, name: 'X' }], '').ids, []);
});

test('normalizeName: trim + lowercase', () => {
  assert.equal(Core.normalizeName('  T-125 '), 't-125');
});
