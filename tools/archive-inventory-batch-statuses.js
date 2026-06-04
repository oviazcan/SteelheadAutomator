// archive-inventory-batch-statuses.js
// One-shot DevTools script: PANEL interactivo para archivar registros del
// catálogo InventoryBatchStatus ("estatus de lotes de inventario") cuando la UI
// nativa falla con "An unexpected error occurred." al disparar
// ArchiveInventoryBatchStatus.
//
// CAUSA DEL BUG NATIVO (CONFIRMADA 2026-06-03):
//   ArchiveInventoryBatchStatus truena con "An unexpected error occurred" cuando
//   el estatus tiene LOTES parados en ese estado (probable violación de FK /
//   validación faltante en el backend de Steelhead). Si el estatus está VACÍO,
//   archiva sin problema. El valor de archivedAt es IRRELEVANTE (ISO o "NOW" dan
//   igual) — se descartó vía pruebas.
//   WORKAROUND: vaciar/migrar los lotes de ese estado a otro estatus, luego
//   archivar. Este script archiva los que ya estén vacíos y, para los que tengan
//   lotes, reporta el fallo como "en uso" en vez del error crudo.
//
// QUÉ HACE:
//   - Lista TODOS los statuses de un inventory type (con su color e id) y te deja
//     seleccionar con checkboxes cuáles archivar.
//   - Dropdown para cambiar de inventory type.
//   - Marca el estatus default del type y avisa de transiciones entrantes
//     (otros estatus que apuntan al seleccionado como "next") antes de archivar.
//   - Archiva los seleccionados, re-consulta y confirma. Descarga un JSON.
//
// CÓMO CORRER:
//   1. Abre app.gosteelhead.com logueado → DevTools → Console.
//   2. Pega este archivo y Enter. Aparece un panel arriba a la derecha.
//   3. Elige el type, marca los estatus a archivar, click "Archivar".
//
// SEGURO / IDEMPOTENTE: los ya archivados salen deshabilitados. Solo toca
// archivedAt vía ArchiveInventoryBatchStatus (reversible vía unarchive).

