// PO Reconciler — Rebalanceo automático entre OVs temp y POs reales (Schneider QRO)
// Depende de: SteelheadAPI, ClaudeAPI, POComparator
// Spec: docs/superpowers/specs/2026-05-12-po-reconciler-design.md

const POReconciler = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;
  const log = (m) => api()?.log?.(m) ?? console.log('[PR]', m);
  const warn = (m) => api()?.warn?.(m) ?? console.warn('[PR]', m);

  const URL_RE = /\/Domains\/\d+\/ReceivedOrders(?:\/|$|\?)/i;
  const SAP_PO_RE = /^14\d{8}$/;

  let state = {
    isOpen: false,
    step: 1,
    pdfs: [],           // [{ file, status: 'pending'|'parsing'|'ok'|'error', parsed, error }]
    tempOVs: [],        // [{ id, name, ots, byPN, snapshot }]
    restantesOV: null,  // { id, name, snapshot } or null
    plan: null,         // see engine
    overrides: {},      // user edits
    runId: null,        // for cancel/idempotency
    auditLog: [],
  };

  function init() {
    if (window.__saPoReconcilerInit) return;
    window.__saPoReconcilerInit = true;
    injectStyles();
    installUrlChangeListener();
    syncFabVisibility();
    listenManualTrigger();
  }

  function isAllowedPath() {
    return URL_RE.test(location.pathname);
  }

  function syncFabVisibility() {
    // TODO Task 10.1
  }

  function installUrlChangeListener() {
    if (window.__saPoReconcilerUrlListener) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saPoReconcilerUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  function listenManualTrigger() {
    chrome.runtime?.onMessage?.addListener?.((msg) => {
      if (msg && msg.action === 'run-po-reconciler') openWizard();
    });
  }

  function injectStyles() {
    // TODO Task 5.2
  }

  function openWizard() {
    // TODO Task 5.1
  }

  // ── Steelhead helpers ──────────────────────────────────────

  async function loadCandidateTempOVs() {
    const domain = api().getDomain();
    const schneider = domain.schneiderQueretaro || {};
    if (!schneider.customerId || !schneider.shipToAddressId) {
      throw new Error('Falta config Schneider QRO (customerId / shipToAddressId)');
    }
    const sapRe = new RegExp(schneider.poNumberRegex || '^14\\d{8}$');
    const variables = {
      filters: { customerId: schneider.customerId, archivedAt: null },
      first: 100,
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const all = data?.activeReceivedOrders?.nodes || data?.receivedOrders?.nodes || [];
    const candidates = all.filter(ov => {
      if (ov.archivedAt) return false;
      const ship = (ov.shipToAddress?.id ?? ov.shipToAddressId);
      if (String(ship) !== String(schneider.shipToAddressId)) return false;
      const name = String(ov.name || '').trim();
      if (sapRe.test(name)) return false;
      return true;
    });
    log(`Temp OVs candidatas: ${candidates.length}`);
    return candidates.map(ov => ({ id: ov.id, idInDomain: ov.idInDomain, name: ov.name, raw: ov }));
  }

  async function loadOVDetails(ovId) {
    const data = await api().query('GetReceivedOrder', { id: ovId });
    const ov = data?.receivedOrder || data?.receivedOrderByIdInDomain;
    if (!ov) throw new Error(`GetReceivedOrder(${ovId}) devolvió shape inesperado`);

    // Líneas y OTs
    const lines = ov.receivedOrderLines?.nodes
                || ov.receivedOrderLinesByReceivedOrderId?.nodes
                || [];

    const ots = [];
    const byPN = {};
    for (const line of lines) {
      for (const li of (line.lineItems?.nodes || line.lineItems || [])) {
        for (const ptAssoc of (li.receivedOrderLineItemPartTransforms?.nodes
                            || li.receivedOrderLineItemPartTransforms
                            || [])) {
          const pt = ptAssoc.receivedOrderPartTransform;
          if (!pt) continue;
          for (const wo of (pt.workOrders?.nodes || pt.workOrders || [])) {
            const pnId = pt.partNumberId;
            const pnString = pt.partNumber?.partNumberString || pt.partNumber?.string || '';
            const qty = Number(wo.partCount || wo.count || 0);
            ots.push({
              id: wo.id,
              partCount: qty,
              partNumberId: pnId,
              partNumber: pnString,
              receivedOrderPartTransformId: pt.id,
              recipeNodeId: wo.recipeNodeId ?? null,
              locationId: wo.locationId ?? null,
              accountId: wo.inventoryAccountId ?? wo.accountId ?? null,
              line: { id: line.id, name: line.name, quantity: Number(li.quantity || 0) },
              raw: wo,
            });
            byPN[pnString] = (byPN[pnString] || 0) + qty;
          }
        }
      }
    }

    return {
      id: ov.id,
      idInDomain: ov.idInDomain,
      name: ov.name,
      customerId: ov.customerId,
      shipToAddressId: ov.shipToAddressId,
      lines,
      ots,
      byPN,
      snapshot: ov, // full record for rename replay
    };
  }

  async function findRestantesOV() {
    const domain = api().getDomain();
    const sch = domain.schneiderQueretaro || {};
    const expectedName = sch.restantesOvName || 'Restantes Schneider QRO';
    const variables = {
      filters: { customerId: sch.customerId, archivedAt: null, searchString: expectedName },
      first: 20,
    };
    const data = await api().query('ActiveReceivedOrders', variables);
    const all = data?.activeReceivedOrders?.nodes || data?.receivedOrders?.nodes || [];
    return all.find(ov => String(ov.name).trim() === expectedName) || null;
  }

  async function createRestantesOV(seed) {
    const domain = api().getDomain();
    const expectedName = domain.schneiderQueretaro?.restantesOvName || 'Restantes Schneider QRO';
    const input = {
      name: expectedName,
      customerId: seed.customerId,
      shipToAddressId: seed.shipToAddressId,
      customerContactId: seed.customerContactId ?? null,
      billToAddressId: seed.billToAddressId ?? null,
      invoiceTermsId: seed.invoiceTermsId ?? null,
      customInputs: seed.customInputs ?? [],
      inputSchemaId: seed.inputSchemaId ?? null,
      shipVia: seed.shipVia ?? null,
      shipMethodId: seed.shipMethodId ?? null,
      type: seed.type ?? 'STANDARD',
      blockPartialShipments: seed.blockPartialShipments ?? false,
      sectorId: seed.sectorId ?? null,
      isBlanketOrder: false,
      deadline: seed.deadline ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const data = await api().query('CreateReceivedOrder', { input });
    const created = data?.createReceivedOrder?.receivedOrder || data?.createReceivedOrder;
    if (!created?.id) throw new Error('CreateReceivedOrder: respuesta sin id');
    log(`OV Restantes creada: ${created.id} (#${created.idInDomain})`);
    return created;
  }

  function findOTForPN(ov, pnId) {
    return ov.ots.find(ot => String(ot.partNumberId) === String(pnId)) || null;
  }

  async function createOTInOV({ ovId, customerId, deadline, partNumberId, hintFromOt }) {
    const variables = {
      input: [{
        id: null,
        name: '',
        customerId,
        deadline,
        productId: hintFromOt?.raw?.productId ?? null,
        startedAt: new Date().toISOString(),
        receivedOrderId: ovId,
        description: '',
        customerFacingNotes: '',
        type: 'MAKE_TO_ORDER',
        blockPartialShipments: false,
        labelIds: [],
        partNumberId,
        recipeNodeId: hintFromOt?.recipeNodeId ?? null,
      }],
    };
    const data = await api().query('CreateUpdateWorkOrdersChecked', variables);
    const wo = data?.createUpdateWorkOrdersChecked?.workOrders?.[0]
            || data?.workOrder
            || data?.workOrders?.[0];
    if (!wo?.id) throw new Error('CreateUpdateWorkOrdersChecked: no devolvió OT');
    return wo;
  }

  async function executeMove({
    qty,
    fromOt,
    toOt,
    partNumberId,
    toOvId,
    transformCount,
    transformDeadline,
    transformPriceId,
    lineItemAssocs,
  }) {
    if (!fromOt?.accountId) throw new Error('executeMove: falta fromOt.accountId');
    if (!toOt?.id || !toOt?.recipeNodeId) throw new Error('executeMove: falta toOt.id / recipeNodeId');
    if (!toOt?.receivedOrderPartTransformId) throw new Error('executeMove: falta toOt.receivedOrderPartTransformId');
    const variables = {
      input: {
        receivedOrderPartTransforms: [{
          id: toOt.receivedOrderPartTransformId,
          receivedOrderId: toOvId,
          description: null,
          count: transformCount ?? toOt.partCount ?? qty,
          deadline: transformDeadline ?? null,
          partNumberId,
          partNumberPriceId: transformPriceId ?? null,
          partsTransferEvents: [{
            createPartsTransferEvent: {},
            partsTransfers: [{
              fromAccountId: fromOt.accountId,
              toAccount: {
                recipeNodeId: toOt.recipeNodeId,
                workOrderId: toOt.id,
                stationId: null,
                locationId: toOt.locationId ?? null,
                partNumberId,
                receivedOrderPartTransformId: toOt.receivedOrderPartTransformId,
                materialConversionId: null,
              },
              partCount: qty,
              type: 'TRANSFER',
              comment: null,
            }],
          }],
          inventoryTransferEvents: [],
          receivedOrderLineItemPartTransforms: lineItemAssocs ?? [],
        }],
        partsTransferEventsPayload: [{
          createPartsTransferEvent: {},
          partsTransfers: [],
        }],
        billedLaborTimeSegments: {},
      },
    };
    return await api().query('AddPartsToWorkOrders', variables);
  }

  async function reconcileLineQuantities(ovId) {
    const fresh = await loadOVDetails(ovId);
    const newLines = [];

    for (const line of fresh.lines) {
      const lineItemsRaw = line.lineItems?.nodes || line.lineItems || [];
      const li = lineItemsRaw[0];
      if (!li) continue;

      // Suma de partCount de todas las OTs asociadas a esta línea
      let sumOts = 0;
      const assocs = li.receivedOrderLineItemPartTransforms?.nodes
                  || li.receivedOrderLineItemPartTransforms
                  || [];
      for (const ptAssoc of assocs) {
        const pt = ptAssoc.receivedOrderPartTransform;
        for (const wo of (pt?.workOrders?.nodes || pt?.workOrders || [])) {
          sumOts += Number(wo.partCount || wo.count || 0);
        }
      }
      const currentLineQty = Number(li.quantity || 0);
      if (currentLineQty === sumOts) continue;

      newLines.push({
        id: line.id,
        name: line.name,
        description: line.description ?? null,
        lineItems: [{
          id: li.id,
          archive: !!li.archive,
          description: li.description ?? '',
          quantity: String(sumOts),
          price: String(li.price ?? '0'),
          productId: li.productId ?? null,
          unitId: li.unitId ?? null,
          quoteLineItemId: li.quoteLineItemId ?? null,
          receivedOrderLineItemPartTransforms: assocs.map(a => ({
            id: a.id,
            receivedOrderPartTransform: {
              id: a.receivedOrderPartTransform?.id,
              partNumberId: a.receivedOrderPartTransform?.partNumberId,
              partNumberPriceId: a.receivedOrderPartTransform?.partNumberPriceId ?? null,
              count: a.receivedOrderPartTransform?.count ?? 0,
              description: a.receivedOrderPartTransform?.description ?? '',
            },
          })),
        }],
      });
    }

    if (newLines.length === 0) {
      log(`Reconcile ${ovId}: sin cambios`);
      return { changed: 0 };
    }

    const variables = { input: { receivedOrderId: ovId, newLines } };
    await api().query('SaveReceivedOrderLinesAndItems', variables);
    log(`Reconcile ${ovId}: ${newLines.length} líneas ajustadas`);
    return { changed: newLines.length };
  }

  function mapToUpdateShape(ov) {
    return {
      id: ov.id,
      name: ov.name,
      customerId: ov.customerId,
      deadline: ov.deadline,
      customerContactId: ov.customerContactId ?? null,
      billToAddressId: ov.billToAddressId ?? null,
      shipToAddressId: ov.shipToAddressId,
      invoiceTermsId: ov.invoiceTermsId ?? null,
      customInputs: ov.customInputs ?? null,
      inputSchemaId: ov.inputSchemaId ?? null,
      shipVia: ov.shipVia ?? null,
      shipMethodId: ov.shipMethodId ?? null,
      type: ov.type,
      blockPartialShipments: ov.blockPartialShipments ?? false,
      sectorId: ov.sectorId ?? null,
      isBlanketOrder: ov.isBlanketOrder ?? false,
      productionStartDate: ov.productionStartDate ?? null,
      contractualDeadline: ov.contractualDeadline ?? null,
      defaultSignOffRecipeId: ov.defaultSignOffRecipeId ?? null,
    };
  }

  async function renameOV(snapshot, toName) {
    const variables = { ...mapToUpdateShape(snapshot), name: toName };
    const data = await api().query('UpdateReceivedOrder', variables);
    return data?.updateReceivedOrder?.receivedOrder || data?.updateReceivedOrder || data;
  }

  // ── Engine (pure functions) ────────────────────────────────

  function consolidateByPN(lines) {
    const out = {};
    for (const line of (lines || [])) {
      const pn = line && line.partNumber;
      if (!pn) continue;
      const qty = Number(line.quantity) || 0;
      out[pn] = (out[pn] || 0) + qty;
    }
    return out;
  }

  function hungarianMatch(costMatrix) {
    const n = costMatrix.length;
    if (n === 0) return { assignment: [], totalCost: 0 };
    if (!costMatrix.every(row => Array.isArray(row) && row.length === n)) {
      throw new Error('hungarianMatch: matriz debe ser cuadrada');
    }
    let best = { assignment: null, totalCost: Infinity };
    const perm = Array.from({ length: n }, (_, i) => i);
    function* permutations(arr, k = 0) {
      if (k === arr.length - 1) { yield arr.slice(); return; }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        yield* permutations(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    }
    for (const p of permutations(perm)) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += costMatrix[i][p[i]];
      if (cost < best.totalCost) best = { assignment: p.slice(), totalCost: cost };
    }
    return best;
  }

  function assignTempsToPOs(temps, pos) {
    const n = temps.length;
    const m = pos.length;
    if (n !== m) {
      return {
        assignment: null,
        totalDelta: null,
        issues: [{
          severity: 'fatal',
          type: 'cardinality_mismatch',
          detail: `#temps=${n} ≠ #POs=${m}. Plan automático no generado.`,
        }],
      };
    }
    if (n === 0) return { assignment: [], totalDelta: 0, issues: [] };

    const allPNs = new Set();
    temps.forEach(t => Object.keys(t.byPN || {}).forEach(pn => allPNs.add(pn)));
    pos.forEach(p => Object.keys(p.byPN || {}).forEach(pn => allPNs.add(pn)));

    const matrix = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        let cost = 0;
        for (const pn of allPNs) {
          const tempQty = (temps[i].byPN || {})[pn] || 0;
          const poQty   = (pos[j].byPN   || {})[pn] || 0;
          cost += Math.abs(tempQty - poQty);
        }
        row.push(cost);
      }
      matrix.push(row);
    }
    const { assignment, totalCost } = hungarianMatch(matrix);
    return {
      assignment: assignment.map((j, i) => ({
        tempOvId: temps[i].ovId,
        poNumber: pos[j].poNumber,
      })),
      totalDelta: totalCost,
      issues: [],
    };
  }

  function computeMovesForPN(pn, currentByOV, targetByOV) {
    const delta = {}; // positive = donor, negative = deficit
    for (const ov of new Set([...Object.keys(currentByOV), ...Object.keys(targetByOV)])) {
      delta[ov] = (currentByOV[ov] || 0) - (targetByOV[ov] || 0);
    }
    const donors  = Object.entries(delta).filter(([, d]) => d > 0).map(([ov, d]) => ({ ov, qty: d }));
    const deficit = Object.entries(delta).filter(([, d]) => d < 0).map(([ov, d]) => ({ ov, qty: -d }));
    donors.sort((a, b) => b.qty - a.qty);
    deficit.sort((a, b) => b.qty - a.qty);

    const moves = [];
    let di = 0, ri = 0;
    while (di < donors.length && ri < deficit.length) {
      const move = Math.min(donors[di].qty, deficit[ri].qty);
      moves.push({ pn, qty: move, fromOvId: donors[di].ov, toOvId: deficit[ri].ov });
      donors[di].qty -= move;
      deficit[ri].qty -= move;
      if (donors[di].qty === 0) di++;
      if (deficit[ri].qty === 0) ri++;
    }
    return moves;
  }

  function detectIssuesForPN(pn, tempsTotal, posTotal) {
    if (tempsTotal === posTotal) return [];
    if (tempsTotal > 0 && posTotal === 0) {
      return [{
        severity: 'warn', type: 'pn_solo_en_hs', pn,
        detail: `PN ${pn} aparece en HS (${tempsTotal} piezas) pero no en ningún PO. Se moverá completo a OV Restantes.`,
        sobrante: tempsTotal,
      }];
    }
    if (tempsTotal === 0 && posTotal > 0) {
      return [{
        severity: 'warn', type: 'pn_solo_en_po', pn,
        detail: `PN ${pn} aparece en PO (${posTotal} piezas) pero no en HS. No se puede surtir; línea excluida.`,
        faltante: posTotal,
      }];
    }
    if (tempsTotal > posTotal) {
      return [{
        severity: 'info', type: 'sobrante', pn,
        detail: `HS tiene ${tempsTotal} piezas, Σ POs pide ${posTotal}. Excedente ${tempsTotal - posTotal} → OV Restantes.`,
        sobrante: tempsTotal - posTotal,
      }];
    }
    return [{
      severity: 'warn', type: 'faltante', pn,
      detail: `HS tiene ${tempsTotal} piezas, Σ POs pide ${posTotal}. Faltante ${posTotal - tempsTotal}; línea excluida del plan.`,
      faltante: posTotal - tempsTotal,
    }];
  }

  function buildPlan({ pos, temps, restantesOV, config, overrides = {} }) {
    const issues = [];

    // Asignación
    let assignmentResult;
    if (overrides.assignment) {
      assignmentResult = { assignment: overrides.assignment, totalDelta: null, issues: [] };
    } else {
      assignmentResult = assignTempsToPOs(temps, pos);
    }
    if (!assignmentResult.assignment) {
      return { assignment: [], moves: [], restantes: [], renames: [], creates: [], issues: assignmentResult.issues };
    }
    const assignment = assignmentResult.assignment;

    // Construir target por OV: por cada PN, suma de qty del PO asignado a esa temp
    const targetByOV = {}; // { ovId: { pn: qty } }
    for (const { tempOvId, poNumber } of assignment) {
      targetByOV[tempOvId] = {};
      const po = pos.find(p => p.poNumber === poNumber);
      if (!po) continue;
      for (const [pn, qty] of Object.entries(po.byPN || {})) {
        targetByOV[tempOvId][pn] = qty;
      }
    }
    const currentByOV = {}; // { ovId: { pn: qty } }
    for (const t of temps) currentByOV[t.ovId] = { ...(t.byPN || {}) };

    // PNs a procesar
    const allPNs = new Set();
    temps.forEach(t => Object.keys(t.byPN || {}).forEach(pn => allPNs.add(pn)));
    pos.forEach(p => Object.keys(p.byPN || {}).forEach(pn => allPNs.add(pn)));

    const moves = [];
    const restantes = [];
    for (const pn of allPNs) {
      const tempsTotal = temps.reduce((s, t) => s + (t.byPN?.[pn] || 0), 0);
      const posTotal   = pos.reduce((s, p) => s + (p.byPN?.[pn] || 0), 0);

      const pnIssues = detectIssuesForPN(pn, tempsTotal, posTotal);
      issues.push(...pnIssues);

      // Si el PN tiene faltante o solo está en PO → no se puede surtir, skip moves
      if (pnIssues.some(i => i.type === 'faltante' || i.type === 'pn_solo_en_po')) continue;

      // Target por OV para este PN
      const tgtByOV = {};
      for (const ovId of Object.keys(currentByOV)) tgtByOV[ovId] = targetByOV[ovId]?.[pn] || 0;

      // Generar moves intra-temp
      const cur = {};
      for (const ovId of Object.keys(currentByOV)) cur[ovId] = currentByOV[ovId][pn] || 0;
      const pnMoves = computeMovesForPN(pn, cur, tgtByOV);

      // Sobrante: si suma de targets < suma de currents → diferencia va a Restantes
      const sumCur = Object.values(cur).reduce((a, b) => a + b, 0);
      const sumTgt = Object.values(tgtByOV).reduce((a, b) => a + b, 0);
      if (sumCur > sumTgt) {
        // Crear restante: tomar del primer donor disponible después de aplicar pnMoves
        // Simplificación: el donor del move-a-restantes es el OV que aún quede con sobrante
        const totalSobrante = sumCur - sumTgt;
        // Encontrar de qué OV viene: el que tenga más currentByOV[pn] - tgtByOV[ov][pn]
        let leftover = totalSobrante;
        for (const ovId of Object.keys(cur)) {
          const ovSobrante = cur[ovId] - tgtByOV[ovId];
          if (ovSobrante > 0) {
            const take = Math.min(ovSobrante, leftover);
            restantes.push({ pn, qty: take, fromOvId: ovId });
            leftover -= take;
            if (leftover === 0) break;
          }
        }
      }

      moves.push(...pnMoves);
    }

    // OV Restantes: si hay sobrantes y no existe la OV, crearla
    const creates = [];
    let restantesOvId = restantesOV?.id ?? null;
    if (restantes.length > 0 && !restantesOvId) {
      creates.push({
        type: 'restantes-ov',
        name: config.restantesOvName,
        metadata: { fromTempOvId: temps[0]?.ovId ?? null },
      });
      restantesOvId = '__pending_restantes__';
    }
    for (const r of restantes) r.toOvId = restantesOvId;

    // Renames
    const renames = assignment.map(({ tempOvId, poNumber }) => {
      const t = temps.find(x => x.ovId === tempOvId);
      return { ovId: tempOvId, fromName: t?.name ?? '', toName: poNumber };
    });

    return { assignment, moves, restantes, renames, creates, issues };
  }

  // ── Public API (also for tests) ─────────────────────────────
  return {
    init,
    openWizard,
    // Internals exposed for test harness (Task 1.3+):
    _engine: {
      consolidateByPN,
      hungarianMatch,
      assignTempsToPOs,
      computeMovesForPN,
      detectIssuesForPN,
      buildPlan,
    },
    _helpers: { loadCandidateTempOVs, loadOVDetails, findRestantesOV, createRestantesOV, findOTForPN, createOTInOV, executeMove, reconcileLineQuantities, mapToUpdateShape, renameOV },
  };
})();

if (typeof window !== 'undefined') {
  window.POReconciler = POReconciler;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', POReconciler.init);
  } else {
    POReconciler.init();
  }
}

if (typeof module !== 'undefined') module.exports = POReconciler;
