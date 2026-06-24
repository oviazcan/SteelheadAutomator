// board-metal-tooltip.js — Enriquece el tooltip NATIVO del Scheduling board.
//
// Steelhead muestra un MUI Tooltip (<div role="tooltip" id="<id>"> con PN + <hr> +
// descripción) al hacer hover sobre el link del PN. Antes este applet creaba SU PROPIO
// tooltip (.sa-bmt-tip) que se ENCIMABA sobre el de Steelhead (3 recuadros traslapados).
// Ahora NO crea uno propio: INYECTA dos líneas dentro del popover de Steelhead, así nunca
// se traslapa. El <a> del PN apunta a su popover por aria-labelledby="<id>" → id del div.
//
// Datos inyectados:
//   - Metal base: customInputs.DatosAdicionalesNP.BaseMetal del PN (GetPartNumber, usagesLimit:0).
//   - PS (Packing Slip del cliente): customInputs.DatosRecibo.PackingSlip del batch de la fila
//     (GetInventoryBatch). El batchId sale del link /Inventory/Batches/<id> de la MISMA fila.
//     Si la fila tuviera varios batches, los PS se concatenan con ", ".
// Ambos se cachean y se PRECARGAN en background (filas visibles + las que entran al viewport
// al hacer scroll) para que el dato ya esté listo cuando aparezca el tooltip.
//
// Memory: SteelheadAPI.query usa fetch() PROPIO (no el Apollo client del host), así que estas
// respuestas NO entran al InMemoryCache del host → NO se usa apolloCacheDrain (rompería el board
// que el usuario está usando). Es un applet PASIVO co-residente: no detiene Datadog ni corre
// mem-monitor con modal de reload (eso es para runs intensivos con panel). Hardening propio:
// slim responses (solo se guarda el string, el objeto GraphQL se descarta), caches topados (FIFO)
// y limpieza al cambiar de board. (Ver docs/applets/auto-router.md.)
//
// Depende de: SteelheadAPI. Expone window.BoardMetalTooltip.

