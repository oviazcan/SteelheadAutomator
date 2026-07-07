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
      'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}'
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
      if (onDashboard() && isEnabled()) scheduleHideSequence();
      else stopPoll();
    });
  }

  function init() {
    if (window.__saSensorHideInit) return;
    window.__saSensorHideInit = true;
    installUrlChangeListener();
    if (onDashboard() && isEnabled()) scheduleHideSequence();
    console.log('[SA] SensorGraphHideAll activo (esconder sensores al entrar al dashboard)');
  }

  return {
    init, toggleFromPopup,
    _getState: function () {
      return {
        enabled: isEnabled(),
        lastKey: window.__saSensorHideLastKey || null,
        onDashboard: onDashboard(),
        toggles: getToggles().length,
        visible: getVisibleToggles().length,
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
