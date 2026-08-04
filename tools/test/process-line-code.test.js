// Caracterización de la identificación de línea en process-shared / process-canon.
//
// POR QUÉ NACE ESTE ARCHIVO (2026-08-04): al alinear la regla "TX00 es un ÁREA" con el filtro del
// board y el auto-ruteador, se descubrió que estos módulos —que MUTAN árboles de proceso en el ERP
// productivo— no tenían NINGÚN test. Y tienen una trampa específica: el repo ya modela los TX00
// aquí, pero con la semántica CONTRARIA.
//
// LAS DOS SEMÁNTICAS DE TX00, que conviene no volver a confundir:
//   · En el FILTRO del board y en el RUTEADOR, TX00 es un ÁREA y lo que importa es DISTINGUIR sus
//     células: T300-CE03 Antitarnish ≠ T300-CE05 Limpieza Especial son destinos rivales.
//   · Aquí, en PROCESOS, TX00 es un SATÉLITE — un paso auxiliar por el que el material PASA — y lo
//     que importa es DESCARTARLO para quedarse con la línea real: getLineCode de
//     "T300 (LES)-T204 (PLA)-CU/BR-VARIOS (16.1)" es T204, no T300. El canon lo dice explícito
//     (process-canon.js:609): un proceso satélite se corta con "no aplica canon".
//
// Las dos son correctas y NO se contradicen: una pregunta "¿a cuál de las células va el material?"
// y la otra "¿de qué línea es este proceso?". Lo que sí se rompería es aplicar la primera y dejar
// que la familia deje de reconocerse como satélite — por eso SATELLITE_REGEX acepta ahora el
// sufijo de célula, y por eso este archivo lo fija.
//
// Run: node --test tools/test/process-line-code.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const R = (f) => path.join(__dirname, '..', '..', 'remote', 'scripts', f);

global.window = {};
// process-shared imprime un log de carga; se silencia para no ensuciar la salida del runner.
const _log = console.log;
console.log = () => {};
require(R('process-shared.js'));
console.log = _log;
const PS = global.window.ProcessShared;

// ── extractLineCodeFromName ───────────────────────────────────────────────
test('extractLineCodeFromName: TX00 lleva el segundo segmento (célula del satélite)', () => {
  assert.strictEqual(PS.extractLineCodeFromName('T300-CE03 Antitarnish'), 'T300-CE03');
  assert.strictEqual(PS.extractLineCodeFromName('T300-CE05 Limpiando Especial'), 'T300-CE05');
  assert.strictEqual(PS.extractLineCodeFromName('T100-SA01 Sandblasteando Sílico'), 'T100-SA01');
});

test('extractLineCodeFromName: una LÍNEA real NO se parte', () => {
  assert.strictEqual(PS.extractLineCodeFromName('T204 (PLA)-CU/BR-VARIOS'), 'T204');
  assert.strictEqual(PS.extractLineCodeFromName('T102 Inspeccionando y Empacando'), 'T102');
  assert.strictEqual(PS.extractLineCodeFromName('T101-EN00-001 Enracado'), 'T101');
});

test('extractLineCodeFromName: sin guion PEGADO no hay segundo segmento', () => {
  // El caso REAL que lo exige: los nombres de proceso llevan el acabado entre paréntesis, y el
  // guion viene DESPUÉS. Sin la condición, "T300 (ANT)-CU-VARIOS" daría "T300-CU".
  assert.strictEqual(PS.extractLineCodeFromName('T300 (ANT)-CU-VARIOS (20.0)'), 'T300');
  assert.strictEqual(PS.extractLineCodeFromName('T100 (LMC)-CU/BR-VARIOS (4.0)'), 'T100');
});

test('extractLineCodeFromName: los globales SP siguen sin código (anclado al inicio)', () => {
  assert.strictEqual(PS.extractLineCodeFromName('SP T300-CE05 Limpieza Especial'), null);
  assert.strictEqual(PS.extractLineCodeFromName('SP Inspección Recibo'), null);
});

