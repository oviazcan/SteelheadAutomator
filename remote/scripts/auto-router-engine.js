// auto-router-engine.js — MOTOR PURO del autoruteador (sin DOM, sin red, sin closure).
//
// Dual-export: window.AutoRouterEngine (browser) / module.exports (node --test).
//
// Dado el árbol de recipeNodes de una WO + las tinas (stations) candidatas por
// tratamiento + la línea origen/destino, produce la lista completa de rutas
// {recipeNodeId -> stationId} que se envía a CreateUpdateDeleteRoutes.
//
// Modelo (descubierto del tráfico real, ver docs/applets/auto-router.md):
//   · Cada recipeNode con treatmentId corre en una "tina" (station). Re-rutear =
//     cambiar la station, NO el treatment.
//   · El nombre de la tina codifica línea + posición física: "T205-TI00-019 Enjuague".
//   · Solo se re-rutean los nodos cuya tina DEFAULT pertenece a la línea origen;
//     los bloques de otras líneas (T300 …) conservan su tina default.
//   · La mutación lleva TODAS las rutas (las cambiadas y las conservadas).
//
// Regla de mapeo (validada contra ground-truth WO 1760978, T204→T205):
//   1. bypass     — nodo de otra línea  → conserva default.
//   2. role-match — la tina default tiene un rol distintivo (Recuperador, Flash,
//                   IMMSA, Caliente) → toma la candidata destino con ese rol.
//   3. single     — el tratamiento tiene 1 sola tina en destino → reúso.
//   4. momentum   — varias tinas (enjuagues): consume la tina destino sin usar más
//                   cercana al ancla (la tina del paso padre), con inercia de
//                   dirección (asc/desc) — el patrón serpentino de la línea física.
//
// El resultado es best-effort para los enjuagues genéricos; el panel muestra un
// preview EDITABLE para que el operador ajuste los pocos que el heurístico no
// clave. Las anclas (pasos de proceso de 1 sola tina) y los roles distintivos se
// reproducen al 100%.

