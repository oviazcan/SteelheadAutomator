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

  // Catálogo de formas. La clave conserva el nombre del `data-testid` histórico para que el
  // código siga leyéndose igual y la búsqueda por testid siga funcionando si SH lo repone.
  // Un icono puede tener más de una forma conocida (variantes outlined/filled de MUI).
  const ICON_SHAPES = {
    // Medidos EN VIVO el 2026-08-03 en /Reporting/View:
    PlayArrowIcon: ['M8 5v14l11-7z'],
    EmailOutlinedIcon: [
      'M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2zm-2 0-8 5-8-5zm0 12H4V8l8 5 8-5z',
      // variante outlined de MUI, por si SH cambia de icono
      'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m0 4-8 5-8-5V6l8 5 8-5z',
    ],
    // Path canónico de MUI. NO medido en vivo: al inspeccionar no había ningún timer
    // corriendo. Por eso el pausa sólo se usa como señal que AFIRMA, nunca como requisito.
    PauseIcon: ['M6 19h4V5H6zm8-14v14h4V5z'],
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
    if (!shapes) return null;

    // 1) por data-testid (legado)
    const byTestid = root.querySelectorAll('svg[data-testid="' + name + '"]');
    if (byTestid && byTestid.length) return { node: byTestid[0], by: 'testid' };

    // 2) por la FORMA del icono
    for (const path of root.querySelectorAll('svg path')) {
      const d = norm(path.getAttribute('d'));
      if (!d) continue;
      if (shapes.indexOf(d) !== -1) {
        return { node: path.parentElement || path, by: 'shape' };
      }
    }
    return null;
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

  return { ICON_SHAPES, findIcon, findIconButton, hasBreadcrumb, findReportHeaderAnchor };
});
