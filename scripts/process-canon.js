// Process Canon — Auditor + carga masiva de nodos canónicos en procesos
// Patrón canónico de 9 nodos top-level por proceso:
//   1) SP Inspección Recibo                  (compartido global, SUB_PROCESS)
//   2) SP Preparación de Surtido en Almacén  (compartido global, SUB_PROCESS)
//   3) Enracado / Carga de Barril por línea  (por línea, vía tag, multi-variante)
//   4) T<linea> Listo para Procesar          (LOCAL, se crea con CreateProcessNode)
//   5) Secado por línea                      (por línea, vía tag, multi-variante)
//   6) Inspección y Empaque por línea        (por línea, vía tag, multi-variante)
//   7) SP Preparación de Embarque en Almacén (compartido global, SUB_PROCESS)
//   8) SP Inspección de Calidad Embarques    (compartido global, SUB_PROCESS)
//   9) SP Embarque en Almacén                (compartido global, STEP_SHIPPING)
//
// Modelo de compartición: NO depende del tipo del nodo ni del prefijo en el nombre.
// Un nodo es "compartido" porque el usuario lo coloca con el MISMO id en otro
// proceso. Los SP están en TODOS los procesos; los Enracado/Secado/Inspección y
// Empaque están solo en los procesos de su línea, con potencial de varias
// variantes por línea (ej. T102 tiene tanto 'Secando Manual – Desenracado'
// como 'Secando Centrífugo' bajo el tag Secado, y cada proceso usa la suya).
//
// Discovery:
//   - Globales SP: ProcessesComponentQuery({ types: PROCESS+SUB_PROCESS+STEP_SHIPPING })
//     por nombre. STEP_SHIPPING es necesario para resolver 'SP Embarque en Almacén'.
//   - Por línea: GetAllTagsQuery + ProcessesWithTag por cada uno de los 3 tags
//     de operación. Los nombres por línea varían (T103 Enracado, T108 Enracado ó
//     Carga de Barril, T106 Carga de Barril, etc.) así que matcheamos por id de
//     tag y derivamos el lineCode con regex sobre el prefijo "T<n>" del nombre.
//     Acumulamos TODAS las variantes por línea (un Set) en _sharedByOp.
// Depends on: SteelheadAPI

