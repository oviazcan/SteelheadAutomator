// Steelhead Catalog Fetcher + Excel Template Generator
// Queries API for fresh catalogs, injects into Excel template, downloads
// Depends on: SteelheadAPI, XLSX (SheetJS)

const CatalogFetcher = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ═══════════════════════════════════════════
  // FETCH CATALOGS FROM API
  // ═══════════════════════════════════════════

  async function fetchAll() {
    log('Catálogos dinámicos: consultando API...');
    const [customers, processes, products, labels, specs, racks] = await Promise.all([
      fetchCustomers(),
      fetchProcesses(),
      fetchProducts(),
      fetchLabels(),
      fetchSpecs(),
      fetchRacks()
    ]);
    log(`  ${customers.length} clientes, ${processes.length} procesos, ${products.length} productos`);
    log(`  ${labels.length} etiquetas, ${specs.length} specs, ${racks.linea.length}/${racks.all.length} racks`);
    return { customers, processes, products, labels, specs, racks };
  }

  async function fetchCustomers() {
    const data = await api().query('CustomerSearchByName', { nameLike: '%%', orderBy: ['NAME_ASC'] });
    const nodes = data?.searchCustomers?.nodes || data?.pagedData?.nodes || data?.allCustomers?.nodes || [];
    // Format: "Nombre — Dirección" (max 40 chars for address), with ID and labels
    const seen = new Set();
    const result = [];
    for (const c of nodes) {
      if (!c.name || !c.active) continue;
      const name = c.name;
      if (seen.has(name)) continue;
      seen.add(name);
      let addr = (c.customerAddressesByCustomerId?.nodes?.[0]?.address || '').replace(/[\r\n]+/g, ' ');
      if (addr.length > 40) addr = addr.substring(0, 40);
      const display = addr ? `${name} \u2014 ${addr}` : name;
      const id = c.idInDomain || c.id || '';
      const labelNames = (c.labelsByCustomerId?.nodes || c.labels?.nodes || []).map(l => l.name).join(', ');
      result.push({ display, id: String(id), labels: labelNames });
    }
    result.sort((a, b) => a.display.localeCompare(b.display));
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
    const data = await api().query('SearchSpecsForSelect', { like: '%%', locationIds: [], alreadySelectedSpecs: [], orderBy: ['NAME_ASC'] });
    const nodes = data?.searchSpecs?.nodes || [];

    // For each spec, check if it has an "espesor" field with params
    // Format: "SpecName | paramValue" for specs with espesor, bare name otherwise
    const specsSeen = new Set();
    const espesorEntries = [];
    const specsWithEspesor = new Set();
    const bareSpecs = [];

    for (const spec of nodes) {
      const name = spec.name;
      if (!name) continue;
      specsSeen.add(name);

      // Check spec fields for "espesor"
      try {
        const sfData = await api().query('TempSpecFieldsAndOptions', { specId: spec.id });
        const fields = sfData?.specById?.specFieldSpecsBySpecId?.nodes || [];
        for (const sf of fields) {
          const fieldName = sf.specFieldBySpecFieldId?.name || '';
          if (fieldName.toLowerCase().includes('espesor')) {
            const params = sf.defaultValues?.nodes || [];
            for (const param of params) {
              const entry = `${name} | ${param.name}`;
              if (!espesorEntries.includes(entry)) {
                espesorEntries.push(entry);
                specsWithEspesor.add(name);
              }
            }
          }
        }
      } catch (e) {
        // If spec field query fails, just add bare name
      }
    }

    // Espesor entries first, then bare specs (without espesor)
    const result = [];
    for (const entry of espesorEntries) result.push(entry);
    for (const name of specsSeen) {
      if (!specsWithEspesor.has(name)) bareSpecs.push(name);
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

  // ═══════════════════════════════════════════
  // GENERATE EXCEL WITH FRESH CATALOGS
  // ═══════════════════════════════════════════

  async function generateTemplate(templateUrl) {
    if (!window.XLSX) throw new Error('SheetJS (XLSX) no cargado');

    // 1. Download base template
    log('Descargando plantilla base...');
    const resp = await fetch(templateUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} descargando plantilla`);
    const templateData = await resp.arrayBuffer();

    // 2. Fetch fresh catalogs
    const catalogs = await fetchAll();

    // 3. Open workbook with SheetJS
    log('Actualizando catálogos en Excel...');
    const wb = XLSX.read(new Uint8Array(templateData), { type: 'array', cellStyles: true });
    const wsListas = wb.Sheets['Listas'];
    if (!wsListas) throw new Error('Hoja "Listas" no encontrada en plantilla');

    // 4. Clear existing catalog data (cols A-I, rows 2+)
    // Keep headers (row 1) and cols J-K (CodigoSAT, MetalBase)
    const clearCols = ['A','B','C','D','E','F','G','H','I','L','M'];
    for (const col of clearCols) {
      for (let r = 2; r <= 1000; r++) {
        const ref = `${col}${r}`;
        if (wsListas[ref]) delete wsListas[ref];
      }
    }

    // 5. Write catalogs

    // Col A: Clientes (display), Col H: ID, Col I: Labels
    for (let i = 0; i < catalogs.customers.length; i++) {
      wsListas[`A${i + 2}`] = { t: 's', v: catalogs.customers[i].display };
      wsListas[`H${i + 2}`] = { t: 's', v: catalogs.customers[i].id };
      wsListas[`I${i + 2}`] = { t: 's', v: catalogs.customers[i].labels };
    }

    // Col B: Procesos
    for (let i = 0; i < catalogs.processes.length; i++) {
      wsListas[`B${i + 2}`] = { t: 's', v: catalogs.processes[i] };
    }

    // Col C: Productos
    for (let i = 0; i < catalogs.products.length; i++) {
      wsListas[`C${i + 2}`] = { t: 's', v: catalogs.products[i] };
    }

    // Col D: Etiquetas
    for (let i = 0; i < catalogs.labels.length; i++) {
      wsListas[`D${i + 2}`] = { t: 's', v: catalogs.labels[i] };
    }

    // Col E: Specs
    for (let i = 0; i < catalogs.specs.length; i++) {
      wsListas[`E${i + 2}`] = { t: 's', v: catalogs.specs[i] };
    }

    // Col F: Racks Línea
    for (let i = 0; i < catalogs.racks.linea.length; i++) {
      wsListas[`F${i + 2}`] = { t: 's', v: catalogs.racks.linea[i] };
    }

    // Col G: Racks Todos
    for (let i = 0; i < catalogs.racks.all.length; i++) {
      wsListas[`G${i + 2}`] = { t: 's', v: catalogs.racks.all[i] };
    }

    // Update sheet range
    const maxRow = Math.max(
      catalogs.customers.length, catalogs.processes.length, catalogs.products.length,
      catalogs.labels.length, catalogs.specs.length, catalogs.racks.all.length
    ) + 1;
    wsListas['!ref'] = `A1:M${maxRow}`;

    // 6. Generate file and trigger download
    log('Generando archivo...');
    const wbOut = XLSX.write(wb, { bookType: 'xlsm', type: 'array', bookVBA: true });
    const blob = new Blob([wbOut], { type: 'application/vnd.ms-excel.sheet.macroEnabled.12' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Plantilla_Cotizaciones_v9_${new Date().toISOString().slice(0,10)}.xlsm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const counts = {
      clientes: catalogs.customers.length,
      procesos: catalogs.processes.length,
      productos: catalogs.products.length,
      etiquetas: catalogs.labels.length,
      specs: catalogs.specs.length,
      racksLinea: catalogs.racks.linea.length,
      racksTodos: catalogs.racks.all.length
    };
    log(`Plantilla descargada con catálogos: ${JSON.stringify(counts)}`);
    return counts;
  }

  return { fetchAll, generateTemplate };
})();

if (typeof window !== 'undefined') window.CatalogFetcher = CatalogFetcher;
