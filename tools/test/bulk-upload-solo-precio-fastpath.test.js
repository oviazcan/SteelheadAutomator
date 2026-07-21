// tools/test/bulk-upload-solo-precio-fastpath.test.js
//
// Golden test del MOTOR del fast-path "SOLO_PRECIO" de bulk-upload.
//
// El fast-path (feat 1.5.40) permite que una corrida cuya ÚNICA intención es cambiar
// el precio de PN que YA existen (sin ningún enriquecimiento de specs/params/racks/dims)
// se salte los STEPs de enriquecimiento (5/6/6a/6b/7) y vaya directo a precios (7b/8).
//
// La DECISIÓN de activar el atajo es una función pura y testeable
// (`planSoloPrecioFastPath`), separada del flujo imperativo. El atajo:
//   - SOLO se activa con el feature-flag ENCENDIDO (default OFF hasta validar en vivo), y
//   - SOLO cuando `classifyRunIntent` devuelve exactamente 'SOLO_PRECIO'.
// Con el flag apagado, la decisión es SIEMPRE false → comportamiento actual byte-idéntico.
//
// Cubre además `classifyRunIntent` (que no tenía golden test) para blindar los invariantes
// que el fast-path da por ciertos (p. ej. un dash "-" en enrich CUENTA como enriquecimiento,
// así que NO dispara SOLO_PRECIO — un borrado de spec no debe tomar el atajo).

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../remote/scripts/bulk-upload-parse.js');

// ─────────────────────────────────────────────────────────────────────────────
// classifyRunIntent — invariantes que el fast-path da por ciertos
// ─────────────────────────────────────────────────────────────────────────────
test('classifyRunIntent: precio + todos existentes + sin enrich → SOLO_PRECIO', () => {
  const parts = [{ precio: 10.5 }, { precio: 3 }];
  assert.equal(P.classifyRunIntent(parts, true), 'SOLO_PRECIO');
});

test('classifyRunIntent: precio pero NO todos existentes → NO es SOLO_PRECIO', () => {
  // allExisting=false: hay al menos un PN nuevo → alta, no atajo.
  assert.equal(P.classifyRunIntent([{ precio: 10 }], false), 'ALTA');
});

test('classifyRunIntent: precio + enriquecimiento → ENRIQUECIMIENTO (no atajo)', () => {
  const parts = [{ precio: 10, specs: [{ id: 1 }] }];
  assert.equal(P.classifyRunIntent(parts, true), 'ENRIQUECIMIENTO');
});

test('classifyRunIntent: enriquecimiento sin precio → AJUSTE_LINEA', () => {
  assert.equal(P.classifyRunIntent([{ specs: [{ id: 1 }] }], true), 'AJUSTE_LINEA');
});

test('classifyRunIntent: ni precio ni enrich → ALTA', () => {
  assert.equal(P.classifyRunIntent([{}], true), 'ALTA');
  assert.equal(P.classifyRunIntent([], true), 'ALTA');
  assert.equal(P.classifyRunIntent(null, true), 'ALTA');
});

test('classifyRunIntent: un dash "-" en una columna de enrich CUENTA como enriquecimiento', () => {
  // partHasEnrich trata dato Y dash como intención de cambio de línea (borrado de spec).
  // Un borrado NO debe tomar el fast-path de solo-precio: aquí un rack con contenido.
  const parts = [{ precio: 10, racks: [{ id: 7 }] }];
  assert.equal(P.classifyRunIntent(parts, true), 'ENRIQUECIMIENTO');
});

test('classifyRunIntent: metalBase / pnAlterno / dims también son enriquecimiento', () => {
  assert.equal(P.classifyRunIntent([{ precio: 1, metalBase: 'Zn' }], true), 'ENRIQUECIMIENTO');
  assert.equal(P.classifyRunIntent([{ precio: 1, dims: { length: 5 } }], true), 'ENRIQUECIMIENTO');
});

// ── INVARIANTE DE SEGURIDAD: la clasificación es por CORRIDA COMPLETA, no por fila ──
// Es lo que protege contra pérdida de datos: si CUALQUIER fila del lote trae enriquecimiento,
// toda la corrida deja de ser SOLO_PRECIO → el fast-path NO se activa → STEP 6 (enrich) corre
// normal para TODAS las filas. Nunca se salta el enrich cuando hay algo que aplicar.
test('SEGURIDAD: una sola fila con enrich en el lote desactiva SOLO_PRECIO (y el atajo)', () => {
  const mixto = [{ precio: 10 }, { precio: 5, specs: [{ id: 1 }] }]; // fila 2 trae spec
  assert.equal(P.classifyRunIntent(mixto, true), 'ENRIQUECIMIENTO');
  assert.equal(P.planSoloPrecioFastPath(P.classifyRunIntent(mixto, true), true), false);
});

test('SEGURIDAD: un solo PN nuevo (no existente) en el lote desactiva el atajo', () => {
  const conNuevo = [{ precio: 10 }, { precio: 5 }];
  // allExisting=false ⇒ hay un PN por crear ⇒ ALTA, no SOLO_PRECIO.
  assert.equal(P.classifyRunIntent(conNuevo, false), 'ALTA');
  assert.equal(P.planSoloPrecioFastPath(P.classifyRunIntent(conNuevo, false), true), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// planSoloPrecioFastPath — gate puro del atajo (flag + intención)
// ─────────────────────────────────────────────────────────────────────────────
test('planSoloPrecioFastPath: flag OFF → SIEMPRE false (comportamiento actual intacto)', () => {
  assert.equal(P.planSoloPrecioFastPath('SOLO_PRECIO', false), false);
  assert.equal(P.planSoloPrecioFastPath('ENRIQUECIMIENTO', false), false);
  assert.equal(P.planSoloPrecioFastPath('ALTA', false), false);
});

test('planSoloPrecioFastPath: flag ON + SOLO_PRECIO → true (único caso que activa el atajo)', () => {
  assert.equal(P.planSoloPrecioFastPath('SOLO_PRECIO', true), true);
});

test('planSoloPrecioFastPath: flag ON pero intención distinta → false', () => {
  assert.equal(P.planSoloPrecioFastPath('AJUSTE_LINEA', true), false);
  assert.equal(P.planSoloPrecioFastPath('ENRIQUECIMIENTO', true), false);
  assert.equal(P.planSoloPrecioFastPath('ALTA', true), false);
  assert.equal(P.planSoloPrecioFastPath(null, true), false);
  assert.equal(P.planSoloPrecioFastPath(undefined, true), false);
});

test('planSoloPrecioFastPath: tolera argumentos raros sin lanzar', () => {
  assert.equal(P.planSoloPrecioFastPath('SOLO_PRECIO'), false); // flag ausente → falsy → false
  assert.equal(P.planSoloPrecioFastPath(), false);
});
