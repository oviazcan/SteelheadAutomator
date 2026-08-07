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
// La foto al 2026-07-28 es de 59 hashes huérfanos: las QUERIES están casi
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
// 2026-08-05 (Nivel B, rotación masiva): 59→58 al darle ruta a GetPartNumber.
//
// OJO con lo que este número mide: DECLARACIÓN, no captura. Ese mismo día se
// re-descubrieron 4 recetas más (GetMaintenanceEvent, GetInventoryBatch,
// SearchInventoryItemBatches, WorkboardById) que llevaban meses declaradas en rutas
// que NUNCA las capturaron —0 aciertos en el log histórico— y aquí contaban como
// cubiertas. La deuda REAL era 63. Un `captures` que nadie verifica contra el log es
// la misma mentira silenciosa que documenta ESCALATION.md § 2026-07-28.
// 2026-08-05: 58 -> 55. La familia de parametros de spec quedo cubierta COMPLETA por la
// entidad partNumberSpecParams sobre el PN Centinela 3770957: SaveMultipleSpecFieldParams,
// UpdatePartNumberSpecParam y AddParamsToPartNumber, las tres en UN ciclo y las tres
// validadas end-to-end en vivo (no declaradas de oido: primero se capturo el hash con el
// flujo DOM real, luego se probo contra el server, y hasta entonces entraron a _para).
// 2026-08-05 (2ª baja del día): 55 -> 53. Se RETIRARON del catálogo dos hashes MUERTOS que
// no consume nadie -- CreateInvoiceAndUpdatePartTransferAccounts y TempSpecFieldsAndOptions.
// Alertaban como URGENTES en cada corrida sin romper nada: cry-wolf que entrena a ignorar el
// correo. Su entrada documental sigue en config.knownOperations; lo que se fue es el hash.
// El "nadie" se midió sobre 4 fuentes (applets, extension, Reportes SH, PowerTools) EXCLUYENDO
// safari/main-bundle.js y dataLoader_v84.js: el primero es un ARTEFACTO que embebe el catálogo
// completo (las 199 ops salían "usadas") y el segundo trae su PROPIA tabla de hashes.
// 2026-08-06: 53 -> 51. Baja por RUTA REAL, no por retiro (la distinción que el CLAUDE.md pide
// que el commit declare): las dos mutations de sensores que rotaron ese día ganaron entidad
// centinela — `sensorDashboardCentinela`, captura-y-aborta sobre el Sensor Dashboard #193.
// Nacieron de una rotación que NO se pudo recuperar de ninguno de los 131 scan_results del
// operador: sin ruta, un hash muerto solo se arregla cuando alguien ejecuta la acción a mano.
// 2026-08-06 (misma sesión, corrección): 51 -> 52. **SUBE, y es a propósito.** No es una
// regresión: es que el 51 era MENTIRA. `sensorDashboardCentinela` se declaró cubriendo también
// CreateManySensorMeasurements, y la corrida real demostró que esa pantalla dispara
// CreateSensorMeasurement (SINGULAR) — otra mutation, que ni está en el config ni usa ningún
// applet. La PLURAL, la que sí usan paros-linea y vale-almacen, solo sale del flujo de
// MANTENIMIENTO (crear evento en un nodo con sensor y medir), y ese ciclo NO está escrito.
// Dejarla en `_para` habría sido justo la deuda invisible que este mismo día destapamos en
// `maintenance-list` y `workorders-detail`: declarada cubierta, capturando cero, y descubierta
// sólo cuando el hash rota y el applet ya está roto en piso. Un número honesto que sube vale más
// que uno bonito que miente.
// 2026-08-06 (cierre): 52 -> 51. Ahora sí por RUTA REAL y EJERCIDA, no declarada: la entidad
// `maintenanceNodeSensorStep` capturó CreateManySensorMeasurements en vivo
// (af4afbc5->895008e0). El camino lo dio el operador y desmintió la suposición previa: no sale
// del dashboard sino de evento -> COMPLETE STEP -> llenar mediciones -> SAVE. Nótese el viaje
// del número en un solo día: 53 -> 51 (declarado de más) -> 52 (corregido al medir) -> 51 (ya
// capturando). Solo el último 51 está respaldado por una corrida real.
const HUERFANAS_BASE = 51;

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

