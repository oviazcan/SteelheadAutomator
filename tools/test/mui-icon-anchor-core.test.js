// tools/test/mui-icon-anchor-core.test.js
// Golden tests del anclaje a iconos de MUI cuando el `data-testid` ya no está.
// Run: node --test tools/test/mui-icon-anchor-core.test.js
//
// POR QUÉ EXISTE (incidente 2026-08-03, segunda mitad):
//   Steelhead publicó un build que **quita los `data-testid` de los iconos MUI** y los
//   `data-steelhead-component-id`. Medido en tres pantallas distintas, todas cargadas y con
//   contenido real: `/Reporting/View` (189 svg), `/Receiving/CustomerParts` (159 svg) y la
//   lista de reportes → **0 `[data-testid]` y 0 `[data-steelhead-component-id]`** en cada
//   una (los únicos dos testid que quedan, `sentinelStart`/`sentinelEnd`, los pone
//   react-virtuoso, no SH).
//   Eso dejó a `report-regen` sin ancla: su gate de permisos pasaba (`allowed: true`), el
//   script cargaba y el observer vivía, pero `findAnchor()` devolvía null para siempre.
//
// LA REGLA QUE FIJA: el `data-testid` era el nivel 1 de la jerarquía de anclaje del repo, y
//   SH lo puede quitar de un build a otro sin avisar. Lo que NO puede quitar sin cambiar lo
//   que el usuario ve es **la FORMA del icono**: el atributo `d` del `<path>`. No depende del
//   idioma, ni de clases generadas, ni de atributos de test. Se ancla por testid PRIMERO (si
//   SH lo repone, sigue sirviendo) y por forma DESPUÉS: un anclaje no se cambia, se AMPLÍA.

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/mui-icon-anchor-core.js');

// ── Simulador mínimo con querySelector/querySelectorAll sobre selectores muy acotados.
function makeSvg(pathD, testid) {
  const path = { tagName: 'PATH', attrs: { d: pathD }, children: [] };
  path.getAttribute = (k) => (k in path.attrs ? path.attrs[k] : null);
  const svg = { tagName: 'SVG', attrs: testid ? { 'data-testid': testid } : {}, children: [path] };
  svg.getAttribute = (k) => (k in svg.attrs ? svg.attrs[k] : null);
  path.parentElement = svg;
  return svg;
}
function makeButton(svg, extra) {
  const btn = { tagName: 'BUTTON', attrs: extra || {}, children: svg ? [svg] : [] };
  btn.getAttribute = (k) => (k in btn.attrs ? btn.attrs[k] : null);
  if (svg) svg.parentElement = btn;
  return btn;
}
function makeContainer(children) {
  const c = { tagName: 'DIV', attrs: {}, children: children.slice() };
  c.getAttribute = () => null;
  for (const ch of children) ch.parentElement = c;
  return c;
}
// Recolecta descendientes que cumplan un predicado, en orden de documento.
function descendants(node) {
  const out = [];
  (function walk(n) { for (const c of n.children || []) { out.push(c); walk(c); } })(node);
  return out;
}
// Implementa el subconjunto de querySelectorAll que el core usa:
//   'svg[data-testid="X"]'  y  'svg path'
function attachQuery(root) {
  const all = [root, ...descendants(root)];
  for (const node of all) {
    const scope = [node, ...descendants(node)];
    node.querySelectorAll = (sel) => {
      const m = /^svg\[data-testid="([^"]+)"\]$/.exec(sel);
      if (m) return scope.filter((e) => e.tagName === 'SVG' && e.getAttribute('data-testid') === m[1]);
      if (sel === 'svg path') return scope.filter((e) => e.tagName === 'PATH');
      if (sel === 'path') return scope.filter((e) => e.tagName === 'PATH');
      return [];
    };
    node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
    node.closest = (sel) => {
      const want = sel.toUpperCase();
      let n = node;
      while (n) { if (n.tagName === want) return n; n = n.parentElement; }
      return null;
    };
  }
  return root;
}

