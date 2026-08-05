// tools/test/packing-slip-modal-core.test.js
// Golden tests del reconocimiento del modal "Send Shipping Email".
// Estructura capturada EN VIVO el 2026-08-04/05 (Ecoplating TLC, dominio 344).
// Run: node --test tools/test/packing-slip-modal-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Modal = require('../../remote/scripts/packing-slip-modal-core.js');

// ---------- isShippingEmailModal ----------
// RIESGO R3: cfdi-attacher reconoce SU modal por «>=2 MuiSwitch + icono de
// correo». El de remisión tiene 5 switches y un icono de correo, así que
// también pasaría ese filtro. Lo que los separa es el HEADING.

test('isShippingEmailModal: reconoce el modal REAL de la remisión', () => {
  // Medido en vivo: heading "Send Shipping Email", 5 MuiSwitch
  // (Logo, Parts List, Visible to Others, Enlace de Albarán de Entrega, +1).
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Shipping Email', switchCount: 5, hasEmailIcon: true,
  }), true);
});

test('isShippingEmailModal: RECHAZA el modal de factura (R3)', () => {
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Invoice Email', switchCount: 3, hasEmailIcon: true,
  }), false);
});

test('isShippingEmailModal: un heading AJENO gana sobre la estructura', () => {
  // Aunque tuviera 5 switches, si el título dice "factura" no lo tocamos.
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Invoice Email', switchCount: 5, hasEmailIcon: true,
  }), false);
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Enviar Correo de Factura', switchCount: 5, hasEmailIcon: true,
  }), false);
});

test('isShippingEmailModal: acepta el heading en español', () => {
  // ES no verificado en vivo (el modal salió en EN con la app en ES): son
  // candidatos declarados como DEUDA en la bitácora, no traducciones medidas.
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Enviar Correo de Albarán', switchCount: 5, hasEmailIcon: true,
  }), true);
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Enviar Remisión', switchCount: 5, hasEmailIcon: true,
  }), true);
});

test('isShippingEmailModal: el heading es case/espacio-insensible', () => {
  assert.equal(Modal.isShippingEmailModal({
    heading: '  SEND   SHIPPING   EMAIL  ', switchCount: 5, hasEmailIcon: true,
  }), true);
});

test('isShippingEmailModal: sin heading cae a la estructura (>=4 switches + icono)', () => {
  // Red de seguridad si SH traduce el título a algo no previsto: el de factura
  // tiene 3 switches y el de remisión 5; el umbral de 4 los separa.
  assert.equal(Modal.isShippingEmailModal({
    heading: '', switchCount: 5, hasEmailIcon: true,
  }), true);
  assert.equal(Modal.isShippingEmailModal({
    heading: '', switchCount: 3, hasEmailIcon: true,
  }), false);
});

test('isShippingEmailModal: sin icono de correo NO es el modal', () => {
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Shipping Email', switchCount: 5, hasEmailIcon: false,
  }), false);
  assert.equal(Modal.isShippingEmailModal({
    heading: '', switchCount: 5, hasEmailIcon: false,
  }), false);
});

test('isShippingEmailModal: entrada vacía o basura devuelve false', () => {
  assert.equal(Modal.isShippingEmailModal({}), false);
  assert.equal(Modal.isShippingEmailModal(null), false);
  assert.equal(Modal.isShippingEmailModal(undefined), false);
});

// ---------- extractPartNumbers ----------
// Filas capturadas EN VIVO del preview del correo (remisión #1746, 2026-08-04).
// El separador real entre celdas es TABULADOR (innerText de un <tr>).

test('extractPartNumbers: lee la fila REAL capturada en vivo', () => {
  const out = Modal.extractPartNumbers(['#1770 - 4300016123\t#13667\t10-4307003-001\t2567']);
  assert.equal(out.length, 1);
  assert.equal(out[0].pnName, '10-4307003-001');
  assert.equal(out[0].soNumber, '#1770 - 4300016123');
  assert.equal(out[0].woNumber, '#13667');
  assert.equal(out[0].qty, '2567');
});

