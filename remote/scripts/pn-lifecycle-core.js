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

  const api = { slimPN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SteelheadPNLifecycleCore = api;
})(typeof window !== 'undefined' ? window : null);
