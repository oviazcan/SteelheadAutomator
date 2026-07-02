// tools/test/pn-lifecycle.test.js
const test = require('node:test');
const assert = require('node:assert');
const { slimPN, applyFilters, discoverFacets } = require('../../remote/scripts/pn-lifecycle-core.js');

const NODE = {
  id: 5, name: 'ABC-1', createdAt: '2026-01-02T00:00:00Z',
  customerByCustomerId: { id: 9, name: 'Fisher' },
  customInputs: { DatosAdicionalesNP: { BaseMetal: 'Cobre', QuoteIBMS: '558' } },
  processNodeByDefaultProcessNodeId: { id: 7, name: 'T204 (EST)' },
  partNumberLabelsByPartNumberId: { nodes: [ { labelByLabelId: { id: 3, name: 'Plata' } } ] },
  acctPnDimensionValueSelectionsByPartNumberId: { nodes: [
    { dimensionId: 349, acctDimensionCustomValueByDimensionCustomValueId: { value: 'L1' } },
    { dimensionId: 586, acctDimensionCustomValueByDimensionCustomValueId: { value: 'D3' } },
  ] },
};
test('slimPN extrae campos enriquecidos', () => {
  const s = slimPN(NODE, true);
  assert.equal(s.id, 5);
  assert.equal(s.customer.name, 'Fisher');
  assert.equal(s.metal, 'Cobre');
  assert.equal(s.quoteIBMS, '558');
  assert.equal(s.proceso, 'T204 (EST)');
  assert.deepEqual(s.labels, [{ id: 3, name: 'Plata' }]);
  assert.equal(s.linea, 'L1');
  assert.equal(s.departamento, 'D3');
  assert.equal(s.archived, true);
});
test('slimPN tolera nodo vacío', () => {
  const s = slimPN({ id: 1, name: 'X' }, false);
  assert.equal(s.metal, ''); assert.equal(s.proceso, ''); assert.deepEqual(s.labels, []);
  assert.equal(s.linea, ''); assert.equal(s.archived, false);
});

const P = [
  { id:1, name:'A', customer:{id:9,name:'Fisher'}, labels:[{id:3,name:'Plata'}], metal:'Cobre', proceso:'T204', linea:'L1', departamento:'D3', createdAt:'2026-01-01T00:00:00Z' },
  { id:2, name:'B', customer:{id:8,name:'Hubbell'}, labels:[{id:4,name:'Zinc'}], metal:'Acero', proceso:'T106', linea:'L2', departamento:'D3', createdAt:'2026-03-01T00:00:00Z' },
  { id:3, name:'C', customer:{id:9,name:'Fisher'}, labels:[{id:3,name:'Plata'},{id:5,name:'Decapado'}], metal:'Cobre', proceso:'T204', linea:'L1', departamento:'D9', createdAt:'2026-05-01T00:00:00Z' },
];
test('applyFilters: cliente', () => {
  assert.deepEqual(applyFilters(P, { customers:[9] }).map(x=>x.id), [1,3]);
});
test('applyFilters: proceso + metal (AND entre criterios)', () => {
  assert.deepEqual(applyFilters(P, { procesos:['T204'], metals:['Cobre'] }).map(x=>x.id), [1,3]);
});
test('applyFilters: etiquetas AND vs OR', () => {
  assert.deepEqual(applyFilters(P, { labels:{names:['Plata','Decapado'],mode:'AND'} }).map(x=>x.id), [3]);
  assert.deepEqual(applyFilters(P, { labels:{names:['Plata','Zinc'],mode:'OR'} }).map(x=>x.id), [1,2,3]);
});
test('applyFilters: fecha before', () => {
  assert.deepEqual(applyFilters(P, { dateFilter:{cutoffISO:'2026-02-01T00:00:00Z',direction:'before'} }).map(x=>x.id), [1]);
});
test('applyFilters: sin criterios = todos', () => {
  assert.equal(applyFilters(P, {}).length, 3);
});
test('discoverFacets: conteos por cliente y proceso', () => {
  const f = discoverFacets(P);
  assert.deepEqual(f.customers.find(c=>c.name==='Fisher'), {name:'Fisher',id:9,count:2});
  assert.equal(f.procesos.length, 2);
});

const classify = require('../../remote/scripts/bulk-upload-classify.js');
const { selectDuplicates, adaptForClassify } = require('../../remote/scripts/pn-lifecycle-core.js');
const NF = ['Muestras','Lote'];
const EQ = [['Plata','Plata Flash']];
const G = [
  { id:1, name:'X', customer:{id:9}, metal:'Cobre', labels:[{name:'Plata'}], archived:false },      // activo
  { id:2, name:'X', customer:{id:9}, metal:'Cobre', labels:[{name:'Plata Flash'}], archived:true },  // dup del activo (Plata≈Plata Flash)
  { id:3, name:'Y', customer:{id:9}, metal:'Cobre', labels:[{name:'Zinc'}], archived:true },          // solo archivado, único
  { id:4, name:'Z', customer:{id:8}, metal:'Acero', labels:[{name:'Zinc'}], archived:true },          // par archivado
  { id:5, name:'Z', customer:{id:8}, metal:'Acero', labels:[{name:'Zinc'}], archived:true },          // par archivado
];
test('selectDuplicates: dup de activo + entre-archivados', () => {
  const r = selectDuplicates(G, { classify, nonFinishList: NF, equivGroups: EQ, scoreFn: (pn)=>pn.id });
  assert.ok(r.toTag.includes(2));            // dup del activo
  assert.ok(!r.toTag.includes(1) && !r.toTag.includes(3)); // activo y único no
  // par Z: conserva mayor score (id 5), marca 4
  assert.ok(r.toTag.includes(4) && !r.toTag.includes(5));
});

