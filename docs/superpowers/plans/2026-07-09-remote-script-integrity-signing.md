# Integridad de scripts remotos por firma — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la extensión verifique criptográficamente (firma ECDSA P-256) el `config.json` y el hash de cada script remoto ANTES de ejecutarlo, con fail-closed, sin perder el hot-update.

**Architecture:** `config.json` es el manifiesto raíz firmado; su firma va en `config.sig` (separado, sobre los bytes exactos). Contiene `scriptIntegrity{path:sha256}`. `background.js` verifica la firma con la pública embebida (WebCrypto), y cada script contra su hash, en el chokepoint `fetchScriptCode`. El firmado ocurre en deploy (`tools/seal-config.mjs`) con backend abstraído: `kms` (GCP KMS del cliente) en prod, `ephemeral` en tests.

**Tech Stack:** JS vanilla (sin bundlers), WebCrypto (`crypto.subtle`), Node ≥20 (`globalThis.crypto`), Chrome MV3 service worker clásico (`importScripts`), GCP KMS (`gcloud kms asymmetric-sign`), `node:test`.

## Global Constraints

- **Algoritmo:** ECDSA **P-256 / SHA-256** en todos lados. Firma en config.sig = **base64 de la firma raw r||s (IEEE P1363, 64 bytes)** — NO DER.
- **`config.sig`** = archivo separado; firma sobre los **bytes exactos** de `config.json` servido.
- **`scriptIntegrity`** = objeto `{ "scripts/foo.js": "<sha256-hex-minúsculas>" }` dentro de `config.json`.
- **Fail-closed:** nunca ejecutar código no verificado. Break-glass = flag local `sa_integrity_bypass` en `chrome.storage.local`, default OFF, solo lo setea la extensión.
- **JS vanilla**, sin frameworks/bundlers. UI de la extensión en **dark mode** (`#1c2430`/`#e6e9ee`/acento `#13a36f`).
- **Node ≥20** para WebCrypto global en tests (el entorno es v25).
- **Deploy solo vía `tools/deploy.sh`.** `autopilot-deploy.sh` **llama a `deploy.sh`** (hereda `seal` automáticamente — NO se toca por separado).
- **Llave privada:** GCP KMS (proyecto del cliente) en prod; `ephemeral` (WebCrypto en memoria) SOLO en tests. Pública embebida en `extension/integrity-pubkey.js` → `self.SA_INTEGRITY_PUBKEY`.
- **Pública placeholder** hasta Fase 0 (KMS provisionado): la verificación en `background.js` no se activa en usuarios hasta la Fase 2 (bump de extensión).

---

### Task 1: Módulo puro de verificación (`extension/integrity-verify.js`)

**Files:**
- Create: `extension/integrity-verify.js`
- Test: `tools/test/integrity-verify.test.js`

**Interfaces:**
- Produces:
  - `SAIntegrity.sha256Hex(text: string): Promise<string>` — hex minúsculas.
  - `SAIntegrity.verifyConfigSignature(configText: string, sigB64: string, pubKeyB64: string): Promise<boolean>` — nunca lanza; false ante cualquier error.
  - `SAIntegrity.verifyScriptHash(code: string, expectedHex: string): Promise<boolean>`
  - Exporta a `module.exports` (Node) y `self.SAIntegrity` (service worker).

- [ ] **Step 1: Write the failing test**

