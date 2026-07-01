// Completar / Descompletar OTs — motor puro (sin DOM, sin red).
// Construye los payloads de las mutaciones a partir de las respuestas de lectura:
//   COMPLETAR    : WorkOrder{idInDomain}.currentPartsTransferAccounts  -> AddPartsToWorkOrders(input)
//   DESCOMPLETAR : GetWorkOrderPartsTransfers{idInDomain}              -> CreateManyPartsTransfersChecked(payload)
//
// Modelo confirmado byte-a-byte contra el scan real
// (~/Downloads/scan_results_2026-06-30_210332.json). Ver golden tests en
// tools/test/wo-completer-engine.test.js y el diseño en
// docs/superpowers/specs/2026-06-30-wo-completer-design.md
(function (root) {
  'use strict';

  // Parsea una lista pegada de números de OT (idInDomain). Tolera columnas de
  // Excel (saltos de línea), comas, tabs, espacios y texto como "OT 5119".
  // Toma enteros > 0, dedup, orden ascendente.
  function parseWoList(text) {
    if (!text) return [];
    const seen = new Set();
    const out = [];
    String(text)
      .split(/[\s,;]+/)
      .forEach((tok) => {
        const n = parseInt(tok, 10);
        if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      });
    return out.sort((a, b) => a - b);
  }

  // Cuentas activas de la OT con piezas por completar (partCount > 0).
  function _activeAccounts(workOrder) {
    const nodes = (workOrder && workOrder.currentPartsTransferAccounts &&
      workOrder.currentPartsTransferAccounts.nodes) || [];
    return nodes.filter((a) => a && (a.partCount || 0) > 0);
  }

  // Construye el input de AddPartsToWorkOrders para COMPLETAR toda la OT.
  // Un solo evento con un partsTransfer por cuenta activa (todos juntos, como el
  // "complete" nativo). Devuelve { skip:true, reason } si no aplica.
  function buildCompletePayload(workOrder) {
    if (workOrder && workOrder.completedAt) {
      return { skip: true, reason: 'ya completada' };
    }
    const accts = _activeAccounts(workOrder);
    if (!accts.length) {
      return { skip: true, reason: 'sin piezas activas' };
    }
    const partsTransfers = accts.map((acc) => ({
      fromAccountId: acc.id,
      partCount: acc.partCount,
      toAccount: {
        workOrderId: null,
        stationId: null,
        recipeNodeId: null,
        receivedOrderPartTransformId: acc.receivedOrderPartTransformId,
        locationId: acc.locationByLocationId ? acc.locationByLocationId.id : null,
      },
      fromOperatorInput: {},
      type: 'COMPLETE',
      partsTransferIdCausingRework: null,
      partsTransferCategoryId: null,
      comment: null,
    }));
    return {
      input: {
        recipeNodePartNumberTreatmentsToCreate: [],
        recipeNodePartNumberTreatmentsToUpdate: [],
        recipeNodePartNumberTreatmentsToDelete: [],
        workOrderUserFilesToCreate: [],
        partsTransferEventsPayload: [
          { createPartsTransferEvent: {}, partsTransfers },
        ],
        billedLaborTimeSegments: {
          billedLaborTimeSegmentIdsToDelete: [],
          billedLaborTimeSegmentsToUpdate: [],
          billedLaborTimeSegmentsToCreate: [],
        },
      },
    };
  }

  // De los transfers de GetWorkOrderPartsTransfers, devuelve los COMPLETE que aún
  // NO fueron revertidos. Detecta el revert de dos formas complementarias:
  //   (a) la sub-conexión partsTransfersByRevertsPartsTransferId trae nodos, o
  //   (b) algún REVERT_COMPLETE de la lista apunta a su id vía revertsPartsTransferId.
  function pickRevertableCompletes(transfers) {
    const list = Array.isArray(transfers) ? transfers : [];
    const revertedIds = new Set();
    list.forEach((t) => {
      if (t && t.type === 'REVERT_COMPLETE' && t.revertsPartsTransferId != null) {
        revertedIds.add(t.revertsPartsTransferId);
      }
    });
    return list.filter((t) => {
      if (!t || t.type !== 'COMPLETE') return false;
      const sub = t.partsTransfersByRevertsPartsTransferId;
      const alreadyRevertedBySub = !!(sub && sub.nodes && sub.nodes.length);
      return !alreadyRevertedBySub && !revertedIds.has(t.id);
    });
  }

  // Construye el payload de CreateManyPartsTransfersChecked para DESCOMPLETAR
  // (revertir) un transfer COMPLETE. El `at` se normaliza a millis+Z: el ERP
  // espera exactamente el instante del COMPLETE original en ese formato
  // ("…761946+00:00" -> "…761Z").
  function buildRevertPayload(transfer) {
    return {
      partsTransferEventsPayload: {
        partsTransferEvents: [
          {
            partsTransfers: [
              {
                partCount: transfer.partCount,
                revertsPartsTransferId: transfer.id,
                toAccount: { id: transfer.fromAccountId },
                type: 'REVERT_COMPLETE',
                at: new Date(transfer.at).toISOString(),
              },
            ],
          },
        ],
        billedLaborTimeSegments: {},
      },
    };
  }

  const api = {
    parseWoList,
    buildCompletePayload,
    pickRevertableCompletes,
    buildRevertPayload,
    // expuestos para tests/depuración
    _activeAccounts,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadWOCompleterEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
