// tools/test/schedule-batch-group-wiring.test.js
// El botón 📦 es un contrato entre TRES archivos y ninguno falla solo: el config declara los
// scripts, el glue llama las ops por nombre y los hashes viven en otra sección del config. Si uno
// se desalinea, no hay error: el applet simplemente no agrupa. La única señal sería el piso, así
// que el recorrido se fija aquí (misma lección que popup-actions-wired).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '../..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'remote/config.json'), 'utf8'));
const glue = readFileSync(join(ROOT, 'remote/scripts/schedule-batch-group.js'), 'utf8');
const app = cfg.apps.find((a) => a.id === 'schedule-batch-highlighter');

test('la app existe y sigue gateada al Schedule Board', () => {
  assert.ok(app, 'falta la app schedule-batch-highlighter en config.apps');
  assert.equal(app.autoInject, true);
  assert.deepEqual(app.urlPatterns, ['^/Schedules/\\d+/ScheduleBoard/\\d+/?(?:[?#]|$)']);
});

test('los scripts van en orden de dependencia', () => {
  // El glue de agrupación consume ScheduleBatchGroupCore, ScheduleBatchHighlighterCore y
  // SteelheadAPI: los tres tienen que estar ANTES en la lista o el IIFE se rinde al cargar.
  const s = app.scripts;
  const i = (x) => s.indexOf(x);
  for (const f of ['scripts/steelhead-api.js', 'scripts/schedule-batch-highlighter-core.js',
    'scripts/schedule-batch-highlighter.js', 'scripts/schedule-batch-group-core.js',
    'scripts/schedule-batch-group.js']) {
    assert.ok(i(f) !== -1, `falta ${f} en los scripts de la app`);
  }
  assert.ok(i('scripts/steelhead-api.js') < i('scripts/schedule-batch-group.js'));
  assert.ok(i('scripts/schedule-batch-group-core.js') < i('scripts/schedule-batch-group.js'));
  assert.ok(i('scripts/schedule-batch-highlighter-core.js') < i('scripts/schedule-batch-group.js'));
});

test('cada op que el glue nombra tiene su hash en config', () => {
  const h = cfg.steelhead.hashes;
  const todos = { ...h.queries, ...h.mutations };
  for (const op of ['RelatedSchedulingInformation', 'SchedulablePartLocations', 'CreateManyScheduleTasks']) {
    assert.ok(glue.includes(`'${op}'`), `el glue ya no nombra ${op} — ¿cambió de fuente?`);
    assert.ok(todos[op], `${op} no tiene hash en remote/config.json`);
    assert.match(todos[op], /^[0-9a-f]{64}$/, `${op} no parece un sha256`);
  }
});

test('el hash de CreateManyScheduleTasks es el que el ERP aceptó en el payload capturado', () => {
  const fx = JSON.parse(readFileSync(join(ROOT, 'tools/test/fixtures/schedule-batch-group-created.json'), 'utf8'));
  assert.equal(cfg.steelhead.hashes.mutations.CreateManyScheduleTasks, fx.hash);
});

test('el glue NO pide RackingRecipeNodes', () => {
  // El Task Builder nativo la usa, pero treatmentId y tiempos ya viajan en
  // RelatedSchedulingInformation. Pedirla serían 340 KB por agrupación, a cambio de nada.
  assert.ok(!glue.includes('RackingRecipeNodes'));
});

test('la escritura no fija hora ni marca la tarea como intencional', () => {
  // Igual que el nativo: status UNSCHEDULED + isIntentional:false, para que el planificador la
  // acomode. Fijar la hora es otra decisión (el 📅 de wo-schedule-button), no la de agrupar.
  assert.ok(glue.includes('isIntentional: false'));
  const core = readFileSync(join(ROOT, 'remote/scripts/schedule-batch-group-core.js'), 'utf8');
  assert.ok(core.includes("status: 'UNSCHEDULED'"));
});
