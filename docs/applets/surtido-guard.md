# Applet `surtido-guard` — Candado de Surtido Programado

> Versión: **0.3.0** — ✅ **DEPLOYADO** (2026-07-30): config **1.11.32**, tag `v1.11.32`, firma
> KMS verificada en vivo. Bundle Safari **0.6.16** construido y sincronizado a `Resources/` —
> **falta recompilar en Xcode**. Core **55/55** + 4 de aislamiento + 5 de contrato de config.
>
> **Validado end-to-end en vivo con la 1.11.24.** Los tres fixes de catálogo posteriores los
> **confirmó el operador en piso**: **1.11.26** (acumulativo) *"ya se corrigió"*, y **1.11.29**
> (catálogo completo desde la API) *"ya salen"* — con la observación de que **tarda**, que es
> lo que atiende **1.11.32** (indicador animado). El indicador en sí **no está visto en vivo**
> todavía.
>
> **Run real en `/Domains/344/Workboards/6234`:** el box se pinta en el header, el dropdown ofrece
> `Todas` + `T300`, y al filtrar por `T300` queda **1 visible · 5 sin programar ocultas** — la
> tarjeta que sobrevive es la **WO 12831**, exactamente la programada a esa línea. El
> `scrollHeight` bajó 441/1034 → **51/401** con los rects **contiguos** (365→416→715→766) y al
> limpiar volvió a 441/1034 con **0 residuos**.
>
> **0.2.0 (lo que está VIVO):** DEPLOYADO 2026-07-20 — config 1.7.160, tag `v1.7.160`, commit
> `1382d33`; `sa-sg-orange` verificado EN VIVO en github.io. Bundle Safari v0.5.8 lo hornea
> (commit `172947c`, pendiente recompilar Xcode). Estado: **toggle VALIDADO en vivo (2026-06-29) ✓;
> el bloqueo aparece en vivo. Marcado INVERTIDO — NARANJA en las NO movibles** (antes verde en las
> movibles), señal DOM bilingüe ES+EN (`Tareas Programadas:` / `Scheduled tasks:`) + salvaguarda
> anti-falsa-alarma con el set de la API. **✅ VALIDADO en vivo 2026-07-22** (confirmación del
> operador): bloqueo fino (sin falsos positivos prog/no-prog), drag silencioso y marcado naranja.
> Spec: [`2026-06-26-surtido-guard-design.md`](../superpowers/specs/2026-06-26-surtido-guard-design.md) ·
> Plan: [`2026-06-26-surtido-guard.md`](../superpowers/plans/2026-06-26-surtido-guard.md)
> **v0.3.0 (filtro):** spec [`2026-07-29-surtido-guard-line-filter-design.md`](../superpowers/specs/2026-07-29-surtido-guard-line-filter-design.md) ·
> plan [`2026-07-29-surtido-guard-line-filter.md`](../superpowers/plans/2026-07-29-surtido-guard-line-filter.md)

## Qué resuelve
En el Workboard **"Preparación de Surtido"** (`/Domains/<id>/Workboards/<n>`), step
**"Preparando Surtido en Almacén"**, evita que el operador mueva piezas al siguiente proceso si la
**orden de trabajo no está programada** en producción, y marca en **naranja** las tarjetas que **NO**
se pueden mover (sin tarea programada). Las movibles (programadas) quedan sin marca (fondo blanco).
> **v0.2.0 invirtió el marcado:** antes se pintaba de VERDE lo movible; ahora se pinta de NARANJA lo
> NO movible (resalta la excepción/lo bloqueado). El **bloqueo** (capas 1-3) es idéntico y API-driven.

**Programada = la pieza tiene una tarea en el programa** (la tarjeta muestra la sección
"Tareas Programadas:" con tratamiento + estación + fecha-hora). El color del calendario rojo/verde es
la **fecha de entrega** (deadline), NO la señal de programación.

## Arquitectura (6 capas — la 6ª es el filtro de v0.3.0, ver abajo)
Glue en `surtido-guard.js`; lógica pura + parsers en `surtido-guard-core.js` (golden tests).
El corazón es un **interceptor de `window.fetch`** (patrón `auto-router.js`) que cubre las dos rutas
de movimiento con un solo punto de enforcement:

