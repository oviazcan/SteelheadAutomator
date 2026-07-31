# Agrupar lote en una tarea del programa — `schedule-batch-highlighter` v0.2.0

**Fecha:** 2026-07-30 · **Estado:** IMPLEMENTADO y deployado (config 1.11.43, tag `v1.11.43`) · **Origen:**
`scan_results_2026-07-30_195800.json` (Schedule Board 454, dominio 344, Ecoplating TLC)

> ⚠️ **Dos puntos de este diseño los tumbó la evidencia durante la implementación** (se dejan como
> registro del razonamiento, con la corrección al lado):
> 1. **`RackingRecipeNodes` NO se usa.** `treatmentId`, nombre del tratamiento y `possibleTreatmentTimes`
>    ya viajan en `RelatedSchedulingInformation`, que el board dispara solo ⇒ **cero consultas nuevas**.
>    Un test se pone rojo si el glue vuelve a nombrarla.
> 2. **Una orden con dos nodos programables no es un caso ambiguo:** pasa por dos tratamientos y el
>    nativo crea dos tareas encadenadas. El modelo «una tarea por lote × tratamiento» resultó ser
>    exactamente lo que hace Steelhead, no un compromiso nuestro.

## Problema

El applet `schedule-batch-highlighter` **resalta y marca** las tareas de un lote en el Schedule Board, pero
ahí termina: el operador todavía tiene que agruparlas a mano. El pedido es cerrar ese paso — **agrupar las
órdenes de un lote en una sola tarea del programa**, y poder hacerlo para **todos los lotes de un jalón**
(cada lote en su propia tarea).

## Evidencia — el mecanismo existe y quedó capturado

Secuencia del **Task Builder** nativo (eventLog, 2026-07-31T01:56:31 → 01:57:00):

```
RackingRecipeNodes{workOrderIds:[1756482,1756460,1756468,1760657]}   ← abre con lo seleccionado
   ↓  (botón Save)
CreateManyScheduleTasks → 1 scheduleTask con 5 scheduleTaskElements
```

**Modelo:** una tarea agrupada es `(treatmentId, stationId)` + N elementos, cada elemento
`(recipeNodeId, partNumberId, partCount, partsPerBatch, relatedPartTransferAccounts[])`.
En la muestra: 5 elementos, 4 `partNumberId` distintos, **un solo** `treatmentId 112435` / `stationId 12099`.

### La fórmula de duración se generaliza a N elementos (verificada 2×, no inferida)

`total = treatmentTime + (Σ ceil(partCount_i / partsPerBatch_i) − 1) × cycleTime`

| tarea del payload | treatment | cycle | Σ lotes (14+10+4+1+12) | calculado | real |
|---|---|---|---|---|---|
| #1 (`treatmentId 112435`) | 45 | 30 | 41 | 45 + 40×30 = 1245 | `1245` ✓ |
| #2 (`treatmentId 91495`)  | 45 | 15 | 41 | 45 + 40×15 = 645  | `645` ✓ |

Es la misma fórmula que `wo-schedule-core.scheduleTaskTimes` (validada en fase 2b contra 4 tareas reales),
extendida: los lotes se **suman entre elementos**, no se calculan por elemento.

### La pieza que le faltaba al applet

`RelatedSchedulingInformation` trae `allWorkOrders.nodes[].receivedBatches.nodes[].{id, idInDomain, name}`
— el vínculo **orden ↔ lote recibido por ID**, para el board completo.

## Decisiones de diseño

### 1. La agrupación se decide con DATOS, no con el DOM

El resaltado actual matchea el **texto** de la celda y solo alcanza las filas montadas (la tabla
**virtualiza**: 34 declaradas, 17 en DOM). Para *pintar* eso basta. Para *escribir el programa* no:
agrupar "lo que alcanzaste a scrollear" crearía una tarea **incompleta en silencio** — el peor modo de
falla, porque el resultado se ve exitoso.

**Fuente de verdad para agrupar:** `SchedulablePartLocations` (candidatos del board) + `RelatedSchedulingInformation`
(mapa orden→lotes por id). El resaltado verde y el `cb.click()` se quedan **exactamente como están**.

### 2. Una tarea por lote **× tratamiento** (donde la realidad no permite lo pedido literal)

Una tarea es `(tratamiento, estación)`. Si un lote tiene órdenes en tratamientos distintos, **no caben en
una sola tarea**. El preview lo declara ("este lote sale en 2 tareas: T204 Cobre y T206 Níquel") en vez de
decidirlo en silencio. Nunca se mezclan tratamientos en una tarea.

