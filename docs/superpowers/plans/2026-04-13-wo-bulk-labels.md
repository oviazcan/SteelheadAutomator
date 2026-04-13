# WO Bulk Label Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the WO deadline changer applet to also add/remove labels on work orders in bulk.

**Architecture:** Same applet, same filters. New UI sections for label selection (add/remove chips). Execution logic branches: date-only, labels-only, or both. Two new mutations (CreateWorkOrderLabel, DeleteWorkOrderLabels) added to config.

**Tech Stack:** Vanilla JS (IIFE pattern), Steelhead GraphQL API via persisted query hashes, Chrome extension remote script.

---

### Task 1: Add new hashes to config.json

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Add mutation hashes**

In `remote/config.json`, add these two entries inside `steelhead.hashes.mutations` (after the existing `UpdateReceivedOrder` line):

```json
"DeleteWorkOrderLabels": "0bd35abe9ed820c45702d49199b4e799ba6dd3b9484bfeaecba23d3c2962af59",
"CreateWorkOrderLabel": "e3d57bbe80a5cedd12c29766ae1f7546cd7a2b69a16aaf09af1ba2f1eaa13f60"
```

- [ ] **Step 2: Update the apiKnowledge section**

Add entries after the existing `AllLabels` apiKnowledge entry:

```json
"DeleteWorkOrderLabels": { "type": "mutation", "description": "Eliminar todas las etiquetas de una OT", "usedBy": "wo-deadline" },
"CreateWorkOrderLabel": { "type": "mutation", "description": "Asignar una etiqueta a una OT", "usedBy": "wo-deadline" }
```

- [ ] **Step 3: Update applet metadata**

Change the applet entry at the `wo-deadline` section:

```json
{
  "id": "wo-deadline",
  "name": "Gestión Masiva de OT",
  "subtitle": "Cambiar plazos y etiquetas masivamente",
  "icon": "⚙️",
  "scripts": ["scripts/steelhead-api.js", "scripts/wo-deadline-changer.js"],
  "actions": [
    { "id": "run-wo-deadline", "label": "Gestionar OTs", "sublabel": "Cambiar plazos y etiquetas masivamente", "icon": "⚙️", "type": "primary", "handler": "message", "message": "run-wo-deadline", "fn": "WODeadlineChanger.run" }
  ]
}
```

- [ ] **Step 4: Commit**

```bash
git add remote/config.json
git commit -m "feat(wo-deadline): add label mutation hashes and update applet metadata"
```

---

### Task 2: Fetch WO labels catalog and extract current WO labels

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (DATA section)

- [ ] **Step 1: Add fetchWOLabels function**

Add after the `enrichWithPNData` function (around line 87):

```javascript
async function fetchWOLabels() {
  const data = await api().query('AllLabels', { condition: { forWorkOrder: true } }, 'AllLabels');
  return (data?.allLabels?.nodes || []).map(l => ({
    id: l.id,
    name: l.name,
    color: l.color || '#475569'
  }));
}
```

- [ ] **Step 2: Add helper to extract current labels from WO data**

Add after `fetchWOLabels`:

```javascript
function extractWOLabels(wo, labelCatalog) {
  const nodes = wo.workOrderLabelsByWorkOrderId?.nodes || [];
  // Nodes may have labelByLabelId sub-relation or just labelId
  return nodes.map(n => {
    if (n.labelByLabelId) {
      return { id: n.labelByLabelId.id, name: n.labelByLabelId.name, color: n.labelByLabelId.color || '#475569' };
    }
    // Fallback: lookup by labelId in catalog
    const labelId = n.labelId || n.id;
    const found = labelCatalog.find(l => l.id === labelId);
    return found || { id: labelId, name: `Label ${labelId}`, color: '#475569' };
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): add WO label catalog fetch and extraction helpers"
```

---

### Task 3: Add label chip UI sections to the modal

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (UI section — `showMainUI` function)

- [ ] **Step 1: Add CSS for label chips**

In the `ensureStyles` function, add these rules inside the template string (after the `.sa-wod-progress-box` rule):

```css
.sa-wod-labels-section{margin-bottom:8px}
.sa-wod-labels-section .section-title{font-size:11px;color:#94a3b8;margin-bottom:4px}
.sa-wod-label-chip{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;margin:2px 3px;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s,opacity 0.15s;opacity:0.6}
.sa-wod-label-chip:hover{opacity:0.85}
.sa-wod-label-chip.chip-selected{opacity:1;border-color:#fff}
.sa-wod-label-chip.chip-remove.chip-selected{opacity:1;border-color:#ef4444}
```

