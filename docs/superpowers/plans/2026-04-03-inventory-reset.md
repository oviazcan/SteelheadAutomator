# Inventory Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New Chrome extension app that archives all active inventory batches for selected types and creates fresh batches from a CSV file.

**Architecture:** Single new script `inventory-reset.js` as IIFE (pattern matching `archiver.js`), registered in `config.json` as a new app, with a message handler in `background.js`. All UI rendered as modals injected into the Steelhead page. Three-phase flow: select types + CSV → archive batches → create batches.

**Tech Stack:** Vanilla JS, Chrome Extension MV3, Steelhead GraphQL persisted queries

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `remote/config.json` | Modify | Add inventory hashes + new app entry |
| `remote/scripts/inventory-reset.js` | Create | All inventory reset logic: fetch types, archive batches, create batches, UI |
| `extension/background.js` | Modify | Add message handler + global registration for `InventoryReset` |

---

### Task 1: Add inventory hashes and app entry to config.json

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Add inventory query hashes**

In `remote/config.json`, inside `steelhead.hashes.queries`, add after the last existing query entry (`AllReceivers`):

```json
"AllInventoryTypes": "c8df929bb155369cf5ee7c7939697cde53a939b644b9bd220bde662522537d4d",
"SearchInventoryTypeItems": "83964a4ab84b6fae39d781127dd7b08d0a0dd852a3e3f85a812bbeda627a6c9a",
"SearchInventoryItemBatches": "d0c8079c928e46305bb3cbd8e10642b195e7bbc7b5417e7f88960912c229f926",
"AllInventoryBatchStatuses": "37ef2266975d34d4318858553f68e56638c25ebff9bb4f16d080589c213cef09",
"CreateEditInventoryBatchDialogQuery": "25c91344eb1e8c12c47da2e65dea36b743a5af2f614fb514b4f12e84894f5b81",
"SearchLocationsOnPath": "65e13310e4b971aba5dce7a130c6e9259f9e1f556b79543ca5a1e414f593e29f"
```

- [ ] **Step 2: Add inventory mutation hashes**

In `steelhead.hashes.mutations`, add after the last existing mutation entry (`CreatePartNumberUserFile`):

```json
"UpdateInventoryBatchesChecked": "4981b6dcbb240d5f9ab763a3b0cedde1fc5bd22c4735e8a33fc717b1ef5e7ea0",
"CreateInventoryTransferEventGroups": "21bf4eb2b1b2ba6c95325a9e15ceb0a51c49715df020517b579f20ad634bb8d9"
```

- [ ] **Step 3: Add new app entry**

In the `apps` array, add after the `file-uploader` entry (last current app):

```json
{
  "id": "inventory-reset",
  "name": "Reinicio de Inventario",
  "subtitle": "Archivar lotes y carga inicial",
  "icon": "🔄",
  "scripts": ["scripts/steelhead-api.js", "scripts/inventory-reset.js"],
  "actions": [
    { "id": "run-inventory-reset", "label": "Reiniciar Inventario", "sublabel": "Archivar lotes y cargar desde CSV", "icon": "🔄", "type": "primary", "handler": "message", "message": "run-inventory-reset" }
  ]
}
```

- [ ] **Step 4: Commit**

```bash
git add remote/config.json
git commit -m "feat: add inventory reset hashes and app entry to config"
```

---

### Task 2: Create inventory-reset.js — helpers and fetch functions

**Files:**
- Create: `remote/scripts/inventory-reset.js`

- [ ] **Step 1: Write the IIFE shell with helpers**

Create `remote/scripts/inventory-reset.js`:

