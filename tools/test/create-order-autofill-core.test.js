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

// ── Regresión 2026-08-05: el cliente dejó de vivir en un singleValue ──
// SH cambió el control de "Cliente:" del modal: al confirmar la selección YA NO monta
// un <div class="…singleValue">NOMBRE (#N)</div>; escribe el label completo del valor
// en el `value` del <input role="combobox">. Medido en vivo: se tecleó "HUBBELL" y el
// input quedó en "HUBBELL PRODUCTS MEXICO (#20)" — ese texto lo puso SH, no el tecleo.
// Consecuencia: leer SOLO singleValues dejaba al cliente invisible y el fallback por
// label agarraba el singleValue del CONTACTO ("Miguel Castillo") → sin (#N) → "sin
// idInDomain" → no autofill. El fix AMPLÍA las fuentes: singleValues + values de los
// combobox, y sigue eligiendo por el badge (#N).
test('pickCustomerFromCandidates: halla al cliente cuando vive en el value del input (no en singleValue)', () => {
  // Snapshot REAL del modal tras elegir cliente (2026-08-05, /Domains/344/SalesOrders).
  const singleValues = [
    'MAKE_TO_ORDER',                       // Tipo
    'Miguel Castillo',                     // Contacto  ← el que el fallback robaba
    'Cinco Sur 104,\nParque Industrial Toluca 2000,\nToluca de Lerdo,, Estado de México,  50200,\nMéxico,', // Facturar a
    'Cinco Sur 104,\nParque Industrial Toluca 2000,\nToluca de Lerdo,, Estado de México,  50200,\nMéxico,', // Enviar a
    'Flete Propio',                        // Enviar vía
    '67 Días'                              // Términos
  ];
  const comboboxValues = ['HUBBELL PRODUCTS MEXICO (#20)'];

  // Antes del fix: ninguna de las fuentes históricas ve al cliente.
  assert.equal(Core.pickCustomerFromSingleValues(singleValues), null);

  const got = Core.pickCustomerFromCandidates(singleValues, comboboxValues);
  assert.deepEqual(got, {
    raw: 'HUBBELL PRODUCTS MEXICO (#20)',
    name: 'HUBBELL PRODUCTS MEXICO (#20)',
    idInDomain: 20
  });
});

test('pickCustomerFromCandidates: el singleValue con (#N) sigue ganando (forma histórica intacta)', () => {
  // Si SH repone el SingleValue, la vía vieja debe seguir mandando: los singleValues
  // van primero, así que un combobox con texto tecleado a medias no puede desbancarla.
  const got = Core.pickCustomerFromCandidates(
    ['CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)', 'Francisca Felipe Gómez'],
    ['CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)']
  );
  assert.equal(got.idInDomain, 10);
});

test('pickCustomerFromCandidates: sin badge en ninguna fuente → null (degrada, no inventa)', () => {
  // "Miguel Castillo" (el contacto) NO puede pasar por cliente: sin (#N) no hay cliente.
  assert.equal(Core.pickCustomerFromCandidates(['Miguel Castillo', '67 Días'], ['']), null);
  assert.equal(Core.pickCustomerFromCandidates([], []), null);
  assert.equal(Core.pickCustomerFromCandidates(null, null), null);
  assert.equal(Core.pickCustomerFromCandidates(undefined, ['ACME (#7)']).idInDomain, 7);
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

// Segunda pantalla de creación de OV (2026-07-09): /Domains/<id>/SalesOrders →
// "New Sales Order" → modal titulado "Create Sales Order" (EN). Mismos IDs RJSF que el
// flujo Receiving, así que reúsa el autofill; solo cambia el gate de URL y el título.
test('isCreateOrderModalHeading acepta ES ("Crear Orden de Venta") y EN ("Create Sales Order")', () => {
  assert.equal(Core.isCreateOrderModalHeading('Crear Orden de Venta'), true);
  assert.equal(Core.isCreateOrderModalHeading('  crear   orden  de  venta  '), true);
  assert.equal(Core.isCreateOrderModalHeading('Create Sales Order'), true);
  assert.equal(Core.isCreateOrderModalHeading('  CREATE SALES ORDER '), true);
  // No confundir con títulos vecinos ni parciales
  assert.equal(Core.isCreateOrderModalHeading('Create Sales Order Line'), false);
  assert.equal(Core.isCreateOrderModalHeading('Sales Orders'), false);
  assert.equal(Core.isCreateOrderModalHeading('Custom Inputs'), false);
  assert.equal(Core.isCreateOrderModalHeading(''), false);
  assert.equal(Core.isCreateOrderModalHeading(null), false);
});

// Regresión 2026-08-05 (v0.1.5): en /Receiving/CustomerParts el modal de OV nace con su
// campo "Cliente:" VACÍO y el cliente vive en el wizard padre. Sin poder anclar ese wizard
// no hay cliente que extraer → el panel ni se pinta ("ni siquiera sale el banner").
test('isReceiveWizardHeading ancla el wizard padre en ES y EN', () => {
  assert.equal(Core.isReceiveWizardHeading('Recibir piezas del cliente'), true);
  assert.equal(Core.isReceiveWizardHeading('  RECIBIR   PIEZAS  DEL  CLIENTE '), true);
  assert.equal(Core.isReceiveWizardHeading('Receive Parts From Customer'), true);
  assert.equal(Core.isReceiveWizardHeading('receive parts from customer'), true);
  // No confundir con el modal que vive DENTRO del wizard
  assert.equal(Core.isReceiveWizardHeading('Crear Orden de Venta'), false);
  assert.equal(Core.isReceiveWizardHeading('Entradas Personalizadas'), false);
  assert.equal(Core.isReceiveWizardHeading(''), false);
  assert.equal(Core.isReceiveWizardHeading(null), false);
});

// 2026-08-06: cuando el cliente NO tiene sus customInputs, el panel deja de ser un callejón
// sin salida y ofrece la ficha del cliente para configurarla. Formato confirmado por el
// operador: https://app.gosteelhead.com/Domains/344/Customers/6 para BRAININ (#6).
// Regresión 2026-08-06 — reportado desde producción con captura: el modal mostraba
// `USD - Dólar americano` YA PUESTO y el panel marcaba DIVISA en rojo con "usuario tocó
// después de autofill". Causa: se llenaba por substring (score 60) pero se verificaba por
// igualdad exacta, así que en la re-pasada del poll el applet no reconocía su propio
// trabajo. Razón Social se salvaba sólo porque ahí el cliente guarda el texto completo.
const DIVISA_OPTS = ['', 'USD - Dólar americano', 'MXN - Peso mexicano'];

test('isSelectAlreadyOnTarget: el applet RECONOCE lo que él mismo puso por substring', () => {
  // El cliente guarda el CÓDIGO; la opción trae código + descripción.
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 1, 'USD'), true);
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 2, 'MXN'), true);
  // …y también cuando guarda el texto completo (caso Razón Social)
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 1, 'USD - Dólar americano'), true);
});

