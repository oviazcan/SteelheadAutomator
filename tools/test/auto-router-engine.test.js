// tools/test/auto-router-engine.test.js
// Golden tests del motor puro del autoruteador, contra el ground-truth REAL:
// re-ruteo manual de la WO 1760978 (PN S1D3852A01) de la línea T204 a la T205.
// Run: node --test tools/test/auto-router-engine.test.js
//
// El fixture (tools/test/fixtures/auto-router-wo1760978.json) trae:
//   · recipeNodes   — el árbol real (61 nodos) capturado de StationTreatmentByWorkOrder.
//   · candidatesByTreatment — tinas T205 candidatas por tratamiento (reconstruidas
//     de la línea T205; las multi-tina de enjuague traen el set completo).
//   · expected      — las 34 rutas que el operador armó a mano (CreateUpdateDeleteRoutes).
//
// Garantías DURAS (el motor nunca debe fallar estas):
//   · bypass de bloques de otra línea (T300) → conservan su tina default.
//   · tratamientos de 1 sola tina destino → reúso exacto.
//   · roles distintivos (Plata Flash, Enjuague Recuperador) → match por nombre.
//   · ninguna tina de enjuague se asigna dos veces; todas las rutas son válidas.
// Los enjuagues GENÉRICOS (momentum) son best-effort → se mide cobertura (soft).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../../remote/scripts/auto-router-engine.js');

const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'auto-router-wo1760978.json'), 'utf8')
);

function run() {
  return Engine.computeRoutes({
    recipeNodes: fx.recipeNodes,
    candidatesByTreatment: fx.candidatesByTreatment,
    sourceLineCode: fx.sourceLineCode,
    destLineCode: fx.destLineCode,
    partNumberId: fx.partNumberId,
    workOrderId: fx.workOrderId,
  });
}

const expById = new Map(fx.expected.map((r) => [r.recipeNodeId, r.stationId]));
const nodeById = new Map(fx.recipeNodes.map((n) => [n.id, n]));
const GENERIC_ENJ_TID = 71283;

test('helpers: physPos / extractLineCode / isLineStation', () => {
  assert.equal(Engine.physPos('T205-TI00-019 Enjuague'), 19);
  assert.equal(Engine.physPos('T205-EN00-001 Enracado'), 1);
  assert.equal(Engine.physPos('T205-LI Plata y Estaño s/Barras (16.3)'), null);
  assert.equal(Engine.extractLineCode('T205-TI00-019 Enjuague'), 'T205');
  assert.equal(Engine.extractLineCode('T300-CE05-001 …'), 'T300');
  assert.equal(Engine.isLineStation('T205-LI Plata y Estaño s/Barras (16.3)'), true);
  assert.equal(Engine.isLineStation('T205-TI00-019 Enjuague'), false);
  assert.equal(Engine.isLineStation('T205-EN00-001 Enracado'), false);
});

test('destinationLines: TODAS las líneas del tratamiento de nivel-línea (Planificación)', () => {
  // 98620 = "Listo para Procesar" (selector de línea, stations "-LI"); 71283 = Enjuague (tinas, muchas líneas).
  const cbt = {
    98620: [
      { id: 1, name: 'T107-LI Plata Colgado Cx (60)' }, { id: 2, name: 'T110-LI Plata Colgado (26)' },
      { id: 3, name: 'T204-LI Plata y Estaño s/Cobre Colgado (16.1)' }, { id: 4, name: 'T205-LI Plata y Estaño s/Barras (16.3)' },
    ],
    71283: [
      { id: 10, name: 'T101-TI00-002 Enjuague' }, { id: 11, name: 'T205-TI00-019 Enjuague' }, { id: 12, name: 'T999-TI00-003 Enjuague' },
    ],
  };
  // TODAS las del selector (incl. la origen T204, para poder devolver); NUNCA T101/T999 de los enjuagues.
  assert.deepEqual(Engine.destinationLines(cbt, 'T204'), ['T107', 'T110', 'T204', 'T205']);
});

test('destinationLines: fallback a unión si no hay selector de línea', () => {
  const cbt = { 71283: [{ id: 1, name: 'T101-TI00-002 Enjuague' }, { id: 2, name: 'T205-TI00-019 Enjuague' }] };
  assert.deepEqual(Engine.destinationLines(cbt, 'T204'), ['T101', 'T205']);
});

const SELECTOR_CBT = {
  98620: [
    { id: 1, name: 'T107-LI Plata Colgado' }, { id: 2, name: 'T110-LI Plata' },
    { id: 3, name: 'T204-LI Plata y Estaño s/Cobre' }, { id: 4, name: 'T205-LI Plata y Estaño s/Barras' },
  ],
};

