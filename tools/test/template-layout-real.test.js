// tools/test/template-layout-real.test.js
// Ata las PLANTILLAS REALES del repo al parser: lee cada .xlsm, simula ExportarCSV y verifica
// que el CSV que produce sea el que el parser espera, columna por columna.
//
// Por qué en la suite y no sólo en el verificador manual: la plantilla la edita un humano en
// Excel y el parser la lee por POSICIÓN. Un corrimiento no truena — escribe datos en el campo
// equivocado, en producción, en silencio. Mientras el .xlsm viva en el repo, su layout es parte
// del contrato y debe romper la suite si cambia, sin depender de que alguien se acuerde de
// correr `node tools/verify-template-layout.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V = require('../verify-template-layout.js');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'remote', 'scripts');

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
  for (const f of ['bulk-upload-parse.js', 'bulk-upload-classify.js', 'bulk-upload-cc.js', 'bulk-upload-packing.js']) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(SCRIPTS, 'bulk-upload.js'), 'utf8'), sandbox, { filename: 'bulk-upload.js' });
  return sandbox.window.BulkUpload;
}

function canonOf(rel) {
  const abs = path.join(ROOT, rel);
  const sst = V.sharedStrings(abs);
  return V.canonicalHeaders(V.readRow(abs, V.sheetPathFor(abs, 'Upload'), 7, sst));
}

// Pasa un CSV con una sonda por columna por el parser REAL y devuelve el `part`.
function parseConSondas(canon, sondas) {
  const row = canon.map((_, i) => `P${i}`);
  row[4] = 'SH-1'; row[5] = 'ACME'; row[6] = 'PN-PROBE';
  for (const [i, v] of Object.entries(sondas)) row[i] = v;
  const csv = [
    'COTIZACIÓN+NP', 'Empresa Emisora:,ECOPLATING', 'Nombre Cotizacion/Layout:,T',
    'Notas Externas:,', 'Notas Internas:,', 'Asignado:,QA', 'Valida Hasta (dias):,30',
    canon.join(','), row.join(','),
  ].join('\n');
  const BU = loadBulkUpload();
  return BU.parseRows(BU.parseCSV(csv)).parts[0];
}

const V13 = [
  'remote/templates/Plantilla_CargaMasiva_v13.xlsm',
  'remote/templates/Plantilla_CargaMasiva_v13_compatibilidad.xlsm',
];

for (const rel of V13) {
  const nombre = path.basename(rel);

  test(`${nombre}: produce el CSV canónico v13 (80 columnas)`, (t) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return t.skip('plantilla ausente');
    const canon = canonOf(rel);
    assert.equal(canon.length, 80, 'el header canónico v13 mide 80 columnas');
  });

  test(`${nombre}: los 5 slots de rack NUMERADOS se detectan y mapean`, (t) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return t.skip('plantilla ausente');
    const canon = canonOf(rel);

    // Los headers van numerados ("Rack Flybar o Barril 1".."5"). Al ser únicos, el AddOut del
    // VBA ya NO les agrega el sufijo " 2" que sí generaba en v12 con headers repetidos.
    const rackIdx = canon.map((h, i) => (/^rack\b/i.test(h.trim()) ? i : -1)).filter(i => i >= 0);
    assert.deepEqual(rackIdx, [47, 49, 51, 53, 55], 'los 5 slots deben caer en las columnas canónicas esperadas');

    // La columna de piezas CONTIENE "Rack" pero no empieza con él: no debe inflar el conteo.
    // Con /rack/i (sin ancla) serían 10 y la versión se detectaría por accidente.
    const conRackEnMedio = canon.filter(h => /rack/i.test(h) && !/^rack\b/i.test(h.trim()));
    assert.equal(conRackEnMedio.length, 5, 'las 5 columnas de piezas por rack');

    // Mapeo real, con nombre y cantidad distintos por slot: caza cualquier cruce de pares.
    const sondas = {};
    rackIdx.forEach((ci, n) => { sondas[ci] = `RACK-${n + 1}`; sondas[ci + 1] = String((n + 1) * 10); });
    const p = parseConSondas(canon, sondas);
    assert.equal(p.schemaVersion, 'v13');
    assert.equal(
      JSON.stringify(p.racks),
      JSON.stringify(Array.from({ length: 5 }, (_, n) => ({ name: `RACK-${n + 1}`, ppr: (n + 1) * 10 }))),
      'los 5 racks deben salir en orden y con SU cantidad',
    );
  });

  test(`${nombre}: Instrucciones de Empaque no se cruza con Notas`, (t) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return t.skip('plantilla ausente');
    const canon = canonOf(rel);
    const p = parseConSondas(canon, { 72: 'EMPAQUE', 73: 'NOTAS' });
    assert.equal(p.instruccionesEmpaque, 'EMPAQUE');
    assert.equal(p.notasAdicionalesPN, 'NOTAS', 'son columnas vecinas: un corrimiento las intercambia');
  });

  test(`${nombre}: lo posterior a los racks no quedó corrido`, (t) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return t.skip('plantilla ausente');
    const canon = canonOf(rel);
    const p = parseConSondas(canon, { 57: 'GEOM', 63: '0.01', 77: '4321', 79: '15' });
    assert.equal(p.tipoGeometria, 'GEOM');
    assert.equal(p.predictiveUsage?.[0]?.usagePerPart, '0.01');
    assert.equal(p.piezasCarga, 4321);
    assert.equal(p.tiempoEntrega, 15);
  });
}

test('Plantilla v12: sigue siendo v12 (2 racks) tras generalizar a N slots', (t) => {
  const rel = 'remote/templates/Plantilla_CargaMasiva_v12.xlsm';
  if (!fs.existsSync(path.join(ROOT, rel))) return t.skip('plantilla ausente');
  const canon = canonOf(rel);
  assert.equal(canon.length, 73);
  const p = parseConSondas(canon, { 47: 'RACK-A', 48: '7', 49: 'RACK-B', 50: '9', 51: 'GEOM', 70: '111' });
  assert.equal(p.schemaVersion, 'v12');
  assert.equal(JSON.stringify(p.racks), JSON.stringify([{ name: 'RACK-A', ppr: 7 }, { name: 'RACK-B', ppr: 9 }]));
  assert.equal(p.tipoGeometria, 'GEOM', 'v12 no debe correrse');
  assert.equal(p.piezasCarga, 111);
  assert.equal(p.instruccionesEmpaque, null, 'la columna no existe en v12');
});
