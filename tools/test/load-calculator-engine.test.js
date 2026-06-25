// tools/test/load-calculator-engine.test.js
//
// Golden tests del motor PURO de la Calculadora de Piezas por Carga (`load-calculator`).
// El motor no toca DOM ni API: se carga directo con require() (patrón F1 de bulk-upload,
// módulo puro dual-export browser/Node).
//
// Los valores golden vienen del `Calculo.xlsx` real de ingeniería (cacheados en el plan
// 2026-06-24-load-calculator.md). Geometría de referencia:
//   - Tina (cuadrícula): 1.7 m × 0.9 m, separación 2 in entre piezas (col y fila).
//   - Pantalla (área):   90 cm × 170 cm, factor 1.5  →  areaEfectiva = 229.5 dm².
//
// Orientación de cuadrícula: lado LARGO de tina × lado CORTO de pieza = columnas;
// lado CORTO de tina × lado LARGO de pieza = filas. (Reproduce 87/112/112; la otra
// orientación daría 90 — ver nota del plan.)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const E = require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'load-calculator-engine.js'));

// Geometría compartida
const TANK_W_IN = E.mToIn(1.7);   // 66.929 in
const TANK_D_IN = E.mToIn(0.9);   // 35.433 in
const SEP = 2;                     // in

// Cada pieza: dims en pulgadas (ancho × largo) + área en cm² + golden esperados.
const PIEZAS = [
  { name: '31104868001', w: 0.25,  l: 8.66, area_cm2: 487.805, grid: 87,  area: 47  },
  { name: 'HB_P5778',     w: 0.375, l: 5.75, area_cm2: 185.807, grid: 112, area: 123 },
  { name: 'P6028',        w: 0.375, l: 6.75, area_cm2: 216.532, grid: 112, area: 105 },
];

test('mToIn convierte metros a pulgadas', () => {
  assert.ok(Math.abs(E.mToIn(1.7) - 66.9291) < 1e-3);
  assert.ok(Math.abs(E.mToIn(0.9) - 35.4331) < 1e-3);
});

test('gridPieces reproduce los golden de cuadrícula del Calculo.xlsx', () => {
  for (const p of PIEZAS) {
    const r = E.gridPieces({
      tankW_in: TANK_W_IN, tankD_in: TANK_D_IN,
      pieceL_in: p.l, pieceW_in: p.w,
      sepCol_in: SEP, sepRow_in: SEP,
    });
    assert.equal(r.piezasPorCarga, p.grid, `${p.name}: cuadrícula esperaba ${p.grid}, dio ${r.piezasPorCarga} (${r.columnas}×${r.filas})`);
  }
});

test('gridPieces es invariante a cuál dimensión se pase primero (normaliza largo/corto)', () => {
  const a = E.gridPieces({ tankW_in: TANK_W_IN, tankD_in: TANK_D_IN, pieceL_in: 8.66, pieceW_in: 0.25, sepCol_in: SEP, sepRow_in: SEP });
  const b = E.gridPieces({ tankW_in: TANK_D_IN, tankD_in: TANK_W_IN, pieceL_in: 0.25, pieceW_in: 8.66, sepCol_in: SEP, sepRow_in: SEP });
  assert.equal(a.piezasPorCarga, b.piezasPorCarga);
  assert.equal(a.piezasPorCarga, 87);
});

test('areaPieces reproduce los golden de área del Calculo.xlsx', () => {
  for (const p of PIEZAS) {
    const r = E.areaPieces({ tankL_cm: 170, tankW_cm: 90, factor: 1.5, pieceArea_cm2: p.area_cm2 });
    assert.equal(r.piezasPorCarga, p.area, `${p.name}: área esperaba ${p.area}, dio ${r.piezasPorCarga}`);
  }
});

test('areaPieces expone areaEfectiva = 229.5 dm² para la pantalla 90×170 factor 1.5', () => {
  const r = E.areaPieces({ tankL_cm: 170, tankW_cm: 90, factor: 1.5, pieceArea_cm2: 100 });
  assert.equal(r.areaTina_dm2, 153);
  assert.equal(r.areaEfectiva, 229.5);
});

test('barrelPieces = FLOOR(capacidad_DMK / area_pieza_dm2)', () => {
  // 600 DMK / 1.85807 dm² = 322.92 → 322
  const r = E.barrelPieces({ capacityDMK: 600, pieceArea_cm2: 185.807 });
  assert.equal(r.piezasPorCarga, 322);
});

test('decideMode cubre los 5 casos de CAT_Líneas', () => {
  assert.equal(E.decideMode({ lineType: 'Rack' }), 'RACK');
  assert.equal(E.decideMode({ lineType: 'Barril' }), 'BARRIL');
  assert.equal(E.decideMode({ lineType: 'Célula' }), 'NINGUNO');
  assert.equal(E.decideMode({ lineType: 'Híbrida', priceUnit: 'PZA' }), 'RACK');
  assert.equal(E.decideMode({ lineType: 'Híbrida', priceUnit: 'KG' }), 'BARRIL');
});

test('loadsPerHour = (60/ciclo) × estaciones × OEE', () => {
  assert.equal(E.loadsPerHour({ cycleMin: 30, stations: 4, oee: 1 }), 8);
  assert.equal(E.loadsPerHour({ cycleMin: 0, stations: 4, oee: 1 }), 0); // guard ciclo inválido
});
