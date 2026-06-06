// bulk-upload-build.js — decisiones PURAS de armado del input de SavePartNumber (F4).
//
// SavePartNumber hace REPLACE en sus arrays (labelIds, dimensionCustomValueIds, etc.):
// si mandas [], SH BORRA lo existente. Estas funciones centralizan la semántica
// "blank→preservar / dash→borrar / dato→reemplazar" que vivía dispersa en enrichWorker
// (bulk-upload.js L4955-5079). Son PURAS y testeables (node --test). El cableado al
// pipeline es F4 Task 3 — este módulo NO toca producción todavía.
//
// Dual-export: window.SteelheadBulkBuild (browser) / module.exports (node).
(function (root) {
  'use strict';

  const isDash = (v) => v === '-';

  // decideLabelIds — qué labelIds enviar (REPLACE) con preserve-on-missing.
  // Réplica fiel de bulk-upload.js L4955-4979 + L5067-5079.
  //   dash (1 sola celda '-')            → []                (borrar todo, sentinel explícito)
  //   CSV sin labels                     → existingLabelIds  (preservar)
  //   CSV con nombres pero TODOS unknown → existingLabelIds  (preservar; el error queda aparte)
  //   CSV con ≥1 id válido               → labelIds          (REPLACE intencional)
  // csvLabels: string[] del CSV. labelByName: Map<nombre,id>. existingLabelIds: number[] vigentes.
  function decideLabelIds(csvLabels, labelByName, existingLabelIds) {
    csvLabels = csvLabels || [];
    existingLabelIds = existingLabelIds || [];
    const labelsAreDash = csvLabels.length === 1 && isDash(csvLabels[0]);
    if (labelsAreDash) {
      // matchedLabelIds:[] → stats.labelsSet no incrementa (igual que el inline).
      return { labelIdsToSend: [], unknownLabels: [], matchedLabelIds: [], decision: 'clear' };
    }
    const labelIds = [];
    const unknownLabels = [];
    for (const n of csvLabels) {
      const id = labelByName.get(n);
      if (id) labelIds.push(id); else unknownLabels.push(n);
    }
    const csvHadLabels = csvLabels.length > 0;
    const allLabelsUnknown = csvHadLabels && labelIds.length === 0 && unknownLabels.length === csvLabels.length;
    let labelIdsToSend, decision;
    if (!csvHadLabels) { labelIdsToSend = existingLabelIds; decision = 'preserve-empty'; }
    else if (allLabelsUnknown) { labelIdsToSend = existingLabelIds; decision = 'preserve-allunknown'; }
    else { labelIdsToSend = labelIds; decision = 'replace'; }
    // matchedLabelIds = los ids realmente encontrados en el catálogo (para stats.labelsSet,
    // que el inline incrementa con labelIds.length ANTES de decidir labelIdsToSend).
    return { labelIdsToSend, unknownLabels, matchedLabelIds: labelIds, decision };
  }

  // decideDimValueIds — qué dimensionCustomValueIds (Línea/Departamento) enviar.
  // Réplica fiel de bulk-upload.js L5044-5065.
  //   ambos vacíos en CSV              → preservar existing
  //   ambos '-' (dash)                 → [] (borrar explícito)
  //   mezcla con ≥1 value-ok           → enviar lookup
  //   lookup roto sin ningún value-ok  → preservar (no borrar por typo)
  // linea/departamento: string del CSV. dimValueMap: Map<nombre,id>. existingDimCustomValueIds: number[].
  function decideDimValueIds(linea, departamento, dimValueMap, existingDimCustomValueIds) {
    existingDimCustomValueIds = existingDimCustomValueIds || [];
    const dimValueIds = [];
    let lineaIntent = 'none';   // 'none' | 'dash' | 'value-ok' | 'value-missing'
    let deptoIntent = 'none';
    const warnings = [];
    if (linea) {
      if (isDash(linea)) lineaIntent = 'dash';
      else { const id = dimValueMap.get(linea); if (id) { dimValueIds.push(id); lineaIntent = 'value-ok'; } else { lineaIntent = 'value-missing'; warnings.push(`Línea "${linea}" no encontrada en dimensiones`); } }
    }
    if (departamento) {
      if (isDash(departamento)) deptoIntent = 'dash';
      else { const id = dimValueMap.get(departamento); if (id) { dimValueIds.push(id); deptoIntent = 'value-ok'; } else { deptoIntent = 'value-missing'; warnings.push(`Departamento "${departamento}" no encontrado en dimensiones`); } }
    }
    let dimValueIdsToSend;
    if (lineaIntent === 'none' && deptoIntent === 'none') {
      dimValueIdsToSend = existingDimCustomValueIds;
    } else if ((lineaIntent === 'value-missing' || lineaIntent === 'none') &&
               (deptoIntent === 'value-missing' || deptoIntent === 'none') &&
               dimValueIds.length === 0) {
      dimValueIdsToSend = existingDimCustomValueIds;
    } else {
      dimValueIdsToSend = dimValueIds;
    }
    return { dimValueIdsToSend, lineaIntent, deptoIntent, warnings };
  }

  // resolveFk — FK-fallback con ORDEN EXPLÍCITO por campo (NO genérico — los órdenes difieren).
  // El persisted query GetPartNumber no pide los escalares directos, solo relacionales (XByX.id).
  // sources: array ordenado de [obj, relName, scalarName]; devuelve el primer id no-nulo.
  // Réplica de los 4 FK de bulk-upload.js L5261/5276/5287/5288 — cada caller pasa SU orden.
  function resolveFk(sources, fallback) {
    for (const [obj, relName, scalarName] of sources) {
      if (!obj) continue;
      const v = (obj[relName] && obj[relName].id != null) ? obj[relName].id : obj[scalarName];
      if (v != null) return v;
    }
    return fallback === undefined ? null : fallback;
  }
  // Helpers con el orden EXACTO de cada campo (verificado contra el código actual):
  //   customerId          : pn primero, luego part.customerId  (L5276)
  //   defaultProcessNodeId: pn primero, luego existingPnNode    (L5287)
  //   partNumberGroupId   : existingPnNode primero, luego pn    (L5261, tras resolveGroupId del CSV)
  //   geometryTypeId      : existingPnNode primero, luego pn    (L5288)
  function resolveCustomerId(pn, existingPnNode, partCustomerId) {
    return resolveFk([[pn, 'customerByCustomerId', 'customerId']], null) ?? partCustomerId ?? null;
  }
  function resolveDefaultProcessNodeId(pn, existingPnNode) {
    return resolveFk([[pn, 'processNodeByDefaultProcessNodeId', 'defaultProcessNodeId'],
                      [existingPnNode, 'processNodeByDefaultProcessNodeId', 'defaultProcessNodeId']], null);
  }
  function resolveGeometryTypeId(existingPnNode, pn) {
    return resolveFk([[existingPnNode, 'geometryTypeByGeometryTypeId', 'geometryTypeId'],
                      [pn, 'geometryTypeByGeometryTypeId', 'geometryTypeId']], null);
  }
  function resolveGroupIdFallback(existingPnNode, pn) {
    return resolveFk([[existingPnNode, 'partNumberGroupByPartNumberGroupId', 'partNumberGroupId'],
                      [pn, 'partNumberGroupByPartNumberGroupId', 'partNumberGroupId']], null);
  }

  // decideDims — partNumberDimensions físicas con preserve-on-missing (REPLACE de SH).
  // Réplica fiel de bulk-upload.js L5334-5350.
  //   dimsAreDash             → []                         (borrar explícito)
  //   csvDims (no vacío)      → csvDims                    (reemplazar)
  //   CSV sin dims            → reconstruir de existingPnNode (preservar físicas)
  // csvDims: resultado de buildDimensions(part.dims, DOMAIN) ya calculado por el caller.
  function decideDims(csvDims, dimsAreDash, existingPnNode) {
    if (dimsAreDash) return [];
    if (csvDims && csvDims.length) return csvDims;
    return (existingPnNode && existingPnNode.partNumberDimensionsByPartNumberId
      ? existingPnNode.partNumberDimensionsByPartNumberId.nodes || [] : [])
      .filter(d => !d.archivedAt && d.geometryTypeDimensionTypeId && ((d.unitByUnitId && d.unitByUnitId.id) ?? d.unitId) != null)
      .map(d => ({
        geometryTypeDimensionTypeId: d.geometryTypeDimensionTypeId,
        dimensionValue: d.dimensionValue,
        unitId: (d.unitByUnitId && d.unitByUnitId.id) ?? d.unitId,
      }));
  }

  // decideOptInOuts — validación 1er artículo, TRI-STATE (fix 1.5.13: toBool('')=false borraba).
  // Réplica fiel de bulk-upload.js L5387-5403.
  //   true  → activar (un optInOut por cada domainNodeId)
  //   null  → CSV vacío → preservar los existentes (rebuild de existingPnNode)
  //   false → desactivar explícito → []
  function decideOptInOuts(validacion1er, domainNodeIds, existingPnNode) {
    if (validacion1er === true) {
      return (domainNodeIds || []).map(nodeId => ({ processNodeId: nodeId, processNodeOccurrence: 1, cancelOthers: false }));
    }
    if (validacion1er === null) {
      const exOpts = (existingPnNode && existingPnNode.processNodePartNumberOptInoutsByPartNumberId
        ? existingPnNode.processNodePartNumberOptInoutsByPartNumberId.nodes || [] : []);
      return exOpts
        .map(o => ({ processNodeId: o.processNodeId, processNodeOccurrence: o.processNodeOccurrence ?? 1, cancelOthers: o.cancelOthers ?? false }))
        .filter(o => o.processNodeId != null);
    }
    return []; // false → desactivar explícito
  }

  const api = {
    isDash, decideLabelIds, decideDimValueIds, decideDims, decideOptInOuts, resolveFk,
    resolveCustomerId, resolveDefaultProcessNodeId, resolveGeometryTypeId, resolveGroupIdFallback,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkBuild = api;
})(typeof window !== 'undefined' ? window : globalThis);
