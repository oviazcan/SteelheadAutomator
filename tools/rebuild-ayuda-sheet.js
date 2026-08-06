#!/usr/bin/env node
/**
 * Regenera la hoja "Ayuda" DENTRO de un .xlsm de carga masiva.
 *
 * Por qué existe: la hoja Ayuda de las plantillas v13 seguía describiendo el layout
 * **v10** — 69 columnas A–BQ, racks ×2 en AP–AS, "Etiqueta 5". No es un rótulo viejo:
 * es un MAPA DE COLUMNAS EQUIVOCADO dentro del archivo que el operador tiene abierto,
 * así que quien la siguiera capturaba corrido. Se desfasó porque estaba escrita a mano.
 *
 * Aquí el inventario de columnas se LEE de la hoja Upload del propio archivo (fila 6 =
 * bandas de grupo, fila 7 = encabezados, fila 8 = tipos, fila 9 = valores iniciales), así
 * que regenerar tras cambiar el layout la deja correcta sola.
 *
 * Sólo reescribe la entrada del zip de esa hoja: el resto del .xlsm —incluido
 * vbaProject.bin— se queda byte a byte como estaba.
 *
 * Uso:  node tools/rebuild-ayuda-sheet.js <archivo.xlsm> [--dry]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { readSheet } = require('./lib/xlsx-read.js');

const FILE = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!FILE || !fs.existsSync(FILE)) {
  console.error('uso: node tools/rebuild-ayuda-sheet.js <archivo.xlsm> [--dry]');
  process.exit(2);
}

// Estilos que ya viven en la plantilla (medidos de styles.xml):
//   1 = negrita 14pt blanca (título)   3 = negrita 12pt (sección)
//   4 = normal 10pt (contenido)        5 = normal 9pt gris (nota)
const S = { TIT: 1, SEC: 3, TXT: 4, NOTA: 5 };

// ── Leer el layout real de la hoja Upload ──────────────────────────────────
const { rows, merges } = readSheet(FILE, 'Upload', 9);
const BAND = rows[6] || {}, HEAD = rows[7] || {}, TYPE = rows[8] || {}, DEF = rows[9] || {};

const colToNum = c => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const numToCol = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
const range = (a, b) => { const o = []; for (let i = colToNum(a); i <= colToNum(b); i++) o.push(numToCol(i)); return o; };

const COLS = Object.keys(HEAD).sort((a, b) => colToNum(a) - colToNum(b));
const LAST = COLS[COLS.length - 1];

// Banda de grupo por columna, expandiendo los merges de la fila 6
const BAND_OF = {};
for (const ref of merges) {
  const m = ref.match(/^([A-Z]+)6:([A-Z]+)6$/);
  if (!m || !BAND[m[1]]) continue;
  for (const c of range(m[1], m[2])) BAND_OF[c] = BAND[m[1]];
}
for (const [c, t] of Object.entries(BAND)) if (!BAND_OF[c]) BAND_OF[c] = t;

// Versión declarada en el título de la hoja (A2), la misma fuente que usa el VBA
const TITULO = rows[2] && rows[2].A ? rows[2].A : '';
const VER = (TITULO.match(/\bv(\d+)\b/) || [])[1] || '?';

const nRacks = COLS.filter(c => /^rack\b/i.test(HEAD[c] || '')).length;
const oneLine = s => String(s || '').replace(/\s*\n\s*/g, ' ').trim();

// ── Contenido ─────────────────────────────────────────────────────────────
const L = [];
const put = (style, text) => L.push({ style, text });
const blank = () => L.push(null);

put(S.TIT, `STEELHEAD AUTOMATOR — PLANTILLA DE CARGA MASIVA v${VER}`);
blank();
put(S.NOTA, `Referencia rápida generada del propio archivo: ${COLS.length} columnas (A–${LAST}), ${nRacks} pares de rack.`);
put(S.NOTA, 'Guía completa con imágenes: docs/training/guia-plantilla-v13.html del repositorio.');
blank();

