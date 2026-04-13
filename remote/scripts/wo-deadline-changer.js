// Steelhead WO Deadline Changer
// Bulk-update work order deadlines with filters
// Depends on: SteelheadAPI

const WODeadlineChanger = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  function labelTextColor(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1e293b' : '#fff';
  }

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

  async function fetchWOLabels() {
    const data = await api().query('AllLabels', { condition: { forWorkOrder: true } }, 'AllLabels');
    return (data?.allLabels?.nodes || []).map(l => ({
      id: l.id,
      name: l.name,
      color: l.color || '#475569'
    }));
  }

  function extractWOLabels(wo, labelCatalog) {
    const nodes = wo.workOrderLabelsByWorkOrderId?.nodes || [];
    return nodes.map(n => {
      if (n.labelByLabelId) {
        return { id: n.labelByLabelId.id, name: n.labelByLabelId.name, color: n.labelByLabelId.color || '#475569' };
      }
      const labelId = n.labelId || n.id;
      const found = labelCatalog.find(l => l.id === labelId);
      return found || { id: labelId, name: `Label ${labelId}`, color: '#475569' };
    });
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

      if (filters.processName && wo.recipeNodeByRecipeId?.name !== filters.processName) return false;

      if (filters.receivedOrder) {
        const q = filters.receivedOrder.toLowerCase();
        const roName = wo.receivedOrderByReceivedOrderId?.name || '';
        if (!roName.toLowerCase().includes(q)) return false;
      }

      if (filters.woName) {
        const q = filters.woName.toLowerCase();
        if (!(wo.name || '').toLowerCase().includes(q)) return false;
      }

      if (filters.deadlineDate) {
        const woDate = wo.deadline ? wo.deadline.substring(0, 10) : '';
        if (woDate !== filters.deadlineDate) return false;
      }

      if (filters.createdFrom) {
        const woCreated = wo.createdAt ? wo.createdAt.substring(0, 10) : '';
        if (woCreated < filters.createdFrom) return false;
      }

      if (filters.createdTo) {
        const woCreated = wo.createdAt ? wo.createdAt.substring(0, 10) : '';
        if (woCreated > filters.createdTo) return false;
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
      .sa-wod-card .wo-label{display:inline-block;padding:0 6px;border-radius:8px;font-size:9px;font-weight:600;margin:1px 2px;white-space:nowrap}
      .sa-wod-card .wo-date{color:#94a3b8;margin-top:3px}
      .sa-wod-bar{display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:12px}
      .sa-wod-btn{padding:8px 20px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
      .sa-wod-btn-cancel{background:#475569;color:#e2e8f0}
      .sa-wod-btn-exec{background:#8b5cf6;color:white}
      .sa-wod-btn-exec:disabled{opacity:0.4;cursor:default}
      .sa-wod-progress{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-wod-progress-box{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;text-align:center;min-width:300px}
      .sa-wod-labels-section{margin-bottom:8px}
      .sa-wod-labels-section .section-title{font-size:11px;color:#94a3b8;margin-bottom:4px}
      .sa-wod-label-chip{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;margin:2px 3px;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s,opacity 0.15s;opacity:0.6}
      .sa-wod-label-chip:hover{opacity:0.85}
      .sa-wod-label-chip.chip-selected{opacity:1;border-color:#fff}
      .sa-wod-label-chip.chip-remove.chip-selected{opacity:1;border-color:#ef4444}
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

  async function fetchDropdownOptions() {
    // Fetch ALL active WOs (for counts + dropdown extraction) and products in parallel
    const [prodResult, woCountResult] = await Promise.allSettled([
      (async () => {
        const d = await api().query('SearchProducts', {
          searchQuery: '', first: 500, offset: 0, includeArchived: 'NO'
        }, 'SearchProducts');
        return d?.searchProducts?.nodes || d?.pagedData?.nodes || [];
      })(),
      fetchAllActiveWOs({}, null)
    ]);

    const allProducts = prodResult.status === 'fulfilled' ? prodResult.value : [];
    const allWOs = woCountResult.status === 'fulfilled' ? woCountResult.value : [];

    // Extract customers, processes, and counts from ALL active WOs
    const customerMap = {};
    const processMap = {};
    const countByCustomer = {};
    const countByProduct = {};
    const countByProcess = {};

    for (const wo of allWOs) {
      const c = wo.customerByCustomerId;
      if (c && c.id) {
        customerMap[c.id] = c.name;
        countByCustomer[c.id] = (countByCustomer[c.id] || 0) + 1;
      }
      const p = wo.productByProductId;
      if (p && p.id) {
        countByProduct[p.id] = (countByProduct[p.id] || 0) + 1;
      }
      const r = wo.recipeNodeByRecipeId;
      if (r && r.name) {
        processMap[r.name] = r.name;
        countByProcess[r.name] = (countByProcess[r.name] || 0) + 1;
      }
    }

    const allCustomers = Object.entries(customerMap).map(([id, name]) => ({ id: parseInt(id), name }));
    const allProcesses = Object.keys(processMap).map(name => ({ id: name, name }));

    return { allCustomers, allProducts, allProcesses, countByCustomer, countByProduct, countByProcess };
  }

  async function showMainUI(wos, pnCache, uiDefaults, dropdownCache, woLabelCatalog) {

    return new Promise((resolve) => {
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'sa-wod-overlay';
      const md = document.createElement('div');
      md.className = 'sa-wod-modal';

      const { allCustomers, allProducts, allProcesses, countByCustomer, countByProduct, countByProcess } = dropdownCache;

      const addChipsHTML = woLabelCatalog.map(l => {
        const fg = labelTextColor(l.color);
        return `<span class="sa-wod-label-chip" data-label-id="${l.id}" data-action="add" style="background:${l.color};color:${fg}">${l.name}</span>`;
      }).join('');

      const seenCust = new Set();
      const customerOpts = allCustomers
        .filter(c => { if (seenCust.has(c.id)) return false; seenCust.add(c.id); return true; })
        .filter(c => countByCustomer[c.id])
        .sort((a, b) => (countByCustomer[b.id] || 0) - (countByCustomer[a.id] || 0))
        .map(c => `<option value="${c.id}">${c.name} (${countByCustomer[c.id] || 0})</option>`)
        .join('');

      const seenProd = new Set();
      const productOpts = allProducts
        .filter(p => { if (seenProd.has(p.id)) return false; seenProd.add(p.id); return true; })
        .filter(p => countByProduct[p.id])
        .sort((a, b) => (countByProduct[b.id] || 0) - (countByProduct[a.id] || 0))
        .map(p => `<option value="${p.id}">${p.name} (${countByProduct[p.id] || 0})</option>`)
        .join('');

      const processOpts = allProcesses
        .filter(p => countByProcess[p.id])
        .sort((a, b) => (countByProcess[b.id] || 0) - (countByProcess[a.id] || 0))
        .map(p => `<option value="${p.id}">${p.name} (${countByProcess[p.id] || 0})</option>`)
        .join('');

      const preCustomer = uiDefaults.customerId || '';

      md.innerHTML = `
        <h2 style="color:#8b5cf6">⚙️ Gestión Masiva de OT</h2>
        <div class="sa-wod-filters">
          <select id="sa-wod-customer">
            <option value="">Cliente (todos)</option>
            ${customerOpts}
          </select>
          <button id="sa-wod-reload" class="sa-wod-btn" style="padding:4px 12px;font-size:11px;background:#334155;color:#e2e8f0;display:none" title="Recargar datos del servidor con nuevo filtro">🔄 Recargar</button>
          <input type="text" id="sa-wod-pn" placeholder="Número de parte...">
          <select id="sa-wod-product">
            <option value="">Producto (todos)</option>
            ${productOpts}
          </select>
          <select id="sa-wod-process">
            <option value="">Proceso (todos)</option>
            ${processOpts}
          </select>
          <input type="text" id="sa-wod-ro" placeholder="Orden de venta...">
          <input type="text" id="sa-wod-name" placeholder="Nombre lote...">
        </div>
        <div class="sa-wod-filters" style="margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:11px;color:#94a3b8;white-space:nowrap">Fecha límite:</label>
            <input type="date" id="sa-wod-deadline-filter" style="padding:4px 8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:11px;color-scheme:dark">
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:11px;color:#94a3b8;white-space:nowrap">Creada desde:</label>
            <input type="date" id="sa-wod-created-from" style="padding:4px 8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:11px;color-scheme:dark">
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:11px;color:#94a3b8;white-space:nowrap">hasta:</label>
            <input type="date" id="sa-wod-created-to" style="padding:4px 8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:11px;color-scheme:dark">
          </div>
        </div>
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

      // Track which customer was loaded server-side
      const loadedCustomerId = preCustomer ? String(preCustomer) : '';

      const selected = new Set(wos.map(wo => wo.id));
      let filteredWOs = wos;

      const labelsToAdd = new Set();
      const labelsToRemove = new Set();

      function rebuildRemoveChips() {
        const presentLabels = new Map();
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
        for (const id of labelsToRemove) {
          if (!presentLabels.has(id)) labelsToRemove.delete(id);
        }
      }

      function getFilters() {
        const cust = document.getElementById('sa-wod-customer').value;
        const pn = document.getElementById('sa-wod-pn').value.trim();
        const prod = document.getElementById('sa-wod-product').value;
        const proc = document.getElementById('sa-wod-process').value;
        const ro = document.getElementById('sa-wod-ro').value.trim();
        const name = document.getElementById('sa-wod-name').value.trim();
        const deadlineDate = document.getElementById('sa-wod-deadline-filter').value;
        const createdFrom = document.getElementById('sa-wod-created-from').value;
        const createdTo = document.getElementById('sa-wod-created-to').value;
        return {
          customerId: cust ? parseInt(cust) : null,
          partNumber: pn || null,
          productId: prod ? parseInt(prod) : null,
          processName: proc || null,
          receivedOrder: ro || null,
          woName: name || null,
          deadlineDate: deadlineDate || null,
          createdFrom: createdFrom || null,
          createdTo: createdTo || null
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
            const labelsHTML = pn.labels.map(l => {
              const fg = labelTextColor(l.color);
              return `<span class="wo-label" style="background:${l.color};color:${fg}">${l.name}</span>`;
            }).join('');
            return `<div class="wo-pn">${pn.name} ${labelsHTML}</div>`;
          }).join('');

          const roName = wo.receivedOrderByReceivedOrderId?.name || '';
          const roDisplay = roName ? `<div class="wo-ro">${roName}</div>` : '';
          const isSelected = selected.has(wo.id);

          const woLabels = extractWOLabels(wo, woLabelCatalog);
          const woLabelsHTML = woLabels.length > 0
            ? `<div style="margin-top:3px">${woLabels.map(l => {
                const fg = labelTextColor(l.color);
                return `<span class="wo-label" style="background:${l.color};color:${fg}">${l.name}</span>`;
              }).join('')}</div>`
            : '';

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
        }).join('');

        rebuildRemoveChips();
        updateCounts();
      }

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
      const checkReload = () => {
        const custVal = document.getElementById('sa-wod-customer').value;
        const reloadBtn = document.getElementById('sa-wod-reload');
        // Show reload if customer changed from what was loaded server-side
        reloadBtn.style.display = custVal !== loadedCustomerId ? '' : 'none';
      };
      document.getElementById('sa-wod-customer').addEventListener('change', () => { checkReload(); renderCards(); });
      document.getElementById('sa-wod-product').addEventListener('change', renderCards);
      document.getElementById('sa-wod-process').addEventListener('change', renderCards);

      // Reload button
      document.getElementById('sa-wod-reload').onclick = () => {
        const custVal = document.getElementById('sa-wod-customer').value;
        const newFilters = {};
        if (custVal) newFilters.customerIdFilter = [parseInt(custVal)];
        ov.parentNode.removeChild(ov);
        resolve({ reload: newFilters });
      };
      document.getElementById('sa-wod-pn').addEventListener('input', onFilter);
      document.getElementById('sa-wod-ro').addEventListener('input', onFilter);
      document.getElementById('sa-wod-name').addEventListener('input', onFilter);
      document.getElementById('sa-wod-deadline-filter').addEventListener('change', renderCards);
      document.getElementById('sa-wod-created-from').addEventListener('change', renderCards);
      document.getElementById('sa-wod-created-to').addEventListener('change', renderCards);
      document.getElementById('sa-wod-date').addEventListener('change', updateCounts);

      // Cancel
      document.getElementById('sa-wod-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      // Execute
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

      // Initial render
      renderCards();
    });
  }

  // ══════════════════════════════════════════
  // ORCHESTRATOR
  // ══════════════════════════════════════════

  async function loadData(serverFilters, existingPnCache) {
    showProgress('Cargando órdenes de trabajo...');
    const wos = await fetchAllActiveWOs(serverFilters, (msg) => showProgress(msg));
    log(`OTs cargadas: ${wos.length}`);

    showProgress('Cargando números de parte...');
    const pnCache = existingPnCache || {};
    // Only fetch PNs we don't already have cached
    const uncached = [];
    for (const wo of wos) {
      for (const pnwo of (wo.partNumberWorkOrdersByWorkOrderId?.nodes || [])) {
        if (pnwo.partNumberId && !pnCache[pnwo.partNumberId]) uncached.push(pnwo.partNumberId);
      }
    }
    if (uncached.length > 0) {
      const newPns = await enrichWithPNData(
        wos.filter(wo => (wo.partNumberWorkOrdersByWorkOrderId?.nodes || []).some(p => uncached.includes(p.partNumberId))),
        (msg) => showProgress(msg)
      );
      Object.assign(pnCache, newPns);
    }
    hideProgress();
    return { wos, pnCache };
  }

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
              const newIds = labelsToAdd.filter(id => !currentIds.has(id));
              for (const labelId of newIds) {
                await api().query('CreateWorkOrderLabel', { workOrderId: wo.id, labelId }, 'CreateWorkOrderLabel');
              }
              added += newIds.length;
            }
          } else {
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

  async function run() {
    log('=== CAMBIO DE PLAZOS OT ===');

    const { serverFilters, uiDefaults } = parseURLFilters();
    let currentServerFilters = serverFilters;
    let currentUiDefaults = { ...uiDefaults };
    let pnCache = {};
    let finalChoice = null;

    // Fetch dropdown options once (shared across reloads)
    showProgress('Cargando catálogos...');
    const dropdownCache = await fetchDropdownOptions();

    showProgress('Cargando etiquetas...');
    const woLabelCatalog = await fetchWOLabels();

    // Load → show UI → reload loop
    while (true) {
      const data = await loadData(currentServerFilters, pnCache);
      pnCache = data.pnCache;

      if (!data.wos.length) {
        hideProgress();
        log('Sin OTs activas con estos filtros');
        return { error: 'Sin OTs activas' };
      }

      const choice = await showMainUI(data.wos, pnCache, currentUiDefaults, dropdownCache, woLabelCatalog);

      if (choice.cancelled) return { cancelled: true };
      if (choice.reload) {
        currentServerFilters = choice.reload;
        currentUiDefaults = { ...currentUiDefaults, customerId: currentServerFilters.customerIdFilter?.[0] || '' };
        log(`Recargando con filtro: ${JSON.stringify(currentServerFilters)}`);
        continue;
      }

      finalChoice = choice;
      break;
    }

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
  }

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

  return { run };
})();

if (typeof window !== 'undefined') window.WODeadlineChanger = WODeadlineChanger;
