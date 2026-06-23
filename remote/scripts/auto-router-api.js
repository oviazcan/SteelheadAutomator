// auto-router-api.js — Capa de datos GraphQL del autoruteador.
//
// Abstrae las 3 operaciones del flujo de ruteo (hashes en config.json):
//   · StationTreatmentByWorkOrder (query)  — árbol de recipeNodes + tinas default
//                                            + grafo de transportes + rutas activas.
//   · SearchStationsForTreatment  (query)  — tinas (schedulingStations) por treatment.
//   · CreateUpdateDeleteRoutes    (mutation) — aplica todas las rutas en batch.
//
// Devuelve estructuras normalizadas (sin __typename ni envoltura). Depende de
// window.SteelheadAPI. Expone window.AutoRouterAPI.

(function (root) {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api()?.log?.(m) ?? console.log('[AR-API]', m);

  // Normaliza un recipeNode crudo del response a la forma que consume el motor.
  function normRecipeNode(n) {
    const pn = n.processNodeByDerivedFrom || {};
    const ds = pn.stationByDefaultStationId || null;
    return {
      id: n.id,
      name: (n.name || '').trim(),
      treatmentId: n.treatmentId ?? null,
      recipeInd: n.recipeInd ?? 0,
      parentRecipeNodeId: n.parentRecipeNodeId ?? null,
      defaultStation: ds && ds.id != null ? { id: ds.id, name: (ds.name || '').trim() } : null,
    };
  }

  // Parsea la respuesta de StationTreatmentByWorkOrder en datos de ruteo.
  function parseRouteData(data, workOrderId, partNumberId) {
    const wo = (data?.allWorkOrders?.nodes || [])[0] || null;
    const rawNodes = wo?.recipeNodesByWorkOrderId?.nodes || [];
    const recipeNodes = rawNodes.map(normRecipeNode);
    const transportGraph = (data?.allDefaultStationTransports?.nodes || []).map((e) => ({
      fromStationId: e.fromStationId,
      toStationId: e.toStationId,
      durationMinutes: e.durationMinutes,
    }));
    // activeRoutes: rutas personalizadas ya existentes en la WO. Vacío = OV sin
    // ruteo previo (caso típico). Se preserva crudo para detectar idempotencia.
    const activeRoutes = (data?.activeRoutes?.nodes || []).slice();
    return {
      workOrderId,
      idInDomain: wo?.idInDomain ?? null,
      partNumberId,
      recipeNodes,
      transportGraph,
      activeRoutes,
    };
  }

  // Carga el árbol + transportes + rutas activas de una WO.
  async function fetchWorkOrderRouteData(workOrderId, partNumberId, partGroupIds = []) {
    const data = await api().query('StationTreatmentByWorkOrder', {
      workOrderIds: [Number(workOrderId)],
      partNumberIds: partNumberId != null ? [Number(partNumberId)] : [],
      partGroupIds: partGroupIds.map(Number),
    });
    return parseRouteData(data, Number(workOrderId), partNumberId != null ? Number(partNumberId) : null);
  }

  // Tinas (schedulingStations) compatibles con un treatment, de TODAS las líneas.
  async function fetchStationsForTreatment(treatmentId) {
    const data = await api().query('SearchStationsForTreatment', {
      nameLike: '%%',
      treatmentId: Number(treatmentId),
    });
    const nodes = data?.treatmentById?.schedulingStations?.nodes || [];
    return nodes.map((s) => ({ id: s.id, name: (s.name || '').trim() }));
  }

  // Corre fns async con concurrencia acotada (evita martillar /graphql con 17+
  // queries simultáneas). Preserva el orden de `items` en el resultado.
  async function mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // Para un set de treatmentIds únicos, devuelve { [treatmentId]: [{id,name}] }.
  async function fetchCandidatesForTreatments(treatmentIds, concurrency = 5) {
    const uniq = [...new Set((treatmentIds || []).filter((t) => t != null).map(Number))];
    const lists = await mapPool(uniq, concurrency, (tId) =>
      fetchStationsForTreatment(tId).catch((e) => {
        log(`SearchStationsForTreatment(${tId}) falló: ${e.message}`);
        return [];
      })
    );
    const map = {};
    uniq.forEach((tId, idx) => { map[tId] = lists[idx]; });
    return map;
  }

  // Resuelve una orden por su número visible (idInDomain) a sus IDs internos.
  // PartNumbersByWorkOrderIdInDomain trae en una sola llamada el workOrderId interno
  // + el/los partNumber(s) + partGroup. Devuelve el part primario (el primero).
  async function resolveWorkOrder(idInDomain) {
    const data = await api().query('PartNumbersByWorkOrderIdInDomain', { idInDomain: Number(idInDomain) });
    const wo = data?.workOrderByIdInDomain;
    if (!wo || wo.id == null) throw new Error(`Orden ${idInDomain} no encontrada`);
    const locs = wo.partLocationsByWorkOrderId?.nodes || [];
    const pn = locs[0]?.partNumberByPartNumberId || null;
    const pg = locs[0]?.partGroupByPartGroupId || null;
    return {
      idInDomain: wo.idInDomain,
      workOrderId: wo.id,
      name: (wo.name || '').trim(),
      partNumberId: pn?.id ?? null,
      partNumberName: (pn?.name || '').trim() || null,
      partGroupId: pg?.id ?? null,
      partCount: locs.length,
    };
  }

  // Aplica las rutas en una sola mutación batch.
  // routes: [{recipeNodeId, treatmentId, stationId, partNumberId, workOrderId, partGroupId}]
  async function applyRoutes(routes, routesToUpdate = [], routesToDelete = []) {
    const data = await api().query('CreateUpdateDeleteRoutes', {
      input: {
        routesToCreate: routes,
        routesToUpdate,
        routesToDelete,
      },
    });
    const res = data?.createUpdateDeleteRoutes || {};
    return {
      createdRoutes: res.createdRoutes || [],
      updatedRoutes: res.updatedRoutes || [],
      deletedRouteIds: res.deletedRouteIds || [],
    };
  }

  root.AutoRouterAPI = {
    fetchWorkOrderRouteData,
    fetchStationsForTreatment,
    fetchCandidatesForTreatments,
    resolveWorkOrder,
    applyRoutes,
    parseRouteData, // exportado para tests/depuración
  };
})(typeof window !== 'undefined' ? window : globalThis);