```js
// tools/test/integrity-verify.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const SAIntegrity = require('../../extension/integrity-verify.js');

// Helper: genera un par efímero P-256 y devuelve { pubB64, sign(text)->sigB64 }
const subtle = globalThis.crypto.subtle;
const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
async function ephemeralKey() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = await subtle.exportKey('spki', kp.publicKey);
  return {
    pubB64: b64(spki),
    async sign(text) {
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(text));
      return b64(sig); // WebCrypto ya devuelve P1363 raw
    }
  };
}

test('sha256Hex: vector conocido', async () => {
  // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  assert.equal(await SAIntegrity.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('verifyConfigSignature: firma válida → true; byte alterado → false', async () => {
  const k = await ephemeralKey();
  const cfg = '{"version":"1.0.0","x":1}';
  const sig = await k.sign(cfg);
  assert.equal(await SAIntegrity.verifyConfigSignature(cfg, sig, k.pubB64), true);
  assert.equal(await SAIntegrity.verifyConfigSignature(cfg + ' ', sig, k.pubB64), false);
});

test('verifyConfigSignature: no lanza con basura', async () => {
  assert.equal(await SAIntegrity.verifyConfigSignature('x', 'no-b64!!', 'no-key'), false);
});

test('verifyScriptHash: correcto true, alterado false, vacío false', async () => {
  const code = 'console.log(1)';
  const h = await SAIntegrity.sha256Hex(code);
  assert.equal(await SAIntegrity.verifyScriptHash(code, h), true);
  assert.equal(await SAIntegrity.verifyScriptHash(code + ';', h), false);
  assert.equal(await SAIntegrity.verifyScriptHash(code, ''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/integrity-verify.test.js`
Expected: FAIL — `Cannot find module '../../extension/integrity-verify.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// extension/integrity-verify.js
// Módulo puro de verificación de integridad (firma ECDSA P-256 + hash SHA-256).
// Corre en el service worker (self.SAIntegrity) y en Node/tests (module.exports).
(function () {
  'use strict';

  function getSubtle() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
    if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) return self.crypto.subtle;
    if (typeof require === 'function') return require('node:crypto').webcrypto.subtle;
    throw new Error('WebCrypto no disponible');
  }

  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64); const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  function bytesToHex(buf) {
    const b = new Uint8Array(buf); let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(String(text));
    const digest = await getSubtle().digest('SHA-256', data);
    return bytesToHex(digest);
  }

  async function verifyConfigSignature(configText, sigB64, pubKeyB64) {
    try {
      const key = await getSubtle().importKey('spki', b64ToBytes(pubKeyB64),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const sig = b64ToBytes(sigB64);
      const data = new TextEncoder().encode(String(configText));
      return await getSubtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
    } catch (_) {
      return false;
    }
  }

  async function verifyScriptHash(code, expectedHex) {
    if (!expectedHex) return false;
    const got = await sha256Hex(code);
    return got === String(expectedHex).toLowerCase();
  }

  const api = { sha256Hex, verifyConfigSignature, verifyScriptHash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.SAIntegrity = api;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/integrity-verify.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add extension/integrity-verify.js tools/test/integrity-verify.test.js
git commit -m "feat(integrity): módulo puro de verificación firma+hash (WebCrypto P-256)"
```

---

### Task 2: Conversión DER→P1363 (`tools/lib/der-to-p1363.mjs`)

GCP KMS `asymmetricSign` devuelve la firma ECDSA en **ASN.1 DER**; WebCrypto exige **raw r||s (64 bytes)**. Esta función convierte. Se prueba con round-trip: firmar DER con Node → convertir → verificar con WebCrypto (lo que hará KMS en prod).

**Files:**
- Create: `tools/lib/der-to-p1363.mjs`
- Test: `tools/test/der-to-p1363.test.js`

**Interfaces:**
- Produces: `derToP1363(der: Uint8Array, size=32): Uint8Array` (64 bytes para P-256).

- [ ] **Step 1: Write the failing test**

```js
// tools/test/der-to-p1363.test.js  (CJS — el runner globea *.test.js y no hay type:module)
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign: nodeSign, webcrypto } = require('node:crypto');

test('round-trip: Node firma DER → convierte → WebCrypto verifica', async () => {
  const { derToP1363 } = await import('../lib/der-to-p1363.mjs'); // dynamic import de ESM desde CJS
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const msg = Buffer.from('hola integridad');
  const der = nodeSign('sha256', msg, { key: privateKey, dsaEncoding: 'der' }); // Node da DER
  const raw = derToP1363(new Uint8Array(der), 32);
  assert.equal(raw.length, 64);

  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const key = await webcrypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, msg);
  assert.equal(ok, true);
});

test('rechaza input que no es SEQUENCE', async () => {
  const { derToP1363 } = await import('../lib/der-to-p1363.mjs');
  assert.throws(() => derToP1363(new Uint8Array([0x01, 0x02]), 32));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/der-to-p1363.test.js`
