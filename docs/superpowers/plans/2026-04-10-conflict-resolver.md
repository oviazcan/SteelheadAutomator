# Conflict Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Resolver Conflictos de Specs" app that detects PNs with shared spec fields across multiple specs and lets the user archive the redundant ones.

**Architecture:** New `resolveConflicts()` function in `spec-migrator.js`, following the same pattern as `assignPendingParams()`. Reuses existing API functions (`fetchAllExternalSpecs`, `getSpec`, `getPNDetail`, `getSpecFields`, `archiveSpecOnPN`) and UI helpers (`ensureStyles`, `showProgressUI`, `updateProgress`, `removeUI`). New config action entry.

**Tech Stack:** Vanilla JS, Steelhead GraphQL API via persisted queries.

**Spec:** `docs/superpowers/specs/2026-04-10-conflict-resolver-design.md`

---

### Task 1: Add config action entry

**Files:**
- Modify: `remote/config.json:225-228`

- [ ] **Step 1: Add the new action to the spec-migrator group**

In `remote/config.json`, add a third action after `assign-pending-params` (line 227):

```json
{ "id": "resolve-conflicts", "label": "Resolver Conflictos", "sublabel": "Detectar PNs con specs duplicadas y archivar", "icon": "⚔️", "handler": "message", "message": "resolve-conflicts", "fn": "SpecMigrator.resolveConflicts" }
```

The actions array at line 225 should now have 3 entries.

- [ ] **Step 2: Commit**

```bash
git add remote/config.json
git commit -m "feat(conflict-resolver): add menu action to config"
```

---

### Task 2: Implement scan phase (detect conflicts)

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (insert before the `return { run, assignPendingParams };` line at 1627)

- [ ] **Step 1: Add the `scanForConflicts` helper function**

Insert before the `return` statement at line 1627:

```javascript
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
    removeUI();
    return conflicts;
  }
```

- [ ] **Step 2: Verify no syntax errors**

Read back the inserted code to confirm the function is correctly placed inside the IIFE, before the `return` statement.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(conflict-resolver): add scanForConflicts helper"
```

---

### Task 3: Implement conflict resolver modal UI

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (insert after `scanForConflicts`, before the `return` line)

- [ ] **Step 1: Add the `showConflictResolverModal` function**

Insert right after `scanForConflicts()`:

```javascript
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
            <input type="checkbox" class="sa-cr-spec" data-pn="${idx}" data-pnspecid="${s.pnSpecId}" data-specname="${s.specName}" checked>
            <span style="color:#e2e8f0">${s.specName}</span>
          </label>`
        ).join('');

        return `<div class="sa-cr-card" data-idx="${idx}" style="background:#0f172a;border-radius:8px;padding:14px 16px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:14px;font-weight:700;color:#e2e8f0">${c.pnName}</span>
              <a href="https://app.gosteelhead.com/part-number/${c.pnId}/specs" target="_blank" style="color:#60a5fa;font-size:12px;text-decoration:none" title="Abrir en Steelhead">🔗</a>
            </div>
            <label style="font-size:11px;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" class="sa-cr-ignore" data-pn="${idx}"> Ignorar
            </label>
          </div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px">Fields compartidos: ${c.sharedFields.join(', ')}</div>
          <div class="sa-cr-specs-container" data-pn="${idx}">${specsHTML}</div>
          <div class="sa-cr-archive-label" data-pn="${idx}" style="font-size:11px;color:#f59e0b;margin-top:6px"></div>
        </div>`;
      }).join('');

      md.innerHTML = `
        <h2 style="color:#f59e0b;font-size:18px">⚔️ Resolver Conflictos de Specs</h2>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:12px">
          ${conflicts.length} PNs con specs en conflicto. Desmarca las specs que quieres archivar.
        </div>
        <div style="margin-bottom:8px">
          <input type="text" id="sa-cr-search" class="sa-specm-input" placeholder="Buscar PN..." style="margin-bottom:10px">
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
              specName: cb.dataset.specname
            }))
          });
        });
        ov.parentNode.removeChild(ov);
        resolve({ actions });
      };
    });
  }
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(conflict-resolver): add conflict resolver modal UI"
```

---

### Task 4: Implement main `resolveConflicts` orchestrator and export

**Files:**
- Modify: `remote/scripts/spec-migrator.js` (insert after modal, before `return` line; update `return` line)

- [ ] **Step 1: Add the `resolveConflicts` orchestrator and summary function**

Insert right after `showConflictResolverModal()`:

```javascript
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
    const conflicts = await scanForConflicts();

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

      const batchResults = await Promise.allSettled(batch.map(async (action) => {
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
```

- [ ] **Step 2: Update the export to include `resolveConflicts`**

Change the return statement at the end of the IIFE (currently `return { run, assignPendingParams };`):

```javascript
  return { run, assignPendingParams, resolveConflicts };
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/spec-migrator.js
git commit -m "feat(conflict-resolver): add resolveConflicts orchestrator and summary"
```

---

### Task 5: Deploy to gh-pages

**Files:**
- Deploy: `remote/config.json` and `remote/scripts/spec-migrator.js` to `gh-pages` branch

- [ ] **Step 1: Stash unrelated files, switch to gh-pages, copy files**

```bash
git stash push -m "wip-untracked" -- CLAUDE.md
git checkout gh-pages
git checkout main -- remote/config.json remote/scripts/spec-migrator.js
cp remote/config.json config.json
cp remote/scripts/spec-migrator.js scripts/spec-migrator.js
rm -rf remote
```

- [ ] **Step 2: Commit and push gh-pages**

```bash
git add config.json scripts/spec-migrator.js
git commit -m "feat(conflict-resolver): deploy conflict resolver app"
git push origin gh-pages
```

- [ ] **Step 3: Return to main and restore stash**

```bash
git checkout main
git stash pop
```

- [ ] **Step 4: Push main**

```bash
git push origin main
```
