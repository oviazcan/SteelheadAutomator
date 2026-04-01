// Steelhead API Knowledge
// Merges: config.knownOperations + config.hashes + HashScanner.discovered (live)

const APIKnowledge = (() => {
  'use strict';

  let config = null;

  function init(remoteConfig) {
    config = remoteConfig;
  }

  function getKnownOperations() {
    const known = config?.knownOperations || {};
    const mutations = config?.steelhead?.hashes?.mutations || {};
    const queries = config?.steelhead?.hashes?.queries || {};
    const allHashes = { ...mutations, ...queries };

    const operations = [];
    const seenOps = new Set();

    // 1. From knownOperations (documented with descriptions)
    for (const [opName, info] of Object.entries(known)) {
      const hashKey = info.hashKey || opName;
      const hash = allHashes[hashKey] || allHashes[opName];
      seenOps.add(opName);
      seenOps.add(hashKey);

      operations.push({
        operationName: opName,
        type: info.type || (mutations[hashKey] ? 'mutation' : 'query'),
        description: info.description,
        usedBy: info.usedBy || 'desconocido',
        hashKey: hashKey,
        hash: hash ? hash.substring(0, 16) + '...' : 'SIN HASH',
        hasHash: !!hash,
        source: 'documentada',
        responseFields: null
      });
    }

    // 2. From config hashes not in knownOperations
    for (const [key, hash] of Object.entries(allHashes)) {
      if (seenOps.has(key)) continue;
      seenOps.add(key);
      operations.push({
        operationName: key,
        type: mutations[key] ? 'mutation' : 'query',
        description: '(hash en config — sin documentar)',
        usedBy: 'config',
        hashKey: key,
        hash: hash.substring(0, 16) + '...',
        hasHash: true,
        source: 'config',
        responseFields: null
      });
    }

    // 3. From HashScanner discovered (live session)
    if (window.HashScanner) {
      const discovered = window.HashScanner.getResults();
      for (const [opName, entry] of Object.entries(discovered)) {
        if (seenOps.has(opName)) {
          // Enrich existing entry with live data
          const existing = operations.find(o => o.operationName === opName);
          if (existing) {
            if (entry.responseFields?.length) existing.responseFields = entry.responseFields;
            if (entry.variablesSamples?.length) existing.variablesSample = entry.variablesSamples[0];
            existing.scanCount = entry.count;
            existing.lastSeen = entry.lastSeen;
            if (existing.source === 'documentada') existing.source = 'documentada + escaneada';
            else existing.source = 'config + escaneada';
          }
          continue;
        }
        seenOps.add(opName);
        const isMutation = /^(Create|Update|Save|Delete|Set|Add|Remove|Archive|Insert)/.test(opName);
        operations.push({
          operationName: opName,
          type: isMutation ? 'mutation' : 'query',
          description: entry.responseFields?.length
            ? `Descubierta: ${entry.responseFields.slice(0, 3).join(', ')}...`
            : '(descubierta por scanner — sin documentar)',
          usedBy: 'scanner',
          hashKey: opName,
          hash: entry.hash ? entry.hash.substring(0, 16) + '...' : '?',
          hasHash: !!entry.hash,
          source: 'escaneada',
          responseFields: entry.responseFields,
          scanCount: entry.count,
          lastSeen: entry.lastSeen,
          variablesSample: entry.variablesSamples?.[0]
        });
      }
    }

    operations.sort((a, b) => {
      const sourceOrder = { 'documentada + escaneada': 0, 'documentada': 1, 'config + escaneada': 2, 'config': 3, 'escaneada': 4 };
      const sa = sourceOrder[a.source] ?? 5;
      const sb = sourceOrder[b.source] ?? 5;
      if (sa !== sb) return sa - sb;
      if (a.type !== b.type) return a.type === 'mutation' ? -1 : 1;
      return a.operationName.localeCompare(b.operationName);
    });

    return operations;
  }

  function getSummary() {
    const ops = getKnownOperations();
    const bySource = {};
    for (const op of ops) bySource[op.source] = (bySource[op.source] || 0) + 1;
    return {
      total: ops.length,
      documented: ops.filter(o => o.source.includes('documentada')).length,
      mutations: ops.filter(o => o.type === 'mutation').length,
      queries: ops.filter(o => o.type === 'query').length,
      scanned: ops.filter(o => o.source.includes('escaneada')).length,
      withHash: ops.filter(o => o.hasHash).length,
      bySource
    };
  }

  return { init, getKnownOperations, getSummary };
})();

if (typeof window !== 'undefined') window.APIKnowledge = APIKnowledge;
