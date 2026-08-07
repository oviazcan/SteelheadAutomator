// tools/test/receive-modal-anchor-core.test.js
// Golden tests del anclaje de los campos que RDO (fecha) y WLP (ubicación) inyectan en el
// ENCABEZADO del modal "Recibir piezas del cliente".
// Run: node --test tools/test/receive-modal-anchor-core.test.js
//
// POR QUÉ EXISTE ESTE CORE (incidente 2026-08-03, reportado desde piso):
//   Ambos applets subían del <p> del label a su contenedor con `p.closest('.css-iyrxkt')`.
//   `css-iyrxkt` es una clase GENERADA por emotion: su hash cambia cuando SH toca el estilo,
//   sin que cambie el idioma ni nada visible. SH rehizo el encabezado —de un GRID de 2
//   columnas a una FILA flex con un wrapper por campo— y esa clase dejó de existir:
//   medido en vivo, `.css-iyrxkt` → 0 ocurrencias y `.css-xd9ivb` → 0.
//   `closest()` devolvía null y los dos applets hacían `return` en silencio: los scripts
//   cargaban, el modal se detectaba (`data-sa-rdo-attached="true"`) y aun así no se pintaba
//   ni la fecha ni la ubicación.
//
// LA REGLA QUE FIJA: se entra por el TEXTO del label (ES+EN — este modal no expone ni un
//   `data-steelhead-component-id` ni un `data-testid`: medido, 0 de cada uno, así que el
//   nivel 1 de la jerarquía de anclaje NO está disponible aquí), pero se SUBE por RELACIÓN
//   ESTRUCTURAL (padre/hijos), nunca por el nombre de una clase generada. Y las clases de
//   presentación se HEREDAN del vecino vivo en vez de hardcodearse, para que el próximo
//   rehash de emotion nos siga vistiendo igual.

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/receive-modal-anchor-core.js');

// ── Simulador de nodo mínimo: sólo lo que el core toca (tagName, className, children,
// parentElement). Sin jsdom, igual que el resto de la suite.
function el(tagName, className, children) {
  const node = {
    tagName: tagName.toUpperCase(),
    className: className || '',
    children: [],
    parentElement: null,
    textContent: '',
  };
  for (const c of children || []) { c.parentElement = node; node.children.push(c); }
  return node;
}
function p(className, text) { const n = el('p', className); n.textContent = text; return n; }

// ── FIXTURE A — layout NUEVO, medido en vivo el 2026-08-03 (dominio Ecoplating TLC).
// Fila `.css-bomumo` (flex, nowrap) con 4 columnas de `flex: 1 1 0%`; cada campo es un
// `.css-1xauu9w` (flex column) con su <p> label + su control. Dos columnas van vacías.
function fixtureFlex() {
  const pCli = p('MuiTypography-root MuiTypography-body1 css-fyswvn', 'Cliente:');
  const pCom = p('MuiTypography-root MuiTypography-body1 css-fyswvn', 'Comentarios del receptor:');
  const wrapCli = el('div', 'css-1xauu9w', [pCli, el('div', '')]);
  const wrapCom = el('div', 'css-1xauu9w', [pCom, el('div', '')]);
  const spacer = el('div', 'css-13pmxen', []);
  const emptySlot = el('div', 'css-1xauu9w', []);
  const row = el('div', 'css-bomumo', [wrapCli, spacer, wrapCom, emptySlot]);
  return { row, wrapCli, wrapCom, pCli, pCom, spacer, emptySlot };
}

// ── FIXTURE B — un contenedor que agrupa VARIOS labels. No es el layout viejo de SH (ver
// fixtureLegacySH abajo): es el caso genérico que obliga a NO tratar al padre como si fuera
// el wrapper de un solo campo, porque agregarle un hermano lo pondría fuera del grupo.
function fixtureGrid() {
  const pCli = p('MuiTypography-root MuiTypography-body1 css-9l3uo3', 'Cliente:');
  const pCom = p('MuiTypography-root MuiTypography-body1 css-9l3uo3', 'Comentarios del receptor:');
  const grid = el('div', 'css-iyrxkt', [pCli, el('div', ''), pCom, el('div', '')]);
  const outer = el('div', 'css-outer', [grid]);
  return { grid, outer, pCli, pCom };
}

