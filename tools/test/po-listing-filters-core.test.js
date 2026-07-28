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

// ---------- toggle binario: solo Proquipa ----------
// Nació triple; el lado Ecoplating no es expresable porque sus OC llevan la dirección del
// dominio y el filtro nativo de SH no la acepta (bug con ticket abierto, 2026-07-27).

const GROUPS = Core.groupLocationsByCompany(LOCATIONS);

test('planProquipaFilter: encendido filtra las DOS direcciones de Proquipa', () => {
  const p = Core.planProquipaFilter(true, GROUPS);
  assert.equal(p.kind, 'filter');
  assert.deepEqual(p.ids.sort(), ['23301', '23344'].sort());
});

test('planProquipaFilter: apagado limpia el filtro', () => {
  assert.equal(Core.planProquipaFilter(false, GROUPS).kind, 'clear');
});

test('planProquipaFilter: sin direcciones de Proquipa no filtra a ciegas', () => {
  const vacio = { ecoplating: ['1'], proquipa: [], otras: [], all: ['1'] };
  assert.equal(Core.planProquipaFilter(true, vacio).kind, 'unavailable');
});

test('isProquipaFilterActive: solo con el set EXACTO de Proquipa', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders';
  assert.equal(Core.isProquipaFilterActive(base, GROUPS), false, 'sin filtro → apagado');
  assert.equal(Core.isProquipaFilterActive(base + '?billToLocationIdFilter=23301,23344', GROUPS), true);
});

test('isProquipaFilterActive: un set parcial o ajeno NO enciende el toggle', () => {
  const base = 'https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders';
  assert.equal(Core.isProquipaFilterActive(base + '?billToLocationIdFilter=23301', GROUPS), false,
    'parcial: mentiría sobre lo aplicado');
  assert.equal(Core.isProquipaFilterActive(base + '?billToLocationIdFilter=23301,23344,22872', GROUPS), false,
    'con una de Ecoplating de más');
  assert.equal(Core.isProquipaFilterActive(base + '?billToLocationIdFilter=99999', GROUPS), false);
});

// ---------- secciones de navegación (siempre "All") ----------

test('PO_NAV_SECTIONS: son 3 y las de facturación OMITEN billingOpen (= All)', () => {
  assert.equal(Core.PO_NAV_SECTIONS.length, 3);
  const issued = Core.PO_NAV_SECTIONS.find((s) => s.key === 'issued-all');
  const ful = Core.PO_NAV_SECTIONS.find((s) => s.key === 'fulfilled-all');
  assert.deepEqual(issued.queryVars, { issuedCondition: true }, 'All = sin billingOpen');
  assert.deepEqual(ful.queryVars, { fulfilledCondition: true });
  assert.equal(issued.urlParams.billing, 'All');
  assert.equal(ful.urlParams.billing, 'All');
});

test('PO_NAV_SECTIONS: ninguna sección de navegación es Open ni Closed', () => {
  for (const s of Core.PO_NAV_SECTIONS) {
    assert.notEqual(s.urlParams.billing, 'Open');
    assert.notEqual(s.urlParams.billing, 'Closed');
    assert.equal('billingOpen' in s.queryVars, false, s.key + ' no debe fijar billingOpen');
  }
});

test('resolveFirstSectionWithResults: respeta el orden Draft → Issued → Fulfilled', () => {
  assert.equal(Core.resolveFirstSectionWithResults({ draft: 2, 'issued-all': 9, 'fulfilled-all': 4 }), 'draft');
  assert.equal(Core.resolveFirstSectionWithResults({ draft: 0, 'issued-all': 9, 'fulfilled-all': 4 }), 'issued-all');
  assert.equal(Core.resolveFirstSectionWithResults({ draft: 0, 'issued-all': 0, 'fulfilled-all': 4 }), 'fulfilled-all');
});

