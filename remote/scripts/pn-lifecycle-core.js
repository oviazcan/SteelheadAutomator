// remote/scripts/pn-lifecycle-core.js
(function (root) {
  'use strict';
  const LINEA_DIM = 349, DEPTO_DIM = 586;

  function slimPN(node, archivedOverride) {
    const ci = node.customInputs || {};
    const dan = ci.DatosAdicionalesNP || {};
    const labels = (node.partNumberLabelsByPartNumberId?.nodes || [])
      .map(n => n.labelByLabelId).filter(Boolean).map(l => ({ id: l.id, name: l.name }));
    const acct = node.acctPnDimensionValueSelectionsByPartNumberId?.nodes || [];
    const dimVal = (dimId) => {
      const hit = acct.find(a => a.dimensionId === dimId);
      return hit?.acctDimensionCustomValueByDimensionCustomValueId?.value || '';
    };
    return {
      id: node.id, name: node.name || '',
      customer: { id: node.customerByCustomerId?.id ?? null, name: node.customerByCustomerId?.name || '' },
      labels,
      metal: dan.BaseMetal || '',
      proceso: node.processNodeByDefaultProcessNodeId?.name || '',
      linea: dimVal(LINEA_DIM), departamento: dimVal(DEPTO_DIM),
      createdAt: node.createdAt || null,
      quoteIBMS: dan.QuoteIBMS || '',
      archived: archivedOverride === true,
    };
  }

  function matchesLabels(pn, sel) {
    const names = (sel?.names || []).map(s => String(s).toUpperCase());
    if (!names.length) return true;
    const have = new Set((pn.labels || []).map(l => String(l.name || '').toUpperCase()));
    return sel.mode === 'OR' ? names.some(n => have.has(n)) : names.every(n => have.has(n));
  }
  function applyFilters(pns, filters) {
    const f = filters || {};
    const inSet = (arr, v) => !arr || !arr.length || arr.includes(v);
    return (pns || []).filter(pn => {
      if (!inSet(f.customers, pn.customer?.id)) return false;
      if (!inSet(f.metals, pn.metal)) return false;
      if (!inSet(f.procesos, pn.proceso)) return false;
      if (!inSet(f.lineas, pn.linea)) return false;
      if (!inSet(f.departamentos, pn.departamento)) return false;
      if (!matchesLabels(pn, f.labels)) return false;
      if (f.dateFilter?.cutoffISO) {
        if (!pn.createdAt) return false;
        const d = new Date(pn.createdAt), cut = new Date(f.dateFilter.cutoffISO);
        if (f.dateFilter.direction === 'after' ? !(d > cut) : !(d < cut)) return false;
      }
      return true;
    });
  }
  function discoverFacets(pns) {
    const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
    const cust = new Map(), metal = new Map(), proc = new Map(), lin = new Map(), dep = new Map(), lbl = new Map();
    for (const pn of pns || []) {
      if (pn.customer?.name) cust.set(pn.customer.name, { id: pn.customer.id, count: (cust.get(pn.customer.name)?.count || 0) + 1 });
      bump(metal, pn.metal); bump(proc, pn.proceso); bump(lin, pn.linea); bump(dep, pn.departamento);
      for (const l of pn.labels || []) bump(lbl, l.name);
    }
    const toArr = (m) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return {
      customers: [...cust.entries()].map(([name, v]) => ({ name, id: v.id, count: v.count })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
      metals: toArr(metal), procesos: toArr(proc),
      lineas: toArr(lin), departamentos: toArr(dep), labels: toArr(lbl),
    };
  }

  // adapta el slim al shape que espera buildCompositeKey (customerId, metalBase, labels[].name)
  function adaptForClassify(pn) {
    return { customerId: pn.customer?.id, name: pn.name, metalBase: pn.metal, labels: (pn.labels || []).map(l => l.name) };
  }
  function selectDuplicates(pns, deps) {
    const { classify, nonFinishList, equivGroups, scoreFn } = deps;
    const equivIndex = classify.buildEquivIndex(equivGroups || []);
    const groups = new Map();
    for (const pn of pns || []) {
      const k = classify.buildCompositeKey(adaptForClassify(pn), nonFinishList || [], equivIndex);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pn);
    }
    const score = scoreFn || ((pn) => pn.id);
    const toTag = [], keep = [];
    for (const g of groups.values()) {
      if (g.length < 2) { keep.push(...g.map(p => p.id)); continue; }
      const activos = g.filter(p => !p.archived);
      const arch = g.filter(p => p.archived);
      if (activos.length) { toTag.push(...arch.map(p => p.id)); keep.push(...activos.map(p => p.id)); }
      else {
        const sorted = [...arch].sort((a, b) => score(b) - score(a));
        keep.push(sorted[0].id); toTag.push(...sorted.slice(1).map(p => p.id));
      }
    }
    return { toTag, keep };
  }

  function isInTargetState(pn, action, vnodes, optInNodeIds) {
    if (action === 'unarchive') return pn.archived === false;
    if (action === 'archive')   return pn.archived === true && (pn.labels || []).some(l => l.id === 15646);
    if (action === 'validate')   return (vnodes || []).every(n => (optInNodeIds || []).includes(n));
    if (action === 'unvalidate') return !(vnodes || []).some(n => (optInNodeIds || []).includes(n));
    return false;
  }
  const buildValidationVars = (partNumberId, processNodeId) => ({ partNumberId, processNodeId, processNodeOccurrence: 1, cancelOthers: false });
  function optInsToDelete(node, vnodes) {
    return (node.processNodePartNumberOptInoutsByPartNumberId?.nodes || [])
      .filter(o => (vnodes || []).includes(o.processNodeId)).map(o => o.id);
  }
  function buildArchiveInput(node, addLabelId) {
    const nds = (p) => { let c = node; for (const k of p.split('.')) c = c?.[k]; return c; };
    const fk = (rel) => node[rel]?.id ?? null;
    const existing = (node.partNumberLabelsByPartNumberId?.nodes || []).map(l => l.labelByLabelId?.id).filter(x => x != null);
    const labelIds = [...new Set([...existing, addLabelId])];
    const opt = (node.processNodePartNumberOptInoutsByPartNumberId?.nodes || [])
      .filter(o => o.processNodeId != null).map(o => ({ processNodeId: o.processNodeId, processNodeOccurrence: o.processNodeOccurrence ?? 1, cancelOthers: !!o.cancelOthers }));
    const dfl = (node.partNumberProcessNodeDefaultsByPartNumberId?.nodes || [])
      .filter(d => d.treatmentByTreatmentId?.id && d.processNodeId).map(d => ({ treatmentId: d.treatmentByTreatmentId.id, processNodeId: d.processNodeId, processNodeOccurrence: d.processNodeOccurrence ?? 1 }));
    const inv = node.inventoryItemByPartNumberId; let inventoryItemInput = null;
    if (inv) {
      const ucs = (inv.inventoryItemUnitConversionsByInventoryItemId?.nodes || [])
        .filter(u => u.unitByUnitId?.id && u.factor != null).map(u => ({ unitId: u.unitByUnitId.id, factor: u.factor }));
      inventoryItemInput = { materialId: inv.materialByMaterialId?.id ?? null, purchasable: false,
        sourceMaterialConversionType: inv.sourceMaterialConversionType ?? null, providedMaterialConversionType: inv.providedMaterialConversionType ?? null,
        defaultLeadTime: inv.defaultLeadTime ?? null, unitConversions: ucs, inventoryItemVendors: [] };
    }
    return {
      id: node.id, name: node.name, shortName: node.shortName ?? null,
      customerId: fk('customerByCustomerId'), defaultProcessNodeId: fk('processNodeByDefaultProcessNodeId'),
      geometryTypeId: fk('geometryTypeByGeometryTypeId'), partNumberGroupId: fk('partNumberGroupByPartNumberGroupId'),
      inputSchemaId: node.inputSchemaId, customInputs: node.customInputs || {},
      glAccountId: fk('glAccountByGlAccountId'), taxCodeId: fk('taxCodeByTaxCodeId'), certPdfTemplateId: node.certPdfTemplateId ?? null,
      userFileName: null, inventoryItemInput, isOneOff: false, isTemplatePartNumber: !!node.isTemplate, isCoupon: !!node.isCoupon, shipDisassembled: false,
      descriptionMarkdown: node.descriptionMarkdown || '', customerFacingNotes: node.customerFacingNotes || '',
      labelIds, ownerIds: [], optInOuts: opt, defaults: dfl,
      inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
      partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [], partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
      partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: [],
      partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [], defaultSourceConversionItemId: null,
    };
  }

  const DUP_RE = /duplicate|unique|already|exists|violat|constraint/i;
  async function runOneItem(pn, action, api, deps) {
    const V = deps.validacionNodeIds, LABEL = deps.labelId;
    try {
      if (action === 'validate') {
        for (const node of V) {
          try { await api.query('CreateProcessNodePartNumberOptInout', buildValidationVars(pn.id, node)); }
          catch (e) { if (!DUP_RE.test(String(e))) throw e; }
        }
        return { id: pn.id, status: 'ok' };
      }
      if (action === 'unarchive') {
        await api.query('UpdatePartNumber', { id: pn.id, archivedAt: null });
        if (deps.alsoValidate) for (const node of V) { try { await api.query('CreateProcessNodePartNumberOptInout', buildValidationVars(pn.id, node)); } catch (e) { if (!DUP_RE.test(String(e))) throw e; } }
        return { id: pn.id, status: 'ok' };
      }
      if (action === 'unvalidate') {
        const data = await api.query('GetPartNumber', { partNumberId: pn.id });
        for (const oid of optInsToDelete(data?.partNumberById || {}, V)) await api.query('DeleteProcessNodePartNumberOptInOut', { id: oid });
        return { id: pn.id, status: 'ok' };
      }
      if (action === 'archive') {
        const data = await api.query('GetPartNumber', { partNumberId: pn.id });
        await api.query('SavePartNumber', { input: [buildArchiveInput(data?.partNumberById || { id: pn.id, name: pn.name }, LABEL)] });
        if (!pn.archived) await api.query('UpdatePartNumber', { id: pn.id, archivedAt: new Date().toISOString() });
        return { id: pn.id, status: 'ok' };
      }
      return { id: pn.id, status: 'noop' };
    } catch (e) { return { id: pn.id, status: 'error', error: String(e?.message || e).slice(0, 160) }; }
  }

  const INCLUDE_FOR_ACTION = { validate: 'NO', unvalidate: 'NO', archive: 'NO', unarchive: 'EXCLUSIVELY' };
  async function pageAll(api, includeArchived, archivedFlag, onProgress, pageSize, seen, out, step, steps) {
    let offset = 0, total = null;
    for (;;) {
      const data = await api.query('AllPartNumbers', { orderBy:['ID_ASC'], offset, first:pageSize, searchQuery:'', includeArchived }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) { const tc = data?.pagedData?.totalCount; total = (typeof tc==='number'&&tc>0)?tc:null; }
      for (const n of nodes) { if (seen.has(n.id)) continue; seen.add(n.id); out.push(slimPN(n, archivedFlag)); }
      if (onProgress) onProgress({ processed: offset + nodes.length, total, kept: out.length, step, steps });
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
  }
  async function fetchPNsForAction(action, api, onProgress, pageSize = 500, opts = {}) {
    const inc = INCLUDE_FOR_ACTION[action] || 'NO';
    const archivedFlag = inc === 'EXCLUSIVELY';
    const seen = new Set(), out = [];
    await pageAll(api, inc, archivedFlag, onProgress, pageSize, seen, out, 1, opts.includeArchivedToo ? 2 : 1);
    if (action === 'archive' && opts.includeArchivedToo) {
      await pageAll(api, 'EXCLUSIVELY', true, onProgress, pageSize, seen, out, 2, 2);
    }
    return out;
  }

  const api = { slimPN, matchesLabels, applyFilters, discoverFacets, selectDuplicates, adaptForClassify, isInTargetState, buildValidationVars, optInsToDelete, buildArchiveInput, INCLUDE_FOR_ACTION, fetchPNsForAction, DUP_RE, runOneItem };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SteelheadPNLifecycleCore = api;
})(typeof window !== 'undefined' ? window : null);
