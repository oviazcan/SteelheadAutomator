// tools/test/route-catalog-coherence.test.js
// Invariante del route-catalog: las ops con RUTA MANUAL (_interactionOps = clic-botón;
// _manualRouteOps = detalle con navegación corregida) deben estar SOLO en su ruta
// dedicada. Si aparecieran también en una ruta de pathname (que NO las dispara),
// selectRoutes (set-cover) podría elegir la de pathname y la op quedaría noCapturada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const cat = JSON.parse(readFileSync(join(__dirname, '../hash-autopilot/route-catalog.json'), 'utf8'));

const EXPECTED = {
  CreateEditReceivedOrderDialogQuery: 'salesorders-ro-edit',
  GetAddPartsReceivedOrder: 'salesorders-ro-addparts',
  SensorDashboardQuery: 'maintenance-sensordashboards-detail',
  GetPurchaseOrderDetail: 'purchasing-po-detail',
  GetReceivedOrdersWithReceivedOrderLineItems: 'invoices-packingslips-addinvoice',
  GetAvailableUnits: 'partnumber-units-definenew',
  SpecFieldsAndOptions: 'partnumber-add-spec',
  SearchSpecsForSelect: 'partnumber-add-spec',
  GetInventoryInputSchema: 'inventory-input-schema',
  AllInventoryBatchStatuses: 'receiving-customerparts-status',
  GetPartNumberInventoryBatch: 'receiving-batch-detail',
  OperatorMaintenanceNodeDialogQuery: 'maintenance-event-complete-step',
  // Insights (Nivel B 2026-07-22): solo se disparan con el deep-link CON query params
  // (?id=<INSIGHT>&type=insight); la ruta de pathname /Reporting/View NO las dispara.
  GetInsightsReportDetails: 'reporting-insights-detail',
  GetInsightsReportColumnConfigs: 'reporting-insights-detail',
  // Buscadores type-ahead (2026-07-24): solo se disparan por INTERACCIÓN, no navegando.
  // FilterSearch al ABRIR un filtro de columna de Work Orders (sin teclear); SearchPartNumbers
  // al TECLEAR en el modal 'Agregar Filtro' de /UploadedFiles (categoría 'Número de Parte').
  FilterSearch: 'workorders-filter-open',
  SearchPartNumbers: 'uploadedfiles-pn-filter',
  // Nivel B 2026-07-28: estaba en home-list (goto /) Y en sensor-dashboards (/Dashboards)
  // Y aquí. El set-cover elegía home-list (cubría 2 pendientes) y esta ruta nunca corría;
  // el home dejó de dispararla el 2026-07-22 y solo se capturaba de REBOTE por el paso 0 de
  // maintenance-sensordashboards-detail (misma lista, sink compartido). Ahora vive SOLO aquí.
  AllSensorDashboards: 'sensordashboards-list',
  // Nivel B 2026-08-05 (rotación masiva de SH: 21 hashes stale). Las 3 rutas que
  // declaraban estas ops NUNCA las capturaron —0 aciertos en el log histórico— y nadie
  // lo notó porque solo se ejercitan cuando la op rota. Cada una por un motivo distinto:
  //  · GetMaintenanceEvent: hrefMatches '/Maintenance/\\d+' no puede matchear
  //    '/Maintenance/Events/\\d+' (id tras la SUB-ENTIDAD, como purchasing-po-detail).
  //  · inventario: la ficha del TIPO está dos niveles arriba del lote (tipo→item→batch).
  //  · WorkboardById: la lista no rinde <a> de detalle; los tableros viven en carpetas
  //    colapsadas y hay que expandir una primero.
  GetMaintenanceEvent: 'maintenance-events-detail',
  GetInventoryBatch: 'inventory-item-batch-detail',
  GetInventoryItem: 'inventory-item-batch-detail',
  SearchInventoryItemBatches: 'inventory-item-batch-detail',
  WorkboardById: 'workboards-folder-detail',
};

