// tools/test/verify-config-sig.test.js  (CJS)
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

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
