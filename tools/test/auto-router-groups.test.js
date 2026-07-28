// tools/test/auto-router-groups.test.js
// Núcleo puro de PISTAS, PARTIR y REAGRUPAR piezas.
//
// Payloads confirmados del scan 2026-07-27 (WO 15075, PN MFR28154, cliente 188781):
//
//   PARTIR — CreateManyPartsTransfersChecked: UNA cuenta origen se reparte en varios
//   grupos con su cantidad. Shape del destino: toAccount.partGroupId (PLANO).
//     { fromAccountId: 44956004, type:'STEP', partCount:100, toAccount:{partGroupId:948204} }
//
//   REAGRUPAR — AddPartsToWorkOrders: VARIAS cuentas caen en un mismo grupo destino.
//   Shape del destino: toAccount.partGroup.id (ANIDADO) y el payload va en un array
//   dentro de `input`. Los dos shapes NO son intercambiables.
//     { fromAccountId: 44961260, type:'STEP', partCount:100, toAccount:{partGroup:{id:948192}} }
const test = require('node:test');
const assert = require('node:assert/strict');
const Groups = require('../../remote/scripts/auto-router-groups.js');

// ── buildLanes ────────────────────────────────────────────────────────────────
// Escenario real de la WO 15075: grupo "100" heredando la global y grupo "200" con
// override propio en T205.
const PART_LOCATIONS = [
  { partsTransferAccountId: 44961260, partCount: 100, partGroup: { id: 948191, name: '100' } },
  { partsTransferAccountId: 44961261, partCount: 50, partGroup: { id: 948192, name: '200' } },
];
const ACTIVE_ROUTES = [
  { id: 9001, recipeNodeId: 1, stationId: 204001, partGroupId: null },
  { id: 9002, recipeNodeId: 1, stationId: 205001, partGroupId: 948192 },
];

test('buildLanes: siempre encabeza la pista GLOBAL', () => {
  const lanes = Groups.buildLanes({ partLocations: PART_LOCATIONS, activeRoutes: ACTIVE_ROUTES });
  assert.equal(lanes[0].kind, 'global');
  assert.equal(lanes[0].partGroupId, null);
  assert.equal(lanes.length, 3, 'global + dos grupos');
});

test('buildLanes: una pista por grupo, con su nombre y sus piezas', () => {
  const lanes = Groups.buildLanes({ partLocations: PART_LOCATIONS, activeRoutes: ACTIVE_ROUTES });
  const g = lanes.filter((l) => l.kind === 'group');
  assert.deepEqual(g.map((l) => l.name), ['100', '200']);
  assert.deepEqual(g.map((l) => l.partCount), [100, 50]);
  assert.deepEqual(g.map((l) => l.partGroupId), [948191, 948192]);
});

test('buildLanes: distingue el grupo con override del que HEREDA', () => {
  const lanes = Groups.buildLanes({ partLocations: PART_LOCATIONS, activeRoutes: ACTIVE_ROUTES });
  const byId = Object.fromEntries(lanes.filter((l) => l.kind === 'group').map((l) => [l.partGroupId, l]));
  assert.equal(byId[948192].state, 'own', 'el 200 tiene rutas propias');
  assert.equal(byId[948191].state, 'inherited', 'el 100 hereda la global');
});

test('buildLanes: sin rutas globales, un grupo sin override queda en "default"', () => {
  const lanes = Groups.buildLanes({ partLocations: PART_LOCATIONS, activeRoutes: [] });
  const g = lanes.find((l) => l.partGroupId === 948191);
  assert.equal(g.state, 'default');
  assert.equal(lanes[0].state, 'default', 'la global tampoco tiene rutas');
});

test('buildLanes: varias cuentas del MISMO grupo suman sus piezas', () => {
  const locs = [
    { partsTransferAccountId: 1, partCount: 30, partGroup: { id: 5, name: 'A' } },
    { partsTransferAccountId: 2, partCount: 70, partGroup: { id: 5, name: 'A' } },
  ];
  const lanes = Groups.buildLanes({ partLocations: locs, activeRoutes: [] });
  const g = lanes.find((l) => l.partGroupId === 5);
  assert.equal(g.partCount, 100);
  assert.deepEqual(g.accountIds, [1, 2]);
});

