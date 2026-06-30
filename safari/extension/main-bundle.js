// ==========================================================================
// Steelhead Automator — iPad — main-bundle.js  (v0.1.0)
// GENERADO por tools/build-safari.sh desde remote/scripts + config.json.
// NO editar a mano: edita la fuente en remote/scripts/ y re-corre el build.
// Cada applet va en su propio IIFE (scope aislado, como el new Function() del
// remote-loader); la comunicación entre scripts es vía window.* (SteelheadAPI, etc.).
// ==========================================================================

// ===== BEGIN sa-bootstrap.js (prelude) =====
(function(){
// sa-bootstrap.js — PRELUDE del bundle (MAIN world). build-safari.sh lo concatena PRIMERO en
// main-bundle.js. Recibe el config.json que bridge.js (mundo aislado) fetchea de gh-pages y lo instala:
//   · window.REMOTE_CONFIG  → lo leen applets como paros-linea (const cfg = () => window.REMOTE_CONFIG)
//   · SteelheadAPI.init(config) → carga los hashes para query()/getHash()
//
// El config llega de forma ASÍNCRONA (tras el fetch del bridge, ~cientos de ms). Las mutaciones de
// los applets ocurren por ACCIÓN del usuario (clicks posteriores), así que para entonces el config ya
// está. Como los hashes NO se hornean en el bundle, rotan en caliente (git push a gh-pages) sin rebuild.
(function () {
  'use strict';
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__saBridge !== true || d.type !== 'config' || !d.config) return;
    window.REMOTE_CONFIG = d.config;
    try {
      if (window.SteelheadAPI && typeof window.SteelheadAPI.init === 'function') {
        window.SteelheadAPI.init(d.config);
      }
    } catch (err) { console.error('[SA] bootstrap: SteelheadAPI.init falló', err); }
  });
})();
})();
// ===== END sa-bootstrap.js =====

// ===== BEGIN scripts/steelhead-api.js =====
(function(){
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

  function log(msg)  { const s = `[SA] ${msg}`; console.log(s); _pushLog(s); }
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
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.errors)) {
          const msgs = parsed.errors.map((e, i) => `[${i + 1}] ${e.message}`).join(' | ');
          throw new Error(`HTTP ${response.status} en ${operationName}: ${msgs.substring(0, 2000)}`);
        }
      } catch (_) { /* fall through */ }
      throw new Error(`HTTP ${response.status} en ${operationName}: ${text.substring(0, 2000)}`);
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
})();
// ===== END scripts/steelhead-api.js =====

