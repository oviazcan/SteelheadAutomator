// recover-ci-from-snapshot.js
// DevTools tool local — recovery masivo de customInputs blanqueados por
// bulk-upload ≤1.5.8 (bug que pasaba customInputs vacío en MODIFY).
//
// Fuente de verdad: snapshot SH 2026-05-27 (tools/snapshot_ci_2026-05-27.json,
// generado por tools/extract_snapshot_ci.py) — 24,677 PNs, 24,330 con algún
// customInput. Match por Id SH (col 5 del export).
//
// Flujo (3 fases secuenciales en el mismo panel):
//   FASE 1 — Scan + Diff (10-20 min)
//     - Pull SH actual con AllPartNumbers includeArchived: NO, paginated 200.
//     - Streaming-compare cada nodo contra snapshot por id.
//     - Acumula candidates = PNs cuyo snapshot tenía CI y SH actual no.
//     - Descarga `ci_recovery_candidates_<ts>.json` con {idsh, name, missing,
//       snapshotCI, currentCI} de cada candidate.
//
//   FASE 2 — Dry-run recovery
//     - Sobre candidates: GetPartNumber por id (snapshot fresco con labels +
//       dims + group).
//     - Build SavePartNumber input estilo Call A de bulk-upload (heavy
//       fields vacíos, preserve-on-missing en labels/dims/group).
//     - Descarga `ci_recovery_dryrun_<ts>.json` con diffs.
//
//   FASE 3 — Execute
//     - SavePartNumber con runPool=3, gap=80ms, drain Apollo cada 10.
//     - Descarga `ci_recovery_exec_<ts>.json` con resultados.
//     - Pide typear EXEC para confirmar.
//
// Memory hardening (porque 24k PNs es grande):
//   - stopDatadogSessionReplay() al iniciar Fase 1
//   - Apollo cache.reset() cada 5 páginas en Fase 1
//   - SLIM: solo guardar candidates (no todos los 24k nodes)
//   - Mem monitor en panel con guardrail @ 88% → cancela run + persist plan
//
// NO MUTA EN FASE 1 ni FASE 2. Solo FASE 3 con confirm.

