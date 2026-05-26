// Steelhead Duplicate Tiers Module
// Bucketización + scoring de duplicados de PNs (DURO/MEDIO/SUAVE).
// Puro funcional: sin DOM, sin fetch, sin dependencias externas.
//
// Spec: docs/superpowers/specs/2026-05-25-integrity-tiers-design.md
//
// API expuesta en window.SADuplicateTiers:
//   • Bucketización (pase 1, solo AllPartNumbers):
//       hardBuckets(pns)
//       mediumBucketsCandidates(pns)
//       softBucketsCandidates(pns)
//   • Refinamiento (pase 2, requiere GetPartNumber detail por PN):
//       refineMediumBuckets(candidates, detailsByPnId, opts)
//       refineSoftBuckets(candidates, detailsByPnId, opts)
//   • Scoring:
//       scoreFor(pn, details)
//       pickWinner(bucket)
//   • Helpers:
//       canonicalMetal(name, metalEquivalents)
//       canonicalFinishings(labels, nonFinishLabelNames)
//       isNonFinishLabel(name, nonFinishLabelNames)
//       computeDeleteCandidates(bucket)

const SADuplicateTiers = (() => {
  'use strict';

  // ─── helpers ───────────────────────────────────────────────────
  function isNonFinishLabel(name, nonFinishList) {
    if (!name) return false;
    return Array.isArray(nonFinishList) && nonFinishList.includes(name);
  }
  function canonicalFinishings(labels, nonFinishList) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    for (const l of labels) {
      if (!l) continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      seen.add(l);
    }
    return [...seen].sort().join('|');
  }
  function canonicalMetal(metalBase, metalEquivalents) {
    if (!metalBase) return '';
    if (!Array.isArray(metalEquivalents)) return metalBase;
    for (const group of metalEquivalents) {
      if (!Array.isArray(group) || group.length === 0) continue;
      if (group.includes(metalBase)) return group[0];
    }
    return metalBase;
  }
  function parseCustomInputs(ci) {
    if (!ci) return {};
    if (typeof ci === 'string') {
      try { return JSON.parse(ci); } catch { return {}; }
    }
    return ci;
  }

  // ─── scoring ───────────────────────────────────────────────────
  function scoreFor(pn, details, opts) {
    const nonFinishList = (opts && opts.nonFinishLabelNames) || [];
    const ci = pn && pn.customInputs || {};
    const da = ci.DatosAdicionalesNP || {};
    const df = ci.DatosFacturacion || {};

    let score = 0;

    // Críticos (5)
    const hasProcess = !!(details && details.defaultProcessNodeId);
    if (hasProcess) score += 5;

    const specsArr = (details && details.partNumberSpecsByPartNumberId && details.partNumberSpecsByPartNumberId.nodes) || [];
    if (specsArr.length > 0) score += 5;

    // Enriquecimiento confiable (2)
    if (da.QuoteIBMS && String(da.QuoteIBMS).trim()) score += 2;

    const prices = (details && details.partNumberPricesByPartNumberId && details.partNumberPricesByPartNumberId.nodes) || [];
    if (prices.some(p => p && p.isDefault)) score += 2;

    if (ci.NotasAdicionales && String(ci.NotasAdicionales).trim()) score += 2;

    // Por cantidad (1 por item)
    // Finishings: prefer details.partNumberLabelsByPartNumberId; fallback a pn.labels (AllPartNumbers shape).
    let labelNames = [];
    if (details && details.partNumberLabelsByPartNumberId && Array.isArray(details.partNumberLabelsByPartNumberId.nodes)) {
      labelNames = details.partNumberLabelsByPartNumberId.nodes.map(n => n && n.labelByLabelId && n.labelByLabelId.name).filter(Boolean);
    } else if (Array.isArray(pn.labels)) {
      labelNames = pn.labels;
    }
    const finishings = labelNames.filter(l => !isNonFinishLabel(l, nonFinishList));
    score += finishings.length;

    score += specsArr.length;
    score += ((details && details.partNumberRackTypesByPartNumberId && details.partNumberRackTypesByPartNumberId.nodes) || []).length;
    score += ((details && details.inventoryPredictedUsagesByPartNumberId && details.inventoryPredictedUsagesByPartNumberId.nodes) || []).length;
    score += ((details && details.inventoryItemByPartNumberId && details.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId && details.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes) || []).length;
    score += ((details && details.dimensionCustomValueIds) || []).length;

    // Otros (1)
    if (details && details.descriptionMarkdown && String(details.descriptionMarkdown).trim()) score += 1;
    if (details && details.partNumberGroupId) score += 1;
    if (da.BaseMetal && String(da.BaseMetal).trim()) score += 1;
    if (df.CodigoSAT && String(df.CodigoSAT).trim()) score += 1;

    return score;
  }

  function pickWinner(bucket) {
    const members = (bucket && bucket.members) || [];
    if (!members.length) return null;
    // Orden: score DESC, createdAt DESC, id DESC.
    let winner = members[0];
    for (let i = 1; i < members.length; i++) {
      const m = members[i];
      if (m.score > winner.score) winner = m;
      else if (m.score === winner.score) {
        const t1 = new Date(m.createdAt || 0).getTime();
        const t2 = new Date(winner.createdAt || 0).getTime();
        if (t1 > t2) winner = m;
        else if (t1 === t2 && Number(m.id) > Number(winner.id)) winner = m;
      }
    }
    return winner.id;
  }

  // ─── bucketización (pase 1) ────────────────────────────────────
  function hardBuckets(pns) {
    const byKey = new Map();
    for (const pn of pns || []) {
      const ci = parseCustomInputs(pn.customInputs);
      const qibms = ci.DatosAdicionalesNP && ci.DatosAdicionalesNP.QuoteIBMS;
      if (!qibms || !String(qibms).trim()) continue;
      const key = String(qibms).trim();
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(pn);
    }
    const result = [];
    for (const [quoteIBMS, members] of byKey) {
      if (members.length >= 2) result.push({ quoteIBMS, members });
    }
    return result;
  }
  function mediumBucketsCandidates(pns) {
    const byKey = new Map();
    for (const pn of pns || []) {
      const cid = (pn.customerByCustomerId && pn.customerByCustomerId.id) || pn.customerId;
      if (cid == null) continue;
      const name = (pn.name || '').toUpperCase().trim();
      if (!name) continue;
      const key = cid + '||' + name;
      if (!byKey.has(key)) byKey.set(key, { customerId: cid, name, members: [] });
      byKey.get(key).members.push(pn);
    }
    return [...byKey.values()].filter(b => b.members.length >= 2);
  }
  function softBucketsCandidates(pns) { return []; }

  // ─── refinamiento (pase 2) ─────────────────────────────────────
  function refineMediumBuckets(candidates, detailsByPnId, opts) {
    const nonFinishList = (opts && opts.nonFinishLabelNames) || [];
    const metalEquiv = (opts && opts.metalEquivalents) || [];
    const result = [];
    for (const cand of candidates || []) {
      const subByKey = new Map();
      for (const pn of cand.members) {
        const det = detailsByPnId && detailsByPnId[pn.id];
        const ciSrc = (det && det.customInputs) || pn.customInputs;
        const ci = parseCustomInputs(ciSrc);
        const metalRaw = (ci.DatosAdicionalesNP && ci.DatosAdicionalesNP.BaseMetal) || '';
        const metalCanon = canonicalMetal(metalRaw, metalEquiv);
        const labelNodes = (det && det.partNumberLabelsByPartNumberId && det.partNumberLabelsByPartNumberId.nodes)
          || (pn.partNumberLabelsByPartNumberId && pn.partNumberLabelsByPartNumberId.nodes)
          || [];
        const labels = labelNodes.map(n => n && n.labelByLabelId && n.labelByLabelId.name).filter(Boolean);
        const finishings = canonicalFinishings(labels, nonFinishList);
        const subKey = metalCanon + '||' + finishings;
        if (!subByKey.has(subKey)) subByKey.set(subKey, { customerId: cand.customerId, name: cand.name, metalBase: metalCanon, finishings, members: [] });
        subByKey.get(subKey).members.push(pn);
      }
      for (const b of subByKey.values()) if (b.members.length >= 2) result.push(b);
    }
    return result;
  }
  function refineSoftBuckets(candidates, detailsByPnId, opts) { return []; }

  // ─── delete candidates ─────────────────────────────────────────
  // scaffolding: cuerpo se implementa en Task 9
  function computeDeleteCandidates(bucket) { return []; }

  return {
    hardBuckets, mediumBucketsCandidates, softBucketsCandidates,
    refineMediumBuckets, refineSoftBuckets,
    scoreFor, pickWinner,
    canonicalMetal, canonicalFinishings, isNonFinishLabel,
    computeDeleteCandidates,
  };
})();

if (typeof window !== 'undefined') window.SADuplicateTiers = SADuplicateTiers;
