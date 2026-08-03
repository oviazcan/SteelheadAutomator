// INVARIANTE DE SEGURIDAD: el filtro por línea destino es PURAMENTE VISUAL.
// Esconder una tarjeta no puede relajar el candado, que bloquea sobre el PAYLOAD de la
// mutación. Este test fija el aislamiento entre los dos módulos — es el precio de haber
// puesto comodidad (filtro) y seguridad (candado) en el mismo applet.
// Run: node --test tools/test/surtido-guard-filter-isolation.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const filterSrc = fs.readFileSync(path.join(ROOT, 'remote', 'scripts', 'surtido-guard-filter-core.js'), 'utf8');

global.window = {};
require(path.join(ROOT, 'remote', 'scripts', 'surtido-guard-core.js'));
require(path.join(ROOT, 'remote', 'scripts', 'surtido-guard-filter-core.js'));
const Guard = global.window.SurtidoGuardCore;
const Filter = global.window.SurtidoGuardFilterCore;

test('el core del filtro NO menciona el estado del candado', () => {
  assert.ok(!/__saSurtidoGuardEnabled/.test(filterSrc), 'el filtro no debe leer el flag del candado');
  assert.ok(!/enforcementEnabled/.test(filterSrc), 'el filtro no debe conocer enforcementEnabled');
});

test('el core del filtro NO toca la red ni la mutación de mover', () => {
  assert.ok(!/\bfetch\b/.test(filterSrc), 'el filtro es puro: sin fetch');
  assert.ok(!/CreateManyPartsTransfersChecked/.test(filterSrc), 'el filtro no conoce la mutación');
  assert.ok(!/evaluateMove/.test(filterSrc), 'el filtro no decide bloqueos');
});

test('los dos módulos son objetos distintos y no comparten API', () => {
  assert.notStrictEqual(Guard, Filter);
  const shared = Object.keys(Filter).filter((k) => Object.prototype.hasOwnProperty.call(Guard, k));
  assert.deepStrictEqual(shared, [], 'no debe haber nombres compartidos: ' + shared.join(','));
});

test('el veredicto del candado NO depende del filtro (mismo input → mismo bloqueo)', () => {
  const vars = {
    partsTransferEventsPayload: {
      partsTransferEvents: [{ partsTransfers: [{ fromAccountId: 1002, type: 'STEP' }] }]
    }
  };
  const ctx = {
    scheduledAccountIds: new Set([1001]),
    // El "no programada" lo declara el mapa por cuenta (GetPartsInProcessNode4): el Set legado
    // viene filtrado por estación y no puede negar. Sin este dato la cuenta sería DESCONOCIDA y
    // el candado haría fail-safe, que no es lo que este test quiere comparar.
    accountScheduled: new Map([[1001, true], [1002, false]]),
    accountNode: { 1002: { recipeNodeId: 7001, workOrderId: 5002 } },
    surtidoNodeIds: new Set([7001])
  };
  const antes = Guard.evaluateMove(vars, ctx, { enforcementEnabled: true });
  // Se "aplica" un filtro que escondería esa misma tarjeta…
  assert.strictEqual(Filter.cardVisibleUnderFilter([], 'T204'), false);
  // …y el veredicto del candado es idéntico: la orden no programada sigue bloqueada.
  const despues = Guard.evaluateMove(vars, ctx, { enforcementEnabled: true });
  assert.strictEqual(antes.block, true);
  assert.deepStrictEqual(antes, despues);
});
