#!/usr/bin/env node
/**
 * Genera los archivos VBA listos para importar en el editor de Excel (Alt+F11), a partir de
 * las fuentes versionadas de `vbas/`.
 *
 * Por qué no se entregan los archivos del repo tal cual:
 *
 * 1. ENCODING. Un .bas se importa con la codificación que el editor de VBA suponga, y no
 *    es la misma en Windows que en Mac. Un comentario con "protección" se lee "protecciÃ³n"
 *    o "protecci?n" según dónde caiga. Los archivos de ENTREGA salen en ASCII PURO: así se
 *    ven igual en cualquier equipo. Las fuentes de `vbas/` conservan sus acentos porque son
 *    lo que se lee y se diffea; la transliteración es un paso de empaquetado, no una regla
 *    de estilo.
 *    Los textos que VE EL OPERADOR no se tocan: el proyecto ya los escribe con ChrW(243) y
 *    demás precisamente por esto. Este script FALLA si encuentra un acento dentro de un
 *    literal de string — sería texto de UI que se rompería al importar.
 *
 * 2. Attribute VB_Name. Module2/Module4 se guardan como .txt en el repo y no lo traen; sin
 *    esa línea el editor no sabe cómo nombrar el módulo al importarlo.
 *
 * 3. Un mismo módulo tiene DOS destinos distintos (Module1 normal vs compat) y hay que
 *    entregarlos con el nombre que corresponde a cada plantilla.
 *
 * Uso: node tools/build-vba-entrega.js
 * Salida: vbas/entrega-proteccion/{moderna,compatibilidad}/
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const VBAS = path.join(RAIZ, 'vbas');
// VBA_ENTREGA_OUT deja regenerar en otro directorio sin pisar el del repo: lo usa el
// trinquete de sincronía de tools/test/vba-protection.test.js.
const OUT = process.env.VBA_ENTREGA_OUT || path.join(VBAS, 'entrega-proteccion');

// origen del repo -> [nombre del módulo en VBA, en qué plantillas va]
const PLAN = [
  ['ModProteccion.bas', 'ModProteccion', 'bas', ['moderna', 'compatibilidad']],
  ['Module5_v19.bas', 'Module5', 'bas', ['moderna', 'compatibilidad']],
  ['Module2.txt', 'Module2', 'bas', ['moderna', 'compatibilidad']],
  ['Module4.txt', 'Module4', 'bas', ['moderna', 'compatibilidad']],
  ['Module1.bas', 'Module1', 'bas', ['moderna']],
  ['Module1_compat.bas', 'Module1', 'bas', ['compatibilidad']],
  ['ThisWorkbook.txt', 'ThisWorkbook', 'pegar', ['moderna', 'compatibilidad']],
  ['ModDiagnostico.bas', 'ModDiagnostico', 'bas', ['moderna', 'compatibilidad']],
];

/** Acentos y signos del español + los símbolos que se usan en los comentarios. */
const MAPA = {
  'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n',
  'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U', 'Ü': 'U', 'Ñ': 'N',
  '¿': '', '¡': '', 'º': 'o', 'ª': 'a', '°': ' grados', 'µ': 'u',
  '→': '->', '←': '<-', '⇒': '=>', '—': '--', '–': '-', '…': '...',
  '“': '"', '”': '"', '‘': "'", '’': "'", '«': '<<', '»': '>>',
  '✓': 'OK', '✗': 'X', '⚠': '!', '·': '-', '≠': '!=', '≤': '<=', '≥': '>=',
  '─': '-', '│': '|', '├': '|', '└': '|', '┌': '-', '┐': '-', '┘': '-', '™': '(tm)',
  '§': 'sec.', '﻿': '<BOM>',
};

/**
 * Corta la línea en el primer apóstrofo que esté FUERA de comillas: eso es donde empieza
 * el comentario en VBA. Hace falta porque los comentarios a media línea también traen
 * comillas —`Case 1   ' ... "Dejar como está" -> blanco`— y buscar literales sin recortar
 * primero marcaba como "texto de UI con acento" lo que era prosa dentro de un comentario.
 * Un apóstrofo DENTRO de un string ("no es 'esto'") no abre comentario: por eso hay que
 * llevar la cuenta de las comillas en vez de partir con un regex.
 */
