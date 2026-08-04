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
      if (sel === '[aria-label]') return scope.filter((e) => e.getAttribute && e.getAttribute('aria-label'));
      if (sel === 'svg') return scope.filter((e) => e.tagName === 'SVG');
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

// ---------- Catálogo: lo medido y lo pendiente ----------
// Estos tests son el REGISTRO de la deuda: si alguien mide un icono y lo agrega, el test que
// lo declara pendiente se pone rojo y obliga a moverlo de lista en el mismo commit.

test('el catálogo trae los 7 iconos MEDIDOS en vivo el 2026-08-03', () => {
  for (const n of ['PlayArrowIcon', 'EmailOutlinedIcon', 'EditIcon', 'ArchiveIcon',
                   'FilterListIcon', 'QrCode2Icon', 'CalendarMonthIcon', 'CloseIcon', 'PrintIcon',
                   'SendIcon', 'VisibilityIcon', 'VisibilityOffIcon']) {
    assert.ok(Core.ICON_SHAPES[n] && Core.ICON_SHAPES[n].length > 0, n + ' debe tener forma medida');
  }
});

test('los iconos PENDIENTES DE MEDIR siguen vacíos (no se adivinan paths)', () => {
  // Un path adivinado no matchea —se comprobó: el Edit canónico dice `a.9959.9959 0` y el
  // real `a.996.996 0`— y además finge cobertura. Mejor vacío y anotado.
  for (const n of ['RestorePageOutlinedIcon']) {
    assert.equal(Core.ICON_SHAPES[n].length, 0, n + ': si ya lo mediste, muévelo a la lista de arriba');
  }
});

test('el Edit medido NO es el canónico de MUI (la diferencia que costó el diagnóstico)', () => {
  const real = Core.ICON_SHAPES.EditIcon[0];
  assert.ok(real.includes('a.996.996 0'), 'el real trae la precisión corta');
  assert.ok(!real.includes('a.9959.9959 0'), 'el canónico de la doc NO matchea en esta versión de MUI');
});

// ---------- Tercera vía: aria-label ----------

test('findIcon: cae al aria-label cuando no hay testid ni forma catalogada', () => {
  const svg = makeSvg('M-forma-desconocida', null);
  const btn = makeButton(svg, { 'aria-label': 'Cerrar' });
  const root = attachQuery(makeContainer([btn]));
  const hit = Core.findIcon(root, 'CloseIcon');
  assert.ok(hit, 'CloseIcon no tiene forma medida, pero sí patrón de aria');
  assert.equal(hit.by, 'aria');
});

test('findIcon: el aria es BILINGÜE — el mismo icono en ES y en EN', () => {
  for (const label of ['Archivar Orden de Trabajo', 'Archive Work Order']) {
    const root = attachQuery(makeContainer([makeButton(makeSvg('M-x', null), { 'aria-label': label })]));
    assert.ok(Core.findIcon(root, 'ArchiveIcon'), 'debe matchear «' + label + '»');
  }
});

test('findIcon: el aria matchea por SUBCADENA (el texto real es más largo)', () => {
  // Medidos en vivo: "Archivar Orden de Trabajo", "Imprimir Etiquetas de Trabajo",
  // "Filtrar Números de Parte" — ninguno es igual al nombre del icono.
  const casos = [['Imprimir Etiquetas de Trabajo', 'QrCode2Icon'], ['Filtrar Números de Parte', 'FilterListIcon']];
  for (const [label, icon] of casos) {
    const root = attachQuery(makeContainer([makeButton(makeSvg('M-x', null), { 'aria-label': label })]));
    assert.ok(Core.findIcon(root, icon), label + ' → ' + icon);
  }
});

test('PRECEDENCIA: la forma gana al aria-label', () => {
  // Dos botones: uno con la forma real de Edit, otro con aria "Editar" y forma desconocida.
  const conForma = makeButton(makeSvg(Core.ICON_SHAPES.EditIcon[0], null));
  const conAria = makeButton(makeSvg('M-otra', null), { 'aria-label': 'Editar' });
  const root = attachQuery(makeContainer([conAria, conForma]));
  const hit = Core.findIcon(root, 'EditIcon');
  assert.equal(hit.by, 'shape', 'la forma es más confiable que un texto traducible');
});

test('findIcon: sin forma medida NI patrón de aria devuelve null (no inventa)', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg('M-lo-que-sea', null))]));
  assert.equal(Core.findIcon(root, 'RestorePageOutlinedIcon'), null);
});

// ---------- findIcons / hasAnyIcon ----------

test('findIcons: devuelve TODOS los del mismo icono, no sólo el primero', () => {
  const d = Core.ICON_SHAPES.EditIcon[0];
  const root = attachQuery(makeContainer([makeButton(makeSvg(d, null)), makeButton(makeSvg(d, null))]));
  assert.equal(Core.findIcons(root, 'EditIcon').length, 2);
});

test('findIcons: lista vacía si no hay ninguno', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg(OTHER_D, null))]));
  assert.deepEqual(Core.findIcons(root, 'EditIcon'), []);
});

test('hasAnyIcon: true si aparece CUALQUIERA de los nombres', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg(MAIL_D, null))]));
  assert.equal(Core.hasAnyIcon(root, ['SendIcon', 'EmailOutlinedIcon']), true);
});

