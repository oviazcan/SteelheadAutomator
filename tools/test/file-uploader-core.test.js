// tools/test/file-uploader-core.test.js
// Golden tests del núcleo puro del Cargador de Archivos.
// Run: node --test tools/test/file-uploader-core.test.js
//
// Decisiones validadas contra el ERP/DuckDB en vivo (sesión 2026-06-25):
//   · Convención de nombre: <PN>__<descriptor>.<ext>  (doble guion bajo).
//     `__` no colisiona con NINGÚN PN (0 / 23,926 en TLC); el espacio (418)
//     y el guion (18,884) sí, por eso NO se usan como separador.
//   · Homónimos: 9,449 nombres duplicados (~40%), peor caso 15 copias.
//     → selectMatchingPNs debe devolver TODOS los exactos, no el primero.
//   · Dedup: contra partNumberUserFilesByPartNumberId.nodes[].userFileByUserFileName.originalName
//     (shape real del PN 3027533). NUNCA contra buckets de nodo/instrucciones.

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/file-uploader-core.js');

// ── extractPNName ───────────────────────────────────────────────────────────
test('extractPNName: quita la extensión cuando no hay sufijo', () => {
  assert.equal(Core.extractPNName('VXC084N528YF53EC.jpg'), 'VXC084N528YF53EC');
});

test('extractPNName: corta en el primer __ (descriptor de foto/plano)', () => {
  assert.equal(Core.extractPNName('VXC084N528YF53EC__front.jpg'), 'VXC084N528YF53EC');
  assert.equal(Core.extractPNName('VXC084N528YF53EC__back.jpg'), 'VXC084N528YF53EC');
});

test('extractPNName: PN con guiones no se rompe (79% de los PNs tienen -)', () => {
  assert.equal(Core.extractPNName('80255-553-01__plano.pdf'), '80255-553-01');
});

test('extractPNName: PN con espacios interiores sobrevive (separador es __)', () => {
  assert.equal(Core.extractPNName('ABC 123__front.jpg'), 'ABC 123');
});

test('extractPNName: corta en el PRIMER __ aunque haya varios', () => {
  assert.equal(Core.extractPNName('ABC__foto__2.jpg'), 'ABC');
});

test('extractPNName: tolera el patrón de copia " (2)" del legacy crudo', () => {
  assert.equal(Core.extractPNName('VXC084N528YF53EC (2).jpg'), 'VXC084N528YF53EC');
});

test('extractPNName: tolera el sufijo " copy" del legacy crudo', () => {
  assert.equal(Core.extractPNName('VXC084N528YF53EC copy.jpg'), 'VXC084N528YF53EC');
});

test('extractPNName: archivo sin extensión devuelve el nombre tal cual', () => {
  assert.equal(Core.extractPNName('ABC123'), 'ABC123');
});

// ── selectMatchingPNs ───────────────────────────────────────────────────────
test('selectMatchingPNs: devuelve TODOS los homónimos exactos, no solo el primero', () => {
  const nodes = [
    { id: 1, name: 'ABC' },
    { id: 2, name: 'abc' },
    { id: 3, name: 'ABCD' },
    { id: 4, name: 'ABC' },
  ];
  const got = Core.selectMatchingPNs(nodes, 'ABC').map((n) => n.id);
  assert.deepEqual(got, [1, 2, 4]);
});

test('selectMatchingPNs: ignora substrings (ABC no matchea ABCD ni XABC)', () => {
  const nodes = [{ id: 1, name: 'ABCD' }, { id: 2, name: 'XABC' }];
  assert.deepEqual(Core.selectMatchingPNs(nodes, 'ABC'), []);
});

test('selectMatchingPNs: case-insensitive + trim', () => {
  const nodes = [{ id: 1, name: '  ABC  ' }];
  assert.deepEqual(Core.selectMatchingPNs(nodes, 'abc').map((n) => n.id), [1]);
});

test('selectMatchingPNs: pnName vacío no matchea nada', () => {
  assert.deepEqual(Core.selectMatchingPNs([{ id: 1, name: '' }], ''), []);
});

// ── existingOriginalNames ───────────────────────────────────────────────────
function pnWithFiles(originalNames) {
  return {
    partNumberUserFilesByPartNumberId: {
      nodes: originalNames.map((on) => ({ userFileByUserFileName: { originalName: on } })),
    },
  };
}

test('existingOriginalNames: extrae los originalName del bucket del PN (shape real)', () => {
  const pn = pnWithFiles(['VXC084N528YF53EC front.jpg', 'VXC084N528YF53EC back.jpg']);
  const set = Core.existingOriginalNames(pn);
  assert.equal(set.size, 2);
  assert.ok(set.has('vxc084n528yf53ec front.jpg')); // normalizado para dedup
});

