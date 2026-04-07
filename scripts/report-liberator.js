// Steelhead Report Liberator
// Removes reports from their folders (sets folderId to null)
// Depends on: SteelheadAPI

const ReportLiberator = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── Fetch all reports + folders ──
  async function fetchAllReportsAndFolders() {
    const data = await api().query('AllReports', { includeArchived: 'NO' }, 'AllReports');
    return {
      reports: data?.allReports?.nodes || [],
      folders: data?.allReportFolders?.nodes || []
    };
  }

  // ── Update report to remove from folder ──
  async function liberateReport(report) {
    await api().query('CreateUpdateReportWithPermissions', {
      reportId: report.id,
      name: report.name,
      query: report.latestQuery || '',
      postProcessing: report.postProcessing || '',
      folderId: null,
      managedPermissions: ['EXPORT_CSV']
    }, 'CreateUpdateReportWithPermissions');
  }

  // ── Delete a folder ──
  async function deleteFolder(folderId) {
    await api().query('DeleteFolderById', { id: folderId }, 'DeleteFolderById');
  }

  // ══════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('sa-rlib-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-rlib-styles';
    s.textContent = `
      .sa-rlib-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .sa-rlib-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
      .sa-rlib-modal h2{font-size:20px;margin:0 0 12px}
      .sa-rlib-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}
      .sa-rlib-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
      .sa-rlib-btn-cancel{background:#475569;color:#e2e8f0}
      .sa-rlib-btn-exec{background:#10b981;color:white}
      .sa-rlib-btn-exec:disabled{background:#475569;cursor:not-allowed;opacity:0.6}
      .sa-rlib-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
      .sa-rlib-table th{text-align:left;padding:6px 4px;color:#94a3b8;border-bottom:1px solid #334155}
      .sa-rlib-table td{padding:4px;border-bottom:1px solid #1e293b}
      .sa-rlib-progress{font-size:13px;color:#94a3b8;margin-top:8px}
      .sa-rlib-bar{width:100%;height:6px;background:#334155;border-radius:3px;margin-top:12px;overflow:hidden}
      .sa-rlib-bar-fill{height:100%;background:#10b981;border-radius:3px;transition:width 0.3s}
    `;
    document.head.appendChild(s);
  }

  function showProgressUI(title, msg) {
    ensureStyles();
    let ov = document.getElementById('sa-rlib-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-rlib-overlay';
      ov.className = 'sa-rlib-overlay';
      ov.innerHTML = `<div class="sa-rlib-modal" style="background:#0f1f1a">
        <h2 style="color:#10b981" id="sa-rlib-title">${title}</h2>
        <div class="sa-rlib-bar"><div class="sa-rlib-bar-fill" id="sa-rlib-bar" style="width:0%"></div></div>
        <div class="sa-rlib-progress" id="sa-rlib-text">${msg}</div>
      </div>`;
      document.body.appendChild(ov);
    } else {
      document.getElementById('sa-rlib-title').textContent = title;
      document.getElementById('sa-rlib-text').textContent = msg;
    }
  }

  function updateProgress(msg, percent) {
    const el = document.getElementById('sa-rlib-text');
    if (el) el.textContent = msg;
    if (percent !== undefined) {
      const bar = document.getElementById('sa-rlib-bar');
      if (bar) bar.style.width = percent + '%';
    }
  }

  function removeUI() {
    const ov = document.getElementById('sa-rlib-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // ── Selection form ──
  function showSelectionForm(reports) {
    return new Promise((resolve) => {
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'sa-rlib-overlay';
      const md = document.createElement('div');
      md.className = 'sa-rlib-modal';
      md.style.background = '#0f1f1a';

      const rowsHTML = reports.map((r, i) =>
        `<tr>
          <td><input type="checkbox" class="sa-rlib-check" data-idx="${i}" checked></td>
          <td>${r.name || '(sin nombre)'}</td>
          <td style="color:#64748b">${r.id}</td>
          <td style="color:#10b981">${r.folderId}</td>
        </tr>`
      ).join('');

      md.innerHTML = `
        <h2 style="color:#10b981">📂 Liberador de Reportes</h2>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:8px">Reportes atrapados en carpetas (folderId ≠ null). Saca los seleccionados de su carpeta para poder editarlos.</p>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input type="checkbox" id="sa-rlib-selectall" checked>
          <label for="sa-rlib-selectall" style="font-size:12px;color:#94a3b8;cursor:pointer">Seleccionar todos</label>
          <span style="font-size:12px;color:#10b981;margin-left:auto" id="sa-rlib-count">${reports.length} seleccionados</span>
        </div>

        <div style="max-height:400px;overflow-y:auto">
          <table class="sa-rlib-table">
            <tr><th>☑</th><th>Nombre</th><th>ID</th><th>Folder ID</th></tr>
            ${rowsHTML}
          </table>
        </div>

        <p style="font-size:11px;color:#f59e0b;margin-top:8px">⚠️ Esta operación cambia <code>folderId</code> a <code>null</code> en cada reporte seleccionado. Es reversible (puedes mover de vuelta a la carpeta después).</p>

        <div class="sa-rlib-btnrow">
          <button class="sa-rlib-btn sa-rlib-btn-cancel" id="sa-rlib-cancel">CANCELAR</button>
          <button class="sa-rlib-btn sa-rlib-btn-exec" id="sa-rlib-exec">SACAR DE CARPETA (<span id="sa-rlib-exec-count">${reports.length}</span>)</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      const updateCount = () => {
        const checked = md.querySelectorAll('.sa-rlib-check:checked').length;
        document.getElementById('sa-rlib-count').textContent = `${checked} seleccionados`;
        document.getElementById('sa-rlib-exec-count').textContent = checked;
        document.getElementById('sa-rlib-exec').disabled = checked === 0;
      };

      md.querySelector('#sa-rlib-selectall').onchange = (e) => {
        md.querySelectorAll('.sa-rlib-check').forEach(cb => { cb.checked = e.target.checked; });
        updateCount();
      };
      md.querySelectorAll('.sa-rlib-check').forEach(cb => { cb.onchange = updateCount; });

      document.getElementById('sa-rlib-cancel').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ cancelled: true });
      };

      document.getElementById('sa-rlib-exec').onclick = () => {
        const selected = [];
        md.querySelectorAll('.sa-rlib-check:checked').forEach(cb => {
          selected.push(reports[parseInt(cb.dataset.idx)]);
        });
        ov.parentNode.removeChild(ov);
        resolve({ selected });
      };
    });
  }

  // ── Folder selection form ──
  function showFolderSelectionForm(folders) {
    return new Promise((resolve) => {
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'sa-rlib-overlay';
      const md = document.createElement('div');
      md.className = 'sa-rlib-modal';
      md.style.background = '#0f1f1a';

      const rowsHTML = folders.map((f, i) => {
        const reportCount = f.reportsByFolderId?.nodes?.length || 0;
        return `<tr>
          <td><input type="checkbox" class="sa-rlib-fcheck" data-idx="${i}" ${reportCount === 0 ? 'checked' : ''}></td>
          <td>${f.name || '(sin nombre)'}</td>
          <td style="color:#64748b">${f.id}</td>
          <td style="color:${reportCount > 0 ? '#f59e0b' : '#10b981'}">${reportCount}</td>
        </tr>`;
      }).join('');

      md.innerHTML = `
        <h2 style="color:#10b981">🗑️ Borrar Carpetas</h2>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:8px">Selecciona las carpetas que quieres borrar. Las carpetas con reportes adentro están deseleccionadas por defecto (debes liberarlos primero).</p>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input type="checkbox" id="sa-rlib-fselectall">
          <label for="sa-rlib-fselectall" style="font-size:12px;color:#94a3b8;cursor:pointer">Seleccionar todas</label>
          <span style="font-size:12px;color:#10b981;margin-left:auto" id="sa-rlib-fcount">0 seleccionadas</span>
        </div>

        <div style="max-height:400px;overflow-y:auto">
          <table class="sa-rlib-table">
            <tr><th>☑</th><th>Nombre</th><th>ID</th><th>Reportes</th></tr>
            ${rowsHTML}
          </table>
        </div>

        <p style="font-size:11px;color:#ef4444;margin-top:8px">⚠️ Borrar es irreversible. Las carpetas con reportes adentro pueden fallar al borrar.</p>

        <div class="sa-rlib-btnrow">
          <button class="sa-rlib-btn sa-rlib-btn-cancel" id="sa-rlib-fskip">SALTAR</button>
          <button class="sa-rlib-btn sa-rlib-btn-exec" id="sa-rlib-fexec" style="background:#ef4444">BORRAR (<span id="sa-rlib-fexec-count">0</span>)</button>
        </div>`;

      ov.appendChild(md);
      document.body.appendChild(ov);

      const updateCount = () => {
        const checked = md.querySelectorAll('.sa-rlib-fcheck:checked').length;
        document.getElementById('sa-rlib-fcount').textContent = `${checked} seleccionadas`;
        document.getElementById('sa-rlib-fexec-count').textContent = checked;
        document.getElementById('sa-rlib-fexec').disabled = checked === 0;
      };
      updateCount();

      md.querySelector('#sa-rlib-fselectall').onchange = (e) => {
        md.querySelectorAll('.sa-rlib-fcheck').forEach(cb => { cb.checked = e.target.checked; });
        updateCount();
      };
      md.querySelectorAll('.sa-rlib-fcheck').forEach(cb => { cb.onchange = updateCount; });

      document.getElementById('sa-rlib-fskip').onclick = () => {
        ov.parentNode.removeChild(ov);
        resolve({ skipped: true });
      };

      document.getElementById('sa-rlib-fexec').onclick = () => {
        const selected = [];
        md.querySelectorAll('.sa-rlib-fcheck:checked').forEach(cb => {
          selected.push(folders[parseInt(cb.dataset.idx)]);
        });
        ov.parentNode.removeChild(ov);
        resolve({ selected });
      };
    });
  }

  // ── Summary modal ──
  function showSummary(results) {
    ensureStyles();
    const ov = document.createElement('div');
    ov.className = 'sa-rlib-overlay';
    const md = document.createElement('div');
    md.className = 'sa-rlib-modal';
    md.style.background = '#0f1f1a';

    const hasErrors = results.errors.length > 0;
    const icon = hasErrors ? '⚠️' : '✅';
    const iconColor = hasErrors ? '#f59e0b' : '#10b981';

    let errorsHTML = '';
    if (results.errors.length > 0) {
      const items = results.errors.slice(0, 15).map(e => `<div style="font-size:11px;color:#fca5a5;padding:1px 0">${e}</div>`).join('');
      errorsHTML = `<div style="margin-top:12px"><div style="font-size:12px;color:#ef4444;font-weight:600;margin-bottom:4px">Errores (${results.errors.length}):</div>${items}</div>`;
    }

    md.innerHTML = `
      <h2 style="color:${iconColor}">${icon} Operación Completada</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:16px 0">
        <div style="background:#0a1410;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#10b981">${results.liberated}</div>
          <div style="font-size:11px;color:#94a3b8">Reportes liberados</div>
        </div>
        <div style="background:#0a1410;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#10b981">${results.foldersDeleted || 0}</div>
          <div style="font-size:11px;color:#94a3b8">Carpetas borradas</div>
        </div>
        <div style="background:#0a1410;padding:12px;border-radius:8px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#ef4444">${results.errors.length}</div>
          <div style="font-size:11px;color:#94a3b8">Errores</div>
        </div>
      </div>
      ${errorsHTML}
      <div class="sa-rlib-btnrow" style="margin-top:16px">
        <button class="sa-rlib-btn" id="sa-rlib-copylog" style="background:#334155;color:#e2e8f0">📋 Copiar Log</button>
        <button class="sa-rlib-btn sa-rlib-btn-exec" id="sa-rlib-close">CERRAR</button>
      </div>`;

    ov.appendChild(md);
    document.body.appendChild(ov);

    document.getElementById('sa-rlib-close').onclick = () => ov.parentNode.removeChild(ov);
    document.getElementById('sa-rlib-copylog').onclick = () => {
      const logText = api().getLog().join('\n');
      navigator.clipboard.writeText(logText).then(() => {
        const btn = document.getElementById('sa-rlib-copylog');
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📋 Copiar Log'; }, 2000);
      });
    };
  }

  // ── Main orchestrator ──
  async function run() {
    log(`=== LIBERADOR DE REPORTES ===`);

    // Phase 1: Fetch reports + folders
    let data;
    try {
      data = await fetchAllReportsAndFolders();
    } catch (e) {
      return { error: 'Error cargando reportes: ' + e.message };
    }

    const { reports: allReports, folders: allFolders } = data;
    log(`Reportes totales: ${allReports.length}`);
    log(`Carpetas totales: ${allFolders.length}`);

    const results = { liberated: 0, foldersDeleted: 0, errors: [] };

    // Phase 2: Liberate reports from folders (if any)
    const inFolders = allReports.filter(r => r.folderId !== null && r.folderId !== undefined);
    log(`Reportes en carpetas: ${inFolders.length}`);

    if (inFolders.length > 0) {
      inFolders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const config = await showSelectionForm(inFolders);
      if (config.cancelled) return { cancelled: true };

      const selected = config.selected;
      log(`Seleccionados para liberar: ${selected.length}`);

      showProgressUI('Liberando Reportes', 'Preparando...');
      for (let i = 0; i < selected.length; i++) {
        const report = selected[i];
        const pct = (i / selected.length) * 100;
        updateProgress(`${i + 1}/${selected.length}: ${report.name}`, pct);
        try {
          await liberateReport(report);
          results.liberated++;
          log(`  ${report.name} (id:${report.id}): liberado ✓`);
        } catch (e) {
          results.errors.push(`${report.name}: ${String(e).substring(0, 200)}`);
          warn(`  ${report.name}: error: ${String(e).substring(0, 200)}`);
        }
      }
      removeUI();
    }

    // Phase 3: Delete folders
    if (allFolders.length > 0) {
      // Re-fetch to get updated folder report counts after liberation
      let updatedFolders = allFolders;
      if (results.liberated > 0) {
        try {
          const fresh = await fetchAllReportsAndFolders();
          updatedFolders = fresh.folders;
        } catch (_) {}
      }
      updatedFolders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      const folderConfig = await showFolderSelectionForm(updatedFolders);
      if (!folderConfig.skipped && folderConfig.selected) {
        const selectedFolders = folderConfig.selected;
        log(`Carpetas a borrar: ${selectedFolders.length}`);

        showProgressUI('Borrando Carpetas', 'Preparando...');
        for (let i = 0; i < selectedFolders.length; i++) {
          const folder = selectedFolders[i];
          const pct = (i / selectedFolders.length) * 100;
          updateProgress(`${i + 1}/${selectedFolders.length}: ${folder.name}`, pct);
          try {
            await deleteFolder(folder.id);
            results.foldersDeleted++;
            log(`  ${folder.name} (id:${folder.id}): borrada ✓`);
          } catch (e) {
            results.errors.push(`Carpeta "${folder.name}": ${String(e).substring(0, 200)}`);
            warn(`  ${folder.name}: error: ${String(e).substring(0, 200)}`);
          }
        }
        removeUI();
      }
    }

    log(`\n=== RESULTADO ===`);
    log(`Reportes liberados: ${results.liberated}`);
    log(`Carpetas borradas: ${results.foldersDeleted}`);
    log(`Errores: ${results.errors.length}`);

    showSummary(results);
    return results;
  }

  return { run };
})();

if (typeof window !== 'undefined') window.ReportLiberator = ReportLiberator;