Expected: FAIL — no existe `../lib/der-to-p1363.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// tools/lib/der-to-p1363.mjs
// Convierte una firma ECDSA ASN.1 DER (SEQUENCE{INTEGER r, INTEGER s}) a raw r||s
// (IEEE P1363), que es lo que WebCrypto verify espera. GCP KMS devuelve DER.
export function derToP1363(der, size = 32) {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('DER: no es SEQUENCE');
  // longitud del SEQUENCE (short o long form) — la saltamos
  if (der[o] & 0x80) o += 1 + (der[o] & 0x7f); else o += 1;
  function readInt() {
    if (der[o++] !== 0x02) throw new Error('DER: no es INTEGER');
    let len = der[o++];
    let bytes = der.slice(o, o + len); o += len;
    while (bytes.length > size && bytes[0] === 0x00) bytes = bytes.slice(1); // quita padding 0x00
    const out = new Uint8Array(size);
    out.set(bytes, size - bytes.length); // left-pad
    return out;
  }
  const r = readInt(); const s = readInt();
  const out = new Uint8Array(size * 2);
  out.set(r, 0); out.set(s, size);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/der-to-p1363.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/lib/der-to-p1363.mjs tools/test/der-to-p1363.test.js
git commit -m "feat(integrity): conversión DER→P1363 para firmas de KMS"
```

---

### Task 3: Núcleo de sellado (`tools/seal-config.mjs`) con backend efímero

**Files:**
- Create: `tools/seal-config.mjs`
- Test: `tools/test/seal-config.test.js`

**Interfaces:**
- Consumes: `SAIntegrity` (Task 1) para verificar en el test.
- Produces:
  - `computeScriptIntegrity(config: object, scriptsRootDir: string): Promise<Record<string,string>>` — hashea cada path de `config.apps[].scripts` ∪ `config.scripts`; lee `scriptsRootDir/<path-sin-'scripts/'>`. Lanza si falta un archivo.
  - `sealConfig({ configPath, sigPath, scriptsRootDir, signer }): Promise<{ integrity, sigB64 }>` — escribe `scriptIntegrity` en el config (preservando indentación de 2 espacios), re-lee bytes, firma, escribe `sigPath`.
  - `ephemeralSigner(): Promise<{ pubB64, sign(bytes:Uint8Array)->Promise<Uint8Array> }>` — SOLO tests.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/seal-config.test.js`
Expected: FAIL — no existe `../seal-config.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
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
```

**Nota de consistencia:** `sealConfig` firma `JSON.stringify(config,null,2)+'\n'` y escribe ESE texto. La verificación en `background.js` (Task 6) leerá el config con `response.text()` y verificará esos mismos bytes. El test usa el texto escrito, así que cuadra.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/seal-config.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/seal-config.mjs tools/test/seal-config.test.js
git commit -m "feat(integrity): seal-config núcleo + backend ephemeral (scriptIntegrity + firma)"
```

---

### Task 4: Backend KMS + CLI de `seal-config.mjs`

Agrega el firmante de producción (GCP KMS vía `gcloud kms asymmetric-sign`) y el entrypoint CLI que usará `deploy.sh`. El firmado KMS no se prueba en vivo (sin gcloud aquí); se prueba el **constructor del comando** y el **parseo/conversión** con un exec inyectable.

**Files:**
- Modify: `tools/seal-config.mjs`
- Test: `tools/test/seal-config-kms.test.js`

**Interfaces:**
- Consumes: `derToP1363` (Task 2).
- Produces:
  - `buildKmsArgs({ keyResource, inputFile, sigFile }): string[]` — puro (testeable).
  - `kmsSigner({ keyResource, signDigest }): { sign(bytes)->Promise<Uint8Array> }` — `signDigest(digest: Buffer, keyResource: string) -> Buffer(DER)` inyectable; default = gcloud a archivo temporal + lectura binaria.
  - CLI: `node tools/seal-config.mjs --config <path> --sig <path> --scripts-dir <dir> --backend kms --kms-key <resource>` (o `--backend ephemeral` para pruebas manuales).

