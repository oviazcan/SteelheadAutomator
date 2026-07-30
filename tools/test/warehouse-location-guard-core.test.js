// tools/test/warehouse-location-guard-core.test.js
// Golden tests del candado de "Ubicación inicial" del modal Recibir piezas del cliente.
// Run: node --test tools/test/warehouse-location-guard-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/warehouse-location-guard-core.js');

// ── Fixtures tomados del DOM REAL (inspección en vivo 2026-07-29, modal Recibir piezas
// del cliente, dominio Ecoplating TLC). Placeholders y textos de botón tal cual salieron.
const PH_LOC_ES = 'Buscar Ubicaciones...';
const PH_OTHER = ['Buscar Orden de Venta', 'Buscar Cotizaciones (Agregar Piezas Desde Cotización)',
  'Crear o buscar grupos', 'Tipo', 'Select...'];
const FOOTER_BUTTONS_ES = ['Guardar + imprimir todas las piezas', 'Cancelar', 'Guardar',
  'Guardar y agregar piezas a OT'];

// ---------- isLocationPlaceholder ----------

test('isLocationPlaceholder: reconoce el placeholder REAL del combo de ubicación', () => {
  assert.equal(Core.isLocationPlaceholder(PH_LOC_ES), true);
});

test('isLocationPlaceholder: bilingüe ES+EN', () => {
  assert.equal(Core.isLocationPlaceholder('Search Locations...'), true);
  assert.equal(Core.isLocationPlaceholder('search locations'), true);
});

test('isLocationPlaceholder: NO confunde los otros placeholders del renglón', () => {
  for (const ph of PH_OTHER) {
    assert.equal(Core.isLocationPlaceholder(ph), false, `no debe matchear «${ph}»`);
  }
});

test('isLocationPlaceholder: tolera espacios raros y vacíos', () => {
  assert.equal(Core.isLocationPlaceholder('  Buscar   Ubicaciones...  '), true);
  assert.equal(Core.isLocationPlaceholder(''), false);
  assert.equal(Core.isLocationPlaceholder(null), false);
  assert.equal(Core.isLocationPlaceholder(undefined), false);
});

// ---------- isRowLocationLabel ----------

test('isRowLocationLabel: el label REAL del renglón, con y sin dos puntos', () => {
  assert.equal(Core.isRowLocationLabel('Ubicación Inicial:'), true);
  assert.equal(Core.isRowLocationLabel('ubicacion inicial'), true);
  assert.equal(Core.isRowLocationLabel('Initial Location:'), true);
});

test('isRowLocationLabel: NO confunde el label del encabezado ni los vecinos del renglón', () => {
  // El del encabezado es nuestro propio campo, no el nativo del renglón.
  assert.equal(Core.isRowLocationLabel('Ubicación inicial'), true); // mismo texto: es aceptable
  for (const t of ['Orden de Venta (OC#):', 'Cotización:', 'Grupo de Piezas:', 'Contenedor:', 'Ubicación:']) {
    assert.equal(Core.isRowLocationLabel(t), false, `no debe matchear «${t}»`);
  }
});

// ---------- rowHasLocation ----------
// El caso que destapó la validación en vivo (2026-07-29): al TECLEAR en el combo del renglón
// sin elegir nada, react-select retira el placeholder aunque NO haya valor. Juzgar por
// "no hay placeholder" daba el renglón por resuelto y liberaba el guardado.

test('rowHasLocation: combo localizado por label — manda la señal POSITIVA', () => {
  assert.equal(Core.rowHasLocation({ foundByLabel: true, hasSingleValue: true, hasPlaceholder: false }), true);
  assert.equal(Core.rowHasLocation({ foundByLabel: true, hasSingleValue: false, hasPlaceholder: true }), false);
});

test('rowHasLocation: TECLEANDO SIN ELEGIR (sin placeholder y sin valor) cuenta como FALTANTE', () => {
  assert.equal(Core.rowHasLocation({ foundByLabel: true, hasSingleValue: false, hasPlaceholder: false }), false);
});