1. **Mapa de programadas** — lee la respuesta de `GetRelatedScheduleData` → `Set<partsTransferAccountId>` programados.
2. **Enforcement** — intercepta el **request** de `CreateManyPartsTransfersChecked`; si un transfer `type:"STEP"`
   sale de un nodo de surtido con account **no** programado → no lo reenvía, responde error GraphQL sintético
   (`{errors:[{message}]}`) + toast. **Cubre el modal MOVER y el drag silencioso** (ambos disparan esa mutación).
3. **Capa de modal** — agrisa los botones **Mover** / **Imprimir y Mover** (match por texto) + mensaje inline.
4. **Marcado naranja** — tarjetas SIN la señal DOM "Tareas Programadas:" / "Scheduled tasks:" (= NO
   programadas = NO movibles) reciben fondo naranja (`sa-sg-orange`). **Señal bilingüe ES+EN.**
   **Salvaguarda anti-falsa-alarma:** si NINGUNA tarjeta reconoce la señal pero la API sí reporta
   programadas (`scheduledAccountIds.size>0`), la señal DOM se rompió → **no marca** (evita todo-naranja).
   Decisión pura en el core (`hasScheduledCardSignal`/`isDomSignalBroken`/`shouldMarkNotMovable`).
5. **Toggle** — en el popup (`toggle-surtido-guard` → `SurtidoGuard.toggleFromPopup`), no persistente,
   **default ON cada carga**; se reactiva al recargar. El naranja no se ve afectado por el toggle.

**Política FAIL-SAFE:** ante dato faltante (account sin puente, set no cargado) **no bloquea**.

## Capa 6 — Filtro por LÍNEA DESTINO (v0.3.0, 2026-07-29)

Filtra las tarjetas del step por la **línea a la que va** el material (`T204`, `T300`…) = la línea
de la estación donde la orden está **programada**. Pedido de operaciones.

**Complementa, no duplica, el filtro nativo de SH** (confirmado con el operador y con evidencia
DOM): el nativo filtra por la estación donde la pieza está **parada** —en la tarjeta,
`Estación: Proquipa.N1.A1`, una ubicación de almacén—, no por la que sigue. Son preguntas
opuestas y **composables**: el nativo te deja en el step, el nuestro recorta a los que van a T204.
Por eso la etiqueta lleva flecha (**`→ Línea destino`**) y el box va en **dark-mode**: dos filtros
de "estación" juntos son el anti-patrón de `auto-router` 0.3.2, y aquí escoger mal **surte
material a la línea equivocada**.

### El dato: `td[1]` de la tabla, nunca el texto de la tarjeta

La tarjeta trae, tras el label `Tareas Programadas:`, una `<table>` con
`[td0=tratamiento, td1=estación, td2=fecha]`. La línea sale de **`td[1]`**.

**Por qué importa — medido en el board real (`/Domains/344/Workboards/6234`, 6 tarjetas):** el
enfoque "ingenuo" de sacar el código del `textContent` de la tarjeta se equivoca en **6 de 6**.

| Tarjetas | Correcto (`td[1]`) | Ingenuo (`textContent`) |
|---|---|---|
| 16408, 16407, 12819, 12798, 12799 (**no** programadas) | `[]` | `T205`,`T300`,`T400`,`T205`,`T205` — **líneas inventadas** |
| 12831 (la **única** programada) | **`T300`** | **`T400`** — la del `Proceso:`, no la del destino |

O sea: la tarjeta dice `Proceso: T400 (ANT)-CU-VARIOS` y su estación destino real es
`T300-CE03-002 Célula de Antitarnish`. **El anclaje por posición de celda no es preferencia de
estilo: es lo que evita surtir a la línea equivocada.**

Tampoco sirve `td[0]`: el tratamiento a veces no trae código (`TR-PRM-001 Antitarnish Manual`).
El prefijo `at ` de `td[1]` es un literal **inglés en UI española** — se ignora al no anclar el
regex al inicio, que es seguro porque el ámbito es **una sola celda**.

### El catálogo del dropdown viene de la API, no del DOM

