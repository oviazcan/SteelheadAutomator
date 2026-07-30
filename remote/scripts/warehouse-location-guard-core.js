// warehouse-location-guard-core.js — funciones PURAS del candado de "Ubicación inicial"
// del modal Recibir piezas del cliente (applet warehouse-location-prefill).
//
// Dual-export: window.WarehouseLocationGuardCore (browser) / module.exports (node --test).
// SIN dependencias de DOM, API ni closure: recibe descriptores ya extraídos del DOM
// (o el payload de CreateReceiverChecked) y DECIDE si el guardado se bloquea.
//
// Dos capas con fuentes de verdad distintas, a propósito:
//   1. decideSaveGate() decide sobre el DOM (lo que el operador ve) → tapa los botones de
//      Guardar y explica QUÉ renglón falta.
//   2. payloadMissingLocations() decide sobre el payload que se va a ESCRIBIR → red de
//      seguridad independiente del idioma y del layout. Si el DOM cambia y la capa 1 deja
//      de reconocer los combos, la capa 2 sigue frenando la escritura (falla RUIDOSA en vez
//      de silenciosa). Ambas son fail-safe: sin evidencia POSITIVA de faltante, dejan pasar.
(function (root) {
  'use strict';

  // Placeholder del combo NATIVO de ubicación por renglón (react-select). Bilingüe ES+EN:
  // es el mismo criterio que warehouse-location-prefill usa desde 0.5.x para localizarlos,
  // ya validado en producción. Un combo CON valor no tiene placeholder (react-select lo
  // reemplaza por singleValue) → la PRESENCIA del placeholder es la señal de "vacío".
  // Verificado en vivo 2026-07-29: vacío = `css-qpe0ht-control` + `[id$="-placeholder"]`
  // «Buscar Ubicaciones...»; con valor = `css-1bsomep-control` + `singleValue` con el path.
  const LOCATION_PLACEHOLDER_RE = /^(?:buscar\s+ubicaciones|search\s+locations)/i;

  // Botones del pie del modal. Bilingüe ES+EN porque el pie NO expone
  // data-steelhead-component-id (verificado en vivo: los 4 botones vienen sin él).
  const SAVE_BUTTON_RE = /(?:guardar|save)/i;
  const CANCEL_BUTTON_RE = /^(?:cancelar|cancel)$/i;

  // Cuántos renglones se listan en el tooltip antes de resumir el resto.
  const MAX_TOOLTIP_ROWS = 8;

  function norm(txt) {
    return String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim();
  }

  function isLocationPlaceholder(txt) {
    return LOCATION_PLACEHOLDER_RE.test(norm(txt));
  }

  function isCancelButtonText(txt) {
    return CANCEL_BUTTON_RE.test(norm(txt));
  }

  // Un botón es "de guardar" si menciona guardar/save y NO es el de cancelar. Cubre los tres
  // del pie: «Guardar», «Guardar + imprimir todas las piezas», «Guardar y agregar piezas a
  // OT» (y sus equivalentes en inglés).
  function isSaveButtonText(txt) {
    const t = norm(txt);
    if (!t) return false;
    if (isCancelButtonText(t)) return false;
    return SAVE_BUTTON_RE.test(t);
  }

  // "Línea 3 · 80095-337-01 · lote T-226" — el nombre es best-effort: si el renglón todavía
  // no tiene número de parte ni lote, el índice es lo único que lo identifica y así se dice.
  function describeRow(row) {
    const idx = row && row.index != null ? row.index : '?';
    const parts = [];
    const part = norm(row && row.part);
    const batch = norm(row && row.batch);
    if (part) parts.push(part);
    if (batch) parts.push('lote ' + batch);
    if (!parts.length) return `Línea ${idx} (sin número de parte)`;
    return `Línea ${idx} · ` + parts.join(' · ');
  }

  function formatGateLines(missing, max) {
    const list = Array.isArray(missing) ? missing : [];
    const cap = max == null ? MAX_TOOLTIP_ROWS : max;
    const shown = list.slice(0, cap).map((r) => ' • ' + describeRow(r));
    const rest = list.length - shown.length;
    if (rest > 0) shown.push(` • …y ${rest} línea${rest === 1 ? '' : 's'} más`);
    return shown;
  }

  // Decisión del candado sobre el DOM.
  //   headerLocation: path de la ubicación elegida en el combo del encabezado (o null/'').
  //   rows: [{ index (1-based), hasLocation, part, batch }]
  // Devuelve { blocked, reason, missing, total, summary, tooltip }.
  function decideSaveGate(input) {
    const headerLocation = norm(input && input.headerLocation);
    const rows = Array.isArray(input && input.rows) ? input.rows : [];
    const total = rows.length;

    // El combo del encabezado se inyecta en TODOS los renglones al interceptar la mutación,
    // así que cubre incluso los que quedaron con su combo vacío.
    if (headerLocation) {
      return { blocked: false, reason: 'header-covers-all', missing: [], total, summary: '', tooltip: '' };
    }
    if (total === 0) {
      return { blocked: false, reason: 'no-rows', missing: [], total, summary: '', tooltip: '' };
    }

    const missing = rows.filter((r) => !(r && r.hasLocation));
    if (!missing.length) {
      return { blocked: false, reason: 'all-set', missing: [], total, summary: '', tooltip: '' };
    }

    const plural = total === 1 ? '' : 's';
    const summary = missing.length === total
      ? `⛔ Falta la ubicación inicial (${total} línea${plural})`
      : `⛔ Falta la ubicación inicial en ${missing.length} de ${total} líneas`;

    const tooltip = [
      `⛔ No se puede guardar: ${missing.length} de ${total} línea${plural} sin ubicación inicial.`,
      '',
      ...formatGateLines(missing),
      '',
      'Elige la ubicación en cada línea, o usa «Ubicación inicial» del encabezado para aplicarla a todas.',
    ].join('\n');

    return { blocked: true, reason: 'missing-locations', missing, total, summary, tooltip };
  }

  // ¿Este locationId cuenta como "puesto"? Los ids de Steelhead son enteros positivos;
  // null/undefined/''/0 significan que el renglón se va a escribir SIN ubicación.
  function hasLocationId(value) {
    if (value == null || value === '') return false;
    const n = Number(value);
    if (Number.isFinite(n)) return n > 0;
    return true; // id no numérico inesperado → se toma como presente (fail-safe: no bloquea)
  }

  // Decisión del candado sobre el PAYLOAD de CreateReceiverChecked, ya mutado por el applet
  // (o sea: DESPUÉS de inyectar el locationId del encabezado, si había).
  // Devuelve { checked, total, missing: [{ itemIndex, accountIndex }] }.
  // checked=false ⇒ el payload no tiene la forma esperada ⇒ el llamador NO debe bloquear.
  function payloadMissingLocations(bodyObj) {
    const items = bodyObj && bodyObj.variables && bodyObj.variables.receiverPayload
      ? bodyObj.variables.receiverPayload.receiverBomItems
      : null;
    if (!Array.isArray(items) || items.length === 0) {
      return { checked: false, total: 0, missing: [] };
    }

    const missing = [];
    let total = 0;
    items.forEach((item, itemIndex) => {
      const accounts = item && item.inventoryTransferEvent && item.inventoryTransferEvent.debitAccounts
        ? item.inventoryTransferEvent.debitAccounts.accounts
        : null;
      if (!Array.isArray(accounts)) return; // forma inesperada: no cuenta ni bloquea
      accounts.forEach((account, accountIndex) => {
        if (!account || typeof account !== 'object') return;
        total++;
        if (!hasLocationId(account.locationId)) missing.push({ itemIndex, accountIndex });
      });
    });

    // Sin un solo account inspeccionable no hay evidencia de nada.
    if (total === 0) return { checked: false, total: 0, missing: [] };
    return { checked: true, total, missing };
  }

  const api = {
    LOCATION_PLACEHOLDER_RE,
    SAVE_BUTTON_RE,
    CANCEL_BUTTON_RE,
    MAX_TOOLTIP_ROWS,
    isLocationPlaceholder,
    isSaveButtonText,
    isCancelButtonText,
    describeRow,
    formatGateLines,
    decideSaveGate,
    hasLocationId,
    payloadMissingLocations,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WarehouseLocationGuardCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
