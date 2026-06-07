// archive-orphan-blanks.js
// One-shot DevTools script: archivar los PNs "huérfanos blanqueados" creados
// por bulk-upload 02:03 en el run 139b77b8, donde el quote 197 quedó lockeado
// y el bug 1.5.10 (silent return en enrichWorker) los dejó sin labels ni
// customInputs.
//
// Source list: acepta DOS formatos de JSON:
//   A) tools/27_new_pase3_to_check.json — [{pn, cust, csvRow, quoteIBMS}, ...]
//      Modo fuzzy: usa SearchPartNumbers para encontrar pareja.
//   B) tools/27_pair_analysis.json — {with_pair: [{pn, csvRow, pairs:[{idsh,...}]}]}
//      Modo directo: ya conoce el pairId del snapshot, evita search ambiguo.
//      RECOMENDADO — más rápido y exacto.
//
// Flujo por cada PN (modo directo B):
//   1. GetPartNumber(pairId) → reporta state actual completo del pair.
//   2. SearchPartNumbers por nombre → encuentra el newest (max id != pairId).
//   3. GetPartNumber(newestId) → confirma blanqueado.
//   4. Dry-run: report side-by-side pair vs newest, indica si pair está
//      POPULATED OK (no requiere recovery) o falta data.
//   5. Exec: archiva newest (archivedAt=now). No toca pair.
//
// DRY-RUN: corre primero en modo dry — descarga JSON con detalle por PN.
// Analiza si los pairs ya están populated post-02:32 MODIFY. Si sí, ejecuta
// archive. Si no, decide entre re-correr bulk-upload o script de recovery.

