// tools/test/bulk-upload-v12-parse.test.js
// Golden test del parser de la zona de datos (parseRows) para el layout v12.
//
// Carga remote/scripts/bulk-upload.js + módulos satélite en un vm con stubs y
// ejerce window.BulkUpload.parseRows sobre el CSV CANÓNICO que emite ExportarCSV
// v15. El punto crítico: v12 trae 4 specs (vs 2 en v11), lo que corre +4 TODO lo
// posterior a las specs (KGM/racks/dims/predictivos/cargasHora). Si V12_COLS tiene
// un off-by-one, estos asserts lo cazan. También verifica que la detección de
// schema NO confunda v11 (2 specs) con v12 (4 specs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Comparación cross-realm: los objetos creados dentro del vm tienen otro
// prototipo, así que assert.deepEqual (strict) falla por reference. Comparamos
// por JSON.
const eqJson = (got, want, msg) => assert.equal(JSON.stringify(got), JSON.stringify(want), msg);

const SCRIPTS = path.join(__dirname, '..', '..', 'remote', 'scripts');

function loadBulkUpload() {
  const sandbox = {
    window: {}, document: { getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} }, createElement: () => ({ appendChild() {}, classList: { add() {} } }) },
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => { throw new Error('fetch stub'); },
    chrome: { runtime: { sendMessage() {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => '', revokeObjectURL() {} }, Blob: function () {},
    TextEncoder, TextDecoder,
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.window.SteelheadAPI = { log() {}, warn() {}, getConfig: () => ({}) };
  vm.createContext(sandbox);
  for (const f of ['bulk-upload-parse.js', 'bulk-upload-classify.js', 'bulk-upload-cc.js']) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(SCRIPTS, 'bulk-upload.js'), 'utf8'), sandbox, { filename: 'bulk-upload.js' });
  if (!sandbox.window.BulkUpload?.parseRows) throw new Error('window.BulkUpload.parseRows no expuesto');
  return sandbox.window.BulkUpload;
}

// Header canónico v12 (73 cols) tal como lo emite ExportarCSV v15.
const V12_HEADERS = [
  'Archivado', 'Validación', 'Forzar', 'Archivar anterior', 'Id SH', 'Cliente', 'Número de parte', 'Descripción', 'PN alterno', 'Grupo',
  'Cantidad', 'Precio', 'Unidad precio', 'Divisa', 'Precio default', 'Línea', 'Metal base', 'Etiqueta 1', 'Etiqueta 2', 'Etiqueta 3',
  'Etiqueta 4', 'Planta Schneider', 'Proceso', 'Producto 1', 'Precio 1', 'Cantidad 1', 'Unidad 1', 'Producto 2', 'Precio 2', 'Cantidad 2',
  'Unidad 2', 'Producto 3', 'Precio 3', 'Cantidad 3', 'Unidad 3', 'Spec 1', 'Esp. Spec 1 (µm)', 'Spec 2', 'Esp. Spec 2 (µm)', 'Spec 3',
  'Esp. Spec 3 (µm)', 'Spec 4', 'Esp. Spec 4 (µm)', 'KGM (kg/pza)', 'CMK (cm²/pza)', 'LM (m/pza)', 'Mín Pzas Lote', 'Rack Flybar o Barril (Carga)', 'Pzas/Rack Línea', 'Rack Flybar o Barril (Carga) 2',
  'Pzas/Rack Línea 2', 'Tipo de Geometría', 'Longitud (m)', 'Ancho (m)', 'Alto (m)', 'Diám.Ext (m)', 'Diám.Int (m)', 'Plata (kg/pza)', 'Estaño (kg/pza)', 'Níquel (kg/pza)',
  'Zinc (kg/pza)', 'Cobre (kg/pza)', 'Antitarnish (L/pza)', 'Epóx. MT (lb/pza)', 'Epóx. BT (lb/pza)', 'Epóx. MTR (lb/pza)', 'Notas adicionales', 'QuoteIBMS', 'EstIBMS', 'Plano',
  'Piezas por Carga', 'Cargas por Hora', 'Tiempo de Entrega',
];