- [ ] **Step 1: Write the failing test**

```js
// tools/test/seal-config-kms.test.js  (CJS)
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign: nodeSign, createHash } = require('node:crypto');

test('buildKmsArgs arma los flags correctos', async () => {
  const { buildKmsArgs } = await import('../seal-config.mjs');
  const args = buildKmsArgs({
    keyResource: 'projects/P/locations/global/keyRings/R/cryptoKeys/K/cryptoKeyVersions/1',
    inputFile: '/tmp/in', sigFile: '/tmp/out'
  });
  const s = args.join(' ');
  assert.match(s, /asymmetric-sign/);
  assert.match(s, /--digest-algorithm=sha256/);
  assert.match(s, /--input-file=\/tmp\/in/);
  assert.match(s, /--signature-file=\/tmp\/out/);
  assert.match(s, /--version=1/);
  assert.match(s, /--key=K/);
  assert.match(s, /--keyring=R/);
  assert.match(s, /--project=P/);
});

test('kmsSigner pasa el sha256 del payload al firmante y convierte DER→64B', async () => {
  const { kmsSigner } = await import('../seal-config.mjs');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = new TextEncoder().encode('config-bytes');
  const expectedDigest = createHash('sha256').update(Buffer.from(payload)).digest();
  let gotDigest = null;
  const fakeSignDigest = (digest) => {
    gotDigest = digest;
    return nodeSign('sha256', Buffer.from('x'), { key: privateKey, dsaEncoding: 'der' }); // cualquier DER válido
  };
  const signer = kmsSigner({
    keyResource: 'projects/P/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
    signDigest: fakeSignDigest
  });
  const raw = await signer.sign(payload);
  assert.equal(raw.length, 64);
  assert.deepEqual(new Uint8Array(gotDigest), new Uint8Array(expectedDigest));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/seal-config-kms.test.js`
Expected: FAIL — `buildKmsArgs`/`kmsSigner` no exportados

- [ ] **Step 3: Write minimal implementation** (agregar a `tools/seal-config.mjs`)

```js
// --- agregar a los imports del tope ---
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { derToP1363 } from './lib/der-to-p1363.mjs';

// --- agregar antes del bloque CLI ---
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

// --- entrypoint CLI (al final del archivo) ---
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
```

**Nota:** `readFileSync` y `writeFileSync` ya están importados de Task 3. El comando exacto de gcloud se confirma en la Fase 0 con gcloud real y se fija en `deploy-signing-setup.md`; el test cubre la parte frágil (args + digest + conversión DER→64B).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/seal-config-kms.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/seal-config.mjs tools/test/seal-config-kms.test.js
git commit -m "feat(integrity): backend KMS + CLI de seal-config"
```

---

### Task 5: Verificador standalone (`tools/verify-config-sig.mjs`)

Lo usan el hook `pre-push` y el smoke-check. Verifica que un `config.json` + `config.sig` verifiquen contra una pública dada.

**Files:**
- Create: `tools/verify-config-sig.mjs`
- Test: `tools/test/verify-config-sig.test.js`

**Interfaces:**
- Produces: `verifyFiles({ configPath, sigPath, pubKeyB64 }): Promise<boolean>`. CLI: `node tools/verify-config-sig.mjs <config> <sig> <pubB64>` → exit 0 si OK, 1 si falla.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/verify-config-sig.test.js`
Expected: FAIL — no existe `../verify-config-sig.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// tools/verify-config-sig.mjs
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/verify-config-sig.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add tools/verify-config-sig.mjs tools/test/verify-config-sig.test.js
git commit -m "feat(integrity): verificador standalone config.sig (hook + smoke-check)"
```

---

### Task 6: Integración en `background.js` + pública placeholder

Cablea la verificación al chokepoint. La pública es placeholder hasta Fase 0; con `SA_INTEGRITY_PUBKEY` vacío, la verificación **no bloquea** (fail-open SOLO cuando no hay pública embebida — modo pre-Fase-2), para que este commit no rompa nada. Al embeber la pública real (Fase 2), pasa a fail-closed.

