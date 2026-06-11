/* ============================================================================
 * archive-racks-by-type.js  —  Script para DevTools (consola del navegador)
 *
 * QUÉ HACE
 *   Archiva (soft-delete) los BASTIDORES (racks) cuyo TIPO de rack coincide con
 *   un patrón. Por default: tipos que contienen "-RA" + dígitos en cualquier
 *   parte del nombre (ej. T103-RA01, T205-RA05, M102-RA02 Bastón 4").
 *
 * CÓMO USARLO
 *   1. Abre https://app.gosteelhead.com con tu sesión iniciada (cualquier página).
 *   2. Abre DevTools → pestaña Console.
 *   3. Pega TODO este script y dale Enter. Aparece el panel arriba a la derecha.
 *   4. Clic "Dry-run (analizar)" → escanea AllRacks, filtra por tipo y muestra
 *      la tabla + resumen por tipo. Descarga un JSON con el plan. NO escribe.
 *   5. Revisa el plan. Si se ve bien, clic "Ejecutar archive".
 *
 * SEGURIDAD
 *   - "Dry-run" nunca escribe. La escritura SOLO ocurre con "Ejecutar archive"
 *     y pide confirm() con el conteo exacto.
 *   - Racks con PARTES ENCIMA (partLocations > 0) se EXCLUYEN por default; hay
 *     un checkbox para incluirlos si de verdad quieres archivar racks en uso.
 *   - Fail-closed: si la API no devuelve el campo de partes (null), el rack se
 *     EXCLUYE como "partes desconocidas" en lugar de asumir vacío.
 *   - Racks sin equipmentId → skip + warn (la mutación lo requiere).
 *   - Reversible: la mutación marca archive:true. Para desarchivar se manda el
 *     mismo input con archive:false (ver ARCHIVE_FLAG abajo).
 *
 * CONFIG (editable arriba del IIFE)
 *   - RACK_TYPE_RE : patrón del tipo de rack a archivar. Default /-RA\d+/i.
 *   - ARCHIVE_FLAG : true=archivar (default). Cambia a false para DESARCHIVAR
 *     el mismo conjunto (también respeta el patrón).
 *   - PAGE_SIZE / CONCURRENCY / SLEEP_PER_BATCH_MS : tuning de scan/exec.
 *
 * Persisted queries capturadas del scan 2026-06-10 (apiKnowledge):
 *   - AllRacks            f2510edb53e49374944b7937199a0b62a4bcfd0b7c74082fb47dadcdb45b1f78
 *   - ArchiveRackChecked  51b7045fdcba5a6cbf8a4b6c5280d49a41d9d22161c9b85fd30fbfd5bbeb0915
 *   ArchiveRackChecked input: {rackId, archive, equipmentId, equipmentAction:'none'}
 * ========================================================================== */

