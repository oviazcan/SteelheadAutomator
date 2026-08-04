// Gate de permisos del menú del popup: AUSENTE ≠ VACÍO, y ante la duda se MUESTRA.
// Run: node --test tools/test/permission-gate.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const G = require(path.join(__dirname, '..', '..', 'extension', 'permission-gate.js'));

const APPS = [
  { id: 'spec-migrator', requiredPermissions: ['READ_SPECS', 'WRITE_SPECS'] },
  { id: 'carga-masiva', requiredPermissions: ['READ_PART_NUMBERS', 'READ_QUOTES'] },
  { id: 'auto-router', requiredPermissions: [] },
  { id: 'po-listing-filters' }
];

const ids = apps => apps.map(a => a.id);

test('REGRESIÓN: una lista VACÍA no esconde nada — es "no sé", no "no tiene"', () => {
  // El bug real (2026-07-30): background.js normalizaba a [] cuando el ERP no mandaba
  // la lista, popup.js lo aceptaba porque [] es truthy, y el menú escondía toda app con
  // requiredPermissions. El operador vio desaparecer "Ajuste Masivo de Specs" sin causa
  // visible. Con [] deben verse las CUATRO.
  assert.deepEqual(ids(G.selectVisibleApps(APPS, [])), ids(APPS));
});

test('sin lista (null/undefined) se muestran todas', () => {
  for (const sinDato of [null, undefined]) {
    assert.deepEqual(ids(G.selectVisibleApps(APPS, sinDato)), ids(APPS));
  }
});

test('una lista que no es array tampoco condena', () => {
  for (const basura of ['READ_SPECS', 0, {}, true]) {
    assert.deepEqual(ids(G.selectVisibleApps(APPS, basura)), ids(APPS));
  }
});

test('una lista de puros vacíos cuenta como desconocida', () => {
  assert.deepEqual(ids(G.selectVisibleApps(APPS, ['', '  ' && ''])), ids(APPS));
});

test('con lista REAL sí esconde lo que el usuario no puede usar', () => {
  const perms = ['READ_PART_NUMBERS', 'READ_QUOTES'];
  assert.deepEqual(ids(G.selectVisibleApps(APPS, perms)),
    ['carga-masiva', 'auto-router', 'po-listing-filters']);
});

test('exige TODOS los permisos, no basta uno', () => {
  assert.equal(G.isAppVisible(APPS[0], ['READ_SPECS']), false);
  assert.equal(G.isAppVisible(APPS[0], ['READ_SPECS', 'WRITE_SPECS']), true);
});

test('una app sin requiredPermissions siempre se ve', () => {
  const perms = ['NADA_QUE_VER'];
  assert.equal(G.isAppVisible({ id: 'auto-router', requiredPermissions: [] }, perms), true);
  assert.equal(G.isAppVisible({ id: 'po-listing-filters' }, perms), true);
});

test('el override del popup gana sobre el config, incluso vaciando el requisito', () => {
  const perms = ['READ_PART_NUMBERS'];
  // Sin override, spec-migrator se esconde con esta lista.
  assert.equal(G.isAppVisible(APPS[0], perms), false);
  // Con override vacío el usuario decidió explícitamente que no exija nada.
  assert.equal(G.isAppVisible(APPS[0], perms, { 'spec-migrator': [] }), true);
  // Y un override puede endurecer una app que el config dejaba libre.
  assert.equal(G.isAppVisible(APPS[2], perms, { 'auto-router': ['WRITE_SPECS'] }), false);
});

test('knownPermissions distingue las tres situaciones', () => {
  assert.equal(G.knownPermissions([]), null);
  assert.equal(G.knownPermissions(null), null);
  assert.deepEqual(G.knownPermissions(['A', '', 'B']), ['A', 'B']);
});

test('apps no-array o entradas nulas no truenan el menú', () => {
  assert.deepEqual(G.selectVisibleApps(null, ['X']), []);
  assert.deepEqual(ids(G.selectVisibleApps([null, APPS[2]], ['X'])), ['auto-router']);
});

test('background.js no vuelve a inventar una lista vacía', () => {
  // El fix no sirve si la fuente sigue fabricando []: se cachearía en storage.local y
  // sobreviviría a las recargas. Aquí se fija que "no sé" viaje como null y que solo se
  // persista una lista con contenido.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'extension', 'background.js'), 'utf8');
  assert.match(src, /managedPermissions:\s*Array\.isArray\(user\.currentManagedPermissions\)\s*\n?\s*\?\s*user\.currentManagedPermissions\s*\n?\s*:\s*null/,
    'managedPermissions ausente debe ser null, nunca []');
  assert.match(src, /result\.managedPermissions\.length\s*>\s*0/,
    'solo se cachea una lista de permisos NO vacía');
});

test('el popup usa el módulo y lo carga en su HTML', () => {
  const dir = path.join(__dirname, '..', '..', 'extension');
  const js = fs.readFileSync(path.join(dir, 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'popup.html'), 'utf8');
  assert.match(js, /SAPermissionGate/, 'popup.js debe delegar la decisión al módulo');
  assert.doesNotMatch(js, /if \(!userPermissions\) return true;/,
    'el filtro viejo (que aceptaba [] como lista real) no debe seguir vivo');
  assert.match(html, /<script src="permission-gate\.js"><\/script>/,
    'permission-gate.js debe cargarse ANTES que popup.js');
  assert.ok(html.indexOf('permission-gate.js') < html.indexOf('popup.js'),
    'el orden de carga importa: el gate primero');
});