- [ ] **Step 2: Update showMainUI signature to accept label catalog**

Change the function signature from:

```javascript
async function showMainUI(wos, pnCache, uiDefaults, dropdownCache) {
```

to:

```javascript
async function showMainUI(wos, pnCache, uiDefaults, dropdownCache, woLabelCatalog) {
```

- [ ] **Step 3: Build label chip HTML inside showMainUI**

Inside `showMainUI`, right after the line that destructures `dropdownCache` (line ~271), add:

```javascript
const addChipsHTML = woLabelCatalog.map(l => {
  const fg = labelTextColor(l.color);
  return `<span class="sa-wod-label-chip" data-label-id="${l.id}" data-action="add" style="background:${l.color};color:${fg}">${l.name}</span>`;
}).join('');
```

- [ ] **Step 4: Insert label sections into modal HTML**

In the `md.innerHTML` template, replace the existing block that contains `"Seleccionar todo"` and `"Nueva fecha"` (the `div` with `display:flex;justify-content:space-between` around line 331) with:

```html
<div class="sa-wod-labels-section">
  <div class="section-title">Agregar etiquetas:</div>
  <div id="sa-wod-add-labels">${addChipsHTML}</div>
</div>
<div class="sa-wod-labels-section">
  <div class="section-title">Quitar etiquetas:</div>
  <div id="sa-wod-remove-labels"><span style="font-size:11px;color:#64748b;font-style:italic">Ninguna OT tiene etiquetas</span></div>
</div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
  <label style="font-size:12px;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px">
    <input type="checkbox" id="sa-wod-selall" checked> Seleccionar todo
    <span id="sa-wod-count" style="color:#cbd5e1;font-weight:600"></span>
  </label>
  <div style="display:flex;align-items:center;gap:8px">
    <label style="font-size:12px;color:#94a3b8">Nueva fecha:</label>
    <input type="date" id="sa-wod-date" style="padding:6px 12px;border-radius:6px;border:2px solid #8b5cf6;background:#0f172a;color:#e2e8f0;font-size:14px;cursor:pointer;color-scheme:dark">
  </div>
</div>
```

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): add label chip UI sections to modal"
```

---

### Task 4: Wire up label chip interaction and dynamic "remove" section

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (inside `showMainUI`)

- [ ] **Step 1: Add label selection state tracking**

Inside `showMainUI`, right after `let filteredWOs = wos;` (around line 363), add:

```javascript
const labelsToAdd = new Set();    // label IDs to add
const labelsToRemove = new Set(); // label IDs to remove
```

- [ ] **Step 2: Add function to rebuild the "remove" chips based on filtered WOs**

After the label state tracking, add:

```javascript
function rebuildRemoveChips() {
  // Collect labels present on at least one filtered WO
  const presentLabels = new Map(); // labelId → {id, name, color}
  for (const wo of filteredWOs) {
    const woLabels = extractWOLabels(wo, woLabelCatalog);
    for (const l of woLabels) {
      if (!presentLabels.has(l.id)) presentLabels.set(l.id, l);
    }
  }
  const container = document.getElementById('sa-wod-remove-labels');
  if (presentLabels.size === 0) {
    container.innerHTML = '<span style="font-size:11px;color:#64748b;font-style:italic">Ninguna OT tiene etiquetas</span>';
    labelsToRemove.clear();
    return;
  }
  container.innerHTML = [...presentLabels.values()].map(l => {
    const fg = labelTextColor(l.color);
    const sel = labelsToRemove.has(l.id) ? ' chip-selected' : '';
    return `<span class="sa-wod-label-chip chip-remove${sel}" data-label-id="${l.id}" data-action="remove" style="background:${l.color};color:${fg}">${l.name}</span>`;
  }).join('');
  // Prune removed labels that are no longer present
  for (const id of labelsToRemove) {
    if (!presentLabels.has(id)) labelsToRemove.delete(id);
  }
}
```

- [ ] **Step 3: Add click handlers for label chips**

After `rebuildRemoveChips`, add:

```javascript
document.getElementById('sa-wod-add-labels').addEventListener('click', (e) => {
  const chip = e.target.closest('.sa-wod-label-chip');
  if (!chip) return;
  const labelId = parseInt(chip.dataset.labelId);
  if (labelsToAdd.has(labelId)) { labelsToAdd.delete(labelId); chip.classList.remove('chip-selected'); }
  else { labelsToAdd.add(labelId); chip.classList.add('chip-selected'); }
  updateCounts();
});

