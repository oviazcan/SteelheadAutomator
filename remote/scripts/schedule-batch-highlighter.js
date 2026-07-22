// Resaltar Lote en Programación — glue (DOM). Consume schedule-batch-highlighter-core.js.
// Panel flotante dark-mode en el Schedule Board (/Schedules/<id>/ScheduleBoard/<id>): tecleas un
// NOMBRE de lote y RESALTA las filas cuyo "Received Batches" coincide (todas las homónimas, lo que
// el filtro nativo no puede) y MARCA su checkbox, para verlas de un vistazo recorriendo la lista.
//
// NO filtra ni oculta filas (workaround del bug del filtro nativo, que es client-side y esconde los
// lotes homónimos). Como la tabla VIRTUALIZA, solo alcanza las filas presentes en el DOM; el panel
// AVISA que hay que hacer scroll para marcar/resaltar todas.
//
// Detección de la columna "Received Batches" por ALINEACIÓN X del header (robusta ante sticky
// headers en tabla separada y ante virtualización) — no depende de un índice de columna fijo.
//
// Panel FLOTANTE (position:fixed en document.body), NO inyectado en el header de React: insertar
// entre los hijos de un contenedor React del board disparaba reconciliaciones que congelaban la SPA.
// Estado singleton en window.__saSBH (injectAppScripts re-evalúa el IIFE en cada acción del popup).
(function () {
  'use strict';

  const Core = window.ScheduleBatchHighlighterCore;
  if (!Core) { console.warn('[schedule-batch-highlighter] core ausente'); return; }

  const PANEL_ID = 'sa-sbh-panel';
  const STYLE_ID = 'sa-sbh-style';
  const HL_CLASS = 'sa-sbh-hl';        // clase marcadora en filas/celdas resaltadas
  const DEBOUNCE_MS = 250;

  const S = (window.__saSBH = window.__saSBH || {
    query: '',
    checkedByUs: null,   // Set<HTMLInputElement> — checkboxes que marcamos nosotros (para des-marcar al limpiar)
    timer: null,
    obs: null,
  });
  if (!S.checkedByUs) S.checkedByUs = new Set();

  // ── estilos (una vez) ──
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #${PANEL_ID}{position:fixed;top:70px;right:16px;z-index:2147483600;background:#1c2430;color:#e6e9ee;
        border:1px solid #33404f;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.55);
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;width:250px;padding:10px 11px;}
      #${PANEL_ID} .sa-sbh-title{color:#f0f3f7;font-weight:600;font-size:12px;margin-bottom:7px;display:flex;align-items:center;gap:6px;}
      #${PANEL_ID} .sa-sbh-title .sa-sbh-x{margin-left:auto;cursor:pointer;color:#9aa7b5;font-weight:400;}
      #${PANEL_ID} .sa-sbh-title .sa-sbh-x:hover{color:#e6e9ee;}
      #${PANEL_ID} input.sa-sbh-inp{width:100%;box-sizing:border-box;background:#141a23;color:#e6e9ee;
        border:1px solid #3a4757;border-radius:6px;padding:6px 8px;font-size:12px;outline:none;}
      #${PANEL_ID} input.sa-sbh-inp:focus{border-color:#13a36f;}
      #${PANEL_ID} input.sa-sbh-inp::placeholder{color:#7f8b99;}
      #${PANEL_ID} .sa-sbh-count{margin-top:7px;color:#13a36f;font-weight:600;}
      #${PANEL_ID} .sa-sbh-scroll{margin-top:7px;background:#3a2a1c;border:1px solid #6b4a2e;color:#f0a35e;
        border-radius:6px;padding:5px 7px;font-size:11px;line-height:1.35;}
      #${PANEL_ID} .sa-sbh-clear{margin-top:8px;width:100%;background:#1c2430;color:#9aa7b5;border:1px solid #33404f;
        border-radius:6px;padding:6px;font-size:12px;cursor:pointer;}
      #${PANEL_ID} .sa-sbh-clear:hover{color:#e6e9ee;border-color:#13a36f;}
      tr.${HL_CLASS} > td{background:#173a2b !important;}
      td.${HL_CLASS}{outline:2px solid #13a36f !important;outline-offset:-2px;}
    `;
    document.head.appendChild(st);
  }

  // ── detección de la columna Received Batches por alineación X del header ──
  // El header de esta tabla (MUI CSS-grid) es un <td> y el texto vive en un <strong> hoja:
  //   <thead><tr class="MuiTableRow-head"><td><div><strong>Received Batches</strong></div></td>
  // Por eso el selector debe incluir strong/b/a/td además de div/span/th, y matchear el NODO HOJA.
  function getRBHeaderCentersX() {
    const leaves = Array.from(document.querySelectorAll('th,td,[role="columnheader"],div,span,strong,b,a,p,label'))
      .filter((e) => e.children.length === 0 && /Received\s*Batch/i.test(e.textContent || '') && (e.textContent || '').trim().length < 25);
    const centers = [];
    const seen = new Set();
    for (const leaf of leaves) {
      // Sube a la CELDA header (td/th) — su ancho/posición = la columna del grid, igual que la celda
      // de datos. El <strong> hoja solo mide el texto (más angosto) y desalinearía la comparación.
      const cell = leaf.closest('th,td,[role="columnheader"]') || leaf;
      if (seen.has(cell)) continue;
      seen.add(cell);
      const r = cell.getBoundingClientRect();
      if (r.width > 0) centers.push(r.left + r.width / 2);
    }
    return centers;
  }

  // Celda "Received Batches" de una fila = la celda cuyo centro X está más cerca de un header RB.
  function rbCellForRow(row, centersX) {
    let best = null, bestDist = Infinity;
    for (const cell of row.children) {
      const r = cell.getBoundingClientRect();
      if (r.width === 0) continue;
      const cx = r.left + r.width / 2;
      for (const hx of centersX) {
        const d = Math.abs(cx - hx);
        if (d < bestDist) { bestDist = d; best = cell; }
      }
    }
    return bestDist < 60 ? best : null; // tolerancia ~media columna; si no alinea, fail-safe (null)
  }

  function taskRows() {
    const rows = [];
    for (const t of document.querySelectorAll('table.MuiTable-root')) {
      for (const tr of t.querySelectorAll('tbody tr')) rows.push(tr);
    }
    return rows;
  }

  // ── aplicar resaltado + marcado a las filas VISIBLES que coinciden ──
  function apply() {
    const name = S.query;
    clearVisualOnly(); // limpia resaltado previo (no toca checkboxes que ya pusimos)
    if (!name) { renderCount(0); return; }
    const centersX = getRBHeaderCentersX();
    if (!centersX.length) { renderCount(0, true); return; } // sin header → no marcar nada (fail-safe)
    let matched = 0;
    for (const tr of taskRows()) {
      const cell = rbCellForRow(tr, centersX);
      if (!cell) continue;
      if (!Core.rowMatchesBatchName(cell.textContent, name)) continue;
      matched++;
      tr.classList.add(HL_CLASS);
      cell.classList.add(HL_CLASS);
      // marcar checkbox (1a celda) si aún no está marcado
      const cb = tr.children[0] && tr.children[0].querySelector('input[type="checkbox"]');
      if (cb && !cb.checked) { cb.click(); S.checkedByUs.add(cb); }
    }
    renderCount(matched);
  }

  function clearVisualOnly() {
    for (const el of document.querySelectorAll('.' + HL_CLASS)) el.classList.remove(HL_CLASS);
  }

  // ── limpiar todo: resaltado + des-marcar SOLO los checkboxes que pusimos nosotros ──
  function clearAll() {
    clearVisualOnly();
    for (const cb of S.checkedByUs) {
      try { if (cb.checked && document.contains(cb)) cb.click(); } catch (_) {}
    }
    S.checkedByUs.clear();
    const inp = document.querySelector('#' + PANEL_ID + ' .sa-sbh-inp');
    if (inp) inp.value = '';
    S.query = '';
    renderCount(0);
  }

  // ── panel ──
  function renderCount(n, noHeader) {
    const el = document.querySelector('#' + PANEL_ID + ' .sa-sbh-count');
    if (!el) return;
    if (noHeader) { el.textContent = 'No encuentro la columna "Received Batches".'; return; }
    el.textContent = S.query ? (n + ' marcada' + (n === 1 ? '' : 's') + ' (visibles)') : '';
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    injectStyles();
    const p = document.createElement('div');
    p.id = PANEL_ID;

    const title = document.createElement('div');
    title.className = 'sa-sbh-title';
    title.appendChild(document.createTextNode('🏷️ Resaltar lote'));
    const x = document.createElement('span');
    x.className = 'sa-sbh-x'; x.textContent = '✕'; x.title = 'Cerrar';
    x.addEventListener('click', () => { clearAll(); p.remove(); });
    title.appendChild(x);
    p.appendChild(title);

    const inp = document.createElement('input');
    inp.className = 'sa-sbh-inp';
    inp.type = 'text';
    inp.placeholder = 'Nombre de lote…';
    inp.setAttribute('aria-label', 'Resaltar tareas por nombre de lote');
    inp.addEventListener('input', () => {
      S.query = inp.value.trim();
      if (S.timer) clearTimeout(S.timer);
      S.timer = setTimeout(apply, DEBOUNCE_MS);
    });
    p.appendChild(inp);

    const count = document.createElement('div');
    count.className = 'sa-sbh-count';
    p.appendChild(count);

    const scroll = document.createElement('div');
    scroll.className = 'sa-sbh-scroll';
    scroll.textContent = '⚠️ Recorre la lista con scroll: la tabla solo carga las filas visibles, así que las de más abajo se resaltan y marcan conforme aparecen.';
    p.appendChild(scroll);

    const clr = document.createElement('button');
    clr.className = 'sa-sbh-clear';
    clr.type = 'button';
    clr.textContent = 'Limpiar (quita marcas)';
    clr.addEventListener('click', clearAll);
    p.appendChild(clr);

    document.body.appendChild(p);
  }

  // ── observer: re-aplica a las filas nuevas al scrollear / re-render (virtualización) ──
  function startObserver() {
    if (S.obs) return;
    S.obs = new MutationObserver(() => {
      if (!Core.isScheduleBoardUrl(location.pathname)) return;
      if (!S.query) return;
      if (S.timer) clearTimeout(S.timer);
      S.timer = setTimeout(apply, DEBOUNCE_MS);
    });
    S.obs.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() { if (S.obs) { S.obs.disconnect(); S.obs = null; } }

  // ── gate por URL + ciclo de vida ──
  function onUrlChange() {
    if (Core.isScheduleBoardUrl(location.pathname)) {
      buildPanel();
      startObserver();
    } else {
      stopObserver();
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove();
    }
  }
  function patchHistory() {
    if (window.__saSBHHistoryPatched) return;
    window.__saSBHHistoryPatched = true;
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); window.dispatchEvent(new Event('sa-sbh-url')); return r; };
    }
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('sa-sbh-url')));
    window.addEventListener('sa-sbh-url', onUrlChange);
  }

  function init() {
    patchHistory();
    onUrlChange();
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);

  window.ScheduleBatchHighlighter = { buildPanel, apply, clearAll };
})();