test('extractPartNumbers: descarta la fila de ENCABEZADO', () => {
  const out = Modal.extractPartNumbers([
    'SO #\tWO #\tPart #\tQTY',
    '#1770 - 4300016123\t#13667\t10-4307003-001\t2567',
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pnName, '10-4307003-001');
});

test('extractPartNumbers: descarta el encabezado en español', () => {
  const out = Modal.extractPartNumbers([
    'OV #\tOT #\tParte #\tCant',
    '#1\t#10\tPN-AAA\t5',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['PN-AAA']);
});

test('extractPartNumbers: varias partes conservan su orden', () => {
  const out = Modal.extractPartNumbers([
    'SO #\tWO #\tPart #\tQTY',
    '#1\t#10\tPN-AAA\t5',
    '#2\t#20\tPN-BBB\t7',
    '#3\t#30\tPN-CCC\t9',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['PN-AAA', 'PN-BBB', 'PN-CCC']);
});

test('extractPartNumbers: DEDUPLICA el mismo PN repetido', () => {
  // El preview del modal repite el bloque "Parts List" varias veces; medido en
  // vivo, la misma fila aparecía 4 veces en el innerText del diálogo.
  const out = Modal.extractPartNumbers([
    '#1\t#10\tPN-AAA\t5',
    '#1\t#10\tPN-AAA\t5',
    '#1\t#10\tPN-AAA\t5',
    '#2\t#20\tPN-BBB\t7',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['PN-AAA', 'PN-BBB']);
});

test('extractPartNumbers: descarta filas que no calzan, sin inventar', () => {
  // Escribir el PN equivocado es peor que no escribir ninguno.
  const out = Modal.extractPartNumbers([
    'Respond to this email with any questions.',
    'Copyright © 2026 - Steelhead Technologies',
    'Click to View Packing Slip #1746',
    'To\tEVELIN MARTINEZ GUTIERREZ',
    '',
    '#1\t#10\tPN-AAA\t5',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['PN-AAA']);
});

test('extractPartNumbers: descarta la fila con celda de PN vacía', () => {
  const out = Modal.extractPartNumbers(['#1\t#10\t\t5\t\t']);
  assert.deepEqual(out, []);
});

test('extractPartNumbers: entrada vacía da lista vacía — y eso NO es conocimiento', () => {
  // Una lista vacía puede significar "no hay partes" o "no supe leerlas".
  // Quien consume debe tratarla como HUECO, no como certeza.
  assert.deepEqual(Modal.extractPartNumbers([]), []);
  assert.deepEqual(Modal.extractPartNumbers(null), []);
  assert.deepEqual(Modal.extractPartNumbers(), []);
});

// ---------- extractPackingSlipNumber ----------
// Sirve para localizar LA FILA correcta en la lista de atrás. Tomar la primera
// daría el cliente de otra remisión: invisible mientras todas las filas visibles
// sean del mismo cliente, y silenciosamente falso en cuanto no lo sean.

test('extractPackingSlipNumber: lee el número del cuerpo REAL del correo', () => {
  // Texto capturado en vivo del preview (remisión #1746).
  const txt = 'Estimado Cliente,\n\nRemisión: #1746\nOrden de Compra: 4300016123 (#1770)\nPartes: 10-4307003-001';
  assert.equal(Modal.extractPackingSlipNumber(txt), '1746');
});

test('extractPackingSlipNumber: lee el del link en inglés', () => {
  assert.equal(Modal.extractPackingSlipNumber('Click to View Packing Slip #1746'), '1746');
});

test('extractPackingSlipNumber: acepta "Albarán de Entrega" y sin acento', () => {
  assert.equal(Modal.extractPackingSlipNumber('Enlace de Albarán de Entrega #992'), '992');
  assert.equal(Modal.extractPackingSlipNumber('Remision: #55'), '55');
});

test('extractPackingSlipNumber: tolera espacios alrededor del #', () => {
  assert.equal(Modal.extractPackingSlipNumber('Remisión  :   #  1746'), '1746');
});

test('extractPackingSlipNumber: sin número devuelve null — no se adivina', () => {
  assert.equal(Modal.extractPackingSlipNumber('Respond to this email with any questions.'), null);
  assert.equal(Modal.extractPackingSlipNumber(''), null);
  assert.equal(Modal.extractPackingSlipNumber(null), null);
  assert.equal(Modal.extractPackingSlipNumber(), null);
});

test('extractPackingSlipNumber: un "#1770" suelto (la OC) NO se confunde con la remisión', () => {
  // La orden de compra también trae "#1770"; sólo cuenta el que sigue a la
  // palabra que nombra al documento.
  assert.equal(Modal.extractPackingSlipNumber('Orden de Compra: 4300016123 (#1770)'), null);
});

// ---------- findCustomerName ----------
// Identifica al cliente desde una respuesta de Apollo sin conocer su shape.
// Es el respaldo para cuando el modal NO se abre desde la lista de albaranes
// (p. ej. el módulo de Envío), donde no hay tabla `#NNNN | Cliente` que leer.

test('findCustomerName: lo encuentra anidado por __typename', () => {
  const resp = {
    emailCustomerContactsByCustomerIds: {
      nodes: [
        { __typename: 'CustomerContact', name: 'Elizabeth Morales', email: 'Ely.Morales@se.com',
          customerByCustomerId: { __typename: 'Customer', id: 7, name: 'SCHNEIDER ELECTRIC MEXICO' } },
      ],
    },
  };
  assert.equal(Modal.findCustomerName(resp), 'SCHNEIDER ELECTRIC MEXICO');
});

test('findCustomerName: NO confunde al contacto con el cliente', () => {
  // El contacto también tiene `name`; sólo cuenta __typename === 'Customer'.
  const resp = { nodes: [{ __typename: 'CustomerContact', name: 'Elizabeth Morales' }] };
  assert.equal(Modal.findCustomerName(resp), null);
});

test('findCustomerName: recorre arrays y objetos anidados', () => {
  const resp = { a: [{ b: { c: [{ __typename: 'Customer', name: 'FISHER CONTROLES DE MEXICO' }] } }] };
  assert.equal(Modal.findCustomerName(resp), 'FISHER CONTROLES DE MEXICO');
});

test('findCustomerName: recorta espacios', () => {
  assert.equal(Modal.findCustomerName({ __typename: 'Customer', name: '  ACME  ' }), 'ACME');
});

test('findCustomerName: un Customer sin nombre usable no cuenta', () => {
  assert.equal(Modal.findCustomerName({ __typename: 'Customer', name: '   ' }), null);
  assert.equal(Modal.findCustomerName({ __typename: 'Customer', name: null }), null);
  assert.equal(Modal.findCustomerName({ __typename: 'Customer', id: 7 }), null);
});

test('findCustomerName: entrada vacía o basura devuelve null', () => {
  assert.equal(Modal.findCustomerName(null), null);
  assert.equal(Modal.findCustomerName(undefined), null);
  assert.equal(Modal.findCustomerName({}), null);
  assert.equal(Modal.findCustomerName('texto'), null);
  assert.equal(Modal.findCustomerName(42), null);
});

test('findCustomerName: no se cuelga con anidamiento profundo', () => {
  // Tope de profundidad: más allá de 6 niveles deja de buscar en vez de
  // recorrer respuestas gigantes en el hilo principal.
  let deep = { __typename: 'Customer', name: 'MUY-PROFUNDO' };
  for (let i = 0; i < 12; i++) deep = { wrap: deep };
  assert.equal(Modal.findCustomerName(deep), null);
});

// ---------- encabezado colado (bug de producción v0.1.4) ----------

test('extractPartNumbers: "Part #" NUNCA se toma como número de parte', () => {
  // Visto en producción: la fila de encabezado se coló y el panel reportó
  // «No pude verificar 1 número(s) de parte: Part #». Filtrar sólo por el
  // INICIO de la fila no basta — basta una celda vacía o un carácter invisible
  // al frente para que el guard no dispare. Ahora se filtra también la CELDA.
  const out = Modal.extractPartNumbers([
    '​\tSO #\tWO #\tPart #\tQTY',   // zero-width space al inicio
    '\tSO #\tWO #\tPart #\tQTY',          // celda vacía al inicio
    '#671 - 4124181754\t#11692\tS2U7412A01\t16',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['S2U7412A01']);
});

test('extractPartNumbers: descarta encabezados en la celda de PN, en ambos idiomas', () => {
  const out = Modal.extractPartNumbers([
    'x\ty\tPart #\tz',
    'x\ty\tParte #\tz',
    'x\ty\tQTY\tz',
    'x\ty\tCantidad\tz',
    '#1\t#10\tPN-BUENO\t5',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['PN-BUENO']);
});

test('extractPartNumbers: el caso REAL de la remisión #1461', () => {
  // Cuatro líneas de datos con S2N1317A01 repetido, más el encabezado.
  const out = Modal.extractPartNumbers([
    'SO #\tWO #\tPart #\tQTY',
    '#671 - 4124181754\t#11692\tS2U7412A01\t16',
    '#671 - 4124181754\t#12045\tS49B0531A7\t1',
    '#671 - 4124181754\t#15030\tS2N1317A01\t30',
    '#671 - 4124181754\t#15218\tS2N1317A01\t30',
  ]);
  assert.deepEqual(out.map((x) => x.pnName), ['S2U7412A01', 'S49B0531A7', 'S2N1317A01']);
});