test('buildLanes: una orden SIN grupos da solo la pista global', () => {
  const locs = [{ partsTransferAccountId: 9, partCount: 12, partGroup: null }];
  const lanes = Groups.buildLanes({ partLocations: locs, activeRoutes: [] });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].kind, 'global');
  assert.equal(lanes[0].partCount, 12);
});

// ── planSplit (PARTIR) ────────────────────────────────────────────────────────

test('planSplit: arma el payload con el shape PLANO de toAccount.partGroupId', () => {
  const p = Groups.planSplit({
    fromAccountId: 44956004,
    partCount: 200,
    splits: [{ partGroupId: 948204, partCount: 100 }, { partGroupId: 948205, partCount: 50 },
             { partGroupId: 948206, partCount: 50 }],
  });
  assert.equal(p.valid, true);
  const transfers = p.payload.partsTransferEventsPayload.partsTransferEvents[0].partsTransfers;
  assert.equal(transfers.length, 3);
  assert.deepEqual(transfers[0], {
    fromAccountId: 44956004, type: 'STEP', partCount: 100,
    toAccount: { partGroupId: 948204 }, unitId: null,
  });
  assert.deepEqual(transfers.map((t) => t.fromAccountId), [44956004, 44956004, 44956004],
    'todas salen de la MISMA cuenta origen');
});

test('planSplit: rechaza si las cantidades no suman el total', () => {
  const p = Groups.planSplit({
    fromAccountId: 1, partCount: 200,
    splits: [{ partGroupId: 10, partCount: 100 }, { partGroupId: 11, partCount: 50 }],
  });
  assert.equal(p.valid, false);
  assert.match(p.errors[0], /150.*200/, 'el error dice cuánto falta');
});

test('planSplit: rechaza cantidades cero o negativas', () => {
  const p = Groups.planSplit({
    fromAccountId: 1, partCount: 100,
    splits: [{ partGroupId: 10, partCount: 100 }, { partGroupId: 11, partCount: 0 }],
  });
  assert.equal(p.valid, false);
  assert.ok(p.errors.some((e) => /mayor que cero/i.test(e)));
});

test('planSplit: rechaza el mismo grupo destino repetido', () => {
  const p = Groups.planSplit({
    fromAccountId: 1, partCount: 100,
    splits: [{ partGroupId: 10, partCount: 50 }, { partGroupId: 10, partCount: 50 }],
  });
  assert.equal(p.valid, false);
  assert.ok(p.errors.some((e) => /repetido/i.test(e)));
});

test('planSplit: rechaza cantidades fraccionarias (las piezas son enteras)', () => {
  const p = Groups.planSplit({
    fromAccountId: 1, partCount: 100,
    splits: [{ partGroupId: 10, partCount: 33.5 }, { partGroupId: 11, partCount: 66.5 }],
  });
  assert.equal(p.valid, false);
  assert.ok(p.errors.some((e) => /entera/i.test(e)));
});

test('planSplit: rechaza una partición vacía', () => {
  const p = Groups.planSplit({ fromAccountId: 1, partCount: 100, splits: [] });
  assert.equal(p.valid, false);
});

test('planSplit: NO emite payload cuando es inválido (no se manda material a medias)', () => {
  const p = Groups.planSplit({ fromAccountId: 1, partCount: 100, splits: [{ partGroupId: 10, partCount: 40 }] });
  assert.equal(p.valid, false);
  assert.equal(p.payload, null);
});

// ── planRegroup (REAGRUPAR) ───────────────────────────────────────────────────

