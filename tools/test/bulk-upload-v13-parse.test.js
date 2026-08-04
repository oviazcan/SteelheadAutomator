// tools/test/bulk-upload-v13-parse.test.js
// Golden test del parser de la zona de datos (parseRows) para el layout v13.
//
// v13 = v12 con 5 pares de rack en vez de 2 → corre +6 TODO lo posterior a los racks
// (geometría/dims/predictivos/referencia). El modo de falla que estos asserts cazan no
// es un crash: es que un CSV v13 leído con V12_COLS saca los predictivos de las columnas
// de dims y escribe basura en producción SIN error visible. Por eso se verifica (a) el
// mapeo completo de las 79 columnas, (b) que v13 NO se confunda con v12 ni al revés, y
// (c) que los slots de rack vacíos/intermedios no desalineen la lista.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Comparación cross-realm: los objetos creados dentro del vm tienen otro prototipo, así
// que assert.deepEqual (strict) falla por reference. Comparamos por JSON.
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

// Header canónico v13 (80 cols) tal como lo emite ExportarCSV sobre la plantilla REAL
// (67 columnas visibles). Los headers de rack van NUMERADOS por el usuario, por consistencia
// con el resto de la hoja; al ser únicos, el AddOut del VBA ya no les agrega sufijo.
// "Instrucciones de Empaque" va entre los predictivos y Notas adicionales.
const RACK_NAME = 'Rack Flybar o Barril';
const RACK_QTY = 'Pzas/Rack Línea';
const V13_HEADERS = [
  'Archivado', 'Validación', 'Forzar', 'Archivar anterior', 'Id SH', 'Cliente', 'Número de parte', 'Descripción', 'PN alterno', 'Grupo',
  'Cantidad', 'Precio', 'Unidad precio', 'Divisa', 'Precio default', 'Línea', 'Metal base', 'Etiqueta 1', 'Etiqueta 2', 'Etiqueta 3',
  'Etiqueta 4', 'Planta Schneider', 'Proceso', 'Producto 1', 'Precio 1', 'Cantidad 1', 'Unidad 1', 'Producto 2', 'Precio 2', 'Cantidad 2',
  'Unidad 2', 'Producto 3', 'Precio 3', 'Cantidad 3', 'Unidad 3', 'Spec 1', 'Esp. Spec 1 (µm)', 'Spec 2', 'Esp. Spec 2 (µm)', 'Spec 3',
  'Esp. Spec 3 (µm)', 'Spec 4', 'Esp. Spec 4 (µm)', 'KGM (kg/pza)', 'CMK (cm²/pza)', 'LM (m/pza)', 'Mín Pzas Lote',
  `${RACK_NAME} 1`, `${RACK_QTY} 1`, `${RACK_NAME} 2`, `${RACK_QTY} 2`, `${RACK_NAME} 3`, `${RACK_QTY} 3`, `${RACK_NAME} 4`, `${RACK_QTY} 4`, `${RACK_NAME} 5`, `${RACK_QTY} 5`,
  'Tipo de Geometría', 'Longitud (m)', 'Ancho (m)', 'Alto (m)', 'Diám.Ext (m)', 'Diám.Int (m)', 'Plata (kg/pza)', 'Estaño (kg/pza)', 'Níquel (kg/pza)',
  'Zinc (kg/pza)', 'Cobre (kg/pza)', 'Antitarnish (L/pza)', 'Epóx. MT (lb/pza)', 'Epóx. BT (lb/pza)', 'Epóx. MTR (lb/pza)',
  'Instrucciones de Empaque', 'Notas adicionales', 'QuoteIBMS', 'EstIBMS', 'Plano',
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

// Fila v13 base con TODAS las columnas pobladas. Devuelve el array de 80 celdas.
function v13Row() {
  const row = new Array(80).fill('');
  row[0] = 'V'; row[1] = 'V'; row[2] = 'F'; row[3] = 'F'; row[4] = 'SH-999'; row[5] = 'ACME'; row[6] = 'PN-TEST-1'; row[7] = 'DESC'; row[8] = 'ALT-1'; row[9] = 'GRUPO-X';
  row[10] = '5'; row[11] = '100'; row[12] = 'PZA'; row[13] = 'USD'; row[14] = 'V'; row[15] = 'LINEA-A'; row[16] = 'COBRE';
  row[17] = 'ET1'; row[18] = 'ET2'; row[19] = 'ET3'; row[20] = 'ET4'; row[21] = 'SCHN'; row[22] = 'PROC-X';
  row[23] = 'PROD-A'; row[24] = '10'; row[25] = '2'; row[26] = 'PZA';
  row[35] = 'NIQUEL | 5-8'; row[37] = 'CROMO | 10'; row[39] = 'ZINC'; // Spec1,2,3 ; Spec4 vacío
  row[43] = '1.5'; row[44] = '2.5'; row[45] = '3.5'; row[46] = '100';
  // 5 racks — el corazón de v13
  row[47] = 'RACK-1'; row[48] = '50';
  row[49] = 'RACK-2'; row[50] = '25';
  row[51] = 'RACK-3'; row[52] = '12';
  row[53] = 'RACK-4'; row[54] = '7';
  row[55] = 'RACK-5'; row[56] = '3';
  row[57] = 'CILINDRO'; row[58] = '0.1'; row[59] = '0.2'; row[60] = '0.3'; row[61] = '0.4'; row[62] = '0.5';
  row[63] = '0.01'; row[66] = '0.04'; // Plata, Zinc
  row[72] = 'Empacar en tarima con esquineros';   // Instrucciones de Empaque (v13)
  row[73] = 'NOTA-PN'; row[74] = 'Q-IBMS'; row[75] = 'E-IBMS'; row[76] = 'PLANO-1';
  row[77] = '200'; row[78] = '8'; row[79] = '15';
  return row;
}

test('parseRows v13: mapea las 80 columnas del CSV canónico (5 racks +6, empaque +1)', () => {
  const BU = loadBulkUpload();
  const { header, parts } = BU.parseRows(BU.parseCSV(buildCsv(V13_HEADERS, v13Row())));
  assert.equal(parts.length, 1);
  const p = parts[0];

  assert.equal(p.schemaVersion, 'v13');
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
  eqJson(p.specs, [{ name: 'NIQUEL', param: '5-8' }, { name: 'CROMO', param: '10' }, { name: 'ZINC', param: '' }]);
  assert.equal(p.unitConv.kgm, 1.5);
  assert.equal(p.unitConv.cmk, 2.5);
  assert.equal(p.unitConv.lm, 3.5);
  assert.equal(p.unitConv.minPzasLote, 100);

  // LO NUEVO: los 5 racks, en orden y con sus piezas por carga.
  eqJson(p.racks, [
    { name: 'RACK-1', ppr: 50 },
    { name: 'RACK-2', ppr: 25 },
    { name: 'RACK-3', ppr: 12 },
    { name: 'RACK-4', ppr: 7 },
    { name: 'RACK-5', ppr: 3 },
  ]);

  // Todo lo posterior a los racks: si V13_COLS tuviera un off-by-6, estos fallan.
  assert.equal(p.tipoGeometria, 'CILINDRO');
  eqJson(p.dims, { length: 0.1, width: 0.2, height: 0.3, outerDiam: 0.4, innerDiam: 0.5 });
  eqJson(p.predictiveUsage, [
    { inventoryItemId: 364506, usagePerPart: '0.01', name: 'Plata Fina' },
    { inventoryItemId: 412805, usagePerPart: '0.04', name: 'Zinc Metálico' },
  ]);
  assert.equal(p.instruccionesEmpaque, 'Empacar en tarima con esquineros');
  assert.equal(p.notasAdicionalesPN, 'NOTA-PN', 'Notas NO debe contaminarse con Instrucciones de Empaque');
  assert.equal(p.quoteIBMS, 'Q-IBMS');
  assert.equal(p.estacionIBMS, 'E-IBMS');
  assert.equal(p.plano, 'PLANO-1');
  assert.equal(p.piezasCarga, 200);
  assert.equal(p.cargasHora, '8');
  assert.equal(p.tiempoEntrega, 15);
  assert.equal(p.departamento, ''); // no exportado en v13 (igual que v12)
  assert.equal(p.codigoSAT, '');    // no exportado en v13 (igual que v12)
  assert.equal(header.modo, 'COTIZACIÓN+NP');
  assert.equal(header.quoteName, 'TEST-QUOTE');
});

test('parseRows v13: slots de rack vacíos NO desalinean la lista (compacta, no rellena)', () => {
  const BU = loadBulkUpload();
  const row = v13Row();
  // Deja solo el 1º y el 4º: el operador llenó saltando renglones.
  row[49] = ''; row[50] = '';
  row[51] = ''; row[52] = '';
  row[55] = ''; row[56] = '';
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(V13_HEADERS, row)));
  eqJson(parts[0].racks, [{ name: 'RACK-1', ppr: 50 }, { name: 'RACK-4', ppr: 7 }]);
  // Y el resto del layout sigue intacto (las columnas no se recorren por celdas vacías).
  assert.equal(parts[0].tipoGeometria, 'CILINDRO');
  assert.equal(parts[0].piezasCarga, 200);
});