```javascript
// Steelhead Inventory Reset
// Archives active inventory batches and creates new ones from CSV
// Depends on: SteelheadAPI

const InventoryReset = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── CSV Parser ──
  function parseCSV(csvText, filename) {
    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('CSV vacío o sin datos');

    const header = lines[0].split(',').map(h => h.trim().toUpperCase());
    const nameIdx = header.indexOf('NAME');
    const qtyIdx = header.indexOf('CANTIDAD');
    if (nameIdx === -1 || qtyIdx === -1) throw new Error('CSV debe tener columnas NAME y CANTIDAD');

    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const name = cols[nameIdx];
      const qty = parseFloat(cols[qtyIdx]);
      if (!name || isNaN(qty) || qty <= 0) continue;
      items.push({ name, qty });
    }

    log(`CSV "${filename}": ${items.length} items con cantidad > 0`);
    return items;
  }

  // ── Fetch all inventory types ──
  async function fetchInventoryTypes() {
    const data = await api().query('AllInventoryTypes', {}, 'AllInventoryTypes');
    const nodes = data?.allInventoryTypes?.nodes || [];
    return nodes.filter(n => !n.archivedAt).map(n => ({
      id: n.id,
      name: n.name,
      nodeId: n.nodeId,
      isPartNumberInventory: n.isPartNumberInventory
    }));
  }

  // ── Fetch all items for an inventory type (paginated) ──
  async function fetchItemsForType(typeId, onProgress) {
    const allItems = [];
    let offset = 0;
    const pageSize = 50;
    while (true) {
      const data = await api().query('SearchInventoryTypeItems', {
        fetchCustomer: false, fetchCreator: false, fetchPurchaseOrder: false,
        fetchWorkOrder: false, fetchVendor: false, fetchReceivedOrder: false,
        fetchLocation: false, fetchMaterial: false,
        inventoryTypeId: typeId, searchString: '', offset, first: pageSize,
        orderBy: ['ID_ASC']
      }, 'SearchInventoryTypeItems');
      const nodes = data?.searchInventoryItems?.nodes || [];
      allItems.push(...nodes);
      if (onProgress) onProgress(`Items cargados: ${allItems.length}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return allItems;
  }

  // ── Fetch active batches for an item ──
  async function fetchActiveBatches(itemId) {
    const allBatches = [];
    let offset = 0;
    while (true) {
      const data = await api().query('SearchInventoryItemBatches', {
        id: itemId, archivedOption: 'NO', offset, notCompleted: true,
        first: 100, orderBy: ['ID_ASC']
      }, 'SearchInventoryItemBatches');
      const nodes = data?.searchInventoryBatches?.nodes || [];
      allBatches.push(...nodes);
      if (nodes.length < 100) break;
      offset += 100;
    }
    // Only batches with remaining quantity > 0
    return allBatches.filter(b => {
      const remaining = parseInt(b.totalRemainingMicroQuantity || '0', 10);
      return remaining > 0;
    });
  }

  // ── Archive batches in groups of 20 ──
  async function archiveBatches(batchIds, onProgress) {
    let archived = 0;
    const errors = [];
    for (let i = 0; i < batchIds.length; i += 20) {
      const chunk = batchIds.slice(i, i + 20);
      try {
        await api().query('UpdateInventoryBatchesChecked', {
          batches: chunk.map(id => ({ id, archive: true }))
        }, 'UpdateInventoryBatchesChecked');
        archived += chunk.length;
      } catch (e) {
        errors.push(...chunk.map(id => ({ id, error: String(e).substring(0, 100) })));
      }
      if (onProgress) onProgress(`Archivando lotes: ${archived}/${batchIds.length}`);
    }
    return { archived, errors };
  }

  // ── Search location by path ──
  async function findLocation(searchText) {
    const data = await api().query('SearchLocationsOnPath', {
      fetchInventoryItem: false, fetchPartNumber: false, isShipping: null,
      path: '', searchText: `%${searchText}%`, offset: 0, first: 50,
      subpathOffset: 0, searchTextLast: `%${searchText}%`,
      archivedIsNull: true, isEmpty: false, includeTypes: true
    }, 'SearchLocationsOnPath');
    return data?.searchLocationsOnPath?.nodes || [];
  }

  // ── Get default batch status for a type ──
  async function getDefaultBatchStatus(typeId) {
    const data = await api().query('AllInventoryBatchStatuses', {
      typeId
    }, 'AllInventoryBatchStatuses');
    const statuses = data?.allInventoryBatchStatuses?.nodes || [];
    // Return first status (usually the default/initial one)
    return statuses.length > 0 ? statuses[0].id : null;
  }

  // ── Get inputSchemaId from inventory type dialog query ──
  async function getInputSchemaId(itemId) {
    try {
      const data = await api().query('CreateEditInventoryBatchDialogQuery', {
        inventoryItemId: itemId, inventoryBatchId: -1
      }, 'CreateEditInventoryBatchDialogQuery');
      const schemas = data?.latestGenericInventoryBatchInputSchema?.nodes || [];
      return schemas.length > 0 ? schemas[0].id : null;
    } catch (_) {
      return null;
    }
  }

  // ── Create a single batch ──
  async function createBatch(itemId, microQuantity, locationId, statusId, inputSchemaId, csvFilename) {
    const payload = {
      inventoryTransferEventGroups: [{
        inventoryTransferEvents: [{
          debitAccounts: {
            createInventoryBatch: {
              name: 'Carga Inicial',
              inventoryItemId: itemId,
              descriptionMarkdown: `Carga inicial desde: ${csvFilename}`,
              statusId,
              customInputs: {},
              inputSchemaId
            },
            accounts: [{
              microQuantity,
              locationId
            }]
          },
          creditAccounts: {
            accounts: [{ microQuantity }]
          },
          transferType: 'CREATE'
        }]
      }]
    };

    try {
      return await api().query('CreateInventoryTransferEventGroups', payload, 'CreateInventoryTransferEventGroups');
    } catch (e) {
      // Retry with unitCostMicroDollars: 0 if API rejected the payload
      if (String(e).includes('unitCost') || String(e).includes('cost')) {
        payload.inventoryTransferEventGroups[0].inventoryTransferEvents[0]
          .debitAccounts.createInventoryBatch.unitCostMicroDollars = 0;
        return await api().query('CreateInventoryTransferEventGroups', payload, 'CreateInventoryTransferEventGroups');
      }
      throw e;
    }
  }

  return { parseCSV, fetchInventoryTypes, fetchItemsForType, fetchActiveBatches, archiveBatches, findLocation, getDefaultBatchStatus, getInputSchemaId, createBatch };
})();

