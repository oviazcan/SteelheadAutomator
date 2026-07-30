/**
 * spec-migrator-normalize.js — lógica PURA para normalizar "falsos pendientes".
 *
 * Contexto (diagnóstico 2026-07-16): "Asignar Params Pendientes" listaba PNs como
 * pendientes que en realidad YA tienen el param correcto y activo, pero con un
 * `specFieldParamId` de una REVISIÓN ANTERIOR de la spec (mismo nombre, distinto id).
 *  - searchPartNumbers compara por id exacto → falso pendiente.
 *  - AddParams valida el constraint por specFieldId → choca (23P01 / HTTP 500 bajo carga).
 *
 * Normalizar = archivar la fila activa vieja (id viejo) y reponer el param del
 * catálogo vigente (id nuevo), dejando el field alineado con la revisión actual.
 * SOLO cuando el nombre coincide (equivalencia semántica) — nunca cambia el valor.
 *
 * Esta unidad es pura y testeable; la ejecución (mutaciones + rollback) vive en el applet.
 */
(function () {
  'use strict';

  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  /**
   * Decide cómo liberar un SpecField cuyas filas traen processNodeId FORZADO.
   *
   * Por qué importa: en el NP el parámetro debe ir SIN nodo. Cuando trae uno forzado,
   * Steelhead lo materializa en ESE nodo al crear la OT —típicamente el raíz— en vez de
   * dejar que caiga en el nodo que declara el specField. Resultado: órdenes con el
   * parámetro en el lugar equivocado.
   *
   * Origen del daño: `bulk-upload` escribía `processNodeId: part.processId ||
   * pn.defaultProcessNodeId` hasta la regla 1.4.38 (commit 046ec5b, 2026-05-25). El fix
   * detuvo la sangría pero no limpió lo ya escrito, y el deduplicador no lo alcanza: solo
   * mira SpecFields con 2+ params y su modo masivo únicamente archiva.
   *
   * @param {Array<{id, processNodeId, paramId, paramName}>} activeRows
   *        Filas ACTIVAS del MISMO specFieldSpec en un NP.
   * @returns {{action, archiveIds:number[], insertParamId:number|null, reason?:string}}
   *   - 'ok'           → ninguna tiene nodo forzado; nada que hacer.
   *   - 'archive-only' → ya existe una sin nodo: basta archivar las forzadas.
   *   - 'rewrite'      → todas están forzadas y valen lo mismo: archivar todas y reponer una
   *                      sin nodo con ese mismo parámetro.
   *   - 'ambiguous'    → las forzadas tienen valores DISTINTOS: elegir cuál vale no le toca
   *                      al applet. No se archiva nada.
   */
  function planForcedNodeRelease(activeRows) {
    const rows = Array.isArray(activeRows) ? activeRows.filter(Boolean) : [];
    const forced = rows.filter(r => r.processNodeId);
    if (!forced.length) return { action: 'ok', archiveIds: [], insertParamId: null };

    const libres = rows.filter(r => !r.processNodeId);
    if (libres.length) {
      // Ya hay una fila que cumple el contrato: las forzadas sobran.
      return { action: 'archive-only', archiveIds: forced.map(r => r.id), insertParamId: null };
    }

    // Todas forzadas. Solo se puede reponer si representan el MISMO valor: distinto nombre
    // significaría elegir criterio de calidad, y eso no lo decide una herramienta.
    const nombres = new Set(forced.map(r => norm(r.paramName)));
    if (nombres.size > 1) {
      return {
        action: 'ambiguous', archiveIds: [], insertParamId: null,
        reason: 'las filas forzadas tienen valores distinto entre sí (' +
                forced.map(r => JSON.stringify(r.paramName)).join(' vs ') + ')'
      };
    }
    // Mismo valor: se repone el parámetro de id más alto (el del catálogo más reciente).
    const ganador = forced.slice().sort((a, b) => Number(b.paramId) - Number(a.paramId))[0];
    return {
      action: 'rewrite',
      archiveIds: forced.map(r => r.id),
      insertParamId: ganador.paramId != null ? ganador.paramId : null
    };
  }

  /**
   * Convierte los grupos en UNIDADES ATÓMICAS de trabajo: cada una lleva su archivado y su
   * reposición JUNTOS.
   *
   * Por qué: el incidente del 2026-07-29 (GRUPO COLLADO) dejó 52 parámetros archivados sin
   * reponer porque el apply archivaba TODO primero y reponía TODO después. Cuando la segunda
   * fase falló en bloque, el daño fue de 52. Procesando unidad por unidad, un fallo deja UN
   * hueco. El radio de daño deja de depender del tamaño de la corrida.
   *
   * @param {Array} grupos          los grupos detectados por el scan
   * @param {Function} getDecision  key → { winnerRowId, ignored }
   * @returns {Array<{key, pnId, fieldId, archive:number[], repone:{specFieldId,specFieldParamId}|null}>}
   */
  function planApplyUnits(grupos, getDecision) {
    const out = [];
    for (const g of (grupos || [])) {
      const dec = getDecision ? getDecision(g.key) : null;
      if (!dec || dec.ignored) continue;

      const rp = g.releasePlan || { action: 'ok', archiveIds: [], insertParamId: null };
      if (rp.action === 'ambiguous') continue;   // valores distintos: no lo decide la herramienta

      const archive = [];
      const ya = new Set(rp.archiveIds || []);
      for (const id of (rp.archiveIds || [])) archive.push(id);
      for (const p of (g.params || [])) {
        if (p.rowId === dec.winnerRowId || ya.has(p.rowId)) continue;
        archive.push(p.rowId);
      }
      const repone = (rp.action === 'rewrite' && rp.insertParamId != null)
        ? { specFieldId: g.fieldId, specFieldParamId: rp.insertParamId }
        : null;
      if (!archive.length && !repone) continue;
      out.push({ key: g.key, pnId: g.pnId, fieldId: g.fieldId, archive, repone });
    }
    return out;
  }

  /**
   * ¿El ERP está aguantando el ritmo? Decide desde los tiempos de respuesta recientes.
   *
   * Medido el 2026-07-29: tras un día de escaneos pesados, una consulta trivial tardó 24 s y
   * el /graphql dejó de responder varias veces —sin devolver 429—. Seguir empujando en ese
   * estado es lo que deja corridas a medias. Más vale ir lento que dejar datos rotos.
   *
   * @param {number[]} muestrasMs  duraciones recientes, la última al final
   * @returns {{degradado:boolean, pausaMs:number, medianaMs:number}}
   */
  function erpHealth(muestrasMs) {
    const m = (muestrasMs || []).filter(x => typeof x === 'number' && x >= 0);
    if (m.length < 3) return { degradado: false, pausaMs: 0, medianaMs: 0 };
    const ord = m.slice().sort((a, b) => a - b);
    const mediana = ord[Math.floor(ord.length / 2)];
    const ultimas = m.slice(-3);
    const promUlt = ultimas.reduce((s, x) => s + x, 0) / ultimas.length;

    // Umbrales por tiempo absoluto: lo que importa es si el server ya está sufriendo.
    if (promUlt >= 8000) return { degradado: true, pausaMs: 30000, medianaMs: mediana };
    if (promUlt >= 4000) return { degradado: true, pausaMs: 10000, medianaMs: mediana };
    if (promUlt >= 2000) return { degradado: true, pausaMs: 3000, medianaMs: mediana };
    return { degradado: false, pausaMs: 0, medianaMs: mediana };
  }

  /**
   * Plan del BARRIDO por cliente: qué falta por procesar y qué se lleva acumulado.
   *
   * El troceo por cliente no es cosmético: cada lote es chico (decenas, no miles), el
   * checkpoint cae en una frontera natural, y si algo falla el alcance es UN cliente.
   *
   * @param {Array<{id,name}>} clientes
   * @param {{done:number[], totales?:object}|null} checkpoint
   */
  function planCustomerSweep(clientes, checkpoint) {
    const done = new Set(((checkpoint && checkpoint.done) || []).map(Number));
    const base = (checkpoint && checkpoint.totales) || {};
    return {
      pendientes: (clientes || []).filter(c => c && !done.has(Number(c.id))),
      yaHechos: done.size,
      totales: {
        archivados: base.archivados || 0,
        repuestos: base.repuestos || 0,
        errores: base.errores || 0,
        clientes: base.clientes || 0
      }
    };
  }

  /** Suma lo de un cliente al acumulado del barrido. */
  function mergeSweepTotals(acum, delta) {
    const a = acum || {};
    const d = delta || {};
    return {
      archivados: (a.archivados || 0) + (d.archivados || 0),
      repuestos: (a.repuestos || 0) + (d.repuestos || 0),
      errores: (a.errores || 0) + (d.errores || 0),
      clientes: (a.clientes || 0) + 1
    };
  }

  /**
   * Decide qué hacer con UN field "falso pendiente" de un PN.
   * @param {Array<{id, archivedAt, processNodeId, paramId, paramName}>} fieldRows
   *        TODAS las filas (activas y archivadas) del MISMO specFieldId en el PN.
   * @param {{newParamId, newParamName}} ctx  el param del catálogo vigente que se quería asignar.
   * @returns {{action, oldRowId?, oldParamId?, oldParamName?, activeRowIds?}}
   *   - 'normalize'      → hay 1 fila activa, mismo nombre, distinto id → migrar (oldRowId a archivar).
   *   - 'already'        → la activa YA es el id del catálogo → nada que hacer.
   *   - 'non-equivalent' → la activa tiene OTRO nombre → NO tocar (cambiaría el valor); reportar.
   *   - 'no-active'      → no hay fila activa → era pendiente real (no falso).
   *   - 'ambiguous'      → 2+ filas activas en el mismo field → dejar al validador de duplicados.
   */
  function planFieldNormalization(fieldRows, ctx) {
    const rows = Array.isArray(fieldRows) ? fieldRows : [];
    const active = rows.filter(function (r) { return r && !r.archivedAt; });
    if (active.length === 0) return { action: 'no-active' };
    if (active.length > 1) return { action: 'ambiguous', activeRowIds: active.map(function (r) { return r.id; }) };
    const target = active[0];
    if (String(target.paramId) === String(ctx.newParamId)) {
      return { action: 'already', oldRowId: target.id, oldParamId: target.paramId, oldParamName: target.paramName };
    }
    if (norm(target.paramName) !== norm(ctx.newParamName)) {
      return { action: 'non-equivalent', oldRowId: target.id, oldParamId: target.paramId, oldParamName: target.paramName };
    }
    return { action: 'normalize', oldRowId: target.id, oldParamId: target.paramId, oldParamName: target.paramName };
  }

  /**
   * Extrae, del response de GetPartNumber, las filas (activas+archivadas) de un specFieldId dado.
   * @param {object} pnNode  partNumberById
   * @param {string|number} specFieldId
   * @returns {Array<{id, archivedAt, processNodeId, paramId, paramName}>}
   */
  function extractFieldRows(pnNode, specFieldId) {
    const nodes = (pnNode && pnNode.partNumberSpecFieldParamsByPartNumberId && pnNode.partNumberSpecFieldParamsByPartNumberId.nodes) || [];
    const out = [];
    for (const p of nodes) {
      const sfp = p && p.specFieldParamBySpecFieldParamId;
      if (!sfp) continue;
      const sfId = sfp.specFieldSpecBySpecFieldSpecId
        && sfp.specFieldSpecBySpecFieldSpecId.specFieldBySpecFieldId
        && sfp.specFieldSpecBySpecFieldSpecId.specFieldBySpecFieldId.id;
      if (String(sfId) !== String(specFieldId)) continue;
      out.push({ id: p.id, archivedAt: p.archivedAt, processNodeId: p.processNodeId, paramId: sfp.id, paramName: sfp.name });
    }
    return out;
  }

  const api = { planFieldNormalization: planFieldNormalization, extractFieldRows: extractFieldRows,
                planForcedNodeRelease: planForcedNodeRelease, planApplyUnits: planApplyUnits,
                erpHealth: erpHealth, planCustomerSweep: planCustomerSweep,
                mergeSweepTotals: mergeSweepTotals, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SpecMigratorNormalize = api;
})();