test('parseRows v13: un rack con nombre pero sin piezas conserva el rack con ppr null', () => {
  const BU = loadBulkUpload();
  const row = v13Row();
  row[52] = ''; // RACK-3 sin piezas por carga
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(V13_HEADERS, row)));
  const r3 = parts[0].racks.find(r => r.name === 'RACK-3');
  assert.ok(r3, 'el rack sin cantidad NO se descarta: el nombre es la señal de intención');
  assert.equal(r3.ppr, null);
});

test('parseRows v13: el sentinel "-" en el primer slot sigue significando "borrar racks"', () => {
  const BU = loadBulkUpload();
  const row = v13Row();
  for (let i = 47; i <= 56; i++) row[i] = '';
  row[47] = '-';
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(V13_HEADERS, row)));
  // STEP 7 borra los racks del PN cuando racks == [{name:'-'}]; ese contrato exige
  // longitud 1, así que los slots vacíos NO deben agregar entradas fantasma.
  eqJson(parts[0].racks, [{ name: '-', ppr: null }]);
});

test('parseRows: v12 (2 racks) NO se detecta como v13 — no-regresión', () => {
  const BU = loadBulkUpload();
  // Header v12 real: mismas 73 cols, 4 specs, 2 pares de rack.
  // v12 = 47 cols iniciales + 2 pares de rack + (geometría..predictivos) + (notas..entrega),
  // SIN "Instrucciones de Empaque" (índice 72 en v13), que nació en v13.
  const V12_HEADERS = V13_HEADERS.slice(0, 47)
    .concat([RACK_NAME, RACK_QTY, `${RACK_NAME} 2`, `${RACK_QTY} 2`])
    .concat(V13_HEADERS.slice(57, 72))
    .concat(V13_HEADERS.slice(73));
  assert.equal(V12_HEADERS.length, 73, 'el header v12 debe medir 73 columnas');
  const row = new Array(73).fill('');
  row[4] = 'SH-1'; row[5] = 'ACME'; row[6] = 'PN-V12';
  row[35] = 'NIQUEL'; row[37] = 'CROMO'; row[39] = 'ZINC';
  row[47] = 'RACK-L'; row[48] = '50'; row[49] = 'RACK-S'; row[50] = '25';
  row[51] = 'CILINDRO'; row[70] = '200';
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(V12_HEADERS, row)));
  assert.equal(parts[0].schemaVersion, 'v12');
  eqJson(parts[0].racks, [{ name: 'RACK-L', ppr: 50 }, { name: 'RACK-S', ppr: 25 }]);
  assert.equal(parts[0].tipoGeometria, 'CILINDRO', 'v12 no debe correrse +6');
  assert.equal(parts[0].piezasCarga, 200);
});

