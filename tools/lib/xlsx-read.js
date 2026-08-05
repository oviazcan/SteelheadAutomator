// Lector mínimo de una hoja de .xlsm. Maneja celdas SELF-CLOSING (<c r="C3" s="1"/>),
// que es donde falla el regex ingenuo: al exigir </c> se traga las celdas vacías y
// TODAS las columnas posteriores de esa fila quedan corridas.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readSheet(file, sheetName, maxRow = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsm-'));
  execSync(`unzip -o -q "${file}" -d "${dir}"`);
  try {
    const sstRaw = fs.existsSync(path.join(dir, 'xl/sharedStrings.xml'))
      ? fs.readFileSync(path.join(dir, 'xl/sharedStrings.xml'), 'utf8') : '';
    const sst = [...sstRaw.matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));

    const wb = fs.readFileSync(path.join(dir, 'xl/workbook.xml'), 'utf8');
    const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)]
      .map(m => ({ name: m[1], rid: m[2] }));
    const rels = fs.readFileSync(path.join(dir, 'xl/_rels/workbook.xml.rels'), 'utf8');
    const relMap = {};
    for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];

    const s = sheets.find(x => x.name === sheetName);
    if (!s) throw new Error('hoja no encontrada: ' + sheetName);
    const xml = fs.readFileSync(path.join(dir, 'xl', relMap[s.rid].replace(/^\/xl\//, '')), 'utf8');

    const rows = {};
    for (const m of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const r = +m[1];
      if (r > maxRow) continue;
      rows[r] = {};
      // (\/>|>…<\/c>)  ← la alternancia que arregla el corrimiento
      for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = c[1], attrs = c[2] || '', body = c[3] || '';
        const t = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
        let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (t === 'inlineStr') v = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        else if (t === 's' && v != null) v = sst[+v];
        if (v == null || v === '') continue;
        rows[r][col] = String(v)
          .replace(/&#10;/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      }
    }

    const merges = [...(xml.match(/<mergeCells[\s\S]*?<\/mergeCells>/) || [''])[0]
      .matchAll(/ref="([^"]+)"/g)].map(m => m[1]);

    const validations = [];
    // Igual que con las celdas: hay <dataValidation …/> SELF-CLOSING (validaciones vacías).
    // Exigir el cierre se las salta y le cuelga a ese sqref el contenido de la SIGUIENTE
    // validación — así se lee "el desplegable está en E8" cuando en realidad está en B9:B508.
    for (const d of xml.matchAll(/<dataValidation ([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
      const ref = (d[1].match(/sqref="([^"]+)"/) || [])[1];
      if (!ref) continue;
      validations.push({
        ref,
        list: (((d[2] || '').match(/<formula1>([\s\S]*?)<\/formula1>/) || [])[1] || '').replace(/&quot;/g, '"'),
      });
    }
    for (const d of xml.matchAll(/<x14:dataValidation[^>]*>([\s\S]*?)<\/x14:dataValidation>/g)) {
      validations.push({
        ref: (d[1].match(/<xm:sqref>([\s\S]*?)<\/xm:sqref>/) || [])[1] || '',
        list: ((d[1].match(/<xm:f>([\s\S]*?)<\/xm:f>/) || [])[1] || '').replace(/&amp;/g, '&'),
      });
    }
    return { rows, merges, validations };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readSheet };

if (require.main === module) {
  const { rows, merges, validations } = readSheet(process.argv[2], process.argv[3] || 'Upload', +(process.argv[4] || 10));
  for (const r of Object.keys(rows).sort((a, b) => a - b)) {
    const cells = Object.entries(rows[r]).map(([c, v]) => `${c}=${v.replace(/\n/g, '⏎')}`);
    if (cells.length) console.log(`r${r} (${cells.length}): ` + cells.join(' | '));
  }
  console.log('\nMERGES fila<=8:', merges.filter(m => /^[A-Z]+[1-8](:|$)/.test(m)).join('  '));
  console.log('\nVALIDACIONES:');
  validations.forEach(v => console.log('  ' + v.ref + '  ->  ' + v.list));
}
