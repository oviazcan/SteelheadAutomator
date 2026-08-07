// tools/test/verify-config-sig.test.js  (CJS)
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('verifyFiles: true tras sellar; false si se altera el config', async () => {
  const { sealConfig, ephemeralSigner } = await import('../seal-config.mjs');
  const { verifyFiles } = await import('../verify-config-sig.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'vf-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'a.js'), 'AAA');
  const configPath = join(dir, 'config.json'); const sigPath = join(dir, 'config.sig');
  writeFileSync(configPath, JSON.stringify({ version: '1', apps: [{ id: 'x', scripts: ['scripts/a.js'] }] }, null, 2));
  const signer = await ephemeralSigner();
  await sealConfig({ configPath, sigPath, scriptsRootDir: join(dir, 'scripts'), signer });
  assert.equal(await verifyFiles({ configPath, sigPath, pubKeyB64: signer.pubB64 }), true);
  writeFileSync(configPath, '{"version":"1","hacked":true}');
  assert.equal(await verifyFiles({ configPath, sigPath, pubKeyB64: signer.pubB64 }), false);
});

// ANTI-REGRESIÓN (2026-08-06): el guard de "¿me ejecutan como CLI?" comparaba import.meta.url
// contra `file://${process.argv[1]}` sin resolver symlinks. Invocado por una ruta symlinkeada
// —cualquier mktemp en macOS— el bloque no corría, el proceso salía 0 y quien invocaba leía
// "todo bien" sin que se verificara nada. En un verificador de firma, un OK silencioso es el
// peor modo de fallo posible: el hook pre-push dejó pasar un config.sig corrupto.
test('CLI: detecta firma inválida AUNQUE se le invoque por una ruta con symlink', async () => {
  const { sealConfig, ephemeralSigner } = await import('../seal-config.mjs');
  const real = mkdtempSync(join(tmpdir(), 'vf-real-'));
  mkdirSync(join(real, 'tools')); mkdirSync(join(real, 'extension')); mkdirSync(join(real, 'scripts'));
  writeFileSync(join(real, 'scripts', 'a.js'), 'AAA');
  // Se copia el par (script + su dependencia relativa), igual que hace el hook pre-push.
  copyFileSync(resolve(__dirname, '../verify-config-sig.mjs'), join(real, 'tools', 'verify-config-sig.mjs'));
  copyFileSync(resolve(__dirname, '../../extension/integrity-verify.js'), join(real, 'extension', 'integrity-verify.js'));

  const configPath = join(real, 'config.json'); const sigPath = join(real, 'config.sig');
  writeFileSync(configPath, JSON.stringify({ version: '1', apps: [{ id: 'x', scripts: ['scripts/a.js'] }] }, null, 2));
  const signer = await ephemeralSigner();
  await sealConfig({ configPath, sigPath, scriptsRootDir: join(real, 'scripts'), signer });

  // Ruta alterna que llega al MISMO archivo a través de un symlink.
  const linkDir = mkdtempSync(join(tmpdir(), 'vf-link-'));
  const linked = join(linkDir, 'alias');
  symlinkSync(real, linked);
  const viaSymlink = join(linked, 'tools', 'verify-config-sig.mjs');

  const run = () => execFileSync(process.execPath, [viaSymlink, configPath, sigPath, signer.pubB64],
    { encoding: 'utf8', stdio: 'pipe' });

  // Firma buena → exit 0 y lo dice explícitamente (no un 0 mudo).
  assert.match(run(), /config\.sig verifica/);

  // Firma alterada → TIENE que salir distinto de 0. Antes salía 0 sin imprimir nada.
  writeFileSync(configPath, '{"version":"1","hacked":true}');
  assert.throws(run, (err) => err.status === 1, 'una firma inválida invocada por symlink debe salir 1');
});

test('CLI: sin argumentos falla cerrado (no sale 0 “por default”)', () => {
  const cli = resolve(__dirname, '../verify-config-sig.mjs');
  assert.throws(
    () => execFileSync(process.execPath, [cli], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 2,
  );
});
