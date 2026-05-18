// Process Deep Audit v0.7.1
// Auditoría read-only que aplica 4 reglas a cada PROCESS root:
//   R1 — nodos "Listo" deben ser SCANNER_NODE, STAGING o STEP_SHIPPING_READY
//   R2 — cada sección/línea (T<n>) debe tener treatment con ≥1 estación y cycleTime>0
//   R3 — procesos satélite (T100,T200,…,(FIB)/(ANT)/(HOR)/(LIM)/(VIB)) con tiempos
//   R4 — defaultLeadTime > 0 + productByProductId cuyo nombre cubra sufijos del nombre
//
// Genera reporte + plantilla XLSX con columnas editables para que un applet
// hermano (Fase 2) suba tiempos/leadTime/product de forma masiva.
//
// API pública: window.ProcessDeepAudit.run()
// Depende de: window.ProcessShared (constantes, queries, helpers de árbol)
// Depende de: window.SteelheadAPI (init de config), window.XLSX (SheetJS)

const ProcessDeepAudit = (() => {
  'use strict';

  const VERSION = '0.8.0';
  const ps = () => window.ProcessShared;
  const api = () => window.SteelheadAPI;

  // ── Logging ──
  function log(msg)  { try { api().log(msg); } catch (_) { console.log('[SA-DA]', msg); } }
  function warn(msg) { try { api().warn(msg); } catch (_) { console.warn('[SA-DA]', msg); } }

  // ── Estado runtime + cancellation token (patrón runId/isStale de invoice-autofill) ──
  let state = null; // { runId, cancelled, processes, satellites, progress: {current, total, phase}, rows: {…} }

  function isStale(myRunId) {
    return !state || state.cancelled || state.runId !== myRunId;
  }

  function bailIfStale(myRunId) {
    if (isStale(myRunId)) throw new Error('__sa_aborted__');
  }

  function resetState() {
    state = {
      runId: (state?.runId || 0) + 1,
      cancelled: false,
      processes: [],
      satellites: [],
      progress: { current: 0, total: 0, phase: 'init' },
      rows: { resumen: [], r1: [], r2: [], r3: [], r4: [], d1: [], d2: [], d3: [], catalogos: [], leyenda: [] },
      treesById: new Map(),
      duplicates: { partial: false, groupsD1: 0, groupsD2: 0, groupsD3: 0, membersD1: 0, membersD2: 0, membersD3: 0 },
      errors: []
    };
    return state.runId;
  }

  // ── Pool con semáforo (concurrencia controlada) ──
  async function runPool(items, worker, concurrency, onProgress, myRunId) {
    const queue = items.slice();
    let active = 0;
    let done = 0;
    let idx = 0;
    return new Promise((resolve) => {
      function next() {
        if (state.cancelled) {
          if (active === 0) resolve();
          return;
        }
        while (active < concurrency && idx < queue.length) {
          const myIdx = idx++;
          const item = queue[myIdx];
          active++;
          Promise.resolve().then(() => worker(item, myIdx))
            .catch(err => { if (err?.message !== '__sa_aborted__') state.errors.push({ item, err: err?.message || String(err) }); })
            .finally(() => {
              active--;
              done++;
              if (onProgress) onProgress(done, queue.length);
              if (state.cancelled && active === 0) { resolve(); return; }
              if (done >= queue.length && active === 0) resolve();
              else next();
            });
        }
      }
      if (!queue.length) resolve();
      else next();
    });
  }

  // ── Retry con backoff (de config.processAudit.concurrency.retryDelaysMs) ──
  async function withRetry(fn, label, myRunId) {
    const delays = (ps().auditConcurrency().retryDelaysMs) || [0, 1000, 2000];
    let lastErr = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      bailIfStale(myRunId);
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      bailIfStale(myRunId);
      try { return await fn(); }
      catch (err) {
        if (err?.message === '__sa_aborted__') throw err;
        lastErr = err;
        warn(`${label}: intento ${attempt + 1}/${delays.length} falló · ${err.message}`);
      }
    }
    throw lastErr || new Error(`${label}: agotó reintentos`);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Catálogo de satélites (regex + override de config) ──
  function buildSatelliteCatalog(allProcesses) {
    const overrides = ps().satelliteOverrides() || { include: [], exclude: [] };
    const excludeIds = new Set((overrides.exclude || []).map(o => o.id));
    const out = new Map(); // id → {id, name, source: 'regex'|'aux'|'override'}

    // 1. Descubrimiento por regex T/M<n>00
    for (const p of allProcesses) {
      if (!p || p.type !== 'PROCESS') continue;
      const code = ps().extractLineCodeFromName(p.name || '');
      if (code && ps().isSatelliteCode(code)) {
        if (!excludeIds.has(p.id)) out.set(p.id, { id: p.id, name: p.name, source: 'regex' });
      }
    }

    // 2. Por sufijos auxiliares (FIB/ANT/HOR/LIM/VIB/MAR/GRA)
    const auxRegex = /\((FIB|ANT|HOR|LIM|VIB|MAR|GRA)\)/i;
    for (const p of allProcesses) {
      if (!p || p.type !== 'PROCESS') continue;
      if (auxRegex.test(p.name || '')) {
        if (!excludeIds.has(p.id) && !out.has(p.id)) out.set(p.id, { id: p.id, name: p.name, source: 'aux' });
      }
    }

    // 3. Includes manuales (override en config)
    for (const inc of (overrides.include || [])) {
      if (inc && inc.id && !out.has(inc.id)) {
        out.set(inc.id, { id: inc.id, name: inc.name || '', source: 'override' });
      }
    }

    return [...out.values()];
  }

  // ── Universo a analizar para D1/D2/D3 ──
  // Reúne los 5 buckets respetando ignoreIds/ignoreNamePatterns/includeSources.
  // Cada item: {id, name, type, source}. Source es metadata para el reporte,
  // NO afecta la detección (un PROCESS clon de un SUB_PROCESS sí cuenta).
  function buildAuditUniverse(allProcesses, satelliteCatalog) {
    const dupCfg = ps().duplicatesConfig();
    if (!dupCfg.enabled) return [];
    const include = new Set(dupCfg.includeSources);
    const ignoreIds = dupCfg.ignoreIds;
    const ignoreNamePatterns = dupCfg.ignoreNamePatterns;
    const isIgnored = (id, name) => {
      if (ignoreIds.has(Number(id))) return true;
      return ignoreNamePatterns.some(re => re.test(name || ''));
    };

    const universe = [];
    const seen = new Set();
    const push = (id, name, type, source) => {
      if (id == null || seen.has(id)) return;
      if (isIgnored(id, name)) return;
      if (!include.has(source)) return;
      seen.add(id);
      universe.push({ id, name: name || '', type: type || null, source });
    };

    const satIds = new Set(satelliteCatalog.map(s => s.id));

    // Bucket 1: PROCESS principales (excluye satélites y RT/SP)
    // Bucket 2: PROCESS satélites
    // Bucket 4: RT (PROCESS con prefijo RT que isExcludedProcessName filtró antes)
    for (const p of allProcesses) {
      if (!p || p.type !== 'PROCESS') continue;
      if (satIds.has(p.id)) { push(p.id, p.name, p.type, 'satellite'); continue; }
      if (/^RT\b/i.test(p.name || '')) { push(p.id, p.name, p.type, 'rt'); continue; }
      if (/^SP\b/i.test(p.name || '')) continue; // SP que sea PROCESS — raro, no se cuenta como main
      push(p.id, p.name, p.type, 'main');
    }

    // Bucket 3: SUB_PROCESS y Bucket 5: STEP_SHIPPING — del catálogo cargado por loadAllNodes
    const cat = ps().getCatalog();
    if (cat && cat.namesById) {
      for (const [id, name] of cat.namesById.entries()) {
        const type = cat.typesById.get(id);
        if (type === 'SUB_PROCESS') push(id, name, type, 'subprocess');
        else if (type === 'STEP_SHIPPING') push(id, name, type, 'stepshipping');
      }
    }

    return universe;
  }

  // ── Helpers de normalización para R4-c (producto cubre sufijos) ──
  function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  }

  function productCoversSuffix(productName, suffix) {
    const map = ps().finishProductMap();
    const tokens = map[suffix] || [];
    if (!tokens.length) return null; // sufijo no mapeado en config
    const pn = stripAccents(productName);
    return tokens.some(t => pn.includes(stripAccents(t)));
  }

  // ── R1: nodos Listo (cualquier nivel) cuyo type no está en la whitelist ──
  // Tipos válidos para nodos "Listo":
  //   - SCANNER_NODE: caso estándar (línea de producción, escanea entrada).
  //   - STAGING: variante de almacenamiento intermedio.
  //   - STEP_SHIPPING_READY: tipo especial para nodos de embarque (válido por
  //     diseño; no debe reportarse como problema).
  function evaluateR1(treeRoot, processInfo) {
    const findings = [];
    if (!treeRoot) return findings;
    const all = ps().flattenTree(treeRoot);
    const validTypes = new Set(['SCANNER_NODE', 'STAGING', 'STEP_SHIPPING_READY']);
    for (const node of all) {
      if (!node?.name) continue;
      if (!/listo/i.test(node.name)) continue;
      if (validTypes.has(node.type)) continue;
      findings.push({
        ProcessID: processInfo.id,
        ProcessName: processInfo.name,
        NodoListoID: node.id,
        NodoListoName: node.name,
        TipoActual: node.type || '(desconocido)',
        TipoEsperado: 'SCANNER_NODE / STAGING / STEP_SHIPPING_READY'
      });
    }
    return findings;
  }

  // ── R2: por cada sección detectada en top-level, validar treatment + tiempos ──
  async function evaluateR2(treeRoot, processInfo, myRunId) {
    const findings = [];
    if (!treeRoot) return findings;
    const topLevel = ps().extractTopLevel(treeRoot);
    const sections = ps().detectLineSections(topLevel);
    if (!sections.length) return findings;

    for (const section of sections) {
      bailIfStale(myRunId);
      const listoNode = section.listoNode;
      const lineCode = section.lineCode || '(sin código)';
      if (!listoNode) {
        findings.push({
          ProcessID: processInfo.id,
          ProcessName: processInfo.name,
          LineCode: lineCode,
          NodoListoID: null,
          NodoListoName: '(sección sin Listo)',
          TreatmentID: null,
          TreatmentName: '',
          StationID: null,
          StationName: '',
          CycleTime_min: '',
          TotalTime_min: '',
          TimeType: '',
          CycleTime_min_NUEVO: '',
          TotalTime_min_NUEVO: '',
          TimeType_NUEVO: '',
          Estado: 'R2-listo-faltante'
        });
        continue;
      }

      // GetProcessNode del Listo → treatmentByTreatmentId
      let listoDetail = null;
      try {
        listoDetail = await withRetry(() => ps().getProcessTree(listoNode.id), `R2 listo ${listoNode.id}`, myRunId);
      } catch (err) {
        if (err.message === '__sa_aborted__') throw err;
        findings.push({
          ProcessID: processInfo.id, ProcessName: processInfo.name, LineCode: lineCode,
          NodoListoID: listoNode.id, NodoListoName: listoNode.name,
          TreatmentID: null, TreatmentName: '', StationID: null, StationName: '',
          CycleTime_min: '', TotalTime_min: '', TimeType: '',
          CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '', TimeType_NUEVO: '',
          Estado: `R2-error: ${err.message.substring(0, 120)}`
        });
        continue;
      }

      const detail = listoDetail?.processNodeById;
      const treatment = detail?.treatmentByTreatmentId;
      if (!treatment || !treatment.id) {
        findings.push({
          ProcessID: processInfo.id, ProcessName: processInfo.name, LineCode: lineCode,
          NodoListoID: listoNode.id, NodoListoName: listoNode.name,
          TreatmentID: null, TreatmentName: '', StationID: null, StationName: '',
          CycleTime_min: '', TotalTime_min: '', TimeType: '',
          CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '', TimeType_NUEVO: '',
          Estado: 'R2-a: sin treatment asignado'
        });
        continue;
      }

      // GetTreatment para estaciones
      let treatmentFull = null;
      try {
        treatmentFull = await withRetry(() => ps().getTreatmentDetail(treatment.id), `R2 treatment ${treatment.id}`, myRunId);
      } catch (err) {
        if (err.message === '__sa_aborted__') throw err;
        findings.push({
          ProcessID: processInfo.id, ProcessName: processInfo.name, LineCode: lineCode,
          NodoListoID: listoNode.id, NodoListoName: listoNode.name,
          TreatmentID: treatment.id, TreatmentName: treatment.name || '',
          StationID: null, StationName: '',
          CycleTime_min: '', TotalTime_min: '', TimeType: '',
          CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '', TimeType_NUEVO: '',
          Estado: `R2-error: ${err.message.substring(0, 120)}`
        });
        continue;
      }

      const stationLinks = treatmentFull?.stationTreatmentsByTreatmentId?.nodes || [];
      if (!stationLinks.length) {
        findings.push({
          ProcessID: processInfo.id, ProcessName: processInfo.name, LineCode: lineCode,
          NodoListoID: listoNode.id, NodoListoName: listoNode.name,
          TreatmentID: treatment.id, TreatmentName: treatmentFull?.name || treatment.name || '',
          StationID: null, StationName: '',
          CycleTime_min: '', TotalTime_min: '', TimeType: '',
          CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '', TimeType_NUEVO: '',
          Estado: 'R2-b: treatment sin estaciones'
        });
        continue;
      }

      const stationIds = stationLinks.map(s => s.stationId).filter(x => x != null);
      const stationNameById = new Map();
      for (const link of stationLinks) {
        if (link.stationId != null) {
          stationNameById.set(link.stationId, link.stationByStationId?.name || link.station?.name || '');
        }
      }

      // CreateEditTreatmentTimesDialogQuery → tiempos por (treatment, station)
      let timesNodes = [];
      try {
        timesNodes = await withRetry(
          () => ps().getTreatmentTimes({ treatmentIds: [treatment.id], stationIds, processNodeIds: [] }),
          `R2 times t=${treatment.id}`, myRunId
        );
      } catch (err) {
        if (err.message === '__sa_aborted__') throw err;
        findings.push({
          ProcessID: processInfo.id, ProcessName: processInfo.name, LineCode: lineCode,
          NodoListoID: listoNode.id, NodoListoName: listoNode.name,
          TreatmentID: treatment.id, TreatmentName: treatmentFull?.name || treatment.name || '',
          StationID: null, StationName: '',
          CycleTime_min: '', TotalTime_min: '', TimeType: '',
          CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '', TimeType_NUEVO: '',
          Estado: `R2-error tiempos: ${err.message.substring(0, 120)}`
        });
        continue;
      }

      // Agrupar tiempos por stationId
      const timesByStation = new Map();
      for (const tn of timesNodes) {
        const sid = tn.stationId;
        if (sid == null) continue;
        const rel = (tn.relatedTimes && tn.relatedTimes[0]) || tn; // shape puede venir colapsado
        if (!timesByStation.has(sid)) timesByStation.set(sid, []);
        timesByStation.get(sid).push(rel);
      }

      let stationsWithTime = 0;
      const stationRows = [];
      for (const sid of stationIds) {
        const times = timesByStation.get(sid) || [];
        const best = times.find(t => ps().hasInterval(t.cycleTime)) || times[0] || null;
        const cycleMin = best ? ps().intervalToMinutes(best.cycleTime) : 0;
        const totalMin = best ? ps().intervalToMinutes(best.totalTime) : 0;
        if (cycleMin > 0) stationsWithTime++;
        stationRows.push({
          StationID: sid,
          StationName: stationNameById.get(sid) || '',
          CycleTime_min: cycleMin || '',
          TotalTime_min: totalMin || '',
          TimeType: best?.timeType || '',
          OK: cycleMin > 0
        });
      }

      let estado;
      if (stationsWithTime === 0) estado = 'R2-c: treatment sin tiempos';
      else if (stationsWithTime < stationIds.length) estado = 'R2-d: tiempos parciales';
      else estado = 'OK';

      // Emitimos UN row por estación (para que la plantilla tenga todas las celdas)
      for (const sRow of stationRows) {
        findings.push({
          ProcessID: processInfo.id,
          ProcessName: processInfo.name,
          LineCode: lineCode,
          NodoListoID: listoNode.id,
          NodoListoName: listoNode.name,
          TreatmentID: treatment.id,
          TreatmentName: treatmentFull?.name || treatment.name || '',
          StationID: sRow.StationID,
          StationName: sRow.StationName,
          CycleTime_min: sRow.CycleTime_min,
          TotalTime_min: sRow.TotalTime_min,
          TimeType: sRow.TimeType,
          CycleTime_min_NUEVO: '',
          TotalTime_min_NUEVO: '',
          TimeType_NUEVO: '',
          Estado: estado === 'OK' ? (sRow.OK ? 'OK' : 'sin tiempo') : estado
        });
      }
    }

    return findings;
  }

  // ── R3: satélites con tiempos cargados ──
  async function evaluateR3(satellite, myRunId) {
    const findings = [];
    let tree = null;
    try {
      tree = await withRetry(() => ps().getProcessTree(satellite.id), `R3 sat ${satellite.id}`, myRunId);
      if (tree) state.treesById.set(satellite.id, tree);
    } catch (err) {
      if (err.message === '__sa_aborted__') throw err;
      findings.push({
        SatelliteID: satellite.id, SatelliteName: satellite.name,
        TipoSufijo: satellite.source, CompartidoEnUso: '',
        TreatmentID: null, StationID: null, StationName: '',
        CycleTime_min: '', TotalTime_min: '',
        CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '',
        Estado: `R3-error: ${err.message.substring(0, 120)}`
      });
      return findings;
    }

    const detail = tree?.processNodeById;
    let treatment = detail?.treatmentByTreatmentId || null;

    // Si el root no tiene treatment, buscar en hijos directos (STEP/STAGING)
    if (!treatment || !treatment.id) {
      const children = detail?.children?.nodes || detail?.children || [];
      for (const ch of children) {
        if (ch.treatmentByTreatmentId?.id) { treatment = ch.treatmentByTreatmentId; break; }
      }
    }

    // Compartido en uso (informativo)
    let compartido = '';
    try {
      const parents = await withRetry(() => ps().getProcessNodeParents(satellite.id), `R3 parents ${satellite.id}`, myRunId);
      if (parents && parents.length > 1) compartido = `Sí (${parents.length})`;
      else if (parents && parents.length === 1) compartido = 'No (1 padre)';
      else compartido = 'Huérfano';
    } catch (_) { compartido = '?'; }

    if (!treatment || !treatment.id) {
      findings.push({
        SatelliteID: satellite.id, SatelliteName: satellite.name,
        TipoSufijo: satellite.source, CompartidoEnUso: compartido,
        TreatmentID: null, StationID: null, StationName: '',
        CycleTime_min: '', TotalTime_min: '',
        CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '',
        Estado: 'R3-a: sin treatment'
      });
      return findings;
    }

    let treatmentFull = null;
    try {
      treatmentFull = await withRetry(() => ps().getTreatmentDetail(treatment.id), `R3 treatment ${treatment.id}`, myRunId);
    } catch (err) {
      if (err.message === '__sa_aborted__') throw err;
      findings.push({
        SatelliteID: satellite.id, SatelliteName: satellite.name,
        TipoSufijo: satellite.source, CompartidoEnUso: compartido,
        TreatmentID: treatment.id, StationID: null, StationName: '',
        CycleTime_min: '', TotalTime_min: '',
        CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '',
        Estado: `R3-error: ${err.message.substring(0, 120)}`
      });
      return findings;
    }

    const stationLinks = treatmentFull?.stationTreatmentsByTreatmentId?.nodes || [];
    if (!stationLinks.length) {
      findings.push({
        SatelliteID: satellite.id, SatelliteName: satellite.name,
        TipoSufijo: satellite.source, CompartidoEnUso: compartido,
        TreatmentID: treatment.id, StationID: null, StationName: '',
        CycleTime_min: '', TotalTime_min: '',
        CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '',
        Estado: 'R3-b: sin estaciones'
      });
      return findings;
    }

    const stationIds = stationLinks.map(s => s.stationId).filter(x => x != null);
    const stationNameById = new Map();
    for (const link of stationLinks) {
      if (link.stationId != null) {
        stationNameById.set(link.stationId, link.stationByStationId?.name || link.station?.name || '');
      }
    }

    let timesNodes = [];
    try {
      timesNodes = await withRetry(
        () => ps().getTreatmentTimes({ treatmentIds: [treatment.id], stationIds, processNodeIds: [] }),
        `R3 times t=${treatment.id}`, myRunId
      );
    } catch (err) {
      if (err.message === '__sa_aborted__') throw err;
      findings.push({
        SatelliteID: satellite.id, SatelliteName: satellite.name,
        TipoSufijo: satellite.source, CompartidoEnUso: compartido,
        TreatmentID: treatment.id, StationID: null, StationName: '',
        CycleTime_min: '', TotalTime_min: '',
        CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '',
        Estado: `R3-error tiempos: ${err.message.substring(0, 120)}`
      });
      return findings;
    }

    const timesByStation = new Map();
    for (const tn of timesNodes) {
      const sid = tn.stationId;
      if (sid == null) continue;
      const rel = (tn.relatedTimes && tn.relatedTimes[0]) || tn;
      if (!timesByStation.has(sid)) timesByStation.set(sid, []);
      timesByStation.get(sid).push(rel);
    }

    let stationsWithTime = 0;
    const rowsBuf = [];
    for (const sid of stationIds) {
      const times = timesByStation.get(sid) || [];
      const best = times.find(t => ps().hasInterval(t.cycleTime)) || times[0] || null;
      const cycleMin = best ? ps().intervalToMinutes(best.cycleTime) : 0;
      const totalMin = best ? ps().intervalToMinutes(best.totalTime) : 0;
      if (cycleMin > 0) stationsWithTime++;
      rowsBuf.push({
        SatelliteID: satellite.id, SatelliteName: satellite.name,
        TipoSufijo: satellite.source, CompartidoEnUso: compartido,
        TreatmentID: treatment.id,
        StationID: sid, StationName: stationNameById.get(sid) || '',
        CycleTime_min: cycleMin || '', TotalTime_min: totalMin || '',
        CycleTime_min_NUEVO: '', TotalTime_min_NUEVO: '',
        Estado: cycleMin > 0 ? 'OK' : 'sin tiempo'
      });
    }

    let summaryState = 'OK';
    if (stationsWithTime === 0) summaryState = 'R3-c: sin tiempos';
    else if (stationsWithTime < stationIds.length) summaryState = 'R3-d: tiempos parciales';
    for (const r of rowsBuf) {
      if (summaryState !== 'OK' && r.Estado === 'OK') r.Estado = summaryState;
      else if (summaryState !== 'OK') r.Estado = summaryState;
    }
    findings.push(...rowsBuf);
    return findings;
  }

  // ── R4: lead time + producto + coherencia con sufijos ──
  function evaluateR4(detail, processInfo) {
    const findings = [];
    if (!detail) return findings;

    const lead = detail.defaultLeadTime;
    const leadHours = lead ? ps().intervalToHours(lead) : 0;
    const product = detail.productByProductId;
    const productName = product?.name || '';
    const suffixes = ps().extractFinishSuffixes(processInfo.name);

    let leadOK = leadHours > 0;
    let productOK = product != null && !!product.id;

    const uncovered = [];
    if (suffixes.length && productOK) {
      for (const sx of suffixes) {
        const cov = productCoversSuffix(productName, sx);
        if (cov === false) uncovered.push(sx);
        // cov === null → sufijo no mapeado → no es error, ignorar
      }
    }
    const coherenciaOK = productOK && uncovered.length === 0;

    // R4-a, b, c — emitir UNA fila por proceso (panel y XLSX más legibles)
    let estado;
    if (!leadOK && !productOK) estado = 'R4-a+b: sin lead, sin producto';
    else if (!leadOK) estado = 'R4-a: sin lead time';
    else if (!productOK) estado = 'R4-b: sin producto';
    else if (uncovered.length === suffixes.length && suffixes.length > 0) estado = 'R4-c: producto NO cubre sufijos';
    else if (uncovered.length > 0) estado = 'R4-warn: cobertura parcial';
    else estado = 'OK';

    if (estado !== 'OK' || suffixes.length > 0) {
      findings.push({
        ProcessID: processInfo.id,
        ProcessName: processInfo.name,
        LeadTime_horas_actual: leadOK ? leadHours.toFixed(2) : 0,
        LeadTime_horas_NUEVO: '',
        ProductID_actual: product?.id || '',
        ProductName_actual: productName,
        ProductName_NUEVO: '',
        SufijosAcabado: suffixes.join(', '),
        SufijosNoCubiertos: uncovered.join(', '),
        EstadoCoherencia: estado
      });
    }

    return { findings, leadOK, productOK, coherenciaOK };
  }

  // ── pickCanonical (un canon por grupo de duplicados) ──
  // Ordena por (referencias entrantes DESC, id ASC). El primer elemento gana.
  function pickCanonical(members, parentsByIdCache) {
    return members.slice().sort((a, b) => {
      const pa = parentsByIdCache.get(a.id);
      const pb = parentsByIdCache.get(b.id);
      const fa = (pa == null) ? -1 : pa;  // sin dato pierde contra cualquier número
      const fb = (pb == null) ? -1 : pb;
      if (fa !== fb) return fb - fa;
      return a.id - b.id;
    })[0];
  }

  // ── evaluateD: D1/D2/D3 sobre el universo. Mutates state.rows.d1/d2/d3
  // y state.duplicates. ──
  async function evaluateD(auditUniverse, myRunId) {
    const concurrency = ps().auditConcurrency();
    const treesPool = concurrency.trees || 5;
    const parentsPool = concurrency.parents || 5;

    // 1. Fetch árboles faltantes (para SUB_PROCESS/STEP_SHIPPING/RT no auditados por R1-R4)
    const missing = auditUniverse.filter(n => !state.treesById.has(n.id));
    log(`  D-fase: árboles ya cacheados=${auditUniverse.length - missing.length}, por fetchar=${missing.length}`);

    if (missing.length) {
      state.progress.phase = `D · fetchando árboles faltantes · 0/${missing.length}`;
      renderPanel();
      await runPool(missing, async (node) => {
        if (state.cancelled || isStale(myRunId)) return;
        try {
          const tree = await withRetry(() => ps().getProcessTree(node.id), `D tree ${node.id}`, myRunId);
          if (tree) state.treesById.set(node.id, tree);
        } catch (err) {
          if (err?.message === '__sa_aborted__') throw err;
          // Error individual: el nodo se omite de D2/D3 pero sigue en D1
        }
      }, treesPool, (done, total) => {
        if (!isStale(myRunId)) {
          state.progress.phase = `D · fetchando árboles faltantes · ${done}/${total}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);
    }

    // Si el run fue cancelado a media fetch, marca parcial pero no aborta — D1 sí puede emitir
    if (state.cancelled) state.duplicates.partial = true;

    // 2. Calcular firmas + agrupar
    state.progress.phase = 'D · calculando firmas y agrupando';
    renderPanel();
    const sigD1Fn = (n) => ps().signatureD1(n);
    const sigD2Fn = (n) => {
      const t = state.treesById.get(n.id);
      return t ? ps().signatureD2(t.treeRoot) : null;
    };
    const sigD3Fn = (n) => {
      const t = state.treesById.get(n.id);
      return t ? ps().signatureD3(t.treeRoot) : null;
    };
    const groupsD1 = ps().groupBySignature(auditUniverse, sigD1Fn);
    const groupsD2 = ps().groupBySignature(auditUniverse, sigD2Fn);
    const groupsD3 = ps().groupBySignature(auditUniverse, sigD3Fn);

    // Filtrar grupos size>=2. D2/D3 además excluyen firma '[]' (top-level vacío)
    // para no agrupar nodos hoja (STEP_SHIPPING terminales, RT minimal) como duplicados falsos.
    const dupGroupsD1 = [...groupsD1.entries()].filter(([, members]) => members.length >= 2);
    const dupGroupsD2 = [...groupsD2.entries()].filter(([sig, members]) => sig !== '[]' && members.length >= 2);
    const dupGroupsD3 = [...groupsD3.entries()].filter(([sig, members]) => sig !== '[]' && members.length >= 2);

    // Cross-flags: ¿este id aparece como duplicado en otra firma?
    const inD1 = new Set(), inD2 = new Set(), inD3 = new Set();
    for (const [, members] of dupGroupsD1) for (const m of members) inD1.add(m.id);
    for (const [, members] of dupGroupsD2) for (const m of members) inD2.add(m.id);
    for (const [, members] of dupGroupsD3) for (const m of members) inD3.add(m.id);

    // 3. Fetch parents para todos los miembros únicos de los 3 conjuntos
    const allDupIds = new Set([...inD1, ...inD2, ...inD3]);
    const parentsByIdCache = new Map();
    if (allDupIds.size) {
      state.progress.phase = `D · fetchando referencias entrantes · 0/${allDupIds.size}`;
      renderPanel();
      const idsArr = [...allDupIds];
      await runPool(idsArr, async (id) => {
        if (state.cancelled || isStale(myRunId)) return;
        try {
          const parents = await withRetry(() => ps().getProcessNodeParents(id), `D parents ${id}`, myRunId);
          parentsByIdCache.set(id, parents.length);
        } catch (err) {
          if (err?.message === '__sa_aborted__') throw err;
          // sin dato: pickCanonical lo trata como -1 (pierde)
        }
      }, parentsPool, (done, total) => {
        if (!isStale(myRunId)) {
          state.progress.phase = `D · fetchando referencias entrantes · ${done}/${total}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);
    }

    if (state.cancelled) state.duplicates.partial = true;

    // 4. Emitir filas por grupo
    function emitRows(targetArr, dupGroups) {
      for (const [groupId, members] of dupGroups) {
        const canon = pickCanonical(members, parentsByIdCache);
        for (const m of members) {
          const isCanon = (m.id === canon.id);
          const refs = parentsByIdCache.get(m.id);
          let accion = '';
          if (isCanon) accion = 'MANTENER';
          else if (refs === 0) accion = 'ARCHIVAR';
          else if (refs != null && refs > 0) accion = 'FUSIONAR';
          targetArr.push({
            ProcessID: m.id,
            ProcessName: m.name,
            Tipo: m.type || '',
            Source: m.source,
            GrupoID: groupId,
            GrupoTamano: members.length,
            EsCanonico: isCanon,
            ReferenciasEntrantes: (refs == null) ? '' : refs,
            EsArchivado: false,
            TambienEnD1: inD1.has(m.id),
            TambienEnD2: inD2.has(m.id),
            TambienEnD3: inD3.has(m.id),
            AccionSugerida: accion,
            AccionSugerida_NUEVO: '',
            Notas_NUEVO: ''
          });
        }
      }
    }
    emitRows(state.rows.d1, dupGroupsD1);
    emitRows(state.rows.d2, dupGroupsD2);
    emitRows(state.rows.d3, dupGroupsD3);

    state.duplicates.groupsD1 = dupGroupsD1.length;
    state.duplicates.groupsD2 = dupGroupsD2.length;
    state.duplicates.groupsD3 = dupGroupsD3.length;
    state.duplicates.membersD1 = state.rows.d1.length;
    state.duplicates.membersD2 = state.rows.d2.length;
    state.duplicates.membersD3 = state.rows.d3.length;

    log(`  D1: ${state.duplicates.groupsD1} grupos / ${state.duplicates.membersD1} miembros`);
    log(`  D2: ${state.duplicates.groupsD2} grupos / ${state.duplicates.membersD2} miembros`);
    log(`  D3: ${state.duplicates.groupsD3} grupos / ${state.duplicates.membersD3} miembros`);
  }

  // ── Auditor por proceso (orquesta R1, R2, R4 sobre una raíz PROCESS) ──
  async function auditProcess(processNode, myRunId) {
    const result = {
      id: processNode.id,
      name: processNode.name,
      lineCode: ps().extractLineCodeFromName(processNode.name || '') || '',
      isSatellite: false,
      counts: { r1: 0, r2: 0, r4: 0 },
      r1: [], r2: [], r4: [],
      estadoGlobal: 'OK',
      error: null
    };
    try {
      const tree = await withRetry(() => ps().getProcessTree(processNode.id), `audit ${processNode.id}`, myRunId);
      bailIfStale(myRunId);
      if (tree) state.treesById.set(processNode.id, tree);

      result.r1 = evaluateR1(tree?.treeRoot, processNode);
      result.counts.r1 = result.r1.length;

      result.r2 = await evaluateR2(tree?.treeRoot, processNode, myRunId);
      result.counts.r2 = result.r2.filter(r => r.Estado && r.Estado !== 'OK').length;

      const r4Eval = evaluateR4(tree?.processNodeById, processNode);
      result.r4 = r4Eval.findings;
      result.counts.r4 = r4Eval.findings.filter(r => r.EstadoCoherencia !== 'OK').length;

      const hasIssue = result.counts.r1 + result.counts.r2 + result.counts.r4 > 0;
      result.estadoGlobal = hasIssue ? 'CON HALLAZGOS' : 'OK';
    } catch (err) {
      if (err.message === '__sa_aborted__') throw err;
      result.error = err.message;
      result.estadoGlobal = 'ERROR';
    }
    return result;
  }

  // ── Orquestador principal ──
  async function run() {
    if (state && !state.cancelled && state.progress.phase !== 'done' && state.progress.phase !== 'error' && state.progress.phase !== 'init') {
      alert('Auditoría profunda en curso. Usa "Detener" o espera a que termine.');
      return;
    }
    const myRunId = resetState();
    ensureOverlay();
    showOverlay();
    renderPanel();

    try {
      log(`Deep audit v${VERSION} iniciado · runId=${myRunId}`);
      state.progress.phase = 'catalog';
      renderPanel();

      // Cargar catálogos (lazy — process-shared dedupe entre llamadas)
      await withRetry(() => ps().loadAllNodes((msg) => {
        if (!isStale(myRunId)) { state.progress.phase = `catálogo · ${msg}`; renderPanel(); }
      }), 'loadAllNodes', myRunId);
      bailIfStale(myRunId);

      // Inventario completo de procesos PROCESS (incluye satélites)
      state.progress.phase = 'procesos · listando…';
      renderPanel();
      const allProcesses = await withRetry(() => ps().fetchAllProcesses((msg) => {
        if (!isStale(myRunId)) { state.progress.phase = `procesos · ${msg}`; renderPanel(); }
      }), 'fetchAllProcesses', myRunId);
      bailIfStale(myRunId);

      // Catálogo de satélites
      const satelliteCatalog = buildSatelliteCatalog(allProcesses);
      const satelliteIds = new Set(satelliteCatalog.map(s => s.id));

      // Procesos no-satélite a auditar con R1/R2/R4
      const mainProcesses = allProcesses.filter(p => p.type === 'PROCESS' && !satelliteIds.has(p.id));

      // Estimación inicial: R1+R2+R4 + R3 + (universo a fetchar en D). Ajustada
      // dinámicamente cuando evaluateD descubre los faltantes reales.
      state.progress.total = mainProcesses.length + satelliteCatalog.length;
      state.progress.current = 0;
      state.progress.phase = `auditando ${mainProcesses.length} procesos + ${satelliteCatalog.length} satélites`;
      renderPanel();

      const concurrency = ps().auditConcurrency().audit || 5;

      // R1 + R2 + R4 sobre procesos principales
      await runPool(mainProcesses, async (p) => {
        if (state.cancelled) return;
        const res = await auditProcess(p, myRunId);
        state.processes.push(res);
        state.rows.r1.push(...res.r1);
        state.rows.r2.push(...res.r2);
        state.rows.r4.push(...res.r4);
      }, concurrency, (done, total) => {
        if (!isStale(myRunId)) {
          state.progress.current = done;
          state.progress.phase = `auditando procesos · ${done}/${total}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);

      // R3 sobre satélites
      state.progress.phase = `auditando satélites · 0/${satelliteCatalog.length}`;
      renderPanel();
      let satDone = 0;
      await runPool(satelliteCatalog, async (sat) => {
        if (state.cancelled) return;
        const findings = await evaluateR3(sat, myRunId);
        state.satellites.push({
          id: sat.id, name: sat.name, source: sat.source,
          findings,
          counts: { r3: findings.filter(f => f.Estado && f.Estado !== 'OK').length }
        });
        state.rows.r3.push(...findings);
      }, concurrency, (done) => {
        if (!isStale(myRunId)) {
          satDone = done;
          state.progress.current = mainProcesses.length + done;
          state.progress.phase = `auditando satélites · ${done}/${satelliteCatalog.length}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);

      // Detección de duplicados D1/D2/D3 (fase global post R1-R4)
      const auditUniverse = buildAuditUniverse(allProcesses, satelliteCatalog);
      log(`Universo D: ${auditUniverse.length} nodos (main+sat+rt+subprocess+stepshipping, descontando ignoreIds/ignoreNamePatterns)`);
      if (auditUniverse.length && ps().duplicatesConfig().enabled) {
        await evaluateD(auditUniverse, myRunId);
        bailIfStale(myRunId);
      } else {
        log('  D-fase saltada (duplicates.enabled=false o universo vacío)');
      }

      // Construir Resumen + Catálogos
      buildResumenRows();
      buildCatalogosRows();
      buildLeyendaRows();

      state.progress.phase = 'done';
      renderPanel();
      log(`Deep audit terminado · procesos=${state.processes.length} satélites=${state.satellites.length} errors=${state.errors.length}`);
    } catch (err) {
      if (err.message === '__sa_aborted__') {
        state.progress.phase = 'cancelled';
        log('Deep audit cancelado por el usuario');
      } else {
        state.progress.phase = 'error';
        state.errors.push({ item: '(orchestrator)', err: err.message });
        warn(`Deep audit error: ${err.message}`);
      }
      renderPanel();
    }
  }

  function cancel() {
    if (!state) return;
    state.cancelled = true;
    log('Cancelación solicitada por el usuario');
    state.progress.phase = 'cancelando…';
    renderPanel();
  }

  // ── Hoja Resumen ──
  function buildResumenRows() {
    state.rows.resumen = [];
    for (const p of state.processes) {
      state.rows.resumen.push({
        ProcessID: p.id, ProcessName: p.name, LineCode: p.lineCode,
        EsSatélite: 'No',
        Secciones: p.r2.length ? new Set(p.r2.map(r => r.LineCode)).size : 0,
        Hallazgos_R1: p.counts.r1,
        Hallazgos_R2: p.counts.r2,
        Hallazgos_R3: 0,
        Hallazgos_R4: p.counts.r4,
        EstadoGlobal: p.estadoGlobal,
        Error: p.error || ''
      });
    }
    for (const s of state.satellites) {
      state.rows.resumen.push({
        ProcessID: s.id, ProcessName: s.name, LineCode: ps().extractLineCodeFromName(s.name) || '',
        EsSatélite: 'Sí',
        Secciones: 1,
        Hallazgos_R1: 0,
        Hallazgos_R2: 0,
        Hallazgos_R3: s.counts.r3 || 0,
        Hallazgos_R4: 0,
        EstadoGlobal: s.counts.r3 > 0 ? 'CON HALLAZGOS' : 'OK',
        Error: ''
      });
    }
  }

  // ── Hoja Catálogos (referencias para lookups en la plantilla) ──
  function buildCatalogosRows() {
    state.rows.catalogos = [];
    const map = ps().finishProductMap();
    state.rows.catalogos.push({ Categoria: '__SUFIJOS_ACABADO__', Clave: '', Valor: '' });
    for (const [sx, tokens] of Object.entries(map)) {
      state.rows.catalogos.push({
        Categoria: 'sufijo→producto',
        Clave: sx,
        Valor: (tokens || []).join(' | ')
      });
    }
    state.rows.catalogos.push({ Categoria: '__SATELITES_DETECTADOS__', Clave: '', Valor: '' });
    for (const s of state.satellites) {
      state.rows.catalogos.push({
        Categoria: `satélite/${s.source}`,
        Clave: String(s.id),
        Valor: s.name
      });
    }
    state.rows.catalogos.push({ Categoria: '__ERRORES__', Clave: '', Valor: '' });
    for (const e of state.errors.slice(0, 200)) {
      state.rows.catalogos.push({
        Categoria: 'error',
        Clave: String(e.item?.id || e.item || ''),
        Valor: String(e.err || '').substring(0, 500)
      });
    }
  }

  // ── XLSX export (SheetJS) ──
  function exportXlsx() {
    if (!window.XLSX) { alert('XLSX no cargado. Recarga la extensión.'); return; }
    const wb = window.XLSX.utils.book_new();

    const addSheet = (name, rows, headers) => {
      if (!rows || !rows.length) {
        const ws = window.XLSX.utils.aoa_to_sheet([headers || ['(sin datos)']]);
        window.XLSX.utils.book_append_sheet(wb, ws, name);
        return;
      }
      const hdr = headers || Object.keys(rows[0]);
      const aoa = [hdr, ...rows.map(r => hdr.map(h => r[h] != null ? r[h] : ''))];
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);
      window.XLSX.utils.book_append_sheet(wb, ws, name);
    };

    addSheet('Resumen', state.rows.resumen, [
      'ProcessID', 'ProcessName', 'LineCode', 'EsSatélite', 'Secciones',
      'Hallazgos_R1', 'Hallazgos_R2', 'Hallazgos_R3', 'Hallazgos_R4',
      'EstadoGlobal', 'Error'
    ]);

    addSheet('R1_Listo_NoScanner', state.rows.r1, [
      'ProcessID', 'ProcessName', 'NodoListoID', 'NodoListoName',
      'TipoActual', 'TipoEsperado'
    ]);

    addSheet('R2_TiemposLineaPrincipal', state.rows.r2, [
      'ProcessID', 'ProcessName', 'LineCode',
      'NodoListoID', 'NodoListoName',
      'TreatmentID', 'TreatmentName',
      'StationID', 'StationName',
      'CycleTime_min', 'TotalTime_min', 'TimeType',
      'CycleTime_min_NUEVO', 'TotalTime_min_NUEVO', 'TimeType_NUEVO',
      'Estado'
    ]);

    addSheet('R3_Satélites', state.rows.r3, [
      'SatelliteID', 'SatelliteName', 'TipoSufijo', 'CompartidoEnUso',
      'TreatmentID', 'StationID', 'StationName',
      'CycleTime_min', 'TotalTime_min',
      'CycleTime_min_NUEVO', 'TotalTime_min_NUEVO',
      'Estado'
    ]);

    addSheet('R4_LeadTime_Producto', state.rows.r4, [
      'ProcessID', 'ProcessName',
      'LeadTime_horas_actual', 'LeadTime_horas_NUEVO',
      'ProductID_actual', 'ProductName_actual', 'ProductName_NUEVO',
      'SufijosAcabado', 'SufijosNoCubiertos', 'EstadoCoherencia'
    ]);

    addSheet('Catálogos', state.rows.catalogos, ['Categoria', 'Clave', 'Valor']);

    const wbOut = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `process-deep-audit-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log('XLSX descargado');
  }

  function exportJson() {
    const dump = {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      processes: state.processes,
      satellites: state.satellites,
      rows: state.rows,
      errors: state.errors
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `process-deep-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── UI Overlay ──
  function ensureOverlay() {
    if (document.getElementById('pdeep-overlay')) return;
    const style = document.createElement('style');
    style.id = 'pdeep-style';
    style.textContent = `
      #pdeep-overlay {
        position: fixed; top: 20px; right: 20px; width: 480px; max-height: 80vh;
        background: #fff; border: 2px solid #1e88e5; border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px; z-index: 2147483600; display: flex; flex-direction: column;
      }
      #pdeep-overlay header {
        background: #1e88e5; color: #fff; padding: 10px 14px;
        display: flex; justify-content: space-between; align-items: center;
        border-radius: 6px 6px 0 0;
      }
      #pdeep-overlay header h3 { margin: 0; font-size: 14px; font-weight: 600; }
      #pdeep-overlay header .pdeep-close {
        background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.5);
        border-radius: 4px; padding: 2px 8px; cursor: pointer;
      }
      #pdeep-overlay .pdeep-body { padding: 12px 14px; overflow-y: auto; flex: 1; }
      #pdeep-overlay .pdeep-progress {
        background: #f5f5f5; padding: 8px; border-radius: 4px; margin-bottom: 10px;
        font-size: 12px; color: #444;
      }
      #pdeep-overlay .pdeep-bar {
        height: 6px; background: #e0e0e0; border-radius: 3px; margin-top: 6px;
        overflow: hidden;
      }
      #pdeep-overlay .pdeep-bar > div { height: 100%; background: #1e88e5; transition: width .25s; }
      #pdeep-overlay table { width: 100%; border-collapse: collapse; font-size: 11px; }
      #pdeep-overlay th, #pdeep-overlay td { padding: 4px 6px; border-bottom: 1px solid #eee; text-align: left; }
      #pdeep-overlay th { background: #fafafa; font-weight: 600; }
      #pdeep-overlay tr.pdeep-issue { background: #fff8e1; }
      #pdeep-overlay tr.pdeep-error { background: #ffebee; }
      #pdeep-overlay .pdeep-actions {
        padding: 10px 14px; border-top: 1px solid #eee; background: #fafafa;
        display: flex; gap: 8px; flex-wrap: wrap; border-radius: 0 0 6px 6px;
      }
      #pdeep-overlay .pdeep-btn {
        padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
        border: 1px solid #1e88e5; background: #1e88e5; color: #fff; font-weight: 500;
      }
      #pdeep-overlay .pdeep-btn.secondary { background: #fff; color: #1e88e5; }
      #pdeep-overlay .pdeep-btn:disabled { opacity: .5; cursor: not-allowed; }
      #pdeep-overlay .pdeep-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 10px; }
      #pdeep-overlay .pdeep-summary > div { background: #f5f5f5; padding: 6px; border-radius: 4px; text-align: center; }
      #pdeep-overlay .pdeep-summary b { display: block; font-size: 18px; color: #1e88e5; }
      #pdeep-overlay .pdeep-summary span { font-size: 10px; color: #666; }
      #pdeep-overlay input.pdeep-filter {
        width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 3px; margin-bottom: 6px;
        box-sizing: border-box;
      }
      #pdeep-overlay .pdeep-tabs { display: flex; gap: 4px; margin-bottom: 6px; }
      #pdeep-overlay .pdeep-tabs button {
        flex: 1; padding: 5px 4px; border: 1px solid #ddd; background: #fff;
        cursor: pointer; font-size: 11px; border-radius: 3px;
      }
      #pdeep-overlay .pdeep-tabs button.active { background: #1e88e5; color: #fff; border-color: #1e88e5; }
    `;
    document.head.appendChild(style);

    const ov = document.createElement('div');
    ov.id = 'pdeep-overlay';
    ov.innerHTML = `
      <header>
        <h3>🔬 Auditoría Profunda de Procesos · v${VERSION}</h3>
        <button class="pdeep-close" data-act="close">×</button>
      </header>
      <div class="pdeep-body">
        <div class="pdeep-progress" id="pdeep-progress">Inicializando…</div>
        <div class="pdeep-summary" id="pdeep-summary" style="display:none"></div>
        <div id="pdeep-tabs-wrap" style="display:none">
          <div class="pdeep-tabs" id="pdeep-tabs"></div>
          <input class="pdeep-filter" id="pdeep-filter" placeholder="Filtrar por nombre, línea, ID…" />
          <div id="pdeep-table-wrap"></div>
        </div>
      </div>
      <div class="pdeep-actions">
        <button class="pdeep-btn" data-act="export-xlsx" disabled>📥 Exportar XLSX</button>
        <button class="pdeep-btn secondary" data-act="export-json" disabled>💾 JSON crudo</button>
        <button class="pdeep-btn secondary" data-act="cancel" style="display:none">⏹ Detener</button>
        <button class="pdeep-btn secondary" data-act="rerun" style="display:none">🔁 Reauditar</button>
      </div>
    `;
    document.body.appendChild(ov);

    ov.addEventListener('click', (e) => {
      const act = e.target?.getAttribute('data-act');
      if (!act) return;
      if (act === 'close') hideOverlay();
      else if (act === 'cancel') cancel();
      else if (act === 'export-xlsx') exportXlsx();
      else if (act === 'export-json') exportJson();
      else if (act === 'rerun') run();
      else if (act && act.startsWith('tab-')) switchTab(act.slice(4));
    });
    ov.querySelector('#pdeep-filter').addEventListener('input', () => renderTable());
  }

  function showOverlay() {
    const ov = document.getElementById('pdeep-overlay');
    if (ov) ov.style.display = 'flex';
  }
  function hideOverlay() {
    const ov = document.getElementById('pdeep-overlay');
    if (ov) ov.style.display = 'none';
  }

  let _activeTab = 'resumen';
  function switchTab(name) {
    _activeTab = name;
    const tabs = document.querySelectorAll('#pdeep-tabs button');
    tabs.forEach(b => b.classList.toggle('active', b.getAttribute('data-act') === `tab-${name}`));
    renderTable();
  }

  function renderPanel() {
    if (!document.getElementById('pdeep-overlay')) return;
    const phase = state.progress.phase;
    const cur = state.progress.current;
    const tot = state.progress.total;
    const pct = tot > 0 ? Math.round(cur / tot * 100) : 0;
    const progress = document.getElementById('pdeep-progress');
    if (progress) {
      progress.innerHTML = `
        <div><b>Fase:</b> ${escapeHtml(phase)}${tot ? ` · ${cur}/${tot}` : ''}</div>
        <div class="pdeep-bar"><div style="width: ${pct}%"></div></div>
        ${state.errors.length ? `<div style="color:#c62828; margin-top:4px;">⚠ ${state.errors.length} errores</div>` : ''}
      `;
    }

    const isDone = phase === 'done' || phase === 'cancelled' || phase === 'error';
    const isWorking = !isDone && phase !== 'init';

    const cancelBtn = document.querySelector('#pdeep-overlay [data-act="cancel"]');
    if (cancelBtn) cancelBtn.style.display = isWorking ? '' : 'none';
    const xlsxBtn = document.querySelector('#pdeep-overlay [data-act="export-xlsx"]');
    if (xlsxBtn) xlsxBtn.disabled = !isDone || phase === 'error';
    const jsonBtn = document.querySelector('#pdeep-overlay [data-act="export-json"]');
    if (jsonBtn) jsonBtn.disabled = !isDone || phase === 'error';
    const rerunBtn = document.querySelector('#pdeep-overlay [data-act="rerun"]');
    if (rerunBtn) rerunBtn.style.display = isDone ? '' : 'none';

    if (isDone && phase !== 'error') {
      renderSummary();
      renderTabs();
      renderTable();
    }
  }

  // Descripciones canónicas (mismos textos en panel, leyenda XLSX y tooltips)
  const RULE_LABELS = {
    R1: '"Listo" con tipo incorrecto',
    R2: 'Tiempos por sección/línea',
    R3: 'Satélites con tiempos cargados',
    R4: 'Lead time + producto coherente',
    D1: 'Mismo nombre (catálogo drift)',
    D2: 'Mismo tren de IDs top-level',
    D3: 'Mismo tren de nombres top-level'
  };

  function renderSummary() {
    const wrap = document.getElementById('pdeep-summary');
    if (!wrap) return;
    wrap.style.display = '';
    wrap.style.gridTemplateColumns = '1fr';  // override del CSS (5 cols) — ahora son listas
    const r1 = state.rows.r1.length;
    const r2 = state.rows.r2.filter(r => r.Estado && r.Estado !== 'OK').length;
    const r3 = state.rows.r3.filter(r => r.Estado && r.Estado !== 'OK').length;
    const r4 = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK').length;
    const d = state.duplicates || {};
    const partialBadge = d.partial ? ` <span style="color:#c62828; font-size:10px;">[PARCIAL]</span>` : '';
    wrap.innerHTML = `
      <div style="text-align:left; padding:8px; background:#f5f5f5; border-radius:4px;">
        <div style="font-weight:600; margin-bottom:4px;">${state.processes.length + state.satellites.length} procesos auditados</div>
        <div style="font-weight:600; margin-top:8px;">Reglas estructurales</div>
        <div title="${escapeHtml(RULE_LABELS.R1)}">▸ R1 — ${escapeHtml(RULE_LABELS.R1)} <b style="float:right;">${r1}</b></div>
        <div title="${escapeHtml(RULE_LABELS.R2)}">▸ R2 — ${escapeHtml(RULE_LABELS.R2)} <b style="float:right;">${r2}</b></div>
        <div title="${escapeHtml(RULE_LABELS.R3)}">▸ R3 — ${escapeHtml(RULE_LABELS.R3)} <b style="float:right;">${r3}</b></div>
        <div title="${escapeHtml(RULE_LABELS.R4)}">▸ R4 — ${escapeHtml(RULE_LABELS.R4)} <b style="float:right;">${r4}</b></div>
        <div style="font-weight:600; margin-top:8px;">Duplicados ★ NUEVO${partialBadge}</div>
        <div title="${escapeHtml(RULE_LABELS.D1)}">▸ D1 — ${escapeHtml(RULE_LABELS.D1)} <b style="float:right;">${d.groupsD1 || 0} grupos / ${d.membersD1 || 0}</b></div>
        <div title="${escapeHtml(RULE_LABELS.D2)}">▸ D2 — ${escapeHtml(RULE_LABELS.D2)} <b style="float:right;">${d.groupsD2 || 0} grupos / ${d.membersD2 || 0}</b></div>
        <div title="${escapeHtml(RULE_LABELS.D3)}">▸ D3 — ${escapeHtml(RULE_LABELS.D3)} <b style="float:right;">${d.groupsD3 || 0} grupos / ${d.membersD3 || 0}</b></div>
      </div>
    `;
    const tabsWrap = document.getElementById('pdeep-tabs-wrap');
    if (tabsWrap) tabsWrap.style.display = '';
  }

  function renderTabs() {
    const wrap = document.getElementById('pdeep-tabs');
    if (!wrap) return;
    const r1Count = state.rows.r1.length;
    const r2Count = state.rows.r2.filter(r => r.Estado !== 'OK').length;
    const r3Count = state.rows.r3.filter(r => r.Estado !== 'OK').length;
    const r4Count = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK').length;
    const d1Count = state.rows.d1.length;
    const d2Count = state.rows.d2.length;
    const d3Count = state.rows.d3.length;
    wrap.innerHTML = `
      <button data-act="tab-resumen" class="${_activeTab === 'resumen' ? 'active' : ''}">Resumen</button>
      <button data-act="tab-r1" title="${escapeHtml(RULE_LABELS.R1)}" class="${_activeTab === 'r1' ? 'active' : ''}">R1 (${r1Count})</button>
      <button data-act="tab-r2" title="${escapeHtml(RULE_LABELS.R2)}" class="${_activeTab === 'r2' ? 'active' : ''}">R2 (${r2Count})</button>
      <button data-act="tab-r3" title="${escapeHtml(RULE_LABELS.R3)}" class="${_activeTab === 'r3' ? 'active' : ''}">R3 (${r3Count})</button>
      <button data-act="tab-r4" title="${escapeHtml(RULE_LABELS.R4)}" class="${_activeTab === 'r4' ? 'active' : ''}">R4 (${r4Count})</button>
      <button data-act="tab-d1" title="${escapeHtml(RULE_LABELS.D1)}" class="${_activeTab === 'd1' ? 'active' : ''}">D1 (${d1Count})</button>
      <button data-act="tab-d2" title="${escapeHtml(RULE_LABELS.D2)}" class="${_activeTab === 'd2' ? 'active' : ''}">D2 (${d2Count})</button>
      <button data-act="tab-d3" title="${escapeHtml(RULE_LABELS.D3)}" class="${_activeTab === 'd3' ? 'active' : ''}">D3 (${d3Count})</button>
    `;
  }

  function renderTable() {
    const wrap = document.getElementById('pdeep-table-wrap');
    if (!wrap) return;
    const filter = (document.getElementById('pdeep-filter')?.value || '').toLowerCase();
    let rows = [];
    let headers = [];
    if (_activeTab === 'resumen') {
      headers = ['ProcessID', 'ProcessName', 'LineCode', 'EsSatélite', 'EstadoGlobal'];
      rows = state.rows.resumen;
    } else if (_activeTab === 'r1') {
      headers = ['ProcessName', 'NodoListoName', 'TipoActual'];
      rows = state.rows.r1;
    } else if (_activeTab === 'r2') {
      headers = ['ProcessName', 'LineCode', 'StationName', 'CycleTime_min', 'Estado'];
      rows = state.rows.r2.filter(r => r.Estado && r.Estado !== 'OK');
    } else if (_activeTab === 'r3') {
      headers = ['SatelliteName', 'TipoSufijo', 'StationName', 'CycleTime_min', 'Estado'];
      rows = state.rows.r3.filter(r => r.Estado && r.Estado !== 'OK');
    } else if (_activeTab === 'r4') {
      headers = ['ProcessName', 'ProductName_actual', 'SufijosNoCubiertos', 'EstadoCoherencia'];
      rows = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK');
    } else if (_activeTab === 'd1') {
      headers = ['ProcessName', 'Tipo', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'AccionSugerida'];
      rows = state.rows.d1;
    } else if (_activeTab === 'd2') {
      headers = ['ProcessName', 'Tipo', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'AccionSugerida'];
      rows = state.rows.d2;
    } else if (_activeTab === 'd3') {
      headers = ['ProcessName', 'Tipo', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'AccionSugerida'];
      rows = state.rows.d3;
    }
    if (filter) {
      rows = rows.filter(r => Object.values(r).some(v => String(v || '').toLowerCase().includes(filter)));
    }
    const max = 200;
    const view = rows.slice(0, max);
    const trs = view.map(r => {
      const cls = (r.EstadoGlobal === 'ERROR' || /^R\d+-error/.test(r.Estado || '')) ? 'pdeep-error'
                : ((r.EstadoGlobal === 'CON HALLAZGOS') || (r.Estado && r.Estado !== 'OK') || (r.EstadoCoherencia && r.EstadoCoherencia !== 'OK')) ? 'pdeep-issue' : '';
      const tds = headers.map(h => `<td>${escapeHtml(String(r[h] != null ? r[h] : ''))}</td>`).join('');
      return `<tr class="${cls}">${tds}</tr>`;
    }).join('');
    wrap.innerHTML = `
      <table>
        <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${trs || '<tr><td colspan="' + headers.length + '" style="text-align:center; color:#999; padding:10px;">Sin datos</td></tr>'}</tbody>
      </table>
      ${rows.length > max ? `<div style="color:#999; font-size:11px; margin-top:4px;">Mostrando ${max} de ${rows.length}. Exporta XLSX para el conjunto completo.</div>` : ''}
    `;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return { run, cancel, getState: () => state, VERSION };
})();

if (typeof window !== 'undefined') {
  window.ProcessDeepAudit = ProcessDeepAudit;
  try { console.log(`[SA] process-deep-audit cargado · v${ProcessDeepAudit.VERSION}`); } catch (_) {}
}