// ── isSatelliteCode: la familia TX00 NO se pierde al partirse ─────────────
// Este es el test que impide que el cambio de arriba se vuelva una regresión silenciosa: si
// SATELLITE_REGEX siguiera siendo /^[TM]\d+00$/, un T300-CE03 dejaría de ser satélite y el canon
// dejaría de cortarlo con "no aplica canon".
test('isSatelliteCode: una célula de satélite SIGUE siendo satélite', () => {
  for (const c of ['T100', 'T200', 'T300', 'T400', 'T500', 'T000']) {
    assert.ok(PS.isSatelliteCode(c), `${c} debe ser satélite`);
  }
  for (const c of ['T300-CE03', 'T300-CE05', 'T100-SA01', 'T000-SPR', 'T400-CE03']) {
    assert.ok(PS.isSatelliteCode(c), `${c} debe seguir siendo satélite`);
  }
});

test('isSatelliteCode: una línea real NUNCA es satélite, ni con sufijo', () => {
  for (const c of ['T101', 'T102', 'T204', 'T205', 'T301', 'T401', 'T501', 'T204-LI', 'T401-CE01']) {
    assert.ok(!PS.isSatelliteCode(c), `${c} NO debe ser satélite`);
  }
});

test('isSatelliteCode: entradas basura no truenan ni afirman', () => {
  for (const c of [null, undefined, '', 'Proquipa.N1.A1', 42]) {
    assert.ok(!PS.isSatelliteCode(c), `${String(c)} NO debe ser satélite`);
  }
});

test('pipeline REAL de process-deep-audit: nombre → código → ¿es satélite?', () => {
  // Éste es el sitio donde la regresión habría mordido de verdad (process-deep-audit.js:113-116):
  //   const code = ps().extractLineCodeFromName(p.name); if (code && ps().isSatelliteCode(code))
  // es el DESCUBRIMIENTO de procesos satélite. Encadena las dos funciones, así que partir los TX00
  // sin ampliar SATELLITE_REGEX habría dejado de descubrir "T300-CE03 Antitarnish" — en silencio.
  const descubre = (nombre) => {
    const code = PS.extractLineCodeFromName(nombre);
    return !!(code && PS.isSatelliteCode(code));
  };
  for (const n of ['T300-CE03 Antitarnish', 'T300-CE05 Limpiando Especial',
    'T100-SA01 Sandblasteando Sílico', 'T300 (ANT)-CU-VARIOS (20.0)', 'T400 (ANT)-CU-VARIOS (20.0)']) {
    assert.ok(descubre(n), `debe descubrirse como satélite: ${n}`);
  }
  for (const n of ['T204 (PLA)-CU/BR-VARIOS', 'T102 Inspeccionando y Empacando', 'T401 (EBT)-CU-VARIOS (30.0)']) {
    assert.ok(!descubre(n), `NO debe descubrirse como satélite: ${n}`);
  }
});

test('isExcludedLineCode: satélites (con o sin célula) y T401 quedan fuera del canon', () => {
  assert.ok(PS.isExcludedLineCode('T300'));
  assert.ok(PS.isExcludedLineCode('T300-CE03'));
  assert.ok(PS.isExcludedLineCode('T401'));
  assert.ok(!PS.isExcludedLineCode('T204'));
});

// ── getLineCode: NO se mueve (usa su propio regex, no extractLineCodeFromName) ──
// Es la función que decide de qué línea es un PROCESO, y su respuesta correcta para un nombre que
// menciona un satélite es la LÍNEA REAL. Se fija aquí porque es lo que el cambio no podía tocar.
test('getLineCode: el satélite se DESCARTA y gana la línea real', () => {
  assert.strictEqual(PS.getLineCode('T300 (LES)-T204 (PLA)-CU/BR-VARIOS (16.1)'), 'T204');
  assert.strictEqual(PS.getLineCode('T300 (LES)-T110 (PLA)-T300 (ANT)-CU-VARIOS (26.0)'), 'T110');
  assert.strictEqual(PS.getLineCode('T401 (EMT)-T205 (PLA)-T300 (ANT)-CU-VARIOS (16.3)'), 'T205');
});

