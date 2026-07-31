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
//     apunta a un partNumberSpec): TODOS sus campos vivos son casillas, y la COBERTURA SE MIDE
//     POR ORDEN — un campo cuenta como cubierto si vive en CUALQUIER nodo, no solo en el de
//     inspección. Solo lo que no está en ninguno se aplica (en el de inspección, forzándolo si
//     ese nodo no lo declara).
//   · Specs de PROCESO/línea: el universo es lo que cada nodo declara en recipeNodeSpecFields.
//
// v0.4.0 — POR QUÉ la cobertura es por orden: la receta reparte los campos externos entre
// varios nodos que los declaran (el raíz y el de inspección declaran los mismos), y mirar solo
// el de inspección hacía proponer duplicados de lo que ya existía. En la corrida real del
// 2026-07-29 sobre 4436 órdenes eso eran ~7660 de 9551 cambios. Verificado contra las OTs
// 16339/16341 (repartidas) y 16333 (todo en el QA): a las tres les faltaba SOLO el campo 33579.
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
  function classifyWorkOrder(input, opts) {
    const migrarAInspeccion = !!(opts && opts.migrarAInspeccion);
    const workOrder = input && input.workOrder;
    const partNumber = input && input.partNumber;
    const cells = [];
    const orphans = [];
    const anomalies = [];
    const fueraDeInspeccion = [];
    const faltantesSinDestino = [];
    const tally = { OK: 0, VACIO: 0, DIFIERE: 0, DUPLICADO: 0, AMBIGUO: 0, SIN_CATALOGO: 0, MIGRAR: 0 };
    if (!workOrder) {
      return { cells, tally, orphans, anomalies, fueraDeInspeccion, faltantesSinDestino,
               externalSpec: null, inspectionNode: null };
    }

    const externalSpec = findExternalSpec(workOrder);
    const inspectionNode = findInspectionNode(workOrder, externalSpec);
    const targetId = (inspectionNode && inspectionNode.node) ? inspectionNode.node.id : null;
    const extFields = externalSpec ? externalSpec.fieldIds : new Set();

    const catalogIndex = buildCatalogIndex(workOrder);
    const pnIndex = buildPartNumberIndex(partNumber);
    const nodes = (workOrder.recipeNodesByWorkOrderId && workOrder.recipeNodesByWorkOrderId.nodes) || [];

    // Universo EXTERNA: los campos de la spec del cliente.
    //
    // La cobertura se mide POR ORDEN, no por nodo. Un campo puede vivir en cualquier nodo que
    // lo DECLARE —el raíz y el de inspección suelen declarar los mismos— y estar ahí ya cuenta
    // como cubierto. Mirar solo el nodo de inspección hacía proponer duplicados de lo que ya
    // existía en otro lado: en la corrida del 2026-07-29 eran ~7660 de 9551 cambios.
    if (externalSpec) {
      // Dónde vive hoy cada campo externo, en toda la orden.
      const ubicaciones = new Map();   // specFieldId → [{ node, row }]
      for (const node of nodes) {
        if (!node) continue;
        for (const a of ((node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId
          && node.partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes) || [])) {
          if (!a || a.archivedAt || !extFields.has(a.specFieldId)) continue;
          if (!ubicaciones.has(a.specFieldId)) ubicaciones.set(a.specFieldId, []);
          ubicaciones.get(a.specFieldId).push({ node, row: a });
        }
      }

      const target = (inspectionNode && inspectionNode.node) || null;
      const declaredTarget = new Set(target ? ((target.recipeNodeSpecFieldsByRecipeNodeId
        && target.recipeNodeSpecFieldsByRecipeNodeId.nodes) || [])
        .map(f => f && f.specFieldId).filter(x => x != null) : []);

      for (const specFieldId of externalSpec.fieldIds) {
        const f = externalSpec.bySpecFieldId.get(specFieldId);
        const fieldName = (f && f.specFieldBySpecFieldId && f.specFieldBySpecFieldId.name) || '';
        const donde = ubicaciones.get(specFieldId) || [];
        const desired = resolveDesired(specFieldId, catalogIndex, pnIndex);

        if (donde.length === 0) {
          // No está en NINGÚN nodo: es lo único que de verdad falta. Se aplica en el de
          // inspección, forzándolo si ese nodo no declara el campo.
          if (!target) {
            faltantesSinDestino.push({ specFieldId, fieldName });
            continue;
          }
          cells.push(buildCell({
            node: target, specFieldId, fieldName, rows: [], desired,
            scope: 'EXTERNA', forced: !declaredTarget.has(specFieldId), tally
          }));
          continue;
        }

        // Ya existe: la casilla vive donde está aplicada, y ahí se compara contra el NP.
        // Con varias ubicaciones, buildCell resuelve el DUPLICADO sobre el nodo de la primera.
        const rows = donde.map(d => d.row);
        const host = donde[0].node;

        // MIGRAR: si el operador lo pidió y el campo no está en el nodo de inspección, se
        // archiva donde esté y se repone allá. Sin destino identificado NO se mueve nada:
        // sacar un parámetro de su nodo sin saber dónde ponerlo lo deja huérfano.
        const fueraDelQA = target && donde.every(d => d.node.id !== target.id);
        if (migrarAInspeccion && fueraDelQA && desired.via !== 'AMBIGUO'
            && desired.via !== 'SIN_CATALOGO' && desired.writeId != null) {
          cells.push({
            recipeNodeId: target.id, recipeNodeName: target.name || '',
            specFieldId, fieldName, specName: desired.specName || '',
            status: 'MIGRAR', via: desired.via, desired, appliedRows: rows,
            toArchiveIds: rows.map(r => r.id),
            toAddWriteId: desired.writeId,
            pnwosId: desired.pnwosId || null,
            reason: 'vivía en ' + (host.name || host.id) + '; se mueve al nodo de inspección',
            forced: !declaredTarget.has(specFieldId), scope: 'EXTERNA',
            migradoDesde: { recipeNodeId: host.id, recipeNodeName: host.name || '' }
          });
          tally.MIGRAR = (tally.MIGRAR || 0) + 1;
          continue;
        }

        cells.push(buildCell({
          node: host, specFieldId, fieldName, rows, desired,
          scope: 'EXTERNA', forced: false, tally
        }));

        // Dato para el operador: qué campos externos viven fuera del nodo de inspección.
        // NO se mueven — moverlos toca órdenes que ya están en piso y es decisión aparte.
        if (target) {
          for (const d of donde) {
            if (d.node.id === target.id) continue;
            fueraDeInspeccion.push({
              specFieldId, fieldName,
              recipeNodeId: d.node.id, recipeNodeName: d.node.name || '',
              recipeNodeType: d.node.type || '', rowId: d.row.id,
              paramName: (d.row.specFieldParamBySpecFieldParamId
                && d.row.specFieldParamBySpecFieldParamId.name) || ''
            });
          }
        }
      }
    }

    // Universo PROCESO + anomalías + huérfanas.
    for (const node of nodes) {
      if (!node) continue;
      const appliedByField = groupActiveByField(node);

      // Ya no hay "anomalías" de la spec externa: el universo EXTERNA cubre TODOS sus campos
      // vivan donde vivan, y que un nodo no declare el campo es exactamente lo que significa
      // "forzado" — algo que nosotros mismos hacemos a propósito. Lo que sí se reporta es
      // fueraDeInspeccion, arriba: dónde vive cada campo, para que el operador decida.

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

    return { cells, tally, orphans, anomalies, fueraDeInspeccion, faltantesSinDestino,
             externalSpec, inspectionNode };
  }

  // ── Plan de escritura ─────────────────────────────────────────────────────

  // Convierte la clasificación en las dos escrituras: qué archivar y qué agregar.
  // Fail-safe: sin partNumberId no arma nada — el payload de AddParams lo exige y mandar uno
  // incompleto escribiría sobre el NP equivocado.
  function buildWritePlan(classification, opts) {
    const out = { archiveIds: [], parametersToAdd: [], touched: 0, skipped: [], soloNP: 0 };
    const partNumberId = opts && opts.partNumberId;
    // Modo acotado: escribe SOLO lo que el Número de Parte define, dejando fuera la vía
    // CATALOGO.
    //
    // POR QUÉ (2026-07-30): `resolveDesired` tiene dos vías. La del NP es la fuente de verdad
    // que este applet declara; la del catálogo es una inferencia — «el NP no dice nada, pero el
    // catálogo ofrece una sola opción, así que debe ser esa». En la corrida de las 194 órdenes
    // esa inferencia era 250 de 16 314 casillas, casi todas campos de PROCESO (temperatura de
    // tina, concentración, tiempo de centrifugadora) que el NP no define porque son de la
    // receta, no del cliente. No está demostrado que una orden sana los tenga llenos, y una
    // escritura de más en el criterio de calidad de una orden EN PISO no se corrige sola en la
    // siguiente corrida. Hasta tener esa evidencia, este modo permite avanzar con lo fundado.
    //
    // De paso, en un barrido del dominio completo recorta las escrituras en la misma
    // proporción (~15 de cada 16 en la muestra medida).
    const soloNP = !!(opts && opts.soloNP);
    const cells = (classification && classification.cells) || [];
    if (!partNumberId) return out;

    for (const c of cells) {
      if (c.status === 'AMBIGUO' || c.status === 'SIN_CATALOGO') { out.skipped.push(c); continue; }
      if (c.status === 'OK') continue;   // MIGRAR sí escribe: archiva en origen y repone en destino
      // El filtro va DESPUÉS de descartar OK/AMBIGUO para que `soloNP` cuente lo que se dejó
      // de escribir por el modo, y no lo que ya se omitía de todas formas.
      if (soloNP && c.via !== 'NP') { out.soloNP++; out.skipped.push(c); continue; }

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