// ── Anclas del centinela de sensores (2026-08-06) ────────────────────────────
// Las anclas de este handler se MIDIERON del DOM real. El test las fija porque su falla es
// silenciosa: un selector que deja de matchear no truena — simplemente no captura, y la op
// vuelve a quedar sin ruta sin que nada se ponga rojo. Es el modo de falla que acabamos de
// descubrir en `maintenance-list` y `workorders-detail`.
const DEPS_SRC = require('fs').readFileSync(
  require('path').join(__dirname, '../hash-autopilot/mutation-deps.mjs'), 'utf8');

test('sensorDashboard: NO se ancla a clases css-* (emotion las regenera sin avisar)', () => {
  const fn = DEPS_SRC.slice(DEPS_SRC.indexOf('async function sensorDashboardOpsAborted'));
  const cuerpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/css-[a-z0-9]{5,}/i.test(cuerpo),
    'un ancla css-* parece estructura y no lo es: cambia cuando alguien mueve un padding');
});
test('sensorDashboard: ancla por FORMA de icono, no solo por texto', () => {
  assert.match(DEPS_SRC, /ICON_EXPAND\s*=\s*'M16\.59 8\.59/, 'ExpandMoreIcon medido en vivo');
  assert.match(DEPS_SRC, /ICON_RADIO_OFF\s*=\s*'M12 2C6\.48 2/, 'RadioButtonUncheckedIcon medido en vivo');
});
test('sensorDashboard: la fila se ancla al href del sensor (inmune al idioma)', () => {
  assert.match(DEPS_SRC, /a\[href\*="\/Sensors\/\$\{SENSOR_CON_PARAM_IDD\}"\]/);
});
test('sensorDashboard: marca la op en abortOps ANTES de clicar (si no, no hay qué abortar)', () => {
  const fn = DEPS_SRC.slice(DEPS_SRC.indexOf('async function sensorDashboardOpsAborted'));
  const cuerpo = fn.slice(0, fn.indexOf('\n}\n'));
  for (const op of ['CreateManySensorMeasurements', 'UpdateSensorDashboardMember']) {
    const marca = cuerpo.indexOf(`abortOps.add('${op}')`);
    assert.ok(marca > -1, `${op} debe marcarse en abortOps`);
    assert.ok(marca < cuerpo.indexOf('.click(', marca),
      `${op}: marcar DESPUÉS del clic deja pasar la escritura — el aborto llegaría tarde`);
  }
});
test('sensorDashboard: sin la fila del sensor no clica NADA (fail-closed)', () => {
  const fn = DEPS_SRC.slice(DEPS_SRC.indexOf('async function sensorDashboardOpsAborted'));
  const cuerpo = fn.slice(0, fn.indexOf('\n}\n'));
  const guard = cuerpo.indexOf('fail-closed');
  assert.ok(guard > -1 && guard < cuerpo.indexOf('.click('),
    'en esta pantalla hay un bote de basura en la fila de al lado: un clic a ciegas no es opción');
});
test('sensorDashboard: el candado isSentinel lee el NOMBRE, no la URL', () => {
  const ent = sen.entities.sensorDashboardCentinela;
  assert.equal(ent.marker, 'Centinela');
  assert.equal(ent._estrategia, 'capture-abort');
  // Se acota al bloque `async load(...)`, no a los primeros N caracteres: una ventana fija se
  // rompe en cuanto alguien agrega un comentario (pasó al documentar los 3 intentos fallidos),
  // y un test que falla por longitud entrena a ignorarlo.
  const bloque = DEPS_SRC.slice(DEPS_SRC.indexOf('sensorDashboardCentinela: {'));
  const load = bloque.slice(bloque.indexOf('async load('), bloque.indexOf('async mutate('));
  assert.match(load, /centinela\/i\.test/,
    'un id correcto en un dashboard renombrado NO debe pasar el candado');
});
