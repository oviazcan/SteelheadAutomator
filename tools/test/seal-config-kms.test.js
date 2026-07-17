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

test('kmsSigner pasa el PAYLOAD crudo (no el digest) al firmante y convierte DER→64B', async () => {
  const { kmsSigner } = await import('../seal-config.mjs');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = new TextEncoder().encode('config-bytes');
  let gotMessage = null;
  const fakeSign = (message) => {
    gotMessage = message;
    return nodeSign('sha256', Buffer.from('x'), { key: privateKey, dsaEncoding: 'der' }); // cualquier DER válido
  };
  const signer = kmsSigner({
    keyResource: 'projects/P/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
    signMessage: fakeSign
  });
  const raw = await signer.sign(payload);
  assert.equal(raw.length, 64);
  // gcloud (--digest-algorithm=sha256) hashea el input, así que se le pasa el MENSAJE crudo,
  // no un sha256 pre-calculado — de lo contrario gcloud re-hashearía (doble hash).
  assert.deepEqual(new Uint8Array(gotMessage), new Uint8Array(payload));
});
