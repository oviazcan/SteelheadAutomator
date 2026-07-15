// Create Order Autofill — módulo puro (sin DOM ni red).
// Lógica de selección/parseo del cliente y de matching de <option>. Consumido por
// create-order-autofill.js (glue) y por los tests (node --test).
//
// Por qué existe (bug 2026-07-03): el glue extraía el cliente con un label-walk
// frágil que hacía `return null` al toparse el input[role=combobox] del react-select
// ANTES de hallar el singleValue → "(sin cliente)" → "sin idInDomain" para TODOS los
// clientes en el modal "Crear Orden de Venta". El singleValue del Cliente es el ÚNICO
// del modal que trae el badge "(#N)" con el idInDomain (confirmado: CONTROLES...(#10)
// = idInDomain 10). Elegirlo por ese badge es label-independiente y robusto.
(function () {
  'use strict';

  function normalizeForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // El singleValue del react-select absorbe badges pegados sin whitespace
  // ("SCHNEIDER ELECTRIC MEXICO (#1)Industrial"). Cortamos tras "(#N)".
  function cleanCustomerName(raw) {
    if (!raw) return raw;
    const m = String(raw).match(/^(.+?\(#\d+\))/);
    if (m) return m[1].trim();
    return String(raw).trim();
  }

  // El sufijo "(#N)" del singleValue es el idInDomain (confirmado por el usuario,
  // no es un index local).
  function extractCustomerIdInDomain(rawName) {
    const m = String(rawName || '').match(/\(#(\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // De una lista de textos de singleValue (ya SIN avatar/svg), elige el del Cliente:
  // el único que trae el badge "(#N)". Devuelve { raw, name, idInDomain } o null.
  function pickCustomerFromSingleValues(texts) {
    if (!Array.isArray(texts)) return null;
    for (const t of texts) {
      const raw = String(t || '').trim();
      const id = extractCustomerIdInDomain(raw);
      if (id != null) return { raw, name: cleanCustomerName(raw), idInDomain: id };
    }
    return null;
  }

  // Matching de <option> por texto: exacto=100, substring=60, tokens (>2 chars)=+8 c/u.
  // Umbral de aceptación: score >= 60. optionTexts: array de strings (opt.text).
  // Devuelve { index, score, pass, text }. index es relativo a optionTexts.
  function scoreOptionMatch(optionTexts, target) {
    const targetNorm = normalizeForMatch(target);
    if (!targetNorm || !Array.isArray(optionTexts)) {
      return { index: -1, score: -1, pass: false, text: null };
    }
    let bestIdx = -1, bestScore = -1;
    for (let i = 0; i < optionTexts.length; i++) {
      const txt = String(optionTexts[i] || '').trim();
      if (!txt) continue;
      const norm = normalizeForMatch(txt);
      let score = 0;
      if (norm === targetNorm) score = 100;
      else if (norm.includes(targetNorm) || targetNorm.includes(norm)) score = 60;
      else {
        const tokens = targetNorm.split(' ').filter(t => t.length > 2);
        for (const t of tokens) { if (norm.includes(t)) score += 8; }
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return {
      index: bestIdx,
      score: bestScore,
      pass: !(bestIdx < 0 || bestScore < 60),
      text: bestIdx >= 0 ? String(optionTexts[bestIdx]) : null
    };
  }

  // ¿El texto de un heading corresponde al modal de creación de OV? Steelhead lo
  // rotula distinto según la pantalla que lo abre:
  //   - "Crear Orden de Venta"  (ES) — flujo /Receiving/CustomerParts (recibir piezas)
  //   - "Create Sales Order"    (EN) — flujo /Domains/<id>/SalesOrders ("New Sales Order")
  // Aceptamos ambos idiomas (mismos IDs RJSF debajo, así que el resto del applet reúsa).
  function isCreateOrderModalHeading(text) {
    return /^\s*(?:crear\s+orden\s+de\s+venta|create\s+sales\s+order)\s*$/i
      .test(String(text || '').trim());
  }

  // ¿La ruta (location.pathname, sin query) es una pantalla donde vive el modal de OV?
  //   - /Receiving/CustomerParts   — flujo original (recibir piezas del cliente)
  //   - /Domains/<id>/SalesOrders  — lista de Órdenes de Venta → botón "New Sales Order"
  function matchesCreateOrderUrl(pathname) {
    const p = String(pathname || '');
    // SalesOrders: anclado al final (con slash opcional) → solo la LISTA, no las páginas
    // de detalle de una OV (/Domains/<id>/SalesOrders/<n>). El modal "New Sales Order"
    // abre sobre la lista sin cambiar la URL (query en location.search, no en pathname).
    return /\/Receiving\/CustomerParts(?:\/|$)/.test(p)
      || /\/Domains\/\d+\/SalesOrders\/?$/.test(p);
  }

  // ¿La clase de un nodo denota el ROOT (paper/contenedor) de un MUI Dialog?
  // Bug 2026-07-03: getModalRoot() usaba `[class*="MuiDialog"]` arrancando en el heading
  // MISMO, cuya clase "MuiDialogTitle-root" contiene el substring "MuiDialog" → matcheaba
  // el TÍTULO vacío y nunca subía al paper con los campos. El título/contenido/acciones
  // (Title/Content/Actions) del diálogo NO son el root; solo el paper/contenedor lo es.
  function isDialogRootClass(className) {
    const cls = String(className || '');
    if (!cls.includes('MuiDialog')) return false;               // paper genérico/accordion → no
    if (/MuiDialog(Title|Content|Actions|ContentText)/.test(cls)) return false;  // subpartes → no
    return true;                                                 // MuiDialog-paper / -container → sí
  }

  const api = {
    normalizeForMatch,
    cleanCustomerName,
    extractCustomerIdInDomain,
    pickCustomerFromSingleValues,
    scoreOptionMatch,
    isCreateOrderModalHeading,
    matchesCreateOrderUrl,
    isDialogRootClass
  };
  if (typeof window !== 'undefined') window.CreateOrderAutofillCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
