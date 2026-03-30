// Steelhead API Client
// Wraps GraphQL persisted query calls to Steelhead ERP
// Uses session cookies from the active browser tab for authentication

const SteelheadAPI = (() => {
  'use strict';

  let config = null;

  function init(remoteConfig) {
    config = remoteConfig;
  }

  function getBaseUrl() {
    return config?.steelhead?.baseUrl || 'https://app.gosteelhead.com';
  }

  function getHash(operationName) {
    const mutations = config?.steelhead?.hashes?.mutations || {};
    const queries = config?.steelhead?.hashes?.queries || {};
    return mutations[operationName] || queries[operationName];
  }

  // Core GraphQL call using Apollo Persisted Queries
  async function query(operationName, variables = {}) {
    const hash = getHash(operationName);
    if (!hash) {
      throw new Error(`Hash no encontrado para operación: ${operationName}`);
    }

    const body = {
      operationName,
      variables,
      extensions: {
        clientLibrary: {
          name: '@apollo/client',
          version: config?.steelhead?.apolloClientVersion || '4.0.8'
        },
        persistedQuery: {
          version: 1,
          sha256Hash: hash
        }
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
      throw new Error(`HTTP ${response.status} en ${operationName}`);
    }

    const result = await response.json();
    if (result.errors?.length) {
      const msg = result.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL error en ${operationName}: ${msg}`);
    }

    return result.data;
  }

  // Keep-alive to prevent session timeout
  async function keepAlive() {
    const url = `${getBaseUrl()}${config?.steelhead?.keepAliveEndpoint || '/api/session/keep-alive'}`;
    await fetch(url, { method: 'POST', credentials: 'include' });
  }

  // Domain constants helper
  function getDomain() {
    return config?.steelhead?.domain || {};
  }

  return { init, query, keepAlive, getDomain, getHash };
})();

// Make available globally
if (typeof window !== 'undefined') {
  window.SteelheadAPI = SteelheadAPI;
}