`GetRelatedScheduleData` —que el candado **ya interceptaba**— trae el `stationId` **hermano** del
set de accounts programados, así que el destino no cuesta ninguna consulta nueva. `AllStations`
(hash ya en config, 1 llamada por carga) le pone nombre y `lineCodeFromStationText` lo agrega.

Se hace así **porque el board está virtualizado**: solo monta ~8 tarjetas, así que un dropdown
armado del DOM nacería incompleto y no dejaría elegir una línea cuya tarjeta no se ha montado.
Los conteos son de **órdenes únicas** (`workOrderId`), no de accounts; las estaciones que no se
pudieron resolver se **reportan** (`unknownStationIds`) — un conteo que se las traga hace mentir
al dropdown por omisión.

### Esconder SÍ es seguro con react-virtuoso (medido, no supuesto)

El board usa **react-virtuoso** (`[data-testid="virtuoso-scroller"]`/`"virtuoso-item-list"`,
items con `data-item-index` + `data-known-size`, `overflow-anchor:none`). `display:none` sobre el
nodo `[data-item-index]` hace que virtuoso **re-mida solo** vía `ResizeObserver`:

| Prueba | Antes | Después | Revertido |
|---|---|---|---|
| Ocultar 2 de 6 | `scrollHeight` 1034 | **524** | 1034 ✓ |
| Filtrar por `T300` (oculta 5) | 441 / 1034 | **51 / 401** | 441 / 1034 ✓ |
| Rects de las visibles | contiguos | **contiguos** (365→416→467→678→889) | — |

Cero huecos, cero tarjetas encimadas. ⇒ se implementó **esconder**, no atenuar.

**Dos guardas fail-safe** (`planFilter`): si virtuoso pasa de **200** items montados con el filtro
puesto → **atenúa** en vez de esconder (esconder libera espacio y virtuoso monta más, que es lo
deseado… hasta que el filtro deja casi nada); y si la API reporta programadas pero **ninguna**
tarjeta revela línea, el filtro **se apaga solo** y lo avisa. Ese árbitro pesa más que en el
naranja: **un color errado se ve; trabajo escondido, no.**

### El catálogo se UNE con el DOM — el bug que encontró la validación en vivo

Primer deploy (1.11.23) validado en el board: la extracción por tarjeta funcionaba perfecto
(una tarjeta daba `T300`) pero **el dropdown salió vacío**, solo con `Todas`. Causa medida:
`GetRelatedScheduleData` **no llegó al interceptor** —ni recargando ni navegando dentro de la
SPA—, así que `lineCounts` quedó en `{}`. Un filtro con el dropdown vacío es **inutilizable**
aunque su lógica esté bien.

Fix (1.11.24): `mergeLineCatalog` **une** el catálogo de la API con las líneas que las tarjetas
montadas revelan. Cuando la API llega manda ella (conteo completo de órdenes, que es la razón de
preferirla); cuando no, al menos se puede filtrar por lo que hay a la vista. **Las líneas que solo
vio el DOM van SIN número** — dar el conteo de lo montado como si fuera el total de órdenes sería
mentir justo en el dato con el que el operador decide. En el board real el dropdown quedó
`Todas` + `T300` (sin número, correcto).

**Lección:** un applet puede tener el núcleo impecable y ser inservible porque su *entrada* depende
de un dato opcional. El fallback no fue relajar la lógica, sino **ampliar la fuente**.

### El catálogo tarda, y callarlo confunde (1.11.32)

Con el catálogo ya correcto, el operador reportó lo siguiente: *"ya salen pero se tarda en cargar,
así que si le doy rápido sólo salen 3, pero después de unos segundos salen las demás"*. El **dato
estaba bien**; lo que faltaba era **decir que aún no terminaba** — abrir el dropdown temprano
mostraba las líneas del DOM y se leían como si fueran todas.

**Anillo animado + «buscando líneas…»** junto al dropdown mientras `boardCatalogState` no sea
`ready`. Si la carga falla, el anillo **deja de girar**, se pone ámbar y dice «catálogo incompleto
(solo lo visible)»: un spinner eterno mentiría prometiendo algo que ya no viene.

