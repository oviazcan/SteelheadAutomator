// tools/test/price-confirm-core.test.js
// Golden tests del módulo puro del Candado de Confirmación de Precio.
// Run: node --test tools/test/price-confirm-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/price-confirm-core.js');

// Fixture: payload real de SaveManyPartNumberPrices (modal nativo "Part Number Price"),
// capturado del hash-scanner 2026-07-01. Una línea, sin divisa (DatosPrecio vacío), unitId null.
const REAL_VARS = {
  input: {
    quoteId: null,
    partNumberPrices: [
      {
        partNumberId: 3235631,
        processId: 213861,
        customInputs: { DatosPrecio: {} },
        partNumberPriceLineItems: [
          { title: 'Plateado - FAKE PART OMAR', price: 1, productId: 14506, quoteInventoryItemId: null },
        ],
        unitId: null,
        priceName: '',
        isDefaultPartNumberPrice: true,
      },
    ],
  },
};

// ---------- extractLines ----------

test('extractLines: payload real → 1 línea con precio, divisa vacía, unitId null', () => {
  const lines = Core.extractLines(REAL_VARS);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    ppIndex: 0,
    liIndex: 0,
    partNumberId: 3235631,
    title: 'Plateado - FAKE PART OMAR',
    price: 1,
    divisa: '',
    unitId: null,
    priceName: '',
  });
});

test('extractLines: divisa se lee de customInputs.DatosPrecio.Divisa', () => {
  const vars = {
    input: {
      partNumberPrices: [
        {
          partNumberId: 10,
          customInputs: { DatosPrecio: { Divisa: 'USD' } },
          partNumberPriceLineItems: [{ title: 'A', price: 5 }],
          unitId: 3969,
          priceName: 'Lista',
        },
      ],
    },
  };
  const lines = Core.extractLines(vars);
  assert.equal(lines[0].divisa, 'USD');
  assert.equal(lines[0].unitId, 3969);
  assert.equal(lines[0].priceName, 'Lista');
});

test('extractLines: múltiples partNumberPrices y múltiples lineItems → una fila por lineItem, en orden', () => {
  const vars = {
    input: {
      partNumberPrices: [
        {
          partNumberId: 1,
          customInputs: { DatosPrecio: { Divisa: 'MXN' } },
          partNumberPriceLineItems: [
            { title: 'L1', price: 10 },
            { title: 'L2', price: 20 },
          ],
          unitId: null,
        },
        {
          partNumberId: 2,
          customInputs: { DatosPrecio: { Divisa: 'USD' } },
          partNumberPriceLineItems: [{ title: 'L3', price: 30 }],
          unitId: 3972,
        },
      ],
    },
  };
  const lines = Core.extractLines(vars);
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => [l.ppIndex, l.liIndex, l.partNumberId, l.title, l.price, l.divisa, l.unitId]),
    [
      [0, 0, 1, 'L1', 10, 'MXN', null],
      [0, 1, 1, 'L2', 20, 'MXN', null],
      [1, 0, 2, 'L3', 30, 'USD', 3972],
    ]
  );
});

test('extractLines: customInputs / DatosPrecio ausente → divisa vacía', () => {
  const vars = {
    input: { partNumberPrices: [{ partNumberId: 7, partNumberPriceLineItems: [{ title: 'X', price: 3 }] }] },
  };
  assert.equal(Core.extractLines(vars)[0].divisa, '');
});

test('extractLines: sin input / sin partNumberPrices / sin lineItems → []', () => {
  assert.deepEqual(Core.extractLines(undefined), []);
  assert.deepEqual(Core.extractLines({}), []);
  assert.deepEqual(Core.extractLines({ input: {} }), []);
  assert.deepEqual(Core.extractLines({ input: { partNumberPrices: [] } }), []);
  assert.deepEqual(
    Core.extractLines({ input: { partNumberPrices: [{ partNumberId: 1, partNumberPriceLineItems: [] }] } }),
    []
  );
});

// ---------- hasDivisa ----------

test('hasDivisa: USD/MXN → true; vacío/espacios/ausente → false', () => {
  assert.equal(Core.hasDivisa({ divisa: 'USD' }), true);
  assert.equal(Core.hasDivisa({ divisa: 'MXN' }), true);
  assert.equal(Core.hasDivisa({ divisa: '' }), false);
  assert.equal(Core.hasDivisa({ divisa: '   ' }), false);
  assert.equal(Core.hasDivisa({}), false);
});

// ---------- pricesMatch ----------

