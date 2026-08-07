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
  assert.equal(r.tally.DIFIERE, 1);
  assert.equal(r.tally.DUPLICADO, 1);
  assert.equal(r.anomalies.length, 0);          // v0.4.0: vivir en el nodo raíz ya no es anomalía
  assert.equal(r.fueraDeInspeccion.length, 5);  // pero se reporta dónde viven
  assert.equal(r.plan.parametersToAdd.length, 3);
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

test('summarize: sobre el fixture real, 3 cambios y ninguna anomalía', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const s = G.summarize([Object.assign({}, cls, { plan })]);
  assert.equal(s.anomalias, 0);
  assert.equal(s.aCorregir, 3);
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
  // 3 casillas que cambian + encabezado
  assert.ok(lines.length >= 4, 'esperaba al menos 4 renglones, hay ' + lines.length);
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
// ── Fase 3: escaneo total ────────────────────────────────────────────────────

test('runPool: respeta el límite de concurrencia', async () => {
  let vivos = 0, pico = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await G.runPool(items, 3, async () => {
    vivos++; pico = Math.max(pico, vivos);
    await new Promise(r => setTimeout(r, 5));
    vivos--;
  });
  assert.ok(pico <= 3, 'el pico de concurrencia fue ' + pico + ', esperaba <= 3');
});

test('runPool: procesa TODOS los elementos aunque alguno falle', async () => {
  const hechos = [];
  await G.runPool([1, 2, 3, 4, 5], 2, async (n) => {
    if (n === 3) throw new Error('boom');
    hechos.push(n);
  });
  assert.deepEqual(hechos.sort((a, b) => a - b), [1, 2, 4, 5]);
});

test('runPool: se detiene cuando shouldStop devuelve true', async () => {
  const hechos = [];
  let n = 0;
  await G.runPool([1, 2, 3, 4, 5, 6, 7, 8], 1, async (x) => { hechos.push(x); n++; },
                  () => n >= 3);
  assert.ok(hechos.length <= 4, 'procesó ' + hechos.length + ', esperaba detenerse cerca de 3');
});

test('planScanChunks: trocea la lista en lotes del tamaño pedido', () => {
  const ids = Array.from({ length: 250 }, (_, i) => i + 1);
  const chunks = G.planScanChunks(ids, 100);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 100);
  assert.equal(chunks[2].length, 50);
  assert.deepEqual(chunks.flat(), ids, 'no puede perder ni duplicar órdenes');
});

test('planScanChunks: lista vacía da cero lotes', () => {
  assert.deepEqual(G.planScanChunks([], 100), []);
});

test('mergeCheckpoint: reanuda saltando lo ya hecho', () => {
  const todas = [10, 11, 12, 13, 14];
  const ck = { done: [10, 12], hallazgos: [{ idInDomain: 10 }] };
  const r = G.mergeCheckpoint(todas, ck);
  assert.deepEqual(r.pendientes, [11, 13, 14]);
  assert.equal(r.yaHechas, 2);
  assert.equal(r.hallazgos.length, 1);
});

test('mergeCheckpoint: sin checkpoint procesa todo', () => {
  const r = G.mergeCheckpoint([1, 2, 3], null);
  assert.deepEqual(r.pendientes, [1, 2, 3]);
  assert.equal(r.yaHechas, 0);
});

test('slimResult: guarda lo mínimo para aplicar, NO el crudo de 0.87 MB', () => {
  const cls = Core.classifyWorkOrder(FIX);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3044551 });
  const gordo = { idInDomain: 5769, partNumberId: 3044551, partNumberName: '80236-167-07',
                  workOrderId: 1756468, tally: cls.tally, cells: cls.cells,
                  anomalies: cls.anomalies, orphans: cls.orphans, plan };
  const slim = G.slimResult(gordo);
  assert.equal(slim.idInDomain, 5769);
  assert.equal(slim.plan.parametersToAdd.length, 3);
  assert.equal(slim.nAnomalias, 0);
  // lo pesado NO viaja
  assert.equal(slim.cells, undefined, 'cells trae los nodos crudos: no debe guardarse');
  assert.equal(slim.anomalies, undefined);
  const bytes = JSON.stringify(slim).length;
  assert.ok(bytes < 4000, 'el resultado slim pesa ' + bytes + ' bytes, esperaba < 4000');
});

