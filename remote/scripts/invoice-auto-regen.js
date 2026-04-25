// Invoice Auto-Regenerate
// Detecta facturas timbradas con PDF pre-timbre y dispara CreateInvoicePdf en background.
// Intercepta ActiveInvoicesPaged (dashboard) e InvoiceByIdInDomain (modal).
// Depends on: SteelheadAPI

const InvoiceAutoRegen = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  let enabled = true;
  let _origFetch = null;

  // KILL SWITCH del flujo automático. Mientras esté en true, el detector + logs
  // funcionan, pero ninguna factura se regenera automáticamente al refrescar.
  // La función manual window.regenerateInvoice(invoiceId, idInDomain) sigue siendo
  // invocable desde la consola para verificar que la nueva secuencia funciona.
  const REGEN_DISABLED = true;

  // Registry de sha256Hash por operationName, llenado en tiempo real desde el
  // interceptor. Permite usar hashes que aún no están en config.json (necesario
  // mientras no agreguemos GetPdfTemplateOutputToUserFile, GetPdfConfigsByType,
  // AddCreatedPaymentOnInvoice).
  //
  // IMPORTANTE: vive en window para sobrevivir doble-load del script. El sentinel
  // __saAutoRegenPatched evita que se reinstale el fetch interceptor, pero la IIFE
  // sí corre dos veces y cada cierre tendría su propio Map vacío si fuera local.
  const hashRegistry = window.__autoRegenHashRegistryMap || (window.__autoRegenHashRegistryMap = new Map());

  // Estado en memoria (vida = pestaña)
  const completedSet = new Set(); // invoiceIds ya regenerados con éxito
  const state = new Map();        // invoiceId → 'pending' | 'running' | 'done' | 'error'
  const queueArr = [];            // FIFO de {invoiceId, idInDomain}
  let processing = false;

  // ── Init ──

  function init() {
    enabled = document.documentElement.dataset.saAutoRegenEnabled !== 'false';
    if (!enabled) { console.log('[AutoRegen] Deshabilitado'); return; }
    if (window.__saAutoRegenInitDone) {
      console.log('[AutoRegen] Ya estaba inicializado en esta página — skip (registry compartido)');
      return;
    }
    window.__saAutoRegenInitDone = true;
    patchFetch();

    // Cablear UI
    on('enqueued', item => { paintRow(item.idInDomain, 'pending'); paintModal('pending'); });
    on('started',  item => { paintRow(item.idInDomain, 'running'); paintModal('running'); });
    on('done',     item => { paintRow(item.idInDomain, 'done');    paintModal('done'); });
    on('error',    item => { paintRow(item.idInDomain, 'error');   paintModal('error'); });

    setupRowObserver();
    console.log('[AutoRegen] Inicializado');
  }

  // ── Fetch Interceptor (placeholder, llenado en Task 7) ──

  function patchFetch() {
    if (window.__saAutoRegenPatched) return;
    window.__saAutoRegenPatched = true;
    _origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      if (!isGraphql || !opts?.body) return _origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch { return _origFetch.apply(this, args); }
      const opName = bodyObj?.operationName;

      // Captura sha256Hash de toda op que pasa para tener registry siempre fresco.
      // Permite invocar mutations cuyos hashes no estén aún en config.json.
      const _h = bodyObj?.extensions?.persistedQuery?.sha256Hash;
      if (opName && _h) {
        hashRegistry.set(opName, _h);
        try { window.__autoRegenHashRegistry = Object.fromEntries(hashRegistry); } catch {}
      }

      // DEBUG: capturar TODAS las ops relacionadas con PDF/Invoice/File para diagnóstico
      const _isInteresting = opName && /Pdf|Invoice|Render|Revision|File|Upload|Sign|S3|Payment/i.test(opName);
      if (_isInteresting) {
        try {
          console.log(`%c[AutoRegen DEBUG] → ${opName}`, 'color:#0891b2', 'vars:', JSON.stringify(bodyObj.variables));
        } catch {
          console.log(`%c[AutoRegen DEBUG] → ${opName}`, 'color:#0891b2', 'vars:', bodyObj.variables);
        }
      }

      const response = await _origFetch.apply(this, args);

      // Loguear respuesta de las ops de interés (clonada, no consume el body original)
      if (_isInteresting) {
        try {
          const respClone = response.clone();
          respClone.json().then(j => {
            try {
              console.log(`%c[AutoRegen DEBUG] ← ${opName}`, 'color:#7c3aed', 'data:', JSON.stringify(j?.data));
            } catch {
              console.log(`%c[AutoRegen DEBUG] ← ${opName}`, 'color:#7c3aed', 'data:', j?.data);
            }
          }).catch(() => {});
        } catch {}
      }

      if (opName === 'ActiveInvoicesPaged' || opName === 'InvoiceByIdInDomain') {
        // Clonar y procesar en el siguiente tick para no bloquear el caller
        try {
          const clone = response.clone();
          const json = await clone.json();

          // DEBUG: shape relevante para diagnóstico
          if (opName === 'InvoiceByIdInDomain') {
            const inv = json?.data?.invoiceByIdInDomain;
            const pdfNodes = inv?.invoicePdfsByInvoiceId?.nodes;
            console.log('[AutoRegen DEBUG] InvoiceByIdInDomain', {
              idInDomain: inv?.idInDomain,
              hasSteelheadObject: !!inv?.steelheadObjectByInvoiceId,
              writtenAt: inv?.steelheadObjectByInvoiceId?.writtenAt,
              voidedAt: inv?.voidedAt,
              voidSuccessfulAt: inv?.steelheadObjectByInvoiceId?.voidSuccessfulAt,
              pdfsCount: pdfNodes?.length,
              pdfNodesRaw: pdfNodes,
              pdfNodeKeys: pdfNodes && pdfNodes[0] ? Object.keys(pdfNodes[0]) : null,
              uuid: inv?.createWriteResult?.data?.result?.writeResult?.uuid,
              keysAtRoot: inv ? Object.keys(inv) : null
            });
          } else {
            const nodes = json?.data?.allInvoices?.nodes || [];
            console.log('[AutoRegen DEBUG] ActiveInvoicesPaged total=', nodes.length);
            if (nodes.length > 0) {
              const sample = nodes[0];
              const pdfNodes = sample.invoicePdfsByInvoiceId?.nodes;
              console.log('[AutoRegen DEBUG] sample[0]', {
                idInDomain: sample.idInDomain,
                hasSteelheadObject: !!sample.steelheadObjectByInvoiceId,
                writtenAt: sample.steelheadObjectByInvoiceId?.writtenAt,
                pdfsCount: pdfNodes?.length,
                pdfNodesRaw: pdfNodes,
                pdfNodeKeys: pdfNodes && pdfNodes[0] ? Object.keys(pdfNodes[0]) : null,
                keysAtRoot: Object.keys(sample)
              });
            }
          }

          const items = (opName === 'ActiveInvoicesPaged') ? scanList(json) : scanSingle(json);
          console.log(`[AutoRegen DEBUG] ${opName} items detectados:`, items.length);
          if (items.length > 0) {
            for (const it of items) rememberItem(it);
            enqueue(items);
          }
        } catch (err) {
          console.warn('[AutoRegen] Error procesando', opName, err);
        }
      }
      return response;
    };
  }

  // ── Detector ──

  // Devuelve max(createdAt) en ms, o 0 si no hay PDFs.
  function maxPdfAt(invoice) {
    const nodes = invoice?.invoicePdfsByInvoiceId?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return 0;
    let max = 0;
    for (const n of nodes) {
      const t = n?.createdAt ? Date.parse(n.createdAt) : 0;
      if (t > max) max = t;
    }
    return max;
  }

  // Aplica el criterio sobre un objeto Invoice (común a dashboard y modal).
  // Retorna true si la factura está timbrada con PDF pre-timbre.
  function needsRegen(invoice, opts = {}) {
    if (!invoice) return false;
    const obj = invoice.steelheadObjectByInvoiceId;
    if (!obj) return false;
    const writtenAt = obj.writtenAt ? Date.parse(obj.writtenAt) : 0;
    if (!writtenAt) return false;
    if (invoice.voidedAt) return false;
    if (obj.voidSuccessfulAt) return false;
    if (maxPdfAt(invoice) >= writtenAt) return false;

    // Confirmación extra (modal): exigir uuid del SAT en createWriteResult
    if (opts.requireUuid) {
      const uuid = invoice?.createWriteResult?.data?.result?.writeResult?.uuid;
      if (!uuid) return false;
    }
    return true;
  }

  // Escanea respuesta de ActiveInvoicesPaged → array de candidatos
  function scanList(json) {
    const nodes = json?.data?.allInvoices?.nodes;
    if (!Array.isArray(nodes)) return [];
    const out = [];
    for (const inv of nodes) {
      if (needsRegen(inv)) {
        out.push({ invoiceId: inv.id, idInDomain: inv.idInDomain });
      }
    }
    return out;
  }

  // Escanea respuesta de InvoiceByIdInDomain → 0 o 1 candidato
  function scanSingle(json) {
    const inv = json?.data?.invoiceByIdInDomain;
    if (!inv) return [];
    if (!needsRegen(inv, { requireUuid: true })) return [];
    return [{ invoiceId: inv.id, idInDomain: inv.idInDomain }];
  }

  // ── Queue ──

  // Eventos: 'enqueued' | 'started' | 'done' | 'error'
  const listeners = { enqueued: [], started: [], done: [], error: [] };
  function on(event, fn) { listeners[event]?.push(fn); }
  function emit(event, payload) {
    for (const fn of (listeners[event] || [])) {
      try { fn(payload); } catch (e) { console.warn('[AutoRegen] listener error:', e); }
    }
  }

  function enqueue(items) {
    if (REGEN_DISABLED) {
      for (const item of items) {
        if (completedSet.has(item.invoiceId)) continue;
        if (state.has(item.invoiceId)) continue;
        completedSet.add(item.invoiceId);  // marca para no spamear logs
        console.log(`%c[AutoRegen KILL-SWITCH] Habría regenerado factura #${item.idInDomain} (id=${item.invoiceId}) — disparo deshabilitado para diagnóstico`, 'color:#a16207');
      }
      return;
    }
    for (const item of items) {
      const id = item.invoiceId;
      if (completedSet.has(id)) continue;          // ya regenerada esta sesión
      if (state.has(id)) continue;                  // ya en flight (pending/running/error)
      state.set(id, 'pending');
      queueArr.push(item);
      emit('enqueued', item);
    }
    if (!processing) processNext();
  }

  async function processNext() {
    if (processing) return;
    processing = true;
    try {
      while (queueArr.length > 0) {
        const item = queueArr.shift();
        state.set(item.invoiceId, 'running');
        emit('started', item);
        try {
          await runRegenerate(item);                // definida en Task 4
          state.set(item.invoiceId, 'done');
          completedSet.add(item.invoiceId);
          emit('done', item);
        } catch (err) {
          console.warn(`[AutoRegen] Error regenerando factura #${item.idInDomain} (id=${item.invoiceId}):`, err?.message || err);
          state.set(item.invoiceId, 'error');
          emit('error', { ...item, error: err });
        }
        await sleep(200);                            // espaciado serial
      }
    } finally {
      processing = false;
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Regenerator ──

  // Genera un filename con el mismo shape que usa Steelhead (`<timestamp>-<random>.pdf`)
  function generatePdfFilename() {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}.pdf`;
  }

  async function runRegenerate(item) {
    if (!api()) throw new Error('SteelheadAPI no disponible');

    const variables = {
      filename: generatePdfFilename(),
      invoiceId: item.invoiceId,
      isRevision: true
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const data = await Promise.race([
        api().query('CreateInvoicePdf', variables, 'CreateInvoicePdf'),
        new Promise((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('Timeout 15s en CreateInvoicePdf')));
        })
      ]);
      const pdfId = data?.createInvoicePdf?.invoicePdf?.id;
      if (!pdfId) throw new Error('Respuesta sin invoicePdf.id');
      console.log(`%c[AutoRegen] ✓ Factura #${item.idInDomain} regenerada → invoicePdf.id=${pdfId}`, 'color:#16a34a;font-weight:bold');
      return pdfId;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Row UI ──

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    pending: '<path d="M8 4v4l2.5 2.5" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5"/>',
    running: '<circle cx="8" cy="8" r="6" stroke-dasharray="20" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle>',
    done:    '<path d="M3 8.5l3.5 3.5L13 5" stroke-linecap="round" stroke-linejoin="round"/>',
    error:   '<path d="M8 4v5M8 11.5v.5" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5"/>'
  };
  const COLORS = { pending: '#6b7280', running: '#2563eb', done: '#16a34a', error: '#dc2626' };
  const TIPS = {
    pending: 'En cola para regenerar',
    running: 'Regenerando factura…',
    done:    'Regenerada',
    error:   'Error al regenerar (click reintenta)'
  };

  function buildBadge(state) {
    const wrap = document.createElement('span');
    wrap.className = 'sa-auto-regen-badge';
    wrap.dataset.saRegenState = state;
    wrap.title = TIPS[state] || '';
    wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:4px;vertical-align:middle;cursor:default;';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', COLORS[state]);
    svg.setAttribute('stroke-width', '1.6');
    // Rellenar SVG con el path correcto via temporary container (parser-safe)
    const tmp = document.createElementNS(SVG_NS, 'g');
    tmp.innerHTML = ICONS[state];
    while (tmp.firstChild) svg.appendChild(tmp.firstChild);
    wrap.appendChild(svg);
    return wrap;
  }

  // Encuentra la fila del dashboard correspondiente al idInDomain
  // Steelhead pinta cada fila con texto "#<idInDomain>" visible.
  // Buscamos el span/link con ese texto y subimos al row contenedor.
  function findDashboardRow(idInDomain) {
    const tag = `#${idInDomain}`;
    // Match exacto del texto del nodo
    const all = document.querySelectorAll('a, span, div');
    for (const el of all) {
      if (el.children.length === 0 && el.textContent && el.textContent.trim() === tag) {
        // Subir hasta el contenedor de la fila (heurística: buscar ancestro con varios hijos)
        let cur = el.parentElement;
        for (let i = 0; cur && i < 8; i++, cur = cur.parentElement) {
          if (cur.children.length >= 4) return cur;  // fila tiene varios elementos
        }
        return el.parentElement;
      }
    }
    return null;
  }

  // Inyecta o actualiza el badge en la fila. Si no existe la fila, no-op.
  function paintRow(idInDomain, state) {
    const row = findDashboardRow(idInDomain);
    if (!row) return;
    let badge = row.querySelector('.sa-auto-regen-badge');
    const newBadge = buildBadge(state);
    if (badge) {
      badge.replaceWith(newBadge);
    } else {
      // Insertar al inicio de la fila
      row.insertBefore(newBadge, row.firstChild);
    }
    if (state === 'done') {
      // Fade-out a 40% opacidad después de 5s
      setTimeout(() => {
        if (newBadge.isConnected) newBadge.style.opacity = '0.4';
      }, 5000);
    }
  }

  // Re-pinta los badges activos cuando Steelhead re-renderiza la tabla.
  let observer = null;
  function setupRowObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      for (const [invoiceId, st] of state.entries()) {
        if (st === 'done' && completedSet.has(invoiceId)) continue;  // ya pintada
        // Buscar item por invoiceId no es directo; usamos el set inverso
        const item = _itemByInvoiceId.get(invoiceId);
        if (!item) continue;
        const row = findDashboardRow(item.idInDomain);
        if (row && !row.querySelector('.sa-auto-regen-badge')) {
          paintRow(item.idInDomain, st);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Cache para encontrar idInDomain rápidamente al re-pintar
  const _itemByInvoiceId = new Map();
  function rememberItem(item) { _itemByInvoiceId.set(item.invoiceId, item); }

  // ── Modal Badge ──

  // Encuentra el header "Invoice History" en el modal abierto
  function findInvoiceHistoryHeader() {
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="heading"], [class*="title"]');
    for (const h of headings) {
      if (h.textContent && /invoice\s+history/i.test(h.textContent.trim())) return h;
    }
    return null;
  }

  function paintModal(state) {
    const header = findInvoiceHistoryHeader();
    if (!header) return;
    let badge = header.querySelector('.sa-auto-regen-badge');
    const newBadge = buildBadge(state);
    newBadge.style.marginLeft = '8px';
    if (badge) {
      badge.replaceWith(newBadge);
    } else {
      header.appendChild(newBadge);
    }
    if (state === 'done') {
      setTimeout(() => { if (newBadge.isConnected) newBadge.style.opacity = '0.4'; }, 5000);
    }
  }

  // ── Regen v2: secuencia completa replicando el click manual ──
  //
  // Click manual hace 4 pasos (capturados en logs 0.4.90):
  //   1. InvoiceByIdInDomain          → invoice completo (con createWriteResult del SAT)
  //   2. GetPdfConfigsByType          → pdfTemplateId activo
  //   3. GetPdfTemplateOutputToUserFile{docs:[{template,data:invoice}]}
  //                                   → renderiza PDF y SUBE binario a S3, devuelve filename
  //   4. CreateInvoicePdf{filename,invoiceId,isRevision:true}
  //                                   → crea record en BD apuntando al S3 ya subido
  //   5. AddCreatedPaymentOnInvoice   → post-step (no fatal)

  async function _callOp(opName, variables) {
    const fromRegistry = hashRegistry.get(opName);
    const fromConfig = api()?.getHash?.(opName);
    const hash = fromRegistry || fromConfig;
    if (!hash) {
      throw new Error(`No hash para ${opName}. Haz un click manual de regenerar primero para que el applet aprenda los hashes.`);
    }
    const body = {
      operationName: opName,
      variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: hash }
      }
    };
    const r = await fetch('https://app.gosteelhead.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} en ${opName}: ${text.substring(0, 300)}`);
    }
    const j = await r.json();
    if (j.errors && !j.data) {
      const msgs = (j.errors || []).map(e => e.message).join('; ');
      throw new Error(`GraphQL ${opName}: ${msgs.substring(0, 300)}`);
    }
    return j.data;
  }

  async function regenerateOne(invoiceId, idInDomain) {
    console.log(`%c[AutoRegen TEST] Iniciando regen factura #${idInDomain} (id=${invoiceId})`, 'color:#0891b2;font-weight:bold');

    const invData = await _callOp('InvoiceByIdInDomain', { idInDomain });
    const invoice = invData?.invoiceByIdInDomain;
    if (!invoice) throw new Error('InvoiceByIdInDomain devolvió null');
    console.log(`[AutoRegen TEST] 1/5 ✓ Invoice cargado (uuid SAT: ${invoice?.createWriteResult?.data?.result?.writeResult?.uuid || 'NO UUID'})`);

    const cfgData = await _callOp('GetPdfConfigsByType', { pdfType: 'INVOICE_TEMPLATE' });
    const pdfCfg = (cfgData?.allPdfConfigs?.nodes || []).find(n => n.isActive);
    if (!pdfCfg) throw new Error('No hay PdfConfig activo para INVOICE_TEMPLATE');
    console.log(`[AutoRegen TEST] 2/5 ✓ pdfTemplateId=${pdfCfg.pdfTemplateId}`);

    const renderData = await _callOp('GetPdfTemplateOutputToUserFile', {
      docs: [{ template: pdfCfg.pdfTemplateId, data: invoice }]
    });
    const filename = renderData?.pdfTemplateOutputToUserFile;
    if (!filename) throw new Error('Render no devolvió filename');
    console.log(`[AutoRegen TEST] 3/5 ✓ PDF renderizado y subido a S3 → ${filename}`);

    const createData = await _callOp('CreateInvoicePdf', {
      filename, invoiceId, isRevision: true
    });
    const pdfId = createData?.createInvoicePdf?.invoicePdf?.id;
    if (!pdfId) throw new Error('CreateInvoicePdf no devolvió id');
    console.log(`[AutoRegen TEST] 4/5 ✓ Record invoicePdf creado → id=${pdfId}`);

    try {
      await _callOp('AddCreatedPaymentOnInvoice', { invoiceIdInDomain: idInDomain });
      console.log(`[AutoRegen TEST] 5/5 ✓ AddCreatedPaymentOnInvoice OK`);
    } catch (e) {
      console.warn(`[AutoRegen TEST] 5/5 ⚠ AddCreatedPaymentOnInvoice falló (no fatal): ${e.message}`);
    }

    console.log(`%c[AutoRegen TEST] ✓ COMPLETADO factura #${idInDomain} — abre el modal y verifica que el PDF se vea con sello SAT`, 'color:#16a34a;font-weight:bold');
    return { pdfId, filename };
  }

  return { init, regenerateOne, _callOp, _hashRegistry: hashRegistry };
})();

if (typeof window !== 'undefined') {
  window.InvoiceAutoRegen = InvoiceAutoRegen;
  // Atajo en consola: regenerateInvoice(invoiceId, idInDomain)
  window.regenerateInvoice = (invoiceId, idInDomain) => InvoiceAutoRegen.regenerateOne(invoiceId, idInDomain);
  InvoiceAutoRegen.init();
}
