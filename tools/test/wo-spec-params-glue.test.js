// Tests del glue wo-spec-params.js — la parte orquestable, sin DOM.
// Run: node --test tools/test/wo-spec-params-glue.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = {};
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params-core.js'));
require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params.js'));
const G = global.window.WoSpecParams;
const Core = global.window.WoSpecParamsCore;
const FIX = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-5769.json'), 'utf8'));

// ── Entradas ─────────────────────────────────────────────────────────────────

test('parsePastedWorkOrders: acepta comas, saltos de línea, espacios y # inicial', () => {
  const r = G.parsePastedWorkOrders('5769, 5770\n5771\n\n #5772  \n5769');
  assert.deepEqual(r.ids, [5769, 5770, 5771, 5772]);   // dedup, en orden de aparición
  assert.equal(r.ignored, 0);
});

test('parsePastedWorkOrders: cuenta los renglones que no son números', () => {
  const r = G.parsePastedWorkOrders('5769\nABC\n\n5770\nxx-1');
  assert.deepEqual(r.ids, [5769, 5770]);
  assert.equal(r.ignored, 2);
});

test('parsePastedWorkOrders: entrada vacía no truena', () => {
  assert.deepEqual(G.parsePastedWorkOrders('').ids, []);
  assert.deepEqual(G.parsePastedWorkOrders(null).ids, []);
});

test('isWorkOrderDetailPath / parseWorkOrderIdInDomain', () => {
  assert.equal(G.isWorkOrderDetailPath('/Domains/344/WorkOrders/5769'), true);
  assert.equal(G.isWorkOrderDetailPath('/Domains/344/WorkOrders'), false);
  assert.equal(G.parseWorkOrderIdInDomain('/Domains/344/WorkOrders/5769?x=1'), 5769);
  assert.equal(G.parseWorkOrderIdInDomain('/Domains/344/WorkOrders'), null);
});

// ── Orquestación ─────────────────────────────────────────────────────────────

test('analyzeWorkOrder: cruza las dos consultas y devuelve el plan, sin tocar la red', async () => {
  const calls = [];
  const deps = {
    getWorkOrderIds: async (idInDomain) => { calls.push(['wo', idInDomain]); return { id: 1756468, partNumberIds: [3044551] }; },
    getSpecsInfo: async (pnId, woId) => { calls.push(['specs', pnId, woId]); return FIX.workOrder; },
    getPartNumber: async (id) => { calls.push(['pn', id]); return FIX.partNumber; },
  };
  const res = await G.analyzeWorkOrder(5769, deps);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 1);
  const r = res.results[0];
  assert.equal(r.partNumberId, 3044551);
  assert.equal(r.tally.DIFIERE, 2);
  assert.equal(r.anomalies.length, 5);
  assert.equal(r.plan.parametersToAdd.length, 7);
  assert.deepEqual(calls[0], ['wo', 5769]);
});

test('analyzeWorkOrder: si una OT no resuelve su NP, reporta y no revienta', async () => {
  const deps = {
    getWorkOrderIds: async () => ({ id: 1, partNumberIds: [] }),
    getSpecsInfo: async () => { throw new Error('no debería llamarse'); },
    getPartNumber: async () => { throw new Error('no debería llamarse'); },
  };
  const res = await G.analyzeWorkOrder(5769, deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /número de parte/i);
});

test('analyzeWorkOrder: un error de red en una OT no tumba el análisis', async () => {
  const deps = {
    getWorkOrderIds: async () => { throw new Error('Failed to fetch'); },
    getSpecsInfo: async () => ({}), getPartNumber: async () => ({}),
  };
  const res = await G.analyzeWorkOrder(5769, deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /Failed to fetch/);
});

// ── Resumen ──────────────────────────────────────────────────────────────────

test('summarize: agrega los conteos de varias órdenes', () => {
  const s = G.summarize([
    { tally: { OK: 5, VACIO: 4, DIFIERE: 2, DUPLICADO: 0, AMBIGUO: 1, SIN_CATALOGO: 0 },
      cells: [{ forced: true }, { forced: false }], anomalies: [{}, {}],
      plan: { archiveIds: [1, 2], parametersToAdd: [{}, {}, {}], touched: 6, skipped: [{}] } },
    { tally: { OK: 1, VACIO: 0, DIFIERE: 1, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 2 },
      cells: [{ forced: true }], anomalies: [],
      plan: { archiveIds: [3], parametersToAdd: [{}], touched: 1, skipped: [{}, {}] } },
  ]);
  assert.equal(s.casillas, 16);
  assert.equal(s.aCorregir, 7);
  assert.equal(s.omitidas, 3);
  assert.equal(s.aArchivar, 3);
  assert.equal(s.aAgregar, 4);
  assert.equal(s.forzadas, 2);
  assert.equal(s.anomalias, 2);
});

