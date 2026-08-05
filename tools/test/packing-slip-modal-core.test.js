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
