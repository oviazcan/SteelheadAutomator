// tools/test/applet-gate.test.js
// Golden tests del gate de carga de applets (extension/applet-gate.js) y de la
// coherencia entre los `urlPatterns` del config y el gate real de cada applet.
// Run: node --test tools/test/applet-gate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Gate = require('../../extension/applet-gate.js');
const config = require('../../remote/config.json');

const R = p => path.join(__dirname, '../../remote/scripts', p);

// ---------------------------------------------------------------------------
// matchesUrlPatterns — el gate es FAIL-OPEN por diseño
// ---------------------------------------------------------------------------

test('matchesUrlPatterns: sin patrones el applet carga en todas partes (retrocompatible)', () => {
  assert.equal(Gate.matchesUrlPatterns(undefined, '/Domains/1/Purchasing/PurchaseOrders'), true);
  assert.equal(Gate.matchesUrlPatterns([], '/lo/que/sea'), true);
  assert.equal(Gate.matchesUrlPatterns(null, '/'), true);
});

test('matchesUrlPatterns: un patrón que no compila NO deja al operador sin su applet', () => {
  assert.equal(Gate.matchesUrlPatterns(['('], '/Domains/1/Invoices'), true);          // único patrón roto → fail-open
  assert.equal(Gate.matchesUrlPatterns(['(', '/Bills'], '/Domains/1/Invoices'), false); // hay uno válido → él manda
  assert.equal(Gate.matchesUrlPatterns(['(', '/Bills'], '/Domains/1/Bills'), true);
});

test('matchesUrlPatterns: matchea case-insensitive y contra el pathname dado', () => {
  assert.equal(Gate.matchesUrlPatterns(['^/Domains/\\d+/Shipping'], '/domains/12/shipping'), true);
  assert.equal(Gate.matchesUrlPatterns(['^/Domains/\\d+/Shipping'], '/Domains/12/Shipping/PackingSlips'), true);
  assert.equal(Gate.matchesUrlPatterns(['^/Domains/\\d+/Shipping/?(?:[?#]|$)'], '/Domains/12/Shipping/PackingSlips'), false);
});

test('matchesUrlPatterns: pathname vacío o nulo no truena', () => {
  assert.equal(Gate.matchesUrlPatterns(['^/x'], null), false);
  assert.equal(Gate.matchesUrlPatterns(['^/x'], undefined), false);
});

// ---------------------------------------------------------------------------
// selectAutoInjectApps
// ---------------------------------------------------------------------------

const APPS = [
  { id: 'sin-gate', autoInject: true, scripts: ['scripts/steelhead-api.js', 'scripts/a.js'] },
  { id: 'solo-facturas', autoInject: true, urlPatterns: ['/Domains/\\d+/Invoices(?:/|$)'], scripts: ['scripts/steelhead-api.js', 'scripts/b.js'] },
  { id: 'manual', autoInject: false, urlPatterns: ['/'], scripts: ['scripts/c.js'] }
];

test('selectAutoInjectApps: filtra por ruta y respeta autoInject', () => {
  const enInvoices = Gate.selectAutoInjectApps(APPS, '/Domains/344/Invoices', {}).map(a => a.id);
  assert.deepEqual(enInvoices, ['sin-gate', 'solo-facturas']);

  const enCompras = Gate.selectAutoInjectApps(APPS, '/Domains/344/Purchasing/PurchaseOrders', {}).map(a => a.id);
  assert.deepEqual(enCompras, ['sin-gate']);   // el de facturas ya no se descarga aquí
});

test('selectAutoInjectApps: solo `=== false` apaga un applet (undefined = encendido)', () => {
  const off = { soloFacturasEnabled: false };
  assert.deepEqual(Gate.selectAutoInjectApps(APPS, '/Domains/1/Invoices', off).map(a => a.id), ['sin-gate']);
  assert.deepEqual(Gate.selectAutoInjectApps(APPS, '/Domains/1/Invoices', { soloFacturasEnabled: undefined }).map(a => a.id),
    ['sin-gate', 'solo-facturas']);
});

test('storageKeyForApp: conserva la convención camelCase + Enabled', () => {
  assert.equal(Gate.storageKeyForApp('cfdi-attacher'), 'cfdiAttacherEnabled');
  assert.equal(Gate.storageKeyForApp('po-listing-filters'), 'poListingFiltersEnabled');
  assert.equal(Gate.storageKeyForApp('archiver'), 'archiverEnabled');
});

test('storageKeysForApps: una sola lectura de storage para todos', () => {
  assert.deepEqual(Gate.storageKeysForApps(APPS), ['sinGateEnabled', 'soloFacturasEnabled', 'manualEnabled']);
});

// ---------------------------------------------------------------------------
// dedupeScriptPaths — steelhead-api.js se bajaba 24 veces por carga
// ---------------------------------------------------------------------------

