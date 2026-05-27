// Steelhead Part Number Auditor
// Analyzes PNs against configurable quality criteria
// Depends on: SteelheadAPI
//
// 2026-05-25 — refactor:
//   * runPool concurrencia 6 para GetPartNumber (antes serial)
//   * extractAuditFlags slim shape (booleans/lengths) — antes retenía nodos completos
//   * Similitud: prefilter por diferencia de longitud (descarta antes de Levenshtein)
//
// 2026-05-26 — 0.1.42:
//   * Quita caps por count (HARD_CAP=8000/15000). El bloqueo es solo por memoria.
//   * Checkpoint en chrome.storage.local: al terminar pase 1, snapshot compacto
//     de PNs slim (~150 bytes/PN). Si guardrail dispara en pase 2, el resume
//     salta el paginado y retoma pase 2 con memoria limpia post-reload.

const PNAuditor = (() => {
  'use strict';

  const VERSION = '0.1.42';
  const RESUME_KEY = 'sa_auditor_resume';
  const RESUME_VERSION = 2; // bump si cambia la shape del snapshot

  const api = () => window.SteelheadAPI;
  const hc  = () => window.SteelheadHostCleanup || null;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let stopped = false;
  let memMonitor = null;

  // _runState lo lee onGuardrail (closure) y lo actualizan run() + runIntegrityScan
  // a medida que avanzan. Cuando guardrail dispara, serializamos lo que esté listo.
  let _runState = null;

  // ═══════════════════════════════════════════
  // CHECKPOINT — localStorage del origin de Steelhead (cap ~5-10 MB)
  // El applet corre en world:'MAIN' (sin chrome.storage). localStorage persiste
  // cross-reload del tab, scoped al origin app.gosteelhead.com.
  // Compacto: PNs en tuples [id, name, custId, custName, archived(0/1), ciJSON,
  // labelsJSON, createdAt] → ~150 bytes/PN. 10k PNs ≈ 1.5 MB. Cabe holgado.
  // ═══════════════════════════════════════════

  function _hasStorage() {
    try { return typeof localStorage !== 'undefined' && !!localStorage; }
    catch { return false; }
  }

  function loadCheckpoint() {
    if (!_hasStorage()) return null;
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      const cp = JSON.parse(raw);
      if (!cp || cp.v !== RESUME_VERSION) return null;
      return cp;
    } catch (e) {
      warn(`checkpoint load: ${e?.message || e}`);
      return null;
    }
  }

  function saveCheckpoint(state) {
    if (!_hasStorage()) return false;
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      // QuotaExceededError si el JSON pasa de ~5 MB → degradamos guardando
      // solo metadata (sin snapshot del pase 1).
      warn(`checkpoint save (probable cuota): ${e?.message || e}. Degradando a metadata.`);
      try {
        const lite = { ...state, pass1Compact: null, _degraded: true };
        localStorage.setItem(RESUME_KEY, JSON.stringify(lite));
        return true;
      } catch (e2) {
        warn(`checkpoint save lite también falló: ${e2?.message || e2}`);
        return false;
      }
    }
  }

  function clearCheckpoint() {
    if (!_hasStorage()) return;
    try { localStorage.removeItem(RESUME_KEY); }
    catch (e) { warn(`checkpoint clear: ${e?.message || e}`); }
  }

  function compactPN(p) {
    // Tupla mínima para resume. customInputs como JSON string (el módulo lo re-parsea
    // o lo lee como objeto; expandPN lo deja como objeto al rehidratar).
    const cust = p.customerByCustomerId;
    let ciStr = '';
    try { ciStr = JSON.stringify(p.customInputs || {}); } catch { ciStr = '{}'; }
    let labelNames = [];
    const lbNodes = p.partNumberLabelsByPartNumberId && p.partNumberLabelsByPartNumberId.nodes;
    if (Array.isArray(lbNodes)) {
      labelNames = lbNodes.map(n => (n && n.labelByLabelId && n.labelByLabelId.name) || '').filter(Boolean);
    }
    return [
      p.id,
      p.name || '',
      cust ? cust.id : null,
      cust ? (cust.name || '') : '',
      p.archivedAt ? (p.archivedAt === ARCHIVED_SENTINEL ? 'S' : String(p.archivedAt)) : 0,
      ciStr,
      labelNames,
      p.createdAt || null,
    ];
  }

  function expandPN(t) {
    let ci = {};
    try { ci = JSON.parse(t[5] || '{}') || {}; } catch { ci = {}; }
    const slim = {
      id: t[0],
      name: t[1] || '',
      customerByCustomerId: t[2] != null ? { id: t[2], name: t[3] || '' } : null,
      archivedAt: t[4] === 'S' ? ARCHIVED_SENTINEL : (t[4] || null),
      customInputs: ci,
      createdAt: t[7] || null,
    };
    if (Array.isArray(t[6]) && t[6].length) {
      slim.partNumberLabelsByPartNumberId = {
        nodes: t[6].map(name => ({ labelByLabelId: { name } })),
      };
    }
    return slim;
  }

  // ═══════════════════════════════════════════
  // POOL + RETRY (patrón de process-deep-audit.js)
  // ═══════════════════════════════════════════

  async function runPool(items, worker, concurrency) {
    const queue = items.slice();
    let active = 0, done = 0, idx = 0;
    return new Promise((resolve) => {
      function next() {
        if (stopped) { if (active === 0) resolve(); return; }
        while (active < concurrency && idx < queue.length) {
          const myIdx = idx++;
          const item = queue[myIdx];
          active++;
          Promise.resolve().then(() => worker(item, myIdx))
            .catch(err => { if (err?.message !== '__sa_aborted__') warn(`runPool[${myIdx}]: ${String(err?.message || err).substring(0, 120)}`); })
            .finally(() => {
              active--; done++;
              if (stopped && active === 0) { resolve(); return; }
              if (done >= queue.length && active === 0) resolve();
              else next();
            });
        }
      }
      if (!queue.length) resolve(); else next();
    });
  }

  async function withRetry(fn, label, delays = [0, 1000, 2000]) {
    let lastErr = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (stopped) throw new Error('__sa_aborted__');
      if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (attempt < delays.length - 1) warn(`${label}: intento ${attempt + 1}/${delays.length} falló · ${String(err?.message || err).substring(0, 80)}`);
      }
    }
    throw lastErr || new Error(`${label}: agotó reintentos`);
  }

  // ═══════════════════════════════════════════
  // CRITERIA DEFINITIONS — operan sobre la shape slim
  // ═══════════════════════════════════════════

  const CRITERIA = [
    // Datos básicos
    { id: 'no-process', group: 'Datos básicos', label: 'Sin proceso default', check: f => !f.hasProcess },
    { id: 'no-description', group: 'Datos básicos', label: 'Sin descripción', check: f => !f.hasDescription },
    { id: 'no-group', group: 'Datos básicos', label: 'Sin grupo/familia', check: f => !f.hasGroup },
    { id: 'no-metal', group: 'Datos básicos', label: 'Sin Metal Base', check: f => !f.hasMetal },
    { id: 'no-sat', group: 'Datos básicos', label: 'Sin Código SAT', check: f => !f.hasSat },

    // Acabados y specs
    { id: 'no-labels', group: 'Acabados y specs', label: 'Sin etiquetas/labels', check: f => f.labelsCount === 0 },
    { id: 'no-specs', group: 'Acabados y specs', label: 'Sin especificaciones', check: f => f.specsCount === 0 },
    { id: 'spec-no-param', group: 'Acabados y specs', label: 'Spec sin parámetro de espesor aplicado', check: f => f.specNoParam },
    { id: 'no-conversions', group: 'Acabados y specs', label: 'Sin conversiones de unidades', check: f => f.unitConversionsCount === 0 },
    { id: 'partial-conversions', group: 'Acabados y specs', label: 'Conversiones incompletas (tiene kg pero no lb, o viceversa)', check: f => {
      if (!f.unitConversionsCount) return false;
      const has = (id) => f.unitIds.includes(id);
      return (has(3969) && !has(3972)) || (has(3972) && !has(3969)) || (has(4907) && !has(4797)) || (has(4797) && !has(4907));
    }},

    // Dimensiones y racks
    { id: 'no-dims', group: 'Dimensiones y racks', label: 'Sin dimensiones', check: f => f.dimensionsCount === 0 },
    { id: 'no-racks', group: 'Dimensiones y racks', label: 'Sin racks asignados', check: f => f.racksCount === 0 },

    // Precios y costos
    { id: 'no-prices', group: 'Precios y costos', label: 'Sin precios', check: f => f.pricesCount === 0 },
    { id: 'no-default-price', group: 'Precios y costos', label: 'Sin precio default', check: f => f.pricesCount > 0 && !f.hasDefaultPrice },
    { id: 'no-predictive', group: 'Precios y costos', label: 'Sin consumo predictivo de materiales', check: f => f.predictiveCount === 0 },

    // Configuración
    { id: 'no-validation', group: 'Configuración', label: 'Validación de ingeniería desactivada', check: f => f.optInOutsCount === 0 },
    { id: 'no-dimensions-acct', group: 'Configuración', label: 'Sin Línea/Departamento (dim. contables)', check: f => f.dimCustomValuesCount === 0 },

    // Etiquetas especiales (labels ya viene lowercased)
    { id: 'label-muestras', group: 'Etiquetas especiales', label: 'Con etiqueta "Muestras"', check: f => f.labels.some(l => l.includes('muestra')) },
    { id: 'label-desarrollo', group: 'Etiquetas especiales', label: 'Con etiqueta "En desarrollo"', check: f => f.labels.some(l => l.includes('desarrollo')) },
    { id: 'label-desconocido', group: 'Etiquetas especiales', label: 'Con etiqueta "NP desconocido"', check: f => f.labels.some(l => l.includes('desconocido')) },

    // Integridad — tier-based duplicate detection (handled in runIntegrityScan)
    { id: 'dup-hard',   group: 'Integridad', label: 'PNs duplicados — DUROS (mismo QuoteIBMS)', check: null },
    { id: 'dup-medium', group: 'Integridad', label: 'PNs duplicados — MEDIOS (mismo metalBase + acabados + cliente)', check: null },
    { id: 'dup-soft',   group: 'Integridad', label: 'PNs duplicados — SUAVES (mismo nombre + cliente, acabados asimétricos)', check: null },
    { id: 'no-customer', group: 'Integridad', label: 'Sin cliente asignado', check: f => !f.customerId },
    { id: 'similar', group: 'Integridad', label: 'PNs por similitud de nombre (~80%)', check: null }, // ortogonal, conservado
  ];

  // ═══════════════════════════════════════════
  // SIMILARITY
  // ═══════════════════════════════════════════

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const d = Array.from({ length: m + 1 }, (_, i) => i);
    for (let j = 1; j <= n; j++) {
      let prev = d[0]; d[0] = j;
      for (let i = 1; i <= m; i++) {
        const temp = d[i];
        d[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[i], d[i - 1]);
        prev = temp;
      }
    }
    return d[m];
  }

  function similarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a.toUpperCase(), b.toUpperCase()) / maxLen;
  }

  // ═══════════════════════════════════════════
  // EXTRACT AUDIT FLAGS (slim shape — antes enrichPN retenía nodos completos)
  // ═══════════════════════════════════════════

  function extractAuditFlags(pn) {
    if (!pn) return null;
    const labelsRaw = (pn.partNumberLabelsByPartNumberId?.nodes || [])
      .map(l => (l.labelByLabelId?.name || l.name || '')).filter(Boolean);
    const labels = labelsRaw.map(s => s.toLowerCase());

    const specs = pn.partNumberSpecsByPartNumberId?.nodes || [];
    let specNoParam = false;
    for (const s of specs) {
      const specFields = s.specBySpecId?.specFieldSpecsBySpecId?.nodes || [];
      const hasEspesorField = specFields.some(sf => sf.specFieldBySpecFieldId?.name?.toLowerCase().includes('espesor'));
      if (!hasEspesorField) continue;
      const params = s.partNumberSpecFieldParamsByPartNumberSpecId?.nodes || [];
      if (params.length === 0) { specNoParam = true; break; }
    }

    const ucs = pn.inventoryItemByPartNumberId?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];
    const prices = pn.partNumberPricesByPartNumberId?.nodes || [];

    return {
      id: pn.id,
      name: pn.name,
      customer: pn.customerByCustomerId?.name || '',
      customerId: pn.customerByCustomerId?.id || null,
      createdAt: pn.createdAt,
      hasProcess: !!pn.defaultProcessNodeId,
      hasDescription: !!pn.descriptionMarkdown?.trim(),
      hasGroup: !!pn.partNumberGroupId,
      hasMetal: !!pn.customInputs?.DatosAdicionalesNP?.BaseMetal,
      hasSat: !!pn.customInputs?.DatosFacturacion?.CodigoSAT,
      labelsCount: labels.length,
      labels,
      specsCount: specs.length,
      specNoParam,
      unitConversionsCount: ucs.length,
      unitIds: ucs.map(u => u.unitId),
      dimensionsCount: (pn.partNumberDimensionsByPartNumberId?.nodes || []).length,
      racksCount: (pn.partNumberRackTypesByPartNumberId?.nodes || []).length,
      pricesCount: prices.length,
      hasDefaultPrice: prices.some(p => p.isDefault),
      predictiveCount: (pn.inventoryPredictedUsagesByPartNumberId?.nodes || []).length,
      optInOutsCount: (pn.processNodePartNumberOptInoutsByPartNumberId?.nodes || []).length,
      dimCustomValuesCount: (pn.dimensionCustomValueIds || []).length
    };
  }

  // ═══════════════════════════════════════════
  // INTEGRITY TIERS — pase 1: AllPartNumbers paginado activos + archivados
  // ═══════════════════════════════════════════

  const ARCHIVED_SENTINEL = '__archived__';

  function matchesCustomer(node, customerFilter, excludeCustomers) {
    const cn = (node.customerByCustomerId?.name || '').toUpperCase();
    if (excludeCustomers && excludeCustomers.length) {
      for (const ex of excludeCustomers) {
        if (ex && cn.includes(ex.toUpperCase())) return false;
      }
    }
    if (!customerFilter) return true;
    return cn.includes(customerFilter.toUpperCase());
  }

  // EJE A: shape slim del pase 1. Solo campos consumidos por duplicate-tiers.js
  // y por el render. Parse-once de customInputs (módulo acepta string u objeto).
  // Preserva labels en formato slim si vienen — el módulo los usa como fallback
  // cuando no hay detail (run abortado / failed fetch).
  function slimPass1Node(n, archivedAtOverride) {
    const ci = (() => {
      try { return typeof n.customInputs === 'string' ? JSON.parse(n.customInputs) : (n.customInputs || {}); }
      catch { return {}; }
    })();
    const slim = {
      id: n.id,
      name: n.name,
      customerByCustomerId: n.customerByCustomerId
        ? { id: n.customerByCustomerId.id, name: n.customerByCustomerId.name }
        : null,
      customInputs: ci,
      createdAt: n.createdAt,
      archivedAt: archivedAtOverride !== undefined ? archivedAtOverride : (n.archivedAt || null),
    };
    // Fallback de labels que duplicate-tiers.js puede leer si falta el detail.
    if (Array.isArray(n.labels)) slim.labels = n.labels.slice();
    if (n.partNumberLabelsByPartNumberId && Array.isArray(n.partNumberLabelsByPartNumberId.nodes)) {
      slim.partNumberLabelsByPartNumberId = {
        nodes: n.partNumberLabelsByPartNumberId.nodes.map(node => ({
          labelByLabelId: { name: (node && node.labelByLabelId && node.labelByLabelId.name) || '' },
        })),
      };
    }
    return slim;
  }

  async function fetchAllPNsWithArchived(opts) {
    const { customerFilter, excludeCustomers, searchQuery, includeArchived, onProgress } = opts;
    const all = [];
    const activeIds = new Set();
    const seenIds = new Set();
    const pageSize = 500;
    const drainPage = hc()?.apolloCacheDrain || (() => {});

    let offset = 0;
    while (!stopped) {
      const vars = { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: searchQuery || '', includeArchived: 'NO' };
      const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        activeIds.add(n.id);
        if (matchesCustomer(n, customerFilter, excludeCustomers) && !seenIds.has(n.id)) {
          seenIds.add(n.id);
          all.push(slimPass1Node(n, null));
        }
      }
      // EJE B: drain Apollo entre páginas — sin esto los normalized records suman MBs.
      try { drainPage(); } catch (_) {}
      onProgress && onProgress(`Pase 1 (activos): ${all.length} PNs · offset ${offset}`);
      // Sin cap por count — el guardrail de memoria es el único stop legítimo.
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    if (stopped) return all;

    if (includeArchived) {
      offset = 0;
      while (!stopped) {
        const vars = { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: searchQuery || '', includeArchived: 'YES' };
        const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
        const nodes = data?.pagedData?.nodes || [];
        for (const n of nodes) {
          if (activeIds.has(n.id)) continue;
          if (matchesCustomer(n, customerFilter, excludeCustomers) && !seenIds.has(n.id)) {
            seenIds.add(n.id);
            all.push(slimPass1Node(n, ARCHIVED_SENTINEL));
          }
        }
        try { drainPage(); } catch (_) {}
        onProgress && onProgress(`Pase 1 (archivados): ${all.length} PNs · offset ${offset}`);
        if (nodes.length < pageSize) break;
        offset += pageSize;
      }
    }
    return all;
  }

  // ═══════════════════════════════════════════
  // INTEGRITY TIERS — pase 2 + scoring + winners
  // ═══════════════════════════════════════════

  // Reduce el response de GetPartNumber a lo único que duplicate-tiers.js consume:
  // ciInputs, defaultProcessNodeId, descriptionMarkdown, partNumberGroupId,
  // dimensionCustomValueIds, label NAMES, isDefault de prices, y counts del resto.
  // Esto pasa el detail de ~30-80KB a ~1-2KB por PN — diferencia entre 400MB y
  // 10MB en runs de 5000 candidatos. Mantiene la shape nested para que el módulo
  // siga leyendo .nodes.length / .nodes.map(...) sin cambios.
  function slimDetail(raw) {
    if (!raw) return null;
    const ci = (() => {
      try { return typeof raw.customInputs === 'string' ? JSON.parse(raw.customInputs) : (raw.customInputs || {}); }
      catch { return {}; }
    })();
    const labelNodes = (raw.partNumberLabelsByPartNumberId && raw.partNumberLabelsByPartNumberId.nodes) || [];
    const priceNodes = (raw.partNumberPricesByPartNumberId && raw.partNumberPricesByPartNumberId.nodes) || [];
    const specsLen = ((raw.partNumberSpecsByPartNumberId && raw.partNumberSpecsByPartNumberId.nodes) || []).length;
    const racksLen = ((raw.partNumberRackTypesByPartNumberId && raw.partNumberRackTypesByPartNumberId.nodes) || []).length;
    const predUsagesLen = ((raw.inventoryPredictedUsagesByPartNumberId && raw.inventoryPredictedUsagesByPartNumberId.nodes) || []).length;
    const unitConvsLen = ((raw.inventoryItemByPartNumberId && raw.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId && raw.inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes) || []).length;
    return {
      customInputs: ci,
      defaultProcessNodeId: raw.defaultProcessNodeId || null,
      descriptionMarkdown: raw.descriptionMarkdown || '',
      partNumberGroupId: raw.partNumberGroupId || null,
      dimensionCustomValueIds: Array.isArray(raw.dimensionCustomValueIds) ? raw.dimensionCustomValueIds.slice() : [],
      partNumberSpecsByPartNumberId: { nodes: new Array(specsLen) },
      partNumberLabelsByPartNumberId: {
        nodes: labelNodes.map(n => ({ labelByLabelId: { name: (n && n.labelByLabelId && n.labelByLabelId.name) || '' } })),
      },
      partNumberPricesByPartNumberId: {
        nodes: priceNodes.map(n => ({ isDefault: !!(n && n.isDefault) })),
      },
      partNumberRackTypesByPartNumberId: { nodes: new Array(racksLen) },
      inventoryPredictedUsagesByPartNumberId: { nodes: new Array(predUsagesLen) },
      inventoryItemByPartNumberId: {
        inventoryItemUnitConversionsByInventoryItemId: { nodes: new Array(unitConvsLen) },
      },
    };
  }

  async function runIntegrityScan(options) {
    const { selectedTiers, customerFilter, excludeCustomers, searchQuery, includeArchived, config, resumePass1Snapshot } = options;
    const tiersMod = window.SADuplicateTiers;
    if (!tiersMod) throw new Error('SADuplicateTiers no cargado');

    const nonFinishList = config?.steelhead?.domain?.bulkUpload?.nonFinishLabelNames || [];
    const metalEquiv = config?.steelhead?.domain?.bulkUpload?.metalEquivalents || [];

    // ── Pase 1 — desde snapshot si hay resume, si no fetch en vivo ──
    let allPNs;
    if (resumePass1Snapshot && Array.isArray(resumePass1Snapshot) && resumePass1Snapshot.length) {
      updateAuditorUI(`Pase 1: rehidratando ${resumePass1Snapshot.length} PNs del checkpoint...`);
      allPNs = resumePass1Snapshot.map(expandPN);
      log(`Pase 1 (resume): ${allPNs.length} PNs rehidratados`);
    } else {
      updateAuditorUI('Pase 1: cargando PNs (activos+archivados)...');
      allPNs = await fetchAllPNsWithArchived({
        customerFilter, excludeCustomers, searchQuery, includeArchived,
        onProgress: (msg) => updateAuditorUI(msg)
      });
      if (stopped) return {
        stopped: true,
        hardBuckets: [], mediumBuckets: [], softBuckets: [],
        totalPNs: allPNs.length, failedIds: [],
        processedInPass2: 0, totalCandidatesPass2: 0,
        abortedInPass: 1,
      };
      log(`Pase 1: ${allPNs.length} PNs cargados`);
      // Snapshot listo para checkpoint si el guardrail dispara durante pase 2.
      if (_runState) {
        _runState.pass1Compact = allPNs.map(compactPN);
        _runState.phase = 'pass1-done';
      }
    }

    // ── Bucketización pase 1 ──
    const hard = selectedTiers.includes('dup-hard') ? tiersMod.hardBuckets(allPNs) : [];
    const usedIds = new Set();
    for (const b of hard) for (const m of b.members) usedIds.add(m.id);

    const remainingForMedSoft = allPNs.filter(p => !usedIds.has(p.id));
    const medCands = (selectedTiers.includes('dup-medium') || selectedTiers.includes('dup-soft'))
      ? tiersMod.mediumBucketsCandidates(remainingForMedSoft)
      : [];

    // ── Pase 2: GetPartNumber a candidatos únicos ──
    const candidateIds = new Set();
    for (const b of hard) for (const m of b.members) candidateIds.add(m.id);
    for (const b of medCands) for (const m of b.members) candidateIds.add(m.id);

    log(`Pase 2: ${candidateIds.size} candidatos a enriquecer (de ${allPNs.length} totales)`);
    updateAuditorUI(`Pase 2: enriqueciendo ${candidateIds.size} candidatos...`, true);
    if (_runState) _runState.phase = 'pass2';

    const detailsByPnId = {};
    const failedIds = new Set();
    let processed = 0;
    const totalCandidatesPass2 = candidateIds.size;
    const drainTier = hc()?.makePeriodicDrain(50) || (() => {});
    await runPool([...candidateIds], async (pnId) => {
      if (stopped) return;
      try {
        const d = await withRetry(
          () => api().query('GetPartNumber', { partNumberId: pnId, usagesLimit: 100, usagesOffset: 0 }),
          `audit-tier ${pnId}`
        );
        // EJE A: slim shape — ver `slimDetail`. Sin esto el Map retiene ~80KB×N.
        detailsByPnId[pnId] = slimDetail(d?.partNumberById);
      } catch (e) {
        if (e?.message === '__sa_aborted__') return;
        failedIds.add(pnId);
        warn(`GetPartNumber ${pnId}: ${String(e).substring(0, 80)}`);
      }
      processed++;
      try { drainTier(); } catch (_) {}
      if (processed % 10 === 0 || processed === candidateIds.size) {
        updateAuditorUI(`Pase 2: ${processed}/${candidateIds.size} (${failedIds.size} fallaron)`, true);
      }
    }, 6);
    const processedInPass2 = processed;
    const wasStoppedInPass2 = stopped;
    // Cuando se aborta en pase 2, igual seguimos al refinamiento con los detalles
    // que SÍ obtuvimos antes del abort. El módulo tolera detalles faltantes
    // (fallback a pn.labels / pn.customInputs) y marca scoreParcial en el bucket.
    // El caller decide qué hacer con `stopped: true` en el return.

    // ── Refinamiento + scoring + winners ──
    const allPnsById = {};
    for (const p of allPNs) allPnsById[p.id] = p;

    function buildBucketWithScores(rawBucket, tier) {
      const members = rawBucket.members.map(pn => {
        const det = detailsByPnId[pn.id];
        const score = tiersMod.scoreFor(pn, det, { nonFinishLabelNames: nonFinishList });
        const ci = (() => { try { return typeof pn.customInputs === 'string' ? JSON.parse(pn.customInputs) : (pn.customInputs || {}); } catch { return {}; } })();
        return {
          id: pn.id,
          name: pn.name,
          customer: pn.customerByCustomerId?.name || '',
          customerId: pn.customerByCustomerId?.id || null,
          quoteIBMS: ci.DatosAdicionalesNP?.QuoteIBMS || '',
          metalBase: ci.DatosAdicionalesNP?.BaseMetal || '',
          createdAt: pn.createdAt,
          archived: !!pn.archivedAt,
          score,
          scoreParcial: !det && failedIds.has(pn.id),
          // EJE A: no retener `det` — el render no lo necesita y el detail completo de
          // GetPartNumber (relations + processNodes anidados) pesa MB en buckets grandes.
        };
      });
      const bucket = { tier, ...rawBucket, members };
      bucket.winnerId = tiersMod.pickWinner(bucket);
      bucket.deleteCandidates = tiersMod.computeDeleteCandidates(bucket);
      return bucket;
    }

    const hardBuckets = hard.map(b => buildBucketWithScores(b, 'DURO'));

    const medium = selectedTiers.includes('dup-medium')
      ? tiersMod.refineMediumBuckets(medCands, detailsByPnId, { nonFinishLabelNames: nonFinishList, metalEquivalents: metalEquiv })
      : [];
    const mediumIds = new Set();
    for (const b of medium) for (const m of b.members) mediumIds.add(m.id);
    const mediumBuckets = medium.map(b => buildBucketWithScores(b, 'MEDIO'));

    const softCandsRemaining = selectedTiers.includes('dup-soft')
      ? medCands
          .map(c => ({ ...c, members: c.members.filter(m => !mediumIds.has(m.id)) }))
          .filter(c => c.members.length >= 2)
      : [];
    const softRefined = selectedTiers.includes('dup-soft')
      ? tiersMod.refineSoftBuckets(softCandsRemaining, detailsByPnId, { nonFinishLabelNames: nonFinishList })
      : [];
    const softBuckets = softRefined.map(b => buildBucketWithScores(b, 'SUAVE'));

    // EJE A: liberar mapas grandes ya consumidos (refineMedium/Soft + buildBucket
    // ya extrajeron lo slim). Los buckets retornados no referencian detailsByPnId.
    for (const k of Object.keys(detailsByPnId)) detailsByPnId[k] = null;
    candidateIds.clear();

    return {
      hardBuckets, mediumBuckets, softBuckets,
      totalPNs: allPNs.length,
      failedIds: [...failedIds],
      stopped: wasStoppedInPass2,
      processedInPass2,
      totalCandidatesPass2,
    };
  }

  // ═══════════════════════════════════════════
  // MAIN AUDIT
  // ═══════════════════════════════════════════

  async function run(options) {
    const { selectedCriteria, searchQuery, customerFilter, excludeCustomers } = options;
    stopped = false;
    const config = options.config || (typeof window !== 'undefined' ? window.REMOTE_CONFIG : null);

    const activeCriteria = CRITERIA.filter(c => selectedCriteria.includes(c.id));
    const results = { criteria: {}, pns: [], totalAudited: 0, totalIssues: 0 };
    for (const c of activeCriteria) results.criteria[c.id] = { label: c.label, count: 0, pns: [] };

    showAuditorUI('Cargando números de parte...');

    // Resume desde checkpoint si el caller lo pidió. resumePass1Snapshot llega
    // como array compacto desde background.js (ya leído de chrome.storage.local).
    const resumePass1Snapshot = Array.isArray(options.resumePass1Snapshot)
      ? options.resumePass1Snapshot
      : null;
    if (resumePass1Snapshot) {
      log(`Resume detectado: ${resumePass1Snapshot.length} PNs en snapshot`);
    }

    // _runState: lo lee onGuardrail por closure. Mantiene la metadata del run y
    // el snapshot del pase 1 una vez termina, para persistir si hay guardrail.
    _runState = {
      v: RESUME_VERSION,
      ts: Date.now(),
      options: {
        selectedCriteria: [...selectedCriteria],
        searchQuery: searchQuery || '',
        customerFilter: customerFilter || '',
        excludeCustomers: excludeCustomers ? [...excludeCustomers] : [],
        includeArchived: options.includeArchived !== false,
      },
      phase: 'pass1', // 'pass1' | 'pass1-done' | 'pass2' | 'done'
      pass1Compact: null,
    };

    // ─── EJE B: Host memory hardening ────────────────────────────
    // Datadog RUM + Apollo cache acumulan cientos de MB en runs largos.
    // Disparamos stop UNA vez al iniciar trabajo real (no al cargar el applet).
    if (hc()) {
      try { hc().stopDatadogSessionReplay(); } catch (_) { /* defensa */ }
      if (!memMonitor) {
        memMonitor = hc().createMemMonitor({
          getElement: () => document.getElementById('sa-aud-mem'),
          onGuardrail: (pct) => {
            warn(`Memoria al ${pct}% — persistiendo avance y abortando`);
            stopped = true;
            // Persistir checkpoint con lo que esté disponible. Si pase 1 terminó,
            // guardamos el snapshot compacto. Si no, solo opciones (al menos
            // se restauran las selecciones del modal).
            try {
              if (_runState) {
                saveCheckpoint({
                  v: _runState.v,
                  ts: _runState.ts,
                  abortedAt: Date.now(),
                  abortPct: pct,
                  phase: _runState.phase,
                  options: _runState.options,
                  pass1Compact: _runState.pass1Compact || null,
                });
              }
            } catch (e) { warn(`save checkpoint: ${e?.message || e}`); }
            const hasSnapshot = !!(_runState && _runState.pass1Compact && _runState.pass1Compact.length);
            const msg = hasSnapshot
              ? `⚠ Memoria al ${pct}%. El auditor guardó el snapshot del pase 1 (${_runState.pass1Compact.length} PNs). Recarga la pestaña y vuelve a abrir el auditor para reanudar.`
              : `⚠ Memoria al ${pct}%. El auditor abortó durante el pase 1; tus selecciones quedaron guardadas. Recarga la pestaña y abre el auditor para retomar.`;
            try { alert(msg); } catch (_) {}
          },
        });
      }
      try { memMonitor.start(); } catch (_) {}
    }

    // EJE A: skip del fetch global cuando solo hay tier criteria. runIntegrityScan
    // pagina su propio set (con archivados), así que esto era DOBLE paginación de
    // miles de PNs — la causa raíz del OOM en 1.5.3. Si seleccionaste solo
    // dup-hard/medium/soft, allPNs queda vacío y el flujo se va directo al
    // bloque de Integrity tiers más abajo.
    const TIER_ONLY = new Set(['dup-hard', 'dup-medium', 'dup-soft']);
    const needsGlobalPNs = selectedCriteria.some(c => !TIER_ONLY.has(c));

    const allPNs = [];
    if (needsGlobalPNs) {
      const drainPage = hc()?.apolloCacheDrain || (() => {});
      let offset = 0;
      while (!stopped) {
        const vars = { orderBy: ['NAME_ASC'], offset, first: 500, searchQuery: searchQuery || '' };
        const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
        const nodes = data?.pagedData?.nodes || [];
        const active = nodes.filter(n => !n.archivedAt);

        // EJE A: slim node — solo {id, name, customerByCustomerId} se lee downstream.
        for (const n of active) {
          if (!matchesCustomer(n, customerFilter, excludeCustomers)) continue;
          allPNs.push({
            id: n.id,
            name: n.name,
            customerByCustomerId: n.customerByCustomerId
              ? { id: n.customerByCustomerId.id, name: n.customerByCustomerId.name }
              : null,
          });
        }

        // EJE B: drenar Apollo cache cada página — sin esto, los normalized records
        // de cada AllPartNumbers persisten en window.__APOLLO_CLIENT__ y suman MBs.
        try { drainPage(); } catch (_) {}

        const filterTxt = customerFilter ? ` (cliente: ${customerFilter})` : '';
        const exclTxt = (excludeCustomers && excludeCustomers.length) ? ` (excluyendo ${excludeCustomers.length})` : '';
        updateAuditorUI(`Cargando PNs... ${allPNs.length}${filterTxt}${exclTxt}`);

        // Sin cap por count — el bloqueo es solo por guardrail de memoria.
        if (nodes.length < 500) break;
        offset += 500;
      }
    }

    if (stopped) { try { memMonitor?.stop(); } catch (_) {} return { ...results, stopped: true, totalAudited: 0 }; }

    log(`Auditor: ${allPNs.length} PNs a auditar, ${activeCriteria.length} criterios`);
    updateAuditorUI(`${allPNs.length} PNs. Auditando (concurrencia 6)...`);

    // Duplicate checks (no necesitan GetPartNumber)
    const checkDuplicates = selectedCriteria.includes('duplicates');
    const checkSimilar = selectedCriteria.includes('similar');
    if (checkDuplicates || checkSimilar) {
      updateAuditorUI('Verificando duplicados...');
      const nameMap = new Map();
      for (const pn of allPNs) {
        const name = pn.name?.toUpperCase();
        if (!nameMap.has(name)) nameMap.set(name, []);
        nameMap.get(name).push(pn);
      }

      if (checkDuplicates) {
        for (const [, pns] of nameMap) {
          if (pns.length > 1) {
            results.criteria['duplicates'].count += pns.length;
            for (const p of pns) results.criteria['duplicates'].pns.push({ id: p.id, name: p.name, customer: p.customerByCustomerId?.name || '' });
          }
        }
      }

      if (checkSimilar) {
        // Prefilter por longitud: si |len(a)-len(b)| / max > 0.2 ya no puede pasar el 80%
        const names = [...new Set(allPNs.map(p => p.name).filter(Boolean))];
        // Ordenar por longitud acelera el corte temprano
        names.sort((a, b) => a.length - b.length);
        let comparisons = 0, skipped = 0;
        for (let i = 0; i < names.length && !stopped; i++) {
          if (i % 100 === 0) updateAuditorUI(`Similitud: ${i}/${names.length} (${comparisons} comparados, ${skipped} descartados)...`);
          const a = names[i], aLen = a.length;
          const aUpper = a.toUpperCase();
          for (let j = i + 1; j < names.length; j++) {
            const b = names[j], bLen = b.length;
            const maxLen = Math.max(aLen, bLen);
            // Si la diferencia de longitud ya consume >20% del max, similitud no puede ≥ 0.8
            if ((bLen - aLen) > maxLen * 0.2) { skipped += (names.length - j); break; } // names ordenados: todos los siguientes son ≥ bLen
            if (a === b) continue;
            const sim = 1 - levenshtein(aUpper, b.toUpperCase()) / maxLen;
            comparisons++;
            if (sim >= 0.8) {
              results.criteria['similar'].count++;
              results.criteria['similar'].pns.push({ id: null, name: `${a} ≈ ${b}`, customer: '', similarity: Math.round(sim * 100) + '%' });
            }
          }
        }
        log(`Auditor: similitud comparó ${comparisons} pares (descartó ${skipped} por prefilter de longitud)`);
      }
    }

    // Integrity tiers (dup-hard / dup-medium / dup-soft) — runIntegrityScan
    const tierCriteria = ['dup-hard', 'dup-medium', 'dup-soft'];
    const selectedTierCrit = selectedCriteria.filter(c => tierCriteria.includes(c));
    let integrityResult = null;
    if (selectedTierCrit.length > 0) {
      integrityResult = await runIntegrityScan({
        selectedTiers: selectedTierCrit,
        customerFilter,
        excludeCustomers,
        searchQuery,
        includeArchived: options.includeArchived !== false, // default ON
        config,
        resumePass1Snapshot,
      });
      results.integrity = integrityResult;
      if (integrityResult?.stopped) {
        // El integrity ya trae buckets parciales + processedInPass2/total. Marcamos
        // results.stopped y dejamos que el caller renderice el panel parcial.
        results.stopped = true;
      }
      for (const c of selectedTierCrit) {
        const key = c === 'dup-hard' ? 'hardBuckets' : c === 'dup-medium' ? 'mediumBuckets' : 'softBuckets';
        const buckets = integrityResult[key] || [];
        results.criteria[c].count = buckets.reduce((acc, b) => acc + b.members.length, 0);
        // tarjetas detalladas se renderizan separadas en Task 13; aquí solo el conteo
      }
    }

    // Per-PN criteria (necesitan GetPartNumber detail) — runPool concurrencia 6
    const perPNCriteria = activeCriteria.filter(c => c.check && c.id !== 'duplicates' && c.id !== 'similar');
    if (perPNCriteria.length > 0 && !stopped) {
      let processed = 0;
      const drainPerPN = hc()?.makePeriodicDrain(50) || (() => {});
      await runPool(allPNs, async (pn) => {
        if (stopped) return;
        try {
          const detail = await withRetry(
            () => api().query('GetPartNumber', { partNumberId: pn.id, usagesLimit: 0, usagesOffset: 0 }),
            `audit ${pn.name}`
          );
          const flags = extractAuditFlags(detail?.partNumberById);
          if (flags) {
            for (const c of perPNCriteria) {
              if (c.check(flags)) {
                // JS single-threaded entre awaits: push es safe sin lock
                results.criteria[c.id].count++;
                results.criteria[c.id].pns.push({
                  id: flags.id, name: flags.name, customer: flags.customer, createdAt: flags.createdAt
                });
                results.totalIssues++;
              }
            }
          }
        } catch (e) {
          if (e?.message === '__sa_aborted__') return;
          warn(`Auditar ${pn.name}: ${String(e).substring(0, 60)}`);
        }
        processed++;
        results.totalAudited = processed;
        try { drainPerPN(); } catch (_) {}
        if (processed % 10 === 0 || processed === allPNs.length) {
          const pct = Math.round((processed / allPNs.length) * 100);
          updateAuditorUI(`Auditando ${processed}/${allPNs.length} (${pct}%) — ${results.totalIssues} problemas | ⏹ para detener`, true);
        }
      }, 6);
    }

    log(`Auditor: ${results.totalAudited} auditados, ${results.totalIssues} problemas`);
    try { memMonitor?.stop(); } catch (_) {}
    // Run terminó sin abort por memoria → checkpoint ya no aplica.
    if (!results.stopped) {
      try { clearCheckpoint(); } catch (_) {}
      if (_runState) _runState.phase = 'done';
    }
    return results;
  }

  function stop() {
    stopped = true;
    try { memMonitor?.stop(); } catch (_) {}
  }

  // ═══════════════════════════════════════════
  // EXPORT CSV
  // ═══════════════════════════════════════════

  function exportCSV(results) {
    const pnIssues = new Map();
    for (const [, data] of Object.entries(results.criteria)) {
      for (const pn of (data.pns || [])) {
        if (!pn.id) continue;
        if (!pnIssues.has(pn.id)) pnIssues.set(pn.id, { ...pn, issues: [] });
        pnIssues.get(pn.id).issues.push(data.label);
      }
    }

    const rows = [['Número de parte', 'Cliente', 'Creado', 'Problemas encontrados', 'Criterios'].join(',')];
    for (const [, pn] of pnIssues) {
      rows.push([
        `"${pn.name}"`,
        `"${pn.customer || ''}"`,
        `"${pn.createdAt ? new Date(pn.createdAt).toLocaleDateString('es-MX') : ''}"`,
        pn.issues.length,
        `"${pn.issues.join('; ')}"`
      ].join(','));
    }

    const csv = rows.join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria_pn_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return pnIssues.size;
  }

  // ═══════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════

  function showAuditorUI(msg) {
    let ov = document.getElementById('sa-auditor-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-auditor-overlay';
      ov.className = 'dl9-overlay';
      ov.innerHTML = `<div class="dl9-modal" style="background:#1a1a2e"><h2 style="color:#38bdf8">Auditor de PNs</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-aud-bar" style="background:#38bdf8"></div></div><div class="dl9-progress" id="sa-aud-text"></div><div id="sa-aud-mem" style="margin-top:8px;font-family:ui-monospace,monospace;font-size:11px;color:#94a3b8"></div><style>#sa-aud-mem.sa-mem-warn{color:#fde68a}#sa-aud-mem.sa-mem-crit{color:#fca5a5;font-weight:600}</style></div>`;
      document.body.appendChild(ov);
    }
    document.getElementById('sa-aud-text').textContent = msg;
  }

  function updateAuditorUI(msg, showStop) {
    const el = document.getElementById('sa-aud-text');
    if (el) el.textContent = msg;
    if (showStop && !document.getElementById('sa-aud-stop')) {
      const modal = el?.closest('.dl9-modal');
      if (modal) {
        const btn = document.createElement('button');
        btn.id = 'sa-aud-stop';
        btn.className = 'dl9-btn';
        btn.style.cssText = 'background:#ef4444;color:white;margin-top:10px;padding:8px 16px;font-size:12px';
        btn.textContent = '⏹ Detener y obtener resultados parciales';
        btn.onclick = () => { stopped = true; btn.textContent = 'Deteniendo...'; btn.disabled = true; };
        modal.appendChild(btn);
      }
    }
  }

  function removeAuditorUI() {
    const ov = document.getElementById('sa-auditor-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // ═══════════════════════════════════════════
  // RENDER — bucket cards (Task 13)
  // ═══════════════════════════════════════════

  function renderIntegrityResults(integrity) {
    if (!integrity) return '';
    const tiers = [
      { key: 'hardBuckets',   label: '🚨 DUROS (mismo QuoteIBMS)',                              color: '#fca5a5' },
      { key: 'mediumBuckets', label: '⚠ MEDIOS (mismo metalBase + acabados + cliente)',         color: '#fde68a' },
      { key: 'softBuckets',   label: 'ⓘ SUAVES (asimetría de acabados)',                        color: '#bae6fd' },
    ];

    // Banner de estado del scan (parcial / completo / con fallos)
    let banner = '';
    const isPartial = !!integrity.stopped;
    const processed = integrity.processedInPass2 ?? 0;
    const totalCands = integrity.totalCandidatesPass2 ?? 0;
    const failedCount = (integrity.failedIds || []).length;
    if (isPartial) {
      const where = integrity.abortedInPass === 1
        ? 'durante la carga inicial (pase 1) — ningún candidato alcanzó a enriquecerse'
        : `después de procesar ${processed}/${totalCands} candidatos del pase 2`;
      banner = `<div style="background:#7c2d12;color:#fed7aa;padding:10px 14px;border-radius:6px;margin-bottom:12px;border-left:4px solid #f59e0b">
        ⏸ <b>Run abortado por memoria</b> ${where}. Los buckets de abajo (si hay) son PARCIALES — pueden faltar duplicados sin verificar. Recarga la tab y re-corre con filtro por cliente para reducir el alcance.
      </div>`;
    } else if (totalCands > 0) {
      const failPart = failedCount > 0 ? ` · ${failedCount} con error de fetch` : '';
      banner = `<div style="color:#94a3b8;font-size:12px;margin-bottom:10px">Pase 2 completo: ${processed}/${totalCands} candidatos enriquecidos${failPart}.</div>`;
    }

    let html = '';
    for (const t of tiers) {
      const buckets = integrity[t.key] || [];
      if (!buckets.length) continue;
      const totalPns = buckets.reduce((a, b) => a + b.members.length, 0);
      html += `<details open style="margin-top:14px"><summary style="color:${t.color};cursor:pointer;font-weight:600">${t.label} — ${buckets.length} buckets · ${totalPns} PNs</summary>`;
      for (const b of buckets) html += renderBucketCard(b);
      html += '</details>';
    }
    if (!html) {
      // Cuando hubo abort, NO afirmar "sin duplicados" — pudo haber duplicados
      // en los candidatos que no alcanzamos a procesar.
      if (isPartial) {
        return banner + `<div style="color:#fed7aa;padding:12px 0">No se detectaron duplicados en los ${processed} candidatos procesados. <b>El resto quedó sin verificar</b> por el abort de memoria.</div>`;
      }
      return banner + '<div style="color:#86efac;padding:12px 0">✓ Sin duplicados detectados en los tiers seleccionados.</div>';
    }
    const totalLosers = sumLosers(integrity);
    const totalDelete = sumDelete(integrity);
    html += `<div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="sa-aud-btn" id="sa-int-archive-all" style="background:#16a34a;color:white;padding:8px 14px;border:none;border-radius:6px;cursor:pointer;font-size:12px">Archivar TODOS los descartados (${totalLosers})</button>
      <button class="sa-aud-btn" id="sa-int-csv-delete" style="background:#dc2626;color:white;padding:8px 14px;border:none;border-radius:6px;cursor:pointer;font-size:12px">📋 CSV candidatos a DELETE (${totalDelete})</button>
      <button class="sa-aud-btn" id="sa-int-json-full" style="background:#475569;color:white;padding:8px 14px;border:none;border-radius:6px;cursor:pointer;font-size:12px">💾 JSON audit</button>
    </div>`;
    return banner + html;
  }

  function renderBucketCard(b) {
    const bucketKey = bucketKeyForCSV(b);
    const headerExtra = b.deleteCandidates && b.deleteCandidates.length
      ? `<span style="color:#fca5a5">🚨 ${b.deleteCandidates.length} candidato(s) a DELETE</span>` : '';
    const rows = b.members.map(m => {
      const isWinner = m.id === b.winnerId;
      const ageDays = m.createdAt ? Math.floor((Date.now() - new Date(m.createdAt).getTime()) / 86400000) : '?';
      const status = m.archived
        ? '<span style="color:#fca5a5">archivado</span>'
        : '<span style="color:#86efac">activo</span>';
      const partial = m.scoreParcial
        ? '<span title="datos incompletos (GetPartNumber falló)" style="color:#fde68a">⚠ parcial</span>' : '';
      return `<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:${isWinner ? '#1e293b' : 'transparent'};border-radius:4px">
        <input type="radio" name="winner-${b.tier}-${escapeAttr(bucketKey)}" value="${m.id}" ${isWinner ? 'checked' : ''}>
        <code style="color:#cbd5e1">PN-${m.id}</code>
        <span>${escapeHtml(m.name)}</span>
        <span style="color:#94a3b8">${escapeHtml(m.customer)}</span>
        <span style="color:#a5b4fc">score ${m.score}</span>
        ${status}
        <span style="color:#94a3b8">${ageDays}d</span>
        ${partial}
      </label>`;
    }).join('');
    return `<div class="sa-int-bucket" data-bucket-key="${escapeAttr(bucketKey)}" data-tier="${b.tier}" style="border:1px solid #334155;border-radius:6px;padding:10px;margin-top:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
        <div style="color:#e2e8f0"><b>${b.tier}</b> · ${escapeHtml(humanBucketKey(b))} ${headerExtra}</div>
        <label style="font-size:11px;color:#94a3b8"><input type="checkbox" class="sa-int-apply" checked> Aplicar acción</label>
      </div>
      ${rows}
    </div>`;
  }

  function bucketKeyForCSV(b) {
    if (b.tier === 'DURO') return 'quoteIBMS=' + b.quoteIBMS;
    if (b.tier === 'MEDIO') return [b.name, b.customerId, b.metalBase, b.finishings].join('||');
    return [b.name, b.customerId].join('||');
  }
  function humanBucketKey(b) {
    if (b.tier === 'DURO') return 'QuoteIBMS ' + b.quoteIBMS;
    if (b.tier === 'MEDIO') return `${b.name} · cust ${b.customerId} · ${b.metalBase || '∅'} · [${b.finishings || '∅'}]`;
    return `${b.name} · cust ${b.customerId}`;
  }
  function sumLosers(integ) {
    return [...(integ.hardBuckets || []), ...(integ.mediumBuckets || []), ...(integ.softBuckets || [])]
      .reduce((a, b) => a + b.members.filter(m => m.id !== b.winnerId).length, 0);
  }
  function sumDelete(integ) {
    return [...(integ.hardBuckets || []), ...(integ.mediumBuckets || []), ...(integ.softBuckets || [])]
      .reduce((a, b) => a + ((b.deleteCandidates || []).length), 0);
  }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-z0-9_-]/gi, '\\$&'); }

  // ═══════════════════════════════════════════
  // ARCHIVE LOSERS (Task 14)
  // ═══════════════════════════════════════════

  async function archiveLosers(integrity, onProgress) {
    const tasks = [];
    for (const tierKey of ['hardBuckets', 'mediumBuckets', 'softBuckets']) {
      for (const b of (integrity[tierKey] || [])) {
        // Lee selección actualizada del DOM si la tarjeta existe; si no, usa winnerId del bucket.
        const card = document.querySelector(`.sa-int-bucket[data-bucket-key="${cssEscape(bucketKeyForCSV(b))}"]`);
        if (card && !card.querySelector('.sa-int-apply')?.checked) continue;
        let winnerId = b.winnerId;
        if (card) {
          const chosen = Number(card.querySelector('input[type=radio]:checked')?.value);
          if (!isNaN(chosen)) winnerId = chosen;
        }
        for (const m of b.members) {
          if (m.id === winnerId) continue;
          if (m.archived) { tasks.push({ id: m.id, name: m.name, skip: true }); continue; }
          tasks.push({ id: m.id, name: m.name });
        }
      }
    }
    let ok = 0, skipped = 0, failed = 0;
    const failures = [];
    const succeededIds = [];
    const drainArchive = hc()?.makePeriodicDrain(50) || (() => {});
    await runPool(tasks, async (t) => {
      if (t.skip) { skipped++; onProgress && onProgress(ok, skipped, failed, tasks.length); return; }
      try {
        await withRetry(
          () => api().query('UpdatePartNumber', { id: t.id, archivedAt: new Date().toISOString() }),
          `archive ${t.name}`
        );
        ok++;
        succeededIds.push(t.id);
      } catch (e) {
        failed++;
        failures.push({ id: t.id, name: t.name, error: String(e?.message || e).substring(0, 120) });
      }
      try { drainArchive(); } catch (_) {}
      onProgress && onProgress(ok, skipped, failed, tasks.length);
    }, 5);
    return { ok, skipped, failed, failures, succeededIds, totalAttempted: tasks.length };
  }

  // ═══════════════════════════════════════════
  // CSV/JSON EXPORT (Task 15)
  // ═══════════════════════════════════════════

  function buildDeleteCSV(integrity) {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [[
      'tier', 'bucketKey', 'pnId', 'pnName', 'customer', 'customerId',
      'quoteIBMS', 'metalBase', 'finishings', 'status',
      'createdAt', 'score', 'winnerPnId', 'razon'
    ].join(',')];
    for (const tierKey of ['hardBuckets', 'mediumBuckets', 'softBuckets']) {
      for (const b of (integrity[tierKey] || [])) {
        for (const id of (b.deleteCandidates || [])) {
          const m = b.members.find(x => x.id === id);
          if (!m) continue;
          const razon = b.tier === 'DURO'
            ? `DURO: comparte QuoteIBMS ${b.quoteIBMS}`
            : `${b.tier} sin QuoteIBMS: bucket ${humanBucketKey(b)}`;
          const status = m.archived ? 'archived' : 'active';
          rows.push([
            b.tier,
            q(bucketKeyForCSV(b)),
            m.id,
            q(m.name),
            q(m.customer),
            m.customerId ?? '',
            q(m.quoteIBMS || ''),
            q(m.metalBase || ''),
            q(b.finishings || ''),
            status,
            q(m.createdAt || ''),
            m.score,
            b.winnerId,
            q(razon),
          ].join(','));
        }
      }
    }
    return rows.join('\n');
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob(['﻿' + content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function getCriteria() { return CRITERIA; }

  return {
    VERSION,
    run, stop, exportCSV, getCriteria, removeAuditorUI,
    renderIntegrityResults, archiveLosers, buildDeleteCSV, downloadBlob,
    bucketKeyForCSV, cssEscape,
    loadCheckpoint, clearCheckpoint, expandPN,
  };
})();

if (typeof window !== 'undefined') window.PNAuditor = PNAuditor;
