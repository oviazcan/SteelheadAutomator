// Steelhead Bulk Upload v9 — Pipeline de 9 pasos
// Migrado de dataLoader_v84.js a formato modular
// Depende de: SteelheadAPI (steelhead-api.js)

const BulkUpload = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let onProgress = () => {};
  function setProgressCallback(fn) { onProgress = fn; }

  // ═══════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════

  const toBool = (v) => { const s = (v || '').toString().trim().toUpperCase(); return s === 'SI' || s === 'SÍ' || s === 'YES' || s === '1' || s === 'TRUE'; };
  const isoDate = (d) => { const dt = new Date(); dt.setDate(dt.getDate() + d); return dt.toISOString(); };
  const g = (row, i) => {
    let v = (row[i] || '').trim().replace(/\s+/g, ' ');
    // Strip placeholder values from dropdowns
    if (v.startsWith('(') && v.endsWith(')')) return '';
    return v;
  };
  const gn = (row, i) => { const v = parseFloat(g(row, i)); return isNaN(v) ? null : v; };

  const PRICE_UNIT_MAP = { PZA: null, KGM: 3969, CMK: 4907, FTK: 4797, LM: 5150, LBR: 3972, LO: 5348 };

  // Predictive columns: AY=50 to BG=58 (shifted -1 from original)
  const PREDICTIVE_MATERIALS = [
    { col: 50, inventoryItemId: 364506, name: 'Plata Fina' },
    { col: 51, inventoryItemId: 397490, name: 'Estaño Puro' },
    { col: 52, inventoryItemId: 412305, name: 'Níquel Metálico' },
    { col: 53, inventoryItemId: 412805, name: 'Zinc Metálico' },
    { col: 54, inventoryItemId: 412479, name: 'Placa de Cobre Electrolítico' },
    { col: 55, inventoryItemId: 412723, name: 'Sterlingshield S (Antitarnish)' },
    { col: 56, inventoryItemId: 702767, name: 'Epoxy MT' },
    { col: 57, inventoryItemId: 702769, name: 'Epoxica BT' },
    { col: 58, inventoryItemId: 702768, name: 'Epoxica MT Red' },
  ];

  const DIVISA_SCHEMA = { type: "object", title: "", required: ["DatosPrecio"], properties: { DatosPrecio: { type: "object", title: "Datos del Precio", required: ["Divisa"], properties: { Divisa: { enum: ["USD", "MXN"], type: "string", title: "Divisa", enumNames: ["USD - Dolar americano", "MXN - Peso mexicano"] } }, dependencies: {} } }, dependencies: {} };
  const DIVISA_UI = { "ui:order": ["DatosPrecio"], DatosPrecio: { "ui:order": ["Divisa"], Divisa: { "ui:title": "Divisa" } } };

  const HEADER_KEYS = {
    'modo': 'modo',
    'nombre cotizacion': 'quoteName', 'nombre cotización': 'quoteName',
    'cliente': 'customer',
    'etiquetas cliente': 'customerLabels',
    'customer idindomain': 'customerIdInDomain',
    'proceso (default)': 'processName',
    'id proceso (default)': 'processId',
    'divisa (precios linea)': 'divisaLinea', 'divisa (precios línea)': 'divisaLinea',
    'empresa emisora': 'empresaEmisora',
    'divisa cotizacion': 'divisaCotizacion', 'divisa cotización': 'divisaCotizacion',
    'notas externas': 'notasExternas',
    'notas internas': 'notasInternas',
    'asignado': 'asignado',
    'valida hasta (dias)': 'validaDias', 'válida hasta (días)': 'validaDias',
  };

  // ═══════════════════════════════════════════
  // CSV PARSER
  // ═══════════════════════════════════════════

  function parseCSV(t) {
    const rows = []; let i = 0;
    while (i < t.length) {
      const row = [];
      while (i < t.length) {
        if (t[i] === '"') {
          i++; let v = '';
          while (i < t.length) {
            if (t[i] === '"') { if (t[i + 1] === '"') { v += '"'; i += 2; } else { i++; break; } }
            else { v += t[i]; i++; }
          }
          row.push(v);
        } else {
          let v = '';
          while (i < t.length && t[i] !== ',' && t[i] !== '\r' && t[i] !== '\n') { v += t[i]; i++; }
          row.push(v);
        }
        if (t[i] === ',') { i++; continue; } else break;
      }
      if (t[i] === '\r') i++;
      if (t[i] === '\n') i++;
      rows.push(row);
    }
    return rows;
  }

  function parseRows(rows) {
    const header = {};
    const parts = [];
    for (const row of rows) {
      const colA = (row[0] || '').trim();
      const keyNorm = colA.replace(/:$/, '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const keyAcc = colA.replace(/:$/, '').trim().toLowerCase();
      const hk = HEADER_KEYS[keyAcc] || HEADER_KEYS[keyNorm];
      if (hk) { header[hk] = (row[2] || '').trim(); continue; }

      const pn = g(row, 4);
      const qty = gn(row, 7);
      if (!pn) continue; // PN is required; qty can be null in SOLO_PN mode

      const products = [];
      // S=18(P1), W=22(P2), AA=26(P3)
      for (const b of [18, 22, 26]) {
        const nm = g(row, b);
        if (nm) products.push({ name: nm, price: gn(row, b + 1) || 0, qty: gn(row, b + 2) || 1, unit: g(row, b + 3) });
      }

      const specs = [];
      // AE=30(Spec1), AF=31(Esp1), AG=32(Spec2), AH=33(Esp2)
      for (const [specIdx, espIdx] of [[30, 31], [32, 33]]) {
        const raw = g(row, specIdx);
        if (!raw) continue;
        if (raw.includes(' | ')) { const s = raw.indexOf(' | '); specs.push({ name: raw.substring(0, s).trim(), param: raw.substring(s + 3).trim() }); }
        else specs.push({ name: raw, param: '' });
      }

      const racks = [];
      // AM=38(Rack Línea), AN=39(Pzas), AO=40(Rack Sec), AP=41(Pzas)
      if (g(row, 38)) racks.push({ name: g(row, 38), ppr: gn(row, 39) });
      if (g(row, 40)) racks.push({ name: g(row, 40), ppr: gn(row, 41) });

      const predictiveUsage = [];
      for (const mat of PREDICTIVE_MATERIALS) {
        const val = gn(row, mat.col);
        if (val !== null && val > 0) predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: String(val), name: mat.name });
      }

      parts.push({
        pn, qty,
        precio: gn(row, 8),           // I=8
        descripcion: g(row, 11),       // L=11
        procesoOverride: g(row, 17),   // R=17
        labels: [g(row, 13), g(row, 14), g(row, 15), g(row, 16)].filter(Boolean), // N-Q
        products, specs,
        unitConv: { kgm: gn(row, 34), cmk: gn(row, 35), lm: gn(row, 36), minPzasLote: gn(row, 37) }, // AI-AL
        racks,
        dims: { length: gn(row, 42), width: gn(row, 43), height: gn(row, 44), outerDiam: gn(row, 45), innerDiam: gn(row, 46) }, // AQ-AU
        metalBase: g(row, 12),         // M=12
        pnAlterno: g(row, 5),         // F=5
        codigoSAT: g(row, 49),        // AX=49
        pnGroup: g(row, 6),           // G=6
        archivado: toBool(g(row, 0)),  // A=0
        precioDefault: toBool(g(row, 10)), // K=10
        forzarDuplicado: toBool(g(row, 2)), // C=2
        archivarAnterior: toBool(g(row, 3)), // D=3
        unidadPrecio: g(row, 9).toUpperCase(), // J=9
        predictiveUsage,
        validacion1er: toBool(g(row, 1)), // B=1
        linea: g(row, 47),            // AV=47
        departamento: g(row, 48),      // AW=48
        quoteIBMS: g(row, 59),        // BH=59
        estacionIBMS: g(row, 60),     // BI=60
        plano: g(row, 61),            // BJ=61
        piezasCarga: gn(row, 62),     // BK=62
        cargasHora: g(row, 63),       // BL=63
        tiempoEntrega: gn(row, 64),   // BM=64
        notasAdicionalesPN: g(row, 65), // BN=65
      });
    }
    return { header, parts };
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════

  let unitNodes = [];
  const resolveUnitId = (abbr) => {
    if (!abbr) return null;
    const u = abbr.toUpperCase().trim();
    const m = unitNodes.find(x => x.name.toUpperCase().startsWith(u + ' ') || x.name.toUpperCase() === u);
    if (m) return m.id;
    const f = unitNodes.find(x => x.name.toUpperCase().includes(u));
    if (f) return f.id;
    warn(`Unit "${abbr}" no encontrada.`);
    return null;
  };

  function buildDimensions(dims, DOMAIN) {
    const out = [];
    const map = [['length', DOMAIN.geometryDimensions.LENGTH], ['width', DOMAIN.geometryDimensions.WIDTH], ['height', DOMAIN.geometryDimensions.HEIGHT], ['outerDiam', DOMAIN.geometryDimensions.OUTER_DIAM], ['innerDiam', DOMAIN.geometryDimensions.INNER_DIAM]];
    for (const [key, id] of map) {
      if (dims[key] !== null && dims[key] !== undefined) out.push({ geometryTypeDimensionTypeId: id, unitId: DOMAIN.unitIds.MTR, dimensionValue: dims[key] });
    }
    return out;
  }

  // Guión (-) comodín: vacío = no tocar, valor = sobrescribir, "-" = borrar
  const isDash = (v) => v === '-';
  const resolveStr = (raw, existing) => {
    if (raw === '' || raw === undefined) return existing; // no tocar
    if (isDash(raw)) return ''; // borrar
    return raw; // sobrescribir
  };
  const resolveNum = (raw, existing) => {
    if (raw === null || raw === undefined) return existing;
    if (typeof raw === 'string' && isDash(raw)) return null;
    return raw;
  };

  function mergeCustomInputs(existing, part) {
    const ci = existing ? JSON.parse(JSON.stringify(existing)) : {};

    // DatosFacturacion
    if (part.codigoSAT) {
      if (!ci.DatosFacturacion) ci.DatosFacturacion = {};
      ci.DatosFacturacion.CodigoSAT = isDash(part.codigoSAT) ? '' : part.codigoSAT;
    }

    // DatosAdicionalesNP
    if (part.metalBase || part.pnAlterno || part.quoteIBMS || part.estacionIBMS || part.plano) {
      if (!ci.DatosAdicionalesNP) ci.DatosAdicionalesNP = {};
      if (part.metalBase) ci.DatosAdicionalesNP.BaseMetal = isDash(part.metalBase) ? '' : part.metalBase;
      if (part.pnAlterno) {
        ci.DatosAdicionalesNP.NumeroParteAlterno = isDash(part.pnAlterno)
          ? [] : part.pnAlterno.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (part.quoteIBMS) ci.DatosAdicionalesNP.QuoteIBMS = isDash(part.quoteIBMS) ? '' : part.quoteIBMS;
      if (part.estacionIBMS) ci.DatosAdicionalesNP.EstacionIBMS = isDash(part.estacionIBMS) ? '' : part.estacionIBMS;
      if (part.plano) ci.DatosAdicionalesNP.Plano = isDash(part.plano) ? '' : part.plano;
    }

    // DatosPlanificacion
    if (part.piezasCarga !== null || part.cargasHora || part.tiempoEntrega !== null) {
      if (!ci.DatosPlanificacion) ci.DatosPlanificacion = {};
      if (part.piezasCarga !== null) ci.DatosPlanificacion.PiezasCarga = isDash(String(part.piezasCarga)) ? null : part.piezasCarga;
      if (part.cargasHora) ci.DatosPlanificacion.CargasHora = isDash(part.cargasHora) ? '' : part.cargasHora;
      if (part.tiempoEntrega !== null) ci.DatosPlanificacion.TiempoEntrega = isDash(String(part.tiempoEntrega)) ? null : part.tiempoEntrega;
    }

    // NotasAdicionales (top level in customInputs)
    if (part.notasAdicionalesPN) {
      ci.NotasAdicionales = isDash(part.notasAdicionalesPN) ? '' : part.notasAdicionalesPN;
    }

    return Object.keys(ci).length > 0 ? ci : null;
  }

  async function checkPNExistence(parts) {
    const uniq = [...new Set(parts.map(p => p.pn.toUpperCase()))];
    const existMap = new Map();
    log(`Buscando ${uniq.length} PNs...`);
    for (const name of uniq) {
      try {
        const d = await api().query('SearchPartNumbers', { searchQuery: name, first: 20, offset: 0, orderBy: ['ID_DESC'] });
        const nodes = d?.searchPartNumbers?.nodes || d?.pagedData?.nodes || [];
        const match = nodes.find(n => n.name?.toUpperCase() === name && !n.archivedAt);
        if (match) { existMap.set(name, { id: match.id }); log(`  "${name}" -> EXISTE id:${match.id}`); }
        else log(`  "${name}" -> NUEVO (${nodes.length} resultados, ninguno coincide exacto+activo)`);
      } catch (e) { warn(`Búsqueda "${name}": ${String(e).substring(0, 120)}`); }
    }
    return parts.map(p => {
      const key = p.pn.toUpperCase(); const ex = existMap.get(key);
      if (!ex) return { pn: p.pn, status: 'new', existingId: null, qty: p.qty, precio: p.precio };
      if (p.forzarDuplicado) return { pn: p.pn, status: 'forceDup', existingId: ex.id, qty: p.qty, precio: p.precio };
      return { pn: p.pn, status: 'existing', existingId: ex.id, qty: p.qty, precio: p.precio };
    });
  }

  // ═══════════════════════════════════════════
  // MODAL UI
  // ═══════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('dl9-styles')) return;
    const s = document.createElement('style'); s.id = 'dl9-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-modal h3{font-size:14px;margin:16px 0 6px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}.dl9-modal .dl9-sub{color:#64748b;font-size:13px;margin-bottom:16px}.dl9-modal table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}.dl9-modal th{text-align:left;padding:4px 8px;color:#94a3b8;border-bottom:1px solid #334155;font-weight:500}.dl9-modal td{padding:4px 8px;border-bottom:1px solid #1e293b}.dl9-new{color:#4ade80}.dl9-exist{color:#facc15}.dl9-dup{color:#f97316}.dl9-err{color:#f87171}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.2s}.dl9-btn:hover{opacity:0.85}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#2563eb;color:white}.dl9-btn-close{background:#475569;color:#e2e8f0}.dl9-btn-copy{background:#0d9488;color:white}.dl9-progress{font-size:13px;color:#94a3b8;margin-top:8px;white-space:pre-wrap;line-height:1.6}.dl9-bar{height:4px;background:#334155;border-radius:2px;margin:8px 0;overflow:hidden}.dl9-bar-fill{height:100%;background:#2563eb;transition:width 0.3s;width:0%}.dl9-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}.dl9-stat{background:#0f172a;padding:8px 12px;border-radius:6px;font-size:13px}.dl9-stat b{color:#38bdf8}`;
    document.head.appendChild(s);
  }

  function createOverlay() { const ov = document.createElement('div'); ov.className = 'dl9-overlay'; const md = document.createElement('div'); md.className = 'dl9-modal'; ov.appendChild(md); document.body.appendChild(ov); return { overlay: ov, modal: md }; }
  function removeOverlay(ov) { if (ov?.parentNode) ov.parentNode.removeChild(ov); }

  function showPreview(header, parts, pnStatus, info, isSoloPN) {
    return new Promise(resolve => {
      injectStyles(); const { overlay, modal } = createOverlay();
      const nc = pnStatus.filter(s => s.status === 'new').length, ec = pnStatus.filter(s => s.status === 'existing').length, dc = pnStatus.filter(s => s.status === 'forceDup').length;

      // Build detail of what will be modified for each PN
      let pnR = '';
      for (let i = 0; i < pnStatus.length; i++) {
        const s = pnStatus[i]; const part = parts[i];
        const cls = s.status === 'new' ? 'dl9-new' : s.status === 'existing' ? 'dl9-exist' : 'dl9-dup';
        const lbl = s.status === 'new' ? 'CREAR NUEVO' : s.status === 'existing' ? `MODIFICAR (id:${s.existingId})` : `DUPLICAR (viejo:${s.existingId})`;

        // Summary of what data will be applied
        const changes = [];
        if (part.labels.length) changes.push(`${part.labels.length} labels`);
        if (part.specs.length) changes.push(`${part.specs.length} specs`);
        if (part.racks.length) changes.push(`${part.racks.length} racks`);
        if (part.dims.length !== undefined || Object.values(part.dims).some(v => v !== null)) changes.push('dims');
        if (part.predictiveUsage.length) changes.push('predictive');
        if (part.unitConv.kgm !== null || part.unitConv.cmk !== null || part.unitConv.lm !== null) changes.push('unitConv');
        if (part.metalBase || part.pnAlterno || part.codigoSAT) changes.push('CI');
        if (part.validacion1er) changes.push('optIn');
        if (!isSoloPN && part.products.length) changes.push(`${part.products.length} products`);
        if (!isSoloPN) changes.push(`qty:${part.qty}`);
        const changeSummary = changes.length ? changes.join(', ') : 'solo crear';

        pnR += `<tr>
          <td><input type="checkbox" checked class="dl9-check" data-idx="${i}"></td>
          <td>${s.pn}</td>
          <td class="${cls}">${lbl}</td>
          <td style="font-size:11px;color:#94a3b8">${changeSummary}</td>
          ${isSoloPN ? '' : `<td>${s.qty}</td><td>${s.precio ?? '-'}</td>`}
        </tr>`;
      }

      // Mode-specific styling and content
      const modeColor = isSoloPN ? '#0d9488' : '#2563eb'; // teal for SOLO_PN, blue for COTIZACIÓN
      const modeBg = isSoloPN ? '#0f2e2c' : '#1e293b';
      const modeLabel = isSoloPN ? 'SOLO NÚMEROS DE PARTE' : 'COTIZACIÓN + NP';

      const statsHtml = isSoloPN
        ? `<div class="dl9-stats">
            <div class="dl9-stat"><b>Cliente:</b> ${info.customerName || '?'}</div>
            <div class="dl9-stat"><b>Proceso:</b> ${info.processName || '?'}</div>
           </div>`
        : `<div class="dl9-stats">
            <div class="dl9-stat"><b>Cotización:</b> ${header.quoteName || '?'}</div>
            <div class="dl9-stat"><b>Cliente:</b> ${info.customerName || '?'}</div>
            <div class="dl9-stat"><b>Asignado:</b> ${info.assigneeName || '(auto)'}</div>
            <div class="dl9-stat"><b>Proceso:</b> ${info.processName || '?'}</div>
            <div class="dl9-stat"><b>Divisa:</b> ${header.divisaLinea || 'USD'}</div>
            <div class="dl9-stat"><b>Empresa:</b> ${header.empresaEmisora || 'ECO'}</div>
           </div>`;

      const tableHeaders = isSoloPN
        ? '<th><input type="checkbox" checked id="dl9-select-all"></th><th>PN</th><th>Acción</th><th>Datos a aplicar</th>'
        : '<th><input type="checkbox" checked id="dl9-select-all"></th><th>PN</th><th>Acción</th><th>Datos</th><th>Qty</th><th>Precio</th>';

      modal.style.background = modeBg;
      modal.innerHTML = `
        <h2 style="color:${modeColor}">Steelhead Automator v9 — ${modeLabel}</h2>
        <p class="dl9-sub">${nc} nuevos, ${ec} ${isSoloPN ? 'a modificar' : 'existentes'}, ${dc} forzar dup</p>
        ${statsHtml}
        <h3>Part Numbers (${parts.length}) — desmarca los que NO quieras procesar:</h3>
        <div style="max-height:250px;overflow-y:auto">
          <table><tr>${tableHeaders}</tr>${pnR}</table>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="dl9-cancel">CANCELAR</button>
          <button class="dl9-btn" id="dl9-exec" style="background:${modeColor};color:white">EJECUTAR (<span id="dl9-count">${parts.length}</span> PNs)</button>
        </div>`;

      // Select all checkbox
      document.getElementById('dl9-select-all').onchange = (e) => {
        modal.querySelectorAll('.dl9-check').forEach(cb => { cb.checked = e.target.checked; });
        updateCount();
      };

      // Individual checkboxes update count
      modal.querySelectorAll('.dl9-check').forEach(cb => { cb.onchange = updateCount; });

      function updateCount() {
        const checked = modal.querySelectorAll('.dl9-check:checked').length;
        document.getElementById('dl9-count').textContent = checked;
      }

      document.getElementById('dl9-cancel').onclick = () => { removeOverlay(overlay); resolve(false); };
      document.getElementById('dl9-exec').onclick = () => {
        // Build array of selected indices
        const selected = [];
        modal.querySelectorAll('.dl9-check:checked').forEach(cb => {
          selected.push(parseInt(cb.dataset.idx));
        });
        removeOverlay(overlay);
        resolve(selected);
      };
    });
  }

  function showProgressUI(msg) {
    let ov = document.getElementById('dl9-progress-overlay');
    if (!ov) {
      injectStyles(); ov = document.createElement('div'); ov.className = 'dl9-overlay'; ov.id = 'dl9-progress-overlay';
      ov.innerHTML = `<div class="dl9-modal"><h2>Ejecutando...</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="dl9-bar"></div></div><div class="dl9-progress" id="dl9-progress-text"></div></div>`;
      document.body.appendChild(ov);
    }
    const el = document.getElementById('dl9-progress-text');
    if (el) el.textContent += msg + '\n';
  }

  function setProgressBar(p) { const b = document.getElementById('dl9-bar'); if (b) b.style.width = p + '%'; }

  function showResult(stats, quoteUrl, errors) {
    const po = document.getElementById('dl9-progress-overlay'); if (po) removeOverlay(po);
    injectStyles(); const { overlay, modal } = createOverlay();
    const errH = errors.length ? `<h3 class="dl9-err">Errores (${errors.length})</h3><div style="max-height:150px;overflow-y:auto;font-size:12px;color:#f87171;white-space:pre-wrap">${errors.join('\n')}</div>` : '';
    modal.innerHTML = `<h2>${errors.length ? 'Completado con errores' : 'Completado OK'}</h2><div class="dl9-stats"><div class="dl9-stat"><b>Quote:</b> ${stats.quoteName} (#${stats.quoteIdInDomain})</div><div class="dl9-stat"><b>PNs creados:</b> ${stats.pnsCreated}</div><div class="dl9-stat"><b>PNs existentes:</b> ${stats.pnsExisting}</div><div class="dl9-stat"><b>Duplicados:</b> ${stats.pnsDuplicated}</div><div class="dl9-stat"><b>Products:</b> ${stats.productsSet}</div><div class="dl9-stat"><b>Labels:</b> ${stats.labelsSet}</div><div class="dl9-stat"><b>Specs:</b> ${stats.specsSet}</div><div class="dl9-stat"><b>UnitConv:</b> ${stats.unitConvSet}</div><div class="dl9-stat"><b>Racks:</b> ${stats.racksSet}</div><div class="dl9-stat"><b>CI:</b> ${stats.ciSet}</div><div class="dl9-stat"><b>Dims:</b> ${stats.dimsSet}</div><div class="dl9-stat"><b>PredUsage:</b> ${stats.predictiveSet}</div><div class="dl9-stat"><b>Default Price:</b> ${stats.defaultPriceSet}</div><div class="dl9-stat"><b>Archivados:</b> ${stats.archived}</div><div class="dl9-stat"><b>Ant.archivados:</b> ${stats.oldArchived}</div><div class="dl9-stat"><b>Valid.1erRecibo:</b> ${stats.validacionSet}</div></div>${errH}<div class="dl9-btnrow"><button class="dl9-btn dl9-btn-copy" id="dl9-copy-log">COPIAR LOG</button>${quoteUrl ? `<a href="${quoteUrl}" class="dl9-btn dl9-btn-exec" style="text-decoration:none" target="_blank">ABRIR COTIZACIÓN</a>` : ''}<button class="dl9-btn dl9-btn-close" id="dl9-close">CERRAR</button></div>`;
    document.getElementById('dl9-close').onclick = () => removeOverlay(overlay);
    document.getElementById('dl9-copy-log').onclick = () => { navigator.clipboard.writeText(api().getLog().join('\n')).then(() => alert('Log copiado.')).catch(() => { const w = window.open('', '_blank'); w.document.write('<pre>' + api().getLog().join('\n') + '</pre>'); }); };
  }

  // ═══════════════════════════════════════════
  // MAIN PIPELINE — 9 STEPS
  // ═══════════════════════════════════════════

  async function execute(csvText) {
    const DOMAIN = api().getDomain();
    const errors = [];
    const stats = { quoteName: '', quoteIdInDomain: 0, pnsCreated: 0, pnsExisting: 0, pnsDuplicated: 0, productsSet: 0, labelsSet: 0, specsSet: 0, unitConvSet: 0, racksSet: 0, ciSet: 0, dimsSet: 0, defaultPriceSet: 0, archived: 0, oldArchived: 0, predictiveSet: 0, validacionSet: 0 };

    try {
      log('Steelhead Automator v9 — iniciando...');

      // Parse CSV
      const csvClean = csvText.replace(/^\uFEFF/, '');
      const { header, parts } = parseRows(parseCSV(csvClean));
      log(`CSV: ${parts.length} partes, header: ${Object.keys(header).join(', ')}`);
      if (!parts.length) throw new Error('No se encontraron filas de datos.');

      const modo = (header.modo || '').toUpperCase();
      const isSoloPN = modo.includes('SOLO');
      const quoteName = header.quoteName || '';
      if (!isSoloPN) {
        if (!quoteName) throw new Error('Falta "Nombre Cotización" en header.');
        const sinQty = parts.filter(p => p.qty === null);
        if (sinQty.length) throw new Error(`Modo COTIZACIÓN+NP requiere Cantidad en todas las filas. ${sinQty.length} filas sin cantidad: ${sinQty.slice(0, 3).map(p => p.pn).join(', ')}...`);
      }
      stats.quoteName = isSoloPN ? '(SOLO_PN)' : quoteName;
      log(`Modo: ${isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP'} ${isSoloPN ? '' : '— "' + quoteName + '"'}`);

      // ── Resolve customer ──
      const customerRaw = header.customer || '';
      const customerName = customerRaw.split(/\s*[\u2014\u2013]\s*|\s+[-]\s+/)[0].trim();
      if (!customerName) throw new Error('Falta Cliente.');
      const custData = await api().query('CustomerSearchByName', { nameLike: `%${customerName}%`, orderBy: ['NAME_ASC'] });
      const custNodes = custData?.searchCustomers?.nodes || custData?.pagedData?.nodes || custData?.allCustomers?.nodes || [];
      const customer = custNodes.find(c => c.name?.toUpperCase().includes(customerName.toUpperCase()));
      if (!customer) throw new Error(`Cliente "${customerName}" no encontrado.`);
      const customerId = customer.id;
      log(`  Cliente: ${customer.name} (${customerId})`);

      // ── Related data ──
      const relData = await api().query('GetQuoteRelatedData', { customerId });
      const custAddr = relData?.customerById?.customerAddressesByCustomerId?.nodes || [];
      const custCont = relData?.customerById?.customerContactsByCustomerId?.nodes || [];
      const customerAddressId = custAddr[0]?.id || null;
      const customerContactId = custCont[0]?.id || null;

      let invoiceTermsId = null;
      try { const fin = await api().query('CustomerFinancialByCustomerId', { id: customerId }, 'CustomerFinancialById'); invoiceTermsId = fin?.customerById?.invoiceTermsId || null; } catch (e) { warn(`CustomerFinancial: ${String(e).substring(0, 80)}`); }
      if (!invoiceTermsId) {
        try { const t = await api().query('SearchInvoiceTerms', { termsLike: '%%' }); const tn = t?.allInvoiceTerms?.nodes || t?.pagedData?.nodes || t?.searchInvoiceTerms?.nodes || []; if (tn.length) invoiceTermsId = tn[0].id; } catch (e) { warn(`SearchInvoiceTerms: ${String(e).substring(0, 80)}`); }
      }
      log(`  Addr:${customerAddressId} Cont:${customerContactId} Terms:${invoiceTermsId}`);

      // ── Assignee ──
      let assigneeId = null, assigneeName = '';
      if (header.asignado) {
        const ud = await api().query('SearchUsers', { searchQuery: header.asignado, first: 500 });
        const un = ud?.searchUsers?.nodes || ud?.pagedData?.nodes || [];
        const u = un.find(u => (u.name || u.fullName || '').toUpperCase().includes(header.asignado.toUpperCase()));
        if (u) { assigneeId = u.id; assigneeName = u.name || u.fullName || ''; }
        else warn(`Asignado "${header.asignado}" no encontrado.`);
      }
      log(`  Asignado: ${assigneeName || '(ninguno)'}`);

      // ── Process ──
      let defaultProcessId = null, defaultProcessName = '';
      if (header.processId) { defaultProcessId = parseInt(header.processId); defaultProcessName = `id:${defaultProcessId}`; }
      else if (header.processName) {
        const pd = await api().query('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: `%${header.processName}%`, first: 500 });
        const pn2 = pd?.allProcessNodes?.nodes || pd?.pagedData?.nodes || [];
        const pr = pn2.find(p => p.name?.toUpperCase().includes(header.processName.toUpperCase()));
        if (pr) { defaultProcessId = pr.id; defaultProcessName = pr.name; }
      }
      log(`  Proceso: ${defaultProcessName} (${defaultProcessId})`);

      // ── Catalogs ──
      log('Cargando catálogos...');
      const [labelsD, specsD, racksD, unitsD, productsD, groupsD] = await Promise.all([
        api().query('AllLabels', { condition: { forPartNumber: true } }),
        api().query('SearchSpecsForSelect', { like: '%%', locationIds: [], alreadySelectedSpecs: [], orderBy: ['NAME_ASC'] }),
        api().query('AllRackTypes', {}),
        api().query('SearchUnits', {}),
        api().query('SearchProducts', { searchQuery: '%%', first: 500 }),
        api().query('PartNumberGroupSelect', { partNumberGroupLike: '%%', first: 500 }, 'PNGroupSelect').catch(() => api().query('PartNumberGroupSelect', {}, 'PNGroupSelect')).catch(() => null),
      ]);

      const labelByName = new Map(); for (const l of (labelsD?.allLabels?.nodes || [])) labelByName.set(l.name, l.id);
      const specByName = new Map(); for (const s of (specsD?.searchSpecs?.nodes || [])) specByName.set(s.name, s);
      const rackTypeByName = new Map(); for (const rt of (racksD?.pagedData?.nodes || racksD?.allRackTypes?.nodes || [])) rackTypeByName.set(rt.name, rt);
      unitNodes = unitsD?.pagedData?.nodes || unitsD?.searchUnits?.nodes || [];
      const productByName = new Map(); for (const p of (productsD?.searchProducts?.nodes || productsD?.pagedData?.nodes || [])) productByName.set(p.name, p);
      const groupByName = new Map();
      if (groupsD) { const gn2 = groupsD?.allPartNumberGroups?.nodes || groupsD?.pagedData?.nodes || groupsD?.partNumberGroups?.nodes || []; for (const gg of gn2) groupByName.set(gg.name, gg.id); }
      log(`  ${labelByName.size} labels, ${specByName.size} specs, ${rackTypeByName.size} racks, ${unitNodes.length} units, ${productByName.size} products, ${groupByName.size} groups`);

      // Load dimension value maps (Línea/Departamento → ID)
      const dimValueMap = new Map(); // "valor" → id
      const dimIds = DOMAIN.dimensionIds || {};
      for (const dimId of Object.values(dimIds)) {
        try {
          const dd = await api().query('GetDimension', { id: dimId, includeArchived: 'NO' });
          const nodes = dd?.acctDimensionById?.acctDimensionCustomValuesByDimensionId?.nodes || [];
          for (const n of nodes) { if (n.value && !n.archivedAt) dimValueMap.set(n.value.trim(), n.id); }
        } catch (_) {}
      }
      log(`  ${dimValueMap.size} dimensiones contables cargadas`);

      // Group resolver
      async function resolveGroupId(name) {
        if (!name) return null; const n = name.trim(); if (!n) return null;
        const existing = groupByName.get(n); if (existing) return existing;
        try {
          // Try {input:{name}} first, fallback to {name} if schema changed
          let res;
          try { res = await api().query('CreatePartNumberGroup', { input: { name: n } }); }
          catch (_) { res = await api().query('CreatePartNumberGroup', { name: n }); }
          const id = res?.createPartNumberGroup?.partNumberGroup?.id;
          if (id) { groupByName.set(n, id); log(`  Grupo "${n}" creado id:${id}`); return id; }
        } catch (e) { warn(`Crear grupo "${n}": ${String(e).substring(0, 100)}`); }
        return null;
      }

      // Spec fields cache
      const uniqueSpecs = new Set(); for (const p of parts) for (const s of p.specs) uniqueSpecs.add(s.name);
      const sfCache = new Map();
      for (const sn of uniqueSpecs) {
        const si = specByName.get(sn); if (!si) { warn(`Spec "${sn}" no encontrada.`); continue; }
        if (!sfCache.has(si.id)) {
          const d = await api().query('TempSpecFieldsAndOptions', { specId: si.id });
          const sd = d?.specById; if (sd) { sfCache.set(si.id, sd); log(`  Spec "${sn}": ${sd.specFieldSpecsBySpecId?.nodes?.length || 0} campos`); }
        }
      }

      // ── PN existence check ──
      const pnStatus = await checkPNExistence(parts);

      // ── Metal Base validation ──
      const metalBaseEnum = ['Cobre', 'Aluminio', 'Fierro', 'Latón', 'Acero Inoxidable', 'Bronce', 'Bimetálica', 'Acero al Carbón', 'Zamak', 'Varios'];
      const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const newMetals = new Set();
      for (const part of parts) {
        if (!part.metalBase || isDash(part.metalBase)) continue;
        const exact = metalBaseEnum.find(m => m === part.metalBase);
        if (exact) continue;
        const fuzzy = metalBaseEnum.find(m => normalize(m) === normalize(part.metalBase));
        if (fuzzy) {
          log(`  Metal Base "${part.metalBase}" → corregido a "${fuzzy}" (fuzzy match)`);
          part.metalBase = fuzzy;
        } else {
          newMetals.add(part.metalBase);
        }
      }
      let createMetals = false;
      if (newMetals.size > 0) {
        createMetals = confirm(
          `Metal Base: los siguientes valores NO existen en el catálogo de Steelhead:\n\n` +
          [...newMetals].join('\n') + '\n\n' +
          `Valores actuales: ${metalBaseEnum.join(', ')}\n\n` +
          `¿Agregar al catálogo? (Aceptar = Sí, Cancelar = No, se cargan como texto libre)`
        );
        if (createMetals) {
          log(`  Creando nuevos Metal Base: ${[...newMetals].join(', ')}`);
        }
      }

      // ── Grupo PN validation (fuzzy + crear si no existe) ──
      const existingGroups = [...groupByName.keys()];
      const newGroups = new Set();
      for (const part of parts) {
        if (!part.pnGroup || isDash(part.pnGroup)) continue;
        const exact = existingGroups.find(g => g === part.pnGroup);
        if (exact) continue;
        const fuzzy = existingGroups.find(g => normalize(g) === normalize(part.pnGroup));
        if (fuzzy) {
          log(`  Grupo "${part.pnGroup}" → corregido a "${fuzzy}" (fuzzy match)`);
          part.pnGroup = fuzzy;
        } else {
          newGroups.add(part.pnGroup);
        }
      }
      if (newGroups.size > 0) {
        const createGroups = confirm(
          `Grupos de PN: los siguientes NO existen en Steelhead:\n\n` +
          [...newGroups].join('\n') + '\n\n' +
          `Se crearán automáticamente al ejecutar. ¿Continuar?`
        );
        if (!createGroups) {
          // Remove unknown groups from parts
          for (const part of parts) {
            if (newGroups.has(part.pnGroup)) part.pnGroup = '';
          }
          log('  Grupos nuevos cancelados por usuario');
        } else {
          log(`  Grupos nuevos a crear: ${[...newGroups].join(', ')}`);
        }
      }

      // ── Preview ──
      const selectedIndices = await showPreview(header, parts, pnStatus, { customerName: customer.name, assigneeName, processName: defaultProcessName }, isSoloPN);
      if (!selectedIndices) { log('Cancelado por usuario.'); return { cancelled: true }; }

      // Filter parts and pnStatus to only selected indices
      if (Array.isArray(selectedIndices) && selectedIndices.length < parts.length) {
        const selSet = new Set(selectedIndices);
        const filteredParts = []; const filteredStatus = [];
        for (let i = 0; i < parts.length; i++) {
          if (selSet.has(i)) { filteredParts.push(parts[i]); filteredStatus.push(pnStatus[i]); }
        }
        log(`  ${filteredParts.length}/${parts.length} PNs seleccionados por usuario`);
        parts.length = 0; parts.push(...filteredParts);
        pnStatus.length = 0; pnStatus.push(...filteredStatus);
      }

      // ── Create new Metal Base values if confirmed ──
      if (createMetals && newMetals.size > 0) {
        showProgressUI('Actualizando catálogo de Metal Base...');
        try {
          const updatedEnum = [...metalBaseEnum, ...newMetals];
          const fullSchema = {
            inputSchema: {
              type: "object", title: "", required: [], description: "", dependencies: {},
              properties: {
                DatosAdicionalesNP: {
                  type: "object", title: "Datos Adicionales de Número de Parte", required: [], description: "", dependencies: {},
                  properties: {
                    BaseMetal: { enum: updatedEnum, type: "string", title: "Metal Base" },
                    NumeroParteAlterno: { type: "array", items: { type: "string", title: "Número de Parte Alterno", description: "Número de Parte Alterno" }, title: "Número de Parte Alterno" },
                    QuoteIBMS: { type: "string", title: "Quote en IBMS" },
                    EstacionIBMS: { type: "string", title: "Número de Estación en IBMS (Est.)" },
                    Plano: { type: "string", title: "Número de Plano" }
                  }
                },
                DatosFacturacion: {
                  type: "object", title: "Datos de Facturación", required: [], dependencies: {},
                  properties: {
                    CodigoSAT: { enum: ["73181106 - Servicios de enchapado", "73181109 - Servicios de niquelado", "73181119 - Servicio de recubrimiento con pintura en polvo", "73151500 - Servicios de ensamble", "73151506 - Servicio de subensamble o ensamble definitivo", "11191500 - Cuerpos sólidos de metal", "30262200 - Barras de cobre", "31281500 - Componentes estampados", "31281813 - Componentes de cobre perforados", "39121400 - Lengüetas de conexión, conectadores y terminales"], type: "string", title: "Código SAT" }
                  }
                },
                DatosPlanificacion: {
                  type: "object", title: "Datos de Planificación", required: [], dependencies: {},
                  properties: {
                    CargasHora: { type: "string", title: "Cargas por Hora (IBMS)" },
                    PiezasCarga: { type: "number", title: "Piezas por Carga (IBMS)" },
                    montoMinimo: { type: "number", title: "Monto Mínimo en USD" },
                    TiempoEntrega: { type: "number", title: "Tiempo de Entrega en Días (Lead Time)" }
                  }
                },
                NotasAdicionales: { type: "string", title: "Notas Adicionales" }
              }
            },
            uiSchema: {
              DatosAdicionalesNP: { NumeroParteAlterno: { items: {} }, "ui:order": ["BaseMetal", "NumeroParteAlterno", "QuoteIBMS", "EstacionIBMS", "Plano"] },
              DatosFacturacion: { "ui:order": ["CodigoSAT"] },
              DatosPlanificacion: { "ui:order": ["PiezasCarga", "CargasHora", "montoMinimo", "TiempoEntrega"] },
              NotasAdicionales: { "ui:widget": "textarea" },
              "ui:order": ["DatosAdicionalesNP", "DatosFacturacion", "DatosPlanificacion", "NotasAdicionales"]
            }
          };
          await api().query('CreatePartNumberInputSchema', fullSchema, 'CreatePartNumberInputSchema');
          log(`  Metal Base actualizado: +${[...newMetals].join(', ')}`);
          showProgressUI(`  Metal Base: ${[...newMetals].join(', ')} agregados al catálogo`);
        } catch (e) {
          errors.push(`Actualizar Metal Base: ${String(e).substring(0, 120)}`);
          warn(`Metal Base schema update falló: ${e.message}`);
        }
      }

      // ═══════════════════════════════════════
      // EXECUTION
      // ═══════════════════════════════════════
      showProgressUI('Iniciando...');

      let quoteId = null, quoteIdInDomain = null;
      const divisaLinea = (header.divisaLinea || 'USD').toUpperCase();

      // STEP 1: CreateQuote (skip in SOLO_PN)
      if (!isSoloPN) {
        showProgressUI('Paso 1: Creando cotización...'); setProgressBar(5);
        const divisaCot = (header.divisaCotizacion || divisaLinea).toUpperCase();
        const empresaKey = (header.empresaEmisora || 'ECO').toUpperCase();
        const empresaStr = DOMAIN.empresas[empresaKey] || DOMAIN.empresas.ECO;
        const validDays = parseInt(header.validaDias) || 30;
        const quoteCI = {
          Comentarios: { CargosFletes: true, CotizacionSujetaPruebas: true, ReferirNumeroCotizacion: true, ModificacionRequiereRecotizar: true },
          DatosAdicionales: { Divisa: divisaCot, Decimales: '2', EmpresaEmisora: empresaStr, MostrarProceso: false, MostrarTotales: true },
          Autorizacion: {}, CondicionesComerciales: {},
        };
        const createResult = await api().query('CreateQuote', {
          name: quoteName, assigneeId, customerId, validUntil: isoDate(validDays), followUpDate: isoDate(3),
          customerAddressId, customerContactId, stagesRevisionId: DOMAIN.stagesRevisionId,
          lowCodeEnabled: false, autoGenerateLines: false, lowCodeId: null,
          customInputs: quoteCI, inputSchemaId: DOMAIN.inputSchemaId_Quote, invoiceTermsId,
          orderDueAt: null, shipToAddressId: customerAddressId
        });
        quoteId = createResult?.createQuote?.quote?.id;
        quoteIdInDomain = createResult?.createQuote?.quote?.idInDomain;
        if (!quoteId) throw new Error('CreateQuote no devolvió id.');
        stats.quoteIdInDomain = quoteIdInDomain;
        log(`  Quote #${quoteIdInDomain} (id:${quoteId})`); showProgressUI(`  -> Quote #${quoteIdInDomain} creada`);
      } else {
        showProgressUI('Modo SOLO_PN — omitiendo cotización'); setProgressBar(5);
      }

      // STEP 2a: Create new PNs via SavePartNumber (minimal)
      showProgressUI('Paso 2/9: Creando PNs nuevos...'); setProgressBar(10);
      const newPnIds = new Map();
      const newOrDupParts = [];
      for (let i = 0; i < parts.length; i++) { const status = pnStatus[i]; if (status.status !== 'existing') newOrDupParts.push({ part: parts[i], status, idx: i }); }
      for (let j = 0; j < newOrDupParts.length; j++) {
        const { part, status } = newOrDupParts[j];
        setProgressBar(10 + Math.round((j / Math.max(newOrDupParts.length, 1)) * 5));
        const processId = part.processIdOverride || defaultProcessId;
        const groupId = await resolveGroupId(part.pnGroup);
        const minInput = {
          id: null, name: part.pn, customerId, defaultProcessNodeId: processId,
          inputSchemaId: DOMAIN.inputSchemaId_PN, customInputs: {},
          geometryTypeId: null, userFileName: null, inventoryItemInput: null,
          glAccountId: null, taxCodeId: null, certPdfTemplateId: null,
          isOneOff: false, isTemplatePartNumber: false, isCoupon: false, partNumberGroupId: groupId,
          descriptionMarkdown: '', customerFacingNotes: '',
          labelIds: [], ownerIds: [], defaults: [], optInOuts: [],
          inventoryPredictedUsages: [], specsToApply: [], paramsToApply: [],
          partNumberDimensions: [], partNumberLocations: [], dimensionCustomValueIds: [],
          partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
          partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
          partNumberSpecClassificationsToUpdate: [],
          partNumberSpecFieldParamUpdates: [], specFieldParamUpdates: []
        };
        try {
          const res = await api().query('SavePartNumber', { input: [minInput] });
          const created = (res?.savePartNumbers || [])[0]; if (!created?.id) throw new Error('No id returned');
          newPnIds.set(part.pn.toUpperCase(), created.id);
          if (status.status === 'forceDup') stats.pnsDuplicated++; else stats.pnsCreated++;
          log(`  "${part.pn}" -> creado id:${created.id}`);
        } catch (e) { errors.push(`Crear PN "${part.pn}": ${String(e).substring(0, 150)}`); }
      }
      showProgressUI(`  -> ${newPnIds.size} PNs creados`);

      // STEP 2b-5: Quote-only steps (skip in SOLO_PN)
      const pnLookup = new Map();

      if (!isSoloPN) {
        // STEP 2b: SaveManyPartNumberPrices
        showProgressUI('Paso 2b: Vinculando precios...'); setProgressBar(15);
        const pnpItems = []; let lineNum = 0;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i]; lineNum++;
          let partNumberId;
          if (status.status === 'existing') { partNumberId = status.existingId; stats.pnsExisting++; }
          else { partNumberId = newPnIds.get(part.pn.toUpperCase()); if (!partNumberId) { errors.push(`PN "${part.pn}" no fue creado, omitido de quote.`); continue; } }
          pnpItems.push({
            partNumberId, processId: part.processIdOverride || defaultProcessId,
            customInputs: { DatosPrecio: { Divisa: divisaLinea } }, inputSchema: DIVISA_SCHEMA, uiSchema: DIVISA_UI,
            partNumberPriceLineItems: [{ title: '', price: part.precio || 0, productId: null, quoteInventoryItemId: null }],
            usePartNumberDescription: true, treatmentSelections: [], priceBuilders: [], informationalPriceDisplayItems: [], priceTiers: [],
            unitId: (part.unidadPrecio && PRICE_UNIT_MAP[part.unidadPrecio] !== undefined) ? PRICE_UNIT_MAP[part.unidadPrecio] : null,
            partNumberCustomInputs: null,
            quotePartNumberPrice: { savedQuotePartNumberPriceId: null, quoteId, quantityPerParent: part.qty, lineNumber: lineNum }
          });
        }
        for (let i = 0; i < pnpItems.length; i += 20) {
          const batch = pnpItems.slice(i, i + 20);
          const { usedHash } = await api().queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN',
            { input: { quoteId, autoGenerateQuoteLines: true, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] } });
          showProgressUI(`  -> Batch ${Math.floor(i / 20) + 1}: ${batch.length} PNs (hash ${usedHash})`);
        }
        log(`  SaveManyPNP: ${pnpItems.length}`);

        // STEP 3: Re-read quote
        showProgressUI('Paso 3: Leyendo cotización...'); setProgressBar(30);
        const { data: qData } = await api().queryWithFallback('GetQuote', 'GetQuote_v8', 'GetQuote_v71', { idInDomain: quoteIdInDomain, revisionNumber: 1 });
        const quote = qData?.quoteByIdInDomainAndRevisionNumber || qData?.quoteByIdInDomain;
        if (!quote) throw new Error(`No se pudo leer quote #${quoteIdInDomain}.`);
        const qpnpNodes = quote.quotePartNumberPricesByQuoteId?.nodes || [];
        const qlNodes = quote.quoteLinesByQuoteId?.nodes || [];
        const qlByQpnpId = new Map(); for (const ql of qlNodes) if (ql.autoGeneratedFromQuotePartNumberPriceId) qlByQpnpId.set(ql.autoGeneratedFromQuotePartNumberPriceId, ql);
        for (const qpnp of qpnpNodes) {
          const pnp = qpnp.partNumberPriceByPartNumberPriceId; if (!pnp) continue;
          const pn = pnp.partNumberByPartNumberId; if (!pn?.name) continue;
          pnLookup.set(pn.name.toUpperCase(), { qpnp, pnp, pn, ql: qlByQpnpId.get(qpnp.id) || null });
        }
        log(`  ${pnLookup.size} PNs en quote`);
        const allProdNodes = quote.allProducts?.nodes || qData.allProducts?.nodes || [];
        if (allProdNodes.length) for (const p of allProdNodes) productByName.set(p.name, p);

        // STEP 4: SaveQuoteLines (products)
        showProgressUI('Paso 4: Products en líneas...'); setProgressBar(40);
        let prodAdded = 0;
        for (const part of parts) {
          if (!part.products.length) continue;
          const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) { errors.push(`PN "${part.pn}" no en quote.`); continue; }
          const ql = entry.ql; if (!ql) { errors.push(`QuoteLine no encontrada para "${part.pn}".`); continue; }
          const existing = ql.quoteLineItemsByQuoteLineId?.nodes || [];
          const idsToDelete = existing.map(ei => ei.id).filter(Boolean);

          // Guión (-) en primer producto = borrar todos los items de esta línea
          if (part.products.length === 1 && isDash(part.products[0].name)) {
            if (idsToDelete.length) {
              try {
                await api().query('SaveQuoteLines', { input: { quoteId, quoteLines: [{ savedQuoteLineId: ql.id, lineNumber: ql.lineNumber, title: ql.title, description: '', autoGeneratedFromQuotePartNumberPriceId: ql.autoGeneratedFromQuotePartNumberPriceId, quoteLineItems: [] }], quoteLinesToDelete: [], quoteLineItemsToDelete: idsToDelete, quoteLineNumberUpdates: [] } });
                log(`  Productos borrados de línea "${part.pn}"`);
              } catch (e) { errors.push(`Borrar productos "${part.pn}": ${String(e).substring(0, 100)}`); }
            }
            continue;
          }

          const items = [];
          for (let idx = 0; idx < part.products.length; idx++) {
            const np = part.products[idx]; const pr = productByName.get(np.name);
            if (!pr) { errors.push(`Product "${np.name}" no en catálogo.`); continue; }
            items.push({ savedQuoteLineItemId: null, title: np.name, price: np.price, quantity: np.qty, productId: pr.id, displayOrder: idx, description: '', dimensionCustomValueIds: [], quotePartNumberPriceIds: [entry.qpnp.id], unitId: resolveUnitId(np.unit) });
            prodAdded++;
          }
          if (!items.length) continue;
          try {
            await api().query('SaveQuoteLines', { input: { quoteId, quoteLines: [{ savedQuoteLineId: ql.id, lineNumber: ql.lineNumber, title: ql.title, description: ql.description || '', autoGeneratedFromQuotePartNumberPriceId: ql.autoGeneratedFromQuotePartNumberPriceId, quoteLineItems: items }], quoteLinesToDelete: [], quoteLineItemsToDelete: idsToDelete, quoteLineNumberUpdates: [] } });
          } catch (e) { errors.push(`SaveQuoteLines "${part.pn}": ${String(e).substring(0, 100)}`); }
        }
        stats.productsSet = prodAdded; showProgressUI(`  -> ${prodAdded} products`);

        // STEP 5: UpdateQuote (notes)
        showProgressUI('Paso 5: Notas...'); setProgressBar(50);
        try {
          if (header.notasExternas) await api().query('UpdateQuote', { id: quoteId, notesMarkdown: isDash(header.notasExternas) ? '' : header.notasExternas });
          if (header.notasInternas) await api().query('UpdateQuote', { id: quoteId, internalNotesMarkdown: isDash(header.notasInternas) ? '' : header.notasInternas });
        } catch (e) { errors.push(`UpdateQuote: ${String(e).substring(0, 100)}`); }
      } else {
        // SOLO_PN: build pnLookup from existing/new PN IDs (no quote context)
        showProgressUI('Modo SOLO_PN: construyendo mapa de PNs...'); setProgressBar(30);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i];
          let pnId;
          if (status.status === 'existing') { pnId = status.existingId; stats.pnsExisting++; }
          else { pnId = newPnIds.get(part.pn.toUpperCase()); }
          if (!pnId) continue;
          // Minimal pn object for enrich step
          pnLookup.set(part.pn.toUpperCase(), {
            qpnp: null, pnp: null,
            pn: { id: pnId, name: part.pn, customerId: customerId, defaultProcessNodeId: part.processIdOverride || defaultProcessId, customInputs: {}, descriptionMarkdown: '', customerFacingNotes: '', geometryTypeId: null, partNumberGroupId: null },
            ql: null
          });
        }
        log(`  ${pnLookup.size} PNs mapeados (SOLO_PN)`);

        // SOLO_PN: Create standalone prices if precio is provided
        const pnpWithPrice = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part.precio === null && !part.qty) continue; // no price data
          const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) continue;
          pnpWithPrice.push({
            partNumberId: entry.pn.id,
            processId: part.procesoOverride ? (defaultProcessId) : (entry.pn.defaultProcessNodeId || defaultProcessId),
            customInputs: { DatosPrecio: { Divisa: divisaLinea } }, inputSchema: DIVISA_SCHEMA, uiSchema: DIVISA_UI,
            partNumberPriceLineItems: [{ title: '', price: part.precio || 0, productId: null, quoteInventoryItemId: null }],
            usePartNumberDescription: true, treatmentSelections: [], priceBuilders: [], informationalPriceDisplayItems: [], priceTiers: [],
            unitId: (part.unidadPrecio && PRICE_UNIT_MAP[part.unidadPrecio] !== undefined) ? PRICE_UNIT_MAP[part.unidadPrecio] : null,
            partNumberCustomInputs: null,
            quotePartNumberPrice: null // no quote
          });
        }
        if (pnpWithPrice.length) {
          showProgressUI('Modo SOLO_PN: Creando precios standalone...'); setProgressBar(40);
          for (let i = 0; i < pnpWithPrice.length; i += 20) {
            const batch = pnpWithPrice.slice(i, i + 20);
            try {
              await api().query('SaveManyPartNumberPrices', {
                input: { quoteId: null, autoGenerateQuoteLines: false, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] }
              }, 'SaveManyPNP_PN');
              showProgressUI(`  -> Precios batch ${Math.floor(i / 20) + 1}: ${batch.length} PNs`);
            } catch (e) {
              errors.push(`Precios standalone: ${String(e).substring(0, 120)}`);
            }
          }
          log(`  Precios standalone: ${pnpWithPrice.length}`);

          // Set as default if marked
          const defaultPriceIds = [];
          // We'd need the price IDs from the response — for now log it
          if (parts.some(p => p.precioDefault)) {
            log('  NOTA: SetDefaultPrice en SOLO_PN requiere re-leer PNs para obtener IDs de precio');
          }
        }
        setProgressBar(50);
      }

      // STEP 6: SavePartNumber (enrich) — runs in BOTH modes
      showProgressUI(`${isSoloPN ? 'Paso 3' : 'Paso 6'}: Enriqueciendo PNs...`); setProgressBar(55);
      let okSP = 0, retrySP = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) continue;
        const pn = entry.pn;
        setProgressBar(55 + Math.round((i / parts.length) * 20));

        // Guión comodín: "-" en primer label = borrar todos los labels
        const labelsAreDash = part.labels.length === 1 && isDash(part.labels[0]);
        const labelIds = labelsAreDash ? [] : part.labels.map(n => labelByName.get(n)).filter(Boolean);
        if (labelIds.length) stats.labelsSet += labelIds.length;

        // Specs — "-" en primer spec = borrar todas las specs
        const specsAreDash = part.specs.length === 1 && isDash(part.specs[0].name);
        const specsToApply = [];
        if (!specsAreDash) for (const cs of part.specs) {
          const si = specByName.get(cs.name); if (!si) { errors.push(`Spec "${cs.name}" no encontrada.`); continue; }
          const sd = sfCache.get(si.id); if (!sd) continue;
          const dS = [], gS = [];
          for (const sf of (sd.specFieldSpecsBySpecId?.nodes || [])) {
            const params = sf.defaultValues?.nodes || []; if (!params.length) continue;
            const fn = sf.specFieldBySpecFieldId?.name || '';
            const isEsp = fn.toLowerCase().includes('espesor');
            let pid;
            if (params.length === 1) pid = params[0].id;
            else if (isEsp && cs.param) { const m = params.find(p => p.name === cs.param); pid = m ? m.id : (errors.push(`"${cs.name}" "${fn}": "${cs.param}" no encontrado.`), params[0].id); }
            else pid = params[0].id;
            if (!pid) continue;
            const sel = { defaultParamId: pid, processNodeId: pn.defaultProcessNodeId || defaultProcessId || null, processNodeOccurrence: (pn.defaultProcessNodeId || defaultProcessId) ? 1 : null, locationId: null, geometryTypeSpecFieldId: null };
            if (sf.isGeneric) gS.push(sel); else dS.push(sel);
          }
          specsToApply.push({ specId: si.id, classificationSetId: null, classificationIds: [], defaultSelections: dS, genericSelections: gS });
          stats.specsSet++;
        }

        // Unit conversions — guión en cualquier campo = borrar todas (enviar inventoryItemInput null)
        const ucDash = [part.unitConv.kgm, part.unitConv.cmk, part.unitConv.lm, part.unitConv.minPzasLote]
          .some(v => typeof v === 'string' && isDash(v));
        const ucs = [];
        if (!ucDash) {
          const uc = part.unitConv;
          if (uc.kgm !== null) { ucs.push({ unitId: DOMAIN.unitIds.KGM, factor: uc.kgm }); ucs.push({ unitId: DOMAIN.unitIds.LBR, factor: uc.kgm * DOMAIN.conversions.KGM_TO_LBR }); }
          if (uc.cmk !== null) { ucs.push({ unitId: DOMAIN.unitIds.CMK, factor: uc.cmk }); ucs.push({ unitId: DOMAIN.unitIds.FTK, factor: uc.cmk * DOMAIN.conversions.CMK_TO_FTK }); }
          if (uc.lm !== null) { ucs.push({ unitId: DOMAIN.unitIds.LM, factor: uc.lm }); ucs.push({ unitId: DOMAIN.unitIds.FOT, factor: uc.lm * DOMAIN.conversions.LM_TO_FOT }); }
          if (uc.minPzasLote !== null && uc.minPzasLote > 0) ucs.push({ unitId: DOMAIN.unitIds.LO, factor: 1 / uc.minPzasLote });
        }
        if (ucs.length || ucDash) stats.unitConvSet++;

        const mergedCI = mergeCustomInputs(pn.customInputs, part);
        if (part.codigoSAT || part.metalBase || part.pnAlterno) stats.ciSet++;

        // Dims — "-" en longitud = borrar dimensiones
        const dimsAreDash = typeof part.dims.length === 'string' && isDash(part.dims.length);
        const dims = dimsAreDash ? [] : buildDimensions(part.dims, DOMAIN);
        const hasDims = dims.length > 0; if (hasDims) stats.dimsSet++;

        // Predictive — "-" en primer material = borrar predictive usage
        const predAreDash = part.predictiveUsage.length === 1 && isDash(part.predictiveUsage[0]?.usagePerPart);
        const finalPredictive = predAreDash ? [] : part.predictiveUsage;
        if (finalPredictive.length) stats.predictiveSet++;

        // OptIn: TRUE = activar, FALSE = desactivar (enviar [])
        const optInOuts = [];
        if (part.validacion1er) {
          const nodeIds = DOMAIN.validacionProcessNodeIds || [DOMAIN.validacionProcessNodeId];
          for (const nodeId of nodeIds) {
            optInOuts.push({ processNodeId: nodeId, processNodeOccurrence: 1, cancelOthers: false });
          }
          stats.validacionSet++;
          log(`  -> ${pn.name}: OptIn validación ACTIVAR`);
        } else {
          // FALSE = explicitly deactivate (send empty array)
          log(`  -> ${pn.name}: OptIn validación DESACTIVAR`);
        }

        // Grupo — "-" = quitar grupo
        const pnGroupId = isDash(part.pnGroup) ? null : (part.pnGroup ? (await resolveGroupId(part.pnGroup)) : pn.partNumberGroupId || null);

        // Dimension custom value IDs (Línea/Departamento)
        const dimValueIds = [];
        if (part.linea && !isDash(part.linea)) { const id = dimValueMap.get(part.linea); if (id) dimValueIds.push(id); else warn(`Línea "${part.linea}" no encontrada en dimensiones`); }
        if (part.departamento && !isDash(part.departamento)) { const id = dimValueMap.get(part.departamento); if (id) dimValueIds.push(id); else warn(`Departamento "${part.departamento}" no encontrado en dimensiones`); }
        // Guión en línea o depto = enviar [] (borrar)
        // Proceso — "-" = quitar proceso override
        const pnProcessId = isDash(part.procesoOverride) ? defaultProcessId : (part.procesoOverride ? (part.processIdOverride || defaultProcessId) : (pn.defaultProcessNodeId || defaultProcessId));

        const pnInput = {
          id: pn.id, name: pn.name, customerId: pn.customerId || customerId, defaultProcessNodeId: pnProcessId,
          descriptionMarkdown: resolveStr(part.descripcion, pn.descriptionMarkdown || ''), customerFacingNotes: pn.customerFacingNotes || '',
          customInputs: mergedCI || pn.customInputs || {}, inputSchemaId: DOMAIN.inputSchemaId_PN, labelIds,
          partNumberGroupId: pnGroupId,
          geometryTypeId: hasDims ? DOMAIN.geometryGenericaId : (pn.geometryTypeId || null),
          inventoryItemInput: ucs.length ? { materialId: null, purchasable: false, sourceMaterialConversionType: null, providedMaterialConversionType: null, defaultLeadTime: null, unitConversions: ucs, inventoryItemVendors: [] } : null,
          inventoryPredictedUsages: finalPredictive.map(pu => ({ inventoryItemId: pu.inventoryItemId, usagePerPart: pu.usagePerPart, lowCodeId: null })),
          specsToApply, isCoupon: false, isOneOff: false, isTemplatePartNumber: false, optInOuts, ownerIds: [], defaults: [],
          dimensionCustomValueIds: dimValueIds,
          paramsToApply: [], partNumberDimensions: dims, partNumberLocations: [],
          partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [], partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
          partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [], specFieldParamUpdates: [],
          glAccountId: null, taxCodeId: null, certPdfTemplateId: null, userFileName: null
        };

        try {
          const spRes = await api().query('SavePartNumber', { input: [pnInput] });
          okSP++;
          log(`  -> ${pnInput.name}: enrich OK (labels:${labelIds.length} specs:${specsToApply.length} dims:${dims.length} optIn:${optInOuts.length} pred:${part.predictiveUsage.length})`);
        }
        catch (e) {
          const errStr = String(e);
          if (errStr.includes('unique_constraint') || errStr.includes('exclusion constraint') || errStr.includes('23505') || errStr.includes('duplicate key')) {
            // Retry progressively removing fields that cause duplicates
            try {
              await api().query('SavePartNumber', { input: [{ ...pnInput, specsToApply: [], optInOuts: [] }] });
              retrySP++; log(`  -> ${pnInput.name}: retry sin specs/optIn OK`);
            } catch (e2) {
              try {
                await api().query('SavePartNumber', { input: [{ ...pnInput, specsToApply: [], optInOuts: [], inventoryPredictedUsages: [] }] });
                retrySP++; log(`  -> ${pnInput.name}: retry mínimo OK`);
              } catch (e3) { errors.push(`${pnInput.name}: retry falló: ${String(e3).substring(0, 120)}`); }
            }
          } else errors.push(`SavePartNumber "${pnInput.name}": ${errStr.substring(0, 120)}`);
        }
      }
      log(`  SavePartNumber: ${okSP} OK, ${retrySP} retry`); showProgressUI(`  -> ${okSP} OK, ${retrySP} retry`);

      // STEP 7: RackTypes — runs in BOTH modes
      showProgressUI(`${isSoloPN ? 'Paso 4' : 'Paso 7'}: Racks...`); setProgressBar(78);
      const rackIn = [];
      const racksToDelete = []; // PNs where racks should be deleted (guión)
      for (const part of parts) {
        if (!part.racks.length) continue;
        const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) continue;
        // Guión (-) in first rack = delete all racks
        if (part.racks.length === 1 && isDash(part.racks[0].name)) {
          racksToDelete.push(entry.pn.id);
          continue;
        }
        for (const rk of part.racks) {
          if (isDash(rk.name)) continue;
          const rt = rackTypeByName.get(rk.name); if (!rt) { errors.push(`RackType "${rk.name}" no encontrado.`); continue; }
          if (rk.ppr === null) continue;
          rackIn.push({ rackTypeId: rt.id, partNumberId: entry.pn.id, partsPerRack: rk.ppr });
        }
      }
      // Delete racks for PNs with guión
      for (const pnId of racksToDelete) {
        try {
          const pnData = await api().query('GetPartNumber', { partNumberId: pnId });
          const existingRacks = pnData?.partNumberById?.partNumberRackTypesByPartNumberId?.nodes || [];
          for (const rk of existingRacks) {
            await api().query('DeletePartNumberRackType', { id: rk.id });
            log(`  Rack ${rk.id} eliminado de PN ${pnId}`);
          }
          if (existingRacks.length) stats.racksSet += existingRacks.length;
        } catch (e) { errors.push(`Borrar racks PN ${pnId}: ${String(e).substring(0, 100)}`); }
      }
      // Add new racks
      if (rackIn.length) {
        for (let i = 0; i < rackIn.length; i += 50) {
          try {
            await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: rackIn.slice(i, i + 50), partNumberRackTypeIdsToDelete: [] } });
          } catch (e) {
            if (String(e).includes('duplicate key') || String(e).includes('23505')) {
              log(`  Racks batch ${Math.floor(i / 50) + 1}: duplicados, insertando uno por uno...`);
              for (const rk of rackIn.slice(i, i + 50)) {
                try {
                  await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: [rk], partNumberRackTypeIdsToDelete: [] } });
                } catch (e2) {
                  if (String(e2).includes('duplicate key') || String(e2).includes('23505')) {
                    log(`  Rack ${rk.rackTypeId} en PN ${rk.partNumberId}: ya existe, omitido`);
                  } else { errors.push(`Rack PN ${rk.partNumberId}: ${String(e2).substring(0, 100)}`); }
                }
              }
            } else { errors.push(`SavePartNumberRackTypes: ${String(e).substring(0, 120)}`); }
          }
        }
      }
      stats.racksSet = rackIn.length + racksToDelete.length; log(`  Racks: ${rackIn.length} agregados, ${racksToDelete.length} PNs con racks eliminados`);

      // STEP 7b: Delete prices (guión in precio column)
      const pricesToDelete = [];
      for (const part of parts) {
        if (!isDash(String(part.precio))) continue;
        const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) continue;
        pricesToDelete.push({ pnId: entry.pn.id, pnName: part.pn });
      }
      if (pricesToDelete.length) {
        showProgressUI(`Borrando precios de ${pricesToDelete.length} PNs...`);
        for (const { pnId, pnName } of pricesToDelete) {
          try {
            const pnData = await api().query('GetPartNumber', { partNumberId: pnId });
            const existingPrices = pnData?.partNumberById?.partNumberPricesByPartNumberId?.nodes || [];
            for (const price of existingPrices) {
              await api().query('DeletePartNumberPrice', { id: price.id });
              log(`  Precio ${price.id} eliminado de PN "${pnName}"`);
            }
          } catch (e) { errors.push(`Borrar precios "${pnName}": ${String(e).substring(0, 100)}`); }
        }
        log(`  Precios eliminados de ${pricesToDelete.length} PNs`);
      }

      // STEP 8: Default Price + Archive
      showProgressUI(`${isSoloPN ? 'Paso 5' : 'Paso 8'}: Archivado...`); setProgressBar(85);
      const pnsToArchive = [], oldPnsToArchive = [], pnsToUnarchive = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) continue;
        if (part.archivado) {
          pnsToArchive.push({ id: entry.pn.id, name: part.pn });
        } else if (pnStatus[i].status === 'existing') {
          // FALSE on existing PN = desarchivar si estaba archivado
          pnsToUnarchive.push({ id: entry.pn.id, name: part.pn });
        }
        if (status.status === 'forceDup' && part.archivarAnterior && status.existingId) oldPnsToArchive.push({ id: status.existingId, name: part.pn + ' (ant)' });
      }
      // Default price: set or unset
      const priceIdsForDefault = [];
      const priceIdsToUnsetDefault = [];
      if (!isSoloPN) {
        // In quote mode, use qpnp price IDs
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const entry = pnLookup.get(part.pn.toUpperCase()); if (!entry) continue;
          const pnpId = entry.pnp?.id;
          if (!pnpId) continue;
          if (part.precioDefault) priceIdsForDefault.push(pnpId);
          else priceIdsToUnsetDefault.push(pnpId);
        }
      } else {
        // In SOLO_PN mode, need to get price IDs from GetPartNumber for existing PNs
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i];
          if (!part.precioDefault && status.status === 'existing') {
            // FALSE on existing = unset default
            try {
              const pnData = await api().query('GetPartNumber', { partNumberId: pnLookup.get(part.pn.toUpperCase())?.pn?.id });
              const prices = pnData?.partNumberById?.partNumberPricesByPartNumberId?.nodes || [];
              const defaultPrice = prices.find(p => p.isDefault);
              if (defaultPrice) priceIdsToUnsetDefault.push(defaultPrice.id);
            } catch (_) {}
          }
        }
      }
      if (priceIdsForDefault.length) {
        try { await api().query('SetPartNumberPricesAsDefaultPrice', { partNumberPriceIds: priceIdsForDefault }, 'SetPNPricesDefault'); stats.defaultPriceSet = priceIdsForDefault.length; }
        catch (e) { errors.push(`SetDefaultPrice: ${String(e).substring(0, 120)}`); }
      }
      for (const priceId of priceIdsToUnsetDefault) {
        try { await api().query('UnsetPartNumberPriceAsDefaultPrice', { id: priceId }); stats.defaultPriceUnset = (stats.defaultPriceUnset || 0) + 1; }
        catch (e) { /* silencioso — puede que no fuera default */ }
      }
      if (priceIdsToUnsetDefault.length) log(`  Default price unset: ${stats.defaultPriceUnset || 0}`);
      for (const p of pnsToArchive) {
        try { await api().query('UpdatePartNumber', { id: p.id, archivedAt: new Date().toISOString() }); stats.archived++; }
        catch (e) { errors.push(`Archivar "${p.name}": ${String(e).substring(0, 100)}`); }
      }
      for (const p of oldPnsToArchive) {
        try { await api().query('UpdatePartNumber', { id: p.id, archivedAt: new Date().toISOString() }); stats.oldArchived++; }
        catch (e) { errors.push(`ArchAnt "${p.name}": ${String(e).substring(0, 100)}`); }
      }
      for (const p of pnsToUnarchive) {
        try { await api().query('UpdatePartNumber', { id: p.id, archivedAt: null }); stats.unarchived = (stats.unarchived || 0) + 1; }
        catch (e) { /* silencioso — puede que no estuviera archivado */ }
      }
      if (pnsToUnarchive.length) log(`  Desarchivados: ${stats.unarchived || 0}`);

      // STEP 9: Done
      showProgressUI('Completado.'); setProgressBar(100);
      const domainId = window.location.pathname.match(/\/Domains\/(\d+)/)?.[1] || DOMAIN.id;
      const quoteUrl = isSoloPN ? null : `/Domains/${domainId}/Quotes/${quoteIdInDomain}`;
      log(`\n=== RESULTADO ===`);
      log(`${isSoloPN ? 'Modo: SOLO_PN' : `Quote: "${quoteName}" #${quoteIdInDomain}`}`);
      log(`PNs: ${stats.pnsCreated} nuevos, ${stats.pnsExisting} existentes, ${stats.pnsDuplicated} dup`);
      if (errors.length) log(`ERRORES: ${errors.length}\n${errors.join('\n')}`);
      await new Promise(r => setTimeout(r, 500));

      // Save load log to localStorage for history
      try {
        const loadLog = {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          mode: isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP',
          quoteName: stats.quoteName,
          quoteIdInDomain: stats.quoteIdInDomain,
          customerName: customer?.name || '',
          stats: { ...stats },
          errors: [...errors],
          log: api().getLog(),
          partsCount: parts.length,
          parts: parts.map(p => ({
            pn: p.pn, qty: p.qty, precio: p.precio, descripcion: p.descripcion,
            labels: p.labels, metalBase: p.metalBase, procesoOverride: p.procesoOverride,
            pnGroup: p.pnGroup, unidadPrecio: p.unidadPrecio,
            specs: p.specs.map(s => s.name), racks: p.racks.map(r => r.name),
            archivado: p.archivado, validacion1er: p.validacion1er,
            precioDefault: p.precioDefault, forzarDuplicado: p.forzarDuplicado
          }))
        };
        const history = JSON.parse(localStorage.getItem('sa_load_history') || '[]');
        history.unshift(loadLog);
        if (history.length > 50) history.length = 50; // keep last 50
        localStorage.setItem('sa_load_history', JSON.stringify(history));
        log('  Log guardado en historial');
      } catch (e) { warn('Error guardando log: ' + e.message); }

      showResult(stats, quoteUrl, errors);
      return { success: true, stats, errors };

    } catch (e) {
      console.error('[SA] FATAL:', e);
      const po = document.getElementById('dl9-progress-overlay'); if (po) removeOverlay(po);
      showResult(stats, null, [`FATAL: ${e.message}`]);
      return { success: false, error: e.message };
    }
  }

  return { execute, setProgressCallback, parseCSV, parseRows };
})();

if (typeof window !== 'undefined') window.BulkUpload = BulkUpload;