**Files:**
- Create: `extension/integrity-pubkey.js`
- Modify: `extension/background.js` (tope; `loadConfig` ~14-27; `fetchScriptCode` ~30-39)

**Interfaces:**
- Consumes: `SAIntegrity` (Task 1), `self.SA_INTEGRITY_PUBKEY` (nuevo).

- [ ] **Step 1: Crear la pública placeholder**

```js
// extension/integrity-pubkey.js
// Llave pública ECDSA P-256 (SPKI base64) para verificar config.sig.
// PLACEHOLDER hasta Fase 0 (KMS provisionado): vacío = verificación desactivada.
// En Fase 2 se reemplaza por la pública real de KMS y se bumpea la extensión.
self.SA_INTEGRITY_PUBKEY = '';
```

- [ ] **Step 2: `importScripts` + break-glass helper** (tope de `background.js`, tras la línea `let cachedConfig = null;`)

```js
// Integridad de scripts remotos (firma + hash). Ver docs/superpowers/specs/2026-07-09-*.
importScripts('integrity-verify.js', 'integrity-pubkey.js');

async function integrityBypassed() {
  const { sa_integrity_bypass } = await chrome.storage.local.get('sa_integrity_bypass');
  return sa_integrity_bypass === true;
}
```

- [ ] **Step 3: Verificar la firma en `loadConfig`** (reemplazar el cuerpo del `try` de `loadConfig`)

```js
async function loadConfig() {
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    const pub = self.SA_INTEGRITY_PUBKEY;
    if (pub && !(await integrityBypassed())) {
      const sigResp = await fetch(`${REMOTE_BASE_URL}/config.sig`, { cache: 'no-cache' });
      const sigB64 = sigResp.ok ? (await sigResp.text()).trim() : '';
      const ok = await self.SAIntegrity.verifyConfigSignature(text, sigB64, pub);
      if (!ok) {
        console.error('[SA] SECURITY: firma de config inválida — no se inyecta nada');
        // fail-closed: NO actualizamos cachedConfig con contenido no verificado
        return cachedConfig; // conserva el último verificado (o null)
      }
    }

    cachedConfig = JSON.parse(text);
    await chrome.storage.local.set({ config: cachedConfig, config_verified_at: Date.now() });
    return cachedConfig;
  } catch (err) {
    console.warn('[SA] Error cargando config:', err.message);
    const stored = await chrome.storage.local.get(['config', 'config_verified_at']);
    // Fallback offline SOLO si venía de una verificación previa exitosa.
    if (stored.config && stored.config_verified_at) { cachedConfig = stored.config; return cachedConfig; }
    return cachedConfig;
  }
}
```

- [ ] **Step 4: Verificar el hash en `fetchScriptCode`** (reemplazar el `return await response.text();`)

```js
  const code = await response.text();
  const pub = self.SA_INTEGRITY_PUBKEY;
  if (pub && !(await integrityBypassed())) {
    const expected = config?.scriptIntegrity?.[scriptPath];
    const ok = await self.SAIntegrity.verifyScriptHash(code, expected);
    if (!ok) {
      console.error(`[SA] SECURITY: hash de ${scriptPath} no coincide — no se ejecuta`);
      throw new Error(`integridad: ${scriptPath}`);
    }
  }
  return code;
```

- [ ] **Step 5: Verificar carga del SW + smoke manual**

Run: `node --check extension/background.js && node --check extension/integrity-verify.js && node --check extension/integrity-pubkey.js`
Expected: sin errores de sintaxis. (La verificación real en runtime se prueba en Fase 2; con pública vacía el comportamiento es idéntico al actual.)

- [ ] **Step 6: Commit**

```bash
git add extension/integrity-pubkey.js extension/background.js
git commit -m "feat(integrity): background.js verifica firma+hash (pública placeholder, fail-open hasta Fase 2)"
```

---

### Task 7: Toggle break-glass en el popup

**Files:**
- Modify: `extension/popup.html`, `extension/popup.js`

**Interfaces:**
- Consumes: `chrome.storage.local` key `sa_integrity_bypass`.

