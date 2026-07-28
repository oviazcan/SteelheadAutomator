// auto-router-groups.js — Núcleo PURO de pistas de ruteo, partición y reagrupación
// de piezas. Sin DOM y sin red: todo lo que decide qué se escribe vive aquí y se
// prueba con `tools/test/auto-router-groups.test.js`.
//
// ── Modelo (confirmado en vivo 2026-07-27, WO 15074/15075) ────────────────────
// Una orden se rutea por PISTAS. La pista GLOBAL (partGroupId null) es la ruta de
// toda la orden; cada grupo de piezas puede tener su OVERRIDE, que toma precedencia
// solo para ese grupo. Un grupo sin override HEREDA la global, y sin global usa el
// default de la receta. Las pistas coexisten: crear la de un grupo no toca las otras.
//
// ── Partir vs reagrupar ──────────────────────────────────────────────────────
// Las dos son transferencias de piezas, pero cada mutación pide un shape DISTINTO
// para el destino y NO son intercambiables:
//   · PARTIR    → CreateManyPartsTransfersChecked · toAccount: { partGroupId: X }
//   · REAGRUPAR → AddPartsToWorkOrders            · toAccount: { partGroup: { id: X } }
// Ambas mueven material físico, así que las funciones de plan devuelven `payload:
// null` cuando algo no cuadra: más vale no escribir que escribir a medias.

