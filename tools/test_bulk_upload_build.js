// Golden tests de bulk-upload-build.js — congelan la semántica REPLACE/preserve-on-missing
// y los FK-fallbacks (con sus órdenes por campo) ANTES de cablear al pipeline (F4). node --test
const test = require('node:test');
const assert = require('node:assert');
const B = require('../remote/scripts/bulk-upload-build.js');

const m = (obj) => new Map(Object.entries(obj));

// ─── decideLabelIds (invariante #1/#2: dash borra, vacío/unknown preserva, dato reemplaza) ───
test('decideLabelIds: dash ("-") → [] (borrar todo)', () => {
  const r = B.decideLabelIds(['-'], m({ Estaño: 10 }), [7, 8]);
  assert.deepStrictEqual(r.labelIdsToSend, []);
  assert.strictEqual(r.decision, 'clear');
});

test('decideLabelIds: CSV sin labels → preserva existentes', () => {
  const r = B.decideLabelIds([], m({ Estaño: 10 }), [7, 8]);
  assert.deepStrictEqual(r.labelIdsToSend, [7, 8]);
  assert.strictEqual(r.decision, 'preserve-empty');
});

test('decideLabelIds: todos los nombres unknown → preserva existentes (no borra por typo)', () => {
  const r = B.decideLabelIds(['NIQu', 'XXX'], m({ Estaño: 10 }), [7, 8]);
  assert.deepStrictEqual(r.labelIdsToSend, [7, 8]);
  assert.strictEqual(r.decision, 'preserve-allunknown');
  assert.deepStrictEqual(r.unknownLabels, ['NIQu', 'XXX']);
});

test('decideLabelIds: al menos un id válido → REPLACE con los del CSV', () => {
  const r = B.decideLabelIds(['Estaño', 'XXX'], m({ Estaño: 10 }), [7, 8]);
  assert.deepStrictEqual(r.labelIdsToSend, [10]);
  assert.strictEqual(r.decision, 'replace');
  assert.deepStrictEqual(r.unknownLabels, ['XXX']);
});

test('decideLabelIds: todos válidos → REPLACE completo', () => {
  const r = B.decideLabelIds(['Estaño', 'Zinc'], m({ Estaño: 10, Zinc: 11 }), [7]);
  assert.deepStrictEqual(r.labelIdsToSend, [10, 11]);
  assert.strictEqual(r.decision, 'replace');
});

// ─── decideDimValueIds (Línea/Departamento, mismo tri-estado) ───
test('decideDimValueIds: ambos vacíos → preserva existentes', () => {
  const r = B.decideDimValueIds('', '', m({ 'Línea A': 1 }), [3, 4]);
  assert.deepStrictEqual(r.dimValueIdsToSend, [3, 4]);
});

test('decideDimValueIds: ambos dash → [] (borrar)', () => {
  const r = B.decideDimValueIds('-', '-', m({ 'Línea A': 1 }), [3, 4]);
  assert.deepStrictEqual(r.dimValueIdsToSend, []);
});

test('decideDimValueIds: value-ok → envía lookup', () => {
  const r = B.decideDimValueIds('Línea A', '', m({ 'Línea A': 1 }), [3, 4]);
  assert.deepStrictEqual(r.dimValueIdsToSend, [1]);
  assert.strictEqual(r.lineaIntent, 'value-ok');
});

test('decideDimValueIds: lookup roto sin ningún value-ok → preserva (no borra por typo)', () => {
  const r = B.decideDimValueIds('Línea Inexistente', '', m({ 'Línea A': 1 }), [3, 4]);
  assert.deepStrictEqual(r.dimValueIdsToSend, [3, 4]);
  assert.strictEqual(r.lineaIntent, 'value-missing');
  assert.ok(r.warnings.length >= 1);
});

test('decideDimValueIds: mezcla value-ok + dash → envía solo el value-ok', () => {
  const r = B.decideDimValueIds('Línea A', '-', m({ 'Línea A': 1 }), [3, 4]);
  assert.deepStrictEqual(r.dimValueIdsToSend, [1]);
});

// ─── resolveFk + helpers (invariante #3: FK relacional > escalar, órdenes por campo) ───
test('resolveFk: prefiere relName.id sobre scalarName; primer source no-nulo', () => {
  const obj = { customerByCustomerId: { id: 99 }, customerId: null };
  assert.strictEqual(B.resolveFk([[obj, 'customerByCustomerId', 'customerId']], null), 99);
  const obj2 = { customerByCustomerId: null, customerId: 55 };
  assert.strictEqual(B.resolveFk([[obj2, 'customerByCustomerId', 'customerId']], null), 55);
  assert.strictEqual(B.resolveFk([[null, 'x', 'y']], 7), 7); // source nulo → fallback
});

test('resolveCustomerId: pn primero, luego part.customerId', () => {
  assert.strictEqual(B.resolveCustomerId({ customerByCustomerId: { id: 1 } }, null, 2), 1); // pn gana
  assert.strictEqual(B.resolveCustomerId({}, null, 2), 2);                                  // cae a part
});

test('resolveDefaultProcessNodeId: pn primero, luego existingPnNode', () => {
  const pn = { processNodeByDefaultProcessNodeId: { id: 100 } };
  const ex = { processNodeByDefaultProcessNodeId: { id: 200 } };
  assert.strictEqual(B.resolveDefaultProcessNodeId(pn, ex), 100); // pn gana
  assert.strictEqual(B.resolveDefaultProcessNodeId({}, ex), 200); // cae a existing
  assert.strictEqual(B.resolveDefaultProcessNodeId({}, {}), null);
});

test('resolveGeometryTypeId / resolveGroupIdFallback: existingPnNode primero, luego pn', () => {
  const ex = { geometryTypeByGeometryTypeId: { id: 5 } };
  const pn = { geometryTypeByGeometryTypeId: { id: 6 } };
  assert.strictEqual(B.resolveGeometryTypeId(ex, pn), 5); // existing gana
  assert.strictEqual(B.resolveGeometryTypeId({}, pn), 6); // cae a pn
  const exG = { partNumberGroupByPartNumberGroupId: { id: 8 } };
  const pnG = { partNumberGroupByPartNumberGroupId: { id: 9 } };
  assert.strictEqual(B.resolveGroupIdFallback(exG, pnG), 8);
  assert.strictEqual(B.resolveGroupIdFallback({}, pnG), 9);
});
