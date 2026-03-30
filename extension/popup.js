// Steelhead Automator — Popup Logic

document.addEventListener('DOMContentLoaded', () => {
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const versionText = document.getElementById('version-text');
  const btnUpload = document.getElementById('btn-upload');
  const btnTemplate = document.getElementById('btn-template');
  const btnStatus = document.getElementById('btn-status');
  const fileInput = document.getElementById('file-input');

  // Check connection status on popup open
  checkStatus();

  // Button handlers
  btnUpload.addEventListener('click', () => {
    fileInput.click();
  });

  btnTemplate.addEventListener('click', () => {
    downloadTemplate();
  });

  btnStatus.addEventListener('click', () => {
    checkStatus();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  // Send message to content script via background
  function sendToContent(action, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0] || !tabs[0].url?.includes('app.gosteelhead.com')) {
          reject(new Error('Abre Steelhead primero (app.gosteelhead.com)'));
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { action, ...data }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response?.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });
    });
  }

  async function checkStatus() {
    try {
      statusText.textContent = 'Conectando...';
      const status = await sendToContent('get-status');
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
      const config = await sendToContent('get-config');
      if (!config) {
        alert('No hay configuración disponible. Abre Steelhead primero.');
        return;
      }
      // TODO: Fetch catalogs from Steelhead API and generate Excel with SheetJS
      // For now, open the static template URL
      const templateUrl = config.templateUrl;
      if (templateUrl) {
        chrome.tabs.create({ url: templateUrl });
      } else {
        alert('URL de plantilla no configurada');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnTemplate.disabled = false;
    }
  }

  async function handleFileUpload(file) {
    try {
      btnUpload.disabled = true;
      showProgress('Leyendo archivo...', 10);

      // Read file as ArrayBuffer
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);

      showProgress('Enviando a Steelhead...', 30);
      const result = await sendToContent('run-bulk-upload', {
        fileName: file.name,
        fileData: base64,
        fileType: file.name.endsWith('.csv') ? 'csv' : 'xlsx'
      });

      showProgress('Completado', 100);
      console.log('[SteelheadAutomator] Resultado:', result);
    } catch (err) {
      alert('Error: ' + err.message);
      hideProgress();
    } finally {
      btnUpload.disabled = false;
      fileInput.value = '';
    }
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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
