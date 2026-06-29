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
      || /(Bad Gateway|Service Unavailable|Gateway Time-?out|Too Many Requests|Failed to fetch|NetworkError|ECONNRESET|ETIMEDOUT|timeout|AbortError|aborted)/i.test(m);
  }

  // ── Display image (foto principal del PN para los tableros) ──────────────────
  // Solo una IMAGEN puede ser display image (nunca un plano PDF/DWG).
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|bmp|tiff?)$/i;
  function isImageFile(name) {
    return IMAGE_EXT.test(String(name == null ? '' : name));
  }

  // El descriptor es lo que va tras el PRIMER "__" (sin extensión).
  function descriptorOf(filename) {
    let s = String(filename == null ? '' : filename).replace(/\.[^.\/\\]+$/, '');
    const idx = s.indexOf('__');
    return idx < 0 ? '' : s.slice(idx + 2).trim();
  }

  // Tokens con los que Cowork (o el operador) marca explícitamente la principal.
  // Match por token con FRONTERA: el descriptor es igual al token, o empieza con
  // el token seguido de un char no-letra (dígito/separador/fin). Así "__DI" y
  // "__foto1" sí, pero "__difuminado"/"__diagram" (token + letra) no.
  const PRINCIPAL_TOKENS = ['principal', 'ppal', 'di', 'foto', 'photo', 'main', 'portada', 'display', 'cover'];
  function isPrincipalDescriptor(filename) {
    const d = descriptorOf(filename).toLowerCase();
    if (!d) return false;
    return PRINCIPAL_TOKENS.some((t) =>
      d === t || (d.startsWith(t) && !/[a-z]/.test(d.charAt(t.length))));
  }

  // De los archivos de un grupo (cada uno {name, size}), elige la foto principal:
  //   1) si hay imágenes con descriptor de principal → la más grande de ESAS;
  //   2) si no, la imagen más grande por bytes;
  //   3) si no hay ninguna imagen (solo PDFs/planos) → null.
  // Desempate determinista: mayor size, luego name asc (estable para tests).
  function selectDisplayImage(files) {
    const imgs = (files || []).filter((x) => x && isImageFile(x.name));
    if (!imgs.length) return null;
    const marked = imgs.filter((x) => isPrincipalDescriptor(x.name));
    const pool = marked.length ? marked : imgs;
    return pool.slice().sort((a, b) =>
      (Number(b.size) || 0) - (Number(a.size) || 0) ||
      String(a.name).localeCompare(String(b.name)))[0];
  }

  // Lee el estado de display image de un PN (de GetPartNumber.partNumberById):
  //   - displayImageId: el id del vínculo marcado como portada (null si no tiene).
  //   - fileIdByName: Map<originalName normalizado → partNumberUserFile.id>.
  // Lee EXCLUSIVAMENTE el bucket del PN (misma disciplina que existingOriginalNames):
  // los ids de buckets de nodo/instrucciones (rackType…) jamás entran al mapa.
  function readDisplayState(pnNode) {
    const displayImageId = pnNode && pnNode.displayImageId != null ? pnNode.displayImageId : null;
    const fileIdByName = new Map();
    const nodes =
      (pnNode &&
        pnNode.partNumberUserFilesByPartNumberId &&
        pnNode.partNumberUserFilesByPartNumberId.nodes) ||
      [];
    for (const n of nodes) {
      const on = n && n.userFileByUserFileName && n.userFileByUserFileName.originalName;
      if (on && n.id != null) fileIdByName.set(norm(on), n.id);
    }
    return { displayImageId, fileIdByName };
  }

  const api = { extractPNName, selectMatchingPNs, existingOriginalNames, isAlreadyLinked, norm, isTransientError, isImageFile, isPrincipalDescriptor, selectDisplayImage, readDisplayState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FileUploaderCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