// ── Paths REALES medidos en vivo el 2026-08-03 en /Reporting/View.
const PLAY_D = 'M8 5v14l11-7z';
const MAIL_D = 'M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2zm-2 0-8 5-8-5zm0 12H4V8l8 5 8-5z';
const OTHER_D = 'M3 18h18v-2H3zm0-5h18v-2H3zm0-7v2h18V6z'; // el de menú, para probar que no confunde
// PauseIcon: path canónico de MUI. NO medido en vivo (no había timer corriendo al inspeccionar);
// por eso el pausa sólo AFIRMA — si su path fuera otro, el breadcrumb sostiene el anclaje igual.
const PAUSE_D = 'M6 19h4V5H6zm8-14v14h4V5z';

// ---------- El catálogo trae lo medido ----------

test('el catálogo conoce play y correo con los paths medidos en vivo', () => {
  assert.ok(Core.ICON_SHAPES.PlayArrowIcon.includes(PLAY_D));
  assert.ok(Core.ICON_SHAPES.EmailOutlinedIcon.includes(MAIL_D));
});

// ---------- findIcon: por testid (legado) ----------

test('findIcon: si el data-testid SIGUE ahí, lo usa (no se rompe si SH lo repone)', () => {
  const svg = makeSvg(PLAY_D, 'PlayArrowIcon');
  const root = attachQuery(makeContainer([makeButton(svg)]));
  const hit = Core.findIcon(root, 'PlayArrowIcon');
  assert.equal(hit.node, svg);
  assert.equal(hit.by, 'testid');
});

// ---------- findIcon: por FORMA (el caso de hoy) ----------

test('findIcon: sin data-testid, lo encuentra por la FORMA del icono', () => {
  const svg = makeSvg(PLAY_D, null);
  const root = attachQuery(makeContainer([makeButton(svg)]));
  const hit = Core.findIcon(root, 'PlayArrowIcon');
  assert.equal(hit.node, svg);
  assert.equal(hit.by, 'shape');
});

test('findIcon: la forma distingue un icono de otro', () => {
  const menu = makeSvg(OTHER_D, null);
  const root = attachQuery(makeContainer([makeButton(menu)]));
  assert.equal(Core.findIcon(root, 'PlayArrowIcon'), null, 'el icono de menú NO es el de play');
});

test('findIcon: tolera espacios alrededor del path', () => {
  const svg = makeSvg('  ' + PLAY_D + '  ', null);
  const root = attachQuery(makeContainer([makeButton(svg)]));
  assert.ok(Core.findIcon(root, 'PlayArrowIcon'));
});

test('findIcon: devuelve null para un icono desconocido o entrada nula', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg(PLAY_D, null))]));
  assert.equal(Core.findIcon(root, 'NoExisteIcon'), null);
  assert.equal(Core.findIcon(null, 'PlayArrowIcon'), null);
});

// ---------- findIconButton ----------

test('findIconButton: devuelve el <button> que envuelve al icono', () => {
  const svg = makeSvg(MAIL_D, null);
  const btn = makeButton(svg);
  const root = attachQuery(makeContainer([btn]));
  assert.equal(Core.findIconButton(root, 'EmailOutlinedIcon').button, btn);
});

test('findIconButton: null si el icono no está dentro de un botón', () => {
  const svg = makeSvg(MAIL_D, null);
  const root = attachQuery(makeContainer([svg]));
  assert.equal(Core.findIconButton(root, 'EmailOutlinedIcon'), null);
});

// ---------- El caso REAL de report-regen ----------
// Header medido en vivo (/Reporting/View): css-bomumo con 7 hijos —
//   [0] nav[aria-label=breadcrumb] · [2] "Ver Documentos" · [4] ▶ · [6] ✉ (badge 99+)
//
// EL ANCLA ES EL CORREO, NO EL PLAY. Corrección de dominio del operador: **el ▶ se convierte
// en ⏸ cuando hay un timer activo**, así que exigirlo hacía desaparecer el botón justo
// mientras corría un reporte — un bug que el applet YA tenía antes del cambio de SH, no algo
// que introdujera este fix. Medido además: hay **un solo sobre en toda la página**, así que
// el correo identifica el header sin ambigüedad.
//
// play/pausa y el breadcrumb sólo AFIRMAN (confirman que es el header secundario); ninguno
// puede negar. El requisito duro es el sobre.