(async () => {
  const HASHES = {
    ConfigureInventoryBatchStatusesQuery: 'e6bd0b40f5adbad5df1b86ff135c5a7a7a3d0203989f7c9c3925a20a6313aa73',
    ArchiveInventoryBatchStatus:          '10865607bb10ff407dc2324eb005e9cf6d8ee2c8cef1507b3fbe0d3e62e0baed',
    InventoryBatchViewQuery:              'e4fc4cdf098f41e10881a512e63ce6fb068bcd8d5bd57b8627c86e5fda025d44'
  };

  const DEFAULT_TYPE_ID = 2191; // Números de Parte
  const COUNT_CONCURRENCY = 3;  // llamadas simultáneas al contar lotes

  const SLEEP_MS = 120;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const sanitizeColor = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : '#64748b';

  // ── GraphQL ──
  async function gqlRaw(op, vars) {
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
    return r.json();
  }
  async function gql(op, vars) {
    const j = await gqlRaw(op, vars);
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── Archivar un status (ArchiveInventoryBatchStatus) ──
  // El resolver truena con "An unexpected error occurred" SOLO si el estatus
  // tiene lotes en ese estado (errors presente). Cuando está vacío, archiva bien
  // y devuelve data.archiveInventoryBatchStatus = null (¡sin errors!). Por eso el
  // éxito se mide por AUSENCIA de errors, NO por el valor del campo (que es null
  // en ambos casos). archivedAt es irrelevante (mandamos ISO por higiene).
  async function archiveOne(id) {
    const archivedAt = new Date().toISOString();
    const j = await gqlRaw('ArchiveInventoryBatchStatus', { input: { id, archivedAt } });
    if (!j.errors) return { ok: true, archivedAt };
    return { ok: false, errors: j.errors };
  }

  // ── Contar lotes ACTIVOS (no archivados) en un estatus ──
  // InventoryBatchViewQuery filtra por inventoryBatchStatusIdFilter y devuelve
  // pagedData.totalCount. Con first:1 no traemos los nodos, solo el conteo.
  // Si totalCount > 0, ArchiveInventoryBatchStatus va a truenar (estatus en uso).
  async function countBatchesInStatus(statusId) {
    const data = await gql('InventoryBatchViewQuery', {
      includeArchived: 'NO',
      orderBy: ['CREATED_AT_DESC'],
      offset: 0, first: 1,
      inventoryBatchStatusIdFilter: [statusId],
      searchQuery: ''
    });
    return data?.pagedData?.totalCount ?? null;
  }

  // ── Estado ──
  let types = [];          // [{id,name,defaultBatchStatusId}]
  let statuses = [];       // nodos del type actual
  let currentTypeId = DEFAULT_TYPE_ID;
  let busy = false;
  const selected = new Set();
  const counts = new Map(); // statusId -> totalCount de lotes activos (o null si error)

  async function loadType(typeId) {
    const data = await gql('ConfigureInventoryBatchStatusesQuery', { typeId });
    types = (data?.allInventoryTypes?.nodes || []).map(t => ({
      id: t.id, name: t.name, defaultBatchStatusId: t.defaultBatchStatusId ?? null
    }));
    statuses = (data?.allInventoryBatchStatuses?.nodes || []).slice()
      .sort((a, b) => Number(a.id) - Number(b.id));
    currentTypeId = typeId;
    selected.clear();
    counts.clear();
  }

  const curType = () => types.find(t => Number(t.id) === Number(currentTypeId)) || null;
  const incomingCount = (s) => (s.inventoryBatchStatusesByNextStatusId?.nodes || []).length;
  const nextName = (s) => s.inventoryBatchStatusByNextStatusId?.name || null;

  // ── UI ──
  const old = document.getElementById('sa-ibs-panel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'sa-ibs-panel';
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 9999999;
    width: 560px; max-height: 92vh; display:flex; flex-direction:column;
    background: #1e293b; color: #e2e8f0; border-radius: 10px; padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="color:#38bdf8;font-size:15px">🏷 Archivar estatus de lotes</b>
      <button id="sa-ibs-close" style="background:#475569;color:#e2e8f0;border:none;border-radius:4px;padding:4px 10px;cursor:pointer">✕</button>
    </div>
    <div style="margin-bottom:10px">
      <label style="display:block;color:#94a3b8;margin-bottom:4px;font-size:12px">Inventory type:</label>
      <select id="sa-ibs-type" style="width:100%;padding:6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px"></select>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:12px;color:#94a3b8;flex-wrap:wrap">
      <button id="sa-ibs-count" style="background:#0e7490;color:#e0f2fe;border:none;border-radius:5px;padding:5px 10px;cursor:pointer;font-weight:600">🔍 Contar lotes en uso</button>
      <button id="sa-ibs-all" style="background:#334155;color:#e2e8f0;border:none;border-radius:5px;padding:5px 10px;cursor:pointer">Todos</button>
      <button id="sa-ibs-none" style="background:#334155;color:#e2e8f0;border:none;border-radius:5px;padding:5px 10px;cursor:pointer">Ninguno</button>
      <label style="margin-left:auto;display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" id="sa-ibs-showarch"> mostrar archivados
      </label>
    </div>
    <div id="sa-ibs-list" style="flex:1;overflow:auto;background:#0f172a;border-radius:6px;padding:6px;min-height:120px"></div>
    <button id="sa-ibs-exec" disabled style="margin-top:10px;background:#dc2626;color:white;border:none;border-radius:6px;padding:11px;font-weight:600;cursor:pointer;opacity:0.5">▶ Archivar seleccionados (0)</button>
    <div id="sa-ibs-log" style="margin-top:8px;max-height:200px;overflow:auto;background:#0f172a;padding:8px;border-radius:4px;font-family:monospace;font-size:10px;line-height:1.4;color:#cbd5e1;display:none"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('sa-ibs-close').onclick = () => panel.remove();

  function log(msg, cls = '') {
    const el = $('sa-ibs-log');
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

  function refreshExecBtn() {
    const n = selected.size;
    const btn = $('sa-ibs-exec');
    btn.textContent = `▶ Archivar seleccionados (${n})`;
    btn.disabled = busy || n === 0;
    btn.style.opacity = (busy || n === 0) ? '0.5' : '1';
  }

  function renderTypes() {
    const sel = $('sa-ibs-type');
    sel.replaceChildren();
    for (const t of types) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = `${t.name} (#${t.id})`;
      if (Number(t.id) === Number(currentTypeId)) o.selected = true;
      sel.appendChild(o);
    }
  }

  function pill(text, bg, fg) {
    const s = document.createElement('span');
    s.textContent = text;
    s.style.cssText = `font-size:10px;padding:1px 6px;border-radius:8px;background:${bg};color:${fg};white-space:nowrap`;
    return s;
  }

  function renderStatuses() {
    const list = $('sa-ibs-list');
    list.replaceChildren();
    const showArch = $('sa-ibs-showarch').checked;
    const def = curType()?.defaultBatchStatusId ?? null;
    const visible = statuses.filter(s => showArch || !s.archivedAt);

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#64748b;padding:14px;text-align:center';
      empty.textContent = 'Sin estatus para mostrar.';
      list.appendChild(empty);
      return;
    }

    for (const s of visible) {
      const archived = !!s.archivedAt;
      const row = document.createElement('label');
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;cursor:${archived ? 'default' : 'pointer'};${archived ? 'opacity:0.45' : ''}`;
      row.onmouseenter = () => { if (!archived) row.style.background = '#1e293b'; };
      row.onmouseleave = () => { row.style.background = ''; };

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = archived || busy;
      cb.checked = selected.has(Number(s.id));
      cb.onchange = () => {
        if (cb.checked) selected.add(Number(s.id)); else selected.delete(Number(s.id));
        refreshExecBtn();
      };

      const swatch = document.createElement('span');
      swatch.style.cssText = `width:16px;height:16px;border-radius:4px;flex:none;border:1px solid rgba(255,255,255,0.2);background:${sanitizeColor(s.color)}`;
      swatch.title = s.color || '';

      const idEl = document.createElement('span');
      idEl.textContent = `#${s.id}`;
      idEl.style.cssText = 'font-family:monospace;color:#64748b;flex:none;width:46px';

      const nameEl = document.createElement('span');
      nameEl.textContent = s.name ?? '(sin nombre)';
      nameEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

      const colorEl = document.createElement('span');
      colorEl.textContent = s.color || '';
      colorEl.style.cssText = 'font-family:monospace;color:#475569;font-size:10px;flex:none';

      row.append(cb, swatch, idEl, nameEl, colorEl);

      // Conteo de lotes en uso (si ya se corrió el detector)
      if (counts.has(Number(s.id)) && !archived) {
        const c = counts.get(Number(s.id));
        if (c === null) row.appendChild(pill('lotes: ?', '#1f2937', '#94a3b8'));
        else if (c === 0) row.appendChild(pill('✓ 0 lotes', '#064e3b', '#6ee7b7'));
        else row.appendChild(pill(`🔴 ${c} lote${c === 1 ? '' : 's'}`, '#4c0519', '#fda4af'));
      }

      const nn = nextName(s);
      if (nn) row.appendChild(pill(`→ ${nn}`, '#0f172a', '#64748b'));
      const inc = incomingCount(s);
      if (inc > 0) row.appendChild(pill(`←${inc}`, '#3f2d12', '#fbbf24'));
      if (Number(s.id) === Number(def)) row.appendChild(pill('default', '#3f2d12', '#fbbf24'));
      if (archived) row.appendChild(pill('archivado', '#1f2937', '#94a3b8'));

      list.appendChild(row);
    }
  }

  async function reload(typeId) {
    busy = true; refreshExecBtn();
    try {
      await loadType(typeId);
      renderTypes();
      renderStatuses();
    } catch (e) {
      log(`✗ Error cargando type ${typeId}: ${String(e).slice(0, 160)}`, 'err');
    } finally {
      busy = false; refreshExecBtn();
    }
  }

  $('sa-ibs-type').onchange = (e) => reload(Number(e.target.value));
  $('sa-ibs-showarch').onchange = renderStatuses;
  $('sa-ibs-all').onclick = () => {
    statuses.filter(s => !s.archivedAt).forEach(s => selected.add(Number(s.id)));
    renderStatuses(); refreshExecBtn();
  };
  $('sa-ibs-none').onclick = () => { selected.clear(); renderStatuses(); refreshExecBtn(); };

  $('sa-ibs-count').onclick = async () => {
    if (busy) return;
    const targets = statuses.filter(s => !s.archivedAt);
    if (!targets.length) return;
    busy = true; refreshExecBtn();
    const btn = $('sa-ibs-count');
    btn.disabled = true; btn.style.opacity = '0.5';
    log(`Contando lotes activos en ${targets.length} estatus…`, 'info');
    for (let i = 0; i < targets.length; i += COUNT_CONCURRENCY) {
      const batch = targets.slice(i, i + COUNT_CONCURRENCY);
      await Promise.all(batch.map(async (s) => {
        try { counts.set(Number(s.id), await countBatchesInStatus(Number(s.id))); }
        catch (e) { counts.set(Number(s.id), null); log(`  ✗ #${s.id}: ${String(e).slice(0, 90)}`, 'err'); }
      }));
      renderStatuses();
    }
    const free = targets.filter(s => counts.get(Number(s.id)) === 0).length;
    const inUse = targets.filter(s => (counts.get(Number(s.id)) || 0) > 0).length;
    log(`✓ Conteo: ${free} archivable(s) (0 lotes), ${inUse} en uso. Los 🔴 hay que vaciarlos primero.`, 'ok');
    btn.disabled = false; btn.style.opacity = '1';
    busy = false; refreshExecBtn(); renderStatuses();
  };

  $('sa-ibs-exec').onclick = async () => {
    if (busy || !selected.size) return;
    const ids = [...selected];
    const chosen = statuses.filter(s => ids.includes(Number(s.id)) && !s.archivedAt);
    if (!chosen.length) return;

    const def = curType()?.defaultBatchStatusId ?? null;
    const warnDefault = chosen.filter(s => Number(s.id) === Number(def));
    const warnIncoming = chosen.filter(s => incomingCount(s) > 0);
    const warnInUse = chosen.filter(s => (counts.get(Number(s.id)) || 0) > 0);

    let msg = `¿Archivar ${chosen.length} estatus del type "${curType()?.name}"?\n\n`;
    msg += chosen.map(s => `  #${s.id}  ${s.name}`).join('\n');
    if (warnInUse.length) {
      msg += `\n\n🔴 CON LOTES en uso (van a fallar — vacíalos/migra primero):\n`;
      msg += warnInUse.map(s => `   #${s.id} ${s.name} (${counts.get(Number(s.id))} lotes)`).join('\n');
    }
    if (warnDefault.length) {
      msg += `\n\n⚠ DEFAULT del type: ${warnDefault.map(s => `#${s.id} ${s.name}`).join(', ')}.\n`;
      msg += `   Archivarlo puede dejar el type sin estatus inicial.`;
    }
    if (warnIncoming.length) {
      msg += `\n\n⚠ Con transiciones entrantes (otros estatus apuntan a éstos como "next"):\n`;
      msg += warnIncoming.map(s => `   #${s.id} ${s.name} (←${incomingCount(s)})`).join('\n');
    }
    msg += `\n\nNota: si no corriste "Contar lotes", un estatus en uso saldrá como`;
    msg += ` "en uso" al intentar (limitación del backend) y habrá que vaciarlo.`;
    if (!confirm(msg)) return;

    busy = true; refreshExecBtn(); renderStatuses();
    const results = [];
    let inUseCount = 0;

    for (const s of chosen) {
      const r = await archiveOne(s.id);
      if (r.ok) {
        log(`✓ #${s.id} ("${s.name}") archivado.`, 'ok');
        results.push({ id: s.id, name: s.name, status: 'archived', archivedAt: r.archivedAt });
      } else {
        // El resolver truena cuando el estatus tiene lotes en ese estado.
        inUseCount++;
        log(`✗ #${s.id} ("${s.name}") NO se archivó — probablemente tiene LOTES en ese estado. Vacíalo/migra y reintenta.`, 'err');
        results.push({ id: s.id, name: s.name, status: 'error_in_use', detail: r.errors });
      }
      await sleep(SLEEP_MS);
    }
    if (inUseCount) {
      log(`⚠ ${inUseCount} no se archivaron por tener lotes en uso. Migra esos lotes a otro estatus y reintenta.`, 'skip');
    }

    // Verificar: recargar el type. La re-consulta es la fuente de verdad final
    // (reconcilia cualquier discrepancia con lo que reportó la mutación).
    log('Verificando…', 'info');
    await loadType(currentTypeId);
    const byId = new Map(statuses.map(s => [Number(s.id), s]));
    for (const r of results) {
      const s = byId.get(Number(r.id));
      r.verified = !!(s && s.archivedAt);
      r.verifiedArchivedAt = s ? s.archivedAt : null;
      // La verificación manda: si quedó archivado, es 'archived' pase lo que pase.
      if (r.verified) r.status = 'archived';
      else if (r.status === 'archived') r.status = 'reported_ok_but_not_verified';
    }
    const okCount = results.filter(r => r.verified).length;
    log(`=== ${okCount}/${chosen.length} confirmados archivados ===`, okCount === chosen.length ? 'ok' : 'skip');

    renderTypes(); renderStatuses();
    busy = false; refreshExecBtn();
    downloadJSON({ mode: 'exec', typeId: currentTypeId, typeName: curType()?.name, results },
      `archive-batch-status_EXEC.json`);
    log('✓ JSON descargado.', 'ok');
  };

  // Init
  await reload(DEFAULT_TYPE_ID);
  console.log('🏷 Panel de estatus de lotes listo.');
})();