La animación es **CSS pura** — el DOM no muta mientras gira, así que no re-dispara el
`MutationObserver` (que corre con `subtree:true`); el nodo se crea una vez y solo se
muestra/oculta. Respeta `prefers-reduced-motion`.

**Lección:** los tres bugs del filtro fueron del **catálogo**, no del núcleo — de dónde salen las
opciones, cuándo se pierden, y **cuánto tarda en estar completo**. Un dato correcto que llega
tarde y en silencio se lee como un dato equivocado.

### El catálogo se descubría por accidente (bug del operador, 1.11.29)

Reportado con capturas en el board **Almacén 1 (Proquipa)**, 142 órdenes: el dropdown abría con
**3** líneas (T101/T104/T204), tras filtrar mostraba **5**, y siguiendo llegaba a **8**
(T101/T102/T104/T106/T110/T204/T301…). El catálogo se iba revelando conforme filtrabas.

**Causa:** el catálogo salía de las tarjetas **montadas**, y el board virtualiza — de 142 órdenes
monta ~8. Filtrar esconde tarjetas, virtuoso monta otras para llenar el hueco, y aparecen líneas
que antes no se veían. El fix de 1.11.26 evitaba **perder** líneas; no que el catálogo **naciera
incompleto**.

**Fix:** `linesFromBoardSchedule` sobre **`WorkOrderSchedule`**, que devuelve el schedule
**COMPLETO del dominio** con el nombre de estación de cada tarea. Cuesta 2 llamadas (hay que
resolver el `workOrderId` GLOBAL primero) una sola vez por carga; la respuesta pesa **~4.6 MB**,
así que se **destila a una lista de códigos y el crudo se suelta de inmediato**.

Devuelve **solo líneas, sin conteos**, y es deliberado: esa query cubre el dominio entero, no este
workboard, así que sus números mentirían justo en el dato con el que se decide.

### El filtro se comía su propio dropdown (bug del operador, 1.11.26)

Reportado en vivo: *"va limitando la cantidad de líneas que muestra el dropdown a las que tiene
filtradas en ese momento, no las totales del workboard"*.

**Causa:** al esconder las tarjetas de otras líneas, react-virtuoso **las desmonta** (el scroll se
encogió y salen del viewport). Como el catálogo del DOM se armaba con lo montado **en ese
instante**, filtrar por `T300` dejaba el dropdown solo con `T300` ⇒ **quedabas atrapado**: para
saltar a `T204` había que quitar el filtro primero.

**Fix:** `accumulateSeenLines` vuelve el catálogo del DOM **acumulativo** — las líneas vistas se
suman y no se pierden aunque su tarjeta se desmonte; se limpian al salir del board. De paso
arregla el caso normal de virtualización: scrollear descubre líneas nuevas y se **suman**.

**Lección:** cuando el efecto de un filtro cambia el DOM del que ese filtro deriva sus opciones,
hay un **lazo de retroalimentación**. El catálogo tiene que vivir fuera de lo que el filtro
modifica. Es la misma familia del bug anterior (dropdown vacío): las dos veces el núcleo estaba
bien y lo que fallaba era **de dónde salían las opciones**.

### Aislamiento del candado

Esconder es **puramente visual**. El candado bloquea sobre el *payload* de la mutación, así que
una tarjeta oculta sigue igual de bloqueada; y `display:none` **no desmonta**, así que
`decorateCards` sigue viendo todas y su árbitro del naranja no se altera.
`surtido-guard-filter-isolation.test.js` lo fija: el core del filtro no menciona el flag del
candado, ni `fetch`, ni la mutación, ni `evaluateMove`, y `evaluateMove` da el mismo veredicto con
y sin filtro. **No persiste** entre recargas, igual que el candado.

**UI:** box en la barra de acciones del header, anclado subiendo desde `NUEVA TARJETA`/`NEW CARD`
(ES+EN). Va **en flujo, sin `position:fixed`**: esa barra tiene `overflow: visible` (medido), a
diferencia del header que forzó el `fixed` en `batch-name-filter`.

