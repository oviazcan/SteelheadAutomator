#!/usr/bin/env node
/**
 * Arma docs/training/guia-plantilla-v13.html a partir de:
 *   - la PLANTILLA REAL (remote/templates/Plantilla_CargaMasiva_v13.xlsm) — encabezados,
 *     tipos, defaults, bandas de grupo y validaciones se LEEN, no se copian a mano;
 *   - la fuente redactada docs/training/guia-plantilla-v13.src.html, con marcadores.
 *
 * Marcadores admitidos en el .src.html:
 *   {{SVG:<bloque>}}       una "captura" SVG de un tramo de la hoja Upload
 *   {{TABLA:columnas}}     el anexo con las 67 columnas
 *   {{DATO:<clave>}}       una cifra medida (nColsVisibles, nColsCsv, version…)
 *
 * Uso:  node tools/build-guia-v13.js
 */
const fs = require('fs');
const path = require('path');
const { readSheet } = require('./lib/xlsx-read.js');

const ROOT = path.resolve(__dirname, '..');
const XLSM = path.join(ROOT, 'remote/templates/Plantilla_CargaMasiva_v13.xlsm');
const SRC = path.join(ROOT, 'docs/training/guia-plantilla-v13.src.html');
const OUT = path.join(ROOT, 'docs/training/guia-plantilla-v13.html');

// ── Lectura de la plantilla ────────────────────────────────────────────────
const { rows, merges } = readSheet(XLSM, 'Upload', 9);
const BAND = rows[6] || {};   // fila 6: bandas de grupo (celdas combinadas)
const HEAD = rows[7] || {};   // fila 7: encabezados
const TYPE = rows[8] || {};   // fila 8: tipo de dato
const DEF = rows[9] || {};    // fila 9: valor por omisión / placeholder

// ── Utilidades de columnas ────────────────────────────────────────────────
const colToNum = c => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
const range = (a, b) => { const o = []; for (let i = colToNum(a); i <= colToNum(b); i++) o.push(numToCol(i)); return o; };

const COLS = Object.keys(HEAD).sort((a, b) => colToNum(a) - colToNum(b));
const LAST = COLS[COLS.length - 1];