test('summarize: sobre el fixture real, 1 forzada y 5 anomalías', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const s = G.summarize([Object.assign({}, cls, { plan })]);
  assert.equal(s.forzadas, 1);
  assert.equal(s.anomalias, 5);
  assert.equal(s.aCorregir, 7);
});

// ── Escritura ────────────────────────────────────────────────────────────────

test('applyPlan: archiva ANTES de agregar y respeta el orden', async () => {
  const order = [];
  const deps = {
    archive: async (ids) => { order.push('archive:' + ids.join(',')); return ids; },
    addParams: async (pnId, params) => { order.push('add:' + params.length); return params; },
  };
  const res = await G.applyPlan({ partNumberId: 3044551,
    plan: { archiveIds: [10, 11], parametersToAdd: [{ specFieldId: 1 }] } }, deps);
  assert.deepEqual(order, ['archive:10,11', 'add:1']);
  assert.equal(res.archived, 2);
  assert.equal(res.added, 1);
  assert.equal(res.errors.length, 0);
});

test('applyPlan: si el archivado falla NO agrega (dejaría dos filas vivas en la casilla)', async () => {
  const deps = {
    archive: async () => { throw new Error('boom'); },
    addParams: async () => { throw new Error('no debería llamarse'); },
  };
  const res = await G.applyPlan({ partNumberId: 1,
    plan: { archiveIds: [10], parametersToAdd: [{ specFieldId: 1 }] } }, deps);
  assert.equal(res.added, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /boom/);
});

test('applyPlan: plan vacío no llama a nada', async () => {
  let called = false;
  const deps = { archive: async () => { called = true; }, addParams: async () => { called = true; } };
  const res = await G.applyPlan({ partNumberId: 1, plan: { archiveIds: [], parametersToAdd: [] } }, deps);
  assert.equal(called, false);
  assert.equal(res.archived, 0);
  assert.equal(res.added, 0);
});

test('applyPlan: sin plan no truena', async () => {
  const res = await G.applyPlan({ partNumberId: 1 }, { archive: async () => {}, addParams: async () => {} });
  assert.equal(res.archived, 0);
  assert.equal(res.added, 0);
});

// ── Popup ────────────────────────────────────────────────────────────────────

test('openFromPopup: devuelve de inmediato y difiere la apertura', () => {
  let abierto = false;
  const original = G.open;
  G.open = () => { abierto = true; };
  const r = G.openFromPopup();
  assert.equal(r, true, 'debe devolver algo serializable de inmediato');
  assert.equal(abierto, false, 'no debe abrir de forma síncrona (colgaría el popup)');
  G.open = original;
});

// ── Reporte ──────────────────────────────────────────────────────────────────

test('buildCsv: una fila por casilla tocada, con forzada y ámbito', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const csv = G.buildCsv([{ idInDomain: 5769, partNumberName: '80236-167-07',
    cells: cls.cells, anomalies: cls.anomalies }]);
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /orden/i);
  assert.match(csv, /FORZADA/);
  assert.match(csv, /ANOMALIA/);
  // las 7 casillas que cambian + encabezado + 5 anomalías
  assert.ok(lines.length >= 13, 'esperaba al menos 13 renglones, hay ' + lines.length);
});

test('buildCsv: escapa comillas y comas de los nombres', () => {
  const csv = G.buildCsv([{ idInDomain: 1, partNumberName: 'A,B"C',
    cells: [{ status: 'VACIO', recipeNodeName: 'nodo, con coma', fieldName: 'x', scope: 'EXTERNA',
              forced: false, toArchiveIds: [], toAddWriteId: 5, desired: { refName: 'v' } }],
    anomalies: [] }]);
  assert.match(csv, /"A,B""C"/);
  assert.match(csv, /"nodo, con coma"/);
});

// ── Fase 2: origen por Número de Parte ───────────────────────────────────────

test('parsePastedPartNumbers: separa ids numéricos de nombres', () => {
  const r = G.parsePastedPartNumbers('3044551\n80236-167-07\n 3612955 \nABC-123');
  assert.deepEqual(r.ids, [3044551, 3612955]);
  assert.deepEqual(r.names, ['80236-167-07', 'ABC-123']);
  assert.equal(r.ignored, 0);
});

test('parsePastedPartNumbers: deduplica y respeta el orden', () => {
  const r = G.parsePastedPartNumbers('80236-167-07, 80236-167-07\n3044551\n3044551');
  assert.deepEqual(r.names, ['80236-167-07']);
  assert.deepEqual(r.ids, [3044551]);
});

test('parsePastedPartNumbers: entrada vacía no truena', () => {
  const r = G.parsePastedPartNumbers('');
  assert.deepEqual(r.ids, []);
  assert.deepEqual(r.names, []);
});

