// Candado de Surtido Programado — bloquea mover piezas no programadas en el
// step "Preparando Surtido en Almacén" del Workboard "Preparación de Surtido".
// Glue DOM/red; la lógica de decisión y parseo vive en SurtidoGuardCore.
//
// Capas (se completan a lo largo del plan 2026-06-26-surtido-guard.md):
//   1. Mapa "programada" (lectura del board query)          — Task 4
//   2. Enforcement (bloqueo de la mutación de mover)        — Task 5
//   3. Capa de modal (agrisar botones)                      — Task 6
//   4. Marcado verde de tarjetas                            — Task 7
//   5. Toggle no persistente desde el popup                 — Task 3 (este scaffold)
const SurtidoGuard = (() => {
  'use strict';

  const Core = () => window.SurtidoGuardCore;
  const WB_PATH_RE = /^\/Domains\/\d+\/Workboards\/\d+/;

  let enforcementEnabled = true;   // default ON en cada carga (no persistente)
  let scheduleIndex = {};          // JOIN_KEY -> record (lo llena el interceptor, Task 4)

  function isWorkboardPage() { return WB_PATH_RE.test(location.pathname); }
  function isEnabled() { return enforcementEnabled; }

  // Entrada desde el popup (background llama window.SurtidoGuard.toggleFromPopup).
  function toggleFromPopup() {
    enforcementEnabled = !enforcementEnabled;
    toast(enforcementEnabled
      ? '🔒 Candado de Surtido: ACTIVADO'
      : '🔓 Candado de Surtido: DESACTIVADO (hasta recargar)');
    return { enabled: enforcementEnabled };
  }

  function injectStyles() {
    if (document.getElementById('sa-sg-style')) return;
    const css = [
      '.sa-sg-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);',
      'z-index:2147483600;background:#1c2430;color:#e6e9ee;border:1px solid #2b3645;',
      'border-left:4px solid #13a36f;border-radius:10px;padding:12px 18px;font-size:14px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:80vw;}',
      '.sa-sg-toast.err{border-left-color:#e8513a;}'
    ].join('');
    const s = document.createElement('style');
    s.id = 'sa-sg-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    injectStyles();
    let el = document.getElementById('sa-sg-toast');
    if (!el) { el = document.createElement('div'); el.id = 'sa-sg-toast'; document.body.appendChild(el); }
    el.className = 'sa-sg-toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { const e = document.getElementById('sa-sg-toast'); if (e) e.remove(); }, 4000);
  }

  function init() {
    if (window.__saSurtidoGuardInit) return;
    window.__saSurtidoGuardInit = true;
    if (!isWorkboardPage()) return;
    injectStyles();
    console.log('[SA] SurtidoGuard init en', location.pathname);
    // patchFetch() / observer / decorateCards se agregan en Tasks 4–8.
  }

  return {
    init,
    isEnabled,
    toggleFromPopup,
    // Helpers internos expuestos para tasks posteriores y tests en vivo.
    _setIndex: (i) => { scheduleIndex = i; },
    _getIndex: () => scheduleIndex
  };
})();

if (typeof window !== 'undefined') {
  window.SurtidoGuard = SurtidoGuard;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SurtidoGuard.init());
  } else {
    SurtidoGuard.init();
  }
}
