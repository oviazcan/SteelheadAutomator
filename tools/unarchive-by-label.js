// unarchive-by-label.js
// One-shot DevTools script: DESARCHIVAR todos los números de parte archivados,
// EXCEPTO los que tengan la etiqueta "Borrado definitivo".
//
// (Sustituye a unarchive-non-schneider.js: se quitó el filtro por cliente —
//  la protección vive únicamente en la etiqueta. Decidido con Omar 2026-07-01,
//  tras etiquetar la basura como 'Borrado definitivo'.)
//
// Regla del filtro:
//   - Etiqueta PROTEGIDA = "Borrado definitivo" (match por nombre normalizado:
//     sin acentos, sin distinguir mayúsculas, espacios colapsados). Si NO aparece
//     en el catálogo escaneado, el panel avisa fuerte (un typo dejaría la
//     protección sin efecto y desarchivaría todo).
//
// Opcional (default ON): marca el check de "validación de ingeniería" a cada PN
//   desarchivado, vía la mutación GRANULAR CreateProcessNodePartNumberOptInout
//   (no toca el resto del PN).
//
// Cómo funciona:
//   AllPartNumbers acepta includeArchived como enum (validado 2026-05-21, ver
//   docs/applets/bulk-upload.md §1.2.13): 'NO'=solo activos, 'YES'=activos+archivados,
//   'EXCLUSIVELY'=SOLO archivados ← lo que usamos (una sola pasada).
//
// Flujo: pegar → "Escanear archivados" → dry-run (conteos + tabla) → "Desarchivar".
//
// Cómo correrlo:
//   1. Abrir Steelhead (app.gosteelhead.com) y loguearse.
//   2. DevTools → Console. Pegar este archivo entero + Enter.
//   3. Click "▶ Escanear archivados".
//   4. Revisar el resumen dry-run: etiqueta protegida encontrada, conteo + tabla.
//   5. Click "Desarchivar (N)" (rojo) → confirmar en el dialog.
//   6. Al terminar descarga `unarchive_results.json`.
//
// Seguridad:
//   - Dry-run OBLIGATORIO antes de mutar. Solo toca `archivedAt` (→ null) + opt-in.
//   - IDEMPOTENTE: re-correrlo es seguro.
//   - CANCELABLE: el botón "Cancelar" para en cuanto termine el in-flight.
//   - Concurrencia 3 (evita el 403 por ráfaga observado en corridas previas).