(function (root) {
  'use strict';

  // Código de línea del prefijo del nombre: "T205-TI00-019…" → "T205". Nació espejando a
  // ProcessShared.extractLineCodeFromName (re-implementado para mantener el módulo puro /
  // testeable en node sin cargar process-shared) y desde 2026-08-04 YA NO LO ESPEJA: aquél
  // sigue cortando a 3 dígitos. Es deliberado — `process-shared` no rutea material, secciona
  // árboles de proceso (`buildLineSections`) y agrupa procesos compartidos para auditoría, así
  // que aplicarle esta regla cambiaría cómo se seccionan los árboles y cómo agregan los reportes
  // históricos: es su propia decisión, no un efecto colateral de ésta. `auto-router` no carga
  // `process-shared`, así que las dos conviven sin tocarse.
  //
  // EXCEPCIÓN TX00 (2026-08-04, a petición del operador): un código de letra + 3 dígitos que
  // termina en "00" NO es una línea, es un ÁREA que agrupa destinos sin relación entre sí —
  // T300-CE03 Antitarnish vs T300-CE05 Limpieza Especial; T100-SA01 Sandblast vs T100-IC00
  // Inspección y Empaque; T000-SPR Surtimiento vs T000-MA00 Maquila. Las líneas de producción
  // son T101…T120, T201…T208, T301, T302, T401, T501 y NINGUNA termina en 00.
  //
  // Por qué le importa AL RUTEADOR y no sólo al filtro: la pregunta que hace `computeRoutes` con
  // este código es «¿este nodo pertenece a la línea que estoy moviendo?» (bypass). Con el corte a
  // 3 dígitos, dos células que no comparten nada respondían que SÍ, así que una orden que corriera
  // dentro de un área podía re-rutearse entre células distintas como si fueran tinas hermanas.
  // Para una línea real el corte a 3 dígitos SIGUE siendo el correcto: sus TI00/EN00/SE00/LI son
  // PASOS suyos, y partirlos rompería el ruteo T204→T205 validado 22/22 contra ground-truth.
  //
  // La misma regla vive en surtido-guard-filter-core.lineCodeFromStationText. Son dos
  // implementaciones a propósito (los regex base difieren: aquí anclado al inicio y con T\d{2,4};
  // allá sin anclar porque la celda trae el prefijo "at "), atadas por
  // tools/test/line-code-area-parity.test.js para que no puedan derivar en silencio.
  const AREA_CODE_RE = /^[A-Z]\d00$/;

  function extractLineCode(name) {
    // El segundo segmento sólo cuenta si el guion viene PEGADO al código: "T100 (LMC)-CU/BR-VARIOS"
    // es un nombre de PROCESO, no de estación, y ahí "CU" no es ningún destino. Sin él se degrada
    // al área — perder granularidad es tolerable; inventar un destino no.
    const m = String(name || '').trim().match(/^(T\d{2,4}|M\d{2,4})\b(?:-([A-Za-z0-9]+))?/i);
    if (!m) return null;
    const base = m[1].toUpperCase();
    if (!AREA_CODE_RE.test(base) || !m[2]) return base;
    return base + '-' + m[2].toUpperCase();
  }

  // Posición física dentro de la línea: "T205-TI00-019 Enjuague" → 19,
  // "T205-EN00-001 Enracado" → 1. Las tinas cabecera (T205-LI …) → null.
  function physPos(name) {
    const m = String(name || '').match(/-[A-Z]{2}\d{2}-(\d{3})\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Station de nivel LÍNEA ("-LI"): el selector de línea de un tratamiento de
  // Planificación (ej. "T205-LI Plata y Estaño s/Barras"). Las tinas individuales
  // (T205-TI00-019, T205-EN00-001) NO lo son. Sirve para acotar las líneas destino
  // a las realmente ruteables (grupo de tratamiento Planificación), no toda línea
  // que tenga un enjuague.
  function isLineStation(name) {
    return /-LI\b/i.test(String(name || ''));
  }

  // Roles distintivos que desambiguan tinas del MISMO tratamiento por nombre.
  // (Un "Enjuague Recuperador" T204 mapea al "Enjuague Recuperador" T205, no a un
  // enjuague genérico cualquiera.) Orden = prioridad de match.
  const ROLE_KEYWORDS = ['recuperador', 'caliente', 'flash', 'immsa'];

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Si la tina default tiene un rol distintivo y existe una candidata destino con
  // ese mismo rol, devuelve esa candidata; si no, null.
  function roleMatch(defaultName, dest) {
    const dn = norm(defaultName);
    for (const kw of ROLE_KEYWORDS) {
      if (!dn.includes(kw)) continue;
      const hits = dest.filter((s) => norm(s.name).includes(kw));
      if (hits.length) {
        // empata por posición ascendente para determinismo.
        return hits.slice().sort((a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9))[0];
      }
    }
    return null;
  }

  // Un "pool de enjuague" (tinas intercambiables de flujo, ≥3 y mayormente
  // "Enjuague") se CONSUME una vez por tina; un tanque de proceso con variantes
  // (ej. 2 tinas de Decapado Nítrico) se REÚSA. La diferencia define si momentum
  // descarta las tinas ya usadas o no.
  function isRinsePool(dest) {
    if (!Array.isArray(dest) || dest.length < 3) return false;
    const rinse = dest.filter((s) => /enjuague|rinse/i.test(s && s.name)).length;
    return rinse >= dest.length / 2;
  }

  // Elige la tina destino para un nodo multi-candidato: la más cercana al ancla,
  // con inercia de dirección. Si `consume`, descarta las tinas ya usadas (enjuagues);
  // si no, permite reúso (tanques de proceso con variantes).
  function pickMomentum(dest, used, anchorPos, dir, consume) {
    const withPos = dest.filter((s) => s.pos != null);
    let pool = consume ? withPos.filter((s) => !used.has(s.id)) : withPos;
    if (!pool.length) pool = withPos.length ? withPos : dest.slice(); // agotado → permite reúso
    if (!pool.length) return dest[0] || null;
    const ref = anchorPos != null ? anchorPos : (pool[0].pos ?? 0);
    // candidatas en la dirección actual (incl. la propia ancla); si ninguna, todas.
    const forward = pool.filter((s) => (dir >= 0 ? (s.pos ?? 0) >= ref : (s.pos ?? 0) <= ref));
    const cand = forward.length ? forward : pool;
    return cand.slice().sort((a, b) => {
      const da = Math.abs((a.pos ?? 0) - ref);
      const db = Math.abs((b.pos ?? 0) - ref);
      if (da !== db) return da - db;
      // empate: respeta la dirección (la que avanza en `dir`).
      return dir >= 0 ? (a.pos ?? 0) - (b.pos ?? 0) : (b.pos ?? 0) - (a.pos ?? 0);
    })[0];
  }

  // ── API pública ──────────────────────────────────────────────────────────────
  // computeRoutes(input) → { routes, skipped, warnings }
  //   input: {
  //     recipeNodes: [{ id, name, treatmentId, recipeInd, parentRecipeNodeId,
  //                     defaultStation: { id, name } | null }],
  //     candidatesByTreatment: { [treatmentId]: [{ id, name }] },  // todas las líneas
  //     sourceLineCode, destLineCode,
  //     partNumberId, workOrderId,
  //     partGroupId?,            // default null
  //   }
  //   routes:  [{ recipeNodeId, treatmentId, stationId, partNumberId, workOrderId, partGroupId }]
  //   skipped: [{ recipeNodeId, name, treatmentId, reason }]
  //   warnings: string[]
  function computeRoutes(input) {
    const {
      recipeNodes = [],
      candidatesByTreatment = {},
      sourceLineCode,
      destLineCode,
      partNumberId,
      workOrderId,
      partGroupId = null,
    } = input || {};

    const routes = [];
    const skipped = [];
    const warnings = [];

    const candOf = (tId) => candidatesByTreatment[tId] || candidatesByTreatment[String(tId)] || [];
    const mkRoute = (node, stationId) => ({
      recipeNodeId: node.id,
      treatmentId: node.treatmentId,
      stationId,
      partNumberId,
      workOrderId,
      partGroupId,
    });

    const nodes = recipeNodes
      .filter((n) => n && n.treatmentId != null)
      .slice()
      .sort((a, b) => (a.recipeInd ?? 0) - (b.recipeInd ?? 0));

    const assignedPosByNode = new Map(); // recipeNodeId -> physPos de la tina asignada
    const usedByTreatment = new Map();   // treatmentId -> Set(stationId) consumidas
    let lastPos = null;                  // cursor global
    let dir = 1;                         // inercia de dirección

    const usedSet = (tId) => {
      if (!usedByTreatment.has(tId)) usedByTreatment.set(tId, new Set());
      return usedByTreatment.get(tId);
    };

    for (const node of nodes) {
      const tId = node.treatmentId;
      const def = node.defaultStation || null;
      const nodeLine = def ? extractLineCode(def.name) : null;

      // 1. bypass — nodo fuera de la línea origen conserva su tina default.
      if (nodeLine !== sourceLineCode) {
        if (def && def.id != null) {
          routes.push(mkRoute(node, def.id));
          if (def.name) { const p = physPos(def.name); if (p != null) assignedPosByNode.set(node.id, p); }
        } else {
          skipped.push({ recipeNodeId: node.id, name: node.name, treatmentId: tId, reason: 'sin_tina_default' });
        }
        continue;
      }

      // candidatas en la línea destino (schedulingStations ya viene filtrado por grupo).
      const dest = candOf(tId)
        .filter((s) => s && extractLineCode(s.name) === destLineCode)
        .map((s) => ({ id: s.id, name: s.name, pos: physPos(s.name) }));

      if (!dest.length) {
        skipped.push({ recipeNodeId: node.id, name: node.name, treatmentId: tId, reason: 'sin_tina_destino' });
        warnings.push(`${node.name || ('nodo ' + node.id)}: sin tina en ${destLineCode} para treatment ${tId}`);
        continue;
      }

      // 2/3/4. role-match → single → momentum.
      let chosen = roleMatch(def && def.name, dest);
      if (!chosen) {
        if (dest.length === 1) {
          chosen = dest[0];
        } else {
          const consume = isRinsePool(dest); // enjuagues se consumen; tanques de proceso se reúsan.
          // Un nodo SIN rol distintivo no debe robar una tina de rol (recuperador,
          // caliente): se reservan para su nodo. Si el pool genérico queda vacío,
          // cae a todas las candidatas.
          const defHasRole = ROLE_KEYWORDS.some((kw) => norm(def && def.name).includes(kw));
          let pool = dest;
          if (!defHasRole) {
            const generic = dest.filter((s) => !ROLE_KEYWORDS.some((kw) => norm(s.name).includes(kw)));
            if (generic.length) pool = generic;
          }
          const parentPos = assignedPosByNode.has(node.parentRecipeNodeId)
            ? assignedPosByNode.get(node.parentRecipeNodeId)
            : null;
          const anchorPos = parentPos != null ? parentPos : lastPos;
          chosen = pickMomentum(pool, usedSet(tId), anchorPos, dir, consume);
        }
      }
      if (!chosen) {
        skipped.push({ recipeNodeId: node.id, name: node.name, treatmentId: tId, reason: 'sin_tina_destino' });
        continue;
      }

      routes.push(mkRoute(node, chosen.id));
      usedSet(tId).add(chosen.id);
      if (chosen.pos != null) {
        assignedPosByNode.set(node.id, chosen.pos);
        if (lastPos != null && chosen.pos !== lastPos) dir = chosen.pos > lastPos ? 1 : -1;
        lastPos = chosen.pos;
      }
    }

    return { routes, skipped, warnings };
  }

  // Convierte el estado deseado (salida de computeRoutes, ya con ediciones del
  // operador) + las rutas activas de la WO en el payload de la mutación:
  //   · routesToCreate — recipeNode sin ruta activa.
  //   · routesToUpdate — recipeNode con ruta activa pero distinta tina → {id, stationId}.
  //   · routesToDelete — ruta activa cuyo recipeNode ya no se rutea → [id].
  //   · (tina sin cambio → se omite, no-op).
  // activeRoutes: nodos crudos de StationTreatmentByWorkOrder.activeRoutes
  //   ({ id, stationId, recipeNodeId, ... }).
  // Una PISTA de ruteo es (recipeNode, partGroup). La global es la pista de partGroup
  // null; cada grupo con override tiene la suya, y ambas COEXISTEN para el mismo
  // recipeNode (evidencia en vivo WO 15074: "Recibo de Orden" aparece dos veces, una
  // sin grupo → T204 y otra del grupo 2 → T205, y la del grupo gana para ese grupo).
  // Indexar solo por recipeNodeId hacía que la override pisara a la global en el Map:
  // el diff podía mover el grupo equivocado o borrarle sus rutas.
  const laneKey = (recipeNodeId, partGroupId) => `${recipeNodeId}::${partGroupId ?? 'null'}`;

  function diffRoutes(desiredRoutes, activeRoutes) {
    const activeByLane = new Map();
    for (const a of activeRoutes || []) {
      if (a && a.recipeNodeId != null) activeByLane.set(laneKey(a.recipeNodeId, a.partGroupId), a);
    }
    const routesToCreate = [];
    const routesToUpdate = [];
    const routesToDelete = [];
    const desiredLanes = new Set();
    // Solo se tocan las pistas que el llamador declaró al pedir estas rutas. Sin rutas
    // deseadas no hay pista declarada → no se borra nada (fail-safe).
    const scopedGroups = new Set();
    for (const r of desiredRoutes || []) {
      desiredLanes.add(laneKey(r.recipeNodeId, r.partGroupId));
      scopedGroups.add(r.partGroupId ?? null);
      const a = activeByLane.get(laneKey(r.recipeNodeId, r.partGroupId));
      if (!a) routesToCreate.push(r);
      else if (a.stationId !== r.stationId) routesToUpdate.push({ id: a.id, stationId: r.stationId });
      // misma tina → no-op
    }
    for (const a of activeRoutes || []) {
      if (!a || a.id == null) continue;
      if (!scopedGroups.has(a.partGroupId ?? null)) continue; // otra pista: no es asunto nuestro
      if (!desiredLanes.has(laneKey(a.recipeNodeId, a.partGroupId))) routesToDelete.push(a.id);
    }
    return { routesToCreate, routesToUpdate, routesToDelete };
  }

  // Líneas destino VÁLIDAS para re-rutear: TODAS las del tratamiento de nivel-línea
  // (grupo Planificación) de la sección origen — sus candidatas son stations "-LI"
  // (selectores de línea). NO la unión de todos los tratamientos (los enjuagues
  // arrastran ~25 líneas). Fallback a la unión si no hay selector de línea.
  //
  // Se ofrecen TODAS las líneas del selector (incluida la origen/actual): NO se excluye
  // ninguna. Detectar "la línea actual" es ambiguo (una orden movida tiene activeRoutes
  // mixtas: tinas físicas de una línea + selector "-LI" de otra), así que esconder líneas
  // rompía el caso "devolver la orden a su línea original" (bug Image #6: una orden movida
  // T204→T205 ya no mostraba T204 para regresarla). En vez de esconder, el batch usa los
  // CAMBIOS REALES (effectiveChangeCount) para el conteo y el botón Aplicar: elegir la
  // línea donde ya está da 0 cambios; cualquier otra (incl. devolver a la original) aplica.
  function destinationLines(candidatesByTreatment, sourceLine) {
    const cbt = candidatesByTreatment || {};
    const selectorTreatments = [];
    for (const tId of Object.keys(cbt)) {
      const li = (cbt[tId] || []).filter((s) => isLineStation(s && s.name));
      if (!li.length) continue;
      const lines = li.map((s) => extractLineCode(s.name)).filter(Boolean);
      if (lines.includes(sourceLine)) selectorTreatments.push(tId); // selector de ESTA sección
    }
    const set = new Set();
    if (selectorTreatments.length) {
      for (const tId of selectorTreatments) for (const s of cbt[tId]) {
        const c = extractLineCode(s.name); if (c) set.add(c);
      }
    } else {
      for (const tId of Object.keys(cbt)) for (const s of (cbt[tId] || [])) {
        const code = extractLineCode(s && s.name); if (code) set.add(code);
      }
    }
    return [...set].sort();
  }

  // Station EFECTIVA de cada recipeNode = la activeRoute si existe, si no la default.
  // Estado efectivo de la PISTA `partGroupId` con la HERENCIA real de Steelhead:
  // override del grupo → ruta global → default de la receta. Con partGroupId null se
  // mira solo la global (las override de otros grupos no son asunto de esa pista).
  // Antes se indexaba por recipeNodeId a secas, así que en una orden con override la
  // ruta del grupo pisaba a la global y el conteo de tinas / la línea de origen salían
  // mezclados.
  function effectiveStationByNode(recipeNodes, activeRoutes, partGroupId = null) {
    const own = new Map();
    const global = new Map();
    for (const a of activeRoutes || []) {
      if (!a || a.recipeNodeId == null) continue;
      const pg = a.partGroupId ?? null;
      if (pg === null) global.set(a.recipeNodeId, a.stationId);
      else if (partGroupId != null && pg === partGroupId) own.set(a.recipeNodeId, a.stationId);
    }
    const eff = new Map();
    for (const n of recipeNodes || []) {
      if (!n) continue;
      if (own.has(n.id)) eff.set(n.id, own.get(n.id));
      else if (global.has(n.id)) eff.set(n.id, global.get(n.id));
      else if (n.defaultStation && n.defaultStation.id != null) eff.set(n.id, n.defaultStation.id);
    }
    return eff;
  }

  // Cambios REALES de un set de rutas deseadas vs el estado efectivo actual
  // (activeRoute ?? default). Un nodo cuenta si su tina deseada difiere de la efectiva.
  // Esto es la verdad para el conteo "tinas a re-rutear" y el filtro "aplicable":
  // independiente de comparar líneas (que falla con órdenes movidas).
  function effectiveChangeCount(recipeNodes, desiredRoutes, activeRoutes, partGroupId = null) {
    const eff = effectiveStationByNode(recipeNodes, activeRoutes, partGroupId);
    let n = 0;
    for (const r of desiredRoutes || []) if (r.stationId !== eff.get(r.recipeNodeId)) n++;
    return n;
  }

  // Línea EFECTIVA actual (best-effort, para mostrar el "Origen"): la línea de la tina
  // física (con posición) más frecuente entre las stations efectivas. Las "-LI" y nodos
  // sin posición no cuentan (no son tinas de proceso). Fallback: null.
  function currentLineCode(recipeNodes, activeRoutes, candidatesByTreatment, partGroupId = null) {
    const nameById = new Map();
    for (const n of recipeNodes || []) if (n && n.defaultStation && n.defaultStation.id != null) nameById.set(n.defaultStation.id, n.defaultStation.name);
    for (const tId of Object.keys(candidatesByTreatment || {})) for (const s of (candidatesByTreatment[tId] || [])) if (s && s.id != null) nameById.set(s.id, s.name);
    const eff = effectiveStationByNode(recipeNodes, activeRoutes, partGroupId);
    const freq = new Map();
    for (const [, sid] of eff) {
      const name = nameById.get(sid);
      const line = extractLineCode(name);
      if (line && physPos(name) != null) freq.set(line, (freq.get(line) || 0) + 1);
    }
    let best = null, k = 0;
    for (const [l, c] of freq) if (c > k) { best = l; k = c; }
    return best;
  }

  const api = { computeRoutes, diffRoutes, extractLineCode, physPos, isLineStation, destinationLines, effectiveStationByNode, effectiveChangeCount, currentLineCode, roleMatch, pickMomentum, isRinsePool };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoRouterEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
