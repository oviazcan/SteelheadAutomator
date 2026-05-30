// archive-pn-inventory-batches.js
// One-shot DevTools script: archivar TODOS los lotes activos de los inventory
// types de "números de parte" (isPartNumberInventory === true).
//
// Uso: reinicio total del inventario de números de parte. NO recrea lotes,
// NO toca part numbers. Solo archiva lotes (InventoryBatch) vía
// UpdateInventoryBatchesChecked, igual que la Fase 2 de inventory-reset.js
// pero filtrando automáticamente por isPartNumberInventory.
//
// Cómo correr:
//   1. Abre app.gosteelhead.com logueado → DevTools → Console.
//   2. Pega este archivo y Enter. Por default corre en DRY-RUN: solo cuenta
//      y reporta cuántos tipos/items/lotes se archivarían, y descarga un JSON
//      con la lista de IDs candidatos.
//   3. Revisa el conteo. Si todo cuadra, NO hace falta repegar: el dry-run
//      deja listo un ejecutor en la consola. Solo escribe y Enter:
//          archivePnBatchesNow()
//      Esto archiva de verdad (reusando los IDs ya escaneados) y descarga un
//      JSON con los IDs archivados + errores.
//      (Alternativa: cambiar EXEC a true abajo y repegar — re-escanea todo.)
//
// Lotes incluidos: TODOS los no archivados (archivedOption:'NO', notCompleted:
// false), tengan o no cantidad restante. Reinicio total.

