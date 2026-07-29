// Datos del NP en el dashboard de Números de Parte — glue DOM.
// En /PartNumbers agrega, AL INICIO de la tabla, hasta 5 columnas con toggles
// persistentes en el header, y enriquece cada NP visible con:
//   🧪 Especificaciones  specs + parámetros con valor numérico (nombre + valor)
//   ⚗️ Metal base        customInputs.DatosAdicionalesNP.BaseMetal
//   🏭 Línea             dimensión contable 349 (cruzada contra el catálogo del response)
//   🧺 Rack Types        cada rack type con sus piezas por carga
//   📐 Unidades          TODOS los factores de unidad registrados (unidades / pieza)
// La decisión pura vive en PnSpecsColumnCore; aquí solo va el DOM, el fetch y el
// memory-hardening.
//
// UN SOLO query por NP para las 5 columnas: `AllPartNumbers` (el del dashboard) no
// trae nada de esto (verificado 2026-07-08) y `GetPartNumber` lo trae TODO junto
// (verificado en vivo 2026-07-29, hash 5efd689d…). El response pesa ~5.8 MB, así que
// el enriquecimiento es OPT-IN por columna y con memory-hardening completo: de ese
// response se guardan ~2 KB por NP y el resto se descarta.
//
// Las columnas van AL INICIO (regla del operador: la tabla nativa tiene 20 columnas y
// Línea/Departamento/Material caen en la posición 10-12, fuera de vista sin scroll
// horizontal). Patrón moveToFront tomado de wo-listing-columns, ya validado en piso.
//
// Auto-inyectado (autoInject:true). Singleton en window.__saPnSpecs* para sobrevivir
// la RE-INYECCIÓN del IIFE (background.js re-evalúa scripts en cada acción del popup).
const PnSpecsColumn = (() => {
  'use strict';

  const Core = () => window.PnSpecsColumnCore;
  const Cleanup = () => window.SteelheadHostCleanup;
  const cfg = () => window.REMOTE_CONFIG;

  // La key de Specs es la ORIGINAL: quien ya tenía la columna encendida la conserva.
  // Las 4 nuevas nacen APAGADAS a propósito — encender una dispara 1 GetPartNumber de
  // ~5.8 MB por NP visible (~50/página), y eso no se le impone a nadie por un deploy.
  const COLS = [
    { key: 'specs', cls: 'sa-pnspec-cell', label: 'Especificaciones', store: 'sa_pn_specs_col_enabled', icon: '🧪', short: 'Specs',    tip: 'Specs del NP y sus parámetros con valor numérico.' },
    { key: 'metal', cls: 'sa-pncol-metal', label: 'Metal base',       store: 'sa_pn_metal_col_enabled', icon: '⚗️', short: 'Metal',    tip: 'Metal base capturado en Datos Adicionales del NP.' },
    { key: 'linea', cls: 'sa-pncol-linea', label: 'Línea',            store: 'sa_pn_linea_col_enabled', icon: '🏭', short: 'Línea',    tip: 'Línea del NP (dimensión contable). La tabla nativa ya la trae, pero hasta la columna 11.' },
    { key: 'racks', cls: 'sa-pncol-racks', label: 'Rack Types',       store: 'sa_pn_racks_col_enabled', icon: '🧺', short: 'Racks',    tip: 'Rack types del NP con sus piezas por carga.' },
    { key: 'units', cls: 'sa-pncol-units', label: 'Unidades',         store: 'sa_pn_units_col_enabled', icon: '📐', short: 'Unidades', tip: 'Todos los factores de unidad registrados (unidades por pieza).' },
  ];
  const ALL_CLS = COLS.map((c) => c.cls);
  const NOT_OURS = ALL_CLS.map((c) => ':not(.' + c + ')').join('');

  const MAX_CONC = 4;              // GetPartNumber en paralelo (pesado)
  const MIN_GAP_MS = 130;          // ~7 req/s: no saturar el gateway
  const RETRY_BACKOFF = [0, 800, 2500];   // reintentos SOLO en transitorios
  const OBS_DEBOUNCE_MS = 160;

  // ── Estado persistente / singleton ─────────────────────────────────────────
  function getFlag(k) { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } }
  function setFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (_) {} }
  function isOn(key) { const c = COLS.find((x) => x.key === key); return !!c && getFlag(c.store); }
  function anyOn() { return COLS.some((c) => getFlag(c.store)); }
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
    if (prev && prev.getAttribute('data-sa-v') === '2') return;
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
      'td.sa-pnspec-cell{min-width:180px;max-width:340px;}',
      'td.sa-pncol-metal{min-width:80px;max-width:140px;}',
      'td.sa-pncol-linea{min-width:120px;max-width:230px;}',
      'td.sa-pncol-racks{min-width:110px;max-width:220px;}',
      'td.sa-pncol-units{min-width:110px;max-width:200px;}',
      '.sa-pnspec-spec{margin:0 0 4px 0;}',
      '.sa-pnspec-spec:last-child{margin-bottom:0;}',
      '.sa-pnspec-spec-name{font-weight:700;color:#0d6b49;display:block;font-size:12px;}',
      // Link a la spec en el azul de link de Steelhead (rgb(9,105,218)) para que se
      // note clicable. Sin subrayar por default (como los links nativos) + hover.
      'a.sa-pnspec-spec-name{color:#0969da;cursor:pointer;text-decoration:none;}',
      'a.sa-pnspec-spec-name:hover{text-decoration:underline;}',
      '.sa-pnspec-param{display:inline-block;background:#eef6f2;border:1px solid #cfe6db;color:#14503a;',
      'border-radius:6px;padding:1px 6px;margin:2px 4px 0 0;font-size:11px;white-space:nowrap;}',
      // Filas de "clave: valor" de racks y unidades (una por línea, alineadas).
      '.sa-pncol-kv{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:1.5;',
      'color:#3a4a58;white-space:nowrap;}',
      '.sa-pncol-kv + .sa-pncol-kv{border-top:1px dotted #e1e5ea;}',
      '.sa-pncol-kv b{font-weight:600;color:#14503a;font-variant-numeric:tabular-nums;}',
      '.sa-pncol-kv i{font-style:normal;color:#5a6b7a;}',
      '.sa-pncol-plain{font-size:12px;color:#3a4a58;}',
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
    s.setAttribute('data-sa-v', '2');
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
    COLS.forEach(function (col) {
      if (!document.getElementById('sa-pnspec-toggle-' + col.key)) bar.appendChild(buildToggle(col));
    });
    refreshToggleUI();
  }

  function refreshToggleUI() {
    COLS.forEach(function (col) {
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
    const ids = new Set();
    document.querySelectorAll('td[data-sa-pnid]').forEach(function (td) { ids.add(Number(td.getAttribute('data-sa-pnid'))); });
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

  function ensureBodyCells(table) {
    const rows = table.querySelectorAll('tbody tr');
    const toFetch = [];
    rows.forEach(function (tr) {
      const link = tr.querySelector('td a[href*="/PartNumbers/"]');
      const pnId = link ? Core().parsePartNumberId(link.getAttribute('href') || link.href) : null;
      const cached = pnId ? cache().get(pnId) : null;
      if (pnId && !cached && !errored().has(pnId)) toFetch.push(pnId);

      COLS.forEach(function (col) {
        let td = tr.querySelector(':scope > .' + col.cls);
        if (!getFlag(col.store)) { if (td) td.remove(); return; }
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
  function plain(td, text) {
    const s = document.createElement('span'); s.className = 'sa-pncol-plain'; s.textContent = text; td.appendChild(s);
  }
  // Fila "clave ····· valor": el valor va en <b> con cifras tabulares para que las
  // cantidades queden alineadas entre renglones.
  function kvRow(td, key, value, suffix) {
    const row = document.createElement('div'); row.className = 'sa-pncol-kv';
    const k = document.createElement('span'); k.textContent = key;
    const v = document.createElement('b'); v.textContent = value;
    row.appendChild(k); row.appendChild(v);
    if (suffix) { const i = document.createElement('i'); i.textContent = ' ' + suffix; row.appendChild(i); }
    td.appendChild(row);
  }

  function renderCell(colKey, td, row) {
    td.setAttribute('data-sa-state', 'done');
    td.textContent = '';
    if (colKey === 'specs') return renderSpecs(td, row);
    if (colKey === 'metal') return row.metal ? plain(td, row.metal) : muted(td, 'sin metal');
    if (colKey === 'linea') return row.linea ? plain(td, row.linea) : muted(td, 'sin línea');
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

  function renderRacks(td, racks) {
    const list = racks || [];
    if (!list.length) { muted(td, 'sin racks'); return; }
    list.forEach(function (r) {
      // partsPerRack ausente se muestra "?" — NO se asume 1 (ese supuesto silencioso
      // es el que dispara las duraciones absurdas en wo-schedule-button).
      const qty = r.partsPerRack == null ? '?' : Core().fmtNum(r.partsPerRack);
      kvRow(td, r.name, qty, r.unit || 'pz');
    });
  }

  function renderUnits(td, units) {
    const list = units || [];
    if (!list.length) { muted(td, 'sin unidades'); return; }
    list.forEach(function (u) {
      const f = u.factor == null ? '?' : Core().fmtFactor(u.factor);
      const row = document.createElement('div'); row.className = 'sa-pncol-kv';
      const k = document.createElement('span');
      k.textContent = u.code || u.name;
      k.title = u.name + ' — ' + f + ' por pieza';   // label completo al hover
      const v = document.createElement('b'); v.textContent = f;
      const i = document.createElement('i'); i.textContent = ' /pz';
      row.appendChild(k); row.appendChild(v); row.appendChild(i);
      td.appendChild(row);
    });
  }

  function renderError(td) {
    td.setAttribute('data-sa-state', 'error');
    td.textContent = '';
    const e = document.createElement('span'); e.className = 'sa-pnspec-err'; e.textContent = '⚠️ error';
    td.appendChild(e);
  }

  function removeColumn(clsList) {
    (clsList || ALL_CLS).forEach(function (cls) {
      document.querySelectorAll('.' + cls).forEach(function (el) { el.remove(); });
    });
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

  // Enciende/apaga UNA columna. `key` omitido = 'specs' (compatibilidad con el popup).
  function toggle(key) {
    const col = COLS.find(function (c) { return c.key === key; }) || COLS[0];
    const next = !getFlag(col.store);
    setFlag(col.store, next);
    refreshToggleUI();
    if (next) {
      toast(col.icon + ' ' + col.label + ': ACTIVADA — cargando datos de los NP visibles…');
      activate();
    } else {
      toast(col.icon + ' ' + col.label + ': DESACTIVADA');
      // Solo se van las celdas de ESA columna; si no queda ninguna, se libera todo.
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
    installUrlChangeListener();
    if (onIndex()) {
      ensureToggle();
      observe();                 // corre siempre en el index para mantener los toggles
      if (anyOn()) activate();
    }
    console.log('[SA] PnSpecsColumn activo (specs/metal/línea/racks/unidades en /PartNumbers)');
  }

  return {
    init, toggleFromPopup, toggle, COLS,
    _getState: function () {
      const p = pool();
      const on = {};
      COLS.forEach(function (c) { on[c.key] = getFlag(c.store); });
      return {
        on: on, anyOn: anyOn(), onIndex: onIndex(),
        cells: document.querySelectorAll('td[data-sa-pnid]').length,
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
