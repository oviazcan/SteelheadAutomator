// tools/test/packing-slip-drawings-core.test.js
// Golden tests del núcleo de decisión de "Planos en Remisión".
// Run: node --test tools/test/packing-slip-drawings-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/packing-slip-drawings-core.js');

// ---------- readIncluirPlanos ----------
// Path MEDIDO contra la DuckDB (snapshot TLC 2026-08-04):
//   customer.custom_input → $.DatosLogisticos.IncluirPlanos
// Presente en 77 clientes; hoy sólo FISHER CONTROLES DE MEXICO lo tiene en true.

test('readIncluirPlanos: objeto anidado con booleano real', () => {
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: true } }), true);
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: false } }), false);
});

test('readIncluirPlanos: string JSON (como lo devuelven algunas queries)', () => {
  assert.equal(Core.readIncluirPlanos('{"DatosLogisticos":{"IncluirPlanos":true}}'), true);
  assert.equal(Core.readIncluirPlanos('{"DatosLogisticos":{"IncluirPlanos":false}}'), false);
});

test('readIncluirPlanos: booleano serializado como string', () => {
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: 'true' } }), true);
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: 'false' } }), false);
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: '  TRUE  ' } }), true);
});

test('readIncluirPlanos: el grupo también puede venir como string JSON', () => {
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: '{"IncluirPlanos":true}' }), true);
});

test('readIncluirPlanos: AUSENTE devuelve null, que NO es false', () => {
  // 6 de los 81 clientes activos no tienen el campo. "No sé" ≠ "no quiere":
  // false apaga el applet en silencio, null obliga a la nota ámbar.
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: {} }), null);
  assert.equal(Core.readIncluirPlanos({}), null);
  assert.equal(Core.readIncluirPlanos(null), null);
  assert.equal(Core.readIncluirPlanos(undefined), null);
});

test('readIncluirPlanos: basura ilegible devuelve null, no revienta', () => {
  assert.equal(Core.readIncluirPlanos('no soy json {{{'), null);
  assert.equal(Core.readIncluirPlanos(42), null);
  assert.equal(Core.readIncluirPlanos([]), null);
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: 'quizá' } }), null);
});

test('readIncluirPlanos: otro grupo con el mismo nombre de campo NO cuenta', () => {
  // Sólo DatosLogisticos.IncluirPlanos gobierna. Un homónimo en otro grupo se ignora.
  assert.equal(Core.readIncluirPlanos({ DatosFactura: { IncluirPlanos: true } }), null);
});

// ---------- classifyFile ----------
// Distribución REAL medida en TLC sobre 30,547 archivos vinculados a NP:
//   jpg 25905 · pdf 3936 · png 627 · jpeg 55 · bmp/gif/tif/step 13

test('classifyFile: PDF y CAD son plano', () => {
  assert.equal(Core.classifyFile('4521-A__plano_rev3.pdf'), 'plano');
  assert.equal(Core.classifyFile('dibujo.dwg'), 'plano');
  assert.equal(Core.classifyFile('modelo.dxf'), 'plano');
  assert.equal(Core.classifyFile('pieza.step'), 'plano');
});

test('classifyFile: imágenes son foto', () => {
  assert.equal(Core.classifyFile('NAT1219802_ISO_02.jpg'), 'foto');
  assert.equal(Core.classifyFile('x.jpeg'), 'foto');
  assert.equal(Core.classifyFile('x.png'), 'foto');
  assert.equal(Core.classifyFile('x.bmp'), 'foto');
  assert.equal(Core.classifyFile('x.gif'), 'foto');
  assert.equal(Core.classifyFile('x.tif'), 'foto');
});

test('classifyFile: la extensión es case-insensitive', () => {
  assert.equal(Core.classifyFile('PLANO.PDF'), 'plano');
  assert.equal(Core.classifyFile('FOTO.JPG'), 'foto');
});

test('classifyFile: nombre con puntos internos usa la ÚLTIMA extensión', () => {
  assert.equal(Core.classifyFile('4521.rev.2.pdf'), 'plano');
  assert.equal(Core.classifyFile('pieza.v1.jpg'), 'foto');
});

test('classifyFile: desconocido o sin extensión es "otro"', () => {
  assert.equal(Core.classifyFile('archivo.xlsx'), 'otro');
  assert.equal(Core.classifyFile('sinextension'), 'otro');
  assert.equal(Core.classifyFile(''), 'otro');
  assert.equal(Core.classifyFile(null), 'otro');
  assert.equal(Core.classifyFile(undefined), 'otro');
});

// ---------- buildAttachmentPlan ----------
// pns = [{id, name}] · filesByPn = { [pnId]: [{name, originalName}] }
//   `name`         = userFile.name (generado por el servidor; es lo que se adjunta)
//   `originalName` = lo que el cliente ve en el correo

const PNS = [
  { id: 101, name: '4521-A' },
  { id: 102, name: '4522-B' },
  { id: 103, name: '4523-C' },
];
const FILES = {
  101: [
    { name: 'gen-aaa.pdf', originalName: '4521-A__plano_rev3.pdf' },
    { name: 'gen-bbb.jpg', originalName: '4521-A_ISO_01.jpg' },
  ],
  102: [{ name: 'gen-ccc.pdf', originalName: '4522-B__dwg.pdf' }],
  103: [], // sin ningún archivo — el caso MAYORITARIO (77% en Fisher)
};