const ProcessCanon = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  const CONCURRENCY_AUDIT = 5;
  const CONCURRENCY_APPLY = 5;
  const PAGE_SIZE = 500;

  // 5 compartidos globales. Los 4 SUB_PROCESS están en el catálogo
  // PROCESS+SUB_PROCESS; 'SP Embarque en Almacén' es type STEP_SHIPPING y por
  // eso requiere ampliar el loader. Hasta 0.5.43 el canon asumía 8 nodos
  // (colapsando Embarque/Preparación), pero el árbol real tiene 9: ambos
  // existen como nodos distintos y consecutivos (verificado 2026-05-04 en
  // T102 (EST)-AL-VARIOS donde aparecen pos 6 y pos 8).
  const GLOBALS = [
    'SP Inspección Recibo',
    'SP Preparación de Surtido en Almacén',
    'SP Preparación de Embarque en Almacén',
    'SP Inspección de Calidad Embarques',
    'SP Embarque en Almacén'
  ];

  const listoPPName = (T) => `${T} Listo para Procesar`;

  // Tags por operación canónica. Los nombres de los nodos por línea varían
  // ('T103 Enracado', 'T108 Enracado ó Carga de Barril', 'T106 Carga de Barril',
  // 'T103-SE00-001 Secando ...', etc.) así que descubrimos los IDs por tag,
  // no por patrón de nombre.
  const TAG_PATTERNS = {
    enracado:    /enracado\s*\/\s*carga\s+de\s+barril/i,
    secado:      /^secado\s+manual\s*,/i,
    inspEmpaque: /^inspecci[oó]n\s+y\s+empaque$/i
  };
  // Algunos tags traen nodos que no corresponden a la operación de esa línea
  // (ej. tag 'Inspección y Empaque' incluye 'T109 Inspección de Horneado').
  // Filtros adicionales por nombre dentro del tag:
  const NAME_FILTERS = {
    enracado: null,
    secado: null,
    inspEmpaque: /inspecci[oó]n\s+y\s+empaque/i
  };

  // processName → "T<n>" line code (158 entradas, generado de 1._Proceso - Tratamientos Genericos.xlsx)
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

  // Catálogos runtime de nodos compartidos descubiertos vía AllProcesses
  let _nodesByName = null;   // Map<normName, id>
  let _namesById = null;     // Map<id, displayName>
  // _sharedByOp: { enracado: Map<lineCode, [{id,name}, ...]>, secado, inspEmpaque }
  // Una línea puede tener múltiples variantes en un mismo tag (ej. T102 tiene
  // 'Secando Manual – Desenracado' Y 'Secando Centrífugo' bajo el tag Secado);
  // cada proceso usa la variante que aplica. Por eso guardamos un array.
  let _sharedByOp = null;

  // Normaliza para lookup case-insensitive: colapsa espacios, baja a lowercase y
  // remueve diacríticos (Inspección ≡ Inspeccion). NFD descompone tilde+letra y
  // \p{Diacritic} matchea el modificador para borrarlo.
  function normName(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function lookupNodeId(name) {
    if (!_nodesByName) return null;
    return _nodesByName.get(normName(name)) || null;
  }

  function lookupNodeName(id) {
    if (!_namesById) return null;
    return _namesById.get(id) || null;
  }

  // Devuelve TODAS las variantes ([{id,name}, ...]) de un tag para una línea.
  // Vacío si la línea no tiene mapeos. El llamador decide cuál usar (preservar
  // existente vs. elegir uno).
  function lookupSharedVariants(op, lineCode) {
    if (!_sharedByOp || !lineCode) return [];
    const m = _sharedByOp[op];
    if (!m) return [];
    return m.get(String(lineCode).toUpperCase()) || [];
  }

  // Devuelve true si `id` es una variante canónica de `op` para `lineCode`.
  function isLineCanonAt(op, lineCode, id) {
    if (id == null) return false;
    return lookupSharedVariants(op, lineCode).some(v => v.id === id);
  }

  function getLineCode(processName) {
    if (LINE_MAPPING[processName]) return LINE_MAPPING[processName];
    // Fallback: derivar el code del nombre cuando no esté en el mapping del Excel
    // (ej. procesos creados después de la última regeneración del JSON).
    // Solo aceptamos si todos los matches del nombre coinciden — para procesos
    // compuestos como "T100 (PUL)-T103 (CRD)..." no podemos adivinar la línea.
    const codes = Array.from(String(processName || '').matchAll(/\b(T\d{2,4}|M\d{2,4})\b/g))
      .map(m => m[1].toUpperCase());
    if (!codes.length) return null;
    const uniq = new Set(codes);
    return uniq.size === 1 ? codes[0] : null;
  }

  // ── Carga del catálogo de nodos compartidos ──
  // Los SP SUB_PROCESS viven con types ['PROCESS','SUB_PROCESS']. 'SP Embarque
  // en Almacén' es STEP_SHIPPING y requiere una pasada extra. Carga todo en
  // una sola pasada paginada por cada lista de tipos.
  async function loadAllNodes(onProgress) {
    const byName = new Map();
    const byId = new Map();
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
          orderBy: ['ID_DESC'],
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
          if (!byName.has(k)) byName.set(k, n.id);
          if (!byId.has(n.id)) byId.set(n.id, n.name);
        }
        if (onProgress) onProgress(`Cargando catálogo (${pass.label})... ${byName.size}`);
        if (nodes.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      total += (passTotal ?? 0);
    }
    _nodesByName = byName;
    _namesById = byId;
    log(`  Catálogo: ${byName.size} nodos (PROCESS+SUB_PROCESS+STEP_SHIPPING, totalCount=${total || '?'}).`);
    return { byName, total };
  }

  // Búsqueda por nombre exacto vía searchQuery sobre ProcessesComponentQuery
  // (fallback cuando un compartido no está en la primera página del catálogo).
  async function searchNodeByName(name) {
    try {
      const data = await api().query('ProcessesComponentQuery', {
        includeArchived: 'NO',
        processNodeTypes: ['PROCESS', 'SUB_PROCESS'],
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

  // Carga complementaria de SCANNER_NODE para poblar _namesById. Los
  // 'T<linea> Listo para Procesar' son LOCALES por proceso (tipo SCANNER_NODE),
  // no aparecen en el catálogo PROCESS+SUB_PROCESS y por eso extractTopLevel
  // no resuelve su name. Con esta carga, lookupNodeName(id) los encuentra y
  // detectCanonStatus puede matchear "Listo para Procesar" en posición 4.
  async function loadScannerNodes(onProgress) {
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
        // Solo poblar id→name. NO tocar _nodesByName: muchos scanner_nodes
        // comparten nombre ('T102 Listo para Procesar' existe en cada proceso
        // T102) y no queremos que un local oculte un global homónimo.
        if (!_namesById.has(n.id)) _namesById.set(n.id, n.name);
      }
      total += nodes.length;
      if (onProgress) onProgress(`Cargando scanner_nodes... ${total}`);
      if (nodes.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    log(`  Scanner nodes: ${total} cargados en _namesById`);
  }

  // ── Discovery de compartidos por línea (tag-based) ──
  // Por cada operación (enracado, secado, inspEmpaque), localiza el tag por
  // patrón de nombre y pagina ProcessesWithTag para construir el map
  // lineCode → {id, name}.
  function extractLineCodeFromName(name) {
    const m = String(name || '').trim().match(/^(T\d{2,4}|M\d{2,4})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  async function loadSharedByLine(onProgress) {
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
        const sample = tagsList.slice(0, 30).map(t => `<li><code>${escapeHtml(t?.name || '?')}</code> (id ${t?.id ?? '?'})</li>`).join('');
        const err = new Error(`Tag de operación '${op}' no encontrado.`);
        err.diagnostic = `<p>Patrón buscado: <code>${escapeHtml(String(re))}</code></p><p>Catálogo de tags (${tagsList.length} totales, primeros 30):</p><ul style="font-size:11px;line-height:1.5">${sample}</ul>`;
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
          // Multi-variante: una línea puede tener varios nodos en un mismo tag
          // (ej. T102 → 'Secando Manual – Desenracado' y 'Secando Centrífugo').
          // Acumulamos todos para que cada proceso pueda usar la suya.
          let arr = sharedByOp[op].get(code);
          if (!arr) { arr = []; sharedByOp[op].set(code, arr); }
          if (!arr.some(v => v.id === n.id)) {
            arr.push({ id: n.id, name: n.name });
            _nodesByName.set(normName(n.name), n.id);
            _namesById.set(n.id, n.name);
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
    return sharedByOp;
  }

  // Verifica que los 5 globales existen. Si alguno falta tras `loadAllNodes`,
  // intenta `searchNodeByName` como fallback antes de tirar el error.
  async function validateGlobals() {
    let missing = GLOBALS.filter(g => !lookupNodeId(g));
    if (missing.length) {
      // Fallback: search por nombre directo para cada faltante
      for (const g of missing) {
        const n = await searchNodeByName(g);
        if (n) {
          _nodesByName.set(normName(n.name), n.id);
          _namesById.set(n.id, n.name);
        }
      }
      missing = GLOBALS.filter(g => !lookupNodeId(g));
    }
    if (missing.length) {
      // Diagnostic: lista los 10 nodos con mayor similitud para cada faltante
      const allNames = Array.from(_nodesByName.keys());
      const suggestions = missing.map(g => {
        const target = normName(g);
        const tokens = target.split(' ').filter(t => t.length > 3);
        const scored = allNames
          .map(n => ({ n, score: tokens.reduce((s, t) => s + (n.includes(t) ? 1 : 0), 0) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
        return `<b>${escapeHtml(g)}</b>: ${scored.length ? scored.map(s => `<code>${escapeHtml(_namesById.get(_nodesByName.get(s.n)) || s.n)}</code>`).join(', ') : '<i>sin coincidencias</i>'}`;
      });
      const total = _nodesByName.size;
      const err = new Error(`Faltan nodos globales: ${missing.join(', ')}.`);
      err.diagnostic = `<p>Catálogo cargado: <b>${total}</b> nodos.</p><p>Para cada faltante, los nombres más cercanos en el catálogo:</p><ul style="font-size:12px;line-height:1.6"><li>${suggestions.join('</li><li>')}</li></ul><p style="font-size:12px;color:#94a3b8">Si los nombres correctos están arriba pero distintos, ajusta la constante <code>GLOBALS</code> en <code>process-canon.js</code>. Si no aparecen, créalos en Steelhead.</p>`;
      throw err;
    }
  }

  // ── Pull de procesos ──
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

  async function fetchProcessTree(id) {
    const data = await api().query('GetProcessNode', {
      id, processNodeOccurrence: 1, rootId: id
    }, 'GetProcessNode');
    return data?.treeRoot || null;
  }

  // Convención del schema de Steelhead (verificada empíricamente 2026-05-04):
  // descendantRelationships modela `child → parent` con la columna toId apuntando
  // al PADRE y el embed processNodeByFromId conteniendo los datos del HIJO
  // (id, name, type). Helpers para no acoplarnos al naming postgraphile.
  const relParentId = (r) => r?.toId;
  const relChildId  = (r) => r?.processNodeByFromId?.id;
  const relChildName = (r) => r?.processNodeByFromId?.name;

  // Filtra descendantRelationships a las que viven dentro del proceso (BFS desde rootId).
  // Un nodo compartido aparece en árboles ajenos, así que solo seguimos por nodos ya visitados.
  function bfsRelationships(rootId, allRels) {
    const byParent = new Map(); // parentId → [rel]
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

  // Resuelve el nombre de un node id desde el embed del rel; fallback a catálogo.
  function resolveNodeName(rel, id) {
    return relChildName(rel) || lookupNodeName(id) || '';
  }

  function extractTopLevel(treeRoot) {
    if (!treeRoot) return [];
    const rootId = treeRoot.id;
    const rels = treeRoot.descendantRelationships || [];
    const top = rels
      .filter(r => relParentId(r) === rootId)
      .sort((a, b) => (a.childInd || 0) - (b.childInd || 0));
    return top.map(r => ({ id: relChildId(r), name: resolveNodeName(r, relChildId(r)) }));
  }

  // ── Detección de canon ──
  // Canon de 9 nodos top-level (verificado en T102 (EST)-AL-VARIOS, 2026-05-04):
  //   pos 0: SP Inspección Recibo                       (global)
  //   pos 1: SP Preparación de Surtido en Almacén       (global)
  //   pos 2: T<n> Enracado/Carga de Barril              (por línea, multi-variante)
  //   pos 3: T<n> Listo para Procesar                   (local, match por nombre)
  //   pos 4: T<n>-SE00-001 Secando ...                  (por línea, multi-variante)
  //   pos 5: T<n> Inspección y Empaque                  (por línea, multi-variante)
  //   pos 6: SP Preparación de Embarque en Almacén      (global)
  //   pos 7: SP Inspección de Calidad Embarques         (global)
  //   pos 8: SP Embarque en Almacén                     (global, type STEP_SHIPPING)
  //
  // Para los compartidos por línea, una misma línea puede tener varias variantes
  // en el tag (ej. T102 → 'Secando Manual – Desenracado' Y 'Secando Centrífugo'),
  // y cada proceso usa la suya. La detección acepta CUALQUIER variante del Set.
  function detectCanonStatus(process, treeRoot) {
    const topLevel = extractTopLevel(treeRoot);
    const lineCode = getLineCode(process.name);
    if (!lineCode) {
      return {
        isCanon: false,
        lineCodeMissing: true,
        topLevel,
        expected: [],
        missingShared: [],
        extras: topLevel,
        reason: 'Línea desconocida (no está en el mapping del Excel)'
      };
    }

    const enracadoVariants    = lookupSharedVariants('enracado', lineCode);
    const secadoVariants      = lookupSharedVariants('secado', lineCode);
    const inspEmpaqueVariants = lookupSharedVariants('inspEmpaque', lineCode);

    const idInsRecibo     = lookupNodeId('SP Inspección Recibo');
    const idPrepSurtido   = lookupNodeId('SP Preparación de Surtido en Almacén');
    const idPrepEmbarque  = lookupNodeId('SP Preparación de Embarque en Almacén');
    const idInspEmbarques = lookupNodeId('SP Inspección de Calidad Embarques');
    const idEmbarqueAlm   = lookupNodeId('SP Embarque en Almacén');

    const missingShared = [];
    if (!enracadoVariants.length)    missingShared.push(`Enracado ${lineCode}`);
    if (!secadoVariants.length)      missingShared.push(`Secado ${lineCode}`);
    if (!inspEmpaqueVariants.length) missingShared.push(`Inspección y Empaque ${lineCode}`);

    const lineCodeNorm = normName(lineCode);
    const isListoMatch = (t) => {
      const n = normName(t?.name || '');
      return n.includes(lineCodeNorm) && /listo para procesar/.test(n);
    };
    const existingListo = topLevel.find(isListoMatch) || null;
    const hasListoPP = !!existingListo;

    // Para mostrar en el "esperado" preferimos el nombre real que el proceso
    // tiene en esa posición si es una variante válida; si no, primera variante
    // del Set; si tampoco hay, placeholder.
    const pickDisplayForLine = (idx, op, label) => {
      const t = topLevel[idx];
      if (t && isLineCanonAt(op, lineCode, t.id)) return t.name;
      const arr = lookupSharedVariants(op, lineCode);
      return arr.length ? arr[0].name : `(falta) ${label} ${lineCode}`;
    };

    const expectedDisplay = [
      'SP Inspección Recibo',
      'SP Preparación de Surtido en Almacén',
      pickDisplayForLine(2, 'enracado',    'Enracado'),
      listoPPName(lineCode),
      pickDisplayForLine(4, 'secado',      'Secado'),
      pickDisplayForLine(5, 'inspEmpaque', 'Inspección y Empaque'),
      'SP Preparación de Embarque en Almacén',
      'SP Inspección de Calidad Embarques',
      'SP Embarque en Almacén'
    ];

    // Validador por posición: globales por ID exacto; por-línea por Set de
    // variantes; Listo PP por nombre flexible.
    const slotMatches = (i) => {
      const t = topLevel[i];
      if (!t) return false;
      switch (i) {
        case 0: return idInsRecibo     && t.id === idInsRecibo;
        case 1: return idPrepSurtido   && t.id === idPrepSurtido;
        case 2: return isLineCanonAt('enracado', lineCode, t.id);
        case 3: return isListoMatch(t);
        case 4: return isLineCanonAt('secado', lineCode, t.id);
        case 5: return isLineCanonAt('inspEmpaque', lineCode, t.id);
        case 6: return idPrepEmbarque  && t.id === idPrepEmbarque;
        case 7: return idInspEmbarques && t.id === idInspEmbarques;
        case 8: return idEmbarqueAlm   && t.id === idEmbarqueAlm;
      }
      return false;
    };

    let isCanon = topLevel.length === 9;
    if (isCanon) {
      for (let i = 0; i < 9; i++) {
        if (!slotMatches(i)) { isCanon = false; break; }
      }
    }

    // extras: top-levels que no caen en NINGÚN slot canónico (no son ninguno
    // de los 5 globales, ni Listo PP, ni variante válida de su línea).
    const isAnyCanonical = (t) => {
      if (!t) return false;
      if (idInsRecibo     && t.id === idInsRecibo)     return true;
      if (idPrepSurtido   && t.id === idPrepSurtido)   return true;
      if (idPrepEmbarque  && t.id === idPrepEmbarque)  return true;
      if (idInspEmbarques && t.id === idInspEmbarques) return true;
      if (idEmbarqueAlm   && t.id === idEmbarqueAlm)   return true;
      if (isListoMatch(t)) return true;
      if (isLineCanonAt('enracado',    lineCode, t.id)) return true;
      if (isLineCanonAt('secado',      lineCode, t.id)) return true;
      if (isLineCanonAt('inspEmpaque', lineCode, t.id)) return true;
      return false;
    };
    const extras = topLevel.filter(t => !isAnyCanonical(t));

    let reason = '';
    if (isCanon) reason = 'OK';
    else if (missingShared.length) reason = `Faltan compartidos: ${missingShared.join(', ')}`;
    else if (topLevel.length < 9 && !extras.length) reason = `Faltan nodos canónicos (${topLevel.length}/9)`;
    else if (extras.length) reason = `Fuera de orden, ${extras.length} extras`;
    else reason = 'Fuera de orden';

    return {
      isCanon,
      lineCodeMissing: false,
      lineCode,
      topLevel,
      expected: expectedDisplay,
      missingShared,
      extras,
      hasListoPP,
      reason
    };
  }

  // ── Construcción del nuevo árbol ──
  // Toma allRels (filtrados con BFS) y reconstruye un sub-árbol para cada nodo,
  // luego devuelve {id: rootId, children: [...canonical, ...extras], specId: null}
  function buildNewTree(rootId, canonicalIds, extraIds, allRels) {
    const byParent = new Map();
    for (const r of allRels) {
      const p = relParentId(r);
      if (p == null) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(r);
    }

    const visited = new Set();
    function buildSubtree(nodeId) {
      if (visited.has(nodeId)) return { id: nodeId, children: [], specId: null };
      visited.add(nodeId);
      const childRels = (byParent.get(nodeId) || []).slice().sort((a, b) => (a.childInd || 0) - (b.childInd || 0));
      const children = [];
      for (const r of childRels) {
        const cid = relChildId(r);
        if (cid == null) continue;
        const sub = buildSubtree(cid);
        if (r.specId !== undefined) sub.specId = r.specId ?? null;
        children.push(sub);
      }
      return { id: nodeId, children, specId: null };
    }

    visited.add(rootId);
    const childrenAll = [...canonicalIds, ...extraIds].map(id => buildSubtree(id));
    return { id: rootId, children: childrenAll, specId: null };
  }

  // ── Mutaciones ──
  async function createListoParaProcesar(lineCode) {
    const data = await api().query('CreateProcessNode', {
      type: 'SCANNER_NODE',
      name: listoPPName(lineCode),
      autoComplete: false
    }, 'CreateProcessNode');
    const id = data?.createProcessNode?.processNode?.id;
    if (!id) throw new Error(`CreateProcessNode no devolvió id para ${listoPPName(lineCode)}`);
    return id;
  }

  async function applyCanonToProcess(process, status) {
    const result = { processId: process.id, name: process.name, lineCode: status.lineCode };

    // Refrescar árbol justo antes de aplicar (snapshot fresco)
    const treeRoot = await fetchProcessTree(process.id);
    if (!treeRoot) return { ...result, success: false, skipped: true, reason: 'No se pudo obtener el árbol del proceso' };
    result.snapshot = treeRoot;

    if (status.lineCodeMissing) return { ...result, success: false, skipped: true, reason: 'Línea desconocida' };
    if (status.missingShared?.length) return { ...result, success: false, skipped: true, reason: `Faltan compartidos: ${status.missingShared.join(', ')}` };

    const lineCode = status.lineCode;
    const allRels = bfsRelationships(process.id, treeRoot.descendantRelationships || []);
    const topLevelFresh = extractTopLevel(treeRoot);

    // 5 globales + 3 por-línea (multi-variante) + 1 local (Listo PP) = 9 nodos.
    const idInsRecibo     = lookupNodeId('SP Inspección Recibo');
    const idPrepSurtido   = lookupNodeId('SP Preparación de Surtido en Almacén');
    const idPrepEmbarque  = lookupNodeId('SP Preparación de Embarque en Almacén');
    const idInspEmbarques = lookupNodeId('SP Inspección de Calidad Embarques');
    const idEmbarqueAlm   = lookupNodeId('SP Embarque en Almacén');

    if (!idInsRecibo || !idPrepSurtido || !idPrepEmbarque || !idInspEmbarques || !idEmbarqueAlm) {
      return { ...result, success: false, skipped: true, reason: 'No se resolvieron todos los IDs globales' };
    }

    // Por-línea: si el proceso ya tiene una variante válida (en el Set del tag
    // para esa línea), preservarla. Si no, escoger la primera variante del Set
    // como default. Esto evita "T102 (EST) usa Centrífugo" → forzar a "Manual".
    const pickLineId = (op, posIdx) => {
      const existing = topLevelFresh[posIdx];
      if (existing && isLineCanonAt(op, lineCode, existing.id)) return existing.id;
      // Fallback: cualquier top-level del proceso que sea variante válida
      const anyExisting = topLevelFresh.find(t => isLineCanonAt(op, lineCode, t.id));
      if (anyExisting) return anyExisting.id;
      // Sin existente: default = primera variante del Set
      const variants = lookupSharedVariants(op, lineCode);
      return variants[0]?.id || null;
    };
    const idEnracado    = pickLineId('enracado',    2);
    const idSecado      = pickLineId('secado',      4);
    const idInspEmpaque = pickLineId('inspEmpaque', 5);

    if (!idEnracado || !idSecado || !idInspEmpaque) {
      return { ...result, success: false, skipped: true, reason: 'No se resolvieron variantes por-línea' };
    }

    // Listo para Procesar: reusar si ya existe top-level, si no crear.
    // Match flexible para detectar legacy y evitar crear duplicados.
    const lineCodeNorm = normName(lineCode);
    const existingListo = topLevelFresh.find(t => {
      const n = normName(t.name);
      return n.includes(lineCodeNorm) && /listo para procesar/.test(n);
    });
    let idListo;
    if (existingListo) {
      idListo = existingListo.id;
    } else {
      idListo = await createListoParaProcesar(lineCode);
      log(`  ${process.name}: creado "${listoPPName(lineCode)}" id:${idListo}`);
    }

    // Orden canónico de 9 (matchea posiciones esperadas en detectCanonStatus).
    const canonicalIds = [
      idInsRecibo, idPrepSurtido, idEnracado, idListo,
      idSecado, idInspEmpaque, idPrepEmbarque, idInspEmbarques, idEmbarqueAlm
    ];

    // Validaciones de seguridad antes de tocar ProcureTree
    const distinct = new Set(canonicalIds);
    if (distinct.size !== canonicalIds.length) {
      return { ...result, success: false, skipped: true, reason: 'IDs canónicos duplicados (compartidos colisionan)' };
    }
    if (canonicalIds.some(id => !id)) {
      return { ...result, success: false, skipped: true, reason: 'ID canónico nulo detectado' };
    }

    // extras = top-level que NO están en canonicalIds (preservar como apéndice)
    const canonicalSet = new Set(canonicalIds);
    const extraIds = topLevelFresh.filter(t => !canonicalSet.has(t.id)).map(t => t.id);

    const newTree = buildNewTree(process.id, canonicalIds, extraIds, allRels);

    try {
      const data = await api().query('ProcureTree', { tree: newTree }, 'ProcureTree');
      const ok = data?.procureProcessTree2?.processTree?.id === process.id;
      if (!ok) return { ...result, success: false, skipped: false, reason: 'ProcureTree no confirmó éxito' };
      return { ...result, success: true, createdListoId: existingListo ? null : idListo };
    } catch (e) {
      return { ...result, success: false, skipped: false, reason: `ProcureTree falló: ${String(e.message).substring(0, 200)}` };
    }
  }

  // ── Worker pool ──
  async function runPool(items, concurrency, worker, onProgress) {
    const results = [];
    let cursor = 0;
    let done = 0;
    async function loop() {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          const r = await worker(items[i], i);
          results[i] = r;
        } catch (e) {
          results[i] = { error: e.message };
        }
        done++;
        if (onProgress) onProgress(done, items.length, items[i], results[i]);
      }
    }
    const ws = [];
    for (let i = 0; i < concurrency; i++) ws.push(loop());
    await Promise.all(ws);
    return results;
  }

  // ── UI: estilos ──
  function injectStyles() {
    if (document.getElementById('pcanon-styles')) return;
    const s = document.createElement('style');
    s.id = 'pcanon-styles';
    s.textContent = `
      .pc-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.65);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .pc-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:24px 28px;max-width:1100px;width:94%;max-height:88vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
      .pc-modal h2{font-size:20px;margin:0 0 6px;color:#38bdf8}
      .pc-modal h3{font-size:14px;margin:14px 0 6px;color:#94a3b8;font-weight:600}
      .pc-sub{color:#94a3b8;font-size:12px;margin-bottom:10px}
      .pc-paste{display:flex;gap:8px;margin-bottom:10px}
      .pc-paste textarea{flex:1;min-height:60px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
      .pc-input{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px 8px;font-size:12px}
      .pc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .pc-table-wrap{max-height:46vh;overflow-y:auto;border:1px solid #334155;border-radius:6px}
      .pc-table{width:100%;border-collapse:collapse;font-size:12px}
      .pc-table th{position:sticky;top:0;background:#1a2236;color:#94a3b8;text-align:left;padding:6px 8px;font-weight:600;border-bottom:1px solid #334155;z-index:1}
      .pc-table td{padding:5px 8px;border-bottom:1px solid #1e293b;vertical-align:top}
      .pc-table tr.pc-ok td{color:#94a3b8}
      .pc-table tr.pc-bad td{color:#e2e8f0}
      .pc-table tr.pc-disabled td{color:#475569}
      .pc-status-ok{color:#4ade80;font-weight:600}
      .pc-status-bad{color:#f87171;font-weight:600}
      .pc-status-warn{color:#fbbf24;font-weight:600}
      .pc-chip{display:inline-block;padding:2px 8px;background:#312e81;color:#c7d2fe;border-radius:10px;font-size:11px;margin:2px 4px 2px 0;cursor:pointer}
      .pc-chip:hover{background:#1e1b4b}
      .pc-btnrow{display:flex;gap:10px;margin-top:14px;justify-content:flex-end;flex-wrap:wrap}
      .pc-btn{padding:9px 18px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer}
      .pc-btn-cancel{background:#475569;color:#e2e8f0}
      .pc-btn-go{background:#38bdf8;color:#0f172a}
      .pc-btn-danger{background:#ef4444;color:#fff}
      .pc-btn-soft{background:#0f172a;color:#94a3b8;border:1px solid #334155}
      .pc-bar{height:4px;background:#0f172a;border-radius:3px;overflow:hidden;margin:6px 0}
      .pc-bar-fill{height:100%;background:#38bdf8;width:0%;transition:width 0.3s}
      .pc-pre{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px;font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;max-height:160px;overflow:auto;color:#cbd5e1;white-space:pre-wrap;word-break:break-all}
    `;
    document.head.appendChild(s);
  }

  function removeOverlay() {
    const ov = document.getElementById('pcanon-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  function setOverlay(html) {
    injectStyles();
    let ov = document.getElementById('pcanon-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'pcanon-overlay';
      ov.className = 'pc-overlay';
      document.body.appendChild(ov);
    }
    ov.innerHTML = `<div class="pc-modal">${html}</div>`;
    return ov.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ── Pegado de lista de Excel ──
  function parsePastedList(text) {
    const tokens = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const cols = line.split(/\t/);
      for (const c of cols) {
        const t = c.trim();
        if (!t) continue;
        const tu = t.toLowerCase();
        if (tu === 'proceso' || tu === 'línea' || tu === 'linea' || tu === 'nombre de la línea' || tu === 'nombre de la linea') continue;
        tokens.push(t);
      }
    }
    return [...new Set(tokens)];
  }

  // Tries to match a token to a process name
  function matchToken(token, processes) {
    const tnorm = normName(token);
    // 1) Match exacto contra process.name
    let m = processes.find(p => normName(p.name) === tnorm);
    if (m) return m;
    // 2) Match contra Nombre de la Línea (LINE_MAPPING key sin prefijo "T<n>-LI ")
    //    En el Excel la columna C es "T101-LI Cromo Decorativo (4.0)" donde el sufijo
    //    después del "-LI " se parece al nombre del proceso. Pero el processName real
    //    está en col D. Si pegan col C, hacemos best-effort por coincidencia parcial.
    m = processes.find(p => normName(p.name).includes(tnorm) || tnorm.includes(normName(p.name)));
    return m || null;
  }

  // ── Render: selección ──
  function renderSelection(rows, onConfirm, onCancel) {
    const visibleRows = rows.filter(r => !r.status.isCanon);
    let showCanon = false;
    let textFilter = '';
    let selected = new Set();
    let unmatched = [];

    function paintRow(r) {
      const s = r.status;
      const lineCol = s.lineCode || '<i style="color:#fbbf24">?</i>';
      let stEl, stClass;
      if (s.isCanon) { stEl = 'OK'; stClass = 'pc-status-ok'; }
      else if (s.lineCodeMissing) { stEl = 'Línea desconocida'; stClass = 'pc-status-warn'; }
      else if (s.missingShared.length) { stEl = `Falta: ${s.missingShared.join(', ')}`; stClass = 'pc-status-warn'; }
      else if (!s.hasListoPP) { stEl = 'Falta Listo para Procesar'; stClass = 'pc-status-bad'; }
      else { stEl = 'Fuera de orden'; stClass = 'pc-status-bad'; }
      const enabled = !s.isCanon && !s.lineCodeMissing && s.missingShared.length === 0;
      const cls = s.isCanon ? 'pc-ok' : (enabled ? 'pc-bad' : 'pc-disabled');
      const checkbox = enabled
        ? `<input type="checkbox" class="pc-row-check" data-id="${r.process.id}" ${selected.has(r.process.id) ? 'checked' : ''}>`
        : `<input type="checkbox" disabled title="No se puede normalizar (línea desconocida o compartidos faltantes)">`;
      const detail = s.extras?.length ? `${s.extras.length} extras: ${s.extras.slice(0,3).map(e => escapeHtml(e.name)).join(', ')}${s.extras.length > 3 ? '…' : ''}` : '';
      return `<tr class="${cls}">
        <td>${checkbox}</td>
        <td>${escapeHtml(r.process.name)}</td>
        <td>${lineCol}</td>
        <td><span class="${stClass}">${escapeHtml(stEl)}</span></td>
        <td style="color:#64748b;font-size:11px">${escapeHtml(detail)}</td>
      </tr>`;
    }

    function renderTable() {
      const filtered = (showCanon ? rows : rows.filter(r => !r.status.isCanon))
        .filter(r => !textFilter || normName(r.process.name).includes(normName(textFilter)));
      const tbody = filtered.map(paintRow).join('');
      const totalNon = rows.filter(r => !r.status.isCanon).length;
      const totalCanon = rows.length - totalNon;
      return `
        <h3>Procesos (${filtered.length} mostrados — ${rows.length} totales — ${totalCanon} OK / ${totalNon} no canónicos)</h3>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr>
              <th><input type="checkbox" id="pc-select-all" title="Seleccionar todos los visibles"></th>
              <th>Proceso</th>
              <th>Línea</th>
              <th>Estado</th>
              <th>Detalle</th>
            </tr></thead>
            <tbody id="pc-tbody">${tbody}</tbody>
          </table>
        </div>`;
    }

    function refresh() {
      const wrap = document.getElementById('pc-table-wrap');
      if (wrap) wrap.outerHTML = `<div id="pc-table-wrap">${renderTable()}</div>`;
      bindRowEvents();
      updateCount();
    }

    function bindRowEvents() {
      document.querySelectorAll('.pc-row-check').forEach(cb => {
        cb.onchange = () => {
          const id = parseInt(cb.dataset.id);
          if (cb.checked) selected.add(id); else selected.delete(id);
          updateCount();
        };
      });
      const sa = document.getElementById('pc-select-all');
      if (sa) sa.onchange = () => {
        document.querySelectorAll('.pc-row-check').forEach(cb => {
          cb.checked = sa.checked;
          const id = parseInt(cb.dataset.id);
          if (sa.checked) selected.add(id); else selected.delete(id);
        });
        updateCount();
      };
    }

    function updateCount() {
      const n = selected.size;
      const goBtn = document.getElementById('pc-go');
      if (goBtn) {
        goBtn.textContent = `APLICAR (${n})`;
        goBtn.disabled = n === 0;
        goBtn.style.opacity = n === 0 ? '0.5' : '1';
      }
    }

    function renderUnmatched() {
      if (!unmatched.length) return '';
      return `<div style="margin:6px 0;font-size:12px;color:#fbbf24">No emparejados (${unmatched.length}): ${unmatched.slice(0, 10).map(u => `<span class="pc-chip" title="quitar">${escapeHtml(u)}</span>`).join('')}${unmatched.length > 10 ? '…' : ''}</div>`;
    }

    function renderRoot() {
      return `
        <h2>🏭 Canon de Procesos</h2>
        <div class="pc-sub">Detecta procesos cuyo orden top-level no coincide con el patrón canónico de 9 nodos. Aplica el patrón a los seleccionados.</div>
        <h3>Pegar lista (Excel: una columna)</h3>
        <div class="pc-paste">
          <textarea id="pc-paste" placeholder="Pega aquí los nombres de proceso (uno por línea o desde una columna de Excel)..."></textarea>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="pc-btn pc-btn-go" id="pc-paste-apply">Aplicar selección</button>
            <button class="pc-btn pc-btn-soft" id="pc-paste-clear">Limpiar</button>
          </div>
        </div>
        <div id="pc-paste-summary" class="pc-sub"></div>
        <div id="pc-unmatched">${renderUnmatched()}</div>
        <div class="pc-row" style="margin:6px 0">
          <input type="text" id="pc-filter" class="pc-input" placeholder="Filtrar por nombre..." style="flex:1">
          <label style="font-size:12px;color:#94a3b8"><input type="checkbox" id="pc-show-canon"> Mostrar canónicos</label>
        </div>
        <div id="pc-table-wrap">${renderTable()}</div>
        <div class="pc-btnrow">
          <button class="pc-btn pc-btn-cancel" id="pc-cancel">CANCELAR</button>
          <button class="pc-btn pc-btn-go" id="pc-go" disabled>APLICAR (0)</button>
        </div>`;
    }

    setOverlay(renderRoot());
    bindRowEvents();
    updateCount();

    document.getElementById('pc-paste-apply').onclick = () => {
      const txt = document.getElementById('pc-paste').value;
      const tokens = parsePastedList(txt);
      const matched = [];
      const um = [];
      for (const tok of tokens) {
        const p = matchToken(tok, rows.map(r => r.process));
        if (!p) { um.push(tok); continue; }
        const r = rows.find(x => x.process.id === p.id);
        if (!r) { um.push(tok); continue; }
        const enabled = !r.status.isCanon && !r.status.lineCodeMissing && r.status.missingShared.length === 0;
        if (!enabled) { um.push(tok); continue; }
        selected.add(p.id);
        matched.push(p.name);
      }
      unmatched = um;
      const summary = document.getElementById('pc-paste-summary');
      if (summary) summary.innerHTML = `<span style="color:#4ade80">✓ ${matched.length} preseleccionados</span>${um.length ? ` <span style="color:#f87171">— ✗ ${um.length} no encontrados</span>` : ''}`;
      const unEl = document.getElementById('pc-unmatched');
      if (unEl) unEl.innerHTML = renderUnmatched();
      refresh();
    };

    document.getElementById('pc-paste-clear').onclick = () => {
      document.getElementById('pc-paste').value = '';
      const summary = document.getElementById('pc-paste-summary');
      if (summary) summary.innerHTML = '';
      unmatched = [];
      const unEl = document.getElementById('pc-unmatched');
      if (unEl) unEl.innerHTML = '';
    };

    document.getElementById('pc-filter').oninput = (e) => { textFilter = e.target.value; refresh(); };
    document.getElementById('pc-show-canon').onchange = (e) => { showCanon = e.target.checked; refresh(); };

    document.getElementById('pc-cancel').onclick = () => { removeOverlay(); onCancel(); };
    document.getElementById('pc-go').onclick = () => {
      const chosen = rows.filter(r => selected.has(r.process.id));
      onConfirm(chosen);
    };
  }

  function renderConfirm(chosen, onYes, onNo) {
    const list = chosen.map(r => `<li>${escapeHtml(r.process.name)} <span style="color:#94a3b8">(${r.status.lineCode})</span></li>`).join('');
    setOverlay(`
      <h2 style="color:#fbbf24">⚠️ Confirmación</h2>
      <p style="color:#cbd5e1;font-size:13px">Esta acción <b>reemplaza el árbol top-level</b> de los siguientes ${chosen.length} procesos. El árbol previo se guarda como snapshot descargable para rollback manual.</p>
      <div style="max-height:38vh;overflow:auto;border:1px solid #334155;border-radius:6px;padding:8px 12px;background:#0f172a;font-size:12px">
        <ol style="margin:0;padding-left:20px">${list}</ol>
      </div>
      <div class="pc-btnrow">
        <button class="pc-btn pc-btn-cancel" id="pc-back">VOLVER</button>
        <button class="pc-btn pc-btn-danger" id="pc-confirm">CONFIRMAR Y APLICAR</button>
      </div>`);
    document.getElementById('pc-back').onclick = onNo;
    document.getElementById('pc-confirm').onclick = onYes;
  }

  function renderProgress(total) {
    setOverlay(`
      <h2>🏭 Aplicando canon...</h2>
      <div id="pc-prog-text" style="font-size:13px;color:#cbd5e1">0/${total}</div>
      <div class="pc-bar"><div class="pc-bar-fill" id="pc-prog-bar"></div></div>
      <div id="pc-prog-current" class="pc-sub">Iniciando...</div>
      <div id="pc-prog-list" class="pc-pre" style="margin-top:8px"></div>
    `);
  }

  function updateProgress(done, total, currentName, lastResult) {
    const bar = document.getElementById('pc-prog-bar');
    const txt = document.getElementById('pc-prog-text');
    const cur = document.getElementById('pc-prog-current');
    const list = document.getElementById('pc-prog-list');
    if (bar) bar.style.width = `${Math.round(done / total * 100)}%`;
    if (txt) txt.textContent = `${done}/${total}`;
    if (cur) cur.textContent = currentName ? `Última: ${currentName}` : '';
    if (list && lastResult) {
      const icon = lastResult.success ? '✓' : (lastResult.skipped ? '↷' : '✗');
      const color = lastResult.success ? '#4ade80' : (lastResult.skipped ? '#fbbf24' : '#f87171');
      const reason = lastResult.success ? 'OK' : (lastResult.reason || 'error');
      const line = document.createElement('div');
      line.style.color = color;
      line.textContent = `${icon} ${lastResult.name} — ${reason}`;
      list.appendChild(line);
      list.scrollTop = list.scrollHeight;
    }
  }

  function renderFinal(results) {
    const success = results.filter(r => r.success);
    const skipped = results.filter(r => !r.success && r.skipped);
    const failed = results.filter(r => !r.success && !r.skipped);

    function rowsFor(arr) {
      return arr.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.lineCode || '?')}</td><td>${r.success ? '<span class="pc-status-ok">✓ OK</span>' : (r.skipped ? '<span class="pc-status-warn">↷ saltado</span>' : '<span class="pc-status-bad">✗ error</span>')}</td><td style="color:#94a3b8">${escapeHtml(r.reason || '')}</td></tr>`).join('');
    }

    setOverlay(`
      <h2 style="color:#4ade80">🏭 Canon aplicado</h2>
      <div class="pc-sub">Total: ${results.length} — ✓ ${success.length} | ↷ ${skipped.length} | ✗ ${failed.length}</div>
      <div class="pc-table-wrap" style="max-height:60vh">
        <table class="pc-table">
          <thead><tr><th>Proceso</th><th>Línea</th><th>Resultado</th><th>Detalle</th></tr></thead>
          <tbody>${rowsFor([...success, ...skipped, ...failed])}</tbody>
        </table>
      </div>
      <div class="pc-btnrow">
        <button class="pc-btn pc-btn-soft" id="pc-download">📥 Descargar snapshots (rollback manual)</button>
        <button class="pc-btn pc-btn-go" id="pc-close">CERRAR</button>
      </div>`);

    document.getElementById('pc-download').onclick = () => {
      const out = {
        exportedAt: new Date().toISOString(),
        canonical: GLOBALS,
        results: results.map(r => ({
          processId: r.processId, name: r.name, lineCode: r.lineCode,
          success: r.success, skipped: r.skipped, reason: r.reason,
          createdListoId: r.createdListoId || null,
          snapshot: r.snapshot || null
        }))
      };
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toLocaleDateString('en-CA') + '_' + Date.now();
      a.download = `process-canon-snapshots_${stamp}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };
    document.getElementById('pc-close').onclick = removeOverlay;
  }

  // ── Orquestador ──
  async function run() {
    if (!api()) { alert('SteelheadAPI no disponible'); return { error: 'SteelheadAPI no disponible' }; }
    log('=== Process Canon ===');

    // Fase A — Carga
    setOverlay(`<h2>🏭 Canon de Procesos</h2><div id="pc-load" class="pc-sub">Cargando catálogo de nodos compartidos...</div>`);
    try {
      await loadAllNodes(msg => {
        const el = document.getElementById('pc-load');
        if (el) el.textContent = msg;
      });
      await validateGlobals();
      await loadSharedByLine(msg => {
        const el = document.getElementById('pc-load');
        if (el) el.textContent = msg;
      });
      await loadScannerNodes(msg => {
        const el = document.getElementById('pc-load');
        if (el) el.textContent = msg;
      });
    } catch (e) {
      const diag = e.diagnostic ? `<div style="margin-top:14px;padding:12px;background:#0f172a;border-radius:8px;border:1px solid #334155">${e.diagnostic}</div>` : '';
      setOverlay(`<h2 style="color:#f87171">Error</h2><p style="color:#cbd5e1">${escapeHtml(e.message)}</p>${diag}<div class="pc-btnrow"><button class="pc-btn pc-btn-cancel" id="pc-err-close">CERRAR</button></div>`);
      const closeBtn = document.getElementById('pc-err-close');
      if (closeBtn) closeBtn.onclick = removeOverlay;
      return { error: e.message };
    }

    const loadEl = document.getElementById('pc-load');
    if (loadEl) loadEl.textContent = 'Cargando lista de procesos...';
    let processes;
    try {
      processes = await fetchAllProcesses(msg => {
        const el = document.getElementById('pc-load');
        if (el) el.textContent = msg;
      });
    } catch (e) {
      setOverlay(`<h2 style="color:#f87171">Error</h2><p>${escapeHtml(e.message)}</p>`);
      return { error: e.message };
    }
    log(`  ${processes.length} procesos descubiertos`);

    // Auditar cada proceso (concurrencia)
    if (loadEl) loadEl.textContent = `Auditando 0/${processes.length}...`;
    const rows = [];
    let auditCursor = 0;
    let auditDone = 0;
    let auditNonCanon = 0;
    const auditWorker = async () => {
      while (auditCursor < processes.length) {
        const i = auditCursor++;
        const p = processes[i];
        try {
          const tree = await fetchProcessTree(p.id);
          const status = detectCanonStatus(p, tree);
          rows[i] = { process: p, status };
          if (!status.isCanon) auditNonCanon++;
        } catch (e) {
          rows[i] = { process: p, status: { isCanon: false, lineCodeMissing: false, missingShared: [], extras: [], reason: `Error: ${e.message.substring(0,60)}` } };
        }
        auditDone++;
        const el = document.getElementById('pc-load');
        if (el) el.textContent = `Auditando ${auditDone}/${processes.length} (${auditNonCanon} no canónicos)`;
      }
    };
    const auditWorkers = [];
    for (let i = 0; i < CONCURRENCY_AUDIT; i++) auditWorkers.push(auditWorker());
    await Promise.all(auditWorkers);
    log(`  Auditoría: ${auditNonCanon} no canónicos / ${rows.length} total`);

    // Fase B → C → D → E (loop entre selección y confirmación)
    return new Promise(resolve => {
      const cancel = () => { removeOverlay(); resolve({ cancelled: true }); };

      const showSelection = () => {
        renderSelection(rows, showConfirm, cancel);
      };

      const showConfirm = (chosen) => {
        renderConfirm(chosen, () => runApply(chosen), showSelection);
      };

      const runApply = async (chosen) => {
        renderProgress(chosen.length);
        const results = [];
        await runPool(chosen, CONCURRENCY_APPLY, async (r) => {
          const res = await applyCanonToProcess(r.process, r.status);
          results.push(res);
          return res;
        }, (done, total, item, last) => {
          updateProgress(done, total, last?.name || item.process.name, last);
        });
        log(`=== Canon: ${results.filter(x=>x.success).length}/${results.length} aplicados ===`);
        renderFinal(results);
        resolve({ total: results.length, success: results.filter(x=>x.success).length });
      };

      showSelection();
    });
  }

  return { run };
})();

if (typeof window !== 'undefined') window.ProcessCanon = ProcessCanon;