// Banda de grupo que cubre cada columna, expandiendo los mergeCells de la fila 6.
const BAND_OF = {};
for (const ref of merges) {
  const m = ref.match(/^([A-Z]+)6:([A-Z]+)6$/);
  if (!m) continue;
  const txt = BAND[m[1]];
  if (!txt) continue;
  for (const c of range(m[1], m[2])) BAND_OF[c] = txt;
}
for (const [c, txt] of Object.entries(BAND)) if (!BAND_OF[c]) BAND_OF[c] = txt;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text, width, size) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (test.length * size * 0.53 > width && line) { out.push(line); line = w; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

// tipo de la fila 8 → clase de relleno de la celda
const FILL = { 'Desp.': 'dropdown', 'Calc.': 'calc', 'Calc/#': 'calc', '#': 'edit', 'Texto': 'edit', '$': 'edit', 'V/F': 'edit' };

// ── El dibujante de "hoja de Excel" ───────────────────────────────────────
// Ancho de la caja donde vive el SVG (el figure dentro de .wrap). Se reparte entre las
// columnas del bloque: si son pocas quedan anchas, si son muchas se angostan hasta un
// mínimo legible. Pasado ese mínimo el figure hace scroll, que es preferible a que el
// navegador escale el dibujo hasta volver la letra ilegible.
const CANVAS = 1020, COL_MIN = 86, COL_MAX = 176;

function sheetSVG({ cols, title, example = {}, highlight = [], notes = [], colW, showBand = true }) {
  const HW = 34;
  const auto = Math.round((CANVAS - HW) / cols.length);
  const w1 = colW || Math.max(COL_MIN, Math.min(COL_MAX, auto));
  const W = cols.map(() => w1);
  const xs = []; let acc = HW;
  for (const w of W) { xs.push(acc); acc += w; }
  const totalW = acc + 1;

  const H_COLBAR = 22, H_BAND = 22, H_HEAD = 56, H_TYPE = 20, H_DATA = 46;
  let y = 0;
  const bands = [];
  bands.push({ kind: 'colbar', y, h: H_COLBAR }); y += H_COLBAR;
  if (showBand) { bands.push({ kind: 'band', y, h: H_BAND, row: 6 }); y += H_BAND; }
  bands.push({ kind: 'head', y, h: H_HEAD, row: 7 }); y += H_HEAD;
  bands.push({ kind: 'type', y, h: H_TYPE, row: 8 }); y += H_TYPE;
  bands.push({ kind: 'data', y, h: H_DATA, row: 9 }); y += H_DATA;
  const gridH = y;

  const noteLines = notes.map(n => wrap(n.text, totalW - 44, 12.5));
  const noteH = notes.length ? noteLines.reduce((s, l) => s + l.length * 17, 0) + notes.length * 9 + 8 : 0;
  const totalH = gridH + noteH + 2;

  const P = [];
  P.push(`<svg viewBox="0 0 ${totalW} ${totalH}" width="100%" style="min-width:${Math.min(totalW, CANVAS)}px" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg" class="xl">`);
  P.push(`<style>
    .xl text{font-family:var(--sans)}
    .xl .cellbg{fill:var(--xl-cell)} .xl .cellbg.dropdown{fill:var(--xl-drop)}
    .xl .cellbg.calc{fill:var(--xl-calc)} .xl .cellbg.edit{fill:var(--xl-edit)}
    .xl .barbg{fill:var(--xl-bar)} .xl .headbg{fill:var(--xl-head)} .xl .bandbg{fill:var(--xl-band)}
    .xl .gl{stroke:var(--xl-line);stroke-width:1}
    .xl .colL{font-size:11px;font-weight:600;fill:var(--xl-bar-ink)}
    .xl .rowL{font-size:10.5px;font-weight:600;fill:var(--xl-bar-ink)}
    .xl .bn{font-size:10px;font-weight:800;fill:var(--xl-band-ink);letter-spacing:.06em}
    .xl .hd{font-size:11.5px;font-weight:700;fill:var(--xl-head-ink)}
    .xl .ty{font-size:10px;fill:var(--xl-mut);font-style:italic}
    .xl .dt{font-size:11.5px;fill:var(--xl-ink)} .xl .dt.ph{fill:var(--xl-mut);font-style:italic}
    .xl .hl{fill:none;stroke:var(--xl-hl);stroke-width:2.5}
    .xl .badge{fill:var(--xl-hl)} .xl .badgeT{font-size:11px;font-weight:700;fill:#fff}
    .xl .note{font-size:12.5px;fill:var(--xl-mut)} .xl .noteN{font-size:11px;font-weight:700;fill:#fff}
  </style>`);

  P.push(`<rect x="0" y="0" width="${totalW}" height="${gridH}" class="cellbg"/>`);
  P.push(`<rect x="0" y="0" width="${totalW}" height="${H_COLBAR}" class="barbg"/>`);
  P.push(`<rect x="0" y="0" width="${HW}" height="${gridH}" class="barbg"/>`);
  cols.forEach((c, i) => P.push(`<text class="colL" x="${xs[i] + W[i] / 2}" y="${H_COLBAR / 2 + 4}" text-anchor="middle">${c}</text>`));

  for (const b of bands) {
    if (b.kind === 'colbar') continue;
    P.push(`<text class="rowL" x="${HW / 2}" y="${b.y + b.h / 2 + 4}" text-anchor="middle">${b.row}</text>`);

    if (b.kind === 'band') {
      P.push(`<rect x="${HW}" y="${b.y}" width="${totalW - HW}" height="${b.h}" class="bandbg"/>`);
      // agrupa columnas contiguas con la misma banda y centra el rótulo sobre el tramo
      let i = 0;
      while (i < cols.length) {
        const name = BAND_OF[cols[i]] || '';
        let j = i;
        while (j + 1 < cols.length && (BAND_OF[cols[j + 1]] || '') === name) j++;
        if (name) {
          const x0 = xs[i], x1 = xs[j] + W[j];
          const label = wrap(name, x1 - x0 - 10, 10)[0] || '';
          P.push(`<text class="bn" x="${(x0 + x1) / 2}" y="${b.y + b.h / 2 + 3.5}" text-anchor="middle">${esc(label.toUpperCase())}</text>`);
          if (i > 0) P.push(`<line class="gl" x1="${x0}" y1="${b.y}" x2="${x0}" y2="${b.y + b.h}"/>`);
        }
        i = j + 1;
      }
      continue;
    }

    if (b.kind === 'head') P.push(`<rect x="${HW}" y="${b.y}" width="${totalW - HW}" height="${b.h}" class="headbg"/>`);

    cols.forEach((c, i) => {
      const x = xs[i], w = W[i];
      if (b.kind === 'head') {
        const lines = wrap(HEAD[c] || '', w - 12, 11.5);
        const start = b.y + b.h / 2 - (lines.length - 1) * 6.5 + 4;
        lines.forEach((ln, k) => P.push(`<text class="hd" x="${x + w / 2}" y="${start + k * 13}" text-anchor="middle">${esc(ln)}</text>`));
      } else if (b.kind === 'type') {
        P.push(`<text class="ty" x="${x + w / 2}" y="${b.y + b.h / 2 + 3.5}" text-anchor="middle">${esc(TYPE[c] || '')}</text>`);
      } else if (b.kind === 'data') {
        P.push(`<rect x="${x}" y="${b.y}" width="${w}" height="${b.h}" class="cellbg ${FILL[TYPE[c]] || ''}"/>`);
        // El ejemplo manda cuando está declarado (aunque sea vacío a propósito);
        // si no, se muestra el valor por omisión que trae la plantilla.
        const hasEx = Object.prototype.hasOwnProperty.call(example, c);
        const raw = hasEx ? example[c] : (DEF[c] || '');
        const isPh = !hasEx && /^\(selec/.test(DEF[c] || '');
        const lines = wrap(raw, w - 12, 11.5).slice(0, 3);
        const start = b.y + b.h / 2 - (lines.length - 1) * 7 + 4;
        lines.forEach((ln, k) => P.push(`<text class="dt${isPh ? ' ph' : ''}" x="${x + w / 2}" y="${start + k * 14}" text-anchor="middle">${esc(ln)}</text>`));
      }
    });
  }

  for (const b of bands) P.push(`<line class="gl" x1="0" y1="${b.y}" x2="${totalW}" y2="${b.y}"/>`);
  P.push(`<line class="gl" x1="0" y1="${gridH}" x2="${totalW}" y2="${gridH}"/>`);
  P.push(`<line class="gl" x1="${HW}" y1="0" x2="${HW}" y2="${gridH}"/>`);
  cols.forEach((c, i) => P.push(`<line class="gl" x1="${xs[i] + W[i]}" y1="0" x2="${xs[i] + W[i]}" y2="${gridH}"/>`));

  const yTop = H_COLBAR + (showBand ? H_BAND : 0);
  for (const h of highlight) {
    const i0 = cols.indexOf(h.from), i1 = cols.indexOf(h.to || h.from);
    if (i0 < 0 || i1 < 0) continue;
    const x = xs[i0] - 1, w = xs[i1] + W[i1] - xs[i0] + 2;
    P.push(`<rect class="hl" x="${x}" y="${yTop - 1}" width="${w}" height="${gridH - yTop + 2}" rx="3"/>`);
    if (h.n) {
      P.push(`<circle class="badge" cx="${x}" cy="${yTop - 1}" r="9.5" stroke="var(--xl-cell)" stroke-width="2"/>`);
      P.push(`<text class="badgeT" x="${x}" y="${yTop + 2.5}" text-anchor="middle">${h.n}</text>`);
    }
  }

  let ny = gridH + 19;
  notes.forEach((n, idx) => {
    if (n.n != null) {
      P.push(`<circle class="badge" cx="14" cy="${ny - 4}" r="9"/>`);
      P.push(`<text class="noteN" x="14" y="${ny}" text-anchor="middle">${n.n}</text>`);
    }
    noteLines[idx].forEach((ln, k) => P.push(`<text class="note" x="${n.n != null ? 32 : 6}" y="${ny + k * 17}">${esc(ln)}</text>`));
    ny += noteLines[idx].length * 17 + 9;
  });

  P.push('</svg>');
  return P.join('\n');
}

// ── Ejemplo de renglón (datos ficticios; NUNCA de clientes reales) ─────────
const EX = {
  A: 'Activo con validación', B: 'Sin forzar duplicado', C: '', D: 'Industrias Delta',
  E: 'CN-4471-A', F: 'Conector recto 12 mm', G: '', H: 'Conectores', I: '1200', J: '3.85',
  K: 'PZA', L: 'USD', M: 'V', N: 'Línea 100', O: 'CU', P: 'ESTAÑO', Q: 'MATE', R: '', S: '', T: '',
  U: 'T204 (PLA)-T300 (LES)', V: 'Estañado',
  W: 'Estaño Mate | 3-8 µm', X: '5.5', Y: '', Z: '', AA: '', AB: '', AC: '', AD: '',
  AE: '0.018', AF: '42.5', AG: '', AH: '250',
  AI: 'FL-204-A', AJ: '4', AK: 'FL-205-B', AL: '1', AM: 'BA-300-C', AN: '250',
  AS: 'Cilindro', AT: '0.012', AU: '0.008', AV: '0.008', AW: '0.006', AX: '0.004',
  AY: '', AZ: '0.00041', BA: '', BB: '', BC: '', BD: '', BE: '', BF: '', BG: '',
  BH: 'Empacar en bolsa antiestática de 50 pzas.', BI: 'Cliente pide certificado',
  BJ: 'Q-8841', BK: 'E-221', BL: 'PL-4471-r3', BM: '', BN: '', BO: '',
};

// ── Los bloques de la guía ────────────────────────────────────────────────
const BLOCKS = {};

BLOCKS.identificacion = sheetSVG({
  cols: range('A', 'H'), example: EX,
  title: 'Parámetros e identificación del número de parte',
  highlight: [{ from: 'D', to: 'E', n: 1 }],
  notes: [
    { n: 1, text: 'Cliente y Número de parte son los dos datos obligatorios de cada renglón. El Cliente va por línea: un mismo archivo puede traer varios y se crea una cotización por cada uno.' },
    { text: 'Id SH (columna C) se deja en blanco al dar de alta. Sirve para apuntar a un número de parte concreto cuando ya sabes su identificador en Steelhead.' },
  ],
});

BLOCKS.precio = sheetSVG({
  cols: range('I', 'M'), example: EX,
  title: 'Cantidad, precio, unidad y divisa',
  notes: [
    { text: 'La Divisa va por renglón: en un mismo archivo puede haber líneas en USD y otras en MXN. Precio default en V fija ese precio como el predeterminado del número de parte.' },
  ],
});

BLOCKS.acabados = sheetSVG({
  cols: range('N', 'V'), example: EX,
  title: 'Línea, acabados, proceso y producto',
  highlight: [{ from: 'U', to: 'U', n: 1 }],
  notes: [
    { n: 1, text: 'El Proceso es obligatorio en cada renglón y no tiene valor por omisión. Si falta, ese renglón se reporta como error y no se carga.' },
    { text: 'Si escribes una etiqueta que no existe en el catálogo de Steelhead, el renglón se carga sin esa etiqueta y aparece en el reporte de errores. Etiqueta Planta Schneider es calculada: no se teclea.' },
  ],
});

BLOCKS.specs = sheetSVG({
  cols: range('W', 'AD'), example: EX,
  title: 'Las cuatro especificaciones',
  highlight: [{ from: 'W', to: 'X', n: 1 }],
  notes: [
    { n: 1, text: 'Cada especificación va en pareja: el nombre se elige de la lista y el espesor se calcula solo, a partir del rango que trae ese nombre. No se captura.' },
    { text: 'Un guión en cualquiera de las specs significa REEMPLAZO, no suma: se archivan todas las specs que el número de parte ya tenga y no vengan en el archivo. El panel te lo advierte en ámbar antes de ejecutar.' },
  ],
});

BLOCKS.unidades = sheetSVG({
  cols: range('AE', 'AH'), example: EX,
  title: 'Factores de conversión de unidad',
  notes: [
    { text: 'Son los factores que permiten cotizar por kilo, por área o por metro lineal en vez de por pieza. Mín Pzas Lote aplica un cargo por lote mínimo cuando se captura.' },
  ],
});

BLOCKS.racks = sheetSVG({
  cols: range('AI', 'AS'), example: EX,
  title: 'Los cinco pares de rack de la versión 13',
  highlight: [{ from: 'AI', to: 'AL', n: 1 }, { from: 'AM', to: 'AR', n: 2 }, { from: 'AS', to: 'AS', n: 3 }],
  notes: [
    { n: 1, text: 'Los dos pares que ya existían en la v12, en las mismas columnas AI–AL. Un archivo hecho con la plantilla anterior sigue cayendo aquí.' },
    { n: 2, text: 'Los tres pares nuevos de la v13 (AM–AR). Cada par es "qué rack" más "cuántas piezas caben en él". Los encabezados van numerados del 1 al 5.' },
    { n: 3, text: 'Tipo de Geometría se recorrió de AM (v12) a AS (v13): todo lo que venía después de los racks se movió seis columnas a la derecha.' },
  ],
});

BLOCKS.dimensiones = sheetSVG({
  cols: range('AS', 'AX'), example: EX,
  title: 'Geometría y dimensiones',
  notes: [
    { text: 'La geometría se elige de la lista y las medidas van en METROS. De aquí salen los consumos de materia prima, así que un cero de más se propaga a todo el bloque siguiente.' },
  ],
});

BLOCKS.predictivos = sheetSVG({
  cols: range('AY', 'BG'), example: EX,
  title: 'Consumo predictivo de materias primas',
  notes: [
    { text: 'Las nueve columnas son calculadas: las llena la hoja Cálculo MP con la geometría, las medidas y el espesor de las specs. No se capturan a mano.' },
  ],
});

BLOCKS.empaque = sheetSVG({
  cols: range('BE', 'BL'), example: EX,
  title: 'La columna Instrucciones de Empaque y sus vecinas',
  highlight: [{ from: 'BH', to: 'BH', n: 1 }, { from: 'BI', to: 'BI', n: 2 }],
  notes: [
    { n: 1, text: 'Instrucciones de Empaque (BH), la columna nueva. No es un campo del número de parte: es la instrucción de ese número de parte en el paso "Preparando Embarque en Almacén".' },
    { n: 2, text: 'Notas adicionales (BI) es su vecina y no es lo mismo: esa sí vive en el número de parte. Son columnas contiguas, así que vale la pena comprobar en cuál estás escribiendo.' },
  ],
});

BLOCKS.referencia = sheetSVG({
  cols: range('BJ', 'BO'), example: EX,
  title: 'Datos de referencia al final de la hoja',
  notes: [
    { text: 'Las tres últimas columnas cierran la hoja en BO. Si tu plantilla termina antes, no es la v13.' },
  ],
});

// ── Anexo: las 67 columnas ────────────────────────────────────────────────
const TYPE_LABEL = {
  'Desp.': 'Lista desplegable', 'Calc.': 'Calculada', 'Calc/#': 'Calculada o numérica',
  '#': 'Numérica', 'Texto': 'Texto libre', '$': 'Importe', 'V/F': 'V o F',
};
function tablaColumnas() {
  const out = ['<div class="tablewrap"><table><thead><tr><th>Col.</th><th>Encabezado</th><th>Bloque</th><th>Cómo se llena</th><th>Valor inicial</th></tr></thead><tbody>'];
  let prevBand = null;
  for (const c of COLS) {
    const band = BAND_OF[c] || '';
    const nuevaBanda = band !== prevBand; prevBand = band;
    const t = TYPE[c] || '';
    out.push(`<tr>`
      + `<td><code>${c}</code></td>`
      + `<td>${esc(String(HEAD[c] || '').replace(/\n/g, ' '))}</td>`
      + `<td>${nuevaBanda ? `<strong>${esc(band)}</strong>` : `<span class="dim">${esc(band)}</span>`}</td>`
      + `<td>${esc(TYPE_LABEL[t] || t)}</td>`
      + `<td>${DEF[c] ? `<code>${esc(DEF[c])}</code>` : '<span class="dim">—</span>'}</td>`
      + `</tr>`);
  }
  out.push('</tbody></table></div>');
  return out.join('\n');
}

// ── Ensamblado ────────────────────────────────────────────────────────────
const DATOS = {
  nColsVisibles: String(COLS.length),
  ultimaColumna: LAST,
  nRacks: String(range('A', LAST).filter(c => /^rack\b/i.test(HEAD[c] || '')).length),
  fechaCorte: new Date(fs.statSync(XLSM).mtime).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }),
};