(async () => {
  'use strict';

  const HASHES = {
    AllPartNumbers:   '827be6815fa644ea35f4982ea8eca8a451500b078112e6e8244f505d0f1cfe09',
    UpdatePartNumber: 'af584fa8ebb7487fc84de18fa3a5e360e99699a3280185fe98b840c157bbf2c7',
    // Mutación GRANULAR del opt-in (marca el check de "validación de ingeniería").
    // Capturada por el hash-scanner (scan 2026-07-01) con processNodeId 231174.
    // Solo toca el opt-in — NO es SavePartNumber (que sería REPLACE y borraría
    // labels/proceso/dims/specs/customInputs). Vars: {partNumberId, processNodeId,
    // processNodeOccurrence, cancelOthers}.
    CreateProcessNodePartNumberOptInout: 'f6fe26e4494c8c91d076975a8d7e89ed2f90a487d05f8bc021c2e296f3d6124f',
  };
  const APOLLO_VERSION = '4.0.8';
  const PAGE_SIZE   = 500;
  const CONCURRENCY = 3;
  const SLEEP_PER_BATCH_MS = 60;
  const MAX_PREVIEW_ROWS = 500;

  // ── Filtro ──
  const PROTECT_LABEL = 'Borrado definitivo';  // etiqueta que PROTEGE del desarchivado

  // Normaliza: sin acentos, minúsculas, espacios colapsados, trim.
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  const PROTECT_LABEL_NORM = norm(PROTECT_LABEL);
  const hasProtectLabel = (pn) => (pn.labels || []).some(l => norm(l.name) === PROTECT_LABEL_NORM);

  // ── Validación de ingeniería ──
  // Process nodes de "validación de ingeniería / 1er artículo"
  // (config.steelhead.domain.validacionProcessNodeIds). Marcar = crear el opt-in a
  // cada uno (el scanCount:2 del scan confirma una llamada por node).
  const VALIDACION_NODE_IDS = [231176, 231174];
  // Regex para reconocer un opt-in ya existente (idempotencia sin pre-check pesado).
  const DUP_RE = /duplicate|unique|already|exists|violat|constraint/i;

  // ── GraphQL (persisted queries; idéntico a producción) ──
  async function gql(op, vars) {
    const body = {
      operationName: op,
      variables: vars,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
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

  // ── Slim de un nodo PN (memoria) ──
  const slim = (n) => ({
    id: n.id,
    name: n.name,
    createdAt: n.createdAt || null,
    customer: n.customerByCustomerId?.name || '',
    labels: (n.partNumberLabelsByPartNumberId?.nodes || [])
      .map(x => x.labelByLabelId).filter(Boolean)
      .map(l => ({ id: l.id, name: l.name })),
  });

  // Escanea y devuelve los PNs ARCHIVADOS (slim) en UNA sola pasada con
  // includeArchived:'EXCLUSIVELY' (devuelve exclusivamente archivados). Dedup por
  // id contra drift de paginación (filas insertadas entre páginas en un scan largo).
  async function scanArchived(onProgress) {
    const archived = [];
    const seen = new Set();
    let offset = 0, total = null;
    while (!cancelled) {
      const data = await withRetry(
        () => gql('AllPartNumbers', { orderBy: ['ID_ASC'], offset, first: PAGE_SIZE, searchQuery: '', includeArchived: 'EXCLUSIVELY' }),
        `AllPartNumbers off=${offset}`
      );
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) {
        const tc = data?.pagedData?.totalCount;
        total = (typeof tc === 'number' && tc > 0) ? tc : null;
      }
      for (const n of nodes) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        archived.push(slim(n));   // todo lo que viene ES archivado
      }
      const processed = offset + nodes.length;
      onProgress && onProgress({ processed, total, kept: archived.length });
      if (nodes.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return archived;
  }

  // ── Estado ──
  let cancelled = false;
  let running = false;
  let candidates = [];   // PNs a desarchivar (tras filtro)
  const results = [];
  const execStats = { total: 0, done: 0, unarchived: 0, errors: 0, validated: 0, alreadyValidated: 0, validationErrors: 0 };

  // ── UI ──
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  document.getElementById('sa-unarch-panel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'sa-unarch-panel';
  panel.style.cssText = `
    position:fixed;top:12px;right:12px;z-index:9999999;width:520px;max-height:92vh;overflow:auto;
    background:#1c2430;color:#e6e9ee;border-radius:12px;padding:16px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
    box-shadow:0 12px 40px rgba(0,0,0,0.55);border:1px solid #2b3646;`;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="color:#13a36f;font-size:15px">📤 Desarchivar PNs (por etiqueta)</b>
      <button id="sa-un-close" style="background:#2b3646;color:#e6e9ee;border:none;border-radius:6px;padding:4px 10px;cursor:pointer">✕</button>
    </div>
    <div style="color:#93a1b5;font-size:12px;margin-bottom:10px;line-height:1.5">
      Desarchiva TODOS los PNs archivados, EXCEPTO los que tengan la etiqueta
      <b style="color:#e6e9ee">${PROTECT_LABEL}</b>. Escanea (dry-run) antes de mutar.
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;color:#e6e9ee;cursor:pointer">
      <input type="checkbox" id="sa-un-validate" checked>
      Marcar también el check de <b>validación de ingeniería</b> (opt-in a nodes ${VALIDACION_NODE_IDS.join(', ')})
    </label>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button id="sa-un-scan" style="flex:1;background:#13a36f;color:#08130d;border:none;border-radius:8px;padding:10px;font-weight:700;cursor:pointer">▶ Escanear archivados</button>
      <button id="sa-un-cancel" disabled style="background:#2b3646;color:#e6e9ee;border:none;border-radius:8px;padding:10px 14px;cursor:pointer;opacity:0.5">⏹ Cancelar</button>
    </div>
    <div id="sa-un-bar" style="height:8px;background:#0f1620;border-radius:5px;overflow:hidden;display:none;margin-bottom:6px">
      <div id="sa-un-fill" style="height:100%;background:#13a36f;transition:width .2s;width:0%"></div>
    </div>
    <div id="sa-un-prog" style="font-size:11px;color:#93a1b5;font-family:ui-monospace,monospace;margin-bottom:8px"></div>
    <div id="sa-un-summary" style="display:none"></div>
    <div id="sa-un-exec-wrap" style="display:none;margin-top:10px">
      <button id="sa-un-exec" style="width:100%;background:#c0392b;color:#fff;border:none;border-radius:8px;padding:12px;font-weight:700;cursor:pointer">Desarchivar (<span id="sa-un-exec-n">0</span>)</button>
    </div>
    <div id="sa-un-execstats" style="font-size:11px;color:#93a1b5;font-family:ui-monospace,monospace;line-height:1.6;margin-top:8px"></div>
    <div id="sa-un-log" style="margin-top:8px;max-height:200px;overflow:auto;background:#0f1620;padding:8px;border-radius:6px;font-family:ui-monospace,monospace;font-size:10px;line-height:1.4;color:#c3ccd8;display:none"></div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('sa-un-close').onclick = () => panel.remove();

  function log(msg, cls = '') {
    const el = $('sa-un-log'); el.style.display = 'block';
    const div = document.createElement('div');
    if (cls === 'err') div.style.color = '#f08a7a';
    else if (cls === 'ok') div.style.color = '#4ade80';
    else if (cls === 'warn') div.style.color = '#f2c14e';
    div.textContent = msg;
    el.appendChild(div); el.scrollTop = el.scrollHeight;
  }

  function setBar(fraction) {
    $('sa-un-bar').style.display = 'block';
    $('sa-un-fill').style.width = `${Math.round(Math.min(Math.max(fraction || 0, 0), 1) * 100)}%`;
  }

  // Progreso de scan (una sola pasada 'EXCLUSIVELY').
  function onScanProgress({ processed, total, kept }) {
    setBar(total ? Math.min(processed / total, 1) : null);
    $('sa-un-prog').textContent = `Escaneando archivados… ${fmt(processed)}${total ? '/' + fmt(total) : ''} · ${fmt(kept)} archivados`;
  }

  // Renderiza el resumen dry-run (todo con DOM API / textContent — XSS-safe).
  function renderSummary(archived) {
    const protectedPNs = archived.filter(pn => hasProtectLabel(pn));
    candidates = archived.filter(pn => !hasProtectLabel(pn));

    // ¿Existe la etiqueta protegida en TODO el catálogo escaneado?
    const labelSeen = protectedPNs.length > 0;

    // Desglose de candidates por cliente (top 12).
    const byCust = new Map();
    for (const pn of candidates) byCust.set(pn.customer || '(sin cliente)', (byCust.get(pn.customer || '(sin cliente)') || 0) + 1);
    const topCust = [...byCust.entries()].sort((a, b) => b[1] - a[1]);

    const wrap = $('sa-un-summary');
    wrap.style.display = 'block';
    wrap.innerHTML = '';

    const box = (bg, border) => {
      const d = document.createElement('div');
      d.style.cssText = `background:${bg};border-left:3px solid ${border};border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:12px;line-height:1.55`;
      return d;
    };
    const b = (parent, text, color) => { const s = document.createElement('b'); s.textContent = text; if (color) s.style.color = color; parent.appendChild(s); };
    const t = (parent, text) => parent.appendChild(document.createTextNode(text));

    // Totales
    const bTot = box('#141c27', '#13a36f');
    b(bTot, `${fmt(archived.length)}`, '#13a36f'); t(bTot, ` PNs archivados escaneados`);
    bTot.appendChild(document.createElement('br'));
    b(bTot, `${fmt(candidates.length)}`, '#4ade80'); t(bTot, ` se DESARCHIVARÁN`);
    bTot.appendChild(document.createElement('br'));
    const valNote = document.createElement('span'); valNote.id = 'sa-un-valnote';
    const paintValNote = () => { valNote.textContent = $('sa-un-validate').checked ? `+ se marcará validación de ingeniería (nodes ${VALIDACION_NODE_IDS.join(', ')})` : `sin marcar validación de ingeniería`; };
    paintValNote();
    $('sa-un-validate').onchange = paintValNote;  // refleja el toggle tras escanear
    bTot.appendChild(valNote);
    wrap.appendChild(bTot);

    // Etiqueta protegida
    const bLbl = box('#141c27', labelSeen ? '#a855f7' : '#c0392b');
    if (labelSeen) { b(bLbl, `${fmt(protectedPNs.length)}`, '#c9a4f5'); t(bLbl, ` protegidos por etiqueta "${PROTECT_LABEL}" (NO se desarchivan)`); }
    else { const w = document.createElement('b'); w.style.color = '#f08a7a'; w.textContent = `⚠ La etiqueta "${PROTECT_LABEL}" NO aparece en ningún PN archivado`; bLbl.appendChild(w); bLbl.appendChild(document.createElement('br')); t(bLbl, '  Verifica el nombre exacto ANTES de ejecutar — si hay typo, se desarchivaría TODO.'); }
    wrap.appendChild(bLbl);

    // Top clientes a desarchivar
    if (topCust.length) {
      const bC = box('#141c27', '#334155');
      b(bC, 'Desarchivado por cliente (top 12):', '#93a1b5');
      for (const [cust, c] of topCust.slice(0, 12)) { bC.appendChild(document.createElement('br')); t(bC, `  • ${cust} — ${fmt(c)}`); }
      if (topCust.length > 12) { bC.appendChild(document.createElement('br')); t(bC, `  … +${topCust.length - 12} clientes más`); }
      wrap.appendChild(bC);
    }

    // Tabla preview (primeros MAX_PREVIEW_ROWS)
    if (candidates.length) {
      const trimmed = candidates.length > MAX_PREVIEW_ROWS;
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:#93a1b5;margin:4px 0';
      note.textContent = trimmed ? `Muestra ${MAX_PREVIEW_ROWS} de ${fmt(candidates.length)} (todos se procesan al ejecutar):` : `Preview (${fmt(candidates.length)}):`;
      wrap.appendChild(note);
      const scroll = document.createElement('div');
      scroll.style.cssText = 'max-height:220px;overflow:auto;background:#0f1620;border-radius:6px';
      const tbl = document.createElement('table');
      tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px';
      const thead = document.createElement('thead');
      thead.innerHTML = `<tr style="color:#93a1b5;position:sticky;top:0;background:#0f1620"><th style="text-align:left;padding:4px">PN</th><th style="text-align:left;padding:4px">Cliente</th><th style="text-align:left;padding:4px">Creado</th></tr>`;
      tbl.appendChild(thead);
      const tb = document.createElement('tbody');
      const frag = document.createDocumentFragment();
      candidates.slice(0, MAX_PREVIEW_ROWS).forEach(pn => {
        const tr = document.createElement('tr'); tr.style.borderTop = '1px solid #1b2532';
        const td1 = document.createElement('td'); td1.style.padding = '3px 4px'; td1.textContent = pn.name || '';
        const td2 = document.createElement('td'); td2.style.cssText = 'padding:3px 4px;color:#93a1b5'; td2.textContent = pn.customer || '(sin cliente)';
        const td3 = document.createElement('td'); td3.style.cssText = 'padding:3px 4px;color:#93a1b5'; td3.textContent = pn.createdAt ? new Date(pn.createdAt).toLocaleDateString('es-MX') : '?';
        tr.append(td1, td2, td3); frag.appendChild(tr);
      });
      tb.appendChild(frag); tbl.appendChild(tb); scroll.appendChild(tbl); wrap.appendChild(scroll);
    }

    // Habilitar botón de ejecución
    $('sa-un-exec-n').textContent = fmt(candidates.length);
    $('sa-un-exec-wrap').style.display = candidates.length ? 'block' : 'none';
  }

  // ── Handlers ──
  $('sa-un-cancel').onclick = () => { if (!running) return; cancelled = true; log('⏹ Cancelando…', 'warn'); };

  $('sa-un-scan').onclick = async () => {
    if (running) return;
    running = true; cancelled = false;
    $('sa-un-scan').disabled = true; $('sa-un-scan').style.opacity = '0.5';
    $('sa-un-cancel').disabled = false; $('sa-un-cancel').style.opacity = '1';
    $('sa-un-summary').style.display = 'none'; $('sa-un-exec-wrap').style.display = 'none';
    try {
      log('Escaneando archivados (includeArchived: EXCLUSIVELY)…');
      const archived = await scanArchived(onScanProgress);
      if (cancelled) { log('⏹ Escaneo cancelado.', 'warn'); return; }
      setBar(1);
      $('sa-un-prog').textContent = `Escaneo completo · ${fmt(archived.length)} PNs archivados`;
      log(`✓ ${archived.length} PNs archivados`, 'ok');
      renderSummary(archived);
      log(`→ ${candidates.length} a desarchivar tras filtro`, 'ok');
    } catch (e) {
      log(`✗ Error en escaneo: ${String(e).slice(0, 160)}`, 'err');
      alert('Error en escaneo: ' + String(e).slice(0, 200));
    } finally {
      running = false;
      $('sa-un-scan').disabled = false; $('sa-un-scan').style.opacity = '1';
      $('sa-un-cancel').disabled = true; $('sa-un-cancel').style.opacity = '0.5';
    }
  };

  $('sa-un-exec').onclick = async () => {
    if (running || !candidates.length) return;
    const doValidate = $('sa-un-validate').checked;
    const ok = confirm(
      `¿DESARCHIVAR ${candidates.length} números de parte?\n\n` +
      `Protegidos (NO se tocan): etiqueta "${PROTECT_LABEL}".\n` +
      `• archivedAt→null (idempotente).\n` +
      (doValidate
        ? `• Marcar validación de ingeniería (opt-in a nodes ${VALIDACION_NODE_IDS.join(', ')}) — mutación granular, NO borra nada del PN.\n`
        : `• Validación de ingeniería: NO se marcará.\n`) +
      `Concurrencia ${CONCURRENCY}.`
    );
    if (!ok) return;

    running = true; cancelled = false;
    $('sa-un-exec').disabled = true; $('sa-un-exec').style.opacity = '0.5';
    $('sa-un-scan').disabled = true; $('sa-un-scan').style.opacity = '0.5';
    $('sa-un-validate').disabled = true;
    $('sa-un-cancel').disabled = false; $('sa-un-cancel').style.opacity = '1';
    Object.assign(execStats, { total: candidates.length, done: 0, unarchived: 0, errors: 0, validated: 0, alreadyValidated: 0, validationErrors: 0 });

    const updateExec = () => {
      setBar(execStats.total ? execStats.done / execStats.total : 0);
      $('sa-un-execstats').innerHTML = '';
      const rows = [
        ['Progreso', `${fmt(execStats.done)} / ${fmt(execStats.total)}`, '#e6e9ee'],
        ['✓ Desarchivados', fmt(execStats.unarchived), '#4ade80'],
        ['⚠ Errores desarchivado', fmt(execStats.errors), execStats.errors ? '#f08a7a' : '#93a1b5'],
      ];
      if (doValidate) {
        rows.push(
          ['✓ Validación marcada', fmt(execStats.validated), '#4ade80'],
          ['↻ Ya tenían validación', fmt(execStats.alreadyValidated), '#f2c14e'],
          ['⚠ Errores validación', fmt(execStats.validationErrors), execStats.validationErrors ? '#f08a7a' : '#93a1b5'],
        );
      }
      for (const [k, v, c] of rows) {
        const d = document.createElement('div'); d.textContent = `${k}: `;
        const s = document.createElement('b'); s.textContent = v; s.style.color = c; d.appendChild(s);
        $('sa-un-execstats').appendChild(d);
      }
    };
    updateExec();

    // Marca la validación de ingeniería en un PN: crea el opt-in a cada node.
    // Idempotente: un opt-in preexistente devuelve error de duplicado → se cuenta
    // como "ya tenía" (no error). Devuelve 'validated' | 'already' | 'error'.
    async function markValidation(pn) {
      let anyCreated = false, anyErr = null;
      for (const nodeId of VALIDACION_NODE_IDS) {
        if (cancelled) break;
        try {
          await withRetry(
            () => gql('CreateProcessNodePartNumberOptInout', { partNumberId: pn.id, processNodeId: nodeId, processNodeOccurrence: 1, cancelOthers: false }),
            `OptIn ${pn.name} node=${nodeId}`
          );
          anyCreated = true;
        } catch (e) {
          if (DUP_RE.test(String(e))) continue;        // ya existía → benigno
          anyErr = String(e).slice(0, 200);
        }
      }
      if (anyErr) return { state: 'error', error: anyErr };
      return { state: anyCreated ? 'validated' : 'already' };
    }

    async function worker(pn) {
      if (cancelled) return;
      const rec = { id: pn.id, pn: pn.name, customer: pn.customer };
      try {
        await withRetry(() => gql('UpdatePartNumber', { id: pn.id, archivedAt: null }), `UpdatePartNumber ${pn.name}`);
        execStats.unarchived++; rec.status = 'unarchived';
      } catch (e) {
        execStats.errors++; rec.status = 'error'; rec.error = String(e).slice(0, 200);
        results.push(rec);
        log(`✗ ${pn.name}: ${String(e).slice(0, 80)}`, 'err');
        execStats.done++; updateExec();
        return;  // no intentar validar si el desarchivado falló
      }

      if (doValidate && !cancelled) {
        const v = await markValidation(pn);
        rec.validation = v.state;
        if (v.state === 'validated') execStats.validated++;
        else if (v.state === 'already') execStats.alreadyValidated++;
        else { execStats.validationErrors++; rec.validationError = v.error; log(`⚠ validación ${pn.name}: ${(v.error || '').slice(0, 70)}`, 'warn'); }
      }
      results.push(rec);
      execStats.done++; updateExec();
    }

    for (let i = 0; i < candidates.length && !cancelled; i += CONCURRENCY) {
      await Promise.all(candidates.slice(i, i + CONCURRENCY).map(worker));
      if (SLEEP_PER_BATCH_MS && !cancelled) await new Promise(r => setTimeout(r, SLEEP_PER_BATCH_MS));
    }

    running = false;
    $('sa-un-cancel').disabled = true; $('sa-un-cancel').style.opacity = '0.5';
    $('sa-un-scan').disabled = false; $('sa-un-scan').style.opacity = '1';
    $('sa-un-validate').disabled = false;
    $('sa-un-exec').disabled = false; $('sa-un-exec').style.opacity = '1';
    log(cancelled ? '⏹ Cancelado' : '✓ Completo', cancelled ? 'warn' : 'ok');

    const out = {
      generated: new Date().toISOString(), cancelled,
      filter: { protectLabel: PROTECT_LABEL },
      markValidation: doValidate, validacionNodeIds: doValidate ? VALIDACION_NODE_IDS : [],
      stats: execStats, results,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'unarchive_results.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('✓ Descargado unarchive_results.json', 'ok');
  };

  console.log('📤 Panel de desarchivado (por etiqueta) listo. Click "Escanear archivados".');
})();