const { isInTargetState, buildValidationVars, optInsToDelete, buildArchiveInput } = require('../../remote/scripts/pn-lifecycle-core.js');
const VNODES = [231176, 231174];
test('isInTargetState validate/unvalidate', () => {
  assert.equal(isInTargetState({}, 'validate', VNODES, [231176,231174]), true);   // ya tiene ambos
  assert.equal(isInTargetState({}, 'validate', VNODES, [231176]), false);          // falta uno
  assert.equal(isInTargetState({}, 'unvalidate', VNODES, []), true);               // ya no tiene ninguno
});
test('isInTargetState archive/unarchive por pn.archived', () => {
  assert.equal(isInTargetState({archived:true}, 'unarchive', VNODES), false);
  assert.equal(isInTargetState({archived:false}, 'unarchive', VNODES), true);
});
test('buildValidationVars', () => {
  assert.deepEqual(buildValidationVars(5, 231174), {partNumberId:5, processNodeId:231174, processNodeOccurrence:1, cancelOthers:false});
});
test('optInsToDelete filtra por processNodeId de validación', () => {
  const node = { processNodePartNumberOptInoutsByPartNumberId: { nodes: [
    {id:100, processNodeId:231174}, {id:101, processNodeId:999}, {id:102, processNodeId:231176} ] } };
  assert.deepEqual(optInsToDelete(node, VNODES).sort(), [100,102]);
});
test('buildArchiveInput agrega label preservando labels existentes', () => {
  const node = { id:5, name:'A', partNumberLabelsByPartNumberId:{nodes:[{labelByLabelId:{id:3}}]},
                 customerByCustomerId:{id:9}, inputSchemaId:3223 };
  const inp = buildArchiveInput(node, 15646);
  assert.deepEqual(inp.labelIds.sort((a,b)=>a-b), [3,15646]);
  assert.equal(inp.customerId, 9); assert.equal(inp.id, 5);
});

const { runOneItem } = require('../../remote/scripts/pn-lifecycle-core.js');
test('validate: crea opt-in por cada node; tolera duplicado', async () => {
  const calls = [];
  const api = { query: async (op, v) => { calls.push([op, v.processNodeId ?? v.id ?? null]);
    if (op === 'CreateProcessNodePartNumberOptInout' && v.processNodeId === 231174) throw new Error('unique constraint'); return {}; } };
  const r = await runOneItem({ id:5 }, 'validate', api, { validacionNodeIds:[231176,231174], labelId:15646 });
  assert.equal(r.status, 'ok');
  assert.equal(calls.filter(c=>c[0]==='CreateProcessNodePartNumberOptInout').length, 2);
});
test('unvalidate: GetPartNumber luego Delete por opt-in de validación', async () => {
  const api = { query: async (op, v) => {
    if (op === 'GetPartNumber') return { partNumberById: { processNodePartNumberOptInoutsByPartNumberId: { nodes: [{id:100,processNodeId:231174},{id:101,processNodeId:999}] } } };
    return {}; } };
  const deleted = [];
  const api2 = { query: async (op, v) => { if (op==='GetPartNumber') return api.query(op,v); if (op==='DeleteProcessNodePartNumberOptInOut') deleted.push(v.id); return {}; } };
  const r = await runOneItem({ id:5 }, 'unvalidate', api2, { validacionNodeIds:[231176,231174], labelId:15646 });
  assert.deepEqual(deleted, [100]);   // solo el opt-in de validación (100), no el 101
});

const { INCLUDE_FOR_ACTION, fetchPNsForAction } = require('../../remote/scripts/pn-lifecycle-core.js');
test('mapa acción → includeArchived', () => {
  assert.equal(INCLUDE_FOR_ACTION.validate, 'NO');
  assert.equal(INCLUDE_FOR_ACTION.unarchive, 'EXCLUSIVELY');
});
test('fetchPNsForAction pagina y hace slim', async () => {
  const page = (nodes, total) => ({ pagedData: { nodes, totalCount: total } });
  const api = { query: async (op, v) => v.offset === 0
      ? page([{id:1,name:'A'},{id:2,name:'B'}], 3)
      : page([{id:3,name:'C'}], 3) };
  const pns = await fetchPNsForAction('validate', api, null, 2);
  assert.deepEqual(pns.map(p=>p.id), [1,2,3]);
  assert.equal(pns[0].archived, false); // 'NO' => activos
});