// ── FIXTURE C — el layout VIEJO REAL de SH, tal como lo documentó la bitácora de
// receiver-date-override 0.5.67/0.5.80: un row container `.css-xd9ivb` flex-row que contenía
// VARIOS `.css-iyrxkt`, y cada uno de ésos era un grid `auto 1fr` con UN label y su control.
// Se conserva para que, si SH revierte, el anclaje siga resolviendo.
function fixtureLegacySH() {
  const pCli = p('MuiTypography-root MuiTypography-body1 css-9l3uo3', 'Cliente:');
  const pCom = p('MuiTypography-root MuiTypography-body1 css-9l3uo3', 'Comentarios del receptor:');
  const gridCli = el('div', 'css-iyrxkt', [pCli, el('div', '')]);
  const gridCom = el('div', 'css-iyrxkt', [pCom, el('div', '')]);
  const rowFlex = el('div', 'css-xd9ivb', [gridCli, gridCom]);
  return { rowFlex, gridCli, gridCom, pCli, pCom };
}

// ---------- findHeaderFieldAnchor: layout FLEX (el vigente) ----------

test('flex: ancla el contenedor de inserción a la FILA, no al wrapper del campo', () => {
  const f = fixtureFlex();
  const a = Core.findHeaderFieldAnchor(f.pCli);
  assert.equal(a.mode, 'sibling');
  assert.equal(a.container, f.row, 'el campo nuevo va como hermano dentro de la fila');
  assert.equal(a.fieldWrapper, f.wrapCli);
});

test('flex: HEREDA las clases del vecino vivo en vez de hardcodearlas', () => {
  const f = fixtureFlex();
  const a = Core.findHeaderFieldAnchor(f.pCli);
  assert.equal(a.wrapperClass, 'css-1xauu9w');
  assert.equal(a.labelClass, 'MuiTypography-root MuiTypography-body1 css-fyswvn');
});

test('flex: funciona igual entrando por Comentarios del receptor (ancla de WLP)', () => {
  const f = fixtureFlex();
  const a = Core.findHeaderFieldAnchor(f.pCom);
  assert.equal(a.mode, 'sibling');
  assert.equal(a.container, f.row);
  assert.equal(a.fieldWrapper, f.wrapCom);
});

// ---------- findHeaderFieldAnchor: layout GRID (el legado) ----------

test('grid: cae al modo legado — el contenedor ES el grid que tiene los labels', () => {
  const g = fixtureGrid();
  const a = Core.findHeaderFieldAnchor(g.pCli);
  assert.equal(a.mode, 'grid');
  assert.equal(a.container, g.grid, 'en el grid viejo se agregaban filas al MISMO contenedor');
  assert.equal(a.labelClass, 'MuiTypography-root MuiTypography-body1 css-9l3uo3');
});

test('grid: NO trepa a un ancestro de más — el contenedor no es el outer', () => {
  const g = fixtureGrid();
  const a = Core.findHeaderFieldAnchor(g.pCli);
  assert.notEqual(a.container, g.outer);
});

// ---------- El layout VIEJO REAL de SH: debe seguir resolviendo ----------
// Ahí cada campo YA era su propio wrapper (un grid `auto 1fr`), así que el core lo trata por
// el mismo camino 'sibling' que el layout de hoy — y hereda `css-iyrxkt`, cuyo grid coloca
// label y control en sus columnas sin que el applet tenga que fijarlas.

test('layout viejo de SH: resuelve por el camino sibling, heredando el grid del vecino', () => {
  const f = fixtureLegacySH();
  const a = Core.findHeaderFieldAnchor(f.pCli);
  assert.equal(a.mode, 'sibling');
  assert.equal(a.container, f.rowFlex, 'el hermano va en el row flex, junto a los demás campos');
  assert.equal(a.wrapperClass, 'css-iyrxkt', 'hereda el grid auto 1fr que ya sabía acomodar label|control');
});

test('layout viejo de SH: sin huecos libres, crea el hermano (no encima de otro campo)', () => {
  const f = fixtureLegacySH();
  const a = Core.findHeaderFieldAnchor(f.pCli);
  assert.equal(Core.pickInsertionSlot(a), null, 'los dos campos están ocupados');
});

// ---------- El criterio que distingue los dos layouts ----------
// Estructural y puro: un wrapper de CAMPO contiene UN solo <p> label; un GRID contenedor
// contiene VARIOS. No se usa estilo computado — el core debe correr en node.

test('el criterio es el número de labels hijos, no el nombre de la clase', () => {
  // Mismo árbol que el flex vigente pero con clases INVENTADAS: debe seguir resolviendo.
  const pCli = p('zzz-label', 'Cliente:');
  const wrap = el('div', 'zzz-field', [pCli, el('div', '')]);
  const row = el('div', 'zzz-row', [wrap, el('div', 'zzz-field', [p('zzz-label', 'Comentarios del receptor:'), el('div', '')])]);
  const a = Core.findHeaderFieldAnchor(pCli);
  assert.equal(a.mode, 'sibling');
  assert.equal(a.container, row);
  assert.equal(a.wrapperClass, 'zzz-field');
});

