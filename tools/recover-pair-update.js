// recover-pair-update.js
// DevTools applet local (NO se publica) — Opción C STEP 1 de recovery 02:03.
//
// Contexto:
//   - bulk-upload 1.5.10 (run 139b77b8 02:03 con quote 197 lockeada) creó 27
//     NEW Pase 3 blanqueados. Cada uno tiene una pareja vieja (idsh distinto,
//     mismo PN+customer) con labels=L4 (Decapado+Plata+Antitarnish+SRG) y
//     metalBase=Cobre — pero SIN QuoteIBMS nuevo y sin codigoSAT/notas del
//     CSV de mayo 2026.
//   - Decisión: recovery primero sobre la pareja vieja → archive después los
//     27 newest. Si recovery falla, NO archivar (queda un pair populado activo
//     usable).
//
// Qué hace este script:
//   1. Carga un JSON tipo `archive_orphan_dryrun_*.json` (input A) — para
//      obtener bestPair.id por PN (ranking real con labels reales).
//   2. Carga `27_recovery_payload.json` (input B) — datos del CSV (IBMS,
//      EstacionIBMS, codigoSAT, notas, tiempoEntrega, piezasPorCarga,
//      cargasPorHora, metalBase).
//   3. Por cada PN: hace GetPartNumber(bestPair.id) para snapshot fresco.
//   4. Construye SavePartNumber input estilo Call A (identifier-enrich) de
//      bulk-upload — heavy fields vacíos, preserve-on-missing en labels/dims/
//      partNumberGroupId, customInputs mergeado (existing + CSV).
//   5. Modo:
//        - 'dry-run' (default): genera plan + descarga JSON, no muta.
//        - 'exec': dispara SavePartNumber con runPool=3 + drain Apollo cada 10.
//   6. Output: JSON con plan/resultados.
//
// NO MUTA EN DRY-RUN. En exec, llama SavePartNumber sólo si typas EXEC en el
// confirm del panel. Pool bajo (3) para no disparar 403.
//
// Cómo correr:
//   1. Steelhead → DevTools → Console.
//   2. Pegar y enter.
//   3. Click "Cargar dryrun JSON" → seleccionar archive_orphan_dryrun_*.json
//   4. Click "Cargar recovery payload" → seleccionar tools/27_recovery_payload.json
//   5. Click "DRY-RUN" → revisar JSON descargado.
//   6. (Opcional) Click "EJECUTAR" → confirmar typeo EXEC.

