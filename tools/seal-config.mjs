// tools/seal-config.mjs
// Sella config.json: calcula scriptIntegrity (sha256 por script), lo escribe en el
// config, y firma los bytes finales → config.sig (base64 de la firma raw P1363).
// Backend de firma abstraído: ephemeral (tests) / kms (prod, en Task 4).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { derToP1363 } from './lib/der-to-p1363.mjs';

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
  // Firmar ANTES de escribir: si signer.sign() truena (p.ej. sin acceso KMS), no dejamos
  // config.json mutado con un config.sig viejo/inconsistente en el worktree.
  const sigRaw = await signer.sign(new TextEncoder().encode(sealedText));
  const sigB64 = b64(sigRaw);
  writeFileSync(configPath, sealedText);
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

export function buildKmsArgs({ keyResource, inputFile, sigFile }) {
  const parts = keyResource.split('/');
  const idx = (k) => parts[parts.indexOf(k) + 1];
  return [
    'kms', 'asymmetric-sign',
    '--digest-algorithm=sha256',
    `--input-file=${inputFile}`,
    `--signature-file=${sigFile}`,
    `--version=${idx('cryptoKeyVersions')}`,
    `--key=${idx('cryptoKeys')}`,
    `--keyring=${idx('keyRings')}`,
    `--location=${idx('locations')}`,
    `--project=${idx('projects')}`
  ];
}

function defaultGcloudSignDigest(digest, keyResource) {
  // KMS firma un DIGEST: input-file = el sha256 (32 bytes); gcloud escribe la firma DER
  // BINARIA a signature-file (no a stdout con utf8 → corrompería). Leemos binario.
  const stamp = createHash('sha256').update(digest).digest('hex').slice(0, 12);
  const inFile = `/tmp/sa-seal-in-${stamp}.bin`;
  const sigFile = `/tmp/sa-seal-out-${stamp}.der`;
  writeFileSync(inFile, digest);
  execFileSync('gcloud', buildKmsArgs({ keyResource, inputFile: inFile, sigFile }), { stdio: 'inherit' });
  return readFileSync(sigFile); // DER binario
}

export function kmsSigner({ keyResource, signDigest }) {
  const doSign = signDigest || defaultGcloudSignDigest;
  return {
    async sign(bytes) {
      const digest = createHash('sha256').update(Buffer.from(bytes)).digest();
      const der = await doSign(digest, keyResource);
      return derToP1363(new Uint8Array(der), 32);
    }
  };
}

// --- entrypoint CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const backend = arg('--backend') || 'kms';
  const signer = backend === 'ephemeral'
    ? await ephemeralSigner()
    : kmsSigner({ keyResource: arg('--kms-key') });
  const { sigB64 } = await sealConfig({
    configPath: arg('--config'), sigPath: arg('--sig'), scriptsRootDir: arg('--scripts-dir'), signer
  });
  console.log(`[seal] config sellado + firmado (backend=${backend}). sig ${sigB64.slice(0, 16)}…`);
}