test('parseRows: red de seguridad — header ancho con racks renombrados cae a v13, no a v12', () => {
  const BU = loadBulkUpload();
  // Alguien renombra los headers de rack a algo que no empieza con "Rack". La señal 1
  // (conteo de racks) muere; la señal 2 (ancho 79) debe salvar la detección, porque
  // caer a v12 leería los predictivos desde las columnas de dims, en silencio.
  const headers = V13_HEADERS.slice();
  for (let i = 47; i <= 56; i += 2) headers[i] = `Carga ${(i - 45) / 2}`;
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(headers, v13Row())));
  assert.equal(parts[0].schemaVersion, 'v13');
  assert.equal(parts[0].piezasCarga, 200, 'el ancho del header salvó el mapeo');
  eqJson(parts[0].predictiveUsage, [
    { inventoryItemId: 364506, usagePerPart: '0.01', name: 'Plata Fina' },
    { inventoryItemId: 412805, usagePerPart: '0.04', name: 'Zinc Metálico' },
  ]);
});

test('parseRows v13: Instrucciones de Empaque distingue los 3 estados del contrato', () => {
  const BU = loadBulkUpload();
  const run = (val) => {
    const row = v13Row();
    row[72] = val;
    return BU.parseRows(BU.parseCSV(buildCsv(V13_HEADERS, row))).parts[0].instruccionesEmpaque;
  };
  // vacío → null (el STEP no toca el nodo). NO puede ser '' porque '' es justo el valor
  // que se ESCRIBE para borrar: confundirlos borraría instrucciones que nadie pidió tocar.
  assert.equal(run(''), null, 'celda vacía debe ser null, no cadena vacía');
  // "-" → se conserva crudo; el STEP lo traduce a descriptionMarkdown:"" (borrar).
  assert.equal(run('-'), '-');
  // dato → tal cual, incluido markdown (el campo del ERP es descriptionMarkdown).
  assert.equal(run('Empacar con **esquineros** y film'), 'Empacar con **esquineros** y film');
});

