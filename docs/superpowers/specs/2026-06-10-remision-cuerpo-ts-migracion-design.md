# Remisión — migración del cuerpo a TypeScript + rojo de OV pendiente — diseño (2026-06-10)

> **Estado: DISEÑO (pendiente de aprobación del usuario).** Migra las 4 columnas del cuerpo
> de la remisión de expression language (PDFGeneratorAPI) a `additionalPayload.bodyRows[]`
> en `powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts`, corrigiendo bugs de consolidación
> Group-by-PN y agregando el rojo `isPending` (espejo de la factura). Aún **no** implementado.

## Contexto / problema

El usuario pidió replicar en la **remisión** (packing slip) la "lógica del rojo" que la
factura ya aplica: pintar en rojo la línea OC(OV) cuando la orden está **pendiente**
(`/pen/i` o `"."`). Al investigar se confirmó que:

- El **cuerpo de la remisión** (columnas **Cantidad Recibida · Descripción · Referencias ·
  Cantidad Embarcada**) se arma 100% en **expression language** de PDFGeneratorAPI contra
  tokens nativos `{partsTransferAccounts::...}` — **no** en el `.ts`. El hook
  `PACKING_SLIP_TEMPLATE.ts` hoy solo (a) muta `item.containerIndex` y (b) arma
  `additionalPayload.labels[]` para las **páginas de etiqueta** (aparte del cuerpo).
- La factura sí arma su HTML por fila en el `.ts` (`INVOICE_TEMPLATE.ts` →
  `invoiceLinesConLotes[]` con `descripcionHtml`/`npHtml`, rojo `isPending` en
  `INVOICE_TEMPLATE.ts:352-381`). La tabla del template itera ese array.

El usuario eligió **replicar ese patrón** (Opción C: migrar el cuerpo entero al `.ts`),
**con la condición de auditar primero dónde la fórmula actual puede fallar**. Una auditoría
adversarial (6 analizadores, ~90 escenarios) confirmó **bugs reales** en la fórmula nativa,
sobre todo en la consolidación Group-by-PN.

Afecta:
- **`powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts`** (`getPdfCustomization`) — cambio principal.
- **El query de datos del PDF de packing slip en Steelhead** — extensión para exponer
  `initialAmount` del lote (ver §Cantidad Recibida).
- **La plantilla visual de PDFGeneratorAPI** — re-apuntar la tabla del cuerpo a `bodyRows[]`
  (lo hace el usuario; ver §Wiring del template).

## Decisiones cerradas (con el usuario, 2026-06-10)

| # | Decisión |
|---|---|
| 1 | **Enfoque = Opción C** (mirror completo): las 4 columnas se arman en el `.ts` como `additionalPayload.bodyRows[]`; la tabla del template itera ese array. |
| 2 | **Group-by-PN en el `.ts`**, key = `pn.id` (number), **no** `pn.name` ni `pn.id+WO` ni `pn.id+batch`. Una fila por PN único del embarque. |
| 3 | **OC(OV): unir OVs únicas** (dedup por `receivedOrder.idInDomain`, fallback `name`) separadas por coma; **rojo** si **cualquiera** es pendiente (`/pen/i` o `=== "."`, con `trim()`). Alcance del rojo: **solo la línea OC(OV)**, 14pt, espejo de la factura. |
| 4 | **Cantidad Recibida = `initialAmount` del lote con fallback a `billablePartCount`** (COALESCE **auto-actualizable**, ver §Validación). `initialAmount` es el campo correcto (validado en DB = recibido del lote) pero **hoy NO llega** al hook → el COALESCE cae a `billablePartCount` solo. Cuando se extienda el query, el mismo código usa `initialAmount` sin cambios. Σ sobre los lotes/cuentas del grupo PN. |
| 5 | **Cantidad Embarcada = Σ `part.partCount`** (piezas físicas del PS) de los PTAs **únicos** del grupo. |
| 6 | **Balance**: cuando embarcado > recibido → Estatus **"Excedente"** y `"+N PZA"`. (`Completa` si =, `Parcial`+`Balance −N` si <.) |
| 7 | **Sufijo Schneider VM/VE = por lote individual.** No es MTY/TLC (dominios distintos, no se mezclan): es **vale manual/automático según el formato del folio**. Cada lote (separado por comas) lleva su propio VM/VE **cuando aplica**: para clientes `SCH*`, `name` del lote con prefijo `RG-M` → `VM`, en otro caso → `VE`. |
| 8 | **`descriptionMarkdown` = markdown básico → HTML** (`**negrita**`, `_cursiva_`, `\n`→`<br>`) **+ escape** de `< > &`. |
| 9 | **Robustez obligatoria**: `try/catch` global (espejo factura), **cero `??`/`??=`** (ES2017, SyntaxError silencioso), fila **placeholder** cuando `bodyRows` queda vacío, `null`→`""` y booleanos como `'1'`/`'0'`, todos los `Map`/`Set` **dentro** del hook (idempotencia). |