test('slimResult: una orden sin nada que corregir queda mínima', () => {
  const slim = G.slimResult({ idInDomain: 1, partNumberId: 2, partNumberName: 'X',
    tally: { OK: 5, VACIO: 0, DIFIERE: 0, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 0 },
    cells: [], anomalies: [], orphans: [],
    plan: { archiveIds: [], parametersToAdd: [], touched: 0, skipped: [] } });
  assert.equal(slim.tieneTrabajo, false);
  assert.ok(JSON.stringify(slim).length < 400);
});

// ── CSV: ancho de fila == ancho de encabezado ───────────────────────────────
// Al agregar las columnas `origen` y `spec` (2026-07-30) una fila quedó en 12 contra 14 del
// encabezado: la de anomalías. Un CSV desalineado es peor que uno sin la columna — corre los
// valores de sitio y el analista lee "EXTERNA" donde dice el estado, sin que nada falle.
test('CSV: todas las filas tienen tantas columnas como el encabezado', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params.js'), 'utf8');

  // Cuenta elementos de primer nivel de un array literal, respetando anidamiento.
  const anchoDe = (txt) => {
    let d = 0, n = 1;
    for (const ch of txt) {
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) d--;
      else if (ch === ',' && d === 1) n++;
    }
    return n;
  };

  for (const fn of ['function downloadScanCsv', 'function buildCsv']) {
    const ini = src.indexOf(fn);
    assert.ok(ini > 0, 'no encontré ' + fn);
    const bloque = src.slice(ini, ini + 1900);
    const head = bloque.match(/const rows = \[\[([\s\S]*?)\]\];/);
    assert.ok(head, fn + ': no encontré el encabezado');
    const nh = anchoDe('[' + head[1] + ']');
    const pushes = bloque.match(/rows\.push\(\[[\s\S]*?\]\);/g) || [];
    assert.ok(pushes.length > 0, fn + ': no encontré filas');
    for (const p of pushes) {
      const arr = p.slice(p.indexOf('['), p.lastIndexOf(']') + 1);
      assert.equal(anchoDe(arr), nh,
        fn + ': fila con ancho distinto al encabezado (' + nh + ') → ' + arr.slice(0, 80));
    }
  }
});

test('CSV: el origen del valor viaja en ambos exportadores', () => {
  // Sin `origen` no se puede separar lo respaldado por el NP de la inferencia del catálogo,
  // que es justo la decisión sobre las casillas de PROCESO.
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'remote', 'scripts', 'wo-spec-params.js'), 'utf8');
  const heads = src.match(/const rows = \[\[[\s\S]*?\]\];/g) || [];
  assert.equal(heads.length, 2, 'se esperan dos exportadores de CSV');
  for (const h of heads) assert.match(h, /'origen'/, 'falta la columna origen');
});

// ── La orden que no puede repararse tiene que DECIRLO ────────────────────────
//
// Caso OT 10837 (piso, 2026-08-03): el core detecta 3 campos de la spec del cliente que no
// puede colocar (`faltantesSinDestino`) y correctamente no escribe nada. Pero el glue
// guardaba esa lista sin contarla ni mostrarla: la orden aparecía con `touched: 0` y sin
// una sola señal, indistinguible de una orden sana. En el barrido de fase 3 —que sólo
// conserva el slim— la señal se perdía por completo.
//
// Es el modo de falla que este repo ya pagó en `price-confirm-guard` y `surtido-guard`:
// «no tengo dónde ponerlo» se veía igual que «no hacía falta».
const ANTITARNISH = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-10837.json'), 'utf8'));