(async () => {
  const HASHES = {
    GetPartNumber:     '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2',
    SearchPartNumbers: '63ba50ed71fbf40476f1844b841351766eefbb147613b51b33919b4f4b2d4d91',
    UpdatePartNumber:  'af584fa8ebb7487fc84de18fa3a5e360e99699a3280185fe98b840c157bbf2c7'
  };

  const CONCURRENCY = 3;
  const SLEEP_PER_BATCH_MS = 80;

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

  function snapshotPN(pn) {
    // Estructura real SH: pn.partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{id,name}
    const labelNodes = (pn.partNumberLabelsByPartNumberId?.nodes || [])
      .map(n => n.labelByLabelId)
      .filter(Boolean);
    const ci = pn.customInputs || {};
    const dp = ci.DatosPlanificacion || {};
    const da = ci.DatosAdicionalesNP || {};
    const df = ci.DatosFacturacion || {};
    // FIX 2026-05-29: QuoteIBMS y EstacionIBMS viven en DatosAdicionalesNP, NO
    // top-level. El dryrun anterior reportaba pair_partial falsamente porque
    // leía ci.QuoteIBMS (siempre null). Fallback top-level por compat con
    // shapes históricos. Igual para PiezasCarga/CargasHora (sin "Por").
    return {
      id: pn.id,
      name: pn.name,
      archivedAt: pn.archivedAt,
      labelCount: labelNodes.length,
      labels: labelNodes.map(l => l.name || l.id),
      labelIds: labelNodes.map(l => l.id),
      quoteIBMS: da.QuoteIBMS || ci.QuoteIBMS || null,
      estIBMS: da.EstacionIBMS || ci.EstacionIBMS || null,
      baseMetal: da.BaseMetal || null,
      plano: da.Plano || null,
      codigoSAT: df.CodigoSAT || null,
      piezasPorCarga: dp.PiezasCarga ?? dp.PiezasPorCarga ?? null,
      cargasPorHora: dp.CargasHora ?? dp.CargasPorHora ?? null,
      tiempoEntrega: dp.TiempoEntrega || null,
      notas: (ci.NotasAdicionales || '').slice(0, 60),
      partNumberGroupId: pn.partNumberGroupId || null,
      defaultProcessNodeId: pn.defaultProcessNodeId || null,
    };
  }

  function isBlanked(snap) {
    return snap.labelCount === 0 && !snap.quoteIBMS && !snap.baseMetal && !snap.notas && !snap.codigoSAT;
  }

  function isPopulated(snap) {
    return snap.labelCount > 0 || !!snap.quoteIBMS || !!snap.baseMetal;
  }

  function isFullyPopulated(snap) {
    return snap.labelCount > 0 && !!snap.quoteIBMS && !!snap.baseMetal && !!snap.notas;
  }

  // --- UI ---
  const oldPanel = document.getElementById('sa-aob-panel');
  if (oldPanel) oldPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'sa-aob-panel';
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 9999999;
    width: 520px; max-height: 92vh; overflow: auto;
    background: #1e293b; color: #e2e8f0; border-radius: 10px; padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="color:#38bdf8;font-size:15px">🗑 Archive orphan blanks</b>
      <button id="sa-aob-close" style="background:#475569;color:#e2e8f0;border:none;border-radius:4px;padding:4px 10px;cursor:pointer">✕</button>
    </div>
    <div style="color:#94a3b8;font-size:12px;margin-bottom:12px">
      Carga <code>27_new_pase3_to_check.json</code>. Hace dry-run primero
      (search + GetPartNumber). Si valida que tiene pareja populada, archiva el más reciente.
    </div>
    <div style="margin-bottom:10px">
      <label style="display:block;color:#94a3b8;margin-bottom:4px">JSON file:</label>
      <input type="file" id="sa-aob-file" accept=".json" style="width:100%;color:#e2e8f0">
    </div>
    <div id="sa-aob-info" style="background:#0f172a;padding:8px 12px;border-radius:4px;margin-bottom:10px;display:none">
      <div>Total a analizar: <b id="sa-aob-total" style="color:#38bdf8">—</b></div>
      <div style="margin-top:4px;font-size:11px;color:#64748b">Concurrencia: ${CONCURRENCY}</div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button id="sa-aob-dry" disabled style="flex:1;background:#0ea5e9;color:white;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;opacity:0.5">🔍 Dry-run (analizar)</button>
      <button id="sa-aob-exec" disabled style="flex:1;background:#dc2626;color:white;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;opacity:0.5">▶ Ejecutar archive</button>
      <button id="sa-aob-cancel" disabled style="background:#475569;color:#e2e8f0;border:none;border-radius:6px;padding:10px 14px;cursor:pointer;opacity:0.5">⏹</button>
    </div>
    <div id="sa-aob-bar" style="height:6px;background:#334155;border-radius:3px;overflow:hidden;display:none;margin-bottom:8px">
      <div id="sa-aob-fill" style="height:100%;background:#16a34a;transition:width 0.2s;width:0%"></div>
    </div>
    <div id="sa-aob-stats" style="font-size:11px;color:#94a3b8;font-family:monospace;line-height:1.6"></div>
    <div id="sa-aob-log" style="margin-top:8px;max-height:300px;overflow:auto;background:#0f172a;padding:8px;border-radius:4px;font-family:monospace;font-size:10px;line-height:1.4;color:#cbd5e1;display:none"></div>
  `;
  document.body.appendChild(panel);

  let payload = null;
  let cancelled = false;
  let running = false;
  let plan = [];   // resultados del dry-run que SÍ se archivarían

  const stats = {
    total: 0, done: 0,
    wouldArchive: 0,
    skipNoPair: 0, skipNotBlanked: 0, skipPairNotPopulated: 0, skipNotFound: 0, errors: 0,
    archived: 0
  };

  const $ = id => document.getElementById(id);
  $('sa-aob-close').onclick = () => panel.remove();

  function log(msg, cls = '') {
    const el = $('sa-aob-log');
    el.style.display = 'block';
    const div = document.createElement('div');
    if (cls === 'err') div.style.color = '#f87171';
    else if (cls === 'ok') div.style.color = '#4ade80';
    else if (cls === 'skip') div.style.color = '#fbbf24';
    else if (cls === 'info') div.style.color = '#93c5fd';
    div.textContent = msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function resetStats(preservePlan = false) {
    Object.keys(stats).forEach(k => stats[k] = 0);
    if (!preservePlan) plan = [];
  }

  function updateStats() {
    const pct = stats.total ? (stats.done / stats.total * 100) : 0;
    $('sa-aob-fill').style.width = pct.toFixed(1) + '%';
    $('sa-aob-stats').innerHTML = `
      <div>Progreso: <b style="color:#e2e8f0">${stats.done} / ${stats.total}</b> (${pct.toFixed(1)}%)</div>
      <div>🎯 Archivaría: <b style="color:#f97316">${stats.wouldArchive}</b> ${stats.archived ? `(archivados: ${stats.archived})` : ''}</div>
      <div>⏸ Skip sin pareja: <b style="color:#fbbf24">${stats.skipNoPair}</b></div>
      <div>⏸ Skip no blanqueado: <b style="color:#fbbf24">${stats.skipNotBlanked}</b></div>
      <div>⏸ Skip pareja no populada: <b style="color:#fbbf24">${stats.skipPairNotPopulated}</b></div>
      <div>⏸ Skip not found: <b style="color:#94a3b8">${stats.skipNotFound}</b></div>
      <div>⚠ Errores: <b style="color:#f87171">${stats.errors}</b></div>
    `;
  }

  $('sa-aob-file').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const text = await f.text();
      const raw = JSON.parse(text);
      // Normaliza a array de items {pn, csvRow, pairIdHint?}
      let items;
      if (Array.isArray(raw)) {
        items = raw.map(r => ({ pn: r.pn, csvRow: r.csvRow, pairIdHint: r.idsh_old || null }));
      } else if (raw.with_pair && Array.isArray(raw.with_pair)) {
        items = raw.with_pair.map(r => ({
          pn: r.pn,
          csvRow: r.csvRow,
          pairIdHint: r.pairs?.[0]?.idsh || null,
        }));
      } else {
        throw new Error('Formato no reconocido (esperaba array o {with_pair:[...]})');
      }
      payload = items;
      stats.total = payload.length;
      $('sa-aob-total').textContent = stats.total;
      $('sa-aob-info').style.display = 'block';
      $('sa-aob-dry').disabled = false; $('sa-aob-dry').style.opacity = '1';
      const directMode = items.every(i => i.pairIdHint);
      log(`✓ Cargados ${stats.total} PNs (modo: ${directMode ? 'DIRECT pairId hint' : 'fuzzy search'})`, 'info');
    } catch (err) {
      alert('Error parsing JSON: ' + err.message);
    }
  };

  $('sa-aob-cancel').onclick = () => {
    if (!running) return;
    cancelled = true;
    log('⏹ Cancelando…', 'err');
  };

  async function analyzeOne(item, doArchive) {
    if (cancelled) return;
    try {
      // 1. Search amplio por nombre (incluye archivados para visibilidad).
      // Paginamos por si hay >50 instancias del mismo nombre.
      let allNodes = [];
      let offset = 0;
      while (true) {
        const sd = await withRetry(
          () => gql('SearchPartNumbers', { searchQuery: item.pn, first: 50, offset, orderBy: ['ID_DESC'] }),
          `search ${item.pn}@${offset}`
        );
        const batch = sd?.searchPartNumbers?.nodes || sd?.pagedData?.nodes || [];
        allNodes = allNodes.concat(batch);
        if (batch.length < 50) break;
        offset += 50;
        if (offset > 200) break; // hard stop
      }
      const wanted = (item.pn || '').toUpperCase().trim();
      const exact = allNodes.filter(n => (n.name || '').toUpperCase().trim() === wanted);
      const active = exact.filter(n => !n.archivedAt);

      if (!active.length) {
        stats.skipNotFound++;
        log(`✗ ${item.pn}: no encontrado en SH (todas archivadas)`, 'err');
        return;
      }

      // 2. GetPartNumber a TODAS las activas para visibilidad completa
      const snaps = [];
      for (const n of active) {
        const d = await withRetry(
          () => gql('GetPartNumber', { partNumberId: Number(n.id) }),
          `GetPartNumber ${item.pn}/${n.id}`
        );
        if (d?.partNumberById) snaps.push(snapshotPN(d.partNumberById));
      }

      if (!snaps.length) {
        stats.skipNotFound++;
        log(`✗ ${item.pn}: GetPartNumber sin data`, 'err');
        return;
      }

      // 3. Identificar:
      //    - newest = max id (target de archive)
      //    - bestPair = la instancia MÁS populada del resto (preferir fully > partial)
      snaps.sort((a, b) => Number(b.id) - Number(a.id));
      const newest = snaps[0];
      const rest = snaps.slice(1);

      function scorePN(s) {
        // ranking por completitud
        let score = 0;
        if (s.labelCount > 0) score += 10;
        if (s.quoteIBMS) score += 5;
        if (s.baseMetal) score += 3;
        if (s.notas) score += 1;
        if (s.codigoSAT) score += 1;
        return score;
      }
      const bestPair = rest.length
        ? rest.slice().sort((a, b) => scorePN(b) - scorePN(a))[0]
        : null;

      const newestBlanked = isBlanked(newest);
      const pairFull = bestPair && isFullyPopulated(bestPair);

      const planEntry = {
        pn: item.pn,
        csvRow: item.csvRow,
        totalActiveInstances: snaps.length,
        allInstances: snaps,    // visibilidad completa
        newest,
        bestPair,
        newestBlanked,
        pairFullyPopulated: pairFull,
        decision: null,
      };

      if (!newestBlanked) {
        planEntry.decision = 'skip_not_blanked';
        stats.skipNotBlanked++;
        log(`⏸ ${item.pn}: newest id=${newest.id} NO blanqueado — labels=${newest.labelCount} IBMS=${newest.quoteIBMS}`, 'skip');
        plan.push(planEntry);
        return;
      }
      if (!bestPair) {
        planEntry.decision = 'skip_no_pair';
        stats.skipNoPair++;
        log(`⏸ ${item.pn}: única instancia (id=${newest.id}) y está blanqueada`, 'skip');
        plan.push(planEntry);
        return;
      }
      if (!pairFull) {
        planEntry.decision = 'archive_but_pair_partial';
        log(`🟡 ${item.pn}: ${snaps.length} activas | newest blanqueado id=${newest.id} | bestPair PARCIAL id=${bestPair.id} L=${bestPair.labelCount} IBMS=${bestPair.quoteIBMS} base=${bestPair.baseMetal}`, 'skip');
      } else {
        planEntry.decision = 'archive';
        log(`🎯 ${item.pn}: ${snaps.length} activas | archivar id=${newest.id} | bestPair OK id=${bestPair.id} L=${bestPair.labelCount} IBMS=${bestPair.quoteIBMS}`, 'info');
      }

      stats.wouldArchive++;
      plan.push(planEntry);

      if (!doArchive) return;

      // EXEC: archivar newest
      const now = new Date().toISOString();
      await withRetry(
        () => gql('UpdatePartNumber', { id: Number(newest.id), archivedAt: now }),
        `UpdatePartNumber ${item.pn}/${newest.id}`
      );
      stats.archived++;
      planEntry.archivedAt = now;
      log(`✓ ${item.pn}: archivado id=${newest.id}`, 'ok');
    } catch (e) {
      stats.errors++;
      log(`⚠ ${item.pn}: ${String(e).slice(0, 120)}`, 'err');
    } finally {
      stats.done++;
      updateStats();
    }
  }

  async function runAll(doArchive) {
    if (!payload || running) return;
    if (doArchive) {
      const ok = confirm(
        `¿Archivar ${plan.length} PNs huérfanos blanqueados?\n\n` +
        `Cada uno será marcado con archivedAt=now (reversible vía unarchive).\n` +
        `Concurrencia: ${CONCURRENCY}.`
      );
      if (!ok) return;
    }
    running = true; cancelled = false;
    $('sa-aob-dry').disabled = true; $('sa-aob-dry').style.opacity = '0.5';
    $('sa-aob-exec').disabled = true; $('sa-aob-exec').style.opacity = '0.5';
    $('sa-aob-cancel').disabled = false; $('sa-aob-cancel').style.opacity = '1';
    $('sa-aob-bar').style.display = 'block';
    // En EXEC necesitamos conservar el plan calculado por el dry-run para
    // saber qué newest archivar. resetStats(true) limpia counters pero no plan.
    resetStats(doArchive);
    // En EXEC: filtrar entries a archivar ANTES de limpiar el plan original,
    // luego limpiar plan para que analyzeOne lo repueble sin duplicar.
    let archiveTargets = [];
    if (doArchive) {
      archiveTargets = plan.filter(p =>
        p.decision === 'archive' || p.decision === 'archive_but_pair_partial'
      ).map(p => ({ pn: p.pn, csvRow: p.csvRow }));
      plan = [];
    }
    const list = doArchive ? archiveTargets : payload;
    stats.total = list.length;
    updateStats();

    for (let i = 0; i < list.length && !cancelled; i += CONCURRENCY) {
      const batch = list.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(item => analyzeOne(item, doArchive)));
      if (SLEEP_PER_BATCH_MS && !cancelled) {
        await new Promise(r => setTimeout(r, SLEEP_PER_BATCH_MS));
      }
    }

    running = false;
    $('sa-aob-cancel').disabled = true; $('sa-aob-cancel').style.opacity = '0.5';
    $('sa-aob-dry').disabled = false; $('sa-aob-dry').style.opacity = '1';
    if (!doArchive && plan.length > 0) {
      $('sa-aob-exec').disabled = false; $('sa-aob-exec').style.opacity = '1';
    }
    log(cancelled ? '⏹ Cancelado' : `✓ ${doArchive ? 'Archive ejecutado' : 'Dry-run completo'}`, cancelled ? 'err' : 'ok');

    // Descargar resultados
    const out = {
      mode: doArchive ? 'execute' : 'dry-run',
      generated: new Date().toISOString(),
      cancelled,
      stats,
      plan
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `archive_orphan_${doArchive ? 'exec' : 'dryrun'}_${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('sa-aob-dry').onclick = () => runAll(false);
  $('sa-aob-exec').onclick = () => runAll(true);

  console.log('🗑 Archive-orphan-blanks panel listo. Carga el JSON.');
})();
