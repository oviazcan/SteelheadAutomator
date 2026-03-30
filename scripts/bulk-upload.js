// Steelhead Bulk Upload Module
// Parses Excel/CSV and executes the 9-step pipeline against Steelhead API
// Depends on: SteelheadAPI (steelhead-api.js), SheetJS (xlsx)

const BulkUpload = (() => {
  'use strict';

  // Pipeline status callback
  let onProgress = () => {};

  function setProgressCallback(fn) {
    onProgress = fn;
  }

  // Parse uploaded file (CSV or XLSX) into header + data rows
  function parseFile(fileData, fileType) {
    // TODO: Implement with SheetJS
    // For CSV: parse 61 columns, header section rows 3-17, data rows 22+
    // For XLSX: read "Upload" sheet, same structure
    throw new Error('parseFile no implementado aún');
  }

  // Main pipeline - 9 steps
  async function execute(fileData, fileType) {
    onProgress('Paso 1/9: Parseando archivo...', 0);
    const { header, rows } = parseFile(fileData, fileType);

    onProgress('Paso 2/9: Resolviendo header...', 11);
    // TODO: Resolve customer, process, assignee by name → ID

    onProgress('Paso 3/9: Cargando catálogos...', 22);
    // TODO: Load labels, specs, racks, units, products, groups

    onProgress('Paso 4/9: Verificando PNs existentes...', 33);
    // TODO: Search existing PNs, decide create vs. reuse

    onProgress('Paso 5/9: Preview...', 44);
    // TODO: Show preview modal, wait for confirmation

    onProgress('Paso 6/9: Creando cotización...', 55);
    // TODO: CreateQuote with custom inputs

    onProgress('Paso 7/9: Creando/vinculando PNs...', 66);
    // TODO: SavePartNumber + SaveManyPNP (batches of 20)

    onProgress('Paso 8/9: Re-leyendo cotización...', 77);
    // TODO: GetQuote to get PN-to-line mapping

    onProgress('Paso 9/9: Enriquecimiento de PNs...', 88);
    // TODO: Labels, specs, dimensions, racks, predictive usage, archive

    onProgress('Completado', 100);
    return { success: true, message: 'Pipeline completado' };
  }

  return { execute, setProgressCallback };
})();

if (typeof window !== 'undefined') {
  window.BulkUpload = BulkUpload;
}
