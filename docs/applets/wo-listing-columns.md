# wo-listing-columns — Columnas en el listado de Órdenes de Trabajo

## 2026-08-03 — SH quitó los `data-testid`: este applet pasa por el núcleo de iconos

Steelhead publicó un build que **elimina los `data-testid` de los iconos MUI** (medido: 0 ocurrencias en cinco pantallas cargadas y con contenido real). **Sólo los `data-testid`**: los `data-steelhead-component-id` y los ids RJSF **siguen vivos** (38 en la ficha de OT, 40 en la de NP) — afirmar lo contrario fue una sobregeneralización corregida el mismo día. Este applet anclaba a ellos, así que sus `querySelector` pasaron a devolver `null` **en silencio**.

- **Ahora resuelve [`mui-icon-anchor-core.js`](../../remote/scripts/mui-icon-anchor-core.js)**, en cascada: `data-testid` (si SH lo repone) → **FORMA del icono** (`path d`, medida en vivo) → **`aria-label` bilingüe**. El comportamiento anterior queda como fallback si el core no cargó, y el core está declarado en `config.apps[].scripts` — atado por `tools/test/mui-icon-core-wiring.test.js`, porque olvidarlo dejaría el applet en el fallback ROTO sin ningún error visible.
- **La forma es el ancla nueva de nivel 1:** SH no la puede cambiar sin cambiar lo que el operador VE. Los paths están **medidos**, no copiados de la doc de MUI: adivinarlos falla por diferencias de optimización SVGO entre versiones (el Edit real trae `a.996.996 0` donde el canónico dice `a.9959.9959 0`).
- **El `aria-label` va al FINAL y con patrones estrechos.** Verificando en vivo se destapó que un aria laxo **no falla: acierta el icono EQUIVOCADO** — `/…|qr/i` matcheaba «Escanear Código QR» (la cámara) en una pantalla sin QR de etiquetas.
- Contexto completo del incidente y estado del catálogo (7 iconos medidos, 5 pendientes con su motivo) en `CLAUDE.md` §"ESTRUCTURA antes que texto".

**Versión:** 0.8.2 — **VIVO config 1.11.47 (tag `v1.11.47`).**

## v0.8.2 (2026-07-31) — la fila reciclada mostraba los datos de OTRA orden

**No salió de un reporte sobre este applet:** el operador reportó el bug en `pn-specs-column` (al
archivar un NP, el renglón seguía mostrando la spec del archivado) y **pidió revisar si el tablero de
Work Orders lo tenía también**. Lo tenía — este applet se hizo con ese molde y arrastró el mismo
defecto, con el agravante de que aquí el reciclaje ocurre al **filtrar, ordenar o paginar**, que es
trabajo de todos los días en esa pantalla.

**Causa (idéntica):** React recicla los `<tr>`; el glue solo preguntaba si nuestra celda **existía**:

```js
let td = tr.querySelector(':scope > .' + col.cls);
if (!td) { …crear, poner data-sa-woid y pintar… }   // si ya existía, no se tocaba nunca
```

La celda nativa pasaba a la OT siguiente y la nuestra sobrevivía con el `data-sa-woid` y el contenido
de la anterior. Y como **`applyToCells` busca por `[data-sa-woid]` en 6 lugares**, el atributo stale
hace que el resultado del fetch de la orden **anterior** se pinte sobre la fila de la **nueva**: la
mentira se refresca sola.

**Un segundo modo de falla que este applet tenía y el hermano no:** el atributo se ponía condicionado
(`if (woIdInDomain != null)`), así que una celda nacida cuando la fila **aún no resolvía su link**
quedaba **sin `data-sa-woid`** — y, al no revalidarse nunca, se quedaba **huérfana mostrando «—» para
siempre**. La revalidación también la rescata.

**Fix:** `Core().isStaleNode(td.getAttribute('data-sa-woid'), woIdInDomain)` antes de dar la celda por
buena, en **cada** sync. La función es pura y vive en `wo-schedule-core` — **gemela** de la de
`pn-specs-column-core`, porque son applets de rutas distintas que no comparten core. La duplicación
solo se sostiene mientras no diverjan, así que hay un **test que corre los dos lados sobre los mismos
casos y falla si difieren**. Core `wo-schedule-core` **94** tests.

**Pendiente:** rebundle Safari/iPad (el applet está en el bundle desde v0.6.0).

## Historial previo

