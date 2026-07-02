// remote/scripts/pn-lifecycle.js
// UI + orquestación para el ciclo de vida de Números de Parte:
//   Marcar validación / Desarchivar / Quitar validación / Archivar (Borrado definitivo)
// Depends on: SteelheadAPI, SteelheadPNLifecycleCore, SteelheadBulkClassify (opcional), SteelheadHostCleanup
//
// 2026-07-02 — feat: applet inicial UI + orquestación (4 acciones, filtros, dedup, download JSON)

const PNLifecycle = (() => {
  'use strict';

  const core = () => window.SteelheadPNLifecycleCore;
  const api  = () => window.SteelheadAPI;
  const hc   = () => window.SteelheadHostCleanup || null;
  const clf  = () => window.SteelheadBulkClassify || null;
  const log  = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  let stopped    = false;
  let memMonitor = null;
  const RESUME_KEY = 'sa_pnlifecycle_resume_v1';

  // ═══════════════════════════════════════════
  // POOL + RETRY  (patrón archiver.js)
  // ═══════════════════════════════════════════

  async function runPool(items, worker, concurrency) {
    const queue = items.slice();
    let active = 0, done = 0, idx = 0;
    return new Promise((resolve) => {
      function next() {
        if (stopped) { if (active === 0) resolve(); return; }
        while (active < concurrency && idx < queue.length) {
          const myIdx = idx++;
          const item = queue[myIdx];
          active++;
          Promise.resolve().then(() => worker(item, myIdx))
            .catch(err => { if (err?.message !== '__sa_aborted__') warn(`runPool[${myIdx}]: ${String(err?.message || err).slice(0, 120)}`); })
            .finally(() => {
              active--; done++;
              if (stopped && active === 0) { resolve(); return; }
              if (done >= queue.length && active === 0) resolve();
              else next();
            });
        }
      }
      if (!queue.length) resolve(); else next();
    });
  }

  async function withRetry(fn, label, delays) {
    const dl = delays || [0, 1000, 2000];
    let lastErr = null;
    for (let attempt = 0; attempt < dl.length; attempt++) {
      if (stopped) throw new Error('__sa_aborted__');
      if (dl[attempt] > 0) await new Promise(r => setTimeout(r, dl[attempt]));
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (attempt < dl.length - 1) warn(`${label}: intento ${attempt + 1}/${dl.length} falló · ${String(err?.message || err).slice(0, 80)}`);
      }
    }
    throw lastErr || new Error(`${label}: agotó reintentos`);
  }

  // ═══════════════════════════════════════════
  // RESUME helpers (localStorage)
  // ═══════════════════════════════════════════

  function loadResume() {
    try { const raw = localStorage.getItem(RESUME_KEY); return raw ? JSON.parse(raw) : null; }
    catch (_) { return null; }
  }
  function saveResume(state) {
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function clearResume() {
    try { localStorage.removeItem(RESUME_KEY); } catch (_) {}
  }

  // ═══════════════════════════════════════════
  // HOST GUARDS  (memory hardening — EJE B)
  // ═══════════════════════════════════════════

  function startHostGuards() {
    const cleanup = hc();
    if (!cleanup) return;
    try { cleanup.stopDatadogSessionReplay(); } catch (_) {}
    if (!memMonitor) {
      memMonitor = cleanup.createMemMonitor({
        getElement: () => document.getElementById('sa-plc-mem'),
        onGuardrail: (pct) => {
          warn(`Memoria al ${pct}% — abortando PN Lifecycle`);
          stopped = true;
          try {
            alert(`⚠ Memoria al ${pct}%. El applet se detuvo. Tu avance quedó guardado: re-ejecuta para reanudar. Recarga la pestaña.`);
          } catch (_) {}
        },
      });
    }
    try { memMonitor.reset(); memMonitor.start(); } catch (_) {}
  }

  function stopMemMonitor() { try { memMonitor && memMonitor.stop(); } catch (_) {} }

  // ═══════════════════════════════════════════
  // UI — overlay dark-mode idempotente
  // Base #1c2430 · texto #e6e9ee · inputs #141a23 · acento #13a36f
  // ═══════════════════════════════════════════

  function ensureStyles() {
    if (document.getElementById('sa-plc-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-plc-styles';
    s.textContent = [
      '.plc-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.65);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.plc-modal{background:#1c2430;color:#e6e9ee;border-radius:12px;padding:28px 32px;max-width:760px;width:94%;max-height:88vh;overflow-y:auto;box-shadow:0 12px 48px rgba(0,0,0,.6)}',
      '.plc-modal h2{font-size:19px;margin:0 0 16px;color:#13a36f}',
      '.plc-btnrow{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}',
      '.plc-btn{padding:9px 22px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}',
      '.plc-btn-cancel{background:#2d3748;color:#e6e9ee}',
      '.plc-btn-primary{background:#13a36f;color:#fff}',
      '.plc-btn-danger{background:#dc2626;color:#fff}',
      '.plc-bar{height:10px;background:#0d1a13;border-radius:6px;overflow:hidden;margin:14px 0 8px}',
      '.plc-bar-fill{height:100%;width:0;background:#13a36f;border-radius:6px;transition:width .2s ease}',
      '.plc-bar-fill.indet{width:40%;animation:plcslide 1.1s infinite ease-in-out}',
      '@keyframes plcslide{0%{margin-left:-40%}100%{margin-left:100%}}',
      '.plc-progress{font-size:12px;color:#9ab0b8}',
      '.plc-input{width:100%;padding:7px 10px;border-radius:6px;border:1px solid #2d3748;background:#141a23;color:#e6e9ee;font-size:13px;box-sizing:border-box}',
      '.plc-select{padding:7px 10px;border-radius:6px;border:1px solid #2d3748;background:#141a23;color:#e6e9ee;font-size:12px}',
    ].join('');
    document.head.appendChild(s);
  }

  // Overlay de progreso idempotente (se reusa sin destruir durante scan/ejecucion).
  function showProgressUI(msg) {
    ensureStyles();
    let ov = document.getElementById('sa-plc-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-plc-overlay';
      ov.className = 'plc-overlay';
      const md = document.createElement('div');
      md.className = 'plc-modal';
      const h2 = document.createElement('h2');
      h2.textContent = '⚙ PN Lifecycle';
      const bar = document.createElement('div');
      bar.className = 'plc-bar';
      const fill = document.createElement('div');
      fill.id = 'sa-plc-bar'; fill.className = 'plc-bar-fill';
      bar.appendChild(fill);
      const txt = document.createElement('div');
      txt.id = 'sa-plc-text'; txt.className = 'plc-progress';
      const mem = document.createElement('div');
      mem.id = 'sa-plc-mem';
      mem.style.cssText = 'margin-top:6px;font-family:ui-monospace,monospace;font-size:11px;color:#6b7a88';
      const stopBtn = document.createElement('button');
      stopBtn.id = 'sa-plc-stop'; stopBtn.className = 'plc-btn plc-btn-danger';
      stopBtn.style.cssText = 'margin-top:10px;padding:7px 14px;font-size:12px';
      stopBtn.textContent = '⏹ Detener';
      stopBtn.onclick = () => {
        stopped = true;
        stopBtn.textContent = 'Deteniendo...'; stopBtn.disabled = true;
      };
      md.append(h2, bar, txt, mem, stopBtn);
      ov.appendChild(md);
      document.body.appendChild(ov);
    }
    const el = document.getElementById('sa-plc-text');
    if (el) el.textContent = msg;
  }

  function setProgress(fraction, text) {
    showProgressUI(text);
    const bar = document.getElementById('sa-plc-bar');
    if (!bar) return;
    if (fraction == null) {
      bar.classList.add('indet');
      bar.style.width = '';
    } else {
      bar.classList.remove('indet');
      bar.style.width = Math.round(Math.min(Math.max(fraction, 0), 1) * 100) + '%';
    }
  }

  function removeProgressUI() {
    const ov = document.getElementById('sa-plc-overlay');
    if (ov) ov.parentNode.removeChild(ov);
  }

  // ═══════════════════════════════════════════
  // PANTALLA 1: Configuración (acción + opciones)
  // ═══════════════════════════════════════════

  function showConfigForm() {
    return new Promise(resolve => {
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'plc-overlay';
      const md = document.createElement('div');
      md.className = 'plc-modal';

      const h2 = document.createElement('h2');
      h2.textContent = '🔄 PN Lifecycle — Configuración';
      md.appendChild(h2);

      // Radios de acción
      const actTitle = document.createElement('p');
      actTitle.style.cssText = 'font-size:12px;color:#9ab0b8;margin:0 0 8px';
      actTitle.textContent = 'Acción a ejecutar:';
      md.appendChild(actTitle);

      const actionsInfo = [
        { value: 'validate',   label: 'Marcar validación',         sub: 'Agrega opt-in de proceso de validación' },
        { value: 'unarchive',  label: 'Desarchivar',                    sub: 'Reactiva PNs archivados' },
        { value: 'unvalidate', label: 'Quitar validación',         sub: 'Elimina opt-in de validación' },
        { value: 'archive',    label: 'Archivar (Borrado definitivo)',   sub: 'Agrega etiqueta 15646 + archiva' },
      ];

      const radioWrap = document.createElement('div');
      radioWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px';
      actionsInfo.forEach((a, i) => {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;color:#e6e9ee';
        const rb = document.createElement('input');
        rb.type = 'radio'; rb.name = 'plc-action'; rb.value = a.value;
        if (i === 0) rb.checked = true;
        rb.style.marginTop = '3px';
        const bEl = document.createElement('b');
        bEl.textContent = a.label;
        const sEl = document.createElement('span');
        sEl.style.cssText = 'color:#6b7a88;font-size:11px';
        sEl.textContent = ' — ' + a.sub;
        const wrap = document.createElement('span');
        wrap.append(bEl, sEl);
        lbl.append(rb, wrap);
        radioWrap.appendChild(lbl);
      });
      md.appendChild(radioWrap);

      // Checkbox "también validar" — solo visible cuando acción = unarchive
      const alsoValidateCb = document.createElement('input');
      alsoValidateCb.type = 'checkbox'; alsoValidateCb.id = 'plc-also-validate';
      const alsoValidateRow = document.createElement('div');
      alsoValidateRow.style.cssText = 'display:none;align-items:center;gap:8px;margin-bottom:12px';
      const avLbl = document.createElement('label');
      avLbl.htmlFor = 'plc-also-validate';
      avLbl.textContent = 'Marcar validación al desarchivar';
      avLbl.style.cssText = 'font-size:13px;color:#e6e9ee;cursor:pointer';
      alsoValidateRow.append(alsoValidateCb, avLbl);
      md.appendChild(alsoValidateRow);

      // Checkbox "incluir ya archivados" — solo visible cuando acción = archive
      const inclArchivedCb = document.createElement('input');
      inclArchivedCb.type = 'checkbox'; inclArchivedCb.id = 'plc-incl-archived';
      const inclArchivedRow = document.createElement('div');
      inclArchivedRow.style.cssText = 'display:none;align-items:center;gap:8px;margin-bottom:12px';
      const iaLbl = document.createElement('label');
      iaLbl.htmlFor = 'plc-incl-archived';
      iaLbl.textContent = 'Incluir PNs ya archivados';
      iaLbl.style.cssText = 'font-size:13px;color:#e6e9ee;cursor:pointer';
      inclArchivedRow.append(inclArchivedCb, iaLbl);
      md.appendChild(inclArchivedRow);

      const hint = document.createElement('p');
      hint.style.cssText = 'font-size:11px;color:#4d6370;margin-bottom:6px';
      hint.textContent = 'Después podrás filtrar por cliente, proceso, metal y etiquetas antes de ejecutar.';
      md.appendChild(hint);

      const btnRow = document.createElement('div');
      btnRow.className = 'plc-btnrow';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'plc-btn plc-btn-cancel'; cancelBtn.textContent = 'CANCELAR';
      const execBtn = document.createElement('button');
      execBtn.className = 'plc-btn plc-btn-primary'; execBtn.textContent = 'BUSCAR PNs';
      btnRow.append(cancelBtn, execBtn);
      md.appendChild(btnRow);

      ov.appendChild(md);
      document.body.appendChild(ov);

      const onActionChange = () => {
        const v = md.querySelector('input[name="plc-action"]:checked').value;
        alsoValidateRow.style.display  = v === 'unarchive' ? 'flex'  : 'none';
        inclArchivedRow.style.display  = v === 'archive'   ? 'flex'  : 'none';
      };
      md.querySelectorAll('input[name="plc-action"]').forEach(r => { r.onchange = onActionChange; });
      onActionChange();

      cancelBtn.onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      execBtn.onclick = () => {
        const result = {
          action:           md.querySelector('input[name="plc-action"]:checked').value,
          alsoValidate:     alsoValidateCb.checked,
          includeArchivedToo: inclArchivedCb.checked,
        };
        ov.parentNode.removeChild(ov);
        resolve(result);
      };
    });
  }

  // ═══════════════════════════════════════════
  // PANTALLA 2: Filtros (facets + dedup toggle + conteo en vivo)
  // ═══════════════════════════════════════════

  function showFilterScreen(pns, facets) {
    return new Promise(resolve => {
      removeProgressUI();
      ensureStyles();

      const ov = document.createElement('div');
      ov.className = 'plc-overlay';
      const md = document.createElement('div');
      md.className = 'plc-modal';

      const h2 = document.createElement('h2');
      h2.textContent = '🔍 Filtrar PNs';
      md.appendChild(h2);

      const sub = document.createElement('p');
      sub.style.cssText = 'font-size:12px;color:#9ab0b8;margin:0 0 12px';
      sub.textContent = pns.length + ' PNs en el conjunto base. Los filtros son opcionales.';
      md.appendChild(sub);

      // Helper: crea un bloque de checkboxes multi-select
      function makeMultiSelect(title, items, getKey, getLabel, cssClass) {
        if (!items || !items.length) return null;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom:10px;flex:1;min-width:0';
        const t = document.createElement('p');
        t.style.cssText = 'font-size:11px;color:#9ab0b8;margin:0 0 4px';
        t.textContent = title;
        const box = document.createElement('div');
        box.style.cssText = 'max-height:90px;overflow-y:auto;background:#141a23;border-radius:6px;padding:6px;display:flex;flex-wrap:wrap;gap:4px';
        items.forEach(item => {
          const lbl = document.createElement('label');
          lbl.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:#e6e9ee;cursor:pointer;white-space:nowrap';
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.className = cssClass;
          cb.dataset.key = getKey(item);
          const sp = document.createElement('span');
          sp.textContent = getLabel(item) + ' (' + item.count + ')';
          lbl.append(cb, sp);
          box.appendChild(lbl);
        });
        wrap.append(t, box);
        return wrap;
      }

      // Cliente
      const custWrap = makeMultiSelect('Cliente', facets.customers, i => String(i.id), i => i.name, 'plc-f-cust');
      if (custWrap) { custWrap.style.marginBottom = '10px'; md.appendChild(custWrap); }

      // Fila: proceso + metal
      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;gap:12px;margin-bottom:0';
      const procWrap  = makeMultiSelect('Proceso', facets.procesos,     i => i.name, i => i.name, 'plc-f-proc');
      const metalWrap = makeMultiSelect('Metal',   facets.metals,       i => i.name, i => i.name, 'plc-f-metal');
      if (procWrap)  row1.appendChild(procWrap);
      if (metalWrap) row1.appendChild(metalWrap);
      if (row1.children.length) md.appendChild(row1);

      // Fila: linea + departamento
      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:12px;margin-bottom:0';
      const lineaWrap = makeMultiSelect('Línea',        facets.lineas,        i => i.name, i => i.name, 'plc-f-linea');
      const deptoWrap = makeMultiSelect('Departamento',       facets.departamentos, i => i.name, i => i.name, 'plc-f-depto');
      if (lineaWrap) row2.appendChild(lineaWrap);
      if (deptoWrap) row2.appendChild(deptoWrap);
      if (row2.children.length) md.appendChild(row2);

      // Etiquetas + modo AND/OR
      if (facets.labels && facets.labels.length) {
        const lblTitle = document.createElement('p');
        lblTitle.style.cssText = 'font-size:11px;color:#9ab0b8;margin:10px 0 4px';
        lblTitle.textContent = 'Etiquetas';
        md.appendChild(lblTitle);

        const lblModeRow = document.createElement('div');
        lblModeRow.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:4px';
        const modeTitle = document.createElement('span');
        modeTitle.style.cssText = 'font-size:11px;color:#9ab0b8';
        modeTitle.textContent = 'Modo:';
        const andLbl = document.createElement('label');
        andLbl.style.cssText = 'font-size:11px;color:#e6e9ee;cursor:pointer;display:flex;gap:4px;align-items:center';
        const andRb = document.createElement('input');
        andRb.type = 'radio'; andRb.name = 'plc-lblmode'; andRb.value = 'AND'; andRb.checked = true;
        andLbl.append(andRb, document.createTextNode('Todas (AND)'));
        const orLbl = document.createElement('label');
        orLbl.style.cssText = 'font-size:11px;color:#e6e9ee;cursor:pointer;display:flex;gap:4px;align-items:center';
        const orRb = document.createElement('input');
        orRb.type = 'radio'; orRb.name = 'plc-lblmode'; orRb.value = 'OR';
        orLbl.append(orRb, document.createTextNode('Cualquiera (OR)'));
        lblModeRow.append(modeTitle, andLbl, orLbl);
        md.appendChild(lblModeRow);

        const lblBox = document.createElement('div');
        lblBox.style.cssText = 'max-height:80px;overflow-y:auto;background:#141a23;border-radius:6px;padding:6px;display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px';
        facets.labels.forEach(item => {
          const lbl = document.createElement('label');
          lbl.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:#e6e9ee;cursor:pointer;white-space:nowrap';
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.className = 'plc-f-lbl'; cb.dataset.key = item.name;
          const sp = document.createElement('span');
          sp.textContent = item.name + ' (' + item.count + ')';
          lbl.append(cb, sp);
          lblBox.appendChild(lbl);
        });
        md.appendChild(lblBox);
      }

      // Filtro de fecha
      const dateToggleRow = document.createElement('div');
      dateToggleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
      const dateCb = document.createElement('input');
      dateCb.type = 'checkbox'; dateCb.id = 'plc-use-date';
      const dateLbl = document.createElement('label');
      dateLbl.htmlFor = 'plc-use-date';
      dateLbl.textContent = 'Filtrar por fecha de creación';
      dateLbl.style.cssText = 'font-size:12px;color:#e6e9ee;cursor:pointer';
      dateToggleRow.append(dateCb, dateLbl);
      const dateOptions = document.createElement('div');
      dateOptions.style.cssText = 'display:none;gap:8px;margin-bottom:10px';
      const dirSelect = document.createElement('select');
      dirSelect.className = 'plc-select';
      [['before', 'Antes de'], ['after', 'Después de']].forEach(function(pair) {
        const o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        dirSelect.appendChild(o);
      });
      const dateInput = document.createElement('input');
      dateInput.type = 'date'; dateInput.className = 'plc-input'; dateInput.style.flex = '1';
      dateInput.value = new Date().toLocaleDateString('en-CA');
      dateOptions.append(dirSelect, dateInput);
      dateCb.onchange = function() { dateOptions.style.display = dateCb.checked ? 'flex' : 'none'; recount(); };
      md.append(dateToggleRow, dateOptions);

      // Toggle "solo duplicados genuinos"
      // scoreFn: prioriza PNs con proceso asignado (1M pts), luego más etiquetas (1K c/u), luego id mayor (más reciente).
      const dedupRow = document.createElement('div');
      dedupRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:14px';
      const dedupCb = document.createElement('input');
      dedupCb.type = 'checkbox'; dedupCb.id = 'plc-dedup';
      const dedupLbl = document.createElement('label');
      dedupLbl.htmlFor = 'plc-dedup';
      dedupLbl.textContent = 'Solo duplicados genuinos';
      dedupLbl.style.cssText = 'font-size:12px;color:#e6e9ee;cursor:pointer';
      const dedupHint = document.createElement('span');
      dedupHint.style.cssText = 'font-size:10px;color:#4d6370';
      dedupHint.textContent = '(prioridad: proceso → #etiquetas → id)';
      dedupRow.append(dedupCb, dedupLbl, dedupHint);
      md.appendChild(dedupRow);

      // Live count
      const countRow = document.createElement('div');
      countRow.style.cssText = 'font-size:14px;color:#13a36f;margin-bottom:14px;font-weight:600';
      const countNum = document.createElement('b');
      countNum.id = 'plc-filter-count'; countNum.textContent = String(pns.length);
      countRow.append(countNum, document.createTextNode(' PNs seleccionados'));
      md.appendChild(countRow);

      const btnRow = document.createElement('div');
      btnRow.className = 'plc-btnrow';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'plc-btn plc-btn-cancel'; cancelBtn.textContent = 'CANCELAR';
      const nextBtn = document.createElement('button');
      nextBtn.className = 'plc-btn plc-btn-primary'; nextBtn.textContent = 'CONTINUAR →';
      btnRow.append(cancelBtn, nextBtn);
      md.appendChild(btnRow);

      ov.appendChild(md);
      document.body.appendChild(ov);

      // Build filters object from current UI state
      function getFilters() {
        const customers = Array.from(md.querySelectorAll('.plc-f-cust:checked')).map(function(cb) { return Number(cb.dataset.key); });
        const metals    = Array.from(md.querySelectorAll('.plc-f-metal:checked')).map(function(cb) { return cb.dataset.key; });
        const procesos  = Array.from(md.querySelectorAll('.plc-f-proc:checked')).map(function(cb) { return cb.dataset.key; });
        const lineas    = Array.from(md.querySelectorAll('.plc-f-linea:checked')).map(function(cb) { return cb.dataset.key; });
        const departamentos = Array.from(md.querySelectorAll('.plc-f-depto:checked')).map(function(cb) { return cb.dataset.key; });
        const lblNames  = Array.from(md.querySelectorAll('.plc-f-lbl:checked')).map(function(cb) { return cb.dataset.key; });
        const modeEl    = md.querySelector('input[name="plc-lblmode"]:checked');
        const lblMode   = modeEl ? modeEl.value : 'AND';
        const dateFilter = (dateCb.checked && dateInput.value)
          ? { cutoffISO: new Date(dateInput.value).toISOString(), direction: dirSelect.value }
          : null;
        return { customers: customers, metals: metals, procesos: procesos,
                 lineas: lineas, departamentos: departamentos,
                 labels: { names: lblNames, mode: lblMode }, dateFilter: dateFilter };
      }

      function recount() {
        var filtered = core().applyFilters(pns, getFilters());
        if (dedupCb.checked && clf()) {
          var DOMAIN = api().getDomain() || {};
          // scoreFn inyectado en selectDuplicates:
          // prioriza proceso presente, luego #etiquetas, luego id (mayor = más reciente).
          var scoreFn = function(pn) { return (pn.proceso ? 1e6 : 0) + ((pn.labels && pn.labels.length) || 0) * 1000 + pn.id; };
          var dup = core().selectDuplicates(filtered, {
            classify: clf(),
            nonFinishList: (DOMAIN.bulkUpload && DOMAIN.bulkUpload.nonFinishLabelNames) || [],
            equivGroups:   (DOMAIN.bulkUpload && DOMAIN.bulkUpload.metalEquivalents) || [],
            scoreFn: scoreFn,
          });
          var toTagSet = new Set(dup.toTag);
          filtered = filtered.filter(function(p) { return toTagSet.has(p.id); });
        }
        var el = document.getElementById('plc-filter-count');
        if (el) el.textContent = String(filtered.length);
        return filtered;
      }

      // Wire live updates on all filter controls
      Array.from(md.querySelectorAll('input[type="checkbox"],input[type="radio"]')).forEach(function(el) {
        el.addEventListener('change', recount);
      });
      dateInput.addEventListener('change', recount);
      dirSelect.addEventListener('change', recount);

      cancelBtn.onclick = function() { ov.parentNode.removeChild(ov); resolve(null); };
      nextBtn.onclick = function() {
        var filtered = recount();
        ov.parentNode.removeChild(ov);
        resolve({ selected: filtered });
      };
    });
  }

  // ═══════════════════════════════════════════
  // PANTALLA 3: Preview (tabla DOM, cap 500 filas)
  // ═══════════════════════════════════════════

  var ACTION_LABELS = {
    validate:   { label: 'Marcar Validación', color: '#13a36f' },
    unarchive:  { label: 'Desarchivar',             color: '#2563eb' },
    unvalidate: { label: 'Quitar Validación',  color: '#d97706' },
    archive:    { label: 'Archivar',                color: '#dc2626' },
  };

  function showPreview(pns, action) {
    var MAX_ROWS = 500;
    var trimmed  = pns.length > MAX_ROWS;
    var displayed = trimmed ? pns.slice(0, MAX_ROWS) : pns;
    var acInfo = ACTION_LABELS[action] || { label: action, color: '#13a36f' };

    return new Promise(function(resolve) {
      removeProgressUI();
      ensureStyles();

      var ov = document.createElement('div');
      ov.className = 'plc-overlay';
      var md = document.createElement('div');
      md.className = 'plc-modal';

      var h2 = document.createElement('h2');
      h2.textContent = acInfo.label + ' — Preview';
      md.appendChild(h2);

      var sub = document.createElement('p');
      sub.style.cssText = 'font-size:12px;color:#9ab0b8;margin:0 0 10px';
      sub.textContent = pns.length + ' PNs seleccionados.';
      md.appendChild(sub);

      if (trimmed) {
        var tw = document.createElement('p');
        tw.style.cssText = 'font-size:11px;color:#d97706;margin:0 0 8px';
        tw.textContent = 'Mostrando primeros ' + MAX_ROWS + ' de ' + pns.length + '. Todos se procesan al confirmar.';
        md.appendChild(tw);
      }

      var tableWrap = document.createElement('div');
      tableWrap.style.cssText = 'max-height:320px;overflow-y:auto;margin-bottom:12px';
      var table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px';

      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      hr.style.cssText = 'color:#6b7a88;border-bottom:1px solid #2d3748';
      ['PN', 'Cliente', 'Proceso', 'Metal', 'Acabados'].forEach(function(col) {
        var th = document.createElement('th');
        th.style.cssText = 'text-align:left;padding:4px 6px;font-weight:500';
        th.textContent = col;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      var frag = document.createDocumentFragment();
      displayed.forEach(function(p) {
        var tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #1c2430';
        var tdName  = document.createElement('td'); tdName.style.padding = '3px 6px'; tdName.textContent = p.name || '';
        var tdCust  = document.createElement('td'); tdCust.style.cssText = 'padding:3px 6px;color:#9ab0b8'; tdCust.textContent = (p.customer && p.customer.name) || '';
        var tdProc  = document.createElement('td'); tdProc.style.cssText = 'padding:3px 6px;color:#9ab0b8'; tdProc.textContent = p.proceso || '';
        var tdMetal = document.createElement('td'); tdMetal.style.cssText = 'padding:3px 6px;color:#9ab0b8'; tdMetal.textContent = p.metal || '';
        var tdLbls  = document.createElement('td'); tdLbls.style.cssText = 'padding:3px 6px;color:#6b7a88;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        tdLbls.textContent = (p.labels || []).map(function(l) { return l.name; }).join(', ');
        tr.append(tdName, tdCust, tdProc, tdMetal, tdLbls);
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      md.appendChild(tableWrap);

      var btnRow = document.createElement('div');
      btnRow.className = 'plc-btnrow';
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'plc-btn plc-btn-cancel'; cancelBtn.textContent = 'CANCELAR';
      var execBtn = document.createElement('button');
      execBtn.className = 'plc-btn';
      execBtn.style.background = acInfo.color; execBtn.style.color = '#fff';
      execBtn.textContent = acInfo.label.toUpperCase() + ' (' + pns.length + ')';
      btnRow.append(cancelBtn, execBtn);
      md.appendChild(btnRow);

      ov.appendChild(md);
      document.body.appendChild(ov);

      cancelBtn.onclick = function() { ov.parentNode.removeChild(ov); resolve(null); };
      execBtn.onclick   = function() { ov.parentNode.removeChild(ov); resolve(pns); };
    });
  }

  // ═══════════════════════════════════════════
  // PANTALLA 4: Resultado + descarga JSON
  // ═══════════════════════════════════════════

  function showResult(stats, action) {
    removeProgressUI();
    ensureStyles();
    var acInfo = ACTION_LABELS[action] || { label: action, color: '#13a36f' };

    var ov = document.createElement('div');
    ov.className = 'plc-overlay';
    var md = document.createElement('div');
    md.className = 'plc-modal';

    var h2 = document.createElement('h2');
    h2.textContent = '✅ ' + acInfo.label + ' — Resultado';
    md.appendChild(h2);

    if (stats.stopped) {
      var sw = document.createElement('p');
      sw.style.cssText = 'color:#d97706;font-size:12px;margin-bottom:8px';
      sw.textContent = 'Detenido. Avance guardado — re-ejecuta para reanudar. (' + (stats.done || 0) + '/' + stats.total + ' completados)';
      md.appendChild(sw);
    }

    var summaryDiv = document.createElement('div');
    summaryDiv.style.cssText = 'font-size:13px;line-height:1.8;margin-bottom:14px';
    [
      { label: 'Total procesados', value: stats.total, color: '#e6e9ee' },
      { label: 'OK',               value: stats.ok,    color: '#13a36f' },
      { label: 'Errores',          value: stats.errors, color: stats.errors ? '#ef4444' : '#9ab0b8' },
    ].forEach(function(r) {
      var p = document.createElement('div');
      var b = document.createElement('b');
      b.style.color = '#9ab0b8'; b.textContent = r.label + ': ';
      var v = document.createElement('span');
      v.style.color = r.color; v.textContent = String(r.value);
      p.append(b, v);
      summaryDiv.appendChild(p);
    });
    md.appendChild(summaryDiv);

    if (stats.errorList && stats.errorList.length) {
      var errBox = document.createElement('div');
      errBox.style.cssText = 'max-height:100px;overflow-y:auto;background:#141a23;padding:8px;border-radius:6px;font-size:11px;color:#ef4444;margin-bottom:12px';
      stats.errorList.slice(0, 20).forEach(function(line, i) {
        if (i > 0) errBox.appendChild(document.createElement('br'));
        errBox.appendChild(document.createTextNode(line));
      });
      md.appendChild(errBox);
    }

    var btnRow = document.createElement('div');
    btnRow.className = 'plc-btnrow';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'plc-btn plc-btn-cancel'; closeBtn.textContent = 'CERRAR';
    var dlBtn = document.createElement('button');
    dlBtn.className = 'plc-btn plc-btn-primary'; dlBtn.textContent = '⬇ Descargar JSON';
    var reloadBtn = document.createElement('button');
    reloadBtn.className = 'plc-btn';
    reloadBtn.style.background = '#2563eb'; reloadBtn.style.color = '#fff';
    reloadBtn.textContent = 'CERRAR Y RECARGAR';
    btnRow.append(closeBtn, dlBtn, reloadBtn);
    md.appendChild(btnRow);

    ov.appendChild(md);
    document.body.appendChild(ov);

    closeBtn.onclick  = function() { ov.parentNode.removeChild(ov); };
    reloadBtn.onclick = function() { ov.parentNode.removeChild(ov); window.location.reload(); };
    dlBtn.onclick = function() {
      try {
        var blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'pn_lifecycle_results.json'; a.click();
        URL.revokeObjectURL(url);
      } catch (_) {}
    };
  }

  // ═══════════════════════════════════════════
  // EJECUCIÓN — runPool concurrencia 3 + resume + makePeriodicDrain
  // ═══════════════════════════════════════════

  async function executeAction(selectedPNs, action, deps, alreadyCompleted, results) {
    var completed = new Set(alreadyCompleted);
    var totalCount = selectedPNs.length;
    results.total = totalCount;
    saveResume({ action: action, selectedPNs: selectedPNs, completed: Array.from(completed), alsoValidate: deps.alsoValidate, includeArchivedToo: deps.includeArchivedToo });

    var acInfo = ACTION_LABELS[action] || { label: action };
    var drainPerPN = (hc() && hc().makePeriodicDrain) ? hc().makePeriodicDrain(50) : function() {};

    function tick(id, ok) {
      if (ok) results.ok++; else results.errors++;
      completed.add(id);
      results.done = completed.size;
      var fraction = totalCount > 0 ? Math.min(completed.size / totalCount, 1) : 0;
      var errStr = results.errors ? ' — ' + results.errors + ' err' : '';
      setProgress(fraction, acInfo.label + ': ' + completed.size + '/' + totalCount + errStr);
      if (completed.size % 5 === 0 || completed.size === totalCount) {
        saveResume({ action: action, selectedPNs: selectedPNs, completed: Array.from(completed), alsoValidate: deps.alsoValidate, includeArchivedToo: deps.includeArchivedToo });
      }
    }

    setProgress(totalCount > 0 ? completed.size / totalCount : 0, acInfo.label + ': ' + completed.size + '/' + totalCount);

    await runPool(selectedPNs, async function(pn) {
      if (stopped) return;
      if (completed.has(pn.id)) return;
      // Idempotencia: solo para acciones cuyo estado destino se conoce desde el slim
      // (archived/label). validate/unvalidate dependen de opt-ins no presentes en el slim,
      // y runOneItem ya es idempotente para ellas (tolera duplicado / borra solo lo que exista).
      if ((action === 'archive' || action === 'unarchive') && core().isInTargetState(pn, action)) { tick(pn.id, true); return; }

      var itemResult;
      try {
        itemResult = await withRetry(function() {
          return core().runOneItem(pn, action, api(), deps);
        }, action + ' PN#' + pn.id);
      } catch (e) {
        itemResult = { id: pn.id, status: 'error', error: String(e && e.message ? e.message : e).slice(0, 160) };
      }
      results.items.push(itemResult);
      if (itemResult.status === 'ok' || itemResult.status === 'noop') {
        tick(pn.id, true);
      } else {
        results.errorList.push((pn.name || String(pn.id)) + ': ' + (itemResult.error || 'error desconocido'));
        tick(pn.id, false);
      }
      drainPerPN();
    }, 3);

    if (stopped) {
      results.stopped = true;
      saveResume({ action: action, selectedPNs: selectedPNs, completed: Array.from(completed), alsoValidate: deps.alsoValidate, includeArchivedToo: deps.includeArchivedToo });
      log('PNLifecycle detenido — ' + completed.size + '/' + totalCount + ' completados, resume guardado');
      showResult(results, action);
      return results;
    }

    clearResume();
    log('\n=== PNLifecycle RESULTADO (' + action + ') ===');
    log('OK: ' + results.ok + '/' + totalCount + ', Errores: ' + results.errors);
    showResult(results, action);
    return results;
  }

  // ═══════════════════════════════════════════
  // ORQUESTACIÓN PRINCIPAL
  // ═══════════════════════════════════════════

  async function run(opts) {
    stopped = false;
    var action           = opts.action;
    var alsoValidate     = !!opts.alsoValidate;
    var includeArchivedToo = !!opts.includeArchivedToo;

    var DOMAIN = api().getDomain() || {};
    var validacionNodeIds = DOMAIN.validacionProcessNodeIds || [231176, 231174];
    var labelId = 15646; // "Borrado definitivo"

    var results = {
      action: action, total: 0, ok: 0, errors: 0,
      errorList: [], stopped: false, done: 0, items: [],
    };

    // ── Resume check ──
    var prevResume = loadResume();
    if (prevResume && prevResume.action === action && prevResume.selectedPNs && prevResume.selectedPNs.length) {
      var pending = prevResume.selectedPNs.filter(function(p) { return !prevResume.completed.includes(p.id); });
      var doResume = confirm(
        'Hay una operación "' + action + '" previa incompleta:\n' +
        '  ' + prevResume.completed.length + ' ya procesados\n  ' + pending.length + ' pendientes\n\n' +
        '¿Reanudar? (Cancelar = empezar de cero)'
      );
      if (doResume) {
        showProgressUI('Reanudando: ' + pending.length + ' pendientes...');
        var resumeAlsoValidate     = prevResume.alsoValidate     !== undefined ? prevResume.alsoValidate     : alsoValidate;
        var resumeIncludeArchived  = prevResume.includeArchivedToo !== undefined ? prevResume.includeArchivedToo : includeArchivedToo;
        return await executeAction(prevResume.selectedPNs, action,
          { validacionNodeIds: validacionNodeIds, labelId: labelId, alsoValidate: resumeAlsoValidate, includeArchivedToo: resumeIncludeArchived },
          prevResume.completed, results);
      }
      clearResume();
    }

    log('PNLifecycle: acción=' + action + ', alsoValidate=' + alsoValidate + ', includeArchivedToo=' + includeArchivedToo);
    setProgress(null, 'Buscando PNs para acción "' + action + '"...');

    // 1. Fetch PNs (scan slim)
    var pns = await core().fetchPNsForAction(action, api(), function(p) {
      var fraction = (p.total && p.total > 0) ? Math.min(p.processed / p.total, 1) : null;
      var stepStr = (p.steps > 1) ? ' (paso ' + p.step + '/' + p.steps + ')' : '';
      setProgress(fraction, 'Cargando PNs... ' + p.processed + (p.total ? '/' + p.total : '') + stepStr + ' (' + p.kept + ' del modo)');
    }, 500, { includeArchivedToo: includeArchivedToo });

    if (stopped) { results.stopped = true; showResult(results, action); return results; }
    log('  ' + pns.length + ' PNs cargados');

    if (!pns.length) {
      showResult(results, action);
      return results;
    }

    // 2. Discover facets
    var facets = core().discoverFacets(pns);

    // 3. Filter screen (incluye dedup si el toggle está activo)
    var filterResult = await showFilterScreen(pns, facets);
    if (!filterResult) { log('Cancelado en filtros.'); return { cancelled: true }; }

    var selected = filterResult.selected;
    if (!selected.length) {
      alert('No hay PNs tras aplicar los filtros.');
      return { cancelled: true };
    }

    // 4. Preview
    var confirmed = await showPreview(selected, action);
    if (!confirmed) { log('Cancelado en preview.'); return { cancelled: true }; }

    results.total = confirmed.length;

    // 5. Execute
    return await executeAction(confirmed, action,
      { validacionNodeIds: validacionNodeIds, labelId: labelId, alsoValidate: alsoValidate, includeArchivedToo: includeArchivedToo },
      [], results);
  }

  // ═══════════════════════════════════════════
  // ENTRY POINT
  // ═══════════════════════════════════════════

  async function openConfigAndRun() {
    startHostGuards();
    var opts = await showConfigForm();
    if (!opts) return { cancelled: true };
    try { return await run(opts); }
    catch (e) {
      warn('PNLifecycle error: ' + String(e && e.message ? e.message : e).slice(0, 120));
      return { error: e && e.message ? e.message : String(e) };
    }
    finally { stopMemMonitor(); }
  }

  var pub = { openConfigAndRun: openConfigAndRun };
  if (typeof window !== 'undefined') window.PNLifecycle = pub;
  return pub;
})();
