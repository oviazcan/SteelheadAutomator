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
  // GENERATE CATALOGS-ONLY FILE (preserves template formatting)
  // ═══════════════════════════════════════════

  async function generateCatalogsFile() {
    if (!window.XLSX) throw new Error('SheetJS (XLSX) no cargado');

    const catalogs = await fetchAll();

    // Create new workbook with catalog sheets matching the template's internal sheets
    const wb = XLSX.utils.book_new();

    // Clientes sheet: col1=id, col2=name, col3-5=other fields, col6=active, col10=address, col12=labels
    const custRows = [['ID', 'Nombre', '', '', '', 'Activo', '', '', '', 'Dirección', '', 'Etiquetas']];
    for (const c of catalogs.customers) {
      custRows.push([c.id, c.display.split(' \u2014 ')[0], '', '', '', true, '', '', '', c.display.includes('\u2014') ? c.display.split(' \u2014 ')[1] : '', '', c.labels]);
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
      if (s.includes(' | ')) {
        const [specName, paramName] = s.split(' | ');
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

    // Resumen sheet
    const counts = {
      clientes: catalogs.customers.length,
      procesos: catalogs.processes.length,
      productos: catalogs.products.length,
      etiquetas: catalogs.labels.length,
      specs: catalogs.specs.length,
      racksLinea: catalogs.racks.linea.length,
      racksTodos: catalogs.racks.all.length
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
      [],
      ['Instrucciones:'],
      ['1. Abre tu Plantilla de Cotizaciones (.xlsm)'],
      ['2. Copia cada hoja de este archivo a tu plantilla (reemplazando la existente)'],
      ['3. Ejecuta la macro "RefrescarListas" para actualizar los dropdowns'],
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
      `${counts.racksLinea} racks línea / ${counts.racksTodos} racks total\n\n` +
      `Archivo: Catalogos_Steelhead_${new Date().toISOString().slice(0, 10)}.xlsx\n` +
      `Copia las hojas a tu plantilla y ejecuta "RefrescarListas".`);

    return counts;
  }

  return { fetchAll, generateCatalogsFile };
})();

if (typeof window !== 'undefined') window.CatalogFetcher = CatalogFetcher;
