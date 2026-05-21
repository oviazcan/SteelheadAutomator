# Asignar Params Pendientes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the "Asignar Params Pendientes" sub-action to `spec-migrator.js` — detects spec fields with unassigned PNs and assigns the correct param, either automatically (1-param fields) or with user assistance (multi-param fields).

**Architecture:** Reuses existing IIFE `SpecMigrator` in `spec-migrator.js`. New function `assignPendingParams()` orchestrates: fetch specs → for each spec, fetch fields via `SpecFieldsAndOptions` → for each field, call `GetSpecFieldSpec` with `partNumberUnassignedActive:true` to find PNs missing the param → auto-assign single-param fields, show modal for multi-param fields → call `AddParamsToPartNumber` **one by one** (tolerating exclusion constraint). A new message handler `assign-pending-params` in `background.js` routes to `SpecMigrator.assignPendingParams()`.

**Tech Stack:** Vanilla JS, Chrome Extension MV3, Steelhead GraphQL (persisted queries)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `remote/scripts/spec-migrator.js` | Modify | Add `getSpecFieldSpec()`, `addSingleParamToPN()`, `assignPendingParams()`, scope-selection UI, multi-param modal |
| `extension/background.js` | Modify | Add `assign-pending-params` case to message switch |
| `remote/config.json` | Already done | `GetSpecFieldSpec` hash already present in `hashes.queries` |

---

### Task 1: Add `getSpecFieldSpec` helper and `addSingleParamToPN` to SpecMigrator

**Files:**
- Modify: `remote/scripts/spec-migrator.js:39-42` (after `getSpecFields`)

- [ ] **Step 1: Add `getSpecFieldSpec` query helper**

Insert after the `getSpecFields` function (after line 42):

```javascript
  // ── Get spec field spec with unassigned PNs ──
  async function getSpecFieldSpec(specFieldSpecId, offset = 0) {
    const data = await api().query('GetSpecFieldSpec', {
      specFieldSpecId,
      partNumberUnassignedActive: true,
      partNumberFirst: 500,
      partNumberOffset: offset,
      partNumberOrderBy: ['NAME_ASC'],
      searchQuery: '',
      includeArchived: 'NO'
    }, 'GetSpecFieldSpec');
    return data || null;
  }
```

- [ ] **Step 2: Add `addSingleParamToPN` — calls AddParamsToPartNumber for ONE param, tolerates exclusion constraint**

Insert after the `addParamsToPN` function (after line 125):

```javascript
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
      return true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes('conflicting key') || msg.includes('exclusion constraint') || msg.includes('23P01')) {
        return false; // already present, skip silently
      }
      throw e;
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(spec-migrator): add getSpecFieldSpec + addSingleParamToPN helpers"
```

---

### Task 2: Add scope-selection UI (single spec or all externals)

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (before the `run()` function, after `showSummary`)

- [ ] **Step 1: Add `showPendingParamsScopeForm` — modal to choose scope**

Insert after the `showSummary` function (after the closing `}` of `showSummary`, around line 452):

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(spec-migrator): add scope selection UI for pending params"
```

---

### Task 3: Add multi-param modal for assisted assignment

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (after `showPendingParamsScopeForm`)

- [ ] **Step 1: Add `showMultiParamModal` — modal with radio for param + checkboxes for PNs**

Insert right after `showPendingParamsScopeForm`:

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(spec-migrator): add multi-param modal for assisted assignment"
```

---

### Task 4: Add `fetchAllExternalSpecs` helper

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (after `searchFilter`, before `fetchFilteredPNs`)

- [ ] **Step 1: Add `fetchAllExternalSpecs` — paginate AllSpecs filtered to EXTERNAL**

