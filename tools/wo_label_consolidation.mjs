// Reproducción determinista del bug de duplicación de etiquetas (job tags) en
// `pdf:WORK_ORDER_PART_NUMBER_TEMPLATE`.
//
// El template genera una etiqueta por contenedor (`numeroContenedores`) por cada
// `partEntry` de `allPartsOnWorkOrder` cuyo `receivedBatch.id` coincide con el lote.
// PROBLEMA: cuando la OT se parte en varias partAccounts (PTAs / partGroups), el
// mismo `receivedBatch.id` aparece en VARIOS partEntry, así que el loop de
// contenedores corre una vez por cada parte → labels = numeroContenedores × (#partAccounts).
//
// `numeroContenedores` es un atributo del LOTE FÍSICO (se captura una vez en
// `DatosRecibo`). Partir el account NO multiplica los contenedores físicos: solo
// reparte cuántos quedan en cada parte. El total de etiquetas debe permanecer
// igual a los contenedores iniciales del lote → consolidado, NO duplicado.

/** parseo de numeroContenedores idéntico al template (parseInt + fallback a 1). */
export function parseNumeroContenedores(batch) {
  const raw = batch?.customInputs?.DatosRecibo?.numeroContenedores;
  let n = parseInt(raw, 10);
  let defaulted = false;
  if (isNaN(n) || n <= 0) {
    n = 1;
    defaulted = true;
  }
  return { numeroContenedores: n, defaulted };
}

/**
 * COMPORTAMIENTO ACTUAL (con bug): replica el doble loop del template.
 * forEach(batch) → forEach(partEntry del batch) → for(numeroContenedores) push.
 * Devuelve la lista plana de etiquetas que produciría el template.
 */
export function buildLabelsCurrent(inputs) {
  const labels = [];
  for (const [batchIndex, batch] of (inputs.receivedBatches || []).entries()) {
    const { numeroContenedores } = parseNumeroContenedores(batch);
    const partsForBatch = (inputs.allPartsOnWorkOrder || []).filter(
      (p) => p.receivedBatch?.id === batch.id
    );
    for (const partEntry of partsForBatch) {
      const part = partEntry.partNumber;
      for (let i = 0; i < numeroContenedores; i++) {
        labels.push({
          batchId: batch.id,
          batchIndex: batchIndex + 1,
          partNumberId: part?.id ?? null,
          partName: part?.name ?? null,
          partGroupId: partEntry.partGroup?.id ?? null,
          containerIndex: i + 1,
          containerDisplay: `${i + 1}/${numeroContenedores}`,
          partQuantity: partEntry.quantity ?? 0,
        });
      }
    }
  }
  return labels;
}

/**
 * COMPORTAMIENTO CONSOLIDADO (fix): `numeroContenedores` es por LOTE.
 * Dentro de cada batch se agrupa por partNumber.id (colapsa las partAccounts del
 * mismo PN), se suma la cantidad repartida entre las partes, y se generan
 * exactamente `numeroContenedores` etiquetas por PN distinto del lote.
 *
 * - Split del mismo PN en N partAccounts → 1 grupo → numeroContenedores etiquetas (NO ×N).
 * - Lote con PNs genuinamente distintos → se preservan por separado.
 */
export function buildLabelsConsolidated(inputs) {
  const labels = [];
  for (const [batchIndex, batch] of (inputs.receivedBatches || []).entries()) {
    const { numeroContenedores } = parseNumeroContenedores(batch);
    const partsForBatch = (inputs.allPartsOnWorkOrder || []).filter(
      (p) => p.receivedBatch?.id === batch.id
    );

    // Agrupar por partNumber.id; sumar cantidades repartidas entre partAccounts.
    const byPart = new Map();
    for (const partEntry of partsForBatch) {
      const pid = partEntry.partNumber?.id ?? `__null_${labels.length}`;
      const existing = byPart.get(pid);
      if (existing) {
        existing.totalQuantity += partEntry.quantity ?? 0;
        existing.partGroupIds.push(partEntry.partGroup?.id ?? null);
      } else {
        byPart.set(pid, {
          partEntry,
          part: partEntry.partNumber,
          totalQuantity: partEntry.quantity ?? 0,
          partGroupIds: [partEntry.partGroup?.id ?? null],
        });
      }
    }

    for (const group of byPart.values()) {
      for (let i = 0; i < numeroContenedores; i++) {
        labels.push({
          batchId: batch.id,
          batchIndex: batchIndex + 1,
          partNumberId: group.part?.id ?? null,
          partName: group.part?.name ?? null,
          partGroupIds: group.partGroupIds, // todas las partAccounts consolidadas
          containerIndex: i + 1,
          containerDisplay: `${i + 1}/${numeroContenedores}`,
          partQuantity: group.totalQuantity, // suma de las partes
        });
      }
    }
  }
  return labels;
}

/** Resumen de conteo por batch para reportar. */
export function countByBatch(labels) {
  const m = new Map();
  for (const l of labels) m.set(l.batchId, (m.get(l.batchId) || 0) + 1);
  return m;
}
