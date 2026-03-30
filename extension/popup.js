// Steelhead Automator — Popup Logic
// Communicates with background.js (service worker) instead of content script

document.addEventListener('DOMContentLoaded', () => {
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const versionText = document.getElementById('version-text');
  const btnUpload = document.getElementById('btn-upload');
  const btnTemplate = document.getElementById('btn-template');
  const btnStatus = document.getElementById('btn-status');

  checkStatus();

  // "Cargar Excel" — triggers file picker in the Steelhead page context
  btnUpload.addEventListener('click', async () => {
    try {
      btnUpload.disabled = true;
      showProgress('Abriendo selector de archivo...', 5);
      const result = await sendToBackground('pick-and-run');
      if (result?.cancelled) {
        hideProgress();
      } else if (result?.error) {
        alert('Error: ' + result.error);
        hideProgress();
      } else {
        showProgress('Pipeline ejecutado. Revisa la pestaña de Steelhead.', 100);
      }
    } catch (err) {
      alert('Error: ' + err.message);
      hideProgress();
    } finally {
      btnUpload.disabled = false;
    }
  });

  btnTemplate.addEventListener('click', () => downloadTemplate());
  btnStatus.addEventListener('click', () => checkStatus());

  document.getElementById('btn-reload').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url?.includes('app.gosteelhead.com')) {
        chrome.tabs.reload(tabs[0].id);
        window.close();
      } else {
        alert('No hay pestaña activa de Steelhead.');
      }
    });
  });

  // Send message to background service worker
  function sendToBackground(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  async function checkStatus() {
    try {
      statusText.textContent = 'Conectando...';
      const status = await sendToBackground('get-status');
      statusBar.classList.remove('error');
      statusText.textContent = status.connected ? 'Conectado' : 'Sin conexión remota';
      versionText.textContent = `v${status.version}`;
    } catch (err) {
      statusBar.classList.add('error');
      statusText.textContent = err.message;
      versionText.textContent = 'v--';
    }
  }

  async function downloadTemplate() {
    try {
      btnTemplate.disabled = true;
      const config = await sendToBackground('get-config');
      if (!config) { alert('No hay configuración disponible.'); return; }
      const templateUrl = config.templateUrl;
      if (templateUrl) {
        chrome.tabs.create({ url: templateUrl });
      } else {
        alert('Descarga de plantilla con catálogos dinámicos aún no disponible.\nUsa la plantilla Excel existente por ahora.');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnTemplate.disabled = false;
    }
  }

  function showProgress(text, percent) {
    const container = document.getElementById('progress-container');
    const fill = document.getElementById('progress-fill');
    const label = document.getElementById('progress-text');
    container.style.display = 'block';
    fill.style.width = percent + '%';
    label.textContent = text;
  }

  function hideProgress() {
    document.getElementById('progress-container').style.display = 'none';
  }
});