test('rowHasLocation: sin el combo localizado cae a la señal negativa (fallback de locale)', () => {
  assert.equal(Core.rowHasLocation({ foundByLabel: false, hasPlaceholder: true }), false);
  assert.equal(Core.rowHasLocation({ foundByLabel: false, hasPlaceholder: false }), true);
});

test('rowHasLocation: señales ausentes no truenan', () => {
  assert.equal(Core.rowHasLocation(undefined), true);
  assert.equal(Core.rowHasLocation({}), true);
});

// ---------- isSaveButtonText / isCancelButtonText ----------

test('isSaveButtonText: los TRES botones de guardar del pie real, y Cancelar NO', () => {
  const flags = FOOTER_BUTTONS_ES.map((t) => Core.isSaveButtonText(t));
  assert.deepEqual(flags, [true, false, true, true]);
});

test('isSaveButtonText: bilingüe ES+EN', () => {
  assert.equal(Core.isSaveButtonText('Save'), true);
  assert.equal(Core.isSaveButtonText('Save + print all parts'), true);
  assert.equal(Core.isSaveButtonText('Save and add parts to WO'), true);
  assert.equal(Core.isSaveButtonText('Cancel'), false);
});

test('isSaveButtonText: texto vacío o ajeno no es botón de guardar', () => {
  assert.equal(Core.isSaveButtonText(''), false);
  assert.equal(Core.isSaveButtonText(null), false);
  assert.equal(Core.isSaveButtonText('Cargar archivo de recepción'), false);
  assert.equal(Core.isSaveButtonText('Serializar'), false);
});

test('isCancelButtonText: exacto — no atrapa un guardar que mencione cancelar', () => {
  assert.equal(Core.isCancelButtonText('Cancelar'), true);
  assert.equal(Core.isCancelButtonText('  cancel  '), true);
  assert.equal(Core.isCancelButtonText('Guardar y cancelar pendientes'), false);
});

// ---------- describeRow ----------

test('describeRow: con número de parte y lote', () => {
  assert.equal(Core.describeRow({ index: 3, part: '80095-337-01', batch: 'T-226' }),
    'Línea 3 · 80095-337-01 · lote T-226');
});

test('describeRow: solo número de parte', () => {
  assert.equal(Core.describeRow({ index: 1, part: '80255-140-01', batch: '' }),
    'Línea 1 · 80255-140-01');
});

test('describeRow: solo lote', () => {
  assert.equal(Core.describeRow({ index: 2, part: null, batch: 'T-232' }),
    'Línea 2 · lote T-232');
});

test('describeRow: renglón todavía vacío → el índice es lo único que identifica', () => {
  assert.equal(Core.describeRow({ index: 4, part: '', batch: '' }),
    'Línea 4 (sin número de parte)');
  assert.equal(Core.describeRow({ index: 4 }), 'Línea 4 (sin número de parte)');
});

// ---------- decideSaveGate ----------

const rowWith = (index, extra) => Object.assign({ index, hasLocation: true, part: null, batch: null }, extra);

test('decideSaveGate: ubicación en el ENCABEZADO cubre todo aunque los renglones estén vacíos', () => {
  const gate = Core.decideSaveGate({
    headerLocation: 'Ecoplating.N2.A2.A2Aduana',
    rows: [rowWith(1, { hasLocation: false }), rowWith(2, { hasLocation: false })],
  });
  assert.equal(gate.blocked, false);
  assert.equal(gate.reason, 'header-covers-all');
  assert.deepEqual(gate.missing, []);
});

test('decideSaveGate: sin renglones no bloquea (React ya deshabilita el pie)', () => {
  const gate = Core.decideSaveGate({ headerLocation: '', rows: [] });
  assert.equal(gate.blocked, false);
  assert.equal(gate.reason, 'no-rows');
});

