// tools/verify-config-sig.mjs
// Verifica que un config.json + config.sig verifiquen contra una pública dada.
// Lo usan el hook pre-push y el smoke-check post-deploy.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const SAIntegrity = require('../extension/integrity-verify.js');

export async function verifyFiles({ configPath, sigPath, pubKeyB64 }) {
  const configText = readFileSync(configPath, 'utf8');
  const sigB64 = readFileSync(sigPath, 'utf8').trim();
  return SAIntegrity.verifyConfigSignature(configText, sigB64, pubKeyB64);
}

// ¿Se está ejecutando como CLI (y no importado como módulo)?
//
// La comparación ingenua `import.meta.url === \`file://${process.argv[1]}\`` falla cuando la ruta
// de invocación pasa por un symlink: Node resuelve el symlink en `import.meta.url` pero NO en
// `process.argv[1]`. En macOS eso ocurre con cualquier ruta bajo /tmp o /var/folders (mktemp),
// que son symlinks a /private/…. El efecto era el peor posible para un verificador de firma:
// el bloque no corría, el proceso salía 0 y quien lo invocó leía "todo bien" SIN QUE SE HUBIERA
// VERIFICADO NADA. Mordió al hook pre-push el 2026-08-06 (el hook copia el script a un mktemp).
// Por eso se comparan las rutas ya resueltas por realpath, de los dos lados.
const runningAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (runningAsCli) {
  const [configPath, sigPath, pubKeyB64] = process.argv.slice(2);
  // Falla cerrado: sin los tres argumentos no hay nada que verificar, y salir 0 aquí volvería
  // a significar "todo bien" para el que invoca.
  if (!configPath || !sigPath || !pubKeyB64) {
    console.error('uso: verify-config-sig.mjs <config.json> <config.sig> <pubKeyB64>');
    process.exit(2);
  }
  let ok = false;
  try {
    ok = await verifyFiles({ configPath, sigPath, pubKeyB64 });
  } catch (err) {
    console.error(`✗ no se pudo verificar config.sig: ${err && err.message ? err.message : err}`);
    process.exit(2);
  }
  if (!ok) { console.error('✗ config.sig NO verifica'); process.exit(1); }
  console.log('✓ config.sig verifica'); process.exit(0);
}