if (typeof window !== 'undefined') window.InventoryReset = InventoryReset;
```

- [ ] **Step 2: Commit**

```bash
git add remote/scripts/inventory-reset.js
git commit -m "feat: add inventory-reset.js with fetch, archive, and create helpers"
```

---

### Task 3: Add the main `run()` flow and UI to inventory-reset.js

**Files:**
- Modify: `remote/scripts/inventory-reset.js`

- [ ] **Step 1: Add UI functions and the `run()` orchestrator**

Before the `return { ... }` line at the bottom of the IIFE, add these functions. Then update the return statement to expose `run` instead of the individual helpers.

Add these UI + orchestration functions before the `return` line:

```javascript
  // ══════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('sa-invr-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-invr-styles';
    s.textContent = `
      .sa-invr-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-invr-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:600px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
      .sa-invr-modal h2{font-size:20px;margin:0 0 12px}
      .sa-invr-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}
      .sa-invr-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
      .sa-invr-btn-cancel{background:#475569;color:#e2e8f0}
      .sa-invr-btn-exec{background:#f59e0b;color:#0f172a}
      .sa-invr-progress{font-size:13px;color:#94a3b8;margin-top:8px}
      .sa-invr-bar{width:100%;height:6px;background:#334155;border-radius:3px;margin-top:12px;overflow:hidden}
      .sa-invr-bar-fill{height:100%;background:#f59e0b;border-radius:3px;transition:width 0.3s}
    `;
    document.head.appendChild(s);
  }

  function showProgressUI(title, msg) {
    ensureStyles();
    let ov = document.getElementById('sa-invr-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-invr-overlay';
      ov.className = 'sa-invr-overlay';
      ov.innerHTML = `<div class="sa-invr-modal" style="background:#1a1e2e">
        <h2 style="color:#f59e0b" id="sa-invr-title">${title}</h2>
        <div class="sa-invr-bar"><div class="sa-invr-bar-fill" id="sa-invr-bar" style="width:0%"></div></div>
        <div class="sa-invr-progress" id="sa-invr-text">${msg}</div>
      </div>`;
      document.body.appendChild(ov);
    } else {
      document.getElementById('sa-invr-title').textContent = title;
      document.getElementById('sa-invr-text').textContent = msg;
    }
  }

  function updateProgress(msg, percent) {
    const el = document.getElementById('sa-invr-text');
    if (el) el.textContent = msg;
    if (percent !== undefined) {
      const bar = document.getElementById('sa-invr-bar');
      if (bar) bar.style.width = percent + '%';
    }
  }

  function removeUI() {
    const ov = document.getElementById('sa-invr-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // ── Config form (Phase 1) ──
  function showConfigForm() {
    return new Promise(async (resolve) => {
      ensureStyles();

      // Fetch inventory types
      let types;
      try {
        types = await fetchInventoryTypes();
      } catch (e) {
        resolve({ error: 'Error cargando tipos de inventario: ' + e.message });
        return;
      }

      const preSelected = ['Materia Prima', 'Materia Prima P', 'Metales'];

      const ov = document.createElement('div');
      ov.className = 'sa-invr-overlay';
      const md = document.createElement('div');
      md.className = 'sa-invr-modal';
      md.style.background = '#1a1e2e';

      const typesHTML = types.map(t => {
        const checked = preSelected.some(ps => t.name.toLowerCase().includes(ps.toLowerCase())) ? 'checked' : '';
        return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:3px 0;cursor:pointer">
          <input type="checkbox" class="sa-invr-type" value="${t.id}" data-name="${t.name}" ${checked}>
          ${t.name}
        </label>`;
      }).join('');

      md.innerHTML = `
        <h2 style="color:#f59e0b">🔄 Reinicio de Inventario</h2>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:16px">Archiva todos los lotes activos de los tipos seleccionados y crea nuevos lotes desde un CSV.</p>

        <div style="margin-bottom:16px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:6px;font-weight:600">Tipos de inventario:</label>
          ${typesHTML}
        </div>

        <div style="margin-bottom:16px">
          <label style="font-size:13px;color:#cbd5e1;display:block;margin-bottom:6px;font-weight:600">Archivo CSV (NAME, CANTIDAD):</label>
          <input type="file" id="sa-invr-file" accept=".csv" style="font-size:12px;color:#e2e8f0">
        </div>

        <p style="font-size:11px;color:#ef4444;margin-bottom:8px">⚠️ Esta operación archivará TODOS los lotes con cantidad restante en los tipos seleccionados. Es irreversible.</p>

        <div class="sa-invr-btnrow">
          <button class="sa-invr-btn sa-invr-btn-cancel" id="sa-invr-cancel">CANCELAR</button>
          <button class="sa-invr-btn sa-invr-btn-exec" id="sa-invr-exec">INICIAR</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      document.getElementById('sa-invr-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      document.getElementById('sa-invr-exec').onclick = () => {
        const selectedTypes = [...md.querySelectorAll('.sa-invr-type:checked')].map(cb => ({
          id: parseInt(cb.value),
          name: cb.dataset.name
        }));

        if (!selectedTypes.length) { alert('Selecciona al menos un tipo de inventario.'); return; }

        const fileInput = document.getElementById('sa-invr-file');
        if (!fileInput.files.length) { alert('Selecciona un archivo CSV.'); return; }

        const file = fileInput.files[0];
        const reader = new FileReader();
        reader.onload = () => {
          ov.parentNode.removeChild(ov);
          resolve({
            selectedTypes,
            csvText: reader.result,
            csvFilename: file.name
          });
        };
        reader.onerror = () => {
          alert('Error leyendo archivo.');
        };
        reader.readAsText(file, 'UTF-8');
      };
    });
  }

  // ── Main orchestrator ──
  async function run() {
    // Phase 1: Config form
    const config = await showConfigForm();
    if (config.cancelled) return { cancelled: true };
    if (config.error) return config;

    const { selectedTypes, csvText, csvFilename } = config;

    // Parse CSV
    let csvItems;
    try {
      csvItems = parseCSV(csvText, csvFilename);
    } catch (e) {
      return { error: 'Error parseando CSV: ' + e.message };
    }

    if (!csvItems.length) return { error: 'CSV sin items válidos (cantidad > 0)' };

    const results = {
      archived: { total: 0, errors: [] },
      created: { total: 0, errors: [], noMatch: [] },
      csvFilename
    };

    showProgressUI('Reinicio de Inventario', 'Preparando...');

    // ── Phase 2: Archive existing batches ──
    log('=== REINICIO DE INVENTARIO ===');
    log(`Tipos: ${selectedTypes.map(t => t.name).join(', ')}`);
    log(`CSV: ${csvFilename} (${csvItems.length} items)`);

    // Collect all items across selected types
    const allItemsByType = {};
    const allItemsFlat = [];
    let totalBatchesToArchive = 0;

    for (const type of selectedTypes) {
      updateProgress(`Cargando items de "${type.name}"...`, 5);
      const items = await fetchItemsForType(type.id, (msg) => updateProgress(msg));
      allItemsByType[type.id] = items;
      allItemsFlat.push(...items.map(it => ({ ...it, typeId: type.id, typeName: type.name })));
      log(`  ${type.name}: ${items.length} items`);
    }

    updateProgress(`Buscando lotes activos en ${allItemsFlat.length} items...`, 10);

    // Collect batches to archive
    const batchesToArchive = [];
    for (let i = 0; i < allItemsFlat.length; i++) {
      const item = allItemsFlat[i];
      if (i % 10 === 0) updateProgress(`Revisando lotes: ${i}/${allItemsFlat.length} items`, 10 + (i / allItemsFlat.length) * 30);
      try {
        const batches = await fetchActiveBatches(item.id);
        for (const b of batches) {
          batchesToArchive.push({ batchId: b.id, itemName: item.name });
        }
      } catch (e) {
        warn(`Error buscando lotes de "${item.name}": ${String(e).substring(0, 80)}`);
      }
    }

    log(`  ${batchesToArchive.length} lotes activos con cantidad restante`);

    if (batchesToArchive.length > 0) {
      updateProgress(`Archivando ${batchesToArchive.length} lotes...`, 40);
      const archiveResult = await archiveBatches(
        batchesToArchive.map(b => b.batchId),
        (msg) => updateProgress(msg, 40 + (results.archived.total / batchesToArchive.length) * 20)
      );
      results.archived.total = archiveResult.archived;
      results.archived.errors = archiveResult.errors;
      log(`  Archivados: ${archiveResult.archived}, errores: ${archiveResult.errors.length}`);
    }

    // ── Phase 3: Create new batches from CSV ──
    updateProgress('Preparando carga inicial...', 60);

    // Build name→item lookup from all loaded items (case-insensitive)
    const itemLookup = {};
    for (const item of allItemsFlat) {
      itemLookup[item.name.trim().toLowerCase()] = item;
    }

    // Match CSV items
    const matched = [];
    for (const csvItem of csvItems) {
      const key = csvItem.name.trim().toLowerCase();
      const item = itemLookup[key];
      if (item) {
        matched.push({ ...csvItem, itemId: item.id, typeId: item.typeId });
      } else {
        results.created.noMatch.push(csvItem.name);
      }
    }

    if (results.created.noMatch.length > 0) {
      log(`  ${results.created.noMatch.length} items sin match: ${results.created.noMatch.slice(0, 10).join(', ')}${results.created.noMatch.length > 10 ? '...' : ''}`);
    }
    log(`  ${matched.length} items con match para crear lotes`);

    // Find location
    let locationId = null;
    try {
      const locations = await findLocation('RJ');
      const rjLoc = locations.find(l => l.path && l.path.includes('A3') && l.path.includes('RJ'));
      if (rjLoc) {
        locationId = rjLoc.id;
        log(`  Ubicación: ${rjLoc.path} (id: ${locationId})`);
      } else if (locations.length > 0) {
        locationId = locations[0].id;
        log(`  Ubicación (fallback): ${locations[0].path} (id: ${locationId})`);
      }
    } catch (e) {
      warn('Error buscando ubicación: ' + e.message);
    }

    if (!locationId) {
      results.created.errors.push('No se encontró ubicación RJ — no se crearon lotes');
      removeUI();
      return results;
    }

    // Get default status and inputSchemaId (from first type, use for all)
    const firstTypeId = selectedTypes[0].id;
    let statusId = await getDefaultBatchStatus(firstTypeId);
    if (!statusId) {
      warn('No se encontró status default, usando null');
    }

    // Get inputSchemaId from first matched item
    let inputSchemaId = null;
    if (matched.length > 0) {
      inputSchemaId = await getInputSchemaId(matched[0].itemId);
      log(`  inputSchemaId: ${inputSchemaId}`);
    }

    // Create batches one by one
    for (let i = 0; i < matched.length; i++) {
      const item = matched[i];
      const pct = 65 + (i / matched.length) * 33;
      updateProgress(`Creando lote ${i + 1}/${matched.length}: ${item.name}`, pct);

      const microQty = Math.round(item.qty * 1000000);
      try {
        await createBatch(item.itemId, microQty, locationId, statusId, inputSchemaId, csvFilename);
        results.created.total++;
      } catch (e) {
        results.created.errors.push(`"${item.name}": ${String(e).substring(0, 100)}`);
        warn(`Error creando lote "${item.name}": ${String(e).substring(0, 100)}`);
      }
    }

    // ── Summary ──
    log('\n=== RESULTADO ===');
    log(`Lotes archivados: ${results.archived.total}`);
    log(`Lotes creados: ${results.created.total}/${matched.length}`);
    log(`Sin match: ${results.created.noMatch.length}`);
    log(`Errores archivo: ${results.archived.errors.length}`);
    log(`Errores creación: ${results.created.errors.length}`);

    removeUI();

    // Show summary alert
    let summary = `Reinicio de Inventario completado:\n\n`;
    summary += `Lotes archivados: ${results.archived.total}\n`;
    summary += `Lotes creados: ${results.created.total}/${matched.length}\n`;
    if (results.created.noMatch.length > 0) {
      summary += `\nSin match en inventario (${results.created.noMatch.length}):\n`;
      summary += results.created.noMatch.slice(0, 15).join('\n');
      if (results.created.noMatch.length > 15) summary += `\n... y ${results.created.noMatch.length - 15} más`;
    }
    if (results.archived.errors.length > 0) {
      summary += `\n\nErrores de archivado: ${results.archived.errors.length}`;
    }
    if (results.created.errors.length > 0) {
      summary += `\n\nErrores de creación:\n`;
      summary += results.created.errors.slice(0, 10).join('\n');
    }
    alert(summary);

    return results;
  }
```

- [ ] **Step 2: Update the return statement and global export**

Replace the existing `return` and global export at the bottom of the IIFE:

```javascript
  return { run };
})();

if (typeof window !== 'undefined') window.InventoryReset = InventoryReset;
```

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/inventory-reset.js
git commit -m "feat: add run() orchestrator and UI to inventory-reset.js"
```

---

### Task 4: Add message handler and global registration in background.js

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Register the InventoryReset global in the inject function**

In `extension/background.js`, find the `globals` object inside `injectAppScripts` (line ~53). Add the new entry:

Change:
```javascript
        const globals = { 'scripts/steelhead-api.js': 'SteelheadAPI', 'scripts/bulk-upload.js': 'BulkUpload',
          'scripts/catalog-fetcher.js': 'CatalogFetcher', 'scripts/hash-scanner.js': 'HashScanner',
          'scripts/api-knowledge.js': 'APIKnowledge' };
```

To:
```javascript
        const globals = { 'scripts/steelhead-api.js': 'SteelheadAPI', 'scripts/bulk-upload.js': 'BulkUpload',
          'scripts/catalog-fetcher.js': 'CatalogFetcher', 'scripts/hash-scanner.js': 'HashScanner',
          'scripts/api-knowledge.js': 'APIKnowledge', 'scripts/inventory-reset.js': 'InventoryReset' };
```

- [ ] **Step 2: Add the message handler**

In `extension/background.js`, add a new case before the `default:` case (line ~524):

```javascript
    // ── Inventory Reset ──
    case 'run-inventory-reset': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'inventory-reset');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (!window.InventoryReset) return { error: 'InventoryReset no disponible' };
          return window.InventoryReset.run();
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }
```

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat: add inventory-reset handler and global to background.js"
```

---

### Task 5: Manual integration test

- [ ] **Step 1: Verify config.json is valid JSON**

```bash
python3 -c "import json; json.load(open('remote/config.json')); print('OK')"
```

Expected: `OK`

- [ ] **Step 2: Verify inventory-reset.js has no syntax errors**

```bash
node -c remote/scripts/inventory-reset.js
```

Expected: no output (no syntax errors)

- [ ] **Step 3: Push to GitHub Pages and test in browser**

```bash
git push
```

Then in Chrome:
1. Open `app.gosteelhead.com`
2. Click the extension popup
3. Verify "Reinicio de Inventario" appears in the app menu
4. Click it → Click "Reiniciar Inventario"
5. Verify the modal shows with inventory type checkboxes
6. Select the 3 types, upload the CSV, and run

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for inventory reset"
```
