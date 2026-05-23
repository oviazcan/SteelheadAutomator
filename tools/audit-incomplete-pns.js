// audit-incomplete-pns.js
// Script standalone para DevTools — auditoría de PNs cargados por bulk-upload
// contra el CSV original. Detecta PNs que quedaron incompletos (labels, specs,
// racks, predictivos, precio, dims, custom inputs, etc.) y emite:
//   1. Un CSV reducido con SOLO las filas incompletas (mismo layout que la
//      entrada — re-cargable por bulk-upload para corregir).
//   2. Un JSON con el detalle de qué le falta a cada PN.
//
// Cómo usar:
//   1. Abre app.gosteelhead.com en Chrome y autentícate.
//   2. Abre DevTools → Console.
//   3. Pega TODO este archivo y dale Enter.
//   4. Aparece un panel flotante. Click "Cargar CSV" y selecciona el .csv
//      original de la carga.
//   5. El script descarga PNs por cliente, audita cada fila y al terminar
//      ofrece descargar el CSV de recuperación + reporte JSON.
//
// Origen del config:
//   - Si window.REMOTE_CONFIG existe (extensión cargada) lo usa.
//   - Si no, hace fetch a https://oviazcan.github.io/SteelheadAutomator/config.json.
//
// El script NO modifica nada en Steelhead — solo hace queries de lectura.
//
// 2026-05-22 — Omar Viazcán + Claude (Opus 4.7)