(async () => {
  // ─────────────────────────────────────────────
  const EXEC = false;   // ← cambia a true para archivar de verdad
  // ─────────────────────────────────────────────

  const HASHES = {
    AllInventoryTypes:             'c8df929bb155369cf5ee7c7939697cde53a939b644b9bd220bde662522537d4d',
    SearchInventoryTypeItems:      '83964a4ab84b6fae39d781127dd7b08d0a0dd852a3e3f85a812bbeda627a6c9a',
    SearchInventoryItemBatches:    'd0c8079c928e46305bb3cbd8e10642b195e7bbc7b5417e7f88960912c229f926',
    UpdateInventoryBatchesChecked: '4981b6dcbb240d5f9ab763a3b0cedde1fc5bd22c4735e8a33fc717b1ef5e7ea0'
  };

  const PAGE_TYPE_ITEMS = 50;
  const PAGE_BATCHES = 100;
  const ARCHIVE_CHUNK = 20;
  const SLEEP_PER_CHUNK_MS = 80;

  async function gql(op, vars) {
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
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  async function withRetry(fn, maxRetry = 2) {
    let lastErr;
    for (let i = 0; i <= maxRetry; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        const msg = String(e);
        if (msg.includes('HTTP 5') || msg.includes('NetworkError')) {
          await new Promise(r => setTimeout(r, 800 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── Tipos de inventario de números de parte ──
  async function fetchPartNumberTypes() {
    const data = await gql('AllInventoryTypes', {});
    const nodes = data?.allInventoryTypes?.nodes || [];
    return nodes
      .filter(n => n.isPartNumberInventory && !n.archivedAt)
      .map(n => ({ id: n.id, name: n.name }));
  }

  // ── Items de un tipo (paginado) ──
  async function fetchItemsForType(typeId) {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await withRetry(() => gql('SearchInventoryTypeItems', {
        fetchCustomer: false, fetchCreator: false, fetchPurchaseOrder: false,
        fetchWorkOrder: false, fetchVendor: false, fetchReceivedOrder: false,
        fetchLocation: false, fetchMaterial: false,
        inventoryTypeId: typeId, searchString: '', offset, first: PAGE_TYPE_ITEMS,
        orderBy: ['ID_ASC']
      }));
      const nodes = data?.searchInventoryItems?.nodes || [];
      all.push(...nodes);
      if (nodes.length < PAGE_TYPE_ITEMS) break;
      offset += PAGE_TYPE_ITEMS;
    }
    return all;
  }

  // ── Lotes activos de un item (TODOS, sin filtro de cantidad) ──
  async function fetchActiveBatches(itemId) {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await withRetry(() => gql('SearchInventoryItemBatches', {
        id: itemId, archivedOption: 'NO', offset, notCompleted: false,
        first: PAGE_BATCHES, orderBy: ['ID_ASC']
      }));
      const nodes = data?.searchInventoryBatches?.nodes || [];
      all.push(...nodes);
      if (nodes.length < PAGE_BATCHES) break;
      offset += PAGE_BATCHES;
    }
    return all;
  }

  // ── Archivar en chunks de 20 ──
  async function archiveBatches(batchIds) {
    let archived = 0;
    const errors = [];
    for (let i = 0; i < batchIds.length; i += ARCHIVE_CHUNK) {
      const chunk = batchIds.slice(i, i + ARCHIVE_CHUNK);
      try {
        await withRetry(() => gql('UpdateInventoryBatchesChecked', {
          batches: chunk.map(id => ({ id, archive: true }))
        }));
        archived += chunk.length;
      } catch (e) {
        errors.push(...chunk.map(id => ({ id, error: String(e).slice(0, 300) })));
      }
      console.log(`  archivando lotes: ${archived}/${batchIds.length}`);
      await sleep(SLEEP_PER_CHUNK_MS);
    }
    return { archived, errors };
  }

  // ══════════════════════════════════════════
  // Main
  // ══════════════════════════════════════════
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`%c=== Archive PN Inventory Batches — ${EXEC ? 'EXEC' : 'DRY-RUN'} ===`,
    'font-weight:bold;color:#f59e0b');

  const types = await fetchPartNumberTypes();
  if (!types.length) {
    console.warn('No hay inventory types con isPartNumberInventory=true. Nada que hacer.');
    return;
  }
  console.log(`Tipos PN: ${types.map(t => `${t.name} (#${t.id})`).join(', ')}`);

  // Recolectar lotes por tipo
  const perType = [];   // [{ typeId, typeName, items, batchIds }]
  const allBatchIds = [];
  const batchDetail = []; // [{ batchId, itemId, itemName, typeName }]

  for (const type of types) {
    const items = await fetchItemsForType(type.id);
    let typeBatchCount = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i % 25 === 0) console.log(`  [${type.name}] revisando lotes: ${i}/${items.length} items`);
      try {
        const batches = await fetchActiveBatches(item.id);
        for (const b of batches) {
          allBatchIds.push(b.id);
          batchDetail.push({ batchId: b.id, itemId: item.id, itemName: item.name, typeName: type.name });
          typeBatchCount++;
        }
      } catch (e) {
        console.warn(`  error en item "${item.name}" (#${item.id}): ${String(e).slice(0, 120)}`);
      }
    }
    perType.push({ typeId: type.id, typeName: type.name, items: items.length, batches: typeBatchCount });
    console.log(`  ${type.name}: ${items.length} items, ${typeBatchCount} lotes activos`);
  }

  console.log(`\nTotal: ${allBatchIds.length} lotes activos en ${types.length} tipos PN`);
  console.table(perType);

  // ── Ejecuta el archivado real sobre los IDs ya recolectados ──
  async function doArchive() {
    console.log(`%cArchivando ${allBatchIds.length} lotes...`, 'color:#ef4444;font-weight:bold');
    const result = await archiveBatches(allBatchIds);
    console.log(`\n%c=== RESULTADO ===`, 'font-weight:bold;color:#4ade80');
    console.log(`Lotes archivados: ${result.archived}/${allBatchIds.length}`);
    console.log(`Errores: ${result.errors.length}`);
    if (result.errors.length) console.table(result.errors.slice(0, 50));

    const out = {
      mode: 'exec', stamp,
      types, perType,
      totalBatches: allBatchIds.length,
      archived: result.archived,
      errors: result.errors,
      batchDetail
    };
    downloadJSON(out, `archive-pn-batches_EXEC_${stamp}.json`);
    console.log('%cJSON descargado con IDs archivados + errores.', 'color:#4ade80');
    return result;
  }

  if (EXEC) {
    return doArchive();
  }

  // DRY-RUN: descarga candidatos y deja listo el ejecutor en consola
  const out = {
    mode: 'dry-run', stamp,
    types, perType,
    totalBatches: allBatchIds.length,
    batchIds: allBatchIds,
    batchDetail
  };
  downloadJSON(out, `archive-pn-batches_DRYRUN_${stamp}.json`);
  window.archivePnBatchesNow = doArchive;
  console.log('%cDRY-RUN: no se archivó nada. Revisa el conteo y el JSON descargado.', 'color:#38bdf8');
  console.log('%c→ Para archivar de verdad SIN re-escanear, escribe en la consola:', 'color:#f59e0b;font-weight:bold');
  console.log('%c   archivePnBatchesNow()', 'color:#f59e0b;font-family:monospace;font-size:14px');
})();