function buildCsv(headers, dataRow) {
  return [
    'COTIZACIÓN+NP',
    'Empresa Emisora:,ECOPLATING',
    'Nombre Cotizacion/Layout:,TEST-QUOTE',
    'Notas Externas:,',
    'Notas Internas:,',
    'Asignado:,Juan',
    'Valida Hasta (dias):,30',
    headers.join(','),
    dataRow.join(','),
  ].join('\n');
}

test('parseRows v12: mapea todas las columnas del CSV canónico (4 specs corren +4)', () => {
  const BU = loadBulkUpload();
  const row = new Array(73).fill('');
  row[0] = 'V'; row[1] = 'V'; row[2] = 'F'; row[3] = 'F'; row[4] = 'SH-999'; row[5] = 'ACME'; row[6] = 'PN-TEST-1'; row[7] = 'DESC'; row[8] = 'ALT-1'; row[9] = 'GRUPO-X';
  row[10] = '5'; row[11] = '100'; row[12] = 'PZA'; row[13] = 'USD'; row[14] = 'V'; row[15] = 'LINEA-A'; row[16] = 'COBRE';
  row[17] = 'ET1'; row[18] = 'ET2'; row[19] = 'ET3'; row[20] = 'ET4'; row[21] = 'SCHN'; row[22] = 'PROC-X';
  row[23] = 'PROD-A'; row[24] = '10'; row[25] = '2'; row[26] = 'PZA';
  row[35] = 'NIQUEL | 5-8'; row[37] = 'CROMO | 10'; row[39] = 'ZINC'; // Spec1,2,3 ; Spec4 vacío
  row[43] = '1.5'; row[44] = '2.5'; row[45] = '3.5'; row[46] = '100';
  row[47] = 'RACK-L'; row[48] = '50'; row[49] = 'RACK-S'; row[50] = '25';
  row[51] = 'CILINDRO'; row[52] = '0.1'; row[53] = '0.2'; row[54] = '0.3'; row[55] = '0.4'; row[56] = '0.5';
  row[57] = '0.01'; row[60] = '0.04'; // Plata, Zinc
  row[66] = 'NOTA-PN'; row[67] = 'Q-IBMS'; row[68] = 'E-IBMS'; row[69] = 'PLANO-1';
  row[70] = '200'; row[71] = '8'; row[72] = '15';

  const { header, parts } = BU.parseRows(BU.parseCSV(buildCsv(V12_HEADERS, row)));
  assert.equal(parts.length, 1);
  const p = parts[0];

  assert.equal(p.schemaVersion, 'v12');
  assert.equal(p.pn, 'PN-TEST-1');
  assert.equal(p.idSh, 'SH-999');
  assert.equal(p.cliente, 'ACME');
  assert.equal(p.pnGroup, 'GRUPO-X');
  assert.equal(p.qty, 5);
  assert.equal(p.precio, 100);
  assert.equal(p.archivado, true);
  assert.equal(p.validacion1er, true);
  eqJson(p.labels, ['ET1', 'ET2', 'ET3', 'ET4', 'SCHN']);
  assert.equal(p.metalBase, 'COBRE');
  assert.equal(p.linea, 'LINEA-A');
  assert.equal(p.procesoOverride, 'PROC-X');
  eqJson(p.products, [{ name: 'PROD-A', price: 10, qty: 2, unit: 'PZA' }]);
  // las 3 specs (la 3ra solo existe en v12; en v11 se leería mal)
  eqJson(p.specs, [{ name: 'NIQUEL', param: '5-8' }, { name: 'CROMO', param: '10' }, { name: 'ZINC', param: '' }]);
  assert.equal(p.unitConv.kgm, 1.5);
  assert.equal(p.unitConv.cmk, 2.5);
  assert.equal(p.unitConv.lm, 3.5);
  assert.equal(p.unitConv.minPzasLote, 100);
  eqJson(p.racks, [{ name: 'RACK-L', ppr: 50 }, { name: 'RACK-S', ppr: 25 }]);
  assert.equal(p.tipoGeometria, 'CILINDRO');
  eqJson(p.dims, { length: 0.1, width: 0.2, height: 0.3, outerDiam: 0.4, innerDiam: 0.5 });
  eqJson(p.predictiveUsage, [
    { inventoryItemId: 364506, usagePerPart: '0.01', name: 'Plata Fina' },
    { inventoryItemId: 412805, usagePerPart: '0.04', name: 'Zinc Metálico' },
  ]);
  assert.equal(p.notasAdicionalesPN, 'NOTA-PN');
  assert.equal(p.quoteIBMS, 'Q-IBMS');
  assert.equal(p.estacionIBMS, 'E-IBMS');
  assert.equal(p.plano, 'PLANO-1');
  assert.equal(p.piezasCarga, 200);
  assert.equal(p.cargasHora, '8');
  assert.equal(p.tiempoEntrega, 15);
  assert.equal(p.departamento, ''); // no exportado en v12
  assert.equal(p.codigoSAT, '');    // no exportado en v12
  assert.equal(header.modo, 'COTIZACIÓN+NP');
  assert.equal(header.quoteName, 'TEST-QUOTE');
});