test('parseRows v13: header angosto (79, sin la columna) NO lee Notas como instrucciones', () => {
  const BU = loadBulkUpload();
  // Plantilla intermedia real: los 5 racks ya estaban, la columna de empaque todavía no.
  // En ese header el índice 72 es "Notas adicionales" — leerlo mandaría las notas del PN
  // al nodo de empaque. Debe apagarse la columna, no adivinar.
  const headers = V13_HEADERS.slice(0, 72).concat(V13_HEADERS.slice(73));
  assert.equal(headers.length, 79);
  const row = v13Row();
  row.splice(72, 1); // quita la celda de instrucciones, recorriendo el resto
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(headers, row)));
  assert.equal(parts[0].schemaVersion, 'v13', 'los 5 racks siguen identificando v13');
  assert.equal(parts[0].instruccionesEmpaque, null, 'sin columna acreditada, no se lee');
  assert.equal(parts[0].notasAdicionalesPN, 'NOTA-PN', 'las notas siguen en su lugar');
});

test('parseRows: en v10/v11/v12 el campo de empaque es null (no existe la columna)', () => {
  const BU = loadBulkUpload();
  const V12_HEADERS = V13_HEADERS.slice(0, 47)
    .concat([RACK_NAME, RACK_QTY, `${RACK_NAME} 2`, `${RACK_QTY} 2`])
    .concat(V13_HEADERS.slice(57, 72))
    .concat(V13_HEADERS.slice(73));
  const row = new Array(73).fill('');
  row[4] = 'SH-1'; row[5] = 'ACME'; row[6] = 'PN-V12';
  row[35] = 'NIQUEL'; row[37] = 'CROMO'; row[39] = 'ZINC';
  row[66] = 'NOTA-V12';
  const { parts } = BU.parseRows(BU.parseCSV(buildCsv(V12_HEADERS, row)));
  assert.equal(parts[0].schemaVersion, 'v12');
  assert.equal(parts[0].instruccionesEmpaque, null);
  assert.equal(parts[0].notasAdicionalesPN, 'NOTA-V12');
});

