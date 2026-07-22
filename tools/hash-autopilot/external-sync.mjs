// tools/hash-autopilot/external-sync.mjs
// Sincroniza los hashes rotados EXTERNOS (plan.external) a los repos que los usan
// (Reportes SH `steelhead_client.py`, PowerTools `sync/*.py`) — el mismo hash que
// la extensión, pero viviendo en OTRO archivo. Cierra el hueco: el motor ya
// CAPTURA y VALIDA el hash externo; esto lo ESCRIBE en el otro repo en vez de solo
// avisar. El formato clave:valor es idéntico a config.json, así que reusa el regex.
//
// Diseño testeable: applyHashesToText es PURO; syncExternalToSinks hace I/O vía
// `deps` inyectables (readFile/writeFile/exists) → mock en el test. El COMMIT lo
// hace el caller (hash-autopilot.mjs) sobre los repos con `changed`, para no meter
// git en el módulo puro.
import { join } from 'path';

// Reemplaza `"op": "<64hex>"` por el hash nuevo, SOLO donde la op ya existe.
// Devuelve { text, applied:[op...], changed:bool }. Ignora hashes mal formados
// (guard) y ops sin match. `changed` distingue "hubo reemplazo real" de "ya estaba
// igual" (idempotencia: re-aplicar el mismo hash no marca changed).
export function applyHashesToText(text, updates) {
  const applied = [];
  let out = text;
  for (const [op, newHash] of Object.entries(updates || {})) {
    if (!/^[0-9a-f]{64}$/.test(newHash || '')) continue; // guard: hash inválido
    const re = new RegExp(`("${op}"\\s*:\\s*")[0-9a-f]{64}(")`, 'g');
    let matched = false;
    out = out.replace(re, (_m, p1, p2) => { matched = true; return `${p1}${newHash}${p2}`; });
    if (matched) applied.push(op);
  }
  return { text: out, applied, changed: out !== text };
}

// Escribe los hashes externos en cada sink que contenga la op. `deps`:
//   exists(path)->bool, readFile(path)->string, writeFile(path,string)->void.
// Devuelve:
//   report:  [{ name, repo, file, applied:[op], changed, missing? }]
//   changedRepos: [repo...]  (dedupe — para que el caller commitee 1 vez por repo)
//   notFound: [op...]        (ops que NINGÚN sink contenía — anomalía a reportar)
export function syncExternalToSinks(externalUpdates, sinks, deps) {
  const report = [];
  const appliedAnywhere = new Set();
  const changedRepos = new Set();
  for (const s of sinks || []) {
    const full = join(s.repo, s.file);
    if (!deps.exists(full)) { report.push({ name: s.name, repo: s.repo, file: s.file, missing: true }); continue; }
    const text = deps.readFile(full);
    const { text: out, applied, changed } = applyHashesToText(text, externalUpdates);
    if (changed) { deps.writeFile(full, out); changedRepos.add(s.repo); }
    applied.forEach((op) => appliedAnywhere.add(op));
    report.push({ name: s.name, repo: s.repo, file: s.file, applied, changed });
  }
  const notFound = Object.keys(externalUpdates || {}).filter((op) => !appliedAnywhere.has(op));
  return { report, changedRepos: [...changedRepos], notFound };
}