// ===== BEGIN scripts/surtido-guard-core.js =====
(function(){
// Candado de Surtido Programado — módulo puro (sin DOM ni red).
// Lógica de decisión de bloqueo + parsers de los queries del board y de la
// mutación de mover. Consumido por surtido-guard.js (glue) y por los tests.
//
// Modelo (shapes confirmados Fase 0, ver spec 2026-06-26):
//   · programada = la pieza (partsTransferAccount) tiene una tarea en el programa.
//   · GetRelatedScheduleData → set de partsTransferAccountId programados.
//   · GetRelatedWorkboardData.allRecipeNodes → recipeNodeId del nodo "Preparando Surtido en Almacén".
//   · Variables de WorkOrderMovePartsData / MoveMultipleFromWorkboardData → puente account→{recipeNodeId,workOrderId}.
//   · Mutación CreateManyPartsTransfersChecked → fromAccountId por transfer "STEP".
//   Bloquea un STEP cuyo fromAccount está en un nodo de surtido y NO está programado. FAIL-SAFE ante falta de datos.
(function () {
  'use strict';

  // ── Constantes de dominio (operationNames + match de nodo) ──
  const SOURCE_NODE_NAME_MATCH = 'preparando surtido en almacen';
  const BOARD_SCHEDULE_OP = 'GetRelatedScheduleData';
  const BOARD_RECIPENODES_OP = 'GetRelatedWorkboardData';
  const MOVE_DATA_OPS = ['WorkOrderMovePartsData', 'MoveMultipleFromWorkboardData'];
  const MOVE_MUTATION_OP = 'CreateManyPartsTransfersChecked';

  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }

  function asNodes(x) {
    if (x && Array.isArray(x.nodes)) return x.nodes;
    return Array.isArray(x) ? x : [];
  }
  function asArray(x) { return Array.isArray(x) ? x : []; }

  // GetRelatedScheduleData.data → Set<partsTransferAccountId> programados.
  function buildScheduledAccountSet(scheduleData) {
    const set = new Set();
    for (const s of asNodes(scheduleData && scheduleData.allSchedules)) {
      for (const t of asNodes(s.validScheduleTasks)) {
        for (const el of asNodes(t.scheduleTaskElementsByScheduleTaskId)) {
          for (const a of asNodes(el.associatedPartsTransferAccounts)) {
            if (a && a.id != null) set.add(a.id);
          }
        }
      }
    }
    return set;
  }

  // GetRelatedWorkboardData.data → Set<recipeNodeId> del nodo "Preparando Surtido en Almacén".
  function buildSurtidoNodeSet(workboardData) {
    const set = new Set();
    for (const n of asNodes(workboardData && workboardData.allRecipeNodes)) {
      if (n && normalize(n.name).includes(SOURCE_NODE_NAME_MATCH)) set.add(n.id);
    }
    return set;
  }

  // Variables de un query de move → mapa accountId → { recipeNodeId, workOrderId }.
  // Acepta WorkOrderMovePartsData (escalares + array de accounts del mismo nodo/WO)
  // y MoveMultipleFromWorkboardData (arrays pareados por índice). Acumula sobre `into`.
  function indexAccountNodeFromMoveVars(op, vars, into) {
    const map = into || {};
    if (!vars) return map;
    if (op === 'WorkOrderMovePartsData') {
      for (const a of asArray(vars.partsTransferAccountIds)) {
        map[a] = { recipeNodeId: vars.fromRecipeNodeId, workOrderId: vars.workOrderId };
      }
    } else if (op === 'MoveMultipleFromWorkboardData') {
      const accs = asArray(vars.partsTransferAccountIds);
      const nodesArr = asArray(vars.fromRecipeNodeIds);
      const wos = asArray(vars.workOrderIds);
      for (let i = 0; i < accs.length; i++) {
        map[accs[i]] = { recipeNodeId: nodesArr[i], workOrderId: wos[i] };
      }
    }
    return map;
  }

  // Variables de CreateManyPartsTransfersChecked → lista de transfers tipo STEP.
  function extractStepTransfers(mutationVars) {
    const out = [];
    const payload = mutationVars && mutationVars.partsTransferEventsPayload;
    for (const ev of asArray(payload && payload.partsTransferEvents)) {
      for (const tr of asArray(ev && ev.partsTransfers)) {
        if (tr && tr.type === 'STEP') out.push(tr);
      }
    }
    return out;
  }

  // Decisión unitaria para un account (Task 1). FAIL-SAFE si !found.
  //   record = { found:boolean, programada:boolean, woId }
  function shouldBlockMove(record, opts) {
    if (!opts || opts.enforcementEnabled !== true) return { block: false, reason: 'disabled' };
    if (!record || record.found !== true) return { block: false, reason: 'unknown-failsafe' };
    if (record.programada === true) return { block: false, reason: 'scheduled' };
    return { block: true, reason: 'not-scheduled' };
  }

  // Decisión para la mutación completa.
  //   ctx  = { scheduledAccountIds:Set, accountNode:{[id]:{recipeNodeId,workOrderId}}, surtidoNodeIds:Set }
  //   opts = { enforcementEnabled }
  // Bloquea si algún transfer STEP sale de un nodo de surtido con account NO programado.
  // FAIL-SAFE: account sin puente o fuera de scope → no se evalúa (no bloquea).
  function evaluateMove(mutationVars, ctx, opts) {
    if (!opts || opts.enforcementEnabled !== true) return { block: false, reason: 'disabled', blocked: [] };
    const scheduled = (ctx && ctx.scheduledAccountIds) || new Set();
    const accountNode = (ctx && ctx.accountNode) || {};
    const surtidoNodes = (ctx && ctx.surtidoNodeIds) || new Set();
    const blocked = [];
    let sawSurtido = false;
    for (const tr of extractStepTransfers(mutationVars)) {
      const info = accountNode[tr.fromAccountId];
      if (!info) continue;                              // sin puente → fail-safe
      if (!surtidoNodes.has(info.recipeNodeId)) continue; // fuera de scope (no es surtido)
      sawSurtido = true;
      const decision = shouldBlockMove(
        { found: true, programada: scheduled.has(tr.fromAccountId), woId: info.workOrderId },
        opts
      );
      if (decision.block) blocked.push({ accountId: tr.fromAccountId, workOrderId: info.workOrderId });
    }
    if (blocked.length > 0) return { block: true, reason: 'not-scheduled', blocked };
    if (sawSurtido) return { block: false, reason: 'scheduled', blocked: [] };
    return { block: false, reason: 'out-of-scope-or-unknown', blocked: [] };
  }

  const api = {
    SOURCE_NODE_NAME_MATCH, BOARD_SCHEDULE_OP, BOARD_RECIPENODES_OP, MOVE_DATA_OPS, MOVE_MUTATION_OP,
    normalize,
    buildScheduledAccountSet, buildSurtidoNodeSet, indexAccountNodeFromMoveVars,
    extractStepTransfers, shouldBlockMove, evaluateMove
  };
  if (typeof window !== 'undefined') window.SurtidoGuardCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
})();
// ===== END scripts/surtido-guard-core.js =====

// ===== BEGIN scripts/surtido-guard.js =====
(function(){
// Candado de Surtido Programado — bloquea mover piezas no programadas en el
// step "Preparando Surtido en Almacén" del Workboard "Preparación de Surtido".
// Glue DOM/red; la lógica de decisión y parseo vive en SurtidoGuardCore.
//
// Capas:
//   1. Mapa "programada" + nodos de surtido + puente account→nodo (lee fetch)   — Task 4
//   2. Enforcement: bloquea CreateManyPartsTransfersChecked (modal y drag)        — Task 5
//   3. Capa de modal: agrisa "Mover" / "Imprimir y Mover"                         — Task 6
//   4. Marcado verde de tarjetas programadas (señal DOM "Tareas Programadas:")    — Task 7
//   5. Toggle no persistente desde el popup (default ON cada carga)               — Task 3
//   6. Memory hardening: observer debounced + teardown al salir del board         — Task 8
const SurtidoGuard = (() => {
  'use strict';

  const Core = () => window.SurtidoGuardCore;
  const WB_PATH_RE = /^\/Domains\/\d+\/Workboards\/\d+/;

  // Estado del candado: vive en `window` (singleton), NO en el closure. background.js
  // → injectAppScripts RE-EVALÚA este IIFE en cada acción del popup (surtido-guard.js
  // no está en el mapa `globals` de dedup), creando una instancia nueva. Si el flag
  // viviera en el closure, el toggle mutaría la instancia nueva mientras el interceptor
  // de fetch —latcheado a la instancia ORIGINAL vía __saSurtidoGuardFetchPatched—
  // seguiría leyendo el flag viejo → "Desactivado" sin efecto real. El singleton lo
  // comparten todas las instancias. Default ON solo en la PRIMERA carga (si está sin
  // definir): así una re-inyección no repisa lo que el operador apagó, y un reload
  // limpia window → vuelve a ON (no persistente, por diseño).
  if (window.__saSurtidoGuardEnabled === undefined) window.__saSurtidoGuardEnabled = true;
  function isEnforcementEnabled() { return window.__saSurtidoGuardEnabled === true; }
  function setEnforcementEnabled(v) { window.__saSurtidoGuardEnabled = !!v; }

  let scheduledAccountIds = new Set();  // partsTransferAccountId programados (GetRelatedScheduleData)
  let surtidoNodeIds = new Set();       // recipeNodeId del nodo de surtido (GetRelatedWorkboardData)
  let accountNode = {};                 // accountId -> {recipeNodeId, workOrderId} (vars de move-data)
  let lastModalCtx = null;              // últimas vars de WorkOrderMovePartsData (para la capa de modal)

  function isWorkboardPage() { return WB_PATH_RE.test(location.pathname); }
  function isEnabled() { return isEnforcementEnabled(); }
  function ctx() { return { scheduledAccountIds, accountNode, surtidoNodeIds }; }

  // Entrada desde el popup (background llama window.SurtidoGuard.toggleFromPopup).
  function toggleFromPopup() {
    setEnforcementEnabled(!isEnforcementEnabled());
    const on = isEnforcementEnabled();
    toast(on
      ? '🔒 Candado de Surtido: ACTIVADO'
      : '🔓 Candado de Surtido: DESACTIVADO (hasta recargar)');
    scheduleDecorate();
    return { enabled: on };
  }

  // ── Estilos (toast + acento verde + mensaje de modal) ──
  function injectStyles() {
    if (document.getElementById('sa-sg-style')) return;
    const css = [
      '.sa-sg-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);',
      'z-index:2147483600;background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;',
      'border-left:4px solid #13a36f;border-radius:10px;padding:12px 18px;font-size:14px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}',
      '.sa-sg-toast.err{border-left-color:#e8513a;}',
      '.sa-sg-green{box-shadow:inset 5px 0 0 0 #13a36f !important;}',
      '.sa-sg-msg{background:#3a1d1d;color:#f3c2c2;border:1px solid #6b2b2b;border-radius:8px;',
      'padding:10px 12px;margin:10px 0;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}'
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-sg-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    injectStyles();
    let el = document.getElementById('sa-sg-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-sg-toast'; document.body.appendChild(el); }
    el.className = 'sa-sg-toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { const e = document.getElementById('sa-sg-toast'); if (e) e.remove(); }, 5000);
  }

  // ── Interceptor de fetch (lee board, construye puente, bloquea la mutación) ──
  function patchFetch() {
    if (window.__saSurtidoGuardFetchPatched) return;
    window.__saSurtidoGuardFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      let op = null, vars = null;
      if (typeof url === 'string' && url.includes('/graphql') && opts && typeof opts.body === 'string') {
        try { const b = JSON.parse(opts.body); op = b.operationName; vars = b.variables; } catch (_) {}
      }

      // (a) Puente account→nodo desde las VARIABLES de los queries de move (modal/drag).
      if (op && Core().MOVE_DATA_OPS.indexOf(op) !== -1 && vars) {
        Core().indexAccountNodeFromMoveVars(op, vars, accountNode);
        if (op === 'WorkOrderMovePartsData') { lastModalCtx = vars; scheduleModalGuard(); }
      }

      // (b) Enforcement: bloquear la mutación de mover ANTES de mandarla al servidor.
      if (op === Core().MOVE_MUTATION_OP && vars) {
        const decision = Core().evaluateMove(vars, ctx(), { enforcementEnabled: isEnforcementEnabled() });
        if (decision.block) {
          const wos = decision.blocked.map((b) => '#' + b.workOrderId).join(', ');
          toast('🔒 Bloqueado: la WO ' + wos + ' no está programada. No se puede mover al siguiente proceso.', true);
          console.warn('[SA] SurtidoGuard: BLOQUEADO move de', decision.blocked);
          return new Response(
            JSON.stringify({ errors: [{ message: 'Bloqueado por extensión: la orden no está programada en producción.' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      const resp = await origFetch.apply(this, args);

      // (c) Lectura de las RESPUESTAS del board → sets de programados y de nodos de surtido.
      if (op === Core().BOARD_SCHEDULE_OP) {
        try { resp.clone().json().then((j) => {
          if (j && j.data) { scheduledAccountIds = Core().buildScheduledAccountSet(j.data);
            console.log('[SA] SurtidoGuard: programadas =', scheduledAccountIds.size, 'accounts');
            scheduleDecorate(); scheduleModalGuard(); }
        }).catch(() => {}); } catch (_) {}
      }
      if (op === Core().BOARD_RECIPENODES_OP) {
        try { resp.clone().json().then((j) => {
          if (j && j.data) { surtidoNodeIds = Core().buildSurtidoNodeSet(j.data);
            console.log('[SA] SurtidoGuard: nodos de surtido =', [...surtidoNodeIds]); }
        }).catch(() => {}); } catch (_) {}
      }

      return resp;
    };
  }

  // ── Capa de modal: agrisa "Mover" / "Imprimir y Mover" si la pieza no está programada ──
  function findMoveDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], .MuiDialog-paper');
    for (const d of dialogs) {
      const t = d.textContent || '';
      if ((/Desde Nodo:/i.test(t) || /From Node:/i.test(t)) && (/Mover Piezas/i.test(t) || /Move Parts/i.test(t))) return d;
    }
    return null;
  }

  function modalShouldBlock() {
    if (!isEnforcementEnabled() || !lastModalCtx) return false;
    const accs = lastModalCtx.partsTransferAccountIds || [];
    const inSurtido = surtidoNodeIds.has(lastModalCtx.fromRecipeNodeId);
    return inSurtido && accs.some((a) => !scheduledAccountIds.has(a));
  }

  function setBtnBlocked(btn, blocked) {
    if (blocked) {
      btn.setAttribute('disabled', 'true');
      btn.style.opacity = '0.45';
      btn.style.filter = 'grayscale(1)';
      btn.style.pointerEvents = 'none';
      btn.dataset.saBlocked = '1';
    } else if (btn.dataset.saBlocked) {
      btn.removeAttribute('disabled');
      btn.style.opacity = '';
      btn.style.filter = '';
      btn.style.pointerEvents = '';
      delete btn.dataset.saBlocked;
    }
  }

  function applyModalGuard() {
    const dialog = findMoveDialog();
    if (!dialog) return;
    const blocked = modalShouldBlock();
    dialog.querySelectorAll('button').forEach((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t.indexOf('mover') === 0 || t.indexOf('imprimir y mover') === 0 ||
          t.indexOf('move') === 0 || t.indexOf('print and') === 0) {
        setBtnBlocked(b, blocked);
      }
    });
    let msg = dialog.querySelector('#sa-sg-modal-msg');
    if (blocked && !msg) {
      msg = document.createElement('div');
      msg.id = 'sa-sg-modal-msg';
      msg.className = 'sa-sg-msg';
      msg.textContent = '🔒 No se puede mover: la orden no está programada en producción.';
      const body = dialog.querySelector('.MuiDialogContent-root') || dialog;
      body.insertBefore(msg, body.firstChild);
    } else if (!blocked && msg) {
      msg.remove();
    }
  }

  // ── Marcado verde (heurístico): tarjeta con "Tareas Programadas:" → acento verde ──
  // NOTA: se refina con el HTML real de la tarjeta (selector de contenedor) en validación en vivo.
  function decorateCards() {
    if (!isWorkboardPage()) return;
    const re = /Tareas Programadas:?/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => re.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    let node;
    while ((node = walker.nextNode())) {
      // Sube hasta el contenedor de tarjeta (ancestro que también tenga "Proceso:" o "WO:").
      let card = node.parentElement;
      for (let i = 0; i < 8 && card; i++) {
        const t = card.textContent || '';
        if (/Proceso:/i.test(t) && /WO:/i.test(t)) break;
        card = card.parentElement;
      }
      if (card) card.classList.add('sa-sg-green');
    }
  }

  // ── Scheduling de trabajo del DOM (debounced, idle) ──
  let decoTimer = null, guardTimer = null;
  function scheduleDecorate() {
    if (decoTimer) return;
    decoTimer = setTimeout(() => { decoTimer = null; try { decorateCards(); } catch (_) {} }, 200);
  }
  function scheduleModalGuard() {
    if (guardTimer) return;
    guardTimer = setTimeout(() => { guardTimer = null; try { applyModalGuard(); } catch (_) {} }, 80);
  }

  function observeDom() {
    if (window.__saSurtidoGuardObs) return;
    const obs = new MutationObserver(() => { scheduleModalGuard(); scheduleDecorate(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saSurtidoGuardObs = obs;
  }

  // ── Memory hardening: teardown al salir del board ──
  function installUrlChangeListener() {
    if (!window.__saSurtidoGuardUrlListener) {
      window.__saSurtidoGuardUrlListener = true;
      const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
      ['pushState', 'replaceState'].forEach((m) => {
        const orig = history[m];
        history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
      });
      window.addEventListener('popstate', fire);
    }
    window.addEventListener('sa-urlchange', () => {
      if (isWorkboardPage()) { observeDom(); }
      else { teardownOnLeave(); }
    });
  }

  function teardownOnLeave() {
    if (window.__saSurtidoGuardObs) { window.__saSurtidoGuardObs.disconnect(); window.__saSurtidoGuardObs = null; }
    scheduledAccountIds = new Set();
    surtidoNodeIds = new Set();
    accountNode = {};
    lastModalCtx = null;
    const t = document.getElementById('sa-sg-toast'); if (t) t.remove();
  }

  function init() {
    if (window.__saSurtidoGuardInit) return;
    window.__saSurtidoGuardInit = true;
    patchFetch();                  // siempre (latch idempotente); solo actúa sobre ops objetivo
    installUrlChangeListener();
    if (!isWorkboardPage()) return;
    injectStyles();
    observeDom();
    console.log('[SA] SurtidoGuard activo en', location.pathname);
  }

  return {
    init, isEnabled, toggleFromPopup,
    _getState: () => ({ enforcementEnabled: isEnforcementEnabled(), scheduled: [...scheduledAccountIds], surtido: [...surtidoNodeIds], accounts: Object.keys(accountNode).length })
  };
})();

if (typeof window !== 'undefined') {
  window.SurtidoGuard = SurtidoGuard;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SurtidoGuard.init());
  } else {
    SurtidoGuard.init();
  }
}
})();
// ===== END scripts/surtido-guard.js =====

// ===== BEGIN scripts/paros-linea.js =====
(function(){
// Steelhead Paros de Línea
// Skin operador sobre MaintenanceEvent con botón flotante Andon.
// Flujo: CreateMaintenanceEvent (inicio) → UpdateMaintenanceEvent/Comment (durante)
//        → CreateMaintenanceNodeEvent + CreateManySensorMeasurements + UpdateMaintenanceEvent{completedAt} (al detener)
//        → /api/files + CreateUserFile + CreateMaintenanceEventUserFile (evidencia)
// Depende de: SteelheadAPI + window.REMOTE_CONFIG

const ParosLinea = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const cfg = () => window.REMOTE_CONFIG;

  const STATE_KEY = 'sa_paros_active_event';
  const LAST_LINE_KEY = 'sa_paros_last_line';
  const EQUIP_CACHE_KEY = 'sa_paros_line_equipments_v1';
  const EQUIP_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

  const RESPONSABLE_AREAS = {
    PLM: { label: 'Mantenimiento',          icon: '🔧' },
    PLP: { label: 'Producción',             icon: '🏭' },
    PLO: { label: 'Operaciones',            icon: '⚙️' },
    PLR: { label: 'Recursos Humanos',       icon: '👥' },
    PLC: { label: 'Calidad',                icon: '✅' },
    PLS: { label: 'Seguridad',              icon: '🛡️' },
    PLA: { label: 'Almacén',                icon: '📦' },
    PLI: { label: 'Ingeniería',             icon: '🛠️' },
    PLL: { label: 'Laboratorio y Procesos', icon: '🧪' },
    PLN: { label: 'Planeación',             icon: '📅' },
    PLT: { label: 'TI (Sistemas)',          icon: '💻' }
  };
  const DEFAULT_AREA_ICON = '📌';

  function normalizeEs(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }

  const LINE_LABEL_RE = /^(?:l[ií]neas?|c[eé]lulas?)$/i;
  const ALLOWED_PATH_RE = /^\/Domains\/\d+\/(Workboards|WorkOrders)(?:\/|$)/;

  let state = {
    currentUser: null,
    allNodes: [],
    responsableOptions: [],
    allEquipments: [],
    selectedSensorId: null,
    activeEvent: null,
    timerInterval: null,
    fabTimerInterval: null,
    floatingBtn: null,
    catalogsLoaded: false
  };

  async function init() {
    if (window.__saParosLineaInitDone) return;
    window.__saParosLineaInitDone = true;

    try {
      state.currentUser = await fetchCurrentUser();
    } catch (e) {
      console.warn('[SA] ParosLinea: no se pudo obtener usuario actual:', e.message);
      return;
    }
    if (!state.currentUser) return;
    if (!isAuthorized(state.currentUser)) {
      console.log('[SA] ParosLinea: usuario sin rol operador/admin — botón omitido');
      return;
    }

    injectStyles();

    const saved = readActiveEvent();
    if (saved) {
      state.activeEvent = saved;
      state.selectedSensorId = saved.selectedSensorId || null;
    }

    installUrlChangeListener();
    syncFabVisibility();

    if (saved) {
      loadCatalogs().catch(e => console.warn('[SA] ParosLinea catálogos:', e.message));
      renderRunningView().catch(e => console.warn('[SA] ParosLinea reanudar:', e.message));
    }
  }

  function isAllowedPath() {
    return ALLOWED_PATH_RE.test(location.pathname);
  }

  function syncFabVisibility() {
    const should = isAllowedPath() || !!state.activeEvent;
    const existing = document.getElementById('sa-pl-fab-dock');
    if (should && !existing) renderFloatingButton();
    else if (!should && existing) {
      existing.remove();
      stopFabTimer();
      state.floatingBtn = null;
    }
  }

  function installUrlChangeListener() {
    if (window.__saParosUrlListenerInstalled) {
      window.addEventListener('sa-urlchange', syncFabVisibility);
      return;
    }
    window.__saParosUrlListenerInstalled = true;
    const fire = () => window.dispatchEvent(new Event('sa-urlchange'));
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('sa-urlchange', syncFabVisibility);
  }

  async function fetchCurrentUser() {
    // CurrentUser fue deprecada server-side 2026-04-27 (HTTP 400 "Must provide a query string.").
    // CurrentUserDetails sigue activa pero solo trae id/isAdmin (sin currentManagedPermissions).
    // isAuthorized cae al branch "no hay info de permisos finos → permitido", así que el
    // gating queda solo por isAdmin (y por requiredPermissions del config si están presentes).
    const data = await api().query('CurrentUserDetails', {}, 'CurrentUserDetails');
    const u = data?.currentSession?.userByUserId;
    if (!u) return null;
    return {
      id: u.id,
      name: u.name || null,
      isAdmin: u.isAdmin === true,
      managedPermissions: undefined
    };
  }

  function isAuthorized(user) {
    if (user.isAdmin) return true;
    const req = cfg()?.apps?.find(a => a.id === 'paros-linea')?.requiredPermissions || [];
    if (req.length === 0) return true;
    if (!Array.isArray(user.managedPermissions)) return true;
    return req.every(p => user.managedPermissions.includes(p));
  }

  function readActiveEvent() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch { return null; }
  }
  function writeActiveEvent(ev) {
    try {
      if (!ev) localStorage.removeItem(STATE_KEY);
      else localStorage.setItem(STATE_KEY, JSON.stringify(ev));
    } catch (_) {}
  }

  function pushComment(ev, { text, author, auto = false, at }) {
    if (!ev) return;
    if (!Array.isArray(ev.comments)) ev.comments = [];
    ev.comments.push({
      at: at || Date.now(),
      text: String(text || '').trim(),
      author: author || (state.currentUser?.name || 'Operador'),
      auto: !!auto
    });
    writeActiveEvent(ev);
    renderCommentsList();
  }

  function renderCommentsList() {
    const host = document.getElementById('pl-comments-list');
    if (!host) return;
    const comments = (state.activeEvent?.comments || []).slice().reverse();
    if (!comments.length) {
      host.innerHTML = '<div class="pl-comments-empty">Aún no hay comentarios en este paro.</div>';
      return;
    }
    host.innerHTML = comments.map(c => {
      const t = new Date(c.at);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const meta = escapeHtml(c.author || 'Operador') + ' · ' + hh + ':' + mm + ':' + ss +
        (c.auto ? ' · automático' : '');
      return '<div class="pl-comment' + (c.auto ? ' auto' : '') + '">' +
        '<div class="pl-comment-meta">' + meta + '</div>' +
        '<div class="pl-comment-text">' + escapeHtml(c.text) + '</div>' +
      '</div>';
    }).join('');
  }

  function injectStyles() {
    if (document.getElementById('dl9-paros-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl9-paros-styles';
    s.textContent = [
      '.pl-fab-dock{position:fixed;bottom:24px;left:24px;z-index:99998;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none}',
      '.pl-fab-dock > *{pointer-events:auto}',
      '.pl-fab-ring{display:flex;align-items:center;justify-content:center;border-radius:50%;padding:10px;box-shadow:0 8px 24px rgba(220,38,38,0.55)}',
      '.pl-fab-dock.running .pl-fab-ring{background:repeating-linear-gradient(45deg,#dc2626 0 14px,#facc15 14px 28px);animation:plStripeScroll 1.4s linear infinite}',
      '.pl-fab{width:76px;height:76px;border-radius:50%;background:#dc2626;color:#fff;border:none;font-size:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease;box-shadow:0 2px 8px rgba(0,0,0,0.3) inset, 0 0 0 3px #0f172a}',
      '.pl-fab:not(.running):hover{transform:scale(1.08)}',
      '.pl-fab.running{animation:plIconPulse 0.95s ease-in-out infinite}',
      '@keyframes plIconPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}',
      '.pl-fab-timer-wrap{padding:5px;border-radius:12px;background:repeating-linear-gradient(45deg,#dc2626 0 10px,#facc15 10px 20px);animation:plStripeScroll 1.4s linear infinite;box-shadow:0 6px 18px rgba(0,0,0,0.55)}',
      '.pl-fab-timer{font-family:"SF Mono","Menlo","Consolas",monospace;font-variant-numeric:tabular-nums;font-size:22px;font-weight:800;color:#fef3c7;background:#0f172a;border-radius:8px;padding:8px 16px;letter-spacing:1.5px;white-space:nowrap;text-align:center;line-height:1}',
      '@media (prefers-reduced-motion:reduce){.pl-fab.running,.pl-fab-dock.running .pl-fab-ring,.pl-fab-timer-wrap{animation:none}}',
      '.pl-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.pl-modal{background:#1e293b;color:#f1f5f9;border-radius:18px;padding:32px 36px;width:620px;max-width:94vw;max-height:94vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);box-sizing:border-box}',
      '.pl-modal.running{width:840px;text-align:center}',
      '.pl-modal h2{margin:0 0 18px;font-size:26px;color:#fecaca}',
      '.pl-row{margin-bottom:16px}',
      '.pl-label{font-size:12px;color:#94a3b8;display:block;margin-bottom:6px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}',
      '.pl-select,.pl-input,.pl-textarea{width:100%;padding:12px 14px;border-radius:9px;border:1px solid #475569;background:#0f172a;color:#f1f5f9;font-size:16px;box-sizing:border-box}',
      '.pl-select:disabled{opacity:.6}',
      '.pl-textarea{min-height:68px;resize:vertical;font-family:inherit}',
      '.pl-btnrow{display:flex;gap:12px;justify-content:flex-end;margin-top:24px;flex-wrap:wrap}',
      '.pl-btn{padding:14px 26px;border:none;border-radius:9px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:.3px}',
      '.pl-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.pl-btn-cancel{background:#475569;color:#f1f5f9}',
      '.pl-btn-primary{background:#dc2626;color:#fff}',
      '.pl-btn-ghost{background:transparent;color:#cbd5e1;border:1px solid #475569}',
      '.pl-btn-stop{background:#dc2626;color:#fff;font-size:24px;padding:22px 0;width:100%;margin-top:20px}',
      '.pl-btn-stop:hover{background:#b91c1c}',
      '.pl-cone{font-size:112px;line-height:1;margin-bottom:6px}',
      '.pl-title{font-size:32px;font-weight:800;color:#fecaca;letter-spacing:1.5px;margin:8px 0}',
      '.pl-timer{font-size:88px;font-family:"SF Mono","Menlo","Consolas",monospace;font-variant-numeric:tabular-nums;color:#fef3c7;margin:10px 0 22px}',
      '.pl-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;text-align:left;margin-top:14px}',
      '.pl-static{background:#0f172a;border:1px solid #334155;border-radius:9px;padding:12px 14px;font-size:16px}',
      '.pl-static strong{display:block;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px;font-weight:700}',
      '.pl-comment-row{display:flex;gap:10px;margin-top:16px;align-items:flex-start}',
      '.pl-comment-row .pl-textarea{flex:1;min-height:56px}',
      '.pl-comments{margin-top:14px;text-align:left;background:#0f172a;border:1px solid #334155;border-radius:10px;padding:10px 12px;max-height:220px;overflow-y:auto}',
      '.pl-comments-title{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:8px}',
      '.pl-comments-empty{font-size:13px;color:#64748b;font-style:italic;padding:4px 0}',
      '.pl-comment{padding:8px 10px;background:#1e293b;border-left:3px solid #60a5fa;border-radius:6px;margin-bottom:6px;font-size:14px;line-height:1.35}',
      '.pl-comment.auto{border-left-color:#a78bfa;opacity:.9}',
      '.pl-comment .pl-comment-meta{font-size:11px;color:#94a3b8;margin-bottom:3px}',
      '.pl-comment .pl-comment-text{color:#f1f5f9;white-space:pre-wrap;word-break:break-word}',
      '.pl-summary{text-align:center;background:#0f172a;border-radius:14px;padding:26px;margin:10px 0}',
      '.pl-summary .pl-big{font-size:50px;font-family:"SF Mono","Menlo","Consolas",monospace;color:#86efac;margin:8px 0}',
      '.pl-dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;text-align:left;margin-top:14px;font-size:15px}',
      '.pl-dl dt{color:#94a3b8}',
      '.pl-dl dd{margin:0;color:#f1f5f9}',
      '.pl-error{color:#fecaca;background:#7f1d1d;padding:12px 14px;border-radius:9px;margin-bottom:14px;font-size:15px}',
      '.pl-loading{text-align:center;padding:22px;color:#94a3b8;font-size:15px}',
      '.pl-striped-frame{padding:26px;border-radius:28px;background:repeating-linear-gradient(45deg,#dc2626 0 22px,#facc15 22px 44px);background-size:200% 200%;box-shadow:0 25px 70px rgba(0,0,0,0.7);max-width:96vw;max-height:96vh;box-sizing:border-box;display:flex;animation:plStripeScroll 1.4s linear infinite}',
      '.pl-striped-frame > .pl-modal.running{box-shadow:none;max-width:100%;max-height:calc(96vh - 52px)}',
      '@keyframes plStripeScroll{0%{background-position:0 0}100%{background-position:62.23px 0}}',
      '@media (prefers-reduced-motion:reduce){.pl-striped-frame{animation:none}}'
    ].join('');
    document.head.appendChild(s);
  }

  function renderFloatingButton() {
    const existing = document.getElementById('sa-pl-fab-dock');
    if (existing) existing.remove();
    stopFabTimer();

    const running = !!state.activeEvent;
    const dock = document.createElement('div');
    dock.className = 'pl-fab-dock' + (running ? ' running' : '');
    dock.id = 'sa-pl-fab-dock';

    const ring = document.createElement('div');
    ring.className = 'pl-fab-ring';

    const btn = document.createElement('button');
    btn.className = 'pl-fab' + (running ? ' running' : '');
    btn.id = 'sa-pl-fab';
    btn.setAttribute('aria-label', 'Paro de Línea');
    btn.title = running ? 'Paro de Línea en curso — click para ver' : 'Registrar Paro de Línea';
    btn.textContent = '⚠️';
    btn.addEventListener('click', () => {
      if (state.activeEvent) renderRunningView();
      else openStopDialog();
    });
    ring.appendChild(btn);
    dock.appendChild(ring);

    if (running) {
      const wrap = document.createElement('div');
      wrap.className = 'pl-fab-timer-wrap';
      const chip = document.createElement('div');
      chip.className = 'pl-fab-timer';
      chip.id = 'sa-pl-fab-timer';
      chip.textContent = formatElapsed(Date.now() - state.activeEvent.createdAt);
      wrap.appendChild(chip);
      dock.appendChild(wrap);
    }

    document.body.appendChild(dock);
    state.floatingBtn = btn;

    if (running) startFabTimer();
  }

  function updateFabStyle() {
    const should = isAllowedPath() || !!state.activeEvent;
    const existing = document.getElementById('sa-pl-fab-dock');
    if (existing) existing.remove();
    stopFabTimer();
    state.floatingBtn = null;
    if (should) renderFloatingButton();
  }

  function startFabTimer() {
    stopFabTimer();
    const tick = () => {
      const chip = document.getElementById('sa-pl-fab-timer');
      if (!chip || !state.activeEvent) { stopFabTimer(); return; }
      chip.textContent = formatElapsed(Date.now() - state.activeEvent.createdAt);
    };
    tick();
    state.fabTimerInterval = setInterval(tick, 1000);
  }

  function stopFabTimer() {
    if (state.fabTimerInterval) {
      clearInterval(state.fabTimerInterval);
      state.fabTimerInterval = null;
    }
  }

  function removeOverlay() {
    const ov = document.getElementById('sa-pl-overlay');
    if (ov) ov.remove();
    if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  }

  function showOverlay(innerHTML, { wide } = {}) {
    removeOverlay();
    const ov = document.createElement('div');
    ov.className = 'pl-overlay';
    ov.id = 'sa-pl-overlay';
    const modal = document.createElement('div');
    modal.className = 'pl-modal' + (wide ? ' running' : '');
    modal.innerHTML = innerHTML;
    if (wide) {
      const frame = document.createElement('div');
      frame.className = 'pl-striped-frame';
      frame.appendChild(modal);
      ov.appendChild(frame);
    } else {
      ov.appendChild(modal);
    }
    document.body.appendChild(ov);
    return ov;
  }

  function areaForNode(node) {
    const m = (node?.name || '').match(/\bPL([A-Z])\b/);
    const code = m ? 'PL' + m[1] : '';
    return RESPONSABLE_AREAS[code] || { label: code || 'Otros', icon: DEFAULT_AREA_ICON };
  }

  function buildResponsableOptions(paroNodes) {
    const items = paroNodes.map(n => {
      const area = areaForNode(n);
      const suffix = (n.name || '')
        .replace(/paro\s+de\s+l[ií]nea\s*/gi, '')
        .replace(/PL[A-Z]\s*[\-:]?\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const sameAsArea = suffix && normalizeEs(suffix) === normalizeEs(area.label);
      const label = (suffix && !sameAsArea) ? area.label + ' — ' + suffix : area.label;
      return { id: n.id, name: n.name, area, display: area.icon + ' ' + label, sortKey: area.label + ' ' + suffix };
    });
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'es'));
    return items;
  }

  function extractLabelMeta(rawLabel) {
    if (!rawLabel || typeof rawLabel !== 'object') return { ids: [], names: [] };
    const ids = [];
    const names = [];
    const candidates = [rawLabel, rawLabel.labelByLabelId, rawLabel.label];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      if (typeof c.id === 'number' || typeof c.id === 'string') ids.push(c.id);
      if (typeof c.name === 'string') names.push(c.name);
    }
    if (rawLabel.labelId != null) ids.push(rawLabel.labelId);
    if (typeof rawLabel.labelName === 'string') names.push(rawLabel.labelName);
    return { ids, names };
  }

  async function fetchLineLabelIds() {
    const conditions = [{ forEquipment: true }, {}];
    for (const condition of conditions) {
      try {
        const data = await api().query('AllLabels', { condition }, 'AllLabels');
        const nodes = data?.allLabels?.nodes || [];
        const matched = nodes.filter(l =>
          typeof l?.name === 'string' && LINE_LABEL_RE.test(l.name.trim())
        );
        const ids = matched.map(l => l.id).filter(id => id != null);
        if (nodes.length > 0) {
          if (matched.length === 0) {
            console.warn('[SA] ParosLinea: AllLabels devolvió ' + nodes.length +
              ' etiquetas pero ninguna coincide con Líneas/Células — ejemplos:',
              nodes.slice(0, 12).map(l => l?.name).join(' | '));
          } else {
            console.log('[SA] ParosLinea: etiquetas objetivo encontradas:',
              matched.map(l => l.name + '(' + l.id + ')').join(', '));
          }
          return new Set(ids);
        }
      } catch (e) {
        console.warn('[SA] ParosLinea AllLabels (' + JSON.stringify(condition) + '):', e.message);
      }
    }
    return new Set();
  }

  function readCachedLineEquipments() {
    try {
      const raw = localStorage.getItem(EQUIP_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.equipments)) return null;
      if (Date.now() - (obj.savedAt || 0) > EQUIP_CACHE_TTL_MS) return null;
      return obj.equipments;
    } catch { return null; }
  }
  function writeCachedLineEquipments(equipments) {
    try {
      localStorage.setItem(EQUIP_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(), equipments
      }));
    } catch (_) {}
  }
  function clearCachedLineEquipments() {
    try { localStorage.removeItem(EQUIP_CACHE_KEY); } catch (_) {}
  }

  async function fetchAllLineEquipments(targetLabelIds, onProgress) {
    const PAGE = 500;
    const matchByLine = (e) => {
      const labels = e?.equipmentLabelsByEquipmentId?.nodes || [];
      for (const l of labels) {
        const meta = extractLabelMeta(l);
        if (targetLabelIds.size && meta.ids.some(id => targetLabelIds.has(id))) return true;
        if (meta.names.some(n => LINE_LABEL_RE.test(String(n).trim()))) return true;
      }
      return false;
    };

    const matched = [];
    let offset = 0;
    let total = null;
    let scanned = 0;
    let safety = 0;
    while (safety++ < 20) {
      const data = await api().query('AllEquipments', {
        fetchEquipmentType: false,
        fetchStation: false,
        fetchLabel: true,
        fetchLocation: false,
        endOfService: true,
        orderBy: ['NAME_ASC'],
        offset,
        first: PAGE,
        searchQuery: ''
      }, 'AllEquipments');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) total = data?.pagedData?.totalCount ?? null;
      scanned += nodes.length;
      for (const n of nodes) {
        if (matchByLine(n)) matched.push({ id: n.id, name: n.name, idInDomain: n.idInDomain });
      }
      if (typeof onProgress === 'function') onProgress(scanned, total, matched.length);
      if (nodes.length < PAGE) break;
      if (total != null && scanned >= total) break;
      offset += PAGE;
    }
    return { matched, scanned, total };
  }

  async function loadCatalogs(force = false) {
    if (state.catalogsLoaded && !force) return;

    const dlg = await api().query('CreateMaintenanceEventDialogQuery', {},
      'CreateMaintenanceEventDialogQuery');
    const allNodes = dlg?.allMaintenanceNodes?.nodes || [];
    const paroNodes = allNodes.filter(n => /paro de l.nea/i.test(n.name || ''));
    if (paroNodes.length === 0) {
      throw new Error('No hay nodos de mantenimiento con "Paro de Línea" configurados. Contacta al administrador.');
    }
    state.allNodes = paroNodes;
    state.responsableOptions = buildResponsableOptions(paroNodes);

    if (!force) {
      const cached = readCachedLineEquipments();
      if (cached && cached.length > 0) {
        state.allEquipments = cached;
        console.log('[SA] ParosLinea: ' + cached.length + ' líneas/células desde caché');
        state.catalogsLoaded = true;
        return;
      }
    }

    const targetLabelIds = await fetchLineLabelIds();
    const onProgress = (scanned, total, found) => {
      const el = document.getElementById('pl-pre-content');
      if (el && el.classList.contains('pl-loading')) {
        el.textContent = 'Cargando catálogo de equipos… ' + scanned +
          (total ? '/' + total : '') + ' (líneas/células: ' + found + ')';
      }
    };
    const { matched, scanned, total } = await fetchAllLineEquipments(targetLabelIds, onProgress);
    console.log('[SA] ParosLinea: ' + matched.length + ' equipos con etiqueta Líneas/Células (de ' + scanned + (total ? '/' + total : '') + ')');

    if (matched.length === 0) {
      throw new Error('No se encontraron equipos con etiqueta "Línea" o "Célula". Revisa que estén etiquetados en Steelhead.');
    }
    state.allEquipments = matched;
    writeCachedLineEquipments(matched);
    state.catalogsLoaded = true;
  }

  async function inferLinePrefix() {
    const wbMatch = location.pathname.match(/\/Workboards\/(\d+)/);
    if (wbMatch) {
      try {
        const data = await api().query('WorkboardById',
          { id: parseInt(wbMatch[1], 10) }, 'WorkboardById');
        const name = data?.workboardById?.name;
        if (name) {
          try { localStorage.setItem(LAST_LINE_KEY, name); } catch (_) {}
          console.log('[SA] ParosLinea: workboard activo =', name);
          return name;
        }
      } catch (e) {
        console.warn('[SA] ParosLinea: WorkboardById falló:', e.message);
      }
    }
    const headings = document.querySelectorAll('h1, h2, h3, [class*="breadcrumb"], [class*="Breadcrumb"], [class*="page-title"], [class*="PageTitle"]');
    for (const h of headings) {
      const txt = h.textContent || '';
      const m = txt.match(/\b(T\d{2,3}[A-Z\-]*)\b/);
      if (m) return m[1];
    }
    try { return localStorage.getItem(LAST_LINE_KEY); } catch { return null; }
  }

  function matchEquipmentByPrefix(prefix) {
    if (!prefix || !state.allEquipments.length) return null;
    const p = prefix.toUpperCase();
    let match = state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(p));
    if (match) return match;
    const tokenMatch = p.match(/^(T\d{2,3})/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      match = state.allEquipments.find(e => (e.name || '').toUpperCase().startsWith(token))
        || state.allEquipments.find(e => (e.name || '').toUpperCase().includes(token));
      if (match) return match;
    }
    return state.allEquipments.find(e => (e.name || '').toUpperCase().includes(p)) || null;
  }

  function responsableLabelFromNodeName(name) {
    const area = areaForNode({ name });
    return area.icon + ' ' + area.label;
  }

  async function loadSensorsForNode(nodeId) {
    const data = await api().query('OperatorMaintenanceNodeDialogQuery',
      { nodeId, maintenanceEventId: state.activeEvent?.id || 0 },
      'OperatorMaintenanceNodeDialogQuery');
    const raw = data?.maintenanceNodeById?.maintenanceNodeSensorsByMaintenanceNodeId?.nodes || [];
    return raw
      .map(s => s.sensorBySensorId)
      .filter(Boolean)
      .map(s => ({ id: s.id, name: s.name }));
  }

  async function openStopDialog() {
    if (state.activeEvent) { renderRunningView(); return; }

    const ov = showOverlay(
      '<h2>⚠️ Registrar Paro de Línea</h2>' +
      '<div id="pl-pre-content" class="pl-loading">Cargando catálogos…</div>'
    );

    try {
      await loadCatalogs();
    } catch (e) {
      document.getElementById('pl-pre-content').innerHTML =
        '<div class="pl-error">' + escapeHtml(e.message) + '</div>' +
        '<div class="pl-btnrow"><button class="pl-btn pl-btn-cancel" id="pl-pre-cancel">CERRAR</button></div>';
      document.getElementById('pl-pre-cancel').onclick = removeOverlay;
      return;
    }

    const responsableOptionsHtml = (state.responsableOptions || [])
      .map(o => '<option value="' + o.id + '">' + escapeHtml(o.display) + '</option>')
      .join('');

    const linePrefix = await inferLinePrefix();
    const defaultEq = matchEquipmentByPrefix(linePrefix);
    const equipmentOptions = state.allEquipments
      .map(e => '<option value="' + e.id + '"' + (defaultEq && defaultEq.id === e.id ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>')
      .join('');

    document.getElementById('pl-pre-content').innerHTML =
      '<div class="pl-row">' +
        '<label class="pl-label">Responsable (categoría)</label>' +
        '<select class="pl-select" id="pl-node-select"><option value="">— Selecciona —</option>' + responsableOptionsHtml + '</select>' +
      '</div>' +
      '<div class="pl-row">' +
        '<label class="pl-label">Motivo</label>' +
        '<select class="pl-select" id="pl-sensor-select" disabled><option value="">Selecciona responsable primero…</option></select>' +
      '</div>' +
      '<div class="pl-row">' +
        '<label class="pl-label">Línea / Equipo</label>' +
        '<select class="pl-select" id="pl-eq-select"><option value="">— Selecciona equipo —</option>' + equipmentOptions + '</select>' +
      '</div>' +
      '<div class="pl-row">' +
        '<label class="pl-label">Comentario inicial (opcional)</label>' +
        '<textarea class="pl-textarea" id="pl-comment" placeholder="Ej: Falla de agitación en tanque 3"></textarea>' +
      '</div>' +
      '<div class="pl-btnrow">' +
        '<button class="pl-btn pl-btn-cancel" id="pl-cancel">CANCELAR</button>' +
        '<button class="pl-btn pl-btn-primary" id="pl-start" disabled>INICIAR PARO</button>' +
      '</div>';

    const nodeSel = document.getElementById('pl-node-select');
    const sensorSel = document.getElementById('pl-sensor-select');
    const eqSel = document.getElementById('pl-eq-select');
    const startBtn = document.getElementById('pl-start');

    const refreshStartState = () => {
      startBtn.disabled = !(nodeSel.value && sensorSel.value && eqSel.value);
    };

    nodeSel.addEventListener('change', async () => {
      sensorSel.disabled = true;
      sensorSel.innerHTML = '<option value="">Cargando motivos…</option>';
      refreshStartState();
      if (!nodeSel.value) return;
      try {
        const sensors = await loadSensorsForNode(parseInt(nodeSel.value, 10));
        if (!sensors.length) {
          sensorSel.innerHTML = '<option value="">(sin motivos configurados)</option>';
        } else {
          sensorSel.innerHTML = '<option value="">— Selecciona motivo —</option>' +
            sensors.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>').join('');
          sensorSel.disabled = false;
        }
      } catch (e) {
        sensorSel.innerHTML = '<option value="">Error: ' + escapeHtml(e.message.substring(0, 60)) + '</option>';
      }
      refreshStartState();
    });

    sensorSel.addEventListener('change', refreshStartState);
    eqSel.addEventListener('change', refreshStartState);

    document.getElementById('pl-cancel').onclick = removeOverlay;
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'Iniciando…';
      try {
        const nodeId = parseInt(nodeSel.value, 10);
        const equipmentId = parseInt(eqSel.value, 10);
        const sensorId = parseInt(sensorSel.value, 10);
        const node = state.allNodes.find(n => n.id === nodeId);
        const eq = state.allEquipments.find(e => e.id === equipmentId);
        const comment = document.getElementById('pl-comment').value.trim();

        const data = await api().query('CreateMaintenanceEvent', {
          maintenancePlanId: null,
          maintenanceNodeId: nodeId,
          equipmentId,
          assigneeId: state.currentUser.id
        }, 'CreateMaintenanceEvent');

        const ev = data?.createMaintenanceEvent?.maintenanceEvent;
        if (!ev) throw new Error('Respuesta sin maintenanceEvent');

        state.activeEvent = {
          id: ev.id,
          idInDomain: ev.idInDomain,
          nodeId,
          nodeName: node?.name || '',
          equipmentId,
          equipmentName: eq?.name || '',
          responsable: responsableLabelFromNodeName(node?.name),
          createdAt: Date.now(),
          selectedSensorId: sensorId,
          comments: []
        };
        state.selectedSensorId = sensorId;
        writeActiveEvent(state.activeEvent);

        if (comment) {
          try {
            await api().query('CreateMaintenanceEventComment',
              { comment, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
            pushComment(state.activeEvent, { text: comment });
          } catch (e) { console.warn('[SA] comentario inicial falló:', e.message); }
        }

        const prefix = (eq?.name || '').split(/[\s-]/)[0];
        if (prefix) { try { localStorage.setItem(LAST_LINE_KEY, prefix); } catch (_) {} }

        updateFabStyle();
        await renderRunningView();
      } catch (e) {
        const modal = ov.querySelector('.pl-modal');
        const err = document.createElement('div');
        err.className = 'pl-error';
        err.textContent = 'Error: ' + e.message;
        const btnrow = modal.querySelector('.pl-btnrow');
        if (btnrow) modal.insertBefore(err, btnrow);
        else modal.appendChild(err);
        startBtn.disabled = false;
        startBtn.textContent = 'INICIAR PARO';
      }
    };
  }

  async function renderRunningView() {
    const ev = state.activeEvent;
    if (!ev) return;

    if (!state.catalogsLoaded) {
      try { await loadCatalogs(); } catch (e) { console.warn('[SA] catálogos:', e.message); }
    }

    let sensors = [];
    try { sensors = await loadSensorsForNode(ev.nodeId); } catch (e) { console.warn('[SA] sensores:', e.message); }

    const eqOptions = state.allEquipments
      .map(e => '<option value="' + e.id + '"' + (e.id === ev.equipmentId ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>')
      .join('');
    const sensorOptions = sensors
      .map(s => '<option value="' + s.id + '"' + (s.id === state.selectedSensorId ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>')
      .join('');

    showOverlay(
      '<div class="pl-cone">⚠️</div>' +
      '<div class="pl-title">PARO DE LÍNEA EN CURSO</div>' +
      '<div class="pl-timer" id="pl-timer">00:00:00</div>' +
      '<div class="pl-grid">' +
        '<div class="pl-static"><strong>Responsable</strong>' + escapeHtml(ev.responsable || '—') + '</div>' +
        '<div class="pl-static"><strong>Evento</strong>#' + ev.idInDomain + '</div>' +
        '<div>' +
          '<label class="pl-label">Línea / Equipo</label>' +
          '<select class="pl-select" id="pl-run-eq">' + eqOptions + '</select>' +
        '</div>' +
        '<div>' +
          '<label class="pl-label">Motivo</label>' +
          '<select class="pl-select" id="pl-run-sensor">' +
            '<option value="">— Selecciona motivo —</option>' + sensorOptions +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="pl-comment-row">' +
        '<textarea class="pl-textarea" id="pl-run-comment" placeholder="Agregar comentario…"></textarea>' +
        '<button class="pl-btn pl-btn-ghost" id="pl-run-addcomment">Añadir</button>' +
      '</div>' +
      '<div class="pl-comments">' +
        '<div class="pl-comments-title">Historial de comentarios</div>' +
        '<div id="pl-comments-list"></div>' +
      '</div>' +
      '<button class="pl-btn pl-btn-stop" id="pl-run-stop">DETENER PARO</button>' +
      '<div class="pl-btnrow" style="margin-top:10px">' +
        '<button class="pl-btn pl-btn-ghost" id="pl-run-hide">OCULTAR (continuar)</button>' +
      '</div>',
      { wide: true }
    );

    const timerEl = document.getElementById('pl-timer');
    const tick = () => { timerEl.textContent = formatElapsed(Date.now() - ev.createdAt); };
    tick();
    state.timerInterval = setInterval(tick, 1000);

    renderCommentsList();

    document.getElementById('pl-run-hide').onclick = removeOverlay;

    const eqSel = document.getElementById('pl-run-eq');
    eqSel.addEventListener('change', async () => {
      const newEqId = parseInt(eqSel.value, 10);
      if (!Number.isFinite(newEqId) || newEqId === ev.equipmentId) return;
      const prevEqName = ev.equipmentName;
      const newEq = state.allEquipments.find(e => e.id === newEqId);
      eqSel.disabled = true;
      try {
        await api().query('UpdateMaintenanceEvent',
          { id: ev.id, equipmentId: newEqId }, 'UpdateMaintenanceEvent');
        ev.equipmentId = newEqId;
        ev.equipmentName = newEq?.name || '';
        writeActiveEvent(ev);
        const autoText = 'Línea cambiada de "' + prevEqName + '" a "' + (newEq?.name || newEqId) + '" por el operador.';
        try {
          await api().query('CreateMaintenanceEventComment', {
            comment: autoText, maintenanceEventId: ev.id
          }, 'CreateMaintenanceEventComment');
          pushComment(ev, { text: autoText, auto: true });
        } catch (_) {}
      } catch (e) {
        alert('No se pudo cambiar el equipo: ' + e.message + '\nSe mantiene la línea anterior.');
        eqSel.value = String(ev.equipmentId);
      } finally {
        eqSel.disabled = false;
      }
    });

    const sensorSel = document.getElementById('pl-run-sensor');
    sensorSel.addEventListener('change', () => {
      const sid = parseInt(sensorSel.value, 10);
      state.selectedSensorId = Number.isFinite(sid) ? sid : null;
      ev.selectedSensorId = state.selectedSensorId;
      writeActiveEvent(ev);
    });

    document.getElementById('pl-run-addcomment').onclick = async () => {
      const ta = document.getElementById('pl-run-comment');
      const txt = ta.value.trim();
      if (!txt) return;
      const btn = document.getElementById('pl-run-addcomment');
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api().query('CreateMaintenanceEventComment',
          { comment: txt, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
        pushComment(ev, { text: txt });
        ta.value = '';
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'Añadir'; btn.disabled = false; }, 900);
      } catch (e) {
        alert('Error agregando comentario: ' + e.message);
        btn.textContent = 'Añadir';
        btn.disabled = false;
      }
    };

    document.getElementById('pl-run-stop').onclick = () => {
      stopEvent().catch(e => {
        alert('Error al detener: ' + e.message);
        const sb = document.getElementById('pl-run-stop');
        if (sb) { sb.disabled = false; sb.textContent = 'DETENER PARO'; }
      });
    };
  }

  function formatElapsed(ms) {
    if (!(ms >= 0)) ms = 0;
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  async function stopEvent() {
    const ev = state.activeEvent;
    if (!ev) return;
    if (!state.selectedSensorId) {
      alert('Selecciona un motivo antes de detener el paro.');
      return;
    }
    const stopBtn = document.getElementById('pl-run-stop');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = 'Deteniendo…'; }

    const finalCommentEl = document.getElementById('pl-run-comment');
    const finalComment = finalCommentEl?.value.trim();
    const totalMs = Date.now() - ev.createdAt;

    const ne = await api().query('CreateMaintenanceNodeEvent',
      { maintenanceNodeId: ev.nodeId, maintenanceEventId: ev.id }, 'CreateMaintenanceNodeEvent');
    const nodeEventId = ne?.createMaintenanceNodeEvent?.maintenanceNodeEvent?.id;
    if (!nodeEventId) throw new Error('Respuesta sin maintenanceNodeEvent.id');

    await api().query('CreateManySensorMeasurements', {
      input: [{
        sensorId: state.selectedSensorId,
        measurementBoolean: true,
        maintenanceNodeEventId: nodeEventId
      }]
    }, 'CreateManySensorMeasurements');

    if (finalComment) {
      try {
        await api().query('CreateMaintenanceEventComment',
          { comment: finalComment, maintenanceEventId: ev.id }, 'CreateMaintenanceEventComment');
        pushComment(ev, { text: finalComment });
      } catch (e) { console.warn('[SA] comentario final falló:', e.message); }
    }

    const completedAt = new Date().toISOString();
    await api().query('UpdateMaintenanceEvent',
      { id: ev.id, completedAt }, 'UpdateMaintenanceEvent');

    const sensors = await loadSensorsForNode(ev.nodeId).catch(() => []);
    const motivo = sensors.find(s => s.id === state.selectedSensorId)?.name || '(motivo)';

    const stopped = {
      id: ev.id,
      idInDomain: ev.idInDomain,
      totalMs,
      responsable: ev.responsable,
      motivo,
      linea: ev.equipmentName,
      completedAt
    };

    state.activeEvent = null;
    state.selectedSensorId = null;
    writeActiveEvent(null);
    if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
    updateFabStyle();

    renderSummaryView(stopped);
  }

  function renderSummaryView(s) {
    const domainId = cfg()?.steelhead?.domain?.id || '';
    const link = location.origin + '/Domains/' + domainId + '/MaintenanceEvents/' + s.idInDomain;
    showOverlay(
      '<div class="pl-summary">' +
        '<div style="font-size:44px">✅</div>' +
        '<div style="font-size:20px;font-weight:800;color:#86efac;margin:6px 0;letter-spacing:1px">PARO REGISTRADO</div>' +
        '<div class="pl-big">' + formatElapsed(s.totalMs) + '</div>' +
        '<dl class="pl-dl">' +
          '<dt>Responsable</dt><dd>' + escapeHtml(s.responsable || '—') + '</dd>' +
          '<dt>Motivo</dt><dd>' + escapeHtml(s.motivo || '—') + '</dd>' +
          '<dt>Línea</dt><dd>' + escapeHtml(s.linea || '—') + '</dd>' +
          '<dt>Evento</dt><dd><a href="' + link + '" target="_blank" style="color:#60a5fa;text-decoration:none">#' + s.idInDomain + '</a></dd>' +
        '</dl>' +
      '</div>' +
      '<div class="pl-btnrow">' +
        '<button class="pl-btn pl-btn-ghost" id="pl-sum-attach">📎 Adjuntar evidencia</button>' +
        '<button class="pl-btn pl-btn-primary" id="pl-sum-close">CERRAR</button>' +
      '</div>' +
      '<input type="file" id="pl-sum-file" accept="image/*,application/pdf" multiple style="display:none">'
    );

    const fileInput = document.getElementById('pl-sum-file');
    const attachBtn = document.getElementById('pl-sum-attach');
    attachBtn.onclick = () => fileInput.click();
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.length) return;
      attachBtn.disabled = true;
      attachBtn.textContent = 'Subiendo…';
      let ok = 0, fail = 0;
      for (const file of fileInput.files) {
        try { await attachEvidence(s.id, file); ok++; }
        catch (e) { fail++; console.error('[SA] attach', e); }
      }
      attachBtn.disabled = false;
      attachBtn.textContent = '📎 ' + ok + ' adjunto(s)' + (fail ? ' — ' + fail + ' fallaron' : '');
    });
    document.getElementById('pl-sum-close').onclick = removeOverlay;
  }

  async function attachEvidence(maintenanceEventId, file) {
    const formData = new FormData();
    formData.append('myfile', file, file.name);
    const resp = await fetch('/api/files', {
      method: 'POST', credentials: 'include', body: formData
    });
    if (!resp.ok) throw new Error('Upload HTTP ' + resp.status);
    const uploaded = await resp.json();
    await api().query('CreateUserFile',
      { name: uploaded.name, originalName: file.name }, 'CreateUserFile');
    await api().query('CreateMaintenanceEventUserFile',
      { maintenanceEventId, userFileName: uploaded.name }, 'CreateMaintenanceEventUserFile');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { init, openStopDialog, renderRunningView, stopEvent, attachEvidence };
})();

if (typeof window !== 'undefined') {
  window.ParosLinea = ParosLinea;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ParosLinea.init());
  } else {
    ParosLinea.init();
  }
}
})();
// ===== END scripts/paros-linea.js =====