### 3. Solo CREA, nunca borra

Las filas *Unscheduled* del board son **candidatos** (`SchedulablePartLocations`), no tareas existentes.
El `DeleteManyScheduleTasks` del scan fue un evento **separado** (42 s después, con su propio Save), no
parte del agrupar. Antes de crear se verifica que las cuentas no estén ya en una tarea, para que agrupar
dos veces no duplique material en el programa.

### 4. Preview obligatorio + el caso que quema

Modal dark-mode con: lote, órdenes, piezas, tratamiento/estación, duración calculada y **diagnóstico**.
Sin `partsPerRack`, `partsPerBatch` cae a 1 y una tarea de 141 min se vuelve **~112 días** (el caso medido
en `wo-schedule-button` 0.8.0). Se reusa `wo-schedule-core.diagnoseSchedulingData` /
`DURACION_IMPLAUSIBLE_MIN` en lugar de reimplementarlo.

**Fail-safe:** sin evidencia positiva de tratamiento/estación/tiempos, **no se ofrece agrupar**. Un falso
"no puedo" cuesta un clic manual; un falso "sí puedo" ocupa una tina de producción por días.

## Arquitectura

### `remote/scripts/schedule-batch-group-core.js` (NUEVO, puro)

| función | qué hace |
|---|---|
| `indexBatchesByWorkOrder(relatedInfo)` | `Map workOrderId → [{id, idInDomain, name}]` desde `allWorkOrders[].receivedBatches` |
| `buildBatchGroups({partLocations, batchIndex, names})` | candidatos → grupos `{batchName, batchIds, elements[]}`; sin `names` = todos los lotes |
| `splitGroupsByTreatment(groups, treatmentByRecipeNode)` | parte cada grupo por `treatmentId` (decisión 2) |
| `groupedTaskTimes(elements, treatmentTime)` | fórmula de N elementos (tabla de arriba) |
| `buildGroupedScheduleTaskInput(input)` | payload `CreateManyScheduleTasks` con N elementos — generaliza `buildScheduleTaskCreateInput` |
| `diagnoseGroup(group)` | avisos: `partsPerRack` ausente, duración implausible, cuenta ya programada, tratamiento mezclado |
| `treatmentIndexFromRacking(rackingResponse)` | `Map recipeNodeId → {treatmentId, cycle, treatment}` desde `RackingRecipeNodes` |

`partSetUuid` entra **como parámetro** (igual que en `wo-schedule-core`): el núcleo no toca fuentes de
aleatoriedad y el golden test lo fija.

### `remote/scripts/schedule-batch-highlighter.js` (glue)

Botón **📦** junto al 🏷️ existente → modal dark-mode (preview → confirmar → crear → **releer y verificar**).
El applet pasa de 100% DOM a API-driven: suma `steelhead-api.js` + `wo-schedule-core.js` a sus `scripts`
en `config.json`, más los hashes `RackingRecipeNodes`, `RelatedSchedulingInformation`,
`SchedulablePartLocations`, `CreateManyScheduleTasks`.

### Verificación post-escritura

`CreateManyScheduleTasks` **sí** devuelve las tareas creadas (`parseCreatedScheduleTasks`), pero la prueba
real es **releer** `SchedulablePartLocations`: el material agrupado debe desaparecer de los candidatos.

## Riesgos aceptados

- **Escribe en el programa de producción.** Acotado con preview + confirmación + solo-crear + fail-safe.
  La alternativa de menor riesgo (puente al Task Builder nativo) se planteó y el operador la descartó.
- **`RackingRecipeNodes` es pesada** (340 KB para 4 OTs): una sola llamada por agrupación, destilada a un
  índice de ~1 KB; nunca se guarda cruda (regla de memory-hardening).
- **Deuda:** las rutas de regeneración de los hashes nuevos deben quedar registradas
  (`route-catalog.json` / `sentinels-config.json`) — un hash sin ruta es deuda (regla del repo).

## Plan de validación en vivo

- [ ] Un lote con órdenes de un solo tratamiento → 1 tarea, duración = fórmula, material sale de candidatos.
- [ ] Un lote con dos tratamientos → el preview anuncia 2 tareas y las crea separadas.
- [ ] Lote sin `partsPerRack` → diagnóstico visible, no se crea a ciegas.
- [ ] "Todos los lotes" → una tarea por lote, ninguna mezcla entre lotes.
- [ ] Agrupar dos veces el mismo lote → la segunda avisa que ya está programado, no duplica.
