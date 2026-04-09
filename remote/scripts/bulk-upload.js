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

  const toBool = (v) => { const s = (v || '').toString().trim().toUpperCase(); return s === 'SI' || s === 'SÍ' || s === 'YES' || s === '1' || s === 'TRUE' || s === 'V' || s === 'VERDADERO'; };
  const isoDate = (d) => { const dt = new Date(); dt.setDate(dt.getDate() + d); return dt.toISOString(); };
  const g = (row, i) => {
    const v = (row[i] || '').trim().replace(/\s+/g, ' ');
    // V10: dropdowns prepend "(seleccione)" / "(seleccione o escriba)" — tratarlos como vacío
    if (v === '(seleccione)' || v === '(seleccione o escriba)') return '';
    return v;
  };
  const gn = (row, i) => { const v = parseFloat(g(row, i)); return isNaN(v) ? null : v; };

  const PRICE_UNIT_MAP = { PZA: null, KGM: 3969, CMK: 4907, FTK: 4797, LM: 5150, LBR: 3972, LO: 5348 };

  // V10 Predictive material columns: BB=53 (Plata) to BJ=61 (Epóx MTR)
  const PREDICTIVE_MATERIALS = [
    { col: 53, inventoryItemId: 364506, name: 'Plata Fina' },
    { col: 54, inventoryItemId: 397490, name: 'Estaño Puro' },
    { col: 55, inventoryItemId: 412305, name: 'Níquel Metálico' },
    { col: 56, inventoryItemId: 412805, name: 'Zinc Metálico' },
    { col: 57, inventoryItemId: 412479, name: 'Placa de Cobre Electrolítico' },
    { col: 58, inventoryItemId: 412723, name: 'Sterlingshield S (Antitarnish)' },
    { col: 59, inventoryItemId: 702767, name: 'Epoxy MT' },
    { col: 60, inventoryItemId: 702769, name: 'Epoxica BT' },
    { col: 61, inventoryItemId: 702768, name: 'Epoxica MT Red' },
  ];

  const DIVISA_SCHEMA = { type: "object", title: "", required: ["DatosPrecio"], properties: { DatosPrecio: { type: "object", title: "Datos del Precio", required: ["Divisa"], properties: { Divisa: { enum: ["USD", "MXN"], type: "string", title: "Divisa", enumNames: ["USD - Dolar americano", "MXN - Peso mexicano"] } }, dependencies: {} } }, dependencies: {} };
  const DIVISA_UI = { "ui:order": ["DatosPrecio"], DatosPrecio: { "ui:order": ["Divisa"], Divisa: { "ui:title": "Divisa" } } };

  // V10: Cliente, Divisa, Proceso (default) ya no van en el header
  const HEADER_KEYS = {
    'modo': 'modo',
    'nombre cotizacion': 'quoteName', 'nombre cotización': 'quoteName',
    'nombre cotizacion/layout': 'quoteName', 'nombre cotización/layout': 'quoteName',
    'empresa emisora': 'empresaEmisora',
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
    // V10 column indices (0-indexed)
    // A=0 Archivado | B=1 Validación | C=2 Forzar | D=3 Archivar
    // E=4 Cliente | F=5 PN | G=6 Descripción | H=7 PN alterno | I=8 Grupo
    // J=9 Cantidad | K=10 Precio | L=11 Unidad precio | M=12 Divisa | N=13 Precio default
    // O=14 Metal base | P=15 Etq1 | Q=16 Etq2 | R=17 Etq3 | S=18 Etq4 | T=19 Etq5
    // U=20 Proceso | V=21 Prod1 | W=22 Pre1 | X=23 Cnt1 | Y=24 Uni1
    // Z=25 Prod2 | AA=26 Pre2 | AB=27 Cnt2 | AC=28 Uni2
    // AD=29 Prod3 | AE=30 Pre3 | AF=31 Cnt3 | AG=32 Uni3
    // AH=33 Spec1 | AI=34 Esp1 µm | AJ=35 Spec2 | AK=36 Esp2 µm
    // AL=37 KGM | AM=38 CMK | AN=39 LM | AO=40 MinPzasLote
    // AP=41 Rack Línea | AQ=42 Pzas R.L. | AR=43 Rack Sec | AS=44 Pzas R.S.
    // AT=45 Long | AU=46 Ancho | AV=47 Alto | AW=48 D.Ext | AX=49 D.Int
    // AY=50 Línea | AZ=51 Departamento | BA=52 Código SAT
    // BB-BJ=53-61 Predictivos | BK=62 QuoteIBMS | BL=63 EstacionIBMS | BM=64 Plano
    // BN=65 PiezasCarga | BO=66 CargasHora | BP=67 TiempoEntrega | BQ=68 Notas adicionales
    const header = {};
    const parts = [];
    // V10 special case: Modo se exporta como valor pelado (sin label) en G1 / row 0 col 6
    // Buscar COTIZACIÓN+NP / SOLO_PN en las primeras 3 filas
    for (let r = 0; r < Math.min(rows.length, 3); r++) {
      for (const cell of rows[r]) {
        const v = (cell || '').trim().toUpperCase();
        if (v === 'COTIZACIÓN+NP' || v === 'COTIZACION+NP' || v === 'SOLO_PN' || v === 'SOLO PN') {
          header.modo = v;
          break;
        }
      }
      if (header.modo) break;
    }
    for (const row of rows) {
      // V10: el header tiene MÚLTIPLES pares clave-valor por fila
      // Escanear TODAS las celdas buscando labels conocidos; el valor está en la siguiente celda no vacía
      let isHeaderRow = false;
      for (let c = 0; c < row.length; c++) {
        const cell = (row[c] || '').trim();
        if (!cell) continue;
        const keyAcc = cell.replace(/:$/, '').trim().toLowerCase();
        const keyNorm = keyAcc.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const hk = HEADER_KEYS[keyAcc] || HEADER_KEYS[keyNorm];
        if (!hk) continue;
        // Buscar el valor en las siguientes 1-4 celdas a la derecha
        for (let d = 1; d <= 4; d++) {
          const v = (row[c + d] || '').trim();
          if (v) { header[hk] = v; isHeaderRow = true; break; }
        }
      }
      if (isHeaderRow) continue;

      // V10: Skip section/column-header/type-indicator rows
      // Row 6: section headers ("PARÁMETROS", "IDENTIFICACIÓN", "PRECIO", etc.) — col A is non-empty
      // Row 7: column headers ("Archivado", "Cliente", "Número de\nparte", etc.) — col A = "Archivado"
      // Row 8: type indicators ("V/F", "Texto", "#", "$", "Desp.")  — col A = "V/F"
      const colA = (row[0] || '').trim();
      const colF = (row[5] || '').trim();
      if (colA === 'PARÁMETROS' || colA === 'Archivado' || colA === 'V/F') continue;
      // Also skip if col F is a literal column-header text (e.g. "Número de\nparte" or "Texto")
      if (colF === 'Texto' || colF.replace(/\s+/g, ' ').toLowerCase() === 'número de parte') continue;

      const pn = g(row, 5); // F=5
      const qty = gn(row, 9); // J=9
      if (!pn) continue;

      const products = [];
      // V=21(P1), Z=25(P2), AD=29(P3); each followed by Price, Qty, Unit
      for (const b of [21, 25, 29]) {
        const nm = g(row, b);
        if (nm) products.push({ name: nm, price: gn(row, b + 1) || 0, qty: gn(row, b + 2) || 1, unit: g(row, b + 3) });
      }

      const specs = [];
      // AH=33(Spec1) AI=34(Esp1) ; AJ=35(Spec2) AK=36(Esp2)
      for (const [specIdx /*, espIdx */] of [[33, 34], [35, 36]]) {
        const raw = g(row, specIdx);
        if (!raw) continue;
        if (raw.includes(' | ')) { const s = raw.indexOf(' | '); specs.push({ name: raw.substring(0, s).trim(), param: raw.substring(s + 3).trim() }); }
        else specs.push({ name: raw, param: '' });
      }

      const racks = [];
      // AP=41 Rack Línea, AQ=42 Pzas; AR=43 Rack Sec, AS=44 Pzas
      if (g(row, 41)) racks.push({ name: g(row, 41), ppr: gn(row, 42) });
      if (g(row, 43)) racks.push({ name: g(row, 43), ppr: gn(row, 44) });

      const predictiveUsage = [];
      for (const mat of PREDICTIVE_MATERIALS) {
        const val = gn(row, mat.col);
        if (val !== null && val > 0) predictiveUsage.push({ inventoryItemId: mat.inventoryItemId, usagePerPart: String(val), name: mat.name });
      }

      parts.push({
        pn, qty,
        cliente: g(row, 4),                     // E=4 NEW per-line customer
        precio: gn(row, 10),                    // K=10
        unidadPrecio: g(row, 11).toUpperCase(), // L=11
        divisa: (g(row, 12) || 'USD').toUpperCase(), // M=12 NEW per-line currency
        precioDefault: toBool(g(row, 13)),      // N=13
        descripcion: g(row, 6),                 // G=6
        pnAlterno: g(row, 7),                   // H=7
        pnGroup: g(row, 8),                     // I=8
        metalBase: g(row, 14),                  // O=14
        labels: [g(row, 15), g(row, 16), g(row, 17), g(row, 18), g(row, 19)].filter(Boolean), // P-T (5 labels)
        procesoOverride: g(row, 20),            // U=20 NOW REQUIRED (no header default)
        products, specs,
        unitConv: { kgm: gn(row, 37), cmk: gn(row, 38), lm: gn(row, 39), minPzasLote: gn(row, 40) }, // AL-AO
        racks,
        dims: { length: gn(row, 45), width: gn(row, 46), height: gn(row, 47), outerDiam: gn(row, 48), innerDiam: gn(row, 49) }, // AT-AX
        linea: g(row, 50),                      // AY=50
        departamento: g(row, 51),               // AZ=51
        codigoSAT: g(row, 52),                  // BA=52
        archivado: toBool(g(row, 0)),
        forzarDuplicado: toBool(g(row, 2)),
        archivarAnterior: toBool(g(row, 3)),
        validacion1er: toBool(g(row, 1)),
        predictiveUsage,
        quoteIBMS: g(row, 62),                  // BK=62
        estacionIBMS: g(row, 63),               // BL=63
        plano: g(row, 64),                      // BM=64
        piezasCarga: gn(row, 65),               // BN=65
        cargasHora: g(row, 66),                 // BO=66
        tiempoEntrega: gn(row, 67),             // BP=67
        notasAdicionalesPN: g(row, 68),         // BQ=68
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
    // V10: PN existence is per (pn name, customerId) since the same name can exist under multiple customers
    // Uses AllPartNumbers because SearchPartNumbers (older hash) doesn't return customer info in the response
    const uniq = new Map(); // "PN|custId" → { name, customerId }
    for (const p of parts) {
      const key = `${p.pn.toUpperCase()}|${p.customerId}`;
      if (!uniq.has(key)) uniq.set(key, { name: p.pn, customerId: p.customerId });
    }
    const existMap = new Map(); // same key → { id }
    log(`Buscando ${uniq.size} PN/cliente combinaciones...`);
    for (const [key, { name, customerId }] of uniq) {
      try {
        const d = await api().query('AllPartNumbers', {
          orderBy: ['ID_DESC'], offset: 0, first: 50, searchQuery: name
        });
        const nodes = d?.pagedData?.nodes || [];
        const match = nodes.find(n =>
          n.name?.toUpperCase() === name.toUpperCase() &&
          !n.archivedAt &&
          (n.customerByCustomerId?.id === customerId || n.customerId === customerId)
        );
        if (match) {
          existMap.set(key, { id: match.id, processId: match.processNodeByDefaultProcessNodeId?.id || match.defaultProcessNodeId || null });
          log(`  "${name}" (cust:${customerId}) -> EXISTE id:${match.id}`);
        }
        else log(`  "${name}" (cust:${customerId}) -> NUEVO (${nodes.length} resultados)`);
      } catch (e) { warn(`Búsqueda "${name}": ${String(e).substring(0, 120)}`); }
    }
    return parts.map(p => {
      const key = `${p.pn.toUpperCase()}|${p.customerId}`;
      const ex = existMap.get(key);
      if (!ex) return { pn: p.pn, status: 'new', existingId: null, existingProcessId: null, qty: p.qty, precio: p.precio, customerId: p.customerId };
      if (p.forzarDuplicado) return { pn: p.pn, status: 'forceDup', existingId: ex.id, existingProcessId: ex.processId, qty: p.qty, precio: p.precio, customerId: p.customerId };
      return { pn: p.pn, status: 'existing', existingId: ex.id, existingProcessId: ex.processId, qty: p.qty, precio: p.precio, customerId: p.customerId };
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
        const lbl = s.status === 'new' ? 'CREAR NUEVO'
          : s.status === 'existing' ? `MODIFICAR (id:${s.existingId})`
          : `DUPLICAR${part.archivarAnterior ? ' + ARCHIVAR' : ''} (viejo:${s.existingId})`;

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
            <div class="dl9-stat"><b>Clientes:</b> ${info.customerCount || '?'}</div>
            <div class="dl9-stat"><b>Procesos:</b> ${info.processCount || '?'}</div>
           </div>`
        : `<div class="dl9-stats">
            <div class="dl9-stat"><b>Layout:</b> ${header.quoteName || '?'}</div>
            <div class="dl9-stat"><b>Clientes:</b> ${info.customerCount || '?'} (1 cot c/u)</div>
            <div class="dl9-stat"><b>Asignado:</b> ${info.assigneeName || '(auto)'}</div>
            <div class="dl9-stat"><b>Procesos:</b> ${info.processCount || '?'}</div>
            <div class="dl9-stat"><b>Divisa:</b> per-línea</div>
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

  // V10: search for existing quotes by customer + name
  async function findExistingQuote(customerId, name) {
    try {
      const data = await api().query('AllQuotes', {
        orderBy: ['ID_DESC'], offset: 0, first: 50,
        customerIdFilter: [customerId], searchQuery: name
      });
      const nodes = data?.pagedData?.nodes || [];
      // Exact name match (case insensitive), only non-archived
      const upper = name.toUpperCase();
      return nodes.find(q => q.name?.toUpperCase() === upper && !q.archivedAt) || null;
    } catch (e) {
      warn(`AllQuotes search "${name}" cust ${customerId}: ${String(e).substring(0, 100)}`);
      return null;
    }
  }

  // Modal: ask user what to do when a quote with same name+customer exists
  function showQuoteConflict(customerName, quoteName, existing) {
    return new Promise((resolve) => {
      injectStyles(); const { overlay, modal } = createOverlay();
      modal.style.background = '#1e293b';
      modal.innerHTML = `
        <h2 style="color:#f59e0b">⚠️ Cotización ya existe</h2>
        <p style="color:#e2e8f0;font-size:13px;margin:12px 0">
          Ya existe una cotización con el nombre <b>"${quoteName}"</b> para el cliente <b>${customerName}</b>:
        </p>
        <div style="background:#0f172a;padding:12px;border-radius:6px;margin-bottom:12px;font-size:12px;color:#94a3b8">
          <div><b style="color:#e2e8f0">Cotización #${existing.idInDomain}</b></div>
          <div>Nombre: ${existing.name}</div>
          <div>Creada: ${new Date(existing.createdAt).toLocaleDateString('es-MX')}</div>
        </div>
        <p style="color:#94a3b8;font-size:12px;margin-bottom:12px">¿Qué quieres hacer?</p>
        <div class="dl9-btnrow" style="flex-direction:column;gap:8px">
          <button class="dl9-btn" id="dl9-conflict-modify" style="background:#0d9488;color:white;justify-content:flex-start">
            ✏️ <b>Modificar la existente</b> — re-llena #${existing.idInDomain} con los PNs del CSV
          </button>
          <button class="dl9-btn" id="dl9-conflict-create" style="background:#2563eb;color:white;justify-content:flex-start">
            ➕ <b>Crear una nueva de todas formas</b> — quedarán 2 cotizaciones con el mismo nombre
          </button>
          <button class="dl9-btn" id="dl9-conflict-skip" style="background:#dc2626;color:white;justify-content:flex-start">
            ⏭️ <b>Omitir este cliente</b> — no procesar sus PNs en esta corrida
          </button>
        </div>`;
      document.getElementById('dl9-conflict-modify').onclick = () => { removeOverlay(overlay); resolve('modify'); };
      document.getElementById('dl9-conflict-create').onclick = () => { removeOverlay(overlay); resolve('create'); };
      document.getElementById('dl9-conflict-skip').onclick = () => { removeOverlay(overlay); resolve('skip'); };
    });
  }

  function showResult(stats, quoteUrl, errors, quoteUrlLabel) {
    const po = document.getElementById('dl9-progress-overlay'); if (po) removeOverlay(po);
    injectStyles(); const { overlay, modal } = createOverlay();
    const errH = errors.length ? `<h3 class="dl9-err">Errores (${errors.length})</h3><div style="max-height:150px;overflow-y:auto;font-size:12px;color:#f87171;white-space:pre-wrap">${errors.join('\n')}</div>` : '';
    const lbl = quoteUrlLabel || 'ABRIR COTIZACIÓN';
    modal.innerHTML = `<h2>${errors.length ? 'Completado con errores' : 'Completado OK'}</h2><div class="dl9-stats"><div class="dl9-stat"><b>Quote:</b> ${stats.quoteName} (#${stats.quoteIdInDomain})</div><div class="dl9-stat"><b>PNs creados:</b> ${stats.pnsCreated}</div><div class="dl9-stat"><b>PNs existentes:</b> ${stats.pnsExisting}</div><div class="dl9-stat"><b>Duplicados:</b> ${stats.pnsDuplicated}</div><div class="dl9-stat"><b>Products:</b> ${stats.productsSet}</div><div class="dl9-stat"><b>Labels:</b> ${stats.labelsSet}</div><div class="dl9-stat"><b>Specs:</b> ${stats.specsSet}</div><div class="dl9-stat"><b>UnitConv:</b> ${stats.unitConvSet}</div><div class="dl9-stat"><b>Racks:</b> ${stats.racksSet}</div><div class="dl9-stat"><b>CI:</b> ${stats.ciSet}</div><div class="dl9-stat"><b>Dims:</b> ${stats.dimsSet}</div><div class="dl9-stat"><b>PredUsage:</b> ${stats.predictiveSet}</div><div class="dl9-stat"><b>Default Price:</b> ${stats.defaultPriceSet}</div><div class="dl9-stat"><b>Archivados:</b> ${stats.archived}</div><div class="dl9-stat"><b>Ant.archivados:</b> ${stats.oldArchived}</div><div class="dl9-stat"><b>Valid.1erRecibo:</b> ${stats.validacionSet}</div></div>${errH}<div class="dl9-btnrow"><button class="dl9-btn dl9-btn-copy" id="dl9-copy-log">COPIAR LOG</button>${quoteUrl ? `<button class="dl9-btn dl9-btn-exec" id="dl9-open-quote">${lbl}</button>` : ''}<button class="dl9-btn dl9-btn-close" id="dl9-close">CERRAR</button></div>`;
    if (quoteUrl) {
      document.getElementById('dl9-open-quote').addEventListener('click', () => {
        // V10: navega en la pestaña actual (Steelhead es SPA, evita perder contexto)
        window.location.href = quoteUrl;
      });
    }
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
        if (!quoteName) throw new Error('Falta "Nombre Cotización/Layout" en header.');
        const sinQty = parts.filter(p => p.qty === null);
        if (sinQty.length) throw new Error(`Modo COTIZACIÓN+NP requiere Cantidad en todas las filas. ${sinQty.length} filas sin cantidad: ${sinQty.slice(0, 3).map(p => p.pn).join(', ')}...`);
      }
      stats.quoteName = isSoloPN ? '(SOLO_PN)' : quoteName;
      log(`Modo: ${isSoloPN ? 'SOLO_PN' : 'COTIZACIÓN+NP'} ${isSoloPN ? '' : '— "' + quoteName + '"'}`);

      // ── V10: Validate required per-line fields ──
      const sinCliente = parts.filter(p => !p.cliente);
      if (sinCliente.length) throw new Error(`${sinCliente.length} filas sin Cliente: ${sinCliente.slice(0, 3).map(p => p.pn).join(', ')}...`);
      // Proceso: vacío = copiar del PN existente (resuelto tras existence check).
      //          "-" = borrar (set null). Nombre = resolver a id.
      //          Validación per-row contra new/existing en el post-process tardío.

      // ── Resolve all unique customers (per-line, with cache) ──
      const customerCache = new Map(); // name → { id, name, addressId, contactId, invoiceTermsId }
      const uniqueClientNames = [...new Set(parts.map(p => p.cliente.split(/\s*[\u2014\u2013]\s*|\s+[-]\s+/)[0].trim()))];
      log(`Clientes únicos en layout: ${uniqueClientNames.length}`);
      for (const cname of uniqueClientNames) {
        const custData = await api().query('CustomerSearchByName', { nameLike: `%${cname}%`, orderBy: ['NAME_ASC'] });
        const custNodes = custData?.searchCustomers?.nodes || custData?.pagedData?.nodes || custData?.allCustomers?.nodes || [];
        const customer = custNodes.find(c => c.name?.toUpperCase().includes(cname.toUpperCase()));
        if (!customer) throw new Error(`Cliente "${cname}" no encontrado.`);
        const cid = customer.id;
        const relData = await api().query('GetQuoteRelatedData', { customerId: cid });
        const addr = relData?.customerById?.customerAddressesByCustomerId?.nodes || [];
        const cont = relData?.customerById?.customerContactsByCustomerId?.nodes || [];
        let invTerms = null;
        try { const fin = await api().query('CustomerFinancialByCustomerId', { id: cid }, 'CustomerFinancialById'); invTerms = fin?.customerById?.invoiceTermsId || null; } catch (_) {}
        if (!invTerms) {
          try { const t = await api().query('SearchInvoiceTerms', { termsLike: '%%' }); const tn = t?.allInvoiceTerms?.nodes || t?.pagedData?.nodes || t?.searchInvoiceTerms?.nodes || []; if (tn.length) invTerms = tn[0].id; } catch (_) {}
        }
        customerCache.set(cname, { id: cid, name: customer.name, addressId: addr[0]?.id || null, contactId: cont[0]?.id || null, invoiceTermsId: invTerms });
        log(`  "${cname}" → ${customer.name} (id:${cid})`);
      }

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

      // ── V10: NO header default process — process must come from each line ──

      // ── Catalogs ──
      log('Cargando catálogos...');
      // V10: AllSpecs paginado en lugar de SearchSpecsForSelect — sin límite oculto y trae fields embebidos.
      async function fetchAllSpecsFull() {
        const all = []; const PAGE = 400; let offset = 0;
        while (true) {
          let d;
          try {
            d = await api().query('AllSpecs', { includeArchived: 'NO', orderBy: ['ID_IN_DOMAIN_ASC'], offset, first: PAGE, searchQuery: '' });
          } catch (e) { warn(`AllSpecs offset ${offset}: ${String(e).substring(0, 100)}`); break; }
          const nodes = d?.pagedData?.nodes || [];
          all.push(...nodes);
          if (nodes.length < PAGE) break;
          offset += PAGE;
          if (offset > 50000) break;
        }
        return all;
      }
      const [labelsD, specsAll, racksD, unitsD, productsD, groupsD] = await Promise.all([
        api().query('AllLabels', { condition: { forPartNumber: true } }),
        fetchAllSpecsFull(),
        api().query('AllRackTypes', {}),
        api().query('SearchUnits', {}),
        api().query('SearchProducts', { searchQuery: '%%', first: 500 }),
        api().query('PartNumberGroupSelect', { partNumberGroupLike: '%%', first: 500 }, 'PNGroupSelect').catch(() => api().query('PartNumberGroupSelect', {}, 'PNGroupSelect')).catch(() => null),
      ]);

      const labelByName = new Map(); for (const l of (labelsD?.allLabels?.nodes || [])) labelByName.set(l.name, l.id);
      const specByName = new Map(); for (const s of specsAll) if (s?.name) specByName.set(s.name, s);
      const rackTypeByName = new Map(); for (const rt of (racksD?.pagedData?.nodes || racksD?.allRackTypes?.nodes || [])) rackTypeByName.set(rt.name, rt);
      unitNodes = unitsD?.pagedData?.nodes || unitsD?.searchUnits?.nodes || [];
      // V10: build unitById map for Espesor mils support
      const unitById = new Map();
      for (const u of unitNodes) unitById.set(u.id, u);
      const productByName = new Map(); for (const p of (productsD?.searchProducts?.nodes || productsD?.pagedData?.nodes || [])) productByName.set(p.name, p);
      const groupByName = new Map();
      if (groupsD) { const gn2 = groupsD?.allPartNumberGroups?.nodes || groupsD?.pagedData?.nodes || groupsD?.partNumberGroups?.nodes || []; for (const gg of gn2) groupByName.set(gg.name, gg.id); }
      log(`  ${labelByName.size} labels, ${specByName.size} specs, ${rackTypeByName.size} racks, ${unitNodes.length} units, ${productByName.size} products, ${groupByName.size} groups`);

      // V10: Resolve all per-line processes to IDs (with cache)
      // Vacío y "-" se saltan aquí; se resuelven en post-process tras el existence check.
      const processCache = new Map(); // name → id
      const uniqueProcessNames = [...new Set(parts.map(p => p.procesoOverride).filter(n => n && !isDash(n)))];
      log(`Procesos únicos en layout: ${uniqueProcessNames.length}`);
      for (const pname of uniqueProcessNames) {
        const pd = await api().query('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: `%${pname}%`, first: 50 });
        const pn2 = pd?.allProcessNodes?.nodes || pd?.pagedData?.nodes || [];
        const pr = pn2.find(p => p.name?.toUpperCase() === pname.toUpperCase()) || pn2.find(p => p.name?.toUpperCase().includes(pname.toUpperCase()));
        if (!pr) throw new Error(`Proceso "${pname}" no encontrado en Steelhead.`);
        processCache.set(pname, pr.id);
      }
      // Annotate each part with its resolved processId and customerId
      for (const p of parts) {
        // null marker para vacío y "-" — se resuelven en post-process tras pnStatus
        p.processId = (!p.procesoOverride || isDash(p.procesoOverride)) ? null : processCache.get(p.procesoOverride);
        const cname = p.cliente.split(/\s*[\u2014\u2013]\s*|\s+[-]\s+/)[0].trim();
        const cust = customerCache.get(cname);
        p.customerId = cust.id;
        p.customerName = cust.name;
        p.customerAddressId = cust.addressId;
        p.customerContactId = cust.contactId;
        p.customerInvoiceTermsId = cust.invoiceTermsId;
      }

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

      // Spec fields cache — V10: AllSpecs ya trajo los fields embebidos, sin más queries
      const uniqueSpecs = new Set(); for (const p of parts) for (const s of p.specs) uniqueSpecs.add(s.name);
      const sfCache = new Map();
      for (const sn of uniqueSpecs) {
        if (isDash(sn)) continue;
        const si = specByName.get(sn); if (!si) { warn(`Spec "${sn}" no encontrada.`); continue; }
        if (!sfCache.has(si.id)) {
          // si ya es un spec node de AllSpecs con specFieldSpecsBySpecId embebido
          if (si.specFieldSpecsBySpecId?.nodes) {
            sfCache.set(si.id, si);
            log(`  Spec "${sn}": ${si.specFieldSpecsBySpecId.nodes.length} campos (embebidos)`);
          } else {
            // Fallback (no debería ocurrir con AllSpecs, pero por seguridad)
            try {
              const d = await api().query('TempSpecFieldsAndOptions', { specId: si.id });
              const sd = d?.specById; if (sd) { sfCache.set(si.id, sd); log(`  Spec "${sn}": ${sd.specFieldSpecsBySpecId?.nodes?.length || 0} campos (fallback)`); }
            } catch (e) { warn(`Spec "${sn}" fields: ${String(e).substring(0, 100)}`); }
          }
        }
      }

      // ── PN existence check ──
      const pnStatus = await checkPNExistence(parts);

      // V10: Resolver proceso vacío / "-" según existence:
      //   "-"   → set null (borrar default process)
      //   ""    → copiar del PN existente; si es nuevo → error y skip
      //   name  → ya está resuelto desde processCache
      const partsToSkip = new Set();
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const raw = p.procesoOverride;
        if (raw && !isDash(raw)) continue; // ya tiene processId resuelto

        if (isDash(raw)) {
          // "-" = borrar el default process del PN (queda null)
          p.processId = null;
          p.clearDefaultProcess = true;
          log(`  PN "${p.pn}": Proceso "-" → se borrará el default process`);
          continue;
        }

        // Vacío
        const st = pnStatus[i];
        if (st.status === 'new') {
          errors.push(`PN "${p.pn}": Proceso vacío en PN NUEVO (no hay de dónde copiar). Ignorado.`);
          partsToSkip.add(i);
          continue;
        }
        if (!st.existingProcessId) {
          errors.push(`PN "${p.pn}": Proceso vacío y el PN existente no tiene defaultProcessNodeId. Ignorado.`);
          partsToSkip.add(i);
          continue;
        }
        p.processId = st.existingProcessId;
        log(`  PN "${p.pn}": Proceso heredado del PN existente (id:${st.existingProcessId})`);
      }
      if (partsToSkip.size) {
        const filtered = parts.filter((_, i) => !partsToSkip.has(i));
        const filteredStatus = pnStatus.filter((_, i) => !partsToSkip.has(i));
        parts.length = 0; parts.push(...filtered);
        pnStatus.length = 0; pnStatus.push(...filteredStatus);
      }

      // ── Metal Base validation ──
      // V10: fetch enum directly from PartNumber input schema (no más hardcoded)
      let metalBaseEnum = [];
      let satEnum = [];
      try {
        const schemaData = await api().query('GetPartNumbersInputSchema', {}, 'GetPartNumbersInputSchema');
        const schemaNodes = schemaData?.allPartNumberInputSchemas?.nodes || [];
        const latestSchema = schemaNodes.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
        if (latestSchema) {
          const schemaProps = latestSchema.inputSchema?.properties || {};
          metalBaseEnum = schemaProps.DatosAdicionalesNP?.properties?.BaseMetal?.enum || [];
          satEnum = schemaProps.DatosFacturacion?.properties?.CodigoSAT?.enum || [];
          log(`  Schema loaded: ${metalBaseEnum.length} metales, ${satEnum.length} SAT`);
        }
      } catch (e) {
        warn(`GetPartNumbersInputSchema falló: ${String(e).substring(0, 100)}. Usando fallback hardcoded.`);
        metalBaseEnum = ['Cobre', 'Aluminio', 'Fierro', 'Latón', 'Acero Inoxidable', 'Bronce', 'Bimetálica', 'Acero al Carbón', 'Zamak', 'Varios'];
      }
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
      const selectedIndices = await showPreview(header, parts, pnStatus, { customerCount: customerCache.size, processCount: processCache.size, assigneeName }, isSoloPN);
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

      // V10: quote vars now per-customer; we track all of them
      const quotesCreated = []; // [{ id, idInDomain, customerId, name }]
      let primaryQuoteIdInDomain = null;
      const empresaKey = (header.empresaEmisora || 'ECO').toUpperCase();
      const empresaStr = DOMAIN.empresas[empresaKey] || DOMAIN.empresas.ECO;
      const validDays = parseInt(header.validaDias) || 30;

      if (!isSoloPN) {
        showProgressUI('Paso 1: Preparando cotizaciones...'); setProgressBar(5);
      } else {
        showProgressUI('Modo SOLO_PN — omitiendo cotización'); setProgressBar(5);
      }

      // STEP 2a: Create new PNs via SavePartNumber (minimal)
      // V10: newPnIds keyed by "pn|customerId" to support multi-customer
      showProgressUI('Paso 2/9: Creando PNs nuevos...'); setProgressBar(10);
      const newPnIds = new Map();
      const newOrDupParts = [];
      for (let i = 0; i < parts.length; i++) { const status = pnStatus[i]; if (status.status !== 'existing') newOrDupParts.push({ part: parts[i], status, idx: i }); }
      for (let j = 0; j < newOrDupParts.length; j++) {
        const { part, status } = newOrDupParts[j];
        setProgressBar(10 + Math.round((j / Math.max(newOrDupParts.length, 1)) * 5));
        const processId = part.processId; // V10: per-line, no fallback
        const groupId = await resolveGroupId(part.pnGroup);
        const minInput = {
          id: null, name: part.pn, customerId: part.customerId, defaultProcessNodeId: processId,
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
          // V10: key by pn|customerId so the same PN under different customers stays separate
          newPnIds.set(`${part.pn.toUpperCase()}|${part.customerId}`, created.id);
          if (status.status === 'forceDup') stats.pnsDuplicated++; else stats.pnsCreated++;
          log(`  "${part.pn}" (cust:${part.customerId}) -> creado id:${created.id}`);
        } catch (e) { errors.push(`Crear PN "${part.pn}": ${String(e).substring(0, 150)}`); }
      }
      showProgressUI(`  -> ${newPnIds.size} PNs creados`);

      // V10: pnLookup keyed by "pn|customerId" to support multi-customer
      const pnLookup = new Map();

      if (!isSoloPN) {
        // V10: Group parts by customer and create one quote per customer
        const partsByCustomer = new Map();
        for (let i = 0; i < parts.length; i++) {
          const cid = parts[i].customerId;
          if (!partsByCustomer.has(cid)) partsByCustomer.set(cid, []);
          partsByCustomer.get(cid).push({ part: parts[i], status: pnStatus[i], origIdx: i });
        }
        log(`Cotizaciones a crear: ${partsByCustomer.size} (una por cliente)`);

        let quoteSeq = 0;
        let prodAddedTotal = 0;
        for (const [cid, custParts] of partsByCustomer) {
          quoteSeq++;
          const cust = [...customerCache.values()].find(c => c.id === cid);
          if (!cust) { errors.push(`Cliente id ${cid} no en cache`); continue; }
          // V10: same layout name for all quotes — distinguishable by customer column in Steelhead UI
          const thisQuoteName = quoteName;
          // Use first part's divisa as quote-level divisa (per-line drives prices later)
          const quoteDivisa = (custParts[0].part.divisa || 'USD').toUpperCase();
          const quoteCI = {
            Comentarios: { CargosFletes: true, CotizacionSujetaPruebas: true, ReferirNumeroCotizacion: true, ModificacionRequiereRecotizar: true },
            DatosAdicionales: { Divisa: quoteDivisa, Decimales: '2', EmpresaEmisora: empresaStr, MostrarProceso: false, MostrarTotales: true },
            Autorizacion: {}, CondicionesComerciales: {},
          };

          showProgressUI(`Quote ${quoteSeq}/${partsByCustomer.size}: buscando duplicados...`);
          setProgressBar(5 + Math.round((quoteSeq / partsByCustomer.size) * 40));

          // V10: detect existing quote with same name+customer
          let thisQuoteId = null, thisQuoteIdInDomain = null;
          const existingQuote = await findExistingQuote(cid, thisQuoteName);
          if (existingQuote) {
            log(`  Cotización existente encontrada: #${existingQuote.idInDomain} (${cust.name})`);
            const action = await showQuoteConflict(cust.name, thisQuoteName, existingQuote);
            if (action === 'skip') {
              log(`  ${cust.name}: omitido por usuario`);
              continue;
            }
            if (action === 'modify') {
              thisQuoteId = existingQuote.id;
              thisQuoteIdInDomain = existingQuote.idInDomain;
              log(`  Modificando cotización existente #${thisQuoteIdInDomain}`);

              // Clean existing PNPs from the quote so we can re-add fresh
              try {
                const existingPnpIds = (existingQuote.quotePartNumberPricesByQuoteId?.nodes || []).map(n => n.partNumberPriceByPartNumberPriceId?.id).filter(Boolean);
                if (existingPnpIds.length) {
                  log(`  Limpiando ${existingPnpIds.length} PNPs viejos de la cotización...`);
                  await api().queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN',
                    { input: { quoteId: thisQuoteId, autoGenerateQuoteLines: false, partNumberPrices: [], partNumberPriceIdsToDelete: existingPnpIds, quotePartNumberPriceLineNumberOnlyUpdates: [] } });
                }
              } catch (e) { warn(`Limpiar PNPs viejos: ${String(e).substring(0, 100)}`); }
            }
            // action === 'create' falls through to the normal CreateQuote
          }

          if (!thisQuoteId) {
            // No existing or user chose to create new
            showProgressUI(`Quote ${quoteSeq}/${partsByCustomer.size}: "${thisQuoteName}"`);
            let createResult;
            try {
              createResult = await api().query('CreateQuote', {
                name: thisQuoteName, assigneeId, customerId: cid,
                validUntil: isoDate(validDays), followUpDate: isoDate(3),
                customerAddressId: cust.addressId, customerContactId: cust.contactId,
                stagesRevisionId: DOMAIN.stagesRevisionId,
                lowCodeEnabled: false, autoGenerateLines: false, lowCodeId: null,
                customInputs: quoteCI, inputSchemaId: DOMAIN.inputSchemaId_Quote,
                invoiceTermsId: cust.invoiceTermsId,
                orderDueAt: null, shipToAddressId: cust.addressId
              });
            } catch (e) { errors.push(`CreateQuote "${thisQuoteName}": ${String(e).substring(0, 150)}`); continue; }
            thisQuoteId = createResult?.createQuote?.quote?.id;
            thisQuoteIdInDomain = createResult?.createQuote?.quote?.idInDomain;
            if (!thisQuoteId) { errors.push(`CreateQuote no devolvió id para "${thisQuoteName}"`); continue; }
          }

          quotesCreated.push({ id: thisQuoteId, idInDomain: thisQuoteIdInDomain, customerId: cid, name: thisQuoteName });
          if (!primaryQuoteIdInDomain) primaryQuoteIdInDomain = thisQuoteIdInDomain;
          log(`  Quote #${thisQuoteIdInDomain} (id:${thisQuoteId}) — ${cust.name}`);

          // SaveManyPNP for this customer's parts
          const pnpItems = []; let lineNum = 0;
          for (const { part, status } of custParts) {
            lineNum++;
            let partNumberId;
            if (status.status === 'existing') { partNumberId = status.existingId; stats.pnsExisting++; }
            else { partNumberId = newPnIds.get(`${part.pn.toUpperCase()}|${cid}`); if (!partNumberId) { errors.push(`PN "${part.pn}" no fue creado, omitido de quote.`); continue; } }
            pnpItems.push({
              partNumberId, processId: part.processId,
              customInputs: { DatosPrecio: { Divisa: part.divisa || 'USD' } }, inputSchema: DIVISA_SCHEMA, uiSchema: DIVISA_UI,
              partNumberPriceLineItems: [{ title: '', price: part.precio || 0, productId: null, quoteInventoryItemId: null }],
              usePartNumberDescription: true, treatmentSelections: [], priceBuilders: [], informationalPriceDisplayItems: [], priceTiers: [],
              unitId: (part.unidadPrecio && PRICE_UNIT_MAP[part.unidadPrecio] !== undefined) ? PRICE_UNIT_MAP[part.unidadPrecio] : null,
              partNumberCustomInputs: null,
              quotePartNumberPrice: { savedQuotePartNumberPriceId: null, quoteId: thisQuoteId, quantityPerParent: part.qty, lineNumber: lineNum }
            });
          }
          for (let i = 0; i < pnpItems.length; i += 20) {
            const batch = pnpItems.slice(i, i + 20);
            try {
              await api().queryWithFallback('SaveManyPartNumberPrices', 'SaveManyPNP_Quote', 'SaveManyPNP_PN',
                { input: { quoteId: thisQuoteId, autoGenerateQuoteLines: true, partNumberPrices: batch, partNumberPriceIdsToDelete: [], quotePartNumberPriceLineNumberOnlyUpdates: [] } });
            } catch (e) { errors.push(`SaveManyPNP quote ${thisQuoteIdInDomain}: ${String(e).substring(0, 120)}`); }
          }
          log(`  SaveManyPNP: ${pnpItems.length}`);

          // Re-read quote to populate pnLookup
          let qData;
          try { ({ data: qData } = await api().queryWithFallback('GetQuote', 'GetQuote_v8', 'GetQuote_v71', { idInDomain: thisQuoteIdInDomain, revisionNumber: 1 })); }
          catch (e) { errors.push(`GetQuote ${thisQuoteIdInDomain}: ${String(e).substring(0, 120)}`); continue; }
          const quote = qData?.quoteByIdInDomainAndRevisionNumber || qData?.quoteByIdInDomain;
          if (!quote) { errors.push(`No se pudo leer quote #${thisQuoteIdInDomain}.`); continue; }
          const qpnpNodes = quote.quotePartNumberPricesByQuoteId?.nodes || [];
          const qlNodes = quote.quoteLinesByQuoteId?.nodes || [];
          const qlByQpnpId = new Map(); for (const ql of qlNodes) if (ql.autoGeneratedFromQuotePartNumberPriceId) qlByQpnpId.set(ql.autoGeneratedFromQuotePartNumberPriceId, ql);
          for (const qpnp of qpnpNodes) {
            const pnp = qpnp.partNumberPriceByPartNumberPriceId; if (!pnp) continue;
            const pn = pnp.partNumberByPartNumberId; if (!pn?.name) continue;
            pnLookup.set(`${pn.name.toUpperCase()}|${cid}`, { qpnp, pnp, pn, ql: qlByQpnpId.get(qpnp.id) || null, quoteId: thisQuoteId });
          }
          const allProdNodes = quote.allProducts?.nodes || qData.allProducts?.nodes || [];
          if (allProdNodes.length) for (const p of allProdNodes) productByName.set(p.name, p);

          // SaveQuoteLines (products) for this customer's parts
          for (const { part } of custParts) {
            if (!part.products.length) continue;
            const entry = pnLookup.get(`${part.pn.toUpperCase()}|${cid}`); if (!entry) { errors.push(`PN "${part.pn}" no en quote.`); continue; }
            const ql = entry.ql; if (!ql) { errors.push(`QuoteLine no encontrada para "${part.pn}".`); continue; }
            const existing = ql.quoteLineItemsByQuoteLineId?.nodes || [];
            const idsToDelete = existing.map(ei => ei.id).filter(Boolean);

            if (part.products.length === 1 && isDash(part.products[0].name)) {
              if (idsToDelete.length) {
                try {
                  await api().query('SaveQuoteLines', { input: { quoteId: thisQuoteId, quoteLines: [{ savedQuoteLineId: ql.id, lineNumber: ql.lineNumber, title: ql.title, description: '', autoGeneratedFromQuotePartNumberPriceId: ql.autoGeneratedFromQuotePartNumberPriceId, quoteLineItems: [] }], quoteLinesToDelete: [], quoteLineItemsToDelete: idsToDelete, quoteLineNumberUpdates: [] } });
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
              prodAddedTotal++;
            }
            if (!items.length) continue;
            try {
              await api().query('SaveQuoteLines', { input: { quoteId: thisQuoteId, quoteLines: [{ savedQuoteLineId: ql.id, lineNumber: ql.lineNumber, title: ql.title, description: ql.description || '', autoGeneratedFromQuotePartNumberPriceId: ql.autoGeneratedFromQuotePartNumberPriceId, quoteLineItems: items }], quoteLinesToDelete: [], quoteLineItemsToDelete: idsToDelete, quoteLineNumberUpdates: [] } });
            } catch (e) { errors.push(`SaveQuoteLines "${part.pn}": ${String(e).substring(0, 100)}`); }
          }

          // UpdateQuote notes
          try {
            if (header.notasExternas) await api().query('UpdateQuote', { id: thisQuoteId, notesMarkdown: isDash(header.notasExternas) ? '' : header.notasExternas });
            if (header.notasInternas) await api().query('UpdateQuote', { id: thisQuoteId, internalNotesMarkdown: isDash(header.notasInternas) ? '' : header.notasInternas });
          } catch (e) { errors.push(`UpdateQuote ${thisQuoteIdInDomain}: ${String(e).substring(0, 100)}`); }
        }
        stats.productsSet = prodAddedTotal;
        stats.quoteIdInDomain = primaryQuoteIdInDomain;
        if (quotesCreated.length > 1) stats.quoteName = `${quotesCreated.length} cotizaciones "${quoteName}"`;
        else if (quotesCreated.length === 1) stats.quoteName = quotesCreated[0].name;
        showProgressUI(`  -> ${quotesCreated.length} cotizaciones creadas, ${prodAddedTotal} products`);
      } else {
        // SOLO_PN: build pnLookup from existing/new PN IDs (no quote context)
        showProgressUI('Modo SOLO_PN: construyendo mapa de PNs...'); setProgressBar(30);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]; const status = pnStatus[i];
          let pnId;
          if (status.status === 'existing') { pnId = status.existingId; stats.pnsExisting++; }
          else { pnId = newPnIds.get(`${part.pn.toUpperCase()}|${part.customerId}`); }
          if (!pnId) continue;
          // V10: key by pn|customerId
          pnLookup.set(`${part.pn.toUpperCase()}|${part.customerId}`, {
            qpnp: null, pnp: null,
            pn: { id: pnId, name: part.pn, customerId: part.customerId, defaultProcessNodeId: part.processId, customInputs: {}, descriptionMarkdown: '', customerFacingNotes: '', geometryTypeId: null, partNumberGroupId: null },
            ql: null
          });
        }
        log(`  ${pnLookup.size} PNs mapeados (SOLO_PN)`);

        // SOLO_PN: Create standalone prices if precio is provided
        const pnpWithPrice = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part.precio === null && !part.qty) continue; // no price data
          const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
          pnpWithPrice.push({
            partNumberId: entry.pn.id,
            processId: part.processId,
            customInputs: { DatosPrecio: { Divisa: part.divisa || 'USD' } }, inputSchema: DIVISA_SCHEMA, uiSchema: DIVISA_UI,
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
          // Default price se aplica en STEP 8 releyendo prices del PN
        }
        setProgressBar(50);
      }

      // STEP 6: SavePartNumber (enrich) — runs in BOTH modes
      showProgressUI(`${isSoloPN ? 'Paso 3' : 'Paso 6'}: Enriqueciendo PNs...`); setProgressBar(55);

      // V10 fix: Pre-fetch existing predicted inventory usages para PNs existentes con predictivos.
      // SavePartNumber inserta sin id → unique constraint en (pn, inventoryItem) → retry strippea
      // los predictivos y se pierde la actualización. Pasamos el id existente para forzar UPDATE.
      const existingPredictedMap = new Map(); // pnId → Map(inventoryItemId → existingRecordId)
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]; const st = pnStatus[i];
        if (st.status !== 'existing' || !p.predictiveUsage.length) continue;
        const e = pnLookup.get(`${p.pn.toUpperCase()}|${p.customerId}`); if (!e?.pn?.id) continue;
        if (existingPredictedMap.has(e.pn.id)) continue; // ya cargado
        try {
          const pnData = await api().query('GetPartNumber', { partNumberId: e.pn.id });
          const exPred = pnData?.partNumberById?.predictedInventoryUsagesByPartNumberId?.nodes || [];
          const m = new Map();
          for (const ep of exPred) {
            const itemId = ep.inventoryItemByInventoryItemId?.id || ep.inventoryItemId;
            if (itemId && ep.id) m.set(String(itemId), ep.id);
          }
          existingPredictedMap.set(e.pn.id, m);
        } catch (_) {}
      }
      if (existingPredictedMap.size) log(`  Pre-fetched predictivos existentes de ${existingPredictedMap.size} PNs`);

      let okSP = 0, retrySP = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
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
            const sel = { defaultParamId: pid, processNodeId: part.processId || pn.defaultProcessNodeId || null, processNodeOccurrence: (part.processId || pn.defaultProcessNodeId) ? 1 : null, locationId: null, geometryTypeSpecFieldId: null };
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
        // V10: Proceso siempre viene de la línea (obligatorio, sin fallback)
        const pnProcessId = part.processId;

        const pnInput = {
          id: pn.id, name: pn.name, customerId: pn.customerId || part.customerId, defaultProcessNodeId: pnProcessId,
          descriptionMarkdown: resolveStr(part.descripcion, pn.descriptionMarkdown || ''), customerFacingNotes: pn.customerFacingNotes || '',
          customInputs: mergedCI || pn.customInputs || {}, inputSchemaId: DOMAIN.inputSchemaId_PN, labelIds,
          partNumberGroupId: pnGroupId,
          geometryTypeId: hasDims ? DOMAIN.geometryGenericaId : (pn.geometryTypeId || null),
          inventoryItemInput: ucs.length ? { materialId: null, purchasable: false, sourceMaterialConversionType: null, providedMaterialConversionType: null, defaultLeadTime: null, unitConversions: ucs, inventoryItemVendors: [] } : null,
          // V10: solo enviar predictivos NUEVOS (sin registro existente). Los que ya existen
          // se actualizan después con UpdateInventoryItemPredictedUsage para evitar el unique
          // constraint en (pn, inventoryItem) que disparaba el retry y strippeaba el campo.
          inventoryPredictedUsages: finalPredictive
            .filter(pu => !existingPredictedMap.get(pn.id)?.has(String(pu.inventoryItemId)))
            .map(pu => ({ inventoryItemId: pu.inventoryItemId, usagePerPart: pu.usagePerPart, lowCodeId: null })),
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

      // STEP 6a: Actualizar predictivos existentes vía UpdateInventoryItemPredictedUsage.
      // Steelhead almacena en microQuantityPerPart (kg/pza × 1e6 redondeado).
      const predictedUpdates = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        if (status.status !== 'existing') continue;
        if (!part.predictiveUsage.length) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
        const exMap = entry?.pn?.id ? existingPredictedMap.get(entry.pn.id) : null;
        if (!exMap || !exMap.size) continue;
        // Si el primer predictivo es "-" se borra todo (ya manejado por finalPredictive arriba: queda [])
        const predIsDash = part.predictiveUsage.length === 1 && typeof part.predictiveUsage[0]?.usagePerPart === 'string' && isDash(part.predictiveUsage[0].usagePerPart);
        if (predIsDash) continue;
        for (const pu of part.predictiveUsage) {
          const exId = exMap.get(String(pu.inventoryItemId));
          if (!exId) continue; // es uno nuevo, ya fue al SavePartNumber
          const micro = Math.round(parseFloat(pu.usagePerPart) * 1e6);
          if (!Number.isFinite(micro)) continue;
          predictedUpdates.push({ id: exId, microQuantityPerPart: micro, inventoryUsageLowCodeId: null });
        }
      }
      if (predictedUpdates.length) {
        // Batches de 20 para no abusar del payload
        for (let i = 0; i < predictedUpdates.length; i += 20) {
          const batch = predictedUpdates.slice(i, i + 20);
          try {
            await api().query('UpdateInventoryItemPredictedUsage', { mnPredictedInventoryUsagePatch: batch }, 'UpdateInventoryItemPredictedUsage');
          } catch (e) {
            errors.push(`UpdatePredictedUsage batch ${Math.floor(i / 20) + 1}: ${String(e).substring(0, 120)}`);
          }
        }
        log(`  Predictivos actualizados: ${predictedUpdates.length}`);
      }

      // STEP 6b: Sync params on existing PNs whose specs were already linked.
      // SavePartNumber.specsToApply ignora specs ya ligadas — si el usuario agregó un field
      // nuevo a la spec definición, no se aplica al PN. Aquí lo emparejamos con AddParamsToPartNumber.
      let syncedParamsCount = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const status = pnStatus[i];
        if (status.status !== 'existing' || !part.specs.length) continue;
        if (part.specs.length === 1 && isDash(part.specs[0].name)) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
        if (!entry?.pn?.id) continue;
        try {
          const pnData = await api().query('GetPartNumber', { partNumberId: entry.pn.id });
          const pnNode = pnData?.partNumberById; if (!pnNode) continue;
          const linkedSpecs = pnNode.partNumberSpecsByPartNumberId?.nodes || [];
          const allParams = pnNode.partNumberSpecFieldParamsByPartNumberId?.nodes || [];
          for (const cs of part.specs) {
            if (isDash(cs.name)) continue;
            const si = specByName.get(cs.name); if (!si) continue;
            const linked = linkedSpecs.find(s => s.specBySpecId?.id === si.id && !s.archivedAt);
            if (!linked) continue; // not linked → SavePartNumber ya lo creó (o lo creará en otro flujo)
            // wanted params: misma lógica que en STEP 6 spec build
            const sd = sfCache.get(si.id); if (!sd) continue;
            const wantedParamIds = new Set();
            const wantedSelections = []; // {specFieldId, specFieldParamId, isGeneric}
            for (const sf of (sd.specFieldSpecsBySpecId?.nodes || [])) {
              const params = sf.defaultValues?.nodes || []; if (!params.length) continue;
              const fn = sf.specFieldBySpecFieldId?.name || '';
              const isEsp = fn.toLowerCase().includes('espesor');
              let pid;
              if (params.length === 1) pid = params[0].id;
              else if (isEsp && cs.param) { const m = params.find(p => p.name === cs.param); pid = m ? m.id : params[0].id; }
              else pid = params[0].id;
              if (!pid) continue;
              wantedParamIds.add(pid);
              wantedSelections.push({ specFieldId: sf.specFieldBySpecFieldId?.id, specFieldParamId: pid, isGeneric: !!sf.isGeneric });
            }
            // existing active params on this PN
            const existingParamIds = new Set(
              allParams
                .filter(p => !p.archivedAt && p.specFieldParamBySpecFieldParamId)
                .map(p => p.specFieldParamBySpecFieldParamId.id)
            );
            const missing = wantedSelections.filter(s => !existingParamIds.has(s.specFieldParamId));
            if (!missing.length) continue;
            const paramsToAdd = missing.map(m => ({
              specFieldId: m.specFieldId,
              specFieldParamId: m.specFieldParamId,
              isGeneric: m.isGeneric,
              geometryTypeSpecFieldId: null,
              processNodeId: part.processId || null,
              processNodeOccurrence: part.processId ? 1 : null,
              locationId: null
            }));
            try {
              await api().query('AddParamsToPartNumber', { input: { partNumberId: entry.pn.id, paramsToApply: paramsToAdd } }, 'AddParamsToPartNumber');
              syncedParamsCount += paramsToAdd.length;
              log(`  PN "${part.pn}" spec "${cs.name}": ${paramsToAdd.length} params nuevos sincronizados`);
            } catch (e) {
              errors.push(`AddParams "${part.pn}" spec "${cs.name}": ${String(e).substring(0, 120)}`);
            }
          }
        } catch (e) {
          warn(`Sync specs "${part.pn}": ${String(e).substring(0, 100)}`);
        }
      }
      if (syncedParamsCount) log(`  Spec params sync: ${syncedParamsCount} params agregados`);

      // STEP 7: RackTypes — runs in BOTH modes
      showProgressUI(`${isSoloPN ? 'Paso 4' : 'Paso 7'}: Racks...`); setProgressBar(78);
      const rackIn = [];
      const racksToDelete = []; // PNs where racks should be deleted (guión)
      for (const part of parts) {
        if (!part.racks.length) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
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
      // Add new racks. Si ya existe el (rackType, PN) hay duplicate key —
      // entonces borramos el viejo y reinsertamos con el partsPerRack nuevo.
      async function upsertRack(rk) {
        try {
          await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: [rk], partNumberRackTypeIdsToDelete: [] } });
        } catch (e2) {
          if (String(e2).includes('duplicate key') || String(e2).includes('23505')) {
            // Buscar el rack existente y borrarlo, luego reinsertar
            try {
              const pnData = await api().query('GetPartNumber', { partNumberId: rk.partNumberId });
              const existing = (pnData?.partNumberById?.partNumberRackTypesByPartNumberId?.nodes || [])
                .find(r => String(r.rackTypeId) === String(rk.rackTypeId));
              if (existing) {
                await api().query('DeletePartNumberRackType', { id: existing.id });
                await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: [rk], partNumberRackTypeIdsToDelete: [] } });
                log(`  Rack ${rk.rackTypeId} en PN ${rk.partNumberId}: actualizado a ${rk.partsPerRack}`);
              } else {
                errors.push(`Rack PN ${rk.partNumberId}: dup pero no encontrado en GetPartNumber`);
              }
            } catch (e3) {
              errors.push(`Rack PN ${rk.partNumberId} update: ${String(e3).substring(0, 100)}`);
            }
          } else {
            errors.push(`Rack PN ${rk.partNumberId}: ${String(e2).substring(0, 100)}`);
          }
        }
      }

      if (rackIn.length) {
        for (let i = 0; i < rackIn.length; i += 50) {
          const batch = rackIn.slice(i, i + 50);
          try {
            await api().query('SavePartNumberRackTypes', { input: { partNumberRackTypes: batch, partNumberRackTypeIdsToDelete: [] } });
          } catch (e) {
            if (String(e).includes('duplicate key') || String(e).includes('23505')) {
              log(`  Racks batch ${Math.floor(i / 50) + 1}: duplicados, upsertando uno por uno...`);
              for (const rk of batch) await upsertRack(rk);
            } else { errors.push(`SavePartNumberRackTypes: ${String(e).substring(0, 120)}`); }
          }
        }
      }
      stats.racksSet = rackIn.length + racksToDelete.length; log(`  Racks: ${rackIn.length} agregados, ${racksToDelete.length} PNs con racks eliminados`);

      // STEP 7b: Delete prices (guión in precio column)
      const pricesToDelete = [];
      for (const part of parts) {
        if (!isDash(String(part.precio))) continue;
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
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
        const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
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
          const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`); if (!entry) continue;
          const pnpId = entry.pnp?.id;
          if (!pnpId) continue;
          if (part.precioDefault) priceIdsForDefault.push(pnpId);
          else priceIdsToUnsetDefault.push(pnpId);
        }
      } else {
        // SOLO_PN: necesitamos releer los precios del PN porque el ID del nuevo precio
        // no lo tenemos (SaveManyPartNumberPrices no devuelve los IDs en este flujo)
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const entry = pnLookup.get(`${part.pn.toUpperCase()}|${part.customerId}`);
          if (!entry?.pn?.id) continue;
          // Solo releemos si hay algo que hacer con el default
          const needsRead = part.precioDefault || (!part.precioDefault && pnStatus[i].status === 'existing');
          if (!needsRead) continue;
          try {
            const pnData = await api().query('GetPartNumber', { partNumberId: entry.pn.id });
            const prices = pnData?.partNumberById?.partNumberPricesByPartNumberId?.nodes || [];
            if (!prices.length) continue;
            if (part.precioDefault) {
              // El precio recién creado en esta corrida es el de ID más alto
              const sorted = [...prices].sort((a, b) => Number(b.id) - Number(a.id));
              const newest = sorted[0];
              if (newest) priceIdsForDefault.push(newest.id);
              // Quita el default del viejo (si era distinto del nuevo)
              const oldDefault = prices.find(p => p.isDefault && p.id !== newest.id);
              if (oldDefault) priceIdsToUnsetDefault.push(oldDefault.id);
            } else {
              // FALSE explícito en existente = quitar el default actual
              const defaultPrice = prices.find(p => p.isDefault);
              if (defaultPrice) priceIdsToUnsetDefault.push(defaultPrice.id);
            }
          } catch (_) {}
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
      // V10: si se creó UNA sola cotización abrir esa; si fueron varias, abrir el listado general
      let quoteUrl = null;
      let quoteUrlLabel = 'ABRIR COTIZACIÓN';
      if (!isSoloPN && quotesCreated.length === 1) {
        quoteUrl = `/Domains/${domainId}/Quotes/${primaryQuoteIdInDomain}`;
      } else if (!isSoloPN && quotesCreated.length > 1) {
        quoteUrl = `/Domains/${domainId}/Quotes`;
        quoteUrlLabel = 'VER LISTA DE COTIZACIONES';
      }
      log(`\n=== RESULTADO ===`);
      log(`${isSoloPN ? 'Modo: SOLO_PN' : `Cotizaciones: ${quotesCreated.length} (${quotesCreated.map(q => '#' + q.idInDomain).join(', ')})`}`);
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
          customerName: [...customerCache.values()].map(c => c.name).join(', '),
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

      showResult(stats, quoteUrl, errors, quoteUrlLabel);
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
