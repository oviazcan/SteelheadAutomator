// tools/test/po-listing-filters-core.test.js
// Golden tests del módulo puro "Buscador global de OC + Toggle de empresa".
// Run: node --test tools/test/po-listing-filters-core.test.js
//
// Los datos de los fixtures son REALES (dominio 344, capturados en vivo 2026-07-27):
// ids de direcciones, displays anidados y el shape de los nodos de PurchaseOrders.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/po-listing-filters-core.js');

// Direcciones reales del dominio 344 tal como las devuelve FilterSearch.
const LOCATIONS = [
  { display: 'Ecoplating', identifier: '22872' },
  { display: 'PlantaToluca', identifier: '24863' },
  { display: 'Proquipa', identifier: '23301' },
  { display: 'Ecoplating.N2', identifier: '23345' },
  { display: 'Ecoplating.N3', identifier: '23346' },
  { display: 'Ecoplating.N4', identifier: '23347' },
  { display: 'Ecoplating.N5', identifier: '25802' },
  { display: 'PlantaToluca.Externa', identifier: '28241' },
  { display: 'Proquipa.N1', identifier: '23344' },
  { display: 'Ecoplating.N2.A2', identifier: '24913' },
];

// ---------- isPurchaseOrdersUrl (gate) ----------

test('isPurchaseOrdersUrl: acepta la pantalla de OCs con y sin query', () => {
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/344/Purchasing/PurchaseOrders'), true);
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/344/Purchasing/PurchaseOrders/'), true);
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/1/Purchasing/PurchaseOrders?category=Issued'), true);
});

test('isPurchaseOrdersUrl: rechaza otras rutas de Purchasing', () => {
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/344/Purchasing'), false);
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/344/Bills'), false);
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/344/Purchasing/PurchaseOrderTemplates'), false);
  assert.equal(Core.isPurchaseOrdersUrl('/Domains/344/Purchasing/PurchaseOrders/1911'), false);
  assert.equal(Core.isPurchaseOrdersUrl(null), false);
});

test('domainIdFromPath: extrae el dominio', () => {
  assert.equal(Core.domainIdFromPath('/Domains/344/Purchasing/PurchaseOrders'), '344');
  assert.equal(Core.domainIdFromPath('/Reporting/View'), null);
});

// ---------- parseCategoryFromUrl (las 5 vistas) ----------

test('parseCategoryFromUrl: las 5 vistas reales', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders';
  assert.equal(Core.parseCategoryFromUrl(base), 'draft');
  assert.equal(Core.parseCategoryFromUrl(base + '?category=Draft'), 'draft');
  assert.equal(Core.parseCategoryFromUrl(base + '?category=Issued'), 'issued-open');
  assert.equal(Core.parseCategoryFromUrl(base + '?billing=Closed&category=Issued'), 'issued-closed');
  assert.equal(Core.parseCategoryFromUrl(base + '?billing=Open&category=Fulfilled'), 'fulfilled-open');
  assert.equal(Core.parseCategoryFromUrl(base + '?billing=Closed&category=Fulfilled'), 'fulfilled-closed');
});

test('parseCategoryFromUrl: categoría desconocida cae en draft (fail-safe)', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders';
  assert.equal(Core.parseCategoryFromUrl(base + '?category=Foo'), 'draft');
  assert.equal(Core.parseCategoryFromUrl('basura'), 'draft');
});

test('PO_CATEGORIES: las variables son las que manda el front (incluye el issuedAt de Draft)', () => {
  assert.equal(Core.PO_CATEGORIES.length, 5);
  assert.deepEqual(Core.categoryByKey('draft').queryVars, { issuedAt: true, fulfilledCondition: false });
  assert.deepEqual(Core.categoryByKey('issued-open').queryVars, { issuedCondition: true, billingOpen: true });
  assert.deepEqual(Core.categoryByKey('issued-closed').queryVars, { issuedCondition: true, billingOpen: false });
  assert.deepEqual(Core.categoryByKey('fulfilled-open').queryVars, { fulfilledCondition: true, billingOpen: true });
  assert.deepEqual(Core.categoryByKey('fulfilled-closed').queryVars, { fulfilledCondition: true, billingOpen: false });
});

// ---------- buildCategoryUrl ----------

test('buildCategoryUrl: limpia el eje billing al cambiar de vista', () => {
  const from = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders?billing=Closed&category=Issued';
  const url = Core.buildCategoryUrl(from, 'draft');
  assert.equal(url.includes('billing='), false, 'no debe arrastrar billing=Closed a Draft');
  assert.equal(url.includes('category=Draft'), true);
});

