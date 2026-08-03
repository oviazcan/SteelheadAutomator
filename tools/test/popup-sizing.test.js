// tools/test/popup-sizing.test.js
// Trinquete: el popup NUNCA debe pedir más de 600px de alto.
// Run: node --test tools/test/popup-sizing.test.js
//
// ── Por qué existe (2026-08-03) ─────────────────────────────────────────────
// Un popup de extensión no tiene tamaño propio: Chromium lo ajusta a lo que pide
// el documento, con un tope duro de 800x600. Si el alto se pasa de 600, el
// navegador deja de ajustar el ancho al preferido (340px) y abre la ventana al
// MÁXIMO: el body a la izquierda y ~460px vacíos a la derecha — que se ven
// oscuros porque el background del body se propaga al canvas.
//
// Esto se sostenía con un `max-height` en px por lista, calculado A MANO contra
// el cromo fijo. Ese esquema falló TRES veces:
//   1. 2026-07-29 — `Ajuste Masivo de Specs` pasó de 5 a 7 acciones y `.app-actions`
//      era la única lista sin tope: 646px.
//   2. 2026-08-03 — la vista de CONFIGURACIÓN nunca se contó: con el editor de
//      permisos de los 44 applets pedía 838px (942 con el banner).
//   3. 2026-08-03 — la barra de progreso (33px) es un hermano de las vistas y se
//      suma a CUALQUIERA: la vista de acciones pasaba de 576 a 609 en el momento
//      exacto en que el operador daba clic a una acción.
//
// La lección: una regla que depende de que alguien rehaga una cuenta a mano cada
// vez que se agrega una pieza es una regla que se rompe. Ahora la aritmética la
// hace el navegador (columna flex con el documento topado), y este test cuida los
// invariantes que sostienen ese modelo — incluido el ORDEN DE LA CASCADA, que es
// donde se fue el primer intento del arreglo: `.view.active{display:flex}` quedó
// ANTES de la regla vieja `.view.active{display:block}` y perdió por orden, sin
// error ni aviso: el CSS era válido y el popup se veía casi igual… hasta que la
// lista crecía.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'extension/popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'extension/popup.js'), 'utf8');

const TOPE_CHROMIUM = 600;

// ── Utilidades de parseo ────────────────────────────────────────────────────
const css = (() => {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, 'popup.html debe traer su <style> embebido');
  // Fuera los comentarios: sus comas parten el selector del bloque que les sigue
  // y el selector real deja de reconocerse.
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
})();

/** Todas las declaraciones de una propiedad para un selector, EN ORDEN de aparición. */
function declaraciones(selector, prop) {
  const out = [];
  // Bloques `sel1, sel2 { ... }` — nos quedamos con los que incluyen el selector exacto.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectores = m[1].split(',').map(s => s.trim());
    if (!selectores.includes(selector)) continue;
    const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(m[2]);
    if (decl) out.push(decl[1].trim());
  }
  return out;
}

/** Extrae el fragmento HTML de un elemento por id, balanceando <div>. */
function bloquePorId(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `popup.html debe tener el elemento #${id}`);
  const open = html.lastIndexOf('<div', start);
  let i = open, depth = 0;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open;
  let m;
  while ((m = tag.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { i = m.index + m[0].length; break; }
  }
  return html.slice(open, i);
}

// ── El documento se topa por debajo del límite de Chromium ──────────────────
test('el body declara un tope de alto por debajo de los 600px de Chromium', () => {
  for (const sel of ['html', 'body']) {
    const topes = declaraciones(sel, 'max-height');
    assert.equal(topes.length, 1, `${sel} debe declarar max-height exactamente una vez`);
    const px = parseInt(topes[0], 10);
    assert.ok(/px$/.test(topes[0]), `${sel} max-height debe ir en px, no "${topes[0]}"`);
    assert.ok(px <= TOPE_CHROMIUM,
      `${sel} pide ${px}px y el tope de Chromium es ${TOPE_CHROMIUM}px: el popup se abriría a 800px de ancho`);
  }
});

test('el body reparte el alto como columna flex y recorta lo que sobra', () => {
  assert.equal(declaraciones('body', 'display').at(-1), 'flex');
  assert.equal(declaraciones('body', 'flex-direction').at(-1), 'column');
  assert.equal(declaraciones('body', 'overflow').at(-1), 'hidden',
    'sin overflow:hidden el contenido desbordado vuelve a estirar el documento');
});