test('hasAnyIcon: false si no aparece ninguno, y tolera entradas nulas', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg(OTHER_D, null))]));
  assert.equal(Core.hasAnyIcon(root, ['EditIcon', 'ArchiveIcon']), false);
  assert.equal(Core.hasAnyIcon(null, ['EditIcon']), false);
  assert.equal(Core.hasAnyIcon(root, null), false);
});

// ---------- Falsos positivos del aria-label (encontrados VERIFICANDO EN VIVO) ----------
// Un aria demasiado laxo no falla: acierta el icono EQUIVOCADO. Estos casos son textos
// REALES medidos en la app el 2026-08-03.

test('REGRESIÓN: «Escanear Código QR» (la cámara) NO es el QR de imprimir etiquetas', () => {
  // Con el patrón viejo `/…|qr/i` esto matcheaba, y wo-schedule-button habría abierto la
  // CÁMARA en vez de generar el PDF de etiquetas.
  const root = attachQuery(makeContainer([makeButton(makeSvg('M-camara', null), { 'aria-label': 'Escanear Código QR' })]));
  assert.equal(Core.findIcon(root, 'QrCode2Icon'), null);
});

test('el QR de etiquetas SÍ matchea por su aria real', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg('M-x', null), { 'aria-label': 'Imprimir Etiquetas de Trabajo' })]));
  assert.ok(Core.findIcon(root, 'QrCode2Icon'));
});

test('REGRESIÓN: «Ver Documentos» / «Ver Desglose de Ventas» NO son el ojo de visibilidad', () => {
  for (const label of ['Ver Documentos', 'Ver Desglose de Ventas']) {
    const root = attachQuery(makeContainer([makeButton(makeSvg('M-x', null), { 'aria-label': label })]));
    assert.equal(Core.findIcon(root, 'VisibilityIcon'), null, '«' + label + '» no debe matchear');
  }
});

test('«View Schedule» (aria real de la ficha de OT) sí es el calendario', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg('M-x', null), { 'aria-label': 'View Schedule' })]));
  assert.ok(Core.findIcon(root, 'CalendarMonthIcon'));
});

test('«Archivar Orden de Trabajo» sigue matcheando tras endurecer el patrón', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg('M-x', null), { 'aria-label': 'Archivar Orden de Trabajo' })]));
  assert.ok(Core.findIcon(root, 'ArchiveIcon'));
});

// ---------- Iconos medidos del HTML aportado por el operador (2026-08-03) ----------
// Cuando la automatización no logró abrir los modales, el operador pegó el HTML de las tres
// pantallas. Salió más rápido y más fiable que seguir intentando por CDP.

const CLOSE_D = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
const EDIT_OUTLINED_D = 'm14.06 9.02.92.92L5.92 19H5v-.92zM17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29m-3.6 3.19L3 17.25V21h3.75L17.81 9.94z';

test('CloseIcon: se resuelve por FORMA con el path del botón Cancelar real', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg(CLOSE_D, null))]));
  const hit = Core.findIcon(root, 'CloseIcon');
  assert.ok(hit);
  assert.equal(hit.by, 'shape', 'ya no depende del aria: tiene forma medida');
});

test('EditIcon: reconoce las DOS variantes que SH usa (filled y outlined)', () => {
  for (const d of [Core.ICON_SHAPES.EditIcon[0], EDIT_OUTLINED_D]) {
    const root = attachQuery(makeContainer([makeButton(makeSvg(d, null))]));
    const hit = Core.findIcon(root, 'EditIcon');
    assert.ok(hit && hit.by === 'shape', 'ambas variantes deben matchear por forma');
  }
});

test('PrintIcon NO se confunde con QrCode2Icon (son botones distintos con la misma función)', () => {
  // El workboard usa PrintIcon para «Print Job Tags»; la ficha de OT usa QrCode2 para
  // «Imprimir Etiquetas de Trabajo». La forma los separa aunque el aria de ambos hable de tags.
  const print = attachQuery(makeContainer([makeButton(makeSvg(Core.ICON_SHAPES.PrintIcon[0], null))]));
  assert.equal(Core.findIcon(print, 'QrCode2Icon'), null, 'PrintIcon no es QrCode2Icon');
  assert.ok(Core.findIcon(print, 'PrintIcon'));
});

test('Visibility vs VisibilityOff: son iconos DISTINTOS y no se confunden', () => {
  // La correspondencia icono↔acción es inversa: el ojo TACHADO va en el botón que dice
  // «Show this sensor…» (está oculto, ofrece mostrarlo). Confundirlos invertiría el applet.
  const abierto = attachQuery(makeContainer([makeButton(makeSvg(Core.ICON_SHAPES.VisibilityIcon[0], null))]));
  assert.ok(Core.findIcon(abierto, 'VisibilityIcon'));
  assert.equal(Core.findIcon(abierto, 'VisibilityOffIcon'), null);
  const tachado = attachQuery(makeContainer([makeButton(makeSvg(Core.ICON_SHAPES.VisibilityOffIcon[0], null))]));
  assert.ok(Core.findIcon(tachado, 'VisibilityOffIcon'));
  assert.equal(Core.findIcon(tachado, 'VisibilityIcon'), null);
});

test('SendIcon se resuelve por forma (botón Send del modal de correo)', () => {
  const root = attachQuery(makeContainer([makeButton(makeSvg('M2.01 21 23 12 2.01 3 2 10l15 2-15 2z', null))]));
  const hit = Core.findIcon(root, 'SendIcon');
  assert.ok(hit && hit.by === 'shape');
});
