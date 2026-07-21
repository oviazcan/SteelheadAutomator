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

// ── extractPNName: convención de guion SIMPLE <PN>_<VISTA>_<num> (Cowork) ─────
// Códigos de vista en whitelist (config.fileUploader.viewCodes). Caso real que
// disparó esto: NAT1219802_LIZ_02.JPG / MFR8991502_SUP_01.JPG → "PN no encontrado"
// porque el applet tomaba el nombre completo como PN (usaba solo "__" doble).
// Glosario oficial (Instructivo de Fotografía de Piezas, §5): códigos fijos de 3 letras.
const VC = ['FRO', 'POS', 'LIZ', 'LDE', 'SUP', 'INF', 'ISO'];

test('extractPNName: quita _<VISTA>_<num> cuando la vista está registrada (caso Collado)', () => {
  assert.equal(Core.extractPNName('NAT1219802_LIZ_02.JPG', VC), 'NAT1219802');
  assert.equal(Core.extractPNName('NAT1219802_SUP_01.JPG', VC), 'NAT1219802');
  assert.equal(Core.extractPNName('MFR8991502_LDE_02.JPG', VC), 'MFR8991502');
});

test('extractPNName: el código de vista es case-insensitive', () => {
  assert.equal(Core.extractPNName('NAT1219802_liz_02.jpg', VC), 'NAT1219802');
});

test('extractPNName: acepta viewCodes como string "LIZ, LDE, SUP"', () => {
  assert.equal(Core.extractPNName('NAT1219802_SUP_01.JPG', 'LIZ, LDE, SUP'), 'NAT1219802');
});

test('extractPNName: SIN viewCodes = comportamiento viejo (nombre completo, sin partir por _ simple)', () => {
  assert.equal(Core.extractPNName('NAT1219802_LIZ_02.JPG'), 'NAT1219802_LIZ_02');
});

test('extractPNName: código de vista NO registrado NO se quita (fail-safe, no mislink)', () => {
  assert.equal(Core.extractPNName('NAT1219802_XYZ_02.jpg', VC), 'NAT1219802_XYZ_02');
});

test('extractPNName: NP con "_" interno sobrevive (protege los 57/23,926 con guion bajo)', () => {
  assert.equal(Core.extractPNName('ABC_12_LIZ_03.jpg', VC), 'ABC_12');
  // sin vista al final: el "_12" NO es <VISTA>_<num> → el NP queda íntegro
  assert.equal(Core.extractPNName('ABC_12.jpg', VC), 'ABC_12');
});

test('extractPNName: el "__" doble sigue teniendo prioridad aunque haya viewCodes', () => {
  assert.equal(Core.extractPNName('VXC084N528YF53EC__front.jpg', VC), 'VXC084N528YF53EC');
  assert.equal(Core.extractPNName('80255-553-01__plano.pdf', VC), '80255-553-01');
});

// ── unregisteredViewCode: pista para el reporte de "no encontrados" ──────────
test('unregisteredViewCode: reporta el código NO registrado que parece vista', () => {
  assert.equal(Core.unregisteredViewCode('NAT1219802_XYZ_02.jpg', VC), 'XYZ');
});

test('unregisteredViewCode: null si la vista SÍ está registrada', () => {
  assert.equal(Core.unregisteredViewCode('NAT1219802_LIZ_02.jpg', VC), null);
  assert.equal(Core.unregisteredViewCode('NAT1219802_liz_02.jpg', VC), null);
});

test('unregisteredViewCode: null si no parece view-coded o usa "__"', () => {
  assert.equal(Core.unregisteredViewCode('VXC084N528YF53EC.jpg', VC), null);
  assert.equal(Core.unregisteredViewCode('ABC__front.jpg', VC), null);
  assert.equal(Core.unregisteredViewCode('ABC_12.jpg', VC), null);
});

// ── normViewCodes ────────────────────────────────────────────────────────────
test('normViewCodes: array y string → Set en MAYÚSCULAS, sin vacíos', () => {
  assert.deepEqual([...Core.normViewCodes(['liz', ' LDE ', ''])].sort(), ['LDE', 'LIZ']);
  assert.deepEqual([...Core.normViewCodes('liz, lde')].sort(), ['LDE', 'LIZ']);
  assert.equal(Core.normViewCodes(null).size, 0);
});

// ── selectDisplayImage: portada = ISO si existe, si no la más grande ─────────
test('selectDisplayImage: prefiere la vista ISO aunque NO sea la más grande', () => {
  const files = [
    { name: 'NAT1219802_SUP_01.jpg', size: 3_000_000 }, // la más grande, pero no ISO
    { name: 'NAT1219802_LDE_02.jpg', size: 2_000_000 },
    { name: 'NAT1219802_ISO_04.jpg', size: 900_000 },   // ISO gana
  ];
  assert.equal(Core.selectDisplayImage(files).name, 'NAT1219802_ISO_04.jpg');
});

test('selectDisplayImage: sin ISO → la imagen más grande por bytes', () => {
  const files = [
    { name: 'NAT1219802_LIZ_02.jpg', size: 1_042_663 },
    { name: 'NAT1219802_SUP_01.jpg', size: 1_190_519 },
    { name: 'NAT1219802_LDE_04.jpg', size: 1_520_946 }, // caso real Collado (no hay ISO)
  ];
  assert.equal(Core.selectDisplayImage(files).name, 'NAT1219802_LDE_04.jpg');
});

test('selectDisplayImage: entre varias ISO, la más grande (desempate por nombre)', () => {
  const files = [
    { name: 'X_ISO_04.jpg', size: 500_000 },
    { name: 'X_ISO_05.jpg', size: 800_000 },
  ];
  assert.equal(Core.selectDisplayImage(files).name, 'X_ISO_05.jpg');
});

test('selectDisplayImage: ISO detectada también en convención doble "__iso"', () => {
  const files = [
    { name: 'ABC__front.jpg', size: 2_000_000 },
    { name: 'ABC__iso.jpg', size: 700_000 },
  ];
  assert.equal(Core.selectDisplayImage(files).name, 'ABC__iso.jpg');
});

test('selectDisplayImage: solo PDFs/planos (sin imagen) → null', () => {
  assert.equal(Core.selectDisplayImage([{ name: 'ABC_ISO_04.pdf', size: 9_000_000 }]), null);
  assert.equal(Core.selectDisplayImage([]), null);
});

test('isIsoView: reconoce ISO en ambas convenciones y descarta falsos positivos', () => {
  assert.equal(Core.isIsoView('NAT1219802_ISO_04.jpg'), true);
  assert.equal(Core.isIsoView('NAT1219802_iso_04.JPG'), true);
  assert.equal(Core.isIsoView('ABC__ISO.jpg'), true);
  assert.equal(Core.isIsoView('NAT1219802_SUP_01.jpg'), false);
  assert.equal(Core.isIsoView('ABC__isometrico.jpg'), false); // "iso"+letra ≠ token ISO
  assert.equal(Core.isIsoView('ISONORM_FRO_01.jpg'), false);  // PN empieza con "ISO" pero la vista es FRO
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
