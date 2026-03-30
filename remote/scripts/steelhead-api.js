// Steelhead API Client v9
// Wraps GraphQL persisted query calls to Steelhead ERP
// Uses session cookies from the active browser tab for authentication

const SteelheadAPI = (() => {
  'use strict';

  let config = null;
  const _log = [];

  function init(remoteConfig) {
    config = remoteConfig;
  }

  function getBaseUrl() {
    return config?.steelhead?.baseUrl || 'https://app.gosteelhead.com';
  }

  function getHash(operationName) {
    const m = config?.steelhead?.hashes?.mutations || {};
    const q = config?.steelhead?.hashes?.queries || {};
    return m[operationName] || q[operationName];
  }

  function getDomain() {
    return config?.steelhead?.domain || {};
  }

  function getLog() { return _log; }

  function log(msg)  { const s = `[SA] ${msg}`; console.log(s); _log.push(s); }
  function warn(msg) { const s = `[SA] WARN: ${msg}`; console.warn(s); _log.push(s); }

  // Core GraphQL call using Apollo Persisted Queries
  async function query(operationName, variables = {}) {
    const hash = getHash(operationName);
    if (!hash) throw new Error(`Hash no encontrado para operación: ${operationName}`);

    const body = {
      operationName,
      variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: config?.steelhead?.apolloClientVersion || '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: hash }
      }
    };

    const url = `${getBaseUrl()}${config?.steelhead?.graphqlEndpoint || '/graphql'}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} en ${operationName}: ${text.substring(0, 200)}`);
    }

    const result = await response.json();
    if (result.errors && !result.data) {
      throw new Error(`GraphQL errors (${operationName}): ${JSON.stringify(result.errors).substring(0, 300)}`);
    }
    if (result.errors) {
      warn(`GraphQL warnings (${operationName}): ${result.errors.map(e => e.message).join('; ')}`);
    }

    return result.data;
  }

  // Try hashA, fall back to hashB on failure
  async function queryFallback(operationName, hashKeyA, hashKeyB, variables = {}) {
    const hashA = getHash(hashKeyA);
    const hashB = getHash(hashKeyB);
    try {
      const origHash = getHash(operationName);
      // Temporarily override hash
      const m = config.steelhead.hashes.mutations;
      const q = config.steelhead.hashes.queries;
      if (m[operationName] !== undefined) m[operationName] = hashA; else q[operationName] = hashA;
      const data = await query(operationName, variables);
      log(`  ${operationName}: hash A OK`);
      // Restore
      if (m[operationName] !== undefined) m[operationName] = origHash; else q[operationName] = origHash;
      return { data, usedHash: 'A' };
    } catch (e) {
      warn(`${operationName}: hash A falló, intentando B...`);
      const m = config.steelhead.hashes.mutations;
      const q = config.steelhead.hashes.queries;
      const origHash = getHash(operationName);
      if (m[operationName] !== undefined) m[operationName] = hashB; else q[operationName] = hashB;
      const data = await query(operationName, variables);
      log(`  ${operationName}: hash B OK`);
      if (m[operationName] !== undefined) m[operationName] = origHash; else q[operationName] = origHash;
      return { data, usedHash: 'B' };
    }
  }

  // Simpler fallback: try with two different hash keys directly
  async function queryWithFallback(operationName, hashKeyA, hashKeyB, variables = {}) {
    const hashA = getHash(hashKeyA);
    const hashB = getHash(hashKeyB);
    if (!hashA && !hashB) throw new Error(`No hash para ${hashKeyA} ni ${hashKeyB}`);

    const makeBody = (hash) => ({
      operationName,
      variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: config?.steelhead?.apolloClientVersion || '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: hash }
      }
    });

    const url = `${getBaseUrl()}${config?.steelhead?.graphqlEndpoint || '/graphql'}`;
    const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include' };

    if (hashA) {
      try {
        const r = await fetch(url, { ...opts, body: JSON.stringify(makeBody(hashA)) });
        if (r.ok) {
          const json = await r.json();
          if (json.data && !json.errors?.length) { log(`  ${operationName}: hash ${hashKeyA} OK`); return { data: json.data, usedHash: 'A' }; }
          if (json.data) { warn(`${operationName} warnings: ${json.errors?.map(e=>e.message).join('; ')}`); return { data: json.data, usedHash: 'A' }; }
        }
      } catch (_) { /* fall through */ }
      warn(`${operationName}: ${hashKeyA} falló, intentando ${hashKeyB}...`);
    }

    if (hashB) {
      const r = await fetch(url, { ...opts, body: JSON.stringify(makeBody(hashB)) });
      if (!r.ok) throw new Error(`HTTP ${r.status} en ${operationName}`);
      const json = await r.json();
      if (json.errors && !json.data) throw new Error(`GraphQL errors (${operationName}): ${JSON.stringify(json.errors).substring(0, 300)}`);
      if (json.errors) warn(`${operationName} warnings: ${json.errors.map(e=>e.message).join('; ')}`);
      log(`  ${operationName}: hash ${hashKeyB} OK`);
      return { data: json.data, usedHash: 'B' };
    }

    throw new Error(`Ambos hashes fallaron para ${operationName}`);
  }

  // Keep-alive to prevent session timeout
  async function keepAlive() {
    const url = `${getBaseUrl()}${config?.steelhead?.keepAliveEndpoint || '/api/session/keep-alive'}`;
    await fetch(url, { method: 'POST', credentials: 'include' });
  }

  return { init, query, queryWithFallback, keepAlive, getDomain, getHash, getLog, log, warn };
})();

if (typeof window !== 'undefined') window.SteelheadAPI = SteelheadAPI;
