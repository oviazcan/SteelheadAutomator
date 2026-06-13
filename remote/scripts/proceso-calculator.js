// Calculadora de Procesos (proceso-calculator) v0.1.0
// ============================================================================
// Replica la "Calculadora de Procesos" de la pestaña CAT_Procesos del Excel de
// carga masiva, DENTRO del UI de Steelhead, como herramienta inline durante la
// edición de un Número de Parte (NP).
//
// FLUJO
//   - autoInject: instala un MutationObserver que pone un ícono 🧮 junto al
//     combobox "Default Process" (en el modal "Edit Part Number → PROCESO Y SPECS"
//     y en la ficha del PN "Process Setup").
//   - Click en 🧮 → abre el modal de la calculadora.
//   - Lee del DOM (el NP aún no está guardado): metal base, línea, etiquetas de
//     acabado. Pre-pobla inputs editables (dropdowns en vivo).
//   - Calcula contra el catálogo `CatProcesos` (artículo de inventario 900192):
//       0 match  → "Combinación no existente" + agregar al catálogo
//       1 match  → coloca el proceso en el combobox Default Process
//       2+ match → lista reducida; al elegir, coloca el proceso
//   - Agregar combinación: escribe el customInputs del artículo (compartido).
//
// ALMACENAMIENTO
//   El catálogo vive en `customInputs.CatProcesos` (array) de un ARTÍCULO DE
//   INVENTARIO dedicado "Catálogo de Procesos (no archivar)" (id 900192, tipo
//   3767). Persistente, compartido por todo el dominio, escribible con la sesión
//   del operador en UNA mutación (UpdateInventoryItemInputs). Cada item:
//     { Linea, MetalBase, Etiqueta1..Etiqueta6, Proceso }
//   (Se descartó el operator input del nodo de proceso: se resetea por orden de
//    trabajo — los datos viven en parts-transfers, frágil. Ver bitácora.)
//
// MATCHING
//   Exacto en metal + línea + CONJUNTO de etiquetas (sin importar orden), con
//   normalización (trim + lowercase + strip acentos). Replica la fórmula del
//   Excel pero con etiquetas separadas en vez de concatenadas.
//
// PENDIENTES FASE 0 (ver docs/applets/proceso-calculator.md):
//   0b — wrappers HTML de los campos METAL y LÍNEA y los chips de ETIQUETAS en
//        ambas vistas → afinar los selectores readSingleValueByLabel/readEtiquetas
//        (⚠️0b). El combobox "Default Process" ya está afinado (react-select).
//
// Depende de: SteelheadAPI
// ============================================================================

