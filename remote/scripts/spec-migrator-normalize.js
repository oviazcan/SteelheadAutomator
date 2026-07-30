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
      // Campos que el ERP rechazó reponer porque ya tenían su fila viva. Se llevan aparte
      // para que "reparados" signifique daño realmente corregido y no intentos.
      yaEstaban: (a.yaEstaban || 0) + (d.yaEstaban || 0),
      errores: (a.errores || 0) + (d.errores || 0),
      clientes: (a.clientes || 0) + 1
    };
  }

  /**
   * REPARADOR: campos que quedaron sin parámetro activo porque se archivó y la reposición
   * falló.
   *
   * Origen (2026-07-30): una corrida del apply en dos fases archivó ~21 000 parámetros y las
   * reposiciones fallaron en masa contra un ERP que devolvía HTTP 500. Los datos no se
   * perdieron —están archivados—, así que reponer el MISMO sfp deja el NP como debía quedar,
   * y de paso sin nodo forzado, que era el objetivo.
   *
   * Tres candados:
   *  · si el campo YA tiene un parámetro activo, no se toca (no duplica);
   *  · solo mira archivados POSTERIORES al corte (no resucita archivados legítimos viejos);
   *  · si los archivados recientes de un campo tienen valores DISTINTOS, no repone: elegir el
   *    criterio de calidad no le toca a una herramienta.
   *
   * @param {Array<{id,archivedAt,processNodeId,paramId,paramName,fieldId,sfsId}>} filas
   *        TODAS las filas (activas y archivadas) de un NP, ya aplanadas.
   * @param {number} corteMs  epoch ms; solo cuentan los archivados desde aquí.
   * @returns {Array<{specFieldId,specFieldParamId,paramName,processNodeId:null,sfsId}>}
   */
  function planRepairs(filas, corteMs) {
    const rows = Array.isArray(filas) ? filas.filter(Boolean) : [];
    const porCampo = new Map();
    for (const f of rows) {
      // Se agrupa por specFieldId A SECAS — es el criterio que aplica el ERP (regla 1.4.38:
      // "1 fila viva por SpecField"), no por (campo, specFieldSpec).
      //
      // POR QUÉ IMPORTA (2026-07-30): un mismo campo puede venir de DOS specs del NP. Ej. real:
      // Adherencia (15820) del NP 73449-553-04 vive en sfs=150436 (Níquel, ACTIVO) y en
      // sfs=106116 (Estaño, archivado). Agrupando por (campo, sfs), el bucket del Estaño se veía
      // "sin activo" y proponía reponer — pero el campo YA estaba cubierto. El ERP rechazaba esa
      // reposición con 23P01, así que no se corrompió nada; lo que se inflaba era el CONTADOR,
      // porque el apply cuenta 'duplicate' como reparado. Es el mismo error de agrupación que
      // hizo que la primera validación reportara 51 campos rotos donde había cero.
      const k = String(f.fieldId);
      if (!porCampo.has(k)) porCampo.set(k, { fieldId: f.fieldId, sfsId: f.sfsId, act: 0, arch: [] });
      const e = porCampo.get(k);
      if (!f.archivedAt) { e.act++; continue; }
      const t = Date.parse(f.archivedAt);
      if (isFinite(t) && t >= corteMs) e.arch.push({ t, paramId: f.paramId, paramName: f.paramName });
    }

    const out = [];
    for (const e of porCampo.values()) {
      if (e.act > 0) continue;          // ya tiene parámetro: nada que reparar
      if (!e.arch.length) continue;     // no lo tocó esta corrida
      const nombres = new Set(e.arch.map(a => norm(a.paramName)));
      if (nombres.size > 1) continue;   // valores distintos: no se decide solo
      const ganador = e.arch.slice().sort((a, b) => b.t - a.t)[0];
      out.push({
        specFieldId: e.fieldId,
        specFieldParamId: ganador.paramId,
        paramName: ganador.paramName,
        processNodeId: null,            // el objetivo: que quede SIN nodo
        sfsId: e.sfsId
      });
    }
    return out;
  }

  /**
   * De dónde sale la lista de clientes de un barrido: del checkpoint o del servidor.
   *
   * Por qué existe: el listado iba ANTES de leer el checkpoint, así que un fallo transitorio
   * del ERP —hoy frecuentes— mataba la corrida y dejaba el avance guardado pero inalcanzable.
   * "Pasó varios clientes, pero aún así me bota el error de nuevo." Guardando la lista dentro
   * del checkpoint, reanudar deja de depender de que el servidor conteste.
   *
   * @param {{clientes?:Array}|null} checkpoint
   * @param {Array|null} frescos  lo que devolvió el servidor (vacío si falló)
   * @returns {{clientes:Array, origen:'servidor'|'checkpoint'|'ninguno'}}
   */
  function resolveCustomerList(checkpoint, frescos) {
    const guardados = (checkpoint && Array.isArray(checkpoint.clientes)) ? checkpoint.clientes : [];
    const nuevos = Array.isArray(frescos) ? frescos : [];
    // La lista fresca solo gana si de verdad aporta: si el listado falló (vacío) o vino corto,
    // se sigue con la guardada — reanudar no puede quedar a merced del servidor.
    if (nuevos.length && nuevos.length >= guardados.length) return { clientes: nuevos, origen: 'servidor' };
    if (guardados.length) return { clientes: guardados, origen: 'checkpoint' };
    return { clientes: [], origen: 'ninguno' };
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
                mergeSweepTotals: mergeSweepTotals, planRepairs: planRepairs, resolveCustomerList: resolveCustomerList, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SpecMigratorNormalize = api;
})();