- [ ] **Step 1: Agregar el control** (en `popup.html`, en la sección de ajustes; dark-mode)

```html
<!-- Break-glass de integridad (emergencia) -->
<label style="display:flex;align-items:center;gap:8px;margin-top:10px;color:#e6e9ee;font-size:12px">
  <input type="checkbox" id="sa-integrity-bypass">
  🔓 Desactivar verificación de integridad (emergencia)
</label>
```

- [ ] **Step 2: Cablear el toggle** (en `popup.js`, al final del init)

```js
(async function initIntegrityBypass() {
  const el = document.getElementById('sa-integrity-bypass');
  if (!el) return;
  const { sa_integrity_bypass } = await chrome.storage.local.get('sa_integrity_bypass');
  el.checked = sa_integrity_bypass === true;
  el.addEventListener('change', () => {
    chrome.storage.local.set({ sa_integrity_bypass: el.checked });
  });
})();
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check extension/popup.js`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat(integrity): toggle break-glass en el popup (default OFF)"
```

---

### Task 8: `deploy.sh` — sellar + espejar `config.sig` + smoke-check

**Files:**
- Modify: `tools/deploy.sh`

**Interfaces:**
- Consumes: `tools/seal-config.mjs` (Task 4), `tools/verify-config-sig.mjs` (Task 5), `SA_INTEGRITY_PUBKEY` (leído de `extension/integrity-pubkey.js`), `SA_KMS_KEY` (env con el recurso KMS).

- [ ] **Step 1: Sellar tras el bump** (en `deploy.sh`, JUSTO después de escribir `version`/`lastUpdated` en `$CFG`, ANTES de `G add remote/`)

```bash
# --- sellar: scriptIntegrity + firma (config.sig) ---
if [ -n "${SA_KMS_KEY:-}" ]; then
  echo "→ seal: scriptIntegrity + firma KMS"
  node tools/seal-config.mjs --config "$MAINWT/remote/config.json" \
    --sig "$MAINWT/remote/config.sig" --scripts-dir "$MAINWT/remote/scripts" \
    --backend kms --kms-key "$SA_KMS_KEY" || { echo "ERROR: seal falló. Aborto."; exit 1; }
else
  echo "⚠️  SA_KMS_KEY no seteada — deploy SIN firmar (pre-Fase-0). config.sig no se actualiza."
fi
```

- [ ] **Step 2: Incluir `config.sig` en el commit y el espejo**

En el `G add remote/` de main ya entra `remote/config.sig` (está bajo `remote/`). En el bloque gh-pages, añadir el espejo del sig tras el de config.json:

```bash
G show main:remote/config.sig > "$MAINWT/config.sig" 2>/dev/null || true
```
y en el `G add`:
```bash
G add scripts config.json config.sig
```

- [ ] **Step 3: Smoke-check post-deploy** (tras el `check-deploy`/verificación en vivo existente)

GitHub Pages tarda 30-60s en propagar → el smoke-check **pollea la versión nueva** antes de verificar (si no, leería el config viejo y daría falso PASS/FAIL).

```bash
# --- smoke-check de firma EN VIVO (lag-aware) ---
REMOTE_BASE="https://oviazcan.github.io/SteelheadAutomator"
PUB=$(node -e "globalThis.self={};require('$MAINWT/extension/integrity-pubkey.js');process.stdout.write(self.SA_INTEGRITY_PUBKEY||'')")
if [ -n "$PUB" ]; then
  echo "→ smoke-check: esperando propagación de v$NEW y verificando firma EN VIVO"
  ok_ver=0
  for i in $(seq 1 20); do
    curl -s "$REMOTE_BASE/config.json?cb=$RANDOM" > /tmp/sa-live-config.json
    live=$(node -e "try{process.stdout.write(require('/tmp/sa-live-config.json').version||'')}catch(e){}")
    [ "$live" = "$NEW" ] && { ok_ver=1; break; }
    sleep 12
  done
  if [ "$ok_ver" = "1" ]; then
    curl -s "$REMOTE_BASE/config.sig?cb=$RANDOM" > /tmp/sa-live-config.sig
    node tools/verify-config-sig.mjs /tmp/sa-live-config.json /tmp/sa-live-config.sig "$PUB" \
      || { echo "🛑 La firma EN VIVO de v$NEW no verifica. Quien ya actualizó se bloqueará. Revisa YA."; exit 1; }
    echo "✓ smoke-check: firma EN VIVO de v$NEW verifica"
  else
    echo "⚠️  smoke-check: v$NEW no propagó en ~4min (lag de Pages). El pre-push ya validó la firma en git; re-verifica con deploy-status."
  fi