test('cada op manual está SOLO en su ruta dedicada (no en rutas de pathname)', () => {
  for (const [op, rid] of Object.entries(EXPECTED)) {
    const routes = Object.entries(cat.routes).filter(([, r]) => (r.captures || []).includes(op)).map(([id]) => id);
    assert.deepEqual(routes, [rid], `${op} debe estar SOLO en ${rid}`);
  }
});

test('_interactionOps + _manualRouteOps cubren exactamente las 22 ops manuales', () => {
  const manual = new Set([...(cat._interactionOps || []), ...(cat._manualRouteOps || [])]);
  assert.deepEqual([...manual].sort(), Object.keys(EXPECTED).sort());
});

test('rutas manuales de detalle: goto a la sub-entidad correcta + hrefMatches por sub-entidad', () => {
  const sd = cat.routes['maintenance-sensordashboards-detail'];
  assert.equal(sd.steps[0].goto, '/Domains/{domain}/SensorDashboards');
  assert.match(sd.steps[1].hrefMatches, /ensorDashboard/);
  const po = cat.routes['purchasing-po-detail'];
  assert.equal(po.steps[0].goto, '/Domains/{domain}/Purchasing/PurchaseOrders');
  // el id va tras la SUB-ENTIDAD PurchaseOrders, no tras el module Purchasing
  assert.equal(po.steps[1].hrefMatches, '/Purchasing/PurchaseOrders/\\d+');
});

test('ruta sensordashboards-list: goto DIRECTO a la lista y sin ruta gemela que gane el desempate', () => {
  const r = cat.routes['sensordashboards-list'];
  assert.deepEqual(r.steps, [{ goto: '/Domains/{domain}/SensorDashboards' }]);
  assert.deepEqual(r.captures, ['AllSensorDashboards']);
  // La ruta 'sensor-dashboards' (/Dashboards + clic) capturaba lo mismo y ganaba el
  // desempate alfabético del set-cover ('sensor-' < 'sensord') → se eliminó.
  assert.equal(cat.routes['sensor-dashboards'], undefined);
});

test('rutas manuales de clic-botón: paso clickButton bilingüe', () => {
  assert.equal(cat.routes['salesorders-ro-edit'].steps[2].clickButton, 'edit sales order|editar orden de venta');
  assert.equal(cat.routes['salesorders-ro-addparts'].steps[2].clickButton, 'add parts \\(table\\)|agregar piezas \\(tabla\\)');
});

test('ruta de insights: goto CON query params (?id=…&type=insight) — el pathname solo no basta', () => {
  const r = cat.routes['reporting-insights-detail'];
  assert.match(r.steps[0].goto, /^\/Reporting\/View\?id=[A-Z_]+&type=insight$/);
  assert.deepEqual(r.captures, ['GetInsightsReportColumnConfigs', 'GetInsightsReportDetails']);
});

test('ruta de factura (interacción por aria-label): goto PackingSlips + clickFirst "Add Invoice"', () => {
  const r = cat.routes['invoices-packingslips-addinvoice'];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/Invoices?mode=PackingSlips&roOffset=0');
  // clic en el botón "Add Invoice" (aria-label, NO texto) → abre el modal que dispara la query.
  // SEGURIDAD: la receta NUNCA clica "Crear Factura" (submit) → abre el modal y cierra sin guardar.
  assert.match(r.steps[1].clickFirst, /Add Invoice/);
  assert.deepEqual(r.captures, ['GetReceivedOrdersWithReceivedOrderLineItems']);
});

test('ruta FilterSearch: abre un filtro de columna de Work Orders (clic estructural, sin teclear)', () => {
  const r = cat.routes['workorders-filter-open'];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/WorkOrders');
  // anclaje ESTRUCTURAL por el icono del filtro, excluyendo los MuiSelect (headless en inglés)
  assert.match(r.steps[1].clickFirst, /ArrowDropDownIcon/);
  assert.match(r.steps[1].clickFirst, /:not\(\.MuiSelect-icon\)/);
  assert.deepEqual(r.captures, ['FilterSearch']);
});