## Registro de riesgos (auditoría 2026-06-10) — lo que el `.ts` debe corregir

Severidad **ALTA** agrupada (la fórmula nativa colapsa al **primer** registro del array
anidado y no consolida cross-item):

**① Consolidación Group-by-PN rota**
- Cantidad Recibida no suma entre PTAs/items → subestima (CR-7, CR-8).
- Cantidad Embarcada usa `{partCount}` = **total del item**: con grupos de partes infla ×N
  grupos (CE-1); con multi-batch triplica (Estructura CR-12).
- **Estatus siempre "Parcial"** con >1 PTA: compara número vs **array**
  (`{partsTransferAccounts::...billablePartCount}` resuelve a arreglo) (CE-9); Balance NaN/negativo
  si `partNumberWorkOrder` es null (CE-10).
- Referencias (OC/OV, OT, Lote, PS, Cotización) muestran **solo el primer** PTA/batch; el resto
  se oculta (Ref CR-1, CR-8, CR-10, CR-14, CR-16, CR-17).

**② Peso: el fix #1090 no está en el cuerpo**
- Cantidad Embarcada multiplica `×2.2046` siempre que cliente=LB sin mirar la unidad de
  **origen** → **duplica** si el origen ya es LBR (Wieland/partGroup, CE-3); si origen=LBR y
  cliente=KG, imprime libras etiquetadas "KGM" sin convertir (CE-4).
- Cantidad Recibida toma `unitConversions[0].factor` a ciegas: sin validar que `[0]` sea la
  unidad correcta (CR-4), que `factor>0` (CR-3), y multiplica `×2.2046` aunque el factor ya esté
  en libras (CR-5, CR-16).

**③ Ramas sin guard / nulos**
- `numeroContenedores` null → `"  contenedor"` roto (CR-9/11/17 Recibida).
- `specFieldParameters`/`specField`/`spec` null → celda vacía o `"null: "` literal
  (DS-6, DS-8, DS-10, DS-12); Acabados `[]` deja `"Acabados:"` sin valor (DS-4); `<br>` extra del
  bloque Espesor/Grano vacío (DS-20).
- `receivedOrder` null → `"OC (OV): ()"` (Ref CR-2); `quoteId===0` falsy se oculta (Ref CR-15).
- `"Sin peso"` aunque exista el bruto (CE-2); `net=0` muestra "Sin peso" (CE-13).
- Parseo de `comment` frágil: token no numérico → conteo y plural incorrectos (CE-5/6/8).

**④ Robustez del hook**
- **No hay `try/catch` global** (la factura sí) → cualquier excepción tumba **todo** el PDF (ID-12).
- Riesgo `??` → **SyntaxError silencioso** ES2017 → payload vacío (ID-14).
- Mutación `item.containerIndex` no idempotente / frágil ante deep-clone (ID-1).
- `bodyRows[]` vacío → PDFGeneratorAPI no crea nodos → hace falta placeholder (ID-18).
- Constante `2.202643172` (fórmula) vs `2.2046226218` (.ts/tests) — usar la del `.ts` (CE-17).

**⑤ Rojo `isPending` ausente** en la remisión (la factura sí lo pinta) (Ref CR-4) — la mejora pedida.

Severidad media/baja relevante: dedup de specs/labels/OVs por casing-espacios (DS-17),
`descriptionMarkdown` con HTML/markdown crudo (DS-13/14), Schneider con `substr` sin `trim`
(Ref CR-19), `quoteId===0` (Ref CR-15).

## Diseño — `additionalPayload.bodyRows[]`

Dentro de un `try/catch` global, tras los guards iniciales, el hook construye **una fila por
`pn.id` único** del embarque. Se reusa el `rows[]` del Paso 1 actual (item × PTA × batch) pero
se **re-agrupa solo por `pn.id`**, **dedupeando PTAs por `pta.id`** para no doble-contar la
expansión por batch.