test('isSelectAlreadyOnTarget: un cambio REAL del operador sigue detectándose', () => {
  // El candado que evita pisar al operador no se debilita: si el select quedó en MXN y
  // nosotros pondríamos USD, NO es nuestro trabajo → false (y el glue respeta el cambio).
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 2, 'USD'), false);
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 1, 'MXN'), false);
  // Sin selección (índice 0 = opción vacía) tampoco es "ya está"
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 0, 'USD'), false);
});

test('isSelectAlreadyOnTarget: sin match razonable nunca dice "ya está"', () => {
  assert.equal(Core.isSelectAlreadyOnTarget(['Apple', 'Banana'], 0, 'USD'), false);
  assert.equal(Core.isSelectAlreadyOnTarget(DIVISA_OPTS, 1, ''), false);
  assert.equal(Core.isSelectAlreadyOnTarget([], 0, 'USD'), false);
});

test('customerUrl arma la ficha del cliente', () => {
  assert.equal(Core.customerUrl(344, 6), '/Domains/344/Customers/6');
  assert.equal(Core.customerUrl('344', '6'), '/Domains/344/Customers/6');
  assert.equal(Core.customerUrl(1, 20), '/Domains/1/Customers/20');
});

test('customerUrl NO inventa la URL si falta un dato (degrada a aviso sin liga)', () => {
  // Un dominio inventado mandaría al operador a la ficha de OTRO dominio (TLC vs MTY) —
  // peor que no ofrecer liga.
  assert.equal(Core.customerUrl(null, 6), null);
  assert.equal(Core.customerUrl(344, null), null);
  assert.equal(Core.customerUrl(undefined, undefined), null);
  assert.equal(Core.customerUrl('', 6), null);
  assert.equal(Core.customerUrl(344, ''), null);
  // Nada que no sea numérico: cierra la puerta a interpolar basura en la ruta
  assert.equal(Core.customerUrl('344; drop', 6), null);
  assert.equal(Core.customerUrl(344, '6/../../evil'), null);
  assert.equal(Core.customerUrl('abc', 'def'), null);
});

test('domainIdFromPath saca el dominio de la ruta, y null cuando no lo trae', () => {
  assert.equal(Core.domainIdFromPath('/Domains/344/SalesOrders'), '344');
  assert.equal(Core.domainIdFromPath('/Domains/1/Customers/6'), '1');
  assert.equal(Core.domainIdFromPath('/Domains/344'), '344');
  // El flujo de Recibo NO lleva el dominio en la ruta → lo resuelve el glue por otra vía
  assert.equal(Core.domainIdFromPath('/Receiving/CustomerParts'), null);
  assert.equal(Core.domainIdFromPath('/Domains/abc/SalesOrders'), null);
  assert.equal(Core.domainIdFromPath(''), null);
  assert.equal(Core.domainIdFromPath(null), null);
});

test('matchesCreateOrderUrl gatea Receiving y la lista de SalesOrders', () => {
  assert.equal(Core.matchesCreateOrderUrl('/Receiving/CustomerParts'), true);
  assert.equal(Core.matchesCreateOrderUrl('/Receiving/CustomerParts/'), true);
  assert.equal(Core.matchesCreateOrderUrl('/Domains/344/SalesOrders'), true);
  assert.equal(Core.matchesCreateOrderUrl('/Domains/1/SalesOrders/'), true);
  // pathname NO trae la query (?receivedOrderStatusFilter=OPEN vive en location.search)
  assert.equal(Core.matchesCreateOrderUrl('/Domains/344/SalesOrders'), true);
  // Rutas que NO deben gatear
  assert.equal(Core.matchesCreateOrderUrl('/Domains/344/SalesOrders/9876'), false);
  assert.equal(Core.matchesCreateOrderUrl('/Domains/344/WorkOrders'), false);
  assert.equal(Core.matchesCreateOrderUrl('/Receiving/Dashboard'), false);
  assert.equal(Core.matchesCreateOrderUrl('/Domains/abc/SalesOrders'), false);
  assert.equal(Core.matchesCreateOrderUrl(''), false);
  assert.equal(Core.matchesCreateOrderUrl(null), false);
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