document.getElementById('sa-wod-remove-labels').addEventListener('click', (e) => {
  const chip = e.target.closest('.sa-wod-label-chip');
  if (!chip) return;
  const labelId = parseInt(chip.dataset.labelId);
  if (labelsToRemove.has(labelId)) { labelsToRemove.delete(labelId); chip.classList.remove('chip-selected'); }
  else { labelsToRemove.add(labelId); chip.classList.add('chip-selected'); }
  updateCounts();
});
```

- [ ] **Step 4: Call rebuildRemoveChips from renderCards**

At the end of the existing `renderCards` function, just before `updateCounts();`, add:

```javascript
rebuildRemoveChips();
```

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): wire label chip selection and dynamic remove section"
```

---

### Task 5: Show WO labels on cards

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (inside `renderCards`)

- [ ] **Step 1: Add WO label badges to card HTML**

In `renderCards`, inside the `filteredWOs.map(wo => ...)` block, after the line that builds `roDisplay` (around line 404–405), add:

```javascript
const woLabels = extractWOLabels(wo, woLabelCatalog);
const woLabelsHTML = woLabels.length > 0
  ? `<div style="margin-top:3px">${woLabels.map(l => {
      const fg = labelTextColor(l.color);
      return `<span class="wo-label" style="background:${l.color};color:${fg}">${l.name}</span>`;
    }).join('')}</div>`
  : '';
```

Then in the card template string, add `${woLabelsHTML}` right after `${pnHTML}`:

```javascript
return `<div class="sa-wod-card ${isSelected ? 'selected' : ''}" data-id="${wo.id}">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <span class="wo-num">OT-${wo.idInDomain}</span>
    <input type="checkbox" class="sa-wod-cb" data-id="${wo.id}" ${isSelected ? 'checked' : ''}>
  </div>
  ${roDisplay}
  ${pnHTML}
  ${woLabelsHTML}
  <div class="wo-date">📅 ${formatDate(wo.deadline)}</div>
</div>`;
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): display WO labels on cards"
```

---

### Task 6: Dynamic button text and updated resolve payload

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (inside `showMainUI`)

- [ ] **Step 1: Update updateCounts for dynamic button text**

Replace the existing `updateCounts` function with:

```javascript
function updateCounts() {
  const visibleSelected = filteredWOs.filter(wo => selected.has(wo.id)).length;
  document.getElementById('sa-wod-count').textContent = `(${visibleSelected} de ${filteredWOs.length})`;

  const dateVal = document.getElementById('sa-wod-date').value;
  const hasLabels = labelsToAdd.size > 0 || labelsToRemove.size > 0;
  const execBtn = document.getElementById('sa-wod-exec');
  execBtn.disabled = visibleSelected === 0 || (!dateVal && !hasLabels);

  let btnText;
  if (dateVal && hasLabels) btnText = `APLICAR CAMBIOS (${visibleSelected})`;
  else if (dateVal) btnText = `APLICAR FECHA (${visibleSelected})`;
  else if (hasLabels) btnText = `APLICAR ETIQUETAS (${visibleSelected})`;
  else btnText = `APLICAR (${visibleSelected})`;
  execBtn.textContent = btnText;

  document.getElementById('sa-wod-selall').checked = visibleSelected === filteredWOs.length && filteredWOs.length > 0;
}
```

- [ ] **Step 2: Update the execute button handler to include label data**

Replace the existing `sa-wod-exec` onclick handler with:

```javascript
document.getElementById('sa-wod-exec').onclick = () => {
  const dateVal = document.getElementById('sa-wod-date').value;
  const selectedWOs = filteredWOs.filter(wo => selected.has(wo.id));
  ov.parentNode.removeChild(ov);
  resolve({
    selectedWOs,
    newDeadline: dateVal || null,
    labelsToAdd: [...labelsToAdd],
    labelsToRemove: [...labelsToRemove]
  });
};
```

