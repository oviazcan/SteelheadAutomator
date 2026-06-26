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