const ProcesosCalculator = (() => {
  'use strict';

  const VERSION = '0.1.0';

  // ── Constantes de dominio ──
  // El catálogo vive en customInputs.CatProcesos de un ARTÍCULO DE INVENTARIO
  // dedicado (persistente, una mutación, sin parts-transfers). Ver bitácora.
  const INV_ITEM_ID = 900192;         // artículo "Catálogo de Procesos (no archivar)"
  const INV_TYPE_ID = 3767;           // tipo de inventario "Catálogo de Procesos"
  const INPUT_SCHEMA_FALLBACK = 942;  // inputSchemaId (se lee dinámico del item; esto es fallback)
  const CATALOG_KEY = 'CatProcesos';  // key del array dentro de customInputs
  const MAX_ETIQUETAS = 6;            // Etiqueta1..6 (43 combos tienen 5-6 etiquetas)
  const CACHE_TTL_MS = 5 * 60 * 1000;

  const api = () => window.SteelheadAPI;
  const log = (m) => (api()?.log ? api().log(`[proceso-calc] ${m}`) : console.log('[proceso-calc]', m));
  const warn = (m) => (api()?.warn ? api().warn(`[proceso-calc] ${m}`) : console.warn('[proceso-calc]', m));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ════════════════════════════════════════════════════════════════════════
  // matchEngine — lógica pura (sin DOM/API). Testeable de forma aislada.
  // ════════════════════════════════════════════════════════════════════════
  function normStr(s) {
    const x = String(s ?? '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return (x === '(seleccione)') ? '' : x;
  }

  // Etiquetas no vacías de un item del catálogo (Etiqueta1..N) → array normalizado.
  function etiquetasOf(row) {
    const out = [];
    for (let i = 1; i <= MAX_ETIQUETAS; i++) {
      const v = normStr(row['Etiqueta' + i]);
      if (v) out.push(v);
    }
    return out;
  }

  // Compara dos colecciones como CONJUNTOS (sin orden, sin duplicados).
  function sameSet(arrA, arrB) {
    const a = [...new Set((arrA || []).map(normStr).filter(Boolean))];
    const b = [...new Set((arrB || []).map(normStr).filter(Boolean))];
    if (a.length !== b.length) return false;
    const setB = new Set(b);
    return a.every(x => setB.has(x));
  }

  // input = { metal, linea, etiquetas:[] }. Devuelve array de procesos únicos.
  function findMatches(entries, input) {
    const metal = normStr(input.metal);
    const linea = normStr(input.linea);
    if (!metal || !linea) return [];
    const inputEtq = (input.etiquetas || []).map(normStr).filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const row of (entries || [])) {
      if (normStr(row.MetalBase) !== metal) continue;
      if (normStr(row.Linea) !== linea) continue;
      if (!sameSet(etiquetasOf(row), inputEtq)) continue;
      const proc = (row.Proceso || '').trim();
      if (proc && !seen.has(proc)) { seen.add(proc); out.push(proc); }
    }
    return out;
  }

  // Construye un item del catálogo a partir de inputs + proceso elegido.
  function buildEntry(input, proceso) {
    const etq = (input.etiquetas || []).filter(e => e && e.trim());
    const item = {
      Linea: input.linea || '',
      MetalBase: input.metal || '',
      Proceso: proceso || ''
    };
    for (let i = 1; i <= MAX_ETIQUETAS; i++) item['Etiqueta' + i] = etq[i - 1] || '';
    return item;
  }

  // ════════════════════════════════════════════════════════════════════════
  // catalogStore — customInputs.CatProcesos del artículo de inventario (RMW)
  //   Leer:   GetInventoryItem {id} → inventoryItemById.customInputs.CatProcesos
  //   Schema: GetInventoryItemInputSchema {inventoryTypeId} → latest…ForType.id
  //   Escribir: UpdateInventoryItemInputs {itemId, inputSchemaId, customInputs}
  // ════════════════════════════════════════════════════════════════════════
  const _cat = { ci: null, entries: null, loadedAt: 0 };

  const _GET_VARS = { id: INV_ITEM_ID, usagesLimit: 10, usagesOffset: 0, purchaseOrderBomItemsOffset: 0, purchaseOrderBomItemsLimit: 10 };

  // Una sola query trae el customInputs Y el inputSchemaId vigente del item.
  // (El inputSchemaId cambia cuando se edita el schema; leerlo del item es lo
  //  robusto — la query por tipo dejó de devolverlo tras editar el schema.)
  async function _readItem() {
    const data = await api().query('GetInventoryItem', _GET_VARS, 'GetInventoryItem');
    const it = (data && data.inventoryItemById) || {};
    const ci = it.customInputs || {};
    const sid = (it.inventoryItemInputSchemaByInputSchemaId && it.inventoryItemInputSchemaByInputSchemaId.id) || INPUT_SCHEMA_FALLBACK;
    return { ci, sid };
  }

  async function readCatalog(force) {
    if (!force && _cat.entries && (Date.now() - _cat.loadedAt) < CACHE_TTL_MS) return _cat.entries;
    const { ci } = await _readItem();
    _cat.ci = ci;
    _cat.entries = Array.isArray(ci[CATALOG_KEY]) ? ci[CATALOG_KEY] : [];
    _cat.loadedAt = Date.now();
    return _cat.entries;
  }

  // Escribe el array completo preservando otras keys del customInputs (RMW).
  async function writeCatalog(entries) {
    // Releer el customInputs COMPLETO + inputSchemaId justo antes de escribir.
    const { ci, sid } = await _readItem();
    ci[CATALOG_KEY] = entries;
    await api().query('UpdateInventoryItemInputs', { itemId: INV_ITEM_ID, inputSchemaId: sid, customInputs: ci }, 'UpdateInventoryItemInputs');
    _cat.ci = ci;
    _cat.entries = entries;
    _cat.loadedAt = Date.now();
    return entries;
  }

  // Agrega o actualiza (dedup por metal+linea+set etiquetas → reemplaza Proceso).
  async function addOrUpdateEntry(item) {
    const entries = (await readCatalog(true)).slice();
    const idx = entries.findIndex(r =>
      normStr(r.MetalBase) === normStr(item.MetalBase) &&
      normStr(r.Linea) === normStr(item.Linea) &&
      sameSet(etiquetasOf(r), etiquetasOf(item)));
    if (idx >= 0) entries[idx] = item; else entries.push(item);
    await writeCatalog(entries);
    return { added: idx < 0, total: entries.length };
  }

  async function deleteEntry(item) {
    const entries = (await readCatalog(true)).slice();
    const next = entries.filter(r => !(
      normStr(r.MetalBase) === normStr(item.MetalBase) &&
      normStr(r.Linea) === normStr(item.Linea) &&
      normStr(r.Proceso) === normStr(item.Proceso) &&
      sameSet(etiquetasOf(r), etiquetasOf(item))));
    await writeCatalog(next);
    return { removed: entries.length - next.length, total: next.length };
  }

  // ════════════════════════════════════════════════════════════════════════
  // liveCatalogs — dropdowns poblados desde catálogos oficiales (en vivo)
  // ════════════════════════════════════════════════════════════════════════
  const _live = { procesos: [], etiquetas: [], lineas: [], metales: [], loadedAt: 0 };

  async function loadLiveCatalogs(force) {
    if (!force && _live.loadedAt && (Date.now() - _live.loadedAt) < CACHE_TTL_MS) return _live;
    const [procesos, etiquetas, lineas, metales] = await Promise.all([
      fetchProcesos().catch(e => (warn(`procesos: ${e.message}`), [])),
      fetchEtiquetas().catch(e => (warn(`etiquetas: ${e.message}`), [])),
      fetchLineas().catch(e => (warn(`lineas: ${e.message}`), [])),
      fetchMetales().catch(e => (warn(`metales: ${e.message}`), []))
    ]);
    Object.assign(_live, { procesos, etiquetas, lineas, metales, loadedAt: Date.now() });
    log(`catálogos en vivo: ${procesos.length} procesos, ${etiquetas.length} etiquetas, ${lineas.length} líneas, ${metales.length} metales`);
    return _live;
  }

  async function fetchProcesos() {
    const data = await api().query('AllProcesses', { includeArchived: 'NO', processNodeTypes: ['PROCESS'], searchQuery: '', first: 500 });
    const nodes = data?.allProcessNodes?.nodes || data?.pagedData?.nodes || [];
    return [...new Set(nodes.map(p => p.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  async function fetchEtiquetas() {
    const data = await api().query('AllLabels', { condition: { forPartNumber: true } });
    const nodes = data?.allLabels?.nodes || [];
    const nonFinish = new Set(((api().getDomain()?.bulkUpload?.nonFinishLabelNames) || []).map(normStr));
    return [...new Set(nodes
      .filter(l => l.name && !l.archivedAt && !nonFinish.has(normStr(l.name)))
      .map(l => l.name))].sort((a, b) => a.localeCompare(b));
  }

  async function fetchLineas() {
    const dimIds = api().getDomain()?.dimensionIds || { linea: 349 };
    const data = await api().query('GetDimension', { id: dimIds.linea, includeArchived: 'NO' });
    const nodes = data?.acctDimensionById?.acctDimensionCustomValuesByDimensionId?.nodes || [];
    return nodes.filter(n => !n.archivedAt).map(n => (n.value || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  async function fetchMetales() {
    const data = await api().query('GetPartNumbersInputSchema', {}, 'GetPartNumbersInputSchema');
    const nodes = data?.allPartNumberInputSchemas?.nodes || [];
    const latest = nodes.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    return [...(latest?.inputSchema?.properties?.DatosAdicionalesNP?.properties?.BaseMetal?.enum || [])];
  }

  // ════════════════════════════════════════════════════════════════════════
  // domAdapter — leer inputs del DOM + escribir el combobox + anclar el ícono
  // ⚠️0b — los selectores específicos se afinan con los wrappers HTML reales.
  // ════════════════════════════════════════════════════════════════════════

  // Label EXACTO del combobox de proceso (evita matchear el heading "PROCESO Y SPECS").
  const PROCESS_LABEL_RE = /^\s*default\s*process\s*:?\s*$/i;
  const PROCESS_COMPONENT_ID = 'CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS';
  const MODAL_HEADING_RE = /proceso\s*y\s*specs|edit\s*part\s*number/i;
  const MATERIAL_LABEL_RE = /^\s*(material|metal\s*base|metal)\s*:?\s*$/i;
  const LINEA_LABEL_RE = /^\s*l[ií]nea\s*:?\s*$/i;

  function _ctrlFrom(el) {
    if (!el || !el.querySelector) return null;
    const combo = el.querySelector('input[role="combobox"]');
    if (!combo) return null;
    return combo.closest('[class*="-control"]') || combo.parentElement;
  }

  // Devuelve el control react-select del Default Process, o null.
  function findProcessControl() {
    // 1) Modal: contenedor estable por component-id.
    const c1 = _ctrlFrom(document.querySelector(`[data-steelhead-component-id="${PROCESS_COMPONENT_ID}"]`));
    if (c1) return c1;
    // 2) Label EXACTO "Default Process:" → primer ancestro que contenga el combobox.
    const els = document.querySelectorAll('p, label, span');
    for (const el of els) {
      if (el.closest('#sa-pc-modal, #sa-pc-icon')) continue;
      if (!PROCESS_LABEL_RE.test((el.textContent || '').trim())) continue;
      let p = el;
      for (let d = 0; d < 6 && p; d++, p = p.parentElement) {
        const c = _ctrlFrom(p);
        if (c) return c;
      }
    }
    return null;
  }

  function detectView() {
    // modal si hay un [role=dialog]/MuiPaper con heading de PN; si no, ficha.
    const heads = document.querySelectorAll('h1,h2,h3,h4,[class*="MuiTypography-h"]');
    for (const h of heads) {
      if (MODAL_HEADING_RE.test((h.textContent || '').trim()) &&
          h.closest('[role="dialog"], [class*="MuiDialog"], [class*="MuiPaper"]')) {
        return 'modal';
      }
    }
    return findProcessControl() ? 'ficha' : null;
  }

  // Lee el texto seleccionado de un react-select localizado por label.
  function readSingleValueByLabel(labelRe, root) {
    const scope = root || document;
    const candidates = scope.querySelectorAll('p, label, span, div');
    for (const el of candidates) {
      if (el.closest('#sa-pc-modal, #sa-pc-icon')) continue;
      const raw = (el.textContent || '').trim();
      if (!raw || raw.length > 40) continue;
      const cleaned = raw.replace(/[\s:*]+$/, '').trim();
      if (!labelRe.test(cleaned) && !labelRe.test(raw)) continue;
      if (el.querySelector('input, textarea, button, select')) continue;
      let labelRoot = el;
      while (labelRoot.parentElement
        && labelRoot.parentElement.children.length === 1
        && !['BODY', 'HTML'].includes(labelRoot.parentElement.tagName)) {
        labelRoot = labelRoot.parentElement;
      }
      let cursor = labelRoot.nextElementSibling;
      for (let hops = 0; cursor && hops < 8; hops++, cursor = cursor.nextElementSibling) {
        const sv = cursor.querySelector && cursor.querySelector('[class*="singleValue"], [class*="SingleValue"]');
        if (sv) return (sv.textContent || '').trim();
        const inp = cursor.querySelector && cursor.querySelector('input[type="text"], input:not([type])');
        if (inp && inp.value) return inp.value.trim();
        // Ficha: el valor es texto plano (<p>) hermano del label, sin control.
        const txt = (cursor.textContent || '').trim();
        if (txt && txt.length < 80 && !labelRe.test(txt)
            && !(cursor.querySelector && cursor.querySelector('input, select, button, textarea'))) {
          return txt;
        }
      }
    }
    return '';
  }

  function _nonFinishSet() {
    const dom = api() && api().getDomain ? api().getDomain() : {};
    return new Set(((dom.bulkUpload && dom.bulkUpload.nonFinishLabelNames) || []).map(normStr));
  }

  // Metal base: en el modal es un <select> RJSF nativo con id estable; en la
  // ficha cae al extractor por label.
  function readMetal() {
    const sel = document.getElementById('root_DatosAdicionalesNP_BaseMetal');
    if (sel && sel.selectedIndex > 0) {
      const opt = sel.options[sel.selectedIndex];
      if (opt && opt.value) return (opt.text || '').trim();
    }
    return readSingleValueByLabel(MATERIAL_LABEL_RE);
  }

  // Etiquetas de acabado: chips del react-select de "Labels". Cada chip se
  // identifica por su svg[data-testid="CloseIcon"]; el texto es el textContent
  // del chip (el svg no aporta texto). Se filtran los labels administrativos
  // (nonFinishLabelNames: SRG, SMY, "En desarrollo", ...).
  function readEtiquetasFromDom() {
    const nonFinish = _nonFinishSet();
    // Modal: react-select de Labels (component-id estable); cada chip tiene un
    // svg CloseIcon → su parentElement es el chip. Ficha: chips de solo lectura
    // (sin CloseIcon) con la clase generada css-1owv9dy en el encabezado.
    const labelCont = document.querySelector('[data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_LABELS"]');
    const chips = labelCont
      ? [...labelCont.querySelectorAll('svg[data-testid="CloseIcon"]')].map(svg => svg.parentElement).filter(Boolean)
      : [...document.querySelectorAll('.css-1owv9dy')];
    const out = [], seen = new Set();
    for (const chip of chips) {
      if (chip.closest('#sa-pc-modal, #sa-pc-icon')) continue;
      const t = (chip.textContent || '').trim();
      const n = normStr(t);
      if (!t || !n || nonFinish.has(n) || seen.has(n)) continue;
      seen.add(n); out.push(t);
    }
    return out;
  }

  // Lee metal, línea y etiquetas del DOM del PN en edición.
  // OJO: la Línea del UI es la forma LARGA (= columna Línea2 del catálogo).
  function readInputs() {
    const metal = readMetal();
    const linea = readSingleValueByLabel(LINEA_LABEL_RE);
    const etiquetas = readEtiquetasFromDom();
    return { metal, linea, etiquetas };
  }

  // Escribe el proceso en el combobox Default Process (patrón react-select).
  async function writeProcess(processName) {
    const ctrl = findProcessControl();
    if (!ctrl) return { success: false, reason: 'combobox Default Process no encontrado' };
    ctrl.click();
    await sleep(300);
    const inputEl = ctrl.querySelector('input');
    if (inputEl) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(inputEl, processName);
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    let options = [];
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      const menu = document.querySelector('[class*="menuList"], [class*="MenuList"], [class*="menu-list"], [class*="menu"], [class*="Menu"]');
      if (menu) {
        options = [...menu.querySelectorAll('[class*="option"], [class*="Option"]')];
        if (options.length) break;
      }
    }
    if (!options.length) return { success: false, reason: 'sin opciones tras abrir el combobox' };
    const target = normStr(processName);
    let best = null, bestScore = -1;
    for (const opt of options) {
      const norm = normStr(opt.textContent || '');
      let score = 0;
      if (norm === target) score = 100;
      else if (norm.includes(target) || target.includes(norm)) score = 50;
      if (score > bestScore) { bestScore = score; best = opt; }
    }
    if (!best || bestScore < 50) return { success: false, reason: `proceso "${processName}" no está en las opciones del combobox` };
    best.click();
    return { success: true, filled: best.textContent.trim() };
  }

  // ════════════════════════════════════════════════════════════════════════
  // iconInjector — autoInject: ancla el ícono 🧮 junto al combobox
  // ════════════════════════════════════════════════════════════════════════
  let _observer = null;
  let _debounce = null;

  // Ícono de calculadora monocromo (estilo icon-button MUI, se mezcla con la UI).
  const _ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'
    + '<path d="M7 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2H7zm0 2h10v4H7V4zm0 6h2v2H7v-2zm0 4h2v2H7v-2zm4-4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-4h2v6h-2v-6z"/></svg>';

  function ensureIcon() {
    const ctrl = findProcessControl();
    if (!ctrl) return;
    // El wrapper inmediato del react-select container suele envolver SOLO el
    // combobox → lo volvemos flex-row para anclar el botón AL LADO (no abajo).
    const container = ctrl.closest('[class*="-container"]') || ctrl;
    const wrap = container.parentElement || container;
    if (wrap.querySelector(':scope > .sa-pc-icon')) return; // idempotente
    const btn = document.createElement('button');
    btn.id = 'sa-pc-icon';
    btn.className = 'sa-pc-icon';
    btn.type = 'button';
    btn.title = 'Calculadora de Procesos';
    btn.innerHTML = _ICON_SVG;
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;'
      + 'flex:0 0 auto;margin-left:6px;width:30px;height:30px;padding:0;border:none;'
      + 'border-radius:6px;background:transparent;color:#1976d2;cursor:pointer;transition:background .15s;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(25,118,210,0.10)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openModal(); });
    try { wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; container.style.flex = '1 1 auto'; } catch (_) {}
    wrap.appendChild(btn);
  }

  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (_debounce) clearTimeout(_debounce);
      _debounce = setTimeout(ensureIcon, 350);
    });
    _observer.observe(document.body, { childList: true, subtree: true });
    ensureIcon();
  }

  // ════════════════════════════════════════════════════════════════════════
  // modal UI — inputs editables, cálculo, resultado, agregar al catálogo
  // ════════════════════════════════════════════════════════════════════════
  function ensureStyles() {
    if (document.getElementById('sa-pc-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-pc-styles';
    s.textContent = `
      #sa-pc-modal{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
      .sa-pc-card{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:22px 24px;width:480px;max-width:94vw;max-height:88vh;overflow-y:auto;box-shadow:0 12px 48px rgba(0,0,0,.5)}
      .sa-pc-card h2{margin:0 0 4px;font-size:18px;color:#38bdf8;display:flex;justify-content:space-between;align-items:center}
      .sa-pc-sub{font-size:11px;color:#64748b;margin-bottom:14px}
      .sa-pc-field{margin-bottom:10px}
      .sa-pc-field label{display:block;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
      .sa-pc-field select,.sa-pc-field input{width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:13px}
      .sa-pc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
      .sa-pc-chip{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:3px 8px 3px 10px;font-size:12px;display:inline-flex;align-items:center;gap:6px}
      .sa-pc-chip button{background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;line-height:1}
      .sa-pc-result{margin-top:14px;padding:12px;border-radius:8px;font-size:13px}
      .sa-pc-btn{padding:8px 16px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer}
      .sa-pc-btn-primary{background:#38bdf8;color:#0f172a}
      .sa-pc-btn-ghost{background:#334155;color:#e2e8f0}
      .sa-pc-btnrow{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
      .sa-pc-procbtn{display:block;width:100%;text-align:left;margin-bottom:6px;padding:9px 12px;border-radius:7px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:13px;cursor:pointer}
      .sa-pc-procbtn:hover{border-color:#38bdf8}
      .sa-pc-x{background:none;border:none;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1}
    `;
    document.head.appendChild(s);
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function optionsHtml(values, selected) {
    const sel = normStr(selected);
    const opts = ['<option value="">(seleccione)</option>'];
    for (const v of values) {
      const isSel = normStr(v) === sel ? ' selected' : '';
      opts.push(`<option value="${escHtml(v)}"${isSel}>${escHtml(v)}</option>`);
    }
    return opts.join('');
  }

  // Estado mutable del modal.
  let _modalState = null;

  async function openModal() {
    ensureStyles();
    closeModal();

    const ov = document.createElement('div');
    ov.id = 'sa-pc-modal';
    ov.innerHTML = `<div class="sa-pc-card">
      <h2>🧮 Calculadora de Procesos <button class="sa-pc-x" id="sa-pc-close">×</button></h2>
      <div class="sa-pc-sub">v${VERSION} · artículo ${INV_ITEM_ID}</div>
      <div id="sa-pc-body">Cargando catálogos…</div>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(); });
    document.getElementById('sa-pc-close').onclick = closeModal;

    // Leer inputs del DOM + cargar catálogos en vivo en paralelo.
    const domInputs = readInputs();
    let live;
    try { live = await loadLiveCatalogs(); }
    catch (e) { live = _live; warn(`catálogos: ${e.message}`); }

    _modalState = {
      metal: domInputs.metal || '',
      linea: domInputs.linea || '',
      etiquetas: (domInputs.etiquetas || []).filter(Boolean),
      live
    };
    renderBody();
  }

  function renderBody() {
    const body = document.getElementById('sa-pc-body');
    if (!body || !_modalState) return;
    const { metal, linea, etiquetas, live } = _modalState;

    const chipsHtml = etiquetas.map((e, i) =>
      `<span class="sa-pc-chip">${escHtml(e)}<button data-rm="${i}" title="quitar">×</button></span>`).join('');

    body.innerHTML = `
      <div class="sa-pc-field">
        <label>Metal base</label>
        <select id="sa-pc-metal">${optionsHtml(live.metales, metal)}</select>
      </div>
      <div class="sa-pc-field">
        <label>Línea</label>
        <select id="sa-pc-linea">${optionsHtml(live.lineas, linea)}</select>
      </div>
      <div class="sa-pc-field">
        <label>Etiquetas de acabado (máx ${MAX_ETIQUETAS})</label>
        <div class="sa-pc-chips" id="sa-pc-chips">${chipsHtml || '<span style="font-size:12px;color:#64748b">sin etiquetas</span>'}</div>
        <select id="sa-pc-add-etq" style="margin-top:6px">${optionsHtml(live.etiquetas, '')}</select>
      </div>
      <div id="sa-pc-result"></div>
      <div class="sa-pc-btnrow">
        <button class="sa-pc-btn sa-pc-btn-ghost" id="sa-pc-recalc">Calcular</button>
      </div>`;

    // Wire inputs.
    document.getElementById('sa-pc-metal').onchange = (e) => { _modalState.metal = e.target.value; };
    document.getElementById('sa-pc-linea').onchange = (e) => { _modalState.linea = e.target.value; };
    document.getElementById('sa-pc-add-etq').onchange = (e) => {
      const v = e.target.value;
      if (v && _modalState.etiquetas.length < MAX_ETIQUETAS && !_modalState.etiquetas.some(x => normStr(x) === normStr(v))) {
        _modalState.etiquetas.push(v);
        renderBody();
      } else { e.target.value = ''; }
    };
    document.querySelectorAll('#sa-pc-chips [data-rm]').forEach(b => {
      b.onclick = () => { _modalState.etiquetas.splice(parseInt(b.dataset.rm, 10), 1); renderBody(); };
    });
    document.getElementById('sa-pc-recalc').onclick = calculate;

    calculate();
  }

  async function calculate() {
    const res = document.getElementById('sa-pc-result');
    if (!res || !_modalState) return;
    const input = { metal: _modalState.metal, linea: _modalState.linea, etiquetas: _modalState.etiquetas };

    if (!input.metal || !input.linea) {
      res.className = 'sa-pc-result';
      res.style.background = '#1e293b';
      res.innerHTML = 'Selecciona al menos metal base y línea.';
      return;
    }

    let entries;
    try { entries = await readCatalog(); }
    catch (e) {
      res.className = 'sa-pc-result';
      res.style.background = '#7f1d1d';
      res.innerHTML = `⚠️ ${escHtml(e.message)}`;
      return;
    }

    const matches = findMatches(entries, input);

    if (matches.length === 1) {
      res.className = 'sa-pc-result';
      res.style.background = '#064e3b';
      res.innerHTML = `<b>1 proceso:</b> ${escHtml(matches[0])}
        <div class="sa-pc-btnrow"><button class="sa-pc-btn sa-pc-btn-primary" id="sa-pc-place">Colocar en Default Process</button></div>`;
      document.getElementById('sa-pc-place').onclick = () => placeProcess(matches[0]);
    } else if (matches.length > 1) {
      res.className = 'sa-pc-result';
      res.style.background = '#1e3a5f';
      res.innerHTML = `<b>${matches.length} procesos candidatos — elige uno:</b>
        <div style="margin-top:8px">${matches.map(m => `<button class="sa-pc-procbtn" data-proc="${escHtml(m)}">${escHtml(m)}</button>`).join('')}</div>`;
      res.querySelectorAll('[data-proc]').forEach(b => { b.onclick = () => placeProcess(b.dataset.proc); });
    } else {
      res.className = 'sa-pc-result';
      res.style.background = '#7c2d12';
      res.innerHTML = `<b>Combinación no existente.</b> Agrégala al catálogo (compartido):
        <div class="sa-pc-field" style="margin-top:8px">
          <label>Proceso</label>
          <select id="sa-pc-new-proc">${optionsHtml(_modalState.live.procesos, '')}</select>
        </div>
        <div class="sa-pc-btnrow"><button class="sa-pc-btn sa-pc-btn-primary" id="sa-pc-add">+ Agregar al catálogo</button></div>`;
      document.getElementById('sa-pc-add').onclick = addCombination;
    }
  }

  async function placeProcess(proc) {
    const res = document.getElementById('sa-pc-result');
    const r = await writeProcess(proc);
    if (r.success) {
      if (res) { res.style.background = '#064e3b'; res.innerHTML = `✓ Colocado: <b>${escHtml(r.filled)}</b>. Recuerda <b>Guardar</b> el NP.`; }
      setTimeout(closeModal, 1400);
    } else if (res) {
      res.style.background = '#7f1d1d';
      res.innerHTML = `⚠️ No se pudo colocar: ${escHtml(r.reason)}. Cópialo manual: <b>${escHtml(proc)}</b>`;
    }
  }

  async function addCombination() {
    const sel = document.getElementById('sa-pc-new-proc');
    const proc = sel?.value;
    const res = document.getElementById('sa-pc-result');
    if (!proc) { if (res) res.innerHTML += '<div style="color:#fca5a5;margin-top:6px">Selecciona un proceso.</div>'; return; }
    const item = buildEntry({ metal: _modalState.metal, linea: _modalState.linea, etiquetas: _modalState.etiquetas }, proc);
    try {
      const r = await addOrUpdateEntry(item);
      if (res) { res.style.background = '#064e3b'; res.innerHTML = `✓ ${r.added ? 'Agregada' : 'Actualizada'} (catálogo: ${r.total}). Compartida con todos.`; }
      // Recalcular para colocar el proceso ya resuelto.
      setTimeout(() => placeProcess(proc), 900);
    } catch (e) {
      if (res) { res.style.background = '#7f1d1d'; res.innerHTML = `⚠️ No se pudo guardar: ${escHtml(e.message)}`; }
    }
  }

  function closeModal() {
    document.getElementById('sa-pc-modal')?.remove();
    _modalState = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // init — autoInject idempotente
  // ════════════════════════════════════════════════════════════════════════
  function init() {
    if (window.__saProcesoCalcInstalled) return;
    window.__saProcesoCalcInstalled = true;
    if (document.documentElement.dataset.saProcesoCalculatorEnabled === 'false') { log('deshabilitado'); return; }
    log(`init v${VERSION} en ${location.pathname}`);
    startObserver();
  }

  return {
    init, openModal, closeModal,
    // expuesto para tests/depuración
    _internals: { normStr, sameSet, findMatches, buildEntry, etiquetasOf }
  };
})();

if (typeof window !== 'undefined') {
  window.ProcesosCalculator = ProcesosCalculator;
  ProcesosCalculator.init();
}
