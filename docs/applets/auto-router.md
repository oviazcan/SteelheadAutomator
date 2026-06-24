# Applet `auto-router` — Auto-Ruteador de Órdenes

> Versión: **0.2.0** (Fase 1 — motor + panel single-order + idempotencia + fix load-before-save).
> Estado: **VALIDADO en vivo** (config 1.6.88). Run real OK: re-ruteo single-order graba correctamente.
> Pendiente: Fase 2 (batch multi-orden), Fase 3 (auto-fill del modal nativo).

## Lección crítica: load-before-save (fix 1.6.88)
El re-ruteo "no se grababa" si el modal de ruteo nativo se cerraba antes de aplicar. **Causa raíz**
(debugging sistemático): NO existe mutación de sesión de ruteo — `RouteWorkOrders`,
`SuperNodeActiveRecipeNodeSelectionQuery`, `StationTreatmentByWorkOrder`, `PartNumbersByWorkOrderIdInDomain`
son **todas lecturas**; la única mutación es `CreateUpdateDeleteRoutes`. Steelhead exige una **lectura
RECIENTE** de `StationTreatmentByWorkOrder` para que el save persista: modal abierto = lectura fresca →
graba; cerrado = lectura vieja → el servidor **acepta la mutación pero crea 0 rutas** (rechazo silencioso).
Y `SteelheadAPI.query` no lanza si viene `data`, así que el panel fingía "✅ aplicado".
**Fix:** `apply()` hace `fetchWorkOrderRouteData()` (re-lectura de `StationTreatmentByWorkOrder`) JUSTO antes
de la mutación + verifica que `createdRoutes` ≥ lo pedido (si crea 0 de N → "⚠️ No se guardó" + Reintentar).

## Qué resuelve
Re-rutear una orden de trabajo (WO) de una línea de producción a otra (ej. T204 → T205)
implica cambiar, **tina por tina**, la `station` de cada paso del proceso en el modal nativo
de Steelhead: ~33 dropdowns react-select, ~17 min por orden. El applet calcula el mapeo
completo en segundos y lo aplica en **una sola** mutación batch, con un preview editable.

## Modelo de datos (descubierto del tráfico real — scan 2026-06-22)
- Una WO tiene un árbol de `recipeNodes`. Cada nodo con `treatmentId` (el "qué se hace") corre
  en una **`station`** = tina (el "dónde"). **Re-rutear = cambiar la station, NO el treatment.**
- El **nombre** de la tina codifica línea + posición física: `T205-TI00-019 Enjuague`,
  `T205-LI Plata y Estaño s/Barras (16.3)`. La posición `TI00-NNN` da el orden físico.
- Solo se re-rutean los nodos cuya tina **default** pertenece a la línea origen. Los bloques de
  otras líneas (T300 Limpieza Especial CE05, T300 Antitarnish CE03) **conservan su tina default**.
- La mutación lleva **TODAS** las rutas del proceso (cambiadas y conservadas), no solo las modificadas.
- Los nodos globales SP (Inspección Recibo, Embarque, etc.) tienen treatment pero **sin estación
  física** (`stationByDefaultStationId = null`) → no se rutean (el ground-truth tampoco los incluye).

## Flujo GraphQL
| Operación | Tipo | Hash (config.json) | Rol |
|---|---|---|---|
| `StationTreatmentByWorkOrder` | query | `1d0e7eb3…dd143` | Árbol de recipeNodes + tinas default + `allDefaultStationTransports` + `activeRoutes` |
| `SearchStationsForTreatment` | query | `6ce8c070…e6e4a2` | `treatmentById.schedulingStations.nodes[].{id,name}` — tinas compatibles, todas las líneas, ya filtradas al grupo "Planificación" |
| `CreateUpdateDeleteRoutes` | mutation | `0597ad98…d9a76e` | `{input:{routesToCreate:[{partNumberId,workOrderId,treatmentId,stationId,recipeNodeId,partGroupId:null}], routesToUpdate:[], routesToDelete:[]}}` |

## Regla de mapeo (motor `auto-router-engine.js`)
Validada contra el **ground-truth**: re-ruteo manual real de la WO 1760978 (PN S1D3852A01), T204→T205.
1. **bypass** — nodo de otra línea → conserva default. (T300 CE05/Antitarnish.)
2. **role-match** — la tina default tiene rol distintivo (Recuperador, Flash, IMMSA, Caliente) →
   toma la candidata destino con ese rol. (Ej. "Enjuague Recuperador" T204 → "Enjuague Recuperador" T205.)
