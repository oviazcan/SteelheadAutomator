// Steelhead Hash Scanner
// Monkey-patches fetch to intercept all GraphQL requests
// Captures operationName, hash, variables, and response schema

const HashScanner = (() => {
  'use strict';

  let isScanning = false;
  let originalFetch = null;
  const discovered = {}; // operationName → { hash, count, firstSeen, lastSeen, variablesSamples, responseSchema, status, configKey }
  const eventLog = [];
  const MAX_EVENT_LOG = 2000;
  let knownHashMap = {}; // hash → configKey
  let knownOpMap = {};   // configKey → hash

  // ── Instrumentación de discovery (Fase B): pantalla + breadcrumb de click por op ──
  const MAX_SCREENS_PER_OP = 5;
  let lastClick = null; // { breadcrumb, ts }
  let clickListener = null;
  let pageHideHandler = null;

  // Descripción corta y NO sensible del control clickeado: tag[role]:textoCorto.
  // Trunca el texto a 40 chars; nunca incluye value/payloads.
  function describeClickTarget(el) {
    if (!el) return '(desconocido)';
    const tag = (el.tagName || '').toLowerCase();
    const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
    const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const text = rawText.slice(0, 40);
    return `${tag}${role ? `[${role}]` : ''}${text ? `:${text}` : ''}`;
  }

  // Anexa {pathname, breadcrumb} a entry.screens, dedup por pathname (sube count),
  // cap MAX_SCREENS_PER_OP. Es la evidencia op→pantalla para el generador de catálogo.
  function recordScreen(entry, pathname, breadcrumb) {
    entry.screens = entry.screens || [];
    const hit = entry.screens.find((s) => s.pathname === pathname);
    if (hit) { hit.count++; return; }
    if (entry.screens.length >= MAX_SCREENS_PER_OP) return;
    entry.screens.push({ pathname, breadcrumb, count: 1 });
  }

  const MAX_SAMPLES_PER_OP = 10;
  const MAX_RESPONSE_SAMPLES_PER_OP = 2;

  // Stable signature of an object's structural shape (keys + value types).
  // Used to dedup variablesSamples by shape, not by exact value equality.
  function shapeSignature(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return `[${shapeSignature(value[0])}]`;
    }
    if (typeof value !== 'object') return typeof value;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${k}:${shapeSignature(value[k])}`).join(',')}}`;
  }

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

    // Breadcrumb: registra el último control clickeado (captura fase para no
    // perder clicks que hagan stopPropagation). Solo activo mientras se escanea.
    clickListener = (ev) => {
      try { lastClick = { breadcrumb: describeClickTarget(ev.target), ts: Date.now() }; } catch (_) {}
    };
    document.addEventListener('click', clickListener, true);

    // Restaurar backup del pagehide previo (lo capturado justo antes de una recarga,
    // que el persist periódico no alcanzó a guardar). Se limpia tras restaurar.
    try {
      const bak = localStorage.getItem('__sa_scan_backup');
      if (bak) { mergeResults(JSON.parse(bak)); localStorage.removeItem('__sa_scan_backup'); }
    } catch (_) {}

    // Salvavidas ante recarga/cierre: backup SLIM SÍNCRONO a localStorage. chrome.storage
    // es async y NO completa en pagehide → sin esto, lo navegado en los segundos previos
    // a una recarga se perdía (causa raíz del bug "recarga pierde el scan").
    pageHideHandler = () => { try { localStorage.setItem('__sa_scan_backup', JSON.stringify(slimForBackup())); } catch (_) {} };
    window.addEventListener('pagehide', pageHideHandler);

    window.fetch = async function (...args) {
      const [url, options] = args;
      const urlStr = typeof url === 'string' ? url : url?.url || '';

      if (urlStr.includes('/graphql') && options?.method === 'POST') {
        try {
          const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
          const operationName = body.operationName;
          const hash = body.extensions?.persistedQuery?.sha256Hash;
          const variables = body.variables;

          const headers = options?.headers || {};
          const apolloVersion = (typeof headers.get === 'function')
            ? headers.get('apollographql-client-version')
            : (headers['apollographql-client-version'] || headers['Apollographql-Client-Version']);
          const pathname = (typeof location !== 'undefined' && location.pathname) ? location.pathname : null;
          const recentClick = (lastClick && Date.now() - lastClick.ts < 5000) ? lastClick.breadcrumb : null;
          const meta = { url: urlStr, apolloVersion, pathname, breadcrumb: recentClick };

          const response = await originalFetch.apply(this, args);
          const httpStatus = response.status;
          const clonedResponse = response.clone();
          let responseData = null;
          try { responseData = await clonedResponse.json(); } catch (_) {}

          if (operationName && hash) {
            recordOperation(operationName, hash, variables, responseData, httpStatus, meta);
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
    }, 5000); // cada 5s (defensa; el salvavidas real ante recarga es pagehide→localStorage)
  }

  function stop() {
    if (!isScanning) return;
    if (originalFetch) window.fetch = originalFetch;
    isScanning = false;
    if (clickListener) { document.removeEventListener('click', clickListener, true); clickListener = null; }
    if (pageHideHandler) { window.removeEventListener('pagehide', pageHideHandler); pageHideHandler = null; }
    if (window.__saScanPersistInterval) {
      clearInterval(window.__saScanPersistInterval);
      window.__saScanPersistInterval = null;
    }
    console.log('[HashScanner] Captura detenida');
  }

  function recordOperation(operationName, hash, variables, responseData, httpStatus, meta) {
    if (!discovered[operationName]) {
      discovered[operationName] = {
        hash, count: 0, firstSeen: new Date().toISOString(), lastSeen: null,
        variablesSamples: [], responseSchema: null, responseFields: [],
        responseSamples: [],
        errorSamples: [], errorCount: 0, lastHttpStatus: null,
        url: null, apolloVersion: null,
        status: 'unknown', configKey: null,
        screens: []
      };
    }

    const entry = discovered[operationName];
    // Normaliza arrays por si la entrada vino de un backup restaurado (defensa: evita undefined.map/.length)
    entry.variablesSamples = entry.variablesSamples || [];
    entry.responseSamples = entry.responseSamples || [];
    entry.errorSamples = entry.errorSamples || [];
    entry.screens = entry.screens || [];
    entry.count++;
    entry.lastSeen = new Date().toISOString();
    entry.hash = hash;

    // Keep up to MAX_SAMPLES_PER_OP samples, deduped by shape signature.
    // Diverse shapes are more useful than exact-value duplicates.
    if (variables && entry.variablesSamples.length < MAX_SAMPLES_PER_OP) {
      const sanitized = sanitizeVariables(operationName, variables);
      const sig = shapeSignature(sanitized);
      entry._sigs = entry._sigs || new Set();
      if (!entry._sigs.has(sig)) {
        entry._sigs.add(sig);
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

    // Keep raw response samples for reproducibility (real IDs to re-run from console)
    if (responseData?.data && entry.responseSamples.length < MAX_RESPONSE_SAMPLES_PER_OP) {
      const counter = { n: 0 };
      const cleaned = sanitizeValue(responseData.data, counter);
      entry.responseSamples.push(cleaned);
    }

    // Capture HTTP status + errors (deprecated hashes return 400, GraphQL errors return 200 with errors[])
    if (httpStatus !== undefined) entry.lastHttpStatus = httpStatus;
    const errs = Array.isArray(responseData?.errors) ? responseData.errors : null;
    if (errs && errs.length > 0) {
      entry.errorCount = (entry.errorCount || 0) + 1;
      if (entry.errorSamples.length < 3) {
        const counter = { n: 0 };
        entry.errorSamples.push(sanitizeValue(errs, counter));
      }
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

    if (meta?.url) entry.url = meta.url;
    if (meta?.apolloVersion) entry.apolloVersion = meta.apolloVersion;
    if (meta?.pathname) {
      const counter = { n: 0 };
      const bc = meta.breadcrumb ? sanitizeValue(meta.breadcrumb, counter) : null;
      recordScreen(entry, meta.pathname, bc);
    }

    // Append to chronological event log (cap MAX_EVENT_LOG, drop oldest)
    eventLog.push({
      ts: entry.lastSeen,
      op: operationName,
      varsSig: variables ? shapeSignature(variables) : null,
      ok: !errs || errs.length === 0,
      status: httpStatus ?? null
    });
    if (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
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

  // Backup mínimo para localStorage (pagehide): hash + screens + estado, SIN los samples
  // pesados (evita exceder la cuota de localStorage en scans grandes).
  function slimForBackup() {
    const out = {};
    for (const [op, v] of Object.entries(discovered)) {
      // Incluye los arrays VACÍOS (no su contenido pesado): mergeResults/recordOperation
      // los asumen presentes → sin esto, una entrada restaurada rompía con undefined.map.
      out[op] = { hash: v.hash, count: v.count, status: v.status, configKey: v.configKey,
        screens: v.screens || [], variablesSamples: [], responseSamples: [], errorSamples: [], errorCount: 0 };
    }
    return out;
  }

  function getResults() {
    const ops = {};
    for (const [k, v] of Object.entries(discovered)) {
      const { _sigs, ...rest } = v;
      ops[k] = rest;
    }
    return { ops, eventLog: [...eventLog] };
  }
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
        // Merge variable samples deduped by shape signature, up to MAX_SAMPLES_PER_OP
        existing.variablesSamples = existing.variablesSamples || [];
        existing._sigs = existing._sigs || new Set(existing.variablesSamples.map(shapeSignature));
        for (const sample of (entry.variablesSamples || [])) {
          if (existing.variablesSamples.length >= MAX_SAMPLES_PER_OP) break;
          const clean = sanitizeVariables(opName, sample);
          const sig = shapeSignature(clean);
          if (!existing._sigs.has(sig)) {
            existing._sigs.add(sig);
            existing.variablesSamples.push(clean);
          }
        }
        // Keep responseSchema if we didn't have one
        if (!existing.responseSchema && entry.responseSchema) {
          existing.responseSchema = entry.responseSchema;
          existing.responseFields = entry.responseFields || [];
        }
        // Merge response samples up to cap (no dedup — raw data variety is useful)
        existing.responseSamples = existing.responseSamples || [];
        for (const rs of (entry.responseSamples || [])) {
          if (existing.responseSamples.length >= MAX_RESPONSE_SAMPLES_PER_OP) break;
          existing.responseSamples.push(rs);
        }
        // Merge error samples (cap 3) + accumulate errorCount + keep latest httpStatus
        existing.errorSamples = existing.errorSamples || [];
        existing.errorCount = (existing.errorCount || 0) + (entry.errorCount || 0);
        if (entry.lastHttpStatus) existing.lastHttpStatus = entry.lastHttpStatus;
        for (const es of (entry.errorSamples || [])) {
          if (existing.errorSamples.length >= 3) break;
          existing.errorSamples.push(es);
        }
        // Merge screens (pantalla+breadcrumb por op) — dedup por pathname, cap MAX_SCREENS_PER_OP
        existing.screens = existing.screens || [];
        for (const s of (entry.screens || [])) {
          const hit = existing.screens.find((x) => x.pathname === s.pathname);
          if (hit) { hit.count += (s.count || 1); continue; }
          if (existing.screens.length >= MAX_SCREENS_PER_OP) break;
          existing.screens.push(s);
        }
      }
    }
  }

  return {
    init, start, stop, getResults, getStats, isActive, exportConfig, clear, mergeResults,
    analyzeSchema, mergeSchema,
    _internal: { sanitizeValue, sanitizeVariables, analyzeSchema, mergeSchema, extractFieldPaths, shapeSignature, recordOperation, describeClickTarget, recordScreen, slimForBackup, discovered, eventLog, knownHashMap, knownOpMap }
  };
})();

if (typeof window !== 'undefined') window.HashScanner = HashScanner;
if (typeof module !== 'undefined') module.exports = HashScanner;