let html = fs.readFileSync(SRC, 'utf8');
const faltantes = [];
html = html.replace(/\{\{SVG:([a-zA-Z0-9_-]+)\}\}/g, (_, k) => {
  if (!BLOCKS[k]) { faltantes.push('SVG:' + k); return ''; }
  return BLOCKS[k];
});
html = html.replace(/\{\{TABLA:columnas\}\}/g, tablaColumnas);
html = html.replace(/\{\{DATO:([a-zA-Z0-9_]+)\}\}/g, (_, k) => {
  if (DATOS[k] == null) { faltantes.push('DATO:' + k); return ''; }
  return DATOS[k];
});

const sobrantes = [...html.matchAll(/\{\{[^}]+\}\}/g)].map(m => m[0]);
if (faltantes.length || sobrantes.length) {
  console.error('✗ marcadores sin resolver:', [...faltantes, ...sobrantes].join(', '));
  process.exit(1);
}

fs.writeFileSync(OUT, html);
console.log(`✓ ${path.relative(ROOT, OUT)}`);
console.log(`  columnas leídas de la plantilla: ${COLS.length} (A–${LAST}) · pares de rack: ${DATOS.nRacks}`);
console.log(`  bloques SVG: ${Object.keys(BLOCKS).join(', ')}`);
