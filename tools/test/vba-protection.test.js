#!/usr/bin/env node
/**
 * Lint estructural de los módulos VBA de las plantillas de carga masiva.
 *
 * Existe porque el VBA de las plantillas NO se puede ejecutar desde aquí: vive dentro de un
 * .xlsm y sólo Excel lo compila. Cuando el 2026-08-07 se agregó el par desproteger/reproteger
 * a las cinco macros, la única alternativa a "se ve bien" era esto — comprobar mecánicamente
 * lo que sí se puede comprobar leyendo el texto.
 *
 * Lo que ESTE test prueba:
 *   1. Bloques balanceados (Sub/Function, If, For, Do, With, Select).
 *   2. Toda etiqueta de `On Error GoTo X` / `GoTo X` existe como `X:` en el MISMO procedimiento.
 *   3. Cada `SA_Desproteger` tiene su `SA_Proteger` en el mismo procedimiento.
 *   4. Ningún `Exit Sub` queda ATRAPADO entre un SA_Desproteger y su SA_Proteger —
 *      ése es el bug que dejaría la plantilla abierta sin que nadie se entere.
 *   5. Toda función SA_* invocada existe y es Public en ModProteccion.bas.
 *   6. Ninguna declaración de módulo (Dim/Private/Public/Const/Type/Option/Enum/Declare)
 *      aparece DESPUÉS del primer procedimiento. VBA las exige todas en la sección de
 *      declaraciones, arriba; una sola línea fuera de lugar tumba la compilación del módulo
 *      entero con "Only comments may appear after End Sub, End Function, or End Property".
 *      Esta regla se agregó porque Excel encontró el error que este test dejó pasar: se había
 *      declarado `Private mHuellaPrevia As String` junto al Sub que la usa, que es donde uno
 *      la escribiría en cualquier otro lenguaje.
 *
 * Lo que NO prueba (y por lo tanto no debe darse por bueno sin abrir Excel):
 *   que el VBA COMPILE, que los rangos existan, que la protección se comporte como se espera
 *   en Excel para Mac, ni que UserInterfaceOnly sobreviva a lo que haga el usuario.
 *   El juez de un .xlsm es Excel, no este script.
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const VBAS = path.join(__dirname, '..', '..', 'vbas');
const MODULOS = [
  'Module1.bas', 'Module1_compat.bas', 'Module5_v19.bas',
  'Module2.txt', 'Module4.txt', 'ModProteccion.bas',
  'ThisWorkbook.txt', 'Sheet_Upload.txt', 'ModDiagnostico.bas',
];

let problemas = [];
const fail = (f, msg) => problemas.push(`${f}: ${msg}`);

/** Quita comentarios y strings para no contar palabras clave que viven dentro de texto. */
function limpiar(linea) {
  let out = '', enStr = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') { enStr = !enStr; out += ' '; continue; }
    if (!enStr && ch === "'") break;          // comentario hasta fin de línea
    out += enStr ? ' ' : ch;
  }
  return out;
}

/** Une las continuaciones de línea ( _ al final) para analizar sentencias completas. */
function sentencias(texto) {
  const crudo = texto.split(/\r?\n/);
  const out = [];
  let acc = '', inicio = 0;
  crudo.forEach((raw, i) => {
    const l = limpiar(raw);
    if (!acc) inicio = i + 1;
    if (/\s_\s*$/.test(l)) { acc += l.replace(/\s_\s*$/, ' '); return; }
    out.push({ n: inicio, t: (acc + l).trim(), raw });
    acc = '';
  });
  if (acc) out.push({ n: inicio, t: acc.trim(), raw: '' });
  return out;
}

