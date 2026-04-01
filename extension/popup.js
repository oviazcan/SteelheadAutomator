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
    config = await sendToBackground('get-config');
    await checkStatus();
    renderAppMenu();

    document.getElementById('btn-reload').addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url?.includes('app.gosteelhead.com')) { chrome.tabs.reload(tabs[0].id); window.close(); }
        else alert('No hay pestaña activa de Steelhead.');
      });
    });

    document.getElementById('app-back').addEventListener('click', goToMenu);
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
  }

  // ── App View ──
  function selectApp(app) {
    currentApp = app;
    document.getElementById('app-title').textContent = app.name;
    const container = document.getElementById('app-actions');
    container.innerHTML = '';

    for (const action of (app.actions || [])) {
      const btn = document.createElement('button');
      btn.className = action.type === 'primary' ? 'btn btn-primary' : 'btn';
      btn.dataset.actionId = action.id;
      btn.innerHTML = `
        <span class="btn-icon">${action.icon || '▸'}</span>
        <span class="btn-label">${action.label}<small>${action.sublabel || ''}</small></span>`;
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
      type === 'show-api-knowledge' ? 'APIs Conocidas' : 'Resultados';

    if (type === 'view-scan-results') {
      renderScanResults(container, data);
    } else if (type === 'show-api-knowledge') {
      renderAPIKnowledge(container, data);
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

    container.innerHTML = `
      <div class="results-stats">
        <span class="results-stat total">${summary.total || ops.length} operaciones</span>
        <span class="results-stat" style="background:#fce4ec;color:#c62828">${summary.mutations || 0} mutations</span>
        <span class="results-stat" style="background:#e3f2fd;color:#1565c0">${summary.queries || 0} queries</span>
      </div>
      <ul class="op-list">
        ${(Array.isArray(ops) ? ops : Object.entries(ops).map(([k, v]) => ({ operationName: k, ...v }))).map(op => `
          <li class="op-item">
            <span class="op-name">${op.operationName}</span>
            <span class="op-badge ${op.type}">${op.type}</span>
            <div class="op-meta">${op.description || '(sin descripción)'}${op.usedBy ? ' — ' + op.usedBy : ''}</div>
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
      document.getElementById('version-text').textContent = `v${status.version}`;

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
});