else
  echo "→ smoke-check omitido (pública aún placeholder — pre-Fase-2)"
fi
```
(`$NEW` = la versión bumpeada, ya disponible en `deploy.sh`.)

- [ ] **Step 4: Probar el deploy en seco (sin KMS)**

Run: `SA_SKIP_TESTS= bash -n tools/deploy.sh` (chequeo de sintaxis del script)
Expected: sin errores de sintaxis. (El deploy real firmado se corre en Fase 1.)

- [ ] **Step 5: Commit**

```bash
git add tools/deploy.sh
git commit -m "feat(integrity): deploy.sh sella + espeja config.sig + smoke-check post-deploy"
```

---

### Task 9: Hook `pre-push` — verificar `config.sig`

**Files:**
- Modify: `.githooks/pre-push`

- [ ] **Step 1: Agregar la verificación de firma** (en el bloque `refs/heads/gh-pages`, tras el check de version-bump, antes del `if [ "$bad" -ne 0 ]`)

```bash
  # 4) firma: config.sig debe verificar contra config.json con la pública embebida.
  PUB=$(node -e "globalThis.self={};require('./extension/integrity-pubkey.js');process.stdout.write(self.SA_INTEGRITY_PUBKEY||'')" 2>/dev/null)
  if [ -n "$PUB" ]; then
    git show "$local_sha:config.json" > /tmp/sa-pp-config.json 2>/dev/null
    git show "$local_sha:config.sig"  > /tmp/sa-pp-config.sig  2>/dev/null || echo "" > /tmp/sa-pp-config.sig
    if ! node tools/verify-config-sig.mjs /tmp/sa-pp-config.json /tmp/sa-pp-config.sig "$PUB" >/dev/null 2>&1; then
      echo "  ✗ config.sig NO verifica contra config.json (¿olvidaste seal? usa tools/deploy.sh)"
      bad=1
    fi
  fi
```

- [ ] **Step 2: Verificar sintaxis del hook**

Run: `bash -n .githooks/pre-push`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add .githooks/pre-push
git commit -m "feat(integrity): pre-push bloquea gh-pages si config.sig no verifica"
```

---

### Task 10: Runbook KMS (Fase 0) + suite + actualización de docs

