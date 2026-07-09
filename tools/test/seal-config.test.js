// tools/test/seal-config.test.js  (CJS + dynamic import de los .mjs)
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const SAIntegrity = require('../../extension/integrity-verify.js'); // CJS, require directo

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'seal-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'a.js'), 'AAA');
  writeFileSync(join(dir, 'scripts', 'b.js'), 'BBB');
  const config = { version: '1.0.0', apps: [{ id: 'x', scripts: ['scripts/a.js', 'scripts/b.js'] }] };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, configPath, sigPath: join(dir, 'config.sig'), scriptsRootDir: join(dir, 'scripts') };
}

test('computeScriptIntegrity hashea cada script', async () => {
  const { computeScriptIntegrity } = await import('../seal-config.mjs');
  const f = fixture();
  const cfg = JSON.parse(readFileSync(f.configPath, 'utf8'));
  const integ = await computeScriptIntegrity(cfg, f.scriptsRootDir);
  // sha256("AAA")
  assert.equal(integ['scripts/a.js'], 'cb1ad2119d8fafb69566510ee712661f9f14b83385006ef92aec47f523a38358');
  assert.equal(Object.keys(integ).length, 2);
});

test('sealConfig produce un config.sig que verifica; tamper del config → falla', async () => {
  const { sealConfig, ephemeralSigner } = await import('../seal-config.mjs');
  const f = fixture();
  const signer = await ephemeralSigner();
  const { sigB64 } = await sealConfig({ ...f, signer });
  const sealedText = readFileSync(f.configPath, 'utf8');
  assert.equal(await SAIntegrity.verifyConfigSignature(sealedText, sigB64, signer.pubB64), true);
  assert.equal(await SAIntegrity.verifyConfigSignature(sealedText + ' ', sigB64, signer.pubB64), false);
});

test('alterar el hash en scriptIntegrity sin re-firmar → la firma ya no verifica', async () => {
  const { sealConfig, ephemeralSigner } = await import('../seal-config.mjs');
  const f = fixture();
  const signer = await ephemeralSigner();
  const { sigB64 } = await sealConfig({ ...f, signer });
  const sealedText = readFileSync(f.configPath, 'utf8');
  const tampered = sealedText.replace(/("scripts\/a\.js": )"[0-9a-f]{64}"/, '$1"deadbeef"');
  assert.notEqual(tampered, sealedText);
  assert.equal(await SAIntegrity.verifyConfigSignature(tampered, sigB64, signer.pubB64), false);
});

test('script faltante → lanza', async () => {
  const { computeScriptIntegrity } = await import('../seal-config.mjs');
  const f = fixture();
  const cfg = JSON.parse(readFileSync(f.configPath, 'utf8'));
  cfg.apps[0].scripts.push('scripts/falta.js');
  await assert.rejects(() => computeScriptIntegrity(cfg, f.scriptsRootDir));
});
