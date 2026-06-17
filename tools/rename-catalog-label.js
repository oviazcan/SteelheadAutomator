/* ============================================================================
 * rename-catalog-label.js — Rename de UNA etiqueta en el catálogo CatProcesos
 * (artículo de inventario 900192) de Steelhead.
 * ----------------------------------------------------------------------------
 * Reemplaza una etiqueta por otra POR IGUALDAD EXACTA DE CAMPO (Etiqueta1..6),
 * NUNCA por substring. Por eso "Estaño Mate" jamás se convierte en
 * "Estaño Brillante Mate": solo se tocan los campos cuyo valor es EXACTAMENTE
 * el OLD_LABEL.
 *
 * Necesario porque el catálogo guarda las etiquetas como TEXTO (no por id), así
 * que renombrar la etiqueta en Steelhead NO actualiza estas entradas → la
 * Calculadora de Procesos dejaría de matchear hasta correr esto.
 *
 * USO (en el navegador, NO en Node):
 *   1. Abre una pestaña en https://app.gosteelhead.com (sesión iniciada).
 *   2. F12 → Console. Pega TODO este archivo.
 *   3. Corre primero con DRY_RUN = true (default): imprime el plan, NO escribe.
 *   4. Revisa la tabla de variantes. Si todo bien, cambia DRY_RUN = false y
 *      vuelve a pegar. Descarga un backup JSON y aplica el cambio (RMW).
 *   5. Después: renombra la etiqueta en Steelhead y corre en la plantilla
 *      "Actualizar Catálogos" + RefrescarListas para verificar.
 * ============================================================================ */
(async () => {
  'use strict';

  // ────────── CONFIG (edita aquí) ──────────
  const OLD_LABEL = 'Estaño';            // valor EXACTO a buscar
  const NEW_LABEL = 'Estaño Brillante';  // valor nuevo
  const DRY_RUN   = true;                // ← cambia a false para APLICAR
  // ─────────────────────────────────────────

  const INV_ITEM_ID = 900192;            // "Catálogo de Procesos (no archivar)"
  const CATALOG_KEY = 'CatProcesos';
  const MAX_ETQ = 6;                      // Etiqueta1..6
  const SCHEMA_FALLBACK = 942;
  const HASH = {
    get: '38a52d1ce2bbb2405b53a28500a273f015f11db393a0257622c8163b82bfc81f', // GetInventoryItem
    upd: 'e5eafcb715c4034adc406af5064a30d27eff273e5fb6121804a5a83f188828cf', // UpdateInventoryItemInputs
  };

  async function gql(operationName, variables, hash) {
    const res = await fetch('https://app.gosteelhead.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        operationName, variables,
        extensions: {
          clientLibrary: { name: '@apollo/client', version: '4.0.8' },
          persistedQuery: { version: 1, sha256Hash: hash }
        }
      })
    });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); }
    catch { throw new Error(`${operationName}: respuesta no-JSON (¿sesión expirada?): ${txt.slice(0, 200)}`); }
    // Para mutaciones el "data" puede ser null; el éxito es la AUSENCIA de errors.
    if (json.errors && json.errors.length) {
      throw new Error(`${operationName}: ${json.errors.map(e => e.message).join(' | ')}`);
    }
    return json.data;
  }

  async function readItem() {
    const vars = { id: INV_ITEM_ID, usagesLimit: 10, usagesOffset: 0, purchaseOrderBomItemsOffset: 0, purchaseOrderBomItemsLimit: 10 };
    const data = await gql('GetInventoryItem', vars, HASH.get);
    const it = (data && data.inventoryItemById) || {};
    const ci = it.customInputs || {};
    const sid = (it.inventoryItemInputSchemaByInputSchemaId && it.inventoryItemInputSchemaByInputSchemaId.id) || SCHEMA_FALLBACK;
    const entries = Array.isArray(ci[CATALOG_KEY]) ? ci[CATALOG_KEY] : [];
    return { ci, sid, entries };
  }

  // Auditoría: variantes que CONTIENEN el texto + conteo exacto.
  function audit(entries) {
    const variants = new Map(); // valor exacto → nº de campos
    let exactFields = 0, exactRows = 0;
    const oldLow = OLD_LABEL.toLowerCase();
    for (const e of entries) {
      let rowHit = false;
      for (let i = 1; i <= MAX_ETQ; i++) {
        const v = e['Etiqueta' + i];
        if (v == null || v === '') continue;
        const s = String(v);
        if (s.toLowerCase().includes(oldLow)) variants.set(s, (variants.get(s) || 0) + 1);
        if (s === OLD_LABEL) { exactFields++; rowHit = true; }
      }
      if (rowHit) exactRows++;
    }
    return { variants, exactFields, exactRows };
  }

  console.log(`%c[rename-catalog-label] OLD="${OLD_LABEL}" → NEW="${NEW_LABEL}"  DRY_RUN=${DRY_RUN}`, 'font-weight:bold;font-size:13px');

  const first = await readItem();
  console.log(`Catálogo leído: ${first.entries.length} combinaciones (inputSchemaId=${first.sid})`);

  const a = audit(first.entries);
  console.log('%cVariantes que CONTIENEN el texto (confirma qué NO se toca):', 'font-weight:bold');
  console.table([...a.variants.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([label, count]) => ({ etiqueta: label, campos: count, accion: label === OLD_LABEL ? '✅ RENOMBRA' : '🚫 intacta' })));
  console.log(`A renombrar (== "${OLD_LABEL}" EXACTO): ${a.exactFields} campos en ${a.exactRows} combinaciones`);

  if (a.exactFields === 0) { console.warn('Nada que renombrar. Fin.'); return; }

  if (DRY_RUN) {
    console.log('%c DRY_RUN: no se escribió nada. Si la tabla se ve bien, pon DRY_RUN=false y vuelve a pegar.', 'color:#c80;font-weight:bold');
    return;
  }

  // ── RMW: releer LO MÁS FRESCO, respaldar, mutar sobre lo fresco, escribir ──
  const fresh = await readItem();

  // Backup del catálogo previo (descarga JSON) ANTES de mutar.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(fresh.entries)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `CatProcesos_backup_${stamp}.json`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  console.log(`Backup descargado: ${link.download} (${fresh.entries.length} entradas)`);

  let changed = 0;
  for (const e of fresh.entries) {
    for (let i = 1; i <= MAX_ETQ; i++) {
      if (e['Etiqueta' + i] === OLD_LABEL) { e['Etiqueta' + i] = NEW_LABEL; changed++; }
    }
  }
  console.log(`Reemplazados ${changed} campos (exacto). Escribiendo…`);

  fresh.ci[CATALOG_KEY] = fresh.entries;
  await gql('UpdateInventoryItemInputs', { itemId: INV_ITEM_ID, inputSchemaId: fresh.sid, customInputs: fresh.ci }, HASH.upd);

  // Verificación: releer y contar OLD restantes (debe ser 0).
  const after = audit((await readItem()).entries);
  console.log(`%cVerificación: "${OLD_LABEL}" restantes = ${after.exactFields} (esperado 0)`, 'font-weight:bold;color:green');
  if (after.exactFields === 0) {
    console.log('%c✅ Catálogo actualizado. Ahora renombra la etiqueta en Steelhead y corre "Actualizar Catálogos" + RefrescarListas.', 'color:green;font-weight:bold');
  } else {
    console.warn('⚠️ Quedaron campos sin renombrar — revisar (¿escritura concurrente?).');
  }
})();
