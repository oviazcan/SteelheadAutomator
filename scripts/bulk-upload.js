// Steelhead Bulk Upload — Pipeline hardened para cargas masivas (18k+ filas)
//
// VERSION 1.2.11 (2026-05-20): Dedup strict-match en alternates + chips CSV con color catálogo
//   - F1: dedupModifyTargets ahora respeta la misma regla que classifyOnePN al elegir
//     alternates (Pase 3): nivel 1 strict-match (acabados ordenados iguales al CSV),
//     nivel 2 blank candidate, nivel 3 demota a NEW. Antes (1.2.10) tomaba el primer
//     candidato disponible aunque sus acabados no matchearan, causando re-asignaciones
//     silenciosas. Threading nonFinishList por dedupModifyTargets para coincidir
//     filtrado con classifyOnePN.
//   - F2: chips CSV ahora se pintan con color real del catálogo Steelhead. Aunque el
//     CSV no trae color de origen, si el nombre del label matchea algún labelObj.color
//     visto en candidates del run, se aplica ese color. Construido un labelColorByName
//     global a nivel preview vía recorrido por todos los candidates.labelObjs.
//
// VERSION 1.2.10 (2026-05-20): Dedup MODIFY targets + UI slim + label colors reales
//   - dedupModifyTargets(): impide que dos filas CSV apunten al mismo existingId; loser
//     se re-asigna a un candidato alterno o se demota a NEW si no hay alternativa
//   - Aplicado en classify (mass+onDemand) y defense-in-depth tras restore de overrides
//   - UI Pase 3: header en una sola línea (título + metal + QUOTE_NO legacy), proc abajo
//   - Etiquetas de candidatos con color real desde labelByLabelId.color + foreground
//     calculado por luminancia (ITU-R BT.601, threshold 0.55)
//   - Banner inline en filas con dedupReassigned/dedupConflict para transparencia
//   - Reporte de etiquetas CSV no encontradas en Steelhead: preflight a nivel execute
//     (warn al cargar catálogo) + per-row error en enrichWorker (antes se dropeaban
//     silenciosas con .filter(Boolean))
//
// VERSION 1.1.0 (2026-05-20): Dedup por QuoteIBMS + composite con override manual
//   - Pase 1 IBMS autoritativo, Pase 2 composite exacto con regla anti-colisión,
//     Pase 3 near-match con dropdown en preview + links a candidatos
//   - Blacklist nonFinishLabelNames en config para distinguir acabados vs plantas/status
//   - Prefetch paginado por cliente (reemplaza loop "una query por nombre")
//   - Reporte XLSX al final del run (Resumen + Decisiones Pase 3 + Errores)
//   - Resume schema extendido con classifications + userOverride
//   - Tests Node de helpers puros en tools/test/bulk-upload-helpers.test.js
//
// VERSION 1.0.0 (2026-05-18): hardening 7 fixes sobre v9
//   Fix 1: pool concurrente SavePartNumber enrich
//   Fix 2: paginación AllPartNumbers en checkPNExistence
//   Fix 3: cancellation token + panel con botón Detener
//   Fix 4: preview paginado del modal
//   Fix 5: withRetry [1s,2s,4s] global
//   Fix 6: pool concurrente archivado final
//   Fix 7: resume tras crash en chrome.storage.local
// Depende de: SteelheadAPI (steelhead-api.js)

