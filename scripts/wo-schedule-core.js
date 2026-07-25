// Órdenes de Trabajo: PN + programación — módulo puro (sin DOM ni red).
// Compartido por dos applets:
//   - wo-listing-columns.js : columnas "Número de Parte" y "Programación" en /Domains/<d>/WorkOrders
//   - wo-schedule-button.js : botón "Programación" en la ficha /Domains/<d>/WorkOrders/<id>
// Aquí solo va la LÓGICA testeable; el DOM, el fetch y el memory-hardening viven en los glues.
//
// Fuentes de datos (persisted queries; el shape lo fija el server):
//   PartNumbersByWorkOrderIdInDomain({idInDomain})  → PN(s) de una WO, con nombre.
//     workOrderByIdInDomain.partLocationsByWorkOrderId.nodes[].partNumberByPartNumberId.{id,name}
//     (soporta N PNs; hoy 1 por WO, pero puede haber varios).
//   GetRelatedScheduleData (shape confirmado en surtido-guard-capture2.json) → tareas agendadas:
//     allSchedules.nodes[].{ id, name,
//        validScheduleTasks.nodes[].{ stationId, expectedStartTime, treatmentId, totalTimeMinutes,
//           scheduleTaskElementsByScheduleTaskId.nodes[].{ partNumberId, recipeNodeId,
//              associatedPartsTransferAccounts.nodes[].{ id, workOrderId } } } }
//     El puente WO→tarea es associatedPartsTransferAccounts.workOrderId (= account de la WO).
//   AllStations → stationId → name (para resolver la estación programada).
(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // Rutas
  // ══════════════════════════════════════════════════════════════════════════
  // Index de WOs de un dominio: /Domains/<d>/WorkOrders (con o sin trailing slash/query).
  const WO_INDEX_RE = /\/Domains\/(\d+)\/WorkOrders\/?(?:[?#]|$)/i;
  // Ficha individual: /Domains/<d>/WorkOrders/<idInDomain>
  const WO_DETAIL_RE = /\/Domains\/(\d+)\/WorkOrders\/(\d+)(?:[/?#]|$)/i;
  const DOMAIN_RE = /\/Domains\/(\d+)/i;

  function isWorkOrdersIndexPath(pathname) {
    return typeof pathname === 'string' && WO_INDEX_RE.test(pathname);
  }
  function isWorkOrderDetailPath(pathname) {
    return typeof pathname === 'string' && WO_DETAIL_RE.test(pathname);
  }
  // idInDomain de la ficha (o del href de una fila del listado). null si no matchea.
  function parseWorkOrderIdInDomain(pathOrHref) {
    if (typeof pathOrHref !== 'string') return null;
    const m = pathOrHref.match(WO_DETAIL_RE);
    return m ? parseInt(m[2], 10) : null;
  }
  function parseDomainId(pathname) {
    if (typeof pathname !== 'string') return null;
    const m = pathname.match(DOMAIN_RE);
    return m ? parseInt(m[1], 10) : null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Número(s) de Parte
  // ══════════════════════════════════════════════════════════════════════════
  // Del response de PartNumbersByWorkOrderIdInDomain → [{ id, name }] (dedup por id,
  // preserva orden). Fail-safe: shape inesperado → []. Soporta múltiples PNs por WO.
  function extractPartNumbers(input) {
    const wo = (input && input.workOrderByIdInDomain) ? input.workOrderByIdInDomain
             : (input && input.data && input.data.workOrderByIdInDomain) ? input.data.workOrderByIdInDomain
             : null;
    if (!wo || typeof wo !== 'object') return [];
    const nodes = (wo.partLocationsByWorkOrderId && wo.partLocationsByWorkOrderId.nodes) || [];
    const out = [];
    const seen = new Set();
    nodes.forEach(function (n) {
      const pn = n && n.partNumberByPartNumberId;
      if (!pn || pn.id == null) return;
      if (seen.has(pn.id)) return;
      seen.add(pn.id);
      out.push({ id: pn.id, name: (pn.name != null && pn.name !== '') ? String(pn.name) : ('PN ' + pn.id) });
    });
    return out;
  }

  // Link a la ficha del PN. Formato global /PartNumbers/<id> (confirmado por pn-specs-column).
  function pnLink(id) {
    return (id == null) ? null : '/PartNumbers/' + id;
  }

  // workOrderId GLOBAL (el `id`, no idInDomain) desde el response de
  // PartNumbersByWorkOrderIdInDomain — necesario para cruzar contra WorkOrderSchedule.
  function extractWorkOrderGlobalId(input) {
    const wo = (input && input.workOrderByIdInDomain) ? input.workOrderByIdInDomain
             : (input && input.data && input.data.workOrderByIdInDomain) ? input.data.workOrderByIdInDomain
             : null;
    return (wo && wo.id != null) ? wo.id : null;
  }

  // Detalle enriquecido de UN PN desde el response de GetPartNumber:
  //   { description, labels: [{ name, color }] }
  // - description = partNumberById.descriptionMarkdown (ej. "CONECTOR").
  // - labels ACTIVOS (node.archivedAt == null) de partNumberLabelsByPartNumberId.
  // Fail-safe: shape inesperado → { description:'', labels:[] }.
  function extractPartNumberDetail(input) {
    const pn = (input && input.partNumberById) ? input.partNumberById
             : (input && input.data && input.data.partNumberById) ? input.data.partNumberById
             : null;
    if (!pn || typeof pn !== 'object') return { description: '', labels: [] };
    const description = (pn.descriptionMarkdown != null) ? String(pn.descriptionMarkdown).trim() : '';
    const nodes = (pn.partNumberLabelsByPartNumberId && pn.partNumberLabelsByPartNumberId.nodes) || [];
    const labels = [];
    const seen = new Set();
    nodes.forEach(function (n) {
      if (!n || n.archivedAt != null) return;                 // archivada → fuera
      const l = n.labelByLabelId; if (!l || l.name == null) return;
      const key = String(l.name);
      if (seen.has(key)) return;
      seen.add(key);
      labels.push({ name: String(l.name), color: (l.color != null ? String(l.color) : '') });
    });
    return { description: description, labels: labels };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lote(s) (inventory batch) de la WO — desde el response de WorkOrder (ficha)
  // ══════════════════════════════════════════════════════════════════════════
  // WorkOrder({idInDomain}) es la query de la ficha (hash fc41042e, ya en config,
  // la usa también wo-schedule-button). Por cada cuenta de la WO trae el lote + su
  // Packing Slip del cliente + el receptor con la fecha real de recibido:
  //   workOrderByIdInDomain.currentPartsTransferAccounts.nodes[]
  //     .inventoryAccountByInventoryAccountId
  //       .inventoryBatchByInventoryBatchId.{ id, idInDomain, name,
  //           customInputs.DatosRecibo.PackingSlip,
  //           inventoryItemByInventoryItemId.partNumberByPartNumberId.id }  ← pnId → link anidado
  //       .receiverBomItemByReceiverBomItemId.receiverByReceiverId.receivedAt  ← fecha de recibido
  // Devuelve [{ id, idInDomain, name, packingSlip, receivedAt, partNumberId }]
  // (dedup por batch id, preserva orden; una WO puede ligar varios lotes). SLIM: solo
  // los campos que se muestran → el response de 1156 campos se descarta tras extraer.
  // Fail-safe: shape inesperado → [].
  function extractWorkOrderBatches(input) {
    const wo = (input && input.workOrderByIdInDomain) ? input.workOrderByIdInDomain
             : (input && input.data && input.data.workOrderByIdInDomain) ? input.data.workOrderByIdInDomain
             : null;
    if (!wo || typeof wo !== 'object') return [];
    const nodes = (wo.currentPartsTransferAccounts && wo.currentPartsTransferAccounts.nodes) || [];
    const out = [];
    const seen = new Set();
    nodes.forEach(function (n) {
      const acc = n && n.inventoryAccountByInventoryAccountId;
      if (!acc) return;
      const batch = acc.inventoryBatchByInventoryBatchId;
      if (!batch || batch.id == null) return;
      if (seen.has(batch.id)) return;   // dedup por batch id (varias cuentas → mismo lote)
      seen.add(batch.id);
      // pnId para el link anidado /PartNumbers/<pn>/Inventory/Batches/<idInDomain>
      let partNumberId = null;
      const item = batch.inventoryItemByInventoryItemId;
      const pn = item && item.partNumberByPartNumberId;
      if (pn && pn.id != null) partNumberId = pn.id;
      // fecha de recibido: receptor ligado a la cuenta del lote (receivedAt real, no createdAt)
      let receivedAt = null;
      const rbi = acc.receiverBomItemByReceiverBomItemId;
      const rcv = rbi && rbi.receiverByReceiverId;
      if (rcv && rcv.receivedAt != null) receivedAt = String(rcv.receivedAt);
      out.push({
        id: batch.id,
        idInDomain: batch.idInDomain != null ? batch.idInDomain : null,
        name: (batch.name != null && batch.name !== '') ? String(batch.name) : ('Lote ' + batch.id),
        packingSlip: packingSlipFromCI(batch.customInputs),
        receivedAt: receivedAt,
        partNumberId: partNumberId,
      });
    });
    return out;
  }

  // customInputs del lote puede venir como objeto o como string JSON (el server varía).
  // → DatosRecibo.PackingSlip ('' si falta o no parsea). Mismo criterio que board-metal-tooltip.
  function packingSlipFromCI(ci) {
    let o = ci;
    if (typeof ci === 'string') { try { o = JSON.parse(ci); } catch (_) { o = null; } }
    return (o && o.DatosRecibo && o.DatosRecibo.PackingSlip != null && o.DatosRecibo.PackingSlip !== '')
      ? String(o.DatosRecibo.PackingSlip) : '';
  }

  // Link a la ficha del lote. Preferido: /PartNumbers/<pnId>/Inventory/Batches/<idInDomain>
  // (forma REAL que renderiza SH → navegable). Sin pnId → forma bare /Inventory/Batches/<idInDomain>.
  // null si no hay idInDomain.
  function batchLink(idInDomain, partNumberId) {
    if (idInDomain == null) return null;
    return (partNumberId != null)
      ? '/PartNumbers/' + partNumberId + '/Inventory/Batches/' + idInDomain
      : '/Inventory/Batches/' + idInDomain;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Programación (índice workOrderId → tarea(s) agendada(s))
  // ══════════════════════════════════════════════════════════════════════════
  // Del response de GetRelatedScheduleData construye un índice:
  //   { byWorkOrderId: { <workOrderId>: [ entry, ... ] }, byAccountId: { <accountId>: [ entry, ... ] } }
  // entry = { workOrderId, accountId, scheduleId, scheduleName, stationId,
  //           expectedStartTime, treatmentId, totalTimeMinutes, partNumberId, recipeNodeId }
  // Cada entry se agrega tanto por workOrderId como por accountId (la WO puede tener
  // varias cuentas/pasos, y una tarea liga una cuenta). Las entries de cada llave
  // quedan ORDENADAS por expectedStartTime ascendente (la más próxima primero).
  // Fail-safe: shape inesperado → índice vacío.
  function buildScheduleIndex(input) {
    const root = (input && input.allSchedules) ? input
               : (input && input.data && input.data.allSchedules) ? input.data
               : null;
    const byWorkOrderId = Object.create(null);
    const byAccountId = Object.create(null);
    if (!root) return { byWorkOrderId: byWorkOrderId, byAccountId: byAccountId };

    const schedules = (root.allSchedules && root.allSchedules.nodes) || [];
    schedules.forEach(function (sch) {
      if (!sch) return;
      const scheduleId = sch.id != null ? sch.id : null;
      const scheduleName = sch.name != null ? String(sch.name) : '';
      const tasks = (sch.validScheduleTasks && sch.validScheduleTasks.nodes) || [];
      tasks.forEach(function (task) {
        if (!task) return;
        const elements = (task.scheduleTaskElementsByScheduleTaskId && task.scheduleTaskElementsByScheduleTaskId.nodes) || [];
        elements.forEach(function (el) {
          if (!el) return;
          const accounts = (el.associatedPartsTransferAccounts && el.associatedPartsTransferAccounts.nodes) || [];
          accounts.forEach(function (acc) {
            if (!acc || acc.workOrderId == null) return;
            const entry = {
              workOrderId: acc.workOrderId,
              accountId: acc.id != null ? acc.id : null,
              scheduleId: scheduleId,
              scheduleName: scheduleName,
              stationId: task.stationId != null ? task.stationId : null,
              expectedStartTime: task.expectedStartTime != null ? task.expectedStartTime : null,
              treatmentId: task.treatmentId != null ? task.treatmentId : null,
              totalTimeMinutes: task.totalTimeMinutes != null ? task.totalTimeMinutes : null,
              partNumberId: el.partNumberId != null ? el.partNumberId : null,
              recipeNodeId: el.recipeNodeId != null ? el.recipeNodeId : null,
            };
            pushSorted(byWorkOrderId, acc.workOrderId, entry);
            if (acc.id != null) pushSorted(byAccountId, acc.id, entry);
          });
        });
      });
    });
    return { byWorkOrderId: byWorkOrderId, byAccountId: byAccountId };
  }

  // Inserta manteniendo orden ascendente por expectedStartTime (nulls al final).
  function pushSorted(map, key, entry) {
    const arr = map[key] || (map[key] = []);
    arr.push(entry);
    arr.sort(function (a, b) {
      const ta = a.expectedStartTime, tb = b.expectedStartTime;
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });
  }

  // Tarea(s) de una WO (por workOrderId GLOBAL — el `id`, no idInDomain). [] si no está programada.
  function resolveByWorkOrderId(index, workOrderId) {
    if (!index || workOrderId == null) return [];
    return index.byWorkOrderId[workOrderId] || [];
  }
  // Tarea(s) por conjunto de accountIds (los currentPartsTransferAccounts de la WO).
  function resolveByAccountIds(index, accountIds) {
    if (!index || !accountIds || !accountIds.length) return [];
    const out = [];
    const seen = new Set();
    accountIds.forEach(function (id) {
      (index.byAccountId[id] || []).forEach(function (e) {
        const k = e.scheduleId + '|' + e.accountId + '|' + e.expectedStartTime + '|' + e.stationId;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(e);
      });
    });
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AllStations → stationId → name
  // ══════════════════════════════════════════════════════════════════════════
  function stationNameMap(input) {
    const root = input && (input.data || input);
    const nodes = (root && root.allStations && root.allStations.nodes) || [];
    const map = Object.create(null);
    nodes.forEach(function (s) { if (s && s.id != null) map[s.id] = s.name != null ? String(s.name) : ('Estación ' + s.id); });
    return map;
  }
  function stationName(map, stationId) {
    if (stationId == null) return '';
    return (map && map[stationId]) || ('Estación ' + stationId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Formateo (TZ-agnóstico y determinista para tests). El glue puede localizar con
  // Date/toLocaleString; esto es el contrato canónico verificable de fallback.
  // ══════════════════════════════════════════════════════════════════════════
  // Parte una ISO 8601 (con o sin offset) a componentes tal cual aparecen en el string
  // (NO convierte de zona). "2026-06-23T22:30:00.154+00:00" → {y,mo,d,h,mi}.
  function parseIsoParts(iso) {
    if (typeof iso !== 'string') return null;
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  }
  // "DD/MM HH:MM" a partir de la ISO (componentes crudos). "" si no parsea.
  function formatShortDateTime(iso) {
    const p = parseIsoParts(iso);
    if (!p) return '';
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(p.d) + '/' + pad(p.mo) + ' ' + pad(p.h) + ':' + pad(p.mi);
  }

  // Texto compacto de la programación de UNA WO para la celda del listado / fallback.
  //   entries vacío        → "—"
  //   1 tarea              → "Estación · 23/06 22:30 · Programa Diario"
  //   N tareas             → "<primera>  (+N-1)"
  // stationNames = mapa stationId→name (opcional).
  function formatScheduleCell(entries, stationNames) {
    if (!entries || !entries.length) return '—';
    const first = entries[0];
    const parts = [];
    const st = stationName(stationNames, first.stationId);
    if (st) parts.push(st);
    const when = formatShortDateTime(first.expectedStartTime);
    if (when) parts.push(when);
    if (first.scheduleName) parts.push(first.scheduleName);
    let s = parts.join(' · ') || '(programada)';
    if (entries.length > 1) s += '  (+' + (entries.length - 1) + ')';
    return s;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Índice de programación desde WorkOrderSchedule (query real de la ficha)
  // ══════════════════════════════════════════════════════════════════════════
  // WorkOrderSchedule({domainId, workOrderId}) devuelve el BOARD COMPLETO (todas las
  // tareas del schedule del dominio, no solo las de la WO consultada — 767 tareas en
  // el board 454). Ventaja: UNA llamada indexa a TODAS las WOs. El puente WO→tarea es
  // element.recipeNodeByRecipeNodeId.workOrderId (workOrderId GLOBAL, no idInDomain).
  // Shape (confirmado en scan real 2026-07-23):
  //   allSchedules.nodes[].{ id,
  //     validScheduleTasks.nodes[].{ id, expectedStartTime, stationId, status, isIntentional,
  //        treatmentId, totalTimeMinutes, stationByStationId.{id,name},
  //        scheduleTaskElementsByScheduleTaskId.nodes[].{ partCount,
  //           recipeNodeByRecipeNodeId.workOrderId, partNumberByPartNumberId.name } } }
  // Devuelve { byWorkOrderId: { <globalWorkOrderId>: [task, ...] } } (task ordenadas por
  // expectedStartTime ascendente). Fail-safe: shape inesperado → índice vacío.
  function buildBoardScheduleIndex(input) {
    const root = (input && input.allSchedules) ? input
               : (input && input.data && input.data.allSchedules) ? input.data
               : null;
    const byWorkOrderId = Object.create(null);
    if (!root) return { byWorkOrderId: byWorkOrderId };
    const schedules = (root.allSchedules && root.allSchedules.nodes) || [];
    schedules.forEach(function (sch) {
      if (!sch) return;
      const scheduleId = sch.id != null ? sch.id : null;
      const tasks = (sch.validScheduleTasks && sch.validScheduleTasks.nodes) || [];
      tasks.forEach(function (task) {
        if (!task) return;
        const station = task.stationByStationId || {};
        const base = {
          taskId: task.id != null ? task.id : null,
          scheduleId: scheduleId,
          expectedStartTime: task.expectedStartTime != null ? task.expectedStartTime : null,
          stationId: task.stationId != null ? task.stationId : (station.id != null ? station.id : null),
          stationName: station.name != null ? String(station.name) : '',
          status: task.status != null ? String(task.status) : '',
          isIntentional: !!task.isIntentional,
          treatmentId: task.treatmentId != null ? task.treatmentId : null,
          totalTimeMinutes: task.totalTimeMinutes != null ? task.totalTimeMinutes : null,
          // Necesarios para reconstruir el input de UpdateManyScheduleTasks (Fase 2).
          cycleTimeMinutes: task.cycleTimeMinutes != null ? task.cycleTimeMinutes : null,
          treatmentTimeMinutes: task.treatmentTimeMinutes != null ? task.treatmentTimeMinutes : null,
        };
        const els = (task.scheduleTaskElementsByScheduleTaskId && task.scheduleTaskElementsByScheduleTaskId.nodes) || [];
        // Une los workOrderId de los elementos de la tarea (una tarea puede agrupar varios).
        const woIds = new Set();
        els.forEach(function (el) {
          const rn = el && el.recipeNodeByRecipeNodeId;
          if (rn && rn.workOrderId != null) woIds.add(rn.workOrderId);
        });
        woIds.forEach(function (woId) {
          const arr = byWorkOrderId[woId] || (byWorkOrderId[woId] = []);
          // dedup por taskId (una tarea aparece 1 vez por WO)
          if (arr.some(function (t) { return t.taskId === base.taskId; })) return;
          arr.push(base);
        });
      });
    });
    // ordena cada lista por expectedStartTime ascendente (nulls al final)
    Object.keys(byWorkOrderId).forEach(function (k) {
      byWorkOrderId[k].sort(function (a, b) {
        const ta = a.expectedStartTime, tb = b.expectedStartTime;
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return ta < tb ? -1 : (ta > tb ? 1 : 0);
      });
    });
    return { byWorkOrderId: byWorkOrderId };
  }

  // Tarea(s) de una WO (por workOrderId GLOBAL). [] si no está programada.
  function resolveBoardScheduleForWO(index, workOrderId) {
    if (!index || workOrderId == null) return [];
    return index.byWorkOrderId[workOrderId] || [];
  }

  // Línea legible de UNA tarea: "T108-LI Níquel Electroless · 15/07 21:15 · En cola".
  // (glue puede localizar la hora con Date; esto es el fallback determinista.)
  function formatScheduleTaskLine(task) {
    if (!task) return '—';
    const parts = [];
    if (task.stationName) parts.push(task.stationName);
    const when = formatShortDateTime(task.expectedStartTime);
    if (when) parts.push(when);
    const st = scheduleStatusLabel(task.status);
    if (st) parts.push(st);
    return parts.join(' · ') || '(programada)';
  }

  // Traducción de los status de tarea a español (ES+EN tolerante). Desconocido → tal cual.
  function scheduleStatusLabel(status) {
    if (!status) return '';
    const s = String(status).toUpperCase();
    const MAP = {
      QUEUED: 'En cola', IN_PROGRESS: 'En proceso', RUNNING: 'En proceso',
      COMPLETED: 'Completada', DONE: 'Completada', PAUSED: 'Pausada',
      SCHEDULED: 'Programada', CANCELLED: 'Cancelada', CANCELED: 'Cancelada',
      BLOCKED: 'Bloqueada',
    };
    return MAP[s] || status;
  }

  // Texto compacto de la programación de UNA WO (celda del listado / fallback).
  //   [] → "—" ; 1 tarea → línea ; N → "<primera>  (+N-1)"
  function formatBoardScheduleCell(tasks) {
    if (!tasks || !tasks.length) return '—';
    let s = formatScheduleTaskLine(tasks[0]);
    if (tasks.length > 1) s += '  (+' + (tasks.length - 1) + ')';
    return s;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 2 — programación INTENCIONAL (fijar una tarea existente): input de la
  // mutación UpdateManyScheduleTasks. Confirmado en scan real (button:Update en la
  // ficha): { scheduledTasks: [{ id, scheduleId, stationId, expectedStartTime,
  //   totalTimeMinutes, cycleTimeMinutes, treatmentTimeMinutes, isIntentional }] }.
  // STATIC-SCHEDULED = isIntentional:true. Es UPDATE por id (NO crea) → la tarea debe
  // existir (auto-agendada). Para crear desde cero: CreateManyScheduleTasks (payload aparte).
  // ══════════════════════════════════════════════════════════════════════════
  // Echo de TODOS los campos existentes de la tarea (el server los espera) + override de
  // expectedStartTime + isIntentional. `expectedStartTime` debe ir en ISO UTC (…Z).
  // overrides: { expectedStartTime?, isIntentional? (default true) }. null si falta id.
  function buildScheduleTaskUpdateInput(task, overrides) {
    overrides = overrides || {};
    if (!task || task.taskId == null) return null;
    return {
      scheduledTasks: [{
        id: task.taskId,
        scheduleId: task.scheduleId,
        stationId: task.stationId,
        expectedStartTime: (overrides.expectedStartTime != null) ? overrides.expectedStartTime : task.expectedStartTime,
        totalTimeMinutes: task.totalTimeMinutes,
        cycleTimeMinutes: task.cycleTimeMinutes,
        treatmentTimeMinutes: task.treatmentTimeMinutes,
        isIntentional: (overrides.isIntentional != null) ? !!overrides.isIntentional : true,
      }],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Impresión de PDFs (JobTag / Verbose / WorkOrder) — helpers puros
  // ══════════════════════════════════════════════════════════════════════════
  // El PDF se genera SERVER-SIDE (PDFGeneratorAPI) y se entrega como share-URL
  //   https://app.gosteelhead.com/api/pdf/share/<shareId>/<token>?downloadName=<name>.pdf
  // visible en el modal de preview como <object data="…">. NO reconstruimos el `data`
  // del renderizador (lo arma el front, blob gigante) → el applet AUTO-MANEJA el flujo
  // nativo (click "Imprimir Etiquetas" → modal → click "Imprimir Regular/Detallado") y
  // toma la URL del <object>, sin mostrar el preview. Por-OT (una a la vez) = sin el
  // techo de merge de PDFGeneratorAPI (~16-20 OTs en batch).
  //
  // Anclaje del botón del modal: ROBUSTO por posición (los 2 MuiButton-contained del
  // modal "Imprimir Etiqueta de Trabajo": order 0 = Regular/JobTag, 1 = Detallado/Verbose)
  // + confirmación por texto ES. EN = deuda bilingüe (falta el string real del otro locale;
  // NO se adivina — el anclaje primario es estructural, el texto solo confirma).
  const PRINT_TYPES = {
    jobtag:  { key: 'jobtag',  order: 0, buttonTextEs: 'Imprimir Regular',   filenameStem: 'work-order-part-number' },
    verbose: { key: 'verbose', order: 1, buttonTextEs: 'Imprimir Detallado', filenameStem: 'work-order-part-number-verbose' },
  };
  function printTypeList() { return Object.keys(PRINT_TYPES).map(function (k) { return PRINT_TYPES[k]; }); }
  function printType(key) { return (key && PRINT_TYPES[key]) ? PRINT_TYPES[key] : null; }

  // ?sa_print=jobtag|verbose → key válido o null. (Disparo remoto desde el listado.)
  function parsePrintParam(search) {
    if (typeof search !== 'string') return null;
    const m = search.match(/[?&]sa_print=([a-z]+)/i);
    if (!m) return null;
    const v = m[1].toLowerCase();
    return PRINT_TYPES[v] ? v : null;
  }

  // ¿Es una share-URL de PDF de Steelhead? (/api/pdf/share/<id>/<token>)
  function isPdfShareUrl(url) {
    return typeof url === 'string' && /\/api\/pdf\/share\/\d+\/[a-z0-9]+/i.test(url);
  }
  // Parte una share-URL → { shareId, token, downloadName }. null si no matchea.
  function parsePdfShareUrl(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/api\/pdf\/share\/(\d+)\/([a-z0-9]+)/i);
    if (!m) return null;
    let downloadName = '';
    const dn = url.match(/[?&]downloadName=([^&#]+)/i);
    if (dn) { try { downloadName = decodeURIComponent(dn[1]); } catch (_) { downloadName = dn[1]; } }
    return { shareId: m[1], token: m[2], downloadName: downloadName };
  }
  // Nombre de archivo de respaldo si la URL no trae downloadName.
  function buildPdfFilename(typeKey, woIdInDomain) {
    const t = printType(typeKey);
    const stem = t ? t.filenameStem : 'work-order';
    return stem + (woIdInDomain != null ? '-' + woIdInDomain : '') + '.pdf';
  }

  // Encabezado del modal de selección de plantilla (ES confirmado; EN = deuda bilingüe).
  function isPrintDialogHeading(text) {
    if (typeof text !== 'string') return false;
    return /imprimir\s+etiqueta\s+de\s+trabajo/i.test(text);
  }
  // Encabezado del modal de preview (ES confirmado; EN = deuda bilingüe).
  function isPrintPreviewHeading(text) {
    if (typeof text !== 'string') return false;
    return /vista\s+previa\s+de\s+etiqueta/i.test(text);
  }

  const api = {
    WO_INDEX_RE, WO_DETAIL_RE, DOMAIN_RE,
    PRINT_TYPES, printTypeList, printType, parsePrintParam,
    isPdfShareUrl, parsePdfShareUrl, buildPdfFilename,
    isPrintDialogHeading, isPrintPreviewHeading,
    isWorkOrdersIndexPath, isWorkOrderDetailPath, parseWorkOrderIdInDomain, parseDomainId,
    extractPartNumbers, pnLink, extractWorkOrderGlobalId, extractPartNumberDetail,
    extractWorkOrderBatches, batchLink,
    buildScheduleIndex, resolveByWorkOrderId, resolveByAccountIds,
    stationNameMap, stationName,
    buildBoardScheduleIndex, resolveBoardScheduleForWO,
    formatScheduleTaskLine, scheduleStatusLabel, formatBoardScheduleCell,
    buildScheduleTaskUpdateInput,
    parseIsoParts, formatShortDateTime, formatScheduleCell,
  };
  if (typeof window !== 'undefined') window.WoScheduleCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
