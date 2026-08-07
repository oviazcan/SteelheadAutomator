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

  // Igual que pickCustomerFromSingleValues pero sobre las DOS formas en que SH pinta el
  // valor elegido de un react-select:
  //   a) <div class="…singleValue">NOMBRE (#N)</div>   — forma histórica
  //   b) <input role="combobox" value="NOMBRE (#N)">   — forma nueva (medida 2026-08-05)
  // El bug: SH migró el control de "Cliente:" a la forma (b) y el applet solo leía (a),
  // así que el cliente quedaba invisible. Los singleValue van PRIMERO para que la vía
  // histórica siga mandando si SH la repone; el badge "(#N)" sigue siendo el criterio.
  function pickCustomerFromCandidates(singleValueTexts, comboboxValues) {
    const sv = Array.isArray(singleValueTexts) ? singleValueTexts : [];
    const cb = Array.isArray(comboboxValues) ? comboboxValues : [];
    return pickCustomerFromSingleValues(sv.concat(cb));
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

  // El domainId sale de la ruta cuando estamos bajo /Domains/<id>/… (lista de OVs). En el
  // flujo de Recibo la URL es /Receiving/CustomerParts y NO lo trae: ahí lo pone el glue
  // desde `SteelheadAPI.getDomain().id`. Mismo patrón que po-listing-filters-core.
  function domainIdFromPath(pathname) {
    const m = /^\/Domains\/(\d+)(?:\/|$)/.exec(String(pathname == null ? '' : pathname));
    return m ? m[1] : null;
  }

  // Ficha del cliente en Steelhead: /Domains/<domainId>/Customers/<idInDomain>
  // (formato confirmado por el operador: .../Domains/344/Customers/6 para BRAININ (#6)).
  // Devuelve null si falta cualquiera de los dos → el panel muestra el aviso SIN liga en
  // vez de fabricar una URL que llevaría al cliente equivocado. No inventar el dominio es
  // el punto: un 344 hardcodeado mandaría a MTY a la ficha de TLC.
  function customerUrl(domainId, idInDomain) {
    if (domainId == null || domainId === '' || idInDomain == null || idInDomain === '') return null;
    if (!/^\d+$/.test(String(domainId)) || !/^\d+$/.test(String(idInDomain))) return null;
    return '/Domains/' + domainId + '/Customers/' + idInDomain;
  }

  // ¿El <select> ya quedó en la MISMA opción que elegiríamos para `target`?
  //
  // Bug 2026-08-06: el llenado elegía por `scoreOptionMatch` (substring: el cliente guarda
  // `"USD"` y la opción dice `"USD - Dólar americano"`, score 60) pero la comprobación de
  // "ya está bien" exigía **igualdad exacta** del texto. Con el poll re-escaneando, la
  // segunda pasada no reconocía su propio trabajo en Divisa, caía en la rama
  // "usuario tocó después de autofill" y el panel marcaba en ROJO un campo BIEN puesto.
  // Razón Social se salvaba de casualidad: ahí el cliente guarda el texto completo, así que
  // la igualdad exacta sí daba.
  //
  // La regla: **se verifica con la misma vara con la que se escribe.** Una comprobación más
  // estricta que la acción que verifica no protege, delata trabajo propio como ajeno.
  function isSelectAlreadyOnTarget(optionTexts, selectedIndex, target) {
    const m = scoreOptionMatch(optionTexts, target);
    return !!(m.pass && m.index === selectedIndex);
  }

  // ¿El heading es el del WIZARD de recepción que ENVUELVE al modal de OV?
  // En /Receiving/CustomerParts el modal "Crear Orden de Venta" nace con su campo
  // "Cliente:" VACÍO: el cliente real vive en el wizard padre, FUERA del [role=dialog]
  // del modal. Regex bilingüe reusada de weight-quick-entry, que ya ancla ese mismo
  // wizard en producción en esta pantalla.
  function isReceiveWizardHeading(text) {
    return /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i
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

  // ¿Qué hay que encender/apagar al evaluar la ruta actual?
  //
  // Bug MEDIDO en producción el 2026-08-07 (/Domains/344/SalesOrders): el poll de
  // re-detección arrancaba en la PRIMERA visita y ya no volvía nunca. `setupObserver()`
  // hacía `if (observerActive) return` antes de `startDetectPoll()`, y como el observer
  // no se desconectaba al salir, el latch seguía en `true` al regresar ⇒ el `startDetectPoll()`
  // quedaba inalcanzable. Sonda en vivo: **4 ticks / 3.5 s** en la primera visita, **0 al
  // volver** por navegación SPA. Sin poll, el applet cuelga del MutationObserver, que en esa
  // pantalla despierta **una sola vez** —al montarse el modal, o sea ANTES de que el operador
  // elija cliente— así que el autofill ya no vuelve a mirar.
  //
  // La decisión sale aquí, pura, en vez de vivir en tres `if` repartidos por el glue: cada
  // recurso (observer, poll) se enciende por SU PROPIO estado, no por el del vecino.
  function lifecycleActions(st) {
    const routeMatches = !!(st && st.routeMatches);
    if (!routeMatches) {
      return { observer: 'disconnect', poll: 'stop', resetSignature: true, removePanel: true, scan: false };
    }
    return {
      observer: (st && st.observerConnected) ? 'keep' : 'connect',
      poll: (st && st.pollRunning) ? 'keep' : 'start',
      resetSignature: false,
      removePanel: false,
      scan: true
    };
  }

  // ¿Qué reportar de un campo que sale del cliente? Devuelve `null` cuando SÍ hay valor
  // ("procede a llenar"), o el resultado que va al panel.
  //
  // Bug: un fallo al LEER al cliente (timeout de 90 s, 5xx, red caída) se reportaba idéntico
  // a "el cliente no tiene el dato" — panel ámbar acusando al catálogo, con liga para ir a
  // capturar algo que ya estaba capturado. En equipos lentos o con red de planta ese es el
  // camino frecuente, no el excepcional. **Un dato que no pudimos leer no es un dato ausente.**
  function customerFieldResult(value, fetchError, fieldName) {
    if (fetchError) {
      return { ok: false, needsSetup: false, retry: true, msg: `no pude leer al cliente (${fetchError}) — reintentando` };
    }
    if (!value) {
      return { ok: false, needsSetup: true, msg: `el cliente no tiene DatosFactura.${fieldName}` };
    }
    return null;
  }

  // Corolario del anterior en el CACHÉ: un `null` por fallo de red se guardaba por
  // idInDomain y envenenaba el resto de la sesión — ni cerrando y reabriendo el modal se
  // recuperaba, porque el segundo intento leía el veneno en vez de reintentar.
  function cacheableCustomerResult(customer, fetchError) {
    return !fetchError;
  }

  const api = {
    normalizeForMatch,
    cleanCustomerName,
    extractCustomerIdInDomain,
    pickCustomerFromSingleValues,
    pickCustomerFromCandidates,
    scoreOptionMatch,
    isSelectAlreadyOnTarget,
    isCreateOrderModalHeading,
    isReceiveWizardHeading,
    domainIdFromPath,
    customerUrl,
    matchesCreateOrderUrl,
    isDialogRootClass,
    lifecycleActions,
    customerFieldResult,
    cacheableCustomerResult
  };
  if (typeof window !== 'undefined') window.CreateOrderAutofillCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