put(S.SEC, 'FLUJO COMPLETO');
put(S.TXT, '   1. Bajar la plantilla desde el menú de la extensión (no reusar una copia vieja)');
put(S.TXT, '   2. Actualizar Catálogos (botón de la extensión, estando dentro de Steelhead)');
put(S.TXT, '   3. En Excel: macro RefrescarListas — pide el archivo de catálogos recién bajado');
put(S.TXT, '   4. Llenar el encabezado y los renglones de la hoja Upload (datos desde la fila 9)');
put(S.TXT, '   5. Macro ExportarCSV — valida y guarda el CSV');
put(S.TXT, '   6. En Steelhead: extensión → Carga Masiva → Cargar CSV → revisar → EJECUTAR');
blank();

put(S.SEC, 'MODOS (celda H1)');
put(S.TXT, '   COTIZACIÓN+NP — crea la cotización y los números de parte, con precios y productos');
put(S.TXT, '   SOLO_PN       — crea o modifica números de parte, sin tocar cotizaciones');
put(S.TXT, '   Con varios clientes en COTIZACIÓN+NP se crea UNA cotización por cliente,');
put(S.TXT, '   nombrada "{Cliente} {Layout}". La macro avisa cuántas va a crear y confirmas.');
blank();

put(S.SEC, 'ENCABEZADO DEL LAYOUT (filas 1-4)');
put(S.TXT, '   Modo                       H1   COTIZACIÓN+NP o SOLO_PN');
put(S.TXT, '   Empresa Emisora            B3   ECOPLATING o PROQUIPA');
put(S.TXT, '   Válida Hasta (días)        B4   vigencia; sólo aplica en modo cotización');
put(S.TXT, '   Nombre Cotización/Layout   G3   OBLIGATORIO en modo cotización');
put(S.TXT, '   Asignado                   G4   vendedor; en blanco = asignación automática');
put(S.TXT, '   Notas Externas             J3   las ve el cliente en la cotización');
put(S.TXT, '   Notas Internas             Q3   uso interno');
put(S.NOTA, '   La macro busca cada campo POR SU ETIQUETA, no por la celda: cambia los valores,');
put(S.NOTA, '   no los rótulos. Si renombras una etiqueta, ese campo deja de leerse.');
blank();

put(S.SEC, 'CONVENCIONES');
put(S.TXT, '   Celda vacía   No se toca nada — conserva lo que ya tenga en Steelhead');
put(S.TXT, '   Guión (-)     Borra el dato (se manda vacío)');
put(S.TXT, '   V / F         En columnas de sí/no: V activa, F desactiva');
put(S.TXT, '   Los renglones sin número de parte no se tocan ni se validan.');
put(S.NOTA, '   Vacío y guión NO son lo mismo: en blanco conserva, guión borra. Ante la duda, en blanco.');
blank();

put(S.SEC, 'PLACEHOLDERS DE LOS DESPLEGABLES');
put(S.TXT, '   (seleccione)             campo con lista — elige del listado');
put(S.TXT, '   (seleccione o escriba)   campo híbrido — elige o escribe un valor nuevo');
blank();

put(S.SEC, 'CÓDIGO DE COLORES');
put(S.TXT, '   Verde claro   Editable — lo llenas tú');
put(S.TXT, '   Gris claro    No aplica al modo elegido (lo sombrea SombrearModoSoloPN)');
blank();

put(S.SEC, `COLUMNAS DE DATOS (fila 7 = encabezados · datos desde la fila 9)`);
put(S.NOTA, '   Tipo:  Desp. = lista desplegable · Calc. = se calcula solo · # = número · Texto = libre');
blank();
let banda = null;
for (const c of COLS) {
  const b = BAND_OF[c] || '';
  if (b !== banda) { if (banda !== null) blank(); put(S.TXT, `   ${b.toUpperCase()}`); banda = b; }
  const tipo = (TYPE[c] || '').padEnd(7);
  const ini = DEF[c] ? `  [${DEF[c]}]` : '';
  put(S.NOTA, `      ${c.padEnd(3)} ${oneLine(HEAD[c]).padEnd(30)} ${tipo}${ini}`);
}
blank();

