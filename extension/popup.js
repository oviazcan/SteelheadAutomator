// Steelhead Automator — Popup Logic
// File picker runs HERE (visible to user), CSV sent to background for execution

document.addEventListener('DOMContentLoaded', () => {
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const versionText = document.getElementById('version-text');
  const btnUpload = document.getElementById('btn-upload');
  const btnTemplate = document.getElementById('btn-template');
  const btnStatus = document.getElementById('btn-status');
  const fileInput = document.getElementById('file-input');

  checkStatus();

  // "Cargar Excel" — open file picker in popup, then send CSV to background
  btnUpload.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    const file = e.target.files[0];
    try {
      btnUpload.disabled = true;
      showProgress('Leyendo archivo...', 5);

      const csvText = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Error leyendo archivo'));
        r.readAsText(file, 'UTF-8');
      });

      showProgress('Inyectando scripts y ejecutando pipeline...', 15);

      // Send CSV to background, which injects scripts + runs pipeline in page
      const result = await sendToBackground('run-csv', { csvText });

      if (result?.cancelled) {
        hideProgress();
      } else if (result?.error) {
        showProgress('Error: ' + result.error, 0);
      } else {
        showProgress('Pipeline ejecutado. Revisa la pestaña de Steelhead.', 100);
      }
    } catch (err) {
      alert('Error: ' + err.message);
      hideProgress();
    } finally {
      btnUpload.disabled = false;
      fileInput.value = '';
    }
  });

  btnTemplate.addEventListener('click', () => downloadTemplate());
  document.getElementById('btn-catalogs').addEventListener('click', () => updateCatalogs());
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

  function sendToBackground(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
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
      if (!config?.templateUrl) { alert('URL de plantilla no configurada.'); return; }
      chrome.tabs.create({ url: config.templateUrl });
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnTemplate.disabled = false;
    }
  }

  async function updateCatalogs() {
    try {
      document.getElementById('btn-catalogs').disabled = true;
      showProgress('Consultando catálogos de Steelhead...', 20);
      const result = await sendToBackground('update-catalogs');
      if (result?.error) {
        alert('Error: ' + result.error);
        hideProgress();
      } else {
        showProgress('Catálogos descargados. Importa las hojas en tu plantilla.', 100);
      }
    } catch (err) {
      alert('Error: ' + err.message);
      hideProgress();
    } finally {
      document.getElementById('btn-catalogs').disabled = false;
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
