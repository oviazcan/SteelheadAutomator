// packing-slip-print.js — cose la remisión + los archivos seleccionados en UN
// PDF y lo manda a imprimir con un solo diálogo.
// Depende de: pdf-lib (window.PDFLib)
//
// ── POR QUÉ COSER Y NO IMPRIMIR UNO POR UNO ──────────────────────────────────
// Con 88 NP en una remisión real de Fisher (medido) serían decenas de diálogos
// que el operador tendría que confirmar a mano.
//
// ── POR QUÉ pdf-lib Y NO RASTERIZAR CON EL pdf.js QUE YA ESTÁ ────────────────
// Rasterizar (renderizar cada página a canvas) degrada justo las cotas finas de
// los planos, que es precisamente lo que el cliente exige impreso. pdf.js LEE;
// pdf-lib ESCRIBE y cose. Son complementarias, no redundantes.
const PackingSlipPrint = (() => {
  'use strict';
  const LOG = '[SA][planos-remision][print]';

  async function fetchBytes(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // Una imagen por página, escalada a CARTA (612×792 pt) respetando la relación
  // de aspecto y centrada.
  function addImagePage(doc, img) {
    const PW = 612, PH = 792, M = 18;
    const page = doc.addPage([PW, PH]);
    const scale = Math.min((PW - M * 2) / img.width, (PH - M * 2) / img.height);
    const w = img.width * scale, h = img.height * scale;
    page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
  }

  // Iframe oculto + print(). Mismo patrón ya probado en wo-listing-columns para
  // las etiquetas de OT, con su fallback a pestaña si SH bloquea el enmarcado.
  function sendToPrinter(bytes) {
    return new Promise((resolve) => {
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText =
        'position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0;opacity:0;pointer-events:none;';
      iframe.src = url;
      iframe.onload = () => {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch (e) {
          console.warn(LOG, 'iframe bloqueado, abro pestaña:', e && e.message);
          window.open(url, '_blank');
        }
        // El objectURL no se revoca de inmediato: el diálogo de impresión sigue
        // leyendo del blob mientras está abierto.
        setTimeout(() => {
          try { iframe.remove(); URL.revokeObjectURL(url); } catch (_) {}
        }, 60000);
        resolve();
      };
      iframe.onerror = () => { window.open(url, '_blank'); resolve(); };
      document.body.appendChild(iframe);
    });
  }

  // Devuelve { ok, missing[] }. `missing` son los archivos que no se pudieron
  // incorporar: se REPORTAN, nunca se omiten en silencio. Imprimir de menos sin
  // decirlo es el modo de falla que este applet existe para evitar.
  async function printCombined(opts) {
    const packingSlipPdfUrl = opts && opts.packingSlipPdfUrl;
    const files = (opts && opts.files) || [];
    if (!window.PDFLib) throw new Error('pdf-lib no está cargado (revisa config.scripts del applet)');
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    const missing = [];

    // 1) La remisión va PRIMERO. Si falla, se sigue con los archivos y se avisa.
    if (packingSlipPdfUrl) {
      try {
        const src = await PDFDocument.load(await fetchBytes(packingSlipPdfUrl));
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch (e) {
        missing.push({ name: 'la remisión', reason: (e && e.message) || 'error' });
        console.warn(LOG, 'no pude incorporar la remisión:', e && e.message);
      }
    } else {
      missing.push({ name: 'la remisión', reason: 'no encontré su PDF en el modal' });
    }

    // 2) Los archivos, en el orden del panel (agrupados por NP).
    for (const f of files) {
      const shown = (f && f.displayName) || '(sin nombre)';
      try {
        const bytes = await fetchBytes(f.url);
        if (/\.pdf$/i.test(shown)) {
          const src = await PDFDocument.load(bytes);
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        } else if (/\.jpe?g$/i.test(shown)) {
          addImagePage(out, await out.embedJpg(bytes));
        } else if (/\.png$/i.test(shown)) {
          addImagePage(out, await out.embedPng(bytes));
        } else {
          missing.push({ name: shown, reason: 'formato no imprimible' });
        }
      } catch (e) {
        missing.push({ name: shown, reason: (e && e.message) || 'error' });
        console.warn(LOG, 'no pude incorporar', shown, e && e.message);
      }
    }

    if (!out.getPageCount()) return { ok: false, missing };
    await sendToPrinter(await out.save());
    return { ok: true, missing };
  }

  return { printCombined };
})();

if (typeof window !== 'undefined') window.PackingSlipPrint = PackingSlipPrint;
