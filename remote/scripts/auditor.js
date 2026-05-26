// Steelhead Part Number Auditor
// Analyzes PNs against configurable quality criteria
// Depends on: SteelheadAPI
//
// 2026-05-25 — refactor:
//   * runPool concurrencia 6 para GetPartNumber (antes serial)
//   * extractAuditFlags slim shape (booleans/lengths) — antes retenía nodos completos
//   * Similitud: prefilter por diferencia de longitud (descarta antes de Levenshtein)

const PNAuditor = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let stopped = false;

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

  function matchesCustomer(node, customerFilter) {
    if (!customerFilter) return true;
    const cn = node.customerByCustomerId?.name || '';
    return cn.toUpperCase().includes(customerFilter.toUpperCase());
  }

  async function fetchAllPNsWithArchived(opts) {
    const { customerFilter, searchQuery, includeArchived, onProgress } = opts;
    const all = [];
    const activeIds = new Set();
    const seenIds = new Set();
    const pageSize = 500;

    let offset = 0;
    while (!stopped) {
      const vars = { orderBy: ['ID_DESC'], offset, first: pageSize, searchQuery: searchQuery || '', includeArchived: 'NO' };
      const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        activeIds.add(n.id);
        if (matchesCustomer(n, customerFilter) && !seenIds.has(n.id)) {
          seenIds.add(n.id);
          all.push({ ...n, archivedAt: null });
        }
      }
      onProgress && onProgress(`Pase 1 (activos): ${all.length} PNs · offset ${offset}`);
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
          if (matchesCustomer(n, customerFilter) && !seenIds.has(n.id)) {
            seenIds.add(n.id);
            all.push({ ...n, archivedAt: ARCHIVED_SENTINEL });
          }
        }
        onProgress && onProgress(`Pase 1 (archivados): ${all.length} PNs · offset ${offset}`);
        if (nodes.length < pageSize) break;
        offset += pageSize;
      }
    }
    return all;
  }

  // ═══════════════════════════════════════════
  // MAIN AUDIT
  // ═══════════════════════════════════════════

  async function run(options) {
    const { selectedCriteria, searchQuery, customerFilter } = options;
    stopped = false;

    const activeCriteria = CRITERIA.filter(c => selectedCriteria.includes(c.id));
    const results = { criteria: {}, pns: [], totalAudited: 0, totalIssues: 0 };
    for (const c of activeCriteria) results.criteria[c.id] = { label: c.label, count: 0, pns: [] };

    showAuditorUI('Cargando números de parte...');

    // Fetch PNs (paginación)
    const allPNs = [];
    let offset = 0;
    while (!stopped) {
      const vars = { orderBy: ['NAME_ASC'], offset, first: 500, searchQuery: searchQuery || '' };
      const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      const active = nodes.filter(n => !n.archivedAt);

      if (customerFilter) {
        const filter = customerFilter.toUpperCase();
        for (const n of active) {
          if (n.customerByCustomerId?.name?.toUpperCase().includes(filter)) allPNs.push(n);
        }
      } else {
        allPNs.push(...active);
      }

      updateAuditorUI(`Cargando PNs... ${allPNs.length}${customerFilter ? ` (cliente: ${customerFilter})` : ''}`);
      if (nodes.length < 500) break;
      offset += 500;
    }

    if (stopped) return { ...results, stopped: true, totalAudited: 0 };

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

    // Per-PN criteria (necesitan GetPartNumber detail) — runPool concurrencia 6
    const perPNCriteria = activeCriteria.filter(c => c.check && c.id !== 'duplicates' && c.id !== 'similar');
    if (perPNCriteria.length > 0 && !stopped) {
      let processed = 0;
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
        if (processed % 10 === 0 || processed === allPNs.length) {
          const pct = Math.round((processed / allPNs.length) * 100);
          updateAuditorUI(`Auditando ${processed}/${allPNs.length} (${pct}%) — ${results.totalIssues} problemas | ⏹ para detener`, true);
        }
      }, 6);
    }

    log(`Auditor: ${results.totalAudited} auditados, ${results.totalIssues} problemas`);
    return results;
  }

  function stop() { stopped = true; }

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
      ov.innerHTML = `<div class="dl9-modal" style="background:#1a1a2e"><h2 style="color:#38bdf8">Auditor de PNs</h2><div class="dl9-bar"><div class="dl9-bar-fill" id="sa-aud-bar" style="background:#38bdf8"></div></div><div class="dl9-progress" id="sa-aud-text"></div></div>`;
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

  function getCriteria() { return CRITERIA; }

  return { run, stop, exportCSV, getCriteria, removeAuditorUI };
})();

if (typeof window !== 'undefined') window.PNAuditor = PNAuditor;