test('existingOriginalNames: PN sin archivos devuelve set vacío', () => {
  assert.equal(Core.existingOriginalNames(pnWithFiles([])).size, 0);
  assert.equal(Core.existingOriginalNames({}).size, 0);
});

test('existingOriginalNames: NUNCA incluye archivos de nodo/instrucciones', () => {
  const pn = pnWithFiles(['foto.jpg']);
  // bucket de nodo (instrucciones) que NO debe contaminar la dedup del PN
  pn.partNumberRackTypesByPartNumberId = {
    nodes: [{ rackTypeByRackTypeId: { rackTypeUserFilesByRackTypeId: { nodes: [
      { userFileByUserFileName: { originalName: 'instruccion-nodo.pdf' } },
    ] } } }],
  };
  const set = Core.existingOriginalNames(pn);
  assert.equal(set.size, 1);
  assert.ok(set.has('foto.jpg'));
  assert.ok(!set.has('instruccion-nodo.pdf'));
});

// ── isTransientError (retry de 502/rate-limit) ──────────────────────────────
test('isTransientError: 502/503/504/429 son transitorios (reintentar)', () => {
  assert.equal(Core.isTransientError('HTTP 502 en SearchPartNumbers: <!DOCTYPE html>'), true);
  assert.equal(Core.isTransientError('Upload HTTP 502'), true);
  assert.equal(Core.isTransientError('HTTP 503'), true);
  assert.equal(Core.isTransientError('HTTP 504'), true);
  assert.equal(Core.isTransientError('HTTP 429 Too Many Requests'), true);
});

test('isTransientError: errores de red son transitorios', () => {
  assert.equal(Core.isTransientError('Failed to fetch'), true);
  assert.equal(Core.isTransientError('NetworkError when attempting to fetch resource'), true);
});

test('isTransientError: AbortError por corte de red se reintenta', () => {
  assert.equal(Core.isTransientError('AbortError: The user aborted a request.'), true);
  assert.equal(Core.isTransientError('The operation was aborted'), true);
});

test('isTransientError: 4xx de lógica NO se reintentan', () => {
  assert.equal(Core.isTransientError('HTTP 404 not found'), false);
  assert.equal(Core.isTransientError('Upload HTTP 400'), false);
  assert.equal(Core.isTransientError('PN inexistente'), false);
  assert.equal(Core.isTransientError(''), false);
  assert.equal(Core.isTransientError(null), false);
});

// ── isAlreadyLinked ─────────────────────────────────────────────────────────
test('isAlreadyLinked: detecta un archivo ya vinculado por nombre', () => {
  const set = Core.existingOriginalNames(pnWithFiles(['VXC084N528YF53EC front.jpg']));
  assert.equal(Core.isAlreadyLinked(set, 'VXC084N528YF53EC front.jpg'), true);
});

test('isAlreadyLinked: case-insensitive + trim (no re-sube ni encima)', () => {
  const set = Core.existingOriginalNames(pnWithFiles(['VXC084N528YF53EC front.jpg']));
  assert.equal(Core.isAlreadyLinked(set, '  vxc084n528yf53ec FRONT.jpg '), true);
});

test('isAlreadyLinked: un archivo nuevo no se reporta como duplicado', () => {
  const set = Core.existingOriginalNames(pnWithFiles(['VXC084N528YF53EC front.jpg']));
  assert.equal(Core.isAlreadyLinked(set, 'VXC084N528YF53EC side.jpg'), false);
});

// ── isImageFile (solo imágenes pueden ser display image, NO planos PDF) ───────
test('isImageFile: extensiones de imagen reconocidas (case-insensitive)', () => {
  for (const n of ['a.jpg', 'a.jpeg', 'A.JPG', 'a.png', 'a.webp', 'a.gif', 'a.heic', 'a.heif', 'a.bmp', 'a.tif', 'a.tiff']) {
    assert.equal(Core.isImageFile(n), true, n);
  }
});

test('isImageFile: PDF/planos y no-imágenes NO son imagen', () => {
  for (const n of ['a.pdf', 'a.dwg', 'a.xlsx', 'a.txt', 'sinext', '', null]) {
    assert.equal(Core.isImageFile(n), false, String(n));
  }
});