(() => {
  if (document.getElementById('sa-recoverci-panel')) {
    document.getElementById('sa-recoverci-panel').remove();
  }

  const HASHES = {
    AllPartNumbers: '65c6de2f9f3cef5ffebba067cb80202b86ef6f32e2d6fda721504fd4bcc6a790',
    GetPartNumber:  '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2',
    SavePartNumber: '27adc1143653e87fbd0c8a763eaa4f3e3a2a6541bbddce47010cdbd1b0365f40',
  };
  const INPUT_SCHEMA_ID_PN = 3456;
  const PAGE_SIZE = 200;
  const DRAIN_EVERY_PAGES = 5;
  const RECOVER_CONCURRENCY = 1;   // retry pass: 1 para evitar HTTP 429
  const RECOVER_GAP_MS = 200;      // retry pass: 200ms entre calls
  const RECOVER_DRAIN_EVERY = 10;
  const GUARDRAIL_PCT = 88;
  const STOP_DD_PCT = 70;

  const state = {
    snapshot: null,        // Map<idsh, {pn, customer, customInputs}>
    snapshotMeta: null,    // {size, withCI}
    candidates: [],        // [{idsh, name, missing:[...], snapshotCI, currentCI}]
    plan: [],              // [{idsh, input, diff, ...}]
    results: [],
    scanning: false,
    running: false,
    cancelled: false,
    memMonitorId: null,
    ddStopped: false,
    guardrailFired: false,
  };

  // ---------- GraphQL helper ----------
  async function gql(op, vars) {
    const body = {
      operationName: op,
      variables: vars,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: HASHES[op] }
      }
    };
    const r = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  }

  // ---------- Memory hardening ----------
  function stopDatadog() {
    if (state.ddStopped) return;
    try {
      const dd = window.DD_RUM;
      if (dd) {
        if (typeof dd.stopSessionReplayRecording === 'function') dd.stopSessionReplayRecording();
        if (typeof dd.stopSession === 'function') dd.stopSession();
      }
      const origFetch = window.fetch;
      if (origFetch && !window.__sa_dd_fetch_patched) {
        window.fetch = function(input, init) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url && url.includes('datadoghq.com')) {
              return Promise.resolve(new Response('', { status: 200 }));
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
        window.__sa_dd_fetch_patched = true;
      }
    } catch (e) {}
    state.ddStopped = true;
  }

  function apolloDrain() {
    try {
      const cli = window.__APOLLO_CLIENT__;
      if (cli && cli.cache && cli.cache.reset) cli.cache.reset();
    } catch (e) {}
  }

  function startMemMonitor() {
    if (state.memMonitorId) return;
    if (!performance.memory) return;
    state.memMonitorId = setInterval(() => {
      const m = performance.memory;
      const pct = (m.usedJSHeapSize / m.jsHeapSizeLimit) * 100;
      const el = document.getElementById('sa-recoverci-mem');
      if (el) el.textContent = `mem ${pct.toFixed(0)}% (${(m.usedJSHeapSize/1048576).toFixed(0)}MB)`;
      if (pct >= STOP_DD_PCT && !state.ddStopped) stopDatadog();
      if (pct >= GUARDRAIL_PCT && !state.guardrailFired) {
        state.guardrailFired = true;
        state.cancelled = true;
        log(`⚠ Guardrail mem ${pct.toFixed(0)}% — cancelando run.`);
        try {
          localStorage.setItem('sa_recoverci_resume', JSON.stringify({
            candidates: state.candidates.slice(0, 5000),
            ts: new Date().toISOString(),
          }));
        } catch (e) {}
      }
    }, 2000);
  }
  function stopMemMonitor() {
    if (state.memMonitorId) { clearInterval(state.memMonitorId); state.memMonitorId = null; }
  }

  // ---------- Snapshot loader ----------
  function loadSnapshot(arr) {
    const map = new Map();
    let withCI = 0;
    for (const r of arr) {
      if (!r.idsh) continue;
      map.set(Number(r.idsh), r);
      if (r.customInputs && Object.keys(r.customInputs).length > 0) withCI++;
    }
    state.snapshot = map;
    state.snapshotMeta = { size: map.size, withCI };
    log(`Snapshot cargado: ${map.size} PNs (${withCI} con algún CI).`);
  }

  // ---------- Diff helpers ----------
  function getCiSummary(ci) {
    if (!ci || typeof ci !== 'object') return {};
    const da = ci.DatosAdicionalesNP || {};
    const df = ci.DatosFacturacion || {};
    const dp = ci.DatosPlanificacion || {};
    return {
      QuoteIBMS: da.QuoteIBMS || ci.QuoteIBMS || null,
      EstacionIBMS: da.EstacionIBMS || ci.EstacionIBMS || null,
      BaseMetal: da.BaseMetal || null,
      Plano: da.Plano || null,
      CodigoSAT: df.CodigoSAT || null,
      PiezasCarga: dp.PiezasCarga ?? dp.PiezasPorCarga ?? null,
      CargasHora: dp.CargasHora ?? dp.CargasPorHora ?? null,
      TiempoEntrega: dp.TiempoEntrega ?? null,
      NotasAdicionales: ci.NotasAdicionales || null,
    };
  }

  function computeMissing(snapCI, currCI) {
    // Devuelve lista de campos que estaban poblados en snapshot pero faltan o
    // están vacíos en SH actual. Solo cuenta campos donde snap tenía valor.
    const s = getCiSummary(snapCI);
    const c = getCiSummary(currCI);
    const missing = [];
    for (const k of Object.keys(s)) {
      const sv = s[k];
      const cv = c[k];
      if (sv && (cv === null || cv === undefined || cv === '')) {
        missing.push(k);
      }
    }
    return missing;
  }

  // ---------- Fase 1: Scan + Diff streaming ----------
  async function fase1Scan() {
    if (!state.snapshot) { log('⚠ Carga primero snapshot JSON.'); return; }
    if (state.scanning || state.running) return;
    state.scanning = true; state.cancelled = false; state.candidates = [];
    state.guardrailFired = false;
    stopDatadog();
    startMemMonitor();

    log('FASE 1: pull SH activos + streaming diff…');
    let offset = 0;
    let scanned = 0;
    let candidatesCount = 0;
    let pageIdx = 0;
    try {
      while (!state.cancelled) {
        const d = await gql('AllPartNumbers', {
          orderBy: ['ID_DESC'], offset, first: PAGE_SIZE, searchQuery: '',
          includeArchived: 'NO',
        });
        const nodes = d?.pagedData?.nodes || [];
        if (!nodes.length) break;
        const total = d?.pagedData?.totalCount || 0;
        for (const n of nodes) {
          scanned++;
          const idsh = Number(n.id);
          const snap = state.snapshot.get(idsh);
          if (!snap) continue;
          const snapCI = snap.customInputs || {};
          if (!Object.keys(snapCI).length) continue;
          let currCI = n.customInputs;
          if (typeof currCI === 'string') {
            try { currCI = JSON.parse(currCI); } catch { currCI = null; }
          }
          currCI = currCI || {};
          const missing = computeMissing(snapCI, currCI);
          if (missing.length) {
            state.candidates.push({
              idsh,
              name: n.name,
              customerId: n.customerByCustomerId?.id || n.customerId || null,
              missing,
              snapshotCI: snapCI,
              currentCI: currCI,
            });
            candidatesCount++;
          }
        }
        pageIdx++;
        if (pageIdx % DRAIN_EVERY_PAGES === 0) apolloDrain();
        document.getElementById('sa-recoverci-progress').textContent =
          `Fase 1: ${scanned}/${total || '?'} scaneados | candidates ${candidatesCount}`;
        await new Promise(r => setTimeout(r, 0));
        if (nodes.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      log(`Fase 1 done: ${scanned} PNs scaneados, ${candidatesCount} candidates.`);
      downloadJSON({
        phase: 'scan',
        generated: new Date().toISOString(),
        snapshotMeta: state.snapshotMeta,
        stats: { scanned, candidates: candidatesCount },
        candidates: state.candidates,
      }, `ci_recovery_candidates_${tsStamp()}.json`);
    } catch (e) {
      log(`❌ Fase 1: ${e.message || e}`);
    } finally {
      state.scanning = false;
      stopMemMonitor();
    }
  }

  // ---------- Fase 2: Dry-run recovery ----------
  function snapshotExistingLabelIds(pn) {
    const out = [];
    for (const ln of (pn.partNumberLabelsByPartNumberId?.nodes || [])) {
      if (ln.archivedAt) continue;
      const id = ln.labelByLabelId?.id; if (id) out.push(id);
    }
    return out;
  }
  function snapshotExistingDimIds(pn) {
    const out = [];
    for (const sel of (pn.acctPnDimensionValueSelectionsByPartNumberId?.nodes || [])) {
      const id = sel.dimensionCustomValueId; if (id) out.push(id);
    }
    return out;
  }

  function mergeCI(currCI, snapCI) {
    // Estrategia: NO sobrescribimos lo que SH actual ya tiene poblado. Solo
    // llenamos huecos con valores del snapshot. Preserva intervenciones
    // posteriores al snapshot.
    const out = currCI && typeof currCI === 'object' ? JSON.parse(JSON.stringify(currCI)) : {};
    const sda = (snapCI && snapCI.DatosAdicionalesNP) || {};
    const sdf = (snapCI && snapCI.DatosFacturacion) || {};
    const sdp = (snapCI && snapCI.DatosPlanificacion) || {};

    const da = out.DatosAdicionalesNP || {};
    for (const k of ['BaseMetal','QuoteIBMS','EstacionIBMS','Plano']) {
      if (!da[k] && sda[k]) da[k] = sda[k];
    }
    if (Object.keys(da).length) out.DatosAdicionalesNP = da;

    if (sdf.CodigoSAT) {
      const df = out.DatosFacturacion || {};
      if (!df.CodigoSAT) df.CodigoSAT = sdf.CodigoSAT;
      out.DatosFacturacion = df;
    }

    const dp = out.DatosPlanificacion || {};
    for (const k of ['PiezasCarga','CargasHora','TiempoEntrega']) {
      const cur = dp[k];
      const snap = sdp[k];
      if ((cur === undefined || cur === null || cur === '') && snap !== undefined && snap !== null && snap !== '') {
        dp[k] = snap;
      }
    }
    if (Object.keys(dp).length) out.DatosPlanificacion = dp;

    if (!out.NotasAdicionales && snapCI.NotasAdicionales) {
      out.NotasAdicionales = snapCI.NotasAdicionales;
    }

    return out;
  }

  function buildSaveInput(pn, snapCI) {
    const labelIds = snapshotExistingLabelIds(pn);
    const dimIds = snapshotExistingDimIds(pn);
    const mergedCI = mergeCI(pn.customInputs || {}, snapCI || {});

    return {
      id: pn.id,
      name: pn.name,
      customerId: pn.customerByCustomerId?.id || pn.customerId || null,
      descriptionMarkdown: pn.descriptionMarkdown || '',
      customerFacingNotes: pn.customerFacingNotes || '',
      customInputs: mergedCI,
      inputSchemaId: INPUT_SCHEMA_ID_PN,
      labelIds,
      partNumberGroupId: pn.partNumberGroupId || null,
      defaultProcessNodeId: pn.defaultProcessNodeId || null,
      geometryTypeId: pn.geometryTypeId || null,
      inventoryItemInput: null,
      inventoryPredictedUsages: [],
      specsToApply: [], paramsToApply: [], partNumberDimensions: [],
      partNumberLocations: [],
      dimensionCustomValueIds: dimIds,
      isCoupon: false, isOneOff: false, isTemplatePartNumber: false,
      optInOuts: [], ownerIds: [], defaults: [],
      partNumberSpecClassificationsToUpdate: [],
      partNumberSpecFieldParamUpdates: [],
      partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
      partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
      specFieldParamUpdates: [],
      glAccountId: null, taxCodeId: null, certPdfTemplateId: null, userFileName: null,
    };
  }

  function diffSummary(before, after) {
    const fields = [];
    const b = getCiSummary(before);
    const a = getCiSummary(after);
    for (const k of Object.keys(a)) {
      if (b[k] !== a[k]) {
        const bv = b[k] === null || b[k] === undefined ? '-' : String(b[k]).slice(0, 20);
        const av = a[k] === null || a[k] === undefined ? '-' : String(a[k]).slice(0, 20);
        fields.push(`${k}:${bv}→${av}`);
      }
    }
    return fields.join(' | ');
  }

  async function fase2Dryrun() {
    if (!state.candidates.length) { log('⚠ Sin candidates. Corre Fase 1 o carga JSON.'); return; }
    if (state.scanning || state.running) return;
    state.running = true; state.cancelled = false; state.plan = [];
    stopDatadog(); startMemMonitor();

    const limitInput = document.getElementById('sa-recoverci-limit');
    const limit = limitInput && limitInput.value ? parseInt(limitInput.value, 10) : null;
    const items = (limit && limit > 0)
      ? state.candidates.slice(0, limit)
      : state.candidates.slice();
    log(`FASE 2: dry-run sobre ${items.length}${limit ? ` (limit ${limit} de ${state.candidates.length})` : ''} candidates…`);
    let done = 0; let drain = 0; let errs = 0;
    const results = await runPool(items, async (cand) => {
      try {
        const d = await gql('GetPartNumber', { partNumberId: cand.idsh });
        const pn = d?.partNumberById;
        if (!pn) { errs++; return { idsh: cand.idsh, name: cand.name, error: 'pn_not_found' }; }
        if (pn.archivedAt) return { idsh: cand.idsh, name: cand.name, status: 'skip_archived' };
        const input = buildSaveInput(pn, cand.snapshotCI);
        const diff = diffSummary(pn.customInputs || {}, input.customInputs || {});
        drain++;
        if (drain % RECOVER_DRAIN_EVERY === 0) apolloDrain();
        return {
          idsh: cand.idsh,
          name: cand.name,
          customerId: input.customerId,
          missing: cand.missing,
          diff,
          input,
          preservedLabelIds: input.labelIds,
          preservedDimIds: input.dimensionCustomValueIds,
          status: 'planned',
        };
      } catch (e) {
        errs++;
        return { idsh: cand.idsh, name: cand.name, error: String(e).slice(0, 200) };
      } finally {
        done++;
        if (done % 50 === 0) {
          document.getElementById('sa-recoverci-progress').textContent =
            `Fase 2: ${done}/${items.length} | errs ${errs}`;
        }
      }
    }, RECOVER_CONCURRENCY);

    state.plan = results.filter(r => r && r.status === 'planned');
    log(`Fase 2 done: planned ${state.plan.length}, errors ${errs}.`);

    // Slim para descarga
    const slim = results.map(r => r && {
      idsh: r.idsh, name: r.name, status: r.status || 'error',
      diff: r.diff, missing: r.missing, error: r.error,
      preservedLabelIds: r.preservedLabelIds, preservedDimIds: r.preservedDimIds,
    });
    downloadJSON({
      phase: 'dry-run',
      generated: new Date().toISOString(),
      stats: { total: items.length, planned: state.plan.length, errors: errs },
      plan: slim,
    }, `ci_recovery_dryrun_${tsStamp()}.json`);
    state.running = false;
    stopMemMonitor();
  }

  // ---------- Fase 3: Exec ----------
  async function fase3Exec() {
    if (!state.plan.length) { log('⚠ Sin plan. Corre Fase 2 primero.'); return; }
    if (state.scanning || state.running) return;
    const confirm = prompt(`Vas a EJECUTAR ${state.plan.length} SavePartNumber. Escribe EXEC:`);
    if (confirm !== 'EXEC') { log('Cancelado.'); return; }
    state.running = true; state.cancelled = false;
    stopDatadog(); startMemMonitor();

    log(`FASE 3: ejecutando ${state.plan.length} SavePartNumber…`);
    let drain = 0; let done = 0;
    const results = await runPool(state.plan, async (item, idx) => {
      try {
        const res = await gql('SavePartNumber', { input: [item.input] });
        const u = (res?.savePartNumbers || [])[0];
        const okId = u?.id || null;
        const ok = String(okId) === String(item.idsh);
        drain++;
        if (drain % RECOVER_DRAIN_EVERY === 0) apolloDrain();
        done++;
        if (done % 25 === 0) {
          document.getElementById('sa-recoverci-progress').textContent =
            `Fase 3: ${done}/${state.plan.length}`;
        }
        return { idsh: item.idsh, name: item.name, ok, diff: item.diff };
      } catch (e) {
        return { idsh: item.idsh, name: item.name, ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    }, RECOVER_CONCURRENCY);

    const okCount = results.filter(r => r.ok).length;
    log(`Fase 3 done: ${okCount}/${results.length} OK.`);
    downloadJSON({
      phase: 'exec',
      generated: new Date().toISOString(),
      stats: { total: results.length, ok: okCount, failed: results.length - okCount },
      results,
    }, `ci_recovery_exec_${tsStamp()}.json`);
    state.running = false;
    stopMemMonitor();
  }

  // ---------- Utilities ----------
  async function runPool(items, fn, conc) {
    const out = [];
    let i = 0;
    async function worker() {
      while (i < items.length && !state.cancelled) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); }
        catch (e) { out[idx] = { error: String(e).slice(0, 200) }; }
        if (RECOVER_GAP_MS) await new Promise(r => setTimeout(r, RECOVER_GAP_MS));
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
    return out;
  }

  function tsStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

  function downloadJSON(obj, name) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function log(msg) {
    const el = document.getElementById('sa-recoverci-log');
    if (el) {
      const ts = new Date().toLocaleTimeString();
      el.textContent = `[${ts}] ${msg}\n` + el.textContent.slice(0, 10000);
    }
    console.log('[recover-ci]', msg);
  }

  // ---------- UI ----------
  const wrap = document.createElement('div');
  wrap.id = 'sa-recoverci-panel';
  wrap.style.cssText = `
    position: fixed; right: 16px; bottom: 16px; width: 460px;
    max-height: 580px; background: #0f172a; color: #e2e8f0;
    font-family: monospace; font-size: 12px; border: 1px solid #334155;
    border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
    padding: 12px; z-index: 99999;
    display: flex; flex-direction: column; gap: 8px;`;
  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong>recover-ci-from-snapshot</strong>
      <span id="sa-recoverci-mem" style="color:#94a3b8;font-size:11px"></span>
      <button id="sa-recoverci-close" style="background:#dc2626;color:white;border:0;padding:2px 8px;cursor:pointer;border-radius:4px;">X</button>
    </div>
    <div>
      <label style="display:block;margin-bottom:4px;">Snapshot JSON (snapshot_ci_2026-05-27.json):</label>
      <input type="file" id="sa-recoverci-snap" accept=".json" style="font-size:11px;color:#e2e8f0;">
      <span id="sa-recoverci-snap-status" style="margin-left:6px;color:#fbbf24;">(no cargado)</span>
    </div>
    <div>
      <label style="display:block;margin-bottom:4px;">(opcional) Candidates JSON ya generado:</label>
      <input type="file" id="sa-recoverci-cand" accept=".json" style="font-size:11px;color:#e2e8f0;">
      <span id="sa-recoverci-cand-status" style="margin-left:6px;color:#94a3b8;">(skip si vas a correr Fase 1)</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <label style="font-size:11px;color:#94a3b8;">Limit Fase 2/3:</label>
      <input id="sa-recoverci-limit" type="number" min="0" placeholder="all" style="width:70px;font-size:11px;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:3px;padding:3px;">
      <span style="font-size:11px;color:#94a3b8;">(vacío = todos)</span>
    </div>
    <div style="display:flex;gap:6px;">
      <button id="sa-recoverci-fase1" style="flex:1;background:#1d4ed8;color:white;border:0;padding:8px;cursor:pointer;border-radius:4px;">Fase 1: Scan</button>
      <button id="sa-recoverci-fase2" style="flex:1;background:#7c3aed;color:white;border:0;padding:8px;cursor:pointer;border-radius:4px;">Fase 2: Dry-run</button>
      <button id="sa-recoverci-fase3" style="flex:1;background:#16a34a;color:white;border:0;padding:8px;cursor:pointer;border-radius:4px;">Fase 3: EXEC</button>
    </div>
    <div id="sa-recoverci-progress" style="font-size:11px;color:#fbbf24;"></div>
    <pre id="sa-recoverci-log" style="background:#020617;padding:8px;border-radius:4px;max-height:260px;overflow:auto;font-size:11px;margin:0;white-space:pre-wrap;"></pre>
  `;
  document.body.appendChild(wrap);

  document.getElementById('sa-recoverci-close').onclick = () => {
    stopMemMonitor();
    wrap.remove();
  };

  document.getElementById('sa-recoverci-snap').onchange = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const arr = JSON.parse(r.result);
        loadSnapshot(arr);
        document.getElementById('sa-recoverci-snap-status').textContent =
          `OK (${state.snapshot.size} PNs, ${state.snapshotMeta.withCI} con CI)`;
        document.getElementById('sa-recoverci-snap-status').style.color = '#10b981';
      } catch (err) { log(`❌ snapshot parse: ${err.message}`); }
    };
    r.readAsText(f);
  };

  document.getElementById('sa-recoverci-cand').onchange = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result);
        const arr = Array.isArray(j) ? j : (j.candidates || []);
        state.candidates = arr;
        document.getElementById('sa-recoverci-cand-status').textContent =
          `OK (${arr.length} candidates)`;
        document.getElementById('sa-recoverci-cand-status').style.color = '#10b981';
        log(`Candidates cargados: ${arr.length}`);
      } catch (err) { log(`❌ cand parse: ${err.message}`); }
    };
    r.readAsText(f);
  };

  document.getElementById('sa-recoverci-fase1').onclick = fase1Scan;
  document.getElementById('sa-recoverci-fase2').onclick = fase2Dryrun;
  document.getElementById('sa-recoverci-fase3').onclick = fase3Exec;

  log('Panel listo. Carga snapshot y corre Fase 1 (o carga candidates y salta a Fase 2).');
})();