function headerReal(opts) {
  const o = opts || {};
  const nav = { tagName: 'NAV', attrs: { 'aria-label': 'breadcrumb' }, children: [] };
  nav.getAttribute = (k) => (k in nav.attrs ? nav.attrs[k] : null);
  const spacer = makeContainer([]);
  const docs = makeButton(makeSvg('M8 16h8v2H8zm0-4h8v2H8z', null));
  const sep0 = makeContainer([]);
  const transporte = o.pausa
    ? makeButton(makeSvg(PAUSE_D, o.testid ? 'PauseIcon' : null))
    : makeButton(makeSvg(PLAY_D, o.testid ? 'PlayArrowIcon' : null));
  const sep1 = makeContainer([]);
  const mail = makeButton(makeSvg(MAIL_D, o.testid ? 'EmailOutlinedIcon' : null));
  const kids = [nav, spacer, docs, sep0, sep1, mail];
  if (!o.sinTransporte) kids.splice(4, 0, transporte);
  const cont = makeContainer(kids);
  attachQuery(cont);
  return { cont, mail, transporte, nav };
}

test('report-regen: ancla al CORREO sin data-testid (el DOM de hoy)', () => {
  const h = headerReal({});
  const a = Core.findReportHeaderAnchor(h.cont);
  assert.ok(a, 'debe resolver');
  assert.equal(a.container, h.cont);
  assert.equal(a.emailBtn, h.mail);
  assert.equal(a.by, 'shape');
});

test('report-regen: sigue anclando CON data-testid (si SH lo repone)', () => {
  const a = Core.findReportHeaderAnchor(headerReal({ testid: true }).cont);
  assert.ok(a);
  assert.equal(a.by, 'testid');
});

test('REGRESIÓN: con el timer activo el ▶ es ⏸ y el ancla DEBE seguir resolviendo', () => {
  // Éste es el bug que el applet arrastraba: exigir PlayArrowIcon lo apagaba con timer activo.
  const h = headerReal({ pausa: true });
  const a = Core.findReportHeaderAnchor(h.cont);
  assert.ok(a, 'con pausa el botón no puede desaparecer');
  assert.equal(a.emailBtn, h.mail);
});

test('report-regen: resuelve aunque NO haya botón de transporte (ni play ni pausa)', () => {
  // El breadcrumb basta para confirmar que es el header secundario.
  const h = headerReal({ sinTransporte: true });
  assert.ok(Core.findReportHeaderAnchor(h.cont));
});

test('report-regen: un sobre suelto SIN señales de header NO monta el botón', () => {
  // Fail-safe: sin breadcrumb ni transporte no hay evidencia de que sea el header de reportes.
  const suelto = makeContainer([makeButton(makeSvg(MAIL_D, null))]);
  attachQuery(suelto);
  assert.equal(Core.findReportHeaderAnchor(suelto), null);
});

test('report-regen: sin el header (otra vista) devuelve null, que NO es error', () => {
  const page = attachQuery(makeContainer([makeButton(makeSvg(OTHER_D, null))]));
  assert.equal(Core.findReportHeaderAnchor(page), null);
});

test('report-regen: con varios sobres elige el que está en el header (con breadcrumb)', () => {
  const suelto = makeContainer([makeButton(makeSvg(MAIL_D, null))]);
  const h = headerReal({});
  const page = makeContainer([suelto, h.cont]);
  attachQuery(page);
  const a = Core.findReportHeaderAnchor(page);
  assert.ok(a);
  assert.equal(a.container, h.cont);
});
