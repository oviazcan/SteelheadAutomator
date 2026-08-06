// tools/test/driver-licenses-core.test.js
// Golden tests del núcleo puro de Licencias de Choferes.
// Run: node --test tools/test/driver-licenses-core.test.js
//
// Datos medidos contra TLC productivo el 2026-08-05 (carpeta «Licencias», folderId 695 —
// que el applet NUNCA hardcodea: filtra por NOMBRE de carpeta, porque en MTY el id es otro).
//
// El contrato que estos tests protegen:
//   · La llave que produce `keyFromOriginalName` tiene que ser EXACTAMENTE la que el hook
//     `pdf:SHIPMENT_TEMPLATE` busca en las notas del embarque (espejo de
//     SteelheadPowerTools/lib/driver_license_match.mjs). Si divergen, la licencia deja de
//     imprimirse y nadie se entera.
//   · El bloque generado sale BYTE-IDÉNTICO en `code` (TS) y `compiled` (JS) — por eso el
//     applet puede publicar sin compilar TypeScript en el navegador. Formato canónico de tsc:
//     4 espacios, un espacio tras los dos puntos, comillas dobles, orden alfabético.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../remote/scripts/driver-licenses-core.js');

// Nodos tal como los devuelve SearchUserFilesQuery (más recientes primero).
const FILES = [
  { originalName: 'Renan.png', name: '1785961702918-2820464.png' },
  { originalName: 'Raul.png', name: '1785961700366-908610012.png' },
  { originalName: 'Rafael.png', name: '1785961699099-116353838.png' },
  { originalName: 'Miguel.png', name: '1785961693039-384224930.png' },
  { originalName: 'Leonardo.png', name: '1785961690548-307986330.png' },
  { originalName: 'Jesus.png', name: '1785961688293-59235230.png' },
  { originalName: 'Hugo.png', name: '1785961686899-166175190.png' },
  { originalName: 'Hector.png', name: '1785961684774-295104609.png' }
];

// ── Normalización: es un CONTRATO con el hook, no un detalle interno ─────────

test('keyFromOriginalName quita la extensión ANTES de normalizar', () => {
  // Si se normalizara primero, el punto se volvería separador y daría "hector-png".
  assert.equal(C.keyFromOriginalName('Hector.png'), 'hector');
  assert.equal(C.keyFromOriginalName('Héctor.PNG'), 'hector');
  assert.equal(C.keyFromOriginalName('Miguel Ángel.jpeg'), 'miguel-angel');
});

test('la llave coincide con lo que el hook busca en las notas', () => {
  // El hook normaliza `notes` con la misma tabla de diacríticos: "Héctor Proquipa" tokeniza a
  // ["hector","proquipa"] y encuentra la llave "hector".
  assert.equal(C.keyFromOriginalName('Hector.png'), C.slugifyKey('Héctor'));
  assert.equal(C.keyFromOriginalName('Jesus.png'), C.slugifyKey('JESÚS'));
});

test('normalizeText: acentos, mayúsculas y puntuación', () => {
  assert.equal(C.normalizeText('Héctor  Proquipa/2'), 'hector proquipa 2');
  assert.equal(C.normalizeText('Muñoz'), 'munoz');
  assert.equal(C.normalizeText(null), '');
});

// ── Prefijo: sustituye a la carpeta como criterio de pertenencia ────────────
// `CreateUserFile` sólo acepta name/originalName y no hay mutation de carpeta disponible,
// así que el applet no puede dejar el archivo dentro de «Licencias» por sí solo.

test('con y sin prefijo producen LA MISMA llave', () => {
  // Las 8 ya subidas van sin prefijo; las que suba el applet, con él. Ambas deben resolver
  // igual o el hook dejaría de encontrarlas.
  assert.equal(C.keyFromOriginalName('licencia-fernando.png'), 'fernando');
  assert.equal(C.keyFromOriginalName('Fernando.png'), 'fernando');
  assert.equal(C.keyFromOriginalName('Licencia-Héctor.JPG'), 'hector');
  assert.equal(C.keyFromOriginalName('licencia_hugo.png'), 'hugo');
});

test('el prefijo NO se come un nombre que empiece parecido', () => {
  // "Licenciado" no es el prefijo; sólo cuenta con separador después de "licencia".
  assert.equal(C.keyFromOriginalName('Licenciado.png'), 'licenciado');
});

test('buildUploadName conserva la extensión de origen', () => {
  assert.equal(C.buildUploadName('Fernando', 'IMG_4821.jpg'), 'licencia-fernando.jpg');
  assert.equal(C.buildUploadName('Miguel Ángel', 'foto.JPEG'), 'licencia-miguel-angel.jpeg');
  assert.equal(C.buildUploadName('Raul', 'sin-extension'), 'licencia-raul.png');
});