test('parseRows: v11 y v10 siguen intactos tras generalizar racks a N slots', () => {
  const BU = loadBulkUpload();
  // v11: Id SH en E, 2 specs, 2 racks (71 cols).
  const V11_HEADERS = [
    'Archivado', 'Validación', 'Forzar', 'Archivar anterior', 'Id SH', 'Cliente', 'Número de parte', 'Descripción', 'PN alterno', 'Grupo',
    'Cantidad', 'Precio', 'Unidad precio', 'Divisa', 'Precio default', 'Línea', 'Metal base', 'Etiqueta 1', 'Etiqueta 2', 'Etiqueta 3',
    'Etiqueta 4', 'Etiqueta 5', 'Proceso', 'Producto 1', 'Precio 1', 'Cantidad 1', 'Unidad 1', 'Producto 2', 'Precio 2', 'Cantidad 2',
    'Unidad 2', 'Producto 3', 'Precio 3', 'Cantidad 3', 'Unidad 3', 'Spec 1', 'Esp. Spec 1 (µm)', 'Spec 2', 'Esp. Spec 2 (µm)', 'KGM (kg/pza)',
    'CMK (cm²/pza)', 'LM (m/pza)', 'Mín Pzas Lote', RACK_NAME, RACK_QTY, `${RACK_NAME} 2`, `${RACK_QTY} 2`, 'Tipo de Geometría', 'Longitud (m)', 'Ancho (m)',
    'Alto (m)', 'Diám.Ext (m)', 'Diám.Int (m)', 'Departamento', 'Codigo SAT', 'Plata (kg/pza)', 'Estaño (kg/pza)', 'Níquel (kg/pza)', 'Zinc (kg/pza)', 'Cobre (kg/pza)',
    'Antitarnish (L/pza)', 'Epóx. MT (lb/pza)', 'Epóx. BT (lb/pza)', 'Epóx. MTR (lb/pza)', 'Notas adicionales', 'QuoteIBMS', 'EstIBMS', 'Plano', 'Piezas por Carga', 'Cargas por Hora',
    'Tiempo de Entrega',
  ];
  const r11 = new Array(71).fill('');
  r11[4] = 'SH-1'; r11[5] = 'ACME'; r11[6] = 'PN-V11';
  r11[43] = 'RACK-L'; r11[44] = '50'; r11[45] = 'RACK-S'; r11[46] = '25';
  const v11 = BU.parseRows(BU.parseCSV(buildCsv(V11_HEADERS, r11)));
  assert.equal(v11.parts[0].schemaVersion, 'v11');
  eqJson(v11.parts[0].racks, [{ name: 'RACK-L', ppr: 50 }, { name: 'RACK-S', ppr: 25 }]);

  // v10: col E = "Cliente" (sin Id SH), racks en 41..44.
  const V10_HEADERS = new Array(69).fill('');
  V10_HEADERS[0] = 'Archivado'; V10_HEADERS[4] = 'Cliente'; V10_HEADERS[5] = 'Número de parte';
  V10_HEADERS[41] = RACK_NAME; V10_HEADERS[42] = RACK_QTY; V10_HEADERS[43] = `${RACK_NAME} 2`; V10_HEADERS[44] = `${RACK_QTY} 2`;
  const r10 = new Array(69).fill('');
  r10[4] = 'ACME'; r10[5] = 'PN-V10';
  r10[41] = 'RACK-L'; r10[42] = '50'; r10[43] = 'RACK-S'; r10[44] = '25';
  const v10 = BU.parseRows(BU.parseCSV(buildCsv(V10_HEADERS, r10)));
  assert.equal(v10.parts[0].schemaVersion, 'v10');
  eqJson(v10.parts[0].racks, [{ name: 'RACK-L', ppr: 50 }, { name: 'RACK-S', ppr: 25 }]);
});
