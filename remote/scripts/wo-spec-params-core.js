// Reaplicar parámetros a las specs de una Orden de Trabajo — módulo PURO (sin DOM ni red).
//
// Problema: Steelhead copia los parámetros del Número de Parte a la OT cuando la crea, y esa
// copia no se refresca. Las OTs generadas antes de una corrección masiva de NP conservan el
// criterio viejo.
//
// La unidad de decisión es la CASILLA = (recipeNodeId, specFieldId). Una sola fila viva por
// casilla (lección de bulk-upload 1.4.38: el SpecField agrupa, no el SpecFieldParam).
//
// HAY DOS UNIVERSOS, no uno:
//   · Spec EXTERNA (la del cliente, vía el NP; se reconoce porque su PartNumberWorkOrderSpec
//     apunta a un partNumberSpec): TODOS sus campos vivos son casillas, y SOLO del nodo de
//     inspección y empaque de la línea. Los que ese nodo no declara se FUERZAN.
//     Un parámetro suyo en cualquier otro nodo es una ANOMALÍA: se reporta y no se toca.
//   · Specs de PROCESO/línea: el universo es lo que cada nodo declara en recipeNodeSpecFields.
//
// OJO — el ERP CLONA el parámetro al aplicarlo: pides el id del catálogo y queda un clon nuevo
// que guarda su origen en specFieldParamByDerivedFromId. Por eso todo se normaliza con
// rootParamId() antes de comparar.
//
// Verificado en vivo el 2026-07-28 contra la OT 5769.
// Ver docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md
(function () {
  'use strict';

  // ── Normalización ─────────────────────────────────────────────────────────

  // El id del catálogo del que desciende un specFieldParam. Es lo que se compara y lo que se
  // escribe — nunca el id del clon.
  function rootParamId(specFieldParam) {
    if (!specFieldParam) return null;
    const df = specFieldParam.specFieldParamByDerivedFromId;
    if (df && df.id != null) return df.id;
    return specFieldParam.id != null ? specFieldParam.id : null;
  }

  // Colapsa espacios, recorta y baja a minúsculas. NO quita acentos a propósito: "Si" y "Sí"
  // son cadenas distintas y en un catálogo de calidad esa diferencia puede ser real.
  function normalizeName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function sameNumber(a, b) {
    const na = (a === undefined || a === null) ? null : a;
    const nb = (b === undefined || b === null) ? null : b;
    return na === nb;
  }

  // ── Índices ───────────────────────────────────────────────────────────────

  // Parámetros ACTIVOS del NP, indexados por specFieldSpecId (= "este campo de esta spec").
  // Si un specFieldSpec tiene 2+ activos el deseado es indeterminado: se marca ambiguo y el
  // consumidor no debe adivinar.
  function buildPartNumberIndex(partNumber) {
    const out = new Map();
    const nodes = (partNumber
      && partNumber.partNumberSpecFieldParamsByPartNumberId
      && partNumber.partNumberSpecFieldParamsByPartNumberId.nodes) || [];
    for (const row of nodes) {
      if (!row || row.archivedAt) continue;
      const sfp = row.specFieldParamBySpecFieldParamId;
      if (!sfp) continue;
      const sfs = sfp.specFieldSpecBySpecFieldSpecId;
      if (!sfs || sfs.id == null) continue;
      const prev = out.get(sfs.id);
      if (prev) { prev.ambiguous = true; continue; }
      out.set(sfs.id, { param: sfp, rowId: row.id, ambiguous: false });
    }
    return out;
  }

  // Catálogo de la OT: specFieldId → candidatos (uno por spec viva que declare ese campo).
  function buildCatalogIndex(workOrder) {
    const out = new Map();
    const specs = (workOrder
      && workOrder.partNumberWorkOrderSpecsByWorkOrderId
      && workOrder.partNumberWorkOrderSpecsByWorkOrderId.nodes) || [];
    for (const pnwos of specs) {
      if (!pnwos || pnwos.archivedAt) continue;
      const spec = pnwos.specBySpecId;
      if (!spec) continue;
      const fields = (spec.specFieldSpecsBySpecId && spec.specFieldSpecsBySpecId.nodes) || [];
      for (const f of fields) {
        if (!f || f.archivedAt || f.specFieldId == null) continue;
        if (!out.has(f.specFieldId)) out.set(f.specFieldId, []);
        out.get(f.specFieldId).push({
          specFieldSpecId: f.id,
          pnwosId: pnwos.id,
          specId: spec.id,
          specName: spec.name || '',
          fieldName: (f.specFieldBySpecFieldId && f.specFieldBySpecFieldId.name) || '',
          isGeneric: !!f.isGeneric,
          params: ((f.specFieldParamsBySpecFieldSpecId && f.specFieldParamsBySpecFieldSpecId.nodes) || [])
            .map(p => ({ id: p.id, name: p.name || '' }))
        });
      }
    }
    return out;
  }

  // ── La spec externa y su nodo ─────────────────────────────────────────────

  // La spec EXTERNA es la del cliente, la que llega por el Número de Parte. Se distingue por
  // estructura: es la única cuyo PartNumberWorkOrderSpec apunta a un partNumberSpec. Las demás
  // son de proceso/línea. Devuelve null si la OT no tiene ninguna.
  function findExternalSpec(workOrder) {
    const specs = (workOrder
      && workOrder.partNumberWorkOrderSpecsByWorkOrderId
      && workOrder.partNumberWorkOrderSpecsByWorkOrderId.nodes) || [];
    for (const s of specs) {
      if (!s || s.archivedAt || !s.partNumberSpecByPartNumberSpecId) continue;
      const spec = s.specBySpecId;
      if (!spec) continue;
      const fieldIds = new Set();
      const bySpecFieldId = new Map();
      for (const f of ((spec.specFieldSpecsBySpecId && spec.specFieldSpecsBySpecId.nodes) || [])) {
        if (!f || f.archivedAt || f.specFieldId == null) continue;
        fieldIds.add(f.specFieldId);
        bySpecFieldId.set(f.specFieldId, f);
      }
      return { pnwosId: s.id, specId: spec.id, specName: spec.name || '', fieldIds, bySpecFieldId };
    }
    return null;
  }

  // El nodo donde vive la spec externa: un QUALITY_ASSURANCE_NODE. Pero hay VARIOS por orden
  // (recibo, línea, embarques), así que el tipo no basta: el bueno es el único que TOCA la spec
  // externa — la declara o ya tiene parámetros suyos aplicados.
  //
  // Si no es exactamente uno NO se adivina: forzar en el nodo equivocado mete criterios de
  // calidad del cliente en una etapa que no le corresponde.
  function findInspectionNode(workOrder, externalSpec) {
    const nodes = (workOrder && workOrder.recipeNodesByWorkOrderId
      && workOrder.recipeNodesByWorkOrderId.nodes) || [];
    if (!externalSpec) {
      return { ambiguous: true, candidates: [], reason: 'la orden no tiene especificación externa' };
    }
    const candidates = [];
    for (const n of nodes) {
      if (!n || n.type !== 'QUALITY_ASSURANCE_NODE') continue;
      let touches = false;
      for (const f of ((n.recipeNodeSpecFieldsByRecipeNodeId
        && n.recipeNodeSpecFieldsByRecipeNodeId.nodes) || [])) {
        if (f && externalSpec.fieldIds.has(f.specFieldId)) { touches = true; break; }
      }
      if (!touches) {
        for (const a of ((n.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId
          && n.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes) || [])) {
          if (a && !a.archivedAt && externalSpec.fieldIds.has(a.specFieldId)) { touches = true; break; }
        }
      }
      if (touches) candidates.push(n);
    }
    if (candidates.length === 1) return { node: candidates[0] };
    return {
      ambiguous: true,
      candidates: candidates.map(n => n.id),
      reason: candidates.length === 0
        ? 'ningún nodo de inspección toca la especificación externa'
        : 'hay ' + candidates.length + ' nodos de inspección que tocan la especificación externa'
    };
  }

  // ── Deseado y equivalencia ────────────────────────────────────────────────

  // Qué parámetro DEBERÍA tener una casilla. Cascada: el NP manda; si no resuelve y el catálogo
  // ofrece exactamente una opción, esa; si no, ambiguo (y no se toca).
  function resolveDesired(specFieldId, catalogIndex, pnIndex) {
    const candidates = catalogIndex.get(specFieldId) || [];
    if (!candidates.length) {
      return { via: 'SIN_CATALOGO', reason: 'el campo no vive en ninguna spec viva de la OT' };
    }

    for (const c of candidates) {
      const hit = pnIndex.get(c.specFieldSpecId);
      if (!hit) continue;
      if (hit.ambiguous) {
        return { via: 'AMBIGUO', reason: 'el Número de Parte tiene más de un parámetro activo en este campo' };
      }
      const root = rootParamId(hit.param);
      return {
        via: 'NP', writeId: root, compareId: root,
        refParam: hit.param, refName: hit.param.name || '',
        pnwosId: c.pnwosId, specFieldSpecId: c.specFieldSpecId,
        specName: c.specName, fieldName: c.fieldName
      };
    }

    const all = [];
    for (const c of candidates) for (const p of c.params) all.push({ p, c });
    if (all.length === 1) {
      const p = all[0].p;
      const c = all[0].c;
      return {
        via: 'CATALOGO', writeId: p.id, compareId: p.id,
        refParam: null, refName: p.name || '',
        pnwosId: c.pnwosId, specFieldSpecId: c.specFieldSpecId,
        specName: c.specName, fieldName: c.fieldName
      };
    }
    return {
      via: 'AMBIGUO',
      reason: all.length === 0
        ? 'el catálogo de la spec no ofrece ningún parámetro para este campo'
        : 'el Número de Parte no define este campo y el catálogo ofrece ' + all.length + ' opciones'
    };
  }

  // ¿El parámetro aplicado equivale al deseado? Tres escalones, y CADA UNO SOLO PUEDE ABSOLVER.
  // Solo agotarlos los tres declara que difiere.
  //
  // El escalón de identidad es el que más trabaja (132 de 136 aciertos medidos en la OT 5769):
  // el catálogo de una spec evoluciona, así que un parámetro aplicado puede descender de una
  // versión ya reemplazada y su raíz no coincide con la vigente aunque el valor sea el mismo.
  function isEquivalent(appliedParam, desired) {
    if (!appliedParam || !desired) return { ok: false, via: null };

    const appliedRoot = rootParamId(appliedParam);
    if (appliedRoot != null && desired.compareId != null && appliedRoot === desired.compareId) {
      return { ok: true, via: 'raiz' };
    }
    if (appliedParam.id != null && desired.compareId != null && appliedParam.id === desired.compareId) {
      return { ok: true, via: 'idDirecto' };
    }
    if (normalizeName(appliedParam.name) === normalizeName(desired.refName)) {
      const ref = desired.refParam;
      // Del catálogo solo hay nombre, y basta: esa vía exige que el catálogo sea unívoco.
      if (!ref) return { ok: true, via: 'identidad' };
      const sameValues = sameNumber(appliedParam.minimumValue, ref.minimumValue)
        && sameNumber(appliedParam.maximumValue, ref.maximumValue)
        && sameNumber(appliedParam.targetValue, ref.targetValue)
        && sameNumber(appliedParam.unitId, ref.unitId);
      if (sameValues) return { ok: true, via: 'identidad' };
    }
    return { ok: false, via: null };
  }

  // ── Clasificación ─────────────────────────────────────────────────────────

  // Decide el estado de UNA casilla y qué escrituras propone. Muta `tally`.
  function buildCell(o) {
    const node = o.node;
    const desired = o.desired;
    const rows = o.rows;
    const tally = o.tally;
    const cell = {
      recipeNodeId: node.id, recipeNodeName: node.name || '',
      specFieldId: o.specFieldId,
      fieldName: o.fieldName || desired.fieldName || '',
      specName: desired.specName || '',
      via: desired.via, desired, appliedRows: rows,
      toArchiveIds: [], toAddWriteId: null,
      pnwosId: desired.pnwosId || null, reason: desired.reason || '',
      forced: !!o.forced, scope: o.scope
    };

    if (desired.via === 'SIN_CATALOGO' || desired.via === 'AMBIGUO') {
      cell.status = desired.via; tally[desired.via]++; return cell;
    }
    if (rows.length === 0) {
      cell.status = 'VACIO'; cell.toAddWriteId = desired.writeId; tally.VACIO++; return cell;
    }
    const matches = rows.filter(r => isEquivalent(r.specFieldParamBySpecFieldParamId, desired).ok);
    if (rows.length > 1) {
      cell.status = 'DUPLICADO';
      if (matches.length > 0) {
        const keep = matches[0].id;
        cell.toArchiveIds = rows.filter(r => r.id !== keep).map(r => r.id);
      } else {
        cell.toArchiveIds = rows.map(r => r.id);
        cell.toAddWriteId = desired.writeId;
      }
      tally.DUPLICADO++; return cell;
    }
    if (matches.length === 1) { cell.status = 'OK'; tally.OK++; return cell; }
    cell.status = 'DIFIERE';
    cell.toArchiveIds = [rows[0].id];
    cell.toAddWriteId = desired.writeId;
    tally.DIFIERE++;
    return cell;
  }

  function groupActiveByField(node) {
    const out = new Map();
    const applied = (node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId
      && node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes) || [];
    for (const a of applied) {
      if (!a || a.archivedAt) continue;
      if (!out.has(a.specFieldId)) out.set(a.specFieldId, []);
      out.get(a.specFieldId).push(a);
    }
    return out;
  }

  // Clasifica TODAS las casillas de una OT, con los dos universos descritos arriba.
  function classifyWorkOrder(input) {
    const workOrder = input && input.workOrder;
    const partNumber = input && input.partNumber;
    const cells = [];
    const orphans = [];
    const anomalies = [];
    const tally = { OK: 0, VACIO: 0, DIFIERE: 0, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 0 };
    if (!workOrder) {
      return { cells, tally, orphans, anomalies, externalSpec: null, inspectionNode: null };
    }

    const externalSpec = findExternalSpec(workOrder);
    const inspectionNode = findInspectionNode(workOrder, externalSpec);
    const targetId = (inspectionNode && inspectionNode.node) ? inspectionNode.node.id : null;
    const extFields = externalSpec ? externalSpec.fieldIds : new Set();

    const catalogIndex = buildCatalogIndex(workOrder);
    const pnIndex = buildPartNumberIndex(partNumber);
    const nodes = (workOrder.recipeNodesByWorkOrderId && workOrder.recipeNodesByWorkOrderId.nodes) || [];

    // Universo EXTERNA: los campos de la spec del cliente, completos, en el nodo de inspección.
    if (externalSpec && targetId != null) {
      const target = inspectionNode.node;
      const declared = new Set(((target.recipeNodeSpecFieldsByRecipeNodeId
        && target.recipeNodeSpecFieldsByRecipeNodeId.nodes) || [])
        .map(f => f && f.specFieldId).filter(x => x != null));
      const appliedByField = groupActiveByField(target);
      for (const specFieldId of externalSpec.fieldIds) {
        const f = externalSpec.bySpecFieldId.get(specFieldId);
        cells.push(buildCell({
          node: target, specFieldId,
          fieldName: (f && f.specFieldBySpecFieldId && f.specFieldBySpecFieldId.name) || '',
          rows: appliedByField.get(specFieldId) || [],
          desired: resolveDesired(specFieldId, catalogIndex, pnIndex),
          scope: 'EXTERNA', forced: !declared.has(specFieldId), tally
        }));
      }
    }

    // Universo PROCESO + anomalías + huérfanas.
    for (const node of nodes) {
      if (!node) continue;
      const appliedByField = groupActiveByField(node);

      // Parámetros de la spec externa fuera del nodo de inspección: error de datos, no casilla.
      if (node.id !== targetId) {
        for (const entry of appliedByField) {
          const fieldId = entry[0];
          if (!extFields.has(fieldId)) continue;
          for (const r of entry[1]) {
            const sfp = r.specFieldParamBySpecFieldParamId || {};
            anomalies.push({
              recipeNodeId: node.id, recipeNodeName: node.name || '', recipeNodeType: node.type || '',
              specFieldId: fieldId,
              fieldName: (r.specFieldBySpecFieldId && r.specFieldBySpecFieldId.name) || '',
              rowId: r.id, paramName: sfp.name || ''
            });
          }
        }
      }

      // Casillas de proceso: lo que el nodo declara, MENOS los campos de la spec externa
      // (esos ya se trataron arriba, y solo en el nodo de inspección).
      const fields = ((node.recipeNodeSpecFieldsByRecipeNodeId
        && node.recipeNodeSpecFieldsByRecipeNodeId.nodes) || [])
        .filter(f => f && f.specFieldId != null && !extFields.has(f.specFieldId));
      const declared = new Set(fields.map(f => f.specFieldId));

      for (const entry of appliedByField) {
        const fieldId = entry[0];
        if (extFields.has(fieldId) || declared.has(fieldId)) continue;
        for (const r of entry[1]) {
          const sfp = r.specFieldParamBySpecFieldParamId || {};
          orphans.push({
            recipeNodeId: node.id, recipeNodeName: node.name || '', specFieldId: fieldId,
            fieldName: (r.specFieldBySpecFieldId && r.specFieldBySpecFieldId.name) || '',
            rowId: r.id, paramName: sfp.name || ''
          });
        }
      }

      for (const f of fields) {
        cells.push(buildCell({
          node, specFieldId: f.specFieldId,
          fieldName: (f.specFieldBySpecFieldId && f.specFieldBySpecFieldId.name) || '',
          rows: appliedByField.get(f.specFieldId) || [],
          desired: resolveDesired(f.specFieldId, catalogIndex, pnIndex),
          scope: 'PROCESO', forced: false, tally
        }));
      }
    }

    return { cells, tally, orphans, anomalies, externalSpec, inspectionNode };
  }

  // ── Plan de escritura ─────────────────────────────────────────────────────

  // Convierte la clasificación en las dos escrituras: qué archivar y qué agregar.
  // Fail-safe: sin partNumberId no arma nada — el payload de AddParams lo exige y mandar uno
  // incompleto escribiría sobre el NP equivocado.
  function buildWritePlan(classification, opts) {
    const out = { archiveIds: [], parametersToAdd: [], touched: 0, skipped: [] };
    const partNumberId = opts && opts.partNumberId;
    const cells = (classification && classification.cells) || [];
    if (!partNumberId) return out;

    for (const c of cells) {
      if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') { out.skipped.push(c); continue; }
      if (c.status === 'OK') continue;

      let changed = false;
      for (const id of (c.toArchiveIds || [])) { out.archiveIds.push(id); changed = true; }
      if (c.toAddWriteId != null && c.pnwosId != null) {
        out.parametersToAdd.push({
          specFieldId: c.specFieldId,
          specFieldParamId: c.toAddWriteId,
          recipeNodeId: c.recipeNodeId,
          geometryTypeSpecFieldId: null,
          locationId: null,
          drivenBy: c.pnwosId
        });
        changed = true;
      }
      if (changed) out.touched++;
    }
    return out;
  }

  window.WoSpecParamsCore = {
    rootParamId, normalizeName,
    buildPartNumberIndex, buildCatalogIndex,
    findExternalSpec, findInspectionNode,
    resolveDesired, isEquivalent,
    classifyWorkOrder, buildWritePlan
  };
})();