test('getLineCode: un proceso que SOLO es satélite devuelve el satélite (y el canon lo corta)', () => {
  assert.strictEqual(PS.getLineCode('T300 (ANT)-CU-VARIOS (20.0)'), 'T300');
  assert.ok(PS.isExcludedLineCode(PS.getLineCode('T300 (ANT)-CU-VARIOS (20.0)')));
});

// ── detectLineSections ────────────────────────────────────────────────────
test('detectLineSections: bloques consecutivos por línea, el global SP corta', () => {
  const top = [
    { name: 'SP Inspección Recibo' },
    { name: 'T101 Enracando' },
    { name: 'T101 Listo para Procesar' },
    { name: 'T101 Secando' },
    { name: 'T108 Enracando' },
    { name: 'T108 Listo para Procesar' },
    { name: 'SP Embarque en Almacén' }
  ];
  const s = PS.detectLineSections(top);
  assert.deepStrictEqual(s.map((x) => x.lineCode), ['T101', 'T108']);
  assert.ok(s[0].listoNode && /listo/i.test(s[0].listoNode.name));
  assert.strictEqual(s[0].blockNodes.length, 3);
});

test('detectLineSections: dos CÉLULAS del mismo satélite ya son secciones distintas', () => {
  // Cambio observable de esta tanda: antes ambas caían en una sola sección "T300", que es
  // justamente la confusión que se vino a corregir — son procesos auxiliares distintos.
  const s = PS.detectLineSections([
    { name: 'T300-CE05 Limpiando Especial' },
    { name: 'T300-CE03 Antitarnish' }
  ]);
  assert.deepStrictEqual(s.map((x) => x.lineCode), ['T300-CE05', 'T300-CE03']);
});

test('detectLineSections: entradas vacías o no-array → []', () => {
  assert.deepStrictEqual(PS.detectLineSections([]), []);
  assert.deepStrictEqual(PS.detectLineSections(null), []);
  assert.deepStrictEqual(PS.detectLineSections('nope'), []);
});

// ── paridad de la copia en process-canon ─────────────────────────────────
// process-canon re-implementa extractLineCodeFromName e isSatelliteCode (no las importa de PS).
// Se cargan ambos módulos y se comparan: dos copias de una decisión que derivan en silencio es el
// molde exacto del incidente del anclaje del modal de recepción.
test('paridad: process-canon aplica las MISMAS reglas que process-shared', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(R('process-canon.js'), 'utf8');
  // Se extraen las dos funciones del fuente en vez de cargar el módulo entero: process-canon
  // toca window/API en su cuerpo y no es requerible en aislamiento.
  const mExtract = src.match(/function extractLineCodeFromName\(name\)\s*\{[\s\S]*?\n  \}/);
  const mSat = src.match(/function isSatelliteCode\(code\)\s*\{[^}]*\}/);
  assert.ok(mExtract, 'no encontré extractLineCodeFromName en process-canon.js');
  assert.ok(mSat, 'no encontré isSatelliteCode en process-canon.js');
  const canon = new Function(`${mExtract[0]}\n${mSat[0]}\nreturn { extractLineCodeFromName, isSatelliteCode };`)();

  const CASOS = ['T300-CE03 Antitarnish', 'T300-CE05 Limpiando Especial', 'T100-SA01 Sandblasteando Sílico',
    'T300 (ANT)-CU-VARIOS (20.0)', 'T204 (PLA)-CU/BR-VARIOS', 'T102 Inspeccionando y Empacando',
    'SP T300-CE05 Limpieza Especial', 'T101-EN00-001 Enracado'];
  for (const c of CASOS) {
    assert.strictEqual(canon.extractLineCodeFromName(c), PS.extractLineCodeFromName(c),
      `extractLineCodeFromName DIVERGE en "${c}"`);
  }
  for (const c of ['T300', 'T300-CE03', 'T100-SA01', 'T204', 'T401', 'T204-LI']) {
    assert.strictEqual(canon.isSatelliteCode(c), PS.isSatelliteCode(c), `isSatelliteCode DIVERGE en "${c}"`);
  }
});