Note: we now pass the full WO objects (not just IDs) because the label logic needs each WO's current labels.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): dynamic button text and label-aware resolve payload"
```

---

### Task 7: Implement label execution logic in the orchestrator

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (ORCHESTRATOR section)

- [ ] **Step 1: Add applyLabels function**

Add before the `run` function:

```javascript
async function applyLabels(selectedWOs, labelsToAdd, labelsToRemove, woLabelCatalog, onProgress) {
  let added = 0, removed = 0, errors = [];
  const BATCH = 10;

  for (let i = 0; i < selectedWOs.length; i += BATCH) {
    const batch = selectedWOs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (wo) => {
      try {
        const currentLabels = extractWOLabels(wo, woLabelCatalog);
        const currentIds = new Set(currentLabels.map(l => l.id));

        if (labelsToRemove.length > 0) {
          const removeSet = new Set(labelsToRemove);
          const hasAnyToRemove = currentLabels.some(l => removeSet.has(l.id));
          if (hasAnyToRemove) {
            // Delete all, then re-create keepers + adds
            await api().query('DeleteWorkOrderLabels', { woId: wo.id }, 'DeleteWorkOrderLabels');
            removed++;
            const keepIds = currentLabels.filter(l => !removeSet.has(l.id)).map(l => l.id);
            const addIds = labelsToAdd.filter(id => !currentIds.has(id) || removeSet.has(id));
            const allToCreate = [...new Set([...keepIds, ...addIds])];
            for (const labelId of allToCreate) {
              await api().query('CreateWorkOrderLabel', { workOrderId: wo.id, labelId }, 'CreateWorkOrderLabel');
            }
            added += addIds.length;
          } else {
            // Nothing to remove on this WO, just add new ones
            const newIds = labelsToAdd.filter(id => !currentIds.has(id));
            for (const labelId of newIds) {
              await api().query('CreateWorkOrderLabel', { workOrderId: wo.id, labelId }, 'CreateWorkOrderLabel');
            }
            added += newIds.length;
          }
        } else {
          // Only adding
          const newIds = labelsToAdd.filter(id => !currentIds.has(id));
          for (const labelId of newIds) {
            await api().query('CreateWorkOrderLabel', { workOrderId: wo.id, labelId }, 'CreateWorkOrderLabel');
          }
          added += newIds.length;
        }
      } catch (e) {
        errors.push(`OT ${wo.idInDomain}: ${String(e).substring(0, 100)}`);
      }
    }));
    if (onProgress) onProgress(`Etiquetas: ${Math.min(i + BATCH, selectedWOs.length)}/${selectedWOs.length}`);
  }
  return { added, removed, errors };
}
```

- [ ] **Step 2: Update run() to fetch label catalog and pass to UI**

In the `run` function, after the line `const dropdownCache = await fetchDropdownOptions();`, add:

```javascript
showProgress('Cargando etiquetas...');
const woLabelCatalog = await fetchWOLabels();
```

Then update the `showMainUI` call inside the while loop from:

```javascript
const choice = await showMainUI(data.wos, pnCache, currentUiDefaults, dropdownCache);
```

to:

```javascript
const choice = await showMainUI(data.wos, pnCache, currentUiDefaults, dropdownCache, woLabelCatalog);
```

- [ ] **Step 3: Replace the execution phase in run()**

Replace everything from `const { selectedIds, newDeadline } = finalChoice;` (line ~579) to the end of `run()` (before `return { run };`) with:

```javascript
const { selectedWOs, newDeadline, labelsToAdd, labelsToRemove } = finalChoice;
const selectedIds = selectedWOs.map(wo => wo.id);
log(`OTs seleccionadas: ${selectedIds.length}`);
if (newDeadline) log(`Nueva fecha: ${newDeadline}`);
if (labelsToAdd.length) log(`Etiquetas a agregar: ${labelsToAdd.length}`);
if (labelsToRemove.length) log(`Etiquetas a quitar: ${labelsToRemove.length}`);

let deadlineUpdated = 0, deadlineErrors = [];
let labelResult = { added: 0, removed: 0, errors: [] };

// Apply labels first
if (labelsToAdd.length > 0 || labelsToRemove.length > 0) {
  showProgress(`Aplicando etiquetas a ${selectedWOs.length} OTs...`);
  labelResult = await applyLabels(selectedWOs, labelsToAdd, labelsToRemove, woLabelCatalog, (msg) => showProgress(msg));
}

// Apply deadline
if (newDeadline) {
  showProgress(`Actualizando fecha de ${selectedIds.length} OTs...`);
  const deadline = new Date(newDeadline + 'T12:00:00.000Z').toISOString();
  const BATCH = 50;
  for (let i = 0; i < selectedIds.length; i += BATCH) {
    const batch = selectedIds.slice(i, i + BATCH);
    const input = batch.map(id => ({ id, deadline }));
    try {
      await api().query('CreateUpdateWorkOrdersChecked', { input }, 'CreateUpdateWorkOrdersChecked');
      deadlineUpdated += batch.length;
      showProgress(`Fecha: ${deadlineUpdated}/${selectedIds.length}`);
    } catch (e) {
      const errMsg = `Batch ${i}-${i + batch.length}: ${String(e).substring(0, 150)}`;
      deadlineErrors.push(errMsg);
      warn(errMsg);
    }
  }
}