test('planRegroup: arma el payload con el shape ANIDADO toAccount.partGroup.id', () => {
  const p = Groups.planRegroup({
    targetGroupId: 948192,
    accounts: [{ accountId: 44961260, partCount: 100 }, { accountId: 44961261, partCount: 50 },
               { accountId: 44961262, partCount: 50 }],
  });
  assert.equal(p.valid, true);
  const transfers = p.payload.input.partsTransferEventsPayload[0].partsTransfers;
  assert.deepEqual(transfers[0], {
    fromAccountId: 44961260, type: 'STEP', partCount: 100,
    toAccount: { partGroup: { id: 948192 } }, unitId: null,
  });
  assert.deepEqual([...new Set(transfers.map((t) => t.toAccount.partGroup.id))], [948192],
    'todas caen en el MISMO grupo destino');
});

test('planRegroup: rechaza sin grupo destino', () => {
  const p = Groups.planRegroup({ targetGroupId: null, accounts: [{ accountId: 1, partCount: 5 }] });
  assert.equal(p.valid, false);
  assert.equal(p.payload, null);
});

test('planRegroup: rechaza sin cuentas origen', () => {
  assert.equal(Groups.planRegroup({ targetGroupId: 10, accounts: [] }).valid, false);
});

test('planRegroup: ignorar una cuenta que ya está en el grupo destino no es error', () => {
  // Reagrupar A+B en A: la cuenta que ya vive ahí se omite, el resto se transfiere.
  const p = Groups.planRegroup({
    targetGroupId: 948191,
    accounts: [{ accountId: 1, partCount: 100, partGroupId: 948191 },
               { accountId: 2, partCount: 50, partGroupId: 948192 }],
  });
  assert.equal(p.valid, true);
  const transfers = p.payload.input.partsTransferEventsPayload[0].partsTransfers;
  assert.equal(transfers.length, 1, 'solo se mueve la que estaba fuera');
  assert.equal(transfers[0].fromAccountId, 2);
});

test('planRegroup: si TODAS ya están en el destino, no hay nada que hacer', () => {
  const p = Groups.planRegroup({
    targetGroupId: 948191,
    accounts: [{ accountId: 1, partCount: 100, partGroupId: 948191 }],
  });
  assert.equal(p.valid, false);
  assert.ok(p.errors.some((e) => /ya está|nada que/i.test(e)));
});

// ── planNewGroupNames ─────────────────────────────────────────────────────────
// CreateNewPartGroup NO es idempotente: cada llamada crea un grupo. Hay que reusar
// los existentes del cliente o acabas con cinco grupos llamados "100".

test('reuseOrCreate: reúsa el grupo existente con el mismo nombre', () => {
  const existing = [{ id: 948191, name: '100' }, { id: 948192, name: '200' }];
  const plan = Groups.reuseOrCreate(['100', '300'], existing);
  assert.deepEqual(plan.reuse, [{ name: '100', id: 948191 }]);
  assert.deepEqual(plan.create, ['300']);
});

test('reuseOrCreate: el match de nombre ignora mayúsculas y espacios de sobra', () => {
  const plan = Groups.reuseOrCreate([' Lote A '], [{ id: 7, name: 'lote a' }]);
  assert.deepEqual(plan.reuse, [{ name: ' Lote A ', id: 7 }]);
  assert.deepEqual(plan.create, []);
});

test('reuseOrCreate: nombres repetidos en la petición se colapsan', () => {
  const plan = Groups.reuseOrCreate(['X', 'X'], []);
  assert.deepEqual(plan.create, ['X']);
});

// ── parseWorkOrderAccounts ────────────────────────────────────────────────────
// WorkOrder{idInDomain} da en UNA llamada el woId interno, el cliente (necesario para
// crear grupos) y las cuentas con sus piezas y su grupo. Shape real del scan.
const WO_RESPONSE = {
  workOrderByIdInDomain: {
    id: 1908434,
    idInDomain: 15075,
    customerByCustomerId: { id: 188781, name: 'INTERNATIONAL METALS DE MEXICO' },
    currentPartsTransferAccounts: {
      nodes: [
        { id: 44956003, partCount: 100, partNumberId: 3028455, partGroupId: 948191,
          partGroupByPartGroupId: { id: 948191, name: '100' } },
        { id: 44956004, partCount: 50, partNumberId: 3028455, partGroupId: 948192,
          partGroupByPartGroupId: { id: 948192, name: '200' } },
      ],
    },
  },
};

