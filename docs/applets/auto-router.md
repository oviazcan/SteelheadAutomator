# Applet `auto-router` — Auto-Ruteador de Órdenes

> Versión: **0.3.0** (bitácora) — **ruteo POR PISTAS + partir/reagrupar piezas**, deployado en
> config **1.7.223** (tag `v1.7.223`, 2026-07-27) y **SIN validar en vivo**. Ver
> §"Modelo de GRUPOS DE PARTES", §"Ruteo POR PISTAS" y §"Riesgos abiertos".
>
> **OJO discrepancia (confirmada 2026-07-15):** la constante
> `VERSION` dentro de `remote/scripts/auto-router.js` sigue en `'0.1.0'` — nunca se bumpeó según
> avanzaron las fases; el applet evolucionó vía bumps de `config.json` (deploys), no del literal
> del script. No fuerces un número "corregido" en el código sin que alguien lo revise a propósito;
> este doc usa `config.json`/gh-pages como fuente de verdad de qué está vivo.
> Estado: **Fases 1, 2, 2b y 3 implementadas y deployadas** (motor + panel single-order + batch
> multi-orden + captura desde el board + ruteo directo sin modal nativo + "rutear todas" + tooltip
> de metal base en el board). **VALIDADO en vivo** solo hasta donde el doc lo registra explícitamente:
> config 1.6.88 (re-ruteo single-order) y config 1.7.4 (tooltip enriquecido). Los deploys 1.7.5→1.7.10
> (perf, fixes de selección, dark mode de modales) están confirmados como **deployados en gh-pages**
> (`git log gh-pages --oneline -- scripts/auto-router*.js`) pero sin confirmación de run real
> registrada en esta bitácora — ver §"Deploys posteriores (confirmado gh-pages)".
> Config más reciente confirmado en gh-pages a 2026-07-15: **1.7.10** (`auto-router-panel.js`, dark mode).
> Validación en vivo de los deploys 1.7.5-1.7.10: **✅ confirmada por el operador 2026-07-22**. Pendiente (opcional): Fase 0 (fidelidad del test).

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
- **Tooltip enriquecido v1.7.4 — inyección en el popover nativo + PS + prefetch + supresión del title nativo**
  (`board-metal-tooltip.js`, reescrito). **VALIDADO en vivo** (config 1.7.4). El popover de Steelhead muestra
  `PN → descripción → Metal base → PS` en un solo recuadro. Cadena del PS validada: `idInDomain 7053 → id interno
  1283250 → customInputs.DatosRecibo.PackingSlip "1983-728-2-8280"`.
  - **Supresión del title nativo (v1.7.4):** seguía saliendo el tooltip oscuro del navegador encima del popover.
    El `title=` redundante NO estaba en el `<a>` (ese venía vacío) sino en el **`<div>` contenedor de la celda**
    (`<div title="<PN>">`). `suppressNativeTitle(a)` remueve ese `title` cuando coincide exacto con el texto del
    link (PN o lote) — se llama en `scanAnchors` y en el observer, así cubre filas iniciales + virtualización.
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

## Fixes 2026-06-24 (feedback en vivo del usuario) — config 1.7.5/1.7.6

**Lentitud reportada por Steelhead (crítico, config 1.7.5).** El prefetch del tooltip disparaba ~3 queries por PN **al hacer scroll** (miles en un board de ~1767). Se ELIMINÓ el prefetch masivo: el tooltip ahora es on-demand (solo al aparecer el popover nativo = hover real) + cache. Ver `board-metal-tooltip.js` y la nota de memory en este doc. HTML de comunicación a Steelhead en `docs/steelhead-extension-design-and-load-2026-06-24.html`.

**FAB persistía fuera del board (1.7.5).** `auto-router.js`: al cambiar de `location.pathname` se limpia `captured = null` (además de `boardSelection`), así el FAB se quita al salir del board.

**Selección fantasma "2-3" sin marcar (1.7.5).** `readBoardSelection` ahora RECONCILIA contra el DOM visible: quita de `boardSelection` las filas visibles desmarcadas (residuos de desmarcar/rutear). Las no visibles (virtualizadas) se conservan.