// ── Nivel B 2026-08-05 ────────────────────────────────────────────────────────────
// Trinquetes de las 3 recetas re-descubiertas. Cada assert fija el detalle EXACTO que
// las hacía fallar: sin ellos, un rebuild o un "simplificado" los pierde en silencio y
// la op vuelve a no capturarse hasta la próxima rotación (que es cuando duele).
test('ruta GetMaintenanceEvent: lista /Events + id tras la SUB-ENTIDAD', () => {
  const r = cat.routes['maintenance-events-detail'];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/Maintenance/Events');
  // el id va tras Events, no tras el module Maintenance (ese era el bug)
  assert.equal(r.steps[1].hrefMatches, '/Maintenance/Events/\\d+');
  assert.deepEqual(r.captures, ['GetMaintenanceEvent']);
});

test('ruta de lote de inventario: cadena tipo→item→batch con hrefMatches anclados al final', () => {
  const r = cat.routes['inventory-item-batch-detail'];
  assert.equal(r.steps[0].goto, '/InventoryTypes');
  // El '$' evita que el paso del TIPO reclique un href de /Items/ ya presente en su ficha.
  assert.equal(r.steps[1].hrefMatches, '/InventoryTypes/\\d+$');
  assert.equal(r.steps[2].hrefMatches, '/InventoryTypes/\\d+/Items/\\d+$');
  assert.equal(r.steps[3].hrefMatches, '/Items/\\d+/Batches/\\d+');
  assert.deepEqual(r.captures, ['GetInventoryBatch', 'GetInventoryItem', 'SearchInventoryItemBatches']);
});

test('ruta WorkboardById: expande carpeta (once) y EXCLUYE el breadcrumb antes de clicar el tablero', () => {
  const r = cat.routes['workboards-folder-detail'];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/Workboards');
  // sin los :not(), el selector toma el breadcrumb y navega al home — medido en vivo
  assert.match(r.steps[1].clickFirst, /:not\(nav span\)/);
  assert.match(r.steps[1].clickFirst, /:not\(\.MuiBreadcrumbs-root span\)/);
  assert.equal(r.steps[1].once, true); // expandir es setup: re-clicar la colapsaría
  assert.equal(r.steps[2].hrefMatches, '/Workboards/\\d+');
  assert.deepEqual(r.captures, ['WorkboardById']);
});

test('las rutas re-descubiertas usan ids que build-catalog NO auto-genera', () => {
  // generateCatalog solo produce `<module>-list` y `<module>-detail`; si estas rutas
  // se llamaran así, un rebuild SOBRESCRIBIRÍA sus steps (mergedRoutes[id] = {...route}).
  for (const id of ['maintenance-events-detail', 'inventory-item-batch-detail', 'workboards-folder-detail']) {
    assert.ok(cat.routes[id], `falta la ruta ${id}`);
    assert.equal(cat.routes[id].curated, true, `${id} debe ir marcada curated`);
    const mod = cat.routes[id].module.toLowerCase();
    assert.notEqual(id, `${mod}-detail`);
    assert.notEqual(id, `${mod}-list`);
  }
});

test('ruta SearchPartNumbers: modal Agregar Filtro (setup once) + typeInto captura', () => {
  const r = cat.routes['uploadedfiles-pn-filter'];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/UploadedFiles');
  assert.match(r.steps[1].clickFirst, /FilterListIcon/);
  // opción por VALOR estable (idioma-agnóstico), no por texto
  assert.match(r.steps[3].clickFirst, /data-value="partNumberId"/);
  // los 3 clics de setup son once (clic único, no re-clic que cierre el modal/menú)
  assert.equal(r.steps[1].once, true);
  assert.equal(r.steps[2].once, true);
  assert.equal(r.steps[3].once, true);
  // el paso que CAPTURA es el typeInto (search-as-you-type)
  assert.ok(r.steps[4].typeInto);
  assert.deepEqual(r.captures, ['SearchPartNumbers']);
});