test('pricesMatch: mismo valor numérico (1 == "1" == "1.00")', () => {
  assert.equal(Core.pricesMatch(1, '1'), true);
  assert.equal(Core.pricesMatch(1, '1.00'), true);
  assert.equal(Core.pricesMatch(1, ' 1 '), true);
  assert.equal(Core.pricesMatch(10.5, '10.50'), true);
  assert.equal(Core.pricesMatch(0, '0'), true);
});

test('pricesMatch: valores distintos → false', () => {
  assert.equal(Core.pricesMatch(1, '1.5'), false);
  assert.equal(Core.pricesMatch(1, '2'), false);
});

test('pricesMatch: reconfirmación vacía o no numérica → false (aunque original sea 0)', () => {
  assert.equal(Core.pricesMatch(1, ''), false);
  assert.equal(Core.pricesMatch(0, ''), false);
  assert.equal(Core.pricesMatch(1, '   '), false);
  assert.equal(Core.pricesMatch(1, 'abc'), false);
});

test('pricesMatch: coma decimal NO se interpreta (input usa punto) → false', () => {
  assert.equal(Core.pricesMatch(1.5, '1,5'), false);
});

// ---------- perPieceEquivalent ----------

test('perPieceEquivalent: price × factor', () => {
  assert.equal(Core.perPieceEquivalent(10, 0.5), 5);
  assert.equal(Core.perPieceEquivalent(2.5, 4), 10);
});

test('perPieceEquivalent: factor inválido (0/neg/NaN/null) → null', () => {
  assert.equal(Core.perPieceEquivalent(10, 0), null);
  assert.equal(Core.perPieceEquivalent(10, -1), null);
  assert.equal(Core.perPieceEquivalent(10, NaN), null);
  assert.equal(Core.perPieceEquivalent(10, null), null);
  assert.equal(Core.perPieceEquivalent(10, undefined), null);
});

test('perPieceEquivalent: price inválido → null', () => {
  assert.equal(Core.perPieceEquivalent(NaN, 0.5), null);
  assert.equal(Core.perPieceEquivalent(null, 0.5), null);
});

// El guard le pasa los valores crudos de los inputs (strings). Contrato consumido por la UI:
test('perPieceEquivalent: acepta strings; vacío/no-numérico → null', () => {
  assert.equal(Core.perPieceEquivalent('5', '0.5'), 2.5);
  assert.equal(Core.perPieceEquivalent('', '0.5'), null);
  assert.equal(Core.perPieceEquivalent('5', ''), null);
  assert.equal(Core.perPieceEquivalent('abc', '0.5'), null);
});

// ---------- unitLabel / isPerPiece / UNIT_BY_ID ----------

test('UNIT_BY_ID: mapa espejo de PRICE_UNIT_MAP de bulk-upload', () => {
  assert.equal(Core.UNIT_BY_ID[3969], 'KGM');
  assert.equal(Core.UNIT_BY_ID[3972], 'LBR');
  assert.equal(Core.UNIT_BY_ID[5150], 'LM');
  assert.equal(Core.UNIT_BY_ID[4907], 'CMK');
  assert.equal(Core.UNIT_BY_ID[4797], 'FTK');
  assert.equal(Core.UNIT_BY_ID[5348], 'LO');
});

test('unitLabel: null → "pieza"; id conocido → código; desconocido → "unidad #id"', () => {
  assert.equal(Core.unitLabel(null), 'pieza');
  assert.equal(Core.unitLabel(undefined), 'pieza');
  assert.equal(Core.unitLabel(3969), 'KGM');
  assert.equal(Core.unitLabel(4797), 'FTK');
  assert.equal(Core.unitLabel(12345), 'unidad #12345');
});

test('isPerPiece: null/undefined → true; id → false', () => {
  assert.equal(Core.isPerPiece(null), true);
  assert.equal(Core.isPerPiece(undefined), true);
  assert.equal(Core.isPerPiece(3969), false);
});

// ---------- parsing del factor desde el DOM (Panel A / tabla Units) ----------

test('unitCodeFromLabel: primer token en mayúsculas', () => {
  assert.equal(Core.unitCodeFromLabel('KGM Kilogramo / Part:'), 'KGM');
  assert.equal(Core.unitCodeFromLabel('  lbr Libra / Part: '), 'LBR');
  assert.equal(Core.unitCodeFromLabel('1 KGM Kilogramos / part'), '1'); // tabla: primer token es el número
  assert.equal(Core.unitCodeFromLabel(''), '');
});

