// CFDI Attacher
// Auto-attaches CFDI XML to invoice emails
// Intercepts InvoiceByIdInDomain responses to cache writeResult,
// then intercepts SendEmailChecked to inject XML attachments
// Depends on: SteelheadAPI

const CfdiAttacher = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const invoiceCache = new Map(); // idInDomain → { xmlBase64, linkxml, filename }
  let enabled = true;
  let _origFetch = null; // unpatched fetch, set in patchFetch()
  let observerActive = false;

  // ── Init ──

  function init() {
    enabled = document.documentElement.dataset.saCfdiEnabled !== 'false';
    if (!enabled) { console.log('[CFDI] Deshabilitado'); return; }
    patchFetch();
    setupObserver();
    console.log('[CFDI] Attacher inicializado');
  }

  // ── Fetch Interceptor ──

  function patchFetch() {
    // Window-level sentinel prevents double-patching on version bumps
    if (window.__saCfdiFetchPatched) return;
    window.__saCfdiFetchPatched = true;
    _origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');

      if (!isGraphql || !opts?.body) return _origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return _origFetch.apply(this, args); }

      const opName = bodyObj?.operationName;

      // Intercept outgoing SendEmailChecked — inject XML attachments
      if (opName === 'SendEmailChecked' && shouldAttach()) {
        try {
          const xmlAttachments = await uploadCachedXmls(bodyObj.variables);
          if (xmlAttachments.length > 0) {
            bodyObj.variables.attachments = [
              ...(bodyObj.variables.attachments || []),
              ...xmlAttachments
            ];
            args[1] = { ...opts, body: JSON.stringify(bodyObj) };
          }
        } catch (err) {
          console.error('[CFDI] Error adjuntando XMLs:', err);
          alert('Error al adjuntar XML(s) CFDI: ' + err.message + '\n\nEl email NO fue enviado. Intenta de nuevo.');
          throw err; // Cancel the send
        }
      }

      // Execute the (possibly modified) fetch
      const response = await _origFetch.apply(this, args);

      // Intercept InvoiceByIdInDomain responses — cache writeResult
      if (opName === 'InvoiceByIdInDomain') {
        try {
          const clone = response.clone();
          const json = await clone.json();
          cacheInvoiceData(json);
        } catch (err) {
          console.warn('[CFDI] Error cacheando invoice data:', err);
        }
      }

      return response;
    };
  }

  // ── Cache Logic ──

  function cacheInvoiceData(json) {
    const inv = json?.data?.invoiceByIdInDomain;
    if (!inv) return;

    const idInDomain = inv.idInDomain;
    const wr = inv.createWriteResult?.data?.result?.writeResult;
    const customInput = wr?.CustomInput;
    const linkxml = customInput?.linkxml || null;
    const xmlBase64 = wr?.XmlBase64File || null;

    // Extract filename from linkxml URL
    let filename = null;
    if (linkxml) {
      try {
        const urlPath = new URL(linkxml).pathname;
        filename = urlPath.split('/').pop();
      } catch { filename = `cfdi-${idInDomain}.xml`; }
    }

    invoiceCache.set(idInDomain, {
      id: inv.id,
      idInDomain,
      xmlBase64,
      linkxml,
      filename: filename || `cfdi-${idInDomain}.xml`
    });

    console.log(`[CFDI] Cacheada factura #${idInDomain}:`, xmlBase64 ? 'con XML' : 'sin XML');
  }

  // ── MutationObserver ──

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          // Look for the email dialog — has heading "Send Invoice Email"
          const heading = node.querySelector?.('h2, h3, h4, h5, h6, [class*="heading"]');
          if (heading && /send\s+invoice\s+email/i.test(heading.textContent)) {
            injectCheckbox(node);
            return;
          }
          // Also check if the node itself contains the dialog deeper
          const dialog = node.querySelector?.('[class*="dialog"], [class*="modal"], [role="dialog"]');
          if (dialog) {
            const h = dialog.querySelector('h2, h3, h4, h5, h6, [class*="heading"]');
            if (h && /send\s+(invoice|.*invoices)/i.test(h.textContent)) {
              injectCheckbox(dialog);
              return;
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // One-time check for dialog already present in DOM
    const existing = document.querySelector('[role="dialog"], .MuiDialog-paper');
    if (existing) {
      const h = existing.querySelector('h2, h3, h4, h5, h6, [class*="heading"]');
      if (h && /send\s+(invoice|.*invoices)/i.test(h.textContent)) {
        injectCheckbox(existing);
      }
    }
  }

  // ── Checkbox Injection ──

  function injectCheckbox(dialog) {
    // Don't inject twice
    if (dialog.querySelector('#sa-cfdi-toggle')) return;
    if (!enabled) return;

    // Find the toggle area — look for the last toggle row (Visible to Others)
    // Steelhead uses a consistent structure with label + switch per row
    const allLabels = dialog.querySelectorAll('label, span, div');
    let toggleContainer = null;

    for (const el of allLabels) {
      const text = el.textContent?.trim();
      if (text === 'Visible to Others' || text === 'Attach PDF' || text === 'Attach PDFs') {
        // Walk up to find the row container
        toggleContainer = el.closest('[class*="row"], [class*="flex"], [class*="switch"]')
          || el.parentElement?.parentElement;
      }
    }

    if (!toggleContainer) {
      console.warn('[CFDI] No se encontró la zona de toggles del diálogo');
      // Fallback: insert before the SEND button area
      const sendBtn = dialog.querySelector('button[class*="send"], button[class*="primary"]');
      toggleContainer = sendBtn?.parentElement?.parentElement;
    }

    if (!toggleContainer) {
      console.warn('[CFDI] No se pudo inyectar checkbox');
      return;
    }

    // Build the checkbox row
    const row = document.createElement('div');
    row.id = 'sa-cfdi-toggle';
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:8px 16px; margin-top:4px;';

    const label = document.createElement('span');
    label.textContent = 'Adjuntar XML(s) CFDI';
    label.style.cssText = 'color:#e0e0e0; font-size:14px; font-weight:500;';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    toggle.id = 'sa-cfdi-checkbox';
    toggle.style.cssText = 'width:18px; height:18px; cursor:pointer; accent-color:#c13c26;';

    row.appendChild(label);
    row.appendChild(toggle);

    // Insert after the toggle container
    toggleContainer.parentElement.insertBefore(row, toggleContainer.nextSibling);

    // Check which invoices are missing XML
    addWarnings(row);

    console.log('[CFDI] Checkbox inyectado en diálogo');
  }

  function addWarnings(row) {
    const missing = [];
    for (const [idInDomain, data] of invoiceCache) {
      if (!data.xmlBase64) missing.push(idInDomain);
    }
    if (missing.length === 0) return;

    const warn = document.createElement('div');
    warn.style.cssText = 'color:#f59e0b; font-size:12px; padding:4px 16px 0; margin-top:2px;';
    warn.textContent = `\u26A0 Factura(s) #${missing.join(', #')} sin XML CFDI disponible`;
    row.parentElement.insertBefore(warn, row.nextSibling);
  }

  // ── Upload Logic ──

  function shouldAttach() {
    const cb = document.getElementById('sa-cfdi-checkbox');
    return cb && cb.checked;
  }

  async function uploadCachedXmls(sendVars) {
    const attachments = [];

    // Determine which invoices are being sent.
    // SendEmailChecked variables contain linkInfo[] with idInDomain per invoice
    // (observed in scan_results_2026-04-11 for both single and multi-invoice sends).
    const linkInfo = sendVars?.linkInfo || [];
    const idsToProcess = linkInfo.map(l => l.idInDomain).filter(Boolean);

    if (idsToProcess.length === 0) {
      console.warn('[CFDI] No se encontraron IDs de factura en linkInfo, omitiendo adjunto XML');
      return [];
    }

    let uploaded = 0;
    const total = idsToProcess.filter(id => invoiceCache.get(id)?.xmlBase64).length;

    for (const idInDomain of idsToProcess) {
      const cached = invoiceCache.get(idInDomain);
      if (!cached?.xmlBase64) continue;

      console.log(`[CFDI] Subiendo XML factura #${idInDomain} (${++uploaded}/${total})...`);

      // Decode base64 → Blob
      const byteStr = atob(cached.xmlBase64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/xml' });
      const file = new File([blob], cached.filename, { type: 'application/xml' });

      // Upload binary to /api/files (use _origFetch to bypass any fetch patches)
      const formData = new FormData();
      formData.append('myfile', file, cached.filename);
      const uploadResp = await _origFetch('/api/files', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      if (!uploadResp.ok) throw new Error(`Upload HTTP ${uploadResp.status} para factura #${idInDomain}`);
      const uploadResult = await uploadResp.json();

      // Register in Steelhead
      await api().query('CreateUserFile', {
        name: uploadResult.name,
        originalName: cached.filename
      });

      attachments.push({
        filename: uploadResult.name,
        displayName: cached.filename
      });

      console.log(`[CFDI] XML factura #${idInDomain} adjuntado: ${cached.filename}`);
    }

    return attachments;
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.CfdiAttacher = CfdiAttacher;
  // Auto-init — called after injection
  CfdiAttacher.init();
}
