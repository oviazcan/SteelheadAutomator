// receive-modal-anchor-core.js — Núcleo PURO del anclaje de los campos que la extensión
// inyecta en el ENCABEZADO del modal "Recibir piezas del cliente" (Receive Parts from
// Customer): la fecha real de recibido (receiver-date-override) y la ubicación inicial
// (warehouse-location-prefill).
//
// ── POR QUÉ EXISTE (incidente 2026-08-03, reportado desde piso) ────────────────────────
// Los dos applets subían del <p> del label a su contenedor con `p.closest('.css-iyrxkt')`.
// `css-iyrxkt` es una clase GENERADA por emotion: su hash cambia cuando SH toca el estilo,
// sin aviso y sin que cambie nada visible ni el idioma. SH rehizo el encabezado —de un GRID
// de 2 columnas a una FILA flex con un wrapper por campo— y la clase dejó de existir
// (medido en vivo: `.css-iyrxkt` → 0, `.css-xd9ivb` → 0). `closest()` devolvía null y ambos
// applets hacían `return` en silencio: cargaban, detectaban el modal, y no pintaban nada.
//
// ── LA REGLA QUE FIJA ─────────────────────────────────────────────────────────────────
// Se ENTRA por el texto del label (ES+EN) porque ESTE modal no ofrece nada mejor: medido en
// vivo, 0 `data-steelhead-component-id` y 0 `data-testid` en todo el diálogo, así que el
// nivel 1 de la jerarquía no está disponible AQUÍ. Ojo con generalizarlo: los
// `data-steelhead-component-id` SÍ existen en otras pantallas (38 en la ficha de OT, 40 en la
// de PN) — lo que SH eliminó globalmente fueron los `data-testid`, no éstos. Pero se SUBE por
// RELACIÓN ESTRUCTURAL (padre / número de labels hijos), nunca por el nombre de una clase
// generada. Y las clases de presentación se HEREDAN del vecino vivo en lugar de escribirse
// a mano, para que el próximo rehash de emotion nos siga vistiendo igual que a SH.
//
// Corolario: una clase `css-<hash>` es MENOS estable que el texto visible. El texto cambia
// cuando alguien traduce; el hash cambia cuando alguien mueve un padding.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.ReceiveModalAnchorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Labels del encabezado. Bilingües ES+EN: la UI de SH cambia de idioma por usuario y
  // este mismo modal ya se ha visto mezclado (título en español, columnas en inglés).
  const LABEL_CUSTOMER = /^(?:customer|cliente)\s*:?$/i;
  const LABEL_RECEIVER_COMMENTS = /^(?:receiver\s+comments|comentarios\s+del\s+receptor)\s*:?$/i;

  function matchLabel(text, re) {
    if (typeof text !== 'string') return false;
    return re.test(text.trim());
  }

  // Busca el <p> de un label dentro del modal. Devuelve el nodo o null.
  function findLabelNode(modal, re) {
    if (!modal || typeof modal.querySelectorAll !== 'function') return null;
    for (const node of modal.querySelectorAll('p')) {
      if (matchLabel(node.textContent, re)) return node;
    }
    return null;
  }

  // Cuenta los <p> que cuelgan DIRECTAMENTE de un nodo. Es el criterio que distingue
  // "wrapper de UN campo" (1 label) de "contenedor de TODO el encabezado" (varios).
  function directLabelCount(node) {
    if (!node || !node.children) return 0;
    let n = 0;
    for (const child of node.children) if (child.tagName === 'P') n++;
    return n;
  }

  /**
   * Dado el <p> de un label del encabezado, decide DÓNDE insertar nuestro campo.
   *
   * Devuelve null si no hay dónde (nodo suelto). Si no, un objeto:
   *   mode:         'sibling' → el layout de hoy: cada campo es un wrapper y el nuestro va
   *                             como HERMANO dentro de la fila.
   *                 'grid'    → el layout legado: un solo contenedor con todos los labels;
   *                             nuestro label y controles se agregan a ESE contenedor.
   *   container:    el nodo donde hay que insertar.
   *   fieldWrapper: el wrapper del campo ancla (sólo en 'sibling'; null en 'grid').
   *   wrapperClass: clase a heredar para nuestro wrapper (sólo en 'sibling').
   *   labelClass:   clase a heredar para nuestro <p> label.
   *
   * Se conserva el modo 'grid' a propósito: si SH revierte el layout, esto sigue vivo.
   */
  function findHeaderFieldAnchor(labelEl) {
    if (!labelEl) return null;
    const parent = labelEl.parentElement;
    if (!parent) return null;

    const labelClass = labelEl.className || '';

    // Varios labels colgando del mismo padre ⇒ ese padre es el contenedor del encabezado
    // completo (el grid legado), no el wrapper de un campo.
    if (directLabelCount(parent) > 1) {
      return { mode: 'grid', container: parent, fieldWrapper: null, wrapperClass: null, labelClass };
    }

    // Un solo label ⇒ `parent` es el wrapper de ESTE campo. Nuestro campo va como hermano
    // suyo, dentro de la fila.
    const row = parent.parentElement;
    if (!row) {
      // Campo sin fila padre: no hay hermanos posibles, pero sí hay dónde insertar.
      return { mode: 'grid', container: parent, fieldWrapper: null, wrapperClass: null, labelClass };
    }

    return {
      mode: 'sibling',
      container: row,
      fieldWrapper: parent,
      wrapperClass: parent.className || '',
      labelClass,
    };
  }

  /**
   * La fila del encabezado es `flex nowrap` con columnas de `flex: 1 1 0%`, así que CADA
   * columna que agreguemos angosta a todas las demás. Medido en vivo el 2026-08-03, SH deja
   * DOS columnas vacías en esa fila — si reusamos una, el campo entra sin encoger nada.
   *
   * Devuelve un slot vacío reusable, o null si no hay (entonces se crea un hermano nuevo).
   * Es una MEJORA cosmética con degradación: que no haya slots no rompe el montaje.
   *
   * Sólo cuenta como vacío un elemento sin hijos y sin texto, y nunca el wrapper ancla.
   */
  function pickInsertionSlot(anchor) {
    if (!anchor || anchor.mode !== 'sibling' || !anchor.container) return null;
    const children = anchor.container.children || [];
    for (const child of children) {
      if (child === anchor.fieldWrapper) continue;
      if (child.children && child.children.length > 0) continue;
      if ((child.textContent || '').trim() !== '') continue;
      return child;
    }
    return null;
  }

  /**
   * Monta un campo (label + controles) en el encabezado, respetando el layout vigente.
   * `doc` se inyecta para que la función siga siendo probable fuera del navegador — y para
   * que el montaje viva en UN solo lugar: que RDO y WLP tuvieran copias separadas del mismo
   * anclaje es justamente lo que hizo que los dos se rompieran igual y en silencio.
   *
   * Devuelve el nodo que quedó montado, o null si no había anclaje.
   */
  function mountHeaderField(doc, anchor, label, controls) {
    if (!doc || !anchor || !anchor.container) return null;

    if (anchor.mode === 'grid') {
      // Layout legado: el contenedor ES un grid de 2 columnas y el campo entra como una
      // fila más. Las columnas se fijan aquí y no en el CSS del applet porque en el layout
      // de hoy no significan nada.
      if (label.style) label.style.gridColumn = '1';
      if (controls.style) controls.style.gridColumn = '2';
      anchor.container.appendChild(label);
      anchor.container.appendChild(controls);
      return anchor.container;
    }

    // Layout vigente: cada campo es un wrapper propio dentro de una fila flex.
    // Se reusa un hueco si SH dejó alguno; si no, se crea un hermano nuevo.
    const slot = pickInsertionSlot(anchor);
    const host = slot || doc.createElement('div');
    if (!host.className) host.className = anchor.wrapperClass || '';
    host.appendChild(label);
    host.appendChild(controls);
    if (!slot) {
      // La posición se calcula sobre `children` y no con `nextSibling`: éste último puede
      // devolver un nodo de texto (whitespace del markup) y dejar el campo en otro lugar.
      const kids = anchor.container.children || [];
      const idx = Array.prototype.indexOf.call(kids, anchor.fieldWrapper);
      const ref = (idx >= 0 && idx + 1 < kids.length) ? kids[idx + 1] : null;
      anchor.container.insertBefore(host, ref);
    }
    return host;
  }

  /**
   * Dado el elemento que contiene el TEXTO de un label, encuentra el control que le
   * corresponde subiendo al ancestro MÁS CERCANO que tenga uno.
   *
   * Subir por cercanía —en vez de tomar "el primer control que sigue en orden de documento
   * dentro del modal"— es lo que impide cruzarse al campo vecino cuando un label no tiene
   * control propio. `queryControl` se inyecta para no acoplar el core a un selector ni al
   * DOM: el glue pasa `n => n.querySelector('[class*="-control"]')`.
   */
  function findControlNearLabel(labelHost, queryControl, maxUp) {
    if (!labelHost || typeof queryControl !== 'function') return null;
    let node = labelHost;
    for (let i = 0; i < (maxUp || 6) && node; i++) {
      const ctrl = queryControl(node);
      if (ctrl) return ctrl;
      node = node.parentElement;
    }
    return null;
  }

  return {
    LABEL_CUSTOMER,
    LABEL_RECEIVER_COMMENTS,
    matchLabel,
    findLabelNode,
    directLabelCount,
    findHeaderFieldAnchor,
    pickInsertionSlot,
    mountHeaderField,
    findControlNearLabel,
  };
});