test('el cromo (header, banner, estado, progreso, pie) no se encoge', () => {
  const flex = declaraciones('body > *', 'flex');
  assert.ok(flex.length >= 1, 'debe existir la regla `body > * { flex: 0 0 auto }`');
  assert.equal(flex.at(-1), '0 0 auto');
});

// ── La cadena flex no se puede cortar a medias ──────────────────────────────
// Este es el test que habría atrapado el error del primer intento de arreglo.
test('la vista activa gana la cascada como flex, no como block', () => {
  const displays = declaraciones('.view.active', 'display');
  assert.ok(displays.length >= 1, '.view.active debe declarar display');
  assert.equal(displays.at(-1), 'flex',
    'la ÚLTIMA declaración de display para .view.active gana: si queda en block, la lista ' +
    'crece libre y el documento se estira (el CSS sigue siendo válido, no avisa)');
  assert.equal(declaraciones('.view.active', 'min-height').at(-1), '0',
    'sin min-height:0 un hijo flex no baja de su tamaño de contenido');
});

test('los intermediarios entre la vista y su lista tampoco cortan la cadena', () => {
  // .app-menu-wrap se interpone entre #view-menu y la lista de apps.
  assert.equal(declaraciones('.app-menu-wrap', 'display').at(-1), 'flex');
  assert.equal(declaraciones('.app-menu-wrap', 'min-height').at(-1), '0');
});

test('.view-scroll es el que scrollea y puede encogerse', () => {
  assert.equal(declaraciones('.view-scroll', 'flex').at(-1), '1 1 auto');
  assert.equal(declaraciones('.view-scroll', 'min-height').at(-1), '0');
  assert.equal(declaraciones('.view-scroll', 'overflow-y').at(-1), 'auto');
});

// ── Toda vista necesita quién scrollee ─────────────────────────────────────
test('cada vista del popup tiene un contenedor scrollable', () => {
  const ids = [...html.matchAll(/id="(view-[a-z-]+)"/g)].map(m => m[1]);
  assert.ok(ids.length >= 4, `esperaba al menos 4 vistas, encontré ${ids.length}`);

  for (const id of ids) {
    const bloque = bloquePorId(id);
    assert.ok(/class="[^"]*\bview-scroll\b/.test(bloque),
      `#${id} no tiene ningún contenedor con la clase view-scroll: su contenido crecería ` +
      `libre y el popup se abriría a 800px de ancho. Marca la lista larga con view-scroll.`);
  }
});

test('las listas del menú que genera popup.js llevan view-scroll', () => {
  // #view-menu se llena desde JS: el HTML solo trae el contenedor vacío, así que
  // el chequeo anterior no alcanza a cubrir grid ni list.
  for (const clase of ['app-grid', 'app-list']) {
    const re = new RegExp(`className\\s*=\\s*'${clase} view-scroll'`);
    assert.ok(re.test(popupJs),
      `popup.js crea .${clase} sin la clase view-scroll: al renderizar el menú la lista ` +
      `crecería con el número de applets`);
  }
});

// ── Nada debe competir con el reparto del flex ─────────────────────────────
test('ninguna lista conserva un max-height en px que compita con el flex', () => {
  const contenedores = [
    '.app-menu', '.app-grid', '.app-list', '.app-actions',
    '.results-panel', '.app-perms-editor', '.view-scroll'
  ];
  for (const sel of contenedores) {
    const topes = declaraciones(sel, 'max-height').filter(v => /\d+px/.test(v));
    assert.deepEqual(topes, [],
      `${sel} conserva un max-height fijo (${topes.join(', ')}). Los topes en px son justo ` +
      `el esquema que falló tres veces: hay que rehacer la cuenta a mano cada vez que se ` +
      `agrega una pieza. El alto lo reparte el flex.`);
  }
});

test('no quedan reglas que encojan listas por el banner de actualización', () => {
  assert.ok(!/body:has\(\.update-banner\.visible\)/.test(css),
    'el banner ya no necesita reglas propias: al ser cromo (flex: 0 0 auto) el flex le ' +
    'quita el espacio a la lista automáticamente');
});
