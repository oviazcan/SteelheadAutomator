// tools/test/module5-column-cap.test.js
// TRINQUETE: el tope de columnas del VBA (`For c = 1 To N`) debe coincidir con el ancho REAL
// de la hoja Upload de la plantilla.
//
// Por qué existe: Module5 (LimpiarDatos/LimpiarEspacios) recorre las columnas por ÍNDICE y
// NO se auto-ajusta cuando alguien inserta columnas en Excel. Si el tope se queda corto, las
// columnas de la derecha NUNCA se limpian: conservan los datos de la carga anterior y se
// vuelven a subir en la siguiente — con la plantilla viéndose limpia. Es una falla silenciosa
// que sólo se descubre en el piso, cuando ya se subieron datos viejos.
//
// Ya pasó: el v18 se escribió para 66 columnas y la plantilla final quedó en 67 (la columna
// "Instrucciones de Empaque" entró después), así que "Tiempo de Entrega" se quedaba sin
// limpiar. Este test convierte ese error humano en un rojo antes del deploy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sheetPathFor, sharedStrings, readRow, normHeader } = require('../verify-template-layout.js');

const ROOT = path.join(__dirname, '..', '..');
const PLANTILLAS = [
  'remote/templates/Plantilla_CargaMasiva_v13.xlsm',
  'remote/templates/Plantilla_CargaMasiva_v13_compatibilidad.xlsm',
];
// El módulo VIGENTE que se pega en Excel. Al liberar un vNN nuevo, actualizar esta ruta en el
// mismo commit — así el test siempre mide el que el operador realmente tiene.
const MODULE5 = 'vbas/Module5_v19.bas';

function anchoVisible(xlsm) {
  const sst = sharedStrings(xlsm);
  const fila = readRow(xlsm, sheetPathFor(xlsm, 'Upload'), 7, sst);
  return fila.filter(h => normHeader(h)).length;
}

function topesDelVba(src) {
  // Sólo CÓDIGO: en VBA el comentario empieza con apóstrofo, y el encabezado de este módulo
  // cita los topes viejos ("For c = 1 To 60" → "1 To 67") para documentar la historia. Contar
  // esas citas haría fallar el test por un texto que no ejecuta nada.
  return src.split(/\r?\n/)
    .filter(l => !/^\s*'/.test(l))
    .flatMap(l => [...l.matchAll(/For\s+c\s*=\s*1\s+To\s+(\d+)/gi)].map(m => Number(m[1])));
}

test('el tope del VBA coincide con el ancho real de la plantilla', () => {
  const vba = fs.readFileSync(path.join(ROOT, MODULE5), 'utf8');
  const topes = topesDelVba(vba);
  assert.ok(topes.length >= 3, `esperaba al menos 3 loops de columnas en ${MODULE5}, hallé ${topes.length}`);

  for (const rel of PLANTILLAS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const ancho = anchoVisible(abs);
    for (const tope of topes) {
      assert.equal(
        tope, ancho,
        `${MODULE5} recorre hasta ${tope} pero ${path.basename(rel)} tiene ${ancho} columnas visibles: ` +
        `las columnas ${tope + 1}..${ancho} nunca se limpiarían (datos de la carga anterior se re-suben).`,
      );
    }
  }
});

test('las dos plantillas v13 tienen el MISMO ancho', () => {
  // La moderna y la de compatibilidad comparten contrato: si divergen, un mismo Module5 no
  // puede servir a las dos y una de las dos quedaría con columnas sin limpiar.
  const anchos = PLANTILLAS
    .map(r => path.join(ROOT, r))
    .filter(fs.existsSync)
    .map(anchoVisible);
  assert.ok(anchos.length >= 1, 'no encontré ninguna plantilla v13');
  assert.equal(new Set(anchos).size, 1, `las plantillas v13 difieren en ancho: ${anchos.join(' vs ')}`);
});

test('los índices de placeholders del VBA caen dentro del rango de columnas', () => {
  // phCols/phHybridCols/boolCols apuntan a columnas por número. Un índice fuera de rango
  // escribiría un placeholder en una columna que no existe o —peor— en la equivocada, como
  // pasó con Tipo de Geometría cuando los racks la empujaron de 39 a 45.
  const vba = fs.readFileSync(path.join(ROOT, MODULE5), 'utf8');
  const ancho = anchoVisible(path.join(ROOT, PLANTILLAS[0]));
  for (const nombre of ['phCols', 'phHybridCols', 'boolCols']) {
    const m = vba.match(new RegExp(`${nombre}\\s*=\\s*Array\\(([^)]*)\\)`));
    assert.ok(m, `no encontré ${nombre} en ${MODULE5}`);
    const idx = m[1].split(',').map(x => Number(x.trim())).filter(n => Number.isFinite(n));
    assert.ok(idx.length, `${nombre} vacío`);
    for (const i of idx) {
      assert.ok(i >= 1 && i <= ancho, `${nombre} apunta a la columna ${i}, fuera del rango 1..${ancho}`);
    }
  }
});

test('Tipo de Geometría sigue siendo la columna híbrida que el VBA cree', () => {
  // El caso concreto que rompió al pasar de v12 a v13: phHybridCols tenía 39 (Geometría en
  // v12) y en v13 el 39 es Rack 3. Se ancla el índice al ENCABEZADO real, no a la memoria.
  const abs = path.join(ROOT, PLANTILLAS[0]);
  const sst = sharedStrings(abs);
  const fila = readRow(abs, sheetPathFor(abs, 'Upload'), 7, sst);
  const idxGeom = fila.findIndex(h => /tipo de geometr/i.test(normHeader(h))) + 1; // 1-based como VBA
  assert.ok(idxGeom > 0, 'no encontré "Tipo de Geometría" en la plantilla');

  const vba = fs.readFileSync(path.join(ROOT, MODULE5), 'utf8');
  const m = vba.match(/phHybridCols\s*=\s*Array\(([^)]*)\)/);
  const idx = m[1].split(',').map(x => Number(x.trim()));
  assert.ok(idx.includes(idxGeom),
    `phHybridCols = (${idx.join(', ')}) pero "Tipo de Geometría" está en la columna ${idxGeom}: ` +
    'el placeholder "(seleccione o escriba)" se escribiría en la columna equivocada.');
});
