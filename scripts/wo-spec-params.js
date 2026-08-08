// Reaplicar parámetros a las specs de Órdenes de Trabajo — glue (red + DOM).
// La decisión vive en wo-spec-params-core.js; aquí solo se consulta, se dibuja y se escribe.
//
// Nada se escribe sin que el operador vea el preview y confirme un conteo.
// Ver docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md
(function () {
  'use strict';

  const VERSION = '0.6.0';
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

  // Una orden procesada DOS VECES deja de ser ruido en cuanto el modo mover está encendido: la
  // segunda pasada archiva la casilla que la primera acababa de crear, y queda hueca. Es lo que
  // le pasó a la OT 15928 el 2026-08-04 — 2 de 2,549 casillas, y las 2 eran justo las repetidas.
  //
  // La repetición NO viene de la fase 2 (findWorkOrdersForPartNumbers ya deduplica con su Set),
  // sino de `allOpenWorkOrders`: pagina con orderBy ID_DESC y SIN deduplicar, así que en una
  // corrida de ~40 min basta que una orden cambie de estado para que dos páginas la devuelvan.
  // Por eso el candado va aquí y no en la fuente: cubre cualquier origen de la lista.
  function dedupHallazgos(lista) {
    const pos = new Map();
    const out = [];
    for (const h of (lista || [])) {
      if (!h) continue;
      const k = h.idInDomain + '|' + h.partNumberId;   // la unidad real: (orden, número de parte)
      if (pos.has(k)) { out[pos.get(k)] = h; continue; }  // gana el último: es el análisis más fresco
      pos.set(k, out.length);
      out.push(h);
    }
    return out;
  }

  // Reanudar: quita del pendiente lo que el checkpoint ya marcó como hecho, y de paso deduplica
  // — tanto la cola por procesar como los hallazgos que ya traía el checkpoint.
  function mergeCheckpoint(todas, checkpoint) {
    const done = new Set(((checkpoint && checkpoint.done) || []));
    const vistos = new Set();
    const pendientes = [];
    for (const id of (todas || [])) {
      if (id == null || done.has(id) || vistos.has(id)) continue;
      vistos.add(id);
      pendientes.push(id);
    }
    return {
      pendientes,
      yaHechas: done.size,
      hallazgos: dedupHallazgos((checkpoint && checkpoint.hallazgos) || [])
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
      // Campos de la spec del cliente que NO se pudieron colocar porque ningún nodo de la
      // orden los declara. Va en el slim aunque la orden no tenga trabajo — de hecho SOBRE
      // TODO entonces: una orden así reporta `touched: 0` y sin este conteo es indistinguible
      // de una orden sana. Es el caso de la OT 10837 (GDE1214700 Antitarnish): nació con una
      // copia de receta cuyo nodo de calidad aún no declaraba los campos, y el operador vio
      // «0 cambios» donde en realidad quedaron 3 criterios de calidad sin aplicar.
      nSinDestino: (r.faltantesSinDestino || []).length,
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
          // El ORIGEN del valor decide si el cambio está respaldado o es una inferencia:
          //   NP        lo define el Número de Parte — fuente de verdad
          //   CATALOGO  el NP no lo define y el catálogo ofrece una sola opción
          // Sin esta columna el CSV no permite separar «aplicar con confianza» de
          // «verificar primero», que es justo la decisión que hay que tomar sobre las
          // casillas de PROCESO (2026-07-30: 7 006 vacías en un escaneo del dominio).
          origen: c.via || '',
          spec: (c.desired && c.desired.specName) || c.specName || '',
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
    // El nodo de la RECETA (no el de la orden). Las tres variables son obligatorias: pedirlo
    // sólo con `id` responde con un error de variables faltantes, no con datos parciales.
    // `rootId` es el maestro del nodo PROCESS de la orden.
    async getProcessNode(id, processNodeOccurrence, rootId) {
      const d = await api().query('GetProcessNode',
        { id, processNodeOccurrence: processNodeOccurrence || 1, rootId }, 'GetProcessNode');
      return d && d.processNodeById;
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
    },
    // ── Sincronización de SPECS de la orden (2026-08-07) ─────────────────────
    // El ORDEN de estas tres lo impone specSyncSteps, no el glue: archivar antes de agregar,
    // porque si la spec vieja y la nueva declaran los mismos specFields CHOCAN y el parámetro
    // no se aplica — y falla en silencio, la mutation no revienta.
    async archiveWorkOrderSpec(partNumberWorkOrderSpecId) {
      return api().query('ArchivePartNumberWorkOrderSpecAndParams',
        { partNumberWorkOrderSpecId, archivedAt: new Date().toISOString() },
        'ArchivePartNumberWorkOrderSpecAndParams');
    },
    // OJO: desarchivar NO manda `archivedAt: null` como uno esperaría — repite el INSTANTE con el
    // que se archivó. Medido en vivo el 2026-08-07: el Archive mandó "…T00:15:55.218Z" y el
    // Unarchive "…T00:15:55.218+00:00" (mismo instante, otra representación). Se pasa tal cual
    // viene de la lectura para no reconstruirlo y errarle por formato.
    async unarchiveWorkOrderSpec(partNumberWorkOrderSpecId, archivedAt) {
      return api().query('UnarchivePartNumberWorkOrderSpecAndParams',
        { partNumberWorkOrderSpecId, archivedAt },
        'UnarchivePartNumberWorkOrderSpecAndParams');
    },
    async unarchiveParam(partNumberRecipeNodeSpecFieldParamId, archivedAt) {
      return api().query('UnarchivePartNumberRecipeNodeSpecFieldParam',
        { partNumberRecipeNodeSpecFieldParamId, archivedAt },
        'UnarchivePartNumberRecipeNodeSpecFieldParam');
    },
    // Los parámetros viajan EN LA MISMA llamada que la spec, con su recipeNodeId ya resuelto: el
    // ERP no los arrastra solo. Por eso agregar la spec y colocar cada campo en su nodo es UN
    // acto atómico y no dos pasos que puedan quedarse a medias.
    async applySpecToWorkOrder(workOrderId, partNumberId, specId, parametersToAdd) {
      return api().query('ApplySpecsToPartNumbersAndWorkOrder', {
        workOrderId,
        partNumberSpecsToApply: [{
          partNumberId,
          specsToApply: [{
            specId, classificationSetId: null, classificationIds: [],
            parametersToAdd: parametersToAdd || []
          }]
        }]
      }, 'ApplySpecsToPartNumbersAndWorkOrder');
    }
  };

  // Caché de Números de Parte para el escaneo largo: muchas órdenes comparten NP, y cada
  // GetPartNumber repetido es una consulta tirada. Se limpia al terminar (EJE A).
  let _pnCache = null;
  function pnCacheOn() { _pnCache = new Map(); }
  function pnCacheOff() { if (_pnCache) _pnCache.clear(); _pnCache = null; _masterCache.clear(); }

  // Caché de recetas maestras (processNodeId → Set<specFieldId>). En un barrido todas las
  // órdenes del mismo proceso comparten maestros, así que la consulta se paga una vez por
  // proceso. Se vacía al EMPEZAR cada corrida, no sólo al terminar: corregir la receta y
  // volver a correr es justo el flujo esperado, y una caché viva devolvería el estado viejo.
  const _masterCache = new Map();
  function resetMasterCache() { _masterCache.clear(); }
  // Rescate por receta maestra. Encendido por omisión: sin él, las órdenes que nacieron con la
  // receta incompleta no se pueden reparar con esta herramienta (caso OT 10837). El interruptor
  // existe para poder apagarlo si alguna vez hiciera falta escanear sin consultas extra.
  let _rescateReceta = true;

  // Analiza UNA orden. Devuelve un resultado por cada NP de la orden.
  // Los processNode MAESTROS que hacen falta para rescatar UNA orden: los de sus nodos de
  // calidad. Se piden EN SERIE (son pocos, y el /graphql se cuelga en ráfaga alrededor de las
  // 40-45 peticiones, sin devolver 429 y tumbando también la pantalla nativa).
  //
  // Se cachean por id de processNode: en un barrido, todas las órdenes del mismo proceso
  // comparten maestros, así que la consulta se paga una vez por proceso y no por orden.
  // Un maestro que no se pueda leer se cachea como Set vacío — reintentarlo en cada orden de
  // un barrido de 4284 multiplicaría el tráfico sin cambiar el resultado.
  async function fetchMasterFields(workOrder, deps) {
    const D = deps || realDeps;
    const C = core();
    const nodes = (workOrder && workOrder.recipeNodesByWorkOrderId
      && workOrder.recipeNodesByWorkOrderId.nodes) || [];
    // El rootId que pide GetProcessNode es el maestro del nodo PROCESS de la orden.
    let rootId = null;
    for (const n of nodes) {
      if (n && n.type === 'PROCESS' && n.processNodeByDerivedFrom) {
        rootId = n.processNodeByDerivedFrom.id; break;
      }
    }
    if (rootId == null) return null;

    const out = new Map();
    for (const n of nodes) {
      if (!n || n.type !== 'QUALITY_ASSURANCE_NODE') continue;
      const masterId = n.processNodeByDerivedFrom && n.processNodeByDerivedFrom.id;
      if (masterId == null || out.has(masterId)) continue;
      if (_masterCache && _masterCache.has(masterId)) { out.set(masterId, _masterCache.get(masterId)); continue; }
      let fields = new Set();
      try {
        const pnode = await D.getProcessNode(masterId, n.processNodeOccurrence || 1, rootId);
        fields = C.masterDeclaredFields(pnode);
      } catch (e) {
        console.warn('[wo-spec-params] no pude leer la receta del nodo ' + masterId + ':', e);
      }
      if (_masterCache) _masterCache.set(masterId, fields);
      out.set(masterId, fields);
    }
    return out;
  }

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
        let cls = C.classifyWorkOrder({ workOrder, partNumber },
                                      { migrarAInspeccion: _migrarAInspeccion });
        // RESCATE POR RECETA MAESTRA. Sólo si la orden dejó campos sin destino: la consulta a
        // los processNode maestros es cara y la inmensa mayoría de las órdenes no la necesita.
        // Se reclasifica con `masterFields` en vez de parchear el resultado — así el estado
        // de cada casilla lo sigue decidiendo el núcleo puro, en un solo lugar.
        if (_rescateReceta && cls.faltantesSinDestino && cls.faltantesSinDestino.length) {
          const masterFields = await fetchMasterFields(workOrder, D);
          if (masterFields && masterFields.size) {
            cls = C.classifyWorkOrder({ workOrder, partNumber },
                                      { migrarAInspeccion: _migrarAInspeccion, masterFields });
          }
        }
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


  // ── Sincronizar las SPECS de la orden con las del NP ────────────────────────
  // Distinto de reaplicar parámetros: aquí se corrige QUÉ SPEC tiene la orden. Cuando el NP migra
  // (80065-DS-004 → RC Ag) la orden conserva la vieja, y mover parámetros de nodo no arregla eso:
  // el operador en piso sigue viendo la spec retirada. 315 de 348 NP pendientes están así.
  async function analyzeSpecSync(idInDomain, deps) {
    const D = deps || realDeps;
    const C = core();
    let ids;
    try { ids = await D.getWorkOrderIds(idInDomain); }
    catch (e) { return { ok: false, idInDomain, error: 'No pude leer la orden: ' + ((e && e.message) || e) }; }
    if (!ids || !ids.id) return { ok: false, idInDomain, error: 'No encontré la orden ' + idInDomain };

    const results = [];
    for (const partNumberId of (ids.partNumberIds || [])) {
      try {
        const workOrder = await D.getSpecsInfo(partNumberId, ids.id);
        const partNumber = await D.getPartNumber(partNumberId);
        const woSpecs = ((workOrder && workOrder.partNumberWorkOrderSpecsByWorkOrderId
          && workOrder.partNumberWorkOrderSpecsByWorkOrderId.nodes) || []);
        const npSpecs = ((partNumber && partNumber.partNumberSpecsByPartNumberId
          && partNumber.partNumberSpecsByPartNumberId.nodes) || []);
        // Solo las specs VIVAS del NP mandan. Una archivada en el NP es criterio retirado.
        const vivosNP = npSpecs.filter(n => n && !n.archivedAt)
          .map(n => (n.specBySpecId || {}).id).filter(x => x != null);
        const nombreNP = new Map(npSpecs.map(n => [((n.specBySpecId || {}).id), ((n.specBySpecId || {}).name || '')]));

        const plan = C.planSpecSync(woSpecs, vivosNP);
        for (const a of plan.agregar) a.specName = nombreNP.get(a.specId) || ('spec ' + a.specId);
        results.push({
          idInDomain, partNumberId,
          partNumberName: (partNumber && partNumber.name) || '',
          workOrderId: ids.id, plan,
          nCambios: plan.archivar.length + plan.desarchivar.length + plan.agregar.length
        });
      } catch (e) {
        results.push({ idInDomain, partNumberId, error: ((e && e.message) || String(e)) });
      }
    }
    return { ok: true, idInDomain, results };
  }

  // Aplica el plan. El orden lo da specSyncSteps (núcleo): archivar → desarchivar → agregar.
  // Si un paso falla se DETIENE: seguir dejaría la orden en un estado intermedio —con la vieja ya
  // archivada y la nueva sin aplicar— que es peor que no haber tocado nada.
  async function applySpecSync(result, deps) {
    const D = deps || realDeps;
    const C = core();
    const out = { archivadas: 0, desarchivadas: 0, agregadas: 0, errores: [] };
    for (const paso of C.specSyncSteps(result.plan)) {
      try {
        if (paso.op === 'archivar') { await D.archiveWorkOrderSpec(paso.pnwosId); out.archivadas++; }
        else if (paso.op === 'desarchivar') { await D.unarchiveWorkOrderSpec(paso.pnwosId, paso.archivedAt); out.desarchivadas++; }
        else if (paso.op === 'agregar') {
          await D.applySpecToWorkOrder(result.workOrderId, result.partNumberId, paso.specId, []);
          out.agregadas++;
        }
      } catch (e) {
        out.errores.push(paso.op + ' ' + (paso.specName || paso.specId || paso.pnwosId) + ': ' + ((e && e.message) || e));
        break;   // no seguir: dejaría la orden a medias
      }
    }
    return out;
  }

  function summarize(results) {
    const s = { ordenes: 0, casillas: 0, aCorregir: 0, omitidas: 0, soloNP: 0, aArchivar: 0, aAgregar: 0,
                forzadas: 0, anomalias: 0, fueraDeInspeccion: 0, sinDestino: 0 };
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
      // Suma tanto la lista cruda (resultado completo) como el conteo del slim: el barrido de
      // fase 3 sólo conserva el slim, y ahí es donde este dato hace más falta.
      s.sinDestino += (r.faltantesSinDestino || []).length || (r.nSinDestino || 0);
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
    const rows = [['orden', 'numero_parte', 'tipo', 'nodo', 'campo', 'ambito', 'origen', 'spec',
                   'forzada', 'estado', 'tenia', 'quedara', 'id_archivado', 'id_escrito']];
    for (const r of (results || [])) {
      for (const c of (r.cells || [])) {
        if (!c || c.status === 'OK') continue;
        const tenia = (c.appliedRows && c.appliedRows[0]
          && c.appliedRows[0].specFieldParamBySpecFieldParamId
          && c.appliedRows[0].specFieldParamBySpecFieldParamId.name) || '';
        rows.push([r.idInDomain, r.partNumberName,
          c.forced ? 'FORZADA' : 'CASILLA',
          c.recipeNodeName, c.fieldName, c.scope,
          c.via || '', (c.desired && c.desired.specName) || '',
          c.forced ? 'si' : 'no',
          c.status, tenia, (c.desired && c.desired.refName) || '',
          (c.toArchiveIds || []).join(' '), c.toAddWriteId == null ? '' : c.toAddWriteId]);
      }
      for (const a of (r.anomalies || [])) {
        // Mismo ancho que el encabezado (14): las anomalías no tienen origen ni spec, pero
        // sus columnas deben existir o el CSV se desalinea a partir de aquí.
        rows.push([r.idInDomain, r.partNumberName, 'ANOMALIA',
          a.recipeNodeName, a.fieldName, 'EXTERNA', '', '',
          'no', 'NO_SE_TOCA', a.paramName, '', '', '']);
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
    resetMasterCache();   // la receta pudo corregirse entre corridas

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
      // Se deduplica AL GUARDAR, no solo al leer: así el checkpoint en disco nunca contiene un
      // repetido, ni siquiera si la corrida se interrumpe entre dos lotes.
      const limpios = dedupHallazgos(hallazgos);
      if (limpios.length !== hallazgos.length) {
        console.warn('[wo-spec-params] ' + (hallazgos.length - limpios.length)
          + ' hallazgo(s) repetido(s) descartado(s) — la lista de órdenes trajo duplicados');
        hallazgos.length = 0; hallazgos.push(...limpios);
      }
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

    renderScanResults(ui, dedupHallazgos(hallazgos), fallidas, doneSet.size, todas.length, _stopScan);
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
    // Órdenes que NO se pueden reparar desde aquí. Van en el resumen del barrido porque ahí
    // sólo sobrevive el slim, y sin este conteo se leen como órdenes sanas (reportan 0 cambios).
    const sinDestino = hallazgos.reduce((a, h) => a + (h.nSinDestino || 0), 0);
    const ordSinDestino = hallazgos.filter(h => (h.nSinDestino || 0) > 0);
    if (sinDestino) {
      const d = el('div', 'sa-mut');
      d.textContent = sinDestino + ' campos de la especificación del cliente quedaron SIN ' +
        'aplicar en ' + ordSinDestino.length + ' órdenes (ningún nodo los declara — se ' +
        'corrige en la receta del proceso, no desde aquí)';
      sum.appendChild(d);
    }
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
    const rows = [['orden', 'numero_parte', 'nodo', 'campo', 'ambito', 'origen', 'spec',
                   'forzada', 'estado', 'tenia', 'quedara']];
    for (const h of (hallazgos || [])) {
      for (const c of (h.cambios || [])) {
        rows.push([h.idInDomain, h.partNumberName, c.nodo, c.campo, c.ambito,
                   c.origen || '', c.spec || '',
                   c.forzada ? 'si' : 'no', c.estado, c.tenia, c.quedara]);
      }
      if (h.nAnomalias) rows.push([h.idInDomain, h.partNumberName, '', '', 'EXTERNA', '', '', 'no',
                                   'ANOMALIAS:' + h.nAnomalias, '', '']);
      // Una orden sin destino no genera renglones de `cambios` (no hay nada que escribir), así
      // que sin este renglón desaparecería del reporte justo siendo la que necesita atención.
      if (h.nSinDestino) rows.push([h.idInDomain, h.partNumberName, '', '', 'EXTERNA', '', '', 'no',
                                    'SIN_DESTINO:' + h.nSinDestino, '', '']);
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
  // UNA SOLA PASADA POR ORDEN: primero la SPEC, después los PARÁMETROS. Al operador no le importa
  // la mecánica interna —quiere la orden igual que su Número de Parte— y separarlo en dos acciones
  // era una costura nuestra, no suya.
  //
  // EL ORDEN Y LA RE-LECTURA no son opcionales: al aplicar la spec nueva, el ERP coloca SOLO sus
  // parámetros en el nodo que declara cada campo (medido en la OT 13219: las 5 casillas quedaron
  // en T202-IC00-001 sin que nadie las moviera). Analizar los parámetros ANTES de eso daría un
  // plan sobre un estado que va a dejar de existir, y propondría escribir lo que el ERP ya puso.
  async function runAnalysis(ui, ids, ignored) {
    setTitle(ui, '🔧 Alinear órdenes con su Número de Parte · analizando ' + ids.length
      + ' orden' + (ids.length === 1 ? '' : 'es'));
    clear(ui.bd); clear(ui.ft);
    const status = el('p', null, 'Leyendo…');
    const bar = el('div', 'sa-prog'); const fill = el('i'); bar.appendChild(fill);
    ui.bd.append(status, bar);

    // FASE 1 — specs desalineadas.
    const specPlans = [];
    for (let i = 0; i < ids.length; i++) {
      status.textContent = 'Revisando specs de la orden ' + ids[i] + ' (' + (i + 1) + ' de ' + ids.length + ')…';
      fill.style.width = ((i / ids.length) * 50).toFixed(1) + '%';
      const r = await analyzeSpecSync(ids[i]).catch(() => null);
      if (r && r.ok) for (const res of r.results) if (!res.error && res.nCambios) specPlans.push(res);
    }

    if (specPlans.length) {
      // Se confirman las specs POR SEPARADO y antes: archivar una spec le quita a la orden un
      // criterio de calidad completo, así que no puede ir escondido en un "aplicar todo".
      const seguir = await confirmarSpecSync(ui, specPlans);
      if (seguir) {
        status.textContent = 'Aplicando specs…';
        for (const sp of specPlans) await applySpecSync(sp).catch(() => {});
      }
    }

    // FASE 2 — parámetros, SOBRE EL ESTADO NUEVO.
    const results = [];
    const failures = [];
    for (let i = 0; i < ids.length; i++) {
      status.textContent = 'Revisando parámetros de la orden ' + ids[i] + ' (' + (i + 1) + ' de ' + ids.length + ')…';
      fill.style.width = (50 + (i / ids.length) * 50).toFixed(1) + '%';
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

  // Confirmación propia de la fase de specs. Devuelve si el operador dijo que sí.
  function confirmarSpecSync(ui, specPlans) {
    return new Promise((resolve) => {
      const nArch = specPlans.reduce((a, r) => a + r.plan.archivar.length, 0);
      const nDes = specPlans.reduce((a, r) => a + r.plan.desarchivar.length, 0);
      const nAdd = specPlans.reduce((a, r) => a + r.plan.agregar.length, 0);
      setTitle(ui, '🔄 Paso 1 de 2 · especificaciones desalineadas');
      clear(ui.bd); clear(ui.ft);
      ui.bd.appendChild(el('div', 'sa-sum',
        specPlans.length + ' orden(es) tienen una spec que su Número de Parte ya no usa'));
      ui.bd.appendChild(el('p', 'sa-mut',
        nArch + ' a archivar · ' + nDes + ' a desarchivar · ' + nAdd + ' a agregar. '
        + 'Al aplicar la spec nueva, el ERP coloca sus parámetros solo en el nodo que declara cada '
        + 'campo; por eso los parámetros se revisan DESPUÉS, sobre el estado ya corregido.'));
      const t = el('table');
      const thead = el('thead'); const trh = el('tr');
      for (const h of ['Orden', 'Número de parte', 'Acción', 'Especificación']) trh.appendChild(el('th', null, h));
      thead.appendChild(trh); t.appendChild(thead);
      const tb = el('tbody');
      for (const r of specPlans) {
        for (const [accion, x] of [
          ...r.plan.archivar.map(x => ['Archivar', x]),
          ...r.plan.desarchivar.map(x => ['Desarchivar', x]),
          ...r.plan.agregar.map(x => ['Agregar', x])]) {
          const tr = el('tr');
          tr.appendChild(el('td', null, String(r.idInDomain)));
          tr.appendChild(el('td', null, r.partNumberName || ''));
          tr.appendChild(el('td', null, accion));
          tr.appendChild(el('td', null, x.specName || ''));
          tb.appendChild(tr);
        }
      }
      t.appendChild(tb); ui.bd.appendChild(t);

      const si = el('button', 'sa-go', 'Corregir las specs y seguir');
      si.addEventListener('click', () => resolve(true));
      const no = el('button', null, 'Saltar y solo revisar parámetros');
      no.addEventListener('click', () => resolve(false));
      ui.ft.append(si, no);
    });
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

    // Sin destino — la orden NO se puede reparar desde aquí, y hay que decirlo.
    // Sin este bloque la orden reporta «0 cambios» y se ve idéntica a una sana: es el modo de
    // falla silenciosa que ya costó caro en `price-confirm-guard`. Caso real: OT 10837
    // (GDE1214700 Antitarnish), 3 criterios de calidad del cliente sin aplicar y ni un aviso.
    if (s.sinDestino) {
      const w = el('div', 'sa-warn');
      w.appendChild(el('h3', null, 'Sin destino — quedaron SIN aplicar'));
      w.appendChild(el('div', 'sa-mut',
        'Ningún nodo de estas órdenes declara estos campos de la especificación del cliente, ' +
        'así que no hay dónde ponerlos y no se escribe nada. Se corrige en la RECETA del ' +
        'proceso (declarar el campo en el nodo de calidad); las órdenes ya creadas conservan ' +
        'la copia vieja aunque la receta ya esté arreglada.'));
      let n = 0;
      for (const r of results) for (const f of (r.faltantesSinDestino || [])) {
        if (n++ >= 40) break;
        w.appendChild(el('div', null,
          'OT ' + r.idInDomain + ' · ' + f.specName + ' · ' + f.fieldName + ' — ' + f.reason));
      }
      if (s.sinDestino > 40) w.appendChild(el('div', 'sa-mut',
        '… y ' + (s.sinDestino - 40) + ' más (van en el CSV)'));
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

  // Entrada desde el popup para la sincronización de specs. Mismo patrón que openFromPopup: si
  // estamos en la ficha de una OT usa ésa, si no pide que peguen las órdenes.
  function openSpecSyncFromPopup() {
    setTimeout(async () => {
      try {
        if (typeof location === 'undefined' || typeof document === 'undefined') return;
        const id = parseWorkOrderIdInDomain(location.pathname);
        if (id) { await openSpecSync([id]); return; }
        const txt = window.prompt('Pega los números de orden a sincronizar (uno por línea):', '');
        if (!txt) return;
        const { ids, ignored } = parsePastedWorkOrders(txt);
        if (!ids.length) { window.alert('No reconocí ningún número de orden.'); return; }
        if (ignored) console.warn('[wo-spec-params] ignoré ' + ignored + ' renglón(es)');
        await openSpecSync(ids);
      } catch (e) {
        console.warn('[wo-spec-params] no pude abrir la sincronización de specs:', e);
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


  // ── UI: sincronizar specs de la orden ──────────────────────────────────────
  // SOLO LECTURA obligatorio: escanea, pinta lo que HARÍA, y hasta que el operador confirma se
  // escribe. Este modo archiva SPECS COMPLETAS de órdenes en piso — un error no deja una casilla
  // hueca, deja una orden sin su criterio de calidad. Por eso el botón de aplicar nace deshabilitado
  // hasta que hay algo que aplicar, y la confirmación nombra el número exacto de specs.
  async function openSpecSync(idsInDomain) {
    const ui = buildShell('🔄 Sincronizar especificaciones de la orden');
    injectStyles();
    setTitle(ui, 'Leyendo órdenes…');
    const status = el('p', 'sa-mut', '0 de ' + idsInDomain.length);
    ui.bd.appendChild(status);

    const conCambios = [];
    const fallidas = [];
    let hechas = 0;
    for (const idd of idsInDomain) {
      const r = await analyzeSpecSync(idd).catch(e => ({ ok: false, idInDomain: idd, error: String(e) }));
      hechas++;
      status.textContent = hechas + ' de ' + idsInDomain.length;
      if (!r.ok) { fallidas.push({ idInDomain: idd, error: r.error }); continue; }
      for (const res of r.results) {
        if (res.error) { fallidas.push({ idInDomain: idd, error: res.error }); continue; }
        if (res.nCambios) conCambios.push(res);
      }
    }
    renderSpecSyncPreview(ui, conCambios, fallidas, idsInDomain.length);
  }

  function renderSpecSyncPreview(ui, results, fallidas, revisadas) {
    setTitle(ui, '🔄 Sincronizar especificaciones · revisa antes de aplicar');
    clear(ui.bd); clear(ui.ft);

    const nArch = results.reduce((a, r) => a + r.plan.archivar.length, 0);
    const nDes = results.reduce((a, r) => a + r.plan.desarchivar.length, 0);
    const nAdd = results.reduce((a, r) => a + r.plan.agregar.length, 0);
    const total = nArch + nDes + nAdd;

    const sum = el('div', 'sa-sum');
    sum.append(document.createTextNode(
      revisadas + ' orden(es) revisada(s) · ' + results.length + ' con cambios · '),
      el('b', null, String(total)), document.createTextNode(' operación(es)'));
    ui.bd.appendChild(sum);
    ui.bd.appendChild(el('div', 'sa-mut',
      nArch + ' spec(s) a archivar · ' + nDes + ' a desarchivar · ' + nAdd + ' a agregar. '
      + 'Se ejecuta SIEMPRE en ese orden: si la vieja y la nueva declaran los mismos campos, '
      + 'chocan y el parámetro no se aplica.'));

    if (results.length) {
      const t = el('table');
      const thead = el('thead'); const trh = el('tr');
      for (const h of ['Orden', 'Número de parte', 'Acción', 'Especificación']) trh.appendChild(el('th', null, h));
      thead.appendChild(trh); t.appendChild(thead);
      const tb = el('tbody');
      for (const r of results) {
        const filas = [
          ...r.plan.archivar.map(x => ['Archivar', x.specName]),
          ...r.plan.desarchivar.map(x => ['Desarchivar', x.specName]),
          ...r.plan.agregar.map(x => ['Agregar', x.specName]),
        ];
        for (const [accion, nombre] of filas) {
          const tr = el('tr');
          tr.appendChild(el('td', null, String(r.idInDomain)));
          tr.appendChild(el('td', null, r.partNumberName || ''));
          tr.appendChild(el('td', null, accion));
          tr.appendChild(el('td', null, nombre || ''));
          tb.appendChild(tr);
        }
        // Lo que NO se toca también se muestra: un filtro invisible engaña sobre lo aplicado.
        if (r.plan.intocables.length) {
          const tr = el('tr');
          const td = el('td', 'sa-mut', r.plan.intocables.length
            + ' spec(s) de esta orden no se tocan (vienen del tratamiento o sin origen declarado)');
          td.colSpan = 4; tr.appendChild(td); tb.appendChild(tr);
        }
      }
      t.appendChild(tb); ui.bd.appendChild(t);
    } else {
      ui.bd.appendChild(el('p', null, 'No hay nada que sincronizar: las specs de estas órdenes ya coinciden con las de su número de parte.'));
    }
    if (fallidas.length) ui.bd.appendChild(el('p', 'sa-mut',
      fallidas.length + ' orden(es) no se pudieron leer: ' + fallidas.slice(0, 3).map(f => f.idInDomain).join(', ')
      + (fallidas.length > 3 ? '…' : '')));

    const aplicar = el('button', null, 'Aplicar ' + total + ' operación(es)');
    aplicar.disabled = !total;
    aplicar.addEventListener('click', async () => {
      // Confirmación EXPLÍCITA que nombra lo irreversible-sin-trabajo: archivar specs.
      const msg = 'Vas a modificar las especificaciones de ' + results.length + ' orden(es):\n\n'
        + '  · ' + nArch + ' spec(s) se ARCHIVARÁN\n'
        + '  · ' + nDes + ' se desarchivarán\n'
        + '  · ' + nAdd + ' se agregarán\n\n'
        + 'Archivar una spec le quita a la orden ese criterio de calidad. ¿Continuar?';
      if (!window.confirm(msg)) return;
      aplicar.disabled = true;
      await aplicarSpecSync(ui, results);
    });
    ui.ft.appendChild(aplicar);
    const cerrar = el('button', null, 'Cerrar');
    cerrar.addEventListener('click', closePanel);
    ui.ft.appendChild(cerrar);
  }

  async function aplicarSpecSync(ui, results) {
    setTitle(ui, 'Aplicando…');
    clear(ui.bd);
    const status = el('p', null, '0 de ' + results.length);
    ui.bd.appendChild(status);
    const tot = { archivadas: 0, desarchivadas: 0, agregadas: 0, errores: [] };
    let i = 0;
    for (const r of results) {
      const out = await applySpecSync(r);
      tot.archivadas += out.archivadas; tot.desarchivadas += out.desarchivadas;
      tot.agregadas += out.agregadas;
      for (const e of out.errores) tot.errores.push('OT ' + r.idInDomain + ' · ' + e);
      status.textContent = (++i) + ' de ' + results.length;
    }
    clear(ui.bd); clear(ui.ft);
    setTitle(ui, 'Listo');
    ui.bd.appendChild(el('div', 'sa-sum',
      tot.archivadas + ' archivadas · ' + tot.desarchivadas + ' desarchivadas · ' + tot.agregadas + ' agregadas'));
    if (tot.errores.length) {
      // Los errores se PINTAN, no se cuentan nada más: un fallo total se veía igual que un éxito
      // silencioso en el incidente de los 52 params (spec-migrator, 2026-07-29).
      ui.bd.appendChild(el('p', 'sa-mut', tot.errores.length + ' operación(es) fallaron; '
        + 'la orden se detuvo en la primera para no dejarla a medias:'));
      const ul = el('ul');
      for (const e of tot.errores.slice(0, 20)) ul.appendChild(el('li', null, e));
      ui.bd.appendChild(ul);
    }
    ui.bd.appendChild(el('p', 'sa-mut',
      'Vuelve a escanear para confirmar: el ERP responde sin confirmar lo que escribió.'));
    const c = el('button', null, 'Cerrar');
    c.addEventListener('click', closePanel);
    ui.ft.appendChild(c);
  }

  window.WoSpecParams = {
    VERSION,
    isWorkOrderDetailPath, parseWorkOrderIdInDomain, parsePastedWorkOrders,
    parsePastedPartNumbers, resolvePartNumbers, findWorkOrdersForPartNumbers,
    runPool, planScanChunks, mergeCheckpoint, dedupHallazgos, slimResult, openScan,
    analyzeSpecSync, applySpecSync, openSpecSync, renderSpecSyncPreview,
    setSoloNP: (v) => { _soloNP = !!v; },
    getSoloNP: () => _soloNP,
    setMigrarAInspeccion: (v) => { _migrarAInspeccion = !!v; },
    getMigrarAInspeccion: () => _migrarAInspeccion,
    setRescateReceta: (v) => { _rescateReceta = !!v; },
    getRescateReceta: () => _rescateReceta,
    resetMasterCache,
    analyzeWorkOrder, summarize, applyPlan, buildCsv,
    open, openFromPopup, openSpecSyncFromPopup, closePanel, init,
    _realDeps: realDeps, _writeDeps: writeDeps
  };

  if (typeof document !== 'undefined' && document.body) init();
  else if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