test('dedupeScriptPaths: no repite archivos y conserva el orden de dependencia', () => {
  assert.deepEqual(Gate.dedupeScriptPaths(APPS),
    ['scripts/steelhead-api.js', 'scripts/a.js', 'scripts/b.js', 'scripts/c.js']);
});

test('dedupeScriptPaths: tolera apps sin scripts', () => {
  assert.deepEqual(Gate.dedupeScriptPaths([{ id: 'x' }, { id: 'y', scripts: ['s.js'] }]), ['s.js']);
  assert.deepEqual(Gate.dedupeScriptPaths(null), []);
});

test('findDependencyViolations: detecta un glue que quedaría antes de su dependencia', () => {
  const bad = Gate.findDependencyViolations([
    { id: 'a', scripts: ['glue-b.js', 'glue-a.js'] },   // glue-b se ve primero…
    { id: 'b', scripts: ['dep.js', 'glue-b.js'] }        // …y aquí necesita dep.js antes
  ]);
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0], { app: 'b', dep: 'dep.js', glue: 'glue-b.js' });
});

test('findDependencyViolations: el orden entre dependencias hermanas no es violación', () => {
  const bad = Gate.findDependencyViolations([
    { id: 'a', scripts: ['api.js', 'core.js', 'glue-a.js'] },
    { id: 'b', scripts: ['core.js', 'api.js', 'glue-b.js'] }   // orden invertido, sin dependencia real
  ]);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// chunkScripts / runPool
// ---------------------------------------------------------------------------

test('chunkScripts: corta por cantidad y por peso acumulado', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ path: `s${i}.js`, code: 'x'.repeat(100) }));
  assert.equal(Gate.chunkScripts(items, 100000, 2).length, 3);
  assert.equal(Gate.chunkScripts(items, 250, 99).length, 3);   // 2 por lote por peso
});

test('chunkScripts: un archivo más grande que el presupuesto va solo, no se pierde', () => {
  const items = [{ path: 'a.js', code: 'x'.repeat(10) }, { path: 'big.js', code: 'x'.repeat(5000) }, { path: 'b.js', code: 'x'.repeat(10) }];
  const chunks = Gate.chunkScripts(items, 1000, 99);
  assert.deepEqual(chunks.flat().map(i => i.path), ['a.js', 'big.js', 'b.js']);   // orden intacto
  assert.deepEqual(chunks.map(c => c.map(i => i.path)), [['a.js'], ['big.js'], ['b.js']]);
});

test('runPool: respeta la concurrencia y devuelve resultados en orden', async () => {
  let live = 0, peak = 0;
  const out = await Gate.runPool([1, 2, 3, 4, 5, 6], async n => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5));
    live--;
    return n * 2;
  }, 2);
  assert.ok(peak <= 2, `concurrencia ${peak} > 2`);
  assert.deepEqual(out.map(r => r.value), [2, 4, 6, 8, 10, 12]);
});

test('runPool: un fallo no tumba a los demás (allSettled explícito)', async () => {
  const out = await Gate.runPool(['ok', 'boom', 'ok2'], async v => {
    if (v === 'boom') throw new Error('falló');
    return v;
  }, 3);
  assert.deepEqual(out.map(r => r.ok), [true, false, true]);
  assert.equal(out[1].error.message, 'falló');
});

// ---------------------------------------------------------------------------
// Caché de código
// ---------------------------------------------------------------------------

test('codeCacheKey: la version es parte de la clave (cache-bust automático)', () => {
  assert.notEqual(Gate.codeCacheKey('scripts/a.js', '1.7.213'), Gate.codeCacheKey('scripts/a.js', '1.7.214'));
});

test('staleCacheKeys: limpia versiones viejas y no toca otras claves', () => {
  const keys = [
    Gate.codeCacheKey('scripts/a.js', '1.7.213'),
    Gate.codeCacheKey('scripts/a.js', '1.7.214'),
    'sa_scanning', 'config', 'sa_claude_api_key'
  ];
  assert.deepEqual(Gate.staleCacheKeys(keys, '1.7.214'), [Gate.codeCacheKey('scripts/a.js', '1.7.213')]);
});

// ---------------------------------------------------------------------------
// Coherencia config ↔ applet real
//
// El riesgo del gate por ruta es que el patrón del config y el gate del applet
// diverjan: si el config es MÁS estricto, el applet nunca se descarga y muere en
// silencio. Estos tests exigen la implicación "el applet dice que aplica ⇒ el
// config lo deja pasar" contra el gate real exportado por cada core.
// ---------------------------------------------------------------------------

