// bulk-upload-packing.js — núcleo PURO de las "Instrucciones de Empaque" (plantilla v13).
//
// Qué son: NO son un campo del número de parte. Son una `ProcessNodeDescription`, o sea la
// descripción de la tupla (PN, nodo de proceso). En el ERP se editan desde la ficha del PN,
// sobre el nodo de empaque, y se guardan con `SaveManyPartNumberProcessNodeDescriptionsAndFiles`.
//
// TRES entidades distintas que NO hay que confundir (la de en medio es la peligrosa):
//   1. `partNumber.descriptionMarkdown`        → descripción del PN. Otra cosa.
//   2. `processNode.descriptionMarkdown`       → descripción GLOBAL del nodo, COMPARTIDA por
//      todos los PNs (en producción trae el aviso rojo "No olvidar empacar conforme a
//      requerimientos del cliente..."). Escribir aquí afectaría a TODO el dominio.
//   3. `ProcessNodeDescription` (PN + nodo)    → ESTA es la que escribimos.
//
// Este módulo es puro y sin dependencias: decide QUÉ hacer y CONTRA QUÉ NODO, sin hablar con
// la red. El glue de bulk-upload ejecuta.

(function () {
  'use strict';

  // ── Normalización de nombres de nodo ────────────────────────────────────────
  // El nodo se liga por NOMBRE, no por id: los ids son por dominio, así que un id fijo
  // funcionaría en TLC y escribiría en el nodo equivocado —o en ninguno— en MTY.
  // Se normaliza acentos/espacios/mayúsculas porque el catálogo trae nombres tecleados a
  // mano (en el árbol real conviven "Inspeccionando y  Empacando" con doble espacio).
  function normNodeName(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ── Decisión por celda ──────────────────────────────────────────────────────
  // Contrato de la columna, idéntico al del resto de la plantilla:
  //   vacío  → 'skip'  (no tocar: el PN conserva lo que tenga)
  //   "-"    → 'clear' (borrar: se escribe descriptionMarkdown "" — no hay mutation de borrado)
  //   dato   → 'set'   (sustituir por el texto tal cual)
  //
  // El texto va CRUDO a `descriptionMarkdown`: el campo es markdown y en producción ya
  // convive con HTML inline (<span style="color: red;">). No se escapa ni se recorta nada
  // salvo los espacios de los extremos, que son ruido de Excel.
  function planPackingInstruction(raw) {
    if (raw == null) return { action: 'skip', markdown: null };
    const s = String(raw).trim();
    if (!s) return { action: 'skip', markdown: null };
    if (s === '-') return { action: 'clear', markdown: '' };
    return { action: 'set', markdown: s };
  }

  // ── Resolución del nodo destino ─────────────────────────────────────────────
  // Recibe el árbol de nodos del proceso del PN (aplanado a {id, name}) y el nombre
  // configurado del nodo de empaque. Devuelve el id SOLO si hay exactamente UNA
  // coincidencia exacta.
  //
  // Por qué exacta y por qué exactamente una: en el árbol real conviven "Preparando
  // Embarque en Almacén", "Listo para Preparar Embarque en Almacén", "SP Preparación de
  // Embarque en Almacén" y "SP Embarque en Almacén". Un match por subcadena devuelve 4 y
  // elegir "el primero" escribiría las instrucciones en un paso que el operador no mira.
  // Ante 0 o >1, NO se adivina: se reporta y el PN se salta (misma regla que usa
  // wo-spec-params para el nodo de inspección).
  function resolvePackingNode(nodes, nodeName) {
    const want = normNodeName(nodeName);
    if (!want) return { ok: false, reason: 'sin-nombre-configurado', nodeId: null, candidates: [] };
    const list = Array.isArray(nodes) ? nodes : [];
    const seen = new Map(); // dedup por id: el árbol repite nodos que aparecen 2+ veces
    for (const n of list) {
      if (!n || n.id == null) continue;
      if (normNodeName(n.name) === want) seen.set(n.id, n.name);
    }
    const ids = [...seen.keys()];
    if (ids.length === 1) return { ok: true, reason: 'ok', nodeId: ids[0], candidates: [] };
    if (ids.length === 0) return { ok: false, reason: 'no-encontrado', nodeId: null, candidates: [] };
    return {
      ok: false, reason: 'ambiguo', nodeId: null,
      candidates: ids.map(id => ({ id, name: seen.get(id) })),
    };
  }

  // Aplana el árbol que viene en GetPartNumber:
  //   partNumberById.processNodeByDefaultProcessNodeId
  //     .descendantRelationships[].processNodeByFromId {id, name}
  // Incluye la raíz porque un proceso podría llamarse como el nodo buscado, y dejarla fuera
  // escondería una ambigüedad real en lugar de reportarla.
  function flattenProcessNodes(rootNode) {
    const out = [];
    if (!rootNode || typeof rootNode !== 'object') return out;
    if (rootNode.id != null) out.push({ id: rootNode.id, name: rootNode.name });
    for (const rel of (rootNode.descendantRelationships || [])) {
      const n = rel && rel.processNodeByFromId;
      if (n && n.id != null) out.push({ id: n.id, name: n.name });
    }
    return out;
  }

  // ── Payload de la mutation ──────────────────────────────────────────────────
  // Forma capturada del ERP (PN 3887933, nodo 154303) y reproducida byte a byte.
  // `cascadeToOccurrences`/`cascadeToRecipeNodes` van en false: la instrucción es de ESTE
  // PN en ESTE nodo; propagarla tocaría otras ocurrencias u otras recetas sin que nadie
  // lo haya pedido.
  function buildPackingPayload(partNumberId, processNodeId, markdown, opts) {
    const o = opts || {};
    return {
      input: {
        partNumberId,
        processNodeDescriptions: [{
          processNodeId,
          processNodeOccurrence: o.occurrence == null ? 1 : o.occurrence,
          otherOccurrences: [],
          descriptionMarkdown: markdown,
          cascadeToOccurrences: false,
          cascadeToRecipeNodes: false,
        }],
      },
    };
  }

  const API = { normNodeName, planPackingInstruction, resolvePackingNode, flattenProcessNodes, buildPackingPayload };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.SteelheadBulkPacking = API;
})();
