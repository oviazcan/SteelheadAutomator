// tools/test/invoice-autofill-customer-heading.test.js
// Contrato del lector del CLIENTE desde el encabezado del editor de factura.
//
// Por qué existe (2026-08-03): reporte de piso — «no detecta el cliente… se queda
// detrás». Al medir en vivo el flujo real (/Invoices → Packing Slips → CREAR FACTURA)
// el encabezado SÍ traía `Creating Invoice for SCHNEIDER ELECTRIC MEXICO`, así que el
// fallo NO era permanente: era intermitente. La ventana de carrera está en cómo se
// leía ese encabezado — se concatenaban sólo los text nodes DIRECTOS y se hacía `break`
// al toparse con un elemento que no fuera span/em/strong/b. Si en ese instante React
// aún no había pintado el nombre como texto plano (o lo metía dentro de un <a>/<div>),
// quedaba `txt = "Creating Invoice for"` SIN el nombre; el regex no matcheaba y, como
// `txt` no estaba vacío, el fallback a `h.textContent` NUNCA se disparaba.
//
// El endurecimiento no cambia el anclaje: lo AMPLÍA. Se intenta el mismo parseo contra
// el texto directo Y contra el textContent completo, y se extrae la decisión a esta
// función pura para poder ejercerla sin DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseCustomerFromHeadingText: parse } = require(
  path.join(__dirname, '..', '..', 'remote', 'scripts', 'invoice-autofill.js'));

test('camino normal: text nodes directos, encabezado limpio (medido en vivo 2026-08-03)', () => {
  assert.equal(
    parse('Creating Invoice for SCHNEIDER ELECTRIC MEXICO'),
    'SCHNEIDER ELECTRIC MEXICO');
});

test('EL CASO DEL BUG: textContent completo, con los botones del encabezado pegados', () => {
  // Así se lee el h* entero: los botones "+ View Customer Custom Inputs",
  // "<> EDIT POWER TOOLS" y el "Total: $X" viven DENTRO del encabezado.
  // El "+" del primer botón queda pegado al nombre tras cortar por "View".
  //
  // ⚠️ FIXTURE RECONSTRUIDO, NO MEDIDO. Se armó a partir de lo que se VE en el editor
  // (captura del 2026-08-03) y del comentario que ya traía el código sobre los botones
  // anexos. Al intentar leer el outerHTML real, `/Invoices` empezó a responder
  // "¡PERMISOS INSUFICIENTES! … READ_INVOICING" y no se pudo volver a abrir el editor.
  // Lo que SÍ está medido en vivo es el encabezado limpio del test anterior. Si alguien
  // alcanza el DOM real, sustituya esta cadena por la medida y deje nota aquí.
  const full = 'Creating Invoice for SCHNEIDER ELECTRIC MEXICO+ View Customer Custom '
    + 'Inputs+ View Customer Address Custom Inputs<> EDIT POWER TOOLSTotal: $0.00';
  assert.equal(parse(full), 'SCHNEIDER ELECTRIC MEXICO');
});

test('el nombre en su propia línea (el textContent trae saltos): se corta en la línea', () => {
  // El regex anterior era `(.+?)$` sin flag `s`: `.` no cruza `\n` y `$` no estaba ahí,
  // así que este texto NO matcheaba y devolvía null.
  const full = 'Creating Invoice for SCHNEIDER ELECTRIC MEXICO\n+ View Customer Custom Inputs';
  assert.equal(parse(full), 'SCHNEIDER ELECTRIC MEXICO');
});

test('CamelCase pegado al botón (caso MOGUL, ya cubierto antes — no se regresiona)', () => {
  assert.equal(
    parse('Editing Invoice for MOGULView Customer Custom Inputs'),
    'MOGUL');
});

test('"Total: $X" pegado al nombre no se lleva el punto final de la razón social', () => {
  assert.equal(
    parse('Creating Invoice for ACME S.A. DE C.V.Total: $1,234.00'),
    'ACME S.A. DE C.V.');
});

test('español: ancla en factura/para, ignorando el verbo que traduzcan', () => {
  assert.equal(parse('Creando Factura para GRUPO COLLADO'), 'GRUPO COLLADO');
  assert.equal(parse('Generando factura para GRUPO COLLADO'), 'GRUPO COLLADO');
});

test('el sufijo (#N) del cliente se PRESERVA — extractIdInDomainFromCustomerName lo usa', () => {
  assert.equal(
    parse('Creating Invoice for FISHER CONTROLES (#7)'),
    'FISHER CONTROLES (#7)');
});

test('sin el ancla invoice/factura + for/para → null (no se adivina)', () => {
  assert.equal(parse('Packing Slip: #001559'), null);
  assert.equal(parse('Panel de Envío'), null);
  assert.equal(parse('Create Invoice Manually'), null);
});

test('encabezado SIN nombre → null, nunca una cadena vacía o el verbo suelto', () => {
  // Éste es exactamente el estado transitorio que producía el bug: si devolviera
  // algo truthy, el applet lo tomaría por cliente y dispararía un autofill con basura.
  assert.equal(parse('Creating Invoice for'), null);
  assert.equal(parse('Creating Invoice for '), null);
  assert.equal(parse('Creating Invoice for +'), null);
});

test('entrada vacía o no-cadena → null (no truena)', () => {
  assert.equal(parse(''), null);
  assert.equal(parse(null), null);
  assert.equal(parse(undefined), null);
});

test('un nombre absurdamente largo se rechaza (200 chars) — es basura del DOM, no un cliente', () => {
  assert.equal(parse('Creating Invoice for ' + 'X'.repeat(250)), null);
  assert.equal(parse('Creating Invoice for ' + 'X'.repeat(150)), 'X'.repeat(150));
});

test('un solo carácter no es un nombre de cliente', () => {
  assert.equal(parse('Creating Invoice for A'), null);
  assert.equal(parse('Creating Invoice for AB'), 'AB');
});