const CORPUS = [
  '/', '/Domains/344', '/Domains/344/PartNumbers', '/Domains/344/PartNumbers/8812',
  '/Domains/344/WorkOrders', '/Domains/344/WorkOrders/9001', '/Domains/344/WorkOrders/9001/Print',
  '/Domains/344/Invoices', '/Domains/344/Invoices/551', '/Domains/344/Bills', '/Domains/344/Bills/22',
  '/Domains/344/Shipping', '/Domains/344/Shipping/PackingSlips', '/Domains/344/Shipping/PackingSlips/77',
  '/Domains/344/Purchasing/PurchaseOrders', '/Domains/344/Purchasing/PurchaseOrders/1841',
  '/Domains/344/ReceivedOrders', '/Domains/344/ReceivedOrders/4102',
  '/Domains/344/SalesOrders', '/Domains/344/SalesOrders/12', '/Receiving/CustomerParts',
  '/Domains/344/Workboards', '/Domains/344/Workboards/71',
  '/Schedules/454/ScheduleBoard/453', '/Schedules/454',
  '/Domains/344/Maintenance/SensorDashboards/9', '/Domains/344/Inventory',
  '/Domains/344/Vendors/6', '/Domains/344/Customers/3', '/Domains/344/Specs/12/Revisions/1'
];

const appById = id => (config.apps || []).find(a => a.id === id);

function assertGateImplication(appId, isApplicable) {
  const app = appById(appId);
  assert.ok(app, `no existe el app ${appId} en config.json`);
  assert.ok(Array.isArray(app.urlPatterns) && app.urlPatterns.length, `${appId} sin urlPatterns`);
  for (const p of CORPUS) {
    if (!isApplicable(p)) continue;
    assert.equal(Gate.matchesUrlPatterns(app.urlPatterns, p), true,
      `${appId}: el applet aplica en "${p}" pero el config NO lo cargaría`);
  }
}

test('coherencia: batch-name-filter (SHIPPING_URL_RE del core)', () => {
  const Core = require(R('batch-name-filter-core.js'));
  assertGateImplication('batch-name-filter', Core.isShippingUrl);
});

test('coherencia: schedule-batch-highlighter (SCHEDULE_BOARD_URL_RE del core)', () => {
  const Core = require(R('schedule-batch-highlighter-core.js'));
  assertGateImplication('schedule-batch-highlighter', Core.isScheduleBoardUrl);
});

test('coherencia: po-listing-filters (PO_URL_RE del core)', () => {
  const Core = require(R('po-listing-filters-core.js'));
  assertGateImplication('po-listing-filters', Core.isPurchaseOrdersUrl);
});

test('coherencia: pn-specs-column (PN_INDEX_RE del core)', () => {
  const Core = require(R('pn-specs-column-core.js'));
  assertGateImplication('pn-specs-column', Core.isPartNumbersIndexPath);
});

test('coherencia: create-order-autofill (matchesCreateOrderUrl del core)', () => {
  const Core = require(R('create-order-autofill-core.js'));
  assertGateImplication('create-order-autofill', Core.matchesCreateOrderUrl);
});

test('coherencia: sensor-graph-hide-all (DASHBOARD_URL_RE del core)', () => {
  const Core = require(R('sensor-graph-hide-all-core.js'));
  assertGateImplication('sensor-graph-hide-all', Core.isDashboardPath);
});

test('coherencia: wo-schedule-button y wo-listing-columns (wo-schedule-core)', () => {
  const Core = require(R('wo-schedule-core.js'));
  assertGateImplication('wo-schedule-button', Core.isWorkOrderDetailPath);
  assertGateImplication('wo-listing-columns', Core.isWorkOrdersIndexPath);
});

// ---------------------------------------------------------------------------
// El caso que originó todo: /Purchasing/PurchaseOrders
// ---------------------------------------------------------------------------

test('en Compras solo entra po-listing-filters de los applets ya gateados', () => {
  const ruta = '/Domains/344/Purchasing/PurchaseOrders';
  const cargados = Gate.selectAutoInjectApps(config.apps, ruta, {}).map(a => a.id);
  const gateados = (config.apps || []).filter(a => a.autoInject && a.urlPatterns).map(a => a.id);
  const gateadosQueCargan = cargados.filter(id => gateados.includes(id));
  assert.deepEqual(gateadosQueCargan, ['po-listing-filters']);
});

// Los applets modal-driven no exportan un gate propio (se montan observando un diálogo),
// así que su contrato son las pantallas que dio el operador el 2026-07-27. Fijarlas en un
// test es lo que evita que se aprieten "de memoria" en un refactor.
test('modal-driven: "Receive Parts" carga donde el operador lo abre', () => {
  for (const id of ['weight-quick-entry', 'receiver-date-override', 'warehouse-location-prefill']) {
    const app = appById(id);
    for (const ruta of ['/Receiving/CustomerParts', '/Domains/344/SalesOrders/4102']) {
      assert.equal(Gate.matchesUrlPatterns(app.urlPatterns, ruta), true, `${id} debe cargar en ${ruta}`);
    }
    assert.equal(Gate.matchesUrlPatterns(app.urlPatterns, '/Domains/344/Purchasing/PurchaseOrders'), false,
      `${id} no tiene nada que hacer en Compras`);
  }
});