test('destinationLines: ofrece TODAS las líneas (incl. la original) para poder devolver', () => {
  // BUG previo (Image #6): se excluía la "línea actual" (detección frágil con activeRoutes
  // mixtas) y desaparecía la línea a la que el operador quería REGRESAR la orden (ej. T111).
  // Ahora se ofrecen todas; el conteo de cambios reales indica cuál aplica.
  assert.deepEqual(Engine.destinationLines(SELECTOR_CBT, 'T204'), ['T107', 'T110', 'T204', 'T205']);
});

test('effectiveChangeCount: cuenta solo tinas que cambian vs la efectiva actual (activeRoute ?? default)', () => {
  const recipeNodes = [
    { id: 1, treatmentId: 10, defaultStation: { id: 100, name: 'T204-TI00-001 Proc' } },
    { id: 2, treatmentId: 11, defaultStation: { id: 200, name: 'T204-TI00-002 Proc' } },
  ];
  // sin activeRoutes: efectivo = default. desired == default → 0 (no es un cambio real).
  assert.equal(Engine.effectiveChangeCount(recipeNodes,
    [{ recipeNodeId: 1, stationId: 100 }, { recipeNodeId: 2, stationId: 200 }], []), 0);
  // desired distinto en uno → 1 cambio.
  assert.equal(Engine.effectiveChangeCount(recipeNodes,
    [{ recipeNodeId: 1, stationId: 999 }, { recipeNodeId: 2, stationId: 200 }], []), 1);
  // orden movida (activeRoute en otra tina) y desired = default → cuenta (devolver al default).
  assert.equal(Engine.effectiveChangeCount(recipeNodes,
    [{ recipeNodeId: 1, stationId: 100 }, { recipeNodeId: 2, stationId: 200 }],
    [{ recipeNodeId: 1, stationId: 500 }]), 1);
});

test('currentLineCode: línea efectiva = tina física más frecuente (activeRoute ?? default)', () => {
  const recipeNodes = [
    { id: 1, treatmentId: 10, defaultStation: { id: 100, name: 'T204-EN00-001 Enracado' } },
    { id: 2, treatmentId: 11, defaultStation: { id: 200, name: 'T204-TI00-002 Proc' } },
    { id: 3, treatmentId: 12, defaultStation: { id: 300, name: 'T204-IC00-001 Insp' } },
  ];
  const cbt = { 11: [{ id: 250, name: 'T205-TI00-002 Proc' }] };
  assert.equal(Engine.currentLineCode(recipeNodes, [], cbt), 'T204'); // sin rutas → default
  // nodo 2 movido a T205 (id 250) → T204 sigue siendo mayoría (2 de 3 tinas físicas).
  assert.equal(Engine.currentLineCode(recipeNodes, [{ recipeNodeId: 2, stationId: 250 }], cbt), 'T204');
});

test('rutea EXACTAMENTE los mismos nodos que el ground-truth (34)', () => {
  const { routes, skipped } = run();
  assert.equal(routes.length, fx.expected.length, '34 rutas');
  const got = new Set(routes.map((r) => r.recipeNodeId));
  const want = new Set(fx.expected.map((r) => r.recipeNodeId));
  assert.deepEqual([...got].sort(), [...want].sort(), 'mismo conjunto de recipeNodes');
  // los únicos omitidos son nodos globales SP (treatment pero sin estación física);
  // el ground-truth tampoco los rutea.
  for (const s of skipped) {
    const n = nodeById.get(s.recipeNodeId);
    assert.ok(!n.defaultStation, `${s.name} omitido debe ser nodo global sin estación`);
    assert.ok(!want.has(s.recipeNodeId), `${s.name} no está en el ground-truth`);
  }
  // todas las rutas llevan los campos de la mutación.
  for (const r of routes) {
    assert.equal(r.partNumberId, fx.partNumberId);
    assert.equal(r.workOrderId, fx.workOrderId);
    assert.equal(r.partGroupId, null);
    assert.ok(r.stationId != null && r.recipeNodeId != null && r.treatmentId != null);
  }
});

test('bypass: bloques T300 conservan su tina default (sin cambio)', () => {
  const { routes } = run();
  const byNode = new Map(routes.map((r) => [r.recipeNodeId, r.stationId]));
  for (const n of fx.recipeNodes) {
    if (n.treatmentId == null || !n.defaultStation) continue;
    if (Engine.extractLineCode(n.defaultStation.name) === fx.sourceLineCode) continue;
    // nodo fuera de T204 → debe conservar su default y coincidir con el ground-truth.
    assert.equal(byNode.get(n.id), n.defaultStation.id, `${n.name} debe conservar default`);
    assert.equal(byNode.get(n.id), expById.get(n.id), `${n.name} ground-truth`);
  }
});