```ts
type BodyRow = {
  pnId: number;
  partNumber: string;            // pn.name ?? ''
  cantidadRecibidaHtml: string;  // Σ initialAmount(fallback billable) + peso teórico + contenedores
  descripcionHtml: string;       // PN + desc(md) + grupo + Acabados(union) + Especificación(union)
  referenciasHtml: string;       // OC(OV) dedup +ROJO si anyPending · OT · Lote · PS+Schneider · Cotización
  cantidadEmbarcadaHtml: string; // Σ part.partCount + peso net + contenedores + Estatus/Balance
  anyPending: string;            // '1' | '0' (string para que PDFGeneratorAPI cree el nodo)
  _placeholder: string;          // '1' en la fila placeholder, '' en reales
};
```

Helpers ya validados que se **reusan** (no se reimplementan): `isLbCustomer`/`displayInLb`/
`weightUnit`, `convertWeight(v, sourceIsLb)`, `unitIsLb`, `readPS`, `fmtDate`, constante
`KG_TO_LB = 2.2046226218`.

### Agrupación (corrige ①, ④-idempotencia)

- `Map<number, Acc>` keyed por `pn.id`, **declarado dentro del hook**.
- Por cada `row` (de `rows[]` ya filtrado `pn.id != null`): acumular en el grupo.
- **Dedup de PTAs por `pta.id`** (un `Set` por grupo): piezas y peso se suman **una vez por
  PTA**, no por batch (corrige CR-12/③). Lotes/OVs/OTs/PS sí recorren todos los batches.

### Cantidad Recibida (decisión #4, corrige ①②③)

- `recibidaCount = Σ` sobre cuentas/lotes del grupo de
  `inventoryAccount.initialAmount` **con fallback** a `pta.partNumberWorkOrder?.billablePartCount`
  cuando `initialAmount` es null/ausente (guard `partNumberWorkOrder != null`).
- **Peso teórico** (el `<small>` actual): `recibidaCount × factor` donde `factor` se busca en
  `pn.unitConversions[]` **por unidad** (la del cliente: si `displayInLb` → entrada LBR, si no →
  KGM), validando `factor > 0`. Se aplica `convertWeight` según la unidad del factor (NO `×2.2046`
  a ciegas; corrige CR-3/4/5/16). Si no hay conversión válida → omitir el peso (sin `"(Sin factor)"`
  con paréntesis colgante; corrige CR-2).
- **Contenedores**: `Σ numeroContenedores` (parse `Number`, guard) sobre los **batches únicos** del
  grupo (`customInputs.DatosRecibo.numeroContenedores`); si total `>= 1` → `"N contenedor(es)"`
  pluralizado por número JS; si null/0 → omitir el bloque (corrige CR-9/11/17).

### Descripción (decisión #8, corrige ③ + DS-15/16/17)

- `<b>${escape(pn.name)}</b>` + `mdToHtml(descriptionMarkdown)` + `partNumberGroup?.name`
  (omitido si vacío; corrige DS-3).
- **Acabados**: union/dedup de `(pn as any).labels` (no está en el typedef; cast `any` como en
  factura) de **todos** los PTAs del grupo; solo emitir `"<br><b>Acabados: </b>…"` si la lista
  no vacía (corrige DS-4/16).
- **Especificación** (specs EXTERNAL): union/dedup de `specFieldParameters` de todos los PTAs,
  con optional chaining total (`sfp?.specField?.spec?.type`), comparación `=== 'EXTERNAL'`
  case-insensitive, filtrando `spec.name` null; solo emitir el bloque si hay ≥1 (corrige
  DS-6/8/10).
- **Bloque Espesor/Grano**: mismo patrón; el `<br>` y el contenido solo si la lista filtrada no
  está vacía (corrige DS-20). Dedup por `spec.name.trim().toLowerCase()` mostrando el casing
  original (DS-17).
- `mdToHtml`: escapa `& < >`, convierte `**x**`→`<b>x</b>`, `_x_`→`<i>x</i>`, `\n`→`<br>`.

### Referencias (decisiones #3 y #7, corrige ①③⑤)

Cada línea se **omite completa** si no hay dato (sin labels colgantes):