test('decideSaveGate: todos los renglones con ubicación manual → pasa', () => {
  const gate = Core.decideSaveGate({ headerLocation: null, rows: [rowWith(1), rowWith(2)] });
  assert.equal(gate.blocked, false);
  assert.equal(gate.reason, 'all-set');
  assert.equal(gate.total, 2);
});

test('decideSaveGate: UN renglón sin ubicación bloquea y lo nombra', () => {
  const gate = Core.decideSaveGate({
    headerLocation: '',
    rows: [
      rowWith(1, { part: '80095-337-01', batch: 'T-226' }),
      rowWith(2, { hasLocation: false, part: '80255-140-01', batch: 'T-232' }),
      rowWith(3, { part: '80247-508-05' }),
    ],
  });
  assert.equal(gate.blocked, true);
  assert.equal(gate.reason, 'missing-locations');
  assert.equal(gate.missing.length, 1);
  assert.equal(gate.summary, '⛔ Falta la ubicación inicial en 1 de 3 líneas');
  assert.match(gate.tooltip, /Línea 2 · 80255-140-01 · lote T-232/);
  // El tooltip solo debe nombrar al faltante, no a los que ya están puestos.
  assert.doesNotMatch(gate.tooltip, /80095-337-01/);
});

test('decideSaveGate: TODOS sin ubicación → resumen sin "de N"', () => {
  const gate = Core.decideSaveGate({ headerLocation: '', rows: [rowWith(1, { hasLocation: false })] });
  assert.equal(gate.blocked, true);
  assert.equal(gate.summary, '⛔ Falta la ubicación inicial (1 línea)');
  assert.match(gate.tooltip, /1 de 1 línea sin ubicación inicial/);
});

test('decideSaveGate: el tooltip resume cuando hay más faltantes que el tope', () => {
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push(rowWith(i, { hasLocation: false, part: `PN-${i}` }));
  const gate = Core.decideSaveGate({ headerLocation: '', rows });
  assert.equal(gate.missing.length, 12);
  assert.match(gate.tooltip, /PN-8/);
  assert.doesNotMatch(gate.tooltip, /PN-9\b/);
  assert.match(gate.tooltip, /…y 4 líneas más/);
});

test('decideSaveGate: tooltip siempre dice CÓMO salir del bloqueo', () => {
  const gate = Core.decideSaveGate({ headerLocation: '', rows: [rowWith(1, { hasLocation: false })] });
  assert.match(gate.tooltip, /Ubicación inicial» del encabezado/);
});

test('decideSaveGate: entradas basura no truenan y NO bloquean (fail-safe)', () => {
  for (const bad of [undefined, null, {}, { rows: null }, { rows: 'x' }]) {
    const gate = Core.decideSaveGate(bad);
    assert.equal(gate.blocked, false, `no debe bloquear con ${JSON.stringify(bad)}`);
  }
});

test('decideSaveGate: un renglón null cuenta como faltante, no como crash', () => {
  const gate = Core.decideSaveGate({ headerLocation: '', rows: [null, rowWith(2)] });
  assert.equal(gate.blocked, true);
  assert.equal(gate.missing.length, 1);
});

// ---------- formatGateLines ----------

test('formatGateLines: sin faltantes → lista vacía', () => {
  assert.deepEqual(Core.formatGateLines([]), []);
  assert.deepEqual(Core.formatGateLines(null), []);
});

test('formatGateLines: singular en el remanente', () => {
  const rows = [];
  for (let i = 1; i <= 4; i++) rows.push({ index: i, part: `PN-${i}` });
  const lines = Core.formatGateLines(rows, 3);
  assert.equal(lines.length, 4);
  assert.equal(lines[3], ' • …y 1 línea más');
});

// ---------- hasLocationId ----------

test('hasLocationId: ids reales de Steelhead cuentan como puestos', () => {
  assert.equal(Core.hasLocationId(123456), true);
  assert.equal(Core.hasLocationId('123456'), true);
});