**Componentes:** `remote/scripts/surtido-guard-filter-core.js` (puro, **39 golden**) +
`tools/test/surtido-guard-filter-isolation.test.js` (4) +
`tools/test/surtido-guard-filter-config.test.js` (5, fija el ORDEN core→glue en `config.json`).

## Shapes confirmados (Fase 0, tráfico real 2026-06-26/29)
| Operación | Tipo | Rol |
|---|---|---|
| `CreateManyPartsTransfersChecked` | mutación | **El move.** `partsTransferEventsPayload.partsTransferEvents[].partsTransfers[].{fromAccountId, type:"STEP", toAccount:{recipeNodeId}}`. NO trae workOrderId. |
| `WorkOrderMovePartsData` | query (modal) | `{workOrderId, fromRecipeNodeId, partsTransferAccountIds:[...]}` → puente account→{nodo,WO}. |
| `MoveMultipleFromWorkboardData` | query (drag) | `{workOrderIds:[...], fromRecipeNodeIds:[...], partsTransferAccountIds:[...]}` pareados por índice. |
| `GetRelatedScheduleData` | query (board) | `allSchedules.nodes[].validScheduleTasks.nodes[].scheduleTaskElementsByScheduleTaskId.nodes[].associatedPartsTransferAccounts.nodes[].{id, workOrderId}` → set de programados. |
| `GetRelatedWorkboardData` | query (board) | `allRecipeNodes.nodes[].{id, name}` → nodo "Preparando Surtido en Almacén" (match normalizado por inclusión). |

**Cruce:** `fromAccountId` de la mutación ↔ `id` de `associatedPartsTransferAccounts` (programado). Scope:
el `fromRecipeNodeId` del move (de las vars del query) debe ser un nodo cuyo nombre incluye
"preparando surtido en almacen".

> `CreateInventoryTransferEventGroups` (ya en config) **NO** es el move (es "carga inicial de lotes",
> usedBy `inventory-reset`).

## Componentes
- `remote/scripts/surtido-guard-core.js` — puro: `buildScheduledAccountSet`, `buildSurtidoNodeSet`,
  `indexAccountNodeFromMoveVars`, `extractStepTransfers`, `shouldBlockMove`, `evaluateMove` y (capa 4)
  `hasScheduledCardSignal` (regex bilingüe), `isDomSignalBroken` (árbitro API), `shouldMarkNotMovable`.
  Tests: `tools/test/surtido-guard-core.test.js` (16/16) + fixtures `tools/test/fixtures/surtido-guard-*.json`.
- `remote/scripts/surtido-guard.js` — glue: interceptor, capa modal, marcado verde, toggle, memory hardening.
- `remote/config.json` — app `surtido-guard` (`autoInject`, scripts, toggle action).

## Plan de validación en vivo — ✅ COMPLETADO 2026-07-22 (confirmación del operador)
1. **Mapa**: en el board, `window.SurtidoGuard._getState()` debe mostrar `scheduled`>0 y `surtido` con el/los recipeNodeId.
2. **Bloqueo modal**: abrir ⇄ de una WO **no programada** + MOVER → no se mueve, toast rojo, botones grises.
   Una WO **programada** → se mueve normal (cuidar falsos positivos).
3. **Bloqueo drag**: arrastrar una no programada → bloqueado igual.
4. **Toggle**: apagar desde el popup → permite mover; recargar → vuelve a ON. ✅ **VALIDADO en vivo 2026-06-29** (fix v0.1.1: estado en `window` singleton).
5. **Verde**: tarjetas con "Tareas Programadas:" en verde; afinar el selector de contenedor con el HTML real.

## Portar a iPad (Safari Web Extension)
Decidido portar como **Safari Web Extension** (no PWA) — análisis en
[`docs/architecture/ipad-surtido-guard-decision.md`](../architecture/ipad-surtido-guard-decision.md).
POC en `safari/` (source + plan B + README de Xcode). Guía de build: `docs/deploy-safari.html`.
Inventario de portabilidad de TODOS los applets: `docs/architecture/ipad-applets-inventory.html`.

