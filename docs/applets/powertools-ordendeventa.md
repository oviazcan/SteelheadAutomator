# Low-code hooks de Steelhead (Power Tools): `rowKey` como handle de WO por crear (2026-05-15, `ordendeventa.ts`)

Los Power Tools de Steelhead exponen hooks TS (`getReceivedOrderCustomization`, `getInvoicePricing`, etc.) cuyo `LowCodeResult` declara campos como `workOrderLabels: { workOrderId: number, labelId: number }[]`. El typedef obliga `workOrderId: number`, pero en flujos donde la WO **aún no nace** (ej. "Add Parts to Sales Order") el `row.workOrder` viene como placeholder:

```ts
row.workOrder = {
  name: "New WO#1",                              // visual del dropdown
  fromRowKey: "29917336-b496-4a3b-a05c-...",     // no está en el typedef
  createdBy: { id: 11973, name: "..." }           // del usuario, no del WO
}
// no hay row.workOrder.id porque la WO no existe aún
```

**Hallazgo**: el runtime de Steelhead acepta `{ rowKey, labelId }` en `workOrderLabels` (mismo patrón que `partNumberWorkOrdersToGroup`, donde `rowKey` ya es el handle oficial). Etiqueta la WO al momento de nacer. Hay que castear a `any` porque el typedef no lo declara:
```ts
result.workOrderLabels!.push({ rowKey: group.rowKey, labelId: loteLabel.id } as any);
```
Verificado: la etiqueta `Lote` aparece en la WO 2503 recién creada al guardar.

**Generalizable**: cuando un campo de `LowCodeResult` pide un id pero estás en flujo "create" (sin id todavía), prueba `rowKey` casteado antes de descartar. Si el typedef de TS lo prohíbe pero existe un campo hermano que sí usa `rowKey` como handle (`partNumberWorkOrdersToGroup`), es señal fuerte de que el runtime acepta el mismo patrón en otros.

**Diagnóstico del shape**: `helpers.log` parece no imprimir en el panel "Test" del Power Tool (al menos no en este flujo). Atajo: dumpear el shape en un `helpers.addErrorMessage` temporal (`severity: 'info'`) con `JSON.stringify(...)` — sale directo en el UI. Se quita cuando el dato esté claro.

**Otras lecciones del mismo ciclo (`ordendeventa.ts`, lote mínimo + NP Desconocido):**
- **Piezas pedidas en "Add Parts to Sales Order"**: `row.lineItems` viene vacío (las líneas se crean al guardar). Las piezas reales son `row.quantity / row.selectedUnitConversion.factor + sum(row.inventory[].depleteQuantity)`. Si calculas desde `row.lineItems` el lote mínimo nunca se dispara.
- **"PN tiene proceso default"**: `partNumber.partNumberTreatment` viene vacío incluso cuando el PN sí tiene proceso. La señal confiable es `row.process != null` (Steelhead lo auto-rellena del default del PN).
- **`specFieldParam` para rango de Espesor**: el shape NO trae `.name` con el rango como string; trae `minimumValue` + `maximumValue` numéricos (y `targetValue` opcional). Construir `"${min}-${max}"` directamente, no caer al `name` que es undefined.
- **Etiquetas en PN vs en WO**: `LowCodeResult` no tiene canal para escribir `partNumberLabels` (solo lee). Probadas 3 formas casteadas a `any` en `getReceivedOrderCustomization` (2026-05-15) — todas aparecen sanas en el output del test pero ninguna aplica al backend al presionar Save:
  - `(result as any).partNumberLabels = [{partNumberId, labelId}]` (top-level inexistente)
  - `partNumberUpdates.push({partNumberId, labels: [labelId]} as any)` (extender con `labels`)
  - `partNumberUpdates.push({partNumberId, partNumberLabels: [{id, name}]} as any)` (shape exacto del input)

  `partNumberUpdates` solo acepta `customInputs` para escritura. A diferencia de `workOrderLabels` (donde `rowKey` sí se proyectó como canal alterno), aquí ningún cast funcionó. Para "NP Desconocido" (PN sin proceso o sin spec) el operador etiqueta manual; el mensaje del hook lo guía. Si en el futuro se necesita etiquetar PNs desde código, hay que abrir otro canal (mutation GraphQL desde un applet de extensión).
