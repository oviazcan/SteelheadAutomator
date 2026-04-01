// Steelhead API Knowledge
// Reports what APIs the system knows — from config.knownOperations + hashes

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

    // From knownOperations (rich metadata with descriptions)
    const documentedKeys = new Set();
    for (const [opName, info] of Object.entries(known)) {
      const hashKey = info.hashKey || opName;
      const hash = allHashes[hashKey] || allHashes[opName];
      documentedKeys.add(hashKey);
      documentedKeys.add(opName);

      operations.push({
        operationName: opName,
        type: info.type || (mutations[hashKey] ? 'mutation' : 'query'),
        description: info.description,
        usedBy: info.usedBy || 'desconocido',
        hashKey: hashKey,
        hash: hash ? hash.substring(0, 16) + '...' : 'SIN HASH',
        hasHash: !!hash,
        documented: true
      });
    }

    // Hashes in config but NOT in knownOperations
    for (const [key, hash] of Object.entries(allHashes)) {
      if (documentedKeys.has(key)) continue;
      operations.push({
        operationName: key,
        type: mutations[key] ? 'mutation' : 'query',
        description: '(solo hash conocido — sin documentar)',
        usedBy: 'desconocido',
        hashKey: key,
        hash: hash.substring(0, 16) + '...',
        hasHash: true,
        documented: false
      });
    }

    operations.sort((a, b) => {
      if (a.documented !== b.documented) return a.documented ? -1 : 1;
      if (a.type !== b.type) return a.type === 'mutation' ? -1 : 1;
      return a.operationName.localeCompare(b.operationName);
    });

    return operations;
  }

  function getSummary() {
    const ops = getKnownOperations();
    const byApp = {};
    for (const op of ops) {
      byApp[op.usedBy] = (byApp[op.usedBy] || 0) + 1;
    }
    return {
      total: ops.length,
      documented: ops.filter(o => o.documented).length,
      mutations: ops.filter(o => o.type === 'mutation').length,
      queries: ops.filter(o => o.type === 'query').length,
      withHash: ops.filter(o => o.hasHash).length,
      byApp
    };
  }

  return { init, getKnownOperations, getSummary };
})();

if (typeof window !== 'undefined') window.APIKnowledge = APIKnowledge;