(() => {
  if (document.getElementById('sa-recover-pair-panel')) {
    document.getElementById('sa-recover-pair-panel').remove();
  }

  const HASHES = {
    SavePartNumber: '27adc1143653e87fbd0c8a763eaa4f3e3a2a6541bbddce47010cdbd1b0365f40',
    GetPartNumber:  '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2',
  };

  const INPUT_SCHEMA_ID_PN = 3456;
  const CONCURRENCY = 3;
  const GAP_MS = 80;
  const DRAIN_EVERY = 10;

  const state = {
    dryrunJson: null,
    payloadJson: null,
    plan: [],
    results: [],
    running: false,
    mode: 'dry-run',
  };

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
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  function apolloDrain() {
    try {
      const cli = window.__APOLLO_CLIENT__;
      if (cli && cli.cache) { cli.cache.reset(); }
    } catch (e) {}
  }

  function mergeCustomInputs(existing, csv) {
    const ci = (existing && typeof existing === 'object') ? JSON.parse(JSON.stringify(existing)) : {};
    if (csv.quoteIBMS) ci.QuoteIBMS = String(csv.quoteIBMS);
    if (csv.estacionIBMS) ci.EstacionIBMS = String(csv.estacionIBMS);

    const adic = ci.DatosAdicionalesNP || {};
    if (csv.metalBase) adic.BaseMetal = csv.metalBase;
    if (csv.plano) adic.Plano = csv.plano;
    if (Object.keys(adic).length) ci.DatosAdicionalesNP = adic;

    if (csv.codigoSAT) {
      const fact = ci.DatosFacturacion || {};
      fact.CodigoSAT = csv.codigoSAT;
      ci.DatosFacturacion = fact;
    }

    const plan = ci.DatosPlanificacion || {};
    if (csv.piezasPorCarga != null && csv.piezasPorCarga !== '') {
      const n = Number(csv.piezasPorCarga);
      if (Number.isFinite(n)) plan.PiezasPorCarga = n;
    }
    if (csv.cargasPorHora != null && csv.cargasPorHora !== '') {
      const n = Number(csv.cargasPorHora);
      if (Number.isFinite(n)) plan.CargasPorHora = n;
    }
    if (csv.tiempoEntrega != null && csv.tiempoEntrega !== '') {
      const n = Number(csv.tiempoEntrega);
      if (Number.isFinite(n)) plan.TiempoEntrega = n;
      else plan.TiempoEntrega = csv.tiempoEntrega;
    }
    if (Object.keys(plan).length) ci.DatosPlanificacion = plan;

    if (csv.notas) ci.NotasAdicionales = csv.notas;

    return ci;
  }

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

  function buildSaveInput(pn, csv) {
    const labelIds = snapshotExistingLabelIds(pn);
    const dimIds = snapshotExistingDimIds(pn);
    const mergedCI = mergeCustomInputs(pn.customInputs, csv);

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
      specsToApply: [],
      paramsToApply: [],
      partNumberDimensions: [],
      partNumberLocations: [],
      dimensionCustomValueIds: dimIds,
      isCoupon: false,
      isOneOff: false,
      isTemplatePartNumber: false,
      optInOuts: [],
      ownerIds: [],
      defaults: [],
      partNumberSpecClassificationsToUpdate: [],
      partNumberSpecFieldParamUpdates: [],
      partNumberSpecFieldParamsToArchive: [],
      partNumberSpecFieldParamsToUnarchive: [],
      partNumberSpecsToArchive: [],
      partNumberSpecsToUnarchive: [],
      specFieldParamUpdates: [],
      glAccountId: null,
      taxCodeId: null,
      certPdfTemplateId: null,
      userFileName: null,
    };
  }

  function diffSummary(before, after) {
    const fields = [];
    const ibmsB = before?.QuoteIBMS; const ibmsA = after?.QuoteIBMS;
    if (ibmsB !== ibmsA) fields.push(`QuoteIBMS:${ibmsB||'-'}→${ibmsA||'-'}`);
    const estB = before?.EstacionIBMS; const estA = after?.EstacionIBMS;
    if (estB !== estA) fields.push(`EstIBMS:${estB||'-'}→${estA||'-'}`);
    const bmB = before?.DatosAdicionalesNP?.BaseMetal;
    const bmA = after?.DatosAdicionalesNP?.BaseMetal;
    if (bmB !== bmA) fields.push(`Metal:${bmB||'-'}→${bmA||'-'}`);
    const satB = before?.DatosFacturacion?.CodigoSAT;
    const satA = after?.DatosFacturacion?.CodigoSAT;
    if (satB !== satA) fields.push(`SAT:${satB?'set':'-'}→${satA?'set':'-'}`);
    const nB = before?.NotasAdicionales;
    const nA = after?.NotasAdicionales;
    if (nB !== nA) fields.push(`Notas:${nB?'set':'-'}→${nA?'set':'-'}`);
    return fields.join(' | ');
  }

  async function runPool(items, fn, conc) {
    const out = [];
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: String(e).slice(0, 300) };
        }
        await new Promise(r => setTimeout(r, GAP_MS));
      }
    }
    const workers = Array.from({ length: Math.min(conc, items.length) }, worker);
    await Promise.all(workers);
    return out;
  }

  function downloadJSON(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function log(msg) {
    const el = document.getElementById('sa-recover-pair-log');
    if (el) {
      const ts = new Date().toLocaleTimeString();
      el.textContent = `[${ts}] ${msg}\n` + el.textContent;
    }
    console.log('[recover-pair]', msg);
  }

  async function buildPlan() {
    if (!state.dryrunJson || !state.payloadJson) {
      throw new Error('Carga primero los 2 JSONs (dryrun + payload).');
    }
    const dryPlan = state.dryrunJson.plan || [];
    const payload = state.payloadJson || [];
    const byPn = new Map();
    for (const r of payload) byPn.set(r.pn, r);

    const items = [];
    for (const entry of dryPlan) {
      const pn = entry.pn;
      const pair = entry.bestPair;
      const csv = byPn.get(pn);
      if (!pair || !pair.id) {
        items.push({ pn, status: 'skip_no_pair' });
        continue;
      }
      if (!csv) {
        items.push({ pn, status: 'skip_no_csv', pairId: pair.id });
        continue;
      }
      items.push({ pn, pairId: pair.id, csv, status: 'pending' });
    }
    log(`Plan inicial: ${items.length} items (${items.filter(i=>i.status==='pending').length} a procesar).`);
    return items;
  }

  async function fetchSnapshotsAndDiff(items) {
    let drainCount = 0;
    const results = await runPool(items.filter(i=>i.status==='pending'), async (item) => {
      const data = await gql('GetPartNumber', { partNumberId: item.pairId });
      const pn = data?.partNumberById;
      if (!pn) return { ...item, status: 'error_no_pn' };
      if (pn.archivedAt) return { ...item, status: 'skip_pair_archived' };
      const input = buildSaveInput(pn, item.csv);
      const diff = diffSummary(pn.customInputs || {}, input.customInputs || {});
      drainCount++;
      if (drainCount % DRAIN_EVERY === 0) apolloDrain();
      return {
        pn: item.pn,
        pairId: item.pairId,
        existingCI: pn.customInputs || {},
        newCI: input.customInputs,
        preservedLabelIds: input.labelIds,
        preservedDimIds: input.dimensionCustomValueIds,
        customerId: input.customerId,
        diff,
        input,
        status: 'planned',
      };
    }, CONCURRENCY);
    return results;
  }

  async function executeUpdates(planned) {
    let drainCount = 0;
    return await runPool(planned, async (item, idx) => {
      try {
        const res = await gql('SavePartNumber', { input: [item.input] });
        const updated = (res?.savePartNumbers || [])[0];
        const okId = updated?.id || null;
        drainCount++;
        if (drainCount % DRAIN_EVERY === 0) apolloDrain();
        const ts = new Date().toISOString();
        const ok = okId === item.pairId || String(okId) === String(item.pairId);
        log(`[${idx+1}/${planned.length}] ${item.pn} (${item.pairId}) → ${ok?'OK':'?'} ${item.diff||''}`);
        return { pn: item.pn, pairId: item.pairId, okId, ok, diff: item.diff, ts };
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        log(`[${idx+1}/${planned.length}] ${item.pn} (${item.pairId}) → ERROR ${msg}`);
        return { pn: item.pn, pairId: item.pairId, ok: false, error: msg };
      }
    }, CONCURRENCY);
  }

  async function actionDryRun() {
    if (state.running) return;
    state.running = true;
    try {
      const items = await buildPlan();
      log('Fetching snapshots de bestPair…');
      const planned = await fetchSnapshotsAndDiff(items);
      const okCount = planned.filter(p=>p.status==='planned').length;
      log(`✅ Plan listo: ${okCount}/${planned.length} a actualizar.`);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // Slim: NO incluir input completo en download (es muy verboso). El input
      // se mantiene en memoria (state.plan) y se usa en EXEC.
      state.plan = planned;
      const slim = planned.map(p => ({
        pn: p.pn,
        pairId: p.pairId,
        status: p.status,
        diff: p.diff,
        existingCI: p.existingCI,
        newCI: p.newCI,
        preservedLabelIds: p.preservedLabelIds,
        preservedDimIds: p.preservedDimIds,
      }));
      downloadJSON({
        mode: 'dry-run',
        generated: new Date().toISOString(),
        stats: {
          total: items.length,
          planned: okCount,
          skipNoPair: items.filter(i=>i.status==='skip_no_pair').length,
          skipNoCsv: items.filter(i=>i.status==='skip_no_csv').length,
        },
        plan: slim,
      }, `recover_pair_dryrun_${ts}.json`);
      log(`📥 Descargado recover_pair_dryrun_${ts}.json`);
    } catch (e) {
      log(`❌ ${e.message || e}`);
    } finally {
      state.running = false;
    }
  }

  async function actionExec() {
    if (state.running) return;
    if (!state.plan || !state.plan.length) {
      log('Corre DRY-RUN primero (el plan se mantiene en memoria).');
      return;
    }
    const planned = state.plan.filter(p => p.status === 'planned');
    if (!planned.length) {
      log('Sin items planned para ejecutar.');
      return;
    }
    const confirm = prompt(`Vas a EJECUTAR ${planned.length} SavePartNumber. Escribe EXEC para confirmar:`);
    if (confirm !== 'EXEC') {
      log('Cancelado (no escribiste EXEC).');
      return;
    }
    state.running = true;
    try {
      log(`Ejecutando ${planned.length} SavePartNumber con concurrency=${CONCURRENCY}…`);
      const results = await executeUpdates(planned);
      const okCount = results.filter(r=>r.ok).length;
      log(`✅ Done: ${okCount}/${planned.length} OK.`);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      downloadJSON({
        mode: 'exec',
        generated: new Date().toISOString(),
        stats: { total: planned.length, ok: okCount, failed: planned.length - okCount },
        results,
      }, `recover_pair_exec_${ts}.json`);
      log(`📥 Descargado recover_pair_exec_${ts}.json`);
    } catch (e) {
      log(`❌ ${e.message || e}`);
    } finally {
      state.running = false;
    }
  }

  function showPanel() {
    const wrap = document.createElement('div');
    wrap.id = 'sa-recover-pair-panel';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;width:420px;max-height:520px;background:#0f172a;color:#e2e8f0;font-family:monospace;font-size:12px;border:1px solid #334155;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:12px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>recover-pair-update (Opción C STEP 1)</strong>
        <button id="sa-recover-pair-close" style="background:#dc2626;color:white;border:0;padding:2px 8px;cursor:pointer;border-radius:4px;">X</button>
      </div>
      <div>
        <label style="display:block;margin-bottom:4px;">1. archive_orphan_dryrun_*.json:</label>
        <input type="file" id="sa-rp-dryrun" accept=".json" style="font-size:11px;color:#e2e8f0;">
        <span id="sa-rp-dryrun-status" style="margin-left:6px;color:#fbbf24;">(no cargado)</span>
      </div>
      <div>
        <label style="display:block;margin-bottom:4px;">2. 27_recovery_payload.json:</label>
        <input type="file" id="sa-rp-payload" accept=".json" style="font-size:11px;color:#e2e8f0;">
        <span id="sa-rp-payload-status" style="margin-left:6px;color:#fbbf24;">(no cargado)</span>
      </div>
      <div style="display:flex;gap:6px;">
        <button id="sa-rp-dryrun-btn" style="flex:1;background:#1d4ed8;color:white;border:0;padding:8px;cursor:pointer;border-radius:4px;">DRY-RUN</button>
        <button id="sa-rp-exec-btn" style="flex:1;background:#16a34a;color:white;border:0;padding:8px;cursor:pointer;border-radius:4px;">EJECUTAR</button>
      </div>
      <pre id="sa-recover-pair-log" style="background:#020617;padding:8px;border-radius:4px;max-height:260px;overflow:auto;font-size:11px;margin:0;white-space:pre-wrap;"></pre>
    `;
    document.body.appendChild(wrap);

    document.getElementById('sa-recover-pair-close').onclick = () => wrap.remove();

    document.getElementById('sa-rp-dryrun').onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          state.dryrunJson = JSON.parse(r.result);
          document.getElementById('sa-rp-dryrun-status').textContent = `OK (${state.dryrunJson.plan?.length||0} items)`;
          document.getElementById('sa-rp-dryrun-status').style.color = '#10b981';
        } catch (err) {
          log(`❌ dryrun parse: ${err.message}`);
        }
      };
      r.readAsText(f);
    };

    document.getElementById('sa-rp-payload').onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          state.payloadJson = JSON.parse(r.result);
          document.getElementById('sa-rp-payload-status').textContent = `OK (${state.payloadJson.length} PNs)`;
          document.getElementById('sa-rp-payload-status').style.color = '#10b981';
        } catch (err) {
          log(`❌ payload parse: ${err.message}`);
        }
      };
      r.readAsText(f);
    };

    document.getElementById('sa-rp-dryrun-btn').onclick = actionDryRun;
    document.getElementById('sa-rp-exec-btn').onclick = actionExec;
  }

  showPanel();
  log('Panel listo. Carga los 2 JSONs y corre DRY-RUN.');
})();