(async () => {
  'use strict';

  // ─── Si ya está cargado, abrir solo el modal ───────────────────────────────
  if (window.__SAAuditIncompletePNs?.openModal) {
    window.__SAAuditIncompletePNs.openModal();
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1) CONFIG + GRAPHQL CLIENT
  // ═══════════════════════════════════════════════════════════════════════
  const CONFIG_URL = 'https://oviazcan.github.io/SteelheadAutomator/config.json';
  const GRAPHQL_URL = 'https://app.gosteelhead.com/graphql';
  const APOLLO_VERSION = '4.0.8';

  let config = window.REMOTE_CONFIG || null;
  if (!config) {
    try {
      const r = await fetch(CONFIG_URL, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      config = await r.json();
    } catch (e) {
      alert('No se pudo cargar config desde gh-pages: ' + e.message);
      return;
    }
  }
  const hashes = {
    ...(config.steelhead?.hashes?.queries || {}),
    ...(config.steelhead?.hashes?.mutations || {}),
  };
  const DOMAIN = config.steelhead?.domain || {};

  // Validaciones mínimas de hashes que vamos a usar.
  const REQUIRED = ['GetPartNumber', 'AllPartNumbers', 'CustomerSearchByName', 'AllProcesses', 'AllLabels', 'AllRackTypes'];
  const missing = REQUIRED.filter(k => !hashes[k]);
  if (missing.length) {
    alert('Faltan hashes en config: ' + missing.join(', '));
    return;
  }

  async function gql(operationName, variables = {}, hashKey) {
    const hash = hashes[hashKey || operationName];
    if (!hash) throw new Error('Hash no encontrado para ' + operationName);
    const body = {
      operationName,
      variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
        persistedQuery: { version: 1, sha256Hash: hash },
      },
    };
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} en ${operationName}: ${t.substring(0, 300)}`);
    }
    const json = await r.json();
    if (json.errors && !json.data) {
      throw new Error(`GraphQL ${operationName}: ` + json.errors.map(e => e.message).join('; ').substring(0, 300));
    }
    return json.data;
  }

  async function withRetry(fn, label, maxRetries = 3) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        const msg = String(e);
        const retriable = /Failed to fetch|HTTP 429|HTTP 5\d{2}|NetworkError/i.test(msg);
        if (!retriable) throw e;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function runPool(items, worker, concurrency, onProgress) {
    let done = 0;
    const total = items.length;
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        if (state.aborted) return;
        const i = idx++;
        if (i >= total) return;
        try { await worker(items[i], i); } catch (_) {}
        done++;
        onProgress?.(done, total);
      }
    });
    await Promise.all(workers);
  }

  // ─── Stop Datadog session replay (copy de bulk-upload v1.4.20) ─────────────
  // En runs largos (3000+ PNs) Datadog acumula 200-400 MB en el heap. Stop
  // agresivo: API oficial + revoke consent + monkey-patch fetch/sendBeacon/XHR
  // para descartar requests al endpoint. Latch idempotente.
  function stopDatadogSessionReplay() {
    if (window.__sa_audit_dd_stopped) return;
    try {
      const dd = window.DD_RUM || window.datadogRum || window.__DD_RUM__;
      if (dd) {
        try { dd.stopSessionReplayRecording?.(); } catch (_) {}
        try { dd.stopSession?.(); } catch (_) {}
        try { dd.setTrackingConsent?.('not-granted'); } catch (_) {}
        log('Datadog: stopSessionReplay + stopSession + consent revoked.');
      }
    } catch (_) {}
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
        if (navigator.sendBeacon) {
          const origBeacon = navigator.sendBeacon.bind(navigator);
          navigator.sendBeacon = function (url, data) {
            if (/browser-intake-ddog-gov\.com|datadoghq\.com/i.test(url)) return true;
            return origBeacon(url, data);
          };
        }
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
        log('Fetch+sendBeacon+XHR a Datadog patcheados.');
      } catch (_) {}
    }
    // Cleanup Apollo cache si está expuesto.
    try {
      const candidates = [window.__APOLLO_CLIENT__, window.apolloClient, window.__APOLLO__?.client].filter(Boolean);
      for (const client of candidates) {
        try {
          if (typeof client.clearStore === 'function') client.clearStore().catch(() => {});
          else if (client.cache && typeof client.cache.reset === 'function') client.cache.reset();
        } catch (_) {}
      }
    } catch (_) {}
    window.__sa_audit_dd_stopped = true;
  }

  // ─── Memoria del tab + guardrail OOM (copy de bulk-upload v1.4.11/1.4.20) ──
  // performance.memory (Chrome/Edge) reporta heap nativo. Re-aplica stop de
  // Datadog a >70% (idempotente). Aborta el run a >88% para evitar crash silente.
  let memoryGaugeTimer = null;
  function startMemoryGauge() {
    if (memoryGaugeTimer) return;
    if (!(performance && performance.memory)) return;
    const tick = () => {
      const el = document.getElementById('sa-audit-mem');
      const used = performance.memory.usedJSHeapSize;
      const limit = performance.memory.jsHeapSizeLimit;
      const usedMB = Math.round(used / 1024 / 1024);
      const limitMB = Math.round(limit / 1024 / 1024);
      const pct = limit > 0 ? Math.round(used / limit * 100) : 0;
      if (el) {
        el.textContent = `Mem: ${usedMB} / ${limitMB} MB (${pct}%)`;
        el.style.color = pct >= 85 ? '#fca5a5' : pct >= 70 ? '#fbbf24' : '#86efac';
      }
      if (pct >= 70) stopDatadogSessionReplay();
      if (pct >= 88 && !state.memoryGuardrailFired) {
        state.memoryGuardrailFired = true;
        state.aborted = true;
        log(`🛑 GUARDRAIL OOM: memoria al ${pct}% del límite — abortando run. ` +
            `Resume está persistido en localStorage; recarga la pestaña y reabre el modal para continuar.`);
      }
    };
    tick();
    memoryGaugeTimer = setInterval(tick, 2000);
  }
  function stopMemoryGauge() {
    if (memoryGaugeTimer) { clearInterval(memoryGaugeTimer); memoryGaugeTimer = null; }
  }

  // ─── Resume en localStorage ───────────────────────────────────────────────
  // Hash simple del CSV (length + primeras 1000 chars) — suficiente para
  // distinguir CSVs distintos sin importar crypto. Si el usuario edita el CSV
  // entre corridas, el hash cambia → no se ofrece resume (corrida limpia).
  function csvHashSimple(txt) {
    const sample = (txt || '').substring(0, 1000) + '|' + (txt?.length || 0);
    let h = 0;
    for (let i = 0; i < sample.length; i++) h = ((h << 5) - h + sample.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }
  function resumeKey() { return state.csvHash ? `sa-audit-resume:${state.csvHash}` : null; }
  function saveResume(audit) {
    const k = resumeKey(); if (!k) return;
    try {
      // Guarda solo lo esencial — sin rawRow ni objetos pesados.
      const slim = audit.map(a => ({
        pnId: a.pnId, archivedAt: a.archivedAt, clienteId: a.clienteId,
        pn: a.part?.pn, rowIdx: a.part?.rowIdx,
        issues: a.issues, complete: a.complete,
      }));
      localStorage.setItem(k, JSON.stringify({ ts: Date.now(), count: slim.length, audit: slim }));
    } catch (e) {
      // QuotaExceeded → limpiar y reintentar una sola vez con resumen reducido.
      try { localStorage.removeItem(k); } catch (_) {}
      log(`⚠️ Resume no guardado (quota): ${String(e?.message || e).substring(0, 80)}`);
    }
  }
  function loadResume() {
    const k = resumeKey(); if (!k) return null;
    try {
      const raw = localStorage.getItem(k); if (!raw) return null;
      const data = JSON.parse(raw);
      if (!Array.isArray(data?.audit)) return null;
      // Rehidratar shape — pero el `part` con rawRow viene del CSV recién parseado
      // (no del resume). Match por rowIdx.
      const byRowIdx = new Map();
      for (const p of state.parts || []) byRowIdx.set(p.rowIdx, p);
      return data.audit
        .map(r => ({
          part: byRowIdx.get(r.rowIdx) || { pn: r.pn, rowIdx: r.rowIdx, rawRow: [] },
          pnId: r.pnId,
          archivedAt: r.archivedAt,
          clienteId: r.clienteId,
          issues: r.issues || [],
          complete: !!r.complete,
        }))
        .filter(r => r.part?.rowIdx != null);
    } catch (_) { return null; }
  }
  function clearResume() {
    const k = resumeKey(); if (!k) return;
    try { localStorage.removeItem(k); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2) CSV PARSER (igual al de bulk-upload — RFC4180 con quoting/escape)
  // ═══════════════════════════════════════════════════════════════════════
  function parseCSV(t) {
    const rows = []; let i = 0;
    // Strip BOM
    if (t.charCodeAt(0) === 0xFEFF) i = 1;
    while (i < t.length) {
      const row = [];
      while (i < t.length) {
        if (t[i] === '"') {
          i++; let v = '';
          while (i < t.length) {
            if (t[i] === '"') {
              if (t[i + 1] === '"') { v += '"'; i += 2; }
              else { i++; break; }
            } else { v += t[i]; i++; }
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

  // ═══════════════════════════════════════════════════════════════════════
  // 3) CSV ROW → PART (replica parseRows de bulk-upload, simplificado)
  // ═══════════════════════════════════════════════════════════════════════
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

  const g = (row, c) => (row[c] || '').trim();
  const gn = (row, c) => {
    const v = (row[c] || '').toString().trim();
    if (!v || v === '-') return null;
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const toBool = (s) => /^(V|TRUE|true|1|verdadero|VERDADERO)$/i.test((s || '').toString().trim());
  const isDash = (v) => v === '-';

  function parseRows(rows) {
    const parts = []; let mode = '';
    for (let r = 0; r < Math.min(rows.length, 3); r++) {
      for (const cell of rows[r] || []) {
        const v = (cell || '').trim().toUpperCase();
        if (v === 'COTIZACIÓN+NP' || v === 'COTIZACION+NP' || v === 'SOLO_PN' || v === 'SOLO PN') {
          mode = v.replace('COTIZACION', 'COTIZACIÓN').replace('SOLO PN', 'SOLO_PN');
          break;
        }
      }
      if (mode) break;
    }
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      const colA = (row[0] || '').trim();
      const colF = (row[5] || '').trim();
      if (colA === 'PARÁMETROS' || colA === 'Archivado' || colA === 'V/F') continue;
      if (colF === 'Texto' || colF.replace(/\s+/g, ' ').toLowerCase() === 'número de parte') continue;

      const pn = g(row, 5);
      if (!pn) continue;
      // Detect header-like rows
      const lowPn = pn.toLowerCase();
      if (lowPn === 'número de parte' || lowPn === 'numero de parte') continue;

      const products = [];
      for (const b of [21, 25, 29]) {
        const nm = g(row, b);
        if (nm) products.push({ name: nm, price: gn(row, b + 1) || 0, qty: gn(row, b + 2) || 1, unit: g(row, b + 3) });
      }

      const specs = [];
      for (const [specIdx] of [[33, 34], [35, 36]]) {
        const raw = g(row, specIdx);
        if (!raw) continue;
        if (raw.includes(' | ')) {
          const s = raw.indexOf(' | ');
          specs.push({ name: raw.substring(0, s).trim(), param: raw.substring(s + 3).trim() });
        } else {
          specs.push({ name: raw, param: '' });
        }
      }

      const racks = [];
      if (g(row, 41)) racks.push({ name: g(row, 41), ppr: gn(row, 42) });
      if (g(row, 43)) racks.push({ name: g(row, 43), ppr: gn(row, 44) });

      const predictiveUsage = [];
      for (const mat of PREDICTIVE_MATERIALS) {
        const raw = g(row, mat.col);
        if (raw === '-') predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: '-', name: mat.name });
        else {
          const val = gn(row, mat.col);
          if (val !== null && val > 0) predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: String(val), name: mat.name });
        }
      }

      parts.push({
        rowIdx: rIdx,
        rawRow: row.slice(), // snapshot para emit CSV
        pn,
        cliente: g(row, 4),
        descripcion: g(row, 6),
        pnAlterno: g(row, 7),
        pnGroup: g(row, 8),
        qty: gn(row, 9),
        precio: gn(row, 10),
        unidadPrecio: g(row, 11).toUpperCase(),
        divisa: (() => { const v = g(row, 12); return (v && v !== '-') ? v.toUpperCase() : 'USD'; })(),
        precioDefault: toBool(g(row, 13)),
        metalBase: g(row, 14),
        labels: [g(row, 15), g(row, 16), g(row, 17), g(row, 18), g(row, 19)].filter(Boolean),
        procesoOverride: g(row, 20),
        products, specs,
        unitConv: { kgm: gn(row, 37), cmk: gn(row, 38), lm: gn(row, 39), minPzasLote: gn(row, 40) },
        racks,
        dims: { length: gn(row, 45), width: gn(row, 46), height: gn(row, 47), outerDiam: gn(row, 48), innerDiam: gn(row, 49) },
        linea: g(row, 50),
        departamento: g(row, 51),
        codigoSAT: g(row, 52),
        archivado: toBool(g(row, 0)),
        validacion1er: toBool(g(row, 1)),
        forzarDuplicado: toBool(g(row, 2)),
        archivarAnterior: toBool(g(row, 3)),
        predictiveUsage,
        quoteIBMS: g(row, 62),
        estacionIBMS: g(row, 63),
        plano: g(row, 64),
        piezasCarga: gn(row, 65),
        cargasHora: g(row, 66),
        tiempoEntrega: gn(row, 67),
        notasAdicionalesPN: g(row, 68),
      });
    }
    return { mode, parts };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4) UI — panel flotante + file picker
  // ═══════════════════════════════════════════════════════════════════════
  const state = {
    aborted: false,
    csvRows: null,
    parts: null,
    mode: '',
    results: null,
    fileName: 'audit',
    memoryGuardrailFired: false,
    csvHash: null, // para resume — identifica el CSV cargado
  };

  function injectCSS() {
    if (document.getElementById('sa-audit-css')) return;
    const s = document.createElement('style'); s.id = 'sa-audit-css';
    s.textContent = `
      .sa-audit-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.55);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-audit-modal{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:24px 28px;max-width:640px;width:92%;max-height:88vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid #1e293b}
      .sa-audit-modal h2{font-size:18px;margin:0 0 14px;color:#38bdf8}
      .sa-audit-modal h3{font-size:14px;margin:14px 0 6px;color:#94a3b8;font-weight:600}
      .sa-audit-row{display:flex;gap:10px;margin-bottom:8px;align-items:center}
      .sa-audit-btn{padding:8px 18px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer}
      .sa-audit-primary{background:#38bdf8;color:#0f172a}
      .sa-audit-secondary{background:#334155;color:#e2e8f0}
      .sa-audit-danger{background:#ef4444;color:#fff}
      .sa-audit-input{padding:6px 10px;border-radius:5px;border:1px solid #334155;background:#020617;color:#e2e8f0;font-size:13px}
      .sa-audit-log{background:#020617;border:1px solid #1e293b;border-radius:6px;padding:8px 10px;font-family:'SF Mono',Menlo,monospace;font-size:11px;max-height:220px;overflow-y:auto;white-space:pre-wrap;color:#cbd5e1}
      .sa-audit-pbar{height:10px;background:#1e293b;border-radius:5px;overflow:hidden;margin:8px 0}
      .sa-audit-pfill{height:100%;background:linear-gradient(90deg,#38bdf8,#0ea5e9);transition:width .2s ease}
      .sa-audit-phase{font-size:13px;color:#fbbf24;margin:6px 0 2px;font-weight:600}
      .sa-audit-sub{font-size:11px;color:#64748b}
      .sa-audit-stat{display:inline-block;background:#1e293b;border-radius:4px;padding:3px 8px;margin:2px 4px 2px 0;font-size:11px}
      .sa-audit-stat-bad{color:#fca5a5}
      .sa-audit-stat-ok{color:#86efac}
    `;
    document.head.appendChild(s);
  }

  function openModal() {
    injectCSS();
    closeModal();
    const ov = document.createElement('div'); ov.className = 'sa-audit-overlay'; ov.id = 'sa-audit-overlay';
    const md = document.createElement('div'); md.className = 'sa-audit-modal';
    md.innerHTML = `
      <h2>🔎 Auditoría de PNs incompletos vs CSV</h2>
      <p style="font-size:12px;color:#94a3b8;margin:0 0 12px">
        Compara los PNs de Steelhead contra el CSV original que se usó en bulk-upload.
        Detecta filas que quedaron sin labels, sin specs, sin racks, sin predictivos, etc.,
        y emite un CSV reducido que puedes recargar para corregir.
      </p>
      <div class="sa-audit-row">
        <label class="sa-audit-btn sa-audit-primary" for="sa-audit-file" style="display:inline-block">📂 Cargar CSV</label>
        <input type="file" id="sa-audit-file" accept=".csv,text/csv" style="display:none">
        <span id="sa-audit-file-name" class="sa-audit-sub">(ningún archivo)</span>
      </div>
      <div class="sa-audit-row">
        <label style="font-size:12px;color:#94a3b8">Límite de filas (0 = todas):</label>
        <input id="sa-audit-limit" class="sa-audit-input" type="number" value="0" min="0" style="width:80px">
        <label style="font-size:12px;color:#94a3b8">Concurrencia:</label>
        <input id="sa-audit-conc" class="sa-audit-input" type="number" value="4" min="1" max="16" style="width:60px">
      </div>
      <div class="sa-audit-row">
        <button class="sa-audit-btn sa-audit-primary" id="sa-audit-start" disabled>▶ Auditar</button>
        <button class="sa-audit-btn sa-audit-danger" id="sa-audit-stop" style="display:none">⏹ Detener</button>
        <button class="sa-audit-btn sa-audit-secondary" id="sa-audit-clear-resume" style="display:none">🗑 Limpiar resume</button>
        <button class="sa-audit-btn sa-audit-secondary" id="sa-audit-close">Cerrar</button>
      </div>
      <div id="sa-audit-progress" style="display:none">
        <div class="sa-audit-phase" id="sa-audit-phase">Esperando...</div>
        <div class="sa-audit-sub" id="sa-audit-sub"></div>
        <div class="sa-audit-pbar"><div class="sa-audit-pfill" id="sa-audit-pfill" style="width:0%"></div></div>
        <div class="sa-audit-sub" id="sa-audit-count"></div>
        <div class="sa-audit-sub" id="sa-audit-mem" style="margin-top:4px;font-weight:600"></div>
      </div>
      <h3>Log</h3>
      <div class="sa-audit-log" id="sa-audit-log"></div>
      <div id="sa-audit-results" style="display:none;margin-top:14px">
        <h3>Resultado</h3>
        <div id="sa-audit-summary"></div>
        <div class="sa-audit-row" style="margin-top:10px">
          <button class="sa-audit-btn sa-audit-primary" id="sa-audit-dl-csv">⬇ Descargar CSV de recuperación</button>
          <button class="sa-audit-btn sa-audit-secondary" id="sa-audit-dl-json">⬇ Descargar reporte JSON</button>
        </div>
      </div>
    `;
    ov.appendChild(md); document.body.appendChild(ov);

    document.getElementById('sa-audit-close').onclick = closeModal;
    document.getElementById('sa-audit-file').onchange = onFile;
    document.getElementById('sa-audit-start').onclick = onStart;
    document.getElementById('sa-audit-stop').onclick = () => { state.aborted = true; log('⛔ Detención solicitada...'); };
    document.getElementById('sa-audit-clear-resume').onclick = () => {
      clearResume();
      document.getElementById('sa-audit-clear-resume').style.display = 'none';
      log('🗑 Resume limpiado. Próximo ▶ Auditar empieza de cero.');
    };
    document.getElementById('sa-audit-dl-csv').onclick = downloadCsv;
    document.getElementById('sa-audit-dl-json').onclick = downloadJson;
  }

  function closeModal() {
    const ov = document.getElementById('sa-audit-overlay');
    if (ov) ov.remove();
  }

  function setPhase(p) { const el = document.getElementById('sa-audit-phase'); if (el) el.textContent = p; }
  function setSub(s) { const el = document.getElementById('sa-audit-sub'); if (el) el.textContent = s; }
  function setProgress(done, total) {
    const f = document.getElementById('sa-audit-pfill'); if (f) f.style.width = (total ? (100 * done / total) : 0) + '%';
    const c = document.getElementById('sa-audit-count'); if (c) c.textContent = `${done} / ${total}`;
  }
  function log(msg) {
    const el = document.getElementById('sa-audit-log'); if (!el) { console.log('[audit]', msg); return; }
    const ts = new Date().toLocaleTimeString();
    el.textContent += `[${ts}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
    console.log('[audit]', msg);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5) FLUJO PRINCIPAL
  // ═══════════════════════════════════════════════════════════════════════
  async function onFile(ev) {
    const f = ev.target.files?.[0];
    if (!f) return;
    state.fileName = f.name.replace(/\.csv$/i, '');
    document.getElementById('sa-audit-file-name').textContent = f.name;
    const txt = await f.text();
    state.csvHash = csvHashSimple(txt);
    state.csvRows = parseCSV(txt);
    const { mode, parts } = parseRows(state.csvRows);
    state.parts = parts;
    state.mode = mode;
    log(`CSV cargado: ${state.csvRows.length} filas brutas, ${parts.length} PNs parseados, modo=${mode || '(sin modo)'}`);
    // Detectar resume disponible para este CSV.
    try {
      const raw = localStorage.getItem(resumeKey());
      if (raw) {
        const d = JSON.parse(raw);
        const ago = Math.round((Date.now() - (d.ts || 0)) / 60000);
        log(`💾 Resume detectado: ${d.count} PNs auditados hace ${ago} min. Click ▶ Auditar para continuar, o "Limpiar resume" para empezar de cero.`);
        document.getElementById('sa-audit-clear-resume').style.display = 'inline-block';
      } else {
        document.getElementById('sa-audit-clear-resume').style.display = 'none';
      }
    } catch (_) {}
    document.getElementById('sa-audit-start').disabled = false;
  }

  async function onStart() {
    if (!state.parts?.length) return;
    const limit = parseInt(document.getElementById('sa-audit-limit').value, 10) || 0;
    const concurrency = parseInt(document.getElementById('sa-audit-conc').value, 10) || 4;
    state.aborted = false;
    state.memoryGuardrailFired = false;
    document.getElementById('sa-audit-progress').style.display = 'block';
    document.getElementById('sa-audit-start').disabled = true;
    document.getElementById('sa-audit-stop').style.display = 'inline-block';
    document.getElementById('sa-audit-results').style.display = 'none';
    stopDatadogSessionReplay();
    startMemoryGauge();
    try {
      await runAudit(limit, concurrency);
    } catch (e) {
      log('❌ Falla: ' + (e.message || e));
    } finally {
      stopMemoryGauge();
      document.getElementById('sa-audit-stop').style.display = 'none';
      document.getElementById('sa-audit-start').disabled = false;
    }
  }

  async function runAudit(limit, concurrency) {
    const allParts = limit > 0 ? state.parts.slice(0, limit) : state.parts;
    log(`Iniciando auditoría de ${allParts.length} filas (concurrency=${concurrency})`);

    // ── 5.1 Resolver clientes ──
    const uniqueClientNames = [...new Set(allParts.map(p => p.cliente.split(/\s*[—–]\s*|\s+[-]\s+/)[0].trim()).filter(Boolean))];
    setPhase(`Resolviendo ${uniqueClientNames.length} clientes`);
    setProgress(0, uniqueClientNames.length);
    const customerByName = new Map(); // nombreCSV → { id, name }
    let cDone = 0;
    for (const cname of uniqueClientNames) {
      if (state.aborted) throw new Error('Detenido');
      setSub('Cliente: ' + cname);
      try {
        const d = await withRetry(() => gql('CustomerSearchByName', { nameLike: `%${cname}%`, orderBy: ['NAME_ASC'] }), 'CustomerSearchByName');
        const nodes = d?.searchCustomers?.nodes || d?.pagedData?.nodes || d?.allCustomers?.nodes || [];
        const match = nodes.find(c => c.name?.toUpperCase().includes(cname.toUpperCase()));
        if (match) customerByName.set(cname, { id: match.id, name: match.name });
        else log(`⚠️  Cliente "${cname}" no encontrado en Steelhead`);
      } catch (e) {
        log(`⚠️  Error resolviendo "${cname}": ${e.message}`);
      }
      cDone++; setProgress(cDone, uniqueClientNames.length);
    }
    log(`Clientes resueltos: ${customerByName.size}/${uniqueClientNames.length}`);
    const customerIds = new Set([...customerByName.values()].map(c => c.id));
    if (!customerIds.size) throw new Error('Ningún cliente resoluble');

    // ── 5.2 Prefetch de catálogos (labels + racks + processes) ──
    setPhase('Cargando catálogos');
    setSub('AllLabels, AllRackTypes, AllProcesses');
    const [labelsD, racksD, processesD] = await Promise.all([
      withRetry(() => gql('AllLabels', { condition: { forPartNumber: true } }), 'AllLabels').catch(() => null),
      withRetry(() => gql('AllRackTypes', {}), 'AllRackTypes').catch(() => null),
      withRetry(() => gql('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: '%%', first: 500 }), 'AllProcesses').catch(() => null),
    ]);
    const labelByName = new Map();
    for (const l of (labelsD?.allLabels?.nodes || [])) labelByName.set(l.name, l.id);
    const rackByName = new Map();
    for (const rt of (racksD?.pagedData?.nodes || racksD?.allRackTypes?.nodes || [])) rackByName.set(rt.name, rt);
    const processByName = new Map();
    for (const pr of (processesD?.pagedData?.nodes || processesD?.allProcesses?.nodes || [])) processByName.set(pr.name, pr);
    log(`Catálogos: ${labelByName.size} labels, ${rackByName.size} racks, ${processByName.size} procesos`);

    // ── 5.3 Lookup por nombre con searchQuery server-side ──
    // 2026-05-23: antes scaneaba TODOS los PNs del dominio (hasta 50k) y filtraba
    // client-side por customerId — ineficiente cuando el CSV cubre 200 PNs de
    // un dominio con 30k. Patrón ahora idéntico a bulk-upload.js:1250-1289:
    // un AllPartNumbers con searchQuery=name por cada (PN, customerId) único,
    // dos pasadas (NO + YES) con dedup por activeIds.
    setPhase('Buscando PNs por nombre (server-side)');
    const pnByKey = new Map(); // `${customerId}|${nameUpper}` → { id, name, customerId, archivedAt }
    const pageSize = 200;

    // Dedup por (pn, customerId) — si el CSV trae el mismo PN 2 veces solo busca 1.
    const lookups = []; // [{ key, name, customerId }]
    const seenLookup = new Set();
    for (const p of allParts) {
      const cust = customerByName.get(p.cliente.split(/\s*[—–]\s*|\s+[-]\s+/)[0].trim());
      if (!cust) continue;
      const key = `${cust.id}|${p.pn.toUpperCase()}`;
      if (seenLookup.has(key)) continue;
      seenLookup.add(key);
      lookups.push({ key, name: p.pn, customerId: cust.id });
    }
    log(`Lookups a ejecutar: ${lookups.length} únicos (de ${allParts.length} filas)`);
    setProgress(0, lookups.length);

    let lookupDone = 0;
    await runPool(lookups, async ({ key, name, customerId }) => {
      if (state.aborted) return;
      setSub(`Buscando: ${name}`);
      const activeIds = new Set();
      let chosen = null; // { id, name, customerId, archivedAt }
      // Pasada 1: activos
      try {
        let offset = 0;
        while (true) {
          if (state.aborted) return;
          const d = await withRetry(
            () => gql('AllPartNumbers', { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: name, includeArchived: 'NO' }),
            `AllPartNumbers (NO) "${name}"`
          );
          const nodes = d?.pagedData?.nodes || [];
          for (const n of nodes) {
            activeIds.add(n.id);
            const cid = n.customerByCustomerId?.id || n.customerId;
            if (cid !== customerId) continue;
            if (!chosen || Number(n.id) > Number(chosen.id)) {
              chosen = { id: n.id, name: n.name, customerId: cid, archivedAt: null };
            }
          }
          if (nodes.length < pageSize) break;
          offset += pageSize;
        }
      } catch (e) { log(`⚠️ AllPartNumbers (NO) "${name}" falló: ${e.message}`); }
      // Pasada 2: archivados — solo si no encontramos activo. El persisted query
      // no expone archivedAt en su selection set; si no estaba en activeIds del
      // step anterior, sintetizamos archivedAt = true.
      if (!chosen) {
        try {
          let offset = 0;
          while (true) {
            if (state.aborted) return;
            const d = await withRetry(
              () => gql('AllPartNumbers', { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: name, includeArchived: 'YES' }),
              `AllPartNumbers (YES) "${name}"`
            );
            const nodes = d?.pagedData?.nodes || [];
            for (const n of nodes) {
              if (activeIds.has(n.id)) continue;
              const cid = n.customerByCustomerId?.id || n.customerId;
              if (cid !== customerId) continue;
              if (!chosen || Number(n.id) > Number(chosen.id)) {
                chosen = { id: n.id, name: n.name, customerId: cid, archivedAt: true };
              }
            }
            if (nodes.length < pageSize) break;
            offset += pageSize;
          }
        } catch (e) { log(`⚠️ AllPartNumbers (YES) "${name}" falló: ${e.message}`); }
      }
      if (chosen) pnByKey.set(key, chosen);
    }, concurrency, (done, total) => { lookupDone = done; setProgress(done, total); });
    log(`Lookups completados: ${pnByKey.size}/${lookups.length} encontrados`);

    // ── 5.4 Resolver pnId por cada fila ──
    setPhase('Resolviendo PNs del CSV');
    const partsWithPn = [];
    const unresolved = [];
    for (const p of allParts) {
      const cust = customerByName.get(p.cliente.split(/\s*[—–]\s*|\s+[-]\s+/)[0].trim());
      if (!cust) { unresolved.push({ part: p, reason: 'cliente no resoluble' }); continue; }
      const key = `${cust.id}|${p.pn.toUpperCase()}`;
      const hit = pnByKey.get(key);
      if (!hit) { unresolved.push({ part: p, reason: 'PN no encontrado en Steelhead' }); continue; }
      partsWithPn.push({ part: p, pnNode: hit, customer: cust });
    }
    log(`Resoluble: ${partsWithPn.length}/${allParts.length} (${unresolved.length} sin match)`);
    // Cleanup: pnByKey ya no se vuelve a usar. Liberar memoria antes de la fase pesada.
    pnByKey.clear();
    if (unresolved.length) {
      const head = unresolved.slice(0, 5).map(u => `${u.part.pn} [${u.part.cliente}] (${u.reason})`).join(', ');
      log(`  Ejemplos sin match: ${head}${unresolved.length > 5 ? `, +${unresolved.length - 5}...` : ''}`);
    }

    // ── 5.5 GetPartNumber + comparación por fila ──
    // Resume: si hay audit previo del mismo CSV, retomamos desde donde quedó.
    const resumed = loadResume();
    const auditedKeys = new Set(); // `${pnId}` ya auditado en resume
    const audit = []; // { part, pnId, archivedAt, issues:[], complete:bool }
    if (resumed?.length) {
      for (const r of resumed) {
        audit.push(r);
        auditedKeys.add(String(r.pnId));
      }
      log(`▶ Resume: retomando con ${resumed.length} PNs ya auditados (de corrida previa).`);
    }
    const pending = partsWithPn.filter(e => !auditedKeys.has(String(e.pnNode.id)));
    setPhase(`Auditando PNs (pool ${concurrency})`);
    setProgress(audit.length, partsWithPn.length);
    log(`Pendientes: ${pending.length} de ${partsWithPn.length} (${audit.length} ya hechos)`);
    let auditDone = audit.length;
    let lastPersist = audit.length;
    await runPool(pending, async (entry) => {
      if (state.aborted) return;
      setSub(`Auditando: ${entry.part.pn}`);
      // Shape mínimo retenido en audit[] — pnNode y customer se liberan al salir
      // de la closure (JS GC) en vez de quedarse retenidos vía spread.
      const result = {
        part: entry.part,
        pnId: entry.pnNode.id,
        archivedAt: entry.pnNode.archivedAt || null,
        clienteId: entry.customer.id,
        issues: [],
        complete: false,
      };
      try {
        const d = await withRetry(() => gql('GetPartNumber', { partNumberId: entry.pnNode.id, usagesLimit: 1, usagesOffset: 0 }), `GetPartNumber ${entry.part.pn}`);
        const pn = d?.partNumberById;
        if (!pn) { result.issues = ['GetPartNumber devolvió null']; audit.push(result); return; }
        result.issues = comparePartNumber(entry.part, pn, { labelByName, rackByName, processByName });
        result.complete = result.issues.length === 0;
        audit.push(result);
      } catch (e) {
        result.issues = ['error fetch: ' + e.message.substring(0, 120)];
        audit.push(result);
      }
    }, concurrency, (done, total) => {
      auditDone = audit.length;
      setProgress(auditDone, partsWithPn.length);
      // Persistir resume cada 50 PNs nuevos auditados.
      if (auditDone - lastPersist >= 50) {
        saveResume(audit);
        lastPersist = auditDone;
      }
    });
    // Persist final.
    saveResume(audit);

    // ── 5.6 Resultados ──
    const incomplete = audit.filter(a => !a.complete);
    state.results = { audit, incomplete, unresolved, allParts, customerByName };

    setPhase(`Auditoría ${state.aborted ? 'detenida' : 'completada'}`);
    setSub(`${audit.length} auditados, ${incomplete.length} incompletos`);
    showResults();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 6) COMPARADOR — CSV row vs PN de Steelhead
  // ═══════════════════════════════════════════════════════════════════════
  function comparePartNumber(csvPart, pn, catalogs) {
    const issues = [];
    const ci = (typeof pn.customInputs === 'string')
      ? (() => { try { return JSON.parse(pn.customInputs); } catch { return null; } })()
      : (pn.customInputs || null);

    // ── Labels ──
    const serverLabels = (pn.partNumberLabelsByPartNumberId?.nodes || [])
      .map(x => x?.labelByLabelId?.name).filter(Boolean);
    const labelsAreDash = csvPart.labels.length === 1 && isDash(csvPart.labels[0]);
    if (csvPart.labels.length && !labelsAreDash) {
      const expected = csvPart.labels.filter(l => !isDash(l));
      const missing = expected.filter(l => !serverLabels.includes(l));
      if (missing.length) issues.push({ field: 'labels', missing, server: serverLabels });
    } else if (labelsAreDash && serverLabels.length) {
      issues.push({ field: 'labels', expectedCleared: true, server: serverLabels });
    }

    // ── Specs (linkeo + param) ──
    const linkedSpecs = (pn.partNumberSpecsByPartNumberId?.nodes || [])
      .filter(s => !s.archivedAt);
    const linkedSpecNames = linkedSpecs.map(s => s?.specBySpecId?.name).filter(Boolean);
    const linkedSpecIds = new Set(linkedSpecs.map(s => s?.specBySpecId?.id).filter(Boolean));
    // Params asignados al PN (de partNumberSpecFieldParamsByPartNumberId)
    const linkedParams = (pn.partNumberSpecFieldParamsByPartNumberId?.nodes || [])
      .filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId);
    const expectedSpecs = csvPart.specs.filter(s => !isDash(s.name));
    for (const cs of expectedSpecs) {
      if (!linkedSpecNames.includes(cs.name)) {
        issues.push({ field: 'spec', spec: cs.name, missing: 'no linkeado' });
        continue;
      }
    }
    // GetPartNumber no devuelve `sfp.specFieldBySpecFieldId.specBySpecId.id`
    // (ese sub-objeto viene vacío), así que no podemos verificar a qué spec
    // pertenece cada param sin un query extra. Fallback: si hay specs esperadas
    // y linkedParams está vacío → bandera global; si hay al menos 1 param,
    // asumimos OK (confianza en que bulk-upload no terminó sin params).
    if (expectedSpecs.length && !linkedParams.length) {
      issues.push({ field: 'specParam', missing: 'PN sin params (esperaba ' + expectedSpecs.length + ' specs)' });
    }

    // ── Racks ──
    const serverRacks = (pn.partNumberRackTypesByPartNumberId?.nodes || [])
      .filter(r => !r.archivedAt)
      .map(r => ({ name: r.rackTypeByRackTypeId?.name || '', ppr: r.partsPerRack }));
    for (const cr of csvPart.racks) {
      if (isDash(cr.name)) continue;
      const hit = serverRacks.find(s => s.name === cr.name);
      if (!hit) { issues.push({ field: 'rack', rack: cr.name, missing: 'no asignado' }); continue; }
      if (cr.ppr != null) {
        const expectedPpr = Math.round(cr.ppr); // CSV puede traer decimales → server redondea
        if (Number(hit.ppr) !== expectedPpr) {
          issues.push({ field: 'rackPpr', rack: cr.name, csv: cr.ppr, server: hit.ppr });
        }
      }
    }

    // ── Predictivos ──
    const serverPred = (pn.predictedInventoryUsagesByPartNumberId?.nodes || [])
      .filter(p => !p.archivedAt);
    const serverPredByItem = new Map();
    for (const sp of serverPred) {
      const itemId = sp.inventoryItemByInventoryItemId?.id || sp.inventoryItemId;
      if (itemId) serverPredByItem.set(String(itemId), sp);
    }
    for (const pu of csvPart.predictiveUsage) {
      const sp = serverPredByItem.get(String(pu.inventoryItemId));
      if (isDash(String(pu.usagePerPart))) {
        if (sp) issues.push({ field: 'predictiveDash', material: pu.name, server: sp.microQuantityPerPart });
      } else {
        const csvVal = parseFloat(pu.usagePerPart);
        if (!sp) { issues.push({ field: 'predictive', material: pu.name, missing: true, csv: csvVal }); continue; }
        const serverVal = (sp.microQuantityPerPart || 0) / 1e6;
        if (Math.abs(serverVal - csvVal) > 1e-6) {
          issues.push({ field: 'predictiveValue', material: pu.name, csv: csvVal, server: serverVal });
        }
      }
    }

    // ── Conversiones de unidad (kgm/cmk/lm/minPzasLote) ──
    const uc = csvPart.unitConv;
    const ii = pn.inventoryItemByPartNumberId || pn.inventoryItemByInventoryItemId || pn.inventoryItem || null;
    const ucs = (ii?.inventoryItemUnitConversionsByInventoryItemId?.nodes
      || ii?.unitConversionsByInventoryItemId?.nodes
      || ii?.unitConversions
      || []);
    const getFactor = (unitId) => {
      const m = ucs.find(x => (x.unitByUnitId?.id || x.unitId) === unitId);
      return m ? Number(m.factor) : null;
    };
    const U = DOMAIN.unitIds || {};
    const checkUC = (key, unitId, expected) => {
      if (expected === null) return;
      const got = getFactor(unitId);
      if (got === null) issues.push({ field: 'unitConv', key, missing: true, csv: expected });
      else if (Math.abs(got - expected) > 1e-4) issues.push({ field: 'unitConv', key, csv: expected, server: got });
    };
    if (uc.kgm !== null && U.KGM) checkUC('kgm', U.KGM, uc.kgm);
    if (uc.cmk !== null && U.CMK) checkUC('cmk', U.CMK, uc.cmk);
    if (uc.lm !== null && U.LM) checkUC('lm', U.LM, uc.lm);
    if (uc.minPzasLote !== null && uc.minPzasLote > 0 && U.LO) {
      const expected = 1 / uc.minPzasLote;
      const got = getFactor(U.LO);
      if (got === null) issues.push({ field: 'unitConv', key: 'minPzasLote', missing: true, csv: uc.minPzasLote });
      else if (Math.abs(got - expected) > 1e-4) issues.push({ field: 'unitConv', key: 'minPzasLote', csv: uc.minPzasLote, server: 1 / got });
    }

    // ── Dimensiones ──
    const dimsExpected = ['length', 'width', 'height', 'outerDiam', 'innerDiam']
      .filter(k => csvPart.dims[k] !== null && !isDash(String(csvPart.dims[k])));
    if (dimsExpected.length) {
      const serverDims = (pn.partNumberDimensionsByPartNumberId?.nodes || [])
        .filter(d => !d.archivedAt);
      if (!serverDims.length) {
        issues.push({ field: 'dims', missing: 'sin dimensiones', expected: dimsExpected });
      }
      // No comparamos por geometryTypeDimensionTypeId aquí — basta saber que hay alguna
    }

    // ── Custom inputs (metalBase, pnAlterno, IBMS, plano, codigoSAT, planificación, notas) ──
    const dCust = ci?.DatosAdicionalesNP || {};
    const dPlan = ci?.DatosPlanificacion || {};
    const dFac = ci?.DatosFacturacion || {};
    // Normaliza whitespace (CRLF dobles, tabs, espacios múltiples) antes de comparar.
    // El server colapsa secuencias de \s+ a un solo espacio en custom inputs.
    const normWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    function checkCI(field, csvVal, serverVal) {
      if (!csvVal) return;
      if (isDash(csvVal)) {
        if (serverVal != null && serverVal !== '') issues.push({ field: 'ci', key: field, expectedCleared: true, server: serverVal });
        return;
      }
      if (normWs(serverVal) !== normWs(csvVal)) issues.push({ field: 'ci', key: field, csv: csvVal, server: serverVal || '' });
    }
    checkCI('metalBase', csvPart.metalBase, dCust.BaseMetal);
    if (csvPart.pnAlterno) {
      if (isDash(csvPart.pnAlterno)) {
        if (Array.isArray(dCust.NumeroParteAlterno) && dCust.NumeroParteAlterno.length) {
          issues.push({ field: 'ci', key: 'pnAlterno', expectedCleared: true, server: dCust.NumeroParteAlterno });
        }
      } else {
        const expectedArr = csvPart.pnAlterno.split(',').map(s => s.trim()).filter(Boolean);
        const serverArr = Array.isArray(dCust.NumeroParteAlterno) ? dCust.NumeroParteAlterno : [];
        const missing = expectedArr.filter(v => !serverArr.includes(v));
        if (missing.length) issues.push({ field: 'ci', key: 'pnAlterno', missing, server: serverArr });
      }
    }
    checkCI('quoteIBMS', csvPart.quoteIBMS, dCust.QuoteIBMS);
    checkCI('estacionIBMS', csvPart.estacionIBMS, dCust.EstacionIBMS);
    checkCI('plano', csvPart.plano, dCust.Plano);
    checkCI('codigoSAT', csvPart.codigoSAT, dFac.CodigoSAT);
    if (csvPart.piezasCarga !== null) {
      const s = dPlan.PiezasCarga; if (s == null || Number(s) !== csvPart.piezasCarga) issues.push({ field: 'ci', key: 'piezasCarga', csv: csvPart.piezasCarga, server: s });
    }
    if (csvPart.cargasHora) checkCI('cargasHora', csvPart.cargasHora, dPlan.CargasHora);
    if (csvPart.tiempoEntrega !== null) {
      const s = dPlan.TiempoEntrega; if (s == null || Number(s) !== csvPart.tiempoEntrega) issues.push({ field: 'ci', key: 'tiempoEntrega', csv: csvPart.tiempoEntrega, server: s });
    }
    if (csvPart.notasAdicionalesPN) checkCI('notasAdicionales', csvPart.notasAdicionalesPN, ci?.NotasAdicionales);

    // ── Descripción ──
    if (csvPart.descripcion) {
      if (isDash(csvPart.descripcion)) {
        if (pn.descriptionMarkdown) issues.push({ field: 'description', expectedCleared: true, server: pn.descriptionMarkdown });
      } else if (normWs(pn.descriptionMarkdown) !== normWs(csvPart.descripcion)) {
        issues.push({ field: 'description', csv: csvPart.descripcion, server: pn.descriptionMarkdown || '' });
      }
    }

    // ── Proceso ──
    if (csvPart.procesoOverride && !isDash(csvPart.procesoOverride)) {
      const expectedProc = catalogs.processByName.get(csvPart.procesoOverride);
      const serverProcId = pn.processNodeByDefaultProcessNodeId?.id || pn.defaultProcessNodeId;
      if (!expectedProc) issues.push({ field: 'process', csv: csvPart.procesoOverride, note: 'no encontrado en catálogo' });
      else if (String(serverProcId) !== String(expectedProc.id)) {
        issues.push({ field: 'process', csv: csvPart.procesoOverride, server: pn.processNodeByDefaultProcessNodeId?.name || serverProcId });
      }
    }

    // ── Precio (existencia y default) ──
    const prices = (pn.partNumberPricesByPartNumberId?.nodes || []).filter(p => !p.archivedAt);
    if (csvPart.precio !== null && !isDash(String(csvPart.precio))) {
      if (!prices.length) issues.push({ field: 'price', missing: 'sin precios' });
      else {
        // priceMicrodollars es el field real (microdólares → dividir entre 1e6).
        // GetPartNumber no devuelve currency (ni `currency` ni `currencyByCurrencyId`),
        // así que el match es solo por valor numérico. La divisa se valida en el loader.
        const priceOf = (p) => {
          if (p.priceMicrodollars != null) return Number(p.priceMicrodollars) / 1e6;
          return Number(p.pricePerUnit || p.price || 0);
        };
        const isDefaultOf = (p) => p.isDefaultPartNumberPrice ?? p.isDefault ?? false;
        const match = prices.find(p => Math.abs(priceOf(p) - csvPart.precio) < 0.01);
        if (!match) issues.push({ field: 'price', csv: { precio: csvPart.precio, divisa: csvPart.divisa }, server: prices.map(p => ({ price: priceOf(p) })) });
        if (csvPart.precioDefault) {
          const hasDefault = prices.some(p => isDefaultOf(p));
          if (!hasDefault) issues.push({ field: 'priceDefault', missing: true });
        }
      }
    }

    return issues;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 7) RESULTADOS + DOWNLOAD
  // ═══════════════════════════════════════════════════════════════════════
  function showResults() {
    const r = state.results; if (!r) return;
    document.getElementById('sa-audit-results').style.display = 'block';
    const ok = r.audit.length - r.incomplete.length;
    // Conteo por tipo de issue
    const counts = {};
    for (const a of r.incomplete) {
      for (const i of a.issues) {
        const key = i.field + (i.key ? `:${i.key}` : '');
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const summary = document.getElementById('sa-audit-summary');
    summary.innerHTML = `
      <div>
        <span class="sa-audit-stat sa-audit-stat-ok">${ok} OK</span>
        <span class="sa-audit-stat sa-audit-stat-bad">${r.incomplete.length} incompletos</span>
        <span class="sa-audit-stat">${r.unresolved.length} no resolubles</span>
      </div>
      <div style="margin-top:8px">
        ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="sa-audit-stat sa-audit-stat-bad">${k}: ${v}</span>`).join('')}
      </div>
    `;
  }

  function csvEsc(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCsv() {
    const r = state.results; if (!r) return;
    const rows = state.csvRows.slice();

    // Preservar primeras 8 filas (header layout V10) + cualquier fila section/header.
    // Estrategia: encontrar el índice de la primera fila de datos en rows (= rowIdx
    // del primer part). Todo lo anterior se preserva tal cual.
    let firstDataRowIdx = 0;
    if (r.audit.length) firstDataRowIdx = r.audit[0].part.rowIdx;
    else if (r.unresolved.length) firstDataRowIdx = r.unresolved[0].part.rowIdx;
    else firstDataRowIdx = 8;

    const headerRows = rows.slice(0, firstDataRowIdx);
    // Filas a emitir: incompletos + unresolved.
    const targets = [
      ...r.incomplete.map(a => a.part),
      ...r.unresolved.map(u => u.part),
    ];
    // Dedup por rowIdx
    const seen = new Set();
    const dataRows = [];
    for (const p of targets) {
      if (seen.has(p.rowIdx)) continue;
      seen.add(p.rowIdx);
      dataRows.push(p.rawRow);
    }

    const out = [...headerRows, ...dataRows];
    const csv = out.map(row => row.map(csvEsc).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    a.href = url; a.download = `recovery_${state.fileName}_${ts}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log(`✅ CSV de recuperación descargado: ${dataRows.length} filas (de ${headerRows.length} cabecera + datos)`);
    // El usuario ya tiene el output — limpiar resume para que la próxima corrida
    // del mismo CSV no arrastre el audit anterior.
    clearResume();
    const btn = document.getElementById('sa-audit-clear-resume');
    if (btn) btn.style.display = 'none';
  }

  function downloadJson() {
    const r = state.results; if (!r) return;
    const report = {
      generatedAt: new Date().toISOString(),
      source: state.fileName,
      totals: {
        audited: r.audit.length,
        complete: r.audit.length - r.incomplete.length,
        incomplete: r.incomplete.length,
        unresolved: r.unresolved.length,
      },
      incomplete: r.incomplete.map(a => ({
        rowIdx: a.part.rowIdx,
        pn: a.part.pn,
        cliente: a.part.cliente,
        pnId: a.pnId,
        archivedAt: a.archivedAt || null,
        issues: a.issues,
      })),
      unresolved: r.unresolved.map(u => ({
        rowIdx: u.part.rowIdx,
        pn: u.part.pn,
        cliente: u.part.cliente,
        reason: u.reason,
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    a.href = url; a.download = `audit_report_${state.fileName}_${ts}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log(`✅ Reporte JSON descargado`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 8) EXPORTAR + ABRIR
  // ═══════════════════════════════════════════════════════════════════════
  window.__SAAuditIncompletePNs = {
    openModal, closeModal,
    parseCSV, parseRows, comparePartNumber,
    PREDICTIVE_MATERIALS,
    get state() { return state; },
    get config() { return config; },
  };
  openModal();
  console.log('[audit] Modal abierto. Para reabrir: window.__SAAuditIncompletePNs.openModal()');
})();
