// Steelhead Automator v2 — Popup Logic
// Data-driven multi-app UI rendered from config.apps

document.addEventListener('DOMContentLoaded', () => {
  let config = null;
  let currentApp = null;
  let viewMode = 'grid'; // 'grid' | 'list'
  let currentUser = null; // { id, name, isAdmin, isSuperUser, ... }

  const views = { menu: 'view-menu', app: 'view-app', results: 'view-results', settings: 'view-settings' };
  const fileInput = document.getElementById('file-input');
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  init();

  // ── Init ──
  async function init() {
    initTheme();
    initViewMode();
    config = await sendToBackground('get-config');
    try {
      currentUser = await sendToBackground('get-current-user');
      if (currentUser?.error) { console.warn('[SA] User fetch failed:', currentUser.error); currentUser = null; }
    } catch (_) { currentUser = null; }
    await checkStatus();
    renderAppMenu();
    checkExtensionUpdate();

    document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('btn-view-toggle').addEventListener('click', toggleViewMode);

    document.getElementById('btn-rec').addEventListener('click', async () => {
      try {
        const result = await sendToBackground('toggle-scan');
        const scanning = result?.started === true;
        updateScanIndicator(scanning);
        updateRecButton(scanning);
      } catch (e) { /* ignore */ }
    });

    document.getElementById('btn-settings').addEventListener('click', () => {
      loadSettingsView();
      showView('settings');
    });

    document.getElementById('settings-back').addEventListener('click', goToMenu);

    document.getElementById('btn-save-api-key').addEventListener('click', saveApiKey);

    document.getElementById('btn-copy-log').addEventListener('click', async () => {
      const btn = document.getElementById('btn-copy-log');
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.url?.includes('app.gosteelhead.com')) { alert('No hay pestaña activa de Steelhead.'); return; }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id }, world: 'MAIN',
          func: () => {
            const saved = localStorage.getItem('sa_last_log');
            if (!saved) return null;
            return JSON.parse(saved).join('\n');
          }
        });
        const logText = results?.[0]?.result;
        if (!logText) { alert('No hay log guardado.'); return; }
        await navigator.clipboard.writeText(logText);
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      } catch (e) { alert('Error: ' + e.message); }
    });

    document.getElementById('btn-reload').addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url?.includes('app.gosteelhead.com')) { chrome.tabs.reload(tabs[0].id); window.close(); }
        else alert('No hay pestaña activa de Steelhead.');
      });
    });

    document.getElementById('app-back').addEventListener('click', goToMenu);
    document.getElementById('btn-stop-scan').addEventListener('click', async () => {
      await sendToBackground('toggle-scan');
      updateScanIndicator(false);
      checkStatus();
    });
    document.getElementById('results-back').addEventListener('click', () => {
      if (currentApp) showView('app'); else goToMenu();
    });

    fileInput.addEventListener('change', async (e) => {
      if (!e.target.files.length) return;
      try {
        showProgress('Leyendo archivo...', 5);
        const csvText = await readFileAsText(e.target.files[0]);
        showProgress('Ejecutando pipeline...', 15);
        const result = await sendToBackground('run-csv', { csvText });
        if (result?.error) showProgress('Error: ' + result.error, 0);
        else showProgress('Pipeline ejecutado. Revisa Steelhead.', 100);
      } catch (err) {
        alert('Error: ' + err.message); hideProgress();
      } finally { fileInput.value = ''; }
    });
  }

  // ── Views ──
  function showView(name) {
    Object.values(views).forEach(id => document.getElementById(id).classList.remove('active'));
    document.getElementById(views[name]).classList.add('active');
  }

  function goToMenu() {
    currentApp = null;
    showView('menu');
    hideProgress();
  }

  // ── App Menu ──
  async function renderAppMenu() {
    const menuWrap = document.querySelector('.app-menu-wrap');
    // Remove existing menu content
    const oldMenu = menuWrap.querySelector('.app-menu, .app-grid, .app-list');
    if (oldMenu) oldMenu.remove();

    const apps = config?.apps || [];
    // Permission-based filtering using Steelhead managed permissions
    let userPermissions = currentUser?.managedPermissions || null;
    if (!userPermissions) {
      try {
        const cached = await new Promise(r => chrome.storage.local.get('sa_user_permissions', d => r(d.sa_user_permissions || null)));
        userPermissions = cached;
      } catch (_) {}
    }
    const { sa_app_permissions_overrides: permOverrides } = await new Promise(r =>
      chrome.storage.local.get('sa_app_permissions_overrides', d => r(d)));
    const visibleApps = apps.filter(app => {
      const req = permOverrides?.[app.id] ?? app.requiredPermissions;
      if (!req || req.length === 0) return true;
      if (!userPermissions) return true;
      return req.every(p => userPermissions.includes(p));
    });

    if (viewMode === 'grid') {
      renderGridMenu(menuWrap, visibleApps);
    } else {
      renderListMenu(menuWrap, visibleApps);
    }

    // Update scroll fade
    const fade = document.getElementById('scroll-fade');
    const scrollEl = menuWrap.querySelector('.app-grid, .app-list');
    if (scrollEl && fade) {
      const updateFade = () => {
        const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight;
        const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
        fade.classList.toggle('visible', scrollable && !atBottom);
      };
      scrollEl.addEventListener('scroll', updateFade);
      setTimeout(updateFade, 0);
    }
  }

  function renderGridMenu(container, apps) {
    const grid = document.createElement('div');
    grid.className = 'app-grid';

    for (const app of apps) {
      const tile = document.createElement('div');
      tile.className = 'app-tile';
      tile.innerHTML = `
        <div class="tile-icon">${app.icon || '📦'}</div>
        <div class="tile-name">${app.name}</div>`;
      tile.addEventListener('click', () => selectApp(app));
      grid.appendChild(tile);
    }

    container.insertBefore(grid, document.getElementById('scroll-fade'));
  }

  function renderListMenu(container, apps) {
    const list = document.createElement('div');
    list.className = 'app-list';

    // Group by category, preserving order of first appearance
    const categories = [];
    const catMap = new Map();
    for (const app of apps) {
      const cat = app.category || 'Otros';
      if (!catMap.has(cat)) {
        catMap.set(cat, []);
        categories.push(cat);
      }
      catMap.get(cat).push(app);
    }

    for (const cat of categories) {
      const header = document.createElement('div');
      header.className = 'app-list-cat';
      header.textContent = cat;
      list.appendChild(header);

      for (const app of catMap.get(cat)) {
        const row = document.createElement('div');
        row.className = 'app-list-row';
        row.innerHTML = `
          <span class="row-icon">${app.icon || '📦'}</span>
          <span class="row-name">${app.name}</span>
          <span class="row-chevron">›</span>`;
        row.addEventListener('click', () => selectApp(app));
        list.appendChild(row);
      }
    }

    container.insertBefore(list, document.getElementById('scroll-fade'));
  }

  // ── App View ──
  async function selectApp(app) {
    currentApp = app;
    document.getElementById('app-title').textContent = app.name;
    const container = document.getElementById('app-actions');
    container.innerHTML = '';

    // Check scanner state to set correct button label
    let scanActive = false;
    if (app.id === 'hash-scanner') {
      try {
        const s = await sendToBackground('check-scan-status');
        scanActive = s?.scanning;
      } catch (_) {}
    }

    for (const action of (app.actions || [])) {
      const btn = document.createElement('button');
      btn.className = action.type === 'primary' ? 'btn btn-primary' : 'btn';
      btn.dataset.actionId = action.id;

      let label = action.label;
      let sublabel = action.sublabel;
      let icon = action.icon || '▸';
      // Dynamic label for toggle-scan
      if (action.id === 'toggle-scan' && scanActive) {
        label = 'Detener Captura';
        sublabel = 'Pausar interceptación';
        icon = '⏹️';
      }

      btn.innerHTML = `
        <span class="btn-icon">${icon}</span>
        <span class="btn-label">${label}<small>${sublabel || ''}</small></span>`;
      btn.addEventListener('click', () => handleAction(action));
      container.appendChild(btn);
    }

    showView('app');
  }

  // ── Action Handlers ──
  async function handleAction(action) {
    switch (action.handler) {
      case 'file-picker':
        fileInput.click();
        break;

      case 'open-url': {
        const url = action.url === 'templateUrl' ? config?.templateUrl : action.url;
        if (url) chrome.tabs.create({ url });
        else alert('URL no configurada.');
        break;
      }

      case 'message': {
        try {
          const btn = event?.target?.closest('.btn');
          if (btn) btn.disabled = true;
          showProgress('Procesando...', 20);

          const result = await sendToBackground(action.message);

          if (result?.error) {
            alert('Error: ' + result.error);
            hideProgress();
          } else if (result?.results || result?.operations) {
            renderResults(action.message, result);
            showView('results');
            hideProgress();
          } else if (action.message === 'toggle-scan') {
            // Update scan indicator + toggle button label
            const scanning = result?.started === true;
            updateScanIndicator(scanning);
            updateRecButton(scanning);
            showProgress(result.message || (scanning ? 'Capturando...' : 'Detenido.'), scanning ? 50 : 100);
            // Update the button text
            const toggleBtn = document.querySelector(`[data-action-id="toggle-scan"]`);
            if (toggleBtn) {
              toggleBtn.querySelector('.btn-label').innerHTML = scanning
                ? '⏹️ Detener Captura<small>Pausar interceptación</small>'
                : '🔍 Iniciar Captura<small>Interceptar requests GraphQL</small>';
            }
          } else if (result?.started) {
            showProgress(result.message || 'Ejecutando...', 50);
          } else {
            showProgress('Completado.', 100);
          }

          if (btn) btn.disabled = false;
        } catch (err) {
          alert('Error: ' + err.message);
          hideProgress();
        }
        break;
      }
    }
  }

  // ── Results Rendering ──
  function renderResults(type, data) {
    const container = document.getElementById('results-content');
    document.getElementById('results-title').textContent =
      type === 'view-scan-results' ? 'Operaciones Capturadas' :
      type === 'show-api-knowledge' ? 'APIs Conocidas' :
      type === 'view-load-history' ? 'Historial de Cargas' : 'Resultados';

    if (type === 'view-scan-results') {
      renderScanResults(container, data);
    } else if (type === 'show-api-knowledge') {
      renderAPIKnowledge(container, data);
    } else if (type === 'view-load-history') {
      renderLoadHistory(container, data);
    } else {
      container.innerHTML = `<pre style="font-size:10px;white-space:pre-wrap">${JSON.stringify(data, null, 2)}</pre>`;
    }
  }

  function renderScanResults(container, data) {
    const ops = data.operations || data;
    const entries = Object.entries(ops);
    const stats = data.stats || {
      total: entries.length,
      known: entries.filter(([, v]) => v.status === 'known').length,
      new: entries.filter(([, v]) => v.status === 'new').length,
      changed: entries.filter(([, v]) => v.status === 'changed').length
    };

    container.innerHTML = `
      <div class="results-stats">
        <span class="results-stat total">${stats.total} total</span>
        <span class="results-stat known">${stats.known} conocidas</span>
        <span class="results-stat new">${stats.new} nuevas</span>
        <span class="results-stat changed">${stats.changed || 0} cambiadas</span>
      </div>
      <ul class="op-list">
        ${entries.map(([name, info]) => `
          <li class="op-item">
            <span class="op-name">${name}</span>
            <span class="op-badge ${info.status}">${info.status}</span>
            <div class="op-meta">Hash: ${(info.hash || '').substring(0, 16)}... | x${info.count || 1}${info.configKey ? ' | config: ' + info.configKey : ''}</div>
          </li>`).join('')}
      </ul>`;
  }

  function renderAPIKnowledge(container, data) {
    const ops = data.operations || data;
    const summary = data.summary || {};

    const sourceColors = {
      'documentada': '#7b1fa2', 'documentada + escaneada': '#2e7d32',
      'config': '#1565c0', 'config + escaneada': '#0d9488',
      'escaneada': '#e65100'
    };

    container.innerHTML = `
      <div class="results-stats">
        <span class="results-stat total">${summary.total || ops.length} operaciones</span>
        <span class="results-stat" style="background:#fce4ec;color:#c62828">${summary.mutations || 0} mutations</span>
        <span class="results-stat" style="background:#e3f2fd;color:#1565c0">${summary.queries || 0} queries</span>
        ${summary.scanned ? `<span class="results-stat new">${summary.scanned} escaneadas</span>` : ''}
      </div>
      <ul class="op-list">
        ${(Array.isArray(ops) ? ops : []).map(op => `
          <li class="op-item">
            <span class="op-name">${op.operationName}</span>
            <span class="op-badge ${op.type}">${op.type}</span>
            <span class="op-badge" style="background:${sourceColors[op.source] || '#999'}22;color:${sourceColors[op.source] || '#999'}">${op.source}</span>
            <div class="op-meta">${op.description || '(sin descripción)'}${op.scanCount ? ' | x' + op.scanCount : ''}</div>
            ${op.responseFields ? `<div class="op-meta" style="color:#0d9488">Campos: ${op.responseFields.slice(0, 5).join(', ')}${op.responseFields.length > 5 ? '...' : ''}</div>` : ''}
          </li>`).join('')}
      </ul>`;
  }

  // ── Settings ──
  async function loadSettingsView() {
    chrome.storage.local.get(['sa_claude_api_key'], (result) => {
      const key = result.sa_claude_api_key || '';
      const input = document.getElementById('input-api-key');
      const hint = document.getElementById('settings-key-hint');
      input.value = '';
      input.placeholder = key ? `••••••••${key.slice(-8)}` : 'sk-ant-api03-...';
      hint.textContent = key ? `Clave guardada · últimos 8 dígitos: ${key.slice(-8)}` : 'Sin clave configurada';
      document.getElementById('settings-save-msg').textContent = '';
    });

    // Show app permissions editor for users with WRITE_USER_PERMISSIONS
    const mgmtSection = document.getElementById('user-mgmt');
    if (mgmtSection) {
      const perms = currentUser?.managedPermissions || [];
      const canAdmin = currentUser?.isAdmin || perms.includes('WRITE_USER_PERMISSIONS');
      if (canAdmin) {
        mgmtSection.style.display = '';
        loadAppPermissionsEditor();
      } else {
        mgmtSection.style.display = 'none';
      }
    }

    // One-time cleanup of deprecated role overrides
    chrome.storage.local.remove('sa_role_overrides');
  }

  async function loadAppPermissionsEditor() {
    const container = document.getElementById('user-mgmt-content');
    container.innerHTML = '<div class="user-mgmt-loading">Cargando permisos...</div>';

    try {
      const apps = config?.apps || [];
      const overrides = await new Promise(r =>
        chrome.storage.local.get('sa_app_permissions_overrides', d => r(d.sa_app_permissions_overrides || {})));

      // Fetch permission catalog from Steelhead (or cached)
      let allPerms = [];
      try {
        const live = await sendToBackground('get-all-permissions');
        if (Array.isArray(live) && live.length > 0) allPerms = live;
      } catch (_) {}
      if (allPerms.length === 0) {
        const cached = await new Promise(r =>
          chrome.storage.local.get('sa_all_permissions', d => r(d.sa_all_permissions || [])));
        allPerms = cached;
      }

      const hasOverrides = Object.keys(overrides).length > 0;

      container.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'app-perms-editor';

      for (const app of apps) {
        const currentPerms = overrides[app.id] ?? app.requiredPermissions ?? [];
        const isOverridden = !!overrides[app.id];

        const row = document.createElement('div');
        row.className = 'app-perm-row';
        row.dataset.appId = app.id;

        const header = document.createElement('div');
        header.className = 'app-perm-header';
        header.innerHTML = '<span class="app-perm-icon">' + escapeHtml(app.icon) + '</span>' +
          '<span class="app-perm-name">' + escapeHtml(app.name) + '</span>' +
          (isOverridden ? '<span class="app-perm-badge">modificado</span>' : '');

        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'app-perm-chips';

        function renderChips() {
          const perms = overrides[app.id] ?? app.requiredPermissions ?? [];
          chipsWrap.innerHTML = '';
          for (const p of perms) {
            const chip = document.createElement('span');
            chip.className = 'perm-chip';
            chip.textContent = p;
            const x = document.createElement('button');
            x.className = 'perm-chip-x';
            x.textContent = '\u00d7';
            x.title = 'Quitar ' + p;
            x.addEventListener('click', async () => {
              const cur = overrides[app.id] ?? [...(app.requiredPermissions || [])];
              const updated = cur.filter(pp => pp !== p);
              overrides[app.id] = updated;
              await chrome.storage.local.set({ sa_app_permissions_overrides: overrides });
              renderChips();
              updateBadge();
            });
            chip.appendChild(x);
            chipsWrap.appendChild(chip);
          }
          // Add button
          const addBtn = document.createElement('button');
          addBtn.className = 'perm-add-btn';
          addBtn.textContent = '+ Agregar';
          addBtn.addEventListener('click', () => showPermDropdown(app, chipsWrap, addBtn));
          chipsWrap.appendChild(addBtn);
        }

        function updateBadge() {
          const badge = row.querySelector('.app-perm-badge');
          if (overrides[app.id]) {
            if (!badge) {
              const b = document.createElement('span');
              b.className = 'app-perm-badge';
              b.textContent = 'modificado';
              header.appendChild(b);
            }
          } else if (badge) {
            badge.remove();
          }
        }

        function showPermDropdown(app, chipsWrap, addBtn) {
          const existing = chipsWrap.querySelector('.perm-dropdown');
          if (existing) { existing.remove(); return; }
          const currentPerms = new Set(overrides[app.id] ?? app.requiredPermissions ?? []);
          const available = allPerms.filter(p => !currentPerms.has(p.permission));
          if (available.length === 0) return;

          const dd = document.createElement('div');
          dd.className = 'perm-dropdown';
          const search = document.createElement('input');
          search.className = 'perm-dropdown-search';
          search.placeholder = 'Buscar permiso...';
          dd.appendChild(search);

          const listEl = document.createElement('div');
          listEl.className = 'perm-dropdown-list';

          function renderList(filter) {
            listEl.innerHTML = '';
            const f = (filter || '').toUpperCase();
            const filtered = f ? available.filter(p => p.permission.includes(f) || (p.description || '').toUpperCase().includes(f)) : available.slice(0, 50);
            for (const p of filtered.slice(0, 50)) {
              const opt = document.createElement('div');
              opt.className = 'perm-dropdown-item';
              opt.innerHTML = '<strong>' + escapeHtml(p.permission) + '</strong>' +
                (p.description ? '<br><small>' + escapeHtml(p.description) + '</small>' : '');
              opt.addEventListener('click', async () => {
                const cur = overrides[app.id] ?? [...(app.requiredPermissions || [])];
                cur.push(p.permission);
                overrides[app.id] = cur;
                await chrome.storage.local.set({ sa_app_permissions_overrides: overrides });
                dd.remove();
                renderChips();
                updateBadge();
              });
              listEl.appendChild(opt);
            }
            if (filtered.length === 0) listEl.innerHTML = '<div class="perm-dropdown-empty">Sin resultados</div>';
          }

          search.addEventListener('input', () => renderList(search.value));
          renderList('');
          dd.appendChild(listEl);
          chipsWrap.insertBefore(dd, addBtn.nextSibling);
          search.focus();

          const closeOnOutside = (e) => { if (!dd.contains(e.target) && e.target !== addBtn) { dd.remove(); document.removeEventListener('click', closeOnOutside); } };
          setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
        }

        renderChips();
        row.appendChild(header);
        row.appendChild(chipsWrap);
        wrapper.appendChild(row);
      }

      // Restore defaults button
      if (hasOverrides) {
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'perm-restore-btn';
        restoreBtn.textContent = 'Restaurar defaults';
        restoreBtn.addEventListener('click', async () => {
          await chrome.storage.local.remove('sa_app_permissions_overrides');
          loadAppPermissionsEditor();
        });
        wrapper.appendChild(restoreBtn);
      }

      container.appendChild(wrapper);
    } catch (e) {
      container.innerHTML = '<div class="user-mgmt-loading">Error: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function saveApiKey() {
    const input = document.getElementById('input-api-key');
    const msg = document.getElementById('settings-save-msg');
    const key = input.value.trim();

    if (!key) {
      msg.textContent = 'Ingresa una clave primero.';
      msg.style.color = '#c62828';
      return;
    }

    chrome.storage.local.set({ sa_claude_api_key: key }, () => {
      input.value = '';
      const hint = document.getElementById('settings-key-hint');
      input.placeholder = `••••••••${key.slice(-8)}`;
      hint.textContent = `Clave guardada · últimos 8 dígitos: ${key.slice(-8)}`;
      msg.textContent = '¡Guardado!';
      msg.style.color = '';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    });
  }

  // ── Helpers ──
  function sendToBackground(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  async function checkStatus() {
    try {
      const status = await sendToBackground('get-status');
      document.getElementById('status-bar').classList.toggle('error', !status.connected);
      document.getElementById('status-text').textContent = status.connected ? '' : 'Sin conexión';
      const extVer = chrome.runtime.getManifest().version;
      const verEl = document.getElementById('version-text');
      const remoteVer = status.connected && status.version ? ` · r${status.version}` : '';
      verEl.textContent = `v${extVer}${remoteVer}`;
      verEl.title = `Extensión: v${extVer}\nScripts remotos: v${status.version}\nÚltima actualización catálogos: ${status.lastUpdated}`;

      // Check if scanner is active
      try {
        const scanStatus = await sendToBackground('check-scan-status');
        updateScanIndicator(scanStatus?.scanning);
        updateRecButton(scanStatus?.scanning);
      } catch (_) { updateScanIndicator(false); updateRecButton(false); }
    } catch (err) {
      document.getElementById('status-bar').classList.add('error');
      document.getElementById('status-text').textContent = err.message;
    }
  }

  function updateScanIndicator(active) {
    document.getElementById('scan-indicator').classList.toggle('active', !!active);
  }

  function updateRecButton(active) {
    const btn = document.getElementById('btn-rec');
    if (!btn) return;
    btn.classList.toggle('recording', !!active);
    btn.textContent = active ? '⏹' : '🔴';
    btn.title = active ? 'Detener captura' : 'Iniciar captura';
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Error leyendo archivo'));
      r.readAsText(file, 'UTF-8');
    });
  }

  function showProgress(text, percent) {
    const c = document.getElementById('progress-container');
    c.style.display = 'block';
    document.getElementById('progress-fill').style.width = percent + '%';
    document.getElementById('progress-text').textContent = text;
  }

  function hideProgress() {
    document.getElementById('progress-container').style.display = 'none';
  }

  function renderLoadHistory(container, data) {
    const history = data.operations || [];
    if (!history.length) {
      container.innerHTML = '<p style="color:#666;text-align:center;padding:20px">Sin cargas registradas.</p>';
      return;
    }

    container.innerHTML = `
      <div class="results-stats">
        <span class="results-stat total">${history.length} cargas</span>
      </div>
      <ul class="op-list">
        ${history.map(h => {
          const date = new Date(h.timestamp);
          const dateStr = date.toLocaleDateString('es-MX') + ' ' + date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
          const hasErrors = h.errors?.length > 0;
          const statusBadge = hasErrors ? '<span class="op-badge" style="background:#fbe9e7;color:#c62828">con errores</span>' : '<span class="op-badge new">OK</span>';
          return `
            <li class="op-item" style="cursor:pointer" data-load-id="${h.id}">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span class="op-name">${h.mode} — ${h.quoteName || ''}</span>
                ${statusBadge}
              </div>
              <div class="op-meta">${dateStr} | ${h.partsCount || h.parts?.length || '?'} PNs | ${h.customerName || ''}</div>
              <div class="op-meta">Creados: ${h.stats?.pnsCreated || 0} | Existentes: ${h.stats?.pnsExisting || 0} | Errores: ${h.errors?.length || 0}</div>
              <button class="btn" style="margin-top:6px;padding:6px 10px;font-size:11px" data-download-id="${h.id}">
                📥 Descargar CSV de corrección
              </button>
            </li>`;
        }).join('')}
      </ul>`;

    // Bind download buttons
    container.querySelectorAll('[data-download-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const loadId = parseInt(btn.dataset.downloadId);
        btn.disabled = true;
        btn.textContent = 'Descargando...';
        try {
          await sendToBackground('download-load-csv', { loadId });
        } catch (err) { alert('Error: ' + err.message); }
        btn.disabled = false;
        btn.textContent = '📥 Descargar CSV de corrección';
      });
    });
  }

  // ── Extension update checker ──
  function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] || 0, db = pb[i] || 0;
      if (da > db) return 1;
      if (da < db) return -1;
    }
    return 0;
  }

  function checkExtensionUpdate() {
    if (!config?.extensionVersion) return;
    const current = chrome.runtime.getManifest().version;
    const latest = config.extensionVersion;
    if (compareVersions(latest, current) <= 0) return; // up to date

    // Check if user dismissed this version
    const dismissedKey = 'sa_update_dismissed_' + latest;
    if (sessionStorage.getItem(dismissedKey)) return;

    // Show banner
    const banner = document.getElementById('update-banner');
    document.getElementById('update-current-version').textContent = current;
    document.getElementById('update-new-version').textContent = latest;
    banner.classList.add('visible');

    document.getElementById('btn-update-download').addEventListener('click', () => {
      const baseUrl = config.extensionZipUrl;
      if (!baseUrl) { alert('URL del zip no configurada.'); return; }
      // Cache-buster: el navegador puede servir el zip viejo de disk cache si no cambia el URL.
      // Usamos la versión nueva para invalidar.
      const sep = baseUrl.includes('?') ? '&' : '?';
      const url = `${baseUrl}${sep}v=${encodeURIComponent(latest)}&t=${Date.now()}`;
      chrome.tabs.create({ url });
    });
    document.getElementById('btn-update-guide').addEventListener('click', () => {
      const url = config.extensionInstallGuideUrl;
      if (url) chrome.tabs.create({ url });
      else {
        alert('Cómo instalar:\n\n1. Descarga el zip\n2. Descomprímelo\n3. Ve a chrome://extensions o edge://extensions\n4. Activa "Modo desarrollador"\n5. Borra la versión vieja\n6. Clic en "Cargar descomprimida" y selecciona la carpeta extension');
      }
    });
    document.getElementById('btn-update-dismiss').addEventListener('click', () => {
      banner.classList.remove('visible');
      sessionStorage.setItem(dismissedKey, '1');
    });
  }

  // ── Dark mode ──
  function initTheme() {
    chrome.storage.local.get(['sa_theme'], (result) => {
      const theme = result.sa_theme || 'light';
      applyTheme(theme);
    });
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.classList.add('dark-mode');
      const btn = document.getElementById('btn-theme-toggle');
      if (btn) btn.textContent = '☀️';
    } else {
      document.body.classList.remove('dark-mode');
      const btn = document.getElementById('btn-theme-toggle');
      if (btn) btn.textContent = '🌙';
    }
  }

  function toggleTheme() {
    const isDark = document.body.classList.contains('dark-mode');
    const newTheme = isDark ? 'light' : 'dark';
    applyTheme(newTheme);
    chrome.storage.local.set({ sa_theme: newTheme });
  }

  // ── View mode ──
  function initViewMode() {
    chrome.storage.local.get(['sa_view_mode'], (result) => {
      viewMode = result.sa_view_mode || 'grid';
      applyViewMode(viewMode);
    });
  }

  function applyViewMode(mode) {
    viewMode = mode;
    const btn = document.getElementById('btn-view-toggle');
    if (btn) {
      btn.textContent = mode === 'grid' ? '≡' : '▦';
      btn.title = mode === 'grid' ? 'Cambiar a vista de lista' : 'Cambiar a vista de grid';
    }
    renderAppMenu();
  }

  function toggleViewMode() {
    const newMode = viewMode === 'grid' ? 'list' : 'grid';
    applyViewMode(newMode);
    chrome.storage.local.set({ sa_view_mode: newMode });
  }
});