**0.8.0 — + toggle "🏷️ Etiquetas"** (VIVO config 1.7.201, 2026-07-24): **2 botones por fila** en la columna Acciones nativa — **🏷️ JobTag** y **📋 Verbose** — que **generan el PDF en un IFRAME OCULTO** dentro del dashboard (sin abrir pestaña → no roba foco; sin throttle → rápido) y **auto-descargan `WO<idInDomain>.pdf`** (verbose: `-verbose`); **retry del iframe** 1 vez y **fallback a pestaña** si SH bloquea el enmarcado. **JobTag validado en vivo** (4/5 iframe, 1 a pestaña bajo carga). Detalle en [`wo-label-pdf-buttons.md`](wo-label-pdf-buttons.md). Commits `a4bff19` (iframe), `736e22b` (verbose+retry).
**Previo 0.6.0 (VIVO 1.7.194+):** 3ª columna opt-in "📦 Lote" (tras Programación, al INICIO): nombre del lote **(idInDomain)** link + **PS Cliente** (`DatosRecibo.PackingSlip`) + **fecha de recibido** (del Receptor ligado al lote). Fuente: **1 query `WorkOrder({idInDomain})` por OT** (pesada 1156 campos → extracción **SLIM**). Core `wo-schedule-core` **37/37** golden (+11 lote, +5 impresión). **0.5.0:** Programación muestra TODAS las tareas apiladas + borde punteado derecho. PN con etiquetas como chips; columnas al INICIO. **0.4.1:** fix celdas no visibles al mover al inicio.
**Categoría:** Órdenes de Trabajo · **autoInject:true** · ruta: `/Domains/<d>/WorkOrders` (index, NO la ficha `/WorkOrders/:id`)
**Sin hash nuevo ni cambio de `config.json`** en 0.6.0/0.7.0 (WorkOrder ya está; los toggles son in-page; el iframe usa la UI nativa, no llama ops nuevas).

## Qué hace

En el listado `https://app.gosteelhead.com/Domains/<d>/WorkOrders`, agrega **tres columnas opt-in** (tres toggles en una barra dark-mode antes de la tabla; también en el popup). **A diferencia de `pn-specs-column` (que van al final), estas van al INICIO** (primeras columnas, izquierda) — `moveToFront()` las mantiene como las primeras celdas en cada sync (reordena solo si hace falta, sin churn del observer). Orden: **[🔩 PN · 📅 Programación · 📦 Lote]**:

- **🔩 "Número de Parte"** — cada PN como **link** a su ficha (`/PartNumbers/<id>`, pestaña nueva) + sus **etiquetas como chips** (con el color real de cada label). Soporta **N PNs** concatenados (hoy 1 por OT).
  - Chips vía **2º query LIGERO** `GetPartNumberForPartNumberPage({partNumberId})` (hash `34ed9de7…`; `partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{name,color}`, sin archivadas). Pool aparte + repintado al resolver.
  - **Descripción DESCARTADA (decisión del usuario):** `descriptionMarkdown` solo vive en `GetPartNumber` (504 campos → mucho peso). Se priorizan los chips con la query ligera. `pickTextColor` da texto legible sobre cualquier color de label.
- **📅 "Programación"** — **estación · fecha/hora local · estado** de la tarea agendada de la OT.
- **📦 "Lote"** (v0.6.0) — **nombre del lote (idInDomain)** como link a la ficha del lote + **PS Cliente** + **fecha de recibido** (ver sección abajo). Una OT puede ligar **varios lotes** → apilados.

Pedido por producción (2026-07-23): ver el PN directo en el listado (con link a su ficha "como cuando entras a la ficha individual") y la programación de cada OT.

## Decisión de diseño (por qué un 2º query)

`AllWorkOrders` (el query del listado) trae `partNumberWorkOrdersByWorkOrderId.nodes[].partNumberId` (el **id**) pero **NO el nombre del PN** (verificado en el scan real 2026-07-23 + `wo-deadline-changer.js`, que también resuelve el nombre aparte). Por eso se hace un 2º query **ligero** por OT:

