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

// ═══════════════════════════════════════════════════════════════════════════════
// LOS DOS UNIVERSOS de hideCompleted — semántica REAL medida en vivo 2026-07-29
// (dominio 344, Ecoplating TLC). El bug: el applet solo veía el 4.3% del inventario.
//
//   hideCompleted:true  → SOLO lotes CON material remanente   →    585 lotes
//   hideCompleted:false → SOLO lotes AGOTADOS (remaining = 0) → 12 926 lotes
//   solape medido = 0 · unión = 13 511 = TODO el inventario
//
// El nombre del parámetro MIENTE: `false` no es "no esconder" (superconjunto),
// es el COMPLEMENTO. Buscar solo con `true` esconde 95.7% de los lotes: el
// operador teclea un lote que existe, ve «Sin lotes», y Enter no hace nada.
// ═══════════════════════════════════════════════════════════════════════════════

// Fixture REAL capturado en vivo 2026-07-29: los T-125 que el dropdown NATIVO de
// Steelhead SÍ ofrece (10 de 20) y que el applet devolvía como 0. Todos agotados.
const IBV_T125_REAL_DEPLETED = [
  { id: 1429651, idInDomain: 16630, name: 'T-125', totalRemainingMicroQuantity: '0', createdMicroQuantity: '1000000' },
  { id: 1422384, idInDomain: 16394, name: 'T-125', totalRemainingMicroQuantity: '0', createdMicroQuantity: '1000000' },
  { id: 1422383, idInDomain: 16393, name: 'T-125', totalRemainingMicroQuantity: '0', createdMicroQuantity: '1000000' },
  { id: 1412290, idInDomain: 15355, name: 'T-125', totalRemainingMicroQuantity: '0', createdMicroQuantity: '1000000' },
  { id: 1412289, idInDomain: 15354, name: 'T-125', totalRemainingMicroQuantity: '0', createdMicroQuantity: '2000000' },
  { id: 1412144, idInDomain: 15326, name: 'T-125', totalRemainingMicroQuantity: '0', createdMicroQuantity: '11000000' },
];
// Fixture REAL del universo CON MATERIAL (hideCompleted:true) del mismo día.
const IBV_WITH_MATERIAL = [
  { id: 1449368, idInDomain: 17970, name: 'T-233', totalRemainingMicroQuantity: '25000000', createdMicroQuantity: '25000000' },
  { id: 1452835, idInDomain: 18112, name: '2907202601', totalRemainingMicroQuantity: '25000000', createdMicroQuantity: '25000000' },
];

test('SEARCH_UNIVERSES: se consultan AMBOS universos (true y false), no solo el de material', () => {
  assert.deepEqual(Core.SEARCH_UNIVERSES, [true, false]);
  assert.equal(Core.UNIVERSE_WITH_MATERIAL, true);
  assert.equal(Core.UNIVERSE_DEPLETED, false);
});

test('isDepletedBatch: remaining "0" = agotado; >0 = con material; AUSENTE = null (no se inventa)', () => {
  assert.equal(Core.isDepletedBatch({ totalRemainingMicroQuantity: '0' }), true);
  assert.equal(Core.isDepletedBatch({ totalRemainingMicroQuantity: '25000000' }), false);
  // Fail-safe: campo ausente/null ⇒ DESCONOCIDO, nunca "agotado" por omisión.
  assert.equal(Core.isDepletedBatch({}), null);
  assert.equal(Core.isDepletedBatch({ totalRemainingMicroQuantity: null }), null);
  assert.equal(Core.isDepletedBatch(null), null);
});

test('REGRESIÓN DEL BUG: los T-125 REALES (todos agotados) devuelven ids, NO cero', () => {
  const r = Core.selectByExactName(IBV_T125_REAL_DEPLETED, 'T-125');
  assert.equal(r.count, 6, 'el operador ve lotes, no «Sin lotes»');
  assert.equal(r.ids.length, 6, 'Enter tiene ids que aplicar');
});

test('selectByExactName: separa CON MATERIAL de AGOTADOS para que el preview diga la verdad', () => {
  const mixed = [...IBV_T125_REAL_DEPLETED.slice(0, 2), { id: 999, idInDomain: 1, name: 'T-125', totalRemainingMicroQuantity: '5000000' }];
  const r = Core.selectByExactName(mixed, 'T-125');
  assert.equal(r.count, 3);
  assert.deepEqual(r.withMaterial.ids, ['999']);
  assert.equal(r.withMaterial.count, 1);
  assert.deepEqual(r.depleted.ids, ['1429651', '1422384']);
  assert.equal(r.depleted.count, 2);
});

