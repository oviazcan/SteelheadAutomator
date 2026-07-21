// Steelhead API Client v9
// Wraps GraphQL persisted query calls to Steelhead ERP
// Uses session cookies from the active browser tab for authentication

const SteelheadAPI = (() => {
  'use strict';

  let config = null;
  const _log = [];
  // 1.5.8: cap del _log + debounce del persist.
  // Pre-1.5.8: _log era unbounded y _persist() escribía el array completo a
  // localStorage SÍNCRONO en cada log()/warn(). En runs largos (1000+ logs):
  //   - JSON.stringify de un array de N entradas es O(N²) por call.
  //   - Cada localStorage.setItem bloquea el main thread por ms.
  //   - sa_last_log crecía hasta el límite de localStorage (5-10 MB) y luego
  //     fallaba silenciosamente, perdiendo el log final justo cuando importa.
  // Ring buffer + debounce arregla los 3.
  const _LOG_MAX = 500;
  let _persistTimer = null;

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

  function copyLastLog() {
    const saved = localStorage.getItem('sa_last_log');
    if (!saved) return { error: 'No hay log guardado' };
    const lines = JSON.parse(saved);
    navigator.clipboard.writeText(lines.join('\n'));
    return { message: `Log copiado (${lines.length} líneas)` };
  }

  // Gate de ruido en consola (audit pre-producción #5). El `console.log` informativo se
  // suprime por default en producción; la PERSISTENCIA (ring buffer + sa_last_log) se
  // mantiene SIEMPRE, así que copyLastLog() conserva el diagnóstico post-mortem. `warn`
  // queda SIEMPRE visible (son señales de problema reales). Activar en vivo sin re-deploy:
  //   localStorage.sa_debug = '1'   (en la consola del tab)   — o config.debug === true.
  function _debugOn() {
    try { if (localStorage.getItem('sa_debug') === '1') return true; } catch (_) {}
    return config?.debug === true;
  }
  function log(msg)  { const s = `[SA] ${msg}`; if (_debugOn()) console.log(s); _pushLog(s); }
  function warn(msg) { const s = `[SA] WARN: ${msg}`; console.warn(s); _pushLog(s); }

  function _pushLog(s) {
    _log.push(s);
    if (_log.length > _LOG_MAX) _log.splice(0, _log.length - _LOG_MAX);
    _schedulePersist();
  }

  function _schedulePersist() {
    if (_persistTimer) return;
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      try { localStorage.setItem('sa_last_log', JSON.stringify(_log)); } catch (_) {}
    }, 200);
  }

  // Core GraphQL call using Apollo Persisted Queries
  // hashKey is optional — if provided, uses that key to look up the hash but sends operationName to GraphQL
  async function query(operationName, variables = {}, hashKey) {
    const hash = getHash(hashKey || operationName);
    if (!hash) throw new Error(`Hash no encontrado para operación: ${hashKey || operationName}`);

    const body = {
      operationName,
      variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: config?.steelhead?.apolloClientVersion || '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: hash }
      }
    };

    const url = `${getBaseUrl()}${config?.steelhead?.graphqlEndpoint || '/graphql'}`;
    // F2: AbortController por llamada. Default generoso (90s) — captura llamadas colgadas
    // (SH sin responder por minutos, que dejaban el slot del runPool bloqueado) sin abortar
    // queries lentas legítimas (<30s típico). Configurable vía config.steelhead.fetchTimeoutMs.
    // El mensaje 'timeout' es retryable en bulk-upload (RETRYABLE_PATTERNS).
    const timeoutMs = config?.steelhead?.fetchTimeoutMs || 90000;
    const _ctrl = new AbortController();
    const _timer = setTimeout(() => _ctrl.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: _ctrl.signal
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error(`Request timeout (${timeoutMs}ms) en ${operationName}`);
      throw e;
    } finally {
      clearTimeout(_timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Detección de persisted query rotada/deprecada: Steelhead responde HTTP 400
      // "Must provide a query string." (o "PersistedQueryNotFound") cuando el sha256Hash
      // que mandamos ya no está en su registry — típicamente porque rotó con un release
      // del front. Marcamos el error (`persistedQueryRotated`) para que los applets aborten
      // con un mensaje claro en vez de acumular cientos de fallos crípticos, avisamos UNA
      // vez por operación, y llevamos un contador global consultable (window.__saRotatedOps).
      const rotated = /must provide a query string|persistedquerynotfound/i.test(text);
      if (rotated) {
        const g = (typeof window !== 'undefined') ? window : globalThis;
        g.__saRotatedOps = g.__saRotatedOps || {};
        if (!g.__saRotatedOps[operationName]) {
          g.__saRotatedOps[operationName] = 0;
          warn(`🔴 HASH ROTADO: Steelhead ya no acepta la persisted query "${operationName}" ("Must provide a query string"). El hash en config.json quedó viejo (rotó con un release de Steelhead). Hay que re-escanear (hash-scanner) y actualizar config.json. Los applets que usan "${operationName}" van a fallar hasta entonces.`);
        }
        g.__saRotatedOps[operationName]++;
      }
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.errors)) detail = parsed.errors.map((e, i) => {
          // Cuando el server responde HTTP !ok con errors[] pero SIN message (p.ej.
          // un 500 "mudo" por excepción no controlada del resolver), `e.message` es
          // undefined y antes se perdía TODO el detalle (extensions/code/path) →
          // el applet solo veía "[1] undefined". Preservamos el error completo en
          // ese caso para poder diagnosticar. No afecta el caso normal (con message),
          // así que los matchers de string existentes (conflicting/exclusion) siguen igual.
          const m = e?.message;
          return `[${i + 1}] ${(m != null && m !== '') ? m : JSON.stringify(e)}`;
        }).join(' | ');
      } catch (_) { /* text no era JSON; usar crudo */ }
      const err = new Error(`HTTP ${response.status} en ${operationName}: ${detail.substring(0, 2000)}`);
      if (rotated) { err.persistedQueryRotated = true; err.rotatedOp = operationName; }
      throw err;
    }

    const result = await response.json();
    if (result.errors && !result.data) {
      const msgs = result.errors.map((e, i) => `[${i + 1}] ${e.message}`).join(' | ');
      throw new Error(`GraphQL errors (${operationName}): ${msgs.substring(0, 2000)}`);
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

  return { init, query, queryWithFallback, keepAlive, getDomain, getHash, getLog, copyLastLog, log, warn };
})();

if (typeof window !== 'undefined') window.SteelheadAPI = SteelheadAPI;