test('isLicenseFile acepta por prefijo O por nombre de carpeta', () => {
  const folder = { fileFolderByFolderId: { id: 695, name: 'Licencias' }, originalName: 'Hector.png' };
  const prefijo = { originalName: 'licencia-fernando.png' };
  const ajeno = { fileFolderByFolderId: { id: 12, name: 'Facturas' }, originalName: 'CXC123.pdf' };
  assert.equal(C.isLicenseFile(folder, 'Licencias'), true);
  assert.equal(C.isLicenseFile(prefijo, 'Licencias'), true);
  assert.equal(C.isLicenseFile(prefijo, null), true);   // sin carpeta, el prefijo basta
  assert.equal(C.isLicenseFile(ajeno, 'Licencias'), false);
});

test('ANTI-REGRESIÓN MTY: la carpeta se reconoce por NOMBRE, no por folderId', () => {
  // En TLC «Licencias» es 695; en MTY es otro número. Filtrar por id rompería la paridad.
  const mty = { fileFolderByFolderId: { id: 9999, name: 'Licencias' }, originalName: 'Hugo.png' };
  assert.equal(C.isLicenseFile(mty, 'Licencias'), true);
  const otraCarpeta = { fileFolderByFolderId: { id: 695, name: 'Otra Cosa' }, originalName: 'Hugo.png' };
  assert.equal(C.isLicenseFile(otraCarpeta, 'Licencias'), false);
});

test('selectLicenseFiles descarta lo que no es licencia', () => {
  const nodes = [
    { originalName: 'licencia-fernando.png' },
    { originalName: 'WhatsApp Image.jpeg' },
    { fileFolderByFolderId: { name: 'Licencias' }, originalName: 'Hector.png' }
  ];
  assert.deepEqual(C.selectLicenseFiles(nodes, 'Licencias').map(n => n.originalName),
                   ['licencia-fernando.png', 'Hector.png']);
});

// ── buildCatalog ────────────────────────────────────────────────────────────

test('buildCatalog arma las 8 entradas medidas en TLC', () => {
  const { catalog, warnings } = C.buildCatalog(FILES);
  assert.equal(Object.keys(catalog).length, 8);
  assert.equal(catalog.hector, '1785961684774-295104609.png');
  assert.deepEqual(warnings, []);
});

test('llave repetida: gana la MÁS RECIENTE y se avisa', () => {
  // No existe «reemplazar» en Steelhead: re-subir crea un `<name>` nuevo y el viejo sigue vivo.
  const dup = [
    { originalName: 'Hector.png', name: 'NUEVO.png' },
    { originalName: 'Héctor.png', name: 'VIEJO.png' }
  ];
  const { catalog, warnings } = C.buildCatalog(dup);
  assert.equal(catalog.hector, 'NUEVO.png');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /repetido/i);
});

test('buildCatalog descarta lo inservible sin tronar', () => {
  const { catalog, warnings } = C.buildCatalog([
    { originalName: '.png', name: 'x.png' },
    { originalName: 'Sofia.png', name: '' },
    null
  ]);
  assert.deepEqual(catalog, {});
  assert.equal(warnings.length, 3);
});

// ── El bloque: byte-identidad entre code y compiled ─────────────────────────

test('renderBlock usa el formato canónico de tsc', () => {
  const block = C.renderBlock({ hector: 'a.png', jesus: 'b.png' }, 'Licencias');
  const lines = block.split('\n');
  assert.ok(lines[0].startsWith(C.MARK_START));
  assert.equal(lines[1], 'const DRIVER_LICENSES = {');
  assert.equal(lines[2], '    "hector": "a.png",');   // 4 espacios, un espacio tras ':'
  assert.equal(lines[3], '    "jesus": "b.png"');     // sin coma en la última
  assert.equal(lines[4], '};');
  assert.equal(lines[5], C.MARK_END);
});

test('renderBlock ordena alfabéticamente — el diff debe ser estable', () => {
  const a = C.renderBlock({ zulema: 'z.png', hector: 'h.png' }, 'Licencias');
  const b = C.renderBlock({ hector: 'h.png', zulema: 'z.png' }, 'Licencias');
  assert.equal(a, b);
});

test('el bloque queda IDÉNTICO en code y compiled tras sustituir', () => {
  // Es la razón de que el bloque viva en el NIVEL RAÍZ del .ts: ahí tsc no lo reindenta.
  const ts = 'const X = 1;\n' + C.renderBlock({ a: '1.png' }, 'Licencias') + '\nconst Y = 2;\n';
  const js = '"use strict";\n' + C.renderBlock({ a: '1.png' }, 'Licencias') + '\nconst Y = 2;\n';
  const block = C.renderBlock({ hector: 'nuevo.png' }, 'Licencias');
  const ts2 = C.replaceBlock(ts, block);
  const js2 = C.replaceBlock(js, block);
  assert.ok(C.blocksMatch(ts2, js2));
});

