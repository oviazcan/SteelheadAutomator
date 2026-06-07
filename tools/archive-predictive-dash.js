// archive-predictive-dash.js
// Tool standalone para DevTools — archiva masivamente los predictives "basura"
// (CSV dice "-" pero server tiene valor activo) detectados por audit-incomplete-pns.
//
// Cómo usar:
//   1. Ejecuta primero audit-incomplete-pns.js sobre tu CSV. Te baja un audit_report_*.json.
//   2. Abre app.gosteelhead.com en Chrome y autentícate.
//   3. Abre DevTools → Console. Pega TODO este archivo y dale Enter.
//   4. Aparece un panel flotante. Click "📁 Cargar audit JSON" y selecciona el .json.
//   5. Muestra vista previa (cuántos PNs, cuántos materiales, breakdown).
//   6. Click "🗑️ Archivar todos" → pool de 4 → reporte JSON al final.
//
// Origen del config: lee window.REMOTE_CONFIG si existe, si no fetch a gh-pages.
//
// 2026-05-25 — Omar Viazcán + Claude (Opus 4.7)

(async () => {
  'use strict';

  if (window.__SAArchivePredictiveDash?.openModal) {
    window.__SAArchivePredictiveDash.openModal();
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIG + GRAPHQL CLIENT
  // ═══════════════════════════════════════════════════════════════════════
  const CONFIG_URL = 'https://oviazcan.github.io/SteelheadAutomator/config.json';
  const GRAPHQL_URL = 'https://app.gosteelhead.com/graphql';
  const APOLLO_VERSION = '4.0.8';
  const CONCURRENCY = 4;

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
  const REQUIRED = ['GetPartNumber', 'ArchivePredictedInventoryUsage'];
  const missing = REQUIRED.filter(k => !hashes[k]);
  if (missing.length) {
    alert('Faltan hashes en config: ' + missing.join(', '));
    return;
  }

  async function gql(operationName, variables) {
    const hash = hashes[operationName];
    if (!hash) throw new Error('Hash no encontrado para ' + operationName);
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationName, variables,
        extensions: {
          clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
          persistedQuery: { version: 1, sha256Hash: hash },
        },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${operationName}: ${t.substring(0, 200)}`);
    }
    const j = await r.json();
    if (j.errors && !j.data) {
      throw new Error(`GQL ${operationName}: ${j.errors.map(e => e.message).join('; ').substring(0, 200)}`);
    }
    return j.data;
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

  function norm(s) { return String(s || '').trim().toLowerCase(); }

  // ═══════════════════════════════════════════════════════════════════════
  // EXTRACCIÓN DE TARGETS desde audit JSON
  // ═══════════════════════════════════════════════════════════════════════
  function extractTargetsFromAudit(json) {
    const incomplete = json?.incomplete || [];
    const byPn = new Map();
    for (const entry of incomplete) {
      const pnId = entry.pnId;
      if (!pnId) continue;
      const dashIssues = (entry.issues || []).filter(i => i.field === 'predictiveDash');
      if (!dashIssues.length) continue;
      const mats = dashIssues.map(i => i.material);
      if (!byPn.has(pnId)) byPn.set(pnId, new Set());
      for (const m of mats) byPn.get(pnId).add(m);
    }
    return Array.from(byPn.entries()).map(([pnId, mats]) => ({
      pnId,
      materials: Array.from(mats),
    }));
  }

  function summarizeTargets(targets) {
    const byMaterial = new Map();
    for (const t of targets) {
      for (const m of t.materials) {
        byMaterial.set(m, (byMaterial.get(m) || 0) + 1);
      }
    }
    return {
      totalPNs: targets.length,
      totalEntries: Array.from(byMaterial.values()).reduce((a, b) => a + b, 0),
      byMaterial: Array.from(byMaterial.entries()).sort((a, b) => b[1] - a[1]),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATE + UI
  // ═══════════════════════════════════════════════════════════════════════
  const state = {
    targets: [],
    auditFile: null,
    running: false,
    aborted: false,
    archivedAt: null,
  };

  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    if (props.style) e.style.cssText = props.style;
    for (const c of children) e.append(c);
    return e;
  }

  const old = document.getElementById('sa-archive-dash-panel');
  if (old) old.remove();

  const panel = el('div', {
    id: 'sa-archive-dash-panel',
    style: `
      position: fixed; top: 20px; right: 20px; width: 460px; max-height: 80vh;
      background: #fff; border: 2px solid #2d3748; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 999999;
      font: 13px -apple-system, BlinkMacSystemFont, sans-serif; color: #2d3748;
      display: flex; flex-direction: column;
    `
  });
  document.body.append(panel);

  const header = el('div', { style: 'padding: 12px; background: #2d3748; color: white; border-radius: 6px 6px 0 0; display: flex; justify-content: space-between; align-items: center; cursor: move;' });
  header.append(
    el('strong', {}, '🗑️ Archive Predictive Dash'),
    el('button', { onclick: () => panel.remove(), style: 'background: transparent; color: white; border: 1px solid white; border-radius: 4px; padding: 2px 8px; cursor: pointer;' }, 'Cerrar')
  );
  panel.append(header);

  // Drag
  let drag = null;
  header.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    panel.style.left = (e.clientX - drag.x) + 'px';
    panel.style.top = (e.clientY - drag.y) + 'px';
    panel.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => drag = null);

  const body = el('div', { style: 'padding: 12px; overflow-y: auto; flex: 1;' });
  panel.append(body);

  const intro = el('p', { style: 'margin: 0 0 8px 0; font-size: 12px; color: #4a5568;' },
    'Carga un audit JSON (generado por audit-incomplete-pns). Archivará los predictives donde el CSV trae "-" pero el server tiene valor activo. Matchea por NAME (case-insensitive).');
  body.append(intro);

  const fileBtn = el('button', {
    style: 'width: 100%; padding: 10px; background: #4299e1; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; margin-bottom: 8px;'
  }, '📁 Cargar audit JSON');
  body.append(fileBtn);

  const fileInput = el('input', { type: 'file', accept: '.json', style: 'display: none;' });
  body.append(fileInput);
  fileBtn.onclick = () => fileInput.click();

  const summaryDiv = el('div', { style: 'margin: 8px 0; padding: 8px; background: #edf2f7; border-radius: 4px; font-size: 12px; min-height: 40px;' }, 'Sin audit cargado.');
  body.append(summaryDiv);

  const actionsDiv = el('div', { style: 'margin: 8px 0; display: flex; gap: 6px;' });
  body.append(actionsDiv);

  const runBtn = el('button', {
    disabled: true,
    style: 'flex: 1; padding: 10px; background: #e53e3e; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; opacity: 0.5;'
  }, '🗑️ Archivar todos');
  actionsDiv.append(runBtn);

  const stopBtn = el('button', {
    disabled: true,
    style: 'padding: 10px 14px; background: #718096; color: white; border: none; border-radius: 4px; cursor: pointer; opacity: 0.5;'
  }, '⏹');
  actionsDiv.append(stopBtn);
  stopBtn.onclick = () => { state.aborted = true; stopBtn.disabled = true; addLog('⏹ Solicitud de cancelación enviada — pool drenará workers en curso.'); };

  const progressDiv = el('div', { style: 'margin: 8px 0; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;' });
  const progressBar = el('div', { style: 'height: 100%; background: #48bb78; width: 0%; transition: width 0.2s;' });
  progressDiv.append(progressBar);
  body.append(progressDiv);

  const logDiv = el('div', { style: 'margin-top: 8px; padding: 8px; background: #1a202c; color: #cbd5e0; border-radius: 4px; font-family: monospace; font-size: 11px; max-height: 200px; overflow-y: auto; white-space: pre-wrap;' });
  body.append(logDiv);

  function addLog(msg) {
    const line = el('div', {}, `[${new Date().toLocaleTimeString()}] ${msg}`);
    logDiv.append(line);
    logDiv.scrollTop = logDiv.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FILE INPUT HANDLER
  // ═══════════════════════════════════════════════════════════════════════
  fileInput.onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    state.auditFile = f.name;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      state.targets = extractTargetsFromAudit(json);
      const sum = summarizeTargets(state.targets);
      summaryDiv.innerHTML = '';
      summaryDiv.append(
        el('div', { style: 'font-weight: 600; margin-bottom: 4px;' }, `${f.name}`),
        el('div', {}, `Audit generado: ${json.generatedAt || '?'}`),
        el('div', {}, `PNs con predictiveDash: ${sum.totalPNs}`),
        el('div', {}, `Entradas a archivar: ${sum.totalEntries}`),
      );
      const matsList = el('div', { style: 'margin-top: 4px;' });
      for (const [m, c] of sum.byMaterial) {
        matsList.append(el('div', {}, `  • ${m}: ${c}`));
      }
      summaryDiv.append(matsList);
      runBtn.disabled = sum.totalPNs === 0;
      runBtn.style.opacity = sum.totalPNs === 0 ? '0.5' : '1';
      addLog(`✅ Audit cargado: ${sum.totalPNs} PNs, ${sum.totalEntries} entradas predictiveDash.`);
    } catch (e) {
      summaryDiv.textContent = '❌ Error: ' + e.message;
      addLog('❌ Error parseando JSON: ' + e.message);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ARCHIVE WORKFLOW
  // ═══════════════════════════════════════════════════════════════════════
  runBtn.onclick = async () => {
    if (state.running) return;
    const sum = summarizeTargets(state.targets);
    if (!confirm(`Vas a archivar ${sum.totalEntries} predictives en ${sum.totalPNs} PNs.\n\nMaterial(es): ${sum.byMaterial.map(([m, c]) => `${m} (${c})`).join(', ')}\n\n¿Continuar?`)) return;

    state.running = true;
    state.aborted = false;
    state.archivedAt = new Date().toISOString();
    runBtn.disabled = true; runBtn.style.opacity = '0.5';
    stopBtn.disabled = false; stopBtn.style.opacity = '1';
    fileBtn.disabled = true; fileBtn.style.opacity = '0.5';

    const result = {
      startedAt: state.archivedAt,
      auditFile: state.auditFile,
      totalPNs: state.targets.length,
      archivedOk: 0,
      skippedAlreadyArchived: 0,
      notFound: 0,
      errors: [],
      details: [],
    };

    addLog(`▶️ Iniciando archivado: ${state.targets.length} PNs, concurrency ${CONCURRENCY}.`);

    async function processTarget(t) {
      try {
        const matsWanted = new Set(t.materials.map(norm));
        const d = await gql('GetPartNumber', { partNumberId: t.pnId, usagesLimit: 100, usagesOffset: 0 });
        const nodes = d?.partNumberById?.predictedInventoryUsagesByPartNumberId?.nodes || [];
        const hits = nodes.filter(n => matsWanted.has(norm(n.inventoryItemByInventoryItemId?.name)));
        if (!hits.length) {
          result.notFound++;
          result.details.push({ pnId: t.pnId, status: 'NOT_FOUND', materials: t.materials });
          return;
        }
        for (const h of hits) {
          if (h.archivedAt) {
            result.skippedAlreadyArchived++;
            continue;
          }
          try {
            await gql('ArchivePredictedInventoryUsage', {
              input: { id: h.id, predictedInventoryUsagePatch: { archivedAt: state.archivedAt } },
            });
            result.archivedOk++;
            result.details.push({
              pnId: t.pnId,
              predId: h.id,
              material: h.inventoryItemByInventoryItemId?.name?.trim(),
              status: 'ARCHIVED',
            });
          } catch (e) {
            result.errors.push({ pnId: t.pnId, predId: h.id, error: String(e).slice(0, 200) });
          }
        }
      } catch (e) {
        result.errors.push({ pnId: t.pnId, error: String(e).slice(0, 200) });
      }
    }

    await runPool(state.targets, processTarget, CONCURRENCY, (done, total) => {
      progressBar.style.width = `${(done / total * 100).toFixed(1)}%`;
      if (done % 10 === 0 || done === total) {
        addLog(`Progress ${done}/${total} — OK=${result.archivedOk} notFound=${result.notFound} err=${result.errors.length}`);
      }
    });

    result.finishedAt = new Date().toISOString();
    result.aborted = state.aborted;

    addLog(`═══ FIN ═══`);
    addLog(`Archivados OK: ${result.archivedOk}`);
    addLog(`Ya archivados: ${result.skippedAlreadyArchived}`);
    addLog(`Sin match: ${result.notFound}`);
    addLog(`Errores: ${result.errors.length}`);

    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = `archive_predictive_dash_report_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(a); a.click(); a.remove();
    addLog('📁 Reporte descargado.');

    state.running = false;
    fileBtn.disabled = false; fileBtn.style.opacity = '1';
    stopBtn.disabled = true; stopBtn.style.opacity = '0.5';
  };

  window.__SAArchivePredictiveDash = {
    openModal: () => { panel.style.display = 'flex'; },
    state, gql, extractTargetsFromAudit, summarizeTargets,
  };

  addLog('Listo. Carga un audit JSON para empezar.');
})();
