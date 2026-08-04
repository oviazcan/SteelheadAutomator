// Paridad de la regla "TX00 es un ÁREA, no una línea" entre sus DOS implementaciones:
//   · surtido-guard-filter-core.lineCodeFromStationText  (filtro por línea destino del board)
//   · auto-router-engine.extractLineCode                 (motor de ruteo)
//
// POR QUÉ EXISTE ESTE ARCHIVO: la regla de dominio es una sola —las líneas de producción son
// T101…T120, T201…T208, T301, T302, T401, T501 y ninguna termina en 00; T000/T100/T200/T300/
// T400/T500 son áreas que agrupan destinos sin relación— pero vive en dos lugares porque los
// regex BASE difieren por buenas razones: el del motor está anclado al inicio y acepta
// T\d{2,4}|M\d{2,4}; el del filtro no ancla, porque la celda del board trae el prefijo inglés
// "at ". Unificarlos cambiaría el comportamiento de ambos.
//
// El repo ya pagó el precio de dos copias de la misma decisión: receiver-date-override y
// warehouse-location-prefill tenían cada uno su copia del anclaje del modal de recepción y por
// eso se rompieron IGUAL, en silencio y el mismo día. Aquí la duplicación se acepta, pero se ATA:
// si alguien toca una y no la otra, este archivo se pone rojo. Mismo patrón que el test gemelo de
// `isStaleNode` (pn-specs-column-core / wo-schedule-core).
//
// Run: node --test tools/test/line-code-area-parity.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const R = (f) => path.join(__dirname, '..', '..', 'remote', 'scripts', f);

global.window = {};
require(R('surtido-guard-filter-core.js'));
const Filter = global.window.SurtidoGuardFilterCore;

const Engine = require(R('auto-router-engine.js'));

// Nombres de estación bien formados (empiezan con el código), que es el terreno donde las dos
// funciones DEBEN coincidir. Fuera de ahí divergen a propósito: el filtro tolera el prefijo "at ".
const CASOS = [
  // ── áreas: el destino es el segundo segmento ──
  ['T300-CE03-002 Célula de Antitarnish', 'T300-CE03'],
  ['T300-CE05-001 Célula de Limpieza Especial', 'T300-CE05'],
  ['T300-IC00-001 Inspección y Empaque', 'T300-IC00'],
  ['T100-SA01-001 Sandblast Sílico', 'T100-SA01'],
  ['T100-IC00-001 Inspección y Empaque', 'T100-IC00'],
  ['T100-HO01-001 Horno', 'T100-HO01'],
  ['T000-SPR-001 Surtimiento de Producción', 'T000-SPR'],
  ['T000-MA00-001 Maquila de Tratamiento Térmico Tetia', 'T000-MA00'],
  ['T000-VC01-001 Durastar 4400 - LH35421', 'T000-VC01'],
  ['T200-CE06-001 Célula', 'T200-CE06'],
  ['T400-CE03-001 Célula de Antitarnish', 'T400-CE03'],
  ['T500-CE04-001 Célula de Ensamble de Kits', 'T500-CE04'],
  // ── líneas reales: el código base basta, sus pasos NO la parten ──
  ['T204-LI Plata y Estaño s/Cobre Colgado (16.1)', 'T204'],
  ['T205-TI00-019 Enjuague', 'T205'],
  ['T101-EN00-001 Enracado', 'T101'],
  ['T103-SE00-001 Secado Manual y Desenracado', 'T103'],
  ['T401-CE01-005 Célula de Inspección y Empaque (Epóxico)', 'T401'],
  ['T501-BS01-001 algo', 'T501'],
  // ── degradaciones: antes inventar un destino, quedarse con el área ──
  ['T100 (LMC)-CU/BR-VARIOS (4.0)', 'T100'],
  ['T100 Horneado Deshidrogenado', 'T100'],
  ['T300', 'T300'],
  ['T300- algo', 'T300']
];

test('paridad: las DOS implementaciones dan el mismo código para el mismo nombre', () => {
  for (const [name, esperado] of CASOS) {
    const f = Filter.lineCodeFromStationText(name);
    const e = Engine.extractLineCode(name);
    assert.strictEqual(f, esperado, `filtro: ${name}`);
    assert.strictEqual(e, esperado, `motor: ${name}`);
    assert.strictEqual(f, e, `DIVERGEN en "${name}": filtro=${f} motor=${e}`);
  }
});

test('paridad: la regla de área NO se aplica fuera de letra + 3 dígitos', () => {
  // La evidencia medida es sobre T?00; un T20 o un T3000 hipotéticos NO entran a la regla.
  // Aquí las dos funciones divergen A PROPÓSITO en el reconocimiento del código base, y por eso
  // se afirma la propiedad —"ninguna añade segundo segmento"— y no la igualdad:
  //   · el filtro exige letra + 3 dígitos exactos (\b a ambos lados) ⇒ T3000/T20 → null. Correcto:
  //     lee una celda de la tarjeta y no debe inventar un código donde no reconoce uno.
  //   · el motor acepta T\d{2,4} ⇒ devuelve T3000/T20 tal cual. También correcto: lee nombres de
  //     station ya validados y su regex está anclado al inicio.
  // Lo que NINGUNA puede hacer es partirlos como si fueran áreas.
  for (const raro of ['T3000-CE01-001 x', 'T20-AB01-001 x']) {
    const f = Filter.lineCodeFromStationText(raro);
    const e = Engine.extractLineCode(raro);
    assert.ok(f === null || !f.includes('-'), `filtro aplicó la regla de área a ${raro}: ${f}`);
    assert.ok(e === null || !e.includes('-'), `motor aplicó la regla de área a ${raro}: ${e}`);
  }
  assert.strictEqual(Engine.extractLineCode('T3000-CE01-001 x'), 'T3000');
  assert.strictEqual(Engine.extractLineCode('T20-AB01-001 x'), 'T20');
  assert.strictEqual(Filter.lineCodeFromStationText('T3000-CE01-001 x'), null);
});

test('paridad: ninguna de las 28 líneas de nivel-LI cae en la regla de área', () => {
  // Catálogo real de stations "-LI" (AllStations, documentado en docs/applets/auto-router.md).
  // Es la premisa que sostiene TODA la regla: si alguna terminara en 00, partirla rompería el
  // ruteo. Se fija aquí para que el día que aparezca una línea T?00 el test lo grite.
  const LINEAS = ['T101', 'T102', 'T103', 'T104', 'T105', 'T106', 'T107', 'T108', 'T109', 'T110',
    'T111', 'T112', 'T113', 'T114', 'T115', 'T116', 'T117', 'T201', 'T202', 'T203', 'T204',
    'T205', 'T206', 'T207', 'T301', 'T302', 'T401'];
  for (const L of LINEAS) {
    const name = `${L}-LI Nombre de la línea`;
    assert.strictEqual(Filter.lineCodeFromStationText(name), L, `filtro partió ${L}`);
    assert.strictEqual(Engine.extractLineCode(name), L, `motor partió ${L}`);
  }
});