// ---------- Fail-safe: sin evidencia, no inventa ----------

test('devuelve null si el label no tiene padre (nodo suelto)', () => {
  assert.equal(Core.findHeaderFieldAnchor(p('x', 'Cliente:')), null);
});

test('devuelve null con entrada nula', () => {
  assert.equal(Core.findHeaderFieldAnchor(null), null);
  assert.equal(Core.findHeaderFieldAnchor(undefined), null);
});

test('un wrapper de campo SIN fila padre no revienta: cae a grid sobre su propio padre', () => {
  // Campo huérfano: <p> dentro de un wrapper que ya no tiene padre.
  const pCli = p('c', 'Cliente:');
  el('div', 'w', [pCli]);
  const a = Core.findHeaderFieldAnchor(pCli);
  assert.ok(a, 'no devuelve null: hay dónde insertar');
  assert.equal(a.mode, 'grid');
});

// ---------- matchLabel: la entrada bilingüe (nivel 2 de la jerarquía) ----------

test('matchLabel: Cliente / Customer', () => {
  assert.equal(Core.matchLabel('Cliente:', Core.LABEL_CUSTOMER), true);
  assert.equal(Core.matchLabel('Customer:', Core.LABEL_CUSTOMER), true);
  assert.equal(Core.matchLabel('customer', Core.LABEL_CUSTOMER), true);
  assert.equal(Core.matchLabel('  Cliente  ', Core.LABEL_CUSTOMER), true);
});

test('matchLabel: Comentarios del receptor / Receiver Comments', () => {
  assert.equal(Core.matchLabel('Comentarios del receptor:', Core.LABEL_RECEIVER_COMMENTS), true);
  assert.equal(Core.matchLabel('Receiver Comments:', Core.LABEL_RECEIVER_COMMENTS), true);
});

test('matchLabel: NO muerde labels vecinos parecidos', () => {
  assert.equal(Core.matchLabel('Comentarios del receptor:', Core.LABEL_CUSTOMER), false);
  assert.equal(Core.matchLabel('Cliente y proveedor:', Core.LABEL_CUSTOMER), false);
  assert.equal(Core.matchLabel('', Core.LABEL_CUSTOMER), false);
  assert.equal(Core.matchLabel(null, Core.LABEL_CUSTOMER), false);
});

// ---------- findLabelNode: recorre los <p> del modal ----------

test('findLabelNode: encuentra el <p> del label dentro del modal', () => {
  const f = fixtureFlex();
  const modal = { querySelectorAll: () => [f.pCli, f.pCom] };
  assert.equal(Core.findLabelNode(modal, Core.LABEL_CUSTOMER), f.pCli);
  assert.equal(Core.findLabelNode(modal, Core.LABEL_RECEIVER_COMMENTS), f.pCom);
});

test('findLabelNode: devuelve null si el label no está', () => {
  const modal = { querySelectorAll: () => [p('x', 'Otra cosa:')] };
  assert.equal(Core.findLabelNode(modal, Core.LABEL_CUSTOMER), null);
});

// ---------- pickInsertionSlot: aprovechar los huecos que SH ya deja ----------
// La fila es flex nowrap con columnas de `flex: 1 1 0%`: cada columna nueva angosta a todas
// las demás. Reusar un hueco existente evita apretar el encabezado.

test('pickInsertionSlot: reusa una columna vacía de la fila', () => {
  const f = fixtureFlex();
  const a = Core.findHeaderFieldAnchor(f.pCli);
  const slot = Core.pickInsertionSlot(a);
  assert.ok(slot === f.spacer || slot === f.emptySlot, 'debe elegir una de las dos vacías');
});

test('pickInsertionSlot: NUNCA devuelve un slot con contenido', () => {
  const f = fixtureFlex();
  const a = Core.findHeaderFieldAnchor(f.pCli);
  const slot = Core.pickInsertionSlot(a);
  assert.notEqual(slot, f.wrapCli);
  assert.notEqual(slot, f.wrapCom, 'el campo de Comentarios NO es un hueco libre');
});

test('pickInsertionSlot: nunca devuelve el wrapper ancla, aunque estuviera vacío', () => {
  const pCli = p('c', 'Cliente:');
  const wrap = el('div', 'w', [pCli]);
  const otro = el('div', 'w2', [p('c', 'Comentarios del receptor:')]);
  el('div', 'row', [wrap, otro]);
  const a = Core.findHeaderFieldAnchor(pCli);
  assert.notEqual(Core.pickInsertionSlot(a), wrap);
});