put(S.SEC, 'MACROS');
put(S.TXT, `   ExportarCSV          Exporta la hoja Upload como CSV UTF-8, ordenado por (Cliente, PN)`);
put(S.TXT, '   RefrescarListas      Carga los catálogos del archivo bajado por la extensión');
put(S.TXT, '   LimpiarDatos         Borra los renglones y restaura los valores iniciales (fila 9+)');
put(S.TXT, '   SombrearModoSoloPN   Sombrea las columnas que no aplican al modo elegido');
put(S.NOTA, '   Reusar la plantilla sin LimpiarDatos re-sube datos viejos de columnas que ya no miras,');
put(S.NOTA, '   y no hay ninguna señal: la hoja se ve bien. Limpia antes de cada archivo nuevo.');
blank();

put(S.SEC, 'CATÁLOGOS (hoja Listas)');
put(S.TXT, '   A Clientes · B Procesos · C Productos · D Etiquetas · E Specs · F Racks');
put(S.TXT, '   I Metal base · J Líneas · L Usuarios · M Grupos de partes · N Geometrías');
put(S.NOTA, '   Sin refrescar, los desplegables traen los catálogos del día en que se armó la plantilla.');
blank();

put(S.SEC, 'QUÉ REVISA ExportarCSV ANTES DE ESCRIBIR');
put(S.TXT, '   • Que el modo sea COTIZACIÓN+NP o SOLO_PN');
put(S.TXT, '   • Que haya Nombre Cotización/Layout si es modo cotización');
put(S.TXT, '   • Que ningún renglón con número de parte se quede sin cliente');
put(S.TXT, '   • Avisa (no bloquea) si hay varios clientes, o más de 2,000 renglones en SOLO_PN');
blank();

put(S.SEC, 'SOPORTE');
put(S.TXT, '   oviazcan@capazconsultoria.com · Capaz Consultoría');

// ── Serializar la hoja ────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildSheetXml(prev) {
  const cells = [];
  let r = 0;
  for (const item of L) {
    r++;
    if (!item) continue; // fila en blanco: sin celda
    // inlineStr: no toca sharedStrings.xml, así que no hay índices que reindexar.
    // xml:space="preserve" es obligatorio — la sangría de dos/tres espacios ES el formato.
    cells.push(`<row r="${r}" spans="1:1"><c r="A${r}" s="${item.style}" t="inlineStr">` +
               `<is><t xml:space="preserve">${esc(item.text)}</t></is></c></row>`);
  }
  const sheetData = `<sheetData>${cells.join('')}</sheetData>`;
  let out = prev.replace(/<sheetData>[\s\S]*?<\/sheetData>|<sheetData\/>/, sheetData);
  out = out.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:A${r}"/>`);
  // El panel congelado apuntaba a una fila del contenido viejo; se deja arriba.
  out = out.replace(/topLeftCell="A\d+"/, 'topLeftCell="A1"');
  return out;
}

// ── Reescribir SOLO esa entrada del zip ───────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayuda-'));
try {
  execSync(`unzip -o -q "${path.resolve(FILE)}" -d "${dir}"`);
  const wb = fs.readFileSync(path.join(dir, 'xl/workbook.xml'), 'utf8');
  const rels = fs.readFileSync(path.join(dir, 'xl/_rels/workbook.xml.rels'), 'utf8');
  const relMap = {};
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
  const sh = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)].find(m => m[1] === 'Ayuda');
  if (!sh) throw new Error('la hoja "Ayuda" no existe en ' + FILE);
  const rel = relMap[sh[2]].replace(/^\/xl\//, '');
  const target = path.join('xl', rel);

  const prev = fs.readFileSync(path.join(dir, target), 'utf8');
  const next = buildSheetXml(prev);

  const filas = L.filter(Boolean).length;
  console.log(`${path.basename(FILE)} → ${target}`);
  console.log(`  layout leído: ${COLS.length} columnas (A–${LAST}) · ${nRacks} pares de rack · título "v${VER}"`);
  console.log(`  hoja Ayuda: ${filas} líneas (antes ${(prev.match(/<row /g) || []).length} filas)`);

  if (DRY) { console.log('  (--dry: no se escribió nada)'); process.exit(0); }

  fs.writeFileSync(path.join(dir, target), next);
  // `zip` ACTUALIZA esa entrada dentro del .xlsm y deja el resto intacto,
  // vbaProject.bin incluido. Re-empaquetar todo desde cero sería más riesgoso.
  execSync(`cd "${dir}" && zip -q "${path.resolve(FILE)}" "${target}"`);
  console.log('  ✓ escrito');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
