/**
 * Trinquete del lector de .xlsm (tools/lib/xlsx-read.js).
 *
 * El bug que fija: un regex que exige la etiqueta de cierre SE TRAGA los elementos
 * self-closing y le cuelga al anterior el contenido del siguiente. Mordió DOS veces
 * el mismo día sobre el mismo archivo:
 *
 *   1. Celdas — `<c r="C3" s="109"/>` (celda vacía) hizo que la fila 3 se leyera con
 *      TODAS las columnas corridas: el encabezado del layout salió mal mapeado.
 *   2. Validaciones — `<dataValidation … sqref="E8"/>` (validación vacía) hizo reportar
 *      que la columna B "no tiene desplegable" cuando `B9:B508` sí lo declara, tres
 *      líneas más abajo en el mismo XML.
 *
 * Corregir el patrón en un sitio no lo corrige en los demás. Este test cubre AMBAS rutas
 * con un .xlsx mínimo construido a mano, y de paso ata el layout de la plantilla real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { readSheet } = require('../lib/xlsx-read.js');

const ROOT = path.resolve(__dirname, '../..');

// ── Un .xlsx mínimo, con celdas y validaciones self-closing intercaladas ──────
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxfix-'));
  const w = (p, c) => {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  w('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/></Types>');
  w('_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="x" Target="xl/workbook.xml"/></Relationships>');
  w('xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns:r="x"><sheets>' +
    '<sheet name="Hoja" sheetId="1" r:id="rId1"/></sheets></workbook>');
  w('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  w('xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst><si><t>Alfa</t></si><si><t>Beta</t></si><si><t>Gama</t></si></sst>');
  // A=Alfa, B y C VACÍAS self-closing, D=Beta, E=Gama
  // dataValidation vacía self-closing en Z1, luego la de verdad en B9:B508
  w('xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?><worksheet><sheetData>' +
    '<row r="7">' +
      '<c r="A7" s="1" t="s"><v>0</v></c>' +
      '<c r="B7" s="1"/>' +
      '<c r="C7" s="1"/>' +
      '<c r="D7" s="1" t="s"><v>1</v></c>' +
      '<c r="E7" s="1" t="s"><v>2</v></c>' +
    '</row>' +
    '</sheetData>' +
    '<mergeCells count="1"><mergeCell ref="A6:C6"/></mergeCells>' +
    '<dataValidations count="2">' +
      '<dataValidation allowBlank="1" sqref="Z1" xr:uid="{X}"/>' +
      '<dataValidation type="list" sqref="B9:B508"><formula1>"Uno,Dos"</formula1></dataValidation>' +
    '</dataValidations>' +
    '</worksheet>');
  const out = path.join(dir, 'fixture.xlsx');
  execSync(`cd "${dir}" && zip -q -r fixture.xlsx '[Content_Types].xml' _rels xl`);
  return { file: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('celdas self-closing NO corren las columnas siguientes', () => {
  const { file, cleanup } = buildFixture();
  try {
    const { rows } = readSheet(file, 'Hoja', 9);
    assert.equal(rows[7].A, 'Alfa', 'A7 debe ser Alfa');
    assert.equal(rows[7].B, undefined, 'B7 está vacía: no debe traer valor');
    assert.equal(rows[7].C, undefined, 'C7 está vacía: no debe traer valor');
    // El corrimiento clásico ponía "Beta" en B o C en vez de D.
    assert.equal(rows[7].D, 'Beta', 'D7 debe ser Beta, no correrse a B/C');
    assert.equal(rows[7].E, 'Gama', 'E7 debe ser Gama');
  } finally { cleanup(); }
});

test('una dataValidation self-closing no le roba la lista a la siguiente', () => {
  const { file, cleanup } = buildFixture();
  try {
    const { validations } = readSheet(file, 'Hoja', 9);
    const z1 = validations.find(v => v.ref === 'Z1');
    const b9 = validations.find(v => v.ref === 'B9:B508');
    assert.ok(z1, 'la validación vacía de Z1 debe aparecer');
    assert.equal(z1.list, '', 'Z1 no declara lista: debe quedar vacía');
    assert.ok(b9, 'la validación de B9:B508 debe aparecer');
    assert.match(b9.list, /Uno,Dos/, 'la lista pertenece a B9:B508, no a la self-closing anterior');
  } finally { cleanup(); }
});

test('los merges se leen completos', () => {
  const { file, cleanup } = buildFixture();
  try {
    const { merges } = readSheet(file, 'Hoja', 9);
    assert.ok(merges.includes('A6:C6'), 'debe leer el mergeCell A6:C6');
  } finally { cleanup(); }
});

// ── El layout real: lo que la guía del equipo afirma sobre la plantilla ───────
const XLSM = path.join(ROOT, 'remote/templates/Plantilla_CargaMasiva_v13.xlsm');

test('la plantilla v13 tiene 67 columnas A–BO y 5 pares de rack', { skip: !fs.existsSync(XLSM) }, () => {
  const { rows } = readSheet(XLSM, 'Upload', 9);
  const head = rows[7];
  const cols = Object.keys(head);
  assert.equal(cols.length, 67, 'la hoja Upload debe medir 67 columnas visibles');
  assert.equal(head.BO, 'Tiempo de Entrega', 'la última columna es BO = Tiempo de Entrega');
  assert.equal(head.BH, 'Instrucciones de Empaque', 'BH es la columna nueva de la v13');
  // /^rack\b/ ANCLADO: "Pzas/Rack Línea N" contiene "Rack" pero no empieza con él.
  const racks = cols.filter(c => /^rack\b/i.test(head[c]));
  assert.equal(racks.length, 5, 'deben ser 5 pares de rack, no 10');
});

test('la columna B (forzar duplicado) SÍ declara su desplegable', { skip: !fs.existsSync(XLSM) }, () => {
  const { validations } = readSheet(XLSM, 'Upload', 9);
  const b = validations.find(v => v.ref === 'B9:B508');
  assert.ok(b, 'B9:B508 debe tener validación (el bug de self-closing la escondía)');
  assert.match(b.list, /Forzar duplicado/, 'su lista es la de forzar duplicado');
});

test('los 5 slots de rack comparten la misma lista de tipos', { skip: !fs.existsSync(XLSM) }, () => {
  const { validations } = readSheet(XLSM, 'Upload', 9);
  const v = validations.find(x => /AI9:AI508/.test(x.ref));
  assert.ok(v, 'debe existir la validación de los slots de rack');
  for (const col of ['AI', 'AK', 'AM', 'AO', 'AQ']) {
    assert.match(v.ref, new RegExp(`${col}9:${col}508`), `${col} debe estar en el sqref compartido`);
  }
});