function sinComentario(linea) {
  let enStr = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') enStr = !enStr;
    else if (ch === "'" && !enStr) return linea.slice(0, i);
  }
  return linea;
}

/** Devuelve los tramos que están DENTRO de comillas (los literales de string de VBA). */
function tramosDeString(linea) {
  const tramos = [];
  let inicio = -1;
  for (let i = 0; i < linea.length; i++) {
    if (linea[i] !== '"') continue;
    if (inicio < 0) inicio = i;
    else { tramos.push(linea.slice(inicio + 1, i)); inicio = -1; }
  }
  return tramos;
}

function transliterar(texto, archivo) {
  const problemas = [];
  const salida = texto.split(/\r?\n/).map((linea, i) => {
    // Un acento dentro de un literal de string es texto que verá el operador: se rompería
    // al importar en otra codificación. Se reporta en vez de arreglarse en silencio.
    for (const s of tramosDeString(sinComentario(linea))) {
      const malo = [...s].filter(c => c.charCodeAt(0) > 127);
      if (malo.length) {
        problemas.push(`${archivo}:${i + 1} literal con caracteres no-ASCII (${[...new Set(malo)].join('')}) — usa ChrW(): ${linea.trim().slice(0, 80)}`);
      }
    }
    let out = '';
    for (const ch of linea) {
      if (ch.charCodeAt(0) <= 127) { out += ch; continue; }
      if (ch in MAPA) { out += MAPA[ch]; continue; }
      problemas.push(`${archivo}:${i + 1} caracter sin equivalente ASCII: "${ch}" (U+${ch.charCodeAt(0).toString(16).toUpperCase()})`);
      out += '?';
    }
    return out;
  }).join('\r\n');                       // VBA espera CRLF
  return { salida, problemas };
}

// ── build ───────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
const todosLosProblemas = [];
const generados = { moderna: [], compatibilidad: [] };

for (const [origen, nombreVBA, tipo, destinos] of PLAN) {
  const src = path.join(VBAS, origen);
  if (!fs.existsSync(src)) { todosLosProblemas.push(`falta la fuente ${origen}`); continue; }
  let texto = fs.readFileSync(src, 'utf8');

  if (tipo === 'bas') {
    // Normaliza el Attribute VB_Name al nombre que debe tener DENTRO de la plantilla.
    texto = texto.replace(/^Attribute VB_Name = ".*"\r?\n/, '');
    texto = `Attribute VB_Name = "${nombreVBA}"\n` + texto;
  }

  const { salida, problemas } = transliterar(texto, origen);
  todosLosProblemas.push(...problemas);

  const ext = tipo === 'bas' ? '.bas' : '.txt';
  for (const d of destinos) {
    const dir = path.join(OUT, d);
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, nombreVBA + ext);
    fs.writeFileSync(destino, salida, 'latin1');   // ASCII puro: latin1 == bytes tal cual
    generados[d].push(path.basename(destino) + (tipo === 'pegar' ? '  (PEGAR, no importar)' : ''));
  }
}

// Comprobación final: los archivos escritos deben ser ASCII puro de verdad.
for (const d of Object.keys(generados)) {
  for (const f of fs.readdirSync(path.join(OUT, d))) {
    const buf = fs.readFileSync(path.join(OUT, d, f));
    const malos = [...buf].filter(b => b > 127).length;
    if (malos) todosLosProblemas.push(`${d}/${f}: ${malos} byte(s) fuera de ASCII tras la transliteración`);
  }
}

console.log('build-vba-entrega');
for (const d of ['moderna', 'compatibilidad']) {
  console.log(`\n  vbas/entrega-proteccion/${d}/`);
  generados[d].forEach(f => console.log(`    ${f}`));
}
if (todosLosProblemas.length) {
  console.error('\nPROBLEMAS:');
  todosLosProblemas.forEach(p => console.error('  ✗ ' + p));
  process.exit(1);
}
console.log('\n  ✓ ASCII puro, CRLF, Attribute VB_Name correcto.');
