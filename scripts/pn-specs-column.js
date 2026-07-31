// Datos del NP en el dashboard de Números de Parte — glue DOM.
// En /PartNumbers enriquece cada NP visible, con toggles persistentes en el header:
//   🧪 Especificaciones  COLUMNA: specs + parámetros con valor numérico
//   🧺 Rack Types        COLUMNA: "T102-RA02 (18 pz)" por cada rack
//   📐 Unidades /pz      COLUMNA: TODOS los factores registrados, 3 decimales
//   📝 Desc+Metal        NO es columna: descripción y metal base BAJO el nombre del NP,
//                        dentro de su celda nativa (ver syncNameInfo)
// La decisión pura vive en PnSpecsColumnCore; aquí solo va el DOM, el fetch y el
// memory-hardening.
//
// UN SOLO query por NP para todo: `AllPartNumbers` (el del dashboard) no trae nada de
// esto (verificado 2026-07-08) y `GetPartNumber` lo trae TODO junto (verificado en vivo
// 2026-07-29, hash 5efd689d…). El response pesa ~5.8 MB, así que el enriquecimiento es
// OPT-IN por toggle y con memory-hardening completo: de ese response se guardan ~2 KB
// por NP y el resto se descarta.
//
// EL ANCHO ES EL RECURSO ESCASO. La tabla nativa ya trae 20 columnas, así que cada
// columna propia se paga con scroll horizontal. Las nuestras van AL INICIO (lo que
// importa cae en las posiciones 10-12 de la nativa, fuera de vista), son solo TRES, y
// lo que cabe dentro de una celda que ya existe —descripción y metal— no se convierte
// en columna. Patrón moveToFront tomado de wo-listing-columns, validado en piso.
//
// Auto-inyectado (autoInject:true). Singleton en window.__saPnSpecs* para sobrevivir
// la RE-INYECCIÓN del IIFE (background.js re-evalúa scripts en cada acción del popup).
const PnSpecsColumn = (() => {
  'use strict';

  const Core = () => window.PnSpecsColumnCore;
  const Cleanup = () => window.SteelheadHostCleanup;
  const cfg = () => window.REMOTE_CONFIG;

  // La key de Specs es la ORIGINAL: quien ya tenía la columna encendida la conserva.
  // Las demás nacen APAGADAS a propósito — encender una dispara 1 GetPartNumber de
  // ~5.8 MB por NP visible (~50/página), y eso no se le impone a nadie por un deploy.
  //
  // Ancho: la tabla nativa ya tiene 20 columnas, así que cada columna propia se paga con
  // scroll horizontal. Por eso (0.3.1) NO hay columna de Línea —la nativa ya la trae y
  // el operador la vio duplicada— y el metal base + la descripción NO son columna: se
  // inyectan BAJO el nombre, dentro de la celda nativa que ya existe.
  const COLS = [
    { key: 'specs', cls: 'sa-pnspec-cell', label: 'Especificaciones', store: 'sa_pn_specs_col_enabled', icon: '🧪', short: 'Specs',    tip: 'Specs del NP y sus parámetros con valor numérico.' },
    { key: 'racks', cls: 'sa-pncol-racks', label: 'Rack Types',       store: 'sa_pn_racks_col_enabled', icon: '🧺', short: 'Racks',    tip: 'Rack types del NP: nombre y, entre paréntesis, piezas por carga.' },
    { key: 'units', cls: 'sa-pncol-units', label: 'Unidades /pz',     store: 'sa_pn_units_col_enabled', icon: '📐', short: 'Unidades', tip: 'Todos los factores de unidad registrados, en unidades por pieza (3 decimales; el valor exacto está en el hover).' },
  ];
  // Enriquecimiento de la celda NATIVA del nombre (descripción + metal base). No es una
  // columna, pero se enciende igual que ellas y comparte la misma consulta. Conserva la
  // key del viejo toggle de Metal para no perderle el estado a quien ya lo tenía puesto.
  const NAME_INFO = { key: 'nameinfo', cls: 'sa-pncol-nameinfo', store: 'sa_pn_metal_col_enabled', icon: '📝', short: 'Desc+Metal', tip: 'Descripción y metal base bajo el nombre del NP, dentro de su misma celda (no agrega columna).' };

  // Orden de la BARRA de toggles ≠ orden de las COLUMNAS. Specs va al FINAL porque es el
  // único que arrastra el contador de progreso y el medidor de memoria ("50/50 Mem: 338MB
  // / 4192MB (8%)"): puesto al inicio empujaba él solo al último toggle a un segundo
  // renglón. Al final, los tres cortos caben juntos y lo largo cierra la fila.
  const TOGGLE_ORDER = ['racks', 'units', 'nameinfo', 'specs'];
  const TOGGLES = TOGGLE_ORDER
    .map(function (k) { return COLS.find(function (c) { return c.key === k; }) || (NAME_INFO.key === k ? NAME_INFO : null); })
    .filter(Boolean);
  // Key huérfana de la columna de Línea (0.3.0), retirada en 0.3.1.
  const RETIRED_KEYS = ['sa_pn_linea_col_enabled'];

  const ALL_CLS = COLS.map((c) => c.cls);
  const NOT_OURS = ALL_CLS.map((c) => ':not(.' + c + ')').join('');

  const MAX_CONC = 4;              // GetPartNumber en paralelo (pesado)
  const MIN_GAP_MS = 130;          // ~7 req/s: no saturar el gateway
  const RETRY_BACKOFF = [0, 800, 2500];   // reintentos SOLO en transitorios
  const OBS_DEBOUNCE_MS = 160;

  // ── Estado persistente / singleton ─────────────────────────────────────────
  function getFlag(k) { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } }
  function setFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (_) {} }
  function isOn(key) { const c = TOGGLES.find((x) => x.key === key); return !!c && getFlag(c.store); }
  function anyOn() { return TOGGLES.some((c) => getFlag(c.store)); }
  function dropRetiredKeys() { RETIRED_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (_) {} }); }
  function onIndex() { return Core().isPartNumbersIndexPath(location.pathname); }
  function lineaDimId() {
    const v = cfg() && cfg().steelhead && cfg().steelhead.domain
      && cfg().steelhead.domain.dimensionIds && cfg().steelhead.domain.dimensionIds.linea;
    return v == null ? Core().LINEA_DIM_ID_DEFAULT : v;
  }

  // Cache slim por partNumberId: id → { specs, total, metal, linea, rackTypes, units }.
  // NUNCA el response completo (5.8 MB × 50 filas = 290 MB si se guardara crudo).
  function cache() {
    if (!window.__saPnSpecsCache) window.__saPnSpecsCache = new Map();
    return window.__saPnSpecsCache;
  }
  function errored() {
    if (!window.__saPnSpecsErr) window.__saPnSpecsErr = new Set();
    return window.__saPnSpecsErr;
  }

  // ── Estilos (dark-mode para los toggles/toast — regla de diseño; las columnas se
  //    integran a la tabla clara de SH con un separador punteado sutil) ─────────
  function injectStyles() {
    const prev = document.getElementById('sa-pnspec-style');
    if (prev && prev.getAttribute('data-sa-v') === '4') return;
    if (prev) prev.remove();   // reemplaza el <style> de versiones anteriores
    const css = [
      // Barra de toggles en el header (UI nuestra → dark-mode; delgada para no abultar)
      '.sa-pnspec-bar{display:inline-flex;align-items:center;flex-wrap:wrap;gap:0;vertical-align:middle;}',
      '.sa-pnspec-toggle{display:inline-flex;align-items:center;gap:5px;background:#1c2430;',
      'color:#e6e9ee;border:1px solid #2b3645;border-radius:6px;',
      'padding:2px 7px;margin:0 6px 2px 0;font-size:11px;font-weight:600;cursor:pointer;user-select:none;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;line-height:1.35;}',
      '.sa-pnspec-toggle:hover{border-color:#13a36f;}',
      '.sa-pnspec-sw{position:relative;width:24px;height:13px;border-radius:7px;',
      'background:#394452;transition:background .15s;flex:0 0 auto;}',
      '.sa-pnspec-sw::after{content:"";position:absolute;top:2px;left:2px;width:9px;height:9px;',
      'border-radius:50%;background:#e6e9ee;transition:transform .15s;}',
      '.sa-pnspec-toggle.on .sa-pnspec-sw{background:#13a36f;}',
      '.sa-pnspec-toggle.on .sa-pnspec-sw::after{transform:translateX(11px);}',
      '.sa-pnspec-count{font-weight:400;color:#9aa7b5;font-size:10px;margin-left:2px;}',
      // Columnas: heredan el look nativo (th/td copian la className MUI de la tabla);
      // aquí solo el separador punteado y el layout. NO se fuerza font/color/background
      // → el encabezado se ve igual que los nativos.
      'th.' + ALL_CLS.join(',th.') + '{border-left:1px dashed #c7ccd1 !important;white-space:nowrap;}',
      'td.' + ALL_CLS.join(',td.') + '{border-left:1px dashed #c7ccd1 !important;vertical-align:middle;}',
      // Borde derecho punteado en la ÚLTIMA de nuestras columnas → frontera clara.
      'th.sa-pncol-edge,td.sa-pncol-edge{border-right:1px dashed #c7ccd1 !important;}',
      // Anchos acotados (0.3.1): la columna de specs se desbordaba. Ahora tiene tope duro
      // y el contenido ENVUELVE en vez de estirar la columna (los chips eran `nowrap`,
      // que es justo lo que forzaba el ancho).
      'td.sa-pnspec-cell{min-width:150px;max-width:230px;width:230px;}',
      'td.sa-pncol-racks{min-width:96px;max-width:150px;}',
      'td.sa-pncol-units{min-width:92px;max-width:130px;}',
      '.sa-pnspec-spec{margin:0 0 4px 0;}',
      '.sa-pnspec-spec:last-child{margin-bottom:0;}',
      '.sa-pnspec-spec-name{font-weight:700;color:#0d6b49;display:block;font-size:12px;',
      'overflow-wrap:anywhere;}',
      // Link a la spec en el azul de link de Steelhead (rgb(9,105,218)) para que se
      // note clicable. Sin subrayar por default (como los links nativos) + hover.
      'a.sa-pnspec-spec-name{color:#0969da;cursor:pointer;text-decoration:none;}',
      'a.sa-pnspec-spec-name:hover{text-decoration:underline;}',
      '.sa-pnspec-param{display:inline-block;background:#eef6f2;border:1px solid #cfe6db;color:#14503a;',
      'border-radius:6px;padding:1px 6px;margin:2px 4px 0 0;font-size:11px;',
      'white-space:normal;overflow-wrap:anywhere;}',
      // Rack type en DOS renglones por diseño: nombre arriba, "(18 pz)" abajo. En una sola
      // línea el wrap natural partía por donde caía ("T102-RA02 (18" / "pz)"), que se lee
      // peor que el corte deliberado.
      '.sa-pncol-rack{font-size:11px;line-height:1.4;color:#3a4a58;margin-bottom:3px;}',
      '.sa-pncol-rack:last-child{margin-bottom:0;}',
      '.sa-pncol-rack-name{display:block;overflow-wrap:anywhere;}',
      '.sa-pncol-rack-qty{display:block;white-space:nowrap;color:#5a6b7a;}',
      '.sa-pncol-rack-qty b{font-weight:600;color:#14503a;font-variant-numeric:tabular-nums;}',
      // Unidades: código a la izquierda, valor pegado a la DERECHA con cifras tabulares
      // para que los puntos decimales queden en columna y se comparen de un vistazo.
      // El "/pz" vive en el ENCABEZADO, no en cada renglón.
      '.sa-pncol-kv{display:flex;justify-content:space-between;align-items:baseline;gap:6px;',
      'font-size:11px;line-height:1.5;color:#3a4a58;white-space:nowrap;}',
      '.sa-pncol-kv + .sa-pncol-kv{border-top:1px dotted #e1e5ea;}',
      '.sa-pncol-kv b{font-weight:600;color:#14503a;font-variant-numeric:tabular-nums;',
      'text-align:right;flex:1 1 auto;}',
      '.sa-pncol-plain{font-size:12px;color:#3a4a58;}',
      // Línea "descripción · metal" inyectada DENTRO de la celda nativa del nombre.
      // Discreta: no debe competir con el nombre del NP, que es el dato principal.
      '.sa-pncol-nameinfo{font-size:11px;line-height:1.35;color:#5a6b7a;margin-top:2px;',
      'overflow-wrap:anywhere;}',
      '.sa-pncol-nameinfo b{font-weight:600;color:#14503a;}',
      // Con las columnas encendidas la fila lleva mucho dato y el NOMBRE del NP —que es
      // el ancla de toda la fila— se perdía entre lo demás (nativo: 12px/400). Se agranda
      // y se pone en negritas. La regla cuelga de una clase en <body>, no del className
      // del <td>: ese lo pinta React y lo reescribiría en cada render.
      'body.sa-pn-active table tbody td a[href^="/PartNumbers/"]{font-size:14px;font-weight:700;',
      'line-height:1.3;}',
      '.sa-pnspec-muted{color:#8a97a5;font-style:italic;font-size:12px;}',
      '.sa-pnspec-err{color:#b04a3a;font-size:12px;}',
      // Toast (dark-mode)
      '.sa-pnspec-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483600;',
      'background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;border-left:4px solid #13a36f;',
      'border-radius:10px;padding:12px 18px;font-size:14px;max-width:80vw;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);}',
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-pnspec-style';
    // OJO: este número y el del chequeo de arriba TIENEN que ser el mismo. En 0.3.1 se
    // subió el chequeo a '3' y este se quedó en '2', así que la condición de salida
    // nunca se cumplía e injectStyles() borraba y recreaba el <style> en CADA sync.
    s.setAttribute('data-sa-v', '4');
    s.textContent = css;
    document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg) {
    injectStyles();
    let el = document.getElementById('sa-pnspec-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-pnspec-toast'; el.className = 'sa-pnspec-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { const e = document.getElementById('sa-pnspec-toast'); if (e) e.remove(); }, 4500);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Toggles en el header (uno por columna)
  // ════════════════════════════════════════════════════════════════════════
  function findHeaderAnchor() {
    // Ancla natural: el botón "NUEVO NÚMERO DE PARTE" (control propio del dashboard).
    const btn = Array.prototype.slice.call(document.querySelectorAll('button, a'))
      .find(function (b) { return /nuevo\s+número\s+de\s+parte|new\s+part\s+number/i.test((b.innerText || '').trim()); });
    if (!btn) return null;
    // Sube hasta el wrapper cuyo padre es la barra de controles (varios hijos).
    let el = btn;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      if (el.parentElement.children.length > 1) return { bar: el.parentElement, before: el };
      el = el.parentElement;
    }
    return { bar: btn.parentElement, before: btn };
  }

  function buildToggle(col) {
    const wrap = document.createElement('div');
    wrap.className = 'sa-pnspec-toggle' + (getFlag(col.store) ? ' on' : '');
    wrap.id = 'sa-pnspec-toggle-' + col.key;
    wrap.title = col.tip + ' Hace 1 consulta por NP visible (compartida entre las columnas).';
    const sw = document.createElement('span'); sw.className = 'sa-pnspec-sw';
    const txt = document.createElement('span'); txt.textContent = col.icon + ' ' + col.short;
    wrap.appendChild(sw); wrap.appendChild(txt);
    if (col.key === 'specs') {
      const cnt = document.createElement('span'); cnt.className = 'sa-pnspec-count'; cnt.id = 'sa-pnspec-count';
      const mem = document.createElement('span'); mem.className = 'sa-pnspec-count'; mem.id = 'sa-pnspec-mem'; // el mem monitor escribe aquí
      wrap.appendChild(cnt); wrap.appendChild(mem);
    }
    wrap.addEventListener('click', function () { toggle(col.key); });
    return wrap;
  }

  function ensureToggle() {
    if (!onIndex()) return;
    injectStyles();
    let bar = document.getElementById('sa-pnspec-bar');
    if (!bar) {
      const anchor = findHeaderAnchor();
      if (!anchor) return;   // header aún no renderiza: el observer reintenta
      bar = document.createElement('div');
      bar.id = 'sa-pnspec-bar';
      bar.className = 'sa-pnspec-bar';
      anchor.bar.insertBefore(bar, anchor.before);
    }
    // El contador vive dentro del toggle de Specs, así que ese va primero.
    TOGGLES.forEach(function (col) {
      if (!document.getElementById('sa-pnspec-toggle-' + col.key)) bar.appendChild(buildToggle(col));
    });
    refreshToggleUI();
  }

  function refreshToggleUI() {
    TOGGLES.forEach(function (col) {
      const t = document.getElementById('sa-pnspec-toggle-' + col.key);
      if (t) t.classList.toggle('on', getFlag(col.store));
    });
    updateCount();
  }

  // El progreso es por NP (una consulta alimenta las 5 columnas), no por celda.
  function updateCount() {
    const c = document.getElementById('sa-pnspec-count');
    if (!c) return;
    if (!anyOn()) { c.textContent = ''; return; }
    // Cualquier marca nuestra sirve: las celdas de columna Y la línea del nombre.
    const ids = new Set();
    document.querySelectorAll('[data-sa-pnid]').forEach(function (el) { ids.add(Number(el.getAttribute('data-sa-pnid'))); });
    if (!ids.size) { c.textContent = ''; return; }
    let done = 0;
    ids.forEach(function (id) { if (cache().has(id) || errored().has(id)) done++; });
    c.textContent = done + '/' + ids.size;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Columnas
  // ════════════════════════════════════════════════════════════════════════
  function getTable() { return document.querySelector('table'); }

  // Nuestras columnas van SIEMPRE al INICIO de la fila, en el orden canónico de COLS,
  // y se reordenan en cada sync. Motivo: al re-render de React (filtrar/paginar) los
  // <th> inyectados "flotan" mientras los <td> se recrean → se desalineaban (header en
  // una columna, chips en otra; bug 0.1.1). Forzar la posición en thead y en cada tr
  // los mantiene alineados sin importar cómo React reordene lo suyo. Idempotente: solo
  // actúa si el orden no es el deseado, así que en estado estable es no-op (si no, el
  // MutationObserver entraría en bucle con sus propias mutaciones).
  function moveToFront(row) {
    const desired = COLS.filter(function (c) { return getFlag(c.store); })
      .map(function (c) { return row.querySelector(':scope > .' + c.cls); })
      .filter(Boolean);
    if (!desired.length) return;
    desired.forEach(function (c, i) { c.classList.toggle('sa-pncol-edge', i === desired.length - 1); });
    let ok = true;
    for (let i = 0; i < desired.length; i++) { if (row.children[i] !== desired[i]) { ok = false; break; } }
    if (ok) return;
    for (let i = desired.length - 1; i >= 0; i--) row.insertBefore(desired[i], row.firstChild);
  }

  function ensureHeaderCells(table) {
    const headRow = table.querySelector('thead tr');
    if (!headRow) return;
    COLS.forEach(function (col) {
      let th = headRow.querySelector(':scope > .' + col.cls);
      if (!getFlag(col.store)) { if (th) th.remove(); return; }
      if (!th) {
        th = document.createElement('th');
        // Hereda la className MUI de un th nativo → el texto del encabezado se ve
        // igual que los demás (mismo font/peso/color/padding). Nuestra marca es solo
        // el separador punteado gris.
        const nativeTh = headRow.querySelector('th' + NOT_OURS);
        th.className = (nativeTh ? nativeTh.className + ' ' : '') + col.cls;
        th.setAttribute('scope', 'col');
        th.textContent = col.label;
        headRow.appendChild(th);   // moveToFront lo reposiciona al inicio
      }
    });
    moveToFront(headRow);
  }

  // ── Enriquecimiento de la celda NATIVA del nombre ───────────────────────────
  // No es una columna: se cuelga un <div> propio al final del <td> que ya contiene el
  // link del NP (React lo pinta como <td><div class="css-…"><a>…</a></div></td>; nuestro
  // nodo va como hermano de ese div). Verificado en vivo sobre la tabla real.
  // IDEMPOTENTE POR CONTRATO: solo escribe si el texto cambió. Sin eso, cada sync mutaría
  // la celda, el MutationObserver dispararía otro sync y el applet entraría en bucle
  // — y aquí el riesgo es peor que con las columnas propias, porque estamos mutando un
  // subárbol que React también toca.
  function nameCellOf(tr) {
    const link = tr.querySelector('td a[href*="/PartNumbers/"]');
    return link ? link.closest('td') : null;
  }

  function syncNameInfo(tr, pnId, row) {
    const cell = nameCellOf(tr);
    if (!cell) return;
    const existing = cell.querySelector(':scope > .' + NAME_INFO.cls);
    if (!getFlag(NAME_INFO.store)) { if (existing) existing.remove(); return; }
    if (pnId == null) return;
    let box = existing;
    // Mismo reciclaje de React que en las columnas: si el box quedó de otro NP hay que
    // re-adoptarlo. No basta con que el texto cambie — el `data-sa-pnid` stale haría que el
    // resultado del fetch del NP ANTERIOR se pinte aquí (applyToCells busca por ese atributo).
    if (box && Core().isStaleNode(box.getAttribute('data-sa-pnid'), pnId)) {
      box.setAttribute('data-sa-pnid', String(pnId));
      box.removeAttribute('data-sa-txt');   // fuerza el repintado aunque el texto coincida
      box.textContent = '';
    }
    if (!box) {
      box = document.createElement('div');
      box.className = NAME_INFO.cls;
      box.setAttribute('data-sa-pnid', String(pnId));
      cell.appendChild(box);
    }
    if (!row) {                       // aún cargando
      if (box.textContent !== '⏳') box.textContent = '⏳';
      return;
    }
    const desc = row.descripcion || '';
    const metal = row.metal || '';
    // El texto que DEBE quedar, para comparar antes de tocar el DOM.
    const want = Core().formatNameInfo(row);
    if (box.getAttribute('data-sa-txt') === want) return;   // ya está: no muta
    box.setAttribute('data-sa-txt', want);
    box.textContent = '';
    if (!want) { box.remove(); return; }   // sin descripción ni metal → no ensuciar la celda
    if (desc) box.appendChild(document.createTextNode(desc));
    if (desc && metal) box.appendChild(document.createTextNode(' · '));
    if (metal) { const b = document.createElement('b'); b.textContent = metal; box.appendChild(b); }
  }

  function ensureBodyCells(table) {
    const rows = table.querySelectorAll('tbody tr');
    const toFetch = [];
    rows.forEach(function (tr) {
      const link = tr.querySelector('td a[href*="/PartNumbers/"]');
      const pnId = link ? Core().parsePartNumberId(link.getAttribute('href') || link.href) : null;
      const cached = pnId ? cache().get(pnId) : null;
      if (pnId && !cached && !errored().has(pnId)) toFetch.push(pnId);
      syncNameInfo(tr, pnId, cached);

      COLS.forEach(function (col) {
        let td = tr.querySelector(':scope > .' + col.cls);
        if (!getFlag(col.store)) { if (td) td.remove(); return; }
        // React RECICLA el <tr> al archivar/filtrar/paginar: la celda nativa del nombre pasa a
        // otro NP y nuestra celda inyectada sobrevive con el dato del anterior. Antes esto no se
        // revalidaba (solo se miraba si la celda EXISTÍA) y el renglón mostraba el nombre de un NP
        // con las columnas de otro — reportado en piso al archivar un NP. La identidad se
        // revalida en CADA sync, no solo al crear.
        if (td && Core().isStaleNode(td.getAttribute('data-sa-pnid'), pnId)) { td.remove(); td = null; }
        if (!td) {
          td = document.createElement('td');
          // Hereda la className MUI de una celda nativa (padding/borde/tipografía).
          const nativeTd = tr.querySelector('td' + NOT_OURS);
          td.className = (nativeTd ? nativeTd.className + ' ' : '') + col.cls;
          if (pnId) {
            td.setAttribute('data-sa-pnid', String(pnId));
            if (cached) renderCell(col.key, td, cached);
            else if (errored().has(pnId)) renderError(td);
            else pendingCell(td);
          } else {
            td.setAttribute('data-sa-state', 'na');
            const s = document.createElement('span'); s.className = 'sa-pnspec-muted'; s.textContent = '—'; td.appendChild(s);
          }
          tr.appendChild(td);   // moveToFront lo reposiciona al inicio
        }
      });
      moveToFront(tr);
    });
    return toFetch;
  }

  function pendingCell(td) {
    td.setAttribute('data-sa-state', 'pending');
    td.textContent = '';
    const s = document.createElement('span'); s.className = 'sa-pnspec-muted'; s.textContent = '⏳';
    td.appendChild(s);
  }

  // ── Render por columna (sin innerHTML de datos: textContent → no XSS con nombres
  //    de spec/rack/unidad, que vienen de GraphQL y los captura otro usuario) ─────
  function muted(td, text) {
    const m = document.createElement('span'); m.className = 'sa-pnspec-muted'; m.textContent = text; td.appendChild(m);
  }

  function renderCell(colKey, td, row) {
    td.setAttribute('data-sa-state', 'done');
    td.textContent = '';
    if (colKey === 'specs') return renderSpecs(td, row);
    if (colKey === 'racks') return renderRacks(td, row.rackTypes);
    if (colKey === 'units') return renderUnits(td, row.units);
  }

  function renderSpecs(td, result) {
    const specs = (result && result.specs) || [];
    if (!specs.length) { muted(td, 'sin specs'); return; }
    specs.forEach(function (s) {
      const box = document.createElement('div'); box.className = 'sa-pnspec-spec';
      // Nombre de la spec = link a la spec (nueva pestaña → no pierde el filtro/scroll
      // del dashboard). Si no se puede armar la URL, cae a texto plano.
      const href = Core().specUrl(s);
      const nm = document.createElement(href ? 'a' : 'span');
      nm.className = 'sa-pnspec-spec-name'; nm.textContent = s.specName;
      if (href) { nm.href = href; nm.target = '_blank'; nm.rel = 'noopener'; }
      box.appendChild(nm);
      if (!s.numericParams.length) {
        const none = document.createElement('span'); none.className = 'sa-pnspec-muted'; none.textContent = 'sin params num.';
        box.appendChild(none);
      } else {
        s.numericParams.forEach(function (p) {
          const chip = document.createElement('span'); chip.className = 'sa-pnspec-param';
          chip.textContent = p.value ? p.name + ': ' + p.value : p.name;
          box.appendChild(chip);
        });
      }
      td.appendChild(box);
    });
  }

  // Dos renglones por rack: nombre arriba, "(18 pz)" abajo — el corte es deliberado
  // para que la columna se lea parejo aunque el nombre del rack sea largo.
  function renderRacks(td, racks) {
    const list = racks || [];
    if (!list.length) { muted(td, 'sin racks'); return; }
    list.forEach(function (r) {
      // partsPerRack ausente se muestra "?" — NO se asume 1 (ese supuesto silencioso
      // es el que dispara las duraciones absurdas en wo-schedule-button).
      const qty = r.partsPerRack == null ? '?' : Core().fmtNum(r.partsPerRack);
      const div = document.createElement('div'); div.className = 'sa-pncol-rack';
      div.title = Core().formatRackChip(r);
      const nm = document.createElement('span'); nm.className = 'sa-pncol-rack-name'; nm.textContent = r.name;
      const qt = document.createElement('span'); qt.className = 'sa-pncol-rack-qty';
      qt.appendChild(document.createTextNode('('));
      const b = document.createElement('b'); b.textContent = qty; qt.appendChild(b);
      qt.appendChild(document.createTextNode(' ' + (r.unit || 'pz') + ')'));
      div.appendChild(nm); div.appendChild(qt);
      td.appendChild(div);
    });
  }

  // Código a la izquierda, factor a la derecha con 3 decimales y miles con coma. El
  // "/pz" está en el encabezado de la columna. El valor EXACTO (10 significativos) vive
  // en el `title`: los 3 decimales son para leer de un vistazo, no para perder el dato.
  function renderUnits(td, units) {
    const list = units || [];
    if (!list.length) { muted(td, 'sin unidades'); return; }
    list.forEach(function (u) {
      const shown = u.factor == null ? '?' : Core().fmtQty3(u.factor);
      const exact = u.factor == null ? '?' : Core().fmtFactor(u.factor);
      const row = document.createElement('div'); row.className = 'sa-pncol-kv';
      row.title = u.name + ' — ' + exact + ' por pieza';   // label y valor exacto al hover
      const k = document.createElement('span');
      k.textContent = u.code || u.name;
      const v = document.createElement('b'); v.textContent = shown;
      row.appendChild(k); row.appendChild(v);
      td.appendChild(row);
    });
  }

  function renderError(td) {
    td.setAttribute('data-sa-state', 'error');
    td.textContent = '';
    const e = document.createElement('span'); e.className = 'sa-pnspec-err'; e.textContent = '⚠️ error';
    td.appendChild(e);
  }

  // Sin argumento quita TODO lo nuestro, incluida la línea inyectada en la celda nativa
  // del nombre (si se quedara, el operador no tendría cómo borrarla).
  function removeColumn(clsList) {
    (clsList || ALL_CLS.concat([NAME_INFO.cls])).forEach(function (cls) {
      document.querySelectorAll('.' + cls).forEach(function (el) { el.remove(); });
    });
    if (!clsList) document.body.classList.remove('sa-pn-active');   // devuelve el nombre a su tamaño nativo
  }

  // ════════════════════════════════════════════════════════════════════════
  // Enriquecimiento (pool con concurrencia + rate-limit + retry transitorio)
  // ════════════════════════════════════════════════════════════════════════
  function pool() {
    if (!window.__saPnSpecsPool) window.__saPnSpecsPool = { queue: [], inFlight: 0, lastLaunch: 0, active: false, drain: null, count: 0 };
    return window.__saPnSpecsPool;
  }

  function enqueue(ids) {
    const p = pool();
    const seen = new Set(p.queue);
    ids.forEach(function (id) { if (!seen.has(id) && !cache().has(id)) { p.queue.push(id); seen.add(id); } });
    pump();
  }

  function isTransient(err) {
    if (!err) return false;
    if (err.persistedQueryRotated) return false;   // hash rotado: reintentar no sirve
    const m = (err.message || '').toLowerCase();
    return /timeout|network|failed to fetch|50\d|429|aborted/.test(m);
  }

  async function fetchOne(pnId) {
    const api = window.SteelheadAPI;
    for (let attempt = 0; attempt < RETRY_BACKOFF.length; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, RETRY_BACKOFF[attempt]); });
      try {
        // El response ronda los 5.8 MB. Se destila UNA vez a ~2 KB y se suelta la
        // referencia: guardar el crudo por 50 filas serían ~290 MB de heap.
        const data = await api.query('GetPartNumber', { partNumberId: pnId, usagesLimit: 0, usagesOffset: 0 });
        return Core().extractPnRow(data, { lineaDimId: lineaDimId() });   // slim
      } catch (e) {
        if (attempt === RETRY_BACKOFF.length - 1 || !isTransient(e)) throw e;
      }
    }
  }

  function fillCells(pnId, result, isError) {
    document.querySelectorAll('td[data-sa-pnid="' + pnId + '"]').forEach(function (td) {
      const col = COLS.find(function (c) { return td.classList.contains(c.cls); });
      if (!col) return;
      if (isError) renderError(td); else renderCell(col.key, td, result);
    });
    // La línea del nombre vive en una celda NATIVA: se actualiza por su propia vía.
    document.querySelectorAll('.' + NAME_INFO.cls + '[data-sa-pnid="' + pnId + '"]').forEach(function (box) {
      const tr = box.closest('tr');
      if (!tr) return;
      if (isError) { box.setAttribute('data-sa-txt', '⚠️'); box.textContent = '⚠️'; }
      else syncNameInfo(tr, pnId, result);
    });
    updateCount();
  }

  function pump() {
    const p = pool();
    if (!anyOn() || !onIndex()) return;
    while (p.inFlight < MAX_CONC && p.queue.length) {
      // rate-limit: separa los lanzamientos al menos MIN_GAP_MS
      const wait = p.lastLaunch + MIN_GAP_MS - Date.now();
      if (wait > 0) { setTimeout(pump, wait + 5); return; }
      const pnId = p.queue.shift();
      p.inFlight++;
      p.lastLaunch = Date.now();
      // Primer trabajo real del run → detener Datadog session replay (memory).
      try { if (Cleanup() && !window.__sa_dd_stopped) Cleanup().stopDatadogSessionReplay(); } catch (_) {}
      fetchOne(pnId).then(function (result) {
        cache().set(pnId, result);
        errored().delete(pnId);
        fillCells(pnId, result, false);
      }).catch(function (e) {
        errored().add(pnId);
        fillCells(pnId, null, true);
        if (e && e.persistedQueryRotated) toast('⚠️ El hash de GetPartNumber rotó — avísale a Claude para actualizarlo.');
        else console.warn('[SA] pn-specs: GetPartNumber ' + pnId + ' falló:', e && e.message);
      }).then(function () {
        p.inFlight--;
        p.count++;
        // Drain de Apollo cada N PNs (memory EJE B).
        try { if (p.drain) p.drain(); } catch (_) {}
        pump();
      });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Memory hardening (EJE B): mem monitor + guardrail + periodic drain
  // ════════════════════════════════════════════════════════════════════════
  function startMonitor() {
    const c = Cleanup();
    if (!c) return;
    const p = pool();
    if (!p.drain && typeof c.makePeriodicDrain === 'function') p.drain = c.makePeriodicDrain(25);
    if (window.__saPnSpecsMon || typeof c.createMemMonitor !== 'function') return;
    window.__saPnSpecsMon = c.createMemMonitor({
      getElement: function () { return document.getElementById('sa-pnspec-mem'); },
      onGuardrail: function (pct) {
        // 88%: aborta el enriquecimiento y avisa. Checkpoint > crash.
        const p2 = pool(); p2.queue.length = 0;
        toast('🛑 Memoria alta (' + pct + '%) — enriquecimiento pausado. Recarga la página si notas lentitud.');
      },
    });
    window.__saPnSpecsMon.start();
  }
  function stopMonitor() {
    if (window.__saPnSpecsMon) { try { window.__saPnSpecsMon.stop(); } catch (_) {} window.__saPnSpecsMon = null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Observer de la tabla (React re-renderiza al paginar/ordenar/filtrar)
  // ════════════════════════════════════════════════════════════════════════
  let obsTimer = null;
  function scheduleSync() {
    if (obsTimer) return;
    obsTimer = setTimeout(function () { obsTimer = null; try { syncColumn(); } catch (_) {} }, OBS_DEBOUNCE_MS);
  }

  function syncColumn() {
    if (!onIndex()) return;
    // Los toggles se montan SIEMPRE, aunque estén apagados: son la UI de entrada del
    // applet, y sin ellos el operador no tiene cómo encenderlo. Estaban detrás del
    // `!isEnabled() → return` y el bug quedaba oculto por timing: ensureToggle() ancla
    // al botón "NUEVO NÚMERO DE PARTE", que en el init puede no estar renderizado, y
    // este observer es el único reintento. Con el loader viejo (79 archivos en serie) el
    // applet llegaba tan tarde que el header ya existía; al acelerarlo (2026-07-27) pasó
    // a correr antes que React. Mismo bug que wo-listing-columns.
    ensureToggle();
    // La clase del <body> gobierna el realce del nombre del NP. Vive en el body y no en
    // el <td> porque ese lo pinta React y reescribiría el className en cada render.
    document.body.classList.toggle('sa-pn-active', anyOn());
    const table = getTable();
    if (!table) return;
    if (!anyOn()) { removeColumn(); return; }   // apagadas: no dejar celdas huérfanas
    injectStyles();
    ensureHeaderCells(table);
    const toFetch = ensureBodyCells(table);
    if (toFetch.length) enqueue(toFetch);
    updateCount();
  }

  function observe() {
    if (window.__saPnSpecsObs) return;
    const obs = new MutationObserver(function () { scheduleSync(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saPnSpecsObs = obs;
  }
  function teardownObserver() {
    if (window.__saPnSpecsObs) { window.__saPnSpecsObs.disconnect(); window.__saPnSpecsObs = null; }
    if (obsTimer) { clearTimeout(obsTimer); obsTimer = null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Activar / desactivar
  // ════════════════════════════════════════════════════════════════════════
  function activate() {
    if (!onIndex()) return;
    injectStyles();
    startMonitor();
    observe();
    syncColumn();   // inyecta columnas + encola los visibles
  }

  function deactivate() {
    const p = pool();
    p.queue.length = 0;     // cancela pendientes (in-flight terminan solos, baratos)
    teardownObserver();
    stopMonitor();
    removeColumn();
    refreshToggleUI();
  }

  // Enciende/apaga UNA columna (o la línea del nombre). `key` omitido = 'specs'
  // (compatibilidad con la acción del popup, que no cambió).
  function toggle(key) {
    // Sin key = 'specs' (lo que espera la acción del popup), NO el primero de la barra:
    // el orden de la barra es cosmético y no debe cambiar a qué apunta el popup.
    const col = TOGGLES.find(function (c) { return c.key === (key || 'specs'); })
             || TOGGLES.find(function (c) { return c.key === 'specs'; });
    const next = !getFlag(col.store);
    setFlag(col.store, next);
    refreshToggleUI();
    const nombre = col.label || col.short;
    if (next) {
      toast(col.icon + ' ' + nombre + ': ACTIVADA — cargando datos de los NP visibles…');
      activate();
    } else {
      toast(col.icon + ' ' + nombre + ': DESACTIVADA');
      // Solo se va lo de ESE toggle; si no queda ninguno, se libera todo.
      removeColumn([col.cls]);
      if (!anyOn()) deactivate(); else syncColumn();
    }
    return { column: col.key, enabled: next, anyOn: anyOn() };
  }

  // Handler para el popup de la extensión (además de los toggles del header).
  function toggleFromPopup() { return toggle('specs'); }

  // ════════════════════════════════════════════════════════════════════════
  // Navegación SPA
  // ════════════════════════════════════════════════════════════════════════
  function installUrlChangeListener() {
    if (!window.__saPnSpecsUrlListener) {
      window.__saPnSpecsUrlListener = true;
      const fire = function () { window.dispatchEvent(new Event('sa-urlchange')); };
      ['pushState', 'replaceState'].forEach(function (m) {
        const orig = history[m];
        history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
      });
      window.addEventListener('popstate', fire);
    }
    window.addEventListener('sa-urlchange', function () {
      if (onIndex()) {
        ensureToggle();
        observe();               // el observer siempre corre en el index (para los toggles)
        if (anyOn()) activate();
      } else {
        // Salimos del index: limpia todo (memory) — la cache slim se descarta.
        deactivate();
        cache().clear();
        errored().clear();
      }
    });
  }

  function init() {
    if (window.__saPnSpecsInit) return;
    window.__saPnSpecsInit = true;
    dropRetiredKeys();   // la columna de Línea se retiró: su flag ya no debe pesar en anyOn()
    installUrlChangeListener();
    if (onIndex()) {
      ensureToggle();
      observe();                 // corre siempre en el index para mantener los toggles
      if (anyOn()) activate();
    }
    console.log('[SA] PnSpecsColumn activo (specs/metal/línea/racks/unidades en /PartNumbers)');
  }

  return {
    init, toggleFromPopup, toggle, COLS, TOGGLES,
    _getState: function () {
      const p = pool();
      const on = {};
      TOGGLES.forEach(function (c) { on[c.key] = getFlag(c.store); });
      return {
        on: on, anyOn: anyOn(), onIndex: onIndex(),
        cells: document.querySelectorAll('td[data-sa-pnid]').length,
        nameInfo: document.querySelectorAll('.' + NAME_INFO.cls).length,
        done: document.querySelectorAll('td[data-sa-state="done"]').length,
        cached: cache().size, errored: errored().size, queue: p.queue.length, inFlight: p.inFlight,
      };
    },
  };
})();

if (typeof window !== 'undefined') {
  window.PnSpecsColumn = PnSpecsColumn;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { PnSpecsColumn.init(); });
  } else {
    PnSpecsColumn.init();
  }
}