- **Consolidación de mensajes por severidad**: el UI de Steelhead apila cada `addErrorMessage` como row del alert panel. Si tienes N PNs con N issues, juntar chips por severidad en una sola llamada por bucket (`error`, `warning`, `info`) evita saturar el panel. Patrón: array de chips por bucket → `addErrorMessage({severity, message: bucketChips.join(' | ')})` al final.
- **Multi-fuente para detectar precio default**: `row.lineItems[].unitPrice` viene en algunos flujos pero **sin `unit` asociado** (visto en "Add Parts to Sales Order"). No condicionar la captura a `li.unit`; caer a `row.selectedUnitConversion.unitByUnitId` como unidad. Y agregar fallbacks: `row.unitPrice` (string, populado cuando hay precio default activo) → `row.quotePartNumber?.priceDollars` (de la quote vinculada). Si exiges `li.unit`, los PNs con precio default sin lineItem-unit reportan falsamente "Sin precio default".
- **Distinguir "precio asignado" de "precio positivo"**: `unitPrice === 0` es un valor válido en ciertos casos (ej. excepciones comerciales — Schneider Electric México en Javier Rojo Gómez requiere $0). El flag `priceAssigned = unitPrice != null` (incluye 0); el flag `hasPositivePrice = unitPrice > 0` (para mostrar monto de lote mínimo). Mezclar los dos lleva a falsos negativos.
- **Validaciones de precio NO dependen del groupMap del lote mínimo**: si el groupMap se crea solo cuando hay conversión LO, todas las validaciones que viven en el group loop (sinPrecio, excepciones comerciales) se brincan para PNs sin conversión. Patrón correcto: el groupMap se crea **siempre**, `piezasPorLote` se vuelve nullable, y solo el bloque `aplicaLoteMinimo` requiere `piezasPorLote != null`. Captura en `ordendeventa.ts` (2026-05-15) cuando el usuario borró la conversión LO para probar y desapareció el warning de "Sin precio default" — no era bug del warning, era que el path nunca corría.
- **Excepción de cliente por nombre + ship-to**: `inputs.customer.name` y `inputs.receivedOrder.shipToAddress.address` permiten gating por cliente. Patrón case-insensitive con `.includes()` tolera variantes ortográficas ("SCHNEIDER ELECTRIC MEXICO" vs "Schneider Electric México"). Para reglas atadas a una bodega del cliente, también checa el ship-to (ej. Schneider tiene varias plantas; solo "Javier Rojo Gómez" requiere $0).
- **NO omitir result keys del shape (2026-05-25)**: el frontend de Steelhead **requiere que `result` traiga las 6 keys del `LowCodeResult`** (`stationRouting`, `treatmentTimes`, `partPrices`, `partsPerRack`, `partNumberUpdates`, `workOrderLabels`), aunque sean arrays vacíos `[]`. Si devuelves `{}` o un subset, el frontend trata el shape como inválido y **descarta silenciosamente todos los `helpers.addErrorMessage`** del hook. Síntoma característico: Test Panel muestra los chips correctamente (porque imprime el output crudo del hook), pero la UI de operación queda muda — sin chips de Schneider, Spec, lote mínimo, ni nada. Patrón obligatorio:
  ```ts
  const result: LowCodeResult = {
    stationRouting: [], treatmentTimes: [], partPrices: [],
    partsPerRack: [], partNumberUpdates: [], workOrderLabels: [],
  };
  ```
  Confusión común: los chips tipo "result keys: stationRouting, ..." que parecen "ruido del frontend pintando las keys" NO son del frontend — son tu propio `addErrorMessage` de debug experimental. Para silenciarlos, quita el `addErrorMessage`, NO las keys. Tampoco usar `??=` (ES2021) en pushes a `result.workOrderLabels`: el runtime de Power Tools transpila a target legacy y lanza SyntaxError silencioso. Usar `result.workOrderLabels!.push(...)` (non-null assertion ES2017-safe).
- **Mensaje "Todo en Orden" como heartbeat (2026-05-25)**: cuando los buckets de chips bloqueantes (error NP Desconocido, warning Sin Precio, warning Schneider+JR ≠ 0) salen vacíos, el panel queda sin chips críticos y el operador no sabe si el hook validó OK o si se rompió. Patrón: al final de las emisiones, si `errorChips.length === 0 && sinPrecioChips.length === 0 && schneiderChips.length === 0`, emitir `helpers.addErrorMessage({ severity: 'success', message: 'Todo en Orden' })`. Da feedback verde de "validado, todo OK" sin obligar a abrir el Test panel. NO contar `sinRackChips` (false positives en procesos por pieza), `loteChips` (regla comercial normal) ni `infoChips` (Spec/Espesor) como bloqueantes — pueden coexistir con el verde. `severity: 'success'` está soportado en el tipo `Severity` y se renderiza como chip verde en el UI real.

## Validación de etiqueta de planta Schneider vs ship-to (2026-06-06)

Cada NP de una OV Schneider (`customerName.includes("schneider")`, cubre razón social MEXICO y USA INC) debe traer la etiqueta de su planta (`SXX`) y coincidir con la planta del `shipToAddress`. Si no → chip rojo (`severity:'error'`), patrón advisory igual a "NP Desconocido" (no bloquea el Save por API; guía al operador a no agregar el NP).

- **Resolución de planta** desde `shipToAddress.address` por substrings discriminantes (no por dirección completa, que cambia). Mapa código→substrings y lógica en `tools/lib/schneider-plants.js` (canónico, probado en `tools/test/received-order-plant.test.js`); el hook lo **transcribe** inline (los Power Tools no importan).
- **7 plantas:** STX (acuamanala/90860), SXC (ocotitla/90434), SMY (apodaca/66627), SQ1 (vesta/76294), SQ2 (aeropuerto/lote 56/76295), SCM (michoacán 20/09208), SRG (rojo gómez/09300). `SQR` renombrada a `SQ1` por el equipo — sin alias.
- **2 direcciones trampa** (fiscales Laredo / Roselle Illinois) no resuelven a planta → caen en error "ship-to no identificado" (correcto, no son plantas de entrega). Por eso STX usa `acuamanala`/`90860` y no "Tlaxcala" suelto (el identifier "Dirección Fiscal Tlaxcala" es de EUA).
- **Veredicto por NP:** lee `partNumber.partNumberLabels[].name` (solo lectura); `missing` (sin etiqueta SXX) / `mismatch` (otra planta) / `ok` (multi-planta pasa si la esperada está entre sus etiquetas). Dedup por `partNumber.id`.
- **Severidades (decisión usuario):** missing, mismatch y ship-to-no-resoluble = error rojo. Los 3 buckets nuevos (`plantMissingChips`, `plantMismatchChips`, `shipToPlantUnresolved`) se suman a la guarda de supresión del "Todo en Orden" verde (ver bullet anterior 2026-05-25).
- **Phase-0 pendiente de confirmar en Test panel:** que `partNumber.partNumberLabels` se pueble como input en "Add Parts to Sales Order" (la bitácora 2026-05-15 solo confirmó que NO es escribible). Si viniera vacío, mover la validación a un applet de extensión con GraphQL.

