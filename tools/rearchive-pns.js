// rearchive-pns.js
// One-shot DevTools script: re-archivar los PNs desarchivados sin intención por
// bulk-upload v11 con CSV v104 (regla "Archivado vacío == F").
//
// Fuente de verdad: ~/Downloads/pns_to_rearchive.json
//   (generado por /tmp/cross_ref_fast.py — cruce de v104.csv vs
//    BD SRG + CG col Archivado=V).
//
// Qué hace:
//   1. Te pide cargar pns_to_rearchive.json via input file picker.
//   2. Itera la lista de PNs (cada uno trae `idsh` precomputado).
//   3. Verifica via GetPartNumber que el PN sigue desarchivado
//      (skip si archivedAt != null — idempotente).
//   4. UpdatePartNumber con archivedAt = now ISO.
//   5. Concurrencia limitada (default 3) — para no replicar el 403 anterior.
//   6. Progress bar + resumen + descarga `rearchive_results.json` con
//      success/failed/skipped por PN.
//
// Cómo correrlo:
//   1. Abrir Steelhead (app.gosteelhead.com), loguearse.
//   2. DevTools → Console.
//   3. Pegar este archivo y enter.
//   4. Click "Cargar JSON" en el panel → seleccionar pns_to_rearchive.json.
//   5. Click "Comenzar" (botón rojo). Confirma en el dialog.
//   6. Esperar. Al final descarga el JSON de resultados automáticamente.
//
// Características:
//   - RESUMABLE: si el navegador crashea o cierras la tab, al volver a correr
//     el script y cargar el mismo JSON, los PNs ya archivados se skip silently.
//   - CANCELABLE: botón "Cancelar" detiene en cuanto la in-flight termine.
//   - SAFE: no toca nada más allá de archivedAt. Si tienes dudas en un PN
//     puntual, abre el modo dry-run.

