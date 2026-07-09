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
