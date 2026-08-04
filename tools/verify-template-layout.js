#!/usr/bin/env node
// tools/verify-template-layout.js — verifica que una plantilla .xlsm produzca el layout
// que el parser de bulk-upload espera, SIN abrir Excel y SIN correr una carga real.
//
// Por qué existe: la plantilla la edita un humano en Excel y el parser la lee por
// POSICIÓN. Si el header queda corrido una columna, no truena nada: los datos se
// escriben en el campo equivocado, en producción, en silencio. Este script cierra ese
// hueco antes del deploy.
//
// Cómo lo hace (end-to-end, sin duplicar el contrato):
//   1. Lee la fila de encabezados de la hoja Upload directo del .xlsm (es un ZIP).
//   2. Simula la sección 3 de ExportarCSV (vbas/Module1.bas): normaliza los headers,
//      expande Estatus/Forzar duplicado/Productos, renombra "Etiqueta Planta Schneider"
//      y desambigua los headers repetidos con " 2".." N" (helper AddOut).
//   3. Construye un CSV canónico con un VALOR SONDA distinto por columna y lo pasa por
//      el parser REAL (window.BulkUpload.parseRows), no por una copia de sus reglas.
//   4. Verifica que cada sonda haya aterrizado en el campo que le toca.
//
// Uso:
//   node tools/verify-template-layout.js remote/templates/Plantilla_CargaMasiva_v13.xlsm
//   node tools/verify-template-layout.js <ruta.xlsm> --expect v12
//
// Salida: 0 si el layout es el esperado; 1 con el detalle de la discrepancia si no.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPTS = path.join(__dirname, '..', 'remote', 'scripts');

