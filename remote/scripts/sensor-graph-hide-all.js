// Auto-ocultar Sensores en la Gráfica — glue DOM.
// Al entrar a un Sensor Dashboard, esconde TODOS los sensores de la gráfica
// (deja todos los ojitos "tachados") para que el operador solo destache el que
// quiere ver. La lógica de decisión pura vive en SensorGraphHideAllCore.
//
// Auto-inyectado (autoInject:true, molde de los guards). Sin fetch: esconder es
// puro estado de React (0 mutaciones). Un poll acotado espera a que la tabla
// "Current Values" renderice y clickea los ojitos visibles hasta que no quede
// ninguno; luego LATCHEA la entrada y no vuelve a pelear con el operador.
const SensorGraphHideAll = (() => {
  'use strict';

  const Core = () => window.SensorGraphHideAllCore;
  const HIDE_ARIA = 'Hide this sensor in the graph.';   // botón de un sensor VISIBLE
  const SHOW_ARIA = 'Show this sensor in the graph.';   // botón de un sensor OCULTO
  const POLL_MS = 150;
  const POLL_MAX_TICKS = 30;   // ~4.5s de ventana para esperar el render
  const MAX_ATTEMPTS = 8;      // topes de clic (evita loop si un sensor no se esconde)

  // ── Estado singleton (sobrevive la RE-INYECCIÓN del script) ──
  // background.js → injectAppScripts RE-EVALÚA este IIFE en cada acción del popup
  // (el script no está en el mapa `globals` de dedup). Si el flag / la clave latcheada
  // vivieran en el closure, una re-inyección los reiniciaría y re-esconderíamos lo que
  // el operador ya destachó. El singleton en `window` lo comparten todas las instancias.
  // Default ON solo en la PRIMERA carga (undefined): un reload limpia window → vuelve a
  // ON (no persistente, por diseño — igual que los guards).
  if (window.__saSensorHideEnabled === undefined) window.__saSensorHideEnabled = true;
  function isEnabled() { return window.__saSensorHideEnabled === true; }
  function setEnabled(v) { window.__saSensorHideEnabled = !!v; }

  function entryKey() { return location.pathname; }   // granularidad = dashboard (ignora ?type=)
  function onDashboard() { return Core().isDashboardPath(location.pathname); }

  // ── Detección de los ojitos ──
  // Primario: por aria-label (específico de la gráfica de sensores, evita cazar otros
  // íconos de ojo del sitio). Fallback (por si Steelhead traduce el aria): botones con
  // el data-testid del ícono, que es a prueba de idioma.
  function getToggles() {
    const byAria = Array.prototype.slice.call(
      document.querySelectorAll(
        'button[aria-label="' + HIDE_ARIA + '"], button[aria-label="' + SHOW_ARIA + '"]'
      )
    );
    if (byAria.length) return byAria;
    return Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) {
      return b.querySelector('svg[data-testid="VisibilityIcon"], svg[data-testid="VisibilityOffIcon"]');
    });
  }
  function isVisibleToggle(btn) {
    const aria = btn.getAttribute('aria-label');
    if (aria === HIDE_ARIA) return true;
    if (aria === SHOW_ARIA) return false;
    return !!btn.querySelector('svg[data-testid="VisibilityIcon"]');   // fallback por testid
  }
  function isHiddenToggle(btn) {
    const aria = btn.getAttribute('aria-label');
    if (aria === SHOW_ARIA) return true;
    if (aria === HIDE_ARIA) return false;
    return !!btn.querySelector('svg[data-testid="VisibilityOffIcon"]');
  }
  function getVisibleToggles() { return getToggles().filter(isVisibleToggle); }

  // ── Poll de entrada ──
  function stopPoll() {
    if (window.__saSensorHidePoll) { clearInterval(window.__saSensorHidePoll); window.__saSensorHidePoll = null; }
  }

  function scheduleHideSequence() {
    stopPoll();                       // cancela cualquier poll de una entrada previa
    const key = entryKey();
    let ticks = 0, attempts = 0, clickedAny = false;

    window.__saSensorHidePoll = setInterval(function () {
      ticks++;
      // Bail si navegamos fuera de esta entrada o se desactivó mientras tanto.
      if (entryKey() !== key || !onDashboard() || !isEnabled()) { stopPoll(); return; }

      const toggles = getToggles();
      const visible = getVisibleToggles();
      const step = Core().nextHideStep({
        onDashboard: true, enabled: true,
        sameEntry: window.__saSensorHideLastKey === key,
        toggleCount: toggles.length, visibleCount: visible.length,
        attempts: attempts, maxAttempts: MAX_ATTEMPTS,
      });

      if (step === 'hide') {
        // Clic a todos los visibles de este tick; React puede re-renderizar de forma
        // async y dejar rezagados → los siguientes ticks re-consultan fresco y los
        // atrapan. No latcheamos hasta que no quede ninguno (o se agoten los intentos).
        visible.forEach(function (b) { try { b.click(); clickedAny = true; } catch (_) {} });
        attempts++;
        return;
      }
      if (step === 'latch') {
        window.__saSensorHideLastKey = key;
        if (clickedAny) toast('👁 Sensores ocultos en la gráfica — destacha el que quieras ver.');
        stopPoll();
        return;
      }
      if (step === 'wait') {
        if (ticks >= POLL_MAX_TICKS) stopPoll();   // la tabla nunca renderizó: nos rendimos
        return;
      }
      stopPoll();   // 'idle' | 'done'
    }, POLL_MS);
  }

  // Restaura todos los sensores a visibles (usado al DESACTIVAR el toggle).
  function unhideAll() {
    let guard = 0;
    while (guard++ < 300) {
      const hidden = getToggles().filter(isHiddenToggle);
      if (!hidden.length) break;
      const before = hidden.length;
      hidden.forEach(function (b) { try { b.click(); } catch (_) {} });
      if (getToggles().filter(isHiddenToggle).length >= before) break;   // atorado: evita loop
    }
  }

  // ── Toggle desde el popup (background llama window.SensorGraphHideAll.toggleFromPopup) ──
  function toggleFromPopup() {
    setEnabled(!isEnabled());
    const on = isEnabled();
    if (on) {
      window.__saSensorHideLastKey = undefined;         // re-arma la entrada actual
      if (onDashboard()) scheduleHideSequence();
      toast('👁 Auto-ocultar sensores: ACTIVADO');
    } else {
      stopPoll();
      if (onDashboard()) unhideAll();                   // mostrar todos de inmediato
      toast('👁 Auto-ocultar sensores: DESACTIVADO (se reactiva al recargar).');
    }
    return { enabled: on };
  }

  // ── Toast (dark mode — regla de diseño: UI propia distinguible de la de SH) ──
  function injectStyles() {
    if (document.getElementById('sa-sgh-style')) return;
    const css = [
      '.sa-sgh-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);',
      'z-index:2147483600;background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;',
      'border-left:4px solid #13a36f;border-radius:10px;padding:12px 18px;font-size:14px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}',
      // Barra del combo (Fase 2) — dark-mode para distinguirla de la UI de SH.
      '.sa-sgc-bar{display:flex;align-items:center;gap:10px;background:#1c2430;color:#e6e9ee;',
      'border:1px solid #2b3645;border-left:4px solid #13a36f;border-radius:10px;',
      'padding:10px 14px;margin:0 0 16px 0;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;}',
      '.sa-sgc-label{font-weight:700;white-space:nowrap;}',
      '.sa-sgc-select{flex:1;min-width:200px;max-width:520px;background:#141a23;color:#e6e9ee;',
      'border:1px solid #2b3645;border-radius:8px;padding:8px 10px;font-size:13px;cursor:pointer;',
      'font-family:inherit;}',
      '.sa-sgc-select:focus{outline:none;border-color:#13a36f;}'
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-sgh-style';
    s.textContent = css;
    document.head.appendChild(s);
  }
  let toastTimer = null;
  function toast(msg) {
    injectStyles();
    let el = document.getElementById('sa-sgh-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-sgh-toast'; el.className = 'sa-sgh-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { const e = document.getElementById('sa-sgh-toast'); if (e) e.remove(); }, 4000);
  }

  // ── Navegación SPA: re-dispara al entrar a un dashboard, teardown al salir ──
  function installUrlChangeListener() {
    if (!window.__saSensorHideUrlListener) {
      window.__saSensorHideUrlListener = true;
      const fire = function () { window.dispatchEvent(new Event('sa-urlchange')); };
      ['pushState', 'replaceState'].forEach(function (m) {
        const orig = history[m];
        history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
      });
      window.addEventListener('popstate', fire);
    }
    window.addEventListener('sa-urlchange', function () {
      if (onDashboard()) {
        if (isEnabled()) scheduleHideSequence();
        observeForCombos();
        scheduleComboWork();
      } else {
        stopPoll();
        teardownCombos();
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Fase 2 — Combo para AISLAR un sensor (ver solo uno)
  // ════════════════════════════════════════════════════════════════════════

  // ── Intercepción de SensorDashboardQuery (fuente del tipo NUMBER/BOOLEAN) ──
  // El ?type=NUMBER nativo filtra la GRÁFICA pero NO la tabla/ojitos (verificado),
  // así que el tipo por-sensor hay que sacarlo de la query. Guardamos {name, station,
  // measurementType} por sensor en un singleton (sobrevive re-inyección).
  function patchFetch() {
    if (window.__saSensorHideFetchPatched) return;
    window.__saSensorHideFetchPatched = true;
    const orig = window.fetch;
    window.fetch = function (...args) {
      const url = (args[0] && args[0].url) || args[0];
      const body = args[1] && args[1].body;
      let isSDQ = false;
      if (typeof url === 'string' && url.indexOf('/graphql') !== -1 && typeof body === 'string') {
        try { isSDQ = JSON.parse(body).operationName === 'SensorDashboardQuery'; } catch (_) {}
      }
      const p = orig.apply(this, args);
      if (isSDQ) {
        p.then(function (resp) {
          resp.clone().json().then(function (j) { try { captureSensorMeta(j); } catch (_) {} }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  }

  function captureSensorMeta(j) {
    const list = Core().parseSensorDashboard(j);
    if (!list) return;
    window.__saSensorMeta = { dashKey: entryKey(), list: list };
    scheduleComboWork();   // repoblar el combo ahora que llegó la data
  }

  // Re-dispara SensorDashboardQuery si el hook NO alcanzó a capturarla (la query se
  // dispara en la carga inicial ANTES de que el applet inyecte patchFetch). Los members
  // (nombres+tipos) NO dependen del rango de fechas, así que pedimos una ventana chica.
  function ensureSensorMeta() {
    if (numericSensorList()) return;                       // ya hay data para esta entrada
    if (window.__saSensorMetaFetching) return;             // ya en curso
    const api = window.SteelheadAPI;
    if (!api || typeof api.query !== 'function') return;   // sin API → dependemos del hook
    const id = parseInt(Core().parseDashboardId(location.pathname), 10);
    if (!id) return;
    const key = entryKey();
    window.__saSensorMetaFetching = true;
    const before = new Date().toISOString();
    const after = new Date(Date.now() - 3600 * 1000).toISOString();   // 1h: members completos, pocas mediciones
    api.query('SensorDashboardQuery', { idInDomain: id, after: after, before: before, measurementType: 'NUMBER' })
      .then(function (data) {
        window.__saSensorMetaFetching = false;
        if (entryKey() !== key) return;                    // navegamos: descartar
        const list = Core().parseSensorDashboard({ data: data });
        if (list && list.length) { window.__saSensorMeta = { dashKey: key, list: list }; scheduleComboWork(); }
      })
      .catch(function (e) {
        window.__saSensorMetaFetching = false;
        console.warn('[SA] combo: replay de SensorDashboardQuery falló:', e && e.message);
      });
  }

  // Lista de sensores NUMBER (o null si aún no capturamos la query).
  function numericSensorList() {
    const meta = window.__saSensorMeta;
    if (!meta || !meta.list || meta.dashKey !== entryKey()) return null;
    return Core().filterNumericSensors(meta.list).map(function (s) {
      return { name: s.name, norm: Core().normalizeName(s.name), label: Core().sensorLabel(s) };
    });
  }

  // ── Mapeo ojito → fila → nombre de sensor ──
  function getEyeRows() {
    return getToggles().map(function (btn) {
      const tr = btn.closest('tr');
      const cell = tr && (tr.querySelector('a') || tr.querySelector('td'));
      const name = cell ? cell.textContent : '';
      return { btn: btn, name: name, norm: Core().normalizeName(name), visible: isVisibleToggle(btn) };
    }).filter(function (r) { return r.name; });
  }

  // ── Aislar (poll acotado: clicar NO actualiza el DOM síncrono; converge en ticks) ──
  function applyIsolation(value) {
    const key = entryKey();
    // Garantizar modo NUMBER al aislar un sensor numérico (si no, no se plotea).
    if (value && value !== 'ALL' && value !== 'NONE') {
      const nb = document.querySelector('button[value="NUMBER"]');
      if (nb && nb.getAttribute('aria-pressed') !== 'true') { try { nb.click(); } catch (_) {} }
    }
    if (window.__saSensorComboApply) clearInterval(window.__saSensorComboApply);
    let attempts = 0;
    window.__saSensorComboApply = setInterval(function () {
      if (entryKey() !== key) { clearInterval(window.__saSensorComboApply); window.__saSensorComboApply = null; return; }
      const rows = getEyeRows();
      const all = rows.map(function (r) { return r.norm; });
      const plan = Core().planIsolation(value, all);
      const showSet = {}, hideSet = {};
      plan.show.forEach(function (n) { showSet[n] = 1; });
      plan.hide.forEach(function (n) { hideSet[n] = 1; });
      let acted = false;
      rows.forEach(function (r) {
        if (showSet[r.norm] && !r.visible) { try { r.btn.click(); acted = true; } catch (_) {} }
        else if (hideSet[r.norm] && r.visible) { try { r.btn.click(); acted = true; } catch (_) {} }
      });
      attempts++;
      if (!acted || attempts >= MAX_ATTEMPTS) {
        clearInterval(window.__saSensorComboApply); window.__saSensorComboApply = null;
        window.__saSensorHideLastKey = key;   // fue elección del operador: Fase 1 no re-esconde
        syncCombos();
      }
    }, POLL_MS);
  }

  // ── Combo UI ──
  function buildComboBar() {
    const bar = document.createElement('div');
    bar.className = 'sa-sgc-bar';
    const label = document.createElement('span');
    label.className = 'sa-sgc-label';
    label.textContent = '👁 Ver solo:';
    const sel = document.createElement('select');
    sel.className = 'sa-sgc-select';
    sel.addEventListener('change', function () { onComboChange(sel.value); });
    bar.appendChild(label);
    bar.appendChild(sel);
    return bar;
  }

  function onComboChange(value) {
    if (value === '') return;            // placeholder: no-op
    applyIsolation(value);
  }

  function injectCombos() {
    const anchors = document.querySelectorAll('button[value="NUMBER"]');
    anchors.forEach(function (nb) {
      const paper = nb.closest('.MuiPaper-root');
      if (!paper || !paper.parentElement) return;
      if (paper.nextElementSibling && paper.nextElementSibling.classList &&
        paper.nextElementSibling.classList.contains('sa-sgc-bar')) return;   // ya inyectado aquí
      injectStyles();
      paper.parentElement.insertBefore(buildComboBar(), paper.nextSibling);
    });
    populateCombos();
    syncCombos();
    if (!numericSensorList()) ensureSensorMeta();   // el hook no capturó → re-disparar la query
  }

  function comboSignature() {
    const nums = numericSensorList();
    return nums ? nums.map(function (s) { return s.norm; }).join('|') : 'LOADING';
  }

  function populateCombos() {
    const sig = comboSignature();
    const nums = numericSensorList();
    document.querySelectorAll('select.sa-sgc-select').forEach(function (sel) {
      if (sel.dataset.saSig === sig) return;   // ya poblado con esta lista (evita loop del observer)
      const current = sel.value;
      sel.innerHTML = '';
      const add = function (v, t) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
      add('', nums ? '— elige sensor —' : 'cargando sensores…');
      add('ALL', 'Todos');
      add('NONE', 'Ninguno');
      if (nums) nums.forEach(function (s) { add(s.norm, s.label); });
      sel.dataset.saSig = sig;
      if (current && Array.prototype.some.call(sel.options, function (o) { return o.value === current; })) sel.value = current;
    });
  }

  // Deriva el valor del combo desde el estado real de los ojitos y lo refleja en todos.
  function syncCombos() {
    const rows = getEyeRows();
    const all = rows.map(function (r) { return r.norm; });
    const vis = rows.filter(function (r) { return r.visible; }).map(function (r) { return r.norm; });
    const nums = (numericSensorList() || []).map(function (s) { return s.norm; });
    const val = Core().deriveComboValue({ visibleNames: vis, allNames: all, numericNames: nums });
    document.querySelectorAll('select.sa-sgc-select').forEach(function (sel) {
      const has = Array.prototype.some.call(sel.options, function (o) { return o.value === val; });
      sel.value = has ? val : '';   // property set: no dispara el MutationObserver
    });
  }

  let comboTimer = null;
  function scheduleComboWork() {
    if (comboTimer) return;
    comboTimer = setTimeout(function () {
      comboTimer = null;
      try { if (onDashboard()) injectCombos(); } catch (_) {}
    }, 200);
  }

  function observeForCombos() {
    if (window.__saSensorComboObs) return;
    const obs = new MutationObserver(function () { scheduleComboWork(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__saSensorComboObs = obs;
  }
  function teardownCombos() {
    if (window.__saSensorComboObs) { window.__saSensorComboObs.disconnect(); window.__saSensorComboObs = null; }
    if (window.__saSensorComboApply) { clearInterval(window.__saSensorComboApply); window.__saSensorComboApply = null; }
  }

  function init() {
    if (window.__saSensorHideInit) return;
    window.__saSensorHideInit = true;
    try { patchFetch(); } catch (_) {}          // solo actúa sobre SensorDashboardQuery
    installUrlChangeListener();
    if (onDashboard()) {
      if (isEnabled()) scheduleHideSequence();  // Fase 1
      // Fase 2 blindada: un bug del combo NO debe tumbar la Fase 1 ni al resto del app.
      try { observeForCombos(); scheduleComboWork(); } catch (e) { console.warn('[SA] combo init falló', e); }
    }
    console.log('[SA] SensorGraphHideAll activo (esconder al entrar + combo aislar sensor)');
  }

  return {
    init, toggleFromPopup,
    // Fase 2 (para debug/validación manual):
    _injectCombos: injectCombos, _applyIsolation: applyIsolation, _numericSensorList: numericSensorList,
    _getState: function () {
      const nums = numericSensorList();
      return {
        enabled: isEnabled(),
        lastKey: window.__saSensorHideLastKey || null,
        onDashboard: onDashboard(),
        toggles: getToggles().length,
        visible: getVisibleToggles().length,
        combos: document.querySelectorAll('select.sa-sgc-select').length,
        numericSensors: nums ? nums.length : null,
        metaCaptured: !!window.__saSensorMeta,
      };
    },
  };
})();

if (typeof window !== 'undefined') {
  window.SensorGraphHideAll = SensorGraphHideAll;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { SensorGraphHideAll.init(); });
  } else {
    SensorGraphHideAll.init();
  }
}
