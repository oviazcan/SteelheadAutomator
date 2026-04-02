// Steelhead Part Number Auditor
// Analyzes PNs against configurable quality criteria
// Depends on: SteelheadAPI

const PNAuditor = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let stopped = false;

  // ═══════════════════════════════════════════
  // CRITERIA DEFINITIONS
  // ═══════════════════════════════════════════

  const CRITERIA = [
    // Datos básicos
    { id: 'no-process', group: 'Datos básicos', label: 'Sin proceso default', check: pn => !pn.defaultProcessNodeId },
    { id: 'no-description', group: 'Datos básicos', label: 'Sin descripción', check: pn => !pn.descriptionMarkdown?.trim() },
    { id: 'no-group', group: 'Datos básicos', label: 'Sin grupo/familia', check: pn => !pn.partNumberGroupId },
    { id: 'no-metal', group: 'Datos básicos', label: 'Sin Metal Base', check: pn => !pn.customInputs?.DatosAdicionalesNP?.BaseMetal },
    { id: 'no-sat', group: 'Datos básicos', label: 'Sin Código SAT', check: pn => !pn.customInputs?.DatosFacturacion?.CodigoSAT },

    // Acabados y specs
    { id: 'no-labels', group: 'Acabados y specs', label: 'Sin etiquetas/labels', check: pn => !(pn._labels?.length > 0) },
    { id: 'no-specs', group: 'Acabados y specs', label: 'Sin especificaciones', check: pn => !(pn._specs?.length > 0) },
    { id: 'spec-no-param', group: 'Acabados y specs', label: 'Spec sin parámetro de espesor aplicado', check: pn => {
      if (!pn._specs?.length) return false;
      // Has spec but spec fields may lack applied params
      return pn._specs.some(s => s._hasEspesorField && !s._hasEspesorParam);
    }},
    { id: 'no-conversions', group: 'Acabados y specs', label: 'Sin conversiones de unidades', check: pn => !(pn._unitConversions?.length > 0) },
    { id: 'partial-conversions', group: 'Acabados y specs', label: 'Conversiones incompletas (tiene kg pero no lb, o viceversa)', check: pn => {
      const ucs = pn._unitConversions || [];
      if (!ucs.length) return false;
      const hasKGM = ucs.some(u => u.unitId === 3969);
      const hasLBR = ucs.some(u => u.unitId === 3972);
      const hasCMK = ucs.some(u => u.unitId === 4907);
      const hasFTK = ucs.some(u => u.unitId === 4797);
      return (hasKGM && !hasLBR) || (hasLBR && !hasKGM) || (hasCMK && !hasFTK) || (hasFTK && !hasCMK);
    }},

    // Dimensiones y racks
    { id: 'no-dims', group: 'Dimensiones y racks', label: 'Sin dimensiones', check: pn => !(pn._dimensions?.length > 0) },
    { id: 'no-racks', group: 'Dimensiones y racks', label: 'Sin racks asignados', check: pn => !(pn._racks?.length > 0) },

    // Precios y costos
    { id: 'no-prices', group: 'Precios y costos', label: 'Sin precios', check: pn => !(pn._prices?.length > 0) },
    { id: 'no-default-price', group: 'Precios y costos', label: 'Sin precio default', check: pn => {
      if (!pn._prices?.length) return false;
      return !pn._prices.some(p => p.isDefault);
    }},
    { id: 'no-predictive', group: 'Precios y costos', label: 'Sin consumo predictivo de materiales', check: pn => !(pn._predictiveUsages?.length > 0) },

    // Configuración
    { id: 'no-validation', group: 'Configuración', label: 'Validación de ingeniería desactivada', check: pn => !(pn._optInOuts?.length > 0) },
    { id: 'no-dimensions-acct', group: 'Configuración', label: 'Sin Línea/Departamento (dim. contables)', check: pn => !(pn._dimCustomValues?.length > 0) },

    // Etiquetas especiales
    { id: 'label-muestras', group: 'Etiquetas especiales', label: 'Con etiqueta "Muestras"', check: pn => pn._labels?.some(l => l.toLowerCase().includes('muestra')) },
    { id: 'label-desarrollo', group: 'Etiquetas especiales', label: 'Con etiqueta "En desarrollo"', check: pn => pn._labels?.some(l => l.toLowerCase().includes('desarrollo')) },
    { id: 'label-desconocido', group: 'Etiquetas especiales', label: 'Con etiqueta "NP desconocido"', check: pn => pn._labels?.some(l => l.toLowerCase().includes('desconocido')) },

    // Integridad
    { id: 'duplicates', group: 'Integridad', label: 'PNs duplicados (nombre exacto)', check: null }, // handled separately
    { id: 'similar', group: 'Integridad', label: 'PNs duplicados por similitud (~80%)', check: null }, // handled separately
    { id: 'no-customer', group: 'Integridad', label: 'Sin cliente asignado', check: pn => !pn.customerByCustomerId?.id },
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
  // DATA EXTRACTION FROM GetPartNumber
  // ═══════════════════════════════════════════

  function enrichPN(pnData) {
    const pn = pnData;
    // Extract nested data for criteria checks
    pn._labels = (pn.partNumberLabelsByPartNumberId?.nodes || [])
      .map(l => l.labelByLabelId?.name || l.name || '').filter(Boolean);
    pn._specs = (pn.partNumberSpecsByPartNumberId?.nodes || []).map(s => {
      const specFields = s.specBySpecId?.specFieldSpecsBySpecId?.nodes || [];
      const hasEspesorField = specFields.some(sf => sf.specFieldBySpecFieldId?.name?.toLowerCase().includes('espesor'));
      const hasEspesorParam = specFields.some(sf => {
        if (!sf.specFieldBySpecFieldId?.name?.toLowerCase().includes('espesor')) return false;
        const params = s.partNumberSpecFieldParamsByPartNumberSpecId?.nodes || [];
        return params.length > 0;
      });
      return { name: s.specBySpecId?.name, _hasEspesorField: hasEspesorField, _hasEspesorParam: hasEspesorParam };
    });
    pn._racks = pn.partNumberRackTypesByPartNumberId?.nodes || [];
    pn._prices = pn.partNumberPricesByPartNumberId?.nodes || [];
    pn._dimensions = pn.partNumberDimensionsByPartNumberId?.nodes || [];
    pn._unitConversions = pn.inventoryItemByPartNumberId?.inventoryItemUnitConversionsByInventoryItemId?.nodes || [];
    pn._predictiveUsages = pn.inventoryPredictedUsagesByPartNumberId?.nodes || [];
    pn._optInOuts = pn.processNodePartNumberOptInoutsByPartNumberId?.nodes || [];
    pn._dimCustomValues = pn.dimensionCustomValueIds || [];
    return pn;
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

    // Fetch PNs
    const allPNs = [];
    let offset = 0;
    while (!stopped) {
      const vars = { orderBy: ['NAME_ASC'], offset, first: 500, searchQuery: searchQuery || '' };
      const data = await api().query('AllPartNumbers', vars, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      const active = nodes.filter(n => !n.archivedAt);

      // Apply customer filter if set
      if (customerFilter) {
        for (const n of active) {
          if (n.customerByCustomerId?.name?.toUpperCase().includes(customerFilter.toUpperCase())) {
            allPNs.push(n);
          }
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
    updateAuditorUI(`${allPNs.length} PNs. Auditando (esto puede tomar varios minutos)...`);

    // Duplicate checks (no need for GetPartNumber)
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
        for (const [name, pns] of nameMap) {
          if (pns.length > 1) {
            results.criteria['duplicates'].count += pns.length;
            for (const p of pns) results.criteria['duplicates'].pns.push({ id: p.id, name: p.name, customer: p.customerByCustomerId?.name || '' });
          }
        }
      }

      if (checkSimilar) {
        const names = [...new Set(allPNs.map(p => p.name))];
        for (let i = 0; i < names.length && !stopped; i++) {
          if (i % 100 === 0) updateAuditorUI(`Similitud: ${i}/${names.length}...`);
          for (let j = i + 1; j < names.length; j++) {
            if (names[i] === names[j]) continue; // exact dup already handled
            if (similarity(names[i], names[j]) >= 0.8) {
              results.criteria['similar'].count++;
              results.criteria['similar'].pns.push({ id: null, name: `${names[i]} ≈ ${names[j]}`, customer: '', similarity: Math.round(similarity(names[i], names[j]) * 100) + '%' });
            }
          }
        }
      }
    }

    // Per-PN criteria (need GetPartNumber detail)
    const perPNCriteria = activeCriteria.filter(c => c.check && c.id !== 'duplicates' && c.id !== 'similar');
    if (perPNCriteria.length > 0) {
      for (let i = 0; i < allPNs.length && !stopped; i++) {
        const pn = allPNs[i];
        const pct = Math.round((i / allPNs.length) * 100);
        if (i % 5 === 0) updateAuditorUI(`Auditando ${i + 1}/${allPNs.length} (${pct}%) — ${results.totalIssues} problemas | ⏹ para detener`, true);

        try {
          const detail = await api().query('GetPartNumber', { partNumberId: pn.id, usagesLimit: 0, usagesOffset: 0 });
          const enriched = enrichPN(detail?.partNumberById || {});

          for (const c of perPNCriteria) {
            if (c.check(enriched)) {
              results.criteria[c.id].count++;
              results.criteria[c.id].pns.push({
                id: enriched.id,
                name: enriched.name,
                customer: enriched.customerByCustomerId?.name || '',
                createdAt: enriched.createdAt
              });
              results.totalIssues++;
            }
          }
        } catch (e) {
          warn(`Auditar ${pn.name}: ${String(e).substring(0, 60)}`);
        }

        results.totalAudited = i + 1;
      }
    }

    log(`Auditor: ${results.totalAudited} auditados, ${results.totalIssues} problemas`);
    return results;
  }

  function stop() { stopped = true; }

  // ═══════════════════════════════════════════
  // EXPORT CSV
  // ═══════════════════════════════════════════

  function exportCSV(results) {
    // Collect unique PNs across all criteria with their issues
    const pnIssues = new Map();
    for (const [criteriaId, data] of Object.entries(results.criteria)) {
      for (const pn of (data.pns || [])) {
        if (!pn.id) continue;
        if (!pnIssues.has(pn.id)) {
          pnIssues.set(pn.id, { ...pn, issues: [] });
        }
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
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
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
    // Add stop button if not present
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