// ── isPrincipalDescriptor (gancho Cowork: <PN>__PRINCIPAL/DI/FOTO/...) ────────
test('isPrincipalDescriptor: tokens de principal matchean (FOTO/DI/PRINCIPAL y variantes)', () => {
  for (const n of [
    'ABC__PRINCIPAL.jpg', 'ABC__principal.jpg', 'ABC__DI.jpg', 'ABC__di.png',
    'ABC__FOTO.jpg', 'ABC__foto.jpg', 'ABC__photo.jpg', 'ABC__main.jpg',
    'ABC__PORTADA.jpg', 'ABC__display.jpg', 'ABC__cover.jpg', 'ABC__ppal.jpg',
  ]) {
    assert.equal(Core.isPrincipalDescriptor(n), true, n);
  }
});

test('isPrincipalDescriptor: token con frontera (foto1/di2/portada-1 sí; difuminado/diagram no)', () => {
  assert.equal(Core.isPrincipalDescriptor('ABC__foto1.jpg'), true);
  assert.equal(Core.isPrincipalDescriptor('ABC__di2.jpg'), true);
  assert.equal(Core.isPrincipalDescriptor('ABC__portada-1.jpg'), true);
  // "difuminado" empieza con "di" pero la siguiente es letra → NO es principal
  assert.equal(Core.isPrincipalDescriptor('ABC__difuminado.jpg'), false);
  assert.equal(Core.isPrincipalDescriptor('ABC__diagram.jpg'), false);
  assert.equal(Core.isPrincipalDescriptor('ABC__fotografo.jpg'), false);
});

test('isPrincipalDescriptor: descriptores normales (front/back/plano) NO son principal', () => {
  for (const n of ['ABC__front.jpg', 'ABC__back.jpg', 'ABC__plano.pdf', 'ABC__side.jpg']) {
    assert.equal(Core.isPrincipalDescriptor(n), false, n);
  }
});

test('isPrincipalDescriptor: sin descriptor __ no es principal', () => {
  assert.equal(Core.isPrincipalDescriptor('ABC.jpg'), false);
  assert.equal(Core.isPrincipalDescriptor('ABCprincipal.jpg'), false);
});

// ── selectDisplayImage (cuál foto se marca como portada del PN) ───────────────
const f = (name, size) => ({ name, size });

test('selectDisplayImage: una sola foto → esa (caso trivial pedido por el usuario)', () => {
  assert.equal(Core.selectDisplayImage([f('ABC__front.jpg', 1000)]).name, 'ABC__front.jpg');
});

test('selectDisplayImage: varias imágenes sin descriptor → la de más bytes', () => {
  const got = Core.selectDisplayImage([f('ABC__a.jpg', 100), f('ABC__b.jpg', 999), f('ABC__c.jpg', 500)]);
  assert.equal(got.name, 'ABC__b.jpg');
});

test('selectDisplayImage: imagen + PDF → la imagen (el PDF se ignora aunque pese más)', () => {
  const got = Core.selectDisplayImage([f('ABC__plano.pdf', 9999), f('ABC__front.jpg', 100)]);
  assert.equal(got.name, 'ABC__front.jpg');
});

test('selectDisplayImage: solo PDFs/planos → null (no se marca display)', () => {
  assert.equal(Core.selectDisplayImage([f('ABC__plano.pdf', 9999), f('ABC__corte.pdf', 1)]), null);
});

test('selectDisplayImage: descriptor de principal gana aunque no sea la más grande', () => {
  const got = Core.selectDisplayImage([f('ABC__back.jpg', 9999), f('ABC__PRINCIPAL.jpg', 10)]);
  assert.equal(got.name, 'ABC__PRINCIPAL.jpg');
});

test('selectDisplayImage: varios descriptores de principal → la más grande de las marcadas', () => {
  const got = Core.selectDisplayImage([
    f('ABC__foto1.jpg', 200), f('ABC__foto2.jpg', 800), f('ABC__back.jpg', 9999),
  ]);
  assert.equal(got.name, 'ABC__foto2.jpg');
});

test('selectDisplayImage: desempate determinista por nombre cuando empatan bytes', () => {
  const got = Core.selectDisplayImage([f('ABC__zeta.jpg', 500), f('ABC__alfa.jpg', 500)]);
  assert.equal(got.name, 'ABC__alfa.jpg');
});

test('selectDisplayImage: lista vacía o sin imágenes → null', () => {
  assert.equal(Core.selectDisplayImage([]), null);
  assert.equal(Core.selectDisplayImage(null), null);
});

// ── readDisplayState (displayImageId actual + mapa originalName→vínculo.id) ────
function pnWithDisplay(displayImageId, files) {
  // files: [{originalName, id}]
  return {
    displayImageId,
    partNumberUserFilesByPartNumberId: {
      nodes: files.map((x) => ({ id: x.id, userFileByUserFileName: { originalName: x.originalName } })),
    },
  };
}