test('pickInsertionSlot: devuelve null si la fila está llena (se creará un hermano)', () => {
  const pCli = p('c', 'Cliente:');
  const wrap = el('div', 'w', [pCli, el('div', '')]);
  const wCom = el('div', 'w', [p('c', 'Comentarios del receptor:'), el('div', '')]);
  el('div', 'row', [wrap, wCom]);
  const a = Core.findHeaderFieldAnchor(pCli);
  assert.equal(Core.pickInsertionSlot(a), null);
});

test('pickInsertionSlot: no aplica en modo grid', () => {
  const g = fixtureGrid();
  assert.equal(Core.pickInsertionSlot(Core.findHeaderFieldAnchor(g.pCli)), null);
});

test('pickInsertionSlot: tolera entrada nula', () => {
  assert.equal(Core.pickInsertionSlot(null), null);
});

// ---------- mountHeaderField ----------
// Vive en el core a propósito: que RDO y WLP tuvieran copias separadas del mismo anclaje es
// lo que hizo que los dos se rompieran igual, en silencio y el mismo día.

function appendable(tag, cls) {
  const n = el(tag, cls);
  n.style = {};
  n.appendChild = function (c) { c.parentElement = this; this.children.push(c); };
  return n;
}
function fakeDoc() {
  return { createElement: (t) => appendable(t, '') };
}
function withAppend(node) {
  node.appendChild = function (c) { c.parentElement = this; this.children.push(c); };
  node.insertBefore = function (c, ref) {
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    c.parentElement = this;
  };
  return node;
}

test('mountHeaderField (flex): reusa el hueco y NO agrega una columna a la fila', () => {
  const f = fixtureFlex();
  withAppend(f.row); withAppend(f.spacer); withAppend(f.emptySlot);
  const antes = f.row.children.length;
  const a = Core.findHeaderFieldAnchor(f.pCli);
  const host = Core.mountHeaderField(fakeDoc(), a, appendable('p', 'l'), appendable('div', 'c'));
  assert.equal(f.row.children.length, antes, 'la fila no debe crecer si había hueco');
  assert.equal(host.children.length, 2, 'label + controles quedaron dentro del hueco');
});

test('mountHeaderField (flex): si NO hay hueco, crea un hermano junto al campo ancla', () => {
  const pCli = p('c', 'Cliente:');
  const wrap = withAppend(el('div', 'css-field', [pCli, el('div', 'x')]));
  const wCom = el('div', 'css-field', [p('c', 'Comentarios del receptor:'), el('div', 'x')]);
  const row = withAppend(el('div', 'css-row', [wrap, wCom]));
  const a = Core.findHeaderFieldAnchor(pCli);
  const host = Core.mountHeaderField(fakeDoc(), a, appendable('p', 'l'), appendable('div', 'c'));
  assert.equal(row.children.length, 3, 'la fila crece en uno');
  assert.equal(host.className, 'css-field', 'hereda la clase del vecino vivo');
  assert.equal(row.children[1], host, 'queda junto al campo ancla, no al final');
});

test('mountHeaderField (grid): usa las columnas del grid legado', () => {
  const g = fixtureGrid();
  withAppend(g.grid);
  const a = Core.findHeaderFieldAnchor(g.pCli);
  const label = appendable('p', 'l'), controls = appendable('div', 'c');
  Core.mountHeaderField(fakeDoc(), a, label, controls);
  assert.equal(label.style.gridColumn, '1');
  assert.equal(controls.style.gridColumn, '2');
  assert.equal(g.grid.children.length, 6, 'label y controles se agregaron al grid');
});

test('mountHeaderField: sin anclaje no monta nada y no revienta', () => {
  assert.equal(Core.mountHeaderField(fakeDoc(), null, appendable('p', ''), appendable('div', '')), null);
  assert.equal(Core.mountHeaderField(null, {}, appendable('p', ''), appendable('div', '')), null);
});

// ---------- findControlNearLabel ----------
// Localiza el combo NATIVO de un campo del encabezado (Grupo de Piezas, Contenedor) sin
// depender de `.css-iyrxkt` / `.css-xd9ivb`, que hoy no existen.

// query que imita querySelector('[class*="-control"]') sobre el simulador
function qControl(node) {
  const found = [];
  (function walk(n) { for (const c of n.children || []) { if (/-control/.test(c.className)) found.push(c); walk(c); } })(node);
  return found[0] || null;
}