test('buildCategoryUrl: resetea offset y agrega extras', () => {
  const from = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders?offset=40';
  const url = Core.buildCategoryUrl(from, 'issued-open', { searchQuery: '1911' });
  assert.equal(url.includes('offset=0'), true);
  assert.equal(url.includes('searchQuery=1911'), true);
  assert.equal(url.includes('category=Issued'), true);
});

test('buildCategoryUrl: extra en null borra el parámetro', () => {
  const from = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders?searchQuery=x';
  const url = Core.buildCategoryUrl(from, 'issued-open', { searchQuery: null });
  assert.equal(url.includes('searchQuery'), false);
});

// ---------- rootLocationName / companyOfLocation ----------

test('rootLocationName: corta en el primer punto (ubicaciones anidadas)', () => {
  assert.equal(Core.rootLocationName('Ecoplating'), 'Ecoplating');
  assert.equal(Core.rootLocationName('Ecoplating.N2'), 'Ecoplating');
  assert.equal(Core.rootLocationName('Ecoplating.N2.A2'), 'Ecoplating');
  assert.equal(Core.rootLocationName('PlantaToluca.Externa'), 'PlantaToluca');
  assert.equal(Core.rootLocationName('  Proquipa.N1  '), 'Proquipa');
  assert.equal(Core.rootLocationName(''), '');
  assert.equal(Core.rootLocationName(null), '');
});

test('companyOfLocation: PlantaToluca (dominio) cuenta como Ecoplating', () => {
  assert.equal(Core.companyOfLocation('PlantaToluca'), 'ecoplating');
  assert.equal(Core.companyOfLocation('PlantaToluca.Externa'), 'ecoplating');
});

test('companyOfLocation: resuelve por RAÍZ, no por prefijo de cadena', () => {
  // 'EcoplatingOtra' NO es una sub-ubicación de Ecoplating: un prefix-match ingenuo fallaría.
  assert.equal(Core.companyOfLocation('EcoplatingOtra'), 'otra');
  assert.equal(Core.companyOfLocation('Ecoplating.N2'), 'ecoplating');
});

test('companyOfLocation: desconocida → otra', () => {
  assert.equal(Core.companyOfLocation('AlgunaBodega'), 'otra');
  assert.equal(Core.companyOfLocation(''), 'otra');
});

// ---------- groupLocationsByCompany ----------

test('groupLocationsByCompany: agrupa las 10 direcciones reales del dominio 344', () => {
  const g = Core.groupLocationsByCompany(LOCATIONS);
  // 6 de Ecoplating.* + PlantaToluca + PlantaToluca.Externa (el dominio cuenta como Ecoplating).
  assert.deepEqual(g.ecoplating.sort(), ['22872', '23345', '23346', '23347', '24863', '24913', '25802', '28241'].sort());
  assert.deepEqual(g.proquipa.sort(), ['23301', '23344'].sort());
  assert.deepEqual(g.otras, []);
  assert.equal(g.all.length, 10);
});

test('groupLocationsByCompany: dedup por identifier (las sondas múltiples repiten)', () => {
  const dup = LOCATIONS.concat(LOCATIONS);
  const g = Core.groupLocationsByCompany(dup);
  assert.equal(g.all.length, 10, 'los repetidos de las sondas no deben duplicarse');
  assert.equal(g.ecoplating.length, 8);
});

test('groupLocationsByCompany: desconocidas van a otras y NO contaminan ningún lado', () => {
  const g = Core.groupLocationsByCompany(LOCATIONS.concat([{ display: 'Bodega X', identifier: '99999' }]));
  assert.equal(g.otras.length, 1);
  assert.equal(g.ecoplating.includes('99999'), false);
  assert.equal(g.proquipa.includes('99999'), false);
});

test('groupLocationsByCompany: entrada basura no truena', () => {
  const g = Core.groupLocationsByCompany([null, {}, { display: 'X' }, undefined]);
  assert.equal(g.all.length, 0);
});

// ---------- planCompanyFilter (las 3 ramas) ----------

const GROUPS = Core.groupLocationsByCompany(LOCATIONS);

test('planCompanyFilter: centro limpia el filtro', () => {
  const p = Core.planCompanyFilter(Core.MODES.BOTH, GROUPS, {});
  assert.equal(p.kind, 'clear');
});

test('planCompanyFilter: Proquipa siempre es filtro nativo puro', () => {
  const p = Core.planCompanyFilter(Core.MODES.PROQUIPA, GROUPS, {});
  assert.equal(p.kind, 'filter');
  assert.deepEqual(p.ids.sort(), ['23301', '23344'].sort());
});

