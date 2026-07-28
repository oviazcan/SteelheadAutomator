// tools/test/hash-regen-coverage.test.js
// INVARIANTE DE PROCESO: todo hash de `remote/config.json` debe tener ruta de
// regeneración — una ruta de query en route-catalog.json o una entidad centinela en
// sentinels-config.json. Sin ella, cuando Steelhead rote el hash el autopilot no lo
// puede recuperar solo y el applet cae en captura manual con el hash-scanner.
//
// La regla ya estaba escrita en CLAUDE.md ("un hash sin ruta de regeneración es deuda")
// pero nada la verificaba, así que la deuda entraba en silencio: CreateUpdateDeleteRoutes
// —LA mutation del auto-ruteador— vivió sin ruta desde su fase 1 hasta 2026-07-27.
//
// La foto al 2026-07-27 es de 60 hashes huérfanos de 188: las QUERIES están casi
// resueltas (110/119) y el hueco son las MUTATIONS (18/69), porque cada una necesita su
// entidad centinela con captura-y-aborta — trabajo caro por op, no algo que se salde de
// una sentada. Por eso el invariante global es un TRINQUETE: no exige cero, exige que la
// deuda no CREZCA. Un hash nuevo sin ruta rompe la suite; saldar deuda vieja baja el
// número y el test pide actualizar la línea base.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

const cfg = JSON.parse(readFileSync(join(__dirname, '../../remote/config.json'), 'utf8'));
const cat = JSON.parse(readFileSync(join(__dirname, '../hash-autopilot/route-catalog.json'), 'utf8'));
const sen = JSON.parse(readFileSync(join(__dirname, '../hash-autopilot/sentinels-config.json'), 'utf8'));

function opsCubiertas() {
  const set = new Set();
  for (const r of Object.values(cat.routes || {})) {
    for (const op of r.captures || []) set.add(op);
  }
  for (const e of Object.values(sen.entities || {})) {
    for (const op of [...(e._para || []), ...(e.opsGroup || [])]) set.add(op);
  }
  return set;
}

// Línea base del trinquete: hashes sin ruta al 2026-07-27. Si BAJA, actualízala en el
// mismo commit que salda la deuda — así el número solo puede ir hacia abajo.
const HUERFANAS_BASE = 60;

test('las ops del ruteo por grupos tienen ruta de regeneración', () => {
  const cubiertas = opsCubiertas();
  // Las que el applet auto-router-lanes llama de verdad.
  for (const op of ['CreateUpdateDeleteRoutes', 'CreateNewPartGroup',
    'CreateManyPartsTransfersChecked', 'AddPartsToWorkOrders',
    'FindPartGroupQuery', 'WorkOrder', 'StationTreatmentByWorkOrder']) {
    assert.ok(cubiertas.has(op), `${op} no tiene ruta de regeneración (route-catalog ni centinela)`);
  }
});

test('las tres entidades centinela nuevas apuntan a la OT Centinela y abortan', () => {
  for (const k of ['partGroupCreate', 'partsSplitTransfer', 'workOrderRoutes']) {
    const e = sen.entities[k];
    assert.ok(e, `falta la entidad ${k}`);
    assert.equal(e.marker, 'Centinela', `${k} debe exigir el marcador Centinela`);
    assert.equal(e._estrategia, 'capture-abort', `${k} escribe: debe ser capture-abort`);
    assert.ok(Array.isArray(e._para) && e._para.length, `${k} debe declarar su op en _para`);
    assert.ok(e._nota && e._nota.length > 80, `${k} necesita nota que explique el flujo`);
  }
});

test('las entidades capture-abort NUNCA quedan sin el marcador centinela', () => {
  // El abort es la segunda salvaguarda; la primera es que el objeto sea de prueba.
  for (const [k, e] of Object.entries(sen.entities || {})) {
    if (e._estrategia !== 'capture-abort') continue;
    assert.ok(e.marker || /sin objeto (sentinela|centinela)/i.test(e._nota || ''),
      `${k} es capture-abort y no declara marcador ni justifica su ausencia`);
  }
});

function huerfanas() {
  const cubiertas = opsCubiertas();
  const out = [];
  for (const seccion of ['queries', 'mutations']) {
    for (const op of Object.keys(cfg.steelhead.hashes[seccion] || {})) {
      if (!cubiertas.has(op)) out.push(`${seccion}.${op}`);
    }
  }
  return out;
}

test('trinquete: la deuda de hashes sin ruta de regeneración no crece', () => {
  const faltan = huerfanas();
  assert.ok(faltan.length <= HUERFANAS_BASE,
    `La deuda subió de ${HUERFANAS_BASE} a ${faltan.length} hash(es) sin ruta de regeneración.\n` +
    `Sin ella, cuando Steelhead rote el hash el autopilot no lo recupera solo.\n` +
    'Dale una ruta en tools/hash-autopilot/route-catalog.json (queries) o una entidad ' +
    'centinela en sentinels-config.json (mutations; captura-y-aborta si escribe).\n' +
    `Huérfanas actuales:\n  ${faltan.join('\n  ')}`);
});

test('si la deuda bajó, hay que actualizar la línea base en el mismo commit', () => {
  const n = huerfanas().length;
  assert.ok(n >= HUERFANAS_BASE,
    `¡Bajó la deuda de ${HUERFANAS_BASE} a ${n}! Actualiza HUERFANAS_BASE a ${n} ` +
    'para que el trinquete no permita volver atrás.');
});