test('isPerPartLabel: detecta labels que terminan en "/ Part:" (Panel A)', () => {
  assert.equal(Core.isPerPartLabel('KGM Kilogramo / Part:'), true);
  assert.equal(Core.isPerPartLabel('CMK Centímetro Cuadrado / Part:'), true);
  assert.equal(Core.isPerPartLabel('FOT ft Pie / Part:'), true);
  assert.equal(Core.isPerPartLabel('KGM Kilogramo / Part'), true);
  assert.equal(Core.isPerPartLabel('Per Part Count Unit Definitions:'), false);
  assert.equal(Core.isPerPartLabel('1 KGM Kilogramos / part'), true); // ojo: la tabla usa "/ part" también
  assert.equal(Core.isPerPartLabel(''), false);
});

test('parseLeadingNumber: primer número del texto (tabla Units / input value)', () => {
  assert.equal(Core.parseLeadingNumber('1 KGM Kilogramos / part'), 1);
  assert.equal(Core.parseLeadingNumber('200 CMK Centímetro Cuadrados / part'), 200);
  assert.equal(Core.parseLeadingNumber('0.5'), 0.5);
  assert.equal(Core.parseLeadingNumber('  1.1023  '), 1.1023);
  assert.equal(Core.parseLeadingNumber(''), null);
  assert.equal(Core.parseLeadingNumber('abc'), null);
  assert.equal(Core.parseLeadingNumber(null), null);
});

// ---------- buildEquivalences: precio convertido a todas las unidades disponibles ----------

test('buildEquivalences: precio por kg → pieza y demás unidades', () => {
  // precio 2 USD/kg, factor KGM=0.5 kg/pza, CMK=200 cm²/pza
  const out = Core.buildEquivalences({
    price: 2, priceUnitCode: 'KGM', priceUnitFactor: 0.5,
    factorsByCode: { KGM: 0.5, CMK: 200 },
  });
  // precio por pieza = 2 × 0.5 = 1
  assert.deepEqual(out, [
    { code: 'pieza', unitPrice: 1, isPriceUnit: false },
    { code: 'KGM', unitPrice: 2, isPriceUnit: true },     // 1 / 0.5 = 2 (== precio capturado)
    { code: 'CMK', unitPrice: 0.005, isPriceUnit: false }, // 1 / 200
  ]);
});

test('buildEquivalences: precio por pieza → convierte al resto', () => {
  const out = Core.buildEquivalences({
    price: 1, priceUnitCode: 'pieza', priceUnitFactor: 1,
    factorsByCode: { KGM: 0.5 },
  });
  assert.deepEqual(out, [
    { code: 'pieza', unitPrice: 1, isPriceUnit: true },
    { code: 'KGM', unitPrice: 2, isPriceUnit: false }, // 1 / 0.5
  ]);
});

test('buildEquivalences: la unidad del precio no se duplica (está en factorsByCode)', () => {
  const out = Core.buildEquivalences({
    price: 4, priceUnitCode: 'CMK', priceUnitFactor: 200,
    factorsByCode: { CMK: 200 },
  });
  // ppp = 4 × 200 = 800; pieza=800; CMK = 800/200 = 4 (== precio)
  assert.deepEqual(out, [
    { code: 'pieza', unitPrice: 800, isPriceUnit: false },
    { code: 'CMK', unitPrice: 4, isPriceUnit: true },
  ]);
});

test('buildEquivalences: factores inválidos en el mapa se omiten (no la unidad válida)', () => {
  const out = Core.buildEquivalences({
    price: 1, priceUnitCode: 'pieza', priceUnitFactor: 1,
    factorsByCode: { KGM: 0.5, DMK: 0, FTK: NaN },
  });
  assert.deepEqual(out, [
    { code: 'pieza', unitPrice: 1, isPriceUnit: true },
    { code: 'KGM', unitPrice: 2, isPriceUnit: false },
  ]);
});

test('buildEquivalences: precio/factor inválido → []', () => {
  assert.deepEqual(Core.buildEquivalences({ price: '', priceUnitCode: 'KGM', priceUnitFactor: 0.5, factorsByCode: {} }), []);
  assert.deepEqual(Core.buildEquivalences({ price: 2, priceUnitCode: 'KGM', priceUnitFactor: 0, factorsByCode: {} }), []);
  assert.deepEqual(Core.buildEquivalences({ price: 2, priceUnitCode: 'KGM', priceUnitFactor: null, factorsByCode: {} }), []);
});

test('buildEquivalences: sin factores extra → solo pieza', () => {
  const out = Core.buildEquivalences({ price: 3, priceUnitCode: 'pieza', priceUnitFactor: 1, factorsByCode: {} });
  assert.deepEqual(out, [{ code: 'pieza', unitPrice: 3, isPriceUnit: true }]);
});
