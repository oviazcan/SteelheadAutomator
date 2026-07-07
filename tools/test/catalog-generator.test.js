// tools/test/catalog-generator.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCatalog, moduleFromPath } = require('../hash-autopilot/catalog-generator.mjs');

const typeOf = (op) => (/^(Create|Update|Save|Delete|Archive|Add|Remove|Set)/.test(op) ? 'mutation' : 'query');

test('moduleFromPath: extrae el módulo tras /Domains/{id}/', () => {
  assert.equal(moduleFromPath('/Domains/344/Customers/123'), 'Customers');
  assert.equal(moduleFromPath('/Domains/344/Customers'), 'Customers');
  assert.equal(moduleFromPath('/Dashboards'), 'Dashboards');
  assert.equal(moduleFromPath('/'), 'Home');
});

test('generateCatalog: agrupa ops de la misma pantalla en UNA ruta (economía de clics)', () => {
  const scanOps = {
    AllCustomers: { status: 'known', screens: [{ pathname: '/Domains/344/Customers', breadcrumb: null, count: 3 }] },
    CustomerTags: { status: 'known', screens: [{ pathname: '/Domains/344/Customers', breadcrumb: null, count: 1 }] },
    GetBillByIdInDomain: { status: 'known', screens: [{ pathname: '/Domains/344/Bills/9', breadcrumb: 'a:Abrir', count: 2 }] },
  };
  const cat = generateCatalog(scanOps, typeOf);
  const customersRoute = Object.values(cat.routes).find((r) => r.module === 'Customers');
  assert.deepEqual(customersRoute.captures, ['AllCustomers', 'CustomerTags']); // ordenado
  assert.deepEqual(customersRoute.steps, [{ goto: '/Domains/{domain}/Customers' }]);
  assert.equal(customersRoute.type, 'query');
});

test('generateCatalog: ruta de DETALLE usa {domain} + clickFirst ESPECÍFICO al módulo (patrón Fase A que funciona headless)', () => {
  const scanOps = { GetBillByIdInDomain: { status: 'known', screens: [{ pathname: '/Domains/344/Bills/9', breadcrumb: 'a:Abrir bill', count: 2 }] } };
  const cat = generateCatalog(scanOps, typeOf);
  const r = Object.values(cat.routes)[0];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/Bills'); // {domain} placeholder, NO el 344 hardcodeado
  const click = r.steps.find((s) => s.clickFirst);
  assert.ok(click, 'hay clickFirst para abrir el detalle');
  assert.equal(click.clickFirst, "a[href*='/Bills/']"); // ESPECÍFICO al módulo, no a[href] genérico
  assert.equal(click.hrefMatches, '/Bills/\\d+');
});

test('generateCatalog: ruta de LISTADO (sin id final) NO añade clickFirst — goto directo (evita timeout headless)', () => {
  const scanOps = { AllReceivers: { screens: [{ pathname: '/Receiving/CustomerParts', breadcrumb: 'a:x', count: 5 }] } };
  const cat = generateCatalog(scanOps, () => 'query');
  const r = Object.values(cat.routes)[0];
  assert.equal(r.steps.length, 1, 'solo goto, sin clickFirst genérico');
  assert.equal(r.steps[0].goto, '/Receiving/CustomerParts');
});

test('generateCatalog: op sin screens se omite (no hay ruta que inferir)', () => {
  const scanOps = { OrphanOp: { status: 'known', screens: [] } };
  const cat = generateCatalog(scanOps, typeOf);
  assert.deepEqual(Object.keys(cat.routes), []);
});

test('generateCatalog: varios objetos de detalle del mismo módulo (mismo id) → UNE captures (no sobrescribe)', () => {
  // dos PN distintos abiertos: pathnames únicos /PartNumbers/111 y /222, ambos → id partnumbers-detail
  const scanOps = {
    GetPartNumber: { screens: [{ pathname: '/Domains/344/PartNumbers/111', breadcrumb: 'a:x', count: 5 }] },
    GetPartNumberInventoryBatch: { screens: [{ pathname: '/Domains/344/PartNumbers/222', breadcrumb: 'a:y', count: 3 }] },
  };
  const cat = generateCatalog(scanOps, () => 'query');
  const pd = cat.routes['partnumbers-detail'];
  assert.ok(pd, 'debe existir partnumbers-detail');
  assert.ok(pd.captures.includes('GetPartNumber'), 'no pierde GetPartNumber por la colisión de id');
  assert.ok(pd.captures.includes('GetPartNumberInventoryBatch'));
});

test('generateCatalog: determinista — rutas ordenadas por id', () => {
  const scanOps = {
    ZebraQuery: { status: 'known', screens: [{ pathname: '/Domains/344/Zebra', count: 1 }] },
    AlphaQuery: { status: 'known', screens: [{ pathname: '/Domains/344/Alpha', count: 1 }] },
  };
  const ids = Object.keys(generateCatalog(scanOps, typeOf).routes);
  assert.deepEqual(ids, [...ids].sort());
});