// ===== BEGIN scripts/weight-quick-entry.js =====
(function(){
// Weight Quick Entry
// Inyecta campo de peso (KG o LB segun preferencia del cliente) en el modal de Receive Parts
// Ejecuta mediciones via CreateInventoryItemUnitConversion / UpdateInventoryItemUnitConversion
// Depends on: SteelheadAPI

const WeightQuickEntry = (() => {
  'use strict';

  const LOG_PREFIX = '[WQE]';
  const api = () => window.SteelheadAPI;
  let observerActive = false;
  let modalObserver = null;

  const inventoryItemCache = new Map();
  const lineStates = new Map();
  const unitObservers = [];

  let customerUseLbs = false;
  let lastCustomerId = null;

  function init() {
    const disabled = document.documentElement.dataset.saWeightQuickEntryEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── Fetch Interceptor ──

  function patchFetch() {
    if (window.__saWqeFetchPatched) return;
    window.__saWqeFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      const reqCid = bodyObj?.variables?.customerId;
      if (reqCid && reqCid !== lastCustomerId) {
        lastCustomerId = reqCid;
        customerLbsResolved = false;
        const modal = document.querySelector('[data-sa-wqe-attached="true"]');
        if (modal) {
          resolveCustomerPreference(modal).then(() => {
            updateFieldUnits(modal);
          });
        }
      }

      const response = await origFetch.apply(this, args);

      if (bodyObj?.operationName === 'ReceivingPartsPartNumbersQuery') {
        try {
          const clone = response.clone();
          const json = await clone.json();
          const nodes = json?.data?.allPartNumbers?.nodes || [];
          for (const pn of nodes) {
            const invItem = pn.inventoryItemByPartNumberId;
            if (pn.id && invItem?.id) {
              inventoryItemCache.set(pn.id, invItem.id);
              const pnStr = pn.stringValue || pn.name || pn.partNumber || '';
              if (pnStr) inventoryItemCache.set('str:' + pnStr.trim().toUpperCase(), invItem.id);
            }
          }
          if (nodes.length > 0) {
            console.log(LOG_PREFIX, `Cacheados ${nodes.length} inventoryItemIds`);
          }
        } catch (err) {
          console.warn(LOG_PREFIX, 'Error cacheando inventoryItemIds:', err);
        }

        if (!customerLbsResolved) {
          const modal = document.querySelector('[data-sa-wqe-attached="true"]');
          if (modal) {
            resolveCustomerPreference(modal).then(() => {
              updateFieldUnits(modal);
            });
          }
        }
      }

      return response;
    };
  }

  // ── Customer LBS Preference ──

  let customerLbsResolved = false;

  async function resolveCustomerPreference(modal) {
    if (customerLbsResolved) return;

    const name = extractCustomerName(modal);
    if (!name || name.length < 2) {
      if (lastCustomerId && !modal._saWqeRetryPending) {
        modal._saWqeRetryPending = true;
        console.log(LOG_PREFIX, 'Nombre no visible aun, reintentando en 800ms');
        setTimeout(() => {
          modal._saWqeRetryPending = false;
          resolveCustomerPreference(modal).then(() => updateFieldUnits(modal));
        }, 800);
      }
      return;
    }

    try {
      const data = await api().query('CustomerSearchByName',
        { nameLike: `%${name}%`, orderBy: ['NAME_ASC'] }, 'CustomerSearchByName');
      const nodes = data?.searchCustomers?.nodes || data?.allCustomers?.nodes || [];
      const found = nodes.find(c => c.name?.toUpperCase().includes(name.toUpperCase()));

      if (!found) {
        console.log(LOG_PREFIX, `Cliente "${name}" no encontrado en busqueda`);
        return;
      }

      console.log(LOG_PREFIX, `Cliente encontrado: ${found.name}, keys:`, Object.keys(found));

      if (found.customInputs) {
        customerUseLbs = checkLbsPreference(found.customInputs);
        customerLbsResolved = true;
        console.log(LOG_PREFIX, `usarLBS=${customerUseLbs} (via SearchByName)`);
        return;
      }

      const displayId = found.idInDomain ?? found.displayId;
      if (displayId != null) {
        try {
          const data2 = await api().query('Customer',
            { idInDomain: parseInt(displayId, 10), includeAccountingFields: false }, 'Customer');
          const cust = data2?.customerByIdInDomain || data2?.customerById;
          if (cust?.customInputs) {
            customerUseLbs = checkLbsPreference(cust.customInputs);
            customerLbsResolved = true;
            console.log(LOG_PREFIX, `usarLBS=${customerUseLbs} (via Customer idInDomain=${displayId})`);
            return;
          }
          console.log(LOG_PREFIX, `Customer(${displayId}) sin customInputs, keys:`, cust ? Object.keys(cust) : 'null');
        } catch (err) {
          console.warn(LOG_PREFIX, 'Customer query fallida:', err.message || err);
        }
      } else {
        console.log(LOG_PREFIX, 'CustomerSearchByName no devolvio idInDomain');
      }

      customerLbsResolved = true;
      console.log(LOG_PREFIX, `Cliente resuelto sin customInputs, usando KG por defecto`);
    } catch (err) {
      console.warn(LOG_PREFIX, 'Error en resolveCustomerPreference:', err.message || err);
    }
  }

  function checkLbsPreference(customInputs) {
    if (Array.isArray(customInputs)) {
      return customInputs.some(ci => {
        const name = (ci.name || ci.fieldName || ci.label || '').toLowerCase();
        return name.includes('lbs') && (ci.value === true || ci.value === 'true' || ci.textValue === 'true');
      });
    }
    if (typeof customInputs === 'object' && customInputs !== null) {
      return searchObjForLbs(customInputs);
    }
    return false;
  }

  function searchObjForLbs(obj) {
    for (const [key, val] of Object.entries(obj)) {
      const k = key.toLowerCase();
      if (k.includes('lbs') || k === 'unidadmedidapeso' || (k.includes('usar') && k.includes('lb'))) {
        if (val === true || val === 'true') return true;
      }
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        if (searchObjForLbs(val)) return true;
      }
    }
    return false;
  }

  const PLACEHOLDER_RE = /^(buscar|search|select|seleccionar|todo|all|elegir|choose)/i;
  const STRIP_PREFIX = /^[-–—\s]+/;
  const STRIP_ID_SUFFIX = /\s*\(#\d+\).*/;

  function isPlaceholder(text) {
    return !text || text.length < 3 || PLACEHOLDER_RE.test(text);
  }

  function cleanName(text) {
    return text?.trim().replace(STRIP_PREFIX, '').replace(STRIP_ID_SUFFIX, '').trim() || '';
  }

  function extractCustomerName(modal) {
    const labels = modal.querySelectorAll('label, span, div, p');
    for (const el of labels) {
      const txt = el.textContent?.trim();
      if (!txt || !/^(customer|cliente):?$/i.test(txt)) continue;

      const container = el.closest('div[class*="field"]')
        || el.closest('div')?.parentElement
        || el.parentElement;
      if (!container) continue;

      const sv = container.querySelector('[class*="singleValue"], [class*="SingleValue"]');
      if (sv) {
        const clone = sv.cloneNode(true);
        clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
        const text = cleanName(clone.textContent);
        if (!isPlaceholder(text)) return text;
      }

      const inputs = container.querySelectorAll('input');
      for (const inp of inputs) {
        const v = cleanName(inp.value);
        if (!isPlaceholder(v)) return v;
      }
    }

    return null;
  }

  function updateFieldUnits(modal) {
    const newUnit = customerUseLbs ? 'LB' : 'KG';
    let updated = 0;
    for (const [container, state] of lineStates) {
      if (!modal.contains(container)) {
        lineStates.delete(container);
        continue;
      }
      updated++;
      if (state.weightUnit === newUnit) continue;
      state.weightUnit = newUnit;
      const label = container.querySelector('.sa-wqe-field label');
      if (label) label.textContent = `Peso cliente ${newUnit}:`;
      const input = state.weightInput;
      if (input) {
        input.placeholder = newUnit === 'KG' ? 'ej: 25' : 'ej: 55';
        if (!input.value) input.value = '';
      }
      const headerSpan = container.querySelector('.sa-wqe-header span');
      if (headerSpan && headerSpan.textContent.includes('Peso')) {
        headerSpan.textContent = `\u26A1 Peso r\u00e1pido (${newUnit})`;
      }
    }
    if (updated === 0) {
      processExistingLines(modal);
    }
    console.log(LOG_PREFIX, `Campos actualizados a ${newUnit} (${updated} existentes)`);
  }

  // ── MutationObserver: detect Receive Parts view ──

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    let scanTimeout = null;
    const observer = new MutationObserver(() => {
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(scanForReceiveView, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForReceiveView();
  }

  function scanForReceiveView() {
    const candidates = document.querySelectorAll(HEADING_SELECTOR);
    for (const el of candidates) {
      if (!VIEW_REGEX.test(el.textContent?.trim())) continue;
      const container = el.closest('[role="dialog"]')
        || el.closest('.MuiDialog-paper')
        || el.closest('[class*="MuiPaper"]')
        || el.closest('main')
        || el.closest('form')
        || el.parentElement?.parentElement;
      if (container) {
        onModalFound(container);
        return;
      }
    }
  }

  function onModalFound(modal) {
    if (modal.dataset.saWqeAttached) return;
    modal.dataset.saWqeAttached = 'true';
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    interceptSaveButtons(modal);
    watchModalRemoval(modal);

    const ready = resolveCustomerPreference(modal);

    ready.then(() => {
      console.log(LOG_PREFIX, `Inyectando campos (unidad: ${customerUseLbs ? 'LB' : 'KG'})`);
      processExistingLines(modal);
      observeNewLines(modal);
    });
  }

  // ── Modal Cleanup ──

  function watchModalRemoval(modal) {
    const removalObserver = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        removalObserver.disconnect();
        cleanupModal(modal);
      }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
  }

  function cleanupModal(modal) {
    if (modalObserver) { modalObserver.disconnect(); modalObserver = null; }
    if (modal._saWqeSaveObserver) { modal._saWqeSaveObserver.disconnect(); }
    for (const obs of unitObservers) obs.disconnect();
    unitObservers.length = 0;
    for (const [container] of lineStates) {
      if (modal.contains(container)) lineStates.delete(container);
    }
    customerLbsResolved = false;
    customerUseLbs = false;
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  // ── Styles ──

  function injectStyles() {
    if (document.getElementById('sa-wqe-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-wqe-styles';
    style.textContent = `
      .sa-wqe-container {
        border: 2px dashed #ccc;
        border-radius: 8px;
        padding: 10px 14px;
        margin-top: 8px;
        background: #fafafa;
        transition: border-color 0.2s, background 0.2s;
      }
      .sa-wqe-container[data-state="pending"] {
        border-color: #e74c3c;
        border-style: dashed;
        background: #fef9f9;
      }
      .sa-wqe-container[data-state="executing"] {
        border-color: #ff9800;
        background: #fff8e1;
        pointer-events: none;
        opacity: 0.7;
      }
      .sa-wqe-container[data-state="done"] {
        border-color: #4CAF50;
        border-style: solid;
        background: #f6fef6;
      }
      .sa-wqe-container[data-state="error"] {
        border-color: #f44336;
        border-style: solid;
        background: #fef0f0;
      }
      .sa-wqe-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .sa-wqe-fields {
        display: flex;
        gap: 12px;
        align-items: flex-end;
      }
      .sa-wqe-field label {
        display: block;
        font-size: 11px;
        color: #666;
        margin-bottom: 3px;
      }
      .sa-wqe-field input {
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 6px 8px;
        width: 100px;
        font-size: 14px;
        font-family: inherit;
      }
      .sa-wqe-field input:read-only {
        background: #f5f5f5;
        color: #666;
      }
      .sa-wqe-hint {
        margin-top: 5px;
        font-size: 10px;
        color: #888;
      }
      .sa-wqe-status {
        font-size: 11px;
        margin-left: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Line Detection & DOM Injection ──

  function processExistingLines(modal) {
    const sections = findQuantitySections(modal);
    for (const section of sections) {
      injectWeightFields(section, modal);
    }
  }

  function observeNewLines(modal) {
    if (modalObserver) modalObserver.disconnect();
    let debounceTimeout = null;
    modalObserver = new MutationObserver(() => {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        const sections = findQuantitySections(modal);
        for (const section of sections) {
          injectWeightFields(section, modal);
        }
      }, 200);
    });
    modalObserver.observe(modal, { childList: true, subtree: true });
  }

  function findQuantitySections(container) {
    const results = [];
    const table = container.querySelector('table.MuiTable-root') || container.querySelector('table');
    if (!table) {
      const ancestor = container.closest?.('table.MuiTable-root') || container.closest?.('table');
      if (ancestor) return findQuantitySectionsInTable(ancestor);
      return results;
    }
    return findQuantitySectionsInTable(table);
  }

  function findQuantitySectionsInTable(table) {
    const results = [];
    const headers = table.querySelectorAll('thead th');
    let colIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      if (/cantidad|quantity/i.test(headers[i].textContent.trim())) {
        colIdx = i;
        break;
      }
    }
    if (colIdx < 0) return results;

    const rows = table.querySelectorAll('tbody > tr');
    for (const row of rows) {
      const cells = row.querySelectorAll(':scope > td');
      const cell = cells[colIdx];
      if (!cell || cell.querySelector('.sa-wqe-container')) continue;

      const inputs = cell.querySelectorAll('input');
      if (inputs.length === 0) continue;

      const countInput = inputs[inputs.length - 1];
      results.push({ countInput, countParent: cell, row, cell });
    }
    return results;
  }

  function getCountValue(countInput) {
    const val = parseFloat(countInput?.value);
    return isNaN(val) || val <= 0 ? 0 : val;
  }

  function getUnitValue(section) {
    const cell = section.cell || section.countParent;
    const inputs = [...cell.querySelectorAll('input')]
      .filter(inp => !inp.closest('.sa-wqe-container'));
    if (inputs.length > 1) {
      return inputs[0].value?.trim() || '';
    }
    return '';
  }

  function getPartNumberId(section) {
    const row = section.row || section.countParent?.closest('tr');
    if (!row) return null;
    const viewLink = row.querySelector('a[href*="part-numbers/"], a[href*="PartNumbers/"]');
    if (viewLink) {
      const match = viewLink.href.match(/(?:part-numbers|PartNumbers)\/(\d+)/i);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  function resolveInventoryItemId(section) {
    const row = section.row || section.countParent?.closest('tr');

    const pnId = getPartNumberId(section);
    if (pnId) {
      const invId = inventoryItemCache.get(pnId);
      if (invId) return { pnId, inventoryItemId: invId };
      return { pnId, inventoryItemId: null };
    }

    if (row) {
      const firstCell = row.querySelector('td');
      if (firstCell) {
        const pnText = extractPnText(firstCell);
        if (pnText) {
          const invId = inventoryItemCache.get('str:' + pnText.toUpperCase());
          if (invId) {
            console.log(LOG_PREFIX, `Resuelto por texto PN: "${pnText}"`);
            return { pnId: null, inventoryItemId: invId };
          }
        }
      }
    }

    const pnEntries = [];
    for (const [k, v] of inventoryItemCache) {
      if (typeof k === 'string' && k.startsWith('str:')) continue;
      pnEntries.push([k, v]);
    }
    if (pnEntries.length === 1) {
      console.log(LOG_PREFIX, 'Usando unico inventoryItemId cacheado:', pnEntries[0][1]);
      return { pnId: pnEntries[0][0], inventoryItemId: pnEntries[0][1] };
    }

    console.warn(LOG_PREFIX, 'resolveInventoryItemId fallo. Cache keys:', [...inventoryItemCache.keys()]);
    return { pnId: null, inventoryItemId: null };
  }

  function extractPnText(cell) {
    const links = cell.querySelectorAll('a');
    for (const link of links) {
      const text = link.textContent?.trim();
      if (text) {
        const match = text.match(/ver\s+'([^']+)'/i) || text.match(/view\s+'([^']+)'/i);
        if (match) return match[1].trim();
      }
    }
    const singleValue = cell.querySelector('[class*="singleValue"], [class*="SingleValue"]');
    if (singleValue) {
      const text = singleValue.textContent?.trim();
      if (text) return text;
    }
    const inputs = cell.querySelectorAll('input');
    for (const inp of inputs) {
      const val = inp.value?.trim();
      if (val && val.length > 1) return val;
    }
    return null;
  }

  // ── Weight Field Injection ──

  function injectWeightFields(section, modal) {
    if (section.countParent.querySelector('.sa-wqe-container')) return;

    const unitVal = getUnitValue(section);
    if (unitVal && unitVal !== 'Count' && unitVal !== 'Conteo') return;

    const weightUnit = customerUseLbs ? 'LB' : 'KG';

    const container = document.createElement('div');
    container.className = 'sa-wqe-container';
    container.dataset.state = 'empty';

    const header = document.createElement('div');
    header.className = 'sa-wqe-header';
    const headerLabel = document.createElement('span');
    headerLabel.style.color = '#e74c3c';
    headerLabel.textContent = '\u26A1 Peso r\u00e1pido (' + weightUnit + ')';
    const headerSub = document.createElement('span');
    headerSub.style.cssText = 'font-weight:400; color:#999; font-size:10px;';
    headerSub.textContent = '(SteelheadAutomator)';
    header.appendChild(headerLabel);
    header.appendChild(headerSub);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'sa-wqe-status';
    header.appendChild(statusSpan);
    container.appendChild(header);

    const fieldsRow = document.createElement('div');
    fieldsRow.className = 'sa-wqe-fields';

    const weightInput = document.createElement('div');
    weightInput.className = 'sa-wqe-field';
    const label = document.createElement('label');
    label.textContent = `Peso cliente ${weightUnit}:`;
    weightInput.appendChild(label);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = weightUnit === 'KG' ? 'ej: 25' : 'ej: 55';
    input.addEventListener('blur', () => {
      const val = parseFloat(input.value);
      if (input.value && !isNaN(val) && val >= 0) {
        executeMeasurement(container);
      }
    });
    weightInput.appendChild(input);
    fieldsRow.appendChild(weightInput);
    container.appendChild(fieldsRow);

    const hint = document.createElement('div');
    hint.className = 'sa-wqe-hint';
    hint.textContent = 'Tab para registrar \u00b7 Registra KG + LB autom\u00e1ticamente';
    container.appendChild(hint);

    section.countParent.appendChild(container);

    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      const st = lineStates.get(container);
      if (input.value !== '' && !isNaN(val) && val >= 0) {
        container.dataset.state = 'pending';
        if (st) st.status = 'pending';
      } else {
        container.dataset.state = 'empty';
        if (st) st.status = 'empty';
      }
    });

    const state = {
      container,
      weightInput: input,
      weightUnit,
      statusSpan,
      section,
      status: 'empty'
    };
    lineStates.set(container, state);

    watchUnitChanges(section, container);

    section.countInput.addEventListener('input', () => {
      if (state.status === 'done') {
        state.status = 'pending';
        container.dataset.state = 'pending';
        statusSpan.textContent = '\u23F3 Recalcular';
        statusSpan.style.color = '#ff9800';
        input.readOnly = false;
      }
    });
  }

  function watchUnitChanges(section, container) {
    const cell = section.cell || section.countParent;
    if (!cell) return;

    const unitObserver = new MutationObserver(() => {
      const unitVal = getUnitValue(section);
      if (unitVal && unitVal !== 'Count' && unitVal !== 'Conteo') {
        container.style.display = 'none';
      } else {
        container.style.display = '';
      }
    });
    unitObserver.observe(cell, { childList: true, subtree: true, characterData: true, attributes: true });
    unitObservers.push(unitObserver);
  }

  // ── Measurement Execution ──

  async function executeMeasurement(container) {
    const state = lineStates.get(container);
    if (!state) return;
    if (state.status === 'executing' || state.status === 'done') return;

    const count = getCountValue(state.section.countInput);
    if (count <= 0) {
      setStatus(state, 'error', 'Count debe ser > 0');
      return;
    }

    const inputVal = parseFloat(state.weightInput.value);
    if (state.weightInput.value === '' || isNaN(inputVal) || inputVal < 0) return;

    const KGM_TO_LBR = api()?.getDomain?.()?.conversions?.KGM_TO_LBR || 2.20462;
    const weightKG = state.weightUnit === 'KG' ? inputVal : inputVal / KGM_TO_LBR;

    const resolved = resolveInventoryItemId(state.section);
    let inventoryItemId = resolved.inventoryItemId;
    const pnId = resolved.pnId;

    if (!inventoryItemId && pnId) {
      try {
        setStatus(state, 'executing', 'Buscando PN...');
        const pnData = await api().query('GetPartNumber', { id: pnId }, 'GetPartNumber');
        const invId = pnData?.partNumberById?.inventoryItemByPartNumberId?.id
          || pnData?.partNumber?.inventoryItemByPartNumberId?.id;
        if (invId) {
          inventoryItemCache.set(pnId, invId);
          inventoryItemId = invId;
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Fallback GetPartNumber fallido:', err);
      }
    }

    if (!inventoryItemId) {
      console.warn(LOG_PREFIX, 'No se pudo resolver inventoryItemId. Cache:', [...inventoryItemCache.entries()]);
      setStatus(state, 'error', 'PN no resuelto');
      return;
    }

    setStatus(state, 'executing', 'Registrando...');

    try {
      const domain = api()?.getDomain?.();
      const unitIdKGM = domain?.unitIds?.KGM || 3969;
      const unitIdLBR = domain?.unitIds?.LBR || 3972;

      const factorKGM = weightKG / count;
      const factorLBR = (weightKG * KGM_TO_LBR) / count;

      const unitsData = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
      const existingConversions = unitsData?.inventoryItemById
        ?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];

      await upsertConversion(existingConversions, unitIdKGM, inventoryItemId, factorKGM);
      await upsertConversion(existingConversions, unitIdLBR, inventoryItemId, factorLBR);

      state.weightInput.readOnly = true;
      const factorText = `${factorKGM.toFixed(4)} kg/pz \u00b7 ${factorLBR.toFixed(4)} lb/pz`;
      setStatus(state, 'done', factorText);
      console.log(LOG_PREFIX, `Medicion registrada: inventoryItem=${inventoryItemId} ${factorText}`);

    } catch (err) {
      console.error(LOG_PREFIX, 'Error registrando medicion:', err);
      setStatus(state, 'error', err.message || 'Error de red');
    }
  }

  async function upsertConversion(existingConversions, unitId, inventoryItemId, factor) {
    const existing = existingConversions.find(c => {
      return Number(c.unitByUnitId?.id) === Number(unitId);
    });

    if (existing) {
      await api().query('UpdateInventoryItemUnitConversion',
        { id: existing.id, factor },
        'UpdateInventoryItemUnitConversion'
      );
    } else {
      await api().query('CreateInventoryItemUnitConversion',
        { unitId, inventoryItemId, factor },
        'CreateInventoryItemUnitConversion'
      );
    }
  }

  function setStatus(state, status, message) {
    state.status = status;
    state.container.dataset.state = status;
    if (status === 'done') {
      state.statusSpan.textContent = '\u2705 ' + message;
      state.statusSpan.style.color = '#4CAF50';
    } else if (status === 'error') {
      state.statusSpan.textContent = '\u274C ' + message;
      state.statusSpan.style.color = '#f44336';
    } else if (status === 'executing') {
      state.statusSpan.textContent = '\u23F3 ' + message;
      state.statusSpan.style.color = '#ff9800';
    } else if (status === 'pending') {
      state.statusSpan.textContent = '\u23F3 pendiente';
      state.statusSpan.style.color = '#999';
    } else {
      state.statusSpan.textContent = '';
    }
  }

  // ── SAVE Button Interception ──

  function interceptSaveButtons(modal) {
    const attachToSaveButtons = () => {
      const buttons = modal.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toUpperCase() || '';
        const isSaveBtn = text === 'SAVE' || text.startsWith('SAVE +') || text.startsWith('SAVE &')
          || text === 'GUARDAR' || text.startsWith('GUARDAR +') || text.startsWith('GUARDAR Y');
        if (isSaveBtn && !btn.dataset.saWqeIntercepted) {
          btn.dataset.saWqeIntercepted = 'true';
          btn.addEventListener('click', handleSaveClick, true);
        }
      }
    };

    const observer = new MutationObserver(attachToSaveButtons);
    observer.observe(modal, { childList: true, subtree: true });
    modal._saWqeSaveObserver = observer;

    attachToSaveButtons();
  }

  function handleSaveClick(e) {
    const btn = e.currentTarget;
    if (btn.dataset.saWqeBypass) return;

    const pending = [];
    for (const [container, state] of lineStates) {
      if (state.status === 'pending' && state.weightInput.value) {
        pending.push(container);
      }
    }

    if (pending.length === 0) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    console.log(LOG_PREFIX, `Procesando ${pending.length} mediciones pendientes antes de SAVE`);

    Promise.allSettled(pending.map(c => executeMeasurement(c))).then(results => {
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(LOG_PREFIX, `${failed}/${pending.length} mediciones fallaron, SAVE continua`);
      }
      btn.dataset.saWqeBypass = 'true';
      btn.click();
      delete btn.dataset.saWqeBypass;
    });
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.WeightQuickEntry = WeightQuickEntry;
  WeightQuickEntry.init();
}
})();
// ===== END scripts/weight-quick-entry.js =====

// ===== BEGIN scripts/receiver-date-override.js =====
(function(){
// Receiver Date Override
// Inyecta un campo "Fecha real de recibido:" en el modal de Receive Parts.
// Intercepta CreateReceiverChecked y, cuando el usuario tocó el campo,
// dispara un follow-up UpdateReceiver con el receivedAt elegido (server
// no acepta receivedAt en el create — siempre lo setea a NOW).
// No depende de SteelheadAPI (solo intercept de fetch nativo).

const ReceiverDateOverride = (() => {
  'use strict';

  const LOG_PREFIX = '[RDO]';
  let observerActive = false;
  let modalObserver = null;

  // modal element → { input, warningEl, userTouched, removalObserver }
  const modalStates = new WeakMap();

  function init() {
    const disabled = document.documentElement.dataset.saReceiverDateOverrideEnabled === 'false';
    if (disabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  // ── MutationObserver: detect Receive Parts modal ──

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const VIEW_REGEX = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    let scanTimeout = null;
    const observer = new MutationObserver(() => {
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(scanForReceiveView, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanForReceiveView();
  }

  function scanForReceiveView() {
    const candidates = document.querySelectorAll(HEADING_SELECTOR);
    for (const el of candidates) {
      if (!VIEW_REGEX.test(el.textContent?.trim())) continue;
      const container = el.closest('[role="dialog"]')
        || el.closest('.MuiDialog-paper')
        || el.closest('[class*="MuiPaper"]')
        || el.closest('main')
        || el.closest('form')
        || el.parentElement?.parentElement;
      if (container) {
        onModalFound(container);
        return;
      }
    }
  }

  function onModalFound(modal) {
    if (modal.dataset.saRdoAttached === 'true') return;
    modal.dataset.saRdoAttached = 'true';
    modalStates.set(modal, {});  // initialize empty state before any downstream code runs
    console.log(LOG_PREFIX, 'Modal de recibo detectado');
    injectStyles();
    injectField(modal);
    watchModalRemoval(modal);
  }

  function watchModalRemoval(modal) {
    const removalObserver = new MutationObserver(() => {
      if (!document.body.contains(modal)) {
        removalObserver.disconnect();
        cleanupModal(modal);
      }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const state = modalStates.get(modal);
    if (state) state.removalObserver = removalObserver;
  }

  function cleanupModal(modal) {
    const state = modalStates.get(modal);
    if (state?.removalObserver) state.removalObserver.disconnect();
    modalStates.delete(modal);
    console.log(LOG_PREFIX, 'Modal cleanup completado');
  }

  // ── Placeholder functions (implementadas en tareas siguientes) ──

  const UPDATE_RECEIVER_HASH = '005653bae4baad289db47d65857cc4e9fb89fa51e06caa78a1f0946dce7f92ec';

  function patchFetch() {
    if (window.__saRdoFetchPatched) return;
    window.__saRdoFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body || typeof opts.body !== 'string') {
        return origFetch.apply(this, args);
      }

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return origFetch.apply(this, args); }

      if (bodyObj?.operationName !== 'CreateReceiverChecked') {
        return origFetch.apply(this, args);
      }

      // Capturar intent ANTES de enviar (el modal se desmonta tras Save)
      let pendingISO = null;
      let pendingPayload = null;
      try {
        const modal = document.querySelector('[data-sa-rdo-attached="true"]');
        const state = modal && modalStates.get(modal);
        if (state?.userTouched && state.input?.value) {
          const [y, m, d] = state.input.value.split('-').map(Number);
          const timeStr = state.timeInput?.value || '12:00';
          const [hh, mm] = timeStr.split(':').map(Number);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            pendingISO = new Date(y, m - 1, d, isNaN(hh) ? 12 : hh, isNaN(mm) ? 0 : mm, 0).toISOString();
            const rp = bodyObj.variables?.receiverPayload || {};
            pendingPayload = {
              notes: rp.notes ?? '',
              customInputs: rp.customInputs ?? {},
              inputSchemaId: rp.inputSchemaId ?? null,
            };
            state.userTouched = false;
          }
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Error capturando intent del modal — paso through:', err);
      }

      const response = await origFetch.apply(this, args);
      if (!pendingISO) return response;

      // Inspeccionar response sin consumirla
      let receiverId = null;
      try {
        const cloned = response.clone();
        const json = await cloned.json();
        if (json?.errors?.length) {
          console.warn(LOG_PREFIX, 'CreateReceiverChecked devolvió errors — sin follow-up:', json.errors);
          return response;
        }
        receiverId = json?.data?.createReceiverChecked?.id ?? null;
      } catch (err) {
        console.warn(LOG_PREFIX, 'No se pudo parsear response de CreateReceiverChecked:', err);
        return response;
      }

      if (!receiverId) {
        console.warn(LOG_PREFIX, 'CreateReceiverChecked sin id en response — skip follow-up');
        return response;
      }

      // Disparar follow-up UpdateReceiver (no awaiteamos para no bloquear el UI)
      const updateBody = {
        operationName: 'UpdateReceiver',
        variables: {
          id: receiverId,
          notes: pendingPayload.notes,
          receivedAt: pendingISO,
          customInputs: pendingPayload.customInputs,
          inputSchemaId: pendingPayload.inputSchemaId,
        },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: UPDATE_RECEIVER_HASH },
        },
      };

      origFetch.call(this, url, {
        method: 'POST',
        credentials: opts.credentials || 'include',
        headers: opts.headers || { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      }).then(r => r.json()).then(j => {
        if (j?.errors?.length) {
          console.warn(LOG_PREFIX, `UpdateReceiver follow-up con errors (id=${receiverId}):`, j.errors);
        } else {
          console.log(LOG_PREFIX, `UpdateReceiver follow-up OK: id=${receiverId} receivedAt=${pendingISO}`);
        }
      }).catch(err => {
        console.warn(LOG_PREFIX, `UpdateReceiver follow-up falló (id=${receiverId}):`, err);
      });

      return response;
    };
  }
  function injectStyles() {
    if (document.getElementById('sa-rdo-styles')) return;
    const style = document.createElement('style');
    style.id = 'sa-rdo-styles';
    style.textContent = `
      .sa-rdo-row-label, .sa-rdo-row-controls {
        margin-top: 12px;
      }
      .sa-rdo-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .sa-rdo-input {
        border: 1px solid #c4c4c4;
        border-radius: 4px;
        padding: 8.5px 14px;
        font: inherit;
        font-size: 14px;
        background: #fff;
        color: rgba(0,0,0,0.87);
      }
      .sa-rdo-input:focus {
        outline: 2px solid #1976d2;
        outline-offset: -1px;
        border-color: transparent;
      }
      .sa-rdo-chip {
        border: 1px solid rgba(25,118,210,0.5);
        color: #1976d2;
        background: transparent;
        border-radius: 16px;
        padding: 4px 12px;
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
      }
      .sa-rdo-chip:hover {
        background: rgba(25,118,210,0.08);
        border-color: #1976d2;
      }
      .sa-rdo-warning {
        flex-basis: 100%;
        margin-top: 4px;
        font-size: 12px;
        color: #ed6c02;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }
  function todayString(offsetDays = 0) {
    const d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function daysDiff(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    const picked = new Date(y, m - 1, d, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((picked.getTime() - today.getTime()) / 86400000);
  }

  function updateWarning(state) {
    const el = state.warningEl;
    if (!el) return;
    const val = state.input.value;
    if (!val) { el.hidden = true; el.textContent = ''; return; }
    const diff = daysDiff(val);
    if (diff === null) { el.hidden = true; el.textContent = ''; return; }
    if (diff > 0) {
      el.textContent = '⚠️ Fecha de recibo en el futuro';
      el.hidden = false;
    } else if (diff < -7) {
      el.textContent = '⚠️ Fecha real de recibo mayor a una semana';
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function injectField(modal) {
    // Anclar dentro del .css-iyrxkt de "Cliente:" / "Customer:" como rows extra del grid
    const labels = modal.querySelectorAll('p');
    let customerWrapper = null;
    for (const p of labels) {
      if (/^(?:customer|cliente):?$/i.test(p.textContent.trim())) {
        customerWrapper = p.closest('.css-iyrxkt');
        break;
      }
    }
    if (!customerWrapper) {
      console.warn(LOG_PREFIX, 'No se localizó el wrapper de Cliente — layout cambió?');
      return;
    }
    if (customerWrapper.querySelector('[data-sa-rdo-field="true"]')) return;

    const label = document.createElement('p');
    label.className = 'MuiTypography-root MuiTypography-body1 css-9l3uo3 sa-rdo-row-label';
    label.style.gridColumn = '1';
    label.textContent = 'Fecha real de recibido:';
    label.dataset.saRdoField = 'true';

    const controls = document.createElement('div');
    controls.style.gridColumn = '2';
    controls.className = 'sa-rdo-controls sa-rdo-row-controls';
    controls.dataset.saRdoField = 'true';

    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'sa-rdo-input';
    input.value = todayString(0);
    controls.appendChild(input);

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'sa-rdo-input sa-rdo-time';
    timeInput.value = '12:00';
    controls.appendChild(timeInput);

    const chipHoy = document.createElement('button');
    chipHoy.type = 'button';
    chipHoy.className = 'sa-rdo-chip';
    chipHoy.dataset.offset = '0';
    chipHoy.textContent = 'Hoy';
    controls.appendChild(chipHoy);

    const chipAyer = document.createElement('button');
    chipAyer.type = 'button';
    chipAyer.className = 'sa-rdo-chip';
    chipAyer.dataset.offset = '-1';
    chipAyer.textContent = 'Ayer';
    controls.appendChild(chipAyer);

    const warningEl = document.createElement('div');
    warningEl.className = 'sa-rdo-warning';
    warningEl.hidden = true;
    controls.appendChild(warningEl);

    customerWrapper.appendChild(label);
    customerWrapper.appendChild(controls);

    // Estado por modal
    const state = modalStates.get(modal) || {};
    state.input = input;
    state.timeInput = timeInput;
    state.warningEl = warningEl;
    state.userTouched = false;
    modalStates.set(modal, state);

    // Tracking de intención
    const markTouched = () => { state.userTouched = true; updateWarning(state); };
    input.addEventListener('input', markTouched);
    input.addEventListener('change', markTouched);
    timeInput.addEventListener('input', markTouched);
    timeInput.addEventListener('change', markTouched);

    for (const chip of [chipHoy, chipAyer]) {
      chip.addEventListener('click', () => {
        const offset = parseInt(chip.dataset.offset, 10);
        input.value = todayString(offset);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        markTouched();
      });
    }

    console.log(LOG_PREFIX, 'Campo de fecha inyectado, default=', input.value);
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.ReceiverDateOverride = ReceiverDateOverride;
  ReceiverDateOverride.init();
}
})();
// ===== END scripts/receiver-date-override.js =====