test('readDisplayState: extrae displayImageId actual', () => {
  const st = Core.readDisplayState(pnWithDisplay(964376, [{ originalName: 'a.jpg', id: 1 }]));
  assert.equal(st.displayImageId, 964376);
});

test('readDisplayState: displayImageId null/ausente cuando el PN no tiene portada', () => {
  assert.equal(Core.readDisplayState(pnWithDisplay(null, [])).displayImageId, null);
  assert.equal(Core.readDisplayState({}).displayImageId, null);
});

test('readDisplayState: mapea originalName(normalizado) → partNumberUserFile.id', () => {
  const st = Core.readDisplayState(pnWithDisplay(null, [
    { originalName: 'ABC__Front.JPG', id: 11 }, { originalName: 'ABC__back.jpg', id: 22 },
  ]));
  assert.equal(st.fileIdByName.get('abc__front.jpg'), 11);
  assert.equal(st.fileIdByName.get('abc__back.jpg'), 22);
});

test('readDisplayState: bucket de nodo/instrucciones NUNCA aporta ids al mapa', () => {
  const pn = pnWithDisplay(null, [{ originalName: 'foto.jpg', id: 5 }]);
  pn.partNumberRackTypesByPartNumberId = {
    nodes: [{ rackTypeByRackTypeId: { rackTypeUserFilesByRackTypeId: { nodes: [
      { id: 999, userFileByUserFileName: { originalName: 'instruccion-nodo.pdf' } },
    ] } } }],
  };
  const st = Core.readDisplayState(pn);
  assert.equal(st.fileIdByName.size, 1);
  assert.equal(st.fileIdByName.get('foto.jpg'), 5);
  assert.equal(st.fileIdByName.has('instruccion-nodo.pdf'), false);
});

// ── parseBackfillCsv (BACKFILL: ingiere el CSV de Cowork PN→displayImage) ─────
// Columnas reales (Cowork): PN, displayImage, tipo, fuente. La principal ya viene
// decidida en displayImage → el backfill solo la aplica (no re-elige heurística).
test('parseBackfillCsv: parsea filas por header (PN, displayImage, tipo, fuente)', () => {
  const csv = 'PN,displayImage,tipo,fuente\n000851,000851.jpg,unico,heuristica\n003397005,003397005__1.jpg,foto,heuristica';
  const rows = Core.parseBackfillCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pn: '000851', displayImage: '000851.jpg', tipo: 'unico', fuente: 'heuristica' });
  assert.equal(rows[1].pn, '003397005');
  assert.equal(rows[1].displayImage, '003397005__1.jpg');
});

test('parseBackfillCsv: mapea por NOMBRE de columna (robusto a reordenar)', () => {
  const csv = 'displayImage,fuente,PN\nx.jpg,heuristica,ABC';
  const rows = Core.parseBackfillCsv(csv);
  assert.equal(rows[0].pn, 'ABC');
  assert.equal(rows[0].displayImage, 'x.jpg');
  assert.equal(rows[0].fuente, 'heuristica');
});

test('parseBackfillCsv: ignora líneas vacías y BOM al inicio', () => {
  const csv = '﻿PN,displayImage,tipo,fuente\n\n000851,000851.jpg,unico,heuristica\n\n';
  const rows = Core.parseBackfillCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pn, '000851');
});

test('parseBackfillCsv: respeta comillas con coma interna y espacios en el nombre', () => {
  const csv = 'PN,displayImage,tipo,fuente\n"ABC,X","003397105__BRIGHT DIP.jpg",unico,heuristica';
  const rows = Core.parseBackfillCsv(csv);
  assert.equal(rows[0].pn, 'ABC,X');
  assert.equal(rows[0].displayImage, '003397105__BRIGHT DIP.jpg');
});

test('parseBackfillCsv: preserva el valor tal cual (no toca mayúsculas de .JPG)', () => {
  const rows = Core.parseBackfillCsv('PN,displayImage\n003397015,003397015__2.JPG');
  assert.equal(rows[0].displayImage, '003397015__2.JPG');
});

test('parseBackfillCsv: sin header reconocible → arroja (evita comerse datos)', () => {
  assert.throws(() => Core.parseBackfillCsv('a,b,c\n1,2,3'), /encabezado|header|PN|displayImage/i);
});

test('parseBackfillCsv: vacío → []', () => {
  assert.deepEqual(Core.parseBackfillCsv(''), []);
  assert.deepEqual(Core.parseBackfillCsv('   '), []);
});