- **OC (OV)**: `Set` de `{name, idInDomain}` de `pta.workOrder.receivedOrder` (guard `!= null`)
  de todos los PTAs del grupo, dedup por `idInDomain` (fallback `name`). `ovStr = join(", ")`.
  `anyPending = some(n => { const t=(name??'').trim(); return /pen/i.test(t) || t==='.'; })`.
  Si `anyPending` → `<span style="color:red; font-size:14pt;"><b>OC (OV): </b>${ovStr}</span>`,
  si no → `<b>OC (OV): </b>${ovStr}`. Línea omitida si el `Set` está vacío.
- **OT**: `Set` de `workOrder.idInDomain` (dedup) de los PTAs; sufijo `" - name"` solo si única y
  `name.trim()` no vacío (corrige Ref CR-6/7/8/21).
- **Lote**: dedup de `batch.name` de todos los batches del grupo.
- **PS Cliente**: por **cada lote** → `readPS(batch.customInputs)` + sufijo Schneider individual
  (`SCH*` && `batch.name.trim().substring(0,4)==='RG-M' ? 'VM' : 'VE'`), unidos por coma; solo los
  que tengan PS (corrige Ref CR-11/12/13/19/20).
- **Cotización**: `quote.quoteId != null` (incluye 0; corrige Ref CR-15), dedup si varias.

### Cantidad Embarcada (decisiones #5 y #6, corrige ①②③)

- `embarcadaCount = Σ pta.partCount` de PTAs únicos del grupo → `"N PZA"`.
- **Peso neto**: `Σ netWeight` ya convertido por `convertWeight(netSrc, sourceIsLb)` (reusa el
  cálculo de etiquetas; fallback a bruto si falta neto, corrige CE-2/13); `"(N {unit})"` o
  `"Sin peso"` solo si realmente null.
- **Contenedores**: `parseInt(comment.trim().split(/\s+/)[0], 10)` con fallback `1`, pluralizado
  por número JS (corrige CE-5/6/8/16). *(Alternativa más limpia disponible:
  `DatosRecibo.numeroContenedores`; ver §Pendientes.)*
