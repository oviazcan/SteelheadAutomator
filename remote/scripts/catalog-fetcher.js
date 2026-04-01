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
    const [customers, processes, products, labels, specs, racks, users, groups] = await Promise.all([
      fetchCustomers(),
      fetchProcesses(),
      fetchProducts(),
      fetchLabels(),
      fetchSpecs(),
      fetchRacks(),
      fetchUsers(),
      fetchGroups()
    ]);
    log(`  ${customers.length} clientes, ${processes.length} procesos, ${products.length} productos`);
    log(`  ${labels.length} etiquetas, ${specs.length} specs, ${racks.linea.length}/${racks.all.length} racks`);
    log(`  ${users.length} usuarios, ${groups.length} grupos`);
    return { customers, processes, products, labels, specs, racks, users, groups };
  }

  async function fetchCustomers() {
    // 1. Get customer list
    // first:500 to get all customers (default may be ~50)
    const data = await api().query('CustomerSearchByName', { nameLike: '%%', orderBy: ['NAME_ASC'], first: 500 });
    const nodes = data?.searchCustomers?.nodes || data?.pagedData?.nodes || data?.allCustomers?.nodes || [];
    const uniqueCustomers = [];
    const seen = new Set();
    for (const c of nodes) {
      if (!c.name || seen.has(c.name.toUpperCase())) continue;
      seen.add(c.name.toUpperCase());
      uniqueCustomers.push(c);
    }
    log(`  Clientes: ${uniqueCustomers.length} únicos, obteniendo direcciones...`);

    // 2. For each customer, get addresses via Customer query (by idInDomain)
    // Process in batches of 5 to avoid overloading
    const result = [];
    for (let i = 0; i < uniqueCustomers.length; i += 5) {
      const batch = uniqueCustomers.slice(i, i + 5);
      const details = await Promise.all(batch.map(async (c) => {
        try {
          const d = await api().query('Customer', { idInDomain: c.idInDomain, includeAccountingFields: true }, 'Customer');
          return { customer: c, detail: d?.customerByIdInDomain };
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

        // Addresses
        const addrs = detail?.customerAddressesByCustomerId?.nodes || [];
        if (addrs.length > 0) {
          for (const addr of addrs) {
            let addrText = (addr.address || addr.street || '').replace(/[\r\n]+/g, ' ');
            if (addrText.length > 40) addrText = addrText.substring(0, 40);
            const display = addrText ? `${name} \u2014 ${addrText}` : name;
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
    const data = await api().query('PartNumberGroupSelect', { partNumberGroupLike: '%%' }, 'PNGroupSelect').catch(() => null);
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

    // Dimensiones Contables (Líneas y Departamentos) — datos estáticos de config
    const domain = api().getDomain();
    const lineas = (domain.lineas || [
      'T101-LI Pre Limpieza (4 - 5)', 'T102-LI Estaño e Iridizado (12)', 'T103-LI Cromo Duro (11)',
      'T104-LI Zinc y Estaño Manual (6)', 'T105-LI Zinc Semiautomático (7)', 'T106-LI Zinc Automático (8)',
      'T107-LI Plata (9)', 'T108-LI Electroless Níquel (14)', 'T109-LI Varios Manual (10)',
      'T110-LI Rack Automático (13)', 'T111-LI Ensamble (13.1)', 'T112-LI Barril Automático (15)',
      'T113-LI Rack Automático (16)', 'T114-LI Barril Automático (16.1)', 'T115-LI Anodizado (17)',
      'T116-LI Rack Automático (18)', 'T117-LI Rack Automático (19)',
      'T200-LI CuSO4 Automático (1)', 'T201-LI Níquel Automático (2)', 'T202-LI Cromo Decorativo (3)',
      'T203-LI Zinc (7.1)', 'T204-LI Varios Manual (10.1)', 'T205-LI Plata (9.1)',
      'T206-LI Electroless Níquel (14.1)', 'T207-LI Enjuague Rack Auto (2.1)', 'T208-LI Pre Limpieza (4.1)'
    ]).sort();
    const departamentos = (domain.departamentos || [
      'Administración', 'Almacén', 'Almacén de Materia Prima', 'Calidad', 'Compras',
      'Contabilidad', 'Dirección', 'Ingeniería de Procesos', 'Laboratorio', 'Logística',
      'Mantenimiento', 'Planta 1', 'Planta 2', 'Producción', 'Recursos Humanos',
      'Seguridad e Higiene', 'Sistemas', 'Taller Mecánico', 'Tratamiento de Aguas',
      'Ventas', 'Ventas Internacionales'
    ]).sort();

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
      grupos: catalogs.groups.length
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
      `${counts.grupos} grupos PN\n\n` +
      `Archivo descargado: Catalogos_Steelhead_${new Date().toISOString().slice(0, 10)}.xlsx\n\n` +
      `Siguiente paso: Abre tu plantilla y ejecuta "RefrescarListas".\n` +
      `La macro detectará el archivo automáticamente.`);

    return counts;
  }

  return { fetchAll, generateCatalogsFile };
})();

if (typeof window !== 'undefined') window.CatalogFetcher = CatalogFetcher;
