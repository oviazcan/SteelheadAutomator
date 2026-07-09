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

test('shouldTrustOfflineConfig: fail-open sin verificación; fail-closed en Fase 2 sin sello', () => {
  // No verificando (pre-Fase-2 / break-glass) → confía como antes, con o sin sello
  assert.equal(SAIntegrity.shouldTrustOfflineConfig(false, false), true);
  assert.equal(SAIntegrity.shouldTrustOfflineConfig(false, true), true);
  // Verificando (Fase 2) → solo si el config offline se verificó antes (tiene sello)
  assert.equal(SAIntegrity.shouldTrustOfflineConfig(true, true), true);
  assert.equal(SAIntegrity.shouldTrustOfflineConfig(true, false), false);
});