- **Estatus / Balance** (decisión #6, corrige CE-9/10/11/12):
  - `embarcadaCount === recibidaCount` → `Completa`.
  - `embarcadaCount <  recibidaCount` → `Parcial` + `Balance: ${recibidaCount-embarcadaCount} PZA`.
  - `embarcadaCount >  recibidaCount` → `Excedente` + `Balance: +${embarcadaCount-recibidaCount} PZA`.
  - Comparado contra `recibidaCount` (misma fuente que Cantidad Recibida) para consistencia interna.

### Robustez (decisión #9)

- `try/catch` global → en error, `addErrorMessage({severity:'error', …})` y `return result` con lo
  calculado (espejo `INVOICE_TEMPLATE.ts:47,801-806`).
- **Cero `??`/`??=`**; solo `!= null` / ternarios. Check de CI: `grep -n '??' PACKING_SLIP_TEMPLATE.ts`.
- `null`→`''` por campo; `anyPending`/`_placeholder` como `'1'`/`'0'`/`''` (string), nunca boolean
  (corrige ID-13).
- Si `bodyRows.length === 0` → emitir 1 fila placeholder (`_placeholder:'1'`, demás `''`) +
  `addErrorMessage` warning (corrige ID-18/ID-2).
- Mantener la mutación `item.containerIndex` por compatibilidad **y además** exponer
  `containerIndexByItemId` en el payload (camino a quitar la mutación; ID-1).
- Diagnóstico: chips `missingPN`, `missingSO`, `missingRecibida`, etc. (consolidados por severidad).

## Validación de la fuente de Cantidad Recibida (2026-06-10)

Se evaluaron 3 fuentes contra la DuckDB (TLC, remisiones recientes) + un dump en el Test Panel:

| Fuente | Reachable en el hook hoy | ¿Buena para "recibido del lote"? |
|---|---|---|
| `initialAmount` (cuenta de inv. del lote) | **NO** (ver dump) | **Sí** — `first_credit/1e6` coincide exacto con lo embarcado: 50/50, 45/45, 115/115, 600/600 |
| `billablePartCount` (`partNumberWorkOrder`) | **Sí** (directo) | Aproximado — campo **computado** (no hay columna en DB); el usuario reporta que "a veces no coincide" |
| `received_order_part_transform.count` (ROPT) | Sí (vía OV, por match de PN) | **NO** — es el **total de la OV** (1656/160/30…), no la del lote → **descartado** |

- **Dump en Test Panel (remisión real):** el batch del packing slip trae keys
  `id,name,descriptionMarkdown,createdAt,createdBy,partNumberOnBatch,customInputs` — **sin**
  `inventoryAccountsByInventoryBatchId`. `initialAmount` = `"AUSENTE"`. El runtime trae más campos
  que el typedef (`createdAt`/`createdBy`) → el shape lo fija el query de Steelhead, no el typedef.
- **Conclusión:** `initialAmount` es el campo correcto pero **Steelhead no lo expone hoy** para el
  documento "packing slip" (sí para "receiver"). El COALESCE `initialAmount → billablePartCount`
  hace que el hook use **billable hoy** y se **auto-actualice** a `initialAmount` el día que el
  query lo exponga, **sin cambiar el `.ts`**.

### Extensión del query (mejora futura, opcional)

Para activar `initialAmount` (cuando se quiera la fuente correcta):

1. Agregar al **data query del PDF de packing slip en Steelhead**:
   `partsTransferAccounts[].receivedBatches[].inventoryAccountsByInventoryBatchId[] { initialAmount, partNumber { id } }`
   (el schema lo soporta — `RECEIVER_TEMPLATE.ts:118-150` ya lo trae). **Pendiente confirmar si ese
   query es editable del lado del usuario o requiere petición a Steelhead.**
2. Re-correr el dump para confirmar que llega y su **unidad** (piezas vs microquantity `/1e6`).
3. Sumar el typedef `Inputs` y, si viene en microquantity, dividir entre `1e6`.
4. **No requiere cambio de la lógica** del hook — el COALESCE ya lo toma como primario.

## Pruebas

Espejo de `tools/packing_slip_weight.mjs`: extraer la lógica pura a
**`tools/packing_slip_body.mjs`** (`buildBodyRows(inputs)` puro, sin `helpers`) con `node:test`
cubriendo los escenarios de la auditoría:

- 1 PN en N items (consolidación), grupos de partes (1 item N PTAs), multi-batch (no triplicar).
- Origen LBR + cliente LB (no duplicar) y origen LBR + cliente KG (convertir).
- `initialAmount` presente / null (fallback billable) / 0.
- OV pendiente (`pen`, `.`, ` . `) → rojo; OVs múltiples dedup.
- specs/labels null, vacíos, con casing duplicado.
- Estatus Completa/Parcial/Excedente y Balance.
- Schneider per-lote VM/VE; `comment` no numérico.

`tsc --target es2017 --strict --alwaysStrict` en verde; `grep '??'` sin hits.

## Wiring del template (PDFGeneratorAPI — lo hace el usuario)

- Re-apuntar la **tabla del cuerpo** a iterar `additionalPayload.bodyRows`.
- Cada celda renderiza su `*Html` como **HTML content**. En la captura actual, Descripción /
  Referencias / Cantidad Embarcada **ya son `[HTML CONTENT]`**; **Cantidad Recibida** pasa de
  `[EXPRESSION]` a `[HTML CONTENT]`.
- El **Group-by-PN** del template ya **no** es necesario (la consolidación se hace en el `.ts`);
  filtrar las filas con `_placeholder == '1'` si se desea ocultarlas.
- Verificar que el motor renderiza HTML embebido en celda (el `<span>` rojo y `<b>`).

## Despliegue / rollback

- Deploy del hook: `python3 tools/lowcode_sync.py push <ruta> pdf:PACKING_SLIP_TEMPLATE`
  (CreatePdfLowCode). Versión activa previa para rollback: ver
  `PACKING_SLIP_TEMPLATE.meta.json` (`active_id` actual = 10630).
- Estrategia segura: el `bodyRows[]` es **aditivo** (no rompe `labels[]` ni la remisión actual);
  el cambio se vuelve visible solo cuando el usuario re-apunta la tabla del template. Permite
  validar `bodyRows` en Test Panel antes de tocar la plantilla productiva.

## Pendientes a confirmar / verificar

- **initialAmount**: ✅ resuelto — no llega hoy, se usa `billablePartCount` vía COALESCE; el query
  editable para exponerlo queda como mejora futura opcional (§Validación).
- **Estatus** comparado contra `recibidaCount` (hoy = billable) — confirmar si el "Excedente/Parcial"
  debe medir contra el recibido o contra el billable puro (hoy coinciden por el COALESCE).
- **numeroContenedores** del `comment` vs el campo limpio `DatosRecibo.numeroContenedores` (¿migrar
  la fuente de contenedores embarcados al customInput?).
- Render de **HTML en celda** del cuerpo (verificar en el motor).
