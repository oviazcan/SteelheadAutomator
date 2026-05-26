// test-null-param-fix.js
// Script standalone para DevTools — dry-run / apply de la regla null-only
// (bulk-upload 1.4.38 + spec-migrator 0.4.3) sobre UN solo PN.
//
// Regla aplicada:
//   • Agrupar params vivos (archivedAt=null) por specFieldId (el SpecField es el
//     contenedor — sólo puede vivir 1 param por SpecField).
//   • Sub-agrupar por sfpId (specFieldParamId). Decisión del winner:
//       - 1 sfpId distinto → auto (regla null).
//       - 2+ sfpIds CON MISMO paramName → auto: duplicación pura. Winner = sfpId
//         que ya tenga un NULL (o el más reciente si varios). Conservar 1 NULL,
//         archivar resto.
//       - 2+ sfpIds con paramName DISTINTO → manual: requiere radio. Default
//         pre-seleccionado = sfpId que tiene rows con processNode (es el que
//         bulk-upload acaba de validar). Usuario puede cambiarlo.
//   • Una vez decidido el winner: insertar 1 row NULL del winner si no existe,
//     y archivar TODOS los demás rows del SpecField (nulls duplicados del
//     winner + todos los con processNode + todos los sfpIds perdedores).
//
// Cómo usar:
//   1. Abre app.gosteelhead.com en Chrome y autentícate.
//   2. Abre DevTools → Console.
//   3. Pega TODO este archivo y dale Enter.
//   4. Aparece un panel flotante. Pega el partNumberId (entero) y click "Dry-run".
//   5. Revisa el plan en la tabla. Si todo OK, click "Aplicar" para ejecutar
//      el SavePartNumber (archive) + AddParamsToPartNumber (insert null).
//
// Origen del config:
//   - Si window.REMOTE_CONFIG existe (extensión cargada) lo usa.
//   - Si no, fetch a https://oviazcan.github.io/SteelheadAutomator/config.json.
//
// 2026-05-25 — Omar Viazcán + Claude (Opus 4.7)

