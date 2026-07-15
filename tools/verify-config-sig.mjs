// tools/verify-config-sig.mjs
// Verifica que un config.json + config.sig verifiquen contra una pública dada.
// Lo usan el hook pre-push y el smoke-check post-deploy.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SAIntegrity = require('../extension/integrity-verify.js');

export async function verifyFiles({ configPath, sigPath, pubKeyB64 }) {
  const configText = readFileSync(configPath, 'utf8');
  const sigB64 = readFileSync(sigPath, 'utf8').trim();
  return SAIntegrity.verifyConfigSignature(configText, sigB64, pubKeyB64);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [configPath, sigPath, pubKeyB64] = process.argv.slice(2);
  const ok = await verifyFiles({ configPath, sigPath, pubKeyB64 });
  if (!ok) { console.error('✗ config.sig NO verifica'); process.exit(1); }
  console.log('✓ config.sig verifica'); process.exit(0);
}