// Una ruta es "blanda" (momentum) solo si es un enjuague genérico (treatment
// 71283, sin rol distintivo). Todo lo demás — anclas single-candidate, roles
// (Flash, Recuperador), y tanques de proceso multi-variante reusados (Decapado
// Nítrico) — es DETERMINISTA y debe reproducir el ground-truth exacto.
function isSoftRinse(n) {
  return (
    n &&
    n.treatmentId === GENERIC_ENJ_TID &&
    n.defaultStation &&
    !/recuperador|caliente/i.test(n.defaultStation.name)
  );
}

test('rutas deterministas (anclas, roles, reúso de proceso) → match EXACTO', () => {
  const { routes } = run();
  const byNode = new Map(routes.map((r) => [r.recipeNodeId, r.stationId]));
  let hard = 0;
  for (const r of fx.expected) {
    const n = nodeById.get(r.recipeNodeId);
    if (isSoftRinse(n)) continue; // los enjuagues genéricos se miden como cobertura
    hard++;
    assert.equal(byNode.get(r.recipeNodeId), r.stationId, `${n ? n.name : r.recipeNodeId} (treatment ${r.treatmentId})`);
  }
  assert.ok(hard >= 22, `esperaba ≥22 rutas deterministas, hubo ${hard}`);
});

test('integridad: ninguna tina de enjuague genérico se asigna dos veces', () => {
  const { routes } = run();
  const enj = routes.filter((r) => r.treatmentId === GENERIC_ENJ_TID).map((r) => r.stationId);
  assert.equal(new Set(enj).size, enj.length, 'tinas de enjuague duplicadas');
  // y todas son tinas T205 de enjuague reales.
  const enjIds = new Set(
    (fx.candidatesByTreatment[GENERIC_ENJ_TID] || [])
      .filter((s) => Engine.extractLineCode(s.name) === fx.destLineCode)
      .map((s) => s.id)
  );
  for (const id of enj) assert.ok(enjIds.has(id), `station ${id} no es enjuague T205 válido`);
});

test('cobertura de enjuagues genéricos (momentum) vs ground-truth', () => {
  const { routes } = run();
  const byNode = new Map(routes.map((r) => [r.recipeNodeId, r.stationId]));
  let total = 0;
  let hit = 0;
  const miss = [];
  for (const r of fx.expected) {
    const n = nodeById.get(r.recipeNodeId);
    if (!n || n.treatmentId !== GENERIC_ENJ_TID || !n.defaultStation) continue;
    if (/recuperador|caliente/i.test(n.defaultStation.name)) continue; // roles, no momentum
    total++;
    if (byNode.get(n.id) === r.stationId) hit++;
    else miss.push(`${n.name}: got ${byNode.get(n.id)} want ${r.stationId}`);
  }
  const pct = Math.round((hit / total) * 100);
  console.log(`   ▸ momentum: ${hit}/${total} enjuagues genéricos exactos (${pct}%)`);
  if (miss.length) console.log('     misses (el preview editable los cubre):\n       ' + miss.join('\n       '));
  // soft gate: la exactitud de enjuagues genéricos es best-effort (el operador
  // ajusta en el preview). El piso solo atrapa una rotura gruesa del heurístico;
  // la garantía dura vive en el test de rutas deterministas.
  assert.ok(pct >= 33, `cobertura de momentum ${pct}% < 33% — heurístico roto`);
});

test('idempotencia: WO sin ruteo previo → todo routesToCreate', () => {
  const { routes } = run();
  const split = Engine.diffRoutes(routes, []); // activeRoutes vacío
  assert.equal(split.routesToCreate.length, routes.length);
  assert.equal(split.routesToUpdate.length, 0);
  assert.equal(split.routesToDelete.length, 0);
});

test('idempotencia: diffRoutes crea/actualiza/borra/no-op', () => {
  // shape de activeRoutes = StationTreatmentByWorkOrder.activeRoutes.nodes[]
  const active = [
    { id: 5001, recipeNodeId: 1, stationId: 100 }, // sin cambio
    { id: 5002, recipeNodeId: 2, stationId: 200 }, // cambia → update
    { id: 5003, recipeNodeId: 4, stationId: 400 }, // ya no se rutea → delete
  ];
  const desired = [
    { recipeNodeId: 1, stationId: 100, treatmentId: 10, partNumberId: 9, workOrderId: 8, partGroupId: null }, // no-op
    { recipeNodeId: 2, stationId: 250, treatmentId: 11, partNumberId: 9, workOrderId: 8, partGroupId: null }, // update
    { recipeNodeId: 3, stationId: 300, treatmentId: 12, partNumberId: 9, workOrderId: 8, partGroupId: null }, // create
  ];
  const split = Engine.diffRoutes(desired, active);
  assert.deepEqual(split.routesToCreate.map((r) => r.recipeNodeId), [3]);
  assert.deepEqual(split.routesToUpdate, [{ id: 5002, stationId: 250 }]);
  assert.deepEqual(split.routesToDelete, [5003]);
});