test('resolvePartNumbers: un nombre homónimo se expande a TODOS sus NP', async () => {
  const deps = {
    searchPartNumbers: async (q) => ([
      { id: 3044551, name: '80236-167-07' },
      { id: 3612955, name: '80236-167-07' },
      { id: 999, name: '80236-167-07-B' },   // parcial: NO debe entrar
    ]),
    getPartNumber: async (id) => ({ id, name: 'PN' + id }),
  };
  const r = await G.resolvePartNumbers({ ids: [], names: ['80236-167-07'] }, deps);
  assert.deepEqual(r.partNumberIds.sort((a, b) => a - b), [3044551, 3612955]);
  assert.equal(r.porNombre['80236-167-07'].length, 2);
  assert.deepEqual(r.noResueltos, []);
});

test('resolvePartNumbers: un nombre sin coincidencia exacta se reporta', async () => {
  const deps = {
    searchPartNumbers: async () => ([{ id: 1, name: 'OTRO-NOMBRE' }]),
    getPartNumber: async (id) => ({ id, name: 'PN' + id }),
  };
  const r = await G.resolvePartNumbers({ ids: [], names: ['NO-EXISTE'] }, deps);
  assert.deepEqual(r.partNumberIds, []);
  assert.deepEqual(r.noResueltos, ['NO-EXISTE']);
});

test('resolvePartNumbers: los ids pegados pasan directo, sin buscar', async () => {
  let buscó = false;
  const deps = {
    searchPartNumbers: async () => { buscó = true; return []; },
    getPartNumber: async (id) => ({ id, name: 'PN' + id }),
  };
  const r = await G.resolvePartNumbers({ ids: [3044551], names: [] }, deps);
  assert.deepEqual(r.partNumberIds, [3044551]);
  assert.equal(buscó, false);
});

test('findWorkOrdersForPartNumbers: junta las OTs y DEDUPLICA entre NPs', async () => {
  const deps = {
    workOrdersForPartNumber: async (pnId) => (pnId === 1
      ? [{ id: 100, idInDomain: 5769 }, { id: 101, idInDomain: 5770 }]
      : [{ id: 101, idInDomain: 5770 }, { id: 102, idInDomain: 5771 }]),
  };
  const r = await G.findWorkOrdersForPartNumbers([1, 2], deps);
  assert.deepEqual(r.idsInDomain.sort((a, b) => a - b), [5769, 5770, 5771]);
  assert.equal(r.porPartNumber[1].length, 2);
  assert.equal(r.porPartNumber[2].length, 2);
});

test('findWorkOrdersForPartNumbers: un NP sin órdenes no rompe ni aporta', async () => {
  const deps = { workOrdersForPartNumber: async (pnId) => (pnId === 1 ? [{ id: 1, idInDomain: 10 }] : []) };
  const r = await G.findWorkOrdersForPartNumbers([1, 2], deps);
  assert.deepEqual(r.idsInDomain, [10]);
  assert.deepEqual(r.sinOrdenes, [2]);
});

test('findWorkOrdersForPartNumbers: si una consulta falla, lo reporta y sigue', async () => {
  const deps = {
    workOrdersForPartNumber: async (pnId) => {
      if (pnId === 2) throw new Error('Failed to fetch');
      return [{ id: 1, idInDomain: 10 }];
    }
  };
  const r = await G.findWorkOrdersForPartNumbers([1, 2], deps);
  assert.deepEqual(r.idsInDomain, [10]);
  assert.equal(r.errores.length, 1);
  assert.match(r.errores[0], /Failed to fetch/);
});

test('el filtro de órdenes por NP usa partNumberIdFilter — los nombres parecidos NO filtran', () => {
  // Verificado en vivo el 2026-07-28: partNumberIdFilter → 4 órdenes; partNumberIdsFilter,
  // partNumberFilter y partNumberIds devuelven 4284 (el dominio ENTERO) porque el server los
  // IGNORA en silencio. Un typo aquí no falla ruidosamente: procesaría todas las órdenes.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params.js'), 'utf8');
  // Se mira SOLO el cuerpo de workOrdersForPartNumber: fuera de ahí, "partNumberIds" es el
  // nombre legítimo de una estructura interna, y el comentario nombra los malos a propósito.
  const i = src.indexOf('async workOrdersForPartNumber(');
  assert.ok(i > 0, 'no encontré workOrdersForPartNumber');
  const cuerpo = src.slice(i, src.indexOf('\n    }', i));
  assert.match(cuerpo, /partNumberIdFilter:\s*\[partNumberId\]/,
    'debe filtrar con partNumberIdFilter');
  for (const malo of ['partNumberIdsFilter', 'partNumberFilter:', 'partNumberIds:']) {
    assert.equal(cuerpo.includes(malo), false,
      'no uses ' + malo + ' — el server lo ignora en silencio y devuelve el dominio entero');
  }
});

test('el modo por NP está expuesto y cableado', () => {
  assert.equal(typeof G.parsePastedPartNumbers, 'function');
  assert.equal(typeof G.resolvePartNumbers, 'function');
  assert.equal(typeof G.findWorkOrdersForPartNumbers, 'function');
});