test('planCompanyFilter: Ecoplating con cobertura total → filtro nativo', () => {
  const p = Core.planCompanyFilter(Core.MODES.ECOPLATING, GROUPS, { allCovered: true });
  assert.equal(p.kind, 'filter');
  assert.equal(p.ids.includes('22872'), true);
  assert.equal(p.ids.includes(null), false, 'sin huérfanas no debe mandar null');
});

test('planCompanyFilter: Ecoplating con null aceptado → filtro + null', () => {
  const p = Core.planCompanyFilter(Core.MODES.ECOPLATING, GROUPS, { allCovered: false, nullAccepted: true });
  assert.equal(p.kind, 'filter');
  assert.equal(p.ids.includes(null), true);
});

test('planCompanyFilter: Ecoplating sin salida limpia → annotate (NO esconde huérfanas)', () => {
  const p = Core.planCompanyFilter(Core.MODES.ECOPLATING, GROUPS,
    { allCovered: false, nullAccepted: false, orphanCount: 79 });
  assert.equal(p.kind, 'annotate', 'fail-safe: nunca esconder OCs por un dato irresoluble');
  assert.deepEqual(p.hiddenIds.sort(), ['23301', '23344'].sort());
  assert.equal(p.orphanCount, 79);
});

test('planCompanyFilter: sin direcciones de una empresa → unavailable (no filtra a ciegas)', () => {
  const vacio = { ecoplating: [], proquipa: [], otras: [], all: [] };
  assert.equal(Core.planCompanyFilter(Core.MODES.PROQUIPA, vacio, {}).kind, 'unavailable');
  assert.equal(Core.planCompanyFilter(Core.MODES.ECOPLATING, vacio, {}).kind, 'unavailable');
});

// ---------- buildCompanyFilterUrl / parseCompanyModeFromUrl ----------

test('buildCompanyFilterUrl: escribe ids con coma literal y resetea offset', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders?category=Issued&offset=40';
  const url = Core.buildCompanyFilterUrl(base, ['23301', '23344']);
  assert.equal(url.includes('billToLocationIdFilter=23301,23344'), true, 'coma literal como el nativo');
  assert.equal(url.includes('offset=0'), true);
  assert.equal(url.includes('category=Issued'), true, 'no debe perder la vista actual');
});

test('buildCompanyFilterUrl: lista vacía limpia el parámetro', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders?billToLocationIdFilter=22872';
  const url = Core.buildCompanyFilterUrl(base, []);
  assert.equal(url.includes('billToLocationIdFilter'), false);
});

test('parseBillToFilter: lee los ids del parámetro', () => {
  const u = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders?billToLocationIdFilter=22872,23345';
  assert.deepEqual(Core.parseBillToFilter(u), ['22872', '23345']);
  assert.deepEqual(Core.parseBillToFilter('https://x.test/a'), []);
});

test('parseCompanyModeFromUrl: refleja el estado del toggle al recargar', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders';
  assert.equal(Core.parseCompanyModeFromUrl(base, GROUPS), Core.MODES.BOTH);
  assert.equal(Core.parseCompanyModeFromUrl(base + '?billToLocationIdFilter=23301,23344', GROUPS), Core.MODES.PROQUIPA);
  assert.equal(Core.parseCompanyModeFromUrl(base + '?billToLocationIdFilter=22872,24863', GROUPS), Core.MODES.ECOPLATING);
});

test('parseCompanyModeFromUrl: un set mixto o ajeno cae en centro (no miente sobre el estado)', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders';
  assert.equal(Core.parseCompanyModeFromUrl(base + '?billToLocationIdFilter=22872,23301', GROUPS), Core.MODES.BOTH);
  assert.equal(Core.parseCompanyModeFromUrl(base + '?billToLocationIdFilter=99999', GROUPS), Core.MODES.BOTH);
});

// ---------- parseVendorDisplay ----------

test('parseVendorDisplay: parte "#6 - ATOTECH DE MEXICO" (formato real de FilterSearch)', () => {
  assert.deepEqual(Core.parseVendorDisplay('#6 - ATOTECH DE MEXICO'), { idInDomain: '6', name: 'ATOTECH DE MEXICO' });
  assert.deepEqual(Core.parseVendorDisplay('#5 - QUIMETAL PEMDER'), { idInDomain: '5', name: 'QUIMETAL PEMDER' });
});

test('parseVendorDisplay: sin el prefijo devuelve el nombre tal cual', () => {
  assert.deepEqual(Core.parseVendorDisplay('ACIDOS DE MEXICO'), { idInDomain: null, name: 'ACIDOS DE MEXICO' });
  assert.deepEqual(Core.parseVendorDisplay(null), { idInDomain: null, name: '' });
});

