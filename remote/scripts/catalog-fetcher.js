// Steelhead Catalog Fetcher
// Queries Steelhead API for fresh catalog data to populate Excel template
// Depends on: SteelheadAPI (steelhead-api.js)

const CatalogFetcher = (() => {
  'use strict';

  // Fetch all catalogs in parallel
  async function fetchAll() {
    const [customers, processes, products, labels, specs, racks] = await Promise.all([
      fetchCustomers(),
      fetchProcesses(),
      fetchProducts(),
      fetchLabels(),
      fetchSpecs(),
      fetchRacks()
    ]);

    return { customers, processes, products, labels, specs, racks };
  }

  async function fetchCustomers() {
    const data = await SteelheadAPI.query('CustomerSearchByName', {
      nameLike: '%%',
      orderBy: [{ column: 'NAME', order: 'ASC' }]
    });
    // TODO: Format as "Nombre — Dirección" like VBA Module2
    return data?.customers?.nodes || [];
  }

  async function fetchProcesses() {
    const data = await SteelheadAPI.query('AllProcesses', {
      includeArchived: false,
      processNodeTypes: ['process'],
      searchQuery: '',
      first: 200
    });
    return data?.processNodes?.nodes || [];
  }

  async function fetchProducts() {
    const data = await SteelheadAPI.query('SearchProducts', {
      searchQuery: '',
      first: 200
    });
    return data?.products?.nodes || [];
  }

  async function fetchLabels() {
    const data = await SteelheadAPI.query('AllLabels', {
      condition: { forPartNumber: true }
    });
    return data?.labels?.nodes || [];
  }

  async function fetchSpecs() {
    const data = await SteelheadAPI.query('SearchSpecsForSelect', {
      like: '%%',
      locationIds: [],
      alreadySelectedSpecs: [],
      orderBy: [{ column: 'NAME', order: 'ASC' }]
    });
    // TODO: For each spec with "espesor" field, format as "SpecName | ParamName"
    return data?.specs?.nodes || [];
  }

  async function fetchRacks() {
    const data = await SteelheadAPI.query('AllRackTypes', {});
    const allRacks = data?.rackTypes?.nodes || [];
    const lineaRacks = allRacks.filter(r =>
      r.name?.includes('-FL') || r.name?.includes('-BA') || r.name?.includes('Barril')
    );
    return { all: allRacks, linea: lineaRacks };
  }

  return { fetchAll, fetchCustomers, fetchProcesses, fetchProducts, fetchLabels, fetchSpecs, fetchRacks };
})();

if (typeof window !== 'undefined') {
  window.CatalogFetcher = CatalogFetcher;
}