test('resolveFirstSectionWithResults: todo en cero → null (no manda a una vista vacía)', () => {
  assert.equal(Core.resolveFirstSectionWithResults({ draft: 0, 'issued-all': 0, 'fulfilled-all': 0 }), null);
  assert.equal(Core.resolveFirstSectionWithResults({}), null);
  assert.equal(Core.resolveFirstSectionWithResults(null), null);
});

test('resolveFirstSectionWithResults: un conteo desconocido NO cuenta como resultado', () => {
  // Si la consulta falló (null), saltarse esa sección es mejor que mandar al operador a ciegas.
  assert.equal(Core.resolveFirstSectionWithResults({ draft: null, 'issued-all': 3 }), 'issued-all');
  assert.equal(Core.resolveFirstSectionWithResults({ draft: undefined, 'issued-all': 0 }), null);
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
    // shape REAL de SearchBills: el PO vive en las líneas (`purchaseOrderName`), no en el raíz.
    { id: 553, idInDomain: 553, invoiceNumber: 'F-900', vendorByVendorId: { name: 'ATOTECH DE MEXICO' },
      billLinesByBillId: { nodes: [{ purchaseOrderName: '1842' }] } },
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

test('classifyResults: la factura conserva su OC (leída de las líneas)', () => {
  const bill = Core.classifyResults(RAW).find((r) => r.type === 'BILL');
  assert.deepEqual(bill.poNames, ['1842']);
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

test('buildResultHref: el proveedor va a "All" por defecto, nunca a Open/Closed', () => {
  const v = Core.classifyResults(RAW).find((r) => r.type === 'VENDOR');
  const href = Core.buildResultHref(v, '344');
  assert.ok(href.includes('billing=All'), 'debe ser la variante All, es: ' + href);
  assert.equal(href.includes('billing=Open'), false);
  assert.equal(href.includes('billing=Closed'), false);
});

test('buildResultHref: el proveedor respeta la sección resuelta', () => {
  const v = Core.classifyResults(RAW).find((r) => r.type === 'VENDOR');
  const draft = Core.buildResultHref(v, '344', 'draft');
  assert.ok(draft.includes('category=Draft'), 'es: ' + draft);
  const ful = Core.buildResultHref(v, '344', 'fulfilled-all');
  assert.ok(ful.includes('category=Fulfilled') && ful.includes('billing=All'), 'es: ' + ful);
});

test('buildResultHref: una OC va a SU vista exacta, no a All', () => {
  // Una OC vive en UNA sola de las 5 vistas; mandarla a All la escondería entre las demás.
  const po = Core.classifyResults(RAW).find((r) => r.categoryKey === 'issued-open');
  const href = Core.buildResultHref(po, '344');
  assert.ok(href.includes('category=Issued'), 'es: ' + href);
  assert.equal(href.includes('billing=All'), false);
});

// ---------- buildDetailHref (la flechita ↗) ----------
// Las 3 rutas usan idInDomain, verificado en vivo: /Vendors/6 abre ATOTECH DE MEXICO,
// /Purchasing/PurchaseOrders/1897 es el PO# visible.

test('buildDetailHref: ficha de cada tipo con idInDomain', () => {
  assert.equal(Core.buildDetailHref({ type: 'PO', idInDomain: '1873' }, '344'),
    '/Domains/344/Purchasing/PurchaseOrders/1873');
  assert.equal(Core.buildDetailHref({ type: 'VENDOR', idInDomain: '6' }, '344'),
    '/Domains/344/Vendors/6');
  assert.equal(Core.buildDetailHref({ type: 'BILL', idInDomain: '553' }, '344'),
    '/Domains/344/Bills/553');
});

test('buildDetailHref: el proveedor usa el "#6" del display, NO el id de BD', () => {
  // FilterSearch da identifier=89855 (id de BD) y display "#6 - ATOTECH DE MEXICO".
  // La ficha es /Vendors/6 — usar 89855 abriría otro proveedor o un 404.
  const v = Core.classifyResults(RAW).find((r) => r.type === 'VENDOR');
  assert.equal(v.id, '89855', 'el id de BD se conserva para el filtro del listado');
  assert.equal(Core.buildDetailHref(v, '344'), '/Domains/344/Vendors/6');
});

test('buildDetailHref: sin idInDomain NO inventa link', () => {
  // Mejor sin flechita que una flechita que abra otro documento.
  assert.equal(Core.buildDetailHref({ type: 'PO', idInDomain: null }, '344'), null);
  assert.equal(Core.buildDetailHref({ type: 'PO', idInDomain: '1' }, null), null);
  assert.equal(Core.buildDetailHref(null, '344'), null);
});

test('buildDetailHref: tipo desconocido → null', () => {
  assert.equal(Core.buildDetailHref({ type: 'OTRO', idInDomain: '1' }, '344'), null);
});

// ---------- ids enteros en GraphQL (regresión del deploy 1.7.208) ----------
// FilterSearch entrega `identifier` como STRING ("89855") pero el schema declara los filtros
// como [Int] y GraphQL no coacciona: mandar strings revienta la consulta ENTERA (HTTP 400
// 'Variable "$vendorIdFilter" got invalid value'). Los 3 conteos que resuelven la sección
// fallaban todos y siempre se caía al fallback.

test('toIdList: convierte los strings de FilterSearch a enteros', () => {
  assert.deepEqual(Core.toIdList(['89855']), [89855]);
  assert.deepEqual(Core.toIdList(['23301', '23344']), [23301, 23344]);
});

test('toIdList: deja pasar los que ya son enteros', () => {
  assert.deepEqual(Core.toIdList([22872, 23301]), [22872, 23301]);
  assert.deepEqual(Core.toIdList([22872, '23301']), [22872, 23301]);
});

test('toIdList: descarta lo no numérico en vez de mandar NaN', () => {
  // Un NaN rompería la consulta igual que un string.
  assert.deepEqual(Core.toIdList(['abc', '123', null, undefined, '']), [123]);
  assert.deepEqual(Core.toIdList([]), []);
  assert.deepEqual(Core.toIdList(null), []);
});

test('toIdList: el resultado son enteros de verdad, no strings', () => {
  for (const n of Core.toIdList(['1', '2'])) {
    assert.equal(typeof n, 'number');
    assert.equal(Number.isInteger(n), true);
  }
});

// ---------- navegación por teclado del panel ----------

test('moveActiveIndex: desde "nada seleccionado", ↓ cae en el primero y ↑ en el último', () => {
  assert.equal(Core.moveActiveIndex(-1, 4, 1), 0);
  assert.equal(Core.moveActiveIndex(-1, 4, -1), 3);
});

test('moveActiveIndex: avanza y retrocede', () => {
  assert.equal(Core.moveActiveIndex(0, 4, 1), 1);
  assert.equal(Core.moveActiveIndex(2, 4, -1), 1);
});

test('moveActiveIndex: da la vuelta en ambos extremos', () => {
  assert.equal(Core.moveActiveIndex(3, 4, 1), 0, 'del último al primero');
  assert.equal(Core.moveActiveIndex(0, 4, -1), 3, 'del primero al último');
});

test('moveActiveIndex: sin resultados no selecciona nada', () => {
  assert.equal(Core.moveActiveIndex(-1, 0, 1), -1);
  assert.equal(Core.moveActiveIndex(2, 0, -1), -1);
});

test('moveActiveIndex: un solo resultado se queda en él', () => {
  assert.equal(Core.moveActiveIndex(0, 1, 1), 0);
  assert.equal(Core.moveActiveIndex(0, 1, -1), 0);
});

test('moveActiveIndex: índice fuera de rango no truena ni devuelve negativo', () => {
  const r = Core.moveActiveIndex(99, 3, 1);
  assert.ok(r >= 0 && r < 3, 'debe caer dentro del rango, es: ' + r);
  assert.equal(Core.moveActiveIndex(null, 3, 1), 0);
});

// ---------- el host ficticio NUNCA se filtra (regresión del deploy 1.7.205) ----------
// new URL(rel, BASE) exige una base; devolver u.toString() la PEGA al resultado y genera
// enlaces a https://x.invalid/… que sacan al operador de Steelhead a un host muerto.
// Los tests originales solo comprobaban `includes(path)` y no lo detectaron.

test('buildResultHref: NUNCA devuelve el host ficticio (los 3 tipos)', () => {
  for (const r of Core.classifyResults(RAW)) {
    const href = Core.buildResultHref(r, '344');
    assert.ok(href, 'debe generar link para ' + r.type);
    assert.equal(/x\.invalid/.test(href), false, `${r.type} filtró el host ficticio: ${href}`);
    assert.ok(href.startsWith('/'), `${r.type} debe ser relativo, es: ${href}`);
  }
});

test('buildCategoryUrl: entrada relativa → salida relativa', () => {
  const url = Core.buildCategoryUrl('/Domains/344/Purchasing/PurchaseOrders', 'issued-open');
  assert.equal(/x\.invalid/.test(url), false);
  assert.ok(url.startsWith('/Domains/344/'), 'es: ' + url);
});

test('buildCategoryUrl: entrada absoluta → salida absoluta (conserva el host real)', () => {
  const url = Core.buildCategoryUrl('https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders', 'issued-open');
  assert.ok(url.startsWith('https://app.gosteelhead.com/'), 'es: ' + url);
  assert.equal(/x\.invalid/.test(url), false);
});

test('buildCompanyFilterUrl: respeta relativo y absoluto', () => {
  const rel = Core.buildCompanyFilterUrl('/Domains/344/Purchasing/PurchaseOrders?category=Issued', ['23301']);
  assert.ok(rel.startsWith('/Domains/344/'), 'es: ' + rel);
  assert.equal(/x\.invalid/.test(rel), false);
  const abs = Core.buildCompanyFilterUrl('https://app.gosteelhead.com/Domains/344/Purchasing/PurchaseOrders', ['23301']);
  assert.ok(abs.startsWith('https://app.gosteelhead.com/'), 'es: ' + abs);
});

// ---------- presupuesto de consultas (invariante de seguridad) ----------
// El /graphql se cae ~40 requests y tumba la pantalla nativa completa. El fan-out DEBE
// estar acotado: si alguien vuelve a meter un segundo fan-out por proveedor, esto truena.

test('planSearchQueries: nunca excede el presupuesto por búsqueda', () => {
  const plan = Core.planSearchQueries('ATOTECH');
  assert.ok(plan.length <= Core.MAX_QUERIES_PER_SEARCH,
    `el fan-out son ${plan.length} consultas, tope ${Core.MAX_QUERIES_PER_SEARCH}`);
});

test('planSearchQueries: 1 de proveedores + 5 vistas + 1 de facturas = 7', () => {
  const plan = Core.planSearchQueries('ATOTECH');
  assert.equal(plan.filter((p) => p.kind === 'vendors').length, 1);
  assert.equal(plan.filter((p) => p.kind === 'pos').length, 5);
  assert.equal(plan.filter((p) => p.kind === 'bills').length, 1);
  assert.equal(plan.length, 7);
});

test('planSearchQueries: NO hace un segundo fan-out por proveedor (12 consultas)', () => {
  // Invariante explícito: el proveedor se entrega clickeable, no se expande a 5 vistas más.
  const plan = Core.planSearchQueries('ATOTECH');
  const porVendor = plan.filter((p) => p.kind === 'pos' && p.vendorIds);
  assert.equal(porVendor.length, 0, 'el fan-out por vendorIdFilter costaría 5 consultas extra');
});

test('planSearchQueries: cubre las 5 vistas, sin repetir ni faltar', () => {
  const keys = Core.planSearchQueries('x').filter((p) => p.kind === 'pos').map((p) => p.categoryKey);
  assert.deepEqual(keys.sort(), Core.PO_CATEGORIES.map((c) => c.key).sort());
});

test('planSearchQueries: término vacío no consulta nada', () => {
  assert.deepEqual(Core.planSearchQueries(''), []);
  assert.deepEqual(Core.planSearchQueries('   '), []);
  assert.deepEqual(Core.planSearchQueries(null), []);
});

test('planSearchQueries: la vista ACTUAL se consulta primero', () => {
  // Con render incremental, el orden decide qué ve el operador antes.
  const plan = Core.planSearchQueries('x', 'fulfilled-closed');
  const pos = plan.filter((p) => p.kind === 'pos');
  assert.equal(pos[0].categoryKey, 'fulfilled-closed');
  assert.equal(pos.length, 5, 'sigue cubriendo las 5, solo cambia el orden');
});

test('planSearchQueries: priorizar no duplica ni pierde vistas', () => {
  for (const key of Core.PO_CATEGORIES.map((c) => c.key)) {
    const keys = Core.planSearchQueries('x', key).filter((p) => p.kind === 'pos').map((p) => p.categoryKey);
    assert.deepEqual(keys.slice().sort(), Core.PO_CATEGORIES.map((c) => c.key).sort(), 'con ' + key);
    assert.equal(keys[0], key);
    assert.equal(new Set(keys).size, 5, 'sin repetidos con ' + key);
  }
});

test('planSearchQueries: sin vista actual (o desconocida) conserva el orden natural', () => {
  const natural = Core.PO_CATEGORIES.map((c) => c.key);
  assert.deepEqual(Core.planSearchQueries('x').filter((p) => p.kind === 'pos').map((p) => p.categoryKey), natural);
  assert.deepEqual(Core.planSearchQueries('x', 'no-existe').filter((p) => p.kind === 'pos').map((p) => p.categoryKey), natural);
});

// ---------- selección de anclajes (regresión del deploy 1.7.203) ----------
// El DOM de SH duplica el botón "New Purchase Order" en dos variantes responsive; tomar el
// primer match del querySelector anclaba en la OCULTA y el widget quedaba con ancho 0.

test('pickVisibleCandidate: ignora la variante responsive oculta (css-eabxx0)', () => {
  // Caso REAL medido en vivo: el botón "New Purchase Order" existe 2 veces.
  const cands = [
    { visible: false, width: 0, ref: 'css-eabxx0 (solo ícono, oculta en escritorio)' },
    { visible: true, width: 199, ref: 'css-165nl96 (botón completo, visible)' },
  ];
  assert.equal(Core.pickVisibleCandidate(cands), 'css-165nl96 (botón completo, visible)');
});

test('pickVisibleCandidate: descarta visible pero de ancho 0', () => {
  assert.equal(Core.pickVisibleCandidate([{ visible: true, width: 0, ref: 'a' }, { visible: true, width: 10, ref: 'b' }]), 'b');
});

test('pickVisibleCandidate: sin candidatos visibles → null (no ancla a ciegas)', () => {
  assert.equal(Core.pickVisibleCandidate([{ visible: false, width: 0, ref: 'a' }]), null);
  assert.equal(Core.pickVisibleCandidate([]), null);
  assert.equal(Core.pickVisibleCandidate(null), null);
});

// ---------- facturas: por qué matchean (reporte del operador, "1841") ----------
// SearchBills.searchQuery busca en VARIOS campos y no dice en cuál pegó, así que "1841"
// devolvía facturas que a simple vista no tenían nada que ver. Datos reales del dominio 344.

const BILLS_1841 = [
  { id: 45897, idInDomain: 1841, invoiceNumber: '262034', vendorByVendorId: { name: 'A&N FORWARDING INC' },
    billLinesByBillId: { nodes: [{ purchaseOrderName: '1617' }] } },
  { id: 2, idInDomain: 2018, invoiceNumber: '1841', vendorByVendorId: { name: 'REACTOR AD SISTEMAS' },
    billLinesByBillId: { nodes: [{ purchaseOrderName: '1790' }] } },
  { id: 3, idInDomain: 2080, invoiceNumber: 'PO1841', vendorByVendorId: { name: 'NORA LIZ PINEDA PEREZ' },
    billLinesByBillId: { nodes: [{ purchaseOrderName: '1841' }] } },
  { id: 4, idInDomain: 1822, invoiceNumber: '260708121841049', vendorByVendorId: { name: 'COMPUTO CONTABLE SOFT' },
    billLinesByBillId: { nodes: [{ purchaseOrderName: '1597' }] } },
];

test('extractBillPOs: el PO vive en las LÍNEAS, no en el nodo raíz', () => {
  assert.deepEqual(Core.extractBillPOs(BILLS_1841[2]), ['1841']);
  assert.deepEqual(Core.extractBillPOs({ billLinesByBillId: { nodes: [] } }), []);
  assert.deepEqual(Core.extractBillPOs(null), []);
});

test('extractBillPOs: dedup de líneas de la misma OC', () => {
  const b = { billLinesByBillId: { nodes: [{ purchaseOrderName: '99' }, { purchaseOrderName: '99' }, { purchaseOrderName: null }] } };
  assert.deepEqual(Core.extractBillPOs(b), ['99']);
});

test('billMatchReason: distingue los 4 casos reales de "1841"', () => {
  assert.equal(Core.billMatchReason(BILLS_1841[0], '1841'), Core.BILL_MATCH.BILL_ID, 'Bill #1841');
  assert.equal(Core.billMatchReason(BILLS_1841[1], '1841'), Core.BILL_MATCH.INVOICE, 'folio exacto 1841');
  assert.equal(Core.billMatchReason(BILLS_1841[2], '1841'), Core.BILL_MATCH.PO, 'ES la factura de la OC 1841');
  assert.equal(Core.billMatchReason(BILLS_1841[3], '1841'), Core.BILL_MATCH.INVOICE, 'substring del folio');
});

test('billMatchReason: la OC gana sobre el folio cuando ambos coinciden', () => {
  // La #2080 tiene folio "PO1841" (substring) Y OC 1841: debe reportar la OC, que informa más.
  assert.equal(Core.billMatchReason(BILLS_1841[2], '1841'), Core.BILL_MATCH.PO);
});

test('classifyResults: las facturas DE la OC buscada van primero', () => {
  const list = Core.classifyResults({ term: '1841', bills: BILLS_1841 });
  const bills = list.filter((r) => r.type === 'BILL');
  assert.equal(bills[0].idInDomain, '2080', 'la factura de la OC 1841 encabeza');
  assert.equal(bills[0].matchReason, Core.BILL_MATCH.PO);
  assert.equal(bills.length, 4, 'las demás no se pierden, solo bajan');
});

test('classifyResults: cada factura expone su OC y su folio para poder explicarse', () => {
  const bills = Core.classifyResults({ term: '1841', bills: BILLS_1841 }).filter((r) => r.type === 'BILL');
  const b2080 = bills.find((b) => b.idInDomain === '2080');
  assert.deepEqual(b2080.poNames, ['1841']);
  assert.equal(b2080.invoiceNumber, 'PO1841');
  const b1841 = bills.find((b) => b.idInDomain === '1841');
  assert.deepEqual(b1841.poNames, ['1617'], 'su OC es otra: por eso parecía no tener relación');
});

test('classifyResults: sin término no truena ni inventa motivos', () => {
  const bills = Core.classifyResults({ bills: BILLS_1841 }).filter((r) => r.type === 'BILL');
  assert.equal(bills.length, 4);
  assert.equal(bills.every((b) => b.matchReason === Core.BILL_MATCH.OTHER), true);
});
