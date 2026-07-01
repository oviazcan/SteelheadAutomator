// tools/test/wo-completer-engine.test.js
// Golden tests del motor puro de Completar / Descompletar OTs.
// Los payloads esperados son los capturados VERBATIM del scan real
// ~/Downloads/scan_results_2026-06-30_210332.json (AddPartsToWorkOrders / CreateManyPartsTransfersChecked).
// Run: node --test tools/test/wo-completer-engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../remote/scripts/wo-completer-engine.js');

// ── parseWoList ─────────────────────────────────────────────────────────────
test('parseWoList: saltos de línea, comas, tabs y espacios; dedup y orden', () => {
  const txt = '5119\n5436, 10515\t5119\n\n  9001 ';
  assert.deepEqual(E.parseWoList(txt), [5119, 5436, 9001, 10515]);
});

test('parseWoList: ignora no-numéricos y negativos/cero; vacío -> []', () => {
  assert.deepEqual(E.parseWoList('abc, 12, -3, 0, 7'), [7, 12]);
  assert.deepEqual(E.parseWoList(''), []);
  assert.deepEqual(E.parseWoList(null), []);
});

test('parseWoList: tolera "OT 5119" tomando el entero', () => {
  // split por separadores deja "OT" (ignorado) y "5119"
  assert.deepEqual(E.parseWoList('OT 5119\nOT 5436'), [5119, 5436]);
});

// ── buildCompletePayload (golden vs AddPartsToWorkOrders real) ───────────────
test('buildCompletePayload: reproduce byte-a-byte el input COMPLETE capturado', () => {
  const workOrder = {
    completedAt: null,
    currentPartsTransferAccounts: {
      nodes: [
        {
          id: 40404463,
          partCount: 136000,
          receivedOrderPartTransformId: 2405324,
          locationByLocationId: { id: 24907 },
        },
      ],
    },
  };
  const out = E.buildCompletePayload(workOrder);
  assert.deepEqual(out, {
    input: {
      recipeNodePartNumberTreatmentsToCreate: [],
      recipeNodePartNumberTreatmentsToUpdate: [],
      recipeNodePartNumberTreatmentsToDelete: [],
      workOrderUserFilesToCreate: [],
      partsTransferEventsPayload: [
        {
          createPartsTransferEvent: {},
          partsTransfers: [
            {
              fromAccountId: 40404463,
              partCount: 136000,
              toAccount: {
                workOrderId: null,
                stationId: null,
                recipeNodeId: null,
                receivedOrderPartTransformId: 2405324,
                locationId: 24907,
              },
              fromOperatorInput: {},
              type: 'COMPLETE',
              partsTransferIdCausingRework: null,
              partsTransferCategoryId: null,
              comment: null,
            },
          ],
        },
      ],
      billedLaborTimeSegments: {
        billedLaborTimeSegmentIdsToDelete: [],
        billedLaborTimeSegmentsToUpdate: [],
        billedLaborTimeSegmentsToCreate: [],
      },
    },
  });
});

test('buildCompletePayload: multi-cuenta -> un evento con N partsTransfers, solo partCount>0', () => {
  const workOrder = {
    completedAt: null,
    currentPartsTransferAccounts: {
      nodes: [
        { id: 1, partCount: 10, receivedOrderPartTransformId: 100, locationByLocationId: { id: 900 } },
        { id: 2, partCount: 0, receivedOrderPartTransformId: 101, locationByLocationId: { id: 900 } }, // se omite
        { id: 3, partCount: 5, receivedOrderPartTransformId: 102, locationByLocationId: { id: 901 } },
      ],
    },
  };
  const out = E.buildCompletePayload(workOrder);
  const pts = out.input.partsTransferEventsPayload[0].partsTransfers;
  assert.equal(pts.length, 2);
  assert.deepEqual(pts.map(p => p.fromAccountId), [1, 3]);
  assert.deepEqual(pts.map(p => p.partCount), [10, 5]);
});

test('buildCompletePayload: skip si ya completada', () => {
  const out = E.buildCompletePayload({
    completedAt: '2026-06-30T00:00:00Z',
    currentPartsTransferAccounts: { nodes: [{ id: 1, partCount: 10, receivedOrderPartTransformId: 1, locationByLocationId: { id: 1 } }] },
  });
  assert.equal(out.skip, true);
  assert.match(out.reason, /completa/i);
});

test('buildCompletePayload: skip si no hay piezas activas', () => {
  const out = E.buildCompletePayload({ completedAt: null, currentPartsTransferAccounts: { nodes: [] } });
  assert.equal(out.skip, true);
  assert.match(out.reason, /piezas/i);
});

// ── pickRevertableCompletes ─────────────────────────────────────────────────
test('pickRevertableCompletes: solo COMPLETE sin revert (por sub-conexión)', () => {
  const transfers = [
    { id: 10, type: 'ENTRANCE' },
    { id: 11, type: 'STEP' },
    { id: 12, type: 'COMPLETE', partsTransfersByRevertsPartsTransferId: { nodes: [] } }, // revertible
    { id: 13, type: 'COMPLETE', partsTransfersByRevertsPartsTransferId: { nodes: [{ id: 99 }] } }, // ya revertido
  ];
  assert.deepEqual(E.pickRevertableCompletes(transfers).map(t => t.id), [12]);
});

test('pickRevertableCompletes: detecta revert por REVERT_COMPLETE en la misma lista', () => {
  const transfers = [
    { id: 20, type: 'COMPLETE' }, // sin sub-conexión, pero…
    { id: 99, type: 'REVERT_COMPLETE', revertsPartsTransferId: 20 }, // …lo revierte
    { id: 21, type: 'COMPLETE' }, // este sí es revertible
  ];
  assert.deepEqual(E.pickRevertableCompletes(transfers).map(t => t.id), [21]);
});

// ── buildRevertPayload (golden vs CreateManyPartsTransfersChecked real) ──────
test('buildRevertPayload: reproduce el REVERT_COMPLETE capturado + normaliza el at', () => {
  const transfer = {
    id: 47311391,
    partCount: 136000,
    fromAccountId: 40404463,
    at: '2026-07-01T03:03:06.761946+00:00', // microsegundos + offset
    type: 'COMPLETE',
  };
  const out = E.buildRevertPayload(transfer);
  assert.deepEqual(out, {
    partsTransferEventsPayload: {
      partsTransferEvents: [
        {
          partsTransfers: [
            {
              partCount: 136000,
              revertsPartsTransferId: 47311391,
              toAccount: { id: 40404463 },
              type: 'REVERT_COMPLETE',
              at: '2026-07-01T03:03:06.761Z', // millis + Z
            },
          ],
        },
      ],
      billedLaborTimeSegments: {},
    },
  });
});
