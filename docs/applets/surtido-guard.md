# Applet `surtido-guard` — Candado de Surtido Programado

> Versión: **0.1.1** (config 1.7.25). Estado: **toggle VALIDADO en vivo (2026-06-29) ✓; el bloqueo aparece en vivo. Pendiente: validación fina del bloqueo (falsos positivos prog/no-prog), drag silencioso y marcado verde**.
> Spec: [`docs/superpowers/specs/2026-06-26-surtido-guard-design.md`](../superpowers/specs/2026-06-26-surtido-guard-design.md) ·
> Plan: [`docs/superpowers/plans/2026-06-26-surtido-guard.md`](../superpowers/plans/2026-06-26-surtido-guard.md)

## Qué resuelve
En el Workboard **"Preparación de Surtido"** (`/Domains/<id>/Workboards/<n>`), step
**"Preparando Surtido en Almacén"**, evita que el operador mueva piezas al siguiente proceso si la
**orden de trabajo no está programada** en producción, y marca en **verde** las tarjetas que sí lo están.

**Programada = la pieza tiene una tarea en el programa** (la tarjeta muestra la sección
"Tareas Programadas:" con tratamiento + estación + fecha-hora). El color del calendario rojo/verde es
la **fecha de entrega** (deadline), NO la señal de programación.

## Arquitectura (5 capas)
Glue en `surtido-guard.js`; lógica pura + parsers en `surtido-guard-core.js` (golden tests).
El corazón es un **interceptor de `window.fetch`** (patrón `auto-router.js`) que cubre las dos rutas
de movimiento con un solo punto de enforcement:

1. **Mapa de programadas** — lee la respuesta de `GetRelatedScheduleData` → `Set<partsTransferAccountId>` programados.
2. **Enforcement** — intercepta el **request** de `CreateManyPartsTransfersChecked`; si un transfer `type:"STEP"`
   sale de un nodo de surtido con account **no** programado → no lo reenvía, responde error GraphQL sintético
   (`{errors:[{message}]}`) + toast. **Cubre el modal MOVER y el drag silencioso** (ambos disparan esa mutación).
3. **Capa de modal** — agrisa los botones **Mover** / **Imprimir y Mover** (match por texto) + mensaje inline.
4. **Marcado verde** — tarjetas con "Tareas Programadas:" reciben acento verde (señal DOM directa).
5. **Toggle** — en el popup (`toggle-surtido-guard` → `SurtidoGuard.toggleFromPopup`), no persistente,
   **default ON cada carga**; se reactiva al recargar. El verde no se ve afectado por el toggle.

**Política FAIL-SAFE:** ante dato faltante (account sin puente, set no cargado) **no bloquea**.

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
  `indexAccountNodeFromMoveVars`, `extractStepTransfers`, `shouldBlockMove`, `evaluateMove`.
  Tests: `tools/test/surtido-guard-core.test.js` (13/13) + fixtures `tools/test/fixtures/surtido-guard-*.json`.
- `remote/scripts/surtido-guard.js` — glue: interceptor, capa modal, marcado verde, toggle, memory hardening.
- `remote/config.json` — app `surtido-guard` (`autoInject`, scripts, toggle action).

## Plan de validación en vivo (pendiente)
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

**Pendiente de validación (crítico, descarta falsos positivos):** probar una pieza **PROGRAMADA** cuando haya
una en el board → debe **moverse normal** (no bloquearse). Ese test confirma además que `GetRelatedScheduleData`
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

## Pendientes
- **Validación en vivo del bloqueo real** (arriba). Riesgo a vigilar: **falsos positivos** (bloquear una
  programada) → el operador apaga el toggle y se reporta.
- **HTML fino de la tarjeta**: el marcado verde usa heurística (sube desde "Tareas Programadas:" hasta un
  ancestro con "Proceso:" + "WO:"); capturar el `outerHTML` de una tarjeta del step para un selector exacto
  y, si se quiere, el 🔒 en no programadas.
- **Confirmar** que el drag silencioso efectivamente commitea por `CreateManyPartsTransfersChecked` (lo más
  probable; validar en vivo).