**Bugs del motor: `T204→T204`, "Aplicar a 0", `T111` no aparece (1.7.6).** Causa raíz: el batch confundía la línea **default** (`detectSourceLine`) con la **actual** (`activeRoutes`). Para órdenes movidas (default≠actual) eso mostraba el default como origen, filtraba por `sourceLine!==destLine` (bloqueaba el botón) y `destinationLines` excluía mal la línea a devolver. **Fix (validado, datos reales = activeRoutes mixtas: tinas físicas de una línea + selector "-LI" de otra → detectar "la actual" es ambiguo):**
- `AutoRouterEngine.destinationLines` ahora OFRECE TODAS las líneas selectoras (no excluye ninguna) → siempre puedes devolver a la original.
- Conteo "tinas a re-rutear" y filtro "Aplicar" = `effectiveChangeCount` (tina deseada ≠ efectiva = `activeRoute ?? default`). Elegir la línea donde ya está → 0; cualquier otra aplica. Independiente de comparar líneas.
- Origen mostrado = `currentLineCode` (tina física efectiva más frecuente, best-effort).
- Default del dropdown = primera línea con cambios reales (evita arrancar en "0 tinas").
- Golden test: 13/13 (34 rutas exactas + `effectiveChangeCount`/`currentLineCode`/`destinationLines` actualizado).

**"Rutear todas" reinterpretado (1.7.6).** El FAB sin selección ahora rutea solo la **estación activa** (`?stationId` de la URL, que el selector de estación del board cambia), NO todo el board. CAP `REROUTE_STATION_CAP = 60`: arriba del cap pide selección (cargar cientos de árboles martillaría `/graphql`).

## Deploys posteriores (confirmado gh-pages, `git log gh-pages -- scripts/auto-router*.js`)

**Limpiar selección al cambiar de estación, no solo de board (config 1.7.7, commit `8032343`).**
`auto-router.js`: `boardSelection` se limpiaba solo al cambiar `location.pathname` (cambio de board).
El selector de **estación** dentro del mismo board (`?stationId=` en la URL) también debe limpiarla
— si no, el badge/FAB del FAB 🔀 arrastraba selección "fantasma" de la estación anterior al cambiar
de estación sin cambiar de board.

**Dark mode de los modales inyectados (config 1.7.9 y 1.7.10).** Los dos modales propios del applet
se restylearon a tema oscuro, en línea con la regla de diseño del repo (UI propia de la extensión
SIEMPRE dark mode, para que el operador distinga de un vistazo que es UI nuestra y no una pantalla
nativa de Steelhead, que son claras):
- `auto-router-batch.js` → config **1.7.9**, commit `6822fa2` ("modal batch en modo oscuro").
- `auto-router-panel.js` → config **1.7.10**, commit `f8456a8` ("modal panel single en modo oscuro").

Sin detalle adicional capturado más allá del mensaje de commit (no hay nota de paleta específica
distinta del estándar `#1c2430`/`#e6e9ee`/`#141a23`/`#13a36f` del repo); confirmar contraste en el
próximo run real si hiciera falta ajuste.

**Nota de cobertura:** ninguno de estos cuatro deploys (1.7.7, 1.7.9, 1.7.10, y tampoco 1.7.5/1.7.6
documentados arriba en "Fixes 2026-06-24") tiene una entrada de "VALIDADO en vivo" registrada en esta
bitácora — quedan como deployados-pero-no-confirmados-en-uso hasta que se anote lo contrario.

## Fix 2026-07-15 — `destinationLines` seguía excluyendo la línea origen (regresión silenciosa)

**Síntoma:** el golden test `auto-router-engine.test.js` estaba **ROJO** (`destinationLines` devolvía
`['T107','T110','T205']`, el test esperaba `['T107','T110','T204','T205']` — faltaba la origen T204).
La nota "Golden test: 13/13" de los fixes 1.7.6 se registró **sin correr la suite**: nunca estuvo verde
tras ese commit. (Es exactamente el modo de fallo que `tools/run-tests.sh` existe para atrapar.)