**Pipeline de bundle multi-applet + bridge de config VALIDADO en vivo (Safari iPad, 2026-06-30) ✓:**
`tools/build-safari.sh` genera `main-bundle.js` (varios applets concatenados desde la fuente única, cada uno
en IIFE) + `manifest.json` (bridge ISOLATED + bundle `world:MAIN`). El **bridge** (`bridge.js`) fetchea
`config.json` de gh-pages en el mundo aislado y `sa-bootstrap.js` instala `window.REMOTE_CONFIG` +
`SteelheadAPI.init` → **los hashes se actualizan EN CALIENTE (git push), sin recompilar** (Apple 2.5.2 prohíbe
código remoto, no datos). Confirmado en dispositivo: `REMOTE_CONFIG.version`="1.7.34" (la version EN VIVO de
gh-pages, no horneada) y `getHash('CreateMaintenanceEvent')` devolvió el hash correcto → la CSP de Steelhead
NO bloquea el fetch del bridge a github.io. Mini-bundle: surtido-guard + paros-linea + weight-quick-entry +
receiver-date-override. **Para escalar a los 16 "directo": editar `safari/bundle.json`.**

**Bundle de 16 applets — gotchas de Safari resueltos (handoff, 2026-06-30):** al escalar de 4 a 16 el
bundle crasheaba en cadena. Lecciones:
- **`run_at: document_idle`** (NO `document_start`): en `document_start` `document.body` es `null` y
  `weight-quick-entry` hace `observer.observe(document.body)` → `TypeError` que **detiene todo el bundle**
  (un error de evaluación mata el `<script>` y no cargan los applets siguientes). La ext. de Chrome ya usa
  `document_idle`.
- **shim `window.chrome`**: en el MAIN world de Safari NO existe `window.chrome`; `wo-mover`/`auto-router`
  hacen `chrome.runtime?.onMessage` y el `?.` no protege la variable base → `ReferenceError` que también
  detiene el bundle. Fix: `if (typeof window.chrome==='undefined') window.chrome={}` al inicio del bundle.
- **config-seed tras `steelhead-api.js`** (no al final) + **bridge en `document_start`**: los applets leen el
  config y su flag de enable UNA vez en `init()`. El config va horneado (seed síncrono) antes de los applets;
  los flags (toggles) los setea el bridge en `document_start` como data-attributes ANTES de que el bundle
  (`document_idle`) los lea. El config en vivo llega por handshake (`__saBridgeReq`).