**Files:**
- Create: `docs/deploy-signing-setup.md`
- Modify: `docs/superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md` (corregir: autopilot hereda seal vía deploy.sh), `CLAUDE.md` (mover seguridad #1 a "en progreso"), `docs/applets/` (bitácora nueva `security-integrity-signing.md`)

- [ ] **Step 1: Runbook KMS** — escribir `docs/deploy-signing-setup.md` con los comandos exactos:

```markdown
# Setup de firma (GCP KMS) — one-time (Fase 0)

Proyecto: **el del cliente**. Requiere `gcloud` autenticado con permisos de KMS Admin.

## 1. Crear key ring + llave de firma
    gcloud kms keyrings create steelhead-automator --location=global --project=<PROJ>
    gcloud kms keys create config-signing --location=global --keyring=steelhead-automator \
      --purpose=asymmetric-signing --default-algorithm=ec-sign-p256-sha256 --project=<PROJ>

## 2. Dar permiso de firmar (tú + el equipo)
    gcloud kms keys add-iam-policy-binding config-signing --location=global \
      --keyring=steelhead-automator --project=<PROJ> \
      --member="user:<correo>" --role="roles/cloudkms.signerVerifier"

## 3. Recurso de la llave (para SA_KMS_KEY)
    projects/<PROJ>/locations/global/keyRings/steelhead-automator/cryptoKeys/config-signing/cryptoKeyVersions/1

## 4. Sacar la pública y embeberla (Fase 2)
    gcloud kms keys versions get-public-key 1 --location=global --keyring=steelhead-automator \
      --key=config-signing --project=<PROJ> --output-file=/tmp/pub.pem
    # convertir PEM SPKI → base64 de una línea y pegar en extension/integrity-pubkey.js:
    openssl pkey -pubin -in /tmp/pub.pem -outform DER | base64 | tr -d '\n'

## 5. Al salir el consultor
    gcloud kms keys remove-iam-policy-binding config-signing ... --member="user:<consultor>" ...

## Deploy firmado
    export SA_KMS_KEY="projects/.../cryptoKeyVersions/1"
    tools/deploy.sh "mensaje"   # seal + smoke-check automáticos
```

- [ ] **Step 2: Correr TODA la suite**

Run: `tools/run-tests.sh`
Expected: VERDE, incluyendo los 5 archivos de test nuevos (integrity-verify, der-to-p1363, seal-config, seal-config-kms, verify-config-sig).

- [ ] **Step 3: Actualizar docs**

- En el spec: corregir la mención de `autopilot-deploy.sh` — hereda `seal` porque llama a `deploy.sh` (no se toca por separado).
- En `CLAUDE.md` (§Seguridad → Pendientes #1): cambiar de "Plan:" a "**En progreso (spec+plan 2026-07-09)**: firma ECDSA P-256 vía KMS; Fase 0/1 pendientes".
- Crear `docs/applets/security-integrity-signing.md` con: qué hace, archivos, cómo firmar/verificar, el rollout de 3 fases, y el break-glass.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy-signing-setup.md docs/superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md CLAUDE.md docs/applets/security-integrity-signing.md
git commit -m "docs(integrity): runbook KMS Fase 0 + actualiza spec/CLAUDE/bitácora"
```

---

## Fases de deploy (tras implementar todas las tareas)

- **Fase 0** (manual, cuando decidas): correr el runbook KMS, exportar `SA_KMS_KEY`, embeber la pública real en `integrity-pubkey.js`.
- **Fase 1:** `tools/deploy.sh "…"` con `SA_KMS_KEY` seteada → gh-pages queda con `scriptIntegrity` + `config.sig`. Extensión actual sigue igual. Smoke-check confirma.
- **Fase 2:** bump `extension/manifest.json` + `config.extensionVersion`, republicar el zip con la pública embebida → verificación fail-closed activa. Distribuir.

## Notas de coherencia con el spec

- La verificación queda **fail-open mientras `SA_INTEGRITY_PUBKEY` esté vacío** (Tasks 6): esto permite mergear todo sin romper a nadie; el fail-closed se activa al embeber la pública (Fase 2). Es intencional y consistente con el rollout del spec.
- `background.js` no es testeable en Node (usa `chrome.*`/`importScripts`); su lógica pura vive en `integrity-verify.js` (Task 1, sí testeada). La verificación en runtime se valida manualmente en Fase 2 (incl. prueba de tamper local → fail-closed).
- **Canonicalización de `config.json`:** `sealConfig` re-serializa con `JSON.stringify(config,null,2)+'\n'`. El primer deploy con seal puede reformatear `config.json` una vez (diff grande si el actual no está ya en ese formato); después es **estable e idempotente**. El `writeConfigHashes` del hash-autopilot ("preserva formato") queda superado por seal en cada deploy — inofensivo (el config termina canónico siempre). El invariante byte-a-byte del `pre-push` se mantiene porque main y gh-pages reciben el MISMO texto sellado. Verificar en la Task 8 que `config.json` actual ya sea 2-espacios (probable) para que el diff inicial sea mínimo.
- **`importScripts` en MV3:** `integrity-verify.js` e `integrity-pubkey.js` viven en la raíz de `extension/` (junto a `background.js`) y se empaquetan en el zip. Un error de sintaxis en cualquiera **tumba el SW entero** → el `node --check` de la Task 6 Step 5 es obligatorio.