3. **single / reúso de proceso** — tratamiento con 1 tina destino → reúso. Tanques de proceso con
   varias variantes (ej. 2 tinas de Decapado Nítrico) → **se reúsan** (no se consumen).
4. **momentum** — enjuagues genéricos (`isRinsePool`: ≥3 tinas mayormente "Enjuague") → **se consumen
   una vez**, tomando la tina sin usar más cercana al ancla (la tina del paso padre), con inercia de
   dirección (asc/desc) — el patrón serpentino de la línea física.

**Cobertura medida (golden test):** 22/22 rutas deterministas (anclas, roles, reúso de proceso, bypass)
**exactas** al ground-truth — esas son las críticas (química correcta). Enjuagues genéricos: **6/12 (50%)**
exactos; el resto es interchangeable y de bajo riesgo, lo cubre el **preview editable**.

## Arquitectura (`remote/scripts/`)
- `auto-router-engine.js` — **motor puro** (sin DOM/red). `AutoRouterEngine.computeRoutes(...)`. Único con golden test.
- `auto-router-api.js` — `AutoRouterAPI`: `fetchWorkOrderRouteData`, `fetchCandidatesForTreatments` (pool conc. 5), `applyRoutes`, `parseRouteData`.
- `auto-router-panel.js` — `AutoRouterPanel.open(ctx)`: detecta línea origen, carga candidatas, select de línea destino, preview editable por tina, "Aplicar". Nombres vía `textContent` (anti-XSS).
- `auto-router.js` — orquestador: **intercepta `StationTreatmentByWorkOrder`** (el modal nativo es el "selector de orden" → captura woId/pnId/árbol gratis), FAB 🔀, mensaje `open-auto-router`.
- **Golden test:** `tools/test/auto-router-engine.test.js` + fixture `tools/test/fixtures/auto-router-wo1760978.json`. Run: `node --test tools/test/auto-router-engine.test.js`.

UX MVP: el usuario abre el modal de ruteo nativo de una orden (Steelhead dispara la query, el applet
captura el contexto) → aparece el FAB 🔀 → panel: elige línea destino → preview editable → **Aplicar**.

## Líneas destino = grupo Planificación + candidatas embebidas (v1.6.93)
El dropdown de línea destino mostraba ~25 líneas (la unión de todas las candidatas; los Enjuagues
existen en casi toda planta). **Fix:** las líneas válidas salen SOLO del tratamiento de **nivel-línea
(grupo de tratamiento "Planificación", id 2344)** de la sección origen — el nodo "Listo para Procesar",
cuyas candidatas son stations **"-LI"** (selectores de línea, ej. `T205-LI Plata y Estaño s/Barras`).
`AutoRouterEngine.destinationLines(candidatesByTreatment, sourceLine, activeRoutes)` toma el/los tratamiento(s)
cuyas candidatas son "-LI" (`isLineStation`) y que incluyen la línea origen; devuelve sus líneas (fallback a la
unión si no detecta selector). Para WO 1760978 da exactamente `[T107,T110,T202,T203,T205]` en vez de 25.

**Fix bug "no puedo regresar a T204" (validado con test):** excluye la línea **ACTUAL**, no la del default.
Si una orden ya se movió (T204→T205), su `defaultStation` sigue siendo T204 pero una **ruta activa** apunta a
la station "-LI" de T205 → la línea actual es T205 y **T204 reaparece** para regresarla. (Antes excluía siempre
la línea origen del default = T204, así que nunca dejaba regresar.) Por eso `destinationLines` recibe `activeRoutes`.

**Bonus:** las candidatas (`schedulingStations`) vienen **EMBEBIDAS** en el árbol
(`recipeNode.treatmentByTreatmentId.schedulingStations`), así que `parseRouteData`/`parseAllRouteData`
construyen `candidatesByTreatment` desde ahí — se **eliminan las 17+ llamadas `SearchStationsForTreatment`**
por orden (queda solo como fallback). Mismos datos, cero llamadas extra.

## Idempotencia (re-rutear órdenes ya ruteadas) — IMPLEMENTADO
Confirmado del scan 2026-06-22 (WO 1805646, idInDomain 8649):
- `StationTreatmentByWorkOrder.activeRoutes.nodes[]` = `{id, stationId, treatmentId, workOrderId, partNumberId, recipeNodeId, partGroupId}`.
- `CreateUpdateDeleteRoutes` acepta `routesToUpdate:[{id, stationId}]` y `routesToDelete:[id]`.