test('buildAttachmentPlan: agrupa por NP conservando el orden recibido', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  assert.deepEqual(p.groups.map((g) => g.pnName), ['4521-A', '4522-B', '4523-C']);
  assert.equal(p.groups[0].files.length, 2);
  assert.equal(p.groups[2].files.length, 0);
});

test('buildAttachmentPlan: premarca SÓLO los planos; las fotos van visibles y desmarcadas', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  const g0 = p.groups[0].files;
  const pdf = g0.find((f) => f.displayName.endsWith('.pdf'));
  const jpg = g0.find((f) => f.displayName.endsWith('.jpg'));
  assert.equal(pdf.preselected, true);
  assert.equal(pdf.kind, 'plano');
  assert.ok(jpg, 'la foto SÍ está presente — nada se oculta');
  assert.equal(jpg.preselected, false, 'pero NO viene marcada');
});

test('buildAttachmentPlan: adjunta userFile.name y muestra originalName', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  const f = p.groups[0].files[0];
  assert.equal(f.filename, 'gen-aaa.pdf');
  assert.equal(f.displayName, '4521-A__plano_rev3.pdf');
});

test('buildAttachmentPlan: pnsSinPlano incluye al que NO TIENE NADA', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  assert.deepEqual(p.pnsSinPlano.map((x) => x.pnName), ['4523-C']);
});

test('buildAttachmentPlan: pnsSinPlano incluye también al que SÓLO tiene fotos', () => {
  // Un NP con fotos y ningún plano deja al cliente sin lo que pidió.
  const p = Core.buildAttachmentPlan({
    pns: [{ id: 1, name: 'SOLO-FOTOS' }],
    filesByPn: { 1: [{ name: 'g1.jpg', originalName: 'a_ISO_01.jpg' }] },
  });
  assert.deepEqual(p.pnsSinPlano.map((x) => x.pnName), ['SOLO-FOTOS']);
  assert.equal(p.groups[0].files.length, 1, 'la foto sigue visible y marcable');
});

test('buildAttachmentPlan: totals cuenta archivos, premarcados y NP sin archivo', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  assert.equal(p.totals.archivos, 3);
  assert.equal(p.totals.preseleccionados, 2);
  assert.equal(p.totals.pnsSinArchivo, 1);
});

test('buildAttachmentPlan: entrada vacía no revienta y da un plan vacío', () => {
  const p = Core.buildAttachmentPlan({ pns: [], filesByPn: {} });
  assert.deepEqual(p.groups, []);
  assert.deepEqual(p.pnsSinPlano, []);
  assert.equal(p.totals.archivos, 0);
});

test('buildAttachmentPlan: tolera pns/filesByPn ausentes', () => {
  const p = Core.buildAttachmentPlan({});
  assert.deepEqual(p.groups, []);
  assert.equal(p.totals.archivos, 0);
  const p2 = Core.buildAttachmentPlan();
  assert.deepEqual(p2.groups, []);
});

test('buildAttachmentPlan: descarta entradas de PN sin id', () => {
  const p = Core.buildAttachmentPlan({ pns: [{ name: 'sin-id' }, null], filesByPn: {} });
  assert.deepEqual(p.groups, []);
});

// ---------- toAttachments ----------

test('toAttachments: proyecta al shape que espera la mutation', () => {
  // Shape CONFIRMADO en vivo (2026-08-05): SendEmailChecked.variables.attachments
  // es un array; cfdi-attacher ya lo usa con {filename, displayName}.
  const out = Core.toAttachments([
    { filename: 'gen-aaa.pdf', displayName: 'plano.pdf', kind: 'plano' },
  ]);
  assert.deepEqual(out, [{ filename: 'gen-aaa.pdf', displayName: 'plano.pdf' }]);
});

test('toAttachments: DEDUPLICA por filename — un archivo en dos NP se adjunta una vez', () => {
  const out = Core.toAttachments([
    { filename: 'gen-aaa.pdf', displayName: 'compartido.pdf' },
    { filename: 'gen-aaa.pdf', displayName: 'compartido.pdf' },
    { filename: 'gen-bbb.pdf', displayName: 'otro.pdf' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((a) => a.filename), ['gen-aaa.pdf', 'gen-bbb.pdf']);
});

test('toAttachments: lista vacía da array vacío (el payload no se debe tocar)', () => {
  assert.deepEqual(Core.toAttachments([]), []);
  assert.deepEqual(Core.toAttachments(null), []);
  assert.deepEqual(Core.toAttachments(), []);
});

test('toAttachments: descarta entradas sin filename', () => {
  const out = Core.toAttachments([{ displayName: 'huerfano.pdf' }, { filename: '', displayName: 'x' }]);
  assert.deepEqual(out, []);
});

test('toAttachments: sin displayName cae al filename', () => {
  assert.deepEqual(Core.toAttachments([{ filename: 'gen-aaa.pdf' }]),
    [{ filename: 'gen-aaa.pdf', displayName: 'gen-aaa.pdf' }]);
});