- **`PartNumbersByWorkOrderIdInDomain`** (hash `fda9e55c9e2341c17b6974c66407ac8b4306cab86a1c82ffe00c30133bb784d3`, ya en `config.json`), vars `{idInDomain}` → `workOrderByIdInDomain.partLocationsByWorkOrderId.nodes[].partNumberByPartNumberId.{id,name}`. Real: OT 15194 → `{id:3781602, name:"SGE11074C7"}`. Mucho más ligero que `GetPartNumber` (504 campos).
- El `idInDomain` sale del **link de la fila** (`td a[href*="/WorkOrders/<idInDomain>"]`), sin depender de `AllWorkOrders`.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/wo-schedule-core.js` | Motor puro **compartido** con `wo-schedule-button`. Aquí usa: `isWorkOrdersIndexPath`, `parseWorkOrderIdInDomain`, `extractPartNumbers`, `pnLink`, `buildBoardScheduleIndex`/`resolveBoardScheduleForWO`, **`extractWorkOrderBatches`/`batchLink`** (columna Lote). |
| `remote/scripts/wo-listing-columns.js` | Glue DOM: 3 toggles persistentes, columnas en la MUI table, MutationObserver, pool de `PartNumbersByWorkOrderIdInDomain` (PN/sched) + pool aparte de `WorkOrder` (Lote), memory-hardening. |
| `tools/test/wo-schedule-core.test.js` | **32 golden tests** (PN múltiples/dedup/sin nombre + fail-safe; programación; update Fase 2; **+11 del lote**). |

- **Toggle persistente:** `localStorage['sa_wo_pn_col_enabled']` (`'1'`/`'0'`, default OFF). Barra dark-mode insertada antes de la tabla + handler de popup `WoListingColumns.toggleFromPopup`.
- **Columna (lección pn-specs):** `<th>`/`<td>` **siempre última celda** (`appendChild`), re-posicionada en cada sync → sobrevive el re-render de React (paginar/ordenar/filtrar) sin desalinearse. Hereda la `className` MUI de una celda nativa. `data-sa-woid` para idempotencia.
- **Render seguro:** `textContent` + `href` (no `innerHTML` de datos → sin XSS con nombres de PN).

## Memory hardening (skill `memory-hardening-applets`)

Importa `host-cleanup-shared.js`. El toggle ON dispara ~1 query por OT visible (~20/página) y se re-dispara al paginar.

- **EJE A (propia):** cache **slim** `idInDomain → [{id,name}]` (`window.__saWoPnCache`); se limpia al salir del index; teardown de columna/observer/pool al desactivar.
- **EJE B (host):** `stopDatadogSessionReplay()` al primer fetch; `createMemMonitor` guardrail @88% → vacía la cola + toast; `makePeriodicDrain(25)`; pool `MAX_CONC=4` + `MIN_GAP_MS=130` (~7 req/s) + retry `[0,800,2500]` solo en transitorios.

## Columna "Programación" (cómo se resuelve)

Fuente: **`WorkOrderSchedule({domainId, workOrderId})`** (hash `7b1b1127…`, capturado 2026-07-23). Aunque se llama por WO, devuelve el **board COMPLETO** (todas las tareas del schedule del dominio, 767 en el board 454) → **UNA sola llamada por página** indexa a todas las filas (no por-fila).

- El `workOrderId` GLOBAL de cada fila sale del mismo fetch de PN (`PartNumbersByWorkOrderIdInDomain` → `workOrderByIdInDomain.id`, vía `extractWorkOrderGlobalId`). Por eso la columna de Programación **comparte** el fetch por-fila con la de PN.
- Al tener el primer `woGlobalId`, se dispara **una** `WorkOrderSchedule` → `WoScheduleCore.buildBoardScheduleIndex` (índice slim `workOrderId→tareas`, con `stationByStationId.name` embebido) → se **descarta el raw (~4.6MB)** y se guarda solo el índice → `fillAllSchedCells()` llena todas las filas. El link WO→tarea es `element.recipeNodeByRecipeNodeId.workOrderId`.
- Render por fila: estación · fecha/hora local (`es-MX`) · estado (`scheduleStatusLabel`). "no programada" si vacío. `(+N)` si hay varias tareas.
- **Peso:** `WorkOrderSchedule` ~4.6MB, pero **1 llamada por página** (opt-in, memory-hardening: se descarta el raw + Apollo drain + guardrail @88%). El índice se libera al salir del listado.

## Columna "📦 Lote" (v0.6.0 — cómo se resuelve)

Pedido por producción (2026-07-24): en el listado, tras Programación, una columna **Lote** con, en la MISMA celda: **nombre del lote (idInDomain)** como link + **PS Cliente** + **fecha de recibido**.

**Fuente única: `WorkOrder({idInDomain})`** (hash `fc41042e…`, **ya en config**, la usa también `wo-schedule-button`). Es la query de la ficha (1156 campos → pesada), pero trae **todo** lo de la celda Lote de un jalón, vía `workOrderByIdInDomain.currentPartsTransferAccounts.nodes[]`:

| Dato | Ruta (dentro de cada nodo de `currentPartsTransferAccounts`) |
|---|---|
| Lote id / idInDomain / name | `…inventoryAccountByInventoryAccountId.inventoryBatchByInventoryBatchId.{id, idInDomain, name}` |
| **PS Cliente** | `…inventoryBatchByInventoryBatchId.customInputs.DatosRecibo.PackingSlip` (customInputs puede venir objeto **o** string JSON) |
| **Fecha de recibido** | `…inventoryAccountByInventoryAccountId.receiverBomItemByReceiverBomItemId.receiverByReceiverId.receivedAt` (el `receivedAt` REAL del receptor, no `createdAt`) |
| pnId (para el link) | `…inventoryBatchByInventoryBatchId.inventoryItemByInventoryItemId.partNumberByPartNumberId.id` |

- **`PartNumbersByWorkOrderIdInDomain` NO trae el lote** (verificado en el cuerpo real del scan 2026-07-23: solo `partNumberByPartNumberId.{id,name}` + `partGroupByPartGroupId`). Por eso la columna Lote necesita **su propia query** (`WorkOrder`), con **pool propio** independiente del de PN (el toggle Lote solo NO dispara el fetch de PartNumbers).
- **Link del lote:** preferido `/PartNumbers/<pnId>/Inventory/Batches/<idInDomain>` (forma REAL que renderiza SH → navegable); sin pnId, fallback bare `/Inventory/Batches/<idInDomain>`. (`batchLink` en el core.)
- **Multi-lote:** una OT puede ligar varios lotes (varias cuentas) → se **apilan** (dedup por batch id), cada uno con su PS y su fecha.
- **PS Cliente:** mismo patrón que `board-metal-tooltip.js` (que lo resuelve por la cadena `GetPartNumberInventoryBatch`→`GetInventoryBatch`); aquí sale directo del `WorkOrder` sin cadena extra.
- **Memory-hardening (query pesada):** `WoScheduleCore.extractWorkOrderBatches` devuelve **SLIM** `[{id,idInDomain,name,packingSlip,receivedAt,partNumberId}]` y el raw de 1156 campos **sale de scope** (no se guarda). Pool `MAX_CONC=4`/`MIN_GAP_MS=130`, Datadog stop, `makePeriodicDrain` tras cada query, cache `window.__saWoLoteCache` liberado al salir del index. Render `textContent` (anti-XSS con nombres de lote/PS).
- **Core:** `extractWorkOrderBatches` + `batchLink` (+ helper interno `packingSlipFromCI`). **11 golden tests** (multi-lote, dedup por id, PS/receptor faltante, customInputs string vs objeto, sin nombre → "Lote &lt;id&gt;", fail-safe; batchLink anidado/bare/null).

## Plan de validación (pendiente)

- **Core:** **32/32** golden ✓ (incluye los 11 del lote).
- **En vivo PN/Programación (operador, foreground):** `/WorkOrders` → toggle 🔩 → columna PN con links correctos (OT 15194 → `SGE11074C7` → `/PartNumbers/3781602`) + paginación (observer re-inyecta, columna siempre última) + contador `done/total`.
- **En vivo Lote (v0.6.0):** toggle 📦 → celda con **nombre del lote (idInDomain)** clicable que abre la ficha del lote, **PS Cliente** correcto (cotejar con el tooltip del board o la ficha del lote), y **fecha de recibido** = el `receivedAt` del receptor (el que edita `receiver-date-override`). Probar una OT **multi-lote** (varios lotes apilados) y una OT sin lote ("sin lote"). Verificar que el toggle 📦 solo **no** dispara el fetch de PartNumbers.
- **Deploy:** `tools/deploy.sh "feat(wo-listing-columns): +columna Lote (0.6.0)" --check wo-listing-columns` (default OFF → deploy seguro). **DIFERIDO** por coordinación: hay WIP ajena en el worktree (`tools/hash-autopilot/*`) + vivo en 1.7.187. **No requiere hash nuevo ni tocar `config.json`** (WorkOrder ya está; el toggle es in-page → sin cambio de `apps[]`).

## Pendiente: botón "Regenerar PDF de etiquetas" en la columna Acciones (bloqueado por captura)

Producción pidió (2026-07-24) un botón en la columna **Acciones** del listado que **regenere el PDF de las etiquetas** del lote/OT, idealmente **sin abrir el modal de preview** ("mandar llamar el generador de etiquetas headless").

- **Terreno virgen — falta capturar la operación del generador.** Candidatas descubiertas por el hash-scanner (sin documentar aún): `GetPdfTemplateOutputV2` (`8e5833fe…`), `PdfLowCode` (`3952791b…`), `GetPdfTemplates` (`7db90aba…`), `GetPdfConfigsByType` (`6902481b…`), `GetCustomerPdfConfigs` (`82ec2501…`), `PartNumberLowCodePdf` (`fefd3e10…`). En la ficha de OT existe además el botón nativo `WORK_ORDER_PAGE_HEADER_PRINT_JOB_TAGS_BUTTON` ("Imprimir etiquetas de trabajo") — posible ancla del mismo generador.
- **Captura requerida:** con `hash-scanner` ON, disparar el flujo EXISTENTE que genera el PDF de etiquetas (el botón/modal que ya usa el operador "en otro contexto") y capturar **qué op(s) dispara + variables + si el PDF sale por `/graphql` o por `/api/files`**. Sin eso NO se puede replicar headless (regla: no adivinar operaciones/DOM).

## Hashes / rutas de regeneración

- `PartNumbersByWorkOrderIdInDomain`, `AllStations`, `WorkOrder`, `WorkOrderSchedule`: **ya en config**, sin hash nuevo introducido por las columnas. La columna Lote usa `WorkOrder({idInDomain})` (mismo hash que `wo-schedule-button`). Ruta de captura de `PartNumbersByWorkOrderIdInDomain`/`WorkOrder`: navegar a la ficha `/Domains/<d>/WorkOrders/<id>` — verificar/registrar en `route-catalog.json`.
- **`AllWorkOrders` NO rotó (corrección 2026-07-24):** el hash de config `aaeb9dc0…` **sigue válido server-side** (el validador no lo reporta). El front sencillamente usa un bundle más nuevo (`4a1ce04a…`); la persisted query vieja sigue registrada. `wo-listing-columns` **no** llama `AllWorkOrders` (lo menciona solo en comentario). Sin acción.


## Safari / iPad (bundle v0.6.0, 2026-07-27)

Integrado al bundle del iPad. El scanner (`tools/safari-bundle-scan.py`) lo clasificaba
**NO-APLICA** por detectar `a.download`, pero esa descarga es la **generación del PDF**: una
función **lateral y opt-in**, no el flujo core del applet. La regla correcta es *NO-APLICA solo
cuando el FLUJO CORE es la descarga* (auditor, carga-masiva, file-uploader…); si es una función
más, el applet sí va al bundle y en iOS simplemente esa función no opera.

Recordatorio: el bundle es **estático** (Apple 2.5.2 prohíbe código remoto) — editar
`remote/scripts` NO llega al iPad hasta correr `tools/build-safari.sh` y **recompilar en Xcode**.

## v0.8.1 (2026-07-27) — los toggles dejaron de aparecer al cargar

Reporte del operador: los 4 toggles no salían al entrar al listado, **pero sí al pulsar el
botón de márgenes** (que fuerza un re-render), y al recargar volvían a esconderse.

**Causa.** `ensureToggles()` necesita la tabla para anclarse; en el `init` todavía no está
pintada, y el único reintento —el `MutationObserver`— vivía detrás de:

```js
function syncColumns() {
  if (!anyOn() || !onIndex()) return;   // ← con todos los toggles apagados, sale aquí
  ensureToggles();                       // ← y nunca monta la barra
```

Como los toggles arrancan **apagados**, ese reintento nunca corría: la UI que sirve para
encenderlos estaba condicionada a que ya estuvieran encendidos.

**Por qué apareció justo ahora.** El bug llevaba meses ahí, tapado por el timing: con el loader
viejo el applet iba detrás de 79 descargas **en serie**, y llegaba tan tarde que React ya había
pintado la tabla → `ensureToggles()` montaba a la primera. Al acelerar el loader ese mismo día
(ver [`../architecture/applet-load-gating.md`](../architecture/applet-load-gating.md)) el applet
pasó a correr **antes** que React y el bug salió a la luz.

**Fix.** `ensureToggles()` se llama SIEMPRE que la ruta aplique; sólo el trabajo pesado queda
detrás de `anyOn()`. De aquí sale una regla de repo (en `CLAUDE.md`): *la UI de ENTRADA de un
applet se monta siempre; sólo el trabajo pesado va detrás del gate de estado.* Y su corolario:
**no asumas que el DOM ya está pintado cuando corre tu `init()`**.

Mismo bug y mismo fix en `pn-specs-column` (el molde del que salió este applet).
