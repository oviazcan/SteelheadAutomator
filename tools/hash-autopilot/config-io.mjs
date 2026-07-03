// tools/hash-autopilot/config-io.mjs
// Lee/escribe los hashes de persisted queries en remote/config.json.
import { readFileSync, writeFileSync } from 'fs';

// Devuelve un mapa op→hash (recorre el JSON buscando valores que sean SHA-256).
export function readConfigHashes(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const out = {};
  const walk = (o) => {
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
        else walk(v);
      }
    }
  };
  walk(cfg);
  return out;
}

// Reemplaza in-place cada "op": "<hash>" por el nuevo hash (todas las ocurrencias),
// preservando el formato del archivo (no re-serializa el JSON → sin ruido de diff).
export function writeConfigHashes(configPath, updates) {
  let text = readFileSync(configPath, 'utf8');
  for (const [op, newHash] of Object.entries(updates)) {
    const re = new RegExp(`("${op}"\\s*:\\s*")[0-9a-f]{64}(")`, 'g');
    text = text.replace(re, `$1${newHash}$2`);
  }
  writeFileSync(configPath, text);
}
