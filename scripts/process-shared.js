// Process Shared — Módulo compartido entre process-canon y process-deep-audit.
//
// Expone window.ProcessShared con:
//   · Constantes (LINE_MAPPING, GLOBALS, TAG_PATTERNS, AUX_SUFFIXES, …).
//   · Identificación: getLineCode, isSatelliteCode, isExcludedLineCode,
//     detectLineSections, extractFinishSuffixes.
//   · Catálogo: loadAllNodes, loadSharedByLine, loadScannerNodes,
//     fetchAllProcesses, lookupNodeId/Name, lookupSharedVariants.
//   · Queries: getProcessTree, getProcessDetail, getTreatmentDetail,
//     getTreatmentTimes, getProcessNodeParents.
//   · Utilidades de árbol: relParentId/ChildId/ChildName, bfsRelationships,
//     extractTopLevel.
//   · Helpers de Interval (lead time, cycle/total time): intervalToSeconds,
//     intervalToMinutes, intervalToHours, hasInterval.
//
// El catálogo es lazy: la primera llamada a loadAllNodes / loadSharedByLine
// puebla los stores internos y las llamadas posteriores reusan. Cualquier
// applet puede invocar loadAllX() en serie sin duplicar trabajo.
//
// Depends on: SteelheadAPI

const ProcessShared = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  const PAGE_SIZE = 500;

  // ── Constantes ──────────────────────────────────────────────────────────

  // 5 globales canónicos. 4 son SUB_PROCESS; "SP Embarque en Almacén" es
  // STEP_SHIPPING — por eso loadAllNodes hace dos pasadas.
  const GLOBALS = [
    'SP Inspección Recibo',
    'SP Preparación de Surtido en Almacén',
    'SP Preparación de Embarque en Almacén',
    'SP Inspección de Calidad Embarques',
    'SP Embarque en Almacén'
  ];

  const listoPPName = (T) => `${T} Listo para Procesar`;

  // Tags por operación canónica (descubrimiento de variantes por línea).
  const TAG_PATTERNS = {
    enracado:    /enracado\s*\/\s*carga\s+de\s+barril/i,
    secado:      /^secado\s+manual\s*,/i,
    inspEmpaque: /^inspecci[oó]n\s+y\s+empaque$/i
  };
  // Filtros extra de nombre dentro del tag (algunos tags traen nodos ajenos).
  const NAME_FILTERS = {
    enracado: null,
    secado: null,
    inspEmpaque: /inspecci[oó]n\s+y\s+empaque/i
  };

  // processName → "T<n>" line code (generado de 1._Proceso - Tratamientos
  // Genericos.xlsx). 158 entradas — fuente de verdad para matching exacto.
  const LINE_MAPPING = {
    "T100 (LMC)-T104 (EST)-CU/BR-HUBBELL (6.0)": "T104",
    "T100 (PUL)-T103 (CRD)-T103 (ACE)-T100 (ABR)-FE-FISHER (11.0)": "T103",
    "T100 (SAB)-T107 (PLA)-CU-C5 (60.0)": "T107",
    "T101 (BDP)-CU-VARIOS (4.0)": "T101",
    "T101 (BRI)-CU-VARIOS (4.0)": "T101",
    "T101 (CRO)-AL-MAT. MECANICO ELECTRICO (4.0)": "T101",
    "T101 (DEC)-AL-VARIOS (4.0)": "T101",
    "T101 (DEC)-CU-VARIOS (4.0)": "T101",
    "T101 (DEC)-FE-VARIOS (4.0)": "T101",
    "T101 (DEC)-INOX-VARIOS (4.0)": "T101",
    "T101 (DEC)-LA-VARIOS (4.0)": "T101",
    "T101 (DEC)-T109 (NBR)-FE/AC-GRANEL (15.0)": "T109",
    "T101 (DEC)-T109 (NSU)-FE/AC-GRANEL (15.0)": "T109",
    "T101 (DES)-INOX/CU-VARIOS (4.0)": "T101",
    "T101 (IRI)-AL-VARIOS (4.0)": "T101",
    "T101 (LAV)-AL-VARIOS (4.0)": "T101",
    "T101 (LAV)-CU-VARIOS (4.0)": "T101",
    "T101 (LAV)-CU/BR-HUBBELL (4.0)": "T101",
    "T101 (LAV)-FE-VARIOS (4.0)": "T101",
    "T101 (LAV)-INOX-VARIOS (4.0)": "T101",
    "T101 (LAV)-LA-VARIOS (4.0)": "T101",
    "T101 (NOX)-AL-VARIOS (4.0)": "T101",
    "T101 (PAS)-CU-VARIOS (4.0)": "T101",
    "T101 (PAS)-FE-VARIOS (4.0)": "T101",
    "T101 (PAS)-INOX-VARIOS (4.0)": "T101",
    "T101 (PRE)-T108 (NSU)-T109 (PAS)-LA-VARIOS (13.0)": "T108",
    "T101 (PRE)-T108 (NWO)-T108 (NEL)-T109 (PAS)-FE-BUJIA (13.0)": "T108",
    "T101 (PRE)-T112 (NWO)-T109 (NSU)-CU/LA/FE/INOX-VARIOS (13.2)": "T112",
    "T101 (PRE)-T112 (NWO)-T109 (NSU)-INOX-RPK (15.0)": "T109",
    "T101 (PRE)-T112 (NWO)-T112 (NEL)-T109 (PAS)-LA-VARIOS (13.2)": "T112",
    "T101 (PRE)-T112 (NWO)-T203 (PLA)-LA-VARIOS (16.0)": "T203",
    "T101 (PRE)-T112 (NWO)-T204 (PLA)-LA-VARIOS (16.1)": "T204",
    "T101 (PRE)-T203 (PLA)-LA-VARIOS (16.0)": "T203",
    "T101 (ROD)-T108 (NWO)-T108 (NEL)-T109 (PAS)-INOX/FE-VARIOS (13.0)": "T108",
    "T101 (ROD)-T109 (NBR)-FE/AC-GRANEL (15.0)": "T109",
    "T101 (ROD)-T109 (NBR)-T100 (HOR)-FE/AC-GRANEL (15.0)": "T109",
    "T101 (ROD)-T109 (NSU)-FE/AC-GRANEL (15.0)": "T109",
    "T101 (ROD)-T109 (NSU)-T100 (HOR)-FE/AC-GRANEL (15.0)": "T109",
    "T101 (ROD)-T112 (NEL)-T109 (PAS)-FE-VARIOS (13.2)": "T112",
    "T101 (ROD)-T112 (NWO)-T112 (NEL)-T112 (ACE)-INOX-MONEDA (13.2)": "T112",
    "T102 (COB)-AL-VARIOS (12.0)": "T102",
    "T102 (COB)-T102 (EST)-FE/AC-VARIOS (12.0)": "T102",
    "T102 (EST)-AL-VARIOS (12.0)": "T102",
    "T102 (EST)-CU/BR-VARIOS (12.0)": "T102",
    "T102 (IRI)-AL-FISHER (12.0)": "T102",
    "T103 (CRD)-FE-VEEBALL (11.0)": "T103",
    "T104 (EST)-CU/BR-VARIOS (6.0)": "T104",
    "T104 (ZIN)-T100 (HOR)-T104 (CAZ)-FE-VARIOS (6.0)": "T104",
    "T104 (ZIN)-T100 (HOR)-T104 (CTR)-FE/AC-VARIOS (6.0)": "T104",
    "T104 (ZIN)-T100 (HOR)-T104 (CVO)-FE/AC-VARIOS (6.0)": "T104",
    "T104 (ZIN)-T104 (CAZ)-FE/AC-VARIOS (6.0)": "T104",
    "T104 (ZIN)-T104 (CTR)-FE/AC-VARIOS (6.0)": "T104",
    "T104 (ZIN)-T104 (CVO)-FE/AC-VARIOS (6.0)": "T104",
    "T105 (ZIN)-T100 (HOR)-T105 (CAZ)-FE/AC/LA-VARIOS (7.0)": "T105",
    "T105 (ZIN)-T105 (CAZ)-FE/AC/LA-VARIOS (7.0)": "T105",
    "T105 (ZIN)-T105 (CTR)-FE/AC/LA-VARIOS (7.0)": "T105",
    "T105 (ZIN)-T105 (CVO)-FE/AC/LA-VARIOS (7.0)": "T105",
    "T106 (ZIN)-T100 (HOR)-T106 (CAM)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T100 (HOR)-T106 (CAZ)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CAM)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CAT)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CAZ)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CNE)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CNT)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CRJ)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CTR)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CTV)-FE/AC-VARIOS (10.0)": "T106",
    "T106 (ZIN)-T106 (CVO)-FE/AC-VARIOS (10.0)": "T106",
    "T107 (PLA)-CU-C4 (60.0)": "T107",
    "T108 (COB)-T108 (NWO)-T108 (NEL)-T108 (NCV)-T109 (PAS)-ZA-CROMVET (13.0)": "T108",
    "T108 (NEL)-T100 (HOR)-T108 (DEC)-T100 (FIB)-FE-CAGES FISHER (13.0)": "T108",
    "T108 (NWO)-T108 (COB)-T108 (NWO)-T108 (NEL)-T109 (PAS)-FE/ZA-VARIOS (13.0)": "T108",
    "T108 (NWO)-T108 (NEL)-T100 (HOR)-T108 (DEC)-T100 (FIB)-FE-CAGES FISHER (13.0)": "T108",
    "T109 (LAV)-T000 (TRT)-T109 (NBR)-BI-BIMETALES (15.0)": "T109",
    "T109 (NBR)-FE/AC-GRANEL (15.0)": "T109",
    "T109 (NBR)-T100 (HOR)-FE/AC-GRANEL (15.0)": "T109",
    "T109 (NSU)-FE-BUJIA (15.0)": "T109",
    "T109 (NSU)-FE-BUJIA RENAULT (15.0)": "T109",
    "T109 (NSU)-FE/AC-GRANEL (15.0)": "T109",
    "T109 (NSU)-T100 (HOR)-FE/AC-GRANEL (15.0)": "T109",
    "T110 (DEC)-CU-VARIOS (26.0)": "T110",
    "T111 (AND)-AL-VARIOS (14.0)": "T111",
    "T111 (COB)-T110 (PLA)-AL-VARIOS (26.0)": "T110",
    "T111 (COB)-T203 (PLA)-AL-HEATER (16.0)": "T203",
    "T111 (ESM)-AL-VARIOS (14.0)": "T111",
    "T111 (ESM)-CU-VARIOS (14.0)": "T111",
    "T111 (EST)-AL-VARIOS (14.0)": "T111",
    "T111 (EST)-CU-VARIOS (14.0)": "T111",
    "T112 (NWO)-T203 (PLA)-FE-VARIOS (16.0)": "T203",
    "T112 (NWO)-T204 (PLA)-FE-VARIOS (16.1)": "T204",
    "T112 (NWO)-T301 (EST)-CU/FE/LA-VARIOS (24.0)": "T301",
    "T113 (ZIN)-T100 (HOR)-T113 (CAZ)-FE-VARIOS (17.0)": "T113",
    "T113 (ZIN)-T113 (CAZ)-FE-VARIOS (17.0)": "T113",
    "T114 (FMS)-FE-GM (7.1)": "T114",
    "T114 (FMS)-FE-PISTON (7.1)": "T114",
    "T114 (FMS)-FE-PIÑON (7.1)": "T114",
    "T114 (FMS)-T114 (ACE)-FE-PISTON (7.1)": "T114",
    "T114 (FMS)-T114 (ACE)-FE-PIÑON (7.1)": "T114",
    "T115 (NCR)-FE/AC-VARIOS (23.0)": "T115",
    "T116 (FZI)-FE/AC-VARIOS (7.2)": "T116",
    "T116 (FZI)-T116 (ACE)-FE/AC-VARIOS (7.2)": "T116",
    "T116 (PAV)-FE/AC-VARIOS (7.2)": "T116",
    "T116 (PAV)-T116 (ACE)-FE/AC-VARIOS (7.2)": "T116",
    "T117 (ZNQ)-T117 (CNN)-FE/AC-BONETE (28.0)": "T117",
    "T200 (REB)-T109 (NBR)-FE/AC-GRANEL (15.0)": "T109",
    "T200 (REB)-T109 (NBR)-T100 (HOR)-FE/AC-GRANEL (15.0)": "T109",
    "T200 (REB)-T109 (NSU)-FE/AC-GRANEL (15.0)": "T109",
    "T200 (REB)-T109 (NSU)-T100 (HOR)-FE/AC-GRANEL (15.0)": "T109",
    "T201 (COB)-AL-VARIOS (25.0)": "T201",
    "T201 (DEC)-T201 (ESM)-CU-VARIOS (25.0)": "T201",
    "T201 (DEC)-T201 (EST)-CU-VARIOS (25.0)": "T201",
    "T201 (DEC)-T201 (NSU)-CU-VARIOS (25.0)": "T201",
    "T201 (ESM)-AL-VARIOS (25.0)": "T201",
    "T201 (ESM)-CU-VARIOS (25.0)": "T201",
    "T201 (EST)-AL-VARIOS (25.0)": "T201",
    "T201 (EST)-CU-VARIOS (25.0)": "T201",
    "T201 (EST)-T401 (EBT)-CU-VARIOS (25.0)": "T201",
    "T201 (NSU)-CU-VARIOS (25.0)": "T201",
    "T202 (DEC)-CU-BARE (16.2)": "T202",
    "T202 (PLA)-CU-VARIOS (16.2)": "T202",
    "T203 (LES)-T203 (PLA)-CU-VARIOS (16.0)": "T203",
    "T204 (DEC)-CU-BARE (16.1)": "T204",
    "T204 (EST)-T401 (EBT)-CU-VARIOS (16.1)": "T204",
    "T205 (DEC)-CU-BARE (16.3)": "T205",
    "T205 (EST)-AL-VARIOS (16.3)": "T205",
    "T205 (EST)-CU-VARIOS (16.3)": "T205",
    "T205 (EST)-T401 (EBT)-CU-VARIOS (16.3)": "T205",
    "T205 (PLA)-T300 (ANT)-CU-SOLERA RG (16.3)": "T205",
    "T206 (LAV)-T000 (TRT)-T206 (EST)-BI-BIMETALES (18.0)": "T206",
    "T207 (AND)-AL-VARIOS (16.4)": "T207",
    "T207 (AND)-T207 (TIN)-AL-VARIOS (16.4)": "T207",
    "T207 (ELE)-FE/AC-FISHER (16.4)": "T207",
    "T300 (ANT)-CU-VARIOS (20.0)": "T300",
    "T300 (FIB)-T205 (PLA)-CU-ZION (16.3)": "T205",
    "T300 (FIB)-T205 (PLA)-T300 (ANT)-CU-SOLERA WIELAND (16.3)": "T205",
    "T300 (LES)-T110 (PLA)-CU-VARIOS (26.0)": "T110",
    "T300 (LES)-T110 (PLA)-T300 (ANT)-CU-VARIOS (26.0)": "T110",
    "T300 (LES)-T204 (EST)-CU/BR-VARIOS (16.1)": "T204",
    "T300 (LES)-T204 (NWO)-T204 (PLA)-CU-VARIOS (16.1)": "T204",
    "T300 (LES)-T204 (PLA)-CU/BR-VARIOS (16.1)": "T204",
    "T300 (LES)-T204 (PLA)-T300 (ANT)-CU-VARIOS (16.1)": "T204",
    "T300 (LES)-T205 (PLA)-CU-MAQUILA QRO (16.3)": "T205",
    "T300 (LES)-T205 (PLA)-T300 (ANT)-CU-MAQUILA RG (16.3)": "T205",
    "T301 (EST)-CU/BR/FE-VARIOS (24.0)": "T301",
    "T301 (LES)-T301 (EST)-CU-CELCO (24.0)": "T301",
    "T400 (ANT)-CU-VARIOS (20.0)": "T400",
    "T401 (EBT)-CU-VARIOS (30.0)": "T401",
    "T401 (EBT)-T110 (PLA)-T300 (ANT)-CU-VARIOS (26.0)": "T110",
    "T401 (EBT)-T204 (PLA)-T300 (ANT)-CU-VARIOS (16.1)": "T204",
    "T401 (EBT)-T205 (PLA)-T300 (ANT)-CU-VARIOS (16.3)": "T205",
    "T401 (EMR)-CU-VARIOS (30.0)": "T401",
    "T401 (EMT)-CU-VARIOS (30.0)": "T401",
    "T401 (EMT)-T110 (PLA)-T300 (ANT)-CU-VARIOS (26.0)": "T110",
    "T401 (EMT)-T201 (EST)-CU-VARIOS (25.0)": "T201",
    "T401 (EMT)-T204 (EST)-CU-VARIOS (16.1)": "T204",
    "T401 (EMT)-T204 (PLA)-T300 (ANT)-CU-VARIOS (16.1)": "T204",
    "T401 (EMT)-T205 (EST)-CU-VARIOS (16.3)": "T205",
    "T401 (EMT)-T205 (PLA)-T300 (ANT)-CU-VARIOS (16.3)": "T205"
  };

  const EPOXY_SUFFIXES = new Set(['EMT', 'EBT', 'EMR']);
  const AUX_SUFFIXES = new Set([
    'LAV', 'DEC', 'PAS', 'ANT', 'HOR', 'PUL', 'REB', 'FIB', 'ENM', 'DNM'
  ]);
  const PREP_CODES = new Set(['T101']);

  // Satélites: T100, T200, T300, T400, T500 (procesos auxiliares).
  const SATELLITE_REGEX = /^[TM]\d+00$/;
  function isSatelliteCode(code) { return SATELLITE_REGEX.test(String(code || '')); }
  function isExcludedLineCode(code) { return isSatelliteCode(code) || code === 'T401'; }
  function isExcludedProcessName(name) {
    return /^(RT|SP)\b/i.test(String(name || '').trim());
  }

  // ── Normalización ──
  function normName(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  // ── Identificación de línea por nombre del proceso ──
  function getLineCode(processName) {
    if (LINE_MAPPING[processName]) return LINE_MAPPING[processName];
    const matches = Array.from(String(processName || '').matchAll(
      /\b(T\d{2,4}|M\d{2,4})(?:\s*\(([A-Z][A-Z/]*)\))?/g
    ));
    if (!matches.length) return null;
    const codes = matches.map(m => ({
      code: m[1].toUpperCase(),
      suffix: m[2] ? m[2].toUpperCase() : null
    }));

    const uniq = new Set(codes.map(c => c.code));
    if (uniq.size === 1) return codes[0].code;

    const isEpoxy = (s) => !!s && EPOXY_SUFFIXES.has(s);
    const isAux   = (s) => !!s && AUX_SUFFIXES.has(s);
    const isPrep  = (c) => PREP_CODES.has(c);

    const eligible = codes.filter(c =>
      !isSatelliteCode(c.code) && c.code !== 'T401' && !isEpoxy(c.suffix)
    );
    const recubrimiento = eligible.filter(c => !isPrep(c.code) && !isAux(c.suffix));
    const auxiliar      = eligible.filter(c => !isPrep(c.code) &&  isAux(c.suffix));
    const preparation   = eligible.filter(c =>  isPrep(c.code));

    function pickMostFrequent(arr) {
      if (!arr.length) return null;
      const counts = new Map();
      for (const c of arr) counts.set(c.code, (counts.get(c.code) || 0) + 1);
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      if (sorted.length === 1) return sorted[0][0];
      if (sorted[0][1] > sorted[1][1]) return sorted[0][0];
      return null;
    }
    return pickMostFrequent(recubrimiento)
        || pickMostFrequent(auxiliar)
        || pickMostFrequent(preparation)
        || null;
  }

  function isVariant71(processName) {
    return /\(7\.1\)/.test(String(processName || ''));
  }
  function getPosOrder(processName) {
    if (isVariant71(processName)) return [1, 0, 2, 3, 4, 5, 6, 7, 8];
    return [0, 1, 2, 3, 4, 5, 6, 7, 8];
  }

  function extractLineCodeFromName(name) {
    const m = String(name || '').trim().match(/^(T\d{2,4}|M\d{2,4})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  // Detecta secciones de línea principal en el top-level. Cada sección es un
  // bloque consecutivo de top-level nodes que comparten el mismo lineCode
  // T<n>. El nodo Listo (slot 3) es la pieza que ancla cada sección.
  //
  // Multi-línea: ej. un proceso T101-T108 puede tener bloques [T101 Enracado,
  // T101 Listo, T101 Secado, T101 InspEmp, T108 Enracado, T108 Listo, T108
  // Secado, T108 InspEmp] entre los 5 globales. Cada bloque es una sección.
  //
  // DEC+PLF: si el nombre menciona dos códigos pero solo hay un bloque en el
  // árbol, la auditoría reporta 1 sección (validamos por árbol, no por nombre).
  //
  // Devuelve: [{ lineCode, listoNode, blockNodes:[topLevelNodes…] }]
  // listoNode es null si el bloque no tiene un nodo Listo para Procesar.
  function detectLineSections(topLevelNodes) {
    if (!Array.isArray(topLevelNodes) || !topLevelNodes.length) return [];
    const sections = [];
    let currentCode = null;
    let currentBlock = [];

    const flush = () => {
      if (!currentBlock.length) return;
      const listoNode = currentBlock.find(n => /listo para procesar/i.test(n.name || '')) || null;
      sections.push({ lineCode: currentCode, listoNode, blockNodes: currentBlock.slice() });
      currentBlock = [];
    };

    for (const node of topLevelNodes) {
      const code = extractLineCodeFromName(node.name || '');
      const isGlobalSP = /^SP\s/i.test(String(node.name || ''));
      if (isGlobalSP || !code) {
        // Global o nodo sin código → cierra el bloque anterior si hay.
        flush();
        currentCode = null;
        continue;
      }
      if (currentCode === null) currentCode = code;
      if (code !== currentCode) {
        flush();
        currentCode = code;
      }
      currentBlock.push(node);
    }
    flush();
    return sections;
  }

  // Extrae sufijos de acabado del nombre: T205 (EST)-CU-VARIOS → ["EST"].
  // Ignora códigos satélite/epóxicos y prep (T101). Devuelve array único en
  // orden de aparición.
  function extractFinishSuffixes(processName) {
    const matches = Array.from(String(processName || '').matchAll(
      /\b(T\d{2,4}|M\d{2,4})\s*\(([A-Z][A-Z/]*)\)/g
    ));
    const out = [];
    const seen = new Set();
    for (const m of matches) {
      const code = m[1].toUpperCase();
      const suffix = m[2].toUpperCase();
      if (isSatelliteCode(code)) continue;
      if (code === 'T401') continue;
      if (EPOXY_SUFFIXES.has(suffix)) continue;
      if (AUX_SUFFIXES.has(suffix)) continue;
      if (PREP_CODES.has(code)) continue;
      if (seen.has(suffix)) continue;
      seen.add(suffix);
      out.push(suffix);
    }
    return out;
  }

  // ── Catálogo runtime ──
  let _nodesByName = null;    // Map<normName, id>
  let _namesById = null;      // Map<id, displayName>
  let _typesById = new Map(); // Map<id, type>  (PROCESS, SUB_PROCESS, …)
  let _sharedIds = new Set();
  let _sharedByOp = null;
  let _scannerIds = new Set();
  let _allNodesLoaded = false;
  let _sharedByLineLoaded = false;
  let _scannerLoaded = false;

  function lookupNodeId(name) {
    if (!_nodesByName) return null;
    return _nodesByName.get(normName(name)) || null;
  }
  function lookupNodeName(id) {
    if (!_namesById) return null;
    return _namesById.get(id) || null;
  }
  function lookupNodeType(id) {
    return _typesById.get(id) || null;
  }
  function lookupSharedVariants(op, lineCode) {
    if (!_sharedByOp || !lineCode) return [];
    const m = _sharedByOp[op];
    if (!m) return [];
    return m.get(String(lineCode).toUpperCase()) || [];
  }
  function isLineCanonAt(op, lineCode, id) {
    if (id == null) return false;
    return lookupSharedVariants(op, lineCode).some(v => v.id === id);
  }

  function isArchivedNode(n) {
    if (!n) return false;
    if (n.archive === true || n.isArchived === true) return true;
    if (n.archivedAt != null && n.archivedAt !== '') return true;
    if (n.archivedDate != null && n.archivedDate !== '') return true;
    return false;
  }

  async function loadAllNodes(onProgress) {
    if (_allNodesLoaded) return { byName: _nodesByName, total: _namesById.size };
    const byName = new Map();
    const byId = new Map();
    const nameDupes = new Map();
    const archivedSeen = new Map();
    let total = 0;
    const passes = [
      { types: ['PROCESS', 'SUB_PROCESS'], label: 'PROCESS+SUB_PROCESS' },
      { types: ['STEP_SHIPPING'],           label: 'STEP_SHIPPING' }
    ];
    for (const pass of passes) {
      let offset = 0;
      let passTotal = null;
      while (true) {
        const data = await api().query('ProcessesComponentQuery', {
          includeArchived: 'NO',
          processNodeTypes: pass.types,
          orderBy: ['ID_ASC'],
          offset,
          first: PAGE_SIZE,
          searchQuery: ''
        }, 'ProcessesComponentQuery');
        const paged = data?.pagedData || {};
        const nodes = paged.nodes || [];
        if (passTotal === null && typeof paged.totalCount === 'number') passTotal = paged.totalCount;
        for (const n of nodes) {
          if (!n?.name || !n?.id) continue;
          const k = normName(n.name);
          if (isArchivedNode(n)) {
            archivedSeen.set(k, (archivedSeen.get(k) || 0) + 1);
            continue;
          }
          if (!byName.has(k)) byName.set(k, n.id);
          if (!byId.has(n.id)) byId.set(n.id, n.name);
          if (n.type) _typesById.set(n.id, n.type);
          if (!nameDupes.has(k)) nameDupes.set(k, []);
          nameDupes.get(k).push(n.id);
          _sharedIds.add(n.id);
        }
        if (onProgress) onProgress(`Cargando catálogo (${pass.label})... ${byName.size}`);
        if (nodes.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      total += (passTotal ?? 0);
    }
    _nodesByName = byName;
    _namesById = byId;
    _allNodesLoaded = true;
    log(`  Catálogo: ${byName.size} nodos únicos por nombre (PROCESS+SUB_PROCESS+STEP_SHIPPING, totalCount=${total || '?'}).`);
    for (const g of GLOBALS) {
      const k = normName(g);
      const ids = nameDupes.get(k);
      if (ids && ids.length > 1) {
        const preview = ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, +${ids.length - 5} más` : '');
        log(`  ⚠ '${g}' tiene ${ids.length} duplicados ACTIVOS [${preview}]. Usando id más antiguo: ${byName.get(k)}.`);
      }
    }
    return { byName, total };
  }

  async function searchNodeByName(name) {
    try {
      const data = await api().query('ProcessesComponentQuery', {
        includeArchived: 'NO',
        processNodeTypes: ['PROCESS', 'SUB_PROCESS', 'STEP', 'STEP_SHIPPING'],
        orderBy: ['ID_DESC'],
        offset: 0, first: 50,
        searchQuery: name
      }, 'ProcessesComponentQuery');
      const nodes = data?.pagedData?.nodes || [];
      const target = normName(name);
      const exact = nodes.find(n => normName(n.name) === target);
      return exact || null;
    } catch (_) { return null; }
  }

  async function loadScannerNodes(onProgress) {
    if (_scannerLoaded) return;
    let offset = 0;
    let total = 0;
    while (true) {
      const data = await api().query('ProcessesComponentQuery', {
        includeArchived: 'NO',
        processNodeTypes: ['SCANNER_NODE'],
        orderBy: ['ID_DESC'],
        offset, first: PAGE_SIZE, searchQuery: ''
      }, 'ProcessesComponentQuery');
      const paged = data?.pagedData || {};
      const nodes = paged.nodes || [];
      for (const n of nodes) {
        if (!n?.name || !n?.id) continue;
        if (!_namesById.has(n.id)) _namesById.set(n.id, n.name);
        if (n.type) _typesById.set(n.id, n.type);
        _scannerIds.add(n.id);
      }
      total += nodes.length;
      if (onProgress) onProgress(`Cargando scanner_nodes... ${total}`);
      if (nodes.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    _scannerLoaded = true;
    log(`  Scanner nodes: ${total} cargados.`);
  }

  async function loadSharedByLine(onProgress) {
    if (_sharedByLineLoaded) return _sharedByOp;
    if (onProgress) onProgress('Cargando catálogo de tags...');
    const tagsData = await api().query('GetAllTagsQuery', {}, 'GetAllTagsQuery');
    const tagsList = tagsData?.allTags?.nodes
      || tagsData?.allTags
      || tagsData?.tags?.nodes
      || tagsData?.tags
      || [];

    const opTags = {};
    for (const op of Object.keys(TAG_PATTERNS)) {
      const re = TAG_PATTERNS[op];
      const tag = tagsList.find(t => re.test(t?.name || ''));
      if (!tag) {
        const err = new Error(`Tag de operación '${op}' no encontrado.`);
        err.diagnostic = `Patrón buscado: ${String(re)}. Tags en catálogo (primeros 30): ${tagsList.slice(0, 30).map(t => t?.name || '?').join(' | ')}`;
        throw err;
      }
      opTags[op] = tag;
    }
    log(`  Tags de operación: enracado(id ${opTags.enracado.id}) | secado(id ${opTags.secado.id}) | inspEmpaque(id ${opTags.inspEmpaque.id})`);

    const sharedByOp = { enracado: new Map(), secado: new Map(), inspEmpaque: new Map() };
    for (const op of Object.keys(opTags)) {
      const tag = opTags[op];
      if (onProgress) onProgress(`Cargando nodos de tag '${tag.name}'...`);
      let offset = 0;
      let collected = 0;
      while (true) {
        const data = await api().query('ProcessesWithTag', {
          tagId: tag.id,
          includeArchived: 'NO',
          orderBy: ['ID_DESC'],
          offset, first: PAGE_SIZE,
          searchQuery: ''
        }, 'ProcessesWithTag');
        const paged = data?.pagedData || data?.processesWithTag || {};
        const nodes = paged.nodes || data?.nodes || [];
        const nameFilter = NAME_FILTERS[op];
        for (const n of nodes) {
          if (!n?.name || !n?.id) continue;
          if (nameFilter && !nameFilter.test(n.name)) continue;
          const code = extractLineCodeFromName(n.name);
          if (!code) continue;
          let arr = sharedByOp[op].get(code);
          if (!arr) { arr = []; sharedByOp[op].set(code, arr); }
          if (!arr.some(v => v.id === n.id)) {
            arr.push({ id: n.id, name: n.name });
            if (_nodesByName) _nodesByName.set(normName(n.name), n.id);
            if (_namesById) _namesById.set(n.id, n.name);
            if (n.type) _typesById.set(n.id, n.type);
            _sharedIds.add(n.id);
          }
        }
        collected += nodes.length;
        if (nodes.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      const variantCount = Array.from(sharedByOp[op].values()).reduce((s, arr) => s + arr.length, 0);
      log(`  Tag '${tag.name}': ${sharedByOp[op].size} líneas, ${variantCount} variantes totales (${collected} nodos crudos)`);
    }
    _sharedByOp = sharedByOp;
    _sharedByLineLoaded = true;
    return sharedByOp;
  }

  async function fetchAllProcesses(onProgress) {
    const all = [];
    let offset = 0;
    while (true) {
      const data = await api().query('AllProcesses', {
        includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: '',
        first: PAGE_SIZE, offset
      }, 'AllProcesses');
      const nodes = data?.allProcessNodes?.nodes || data?.pagedData?.nodes || [];
      all.push(...nodes);
      if (onProgress) onProgress(`Procesos: ${all.length}`);
      if (nodes.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return all;
  }

  function getCatalog() {
    return {
      nodesByName: _nodesByName,
      namesById: _namesById,
      typesById: _typesById,
      sharedIds: _sharedIds,
      sharedByOp: _sharedByOp,
      scannerIds: _scannerIds
    };
  }

  function resetCatalog() {
    _nodesByName = null;
    _namesById = null;
    _typesById = new Map();
    _sharedIds = new Set();
    _sharedByOp = null;
    _scannerIds = new Set();
    _allNodesLoaded = false;
    _sharedByLineLoaded = false;
    _scannerLoaded = false;
  }

  // ── Queries de nodos/treatments/tiempos ──

  // Trae el árbol completo (descendantRelationships) y el atributo detalle del
  // nodo raíz: processNodeById.{defaultLeadTime, productByProductId,
  // treatmentByTreatmentId, children}.
  async function getProcessTree(id) {
    const data = await api().query('GetProcessNode', {
      id, processNodeOccurrence: 1, rootId: id
    }, 'GetProcessNode');
    return {
      treeRoot: data?.treeRoot || null,
      processNodeById: data?.processNodeById || null
    };
  }

  // Detalle ligero (sin árbol): defaultLeadTime, productByProductId, type, name.
  async function getProcessDetail(id) {
    const data = await api().query('CreateEditProcessDialogQuery', { id }, 'CreateEditProcessDialogQuery');
    return data?.processNodeById || null;
  }

  // Detalle de un treatment con sus estaciones (stationTreatmentsByTreatmentId).
  async function getTreatmentDetail(id) {
    const data = await api().query('GetTreatment', { id }, 'GetTreatment');
    return data?.treatmentById || null;
  }

  // Tiempos por combinación (treatmentId, stationId, processNodeId?, processNodeOccurrence?).
  // input = { treatmentIds:[], stationIds:[], processNodeIds:[], processNodeOccurrence?:null }
  // Devuelve: { nodes: [{treatmentId, stationId, processNodeId, processNodeOccurrence, relatedTimes: [{cycleTime, totalTime, timeType, ...}]}] }
  async function getTreatmentTimes({ treatmentIds = [], stationIds = [], processNodeIds = [], processNodeOccurrence = null, partNumberIds = [], treatmentGroupIds = [] } = {}) {
    // Steelhead requiere `searchTreatmentTimesInput`: una entrada por combo.
    // Si no hay processNodeIds, hacemos producto cartesiano treatments × stations.
    // Si hay processNodeIds, lo agregamos a cada combo.
    const searchInput = [];
    if (processNodeIds.length === 0) {
      for (const tId of treatmentIds) {
        for (const sId of stationIds) {
          searchInput.push({ stationId: sId, treatmentId: tId, processNodeOccurrence: processNodeOccurrence });
        }
      }
    } else {
      for (const tId of treatmentIds) {
        for (const sId of stationIds) {
          for (const pnId of processNodeIds) {
            searchInput.push({
              stationId: sId,
              treatmentId: tId,
              processNodeId: pnId,
              processNodeOccurrence: processNodeOccurrence
            });
          }
        }
      }
    }
    const variables = {
      searchTreatmentTimesInput: searchInput,
      partNumberIds,
      stationIds,
      treatmentIds,
      treatmentGroupIds,
      processNodeIds
    };
    const data = await api().query('CreateEditTreatmentTimesDialogQuery', variables, 'CreateEditTreatmentTimesDialogQuery');
    return data?.allRelatedTreatmentTimesByIdSets?.nodes || [];
  }

  // Padres de un nodo (compartido en uso). Devuelve [{id, name}] o [].
  async function getProcessNodeParents(processNodeId) {
    const data = await api().query('GetProcessNodeParents', { processNodeId }, 'GetProcessNodeParents');
    return data?.processNodeById?.parentProcesses?.nodes || [];
  }

  // ── Utilidades de árbol (descendantRelationships) ──
  const relParentId = (r) => r?.toId;
  const relChildId  = (r) => r?.processNodeByFromId?.id;
  const relChildName = (r) => r?.processNodeByFromId?.name;
  const relChildType = (r) => r?.processNodeByFromId?.type;

  function bfsRelationships(rootId, allRels) {
    const byParent = new Map();
    for (const r of allRels) {
      const p = relParentId(r);
      if (p == null) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(r);
    }
    const kept = [];
    const visited = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const pid = queue.shift();
      const children = (byParent.get(pid) || []).slice().sort((a, b) => (a.childInd || 0) - (b.childInd || 0));
      for (const r of children) {
        kept.push(r);
        const cid = relChildId(r);
        if (cid != null && !visited.has(cid)) {
          visited.add(cid);
          queue.push(cid);
        }
      }
    }
    return kept;
  }

  function extractTopLevel(treeRoot) {
    if (!treeRoot) return [];
    const rootId = treeRoot.id;
    const rels = treeRoot.descendantRelationships || [];
    const top = rels
      .filter(r => relParentId(r) === rootId)
      .sort((a, b) => (a.childInd || 0) - (b.childInd || 0));
    return top.map(r => ({
      id: relChildId(r),
      name: relChildName(r) || lookupNodeName(relChildId(r)) || '',
      type: relChildType(r) || lookupNodeType(relChildId(r)) || null
    }));
  }

  // Recorrido BFS del árbol devolviendo todos los nodos con (id, name, type).
  function flattenTree(treeRoot) {
    if (!treeRoot) return [];
    const rootId = treeRoot.id;
    const rels = treeRoot.descendantRelationships || [];
    const out = [];
    const seen = new Set([rootId]);
    for (const r of rels) {
      const cid = relChildId(r);
      if (cid == null || seen.has(cid)) continue;
      seen.add(cid);
      out.push({
        id: cid,
        name: relChildName(r) || lookupNodeName(cid) || '',
        type: relChildType(r) || lookupNodeType(cid) || null,
        parentId: relParentId(r)
      });
    }
    return out;
  }

  // ── Interval helpers (Steelhead usa shape {years,months,days,hours,minutes,seconds}) ──
  function intervalToSeconds(i) {
    if (!i || typeof i !== 'object') return 0;
    const y = (+i.years || 0) * 31557600;
    const mo = (+i.months || 0) * 2629800;
    const d = (+i.days || 0) * 86400;
    const h = (+i.hours || 0) * 3600;
    const m = (+i.minutes || 0) * 60;
    const s = (+i.seconds || 0);
    return y + mo + d + h + m + s;
  }
  function intervalToMinutes(i) { return intervalToSeconds(i) / 60; }
  function intervalToHours(i)   { return intervalToSeconds(i) / 3600; }
  function hasInterval(i) { return intervalToSeconds(i) > 0; }

  // ── Acceso a config (lazy, vía SteelheadAPI.getDomain) ──
  function getProcessAuditConfig() {
    try { return api().getDomain()?.processAudit || {}; } catch (_) { return {}; }
  }
  function finishProductMap() {
    return getProcessAuditConfig().finishProductMap || {};
  }
  function satelliteOverrides() {
    return getProcessAuditConfig().satelliteOverrides || { include: [], exclude: [] };
  }
  function auditConcurrency() {
    return getProcessAuditConfig().concurrency || { audit: 5, retryDelaysMs: [0, 1000, 2000] };
  }

  return {
    // Constantes
    GLOBALS,
    LINE_MAPPING,
    TAG_PATTERNS,
    NAME_FILTERS,
    AUX_SUFFIXES,
    EPOXY_SUFFIXES,
    PREP_CODES,
    SATELLITE_REGEX,
    listoPPName,

    // Normalización / identificación
    normName,
    getLineCode,
    isSatelliteCode,
    isExcludedLineCode,
    isExcludedProcessName,
    isVariant71,
    getPosOrder,
    extractLineCodeFromName,
    detectLineSections,
    extractFinishSuffixes,

    // Catálogo
    lookupNodeId,
    lookupNodeName,
    lookupNodeType,
    lookupSharedVariants,
    isLineCanonAt,
    getCatalog,
    resetCatalog,
    isArchivedNode,

    // Loaders
    loadAllNodes,
    searchNodeByName,
    loadScannerNodes,
    loadSharedByLine,
    fetchAllProcesses,

    // Queries
    getProcessTree,
    getProcessDetail,
    getTreatmentDetail,
    getTreatmentTimes,
    getProcessNodeParents,

    // Árbol
    relParentId,
    relChildId,
    relChildName,
    relChildType,
    bfsRelationships,
    extractTopLevel,
    flattenTree,

    // Intervals
    intervalToSeconds,
    intervalToMinutes,
    intervalToHours,
    hasInterval,

    // Config accessors
    finishProductMap,
    satelliteOverrides,
    auditConcurrency
  };
})();

if (typeof window !== 'undefined') {
  window.ProcessShared = ProcessShared;
  window.__psVersion = '0.7.0';
  try { console.log('[SA] process-shared cargado · v0.7.0'); } catch (_) {}
}