test('modal-driven: edición de NP cubre PartNumbers, recibo y cotizaciones', () => {
  for (const id of ['unit-autoconvert', 'proceso-calculator', 'load-calculator']) {
    const app = appById(id);
    for (const ruta of ['/PartNumbers/8812', '/Domains/344/PartNumbers', '/Receiving/CustomerParts',
                        '/Domains/344/Quotes/12', '/Domains/344/SalesOrders/77']) {
      assert.equal(Gate.matchesUrlPatterns(app.urlPatterns, ruta), true, `${id} debe cargar en ${ruta}`);
    }
  }
});

test('modal-driven: los de facturas cargan en Invoices', () => {
  for (const id of ['cfdi-attacher', 'invoice-auto-regen']) {
    const app = appById(id);
    assert.equal(Gate.matchesUrlPatterns(app.urlPatterns, '/Domains/344/Invoices/551'), true);
    assert.equal(Gate.matchesUrlPatterns(app.urlPatterns, '/Domains/344/Bills'), false);
  }
});

// CANDADO DE DECISIÓN — si este test se pone rojo, léelo antes de "arreglarlo".
test('price-confirm-guard y report-regen se quedan SIN urlPatterns a propósito', () => {
  const sinGate = (config.apps || []).filter(a => a.autoInject && !a.urlPatterns).map(a => a.id).sort();
  assert.deepEqual(sinGate, ['price-confirm-guard', 'report-regen'],
    'price-confirm-guard es un CANDADO DE SEGURIDAD y la lista de pantallas donde se edita un ' +
    'precio NO es exhaustiva ("también en otros urls" — operador 2026-07-27): un patrón incompleto ' +
    'lo apaga EN SILENCIO y deja pasar una captura de precio sin reconfirmar. report-regen debe ' +
    'aparecer en TODAS las pantallas por pedido del operador. Si vas a gatear alguno, necesitas ' +
    'evidencia de las pantallas, no memoria.');
});

test('cada applet gateado sigue cargando en SU pantalla', () => {
  const CANONICAS = {
    'wo-schedule-button': '/Domains/344/WorkOrders/9001',
    'batch-name-filter': '/Domains/344/Shipping',
    'schedule-batch-highlighter': '/Schedules/454/ScheduleBoard/453',
    'po-reconciler': '/Domains/344/ReceivedOrders',
    'wo-mover': '/Domains/344/ReceivedOrders/4102',
    'invoice-default-tab': '/Domains/344/Invoices',
    'invoice-listing-marker': '/Domains/344/Invoices',
    'paros-linea': '/Domains/344/Workboards/71',
    'vale-almacen': '/Domains/344/Workboards/71',
    'create-order-autofill': '/Domains/344/SalesOrders',
    'bill-autofill': '/Domains/344/Bills',
    'invoice-autofill': '/Domains/344/Invoices',
    'sensor-graph-hide-all': '/Domains/344/Maintenance/SensorDashboards/9',
    'pn-specs-column': '/Domains/344/PartNumbers',
    'wo-listing-columns': '/Domains/344/WorkOrders',
    'auto-router': '/Schedules/454/ScheduleBoard/453',
    'surtido-guard': '/Domains/344/Workboards/71',
    'po-listing-filters': '/Domains/344/Purchasing/PurchaseOrders',
    'weight-quick-entry': '/Receiving/CustomerParts',
    'receiver-date-override': '/Receiving/CustomerParts',
    'warehouse-location-prefill': '/Domains/344/SalesOrders/4102',
    'unit-autoconvert': '/PartNumbers/8812',
    'proceso-calculator': '/Domains/344/Quotes/12',
    'load-calculator': '/Domains/344/PartNumbers',
    'cfdi-attacher': '/Domains/344/Invoices/551',
    'invoice-auto-regen': '/Domains/344/Invoices'
  };
  for (const [id, ruta] of Object.entries(CANONICAS)) {
    const cargados = Gate.selectAutoInjectApps(config.apps, ruta, {}).map(a => a.id);
    assert.ok(cargados.includes(id), `${id} NO se cargaría en su pantalla ${ruta}`);
  }
});

test('todo urlPatterns del config compila como regex', () => {
  for (const app of (config.apps || [])) {
    for (const p of (app.urlPatterns || [])) {
      assert.doesNotThrow(() => new RegExp(p), `${app.id}: patrón inválido ${p}`);
    }
  }
});

test('en el orden dedupeado, ningún applet del config se evalúa antes que sus dependencias', () => {
  assert.deepEqual(Gate.findDependencyViolations(config.apps), []);
});
