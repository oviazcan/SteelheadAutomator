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

  // ─── scoring ───────────────────────────────────────────────────
  // scaffolding: cuerpos se implementan en Tasks 3-4
  function scoreFor(pn, details) { return 0; }
  function pickWinner(bucket) { return null; }

  // ─── bucketización (pase 1) ────────────────────────────────────
  // scaffolding: cuerpos se implementan en Tasks 5-7
  function hardBuckets(pns) { return []; }
  function mediumBucketsCandidates(pns) { return []; }
  function softBucketsCandidates(pns) { return []; }

  // ─── refinamiento (pase 2) ─────────────────────────────────────
  // scaffolding: cuerpos se implementan en Tasks 6-7
  function refineMediumBuckets(candidates, detailsByPnId, opts) { return []; }
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
