// Steelhead File Uploader — núcleo puro (sin DOM ni red)
// Matching de archivo→PN, selección de homónimos y dedup contra el bucket del PN.
// Convención de nombre: <PN>__<descriptor>.<ext>  (doble guion bajo, separador seguro).
// Dual export: module.exports (tests con node) + root.FileUploaderCore (browser).
// Golden tests: tools/test/file-uploader-core.test.js
(function (root) {
  'use strict';

  // Nombre de archivo → nombre del PN.
  // 1) quita la última extensión, 2) si hay "__" corta en el primero (descriptor),
  // 3) si no, tolera el patrón de copia del legacy crudo (" (2)", " copy"), 4) trim.
  function extractPNName(filename) {
    let s = String(filename == null ? '' : filename);
    s = s.replace(/\.[^.\/\\]+$/, ''); // última extensión
    const idx = s.indexOf('__');
    if (idx >= 0) {
      s = s.slice(0, idx);
    } else {
      s = s.replace(/\s*\(\d+\)\s*$/, '').replace(/\s+copy\s*$/i, '');
    }
    return s.trim();
  }

  function norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  // TODOS los PNs cuyo `name` coincide EXACTO (case-insensitive, trim) con pnName.
  // Devuelve los nodos originales (no solo el primero) — los homónimos son ~40%.
  function selectMatchingPNs(nodes, pnName) {
    const target = norm(pnName);
    if (!target) return [];
    return (nodes || []).filter((n) => n && norm(n.name) === target);
  }

  // Set de originalName (normalizados) de los archivos YA vinculados AL PN.
  // Lee EXCLUSIVAMENTE partNumberUserFilesByPartNumberId; ignora a propósito
  // cualquier bucket de nodo/instrucciones (processNode, recipeNode, rackType…).
  function existingOriginalNames(pnNode) {
    const out = new Set();
    const nodes =
      (pnNode &&
        pnNode.partNumberUserFilesByPartNumberId &&
        pnNode.partNumberUserFilesByPartNumberId.nodes) ||
      [];
    for (const n of nodes) {
      const on = n && n.userFileByUserFileName && n.userFileByUserFileName.originalName;
      if (on) out.add(norm(on));
    }
    return out;
  }

  // ¿El PN ya tiene un archivo con este nombre? (evita duplicar/encimar)
  function isAlreadyLinked(existingSet, fileName) {
    return !!existingSet && existingSet.has(norm(fileName));
  }

  // ¿Vale la pena reintentar este error? true para 5xx/429/red (transitorios:
  // gateway saturado, rate-limit), false para 4xx de lógica (404, 400) y vacíos.
  function isTransientError(message) {
    const m = String(message == null ? '' : message);
    if (!m) return false;
    return /HTTP\s*(429|500|502|503|504)\b/i.test(m)
      || /(Bad Gateway|Service Unavailable|Gateway Time-?out|Too Many Requests|Failed to fetch|NetworkError|ECONNRESET|ETIMEDOUT|timeout)/i.test(m);
  }

  const api = { extractPNName, selectMatchingPNs, existingOriginalNames, isAlreadyLinked, norm, isTransientError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FileUploaderCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