function revisar(archivo) {
  const full = path.join(VBAS, archivo);
  if (!fs.existsSync(full)) return fail(archivo, 'no existe');
  const st = sentencias(fs.readFileSync(full, 'utf8'));

  // ── 1) Balanceo de bloques ────────────────────────────────────────────────
  let proc = 0, iff = 0, forr = 0, doo = 0, wth = 0, sel = 0;
  let procNombre = null;
  // Estado por procedimiento para las reglas 2-4.
  // `eventos` va en orden de aparición: así "¿hay un Exit Sub con la hoja abierta?" se
  // contesta con un simple recorrido, en vez de comparando contra el ÚLTIMO SA_Proteger
  // del procedimiento (que suele ser el del manejador de error, muy por debajo del
  // Exit Sub del camino feliz — y hacía saltar la alarma en código correcto).
  let etiquetas = new Set(), gotos = [], eventos = [], huboDesproteger = false;
  const cerrarProc = () => {
    if (!procNombre) return;
    gotos.forEach(g => {
      if (!etiquetas.has(g.label)) fail(archivo, `línea ${g.n}: GoTo ${g.label} sin etiqueta "${g.label}:" en ${procNombre}`);
    });
    if (huboDesproteger && !eventos.some(e => e.tipo === 'proteger')) {
      fail(archivo, `${procNombre}: llama SA_Desproteger y NUNCA SA_Proteger — la plantilla quedaría abierta`);
    }
    let abierto = null;
    for (const e of eventos) {
      if (e.tipo === 'desproteger') abierto = e.n;
      else if (e.tipo === 'proteger') abierto = null;
      else if (e.tipo === 'exit' && abierto !== null) {
        fail(archivo, `línea ${e.n}: "Exit Sub" con la hoja DESPROTEGIDA (SA_Desproteger en ${abierto}) en ${procNombre} — saldría sin reproteger`);
      }
    }
    procNombre = null; etiquetas = new Set(); gotos = []; eventos = []; huboDesproteger = false;
  };

  let vistoAlgunProc = false;
  for (const { n, t } of st) {
    if (!t) continue;
    const decl = t.match(/^(?:Public\s+|Private\s+|Friend\s+)?(?:Static\s+)?(Sub|Function|Property)\s+(\w+)/i);
    if (decl) { cerrarProc(); proc++; procNombre = decl[2]; vistoAlgunProc = true; continue; }
    if (/^End\s+(Sub|Function|Property)\b/i.test(t)) { proc--; cerrarProc(); continue; }

    // 6) Declaración de módulo fuera de la sección de declaraciones.
    // Sólo cuenta si estamos FUERA de un procedimiento (procNombre === null): un `Dim`
    // dentro de un Sub es una variable local perfectamente normal.
    if (procNombre === null && vistoAlgunProc &&
        /^(?:Public|Private|Friend|Global)\s+(?!Sub\b|Function\b|Property\b|Declare\b)|^(?:Dim|Const|Type|Enum|Option|Declare)\b/i.test(t)) {
      fail(archivo, `línea ${n}: declaración de módulo después del primer procedimiento — VBA sólo admite comentarios ahí ("${t.slice(0, 60)}")`);
    }

    // If de una sola línea (Then con algo después) NO abre bloque.
    const mIf = t.match(/^If\b.*\bThen\b(.*)$/i);
    if (mIf) { if (!mIf[1].trim()) iff++; }
    else if (/^End\s+If\b/i.test(t)) iff--;
    else if (/^ElseIf\b/i.test(t)) { /* neutro */ }

    // VBA permite varias sentencias por línea separadas por ":", incluyendo bucles
    // completos (`For Each ch In inv: ... : Next`). Se cuentan TODAS las apariciones al
    // inicio de cada sentencia, no sólo la primera de la línea.
    const cuenta = (re) => (t.match(re) || []).length;
    forr += cuenta(/(?:^|:)\s*For\b/gi) - cuenta(/(?:^|:)\s*Next\b/gi);
    doo += cuenta(/(?:^|:)\s*Do\b/gi) - cuenta(/(?:^|:)\s*Loop\b/gi);
    wth += cuenta(/(?:^|:)\s*With\b/gi) - cuenta(/(?:^|:)\s*End\s+With\b/gi);
    sel += cuenta(/(?:^|:)\s*Select\s+Case\b/gi) - cuenta(/(?:^|:)\s*End\s+Select\b/gi);

    // Etiquetas. VBA acepta código en la MISMA línea que la etiqueta ("no: CollHas = False"),
    // así que no se puede exigir que esté sola. Una asignación no se confunde: "x = 1" no
    // trae ":" pegado al identificador.
    const lbl = t.match(/^([A-Za-z_]\w*):(?!=)/);
    if (lbl) etiquetas.add(lbl[1]);

    const g = t.match(/\bGoTo\s+([A-Za-z_]\w*)/i);
    if (g && g[1].toLowerCase() !== '0') gotos.push({ n, label: g[1] });

    // El orden importa: dentro de una misma línea puede haber desproteger y Exit Sub.
    if (/\bSA_Desproteger\b/.test(t)) { eventos.push({ n, tipo: 'desproteger' }); huboDesproteger = true; }
    if (/\bSA_Proteger\b/.test(t)) eventos.push({ n, tipo: 'proteger' });
    if (/\bExit\s+Sub\b/i.test(t)) eventos.push({ n, tipo: 'exit' });
  }
  cerrarProc();

  const chk = (v, nom) => { if (v !== 0) fail(archivo, `bloques ${nom} desbalanceados (saldo ${v})`); };
  chk(proc, 'Sub/Function'); chk(iff, 'If/End If'); chk(forr, 'For/Next');
  chk(doo, 'Do/Loop'); chk(wth, 'With/End With'); chk(sel, 'Select/End Select');
}

