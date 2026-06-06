// tools/test/received-order-plant.test.js
// Tabla de verdad de la resolución de planta Schneider desde shipToAddress y del
// veredicto de etiqueta de planta del NP. Fuente de verdad: tools/lib/schneider-plants.js
// (el hook powertools/synced/received-order/received-order.ts transcribe esta lógica).

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHNEIDER_PLANTS, resolvePlant, plantLabelVerdict } = require('../lib/schneider-plants');

// Direcciones reales de Steelhead (capturas 2026-06-06), tal cual el shipToAddress.address.
const REAL = {
  STX: 'Vía Corta Santa Ana Puebla Km 17.5, Acuamanala de Miguel Hidalgo, Tlaxcala,, Tlaxcala, 90860, México',
  SXC: 'FWPR+J7, Tercera Sección Ocotitla, José María Morelos y Pavón,, Tlaxcala, 90434, México',
  SMY: 'Blvd. Escobedo 317, Ciudad Apodaca,, Nuevo León, 66627, México',
  SQ1: 'Vesta Industrial Park Querétaro, Av. Vesta 23 y 25 Edificio VPQ07, Colón,, Querétaro, 76294, México',
  SQ2: 'Carretera Estatal 100 4200 Lote 56, Parque Industrial Aeropuerto, Querétaro,, Querétaro, 76295, México',
  SCM: 'Michoacán 20, Complejo Industrial Tecnológico, Iztapalapa,, CDMX, 09208, México',
  SRG: 'Javier Rojo Gómez 1121-A, Guadalupe del Moral, Iztapalapa,, CDMX, 09300, México',
};
// Direcciones fiscales/billing que NO son plantas de entrega (no deben resolver).
const TRAPS = [
  '5914 San Bernardo, Suite 4-960, Laredo,, Texas, 78041, USA',
  '1415 S. Roselle Road, Palatine,, Illinois, 60067, México',
];

test('resolvePlant: cada dirección real resuelve a su planta', () => {
  for (const code of Object.keys(REAL)) {
    const p = resolvePlant(REAL[code]);
    assert.ok(p, `${code}: no resolvió`);
    assert.equal(p.code, code, `${code}: resolvió a ${p && p.code}`);
  }
});

test('resolvePlant: sin colisiones — cada dirección real matchea exactamente 1 planta', () => {
  for (const code of Object.keys(REAL)) {
    const addr = REAL[code].toLowerCase();
    const matches = SCHNEIDER_PLANTS.filter((p) => p.needles.some((n) => addr.includes(n)));
    assert.equal(matches.length, 1, `${code}: matchea ${matches.map((m) => m.code).join(',')}`);
  }
});

test('resolvePlant: direcciones trampa (fiscales) → null', () => {
  for (const t of TRAPS) assert.equal(resolvePlant(t), null, `trampa resolvió: ${t}`);
});

test('resolvePlant: vacío/null/undefined → null', () => {
  assert.equal(resolvePlant(''), null);
  assert.equal(resolvePlant(null), null);
  assert.equal(resolvePlant(undefined), null);
});

test('plantLabelVerdict: ok cuando trae la planta esperada', () => {
  const r = plantLabelVerdict(['NIQ', 'STX'], 'STX');
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.plantLabels, ['STX']);
});

test('plantLabelVerdict: missing cuando no trae ninguna etiqueta de planta', () => {
  const r = plantLabelVerdict(['NIQ', 'EST'], 'STX');
  assert.equal(r.verdict, 'missing');
  assert.deepEqual(r.plantLabels, []);
});

test('plantLabelVerdict: mismatch cuando trae otra planta', () => {
  const r = plantLabelVerdict(['NIQ', 'SMY'], 'STX');
  assert.equal(r.verdict, 'mismatch');
  assert.deepEqual(r.plantLabels, ['SMY']);
});

test('plantLabelVerdict: multi-planta pasa si la esperada está entre ellas', () => {
  assert.equal(plantLabelVerdict(['STX', 'SMY'], 'SMY').verdict, 'ok');
});

test('plantLabelVerdict: labels null/undefined → missing', () => {
  assert.equal(plantLabelVerdict(null, 'STX').verdict, 'missing');
  assert.equal(plantLabelVerdict(undefined, 'STX').verdict, 'missing');
});