test('blocksMatch detecta la desalineación entre code y compiled', () => {
  const ts = C.replaceBlock(C.renderBlock({ a: '1.png' }, 'L'), C.renderBlock({ a: '2.png' }, 'L'));
  const js = C.renderBlock({ a: '9.png' }, 'L');
  assert.equal(C.blocksMatch(ts, js), false);
});

// ── Abortar en vez de publicar basura ───────────────────────────────────────

test('sin marcadores: ABORTA, no publica', () => {
  assert.throws(() => C.replaceBlock('const a = 1;', 'X'), /editado a mano/);
});

test('marcadores duplicados: ABORTA, no publica', () => {
  const dup = C.renderBlock({ a: '1.png' }, 'L') + '\n' + C.renderBlock({ b: '2.png' }, 'L');
  assert.throws(() => C.replaceBlock(dup, 'X'), /2 veces/);
});

test('findBlocks cuenta las ocurrencias reales', () => {
  assert.equal(C.findBlocks('nada').length, 0);
  assert.equal(C.findBlocks(C.renderBlock({ a: '1.png' }, 'L')).length, 1);
});

// ── parseBlockCatalog / diffCatalogs ────────────────────────────────────────

test('parseBlockCatalog hace round-trip con renderBlock', () => {
  const { catalog } = C.buildCatalog(FILES);
  const parsed = C.parseBlockCatalog('x\n' + C.renderBlock(catalog, 'Licencias') + '\ny');
  assert.deepEqual(parsed, catalog);
});

test('parseBlockCatalog devuelve null si el bloque no está sano', () => {
  assert.equal(C.parseBlockCatalog('sin marcadores'), null);
});

test('diffCatalogs habla en lenguaje de negocio', () => {
  const d = C.diffCatalogs(
    { hector: 'viejo.png', raul: 'r.png' },
    { hector: 'nuevo.png', fernando: 'f.png' }
  );
  assert.deepEqual(d.added, ['fernando']);
  assert.deepEqual(d.removed, ['raul']);
  assert.deepEqual(d.changed, [{ key: 'hector', from: 'viejo.png', to: 'nuevo.png' }]);
  assert.equal(d.isEmpty, false);
});

test('diffCatalogs vacío cuando no hay nada que publicar', () => {
  const { catalog } = C.buildCatalog(FILES);
  assert.equal(C.diffCatalogs(catalog, catalog).isEmpty, true);
});

// ── validateDriverName ──────────────────────────────────────────────────────

test('colisión: NO sobrescribe en silencio, pide otro nombre', () => {
  const { catalog } = C.buildCatalog(FILES);
  const r = C.validateDriverName('Héctor', catalog, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'collision');
  assert.match(r.message, /inicial del apellido/);
});

test('colisión aceptada explícitamente = reemplazo', () => {
  const { catalog } = C.buildCatalog(FILES);
  const r = C.validateDriverName('Héctor', catalog, { allowReplace: true });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'replace');
});

test('nombre nuevo pasa; vacío y demasiado corto no', () => {
  const { catalog } = C.buildCatalog(FILES);
  assert.equal(C.validateDriverName('Fernando', catalog, {}).ok, true);
  assert.equal(C.validateDriverName('   ', catalog, {}).reason, 'empty');
  // Un nombre de 2 letras chocaría con palabras sueltas de las notas.
  assert.equal(C.validateDriverName('Al', catalog, {}).reason, 'too-short');
});

// ── buildInventory ──────────────────────────────────────────────────────────

test('buildInventory cruza la carpeta contra lo publicado', () => {
  const published = {
    hector: '1785961684774-295104609.png',   // al día
    jesus: 'VIEJO.png',                      // desactualizado
    fernando: 'f.png'                        // ya no está en la carpeta
  };
  const inv = C.buildInventory(FILES, published);
  const by = {};
  inv.rows.forEach(r => { by[r.key] = r; });
  assert.equal(by.hector.status, 'publicado');
  assert.equal(by.jesus.status, 'desactualizado');
  assert.equal(by.hugo.status, 'sin-publicar');
  assert.deepEqual(inv.orphans.map(o => o.key), ['fernando']);
});

test('buildInventory sin catálogo publicado: todo sale sin-publicar', () => {
  const inv = C.buildInventory(FILES, {});
  assert.equal(inv.rows.length, 8);
  assert.ok(inv.rows.every(r => r.status === 'sin-publicar'));
  assert.deepEqual(inv.orphans, []);
});