test('hasLocationId: ausente, nulo, vacío y 0 cuentan como FALTANTE', () => {
  for (const v of [null, undefined, '', 0, '0', -1]) {
    assert.equal(Core.hasLocationId(v), false, `${JSON.stringify(v)} debe contar como faltante`);
  }
});

// ---------- payloadMissingLocations ----------

// Forma REAL del payload de CreateReceiverChecked (documentada en la bitácora del applet,
// dumps de producción 0.5.69→0.5.80): el locationId vive en
// receiverBomItems[].inventoryTransferEvent.debitAccounts.accounts[].locationId
// y el campo NO EXISTE cuando el operador no toca el combo del renglón.
const payload = (accountsPerItem) => ({
  operationName: 'CreateReceiverChecked',
  variables: {
    receiverPayload: {
      receiverBomItems: accountsPerItem.map((accs) => ({
        inventoryTransferEvent: { debitAccounts: { accounts: accs } },
      })),
    },
  },
});

test('payloadMissingLocations: todos con locationId → checked, sin faltantes', () => {
  const r = Core.payloadMissingLocations(payload([[{ locationId: 3311 }], [{ locationId: 3311 }]]));
  assert.equal(r.checked, true);
  assert.equal(r.total, 2);
  assert.deepEqual(r.missing, []);
});

test('payloadMissingLocations: campo AUSENTE (el caso real de "no tocó el combo") → faltante', () => {
  const r = Core.payloadMissingLocations(payload([[{ partCount: 10 }], [{ locationId: 3311 }]]));
  assert.equal(r.checked, true);
  assert.equal(r.total, 2);
  assert.deepEqual(r.missing, [{ itemIndex: 0, accountIndex: 0 }]);
});

test('payloadMissingLocations: locationId null explícito → faltante', () => {
  const r = Core.payloadMissingLocations(payload([[{ locationId: null }]]));
  assert.deepEqual(r.missing, [{ itemIndex: 0, accountIndex: 0 }]);
});

test('payloadMissingLocations: varios accounts por item (piezas serializadas) se revisan todos', () => {
  const r = Core.payloadMissingLocations(payload([[{ locationId: 1 }, { locationId: null }, { locationId: 2 }]]));
  assert.equal(r.total, 3);
  assert.deepEqual(r.missing, [{ itemIndex: 0, accountIndex: 1 }]);
});

test('payloadMissingLocations: FAIL-SAFE — forma inesperada no se puede juzgar', () => {
  for (const bad of [undefined, null, {}, { variables: {} },
    { variables: { receiverPayload: {} } },
    { variables: { receiverPayload: { receiverBomItems: [] } } },
    { variables: { receiverPayload: { receiverBomItems: 'x' } } }]) {
    const r = Core.payloadMissingLocations(bad);
    assert.equal(r.checked, false, `no debe juzgar ${JSON.stringify(bad)}`);
    assert.deepEqual(r.missing, []);
  }
});

test('payloadMissingLocations: FAIL-SAFE — items sin debitAccounts no cuentan ni bloquean', () => {
  const r = Core.payloadMissingLocations({
    variables: { receiverPayload: { receiverBomItems: [{ inventoryTransferEvent: {} }, {}] } },
  });
  assert.equal(r.checked, false);
  assert.deepEqual(r.missing, []);
});

test('payloadMissingLocations: item sin accounts junto a otro válido → solo juzga el válido', () => {
  const body = payload([[{ locationId: 3311 }]]);
  body.variables.receiverPayload.receiverBomItems.push({ inventoryTransferEvent: {} });
  const r = Core.payloadMissingLocations(body);
  assert.equal(r.checked, true);
  assert.equal(r.total, 1);
  assert.deepEqual(r.missing, []);
});

test('payloadMissingLocations: accounts con entradas no-objeto se ignoran sin truenar', () => {
  const r = Core.payloadMissingLocations(payload([[null, { locationId: 5 }]]));
  assert.equal(r.checked, true);
  assert.equal(r.total, 1);
  assert.deepEqual(r.missing, []);
});