hideProgress();

log(`\n=== RESULTADO ===`);
if (newDeadline) log(`Fecha actualizada: ${deadlineUpdated}`);
if (labelsToAdd.length || labelsToRemove.length) log(`Etiquetas agregadas: ${labelResult.added}, quitadas: ${labelResult.removed}`);
const allErrors = [...deadlineErrors, ...labelResult.errors];
log(`Errores: ${allErrors.length}`);

showSummary(deadlineUpdated, labelResult, newDeadline, allErrors);
return { deadlineUpdated, labelResult, errors: allErrors.length };
```

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): implement label execution logic in orchestrator"
```

---

### Task 8: Update summary dialog for combined results

**Files:**
- Modify: `remote/scripts/wo-deadline-changer.js` (`showSummary` function)

- [ ] **Step 1: Replace showSummary with combined version**

Replace the entire `showSummary` function with:

```javascript
function showSummary(deadlineUpdated, labelResult, newDeadline, allErrors) {
  ensureStyles();
  const ov = document.createElement('div');
  ov.className = 'sa-wod-overlay';
  const md = document.createElement('div');
  md.className = 'sa-wod-modal';
  md.style.maxWidth = '450px';

  const icon = allErrors.length > 0 ? '⚠️' : '✅';
  const color = allErrors.length > 0 ? '#f59e0b' : '#4ade80';

  let statsHTML = '';
  if (newDeadline) {
    statsHTML += `
      <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#4ade80">${deadlineUpdated}</div>
        <div style="font-size:11px;color:#94a3b8">Fecha actualizada</div>
      </div>`;
  }
  if (labelResult.added > 0) {
    statsHTML += `
      <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#60a5fa">${labelResult.added}</div>
        <div style="font-size:11px;color:#94a3b8">Etiquetas agregadas</div>
      </div>`;
  }
  if (labelResult.removed > 0) {
    statsHTML += `
      <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#f59e0b">${labelResult.removed}</div>
        <div style="font-size:11px;color:#94a3b8">OTs con etiquetas quitadas</div>
      </div>`;
  }
  if (allErrors.length > 0) {
    statsHTML += `
      <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#ef4444">${allErrors.length}</div>
        <div style="font-size:11px;color:#94a3b8">Errores</div>
      </div>`;
  }

  let errHTML = '';
  if (allErrors.length > 0) {
    errHTML = `<div style="margin-top:12px;font-size:11px;color:#fca5a5">${allErrors.slice(0, 10).join('<br>')}</div>`;
  }

  md.innerHTML = `
    <h2 style="color:${color}">${icon} Cambios Aplicados</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:16px 0">
      ${statsHTML}
    </div>
    ${errHTML}
    <div style="display:flex;justify-content:flex-end;margin-top:16px">
      <button class="sa-wod-btn sa-wod-btn-exec" id="sa-wod-close">CERRAR</button>
    </div>`;

  ov.appendChild(md);
  document.body.appendChild(ov);
  document.getElementById('sa-wod-close').onclick = () => ov.parentNode.removeChild(ov);
}
```

- [ ] **Step 2: Update the modal title**

In the `showMainUI` function, change the `<h2>` line from:

```html
<h2 style="color:#8b5cf6">📅 Cambio Masivo de Plazos OT</h2>
```

to:

```html
<h2 style="color:#8b5cf6">⚙️ Gestión Masiva de OT</h2>
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/wo-deadline-changer.js
git commit -m "feat(wo-deadline): update summary dialog and modal title for combined operations"
```

---

### Task 9: Deploy to gh-pages

**Files:**
- Deploy: `remote/config.json`, `remote/scripts/wo-deadline-changer.js` to gh-pages branch

- [ ] **Step 1: Deploy both branches**

Follow the standard deploy recipe: stash changes if needed, copy remote files to gh-pages branch flat layout, push both main and gh-pages.

- [ ] **Step 2: Verify in browser**

Open app.gosteelhead.com, load the extension, navigate to the WO deadline applet. Verify:
1. Title shows "⚙️ Gestión Masiva de OT"
2. Label chips appear for "Agregar" and "Quitar" sections
3. Selecting only labels → button says "APLICAR ETIQUETAS (N)"
4. Selecting only date → button says "APLICAR FECHA (N)"
5. Selecting both → button says "APLICAR CAMBIOS (N)"
6. WO cards show their current labels
7. Apply labels to a test WO, verify in Steelhead UI