(async () => {
  'use strict';

  if (window.__SATestNullParamFix?.openModal) {
    window.__SATestNullParamFix.openModal();
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

  const REQUIRED = ['GetPartNumber', 'SavePartNumber', 'AddParamsToPartNumber'];
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

  // ═══════════════════════════════════════════════════════════════════════
  // 2) LÓGICA — calcular plan a partir de allParams (dry-run puro)
  // ═══════════════════════════════════════════════════════════════════════
  function computePlan(allParams) {
    // Agrupar params vivos por specFieldId (el SpecField agrupa: sólo 1 param vivo por SpecField).
    const bySpecField = new Map();
    for (const p of allParams) {
      if (p.archivedAt || !p.specFieldParamBySpecFieldParamId) continue;
      const sfp = p.specFieldParamBySpecFieldParamId;
      const sfs = sfp.specFieldSpecBySpecFieldSpecId;
      const sf = sfs?.specFieldBySpecFieldId;
      if (!sf?.id) continue;
      if (!bySpecField.has(sf.id)) {
        bySpecField.set(sf.id, {
          specFieldId: sf.id,
          specFieldName: sf.name || '?',
          isGeneric: !!sfs?.isGeneric,
          rows: [],
        });
      }
      bySpecField.get(sf.id).rows.push(p);
    }

    const groups = [];
    for (const g of bySpecField.values()) {
      // Sub-agrupar por sfpId (como string para evitar type mismatches con el value del radio).
      const bySfp = new Map();
      for (const p of g.rows) {
        const sfpId = String(p.specFieldParamBySpecFieldParamId.id);
        if (!bySfp.has(sfpId)) {
          bySfp.set(sfpId, {
            sfpId,
            paramName: p.specFieldParamBySpecFieldParamId.name || '?',
            rows: [],
          });
        }
        bySfp.get(sfpId).rows.push(p);
      }
      const sfpOptions = Array.from(bySfp.values());
      // Auto-decidable si:
      //   • 1 solo sfpId, O
      //   • Todos los sfpIds comparten el mismo paramName (duplicación pura).
      const firstName = sfpOptions[0].paramName;
      const sameName = sfpOptions.every(o => o.paramName === firstName);
      const autoDecidable = sfpOptions.length === 1 || sameName;
      const winnerSfpId = autoDecidable
        ? pickAutoWinner(sfpOptions)
        : pickManualDefaultWinner(sfpOptions);
      groups.push({
        specFieldId: g.specFieldId,
        specFieldName: g.specFieldName,
        isGeneric: g.isGeneric,
        sfpOptions,
        autoDecidable,
        winnerSfpId,
      });
    }
    return groups;
  }

  // Auto: prefiere el sfpId que ya tenga un row NULL (más reciente). Sin null,
  // el sfpId con row.id más alto.
  function pickAutoWinner(sfpOptions) {
    const withNull = sfpOptions.filter(o => o.rows.some(r => !r.processNodeId));
    const pool = withNull.length ? withNull : sfpOptions;
    return pool.slice().sort((a, b) => {
      const aMax = Math.max(...a.rows.filter(r => withNull.length ? !r.processNodeId : true).map(r => Number(r.id)));
      const bMax = Math.max(...b.rows.filter(r => withNull.length ? !r.processNodeId : true).map(r => Number(r.id)));
      return bMax - aMax;
    })[0].sfpId;
  }

  // Manual default: prefiere el sfpId que tenga rows con processNode (último
  // que bulk-upload insertó). Sin processNode, fallback al row.id más alto.
  function pickManualDefaultWinner(sfpOptions) {
    const withProc = sfpOptions.filter(o => o.rows.some(r => !!r.processNodeId));
    const pool = withProc.length ? withProc : sfpOptions;
    return pool.slice().sort((a, b) => {
      const aMax = Math.max(...a.rows.filter(r => withProc.length ? !!r.processNodeId : true).map(r => Number(r.id)));
      const bMax = Math.max(...b.rows.filter(r => withProc.length ? !!r.processNodeId : true).map(r => Number(r.id)));
      return bMax - aMax;
    })[0].sfpId;
  }

  // Calcula el delta (archive + insert) para UN grupo dado su winnerSfpId actual.
  // Si winnerSfpId es null → grupo pendiente (no contribuye).
  function computeGroupAction(group) {
    if (!group.winnerSfpId) {
      return { archiveIds: [], insertWinner: null, summary: 'PENDIENTE: elige param ganador', pending: true };
    }
    const winner = group.sfpOptions.find(o => o.sfpId === group.winnerSfpId);
    if (!winner) {
      return { archiveIds: [], insertWinner: null, summary: 'ERROR: winner inválido', pending: true };
    }
    const archiveIds = [];
    let insertWinner = null;
    let parts = [];

    const nulls = winner.rows.filter(r => !r.processNodeId);
    const nonNulls = winner.rows.filter(r => r.processNodeId);

    if (nulls.length === 0) {
      insertWinner = { specFieldId: group.specFieldId, specFieldParamId: winner.sfpId, isGeneric: group.isGeneric, specFieldName: group.specFieldName, paramName: winner.paramName };
      for (const r of nonNulls) archiveIds.push(r.id);
      parts.push(`INSERT null "${winner.paramName}"`);
      if (nonNulls.length) parts.push(`ARCHIVE ${nonNulls.length} con processNode`);
    } else {
      const sortedNulls = nulls.slice().sort((a, b) => Number(b.id) - Number(a.id));
      for (const r of sortedNulls.slice(1)) archiveIds.push(r.id);
      for (const r of nonNulls) archiveIds.push(r.id);
      if (archiveIds.length) parts.push(`KEEP null "${winner.paramName}" + ARCHIVE ${archiveIds.length}`);
      else parts.push(`OK (1 null único "${winner.paramName}")`);
    }

    // Archivar TODOS los rows de sfpIds perdedores (cualquier processNodeId).
    let loserRowsCount = 0;
    for (const opt of group.sfpOptions) {
      if (opt.sfpId === group.winnerSfpId) continue;
      for (const r of opt.rows) {
        archiveIds.push(r.id);
        loserRowsCount++;
      }
    }
    if (loserRowsCount) parts.push(`ARCHIVE ${loserRowsCount} de ${group.sfpOptions.length - 1} sfpId perdedor(es)`);

    return { archiveIds, insertWinner, summary: parts.join(' + '), pending: false };
  }

  // Agrega los deltas de todos los grupos para el plan total.
  function aggregatePlan(groups) {
    const idsToArchive = [];
    const inserts = [];
    let pending = 0;
    for (const g of groups) {
      const a = computeGroupAction(g);
      if (a.pending) { pending++; continue; }
      for (const id of a.archiveIds) idsToArchive.push(id);
      if (a.insertWinner) inserts.push(a.insertWinner);
    }
    return { idsToArchive, inserts, pending };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3) APPLY — ejecutar SavePartNumber + AddParamsToPartNumber
  // ═══════════════════════════════════════════════════════════════════════
  async function applyPlan(pnNode, idsToArchive, inserts, logFn) {
    const results = { archived: 0, inserted: 0, errors: [] };

    if (idsToArchive.length) {
      const cleanupInput = {
        id: pnNode.id,
        name: pnNode.name,
        customerId: pnNode.customerId,
        defaultProcessNodeId: pnNode.defaultProcessNodeId,
        inputSchemaId: DOMAIN.inputSchemaId_PN,
        customInputs: pnNode.customInputs || {},
        geometryTypeId: pnNode.geometryTypeId || null,
        userFileName: null,
        inventoryItemInput: null,
        glAccountId: null, taxCodeId: null, certPdfTemplateId: null,
        isOneOff: false, isTemplatePartNumber: false, isCoupon: false,
        partNumberGroupId: pnNode.partNumberGroupId || null,
        descriptionMarkdown: pnNode.descriptionMarkdown || '',
        customerFacingNotes: pnNode.customerFacingNotes || '',
        labelIds: [], ownerIds: [], defaults: [], optInOuts: [],
        inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
        partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [],
        partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
        partNumberSpecFieldParamsToArchive: idsToArchive,
        partNumberSpecFieldParamsToUnarchive: [],
        partNumberSpecClassificationsToUpdate: [],
        partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: []
      };
      try {
        await gql('SavePartNumber', { input: [cleanupInput] });
        results.archived = idsToArchive.length;
        logFn(`✓ SavePartNumber archive ${idsToArchive.length} rows OK`);
      } catch (e) {
        results.errors.push(`SavePartNumber archive: ${String(e).substring(0, 200)}`);
        logFn(`✗ SavePartNumber archive falló: ${String(e).substring(0, 200)}`);
      }
    }

    for (const ins of inserts) {
      // El schema requiere Int para specFieldId y specFieldParamId. computePlan
      // normaliza sfpId a String (para que los radios value/check funcionen),
      // hay que revertir a Number antes de enviar al servidor.
      const pa = {
        specFieldId: Number(ins.specFieldId),
        specFieldParamId: Number(ins.specFieldParamId),
        isGeneric: !!ins.isGeneric,
        geometryTypeSpecFieldId: null,
        processNodeId: null,
        processNodeOccurrence: null,
        locationId: null,
      };
      try {
        await gql('AddParamsToPartNumber', { input: { partNumberId: pnNode.id, paramsToApply: [pa] } });
        results.inserted++;
        logFn(`✓ AddParams "${ins.specFieldName}" = "${ins.paramName}" OK`);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('exclusion constraint') || msg.includes('conflicting key') || msg.includes('23P01')) {
          logFn(`⚠ AddParams "${ins.specFieldName}" ya presente (skip)`);
        } else {
          results.errors.push(`AddParams ${ins.specFieldName}: ${msg.substring(0, 200)}`);
          logFn(`✗ AddParams "${ins.specFieldName}" falló: ${msg.substring(0, 200)}`);
        }
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4) UI — panel flotante
  // ═══════════════════════════════════════════════════════════════════════
  let currentGroups = null;
  let currentAggregate = null;
  let currentPnNode = null;

  const host = document.createElement('div');
  host.id = '__sa-test-null-param-fix';
  host.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 999999;
    width: 720px; max-height: 85vh; overflow: hidden;
    background: #1f2937; color: #e5e7eb; border: 1px solid #374151;
    border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px;
    display: flex; flex-direction: column;
  `;
  host.innerHTML = `
    <div style="padding: 12px 16px; border-bottom: 1px solid #374151; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="font-weight: 600; font-size: 14px;">Test: regla null-only (bulk-upload 1.4.38)</div>
        <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">Dry-run y apply sobre 1 PN</div>
      </div>
      <button id="__sa-close" style="background: transparent; border: none; color: #9ca3af; cursor: pointer; font-size: 18px;">×</button>
    </div>
    <div style="padding: 12px 16px; border-bottom: 1px solid #374151; display: flex; gap: 8px; align-items: center;">
      <label style="font-size: 12px; color: #9ca3af;">partNumberId:</label>
      <input id="__sa-pnid" type="text" placeholder="ID entero del PN (p.ej. 3027939)" style="flex: 1; padding: 6px 8px; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 4px; font-family: monospace; font-size: 12px;" />
      <button id="__sa-dry" style="padding: 6px 12px; background: #4f46e5; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">Dry-run</button>
      <button id="__sa-apply" disabled style="padding: 6px 12px; background: #6b7280; color: #fff; border: none; border-radius: 4px; cursor: not-allowed; font-weight: 500;">Aplicar</button>
    </div>
    <div id="__sa-summary" style="padding: 10px 16px; border-bottom: 1px solid #374151; font-size: 12px; color: #9ca3af;">
      Pega un partNumberId y dale Dry-run.
    </div>
    <div id="__sa-plan" style="overflow: auto; flex: 1; padding: 8px;"></div>
    <div id="__sa-log" style="border-top: 1px solid #374151; padding: 8px 16px; font-family: monospace; font-size: 11px; color: #9ca3af; max-height: 140px; overflow: auto; background: #111827;"></div>
  `;
  document.body.appendChild(host);

  const $ = sel => host.querySelector(sel);
  const logEl = $('#__sa-log');
  function log(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    console.log('[test-null-param-fix]', msg);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderRowsHtml(opt, willArchiveSet) {
    return opt.rows.map(r => {
      const procShort = r.processNodeId != null ? String(r.processNodeId).substring(0, 8) : null;
      const proc = r.processNodeId != null
        ? `proc=${escapeHtml(r.processNodeByProcessNodeId?.name || procShort)}`
        : '<b style="color:#a78bfa">NULL</b>';
      const idShort = String(r.id).substring(0, 8);
      return willArchiveSet.has(r.id)
        ? `<span style="text-decoration: line-through; color: #ef4444;">${idShort} (${proc})</span>`
        : `<span style="color: #10b981;">${idShort} (${proc})</span>`;
    }).join('<br>');
  }

  function renderGroup(group, tbody) {
    const action = computeGroupAction(group);
    const archiveSet = new Set(action.archiveIds);
    const isManual = !group.autoDecidable;
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #1f2937';
    tr.dataset.specFieldId = String(group.specFieldId);
    const sfHeader = `${escapeHtml(group.specFieldName)}${group.isGeneric ? ' <span style="color:#9ca3af; font-size: 10px;">(generic)</span>' : ''}${isManual ? ` <span style="background:#7c2d12; color:#fed7aa; padding:1px 6px; border-radius:3px; font-size:10px; margin-left:4px;">MANUAL (${group.sfpOptions.length} opciones)</span>` : ''}`;

    let optionsHtml = '';
    for (const opt of group.sfpOptions) {
      const isWinner = opt.sfpId === group.winnerSfpId;
      const rowsHtml = renderRowsHtml(opt, archiveSet);
      if (isManual) {
        optionsHtml += `
          <div style="margin-bottom: 6px; padding: 4px; border-left: 2px solid ${isWinner ? '#10b981' : '#374151'}; padding-left: 8px;">
            <label style="display: flex; gap: 6px; align-items: flex-start; cursor: pointer;">
              <input type="radio" name="sf-${group.specFieldId}" value="${escapeHtml(opt.sfpId)}" ${isWinner ? 'checked' : ''} style="margin-top: 2px;" />
              <div>
                <div style="color: ${isWinner ? '#10b981' : '#e5e7eb'}; font-weight: ${isWinner ? '600' : '400'};">${escapeHtml(opt.paramName)}</div>
                <div style="font-family: monospace; font-size: 10px; margin-top: 2px;">${rowsHtml}</div>
              </div>
            </label>
          </div>`;
      } else {
        optionsHtml += `
          <div style="margin-bottom: 4px;">
            <div style="color: #10b981; font-weight: 500;">${escapeHtml(opt.paramName)}</div>
            <div style="font-family: monospace; font-size: 10px; margin-top: 2px;">${rowsHtml}</div>
          </div>`;
      }
    }
    const insertTxt = action.insertWinner ? `<div style="margin-top: 4px; color: #10b981; font-family: monospace; font-size: 10px;">+ INSERT new NULL</div>` : '';
    const actionColor = action.pending ? '#f59e0b' : (action.summary.startsWith('OK') ? '#9ca3af' : action.insertWinner ? '#10b981' : '#f59e0b');
    tr.innerHTML = `
      <td style="padding: 6px; vertical-align: top;">${sfHeader}</td>
      <td style="padding: 6px; vertical-align: top;">${optionsHtml}${insertTxt}</td>
      <td style="padding: 6px; vertical-align: top; color: ${actionColor};">${escapeHtml(action.summary)}</td>
    `;
    tbody.appendChild(tr);

    if (isManual) {
      const radios = tr.querySelectorAll('input[type="radio"]');
      radios.forEach(rb => rb.addEventListener('change', () => {
        if (rb.checked) {
          group.winnerSfpId = rb.value;
          // Re-render only this group + update summary + apply button.
          const next = document.createElement('tbody');
          renderGroup(group, next);
          tr.replaceWith(next.firstChild);
          updateSummaryAndApplyBtn();
        }
      }));
    }
  }

  function updateSummaryAndApplyBtn() {
    if (!currentGroups) return;
    const agg = aggregatePlan(currentGroups);
    currentAggregate = agg;
    const summary = $('#__sa-summary');
    const total = currentGroups.length;
    const touched = currentGroups.filter(g => {
      const a = computeGroupAction(g);
      return !a.pending && (a.archiveIds.length || a.insertWinner);
    }).length;
    const pendingTxt = agg.pending ? ` · <b style="color:#f59e0b">${agg.pending} pendientes (elige opción)</b>` : '';
    summary.innerHTML = `
      <b>${total}</b> grupos SpecField · <b>${touched}</b> con acción ·
      <b style="color:#ef4444">${agg.idsToArchive.length}</b> archivar ·
      <b style="color:#10b981">${agg.inserts.length}</b> insert nuevos NULL${pendingTxt}
    `;
    const btnApply = $('#__sa-apply');
    const canApply = !agg.pending && (agg.idsToArchive.length || agg.inserts.length);
    if (canApply) {
      btnApply.disabled = false;
      btnApply.style.background = '#dc2626';
      btnApply.style.cursor = 'pointer';
    } else {
      btnApply.disabled = true;
      btnApply.style.background = '#6b7280';
      btnApply.style.cursor = 'not-allowed';
    }
  }

  function renderPlan(groups) {
    const planEl = $('#__sa-plan');
    planEl.innerHTML = '';
    if (!groups.length) {
      planEl.innerHTML = '<div style="padding: 16px; text-align: center; color: #9ca3af;">No hay params vivos en este PN.</div>';
      return;
    }
    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11px;';
    table.innerHTML = `
      <thead>
        <tr style="background: #111827;">
          <th style="text-align: left; padding: 6px; border-bottom: 1px solid #374151;">SpecField</th>
          <th style="text-align: left; padding: 6px; border-bottom: 1px solid #374151;">Param(s) y rows</th>
          <th style="text-align: left; padding: 6px; border-bottom: 1px solid #374151;">Acción</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    for (const g of groups) renderGroup(g, tbody);
    planEl.appendChild(table);
    updateSummaryAndApplyBtn();
  }

  $('#__sa-close').addEventListener('click', () => host.remove());

  $('#__sa-dry').addEventListener('click', async () => {
    const raw = $('#__sa-pnid').value.trim();
    if (!raw) { alert('Pega un partNumberId'); return; }
    const pnId = /^\d+$/.test(raw) ? Number(raw) : raw;
    $('#__sa-dry').disabled = true;
    log(`→ GetPartNumber(${pnId})`);
    try {
      const data = await gql('GetPartNumber', { partNumberId: pnId });
      currentPnNode = data?.partNumberById;
      if (!currentPnNode) {
        log(`✗ partNumberById null`);
        $('#__sa-dry').disabled = false;
        return;
      }
      const allParams = currentPnNode.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
      log(`  PN: "${currentPnNode.name}" — ${allParams.length} rows totales (incluye archivados)`);
      currentGroups = computePlan(allParams);
      const manualCount = currentGroups.filter(g => !g.autoDecidable).length;
      if (manualCount) log(`  ${manualCount} grupos MANUAL: elige el param ganador con los radio buttons.`);
      renderPlan(currentGroups);
    } catch (e) {
      log(`✗ ${String(e).substring(0, 200)}`);
    } finally {
      $('#__sa-dry').disabled = false;
    }
  });

  $('#__sa-apply').addEventListener('click', async () => {
    if (!currentAggregate || !currentPnNode || currentAggregate.pending) return;
    const { idsToArchive, inserts } = currentAggregate;
    const msg = `¿Aplicar?\n\n• Archivar ${idsToArchive.length} rows\n• Insertar ${inserts.length} nuevos NULL\n\nPN: ${currentPnNode.name}`;
    if (!confirm(msg)) return;
    $('#__sa-apply').disabled = true;
    $('#__sa-dry').disabled = true;
    log(`→ Aplicando…`);
    try {
      const res = await applyPlan(currentPnNode, idsToArchive, inserts, log);
      log(`✓ DONE — archived=${res.archived} inserted=${res.inserted} errors=${res.errors.length}`);
      if (res.errors.length) {
        for (const e of res.errors) log(`  ! ${e}`);
      }
      log(`  Re-corre Dry-run para verificar el estado final.`);
    } catch (e) {
      log(`✗ ${String(e).substring(0, 200)}`);
    } finally {
      $('#__sa-dry').disabled = false;
    }
  });

  window.__SATestNullParamFix = {
    openModal: () => { if (!document.body.contains(host)) document.body.appendChild(host); },
    computePlan,
  };

  log('Listo. Pega un partNumberId y dale Dry-run.');
})();
