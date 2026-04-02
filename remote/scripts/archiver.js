// Steelhead Part Number Archiver
// Archives PNs based on inactivity date criteria
// Depends on: SteelheadAPI

const PNArchiver = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // Fetch all active (non-archived) PNs with pagination
  async function fetchAllActivePNs(onProgress, pageSize = 500) {
    const allPNs = [];
    let offset = 0;
    while (true) {
      const data = await api().query('AllPartNumbers', {
        orderBy: ['ID_ASC'], offset, first: pageSize, searchQuery: ''
      }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      // Only include non-archived PNs
      const active = nodes.filter(n => !n.archivedAt);
      allPNs.push(...active);
      if (onProgress) onProgress(`Cargando PNs... ${allPNs.length}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return allPNs;
  }

  // Get PN detail with usage data (work orders, invoices, etc.)
  async function getPartNumberUsage(pnId) {
    try {
      const data = await api().query('GetPartNumber', { partNumberId: pnId, usagesLimit: 1, usagesOffset: 0 });
      const pn = data?.partNumberById;
      if (!pn) return null;
      return {
        id: pn.id,
        name: pn.name,
        createdAt: pn.createdAt,
        archivedAt: pn.archivedAt,
        customer: pn.customerByCustomerId?.name || '',
        // Check for activity in related entities
        hasWorkOrders: (pn.workOrdersByPartNumberId?.nodes?.length || 0) > 0,
        hasInvoices: (pn.invoiceLinesByPartNumberId?.nodes?.length || 0) > 0,
        hasQuotes: (pn.quotePartNumberPricesByPartNumberId?.nodes?.length || 0) > 0,
        hasPrices: (pn.partNumberPricesByPartNumberId?.nodes?.length || 0) > 0,
      };
    } catch (_) { return null; }
  }

  // Main archive flow
  async function run(options) {
    const { cutoffDate, dateType, enableValidation } = options;
    const DOMAIN = api().getDomain();
    const cutoff = new Date(cutoffDate);
    const results = { found: 0, archived: 0, validated: 0, errors: [] };

    log(`Archivador: fecha corte ${cutoffDate}, tipo: ${dateType}, validación: ${enableValidation}`);

    // Show progress UI
    showArchiverUI('Buscando números de parte activos...');

    // Fetch all active PNs
    const allPNs = await fetchAllActivePNs((msg) => updateArchiverUI(msg), 500);
    log(`  ${allPNs.length} PNs activos encontrados`);
    updateArchiverUI(`${allPNs.length} PNs activos. Analizando actividad...`);

    // Step 1: Pre-filter by creation date
    const candidates = [];
    for (const pn of allPNs) {
      if (pn.createdAt && new Date(pn.createdAt) < cutoff) {
        candidates.push(pn);
      }
    }
    log(`  ${candidates.length} PNs creados antes de ${cutoffDate}`);

    const toArchive = [];

    if (dateType === 'utilizacion') {
      // Step 2a: Get all WO PN IDs (batch approach)
      // Use createdAtAfter to only get WOs since a reasonable date (avoid loading ALL history)
      // We want WOs that prove a PN is "in use" — any WO ever means the PN was used
      updateArchiverUI(`Cargando órdenes de trabajo...`);
      const woPNIds = new Set();
      let woOffset = 0;
      while (true) {
        try {
          const woData = await api().query('AllWorkOrders', {
            status: null, includeArchived: 'YES', couponWorkOrders: null, computeMargins: false,
            orderBy: ['ID_DESC'], offset: woOffset, first: 500, searchQuery: ''
          }, 'AllWorkOrders');
          const woNodes = woData?.pagedData?.nodes || [];
          if (!woNodes.length) break;

          for (const wo of woNodes) {
            // Extract PN IDs from work order
            const pnWOs = wo.partNumberWorkOrdersByWorkOrderId?.nodes || [];
            for (const pnWO of pnWOs) {
              const pnId = pnWO.partNumberId || pnWO.partNumberByPartNumberId?.id;
              if (pnId) woPNIds.add(pnId);
            }
          }

          updateArchiverUI(`OTs: página ${Math.floor(woOffset / 500) + 1}, ${woPNIds.size} PNs con OT encontrados`);
          if (woNodes.length < 500) break;
          woOffset += 500;
        } catch (e) {
          warn(`AllWorkOrders offset ${woOffset}: ${String(e).substring(0, 60)}`);
          break;
        }
      }
      log(`  ${woPNIds.size} PNs con órdenes de trabajo`);

      // Step 2b: Get receiver PN IDs
      updateArchiverUI(`Cargando recibos...`);
      const recPNIds = new Set();
      let recOffset = 0;
      while (true) {
        try {
          const recData = await api().query('AllReceivers', {
            orderBy: ['CREATED_AT_DESC'], offset: recOffset, first: 500, searchQuery: ''
          }, 'AllReceivers');
          const recNodes = recData?.pagedData?.nodes || [];
          if (!recNodes.length) break;

          for (const rec of recNodes) {
            const bomItems = rec.receiverBomItemsByReceiverId?.nodes || [];
            for (const item of bomItems) {
              const pnId = item.partNumberId || item.partNumberByPartNumberId?.id;
              if (pnId) recPNIds.add(pnId);
            }
          }

          updateArchiverUI(`Recibos: página ${Math.floor(recOffset / 500) + 1}, ${recPNIds.size} PNs con recibos`);
          if (recNodes.length < 500) break;
          recOffset += 500;
        } catch (e) {
          warn(`AllReceivers offset ${recOffset}: ${String(e).substring(0, 60)}`);
          break;
        }
      }
      log(`  ${recPNIds.size} PNs con recibos`);

      // Step 2c: If batch approach found 0 PNs (nodes might be collapsed), fallback to individual
      const usedPNIds = new Set([...woPNIds, ...recPNIds]);

      if (usedPNIds.size === 0 && candidates.length > 0) {
        log('  WARN: Batch approach returned 0 PNs used — fallback to individual check');
        updateArchiverUI(`Verificación individual (batch no disponible)...`);
        for (let i = 0; i < candidates.length; i++) {
          const pn = candidates[i];
          if (i % 5 === 0) updateArchiverUI(`Verificando ${i + 1}/${candidates.length} (${Math.round(i/candidates.length*100)}%) — ${toArchive.length} sin uso`);
          try {
            const detail = await api().query('GetPartNumber', { partNumberId: pn.id, usagesLimit: 1, usagesOffset: 0 });
            const pnData = detail?.partNumberById;
            if (!pnData) continue;
            const hasWO = (pnData.workOrderPartNumberTreatmentStationsByPartNumberId?.nodes?.length || 0) > 0;
            if (!hasWO) {
              toArchive.push({ id: pn.id, name: pn.name, createdAt: pn.createdAt, customer: pn.customerByCustomerId?.name || '', reason: 'Sin OTs ni recibos', selected: true });
            }
          } catch (_) {}
        }
      } else {
        // Cross-reference: candidates not in usedPNIds
        updateArchiverUI(`Cruzando datos: ${candidates.length} candidatos vs ${usedPNIds.size} PNs con actividad...`);
        for (const pn of candidates) {
          if (!usedPNIds.has(pn.id)) {
            toArchive.push({ id: pn.id, name: pn.name, createdAt: pn.createdAt, customer: pn.customerByCustomerId?.name || '', reason: 'Sin OTs ni recibos', selected: true });
          }
        }
      }
    } else {
      for (const pn of candidates) {
        toArchive.push({ id: pn.id, name: pn.name, createdAt: pn.createdAt, customer: pn.customerByCustomerId?.name || '',
          reason: dateType === 'creacion' ? `Creado antes de ${cutoffDate}` : `Sin actividad antes de ${cutoffDate}`, selected: true });
      }
    }

    log(`  ${toArchive.length} PNs para archivar (de ${candidates.length} candidatos)`);
    results.found = toArchive.length;

    if (!toArchive.length) {
      showArchiverResult(results, 'No se encontraron PNs para archivar.');
      return results;
    }

    // Show preview with checkboxes
    const selectedPNs = await showArchiverPreview(toArchive, cutoffDate, dateType, enableValidation);
    if (!selectedPNs) { log('Cancelado.'); return { cancelled: true }; }

    updateArchiverUI(`Archivando ${selectedPNs.length} PNs...`);

    // Archive selected PNs
    for (let i = 0; i < selectedPNs.length; i++) {
      const pn = selectedPNs[i];
      updateArchiverUI(`Archivando ${i + 1}/${selectedPNs.length}: ${pn.name}`);

      // Archive
      try {
        await api().query('UpdatePartNumber', { id: pn.id, archivedAt: new Date().toISOString() });
        results.archived++;
      } catch (e) {
        results.errors.push(`Archivar "${pn.name}": ${String(e).substring(0, 80)}`);
        continue;
      }

      // Set validation if enabled
      if (enableValidation) {
        try {
          const nodeIds = DOMAIN.validacionProcessNodeIds || [];
          const optInOuts = nodeIds.map(id => ({ processNodeId: id, processNodeOccurrence: 1, cancelOthers: false }));
          await api().query('SavePartNumber', { input: [{
            id: pn.id, name: pn.name, optInOuts,
            specsToApply: [], paramsToApply: [], partNumberDimensions: [], partNumberLocations: [],
            dimensionCustomValueIds: [], partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
            partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
            partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [],
            specFieldParamUpdates: [], labelIds: [], ownerIds: [], defaults: [],
            inventoryPredictedUsages: []
          }] });
          results.validated++;
        } catch (e) {
          // Silencioso — el PN ya se archivó, solo falla la validación
          warn(`Validación "${pn.name}": ${String(e).substring(0, 80)}`);
        }
      }
    }

    log(`\n=== ARCHIVADOR RESULTADO ===`);
    log(`Archivados: ${results.archived}/${selectedPNs.length}`);
    if (enableValidation) log(`Con validación: ${results.validated}`);
    if (results.errors.length) log(`Errores: ${results.errors.length}`);

    showArchiverResult(results);
    return results;
  }

  // ── UI ──
  function showArchiverUI(msg) {
    let ov = document.getElementById('sa-archiver-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-archiver-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#1a2e1a"><h2 style="color:#4ade80">Archivador Masivo</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-arch-bar" style="background:#4ade80"></div></div><div class="dl9-progress" id="sa-arch-text"></div></div>`;
      document.body.appendChild(ov);
    }
    document.getElementById('sa-arch-text').textContent = msg;
  }

  function updateArchiverUI(msg) {
    const el = document.getElementById('sa-arch-text');
    if (el) el.textContent = msg;
  }

  function removeArchiverUI() {
    const ov = document.getElementById('sa-archiver-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  function showArchiverPreview(pns, cutoffDate, dateType, enableValidation) {
    return new Promise(resolve => {
      removeArchiverUI();
      if (!document.getElementById('dl9-styles')) {
        const s = document.createElement('style'); s.id = 'dl9-styles';
        s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#ef4444;color:white}`;
        document.head.appendChild(s);
      }

      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';

      const dateLabel = dateType === 'creacion' ? 'creación' : dateType === 'modificacion' ? 'modificación' : 'utilización';

      md.innerHTML = `
        <h2 style="color:#4ade80">Archivador Masivo — Preview</h2>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">
          ${pns.length} PNs con fecha de ${dateLabel} anterior a ${cutoffDate}
          ${enableValidation ? ' + activar validación de ingeniería' : ''}
        </p>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input type="checkbox" checked id="sa-arch-selectall">
          <label for="sa-arch-selectall" style="font-size:12px;color:#94a3b8">Seleccionar todos</label>
          <span style="font-size:12px;color:#4ade80;margin-left:auto" id="sa-arch-count">${pns.length} seleccionados</span>
        </div>
        <div style="max-height:300px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <tr style="color:#94a3b8;border-bottom:1px solid #334155"><th style="text-align:left;padding:4px"><input type="checkbox" checked id="sa-arch-th-check"></th><th style="text-align:left;padding:4px">PN</th><th style="text-align:left;padding:4px">Cliente</th><th style="text-align:left;padding:4px">Creado</th><th style="text-align:left;padding:4px">Razón</th></tr>
            ${pns.map((p, i) => `<tr style="border-bottom:1px solid #1e293b">
              <td style="padding:3px"><input type="checkbox" checked class="sa-arch-check" data-idx="${i}"></td>
              <td style="padding:3px">${p.name}</td>
              <td style="padding:3px;color:#94a3b8;font-size:11px">${p.customer}</td>
              <td style="padding:3px;color:#94a3b8;font-size:11px">${p.createdAt ? new Date(p.createdAt).toLocaleDateString('es-MX') : '?'}</td>
              <td style="padding:3px;color:#4ade80;font-size:11px">${p.reason || ''}</td>
            </tr>`).join('')}
          </table>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-arch-cancel">CANCELAR</button>
          <button class="dl9-btn dl9-btn-exec" id="sa-arch-exec">ARCHIVAR (<span id="sa-arch-exec-count">${pns.length}</span>)</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      const updateCount = () => {
        const checked = md.querySelectorAll('.sa-arch-check:checked').length;
        document.getElementById('sa-arch-count').textContent = `${checked} seleccionados`;
        document.getElementById('sa-arch-exec-count').textContent = checked;
      };

      md.querySelector('#sa-arch-selectall').onchange = (e) => {
        md.querySelectorAll('.sa-arch-check').forEach(cb => { cb.checked = e.target.checked; });
        updateCount();
      };
      md.querySelectorAll('.sa-arch-check').forEach(cb => { cb.onchange = updateCount; });

      document.getElementById('sa-arch-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      document.getElementById('sa-arch-exec').onclick = () => {
        const selected = [];
        md.querySelectorAll('.sa-arch-check:checked').forEach(cb => {
          selected.push(pns[parseInt(cb.dataset.idx)]);
        });
        ov.parentNode.removeChild(ov);
        resolve(selected);
      };
    });
  }

  function showArchiverResult(results, msg) {
    removeArchiverUI();
    alert(msg || `Archivador completado:\n\n` +
      `PNs encontrados: ${results.found}\n` +
      `Archivados: ${results.archived}\n` +
      (results.validated ? `Con validación: ${results.validated}\n` : '') +
      (results.errors.length ? `Errores: ${results.errors.length}\n${results.errors.slice(0, 5).join('\n')}` : '')
    );
  }

  return { run };
})();

if (typeof window !== 'undefined') window.PNArchiver = PNArchiver;