test('slimResult: una orden con faltantes sin destino NO se ve como orden sana', () => {
  const cls = Core.classifyWorkOrder(ANTITARNISH);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3016541 });
  const slim = G.slimResult({ idInDomain: 10837, partNumberId: 3016541,
    partNumberName: 'PHA20842', workOrderId: 1844453, tally: cls.tally, cells: cls.cells,
    anomalies: cls.anomalies, orphans: cls.orphans,
    faltantesSinDestino: cls.faltantesSinDestino, plan });
  assert.equal(slim.tieneTrabajo, false, 'no hay nada que escribir, y eso es correcto');
  assert.equal(slim.nSinDestino, 3,
    'pero el conteo debe viajar en el slim: es la única señal de que quedó sin aplicar');
});

test('slimResult: sin faltantes el conteo es 0, no undefined', () => {
  const slim = G.slimResult({ idInDomain: 1, partNumberId: 2, partNumberName: 'X',
    tally: { OK: 5, VACIO: 0, DIFIERE: 0, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 0 },
    cells: [], anomalies: [], orphans: [], faltantesSinDestino: [],
    plan: { archiveIds: [], parametersToAdd: [], touched: 0, skipped: [] } });
  assert.equal(slim.nSinDestino, 0);
});

test('summarize: agrega los faltantes sin destino de todas las órdenes', () => {
  const cls = Core.classifyWorkOrder(ANTITARNISH);
  const plan = Core.buildWritePlan(cls, { partNumberId: 3016541 });
  const uno = Object.assign({}, cls, { plan });
  const s = G.summarize([uno, uno]);
  assert.equal(s.sinDestino, 6, 'dos órdenes con 3 campos cada una');
});

// ── Rescate por receta maestra: el cableado ─────────────────────────────────
const ANTI = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-10837.json'), 'utf8'));
const MASTERS_G = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wo-spec-params-masters.json'), 'utf8'));

function antiDeps(calls) {
  G.resetMasterCache();   // la caché de recetas es global: cada test parte de cero
  return {
    getWorkOrderIds: async () => ({ id: 1844453, partNumberIds: [3016541] }),
    getSpecsInfo: async () => ANTI.workOrder,
    getPartNumber: async () => ANTI.partNumber,
    getProcessNode: async (id, occ, rootId) => {
      calls.push({ id, occ, rootId });
      return MASTERS_G[String(id)] || null;
    }
  };
}

test('rescate: la OT 10837 se repara consultando la receta maestra', async () => {
  const calls = [];
  const res = await G.analyzeWorkOrder(10837, antiDeps(calls));
  assert.equal(res.ok, true);
  const r = res.results[0];
  assert.equal(r.plan.parametersToAdd.length, 3, 'los 3 criterios del cliente se aplican');
  assert.equal((r.faltantesSinDestino || []).length, 0);
  for (const a of r.plan.parametersToAdd) assert.equal(a.recipeNodeId, 44947411);
});

test('rescate: GetProcessNode va con las TRES variables (id, ocurrencia y raíz)', async () => {
  const calls = [];
  await G.analyzeWorkOrder(10837, antiDeps(calls));
  assert.ok(calls.length > 0, 'debe haber consultado la receta');
  for (const c of calls) {
    assert.ok(c.id != null, 'id');
    assert.ok(c.occ != null, 'processNodeOccurrence — sin ella el server responde error, no datos');
    assert.equal(c.rootId, 170989, 'rootId = maestro del nodo PROCESS de la orden');
  }
});

test('rescate: una orden SIN faltantes no dispara ni una consulta extra', async () => {
  const calls = [];
  const deps = {
    getWorkOrderIds: async () => ({ id: 1756468, partNumberIds: [3044551] }),
    getSpecsInfo: async () => FIX.workOrder,
    getPartNumber: async () => FIX.partNumber,
    getProcessNode: async (id) => { calls.push(id); return null; }
  };
  await G.analyzeWorkOrder(5769, deps);
  assert.equal(calls.length, 0,
    'la consulta de receta es cara: sólo se paga cuando la orden dejó campos sin destino');
});

