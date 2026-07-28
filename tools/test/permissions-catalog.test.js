// tools/test/permissions-catalog.test.js
// Todo permiso que la extensión exige debe EXISTIR en el catálogo de Steelhead.
//
// Por qué existe: el 2026-07-27 el botón de report-regen "de pronto dejó de aparecer".
// Tras descartar timing, carrera y DOM, el diagnóstico en vivo mostró que el veredicto del
// gate era correcto: el usuario tenía 245 permisos y `MANAGE_REPORTING` no estaba entre
// ellos. Steelhead lo había FRAGMENTADO en cinco permisos granulares
// (MANAGE_REPORTING_{CONFIGURATIONS,CUSTOM,DASHBOARDS,FILTER_SETS,SETTINGS}) y el viejo
// dejó de existir. El applet quedó exigiendo un permiso fantasma: nadie podía verlo nunca,
// y en silencio — indistinguible de "no tienes permiso".
//
// El mismo barrido encontró un segundo caso: bill-autofill exigía READ_ACCOUNTS_PAYABLE,
// que tampoco existe ya (hoy es READ_BILLS).
//
// El catálogo se captura de https://app.gosteelhead.com/Users/Access/PermissionsReference
// con la sesión del operador. Cuando Steelhead vuelva a renombrar algo, re-captúralo y este
// test señalará exactamente qué applet quedó pidiendo un fantasma.
// Run: node --test tools/test/permissions-catalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const catalogo = require('../../docs/api/permissions-catalog.json');
const config = require('../../remote/config.json');

test('el catálogo está bien formado', () => {
  assert.ok(Array.isArray(catalogo.permisos) && catalogo.permisos.length > 200,
    'el catálogo se ve truncado');
  assert.equal(catalogo.permisos.length, catalogo.total);
  assert.equal(new Set(catalogo.permisos).size, catalogo.permisos.length, 'hay duplicados');
});

test('ningún applet exige un permiso que ya no existe en Steelhead', () => {
  const validos = new Set(catalogo.permisos);
  const fantasmas = [];
  for (const app of (config.apps || [])) {
    for (const p of (app.requiredPermissions || [])) {
      if (!validos.has(p)) fantasmas.push(`${app.id} → ${p}`);
    }
  }
  assert.deepEqual(fantasmas, [],
    'Estos applets exigen permisos que NO están en el catálogo de Steelhead. Un permiso ' +
    'fantasma nunca se cumple: el applet queda invisible para todos, en silencio. Busca el ' +
    'reemplazo en docs/api/permissions-catalog.json (Steelhead suele fragmentar un permiso ' +
    'en varios granulares) y actualiza requiredPermissions.');
});

test('report-regen exige el permiso vigente de regenerar la base de reportes', () => {
  const app = (config.apps || []).find(a => a.id === 'report-regen');
  // MANAGE_REPORTING_SETTINGS es, textual en el catálogo de Steelhead: "Admin-level
  // reporting actions: regenerate the reporting database, view and change reporting settings."
  assert.deepEqual(app.requiredPermissions, ['MANAGE_REPORTING_SETTINGS']);
});
