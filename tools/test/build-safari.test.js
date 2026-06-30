// Regresión del build del bundle Safari/iPad (tools/build-safari.sh).
// Corre el build y verifica: orden por dependencias, dedup de helpers compartidos,
// presencia de cada applet, sintaxis JS válida del concatenado y manifest world:MAIN.
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const EXT = path.join(ROOT, 'safari/extension');

// Build una vez para toda la suite (determinístico).
execSync('tools/build-safari.sh', { cwd: ROOT, stdio: 'pipe' });
const bundle = fs.readFileSync(path.join(EXT, 'main-bundle.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

test('el concatenado es JS sintácticamente válido', () => {
  // node --check truena si hay error de sintaxis (p. ej. colisión de const top-level).
  execSync(`node --check ${JSON.stringify(path.join(EXT, 'main-bundle.js'))}`);
});

test('los helpers compartidos se deduplican (steelhead-api 1 sola vez)', () => {
  const n = (bundle.match(/BEGIN scripts\/steelhead-api\.js/g) || []).length;
  assert.strictEqual(n, 1, 'steelhead-api.js debe concatenarse exactamente una vez');
});

test('orden por dependencias: helper antes que el applet que lo usa', () => {
  const api = bundle.indexOf('BEGIN scripts/steelhead-api.js');
  const core = bundle.indexOf('BEGIN scripts/surtido-guard-core.js');
  const guard = bundle.indexOf('BEGIN scripts/surtido-guard.js');
  assert.ok(api >= 0 && core >= 0 && guard >= 0, 'deben estar los tres');
  assert.ok(api < core && core < guard, 'steelhead-api → surtido-guard-core → surtido-guard');
});

test('cada applet del bundle.json está presente', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote/config.json'), 'utf8'));
  const apps = Object.fromEntries(cfg.apps.map((a) => [a.id, a]));
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'safari/bundle.json'), 'utf8')).applets;
  for (const id of list) {
    const main = (apps[id].scripts || []).slice(-1)[0]; // el script del applet es el último de su lista
    assert.ok(bundle.includes('BEGIN ' + main), `falta ${main} (${id}) en el bundle`);
  }
});

test('cada script va envuelto en su propio IIFE (aislamiento de scope)', () => {
  // Tras cada marcador BEGIN debe abrir un IIFE.
  const begins = bundle.match(/\/\/ ===== BEGIN [^\n]+\n\(function\(\)\{/g) || [];
  const total = (bundle.match(/\/\/ ===== BEGIN /g) || []).length;
  assert.strictEqual(begins.length, total, 'todo BEGIN debe ir seguido de (function(){');
});

test('manifest: content script world:MAIN apuntando al bundle', () => {
  const cs = manifest.content_scripts[0];
  assert.deepStrictEqual(cs.js, ['main-bundle.js']);
  assert.strictEqual(cs.world, 'MAIN');
  assert.strictEqual(cs.run_at, 'document_start');
});
