// Steelhead Hash Scanner
// Monkey-patches fetch to intercept all GraphQL requests
// Captures operationName, hash, variables, and response schema

const HashScanner = (() => {
  'use strict';

  let isScanning = false;
  let originalFetch = null;
  const discovered = {}; // operationName → { hash, count, firstSeen, lastSeen, variablesSamples, responseSchema, status, configKey }
  let knownHashMap = {}; // hash → configKey
  let knownOpMap = {};   // configKey → hash

  function init(config) {
    const mutations = config?.steelhead?.hashes?.mutations || {};
    const queries = config?.steelhead?.hashes?.queries || {};
    knownHashMap = {};
    knownOpMap = {};
    for (const [key, hash] of Object.entries({ ...mutations, ...queries })) {
      knownHashMap[hash] = key;
      knownOpMap[key] = hash;
    }
    console.log(`[HashScanner] Inicializado con ${Object.keys(knownHashMap).length} hashes conocidos`);
  }

  function start() {
    if (isScanning) return;
    isScanning = true;
    originalFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, options] = args;
      const urlStr = typeof url === 'string' ? url : url?.url || '';

      if (urlStr.includes('/graphql') && options?.method === 'POST') {
        try {
          const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
          const operationName = body.operationName;
          const hash = body.extensions?.persistedQuery?.sha256Hash;
          const variables = body.variables;

          const response = await originalFetch.apply(this, args);
          const clonedResponse = response.clone();
          let responseData = null;
          try { responseData = await clonedResponse.json(); } catch (_) {}

          if (operationName && hash) {
            recordOperation(operationName, hash, variables, responseData);
          }

          return response;
        } catch (e) {
          return originalFetch.apply(this, args);
        }
      }

      return originalFetch.apply(this, args);
    };

    console.log('[HashScanner] Captura iniciada — navega por Steelhead para capturar operaciones');
  }

  function stop() {
    if (!isScanning) return;
    if (originalFetch) window.fetch = originalFetch;
    isScanning = false;
    console.log('[HashScanner] Captura detenida');
  }

  function recordOperation(operationName, hash, variables, responseData) {
    if (!discovered[operationName]) {
      discovered[operationName] = {
        hash, count: 0, firstSeen: new Date().toISOString(), lastSeen: null,
        variablesSamples: [], responseSchema: null, responseFields: [],
        status: 'unknown', configKey: null
      };
    }

    const entry = discovered[operationName];
    entry.count++;
    entry.lastSeen = new Date().toISOString();
    entry.hash = hash;

    // Keep up to 3 variable samples (deduplicated by JSON string)
    if (variables && entry.variablesSamples.length < 3) {
      const vStr = JSON.stringify(variables);
      if (!entry.variablesSamples.some(v => JSON.stringify(v) === vStr)) {
        entry.variablesSamples.push(variables);
      }
    }

    // Analyze response structure (first time only, or if previous was null)
    if (responseData?.data && !entry.responseSchema) {
      entry.responseSchema = analyzeSchema(responseData.data);
      entry.responseFields = extractFieldPaths(responseData.data);
    }

    // Determine status vs known config
    const knownKey = knownHashMap[hash];
    if (knownKey) {
      entry.status = 'known';
      entry.configKey = knownKey;
    } else {
      // Check if operationName matches a config key but hash differs
      const existingHash = knownOpMap[operationName];
      if (existingHash && existingHash !== hash) {
        entry.status = 'changed';
        entry.configKey = operationName;
        entry.previousHash = existingHash;
      } else {
        entry.status = 'new';
      }
    }
  }

  // Analyze JSON structure recursively — returns type tree
  function analyzeSchema(data, depth = 0, maxDepth = 4) {
    if (depth > maxDepth) return '...';
    if (data === null || data === undefined) return 'null';
    if (Array.isArray(data)) {
      if (data.length === 0) return '[]';
      return [analyzeSchema(data[0], depth + 1, maxDepth)];
    }
    if (typeof data === 'object') {
      const schema = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === '__typename') { schema.__typename = value; continue; }
        schema[key] = analyzeSchema(value, depth + 1, maxDepth);
      }
      return schema;
    }
    return typeof data;
  }

  // Extract flat list of field paths (e.g., "createQuote.quote.id")
  function extractFieldPaths(data, prefix = '', depth = 0, maxDepth = 3) {
    const paths = [];
    if (depth > maxDepth || !data || typeof data !== 'object') return paths;
    for (const [key, value] of Object.entries(data)) {
      if (key === '__typename') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        paths.push(...extractFieldPaths(value, path, depth + 1, maxDepth));
      } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
        paths.push(...extractFieldPaths(value[0], `${path}[]`, depth + 1, maxDepth));
      }
    }
    return paths;
  }

  function getResults() { return discovered; }
  function isActive() { return isScanning; }

  function getStats() {
    const entries = Object.values(discovered);
    return {
      total: entries.length,
      known: entries.filter(d => d.status === 'known').length,
      new: entries.filter(d => d.status === 'new').length,
      changed: entries.filter(d => d.status === 'changed').length,
      totalRequests: entries.reduce((sum, d) => sum + d.count, 0)
    };
  }

  // Merge discovered hashes into config
  function exportConfig(currentConfig) {
    const updated = JSON.parse(JSON.stringify(currentConfig));
    for (const [opName, entry] of Object.entries(discovered)) {
      if (entry.status === 'new' || entry.status === 'changed') {
        const isMutation = /^(Create|Update|Save|Delete|Set|Add|Remove|Archive|Insert)/.test(opName);
        const section = isMutation ? 'mutations' : 'queries';
        updated.steelhead.hashes[section][opName] = entry.hash;
      }
    }
    updated.lastUpdated = new Date().toISOString().split('T')[0];
    return updated;
  }

  function clear() {
    Object.keys(discovered).forEach(k => delete discovered[k]);
  }

  return { init, start, stop, getResults, getStats, isActive, exportConfig, clear, analyzeSchema };
})();

if (typeof window !== 'undefined') window.HashScanner = HashScanner;