Insert after the `searchFilter` function (after line 97):

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(spec-migrator): add fetchAllExternalSpecs helper"
```

---

### Task 5: Add `assignPendingParams` orchestrator

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (before `run()`, and update the `return` statement)

This is the core function. It orchestrates the full flow:
1. Show scope form
2. Fetch specs (single or all external)
3. For each spec, fetch fields via SpecFieldsAndOptions
4. For each field, call GetSpecFieldSpec to find PNs with unassigned param
5. Auto-assign single-param fields; show modal for multi-param fields
6. Call AddParamsToPartNumber one-by-one per PN
7. Show summary

- [ ] **Step 1: Add `assignPendingParams` function**

Insert before the `run()` function (around line 583):

```javascript
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
      // Single spec — we already have specId, fetch its basic info
      specs = [{ id: scope.specId, name: scope.specName }];
      log(`Spec seleccionada: ${scope.specName}`);
    }

    if (!specs.length) {
      removeUI();
      return { error: 'No se encontraron specs' };
    }

    // Phase 3: For each spec, fetch fields via SpecFieldsAndOptions
    const results = { assigned: 0, skippedFields: 0, skippedPNs: 0, errors: [], autoAssigned: 0, assisted: 0 };
    const BATCH = 20;

    // Fetch all spec fields in batches
    const specFields = []; // { specId, specName, fieldId (specFieldSpecId), fieldName, isGeneric, params[], specFieldId }
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
    const fieldsWithPending = []; // { ...field, pns: [{id, name}] }

    for (let i = 0; i < specFields.length; i += BATCH) {
      const batch = specFields.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (field) => {
        try {
          const data = await getSpecFieldSpec(field.specFieldSpecId);
          const totalCount = data?.searchPartNumbers?.totalCount || 0;
          if (totalCount === 0) return null;

          // Collect all unassigned PNs (paginate if > 500)
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
    removeUI(); // Remove progress before showing modals

    for (let fi = 0; fi < fieldsWithPending.length; fi++) {
      const field = fieldsWithPending[fi];

      if (field.params.length === 0) {
        log(`  ${field.specName}/${field.fieldName}: sin params disponibles, skip`);
        results.skippedFields++;
        continue;
      }

      if (field.params.length === 1) {
        // Auto-assign: single param → apply to all PNs
        showProgressUI('Auto-asignando', `${field.specName} / ${field.fieldName} (${field.pns.length} PNs)`);
        const param = field.params[0];
        log(`  AUTO: ${field.specName}/${field.fieldName} → ${param.name} (${field.pns.length} PNs)`);

        for (let pi = 0; pi < field.pns.length; pi++) {
          const pn = field.pns[pi];
          const pct = (pi / field.pns.length) * 100;
          updateProgress(`${field.fieldName}: ${pi + 1}/${field.pns.length} — ${pn.name || pn.id}`, pct);
          try {
            const ok = await addSingleParamToPN(pn.id, field.specFieldId, param.id, field.isGeneric);
            if (ok) results.assigned++;
            else results.skippedPNs++;
          } catch (e) {
            results.errors.push(`${pn.name || pn.id}: ${String(e).substring(0, 150)}`);
          }
        }
        results.autoAssigned++;
        removeUI();
      } else {
        // Multi-param: show modal for user assistance
        // Loop until all PNs in this field are handled (user may split across params)
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

          for (let pi = 0; pi < choice.pnIds.length; pi++) {
            const pnId = choice.pnIds[pi];
            const pnName = remainingPNs.find(p => p.id === pnId)?.name || pnId;
            updateProgress(`${pi + 1}/${choice.pnIds.length} — ${pnName}`, (pi / choice.pnIds.length) * 100);
            try {
              const ok = await addSingleParamToPN(pnId, field.specFieldId, choice.paramId, field.isGeneric);
              if (ok) results.assigned++;
              else results.skippedPNs++;
            } catch (e) {
              results.errors.push(`${pnName}: ${String(e).substring(0, 150)}`);
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
    log(`Errores: ${results.errors.length}`);

    showPendingParamsSummary(results);
    return results;
  }
```

- [ ] **Step 2: Add `showPendingParamsSummary` — summary modal for pending params results**

Insert right after `assignPendingParams`:

```javascript
  // ── Summary for pending params ──
  function showPendingParamsSummary(results) {
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
      <h2 style="color:${iconColor}">${icon} Asignación Completada</h2>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#4ade80">${results.assigned}</div>
          <div style="font-size:11px;color:#94a3b8">Asignados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#8b5cf6">${results.autoAssigned}</div>
          <div style="font-size:11px;color:#94a3b8">Auto</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#f59e0b">${results.skippedFields}</div>
          <div style="font-size:11px;color:#94a3b8">Saltados</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#ef4444">${results.errors.length}</div>
          <div style="font-size:11px;color:#94a3b8">Errores</div>
        </div>
      </div>
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
```

- [ ] **Step 3: Update the `return` statement to export `assignPendingParams`**

Change the return at the end of the IIFE from:

```javascript
  return { run };
```

to:

```javascript
  return { run, assignPendingParams };
```

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(spec-migrator): add assignPendingParams orchestrator + summary modal"
```

---

### Task 6: Add message handler in background.js

**Files:**
- Modify: `extension/background.js:697` (after the `run-spec-migrator` case)

- [ ] **Step 1: Add `assign-pending-params` case**

Insert right after the closing `}` of the `run-spec-migrator` case (line 697):

```javascript
    // ── Assign Pending Params ──
    case 'assign-pending-params': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'spec-migrator');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.SpecMigrator) return { error: 'SpecMigrator no disponible' };
          return window.SpecMigrator.assignPendingParams();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }
```

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat(background): add assign-pending-params message handler"
```

---

### Task 7: Smoke test and final commit

- [ ] **Step 1: Verify no syntax errors**

Run a quick syntax check on both modified files:

```bash
node -c remote/scripts/spec-migrator.js && echo "spec-migrator OK"
node -c extension/background.js && echo "background OK"
```

Expected: both print "OK" with no errors.

- [ ] **Step 2: Review the full flow end-to-end**

Verify the chain works:
1. `config.json` → action `assign-pending-params` sends message `assign-pending-params` ✓ (already present)
2. `background.js` → `assign-pending-params` case → injects scripts → calls `SpecMigrator.assignPendingParams()` ✓
3. `spec-migrator.js` → `assignPendingParams()` exported in IIFE return ✓
4. `GetSpecFieldSpec` hash already in `config.json` at `hashes.queries.GetSpecFieldSpec` ✓

- [ ] **Step 3: Final commit with version bump**

Bump `config.json` version to `0.2.8`:

```bash
git add remote/config.json remote/scripts/spec-migrator.js extension/background.js
git commit -m "feat: implement 'Asignar Params Pendientes' action in spec-migrator

Adds ability to detect and assign missing params across specs,
with auto-assign for single-param fields and assisted modal for multi-param."
```