`AutoRouterEngine.diffRoutes(desiredRoutes, activeRoutes)` produce el payload: **crea** los recipeNodes
sin ruta activa, **actualiza** `{id, stationId}` los que cambian de tina, **borra** `[id]` los que ya no
se rutean, y **omite** (no-op) los iguales. El panel lo aplica así (ya NO bloquea órdenes ya ruteadas);
muestra `+creadas ~actualizadas -eliminadas`. Validado end-to-end con el shape real.

## Pendientes
- **Fase 0 (opcional, fidelidad del test):** capturar `SearchStationsForTreatment` por treatment multi-tina
  para confirmar candidatas autoritativas (la línea T205 ya se reconstruyó completa del catálogo de 772
  estaciones — el fixture está confirmado). No bloquea: el applet llama `SearchStationsForTreatment` en vivo.
- **Fase 2 (batch multi-orden) — IMPLEMENTADO (modo entrada manual), v1.6.89.** `auto-router-batch.js`
  (`window.AutoRouterBatch`, acción popup `open-auto-router-batch`): pegas los números de orden (idInDomain),
  el applet resuelve cada una con `PartNumbersByWorkOrderIdInDomain {idInDomain}` (→ woId interno + pnId +
  partGroup en UNA llamada — `workOrderByIdInDomain.{id, partLocationsByWorkOrderId.nodes[].partNumberByPartNumberId}`),
  carga su árbol, elige línea destino única, y aplica todas con concurrencia 3. Cada orden hace el re-fetch
  load-before-save + verificación de `createdRoutes` por separado.
- **Fase 2b — captura desde el board (sin pegar números), v1.6.91.** Confirmado por scan: al multi-seleccionar
  en el Scheduling board y abrir el ruteo, Steelhead dispara **UN** `StationTreatmentByWorkOrder` con
  `workOrderIds:[…]` + `partNumberIds:[…]` (pareados por índice) y `allWorkOrders.nodes[]` con un árbol por WO;
  `activeRoutes` traen `workOrderId` para repartirlas. El interceptor de `auto-router.js` usa
  `AutoRouterAPI.parseAllRouteData(data, reqVars)` para capturar las N órdenes; el FAB 🔀 muestra un badge con el
  conteo y, al click, abre el batch **precargado** (o el panel single si es 1 orden). NO requirió inspección de DOM.
- **Fase 3 — Ruteo directo desde el Scheduling board (sin modal), v1.6.99.** En vez de manejar los
  react-selects frágiles del modal nativo, el usuario pidió rutear directo desde el board por API. El FAB 🔀
  aparece en la página del board (URL `/Schedules/\d+/ScheduleBoard/\d+`), muestra un badge con el conteo de
  filas seleccionadas (checkbox marcado) en vivo, y al click lee las órdenes seleccionadas
  (`tr input[type=checkbox]:checked` → `a[href*="/WorkOrders/<idInDomain>"]`) y las pasa a
  `AutoRouterBatch.openWithNumbers([...])` → resuelve + calcula + aplica vía API. **Limitación:** la lista es
  VIRTUALIZADA → se RASTREA la selección por evento `change` de cada checkbox (set persistente que
  sobrevive el scroll; se limpia al cambiar de board). `readBoardSelection` = rastreado ∪ visibles-marcados.
  No hay "select all" → cubre el 100% de la selección individual.
- **Rutear TODAS (FAB sin selección), v1.7.0.** Si presionas 🔀 sin órdenes marcadas, lee `scheduleId`+`stationId`
  de la URL, trae las WO de la línea con `SchedulablePartLocations {scheduleId, stationIds:[station], routedOnly:false}`
  (dedup por workOrderId), confirma el conteo, y abre el batch con `openWithWorkOrders` (carga cada árbol con
  concurrencia 3). El preview deja revisar antes de aplicar.
- **Tooltip de "Metal base" en el board, v1.7.0** (`board-metal-tooltip.js`). El metal base es un customInput
  (`customInputs.DatosAdicionalesNP.BaseMetal`) que las queries del board NO traen. Al hacer hover sobre el link
  del PN (`a[href*="/PartNumbers/<id>"]`) se pide bajo demanda con `GetPartNumber {partNumberId, usagesLimit:0}`
  (mismo patrón que `auditor.js`) y se cachea por parte → tooltip con el metal base. Columna+orden se descartó
  (requeriría traer el metal base de las ~1767 partes de golpe).
