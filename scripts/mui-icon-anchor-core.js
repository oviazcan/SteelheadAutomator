// mui-icon-anchor-core.js — Núcleo PURO para anclar a iconos de MUI cuando el `data-testid`
// ya no está.
//
// ── POR QUÉ EXISTE (incidente 2026-08-03, segunda mitad) ──────────────────────────────
// Steelhead publicó un build que **quita los `data-testid` de los iconos MUI** y los
// `data-steelhead-component-id`. Medido en tres pantallas distintas, todas cargadas y con
// contenido real: `/Reporting/View` (189 svg), `/Receiving/CustomerParts` (159 svg) y la
// lista de reportes → **0 `[data-testid]` y 0 `[data-steelhead-component-id]`** en cada una.
// (Los únicos dos testid que sobreviven, `sentinelStart`/`sentinelEnd`, los pone
// react-virtuoso, no SH.)
//
// Eso dejó a `report-regen` sin ancla, con un modo de falla que engaña: su gate de permisos
// pasaba (`allowed: true`), el script cargaba, el observer vivía — y `findAnchor()` devolvía
// null para siempre, en silencio, porque «esta vista no tiene el header» es un caso legítimo.
//
// ── LA REGLA QUE FIJA ────────────────────────────────────────────────────────────────
// El `data-testid` era el nivel 1 de la jerarquía de anclaje del repo y SH lo puede quitar de
// un build a otro. Lo que NO puede quitar sin cambiar lo que el operador VE es **la FORMA del
// icono**: el atributo `d` del `<path>`. No depende del idioma, ni de clases generadas, ni de
// atributos de test. Se busca por testid PRIMERO (si SH lo repone, sigue sirviendo) y por
// forma DESPUÉS — un anclaje no se cambia, se AMPLÍA.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.MuiIconAnchorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Catálogo de FORMAS ────────────────────────────────────────────────────────────────
  // La clave conserva el nombre del `data-testid` histórico para que el código siga
  // leyéndose igual y la búsqueda por testid siga funcionando si SH lo repone.
  //
  // TODOS los paths de aquí abajo están MEDIDOS EN VIVO el 2026-08-03, no copiados de la
  // documentación de MUI. Eso NO es ceremonia: al intentar adivinarlos fallaron por
  // diferencias mínimas de optimización SVGO entre versiones — el Edit real trae
  // `a.996.996 0` donde el canónico dice `a.9959.9959 0`, y el Archive real empieza con `m`
  // minúscula donde el canónico usa `M`. Un path adivinado no matchea nunca.
  //
  // Un path que no matchea NO hace daño (el applet queda como está, sin ancla), así que el
  // riesgo de catalogar de más es cero; el de catalogar de menos es quedarse sin arreglo.
  const ICON_SHAPES = {
    // ── Medidos en /Reporting/View
    PlayArrowIcon: ['M8 5v14l11-7z'],
    EmailOutlinedIcon: [
      'M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2zm-2 0-8 5-8-5zm0 12H4V8l8 5 8-5z',
      // variante outlined de MUI, por si SH cambia de icono
      'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m0 4-8 5-8-5V6l8 5 8-5z',
    ],
    // ── Medidos en /Domains/344/WorkOrders (identidad confirmada por el aria-label del botón)
    EditIcon: ['M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z'],
    ArchiveIcon: ['m20.54 5.23-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27M12 17.5 6.5 12H10v-2h4v2h3.5zM5.12 5l.81-1h12l.94 1z'],
    // ── Medido en el modal de recepción y en el filtro de OTs (doble confirmación)
    FilterListIcon: ['M10 18h4v-2h-4zM3 6v2h18V6zm3 7h12v-2H6z'],
    // ── Medidos en la ficha de OT
    QrCode2Icon: ['M3 11h8V3H3zm2-6h4v4H5zM3 21h8v-8H3zm2-6h4v4H5zm8-12v8h8V3zm6 6h-4V5h4zm0 10h2v2h-2zm-6-6h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm0-4h2v2h-2zm2 2h2v2h-2z'],
    CalendarMonthIcon: ['M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m0 16H5V10h14zM9 14H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zm-8 4H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2z'],

    // ── PENDIENTES DE MEDIR ───────────────────────────────────────────────────────────
    // Se dejan VACÍOS a propósito. Meter aquí el path canónico de MUI sería peor que dejarlo
    // vacío: no matchearía (ver arriba) y daría la falsa impresión de que el icono está
    // cubierto. Con la lista vacía, `findIcon` cae al aria-label o devuelve null, que es
    // exactamente el estado de hoy — nunca peor. Para cerrarlos hay que abrir la pantalla
    // donde vive cada uno y leer el `d` real:
    //   CloseIcon                → cualquier modal con "X" de cerrar
    //   SendIcon                 → modal de enviar factura por correo
    //   RestorePageOutlinedIcon  → listado de facturas, con las filas cargadas
    //   VisibilityIcon/OffIcon   → dashboard de sensores
    CloseIcon: [],
    SendIcon: [],
    RestorePageOutlinedIcon: [],
    VisibilityIcon: [],
    VisibilityOffIcon: [],
    // Path canónico de MUI. NO medido en vivo: al inspeccionar no había ningún timer
    // corriendo. Por eso el pausa sólo se usa como señal que AFIRMA, nunca como requisito.
    PauseIcon: ['M6 19h4V5H6zm8-14v14h4V5z'],
  };

  // ── Catálogo de ARIA-LABELS (tercera señal) ──────────────────────────────────────────
  // Descubierto midiendo: SH quitó los `data-testid` pero **conserva `aria-label` en muchos
  // botones de icono**, y lo TRADUCE ("Editar", "Archivar", "Filtrar Números de Parte").
  // Por eso los patrones son bilingües ES+EN y por SUBCADENA: el texto real suele ser más
  // largo que el nombre del icono ("Archivar Orden de Trabajo", "Imprimir Etiquetas de
  // Trabajo"). Es la red que sostiene a los iconos cuya forma todavía no se ha medido.
  const ICON_ARIA = {
    EditIcon: /(?:^|\s)(?:editar|edit)(?:\s|$)/i,
    ArchiveIcon: /archivar|archive/i,
    FilterListIcon: /filtrar|filter/i,
    QrCode2Icon: /etiquetas|labels?|qr/i,
    CalendarMonthIcon: /schedule|programaci[oó]n|calendario/i,
    CloseIcon: /^(?:cerrar|close)$/i,
    SendIcon: /enviar|send/i,
    VisibilityIcon: /mostrar|ver|show|visible/i,
    VisibilityOffIcon: /ocultar|esconder|hide/i,
  };

  function norm(s) { return (s || '').trim(); }

  /**
   * Encuentra un icono por nombre. Devuelve `{node, by}` con `by` = 'testid' | 'shape',
   * o null. El `by` no es decorativo: permite loguear POR QUÉ se encontró y detectar el día
   * que SH reponga (o vuelva a quitar) los atributos de test.
   */
  function findIcon(root, name) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const shapes = ICON_SHAPES[name];
    const ariaRe = ICON_ARIA[name];
    if (!shapes && !ariaRe) return null;

    // 1) por data-testid (legado). Si SH lo repone, esto vuelve a ser lo más barato.
    const byTestid = root.querySelectorAll('svg[data-testid="' + name + '"]');
    if (byTestid && byTestid.length) return { node: byTestid[0], by: 'testid' };

    // 2) por la FORMA del icono — lo único que SH no puede cambiar sin cambiar lo que se VE.
    if (shapes && shapes.length) {
      for (const path of root.querySelectorAll('svg path')) {
        const d = norm(path.getAttribute('d'));
        if (!d) continue;
        if (shapes.indexOf(d) !== -1) {
          return { node: path.parentElement || path, by: 'shape' };
        }
      }
    }

    // 3) por aria-label del botón (bilingüe ES+EN). Es la red para los iconos cuya forma
    // todavía no se ha medido; va al final porque el texto SÍ cambia con el idioma y podría
    // colisionar entre iconos parecidos.
    if (ariaRe && typeof root.querySelectorAll === 'function') {
      for (const el of root.querySelectorAll('[aria-label]')) {
        const label = el.getAttribute && el.getAttribute('aria-label');
        if (!label || !ariaRe.test(label)) continue;
        const svg = el.querySelector && el.querySelector('svg');
        if (svg) return { node: svg, by: 'aria' };
      }
    }
    return null;
  }

  /**
   * TODOS los iconos de un nombre dentro de `root`, no sólo el primero. Lo necesitan los
   * applets que iteran (p. ej. una lista de chips, cada uno con su "X" de quitar).
   */
  function findIcons(root, name) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const shapes = ICON_SHAPES[name];
    const ariaRe = ICON_ARIA[name];
    const out = [];

    const byTestid = root.querySelectorAll('svg[data-testid="' + name + '"]');
    if (byTestid && byTestid.length) return Array.prototype.slice.call(byTestid);

    if (shapes && shapes.length) {
      for (const path of root.querySelectorAll('svg path')) {
        const d = norm(path.getAttribute('d'));
        if (d && shapes.indexOf(d) !== -1) out.push(path.parentElement || path);
      }
      if (out.length) return out;
    }

    if (ariaRe) {
      for (const el of root.querySelectorAll('[aria-label]')) {
        const label = el.getAttribute && el.getAttribute('aria-label');
        if (!label || !ariaRe.test(label)) continue;
        const svg = el.querySelector && el.querySelector('svg');
        if (svg) out.push(svg);
      }
    }
    return out;
  }

  /** ¿Hay alguno de estos iconos dentro de `root`? Para gates que aceptan varios. */
  function hasAnyIcon(root, names) {
    if (!root || !names) return false;
    for (const name of names) if (findIcon(root, name)) return true;
    return false;
  }

  /** El `<button>` que envuelve al icono. Devuelve `{button, icon, by}` o null. */
  function findIconButton(root, name) {
    const hit = findIcon(root, name);
    if (!hit || !hit.node || typeof hit.node.closest !== 'function') return null;
    const button = hit.node.closest('button');
    if (!button) return null;
    return { button, icon: hit.node, by: hit.by };
  }

  // ¿El contenedor tiene un breadcrumb? Es la señal estructural de que estamos en el header
  // secundario. Se busca el `<nav>` entre los hijos directos — `aria-label="breadcrumb"` es un
  // valor técnico que SH NO traduce (verificado en vivo con la UI en español), pero basta con
  // el tagName, que es aún más estable.
  function hasBreadcrumb(container) {
    if (!container || !container.children) return false;
    for (const child of container.children) if (child.tagName === 'NAV') return true;
    return false;
  }

  /**
   * Ancla del header secundario de reportes: el contenedor que tiene el botón de CORREO.
   *
   * EL ANCLA ES EL CORREO, NO EL PLAY. Corrección de dominio del operador (2026-08-03):
   * **el ▶ se convierte en ⏸ cuando hay un timer activo**, así que exigir `PlayArrowIcon`
   * hacía desaparecer el botón justo mientras corría un reporte — un bug que el applet ya
   * arrastraba, independiente del cambio de SH. Medido además: hay **un solo sobre en toda la
   * página**, así que el correo identifica el header sin ambigüedad.
   *
   * El breadcrumb y el botón de transporte (play O pausa) sólo CONFIRMAN; ninguno puede negar.
   * Se exige al menos una confirmación para no montar el botón en cualquier header que tenga
   * un sobre: sin evidencia de que sea el header de reportes, no se monta (fail-safe).
   *
   * Devuelve `{container, emailBtn, by}` o null — null NO es error: la mayoría de las vistas
   * simplemente no tienen este header.
   */
  function findReportHeaderAnchor(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;

    const shapes = ICON_SHAPES.EmailOutlinedIcon;
    const candidates = [];

    // Todos los sobres de la página, por testid y por forma.
    for (const svg of root.querySelectorAll('svg[data-testid="EmailOutlinedIcon"]')) {
      candidates.push({ node: svg, by: 'testid' });
    }
    if (!candidates.length) {
      for (const path of root.querySelectorAll('svg path')) {
        const d = norm(path.getAttribute('d'));
        if (d && shapes.indexOf(d) !== -1) candidates.push({ node: path.parentElement || path, by: 'shape' });
      }
    }

    for (const cand of candidates) {
      if (typeof cand.node.closest !== 'function') continue;
      const emailBtn = cand.node.closest('button');
      if (!emailBtn || !emailBtn.parentElement) continue;
      const container = emailBtn.parentElement;

      // Confirmación: breadcrumb, o un botón de transporte (play o pausa) como hermano.
      const confirmed = hasBreadcrumb(container)
        || !!findIcon(container, 'PlayArrowIcon')
        || !!findIcon(container, 'PauseIcon');
      if (!confirmed) continue;

      return { container, emailBtn, by: cand.by };
    }
    return null;
  }

  return { ICON_SHAPES, ICON_ARIA, findIcon, findIcons, hasAnyIcon, findIconButton, hasBreadcrumb, findReportHeaderAnchor };
});
