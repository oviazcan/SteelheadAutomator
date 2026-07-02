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

  const api = { slimPN, matchesLabels, applyFilters, discoverFacets, selectDuplicates, adaptForClassify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SteelheadPNLifecycleCore = api;
})(typeof window !== 'undefined' ? window : null);