**Causa raíz:** el commit `0d223c3` documentó el nuevo diseño ("ofrecer TODAS las líneas, el conteo lo
da `effectiveChangeCount`"), agregó `effectiveChangeCount`/`currentLineCode`, los adoptó en
`auto-router-batch.js` (L50, L317) y reescribió el test — **pero dejó en el engine el bloque viejo de
exclusión `set.delete(currentLine)` y su comentario**. El único caller (`auto-router-batch.js:280`)
llama `destinationLines(cbt, wo.sourceLine)` **sin `activeRoutes`**, así que la exclusión borraba la
línea origen (`sourceLine`) del dropdown → el bug Image #6 seguía vivo en producción: una orden en T204
no ofrecía T204 para regresarla.

**Fix:** se quitó el bloque de exclusión (`currentLine` + `set.delete`) y el param muerto `activeRoutes`
de la firma; el comentario contradictorio se unificó. `destinationLines(candidatesByTreatment, sourceLine)`
ahora devuelve **todas** las líneas del selector. **Golden test 13/13 REAL (verificado con `run-tests.sh`),
suite 62/0.** No hay caller que dependa de la exclusión. Pendiente: deploy (el engine `remote/scripts` de
`main` tiene la misma regresión; llevar el fix por `main` y coordinar con la versión viva).

## Fix 2026-07-15 — `destinationLines` seguía excluyendo la línea origen (regresión silenciosa)

**Síntoma:** el golden test `auto-router-engine.test.js` estaba **ROJO** (`destinationLines` devolvía
`['T107','T110','T205']`, el test esperaba `['T107','T110','T204','T205']` — faltaba la origen T204).
La nota "Golden test: 13/13" de los fixes 1.7.6 se registró **sin correr la suite**: nunca estuvo verde
tras ese commit. (Es exactamente el modo de fallo que `tools/run-tests.sh` existe para atrapar.)

**Causa raíz:** el commit `0d223c3` documentó el nuevo diseño ("ofrecer TODAS las líneas, el conteo lo
da `effectiveChangeCount`"), agregó `effectiveChangeCount`/`currentLineCode`, los adoptó en
`auto-router-batch.js` (L50, L317) y reescribió el test — **pero dejó en el engine el bloque viejo de
exclusión `set.delete(currentLine)` y su comentario**. El único caller (`auto-router-batch.js:280`)
llama `destinationLines(cbt, wo.sourceLine)` **sin `activeRoutes`**, así que la exclusión borraba la
línea origen (`sourceLine`) del dropdown → el bug Image #6 seguía vivo en producción: una orden en T204
no ofrecía T204 para regresarla.

**Fix:** se quitó el bloque de exclusión (`currentLine` + `set.delete`) y el param muerto `activeRoutes`
de la firma; el comentario contradictorio se unificó. `destinationLines(candidatesByTreatment, sourceLine)`
ahora devuelve **todas** las líneas del selector. **Golden test 13/13 REAL (verificado con `run-tests.sh`),
suite 62/0.** No hay caller que dependa de la exclusión. **DEPLOYADO a producción (config 1.7.120,
tag `v1.7.120`, 2026-07-15); `auto-router-engine.js` en vivo ya sin `set.delete`.** El golden de `main`
era la versión vieja (esperaba exclusión) → al deployar se actualizó al golden correcto; el batch de
`main` ya usaba `effectiveChangeCount` (L50/L317), así que el comportamiento quedó coherente.

## Modelo de GRUPOS DE PARTES — confirmado en vivo 2026-07-27

Evidencia: WO 15074 y 15075 del dominio 344, capturas del operador + scan
`scan_results_2026-07-27_202908.json`. La pantalla es **"Enrutamiento de Estación"** de la ficha
de la orden (`/Domains/<d>/WorkOrders/<idInDomain>`), con tres bloques: *Rutas Predeterminadas de
Orden de Trabajo*, *Work Order Part Group Routes* (botón **CREATE OVERRIDE ROUTES**) y
*Current Routes* (tabla con columna **Part Group** y bote de basura por renglón).

**Semántica (el hallazgo):**
- Ruta con `partGroupId = null` → **GLOBAL** de la orden. Aplica a los grupos sin override.
- Ruta con `partGroupId = X` → **OVERRIDE** del grupo X. **Toma precedencia** sobre la global.
- **Las dos COEXISTEN para el mismo `recipeNode`.** En la WO 15074, *Current Routes* lista
  `TR-PRM-010 Recibo de Orden` dos veces: sin grupo → `T204-EN00-001`, y grupo 2 → `T205-EN00-001`.
- Un grupo sin override hereda la global; sin global, el default de la receta. En la WO 15075 solo
  se ruteó el grupo "200" (todo a T205) y el "100" siguió mostrando T204 **sin rutas propias**.

**Consecuencia de diseño: el ruteo por grupo es ADITIVO.** Mandar un grupo a otra línea NO obliga
a reescribir ni borrar las rutas globales — basta con crear sus override. (La duda que bloqueaba
el diseño queda cerrada.)

**Payload confirmado** (`CreateUpdateDeleteRoutes`, 33 rutas, HTTP 200):
```json
{ "partNumberId": 3028455, "workOrderId": 1908434, "treatmentId": 94832,
  "stationId": 13740, "recipeNodeId": 46711342, "partGroupId": 948192 }
```
Ojo al leer el response: `createdRoutes[]` devuelve solo `{nodeId, id, priorityNumber}` — **no**
incluye `partGroupId`. Su ausencia NO significa que el servidor lo ignore (error de lectura que
casi se documenta como hallazgo). La confirmación de que se persiste vino de *Current Routes*.

`StationTreatmentByWorkOrder` **filtra por grupo**: al pedir `partGroupIds:[948191]`, `allPartGroups`
devuelve solo ese grupo. El modal nativo rutea **un grupo a la vez** y trabaja ruta por ruta
(72 llamadas a la mutación en una sesión).

### Fix 2026-07-27 — `diffRoutes` pisaba pistas entre sí (riesgo con consecuencia física)

`diffRoutes` indexaba las rutas activas **solo por `recipeNodeId`**:
`activeByNode.set(a.recipeNodeId, a)`. En una WO con override, dos rutas activas comparten
`recipeNodeId` (una global, una del grupo) → **la segunda pisaba a la primera en el Map**. De ahí:
- **update cruzado** — rutear la global podía emitir el `id` de la override y **mover el grupo**;
- **borrado colateral** — el barrido final borraba toda activa cuyo nodo no estuviera en las
  deseadas, incluidas las override de otros grupos.

Con piezas de por medio eso es un error físico: material a la tina equivocada.

**Fix:** la unidad es la **PISTA** `(recipeNodeId, partGroupId)`, con `laneKey()` y normalización
`undefined ≡ null`. El borrado se acota a los `partGroupId` presentes en las rutas **deseadas**
(`scopedGroups`), así una pista nunca toca a otra; sin rutas deseadas no se borra nada (fail-safe:
no hay pista declarada). Tests: `tools/test/auto-router-part-groups.test.js` (9), golden del engine
intacto (12). Suite 73/0.

## Ruteo POR PISTAS + partir piezas (2026-07-27) — implementado, **sin validar en vivo**

La orden se modela como **pistas**: la GLOBAL (toda la orden) y una por grupo de piezas.
Cada pista elige su línea destino por separado o se deja **pendiente** y no se toca.

### Módulos
- **`auto-router-groups.js`** — núcleo PURO (25 golden tests, `tools/test/auto-router-groups.test.js`):
  - `buildLanes({partLocations, activeRoutes})` → pistas con `state`: `own` (override propio),
    `inherited` (hereda la global), `default` (manda la receta).
  - `planSplit()` / `planRegroup()` → payloads de partición y reagrupación.
  - `reuseOrCreate(names, existing)` → qué grupos se reúsan y cuáles se crean.
  - `parseWorkOrderAccounts(data)` → normaliza `WorkOrder{idInDomain}`.
- **`auto-router-lanes.js`** — panel dark-mode: tabla de pistas + sub-modal de partición.
  **Convive** con `auto-router-panel.js` (single-order, validado en producción): no lo reemplaza.
- Acción de popup **`open-auto-router-lanes`** ("Auto-Ruteador — Por grupos"). Toma el número de
  orden de la URL de la ficha; fuera de ella lo pregunta.

### El botón del popup nunca estuvo cableado (0.3.1, 2026-07-27)
Reporte del operador: *"no me sale y ya tengo actualizada la extensión"*. La extensión estaba bien
— **las tres acciones del auto-ruteador nunca tuvieron cómo llegar al applet.**

El popup **no habla con la página**: manda `action.message` al background, que lo resuelve por un
`case` explícito de su switch o, si no, por su **handler genérico**, que busca en config una acción
con el mismo `message` **y un campo `fn`**, inyecta los scripts del app y ejecuta esa función con
`executeScript({world:'MAIN'})`. Las tres acciones se declararon con `handler:"message"` **sin `fn`
y sin case** → el background contestaba `Acción desconocida: open-auto-router-lanes`.

La entrada que el applet sí tenía era `chrome.runtime.onMessage`, y **ese API no existe en el mundo
MAIN** — envuelto en un `try/catch` que se tragaba el error, así que el código se veía correcto.
`open-auto-router` y `open-auto-router-batch` sobrevivieron porque el **FAB 🔀** los abre; el ruteo
por grupos **no tiene FAB** (necesita todos los grupos, no el que captura el modal nativo), así que
el popup era su única puerta y nació inalcanzable.

Fix: `openPanelFromPopup` / `openBatchFromPopup` / `openLanesFromPopup` expuestas en
`window.AutoRouter` + `fn` en las tres acciones de config. Devuelven **de inmediato** y difieren la
apertura con `setTimeout(…, 0)`: `openLanes()` puede pedir el número de orden con `prompt()`, que
bloquearía el `executeScript` y dejaría al popup colgado en "Procesando…". `listenManualTrigger()`
se eliminó (código muerto). El bundle Safari/iPad tenía el mismo hueco — su `LAUNCH_FN` mapeaba a
`openPanel`/`openBatch` y **no listaba lanes**; ya va en el bundle.

**Trinquete: [`tools/test/popup-actions-wired.test.js`](../../tools/test/popup-actions-wired.test.js)** —
toda acción `handler:"message"` debe tener case o `fn`, y cada `fn` debe resolver a un método que su
applet exporte. Destapó **4 huérfanas más** (`run-wo-mover` y los toggles de `invoice-listing-marker`,
`create-order-autofill`, `invoice-autofill`), que van como línea base: los tres toggles guardan estado
en `chrome.storage.local`, inalcanzable desde MAIN → necesitan republicar la extensión.

**Lección:** un botón del popup es un contrato entre TRES archivos (config, background, applet) y
**ninguno de los tres falla solo**: el botón se pinta, el config valida, el script deploya. La única
señal es el clic en producción. Todo canal así necesita un test que lo recorra de punta a punta.

### FAB 📦: el ruteo por grupos deja de depender del popup (0.3.2, 2026-07-27)
Con el popup ya cableado, el operador **seguía** abriendo el panel single-order creyendo que era el
de grupos. Se entiende: los dos botones del popup se llaman casi igual ("Auto-Ruteador" y
"Auto-Ruteador — Por grupos"), los dos modales son dark-mode y arrancan con "🔀 …· WO/OT 15990",
y el **FAB 🔀 de la ficha abre el single-order**. Tres caminos parecidos, uno solo era el correcto.

El ruteo por grupos ahora tiene **entrada propia y visible en la página**: FAB **📦** (oscuro,
`#1c2430`, para no confundirse con los verdes) en la ficha de una OT, apilado sobre el 🔀. **No
depende del contexto capturado** — el panel de pistas necesita TODOS los grupos, no el que trae el
modal nativo — así que se monta con la sola ruta. Si el 🔀 no está (sin contexto), el 📦 baja a
ocupar su lugar en vez de flotar sobre un hueco. El board se queda como estaba: ahí manda el 🔀.

**Verificado en vivo** sobre la OT 15990: FAB montado, clic → panel "Ruteo por grupos · OT 15990"
con la pista `Toda la orden` en `default de receta`. Gate atado al `urlPatterns` del config en
[`tools/test/auto-router-lanes-fab.test.js`](../../tools/test/auto-router-lanes-fab.test.js).

**Lección:** cablear el botón no es lo mismo que hacerlo alcanzable. Cuando dos flujos vecinos se
parecen tanto que el operador escoge mal, el arreglo no es más documentación — es que el camino
correcto sea el más visible desde donde ya está parado.

### Fuente de datos de las piezas
`WorkOrder { idInDomain }` → `workOrderByIdInDomain.currentPartsTransferAccounts.nodes[]` da en UNA
llamada `{id, partCount, partGroupId, partGroupByPartGroupId{id,name}, partNumberId}` más
`customerByCustomerId.id`. **`PartNumbersByWorkOrderIdInDomain` NO sirve aquí:** sus `partLocations`
traen el grupo pero **no `partCount` ni el id de cuenta**, y sin eso no se puede partir.

### Partir y reagrupar — los dos shapes NO son intercambiables
| | Mutación | Destino | Forma |
|---|---|---|---|
| **Partir** | `CreateManyPartsTransfersChecked` | `toAccount: { partGroupId: X }` — **plano** | 1 cuenta → N grupos |
| **Reagrupar** | `AddPartsToWorkOrders` | `toAccount: { partGroup: { id: X } }` — **anidado** | N cuentas → 1 grupo |

Partir también difiere en la envoltura: `partsTransferEventsPayload` es un **objeto** con
`partsTransferEvents[]`, mientras que en reagrupar va dentro de `input` y es un **array**. Por eso
los payloads los arma el núcleo puro y nunca el panel al vuelo.

Secuencia de partición (validada contra el tráfico real): `FindPartGroupQuery` (reúso) →
`CreateNewPartGroup` por cada grupo que falte → `CreateManyPartsTransfersChecked`. **`CreateNewPartGroup`
NO es idempotente:** pedir "100" tres veces deja tres grupos "100" en el catálogo del cliente. El panel
valida las cantidades **antes** de crear ningún grupo, para no dejar huérfanos si la suma no cuadra.

### Hashes en `config.json` y sus rutas de regeneración
Solo se agregaron los dos que el applet **llama de verdad**: `FindPartGroupQuery` `85121b64…` y
`CreateNewPartGroup` `7ee30dd4…`. Los otros cuatro del flujo de agrupación
(`GroupPartsDialogQuery`, `GroupPartsDialogPartLocation`, `GroupMultiplePartsDialogQuery`,
`CreateManyPartGroups`) se capturaron en el scan pero **ningún script los usa**, así que se
sacaron de `config.json`: un hash sin uso es superficie de mantenimiento sin beneficio.
`WorkOrder`, `CreateManyPartsTransfersChecked`, `AddPartsToWorkOrders`, `StationTreatmentByWorkOrder`
y `CreateUpdateDeleteRoutes` ya estaban y coinciden con el scan.

**Cobertura (2026-07-27):** `FindPartGroupQuery` ya la capturaba la ruta `receiving-list`
(navegación simple a `/Receiving/CustomerParts`). Las tres mutations que faltaban tienen ahora
entidad centinela sobre la **OT Sentinela 11677**, todas con **captura-y-aborta**:

| Entidad | Op | Disparador |
|---|---|---|
| `workOrderRoutes` | `CreateUpdateDeleteRoutes` | `#stationRouting-section` → checkbox → *Create Default Routes* → modal *Crear rutas* → Guardar |
| `partGroupCreate` | `CreateNewPartGroup` | tres puntos → *Agrupar/Serializar Piezas* → `+ Agregar` → nombre inexistente + Enter |
| `partsSplitTransfer` | `CreateManyPartsTransfersChecked` | mismo diálogo, grupo **existente** + cantidad → Guardar |

Anclas por **`data-steelhead-component-id`** (`WORK_ORDER_PAGE_PARTS_OPTIONS_ALL_OPTIONS`,
`…_GROUP_SERIALIZE_PARTS`) y por el id `#stationRouting-section`: estables e
idioma-independientes. Importa aquí más que en otras pantallas — esta **mezcla idiomas**
("Enrutamiento de Estación" junto a "Create Default Routes" y "Select All"), así que anclar por
texto se rompería solo. `partsSplitTransfer` elige un grupo **existente** a propósito: crear uno
dependería de `CreateNewPartGroup`, que en el mismo ciclo va abortado.

**`CreateUpdateDeleteRoutes` cierra una deuda vieja:** es LA mutation del auto-ruteador desde su
fase 1 y **nunca tuvo ruta de regeneración**. Si Steelhead la rotaba, el applet quedaba muerto
hasta una captura manual.

**Trinquete anti-deuda (`tools/test/hash-regen-coverage.test.js`).** La regla "un hash sin ruta de
regeneración es deuda" estaba en `CLAUDE.md` pero **nada la verificaba**, y por eso entraba en
silencio. El test mide la cobertura real —**57 huérfanas de 184** al 2026-07-27: las queries están
casi resueltas (110/115), el hueco son las mutations (17/69)— y falla si el número **sube**. Saldar
deuda vieja obliga a bajar la línea base en el mismo commit, así el número solo va hacia abajo.

### Deploy 2026-07-27 — config **1.7.223**, tag `v1.7.223`

**DEPLOYADO a producción** (`main` = `gh-pages` = EN VIVO = 1.7.223, invariante byte-a-byte
verificado, firma KMS validada en vivo). Suite **77/0**.

El merge de `main` (que había avanzado ~100 commits en paralelo) obligó a **tres ajustes de
fondo**, no simples resoluciones de conflicto. Los tres son fallos que la suite no habría
atrapado:

1. **Gate por ruta (`urlPatterns`).** `main` introdujo la carga gateada por URL
   ([`docs/architecture/applet-load-gating.md`](../architecture/applet-load-gating.md)) y el
   `auto-router` solo cargaba en `/Schedules/\d+/ScheduleBoard/\d+`. El panel de pistas se abre
   desde la **ficha de la OT**, así que ahí el script nunca se habría inyectado y el popup
   habría respondido con silencio. Se agregó `/Domains/\d+/WorkOrders/\d+` al gate.
2. **El marcador centinela se renombró a «Centinela»** (español correcto; `main` lo hizo en su
   Fase 4). Las 3 entidades nuevas y sus handlers usaban «Sentinela» → el `isSentinel`
   fail-closed **las habría rechazado todas** y los ciclos abortarían sin capturar nada. Es un
   fallo que solo se habría manifestado dentro de meses, cuando el autopilot intentara
   regenerar un hash.
3. **Línea base del trinquete.** `main` trajo 4 hashes nuevos, 3 sin ruta: la deuda pasó de
   **57/184 a 60/188** (queries 110/119, mutations 18/69). Se subió la base al número real
   medido tras el merge.

## Riesgos abiertos
- **Ruteo por pistas y partición: SIN validar en vivo.** El núcleo tiene golden tests y los payloads
  salen de tráfico real capturado, pero ninguna corrida contra producción está registrada. Partir
  piezas **mueve material físico**: primer uso en una orden de prueba.
- **Los 3 ciclos centinela nuevos NO se han corrido headless.** Las rutas salen del DOM que dio el
  operador y los selectores son coherentes con él, pero ninguna corrida real las validó. Hasta
  entonces son rutas *declaradas*, no *probadas*; el `_nota` de cada entidad lo dice.
- **`activeRoutes` filtradas por grupo, sin confirmar.** `StationTreatmentByWorkOrder` se llama con
  todos los `partGroupIds` de la orden, pero no está verificado si devuelve las rutas de TODOS los
  grupos o solo las de los pedidos. El diff aísla por pista, así que el riesgo es sub-reportar
  cambios, no pisar pistas ajenas.
- **Momentum** de enjuagues: best-effort por diseño (≈50% exacto en genéricos; las 22 rutas críticas son
  exactas). El preview editable es la red de seguridad. No vale la pena sobreajustar (las elecciones del
  operador en el cluster Desengrase/Decapado son batching físico, no una regla geométrica).
