// tools/seal-config.mjs
// Sella config.json: calcula scriptIntegrity (sha256 por script), lo escribe en el
// config, y firma los bytes finales → config.sig (base64 de la firma raw P1363).
// Backend de firma abstraído: ephemeral (tests) / kms (prod, en Task 4).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const b64 = (u8) => Buffer.from(u8).toString('base64');

async function sha256Hex(buf) {
  const d = await subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeScriptIntegrity(config, scriptsRootDir) {
  const paths = new Set();
  for (const a of (config.apps || [])) for (const s of (a.scripts || [])) paths.add(s);
  for (const s of (config.scripts || [])) paths.add(s);
  const out = {};
  for (const p of [...paths].sort()) {
    const rel = p.replace(/^scripts\//, '');
    const bytes = readFileSync(join(scriptsRootDir, rel)); // lanza si falta
    out[p] = await sha256Hex(bytes);
  }
  return out;
}

export async function sealConfig({ configPath, sigPath, scriptsRootDir, signer }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const integrity = await computeScriptIntegrity(config, scriptsRootDir);
  config.scriptIntegrity = integrity;
  const sealedText = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(configPath, sealedText);
  const sigRaw = await signer.sign(new TextEncoder().encode(sealedText));
  const sigB64 = b64(sigRaw);
  writeFileSync(sigPath, sigB64 + '\n');
  return { integrity, sigB64 };
}

export async function ephemeralSigner() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = await subtle.exportKey('spki', kp.publicKey);
  return {
    pubB64: b64(new Uint8Array(spki)),
    async sign(bytes) {
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, bytes);
      return new Uint8Array(sig); // WebCrypto ya da P1363
    }
  };
}
