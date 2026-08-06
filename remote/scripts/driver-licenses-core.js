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

  // ── Búsqueda de archivos: el filtro lo hace el SERVIDOR ────────────────────
  //
  // INCIDENTE 2026-08-06: se paginaba el catálogo COMPLETO (23,147 archivos ⇒ ~460
  // peticiones) para quedarse con 8 licencias. El `/graphql` de SH se cuelga a las ~40-45
  // y **el límite es por SESIÓN**: abrir el panel dejaba al operador sin ERP, incluidas las
  // pantallas nativas. Ahora se le pide al servidor que filtre, y hay freno duro.
  // El tope que importa es el de PETICIONES, no el de términos: con 2 pasadas por término,
  // 24 términos serían 48 peticiones y volveríamos a pasarnos del límite (~40-45 por
  // sesión). El presupuesto se cuenta en peticiones y el glue se detiene al agotarlo.
  const MAX_PAGES = 3;          // por término y pasada: 300 archivos
  const MAX_REQUESTS = 24;      // presupuesto duro de la corrida — la mitad del límite
  const MAX_SEARCH_TERMS = 10;  // techo de términos aunque el catálogo crezca

  // La convención nueva es el prefijo, pero las 8 que ya vivían en la carpeta se subieron
  // SIN él: buscar sólo el prefijo las perdería. Se agregan por su nombre exacto, que el
  // catálogo publicado ya conoce. Sin catálogo se busca el prefijo igual — «no sé» no
  // puede volverse «no hay».
  function buildSearchTerms(publishedCatalog) {
    const terms = [LICENSE_PREFIX.replace(/-+$/, '')];
    const pub = publishedCatalog || {};
    const keys = Object.keys(pub).sort();
    for (let i = 0; i < keys.length; i++) {
      const file = pub[keys[i]];
      if (!file || typeof file !== 'string') continue;
      if (terms.indexOf(file) !== -1) continue;
      if (terms.length >= MAX_SEARCH_TERMS) break;
      terms.push(file);
    }
    return terms;
  }

  // Tras la búsqueda por prefijo, sólo hay que ir por lo publicado que NO apareció (las
  // que se subieron sin prefijo). Así el número de búsquedas dirigidas no crece con el
  // catálogo: las altas nuevas siempre llevan prefijo y caen en la primera búsqueda.
  function missingPublishedFiles(foundNames, publishedCatalog) {
    const found = {};
    (foundNames || []).forEach(function (n) { if (n) found[n] = true; });
    const pub = publishedCatalog || {};
    const out = [];
    const keys = Object.keys(pub).sort();
    for (let i = 0; i < keys.length; i++) {
      const file = pub[keys[i]];
      if (!file || typeof file !== 'string') continue;
      if (found[file]) continue;
      if (out.indexOf(file) !== -1) continue;
      if (out.length >= MAX_SEARCH_TERMS) break;
      out.push(file);
    }
    return out;
  }

  // Cero archivos encontrados MIENTRAS hay catálogo publicado no significa «las dieron de
  // baja»: significa que la búsqueda no trajo lo que debía. Publicar sobre esa lectura
  // BORRARÍA el catálogo y dejaría a los choferes sin foto en la remisión, sin un error a
  // la vista. Sin catálogo publicado, en cambio, el vacío es legítimo: es el primer alta.
  function looksLikeFailedSearch(foundFiles, publishedCatalog) {
    const found = (foundFiles || []).length;
    const published = Object.keys(publishedCatalog || {}).length;
    return found === 0 && published > 0;
  }

  // ── Lectura del hook: PdfLowCode es un LISTADO, no un fetch por tipo ────────
  //
  // `$first` y `$offset` son `Int!` OBLIGATORIOS: sin ellos el ERP responde HTTP 400 y el
  // panel no abre (bug de producción 2026-08-06). El contrato está tomado de la
  // implementación de referencia que sí funciona con este mismo hash:
  // SteelheadPowerTools/sync/lowcode_sync.py::_fetch_single_slot.
  const HOOK_PAGE = 50;

  function hookQueryVariables(pdfType, page, offset) {
    return {
      first: typeof page === 'number' ? page : HOOK_PAGE,
      offset: typeof offset === 'number' ? offset : 0,
      pdfType: pdfType
    };
  }

  // La respuesta trae TODAS las versiones del hook bajo una key `all<Algo>LowCodes`, y
  // **la activa es la MÁS RECIENTE por `createdAt`**: cada save crea una versión nueva y no
  // existe mutation de «activar». Tomar `nodes[0]` a ciegas puede devolver una versión vieja
  // — y como este applet PUBLICA CÓDIGO PRODUCTIVO, eso significaría republicarla encima de
  // la buena, sin error y sin que nadie se entere.
  function pickActiveHook(data) {
    if (!data || typeof data !== 'object') return null;
    let nodes = null;
    const keys = Object.keys(data);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf('all') !== 0 || !/LowCodes$/.test(k)) continue;
      const slot = data[k];
      if (slot && Array.isArray(slot.nodes)) { nodes = slot.nodes; break; }
    }
    if (!nodes || !nodes.length) return null;
    // Un nodo sin `code` no es una versión utilizable, por muy reciente que sea.
    const usable = nodes.filter(function (n) {
      return n && typeof n.code === 'string' && n.code.length > 0;
    });
    if (!usable.length) return null;
    usable.sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    const active = usable[0];
    return {
      code: active.code,
      compiled: typeof active.compiled === 'string' ? active.compiled : '',
      id: active.id,
      createdAt: active.createdAt || ''
    };
  }

  const api = {
    MARK_START: MARK_START,
    HOOK_PAGE: HOOK_PAGE,
    MAX_PAGES: MAX_PAGES,
    MAX_REQUESTS: MAX_REQUESTS,
    MAX_SEARCH_TERMS: MAX_SEARCH_TERMS,
    buildSearchTerms: buildSearchTerms,
    missingPublishedFiles: missingPublishedFiles,
    looksLikeFailedSearch: looksLikeFailedSearch,
    hookQueryVariables: hookQueryVariables,
    pickActiveHook: pickActiveHook,
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
