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
  GetInventoryInputSchema: 'inventory-input-schema',
  AllInventoryBatchStatuses: 'receiving-customerparts-status',
  GetPartNumberInventoryBatch: 'receiving-batch-detail',
};

test('cada op manual está SOLO en su ruta dedicada (no en rutas de pathname)', () => {
  for (const [op, rid] of Object.entries(EXPECTED)) {
    const routes = Object.entries(cat.routes).filter(([, r]) => (r.captures || []).includes(op)).map(([id]) => id);
    assert.deepEqual(routes, [rid], `${op} debe estar SOLO en ${rid}`);
  }
});

test('_interactionOps + _manualRouteOps cubren exactamente las 10 ops manuales', () => {
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

test('rutas manuales de clic-botón: paso clickButton bilingüe', () => {
  assert.equal(cat.routes['salesorders-ro-edit'].steps[2].clickButton, 'edit sales order|editar orden de venta');
  assert.equal(cat.routes['salesorders-ro-addparts'].steps[2].clickButton, 'add parts \\(table\\)|agregar piezas \\(tabla\\)');
});

test('ruta de factura (interacción por aria-label): goto PackingSlips + clickFirst "Add Invoice"', () => {
  const r = cat.routes['invoices-packingslips-addinvoice'];
  assert.equal(r.steps[0].goto, '/Domains/{domain}/Invoices?mode=PackingSlips&roOffset=0');
  // clic en el botón "Add Invoice" (aria-label, NO texto) → abre el modal que dispara la query.
  // SEGURIDAD: la receta NUNCA clica "Crear Factura" (submit) → abre el modal y cierra sin guardar.
  assert.match(r.steps[1].clickFirst, /Add Invoice/);
  assert.deepEqual(r.captures, ['GetReceivedOrdersWithReceivedOrderLineItems']);
});
