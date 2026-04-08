// Steelhead Automator v2 — Popup Logic
// Data-driven multi-app UI rendered from config.apps

document.addEventListener('DOMContentLoaded', () => {
  let config = null;
  let currentApp = null;

  const views = { menu: 'view-menu', app: 'view-app', results: 'view-results' };
  const fileInput = document.getElementById('file-input');

  init();

  // ── Init ──
  async function init() {
    initTheme();
    config = await sendToBackground('get-config');
    await checkStatus();
    renderAppMenu();
    checkExtensionUpdate();

    document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);

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
  function renderAppMenu() {
    const menu = document.getElementById('app-menu');
    menu.innerHTML = '';

    const apps = config?.apps || [];
    for (const app of apps) {
      const card = document.createElement('div');
      card.className = 'app-card';
      card.innerHTML = `
        <span class="app-icon">${app.icon || '📦'}</span>
        <div class="app-info">
          <div class="app-name">${app.name}</div>
          <div class="app-subtitle">${app.subtitle || ''}</div>
        </div>
        <span class="app-chevron">▶</span>`;
      card.addEventListener('click', () => selectApp(app));
      menu.appendChild(card);
    }

    // Placeholder for future apps
    const placeholder = document.createElement('div');
    placeholder.className = 'app-card disabled';
    placeholder.innerHTML = `
      <span class="app-icon">⚙️</span>
      <div class="app-info">
        <div class="app-name">Más apps</div>
        <div class="app-subtitle">Próximamente</div>
      </div>`;
    menu.appendChild(placeholder);

    // Wire up scroll indicator
    const fade = document.getElementById('scroll-fade');
    const updateFade = () => {
      const scrollable = menu.scrollHeight > menu.clientHeight;
      const atBottom = menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 4;
      fade.classList.toggle('visible', scrollable && !atBottom);
    };
    menu.addEventListener('scroll', updateFade);
    setTimeout(updateFade, 0);
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
      document.getElementById('status-text').textContent = status.connected ? 'Conectado' : 'Sin conexión';
      const extVer = chrome.runtime.getManifest().version;
      const verEl = document.getElementById('version-text');
      verEl.textContent = `v${extVer}`;
      verEl.title = `Extensión: v${extVer}\nScripts remotos: v${status.version}\nÚltima actualización catálogos: ${status.lastUpdated}`;

      // Check if scanner is active
      try {
        const scanStatus = await sendToBackground('check-scan-status');
        updateScanIndicator(scanStatus?.scanning);
      } catch (_) { updateScanIndicator(false); }
    } catch (err) {
      document.getElementById('status-bar').classList.add('error');
      document.getElementById('status-text').textContent = err.message;
    }
  }

  function updateScanIndicator(active) {
    document.getElementById('scan-indicator').classList.toggle('active', !!active);
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
      const url = config.extensionZipUrl;
      if (url) chrome.tabs.create({ url });
      else alert('URL del zip no configurada.');
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
});
