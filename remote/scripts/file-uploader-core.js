// Steelhead File Uploader — núcleo puro (sin DOM ni red)
// Matching de archivo→PN, selección de homónimos y dedup contra el bucket del PN.
// Convención de nombre: <PN>__<descriptor>.<ext>  (doble guion bajo, separador seguro).
// Dual export: module.exports (tests con node) + root.FileUploaderCore (browser).
// Golden tests: tools/test/file-uploader-core.test.js
(function (root) {
  'use strict';

  // Códigos de vista (whitelist de dominio, viven en config.fileUploader.viewCodes).
  // Acepta array (["LIZ","LDE"]) o string ("LIZ, LDE") → Set en MAYÚSCULAS+trim.
  function normViewCodes(viewCodes) {
    const arr = Array.isArray(viewCodes)
      ? viewCodes
      : String(viewCodes == null ? '' : viewCodes).split(',');
    const out = new Set();
    for (const c of arr) {
      const t = String(c == null ? '' : c).trim().toUpperCase();
      if (t) out.add(t);
    }
    return out;
  }

  // Descompone un nombre-sin-extensión que use la convención de guion SIMPLE
  // <PN>_<VISTA>_<consecutivo> (ej. "NAT1219802_LIZ_02"). Devuelve
  // {pn, view, seq} o null si no calza el patrón. El `.*` es greedy → agarra el
  // ÚLTIMO bloque _<letras>_<dígitos> como (vista,consecutivo), así un PN que ya
  // trae "_" interno (ej. "ABC_12") sobrevive: "ABC_12_LIZ_03" → pn="ABC_12".
  function splitViewCoded(sNoExt) {
    const m = String(sNoExt == null ? '' : sNoExt).match(/^(.*)_([A-Za-z]{1,6})_(\d{1,4})$/);
    if (!m || !m[1]) return null;
    return { pn: m[1], view: m[2].toUpperCase(), seq: m[3] };
  }

  // Nombre de archivo → nombre del PN.
  // 1) quita la última extensión.
  // 2) si hay "__" corta en el primero (convención <PN>__<descriptor>).
  // 3) si NO hay "__" pero el nombre calza <PN>_<VISTA>_<num> Y <VISTA> es un
  //    código de vista REGISTRADO (whitelist) → quita el sufijo (convención de
  //    Cowork con guion simple). La whitelist es clave: sin ella cortaríamos por
  //    error los NP que ya llevan "_" en su nombre (57/23,926 en TLC).
  // 4) si no, tolera el patrón de copia del legacy crudo (" (2)", " copy").
  // 5) trim.
  function extractPNName(filename, viewCodes) {
    let s = String(filename == null ? '' : filename);
    s = s.replace(/\.[^.\/\\]+$/, ''); // última extensión
    const idx = s.indexOf('__');
    if (idx >= 0) {
      return s.slice(0, idx).trim();
    }
    const set = normViewCodes(viewCodes);
    if (set.size) {
      const parts = splitViewCoded(s);
      if (parts && set.has(parts.view)) return parts.pn.trim();
    }
    s = s.replace(/\s*\(\d+\)\s*$/, '').replace(/\s+copy\s*$/i, '');
    return s.trim();
  }

  // Diagnóstico para el reporte de "no encontrados": si el nombre PARECE seguir
  // la convención <PN>_<VISTA>_<num> pero <VISTA> NO está registrado, devuelve
  // ese código (en MAYÚSCULAS) para sugerirle al operador agregarlo al config.
  // Devuelve null si no parece view-coded o si el código sí está registrado.
  // Evita el "no encontrado" mudo que confunde código-de-vista-nuevo con NP-inexistente.
  function unregisteredViewCode(filename, viewCodes) {
    let s = String(filename == null ? '' : filename).replace(/\.[^.\/\\]+$/, '');
    if (s.indexOf('__') >= 0) return null;
    const parts = splitViewCoded(s);
    if (!parts) return null;
    // el token de vista debe parecer un código (2-5 letras), no un consecutivo suelto
    if (parts.view.length < 2 || parts.view.length > 5) return null;
    return normViewCodes(viewCodes).has(parts.view) ? null : parts.view;
  }

  // NFC unifica acentos: macOS guarda nombres en NFD (Ñ = N+◌̃) y el CSV suele
  // venir en NFC (Ñ = un code point). Sin normalizar, "ESTAÑO" del ERP no matchea
  // el del CSV → falso "no vinculada". normalize antes de lowercase/trim.
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFC').trim().toLowerCase();
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

  // ¿Es la vista ISO (isométrica 3/4)? La portada preferida: el Instructivo de
  // Fotografía dice que "la vista ISO nunca se omite" → toda categoría la tiene y
  // es la toma que mejor comunica el volumen. Detecta ISO en ambas convenciones:
  //   · guion simple: <PN>_ISO_##  (view === 'ISO', estructural, no depende de config)
  //   · doble: <PN>__iso…          (descriptor empieza con "iso" en frontera)
  function isIsoView(filename) {
    const s = String(filename == null ? '' : filename).replace(/\.[^.\/\\]+$/, '');
    const idx = s.indexOf('__');
    if (idx >= 0) {
      const d = s.slice(idx + 2).trim().toLowerCase();
      return d === 'iso' || (d.startsWith('iso') && !/[a-z]/.test(d.charAt(3)));
    }
    const parts = splitViewCoded(s);
    return !!parts && parts.view === 'ISO';
  }

  // De los archivos de un grupo (cada uno {name, size}), elige la foto principal:
  //   1) si hay vista ISO → la más grande de ESAS (regla de portada del instructivo);
  //   2) si no, si hay imágenes con descriptor de principal (conv. "__") → la más grande de ESAS;
  //   3) si no, la imagen más grande por bytes;
  //   4) si no hay ninguna imagen (solo PDFs/planos) → null.
  // Desempate determinista: mayor size, luego name asc (estable para tests).
  function selectDisplayImage(files) {
    const imgs = (files || []).filter((x) => x && isImageFile(x.name));
    if (!imgs.length) return null;
    const iso = imgs.filter((x) => isIsoView(x.name));
    const marked = imgs.filter((x) => isPrincipalDescriptor(x.name));
    const pool = iso.length ? iso : (marked.length ? marked : imgs);
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

  // ── Backfill: ingesta del CSV de Cowork (PN → displayImage ya decidido) ──────
  // Una línea CSV → campos, respetando comillas ("" = comilla escapada) y comas
  // internas. No maneja newlines dentro de comillas (los nombres de archivo no
  // los tienen).
  function splitCsvLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  // Parsea el CSV de Cowork → [{pn, displayImage, tipo, fuente}].
  // Header mapeado por NOMBRE de columna (case-insensitive); exige PN + displayImage.
  // Cowork ya eligió la principal (columna displayImage) → el backfill solo la aplica.
  function parseBackfillCsv(text) {
    let s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
    const lines = s.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
    if (!lines.length) return [];
    const header = splitCsvLine(lines[0]).map((h) => norm(h));
    const idx = {};
    header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
    const pnI = idx['pn'], diI = idx['displayimage'];
    if (pnI == null || diI == null) {
      throw new Error('CSV sin encabezado reconocible (faltan columnas PN/displayImage)');
    }
    const tipoI = idx['tipo'], fuenteI = idx['fuente'];
    const at = (c, i) => (i != null && c[i] != null ? String(c[i]).trim() : '');
    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const c = splitCsvLine(lines[li]);
      const pn = at(c, pnI), displayImage = at(c, diI);
      if (!pn && !displayImage) continue;
      rows.push({ pn, displayImage, tipo: at(c, tipoI), fuente: at(c, fuenteI) });
    }
    return rows;
  }

  const api = { extractPNName, unregisteredViewCode, normViewCodes, selectMatchingPNs, existingOriginalNames, isAlreadyLinked, norm, isTransientError, isImageFile, isPrincipalDescriptor, isIsoView, selectDisplayImage, readDisplayState, parseBackfillCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FileUploaderCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
