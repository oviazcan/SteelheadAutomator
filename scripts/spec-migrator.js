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

  // ── Get spec field spec with unassigned PNs ──
  async function getSpecFieldSpec(specFieldSpecId, offset = 0) {
    const data = await api().query('GetSpecFieldSpec', {
      specFieldSpecId,
      // PN filters (what we care about)
      partNumberUnassignedActive: true,
      partNumberSpecFieldParamActive: false,
      partNumberSearchQuery: '',
      partNumberFirst: 500,
      partNumberOffset: offset,
      partNumberOrderBy: ['NAME_ASC'],
      // Treatment filters (required by query but unused)
      treatmentUnassignedActive: false,
      treatmentSpecFieldParamActive: false,
      treatmentSearchQuery: '',
      treatmentFirst: 10,
      treatmentOffset: 0,
      treatmentOrderBy: ['ID_DESC'],
      // Work order filters (required by query but unused)
      partNumberWorkOrderUnassignedActive: false,
      partNumberWorkOrderSpecFieldParamActive: false,
      partNumberWorkOrderSearchQuery: '',
      partNumberWorkOrderFirst: 10,
      partNumberWorkOrderOffset: 0,
      partNumberWorkOrderOrderBy: ['ID_DESC']
    }, 'GetSpecFieldSpec');
    return data || null;
  }

  // ── Get PN detail with specs and params ──
  async function getPNDetail(partNumberId) {
    const data = await api().query('GetPartNumber', {
      partNumberId, usagesLimit: 0, usagesOffset: 0
    });
    return data?.partNumberById || null;
  }

  // ── Archive spec at PN level (same mutation Steelhead UI uses) ──
  // NOTE: Steelhead's UI sends archivedAt:null to ARCHIVE, timestamp to UNARCHIVE.
  // This is counterintuitive but confirmed via scan capture of manual archive action.
  async function archiveSpecOnPN(partNumberSpecId, partNumberSpecFieldParamIds) {
    const result = await api().query('ArchivePartNumberSpecAndParams', {
      partNumberSpecId,
      partNumberSpecFieldParamIds: partNumberSpecFieldParamIds || [],
      archivedAt: null
    }, 'ArchivePartNumberSpecAndParams');
    log(`    archiveSpecOnPN(${partNumberSpecId}): response = ${JSON.stringify(result)}`);
    return result;
  }

  // ── Unarchive spec at PN level ──
  async function unarchiveSpecOnPN(partNumberSpecId, partNumberSpecFieldParamIds) {
    const result = await api().query('ArchivePartNumberSpecAndParams', {
      partNumberSpecId,
      partNumberSpecFieldParamIds: partNumberSpecFieldParamIds || [],
      archivedAt: new Date().toISOString()
    }, 'ArchivePartNumberSpecAndParams');
    log(`    unarchiveSpecOnPN(${partNumberSpecId}): response = ${JSON.stringify(result)}`);
    return result;
  }

  // ── Apply new spec to PN (for PNs that don't have it yet) ──
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

  // ── Archive a single param on a PN ──
  async function archiveParam(paramId) {
    await api().query('UpdatePartNumberSpecParam', {
      id: paramId,
      archivedAt: new Date().toISOString()
    }, 'UpdatePartNumberSpecParam');
  }

  // ── Get classification names for a spec field param ──
  async function getParamClassifications(specFieldParamId, specFieldId) {
    try {
      const data = await api().query('GetSpecFieldParamToEdit', {
        specFieldParamId, specFieldId
      }, 'GetSpecFieldParamToEdit');
      const cs = data?.specFieldParamById?.classificationSetByClassificationSetId;
      if (!cs) return [];
      const nodes = cs.classificationSetClassificationsByClassificationSetId?.nodes || [];
      return nodes.map(n => {
        const c = n.classificationByClassificationId || n;
        return c.name || c.id || '';
      }).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  // ── Search filter options (customer, label) ──
  async function searchFilter(key, searchQuery) {
    const data = await api().query('FilterSearch', { key, searchQuery }, 'FilterSearch');
    return data?.tableFilterSearch || [];
  }

  // ── Fetch all external specs (paginated) ──
  async function fetchAllExternalSpecs(onProgress) {
    const specs = [];
    const seenIds = new Set();
    const PAGE = 400;
    let offset = 0;
    while (true) {
      const data = await api().query('AllSpecs', {
        includeArchived: 'NO',
        orderBy: ['ID_IN_DOMAIN_ASC'],
        offset,
        first: PAGE,
        searchQuery: ''
      });
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (n.type === 'EXTERNAL' && !seenIds.has(n.id)) {
          seenIds.add(n.id);
          specs.push(n);
        }
      }
      if (onProgress) onProgress(`Specs: ${specs.length} externas`);
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 50000) break;
    }
    return specs;
  }

  // ── Fetch filtered PNs with pagination ──
  async function fetchFilteredPNs(filters, onProgress) {
    const allPNs = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
      const vars = { orderBy: ['ID_ASC'], offset, first: pageSize, searchQuery: '', ...filters };
      const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      const total = data?.pagedData?.totalCount || 0;
      allPNs.push(...nodes.filter(n => !n.archivedAt));
      if (onProgress) onProgress(`Cargando PNs: ${allPNs.length}/${total}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return allPNs;
  }

  // ── Add params to an existing spec on a PN ──
  async function addParamsToPN(partNumberId, paramsToApply) {
    await api().query('AddParamsToPartNumber', {
      input: {
        partNumberId,
        paramsToApply
      }
    }, 'AddParamsToPartNumber');
  }

  // ── Add a single param to a PN, tolerating "already present" constraint ──
  async function addSingleParamToPN(partNumberId, specFieldId, specFieldParamId, isGeneric) {
    try {
      await api().query('AddParamsToPartNumber', {
        input: {
          partNumberId,
          paramsToApply: [{
            specFieldId,
            specFieldParamId,
            isGeneric,
            geometryTypeSpecFieldId: null,
            processNodeId: null,
            processNodeOccurrence: null,
            locationId: null
          }]
        }
      }, 'AddParamsToPartNumber');
      return 'ok';
    } catch (e) {
      const msg = String(e);
      if (msg.includes('conflicting')) return 'conflict';
      if (msg.includes('exclusion constraint') || msg.includes('23P01')) return 'duplicate';
      throw e;
    }
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

        <div style="margin-bottom:12px">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#cbd5e1;cursor:pointer">
            <input type="checkbox" id="sa-specm-archive-only" style="width:16px;height:16px;accent-color:#f59e0b">
            Solo archivar (quitar spec sin asignar nueva)
          </label>
        </div>

        <div id="sa-specm-target-section" style="margin-bottom:16px">
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
      const archiveOnlyCheckbox = document.getElementById('sa-specm-archive-only');
      const targetSection = document.getElementById('sa-specm-target-section');

      archiveOnlyCheckbox.addEventListener('change', () => {
        if (archiveOnlyCheckbox.checked) {
          targetSection.style.display = 'none';
          paramsSection.style.display = 'none';
          execBtn.disabled = false;
          execBtn.textContent = 'ARCHIVAR';
          execBtn.style.background = '#f59e0b';
        } else {
          targetSection.style.display = 'block';
          execBtn.textContent = 'MIGRAR';
          execBtn.style.background = '';
          execBtn.disabled = !selectedSpec;
        }
      });

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
          autoDefault = [];      // auto-selected { paramId, specFieldId, isGeneric }
          autoGeneric = [];

          for (const field of fields) {
            const params = field.defaultValues?.nodes || [];
            const fieldName = field.specFieldBySpecFieldId?.name || '';
            const specFieldId = field.specFieldBySpecFieldId?.id || field.specFieldId;

            if (params.length === 0) continue;

            if (params.length === 1) {
              // Auto-select single param
              const entry = { paramId: params[0].id, specFieldId, isGeneric: field.isGeneric };
              if (field.isGeneric) {
                autoGeneric.push(entry);
              } else {
                autoDefault.push(entry);
              }
              log(`  Auto-select: ${fieldName} → ${params[0].name}`);
            } else {
              // Multiple params — user must choose
              multiParamFields.push({
                fieldName,
                specFieldId,
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
              html += `<div style="margin-bottom:12px"><div style="font-size:12px;color:#8b5cf6;font-weight:600;margin-bottom:4px">${mpf.fieldName}:</div>`;
              html += mpf.params.map(p =>
                `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:5px 0;cursor:pointer">
                  <input type="radio" name="sa-specm-field-${mpf.fieldName}" value="${p.id}" data-generic="${mpf.isGeneric}">
                  <span>${p.name}</span>
                  <span class="sa-specm-classif" data-param-id="${p.id}" data-field-id="${mpf.specFieldId}" style="font-size:10px;color:#64748b;margin-left:auto"></span>
                </label>`
              ).join('');
              html += '</div>';
            }
            paramsDiv.innerHTML = html;

            // Load classifications for each param (async, fills in as they arrive)
            paramsDiv.querySelectorAll('.sa-specm-classif').forEach(async (span) => {
              const paramId = parseInt(span.dataset.paramId);
              const fieldId = parseInt(span.dataset.fieldId);
              const names = await getParamClassifications(paramId, fieldId);
              if (names.length) {
                span.textContent = names.join(', ');
                span.style.color = '#38bdf8';
                span.style.background = 'rgba(56,189,248,0.1)';
                span.style.padding = '1px 6px';
                span.style.borderRadius = '4px';
              }
            });

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
        if (archiveOnlyCheckbox.checked) {
          ov.parentNode.removeChild(ov);
          resolve({
            archiveOnly: true,
            targetSpecId: null,
            targetSpecName: '(solo archivar)',
            allParams: [],
            defaultSelections: [],
            genericSelections: []
          });
          return;
        }

        if (!selectedSpec) return;

        // Collect user-selected params with specFieldId
        const userDefault = [];
        const userGeneric = [];
        for (const mpf of multiParamFields) {
          const checked = paramsDiv.querySelector(`input[name="sa-specm-field-${mpf.fieldName}"]:checked`);
          if (checked) {
            const entry = { paramId: parseInt(checked.value), specFieldId: mpf.specFieldId, isGeneric: mpf.isGeneric };
            if (mpf.isGeneric) userGeneric.push(entry);
            else userDefault.push(entry);
          }
        }

        // allParams: full objects with { paramId, specFieldId, isGeneric }
        const allParams = [...autoDefault, ...autoGeneric, ...userDefault, ...userGeneric];

        ov.parentNode.removeChild(ov);
        resolve({
          archiveOnly: false,
          targetSpecId: selectedSpec.id,
          targetSpecName: selectedSpec.name,
          allParams,
          // For ApplySpecsToPartNumber (new specs): just the IDs
          defaultSelections: allParams.filter(p => !p.isGeneric).map(p => p.paramId),
          genericSelections: allParams.filter(p => p.isGeneric).map(p => p.paramId)
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

  // ── Scope form for pending params ──
  function showPendingParamsScopeForm() {
    return new Promise((resolve) => {
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'sa-specm-overlay';
      const md = document.createElement('div');
      md.className = 'sa-specm-modal';
      md.style.background = '#1a1a2e';

      md.innerHTML = `
        <h2 style="color:#8b5cf6">📋 Asignar Params Pendientes</h2>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:16px">Detecta fields con PNs sin parámetro asignado y los asigna automáticamente o con tu ayuda.</p>

        <div style="margin-bottom:16px">
          <label style="display:flex;align-items:center;gap:10px;font-size:14px;padding:10px 12px;background:#0f172a;border-radius:8px;cursor:pointer;margin-bottom:8px;border:2px solid transparent" id="sa-pp-opt-all">
            <input type="radio" name="sa-pp-scope" value="all" checked>
            <div>
              <div style="font-weight:600;color:#e2e8f0">Todas las specs externas</div>
              <div style="font-size:11px;color:#94a3b8">Barrer ~110 specs, detectar pendientes en cada una</div>
            </div>
          </label>
          <label style="display:flex;align-items:center;gap:10px;font-size:14px;padding:10px 12px;background:#0f172a;border-radius:8px;cursor:pointer;border:2px solid transparent" id="sa-pp-opt-single">
            <input type="radio" name="sa-pp-scope" value="single">
            <div>
              <div style="font-weight:600;color:#e2e8f0">Una spec específica</div>
              <div style="font-size:11px;color:#94a3b8">Elegir spec desde la URL actual o buscando</div>
            </div>
          </label>
        </div>

        <div id="sa-pp-search-section" style="display:none;margin-bottom:16px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:6px;font-weight:600">Spec:</label>
          <input type="text" id="sa-pp-search" class="sa-specm-input" placeholder="Buscar spec..." autocomplete="off">
          <div id="sa-pp-dropdown" class="sa-specm-dropdown" style="display:none"></div>
          <div id="sa-pp-selected" style="display:none;margin-top:8px;padding:8px 12px;background:#1e1b4b;border:1px solid #8b5cf6;border-radius:6px;font-size:13px;cursor:pointer" title="Clic para cambiar"></div>
        </div>

        <div class="sa-specm-btnrow">
          <button class="sa-specm-btn sa-specm-btn-cancel" id="sa-pp-cancel">CANCELAR</button>
          <button class="sa-specm-btn sa-specm-btn-exec" id="sa-pp-start">INICIAR</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      let selectedSpec = null;
      let searchTimeout = null;

      // Toggle search section visibility
      const radios = md.querySelectorAll('input[name="sa-pp-scope"]');
      const searchSection = document.getElementById('sa-pp-search-section');
      const startBtn = document.getElementById('sa-pp-start');

      radios.forEach(r => r.addEventListener('change', () => {
        const isSingle = md.querySelector('input[name="sa-pp-scope"]:checked').value === 'single';
        searchSection.style.display = isSingle ? 'block' : 'none';
        startBtn.disabled = isSingle && !selectedSpec;
      }));

      // Spec search (reuse same pattern)
      const searchInput = document.getElementById('sa-pp-search');
      const dropdown = document.getElementById('sa-pp-dropdown');
      const selectedDiv = document.getElementById('sa-pp-selected');

      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
          const q = searchInput.value.trim();
          if (q.length < 2) { dropdown.style.display = 'none'; return; }
          try {
            const results = await searchSpecs(q);
            const active = results.filter(s => !s.archivedAt);
            if (!active.length) {
              dropdown.innerHTML = '<div class="sa-specm-dropdown-item" style="color:#64748b">Sin resultados</div>';
            } else {
              dropdown.innerHTML = active.map(s =>
                `<div class="sa-specm-dropdown-item" data-id="${s.id}" data-name="${s.name}">${s.name}${s.revisionName ? ' - Rev. ' + s.revisionName : ''}</div>`
              ).join('');
              dropdown.querySelectorAll('.sa-specm-dropdown-item[data-id]').forEach(item => {
                item.addEventListener('click', () => {
                  selectedSpec = { id: parseInt(item.dataset.id), name: item.dataset.name };
                  dropdown.style.display = 'none';
                  searchInput.style.display = 'none';
                  selectedDiv.textContent = selectedSpec.name;
                  selectedDiv.style.display = 'block';
                  selectedDiv.onclick = () => {
                    selectedSpec = null;
                    searchInput.style.display = 'block';
                    searchInput.value = '';
                    selectedDiv.style.display = 'none';
                    startBtn.disabled = true;
                  };
                  startBtn.disabled = false;
                });
              });
            }
            dropdown.style.display = 'block';
          } catch (e) {
            dropdown.innerHTML = '<div class="sa-specm-dropdown-item" style="color:#ef4444">Error buscando</div>';
            dropdown.style.display = 'block';
          }
        }, 300);
      });

      // Auto-detect spec from URL
      const specRef = parseSpecFromURL();
      if (specRef) {
        (async () => {
          try {
            const spec = await getSpec(specRef.idInDomain, specRef.revision);
            if (spec) {
              // Pre-select "single" and fill in spec
              md.querySelector('input[value="single"]').checked = true;
              searchSection.style.display = 'block';
              selectedSpec = { id: spec.id, name: spec.name };
              searchInput.style.display = 'none';
              selectedDiv.textContent = spec.name;
              selectedDiv.style.display = 'block';
              selectedDiv.onclick = () => {
                selectedSpec = null;
                searchInput.style.display = 'block';
                searchInput.value = '';
                selectedDiv.style.display = 'none';
                startBtn.disabled = true;
              };
              startBtn.disabled = false;
            }
          } catch (_) {}
        })();
      }

      document.getElementById('sa-pp-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      startBtn.addEventListener('click', () => {
        const scope = md.querySelector('input[name="sa-pp-scope"]:checked').value;
        ov.parentNode.removeChild(ov);
        if (scope === 'all') {
          resolve({ scope: 'all' });
        } else {
          resolve({ scope: 'single', specId: selectedSpec.id, specName: selectedSpec.name });
        }
      });
    });
  }

  // ── Multi-param modal: user picks a param and selects which PNs get it ──
  function showMultiParamModal(fieldName, specName, params, pns) {
    return new Promise((resolve) => {
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'sa-specm-overlay';
      const md = document.createElement('div');
      md.className = 'sa-specm-modal';
      md.style.background = '#1a1a2e';
      md.style.maxWidth = '700px';

      const pnListHTML = pns.map(pn =>
        `<label style="display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0;cursor:pointer">
          <input type="checkbox" class="sa-pp-pn-cb" data-id="${pn.id}" checked>
          <span style="color:#e2e8f0">${pn.name || pn.id}</span>
        </label>`
      ).join('');

      const paramRadios = params.map((p, idx) =>
        `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer">
          <input type="radio" name="sa-pp-param" value="${p.id}" data-name="${p.name}" ${idx === 0 ? 'checked' : ''}>
          <span style="color:#e2e8f0">${p.name}${p.isDefault ? ' <span style="color:#4ade80;font-size:10px">(default)</span>' : ''}</span>
        </label>`
      ).join('');

      md.innerHTML = `
        <h2 style="color:#f59e0b;font-size:16px">🔧 ${fieldName}</h2>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:12px">Spec: ${specName} · ${pns.length} PNs sin asignar</div>

        <div style="margin-bottom:16px">
          <div style="font-size:13px;color:#cbd5e1;font-weight:600;margin-bottom:6px">Parámetro a asignar:</div>
          ${paramRadios}
        </div>

        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="font-size:13px;color:#cbd5e1;font-weight:600">PNs a asignar:</div>
            <label style="font-size:11px;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" id="sa-pp-selectall" checked> Todos
            </label>
          </div>
          <div style="max-height:200px;overflow-y:auto;background:#0f172a;border-radius:6px;padding:8px 12px">
            ${pnListHTML}
          </div>
        </div>

        <div class="sa-specm-btnrow">
          <button class="sa-specm-btn sa-specm-btn-cancel" id="sa-pp-skip" style="background:#78350f;color:#fbbf24">SALTAR FIELD</button>
          <button class="sa-specm-btn sa-specm-btn-exec" id="sa-pp-assign">ASIGNAR <span id="sa-pp-count">${pns.length}</span> PNs</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      // Select-all toggle
      const selectAllCb = document.getElementById('sa-pp-selectall');
      const pnCheckboxes = () => md.querySelectorAll('.sa-pp-pn-cb');

      const updateCount = () => {
        const checked = md.querySelectorAll('.sa-pp-pn-cb:checked').length;
        document.getElementById('sa-pp-count').textContent = checked;
        document.getElementById('sa-pp-assign').disabled = checked === 0;
      };

      selectAllCb.addEventListener('change', () => {
        pnCheckboxes().forEach(cb => { cb.checked = selectAllCb.checked; });
        updateCount();
      });
      pnCheckboxes().forEach(cb => cb.addEventListener('change', updateCount));

      document.getElementById('sa-pp-skip').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ skipped: true });
      };

      document.getElementById('sa-pp-assign').onclick = () => {
        const selectedParam = md.querySelector('input[name="sa-pp-param"]:checked');
        const selectedPNIds = [...md.querySelectorAll('.sa-pp-pn-cb:checked')].map(cb => parseInt(cb.dataset.id));
        ov.parentNode.removeChild(ov);
        resolve({
          paramId: parseInt(selectedParam.value),
          paramName: selectedParam.dataset.name,
          pnIds: selectedPNIds,
          // PNs NOT selected stay pending for next round
          remainingPNs: pns.filter(pn => !selectedPNIds.includes(pn.id))
        });
      };
    });
  }

  // ── Dashboard filter form ──
  function showDashboardForm() {
    return new Promise((resolve) => {
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'sa-specm-overlay';
      const md = document.createElement('div');
      md.className = 'sa-specm-modal';
      md.style.background = '#1a1a2e';

      md.innerHTML = `
        <h2 style="color:#8b5cf6">🔀 Aplicar Spec desde Dashboard</h2>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:16px">Filtra PNs por cliente y/o etiqueta, luego aplica una spec a todos.</p>

        <div style="margin-bottom:12px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:4px;font-weight:600">Cliente (opcional):</label>
          <input type="text" id="sa-specm-cust-search" class="sa-specm-input" placeholder="Buscar cliente..." autocomplete="off">
          <div id="sa-specm-cust-dropdown" class="sa-specm-dropdown" style="display:none"></div>
          <div id="sa-specm-cust-selected" style="display:none;margin-top:4px;padding:6px 10px;background:#1e1b4b;border:1px solid #8b5cf6;border-radius:6px;font-size:12px;cursor:pointer" title="Clic para quitar"></div>
        </div>

        <div style="margin-bottom:12px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:4px;font-weight:600">Etiqueta (opcional):</label>
          <input type="text" id="sa-specm-label-search" class="sa-specm-input" placeholder="Buscar etiqueta..." autocomplete="off">
          <div id="sa-specm-label-dropdown" class="sa-specm-dropdown" style="display:none"></div>
          <div id="sa-specm-label-selected" style="display:none;margin-top:4px;padding:6px 10px;background:#1e1b4b;border:1px solid #8b5cf6;border-radius:6px;font-size:12px;cursor:pointer" title="Clic para quitar"></div>
        </div>

        <div id="sa-specm-preview" style="margin-bottom:12px;display:none">
          <div style="font-size:13px;color:#4ade80;font-weight:600" id="sa-specm-pn-count"></div>
        </div>

        <div class="sa-specm-btnrow">
          <button class="sa-specm-btn sa-specm-btn-cancel" id="sa-specm-dash-cancel">CANCELAR</button>
          <button class="sa-specm-btn sa-specm-btn-exec" id="sa-specm-dash-next" disabled>SIGUIENTE</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      let selectedCustomer = null;
      let selectedLabel = null;
      let fetchedPNs = null;

      // Wire up filter search for customer and label
      function wireFilter(inputId, dropdownId, selectedId, filterKey, onSelect) {
        const input = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        const selectedDiv = document.getElementById(selectedId);
        let timeout = null;

        input.addEventListener('input', () => {
          clearTimeout(timeout);
          timeout = setTimeout(async () => {
            const q = input.value.trim();
            if (q.length < 2) { dropdown.style.display = 'none'; return; }
            const results = await searchFilter(filterKey, q);
            if (!results.length) {
              dropdown.innerHTML = '<div class="sa-specm-dropdown-item" style="color:#64748b">Sin resultados</div>';
            } else {
              dropdown.innerHTML = results.map(r =>
                `<div class="sa-specm-dropdown-item" data-id="${r.identifier}" data-name="${r.display}">${r.display}</div>`
              ).join('');
              dropdown.querySelectorAll('.sa-specm-dropdown-item[data-id]').forEach(item => {
                item.addEventListener('click', () => {
                  onSelect(parseInt(item.dataset.id), item.dataset.name);
                  input.style.display = 'none';
                  dropdown.style.display = 'none';
                  selectedDiv.textContent = item.dataset.name + ' ✕';
                  selectedDiv.style.display = 'block';
                  selectedDiv.onclick = () => {
                    onSelect(null, null);
                    input.style.display = 'block';
                    input.value = '';
                    selectedDiv.style.display = 'none';
                    previewPNs();
                  };
                  previewPNs();
                });
              });
            }
            dropdown.style.display = 'block';
          }, 300);
        });
      }

      wireFilter('sa-specm-cust-search', 'sa-specm-cust-dropdown', 'sa-specm-cust-selected',
        'customerIdFilter', (id, name) => { selectedCustomer = id; });

      wireFilter('sa-specm-label-search', 'sa-specm-label-dropdown', 'sa-specm-label-selected',
        'labelIdFilter', (id, name) => { selectedLabel = id; });

      async function previewPNs() {
        const filters = {};
        if (selectedCustomer) filters.customerIdFilter = [selectedCustomer];
        if (selectedLabel) filters.labelIdFilter = [selectedLabel];

        if (!selectedCustomer && !selectedLabel) {
          document.getElementById('sa-specm-preview').style.display = 'none';
          document.getElementById('sa-specm-dash-next').disabled = true;
          fetchedPNs = null;
          return;
        }

        document.getElementById('sa-specm-pn-count').textContent = 'Buscando PNs...';
        document.getElementById('sa-specm-preview').style.display = 'block';

        fetchedPNs = await fetchFilteredPNs(filters, (msg) => {
          document.getElementById('sa-specm-pn-count').textContent = msg;
        });

        document.getElementById('sa-specm-pn-count').textContent = `${fetchedPNs.length} PNs encontrados`;
        document.getElementById('sa-specm-dash-next').disabled = fetchedPNs.length === 0;
      }

      document.getElementById('sa-specm-dash-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      document.getElementById('sa-specm-dash-next').onclick = () => {
        if (!fetchedPNs || !fetchedPNs.length) return;
        ov.parentNode.removeChild(ov);
        resolve({ pns: fetchedPNs });
      };
    });
  }

  // ══════════════════════════════════════════
  // ASSIGN PENDING PARAMS — Orchestrator
  // ══════════════════════════════════════════

  async function assignPendingParams() {
    // Phase 1: Scope selection
    const scope = await showPendingParamsScopeForm();
    if (scope.cancelled) return { cancelled: true };

    log('=== ASIGNAR PARAMS PENDIENTES ===');

    // Phase 2: Fetch specs to process
    let specs = [];
    showProgressUI('Params Pendientes', 'Cargando specs...');

    if (scope.scope === 'all') {
      specs = await fetchAllExternalSpecs((msg) => updateProgress(msg));
      log(`Specs externas encontradas: ${specs.length}`);
    } else {
      specs = [{ id: scope.specId, name: scope.specName }];
      log(`Spec seleccionada: ${scope.specName}`);
    }

    if (!specs.length) {
      removeUI();
      return { error: 'No se encontraron specs' };
    }

    // Phase 3: For each spec, fetch fields via SpecFieldsAndOptions
    const results = { assigned: 0, skippedFields: 0, skippedPNs: 0, conflicts: [], errors: [], autoAssigned: 0, assisted: 0 };
    const BATCH = 20;

    const specFields = [];
    updateProgress(`Cargando fields de ${specs.length} specs...`, 0);

    for (let i = 0; i < specs.length; i += BATCH) {
      const batch = specs.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (spec) => {
        try {
          const detail = await getSpecFields(spec.id);
          const fields = detail?.specFieldSpecsBySpecId?.nodes || [];
          return fields.map(f => ({
            specId: spec.id,
            specName: spec.name,
            specFieldSpecId: f.id,
            fieldName: f.specFieldBySpecFieldId?.name || '?',
            isGeneric: f.isGeneric,
            specFieldId: f.specFieldBySpecFieldId?.id,
            params: (f.defaultValues?.nodes || []).map(p => ({ id: p.id, name: p.name, isDefault: p.isDefault }))
          }));
        } catch (e) {
          warn(`SpecFieldsAndOptions ${spec.name}: ${String(e).substring(0, 120)}`);
          return [];
        }
      }));
      specFields.push(...batchResults.flat());
      const pct = Math.min(((i + BATCH) / specs.length) * 30, 30);
      updateProgress(`Fields: ${specFields.length} de ${Math.min(i + BATCH, specs.length)}/${specs.length} specs`, pct);
    }

    log(`Total fields a revisar: ${specFields.length}`);

    // Phase 4: For each field, check for unassigned PNs via GetSpecFieldSpec
    const fieldsWithPending = [];

    for (let i = 0; i < specFields.length; i += BATCH) {
      const batch = specFields.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (field) => {
        try {
          const data = await getSpecFieldSpec(field.specFieldSpecId);
          const totalCount = data?.searchPartNumbers?.totalCount || 0;
          if (totalCount === 0) return null;

          let pns = (data?.searchPartNumbers?.nodes || []).map(n => ({ id: n.id, name: n.name }));
          let offset = pns.length;
          while (offset < totalCount) {
            const more = await getSpecFieldSpec(field.specFieldSpecId, offset);
            const morePNs = (more?.searchPartNumbers?.nodes || []).map(n => ({ id: n.id, name: n.name }));
            pns.push(...morePNs);
            offset += morePNs.length;
            if (morePNs.length === 0) break;
          }

          return { ...field, pns };
        } catch (e) {
          warn(`GetSpecFieldSpec ${field.specName}/${field.fieldName}: ${String(e).substring(0, 120)}`);
          return null;
        }
      }));

      for (const r of batchResults) {
        if (r) fieldsWithPending.push(r);
      }

      const pct = 30 + Math.min(((i + BATCH) / specFields.length) * 40, 40);
      updateProgress(`Revisando fields: ${Math.min(i + BATCH, specFields.length)}/${specFields.length} — ${fieldsWithPending.length} con pendientes`, pct);
    }

    log(`Fields con PNs pendientes: ${fieldsWithPending.length}`);

    if (!fieldsWithPending.length) {
      removeUI();
      log('¡Sin params pendientes!');
      showPendingParamsSummary(results);
      return results;
    }

    // Phase 5: Process each field
    removeUI();

    for (let fi = 0; fi < fieldsWithPending.length; fi++) {
      const field = fieldsWithPending[fi];

      if (field.params.length === 0) {
        log(`  ${field.specName}/${field.fieldName}: sin params disponibles, skip`);
        results.skippedFields++;
        continue;
      }

      if (field.params.length === 1) {
        // Auto-assign: single param → apply to all PNs in parallel batches
        showProgressUI('Auto-asignando', `${field.specName} / ${field.fieldName} (${field.pns.length} PNs)`);
        const param = field.params[0];
        log(`  AUTO: ${field.specName}/${field.fieldName} → ${param.name} (${field.pns.length} PNs)`);

        const PBATCH = 10;
        let fieldConflicts = 0;
        for (let pi = 0; pi < field.pns.length; pi += PBATCH) {
          const batch = field.pns.slice(pi, pi + PBATCH);
          const pct = (pi / field.pns.length) * 100;
          updateProgress(`${field.fieldName}: ${pi + 1}-${Math.min(pi + PBATCH, field.pns.length)}/${field.pns.length}`, pct);
          const batchResults = await Promise.allSettled(batch.map(pn =>
            addSingleParamToPN(pn.id, field.specFieldId, param.id, field.isGeneric)
              .then(status => ({ status, name: pn.name || pn.id }))
          ));
          for (const r of batchResults) {
            if (r.status === 'fulfilled') {
              if (r.value.status === 'ok') results.assigned++;
              else if (r.value.status === 'conflict') {
                fieldConflicts++;
                results.conflicts.push(r.value.name);
              }
              else results.skippedPNs++;
            } else {
              results.errors.push(`${String(r.reason).substring(0, 150)}`);
            }
          }
        }
        if (fieldConflicts > 0) {
          log(`    ⚠ ${fieldConflicts} PNs con params conflictivos`);
        }
        results.autoAssigned++;
        removeUI();
      } else {
        // Multi-param: show modal for user assistance
        let remainingPNs = [...field.pns];

        while (remainingPNs.length > 0) {
          const choice = await showMultiParamModal(
            `${field.fieldName} (${fi + 1}/${fieldsWithPending.length})`,
            field.specName,
            field.params,
            remainingPNs
          );

          if (choice.skipped) {
            log(`  SKIP: ${field.specName}/${field.fieldName} — ${remainingPNs.length} PNs sin asignar`);
            results.skippedFields++;
            break;
          }

          // Assign chosen param to selected PNs
          showProgressUI('Asignando', `${field.fieldName} → ${choice.paramName}`);
          log(`  ASISTIDO: ${field.specName}/${field.fieldName} → ${choice.paramName} (${choice.pnIds.length} PNs)`);

          const PBATCH = 10;
          for (let pi = 0; pi < choice.pnIds.length; pi += PBATCH) {
            const batch = choice.pnIds.slice(pi, pi + PBATCH);
            updateProgress(`${pi + 1}-${Math.min(pi + PBATCH, choice.pnIds.length)}/${choice.pnIds.length}`, (pi / choice.pnIds.length) * 100);
            const batchResults = await Promise.allSettled(batch.map(pnId => {
              const pnName = remainingPNs.find(p => p.id === pnId)?.name || pnId;
              return addSingleParamToPN(pnId, field.specFieldId, choice.paramId, field.isGeneric)
                .then(status => ({ status, name: pnName }));
            }));
            for (const r of batchResults) {
              if (r.status === 'fulfilled') {
                if (r.value.status === 'ok') results.assigned++;
                else if (r.value.status === 'conflict') results.conflicts.push(r.value.name);
                else results.skippedPNs++;
              } else {
                results.errors.push(`${String(r.reason).substring(0, 150)}`);
              }
            }
          }
          results.assisted++;
          removeUI();

          remainingPNs = choice.remainingPNs;
          if (remainingPNs.length > 0) {
            log(`  ${field.fieldName}: quedan ${remainingPNs.length} PNs sin asignar, siguiente ronda...`);
          }
        }
      }
    }

    // Phase 6: Summary
    log(`\n=== RESULTADO PARAMS PENDIENTES ===`);
    log(`Asignados: ${results.assigned}`);
    log(`Auto-assign fields: ${results.autoAssigned}`);
    log(`Asistidos: ${results.assisted}`);
    log(`Fields saltados: ${results.skippedFields}`);
    log(`PNs ya presentes: ${results.skippedPNs}`);
    log(`PNs con conflicto: ${results.conflicts.length}`);
    if (results.conflicts.length > 0) {
      const unique = [...new Set(results.conflicts)];
      log(`  PNs conflictivos (${unique.length} únicos): ${unique.slice(0, 30).join(', ')}${unique.length > 30 ? ` ... y ${unique.length - 30} más` : ''}`);
    }
    log(`Errores: ${results.errors.length}`);

    showPendingParamsSummary(results);
    return results;
  }

  // ── Summary for pending params ──
  function showPendingParamsSummary(results) {
    ensureStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-specm-overlay';
    const md = document.createElement('div');
    md.className = 'sa-specm-modal';
    md.style.background = '#1a1a2e';

    const hasErrors = results.errors.length > 0;
    const hasConflicts = results.conflicts.length > 0;
    const icon = hasErrors ? '⚠️' : hasConflicts ? '⚠️' : '✅';
    const iconColor = hasErrors ? '#f59e0b' : hasConflicts ? '#f59e0b' : '#4ade80';

    let errorsHTML = '';
    if (results.errors.length > 0) {
      const items = results.errors.slice(0, 15).map(e => `<div style="font-size:11px;color:#fca5a5;padding:1px 0">${e}</div>`).join('');
      errorsHTML = `<div style="margin-top:12px"><div style="font-size:12px;color:#ef4444;font-weight:600;margin-bottom:4px">Errores (${results.errors.length}):</div>${items}</div>`;
    }

    const uniqueConflicts = [...new Set(results.conflicts)];
    let conflictsHTML = '';
    if (uniqueConflicts.length > 0) {
      const items = uniqueConflicts.slice(0, 20).map(n => `<div style="font-size:11px;color:#fbbf24;padding:1px 0">${n}</div>`).join('');
      conflictsHTML = `<div style="margin-top:12px"><div style="font-size:12px;color:#f59e0b;font-weight:600;margin-bottom:4px">PNs con params conflictivos (${uniqueConflicts.length} únicos):</div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px">Estos PNs tienen el mismo spec field en 2+ specs. Resolver manualmente en Steelhead.</div>${items}${uniqueConflicts.length > 20 ? `<div style="font-size:11px;color:#94a3b8;padding:1px 0">... y ${uniqueConflicts.length - 20} más (ver log)</div>` : ''}</div>`;
    }

    md.innerHTML = `
      <h2 style="color:${iconColor}">${icon} Asignación Completada</h2>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#4ade80">${results.assigned}</div>
          <div style="font-size:11px;color:#94a3b8">PNs asignados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#94a3b8">${results.skippedPNs}</div>
          <div style="font-size:11px;color:#94a3b8">Ya tenían param</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#f59e0b">${uniqueConflicts.length}</div>
          <div style="font-size:11px;color:#94a3b8">Conflictos</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#ef4444">${results.errors.length}</div>
          <div style="font-size:11px;color:#94a3b8">Errores</div>
        </div>
      </div>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">
        Fields procesados: ${results.autoAssigned} auto · ${results.assisted} asistidos · ${results.skippedFields} saltados
      </div>
      ${conflictsHTML}
      ${errorsHTML}
      <div class="sa-specm-btnrow" style="margin-top:16px">
        <button class="sa-specm-btn" id="sa-pp-copylog" style="background:#334155;color:#e2e8f0">📋 Copiar Log</button>
        <button class="sa-specm-btn sa-specm-btn-exec" id="sa-pp-close">CERRAR</button>
      </div>`;

    ov.appendChild(md);
    document.body.appendChild(ov);

    document.getElementById('sa-pp-close').onclick = () => ov.parentNode.removeChild(ov);
    document.getElementById('sa-pp-copylog').onclick = () => {
      const logText = api().getLog().join('\n');
      navigator.clipboard.writeText(logText).then(() => {
        const btn = document.getElementById('sa-pp-copylog');
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📋 Copiar Log'; }, 2000);
      });
    };
  }

  // ── Main orchestrator ──
  async function run() {
    // Detect mode: spec page or dashboard
    const specRef = parseSpecFromURL();

    if (!specRef) {
      // Dashboard mode: filter PNs, then apply spec
      return runDashboardMode();
    }

    // Spec page mode: migrate from source spec
    return runSpecMode(specRef);
  }

  // ── Dashboard mode ──
  async function runDashboardMode() {
    const dashConfig = await showDashboardForm();
    if (dashConfig.cancelled) return { cancelled: true };

    const pns = dashConfig.pns;
    log(`=== MIGRADOR DE SPECS (DASHBOARD) ===`);
    log(`PNs filtrados: ${pns.length}`);

    // Show spec selection form (reuse showConfigForm without source spec info)
    const config = await showConfigForm({ name: `${pns.length} PNs del dashboard`, archivedAt: null }, pns.length);
    if (config.cancelled) return { cancelled: true };

    const { targetSpecId, targetSpecName, defaultSelections, genericSelections, allParams } = config;

    log(`Spec destino: ${targetSpecName} (id: ${targetSpecId})`);
    log(`defaultSelections: [${defaultSelections.join(', ')}]`);
    log(`genericSelections: [${genericSelections.join(', ')}]`);

    const results = { migrated: 0, alreadyArchived: 0, errors: [], sourceSpecName: 'Dashboard', targetSpecName };

    showProgressUI('Aplicando Specs', 'Preparando...');

    // Apply spec to each PN (same logic as spec mode)
    for (let i = 0; i < pns.length; i++) {
      const pn = pns[i];
      const pnId = pn.id;
      const pnName = pn.name || `PN ${pnId}`;
      const pct = (i / pns.length) * 100;
      updateProgress(`${i + 1}/${pns.length}: ${pnName}`, pct);

      try {
        const pnDetail = await getPNDetail(pnId);
        const pnSpecsList = pnDetail?.partNumberSpecsByPartNumberId?.nodes || [];
        const pnAllParams = pnDetail?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];

        // Check if target spec already assigned
        const existingTargetSpec = pnSpecsList.find(s => s.specBySpecId?.id === targetSpecId);

        if (existingTargetSpec) {
          if (existingTargetSpec.archivedAt) {
            const archivedParamIds = pnAllParams.filter(p => p.archivedAt).map(p => p.id);
            await unarchiveSpecOnPN(existingTargetSpec.id, archivedParamIds);
          }

          const activeParams = pnAllParams.filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId);
          const existingIds = new Set(activeParams.map(p => p.specFieldParamBySpecFieldParamId.id));
          const wantedIds = new Set([...defaultSelections, ...genericSelections]);

          if (wantedIds.size > 0 && [...wantedIds].every(id => existingIds.has(id))) {
            log(`  ${pnName}: params correctos, skip`);
            results.skipped = (results.skipped || 0) + 1;
            continue;
          }

          // Archive wrong params, add missing
          for (const p of activeParams) {
            if (!wantedIds.has(p.specFieldParamBySpecFieldParamId.id)) {
              try { await archiveParam(p.id); } catch (_) {}
            }
          }
          const missing = allParams.filter(ap => !existingIds.has(ap.paramId));
          if (missing.length > 0) {
            await addParamsToPN(pnId, missing.map(p => ({
              specFieldId: p.specFieldId, specFieldParamId: p.paramId, isGeneric: p.isGeneric,
              geometryTypeSpecFieldId: null, processNodeId: null, processNodeOccurrence: null, locationId: null
            })));
          }
          results.migrated++;
          log(`  ${pnName}: params corregidos ✓`);
        } else {
          await applySpecToPN(pnId, targetSpecId, defaultSelections, genericSelections);
          results.migrated++;
          log(`  ${pnName}: spec aplicada ✓`);
        }
      } catch (e) {
        results.errors.push(`${pnName}: ${String(e).substring(0, 200)}`);
        warn(`  ${pnName}: error: ${String(e).substring(0, 200)}`);
      }
    }

    log(`\n=== RESULTADO ===`);
    log(`Migrados: ${results.migrated}/${pns.length}`);
    log(`Skipped: ${results.skipped || 0}`);
    log(`Errores: ${results.errors.length}`);

    removeUI();
    showSummary(results);
    return results;
  }

  // ── Spec page mode ──
  async function runSpecMode(specRef) {
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

    const { targetSpecId, targetSpecName, defaultSelections, genericSelections, allParams, archiveOnly } = config;

    if (archiveOnly) {
      log(`Modo: solo archivar (sin spec destino)`);
    } else {
      log(`Spec destino: ${targetSpecName} (id: ${targetSpecId})`);
      log(`defaultSelections: [${defaultSelections.join(', ')}]`);
      log(`genericSelections: [${genericSelections.join(', ')}]`);
    }

    const results = {
      migrated: 0,
      alreadyArchived: 0,
      errors: [],
      sourceSpecName: sourceSpec.name,
      targetSpecName
    };

    // Get source spec field IDs to correctly scope param archival
    const sourceSpecDetail = await getSpecFields(sourceSpec.id);
    const sourceFieldIds = new Set(
      (sourceSpecDetail?.specFieldSpecsBySpecId?.nodes || [])
        .map(f => f.specFieldBySpecFieldId?.id)
        .filter(Boolean)
    );

    showProgressUI(archiveOnly ? 'Archivando Specs' : 'Migrando Specs', 'Preparando...');

    // Phase 3: Migrate each PN
    for (let i = 0; i < pnSpecs.length; i++) {
      const pnSpec = pnSpecs[i];
      const pnId = pnSpec.partNumberId;
      const pnName = pnSpec.partNumberByPartNumberId?.name || `PN ${pnId}`;
      const pct = (i / pnSpecs.length) * 100;

      updateProgress(`${i + 1}/${pnSpecs.length}: ${pnName}`, pct);

      try {
        // Get PN detail with specs and params
        const pnDetail = await getPNDetail(pnId);
        const pnSpecsList = pnDetail?.partNumberSpecsByPartNumberId?.nodes || [];
        const pnAllParams = pnDetail?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];

        const sourceSpecOnPN = pnSpecsList.find(s =>
          s.specBySpecId?.id === sourceSpec.id
        );

        if (sourceSpecOnPN && !sourceSpecOnPN.archivedAt) {
          // Archive the old spec at PN level — only pass params that belong to the
          // source spec's fields, not ALL active params (which would break multi-spec PNs)
          try {
            const sourceParamIds = pnAllParams
              .filter(p => !p.archivedAt && sourceFieldIds.has(p.specFieldId))
              .map(p => p.id);
            await archiveSpecOnPN(sourceSpecOnPN.id, sourceParamIds);
            log(`  ${pnName}: spec archivada a nivel PN`);
          } catch (e) {
            warn(`  ${pnName}: error archivando spec: ${String(e).substring(0, 200)}`);
            results.errors.push(`${pnName}: error archivando spec`);
            continue;
          }
          if (archiveOnly) { results.migrated++; continue; }
        } else if (sourceSpecOnPN && sourceSpecOnPN.archivedAt) {
          results.alreadyArchived++;
          if (archiveOnly) continue;
        } else if (archiveOnly) {
          log(`  ${pnName}: spec no encontrada en PN, skip`);
          continue;
        }

        // Check if target spec already assigned (active or archived)
        const existingTargetSpec = pnSpecsList.find(s =>
          s.specBySpecId?.id === targetSpecId
        );
        if (existingTargetSpec) {
          // If archived, unarchive the spec first
          if (existingTargetSpec.archivedAt) {
            try {
              const archivedParamIds = pnAllParams.filter(p => p.archivedAt).map(p => p.id);
              await unarchiveSpecOnPN(existingTargetSpec.id, archivedParamIds);
              log(`  ${pnName}: spec destino desarchivada`);
            } catch (e) {
              warn(`  ${pnName}: error desarchivando: ${String(e).substring(0, 200)}`);
              results.errors.push(`${pnName}: error desarchivando`);
              continue;
            }
          }

          // Check existing active params on this PN
          const activeParams = pnAllParams.filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId);
          const existingParamIds = new Set(activeParams.map(p => p.specFieldParamBySpecFieldParamId.id));
          const wantedParamIds = new Set([...defaultSelections, ...genericSelections]);

          // Check if all wanted params already present
          const paramsMatch = wantedParamIds.size > 0
            && [...wantedParamIds].every(id => existingParamIds.has(id));

          if (paramsMatch) {
            const names = activeParams.map(p => p.specFieldParamBySpecFieldParamId.name).join(', ');
            log(`  ${pnName}: params correctos [${names}], skip`);
            results.skipped = (results.skipped || 0) + 1;
            continue;
          }

          // Archive wrong/extra active params, then add correct ones
          const names = activeParams.map(p => p.specFieldParamBySpecFieldParamId.name).join(', ');
          log(`  ${pnName}: corrigiendo params [${names || 'sin params'}]...`);

          // Step 1: Archive all active params that are NOT in wanted set
          for (const p of activeParams) {
            if (!wantedParamIds.has(p.specFieldParamBySpecFieldParamId.id)) {
              try {
                await archiveParam(p.id);
              } catch (_) {}
            }
          }

          // Step 2: Add missing params one-by-one (tolerates constraints from shared spec fields)
          const missingParams = allParams.filter(ap => !existingParamIds.has(ap.paramId));
          for (const p of missingParams) {
            await addSingleParamToPN(pnId, p.specFieldId, p.paramId, p.isGeneric);
          }

          results.migrated++;
          log(`  ${pnName}: params corregidos ✓`);
          continue;
        }

        // Target spec doesn't exist on PN — but check if it exists archived
        // (the existingTargetSpec check above only searches current pnSpecsList which
        //  was fetched BEFORE we archived the source spec — re-check now)
        const pnDetail2 = await getPNDetail(pnId);
        const pnSpecsList2 = pnDetail2?.partNumberSpecsByPartNumberId?.nodes || [];
        const pnAllParams2 = pnDetail2?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
        const archivedTarget = pnSpecsList2.find(s => s.specBySpecId?.id === targetSpecId && s.archivedAt);

        if (archivedTarget) {
          // Target spec exists but archived — unarchive it and fix its params
          // Collect its archived param IDs to unarchive along with the spec
          const archivedParamIds = pnAllParams2
            .filter(p => p.archivedAt && p.specFieldParamBySpecFieldParamId)
            .map(p => p.id);

          await unarchiveSpecOnPN(archivedTarget.id, archivedParamIds);
          log(`  ${pnName}: spec destino desarchivada (con ${archivedParamIds.length} params)`);

          // Now check which params we have active vs which we want
          const pnDetail3 = await getPNDetail(pnId);
          const pnAllParams3 = pnDetail3?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
          const activeParams3 = pnAllParams3.filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId);
          const activeParamIds = new Set(activeParams3.map(p => p.specFieldParamBySpecFieldParamId.id));
          const wantedIds = new Set([...defaultSelections, ...genericSelections]);

          // Archive params that are active but not wanted
          for (const p of activeParams3) {
            if (!wantedIds.has(p.specFieldParamBySpecFieldParamId.id)) {
              try { await archiveParam(p.id); } catch (_) {}
            }
          }

          // Add params that are wanted but not present
          const missingParams = allParams.filter(ap => !activeParamIds.has(ap.paramId));
          if (missingParams.length > 0) {
            for (const p of missingParams) {
              await addSingleParamToPN(pnId, p.specFieldId, p.paramId, p.isGeneric);
            }
          }

          results.migrated++;
          log(`  ${pnName}: spec restaurada y params corregidos ✓`);
        } else {
          // Truly fresh — apply spec
          try {
            await applySpecToPN(pnId, targetSpecId, defaultSelections, genericSelections);
            results.migrated++;
            log(`  ${pnName}: spec aplicada ✓`);
          } catch (applyErr) {
            const msg = String(applyErr);
            if (msg.includes('exclusion constraint') || msg.includes('conflicting key') || msg.includes('unique_constraint')) {
              // Shared spec fields with archived source spec — add params one by one
              log(`  ${pnName}: constraint en apply, intentando param-by-param...`);
              try { await applySpecToPN(pnId, targetSpecId, [], []); } catch (_) {}
              let added = 0;
              for (const p of allParams) {
                const ok = await addSingleParamToPN(pnId, p.specFieldId, p.paramId, p.isGeneric);
                if (ok) added++;
              }
              results.migrated++;
              log(`  ${pnName}: spec aplicada (fallback, ${added}/${allParams.length} params) ✓`);
            } else {
              throw applyErr;
            }
          }
        }

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

  // ══════════════════════════════════════════
  // RESOLVE CONFLICTS — Scan
  // ══════════════════════════════════════════

  async function scanForConflicts() {
    showProgressUI('Conflictos de Specs', 'Cargando specs externas...');
    const specs = await fetchAllExternalSpecs((msg) => updateProgress(msg, 5));
    log(`=== RESOLVER CONFLICTOS DE SPECS ===`);
    log(`Specs externas: ${specs.length}`);

    // Phase 1: For each spec, get its assigned PNs via GetSpec
    const pnMap = {}; // pnId → { pnId, pnName, pnSpecs: [{ pnSpecId, specId, specName }] }
    const BATCH = 10;

    for (let i = 0; i < specs.length; i += BATCH) {
      const batch = specs.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (spec) => {
        try {
          const detail = await getSpec(spec.idInDomain, spec.revisionNumber);
          if (!detail) return [];
          const pnSpecs = detail.partNumberSpecsBySpecId?.nodes || [];
          return pnSpecs
            .filter(ps => !ps.archivedAt && ps.partNumberByPartNumberId?.isActive !== false)
            .map(ps => ({
              pnId: ps.partNumberId,
              pnName: ps.partNumberByPartNumberId?.name || `PN ${ps.partNumberId}`,
              pnSpecId: ps.id,
              specId: spec.id,
              specName: spec.name
            }));
        } catch (e) {
          warn(`GetSpec ${spec.name}: ${String(e).substring(0, 120)}`);
          return [];
        }
      }));

      for (const entries of batchResults) {
        for (const entry of entries) {
          if (!pnMap[entry.pnId]) {
            pnMap[entry.pnId] = { pnId: entry.pnId, pnName: entry.pnName, pnSpecs: [] };
          }
          pnMap[entry.pnId].pnSpecs.push({
            pnSpecId: entry.pnSpecId,
            specId: entry.specId,
            specName: entry.specName
          });
        }
      }

      const pct = 10 + ((i + BATCH) / specs.length) * 30;
      updateProgress(`Revisando PNs de ${Math.min(i + BATCH, specs.length)}/${specs.length} specs`, Math.min(pct, 40));
    }

    // Only PNs with 2+ specs are candidates
    const candidates = Object.values(pnMap).filter(pn => pn.pnSpecs.length >= 2);
    log(`PNs con 2+ specs externas: ${candidates.length}`);

    if (!candidates.length) {
      removeUI();
      log('Sin conflictos detectados.');
      return [];
    }

    // Phase 2: For each candidate, get spec fields and detect shared fields
    const specFieldsCache = {}; // specId → [{ specFieldId, fieldName }]
    const conflicts = [];

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (pn) => {
        try {
          // Get spec fields for each spec (cached)
          for (const ps of pn.pnSpecs) {
            if (!specFieldsCache[ps.specId]) {
              const detail = await getSpecFields(ps.specId);
              const fields = detail?.specFieldSpecsBySpecId?.nodes || [];
              specFieldsCache[ps.specId] = fields.map(f => ({
                specFieldId: f.specFieldBySpecFieldId?.id,
                fieldName: f.specFieldBySpecFieldId?.name || '?'
              }));
            }
          }

          // Build map: specFieldId → specs that have it
          const fieldToSpecs = {};
          for (const ps of pn.pnSpecs) {
            const fields = specFieldsCache[ps.specId] || [];
            for (const f of fields) {
              if (!f.specFieldId) continue;
              if (!fieldToSpecs[f.specFieldId]) fieldToSpecs[f.specFieldId] = { fieldName: f.fieldName, specs: [] };
              fieldToSpecs[f.specFieldId].specs.push(ps);
            }
          }

          const sharedFields = Object.values(fieldToSpecs).filter(v => v.specs.length >= 2);
          if (sharedFields.length === 0) return null;

          // Collect unique specs involved in any conflict
          const involvedSpecIds = new Set();
          for (const sf of sharedFields) {
            for (const s of sf.specs) involvedSpecIds.add(s.specId);
          }
          const involvedSpecs = pn.pnSpecs.filter(ps => involvedSpecIds.has(ps.specId));

          return {
            pnId: pn.pnId,
            pnName: pn.pnName,
            specs: involvedSpecs,
            sharedFields: sharedFields.map(sf => sf.fieldName)
          };
        } catch (e) {
          warn(`Conflict check ${pn.pnName}: ${String(e).substring(0, 120)}`);
          return null;
        }
      }));

      for (const r of batchResults) {
        if (r) conflicts.push(r);
      }

      const pct = 40 + ((i + BATCH) / candidates.length) * 50;
      updateProgress(`Detectando conflictos: ${Math.min(i + BATCH, candidates.length)}/${candidates.length} PNs`, Math.min(pct, 90));
    }

    log(`PNs con conflictos reales: ${conflicts.length}`);

    if (conflicts.length === 0) {
      removeUI();
      return conflicts;
    }

    // Phase 3: Enrich conflict PNs with labels and process
    updateProgress(`Cargando etiquetas y procesos...`, 92);
    for (let i = 0; i < conflicts.length; i += BATCH) {
      const batch = conflicts.slice(i, i + BATCH);
      await Promise.all(batch.map(async (c) => {
        try {
          const detail = await getPNDetail(c.pnId);
          c.labels = (detail?.partNumberLabelsByPartNumberId?.nodes || []).map(n => ({
            name: n.labelByLabelId?.name || '?',
            color: n.labelByLabelId?.color || '#475569'
          }));
          c.process = detail?.processNodeByDefaultProcessNodeId?.name || null;
        } catch (e) {
          c.labels = [];
          c.process = null;
        }
      }));
      updateProgress(`Etiquetas: ${Math.min(i + BATCH, conflicts.length)}/${conflicts.length}`, 92 + ((i + BATCH) / conflicts.length) * 8);
    }

    removeUI();
    return { conflicts, specFieldsCache };
  }

  // ── Conflict Resolver Modal ──
  function showConflictResolverModal(conflicts) {
    return new Promise((resolve) => {
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-specm-overlay';
      const md = document.createElement('div');
      md.className = 'sa-specm-modal';
      md.style.background = '#1a1a2e';
      md.style.maxWidth = '800px';

      // Build cards HTML
      const cardsHTML = conflicts.map((c, idx) => {
        const specsHTML = c.specs.map(s =>
          `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0;cursor:pointer">
            <input type="checkbox" class="sa-cr-spec" data-pn="${idx}" data-pnspecid="${s.pnSpecId}" data-specid="${s.specId}" data-specname="${s.specName}" checked>
            <span style="color:#e2e8f0">${s.specName}</span>
          </label>`
        ).join('');

        const labelsHTML = (c.labels || []).map(l =>
          `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${l.color};color:#fff;white-space:nowrap">${l.name}</span>`
        ).join('');
        const processHTML = c.process
          ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px">Proceso: <span style="color:#cbd5e1">${c.process}</span></div>`
          : '';

        return `<div class="sa-cr-card" data-idx="${idx}" style="background:#0f172a;border-radius:8px;padding:14px 16px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:14px;font-weight:700;color:#e2e8f0">${c.pnName}</span>
              <a href="https://app.gosteelhead.com/PartNumbers/${c.pnId}" target="_blank" style="color:#60a5fa;font-size:12px;text-decoration:none" title="Abrir en Steelhead">🔗</a>
              ${labelsHTML}
            </div>
            <label style="font-size:11px;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" class="sa-cr-ignore" data-pn="${idx}"> Ignorar
            </label>
          </div>
          ${processHTML}
          <div style="font-size:11px;color:#64748b;margin-bottom:8px;margin-top:4px">Fields compartidos: ${c.sharedFields.join(', ')}</div>
          <div class="sa-cr-specs-container" data-pn="${idx}">${specsHTML}</div>
          <div class="sa-cr-archive-label" data-pn="${idx}" style="font-size:11px;color:#f59e0b;margin-top:6px"></div>
        </div>`;
      }).join('');

      md.innerHTML = `
        <h2 style="color:#f59e0b;font-size:18px">⚔️ Resolver Conflictos de Specs</h2>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:12px">
          ${conflicts.length} PNs con specs en conflicto. Desmarca las specs que quieres archivar.
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px">
          <input type="text" id="sa-cr-search" class="sa-specm-input" placeholder="Buscar PN..." style="flex:1">
          <label style="font-size:11px;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap">
            <input type="checkbox" id="sa-cr-ignoreall"> Ignorar todas
          </label>
        </div>
        <div id="sa-cr-cards" style="max-height:55vh;overflow-y:auto">
          ${cardsHTML}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
          <div id="sa-cr-status" style="font-size:12px;color:#94a3b8"></div>
          <div class="sa-specm-btnrow" style="margin-top:0">
            <button class="sa-specm-btn sa-specm-btn-cancel" id="sa-cr-cancel">CANCELAR</button>
            <button class="sa-specm-btn sa-specm-btn-exec" id="sa-cr-exec" disabled>EJECUTAR</button>
          </div>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      const updateUI = () => {
        let configured = 0;
        let total = 0;

        conflicts.forEach((c, idx) => {
          const card = md.querySelector(`.sa-cr-card[data-idx="${idx}"]`);
          const ignoreCb = md.querySelector(`.sa-cr-ignore[data-pn="${idx}"]`);
          const specsContainer = md.querySelector(`.sa-cr-specs-container[data-pn="${idx}"]`);
          const archiveLabel = md.querySelector(`.sa-cr-archive-label[data-pn="${idx}"]`);
          const specCbs = md.querySelectorAll(`.sa-cr-spec[data-pn="${idx}"]`);

          if (ignoreCb.checked) {
            specsContainer.style.opacity = '0.3';
            specsContainer.style.pointerEvents = 'none';
            archiveLabel.textContent = '';
            card.style.borderLeft = '3px solid #475569';
            return;
          }

          specsContainer.style.opacity = '1';
          specsContainer.style.pointerEvents = 'auto';
          total++;

          const checked = [...specCbs].filter(cb => cb.checked);
          const unchecked = [...specCbs].filter(cb => !cb.checked);

          // Must keep at least 1
          if (checked.length <= 1) {
            checked.forEach(cb => { cb.disabled = true; });
          } else {
            specCbs.forEach(cb => { cb.disabled = false; });
          }

          if (unchecked.length > 0) {
            const names = unchecked.map(cb => cb.dataset.specname).join(', ');
            archiveLabel.textContent = `Se archivará: ${names}`;
            card.style.borderLeft = '3px solid #f59e0b';
            configured++;
          } else {
            archiveLabel.textContent = '';
            card.style.borderLeft = '3px solid transparent';
          }
        });

        const statusEl = document.getElementById('sa-cr-status');
        statusEl.textContent = `${configured} de ${total} PNs configurados`;

        const execBtn = document.getElementById('sa-cr-exec');
        execBtn.disabled = configured === 0;
      };

      // Search filter
      document.getElementById('sa-cr-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        conflicts.forEach((c, idx) => {
          const card = md.querySelector(`.sa-cr-card[data-idx="${idx}"]`);
          card.style.display = c.pnName.toLowerCase().includes(q) ? '' : 'none';
        });
      });

      // Ignore all toggle
      document.getElementById('sa-cr-ignoreall').addEventListener('change', (e) => {
        md.querySelectorAll('.sa-cr-ignore').forEach(cb => { cb.checked = e.target.checked; });
        updateUI();
      });

      // Checkbox events
      md.addEventListener('change', (e) => {
        if (e.target.classList.contains('sa-cr-ignore') || e.target.classList.contains('sa-cr-spec')) {
          updateUI();
        }
      });

      updateUI();

      // Cancel
      document.getElementById('sa-cr-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      // Execute
      document.getElementById('sa-cr-exec').onclick = () => {
        const actions = [];
        conflicts.forEach((c, idx) => {
          const ignoreCb = md.querySelector(`.sa-cr-ignore[data-pn="${idx}"]`);
          if (ignoreCb.checked) return;
          const unchecked = [...md.querySelectorAll(`.sa-cr-spec[data-pn="${idx}"]`)]
            .filter(cb => !cb.checked);
          if (unchecked.length === 0) return;
          actions.push({
            pnId: c.pnId,
            pnName: c.pnName,
            toArchive: unchecked.map(cb => ({
              pnSpecId: parseInt(cb.dataset.pnspecid),
              specId: parseInt(cb.dataset.specid),
              specName: cb.dataset.specname
            }))
          });
        });
        ov.parentNode.removeChild(ov);
        resolve({ actions });
      };
    });
  }

  // ── Conflict Resolver Summary ──
  function showConflictResolverSummary(results) {
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
      <h2 style="color:${iconColor}">${icon} Conflictos Resueltos</h2>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#4ade80">${results.archived}</div>
          <div style="font-size:11px;color:#94a3b8">Specs archivadas</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#94a3b8">${results.ignored}</div>
          <div style="font-size:11px;color:#94a3b8">PNs ignorados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#ef4444">${results.errors.length}</div>
          <div style="font-size:11px;color:#94a3b8">Errores</div>
        </div>
      </div>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">
        PNs procesados: ${results.processed} · Conflictos detectados: ${results.totalConflicts}
      </div>
      ${errorsHTML}
      <div class="sa-specm-btnrow" style="margin-top:16px">
        <button class="sa-specm-btn" id="sa-cr-copylog" style="background:#334155;color:#e2e8f0">📋 Copiar Log</button>
        <button class="sa-specm-btn sa-specm-btn-exec" id="sa-cr-close">CERRAR</button>
      </div>`;

    ov.appendChild(md);
    document.body.appendChild(ov);

    document.getElementById('sa-cr-close').onclick = () => ov.parentNode.removeChild(ov);
    document.getElementById('sa-cr-copylog').onclick = () => {
      const logText = api().getLog().join('\n');
      navigator.clipboard.writeText(logText).then(() => {
        const btn = document.getElementById('sa-cr-copylog');
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📋 Copiar Log'; }, 2000);
      });
    };
  }

  // ══════════════════════════════════════════
  // RESOLVE CONFLICTS — Orchestrator
  // ══════════════════════════════════════════

  async function resolveConflicts() {
    // Phase 1: Scan
    const scanResult = await scanForConflicts();
    const conflicts = scanResult.conflicts;
    const specFieldsCache = scanResult.specFieldsCache;

    if (!conflicts.length) {
      showConflictResolverSummary({ archived: 0, ignored: 0, processed: 0, totalConflicts: 0, errors: [] });
      return { noConflicts: true };
    }

    // Phase 2: Show resolver modal
    const choice = await showConflictResolverModal(conflicts);
    if (choice.cancelled) return { cancelled: true };

    const { actions } = choice;
    const ignored = conflicts.length - actions.length;

    log(`\nPNs a procesar: ${actions.length}, ignorados: ${ignored}`);

    // Phase 3: Execute archives
    const results = { archived: 0, ignored, processed: actions.length, totalConflicts: conflicts.length, errors: [] };

    showProgressUI('Archivando specs', `0/${actions.length} PNs`);
    const PBATCH = 10;

    for (let i = 0; i < actions.length; i += PBATCH) {
      const batch = actions.slice(i, i + PBATCH);
      const pct = (i / actions.length) * 100;
      updateProgress(`${i + 1}-${Math.min(i + PBATCH, actions.length)}/${actions.length} PNs`, pct);

      await Promise.allSettled(batch.map(async (action) => {
        // Collect specFieldIds from specs being archived (to clean up orphaned params)
        const archivedFieldIds = new Set();
        for (const spec of action.toArchive) {
          const cached = specFieldsCache[spec.specId];
          if (cached) {
            for (const f of cached) if (f.specFieldId) archivedFieldIds.add(f.specFieldId);
          }
        }

        for (const spec of action.toArchive) {
          try {
            await archiveSpecOnPN(spec.pnSpecId, []);
            results.archived++;
            log(`  ✓ ${action.pnName}: archivada ${spec.specName}`);
          } catch (e) {
            const errMsg = `${action.pnName}/${spec.specName}: ${String(e).substring(0, 120)}`;
            results.errors.push(errMsg);
            warn(`  ✗ ${errMsg}`);
          }
        }

        // Archive orphaned params from the archived spec's fields
        if (archivedFieldIds.size > 0) {
          try {
            const detail = await getPNDetail(action.pnId);
            const params = detail?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
            const orphaned = params.filter(p => !p.archivedAt && archivedFieldIds.has(p.specFieldId));
            for (const p of orphaned) {
              await archiveParam(p.id);
            }
            if (orphaned.length > 0) {
              log(`    🧹 ${action.pnName}: ${orphaned.length} params huérfanos archivados`);
            }
          } catch (e) {
            warn(`    ⚠ ${action.pnName}: error limpiando params: ${String(e).substring(0, 100)}`);
          }
        }
      }));
    }

    removeUI();

    // Phase 4: Summary
    log(`\n=== RESULTADO CONFLICTOS ===`);
    log(`Specs archivadas: ${results.archived}`);
    log(`PNs procesados: ${results.processed}`);
    log(`PNs ignorados: ${results.ignored}`);
    log(`Errores: ${results.errors.length}`);

    showConflictResolverSummary(results);
    return results;
  }


  // ════════════════════════════════════════════════════════
  //  DUPLICATE-PARAMS VALIDATOR (action 0.5.1)
  //  Detecta PNs con >1 param activo por specFieldSpecId (= mismo SpecField de
  //  la misma Spec, sin importar processNode/location), permite elegir cuál
  //  conservar y archivar el resto vía UpdatePartNumberSpecParam{archivedAt:ISO}
  //  (reversible con null).
  //
  //  0.5.0: modo CSV — el usuario carga el CSV de bulk-upload y el validator
  //  resuelve pnIds (multi-cliente + dedup QuoteIBMS), detecta issues por PN
  //  (duplicados + processNode no-null + sfp distinto al CSV) y aplica corrección
  //  vía SavePartNumber (archive perdedores + insert NULL del wanted). Sin
  //  re-correr toda la carga masiva.
  //
  //  0.4.1: agrupación corregida — el response de GetPartNumber NO expone
  //  partNumberSpecId en partNumberSpecFieldParamsByPartNumberId.nodes[]; se
  //  navega specFieldParamBySpecFieldParamId.specFieldSpecBySpecFieldSpecId.id.
  //  La key (partNumberSpecId, specFieldId) de 0.4.0 era undefined → 0 detecciones.
  //
  //  0.4.2: UX — auto-decisión para grupos "sameSfp" (todos los params comparten
  //  el mismo SpecFieldParam y difieren sólo por processNodeId null vs valor).
  //  Toggle global decide por estos sin radios manuales. Grupos con sfpId
  //  distintos (caso Espesor: 5.8-8.89 µm vs 7.62-15.24 µm) conservan radios
  //  manuales como antes.
  //
  //  0.4.3: regla alineada con bulk-upload 1.4.38 — el SpecField agrupa, no el
  //  SpecFieldParam. Sólo puede vivir 1 row por SpecField y debe ser NULL.
  //  Casos:
  //    • 1 sfpId con ≥1 NULL → auto: conservar NULL más reciente, archivar resto
  //      (incluyendo otros NULLs y todos los con processNode del mismo sfp).
  //    • 2+ sfpIds con MISMO paramName (duplicación pura) → auto: igual al caso 1
  //      tras consolidar bajo el sfpId que ya tenga un NULL.
  //    • 2+ sfpIds con paramName DISTINTO → manual: radio buttons para elegir
  //      el ganador. Default = sfpId que tiene rows con processNode más reciente
  //      (es el que bulk-upload acaba de validar). El usuario puede cambiarlo.
  //    • 1 sfpId con sólo processNode (sin NULL) → manual: el validator sólo
  //      archive, no inserta. Quedará 1 row con processNode hasta que bulk-upload
  //      vuelva a pasar y lo reescriba como NULL.
  //
  //  Eliminado en 0.4.3: toggle global keepNullProcessNode (no aplica — la regla
  //  es absoluta).
  //
  //  Bundle: vive en spec-migrator (menú "Ajuste Masivo de Specs") porque es
  //  validación + corrección de specs ya aplicadas, no edición de parámetros.
  // ════════════════════════════════════════════════════════

  // Helpers locales del validador (no colisionan con el resto del módulo)
  const dupSleep = (ms) => new Promise(r => setTimeout(r, ms));
  const dupRetryDelays = [1000, 2000, 4000];

  async function dupWithRetry(fn, label) {
    let lastErr = null;
    for (let i = 0; i <= dupRetryDelays.length; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        if (i === dupRetryDelays.length) throw e;
        warn(`${label} falló intento ${i + 1}/${dupRetryDelays.length + 1}: ${e?.message || e}; retry en ${dupRetryDelays[i]}ms`);
        await dupSleep(dupRetryDelays[i]);
      }
    }
    throw lastErr;
  }

  async function dupRunPool(items, worker, concurrency, onProgress) {
    const results = new Array(items.length);
    let idx = 0, done = 0;
    const workers = new Array(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        try { results[i] = await worker(items[i], i); }
        catch (e) { results[i] = { __error: e?.message || String(e) }; }
        done++;
        if (onProgress) { try { onProgress(done, items.length); } catch (_) {} }
      }
    });
    await Promise.all(workers);
    return results;
  }

  function dupEscHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function dupEnsureStyles() {
    if (document.getElementById('sa-specm-dup-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-specm-dup-styles';
    s.textContent = `
      .sa-specm-dup-overlay { position:fixed; right:18px; bottom:18px; width:880px; max-height:78vh;
        background:#1f2937; color:#e5e7eb; border:1px solid #374151; border-radius:10px;
        box-shadow:0 6px 24px rgba(0,0,0,0.4);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        font-size:13px; z-index:2147483647; display:flex; flex-direction:column; }
      .sa-specm-dup-overlay .dup-hdr { padding:10px 12px; background:#111827; border-bottom:1px solid #374151;
        display:flex; align-items:center; justify-content:space-between; border-radius:10px 10px 0 0; }
      .sa-specm-dup-overlay .dup-hdr h3 { margin:0; font-size:14px; color:#f9fafb; }
      .sa-specm-dup-overlay .dup-body { padding:10px 12px; overflow-y:auto; flex:1; }
      .sa-specm-dup-overlay .dup-ftr { padding:10px 12px; border-top:1px solid #374151; background:#111827;
        border-radius:0 0 10px 10px; display:flex; gap:8px; align-items:center; justify-content:space-between; }
      .sa-specm-dup-overlay .dup-btn { background:#8b5cf6; color:white; border:none; padding:6px 12px;
        border-radius:6px; cursor:pointer; font-size:12px; }
      .sa-specm-dup-overlay .dup-btn:hover:not(:disabled) { background:#7c3aed; }
      .sa-specm-dup-overlay .dup-btn:disabled { background:#4b5563; cursor:not-allowed; opacity:0.6; }
      .sa-specm-dup-overlay .dup-btn-ghost { background:transparent; color:#9ca3af; border:1px solid #374151; }
      .sa-specm-dup-overlay .dup-btn-ghost:hover { color:#e5e7eb; border-color:#6b7280; }
      .sa-specm-dup-overlay .dup-btn-danger { background:#dc2626; }
      .sa-specm-dup-overlay .dup-btn-danger:hover:not(:disabled) { background:#b91c1c; }
      .sa-specm-dup-overlay .dup-filter-row { display:flex; gap:10px; margin-bottom:8px; align-items:center; flex-wrap:wrap; }
      .sa-specm-dup-overlay label { font-size:12px; color:#d1d5db; }
      .sa-specm-dup-overlay input[type=text] { background:#0f172a; color:#e5e7eb; border:1px solid #334155;
        padding:4px 8px; border-radius:4px; font-size:12px; flex:1; }
      .sa-specm-dup-overlay input[type=text]:focus { outline:1px solid #8b5cf6; }
      .sa-specm-dup-overlay .dup-counter { font-size:11px; color:#9ca3af; }
      .sa-specm-dup-overlay .dup-progress { margin:8px 0; font-size:12px; color:#a78bfa; }
      .sa-specm-dup-overlay .dup-bar { height:4px; background:#1f2937; border-radius:2px; overflow:hidden; margin-top:4px; }
      .sa-specm-dup-overlay .dup-bar div { height:100%; background:#8b5cf6; transition:width 0.2s; }
      .sa-specm-dup-overlay .dup-error { color:#f87171; font-size:12px; padding:6px; background:#7f1d1d33;
        border:1px solid #7f1d1d; border-radius:4px; }
      .sa-specm-dup-overlay .dup-success { color:#6ee7b7; font-size:12px; padding:6px; background:#14532d33;
        border:1px solid #14532d; border-radius:4px; }
      .sa-specm-dup-overlay .dup-stats { display:flex; gap:14px; font-size:11px; color:#cbd5e1;
        background:#0f172a; padding:6px 10px; border-radius:6px; margin-bottom:8px; flex-wrap:wrap; }
      .sa-specm-dup-overlay .dup-stats b { color:#f9fafb; }
      .sa-specm-dup-overlay .dup-table { width:100%; border-collapse:collapse; font-size:11px; }
      .sa-specm-dup-overlay .dup-table thead th { position:sticky; top:0; background:#111827;
        z-index:1; padding:5px 6px; border:1px solid #374151; text-align:left; color:#f9fafb; font-size:11px; }
      .sa-specm-dup-overlay .dup-table td { border:1px solid #1f2937; padding:5px 6px; vertical-align:top; }
      .sa-specm-dup-overlay .dup-table .pname { color:#a78bfa; font-weight:600; }
      .sa-specm-dup-overlay .dup-table .pmeta { font-size:10px; color:#9ca3af; }
      .sa-specm-dup-overlay .dup-table .dup-radio-row { display:flex; align-items:center; gap:6px;
        padding:2px 0; cursor:pointer; }
      .sa-specm-dup-overlay .dup-table .dup-radio-row.winner { color:#6ee7b7; }
      .sa-specm-dup-overlay .dup-table .dup-radio-row.loser { color:#fca5a5; }
      .sa-specm-dup-overlay .dup-table tr.ignored td { opacity:0.45; }
      .sa-specm-dup-overlay .dup-table tr.ignored .dup-radio-row { color:#9ca3af !important; }
      .sa-specm-dup-overlay .dup-table .dup-mini { font-size:10px; color:#cbd5e1; background:#1f2937;
        padding:1px 5px; border-radius:8px; margin-left:4px; }
    `;
    document.head.appendChild(s);
  }

  // Estado del validador
  const dupState = {
    panelEl: null,
    runId: 0,
    customerFilter: '',
    specFilter: '',
    groups: [],
    decisions: new Map(),
  };

  function dupClosePanel() {
    if (dupState.panelEl && dupState.panelEl.parentNode) dupState.panelEl.parentNode.removeChild(dupState.panelEl);
    dupState.panelEl = null;
  }

  function dupEnsurePanel(title) {
    dupClosePanel();
    dupEnsureStyles();
    const el = document.createElement('div');
    el.className = 'sa-specm-dup-overlay';
    el.innerHTML = `
      <div class="dup-hdr">
        <h3>${dupEscHtml(title)}</h3>
        <button class="dup-btn dup-btn-ghost" data-act="dup-close">✕</button>
      </div>
      <div class="dup-body"></div>
      <div class="dup-ftr"></div>
    `;
    document.body.appendChild(el);
    dupState.panelEl = el;
    el.querySelector('[data-act=dup-close]')?.addEventListener('click', () => {
      dupState.runId++;
      dupClosePanel();
    });
    return el;
  }

  function dupSetBody(html) {
    if (!dupState.panelEl) return;
    dupState.panelEl.querySelector('.dup-body').innerHTML = html;
  }
  function dupSetFooter(html) {
    if (!dupState.panelEl) return;
    dupState.panelEl.querySelector('.dup-ftr').innerHTML = html;
  }

  async function runDuplicateParamsValidator() {
    const myRunId = ++dupState.runId;
    dupEnsurePanel('Validar params duplicados por SpecField');

    dupState.customerFilter = '';
    dupState.specFilter = '';
    dupState.groups = [];
    dupState.decisions = new Map();

    dupRenderFilterPanel(myRunId);
  }

  function dupRenderFilterPanel(myRunId) {
    dupSetBody(`
      <div style="font-size:12px;color:#cbd5e1;margin-bottom:8px">
        Escanea PNs activos y detecta &gt;1 param activo por (Spec, SpecField).
        Puedes filtrar por cliente, spec, ambos o ninguno (vacío = todos los PNs activos).
      </div>
      <div class="dup-filter-row">
        <label style="flex:1">Cliente (contiene):
          <input type="text" data-ctrl="dup-cust" placeholder="Ej. JABIL — vacío = todos" autocomplete="off">
        </label>
      </div>
      <div class="dup-filter-row">
        <label style="flex:1">Spec (nombre contiene):
          <input type="text" data-ctrl="dup-spec" placeholder="Ej. NIQUEL — vacío = todas" autocomplete="off">
        </label>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:6px">
        Aviso: escanear sin filtros revisa todos los PNs activos (puede tardar varios minutos).
      </div>
      <div style="background:#0f172a;border:1px dashed #334155;border-radius:6px;padding:8px 10px;margin-top:10px">
        <div style="font-size:12px;color:#a78bfa;font-weight:600;margin-bottom:4px">⚡ Modo CSV (opcional)</div>
        <div style="font-size:11px;color:#cbd5e1;margin-bottom:6px">
          Carga el CSV de bulk-upload original. El validator resolverá los PNs (multi-cliente + dedup por QuoteIBMS), detectará issues vs CSV y corregirá vía SavePartNumber sin re-correr la carga masiva.
          <br><span style="color:#9ca3af">Si cargas CSV, los filtros cliente/spec arriba se ignoran.</span>
        </div>
        <input type="file" data-ctrl="dup-csv-file" accept=".csv,text/csv" style="font-size:11px;color:#cbd5e1">
        <div data-ctrl="dup-csv-status" style="font-size:11px;color:#9ca3af;margin-top:4px"></div>
      </div>
    `);
    dupSetFooter(`
      <span class="dup-counter">Listo</span>
      <div style="display:flex;gap:6px">
        <button class="dup-btn dup-btn-ghost" data-act="dup-cancel">Cerrar</button>
        <button class="dup-btn" data-act="dup-start">Escanear</button>
      </div>
    `);
    dupState.panelEl.querySelector('[data-act=dup-cancel]')?.addEventListener('click', () => dupClosePanel());

    const csvInput = dupState.panelEl.querySelector('[data-ctrl=dup-csv-file]');
    const csvStatus = dupState.panelEl.querySelector('[data-ctrl=dup-csv-status]');
    let csvFile = null;
    csvInput?.addEventListener('change', (ev) => {
      csvFile = ev.target.files?.[0] || null;
      if (csvStatus) {
        csvStatus.textContent = csvFile
          ? `✓ ${csvFile.name} (${Math.round(csvFile.size / 1024)} KB)`
          : '';
      }
    });

    dupState.panelEl.querySelector('[data-act=dup-start]')?.addEventListener('click', async () => {
      dupState.customerFilter = dupState.panelEl.querySelector('[data-ctrl=dup-cust]')?.value?.trim() || '';
      dupState.specFilter = dupState.panelEl.querySelector('[data-ctrl=dup-spec]')?.value?.trim() || '';
      try {
        if (csvFile) {
          const csvText = await csvFile.text();
          await dupRunScanFromCsv(myRunId, csvText, csvFile.name);
        } else {
          await dupRunScan(myRunId);
        }
      } catch (e) {
        if (dupState.runId !== myRunId) return;
        dupSetBody(`<div class="dup-error">Error en escaneo: ${dupEscHtml(e.message)}</div>`);
        dupSetFooter(`<button class="dup-btn" data-act="dup-close-err">Cerrar</button>`);
        dupState.panelEl.querySelector('[data-act=dup-close-err]')?.addEventListener('click', () => dupClosePanel());
      }
    });
  }

  async function dupRunScan(myRunId) {
    dupSetBody(`<div class="dup-progress">
      Fase 1/2: cargando PNs…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="dup-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    dupSetFooter(`<button class="dup-btn dup-btn-danger" data-act="dup-cancel-run">Cancelar</button>`);
    dupState.panelEl.querySelector('[data-act=dup-cancel-run]')?.addEventListener('click', () => {
      dupState.runId++;
      dupClosePanel();
    });
    const progMsg = dupState.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar = dupState.panelEl.querySelector('[data-ctrl=prog-bar]');

    // ── Fase 1: AllPartNumbers paginado, filtro cliente cliente-side
    const allPNs = [];
    let offset = 0;
    const PAGE = 500;
    const custFilter = dupState.customerFilter.toUpperCase();
    while (true) {
      if (dupState.runId !== myRunId) return;
      const data = await dupWithRetry(
        () => api().query('AllPartNumbers',
          { orderBy: ['NAME_ASC'], offset, first: PAGE, searchQuery: '' },
          'AllPartNumbers'),
        `AllPartNumbers offset=${offset}`
      );
      if (dupState.runId !== myRunId) return;
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (n.archivedAt) continue;
        if (custFilter && !(n.customerByCustomerId?.name || '').toUpperCase().includes(custFilter)) continue;
        allPNs.push(n);
      }
      if (progMsg) progMsg.textContent = `${allPNs.length} PNs cargados (offset ${offset})`;
      if (nodes.length < PAGE) break;
      offset += PAGE;
    }

    if (!allPNs.length) {
      dupSetBody(`<div class="dup-error">No se encontraron PNs activos${dupState.customerFilter ? ` para cliente "${dupEscHtml(dupState.customerFilter)}"` : ''}.</div>`);
      dupSetFooter(`<button class="dup-btn" data-act="dup-close-empty">Cerrar</button>`);
      dupState.panelEl.querySelector('[data-act=dup-close-empty]')?.addEventListener('click', () => dupClosePanel());
      return;
    }

    log(`[SPM-dup] Fase 1 OK: ${allPNs.length} PNs activos${custFilter ? ` (cliente ${dupState.customerFilter})` : ''}`);

    // ── Fase 2: GetPartNumber con runPool 6, detectar grupos
    dupSetBody(`<div class="dup-progress">
      Fase 2/2: revisando ${allPNs.length} PNs (concurrencia 6)…
      <div data-ctrl="prog-msg">Iniciando…</div>
      <div class="dup-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    const progMsg2 = dupState.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar2 = dupState.panelEl.querySelector('[data-ctrl=prog-bar]');

    const specFilterLow = dupState.specFilter.toLowerCase();
    const groups = [];
    const fetchErrors = [];

    await dupRunPool(allPNs, async (pn) => {
      if (dupState.runId !== myRunId) return;
      let detail = null;
      try {
        const data = await dupWithRetry(
          () => api().query('GetPartNumber', { partNumberId: pn.id }),
          `GetPartNumber ${pn.id}`
        );
        detail = data?.partNumberById;
      } catch (e) {
        fetchErrors.push({ pnId: pn.id, pnName: pn.name, error: e?.message || String(e) });
        return;
      }
      if (!detail) return;

      const allParams = detail.partNumberSpecFieldParamsByPartNumberId?.nodes || [];

      // Agrupar params activos por specFieldSpecId (= "este SpecField de esta Spec").
      // El response NO expone partNumberSpecId en estos nodes, así que navegamos
      // por specFieldParamBySpecFieldParamId.specFieldSpecBySpecFieldSpecId.
      const buckets = new Map();
      for (const p of allParams) {
        if (p.archivedAt) continue;
        const sfp = p.specFieldParamBySpecFieldParamId;
        if (!sfp) continue;
        const sfs = sfp.specFieldSpecBySpecFieldSpecId;
        if (!sfs?.id) continue;

        const specName = sfs.specBySpecId?.name || '';
        if (specFilterLow && !specName.toLowerCase().includes(specFilterLow)) continue;

        const sfsId = sfs.id;
        if (!buckets.has(sfsId)) {
          buckets.set(sfsId, {
            params: [],
            specName,
            specId: sfs.specBySpecId?.id || null,
            specIdInDomain: sfs.specBySpecId?.idInDomain || null,
            fieldName: sfs.specFieldBySpecFieldId?.name || '',
            fieldId: sfs.specFieldBySpecFieldId?.id || p.specFieldId,
          });
        }
        buckets.get(sfsId).params.push(p);
      }

      for (const [sfsId, bucket] of buckets) {
        if (bucket.params.length < 2) continue;
        const sorted = [...bucket.params].sort((a, b) => Number(b.id) - Number(a.id));

        const mappedParams = sorted.map(p => ({
          rowId: p.id,
          sfpId: p.specFieldParamBySpecFieldParamId?.id ?? null,
          sfpName: p.specFieldParamBySpecFieldParamId?.name || '(sin nombre)',
          processNodeId: p.processNodeId || null,
          processNodeOccurrence: p.processNodeOccurrence || null,
          locationId: p.locationId || null,
        }));

        // 0.4.3: clasificación por SpecField (no por sfpId)
        // sameSfp: todos los params comparten el mismo SpecFieldParam (duplicación pura).
        // sameName: todos comparten el mismo paramName (mismo valor con sfpId distinto
        //   por copia accidental al recrear el SpecFieldParam — tratable como sameSfp).
        // autoDecidable: sameSfp (o sameName) Y al menos un row tiene processNodeId=NULL.
        //   Si ningún row tiene NULL queda manual: el validator sólo archive y no podemos
        //   convertir un row con processNode en NULL (eso lo hace bulk-upload).
        const firstSfpId = mappedParams[0].sfpId;
        const firstName = mappedParams[0].sfpName;
        const sameSfp = firstSfpId != null && mappedParams.every(p => p.sfpId === firstSfpId);
        const sameName = mappedParams.every(p => p.sfpName === firstName);
        const hasNull = mappedParams.some(p => !p.processNodeId);
        const autoDecidable = (sameSfp || sameName) && hasNull;

        const group = {
          key: `${pn.id}-${sfsId}`,
          pnId: pn.id,
          pnName: pn.name || '',
          customer: pn.customerByCustomerId?.name || '',
          specFieldSpecId: sfsId,
          specName: bucket.specName,
          specId: bucket.specId,
          specIdInDomain: bucket.specIdInDomain,
          fieldId: bucket.fieldId,
          fieldName: bucket.fieldName,
          params: mappedParams,
          sameSfp,
          sameName,
          autoDecidable,
        };
        groups.push(group);

        const winnerRowId = autoDecidable
          ? dupComputeAutoWinner(group)
          : dupManualDefaultWinner(group);
        dupState.decisions.set(group.key, { winnerRowId, ignored: false });
      }
    }, 6, (done, total) => {
      if (progMsg2) progMsg2.textContent = `${done}/${total} PNs revisados — ${groups.length} grupos duplicados`;
      if (progBar2) progBar2.style.width = `${(done / total) * 100}%`;
    });

    if (dupState.runId !== myRunId) return;
    dupState.groups = groups;

    log(`[SPM-dup] Fase 2 OK: ${groups.length} grupos duplicados en ${new Set(groups.map(g => g.pnId)).size} PNs (${fetchErrors.length} errores fetch)`);

    if (!groups.length) {
      dupSetBody(`<div class="dup-success">
        ✓ Sin duplicados detectados en ${allPNs.length} PNs revisados.
        ${fetchErrors.length ? `<br><span style="color:#fbbf24">⚠ ${fetchErrors.length} PNs no pudieron consultarse</span>` : ''}
      </div>`);
      dupSetFooter(`<button class="dup-btn" data-act="dup-close-ok">Cerrar</button>`);
      dupState.panelEl.querySelector('[data-act=dup-close-ok]')?.addEventListener('click', () => dupClosePanel());
      return;
    }

    dupRenderTable(myRunId, allPNs.length, fetchErrors);
  }

  function dupRenderTable(myRunId, scannedCount, fetchErrors) {
    const groups = dupState.groups;
    const uniquePNs = new Set(groups.map(g => g.pnId)).size;
    const losersCount = groups.reduce((s, g) => s + (g.params.length - 1), 0);
    const autoCount = groups.filter(g => g.autoDecidable).length;
    const manualCount = groups.length - autoCount;

    const body = dupState.panelEl.querySelector('.dup-body');
    body.innerHTML = '';

    const stats = document.createElement('div');
    stats.className = 'dup-stats';
    const mk = (lbl, val) => {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = String(val);
      span.appendChild(document.createTextNode(`${lbl}: `));
      span.appendChild(b);
      return span;
    };
    stats.appendChild(mk('PNs revisados', scannedCount));
    stats.appendChild(mk('PNs con duplicados', uniquePNs));
    stats.appendChild(mk('Grupos', groups.length));
    stats.appendChild(mk('Auto-decidibles', autoCount));
    stats.appendChild(mk('Manuales', manualCount));
    stats.appendChild(mk('Params a archivar', losersCount));
    if (fetchErrors.length) stats.appendChild(mk('Errores fetch', fetchErrors.length));
    body.appendChild(stats);

    // 0.4.3: nota informativa de la regla (sin toggle — la regla es absoluta).
    if (autoCount > 0) {
      const info = document.createElement('div');
      info.style.cssText = 'background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:#cbd5e1';
      info.innerHTML = `Regla: por SpecField sólo puede vivir 1 row con <b style="color:#a78bfa">processNodeId=NULL</b>. ${autoCount} grupos auto-decidibles (mismo param, conservar NULL más reciente). ${manualCount} grupos manuales (paramName distinto entre sfpIds o ningún NULL existente — elige el ganador con radios).`;
      body.appendChild(info);
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-height:48vh;overflow-y:auto;border:1px solid #374151;border-radius:6px';
    const table = document.createElement('table');
    table.className = 'dup-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['PN', 'Cliente', 'Spec', 'SpecField', 'Params (conservar)', 'Ignorar'].forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const g of groups) {
      const tr = document.createElement('tr');
      tr.dataset.key = g.key;

      const tdPn = document.createElement('td');
      const pname = document.createElement('div');
      pname.className = 'pname';
      pname.textContent = g.pnName;
      const pmeta = document.createElement('div');
      pmeta.className = 'pmeta';
      pmeta.textContent = `#${g.pnId}`;
      tdPn.appendChild(pname);
      tdPn.appendChild(pmeta);
      tr.appendChild(tdPn);

      const tdCust = document.createElement('td');
      tdCust.textContent = g.customer;
      tr.appendChild(tdCust);

      const tdSpec = document.createElement('td');
      tdSpec.textContent = g.specName || `(spec ${g.specIdInDomain})`;
      tr.appendChild(tdSpec);

      const tdField = document.createElement('td');
      tdField.textContent = g.fieldName || `(field ${g.fieldId})`;
      tr.appendChild(tdField);

      const tdParams = document.createElement('td');
      const initialWinner = dupState.decisions.get(g.key)?.winnerRowId;

      if (g.autoDecidable) {
        // Auto: pill que muestra qué se conserva y qué se archiva, derivado del toggle
        const pill = document.createElement('div');
        pill.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:6px;padding:6px 8px;font-size:11px;color:#cbd5e1';
        const tag = document.createElement('div');
        tag.style.cssText = 'font-size:10px;color:#a78bfa;font-weight:600;margin-bottom:4px';
        tag.textContent = '⚙ AUTO (mismo param, ' + g.params.length + ' filas)';
        pill.appendChild(tag);
        for (const p of g.params) {
          const isWin = p.rowId === initialWinner;
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:1px 0;color:' + (isWin ? '#6ee7b7' : '#fca5a5');
          const ic = document.createElement('span');
          ic.textContent = isWin ? '✓ CONSERVA' : '✗ ARCHIVA';
          ic.style.cssText = 'font-size:9px;font-weight:700;min-width:74px';
          row.appendChild(ic);
          const nm = document.createElement('span');
          nm.textContent = p.sfpName;
          row.appendChild(nm);
          const mini = document.createElement('span');
          mini.className = 'dup-mini';
          mini.textContent = `row#${p.rowId}${p.processNodeId ? ` · pn#${p.processNodeId}` : ' · NULL'}`;
          row.appendChild(mini);
          pill.appendChild(row);
        }
        tdParams.appendChild(pill);
      } else {
        g.params.forEach((p, idx) => {
          const lbl = document.createElement('label');
          lbl.className = 'dup-radio-row';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = `dup-${g.key}`;
          radio.value = String(p.rowId);
          if (p.rowId === initialWinner) radio.checked = true;
          radio.addEventListener('change', () => {
            const dec = dupState.decisions.get(g.key) || {};
            dec.winnerRowId = p.rowId;
            dupState.decisions.set(g.key, dec);
            dupRefreshRadioStyles(tr, g);
            dupUpdateFooter();
          });
          lbl.appendChild(radio);
          const txt = document.createElement('span');
          txt.textContent = p.sfpName;
          lbl.appendChild(txt);
          const mini = document.createElement('span');
          mini.className = 'dup-mini';
          mini.textContent = `row#${p.rowId} · sfp#${p.sfpId}${p.processNodeId ? ` · pn#${p.processNodeId}` : ' · sin proceso'}${idx === 0 ? ' · más reciente' : ''}`;
          lbl.appendChild(mini);
          tdParams.appendChild(lbl);
        });
      }
      tr.appendChild(tdParams);

      const tdIgn = document.createElement('td');
      tdIgn.style.textAlign = 'center';
      const ignCb = document.createElement('input');
      ignCb.type = 'checkbox';
      ignCb.checked = !!dupState.decisions.get(g.key)?.ignored;
      tr.classList.toggle('ignored', ignCb.checked);
      ignCb.addEventListener('change', () => {
        const dec = dupState.decisions.get(g.key) || {};
        dec.ignored = ignCb.checked;
        dupState.decisions.set(g.key, dec);
        tr.classList.toggle('ignored', ignCb.checked);
        dupUpdateFooter();
      });
      tdIgn.appendChild(ignCb);
      tr.appendChild(tdIgn);

      if (!g.autoDecidable) dupRefreshRadioStyles(tr, g);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    dupSetFooter(`
      <span class="dup-counter" data-ctrl="dup-foot-stats"></span>
      <div style="display:flex;gap:6px">
        <button class="dup-btn dup-btn-ghost" data-act="dup-back">← Filtros</button>
        <button class="dup-btn dup-btn-ghost" data-act="dup-download-bit">Descargar XLSX</button>
        <button class="dup-btn dup-btn-danger" data-act="dup-apply">Aplicar fix</button>
      </div>
    `);
    dupState.panelEl.querySelector('[data-act=dup-back]')?.addEventListener('click', () => {
      dupState.runId++;
      runDuplicateParamsValidator();
    });
    dupState.panelEl.querySelector('[data-act=dup-download-bit]')?.addEventListener('click', () => {
      dupBuildBitacora('preview', null);
    });
    dupState.panelEl.querySelector('[data-act=dup-apply]')?.addEventListener('click', async () => {
      if (!confirm('Esto archivará los params no seleccionados (reversible vía UpdatePartNumberSpecParam con archivedAt:null). ¿Continuar?')) return;
      await dupRunApply(myRunId);
    });
    dupUpdateFooter();
  }

  function dupRefreshRadioStyles(tr, g) {
    const winnerRowId = dupState.decisions.get(g.key)?.winnerRowId;
    tr.querySelectorAll('.dup-radio-row').forEach((lbl) => {
      const rb = lbl.querySelector('input[type=radio]');
      const isWin = Number(rb.value) === Number(winnerRowId);
      lbl.classList.toggle('winner', isWin);
      lbl.classList.toggle('loser', !isWin);
    });
  }

  function dupUpdateFooter() {
    const ftr = dupState.panelEl?.querySelector('[data-ctrl=dup-foot-stats]');
    if (!ftr) return;
    let toArchive = 0, ignored = 0;
    for (const g of dupState.groups) {
      const dec = dupState.decisions.get(g.key);
      if (!dec) continue;
      if (dec.ignored) { ignored++; continue; }
      toArchive += (g.params.length - 1);
    }
    ftr.textContent = `${toArchive} params a archivar — ${ignored} grupos ignorados`;
  }

  // 0.4.3: winner auto = NULL más reciente. Aplica a grupos autoDecidable
  // (sameSfp/sameName con al menos 1 row NULL). Si no hay NULL queda manual.
  // params ya vienen sort desc por rowId.
  function dupComputeAutoWinner(g) {
    if (!g.autoDecidable) return g.params[0].rowId;
    const nulls = g.params.filter(p => !p.processNodeId);
    return (nulls.length ? nulls[0] : g.params[0]).rowId;
  }

  // 0.4.3: default manual = row con processNode más reciente (es el último que
  // bulk-upload validó/insertó). Si no hay con processNode, el más reciente.
  function dupManualDefaultWinner(g) {
    const withProc = g.params.filter(p => !!p.processNodeId);
    return (withProc.length ? withProc[0] : g.params[0]).rowId;
  }

  async function dupRunApply(parentRunId) {
    const myRunId = ++dupState.runId;
    void parentRunId;

    const tasks = [];
    for (const g of dupState.groups) {
      const dec = dupState.decisions.get(g.key);
      if (!dec || dec.ignored) continue;
      for (const p of g.params) {
        if (p.rowId === dec.winnerRowId) continue;
        tasks.push({ group: g, paramRowId: p.rowId, sfpName: p.sfpName });
      }
    }

    if (!tasks.length) {
      alert('No hay nada que archivar (todos los grupos están ignorados o solo tienen 1 param).');
      return;
    }

    dupSetBody(`<div class="dup-progress">
      Archivando ${tasks.length} params (concurrencia 3)…
      <div data-ctrl="prog-msg">0/${tasks.length}</div>
      <div class="dup-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    dupSetFooter(`<button class="dup-btn dup-btn-danger" data-act="dup-stop">Cancelar</button>`);
    dupState.panelEl.querySelector('[data-act=dup-stop]')?.addEventListener('click', () => {
      dupState.runId++;
      dupClosePanel();
    });
    const pm = dupState.panelEl.querySelector('[data-ctrl=prog-msg]');
    const pb = dupState.panelEl.querySelector('[data-ctrl=prog-bar]');

    const okRows = [];
    const errRows = [];
    let processed = 0;

    await dupRunPool(tasks, async (t) => {
      if (dupState.runId !== myRunId) return;
      try {
        await dupWithRetry(
          () => api().query('UpdatePartNumberSpecParam',
            { id: t.paramRowId, archivedAt: new Date().toISOString() },
            'UpdatePartNumberSpecParam'),
          `archiveParam ${t.paramRowId}`
        );
        okRows.push({ group: t.group, paramRowId: t.paramRowId, sfpName: t.sfpName });
      } catch (e) {
        errRows.push({ group: t.group, paramRowId: t.paramRowId, sfpName: t.sfpName, error: e?.message || String(e) });
      }
      processed++;
      if (pm) pm.textContent = `${processed}/${tasks.length} (${okRows.length} OK, ${errRows.length} err)`;
      if (pb) pb.style.width = `${(processed / tasks.length) * 100}%`;
    }, 3);

    log(`[SPM-dup] Fix aplicado: ${okRows.length} OK, ${errRows.length} errores`);

    const body = dupState.panelEl.querySelector('.dup-body');
    body.innerHTML = '';
    const sum = document.createElement('div');
    sum.className = okRows.length && !errRows.length ? 'dup-success' : 'dup-error';
    sum.textContent = `Resultado: ${okRows.length} archivados, ${errRows.length} errores. Reversible vía UpdatePartNumberSpecParam con archivedAt:null (usa los rowId del XLSX).`;
    body.appendChild(sum);

    if (errRows.length) {
      const ul = document.createElement('ul');
      ul.style.cssText = 'font-size:11px;color:#fca5a5;max-height:200px;overflow-y:auto;margin-top:8px';
      for (const r of errRows.slice(0, 50)) {
        const li = document.createElement('li');
        li.textContent = `row#${r.paramRowId} (${r.sfpName}) — ${r.error}`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    dupSetFooter(`
      <span class="dup-counter">${okRows.length} OK · ${errRows.length} errores</span>
      <div style="display:flex;gap:6px">
        <button class="dup-btn dup-btn-ghost" data-act="dup-download-final">Descargar XLSX</button>
        <button class="dup-btn" data-act="dup-final-close">Cerrar</button>
      </div>
    `);
    dupState.panelEl.querySelector('[data-act=dup-download-final]')?.addEventListener('click', () => {
      dupBuildBitacora('applied', { okRows, errRows });
    });
    dupState.panelEl.querySelector('[data-act=dup-final-close]')?.addEventListener('click', () => dupClosePanel());

    dupBuildBitacora('applied', { okRows, errRows });
  }

  function dupBuildBitacora(mode, applied) {
    if (!window.XLSX) {
      alert('XLSX (SheetJS) no cargado. Recarga la extensión.');
      return;
    }
    const wb = window.XLSX.utils.book_new();
    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const detRows = [];
    for (const g of dupState.groups) {
      const dec = dupState.decisions.get(g.key) || {};
      for (const p of g.params) {
        const isWinner = p.rowId === dec.winnerRowId;
        detRows.push({
          PNID: g.pnId, PNName: g.pnName, Cliente: g.customer,
          SpecIdInDomain: g.specIdInDomain, SpecName: g.specName,
          FieldID: g.fieldId, FieldName: g.fieldName,
          ParamRowID: p.rowId, SpecFieldParamID: p.sfpId, ParamName: p.sfpName,
          ProcessNodeID: p.processNodeId || '',
          Modo: g.autoDecidable ? 'AUTO' : 'MANUAL',
          Decisión: dec.ignored ? 'IGNORADO' : (isWinner ? 'CONSERVAR' : 'ARCHIVAR'),
        });
      }
    }
    dupAddSheet(wb, 'Detectados', `Detectados · ${detRows.length} filas · ${now}`, detRows,
      ['PNID','PNName','Cliente','SpecIdInDomain','SpecName','FieldID','FieldName',
       'ParamRowID','SpecFieldParamID','ParamName','ProcessNodeID','Modo','Decisión']);

    if (mode === 'applied' && applied) {
      const okRows = (applied.okRows || []).map(r => ({
        PNID: r.group.pnId, PNName: r.group.pnName,
        SpecIdInDomain: r.group.specIdInDomain, SpecName: r.group.specName,
        FieldName: r.group.fieldName,
        ParamRowID: r.paramRowId, ParamName: r.sfpName,
      }));
      dupAddSheet(wb, 'Aplicadas', `Archivadas OK · ${okRows.length} · ${now}`, okRows,
        ['PNID','PNName','SpecIdInDomain','SpecName','FieldName','ParamRowID','ParamName']);

      const errRows = (applied.errRows || []).map(r => ({
        PNID: r.group.pnId, PNName: r.group.pnName,
        SpecIdInDomain: r.group.specIdInDomain, SpecName: r.group.specName,
        FieldName: r.group.fieldName,
        ParamRowID: r.paramRowId, ParamName: r.sfpName, Error: r.error,
      }));
      dupAddSheet(wb, 'Errores', `Errores · ${errRows.length} · ${now}`, errRows,
        ['PNID','PNName','SpecIdInDomain','SpecName','FieldName','ParamRowID','ParamName','Error']);
    }

    const wbOut = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dup-params-${mode}-${now}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function dupAddSheet(wb, name, title, rows, headers) {
    const data = rows.length ? rows.map(r => headers.map(h => r[h] ?? '')) : [headers.map(() => '')];
    const aoa = [[title], headers, ...data];
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
    window.XLSX.utils.book_append_sheet(wb, ws, name);
  }

  // ═══════════════════════════════════════════════════════════
  // CSV-MODE (0.5.0) — validar PNs contra CSV de bulk-upload
  // ═══════════════════════════════════════════════════════════

  // Parser idéntico a bulk-upload.parseCSV (RFC 4180-ish con escape ""/separador ,).
  function dupCsvParseCSV(text) {
    const rows = []; let i = 0;
    while (i < text.length) {
      const row = [];
      while (i < text.length) {
        if (text[i] === '"') {
          i++; let v = '';
          while (i < text.length) {
            if (text[i] === '"') { if (text[i + 1] === '"') { v += '"'; i += 2; } else { i++; break; } }
            else { v += text[i]; i++; }
          }
          row.push(v);
        } else {
          let v = '';
          while (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') { v += text[i]; i++; }
          row.push(v);
        }
        if (text[i] === ',') { i++; continue; } else break;
      }
      if (text[i] === '\r') i++;
      if (text[i] === '\n') i++;
      rows.push(row);
    }
    return rows;
  }

  // Extrae solo lo que el validator necesita del V10: pn(F=5), customer(E=4),
  // quoteIBMS(BK=62), specs (AH=33 + AJ=35 con " | " split).
  function dupCsvParseRows(rows) {
    const get = (row, idx) => (row[idx] || '').toString().trim();
    const parts = [];
    for (const row of rows) {
      const colA = (row[0] || '').trim();
      const colF = (row[5] || '').trim();
      if (colA === 'PARÁMETROS' || colA === 'Archivado' || colA === 'V/F') continue;
      if (colF === 'Texto' || colF.replace(/\s+/g, ' ').toLowerCase() === 'número de parte') continue;
      const pn = get(row, 5);
      if (!pn) continue;
      const customer = get(row, 4);
      const quoteIBMS = get(row, 62);
      const specs = [];
      for (const idx of [33, 35]) {
        const raw = get(row, idx);
        if (!raw) continue;
        if (raw.includes(' | ')) {
          const s = raw.indexOf(' | ');
          specs.push({ name: raw.substring(0, s).trim(), param: raw.substring(s + 3).trim() });
        } else {
          specs.push({ name: raw, param: '' });
        }
      }
      parts.push({ pn, customer, quoteIBMS, specs });
    }
    return parts;
  }

  // Resolución multi-cliente con dedup QuoteIBMS:
  //   1. Fetch AllPartNumbers global (customer + name + customInputs en cada nodo).
  //   2. Index por `customerUpper|pnUpper` → array de nodos.
  //   3. Por cada csvPart: 0 candidates → unresolved; 1 → directo; 2+ → match
  //      por QuoteIBMS del CSV vs customInputs.DatosAdicionalesNP.QuoteIBMS del server.
  async function dupCsvResolvePnIds(csvParts, myRunId, onPhase) {
    onPhase?.('Pre-fetch AllPartNumbers…', 0, 0);
    const allNodes = [];
    let offset = 0;
    const PAGE = 500;
    while (true) {
      if (dupState.runId !== myRunId) return null;
      const data = await dupWithRetry(
        () => api().query('AllPartNumbers',
          { orderBy: ['NAME_ASC'], offset, first: PAGE, searchQuery: '' },
          'AllPartNumbers'),
        `AllPartNumbers offset=${offset}`
      );
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        if (n.archivedAt) continue;
        allNodes.push(n);
      }
      onPhase?.(`Pre-fetch AllPartNumbers (offset ${offset}, ${allNodes.length} activos)…`, offset, 0);
      if (nodes.length < PAGE) break;
      offset += PAGE;
    }

    // 0.5.1: el CSV trae el customer concatenado con dirección fiscal
    // ("BRAININ DE MEXICO — Dirección Fiscal, — Av. San Luis Tlatilc"), pero
    // el server solo guarda el nombre base ("BRAININ DE MEXICO"). bulk-upload.js:1620
    // ya usa esta misma regla para deambiguar — split por em/en-dash o " - ", primer chunk.
    const dupCsvNormCustomer = (s) => (s || '').split(/\s*[—–]\s*|\s+[-]\s+/)[0].trim().toUpperCase();

    const index = new Map();
    for (const n of allNodes) {
      const cust = dupCsvNormCustomer(n.customerByCustomerId?.name || '');
      const name = (n.name || '').trim().toUpperCase();
      if (!cust || !name) continue;
      const k = `${cust}|${name}`;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(n);
    }

    const resolved = []; // { csvPart, pnNode }
    const unresolved = []; // { csvPart, reason }
    const ambiguousByQuote = []; // info-only
    let i = 0;
    for (const cp of csvParts) {
      i++;
      if (i % 200 === 0) onPhase?.(`Resolviendo pnIds (${i}/${csvParts.length})…`, i, csvParts.length);
      const k = `${dupCsvNormCustomer(cp.customer)}|${cp.pn.trim().toUpperCase()}`;
      const cands = index.get(k) || [];
      if (cands.length === 0) { unresolved.push({ csvPart: cp, reason: 'no encontrado' }); continue; }
      if (cands.length === 1) { resolved.push({ csvPart: cp, pnNode: cands[0] }); continue; }
      // 2+ candidates: dedup por QuoteIBMS
      const csvQ = (cp.quoteIBMS || '').trim();
      if (!csvQ) {
        unresolved.push({ csvPart: cp, reason: `${cands.length} candidatos sin QuoteIBMS en CSV` });
        continue;
      }
      const matches = cands.filter(n => {
        const ci = (typeof n.customInputs === 'string')
          ? (() => { try { return JSON.parse(n.customInputs); } catch { return null; } })()
          : (n.customInputs || null);
        const srvQ = (ci?.DatosAdicionalesNP?.QuoteIBMS || '').trim();
        return srvQ === csvQ;
      });
      if (matches.length === 1) {
        resolved.push({ csvPart: cp, pnNode: matches[0] });
        ambiguousByQuote.push({ pn: cp.pn, customer: cp.customer, quoteIBMS: csvQ, resolvedId: matches[0].id });
      } else if (matches.length === 0) {
        unresolved.push({ csvPart: cp, reason: `${cands.length} candidatos, ninguno con QuoteIBMS=${csvQ}` });
      } else {
        unresolved.push({ csvPart: cp, reason: `${matches.length} candidatos con mismo QuoteIBMS=${csvQ}` });
      }
    }
    return { resolved, unresolved, ambiguousByQuote, totalNodes: allNodes.length };
  }

  // Orquesta: parse → resolve → GetPartNumber → clasificar → render.
  async function dupRunScanFromCsv(myRunId, csvText, fileName) {
    dupSetBody(`<div class="dup-progress">
      Modo CSV: <b>${dupEscHtml(fileName || 'archivo')}</b>
      <div data-ctrl="prog-msg">Parseando CSV…</div>
      <div class="dup-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    dupSetFooter(`<button class="dup-btn dup-btn-danger" data-act="dup-cancel-run">Cancelar</button>`);
    dupState.panelEl.querySelector('[data-act=dup-cancel-run]')?.addEventListener('click', () => {
      dupState.runId++;
      dupClosePanel();
    });
    const progMsg = dupState.panelEl.querySelector('[data-ctrl=prog-msg]');
    const progBar = dupState.panelEl.querySelector('[data-ctrl=prog-bar]');
    const setProg = (msg, done, total) => {
      if (dupState.runId !== myRunId) return;
      if (progMsg) progMsg.textContent = msg;
      if (progBar && total > 0) progBar.style.width = `${Math.min(100, (done / total) * 100)}%`;
    };

    const rows = dupCsvParseCSV(csvText);
    const csvParts = dupCsvParseRows(rows);
    if (!csvParts.length) {
      dupSetBody(`<div class="dup-error">CSV no contiene filas válidas (¿formato V10 con columna F=PN?).</div>`);
      dupSetFooter(`<button class="dup-btn" data-act="dup-close-err">Cerrar</button>`);
      dupState.panelEl.querySelector('[data-act=dup-close-err]')?.addEventListener('click', () => dupClosePanel());
      return;
    }
    log(`[SPM-dup-csv] CSV parsed: ${csvParts.length} PNs`);

    setProg('Resolviendo pnIds…', 0, csvParts.length);
    const resolution = await dupCsvResolvePnIds(csvParts, myRunId, (m, d, t) => setProg(m, d, t));
    if (!resolution) return;
    if (dupState.runId !== myRunId) return;
    log(`[SPM-dup-csv] Resolución: ${resolution.resolved.length}/${csvParts.length} resueltos, ${resolution.unresolved.length} unresolved, ${resolution.ambiguousByQuote.length} dedup por QuoteIBMS, ${resolution.totalNodes} nodos activos en server`);

    if (!resolution.resolved.length) {
      dupSetBody(`<div class="dup-error">
        Ningún PN del CSV pudo resolverse contra el server.<br>
        ${resolution.unresolved.length} unresolved. Primeros: ${
          resolution.unresolved.slice(0, 5).map(u => dupEscHtml(`${u.csvPart.customer}|${u.csvPart.pn} (${u.reason})`)).join(' · ')
        }
      </div>`);
      dupSetFooter(`<button class="dup-btn" data-act="dup-close-err">Cerrar</button>`);
      dupState.panelEl.querySelector('[data-act=dup-close-err]')?.addEventListener('click', () => dupClosePanel());
      return;
    }

    // Fase 3: GetPartNumber por PN resuelto y clasificación.
    setProg(`Revisando ${resolution.resolved.length} PNs (concurrencia 6)…`, 0, resolution.resolved.length);
    const items = [];
    const fetchErrors = [];

    await dupRunPool(resolution.resolved, async (r) => {
      if (dupState.runId !== myRunId) return;
      let detail = null;
      try {
        const data = await dupWithRetry(
          () => api().query('GetPartNumber', { partNumberId: r.pnNode.id }),
          `GetPartNumber ${r.pnNode.id}`
        );
        detail = data?.partNumberById;
      } catch (e) {
        fetchErrors.push({ pnId: r.pnNode.id, pnName: r.pnNode.name, error: e?.message || String(e) });
        return;
      }
      if (!detail) return;

      const item = dupCsvClassifyPN(r.csvPart, r.pnNode, detail);
      if (item) items.push(item);
    }, 6, (done, total) => {
      setProg(`${done}/${total} PNs revisados — ${items.length} con issues`, done, total);
    });

    if (dupState.runId !== myRunId) return;
    log(`[SPM-dup-csv] Scan OK: ${items.length} PNs con issues / ${resolution.resolved.length} resueltos`);

    dupState.csvItems = items;
    dupState.csvUnresolved = resolution.unresolved;
    dupState.csvFetchErrors = fetchErrors;
    dupState.csvFileName = fileName;
    dupState.csvSelections = new Map();
    for (const it of items) dupState.csvSelections.set(it.pnId, true);

    dupRenderCsvResults(myRunId);
  }

  // Para un PN: agrupa rows vivos por specFieldId, matchea contra CSV y devuelve
  // shape { pnId, pnName, customer, quoteIBMS, issues[] } o null si no hay issues.
  function dupCsvClassifyPN(csvPart, pnNode, detail) {
    const allParams = detail.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
    const liveBySpecField = new Map();
    for (const p of allParams) {
      if (p.archivedAt || !p.specFieldParamBySpecFieldParamId) continue;
      const sfp = p.specFieldParamBySpecFieldParamId;
      const sfs = sfp.specFieldSpecBySpecFieldSpecId;
      const sfId = sfs?.specFieldBySpecFieldId?.id;
      if (!sfId) continue;
      const sfName = sfs.specFieldBySpecFieldId?.name || '';
      const specName = sfs.specBySpecId?.name || '';
      const specId = sfs.specBySpecId?.id || null;
      if (!liveBySpecField.has(sfId)) liveBySpecField.set(sfId, { sfId, sfName, specName, specId, rows: [] });
      liveBySpecField.get(sfId).rows.push({
        rowId: p.id,
        sfpId: sfp.id,
        sfpName: sfp.name || '(sin nombre)',
        processNodeId: p.processNodeId || null,
      });
    }

    // Index CSV specs por nombre normalizado (case-insensitive, trim) para matchear
    // contra fieldName/specName del live.
    const csvSpecMap = new Map();
    for (const cs of csvPart.specs) {
      if (!cs.name || cs.name === '-') continue;
      const k = cs.name.trim().toLowerCase();
      csvSpecMap.set(k, cs);
    }

    const issues = [];
    for (const [sfId, g] of liveBySpecField) {
      const specKey = (g.specName || '').trim().toLowerCase();
      const cs = csvSpecMap.get(specKey);
      if (!cs) continue; // El CSV no menciona esta Spec → no podemos opinar.
      const csvParam = (cs.param || '').trim();
      const hasDup = g.rows.length > 1;
      const hasProc = g.rows.some(r => r.processNodeId);

      // Matchear el wanted del CSV contra los rows vivos (por sfpName, case-insensitive).
      let wanted = null;
      if (csvParam) {
        const csvLow = csvParam.toLowerCase();
        wanted = g.rows.find(r => (r.sfpName || '').trim().toLowerCase() === csvLow) || null;
      } else {
        // CSV sin param explícito (params.length===1 en el catálogo). Si hay 1 row vivo,
        // ese es el wanted automáticamente; si hay 2+ es ambigüedad.
        if (g.rows.length === 1) wanted = g.rows[0];
      }

      let status, toArchive = [], wantedNullSfp = null;
      if (!wanted) {
        // No matchea ningún sfpName del live: el sfp del CSV no está en BD.
        // No podemos insertar sin conocer el sfpId del catálogo → solo flagear.
        status = 'wrongSfp';
      } else {
        // El wanted está vivo. Archive perdedores (sfp distinto) + wanted-con-processNode.
        for (const r of g.rows) {
          if (r.rowId === wanted.rowId) continue;
          toArchive.push(r);
        }
        // El wanted: si tiene processNode → archive + insert NULL.
        if (wanted.processNodeId) {
          toArchive.push(wanted);
          wantedNullSfp = { sfpId: wanted.sfpId, sfpName: wanted.sfpName };
          status = 'processNodeRewrite';
        } else if (hasDup || hasProc) {
          status = 'duplicateRemove';
        } else {
          status = 'ok';
        }
      }

      if (status === 'ok') continue;
      issues.push({
        specFieldId: sfId,
        specFieldName: g.sfName,
        specName: g.specName,
        csvParam: csvParam || '(default)',
        liveRows: g.rows,
        wanted,
        toArchive,
        wantedNullSfp, // {sfpId, sfpName} si necesitamos reinsertar NULL
        status,
      });
    }

    if (!issues.length) return null;
    return {
      pnId: pnNode.id,
      pnName: pnNode.name,
      customer: pnNode.customerByCustomerId?.name || csvPart.customer,
      quoteIBMS: csvPart.quoteIBMS,
      detail, // referencia para SavePartNumber
      issues,
    };
  }

  function dupRenderCsvResults(myRunId) {
    const items = dupState.csvItems || [];
    const body = dupState.panelEl.querySelector('.dup-body');
    body.innerHTML = '';

    const stats = document.createElement('div');
    stats.className = 'dup-stats';
    const totalIssues = items.reduce((s, it) => s + it.issues.length, 0);
    const wrongSfp = items.reduce((s, it) => s + it.issues.filter(i => i.status === 'wrongSfp').length, 0);
    const totalArchive = items.reduce((s, it) => s + it.issues.reduce((ss, i) => ss + i.toArchive.length, 0), 0);
    const totalInsert = items.reduce((s, it) => s + it.issues.filter(i => i.wantedNullSfp).length, 0);
    const mk = (lbl, val, color) => {
      const span = document.createElement('span');
      const b = document.createElement('b');
      if (color) b.style.color = color;
      b.textContent = String(val);
      span.appendChild(document.createTextNode(`${lbl}: `));
      span.appendChild(b);
      return span;
    };
    stats.appendChild(mk('PNs con issues', items.length));
    stats.appendChild(mk('Issues totales', totalIssues));
    stats.appendChild(mk('Rows a archivar', totalArchive, '#fca5a5'));
    stats.appendChild(mk('NULL a insertar', totalInsert, '#6ee7b7'));
    if (wrongSfp) stats.appendChild(mk('wrongSfp (no aplicables)', wrongSfp, '#fbbf24'));
    if (dupState.csvUnresolved?.length) stats.appendChild(mk('PNs unresolved', dupState.csvUnresolved.length, '#9ca3af'));
    if (dupState.csvFetchErrors?.length) stats.appendChild(mk('Errores fetch', dupState.csvFetchErrors.length, '#fca5a5'));
    body.appendChild(stats);

    const info = document.createElement('div');
    info.style.cssText = 'background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:#cbd5e1';
    info.innerHTML = `Modo CSV: <b>${dupEscHtml(dupState.csvFileName || 'archivo')}</b>. El validator compara cada PN contra su fila del CSV y aplica corrección vía <code>SavePartNumber</code>. <span style="color:#fbbf24">wrongSfp</span> = el CSV pide un param que no está vivo en el PN (no se inserta sin re-correr bulk-upload). Deselecciona PNs específicos antes de Aplicar.`;
    body.appendChild(info);

    if (!items.length) {
      const ok = document.createElement('div');
      ok.className = 'dup-success';
      ok.textContent = '✓ Ningún PN del CSV requiere corrección (todos cumplen la regla 1.4.38).';
      body.appendChild(ok);
      dupSetFooter(`
        <span class="dup-counter">Listo</span>
        <div style="display:flex;gap:6px">
          <button class="dup-btn dup-btn-ghost" data-act="dup-back">← Filtros</button>
          <button class="dup-btn" data-act="dup-close-ok">Cerrar</button>
        </div>
      `);
      dupState.panelEl.querySelector('[data-act=dup-back]')?.addEventListener('click', () => {
        dupState.runId++;
        runDuplicateParamsValidator();
      });
      dupState.panelEl.querySelector('[data-act=dup-close-ok]')?.addEventListener('click', () => dupClosePanel());
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-height:48vh;overflow-y:auto;border:1px solid #374151;border-radius:6px';
    const table = document.createElement('table');
    table.className = 'dup-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Aplicar', 'PN', 'Cliente', 'Issues', 'Preview'].forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.dataset.pnid = String(it.pnId);

      const tdAp = document.createElement('td');
      tdAp.style.textAlign = 'center';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = dupState.csvSelections.get(it.pnId) !== false;
      cb.disabled = it.issues.every(i => i.status === 'wrongSfp'); // wrongSfp puro → no aplicable
      if (cb.disabled) cb.checked = false;
      cb.addEventListener('change', () => {
        dupState.csvSelections.set(it.pnId, cb.checked);
        dupUpdateCsvFooter();
      });
      tdAp.appendChild(cb);
      tr.appendChild(tdAp);

      const tdPn = document.createElement('td');
      const pname = document.createElement('div');
      pname.className = 'pname';
      pname.textContent = it.pnName;
      const pmeta = document.createElement('div');
      pmeta.className = 'pmeta';
      pmeta.textContent = `#${it.pnId}${it.quoteIBMS ? ` · Q=${it.quoteIBMS}` : ''}`;
      tdPn.appendChild(pname);
      tdPn.appendChild(pmeta);
      tr.appendChild(tdPn);

      const tdC = document.createElement('td');
      tdC.textContent = it.customer;
      tr.appendChild(tdC);

      const tdIs = document.createElement('td');
      const statusCounts = {};
      for (const i of it.issues) statusCounts[i.status] = (statusCounts[i.status] || 0) + 1;
      const statusLine = Object.entries(statusCounts).map(([k, v]) => {
        const color = k === 'wrongSfp' ? '#fbbf24' : (k === 'processNodeRewrite' ? '#a78bfa' : '#fca5a5');
        return `<span style="color:${color}">${k}: ${v}</span>`;
      }).join(' · ');
      tdIs.innerHTML = statusLine;
      tr.appendChild(tdIs);

      const tdPv = document.createElement('td');
      const preview = document.createElement('div');
      preview.style.cssText = 'font-size:10px;color:#cbd5e1;max-width:380px;line-height:1.4';
      preview.innerHTML = it.issues.map(i => {
        const label = i.status === 'wrongSfp'
          ? `<span style="color:#fbbf24">⚠ wrongSfp</span>`
          : `archive ${i.toArchive.length}${i.wantedNullSfp ? ' + insert NULL' : ''}`;
        return `<div><b>${dupEscHtml(i.specName)} · ${dupEscHtml(i.specFieldName)}</b> → CSV pide "<i>${dupEscHtml(i.csvParam)}</i>" → ${label}</div>`;
      }).join('');
      tdPv.appendChild(preview);
      tr.appendChild(tdPv);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    dupSetFooter(`
      <span class="dup-counter" data-ctrl="dup-csv-foot"></span>
      <div style="display:flex;gap:6px">
        <button class="dup-btn dup-btn-ghost" data-act="dup-back">← Filtros</button>
        <button class="dup-btn dup-btn-danger" data-act="dup-csv-apply">Aplicar a seleccionados</button>
      </div>
    `);
    dupState.panelEl.querySelector('[data-act=dup-back]')?.addEventListener('click', () => {
      dupState.runId++;
      runDuplicateParamsValidator();
    });
    dupState.panelEl.querySelector('[data-act=dup-csv-apply]')?.addEventListener('click', async () => {
      if (!confirm('Esto aplicará SavePartNumber a los PNs seleccionados (archive + insert NULL). ¿Continuar?')) return;
      await dupRunApplyCsv(myRunId);
    });
    dupUpdateCsvFooter();
  }

  function dupUpdateCsvFooter() {
    const ftr = dupState.panelEl?.querySelector('[data-ctrl=dup-csv-foot]');
    if (!ftr) return;
    let sel = 0, totalArch = 0, totalIns = 0;
    for (const it of (dupState.csvItems || [])) {
      if (dupState.csvSelections.get(it.pnId) === false) continue;
      if (it.issues.every(i => i.status === 'wrongSfp')) continue;
      sel++;
      for (const i of it.issues) {
        if (i.status === 'wrongSfp') continue;
        totalArch += i.toArchive.length;
        if (i.wantedNullSfp) totalIns++;
      }
    }
    ftr.textContent = `${sel} PNs seleccionados · ${totalArch} archives · ${totalIns} inserts NULL`;
  }

  // Apply CSV-mode: 1 SavePartNumber por PN seleccionado, con paramsToApply
  // (insert NULL del wantedNullSfp) + partNumberSpecFieldParamsToArchive
  // agregados de TODOS sus issues. Mismo shape que bulk-upload STEP 6b.
  async function dupRunApplyCsv(parentRunId) {
    const myRunId = ++dupState.runId;
    void parentRunId;

    const tasks = [];
    for (const it of (dupState.csvItems || [])) {
      if (dupState.csvSelections.get(it.pnId) === false) continue;
      if (it.issues.every(i => i.status === 'wrongSfp')) continue;
      const archiveIds = [];
      const paramsToApply = [];
      for (const i of it.issues) {
        if (i.status === 'wrongSfp') continue;
        for (const r of i.toArchive) archiveIds.push(Number(r.rowId));
        if (i.wantedNullSfp) {
          paramsToApply.push({
            specFieldId: Number(i.specFieldId),
            specFieldParamId: Number(i.wantedNullSfp.sfpId),
            isGeneric: false,
            geometryTypeSpecFieldId: null,
            processNodeId: null,
            processNodeOccurrence: null,
            locationId: null,
          });
        }
      }
      if (!archiveIds.length && !paramsToApply.length) continue;
      tasks.push({ item: it, archiveIds, paramsToApply });
    }

    if (!tasks.length) {
      alert('No hay nada que aplicar (todos los PNs seleccionados son wrongSfp o ya están OK).');
      return;
    }

    dupSetBody(`<div class="dup-progress">
      Aplicando SavePartNumber a ${tasks.length} PNs (concurrencia 3)…
      <div data-ctrl="prog-msg">0/${tasks.length}</div>
      <div class="dup-bar"><div data-ctrl="prog-bar" style="width:0%"></div></div>
    </div>`);
    dupSetFooter(`<button class="dup-btn dup-btn-danger" data-act="dup-stop">Cancelar</button>`);
    dupState.panelEl.querySelector('[data-act=dup-stop]')?.addEventListener('click', () => {
      dupState.runId++;
      dupClosePanel();
    });
    const pm = dupState.panelEl.querySelector('[data-ctrl=prog-msg]');
    const pb = dupState.panelEl.querySelector('[data-ctrl=prog-bar]');

    const okRows = [];
    const errRows = [];
    let processed = 0;

    await dupRunPool(tasks, async (t) => {
      if (dupState.runId !== myRunId) return;
      const d = t.item.detail;
      const input = {
        id: t.item.pnId,
        name: d.name,
        customerId: d.customerId || d.customerByCustomerId?.id,
        defaultProcessNodeId: d.defaultProcessNodeId || null,
        inputSchemaId: d.inputSchemaId || null,
        customInputs: d.customInputs || {},
        geometryTypeId: d.geometryTypeId || null,
        userFileName: null,
        inventoryItemInput: null,
        glAccountId: null, taxCodeId: null, certPdfTemplateId: null,
        isOneOff: false, isTemplatePartNumber: false, isCoupon: false,
        partNumberGroupId: d.partNumberGroupId || null,
        descriptionMarkdown: d.descriptionMarkdown || '',
        customerFacingNotes: d.customerFacingNotes || '',
        labelIds: [], ownerIds: [], defaults: [], optInOuts: [],
        inventoryPredictedUsages: [],
        specsToApply: [],
        paramsToApply: t.paramsToApply,
        partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [],
        partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
        partNumberSpecFieldParamsToArchive: t.archiveIds,
        partNumberSpecFieldParamsToUnarchive: [],
        partNumberSpecClassificationsToUpdate: [],
        partNumberSpecFieldParamUpdates: [],
        specFieldParamUpdates: [],
      };
      try {
        await dupWithRetry(
          () => api().query('SavePartNumber', { input: [input] }, 'SavePartNumber'),
          `SavePartNumber csv-fix ${t.item.pnId}`
        );
        okRows.push({ pnId: t.item.pnId, pnName: t.item.pnName, archived: t.archiveIds.length, inserted: t.paramsToApply.length });
      } catch (e) {
        errRows.push({ pnId: t.item.pnId, pnName: t.item.pnName, error: e?.message || String(e) });
      }
      processed++;
      if (pm) pm.textContent = `${processed}/${tasks.length} (${okRows.length} OK, ${errRows.length} err)`;
      if (pb) pb.style.width = `${(processed / tasks.length) * 100}%`;
    }, 3);

    log(`[SPM-dup-csv] Apply: ${okRows.length} OK, ${errRows.length} errores`);

    const body = dupState.panelEl.querySelector('.dup-body');
    body.innerHTML = '';
    const sum = document.createElement('div');
    sum.className = okRows.length && !errRows.length ? 'dup-success' : 'dup-error';
    const totalArch = okRows.reduce((s, r) => s + r.archived, 0);
    const totalIns = okRows.reduce((s, r) => s + r.inserted, 0);
    sum.textContent = `Resultado: ${okRows.length} PNs OK (${totalArch} archived + ${totalIns} inserted NULL), ${errRows.length} errores.`;
    body.appendChild(sum);

    if (errRows.length) {
      const ul = document.createElement('ul');
      ul.style.cssText = 'font-size:11px;color:#fca5a5;max-height:200px;overflow-y:auto;margin-top:8px';
      for (const r of errRows.slice(0, 50)) {
        const li = document.createElement('li');
        li.textContent = `PN ${r.pnName} (#${r.pnId}) — ${r.error}`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    dupSetFooter(`
      <span class="dup-counter">${okRows.length} OK · ${errRows.length} errores</span>
      <div style="display:flex;gap:6px">
        <button class="dup-btn" data-act="dup-csv-final-close">Cerrar</button>
      </div>
    `);
    dupState.panelEl.querySelector('[data-act=dup-csv-final-close]')?.addEventListener('click', () => dupClosePanel());
  }


  return { run, assignPendingParams, resolveConflicts, runDuplicateParamsValidator };
})();

if (typeof window !== 'undefined') window.SpecMigrator = SpecMigrator;
