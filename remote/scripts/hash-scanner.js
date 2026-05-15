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

  // Redact variable samples that may contain live Steelhead tokens or payloads.
  // Key-level redaction: catches secrets by field name recursively, no op-level blanking.
  const SENSITIVE_KEY_PATTERN = /^(body|rawBody|html|htmlBody|token|accessToken|authToken|emailData)$/i;
  const TOKEN_URL_PATTERN = /([?&])token=[^&"'\s]+/gi;
  const MAX_STRING_LENGTH = 500;

  function sanitizeValue(value, counter) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      let out = value.replace(TOKEN_URL_PATTERN, (_, sep) => { counter.n++; return `${sep}token=[REDACTED]`; });
      if (out.length > MAX_STRING_LENGTH) {
        counter.n++;
        return `[TRUNCATED: ${out.length} chars]`;
      }
      return out;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => sanitizeValue(v, counter));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
        counter.n++;
      } else {
        out[k] = sanitizeValue(v, counter);
      }
    }
    return out;
  }

  function sanitizeVariables(operationName, variables) {
    if (variables === null || variables === undefined) return variables;
    const counter = { n: 0 };
    const sanitized = sanitizeValue(variables, counter);
    if (counter.n > 0) {
      console.log(`[HashScanner] Redacted ${counter.n} sensitive value(s) in ${operationName}`);
    }
    return sanitized;
  }

  function init(config) {
    const mutations = config?.steelhead?.hashes?.mutations || {};
    const queries = config?.steelhead?.hashes?.queries || {};
    // Mutate in place so _internal references stay valid across init() calls
    Object.keys(knownHashMap).forEach(k => delete knownHashMap[k]);
    Object.keys(knownOpMap).forEach(k => delete knownOpMap[k]);
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

    // Periodically persist results to survive page reloads
    if (window.__saScanPersistInterval) clearInterval(window.__saScanPersistInterval);
    window.__saScanPersistInterval = setInterval(() => {
      if (!isScanning) return;
      // Signal content script to persist results via custom event
      document.dispatchEvent(new CustomEvent('sa-persist-scan'));
    }, 15000); // Every 15 seconds
  }

  function stop() {
    if (!isScanning) return;
    if (originalFetch) window.fetch = originalFetch;
    isScanning = false;
    if (window.__saScanPersistInterval) {
      clearInterval(window.__saScanPersistInterval);
      window.__saScanPersistInterval = null;
    }
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

    // Keep up to 3 variable samples (deduplicated by JSON string), sanitized
    if (variables && entry.variablesSamples.length < 3) {
      const sanitized = sanitizeVariables(operationName, variables);
      const vStr = JSON.stringify(sanitized);
      if (!entry.variablesSamples.some(v => JSON.stringify(v) === vStr)) {
        entry.variablesSamples.push(sanitized);
      }
    }

    // Merge response schema across calls — enriches sparse first responses
    if (responseData?.data) {
      const newSchema = analyzeSchema(responseData.data);
      entry.responseSchema = entry.responseSchema
        ? mergeSchema(entry.responseSchema, newSchema)
        : newSchema;
      // Rebuild field paths from merged schema
      entry.responseFields = extractFieldPaths(entry.responseSchema);
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

  // Recursive schema analyzer. No artificial depth limit; circular refs guarded by seen-set.
  function analyzeSchema(data, seen = new WeakSet()) {
    if (data === null || data === undefined) return null;
    if (typeof data !== 'object') return typeof data;
    if (seen.has(data)) return '[circular]';
    seen.add(data);
    if (Array.isArray(data)) {
      if (data.length === 0) return [null]; // marker: unknown item shape
      return [analyzeSchema(data[0], seen)];
    }
    const schema = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === '__typename') { schema.__typename = value; continue; }
      schema[key] = analyzeSchema(value, seen);
    }
    return schema;
  }

  // Merge two schemas. Used to enrich responseSchema across multiple calls.
  function mergeSchema(a, b) {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) {
      return [mergeSchema(a[0] ?? null, b[0] ?? null)];
    }
    if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
      const out = {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) out[k] = mergeSchema(a[k] ?? null, b[k] ?? null);
      return out;
    }
    if (typeof a === 'string' && typeof b === 'string') {
      return a === b ? a : `${a}|${b}`;
    }
    return a; // fallback: keep first non-null
  }

  // Extract flat list of field paths (e.g., "createQuote.quote.id")
  function extractFieldPaths(data, prefix = '', seen = new WeakSet()) {
    const paths = [];
    if (!data || typeof data !== 'object') return paths;
    if (seen.has(data)) return paths;
    seen.add(data);
    for (const [key, value] of Object.entries(data)) {
      if (key === '__typename') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        paths.push(...extractFieldPaths(value, path, seen));
      } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
        paths.push(...extractFieldPaths(value[0], `${path}[]`, seen));
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

  function mergeResults(data) {
    if (!data || typeof data !== 'object') return;
    for (const [opName, entry] of Object.entries(data)) {
      if (!discovered[opName]) {
        discovered[opName] = entry;
      } else {
        // Merge: keep higher count, earlier firstSeen, later lastSeen, union samples
        const existing = discovered[opName];
        existing.count += entry.count || 0;
        if (entry.firstSeen && (!existing.firstSeen || entry.firstSeen < existing.firstSeen)) {
          existing.firstSeen = entry.firstSeen;
        }
        if (entry.lastSeen && (!existing.lastSeen || entry.lastSeen > existing.lastSeen)) {
          existing.lastSeen = entry.lastSeen;
        }
        // Merge variable samples (keep up to 3 unique); re-sanitize defensively
        // in case incoming data was captured before redaction was in place.
        for (const sample of (entry.variablesSamples || [])) {
          if (existing.variablesSamples.length < 3) {
            const clean = sanitizeVariables(opName, sample);
            const sStr = JSON.stringify(clean);
            if (!existing.variablesSamples.some(v => JSON.stringify(v) === sStr)) {
              existing.variablesSamples.push(clean);
            }
          }
        }
        // Keep responseSchema if we didn't have one
        if (!existing.responseSchema && entry.responseSchema) {
          existing.responseSchema = entry.responseSchema;
          existing.responseFields = entry.responseFields || [];
        }
      }
    }
  }

  return {
    init, start, stop, getResults, getStats, isActive, exportConfig, clear, mergeResults,
    analyzeSchema, mergeSchema,
    _internal: { sanitizeValue, sanitizeVariables, analyzeSchema, mergeSchema, extractFieldPaths, recordOperation, discovered, knownHashMap, knownOpMap }
  };
})();

if (typeof window !== 'undefined') window.HashScanner = HashScanner;
if (typeof module !== 'undefined') module.exports = HashScanner;