(async () => {
  // ---- CONFIG ---------------------------------------------------------------
  const RACK_TYPE_RE       = /-RA\d+/i;   // tipo de rack a archivar (contiene -RA + dígitos)
  const ARCHIVE_FLAG       = true;        // true = archivar; false = desarchivar
  const PAGE_SIZE          = 100;         // racks por página de AllRacks
  const CONCURRENCY        = 3;           // mutaciones en paralelo
  const SLEEP_PER_BATCH_MS = 80;          // pausa entre lotes (cortesía al server)
  const MAX_TABLE_ROWS     = 500;         // tope de filas en el DOM (todas se procesan igual)

  const HASHES = {
    AllRacks:           'f2510edb53e49374944b7937199a0b62a4bcfd0b7c74082fb47dadcdb45b1f78',
    ArchiveRackChecked: '51b7045fdcba5a6cbf8a4b6c5280d49a41d9d22161c9b85fd30fbfd5bbeb0915',
  };

  // ---- API ------------------------------------------------------------------
  async function gql(op, vars) {
    const body = {
      operationName: op,
      variables: vars,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: HASHES[op] },
      },
    };
    const r = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    // Acción destructiva → fallar fuerte ante CUALQUIER error de GraphQL, incluso
    // partial errors {data, errors}: evita scans incompletos y falsos "archivado ok".
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  async function withRetry(fn, label, maxRetry = 3) {
    let lastErr;
    for (let i = 0; i <= maxRetry; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        const msg = String(e);
        if (msg.includes('HTTP 5') || msg.includes('HTTP 429') || msg.includes('NetworkError')) {
          await new Promise(r => setTimeout(r, 800 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // ---- Lógica de dominio (pura) ---------------------------------------------
  function matchesType(typeName) {
    return !!typeName && RACK_TYPE_RE.test(typeName);
  }

  // Mapea un nodo de AllRacks a lo mínimo que usamos (slim).
  function slimRack(node) {
    const rt = node.rackTypeByRackTypeId || {};
    const eq = node.equipmentByEquipmentId || null;
    const plConn = node.partLocationsByRackId;            // puede venir null (schema/parcial)
    const partsUnknown = plConn == null;                  // fail-closed si el campo falta
    const plNodes = (plConn && plConn.nodes) || [];
    const partTotal = plNodes.reduce((s, pl) => s + (Number(pl.partCount) || 0), 0);
    return {
      rackId:       Number(node.id),
      name:         node.name || '',
      rackTypeName: rt.name || '',
      rackTypeId:   rt.id != null ? Number(rt.id) : null,
      isContainer:  !!rt.isContainer,
      equipmentId:  eq && eq.id != null ? Number(eq.id) : null,
      partLocCount: plNodes.length,   // # de ubicaciones de parte (criterio conservador de "en uso")
      partTotal,                      // suma de piezas en el rack (informativo)
      partsUnknown,                   // true si la API no trajo el campo → excluir por seguridad
    };
  }

  // Decide qué se archiva realmente, dado el conjunto que matchea el tipo.
  // Devuelve {targets, skippedInUse, skippedNoEquip, skippedUnknown}.
  function computeTargets(matched, includeInUse) {
    const targets = [], skippedInUse = [], skippedNoEquip = [], skippedUnknown = [];
    for (const r of matched) {
      if (r.equipmentId == null) { skippedNoEquip.push(r); continue; }
      if (!includeInUse && r.partsUnknown) { skippedUnknown.push(r); continue; } // fail-closed
      if (!includeInUse && r.partLocCount > 0) { skippedInUse.push(r); continue; }
      targets.push(r);
    }
    return { targets, skippedInUse, skippedNoEquip, skippedUnknown };
  }

  // Agrupa por tipo para el resumen reassurance pre-mutación.
  function summarizeByType(racks) {
    const m = new Map();
    for (const r of racks) {
      const k = r.rackTypeName || '(sin tipo)';
      if (!m.has(k)) m.set(k, { type: k, total: 0, withParts: 0 });
      const e = m.get(k);
      e.total++;
      if (r.partLocCount > 0) e.withParts++;
    }
    return [...m.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  // ---- UI -------------------------------------------------------------------
  const old = document.getElementById('sa-rax-panel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'sa-rax-panel';
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 9999999;
    width: 560px; max-height: 92vh; overflow: auto;
    background: #1e293b; color: #e2e8f0; border-radius: 10px; padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  `;
  const modeLabel = ARCHIVE_FLAG ? 'Archivar' : 'DESARCHIVAR';
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="color:#38bdf8;font-size:15px">🗄 ${modeLabel} racks por tipo</b>
      <button id="sa-rax-close" style="background:#475569;color:#e2e8f0;border:none;border-radius:4px;padding:4px 10px;cursor:pointer">✕</button>
    </div>
    <div style="color:#94a3b8;font-size:12px;margin-bottom:10px">
      Patrón de tipo: <code style="color:#fbbf24">${String(RACK_TYPE_RE)}</code> ·
      modo: <b style="color:${ARCHIVE_FLAG ? '#f97316' : '#4ade80'}">${modeLabel}</b>.
      Dry-run escanea <code>AllRacks</code> (incluyeArchivados:${ARCHIVE_FLAG ? 'NO' : 'YES'}), filtra por tipo y NO escribe.
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:#cbd5e1;font-size:12px">
      <input type="checkbox" id="sa-rax-include-inuse">
      Incluir racks con partes encima (por default se <b>excluyen</b>)
    </label>
    <div id="sa-rax-info" style="background:#0f172a;padding:8px 12px;border-radius:4px;margin-bottom:10px;display:none">
      <div>Total racks escaneados: <b id="sa-rax-total" style="color:#38bdf8">—</b></div>
      <div style="font-size:11px;color:#64748b;margin-top:2px">Concurrencia: ${CONCURRENCY} · página: ${PAGE_SIZE}</div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button id="sa-rax-dry"    style="flex:1;background:#0ea5e9;color:white;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer">🔍 Dry-run (analizar)</button>
      <button id="sa-rax-exec"   disabled style="flex:1;background:#dc2626;color:white;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;opacity:0.5">▶ Ejecutar ${ARCHIVE_FLAG ? 'archive' : 'unarchive'}</button>
      <button id="sa-rax-cancel" disabled style="background:#475569;color:#e2e8f0;border:none;border-radius:6px;padding:10px 14px;cursor:pointer;opacity:0.5">⏹</button>
    </div>
    <div id="sa-rax-bar" style="height:6px;background:#334155;border-radius:3px;overflow:hidden;display:none;margin-bottom:8px">
      <div id="sa-rax-fill" style="height:100%;background:#16a34a;transition:width 0.2s;width:0%"></div>
    </div>
    <div id="sa-rax-stats" style="font-size:11px;color:#94a3b8;font-family:monospace;line-height:1.6"></div>
    <div id="sa-rax-summary" style="margin-top:8px;font-size:11px;color:#cbd5e1;display:none"></div>
    <div id="sa-rax-tablewrap" style="margin-top:8px;max-height:240px;overflow:auto;display:none;border:1px solid #334155;border-radius:4px"></div>
    <div id="sa-rax-log" style="margin-top:8px;max-height:220px;overflow:auto;background:#0f172a;padding:8px;border-radius:4px;font-family:monospace;font-size:10px;line-height:1.4;color:#cbd5e1;display:none"></div>
  `;
  document.body.appendChild(panel);

  const $ = id => document.getElementById(id);
  $('sa-rax-close').onclick = () => panel.remove();

  // Escapa texto de usuario (nombres/tipos vienen de la API) antes de meterlo en innerHTML.
  const esc = s => { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; };

  let running = false, cancelled = false;
  let scanned = [];   // todos los racks escaneados (slim)
  let matched = [];   // los que matchean el tipo
  let lastPlan = null; // {targets, skippedInUse, skippedNoEquip, skippedUnknown}
  let lastIncludeInUse = false; // toggle con el que se calculó lastPlan
  let processedIds = new Set(); // rackIds ya mutados (no re-archivar tras cancel/re-run)

  const stats = { scanned: 0, matched: 0, withParts: 0, targets: 0, skippedInUse: 0, skippedNoEquip: 0, skippedUnknown: 0, archived: 0, errors: 0 };

  function log(msg, cls = '') {
    const el = $('sa-rax-log'); el.style.display = 'block';
    const div = document.createElement('div');
    if (cls === 'err') div.style.color = '#f87171';
    else if (cls === 'ok') div.style.color = '#4ade80';
    else if (cls === 'skip') div.style.color = '#fbbf24';
    else if (cls === 'info') div.style.color = '#93c5fd';
    div.textContent = msg;
    el.appendChild(div); el.scrollTop = el.scrollHeight;
  }

  function setProgress(frac, text) {
    $('sa-rax-bar').style.display = 'block';
    $('sa-rax-fill').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
    if (text) $('sa-rax-fill').title = text;
  }

  function renderStats(phase) {
    $('sa-rax-stats').innerHTML = `
      <div>Fase: <b style="color:#e2e8f0">${phase}</b></div>
      <div>Escaneados: <b style="color:#38bdf8">${stats.scanned}</b> · matchean <code>${String(RACK_TYPE_RE)}</code>: <b style="color:#a78bfa">${stats.matched}</b> (con partes: ${stats.withParts})</div>
      <div>🎯 A ${ARCHIVE_FLAG ? 'archivar' : 'desarchivar'}: <b style="color:#f97316">${stats.targets}</b> ${stats.archived ? `(hechos: ${stats.archived})` : ''}</div>
      <div>⏸ Excluidos en uso: <b style="color:#fbbf24">${stats.skippedInUse}</b> · sin equipo: <b style="color:#fbbf24">${stats.skippedNoEquip}</b> · partes?: <b style="color:#fbbf24">${stats.skippedUnknown}</b></div>
      <div>⚠ Errores: <b style="color:#f87171">${stats.errors}</b></div>
    `;
  }

  function renderSummary() {
    const sum = summarizeByType(matched);
    if (!sum.length) { $('sa-rax-summary').style.display = 'none'; return; }
    $('sa-rax-summary').style.display = 'block';
    $('sa-rax-summary').innerHTML =
      `<b style="color:#a78bfa">Tipos que matchean (${sum.length}):</b><br>` +
      sum.map(s => `&nbsp;&nbsp;<code>${esc(s.type)}</code>: ${s.total} rack(s)` +
        (s.withParts ? ` <span style="color:#fbbf24">(${s.withParts} con partes)</span>` : '')).join('<br>');
  }

  function renderTable() {
    const wrap = $('sa-rax-tablewrap');
    if (!matched.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    const rows = matched.slice(0, MAX_TABLE_ROWS);
    const tgtIds = new Set((lastPlan ? lastPlan.targets : []).map(r => r.rackId));
    const head = `<tr style="position:sticky;top:0;background:#0f172a;color:#94a3b8">
      <th style="text-align:left;padding:4px 6px">rackId</th>
      <th style="text-align:left;padding:4px 6px">nombre</th>
      <th style="text-align:left;padding:4px 6px">tipo</th>
      <th style="text-align:right;padding:4px 6px">equip</th>
      <th style="text-align:right;padding:4px 6px" title="ubicaciones/piezas">ubic/pzas</th>
      <th style="text-align:center;padding:4px 6px">archiva</th></tr>`;
    const body = rows.map(r => {
      const tgt = tgtIds.has(r.rackId);
      const why = r.equipmentId == null ? 'sin equipo'
        : (r.partsUnknown && !tgt ? 'partes?'
        : (r.partLocCount > 0 && !tgt ? 'en uso'
        : (tgt ? '✓' : '—')));
      const partsCell = r.partsUnknown ? '?' : `${r.partLocCount}/${r.partTotal}`;
      return `<tr style="border-top:1px solid #1e293b;color:${tgt ? '#e2e8f0' : '#64748b'}">
        <td style="padding:3px 6px;font-family:monospace">${r.rackId}</td>
        <td style="padding:3px 6px">${esc(r.name)}</td>
        <td style="padding:3px 6px;color:#fbbf24">${esc(r.rackTypeName)}</td>
        <td style="padding:3px 6px;text-align:right;font-family:monospace">${r.equipmentId ?? '—'}</td>
        <td style="padding:3px 6px;text-align:right;${(r.partLocCount || r.partsUnknown) ? 'color:#fbbf24' : ''}">${partsCell}</td>
        <td style="padding:3px 6px;text-align:center">${why}</td></tr>`;
    }).join('');
    const note = matched.length > MAX_TABLE_ROWS
      ? `<div style="padding:4px 6px;color:#64748b">… +${matched.length - MAX_TABLE_ROWS} más (no mostrados; sí se procesan)</div>` : '';
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:10px">${head}${body}</table>${note}`;
  }

  // Recalcula el plan desde `matched` con el estado ACTUAL del toggle y refleja
  // los conteos + habilita/deshabilita el botón exec. Anti-staleness: lo llamamos
  // en el dry-run, al cambiar el checkbox, y otra vez justo antes de ejecutar.
  function recomputePlan() {
    lastIncludeInUse = $('sa-rax-include-inuse').checked;
    lastPlan = computeTargets(matched, lastIncludeInUse);
    stats.targets = lastPlan.targets.length;
    stats.skippedInUse = lastPlan.skippedInUse.length;
    stats.skippedNoEquip = lastPlan.skippedNoEquip.length;
    stats.skippedUnknown = lastPlan.skippedUnknown.length;
    const exec = $('sa-rax-exec');
    if (stats.targets > 0) {
      exec.disabled = false; exec.style.opacity = '1';
      exec.textContent = '▶ Ejecutar ' + (ARCHIVE_FLAG ? 'archive' : 'unarchive');
    } else {
      exec.disabled = true; exec.style.opacity = '0.5';
    }
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Scan -----------------------------------------------------------------
  async function scanAllRacks() {
    const out = [];
    let offset = 0, totalCount = null;
    const includeArchived = ARCHIVE_FLAG ? 'NO' : 'YES'; // archivar→activos; desarchivar→incluye archivados
    while (!cancelled) {
      const d = await withRetry(
        () => gql('AllRacks', { includeArchived, orderBy: ['ID_DESC'], offset, first: PAGE_SIZE, searchQuery: '' }),
        `AllRacks@${offset}`
      );
      const pd = d && d.pagedData;
      const nodes = (pd && pd.nodes) || [];
      if (totalCount == null && pd && typeof pd.totalCount === 'number') totalCount = pd.totalCount;
      for (const n of nodes) out.push(slimRack(n));
      stats.scanned = out.length;
      setProgress(totalCount ? out.length / totalCount : 0.5, `escaneando ${out.length}/${totalCount ?? '?'}`);
      renderStats('scan');
      if (nodes.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      if (totalCount != null && offset >= totalCount) break;
      if (offset > 20000) { log('⚠ corte de seguridad a 20000', 'err'); break; } // backstop anti-loop
    }
    return out;
  }

  // ---- Dry-run --------------------------------------------------------------
  async function runDry() {
    if (running) return;
    running = true; cancelled = false;
    Object.keys(stats).forEach(k => stats[k] = 0);
    $('sa-rax-dry').disabled = true; $('sa-rax-dry').style.opacity = '0.5';
    $('sa-rax-exec').disabled = true; $('sa-rax-exec').style.opacity = '0.5';
    $('sa-rax-cancel').disabled = false; $('sa-rax-cancel').style.opacity = '1';
    $('sa-rax-info').style.display = 'block';
    log('🔍 Iniciando dry-run (scan AllRacks)…', 'info');

    try {
      processedIds = new Set();   // plan nuevo → nada procesado aún
      scanned = await scanAllRacks();
      if (cancelled) { log('⏹ Cancelado durante scan', 'err'); return; }
      matched = scanned.filter(r => matchesType(r.rackTypeName));
      stats.scanned = scanned.length;
      stats.matched = matched.length;
      stats.withParts = matched.filter(r => r.partLocCount > 0 || r.partsUnknown).length;
      recomputePlan();   // calcula lastPlan + stats.targets/skipped* + habilita exec

      $('sa-rax-total').textContent = scanned.length;
      setProgress(1, 'scan completo');
      renderStats('dry-run completo');
      renderSummary();
      renderTable();

      log(`✓ Scan: ${scanned.length} racks · matchean ${matched.length} · a ${ARCHIVE_FLAG ? 'archivar' : 'desarchivar'}: ${stats.targets} · en uso: ${stats.skippedInUse} · sin equipo: ${stats.skippedNoEquip} · partes?: ${stats.skippedUnknown}`, 'ok');

      downloadJSON({
        mode: 'dry-run',
        action: ARCHIVE_FLAG ? 'archive' : 'unarchive',
        pattern: String(RACK_TYPE_RE),
        includeInUse: lastIncludeInUse,
        generated: new Date().toISOString(),
        stats: { ...stats },
        summaryByType: summarizeByType(matched),
        targets: lastPlan.targets,
        skippedInUse: lastPlan.skippedInUse,
        skippedNoEquip: lastPlan.skippedNoEquip,
        skippedUnknown: lastPlan.skippedUnknown,
      }, `archive_ra_racks_dryrun_${Date.now()}.json`);

      if (stats.targets === 0) log('⚠ Nada que procesar con el filtro/toggle actual.', 'skip');
    } catch (e) {
      stats.errors++; renderStats('error'); log(`⚠ ${String(e).slice(0, 200)}`, 'err');
    } finally {
      running = false;
      $('sa-rax-dry').disabled = false; $('sa-rax-dry').style.opacity = '1';
      $('sa-rax-cancel').disabled = true; $('sa-rax-cancel').style.opacity = '0.5';
    }
  }

  // ---- Exec -----------------------------------------------------------------
  async function runExec() {
    if (running || !lastPlan) return;
    recomputePlan();   // anti-staleness: plan = estado ACTUAL del toggle
    const targets = lastPlan.targets;
    if (!targets.length) return;
    const verb = ARCHIVE_FLAG ? 'archivar' : 'DESARCHIVAR';
    const ok = confirm(
      `¿${verb} ${targets.length} racks cuyo tipo matchea ${String(RACK_TYPE_RE)}?\n\n` +
      `Incluir racks con partes encima: ${lastIncludeInUse ? 'SÍ' : 'NO'}.\n` +
      `Reversible (mismo input con archive:${ARCHIVE_FLAG ? 'false' : 'true'}).\n` +
      `Excluidos — en uso: ${lastPlan.skippedInUse.length} · sin equipo: ${lastPlan.skippedNoEquip.length} · partes?: ${lastPlan.skippedUnknown.length}.\n` +
      `Concurrencia: ${CONCURRENCY}.`
    );
    if (!ok) return;

    running = true; cancelled = false;
    stats.archived = 0; stats.errors = 0;
    $('sa-rax-dry').disabled = true; $('sa-rax-dry').style.opacity = '0.5';
    $('sa-rax-exec').disabled = true; $('sa-rax-exec').style.opacity = '0.5';
    $('sa-rax-cancel').disabled = false; $('sa-rax-cancel').style.opacity = '1';
    log(`▶ Ejecutando ${verb} de ${targets.length} racks…`, 'info');

    const results = [];
    async function archiveOne(r) {
      if (cancelled || processedIds.has(r.rackId)) return; // no re-archivar tras cancel/re-run
      try {
        const d = await withRetry(
          () => gql('ArchiveRackChecked', { input: { rackId: r.rackId, archive: ARCHIVE_FLAG, equipmentId: r.equipmentId, equipmentAction: 'none' } }),
          `ArchiveRackChecked ${r.rackId}`, 1   // mutación: máx 1 reintento (no garantizada idempotente)
        );
        if (!d || !d.archiveRackChecked) throw new Error('la mutación devolvió null'); // no contar falso éxito
        processedIds.add(r.rackId);
        stats.archived++;
        results.push({ rackId: r.rackId, name: r.name, rackTypeName: r.rackTypeName, ok: true });
        log(`✓ ${r.name} (id=${r.rackId}) ${ARCHIVE_FLAG ? 'archivado' : 'desarchivado'}`, 'ok');
      } catch (e) {
        stats.errors++;
        results.push({ rackId: r.rackId, name: r.name, rackTypeName: r.rackTypeName, ok: false, error: String(e).slice(0, 200) });
        log(`⚠ ${r.name} (id=${r.rackId}): ${String(e).slice(0, 120)}`, 'err');
      } finally {
        setProgress((stats.archived + stats.errors) / targets.length, `${stats.archived + stats.errors}/${targets.length}`);
        renderStats('ejecutando');
      }
    }

    for (let i = 0; i < targets.length && !cancelled; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(archiveOne));
      if (SLEEP_PER_BATCH_MS && !cancelled) await new Promise(r => setTimeout(r, SLEEP_PER_BATCH_MS));
    }

    running = false;
    $('sa-rax-cancel').disabled = true; $('sa-rax-cancel').style.opacity = '0.5';
    $('sa-rax-dry').disabled = false; $('sa-rax-dry').style.opacity = '1';
    if (!cancelled) {   // acción única: bloquear re-ejecución del mismo plan
      $('sa-rax-exec').disabled = true; $('sa-rax-exec').style.opacity = '0.5';
      $('sa-rax-exec').textContent = '✓ Ejecutado';
    }
    renderStats(cancelled ? 'cancelado' : 'exec completo');
    log(cancelled ? '⏹ Cancelado' : `✓ Listo: ${stats.archived} hechos, ${stats.errors} errores`, cancelled ? 'err' : 'ok');

    downloadJSON({
      mode: 'execute',
      action: ARCHIVE_FLAG ? 'archive' : 'unarchive',
      pattern: String(RACK_TYPE_RE),
      cancelled,
      generated: new Date().toISOString(),
      stats: { ...stats },
      results,
    }, `archive_ra_racks_exec_${Date.now()}.json`);
  }

  $('sa-rax-dry').onclick = runDry;
  $('sa-rax-exec').onclick = runExec;
  $('sa-rax-cancel').onclick = () => { if (running) { cancelled = true; log('⏹ Cancelando…', 'err'); } };
  // Cambiar el toggle tras el dry-run recalcula plan + tabla en vivo (anti-staleness).
  $('sa-rax-include-inuse').onchange = () => {
    if (!scanned.length || running) return;
    recomputePlan();
    renderStats('dry-run completo'); renderSummary(); renderTable();
  };

  // Para inspección/manual debugging desde consola.
  window.__SARackArchiver = { matchesType, slimRack, computeTargets, summarizeByType, RACK_TYPE_RE, HASHES };

  console.log('🗄 archive-racks-by-type listo. Clic "Dry-run (analizar)".');
})();