(function (root) {
  'use strict';

  const num = (v) => (v == null ? null : Number(v));
  const normName = (s) => String(s ?? '').trim().toLowerCase();

  // ── Pistas ─────────────────────────────────────────────────────────────────
  // partLocations: [{ partsTransferAccountId, partCount, partGroup: {id,name}|null }]
  //   (shape de GroupPartsDialogPartLocation.searchPartLocations.nodes[], ya normalizado)
  // activeRoutes:  [{ id, recipeNodeId, stationId, partGroupId }]
  //
  // Devuelve [{ kind, partGroupId, name, partCount, accountIds, state }] con la GLOBAL
  // siempre primero. `state` dice de dónde salen las rutas efectivas de esa pista:
  //   'own'       → tiene override propio
  //   'inherited' → no tiene, pero la global sí (la hereda)
  //   'default'   → ni una ni otra: manda el default de la receta
  function buildLanes(input) {
    const partLocations = (input && input.partLocations) || [];
    const activeRoutes = (input && input.activeRoutes) || [];

    const hasGlobalRoutes = activeRoutes.some((a) => a && (a.partGroupId ?? null) === null);
    const groupsWithOwnRoutes = new Set(
      activeRoutes.filter((a) => a && a.partGroupId != null).map((a) => Number(a.partGroupId))
    );

    // Agrupa las cuentas por grupo, preservando el orden de aparición.
    const byGroup = new Map();
    let globalCount = 0;
    for (const loc of partLocations) {
      if (!loc) continue;
      const count = Number(loc.partCount) || 0;
      globalCount += count;
      const g = loc.partGroup;
      if (!g || g.id == null) continue;
      const id = Number(g.id);
      if (!byGroup.has(id)) byGroup.set(id, { id, name: String(g.name ?? ''), partCount: 0, accountIds: [] });
      const entry = byGroup.get(id);
      entry.partCount += count;
      if (loc.partsTransferAccountId != null) entry.accountIds.push(Number(loc.partsTransferAccountId));
    }

    const stateFor = (partGroupId) => {
      if (partGroupId != null && groupsWithOwnRoutes.has(partGroupId)) return 'own';
      if (hasGlobalRoutes) return partGroupId == null ? 'own' : 'inherited';
      return 'default';
    };

    const lanes = [{
      kind: 'global', partGroupId: null, name: 'Toda la orden',
      partCount: globalCount, accountIds: partLocations
        .filter((l) => l && l.partsTransferAccountId != null)
        .map((l) => Number(l.partsTransferAccountId)),
      state: stateFor(null),
    }];
    for (const g of byGroup.values()) {
      lanes.push({
        kind: 'group', partGroupId: g.id, name: g.name,
        partCount: g.partCount, accountIds: g.accountIds, state: stateFor(g.id),
      });
    }
    return lanes;
  }

  // ── Partir ─────────────────────────────────────────────────────────────────
  // Reparte las piezas de UNA cuenta origen entre varios grupos.
  // splits: [{ partGroupId, partCount }]
  function planSplit(input) {
    const fromAccountId = num(input && input.fromAccountId);
    const partCount = Number(input && input.partCount);
    const splits = (input && input.splits) || [];
    const errors = [];

    if (fromAccountId == null) errors.push('Falta la cuenta de origen.');
    if (!splits.length) errors.push('No hay ninguna partición definida.');

    const seen = new Set();
    let suma = 0;
    for (const s of splits) {
      const n = Number(s && s.partCount);
      const gid = num(s && s.partGroupId);
      if (gid == null) { errors.push('Una partición no tiene grupo destino.'); continue; }
      if (seen.has(gid)) errors.push(`El grupo destino ${gid} está repetido.`);
      seen.add(gid);
      if (!Number.isFinite(n) || n <= 0) { errors.push(`La cantidad del grupo ${gid} debe ser mayor que cero.`); continue; }
      if (!Number.isInteger(n)) { errors.push(`La cantidad del grupo ${gid} debe ser entera.`); continue; }
      suma += n;
    }
    if (splits.length && Number.isFinite(partCount) && suma !== partCount) {
      errors.push(`Las cantidades suman ${suma} y la cuenta tiene ${partCount} piezas.`);
    }
    if (errors.length) return { valid: false, errors, payload: null };

    return {
      valid: true,
      errors: [],
      payload: {
        partsTransferEventsPayload: {
          partsTransferEvents: [{
            createPartsTransferEvent: {},
            partsTransfers: splits.map((s) => ({
              fromAccountId,
              type: 'STEP',
              partCount: Number(s.partCount),
              toAccount: { partGroupId: num(s.partGroupId) },  // PLANO — no anidar aquí
              unitId: null,
            })),
          }],
        },
      },
    };
  }

  // ── Reagrupar ──────────────────────────────────────────────────────────────
  // Junta varias cuentas en un mismo grupo destino. Las cuentas que ya viven en ese
  // grupo se omiten (no es error: reagrupar A+B en A es una petición legítima).
  // accounts: [{ accountId, partCount, partGroupId? }]
  function planRegroup(input) {
    const targetGroupId = num(input && input.targetGroupId);
    const accounts = (input && input.accounts) || [];
    const errors = [];

    if (targetGroupId == null) errors.push('Falta el grupo destino.');
    if (!accounts.length) errors.push('No hay cuentas de origen que reagrupar.');
    if (errors.length) return { valid: false, errors, payload: null };

    const move = accounts.filter((a) => a && num(a.partGroupId) !== targetGroupId);
    if (!move.length) {
      return { valid: false, errors: ['Todo ya está en el grupo destino: no hay nada que mover.'], payload: null };
    }
    for (const a of move) {
      const n = Number(a.partCount);
      if (!Number.isFinite(n) || n <= 0) errors.push(`La cuenta ${a.accountId} no tiene piezas que mover.`);
    }
    if (errors.length) return { valid: false, errors, payload: null };

    return {
      valid: true,
      errors: [],
      payload: {
        input: {
          partsTransferEventsPayload: [{
            createPartsTransferEvent: {},
            partsTransfers: move.map((a) => ({
              fromAccountId: num(a.accountId),
              type: 'STEP',
              partCount: Number(a.partCount),
              toAccount: { partGroup: { id: targetGroupId } },  // ANIDADO — distinto a partir
              unitId: null,
            })),
          }],
        },
      },
    };
  }

  // ── Reúso de grupos ────────────────────────────────────────────────────────
  // CreateNewPartGroup NO es idempotente: cada llamada crea un grupo, así que pedir
  // "100" tres veces deja tres grupos llamados "100". Se reúsan los del cliente que
  // ya existan (match por nombre normalizado) y solo se crean los que falten.
  function reuseOrCreate(wantedNames, existingGroups) {
    const byName = new Map();
    for (const g of existingGroups || []) {
      if (g && g.id != null) byName.set(normName(g.name), Number(g.id));
    }
    const reuse = [];
    const create = [];
    const pedidos = new Set();
    for (const name of wantedNames || []) {
      const key = normName(name);
      if (!key || pedidos.has(key)) continue;
      pedidos.add(key);
      if (byName.has(key)) reuse.push({ name, id: byName.get(key) });
      else create.push(name);
    }
    return { reuse, create };
  }

  // ── Lectura del estado de piezas ───────────────────────────────────────────
  // `WorkOrder { idInDomain }` trae en UNA llamada el id interno de la orden, su
  // cliente (que CreateNewPartGroup pide) y las cuentas vivas con sus piezas y su
  // grupo. `PartNumbersByWorkOrderIdInDomain` NO sirve aquí: sus partLocations traen
  // el grupo pero no `partCount` ni el id de cuenta, y sin eso no se puede partir.
  function parseWorkOrderAccounts(data) {
    const wo = (data && data.workOrderByIdInDomain) || null;
    const nodes = (wo && wo.currentPartsTransferAccounts && wo.currentPartsTransferAccounts.nodes) || [];
    const partLocations = nodes.filter(Boolean).map((n) => {
      const g = n.partGroupByPartGroupId;
      return {
        partsTransferAccountId: num(n.id),
        partCount: Number(n.partCount) || 0,
        partGroup: g && g.id != null ? { id: num(g.id), name: String(g.name ?? '') } : null,
      };
    });
    return {
      workOrderId: num(wo && wo.id),
      idInDomain: num(wo && wo.idInDomain),
      customerId: num(wo && wo.customerByCustomerId && wo.customerByCustomerId.id),
      partNumberId: num(nodes.find((n) => n && n.partNumberId != null)?.partNumberId),
      partLocations,
    };
  }

  const api = { buildLanes, planSplit, planRegroup, reuseOrCreate, parseWorkOrderAccounts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoRouterGroups = api;
})(typeof window !== 'undefined' ? window : globalThis);