/**
 * 7) Ningún identificador declarado choca con una palabra reservada de VBA.
 *
 * VBA es CASE-INSENSITIVE, así que `eNum` ES `Enum` y `Dim eNum As Long` revienta con un
 * escueto "Syntax error" que no nombra la palabra culpable. Un identificador que se lee
 * distinto al leerlo en voz alta puede ser el mismo para el compilador — y en camelCase,
 * que es como se nombra en este proyecto, la colisión queda invisible.
 *
 * La lista es CONSERVADORA a propósito: sólo palabras que VBA rechaza como nombre en
 * cualquier contexto. Quedan fuera las contextuales (`Name`, `Line`, `Text`, `Step`,
 * `Base`, `Time`…) y las funciones de librería (`Left`, `Mid`, `Format`, `Str`), que son
 * legales como identificador aunque sean mala idea: marcarlas produciría ruido y el ruido
 * hace que se ignore el test.
 */
const RESERVADAS = new Set([
  'and', 'as', 'boolean', 'byref', 'byte', 'byval', 'call', 'case', 'const', 'currency',
  'date', 'declare', 'dim', 'do', 'double', 'each', 'else', 'elseif', 'empty', 'end',
  'enum', 'eqv', 'erase', 'event', 'exit', 'false', 'for', 'friend', 'function', 'get',
  'global', 'gosub', 'goto', 'if', 'imp', 'implements', 'in', 'integer', 'is', 'let',
  'like', 'long', 'loop', 'me', 'mod', 'new', 'next', 'not', 'nothing', 'null', 'object',
  'on', 'option', 'optional', 'or', 'paramarray', 'preserve', 'private', 'property',
  'public', 'raiseevent', 'redim', 'rem', 'resume', 'return', 'select', 'set', 'single',
  'static', 'stop', 'string', 'sub', 'then', 'to', 'true', 'type', 'typeof', 'until',
  'variant', 'wend', 'while', 'with', 'withevents', 'xor',
]);

function revisarReservadas(archivo) {
  const full = path.join(VBAS, archivo);
  if (!fs.existsSync(full)) return;
  for (const { n, t } of sentencias(fs.readFileSync(full, 'utf8'))) {
    if (!t) continue;
    const nombres = [];

    // Dim / Const / Static / Private / Public a nivel de declaración.
    //
    // `Dim` y `Static` van SIN lookahead a propósito. La primera versión llevaba uno solo
    // para las dos ramas —`(?:Dim|Private|…)\s+(?!Sub\b|…|Enum\b|…)`— y con el flag `i` la
    // alternativa `Enum\b` matcheaba `eNum`, así que la línea `Dim eNum As Long` quedaba
    // DESCARTADA por el propio filtro que debía delatarla. El test cayó en el bug que
    // buscaba, y por eso pasó en verde con tres módulos rotos.
    const mDecl = /^(?:Dim|Static)\s+/i.test(t)
      ? t.match(/^(?:Dim|Static)\s+(.+)$/i)
      : t.match(/^(?:Private|Public|Global|Friend)\s+(?!Sub\s|Function\s|Property\s|Declare\s|Type\s|Enum\s|Const\s|WithEvents\s)(.+)$/i);
    if (mDecl) {
      for (const parte of mDecl[1].split(',')) {
        const id = parte.trim().split(/\s+/)[0];
        if (id) nombres.push(id.replace(/\(\)?.*$/, ''));
      }
    }
    // Parámetros de Sub/Function/Property.
    const mProc = t.match(/^(?:Public\s+|Private\s+|Friend\s+)?(?:Static\s+)?(?:Sub|Function|Property(?:\s+\w+)?)\s+\w+\s*\(([^)]*)\)/i);
    if (mProc && mProc[1].trim()) {
      for (const p of mProc[1].split(',')) {
        const id = p.trim().replace(/^(?:Optional\s+)?(?:ByRef\s+|ByVal\s+|ParamArray\s+)?/i, '').split(/\s+/)[0];
        if (id) nombres.push(id.replace(/\(\)$/, ''));
      }
    }
    // Campos de un Type.
    const mCampo = t.match(/^(\w+)\s+As\s+\w/i);
    if (mCampo && !mDecl && !mProc) nombres.push(mCampo[1]);

    for (const id of nombres) {
      if (RESERVADAS.has(id.toLowerCase())) {
        fail(archivo, `línea ${n}: "${id}" choca con la palabra reservada "${id.toLowerCase()}" (VBA ignora mayúsculas) — Syntax error`);
      }
    }
  }
}

