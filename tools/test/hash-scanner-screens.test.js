// tools/test/hash-scanner-screens.test.js
// Instrumentación de Fase B: el scanner captura, por op, la PANTALLA (location.pathname)
// y un breadcrumb del último click. Prueba los núcleos describeClickTarget + recordScreen
// (puros-ish, con elementos mock) sin DOM real.
const test = require('node:test');
const assert = require('node:assert/strict');
const HashScanner = require('../../remote/scripts/hash-scanner.js');
const { describeClickTarget, recordScreen } = HashScanner._internal;

test('describeClickTarget: botón con texto → tag:texto corto, sin payload', () => {
  const el = { tagName: 'BUTTON', getAttribute: () => null, textContent: '  Guardar cambios  ', closest: () => null };
  assert.equal(describeClickTarget(el), 'button:Guardar cambios');
});

test('describeClickTarget: link con role y texto largo → trunca a 40 chars', () => {
  const long = 'X'.repeat(80);
  const el = { tagName: 'A', getAttribute: (a) => (a === 'role' ? 'link' : null), textContent: long, closest: () => null };
  const out = describeClickTarget(el);
  assert.match(out, /^a\[link\]:X+$/);
  assert.ok(out.length <= 'a[link]:'.length + 40);
});

test('describeClickTarget: elemento nulo → "(desconocido)"', () => {
  assert.equal(describeClickTarget(null), '(desconocido)');
});

test('recordScreen: agrega pathname+breadcrumb nuevo, dedup por pathname (sube count)', () => {
  const entry = { screens: [] };
  recordScreen(entry, '/Domains/344/Customers', 'a:Ver cliente');
  recordScreen(entry, '/Domains/344/Customers', 'a:Otro');    // mismo pathname → count++
  recordScreen(entry, '/Domains/344/Bills', 'button:Buscar');  // pathname nuevo
  assert.deepEqual(entry.screens.map((s) => s.pathname), ['/Domains/344/Customers', '/Domains/344/Bills']);
  assert.equal(entry.screens[0].count, 2);
});

test('recordScreen: cap de 5 pathnames distintos', () => {
  const entry = { screens: [] };
  for (let i = 0; i < 8; i++) recordScreen(entry, `/p/${i}`, 'x');
  assert.equal(entry.screens.length, 5);
});

test('recordScreen: inicializa screens si falta', () => {
  const entry = {};
  recordScreen(entry, '/Dashboards', null);
  assert.equal(entry.screens.length, 1);
  assert.equal(entry.screens[0].pathname, '/Dashboards');
});