const BulkUpload = (() => {
  'use strict';

  const VERSION = '1.4.25';
  const api = () => window.SteelheadAPI;

  // 1.4.20: stop AGRESIVO de Datadog. Versión 1.4.19 llamaba solo a
  // stopSessionReplayRecording() pero en runs largos (3692 PNs) la memoria
  // seguía creciendo ~43 MB/min — el SDK mantiene observers de DOM activos
  // aunque el flag esté "stopped". Esta versión:
  //   1) Intenta TODAS las APIs de stop conocidas
  //   2) Revoca tracking consent (impide nuevos eventos)
  //   3) Monkey-patchea fetch para descartar requests al endpoint Datadog
  //      (cierra el loop: aunque el SDK acumule buffer, no logra enviarlo
  //       y los retries no inflan más el heap)
  function stopDatadogSessionReplay() {
    // 1.4.24 Fix EE: latch. La invocación desde startMemoryGauge.tick() corre
    // cada 2s mientras pct >= 70 — antes (1.4.20-1.4.23) eso ejecutaba todo el
    // bloque cada tick y, peor, llamaba log() cada vez. El log() de steelhead-api
    // pushea a un array sin cap y re-serializa a localStorage en cada call →
    // O(n²) memoria + churn de sa_last_log. Latch idempotente: el primer call
    // hace el trabajo (stops + patches + Apollo cleanup), los siguientes solo
    // re-intentan Apollo cleanup silencioso (porque el cache sí puede crecer y
    // queremos drenarlo periódicamente).
    if (window.__sa_dd_stopped) {
      try {
        const candidates = [
          window.__APOLLO_CLIENT__,
          window.apolloClient,
          window.__APOLLO__?.client
        ].filter(Boolean);
        for (const client of candidates) {
          try {
            if (typeof client.clearStore === 'function') client.clearStore().catch(() => {});
            else if (client.cache && typeof client.cache.reset === 'function') client.cache.reset();
          } catch (_) {}
        }
      } catch (_) {}
      return;
    }
    try {
      const dd = window.DD_RUM || window.datadogRum || window.__DD_RUM__;
      if (dd) {
        try { dd.stopSessionReplayRecording?.(); } catch (_) {}
        try { dd.stopSession?.(); } catch (_) {}
        try { dd.setTrackingConsent?.('not-granted'); } catch (_) {}
        log('Datadog: stopSessionReplay + stopSession + consent revoked.');
      }
    } catch (_) { /* defensa */ }
    // Monkey-patch fetch: una sola vez por tab. Descarta requests a Datadog
    // y los responde con 204 vacío para que el SDK no haga retry.
    if (!window.__sa_fetch_patched) {
      try {
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input?.url || '');
          if (/browser-intake-ddog-gov\.com|datadoghq\.com|datadog-rum/i.test(url)) {
            return Promise.resolve(new Response('', { status: 204 }));
          }
          return origFetch.call(this, input, init);
        };
        // También sendBeacon (Datadog lo usa para session replay)
        if (navigator.sendBeacon) {
          const origBeacon = navigator.sendBeacon.bind(navigator);
          navigator.sendBeacon = function (url, data) {
            if (/browser-intake-ddog-gov\.com|datadoghq\.com/i.test(url)) return true;
            return origBeacon(url, data);
          };
        }
        // 1.4.21 Fix CC v3: también XHR. Algunas SDKs (incluido Apollo DevTools y
        // ciertos sinks de RUM) usan XMLHttpRequest, no fetch. Sin esto, el patch
        // de fetch deja la mitad del flujo abierto.
        if (window.XMLHttpRequest && !window.__sa_xhr_patched) {
          const origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function (method, url) {
            this.__sa_url = url;
            return origOpen.apply(this, arguments);
          };
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function (body) {
            const url = this.__sa_url || '';
            if (/browser-intake-ddog-gov\.com|datadoghq\.com|datadog-rum/i.test(url)) {
              try { this.abort(); } catch (_) {}
              return;
            }
            return origSend.apply(this, arguments);
          };
          window.__sa_xhr_patched = true;
        }
        window.__sa_fetch_patched = true;
        log('Fetch+sendBeacon+XHR a Datadog patcheados (defensa anti-leak).');
      } catch (e) { warn(`Patch fetch falló: ${String(e?.message || e).substring(0, 80)}`); }
    }
    // 1.4.21 Fix CC v3: intento agresivo de cleanup del Apollo Client de Steelhead.
    // El cliente no está expuesto en window.__APOLLO_CLIENT__ en su build de prod,
    // pero podemos intentar varios accesos. Si encontramos uno, clearStore() libera
    // todo el InMemoryCache normalizado (es la fuente sospechada del leak real).
    try {
      const candidates = [
        window.__APOLLO_CLIENT__,
        window.apolloClient,
        window.__APOLLO__?.client
      ].filter(Boolean);
      for (const client of candidates) {
        try {
          if (typeof client.clearStore === 'function') {
            client.clearStore().catch(() => {});
            log('Apollo cache clearStore() invocado.');
          } else if (client.cache && typeof client.cache.reset === 'function') {
            client.cache.reset();
            log('Apollo cache reset() invocado.');
          }
        } catch (_) {}
      }
    } catch (_) {}
    // 1.4.24 Fix EE: latch al final del primer call. Próximos ticks del
    // memoryGauge entran al early-return arriba (solo Apollo cleanup silencioso).
    window.__sa_dd_stopped = true;
  }

  // 1.4.20: guardrail anti-OOM. Si el heap pasa 88% del límite, persiste
  // resume y detiene el run con modal pidiendo reload. Mejor un checkpoint
  // limpio que un crash que pierde el step intermedio (STEP 6b/7 no flushean
  // intra-step). El usuario hace Cmd+Shift+R y reanuda desde donde quedó.
  async function triggerMemoryGuardrail(pct) {
    warn(`Memoria al ${pct}% del límite — guardrail dispara cancelRun + modal de reload.`);
    try {
      if (typeof state.flushSentinelBuffer === 'function') {
        try { await state.flushSentinelBuffer(); } catch (_) {}
      }
      if (resumeState) {
        try { await persistResumeState(); } catch (_) {}
      }
      cancelRun();
    } catch (_) {}
    setTimeout(() => {
      if (document.getElementById('sa-mem-guardrail')) return;
      const m = document.createElement('div');
      m.id = 'sa-mem-guardrail';
      m.style.cssText = 'position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;color:#fff;font-family:system-ui;';
      const card = document.createElement('div');
      card.style.cssText = 'background:#1e293b;padding:32px;border-radius:12px;max-width:520px;text-align:center;';
      const h = document.createElement('h2');
      h.style.cssText = 'color:#fca5a5;margin:0 0 16px;';
      h.textContent = `Memoria al ${pct}% — checkpoint forzado`;
      const p1 = document.createElement('p');
      p1.style.cssText = 'margin:0 0 16px;';
      p1.textContent = 'El run se detuvo en checkpoint para evitar crash. Tu progreso está guardado en resume.';
      const p2 = document.createElement('p');
      p2.style.cssText = 'margin:0 0 24px;';
      p2.innerHTML = 'Recarga la tab (Cmd+Shift+R) y abre el bulk-upload para reanudar.';
      const btn = document.createElement('button');
      btn.style.cssText = 'background:#3b82f6;color:#fff;border:0;padding:10px 24px;border-radius:6px;font-size:14px;cursor:pointer;';
      btn.textContent = 'Cerrar';
      btn.onclick = () => m.remove();
      card.appendChild(h); card.appendChild(p1); card.appendChild(p2); card.appendChild(btn);
      m.appendChild(card);
      document.body.appendChild(m);
    }, 500);
  }

  // 1.2.13: sentinel para marcar PNs archivados en el shape extraído de
  // AllPartNumbers. El persisted query no expone archivedAt en su selection
  // set, así que sintetizamos un valor truthy diferenciado de un ISO timestamp
  // real (los callers solo chequean truthy/falsy con `!p.archivedAt`).
  const ARCHIVED_SENTINEL = 'archived';
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let onProgress = () => {};
  function setProgressCallback(fn) { onProgress = fn; }

  // ═══════════════════════════════════════════
  // CONFIG ACCESS (con defaults sanos si config no provee)
  // ═══════════════════════════════════════════

  const bulkCfg = () => {
    // 1.4.7: SteelheadAPI no expone getConfig (sólo getDomain), y __sa_config
    // tampoco existe — el background setea window.REMOTE_CONFIG. Antes esta
    // línea siempre caía a {} y TODO el shape devolvía defaults, lo que dejó
    // muerto el filtro nonFinish y las equivalencias semánticas desde 1.4.3.
    const cfg = window.REMOTE_CONFIG || api()?.getConfig?.() || window.__sa_config || {};
    const d = cfg?.steelhead?.domain?.bulkUpload || {};
    return {
      concurrency: {
        savePartNumber: d.concurrency?.savePartNumber ?? 5,
        archive: d.concurrency?.archive ?? 5,
        // 1.4.8: concurrencia dedicada al STEP 5 (archive de specs sentinel
        // pre-cotización). Más conservadora porque este paso corre antes del
        // chunk loop sobre el universo completo de PNs existentes — en runs
        // de >3k PNs, mantener buffers de SavePartNumber en vuelo dispara
        // OOM del sandbox de Edge/Chrome. Si no se define, cae al default
        // de savePartNumber para retro-compat.
        sentinelPreQuoteArchive: d.concurrency?.sentinelPreQuoteArchive ?? d.concurrency?.savePartNumber ?? 3,
      },
      retry: {
        delaysMs: d.retry?.delaysMs ?? [1000, 2000, 4000],
      },
      paging: {
        allPartNumbersFirst: d.paging?.allPartNumbers?.first ?? 200,
        allPartNumbersMaxResults: d.paging?.allPartNumbers?.maxResults ?? 1000,
      },
      preview: { pageSize: d.preview?.pageSize ?? 100 },
      resume: { maxEntries: d.resume?.maxEntries ?? 20, purgeAgeDays: d.resume?.purgeAgeDays ?? 7 },
      chunking: { defaultChunkSize: d.chunking?.defaultChunkSize ?? 250 },
      // 1.4.6: estos dos faltaban en el shape — sin ellos classifyPNsMassive y
      // los chips de Pase 3 quedaban siempre con nonFinishList=[] y equivIndex
      // vacío, así que SRG no se filtraba y Plata ≠ Plata Flash, contradiciendo
      // lo que el config sí define. Bug introducido en 1.4.3.
      nonFinishLabelNames: Array.isArray(d.nonFinishLabelNames) ? d.nonFinishLabelNames : [],
      metalEquivalents: Array.isArray(d.metalEquivalents) ? d.metalEquivalents : [],
    };
  };

  // ═══════════════════════════════════════════
  // FIX 3 — CANCELLATION TOKEN + STATE
  // ═══════════════════════════════════════════

  class BailError extends Error {
    constructor() { super('__sa_aborted__'); this.name = 'BailError'; }
  }
  const BAIL_MSG = '__sa_aborted__';
  const isBail = (e) => e?.message === BAIL_MSG;
  // 1.2.4: Steelhead devuelve "A record with these details already exists" como
  // user-friendly version del unique_constraint (códigos 23505/duplicate key).
  // Sin este patrón el retry progresivo no se dispara y el error escapa hasta
  // el reporte como falla dura.
  const isDuplicateKeyError = (e) => {
    const s = String(e || '');
    return s.includes('unique_constraint')
      || s.includes('exclusion constraint')
      || s.includes('23505')
      || s.includes('duplicate key')
      || s.includes('A record with these details already exists');
  };

  let state = {
    runId: 0,
    cancelled: false,
    phase: 'idle',
    progress: { current: 0, total: 0 },
    counters: { ok: 0, retried: 0, errors: 0 },
    // 1.2.13: expuestos en state para que el snippet diagnóstico
    // (window.BulkUpload.__state) pueda leerlos sin tener que ser parámetros
    // de execute(). Se rellenan durante execute() y se reinician en nextRunId().
    parts: [],
    pnStatus: [],
    archiveGlobal: true,
    // 1.3.0: chunkSize editable en el preview (solo COTIZACIÓN+NP). El default
    // se lee de bulkCfg().chunking.defaultChunkSize. Se persiste en resumeState
    // para que el restart respete el tamaño elegido en la corrida original.
    chunkSize: null,
    // 1.4.10: ring buffer del log del panel chico — addPanelLog recorta a
    // PANEL_LOG_MAX líneas para evitar OOM en runs largos.
    panelLog: [],
    // 1.4.20: latch del guardrail anti-OOM — una sola vez por run.
    memoryGuardrailFired: false,
  };

  // ── Fix 7: resume tras crash ──
  // El plan original mencionaba chrome.storage.local, pero el applet vive en
  // MAIN world (executeScript world:'MAIN') donde `chrome.*` no se expone de
  // forma confiable. Otros applets del repo (paros-linea, invoice-auto-regen,
  // bill-autofill) usan localStorage para persistencia: misma estrategia aquí.
  // 5MB por origen alcanza de sobra (~9k PN keys ≈ 300KB JSON).
  let resumeState = null;
  const RESUME_KEY_PREFIX = 'sa_bulk_resume_';
  const RESUME_INDEX_KEY = 'sa_bulk_resume_index';

  // 1.2.0 R4: cache de specs por candidato (lazy fetch en preview Pase 3).
  // Vida del cache: el IIFE — sobrevive entre clics del usuario en distintas
  // filas pero no entre reloads de la extensión. Suficiente porque GetPartNumber
  // es estable y el usuario raramente cambia datos del candidato fuera del run.
  const specsCache = new Map(); // pnId → { state: 'loading'|'loaded'|'error', specs: string[], err: string }

  async function computeRunKey(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function loadResumeIndex() {
    try { return JSON.parse(localStorage.getItem(RESUME_INDEX_KEY) || '[]'); } catch { return []; }
  }
  function saveResumeIndex(idx) {
    try { localStorage.setItem(RESUME_INDEX_KEY, JSON.stringify(idx)); } catch (_) {}
  }
  function loadResumeStateByKey(runKey) {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY_PREFIX + runKey) || 'null'); } catch { return null; }
  }
  function deleteResumeStateByKey(runKey) {
    try { localStorage.removeItem(RESUME_KEY_PREFIX + runKey); } catch (_) {}
    const idx = loadResumeIndex().filter(e => e.runKey !== runKey);
    saveResumeIndex(idx);
  }

  function purgeOldResumeStates() {
    try {
      const cfg = bulkCfg().resume;
      const maxAge = (cfg.purgeAgeDays || 7) * 24 * 60 * 60 * 1000;
      const maxEntries = cfg.maxEntries || 20;
      const now = Date.now();
      const idx = loadResumeIndex();
      const keep = [];
      for (const entry of idx) {
        const age = now - new Date(entry.lastUpdatedAt || 0).getTime();
        if (entry.phase === 'done' && age > maxAge) {
          try { localStorage.removeItem(RESUME_KEY_PREFIX + entry.runKey); } catch (_) {}
        } else {
          keep.push(entry);
        }
      }
      // Cap por número de entradas (más viejas primero)
      if (keep.length > maxEntries) {
        keep.sort((a, b) => new Date(b.lastUpdatedAt || 0) - new Date(a.lastUpdatedAt || 0));
        const drop = keep.splice(maxEntries);
        for (const d of drop) try { localStorage.removeItem(RESUME_KEY_PREFIX + d.runKey); } catch (_) {}
      }
      saveResumeIndex(keep);
    } catch (_) { /* persistencia es best-effort */ }
  }

  async function persistResumeState() {
    if (!resumeState) return;
    resumeState.lastUpdatedAt = new Date().toISOString();
    try {
      localStorage.setItem(RESUME_KEY_PREFIX + resumeState.runKey, JSON.stringify(resumeState));
      const idx = loadResumeIndex().filter(e => e.runKey !== resumeState.runKey);
      idx.push({ runKey: resumeState.runKey, lastUpdatedAt: resumeState.lastUpdatedAt, phase: resumeState.phase });
      saveResumeIndex(idx);
    } catch (e) {
      // Si localStorage está lleno, deshabilitar resume en silencio para esta corrida.
      console.warn('[bulk-upload] persistResumeState falló (storage lleno?):', e?.message || e);
    }
  }

  function askResumeOrFresh(prev) {
    return new Promise(resolve => {
      injectStyles(); const { overlay, modal } = createOverlay();
      const completed = (prev.completedPNs || []).length;
      const failed = (prev.failedPNs || []).length;
      const since = prev.lastUpdatedAt ? new Date(prev.lastUpdatedAt).toLocaleString() : '(desconocido)';
      modal.innerHTML = `
        <h2>Corrida previa detectada</h2>
        <p class="dl9-sub">Este mismo CSV se intentó procesar antes. Puedes reanudar desde donde quedó o empezar de cero.</p>
        <div class="dl9-stats">
          <div class="dl9-stat"><b>Modo:</b> ${prev.mode || '?'}</div>
          <div class="dl9-stat"><b>Fase actual:</b> ${prev.phase || '?'}</div>
          <div class="dl9-stat"><b>PNs completados:</b> ${completed}</div>
          <div class="dl9-stat"><b>PNs con error:</b> ${failed}</div>
          <div class="dl9-stat"><b>Cliente(s):</b> ${prev.customerScope || '?'}</div>
          <div class="dl9-stat"><b>Última actualización:</b> ${since}</div>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-resume-cancel">CANCELAR</button>
          <button class="dl9-btn" id="dl9-resume-fresh" style="background:#475569;color:#e2e8f0">EMPEZAR DE CERO</button>
          <button class="dl9-btn dl9-btn-exec" id="dl9-resume-yes" style="background:#0d9488;color:white">REANUDAR</button>
        </div>`;
      modal.querySelector('#dl9-resume-yes').onclick = () => { removeOverlay(overlay); resolve('resume'); };
      modal.querySelector('#dl9-resume-fresh').onclick = () => { removeOverlay(overlay); resolve('fresh'); };
      modal.querySelector('#dl9-resume-cancel').onclick = () => { removeOverlay(overlay); resolve('cancel'); };
    });
  }

  function nextRunId() {
    state = {
      runId: (state?.runId || 0) + 1,
      cancelled: false,
      phase: 'init',
      progress: { current: 0, total: 0 },
      counters: { ok: 0, retried: 0, errors: 0 },
      parts: [],
      pnStatus: [],
      archiveGlobal: true,
      chunkSize: null,
      panelLog: [],
      memoryGuardrailFired: false,
    };
    return state.runId;
  }
  function isStale(myRunId) { return !state || state.cancelled || state.runId !== myRunId; }
  function bailIfStale(myRunId) { if (isStale(myRunId)) throw new BailError(); }
  function cancelRun() {
    if (!state || state.cancelled) return;
    state.cancelled = true;
    state.phase = 'cancelled';
    // 1.4.9: persistir cancelled en localStorage. Antes (≤1.4.8) solo se cambiaba
    // state.phase (memoria) — el resumeState quedaba con phase del último checkpoint
    // (o 'init' si nunca se completó STEP 6). Esto distorsionaba el modal de resume
    // que mostraba "Fase actual: init" para corridas que ya habían avanzado hasta
    // STEP 6b o más. fire-and-forget para no bloquear el repintado del panel.
    if (resumeState) {
      resumeState.phase = 'cancelled';
      // 1.4.14 Fix Z: flush del buffer de sentinels archivados ANTES de persistir
      // el cancel. Antes (1.4.13) el cancel mid-STEP-5 dejaba en limbo todos los
      // pnIds ya archivados en el server pero aún en el buffer in-memory; al
      // reanudar, archivedSentinelsPreQuote quedaba vacío y se re-procesaban
      // 800-2800 items idempotentes (caros).
      if (typeof state.flushSentinelBuffer === 'function') {
        try { state.flushSentinelBuffer(); } catch (_) {}
      }
      persistResumeState().catch(() => {});
    }
    // 1.2.2: pintar el panel como Cancelado inmediatamente sin esperar al
    // próximo bailIfStale. Antes el panel quedaba "esperando..." durante
    // segundos hasta que algún loop pegaba a un bailIfStale; el usuario lo
    // percibía como colgado. Ahora el panel reacciona al instante: botón
    // Detener desaparece, aparece Cerrar y el usuario puede salir aunque
    // queden requests en vuelo terminando en background (los catch/finally
    // se ejecutan igual cuando regresen).
    const p = document.getElementById('sa-bu-panel');
    if (p) {
      p.classList.remove('sa-error', 'sa-done');
      p.classList.add('sa-cancelled');
      setPanelPhase('Cancelado — requests en vuelo terminarán en background');
      const stopBtn = p.querySelector('#sa-bu-stop');
      if (stopBtn) stopBtn.style.display = 'none';
      const closeBtn = p.querySelector('#sa-bu-close');
      if (closeBtn) closeBtn.style.display = 'inline-block';
    }
    addPanelLog('⏹ Cancelado. Puedes cerrar el panel — el resume guardado permite reanudar después.');
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ═══════════════════════════════════════════
  // FIX 5 — withRetry con backoff [1s, 2s, 4s] que respeta cancelación
  // Solo reintenta en 429/503/network errors. unique_constraint NO se reintenta
  // (la lógica progresiva ad-hoc en SavePartNumber sigue aplicando).
  // ═══════════════════════════════════════════

  const RETRYABLE_PATTERNS = [
    /\b429\b/, /\b503\b/, /\b502\b/, /\b504\b/,
    /too many requests/i, /service unavailable/i, /gateway/i,
    /failed to fetch/i, /network/i, /timeout/i, /ECONN/i,
  ];
  function isRetryable(err) {
    const msg = String(err?.message || err || '');
    if (msg.includes('unique_constraint') || msg.includes('23505') || msg.includes('duplicate key')) return false;
    if (msg.includes('exclusion constraint') || msg.includes('23P01')) return false;
    return RETRYABLE_PATTERNS.some(re => re.test(msg));
  }

  async function withRetry(fn, label, myRunId, delaysMs) {
    const delays = delaysMs || bulkCfg().retry.delaysMs;
    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (myRunId != null) bailIfStale(myRunId);
      try { return await fn(); }
      catch (err) {
        if (isBail(err)) throw err;
        lastErr = err;
        const more = attempt < delays.length && isRetryable(err);
        if (!more) throw err;
        state.counters.retried++;
        const delay = delays[attempt];
        warn(`${label}: intento ${attempt + 1} falló (${String(err).substring(0, 80)}), reintentando en ${delay}ms`);
        if (myRunId != null) bailIfStale(myRunId);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  // ═══════════════════════════════════════════
  // FIX 1 / FIX 6 — runPool: pool concurrente con semáforo + cancellation
  // ═══════════════════════════════════════════

  async function runPool(items, worker, concurrency, onProgressCb, myRunId) {
    const queue = items.slice();
    let active = 0, done = 0, idx = 0;
    const total = queue.length;
    return new Promise((resolve) => {
      function next() {
        if (state.cancelled || isStale(myRunId)) {
          if (active === 0) resolve();
          return;
        }
        while (active < concurrency && idx < queue.length) {
          const item = queue[idx];
          const myIdx = idx;
          idx++;
          active++;
          Promise.resolve()
            .then(() => worker(item, myIdx, myRunId))
            .catch(err => {
              if (!isBail(err)) {
                state.counters.errors++;
                warn(`runPool[${myIdx}]: ${String(err).substring(0, 120)}`);
              }
            })
            .finally(() => {
              active--; done++;
              if (onProgressCb) {
                try { onProgressCb(done, total); } catch (_) {}
              }
              if ((state.cancelled || isStale(myRunId)) && active === 0) { resolve(); return; }
              if (done >= queue.length && active === 0) resolve();
              else next();
            });
        }
      }
      if (!queue.length) resolve();
      else next();
    });
  }

  // ═══════════════════════════════════════════
  // FIX 3 — Panel flotante con barra de progreso + botón Detener
  // ═══════════════════════════════════════════

  function ensurePanelStyles() {
    if (document.getElementById('sa-bu-panel-styles')) return;
    const s = document.createElement('style'); s.id = 'sa-bu-panel-styles';
    s.textContent = `
      #sa-bu-panel{position:fixed;top:20px;right:20px;width:480px;max-height:80vh;background:#1e293b;color:#e2e8f0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;z-index:100000;display:flex;flex-direction:column;overflow:hidden}
      #sa-bu-panel .sa-hdr{padding:14px 18px;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center}
      #sa-bu-panel .sa-hdr h3{margin:0;font-size:14px;color:#38bdf8;font-weight:600}
      #sa-bu-panel .sa-hdr .sa-meta{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:11px;color:#64748b}
      #sa-bu-panel .sa-hdr .sa-ver{font-size:11px;color:#64748b}
      #sa-bu-panel .sa-hdr .sa-mem{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:#64748b}
      #sa-bu-panel .sa-hdr .sa-mem.sa-mem-warn{color:#f59e0b}
      #sa-bu-panel .sa-hdr .sa-mem.sa-mem-crit{color:#f87171;font-weight:600}
      #sa-bu-panel .sa-body{padding:14px 18px;overflow-y:auto;flex:1;font-size:13px}
      #sa-bu-panel .sa-phase{font-size:13px;color:#e2e8f0;font-weight:500;margin-bottom:2px}
      #sa-bu-panel .sa-subphase{font-size:11px;color:#94a3b8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:6px;min-height:14px}
      #sa-bu-panel .sa-stats{display:flex;gap:12px;margin-bottom:8px;font-size:12px;color:#94a3b8}
      #sa-bu-panel .sa-stats span b{color:#38bdf8;font-weight:600}
      #sa-bu-panel .sa-bar{height:6px;background:#0f172a;border-radius:3px;overflow:hidden;margin-bottom:10px}
      #sa-bu-panel .sa-bar-fill{height:100%;background:linear-gradient(90deg,#2563eb,#38bdf8);width:0%;transition:width 0.25s}
      #sa-bu-panel .sa-log{max-height:200px;overflow-y:auto;font-size:11px;color:#94a3b8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f172a;border-radius:6px;padding:8px 10px;white-space:pre-wrap;line-height:1.5}
      #sa-bu-panel .sa-actions{padding:10px 18px;border-top:1px solid #334155;display:flex;justify-content:flex-end;gap:8px}
      #sa-bu-panel .sa-btn{padding:7px 14px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity 0.2s}
      #sa-bu-panel .sa-btn:hover{opacity:0.85}
      #sa-bu-panel .sa-btn-stop{background:#dc2626;color:white}
      #sa-bu-panel .sa-btn-close{background:#475569;color:#e2e8f0}
      #sa-bu-panel.sa-cancelled .sa-phase{color:#f59e0b}
      #sa-bu-panel.sa-error .sa-phase{color:#f87171}
      #sa-bu-panel.sa-done .sa-phase{color:#4ade80}
    `;
    document.head.appendChild(s);
  }

  function ensurePanel() {
    let p = document.getElementById('sa-bu-panel');
    if (p) return p;
    ensurePanelStyles();
    p = document.createElement('div');
    p.id = 'sa-bu-panel';
    p.innerHTML = `
      <div class="sa-hdr">
        <h3>Carga masiva — Steelhead Automator</h3>
        <div class="sa-meta">
          <span class="sa-ver">v${VERSION}</span>
          <span class="sa-mem" id="sa-bu-mem" title="Memoria JS del tab (Chrome/Edge)"></span>
        </div>
      </div>
      <div class="sa-body">
        <div class="sa-phase" id="sa-bu-phase">Inicializando...</div>
        <div class="sa-subphase" id="sa-bu-subphase"></div>
        <div class="sa-stats">
          <span><b id="sa-bu-current">0</b>/<span id="sa-bu-total">0</span></span>
          <span>OK: <b id="sa-bu-ok">0</b></span>
          <span>Reintentos: <b id="sa-bu-retried">0</b></span>
          <span>Errores: <b id="sa-bu-errors">0</b></span>
        </div>
        <div class="sa-bar"><div class="sa-bar-fill" id="sa-bu-bar"></div></div>
        <div class="sa-log" id="sa-bu-log"></div>
      </div>
      <div class="sa-actions">
        <button class="sa-btn sa-btn-stop" id="sa-bu-stop">Detener</button>
        <button class="sa-btn sa-btn-close" id="sa-bu-close" style="display:none">Cerrar</button>
      </div>`;
    document.body.appendChild(p);
    p.querySelector('#sa-bu-stop').onclick = () => {
      if (confirm('¿Detener la corrida? Las requests en vuelo seguirán hasta terminar, pero no se enviarán más.')) {
        cancelRun();
      }
    };
    p.querySelector('#sa-bu-close').onclick = () => hidePanel();
    return p;
  }

  function showPanel() { ensurePanel().style.display = 'flex'; startMemoryGauge(); }
  function hidePanel() {
    stopMemoryGauge();
    const p = document.getElementById('sa-bu-panel');
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  // 1.4.11: medidor de memoria del tab. performance.memory (Chrome/Edge) reporta
  // usedJSHeapSize y jsHeapSizeLimit en bytes. Polling cada 2s — lectura nativa
  // sin costo medible. Alerta amarilla a >70% del límite y roja a >85%.
  // Sin performance.memory (Firefox/Safari) el span queda en blanco.
  let memoryGaugeTimer = null;
  function startMemoryGauge() {
    if (memoryGaugeTimer) return;
    if (!(performance && performance.memory)) return;
    const tick = () => {
      const el = document.getElementById('sa-bu-mem'); if (!el) return;
      const used = performance.memory.usedJSHeapSize;
      const limit = performance.memory.jsHeapSizeLimit;
      const usedMB = Math.round(used / 1024 / 1024);
      const limitMB = Math.round(limit / 1024 / 1024);
      const pct = limit > 0 ? Math.round(used / limit * 100) : 0;
      el.textContent = `Mem: ${usedMB}MB / ${limitMB}MB (${pct}%)`;
      el.classList.remove('sa-mem-warn', 'sa-mem-crit');
      if (pct >= 85) el.classList.add('sa-mem-crit');
      else if (pct >= 70) el.classList.add('sa-mem-warn');
      // 1.4.20: re-aplicar stop de Datadog cada tick (defensa por si el SDK
      // se re-inicializa). Idempotente y barato — solo invoca stop API si
      // sigue presente. El monkey-patch de fetch se aplica una sola vez.
      if (pct >= 70) stopDatadogSessionReplay();
      // 1.4.20: guardrail anti-OOM a 88%.
      if (pct >= 88 && !state.memoryGuardrailFired) {
        state.memoryGuardrailFired = true;
        triggerMemoryGuardrail(pct);
      }
    };
    tick();
    memoryGaugeTimer = setInterval(tick, 2000);
  }
  function stopMemoryGauge() {
    if (memoryGaugeTimer) { clearInterval(memoryGaugeTimer); memoryGaugeTimer = null; }
  }

  // 1.4.10: panel chico es la única UI de progreso. Tamaño del ring buffer del log
  // — chico para que el textContent del DOM no crezca sin pausa y agote el renderer.
  const PANEL_LOG_MAX = 200;

  function setPanelPhase(text) {
    state.phase = text;
    const el = document.getElementById('sa-bu-phase'); if (el) el.textContent = text;
    // 1.4.10: limpiar sub-fase cuando cambia la fase principal (la sub-fase es
    // propia del step actual y no debe arrastrarse al siguiente).
    setPanelSubPhase('');
  }
  // 1.4.10: línea fina debajo de la fase principal. La usan los workers de
  // runPool en pasos largos (enrich, sync, racks, archive) para mostrar qué
  // tipo de operación se ejecuta en este momento ("specs", "racks", "labels",
  // "params"…) sin inundar el log.
  function setPanelSubPhase(text) {
    const el = document.getElementById('sa-bu-subphase'); if (el) el.textContent = text || '';
  }
  function setPanelProgress(current, total) {
    state.progress.current = current;
    state.progress.total = total;
    const c = document.getElementById('sa-bu-current');
    const t = document.getElementById('sa-bu-total');
    const bar = document.getElementById('sa-bu-bar');
    if (c) c.textContent = String(current);
    if (t) t.textContent = String(total);
    if (bar) bar.style.width = (total ? Math.round((current / total) * 100) : 0) + '%';
  }
  function setPanelCounters() {
    const o = document.getElementById('sa-bu-ok'); if (o) o.textContent = String(state.counters.ok);
    const r = document.getElementById('sa-bu-retried'); if (r) r.textContent = String(state.counters.retried);
    const e = document.getElementById('sa-bu-errors'); if (e) e.textContent = String(state.counters.errors);
  }
  function addPanelLog(msg) {
    const ts = new Date().toTimeString().slice(0, 8);
    if (!state.panelLog) state.panelLog = [];
    state.panelLog.push(`[${ts}] ${msg}`);
    // 1.4.10: recortar para evitar crecimiento ilimitado del textContent en runs
    // largos (10k+ batches). Pre-1.4.10 el modal grande acumulaba TODO el log y
    // tronaba la pestaña por OOM (SBOX_FATAL_MEMORY_EXCEEDED) cerca del final.
    if (state.panelLog.length > PANEL_LOG_MAX) {
      state.panelLog = state.panelLog.slice(-PANEL_LOG_MAX);
    }
    const el = document.getElementById('sa-bu-log');
    if (!el) return;
    el.textContent = state.panelLog.join('\n') + '\n';
    el.scrollTop = el.scrollHeight;
  }
  function markPanelDone(success, errorMsg) {
    const p = document.getElementById('sa-bu-panel'); if (!p) return;
    p.classList.remove('sa-cancelled', 'sa-error', 'sa-done');
    if (errorMsg) { p.classList.add('sa-error'); setPanelPhase('ERROR: ' + errorMsg); }
    else if (state.cancelled) { p.classList.add('sa-cancelled'); setPanelPhase('Cancelado'); }
    else if (success) { p.classList.add('sa-done'); setPanelPhase('Completado'); }
    const stopBtn = p.querySelector('#sa-bu-stop'); if (stopBtn) stopBtn.style.display = 'none';
    const closeBtn = p.querySelector('#sa-bu-close'); if (closeBtn) closeBtn.style.display = 'inline-block';
  }

  // ═══════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════

  const toBool = (v) => { const s = (v || '').toString().trim().toUpperCase(); return s === 'SI' || s === 'SÍ' || s === 'YES' || s === '1' || s === 'TRUE' || s === 'V' || s === 'VERDADERO'; };
  const isoDate = (d) => { const dt = new Date(); dt.setDate(dt.getDate() + d); return dt.toISOString(); };
  const g = (row, i) => {
    const v = (row[i] || '').trim().replace(/\s+/g, ' ');
    // V10: dropdowns prepend "(seleccione)" / "(seleccione o escriba)" — tratarlos como vacío
    if (v === '(seleccione)' || v === '(seleccione o escriba)') return '';
    return v;
  };
  const gn = (row, i) => { const v = parseFloat(g(row, i)); return isNaN(v) ? null : v; };

  const PRICE_UNIT_MAP = { PZA: null, KGM: 3969, CMK: 4907, FTK: 4797, LM: 5150, LBR: 3972, LO: 5348 };

  // V10 Predictive material columns: BB=53 (Plata) to BJ=61 (Epóx MTR)
  const PREDICTIVE_MATERIALS = [
    { col: 53, inventoryItemId: 364506, name: 'Plata Fina' },
    { col: 54, inventoryItemId: 397490, name: 'Estaño Puro' },
    { col: 55, inventoryItemId: 412305, name: 'Níquel Metálico' },
    { col: 56, inventoryItemId: 412805, name: 'Zinc Metálico' },
    { col: 57, inventoryItemId: 412479, name: 'Placa de Cobre Electrolítico' },
    { col: 58, inventoryItemId: 412723, name: 'Sterlingshield S (Antitarnish)' },
    { col: 59, inventoryItemId: 702767, name: 'Epoxy MT' },
    { col: 60, inventoryItemId: 702769, name: 'Epoxica BT' },
    { col: 61, inventoryItemId: 702768, name: 'Epoxica MT Red' },
  ];

  const DIVISA_SCHEMA = { type: "object", title: "", required: ["DatosPrecio"], properties: { DatosPrecio: { type: "object", title: "Datos del Precio", required: ["Divisa"], properties: { Divisa: { enum: ["USD", "MXN"], type: "string", title: "Divisa", enumNames: ["USD - Dolar americano", "MXN - Peso mexicano"] } }, dependencies: {} } }, dependencies: {} };
  const DIVISA_UI = { "ui:order": ["DatosPrecio"], DatosPrecio: { "ui:order": ["Divisa"], Divisa: { "ui:title": "Divisa" } } };

  // V10: Cliente, Divisa, Proceso (default) ya no van en el header
  const HEADER_KEYS = {
    'modo': 'modo',
    'nombre cotizacion': 'quoteName', 'nombre cotización': 'quoteName',
    'nombre cotizacion/layout': 'quoteName', 'nombre cotización/layout': 'quoteName',
    'empresa emisora': 'empresaEmisora',
    'notas externas': 'notasExternas',
    'notas internas': 'notasInternas',
    'asignado': 'asignado',
    'valida hasta (dias)': 'validaDias', 'válida hasta (días)': 'validaDias',
  };

  // ═══════════════════════════════════════════
  // CSV PARSER
  // ═══════════════════════════════════════════

  function parseCSV(t) {
    const rows = []; let i = 0;
    while (i < t.length) {
      const row = [];
      while (i < t.length) {
        if (t[i] === '"') {
          i++; let v = '';
          while (i < t.length) {
            if (t[i] === '"') { if (t[i + 1] === '"') { v += '"'; i += 2; } else { i++; break; } }
            else { v += t[i]; i++; }
          }
          row.push(v);
        } else {
          let v = '';
          while (i < t.length && t[i] !== ',' && t[i] !== '\r' && t[i] !== '\n') { v += t[i]; i++; }
          row.push(v);
        }
        if (t[i] === ',') { i++; continue; } else break;
      }
      if (t[i] === '\r') i++;
      if (t[i] === '\n') i++;
      rows.push(row);
    }
    return rows;
  }

  function parseRows(rows) {
    // V10 column indices (0-indexed)
    // A=0 Archivado | B=1 Validación | C=2 Forzar | D=3 Archivar
    // E=4 Cliente | F=5 PN | G=6 Descripción | H=7 PN alterno | I=8 Grupo
    // J=9 Cantidad | K=10 Precio | L=11 Unidad precio | M=12 Divisa | N=13 Precio default
    // O=14 Metal base | P=15 Etq1 | Q=16 Etq2 | R=17 Etq3 | S=18 Etq4 | T=19 Etq5
    // U=20 Proceso | V=21 Prod1 | W=22 Pre1 | X=23 Cnt1 | Y=24 Uni1
    // Z=25 Prod2 | AA=26 Pre2 | AB=27 Cnt2 | AC=28 Uni2
    // AD=29 Prod3 | AE=30 Pre3 | AF=31 Cnt3 | AG=32 Uni3
    // AH=33 Spec1 | AI=34 Esp1 µm | AJ=35 Spec2 | AK=36 Esp2 µm
    // AL=37 KGM | AM=38 CMK | AN=39 LM | AO=40 MinPzasLote
    // AP=41 Rack Línea | AQ=42 Pzas R.L. | AR=43 Rack Sec | AS=44 Pzas R.S.
    // AT=45 Long | AU=46 Ancho | AV=47 Alto | AW=48 D.Ext | AX=49 D.Int
    // AY=50 Línea | AZ=51 Departamento | BA=52 Código SAT
    // BB-BJ=53-61 Predictivos | BK=62 QuoteIBMS | BL=63 EstacionIBMS | BM=64 Plano
    // BN=65 PiezasCarga | BO=66 CargasHora | BP=67 TiempoEntrega | BQ=68 Notas adicionales
    const header = {};
    const parts = [];
    // V10 special case: Modo se exporta como valor pelado (sin label) en G1 / row 0 col 6
    // Buscar COTIZACIÓN+NP / SOLO_PN en las primeras 3 filas
    for (let r = 0; r < Math.min(rows.length, 3); r++) {
      for (const cell of rows[r]) {
        const v = (cell || '').trim().toUpperCase();
        if (v === 'COTIZACIÓN+NP' || v === 'COTIZACION+NP' || v === 'SOLO_PN' || v === 'SOLO PN') {
          header.modo = v;
          break;
        }
      }
      if (header.modo) break;
    }
    for (const row of rows) {
      // V10: el header tiene MÚLTIPLES pares clave-valor por fila
      // Escanear TODAS las celdas buscando labels conocidos; el valor está en la siguiente celda no vacía
      let isHeaderRow = false;
      for (let c = 0; c < row.length; c++) {
        const cell = (row[c] || '').trim();
        if (!cell) continue;
        const keyAcc = cell.replace(/:$/, '').trim().toLowerCase();
        const keyNorm = keyAcc.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const hk = HEADER_KEYS[keyAcc] || HEADER_KEYS[keyNorm];
        if (!hk) continue;
        // Buscar el valor en las siguientes 1-4 celdas a la derecha
        for (let d = 1; d <= 4; d++) {
          const v = (row[c + d] || '').trim();
          if (v) { header[hk] = v; isHeaderRow = true; break; }
        }
      }
      if (isHeaderRow) continue;

      // V10: Skip section/column-header/type-indicator rows
      // Row 6: section headers ("PARÁMETROS", "IDENTIFICACIÓN", "PRECIO", etc.) — col A is non-empty
      // Row 7: column headers ("Archivado", "Cliente", "Número de\nparte", etc.) — col A = "Archivado"
      // Row 8: type indicators ("V/F", "Texto", "#", "$", "Desp.")  — col A = "V/F"
      const colA = (row[0] || '').trim();
      const colF = (row[5] || '').trim();
      if (colA === 'PARÁMETROS' || colA === 'Archivado' || colA === 'V/F') continue;
      // Also skip if col F is a literal column-header text (e.g. "Número de\nparte" or "Texto")
      if (colF === 'Texto' || colF.replace(/\s+/g, ' ').toLowerCase() === 'número de parte') continue;

      const pn = g(row, 5); // F=5
      const qty = gn(row, 9); // J=9
      if (!pn) continue;

      const products = [];
      // V=21(P1), Z=25(P2), AD=29(P3); each followed by Price, Qty, Unit
      for (const b of [21, 25, 29]) {
        const nm = g(row, b);
        if (nm) products.push({ name: nm, price: gn(row, b + 1) || 0, qty: gn(row, b + 2) || 1, unit: g(row, b + 3) });
      }

      const specs = [];
      // AH=33(Spec1) AI=34(Esp1) ; AJ=35(Spec2) AK=36(Esp2)
      for (const [specIdx /*, espIdx */] of [[33, 34], [35, 36]]) {
        const raw = g(row, specIdx);
        if (!raw) continue;
        if (raw.includes(' | ')) { const s = raw.indexOf(' | '); specs.push({ name: raw.substring(0, s).trim(), param: raw.substring(s + 3).trim() }); }
        else specs.push({ name: raw, param: '' });
      }

      const racks = [];
      // AP=41 Rack Línea, AQ=42 Pzas; AR=43 Rack Sec, AS=44 Pzas
      if (g(row, 41)) racks.push({ name: g(row, 41), ppr: gn(row, 42) });
      if (g(row, 43)) racks.push({ name: g(row, 43), ppr: gn(row, 44) });

      const predictiveUsage = [];
      // 1.3.1: sentinel "-" granular por material. Cada celda BB..BJ se evalúa en crudo:
      //   * "-" → placeholder usagePerPart='-' (STEP 6a lo manda con microQuantityPerPart=0
      //     vía UpdateInventoryItemPredictedUsage para "archivar" ese predictivo individual)
      //   * número > 0 → upsert ese predictivo
      //   * vacío → no tocar
      // Antes (1.2.12-1.3.0) solo BB=`-` actuaba como wildcard "borrar todos" y `-` en otras
      // columnas se ignoraba porque gn() colapsa "-"→null igual que celda vacía. El wildcard
      // se quita: para borrar todos, pone `-` en cada columna que aplique.
      for (const mat of PREDICTIVE_MATERIALS) {
        const raw = g(row, mat.col);
        if (raw === '-') {
          predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: '-', name: mat.name });
        } else {
          const val = gn(row, mat.col);
          if (val !== null && val > 0) {
            predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: String(val), name: mat.name });
          }
        }
      }

      parts.push({
        pn, qty,
        cliente: g(row, 4),                     // E=4 NEW per-line customer
        precio: gn(row, 10),                    // K=10
        unidadPrecio: g(row, 11).toUpperCase(), // L=11
        // 1.2.6: VBA exporta '-' como sentinel "borrar / default". `-` es truthy,
        // así que `|| 'USD'` no aplica y se enviaba `Divisa: '-'` al server, que
        // falla la enum ["USD","MXN"] y el campo queda vacío en el PN.
        divisa: (() => { const v = g(row, 12); return (v && v !== '-') ? v.toUpperCase() : 'USD'; })(), // M=12
        precioDefault: toBool(g(row, 13)),      // N=13
        descripcion: g(row, 6),                 // G=6
        pnAlterno: g(row, 7),                   // H=7
        pnGroup: g(row, 8),                     // I=8
        metalBase: g(row, 14),                  // O=14
        labels: [g(row, 15), g(row, 16), g(row, 17), g(row, 18), g(row, 19)].filter(Boolean), // P-T (5 labels)
        procesoOverride: g(row, 20),            // U=20 NOW REQUIRED (no header default)
        products, specs,
        unitConv: { kgm: gn(row, 37), cmk: gn(row, 38), lm: gn(row, 39), minPzasLote: gn(row, 40) }, // AL-AO
        racks,
        dims: { length: gn(row, 45), width: gn(row, 46), height: gn(row, 47), outerDiam: gn(row, 48), innerDiam: gn(row, 49) }, // AT-AX
        linea: g(row, 50),                      // AY=50
        departamento: g(row, 51),               // AZ=51
        codigoSAT: g(row, 52),                  // BA=52
        archivado: toBool(g(row, 0)),
        forzarDuplicado: toBool(g(row, 2)),
        archivarAnterior: toBool(g(row, 3)),
        validacion1er: toBool(g(row, 1)),
        predictiveUsage,
        quoteIBMS: g(row, 62),                  // BK=62
        estacionIBMS: g(row, 63),               // BL=63
        plano: g(row, 64),                      // BM=64
        piezasCarga: gn(row, 65),               // BN=65
        cargasHora: g(row, 66),                 // BO=66
        tiempoEntrega: gn(row, 67),             // BP=67
        notasAdicionalesPN: g(row, 68),         // BQ=68
      });
    }
    return { header, parts };
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════

  let unitNodes = [];
  const resolveUnitId = (abbr) => {
    if (!abbr) return null;
    const u = abbr.toUpperCase().trim();
    const m = unitNodes.find(x => x.name.toUpperCase().startsWith(u + ' ') || x.name.toUpperCase() === u);
    if (m) return m.id;
    const f = unitNodes.find(x => x.name.toUpperCase().includes(u));
    if (f) return f.id;
    warn(`Unit "${abbr}" no encontrada.`);
    return null;
  };

  function buildDimensions(dims, DOMAIN) {
    const out = [];
    const map = [['length', DOMAIN.geometryDimensions.LENGTH], ['width', DOMAIN.geometryDimensions.WIDTH], ['height', DOMAIN.geometryDimensions.HEIGHT], ['outerDiam', DOMAIN.geometryDimensions.OUTER_DIAM], ['innerDiam', DOMAIN.geometryDimensions.INNER_DIAM]];
    for (const [key, id] of map) {
      if (dims[key] !== null && dims[key] !== undefined) out.push({ geometryTypeDimensionTypeId: id, unitId: DOMAIN.unitIds.MTR, dimensionValue: dims[key] });
    }
    return out;
  }

  // Guión (-) comodín: vacío = no tocar, valor = sobrescribir, "-" = borrar
  const isDash = (v) => v === '-';
  const resolveStr = (raw, existing) => {
    if (raw === '' || raw === undefined) return existing; // no tocar
    if (isDash(raw)) return ''; // borrar
    return raw; // sobrescribir
  };
  const resolveNum = (raw, existing) => {
    if (raw === null || raw === undefined) return existing;
    if (typeof raw === 'string' && isDash(raw)) return null;
    return raw;
  };

  function mergeCustomInputs(existing, part) {
    const ci = existing ? JSON.parse(JSON.stringify(existing)) : {};

    // 1.2.12: el campo MontoMinimo se removió del esquema; borrar siempre del legacy.
    if (ci.DatosPlanificacion && 'montoMinimo' in ci.DatosPlanificacion) {
      delete ci.DatosPlanificacion.montoMinimo;
    }
    if (ci.DatosPlanificacion && 'MontoMinimo' in ci.DatosPlanificacion) {
      delete ci.DatosPlanificacion.MontoMinimo;
    }

    // DatosFacturacion
    if (part.codigoSAT) {
      if (!ci.DatosFacturacion) ci.DatosFacturacion = {};
      ci.DatosFacturacion.CodigoSAT = isDash(part.codigoSAT) ? '' : part.codigoSAT;
    }

    // DatosAdicionalesNP
    if (part.metalBase || part.pnAlterno || part.quoteIBMS || part.estacionIBMS || part.plano) {
      if (!ci.DatosAdicionalesNP) ci.DatosAdicionalesNP = {};
      if (part.metalBase) ci.DatosAdicionalesNP.BaseMetal = isDash(part.metalBase) ? '' : part.metalBase;
      if (part.pnAlterno) {
        ci.DatosAdicionalesNP.NumeroParteAlterno = isDash(part.pnAlterno)
          ? [] : part.pnAlterno.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (part.quoteIBMS) ci.DatosAdicionalesNP.QuoteIBMS = isDash(part.quoteIBMS) ? '' : part.quoteIBMS;
      if (part.estacionIBMS) ci.DatosAdicionalesNP.EstacionIBMS = isDash(part.estacionIBMS) ? '' : part.estacionIBMS;
      if (part.plano) ci.DatosAdicionalesNP.Plano = isDash(part.plano) ? '' : part.plano;
    }

    // DatosPlanificacion
    if (part.piezasCarga !== null || part.cargasHora || part.tiempoEntrega !== null) {
      if (!ci.DatosPlanificacion) ci.DatosPlanificacion = {};
      if (part.piezasCarga !== null) ci.DatosPlanificacion.PiezasCarga = isDash(String(part.piezasCarga)) ? null : part.piezasCarga;
      if (part.cargasHora) ci.DatosPlanificacion.CargasHora = isDash(part.cargasHora) ? '' : part.cargasHora;
      if (part.tiempoEntrega !== null) ci.DatosPlanificacion.TiempoEntrega = isDash(String(part.tiempoEntrega)) ? null : part.tiempoEntrega;
    }

    // NotasAdicionales (top level in customInputs)
    if (part.notasAdicionalesPN) {
      ci.NotasAdicionales = isDash(part.notasAdicionalesPN) ? '' : part.notasAdicionalesPN;
    }

    return Object.keys(ci).length > 0 ? ci : null;
  }

  // ─── Prefetch global de PNs (modo masivo del dedup 1.1.0) ───
  // Pagina AllPartNumbers SIN searchQuery (catálogo completo del dominio) y
  // agrupa client-side por customerId. customerIds es un Set para filtrar el
  // output — PNs cuyo cliente no esté en customerIds se descartan para
  // ahorrar memoria (un dominio puede tener 50k+ PNs).
  // Costo: ~N/200 queries para un dominio de N PNs (~250 para 50k).
  // Solo conviene cuando |CSV| > massiveThreshold (typically 1000). En CSV
  // chico, classifyPNs sigue el patrón on-demand de 1.0.0.
  async function prefetchPNsByCustomer(customerIds, myRunId) {
    const cfg = bulkCfg();
    const pageSize = cfg.paging?.allPartNumbers?.first || 200;
    const maxResults = cfg.paging?.allPartNumbers?.massiveMaxResults || 100000;
    const customerSet = new Set(customerIds);
    const result = new Map();
    for (const cid of customerSet) result.set(cid, []);
    // 1.2.13: el persisted query de AllPartNumbers NO devuelve archivedAt en su
    // selection set (verificado en consola 2026-05-21 — la respuesta solo trae
    // nodeId/id/createdAt/name/... sin archivedAt). Para distinguir activos de
    // archivados hacemos dos pasadas (includeArchived: 'NO' luego 'YES') y
    // sintetizamos archivedAt = ARCHIVED_SENTINEL para los IDs que aparecen en
    // YES pero no en NO. La lógica de Pases 1/2 ya respeta el flag (1.2.12).
    const activeIds = new Set();

    setPanelPhase(`Prefetch PNs activos (subset: ${customerSet.size} clientes)`);
    let offset = 0;
    let scanned = 0;
    let kept = 0;
    while (offset < maxResults) {
      if (myRunId != null) bailIfStale(myRunId);
      const d = await withRetry(
        () => api().query('AllPartNumbers', {
          orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: '',
          includeArchived: 'NO'
        }),
        `AllPartNumbers (NO) prefetch offset=${offset}`,
        myRunId
      );
      const nodes = d?.pagedData?.nodes || [];
      scanned += nodes.length;
      for (const n of nodes) {
        activeIds.add(n.id);
        const cid = n.customerByCustomerId?.id || n.customerId;
        if (cid != null && customerSet.has(cid)) {
          result.get(cid).push(extractPNShape(n));
          kept++;
        }
      }
      const totalCount = d?.pagedData?.totalCount || 0;
      setPanelProgress(scanned, Math.min(totalCount || maxResults, maxResults));
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    log(`Prefetch activos: ${scanned} PNs escaneados, ${kept} relevantes para ${customerSet.size} clientes`);

    setPanelPhase(`Prefetch PNs archivados (subset: ${customerSet.size} clientes)`);
    offset = 0;
    let scannedArch = 0;
    let keptArch = 0;
    while (offset < maxResults) {
      if (myRunId != null) bailIfStale(myRunId);
      const d = await withRetry(
        () => api().query('AllPartNumbers', {
          orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: '',
          includeArchived: 'YES'
        }),
        `AllPartNumbers (YES) prefetch offset=${offset}`,
        myRunId
      );
      const nodes = d?.pagedData?.nodes || [];
      scannedArch += nodes.length;
      for (const n of nodes) {
        if (activeIds.has(n.id)) continue; // ya añadido en pasada NO
        const cid = n.customerByCustomerId?.id || n.customerId;
        if (cid != null && customerSet.has(cid)) {
          const shape = extractPNShape(n);
          shape.archivedAt = ARCHIVED_SENTINEL;
          result.get(cid).push(shape);
          keptArch++;
        }
      }
      const totalCount = d?.pagedData?.totalCount || 0;
      setPanelProgress(scannedArch, Math.min(totalCount || maxResults, maxResults));
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    log(`Prefetch archivados: ${scannedArch} PNs escaneados, ${keptArch} archivados relevantes`);
    return result;
  }

  // Extrae el shape mínimo de un nodo de AllPartNumbers para el classifier.
  // customInputs viene como objeto JS en AllPartNumbers (verificado en scan
  // 2026-05-20); el branch del JSON.parse queda como defensa por si Steelhead
  // cambia el shape en el futuro.
  function extractPNShape(n) {
    let ci = null;
    if (typeof n.customInputs === 'string') {
      try { ci = JSON.parse(n.customInputs); } catch { ci = null; }
    } else if (n.customInputs && typeof n.customInputs === 'object') {
      ci = n.customInputs;
    }
    const metalBase = ci?.DatosAdicionalesNP?.BaseMetal || '';
    const quoteIBMS = ci?.DatosAdicionalesNP?.QuoteIBMS || '';
    // 1.2.10: capturar también el color del label (Steelhead lo expone en
    // labelByLabelId.color como hex). Lo guardamos paralelo a labels (legacy
    // array de strings) en labelObjs para que la UI use ambos sin romper
    // callers que iteran sobre labels.
    const labelNodes = (n.partNumberLabelsByPartNumberId?.nodes || [])
      .map(x => x?.labelByLabelId)
      .filter(x => x && x.name);
    const labels = labelNodes.map(l => l.name);
    const labelObjs = labelNodes.map(l => ({ name: l.name, color: l.color || '#475569' }));
    return {
      id: n.id,
      name: n.name,
      customerId: n.customerByCustomerId?.id || n.customerId,
      metalBase,
      quoteIBMS,
      labels,
      labelObjs,
      archivedAt: n.archivedAt || null,
      defaultProcessNodeId: n.processNodeByDefaultProcessNodeId?.id || n.defaultProcessNodeId || null,
      processName: n.processNodeByDefaultProcessNodeId?.name || null,
    };
  }

  // 1.2.0 R4: lazy fetch de specs del PN candidato.
  // Llamamos GetPartNumber con usagesLimit=1 (mínimo aceptado por el server,
  // no usamos los usages pero la query exige el param). El shape relevante es
  // partNumberById.partNumberSpecsByPartNumberId.nodes[].specBySpecId.name.
  // Devuelve siempre lo que esté en cache (con state: loading/loaded/error).
  async function fetchCandidateSpecs(pnId) {
    const cached = specsCache.get(pnId);
    if (cached?.state === 'loaded' || cached?.state === 'loading') return cached;
    specsCache.set(pnId, { state: 'loading', specs: [], err: '' });
    try {
      const d = await api().query('GetPartNumber', {
        partNumberId: pnId, usagesLimit: 1, usagesOffset: 0,
      });
      const nodes = d?.partNumberById?.partNumberSpecsByPartNumberId?.nodes || [];
      const specs = nodes.map(x => x?.specBySpecId?.name).filter(Boolean);
      const entry = { state: 'loaded', specs, err: '' };
      specsCache.set(pnId, entry);
      return entry;
    } catch (e) {
      const entry = { state: 'error', specs: [], err: e?.message || String(e) };
      specsCache.set(pnId, entry);
      return entry;
    }
  }

  // ─── classifyPNs (reemplaza checkPNExistence en 1.1.0) ───
  // Auto-detect dual-mode por tamaño del CSV:
  //   - CSV grande (> massiveThreshold, default 1000): prefetch global del
  //     dominio + group-by customer (~250 queries para domain 50k vs ~9k
  //     queries on-demand). Pase 1 (QuoteIBMS match) viable porque se
  //     evalúan TODOS los PNs activos del cliente.
  //   - CSV chico (≤ massiveThreshold): query on-demand searchQuery=name
  //     por PN del CSV (patrón 1.0.0). Performance: ~|CSV| queries. Pase 1
  //     limitado a matches por nombre exacto (raro pero acotado en CSVs <
  //     1000 filas — diseño del día a día).
  async function classifyPNs(parts, myRunId) {
    const cfg = bulkCfg();
    const massiveThreshold = cfg.dedup?.massiveThreshold ?? 1000;
    const useMassive = parts.length > massiveThreshold;
    log(`Clasificación: ${parts.length} filas — modo ${useMassive ? 'MASIVO (prefetch global)' : 'DÍA (on-demand)'} (threshold=${massiveThreshold})`);
    return useMassive
      ? await classifyPNsMassive(parts, myRunId)
      : await classifyPNsOnDemand(parts, myRunId);
  }

  // Modo masivo: prefetch global + classifier puro.
  async function classifyPNsMassive(parts, myRunId) {
    const cfg = bulkCfg();
    const nonFinishList = cfg.nonFinishLabelNames || [];
    // 1.4.3: equivalencias semánticas (Estaño/Plata...) configurables.
    const equivIndex = buildEquivIndex(cfg.metalEquivalents);
    const customerIds = [...new Set(parts.map(p => p.customerId).filter(x => x != null))];
    const pnsByCustomer = await prefetchPNsByCustomer(customerIds, myRunId);

    setPanelPhase(`Clasificación: evaluando ${parts.length} filas`);
    const out = parts.map(p => buildClassifiedRow(p, pnsByCustomer.get(p.customerId) || [], nonFinishList, equivIndex));
    const dedup = dedupModifyTargets(out, nonFinishList, equivIndex);
    if (dedup.reassigned || dedup.demoted) {
      log(`Dedup MODIFY targets: ${dedup.reassigned} re-asignaciones, ${dedup.demoted} demotadas a NEW por conflicto`);
    }
    logClassificationSummary(out);
    return out;
  }

  // Modo día: una pasada paginada de AllPartNumbers con searchQuery=name por
  // PN del CSV; filtro client-side por customerId; mapeo a shape con
  // extractPNShape; llamada a classifyOnePN.
  async function classifyPNsOnDemand(parts, myRunId) {
    const cfg = bulkCfg();
    const nonFinishList = cfg.nonFinishLabelNames || [];
    // 1.4.3: equivalencias semánticas (Estaño/Plata...) configurables.
    const equivIndex = buildEquivIndex(cfg.metalEquivalents);
    const pageSize = cfg.paging?.allPartNumbers?.first || cfg.paging?.allPartNumbersFirst || 200;
    const maxResults = cfg.paging?.allPartNumbers?.maxResults || cfg.paging?.allPartNumbersMaxResults || 1000;

    // Deduplicar por (PN|customerId) para no buscar dos veces el mismo lookup
    const uniq = new Map();
    for (const p of parts) {
      const key = `${p.pn.toUpperCase()}|${p.customerId}`;
      if (!uniq.has(key)) uniq.set(key, { name: p.pn, customerId: p.customerId });
    }
    const candidatesByKey = new Map(); // key → PN[] del cliente con nombre cercano
    // 1.2.6: trackear nodos que matchearon por nombre pero NO por customerId, para
    // diagnosticar el caso "PN existe en Steelhead pero el comparador no lo muestra
    // como opción". Causas típicas: la previous run creó el PN bajo otro
    // customerId (ej. duplicate cliente), o el customerByCustomerId vino null en
    // la respuesta (shape incompleto post-crash).
    const otherCustomerHits = new Map(); // key → [{id, name, otherCustomerId, otherCustomerName, archivedAt}]
    log(`Buscando ${uniq.size} PN/cliente combinaciones (page=${pageSize}, cap=${maxResults})...`);
    setPanelPhase(`Verificando PNs existentes (${uniq.size} búsquedas únicas / ${parts.length} registros)`);
    setPanelProgress(0, uniq.size);

    let progress = 0;
    for (const [key, { name, customerId }] of uniq) {
      if (myRunId != null) bailIfStale(myRunId);
      const pnsForKey = [];
      const otherHits = [];
      // 1.2.13: dos pasadas (NO + YES) — diff por ID sintetiza archivedAt para
      // los archivados, porque el persisted query de AllPartNumbers no expone
      // archivedAt en su selection set. Sin esta señal, Pases 1/2 no podían
      // distinguir cuándo un match estaba archivado (no marcaba wasArchived
      // ni disparaba el unarchive en STEP 8). Ver bitácora 1.2.13.
      const activeIdsForKey = new Set();
      try {
        // Pasada 1: solo activos (typical hit rate alto, queda cacheado para el diff)
        let offset = 0;
        while (offset < maxResults) {
          if (myRunId != null) bailIfStale(myRunId);
          const d = await withRetry(
            () => api().query('AllPartNumbers', {
              orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: name,
              includeArchived: 'NO'
            }),
            `AllPartNumbers (NO) "${name}" offset=${offset}`,
            myRunId
          );
          const nodes = d?.pagedData?.nodes || [];
          for (const n of nodes) {
            activeIdsForKey.add(n.id);
            const cid = n.customerByCustomerId?.id || n.customerId;
            if (cid === customerId) pnsForKey.push(extractPNShape(n));
            else if ((n.name || '').toUpperCase() === name.toUpperCase()) {
              otherHits.push({
                id: n.id, name: n.name,
                otherCustomerId: cid || null,
                otherCustomerName: n.customerByCustomerId?.name || null,
                archivedAt: null,
              });
            }
          }
          if (nodes.length < pageSize) break;
          offset += pageSize;
        }
        // Pasada 2: includeArchived YES — solo agregamos lo que NO esté en activeIds
        offset = 0;
        while (offset < maxResults) {
          if (myRunId != null) bailIfStale(myRunId);
          const d = await withRetry(
            () => api().query('AllPartNumbers', {
              orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: name,
              includeArchived: 'YES'
            }),
            `AllPartNumbers (YES) "${name}" offset=${offset}`,
            myRunId
          );
          const nodes = d?.pagedData?.nodes || [];
          for (const n of nodes) {
            if (activeIdsForKey.has(n.id)) continue; // ya añadido en pasada NO
            const cid = n.customerByCustomerId?.id || n.customerId;
            if (cid === customerId) {
              const shape = extractPNShape(n);
              shape.archivedAt = ARCHIVED_SENTINEL;
              pnsForKey.push(shape);
            } else if ((n.name || '').toUpperCase() === name.toUpperCase()) {
              otherHits.push({
                id: n.id, name: n.name,
                otherCustomerId: cid || null,
                otherCustomerName: n.customerByCustomerId?.name || null,
                archivedAt: ARCHIVED_SENTINEL,
              });
            }
          }
          if (nodes.length < pageSize) break;
          offset += pageSize;
        }
      } catch (e) {
        if (isBail(e)) throw e;
        warn(`Búsqueda "${name}": ${String(e).substring(0, 120)}`);
        state.counters.errors++;
      }
      candidatesByKey.set(key, pnsForKey);
      if (otherHits.length) otherCustomerHits.set(key, otherHits);
      progress++;
      setPanelProgress(progress, uniq.size);
    }

    setPanelPhase(`Clasificación: evaluando ${parts.length} filas`);
    const out = parts.map(p => {
      const key = `${p.pn.toUpperCase()}|${p.customerId}`;
      const pnsForCustomer = candidatesByKey.get(key) || [];
      return buildClassifiedRow(p, pnsForCustomer, nonFinishList, equivIndex);
    });
    const dedup = dedupModifyTargets(out, nonFinishList, equivIndex);
    if (dedup.reassigned || dedup.demoted) {
      log(`Dedup MODIFY targets: ${dedup.reassigned} re-asignaciones, ${dedup.demoted} demotadas a NEW por conflicto`);
    }
    logClassificationSummary(out);

    // 1.2.6: diagnóstico — para cada PN que terminó sin candidatos pero existe
    // bajo otro customerId, reportar el desvío. El usuario ve esto en logs si
    // el comparador "no toma en cuenta" un PN que él sabe que existe.
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]; const cls = out[i];
      if (cls.pase != null) continue; // ya tiene match
      const key = `${p.pn.toUpperCase()}|${p.customerId}`;
      const others = otherCustomerHits.get(key);
      if (!others?.length) continue;
      const sample = others.slice(0, 3).map(o =>
        `#${o.id}${o.archivedAt ? ' (archivado)' : ''} bajo cust=${o.otherCustomerId ?? 'null'}${o.otherCustomerName ? ` "${o.otherCustomerName}"` : ''}`
      ).join(', ');
      warn(`PN "${p.pn}" sin candidatos para cust=${p.customerId}, pero ${others.length} match(es) en otro(s) cliente(s): ${sample}${others.length > 3 ? '…' : ''}`);
    }
    return out;
  }

  // Builder común: construye el objeto pnStatus retro-compatible + nuevos
  // campos del refactor. Centraliza el mapping classification → status para
  // que ambos modos (masivo y día) emitan el mismo shape.
  function buildClassifiedRow(p, pnsForCustomer, nonFinishList, equivIndex) {
    const csvRow = {
      customerId: p.customerId,
      name: p.pn,
      metalBase: p.metalBase || '',
      labels: p.labels || [],
      quoteIBMS: p.quoteIBMS || '',
    };
    const cls = classifyOnePN(csvRow, pnsForCustomer, nonFinishList, equivIndex);

    // Retro-compat: derivar status para enrichWorker y demás callers.
    let status;
    if (p.forzarDuplicado && cls.classification === 'MODIFY') status = 'forceDup';
    else if (cls.classification === 'MODIFY') status = 'existing';
    else status = 'new';
    // forceDup sin target → degrada a 'new' (nada que duplicar)
    if (status === 'forceDup' && !cls.targetPnId) status = 'new';

    const pnTarget = cls.targetPnId ? pnsForCustomer.find(x => x.id === cls.targetPnId) : null;
    return {
      // retro-compat
      pn: p.pn,
      status,
      existingId: cls.targetPnId,
      existingProcessId: pnTarget?.defaultProcessNodeId || null,
      qty: p.qty,
      precio: p.precio,
      customerId: p.customerId,
      // nuevos campos
      classification: cls.classification,
      pase: cls.pase,
      confidence: cls.confidence,
      candidates: cls.candidates,
      userOverride: null,
      // 1.4.5: separar "el operador ya validó esta fila" de "el operador eligió
      // algo distinto al default". Antes usábamos userOverride!=null para ambos,
      // pero re-seleccionar el default propuesto resetea userOverride a null y la
      // fila vuelve a aparecer como pendiente — UX confusa.
      userDecided: false,
      targetPnId: cls.targetPnId,
      wasArchived: !!cls.wasArchived, // 1.2.12: PN matcheado por Pase 1/2 estaba archivado
      csvRowKey: `${p.pn.toUpperCase()}|${p.customerId}`,
      // 1.2.11: snapshot del CSV para que dedupModifyTargets pueda evaluar
      // strict-match de alternates con la misma lógica de classifyOnePN.
      csvLabels: p.labels || [],
      csvMetalBase: p.metalBase || '',
    };
  }

  function logClassificationSummary(out) {
    const p1 = out.filter(s => s.pase === 1).length;
    const p2 = out.filter(s => s.pase === 2).length;
    const p3 = out.filter(s => s.pase === 3).length;
    const newClean = out.filter(s => s.pase === null).length;
    log(`Clasificación: P1=${p1} P2=${p2} P3=${p3} NEW=${newClean} (total ${out.length})`);
  }

  // Alias retro-compat: el callsite (~línea 1389) sigue invocando checkPNExistence.
  const checkPNExistence = classifyPNs;

  // ═══════════════════════════════════════════
  // MODAL UI
  // ═══════════════════════════════════════════

  // 1.2.10: helper para calcular un foreground legible (oscuro o claro) sobre
  // un background hex. Patrón estable lift-eado de wo-deadline-changer.js.
  // Luminancia ITU-R BT.601; threshold 0.55 es la cota usada por el applet
  // hermano. Acepta strings con/sin '#' y degrada a blanco si el hex es inválido.
  function labelTextColor(hex) {
    const raw = String(hex || '').replace('#', '');
    if (raw.length < 6) return '#fff';
    const r = parseInt(raw.substring(0, 2), 16);
    const g = parseInt(raw.substring(2, 4), 16);
    const b = parseInt(raw.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return '#fff';
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1e293b' : '#fff';
  }

  function injectStyles() {
    if (document.getElementById('dl9-styles')) return;
    const s = document.createElement('style'); s.id = 'dl9-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:14px 22px;max-width:min(1800px,98vw);width:98%;max-height:96vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-line-num{display:inline-block;font-size:10px;color:#64748b;font-family:monospace;margin-right:6px;min-width:36px}.dl9-saved-chip{display:inline-block;margin-left:6px;padding:1px 7px;font-size:10px;font-weight:600;background:rgba(20,83,45,0.30);color:#86efac;border:1px solid #15803d;border-radius:10px;font-family:inherit;vertical-align:middle;line-height:1.4}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-modal h3{font-size:14px;margin:16px 0 6px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}.dl9-modal .dl9-sub{color:#64748b;font-size:13px;margin-bottom:16px}.dl9-modal table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}.dl9-modal th{text-align:left;padding:4px 8px;color:#94a3b8;border-bottom:1px solid #334155;font-weight:500}.dl9-modal td{padding:4px 8px;border-bottom:1px solid #1e293b}.dl9-new{color:#4ade80}.dl9-exist{color:#facc15}.dl9-dup{color:#f97316}.dl9-err{color:#f87171}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.2s}.dl9-btn:hover{opacity:0.85}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#2563eb;color:white}.dl9-btn-close{background:#475569;color:#e2e8f0}.dl9-btn-copy{background:#0d9488;color:white}.dl9-progress{font-size:13px;color:#94a3b8;margin-top:8px;white-space:pre-wrap;line-height:1.6}.dl9-bar{height:4px;background:#334155;border-radius:2px;margin:8px 0;overflow:hidden}.dl9-bar-fill{height:100%;background:#2563eb;transition:width 0.3s;width:0%}.dl9-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}.dl9-stat{background:#0f172a;padding:8px 12px;border-radius:6px;font-size:13px}.dl9-stat b{color:#38bdf8}.dl9-pending-chip{background:#7c2d12;color:#fed7aa;padding:2px 8px;border-radius:4px;font-weight:600}.dl9-pending-chip b{color:#fdba74}.dl9-btn-mini{padding:2px 8px;font-size:11px;margin-left:6px;background:#9a3412;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600}.dl9-btn-mini:hover{opacity:0.85}.dl9-row-pending{background:rgba(124,45,18,0.18)}.dl9-cls-select{background:#0f172a;color:#e2e8f0;border:1px solid #475569;padding:2px 6px;border-radius:4px;font-size:12px;max-width:520px}.dl9-cand-links{display:inline-flex;gap:4px;margin-left:6px}.dl9-cand-link{color:#38bdf8;text-decoration:none;font-size:11px;padding:1px 4px;background:#0f172a;border-radius:3px}.dl9-cand-link:hover{color:#7dd3fc;background:#1e293b}.dl9-p3-wrap{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;align-items:start}.dl9-p3-selrow{grid-column:1/-1;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}.dl9-p3-col{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:4px;min-width:0}.dl9-p3-col-csv{background:rgba(15,23,42,0.6);border-left:2px solid #38bdf8}.dl9-p3-col-cand{background:rgba(120,53,15,0.18);border-left:2px solid #fbbf24}.dl9-p3-col-cand.dl9-p3-col-cand-new{background:rgba(20,83,45,0.18);border-left-color:#4ade80}.dl9-p3-hdr{font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px}.dl9-p3-col-csv .dl9-p3-hdr{color:#38bdf8}.dl9-p3-col-cand .dl9-p3-hdr{color:#fbbf24}.dl9-p3-col-cand-new .dl9-p3-hdr{color:#4ade80}.dl9-p3-meta{font-size:10px;color:#cbd5e1;font-family:monospace;line-height:1.3;word-break:break-word}.dl9-p3-meta b{color:#e2e8f0;font-weight:500}.dl9-p3-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:1px}.dl9-p3-chip{font-size:10px;padding:1px 7px;background:#0f172a;color:#cbd5e1;border:1px solid #334155;border-radius:10px;font-family:inherit;line-height:1.4}.dl9-p3-chip-match{background:rgba(20,83,45,0.45);color:#86efac;border-color:#15803d}.dl9-p3-chip-miss{background:rgba(127,29,29,0.35);color:#fca5a5;border-color:#991b1b}.dl9-p3-chip-empty{color:#64748b;font-style:italic;border-style:dashed}.dl9-p3-specs-btn{font-size:10px;padding:1px 6px;background:#1e293b;color:#94a3b8;border:1px solid #475569;border-radius:3px;cursor:pointer;font-family:inherit}.dl9-p3-specs-btn:hover{background:#334155;color:#e2e8f0}.dl9-p3-specs{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:2px;padding:4px 6px;background:rgba(15,23,42,0.4);border-radius:4px;border-left:2px solid #475569}.dl9-p3-specs-col{display:flex;flex-direction:column;gap:2px;min-width:0}.dl9-p3-specs-hdr{font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase}.dl9-p3-specs-list{font-size:10px;color:#cbd5e1;font-family:monospace;line-height:1.4;word-break:break-word}.dl9-p3-specs-err{color:#f87171}.dl9-p3-hdrrow{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;margin-bottom:1px}.dl9-p3-hdr-title{font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px}.dl9-p3-col-csv .dl9-p3-hdr-title{color:#38bdf8}.dl9-p3-col-cand .dl9-p3-hdr-title{color:#fbbf24}.dl9-p3-col-cand-new .dl9-p3-hdr-title{color:#4ade80}.dl9-p3-hdr-meta{font-size:10px;color:#cbd5e1;font-family:monospace;line-height:1.2}.dl9-p3-hdr-meta b{color:#e2e8f0;font-weight:500}.dl9-p3-real-chip{font-size:10px;padding:1px 7px;border-radius:10px;font-family:inherit;line-height:1.4;border:1px solid transparent;display:inline-flex;align-items:center;gap:3px}.dl9-p3-real-chip.match::before{content:'✓';font-size:9px;opacity:0.8}.dl9-p3-real-chip.miss::before{content:'✗';font-size:9px;opacity:0.6}.dl9-p3-dedup-banner{grid-column:1/-1;font-size:11px;padding:4px 8px;border-radius:4px;margin-bottom:2px;display:flex;align-items:center;gap:6px}.dl9-p3-dedup-banner.reassigned{background:rgba(202,138,4,0.18);color:#fde68a;border-left:3px solid #d97706}.dl9-p3-dedup-banner.conflict{background:rgba(127,29,29,0.30);color:#fca5a5;border-left:3px solid #b91c1c}.dl9-csv-dup-chip{display:inline-block;margin-left:6px;padding:1px 7px;font-size:10px;font-weight:600;background:rgba(234,88,12,0.22);color:#fdba74;border:1px solid #9a3412;border-radius:10px;font-family:inherit;vertical-align:middle;line-height:1.4}.dl9-unarch-chip{display:inline-block;margin-left:6px;padding:1px 7px;font-size:10px;font-weight:600;background:rgba(37,99,235,0.20);color:#93c5fd;border:1px solid #1e40af;border-radius:10px;font-family:inherit;vertical-align:middle;line-height:1.4}.dl9-archive-toggle{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#94a3b8;padding:3px 6px;background:#0f172a;border:1px solid #334155;border-radius:4px}.dl9-archive-toggle input{margin:0 4px 0 0;cursor:pointer}.dl9-archive-toggle.dl9-archive-off{background:rgba(127,29,29,0.18);color:#fca5a5;border-color:#7f1d1d}.dl9-archive-row-chk{display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:1px 5px;font-size:10px;background:rgba(124,45,18,0.20);color:#fed7aa;border:1px solid #9a3412;border-radius:3px;font-family:inherit;cursor:pointer;vertical-align:middle}.dl9-archive-row-chk input{margin:0 3px 0 0;cursor:pointer}.dl9-archive-row-chk.dl9-archive-row-off{background:rgba(15,23,42,0.6);color:#64748b;border-color:#334155;text-decoration:line-through}`;
    document.head.appendChild(s);
  }

  function createOverlay() { const ov = document.createElement('div'); ov.className = 'dl9-overlay'; const md = document.createElement('div'); md.className = 'dl9-modal'; ov.appendChild(md); document.body.appendChild(ov); return { overlay: ov, modal: md }; }
  function removeOverlay(ov) { if (ov?.parentNode) ov.parentNode.removeChild(ov); }

  function showPreview(header, parts, pnStatus, info, isSoloPN) {
    return new Promise(resolve => {
      injectStyles(); const { overlay, modal } = createOverlay();

      // ── Fix 4: preview paginado ──
      // En vez de inyectar N <tr> con innerHTML (9k filas congelan Chrome),
      // construimos un array de rows en memoria, filtramos/paginamos y solo
      // renderizamos la página visible (100 filas) vía DOM.

      const PAGE_SIZE = bulkCfg().preview.pageSize || 100;

      // 1) Construir las rows una sola vez (objeto, no HTML)
      const rows = pnStatus.map((s, i) => {
        const part = parts[i];
        const changes = [];
        if (part.labels.length) changes.push(`${part.labels.length} labels`);
        if (part.specs.length) changes.push(`${part.specs.length} specs`);
        if (part.racks.length) changes.push(`${part.racks.length} racks`);
        if (part.dims && Object.values(part.dims).some(v => v !== null)) changes.push('dims');
        if (part.predictiveUsage.length) changes.push('predictive');
        if (part.unitConv.kgm !== null || part.unitConv.cmk !== null || part.unitConv.lm !== null) changes.push('unitConv');
        if (part.metalBase || part.pnAlterno || part.codigoSAT) changes.push('CI');
        if (part.validacion1er) changes.push('optIn');
        if (!isSoloPN && part.products.length) changes.push(`${part.products.length} products`);
        if (!isSoloPN) changes.push(`qty:${part.qty}`);
        const customerBase = (part.cliente || '').split(/\s*[—–]\s*|\s+[-]\s+/)[0].trim();
        return {
          idx: i,
          pn: s.pn,
          status: s.status,
          existingId: s.existingId || null,
          archivarAnterior: !!part.archivarAnterior,
          customer: customerBase || '(sin cliente)',
          changeSummary: changes.length ? changes.join(', ') : 'solo crear',
          qty: s.qty,
          precio: s.precio,
          pase: s.pase,
          candidates: s.candidates || [],
          // 1.2.0 R3/R4: snapshot del CSV row para comparación inline en Pase 3
          csvLabels: part.labels || [],
          csvMetalBase: part.metalBase || '',
          csvIBMS: part.quoteIBMS || '',
          csvProceso: part.procesoOverride || '',
          csvSpecs: (part.specs || []).map(s => s.name).filter(Boolean),
          // 1.2.10: markers de dedup propagados desde pnStatus para visual cue
          dedupReassigned: !!s.dedupReassigned,
          dedupOriginalTargetPnId: s.dedupOriginalTargetPnId || null,
          dedupConflict: !!s.dedupConflict,
          dedupConflictTargetPnId: s.dedupConflictTargetPnId || null,
          // 1.2.11 H5: duplicados internos del CSV (detectados en parse).
          // Se muestran como chip naranja "🔄 DUP n/m" junto al PN para que el
          // operador entienda que esa fila comparte (name, customerId) con otra
          // — informativo; el classifier decide cada fila por separado.
          isCsvDuplicate: !!part.isCsvDuplicate,
          csvDuplicateIndex: part.csvDuplicateIndex || null,
          csvDuplicateGroupSize: part.csvDuplicateGroupSize || null,
          // 1.2.12: Pase 1/2 matchearon un PN archivado → STEP 8 auto-desarchiva
          wasArchived: !!s.wasArchived,
          confidence: s.confidence || null,
        };
      });

      // 2) Selección global persistente: un Set, no checkboxes del DOM.
      const selected = new Set(rows.map(r => r.idx));

      // 1.2.11 F2: mapa global label-name → color real del catálogo Steelhead.
      // Se construye recorriendo labelObjs de TODOS los candidates de TODAS las
      // filas. Los labels del CSV no traen color de origen, pero si su nombre
      // matchea alguno visto en el catálogo (vía candidates de Steelhead) podemos
      // pintarlos con el mismo color para que el operador identifique al vuelo
      // qué etiqueta es cuál sin tener que mirar el candidato.
      const labelColorByName = new Map();
      for (const r of rows) {
        for (const c of (r.candidates || [])) {
          for (const o of (c.labelObjs || [])) {
            if (o && o.name && o.color && !labelColorByName.has(o.name)) {
              labelColorByName.set(o.name, o.color);
            }
          }
        }
      }
      const enrichCsvLabel = (name) => ({ name, color: labelColorByName.get(name) || null });

      // 3) Conteos
      const nc = rows.filter(r => r.status === 'new').length;
      const ec = rows.filter(r => r.status === 'existing').length;
      const dc = rows.filter(r => r.status === 'forceDup').length;
      const pendingCount = rows.filter(r => r.pase === 3).length;

      // 4) Catálogo de clientes para el dropdown (ordenado, top 50 si son muchos)
      const customerCounts = new Map();
      for (const r of rows) customerCounts.set(r.customer, (customerCounts.get(r.customer) || 0) + 1);
      const customerOptions = [...customerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

      // Mode-specific styling
      const modeColor = isSoloPN ? '#0d9488' : '#2563eb';
      const modeBg = isSoloPN ? '#0f2e2c' : '#1e293b';
      const modeLabel = isSoloPN ? 'SOLO NÚMEROS DE PARTE' : 'COTIZACIÓN + NP';

      const statsHtml = isSoloPN
        ? `<div class="dl9-stats">
            <div class="dl9-stat"><b>Clientes:</b> ${info.customerCount || '?'}</div>
            <div class="dl9-stat"><b>Procesos:</b> ${info.processCount || '?'}</div>
           </div>`
        : `<div class="dl9-stats">
            <div class="dl9-stat"><b>Layout:</b> ${header.quoteName || '?'}</div>
            <div class="dl9-stat"><b>Clientes:</b> ${info.customerCount || '?'} (1 cot c/u)</div>
            <div class="dl9-stat"><b>Asignado:</b> ${info.assigneeName || '(auto)'}</div>
            <div class="dl9-stat"><b>Procesos:</b> ${info.processCount || '?'}</div>
            <div class="dl9-stat"><b>Divisa:</b> per-línea</div>
            <div class="dl9-stat"><b>Empresa:</b> ${header.empresaEmisora || 'ECO'}</div>
           </div>`;

      // 5) Custom dropdown options HTML (built without innerHTML interpolation of row data)
      const custOptsHtml = ['<option value="__all__">Todos los clientes</option>']
        .concat(customerOptions.slice(0, 200).map(c => {
          const safe = String(c.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          return `<option value="${safe}">${safe} (${c.count})</option>`;
        }))
        .join('');

      modal.style.background = modeBg;
      modal.innerHTML = `
        <h2 style="color:${modeColor}">Steelhead Automator v10 — ${modeLabel}</h2>
        <p class="dl9-sub" id="dl9-counts-line">${rows.length} filas — ${nc} nuevos, ${ec} ${isSoloPN ? 'a modificar' : 'existentes'}, ${dc} forzar dup${pendingCount > 0 ? ` · <span class="dl9-pending-chip"><b>${pendingCount}</b> decisiones pendientes</span> <button id="dl9-toggle-pending" class="dl9-btn-mini">Solo pendientes</button>` : ''}</p>
        ${statsHtml}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:center">
          <label style="font-size:12px;color:#94a3b8">Filtro:
            <select id="dl9-flt-status" style="margin-left:4px;padding:3px 6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px">
              <option value="__all__">Todos los estatus</option>
              <option value="new">Solo nuevos</option>
              <option value="existing">Solo existentes</option>
              <option value="forceDup">Solo forceDup</option>
            </select>
          </label>
          <label style="font-size:12px;color:#94a3b8">Cliente:
            <select id="dl9-flt-cust" style="margin-left:4px;padding:3px 6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;max-width:280px">${custOptsHtml}</select>
          </label>
          <label class="dl9-archive-toggle" id="dl9-archive-global-lbl" title="Cuando está prendido, las filas con 'archivar anterior' en el CSV archivan el PN viejo (forceDup). Apaga para que ninguna archive (override blanket).">
            <input type="checkbox" id="dl9-archive-global" checked>
            🗄️ Archivar PNs viejos (CSV)
          </label>
          ${isSoloPN ? '' : `<label style="font-size:12px;color:#94a3b8" title="Si la cotización tiene más de N líneas se parte en varias cotizaciones nombradas '<nombre> 01', '<nombre> 02', etc. Útil para clientes muy grandes (Schneider) donde abrir una quote de miles de líneas tarda minutos.">Chunk:
            <input type="number" id="dl9-chunksize" min="10" step="10" value="${bulkCfg().chunking.defaultChunkSize}" style="margin-left:4px;width:70px;padding:3px 6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px">
            <span id="dl9-chunkpreview" style="margin-left:6px;color:#cbd5e1"></span>
          </label>`}
          <span style="font-size:12px;color:#94a3b8;margin-left:auto">Seleccionadas: <b id="dl9-sel-count">${selected.size}</b> / ${rows.length}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <button class="dl9-btn" id="dl9-sel-page" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Seleccionar todo (página)</button>
          <button class="dl9-btn" id="dl9-unsel-page" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Deseleccionar todo (página)</button>
          <button class="dl9-btn" id="dl9-sel-global" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Seleccionar TODO (global)</button>
          <button class="dl9-btn" id="dl9-unsel-global" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Deseleccionar TODO (global)</button>
        </div>
        <h3 id="dl9-preview-title" style="margin-bottom:4px">Part Numbers — página 1</h3>
        <div id="dl9-table-wrap" style="max-height:calc(96vh - 280px);min-height:300px;overflow-y:auto;border:1px solid #334155;border-radius:4px">
          <table style="width:100%;border-collapse:collapse"><thead id="dl9-thead"></thead><tbody id="dl9-tbody"></tbody></table>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
          <button class="dl9-btn" id="dl9-prev-page" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">‹ Anterior</button>
          <span id="dl9-page-info" style="font-size:12px;color:#94a3b8">Página 1 / 1</span>
          <button class="dl9-btn" id="dl9-next-page" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Siguiente ›</button>
          <span style="font-size:12px;color:#94a3b8;margin-left:auto">Filtradas: <b id="dl9-filtered-count">0</b></span>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-cancel">CANCELAR</button>
          <button class="dl9-btn" id="dl9-exec" style="background:${modeColor};color:white">EJECUTAR (<span id="dl9-count">${selected.size}</span> PNs)</button>
        </div>`;

      // Render thead
      const thead = modal.querySelector('#dl9-thead');
      const headerCells = isSoloPN
        ? ['Sel', 'PN', 'Cliente', 'Acción', 'Datos a aplicar']
        : ['Sel', 'PN', 'Cliente', 'Acción', 'Datos', 'Qty', 'Precio'];
      const trh = document.createElement('tr');
      for (const cell of headerCells) {
        const th = document.createElement('th');
        th.textContent = cell;
        th.style.textAlign = 'left';
        th.style.padding = '4px 6px';
        th.style.background = '#0f172a';
        th.style.fontSize = '11px';
        th.style.borderBottom = '1px solid #334155';
        trh.appendChild(th);
      }
      thead.appendChild(trh);

      // Filter + pagination state
      let filterStatus = '__all__';
      let filterCustomer = '__all__';
      let filterPendingOnly = false;
      let currentPage = 0;
      let filteredRows = rows; // se recalcula en applyFilters

      function applyFilters() {
        filteredRows = rows.filter(r => {
          if (filterStatus !== '__all__' && r.status !== filterStatus) return false;
          if (filterCustomer !== '__all__' && r.customer !== filterCustomer) return false;
          if (filterPendingOnly && r.pase !== 3) return false;
          return true;
        });
        currentPage = 0;
        modal.querySelector('#dl9-filtered-count').textContent = filteredRows.length;
        renderPage();
      }

      function totalPages() { return Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE)); }

      // 1.3.0: hook opcional para recalcular preview de chunks cuando cambia
      // la selección. Lo asigna el bloque !isSoloPN más abajo.
      let onSelChange = null;
      function updateSelCount() {
        modal.querySelector('#dl9-sel-count').textContent = selected.size;
        modal.querySelector('#dl9-count').textContent = selected.size;
        if (onSelChange) onSelChange();
      }

      function updateHeaderStats() {
        const ncNow = rows.filter(r => r.status === 'new').length;
        const ecNow = rows.filter(r => r.status === 'existing').length;
        const dcNow = rows.filter(r => r.status === 'forceDup').length;
        const pase3Rows = rows.filter(r => r.pase === 3);
        const pendingTotal = pase3Rows.length;
        // 1.4.5: una decisión "tomada" = el operador interactuó con el dropdown
        // o aceptó explícitamente la sugerencia (userDecided === true). Antes
        // usábamos userOverride!=null, lo que tenía dos bugs: (a) si el usuario
        // re-elegía el default propuesto, userOverride volvía a null y la fila
        // re-aparecía como pendiente; (b) si el usuario estaba de acuerdo con la
        // sugerencia y no clickeaba nada, la fila quedaba pendiente para siempre.
        const decidedNow = pase3Rows.filter(r => pnStatus[r.idx]?.userDecided === true).length;
        const remainingNow = pendingTotal - decidedNow;
        const line = modal.querySelector('#dl9-counts-line');
        if (line) {
          const pendingHtml = pendingTotal > 0
            ? ` · <span class="dl9-pending-chip">Pase 3: <b>${decidedNow}</b>/${pendingTotal} validadas (${remainingNow} restantes)</span> <button id="dl9-toggle-pending" class="dl9-btn-mini">${filterPendingOnly ? 'Mostrar todas' : 'Solo pendientes'}</button> <button id="dl9-accept-visible" class="dl9-btn-mini" style="background:#15803d" title="Marca como validadas todas las filas Pase 3 visibles en la página actual con la sugerencia que tienen (sin tener que clickear una por una)">✓ Aceptar visibles</button>`
            : '';
          line.innerHTML = `${rows.length} filas — ${ncNow} nuevos, ${ecNow} ${isSoloPN ? 'a modificar' : 'existentes'}, ${dcNow} forzar dup${pendingHtml}`;
          // Re-bindear el toggle pendientes (innerHTML borra el listener anterior)
          const btn = modal.querySelector('#dl9-toggle-pending');
          if (btn) {
            btn.addEventListener('click', () => {
              filterPendingOnly = !filterPendingOnly;
              btn.textContent = filterPendingOnly ? 'Mostrar todas' : 'Solo pendientes';
              applyFilters();
            });
          }
          // 1.4.5: botón "Aceptar visibles" — marca como validadas todas las
          // filas Pase 3 visibles en la página actual con la sugerencia actual
          // del select. Acelera el flujo cuando el operador está de acuerdo con
          // las sugerencias automáticas sin tener que clickear cada select.
          const acceptBtn = modal.querySelector('#dl9-accept-visible');
          if (acceptBtn) {
            acceptBtn.addEventListener('click', () => {
              const start = currentPage * PAGE_SIZE;
              const visiblePase3 = filteredRows.slice(start, start + PAGE_SIZE).filter(r => r.pase === 3);
              let accepted = 0;
              for (const r of visiblePase3) {
                if (!pnStatus[r.idx]?.userDecided) {
                  pnStatus[r.idx].userDecided = true;
                  accepted++;
                  if (resumeState?.classifications?.[r.idx]) {
                    resumeState.classifications[r.idx].userDecided = true;
                  }
                }
              }
              if (accepted > 0 && resumeState) {
                persistResumeState().catch(() => {});
              }
              // Re-pintar todos los chips visibles
              modal.querySelectorAll('.dl9-p3-wrap').forEach(w => {
                if (w._renderSavedChip) w._renderSavedChip();
              });
              updateHeaderStats();
            });
          }
        }
      }

      function renderPage() {
        const tbody = modal.querySelector('#dl9-tbody');
        tbody.replaceChildren();
        const start = currentPage * PAGE_SIZE;
        const slice = filteredRows.slice(start, start + PAGE_SIZE);
        for (const r of slice) {
          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid #1e293b';
          tr.style.fontSize = '12px';
          if (r.pase === 3) tr.classList.add('dl9-row-pending');
          // 1.2.6: en Pase 3 el wrap se monta en una fila aparte (colspan completo)
          // para que el dropdown + comparación inline aproveche todo el ancho del
          // modal y quede visualmente atado al PN de su row principal (no compete
          // por el espacio angosto de la columna Acción).
          let pase3Wrap = null;

          const tdCheck = document.createElement('td');
          tdCheck.style.padding = '3px 6px';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(r.idx);
          cb.dataset.idx = String(r.idx);
          cb.onchange = () => {
            if (cb.checked) selected.add(r.idx);
            else selected.delete(r.idx);
            updateSelCount();
          };
          tdCheck.appendChild(cb);
          tr.appendChild(tdCheck);

          const tdPN = document.createElement('td');
          tdPN.style.padding = '3px 6px';
          tdPN.style.fontFamily = 'monospace';
          // 1.4.3: número de línea CSV (header=1, primera fila de datos=2) para
          // que el operador sepa cuántas decisiones le faltan/lleva.
          const lineSpan = document.createElement('span');
          lineSpan.className = 'dl9-line-num';
          lineSpan.textContent = `L${r.idx + 2}`;
          lineSpan.title = `Fila ${r.idx + 2} del CSV (idx ${r.idx})`;
          tdPN.appendChild(lineSpan);
          const pnNameSpan = document.createElement('span');
          pnNameSpan.textContent = r.pn;
          tdPN.appendChild(pnNameSpan);
          // 1.2.11 H5: chip "🔄 DUP n/m" cuando el CSV tiene 2+ filas con el
          // mismo (name, customerId). Informativo — el classifier maneja cada
          // fila por separado; el chip avisa al operador para que verifique
          // visualmente que las decisiones (MODIFY a IDs distintos o NEW
          // duplicados) están bien.
          if (r.isCsvDuplicate && r.csvDuplicateIndex && r.csvDuplicateGroupSize) {
            const dupChip = document.createElement('span');
            dupChip.className = 'dl9-csv-dup-chip';
            dupChip.textContent = `🔄 DUP ${r.csvDuplicateIndex}/${r.csvDuplicateGroupSize}`;
            dupChip.title = `El CSV trae ${r.csvDuplicateGroupSize} filas con este (PN, cliente) — fila ${r.csvDuplicateIndex} del grupo`;
            tdPN.appendChild(dupChip);
          }
          // 1.2.12: chip "🔓 desarch" cuando Pase 1/2 matchearon un PN archivado.
          // STEP 8 lo desarchiva automáticamente (UpdatePartNumber archivedAt:null).
          if (r.wasArchived) {
            const unArchChip = document.createElement('span');
            unArchChip.className = 'dl9-unarch-chip';
            unArchChip.textContent = '🔓 desarch';
            unArchChip.title = 'PN matcheado estaba archivado; se desarchivará automáticamente antes de aplicar cambios.';
            tdPN.appendChild(unArchChip);
          }
          tr.appendChild(tdPN);

          const tdCust = document.createElement('td');
          tdCust.textContent = r.customer;
          tdCust.style.padding = '3px 6px';
          tdCust.style.color = '#94a3b8';
          tdCust.style.fontSize = '11px';
          tr.appendChild(tdCust);

          const tdAct = document.createElement('td');
          tdAct.style.padding = '3px 6px';
          if (r.pase === 3) {
            // Pase 3 (1.2.0): default MODIFY al top match. Dropdown ordena
            // candidatos primero y "Crear nuevo" al final. Debajo del select
            // se muestran dos líneas comparativas (CSV vs candidato seleccionado)
            // con etiquetas + proceso + metal + IBMS para que el operador valide
            // de un vistazo si el match propuesto tiene sentido.
            // DOM API (no innerHTML) por el XSS gotcha conocido (CLAUDE.md).
            const wrap = document.createElement('div');
            wrap.className = 'dl9-p3-wrap';

            // Fila 1: select + links
            const selRow = document.createElement('div');
            selRow.className = 'dl9-p3-selrow';

            const sel = document.createElement('select');
            sel.className = 'dl9-cls-select';
            sel.dataset.rowIdx = String(r.idx);
            // 1.2.7: ⭐ top match SOLO cuando hay match estricto (nombre + todas
            // las etiquetas de acabado coinciden con el CSV). Si no, no se marca
            // ningún candidato como "top" — el operador decide a mano.
            const hasStrictTopMatch = r.confidence === 'name+labels-match';
            // 1.2.7: texto de cada opción enriquecido con etiquetas y metal base
            // para que el operador vea de un vistazo qué candidato es cuál sin
            // tener que abrir el panel de comparación. Formato:
            //   "Modificar #ID etiq:[NIQ,CRO] metal:CU"
            // Etiquetas filtradas con nonFinishList (V/Cobre fuera) y ordenadas.
            const nonFinishListUI = (bulkCfg().nonFinishLabelNames || []);
            // 1.4.3: index de equivalencias semánticas reusado en chips y options.
            const equivIndexUI = buildEquivIndex(bulkCfg().metalEquivalents);
            // 1.2.8: sin cap — antes filtrábamos a 3 y eso confundía al operador
            // (parecía que faltaban PNs). Ahora salen TODOS los matches por nombre
            // del cliente; en escenarios reales son <=10, sin riesgo de saturar.
            for (let ci = 0; ci < (r.candidates || []).length; ci++) {
              const c = r.candidates[ci];
              const candLabels = (c.labels || []).filter(l => !isNonFinishLabel(l, nonFinishListUI));
              candLabels.sort((a, b) => String(a).localeCompare(String(b)));
              const etiqStr = candLabels.length ? `etiq:[${candLabels.join(',')}]` : 'sin-etiq';
              const metalStr = c.metalBase ? `metal:${c.metalBase}` : 'sin-metal';
              const starStr = (ci === 0 && hasStrictTopMatch) ? ' ⭐ top match' : '';
              const opt = document.createElement('option');
              opt.value = String(c.id);
              opt.textContent = `Modificar #${c.id} ${etiqStr} ${metalStr}${starStr}`;
              sel.appendChild(opt);
            }
            const optNew = document.createElement('option');
            optNew.value = '__new__';
            optNew.textContent = '🆕 Crear nuevo PN';
            sel.appendChild(optNew);

            // Determinar selección inicial: respeta status actual.
            // - status='existing' + existingId → ese candidato
            // - status='new' → "__new__"
            // Si no hay candidatos (caso edge), el bloque pase===3 no se renderiza
            // (porque pase=3 implica candidates.length>0 por contrato del classifier).
            let initialVal;
            if (pnStatus[r.idx].status === 'new') {
              initialVal = '__new__';
            } else {
              initialVal = String(pnStatus[r.idx].existingId || r.candidates[0].id);
            }
            sel.value = initialVal;
            selRow.appendChild(sel);

            // Links 🔗 a fichas de cada candidato
            const linksSpan = document.createElement('span');
            linksSpan.className = 'dl9-cand-links';
            for (const c of (r.candidates || [])) {
              const a = document.createElement('a');
              a.href = `https://app.gosteelhead.com/PartNumbers/${c.id}`;
              a.target = '_blank';
              a.rel = 'noopener';
              a.className = 'dl9-cand-link';
              a.textContent = `🔗#${c.id}`;
              a.title = `Abrir ficha de PN #${c.id} en pestaña nueva`;
              linksSpan.appendChild(a);
            }
            selRow.appendChild(linksSpan);

            // R4: botón "📋 specs" que despliega panel comparativo lazy-loaded
            const specsBtn = document.createElement('button');
            specsBtn.className = 'dl9-p3-specs-btn';
            specsBtn.textContent = '📋 specs';
            specsBtn.title = 'Comparar specs del CSV vs PN candidato';
            selRow.appendChild(specsBtn);
            wrap.appendChild(selRow);

            // 1.2.10: banner de dedup arriba de la comparación cuando aplica.
            // dedupReassigned = el classifier re-asignó automáticamente porque
            // otra fila del CSV tomó el target original. El operador puede
            // override-ar el dropdown si conoce mejor el contexto.
            // dedupConflict = no había alternativas, la fila se demotó a NEW;
            // se preserva el id que se quería pisar para auditoría.
            if (r.dedupReassigned) {
              const banner = document.createElement('div');
              banner.className = 'dl9-p3-dedup-banner reassigned';
              banner.textContent = `⚠️ Re-asignado a candidato alterno — otra fila del CSV ya iba a modificar #${r.dedupOriginalTargetPnId}`;
              wrap.appendChild(banner);
            } else if (r.dedupConflict) {
              const banner = document.createElement('div');
              banner.className = 'dl9-p3-dedup-banner conflict';
              banner.textContent = `🛑 Conflicto — otra fila ya iba a modificar #${r.dedupConflictTargetPnId}; sin alternativas → forzado a "Crear nuevo PN"`;
              wrap.appendChild(banner);
            }

            // Fila 2 (1.2.10): header con titulo + metadata inline (metal,
            // QUOTE_NO). El proc va en su propio renglón debajo para que se
            // compare side-by-side con el candidato. Etiquetas como chips
            // pintadas con el color real del label en Steelhead (1.2.10).
            const makeMeta = (key, value) => {
              const div = document.createElement('div');
              div.className = 'dl9-p3-meta';
              const k = document.createElement('b');
              k.textContent = key + ': ';
              div.appendChild(k);
              div.appendChild(document.createTextNode(value));
              return div;
            };
            const makeHdrMeta = (key, value) => {
              const span = document.createElement('span');
              span.className = 'dl9-p3-hdr-meta';
              const k = document.createElement('b');
              k.textContent = key + ': ';
              span.appendChild(k);
              span.appendChild(document.createTextNode(value));
              return span;
            };
            // Chip de etiqueta con color real (si viene de Steelhead) o neutro.
            // labelObj puede ser {name,color} (de Steelhead) o solo string (CSV).
            const makeLabelChip = (labelObj, kind) => {
              const chip = document.createElement('span');
              const isObj = labelObj && typeof labelObj === 'object';
              const name = isObj ? labelObj.name : labelObj;
              const color = isObj ? labelObj.color : null;
              chip.className = 'dl9-p3-real-chip ' + (kind || '');
              if (color) {
                chip.style.background = color;
                chip.style.color = labelTextColor(color);
                chip.style.borderColor = color;
              } else {
                // CSV labels sin color — neutro
                chip.style.background = '#0f172a';
                chip.style.color = '#cbd5e1';
                chip.style.borderColor = '#334155';
              }
              chip.textContent = name;
              return chip;
            };
            const makeEmptyChip = (text) => {
              const chip = document.createElement('span');
              chip.className = 'dl9-p3-chip dl9-p3-chip-empty';
              chip.textContent = text;
              return chip;
            };

            // Columna CSV (fija — la metadata del CSV no cambia)
            const csvCol = document.createElement('div');
            csvCol.className = 'dl9-p3-col dl9-p3-col-csv';
            const csvHdrRow = document.createElement('div');
            csvHdrRow.className = 'dl9-p3-hdrrow';
            const csvHdrTitle = document.createElement('span');
            csvHdrTitle.className = 'dl9-p3-hdr-title';
            csvHdrTitle.textContent = '📄 CSV';
            csvHdrRow.appendChild(csvHdrTitle);
            if (r.csvMetalBase) csvHdrRow.appendChild(makeHdrMeta('metal', r.csvMetalBase));
            if (r.csvIBMS) csvHdrRow.appendChild(makeHdrMeta('QUOTE_NO (legacy)', r.csvIBMS));
            csvCol.appendChild(csvHdrRow);
            if (r.csvProceso && r.csvProceso !== '-') csvCol.appendChild(makeMeta('proc', r.csvProceso));
            const csvChips = document.createElement('div');
            csvChips.className = 'dl9-p3-chips';
            csvCol.appendChild(csvChips);
            wrap.appendChild(csvCol);

            // Columna candidato (se rerenderea al cambiar el dropdown).
            const candCol = document.createElement('div');
            candCol.className = 'dl9-p3-col dl9-p3-col-cand';
            wrap.appendChild(candCol);

            const renderCandColumn = (selVal) => {
              candCol.replaceChildren();
              csvChips.replaceChildren();
              // Caso NEW: no hay candidato, chips del CSV sin comparación.
              if (selVal === '__new__') {
                candCol.classList.add('dl9-p3-col-cand-new');
                const hdrRow = document.createElement('div');
                hdrRow.className = 'dl9-p3-hdrrow';
                const hdrTitle = document.createElement('span');
                hdrTitle.className = 'dl9-p3-hdr-title';
                hdrTitle.textContent = '🆕 Crear nuevo PN';
                hdrRow.appendChild(hdrTitle);
                candCol.appendChild(hdrRow);
                const note = document.createElement('div');
                note.className = 'dl9-p3-meta';
                note.textContent = 'Se creará sin tocar los existentes.';
                candCol.appendChild(note);
                // 1.4.3: filtrar nonFinish también aquí (chips informativos del CSV)
                const csvLabelsCleanN = (r.csvLabels || []).filter(l => !isNonFinishLabel(l, nonFinishListUI));
                for (const lbl of csvLabelsCleanN) {
                  csvChips.appendChild(makeLabelChip(enrichCsvLabel(lbl), null));
                }
                if (!csvLabelsCleanN.length) {
                  csvChips.appendChild(makeEmptyChip('(sin etiquetas de acabado)'));
                }
                return;
              }
              candCol.classList.remove('dl9-p3-col-cand-new');
              const id = parseInt(selVal, 10);
              const c = (r.candidates || []).find(x => x.id === id);
              if (!c) return;
              const isTop = (r.candidates?.[0]?.id === id) && hasStrictTopMatch;
              const hdrRow = document.createElement('div');
              hdrRow.className = 'dl9-p3-hdrrow';
              const hdrTitle = document.createElement('span');
              hdrTitle.className = 'dl9-p3-hdr-title';
              hdrTitle.textContent = `🎯 #${c.id}` + (isTop ? ' (top match)' : '');
              hdrRow.appendChild(hdrTitle);
              if (c.metalBase) hdrRow.appendChild(makeHdrMeta('metal', c.metalBase));
              if (c.quoteIBMS) hdrRow.appendChild(makeHdrMeta('QUOTE_NO (legacy)', c.quoteIBMS));
              candCol.appendChild(hdrRow);
              candCol.appendChild(makeMeta('proc', c.processName || '(sin proceso default)'));

              // 1.4.3: filtrar etiquetas nonFinish (plantas SCM/SMY/STX/... y status)
              // ANTES de pintar chips — esas etiquetas no son acabados y no deberían
              // contar como match/miss visible. Match con equivalencias semánticas
              // (Estaño ≡ Estaño s/Aluminio etc.) vía equivIndexUI.
              const csvLabelsClean = (r.csvLabels || []).filter(l => !isNonFinishLabel(l, nonFinishListUI));
              const candLabelsClean = (c.labels || []).filter(l => !isNonFinishLabel(l, nonFinishListUI));
              const candObjsAll = c.labelObjs || (c.labels || []).map(n => ({ name: n, color: null }));
              const candObjs = candObjsAll.filter(o => !isNonFinishLabel(o.name, nonFinishListUI));
              const candByName = new Map(candObjs.map(o => [o.name, o]));
              const matchInCand = (lbl) => candLabelsClean.some(cl => equivalentValues(equivIndexUI, lbl, cl));
              const matchInCsv = (lbl) => csvLabelsClean.some(cv => equivalentValues(equivIndexUI, lbl, cv));
              for (const lblName of csvLabelsClean) {
                if (matchInCand(lblName)) {
                  // Si existe exactamente igual usamos el color del candidato; si
                  // sólo es equivalente, color del catálogo (puede ser null).
                  const exact = candByName.get(lblName);
                  csvChips.appendChild(makeLabelChip(exact || enrichCsvLabel(lblName), 'match'));
                } else {
                  csvChips.appendChild(makeLabelChip(enrichCsvLabel(lblName), 'miss'));
                }
              }
              if (!csvLabelsClean.length) csvChips.appendChild(makeEmptyChip('(sin etiquetas de acabado)'));

              const candChips = document.createElement('div');
              candChips.className = 'dl9-p3-chips';
              for (const obj of candObjs) {
                const kind = matchInCsv(obj.name) ? 'match' : 'miss';
                candChips.appendChild(makeLabelChip(obj, kind));
              }
              if (!candObjs.length) candChips.appendChild(makeEmptyChip('(sin etiquetas de acabado)'));
              candCol.appendChild(candChips);
            };
            renderCandColumn(initialVal);

            // R4: panel de specs (oculto hasta primer click en "📋 specs")
            const specsPanel = document.createElement('div');
            specsPanel.className = 'dl9-p3-specs';
            specsPanel.style.display = 'none';
            wrap.appendChild(specsPanel);

            const renderSpecsPanel = async (selVal) => {
              specsPanel.replaceChildren();
              // Columna CSV specs (instantáneo)
              const csvSpecsCol = document.createElement('div');
              csvSpecsCol.className = 'dl9-p3-specs-col';
              const csvSpecsHdr = document.createElement('div');
              csvSpecsHdr.className = 'dl9-p3-specs-hdr';
              csvSpecsHdr.textContent = '📄 CSV specs';
              csvSpecsCol.appendChild(csvSpecsHdr);
              const csvSpecsList = document.createElement('div');
              csvSpecsList.className = 'dl9-p3-specs-list';
              csvSpecsList.textContent = r.csvSpecs.length
                ? `(${r.csvSpecs.length}) ${r.csvSpecs.join(' · ')}`
                : '(sin specs en plantilla)';
              csvSpecsCol.appendChild(csvSpecsList);
              specsPanel.appendChild(csvSpecsCol);
              // Columna candidato specs (lazy fetch)
              const candSpecsCol = document.createElement('div');
              candSpecsCol.className = 'dl9-p3-specs-col';
              const candSpecsHdr = document.createElement('div');
              candSpecsHdr.className = 'dl9-p3-specs-hdr';
              if (selVal === '__new__') {
                candSpecsHdr.textContent = '🆕 PN nuevo';
                candSpecsCol.appendChild(candSpecsHdr);
                const note = document.createElement('div');
                note.className = 'dl9-p3-specs-list';
                note.textContent = '(sin specs preexistentes)';
                candSpecsCol.appendChild(note);
                specsPanel.appendChild(candSpecsCol);
                return;
              }
              const pnId = parseInt(selVal, 10);
              candSpecsHdr.textContent = `🎯 #${pnId} specs`;
              candSpecsCol.appendChild(candSpecsHdr);
              const candSpecsList = document.createElement('div');
              candSpecsList.className = 'dl9-p3-specs-list';
              candSpecsList.textContent = 'cargando...';
              candSpecsCol.appendChild(candSpecsList);
              specsPanel.appendChild(candSpecsCol);
              const entry = await fetchCandidateSpecs(pnId);
              if (entry.state === 'error') {
                candSpecsList.textContent = `error — ${entry.err}`;
                candSpecsList.classList.add('dl9-p3-specs-err');
              } else {
                candSpecsList.textContent = entry.specs.length
                  ? `(${entry.specs.length}) ${entry.specs.join(' · ')}`
                  : '(sin specs en este PN)';
              }
            };

            let specsExpanded = false;
            specsBtn.addEventListener('click', () => {
              specsExpanded = !specsExpanded;
              if (specsExpanded) {
                specsPanel.style.display = 'block';
                specsBtn.textContent = '📋 ocultar';
                renderSpecsPanel(sel.value);
              } else {
                specsPanel.style.display = 'none';
                specsBtn.textContent = '📋 specs';
              }
            });

            sel.addEventListener('change', (e) => {
              const idx = parseInt(e.target.dataset.rowIdx, 10);
              const val = e.target.value;
              // 1.2.1: `classification` original (set por classifyOnePN) define el default:
              //   'MODIFY' → default top match; userOverride null si user elige top
              //   'NEW'    → default crear nuevo; userOverride null si user deja NEW
              const origClass = pnStatus[idx].classification;
              if (val === '__new__') {
                pnStatus[idx].userOverride = origClass === 'NEW' ? null : '__new__';
                pnStatus[idx].status = 'new';
                pnStatus[idx].existingId = null;
                pnStatus[idx].existingProcessId = null;
                rows[idx].status = 'new';
                rows[idx].existingId = null;
              } else {
                const newTargetId = parseInt(val, 10);
                const cand = (pnStatus[idx].candidates || []).find(c => c.id === newTargetId);
                const isTopMatch = newTargetId === (pnStatus[idx].candidates?.[0]?.id || null);
                pnStatus[idx].userOverride = (origClass === 'MODIFY' && isTopMatch) ? null : newTargetId;
                pnStatus[idx].status = 'existing';
                pnStatus[idx].existingId = newTargetId;
                pnStatus[idx].existingProcessId = cand?.defaultProcessNodeId || null;
                rows[idx].status = 'existing';
                rows[idx].existingId = newTargetId;
              }
              // 1.4.5: marcar la fila como validada por el operador.
              pnStatus[idx].userDecided = true;
              renderCandColumn(val);
              if (specsExpanded) renderSpecsPanel(val);
              updateHeaderStats();
              // 1.4.3: re-pintar el chip "✓ guardada" / "pendiente" en vivo.
              if (wrap._renderSavedChip) wrap._renderSavedChip();
              if (resumeState) {
                const slot = resumeState.classifications?.[idx];
                if (slot) {
                  slot.userOverride = pnStatus[idx].userOverride;
                  slot.userDecided = true;
                }
                persistResumeState().catch(() => {});
              }
            });
            // 1.4.5: si el usuario hace click en el select (incluso si re-elige
            // la misma opción), también lo tomamos como confirmación explícita.
            // El evento 'change' NO se dispara cuando re-seleccionas la opción
            // ya seleccionada — por eso el bug donde el contador no avanzaba.
            sel.addEventListener('click', (e) => {
              const idx = parseInt(e.target.dataset.rowIdx, 10);
              if (!pnStatus[idx].userDecided) {
                pnStatus[idx].userDecided = true;
                updateHeaderStats();
                if (wrap._renderSavedChip) wrap._renderSavedChip();
                if (resumeState) {
                  const slot = resumeState.classifications?.[idx];
                  if (slot) slot.userDecided = true;
                  persistResumeState().catch(() => {});
                }
              }
            });

            pase3Wrap = wrap;
            // 1.4.3: liberamos el espacio del "👇 decidir abajo" (la fila
            // completa ya está pintada naranja por dl9-row-pending). Mostramos
            // chip "✓ guardado" si el operador ya decidió (userOverride != null);
            // si no, "pendiente". El chip se re-pinta en sel.change.
            const savedChipSlot = document.createElement('span');
            savedChipSlot.className = 'dl9-p3-saved-slot';
            const renderSavedChip = () => {
              savedChipSlot.replaceChildren();
              // 1.4.5: usar userDecided (no userOverride) — ver comentario en línea
              // del contador `decidedNow`.
              if (pnStatus[r.idx]?.userDecided === true) {
                const chip = document.createElement('span');
                chip.className = 'dl9-saved-chip';
                chip.textContent = '✓ validada';
                chip.title = 'Decisión persistida en localStorage; al recargar y elegir REANUDAR vuelve aplicada.';
                savedChipSlot.appendChild(chip);
              } else {
                const chip = document.createElement('span');
                chip.style.cssText = 'font-size:10px;color:#fdba74;font-style:italic';
                chip.textContent = 'pendiente';
                savedChipSlot.appendChild(chip);
              }
            };
            renderSavedChip();
            tdAct.appendChild(savedChipSlot);
            // Hook para re-pintar el chip cuando cambia el select.
            wrap.dataset.savedChipHook = '1';
            wrap._renderSavedChip = renderSavedChip;
          } else if (r.status === 'new') { tdAct.className = 'dl9-new'; tdAct.textContent = 'CREAR NUEVO'; }
          else if (r.status === 'existing') { tdAct.className = 'dl9-exist'; tdAct.textContent = `MODIFICAR (id:${r.existingId})`; }
          else {
            tdAct.className = 'dl9-dup';
            tdAct.textContent = `DUPLICAR${r.archivarAnterior ? ' + ARCHIVAR' : ''} (viejo:${r.existingId})`;
            // 1.2.11 H5: checkbox per-row para override de "archivar anterior".
            // Solo aplica a filas forceDup con archivarAnterior=true en el CSV.
            // - undefined (default): sigue toggle global + flag del CSV
            // - true:                fuerza archivar aunque global esté off
            // - false:               fuerza NO archivar aunque CSV diga true
            // Se renderiza checked si la fila va a archivar en este momento.
            if (r.status === 'forceDup' && r.archivarAnterior) {
              const archLbl = document.createElement('label');
              archLbl.className = 'dl9-archive-row-chk';
              archLbl.title = 'Archivar el PN viejo (id ' + r.existingId + ') al duplicar. Override per-row del toggle global.';
              const archCb = document.createElement('input');
              archCb.type = 'checkbox';
              const part = parts[r.idx];
              const override = part.archiveOverride;
              // Default: si no hay override, sigue el toggle global (state.archiveGlobal)
              // Si global está off y CSV=true, mostrar desmarcado (porque no va a archivar)
              const globalOn = (state.archiveGlobal !== false);
              const willArchive = (override === true) || (override === undefined && globalOn);
              archCb.checked = willArchive;
              const archTxt = document.createTextNode('🗄️ Arch ant');
              archLbl.appendChild(archCb);
              archLbl.appendChild(archTxt);
              if (!willArchive) archLbl.classList.add('dl9-archive-row-off');
              archCb.addEventListener('change', () => {
                const globalOnNow = (state.archiveGlobal !== false);
                // Si el nuevo estado coincide con el default (toggle global + CSV=true),
                // limpiamos el override para que la fila vuelva a seguir al global.
                // Si difiere, fijamos el override explícito.
                if (archCb.checked === globalOnNow) {
                  delete part.archiveOverride;
                } else {
                  part.archiveOverride = archCb.checked;
                }
                if (archCb.checked) archLbl.classList.remove('dl9-archive-row-off');
                else archLbl.classList.add('dl9-archive-row-off');
              });
              tdAct.appendChild(document.createTextNode(' '));
              tdAct.appendChild(archLbl);
            }
          }
          tr.appendChild(tdAct);

          const tdChg = document.createElement('td');
          tdChg.textContent = r.changeSummary;
          tdChg.style.fontSize = '11px';
          tdChg.style.color = '#94a3b8';
          tdChg.style.padding = '3px 6px';
          tr.appendChild(tdChg);

          if (!isSoloPN) {
            const tdQ = document.createElement('td'); tdQ.textContent = r.qty != null ? String(r.qty) : '-';
            tdQ.style.padding = '3px 6px'; tr.appendChild(tdQ);
            const tdP = document.createElement('td'); tdP.textContent = r.precio != null ? String(r.precio) : '-';
            tdP.style.padding = '3px 6px'; tr.appendChild(tdP);
          }

          tbody.appendChild(tr);

          // 1.2.6: fila secundaria full-width con el dropdown + comparación Pase 3.
          // Pegada visualmente al row principal (mismo bg dl9-row-pending) para que
          // sea obvio que "pertenece" al PN de arriba.
          if (pase3Wrap) {
            const tr2 = document.createElement('tr');
            tr2.classList.add('dl9-row-pending');
            const td2 = document.createElement('td');
            td2.colSpan = headerCells.length;
            td2.style.padding = '4px 12px 10px 32px';
            td2.style.borderBottom = '1px solid #1e293b';
            td2.appendChild(pase3Wrap);
            tr2.appendChild(td2);
            tbody.appendChild(tr2);
          }
        }
        modal.querySelector('#dl9-preview-title').textContent =
          `Part Numbers — página ${currentPage + 1} de ${totalPages()} (mostrando ${slice.length} de ${filteredRows.length} filtradas)`;
        modal.querySelector('#dl9-page-info').textContent = `Página ${currentPage + 1} / ${totalPages()}`;
      }

      // Wire up controls
      modal.querySelector('#dl9-flt-status').onchange = (e) => { filterStatus = e.target.value; applyFilters(); };
      modal.querySelector('#dl9-flt-cust').onchange = (e) => { filterCustomer = e.target.value; applyFilters(); };
      // 1.2.11 H5: toggle global de archive. Lee de state.archiveGlobal y al
      // cambiar actualiza state + re-rendea la página para que los checkboxes
      // per-row reflejen el nuevo default (siempre que NO tengan override
      // explícito). El archive flow en STEP 8 ya lee state.archiveGlobal.
      {
        const archGlobalCb = modal.querySelector('#dl9-archive-global');
        const archGlobalLbl = modal.querySelector('#dl9-archive-global-lbl');
        // Sincroniza estado inicial con state.archiveGlobal por si vino de un
        // resume previo (default: undefined → true).
        archGlobalCb.checked = (state.archiveGlobal !== false);
        if (!archGlobalCb.checked) archGlobalLbl.classList.add('dl9-archive-off');
        archGlobalCb.addEventListener('change', () => {
          state.archiveGlobal = archGlobalCb.checked;
          if (archGlobalCb.checked) archGlobalLbl.classList.remove('dl9-archive-off');
          else archGlobalLbl.classList.add('dl9-archive-off');
          // Re-rendea para que los checkboxes per-row sin override sigan el
          // nuevo default visualmente.
          renderPage();
        });
      }
      // 1.3.0: chunk size preview live update (solo COTIZACIÓN+NP). Recalcula
      // cuántas cotizaciones se van a crear: ceil(parts[cliente].length / size)
      // sumado para todos los clientes seleccionados. Solo informativo; el
      // valor se aplica al ejecutar.
      if (!isSoloPN) {
        const chunkInput = modal.querySelector('#dl9-chunksize');
        const chunkPreview = modal.querySelector('#dl9-chunkpreview');
        const recalcChunkPreview = () => {
          const size = Math.max(1, Math.floor(Number(chunkInput.value) || 1));
          // Cuenta líneas por cliente sobre filas seleccionadas
          const perCust = new Map();
          for (const r of rows) {
            if (!selected.has(r.idx)) continue;
            perCust.set(r.customer, (perCust.get(r.customer) || 0) + 1);
          }
          let totalQuotes = 0;
          for (const n of perCust.values()) totalQuotes += Math.ceil(n / size);
          chunkPreview.textContent = `→ ${perCust.size} cliente(s), ${totalQuotes} cotización(es)`;
        };
        chunkInput.addEventListener('input', recalcChunkPreview);
        // Hook: updateSelCount llama onSelChange si está seteado.
        onSelChange = recalcChunkPreview;
        recalcChunkPreview();
      }

      const pendingBtn = modal.querySelector('#dl9-toggle-pending');
      if (pendingBtn) {
        pendingBtn.addEventListener('click', () => {
          filterPendingOnly = !filterPendingOnly;
          pendingBtn.textContent = filterPendingOnly ? 'Mostrar todas' : 'Solo pendientes';
          applyFilters();
        });
      }
      modal.querySelector('#dl9-prev-page').onclick = () => { if (currentPage > 0) { currentPage--; renderPage(); } };
      modal.querySelector('#dl9-next-page').onclick = () => { if (currentPage < totalPages() - 1) { currentPage++; renderPage(); } };
      modal.querySelector('#dl9-sel-page').onclick = () => {
        const start = currentPage * PAGE_SIZE;
        for (const r of filteredRows.slice(start, start + PAGE_SIZE)) selected.add(r.idx);
        renderPage(); updateSelCount();
      };
      modal.querySelector('#dl9-unsel-page').onclick = () => {
        const start = currentPage * PAGE_SIZE;
        for (const r of filteredRows.slice(start, start + PAGE_SIZE)) selected.delete(r.idx);
        renderPage(); updateSelCount();
      };
      modal.querySelector('#dl9-sel-global').onclick = () => {
        // Si son >5k filas filtradas, pedir confirmación
        if (filteredRows.length > 5000 && !confirm(`Vas a seleccionar ${filteredRows.length} filas. ¿Continuar?`)) return;
        for (const r of filteredRows) selected.add(r.idx);
        renderPage(); updateSelCount();
      };
      modal.querySelector('#dl9-unsel-global').onclick = () => {
        for (const r of filteredRows) selected.delete(r.idx);
        renderPage(); updateSelCount();
      };

      // Initial render
      applyFilters();
      updateSelCount();

      modal.querySelector('#dl9-cancel').onclick = () => {
        // 1.4.5: usar userDecided (filas validadas explícitamente por el operador)
        // en vez de userOverride!=null. Antes el banner subestimaba el progreso
        // cuando el usuario aceptaba sugerencias sin override.
        try {
          const decisionsTaken = pnStatus.filter(s => s.userDecided === true).length;
          if (decisionsTaken > 0) {
            alert(
              `Guardé ${decisionsTaken} decisión${decisionsTaken === 1 ? '' : 'es'} en este navegador.\n\n` +
              `Si vuelves a subir EL MISMO CSV te aparecerá el prompt "Corrida previa detectada" — elige REANUDAR y tus decisiones se aplican automáticamente.\n\n` +
              `(Si editas el CSV el runKey cambia y se trata como corrida nueva.)`
            );
          }
        } catch (_) { /* alert es best-effort */ }
        removeOverlay(overlay); resolve(false);
      };
      modal.querySelector('#dl9-exec').onclick = () => {
        // 1.3.0: capturar chunkSize si aplica (solo COTIZACIÓN+NP). El default
        // viene de bulkCfg().chunking.defaultChunkSize. Persiste en state para
        // que execute() y resumeState lo encuentren.
        if (!isSoloPN) {
          const chunkInput = modal.querySelector('#dl9-chunksize');
          const sizeRaw = chunkInput ? parseInt(chunkInput.value, 10) : NaN;
          state.chunkSize = (Number.isFinite(sizeRaw) && sizeRaw >= 1)
            ? sizeRaw
            : bulkCfg().chunking.defaultChunkSize;
        }
        const out = [...selected].sort((a, b) => a - b);
        removeOverlay(overlay);
        resolve(out);
      };
    });
  }

  // 1.4.10: setProgressBar ahora apunta al panel chico (`#sa-bu-bar`). El modal
  // grande `dl9-progress-overlay` fue eliminado — coexistía con el panel y
  // duplicaba info, además de acumular textContent sin recorte (causa raíz del
  // OOM de la pestaña en runs de 4k+ PNs). Mantenemos la firma porcentual para
  // no romper los call-sites que pasan 5/10/30/55/78/85/100.
  function setProgressBar(p) { const b = document.getElementById('sa-bu-bar'); if (b) b.style.width = p + '%'; }

  // V10: search for existing quotes by customer + name
  async function findExistingQuote(customerId, name) {
    try {
      const data = await api().query('AllQuotes', {
        orderBy: ['ID_DESC'], offset: 0, first: 50,
        customerIdFilter: [customerId], searchQuery: name
      });
      const nodes = data?.pagedData?.nodes || [];
      // Exact name match (case insensitive), only non-archived
      const upper = name.toUpperCase();
      return nodes.find(q => q.name?.toUpperCase() === upper && !q.archivedAt) || null;
    } catch (e) {
      warn(`AllQuotes search "${name}" cust ${customerId}: ${String(e).substring(0, 100)}`);
      return null;
    }
  }

  // Modal: ask user what to do when a quote with same name+customer exists
  function showQuoteConflict(customerName, quoteName, existing) {
    return new Promise((resolve) => {
      injectStyles(); const { overlay, modal } = createOverlay();
      modal.style.background = '#1e293b';
      modal.innerHTML = `
        <h2 style="color:#f59e0b">⚠️ Cotización ya existe</h2>
        <p style="color:#e2e8f0;font-size:13px;margin:12px 0">
          Ya existe una cotización con el nombre <b>"${quoteName}"</b> para el cliente <b>${customerName}</b>:
        </p>
        <div style="background:#0f172a;padding:12px;border-radius:6px;margin-bottom:12px;font-size:12px;color:#94a3b8">
          <div><b style="color:#e2e8f0">Cotización #${existing.idInDomain}</b></div>
          <div>Nombre: ${existing.name}</div>
          <div>Creada: ${new Date(existing.createdAt).toLocaleDateString('es-MX')}</div>
        </div>
        <p style="color:#94a3b8;font-size:12px;margin-bottom:12px">¿Qué quieres hacer?</p>
        <div class="dl9-btnrow" style="flex-direction:column;gap:8px">
          <button class="dl9-btn" id="dl9-conflict-modify" style="background:#0d9488;color:white;justify-content:flex-start">
            ✏️ <b>Modificar la existente</b> — re-llena #${existing.idInDomain} con los PNs del CSV
          </button>
          <button class="dl9-btn" id="dl9-conflict-create" style="background:#2563eb;color:white;justify-content:flex-start">
            ➕ <b>Crear una nueva de todas formas</b> — quedarán 2 cotizaciones con el mismo nombre
          </button>
          <button class="dl9-btn" id="dl9-conflict-skip" style="background:#dc2626;color:white;justify-content:flex-start">
            ⏭️ <b>Omitir este cliente</b> — no procesar sus PNs en esta corrida
          </button>
        </div>`;
      document.getElementById('dl9-conflict-modify').onclick = () => { removeOverlay(overlay); resolve('modify'); };
      document.getElementById('dl9-conflict-create').onclick = () => { removeOverlay(overlay); resolve('create'); };
      document.getElementById('dl9-conflict-skip').onclick = () => { removeOverlay(overlay); resolve('skip'); };
    });
  }

  // ─── Reporte XLSX del run ───
  function generateRunReport(state, pnStatus, parts, stats, errors) {
    if (typeof window.XLSX === 'undefined') {
      warn('XLSX no disponible; reporte saltado.');
      return null;
    }
    const wb = window.XLSX.utils.book_new();

    // ── Hoja Resumen ──
    // 1.2.0: el default del Pase 3 ahora es MODIFY al top match (R2). Las stats
    // distinguen 3 sub-casos: default (no tocó), override-MODIFY (cambió a otro
    // candidato), override-NEW (eligió Crear nuevo).
    const counts = {
      total: pnStatus.length,
      newClean: pnStatus.filter(s => s.classification === 'NEW' && s.pase == null).length,
      pase1: pnStatus.filter(s => s.pase === 1).length,
      pase2: pnStatus.filter(s => s.pase === 2).length,
      // 1.2.1: Pase 3 ahora tiene 2 defaults distintos.
      //   default MODIFY: classification=MODIFY (etiquetas matchean) + userOverride=null
      //   default NEW:    classification=NEW    (etiquetas distintas)  + userOverride=null
      pase3DefaultModify: pnStatus.filter(s => s.pase === 3 && s.classification === 'MODIFY' && s.userOverride == null && s.status === 'existing').length,
      pase3DefaultNew: pnStatus.filter(s => s.pase === 3 && s.classification === 'NEW' && s.userOverride == null && s.status === 'new').length,
      pase3OverrideModify: pnStatus.filter(s => s.pase === 3 && s.userOverride != null && s.userOverride !== '__new__' && s.status === 'existing').length,
      pase3OverrideNew: pnStatus.filter(s => s.pase === 3 && s.userOverride === '__new__' && s.status === 'new').length,
      errors: errors.length,
      omitidas: stats?.omitidas || 0,
    };
    const resumenAoa = [
      ['Métrica', 'Conteo'],
      ['PNs procesados', counts.total],
      ['NEW limpios (sin candidatos)', counts.newClean],
      ['MODIFY Pase 1 (IBMS)', counts.pase1],
      ['MODIFY Pase 2 (composite)', counts.pase2],
      ['MODIFY Pase 3 (default — top match, etiquetas iguales)', counts.pase3DefaultModify],
      ['NEW Pase 3 (default — etiquetas distintas)', counts.pase3DefaultNew],
      ['MODIFY Pase 3 (override a candidato)', counts.pase3OverrideModify],
      ['NEW Pase 3 (override Crear nuevo)', counts.pase3OverrideNew],
      ['Errores', counts.errors],
      ['Omitidas', counts.omitidas],
    ];
    const wsResumen = window.XLSX.utils.aoa_to_sheet(resumenAoa);
    window.XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // ── Hoja Decisiones Pase 3 ──
    const pase3Headers = [
      'CSVRow', 'PN', 'Cliente', 'QuoteIBMS_CSV', 'MetalBase_CSV', 'Acabados_CSV',
      'DecisionFinal', 'CandidatoElegido', 'CandidatoLink',
      'Candidato1', 'Candidato2', 'Candidato3',
    ];
    const pase3Rows = [pase3Headers];
    pnStatus.forEach((s, i) => {
      if (s.pase !== 3) return;
      // 1.2.0: decisión final basada en status (no en userOverride), porque el
      // default Pase 3 ahora es MODIFY al top match y userOverride==null ya
      // implica MODIFY al candidato top.
      const decision = s.status === 'existing' ? 'MODIFY' : 'NEW';
      const chosen = decision === 'MODIFY' ? (s.existingId || '') : '';
      const link = chosen ? `https://app.gosteelhead.com/PartNumbers/${chosen}` : '';
      pase3Rows.push([
        i + 1, s.pn, s.customerId,
        parts[i]?.quoteIBMS || '',
        parts[i]?.metalBase || '',
        (parts[i]?.labels || []).join(','),
        decision, chosen, link,
        s.candidates?.[0]?.id || '',
        s.candidates?.[1]?.id || '',
        s.candidates?.[2]?.id || '',
      ]);
    });
    const wsPase3 = window.XLSX.utils.aoa_to_sheet(pase3Rows);
    window.XLSX.utils.book_append_sheet(wb, wsPase3, 'Decisiones Pase 3');

    // ── Hoja Errores ──
    const erroresAoa = [['Mensaje']].concat(errors.map(e => [typeof e === 'string' ? e : (e?.message || JSON.stringify(e))]));
    const wsErrores = window.XLSX.utils.aoa_to_sheet(erroresAoa);
    window.XLSX.utils.book_append_sheet(wb, wsErrores, 'Errores');

    // Descargar
    const runKey = state?.runKey || resumeState?.runKey || 'no-key';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fname = `bulk-upload-report-${String(runKey).slice(0, 8)}-${ts}.xlsx`;
    const wbout = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    log(`Reporte XLSX descargado: ${fname}`);
    return fname;
  }

  function showResult(stats, quoteUrl, errors, quoteUrlLabel) {
    // Fix J 1.3.2: remover overlays previos (resultado anterior) antes de crear uno
    // nuevo. Antes (≤1.3.1) re-ejecuciones consecutivas apilaban modales de
    // resultado y el botón CERRAR solo cerraba el último por id duplicado.
    // 1.4.10: el `dl9-progress-overlay` fue eliminado (consolidación al panel chico).
    const prevResult = document.getElementById('dl9-result-overlay'); if (prevResult) removeOverlay(prevResult);
    injectStyles(); const { overlay, modal } = createOverlay();
    overlay.id = 'dl9-result-overlay';
    const errH = errors.length ? `<h3 class="dl9-err">Errores (${errors.length})</h3><div style="max-height:150px;overflow-y:auto;font-size:12px;color:#f87171;white-space:pre-wrap">${errors.join('\n')}</div>` : '';
    const lbl = quoteUrlLabel || 'ABRIR COTIZACIÓN';
    modal.innerHTML = `<h2>${errors.length ? 'Completado con errores' : 'Completado OK'}</h2><div class="dl9-stats"><div class="dl9-stat"><b>Quote:</b> ${stats.quoteName} (#${stats.quoteIdInDomain})</div><div class="dl9-stat"><b>PNs creados:</b> ${stats.pnsCreated}</div><div class="dl9-stat"><b>PNs existentes:</b> ${stats.pnsExisting}</div><div class="dl9-stat"><b>Duplicados:</b> ${stats.pnsDuplicated}</div><div class="dl9-stat"><b>Products:</b> ${stats.productsSet}</div><div class="dl9-stat"><b>Labels:</b> ${stats.labelsSet}</div><div class="dl9-stat"><b>Specs:</b> ${stats.specsSet}</div><div class="dl9-stat"><b>UnitConv:</b> ${stats.unitConvSet}</div><div class="dl9-stat"><b>Racks:</b> ${stats.racksSet}</div><div class="dl9-stat"><b>CI:</b> ${stats.ciSet}</div><div class="dl9-stat"><b>Dims:</b> ${stats.dimsSet}</div><div class="dl9-stat"><b>PredUsage:</b> ${stats.predictiveSet}</div><div class="dl9-stat"><b>Default Price:</b> ${stats.defaultPriceSet}</div><div class="dl9-stat"><b>Archivados:</b> ${stats.archived}</div><div class="dl9-stat"><b>Ant.archivados:</b> ${stats.oldArchived}</div><div class="dl9-stat"><b>Valid.1erRecibo:</b> ${stats.validacionSet}</div></div>${errH}<div class="dl9-btnrow"><button class="dl9-btn dl9-btn-copy" id="dl9-copy-log">COPIAR LOG</button>${quoteUrl ? `<button class="dl9-btn dl9-btn-exec" id="dl9-open-quote">${lbl}</button>` : ''}<button class="dl9-btn dl9-btn-close" id="dl9-close">CERRAR</button></div>`;
    // 1.4.18 Fix BB: scope a `modal.querySelector` (no `document.getElementById`) + null
    // guards. Antes, en runs grandes el outer catch capturaba "Cannot set properties of
    // null (setting 'onclick')" tras completar el pipeline: el árbol React de Steelhead
    // re-reconcilia agresivamente y puede desreferenciar elementos por id global aunque
    // sigan vivos dentro del modal nuestro. modal.querySelector busca dentro del nodo
    // que acabamos de crear, inmune al churn externo.
    if (quoteUrl) {
      const openBtn = modal.querySelector('#dl9-open-quote');
      if (openBtn) openBtn.addEventListener('click', () => {
        // V10: navega en la pestaña actual (Steelhead es SPA, evita perder contexto)
        window.location.href = quoteUrl;
      });
      else warn('showResult: #dl9-open-quote no encontrado (esperado tras quoteUrl truthy).');
    }
    const closeBtn = modal.querySelector('#dl9-close');
    if (closeBtn) closeBtn.onclick = () => removeOverlay(overlay);
    else warn('showResult: #dl9-close no encontrado en modal.');
    const copyBtn = modal.querySelector('#dl9-copy-log');
    if (copyBtn) copyBtn.onclick = () => { navigator.clipboard.writeText(api().getLog().join('\n')).then(() => alert('Log copiado.')).catch(() => { const w = window.open('', '_blank'); w.document.write('<pre>' + api().getLog().join('\n') + '</pre>'); }); };
    else warn('showResult: #dl9-copy-log no encontrado en modal.');
  }

  // ═══════════════════════════════════════════
  // MAIN PIPELINE — 9 STEPS
  // ═══════════════════════════════════════════

  async function execute(csvText) {
    const DOMAIN = api().getDomain();
    const errors = [];
    const stats = { quoteName: '', quoteIdInDomain: 0, pnsCreated: 0, pnsExisting: 0, pnsDuplicated: 0, productsSet: 0, labelsSet: 0, specsSet: 0, unitConvSet: 0, racksSet: 0, ciSet: 0, dimsSet: 0, defaultPriceSet: 0, archived: 0, oldArchived: 0, predictiveSet: 0, validacionSet: 0 };

    // Cancellation token + panel: cada corrida obtiene un runId monotónico que
    // se propaga a runPool, withRetry, checkPNExistence y demás helpers async.
    const myRunId = nextRunId();
    // Fix G 1.3.2: liberar resumeState heredado del closure de corridas previas en la
    // misma página. Sin esto, una segunda corrida (sin reload) arrastra completedChunks
    // y completedPNs en memoria aunque localStorage esté limpio — el bloque
    // `if (!resumeState)` de línea 2271 nunca entra y el state queda con datos viejos.
    resumeState = null;
    try { showPanel(); } catch (_) {}
    // 1.4.19: cortar Datadog session replay antes de empezar — su sample_rate=100
    // graba toda respuesta GraphQL y satura el heap en runs > 1000 PNs (root cause
    // del OOM nocturno verificado con heap snapshots 2026-05-23).
    stopDatadogSessionReplay();
    setPanelPhase('Iniciando...');
    setPanelProgress(0, 0);
    setPanelCounters();

    try {
      log('Steelhead Automator v9 — iniciando...');

      // Parse CSV
      const csvClean = csvText.replace(/^\uFEFF/, '');
      const { header, parts } = parseRows(parseCSV(csvClean));
      // 1.2.13: exponer parts en state para snippets diagnósticos. STEPs
      // posteriores siguen mutando el array local (filtered/filteredParts), y
      // ese mismo array vive en state.parts porque es la misma referencia.
      state.parts = parts;
      log(`CSV: ${parts.length} partes, header: ${Object.keys(header).join(', ')}`);
      if (!parts.length) throw new Error('No se encontraron filas de datos.');

      const modo = (header.modo || '').toUpperCase();
      const isSoloPN = modo.includes('SOLO');
      const quoteName = header.quoteName || '';
      if (!isSoloPN) {
        if (!quoteName) throw new Error('Falta "Nombre Cotización/Layout" en header.');
        const sinQty = parts.filter(p => p.qty === null);
        if (sinQty.length) throw new Error(`Modo COTIZACIÓN+NP requiere Cantidad en todas las filas. ${sinQty.length} filas sin cantidad: ${sinQty.slice(0, 3).map(p => p.pn).join(', ')}...`);
      }
      stats.quoteName = isSoloPN ? '(SOLO_PN)' : quoteName;
      log(`Modo: ${isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP'} ${isSoloPN ? '' : '— "' + quoteName + '"'}`);

      // ── Fix 7: detección de corrida previa por sha256(csvText) ──
      // Si encuentro progreso previo de ESTE mismo CSV, ofrezco resume.
      // Si el usuario edita el CSV entre runs, el runKey cambia y se trata como
      // corrida nueva (intencional — el resume sólo cuadra con CSV idéntico).
      purgeOldResumeStates();
      const runKey = await computeRunKey(csvClean);
      const prev = loadResumeStateByKey(runKey);
      let resumeCompletedSet = new Set();
      // 1.4.11: identificadores ya commiteados (Call A del Split A/B) en corridas previas.
      let resumeIdentifierSet = new Set();
      if (prev && prev.phase && prev.phase !== 'done') {
        const decision = await askResumeOrFresh(prev);
        if (decision === 'cancel') {
          hidePanel();
          log('Cancelado por usuario en modal de resume.');
          return;
        }
        if (decision === 'resume') {
          resumeState = prev;
          resumeState.lastUpdatedAt = new Date().toISOString();
          resumeCompletedSet = new Set(prev.completedPNs || []);
          resumeIdentifierSet = new Set(prev.identifierEnrichDone || []);
          log(`Reanudando corrida previa — fase: ${prev.phase}, ${resumeCompletedSet.size} PNs ya completados, ${resumeIdentifierSet.size} con identificadores commiteados.`);
        } else {
          // 'fresh' — borrar progreso previo
          deleteResumeStateByKey(runKey);
        }
      }
      if (!resumeState) {
        resumeState = {
          runKey,
          csvFirstLineHash: (csvClean.split('\n')[0] || '').substring(0, 80),
          startedAt: new Date().toISOString(),
          mode: isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP',
          customerScope: '', // se llena más abajo cuando conozcamos clientes únicos
          phase: 'init',
          completedPNs: [],
          failedPNs: [],
          quoteId: null,
          quoteAction: null,
          classifications: null,
          // 1.3.0: chunkSize lockeado en la corrida original. Si el usuario hace
          // resume, las fronteras de chunks se respetan (mismo tamaño → mismas
          // particiones contiguas). En isSoloPN queda null (no aplica).
          chunkSize: isSoloPN ? null : (state.chunkSize || bulkCfg().chunking.defaultChunkSize),
          // 1.3.0: chunks completados por cliente. Mapa cid (string) → number[].
          // Cada chunk se marca al final de su pipeline (UpdateQuote ok).
          completedChunks: {},
          // 1.4.8: pnIds cuyo archive de specs sentinel pre-cotización (STEP 5)
          // ya quedó OK. Se persiste cada N=100 y permite que un resume tras
          // crash OOM saltee los pnIds ya procesados en vez de re-correr los
          // ~5879 sentinels desde cero (idempotente pero caro: ~10 min de
          // SavePartNumber no-ops + buffers GraphQL que dispararon OOM).
          archivedSentinelsPreQuote: [],
          // 1.4.11: STEP 6 split A/B. Call A persiste identificadores
          // (labels + customInputs.BaseMetal + customInputs.QuoteIBMS + name +
          // customerId) ANTES de Call B (specs/params/dims/archive/processNode).
          // Si truena entre A y B, el siguiente resume corre classifyPNs sobre
          // un catálogo donde los PNs ya tienen labels y QuoteIBMS — los pases
          // 1/2 de classifyOnePN matchean correcto en vez de caer a "NEW" y
          // duplicar PNs. Lista de rowKeys "idx|pn|customerId" que ya pasaron A.
          identifierEnrichDone: [],
          // 1.4.24 Fix EE: lista de rowKeys que ya completaron STEP 6b
          // (Sync params spec). Antes, STEP 6b siempre arrancaba desde 0 en
          // cada reanudación → re-procesaba GetPartNumber + AddParams sobre
          // PNs ya completos (silent-skip 23P01 pero igual ~1.6 MB/PN por
          // Apollo cache). Para CSVs > 3000 PNs, eso disparaba OOM en
          // cada ciclo aunque solo faltaran ~200 PNs reales.
          syncParamsCompletedPNs: [],
          lastUpdatedAt: new Date().toISOString(),
        };
        await persistResumeState();
      } else {
        // Resume: si la corrida previa no tenía chunkSize (pre-1.3.0) y estamos
        // en COTIZACIÓN+NP, hidratar desde state o default. Esto evita partir un
        // resume "fresco" en chunks distintos a la corrida original.
        if (!isSoloPN && resumeState.chunkSize == null) {
          resumeState.chunkSize = state.chunkSize || bulkCfg().chunking.defaultChunkSize;
        }
        if (!resumeState.completedChunks) resumeState.completedChunks = {};
        // 1.4.8: hidratar lista de sentinels archivados si la corrida es pre-1.4.8.
        if (!Array.isArray(resumeState.archivedSentinelsPreQuote)) {
          resumeState.archivedSentinelsPreQuote = [];
        }
        // 1.4.11: hidratar lista de identifier-enriched si la corrida es pre-1.4.11.
        if (!Array.isArray(resumeState.identifierEnrichDone)) {
          resumeState.identifierEnrichDone = [];
        }
        // 1.4.24 Fix EE: hidratar set de STEP 6b si la corrida es pre-1.4.24.
        if (!Array.isArray(resumeState.syncParamsCompletedPNs)) {
          resumeState.syncParamsCompletedPNs = [];
        }
      }

      // ── V10: Validate required per-line fields ──
      const sinCliente = parts.filter(p => !p.cliente);
      if (sinCliente.length) throw new Error(`${sinCliente.length} filas sin Cliente: ${sinCliente.slice(0, 3).map(p => p.pn).join(', ')}...`);
      // Proceso: vacío = copiar del PN existente (resuelto tras existence check).
      //          "-" = borrar (set null). Nombre = resolver a id.
      //          Validación per-row contra new/existing en el post-process tardío.

      // ── Resolve all unique customers (per-line, with cache) ──
      const customerCache = new Map(); // name → { id, name, addressId, contactId, invoiceTermsId }
      const uniqueClientNames = [...new Set(parts.map(p => p.cliente.split(/\s*[\u2014\u2013]\s*|\s+[-]\s+/)[0].trim()))];
      log(`Clientes únicos en layout: ${uniqueClientNames.length}`);
      // 1.4.12: loop secuencial con feedback en panel (antes silent).
      setPanelPhase(`Resolviendo clientes (${uniqueClientNames.length})`);
      setPanelProgress(0, uniqueClientNames.length);
      {
        let custDone = 0;
        for (const cname of uniqueClientNames) {
          bailIfStale(myRunId);
          setPanelSubPhase(`Cliente: ${cname}`);
          const custData = await api().query('CustomerSearchByName', { nameLike: `%${cname}%`, orderBy: ['NAME_ASC'] });
          const custNodes = custData?.searchCustomers?.nodes || custData?.pagedData?.nodes || custData?.allCustomers?.nodes || [];
          const customer = custNodes.find(c => c.name?.toUpperCase().includes(cname.toUpperCase()));
          if (!customer) throw new Error(`Cliente "${cname}" no encontrado.`);
          const cid = customer.id;
          const relData = await api().query('GetQuoteRelatedData', { customerId: cid });
          const addr = relData?.customerById?.customerAddressesByCustomerId?.nodes || [];
          const cont = relData?.customerById?.customerContactsByCustomerId?.nodes || [];
          let invTerms = null;
          try { const fin = await api().query('CustomerFinancialByCustomerId', { id: cid }, 'CustomerFinancialById'); invTerms = fin?.customerById?.invoiceTermsId || null; } catch (_) {}
          if (!invTerms) {
            try { const t = await api().query('SearchInvoiceTerms', { termsLike: '%%' }); const tn = t?.allInvoiceTerms?.nodes || t?.pagedData?.nodes || t?.searchInvoiceTerms?.nodes || []; if (tn.length) invTerms = tn[0].id; } catch (_) {}
          }
          customerCache.set(cname, { id: cid, name: customer.name, addressId: addr[0]?.id || null, contactId: cont[0]?.id || null, invoiceTermsId: invTerms });
          log(`  "${cname}" → ${customer.name} (id:${cid})`);
          custDone++;
          setPanelProgress(custDone, uniqueClientNames.length);
        }
      }

      // ── Assignee ──
      let assigneeId = null, assigneeName = '';
      if (header.asignado) {
        const ud = await api().query('SearchUsers', { searchQuery: header.asignado, first: 500 });
        const un = ud?.searchUsers?.nodes || ud?.pagedData?.nodes || [];
        const u = un.find(u => (u.name || u.fullName || '').toUpperCase().includes(header.asignado.toUpperCase()));
        if (u) { assigneeId = u.id; assigneeName = u.name || u.fullName || ''; }
        else warn(`Asignado "${header.asignado}" no encontrado.`);
      }
      log(`  Asignado: ${assigneeName || '(ninguno)'}`);

      // ── V10: NO header default process — process must come from each line ──

      // ── Catalogs ──
      log('Cargando catálogos...');
      // V10: AllSpecs paginado en lugar de SearchSpecsForSelect — sin límite oculto y trae fields embebidos.
      async function fetchAllSpecsFull() {
        const all = []; const PAGE = 400; let offset = 0;
        while (true) {
          bailIfStale(myRunId);
          let d;
          try {
            d = await api().query('AllSpecs', { includeArchived: 'NO', orderBy: ['ID_IN_DOMAIN_ASC'], offset, first: PAGE, searchQuery: '' });
          } catch (e) { warn(`AllSpecs offset ${offset}: ${String(e).substring(0, 100)}`); break; }
          const nodes = d?.pagedData?.nodes || [];
          all.push(...nodes);
          if (nodes.length < PAGE) break;
          offset += PAGE;
          if (offset > 50000) break;
        }
        return all;
      }
      const [labelsD, specsAll, racksD, unitsD, productsD, groupsD] = await Promise.all([
        api().query('AllLabels', { condition: { forPartNumber: true } }),
        fetchAllSpecsFull(),
        api().query('AllRackTypes', {}),
        api().query('SearchUnits', {}),
        api().query('SearchProducts', { searchQuery: '%%', first: 500 }),
        api().query('PartNumberGroupSelect', { partNumberGroupLike: '%%', first: 500 }, 'PNGroupSelect').catch(() => api().query('PartNumberGroupSelect', {}, 'PNGroupSelect')).catch(() => null),
      ]);

      const labelByName = new Map(); for (const l of (labelsD?.allLabels?.nodes || [])) labelByName.set(l.name, l.id);
      // 1.2.10: preflight de etiquetas — reportar nombres de label en CSV que no existen
      // en el catálogo de Steelhead. Antes (≤1.2.9) se descartaban silenciosamente en
      // enrichWorker vía .filter(Boolean). Esto NO aborta la corrida; solo loguea para
      // que el operador vea el problema antes del exec.
      const unknownLabelNames = new Set();
      for (const p of parts) {
        if (!Array.isArray(p.labels)) continue;
        if (p.labels.length === 1 && isDash(p.labels[0])) continue;
        for (const n of p.labels) {
          if (n && !isDash(n) && !labelByName.has(n)) unknownLabelNames.add(n);
        }
      }
      if (unknownLabelNames.size > 0) {
        const list = [...unknownLabelNames].slice(0, 10).join(', ');
        const more = unknownLabelNames.size > 10 ? ` (+${unknownLabelNames.size - 10} más)` : '';
        warn(`⚠️ ${unknownLabelNames.size} etiqueta(s) en el CSV no existen en el catálogo de Steelhead: ${list}${more}. Las filas afectadas se cargarán SIN esas etiquetas y aparecerán en el reporte de errores.`);
      }
      const specByName = new Map(); for (const s of specsAll) if (s?.name) specByName.set(s.name, s);
      const rackTypeByName = new Map(); for (const rt of (racksD?.pagedData?.nodes || racksD?.allRackTypes?.nodes || [])) rackTypeByName.set(rt.name, rt);
      unitNodes = unitsD?.pagedData?.nodes || unitsD?.searchUnits?.nodes || [];
      // V10: build unitById map for Espesor mils support
      const unitById = new Map();
      for (const u of unitNodes) unitById.set(u.id, u);
      const productByName = new Map(); for (const p of (productsD?.searchProducts?.nodes || productsD?.pagedData?.nodes || [])) productByName.set(p.name, p);
      const groupByName = new Map();
      if (groupsD) { const gn2 = groupsD?.allPartNumberGroups?.nodes || groupsD?.pagedData?.nodes || groupsD?.partNumberGroups?.nodes || []; for (const gg of gn2) groupByName.set(gg.name, gg.id); }
      log(`  ${labelByName.size} labels, ${specByName.size} specs, ${rackTypeByName.size} racks, ${unitNodes.length} units, ${productByName.size} products, ${groupByName.size} groups`);

      // V10: Resolve all per-line processes to IDs (with cache)
      // Vacío y "-" se saltan aquí; se resuelven en post-process tras el existence check.
      const processCache = new Map(); // name → id
      const uniqueProcessNames = [...new Set(parts.map(p => p.procesoOverride).filter(n => n && !isDash(n)))];
      log(`Procesos únicos en layout: ${uniqueProcessNames.length}`);
      // 1.4.12: feedback en panel (antes silent).
      if (uniqueProcessNames.length) {
        setPanelPhase(`Resolviendo procesos (${uniqueProcessNames.length})`);
        setPanelProgress(0, uniqueProcessNames.length);
      }
      {
        let procDone = 0;
        for (const pname of uniqueProcessNames) {
          bailIfStale(myRunId);
          setPanelSubPhase(`Proceso: ${pname}`);
          const pd = await api().query('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: `%${pname}%`, first: 50 });
          const pn2 = pd?.allProcessNodes?.nodes || pd?.pagedData?.nodes || [];
          const pr = pn2.find(p => p.name?.toUpperCase() === pname.toUpperCase()) || pn2.find(p => p.name?.toUpperCase().includes(pname.toUpperCase()));
          if (!pr) throw new Error(`Proceso "${pname}" no encontrado en Steelhead.`);
          processCache.set(pname, pr.id);
          procDone++;
          setPanelProgress(procDone, uniqueProcessNames.length);
        }
      }
      // Annotate each part with its resolved processId and customerId
      for (const p of parts) {
        // null marker para vacío y "-" — se resuelven en post-process tras pnStatus
        p.processId = (!p.procesoOverride || isDash(p.procesoOverride)) ? null : processCache.get(p.procesoOverride);
        const cname = p.cliente.split(/\s*[\u2014\u2013]\s*|\s+[-]\s+/)[0].trim();
        const cust = customerCache.get(cname);
        p.customerId = cust.id;
        p.customerName = cust.name;
        p.customerAddressId = cust.addressId;
        p.customerContactId = cust.contactId;
        p.customerInvoiceTermsId = cust.invoiceTermsId;
      }

      // 1.2.11: detectar duplicados internos del CSV (mismo PN+customer en 2+ filas).
      // Steelhead permite múltiples PNs con (name, customerId) — son PNs físicos
      // distintos con mismo nombre. El flag se usa para info de UI (chip rojo en
      // preview) y para decidir Capa A/B en SavePartNumber (serializar la creación
      // de NEWs duplicados para evitar race en INSERT concurrente).
      {
        const { dupGroups, dupRows } = detectCsvDuplicates(parts);
        if (dupGroups) log(`  Duplicados internos del CSV detectados: ${dupGroups} grupos, ${dupRows} fila(s) extra`);
      }

      // Load dimension value maps (Línea/Departamento → ID)
      const dimValueMap = new Map(); // "valor" → id
      const dimIds = DOMAIN.dimensionIds || {};
      // 1.4.12: feedback en panel (típicamente 3-5 dims, corto pero consistente).
      const dimEntries = Object.entries(dimIds);
      if (dimEntries.length) {
        setPanelPhase(`Cargando dimensiones contables (${dimEntries.length})`);
        setPanelProgress(0, dimEntries.length);
      }
      {
        let dimDone = 0;
        for (const [dimKey, dimId] of dimEntries) {
          bailIfStale(myRunId);
          setPanelSubPhase(`Dimensión: ${dimKey}`);
          try {
            const dd = await api().query('GetDimension', { id: dimId, includeArchived: 'NO' });
            const nodes = dd?.acctDimensionById?.acctDimensionCustomValuesByDimensionId?.nodes || [];
            for (const n of nodes) { if (n.value && !n.archivedAt) dimValueMap.set(n.value.trim(), n.id); }
          } catch (_) {}
          dimDone++;
          setPanelProgress(dimDone, dimEntries.length);
        }
      }
      log(`  ${dimValueMap.size} dimensiones contables cargadas`);

      // Group resolver
      async function resolveGroupId(name) {
        if (!name) return null; const n = name.trim(); if (!n) return null;
        const existing = groupByName.get(n); if (existing) return existing;
        try {
          // Try {input:{name}} first, fallback to {name} if schema changed
          let res;
          try { res = await api().query('CreatePartNumberGroup', { input: { name: n } }); }
          catch (_) { res = await api().query('CreatePartNumberGroup', { name: n }); }
          const id = res?.createPartNumberGroup?.partNumberGroup?.id;
          if (id) { groupByName.set(n, id); log(`  Grupo "${n}" creado id:${id}`); return id; }
        } catch (e) { warn(`Crear grupo "${n}": ${String(e).substring(0, 100)}`); }
        return null;
      }

      // Spec fields cache — V10: AllSpecs ya trajo los fields embebidos, sin más queries
      const uniqueSpecs = new Set(); for (const p of parts) for (const s of p.specs) uniqueSpecs.add(s.name);
      const sfCache = new Map();
      // 1.4.12: feedback en panel (antes silent en runs con muchos specs únicos).
      const specCount = uniqueSpecs.size;
      if (specCount) {
        setPanelPhase(`Cargando definiciones de specs (${specCount})`);
        setPanelProgress(0, specCount);
      }
      {
        let specDone = 0;
        for (const sn of uniqueSpecs) {
          bailIfStale(myRunId);
          if (isDash(sn)) { specDone++; setPanelProgress(specDone, specCount); continue; }
          const si = specByName.get(sn); if (!si) { warn(`Spec "${sn}" no encontrada.`); specDone++; setPanelProgress(specDone, specCount); continue; }
          setPanelSubPhase(`Spec: ${sn}`);
          if (!sfCache.has(si.id)) {
            // V10: AllSpecs embed no devuelve params para todos los field types (e.g. DROPDOWN
            // viene vacío). SpecFieldsAndOptions sí trae el shape completo (mismo que usa
            // spec-migrator y está validado). Costo: N queries por upload, pero N suele ser < 10.
            try {
              const d = await api().query('SpecFieldsAndOptions', { specId: si.id }, 'SpecFieldsAndOptions');
              const sd = d?.specById; if (sd) { sfCache.set(si.id, sd); log(`  Spec "${sn}": ${sd.specFieldSpecsBySpecId?.nodes?.length || 0} campos`); }
            } catch (e) { warn(`Spec "${sn}" fields: ${String(e).substring(0, 100)}`); }
          }
          specDone++;
          setPanelProgress(specDone, specCount);
        }
      }

      // ── PN existence check ──
      bailIfStale(myRunId);
      // 1.4.21 Fix CC v3 (opción B): si tenemos resumeState con classifications
      // completos para todos los parts, saltar classifyPNs (que dispara prefetch
      // global de ~22k PNs activos + 24k archivados, ~1.7GB baseline). El resume
      // ya tiene targetPnId + existingProcessId + classification de cada fila;
      // reconstruimos pnStatus desde ahí sin tocar la red.
      let pnStatus;
      // 1.4.23 Fix DD: parts[i].csvRowKey es undefined — el shape de parts viene
      // de parseRows() y no incluye csvRowKey (ese campo solo nace dentro de
      // classifyOnePN, línea 1379). Reconstruimos el key esperado con la misma
      // fórmula para que la comparación sea real. Antes el fast-path nunca
      // aplicaba porque `c.csvRowKey === undefined` siempre era false.
      const canSkipPrefetch =
        resumeState?.classifications?.length === parts.length &&
        parts.length > 0 &&
        resumeState.classifications.every((c, i) => {
          const expectedKey = `${(parts[i].pn || '').toUpperCase()}|${parts[i].customerId}`;
          return c &&
            c.csvRowKey === expectedKey &&
            c.classification != null &&
            (c.classification === 'NEW' || c.targetPnId != null) &&
            // Si el PN va a MODIFY, necesitamos existingProcessId para no romper
            // STEP 6/8. Pre-1.4.21 no se guardaba → forzar full classifyPNs como
            // migración. Post-1.4.21 sí.
            (c.classification === 'NEW' || c.existingProcessId !== undefined);
        });
      if (canSkipPrefetch) {
        log(`Resume detectado con classifications completas — saltando prefetch global (ahorro ~1.7GB baseline).`);
        pnStatus = resumeState.classifications.map((c, i) => {
          const isExisting = c.classification !== 'NEW' && c.targetPnId != null;
          return {
            csvRowKey: c.csvRowKey,
            classification: c.classification,
            pase: c.pase || null,
            targetPnId: c.targetPnId || null,
            userOverride: c.userOverride || null,
            userDecided: !!c.userDecided,
            candidates: (c.candidates || []).map(id => ({ id })),
            status: isExisting ? 'existing' : 'new',
            existingId: isExisting ? c.targetPnId : null,
            existingProcessId: c.existingProcessId || null,
          };
        });
      } else {
        pnStatus = await checkPNExistence(parts, myRunId);
      }
      // 1.2.13: exponer pnStatus en state para snippets diagnósticos.
      state.pnStatus = pnStatus;

      // ── Restaurar userOverrides + userDecided previos ANTES de pisar el snapshot ──
      // Si el usuario ya eligió candidatos en un preview previo (Pase 3 dropdown),
      // los recuperamos del resumeState antes de sobreescribir classifications.
      const prevOverrides = new Map();
      const prevDecided = new Set();
      if (resumeState?.classifications) {
        for (const slot of resumeState.classifications) {
          if (slot.userOverride != null) prevOverrides.set(slot.csvRowKey, slot.userOverride);
          if (slot.userDecided === true) prevDecided.add(slot.csvRowKey);
        }
      }
      for (let i = 0; i < pnStatus.length; i++) {
        const ov = prevOverrides.get(pnStatus[i].csvRowKey);
        if (ov != null) {
          pnStatus[i].userOverride = ov;
          if (ov === '__new__') {
            pnStatus[i].status = 'new';
            pnStatus[i].existingId = null;
            pnStatus[i].existingProcessId = null;
          } else {
            pnStatus[i].existingId = ov;
            pnStatus[i].status = 'existing';
          }
        }
        // 1.4.5: restaurar userDecided independiente de userOverride.
        if (prevDecided.has(pnStatus[i].csvRowKey)) {
          pnStatus[i].userDecided = true;
        }
      }

      // 1.2.10: defensa en profundidad — overrides del usuario (preview previo
      // o dropdown actual al regresar de resume) pueden re-introducir colisiones
      // que dedupModifyTargets ya había resuelto en classifyPNs. Re-aplicar el
      // dedup mantiene la invariante "no se puede modificar el mismo id dos
      // veces" sin importar cómo llegamos al estado actual. Si el usuario
      // intencionalmente override-ó dos filas al mismo id, dedup reparte al
      // segundo entre candidatos disponibles o lo demota a NEW.
      const dedup2 = dedupModifyTargets(pnStatus, (bulkCfg().nonFinishLabelNames || []), buildEquivIndex(bulkCfg().metalEquivalents));
      if (dedup2.reassigned || dedup2.demoted) {
        warn(`Dedup post-overrides: ${dedup2.reassigned} re-asignaciones, ${dedup2.demoted} demotadas a NEW por conflicto`);
      }

      // Persist classifications (con overrides ya re-aplicados)
      if (resumeState) {
        resumeState.classifications = pnStatus.map(s => ({
          csvRowKey: s.csvRowKey,
          classification: s.classification,
          pase: s.pase,
          targetPnId: s.targetPnId,
          userOverride: s.userOverride,
          userDecided: !!s.userDecided, // 1.4.5
          candidates: (s.candidates || []).map(c => c.id),
          // 1.4.21 Fix CC v3: persistir existingProcessId habilita el fast-path
          // de "skip prefetch en resume". Sin esto, un resume re-corre classifyPNs
          // entero (~1.7GB de baseline para CSVs grandes).
          existingProcessId: s.existingProcessId || null,
        }));
        await persistResumeState();
      }

      // V10: Resolver proceso vacío / "-" según existence:
      //   "-"   → set null (borrar default process)
      //   ""    → copiar del PN existente; si es nuevo → error y skip
      //   name  → ya está resuelto desde processCache
      const partsToSkip = new Set();
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const raw = p.procesoOverride;
        if (raw && !isDash(raw)) continue; // ya tiene processId resuelto

        if (isDash(raw)) {
          // "-" = borrar el default process del PN (queda null)
          p.processId = null;
          p.clearDefaultProcess = true;
          log(`  PN "${p.pn}": Proceso "-" → se borrará el default process`);
          continue;
        }

        // Vacío
        const st = pnStatus[i];
        if (st.status === 'new') {
          errors.push(`PN "${p.pn}": Proceso vacío en PN NUEVO (no hay de dónde copiar). Ignorado.`);
          partsToSkip.add(i);
          continue;
        }
        if (!st.existingProcessId) {
          errors.push(`PN "${p.pn}": Proceso vacío y el PN existente no tiene defaultProcessNodeId. Ignorado.`);
          partsToSkip.add(i);
          continue;
        }
        p.processId = st.existingProcessId;
        log(`  PN "${p.pn}": Proceso heredado del PN existente (id:${st.existingProcessId})`);
      }
      if (partsToSkip.size) {
        const filtered = parts.filter((_, i) => !partsToSkip.has(i));
        const filteredStatus = pnStatus.filter((_, i) => !partsToSkip.has(i));
        parts.length = 0; parts.push(...filtered);
        pnStatus.length = 0; pnStatus.push(...filteredStatus);
      }

      // ── Metal Base validation ──
      // V10: fetch enum directly from PartNumber input schema (no más hardcoded)
      let metalBaseEnum = [];
      let satEnum = [];
      try {
        const schemaData = await api().query('GetPartNumbersInputSchema', {}, 'GetPartNumbersInputSchema');
        const schemaNodes = schemaData?.allPartNumberInputSchemas?.nodes || [];
        const latestSchema = schemaNodes.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
        if (latestSchema) {
          const schemaProps = latestSchema.inputSchema?.properties || {};
          metalBaseEnum = schemaProps.DatosAdicionalesNP?.properties?.BaseMetal?.enum || [];
          satEnum = schemaProps.DatosFacturacion?.properties?.CodigoSAT?.enum || [];
          log(`  Schema loaded: ${metalBaseEnum.length} metales, ${satEnum.length} SAT`);
        }
      } catch (e) {
        warn(`GetPartNumbersInputSchema falló: ${String(e).substring(0, 100)}. Usando fallback hardcoded.`);
        metalBaseEnum = ['Cobre', 'Aluminio', 'Fierro', 'Latón', 'Acero Inoxidable', 'Bronce', 'Bimetálica', 'Acero al Carbón', 'Zamak', 'Varios'];
      }
      const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const newMetals = new Set();
      for (const part of parts) {
        if (!part.metalBase || isDash(part.metalBase)) continue;
        const exact = metalBaseEnum.find(m => m === part.metalBase);
        if (exact) continue;
        const fuzzy = metalBaseEnum.find(m => normalize(m) === normalize(part.metalBase));
        if (fuzzy) {
          log(`  Metal Base "${part.metalBase}" → corregido a "${fuzzy}" (fuzzy match)`);
          part.metalBase = fuzzy;
        } else {
          newMetals.add(part.metalBase);
        }
      }
      let createMetals = false;
      if (newMetals.size > 0) {
        createMetals = confirm(
          `Metal Base: los siguientes valores NO existen en el catálogo de Steelhead:\n\n` +
          [...newMetals].join('\n') + '\n\n' +
          `Valores actuales: ${metalBaseEnum.join(', ')}\n\n` +
          `¿Agregar al catálogo? (Aceptar = Sí, Cancelar = No, se cargan como texto libre)`
        );
        if (createMetals) {
          log(`  Creando nuevos Metal Base: ${[...newMetals].join(', ')}`);
        }
      }

      // ── Grupo PN validation (fuzzy + crear si no existe) ──
      const existingGroups = [...groupByName.keys()];
      const newGroups = new Set();
      for (const part of parts) {
        if (!part.pnGroup || isDash(part.pnGroup)) continue;
        const exact = existingGroups.find(g => g === part.pnGroup);
        if (exact) continue;
        const fuzzy = existingGroups.find(g => normalize(g) === normalize(part.pnGroup));
        if (fuzzy) {
          log(`  Grupo "${part.pnGroup}" → corregido a "${fuzzy}" (fuzzy match)`);
          part.pnGroup = fuzzy;
        } else {
          newGroups.add(part.pnGroup);
        }
      }
      if (newGroups.size > 0) {
        const createGroups = confirm(
          `Grupos de PN: los siguientes NO existen en Steelhead:\n\n` +
          [...newGroups].join('\n') + '\n\n' +
          `Se crearán automáticamente al ejecutar. ¿Continuar?`
        );
        if (!createGroups) {
          // Remove unknown groups from parts
          for (const part of parts) {
            if (newGroups.has(part.pnGroup)) part.pnGroup = '';
          }
          log('  Grupos nuevos cancelados por usuario');
        } else {
          log(`  Grupos nuevos a crear: ${[...newGroups].join(', ')}`);
        }
      }

      // ── Preview ──
      const selectedIndices = await showPreview(header, parts, pnStatus, { customerCount: customerCache.size, processCount: processCache.size, assigneeName }, isSoloPN);
      if (!selectedIndices) { log('Cancelado por usuario.'); return { cancelled: true }; }

      // Filter parts and pnStatus to only selected indices
      if (Array.isArray(selectedIndices) && selectedIndices.length < parts.length) {
        const selSet = new Set(selectedIndices);
        const filteredParts = []; const filteredStatus = [];
        for (let i = 0; i < parts.length; i++) {
          if (selSet.has(i)) { filteredParts.push(parts[i]); filteredStatus.push(pnStatus[i]); }
        }
        log(`  ${filteredParts.length}/${parts.length} PNs seleccionados por usuario`);
        parts.length = 0; parts.push(...filteredParts);
        pnStatus.length = 0; pnStatus.push(...filteredStatus);
      }

      // 1.4.15 Fix Y: liberar candidates/csvLabels/csvMetalBase de pnStatus.
      // Después de showPreview ya no se usan: enrichWorker solo lee status,
      // existingId, existingProcessId, csvRowKey, userOverride, userDecided.
      // Para 3,700 PNs × ~20 candidatos × ~1KB/shape ≈ ~75MB retenidos en
      // state.pnStatus durante todo STEP 6/6a/6b/7/8. Si el resume vuelve a
      // entrar al pipeline, classifyPNs re-genera candidates frescos en
      // memoria nueva — no perdemos información persistible (en resumeState
      // solo guardamos los IDs, no los shapes).
      for (const s of pnStatus) {
        s.candidates = null;
        s.csvLabels = null;
        s.csvMetalBase = null;
      }

      // ── Create new Metal Base values if confirmed ──
      if (createMetals && newMetals.size > 0) {
        setPanelPhase('Actualizando catálogo de Metal Base...');
        try {
          const updatedEnum = [...metalBaseEnum, ...newMetals];
          const fullSchema = {
            inputSchema: {
              type: "object", title: "", required: [], description: "", dependencies: {},
              properties: {
                DatosAdicionalesNP: {
                  type: "object", title: "Datos Adicionales de Número de Parte", required: [], description: "", dependencies: {},
                  properties: {
                    BaseMetal: { enum: updatedEnum, type: "string", title: "Metal Base" },
                    NumeroParteAlterno: { type: "array", items: { type: "string", title: "Número de Parte Alterno", description: "Número de Parte Alterno" }, title: "Número de Parte Alterno" },
                    QuoteIBMS: { type: "string", title: "Quote en IBMS" },
                    EstacionIBMS: { type: "string", title: "Número de Estación en IBMS (Est.)" },
                    Plano: { type: "string", title: "Número de Plano" }
                  }
                },
                DatosFacturacion: {
                  type: "object", title: "Datos de Facturación", required: [], dependencies: {},
                  properties: {
                    CodigoSAT: { enum: ["73181106 - Servicios de enchapado", "73181109 - Servicios de niquelado", "73181119 - Servicio de recubrimiento con pintura en polvo", "73151500 - Servicios de ensamble", "73151506 - Servicio de subensamble o ensamble definitivo", "11191500 - Cuerpos sólidos de metal", "30262200 - Barras de cobre", "31281500 - Componentes estampados", "31281813 - Componentes de cobre perforados", "39121400 - Lengüetas de conexión, conectadores y terminales"], type: "string", title: "Código SAT" }
                  }
                },
                DatosPlanificacion: {
                  type: "object", title: "Datos de Planificación", required: [], dependencies: {},
                  properties: {
                    CargasHora: { type: "string", title: "Cargas por Hora (IBMS)" },
                    PiezasCarga: { type: "number", title: "Piezas por Carga (IBMS)" },
                    montoMinimo: { type: "number", title: "Monto Mínimo en USD" },
                    TiempoEntrega: { type: "number", title: "Tiempo de Entrega en Días (Lead Time)" }
                  }
                },
                NotasAdicionales: { type: "string", title: "Notas Adicionales" }
              }
            },
            uiSchema: {
              DatosAdicionalesNP: { NumeroParteAlterno: { items: {} }, "ui:order": ["BaseMetal", "NumeroParteAlterno", "QuoteIBMS", "EstacionIBMS", "Plano"] },
              DatosFacturacion: { "ui:order": ["CodigoSAT"] },
              DatosPlanificacion: { "ui:order": ["PiezasCarga", "CargasHora", "montoMinimo", "TiempoEntrega"] },
              NotasAdicionales: { "ui:widget": "textarea" },
              "ui:order": ["DatosAdicionalesNP", "DatosFacturacion", "DatosPlanificacion", "NotasAdicionales"]
            }
          };
          await api().query('CreatePartNumberInputSchema', fullSchema, 'CreatePartNumberInputSchema');
          log(`  Metal Base actualizado: +${[...newMetals].join(', ')}`);
          addPanelLog(`Metal Base: ${[...newMetals].join(', ')} agregados al catálogo`);
        } catch (e) {
          errors.push(`Actualizar Metal Base: ${String(e).substring(0, 120)}`);
          warn(`Metal Base schema update falló: ${e.message}`);
        }
      }

      // ═══════════════════════════════════════
      // EXECUTION
      // ═══════════════════════════════════════
      setPanelPhase('Iniciando...');

      // V10: quote vars now per-customer; we track all of them
      const quotesCreated = []; // [{ id, idInDomain, customerId, name }]
      let primaryQuoteIdInDomain = null;
      const empresaKey = (header.empresaEmisora || 'ECO').toUpperCase();
      const empresaStr = DOMAIN.empresas[empresaKey] || DOMAIN.empresas.ECO;
      const validDays = parseInt(header.validaDias) || 30;

      if (!isSoloPN) {
        setPanelPhase('Paso 1/9: Preparando cotizaciones...'); setProgressBar(5);
      } else {
        setPanelPhase('Modo SOLO_PN — omitiendo cotización'); setProgressBar(5);
      }

      // STEP 2a: Create new PNs via SavePartNumber (minimal)
      // 1.2.11: newPnIds keyed por rowIdx (origen en parts[]) en vez de "pn|customerId".
      // Steelhead permite múltiples PNs con (name, customerId) → necesitamos UN id por fila CSV
      // independiente. Capa A crea las filas NEW con name+customerId únicos en paralelo; Capa B
      // serializa los duplicados restantes (mismo name+customerId) uno por uno para evitar race
      // en el server (que rechaza creates concurrentes con identidad colisionante).
      setPanelPhase('Paso 2/9: Creando PNs nuevos...'); setProgressBar(10);
      const newPnIds = new Map(); // rowIdx → pn.id
      const newOrDupParts = [];
      for (let i = 0; i < parts.length; i++) { const status = pnStatus[i]; if (status.status !== 'existing') newOrDupParts.push({ part: parts[i], status, idx: i }); }
      // Capa A: filas con (name, customerId) único entre newOrDupParts → seguras en paralelo (futuro pool).
      // Capa B: filas que comparten name+customerId con otra del mismo set → serializar.
      const seenNameCust = new Map(); // "${pn}|${cid}" → [idx en newOrDupParts]
      for (let j = 0; j < newOrDupParts.length; j++) {
        const { part } = newOrDupParts[j];
        const k = `${String(part.pn).toUpperCase()}|${part.customerId}`;
        if (!seenNameCust.has(k)) seenNameCust.set(k, []);
        seenNameCust.get(k).push(j);
      }
      const capaA = [], capaB = [];
      for (const indices of seenNameCust.values()) {
        if (indices.length === 1) capaA.push(indices[0]);
        else { capaA.push(indices[0]); for (let n = 1; n < indices.length; n++) capaB.push(indices[n]); }
      }
      // Procesamos capa A primero, luego capa B en orden (la B siempre serial — sin paralelo).
      const orderedJs = [...capaA, ...capaB];
      if (capaB.length) log(`  Capa A (únicos): ${capaA.length} PNs; Capa B (duplicados name+customerId): ${capaB.length} — serializados`);
      for (const jSlot of orderedJs) {
        const j = jSlot;
        const { part, status, idx } = newOrDupParts[j];
        setProgressBar(10 + Math.round((j / Math.max(newOrDupParts.length, 1)) * 5));
        const processId = part.processId; // V10: per-line, no fallback
        const groupId = await resolveGroupId(part.pnGroup);
        const minInput = {
          id: null, name: part.pn, customerId: part.customerId, defaultProcessNodeId: processId,
          inputSchemaId: DOMAIN.inputSchemaId_PN, customInputs: {},
          geometryTypeId: null, userFileName: null, inventoryItemInput: null,
          glAccountId: null, taxCodeId: null, certPdfTemplateId: null,
          isOneOff: false, isTemplatePartNumber: false, isCoupon: false, partNumberGroupId: groupId,
          descriptionMarkdown: '', customerFacingNotes: '',
          labelIds: [], ownerIds: [], defaults: [], optInOuts: [],
          inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
          partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [],
          partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
          partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
          partNumberSpecClassificationsToUpdate: [],
          partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: []
        };
        try {
          const res = await api().query('SavePartNumber', { input: [minInput] });
          const created = (res?.savePartNumbers || [])[0]; if (!created?.id) throw new Error('No id returned');
          // 1.2.11: key por rowIdx (no por "name|cid") — duplicados name+customerId ahora resuelven
          // ids distintos.
          newPnIds.set(idx, created.id);
          if (status.status === 'forceDup') stats.pnsDuplicated++; else stats.pnsCreated++;
          log(`  "${part.pn}" (cust:${part.customerId}) -> creado id:${created.id} (row ${idx})`);
        } catch (e) { errors.push(`Crear PN "${part.pn}" (row ${idx}): ${String(e).substring(0, 150)}`); }
      }
      addPanelLog(`${newPnIds.size} PNs creados`);

      // V10: pnLookup keyed by "pn|customerId" to support multi-customer
      const pnLookup = new Map();

      // 1.2.5: cache compartida entre enrichWorker (archive sentinel) y STEP 6b (param sync).
      // pnId → partNumberById (shape completo de GetPartNumber, incluye partNumberSpecsByPartNumberId
      // y partNumberSpecFieldParamsByPartNumberId). On-demand fetch — solo se popula cuando algún
      // PN existente lo necesita. Evita doble GetPartNumber al mismo PN.
      const existingPnFullCache = new Map();

      // STEP 4.5 (1.4.1): Desarchivar PNs que llegan archivados ANTES de cualquier
      // mutación de enrich. Problema observado (1.4.0): cuando un PN existing matcheaba
      // a un PN archivado en Steelhead, STEP 5 / STEP 6 / SaveManyPNP_Quote corrían sobre
      // el PN aún archivado. La quote line auto-generada heredaba el estado archivado
      // → las specs salían tachadas en la cotización aunque STEP 5 archivara los sentinels.
      // Repro: PN id 3017160 quote nueva tras archivar #139 — toggle archived de la línea
      // mostraba/escondía las specs igual que la columna del PN. Fix: UpdatePartNumber
      // (archivedAt:null) para todos los wasArchived antes del STEP 5. STEP 8 ya
      // re-archiva al final si CSV lo pide (part.archivado=true) — el flujo queda idempotent.
      const pnsToUnarchivePre = [];
      const unarchivePreSeen = new Set();
      for (let i = 0; i < parts.length; i++) {
        const status = pnStatus[i];
        if (!status.wasArchived || !status.existingId) continue;
        if (unarchivePreSeen.has(status.existingId)) continue;
        unarchivePreSeen.add(status.existingId);
        pnsToUnarchivePre.push({ id: status.existingId, name: parts[i].pn });
      }
      if (pnsToUnarchivePre.length) {
        // 1.4.25 Fix FF: consolidamos la fase en un solo setPanelPhase con prefix
        // "Paso 4.5/9" — antes la segunda llamada sobrescribía y borraba el prefix.
        setPanelPhase(`Paso 4.5/9: Desarchivando PNs pre-enrich (${pnsToUnarchivePre.length})`);
        setProgressBar(13);
        setPanelProgress(0, pnsToUnarchivePre.length);
        const unarchivePreConcurrency = bulkCfg().concurrency.savePartNumber || 5;
        let unarchivedPreOk = 0;
        await runPool(
          pnsToUnarchivePre,
          async (op, _idx, myRunIdLocal) => {
            bailIfStale(myRunIdLocal);
            setPanelSubPhase(`Desarchivando: ${op.name}`);
            try {
              await withRetry(
                () => api().query('UpdatePartNumber', { id: op.id, archivedAt: null }),
                `UpdatePartNumber unarchive-pre "${op.name}"`,
                myRunIdLocal
              );
              unarchivedPreOk++;
            } catch (e) {
              if (isBail(e)) throw e;
              errors.push(`UpdatePartNumber unarchive-pre "${op.name}": ${String(e).substring(0, 120)}`);
            }
          },
          unarchivePreConcurrency,
          (done, total) => {
            setPanelProgress(done, total);
            setProgressBar(13 + Math.round((done / Math.max(total, 1)) * 3));
          },
          myRunId
        );
        bailIfStale(myRunId);
        stats.unarchivedPre = unarchivedPreOk;
        log(`  STEP 4.5 desarchive pre-enrich: ${unarchivedPreOk}/${pnsToUnarchivePre.length} OK`);
      }

      if (!isSoloPN) {
        // STEP 5 (1.4.0): Archive de specs sentinel ANTES del chunk loop.
        // Problema (1.3.x): enrichWorker archivaba specs vigentes DESPUÉS de
        // SaveQuoteLines — el snapshot de la línea capturaba la spec aún vigente y
        // al refrescar la cotización aparecía como "archivada". El workaround manual
        // del usuario (desarchivar NP → editar línea → guardar → re-archivar NP)
        // confirma que un GetQuote tras un PN limpio refresca el snapshot.
        // Solución quirúrgica: archivar specs sentinel pre-quote. Cuando llega
        // STEP 6, no encuentra specs vigentes que archivar y queda idempotent.
        // 1.4.8: si venimos de un resume, filtrar los pnIds que ya quedaron
        // archivados en una corrida previa. Aún así pasan por el armado para
        // recalcular targets desde parts/pnStatus actuales (csv puede haber
        // cambiado entre corridas — runKey distinto sería un run nuevo).
        const alreadyArchivedSet = new Set(
          Array.isArray(resumeState?.archivedSentinelsPreQuote)
            ? resumeState.archivedSentinelsPreQuote
            : []
        );
        const sentinelTargets = [];
        let sentinelSkippedByResume = 0;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i];
          if (status.status !== 'existing') continue;
          if (!status.existingId) continue;
          if (!part.specs.length) continue;
          if (!part.specs.some(s => isDash(s.name))) continue;
          if (alreadyArchivedSet.has(status.existingId)) {
            sentinelSkippedByResume++;
            continue;
          }
          sentinelTargets.push({ part, pnId: status.existingId, idx: i });
        }
        if (sentinelSkippedByResume > 0) {
          log(`  STEP 5 resume: ${sentinelSkippedByResume} PN(s) saltados (sentinels ya archivados en corrida previa).`);
        }
        if (sentinelTargets.length) {
          // 1.4.25 Fix FF: consolidado en un solo setPanelPhase con prefix "Paso 5/9".
          setPanelPhase(`Paso 5/9: Archive specs sentinel pre-cotización (${sentinelTargets.length} PN(s))`);
          setProgressBar(16);
          setPanelProgress(0, sentinelTargets.length);
          let sentinelOk = 0, sentinelSkip = 0;
          // 1.4.8: concurrencia dedicada (default 3). Antes usaba savePartNumber=5
          // y eso saturaba memoria con buffers GraphQL en runs de >3k PNs → OOM.
          const sentinelConcurrency = bulkCfg().concurrency.sentinelPreQuoteArchive || 3;
          // 1.4.8: buffer local de pnIds archivados en este pase. Se flushea a
          // resumeState.archivedSentinelsPreQuote cada FLUSH_EVERY items y al
          // terminar el runPool. Persistir cada call sería muy ruidoso para
          // localStorage; cada 100 da grano fino sin amplificar I/O.
          // 1.4.14 Fix Z: threshold bajó de 100 a 25 para reducir pérdida en
          // crash/cancel mid-STEP-5. Cost extra: ~4× más setItem() en localStorage,
          // pero c/u <2ms con ~150KB JSON, irrelevante vs costo de re-archivar PNs.
          const SENTINEL_FLUSH_EVERY = 25;
          const sentinelArchivedBuffer = [];
          const flushSentinelBuffer = async () => {
            if (!sentinelArchivedBuffer.length || !resumeState) return;
            if (!Array.isArray(resumeState.archivedSentinelsPreQuote)) {
              resumeState.archivedSentinelsPreQuote = [];
            }
            for (const id of sentinelArchivedBuffer) {
              if (!alreadyArchivedSet.has(id)) {
                resumeState.archivedSentinelsPreQuote.push(id);
                alreadyArchivedSet.add(id);
              }
            }
            sentinelArchivedBuffer.length = 0;
            try { await persistResumeState(); } catch (e) {
              // 1.4.14 Fix Z: antes el catch era silencioso ({}) — si localStorage
              // quota se saturaba, el usuario perdía progreso sin saberlo. Ahora
              // log visible en el panel-log para diagnóstico.
              addPanelLog(`⚠ Persist sentinel buffer falló: ${String(e?.message || e).substring(0, 80)}`);
            }
          };
          // 1.4.14 Fix Z: exponer al state para que cancelRun() pueda flushear
          // ANTES de persistir el cancelled, no perdiendo items in-flight.
          state.flushSentinelBuffer = flushSentinelBuffer;
          await runPool(
            sentinelTargets,
            async (target, _idx, myRunIdLocal) => {
              bailIfStale(myRunIdLocal);
              setPanelSubPhase(`Archive sentinel: ${target.part.pn}`);
              let pnNode = existingPnFullCache.get(target.pnId);
              if (!pnNode) {
                try {
                  const pnData = await withRetry(
                    () => api().query('GetPartNumber', { partNumberId: target.pnId }),
                    `GetPartNumber pre-archive "${target.part.pn}"`,
                    myRunIdLocal
                  );
                  pnNode = pnData?.partNumberById || null;
                  if (pnNode) existingPnFullCache.set(target.pnId, pnNode);
                } catch (e) {
                  if (isBail(e)) throw e;
                  errors.push(`GetPartNumber pre-archive "${target.part.pn}": ${String(e).substring(0, 120)}`);
                  return;
                }
              }
              if (!pnNode) { sentinelSkip++; return; }
              const wantedSpecIds = new Set();
              for (const cs of target.part.specs) {
                if (isDash(cs.name)) continue;
                const si = specByName.get(cs.name);
                if (si) wantedSpecIds.add(si.id);
              }
              const archiveIds = [];
              for (const ls of (pnNode.partNumberSpecsByPartNumberId?.nodes || [])) {
                if (ls.archivedAt) continue;
                const linkedSpecId = ls.specBySpecId?.id;
                if (!linkedSpecId) continue;
                if (!wantedSpecIds.has(linkedSpecId)) archiveIds.push(ls.id);
              }
              if (!archiveIds.length) {
                sentinelSkip++;
                // 1.4.21 Fix CC v3: marcar PN como "ya procesado" aunque no haya
                // archivado nada. Antes solo se marcaban los OK reales → un resume
                // re-procesaba miles de PNs limpios, llamando GetPartNumber (~25KB
                // por response) y disparando OOM aunque no hubiera trabajo real.
                sentinelArchivedBuffer.push(target.pnId);
                return;
              }
              const minInput = {
                id: target.pnId,
                name: pnNode.name,
                customerId: pnNode.customerId || target.part.customerId,
                defaultProcessNodeId: pnNode.defaultProcessNodeId || target.part.processId,
                inputSchemaId: DOMAIN.inputSchemaId_PN,
                customInputs: pnNode.customInputs || {},
                geometryTypeId: pnNode.geometryTypeId || null,
                userFileName: null,
                inventoryItemInput: null,
                glAccountId: null, taxCodeId: null, certPdfTemplateId: null,
                isOneOff: false, isTemplatePartNumber: false, isCoupon: false,
                partNumberGroupId: pnNode.partNumberGroupId || null,
                descriptionMarkdown: pnNode.descriptionMarkdown || '',
                customerFacingNotes: pnNode.customerFacingNotes || '',
                labelIds: [], ownerIds: [], defaults: [], optInOuts: [],
                inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
                partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [],
                partNumberSpecsToArchive: archiveIds,
                partNumberSpecsToUnarchive: [],
                partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
                partNumberSpecClassificationsToUpdate: [],
                partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: []
              };
              try {
                await withRetry(
                  () => api().query('SavePartNumber', { input: [minInput] }),
                  `SavePartNumber pre-archive "${pnNode.name}"`,
                  myRunIdLocal
                );
                sentinelOk++;
                stats.specsArchivedBySentinel = (stats.specsArchivedBySentinel || 0) + archiveIds.length;
                // 1.4.8: marcar este pnId como sentinel-archived para que un
                // resume tras crash no lo vuelva a procesar. Push al buffer
                // local; el flush a resumeState ocurre cada FLUSH_EVERY items
                // en el callback de progreso del runPool.
                sentinelArchivedBuffer.push(target.pnId);
              } catch (e) {
                if (isBail(e)) throw e;
                errors.push(`SavePartNumber pre-archive "${pnNode.name}": ${String(e).substring(0, 120)}`);
                // 1.4.14 Fix Z: contador visible y log al panel cada N fallos —
                // si la mutation revienta para todo el batch (hash rotado /
                // schema cambio), el usuario lo ve en vez de pensar que avanza
                // OK (panel mostraba "OK: 0, Errores: 0" engañoso).
                state.counters.errors++;
                if (state.counters.errors === 1 || state.counters.errors % 50 === 0) {
                  addPanelLog(`⚠ STEP 5 SavePartNumber fallos: ${state.counters.errors} — ej: ${String(e?.message || e).substring(0, 100)}`);
                }
              } finally {
                // 1.4.14 Fix Z: invalidar cache SIEMPRE (antes solo en éxito).
                // STEP 6 vuelve a fetchear y ve specs ya archivadas → no-op.
                // Sin esto, existingPnFullCache retiene ~25KB/PN × 7300 = ~180MB
                // que nunca se libera hasta el fin del run.
                existingPnFullCache.delete(target.pnId);
              }
            },
            sentinelConcurrency,
            (done, total) => {
              setPanelProgress(done, total);
              setProgressBar(16 + Math.round((done / Math.max(total, 1)) * 3));
              // 1.4.8: flush periódico — el callback se invoca tras cada item
              // completado por el runPool. Si el buffer creció más allá del
              // umbral, persistir resumeState para que un OOM mid-step no
              // pierda el progreso intra-paso. fire-and-forget para no bloquear
              // el pipeline.
              if (sentinelArchivedBuffer.length >= SENTINEL_FLUSH_EVERY) {
                flushSentinelBuffer().catch(() => {});
              }
            },
            myRunId
          );
          // 1.4.14 Fix Z: flush ANTES de bailIfStale. Si runPool sale por cancel
          // mid-step, bailIfStale lanza BailError y el flush final NUNCA corría
          // → archivedSentinelsPreQuote quedaba en 0 aunque hubieran cientos de
          // items archivados con éxito. Ahora flushea siempre, incluso al cancel.
          await flushSentinelBuffer();
          // Soltar referencia para que cancel post-STEP-5 no intente flushear
          // un buffer huérfano.
          state.flushSentinelBuffer = null;
          bailIfStale(myRunId);
          // (Nota histórica) No limpiamos archivedSentinelsPreQuote al final de
          // STEP 5: si un crash ocurre en STEP 6/7, el resume vuelve a entrar a
          // STEP 5 y necesita la lista para saltear lo ya hecho. La purga del
          // estado completo se hace cuando phase llega a 'done'
          // (deleteResumeStateByKey). 5879 UUIDs ≈ 420KB, cabe holgadamente.
          log(`  STEP 5 archive sentinel pre-cotización: ${sentinelOk} OK, ${sentinelSkip} skip (sin specs vigentes que archivar)`);
          // 1.4.15 Fix Y: clear cache entre fases (defensa en profundidad). El delete
          // por-item en el finally del worker (línea 3332) cubre el caso normal, pero
          // un BailError en mid-pool deja orfanos. STEP 6 re-fetchea via GetPartNumber
          // si necesita el pnNode — coste ~0.3s/PN existing.
          existingPnFullCache.clear();
        }

        // V10: Group parts by customer and create one quote per customer
        const partsByCustomer = new Map();
        for (let i = 0; i < parts.length; i++) {
          const cid = parts[i].customerId;
          if (!partsByCustomer.has(cid)) partsByCustomer.set(cid, []);
          partsByCustomer.get(cid).push({ part: parts[i], status: pnStatus[i], origIdx: i });
        }
        // 1.3.0: chunking. chunkSize lockeado en resumeState (sobrevive resume).
        // Si la corrida nace fresh, resumeState.chunkSize ya tiene state.chunkSize o el default.
        const chunkSize = (resumeState && resumeState.chunkSize) || state.chunkSize || bulkCfg().chunking.defaultChunkSize;

        // Pre-cómputo: chunks por cliente + total global para barras de progreso.
        const chunksByCust = new Map();
        let totalChunks = 0;
        for (const [cid, custParts] of partsByCustomer) {
          const chunks = chunkParts(custParts, chunkSize);
          chunksByCust.set(cid, chunks);
          totalChunks += chunks.length;
        }
        if (totalChunks !== partsByCustomer.size) {
          log(`Cotizaciones a crear: ${totalChunks} (${partsByCustomer.size} cliente(s), chunkSize=${chunkSize})`);
        } else {
          log(`Cotizaciones a crear: ${totalChunks} (una por cliente, chunkSize=${chunkSize})`);
        }

        // 1.4.25 Fix FF: faltaba setPanelPhase para STEP 3 (chunk loop). El modal
        // quedaba mostrando "Paso 2/9: Creando PNs nuevos... 9/9 0 PNs creados"
        // durante todos los chunks. Operator no veía qué estaba pasando aunque
        // la consola loggeara "chunk N/15: ya completado, reconstruyendo pnLookup".
        setPanelPhase(`Paso 3/9: Creando/reanudando cotizaciones (${totalChunks})...`);
        setPanelProgress(0, totalChunks);
        setProgressBar(20);

        let quoteSeq = 0;
        let prodAddedTotal = 0;
        let pnpItemsTotal = 0;
        for (const [cid, custParts] of partsByCustomer) {
          const cust = [...customerCache.values()].find(c => c.id === cid);
          if (!cust) { errors.push(`Cliente id ${cid} no en cache`); continue; }
          const chunks = chunksByCust.get(cid);
          // 1.3.0: loop interno por chunk. Cada chunk es una cotización
          // independiente con su propio nombre derivado, su propio
          // modal modify/skip/create al inicio, y se persiste como
          // completado al final del pipeline.
          for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
            const chunkAlreadyDone = resumeState?.completedChunks?.[cid]?.includes(cIdx);
            if (chunkAlreadyDone) {
              // Fix B-resume 1.3.2: NO saltar ciegamente — reconstruir pnLookup desde la quote
              // existente para que STEP 6 (enrich) y STEP 6b (sync params) corran sobre los
              // PNs ya creados. Antes (1.3.1) este `continue` dejaba pnLookup vacío y todo
              // el resto de fases reportaba 0/0/0.
              bailIfStale(myRunId);
              const chunkSliceLocal = chunks[cIdx];
              const thisQuoteNameLocal = makeChunkQuoteName(quoteName, cIdx, chunks.length);
              // 1.4.25 Fix FF: mostrar en modal qué chunk se está reconstruyendo.
              quoteSeq++;
              setPanelSubPhase(`Reanudando chunk ${quoteSeq}/${totalChunks}: "${thisQuoteNameLocal}" (GetQuote)`);
              setPanelProgress(quoteSeq, totalChunks);
              setProgressBar(20 + Math.round((quoteSeq / totalChunks) * 25));
              log(`  ${cust.name} chunk ${cIdx + 1}/${chunks.length}: ya completado, reconstruyendo pnLookup desde quote existente`);
              const existing = await findExistingQuote(cid, thisQuoteNameLocal);
              if (!existing) {
                warn(`  Chunk marcado completo pero quote "${thisQuoteNameLocal}" no encontrada — saltando.`);
                continue;
              }
              let qDataR;
              try { ({ data: qDataR } = await api().queryWithFallback('GetQuote', 'GetQuote_v8', 'GetQuote_v71', { idInDomain: existing.idInDomain, revisionNumber: 1 })); }
              catch (e) { errors.push(`GetQuote (resume) ${existing.idInDomain}: ${String(e).substring(0, 120)}`); continue; }
              const quoteR = qDataR?.quoteByIdInDomainAndRevisionNumber || qDataR?.quoteByIdInDomain;
              if (!quoteR) { warn(`  No se pudo leer quote #${existing.idInDomain} para reconstruir lookup.`); continue; }
              const qpnpNodesR = quoteR.quotePartNumberPricesByQuoteId?.nodes || [];
              const qlNodesR = quoteR.quoteLinesByQuoteId?.nodes || [];
              const qlByQpnpIdR = new Map(); for (const ql of qlNodesR) if (ql.autoGeneratedFromQuotePartNumberPriceId) qlByQpnpIdR.set(ql.autoGeneratedFromQuotePartNumberPriceId, ql);
              // Match por (pn.name, customerId) → origIdx. Si hay duplicados name+customerId en chunkSliceLocal,
              // el matching es best-effort y los duplicados extras se quedan sin entry (warn).
              const pnByNameR = new Map();
              for (const qpnp of qpnpNodesR) {
                const pnp = qpnp.partNumberPriceByPartNumberPriceId; if (!pnp) continue;
                const pn = pnp.partNumberByPartNumberId; if (!pn?.name) continue;
                const arr = pnByNameR.get(pn.name.toUpperCase()) || [];
                arr.push({ qpnp, pnp, pn, ql: qlByQpnpIdR.get(qpnp.id) || null, quoteId: existing.id });
                pnByNameR.set(pn.name.toUpperCase(), arr);
              }
              for (const { part, origIdx } of chunkSliceLocal) {
                const arr = pnByNameR.get(String(part.pn).toUpperCase()) || [];
                const next = arr.shift();
                if (!next) { warn(`pnLookup (resume): "${part.pn}" no en quote #${existing.idInDomain}`); continue; }
                pnLookup.set(origIdx, next);
              }
              quotesCreated.push({ id: existing.id, idInDomain: existing.idInDomain, customerId: cid, name: thisQuoteNameLocal });
              if (!primaryQuoteIdInDomain) primaryQuoteIdInDomain = existing.idInDomain;
              // No re-popular productByName aquí — los productos ya están aplicados desde la corrida original.
              continue;
            }
            bailIfStale(myRunId);
            const chunkSlice = chunks[cIdx];
          quoteSeq++;
          // 1.3.0: 1 chunk → nombre original; >1 → "<name> 01", " 02", ... (padStart 2 dígitos, escala a 3+ si pasamos 99)
          const thisQuoteName = makeChunkQuoteName(quoteName, cIdx, chunks.length);
          // Use first part's divisa as quote-level divisa (per-line drives prices later)
          const quoteDivisa = (chunkSlice[0].part.divisa || 'USD').toUpperCase();
          const quoteCI = {
            Comentarios: { CargosFletes: true, CotizacionSujetaPruebas: true, ReferirNumeroCotizacion: true, ModificacionRequiereRecotizar: true },
            DatosAdicionales: { Divisa: quoteDivisa, Decimales: '2', EmpresaEmisora: empresaStr, MostrarProceso: false, MostrarTotales: true },
            Autorizacion: {}, CondicionesComerciales: {},
          };

          // 1.4.25 Fix FF: actualizar progress bar del panel (no solo el bar lateral).
          setPanelProgress(quoteSeq, totalChunks);
          setPanelSubPhase(`Quote ${quoteSeq}/${totalChunks}: buscando duplicados...`);
          setProgressBar(20 + Math.round((quoteSeq / totalChunks) * 25));

          // V10: detect existing quote with same name+customer
          let thisQuoteId = null, thisQuoteIdInDomain = null;
          const existingQuote = await findExistingQuote(cid, thisQuoteName);
          if (existingQuote) {
            log(`  Cotización existente encontrada: #${existingQuote.idInDomain} (${cust.name})`);
            const action = await showQuoteConflict(cust.name, thisQuoteName, existingQuote);
            if (action === 'skip') {
              log(`  ${cust.name}: omitido por usuario`);
              continue;
            }
            if (action === 'modify') {
              thisQuoteId = existingQuote.id;
              thisQuoteIdInDomain = existingQuote.idInDomain;
              log(`  Modificando cotización existente #${thisQuoteIdInDomain}`);

              // Clean existing PNPs from the quote so we can re-add fresh
              try {
                const existingPnpIds = (existingQuote.quotePartNumberPricesByQuoteId?.nodes || []).map(n => n.partNumberPriceByPartNumberPriceId?.id).filter(Boolean);
                if (existingPnpIds.length) {
                  log(`  Limpiando ${existingPnpIds.length} PNPs viejos de la cotización...`);
                  await api().queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN',
                    { input: { quoteId: thisQuoteId, autoGenerateQuoteLines: false, partNumberPrices: [], partNumberPriceIdsToDelete: existingPnpIds, quotePartNumberPriceLineNumberOnlyUpdates: [] } });
                }
              } catch (e) { warn(`Limpiar PNPs viejos: ${String(e).substring(0, 100)}`); }
            }
            // action === 'create' falls through to the normal CreateQuote
          }

          if (!thisQuoteId) {
            // No existing or user chose to create new
            setPanelSubPhase(`Quote ${quoteSeq}/${totalChunks}: "${thisQuoteName}"`);
            let createResult;
            try {
              createResult = await api().query('CreateQuote', {
                name: thisQuoteName, assigneeId, customerId: cid,
                validUntil: isoDate(validDays), followUpDate: isoDate(3),
                customerAddressId: cust.addressId, customerContactId: cust.contactId,
                stagesRevisionId: DOMAIN.stagesRevisionId,
                lowCodeEnabled: false, autoGenerateLines: false, lowCodeId: null,
                customInputs: quoteCI, inputSchemaId: DOMAIN.inputSchemaId_Quote,
                invoiceTermsId: cust.invoiceTermsId,
                orderDueAt: null, shipToAddressId: cust.addressId
              });
            } catch (e) { errors.push(`CreateQuote "${thisQuoteName}": ${String(e).substring(0, 150)}`); continue; }
            thisQuoteId = createResult?.createQuote?.quote?.id;
            thisQuoteIdInDomain = createResult?.createQuote?.quote?.idInDomain;
            if (!thisQuoteId) { errors.push(`CreateQuote no devolvió id para "${thisQuoteName}"`); continue; }
          }

          quotesCreated.push({ id: thisQuoteId, idInDomain: thisQuoteIdInDomain, customerId: cid, name: thisQuoteName });
          if (!primaryQuoteIdInDomain) primaryQuoteIdInDomain = thisQuoteIdInDomain;
          log(`  Quote #${thisQuoteIdInDomain} (id:${thisQuoteId}) — ${cust.name}`);

          // SaveManyPNP for this customer's parts
          // 1.2.11: tracking lineNum → origIdx para reconstruir pnLookup por rowIdx tras el GetQuote.
          // Cada qpnp.lineNumber en la respuesta corresponde 1:1 con el pnpItem que lo creó.
          const pnpItems = []; let lineNum = 0;
          const lineNumberToOrigIdx = new Map();
          for (const { part, status, origIdx } of chunkSlice) {
            lineNum++;
            let partNumberId;
            if (status.status === 'existing') { partNumberId = status.existingId; stats.pnsExisting++; }
            else { partNumberId = newPnIds.get(origIdx); if (!partNumberId) { errors.push(`PN "${part.pn}" (row ${origIdx}) no fue creado, omitido de quote.`); continue; } }
            lineNumberToOrigIdx.set(lineNum, origIdx);
            pnpItems.push({
              partNumberId, processId: part.processId,
              customInputs: { DatosPrecio: { Divisa: (part.divisa && !isDash(part.divisa)) ? part.divisa : 'USD' } }, inputSchema: DIVISA_SCHEMA, uiSchema: DIVISA_UI,
              partNumberPriceLineItems: [{ title: '', price: part.precio || 0, productId: null, quoteInventoryItemId: null }],
              usePartNumberDescription: true, treatmentSelections: [], priceBuilders: [], informationalPriceDisplayItems: [], priceTiers: [],
              unitId: (part.unidadPrecio && PRICE_UNIT_MAP[part.unidadPrecio] !== undefined) ? PRICE_UNIT_MAP[part.unidadPrecio] : null,
              partNumberCustomInputs: null,
              quotePartNumberPrice: { savedQuotePartNumberPriceId: null, quoteId: thisQuoteId, quantityPerParent: part.qty, lineNumber: lineNum }
            });
          }
          const pnpBatches = Math.ceil(pnpItems.length / 20);
          for (let i = 0; i < pnpItems.length; i += 20) {
            const batch = pnpItems.slice(i, i + 20);
            const bnum = Math.floor(i / 20) + 1;
            // 1.4.25 Fix FF: sub-fase visible para SaveManyPNP batches.
            setPanelSubPhase(`Quote ${quoteSeq}/${totalChunks}: SaveManyPNP batch ${bnum}/${pnpBatches} (${batch.length} PNs)`);
            try {
              await api().queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN',
                { input: { quoteId: thisQuoteId, autoGenerateQuoteLines: true, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] } });
            } catch (e) { errors.push(`SaveManyPNP quote ${thisQuoteIdInDomain}: ${String(e).substring(0, 120)}`); }
          }
          pnpItemsTotal += pnpItems.length;
          log(`  SaveManyPNP: ${pnpItems.length}`);

          // Re-read quote to populate pnLookup
          setPanelSubPhase(`Quote ${quoteSeq}/${totalChunks}: leyendo quote para reconstruir lookup`);
          let qData;
          try { ({ data: qData } = await api().queryWithFallback('GetQuote', 'GetQuote_v8', 'GetQuote_v71', { idInDomain: thisQuoteIdInDomain, revisionNumber: 1 })); }
          catch (e) { errors.push(`GetQuote ${thisQuoteIdInDomain}: ${String(e).substring(0, 120)}`); continue; }
          const quote = qData?.quoteByIdInDomainAndRevisionNumber || qData?.quoteByIdInDomain;
          if (!quote) { errors.push(`No se pudo leer quote #${thisQuoteIdInDomain}.`); continue; }
          const qpnpNodes = quote.quotePartNumberPricesByQuoteId?.nodes || [];
          const qlNodes = quote.quoteLinesByQuoteId?.nodes || [];
          const qlByQpnpId = new Map(); for (const ql of qlNodes) if (ql.autoGeneratedFromQuotePartNumberPriceId) qlByQpnpId.set(ql.autoGeneratedFromQuotePartNumberPriceId, ql);
          // 1.2.11: keyed por rowIdx via lineNumberToOrigIdx. Si qpnp.lineNumber no matchea
          // ningún rowIdx (raro pero posible si Steelhead asigna lineNumbers distintos a los pedidos),
          // se cae a un fallback por (pn.name, cid) que solo aplica a filas únicas — duplicados name
          // dentro de un cliente quedarían sin lookup (warning explícito).
          for (const qpnp of qpnpNodes) {
            const pnp = qpnp.partNumberPriceByPartNumberPriceId; if (!pnp) continue;
            const pn = pnp.partNumberByPartNumberId; if (!pn?.name) continue;
            const origIdx = lineNumberToOrigIdx.get(qpnp.lineNumber);
            if (origIdx == null) {
              warn(`pnLookup: qpnp lineNumber=${qpnp.lineNumber} (pn="${pn.name}") sin origIdx — fila omitida del lookup`);
              continue;
            }
            pnLookup.set(origIdx, { qpnp, pnp, pn, ql: qlByQpnpId.get(qpnp.id) || null, quoteId: thisQuoteId });
          }
          const allProdNodes = quote.allProducts?.nodes || qData.allProducts?.nodes || [];
          if (allProdNodes.length) for (const p of allProdNodes) productByName.set(p.name, p);

          // SaveQuoteLines (products) for this customer's parts
          // 1.2.11: iteramos por { part, origIdx } y resolvemos pnLookup.get(origIdx) — cada fila CSV
          // tiene su propio ql aunque comparta name+customerId con otra. Esto soluciona Bug E
          // (productos combinados entre líneas) y Bug F (PNs duplicados que se pisaban entre sí).
          setPanelSubPhase(`Quote ${quoteSeq}/${totalChunks}: aplicando productos a líneas...`);
          for (const { part, origIdx } of chunkSlice) {
            if (!part.products.length) continue;
            const entry = pnLookup.get(origIdx); if (!entry) { errors.push(`PN "${part.pn}" (row ${origIdx}) no en quote.`); continue; }
            const ql = entry.ql; if (!ql) { errors.push(`QuoteLine no encontrada para "${part.pn}" (row ${origIdx}).`); continue; }
            const existing = ql.quoteLineItemsByQuoteLineId?.nodes || [];
            const idsToDelete = existing.map(ei => ei.id).filter(Boolean);

            if (part.products.length === 1 && isDash(part.products[0].name)) {
              if (idsToDelete.length) {
                try {
                  await api().query('SaveQuoteLines', { input: { quoteId: thisQuoteId, quoteLines: [{ savedQuoteLineId: ql.id, lineNumber: ql.lineNumber, title: ql.title, description: '', autoGeneratedFromQuotePartNumberPriceId: ql.autoGeneratedFromQuotePartNumberPriceId, quoteLineItems: [] }], quoteLinesToDelete: [], quoteLineItemsToDelete: idsToDelete, quoteLineNumberUpdates: [] } });
                  log(`  Productos borrados de línea "${part.pn}"`);
                } catch (e) { errors.push(`Borrar productos "${part.pn}": ${String(e).substring(0, 100)}`); }
              }
              continue;
            }

            const items = [];
            for (let idx = 0; idx < part.products.length; idx++) {
              const np = part.products[idx]; const pr = productByName.get(np.name);
              if (!pr) { errors.push(`Product "${np.name}" no en catálogo.`); continue; }
              items.push({ savedQuoteLineItemId: null, title: np.name, price: np.price, quantity: np.qty, productId: pr.id, displayOrder: idx, description: '', dimensionCustomValueIds: [], quotePartNumberPriceIds: [entry.qpnp.id], unitId: resolveUnitId(np.unit) });
              prodAddedTotal++;
            }
            if (!items.length) continue;
            try {
              await api().query('SaveQuoteLines', { input: { quoteId: thisQuoteId, quoteLines: [{ savedQuoteLineId: ql.id, lineNumber: ql.lineNumber, title: ql.title, description: ql.description || '', autoGeneratedFromQuotePartNumberPriceId: ql.autoGeneratedFromQuotePartNumberPriceId, quoteLineItems: items }], quoteLinesToDelete: [], quoteLineItemsToDelete: idsToDelete, quoteLineNumberUpdates: [] } });
            } catch (e) { errors.push(`SaveQuoteLines "${part.pn}": ${String(e).substring(0, 100)}`); }
          }

          // UpdateQuote notes
          try {
            if (header.notasExternas) await api().query('UpdateQuote', { id: thisQuoteId, notesMarkdown: isDash(header.notasExternas) ? '' : header.notasExternas });
            if (header.notasInternas) await api().query('UpdateQuote', { id: thisQuoteId, internalNotesMarkdown: isDash(header.notasInternas) ? '' : header.notasInternas });
          } catch (e) { errors.push(`UpdateQuote ${thisQuoteIdInDomain}: ${String(e).substring(0, 100)}`); }

          // 1.3.0: chunk completado — persistir para que un resume futuro lo salte.
          if (resumeState) {
            if (!resumeState.completedChunks) resumeState.completedChunks = {};
            if (!resumeState.completedChunks[cid]) resumeState.completedChunks[cid] = [];
            if (!resumeState.completedChunks[cid].includes(cIdx)) resumeState.completedChunks[cid].push(cIdx);
            await persistResumeState().catch(() => {});
          }
          } // end chunk loop
        }
        stats.productsSet = prodAddedTotal;
        stats.quoteIdInDomain = primaryQuoteIdInDomain;
        if (quotesCreated.length > 1) stats.quoteName = `${quotesCreated.length} cotizaciones "${quoteName}"`;
        else if (quotesCreated.length === 1) stats.quoteName = quotesCreated[0].name;
        const cotS = quotesCreated.length === 1 ? 'cotización' : 'cotizaciones';
        const cotV = quotesCreated.length === 1 ? 'creada' : 'creadas';
        addPanelLog(`${quotesCreated.length} ${cotS} ${cotV} con ${pnpItemsTotal} PNs y ${prodAddedTotal} productos`);
      } else {
        // SOLO_PN: build pnLookup from existing/new PN IDs (no quote context)
        // 1.2.11: keyed por rowIdx (índice en parts[]) — soporta duplicados name+customerId.
        setPanelPhase('Paso 1/5: SOLO_PN — construyendo mapa de PNs...'); setProgressBar(30);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i];
          let pnId;
          if (status.status === 'existing') { pnId = status.existingId; stats.pnsExisting++; }
          else { pnId = newPnIds.get(i); }
          if (!pnId) continue;
          pnLookup.set(i, {
            qpnp: null, pnp: null,
            pn: { id: pnId, name: part.pn, customerId: part.customerId, defaultProcessNodeId: part.processId, customInputs: {}, descriptionMarkdown: '', customerFacingNotes: '', geometryTypeId: null, partNumberGroupId: null },
            ql: null
          });
        }
        log(`  ${pnLookup.size} PNs mapeados (SOLO_PN)`);

        // SOLO_PN: Create standalone prices if precio is provided
        const pnpWithPrice = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part.precio === null && !part.qty) continue; // no price data
          const entry = pnLookup.get(i); if (!entry) continue;
          pnpWithPrice.push({
            partNumberId: entry.pn.id,
            processId: part.processId,
            customInputs: { DatosPrecio: { Divisa: (part.divisa && !isDash(part.divisa)) ? part.divisa : 'USD' } }, inputSchema: DIVISA_SCHEMA, uiSchema: DIVISA_UI,
            partNumberPriceLineItems: [{ title: '', price: part.precio || 0, productId: null, quoteInventoryItemId: null }],
            usePartNumberDescription: true, treatmentSelections: [], priceBuilders: [], informationalPriceDisplayItems: [], priceTiers: [],
            unitId: (part.unidadPrecio && PRICE_UNIT_MAP[part.unidadPrecio] !== undefined) ? PRICE_UNIT_MAP[part.unidadPrecio] : null,
            partNumberCustomInputs: null,
            quotePartNumberPrice: null // no quote
          });
        }
        if (pnpWithPrice.length) {
          setPanelPhase('Paso 2/5: SOLO_PN — creando precios standalone...'); setProgressBar(40);
          for (let i = 0; i < pnpWithPrice.length; i += 20) {
            const batch = pnpWithPrice.slice(i, i + 20);
            try {
              await api().query('SaveManyPartNumberPrices', {
                input: { quoteId: null, autoGenerateQuoteLines: false, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] }
              }, 'SaveManyPNP_PN');
              {
                // 1.4.13: el totalBatches referenciaba `quotePnIds` que no existe en SOLO_PN,
                // tiraba ReferenceError y se tragaba TODA la fase de precios standalone.
                // En SOLO_PN el iterable es `pnpWithPrice` — usar su length.
                const batchNum = Math.floor(i / 20) + 1;
                const totalBatches = Math.ceil(pnpWithPrice.length / 20);
                setPanelSubPhase(`Precios batch ${batchNum}/${totalBatches} (${batch.length} PNs)`);
                if (batchNum % 10 === 0 || batchNum === totalBatches) addPanelLog(`Precios: ${batchNum * 20} PNs procesados`);
              }
            } catch (e) {
              errors.push(`Precios standalone: ${String(e).substring(0, 120)}`);
            }
          }
          log(`  Precios standalone: ${pnpWithPrice.length}`);
          // Default price se aplica en STEP 8 releyendo prices del PN
        }
        setProgressBar(50);
      }

      // STEP 6: SavePartNumber (enrich) — runs in BOTH modes
      setPanelPhase(`${isSoloPN ? 'Paso 3/5' : 'Paso 6/9'}: Enriqueciendo PNs...`); setProgressBar(55);

      // V10 fix + 1.4.12: Pre-fetch existing predicted inventory usages para PNs existentes con
      // predictivos. SavePartNumber inserta sin id → unique constraint en (pn, inventoryItem) →
      // retry strippea los predictivos y se pierde la actualización. Pasamos el id existente
      // para forzar UPDATE.
      //
      // 1.4.12 (Fix W): antes era loop secuencial sin feedback (silent). En runs grandes (4000+
      // PNs existing con predictivo) tomaba 15-35 min con el panel mostrando "Paso 3/5:
      // Enriqueciendo PNs... 24364/24364 OK: 0" (residual del scan de archivados) — el usuario
      // lo veía como "atorado". Ahora:
      //   1) Skip resumeCompletedSet (en reanudación, ya se enriquecieron — su predictivo
      //      no se va a re-aplicar, así que ahorra el fetch).
      //   2) runPool concurrency = savePartNumber (8 por default) → 15-35 min → 2-5 min.
      //   3) setPanelPhase + setPanelSubPhase + setPanelProgress + bailIfStale.
      const existingPredictedMap = new Map(); // pnId → Map(inventoryItemId → existingRecordId)
      const predictedFetchTargets = [];
      const seenPredFetch = new Set();
      let predFetchSkippedByResume = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]; const st = pnStatus[i];
        if (st.status !== 'existing' || !p.predictiveUsage.length) continue;
        const e = pnLookup.get(i); if (!e?.pn?.id) continue;
        if (seenPredFetch.has(e.pn.id)) continue;
        const resumeKey = `${i}|${p.pn}|${p.customerId}`;
        if (resumeCompletedSet.has(resumeKey)) { predFetchSkippedByResume++; continue; }
        seenPredFetch.add(e.pn.id);
        predictedFetchTargets.push({ pnId: e.pn.id, name: e.pn.name || p.pn });
      }
      if (predFetchSkippedByResume) {
        log(`  Pre-fetch predictivos: ${predFetchSkippedByResume} PN(s) saltados (ya enriquecidos en corrida previa).`);
      }
      if (predictedFetchTargets.length) {
        // 1.4.25 Fix FF: prefix de paso. Es sub-fase del STEP 6 enrich, antes
        // del enrichWorker. Mantiene el "Paso 6/9" en pantalla.
        setPanelPhase(`Paso 6/9: Pre-fetch predictivos existentes (${predictedFetchTargets.length})`);
        setPanelProgress(0, predictedFetchTargets.length);
        const predFetchConcurrency = bulkCfg().concurrency.savePartNumber || 8;
        await runPool(
          predictedFetchTargets,
          async (target, _idx, myRunIdLocal) => {
            bailIfStale(myRunIdLocal);
            setPanelSubPhase(`Pre-fetch predictivos: ${target.name}`);
            try {
              const pnData = await api().query('GetPartNumber', { partNumberId: target.pnId });
              const exPred = pnData?.partNumberById?.predictedInventoryUsagesByPartNumberId?.nodes || [];
              const m = new Map();
              for (const ep of exPred) {
                const itemId = ep.inventoryItemByInventoryItemId?.id || ep.inventoryItemId;
                if (itemId && ep.id) m.set(String(itemId), ep.id);
              }
              existingPredictedMap.set(target.pnId, m);
            } catch (_) {}
          },
          predFetchConcurrency,
          (done, total) => { setPanelProgress(done, total); },
          myRunId
        );
        bailIfStale(myRunId);
      }
      if (existingPredictedMap.size) log(`  Pre-fetched predictivos existentes de ${existingPredictedMap.size} PNs`);

      // FIX 1 (2026-05-18): pool concurrente (default 5) en lugar de loop secuencial.
      // 9k PNs × 0.5-1s sec → 75 min se vuelven 15-30 min con concurrency 5.
      let okSP = 0, retrySP = 0;
      const enrichConcurrency = bulkCfg().concurrency.savePartNumber;
      // 1.4.25 Fix FF: mantener prefix de paso (sobreescribía a "Enriqueciendo PNs" sin número).
      setPanelPhase(`${isSoloPN ? 'Paso 3/5' : 'Paso 6/9'}: Enriqueciendo PNs (pool ${enrichConcurrency})`);
      setPanelProgress(0, parts.length);

      async function enrichWorker(part, idx, myRunId) {
        bailIfStale(myRunId);
        // Resume: si esta fila (rowIdx-aware) ya quedó completada en una corrida previa, brincarla.
        // 1.2.11: clave de resume incluye rowIdx para que duplicados name+customerId no se brinquen
        // por culpa de uno solo del grupo haber sido completado.
        const resumeKey = `${idx}|${part.pn}|${part.customerId}`;
        if (resumeCompletedSet.has(resumeKey)) {
          okSP++;
          state.counters.ok++;
          return;
        }
        const entry = pnLookup.get(idx);
        if (!entry) return;
        const pn = entry.pn;
        setPanelSubPhase(`Enriqueciendo: ${part.pn}`);

        // Guión comodín: "-" en primer label = borrar todos los labels
        const labelsAreDash = part.labels.length === 1 && isDash(part.labels[0]);
        // 1.2.10: Reportar etiquetas no encontradas en el catálogo de Steelhead.
        // Antes (≤1.2.9) se hacía .filter(Boolean) y los typos como "NIQu" desaparecían
        // sin warn ni error. Ahora cada nombre desconocido va a errors[] para que aparezca
        // en el reporte XLSX y el operador vea el problema.
        const labelIds = [];
        const unknownLabels = [];
        if (!labelsAreDash) {
          for (const n of part.labels) {
            const id = labelByName.get(n);
            if (id) labelIds.push(id);
            else unknownLabels.push(n);
          }
        }
        if (unknownLabels.length) {
          errors.push(`Etiqueta(s) no encontrada(s) en Steelhead para "${part.pn}": ${unknownLabels.join(', ')}`);
        }
        if (labelIds.length) stats.labelsSet += labelIds.length;

        // Fix C 1.3.2: pre-fetch del PN existente para poder filtrar specsToApply y NO
        // gatillar unique_constraint en la link table. Antes (≤1.3.1) este fetch solo se
        // hacía cuando hasArchiveSentinel — los demás PNs existing mandaban specsToApply
        // con specs ya linkeadas → primer SavePartNumber fallaba con duplicate-key →
        // strip1 quitaba specsToApply → 2x calls por PN.
        let existingPnNode = null;
        const statusEarly = pnStatus[idx];
        if (statusEarly?.status === 'existing' && pn.id) {
          existingPnNode = existingPnFullCache.get(pn.id);
          if (!existingPnNode) {
            try {
              bailIfStale(myRunId);
              const pnData = await withRetry(
                () => api().query('GetPartNumber', { partNumberId: pn.id }),
                `GetPartNumber prefetch "${pn.name}"`,
                myRunId
              );
              existingPnNode = pnData?.partNumberById || null;
              if (existingPnNode) existingPnFullCache.set(pn.id, existingPnNode);
            } catch (e) {
              if (isBail(e)) throw e;
              warn(`GetPartNumber prefetch "${pn.name}" falló (${String(e).substring(0, 80)}) — caerá al flujo strip1`);
            }
          }
        }
        const alreadyLinkedSpecIds = new Set();
        if (existingPnNode) {
          for (const ls of (existingPnNode.partNumberSpecsByPartNumberId?.nodes || [])) {
            if (ls.archivedAt) continue;
            const sid = ls.specBySpecId?.id; if (sid) alreadyLinkedSpecIds.add(sid);
          }
        }

        // Specs — semántica del guión:
        //   * `spec1=-` solo → archive sentinel "borrar todas las linked specs" (specsToApply queda [])
        //   * `spec1=Y, spec2=-` → apply Y + archive sentinel "borrar el resto que no sea Y"
        //   * `spec1=Y, spec2=Z, spec3=-` → apply Y,Z + archive el resto
        //   * sin "-" en ninguna posición → solo upsert (no archive). Comportamiento histórico.
        // 1.2.5: SavePartNumber.specsToApply es upsert/add-only (ver STEP 6b). Para archivar
        // de verdad hay que pasar IDs explícitos en partNumberSpecsToArchive — esos IDs son
        // del registro link (partNumberSpec.id), no del Spec mismo.
        const hasArchiveSentinel = part.specs.length > 0 && part.specs.some(s => isDash(s.name));
        const wantedSpecIds = new Set(); // si.id de las specs no-dash del CSV
        const specsToApply = [];
        for (const cs of part.specs) {
          if (isDash(cs.name)) continue; // "-" mezclado o solo: no se aplica (archive sentinel maneja el resto)
          const si = specByName.get(cs.name); if (!si) { errors.push(`Spec "${cs.name}" no encontrada.`); continue; }
          wantedSpecIds.add(si.id);
          const sd = sfCache.get(si.id); if (!sd) continue;
          const dS = [], gS = [];
          for (const sf of (sd.specFieldSpecsBySpecId?.nodes || [])) {
            const params = sf.defaultValues?.nodes || []; if (!params.length) continue;
            const fn = sf.specFieldBySpecFieldId?.name || '';
            const isEsp = fn.toLowerCase().includes('espesor');
            let pid;
            if (params.length === 1) pid = params[0].id;
            else if (isEsp && cs.param) { const m = params.find(p => p.name === cs.param); pid = m ? m.id : (errors.push(`"${cs.name}" "${fn}": "${cs.param}" no encontrado.`), params[0].id); }
            else pid = params[0].id;
            if (!pid) continue;
            const sel = { defaultParamId: pid, processNodeId: part.processId || pn.defaultProcessNodeId || null, processNodeOccurrence: (part.processId || pn.defaultProcessNodeId) ? 1 : null, locationId: null, geometryTypeSpecFieldId: null };
            if (sf.isGeneric) gS.push(sel); else dS.push(sel);
          }
          specsToApply.push({ specId: si.id, classificationSetId: null, classificationIds: [], defaultSelections: dS, genericSelections: gS });
          stats.specsSet++;
        }

        // partNumberSpecsToArchive: solo se popula si hay archive sentinel y el PN ya existe.
        // Para PN nuevo no hay nada que archivar. El fetch on-demand reusa existingPnFullCache
        // para que STEP 6b no vuelva a pegarle a GetPartNumber del mismo PN.
        const partNumberSpecsToArchiveIds = [];
        const statusForArchive = pnStatus[idx];
        if (hasArchiveSentinel && statusForArchive?.status === 'existing' && pn.id) {
          // Fix C 1.3.2: existingPnNode ya fue pre-fetched arriba para todo PN existing;
          // no hace falta un segundo GetPartNumber aquí.
          const cached = existingPnNode;
          const linked = cached?.partNumberSpecsByPartNumberId?.nodes || [];
          for (const ls of linked) {
            if (ls.archivedAt) continue;
            const linkedSpecId = ls.specBySpecId?.id;
            if (!linkedSpecId) continue;
            if (!wantedSpecIds.has(linkedSpecId)) partNumberSpecsToArchiveIds.push(ls.id);
          }
          if (partNumberSpecsToArchiveIds.length) {
            stats.specsArchivedBySentinel = (stats.specsArchivedBySentinel || 0) + partNumberSpecsToArchiveIds.length;
            log(`  "${pn.name}": archive sentinel → ${partNumberSpecsToArchiveIds.length} specs serán archivadas`);
          }
        }

        // Unit conversions — guión en cualquier campo = borrar todas (enviar inventoryItemInput null)
        const ucDash = [part.unitConv.kgm, part.unitConv.cmk, part.unitConv.lm, part.unitConv.minPzasLote]
          .some(v => typeof v === 'string' && isDash(v));
        const ucs = [];
        if (!ucDash) {
          const uc = part.unitConv;
          if (uc.kgm !== null) { ucs.push({ unitId: DOMAIN.unitIds.KGM, factor: uc.kgm }); ucs.push({ unitId: DOMAIN.unitIds.LBR, factor: uc.kgm * DOMAIN.conversions.KGM_TO_LBR }); }
          if (uc.cmk !== null) { ucs.push({ unitId: DOMAIN.unitIds.CMK, factor: uc.cmk }); ucs.push({ unitId: DOMAIN.unitIds.FTK, factor: uc.cmk * DOMAIN.conversions.CMK_TO_FTK }); }
          if (uc.lm !== null) { ucs.push({ unitId: DOMAIN.unitIds.LM, factor: uc.lm }); ucs.push({ unitId: DOMAIN.unitIds.FOT, factor: uc.lm * DOMAIN.conversions.LM_TO_FOT }); }
          if (uc.minPzasLote !== null && uc.minPzasLote > 0) ucs.push({ unitId: DOMAIN.unitIds.LO, factor: 1 / uc.minPzasLote });
        }
        if (ucs.length || ucDash) stats.unitConvSet++;

        // Fix C 1.3.2: para PNs existing, las specs ya linkeadas no se reenvían — Steelhead
        // las trata como unique_constraint en partNumberSpec (pnId, specId).
        const specsToApplyFiltered = alreadyLinkedSpecIds.size
          ? specsToApply.filter(s => !alreadyLinkedSpecIds.has(s.specId))
          : specsToApply;

        const mergedCI = mergeCustomInputs(pn.customInputs, part);
        if (part.codigoSAT || part.metalBase || part.pnAlterno) stats.ciSet++;

        // 1.4.11: Call A del Split A/B — identifier-enrich.
        // Antes (≤1.4.10) el único SavePartNumber por PN mandaba TODO de una vez:
        // labels + customInputs (BaseMetal, QuoteIBMS) + specs + params + dims +
        // archive + processNode. Si truena DESPUÉS de classifyPNs pero ANTES de
        // que SavePartNumber commitee, al reanudar `classifyPNs` veía el PN
        // existente todavía SIN labels y SIN QuoteIBMS — pases 1/2 del matcher
        // no detectaban duplicados → `forceNew` → PN duplicado en el catálogo.
        // Repro real: corrida que tronó a 4795/4799 dejó 58 PNs duplicados al
        // reanudar.
        //
        // 1.4.11 fix: hacer DOS SavePartNumber por PN. Call A primero (labels +
        // customInputs + name + customerId + inputSchemaId con todo lo demás
        // vacío) → persistir rowKey en `resumeState.identifierEnrichDone[]` con
        // flush incremental cada 50. Call B (todo lo pesado) se mantiene igual.
        // Si truena entre A y B, el siguiente resume corre classifyPNs sobre un
        // catálogo donde el PN existente ya trae labels/BaseMetal/QuoteIBMS
        // frescos → matcheo limpio.
        //
        // Coste por PN: +1 round-trip SavePartNumber (~0.3-0.5s) — compensado
        // por el bump de concurrency 5→8 en este mismo release.
        const identifierKey = `${idx}|${part.pn}|${part.customerId}`;
        if (!resumeIdentifierSet.has(identifierKey)) {
          const identifierInput = {
            id: pn.id, name: pn.name, customerId: pn.customerId || part.customerId,
            descriptionMarkdown: pn.descriptionMarkdown || '',
            customerFacingNotes: pn.customerFacingNotes || '',
            customInputs: mergedCI || pn.customInputs || {},
            inputSchemaId: DOMAIN.inputSchemaId_PN,
            labelIds: labelsAreDash ? [] : labelIds,
            partNumberGroupId: pn.partNumberGroupId || null,
            // Heavy fields explícitamente vacíos — Steelhead acepta el shape mínimo
            // como un upsert idempotente de identificadores.
            defaultProcessNodeId: pn.defaultProcessNodeId || null,
            geometryTypeId: pn.geometryTypeId || null,
            inventoryItemInput: null, inventoryPredictedUsages: [],
            specsToApply: [], paramsToApply: [], partNumberDimensions: [],
            partNumberLocations: [], dimensionCustomValueIds: [],
            isCoupon: false, isOneOff: false, isTemplatePartNumber: false,
            optInOuts: [], ownerIds: [], defaults: [],
            partNumberSpecClassificationsToUpdate: [],
            partNumberSpecFieldParamUpdates: [],
            partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
            partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
            specFieldParamUpdates: [],
            glAccountId: null, taxCodeId: null, certPdfTemplateId: null, userFileName: null
          };
          bailIfStale(myRunId);
          try {
            await withRetry(
              () => api().query('SavePartNumber', { input: [identifierInput] }),
              `SavePartNumber-A (identifier) "${pn.name}"`,
              myRunId
            );
            resumeIdentifierSet.add(identifierKey);
            if (resumeState) {
              resumeState.identifierEnrichDone.push(identifierKey);
              // Persistir cada 50 — mismo ritmo que completedPNs para no inundar localStorage.
              if (resumeState.identifierEnrichDone.length % 50 === 0) {
                persistResumeState().catch(() => {});
              }
            }
          } catch (eA) {
            if (isBail(eA)) throw eA;
            // Call A falló: NO marcamos identifierEnrichDone. Call B sigue intentando
            // (con el pnInput completo); si Steelhead acepta B con todos los campos,
            // el PN queda enriched. Si B también falla, error queda registrado.
            // Loggeamos warn para diagnóstico pero no abortamos el worker.
            warn(`SavePartNumber-A (identifier) "${pn.name}" falló (${String(eA).substring(0, 80)}) — caemos a Call B con pnInput completo`);
          }
        }

        // Dims — "-" en longitud = borrar dimensiones
        const dimsAreDash = typeof part.dims.length === 'string' && isDash(part.dims.length);
        const dims = dimsAreDash ? [] : buildDimensions(part.dims, DOMAIN);
        const hasDims = dims.length > 0; if (hasDims) stats.dimsSet++;

        // Predictive — 1.3.1: dash granular por material. SavePartNumber.inventoryPredictedUsages
        // solo lleva los predictivos con valor numérico (los nuevos para el PN). Los con
        // usagePerPart='-' los archiva STEP 6a vía UpdateInventoryItemPredictedUsage(microQuantityPerPart=0).
        const finalPredictive = part.predictiveUsage.filter(pu => !isDash(String(pu.usagePerPart)));
        if (finalPredictive.length) stats.predictiveSet++;

        // OptIn: TRUE = activar, FALSE = desactivar (enviar [])
        const optInOuts = [];
        if (part.validacion1er) {
          const nodeIds = DOMAIN.validacionProcessNodeIds || [DOMAIN.validacionProcessNodeId];
          for (const nodeId of nodeIds) {
            optInOuts.push({ processNodeId: nodeId, processNodeOccurrence: 1, cancelOthers: false });
          }
          stats.validacionSet++;
        }

        // Grupo — "-" = quitar grupo
        const pnGroupId = isDash(part.pnGroup) ? null : (part.pnGroup ? (await resolveGroupId(part.pnGroup)) : pn.partNumberGroupId || null);

        // Dimension custom value IDs (Línea/Departamento)
        const dimValueIds = [];
        if (part.linea && !isDash(part.linea)) { const id = dimValueMap.get(part.linea); if (id) dimValueIds.push(id); else warn(`Línea "${part.linea}" no encontrada en dimensiones`); }
        if (part.departamento && !isDash(part.departamento)) { const id = dimValueMap.get(part.departamento); if (id) dimValueIds.push(id); else warn(`Departamento "${part.departamento}" no encontrado en dimensiones`); }
        const pnProcessId = part.processId;

        const pnInput = {
          id: pn.id, name: pn.name, customerId: pn.customerId || part.customerId, defaultProcessNodeId: pnProcessId,
          descriptionMarkdown: resolveStr(part.descripcion, pn.descriptionMarkdown || ''), customerFacingNotes: pn.customerFacingNotes || '',
          customInputs: mergedCI || pn.customInputs || {}, inputSchemaId: DOMAIN.inputSchemaId_PN, labelIds,
          partNumberGroupId: pnGroupId,
          geometryTypeId: hasDims ? DOMAIN.geometryGenericaId : (pn.geometryTypeId || null),
          inventoryItemInput: ucs.length ? { materialId: null, purchasable: false, sourceMaterialConversionType: null, providedMaterialConversionType: null, defaultLeadTime: null, unitConversions: ucs, inventoryItemVendors: [] } : null,
          inventoryPredictedUsages: finalPredictive
            .filter(pu => !existingPredictedMap.get(pn.id)?.has(String(pu.inventoryItemId)))
            .map(pu => ({ inventoryItemId: pu.inventoryItemId, usagePerPart: pu.usagePerPart, lowCodeId: null })),
          specsToApply: specsToApplyFiltered, isCoupon: false, isOneOff: false, isTemplatePartNumber: false, optInOuts, ownerIds: [], defaults: [],
          dimensionCustomValueIds: dimValueIds,
          paramsToApply: [], partNumberDimensions: dims, partNumberLocations: [],
          partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [], partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
          partNumberSpecsToArchive: partNumberSpecsToArchiveIds, partNumberSpecsToUnarchive: [], specFieldParamUpdates: [],
          glAccountId: null, taxCodeId: null, certPdfTemplateId: null, userFileName: null
        };

        bailIfStale(myRunId);
        // 1.4.13 Fix Y: pnSucceeded gating — antes (≤1.4.12) este bloque marcaba el rkey
        // en resumeState.completedPNs aunque SavePartNumber hubiera fallado por red
        // (Failed to fetch) o por retry exhausted. Eso causó "false-completed PNs": entradas
        // que el resume brincaba silenciosamente sin tener labels/specs reales en Steelhead.
        // Síntoma: en runs con red intermitente, el listado quedaba con bloques de PNs
        // vacíos intercalados con bloques OK, mientras el panel reportaba "Labels: 0".
        let pnSucceeded = false;
        try {
          try {
            // withRetry para 429/503/network; unique_constraint cae a la lógica progresiva abajo
            await withRetry(
              () => api().query('SavePartNumber', { input: [pnInput] }),
              `SavePartNumber "${pnInput.name}"`,
              myRunId
            );
            okSP++;
            state.counters.ok++;
            pnSucceeded = true;
          }
          catch (e) {
            if (isBail(e)) throw e;
            const errStr = String(e);
            if (isDuplicateKeyError(e)) {
              // Retry progressively removing fields that cause duplicates
              try {
                await withRetry(
                  () => api().query('SavePartNumber', { input: [{ ...pnInput, specsToApply: [], optInOuts: [] }] }),
                  `SavePartNumber "${pnInput.name}" strip1`,
                  myRunId
                );
                retrySP++; state.counters.retried++; log(`  -> ${pnInput.name}: retry sin specs/optIn OK`);
                pnSucceeded = true;
              } catch (e2) {
                if (isBail(e2)) throw e2;
                try {
                  await withRetry(
                    () => api().query('SavePartNumber', { input: [{ ...pnInput, specsToApply: [], optInOuts: [], inventoryPredictedUsages: [] }] }),
                    `SavePartNumber "${pnInput.name}" strip2`,
                    myRunId
                  );
                  retrySP++; state.counters.retried++; log(`  -> ${pnInput.name}: retry mínimo OK`);
                  pnSucceeded = true;
                } catch (e3) {
                  if (isBail(e3)) throw e3;
                  errors.push(`${pnInput.name}: retry falló: ${String(e3).substring(0, 120)}`);
                  state.counters.errors++;
                }
              }
            } else {
              errors.push(`SavePartNumber "${pnInput.name}": ${errStr.substring(0, 120)}`);
              state.counters.errors++;
            }
          }
        } finally {
          // 1.4.15 Fix Y: invalidar cache SIEMPRE (antes solo en path de éxito, líneas
          // 4047/4062/4073). Si bailIfStale arroja BailError o retry exhausted, el pnNode
          // ~25KB quedaba retenido en existingPnFullCache hasta el fin del run. Para 3,700
          // PNs en concurrency 8, los fallos acumulados eran ~90MB que nunca se liberaban.
          // STEP 6b vuelve a fetchear fresh via GetPartNumber si necesita el pnNode.
          // Mismo patrón que Fix Z aplicó al STEP 5 (línea 3332).
          if (pn.id) existingPnFullCache.delete(pn.id);
        }

        // Persistencia incremental para resume (Fix 7) — cada 50 PNs procesados.
        // 1.2.11: clave incluye rowIdx para distinguir duplicados name+customerId.
        // 1.4.13: solo persiste si pnSucceeded — un PN con SavePartNumber fallado se
        // reintentará en la próxima reanudación en lugar de quedar como false-completed.
        if (pnSucceeded && resumeState) {
          const rkey = `${idx}|${part.pn}|${part.customerId}`;
          resumeState.completedPNs.push(rkey);
          if ((okSP + retrySP) % 50 === 0) {
            persistResumeState().catch(() => {});
          }
        }
      }

      await runPool(
        parts,
        enrichWorker,
        enrichConcurrency,
        (done, total) => { setPanelProgress(done, total); setPanelCounters(); setProgressBar(55 + Math.round((done / Math.max(total, 1)) * 20)); },
        myRunId
      );
      bailIfStale(myRunId);
      log(`  SavePartNumber: ${okSP} OK, ${retrySP} retry`);
      addPanelLog(`Enrich: ${okSP} OK, ${retrySP} retry`);
      if (resumeState) { resumeState.phase = 'enrich-done'; await persistResumeState(); }
      // 1.4.15 Fix Y: clear cache entre STEP 6 y STEP 6a/6b. Defensa en profundidad —
      // el finally del enrichWorker (Fix Y) ya limpia por item, pero un BailError
      // mid-pool puede dejar 8 orfanos × ~25KB = ~200KB. STEP 6b re-fetchea vía
      // GetPartNumber on-demand (líneas ~4222 con cache miss).
      existingPnFullCache.clear();

      // STEP 6a: Actualizar predictivos existentes vía UpdateInventoryItemPredictedUsage.
      // Steelhead almacena en microQuantityPerPart (kg/pza × 1e6 redondeado).
      // 1.3.3: dash granular por material AHORA archiva real vía ArchivePredictedInventoryUsage
      // (input singular {id, predictedInventoryUsagePatch:{archivedAt}}). Antes (1.3.1-1.3.2) se
      // mandaba microQuantityPerPart=0 — los dejaba inertes pero seguían listados en Predicted
      // Inventory Usage. Se separan dos buckets: numérico → UpdateInventoryItemPredictedUsage
      // (batch 20), dash → ArchivePredictedInventoryUsage (singular, paralelo con pool).
      const predictedUpdates = [];
      const predictedArchives = []; // ids a archivar (dash granular)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        if (status.status !== 'existing') continue;
        if (!part.predictiveUsage.length) continue;
        const entry = pnLookup.get(i);
        const exMap = entry?.pn?.id ? existingPredictedMap.get(entry.pn.id) : null;
        if (!exMap || !exMap.size) continue;
        for (const pu of part.predictiveUsage) {
          const exId = exMap.get(String(pu.inventoryItemId));
          if (!exId) continue; // es uno nuevo, ya fue al SavePartNumber (o no existe en el PN)
          if (isDash(String(pu.usagePerPart))) {
            predictedArchives.push(exId);
            continue;
          }
          const micro = Math.round(parseFloat(pu.usagePerPart) * 1e6);
          if (!Number.isFinite(micro)) continue;
          predictedUpdates.push({ id: exId, microQuantityPerPart: micro, inventoryUsageLowCodeId: null });
        }
      }
      // 1.4.25 Fix FF: setPanelPhase para STEP 6a (predictivos). Antes el modal
      // quedaba en "Paso 6/9: Enriqueciendo PNs..." durante esta fase, aunque
      // STEP 6 ya hubiera terminado.
      const predTotalOps = predictedUpdates.length + predictedArchives.length;
      if (predTotalOps) {
        setPanelPhase(`Paso 6a/9: Predictivos (${predictedUpdates.length} update / ${predictedArchives.length} archive)`);
        setPanelProgress(0, predTotalOps);
        setProgressBar(75);
      }
      if (predictedUpdates.length) {
        // Batches de 20 para no abusar del payload
        let predUpdDone = 0;
        for (let i = 0; i < predictedUpdates.length; i += 20) {
          const batch = predictedUpdates.slice(i, i + 20);
          setPanelSubPhase(`Predictivos: batch ${Math.floor(i / 20) + 1} (${batch.length} items)`);
          try {
            await api().query('UpdateInventoryItemPredictedUsage', { mnPredictedInventoryUsagePatch: batch }, 'UpdateInventoryItemPredictedUsage');
          } catch (e) {
            errors.push(`UpdatePredictedUsage batch ${Math.floor(i / 20) + 1}: ${String(e).substring(0, 120)}`);
          }
          predUpdDone += batch.length;
          setPanelProgress(predUpdDone, predTotalOps);
        }
        log(`  Predictivos actualizados: ${predictedUpdates.length}`);
      }
      if (predictedArchives.length) {
        // ArchivePredictedInventoryUsage es input singular {input:{id, predictedInventoryUsagePatch:{archivedAt}}}.
        // Pool concurrente para no serializar — 1 round-trip por predictivo a archivar.
        const archivedAt = new Date().toISOString();
        let archivedOk = 0;
        await runPool(predictedArchives, async (exId) => {
          bailIfStale(myRunId);
          setPanelSubPhase(`Archivando predictivo id=${exId}`);
          try {
            await withRetry(
              () => api().query('ArchivePredictedInventoryUsage', { input: { id: exId, predictedInventoryUsagePatch: { archivedAt } } }, 'ArchivePredictedInventoryUsage'),
              `ArchivePredictedInventoryUsage(id=${exId})`,
              myRunId
            );
            archivedOk++;
          } catch (e) {
            if (isBail(e)) throw e;
            errors.push(`ArchivePredictedInventoryUsage(id=${exId}): ${String(e).substring(0, 120)}`);
          }
        }, bulkCfg().concurrency.savePartNumber || 5,
          // 1.4.25 Fix FF: callback de progreso global (update + archive).
          (done) => { setPanelProgress(predictedUpdates.length + done, predTotalOps); },
          myRunId);
        log(`  Predictivos archivados: ${archivedOk}/${predictedArchives.length}`);
      }

      // STEP 6b: Sync params on existing PNs whose specs were already linked.
      // SavePartNumber.specsToApply ignora specs ya ligadas — si el usuario agregó un field
      // nuevo a la spec definición, no se aplica al PN. Aquí lo emparejamos con AddParamsToPartNumber.
      // 1.3.1: Cuenta candidatos primero y reporta progreso por iteración. Antes el panel
      // quedaba pegado en "Enriqueciendo PNs (pool N)" del STEP 6 mientras este loop
      // secuencial procesaba 100+ PNs uno por uno con varios AddParamsToPartNumber cada uno;
      // parecía atorado aunque sí avanzaba.
      const step6bCandidates = [];
      for (let i = 0; i < parts.length; i++) {
        const status = pnStatus[i]; const part = parts[i];
        if (status.status !== 'existing' || !part.specs.length) continue;
        if (part.specs.length === 1 && isDash(part.specs[0].name)) continue;
        step6bCandidates.push(i);
      }
      // Fix D 1.3.2: runPool concurrencia 5 para STEP 6b. Antes (1.3.1) el loop era
      // secuencial; con 100+ candidatos × varios AddParamsToPartNumber por PN, esto
      // dominaba el tiempo total (>50% del wall-clock para corridas Schneider).
      const syncConcurrency = bulkCfg().concurrency.savePartNumber; // reusamos la misma config (5)
      const syncCounters = { synced: 0 };
      // 1.4.9 STEP 0 cleanup defensivo: contador de params duplicados archivados
      // por el cleanup integrado en STEP 6b (ver comentario abajo).
      const cleanupCounters = { archived: 0, pnsTouched: 0 };
      // 1.4.24 Fix EE: set en memoria hidratado desde resumeState para skip rápido.
      // Si una corrida previa crasheó en STEP 6b al PN 691/3692, esta reanudación
      // saltea esos 691 sin volver a pegarle a GetPartNumber + AddParams.
      const syncParamsCompletedSet = new Set(resumeState?.syncParamsCompletedPNs || []);
      async function step6bWorker(i, _idx, myRunIdLocal) {
        bailIfStale(myRunIdLocal);
        const part = parts[i];
        const entry = pnLookup.get(i);
        if (!entry?.pn?.id) return;
        // 1.4.24 Fix EE: skip si esta fila ya completó STEP 6b en corrida previa.
        const rkey = `${i}|${part.pn}|${part.customerId}`;
        if (syncParamsCompletedSet.has(rkey)) return;
        setPanelSubPhase(`Sync params: ${part.pn}`);
        let workerError = null;
        try {
          // Fix I 1.3.2: cache invalidado por enrichWorker → fetch fresco con los specs/params
          // que SavePartNumber acaba de agregar. Sin esto, AddParams reintenta params ya creados.
          let pnNode = existingPnFullCache.get(entry.pn.id);
          if (!pnNode) {
            const pnData = await withRetry(
              () => api().query('GetPartNumber', { partNumberId: entry.pn.id }),
              `GetPartNumber sync "${part.pn}"`,
              myRunIdLocal
            );
            pnNode = pnData?.partNumberById; if (!pnNode) return;
            existingPnFullCache.set(entry.pn.id, pnNode);
          }
          const linkedSpecs = pnNode.partNumberSpecsByPartNumberId?.nodes || [];
          let allParams = pnNode.partNumberSpecFieldParamsByPartNumberId?.nodes || [];

          // 1.4.9 STEP 0 cleanup defensivo (idempotente): detectar params
          // duplicados causados por bug 1.3.x-1.4.8 — STEP 6b insertaba con
          // processNodeId: null mientras STEP 6 ponía processNodeId real. Si
          // existe el par (mismo specFieldParamId con processNodeId null Y
          // otro con processNodeId !== null), archivamos el null.
          // Corre dentro del worker porque ya tenemos el GetPartNumber fresco
          // — cero round-trips extra fuera del SavePartNumber del archive.
          const paramsBySfpId = new Map();
          for (const p of allParams) {
            if (p.archivedAt || !p.specFieldParamBySpecFieldParamId) continue;
            const sfpId = p.specFieldParamBySpecFieldParamId.id;
            if (!paramsBySfpId.has(sfpId)) paramsBySfpId.set(sfpId, []);
            paramsBySfpId.get(sfpId).push(p);
          }
          const duplicateNullIdsToArchive = [];
          for (const [, rows] of paramsBySfpId) {
            if (rows.length < 2) continue;
            const hasNonNull = rows.some(r => r.processNodeId);
            if (!hasNonNull) continue;
            for (const r of rows) {
              if (!r.processNodeId) duplicateNullIdsToArchive.push(r.id);
            }
          }
          if (duplicateNullIdsToArchive.length) {
            const cleanupInput = {
              id: entry.pn.id,
              name: pnNode.name,
              customerId: pnNode.customerId || part.customerId,
              defaultProcessNodeId: pnNode.defaultProcessNodeId || part.processId,
              inputSchemaId: DOMAIN.inputSchemaId_PN,
              customInputs: pnNode.customInputs || {},
              geometryTypeId: pnNode.geometryTypeId || null,
              userFileName: null,
              inventoryItemInput: null,
              glAccountId: null, taxCodeId: null, certPdfTemplateId: null,
              isOneOff: false, isTemplatePartNumber: false, isCoupon: false,
              partNumberGroupId: pnNode.partNumberGroupId || null,
              descriptionMarkdown: pnNode.descriptionMarkdown || '',
              customerFacingNotes: pnNode.customerFacingNotes || '',
              labelIds: [], ownerIds: [], defaults: [], optInOuts: [],
              inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
              partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [],
              partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
              partNumberSpecFieldParamsToArchive: duplicateNullIdsToArchive,
              partNumberSpecFieldParamsToUnarchive: [],
              partNumberSpecClassificationsToUpdate: [],
              partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: []
            };
            try {
              await withRetry(
                () => api().query('SavePartNumber', { input: [cleanupInput] }),
                `SavePartNumber cleanup-dups "${pnNode.name}"`,
                myRunIdLocal
              );
              cleanupCounters.archived += duplicateNullIdsToArchive.length;
              cleanupCounters.pnsTouched++;
              log(`  PN "${part.pn}": cleanup ${duplicateNullIdsToArchive.length} params duplicados (processNodeId: null) archivados`);
              // Reflejar en memoria: filtrar params recién archivados para que
              // el dedup tuple del loop siguiente no los vea como existentes.
              const archivedSet = new Set(duplicateNullIdsToArchive);
              allParams = allParams.filter(p => !archivedSet.has(p.id));
              // Invalidar cache para que cualquier consumidor posterior fetchee fresco.
              existingPnFullCache.delete(entry.pn.id);
            } catch (e) {
              if (isBail(e)) throw e;
              errors.push(`Cleanup dups "${part.pn}": ${String(e).substring(0, 120)}`);
            }
          }

          for (const cs of part.specs) {
            if (isDash(cs.name)) continue;
            const si = specByName.get(cs.name); if (!si) continue;
            const linked = linkedSpecs.find(s => s.specBySpecId?.id === si.id && !s.archivedAt);
            if (!linked) continue;
            const sd = sfCache.get(si.id); if (!sd) continue;
            const wantedSelections = [];
            for (const sf of (sd.specFieldSpecsBySpecId?.nodes || [])) {
              const params = sf.defaultValues?.nodes || []; if (!params.length) continue;
              const fn = sf.specFieldBySpecFieldId?.name || '';
              const isEsp = fn.toLowerCase().includes('espesor');
              let pid;
              if (params.length === 1) pid = params[0].id;
              else if (isEsp && cs.param) { const m = params.find(p => p.name === cs.param); pid = m ? m.id : params[0].id; }
              else pid = params[0].id;
              if (!pid) continue;
              wantedSelections.push({ specFieldId: sf.specFieldBySpecFieldId?.id, specFieldParamId: pid, isGeneric: !!sf.isGeneric });
            }
            // Fix 1.4.9: dedup por tuple (specFieldParamId, processNodeId).
            // Antes (≤1.4.8) era solo por specFieldParamId — y `paramsToAdd` insertaba
            // con processNodeId: null. Resultado: si STEP 6 (enrichWorker) ya había
            // dejado un row con processNodeId real para el mismo param, STEP 6b lo
            // duplicaba con processNodeId: null. El dedup tuple + asignar el mismo
            // processNodeId que STEP 6 usaría (part.processId || pn.defaultProcessNodeId)
            // resuelve ambos lados del bug.
            const targetProcessNodeId = part.processId || pnNode.defaultProcessNodeId || null;
            const targetOccurrence = targetProcessNodeId ? 1 : null;
            const existingParamKeys = new Set(
              allParams.filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId)
                       .map(p => `${p.specFieldParamBySpecFieldParamId.id}|${p.processNodeId || ''}`)
            );
            const missing = wantedSelections.filter(s =>
              !existingParamKeys.has(`${s.specFieldParamId}|${targetProcessNodeId || ''}`)
            );
            if (!missing.length) continue;
            const paramsToAdd = missing.map(m => ({
              specFieldId: m.specFieldId, specFieldParamId: m.specFieldParamId, isGeneric: m.isGeneric,
              geometryTypeSpecFieldId: null, processNodeId: targetProcessNodeId, processNodeOccurrence: targetOccurrence, locationId: null
            }));
            let added = 0;
            for (const pa of paramsToAdd) {
              if (isStale(myRunIdLocal)) return;
              try {
                await api().query('AddParamsToPartNumber', { input: { partNumberId: entry.pn.id, paramsToApply: [pa] } }, 'AddParamsToPartNumber');
                added++;
              } catch (e) {
                const msg = String(e);
                if (msg.includes('exclusion constraint') || msg.includes('conflicting key') || msg.includes('23P01')) {
                  // Fix D 1.3.2: skip silencioso — antes (1.3.1) loggeábamos "ya presente, skip" por cada
                  // param ya existente, lo que llenaba consola con N × M × PNs líneas inútiles. Con Fix I
                  // (cache invalidado tras SavePartNumber) esto debería ser raro; cuando ocurre, queda solo
                  // como contador implícito (added no incrementa).
                } else {
                  errors.push(`AddParams "${part.pn}" spec "${cs.name}" param ${pa.specFieldParamId}: ${msg.substring(0, 120)}`);
                }
              }
            }
            syncCounters.synced += added;
            if (added) log(`  PN "${part.pn}" spec "${cs.name}": ${added} params nuevos sincronizados`);
          }
        } catch (e) {
          if (isBail(e)) throw e;
          workerError = e;
          warn(`Sync specs "${part.pn}": ${String(e).substring(0, 100)}`);
        } finally {
          // 1.4.24 Fix EE: liberar buffer del PN procesado. Antes el cache
          // retenía ~25KB × N PNs hasta el clear() final post-STEP 6b — para
          // 3692 PNs eso son ~92MB acumulados solo en pnNodes, sin contar el
          // overhead de Apollo cache (__typename normalization).
          if (entry?.pn?.id) existingPnFullCache.delete(entry.pn.id);
        }
        // 1.4.24 Fix EE: marcar completed sólo si no hubo error. Persistir cada 50
        // — mismo ritmo que completedPNs de STEP 6. Si ocurre OOM/crash a mitad,
        // el set en localStorage refleja PNs realmente terminados.
        if (!workerError && resumeState) {
          resumeState.syncParamsCompletedPNs.push(rkey);
          syncParamsCompletedSet.add(rkey);
          if (resumeState.syncParamsCompletedPNs.length % 50 === 0) {
            persistResumeState().catch(() => {});
          }
        }
      }
      // 1.4.25 Fix FF: prefix "Paso 6b/9" para mantener numeración consistente
      // con los otros pasos del modal. Sin esto, en STEP 6b el modal mostraba
      // sólo "Sync params spec en PNs existentes" sin indicar dónde estamos en
      // el pipeline de 9 pasos.
      setPanelPhase(`Paso 6b/9: Sync params spec en PNs existentes (pool ${syncConcurrency})`);
      setPanelProgress(0, step6bCandidates.length);
      setProgressBar(76);
      await runPool(
        step6bCandidates,
        step6bWorker,
        syncConcurrency,
        (done, total) => { setPanelProgress(done, total); setPanelCounters(); },
        myRunId
      );
      if (syncCounters.synced) log(`  Spec params sync: ${syncCounters.synced} params agregados`);
      if (cleanupCounters.archived) log(`  Cleanup duplicados (1.4.9): ${cleanupCounters.archived} params null archivados en ${cleanupCounters.pnsTouched} PNs`);
      // 1.4.9: checkpoint intermedio. Si un crash ocurre en STEP 7/8, el modal
      // de resume muestra "sync-done" y el operador sabe que STEP 5/6/6b ya
      // pasaron — útil para diagnóstico aunque no implementemos skip-by-phase.
      if (resumeState) { resumeState.phase = 'sync-done'; await persistResumeState(); }
      // 1.4.15 Fix Y: clear cache entre STEP 6b y STEP 7. STEP 7 (Racks) y STEP 8
      // (default price + archive) NO usan existingPnFullCache — solo invocan otras
      // queries por pnId. Sin clear, los pnNodes acumulados en 6b se mantienen
      // hasta el GC del run.
      existingPnFullCache.clear();
      bailIfStale(myRunId);

      // STEP 7: RackTypes — runs in BOTH modes
      // 1.2.11: iteramos con índice para resolver pnLookup por rowIdx. Si la fila CSV NO trae
      // racks (Bug C), no contribuye nada — ya no hay riesgo de que rows duplicadas (mismo
      // name+customerId) compartan entry y se infecten con el rack de la otra.
      // Además: dedup por (rackTypeId, partNumberId) — si 2 filas del CSV apuntan al mismo PN
      // físico (Pase 1 IBMS coincidente) con el mismo rack, evitamos el duplicate-key insert.
      setPanelPhase(`${isSoloPN ? 'Paso 4/5' : 'Paso 7/9'}: Racks...`); setProgressBar(78);
      const rackIn = [];
      const rackInSeen = new Set(); // "rtId|pnId" para dedup intra-corrida
      const racksToDelete = new Set(); // pn.id (Set para auto-dedup)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.racks.length) continue;
        const entry = pnLookup.get(i); if (!entry) continue;
        if (part.racks.length === 1 && isDash(part.racks[0].name)) {
          racksToDelete.add(entry.pn.id);
          continue;
        }
        for (const rk of part.racks) {
          if (isDash(rk.name)) continue;
          const rt = rackTypeByName.get(rk.name); if (!rt) { errors.push(`RackType "${rk.name}" no encontrado.`); continue; }
          if (rk.ppr === null) continue;
          // Fix M 1.4.2: partsPerRack es Int en GraphQL. Si la celda CSV trae decimal
          // (fórmula con resultado no-entero, error de pegado), Math.floor evita el
          // HTTP 400 que en 1.4.1 tiraba el batch entero de 50 racks — el catch de
          // SavePartNumberRackTypes solo hace fallback uno-por-uno si el error es
          // duplicate-key, no si es validación de tipo.
          const ppr = Math.floor(rk.ppr);
          if (!Number.isFinite(ppr)) continue;
          if (ppr !== rk.ppr) log(`  WARN: rack "${rk.name}" PN id ${entry.pn.id} ppr=${rk.ppr} no entero → redondeado a ${ppr}`);
          const key = `${rt.id}|${entry.pn.id}`;
          if (rackInSeen.has(key)) continue; // misma combinación ya agregada por otra fila
          rackInSeen.add(key);
          rackIn.push({ rackTypeId: rt.id, partNumberId: entry.pn.id, partsPerRack: ppr });
        }
      }
      // Delete racks for PNs with guión
      if (racksToDelete.size) {
        // 1.4.25 Fix FF: subPhase visible para el delete loop de racks.
        let delDone = 0;
        for (const pnId of racksToDelete) {
          delDone++;
          setPanelSubPhase(`Borrando racks ${delDone}/${racksToDelete.size} (PN ${pnId})`);
          try {
            const pnData = await api().query('GetPartNumber', { partNumberId: pnId });
            const existingRacks = pnData?.partNumberById?.partNumberRackTypesByPartNumberId?.nodes || [];
            for (const rk of existingRacks) {
              await api().query('DeletePartNumberRackType', { id: rk.id });
              log(`  Rack ${rk.id} eliminado de PN ${pnId}`);
            }
            if (existingRacks.length) stats.racksSet += existingRacks.length;
          } catch (e) { errors.push(`Borrar racks PN ${pnId}: ${String(e).substring(0, 100)}`); }
        }
      }
      // Add new racks. Si ya existe el (rackType, PN) hay duplicate key —
      // entonces borramos el viejo y reinsertamos con el partsPerRack nuevo.
      async function upsertRack(rk) {
        try {
          await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: [rk], partNumberRackTypeIdsToDelete: [] } });
        } catch (e2) {
          if (isDuplicateKeyError(e2)) {
            // V10: usar mutación dedicada UpdatePartNumberPerPerRackType (typo en el API real)
            // que actualiza por composite key (partNumberId, rackTypeId).
            try {
              await api().query('UpdatePartNumberPerPerRackType', {
                partNumberId: rk.partNumberId,
                partsPerRack: rk.partsPerRack,
                rackTypeId: rk.rackTypeId
              }, 'UpdatePartNumberPerPerRackType');
              log(`  Rack ${rk.rackTypeId} en PN ${rk.partNumberId}: partsPerRack actualizado a ${rk.partsPerRack}`);
            } catch (e3) {
              errors.push(`Rack PN ${rk.partNumberId} update: ${String(e3).substring(0, 100)}`);
            }
          } else {
            errors.push(`Rack PN ${rk.partNumberId}: ${String(e2).substring(0, 100)}`);
          }
        }
      }

      // 1.4.16: fallback uno-por-uno también para errores no-duplicate-key. Antes
      // (≤1.4.15) si una batch fallaba por timeout/validación/red, los 50 racks
      // quedaban sin asignar sin diagnóstico — la audit detectó >1000 PNs con racks
      // missing sin log explícito. Ahora cada rack se reintenta solo y si falla,
      // queda registrado con su nombre+PN para reproducción.
      let rackBatchFailures = 0, rackIndividualFailures = 0;
      if (rackIn.length) {
        // 1.4.25 Fix FF: panel progress + subPhase para batches de racks.
        const rackTotalBatches = Math.ceil(rackIn.length / 50);
        setPanelProgress(0, rackIn.length);
        for (let i = 0; i < rackIn.length; i += 50) {
          const batch = rackIn.slice(i, i + 50);
          const batchNum = Math.floor(i / 50) + 1;
          setPanelSubPhase(`Racks batch ${batchNum}/${rackTotalBatches} (${batch.length} racks)`);
          setPanelProgress(Math.min(i + batch.length, rackIn.length), rackIn.length);
          try {
            await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: batch, partNumberRackTypeIdsToDelete: [] } });
          } catch (e) {
            rackBatchFailures++;
            const errMsg = String(e).substring(0, 200);
            if (isDuplicateKeyError(e)) {
              log(`  Racks batch ${batchNum}: duplicados, upsertando uno por uno...`);
            } else {
              log(`  Racks batch ${batchNum} FAIL (${batch.length} racks): ${errMsg}`);
              errors.push(`SavePartNumberRackTypes batch ${batchNum}: ${errMsg.substring(0, 120)}`);
            }
            // Fallback uno-por-uno para AMBOS casos (duplicate o cualquier otro error).
            for (const rk of batch) {
              try {
                await upsertRack(rk);
              } catch (e2) {
                rackIndividualFailures++;
                errors.push(`Rack PN ${rk.partNumberId} rackTypeId ${rk.rackTypeId}: ${String(e2).substring(0, 100)}`);
              }
            }
          }
        }
      }
      if (rackBatchFailures) {
        log(`  ⚠️ ${rackBatchFailures} batches fallaron (de ${Math.ceil(rackIn.length / 50)}), ${rackIndividualFailures} racks individuales sin asignar tras retry`);
      }
      stats.racksSet = rackIn.length + racksToDelete.size; log(`  Racks: ${rackIn.length} agregados, ${racksToDelete.size} PNs con racks eliminados`);

      // STEP 7b: Delete prices (guión in precio column)
      // 1.2.11: iteramos con índice para resolver entry por rowIdx; dedup por pnId
      // porque si 2 filas apuntan al mismo PN físico con guión, una sola pasada borra todos los precios.
      const pricesToDelete = [];
      const pricesToDeleteSeen = new Set();
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!isDash(String(part.precio))) continue;
        const entry = pnLookup.get(i); if (!entry) continue;
        if (pricesToDeleteSeen.has(entry.pn.id)) continue;
        pricesToDeleteSeen.add(entry.pn.id);
        pricesToDelete.push({ pnId: entry.pn.id, pnName: part.pn });
      }
      if (pricesToDelete.length) {
        setPanelSubPhase(`Borrando precios de ${pricesToDelete.length} PNs...`);
        for (const { pnId, pnName } of pricesToDelete) {
          try {
            const pnData = await api().query('GetPartNumber', { partNumberId: pnId });
            const existingPrices = pnData?.partNumberById?.partNumberPricesByPartNumberId?.nodes || [];
            for (const price of existingPrices) {
              await api().query('DeletePartNumberPrice', { id: price.id });
              log(`  Precio ${price.id} eliminado de PN "${pnName}"`);
            }
          } catch (e) { errors.push(`Borrar precios "${pnName}": ${String(e).substring(0, 100)}`); }
        }
        log(`  Precios eliminados de ${pricesToDelete.length} PNs`);
      }

      // 1.4.9: checkpoint intermedio. Si crashea STEP 8, el modal de resume
      // muestra "racks-done" — diagnóstico de qué quedó pendiente.
      if (resumeState) { resumeState.phase = 'racks-done'; await persistResumeState(); }

      // STEP 8: Default Price + Archive
      // 1.2.11: respeta archiveOverride (per-row) y archiveGlobal (toggle UI preview).
      // archiveGlobal=true  → archivarAnterior se aplica (default del CSV honrado)
      // archiveGlobal=false → ninguna fila archiva anterior (override blanket)
      // archiveOverride por fila TRUE  → fuerza archivar aunque global esté off
      // archiveOverride por fila FALSE → fuerza no archivar aunque CSV diga true
      // Dedup por pnId para no archivar/desarchivar 2 veces el mismo PN físico.
      setPanelPhase(`${isSoloPN ? 'Paso 5/5' : 'Paso 8/9'}: Archivado / Desarchivado...`); setProgressBar(85);
      const pnsToArchive = [], oldPnsToArchive = [], pnsToUnarchive = [];
      const archiveSeen = new Set(), unarchiveSeen = new Set(), oldArchiveSeen = new Set();
      const archiveGlobal = (state.archiveGlobal !== false); // default true si el toggle no fue tocado
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        const entry = pnLookup.get(i); if (!entry) continue;
        if (part.archivado) {
          if (!archiveSeen.has(entry.pn.id)) { pnsToArchive.push({ id: entry.pn.id, name: part.pn }); archiveSeen.add(entry.pn.id); }
        } else if (pnStatus[i].status === 'existing') {
          if (!unarchiveSeen.has(entry.pn.id)) { pnsToUnarchive.push({ id: entry.pn.id, name: part.pn }); unarchiveSeen.add(entry.pn.id); }
        }
        // archiveOverride per-row: undefined → seguir CSV; true → archivar; false → no archivar
        const csvWantsArchive = !!part.archivarAnterior;
        const rowOverride = part.archiveOverride; // boolean | undefined
        const willArchive = (rowOverride === true) || (rowOverride === undefined && csvWantsArchive && archiveGlobal);
        if (status.status === 'forceDup' && willArchive && status.existingId) {
          if (!oldArchiveSeen.has(status.existingId)) {
            oldPnsToArchive.push({ id: status.existingId, name: part.pn + ' (ant)' });
            oldArchiveSeen.add(status.existingId);
          }
        }
      }
      // Default price: set or unset
      const priceIdsForDefault = [];
      const priceIdsToUnsetDefault = [];
      if (!isSoloPN) {
        // In quote mode, use qpnp price IDs
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const entry = pnLookup.get(i); if (!entry) continue;
          const pnpId = entry.pnp?.id;
          if (!pnpId) continue;
          if (part.precioDefault) priceIdsForDefault.push(pnpId);
          else priceIdsToUnsetDefault.push(pnpId);
        }
      } else {
        // SOLO_PN: necesitamos releer los precios del PN porque el ID del nuevo precio
        // no lo tenemos (SaveManyPartNumberPrices no devuelve los IDs en este flujo).
        // Fix 1.4.4: pre-filtrar items que necesitan lectura y meterlos en runPool
        // (antes era for secuencial → 1500 GetPartNumber en serie ~10-20 min, UI atascada
        // mostrando "Archivado..." sin progreso).
        const priceReadTargets = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const entry = pnLookup.get(i);
          if (!entry?.pn?.id) continue;
          const needsRead = part.precioDefault || (!part.precioDefault && pnStatus[i].status === 'existing');
          if (!needsRead) continue;
          priceReadTargets.push({ pnId: entry.pn.id, pnName: part.pn, precioDefault: !!part.precioDefault });
        }
        if (priceReadTargets.length) {
          // 1.4.25 Fix FF: prefix Paso 8a/9 (sub-fase del STEP 8 archive).
          setPanelPhase(`${isSoloPN ? 'Paso 5a/5' : 'Paso 8a/9'}: Releyendo precios para fijar default (${priceReadTargets.length})`);
          setPanelProgress(0, priceReadTargets.length);
          setProgressBar(86);
          const priceReadConcurrency = bulkCfg().concurrency.savePartNumber || 5;
          await runPool(
            priceReadTargets,
            async (target, _idx, myRunIdLocal) => {
              bailIfStale(myRunIdLocal);
              setPanelSubPhase(`Releyendo precio: ${target.pnName}`);
              try {
                const pnData = await withRetry(
                  () => api().query('GetPartNumber', { partNumberId: target.pnId }),
                  `GetPartNumber default-price "${target.pnName}"`,
                  myRunIdLocal
                );
                const prices = pnData?.partNumberById?.partNumberPricesByPartNumberId?.nodes || [];
                if (!prices.length) return;
                if (target.precioDefault) {
                  const sorted = [...prices].sort((a, b) => Number(b.id) - Number(a.id));
                  const newest = sorted[0];
                  if (newest) priceIdsForDefault.push(newest.id);
                  const oldDefault = prices.find(p => p.isDefault && p.id !== newest.id);
                  if (oldDefault) priceIdsToUnsetDefault.push(oldDefault.id);
                } else {
                  const defaultPrice = prices.find(p => p.isDefault);
                  if (defaultPrice) priceIdsToUnsetDefault.push(defaultPrice.id);
                }
              } catch (e) {
                if (isBail(e)) throw e;
                // silencioso — el default no se aplicará pero no rompemos el flujo
              }
            },
            priceReadConcurrency,
            (done, total) => {
              setPanelProgress(done, total);
              setProgressBar(86 + Math.round((done / Math.max(total, 1)) * 2));
            },
            myRunId
          );
          bailIfStale(myRunId);
        }
      }
      if (priceIdsForDefault.length) {
        try { await api().query('SetPartNumberPricesAsDefaultPrice', { partNumberPriceIds: priceIdsForDefault }, 'SetPNPricesDefault'); stats.defaultPriceSet = priceIdsForDefault.length; }
        catch (e) { errors.push(`SetDefaultPrice: ${String(e).substring(0, 120)}`); }
      }
      for (const priceId of priceIdsToUnsetDefault) {
        try { await api().query('UnsetPartNumberPriceAsDefaultPrice', { id: priceId }); stats.defaultPriceUnset = (stats.defaultPriceUnset || 0) + 1; }
        catch (e) { /* silencioso — puede que no fuera default */ }
      }
      if (priceIdsToUnsetDefault.length) log(`  Default price unset: ${stats.defaultPriceUnset || 0}`);
      // ── Fix 6: archivado en pool concurrente (5 workers + withRetry) ──
      // Combinamos las 3 listas en un solo run para que el pool aproveche la
      // capacidad cuando hay pocos items de un tipo y muchos de otro.
      const archiveOps = [
        ...pnsToArchive.map(p => ({ id: p.id, name: p.name, kind: 'archive' })),
        ...oldPnsToArchive.map(p => ({ id: p.id, name: p.name, kind: 'oldArchive' })),
        ...pnsToUnarchive.map(p => ({ id: p.id, name: p.name, kind: 'unarchive' })),
      ];
      if (archiveOps.length) {
        const archiveConcurrency = bulkCfg().concurrency.archive;
        // 1.4.13: desglose claro en phase line para evitar la confusión de "¿por qué archiva en ronda de activos?".
        // En rondas de activos el grueso suele ser desarchivar (PNs marcados archivados en Steelhead pero
        // que el CSV los lista como activos → STEP 8 los desarchiva para que los updates apliquen a vivos).
        // 1.4.25 Fix FF: prefix Paso 8/9 (antes sobrescribía sin numerar).
        const archivePhaseLbl = `${isSoloPN ? 'Paso 5/5' : 'Paso 8/9'}: Archivando ${pnsToArchive.length + oldPnsToArchive.length} / Desarchivando ${pnsToUnarchive.length} (pool ${archiveConcurrency})`;
        setPanelPhase(archivePhaseLbl);
        setPanelProgress(0, archiveOps.length);
        log(`  Archivado: ${pnsToArchive.length} nuevos archivar, ${oldPnsToArchive.length} viejos archivar, ${pnsToUnarchive.length} desarchivar (concurrencia ${archiveConcurrency})`);

        async function archiveWorker(op, _idx, runId) {
          bailIfStale(runId);
          const verb = op.kind === 'unarchive' ? 'Desarchivando' : (op.kind === 'oldArchive' ? 'Arch.viejo' : 'Archivando');
          setPanelSubPhase(`${verb}: ${op.name}`);
          try {
            if (op.kind === 'unarchive') {
              await withRetry(
                () => api().query('UpdatePartNumber', { id: op.id, archivedAt: null }),
                `UpdatePartNumber unarchive "${op.name}"`, runId
              );
              stats.unarchived = (stats.unarchived || 0) + 1;
            } else {
              await withRetry(
                () => api().query('UpdatePartNumber', { id: op.id, archivedAt: new Date().toISOString() }),
                `UpdatePartNumber ${op.kind} "${op.name}"`, runId
              );
              if (op.kind === 'archive') stats.archived++;
              else stats.oldArchived++;
            }
            state.counters.ok++;
          } catch (e) {
            if (isBail(e)) throw e;
            // unarchive: silencioso (puede que no estuviera archivado)
            if (op.kind !== 'unarchive') {
              const label = op.kind === 'oldArchive' ? 'ArchAnt' : 'Archivar';
              errors.push(`${label} "${op.name}": ${String(e).substring(0, 100)}`);
              state.counters.errors++;
            }
          }
        }

        await runPool(
          archiveOps,
          archiveWorker,
          archiveConcurrency,
          (done, total) => { setPanelProgress(done, total); setPanelCounters(); setProgressBar(90 + Math.round((done / Math.max(total, 1)) * 8)); },
          myRunId
        );
        bailIfStale(myRunId);
      }
      if (pnsToUnarchive.length) log(`  Desarchivados: ${stats.unarchived || 0}`);

      // STEP 9: Done
      setPanelPhase('Completado.'); setProgressBar(100);
      const domainId = window.location.pathname.match(/\/Domains\/(\d+)/)?.[1] || DOMAIN.id;
      // V10: si se creó UNA sola cotización abrir esa; si fueron varias, abrir el listado general
      let quoteUrl = null;
      let quoteUrlLabel = 'ABRIR COTIZACIÓN';
      if (!isSoloPN && quotesCreated.length === 1) {
        quoteUrl = `/Domains/${domainId}/Quotes/${primaryQuoteIdInDomain}`;
      } else if (!isSoloPN && quotesCreated.length > 1) {
        quoteUrl = `/Domains/${domainId}/Quotes`;
        quoteUrlLabel = 'VER LISTA DE COTIZACIONES';
      }
      log(`\n=== RESULTADO ===`);
      log(`${isSoloPN ? 'Modo: SOLO_PN' : `Cotizaciones: ${quotesCreated.length} (${quotesCreated.map(q => '#' + q.idInDomain).join(', ')})`}`);
      log(`PNs: ${stats.pnsCreated} nuevos, ${stats.pnsExisting} existentes, ${stats.pnsDuplicated} dup`);
      if (errors.length) log(`ERRORES: ${errors.length}\n${errors.join('\n')}`);
      await new Promise(r => setTimeout(r, 500));

      // Save load log to localStorage for history
      try {
        const loadLog = {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          version: 'v10',
          mode: isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP',
          quoteName: stats.quoteName,
          quoteIdInDomain: stats.quoteIdInDomain,
          customerName: [...customerCache.values()].map(c => c.name).join(', '),
          // V10: header completo para reconstruir CSV
          header: {
            modo: isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP',
            empresaEmisora: header.empresaEmisora || '',
            quoteName: header.quoteName || '',
            asignado: header.asignado || '',
            validaDias: header.validaDias || '',
            notasExternas: header.notasExternas || '',
            notasInternas: header.notasInternas || ''
          },
          stats: { ...stats },
          errors: [...errors],
          // Fix 1.4.4: api().getLog() puede ser 1-2MB por corrida grande y reventaba
          // la cuota de localStorage. El log completo ya va en el XLSX de reporte.
          partsCount: parts.length,
          // V10: snapshot completo (todas las cols A-BQ) para round-trip
          parts: parts.map(p => ({
            // Identificación
            pn: p.pn, cliente: p.cliente, descripcion: p.descripcion,
            pnAlterno: p.pnAlterno, pnGroup: p.pnGroup,
            // Precio
            qty: p.qty, precio: p.precio, unidadPrecio: p.unidadPrecio,
            divisa: p.divisa, precioDefault: p.precioDefault,
            // Acabados
            metalBase: p.metalBase, labels: p.labels,
            // Proceso + productos
            procesoOverride: p.procesoOverride,
            products: p.products,
            // Specs (con param para espesor)
            specs: p.specs.map(s => ({ name: s.name, param: s.param })),
            // Conversiones
            unitConv: p.unitConv,
            // Racks (con ppr)
            racks: p.racks.map(r => ({ name: r.name, ppr: r.ppr })),
            // Dimensiones
            dims: p.dims,
            // Asignación contable
            linea: p.linea, departamento: p.departamento, codigoSAT: p.codigoSAT,
            // Predictivos
            predictiveUsage: p.predictiveUsage,
            // IBMS / referencias
            quoteIBMS: p.quoteIBMS, estacionIBMS: p.estacionIBMS, plano: p.plano,
            piezasCarga: p.piezasCarga, cargasHora: p.cargasHora, tiempoEntrega: p.tiempoEntrega,
            notasAdicionalesPN: p.notasAdicionalesPN,
            // Parámetros
            archivado: p.archivado, validacion1er: p.validacion1er,
            forzarDuplicado: p.forzarDuplicado, archivarAnterior: p.archivarAnterior
          }))
        };
        const history = JSON.parse(localStorage.getItem('sa_load_history') || '[]');
        history.unshift(loadLog);
        // Fix 1.4.4: cap reducido 50→20 + auto-prune ante QuotaExceededError.
        // Una corrida de 1500 PNs serializa ~1MB en parts[]; con cap=50 podía intentar
        // guardar 50MB y reventar el cuota de localStorage (~5MB en Chrome).
        if (history.length > 20) history.length = 20;
        try {
          localStorage.setItem('sa_load_history', JSON.stringify(history));
        } catch (quotaErr) {
          let attempts = 0;
          while (history.length > 1 && attempts < 6) {
            attempts++;
            history.length = Math.floor(history.length / 2) || 1;
            try {
              localStorage.setItem('sa_load_history', JSON.stringify(history));
              warn(`sa_load_history: cuota excedida, recortado a ${history.length} entradas`);
              break;
            } catch (_) { /* sigue recortando */ }
          }
        }
        log('  Log guardado en historial');
      } catch (e) { warn('Error guardando log: ' + e.message); }

      // Fix 7: marcar la corrida como completa para que el próximo run con el
      // mismo CSV no pregunte si reanudar. El TTL de purge la borrará después.
      if (resumeState) {
        resumeState.phase = 'done';
        await persistResumeState();
      }
      try { markPanelDone(errors.length === 0); } catch (_) {}

      try {
        generateRunReport(state, pnStatus, parts, stats, errors);
      } catch (e) {
        warn(`Reporte XLSX falló: ${e.message}`);
      }

      showResult(stats, quoteUrl, errors, quoteUrlLabel);
      return { success: true, stats, errors };

    } catch (e) {
      if (isBail(e)) {
        console.warn('[SA] cancelado por usuario.');
        try { markPanelDone(false, 'Cancelado'); } catch (_) {}
        return { success: false, cancelled: true };
      }
      console.error('[SA] FATAL:', e);
      // Persistir el progreso parcial para que el próximo run pueda retomar
      if (resumeState) {
        resumeState.phase = resumeState.phase || 'error';
        await persistResumeState().catch(() => {});
      }
      try { markPanelDone(false, e.message); } catch (_) {}
      showResult(stats, null, [`FATAL: ${e.message}`]);
      return { success: false, error: e.message };
    }
  }

  // ─── Helpers de clasificación (puros, exportados a window.BulkUploadHelpers) ───

  // 1.4.3: normalización trim+upper para comparar labels/metales sin que un espacio
  // accidental o variante de case (ej. "SRG " vs "SRG", "Estaño" vs "estaño") rompa
  // matches.
  function normLabel(s) {
    if (s == null) return '';
    return String(s).trim().toUpperCase();
  }

  function isNonFinishLabel(name, nonFinishList) {
    if (!name || typeof name !== 'string') return false;
    const n = normLabel(name);
    if (!n) return false;
    return nonFinishList.some(nf => normLabel(nf) === n);
  }

  // 1.4.3: equivalencias semánticas configurables. Cada grupo es una lista de
  // sinónimos para match — si dos valores caen en el mismo grupo se consideran
  // equivalentes (no exactos). Se construye un mapa name→groupId una sola vez.
  function buildEquivIndex(groups) {
    const map = new Map();
    if (!Array.isArray(groups)) return map;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (!Array.isArray(g)) continue;
      for (const item of g) {
        const k = normLabel(item);
        if (k) map.set(k, gi);
      }
    }
    return map;
  }
  function equivGroup(map, value) {
    return map.get(normLabel(value));
  }
  function equivalentValues(map, a, b) {
    const na = normLabel(a), nb = normLabel(b);
    if (na === nb) return true;
    const ga = map.get(na), gb = map.get(nb);
    return ga != null && gb != null && ga === gb;
  }

  function acabadosOrdenados(labels, nonFinishList) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    const acabados = [];
    for (const l of labels) {
      if (!l || typeof l !== 'string') continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      const key = normLabel(l);
      if (seen.has(key)) continue;
      seen.add(key);
      acabados.push(key);
    }
    return acabados.sort().join('|');
  }

  // 1.4.3: misma función que acabadosOrdenados pero colapsa equivalentes a un
  // mismo token canonical "__G<id>" antes de ordenar. Permite que "Estaño" y
  // "Estaño s/Aluminio" cuenten como el mismo acabado para fines de match.
  // Si no hay equivIndex (config sin metalEquivalents) se comporta igual que
  // acabadosOrdenados.
  function acabadosCanonicos(labels, nonFinishList, equivIndex) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    const tokens = [];
    for (const l of labels) {
      if (!l || typeof l !== 'string') continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      const norm = normLabel(l);
      let token = norm;
      if (equivIndex && equivIndex.size) {
        const g = equivIndex.get(norm);
        if (g != null) token = `__G${g}`;
      }
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
    return tokens.sort().join('|');
  }

  // 1.4.3: representación canonical de un metal — si está en un grupo
  // equivalente devuelve "__M<groupId>", si no devuelve el metal normalizado.
  function metalCanonico(metal, equivIndex) {
    const m = normLabel(metal);
    if (!m) return '';
    if (equivIndex && equivIndex.size) {
      const g = equivIndex.get(m);
      if (g != null) return `__M${g}`;
    }
    return m;
  }

  function buildCompositeKey(pn, nonFinishList, equivIndex) {
    const customerId = pn.customerId != null ? String(pn.customerId) : '';
    const name = (pn.name || '').toUpperCase();
    // 1.4.3: metal y acabados ahora se canonicalizan para que el composite
    // matchee aunque el CSV traiga "Estaño" y el PN tenga "Estaño s/Aluminio".
    // Sin equivIndex se comporta como antes (exacto).
    const metalBase = metalCanonico(pn.metalBase || '', equivIndex);
    const acabados = acabadosCanonicos(pn.labels || [], nonFinishList, equivIndex);
    return `${customerId}||${name}||${metalBase}||${acabados}`;
  }

  function rankCandidates(csvRow, candidates, nonFinishList, equivIndex) {
    const csvMetalCanon = metalCanonico(csvRow.metalBase || '', equivIndex);
    const csvAcabadosCanon = acabadosCanonicos(csvRow.labels || [], nonFinishList, equivIndex);
    const csvIbms = csvRow.quoteIBMS || '';

    function score(c) {
      let s = 0;
      if (metalCanonico(c.metalBase || '', equivIndex) === csvMetalCanon) s++;
      if (acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === csvAcabadosCanon) s++;
      return s;
    }

    function ibmsRank(c) {
      const ibms = c.quoteIBMS || '';
      if (csvIbms && ibms === csvIbms) return 0; // mismo IBMS gana
      if (!ibms) return 1;                       // IBMS vacío segundo
      return 2;                                  // IBMS distinto último
    }

    return [...candidates].sort((a, b) => {
      const sd = score(b) - score(a);
      if (sd !== 0) return sd;
      const id = ibmsRank(a) - ibmsRank(b);
      if (id !== 0) return id;
      return (a.id || 0) - (b.id || 0);
    });
  }

  function classifyOnePN(csvRow, pnsForCustomer, nonFinishList, equivIndex) {
    const allPns = pnsForCustomer || [];
    // 1.2.12: Pases 1 y 2 ven archivados también (auto-desarchiva en STEP 8 vía
    // pnsToUnarchive cuando status='existing'). Pase 3 sigue limitado a activos
    // para no ensuciar el dropdown de candidatos near-match con históricos.
    const activePns = allPns.filter(p => !p.archivedAt);
    const csvIbms = csvRow.quoteIBMS || '';
    const csvCompositeKey = buildCompositeKey(csvRow, nonFinishList, equivIndex);

    // ── Pase 1: QuoteIBMS autoritativo (1.2.12: incluye archivados) ──
    if (csvIbms) {
      const byIbms = allPns.find(p => (p.quoteIBMS || '') === csvIbms);
      if (byIbms) {
        const archSuffix = byIbms.archivedAt ? '-desarchiva' : '';
        return {
          classification: 'MODIFY',
          pase: 1,
          confidence: `ibms-exacto${archSuffix}`,
          targetPnId: byIbms.id,
          wasArchived: !!byIbms.archivedAt,
          candidates: [],
        };
      }
    }

    // ── Pase 2: composite exacto con regla anti-colisión (1.2.12: incluye archivados) ──
    // Los PNs del catálogo pueden no traer customerId en su shape (ya están filtrados por cliente).
    // Normalizamos usando el customerId del csvRow para que la comparación de keys sea apples-to-apples.
    const csvCustomerId = csvRow.customerId;
    const byComposite = allPns.find(p => {
      const pNorm = (p.customerId != null) ? p : Object.assign({}, p, { customerId: csvCustomerId });
      return buildCompositeKey(pNorm, nonFinishList, equivIndex) === csvCompositeKey;
    });
    if (byComposite) {
      const pnIbms = byComposite.quoteIBMS || '';
      const colision = csvIbms && pnIbms && pnIbms !== csvIbms;
      if (!colision) {
        let confSuffix;
        if (!pnIbms && !csvIbms) confSuffix = 'ambos-sin-ibms';
        else if (!pnIbms) confSuffix = 'pn-sin-ibms';
        else if (!csvIbms) confSuffix = 'csv-sin-ibms';
        else confSuffix = 'ibms-coincide';
        const archSuffix = byComposite.archivedAt ? '-desarchiva' : '';
        return {
          classification: 'MODIFY',
          pase: 2,
          confidence: `composite-exacto-${confSuffix}${archSuffix}`,
          targetPnId: byComposite.id,
          wasArchived: !!byComposite.archivedAt,
          candidates: [],
        };
      }
      // colision → cae a Pase 3 (el PN aparecerá como candidato)
    }

    // ── Pase 3: near-match por nombre ──
    // 1.2.9: tres niveles de default según evidencia de match:
    //   1) Top match estricto (nombre + acabados exactos sin contar nonFinish)
    //      → MODIFY ranked[0]. Confianza alta, operador puede confirmar de un vistazo.
    //   2) Sin match estricto pero existe candidato sin-etiqueta (slate limpia)
    //      → MODIFY ese candidato. Es más seguro completar un PN vacío que crear
    //      un duplicado con etiquetas; el PN sin-etiq típicamente nació por accidente
    //      (creado sin clasificar) y este es el momento natural para corregirlo.
    //   3) Sin match estricto y sin candidato sin-etiq → NEW. El operador decide
    //      a mano si quiere pisar alguno de los candidatos con etiquetas distintas.
    // En los 3 casos el dropdown del panel muestra TODOS los candidatos por nombre
    // (1.2.8) para que el operador pueda override.
    const nameUpper = (csvRow.name || '').toUpperCase();
    const nameCandidates = activePns.filter(p => (p.name || '').toUpperCase() === nameUpper);
    if (nameCandidates.length > 0) {
      const ranked = rankCandidates(csvRow, nameCandidates, nonFinishList, equivIndex);
      // 1.4.3: comparación canonical para que "Estaño" vs "Estaño s/Cobre" o
      // mismo acabado con casing/espacios distintos cuenten como labelsMatchFull.
      const csvAcabados = acabadosCanonicos(csvRow.labels || [], nonFinishList, equivIndex);
      const topAcabados = acabadosCanonicos(ranked[0].labels || [], nonFinishList, equivIndex);
      const labelsMatchFull = csvAcabados === topAcabados;
      if (labelsMatchFull) {
        return {
          classification: 'MODIFY',
          pase: 3,
          confidence: 'name+labels-match',
          targetPnId: ranked[0].id,
          wasArchived: false,
          candidates: ranked,
        };
      }
      // 1.2.9: fallback a candidato sin-etiqueta si existe.
      const blankCandidate = ranked.find(c => acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === '');
      if (blankCandidate) {
        return {
          classification: 'MODIFY',
          pase: 3,
          confidence: 'name+blank-candidate',
          targetPnId: blankCandidate.id,
          wasArchived: false,
          candidates: ranked,
        };
      }
      return {
        classification: 'NEW',
        pase: 3,
        confidence: 'name-only-labels-differ',
        targetPnId: null,
        wasArchived: false,
        candidates: ranked,
      };
    }

    // ── Sin candidatos en ningún pase ──
    return {
      classification: 'NEW',
      pase: null,
      confidence: 'sin-match',
      targetPnId: null,
      wasArchived: false,
      candidates: [],
    };
  }

  // 1.2.10/1.2.11: dedup MODIFY targets para evitar que dos filas del CSV apunten
  // al mismo PN existente. La regla del usuario: si el CSV trae dos veces el mismo
  // nombre y el catálogo tiene dos PNs distintos con ese nombre, AMBAS filas
  // pueden ser MODIFY pero a IDs distintos; lo que NO se permite es que ambas
  // pisen el mismo id (perdería datos en silencio y el log mentiría diciendo
  // que las dos cargaron).
  //
  // Precedencia (gana el target primero): Pase 1 > Pase 2 > Pase 3 strict
  // > Pase 3 blank > Pase 3 id asc. Empate → idx ascendente (orden de CSV).
  //
  // 1.2.11: el loser solo se re-asigna a un alternate que pase strict-match
  // (mismas acabados ignorando nonFinishList) o blank candidate (sin acabados).
  // Antes (1.2.10) se aceptaba el primer alternate disponible aunque las
  // etiquetas fueran distintas, lo que violaba la regla "si no hay match de
  // etiquetas, default a crear nuevo". Mismo 3-level fallback que classifyOnePN.
  //
  // Mutaciones (en place) por loser:
  //   - Alternate strict (acabados iguales) → re-asigna. confidence='name+labels-match',
  //     pase=3, dedupReassigned=true, dedupOriginalTargetPnId guarda el id original.
  //   - Alternate blank (sin acabados) → re-asigna. confidence='name+blank-candidate'.
  //   - Sin alternate aceptable → demota a NEW. dedupConflict=true,
  //     dedupConflictTargetPnId guarda el id originalmente propuesto.
  function dedupModifyTargets(pnStatus, nonFinishList, equivIndex) {
    const nfList = nonFinishList || [];
    const eIdx = equivIndex || null;
    const confRank = {
      'ibms-exacto': 0,
      'composite-exacto-ambos-sin-ibms': 1,
      'composite-exacto-ibms-coincide': 1,
      'composite-exacto-pn-sin-ibms': 1,
      'composite-exacto-csv-sin-ibms': 1,
      'name+labels-match': 2,
      'name+blank-candidate': 3,
    };
    const claimers = [];
    for (let i = 0; i < pnStatus.length; i++) {
      const s = pnStatus[i];
      if ((s.status === 'existing' || s.status === 'forceDup') && s.existingId != null) {
        claimers.push({ idx: i, s });
      }
    }
    if (claimers.length === 0) return { reassigned: 0, demoted: 0 };

    // 1.2.12: el confidence puede traer suffix '-desarchiva' (Pase 1/2 con PN
    // archivado); el rank es el mismo que su variante activa.
    const stripArch = (c) => (c || '').replace(/-desarchiva$/, '');
    claimers.sort((a, b) => {
      const pa = a.s.pase == null ? 99 : a.s.pase;
      const pb = b.s.pase == null ? 99 : b.s.pase;
      if (pa !== pb) return pa - pb;
      const ra = confRank[stripArch(a.s.confidence)] == null ? 99 : confRank[stripArch(a.s.confidence)];
      const rb = confRank[stripArch(b.s.confidence)] == null ? 99 : confRank[stripArch(b.s.confidence)];
      if (ra !== rb) return ra - rb;
      return a.idx - b.idx;
    });

    const used = new Set();
    let reassigned = 0, demoted = 0;
    for (const { s } of claimers) {
      if (!used.has(s.existingId)) {
        used.add(s.existingId);
        continue;
      }
      // Target tomado por una fila de precedencia mayor. Buscar alterno strict
      // o blank entre s.candidates (poblado solo en Pase 3; Pase 1/2 traen [] → demote).
      const candidates = s.candidates || [];
      const csvAcabados = acabadosCanonicos(s.csvLabels || [], nfList, eIdx);
      let alternative = null;
      let altConfidence = null;
      // Nivel 1: alternate con acabados estrictamente iguales al CSV.
      for (const c of candidates) {
        if (c.id === s.existingId || used.has(c.id)) continue;
        const candAcabados = acabadosCanonicos(c.labels || [], nfList, eIdx);
        if (candAcabados === csvAcabados) {
          alternative = c;
          altConfidence = 'name+labels-match';
          break;
        }
      }
      // Nivel 2: alternate sin acabados (slate limpia).
      if (!alternative) {
        for (const c of candidates) {
          if (c.id === s.existingId || used.has(c.id)) continue;
          const candAcabados = acabadosCanonicos(c.labels || [], nfList, eIdx);
          if (candAcabados === '') {
            alternative = c;
            altConfidence = 'name+blank-candidate';
            break;
          }
        }
      }
      if (alternative) {
        s.dedupOriginalTargetPnId = s.existingId;
        s.dedupReassigned = true;
        s.existingId = alternative.id;
        s.targetPnId = alternative.id;
        s.existingProcessId = alternative.defaultProcessNodeId || null;
        s.confidence = altConfidence;
        s.pase = 3;
        used.add(alternative.id);
        reassigned++;
      } else {
        s.dedupConflict = true;
        s.dedupConflictTargetPnId = s.existingId;
        s.status = 'new';
        s.classification = 'NEW';
        s.existingId = null;
        s.targetPnId = null;
        s.existingProcessId = null;
        demoted++;
      }
    }
    return { reassigned, demoted };
  }

  // 1.2.11: detectar duplicados internos del CSV (mismo PN+customer en 2+ filas).
  // Marca TODAS las filas del grupo (incluyendo la 1ª) con flags para UI y para
  // que SavePartNumber decida la asignación a Capa A/B. No fuerza status — el
  // clasificador (Pase 1 IBMS / Pase 2 composite / Pase 3 near-match) decide
  // independientemente; dedupModifyTargets ya maneja conflictos por existingId.
  function detectCsvDuplicates(parts) {
    const groups = new Map(); // key → [idx]
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.pn || p.customerId == null) continue;
      const key = `${String(p.pn).toUpperCase()}|${p.customerId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    let dupGroups = 0;
    let dupRows = 0;
    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      dupGroups++;
      for (let n = 0; n < indices.length; n++) {
        const idx = indices[n];
        parts[idx].isCsvDuplicate = true;
        parts[idx].csvDuplicateIndex = n + 1;
        parts[idx].csvDuplicateGroupSize = indices.length;
        if (n > 0) dupRows++;
      }
    }
    return { dupGroups, dupRows };
  }

  // 1.3.0: chunking helpers — partir corridas grandes COTIZACIÓN+NP en cotizaciones
  // de hasta `chunkSize` líneas. Contiguous slicing, no agrupa duplicados a través
  // de fronteras (los duplicados internos del CSV se distribuyen libremente).
  function chunkParts(arr, chunkSize) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const size = Math.max(1, Math.floor(Number(chunkSize) || 1));
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  // 1.3.0: nombre derivado para chunks. 1 chunk → nombre original (sin sufijo).
  // >1 chunks → "<name> 01", "<name> 02", ..., padStart(2,'0') deja 3+ dígitos si pasamos 99.
  function makeChunkQuoteName(originalName, chunkIndex, totalChunks) {
    if (totalChunks <= 1) return originalName;
    return `${originalName} ${String(chunkIndex + 1).padStart(2, '0')}`;
  }

  const __helpers = { isNonFinishLabel, normLabel, buildEquivIndex, equivGroup, equivalentValues, metalCanonico, acabadosOrdenados, acabadosCanonicos, buildCompositeKey, rankCandidates, classifyOnePN, extractPNShape, dedupModifyTargets, detectCsvDuplicates, chunkParts, makeChunkQuoteName };

  // 1.2.12: getter para que window.BulkUpload.__state apunte siempre al state actual
  // (state se reasigna en nextRunId() así que un snapshot quedaría stale).
  return { execute, setProgressCallback, parseCSV, parseRows, __helpers, get __state() { return state; } };
})();

if (typeof window !== 'undefined') {
  window.BulkUpload = BulkUpload;
  window.BulkUploadHelpers = BulkUpload.__helpers || {};
}
