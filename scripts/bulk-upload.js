// Steelhead Bulk Upload — Pipeline hardened para cargas masivas (18k+ filas)
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

  const VERSION = '1.2.8';
  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let onProgress = () => {};
  function setProgressCallback(fn) { onProgress = fn; }

  // ═══════════════════════════════════════════
  // CONFIG ACCESS (con defaults sanos si config no provee)
  // ═══════════════════════════════════════════

  const bulkCfg = () => {
    const cfg = (api()?.getConfig?.() || window.__sa_config || {});
    const d = cfg?.steelhead?.domain?.bulkUpload || {};
    return {
      concurrency: {
        savePartNumber: d.concurrency?.savePartNumber ?? 5,
        archive: d.concurrency?.archive ?? 5,
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
    };
    return state.runId;
  }
  function isStale(myRunId) { return !state || state.cancelled || state.runId !== myRunId; }
  function bailIfStale(myRunId) { if (isStale(myRunId)) throw new BailError(); }
  function cancelRun() {
    if (!state || state.cancelled) return;
    state.cancelled = true;
    state.phase = 'cancelled';
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
      #sa-bu-panel{position:fixed;top:20px;right:20px;width:480px;max-height:80vh;background:#1e293b;color:#e2e8f0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;z-index:99998;display:flex;flex-direction:column;overflow:hidden}
      #sa-bu-panel .sa-hdr{padding:14px 18px;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center}
      #sa-bu-panel .sa-hdr h3{margin:0;font-size:14px;color:#38bdf8;font-weight:600}
      #sa-bu-panel .sa-hdr .sa-ver{font-size:11px;color:#64748b}
      #sa-bu-panel .sa-body{padding:14px 18px;overflow-y:auto;flex:1;font-size:13px}
      #sa-bu-panel .sa-phase{font-size:13px;color:#e2e8f0;font-weight:500;margin-bottom:6px}
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
        <span class="sa-ver">v${VERSION}</span>
      </div>
      <div class="sa-body">
        <div class="sa-phase" id="sa-bu-phase">Inicializando...</div>
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

  function showPanel() { ensurePanel().style.display = 'flex'; }
  function hidePanel() {
    const p = document.getElementById('sa-bu-panel');
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  function setPanelPhase(text) {
    state.phase = text;
    const el = document.getElementById('sa-bu-phase'); if (el) el.textContent = text;
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
    const el = document.getElementById('sa-bu-log');
    if (!el) return;
    const ts = new Date().toTimeString().slice(0, 8);
    el.textContent += `[${ts}] ${msg}\n`;
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
      for (const mat of PREDICTIVE_MATERIALS) {
        const val = gn(row, mat.col);
        if (val !== null && val > 0) predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: String(val), name: mat.name });
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

    setPanelPhase(`Prefetch global de PNs (subset: ${customerSet.size} clientes)`);
    let offset = 0;
    let scanned = 0;
    let kept = 0;
    while (offset < maxResults) {
      if (myRunId != null) bailIfStale(myRunId);
      const d = await withRetry(
        () => api().query('AllPartNumbers', {
          orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: ''
        }),
        `AllPartNumbers prefetch offset=${offset}`,
        myRunId
      );
      const nodes = d?.pagedData?.nodes || [];
      scanned += nodes.length;
      for (const n of nodes) {
        const cid = n.customerByCustomerId?.id || n.customerId;
        if (cid != null && customerSet.has(cid)) {
          result.get(cid).push(extractPNShape(n));
          kept++;
        }
      }
      const totalCount = d?.pagedData?.totalCount || 0;
      setPanelProgress(scanned, Math.min(totalCount || maxResults, maxResults));
      if (nodes.length < pageSize) break; // última página
      offset += pageSize;
    }
    log(`Prefetch: ${scanned} PNs escaneados, ${kept} relevantes para ${customerSet.size} clientes`);
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
    const labels = (n.partNumberLabelsByPartNumberId?.nodes || [])
      .map(x => x?.labelByLabelId?.name)
      .filter(Boolean);
    return {
      id: n.id,
      name: n.name,
      customerId: n.customerByCustomerId?.id || n.customerId,
      metalBase,
      quoteIBMS,
      labels,
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
    const customerIds = [...new Set(parts.map(p => p.customerId).filter(x => x != null))];
    const pnsByCustomer = await prefetchPNsByCustomer(customerIds, myRunId);

    setPanelPhase(`Clasificación: evaluando ${parts.length} filas`);
    const out = parts.map(p => buildClassifiedRow(p, pnsByCustomer.get(p.customerId) || [], nonFinishList));
    logClassificationSummary(out);
    return out;
  }

  // Modo día: una pasada paginada de AllPartNumbers con searchQuery=name por
  // PN del CSV; filtro client-side por customerId; mapeo a shape con
  // extractPNShape; llamada a classifyOnePN.
  async function classifyPNsOnDemand(parts, myRunId) {
    const cfg = bulkCfg();
    const nonFinishList = cfg.nonFinishLabelNames || [];
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
    setPanelPhase(`Verificando PNs existentes (${uniq.size} búsquedas)`);
    setPanelProgress(0, uniq.size);

    let progress = 0;
    for (const [key, { name, customerId }] of uniq) {
      if (myRunId != null) bailIfStale(myRunId);
      const pnsForKey = [];
      const otherHits = [];
      try {
        let offset = 0;
        while (offset < maxResults) {
          if (myRunId != null) bailIfStale(myRunId);
          const d = await withRetry(
            () => api().query('AllPartNumbers', {
              orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: name
            }),
            `AllPartNumbers "${name}" offset=${offset}`,
            myRunId
          );
          const nodes = d?.pagedData?.nodes || [];
          for (const n of nodes) {
            const cid = n.customerByCustomerId?.id || n.customerId;
            if (cid === customerId) pnsForKey.push(extractPNShape(n));
            else if ((n.name || '').toUpperCase() === name.toUpperCase()) {
              otherHits.push({
                id: n.id, name: n.name,
                otherCustomerId: cid || null,
                otherCustomerName: n.customerByCustomerId?.name || null,
                archivedAt: n.archivedAt || null,
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
      return buildClassifiedRow(p, pnsForCustomer, nonFinishList);
    });
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
  function buildClassifiedRow(p, pnsForCustomer, nonFinishList) {
    const csvRow = {
      customerId: p.customerId,
      name: p.pn,
      metalBase: p.metalBase || '',
      labels: p.labels || [],
      quoteIBMS: p.quoteIBMS || '',
    };
    const cls = classifyOnePN(csvRow, pnsForCustomer, nonFinishList);

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
      targetPnId: cls.targetPnId,
      csvRowKey: `${p.pn.toUpperCase()}|${p.customerId}`,
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

  function injectStyles() {
    if (document.getElementById('dl9-styles')) return;
    const s = document.createElement('style'); s.id = 'dl9-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:min(1400px,96vw);width:96%;max-height:88vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-modal h3{font-size:14px;margin:16px 0 6px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}.dl9-modal .dl9-sub{color:#64748b;font-size:13px;margin-bottom:16px}.dl9-modal table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}.dl9-modal th{text-align:left;padding:4px 8px;color:#94a3b8;border-bottom:1px solid #334155;font-weight:500}.dl9-modal td{padding:4px 8px;border-bottom:1px solid #1e293b}.dl9-new{color:#4ade80}.dl9-exist{color:#facc15}.dl9-dup{color:#f97316}.dl9-err{color:#f87171}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.2s}.dl9-btn:hover{opacity:0.85}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#2563eb;color:white}.dl9-btn-close{background:#475569;color:#e2e8f0}.dl9-btn-copy{background:#0d9488;color:white}.dl9-progress{font-size:13px;color:#94a3b8;margin-top:8px;white-space:pre-wrap;line-height:1.6}.dl9-bar{height:4px;background:#334155;border-radius:2px;margin:8px 0;overflow:hidden}.dl9-bar-fill{height:100%;background:#2563eb;transition:width 0.3s;width:0%}.dl9-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}.dl9-stat{background:#0f172a;padding:8px 12px;border-radius:6px;font-size:13px}.dl9-stat b{color:#38bdf8}.dl9-pending-chip{background:#7c2d12;color:#fed7aa;padding:2px 8px;border-radius:4px;font-weight:600}.dl9-pending-chip b{color:#fdba74}.dl9-btn-mini{padding:2px 8px;font-size:11px;margin-left:6px;background:#9a3412;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600}.dl9-btn-mini:hover{opacity:0.85}.dl9-row-pending{background:rgba(124,45,18,0.18)}.dl9-cls-select{background:#0f172a;color:#e2e8f0;border:1px solid #475569;padding:2px 6px;border-radius:4px;font-size:12px;max-width:520px}.dl9-cand-links{display:inline-flex;gap:4px;margin-left:6px}.dl9-cand-link{color:#38bdf8;text-decoration:none;font-size:11px;padding:1px 4px;background:#0f172a;border-radius:3px}.dl9-cand-link:hover{color:#7dd3fc;background:#1e293b}.dl9-p3-wrap{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;align-items:start}.dl9-p3-selrow{grid-column:1/-1;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}.dl9-p3-col{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:4px;min-width:0}.dl9-p3-col-csv{background:rgba(15,23,42,0.6);border-left:2px solid #38bdf8}.dl9-p3-col-cand{background:rgba(120,53,15,0.18);border-left:2px solid #fbbf24}.dl9-p3-col-cand.dl9-p3-col-cand-new{background:rgba(20,83,45,0.18);border-left-color:#4ade80}.dl9-p3-hdr{font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px}.dl9-p3-col-csv .dl9-p3-hdr{color:#38bdf8}.dl9-p3-col-cand .dl9-p3-hdr{color:#fbbf24}.dl9-p3-col-cand-new .dl9-p3-hdr{color:#4ade80}.dl9-p3-meta{font-size:10px;color:#cbd5e1;font-family:monospace;line-height:1.3;word-break:break-word}.dl9-p3-meta b{color:#e2e8f0;font-weight:500}.dl9-p3-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:1px}.dl9-p3-chip{font-size:10px;padding:1px 7px;background:#0f172a;color:#cbd5e1;border:1px solid #334155;border-radius:10px;font-family:inherit;line-height:1.4}.dl9-p3-chip-match{background:rgba(20,83,45,0.45);color:#86efac;border-color:#15803d}.dl9-p3-chip-miss{background:rgba(127,29,29,0.35);color:#fca5a5;border-color:#991b1b}.dl9-p3-chip-empty{color:#64748b;font-style:italic;border-style:dashed}.dl9-p3-specs-btn{font-size:10px;padding:1px 6px;background:#1e293b;color:#94a3b8;border:1px solid #475569;border-radius:3px;cursor:pointer;font-family:inherit}.dl9-p3-specs-btn:hover{background:#334155;color:#e2e8f0}.dl9-p3-specs{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:2px;padding:4px 6px;background:rgba(15,23,42,0.4);border-radius:4px;border-left:2px solid #475569}.dl9-p3-specs-col{display:flex;flex-direction:column;gap:2px;min-width:0}.dl9-p3-specs-hdr{font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase}.dl9-p3-specs-list{font-size:10px;color:#cbd5e1;font-family:monospace;line-height:1.4;word-break:break-word}.dl9-p3-specs-err{color:#f87171}`;
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
        };
      });

      // 2) Selección global persistente: un Set, no checkboxes del DOM.
      const selected = new Set(rows.map(r => r.idx));

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
          <span style="font-size:12px;color:#94a3b8;margin-left:auto">Seleccionadas: <b id="dl9-sel-count">${selected.size}</b> / ${rows.length}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <button class="dl9-btn" id="dl9-sel-page" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Seleccionar todo (página)</button>
          <button class="dl9-btn" id="dl9-unsel-page" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Deseleccionar todo (página)</button>
          <button class="dl9-btn" id="dl9-sel-global" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Seleccionar TODO (global)</button>
          <button class="dl9-btn" id="dl9-unsel-global" style="background:#1e293b;color:#e2e8f0;font-size:11px;padding:4px 10px">Deseleccionar TODO (global)</button>
        </div>
        <h3 id="dl9-preview-title" style="margin-bottom:4px">Part Numbers — página 1</h3>
        <div id="dl9-table-wrap" style="max-height:300px;overflow-y:auto;border:1px solid #334155;border-radius:4px">
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

      function updateSelCount() {
        modal.querySelector('#dl9-sel-count').textContent = selected.size;
        modal.querySelector('#dl9-count').textContent = selected.size;
      }

      function updateHeaderStats() {
        const ncNow = rows.filter(r => r.status === 'new').length;
        const ecNow = rows.filter(r => r.status === 'existing').length;
        const dcNow = rows.filter(r => r.status === 'forceDup').length;
        const pendingNow = rows.filter(r => r.pase === 3).length;
        const line = modal.querySelector('#dl9-counts-line');
        if (line) {
          const pendingHtml = pendingNow > 0
            ? ` · <span class="dl9-pending-chip"><b>${pendingNow}</b> decisiones pendientes</span> <button id="dl9-toggle-pending" class="dl9-btn-mini">${filterPendingOnly ? 'Mostrar todas' : 'Solo pendientes'}</button>`
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
          tdPN.textContent = r.pn;
          tdPN.style.padding = '3px 6px';
          tdPN.style.fontFamily = 'monospace';
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
            // 1.2.8: sin cap — antes filtrábamos a 3 y eso confundía al operador
            // (parecía que faltaban PNs). Ahora salen TODOS los matches por nombre
            // del cliente; en escenarios reales son <=10, sin riesgo de saturar.
            for (let ci = 0; ci < (r.candidates || []).length; ci++) {
              const c = r.candidates[ci];
              const candLabels = (c.labels || []).filter(l => !nonFinishListUI.some(nf => nf.toUpperCase() === String(l).toUpperCase()));
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

            // Fila 2: columnas side-by-side CSV vs candidato.
            // Las etiquetas se renderizan como chips con color match/miss
            // para que el operador valide de un vistazo si el match propuesto
            // tiene sentido. Los demás campos (metal, proc, IBMS) se muestran
            // como meta-lines tipo "key: value".
            const makeMeta = (key, value) => {
              const div = document.createElement('div');
              div.className = 'dl9-p3-meta';
              const k = document.createElement('b');
              k.textContent = key + ': ';
              div.appendChild(k);
              div.appendChild(document.createTextNode(value));
              return div;
            };
            const makeChip = (text, kind) => {
              const chip = document.createElement('span');
              chip.className = 'dl9-p3-chip' + (kind ? ' dl9-p3-chip-' + kind : '');
              chip.textContent = text;
              return chip;
            };

            // Columna CSV (fija — la metadata del CSV no cambia)
            const csvCol = document.createElement('div');
            csvCol.className = 'dl9-p3-col dl9-p3-col-csv';
            const csvHdr = document.createElement('div');
            csvHdr.className = 'dl9-p3-hdr';
            csvHdr.textContent = '📄 CSV';
            csvCol.appendChild(csvHdr);
            if (r.csvMetalBase) csvCol.appendChild(makeMeta('metal', r.csvMetalBase));
            if (r.csvIBMS) csvCol.appendChild(makeMeta('IBMS', r.csvIBMS));
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
                const hdr = document.createElement('div');
                hdr.className = 'dl9-p3-hdr';
                hdr.textContent = '🆕 Crear nuevo PN';
                candCol.appendChild(hdr);
                const note = document.createElement('div');
                note.className = 'dl9-p3-meta';
                note.textContent = 'Se creará sin tocar los existentes.';
                candCol.appendChild(note);
                for (const lbl of (r.csvLabels || [])) {
                  csvChips.appendChild(makeChip(lbl, null));
                }
                if (!r.csvLabels?.length) {
                  csvChips.appendChild(makeChip('(sin etiquetas)', 'empty'));
                }
                return;
              }
              candCol.classList.remove('dl9-p3-col-cand-new');
              const id = parseInt(selVal, 10);
              const c = (r.candidates || []).find(x => x.id === id);
              if (!c) return;
              // 1.2.8: "(top match)" SOLO cuando el top candidato cumple match
              // estricto (mismo nombre + mismas etiquetas de acabado sin contar
              // nonFinish como SRG). Antes el badge salía siempre que id fuera el
              // primero del ranking, lo que confundía cuando las etiquetas no
              // empataban exacto (ej. CSV [Antitarnish,SRG] vs PN [Plata Flash,Antitarnish]).
              const isTop = (r.candidates?.[0]?.id === id) && hasStrictTopMatch;
              const hdr = document.createElement('div');
              hdr.className = 'dl9-p3-hdr';
              hdr.textContent = `🎯 #${c.id}` + (isTop ? ' (top match)' : '');
              candCol.appendChild(hdr);
              if (c.metalBase) candCol.appendChild(makeMeta('metal', c.metalBase));
              if (c.quoteIBMS) candCol.appendChild(makeMeta('IBMS', c.quoteIBMS));
              candCol.appendChild(makeMeta('proc', c.processName || '(sin proceso default)'));
              const csvSet = new Set(r.csvLabels || []);
              const candSet = new Set(c.labels || []);
              for (const lbl of (r.csvLabels || [])) {
                csvChips.appendChild(makeChip(lbl, candSet.has(lbl) ? 'match' : 'miss'));
              }
              if (!r.csvLabels?.length) {
                csvChips.appendChild(makeChip('(sin etiquetas)', 'empty'));
              }
              const candChips = document.createElement('div');
              candChips.className = 'dl9-p3-chips';
              for (const lbl of (c.labels || [])) {
                candChips.appendChild(makeChip(lbl, csvSet.has(lbl) ? 'match' : 'miss'));
              }
              if (!c.labels?.length) {
                candChips.appendChild(makeChip('(sin etiquetas)', 'empty'));
              }
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
              renderCandColumn(val);
              if (specsExpanded) renderSpecsPanel(val);
              updateHeaderStats();
              if (resumeState) {
                const slot = resumeState.classifications?.[idx];
                if (slot) slot.userOverride = pnStatus[idx].userOverride;
                persistResumeState().catch(() => {});
              }
            });

            pase3Wrap = wrap;
            tdAct.className = 'dl9-exist';
            tdAct.style.fontStyle = 'italic';
            tdAct.textContent = '👇 decidir abajo';
          } else if (r.status === 'new') { tdAct.className = 'dl9-new'; tdAct.textContent = 'CREAR NUEVO'; }
          else if (r.status === 'existing') { tdAct.className = 'dl9-exist'; tdAct.textContent = `MODIFICAR (id:${r.existingId})`; }
          else { tdAct.className = 'dl9-dup'; tdAct.textContent = `DUPLICAR${r.archivarAnterior ? ' + ARCHIVAR' : ''} (viejo:${r.existingId})`; }
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

      modal.querySelector('#dl9-cancel').onclick = () => { removeOverlay(overlay); resolve(false); };
      modal.querySelector('#dl9-exec').onclick = () => {
        const out = [...selected].sort((a, b) => a - b);
        removeOverlay(overlay);
        resolve(out);
      };
    });
  }

  function showProgressUI(msg) {
    let ov = document.getElementById('dl9-progress-overlay');
    if (!ov) {
      injectStyles(); ov = document.createElement('div'); ov.className = 'dl9-overlay'; ov.id = 'dl9-progress-overlay';
      ov.innerHTML = `<div class="dl9-modal"><h2>Ejecutando...</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="dl9-bar"></div></div><div class="dl9-progress" id="dl9-progress-text"></div></div>`;
      document.body.appendChild(ov);
    }
    const el = document.getElementById('dl9-progress-text');
    if (el) el.textContent += msg + '\n';
  }

  function setProgressBar(p) { const b = document.getElementById('dl9-bar'); if (b) b.style.width = p + '%'; }

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
    const po = document.getElementById('dl9-progress-overlay'); if (po) removeOverlay(po);
    injectStyles(); const { overlay, modal } = createOverlay();
    const errH = errors.length ? `<h3 class="dl9-err">Errores (${errors.length})</h3><div style="max-height:150px;overflow-y:auto;font-size:12px;color:#f87171;white-space:pre-wrap">${errors.join('\n')}</div>` : '';
    const lbl = quoteUrlLabel || 'ABRIR COTIZACIÓN';
    modal.innerHTML = `<h2>${errors.length ? 'Completado con errores' : 'Completado OK'}</h2><div class="dl9-stats"><div class="dl9-stat"><b>Quote:</b> ${stats.quoteName} (#${stats.quoteIdInDomain})</div><div class="dl9-stat"><b>PNs creados:</b> ${stats.pnsCreated}</div><div class="dl9-stat"><b>PNs existentes:</b> ${stats.pnsExisting}</div><div class="dl9-stat"><b>Duplicados:</b> ${stats.pnsDuplicated}</div><div class="dl9-stat"><b>Products:</b> ${stats.productsSet}</div><div class="dl9-stat"><b>Labels:</b> ${stats.labelsSet}</div><div class="dl9-stat"><b>Specs:</b> ${stats.specsSet}</div><div class="dl9-stat"><b>UnitConv:</b> ${stats.unitConvSet}</div><div class="dl9-stat"><b>Racks:</b> ${stats.racksSet}</div><div class="dl9-stat"><b>CI:</b> ${stats.ciSet}</div><div class="dl9-stat"><b>Dims:</b> ${stats.dimsSet}</div><div class="dl9-stat"><b>PredUsage:</b> ${stats.predictiveSet}</div><div class="dl9-stat"><b>Default Price:</b> ${stats.defaultPriceSet}</div><div class="dl9-stat"><b>Archivados:</b> ${stats.archived}</div><div class="dl9-stat"><b>Ant.archivados:</b> ${stats.oldArchived}</div><div class="dl9-stat"><b>Valid.1erRecibo:</b> ${stats.validacionSet}</div></div>${errH}<div class="dl9-btnrow"><button class="dl9-btn dl9-btn-copy" id="dl9-copy-log">COPIAR LOG</button>${quoteUrl ? `<button class="dl9-btn dl9-btn-exec" id="dl9-open-quote">${lbl}</button>` : ''}<button class="dl9-btn dl9-btn-close" id="dl9-close">CERRAR</button></div>`;
    if (quoteUrl) {
      document.getElementById('dl9-open-quote').addEventListener('click', () => {
        // V10: navega en la pestaña actual (Steelhead es SPA, evita perder contexto)
        window.location.href = quoteUrl;
      });
    }
    document.getElementById('dl9-close').onclick = () => removeOverlay(overlay);
    document.getElementById('dl9-copy-log').onclick = () => { navigator.clipboard.writeText(api().getLog().join('\n')).then(() => alert('Log copiado.')).catch(() => { const w = window.open('', '_blank'); w.document.write('<pre>' + api().getLog().join('\n') + '</pre>'); }); };
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
    try { showPanel(); } catch (_) {}
    setPanelPhase('Iniciando...');
    setPanelProgress(0, 0);
    setPanelCounters();

    try {
      log('Steelhead Automator v9 — iniciando...');

      // Parse CSV
      const csvClean = csvText.replace(/^\uFEFF/, '');
      const { header, parts } = parseRows(parseCSV(csvClean));
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
          log(`Reanudando corrida previa — fase: ${prev.phase}, ${resumeCompletedSet.size} PNs ya completados.`);
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
          lastUpdatedAt: new Date().toISOString(),
        };
        await persistResumeState();
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
      for (const cname of uniqueClientNames) {
        bailIfStale(myRunId);
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
      for (const pname of uniqueProcessNames) {
        bailIfStale(myRunId);
        const pd = await api().query('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: `%${pname}%`, first: 50 });
        const pn2 = pd?.allProcessNodes?.nodes || pd?.pagedData?.nodes || [];
        const pr = pn2.find(p => p.name?.toUpperCase() === pname.toUpperCase()) || pn2.find(p => p.name?.toUpperCase().includes(pname.toUpperCase()));
        if (!pr) throw new Error(`Proceso "${pname}" no encontrado en Steelhead.`);
        processCache.set(pname, pr.id);
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

      // Load dimension value maps (Línea/Departamento → ID)
      const dimValueMap = new Map(); // "valor" → id
      const dimIds = DOMAIN.dimensionIds || {};
      for (const dimId of Object.values(dimIds)) {
        bailIfStale(myRunId);
        try {
          const dd = await api().query('GetDimension', { id: dimId, includeArchived: 'NO' });
          const nodes = dd?.acctDimensionById?.acctDimensionCustomValuesByDimensionId?.nodes || [];
          for (const n of nodes) { if (n.value && !n.archivedAt) dimValueMap.set(n.value.trim(), n.id); }
        } catch (_) {}
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
      for (const sn of uniqueSpecs) {
        bailIfStale(myRunId);
        if (isDash(sn)) continue;
        const si = specByName.get(sn); if (!si) { warn(`Spec "${sn}" no encontrada.`); continue; }
        if (!sfCache.has(si.id)) {
          // V10: AllSpecs embed no devuelve params para todos los field types (e.g. DROPDOWN
          // viene vacío). SpecFieldsAndOptions sí trae el shape completo (mismo que usa
          // spec-migrator y está validado). Costo: N queries por upload, pero N suele ser < 10.
          try {
            const d = await api().query('SpecFieldsAndOptions', { specId: si.id }, 'SpecFieldsAndOptions');
            const sd = d?.specById; if (sd) { sfCache.set(si.id, sd); log(`  Spec "${sn}": ${sd.specFieldSpecsBySpecId?.nodes?.length || 0} campos`); }
          } catch (e) { warn(`Spec "${sn}" fields: ${String(e).substring(0, 100)}`); }
        }
      }

      // ── PN existence check ──
      bailIfStale(myRunId);
      const pnStatus = await checkPNExistence(parts, myRunId);

      // ── Restaurar userOverrides previos ANTES de pisar el snapshot ──
      // Si el usuario ya eligió candidatos en un preview previo (Pase 3 dropdown),
      // los recuperamos del resumeState antes de sobreescribir classifications.
      const prevOverrides = new Map();
      if (resumeState?.classifications) {
        for (const slot of resumeState.classifications) {
          if (slot.userOverride != null) prevOverrides.set(slot.csvRowKey, slot.userOverride);
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
      }

      // Persist classifications (con overrides ya re-aplicados)
      if (resumeState) {
        resumeState.classifications = pnStatus.map(s => ({
          csvRowKey: s.csvRowKey,
          classification: s.classification,
          pase: s.pase,
          targetPnId: s.targetPnId,
          userOverride: s.userOverride,
          candidates: (s.candidates || []).map(c => c.id),
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

      // ── Create new Metal Base values if confirmed ──
      if (createMetals && newMetals.size > 0) {
        showProgressUI('Actualizando catálogo de Metal Base...');
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
          showProgressUI(`  Metal Base: ${[...newMetals].join(', ')} agregados al catálogo`);
        } catch (e) {
          errors.push(`Actualizar Metal Base: ${String(e).substring(0, 120)}`);
          warn(`Metal Base schema update falló: ${e.message}`);
        }
      }

      // ═══════════════════════════════════════
      // EXECUTION
      // ═══════════════════════════════════════
      showProgressUI('Iniciando...');

      // V10: quote vars now per-customer; we track all of them
      const quotesCreated = []; // [{ id, idInDomain, customerId, name }]
      let primaryQuoteIdInDomain = null;
      const empresaKey = (header.empresaEmisora || 'ECO').toUpperCase();
      const empresaStr = DOMAIN.empresas[empresaKey] || DOMAIN.empresas.ECO;
      const validDays = parseInt(header.validaDias) || 30;

      if (!isSoloPN) {
        showProgressUI('Paso 1: Preparando cotizaciones...'); setProgressBar(5);
      } else {
        showProgressUI('Modo SOLO_PN — omitiendo cotización'); setProgressBar(5);
      }

      // STEP 2a: Create new PNs via SavePartNumber (minimal)
      // V10: newPnIds keyed by "pn|customerId" to support multi-customer
      showProgressUI('Paso 2/9: Creando PNs nuevos...'); setProgressBar(10);
      const newPnIds = new Map();
      const newOrDupParts = [];
      for (let i = 0; i < parts.length; i++) { const status = pnStatus[i]; if (status.status !== 'existing') newOrDupParts.push({ part: parts[i], status, idx: i }); }
      for (let j = 0; j < newOrDupParts.length; j++) {
        const { part, status } = newOrDupParts[j];
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
          // V10: key by pn|customerId so the same PN under different customers stays separate
          newPnIds.set(`${part.pn.toUpperCase()}|${part.customerId}`, created.id);
          if (status.status === 'forceDup') stats.pnsDuplicated++; else stats.pnsCreated++;
          log(`  "${part.pn}" (cust:${part.customerId}) -> creado id:${created.id}`);
        } catch (e) { errors.push(`Crear PN "${part.pn}": ${String(e).substring(0, 150)}`); }
      }
      showProgressUI(`  -> ${newPnIds.size} PNs creados`);

      // V10: pnLookup keyed by "pn|customerId" to support multi-customer
      const pnLookup = new Map();

      // 1.2.5: cache compartida entre enrichWorker (archive sentinel) y STEP 6b (param sync).
      // pnId → partNumberById (shape completo de GetPartNumber, incluye partNumberSpecsByPartNumberId
      // y partNumberSpecFieldParamsByPartNumberId). On-demand fetch — solo se popula cuando algún
      // PN existente lo necesita. Evita doble GetPartNumber al mismo PN.
      const existingPnFullCache = new Map();

      if (!isSoloPN) {
        // V10: Group parts by customer and create one quote per customer
        const partsByCustomer = new Map();
        for (let i = 0; i < parts.length; i++) {
          const cid = parts[i].customerId;
          if (!partsByCustomer.has(cid)) partsByCustomer.set(cid, []);
          partsByCustomer.get(cid).push({ part: parts[i], status: pnStatus[i], origIdx: i });
        }
        log(`Cotizaciones a crear: ${partsByCustomer.size} (una por cliente)`);

        let quoteSeq = 0;
        let prodAddedTotal = 0;
        for (const [cid, custParts] of partsByCustomer) {
          quoteSeq++;
          const cust = [...customerCache.values()].find(c => c.id === cid);
          if (!cust) { errors.push(`Cliente id ${cid} no en cache`); continue; }
          // V10: same layout name for all quotes — distinguishable by customer column in Steelhead UI
          const thisQuoteName = quoteName;
          // Use first part's divisa as quote-level divisa (per-line drives prices later)
          const quoteDivisa = (custParts[0].part.divisa || 'USD').toUpperCase();
          const quoteCI = {
            Comentarios: { CargosFletes: true, CotizacionSujetaPruebas: true, ReferirNumeroCotizacion: true, ModificacionRequiereRecotizar: true },
            DatosAdicionales: { Divisa: quoteDivisa, Decimales: '2', EmpresaEmisora: empresaStr, MostrarProceso: false, MostrarTotales: true },
            Autorizacion: {}, CondicionesComerciales: {},
          };

          showProgressUI(`Quote ${quoteSeq}/${partsByCustomer.size}: buscando duplicados...`);
          setProgressBar(5 + Math.round((quoteSeq / partsByCustomer.size) * 40));

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
            showProgressUI(`Quote ${quoteSeq}/${partsByCustomer.size}: "${thisQuoteName}"`);
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
          const pnpItems = []; let lineNum = 0;
          for (const { part, status } of custParts) {
            lineNum++;
            let partNumberId;
            if (status.status === 'existing') { partNumberId = status.existingId; stats.pnsExisting++; }
            else { partNumberId = newPnIds.get(`${part.pn.toUpperCase()}|${cid}`); if (!partNumberId) { errors.push(`PN "${part.pn}" no fue creado, omitido de quote.`); continue; } }
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
          for (let i = 0; i < pnpItems.length; i += 20) {
            const batch = pnpItems.slice(i, i + 20);
            try {
              await api().queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN',
                { input: { quoteId: thisQuoteId, autoGenerateQuoteLines: true, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] } });
            } catch (e) { errors.push(`SaveManyPNP quote ${thisQuoteIdInDomain}: ${String(e).substring(0, 120)}`); }
          }
          log(`  SaveManyPNP: ${pnpItems.length}`);

          // Re-read quote to populate pnLookup
          let qData;
          try { ({ data: qData } = await api().queryWithFallback('GetQuote', 'GetQuote_v8', 'GetQuote_v71', { idInDomain: thisQuoteIdInDomain, revisionNumber: 1 })); }
          catch (e) { errors.push(`GetQuote ${thisQuoteIdInDomain}: ${String(e).substring(0, 120)}`); continue; }
          const quote = qData?.quoteByIdInDomainAndRevisionNumber || qData?.quoteByIdInDomain;
          if (!quote) { errors.push(`No se pudo leer quote #${thisQuoteIdInDomain}.`); continue; }
          const qpnpNodes = quote.quotePartNumberPricesByQuoteId?.nodes || [];
          const qlNodes = quote.quoteLinesByQuoteId?.nodes || [];
          const qlByQpnpId = new Map(); for (const ql of qlNodes) if (ql.autoGeneratedFromQuotePartNumberPriceId) qlByQpnpId.set(ql.autoGeneratedFromQuotePartNumberPriceId, ql);
          for (const qpnp of qpnpNodes) {
            const pnp = qpnp.partNumberPriceByPartNumberPriceId; if (!pnp) continue;
            const pn = pnp.partNumberByPartNumberId; if (!pn?.name) continue;
            pnLookup.set(`${pn.name.toUpperCase()}|${cid}`, { qpnp, pnp, pn, ql: qlByQpnpId.get(qpnp.id) || null, quoteId: thisQuoteId });
          }
          const allProdNodes = quote.allProducts?.nodes || qData.allProducts?.nodes || [];
          if (allProdNodes.length) for (const p of allProdNodes) productByName.set(p.name, p);

          // SaveQuoteLines (products) for this customer's parts
          for (const { part } of custParts) {
            if (!part.products.length) continue;
            const entry = pnLookup.get(`${part.pn.toUpperCase()}|${cid}`); if (!entry) { errors.push(`PN "${part.pn}" no en quote.`); continue; }
            const ql = entry.ql; if (!ql) { errors.push(`QuoteLine no encontrada para "${part.pn}".`); continue; }
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
        }
        stats.productsSet = prodAddedTotal;
        stats.quoteIdInDomain = primaryQuoteIdInDomain;
        if (quotesCreated.length > 1) stats.quoteName = `${quotesCreated.length} cotizaciones "${quoteName}"`;
        else if (quotesCreated.length === 1) stats.quoteName = quotesCreated[0].name;
        showProgressUI(`  -> ${quotesCreated.length} cotizaciones creadas, ${prodAddedTotal} products`);
      } else {
        // SOLO_PN: build pnLookup from existing/new PN IDs (no quote context)
        showProgressUI('Modo SOLO_PN: construyendo mapa de PNs...'); setProgressBar(30);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i];
          let pnId;
          if (status.status === 'existing') { pnId = status.existingId; stats.pnsExisting++; }
          else { pnId = newPnIds.get(`${part.pn.toUpperCase()}|${part.customerId}`); }
          if (!pnId) continue;
          // V10: key by pn|customerId
          pnLookup.set(`${part.pn.toUpperCase()}|${part.customerId}`, {
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
          const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
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
          showProgressUI('Modo SOLO_PN: Creando precios standalone...'); setProgressBar(40);
          for (let i = 0; i < pnpWithPrice.length; i += 20) {
            const batch = pnpWithPrice.slice(i, i + 20);
            try {
              await api().query('SaveManyPartNumberPrices', {
                input: { quoteId: null, autoGenerateQuoteLines: false, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] }
              }, 'SaveManyPNP_PN');
              showProgressUI(`  -> Precios batch ${Math.floor(i / 20) + 1}: ${batch.length} PNs`);
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
      showProgressUI(`${isSoloPN ? 'Paso 3' : 'Paso 6'}: Enriqueciendo PNs...`); setProgressBar(55);

      // V10 fix: Pre-fetch existing predicted inventory usages para PNs existentes con predictivos.
      // SavePartNumber inserta sin id → unique constraint en (pn, inventoryItem) → retry strippea
      // los predictivos y se pierde la actualización. Pasamos el id existente para forzar UPDATE.
      const existingPredictedMap = new Map(); // pnId → Map(inventoryItemId → existingRecordId)
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]; const st = pnStatus[i];
        if (st.status !== 'existing' || !p.predictiveUsage.length) continue;
        const e = pnLookup.get(`${p.pn.toUpperCase()}|${p.customerId}`); if (!e?.pn?.id) continue;
        if (existingPredictedMap.has(e.pn.id)) continue; // ya cargado
        try {
          const pnData = await api().query('GetPartNumber', { partNumberId: e.pn.id });
          const exPred = pnData?.partNumberById?.predictedInventoryUsagesByPartNumberId?.nodes || [];
          const m = new Map();
          for (const ep of exPred) {
            const itemId = ep.inventoryItemByInventoryItemId?.id || ep.inventoryItemId;
            if (itemId && ep.id) m.set(String(itemId), ep.id);
          }
          existingPredictedMap.set(e.pn.id, m);
        } catch (_) {}
      }
      if (existingPredictedMap.size) log(`  Pre-fetched predictivos existentes de ${existingPredictedMap.size} PNs`);

      // FIX 1 (2026-05-18): pool concurrente (default 5) en lugar de loop secuencial.
      // 9k PNs × 0.5-1s sec → 75 min se vuelven 15-30 min con concurrency 5.
      let okSP = 0, retrySP = 0;
      const enrichConcurrency = bulkCfg().concurrency.savePartNumber;
      setPanelPhase('Enriqueciendo PNs (pool ' + enrichConcurrency + ')');
      setPanelProgress(0, parts.length);

      async function enrichWorker(part, idx, myRunId) {
        bailIfStale(myRunId);
        // Resume: si este PN ya quedó completado en una corrida previa, brincarlo.
        if (resumeCompletedSet.has(`${part.pn}|${part.customerId}`)) {
          okSP++;
          state.counters.ok++;
          return;
        }
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
        if (!entry) return;
        const pn = entry.pn;

        // Guión comodín: "-" en primer label = borrar todos los labels
        const labelsAreDash = part.labels.length === 1 && isDash(part.labels[0]);
        const labelIds = labelsAreDash ? [] : part.labels.map(n => labelByName.get(n)).filter(Boolean);
        if (labelIds.length) stats.labelsSet += labelIds.length;

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
          let cached = existingPnFullCache.get(pn.id);
          if (!cached) {
            try {
              bailIfStale(myRunId);
              const pnData = await withRetry(
                () => api().query('GetPartNumber', { partNumberId: pn.id }),
                `GetPartNumber archive "${pn.name}"`,
                myRunId
              );
              cached = pnData?.partNumberById || null;
              if (cached) existingPnFullCache.set(pn.id, cached);
            } catch (e) {
              if (isBail(e)) throw e;
              warn(`Archive sentinel "${pn.name}": GetPartNumber falló (${String(e).substring(0, 80)}), no se archivará nada`);
            }
          }
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

        const mergedCI = mergeCustomInputs(pn.customInputs, part);
        if (part.codigoSAT || part.metalBase || part.pnAlterno) stats.ciSet++;

        // Dims — "-" en longitud = borrar dimensiones
        const dimsAreDash = typeof part.dims.length === 'string' && isDash(part.dims.length);
        const dims = dimsAreDash ? [] : buildDimensions(part.dims, DOMAIN);
        const hasDims = dims.length > 0; if (hasDims) stats.dimsSet++;

        // Predictive — "-" en primer material = borrar predictive usage
        const predAreDash = part.predictiveUsage.length === 1 && isDash(part.predictiveUsage[0]?.usagePerPart);
        const finalPredictive = predAreDash ? [] : part.predictiveUsage;
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
          specsToApply, isCoupon: false, isOneOff: false, isTemplatePartNumber: false, optInOuts, ownerIds: [], defaults: [],
          dimensionCustomValueIds: dimValueIds,
          paramsToApply: [], partNumberDimensions: dims, partNumberLocations: [],
          partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [], partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
          partNumberSpecsToArchive: partNumberSpecsToArchiveIds, partNumberSpecsToUnarchive: [], specFieldParamUpdates: [],
          glAccountId: null, taxCodeId: null, certPdfTemplateId: null, userFileName: null
        };

        bailIfStale(myRunId);
        try {
          // withRetry para 429/503/network; unique_constraint cae a la lógica progresiva abajo
          await withRetry(
            () => api().query('SavePartNumber', { input: [pnInput] }),
            `SavePartNumber "${pnInput.name}"`,
            myRunId
          );
          okSP++;
          state.counters.ok++;
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
              retrySP++; log(`  -> ${pnInput.name}: retry sin specs/optIn OK`);
            } catch (e2) {
              if (isBail(e2)) throw e2;
              try {
                await withRetry(
                  () => api().query('SavePartNumber', { input: [{ ...pnInput, specsToApply: [], optInOuts: [], inventoryPredictedUsages: [] }] }),
                  `SavePartNumber "${pnInput.name}" strip2`,
                  myRunId
                );
                retrySP++; log(`  -> ${pnInput.name}: retry mínimo OK`);
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

        // Persistencia incremental para resume (Fix 7) — cada 50 PNs procesados
        if ((okSP + retrySP) % 50 === 0 && resumeState) {
          resumeState.completedPNs.push(`${part.pn}|${part.customerId}`);
          persistResumeState().catch(() => {});
        } else if (resumeState) {
          resumeState.completedPNs.push(`${part.pn}|${part.customerId}`);
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
      showProgressUI(`  -> ${okSP} OK, ${retrySP} retry`);
      if (resumeState) { resumeState.phase = 'enrich-done'; await persistResumeState(); }

      // STEP 6a: Actualizar predictivos existentes vía UpdateInventoryItemPredictedUsage.
      // Steelhead almacena en microQuantityPerPart (kg/pza × 1e6 redondeado).
      const predictedUpdates = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        if (status.status !== 'existing') continue;
        if (!part.predictiveUsage.length) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
        const exMap = entry?.pn?.id ? existingPredictedMap.get(entry.pn.id) : null;
        if (!exMap || !exMap.size) continue;
        // Si el primer predictivo es "-" se borra todo (ya manejado por finalPredictive arriba: queda [])
        const predIsDash = part.predictiveUsage.length === 1 && typeof part.predictiveUsage[0]?.usagePerPart === 'string' && isDash(part.predictiveUsage[0].usagePerPart);
        if (predIsDash) continue;
        for (const pu of part.predictiveUsage) {
          const exId = exMap.get(String(pu.inventoryItemId));
          if (!exId) continue; // es uno nuevo, ya fue al SavePartNumber
          const micro = Math.round(parseFloat(pu.usagePerPart) * 1e6);
          if (!Number.isFinite(micro)) continue;
          predictedUpdates.push({ id: exId, microQuantityPerPart: micro, inventoryUsageLowCodeId: null });
        }
      }
      if (predictedUpdates.length) {
        // Batches de 20 para no abusar del payload
        for (let i = 0; i < predictedUpdates.length; i += 20) {
          const batch = predictedUpdates.slice(i, i + 20);
          try {
            await api().query('UpdateInventoryItemPredictedUsage', { mnPredictedInventoryUsagePatch: batch }, 'UpdateInventoryItemPredictedUsage');
          } catch (e) {
            errors.push(`UpdatePredictedUsage batch ${Math.floor(i / 20) + 1}: ${String(e).substring(0, 120)}`);
          }
        }
        log(`  Predictivos actualizados: ${predictedUpdates.length}`);
      }

      // STEP 6b: Sync params on existing PNs whose specs were already linked.
      // SavePartNumber.specsToApply ignora specs ya ligadas — si el usuario agregó un field
      // nuevo a la spec definición, no se aplica al PN. Aquí lo emparejamos con AddParamsToPartNumber.
      let syncedParamsCount = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        if (status.status !== 'existing' || !part.specs.length) continue;
        if (part.specs.length === 1 && isDash(part.specs[0].name)) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
        if (!entry?.pn?.id) continue;
        try {
          // 1.2.5: reusa cache poblado en enrichWorker (archive sentinel). Cache-miss → fetch.
          let pnNode = existingPnFullCache.get(entry.pn.id);
          if (!pnNode) {
            const pnData = await api().query('GetPartNumber', { partNumberId: entry.pn.id });
            pnNode = pnData?.partNumberById; if (!pnNode) continue;
            existingPnFullCache.set(entry.pn.id, pnNode);
          }
          const linkedSpecs = pnNode.partNumberSpecsByPartNumberId?.nodes || [];
          const allParams = pnNode.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
          for (const cs of part.specs) {
            if (isDash(cs.name)) continue;
            const si = specByName.get(cs.name); if (!si) continue;
            const linked = linkedSpecs.find(s => s.specBySpecId?.id === si.id && !s.archivedAt);
            if (!linked) continue; // not linked → SavePartNumber ya lo creó (o lo creará en otro flujo)
            // wanted params: misma lógica que en STEP 6 spec build
            const sd = sfCache.get(si.id); if (!sd) continue;
            const wantedParamIds = new Set();
            const wantedSelections = []; // {specFieldId, specFieldParamId, isGeneric}
            for (const sf of (sd.specFieldSpecsBySpecId?.nodes || [])) {
              const params = sf.defaultValues?.nodes || []; if (!params.length) continue;
              const fn = sf.specFieldBySpecFieldId?.name || '';
              const isEsp = fn.toLowerCase().includes('espesor');
              let pid;
              if (params.length === 1) pid = params[0].id;
              else if (isEsp && cs.param) { const m = params.find(p => p.name === cs.param); pid = m ? m.id : params[0].id; }
              else pid = params[0].id;
              if (!pid) continue;
              wantedParamIds.add(pid);
              wantedSelections.push({ specFieldId: sf.specFieldBySpecFieldId?.id, specFieldParamId: pid, isGeneric: !!sf.isGeneric });
            }
            // existing active params on this PN
            const existingParamIds = new Set(
              allParams
                .filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId)
                .map(p => p.specFieldParamBySpecFieldParamId.id)
            );
            const missing = wantedSelections.filter(s => !existingParamIds.has(s.specFieldParamId));
            if (!missing.length) continue;
            // El scan de la UI muestra que AddParamsToPartNumber se llama con processNodeId:null
            // (igual para isGeneric true o false). Pasar el processId real choca con exclusion constraint.
            const paramsToAdd = missing.map(m => ({
              specFieldId: m.specFieldId,
              specFieldParamId: m.specFieldParamId,
              isGeneric: m.isGeneric,
              geometryTypeSpecFieldId: null,
              processNodeId: null,
              processNodeOccurrence: null,
              locationId: null
            }));
            // La UI los manda uno por uno; replicamos el patrón para que un param fallido no
            // tire el batch, y para tolerar mejor exclusion-constraint en params ya presentes.
            let added = 0;
            for (const pa of paramsToAdd) {
              try {
                await api().query('AddParamsToPartNumber', { input: { partNumberId: entry.pn.id, paramsToApply: [pa] } }, 'AddParamsToPartNumber');
                added++;
              } catch (e) {
                const msg = String(e);
                if (msg.includes('exclusion constraint') || msg.includes('conflicting key') || msg.includes('23P01')) {
                  // Steelhead dice que ya existe — lo tratamos como skip silencioso
                  log(`  PN "${part.pn}" spec "${cs.name}": param ${pa.specFieldParamId} ya presente, skip`);
                } else {
                  errors.push(`AddParams "${part.pn}" spec "${cs.name}" param ${pa.specFieldParamId}: ${msg.substring(0, 120)}`);
                }
              }
            }
            syncedParamsCount += added;
            if (added) log(`  PN "${part.pn}" spec "${cs.name}": ${added} params nuevos sincronizados`);
          }
        } catch (e) {
          warn(`Sync specs "${part.pn}": ${String(e).substring(0, 100)}`);
        }
      }
      if (syncedParamsCount) log(`  Spec params sync: ${syncedParamsCount} params agregados`);

      // STEP 7: RackTypes — runs in BOTH modes
      showProgressUI(`${isSoloPN ? 'Paso 4' : 'Paso 7'}: Racks...`); setProgressBar(78);
      const rackIn = [];
      const racksToDelete = []; // PNs where racks should be deleted (guión)
      for (const part of parts) {
        if (!part.racks.length) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
        // Guión (-) in first rack = delete all racks
        if (part.racks.length === 1 && isDash(part.racks[0].name)) {
          racksToDelete.push(entry.pn.id);
          continue;
        }
        for (const rk of part.racks) {
          if (isDash(rk.name)) continue;
          const rt = rackTypeByName.get(rk.name); if (!rt) { errors.push(`RackType "${rk.name}" no encontrado.`); continue; }
          if (rk.ppr === null) continue;
          rackIn.push({ rackTypeId: rt.id, partNumberId: entry.pn.id, partsPerRack: rk.ppr });
        }
      }
      // Delete racks for PNs with guión
      for (const pnId of racksToDelete) {
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

      if (rackIn.length) {
        for (let i = 0; i < rackIn.length; i += 50) {
          const batch = rackIn.slice(i, i + 50);
          try {
            await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: batch, partNumberRackTypeIdsToDelete: [] } });
          } catch (e) {
            if (isDuplicateKeyError(e)) {
              log(`  Racks batch ${Math.floor(i / 50) + 1}: duplicados, upsertando uno por uno...`);
              for (const rk of batch) await upsertRack(rk);
            } else { errors.push(`SavePartNumberRackTypes: ${String(e).substring(0, 120)}`); }
          }
        }
      }
      stats.racksSet = rackIn.length + racksToDelete.length; log(`  Racks: ${rackIn.length} agregados, ${racksToDelete.length} PNs con racks eliminados`);

      // STEP 7b: Delete prices (guión in precio column)
      const pricesToDelete = [];
      for (const part of parts) {
        if (!isDash(String(part.precio))) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
        pricesToDelete.push({ pnId: entry.pn.id, pnName: part.pn });
      }
      if (pricesToDelete.length) {
        showProgressUI(`Borrando precios de ${pricesToDelete.length} PNs...`);
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

      // STEP 8: Default Price + Archive
      showProgressUI(`${isSoloPN ? 'Paso 5' : 'Paso 8'}: Archivado...`); setProgressBar(85);
      const pnsToArchive = [], oldPnsToArchive = [], pnsToUnarchive = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
        if (part.archivado) {
          pnsToArchive.push({ id: entry.pn.id, name: part.pn });
        } else if (pnStatus[i].status === 'existing') {
          // FALSE on existing PN = desarchivar si estaba archivado
          pnsToUnarchive.push({ id: entry.pn.id, name: part.pn });
        }
        if (status.status === 'forceDup' && part.archivarAnterior && status.existingId) oldPnsToArchive.push({ id: status.existingId, name: part.pn + ' (ant)' });
      }
      // Default price: set or unset
      const priceIdsForDefault = [];
      const priceIdsToUnsetDefault = [];
      if (!isSoloPN) {
        // In quote mode, use qpnp price IDs
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
          const pnpId = entry.pnp?.id;
          if (!pnpId) continue;
          if (part.precioDefault) priceIdsForDefault.push(pnpId);
          else priceIdsToUnsetDefault.push(pnpId);
        }
      } else {
        // SOLO_PN: necesitamos releer los precios del PN porque el ID del nuevo precio
        // no lo tenemos (SaveManyPartNumberPrices no devuelve los IDs en este flujo)
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
          if (!entry?.pn?.id) continue;
          // Solo releemos si hay algo que hacer con el default
          const needsRead = part.precioDefault || (!part.precioDefault && pnStatus[i].status === 'existing');
          if (!needsRead) continue;
          try {
            const pnData = await api().query('GetPartNumber', { partNumberId: entry.pn.id });
            const prices = pnData?.partNumberById?.partNumberPricesByPartNumberId?.nodes || [];
            if (!prices.length) continue;
            if (part.precioDefault) {
              // El precio recién creado en esta corrida es el de ID más alto
              const sorted = [...prices].sort((a, b) => Number(b.id) - Number(a.id));
              const newest = sorted[0];
              if (newest) priceIdsForDefault.push(newest.id);
              // Quita el default del viejo (si era distinto del nuevo)
              const oldDefault = prices.find(p => p.isDefault && p.id !== newest.id);
              if (oldDefault) priceIdsToUnsetDefault.push(oldDefault.id);
            } else {
              // FALSE explícito en existente = quitar el default actual
              const defaultPrice = prices.find(p => p.isDefault);
              if (defaultPrice) priceIdsToUnsetDefault.push(defaultPrice.id);
            }
          } catch (_) {}
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
        setPanelPhase('Archivando PNs (pool ' + archiveConcurrency + ')');
        setPanelProgress(0, archiveOps.length);
        log(`  Archivado: ${pnsToArchive.length} nuevos archivar, ${oldPnsToArchive.length} viejos archivar, ${pnsToUnarchive.length} desarchivar (concurrencia ${archiveConcurrency})`);

        async function archiveWorker(op, _idx, runId) {
          bailIfStale(runId);
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
      showProgressUI('Completado.'); setProgressBar(100);
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
          log: api().getLog(),
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
        if (history.length > 50) history.length = 50; // keep last 50
        localStorage.setItem('sa_load_history', JSON.stringify(history));
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
        const po = document.getElementById('dl9-progress-overlay'); if (po) removeOverlay(po);
        try { markPanelDone(false, 'Cancelado'); } catch (_) {}
        return { success: false, cancelled: true };
      }
      console.error('[SA] FATAL:', e);
      const po = document.getElementById('dl9-progress-overlay'); if (po) removeOverlay(po);
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

  function isNonFinishLabel(name, nonFinishList) {
    if (!name || typeof name !== 'string') return false;
    return nonFinishList.includes(name);
  }

  function acabadosOrdenados(labels, nonFinishList) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    const acabados = [];
    for (const l of labels) {
      if (!l || typeof l !== 'string') continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      if (seen.has(l)) continue;
      seen.add(l);
      acabados.push(l);
    }
    return acabados.sort().join('|');
  }

  function buildCompositeKey(pn, nonFinishList) {
    const customerId = pn.customerId != null ? String(pn.customerId) : '';
    const name = (pn.name || '').toUpperCase();
    const metalBase = pn.metalBase ? String(pn.metalBase) : '';
    const acabados = acabadosOrdenados(pn.labels || [], nonFinishList);
    return `${customerId}||${name}||${metalBase}||${acabados}`;
  }

  function rankCandidates(csvRow, candidates, nonFinishList) {
    const csvMetal = csvRow.metalBase || '';
    const csvAcabados = acabadosOrdenados(csvRow.labels || [], nonFinishList);
    const csvIbms = csvRow.quoteIBMS || '';

    function score(c) {
      let s = 0;
      if ((c.metalBase || '') === csvMetal) s++;
      if (acabadosOrdenados(c.labels || [], nonFinishList) === csvAcabados) s++;
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

  function classifyOnePN(csvRow, pnsForCustomer, nonFinishList) {
    const activePns = (pnsForCustomer || []).filter(p => !p.archivedAt);
    const csvIbms = csvRow.quoteIBMS || '';
    const csvCompositeKey = buildCompositeKey(csvRow, nonFinishList);

    // ── Pase 1: QuoteIBMS autoritativo ──
    if (csvIbms) {
      const byIbms = activePns.find(p => (p.quoteIBMS || '') === csvIbms);
      if (byIbms) {
        return {
          classification: 'MODIFY',
          pase: 1,
          confidence: 'ibms-exacto',
          targetPnId: byIbms.id,
          candidates: [],
        };
      }
    }

    // ── Pase 2: composite exacto con regla anti-colisión ──
    // Los PNs del catálogo pueden no traer customerId en su shape (ya están filtrados por cliente).
    // Normalizamos usando el customerId del csvRow para que la comparación de keys sea apples-to-apples.
    const csvCustomerId = csvRow.customerId;
    const byComposite = activePns.find(p => {
      const pNorm = (p.customerId != null) ? p : Object.assign({}, p, { customerId: csvCustomerId });
      return buildCompositeKey(pNorm, nonFinishList) === csvCompositeKey;
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
        return {
          classification: 'MODIFY',
          pase: 2,
          confidence: `composite-exacto-${confSuffix}`,
          targetPnId: byComposite.id,
          candidates: [],
        };
      }
      // colision → cae a Pase 3 (el PN aparecerá como candidato)
    }

    // ── Pase 3: near-match por nombre ──
    // 1.2.1: default MODIFY al top match SOLO si las etiquetas de acabado del top
    // coinciden exactas con las del CSV (sets iguales sin contar nonFinish). Si no,
    // default NEW con los candidatos disponibles en el dropdown para override manual.
    // Esto evita pisar PNs con etiquetas distintas por nombre coincidente accidental.
    const nameUpper = (csvRow.name || '').toUpperCase();
    const nameCandidates = activePns.filter(p => (p.name || '').toUpperCase() === nameUpper);
    if (nameCandidates.length > 0) {
      // 1.2.8: sin cap — devuelve todos los matches por nombre. El operador ve
      // la lista completa en el dropdown del panel y decide. Antes capábamos a 3
      // y eso ocultaba PNs reales que el operador esperaba ver.
      const ranked = rankCandidates(csvRow, nameCandidates, nonFinishList);
      const csvAcabados = acabadosOrdenados(csvRow.labels || [], nonFinishList);
      const topAcabados = acabadosOrdenados(ranked[0].labels || [], nonFinishList);
      const labelsMatchFull = csvAcabados === topAcabados;
      if (labelsMatchFull) {
        return {
          classification: 'MODIFY',
          pase: 3,
          confidence: 'name+labels-match',
          targetPnId: ranked[0].id,
          candidates: ranked,
        };
      }
      return {
        classification: 'NEW',
        pase: 3,
        confidence: 'name-only-labels-differ',
        targetPnId: null,
        candidates: ranked,
      };
    }

    // ── Sin candidatos en ningún pase ──
    return {
      classification: 'NEW',
      pase: null,
      confidence: 'sin-match',
      targetPnId: null,
      candidates: [],
    };
  }

  const __helpers = { isNonFinishLabel, acabadosOrdenados, buildCompositeKey, rankCandidates, classifyOnePN, extractPNShape };

  return { execute, setProgressCallback, parseCSV, parseRows, __helpers };
})();

if (typeof window !== 'undefined') {
  window.BulkUpload = BulkUpload;
  window.BulkUploadHelpers = BulkUpload.__helpers || {};
}