test('rescate: si la receta maestra no se puede leer, la orden no truena', async () => {
  const deps = Object.assign(antiDeps([]), {
    getProcessNode: async () => { throw new Error('403'); }
  });
  const res = await G.analyzeWorkOrder(10837, deps);
  assert.equal(res.ok, true);
  const r = res.results[0];
  assert.equal(r.plan.parametersToAdd.length, 0, 'sin receta no se adivina destino');
  assert.equal((r.faltantesSinDestino || []).length, 3, 'y se reporta lo que quedó sin aplicar');
});

// ── dedup de hallazgos: el candado que evita BORRAR una casilla ──────────────
// Con `migrarAInspeccion` encendido, procesar una orden dos veces no es ruido: la segunda
// pasada archiva la casilla que la primera acababa de crear y la deja HUECA. Fue el incidente
// de la OT 15928 (2026-08-04): 2 de 2,549 casillas quedaron vacías, y las 2 eran justo las
// únicas repetidas del reporte. La repetición nace de `allOpenWorkOrders`, que pagina con
// ID_DESC y sin deduplicar: en 40 min una orden cambia de estado y sale en dos páginas.
const H = (idInDomain, partNumberId, marca) => ({ idInDomain, partNumberId, marca });

test('dedupHallazgos: una orden repetida queda UNA vez', () => {
  const r = G.dedupHallazgos([H(15928, 3798757, 'a'), H(15928, 3798757, 'b')]);
  assert.equal(r.length, 1);
});
test('dedupHallazgos: gana el ÚLTIMO (es el análisis más fresco)', () => {
  const r = G.dedupHallazgos([H(15928, 3798757, 'viejo'), H(15928, 3798757, 'nuevo')]);
  assert.equal(r[0].marca, 'nuevo');
});
test('dedupHallazgos: la misma orden con NP distinto NO se colapsa', () => {
  // Una orden con piezas de dos números de parte produce dos hallazgos legítimos: la unidad
  // es (orden, NP), no la orden. Colapsar por idInDomain perdería trabajo real.
  const r = G.dedupHallazgos([H(16000, 111, 'a'), H(16000, 222, 'b')]);
  assert.equal(r.length, 2);
});
test('dedupHallazgos: conserva el orden de aparición', () => {
  const r = G.dedupHallazgos([H(1, 10), H(2, 20), H(1, 10), H(3, 30)]);
  assert.deepEqual(r.map(x => x.idInDomain), [1, 2, 3]);
});
test('dedupHallazgos: tolera nulos y lista vacía', () => {
  assert.deepEqual(G.dedupHallazgos(null), []);
  assert.deepEqual(G.dedupHallazgos([null, undefined]), []);
});

test('mergeCheckpoint: deduplica la COLA por procesar (la lista puede traer repetidos)', () => {
  const r = G.mergeCheckpoint([5, 6, 5, 7, 6], null);
  assert.deepEqual(r.pendientes, [5, 6, 7], 'una orden repetida se procesaría dos veces');
});
test('mergeCheckpoint: deduplica los hallazgos que venían del checkpoint', () => {
  const ck = { done: [1], hallazgos: [H(15928, 3798757, 'a'), H(15928, 3798757, 'b')] };
  assert.equal(G.mergeCheckpoint([2, 3], ck).hallazgos.length, 1);
});
test('mergeCheckpoint: dedup y salto de hechas conviven', () => {
  const r = G.mergeCheckpoint([1, 2, 2, 3], { done: [1], hallazgos: [] });
  assert.deepEqual(r.pendientes, [2, 3]);
  assert.equal(r.yaHechas, 1);
});
