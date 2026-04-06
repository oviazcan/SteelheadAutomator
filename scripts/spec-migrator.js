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

  // ── Get PN detail with specs and params ──
  async function getPNDetail(partNumberId) {
    const data = await api().query('GetPartNumber', {
      partNumberId, usagesLimit: 0, usagesOffset: 0
    });
    return data?.partNumberById || null;
  }

  // ── Archive spec at PN level (proper mutation) ──
  async function archiveSpecOnPN(partNumberSpecId, partNumberSpecFieldParamIds) {
    await api().query('ArchivePartNumberSpecAndParams', {
      partNumberSpecId,
      partNumberSpecFieldParamIds: partNumberSpecFieldParamIds || [],
      archivedAt: new Date().toISOString()
    }, 'ArchivePartNumberSpecAndParams');
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

  // ── Search filter options (customer, label) ──
  async function searchFilter(key, searchQuery) {
    const data = await api().query('FilterSearch', { key, searchQuery }, 'FilterSearch');
    return data?.tableFilterSearch || [];
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
            await api().query('ArchivePartNumberSpecAndParams', {
              partNumberSpecId: existingTargetSpec.id, partNumberSpecFieldParamIds: [], archivedAt: null
            }, 'ArchivePartNumberSpecAndParams');
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

    const { targetSpecId, targetSpecName, defaultSelections, genericSelections, allParams } = config;

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
        // Get PN detail with specs and params
        const pnDetail = await getPNDetail(pnId);
        const pnSpecsList = pnDetail?.partNumberSpecsByPartNumberId?.nodes || [];
        const pnAllParams = pnDetail?.partNumberSpecFieldParamsByPartNumberId?.nodes || [];

        // Helper: get param IDs for a given partNumberSpecId
        const getParamIdsForSpec = (pnSpecId) => {
          // partNumberSpecFieldParams have specFieldId which links to specFieldSpec
          // Filter params that belong to this spec by checking their specFieldParamBySpecFieldParamId.specFieldSpecId
          // matches a specFieldSpec belonging to the target spec
          return pnAllParams
            .filter(p => !p.archivedAt)
            .map(p => p.id);
        };

        const sourceSpecOnPN = pnSpecsList.find(s =>
          s.specBySpecId?.id === sourceSpec.id
        );

        if (sourceSpecOnPN && !sourceSpecOnPN.archivedAt) {
          // Archive the old spec at PN level using proper mutation
          try {
            const paramIds = getParamIdsForSpec(sourceSpecOnPN.id);
            await archiveSpecOnPN(sourceSpecOnPN.id, paramIds);
            log(`  ${pnName}: spec vieja archivada a nivel PN`);
          } catch (e) {
            warn(`  ${pnName}: error archivando spec vieja: ${String(e).substring(0, 200)}`);
            results.errors.push(`${pnName}: error archivando spec vieja`);
            continue;
          }
        } else if (sourceSpecOnPN && sourceSpecOnPN.archivedAt) {
          results.alreadyArchived++;
        }

        // Check if target spec already assigned (active or archived)
        const existingTargetSpec = pnSpecsList.find(s =>
          s.specBySpecId?.id === targetSpecId
        );
        if (existingTargetSpec) {
          // If archived, unarchive the spec first
          if (existingTargetSpec.archivedAt) {
            try {
              await api().query('ArchivePartNumberSpecAndParams', {
                partNumberSpecId: existingTargetSpec.id,
                partNumberSpecFieldParamIds: [],
                archivedAt: null
              }, 'ArchivePartNumberSpecAndParams');
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

          // Step 2: Add missing params via AddParamsToPartNumber
          const missingParams = allParams.filter(ap => !existingParamIds.has(ap.paramId));
          if (missingParams.length > 0) {
            const paramsToAdd = missingParams.map(p => ({
              specFieldId: p.specFieldId,
              specFieldParamId: p.paramId,
              isGeneric: p.isGeneric,
              geometryTypeSpecFieldId: null,
              processNodeId: null,
              processNodeOccurrence: null,
              locationId: null
            }));
            await addParamsToPN(pnId, paramsToAdd);
          }

          results.migrated++;
          log(`  ${pnName}: params corregidos ✓`);
          continue;
        }

        // Target spec doesn't exist on PN — apply fresh
        await applySpecToPN(pnId, targetSpecId, defaultSelections, genericSelections);
        results.migrated++;
        log(`  ${pnName}: spec aplicada ✓`);

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