const BoardMetalTooltip = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;

  const CACHE_CAP = 3000;           // tope FIFO de cada cache (strings cortos)
  const MAX_CONC = 4;               // concurrencia del prefetch
  const metalCache = new Map();     // pnId -> string | Promise<string>
  const psCache = new Map();        // batchId -> string | Promise<string>

  function capPut(map, key, val) {
    if (!map.has(key) && map.size >= CACHE_CAP) map.delete(map.keys().next().value);
    map.set(key, val);
  }

  function isBoardPage() {
    return /\/Schedules\/\d+\/ScheduleBoard\/\d+/i.test(location.pathname);
  }

  // ── extracción de datos (slim: solo el string que se muestra) ──
  function metalFromCI(ci) {
    let o = ci; if (typeof ci === 'string') { try { o = JSON.parse(ci); } catch { o = {}; } }
    return (o && o.DatosAdicionalesNP && o.DatosAdicionalesNP.BaseMetal) || '';
  }
  function psFromCI(ci) {
    let o = ci; if (typeof ci === 'string') { try { o = JSON.parse(ci); } catch { o = {}; } }
    return (o && o.DatosRecibo && o.DatosRecibo.PackingSlip) || '';
  }

  function getMetal(pnId) {
    if (metalCache.has(pnId)) return metalCache.get(pnId);
    const p = api().query('GetPartNumber', { partNumberId: Number(pnId), usagesLimit: 0, usagesOffset: 0 })
      .then((d) => { const m = metalFromCI(d?.partNumberById?.customInputs); capPut(metalCache, pnId, m); return m; })
      .catch(() => { capPut(metalCache, pnId, ''); return ''; });
    capPut(metalCache, pnId, p);
    return p;
  }

  // El link de la fila da el idInDomain del batch (ej. 7053), pero GetInventoryBatch (que trae
  // el PackingSlip) necesita el id INTERNO. Cadena de 2 pasos:
  //   GetPartNumberInventoryBatch(idInDomain) → inventoryBatchByIdInDomain.id → GetInventoryBatch(id).
  function getPS(idInDomain) {
    if (psCache.has(idInDomain)) return psCache.get(idInDomain);
    const p = api().query('GetPartNumberInventoryBatch', { idInDomain: Number(idInDomain) })
      .then((d) => {
        const internalId = d?.inventoryBatchByIdInDomain?.id;
        if (!internalId) return '';
        return api().query('GetInventoryBatch', { id: Number(internalId), limit: 10, offset: 0 })
          .then((d2) => psFromCI(d2?.inventoryBatchById?.customInputs));
      })
      .then((s) => { capPut(psCache, idInDomain, s || ''); return s || ''; })
      .catch(() => { capPut(psCache, idInDomain, ''); return ''; });
    capPut(psCache, idInDomain, p);
    return p;
  }

  // ── DOM helpers ──
  const PN_RE = /\/PartNumbers\/(\d+)/;
  const BATCH_RE = /\/Inventory\/Batches\/(\d+)/;

  function pnIdFromAnchor(a) {
    const m = (a.getAttribute('href') || '').match(PN_RE);
    return m ? m[1] : null;
  }

  // La celda lleva un title= con el MISMO texto del link → el navegador lo muestra como
  // tooltip nativo encima del popover MUI (el recuadro oscuro redundante). Lo quitamos: el
  // valor ya se ve en el link y, para el PN, en el popover enriquecido. Solo si el title
  // ES exactamente el texto del link (no toca titles legítimos de otras celdas).
  function suppressNativeTitle(a) {
    const holder = a.closest('[title]');
    if (holder && holder.getAttribute('title') === (a.textContent || '').trim()) {
      holder.removeAttribute('title');
    }
  }
  function rowOf(el) {
    return el.closest('tr, [role="row"], [data-index]');
  }
  function batchIdsForAnchor(a) {
    const row = rowOf(a);
    if (!row) return [];
    const ids = [];
    row.querySelectorAll('a[href*="/Inventory/Batches/"]').forEach((b) => {
      const m = (b.getAttribute('href') || '').match(BATCH_RE);
      if (m) ids.push(m[1]);
    });
    return [...new Set(ids)];
  }
  function psForRow(batchIds) {
    if (!batchIds.length) return Promise.resolve('');
    return Promise.all(batchIds.map(getPS)).then((a) => a.filter(Boolean).join(', '));
  }

  // ── inyección en el popover MUI de Steelhead ──
  function anchorForPopover(pop) {
    const id = pop.id;
    if (!id) return null;
    try { return document.querySelector('a[aria-labelledby="' + id + '"][href*="/PartNumbers/"]'); }
    catch { return null; }
  }

  function mkRow(label) {
    const p = document.createElement('p');
    p.className = 'sa-bmt-row';
    p.style.cssText = 'margin:3px 0 0;font-size:0.92em;line-height:1.25;';
    const lab = document.createElement('span');
    lab.textContent = label + ': ';
    lab.style.opacity = '0.65';
    const b = document.createElement('b');
    b.className = 'sa-bmt-val';
    b.textContent = '…';
    p.appendChild(lab); p.appendChild(b);
    return p;
  }
  function setVal(row, val) {
    const b = row.querySelector('.sa-bmt-val');
    if (b) b.textContent = val; // textContent → anti-XSS (datos de Steelhead)
  }

  function enrichPopover(pop) {
    if (!isBoardPage()) return;
    const a = anchorForPopover(pop);
    if (!a) return; // no es el tooltip de un PN
    const pnId = pnIdFromAnchor(a);
    if (!pnId) return;
    const inner = pop.querySelector('.MuiTooltip-tooltip') || pop;
    // idempotencia + staleness (MUI reusa el popper para distintos PN)
    if (inner.getAttribute('data-sa-pn') === pnId && inner.querySelector('.sa-bmt-row')) return;
    inner.querySelectorAll('.sa-bmt-row, .sa-bmt-sep').forEach((n) => n.remove());
    inner.setAttribute('data-sa-pn', pnId);

    const sep = document.createElement('hr');
    sep.className = 'sa-bmt-sep MuiDivider-root MuiDivider-fullWidth';
    sep.style.cssText = 'margin:4px 0 2px;opacity:.4;';
    const metalRow = mkRow('Metal base');
    const psRow = mkRow('PS');
    inner.appendChild(sep);
    inner.appendChild(metalRow);
    inner.appendChild(psRow);

    Promise.resolve(getMetal(pnId)).then((m) => {
      if (inner.getAttribute('data-sa-pn') !== pnId) return; // popper ya cambió de PN
      setVal(metalRow, m || '(sin dato)');
    });
    const batchIds = batchIdsForAnchor(a);
    if (batchIds.length) {
      psForRow(batchIds).then((s) => {
        if (inner.getAttribute('data-sa-pn') !== pnId) return;
        setVal(psRow, s || '(sin dato)');
      });
    } else {
      setVal(psRow, '(sin dato)');
    }
  }

  function scanPopovers() {
    document.querySelectorAll('div[role="tooltip"]').forEach((pop) => { try { enrichPopover(pop); } catch {} });
  }

  // ── prefetch (filas visibles + las que entran al viewport al hacer scroll) ──
  const prefetchSeen = new Set();
  const queue = [];
  let active = 0;

  function enqueue(a) {
    const pnId = pnIdFromAnchor(a);
    if (!pnId) return;
    const batchIds = batchIdsForAnchor(a);
    const key = pnId + '|' + batchIds.join(',');
    if (prefetchSeen.has(key)) return;
    if (prefetchSeen.size >= CACHE_CAP) prefetchSeen.clear();
    prefetchSeen.add(key);
    queue.push({ pnId, batchIds });
    pump();
  }
  function pump() {
    while (active < MAX_CONC && queue.length) {
      const job = queue.shift();
      active++;
      Promise.all([
        Promise.resolve(getMetal(job.pnId)).catch(() => {}),
        job.batchIds.length ? psForRow(job.batchIds).catch(() => {}) : Promise.resolve(),
      ]).finally(() => { active--; pump(); });
    }
  }
  function scanAnchors(root) {
    const scope = (root && root.querySelectorAll) ? root : document;
    scope.querySelectorAll('a[href*="/PartNumbers/"]').forEach((a) => { suppressNativeTitle(a); enqueue(a); });
  }

  // ── observer único (inyección de tooltips + prefetch) ──
  let observer = null;
  let lastPath = location.pathname;

  function resetForNavigation() {
    metalCache.clear(); psCache.clear(); prefetchSeen.clear(); queue.length = 0;
  }

  function onMutations(muts) {
    if (location.pathname !== lastPath) { lastPath = location.pathname; resetForNavigation(); }
    if (!isBoardPage()) return;
    let sawPopover = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('div[role="tooltip"]') || n.querySelector?.('div[role="tooltip"]')) sawPopover = true;
        if (n.matches?.('a[href*="/PartNumbers/"]')) { suppressNativeTitle(n); enqueue(n); }
        else if (n.querySelector?.('a[href*="/PartNumbers/"]')) scanAnchors(n);
      }
    }
    if (sawPopover) scanPopovers();
  }

  function init() {
    if (window.__saBmtInit) return;
    window.__saBmtInit = true;
    if (document.documentElement.dataset.saAutoRouterEnabled === 'false') return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    if (isBoardPage()) scanAnchors(document); // prefetch inicial de lo visible
  }

  if (typeof window !== 'undefined') {
    window.BoardMetalTooltip = { init };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  return { init };
})();
