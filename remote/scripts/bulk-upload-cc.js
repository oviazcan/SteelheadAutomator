// bulk-upload-cc.js — Helpers puros del applet bulk-upload (Control de Cambios +
// decisión de matching con acabados en blanco). Dual-export: en el browser expone
// window.SteelheadBulkCC; en Node (tests) exporta vía module.exports.
//
// Versión 1.0.0 (2026-06-04): extracción inicial para Feature A (blank-acabados)
// y Feature B (footprint en customInputs.ControlCambios).
(function (root) {
  'use strict';

  // Elige el candidato con id más alto (= el más reciente; los ids de Steelhead
  // son autoincrement). Devuelve null si no hay candidatos.
  function pickMostRecent(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    let best = candidates[0];
    for (const c of candidates) {
      if ((c && c.id ? c.id : 0) > (best && best.id ? best.id : 0)) best = c;
    }
    return best;
  }

  // Feature A: con acabados vacíos en el upload, decide el PN destino y si la
  // decisión es automática (1 candidato) o requiere confirmación (2+).
  // Devuelve null si no hay candidatos por nombre (la regla no aplica).
  function decideBlankAcabados(nameCandidates) {
    if (!Array.isArray(nameCandidates) || nameCandidates.length === 0) return null;
    const recent = pickMostRecent(nameCandidates);
    if (!recent || recent.id == null) return null;
    return { targetPnId: recent.id, autoDecided: nameCandidates.length === 1 };
  }

  // Construye el token de Accion combinando lo que cambió, en orden canónico.
  function computeAccion(flags) {
    const tokens = [];
    if (flags && flags.isNew) tokens.push('ALTA');
    if (flags && flags.hasPrice) tokens.push('PRECIO');
    if (flags && flags.hasEnrich) tokens.push('ENRIQUECIMIENTO');
    return tokens.join(', ');
  }

  // Detalle legible del evento. Best-effort en precio anterior.
  function buildDetalle(opts) {
    const accion = (opts && opts.accion) || '';
    const segs = [];
    if (accion.indexOf('ALTA') !== -1) segs.push('PN creado vía carga masiva');
    if (accion.indexOf('PRECIO') !== -1) {
      const div = ((opts && opts.divisa) || '').trim();
      const nuevo = opts.precioNuevo;
      const ant = opts.precioAnterior;
      // Guard: no estampar "undefined USD" si el caller marcó PRECIO pero no pasó precio.
      if (nuevo != null) {
        if (ant != null && ant !== '') {
          segs.push(`${ant} → ${nuevo} ${div}`.trim());
        } else {
          segs.push(`${nuevo} ${div}`.trim());
        }
      }
    }
    if (accion.indexOf('ENRIQUECIMIENTO') !== -1) {
      const fields = (opts && opts.enrichFields && opts.enrichFields.length) ? opts.enrichFields.join(', ') : 'campos';
      segs.push(`Enriquecimiento: ${fields}`);
    }
    return segs.join(' · ');
  }

  // Arma una entrada del Control de Cambios con los nombres EXACTOS del schema 3932.
  function buildControlCambiosEntry(opts) {
    return {
      Fecha: (opts && opts.nowIso) || '',
      Usuario: (opts && opts.usuario) || '(desconocido)',
      Accion: (opts && opts.accion) || '',
      Detalle: (opts && opts.detalle) || '',
      Version: (opts && opts.version) || '',
    };
  }

  // Append no-destructivo a ci.ControlCambios. Crea el array si no existe.
  // Devuelve ci (o null si ci no es objeto).
  function appendControlCambios(ci, entry) {
    if (!ci || typeof ci !== 'object') return ci;
    if (!Array.isArray(ci.ControlCambios)) ci.ControlCambios = [];
    ci.ControlCambios.push(entry);
    return ci;
  }

  const api = {
    pickMostRecent, decideBlankAcabados, computeAccion, buildDetalle,
    buildControlCambiosEntry, appendControlCambios, VERSION: '1.0.0',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkCC = api;
})(typeof window !== 'undefined' ? window : globalThis);