test('findControlNearLabel: encuentra el control del MISMO campo', () => {
  const lbl = el('span', 'lbl'); lbl.textContent = 'Contenedor:';
  const ctrl = el('div', 'css-abc-control');
  const campo = el('div', 'campo', [lbl, ctrl]);
  el('div', 'fila', [campo]);
  assert.equal(Core.findControlNearLabel(lbl, qControl), ctrl);
});

test('findControlNearLabel: NO se cruza al campo vecino si el label no tiene control propio', () => {
  // El label vive solo en su bloque; el control del vecino NO debe ganarle al del padre.
  const lbl = el('span', 'lbl'); lbl.textContent = 'Contenedor:';
  const bloqueLabel = el('div', 'solo-label', [lbl]);
  const propio = el('div', 'css-mio-control');
  const campo = el('div', 'campo', [bloqueLabel, propio]);
  const vecino = el('div', 'campo2', [el('div', 'css-otro-control')]);
  el('div', 'fila', [campo, vecino]);
  const hit = Core.findControlNearLabel(lbl, qControl);
  assert.equal(hit, propio, 'debe ganar el control del ancestro más cercano');
});

test('findControlNearLabel: devuelve null si no hay control en el camino', () => {
  const lbl = el('span', 'lbl'); lbl.textContent = 'Contenedor:';
  el('div', 'campo', [lbl]);
  assert.equal(Core.findControlNearLabel(lbl, qControl), null);
});

test('findControlNearLabel: respeta el tope de niveles y tolera entradas nulas', () => {
  const lbl = el('span', 'lbl');
  let n = lbl;
  for (let i = 0; i < 5; i++) n = el('div', 'w' + i, [n]);
  el('div', 'raiz', [n, el('div', 'css-lejos-control')]);
  assert.equal(Core.findControlNearLabel(lbl, qControl, 2), null, 'con tope 2 no debe llegar');
  assert.equal(Core.findControlNearLabel(null, qControl), null);
  assert.equal(Core.findControlNearLabel(lbl, null), null);
});

// ---------- Regresión del incidente: el ancla vieja NO debe volver ----------

test('REGRESIÓN 2026-08-03: resuelve aunque NINGUNA clase css-* legada exista', () => {
  // Éste es exactamente el DOM que se midió el día del reporte: sin css-iyrxkt, sin css-xd9ivb.
  const f = fixtureFlex();
  const clases = [];
  (function walk(n) { clases.push(n.className); (n.children || []).forEach(walk); })(f.row);
  assert.ok(!clases.some(c => /css-iyrxkt|css-xd9ivb/.test(c)), 'el fixture no debe traer las clases viejas');
  const a = Core.findHeaderFieldAnchor(f.pCli);
  assert.ok(a && a.container, 'con el DOM del incidente el anclaje DEBE resolver');
});

// ── firstMounted: un intento que no montó no consume el turno del siguiente ─────────
// Regresión 2026-08-07 (`receiver-date-override`, reporte de piso "el campo de fecha es
// intermitente en los equipos Windows"): el scan hacía `return` en cuanto RESOLVÍA un
// contenedor, montara o no. Si el primer heading que matchea resuelve un contenedor
// equivocado, el applet se quedaba reintentando con ÉSE cada vez y nunca probaba el modal
// bueno — falla permanente que depende del orden del DOM.
test('firstMounted sigue con el siguiente candidato cuando el primero NO monta', () => {
  const intentos = [];
  const montado = Core.firstMounted(['malo', 'bueno', 'otro'], (c) => {
    intentos.push(c);
    return c === 'bueno';
  });
  assert.equal(montado, 'bueno');
  assert.deepEqual(intentos, ['malo', 'bueno'], 'para en cuanto uno monta, sin seguir de largo');
});

test('firstMounted devuelve null si ninguno monta (y los probó TODOS)', () => {
  const intentos = [];
  const montado = Core.firstMounted(['a', 'b', 'c'], (c) => { intentos.push(c); return false; });
  assert.equal(montado, null);
  assert.deepEqual(intentos, ['a', 'b', 'c']);
});

test('firstMounted tolera entradas vacías o inválidas', () => {
  assert.equal(Core.firstMounted(null, () => true), null);
  assert.equal(Core.firstMounted([], () => true), null);
  assert.equal(Core.firstMounted(['x'], null), null);
  assert.equal(Core.firstMounted([null, 'x'], (c) => c === 'x'), 'x', 'un candidato nulo no aborta el recorrido');
});
