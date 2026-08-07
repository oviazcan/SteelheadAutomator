// tools/test/modal-detect-poll-coverage.test.js
// TRINQUETE de familia: todo applet que monta UI dentro de un MODAL de Steelhead necesita una
// RED DE SEGURIDAD por poll — el MutationObserver no alcanza.
//
// POR QUÉ EXISTE (el mismo bug, cuatro veces, con cuatro nombres distintos):
//   2026-07-30  weight-quick-entry      — "la fila 1 tiene campo y las demás no"
//   2026-08-06  create-order-autofill   — "el modal está abierto y el applet no corrió"
//   2026-08-07  receiver-date-override  — "el campo de fecha es intermitente en los Windows"
//   2026-08-07  proceso-calculator / unit-autoconvert — mismo perfil, corregidos preventivamente
//
// LA MEDICIÓN QUE LO EXPLICA (2026-08-07, /Domains/344/SalesOrders y /Receiving/CustomerParts,
// en producción): con un modal ABIERTO se contaron **0 mutaciones de `childList` en el
// `document.body` durante 6 segundos**, incluso tecleando dentro del modal. El
// `MutationObserver` NO es un vigilante continuo: dispara en eventos discretos. En estas
// pantallas el único evento que llega es el montaje del modal — y si el debounce vence
// mientras ese montaje va a medias (lo normal en un equipo lento, donde el encabezado se llena
// con la respuesta de red), el applet mira cuando no hay nada que ver, falla en silencio, y
// NADIE vuelve a llamarlo. En una máquina rápida todo se monta en la misma ráfaga y el disparo
// cae con el DOM completo: por eso el síntoma es "a mí me funciona, a ellos es intermitente".
//
// CÓMO SE MANTIENE ESTA LISTA:
//   - Un applet entra aquí cuando monta UI dentro de un modal/diálogo de SH.
//   - NO entran los que inyectan en LISTADOS (tablas): ahí las mutaciones son continuas
//     (paginar, filtrar, ordenar, scroll) y el observer sí despierta. Inventario de los que
//     hoy corren sin poll a propósito: docs/architecture/applet-load-gating.md.
//   - El poll debe ser BARATO por tick (ver la nota de cada applet): un `querySelectorAll` por
//     atributo, o un gate previo antes del barrido caro. Un poll caro cambia un bug por un
//     costo permanente en el hilo que el operador está usando.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', '..', 'remote', 'scripts');

// Applets que montan UI dentro de un modal de SH ⇒ el observer solo no basta.
const MODAL_DRIVEN = [
  'weight-quick-entry.js',
  'receiver-date-override.js',
  'warehouse-location-prefill.js',
  'create-order-autofill.js',
  'proceso-calculator.js',
  'unit-autoconvert.js',
];

for (const file of MODAL_DRIVEN) {
  test(`${file}: tiene red de seguridad por poll (no solo MutationObserver)`, () => {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    assert.match(src, /setInterval\s*\(/,
      `${file} monta UI en un modal y depende solo del MutationObserver. Medido en producción: ` +
      '0 mutaciones de childList en 6 s con el modal abierto ⇒ un montaje fallido no tiene quién ' +
      'lo reintente. Agrega un poll de re-detección BARATO (patrón weight-quick-entry).');
    assert.match(src, /DETECT_POLL_MS|detectPoll|_detectPoll/i,
      `${file}: el setInterval existe pero no se ve el poll de re-detección. Si el interval es ` +
      'para otra cosa, este applet sigue sin red de seguridad.');
  });
}

// El poll no sirve de nada si el montaje marca el INTENTO en vez del ÉXITO: el latch se pondría
// igual al fallar y el reintento se saltaría el trabajo. Estos dos ya lo aprendieron por la vía
// dolorosa (rehash de emotion 2026-08-03) y el test lo fija.
// WLP es el caso delicado: su CANDADO (bloquea guardar un recibo sin ubicación) se activa con
// el modal DETECTADO, no con el combo montado — a propósito, porque si el anclaje falla el
// operador conserva los combos por renglón y frenarlo sigue siendo correcto y con salida.
// Por eso lleva DOS marcas. Atar el candado al montaje del campo lo desarmaría justo el día
// que SH vuelva a rehashear el encabezado (2026-08-03), que es cuando más se necesita.
test('warehouse-location-prefill: el candado NO depende de que el campo monte (dos marcas)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'warehouse-location-prefill.js'), 'utf8');
  assert.match(src, /saWlpFieldMounted/,
    'el montaje del campo necesita su propia marca, separada de la detección del modal');
  // El interceptor de fetch se sigue activando con la marca de DETECCIÓN.
  assert.match(src, /querySelector\('\[data-sa-wlp-attached="true"\]'\)/,
    'la capa fetch del candado debe seguir atada a saWlpAttached (modal detectado)');
  // La intención NO es un orden textual (esa primera versión del test se rompió en cuanto el
  // campo volvió a montarse primero, que es su orden correcto): es que un `injectField` que
  // FALLA no pueda cortar la ejecución antes de instalar el candado. O sea: en `onModalFound`
  // no puede haber un `return` entre el intento de montar el campo y `startGatePoll`.
  const cuerpo = src.slice(src.indexOf('function onModalFound(modal) {'));
  const fin = cuerpo.indexOf('\n  }\n');
  const body = cuerpo.slice(0, fin);
  const idxField = body.indexOf('injectField(modal)');
  const idxGate = body.indexOf('startGatePoll(modal)');
  assert.ok(idxField > 0 && idxGate > 0, 'injectField y startGatePoll deben estar en onModalFound');
  const entre = body.slice(Math.min(idxField, idxGate), Math.max(idxField, idxGate));
  assert.doesNotMatch(entre, /\breturn\b/,
    'un injectField que falla NO puede cortar antes de instalar el candado: el candado protege ' +
    'aunque el combo del encabezado no haya montado (el operador conserva los combos por renglón).');
  // Y el campo se monta ANTES del cableado que toca el DOM del modal: si una de esas funciones
  // tira, no puede llevarse por delante lo único que el operador ve.
  assert.ok(idxField < idxGate,
    'injectField va antes del cableado (orden original del applet; invertirlo lo puso detrás de ' +
    'applyUnusedFieldStates/evaluateSaveGate/watchLineRows, que tocan el DOM y pueden tirar).');
});

test('receiver-date-override: onModalFound devuelve si MONTÓ, no si lo intentó', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'receiver-date-override.js'), 'utf8');
  assert.match(src, /if \(!injectField\(modal\)\) return false;/,
    'el latch saRdoAttached debe ponerse SOLO tras un montaje exitoso, y la función debe ' +
    'reportarlo para que el scan siga con los demás candidatos y el poll reintente.');
  assert.match(src, /firstMounted/,
    'el scan debe recorrer todos los candidatos hasta que uno monte (Core.firstMounted), ' +
    'no rendirse en el primero que resuelva un contenedor.');
});
