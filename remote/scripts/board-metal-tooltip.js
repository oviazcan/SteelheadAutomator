// board-metal-tooltip.js — Enriquece el tooltip NATIVO del Scheduling board.
//
// Steelhead muestra un MUI Tooltip (<div role="tooltip" id="<id>"> con PN + <hr> +
// descripción) al hacer hover sobre el link del PN. Este módulo INYECTA dos líneas
// dentro de ESE popover (no crea uno propio → no se traslapa): "Metal base" y "PS"
// (Packing Slip del cliente). El <a> del PN apunta a su popover por aria-labelledby.
//
// Datos:
//   - Metal base: customInputs.DatosAdicionalesNP.BaseMetal del PN (GetPartNumber).
//   - PS: customInputs.DatosRecibo.PackingSlip del batch de la fila. El link da el
//     idInDomain del batch; cadena GetPartNumberInventoryBatch(idInDomain)→id→GetInventoryBatch(id).
//     Varios batches en la fila → PS concatenados con ", ".
//
// CARGA / rendimiento (importante — Steelhead reportó lentitud con el prefetch agresivo):
//   NO hay prefetch masivo. Las queries se disparan SOLO cuando el popover nativo
//   aparece (= hover real del usuario sobre un PN), nunca al hacer scroll. Así el
//   tráfico a /graphql es proporcional a las partes que el usuario realmente inspecciona
//   (unas pocas por sesión), no a las ~1767 del board. El cache hace instantáneo el
//   re-hover. SteelheadAPI.query usa fetch propio (no toca el Apollo del host).
//   suppressNativeTitle es DOM puro (sin red).
//
// Depende de: SteelheadAPI. Expone window.BoardMetalTooltip.

const BoardMetalTooltip = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;

  const CACHE_CAP = 1500;        // tope FIFO (strings cortos; on-demand, crece despacio)
  const metalCache = new Map();  // pnId -> string | Promise<string>
  const psCache = new Map();     // batchIdInDomain -> string | Promise<string>

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

  // El link de la fila da el idInDomain del batch; GetInventoryBatch necesita el id INTERNO.
  // Cadena: GetPartNumberInventoryBatch(idInDomain) → inventoryBatchByIdInDomain.id → GetInventoryBatch(id).
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
  // tooltip nativo encima del popover MUI (recuadro oscuro redundante). Lo quitamos solo
  // si el title ES exactamente el texto del link (no toca titles legítimos de otras celdas).
  function suppressNativeTitle(a) {
    const holder = a.closest('[title]');
    if (holder && holder.getAttribute('title') === (a.textContent || '').trim()) {
      holder.removeAttribute('title');
    }
  }

  function batchIdsForAnchor(a) {
    const row = a.closest('tr, [role="row"], [data-index]');
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

  // ── inyección en el popover MUI de Steelhead (on-demand: al aparecer el popover) ──
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

  // Suprime el title nativo de los PN anchors de un subárbol (DOM puro, sin red).
  function suppressTitlesIn(root) {
    const scope = (root && root.querySelectorAll) ? root : document;
    scope.querySelectorAll('a[href*="/PartNumbers/"]').forEach(suppressNativeTitle);
  }

  // ── observer único: inyecta tooltips (on-hover) + suprime title nativo (DOM) ──
  let observer = null;
  let lastPath = location.pathname;

  function onMutations(muts) {
    if (location.pathname !== lastPath) { lastPath = location.pathname; metalCache.clear(); psCache.clear(); }
    if (!isBoardPage()) return;
    let sawPopover = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('div[role="tooltip"]') || n.querySelector?.('div[role="tooltip"]')) sawPopover = true;
        if (n.matches?.('a[href*="/PartNumbers/"]')) suppressNativeTitle(n);
        else if (n.querySelector?.('a[href*="/PartNumbers/"]')) suppressTitlesIn(n);
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
    if (isBoardPage()) suppressTitlesIn(document); // limpia titles visibles iniciales (sin red)
  }

  if (typeof window !== 'undefined') {
    window.BoardMetalTooltip = { init };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  return { init };
})();
