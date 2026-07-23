// Resaltar Lote en Programación — glue (DOM). Consume schedule-batch-highlighter-core.js.
// Buscador INLINE en la barra de filtros nativa del Schedule Board, "donde terminan los filtros
// oficiales" (tras el último filtro de columna: PN/WO/Customer/Part Group/SO): tecleas un NOMBRE de
// lote y RESALTA las filas cuyo "Received Batches" coincide (todas las homónimas, lo que el filtro
// nativo no puede) y MARCA su checkbox, para verlas de un vistazo recorriendo la lista.
//
// NO filtra ni oculta filas (workaround del bug del filtro nativo, que es client-side y esconde los
// lotes homónimos). Como la tabla VIRTUALIZA, solo alcanza las filas presentes en el DOM; el aviso de
// scroll vive en el tooltip (title) del 🏷️ y del input, no en un bloque grande (para no ser intrusivo).
//
// El widget se ancla en la barra NATIVA (enriquecimiento de su UI, como board-metal-tooltip): estilo
// claro para integrarse a la barra, con acento VERDE (#13a36f) + emoji 🏷️ para que el operador
// reconozca de un vistazo que es de la extensión. Anclaje idioma-agnóstico: svg[data-testid=
// "FilterListIcon"] (no cambia por locale) → su <button> → contenedor de filtros; me inserto tras el
// ÚLTIMO div[role="button"] (SO), sin depender del texto del filtro.
//
// React puede re-renderizar la barra y borrar nuestro nodo → un MutationObserver lo RE-MONTA de forma
// idempotente (por id) además de re-aplicar el resaltado a las filas nuevas al scrollear.
//
// Detección de la columna "Received Batches" por ALINEACIÓN X del header (MUI CSS-grid; el header es
// un <strong> hoja dentro de un <td> — se mide el <td> ancestro, no el <strong>). Estado singleton en
// window.__saSBH (injectAppScripts re-evalúa el IIFE en cada acción del popup).
(function () {
  'use strict';

  const Core = window.ScheduleBatchHighlighterCore;
  if (!Core) { console.warn('[schedule-batch-highlighter] core ausente'); return; }

  const INLINE_ID = 'sa-sbh-inline';
  const STYLE_ID = 'sa-sbh-style';
  const HL_CLASS = 'sa-sbh-hl';        // clase marcadora en filas/celdas resaltadas
  const DEBOUNCE_MS = 250;
  const SCROLL_HINT = 'Consejo: primero ORDENA la tabla por la columna "Received Batches" (clic en su encabezado) para que los lotes con el mismo nombre queden juntos. Además, la tabla solo carga las filas visibles: recorre la lista con scroll para resaltar y marcar todas.';

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
      #${INLINE_ID}{display:inline-flex;align-items:center;gap:5px;margin-left:8px;
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;white-space:nowrap;}
      #${INLINE_ID} .sa-sbh-tag{font-size:14px;line-height:1;cursor:default;}
      #${INLINE_ID} input.sa-sbh-inp{width:118px;box-sizing:border-box;background:#fff;color:#1c2430;
        border:1.5px solid #13a36f;border-radius:6px;padding:3px 7px;font-size:12px;outline:none;}
      #${INLINE_ID} input.sa-sbh-inp:focus{border-color:#0e8659;box-shadow:0 0 0 2px rgba(19,163,111,.22);}
      #${INLINE_ID} input.sa-sbh-inp::placeholder{color:#9aa7b5;}
      #${INLINE_ID} .sa-sbh-count{font-size:12px;font-weight:700;color:#13a36f;min-width:10px;}
      #${INLINE_ID} .sa-sbh-count.warn{color:#d9822b;}
      #${INLINE_ID} .sa-sbh-info{cursor:help;color:#13a36f;font-size:13px;line-height:1;font-weight:700;}
      #${INLINE_ID} .sa-sbh-info:hover{color:#0e8659;}
      #${INLINE_ID} .sa-sbh-x{cursor:pointer;color:#9aa7b5;font-size:12px;line-height:1;padding:0 1px;}
      #${INLINE_ID} .sa-sbh-x:hover{color:#d9534f;}
      tr.${HL_CLASS} > td{background:#dbf3e7 !important;}
      td.${HL_CLASS}{outline:1.5px solid #13a36f !important;outline-offset:-2px;}
    `;
    document.head.appendChild(st);
  }

  // ── anclaje: barra de filtros de columna del Schedule Board ──
  // FilterListIcon (data-testid, estable ante idioma) → su <button> → contenedor (padre) de filtros.
  function findFilterBar() {
    const icon = document.querySelector('svg[data-testid="FilterListIcon"]');
    const btn = icon && icon.closest('button');
    return btn ? btn.parentElement : null;
  }

  // Monta (o re-monta) el buscador inline si falta. Idempotente por id.
  function ensureInlineMounted() {
    if (!Core.isScheduleBoardUrl(location.pathname)) return;
    if (document.getElementById(INLINE_ID)) return; // ya montado
    const bar = findFilterBar();
    if (!bar) return; // barra aún no renderizada
    const wrap = buildInline();
    // "donde terminan los filtros oficiales" = tras el ÚLTIMO div[role="button"] (SO), idioma-agnóstico.
    const roleBtns = bar.querySelectorAll(':scope > div[role="button"]');
    const anchor = roleBtns.length ? roleBtns[roleBtns.length - 1] : null;
    if (anchor) anchor.after(wrap); else bar.appendChild(wrap);
    // restaurar estado tras un re-montaje (React nos borró y el observer nos repuso)
    const inp = wrap.querySelector('.sa-sbh-inp');
    if (inp && S.query) { inp.value = S.query; scheduleApply(); }
  }

  function buildInline() {
    injectStyles();
    const wrap = document.createElement('span');
    wrap.id = INLINE_ID;

    const tag = document.createElement('span');
    tag.className = 'sa-sbh-tag';
    tag.textContent = '🏷️';
    tag.title = SCROLL_HINT;
    wrap.appendChild(tag);

    const inp = document.createElement('input');
    inp.className = 'sa-sbh-inp';
    inp.type = 'text';
    inp.placeholder = 'Resaltar lote…';
    inp.title = SCROLL_HINT;
    inp.setAttribute('aria-label', 'Resaltar tareas por nombre de lote');
    inp.addEventListener('input', () => { S.query = inp.value.trim(); scheduleApply(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    wrap.appendChild(inp);

    const count = document.createElement('span');
    count.className = 'sa-sbh-count';
    count.title = SCROLL_HINT;
    wrap.appendChild(count);

    const info = document.createElement('span');
    info.className = 'sa-sbh-info';
    info.textContent = 'ⓘ';
    info.title = SCROLL_HINT;
    info.setAttribute('aria-label', SCROLL_HINT);
    wrap.appendChild(info);

    const x = document.createElement('span');
    x.className = 'sa-sbh-x';
    x.textContent = '✕';
    x.title = 'Limpiar (quita las marcas que puso la extensión)';
    x.addEventListener('click', clearAll);
    wrap.appendChild(x);

    return wrap;
  }

  function scheduleApply() {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(apply, DEBOUNCE_MS);
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

  // ── limpiar todo: quita resaltado y DES-MARCA los checkboxes del lote ──
  // Dos vías porque la tabla VIRTUALIZA (recicla el DOM al scrollear): las referencias que guardamos
  // pueden quedar "muertas" (fuera del DOM) y su fila reciclada seguir marcada. Por eso, además de
  // des-marcar las referencias vivas, barremos las filas VISIBLES del lote y des-marcamos su checkbox
  // actual. (Limitación por virtualización: solo alcanza las visibles; recorre con scroll para el resto.)
  function clearAll() {
    const name = S.query;
    clearVisualOnly();
    // 1) referencias vivas que pusimos nosotros
    for (const cb of S.checkedByUs) {
      try { if (document.contains(cb) && cb.checked) cb.click(); } catch (_) {}
    }
    S.checkedByUs.clear();
    // 2) barrido robusto: filas visibles del lote (cubre las referencias recicladas por virtualización)
    if (name) {
      const centersX = getRBHeaderCentersX();
      if (centersX.length) {
        for (const tr of taskRows()) {
          const cell = rbCellForRow(tr, centersX);
          if (!cell || !Core.rowMatchesBatchName(cell.textContent, name)) continue;
          const cb = tr.children[0] && tr.children[0].querySelector('input[type="checkbox"]');
          try { if (cb && cb.checked) cb.click(); } catch (_) {}
        }
      }
    }
    const inp = document.querySelector('#' + INLINE_ID + ' .sa-sbh-inp');
    if (inp) inp.value = '';
    S.query = '';
    renderCount(0);
  }

  // ── contador (compacto) ──
  function renderCount(n, noHeader) {
    const el = document.querySelector('#' + INLINE_ID + ' .sa-sbh-count');
    if (!el) return;
    if (noHeader) {
      el.textContent = 'columna?';
      el.title = 'No encuentro la columna "Received Batches".';
      el.classList.add('warn');
      return;
    }
    el.classList.remove('warn');
    el.title = SCROLL_HINT;
    el.textContent = S.query ? String(n) : '';
  }

  // ── observer: re-monta el widget si React lo borra + re-aplica a filas nuevas (virtualización) ──
  function startObserver() {
    if (S.obs) return;
    S.obs = new MutationObserver(() => {
      if (!Core.isScheduleBoardUrl(location.pathname)) return;
      ensureInlineMounted();      // idempotente: repone el buscador si React lo quitó
      if (!S.query) return;
      scheduleApply();
    });
    S.obs.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() { if (S.obs) { S.obs.disconnect(); S.obs = null; } }

  function removeInline() {
    const w = document.getElementById(INLINE_ID);
    if (w) w.remove();
  }

  // ── gate por URL + ciclo de vida ──
  function onUrlChange() {
    if (Core.isScheduleBoardUrl(location.pathname)) {
      ensureInlineMounted();
      startObserver();
    } else {
      stopObserver();
      clearVisualOnly();
      removeInline();
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

  window.ScheduleBatchHighlighter = { ensureInlineMounted, apply, clearAll };
})();
