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

test('manifest: bridge (ISOLATED) + bundle (MAIN)', () => {
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  const iso = manifest.content_scripts.find((c) => c.world !== 'MAIN');
  assert.ok(main && iso, 'debe haber un content script MAIN y uno aislado');
  assert.deepStrictEqual(main.js, ['main-bundle.js']);
  assert.strictEqual(main.run_at, 'document_idle');
  assert.deepStrictEqual(iso.js, ['bridge.js']);
});

test('el bundle trae bridge bootstrap + config seed (caliente + arranque síncrono)', () => {
  assert.ok(bundle.includes('BEGIN sa-bootstrap.js'), 'falta el listener del bridge (refresh en caliente)');
  assert.ok(bundle.includes('BEGIN config-seed'), 'falta el config-seed (arranque síncrono)');
  assert.ok(/window\.REMOTE_CONFIG\s*=\s*\{/.test(bundle), 'el seed debe asignar window.REMOTE_CONFIG');
});

test('--check ignora cambios SOLO en el config-seed (hashes en caliente, sin drift)', () => {
  const p = path.join(EXT, 'main-bundle.js');
  const orig = fs.readFileSync(p, 'utf8');
  const tampered = orig.replace(/("CreateMaintenanceEvent":\s*")[0-9a-f]{64}(")/, '$1deadbeef$2');
  assert.notStrictEqual(tampered, orig, 'el seed debe contener el hash a alterar');
  fs.writeFileSync(p, tampered);
  let code = 0;
  try { execSync('tools/build-safari.sh --check', { cwd: ROOT, stdio: 'pipe' }); } catch (e) { code = e.status; }
  fs.writeFileSync(p, orig); // restaurar
  assert.strictEqual(code, 0, '--check NO debe marcar drift por cambio solo en el config-seed');
});

test('el bundle trae el dispatcher de comandos del popup (type:command)', () => {
  assert.ok(bundle.includes('BEGIN sa-dispatcher.js'), 'falta sa-dispatcher.js en el bundle');
  assert.ok(bundle.includes("'command'"), 'el dispatcher debe reaccionar a mensajes type:command');
});

// El canal de lanzadores cruza 4 archivos: popup.js (escribe saCommand) → bridge.js (reenvía) →
// sa-dispatcher.js (mapea message→fn) → el applet (definido en el bundle). Este test verifica que la
// cadena esté completa y consistente para CADA mensaje que el popup ofrece: un typo en cualquier
// eslabón (message, allowlist o applet ausente del bundle) truena aquí antes del iPad.
test('canal de lanzadores consistente: popup LAUNCHERS → dispatcher LAUNCH_FN → applet en bundle', () => {
  const popupSrc  = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const dispSrc   = fs.readFileSync(path.join(ROOT, 'safari/sa-dispatcher.js'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(EXT, 'bridge.js'), 'utf8');

  const popupMsgs = [...popupSrc.matchAll(/message:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(popupMsgs.length >= 4, 'popup.js debe declarar al menos 4 lanzadores');

  // global del applet → script donde se define (para exigir que esté en el bundle)
  const GLOBAL_SCRIPT = {
    ValeAlmacen: 'scripts/vale-almacen.js',
    PNArchiver: 'scripts/archiver.js',
    SensorStatusAutofill: 'scripts/sensor-status-autofill.js',
    LoadCalculator: 'scripts/load-calculator.js',
  };

  for (const msg of popupMsgs) {
    const m = dispSrc.match(new RegExp(`'${msg}':\\s*'([A-Za-z]+)\\.`));
    assert.ok(m, `sa-dispatcher LAUNCH_FN no mapea el mensaje '${msg}' del popup`);
    const script = GLOBAL_SCRIPT[m[1]];
    assert.ok(script, `global ${m[1]} sin script conocido en el test`);
    assert.ok(bundle.includes('BEGIN ' + script), `el applet de '${msg}' (${script}) no está en el bundle`);
  }

  assert.ok(/saCommand/.test(bridgeSrc), 'bridge.js debe reenviar saCommand al MAIN world');
  assert.ok(/saCommand/.test(popupSrc), 'popup.js debe escribir saCommand en storage');
});