- **Tooltip enriquecido v1.7.x — inyección en el popover nativo + PS + prefetch** (`board-metal-tooltip.js`,
  reescrito). **Pendiente: hash de `GetInventoryBatch` (validándolo el background agent) + validación en vivo + deploy.**
  - **Bug de los 3 tooltips traslapados (fix):** la v1.7.0 creaba su PROPIO `.sa-bmt-tip` que se encimaba sobre el
    MUI Tooltip nativo de Steelhead (`<div role="tooltip" id="<id>">` con PN + `<hr>` + descripción). Confirmado por
    DevTools: ambos divs coexistían. **Fix:** ya NO se crea tooltip propio; se **INYECTAN** dos líneas dentro del
    popover de Steelhead, así nunca se traslapa. El vínculo popover↔PN es `<a aria-labelledby="<id>">` ↔
    `<div role="tooltip" id="<id>">`; el `href` del `<a>` da el `pnId`. (No había `title` nativo del navegador — el
    `title` del `<a>` venía vacío.) Inyección con `textContent` (anti-XSS); idempotente vía `data-sa-pn` (MUI reusa
    el popper para distintos PN → se re-inyecta si cambia).
  - **PS (Packing Slip del cliente):** `customInputs.DatosRecibo.PackingSlip` del **batch de la fila**, vía
    `GetInventoryBatch {id, limit:10, offset:0}` → `inventoryBatchById.customInputs.DatosRecibo.PackingSlip`. El
    `batchId` sale del link `/Inventory/Batches/<id>` de la MISMA fila (`closest('tr,[data-index]')`). 1 batch por
    fila normalmente → 1 PS; si hubiera varios, se concatenan con `, `. **Ojo (pendiente del agente):** en el scan
    `GetInventoryBatch` usaba `id` INTERNO (ej. 1338941), no el del link (ej. 7053) — falta confirmar cuál acepta;
    y dio http 502 transitorio (hash sin validar). `GetInventoryBatch` aún NO está en `config.json`.
  - **Prefetch (lazy-load) "visibles + scroll":** un `MutationObserver` sobre `document.body` encola los
    `a[href*="/PartNumbers/"]` que se añaden al DOM (filas que entran al viewport en la lista virtualizada) y
    precarga metal+PS en background con pool de concurrencia 4 → el tooltip aparece instantáneo. Prefetch inicial
    de lo visible al cargar. **NO** se trae todo el board de golpe (la bitácora ya había descartado las ~1767).
  - **Memory hardening (skill `memory-hardening-applets`):** `SteelheadAPI.query` usa `fetch()` PROPIO (no el Apollo
    client del host) → las respuestas NO entran al InMemoryCache del host. Por eso **EJE B no aplica**:
    `apolloCacheDrain` (clearStore) rompería el board que el usuario está usando, y es un applet PASIVO co-residente
    (no run intensivo) → tampoco detiene Datadog ni corre mem-monitor con modal de reload. **EJE A sí:** slim
    responses (solo se guarda el string, el objeto GraphQL se descarta), caches `Map` topados FIFO (`CACHE_CAP=3000`)
    y limpieza al cambiar de board (reset en `MutationObserver` por cambio de `location.pathname`).

## Diagnóstico del query pesado del Scheduling board (para un "Programador rápido")
`RelatedSchedulingInformation` (hash `3d2f8583…`) es **el query más pesado** (~87 MB / 7 llamadas). El **98% del
peso es `allWorkOrders` = 54 MB**: trae **las ~1,751 órdenes del dominio sin paginar**, cada una ~30 KB porque
eager-carga ~10 relaciones anidadas (`receivedBatches`, `currentPartsTransferAccounts`, `recipeNodeByRecipeId`,
`incompleteRecipeNodesByWorkOrderId`, `customerByCustomerId`, labels, `partNumberWorkOrders`, plan-before/after).
Es `O(órdenes × relaciones)` → JOINs masivos server-side; **no es problema de índices sino de la FORMA del query**
(sin paginar + eager-load). Arreglarlo de verdad = paginar + lazy-load de lo pesado + read-model. **Un "Programador
Rápido" puede saltarse este query por completo**: traer solo la(s) orden(es) objetivo por-WO (KBs, como hace el
auto-ruteador) y programar con `CreateManyScheduleTasks`/`CreateManyStationTasks` (mutaciones ligeras ya existentes).

## Riesgos abiertos
- **`partGroupId: null`** hardcodeado (el ground-truth lo tiene null; revisar WOs con grupos de partes).
- **Momentum** de enjuagues: best-effort por diseño (≈50% exacto en genéricos; las 22 rutas críticas son
  exactas). El preview editable es la red de seguridad. No vale la pena sobreajustar (las elecciones del
  operador en el cluster Desengrase/Decapado son batching físico, no una regla geométrica).
