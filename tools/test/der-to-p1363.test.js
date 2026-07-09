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
