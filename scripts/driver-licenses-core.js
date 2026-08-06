// Licencias de Choferes — núcleo puro (sin DOM ni red).
//
// Administra las identificaciones de los choferes EXTERNOS y publica el catálogo al hook
// low-code `pdf:SHIPMENT_TEMPLATE` de SteelheadPowerTools, que pinta la licencia en la lista
// de embarque cuando el nombre del chofer aparece en las notas o en el nombre del embarque.
//
// Contrato completo (marcadores, formato canónico, flujo de publicación con diff):
//   SteelheadPowerTools/docs/specs/2026-08-05-applet-licencias-choferes.md
//
// ⚠ LA NORMALIZACIÓN ES UN CONTRATO. `keyFromOriginalName` tiene que producir exactamente la
// misma llave que `licenseNormalizeText` del hook (espejo de `lib/driver_license_match.mjs`).
// Si cambia una, cambian las dos: el hook busca en las notas justo las llaves que este core
// genera. Cubierto por `tools/test/driver-licenses-core.test.js`.
//
// Golden tests: tools/test/driver-licenses-core.test.js
(function (root) {
  'use strict';

  // Marcadores del bloque dentro del .ts del hook. Son el contrato de sustitución.
  const MARK_START = '// <<<LICENCIAS:INICIO>>>';
  const MARK_END = '// <<<LICENCIAS:FIN>>>';
  const BLOCK_HEADER_SUFFIX = ' generado — no editar a mano · fuente: carpeta «{folder}» de Uploaded Files';
  const FILE_PATH = '/api/files/';

  // Diacríticos del español explícitos, igual que en el hook: no depender de String.normalize
  // ni de que el runtime traiga ICU.
  const DIACRITICS = {
    'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a', 'å': 'a',
    'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
    'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
    'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o',
    'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u',
    'ñ': 'n', 'ç': 'c'
  };

  // "Héctor  Proquipa/2" → "hector proquipa 2"
  function normalizeText(value) {
    if (value === null || value === undefined) return '';
    const lower = String(value).toLowerCase();
    let out = '';
    for (let i = 0; i < lower.length; i++) {
      const ch = lower.charAt(i);
      const mapped = DIACRITICS[ch];
      if (mapped) { out += mapped; continue; }
      out += (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ? ch : ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // "Miguel Á." → "miguel-a"
  function slugifyKey(value) {
    return normalizeText(value).replace(/ /g, '-');
  }

  // Prefijo con el que el applet registra las licencias que sube.
  //
  // Por qué existe: `CreateUserFile` sólo acepta `name` y `originalName` — NO hay mutation
  // disponible para asignar la carpeta, así que el applet no puede dejar el archivo dentro de
  // «Licencias» por sí solo. El prefijo lo sustituye como criterio de pertenencia y sale
  // ganando: no depende de que exista una carpeta, ni de su id (que es por dominio), ni de que
  // alguien se acuerde de elegirla en el combo.
  const LICENSE_PREFIX = 'licencia-';

  // "Héctor.png" → "hector"  ·  "licencia-fernando.png" → "fernando"
  //
  // Tolera las dos formas a propósito: las 8 licencias que ya viven en la carpeta se subieron
  // sin prefijo, y tienen que seguir resolviendo a la misma llave que el hook busca.
  // La extensión se quita ANTES de normalizar; si no, el punto se volvería separador y la
  // llave quedaría "hector-png".
  function keyFromOriginalName(originalName) {
    let stem = String(originalName || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const norm = normalizeText(stem);
    if (norm.indexOf(normalizeText(LICENSE_PREFIX).trim()) === 0) {
      stem = stem.replace(/^\s*licencia[\s_-]+/i, '');
    }
    return slugifyKey(stem);
  }

  // Nombre con el que se REGISTRA en Steelhead (`originalName` de CreateUserFile).
  // El operador sube "IMG_4821.jpg" y teclea "Fernando" → queda "licencia-fernando.jpg".
  function buildUploadName(key, sourceFileName) {
    const m = String(sourceFileName || '').match(/\.([A-Za-z0-9]{1,5})$/);
    const ext = m ? m[1].toLowerCase() : 'png';
    return LICENSE_PREFIX + slugifyKey(key) + '.' + ext;
  }

  // ¿Este archivo es una licencia? Vale por CUALQUIERA de los dos caminos:
  //   · el prefijo (lo que sube el applet, sin depender de carpetas), o
  //   · estar en la carpeta indicada, por NOMBRE — nunca por folderId, que en TLC es 695 y en
  //     MTY es otro número.
  function isLicenseFile(node, folderName) {
    const n = node || {};
    const original = String(n.originalName || '');
    if (normalizeText(original).indexOf('licencia') === 0) return true;
    if (!folderName) return false;
    const folder = (n.fileFolderByFolderId || {}).name || '';
    return normalizeText(folder) === normalizeText(folderName);
  }

  // Filtra los nodos de SearchUserFilesQuery que son licencias.
  function selectLicenseFiles(nodes, folderName) {
    const list = Array.isArray(nodes) ? nodes : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (isLicenseFile(list[i], folderName)) out.push(list[i]);
    }
    return out;
  }

  function isImageFile(name) {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(name || ''));
  }

  // Liga perenne. `<name>` no es un id por dominio: /api/files/ no valida dominio, así que la
  // misma liga sirve en TLC y en MTY.
  function buildLicenseUrl(fileName, host) {
    const clean = String(fileName || '').trim();
    if (!clean) return '';
    if (/^(https?:)?\/\//i.test(clean)) return clean;
    const base = String(host || '').replace(/\/+$/, '');
    return base + FILE_PATH + clean.replace(/^\/+/, '');
  }

  // Nodos de SearchUserFilesQuery → catálogo { llave: <name> } + los avisos de lo descartado.
  //
  // `files` debe venir ordenado por fecha DESCENDENTE: ante llaves repetidas gana el más
  // reciente, que es lo correcto cuando alguien re-sube una licencia — en Steelhead no existe
  // «reemplazar», cada subida crea un `<name>` nuevo y el viejo sigue vivo.
  function buildCatalog(files) {
    const catalog = {};
    const warnings = [];
    const list = Array.isArray(files) ? files : [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i] || {};
      const original = node.originalName || '';
      const name = node.name || '';
      const key = keyFromOriginalName(original);
      if (!key) {
        warnings.push('Se ignoró «' + original + '»: no produce un nombre válido.');
        continue;
      }
      if (!name) {
        warnings.push('Se ignoró «' + original + '»: no trae nombre interno de archivo.');
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(catalog, key)) {
        warnings.push(
          'Nombre repetido «' + key + '»: se conserva la versión más reciente y se ignora «' +
          original + '». Si son dos choferes distintos, renombra uno.'
        );
        continue;
      }
      catalog[key] = name;
    }
    return { catalog: catalog, warnings: warnings };
  }

  // Bloque en el formato canónico que emite tsc: 4 espacios, un espacio tras los dos puntos,
  // comillas dobles, orden alfabético. Ese formato es lo que hace que el bloque salga
  // BYTE-IDÉNTICO en `code` y en `compiled` — y por eso el applet no necesita compilar
  // TypeScript en el navegador. Verificado el 2026-08-05 contra `tsc --target es2017`.
  function renderBlock(catalog, folder) {
    const keys = Object.keys(catalog || {}).sort();
    const lines = [];
    lines.push(MARK_START + BLOCK_HEADER_SUFFIX.replace('{folder}', String(folder || 'Licencias')));
    lines.push('const DRIVER_LICENSES = {');
    for (let i = 0; i < keys.length; i++) {
      const comma = i === keys.length - 1 ? '' : ',';
      lines.push('    "' + keys[i] + '": "' + catalog[keys[i]] + '"' + comma);
    }
    lines.push('};');
    lines.push(MARK_END);
    return lines.join('\n');
  }

  function blockPattern() {
    return new RegExp(
      MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' +
      MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'g'
    );
  }

  // Cuántas veces aparece el bloque. Debe ser exactamente 1: cero significa que alguien editó
  // el hook a mano y borró los marcadores; más de uno, que quedó duplicado. En ambos casos hay
  // que ABORTAR sin publicar — sustituir a ciegas dejaría el hook inconsistente.
  function findBlocks(source) {
    const found = String(source || '').match(blockPattern());
    return found || [];
  }

  function replaceBlock(source, block) {
    const found = findBlocks(source);
    if (found.length === 0) {
      throw new Error(
        'No se encontraron los marcadores del catálogo. El hook fue editado a mano; ' +
        'no se publicó nada.'
      );
    }
    if (found.length > 1) {
      throw new Error(
        'Los marcadores aparecen ' + found.length + ' veces y debe haber exactamente uno; ' +
        'no se publicó nada.'
      );
    }
    return String(source).replace(blockPattern(), function () { return block; });
  }

  // Red de seguridad DESPUÉS de sustituir: `code` y `compiled` tienen que traer el bloque
  // idéntico. Si no, el hook publicado correría un catálogo distinto al que dice su fuente.
  function blocksMatch(code, compiled) {
    const a = findBlocks(code);
    const b = findBlocks(compiled);
    return a.length === 1 && b.length === 1 && a[0] === b[0];
  }

  // Lee el catálogo que hoy vive en el .ts, para poder mostrar el diff antes de publicar.
  function parseBlockCatalog(source) {
    const found = findBlocks(source);
    if (found.length !== 1) return null;
    const catalog = {};
    const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(found[0])) !== null) catalog[m[1]] = m[2];
    return catalog;
  }

  // Diff en lenguaje de negocio: qué chofer entra, cuál sale y a cuál le cambió el archivo.
  function diffCatalogs(current, next) {
    const a = current || {};
    const b = next || {};
    const added = [];
    const removed = [];
    const changed = [];
    const keysB = Object.keys(b).sort();
    for (let i = 0; i < keysB.length; i++) {
      const k = keysB[i];
      if (!Object.prototype.hasOwnProperty.call(a, k)) added.push(k);
      else if (a[k] !== b[k]) changed.push({ key: k, from: a[k], to: b[k] });
    }
    const keysA = Object.keys(a).sort();
    for (let i = 0; i < keysA.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, keysA[i])) removed.push(keysA[i]);
    }
    return { added: added, removed: removed, changed: changed,
             isEmpty: !added.length && !removed.length && !changed.length };
  }

  // Valida el nombre que el operador teclea al subir una licencia.
  //
  // La colisión NO se resuelve sobrescribiendo: dos choferes distintos con el mismo nombre de
  // pila son dos personas, y pisar a una dejaría su licencia sin imprimirse en silencio. Se
  // avisa y se pide un nombre alternativo (la convención acordada con el cliente es agregar la
  // inicial del apellido).
  function validateDriverName(rawName, catalog, options) {
    const opts = options || {};
    const key = slugifyKey(rawName);
    if (!key) {
      return { ok: false, key: '', reason: 'empty',
               message: 'Escribe el nombre con el que se va a nombrar al chofer en el embarque.' };
    }
    if (key.replace(/-/g, '').length < 3) {
      return { ok: false, key: key, reason: 'too-short',
               message: 'El nombre «' + rawName + '» es muy corto: se confundiría con otras palabras de las notas.' };
    }
    const exists = Object.prototype.hasOwnProperty.call(catalog || {}, key);
    if (exists && !opts.allowReplace) {
      return { ok: false, key: key, reason: 'collision',
               message: 'Ya hay una licencia registrada como «' + key + '». Si es otra persona, ' +
                        'usa un nombre distinto (por ejemplo agregando la inicial del apellido). ' +
                        'Si es la misma, marca «reemplazar».' };
    }
    return { ok: true, key: key, reason: exists ? 'replace' : 'new', message: '' };
  }

  // Estado de cada renglón del listado, cruzando la carpeta contra el catálogo publicado.
  // AUSENTE ≠ VACÍO: si la carpeta no se pudo leer se pasa `null`, no `[]`, y se dice.
  function buildInventory(files, publishedCatalog) {
    const published = publishedCatalog || {};
    const built = buildCatalog(files);
    const rows = [];
    const keys = Object.keys(built.catalog).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const file = built.catalog[key];
      const inPublished = Object.prototype.hasOwnProperty.call(published, key);
      rows.push({
        key: key,
        file: file,
        published: inPublished,
        outdated: inPublished && published[key] !== file,
        status: !inPublished ? 'sin-publicar' : (published[key] !== file ? 'desactualizado' : 'publicado')
      });
    }
    // Publicado sin archivo en la carpeta: apunta a una liga que ya nadie administra.
    const orphans = [];
    const pk = Object.keys(published).sort();
    for (let i = 0; i < pk.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(built.catalog, pk[i])) {
        orphans.push({ key: pk[i], file: published[pk[i]], status: 'huerfano' });
      }
    }
    return { rows: rows, orphans: orphans, warnings: built.warnings };
  }

  const api = {
    MARK_START: MARK_START,
    MARK_END: MARK_END,
    LICENSE_PREFIX: LICENSE_PREFIX,
    normalizeText: normalizeText,
    slugifyKey: slugifyKey,
    keyFromOriginalName: keyFromOriginalName,
    buildUploadName: buildUploadName,
    isLicenseFile: isLicenseFile,
    selectLicenseFiles: selectLicenseFiles,
    isImageFile: isImageFile,
    buildLicenseUrl: buildLicenseUrl,
    buildCatalog: buildCatalog,
    renderBlock: renderBlock,
    findBlocks: findBlocks,
    replaceBlock: replaceBlock,
    blocksMatch: blocksMatch,
    parseBlockCatalog: parseBlockCatalog,
    diffCatalogs: diffCatalogs,
    validateDriverName: validateDriverName,
    buildInventory: buildInventory
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DriverLicensesCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