- **Correr SIN el debugger de Xcode**: con el debugger adjunto (`MallocStackLogging`) el `WebContent` de Safari
  + Steelhead da OOM en iPad a los ~5 min. Instalar con Xcode y luego abrir Safari suelto (o desmarcar "Debug
  executable" en el scheme). No es la app: es el overhead del debugger.

**Popup de toggles** (`safari/extension/popup.html`/`popup.js`): interruptores para los 6 applets con flag
data-attribute (cfdi, weight, receiver, warehouse, invoice-auto-regen, invoice-default-tab). El candado y
paros-linea usan otro mecanismo (no dataset) → **pendiente** portarlos al popup. Los 6 "con-popup" del
inventario (auto-router, archiver, load-calculator config, sensor-status, report-liberator, wo-deadline) son
**Fase 2** (requieren portar su popup de acción).

**POC validado en vivo (Safari iPad, 2026-06-30) ✓:** `world:"MAIN"` SÍ intercepta `fetch` en Safari/iPadOS
(el warning `world not supported` del converter es de su validador, no del runtime → **NO se necesitó el plan
B**). `_getState()` devolvió `{enforcementEnabled:true, surtido:[44721633], scheduled:[], accounts:0}`: el
interceptor captura el nodo de surtido y **bloquea mover una pieza no programada** (confirmado en dispositivo).
`scheduled:[]` fue correcto — no había piezas programadas en el board. Gotchas de build documentados en la
guía (warning de `world`; error "Embedded binary's bundle identifier is not prefixed…" → la extensión debe ser
`<bundleId-app>.Extension`).

**✅ Validado en vivo 2026-07-22 (confirmación del operador) — sin falsos positivos:** una pieza **PROGRAMADA** en el board
se **mueve normal** (no se bloquea). El run confirmó además que `GetRelatedScheduleData`
sí se captura y puebla `scheduled` (hoy no se pudo distinguir "vacío correcto" de "no capturado"). Vinculado al
riesgo del **fail-safe silencioso**: el mapa de programadas (`buildScheduledAccountSet`) devuelve `Set` vacío
sin error si el shape cambia → pendiente telemetría/alerta cuando el set sale vacío en un board de surtido.

## Lecciones

### El estado mutable del applet NO puede vivir en el closure del IIFE (bug del toggle, 2026-06-29)
**Síntoma:** el operador apaga el candado desde el popup → toast "DESACTIVADO" aparece → pero **sigue
bloqueando**; al recargar vuelve a ON.

**Causa raíz:** `background.js` → `injectAppScripts` **re-evalúa los scripts del app en CADA acción del
popup**. El dedup que evita re-evaluar (`if (window[globalName].__saVersion === version) return`) solo aplica
a los scripts listados en el mapa `globals` de `background.js` — **`surtido-guard.js` no está en ese mapa**,
así que cada toggle corre `new Function(código)()` y crea una **instancia nueva** del IIFE. El interceptor de
`window.fetch` está latcheado a la instancia ORIGINAL (`__saSurtidoGuardFetchPatched`) y lee el
`enforcementEnabled` de **su** closure; el toggle mutaba el `enforcementEnabled` de la instancia NUEVA. Toast
sí (la nueva instancia lo dispara), enforcement no (el interceptor lee el flag viejo).

**Fix:** el flag de estado vive en `window.__saSurtidoGuardEnabled` (singleton compartido por todas las
instancias), igual que los latches `__saSurtidoGuard*` que el applet ya usaba para interceptor/observer/init.
Default ON solo en la **primera** carga (`if (window.__saSurtidoGuardEnabled === undefined) … = true`): una
re-inyección NO repisa lo que el operador apagó, y un reload limpia `window` → vuelve a ON (no persistente, por
diseño). Test de regresión: `tools/test/surtido-guard-toggle.test.js` (replica `new Function()` como la
extensión; RED sin fix, GREEN con fix).

**Regla general:** cualquier applet re-inyectable que NO esté en el mapa `globals` de `background.js` debe
guardar su estado mutable en `window.__sa<App>*`, no en variables del closure — o el popup mutará una instancia
distinta a la que tiene los interceptores latcheados.

### Invertir un marcado por señal DOM agrava el riesgo del anclaje mono-idioma (v0.2.0, 2026-07-20)
El marcado v0.1.x pintaba **verde** las tarjetas CON la señal "Tareas Programadas:". Al invertir a **naranja
las que NO la tienen**, el failure mode cambió de signo: con el verde, si la señal no matcheaba (locale EN,
cambio de texto de SH) simplemente **no se pintaba nada** (benigno); con el naranja, la ausencia de señal
haría que **TODAS** las tarjetas se pinten (falsa alarma masiva "nada se puede mover"). Dos mitigaciones:
1. **Anclaje bilingüe ES+EN** (`Tareas Programadas:` / `Scheduled tasks:`) — string EN provisto por el usuario,
   no adivinado (regla dura del repo). Baja la probabilidad de "señal no matchea".
2. **Árbitro con el dato de la API**: `isDomSignalBroken(anyCardScheduled, scheduledAccountIds.size)` — si
   NINGUNA tarjeta reconoce la señal pero `GetRelatedScheduleData` sí trajo programadas, la señal DOM está
   rota → no marcar (en vez de pintar todo). `scheduledAccountIds` vive en el closure de la instancia ORIGINAL
   (la que tiene el interceptor y el observer latcheados), que es la misma que corre `decorateCards`, así que
   el árbitro ve el set correcto. El color NO afecta el bloqueo real (API-driven), así que un color errado
   confunde pero no permite mover lo que no se debe.

**Lección transferible:** antes de invertir cualquier marcado heurístico "resaltar lo bueno" → "resaltar lo
malo", revisa el failure mode del anclaje: resaltar la excepción amplifica los falsos positivos del ancla.

## Pendientes

### 🔴 PRIORITARIO — `scheduledAccountIds` salió VACÍO en un board de surtido real (2026-07-30)

Medido al validar el filtro en `/Domains/344/Workboards/6234` ("Preparación de Surtido Almacén 5
(Blanca)"): `_getState().scheduled.length === 0` **con el board cargado y con una tarjeta que sí
muestra su tabla de `Tareas Programadas:`** (WO 12831 → T300). No es una carrera de inyección: se
reprodujo **recargando por URL y navegando dentro de la SPA**, y en la misma sesión
`GetRelatedWorkboardData` **sí** se capturó (`surtido` traía 4 nodos). O sea, en ese board
`GetRelatedScheduleData` no llega al interceptor.

**Por qué importa (razonamiento sobre el código, NO observado en vivo — no se intentó mover nada
en producción):** con `scheduledAccountIds` vacío, en cuanto el operador abra el modal de mover
—que es lo que llena `accountNode`— `evaluateMove` encontraría `info`, el nodo estaría en scope y
`scheduled.has(accountId)` daría `false` ⇒ **bloquearía una orden legítimamente programada**. Es
exactamente el riesgo de falso positivo que esta bitácora ya listaba como "el que hay que vigilar",
y su síntoma es que el operador apaga el candado.

Contra esto juega que el 2026-07-22 el operador validó que una programada **sí se mueve**, así que
ahí el set no estaba vacío. Hipótesis a checar (sin confirmar): que aquél fuera **otro workboard**
de surtido y que la query dependa del board.

**Qué hacer:** (1) reproducir en el board donde se validó en julio; (2) si se confirma, el candado
necesita **pedir la query él mismo** en vez de esperar a cazarla, o **fail-safe explícito**: si el
set está vacío y el board sí es de surtido, no bloquear y avisar. Enlaza con la telemetría ya
pendiente ("alerta cuando el set sale vacío en un board de surtido"), que deja de ser un nice-to-have.
- **Filtro: los ENCABEZADOS DE GRUPO no se filtran (conocido, cosmético).** El board tiene items
  `[data-item-index]` que no son tarjetas sino headers del agrupador (`Scheduled | Total QTY: 2291`;
  3 de los 9 items montados). El filtro no los toca —correcto, son estructura— pero si un grupo
  queda **sin tarjetas visibles**, su header se queda huérfano anunciando un total que no
  corresponde a lo que se ve. Resolverlo requiere modelar el agrupamiento (hay varios grupos
  intercalados **dentro** de una misma lista virtuoso: se observaron headers con `data-item-index`
  0 y 2 en el mismo scroller), y esconder un header por error ocultaría información legítima. Por
  eso se dejó fuera de v0.3.0; el contador del box (`N visibles`) es la mitigación actual.
- **Filtro: `mountedCount` cuenta headers además de tarjetas** (9 vs 6 en el board medido). Solo
  alimenta la guarda del tope de 200, así que el efecto es dispararla un poco antes —conservador,
  no incorrecto—. Afinarlo si alguna vez la guarda se activa de más.
- **Validar en vivo el indicador de carga (1.11.32).** Es lo único de la capa 6 sin ver en piso: al
  recargar el board debe aparecer el anillo con «buscando líneas…» un par de segundos y luego el
  dropdown completo. Los otros tres fixes de catálogo ya los confirmó el operador.
- **Riesgo permanente a vigilar en el candado: falsos positivos** (bloquear una programada) → el
  operador apaga el toggle y se reporta. Hoy tiene un disparador concreto identificado: el
  pendiente 🔴 de arriba.

> **Cerrados (ya no son pendientes — se dejan anotados para que no vuelvan a la lista):**
> **Validación en vivo del bloqueo** — hecha 2026-07-22, confirmada por el operador (sin falsos
> positivos prog/no-prog). · **Drag silencioso commitea por `CreateManyPartsTransfersChecked`** —
> confirmado en vivo 2026-07-22. · **HTML fino de la tarjeta** — capturado y documentado el
> 2026-07-29 (§1.1 del spec del filtro y §Capa 6): el ancla es
> `[data-item-index]` → `table.MuiTable-root`, y el marcado ya **no es verde** sino naranja desde
> 0.2.0, así que la redacción vieja de ese pendiente había quedado obsoleta.