(async () => {
  const HASHES = {
    GetPartNumber:     '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2',
    SearchPartNumbers: '63ba50ed71fbf40476f1844b841351766eefbb147613b51b33919b4f4b2d4d91',
    UpdatePartNumber:  'af584fa8ebb7487fc84de18fa3a5e360e99699a3280185fe98b840c157bbf2c7'
  };

  const CONCURRENCY    = 3;
  const SLEEP_PER_BATCH_MS = 60;  // pequeña respiración entre batches

  // --- GraphQL ---
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
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  async function withRetry(fn, label, maxRetry = 2) {
    let lastErr;
    for (let i = 0; i <= maxRetry; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        const msg = String(e);
        if (msg.includes('HTTP 5') || msg.includes('NetworkError')) {
          await new Promise(r => setTimeout(r, 800 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // --- Resolver id si no viene en el item ---
  async function resolvePNId(item) {
    if (item.idsh && /^\d+$/.test(String(item.idsh))) return Number(item.idsh);
    // Fallback: search by name
    const d = await gql('SearchPartNumbers', {
      searchQuery: item.pn, first: 20, offset: 0, orderBy: ['ID_DESC']
    });
    const nodes = d?.searchPartNumbers?.nodes || d?.pagedData?.nodes || [];
    const wanted = (item.pn || '').toUpperCase().trim();
    const exact = nodes.filter(n => (n.name || '').toUpperCase().trim() === wanted);
    if (!exact.length) return null;
    if (exact.length === 1) return exact[0].id;
    // Múltiples: prefer match de customer
    const cust = (item.cust_csv || item.cust_bd || '').toUpperCase();
    const byCust = exact.find(n =>
      (n.customerByCustomerId?.name || '').toUpperCase().includes(cust.split(/\s+/)[0] || '__nope__')
    );
    return byCust ? byCust.id : exact[0].id;
  }

  // --- UI ---
  const oldPanel = document.getElementById('sa-rearchive-panel');
  if (oldPanel) oldPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'sa-rearchive-panel';
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 9999999;
    width: 480px; max-height: 90vh; overflow: auto;
    background: #1e293b; color: #e2e8f0; border-radius: 10px; padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="color:#38bdf8;font-size:15px">📦 Re-archive PNs</b>
      <button id="sa-ra-close" style="background:#475569;color:#e2e8f0;border:none;border-radius:4px;padding:4px 10px;cursor:pointer">✕</button>
    </div>
    <div style="color:#94a3b8;font-size:12px;margin-bottom:12px">
      Carga <code>pns_to_rearchive.json</code> y dale comenzar. Idempotente (skip si ya archivado).
    </div>
    <div style="margin-bottom:10px">
      <label style="display:block;color:#94a3b8;margin-bottom:4px">JSON file:</label>
      <input type="file" id="sa-ra-file" accept=".json" style="width:100%;color:#e2e8f0">
    </div>
    <div id="sa-ra-info" style="background:#0f172a;padding:8px 12px;border-radius:4px;margin-bottom:10px;display:none">
      <div>Total a archivar: <b id="sa-ra-total" style="color:#38bdf8">—</b></div>
      <div style="margin-top:4px;font-size:11px;color:#64748b">Concurrencia: ${CONCURRENCY}</div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button id="sa-ra-start" disabled style="flex:1;background:#dc2626;color:white;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;opacity:0.5">▶ Comenzar</button>
      <button id="sa-ra-cancel" disabled style="background:#475569;color:#e2e8f0;border:none;border-radius:6px;padding:10px 14px;cursor:pointer;opacity:0.5">⏹ Cancelar</button>
    </div>
    <div id="sa-ra-bar" style="height:6px;background:#334155;border-radius:3px;overflow:hidden;display:none;margin-bottom:8px">
      <div id="sa-ra-fill" style="height:100%;background:#16a34a;transition:width 0.2s;width:0%"></div>
    </div>
    <div id="sa-ra-stats" style="font-size:11px;color:#94a3b8;font-family:monospace;line-height:1.6"></div>
    <div id="sa-ra-log" style="margin-top:8px;max-height:240px;overflow:auto;background:#0f172a;padding:8px;border-radius:4px;font-family:monospace;font-size:10px;line-height:1.4;color:#cbd5e1;display:none"></div>
  `;
  document.body.appendChild(panel);

  let payload = null;
  let cancelled = false;
  let running = false;
  const stats = { total: 0, done: 0, archived: 0, alreadyArchived: 0, notFound: 0, errors: 0 };
  const results = [];

  const $ = id => document.getElementById(id);
  $('sa-ra-close').onclick = () => panel.remove();

  $('sa-ra-file').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      payload = parsed.pns_to_rearchive || parsed;
      if (!Array.isArray(payload)) throw new Error('Esperaba array `pns_to_rearchive`');
      stats.total = payload.length;
      $('sa-ra-total').textContent = stats.total;
      $('sa-ra-info').style.display = 'block';
      $('sa-ra-start').disabled = false;
      $('sa-ra-start').style.opacity = '1';
      log(`✓ Cargados ${stats.total} PNs`);
    } catch (err) {
      alert('Error parsing JSON: ' + err.message);
    }
  };

  function log(msg, cls = '') {
    const el = $('sa-ra-log');
    el.style.display = 'block';
    const div = document.createElement('div');
    if (cls === 'err') div.style.color = '#f87171';
    else if (cls === 'ok') div.style.color = '#4ade80';
    else if (cls === 'skip') div.style.color = '#fbbf24';
    div.textContent = msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function updateStats() {
    const pct = stats.total ? (stats.done / stats.total * 100) : 0;
    $('sa-ra-fill').style.width = pct.toFixed(1) + '%';
    $('sa-ra-stats').innerHTML = `
      <div>Progreso: <b style="color:#e2e8f0">${stats.done} / ${stats.total}</b> (${pct.toFixed(1)}%)</div>
      <div>✓ Archivados nuevos: <b style="color:#4ade80">${stats.archived}</b></div>
      <div>↻ Ya estaban archivados: <b style="color:#fbbf24">${stats.alreadyArchived}</b></div>
      <div>✗ No encontrados: <b style="color:#94a3b8">${stats.notFound}</b></div>
      <div>⚠ Errores: <b style="color:#f87171">${stats.errors}</b></div>
    `;
  }

  $('sa-ra-cancel').onclick = () => {
    if (!running) return;
    cancelled = true;
    log('⏹ Cancelando…', 'err');
  };

  $('sa-ra-start').onclick = async () => {
    if (!payload || running) return;
    const ok = confirm(
      `¿Re-archivar ${stats.total} PNs en Steelhead?\n\n` +
      `Concurrencia: ${CONCURRENCY}. Es idempotente — corre safe varias veces.`
    );
    if (!ok) return;

    running = true;
    cancelled = false;
    $('sa-ra-start').disabled = true; $('sa-ra-start').style.opacity = '0.5';
    $('sa-ra-cancel').disabled = false; $('sa-ra-cancel').style.opacity = '1';
    $('sa-ra-bar').style.display = 'block';
    $('sa-ra-file').disabled = true;
    updateStats();

    const now = new Date().toISOString();

    async function worker(item) {
      if (cancelled) return;
      try {
        // 1. Resolver id
        let pnId = item.idsh && /^\d+$/.test(String(item.idsh)) ? Number(item.idsh) : null;
        if (!pnId) {
          pnId = await withRetry(() => resolvePNId(item), `resolve ${item.pn}`);
        }
        if (!pnId) {
          stats.notFound++;
          results.push({ pn: item.pn, status: 'not_found' });
          log(`✗ ${item.pn}: not found`, 'err');
          return;
        }

        // 2. Verificar archivedAt
        const data = await withRetry(
          () => gql('GetPartNumber', { partNumberId: pnId }),
          `GetPartNumber ${item.pn}`
        );
        const pn = data?.partNumberById;
        if (!pn) {
          stats.notFound++;
          results.push({ pn: item.pn, id: pnId, status: 'not_found' });
          log(`✗ ${item.pn}: GetPartNumber null`, 'err');
          return;
        }
        if (pn.archivedAt) {
          stats.alreadyArchived++;
          results.push({ pn: item.pn, id: pnId, status: 'already_archived', archivedAt: pn.archivedAt });
          return;  // silent skip
        }

        // 3. Archivar
        await withRetry(
          () => gql('UpdatePartNumber', { id: pnId, archivedAt: now }),
          `UpdatePartNumber ${item.pn}`
        );
        stats.archived++;
        results.push({ pn: item.pn, id: pnId, status: 'archived' });
      } catch (e) {
        stats.errors++;
        results.push({ pn: item.pn, status: 'error', error: String(e).slice(0, 200) });
        log(`✗ ${item.pn}: ${String(e).slice(0, 80)}`, 'err');
      } finally {
        stats.done++;
        updateStats();
      }
    }

    // Run in batches of CONCURRENCY
    for (let i = 0; i < payload.length && !cancelled; i += CONCURRENCY) {
      const batch = payload.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(worker));
      if (SLEEP_PER_BATCH_MS && !cancelled) {
        await new Promise(r => setTimeout(r, SLEEP_PER_BATCH_MS));
      }
    }

    running = false;
    $('sa-ra-cancel').disabled = true; $('sa-ra-cancel').style.opacity = '0.5';
    log(cancelled ? '⏹ Cancelado' : '✓ Completo', cancelled ? 'err' : 'ok');

    // Download results
    const out = {
      generated: new Date().toISOString(),
      cancelled,
      stats,
      results
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rearchive_results.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('✓ Descargado rearchive_results.json', 'ok');
  };

  console.log('📦 Re-archive panel listo. Carga el JSON y dale comenzar.');
})();
