// Steelhead Spec Migrator
// Migrates PNs from one spec to another with parameter selection
// Depends on: SteelheadAPI

const SpecMigrator = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── Parse spec from current URL ──
  function parseSpecFromURL() {
    const url = window.location.href;
    // Pattern: /specs/{idInDomain}/revisions/{revision}
    const match = url.match(/\/specs\/(\d+)\/revisions\/(\d+)/i);
    if (!match) return null;
    return { idInDomain: parseInt(match[1]), revision: parseInt(match[2]) };
  }

  // ── Get spec details including PNs ──
  async function getSpec(idInDomain, revision) {
    const data = await api().query('GetSpec', { idInDomain, revision }, 'GetSpec');
    return data?.specByIdInDomainAndRevisionNumber || null;
  }

  // ── Search specs for dropdown ──
  async function searchSpecs(searchText) {
    const data = await api().query('SearchSpecsForSelect', {
      like: `%${searchText}%`,
      locationIds: [],
      alreadySelectedSpecs: [],
      orderBy: searchText ? ['NATURAL'] : ['NAME_ASC']
    }, 'SearchSpecsForSelect');
    return data?.searchSpecs?.nodes || [];
  }

  // ── Get spec fields and params ──
  async function getSpecFields(specId) {
    const data = await api().query('SpecFieldsAndOptions', { specId }, 'SpecFieldsAndOptions');
    return data?.specById || null;
  }

  // ── Get PN spec summary ──
  async function getPNSpecsSummary(partNumberId) {
    const data = await api().query('PartNumberSpecsSummary', { partNumberId }, 'PartNumberSpecsSummary');
    return data?.partNumberById || null;
  }

  // ── Archive spec at PN level ──
  async function archiveSpecOnPN(partNumberId, partNumberName, partNumberSpecId) {
    await api().query('SavePartNumber', {
      input: [{
        id: partNumberId,
        name: partNumberName,
        specsToApply: [], paramsToApply: [], partNumberDimensions: [], partNumberLocations: [],
        dimensionCustomValueIds: [], partNumberSpecsToArchive: [partNumberSpecId], partNumberSpecsToUnarchive: [],
        partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
        partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [],
        specFieldParamUpdates: [], labelIds: [], ownerIds: [], defaults: [],
        inventoryPredictedUsages: [], optInOuts: []
      }]
    });
  }

  // ── Apply new spec to PN ──
  async function applySpecToPN(partNumberId, specId, defaultSelections, genericSelections) {
    const makeSel = (paramId) => ({
      defaultParamId: paramId,
      geometryTypeSpecFieldId: null,
      locationId: null,
      processNodeId: null,
      processNodeOccurrence: null
    });

    await api().query('ApplySpecsToPartNumber', {
      input: {
        partNumberId,
        specsToApply: [{
          specId,
          classificationSetId: null,
          classificationIds: [],
          defaultSelections: defaultSelections.map(makeSel),
          genericSelections: genericSelections.map(makeSel)
        }]
      }
    }, 'ApplySpecsToPartNumber');
  }

  // ══════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('sa-specm-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-specm-styles';
    s.textContent = `
      .sa-specm-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-specm-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:600px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
      .sa-specm-modal h2{font-size:20px;margin:0 0 12px}
      .sa-specm-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}
      .sa-specm-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
      .sa-specm-btn-cancel{background:#475569;color:#e2e8f0}
      .sa-specm-btn-exec{background:#8b5cf6;color:white}
      .sa-specm-input{width:100%;padding:8px 12px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px;box-sizing:border-box}
      .sa-specm-dropdown{max-height:150px;overflow-y:auto;background:#0f172a;border:1px solid #475569;border-radius:6px;margin-top:4px}
      .sa-specm-dropdown-item{padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #1e293b}
      .sa-specm-dropdown-item:hover{background:#334155}
      .sa-specm-progress{font-size:13px;color:#94a3b8;margin-top:8px}
      .sa-specm-bar{width:100%;height:6px;background:#334155;border-radius:3px;margin-top:12px;overflow:hidden}
      .sa-specm-bar-fill{height:100%;background:#8b5cf6;border-radius:3px;transition:width 0.3s}
    `;
    document.head.appendChild(s);
  }

  function showProgressUI(title, msg) {
    ensureStyles();
    let ov = document.getElementById('sa-specm-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-specm-overlay';
      ov.className = 'sa-specm-overlay';
      ov.innerHTML = `<div class="sa-specm-modal" style="background:#1a1a2e">
        <h2 style="color:#8b5cf6" id="sa-specm-title">${title}</h2>
        <div class="sa-specm-bar"><div class="sa-specm-bar-fill" id="sa-specm-bar" style="width:0%"></div></div>
        <div class="sa-specm-progress" id="sa-specm-text">${msg}</div>
      </div>`;
      document.body.appendChild(ov);
    } else {
      document.getElementById('sa-specm-title').textContent = title;
      document.getElementById('sa-specm-text').textContent = msg;
    }
  }

  function updateProgress(msg, percent) {
    const el = document.getElementById('sa-specm-text');
    if (el) el.textContent = msg;
    if (percent !== undefined) {
      const bar = document.getElementById('sa-specm-bar');
      if (bar) bar.style.width = percent + '%';
    }
  }

  function removeUI() {
    const ov = document.getElementById('sa-specm-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // ── Config form ──
  function showConfigForm(sourceSpec, pnCount) {
    return new Promise((resolve) => {
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'sa-specm-overlay';
      const md = document.createElement('div');
      md.className = 'sa-specm-modal';
      md.style.background = '#1a1a2e';

      md.innerHTML = `
        <h2 style="color:#8b5cf6">🔀 Migrador de Specs</h2>
        <div style="background:#0f172a;padding:12px;border-radius:8px;margin-bottom:16px">
          <div style="font-size:11px;color:#94a3b8">Spec actual:</div>
          <div style="font-size:14px;font-weight:600;color:#e2e8f0">${sourceSpec.name}</div>
          <div style="font-size:12px;color:#8b5cf6;margin-top:4px">${pnCount} números de parte asignados</div>
          ${sourceSpec.archivedAt ? '<div style="font-size:11px;color:#f59e0b;margin-top:4px">⚠️ Spec archivada</div>' : ''}
        </div>

        <div style="margin-bottom:16px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:6px;font-weight:600">Spec destino:</label>
          <input type="text" id="sa-specm-search" class="sa-specm-input" placeholder="Buscar spec..." autocomplete="off">
          <div id="sa-specm-dropdown" class="sa-specm-dropdown" style="display:none"></div>
          <div id="sa-specm-selected" style="display:none;margin-top:8px;padding:8px 12px;background:#1e1b4b;border:1px solid #8b5cf6;border-radius:6px;font-size:13px"></div>
        </div>

        <div id="sa-specm-params-section" style="display:none;margin-bottom:16px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:6px;font-weight:600">Parámetro de espesor:</label>
          <div id="sa-specm-params"></div>
        </div>

        <div class="sa-specm-btnrow">
          <button class="sa-specm-btn sa-specm-btn-cancel" id="sa-specm-cancel">CANCELAR</button>
          <button class="sa-specm-btn sa-specm-btn-exec" id="sa-specm-exec" disabled>MIGRAR</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      let selectedSpec = null;
      let searchTimeout = null;
      let multiParamFields = [];
      let autoDefault = [];
      let autoGeneric = [];

      const searchInput = document.getElementById('sa-specm-search');
      const dropdown = document.getElementById('sa-specm-dropdown');
      const selectedDiv = document.getElementById('sa-specm-selected');
      const paramsSection = document.getElementById('sa-specm-params-section');
      const paramsDiv = document.getElementById('sa-specm-params');
      const execBtn = document.getElementById('sa-specm-exec');

      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
          const q = searchInput.value.trim();
          if (q.length < 2) { dropdown.style.display = 'none'; return; }
          try {
            const results = await searchSpecs(q);
            // Filter out archived specs
            const active = results.filter(s => !s.archivedAt);
            if (!active.length) {
              dropdown.innerHTML = '<div class="sa-specm-dropdown-item" style="color:#64748b">Sin resultados</div>';
            } else {
              dropdown.innerHTML = active.map(s =>
                `<div class="sa-specm-dropdown-item" data-id="${s.id}" data-name="${s.name}">${s.name}${s.revisionName ? ' - Rev. ' + s.revisionName : ''}</div>`
              ).join('');
              dropdown.querySelectorAll('.sa-specm-dropdown-item[data-id]').forEach(item => {
                item.addEventListener('click', () => selectTargetSpec(parseInt(item.dataset.id), item.dataset.name));
              });
            }
            dropdown.style.display = 'block';
          } catch (e) {
            dropdown.innerHTML = '<div class="sa-specm-dropdown-item" style="color:#ef4444">Error buscando</div>';
            dropdown.style.display = 'block';
          }
        }, 300);
      });

      async function selectTargetSpec(specId, specName) {
        selectedSpec = { id: specId, name: specName };
        dropdown.style.display = 'none';
        searchInput.style.display = 'none';
        selectedDiv.textContent = specName;
        selectedDiv.style.display = 'block';
        selectedDiv.style.cursor = 'pointer';
        selectedDiv.title = 'Clic para cambiar';
        selectedDiv.onclick = () => {
          selectedSpec = null;
          multiParamFields = [];
          autoDefault = [];
          autoGeneric = [];
          searchInput.style.display = 'block';
          searchInput.value = '';
          selectedDiv.style.display = 'none';
          paramsSection.style.display = 'none';
          execBtn.disabled = true;
        };

        // Load params
        paramsDiv.innerHTML = '<div style="font-size:12px;color:#94a3b8">Cargando parámetros...</div>';
        paramsSection.style.display = 'block';

        try {
          const specDetail = await getSpecFields(specId);
          const fields = specDetail?.specFieldSpecsBySpecId?.nodes || [];

          // Extract params from defaultValues.nodes (SpecFieldParamsConnection)
          // Fields with 1 param are auto-selected; fields with multiple params need user choice
          multiParamFields = []; // fields where user must choose
          autoDefault = [];      // auto-selected non-generic param IDs
          autoGeneric = [];      // auto-selected generic param IDs

          for (const field of fields) {
            const params = field.defaultValues?.nodes || [];
            const fieldName = field.specFieldBySpecFieldId?.name || '';

            if (params.length === 0) continue;

            if (params.length === 1) {
              // Auto-select single param
              if (field.isGeneric) {
                autoGeneric.push(params[0].id);
              } else {
                autoDefault.push(params[0].id);
              }
              log(`  Auto-select: ${fieldName} → ${params[0].name}`);
            } else {
              // Multiple params — user must choose
              multiParamFields.push({
                fieldName,
                isGeneric: field.isGeneric,
                params: params.map(p => ({ id: p.id, name: p.name }))
              });
            }
          }

          if (!multiParamFields.length) {
            paramsDiv.innerHTML = '<div style="font-size:12px;color:#4ade80">Todos los parámetros auto-seleccionados</div>';
            execBtn.disabled = false;
          } else {
            // Show radio buttons for each multi-param field
            let html = '';
            for (const mpf of multiParamFields) {
              html += `<div style="margin-bottom:8px"><div style="font-size:12px;color:#8b5cf6;font-weight:600;margin-bottom:4px">${mpf.fieldName}:</div>`;
              html += mpf.params.map(p =>
                `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer">
                  <input type="radio" name="sa-specm-field-${mpf.fieldName}" value="${p.id}" data-generic="${mpf.isGeneric}">
                  <span>${p.name}</span>
                </label>`
              ).join('');
              html += '</div>';
            }
            paramsDiv.innerHTML = html;

            // Enable MIGRAR only when all fields have a selection
            const checkAllSelected = () => {
              const allSelected = multiParamFields.every(mpf =>
                paramsDiv.querySelector(`input[name="sa-specm-field-${mpf.fieldName}"]:checked`)
              );
              execBtn.disabled = !allSelected;
            };
            paramsDiv.querySelectorAll('input[type="radio"]').forEach(r => r.addEventListener('change', checkAllSelected));
          }
        } catch (e) {
          paramsDiv.innerHTML = `<div style="font-size:12px;color:#ef4444">Error: ${e.message}</div>`;
        }
      }

      document.getElementById('sa-specm-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      execBtn.addEventListener('click', () => {
        if (!selectedSpec) return;

        // Collect user-selected params
        const userDefault = [];
        const userGeneric = [];
        for (const mpf of multiParamFields) {
          const checked = paramsDiv.querySelector(`input[name="sa-specm-field-${mpf.fieldName}"]:checked`);
          if (checked) {
            const paramId = parseInt(checked.value);
            if (mpf.isGeneric) userGeneric.push(paramId);
            else userDefault.push(paramId);
          }
        }

        ov.parentNode.removeChild(ov);
        resolve({
          targetSpecId: selectedSpec.id,
          targetSpecName: selectedSpec.name,
          defaultSelections: [...autoDefault, ...userDefault],
          genericSelections: [...autoGeneric, ...userGeneric]
        });
      });
    });
  }

  // ── Summary modal ──
  function showSummary(results) {
    ensureStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-specm-overlay';
    const md = document.createElement('div');
    md.className = 'sa-specm-modal';
    md.style.background = '#1a1a2e';

    const hasErrors = results.errors.length > 0;
    const icon = hasErrors ? '⚠️' : '✅';
    const iconColor = hasErrors ? '#f59e0b' : '#4ade80';

    let errorsHTML = '';
    if (results.errors.length > 0) {
      const items = results.errors.slice(0, 15).map(e => `<div style="font-size:11px;color:#fca5a5;padding:1px 0">${e}</div>`).join('');
      errorsHTML = `<div style="margin-top:12px"><div style="font-size:12px;color:#ef4444;font-weight:600;margin-bottom:4px">Errores (${results.errors.length}):</div>${items}</div>`;
    }

    md.innerHTML = `
      <h2 style="color:${iconColor}">${icon} Migración Completada</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:16px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#4ade80">${results.migrated}</div>
          <div style="font-size:11px;color:#94a3b8">Migrados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#f59e0b">${results.alreadyArchived}</div>
          <div style="font-size:11px;color:#94a3b8">Ya archivados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#ef4444">${results.errors.length}</div>
          <div style="font-size:11px;color:#94a3b8">Errores</div>
        </div>
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-bottom:8px">
        ${results.sourceSpecName} → ${results.targetSpecName}
      </div>
      ${errorsHTML}
      <div class="sa-specm-btnrow" style="margin-top:16px">
        <button class="sa-specm-btn" id="sa-specm-copylog" style="background:#334155;color:#e2e8f0">📋 Copiar Log</button>
        <button class="sa-specm-btn sa-specm-btn-exec" id="sa-specm-close">CERRAR</button>
      </div>`;

    ov.appendChild(md);
    document.body.appendChild(ov);

    document.getElementById('sa-specm-close').onclick = () => ov.parentNode.removeChild(ov);
    document.getElementById('sa-specm-copylog').onclick = () => {
      const logText = api().getLog().join('\n');
      navigator.clipboard.writeText(logText).then(() => {
        const btn = document.getElementById('sa-specm-copylog');
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📋 Copiar Log'; }, 2000);
      });
    };
  }

  // ── Main orchestrator ──
  async function run() {
    // Phase 1: Parse URL
    const specRef = parseSpecFromURL();
    if (!specRef) {
      return { error: 'No estás en una página de spec. URL esperada: /specs/{id}/revisions/{rev}' };
    }

    // Load source spec
    let sourceSpec;
    try {
      sourceSpec = await getSpec(specRef.idInDomain, specRef.revision);
    } catch (e) {
      return { error: 'Error cargando spec: ' + e.message };
    }

    if (!sourceSpec) {
      return { error: 'Spec no encontrada' };
    }

    const pnSpecs = sourceSpec.partNumberSpecsBySpecId?.nodes || [];
    if (!pnSpecs.length) {
      return { error: 'Esta spec no tiene números de parte asignados' };
    }

    log(`=== MIGRADOR DE SPECS ===`);
    log(`Spec origen: ${sourceSpec.name} (id: ${sourceSpec.id})`);
    log(`PNs asignados: ${pnSpecs.length}`);

    // Phase 2: Config form
    const config = await showConfigForm(sourceSpec, pnSpecs.length);
    if (config.cancelled) return { cancelled: true };

    const { targetSpecId, targetSpecName, defaultSelections, genericSelections } = config;

    log(`Spec destino: ${targetSpecName} (id: ${targetSpecId})`);
    log(`defaultSelections: [${defaultSelections.join(', ')}]`);
    log(`genericSelections: [${genericSelections.join(', ')}]`);

    const results = {
      migrated: 0,
      alreadyArchived: 0,
      errors: [],
      sourceSpecName: sourceSpec.name,
      targetSpecName
    };

    showProgressUI('Migrando Specs', 'Preparando...');

    // Phase 3: Migrate each PN
    for (let i = 0; i < pnSpecs.length; i++) {
      const pnSpec = pnSpecs[i];
      const pnId = pnSpec.partNumberId;
      const pnName = pnSpec.partNumberByPartNumberId?.name || `PN ${pnId}`;
      const pct = (i / pnSpecs.length) * 100;

      updateProgress(`${i + 1}/${pnSpecs.length}: ${pnName}`, pct);

      try {
        // Check if source spec is archived at PN level
        const pnSummary = await getPNSpecsSummary(pnId);
        const pnSpecsList = pnSummary?.partNumberSpecsByPartNumberId?.nodes || [];
        const sourceSpecOnPN = pnSpecsList.find(s =>
          s.specBySpecId?.id === sourceSpec.id
        );

        if (sourceSpecOnPN && !sourceSpecOnPN.archivedAt) {
          // Archive the old spec at PN level
          try {
            await archiveSpecOnPN(pnId, pnName, sourceSpecOnPN.id);
            log(`  ${pnName}: spec vieja archivada a nivel PN`);
          } catch (e) {
            warn(`  ${pnName}: error archivando spec vieja: ${String(e).substring(0, 200)}`);
            results.errors.push(`${pnName}: error archivando spec vieja`);
            continue;
          }
        } else if (sourceSpecOnPN && sourceSpecOnPN.archivedAt) {
          results.alreadyArchived++;
        }

        // Check if target spec already assigned (avoid duplicate key error)
        const existingTargetSpec = pnSpecsList.find(s =>
          s.specBySpecId?.id === targetSpecId && !s.archivedAt
        );
        if (existingTargetSpec) {
          // Try to find which params are assigned for this spec
          const pnParams = pnSummary?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
          const paramNames = pnParams
            .filter(p => p.specFieldParamBySpecFieldParamId)
            .map(p => p.specFieldParamBySpecFieldParamId.name || `id:${p.specFieldParamBySpecFieldParamId.id}`)
            .join(', ');
          log(`  ${pnName}: ya tiene spec destino${paramNames ? ' [' + paramNames + ']' : ''}, skip`);
          results.skipped = (results.skipped || 0) + 1;
          continue;
        }

        // Apply new spec
        await applySpecToPN(pnId, targetSpecId, defaultSelections, genericSelections);
        results.migrated++;
        log(`  ${pnName}: spec nueva aplicada ✓`);

      } catch (e) {
        results.errors.push(`${pnName}: ${String(e).substring(0, 200)}`);
        warn(`  ${pnName}: error: ${String(e).substring(0, 200)}`);
      }
    }

    // Phase 4: Summary
    log(`\n=== RESULTADO ===`);
    log(`Migrados: ${results.migrated}/${pnSpecs.length}`);
    log(`Ya archivados (spec vieja): ${results.alreadyArchived}`);
    log(`Skipped (ya tienen destino): ${results.skipped || 0}`);
    log(`Errores: ${results.errors.length}`);

    removeUI();
    showSummary(results);

    return results;
  }

  return { run };
})();

if (typeof window !== 'undefined') window.SpecMigrator = SpecMigrator;
