// tools/test/mui-icon-core-wiring.test.js
// TRINQUETE de cableado: todo applet que USE el núcleo de iconos debe DECLARARLO en config.
// Run: node --test tools/test/mui-icon-core-wiring.test.js
//
// POR QUÉ EXISTE:
//   `mui-icon-anchor-core.js` se lee desde el glue como `window.MuiIconAnchorCore`, y todos
//   los applets caen a un fallback silencioso si no está cargado. Ese fallback es
//   exactamente el comportamiento ROTO de hoy (busca por `data-testid`, que SH eliminó), así
//   que olvidar el core en `config.apps[].scripts` no produce ningún error visible: produce
//   un applet que sigue sin funcionar y parece arreglado.
//
//   Es el mismo molde del incidente `popup-actions-wired`: un contrato repartido entre varios
//   archivos donde ninguno falla solo, y la única señal sería el clic en producción.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'remote', 'scripts');
const CORE = 'scripts/mui-icon-anchor-core.js';
const CORE_FILE = 'mui-icon-anchor-core.js';

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote', 'config.json'), 'utf8'));

// Scripts (que no sean el core) cuyo código referencia el core.
function scriptsQueUsanElCore() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js') && f !== CORE_FILE)
    .filter((f) => fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8').includes('MuiIconAnchorCore'))
    .map((f) => 'scripts/' + f);
}

test('todo applet que usa el núcleo lo declara en config.apps[].scripts', () => {
  const usan = new Set(scriptsQueUsanElCore());
  const faltantes = [];
  for (const app of config.apps) {
    const scripts = app.scripts || [];
    if (!scripts.some((s) => usan.has(s))) continue;
    if (!scripts.includes(CORE)) faltantes.push(app.id);
  }
  assert.deepEqual(faltantes, [],
    'estas apps usan el núcleo pero no lo cargan (caerían al fallback roto, en silencio): ' + faltantes.join(', '));
});

test('el núcleo se carga ANTES del script que lo usa', () => {
  // El glue lee `window.MuiIconAnchorCore` al ejecutarse; si el core va después, la primera
  // pasada corre sin él.
  const usan = new Set(scriptsQueUsanElCore());
  const malOrden = [];
  for (const app of config.apps) {
    const scripts = app.scripts || [];
    const iCore = scripts.indexOf(CORE);
    if (iCore === -1) continue;
    const iPrimerUso = scripts.findIndex((s) => usan.has(s));
    if (iPrimerUso !== -1 && iCore > iPrimerUso) malOrden.push(app.id);
  }
  assert.deepEqual(malOrden, [], 'el core debe ir antes de su primer consumidor en: ' + malOrden.join(', '));
});

test('el archivo del núcleo existe y exporta lo que el glue usa', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, CORE_FILE), 'utf8');
  for (const fn of ['findIcon', 'findIcons', 'hasAnyIcon', 'findReportHeaderAnchor']) {
    assert.ok(src.includes(fn), 'el núcleo debe exportar ' + fn);
  }
});

test('ningún applet quedó anclado SÓLO a data-testid (sin pasar por el núcleo)', () => {
  // Un `data-testid` suelto se vale como FALLBACK dentro de un `if (Icons) … else …`, pero no
  // como única vía: SH ya demostró que los puede quitar de un build a otro.
  const sospechosos = [];
  for (const f of fs.readdirSync(SCRIPTS_DIR).filter((x) => x.endsWith('.js'))) {
    if (f === CORE_FILE) continue;
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
    // ¿usa data-testid de un icono MUI en código (no en comentario)?
    const usaTestid = src.split('\n').some((line) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*')) return false;
      return /data-testid="[A-Z][A-Za-z0-9]*Icon"/.test(code);
    });
    if (usaTestid && !src.includes('MuiIconAnchorCore')) sospechosos.push(f);
  }
  assert.deepEqual(sospechosos, [],
    'estos anclan a data-testid sin el núcleo — SH los puede apagar en silencio: ' + sospechosos.join(', '));
});
