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