// ---------- classifyResults ----------

const RAW = {
  vendors: [{ display: '#6 - ATOTECH DE MEXICO', identifier: '89855' }],
  poByCategory: {
    'issued-open': [
      { id: 736, idInDomain: 1873, vendorByVendorId: { name: 'ATOTECH DE MEXICO' }, currentStage: { name: 'Emitida con autorización' } },
    ],
    'fulfilled-closed': [
      { id: 700, idInDomain: 1842, vendorByVendorId: { name: 'ATOTECH DE MEXICO' }, currentStage: null },
    ],
  },
  bills: [
    { id: 553, idInDomain: 553, vendorByVendorId: { name: 'ATOTECH DE MEXICO' }, purchaseOrderByPurchaseOrderId: { idInDomain: 1842 } },
  ],
};

test('classifyResults: etiqueta cada hallazgo con su tipo', () => {
  const list = Core.classifyResults(RAW);
  assert.deepEqual(list.map((r) => r.type), ['VENDOR', 'PO', 'PO', 'BILL']);
});

test('classifyResults: cada OC dice en qué vista vive (el dolor original)', () => {
  const list = Core.classifyResults(RAW);
  const pos = list.filter((r) => r.type === 'PO');
  assert.equal(pos[0].categoryKey, 'issued-open');
  assert.equal(pos[0].categoryLabel, 'Emitida · Abierta');
  assert.equal(pos[1].categoryKey, 'fulfilled-closed');
  assert.equal(pos[1].categoryLabel, 'Surtida · Cerrada');
});

test('classifyResults: la factura conserva su OC', () => {
  const bill = Core.classifyResults(RAW).find((r) => r.type === 'BILL');
  assert.equal(bill.poIdInDomain, '1842');
  assert.equal(bill.label, 'Factura 553');
});

test('classifyResults: entrada vacía → lista vacía', () => {
  assert.deepEqual(Core.classifyResults({}), []);
  assert.deepEqual(Core.classifyResults(null), []);
});

test('classifyResults: respeta el orden de PO_CATEGORIES', () => {
  const raw = { poByCategory: { 'fulfilled-closed': [{ id: 1, idInDomain: 1 }], draft: [{ id: 2, idInDomain: 2 }] } };
  const list = Core.classifyResults(raw);
  assert.deepEqual(list.map((r) => r.categoryKey), ['draft', 'fulfilled-closed']);
});

// ---------- dedupeResults / groupResultsForRender ----------

test('dedupeResults: la misma OC por searchQuery y por vendorIdFilter sale una vez', () => {
  const dupes = [
    { type: 'PO', id: '736', idInDomain: '1873' },
    { type: 'PO', id: '736', idInDomain: '1873' },
  ];
  assert.equal(Core.dedupeResults(dupes).length, 1);
});

test('dedupeResults: no colapsa tipos distintos con el mismo id', () => {
  const mixed = [{ type: 'PO', id: '553' }, { type: 'BILL', id: '553' }];
  assert.equal(Core.dedupeResults(mixed).length, 2);
});

test('groupResultsForRender: separa en las 3 secciones del panel', () => {
  const g = Core.groupResultsForRender(Core.classifyResults(RAW));
  assert.equal(g.vendors.length, 1);
  assert.equal(g.pos.length, 2);
  assert.equal(g.bills.length, 1);
  assert.equal(g.total, 4);
});

// ---------- buildResultHref ----------

test('buildResultHref: la OC lleva a su vista con el PO# filtrado', () => {
  const po = Core.classifyResults(RAW).find((r) => r.type === 'PO');
  const href = Core.buildResultHref(po, '344');
  assert.equal(href.includes('/Domains/344/Purchasing/PurchaseOrders'), true);
  assert.equal(href.includes('category=Issued'), true);
  assert.equal(href.includes('searchQuery=1873'), true);
});

test('buildResultHref: el proveedor lleva a sus OCs por vendorIdFilter', () => {
  const v = Core.classifyResults(RAW).find((r) => r.type === 'VENDOR');
  const href = Core.buildResultHref(v, '344');
  assert.equal(href.includes('vendorIdFilter=89855'), true);
});

test('buildResultHref: la factura lleva a la pantalla de Bills', () => {
  const b = Core.classifyResults(RAW).find((r) => r.type === 'BILL');
  assert.equal(Core.buildResultHref(b, '344'), '/Domains/344/Bills?searchQuery=553');
});

test('buildResultHref: sin dominio no inventa link', () => {
  assert.equal(Core.buildResultHref({ type: 'PO' }, null), null);
  assert.equal(Core.buildResultHref(null, '344'), null);
});
