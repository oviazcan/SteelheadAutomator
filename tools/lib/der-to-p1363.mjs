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