// ── 5) Las SA_* invocadas existen y son Public en ModProteccion ──────────────
function revisarApi() {
  const src = fs.readFileSync(path.join(VBAS, 'ModProteccion.bas'), 'utf8');
  // Las SA_* publicas pueden vivir en ModProteccion O en ModDiagnostico (modulo de
  // soporte). Mirar solo el primero marcaba como rotas las del segundo.
  const diag = fs.existsSync(path.join(VBAS, 'ModDiagnostico.bas'))
    ? fs.readFileSync(path.join(VBAS, 'ModDiagnostico.bas'), 'utf8') : '';
  const publicas = new Set([...(src + '\n' + diag).matchAll(/^Public\s+(?:Sub|Function)\s+(SA_\w+)/gim)].map(m => m[1]));
  const constantes = new Set([...src.matchAll(/^Public\s+Const\s+(SA_\w+)/gim)].map(m => m[1]));
  for (const archivo of MODULOS) {
    const full = path.join(VBAS, archivo);
    if (!fs.existsSync(full)) continue;
    const txt = fs.readFileSync(full, 'utf8');
    for (const { t, n } of sentencias(txt)) {
      for (const m of t.matchAll(/\b(SA_\w+)\b/g)) {
        const nombre = m[1];
        if (publicas.has(nombre) || constantes.has(nombre)) continue;
        // dentro del propio ModProteccion pueden ser privadas / tipos / variables
        if (archivo === 'ModProteccion.bas') continue;
        fail(archivo, `línea ${n}: usa ${nombre}, que no es Public en ModProteccion.bas`);
      }
    }
  }
  const requeridas = ['SA_Desproteger', 'SA_Proteger', 'SA_RehabilitarEscrituraVBA'];
  requeridas.forEach(r => { if (!publicas.has(r)) fail('ModProteccion.bas', `falta la Public ${r}`); });
}

test('VBA: bloques, etiquetas y pares desproteger/reproteger', () => {
  problemas = [];
  MODULOS.forEach(revisar);
  MODULOS.forEach(revisarReservadas);
  revisarApi();
  assert.deepStrictEqual(problemas, [], '\n  - ' + problemas.join('\n  - '));
});

/**
 * Trinquete de sincronía. Los archivos de `vbas/entrega-proteccion/` son los que se importan
 * en Excel: si alguien edita una fuente de `vbas/` y no vuelve a correr
 * `node tools/build-vba-entrega.js`, la plantilla se queda con el código viejo y NADA lo
 * delata — el repo se ve corregido y el .xlsm no lo está. Este test compara byte a byte.
 */
test('VBA: la carpeta de entrega está al día con las fuentes', () => {
  const OUT = path.join(VBAS, 'entrega-proteccion');
  if (!fs.existsSync(OUT)) assert.fail('falta vbas/entrega-proteccion/ — corre: node tools/build-vba-entrega.js');

  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vba-entrega-'));
  // Sólo subdirectorios y sólo archivos VBA: abrir la carpeta en Finder deja un .DS_Store
  // dentro, y un readdir que da por hecho que todo es directorio revienta con ENOTDIR.
  const leerEntrega = (raiz) => {
    const m = new Map();
    for (const d of fs.readdirSync(raiz, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(raiz, d.name))) {
        if (!/\.(bas|txt)$/i.test(f)) continue;
        m.set(`${d.name}/${f}`, fs.readFileSync(path.join(raiz, d.name, f)));
      }
    }
    return m;
  };
  const vivo = leerEntrega(OUT);
  // Regenera en un directorio aparte y compara, sin tocar el del repo.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'build-vba-entrega.js')], {
    env: { ...process.env, VBA_ENTREGA_OUT: tmp }, stdio: 'pipe',
  });
  const nuevo = leerEntrega(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });

  const desfasados = [];
  for (const [k, v] of nuevo) {
    if (!vivo.has(k)) desfasados.push(`falta ${k}`);
    else if (!v.equals(vivo.get(k))) desfasados.push(`desfasado ${k}`);
  }
  for (const k of vivo.keys()) if (!nuevo.has(k)) desfasados.push(`sobra ${k}`);

  assert.deepStrictEqual(desfasados, [],
    '\n  corre: node tools/build-vba-entrega.js\n  - ' + desfasados.join('\n  - '));
});
