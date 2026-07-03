// Steelhead Catalog Fetcher + Excel Template Generator
// Queries API for fresh catalogs, injects into Excel template, downloads
// Depends on: SteelheadAPI, XLSX (SheetJS)

const CatalogFetcher = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── Guard de integridad: listas vacías por fallo de query (p.ej. hash rotado) ──
  // Cuando Steelhead rota un persisted-query hash, api().query() lanza con
  // "Must provide a query string." La lista queda vacía y —sin este guard— la
  // plantilla se generaría con 0 items; al correr RefrescarListas SOBRESCRIBIRÍA
  // las listas buenas con vacíos. Acumulamos los fallos y bloqueamos/avisamos
  // ANTES de descargar. (Incidente 2026-07-03: rotaron AllCustomers y Customer →
  // carga masiva trajo 0 clientes sin avisar.)
  const HASH_ERR_RE = /must provide a query string|persistedquery(?:notfound)?/i;
  let _fetchIssues = [];
  function noteFetchIssue(catalog, op, e) {
    const msg = String((e && e.message) || e || '');
    const hashRotated = HASH_ERR_RE.test(msg);
    _fetchIssues.push({ catalog, op, msg: msg.substring(0, 220), hashRotated });
    return hashRotated;
  }

  // Catálogos "críticos": si alguno queda vacío es casi seguro un fallo de fetch,
  // NO un dato real (el dominio siempre tiene clientes/procesos/productos/specs).
  const CRITICAL_CATALOGS = [
    { key: 'customers', label: 'Clientes' },
    { key: 'processes', label: 'Procesos' },
    { key: 'products',  label: 'Productos' },
    { key: 'specs',     label: 'Especificaciones' },
  ];

  // PURA + testeable. Decide si la descarga es segura a partir de los catálogos
  // obtenidos y los fallos registrados. level:
  //  - 'block': algún catálogo crítico vacío → NO descargar (sobrescribiría listas buenas).
  //  - 'warn' : hubo hash rotado pero los críticos traen datos → confirmar con el usuario.
  //  - 'ok'   : todo bien.
  function assessCatalogHealth(catalogs, issues) {
    const c = catalogs || {};
    const iss = Array.isArray(issues) ? issues : [];
    const empties = CRITICAL_CATALOGS
      .filter(cc => !Array.isArray(c[cc.key]) || c[cc.key].length === 0)
      .map(cc => cc.label);
    const hashRotated = iss.filter(i => i.hashRotated);
    const otherErrors = iss.filter(i => !i.hashRotated);
    let level = 'ok';
    if (empties.length) level = 'block';
    else if (hashRotated.length) level = 'warn';
    return { level, empties, hashRotated, otherErrors };
  }

  // Arma el texto del aviso (PURO, testeable).
  function buildHealthMessage(health) {
    const lines = [];
    lines.push(health.level === 'block'
      ? '⚠️ CATÁLOGOS INCOMPLETOS — descarga cancelada'
      : '⚠️ Aviso: hubo consultas con hash rotado');
    lines.push('');
    if (health.hashRotated.length) {
      lines.push('Fallaron por HASH ROTADO (Steelhead actualizó su API):');
      for (const i of health.hashRotated) lines.push(`  • ${i.catalog} (${i.op})`);
      lines.push('');
    }
    if (health.empties.length) {
      lines.push('Catálogos críticos que quedaron VACÍOS:');
      for (const e of health.empties) lines.push(`  • ${e}`);
      lines.push('');
    }
    if (health.otherErrors.length) {
      lines.push('Otros errores de consulta:');
      for (const i of health.otherErrors) lines.push(`  • ${i.catalog}: ${i.msg}`);
      lines.push('');
    }
    if (health.level === 'block') {
      lines.push('NO se generó el archivo para no sobrescribir tus listas buenas');
      lines.push('con listas vacías al correr "RefrescarListas".');
      lines.push('');
      lines.push('Reporta al equipo para actualizar los hashes (config.json) y reintenta.');
    } else {
      lines.push('Los catálogos críticos SÍ traen datos, pero los de arriba saldrán');
      lines.push('vacíos/incompletos. ¿Descargar de todos modos?');
    }
    return lines.join('\n');
  }

  // ── CAT_Procesos: catálogo de procesos en un ARTÍCULO DE INVENTARIO (fuente de
  // verdad). Lo mantiene el applet proceso-calculator (agrega combinaciones nuevas
  // en vivo). Aquí lo bajamos para que RefrescarListas reconstruya la hoja
  // CAT_Procesos de la plantilla. Cada item: { Linea, MetalBase, Etiqueta1..6, Proceso }.
  const CATPROC_INV_ITEM_ID = 900192;     // artículo "Catálogo de Procesos (no archivar)"
  const CATPROC_KEY = 'CatProcesos';      // key del array dentro de customInputs
  const CATPROC_MAX_ETIQUETAS = 6;        // Etiqueta1..6

  // ── Specs combinables (espesor/temp/tiempo) — funciones PURAS, testeables ──
  // Clasifica un spec field: Espesor (0), Temperatura (1), Tiempo (2); -1 si no aplica.
  // El catálogo combina los params de TODOS los fields combinables en su producto
  // cartesiano. Hoy solo "Deshidrogenado" trae temp/tiempo, pero el catálogo puede
  // crecer: cualquier EXTERNAL spec con estos fields se combina (no hay hardcode).
  const comboFieldRank = (fieldName, fieldType) => {
    const fn = (fieldName || '').toLowerCase();
    const ft = (fieldType || '').toUpperCase();
    if (fn.includes('espesor')) return 0;
    if (fn.includes('temperatura')) return 1;
    if (ft === 'TIMER' || /tiempo|duraci[oó]n|horneado/.test(fn)) return 2;
    return -1;
  };

  // Construye las entries combinadas de UNA spec a partir de sus fields. Devuelve
  // { entries, truncated }. entries=[] si la spec no tiene fields combinables (→ bare).
  // Orden canónico de pipes: espesor | temperatura | tiempo.
  const buildSpecComboEntries = (specName, fields, cap = 500) => {
    const comboFields = [];
    for (const sf of (fields || [])) {
      const meta = sf.specFieldBySpecFieldId || {};
      const rank = comboFieldRank(meta.name, meta.fieldType ?? meta.type);
      if (rank < 0) continue;
      const pnames = ((sf.defaultValues && sf.defaultValues.nodes) || []).map(p => p.name).filter(Boolean);
      if (!pnames.length) continue;
      comboFields.push({ rank, pnames });
    }
    if (!comboFields.length) return { entries: [], truncated: false };
    comboFields.sort((a, b) => a.rank - b.rank);
    let combos = [[]];
    let truncated = false;
    for (const cf of comboFields) {
      const next = [];
      for (const combo of combos) {
        for (const pv of cf.pnames) {
          next.push([...combo, pv]);
          if (next.length >= cap) { truncated = true; break; }
        }
        if (truncated) break;
      }
      combos = next;
      if (truncated) break;
    }
    const entries = combos.map(c => `${specName} | ${c.join(' | ')}`);
    return { entries, truncated };
  };

  // Separa una entry "specName | a | b | …" en { specName, paramName } preservando
  // TODOS los segmentos del param tras el primer ' | ' (con sus pipes internos). El
  // VBA RefrescarListas reconstruye `specName & " | " & paramName`, así que el param
  // combinado (temp|tiempo) llega íntegro al dropdown. paramName=null si no hay pipe.
  const splitSpecEntry = (s) => {
    const str = s || '';
    const idx = str.indexOf(' | ');
    if (idx < 0) return { specName: str, paramName: null };
    return { specName: str.slice(0, idx), paramName: str.slice(idx + 3) };
  };

  // ═══════════════════════════════════════════
  // FETCH CATALOGS FROM API
  // ═══════════════════════════════════════════

  async function fetchAll() {
    _fetchIssues = [];
    log('Catálogos dinámicos: consultando API...');
    // allSettled (no all): si un fetch SIN catch interno rota (SearchProducts,
    // AllLabels, AllProcesses, AllRackTypes, SearchUsers), NO tumba todo el lote —
    // lo registramos como issue y seguimos con su fallback vacío para poder avisar.
    const jobs = [
      ['Clientes', fetchCustomers, () => []],
      ['Procesos', fetchProcesses, () => []],
      ['Productos', fetchProducts, () => []],
      ['Etiquetas', fetchLabels, () => []],
      ['Especificaciones', fetchSpecs, () => []],
      ['Racks', fetchRacks, () => ({ all: [], linea: [] })],
      ['Usuarios', fetchUsers, () => []],
      ['Grupos', fetchGroups, () => []],
      ['Input Schema', fetchPNInputSchema, () => ({ metalBase: [], codigoSAT: [] })],
      ['Tipos de Geometría', fetchGeometryTypes, () => []],
      ['CAT_Procesos', fetchCatProcesos, () => []],
    ];
    const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
    const vals = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      noteFetchIssue(jobs[i][0], jobs[i][1].name || 'fetch', s.reason);
      warn(`${jobs[i][0]}: fetch falló → ${String((s.reason && s.reason.message) || s.reason).substring(0, 120)}`);
      return jobs[i][2]();
    });
    const [customers, processes, products, labels, specs, racks, users, groups, pnInputSchema, geometryTypes, catProcesos] = vals;
    log(`  ${customers.length} clientes, ${processes.length} procesos, ${products.length} productos`);
    log(`  ${labels.length} etiquetas, ${specs.length} specs, ${racks.linea.length}/${racks.all.length} racks`);
    log(`  ${users.length} usuarios, ${groups.length} grupos`);
    log(`  Input schema: ${pnInputSchema.metalBase.length} metales, ${pnInputSchema.codigoSAT.length} códigos SAT`);
    log(`  ${geometryTypes.length} tipos de geometría`);
    log(`  ${catProcesos.length} combinaciones CAT_Procesos (inventario ${CATPROC_INV_ITEM_ID})`);
    return { customers, processes, products, labels, specs, racks, users, groups, pnInputSchema, geometryTypes, catProcesos };
  }

  // CAT_Procesos: lee el array customInputs.CatProcesos del artículo de inventario
  // 900192 (la fuente de verdad que mantiene proceso-calculator). Devuelve los items
  // tal cual { Linea, MetalBase, Etiqueta1..6, Proceso }; RefrescarListas los mapea
  // a las columnas D/E/F/G de la hoja CAT_Procesos.
  async function fetchCatProcesos() {
    try {
      const vars = { id: CATPROC_INV_ITEM_ID, usagesLimit: 10, usagesOffset: 0, purchaseOrderBomItemsOffset: 0, purchaseOrderBomItemsLimit: 10 };
      const data = await api().query('GetInventoryItem', vars, 'GetInventoryItem');
      const ci = data?.inventoryItemById?.customInputs || {};
      const entries = Array.isArray(ci[CATPROC_KEY]) ? ci[CATPROC_KEY] : [];
      return entries;
    } catch (e) {
      noteFetchIssue('CAT_Procesos', 'GetInventoryItem', e);
      warn(`GetInventoryItem (CatProcesos): ${String(e).substring(0, 120)}`);
      return [];
    }
  }

  // V10: fetch metalBase + codigoSAT enums directly from PartNumber input schema
  async function fetchPNInputSchema() {
    try {
      const data = await api().query('GetPartNumbersInputSchema', {}, 'GetPartNumbersInputSchema');
      const nodes = data?.allPartNumberInputSchemas?.nodes || [];
      // Find the latest schema (highest id)
      const latest = nodes.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
      if (!latest) return { metalBase: [], codigoSAT: [] };
      const props = latest.inputSchema?.properties || {};
      const metalBase = props.DatosAdicionalesNP?.properties?.BaseMetal?.enum || [];
      const codigoSAT = props.DatosFacturacion?.properties?.CodigoSAT?.enum || [];
      return { metalBase: [...metalBase], codigoSAT: [...codigoSAT] };
    } catch (e) {
      noteFetchIssue('Input Schema', 'GetPartNumbersInputSchema', e);
      warn(`GetPartNumbersInputSchema: ${String(e).substring(0, 100)}`);
      return { metalBase: [], codigoSAT: [] };
    }
  }

  async function fetchCustomers() {
    // 1. Get all customers via AllCustomers paginated (1-2 requests reemplazan 36 letras)
    const allNodes = [];
    const seenIds = new Set();
    const PAGE = 500;
    let offset = 0;
    let total = null;
    while (true) {
      let data;
      try {
        data = await api().query('AllCustomers', {
          includeArchived: 'NO',
          includeAccountingFields: false,
          orderBy: ['NAME_ASC'],
          offset,
          first: PAGE,
          searchQuery: ''
        });
      } catch (e) {
        noteFetchIssue('Clientes', 'AllCustomers', e);
        warn(`AllCustomers offset ${offset}: ${String(e).substring(0, 120)}`);
        break;
      }
      const nodes = data?.pagedData?.nodes || [];
      if (total === null) total = data?.pagedData?.totalCount ?? null;
      for (const n of nodes) {
        if (n.id && !seenIds.has(n.id) && !n.archivedAt) {
          seenIds.add(n.id);
          allNodes.push(n);
        }
      }
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 20000) { warn('AllCustomers: límite de seguridad 20k alcanzado'); break; }
    }
    log(`  Clientes: ${allNodes.length}/${total ?? '?'} activos`);

    const uniqueCustomers = [];
    const seen = new Set();
    for (const c of allNodes) {
      if (!c.name || seen.has(c.name.toUpperCase())) continue;
      seen.add(c.name.toUpperCase());
      uniqueCustomers.push(c);
    }
    log(`  Clientes: ${uniqueCustomers.length} únicos, obteniendo direcciones...`);

    // 2. For each customer, get addresses via GetQuoteRelatedData (by numeric id).
    // 1.6.28: GetCustomerInfoForReceivedOrder deprecada. GetQuoteRelatedData toma
    // el mismo input {customerId} y devuelve el mismo path customerById.customerAddressesByCustomerId.nodes[]
    // con useForShipping/useForBilling. Bug colateral: ya no incluye customerLabelsByCustomerId
    // (AllCustomers tampoco). Labels saldrán vacíos hasta refactor en 1.6.29.
    // Process in batches of 20 (Steelhead aguanta concurrencia, ya validado con specs)
    const result = [];
    for (let i = 0; i < uniqueCustomers.length; i += 20) {
      const batch = uniqueCustomers.slice(i, i + 20);
      const details = await Promise.all(batch.map(async (c) => {
        try {
          const d = await api().query('GetQuoteRelatedData', { customerId: parseInt(c.id, 10) });
          return { customer: c, detail: d?.customerById };
        } catch (e) {
          warn(`Cliente ${c.name}: ${String(e).substring(0, 80)}`);
          return { customer: c, detail: null };
        }
      }));

      for (const { customer, detail } of details) {
        const name = customer.name;
        const id = customer.idInDomain || customer.id || '';

        // Labels
        const labelNodes = detail?.customerLabelsByCustomerId?.nodes || customer.customerLabelsByCustomerId?.nodes || [];
        const labelNames = labelNodes.map(l => l.labelByLabelId?.name || l.name || '').filter(Boolean).join(', ');

        // Addresses: solo Ship-To (incluye las que son Ship-To + Bill-To; excluye Bill-To puras)
        const allAddrs = detail?.customerAddressesByCustomerId?.nodes || [];
        const addrs = allAddrs.filter(a => a.useForShipping === true);
        if (addrs.length > 0) {
          for (const addr of addrs) {
            let addrText = (addr.address || addr.street || '').replace(/[\r\n]+/g, ' ');
            if (addrText.length > 40) addrText = addrText.substring(0, 40);
            const plant = (addr.identifier || addr.description || '').toString().replace(/[\r\n]+/g, ' ').trim();
            const parts = [name];
            if (plant) parts.push(plant);
            if (addrText) parts.push(addrText);
            const display = parts.join(' \u2014 ');
            result.push({ display, id: String(id), labels: labelNames, addressId: addr.id });
          }
        } else {
          result.push({ display: name, id: String(id), labels: labelNames, addressId: null });
        }
      }
    }

    result.sort((a, b) => a.display.localeCompare(b.display));
    log(`  Clientes con direcciones: ${result.length} entradas`);
    return result;
  }

  async function fetchProcesses() {
    const data = await api().query('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: '', first: 500 });
    const nodes = data?.allProcessNodes?.nodes || data?.pagedData?.nodes || [];
    const seen = new Set();
    const result = [];
    for (const p of nodes) {
      const name = p.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function fetchProducts() {
    const data = await api().query('SearchProducts', { searchQuery: '%%', first: 500 });
    const nodes = data?.searchProducts?.nodes || data?.pagedData?.nodes || [];
    const seen = new Set();
    const result = [];
    for (const p of nodes) {
      const name = p.name;
      if (!name || seen.has(name) || p.archivedAt) continue;
      seen.add(name);
      result.push(name);
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function fetchLabels() {
    const data = await api().query('AllLabels', { condition: { forPartNumber: true } });
    const nodes = data?.allLabels?.nodes || [];
    const seen = new Set();
    const result = [];
    for (const l of nodes) {
      const name = l.name;
      if (!name || seen.has(name) || l.archivedAt) continue;
      seen.add(name);
      result.push(name);
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function fetchSpecs() {
    // V10: AllSpecs trae specs CON sus fields embebidos en una sola query (sin N+1).
    // Paginamos por offset/first y filtramos a EXTERNAL (las únicas que necesita la plantilla).
    const allSpecs = [];
    const seenIds = new Set();
    const PAGE = 400;
    let offset = 0;
    let total = null;
    const typeCounts = {};
    while (true) {
      let data;
      try {
        data = await api().query('AllSpecs', {
          includeArchived: 'NO',
          orderBy: ['ID_IN_DOMAIN_ASC'],
          offset,
          first: PAGE,
          searchQuery: ''
        });
      } catch (e) {
        noteFetchIssue('Especificaciones', 'AllSpecs', e);
        warn(`AllSpecs offset ${offset}: ${String(e).substring(0, 120)}`);
        break;
      }
      const nodes = data?.pagedData?.nodes || [];
      if (total === null) total = data?.pagedData?.totalCount ?? null;
      for (const n of nodes) {
        const t = n?.type || 'UNKNOWN';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
        if (t !== 'EXTERNAL') continue;
        if (n.id && !seenIds.has(n.id)) {
          seenIds.add(n.id);
          allSpecs.push(n);
        }
      }
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 50000) { warn('AllSpecs: límite de seguridad 50k alcanzado'); break; }
    }
    log(`  Specs externas: ${allSpecs.length}/${total ?? '?'} (tipos: ${JSON.stringify(typeCounts)})`);

    // El embed de AllSpecs no trae datos confiables de fields/params. La única forma
    // confiable es llamar SpecFieldsAndOptions para CADA spec externa. Con ~110 specs
    // y batch de 20 son ~6 rondas paralelas, ~1-2 segundos total.
    const specsSeen = new Set();
    const comboEntries = [];        // entries combinadas (espesor/temp/tiempo, producto cartesiano)
    const comboEntrySet = new Set();
    const specsWithCombo = new Set();
    const bareSpecs = [];
    const COMBO_CAP = 500;          // tope de seguridad por spec (evita explosión cartesiana)

    for (const spec of allSpecs) {
      if (spec.name) specsSeen.add(spec.name);
    }

    const BATCH = 20;
    for (let i = 0; i < allSpecs.length; i += BATCH) {
      const batch = allSpecs.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (spec) => {
        if (!spec.name) return null;
        try {
          const d = await api().query('SpecFieldsAndOptions', { specId: spec.id }, 'SpecFieldsAndOptions');
          return { spec, sd: d?.specById };
        } catch (e) { warn(`SpecFieldsAndOptions ${spec.name}: ${String(e).substring(0, 80)}`); return { spec, sd: null }; }
      }));
      for (const r of results) {
        if (!r || !r.sd) continue;
        const fields = r.sd.specFieldSpecsBySpecId?.nodes || [];
        const { entries, truncated } = buildSpecComboEntries(r.spec.name, fields, COMBO_CAP);
        if (truncated) warn(`Spec "${r.spec.name}": producto cartesiano topado a ${COMBO_CAP} — catálogo parcial`);
        for (const entry of entries) {
          if (!comboEntrySet.has(entry)) {
            comboEntrySet.add(entry);
            comboEntries.push(entry);
            specsWithCombo.add(r.spec.name);
          }
        }
      }
      if ((i + BATCH) % 100 === 0 || i + BATCH >= allSpecs.length) {
        log(`  SpecFieldsAndOptions: ${Math.min(i + BATCH, allSpecs.length)}/${allSpecs.length} (${comboEntries.length} entradas combinadas hasta ahora)`);
      }
    }

    // Entries combinadas (espesor/temp/tiempo) primero, luego specs sin fields
    // combinables (bare).
    const result = [];
    for (const entry of comboEntries) result.push(entry);
    for (const name of specsSeen) {
      if (!specsWithCombo.has(name)) bareSpecs.push(name);
    }
    for (const name of bareSpecs) result.push(name);
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function fetchRacks() {
    const data = await api().query('AllRackTypes', {});
    const nodes = data?.pagedData?.nodes || data?.allRackTypes?.nodes || [];
    const allRacks = [];
    const lineaRacks = [];
    const seenAll = new Set();
    const seenLinea = new Set();
    for (const r of nodes) {
      const name = r.name;
      if (!name || seenAll.has(name)) continue;
      seenAll.add(name);
      allRacks.push(name);
      if (name.includes('-FL') || name.includes('-BA') || name.includes('Barril')) {
        if (!seenLinea.has(name)) { seenLinea.add(name); lineaRacks.push(name); }
      }
    }
    allRacks.sort((a, b) => a.localeCompare(b));
    lineaRacks.sort((a, b) => a.localeCompare(b));
    return { all: allRacks, linea: lineaRacks };
  }

  async function fetchUsers() {
    const data = await api().query('SearchUsers', { searchQuery: '', first: 500 });
    const nodes = data?.searchUsers?.nodes || data?.pagedData?.nodes || [];
    const seen = new Set();
    const result = [];
    for (const u of nodes) {
      const name = u.name || u.fullName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function fetchGroups() {
    const data = await api().query('PartNumberGroupSelect', { partNumberGroupLike: '%%', first: 500 }, 'PNGroupSelect')
      .catch((e) => { noteFetchIssue('Grupos', 'PNGroupSelect', e); return null; });
    if (!data) return [];
    const nodes = data?.allPartNumberGroups?.nodes || data?.pagedData?.nodes || data?.partNumberGroups?.nodes || [];
    const seen = new Set();
    const result = [];
    for (const g of nodes) {
      const name = g.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function fetchGeometryTypes() {
    const all = [];
    const PAGE = 200;
    let offset = 0;
    while (true) {
      let data;
      try {
        data = await api().query('AllGeometryTypes', {
          orderBy: ['ID_DESC'], offset, first: PAGE, searchQuery: ''
        });
      } catch (e) {
        noteFetchIssue('Tipos de Geometría', 'AllGeometryTypes', e);
        warn(`AllGeometryTypes offset ${offset}: ${String(e).substring(0, 120)}`);
        break;
      }
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) if (n.name) all.push(n.name);
      if (nodes.length < PAGE) break;
      offset += PAGE;
      if (offset > 5000) { warn('AllGeometryTypes: límite 5k'); break; }
    }
    const seen = new Set();
    const dedup = [];
    for (const n of all) {
      if (seen.has(n)) continue;
      seen.add(n);
      dedup.push(n);
    }
    dedup.sort((a, b) => a.localeCompare(b));
    return dedup;
  }

  // ═══════════════════════════════════════════
  // GENERATE CATALOGS-ONLY FILE (preserves template formatting)
  // ═══════════════════════════════════════════

  async function generateCatalogsFile() {
    if (!window.XLSX) throw new Error('SheetJS (XLSX) no cargado');

    const catalogs = await fetchAll();

    // Guard de integridad: si un catálogo crítico vino vacío (p.ej. hash rotado),
    // NO generamos el archivo — evitamos que RefrescarListas borre las listas buenas.
    const health = assessCatalogHealth(catalogs, _fetchIssues);
    if (health.level === 'block') {
      log('generateCatalogsFile ABORTADO por catálogos incompletos: ' + JSON.stringify({
        empties: health.empties,
        hashRotated: health.hashRotated.map(i => i.op),
        otherErrors: health.otherErrors.map(i => i.op),
      }));
      alert(buildHealthMessage(health));
      return { aborted: true, health };
    }
    if (health.level === 'warn') {
      if (!confirm(buildHealthMessage(health))) {
        log('generateCatalogsFile cancelado por el usuario (hash rotado en catálogos secundarios).');
        return { aborted: true, health };
      }
      warn('Continuando pese a hash rotado en catálogos secundarios: ' + health.hashRotated.map(i => i.op).join(', '));
    }

    // Create new workbook with catalog sheets matching the template's internal sheets
    const wb = XLSX.utils.book_new();

    // Clientes sheet: VBA solo lee col2=name, col6=active, col10=address (sin ID ni labels)
    // El display tiene formato "Cliente — [Identifier —] Direccion"; tomamos todo lo posterior
    // al primer guion como columna Direccion para no perder ningun segmento.
    const custRows = [['', 'Nombre', '', '', '', 'Activo', '', '', '', 'Dirección']];
    for (const c of catalogs.customers) {
      const sep = ' \u2014 ';
      const i = c.display.indexOf(sep);
      const namePart = i === -1 ? c.display : c.display.substring(0, i);
      const addrPart = i === -1 ? '' : c.display.substring(i + sep.length);
      custRows.push(['', namePart, '', '', '', true, '', '', '', addrPart]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(custRows), 'Clientes');

    // Procesos sheet: col2=name, col3=type, col5=archived
    const procRows = [['', 'Nombre', 'Tipo', '', 'Archivado']];
    for (const p of catalogs.processes) procRows.push(['', p, 'process', '', 'No']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(procRows), 'Procesos');

    // Productos sheet: col2=name, col4=estado
    const prodRows = [['', 'Nombre', '', 'Estado']];
    for (const p of catalogs.products) prodRows.push(['', p, '', 'Activo']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prodRows), 'Productos');

    // Etiquetas sheet: col4=archivedAt (empty=active), col6=name
    const labelRows = [['', '', '', 'ArchivedAt', '', 'Nombre']];
    for (const l of catalogs.labels) labelRows.push(['', '', '', '', '', l]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(labelRows), 'Etiquetas');

    // Especificaciones sheet: col3=specName, col17=fieldName, col22=paramName
    const specRows = [['', '', 'SpecName', '', '', '', '', '', '', '', '', '', '', '', '', '', 'FieldName', '', '', '', '', 'ParamName']];
    for (const s of catalogs.specs) {
      // El param puede traer VARIOS segmentos (espesor/temp/tiempo combinados, p.ej.
      // "177 - 205 °C | >= 3 hrs."). splitSpecEntry preserva TODO tras el primer ' | '
      // (antes un destructuring tiraba el 3er segmento → perdía el tiempo → el VBA
      // dedupeaba las filas idénticas a una sola). fieldName="espesor" es la etiqueta
      // que RefrescarListas busca para reconstruir el dropdown (no es el field real).
      const { specName, paramName } = splitSpecEntry(s);
      if (paramName !== null) {
        specRows.push(['', '', specName, '', '', '', '', '', '', '', '', '', '', '', '', '', 'espesor', '', '', '', '', paramName]);
      } else {
        specRows.push(['', '', s]);
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(specRows), 'Especificaciones');

    // Racks sheet: col5=name
    const rackRows = [['', '', '', '', 'Nombre']];
    for (const r of catalogs.racks.all) rackRows.push(['', '', '', '', r]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rackRows), 'Racks');

    // Dimensiones Contables — dinámico vía GetDimension API
    const domain = api().getDomain();
    // V10: defaults match config.json domain values for Ecoplating
    const dimIds = domain.dimensionIds || { linea: 349, departamento: 586 };
    log(`  Dimension IDs: linea=${dimIds.linea}, departamento=${dimIds.departamento}`);

    async function fetchDimension(dimId) {
      try {
        const data = await api().query('GetDimension', { id: dimId, includeArchived: 'NO' });
        const nodes = data?.acctDimensionById?.acctDimensionCustomValuesByDimensionId?.nodes || [];
        const vals = nodes.filter(n => !n.archivedAt).map(n => n.value.trim()).sort();
        log(`    GetDimension(${dimId}): ${vals.length} valores activos`);
        return vals;
      } catch (e) {
        warn(`Dimensión ${dimId}: ${String(e).substring(0, 80)}`);
        return [];
      }
    }

    const [lineas, departamentos] = await Promise.all([
      fetchDimension(dimIds.linea),
      fetchDimension(dimIds.departamento)
    ]);
    log(`  ${lineas.length} líneas, ${departamentos.length} departamentos (dinámico)`);

    // Líneas sheet
    const lineaRows = [['Línea']];
    for (const l of lineas) lineaRows.push([l]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lineaRows), 'Líneas');

    // Departamentos sheet
    const deptoRows = [['Departamento']];
    for (const d of departamentos) deptoRows.push([d]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(deptoRows), 'Departamentos');

    // Usuarios sheet
    const userRows = [['Nombre']];
    for (const u of catalogs.users) userRows.push([u]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(userRows), 'Usuarios');

    // Grupos sheet
    const groupRows = [['Nombre']];
    for (const g of catalogs.groups) groupRows.push([g]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(groupRows), 'Grupos');

    // TiposGeometria sheet (V11: nuevo)
    const geomRows = [['Nombre']];
    for (const g of catalogs.geometryTypes) geomRows.push([g]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(geomRows), 'TiposGeometria');

    // V10: MetalBase + CodigoSAT desde el input schema (no más hardcoded)
    const mbRows = [['MetalBase']];
    for (const m of catalogs.pnInputSchema.metalBase) mbRows.push([m]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mbRows), 'MetalBase');

    const satRows = [['CódigoSAT']];
    for (const c of catalogs.pnInputSchema.codigoSAT) satRows.push([c]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(satRows), 'CodigoSAT');

    // CAT_Procesos sheet: catálogo de procesos desde el artículo de inventario 900192
    // (fuente de verdad). Cols: Linea | MetalBase | Etiqueta1..6 | Proceso. El VBA
    // CargarCatProcesosDesde reconstruye la hoja CAT_Procesos de la plantilla:
    //   D=Linea, E=MetalBase, F=join(Etiqueta1..6, " + "), G=Proceso.
    // A/B/C (Grupo/Característica/Línea corta) quedan vacías: ninguna fórmula las usa.
    const catProcHeader = ['Linea', 'MetalBase', 'Etiqueta1', 'Etiqueta2', 'Etiqueta3', 'Etiqueta4', 'Etiqueta5', 'Etiqueta6', 'Proceso'];
    const catProcRows = [catProcHeader];
    for (const e of catalogs.catProcesos) {
      catProcRows.push([
        e.Linea || '', e.MetalBase || '',
        e.Etiqueta1 || '', e.Etiqueta2 || '', e.Etiqueta3 || '',
        e.Etiqueta4 || '', e.Etiqueta5 || '', e.Etiqueta6 || '',
        e.Proceso || ''
      ]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catProcRows), 'CAT_Procesos');

    // Resumen sheet
    const counts = {
      clientes: catalogs.customers.length,
      procesos: catalogs.processes.length,
      productos: catalogs.products.length,
      etiquetas: catalogs.labels.length,
      specs: catalogs.specs.length,
      racksLinea: catalogs.racks.linea.length,
      racksTodos: catalogs.racks.all.length,
      lineas: lineas.length,
      departamentos: departamentos.length,
      usuarios: catalogs.users.length,
      grupos: catalogs.groups.length,
      metalBase: catalogs.pnInputSchema.metalBase.length,
      codigoSAT: catalogs.pnInputSchema.codigoSAT.length,
      tiposGeometria: catalogs.geometryTypes.length,
      catProcesos: catalogs.catProcesos.length
    };
    const resumenRows = [
      ['Catálogos Steelhead — ' + new Date().toLocaleDateString('es-MX')],
      [],
      ['Catálogo', 'Registros'],
      ['Clientes', counts.clientes],
      ['Procesos', counts.procesos],
      ['Productos', counts.productos],
      ['Etiquetas', counts.etiquetas],
      ['Especificaciones', counts.specs],
      ['Racks (Línea)', counts.racksLinea],
      ['Racks (Todos)', counts.racksTodos],
      ['Líneas', counts.lineas],
      ['Departamentos', counts.departamentos],
      ['Usuarios', counts.usuarios],
      ['Grupos PN', counts.grupos],
      ['Metal Base', counts.metalBase],
      ['Código SAT', counts.codigoSAT],
      ['Tipos de Geometría', counts.tiposGeometria],
      ['CAT_Procesos (combinaciones)', counts.catProcesos],
      [],
      ['Instrucciones:'],
      ['1. Abre tu Plantilla de Cotizaciones (.xlsm)'],
      ['2. Ejecuta la macro "RefrescarListas" (botón en la plantilla)'],
      ['3. La macro detectará este archivo automáticamente'],
      ['4. Si no lo detecta, te pedirá seleccionarlo manualmente'],
    ];
    const wsResumen = XLSX.utils.aoa_to_sheet(resumenRows);
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // Move Resumen to first position
    wb.SheetNames.unshift(wb.SheetNames.pop());

    // Download
    const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Catalogos_Steelhead_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log(`Catálogos descargados: ${JSON.stringify(counts)}`);

    // Show summary alert
    alert(`Catálogos actualizados:\n\n` +
      `${counts.clientes} clientes\n` +
      `${counts.procesos} procesos\n` +
      `${counts.productos} productos\n` +
      `${counts.etiquetas} etiquetas\n` +
      `${counts.specs} especificaciones\n` +
      `${counts.racksLinea} racks línea / ${counts.racksTodos} racks total\n` +
      `${counts.lineas} líneas\n` +
      `${counts.departamentos} departamentos\n` +
      `${counts.usuarios} usuarios\n` +
      `${counts.grupos} grupos PN\n` +
      `${counts.tiposGeometria} tipos de geometría\n` +
      `${counts.catProcesos} combinaciones CAT_Procesos\n\n` +
      `Archivo descargado: Catalogos_Steelhead_${new Date().toISOString().slice(0, 10)}.xlsx\n\n` +
      `Siguiente paso: Abre tu plantilla y ejecuta "RefrescarListas".\n` +
      `La macro detectará el archivo automáticamente.`);

    return counts;
  }

  return { fetchAll, generateCatalogsFile, _comboFieldRank: comboFieldRank, _buildSpecComboEntries: buildSpecComboEntries, _splitSpecEntry: splitSpecEntry, _assessCatalogHealth: assessCatalogHealth, _buildHealthMessage: buildHealthMessage, _noteFetchIssue: noteFetchIssue };
})();

if (typeof window !== 'undefined') window.CatalogFetcher = CatalogFetcher;
if (typeof module !== 'undefined' && module.exports) module.exports = CatalogFetcher;