test('selectByExactName: universo con material se clasifica entero, sin agotados', () => {
  const r = Core.selectByExactName(IBV_WITH_MATERIAL, 'T-233');
  assert.equal(r.count, 1);
  assert.equal(r.withMaterial.count, 1);
  assert.equal(r.depleted.count, 0);
});

test('selectByExactName: nodos sin el campo caen en unknown (compat con fixtures viejos)', () => {
  const r = Core.selectByExactName(IBV_T125, 'T-125'); // fixture 2026-07-22, sin remaining
  assert.equal(r.count, 18, 'siguen contando para aplicar');
  assert.equal(r.unknown.count, 18);
  assert.equal(r.depleted.count, 0, 'ausente NO es agotado');
});

test('el aviso de «todos vacíos» YA NO existe: vacío es la norma, no una anomalía', () => {
  // Un lote es un contenedor que Steelhead VACÍA al convertirlo a OT, así que remaining=0 es
  // el curso normal. El aviso salía casi siempre y leía como problema lo que es lo esperado.
  assert.equal(Core.shouldWarnAllDepleted, undefined, 'se retiró del core, no solo del render');
});

test('MARCADO INVERTIDO: lo que se resalta es el lote que AÚN tiene material (la excepción)', () => {
  // Misma lección que surtido-guard 0.2.0. `withMaterial` es el bucket que la UI marca.
  const soloVacios = Core.selectByExactName(IBV_T125_REAL_DEPLETED, 'T-125');
  assert.equal(soloVacios.count, 6, 'se aplican igual: sirven como REFERENCIA');
  assert.equal(soloVacios.withMaterial.count, 0, 'nada que resaltar — es el caso normal');

  const mixto = [...IBV_T125_REAL_DEPLETED.slice(0, 2),
                 { id: 999, idInDomain: 1, name: 'T-125', totalRemainingMicroQuantity: '5000000' }];
  const r = Core.selectByExactName(mixto, 'T-125');
  assert.deepEqual(r.withMaterial.ids, ['999'], 'el que conserva material es el que se marca');
  assert.equal(r.count, 3, 'pero se aplican los tres');
});

// ── Guardarraíl de volumen: el /graphql de la sesión se CUELGA a ~40-45 requests
// (incidente medido en po-listing-filters) y tumba la pantalla NATIVA del operador.
// Duplicar el universo duplica el tráfico → hay que acotarlo con decisión PURA.
test('planSearch: exige un mínimo de caracteres (searchQuery:"T" = 12 793 lotes)', () => {
  assert.equal(Core.planSearch('').ok, false);
  assert.equal(Core.planSearch('T').ok, false);
  assert.equal(Core.planSearch('T').reason, 'too-short');
  assert.equal(Core.planSearch('  T  ').ok, false, 'se cuenta el nombre YA recortado');
  const p = Core.planSearch('T-1');
  assert.equal(p.ok, true);
  assert.deepEqual(p.universes, [true, false]);
});

test('planPagination: pide solo las páginas necesarias', () => {
  assert.deepEqual(Core.planPagination(0, 200), { pages: 0, capped: false, tooBroad: false });
  assert.deepEqual(Core.planPagination(20, 200), { pages: 1, capped: false, tooBroad: false });
  assert.deepEqual(Core.planPagination(200, 200), { pages: 1, capped: false, tooBroad: false });
  assert.deepEqual(Core.planPagination(201, 200), { pages: 2, capped: false, tooBroad: false });
});

test('planPagination: 1 009 (searchQuery:"T-1") SÍ se pagina — el tope subió a 1 600', () => {
  // Nació en 600 y cortaba búsquedas legítimas: los lotes vacíos se ACUMULAN históricamente
  // (todo lote que pasa a OT queda vacío), así que un nombre viejo junta cientos.
  const r = Core.planPagination(1009, 200);
  assert.equal(r.tooBroad, false);
  assert.equal(r.pages, 6);
  assert.equal(r.capped, false);
});

test('planPagination: tooBroad corta ANTES de paginar cuando el substring es de veras amplio', () => {
  const r = Core.planPagination(12793, 200); // searchQuery:'T' medido en vivo
  assert.equal(r.tooBroad, true);
  assert.equal(r.pages, 0, 'no pagina: un exacto sacado de un substring inpaginable queda parcial e IMPREDECIBLE');
});

test('planPagination: el cap de páginas se reporta, no se calla', () => {
  const cap = Core.MAX_PAGES_PER_UNIVERSE;
  const justUnderBroad = Core.MAX_TOTAL_TO_PAGE;
  const r = Core.planPagination(justUnderBroad, 1); // fuerza muchas páginas con page=1
  assert.equal(r.pages, cap);
  assert.equal(r.capped, true, 'truncar en silencio se lee como «los cubrí todos»');
});
