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

  // Código de línea del prefijo del nombre: "T205-TI00-019…" → "T205". Espeja
  // ProcessShared.extractLineCodeFromName (se re-implementa para mantener el
  // módulo puro / testeable en node sin cargar process-shared).
  function extractLineCode(name) {
    const m = String(name || '').trim().match(/^(T\d{2,4}|M\d{2,4})\b/i);
    return m ? m[1].toUpperCase() : null;
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
  function diffRoutes(desiredRoutes, activeRoutes) {
    const activeByNode = new Map();
    for (const a of activeRoutes || []) {
      if (a && a.recipeNodeId != null) activeByNode.set(a.recipeNodeId, a);
    }
    const routesToCreate = [];
    const routesToUpdate = [];
    const routesToDelete = [];
    const desiredNodes = new Set();
    for (const r of desiredRoutes || []) {
      desiredNodes.add(r.recipeNodeId);
      const a = activeByNode.get(r.recipeNodeId);
      if (!a) routesToCreate.push(r);
      else if (a.stationId !== r.stationId) routesToUpdate.push({ id: a.id, stationId: r.stationId });
      // misma tina → no-op
    }
    for (const a of activeRoutes || []) {
      if (a && a.id != null && !desiredNodes.has(a.recipeNodeId)) routesToDelete.push(a.id);
    }
    return { routesToCreate, routesToUpdate, routesToDelete };
  }

  // Líneas destino VÁLIDAS para re-rutear: solo las del tratamiento de nivel-línea
  // (grupo Planificación) de la sección origen — sus candidatas son stations "-LI"
  // (selectores de línea) y la lista incluye la línea origen + sus destinos válidos.
  // NO la unión de todos los tratamientos (los enjuagues arrastran ~25 líneas).
  // Fallback a la unión si no se detecta un selector de línea.
  function destinationLines(candidatesByTreatment, sourceLine) {
    const cbt = candidatesByTreatment || {};
    const selector = new Set();
    let found = false;
    for (const tId of Object.keys(cbt)) {
      const li = (cbt[tId] || []).filter((s) => isLineStation(s && s.name));
      if (!li.length) continue;
      const lines = li.map((s) => extractLineCode(s.name)).filter(Boolean);
      if (!lines.includes(sourceLine)) continue; // el selector de ESTA sección incluye su línea origen
      found = true;
      for (const c of lines) if (c !== sourceLine) selector.add(c);
    }
    if (found) return [...selector].sort();
    const set = new Set();
    for (const tId of Object.keys(cbt)) for (const s of (cbt[tId] || [])) {
      const code = extractLineCode(s && s.name);
      if (code && code !== sourceLine) set.add(code);
    }
    return [...set].sort();
  }

  const api = { computeRoutes, diffRoutes, extractLineCode, physPos, isLineStation, destinationLines, roleMatch, pickMomentum, isRinsePool };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoRouterEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