// ── 1) Leer el .xlsm (ZIP) ────────────────────────────────────────────────────
const unzip = (file, entry) => execFileSync('unzip', ['-p', file, entry], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

function sheetPathFor(file, sheetName) {
  const wb = unzip(file, 'xl/workbook.xml');
  const rels = unzip(file, 'xl/_rels/workbook.xml.rels');
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    if (m[1] === sheetName) {
      const t = relMap[m[2]].replace(/^\/?xl\//, '');
      return `xl/${t}`;
    }
  }
  throw new Error(`No encontré la hoja "${sheetName}" en ${path.basename(file)}`);
}

function sharedStrings(file) {
  let xml;
  try { xml = unzip(file, 'xl/sharedStrings.xml'); } catch { return []; }
  // Cada <si> puede traer varios <t> (rich text) — se concatenan, como hace Excel.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join(''));
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

const colToNum = (ref) => {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
};

function readRow(file, sheetFile, rowNum, sst) {
  const xml = unzip(file, sheetFile);
  const re = new RegExp(`<row[^>]*\\br="${rowNum}"[^>]*>([\\s\\S]*?)</row>`);
  const m = xml.match(re);
  if (!m) throw new Error(`La hoja no tiene fila ${rowNum}`);
  const cells = {};
  for (const c of m[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = c[1], inner = c[2];
    const ref = attrs.match(/\br="([A-Z]+\d+)"/);
    if (!ref) continue;
    const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
    let val = '';
    if (t === 's') {
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (v) val = sst[+v[1]] ?? '';
    } else if (t === 'inlineStr') {
      val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => decodeXml(x[1])).join('');
    } else {
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (v) val = decodeXml(v[1]);
    }
    cells[colToNum(ref[1])] = val;
  }
  const max = Math.max(0, ...Object.keys(cells).map(Number));
  return Array.from({ length: max }, (_, i) => cells[i + 1] ?? '');
}

// ── 2) Simular ExportarCSV §3 (vbas/Module1.bas) ──────────────────────────────
// NormHeader: colapsa saltos de línea y espacios dobles, recorta.
const normHeader = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();

function canonicalHeaders(visibleHeaders) {
  const out = [];
  const used = new Set();
  // AddOut: si el header ya se usó, le agrega " 2", " 3", ... hasta encontrar libre.
  const add = (hdr) => {
    let cand = hdr, k = 1;
    while (used.has(cand)) { k++; cand = `${hdr} ${k}`; }
    used.add(cand);
    out.push(cand);
  };
  for (const raw of visibleHeaders) {
    const hn = normHeader(raw);
    if (!hn) continue;
    switch (hn.toLowerCase()) {
      case 'estatus': add('Archivado'); add('Validación'); break;
      case 'forzar duplicado': add('Forzar'); add('Archivar anterior'); break;
      case 'productos':
        for (let gi = 1; gi <= 3; gi++) { add(`Producto ${gi}`); add(`Precio ${gi}`); add(`Cantidad ${gi}`); add(`Unidad ${gi}`); }
        break;
      case 'etiqueta planta schneider': add('Planta Schneider'); break;
      default: add(hn);
    }
  }
  return out;
}

// ── 3) Cargar el parser REAL ──────────────────────────────────────────────────
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
  return sandbox.window.BulkUpload;
}

// ── 4) Contrato esperado por versión ──────────────────────────────────────────
// Sondas: texto donde el parser lee texto, número donde lee número. Cada aserción dice
// "la columna N de la plantilla debe aterrizar en ESTE campo del objeto part".
const LAYOUTS = {
  v12: { width: 73, rackSlots: 2, geom: 51, piezasCarga: 70, tiempoEntrega: 72, predPlata: 57, empaque: -1, notas: 66 },
  v13: { width: 80, rackSlots: 5, geom: 57, piezasCarga: 77, tiempoEntrega: 79, predPlata: 63, empaque: 72, notas: 73 },
};

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const expectIdx = args.indexOf('--expect');
  const expect = expectIdx >= 0 ? args[expectIdx + 1] : null;
  if (!file) {
    console.error('Uso: node tools/verify-template-layout.js <ruta.xlsm> [--expect v12|v13]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) { console.error(`No existe: ${file}`); process.exit(2); }

  const sst = sharedStrings(file);
  const sheetFile = sheetPathFor(file, 'Upload');
  const visible = readRow(file, sheetFile, 7, sst);
  const canon = canonicalHeaders(visible);

  console.log(`Plantilla : ${path.basename(file)}`);
  console.log(`Hoja      : Upload (${sheetFile})`);
  console.log(`Columnas  : ${visible.filter(h => normHeader(h)).length} visibles → ${canon.length} canónicas en el CSV\n`);

  const rackIdx = canon.map((h, i) => (/^rack\b/i.test(h) ? i : -1)).filter(i => i >= 0);
  console.log(`Slots de rack detectados: ${rackIdx.length} (columnas canónicas ${rackIdx.join(', ')})`);

  const guess = expect || (canon.length >= 79 || rackIdx.length >= 3 ? 'v13' : 'v12');
  const L = LAYOUTS[guess];
  if (!L) { console.error(`Versión desconocida: ${guess}`); process.exit(2); }
  console.log(`Contrato verificado contra: ${guess}\n`);

  // CSV canónico con sondas: PROBE_<i> en texto; los numéricos reciben el índice.
  const row = new Array(canon.length).fill('');
  for (let i = 0; i < canon.length; i++) row[i] = `P${i}`;
  row[4] = 'SH-1'; row[5] = 'ACME'; row[6] = 'PN-PROBE';
  // Racks: nombre texto, piezas número — así se verifica el PAR completo.
  rackIdx.forEach((ci, n) => { row[ci] = `RACK-${n + 1}`; row[ci + 1] = String((n + 1) * 10); });
  row[L.geom] = 'GEOM-PROBE';
  row[L.predPlata] = '0.01';
  row[L.piezasCarga] = '4321';
  row[L.tiempoEntrega] = '15';
  row[L.notas] = 'NOTAS-PROBE';
  if (L.empaque >= 0) row[L.empaque] = 'EMPAQUE-PROBE';

  const csv = [
    'COTIZACIÓN+NP', 'Empresa Emisora:,ECOPLATING', 'Nombre Cotizacion/Layout:,VERIFY',
    'Notas Externas:,', 'Notas Internas:,', 'Asignado:,QA', 'Valida Hasta (dias):,30',
    canon.join(','), row.join(','),
  ].join('\n');

  const BU = loadBulkUpload();
  const { parts } = BU.parseRows(BU.parseCSV(csv));
  if (!parts.length) { console.error('✗ El parser no devolvió ninguna fila.'); process.exit(1); }
  const p = parts[0];

  const fails = [];
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  ← esperaba ${JSON.stringify(want)}`}`);
    if (!ok) fails.push(label);
  };

  console.log('Verificación del mapeo (sondas → campos del parser):');
  check('schemaVersion', p.schemaVersion, guess);
  check('ancho del header canónico', canon.length, L.width);
  check('slots de rack', rackIdx.length, L.rackSlots);
  check('racks (nombre + piezas por carga)', p.racks,
    Array.from({ length: L.rackSlots }, (_, n) => ({ name: `RACK-${n + 1}`, ppr: (n + 1) * 10 })));
  check('tipoGeometría (1ª columna DESPUÉS de los racks)', p.tipoGeometria, 'GEOM-PROBE');
  check('predictivo Plata', p.predictiveUsage?.[0]?.usagePerPart, '0.01');
  // Empaque y Notas van pegadas: si la columna nueva se corre, una se lee como la otra.
  check('Instrucciones de Empaque', p.instruccionesEmpaque, L.empaque >= 0 ? 'EMPAQUE-PROBE' : null);
  check('Notas adicionales (vecina de Empaque)', p.notasAdicionalesPN, 'NOTAS-PROBE');
  check('piezasCarga', p.piezasCarga, 4321);
  check('tiempoEntrega', p.tiempoEntrega, 15);

  console.log('');
  if (fails.length) {
    console.error(`✗ LAYOUT INCORRECTO — ${fails.length} verificación(es) fallaron: ${fails.join(', ')}`);
    console.error('  El parser leería datos de columnas equivocadas. NO deployes esta plantilla.');
    console.error('\n  Header canónico que produce la plantilla:');
    canon.forEach((h, i) => console.error(`    ${String(i).padStart(2)} | ${h}`));
    process.exit(1);
  }
  console.log(`✓ LAYOUT CORRECTO — la plantilla produce exactamente el CSV canónico ${guess} que el parser espera.`);
}

// Los lectores del .xlsm se exportan para que otros tests puedan medir la plantilla real
// sin duplicar el parseo (p.ej. module5-column-cap, que ata el tope del VBA al ancho de la
// hoja). El CLI sólo corre si el archivo se invoca directamente.
module.exports = { sheetPathFor, sharedStrings, readRow, canonicalHeaders, normHeader };

if (require.main === module) main();
