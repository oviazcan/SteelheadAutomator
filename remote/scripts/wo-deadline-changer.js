// Steelhead WO Deadline Changer
// Bulk-update work order deadlines with filters
// Depends on: SteelheadAPI

const WODeadlineChanger = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ══════════════════════════════════════════
  // DATA
  // ══════════════════════════════════════════

  async function fetchAllActiveWOs(serverFilters, onProgress) {
    const all = [];
    const PAGE = 500;
    let offset = 0;
    while (true) {
      const vars = {
        status: 'ACTIVE', includeArchived: 'NO', couponWorkOrders: null,
        computeMargins: false, orderBy: ['ID_DESC'],
        offset, first: PAGE, searchQuery: '',
        ...serverFilters
      };
      const data = await api().query('AllWorkOrders', vars, 'AllWorkOrders');
      const nodes = data?.pagedData?.nodes || [];
      const total = data?.pagedData?.totalCount || 0;
      all.push(...nodes);
      if (onProgress) onProgress(`OTs: ${all.length}/${total}`);
      if (nodes.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  }

  async function enrichWithPNData(wos, onProgress) {
    // Collect unique partNumberIds
    const pnIds = new Set();
    for (const wo of wos) {
      for (const pnwo of (wo.partNumberWorkOrdersByWorkOrderId?.nodes || [])) {
        if (pnwo.partNumberId) pnIds.add(pnwo.partNumberId);
      }
    }

    if (pnIds.size === 0) return {};

    // Batch-fetch PN details
    const pnCache = {}; // pnId → { name, labels: [{name, color}] }
    const ids = [...pnIds];
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (pnId) => {
        try {
          const data = await api().query('GetPartNumber', {
            partNumberId: pnId, usagesLimit: 0, usagesOffset: 0
          });
          const pn = data?.partNumberById;
          if (!pn) return null;
          return {
            id: pnId,
            name: pn.name || `PN ${pnId}`,
            labels: (pn.partNumberLabelsByPartNumberId?.nodes || []).map(n => ({
              name: n.labelByLabelId?.name || '?',
              color: n.labelByLabelId?.color || '#475569'
            }))
          };
        } catch (e) { return null; }
      }));
      for (const r of results) {
        if (r) pnCache[r.id] = r;
      }
      if (onProgress) onProgress(`NPs: ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
    }
    return pnCache;
  }

  function parseURLFilters() {
    const params = new URLSearchParams(window.location.search);
    const serverFilters = {};
    const uiDefaults = {};
    const customerFilter = params.get('customerIdFilter');
    if (customerFilter) {
      try {
        const ids = JSON.parse(customerFilter);
        serverFilters.customerIdFilter = Array.isArray(ids) ? ids : [ids];
      } catch (_) {
        serverFilters.customerIdFilter = [parseInt(customerFilter)];
      }
      uiDefaults.customerId = serverFilters.customerIdFilter[0];
    }
    return { serverFilters, uiDefaults };
  }

  // ══════════════════════════════════════════
  // FILTER LOGIC
  // ══════════════════════════════════════════

  function applyFilters(wos, filters, pnCache) {
    return wos.filter(wo => {
      if (filters.customerId && wo.customerByCustomerId?.id !== filters.customerId) return false;
      if (filters.productId && wo.productByProductId?.id !== filters.productId) return false;

      if (filters.partNumber) {
        const q = filters.partNumber.toLowerCase();
        const pns = (wo.partNumberWorkOrdersByWorkOrderId?.nodes || []);
        const match = pns.some(pnwo => {
          const pn = pnCache[pnwo.partNumberId];
          return pn && pn.name.toLowerCase().includes(q);
        });
        if (!match) return false;
      }

      if (filters.receivedOrder) {
        const q = filters.receivedOrder.toLowerCase();
        const roName = wo.receivedOrderByReceivedOrderId?.name || '';
        if (!roName.toLowerCase().includes(q)) return false;
      }

      if (filters.woName) {
        const q = filters.woName.toLowerCase();
        if (!(wo.name || '').toLowerCase().includes(q)) return false;
      }

      return true;
    });
  }

  // ══════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('sa-wod-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-wod-styles';
    s.textContent = `
      .sa-wod-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-wod-modal{background:#1a1a2e;color:#e2e8f0;border-radius:12px;padding:24px 28px;max-width:1100px;width:96%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
      .sa-wod-modal h2{font-size:18px;margin:0 0 10px}
      .sa-wod-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
      .sa-wod-filters input,.sa-wod-filters select{padding:6px 10px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:12px}
      .sa-wod-filters input{width:120px}
      .sa-wod-filters select{width:150px}
      .sa-wod-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;overflow-y:auto;flex:1;min-height:200px;max-height:55vh;padding:4px}
      .sa-wod-card{background:#0f172a;border-radius:8px;padding:10px 12px;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;font-size:11px}
      .sa-wod-card:hover{border-color:#475569}
      .sa-wod-card.selected{border-color:#8b5cf6}
      .sa-wod-card .wo-num{font-size:13px;font-weight:700;color:#e2e8f0}
      .sa-wod-card .wo-ro{color:#60a5fa;font-size:10px}
      .sa-wod-card .wo-pn{color:#cbd5e1;margin-top:3px}
      .sa-wod-card .wo-label{display:inline-block;padding:0 6px;border-radius:8px;font-size:9px;font-weight:600;color:#fff;margin:1px 2px;white-space:nowrap}
      .sa-wod-card .wo-date{color:#94a3b8;margin-top:3px}
      .sa-wod-bar{display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:12px}
      .sa-wod-btn{padding:8px 20px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
      .sa-wod-btn-cancel{background:#475569;color:#e2e8f0}
      .sa-wod-btn-exec{background:#8b5cf6;color:white}
      .sa-wod-btn-exec:disabled{opacity:0.4;cursor:default}
      .sa-wod-progress{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-wod-progress-box{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;text-align:center;min-width:300px}
    `;
    document.head.appendChild(s);
  }

  function showProgress(msg) {
    ensureStyles();
    let el = document.getElementById('sa-wod-prog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sa-wod-prog';
      el.className = 'sa-wod-progress';
      el.innerHTML = '<div class="sa-wod-progress-box"><div id="sa-wod-prog-msg" style="font-size:14px"></div></div>';
      document.body.appendChild(el);
    }
    document.getElementById('sa-wod-prog-msg').textContent = msg;
  }

  function hideProgress() {
    const el = document.getElementById('sa-wod-prog');
    if (el) el.parentNode.removeChild(el);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function showMainUI(wos, pnCache, uiDefaults) {
    return new Promise((resolve) => {
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-wod-overlay';
      const md = document.createElement('div');
      md.className = 'sa-wod-modal';

      // Extract unique customers and products for dropdowns
      const customers = {};
      const products = {};
      for (const wo of wos) {
        const c = wo.customerByCustomerId;
        if (c) customers[c.id] = c.name;
        const p = wo.productByProductId;
        if (p) products[p.id] = p.name;
      }

      const customerOpts = Object.entries(customers)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => `<option value="${id}">${name}</option>`)
        .join('');

      const productOpts = Object.entries(products)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => `<option value="${id}">${name}</option>`)
        .join('');

      const preCustomer = uiDefaults.customerId || '';

      md.innerHTML = `
        <h2 style="color:#8b5cf6">📅 Cambio Masivo de Plazos OT</h2>
        <div class="sa-wod-filters">
          <select id="sa-wod-customer">
            <option value="">Cliente (todos)</option>
            ${customerOpts}
          </select>
          <input type="text" id="sa-wod-pn" placeholder="Número de parte...">
          <select id="sa-wod-product">
            <option value="">Producto (todos)</option>
            ${productOpts}
          </select>
          <input type="text" id="sa-wod-ro" placeholder="Orden de venta...">
          <input type="text" id="sa-wod-name" placeholder="Nombre lote...">
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <label style="font-size:12px;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="sa-wod-selall" checked> Seleccionar todo
            <span id="sa-wod-count" style="color:#cbd5e1;font-weight:600"></span>
          </label>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:12px;color:#94a3b8">Nueva fecha:</label>
            <input type="date" id="sa-wod-date" style="padding:5px 10px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:13px">
          </div>
        </div>
        <div class="sa-wod-grid" id="sa-wod-grid"></div>
        <div class="sa-wod-bar">
          <div id="sa-wod-status" style="font-size:12px;color:#94a3b8"></div>
          <div style="display:flex;gap:10px">
            <button class="sa-wod-btn sa-wod-btn-cancel" id="sa-wod-cancel">CANCELAR</button>
            <button class="sa-wod-btn sa-wod-btn-exec" id="sa-wod-exec" disabled>APLICAR FECHA</button>
          </div>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      // Pre-set customer filter from URL
      if (preCustomer) {
        document.getElementById('sa-wod-customer').value = preCustomer;
      }

      const selected = new Set(wos.map(wo => wo.id));
      let filteredWOs = wos;

      function getFilters() {
        const cust = document.getElementById('sa-wod-customer').value;
        const pn = document.getElementById('sa-wod-pn').value.trim();
        const prod = document.getElementById('sa-wod-product').value;
        const ro = document.getElementById('sa-wod-ro').value.trim();
        const name = document.getElementById('sa-wod-name').value.trim();
        return {
          customerId: cust ? parseInt(cust) : null,
          partNumber: pn || null,
          productId: prod ? parseInt(prod) : null,
          receivedOrder: ro || null,
          woName: name || null
        };
      }

      function renderCards() {
        const filters = getFilters();
        filteredWOs = applyFilters(wos, filters, pnCache);
        const grid = document.getElementById('sa-wod-grid');

        grid.innerHTML = filteredWOs.map(wo => {
          const pns = (wo.partNumberWorkOrdersByWorkOrderId?.nodes || []);
          const pnHTML = pns.map(pnwo => {
            const pn = pnCache[pnwo.partNumberId];
            if (!pn) return '';
            const labelsHTML = pn.labels.map(l =>
              `<span class="wo-label" style="background:${l.color}">${l.name}</span>`
            ).join('');
            return `<div class="wo-pn">${pn.name} ${labelsHTML}</div>`;
          }).join('');

          const roName = wo.receivedOrderByReceivedOrderId?.name || '';
          const roDisplay = roName ? `<div class="wo-ro">${roName}</div>` : '';
          const isSelected = selected.has(wo.id);

          return `<div class="sa-wod-card ${isSelected ? 'selected' : ''}" data-id="${wo.id}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="wo-num">OT-${wo.idInDomain}</span>
              <input type="checkbox" class="sa-wod-cb" data-id="${wo.id}" ${isSelected ? 'checked' : ''}>
            </div>
            ${roDisplay}
            ${pnHTML}
            <div class="wo-date">📅 ${formatDate(wo.deadline)}</div>
          </div>`;
        }).join('');

        updateCounts();
      }

      function updateCounts() {
        const visibleSelected = filteredWOs.filter(wo => selected.has(wo.id)).length;
        document.getElementById('sa-wod-count').textContent = `(${visibleSelected} de ${filteredWOs.length})`;

        const dateVal = document.getElementById('sa-wod-date').value;
        const execBtn = document.getElementById('sa-wod-exec');
        execBtn.disabled = visibleSelected === 0 || !dateVal;
        execBtn.textContent = `APLICAR FECHA (${visibleSelected})`;

        document.getElementById('sa-wod-selall').checked = visibleSelected === filteredWOs.length && filteredWOs.length > 0;
      }

      // Event: card click or checkbox
      document.getElementById('sa-wod-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.sa-wod-card');
        if (!card) return;
        const id = parseInt(card.dataset.id);
        const cb = card.querySelector('.sa-wod-cb');
        if (e.target !== cb) {
          // Toggle from card click
          if (selected.has(id)) { selected.delete(id); cb.checked = false; card.classList.remove('selected'); }
          else { selected.add(id); cb.checked = true; card.classList.add('selected'); }
        } else {
          // Toggle from checkbox
          if (cb.checked) { selected.add(id); card.classList.add('selected'); }
          else { selected.delete(id); card.classList.remove('selected'); }
        }
        updateCounts();
      });

      // Select all toggle
      document.getElementById('sa-wod-selall').addEventListener('change', (e) => {
        filteredWOs.forEach(wo => {
          if (e.target.checked) selected.add(wo.id);
          else selected.delete(wo.id);
        });
        renderCards();
      });

      // Filter events
      let filterTimeout;
      const onFilter = () => {
        clearTimeout(filterTimeout);
        filterTimeout = setTimeout(renderCards, 200);
      };
      document.getElementById('sa-wod-customer').addEventListener('change', renderCards);
      document.getElementById('sa-wod-product').addEventListener('change', renderCards);
      document.getElementById('sa-wod-pn').addEventListener('input', onFilter);
      document.getElementById('sa-wod-ro').addEventListener('input', onFilter);
      document.getElementById('sa-wod-name').addEventListener('input', onFilter);
      document.getElementById('sa-wod-date').addEventListener('change', updateCounts);

      // Cancel
      document.getElementById('sa-wod-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      // Execute
      document.getElementById('sa-wod-exec').onclick = () => {
        const dateVal = document.getElementById('sa-wod-date').value;
        const selectedIds = filteredWOs.filter(wo => selected.has(wo.id)).map(wo => wo.id);
        ov.parentNode.removeChild(ov);
        resolve({ selectedIds, newDeadline: dateVal });
      };

      // Initial render
      renderCards();
    });
  }

  // ══════════════════════════════════════════
  // ORCHESTRATOR
  // ══════════════════════════════════════════

  async function run() {
    log('=== CAMBIO DE PLAZOS OT ===');

    // Parse URL filters for server-side filtering
    const { serverFilters, uiDefaults } = parseURLFilters();

    // Phase 1: Load WOs with server filters
    showProgress('Cargando órdenes de trabajo...');
    const wos = await fetchAllActiveWOs(serverFilters, (msg) => showProgress(msg));
    log(`OTs cargadas: ${wos.length}${Object.keys(serverFilters).length ? ' (filtradas por URL)' : ''}`);

    if (!wos.length) {
      hideProgress();
      log('Sin OTs activas');
      return { error: 'Sin OTs activas' };
    }

    // Phase 2: Enrich with PN data (only for loaded WOs)
    showProgress('Cargando números de parte...');
    const pnCache = await enrichWithPNData(wos, (msg) => showProgress(msg));
    hideProgress();

    // Phase 3: Show UI
    const choice = await showMainUI(wos, pnCache, uiDefaults);
    if (choice.cancelled) return { cancelled: true };

    const { selectedIds, newDeadline } = choice;
    log(`OTs seleccionadas: ${selectedIds.length}`);
    log(`Nueva fecha: ${newDeadline}`);

    // Phase 4: Apply deadline
    showProgress(`Actualizando ${selectedIds.length} OTs...`);

    const deadline = new Date(newDeadline + 'T12:00:00.000Z').toISOString();
    const BATCH = 50;
    let updated = 0;
    const errors = [];

    for (let i = 0; i < selectedIds.length; i += BATCH) {
      const batch = selectedIds.slice(i, i + BATCH);
      const input = batch.map(id => ({ id, deadline }));
      try {
        await api().query('CreateUpdateWorkOrdersChecked', { input }, 'CreateUpdateWorkOrdersChecked');
        updated += batch.length;
        showProgress(`Actualizadas: ${updated}/${selectedIds.length}`);
      } catch (e) {
        const errMsg = `Batch ${i}-${i + batch.length}: ${String(e).substring(0, 150)}`;
        errors.push(errMsg);
        warn(errMsg);
      }
    }

    hideProgress();

    // Phase 5: Summary
    log(`\n=== RESULTADO ===`);
    log(`Actualizadas: ${updated}`);
    log(`Errores: ${errors.length}`);

    showSummary(updated, errors);
    return { updated, errors: errors.length };
  }

  function showSummary(updated, errors) {
    ensureStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-wod-overlay';
    const md = document.createElement('div');
    md.className = 'sa-wod-modal';
    md.style.maxWidth = '400px';

    const icon = errors.length > 0 ? '⚠️' : '✅';
    const color = errors.length > 0 ? '#f59e0b' : '#4ade80';

    let errHTML = '';
    if (errors.length > 0) {
      errHTML = `<div style="margin-top:12px;font-size:11px;color:#fca5a5">${errors.slice(0, 10).join('<br>')}</div>`;
    }

    md.innerHTML = `
      <h2 style="color:${color}">${icon} Plazos Actualizados</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0">
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#4ade80">${updated}</div>
          <div style="font-size:11px;color:#94a3b8">OTs actualizadas</div>
        </div>
        <div style="background:#0f172a;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#ef4444">${errors.length}</div>
          <div style="font-size:11px;color:#94a3b8">Errores</div>
        </div>
      </div>
      ${errHTML}
      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button class="sa-wod-btn sa-wod-btn-exec" id="sa-wod-close">CERRAR</button>
      </div>`;

    ov.appendChild(md);
    document.body.appendChild(ov);
    document.getElementById('sa-wod-close').onclick = () => ov.parentNode.removeChild(ov);
  }

  return { run };
})();

if (typeof window !== 'undefined') window.WODeadlineChanger = WODeadlineChanger;