test('parseWorkOrderAccounts: saca ids internos, cliente y cuentas', () => {
  const r = Groups.parseWorkOrderAccounts(WO_RESPONSE);
  assert.equal(r.workOrderId, 1908434);
  assert.equal(r.idInDomain, 15075);
  assert.equal(r.customerId, 188781);
  assert.equal(r.partNumberId, 3028455);
  assert.equal(r.partLocations.length, 2);
  assert.deepEqual(r.partLocations[0], {
    partsTransferAccountId: 44956003, partCount: 100,
    partGroup: { id: 948191, name: '100' },
  });
});

test('parseWorkOrderAccounts: alimenta buildLanes directo (contrato entre los dos)', () => {
  const r = Groups.parseWorkOrderAccounts(WO_RESPONSE);
  const lanes = Groups.buildLanes({ partLocations: r.partLocations, activeRoutes: [] });
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].partCount, 150, 'la global suma todas las piezas');
  assert.deepEqual(lanes.slice(1).map((l) => l.name), ['100', '200']);
});

test('parseWorkOrderAccounts: cuenta sin grupo queda sin partGroup (no inventa uno)', () => {
  const r = Groups.parseWorkOrderAccounts({
    workOrderByIdInDomain: {
      id: 1, idInDomain: 2, customerByCustomerId: null,
      currentPartsTransferAccounts: { nodes: [{ id: 9, partCount: 7, partNumberId: 3, partGroupId: null }] },
    },
  });
  assert.equal(r.partLocations[0].partGroup, null);
  assert.equal(r.customerId, null);
});

test('parseWorkOrderAccounts: respuesta vacía no truena', () => {
  const r = Groups.parseWorkOrderAccounts({});
  assert.equal(r.workOrderId, null);
  assert.deepEqual(r.partLocations, []);
});

// ── splitTargetFromSelection ─────────────────────────────────────────────────
// El ✂️ vive ahora en el tablero de planificación, donde el operador puede tener N
// órdenes marcadas. Partir es de UNA: la cuenta origen y sus grupos pertenecen a esa
// orden. Tomar "la primera" en silencio partiría material de una orden que nadie
// eligió — con consecuencia física — así que la ambigüedad se devuelve explícita.
test('splitTargetFromSelection: una sola marcada → esa es la orden', () => {
  const r = Groups.splitTargetFromSelection(['15990']);
  assert.deepEqual(r, { ok: true, reason: 'one', count: 1, idInDomain: 15990 });
});

test('splitTargetFromSelection: sin selección no adivina', () => {
  const r = Groups.splitTargetFromSelection([]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'none');
  assert.equal(r.idInDomain, null);
});

test('splitTargetFromSelection: varias marcadas → NO elige una', () => {
  const r = Groups.splitTargetFromSelection(['15990', '15991', '15992']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'many');
  assert.equal(r.count, 3);
  assert.equal(r.idInDomain, null, 'no puede proponer una: partiría material ajeno');
});

test('splitTargetFromSelection: la misma orden repetida sigue siendo una', () => {
  // El rastreo del board une la selección persistente con las filas visibles; una
  // orden puede llegar dos veces sin que el operador haya marcado dos.
  const r = Groups.splitTargetFromSelection(['15990', '15990']);
  assert.equal(r.ok, true);
  assert.equal(r.idInDomain, 15990);
});

test('splitTargetFromSelection: descarta basura y no truena con null', () => {
  assert.equal(Groups.splitTargetFromSelection(null).reason, 'none');
  assert.equal(Groups.splitTargetFromSelection([null, '', '  ']).reason, 'none');
  // Un href mal leído no debe convertirse en un número de orden inventado.
  assert.equal(Groups.splitTargetFromSelection(['abc', '15990']).idInDomain, 15990);
});
