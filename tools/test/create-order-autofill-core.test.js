// tools/test/create-order-autofill-core.test.js
// Golden tests del módulo puro de Crear OV — Autofill.
// Run: node --test tools/test/create-order-autofill-core.test.js
//
// Regresión del bug 2026-07-03: "sin idInDomain" para TODOS los clientes porque el
// glue no encontraba el singleValue del Cliente. Aquí fijamos la lógica robusta:
// elegir el singleValue con badge "(#N)" y matchear <option> por texto (incluye el
// caso Divisa "USD" vs opción "USD - Dólar americano").
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/create-order-autofill-core.js');

test('extractCustomerIdInDomain parsea el badge (#N)', () => {
  assert.equal(Core.extractCustomerIdInDomain('CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)'), 10);
  assert.equal(Core.extractCustomerIdInDomain('SCHNEIDER ELECTRIC MEXICO (#1)'), 1);
  assert.equal(Core.extractCustomerIdInDomain('Cliente sin badge'), null);
  assert.equal(Core.extractCustomerIdInDomain(''), null);
  assert.equal(Core.extractCustomerIdInDomain(null), null);
});

test('cleanCustomerName corta tras (#N) y elimina badges pegados', () => {
  assert.equal(
    Core.cleanCustomerName('SCHNEIDER ELECTRIC MEXICO (#1)Industrial'),
    'SCHNEIDER ELECTRIC MEXICO (#1)'
  );
  assert.equal(
    Core.cleanCustomerName('CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)'),
    'CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)'
  );
  // sin badge → trim tal cual
  assert.equal(Core.cleanCustomerName('  Foo Bar  '), 'Foo Bar');
});

test('pickCustomerFromSingleValues elige el singleValue con (#N) entre los del modal', () => {
  // Orden real del modal: Cliente, Contacto, Facturar a, Enviar vía, Términos.
  // Solo el Cliente trae "(#N)".
  const texts = [
    'CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)',
    'Francisca Felipe Gómez',
    'Paseo de la Reforma 2608 Int Piso 3, Oficina 301',
    'Flete Propio',
    '30 Días'
  ];
  const got = Core.pickCustomerFromSingleValues(texts);
  assert.deepEqual(got, {
    raw: 'CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)',
    name: 'CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)',
    idInDomain: 10
  });
});

test('pickCustomerFromSingleValues → null si ningún singleValue trae badge', () => {
  assert.equal(Core.pickCustomerFromSingleValues(['Francisca Felipe Gómez', '30 Días']), null);
  assert.equal(Core.pickCustomerFromSingleValues([]), null);
  assert.equal(Core.pickCustomerFromSingleValues(null), null);
});

test('scoreOptionMatch Divisa: "USD" matchea la opción "USD - Dólar americano" (substring, score 60)', () => {
  // RJSF: enum=value ("USD"), enumNames=text ("USD - Dólar americano"). El cliente
  // guarda "USD" (código) pero matcheamos contra opt.text.
  const opts = ['', 'USD - Dólar americano', 'MXN - Peso mexicano'];
  const r = Core.scoreOptionMatch(opts, 'USD');
  assert.equal(r.index, 1);
  assert.equal(r.score, 60);
  assert.equal(r.pass, true);
  assert.equal(r.text, 'USD - Dólar americano');

  const r2 = Core.scoreOptionMatch(opts, 'MXN');
  assert.equal(r2.index, 2);
  assert.equal(r2.pass, true);
});

test('scoreOptionMatch Divisa: también matchea si el cliente guardó el enumName completo (exacto, 100)', () => {
  const opts = ['', 'USD - Dólar americano', 'MXN - Peso mexicano'];
  const r = Core.scoreOptionMatch(opts, 'USD - Dólar americano');
  assert.equal(r.index, 1);
  assert.equal(r.score, 100);
  assert.equal(r.pass, true);
});

test('scoreOptionMatch Razón Social: string largo con dirección matchea exacto (100)', () => {
  const full = 'ECO030618BR4 - ECOPLATING SA DE CV, 1 de Mayo 1803, Zona Industrial, Toluca, Estado de México, 50071, México';
  const opts = ['', full, 'PRO800417TDA - PROQUIPA SA DE CV, 1 de Mayo 1801, Zona Industrial, Toluca, Estado de México, 50070, México'];
  const r = Core.scoreOptionMatch(opts, full);
  assert.equal(r.index, 1);
  assert.equal(r.score, 100);
  assert.equal(r.pass, true);
});

test('scoreOptionMatch: sin match razonable → pass=false', () => {
  const r = Core.scoreOptionMatch(['Apple', 'Banana'], 'USD');
  assert.equal(r.pass, false);
});

test('scoreOptionMatch: target vacío o options no-array → no match', () => {
  assert.equal(Core.scoreOptionMatch(['USD - Dólar americano'], '').pass, false);
  assert.equal(Core.scoreOptionMatch(null, 'USD').pass, false);
});

// Regresión del bug 2026-07-03 (v0.1.2): getModalRoot() arrancaba el match en el
// heading MISMO, y su clase "MuiDialogTitle-root" contiene el substring "MuiDialog",
// así que el selector `[class*="MuiDialog"]` matcheaba el TÍTULO (vacío) → svInRoot=0
// → cliente=null → "sin idInDomain" para TODOS. El título/contenido/acciones del
// diálogo NO son el root del modal; solo lo es el paper/contenedor.
test('isDialogRootClass: el título del diálogo NO es el root (bug del substring MuiDialog)', () => {
  assert.equal(Core.isDialogRootClass('MuiTypography-root MuiTypography-h6 MuiDialogTitle-root css-ohyacs'), false);
  assert.equal(Core.isDialogRootClass('MuiDialogContent-root css-y'), false);
  assert.equal(Core.isDialogRootClass('MuiDialogActions-root css-z'), false);
  assert.equal(Core.isDialogRootClass('MuiDialogContentText-root'), false);
});

test('isDialogRootClass: el paper/contenedor del diálogo SÍ es root', () => {
  assert.equal(Core.isDialogRootClass('MuiPaper-root MuiPaper-elevation24 MuiDialog-paper MuiDialog-paperScrollPaper css-x'), true);
  assert.equal(Core.isDialogRootClass('MuiDialog-container MuiDialog-scrollPaper css-x'), true);
  assert.equal(Core.isDialogRootClass('MuiDialog-paperFullScreen'), true);
});

test('isDialogRootClass: paper genérico (accordion) NO es root — evita quedarnos en el panel chico del RJSF', () => {
  assert.equal(Core.isDialogRootClass('MuiPaper-root MuiAccordion-root'), false);
  assert.equal(Core.isDialogRootClass('MuiContainer-root MuiContainer-maxWidthLg'), false);
  assert.equal(Core.isDialogRootClass(''), false);
  assert.equal(Core.isDialogRootClass(null), false);
});
