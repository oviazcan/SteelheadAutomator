// Reaplicar parámetros a las specs de Órdenes de Trabajo — glue (red + DOM).
// La decisión vive en wo-spec-params-core.js; aquí solo se consulta, se dibuja y se escribe.
//
// Nada se escribe sin que el operador vea el preview y confirme un conteo.
// Ver docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md
(function () {
  'use strict';

  const VERSION = '0.5.0';
  const PANEL_ID = 'sa-wo-spec-params-panel';
  const STYLE_ID = 'sa-wo-spec-params-style';
  const FAB_ID = 'sa-wo-spec-params-fab';

  const WO_DETAIL_RE = /\/Domains\/(\d+)\/WorkOrders\/(\d+)(?:[/?#]|$)/i;

  function isWorkOrderDetailPath(p) { return typeof p === 'string' && WO_DETAIL_RE.test(p); }
  function parseWorkOrderIdInDomain(p) {
    if (typeof p !== 'string') return null;
    const m = p.match(WO_DETAIL_RE);
    return m ? parseInt(m[2], 10) : null;
  }

  // Pega números de OT: acepta comas, saltos de línea, espacios y un '#' inicial.
  // Deduplica conservando el orden de aparición y cuenta los renglones ilegibles.
  function parsePastedWorkOrders(text) {
    const ids = [];
    const seen = new Set();
    let ignored = 0;
    for (const tok of String(text == null ? '' : text).split(/[\s,;]+/)) {
      const t = tok.trim().replace(/^#/, '');
      if (!t) continue;
      if (!/^\d+$/.test(t)) { ignored++; continue; }
      const n = parseInt(t, 10);
      if (seen.has(n)) continue;
      seen.add(n);
      ids.push(n);
    }
    return { ids, ignored };
  }

  // Pega Números de Parte: separa ids numéricos de nombres. Ambos conviven en la misma caja
  // porque el operador a veces trae la lista del ERP (ids) y a veces del cliente (nombres).
  function parsePastedPartNumbers(text) {
    const ids = [], names = [];
    const seenId = new Set(), seenName = new Set();
    let ignored = 0;
    for (const raw of String(text == null ? '' : text).split(/[\n,;]+/)) {
      const t = raw.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (!seenId.has(n)) { seenId.add(n); ids.push(n); }
      } else if (/^[\w][\w .\-/]*$/.test(t)) {
        const u = t.toUpperCase();
        if (!seenName.has(u)) { seenName.add(u); names.push(t); }
      } else {
        ignored++;
      }
    }
    return { ids, names, ignored };
  }

  // Nombre → ids. OJO: los nombres de NP NO son únicos — verificado el 2026-07-28, "80236-167-07"
  // resuelve a NUEVE NPs activos. Se expande a TODOS los homónimos exactos, y eso es seguro:
  // cada orden se compara contra el NP que ELLA tiene asociado, nunca contra "el que pegaste".
  // Expandir solo amplía la cobertura; no puede corregir una orden contra el NP equivocado.
  async function resolvePartNumbers(parsed, deps) {
    const D = deps || realDeps;
    const out = { partNumberIds: [], porNombre: {}, noResueltos: [], errores: [] };
    const seen = new Set();
    for (const id of (parsed.ids || [])) {
      if (!seen.has(id)) { seen.add(id); out.partNumberIds.push(id); }
    }
    for (const name of (parsed.names || [])) {
      let nodes = [];
      try {
        nodes = await D.searchPartNumbers(name);
      } catch (e) {
        out.errores.push(name + ': ' + ((e && e.message) ? e.message : String(e)));
        continue;
      }
      const target = String(name).trim().toUpperCase();
      const exactos = (nodes || []).filter(n => String(n.name || '').trim().toUpperCase() === target);
      if (!exactos.length) { out.noResueltos.push(name); continue; }
      out.porNombre[name] = exactos.map(n => ({ id: n.id, name: n.name }));
      for (const n of exactos) {
        if (!seen.has(n.id)) { seen.add(n.id); out.partNumberIds.push(n.id); }
      }
    }
    return out;
  }

  // NPs → sus órdenes abiertas. Una orden puede colgar de varios NPs, así que se deduplica.
  async function findWorkOrdersForPartNumbers(partNumberIds, deps) {
    const D = deps || realDeps;
    const out = { idsInDomain: [], porPartNumber: {}, sinOrdenes: [], errores: [] };
    const seen = new Set();
    for (const pnId of (partNumberIds || [])) {
      let wos = [];
      try {
        wos = await D.workOrdersForPartNumber(pnId);
      } catch (e) {
        out.errores.push('NP ' + pnId + ': ' + ((e && e.message) ? e.message : String(e)));
        continue;
      }
      out.porPartNumber[pnId] = wos || [];
      if (!wos || !wos.length) { out.sinOrdenes.push(pnId); continue; }
      for (const w of wos) {
        const k = w.idInDomain;
        if (k != null && !seen.has(k)) { seen.add(k); out.idsInDomain.push(k); }
      }
    }
    return out;
  }

  function api() { return window.SteelheadAPI; }
  function core() { return window.WoSpecParamsCore; }
  function hostCleanup() { return window.SteelheadHostCleanup; }

  // ── Fase 3: piezas del escaneo largo ───────────────────────────────────────

  // Concurrencia acotada. El tope es 3 y no se sube: el /graphql se cuelga alrededor de las
  // 40-45 peticiones en ráfaga —sin devolver 429, sin recuperarse al recargar— y tumba también
  // la pantalla nativa, porque el límite es por SESIÓN y no por pestaña (lección po-listing-filters).
  async function runPool(items, limit, worker, shouldStop) {
    const list = items || [];
    const n = Math.max(1, Math.min(limit || 1, 3));
    let i = 0;
    async function lane() {
      while (i < list.length) {
        if (shouldStop && shouldStop()) return;
        const idx = i++;
        try { await worker(list[idx], idx); } catch (_) { /* el worker reporta; la pasada sigue */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, lane));
  }

  function planScanChunks(ids, size) {
    const out = [];
    const s = Math.max(1, size || 100);
    for (let i = 0; i < (ids || []).length; i += s) out.push(ids.slice(i, i + s));
    return out;
  }

  // Reanudar: quita del pendiente lo que el checkpoint ya marcó como hecho.
  function mergeCheckpoint(todas, checkpoint) {
    const done = new Set(((checkpoint && checkpoint.done) || []));
    const pendientes = (todas || []).filter(id => !done.has(id));
    return {
      pendientes,
      yaHechas: done.size,
      hallazgos: (checkpoint && checkpoint.hallazgos) || []
    };
  }

  // Guarda SOLO lo que hace falta para aplicar después. El resultado completo trae `cells` con
  // los nodos crudos del ERP; en una corrida de 4284 órdenes eso es el OOM (spec §7).
  function slimResult(r) {
    const plan = r.plan || {};
    const t = r.tally || {};
    const tieneTrabajo = (plan.touched || 0) > 0;
    const out = {
      idInDomain: r.idInDomain,
      partNumberId: r.partNumberId,
      partNumberName: r.partNumberName,
      workOrderId: r.workOrderId,
      tieneTrabajo,
      nAnomalias: (r.anomalies || []).length,
      nFueraDeInspeccion: (r.fueraDeInspeccion || []).length,
      nForzadas: (r.cells || []).filter(c => c && c.forced).length,
      nOmitidas: (plan.skipped || []).length,
      // Cuántas dejó fuera el modo acotado. Va en el slim aunque la orden no tenga trabajo:
      // si no, un barrido en modo acotado no podría reportar qué se decidió no escribir.
      soloNP: plan.soloNP || 0
    };
    if (tieneTrabajo) {
      out.tally = { OK: t.OK || 0, VACIO: t.VACIO || 0, DIFIERE: t.DIFIERE || 0,
                    DUPLICADO: t.DUPLICADO || 0, AMBIGUO: t.AMBIGUO || 0,
                    SIN_CATALOGO: t.SIN_CATALOGO || 0 };
      out.plan = {
        archiveIds: plan.archiveIds || [],
        parametersToAdd: plan.parametersToAdd || [],
        touched: plan.touched || 0,
        soloNP: plan.soloNP || 0,
        skipped: []
      };
      // Renglones legibles para el preview y el CSV, sin arrastrar los nodos crudos.
      out.cambios = (r.cells || [])
        .filter(c => c && c.status !== 'OK' && c.status !== 'AMBIGUO' && c.status !== 'SIN_CATALOGO')
        .map(c => ({
          nodo: c.recipeNodeName, campo: c.fieldName, estado: c.status,
          forzada: !!c.forced, ambito: c.scope,
          tenia: (c.appliedRows && c.appliedRows[0] && c.appliedRows[0].specFieldParamBySpecFieldParamId
                  && c.appliedRows[0].specFieldParamBySpecFieldParamId.name) || '',
          quedara: (c.desired && c.desired.refName) || ''
        }));
    }
    return out;
  }

  // ── Checkpoint en IndexedDB ───────────────────────────────────────────────
  // localStorage no aguanta una corrida de 4284 órdenes (lección bulk-upload, que migró
  // sa_load_history por esto mismo).

  const DB_NAME = 'sa_wo_spec_params';
  const STORE = 'scans';

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function ckSave(key, value) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, value, ts: new Date().toISOString() });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (e) { console.warn('[wo-spec-params] no pude guardar el checkpoint:', e); }
  }
  async function ckLoad(key) {
    try {
      const db = await idb();
      const v = await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result ? r.result.value : null);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return v;
    } catch (e) { return null; }
  }
  async function ckClear(key) {
    try {
      const db = await idb();
      await new Promise((res) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = res; tx.onerror = res;
      });
      db.close();
    } catch (_) {}
  }

  // ── Consultas (inyectables para poder testear sin red) ─────────────────────

  const realDeps = {
    // idInDomain → { id (global), partNumberIds[] }
    async getWorkOrderIds(idInDomain) {
      const d = await api().query('PartNumbersByWorkOrderIdInDomain', { idInDomain },
                                  'PartNumbersByWorkOrderIdInDomain');
      const wo = d && d.workOrderByIdInDomain;
      if (!wo) return { id: null, partNumberIds: [] };
      const locs = (wo.partLocationsByWorkOrderId && wo.partLocationsByWorkOrderId.nodes) || [];
      const ids = [];
      const seen = new Set();
      for (const l of locs) {
        const pn = l && l.partNumberByPartNumberId;
        if (pn && pn.id != null && !seen.has(pn.id)) { seen.add(pn.id); ids.push(pn.id); }
      }
      return { id: wo.id, partNumberIds: ids };
    },
    async getSpecsInfo(partNumberId, workOrderId) {
      const d = await api().query('GetPartNumberWorkOrderSpecsInfo', { partNumberId, workOrderId },
                                  'GetPartNumberWorkOrderSpecsInfo');
      return d && d.workOrderById;
    },
    async getPartNumber(partNumberId) {
      const d = await api().query('GetPartNumber', { partNumberId }, 'GetPartNumber');
      return d && d.partNumberById;
    },
    // Nombre → NPs. searchQuery hace match PARCIAL; el filtro exacto lo pone resolvePartNumbers.
    async searchPartNumbers(name) {
      const d = await api().query('SearchPartNumbers',
        { searchQuery: name, first: 100, offset: 0, orderBy: ['ID_DESC'] }, 'SearchPartNumbers');
      return (d && d.searchPartNumbers && d.searchPartNumbers.nodes) || [];
    },
    // NP → sus órdenes ABIERTAS (status ACTIVE), paginado.
    // `partNumberIdFilter` NO aparece en el sample del scan: se descubrió probando en vivo el
    // 2026-07-28. CUIDADO: los nombres parecidos (partNumberIdsFilter, partNumberFilter,
    // partNumberIds) el server los IGNORA EN SILENCIO y devuelve el dominio completo — 4284
    // órdenes en vez de 4. Un typo aquí no falla: procesa todo. Por eso el test lo fija.
    // TODAS las órdenes abiertas del dominio, paginado. Solo idInDomain — nada más se guarda.
    // Medido el 2026-07-28: 4284 activas.
    async allOpenWorkOrders(onProgress) {
      const PAGE = 100;
      const out = [];
      let total = null;
      for (let offset = 0; ; offset += PAGE) {
        const d = await api().query('AllWorkOrders', {
          status: 'ACTIVE', includeArchived: 'NO', couponWorkOrders: null, computeMargins: false,
          orderBy: ['ID_DESC'], offset, first: PAGE, searchQuery: ''
        }, 'AllWorkOrders');
        const paged = d && d.pagedData;
        const nodes = (paged && paged.nodes) || [];
        if (total == null) total = (paged && paged.totalCount) || 0;
        for (const n of nodes) if (n && n.idInDomain != null) out.push(n.idInDomain);
        if (onProgress) onProgress(out.length, total);
        if (!nodes.length || out.length >= total) break;
        if (offset > 100000) break;   // tope duro contra un bucle infinito
      }
      return { ids: out, total };
    },
    async workOrdersForPartNumber(partNumberId) {
      const PAGE = 100;
      const out = [];
      for (let offset = 0; ; offset += PAGE) {
        const d = await api().query('AllWorkOrders', {
          status: 'ACTIVE', includeArchived: 'NO', couponWorkOrders: null, computeMargins: false,
          orderBy: ['ID_DESC'], offset, first: PAGE, searchQuery: '',
          partNumberIdFilter: [partNumberId]
        }, 'AllWorkOrders');
        const paged = d && d.pagedData;
        const nodes = (paged && paged.nodes) || [];
        for (const n of nodes) out.push({ id: n.id, idInDomain: n.idInDomain, name: n.name || '' });
        const total = paged && paged.totalCount;
        if (!nodes.length || out.length >= (total || 0) || offset > 5000) break;
      }
      return out;
    }
  };

  const writeDeps = {
    async archive(ids) {
      return api().query('ArchivePartNumberRecipeNodeSpecFieldParams',
        { partNumberRecipeNodeSpecFieldParamIds: ids, archivedAt: new Date().toISOString() },
        'ArchivePartNumberRecipeNodeSpecFieldParams');
    },
    async addParams(partNumberId, parametersToAdd) {
      return api().query('AddParamsToPartNumberRecipeNodeSpecFieldParam',
        { input: { partNumberId, parametersToAdd } },
        'AddParamsToPartNumberRecipeNodeSpecFieldParam');
    }
  };

  // Caché de Números de Parte para el escaneo largo: muchas órdenes comparten NP, y cada
  // GetPartNumber repetido es una consulta tirada. Se limpia al terminar (EJE A).
  let _pnCache = null;
  function pnCacheOn() { _pnCache = new Map(); }
  function pnCacheOff() { if (_pnCache) _pnCache.clear(); _pnCache = null; }

  // Analiza UNA orden. Devuelve un resultado por cada NP de la orden.
  // Destila y descarta: la respuesta de getSpecsInfo pesa ~0.87 MB y NO se guarda.
  async function analyzeWorkOrder(idInDomain, deps) {
    const D = deps || realDeps;
    const C = core();
    let ids;
    try {
      ids = await D.getWorkOrderIds(idInDomain);
    } catch (e) {
      return { ok: false, idInDomain, error: 'No pude leer la orden: ' + (e && e.message ? e.message : e) };
    }
    if (!ids || !ids.id) return { ok: false, idInDomain, error: 'No encontré la orden ' + idInDomain };
    if (!ids.partNumberIds.length) {
      return { ok: false, idInDomain, error: 'La orden ' + idInDomain + ' no tiene número de parte asociado' };
    }

    const results = [];
    for (const partNumberId of ids.partNumberIds) {
      try {
        let workOrder = await D.getSpecsInfo(partNumberId, ids.id);
        let partNumber;
        if (_pnCache && _pnCache.has(partNumberId)) {
          partNumber = _pnCache.get(partNumberId);
        } else {
          partNumber = await D.getPartNumber(partNumberId);
          if (_pnCache) _pnCache.set(partNumberId, partNumber);
        }
        if (!workOrder) { results.push({ partNumberId, idInDomain, error: 'sin datos de specs' }); continue; }
        const cls = C.classifyWorkOrder({ workOrder, partNumber },
                                        { migrarAInspeccion: _migrarAInspeccion });
        const plan = C.buildWritePlan(cls, { partNumberId, soloNP: _soloNP });
        workOrder = null;   // EJE A: soltar los 0.87 MB antes de la siguiente vuelta
        results.push({
          partNumberId,
          partNumberName: (partNumber && partNumber.name) || String(partNumberId),
          workOrderId: ids.id,
          idInDomain,
          tally: cls.tally,
          cells: cls.cells,
          orphans: cls.orphans,
          anomalies: cls.anomalies,
          fueraDeInspeccion: cls.fueraDeInspeccion || [],
          faltantesSinDestino: cls.faltantesSinDestino || [],
          externalSpec: cls.externalSpec
            ? { specName: cls.externalSpec.specName, nCampos: cls.externalSpec.fieldIds.size }
            : null,
          inspectionNode: cls.inspectionNode && cls.inspectionNode.node
            ? { id: cls.inspectionNode.node.id, name: cls.inspectionNode.node.name }
            : { ambiguous: true, reason: (cls.inspectionNode && cls.inspectionNode.reason) || '' },
          plan
        });
      } catch (e) {
        results.push({ partNumberId, idInDomain, error: (e && e.message) ? e.message : String(e) });
      }
    }
    return { ok: true, idInDomain, workOrderId: ids.id, results };
  }

  function summarize(results) {
    const s = { ordenes: 0, casillas: 0, aCorregir: 0, omitidas: 0, soloNP: 0, aArchivar: 0, aAgregar: 0,
                forzadas: 0, anomalias: 0, fueraDeInspeccion: 0 };
    for (const r of (results || [])) {
      if (!r || !r.tally) continue;
      s.ordenes++;
      for (const k of ['OK', 'VACIO', 'DIFIERE', 'DUPLICADO', 'AMBIGUO', 'SIN_CATALOGO']) {
        s.casillas += (r.tally[k] || 0);
      }
      s.aCorregir += (r.plan && r.plan.touched) || 0;
      s.omitidas += (r.plan && r.plan.skipped ? r.plan.skipped.length : 0);
      s.soloNP += (r.plan && r.plan.soloNP) || 0;
      s.aArchivar += (r.plan && r.plan.archiveIds ? r.plan.archiveIds.length : 0);
      s.aAgregar += (r.plan && r.plan.parametersToAdd ? r.plan.parametersToAdd.length : 0);
      s.forzadas += (r.cells || []).filter(c => c && c.forced).length;
      s.anomalias += (r.anomalies || []).length;
      s.fueraDeInspeccion += (r.fueraDeInspeccion || []).length;
    }
    return s;
  }

  // Aplica el plan de UNA orden. Archiva primero y solo entonces agrega: si el archivado falla
  // y agregáramos igual, la casilla quedaría con DOS filas vivas — el estado que este applet
  // existe para evitar.
  async function applyPlan(result, deps) {
    const D = deps || writeDeps;
    const out = { archived: 0, added: 0, errors: [] };
    const plan = result && result.plan;
    if (!plan) return out;
    const archiveIds = plan.archiveIds || [];
    const toAdd = plan.parametersToAdd || [];
    if (!archiveIds.length && !toAdd.length) return out;

    if (archiveIds.length) {
      try {
        await D.archive(archiveIds);
        out.archived = archiveIds.length;
      } catch (e) {
        out.errors.push('Archivar: ' + ((e && e.message) ? e.message : String(e)));
        return out;   // sin archivar, no se agrega
      }
    }
    if (toAdd.length) {
      try {
        await D.addParams(result.partNumberId, toAdd);
        out.added = toAdd.length;
      } catch (e) {
        out.errors.push('Agregar: ' + ((e && e.message) ? e.message : String(e)));
      }
    }
    return out;
  }

  // ── Reporte ───────────────────────────────────────────────────────────────

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(results) {
    const rows = [['orden', 'numero_parte', 'tipo', 'nodo', 'campo', 'ambito', 'forzada',
                   'estado', 'tenia', 'quedara', 'id_archivado', 'id_escrito']];
    for (const r of (results || [])) {
      for (const c of (r.cells || [])) {
        if (!c || c.status === 'OK') continue;
        const tenia = (c.appliedRows && c.appliedRows[0]
          && c.appliedRows[0].specFieldParamBySpecFieldParamId
          && c.appliedRows[0].specFieldParamBySpecFieldParamId.name) || '';
        rows.push([r.idInDomain, r.partNumberName,
          c.forced ? 'FORZADA' : 'CASILLA',
          c.recipeNodeName, c.fieldName, c.scope, c.forced ? 'si' : 'no',
          c.status, tenia, (c.desired && c.desired.refName) || '',
          (c.toArchiveIds || []).join(' '), c.toAddWriteId == null ? '' : c.toAddWriteId]);
      }
      for (const a of (r.anomalies || [])) {
        rows.push([r.idInDomain, r.partNumberName, 'ANOMALIA',
          a.recipeNodeName, a.fieldName, 'EXTERNA', 'no',
          'NO_SE_TOCA', a.paramName, '', '', '']);
      }
    }
    return rows.map(cols => cols.map(csvCell).join(',')).join('\n') + '\n';
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  const CSS = `
#${PANEL_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;
 justify-content:center;background:rgba(6,10,16,.62);font-family:-apple-system,BlinkMacSystemFont,
 'Segoe UI',Roboto,sans-serif}
#${PANEL_ID} .sa-box{background:#1c2430;color:#e6e9ee;border:1px solid #2a3543;border-radius:10px;
 width:min(1080px,94vw);max-height:88vh;display:flex;flex-direction:column;
 box-shadow:0 18px 50px rgba(0,0,0,.5)}
#${PANEL_ID} .sa-hd{padding:14px 18px;border-bottom:1px solid #2a3543;display:flex;
 align-items:center;gap:10px}
#${PANEL_ID} .sa-hd h2{margin:0;font-size:15px;font-weight:600;flex:1}
#${PANEL_ID} .sa-bd{padding:16px 18px;overflow:auto;flex:1;font-size:13px;line-height:1.5}
#${PANEL_ID} .sa-ft{padding:12px 18px;border-top:1px solid #2a3543;display:flex;gap:10px;
 align-items:center;justify-content:flex-end}
#${PANEL_ID} button{font:inherit;font-size:13px;padding:8px 14px;border-radius:6px;cursor:pointer;
 border:1px solid #38465a;background:#232d3b;color:#e6e9ee}
#${PANEL_ID} button.sa-go{background:#13a36f;border-color:#13a36f;color:#fff;font-weight:600}
#${PANEL_ID} button:disabled{opacity:.45;cursor:not-allowed}
#${PANEL_ID} textarea{width:100%;min-height:130px;background:#141a23;color:#e6e9ee;
 border:1px solid #2a3543;border-radius:6px;padding:10px;font:inherit;font-size:13px;resize:vertical}
#${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
#${PANEL_ID} th{text-align:left;color:#93a2b5;font-weight:600;border-bottom:1px solid #2a3543;
 padding:6px 8px;position:sticky;top:0;background:#1c2430}
#${PANEL_ID} td{padding:5px 8px;border-bottom:1px solid #232d3b;vertical-align:top}
#${PANEL_ID} .sa-sum{background:#141a23;border:1px solid #2a3543;border-radius:6px;padding:10px 12px;
 margin-bottom:12px}
#${PANEL_ID} .sa-sum b{color:#13a36f;font-size:15px}
#${PANEL_ID} .sa-warn{border-left:3px solid #e0a341;background:#241f14;padding:10px 12px;
 border-radius:4px;margin-top:14px}
#${PANEL_ID} .sa-warn h3{margin:0 0 6px;font-size:12px;color:#e0a341;text-transform:uppercase;
 letter-spacing:.4px}
#${PANEL_ID} .sa-err{border-left:3px solid #e05c5c;background:#241618;padding:10px 12px;
 border-radius:4px;margin-top:14px;color:#f0b8b8}
#${PANEL_ID} .sa-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:3px;
 background:#3a3016;color:#e0a341;border:1px solid #5c4a1e;letter-spacing:.4px}
#${PANEL_ID} .sa-mut{color:#93a2b5}
#${PANEL_ID} .sa-prog{height:4px;background:#141a23;border-radius:2px;overflow:hidden;margin-top:10px}
#${PANEL_ID} .sa-prog i{display:block;height:100%;background:#13a36f;width:0;transition:width .2s}
#${FAB_ID}{position:fixed;right:22px;bottom:150px;z-index:2147482000;width:46px;height:46px;
 border-radius:50%;border:1px solid #2a3543;background:#1c2430;color:#e6e9ee;font-size:20px;
 cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)}
`;

  function injectStyles() {
    let el = document.getElementById(STYLE_ID);
    if (el) el.remove();
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function closePanel() {
    // EJE A/B: el panel puede quedar abierto 40 min sobre un escaneo del dominio entero.
    // Al cerrar se suelta TODO: el usuario puede reabrir y empezar limpio.
    _stopScan = true;
    try { if (_memMonitor) { _memMonitor.stop(); _memMonitor = null; } } catch (_) {}
    pnCacheOff();
    const node = document.getElementById(PANEL_ID);
    if (node) node.remove();
    document.removeEventListener('keydown', onEsc, true);
  }
  function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent SIEMPRE: los nombres vienen de GraphQL
    return n;
  }

  function buildShell(title) {
    closePanel();
    injectStyles();
    const wrap = el('div'); wrap.id = PANEL_ID;
    const box = el('div', 'sa-box');
    const hd = el('div', 'sa-hd');
    const h2 = el('h2', null, title);
    const x = el('button', null, 'Cerrar');
    x.addEventListener('click', closePanel);
    hd.append(h2, x);
    const bd = el('div', 'sa-bd');
    const ft = el('div', 'sa-ft');
    box.append(hd, bd, ft);
    wrap.appendChild(box);
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closePanel(); });
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onEsc, true);
    return { wrap, box, hd, h2, bd, ft };
  }

  function setTitle(ui, t) { ui.h2.textContent = t; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Fase 1 — captura
  function open(opts) {
    const o = opts || {};
    const fromScreen = parseWorkOrderIdInDomain(location.pathname);
    const ui = buildShell('🔧 Reaplicar parámetros de specs');

    if (o.mode === 'pantalla' && fromScreen) { runAnalysis(ui, [fromScreen]); return; }

    // Dos orígenes: por orden o por Número de Parte.
    let modo = o.mode === 'np' ? 'np' : 'ot';
    const tabs = el('div');
    tabs.style.cssText = 'display:flex;gap:8px;margin-bottom:12px';
    const bOT = el('button', null, 'Por orden');
    const bNP = el('button', null, 'Por Número de Parte');
    const bTodo = el('button', null, 'Todo el dominio');
    const p = el('p');
    const ta = el('textarea');
    const hint = el('p', 'sa-mut');

    function pintar() {
      bOT.className = modo === 'ot' ? 'sa-go' : '';
      bNP.className = modo === 'np' ? 'sa-go' : '';
      if (modo === 'ot') {
        p.textContent = 'Pega los números de orden, uno por renglón. También acepta comas.';
        ta.setAttribute('placeholder', '5769\n5770\n5771');
        hint.textContent = 'Se leen sus specs y se comparan contra el Número de Parte. Nada se escribe todavía.';
      } else {
        p.textContent = 'Pega los Números de Parte que corregiste — nombres o ids, uno por renglón.';
        ta.setAttribute('placeholder', '80236-167-07\n3044551');
        hint.textContent = 'Busco todas sus órdenes abiertas. Un mismo nombre puede corresponder a varios '
          + 'Números de Parte distintos: se toman todos, y cada orden se compara contra el suyo.';
      }
    }
    bOT.addEventListener('click', () => { modo = 'ot'; pintar(); });
    bNP.addEventListener('click', () => { modo = 'np'; pintar(); });
    bTodo.addEventListener('click', () => { openScan(ui); });
    tabs.append(bOT, bNP, bTodo);
    if (fromScreen && modo === 'ot') ta.value = String(fromScreen);
    pintar();
    const migWrap = el('label', 'sa-mut');
    migWrap.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-top:12px;cursor:pointer';
    const migChk = document.createElement('input');
    migChk.type = 'checkbox';
    migChk.checked = _migrarAInspeccion;
    migChk.addEventListener('change', () => { _migrarAInspeccion = migChk.checked; });
    const migTxt = el('span', null,
      'Mover al nodo de Inspección y Empaque los parámetros que hoy viven en otro nodo. '
      + 'Sin esto solo se aplica lo que falta; con esto además se reubica lo existente.');
    migWrap.append(migChk, migTxt);

    const npWrap = el('label', 'sa-mut');
    npWrap.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-top:10px;cursor:pointer';
    const npChk = document.createElement('input');
    npChk.type = 'checkbox';
    npChk.checked = _soloNP;
    npChk.addEventListener('change', () => { _soloNP = npChk.checked; });
    const npTxt = el('span', null,
      'Escribir SOLO lo que define el Número de Parte. Deja fuera los campos que el NP no '
      + 'declara y que se deducen porque el catálogo de la spec ofrece una sola opción '
      + '(típicamente parámetros de proceso: temperatura, concentración, tiempos). '
      + 'Más conservador y bastante más rápido en corridas grandes.');
    npWrap.append(npChk, npTxt);

    ui.bd.append(tabs, p, ta, hint, migWrap, npWrap);

    const go = el('button', 'sa-go', 'Analizar');
    go.addEventListener('click', () => {
      if (modo === 'ot') {
        const parsed = parsePastedWorkOrders(ta.value);
        if (!parsed.ids.length) { alert('No encontré ningún número de orden.'); return; }
        runAnalysis(ui, parsed.ids, parsed.ignored);
      } else {
        const parsed = parsePastedPartNumbers(ta.value);
        if (!parsed.ids.length && !parsed.names.length) { alert('No encontré ningún Número de Parte.'); return; }
        runFromPartNumbers(ui, parsed);
      }
    });
    const cancel = el('button', null, 'Cancelar');
    cancel.addEventListener('click', closePanel);
    ui.ft.append(cancel, go);
  }

  // Fase 3 — escaneo de TODO el dominio
  //
  // 4284 órdenes abiertas × ~0.87 MB por lectura. Es una corrida de ~40 min, así que nace
  // troceada, reanudable y con las dos memorias vigiladas (ver el skill memory-hardening).
  const CK_KEY = 'scan-dominio';
  let _stopScan = false;
  let _memMonitor = null;
  let _migrarAInspeccion = false;   // lo enciende el operador en el panel
  // Modo acotado: solo se escribe lo que el NP define (deja fuera la vía CATALOGO).
  let _soloNP = false;

  async function openScan(ui0) {
    const ui = ui0 || buildShell('🔧 Escanear todas las órdenes abiertas');
    setTitle(ui, '🔧 Escanear todas las órdenes abiertas');
    clear(ui.bd); clear(ui.ft);

    const prev = await ckLoad(CK_KEY);
    const aviso = el('div', 'sa-sum');
    aviso.appendChild(el('div', null,
      'Recorre TODAS las órdenes abiertas del dominio comparándolas contra su Número de Parte.'));
    aviso.appendChild(el('div', 'sa-mut',
      'Son unas 4,284 órdenes y cada lectura pesa ~0.87 MB: la pasada tarda cerca de 40 minutos. '
      + 'Solo LEE — al terminar verás el preview y decides qué aplicar.'));
    aviso.appendChild(el('div', 'sa-mut',
      'Deja esta pestaña abierta. Puedes detenerlo cuando quieras: lo avanzado se guarda y se reanuda.'));
    ui.bd.appendChild(aviso);

    if (prev && prev.done && prev.done.length) {
      const w = el('div', 'sa-warn');
      w.appendChild(el('h3', null, 'Hay un escaneo a medias'));
      w.appendChild(el('div', null, prev.done.length + ' órdenes ya revisadas · '
        + (prev.hallazgos || []).length + ' con algo que corregir'));
      w.appendChild(el('div', 'sa-mut', 'Guardado el ' + (prev.ts || '—')));
      ui.bd.appendChild(w);
    }

    const cancel = el('button', null, 'Cancelar');
    cancel.addEventListener('click', closePanel);
    if (prev && prev.done && prev.done.length) {
      const nuevo = el('button', null, 'Empezar de cero');
      nuevo.addEventListener('click', async () => { await ckClear(CK_KEY); runScan(ui, true); });
      const seguir = el('button', 'sa-go', 'Reanudar');
      seguir.addEventListener('click', () => runScan(ui, false));
      ui.ft.append(cancel, nuevo, seguir);
    } else {
      const go = el('button', 'sa-go', 'Escanear');
      go.addEventListener('click', () => runScan(ui, true));
      ui.ft.append(cancel, go);
    }
  }

  async function runScan(ui, desdeCero) {
    _stopScan = false;
    setTitle(ui, '🔧 Escaneando…');
    clear(ui.bd); clear(ui.ft);

    const status = el('p', null, 'Pidiendo la lista de órdenes abiertas…');
    const bar = el('div', 'sa-prog'); const fill = el('i'); bar.appendChild(fill);
    const detalle = el('p', 'sa-mut', '');
    const mem = el('span', 'sa-mut', '');
    mem.id = 'sa-wsp-mem';
    const memWrap = el('p', 'sa-mut'); memWrap.append(document.createTextNode('memoria: '), mem);
    ui.bd.append(status, bar, detalle, memWrap);

    const H = hostCleanup();
    // EJE B — el host deja de acumular durante la corrida larga
    try { if (H) H.stopDatadogSessionReplay(); } catch (_) {}
    const drain = (H && H.makePeriodicDrain) ? H.makePeriodicDrain(50) : () => {};
    if (H && H.createMemMonitor) {
      _memMonitor = H.createMemMonitor({
        getElement: () => document.getElementById('sa-wsp-mem'),
        onGuardrail: async (pct) => {
          _stopScan = true;
          status.textContent = 'Detenido: la memoria llegó a ' + pct + '%.';
          const w = el('div', 'sa-err');
          w.appendChild(el('div', null,
            'Se detuvo el escaneo con la memoria al ' + pct + '% y se guardó el avance.'));
          w.appendChild(el('div', null,
            'Recarga la pestaña y vuelve a abrir el panel: te va a ofrecer reanudar donde quedó.'));
          ui.bd.appendChild(w);
        }
      });
      _memMonitor.start();
    }

    // EJE A — caché de NP durante la corrida
    pnCacheOn();

    let todas = [];
    try {
      const r = await realDeps.allOpenWorkOrders((n, total) => {
        status.textContent = 'Pidiendo la lista de órdenes… ' + n + (total ? ' de ' + total : '');
      });
      todas = r.ids;
    } catch (e) {
      status.textContent = 'No pude pedir la lista de órdenes: ' + ((e && e.message) || e);
      pnCacheOff();
      if (_memMonitor) { _memMonitor.stop(); _memMonitor = null; }
      const c = el('button', null, 'Cerrar'); c.addEventListener('click', closePanel);
      ui.ft.appendChild(c);
      return;
    }

    const ck = desdeCero ? null : await ckLoad(CK_KEY);
    const merged = mergeCheckpoint(todas, ck);
    const hallazgos = merged.hallazgos.slice();
    const doneSet = new Set(((ck && ck.done) || []));
    const fallidas = [];

    const stop = el('button', null, '■ Detener');
    stop.addEventListener('click', () => { _stopScan = true; stop.disabled = true; stop.textContent = 'Deteniendo…'; });
    ui.ft.appendChild(stop);

    const t0 = Date.now();
    let hechas = 0;
    const totalPendiente = merged.pendientes.length;

    async function guardar() {
      await ckSave(CK_KEY, { done: [...doneSet], hallazgos, ts: new Date().toISOString() });
    }

    const chunks = planScanChunks(merged.pendientes, 100);
    for (const chunk of chunks) {
      if (_stopScan) break;
      await runPool(chunk, 3, async (idInDomain) => {
        const res = await analyzeWorkOrder(idInDomain);
        doneSet.add(idInDomain);
        hechas++;
        if (!res.ok) { fallidas.push({ idInDomain, error: res.error }); }
        else {
          for (const r of res.results) {
            if (r.error) { fallidas.push({ idInDomain, error: r.error }); continue; }
            const slim = slimResult(r);
            if (slim.tieneTrabajo || slim.nAnomalias) hallazgos.push(slim);
          }
        }
        drain();
        if (hechas % 10 === 0) {
          const pct = ((hechas / Math.max(1, totalPendiente)) * 100);
          fill.style.width = pct.toFixed(1) + '%';
          const seg = (Date.now() - t0) / 1000;
          const restantes = totalPendiente - hechas;
          const eta = hechas > 0 ? Math.round((seg / hechas) * restantes / 60) : null;
          status.textContent = hechas + ' de ' + totalPendiente + ' órdenes'
            + (merged.yaHechas ? ' (+' + merged.yaHechas + ' de antes)' : '');
          detalle.textContent = hallazgos.length + ' con algo que corregir'
            + (fallidas.length ? ' · ' + fallidas.length + ' no se pudieron leer' : '')
            + (eta != null ? ' · faltan ~' + eta + ' min' : '');
        }
      }, () => _stopScan);
      await guardar();   // checkpoint al cierre de cada lote
    }

    await guardar();
    pnCacheOff();
    if (_memMonitor) { _memMonitor.stop(); _memMonitor = null; }
    try { if (H) H.apolloCacheDrain(); } catch (_) {}

    renderScanResults(ui, hallazgos, fallidas, doneSet.size, todas.length, _stopScan);
  }

  function renderScanResults(ui, hallazgos, fallidas, revisadas, total, detenido) {
    setTitle(ui, detenido ? '🔧 Escaneo detenido' : '🔧 Escaneo terminado');
    clear(ui.bd); clear(ui.ft);

    const conTrabajo = hallazgos.filter(h => h.tieneTrabajo);
    const cambios = conTrabajo.reduce((a, h) => a + (h.plan ? h.plan.touched : 0), 0);
    const anomalias = hallazgos.reduce((a, h) => a + (h.nAnomalias || 0), 0);

    const sum = el('div', 'sa-sum');
    sum.appendChild(el('div', null, revisadas + ' de ' + total + ' órdenes revisadas'));
    const b = el('b', null, String(cambios));
    const linea = el('div');
    linea.append(b, document.createTextNode(' cambios en ' + conTrabajo.length + ' órdenes'));
    sum.appendChild(linea);
    if (anomalias) sum.appendChild(el('div', 'sa-mut',
      anomalias + ' anomalías detectadas (no se tocan)'));
    if (detenido) sum.appendChild(el('div', 'sa-mut',
      'Se detuvo antes de terminar: el avance quedó guardado y puedes reanudar.'));
    ui.bd.appendChild(sum);

    if (conTrabajo.length) {
      const t = el('table');
      const thead = el('thead'); const trh = el('tr');
      for (const h of ['Orden', 'Número de Parte', 'Cambios', 'Forzadas', 'Anomalías']) trh.appendChild(el('th', null, h));
      thead.appendChild(trh); t.appendChild(thead);
      const tb = el('tbody');
      for (const h of conTrabajo.slice(0, 300)) {
        const tr = el('tr');
        tr.appendChild(el('td', null, String(h.idInDomain)));
        tr.appendChild(el('td', null, h.partNumberName || String(h.partNumberId)));
        tr.appendChild(el('td', null, String(h.plan.touched)));
        tr.appendChild(el('td', null, h.nForzadas ? String(h.nForzadas) : '—'));
        tr.appendChild(el('td', 'sa-mut', h.nAnomalias ? String(h.nAnomalias) : '—'));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      ui.bd.appendChild(t);
      if (conTrabajo.length > 300) ui.bd.appendChild(el('p', 'sa-mut',
        'Se muestran 300 de ' + conTrabajo.length + '. El CSV las trae todas.'));
    } else {
      ui.bd.appendChild(el('p', null, 'Ninguna orden necesita corrección.'));
    }

    if (fallidas.length) {
      const w = el('div', 'sa-warn');
      w.appendChild(el('h3', null, 'No se pudieron leer'));
      for (const f of fallidas.slice(0, 20)) w.appendChild(el('div', null, f.idInDomain + ' — ' + f.error));
      if (fallidas.length > 20) w.appendChild(el('div', 'sa-mut', '… y ' + (fallidas.length - 20) + ' más'));
      ui.bd.appendChild(w);
    }

    const cerrar = el('button', null, 'Cerrar');
    cerrar.addEventListener('click', closePanel);
    const csvBtn = el('button', null, '⬇ Reporte');
    csvBtn.addEventListener('click', () => downloadScanCsv(hallazgos));
    const go = el('button', 'sa-go', 'Aplicar (' + cambios + ' cambios)');
    go.disabled = cambios === 0;
    go.addEventListener('click', () => runApplyMany(ui, conTrabajo));
    ui.ft.append(cerrar, csvBtn, go);
  }

  async function runApplyMany(ui, hallazgos) {
    setTitle(ui, '🔧 Aplicando…');
    clear(ui.bd); clear(ui.ft);
    const status = el('p', null, 'Escribiendo…');
    const bar = el('div', 'sa-prog'); const fill = el('i'); bar.appendChild(fill);
    ui.bd.append(status, bar);
    _stopScan = false;
    const stop = el('button', null, '■ Detener');
    stop.addEventListener('click', () => { _stopScan = true; stop.disabled = true; });
    ui.ft.appendChild(stop);

    let archived = 0, added = 0, hechas = 0;
    const errors = [];
    // En serie a propósito: son ESCRITURAS. La lectura tolera pool; esto no.
    for (const h of hallazgos) {
      if (_stopScan) break;
      const out = await applyPlan(h);
      archived += out.archived; added += out.added;
      for (const e of out.errors) errors.push('OT ' + h.idInDomain + ': ' + e);
      hechas++;
      fill.style.width = ((hechas / hallazgos.length) * 100).toFixed(1) + '%';
      status.textContent = 'Orden ' + h.idInDomain + ' (' + hechas + ' de ' + hallazgos.length + ')…';
    }

    await ckClear(CK_KEY);
    clear(ui.bd); clear(ui.ft);
    setTitle(ui, errors.length ? '🔧 Terminó con errores' : '🔧 Listo');
    const sum = el('div', 'sa-sum');
    sum.appendChild(el('div', null, hechas + ' órdenes · ' + archived + ' parámetros archivados · ' + added + ' aplicados'));
    ui.bd.appendChild(sum);
    if (errors.length) {
      const w = el('div', 'sa-err');
      for (const e of errors.slice(0, 30)) w.appendChild(el('div', null, e));
      ui.bd.appendChild(w);
    }
    const csvBtn = el('button', null, '⬇ Reporte');
    csvBtn.addEventListener('click', () => downloadScanCsv(hallazgos));
    const done = el('button', 'sa-go', 'Cerrar');
    done.addEventListener('click', closePanel);
    ui.ft.append(csvBtn, done);
  }

  function downloadScanCsv(hallazgos) {
    const rows = [['orden', 'numero_parte', 'nodo', 'campo', 'ambito', 'forzada', 'estado', 'tenia', 'quedara']];
    for (const h of (hallazgos || [])) {
      for (const c of (h.cambios || [])) {
        rows.push([h.idInDomain, h.partNumberName, c.nodo, c.campo, c.ambito,
                   c.forzada ? 'si' : 'no', c.estado, c.tenia, c.quedara]);
      }
      if (h.nAnomalias) rows.push([h.idInDomain, h.partNumberName, '', '', 'EXTERNA', 'no',
                                   'ANOMALIAS:' + h.nAnomalias, '', '']);
    }
    try {
      const blob = new Blob([rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'],
                            { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'escaneo-params-ot.csv';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { console.warn('[wo-spec-params] no pude generar el reporte:', e); }
  }

  // Fase 2 — de Números de Parte a sus órdenes
  async function runFromPartNumbers(ui, parsed) {
    setTitle(ui, '🔧 Buscando las órdenes de esos Números de Parte…');
    clear(ui.bd); clear(ui.ft);
    const status = el('p', null, 'Resolviendo Números de Parte…');
    ui.bd.appendChild(status);

    const res = await resolvePartNumbers(parsed);
    if (!res.partNumberIds.length) {
      clear(ui.bd);
      const w = el('div', 'sa-err');
      w.appendChild(el('div', null, 'No pude resolver ningún Número de Parte.'));
      for (const n of res.noResueltos) w.appendChild(el('div', null, '  sin coincidencia exacta: ' + n));
      for (const e of res.errores) w.appendChild(el('div', null, '  ' + e));
      ui.bd.appendChild(w);
      const c = el('button', null, 'Cerrar'); c.addEventListener('click', closePanel);
      ui.ft.appendChild(c);
      return;
    }

    status.textContent = 'Buscando órdenes abiertas de ' + res.partNumberIds.length + ' Número(s) de Parte…';
    const wos = await findWorkOrdersForPartNumbers(res.partNumberIds);

    // Lo que el operador necesita saber ANTES de que arranque el análisis pesado
    const nota = el('div', 'sa-sum');
    const nNombres = Object.keys(res.porNombre).length;
    if (nNombres) {
      for (const nombre of Object.keys(res.porNombre)) {
        const lista = res.porNombre[nombre];
        nota.appendChild(el('div', null,
          '"' + nombre + '" → ' + lista.length + ' Número(s) de Parte' +
          (lista.length > 1 ? ' con ese mismo nombre' : '')));
      }
    }
    nota.appendChild(el('div', null,
      res.partNumberIds.length + ' Números de Parte · ' + wos.idsInDomain.length + ' órdenes abiertas'));
    if (wos.sinOrdenes.length) nota.appendChild(el('div', 'sa-mut',
      wos.sinOrdenes.length + ' sin ninguna orden abierta (no aportan nada)'));
    ui.bd.appendChild(nota);
    for (const n of res.noResueltos) ui.bd.appendChild(el('div', 'sa-mut', 'Sin coincidencia exacta: ' + n));

    if (!wos.idsInDomain.length) {
      ui.bd.appendChild(el('p', null, 'Ninguno tiene órdenes abiertas: no hay nada que corregir.'));
      const c = el('button', null, 'Cerrar'); c.addEventListener('click', closePanel);
      ui.ft.appendChild(c);
      return;
    }
    await runAnalysis(ui, wos.idsInDomain, parsed.ignored);
  }

  // Fase 2 — análisis y preview
  async function runAnalysis(ui, ids, ignored) {
    setTitle(ui, '🔧 Reaplicar parámetros · analizando ' + ids.length + ' orden' + (ids.length === 1 ? '' : 'es'));
    clear(ui.bd); clear(ui.ft);
    const status = el('p', null, 'Leyendo…');
    const bar = el('div', 'sa-prog'); const fill = el('i'); bar.appendChild(fill);
    ui.bd.append(status, bar);

    const results = [];
    const failures = [];
    for (let i = 0; i < ids.length; i++) {
      status.textContent = 'Leyendo orden ' + ids[i] + ' (' + (i + 1) + ' de ' + ids.length + ')…';
      fill.style.width = ((i / ids.length) * 100).toFixed(1) + '%';
      const res = await analyzeWorkOrder(ids[i]);
      if (!res.ok) { failures.push({ idInDomain: ids[i], error: res.error }); continue; }
      for (const r of res.results) {
        if (r.error) failures.push({ idInDomain: ids[i], error: r.error });
        else results.push(r);
      }
    }
    fill.style.width = '100%';
    renderPreview(ui, results, failures, ignored);
  }

  function renderPreview(ui, results, failures, ignored) {
    const s = summarize(results);
    setTitle(ui, '🔧 Reaplicar parámetros · revisa antes de aplicar');
    clear(ui.bd); clear(ui.ft);

    const sum = el('div', 'sa-sum');
    const b = el('b', null, String(s.aCorregir));
    sum.append(
      document.createTextNode(s.ordenes + ' orden' + (s.ordenes === 1 ? '' : 'es') + ' · ' +
                              s.casillas + ' casillas · '),
      b,
      document.createTextNode(' por corregir · ' + s.omitidas + ' omitidas'));
    if (s.soloNP) sum.append(el('div', 'sa-mut',
      'Modo acotado: ' + s.soloNP + ' casillas quedaron fuera porque su valor no lo define el '
      + 'Número de Parte, sino el catálogo de la spec.'));
    if (s.forzadas) sum.append(el('div', 'sa-mut',
      s.forzadas + ' de esas casillas son forzadas: el nodo todavía no declara ese campo.'));
    ui.bd.appendChild(sum);
    if (ignored) ui.bd.appendChild(el('p', 'sa-mut',
      'Ignoré ' + ignored + ' renglón(es) que no eran números de orden.'));

    // Tabla de cambios
    const cambios = [];
    for (const r of results) for (const c of (r.cells || [])) {
      if (c.status !== 'OK' && c.status !== 'AMBIGUO' && c.status !== 'SIN_CATALOGO') cambios.push({ r, c });
    }
    if (cambios.length) {
      const t = el('table');
      const thead = el('thead'); const trh = el('tr');
      for (const h of ['Orden', 'Nodo', 'Campo', 'Tiene', 'Quedará', 'Origen']) trh.appendChild(el('th', null, h));
      thead.appendChild(trh); t.appendChild(thead);
      const tb = el('tbody');
      for (const it of cambios) {
        const tr = el('tr');
        tr.appendChild(el('td', null, String(it.r.idInDomain)));
        const tdNodo = el('td', null, it.c.recipeNodeName);
        if (it.c.forced) { tdNodo.appendChild(document.createTextNode(' ')); tdNodo.appendChild(el('span', 'sa-tag', 'FORZADA')); }
        tr.appendChild(tdNodo);
        tr.appendChild(el('td', null, it.c.fieldName));
        const tenia = (it.c.appliedRows && it.c.appliedRows[0]
          && it.c.appliedRows[0].specFieldParamBySpecFieldParamId
          && it.c.appliedRows[0].specFieldParamBySpecFieldParamId.name) || '—';
        tr.appendChild(el('td', 'sa-mut', tenia));
        tr.appendChild(el('td', null, (it.c.desired && it.c.desired.refName) || ''));
        tr.appendChild(el('td', 'sa-mut', it.c.via === 'NP' ? 'Número de Parte' : 'catálogo'));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      ui.bd.appendChild(t);
    } else {
      ui.bd.appendChild(el('p', null, 'No hay nada que corregir: las specs ya están alineadas.'));
    }

    // Nodo de inspección no identificado
    for (const r of results) {
      if (r.inspectionNode && r.inspectionNode.ambiguous) {
        const d = el('div', 'sa-err');
        d.appendChild(el('div', null, 'Orden ' + r.idInDomain +
          ': no pude identificar el nodo de inspección de la línea (' + r.inspectionNode.reason + ').'));
        d.appendChild(el('div', null, 'No se aplicará ningún campo de la especificación externa en esta orden.'));
        ui.bd.appendChild(d);
      }
    }

    // Omitidas
    const omit = [];
    for (const r of results) for (const c of (r.plan && r.plan.skipped) || []) omit.push({ r, c });
    if (omit.length) {
      const w = el('div', 'sa-warn');
      w.appendChild(el('h3', null, 'Omitidas — las tienes que resolver a mano'));
      for (const it of omit.slice(0, 40)) {
        w.appendChild(el('div', null,
          'OT ' + it.r.idInDomain + ' · ' + it.c.recipeNodeName + ' · ' + it.c.fieldName + ' — ' + it.c.reason));
      }
      if (omit.length > 40) w.appendChild(el('div', 'sa-mut', '… y ' + (omit.length - 40) + ' más (van en el CSV)'));
      ui.bd.appendChild(w);
    }

    // Anomalías
    if (s.anomalias) {
      const w = el('div', 'sa-warn');
      w.appendChild(el('h3', null, 'Anomalías — no se van a tocar'));
      w.appendChild(el('div', 'sa-mut',
        'Estos parámetros de la especificación externa viven en un nodo que no es el de inspección.'));
      for (const r of results) for (const a of (r.anomalies || []).slice(0, 30)) {
        w.appendChild(el('div', null,
          'OT ' + r.idInDomain + ' · ' + a.recipeNodeName + ' [' + a.recipeNodeType + '] · ' +
          a.fieldName + ' = ' + a.paramName));
      }
      ui.bd.appendChild(w);
    }

    // Fallos de lectura
    if (failures && failures.length) {
      const w = el('div', 'sa-err');
      w.appendChild(el('div', null, 'No pude leer ' + failures.length + ' orden(es):'));
      for (const f of failures.slice(0, 20)) w.appendChild(el('div', null, f.idInDomain + ' — ' + f.error));
      ui.bd.appendChild(w);
    }

    const cancel = el('button', null, 'Cancelar');
    cancel.addEventListener('click', closePanel);
    const csvBtn = el('button', null, '⬇ Reporte');
    csvBtn.addEventListener('click', () => downloadCsv(results));
    const go = el('button', 'sa-go', 'Aplicar (' + s.aCorregir + ' cambios)');
    go.disabled = s.aCorregir === 0;
    go.addEventListener('click', () => runApply(ui, results));
    ui.ft.append(cancel, csvBtn, go);
  }

  // Fase 3 — aplicar
  async function runApply(ui, results) {
    setTitle(ui, '🔧 Aplicando…');
    clear(ui.bd); clear(ui.ft);
    const status = el('p', null, 'Escribiendo…');
    const bar = el('div', 'sa-prog'); const fill = el('i'); bar.appendChild(fill);
    ui.bd.append(status, bar);

    let archived = 0, added = 0;
    const errors = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      status.textContent = 'Orden ' + r.idInDomain + ' (' + (i + 1) + ' de ' + results.length + ')…';
      fill.style.width = ((i / results.length) * 100).toFixed(1) + '%';
      const out = await applyPlan(r);
      archived += out.archived; added += out.added;
      for (const e of out.errors) errors.push('OT ' + r.idInDomain + ': ' + e);
    }
    fill.style.width = '100%';

    clear(ui.bd);
    setTitle(ui, errors.length ? '🔧 Terminó con errores' : '🔧 Listo');
    const sum = el('div', 'sa-sum');
    sum.append(el('div', null, archived + ' parámetros archivados · ' + added + ' aplicados'));
    ui.bd.appendChild(sum);
    ui.bd.appendChild(el('p', 'sa-mut',
      'Vuelve a analizar la misma orden para confirmar que el ERP quedó como decía el preview.'));
    if (errors.length) {
      const w = el('div', 'sa-err');
      for (const e of errors.slice(0, 30)) w.appendChild(el('div', null, e));
      ui.bd.appendChild(w);
    }
    const csvBtn = el('button', null, '⬇ Reporte');
    csvBtn.addEventListener('click', () => downloadCsv(results));
    const done = el('button', 'sa-go', 'Cerrar');
    done.addEventListener('click', closePanel);
    ui.ft.append(csvBtn, done);
  }

  function downloadCsv(results) {
    try {
      const blob = new Blob([buildCsv(results)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'reaplicar-params-ot.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
      console.warn('[wo-spec-params] no pude generar el reporte:', e);
    }
  }

  // ── Entradas ──────────────────────────────────────────────────────────────

  // El popup ejecuta esto con executeScript en el mundo MAIN. Tiene que devolver YA:
  // si bloquea, el popup se queda colgado (lección auto-router 0.3.1).
  function openFromPopup() {
    setTimeout(() => {
      try {
        if (typeof location === 'undefined' || typeof document === 'undefined') return;
        const id = parseWorkOrderIdInDomain(location.pathname);
        window.WoSpecParams.open({ mode: id ? 'pantalla' : 'pegar' });
      } catch (e) {
        console.warn('[wo-spec-params] no pude abrir el panel:', e);
      }
    }, 0);
    return true;
  }

  // Botón de entrada en la ficha de una OT. Se monta SIEMPRE que la ruta aplique — nunca detrás
  // de un gate de estado, y con observer porque el DOM puede no estar pintado al correr init().
  function ensureFab() {
    if (!isWorkOrderDetailPath(location.pathname)) {
      const old = document.getElementById(FAB_ID);
      if (old) old.remove();
      return;
    }
    if (document.getElementById(FAB_ID)) return;
    injectStyles();
    const b = document.createElement('button');
    b.id = FAB_ID;
    b.textContent = '🔧';
    b.title = 'Reaplicar parámetros de specs desde el Número de Parte';
    b.addEventListener('click', () => open({ mode: 'pantalla' }));
    document.body.appendChild(b);
  }

  function init() {
    if (window.__saWoSpecParamsInit) return;
    window.__saWoSpecParamsInit = true;
    const tick = () => { try { ensureFab(); } catch (_) {} };
    tick();
    try {
      const obs = new MutationObserver(tick);
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    setInterval(tick, 1500);
  }

  window.WoSpecParams = {
    VERSION,
    isWorkOrderDetailPath, parseWorkOrderIdInDomain, parsePastedWorkOrders,
    parsePastedPartNumbers, resolvePartNumbers, findWorkOrdersForPartNumbers,
    runPool, planScanChunks, mergeCheckpoint, slimResult, openScan,
    setSoloNP: (v) => { _soloNP = !!v; },
    getSoloNP: () => _soloNP,
    setMigrarAInspeccion: (v) => { _migrarAInspeccion = !!v; },
    getMigrarAInspeccion: () => _migrarAInspeccion,
    analyzeWorkOrder, summarize, applyPlan, buildCsv,
    open, openFromPopup, closePanel, init,
    _realDeps: realDeps, _writeDeps: writeDeps
  };

  if (typeof document !== 'undefined' && document.body) init();
  else if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