test('parseRows: detección NO confunde v11 (2 specs) con v12', () => {
  const BU = loadBulkUpload();
  // Header v11: Id SH en E, solo 2 specs → debe detectar v11, no v12.
  const V11_HEADERS = [
    'Archivado', 'Validación', 'Forzar', 'Archivar anterior', 'Id SH', 'Cliente', 'Número de parte', 'Descripción', 'PN alterno', 'Grupo',
    'Cantidad', 'Precio', 'Unidad precio', 'Divisa', 'Precio default', 'Línea', 'Metal base', 'Etiqueta 1', 'Etiqueta 2', 'Etiqueta 3',
    'Etiqueta 4', 'Etiqueta 5', 'Proceso', 'Producto 1', 'Precio 1', 'Cantidad 1', 'Unidad 1', 'Producto 2', 'Precio 2', 'Cantidad 2',
    'Unidad 2', 'Producto 3', 'Precio 3', 'Cantidad 3', 'Unidad 3', 'Spec 1', 'Esp. Spec 1 (µm)', 'Spec 2', 'Esp. Spec 2 (µm)', 'KGM (kg/pza)',
    'CMK (cm²/pza)', 'LM (m/pza)', 'Mín Pzas Lote', 'Rack Flybar o Barril (Carga)', 'Pzas/Rack Línea', 'Rack Flybar o Barril (Carga) 2', 'Pzas/Rack Línea 2', 'Tipo de Geometría', 'Longitud (m)', 'Ancho (m)',
    'Alto (m)', 'Diám.Ext (m)', 'Diám.Int (m)', 'Departamento', 'Codigo SAT', 'Plata (kg/pza)', 'Estaño (kg/pza)', 'Níquel (kg/pza)', 'Zinc (kg/pza)', 'Cobre (kg/pza)',
    'Antitarnish (L/pza)', 'Epóx. MT (lb/pza)', 'Epóx. BT (lb/pza)', 'Epóx. MTR (lb/pza)', 'Notas adicionales', 'QuoteIBMS', 'EstIBMS', 'Plano', 'Piezas por Carga', 'Cargas por Hora',
    'Tiempo de Entrega',
  ];
  const row = new Array(71).fill('');
  row[4] = 'SH-1'; row[5] = 'ACME'; row[6] = 'PN-V11';
  row[35] = 'NIQUEL'; row[37] = 'CROMO'; // 2 specs
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(V11_HEADERS, row)));
  assert.equal(parts[0].schemaVersion, 'v11');
  assert.equal(parts[0].pn, 'PN-V11');
  eqJson(parts[0].specs, [{ name: 'NIQUEL', param: '' }, { name: 'CROMO', param: '' }]);
});
