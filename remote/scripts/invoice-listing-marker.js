// Invoice Listing Marker
// Marca visualmente filas del listado de facturas (/Domains/{N}/Invoices...) según:
//   - Monto cero → fondo rojo sutil + chip "Monto Cero"
//   - Monto negativo (Nota de Crédito) → fondo amarillo sutil + chip "Nota de Crédito"
//   - Sin botón de cancelación (Edit Invoice icon) → chip "Borrador"
//     (independiente: aplica a facturas, NC y montos cero por igual)
//
// El total negativo en este listado viene en formato contable: "Total: ($1,234.56)".
// El indicador de borrador es la presencia del icono Edit Invoice en lugar del
// icono "Send cancellation request to Contpaq E".

const InvoiceListingMarker = (() => {
  'use strict';

  const LOG_PREFIX = '[InvoiceListingMarker]';
  const URL_RE = /\/Domains\/\d+\/Invoices(?:\/|\?|$)/;
  const ROW_LINK_RE = /\/Domains\/\d+\/Invoices\/\d+/;
  const TOTAL_RE = /total\s*:\s*(\(\s*)?-?\$?-?\s*([\d,]+(?:\.\d+)?)\s*(\))?/i;

  const COLOR_ZERO_BG = 'rgba(244, 67, 54, 0.20)';
  const COLOR_NC_BG = 'rgba(255, 193, 7, 0.32)';

  const CHIP_STYLE = {
    base: 'display:inline-block;font-size:10px;font-weight:600;padding:1px 7px;border-radius:10px;letter-spacing:0.3px;text-transform:uppercase;line-height:14px;vertical-align:middle;',
    zero: 'background:#f44336;color:#fff;',
    nc: 'background:#ffb300;color:#3a2300;',
    draft: 'background:#607d8b;color:#fff;',
  };

  let enabled = true;
  let observer = null;
  let scanScheduled = false;

  function shouldRun() {
    return URL_RE.test(location.pathname + location.search);
  }

  function findRows() {
    const headers = document.querySelectorAll('.css-15vf43d');
    const rows = [];
    for (const header of headers) {
      const link = header.querySelector('a[href*="/Invoices/"]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      if (!ROW_LINK_RE.test(href)) continue;
      const row = findRowContainer(header);
      if (!row) continue;
      rows.push({ row, header, link, href });
    }
    return rows;
  }

  function findRowContainer(header) {
    let cur = header.parentElement;
    let depth = 0;
    while (cur && depth < 6) {
      const style = cur.getAttribute('style') || '';
      if (style.includes('padding: 15px') && style.includes('border-bottom')) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function parseTotal(row) {
    const candidates = row.querySelectorAll('div');
    for (const div of candidates) {
      const txt = (div.textContent || '').trim();
      if (!/total\s*:/i.test(txt)) continue;
      if (!/terms\s*:|t[eé]rminos\s*:/i.test(txt)) continue;
      const m = txt.match(TOTAL_RE);
      if (!m) continue;
      const isParenNegative = !!(m[1] && m[3]);
      const hasMinus = /total\s*:\s*-?\$?\s*-/i.test(txt) || /-\$/i.test(txt);
      const num = parseFloat(m[2].replace(/,/g, ''));
      if (!isFinite(num)) continue;
      const signed = isParenNegative || hasMinus ? -Math.abs(num) : num;
      return signed;
    }
    return null;
  }

  function isDraft(row) {
    return !!row.querySelector('svg[data-testid="EditIcon"], [aria-label="Edit Invoice"]');
  }

  function clearMarks(row, header) {
    row.style.backgroundColor = '';
    const existing = header.querySelector(':scope > .sa-ilm-chips');
    if (existing) existing.remove();
    const stale = header.parentElement && header.parentElement.querySelector(':scope > .sa-ilm-chips');
    if (stale) stale.remove();
    delete row.dataset.saIlmState;
  }

  function applyMarks(row, header, total, draft) {
    const isZero = total === 0;
    const isNC = total < 0;
    const state = `${total}|${draft ? 1 : 0}|${isZero ? 'z' : isNC ? 'nc' : 'p'}`;
    if (row.dataset.saIlmState === state) return;
    row.dataset.saIlmState = state;

    if (isZero) row.style.backgroundColor = COLOR_ZERO_BG;
    else if (isNC) row.style.backgroundColor = COLOR_NC_BG;
    else row.style.backgroundColor = '';

    const stale = header.parentElement && header.parentElement.querySelector(':scope > .sa-ilm-chips');
    if (stale) stale.remove();

    let chipsContainer = header.querySelector(':scope > .sa-ilm-chips');
    if (!chipsContainer) {
      chipsContainer = document.createElement('div');
      chipsContainer.className = 'sa-ilm-chips';
      chipsContainer.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;line-height:1;';
      header.appendChild(chipsContainer);
    }
    chipsContainer.innerHTML = '';

    if (isZero) chipsContainer.appendChild(makeChip('Monto Cero', CHIP_STYLE.zero));
    if (isNC) chipsContainer.appendChild(makeChip('Nota de Crédito', CHIP_STYLE.nc));
    if (draft) chipsContainer.appendChild(makeChip('Borrador', CHIP_STYLE.draft));

    if (!isZero && !isNC && !draft) chipsContainer.remove();
  }

  function makeChip(text, colorStyle) {
    const span = document.createElement('span');
    span.className = 'sa-ilm-chip';
    span.style.cssText = CHIP_STYLE.base + colorStyle;
    span.textContent = text;
    return span;
  }

  function scan() {
    scanScheduled = false;
    if (!enabled || !shouldRun()) return;
    const rows = findRows();
    for (const { row, header } of rows) {
      const total = parseTotal(row);
      if (total === null) continue;
      const draft = isDraft(row);
      applyMarks(row, header, total, draft);
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => setTimeout(scan, 80));
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function patchHistoryNav() {
    if (window.__saIlmHistoryPatched) return;
    window.__saIlmHistoryPatched = true;
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function () { _push.apply(this, arguments); scheduleScan(); };
    history.replaceState = function () { _replace.apply(this, arguments); scheduleScan(); };
    window.addEventListener('popstate', scheduleScan);
  }

  function init() {
    enabled = document.documentElement.dataset.saInvoiceListingMarkerEnabled !== 'false';
    if (!enabled) { console.log(LOG_PREFIX, 'Deshabilitado'); return; }
    if (window.__saIlmInitDone) { console.log(LOG_PREFIX, 'Ya inicializado — skip'); return; }
    window.__saIlmInitDone = true;
    patchHistoryNav();
    startObserver();
    scheduleScan();
    console.log(LOG_PREFIX, 'Inicializado');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.InvoiceListingMarker = InvoiceListingMarker;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => InvoiceListingMarker.init());
  } else {
    InvoiceListingMarker.init();
  }
}