// ── buildLicenseUrl / isImageFile ───────────────────────────────────────────

test('buildLicenseUrl arma la liga perenne', () => {
  assert.equal(
    C.buildLicenseUrl('1785961684774-295104609.png', 'https://app.gosteelhead.com'),
    'https://app.gosteelhead.com/api/files/1785961684774-295104609.png'
  );
  assert.equal(C.buildLicenseUrl('', 'https://x'), '');
});

test('isImageFile acepta imágenes y rechaza PDF', () => {
  assert.equal(C.isImageFile('Hector.png'), true);
  assert.equal(C.isImageFile('Hector.jpeg'), true);
  assert.equal(C.isImageFile('licencia.pdf'), false);
});

// ── pickActiveHook: leer la respuesta de PdfLowCode ─────────────────────────
//
// BUG 2026-08-06 (reportado en producción): el panel abría con
//   «HTTP 400 en PdfLowCode: Variable "$first" of required type "Int!" was not provided.»
//
// `PdfLowCode` NO es un fetch por pdfType: es un LISTADO PAGINADO de todas las VERSIONES
// del hook. Contrato tomado de la implementación de referencia que sí funciona,
// SteelheadPowerTools/sync/lowcode_sync.py::_fetch_single_slot:
//   · variables → { first, offset, pdfType }   ($first y $offset son Int! obligatorios)
//   · respuesta → { allPdfLowCodes: { nodes: [...] } }
//   · LA VERSIÓN ACTIVA ES LA MÁS RECIENTE POR createdAt — no existe mutation de «activar».
//
// El tercer punto es el peligroso: no da error, da la versión equivocada. Y este applet
// PUBLICA CÓDIGO PRODUCTIVO, así que leer una vieja significa republicarla encima de la buena.

const HOOK_NODES = [
  { id: 3, code: 'const A = 1;', compiled: 'var A = 1;', createdAt: '2026-08-01T10:00:00Z' },
  { id: 7, code: 'const C = 3;', compiled: 'var C = 3;', createdAt: '2026-08-05T22:14:00Z' },
  { id: 5, code: 'const B = 2;', compiled: 'var B = 2;', createdAt: '2026-08-03T09:00:00Z' }
];

test('pickActiveHook lee la key real allPdfLowCodes', () => {
  const got = C.pickActiveHook({ allPdfLowCodes: { nodes: HOOK_NODES } });
  assert.ok(got, 'debe encontrar el hook en allPdfLowCodes');
  assert.equal(typeof got.code, 'string');
});

test('pickActiveHook toma la MÁS RECIENTE por createdAt, no la primera del arreglo', () => {
  // El servidor devuelve desordenado a propósito en este fixture: la activa es la id 7.
  const got = C.pickActiveHook({ allPdfLowCodes: { nodes: HOOK_NODES } });
  assert.equal(got.code, 'const C = 3;');
  assert.equal(got.compiled, 'var C = 3;');
});

test('pickActiveHook aguanta cualquier all*LowCodes (el slot cambia de nombre por categoría)', () => {
  const got = C.pickActiveHook({ allShipmentLowCodes: { nodes: HOOK_NODES } });
  assert.equal(got.code, 'const C = 3;');
});

test('pickActiveHook devuelve null si no hay nada — AUSENTE no se disfraza de vacío', () => {
  assert.equal(C.pickActiveHook({ allPdfLowCodes: { nodes: [] } }), null);
  assert.equal(C.pickActiveHook({}), null);
  assert.equal(C.pickActiveHook(null), null);
  assert.equal(C.pickActiveHook({ allPdfLowCodes: null }), null);
});

test('pickActiveHook: compiled ausente degrada a cadena vacía, no a undefined', () => {
  const got = C.pickActiveHook({ allPdfLowCodes: { nodes: [
    { code: 'x', createdAt: '2026-08-05T00:00:00Z' }
  ] } });
  assert.equal(got.compiled, '');
});

test('pickActiveHook ignora nodos sin code (no son una versión utilizable)', () => {
  const got = C.pickActiveHook({ allPdfLowCodes: { nodes: [
    { id: 9, compiled: 'var Z;', createdAt: '2026-08-09T00:00:00Z' },   // más reciente pero sin code
    { id: 7, code: 'const C = 3;', compiled: 'var C = 3;', createdAt: '2026-08-05T22:14:00Z' }
  ] } });
  assert.equal(got.code, 'const C = 3;');
});

test('hookQueryVariables incluye $first y $offset — el 400 que rompió producción', () => {
  const v = C.hookQueryVariables('SHIPMENT_TEMPLATE');
  assert.equal(typeof v.first, 'number');
  assert.equal(typeof v.offset, 'number');
  assert.equal(v.pdfType, 'SHIPMENT_TEMPLATE');
});
