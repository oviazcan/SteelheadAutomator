# schedule-batch-highlighter — Resaltar y Agrupar Lote en Programación

**Versión actual:** 0.2.0 — **SIN DEPLOYAR, sin corrida real.** Core de agrupación 28/28 + cableado 6/6,
suite 88 archivos verde. La 0.1.4 (config **1.7.178**, tag `v1.7.178`) sigue siendo lo que está vivo.

## v0.2.0 (2026-07-30) — agrupar el lote en UNA tarea del programa

Cierra el paso que el applet dejaba a mano: resaltaba y marcaba las tareas del lote, y ahí terminaba.
Ahora el botón **📦** junto al 🏷️ crea la tarea agrupada, como el **Task Builder** nativo.

**El mecanismo, capturado en vivo** (scan 2026-07-30, board 454; eventLog 01:56:31 → 01:57:00):

```
RackingRecipeNodes{workOrderIds:[4 OTs]}   ← el Task Builder abre con lo seleccionado
   ↓ (Save)
CreateManyScheduleTasks → 1 scheduleTask con 5 scheduleTaskElements
```

Una tarea agrupada es **(treatmentId, stationId) + N elementos**, cada elemento
`(recipeNodeId, partNumberId, partCount, partsPerBatch, relatedPartTransferAccounts[])`.

**Fórmula de duración, verificada 2× contra ese payload (no inferida):**
`total = treatmentTime + (Σ ceil(partCount_i / partsPerBatch_i) − 1) × cycleTime`
— #1: `45 + (41−1)×30 = 1245` (real 1245) · #2: `45 + (41−1)×15 = 645` (real 645). Los lotes se
**SUMAN entre elementos**; calcularlos por elemento da otro número. Es la fórmula de
`wo-schedule-core` (fase 2b) extendida a N elementos.

### Tres cosas que la evidencia corrigió

1. **«T-2150» no es un lote: son 21 inventory batches DISTINTOS con el mismo nombre** (`ids
   1439287…1447756`) — el ERP crea uno por orden. Así que la unidad de agrupación es el **NOMBRE**;
   por id no se agruparía nada. Es el mismo hecho que rompe al filtro nativo (su dropdown solo
   ofrece un id por nombre) y el que justificó este applet desde el día uno.
2. **Una orden con DOS nodos programables no es un caso ambiguo:** pasa por dos tratamientos y el
   nativo crea **dos tareas encadenadas** — el payload real son las mismas 5 piezas en `112435` y
   luego `91495`. Por eso el modelo es **una tarea por lote × tratamiento**, que es exactamente lo
   que hace Steelhead, y el preview lo anuncia («este lote sale en 2 tareas») en vez de decidirlo.
3. **`RackingRecipeNodes` (340 KB) no hace falta:** `treatmentId`, nombre del tratamiento y
   `possibleTreatmentTimes` ya viajan en **`RelatedSchedulingInformation`**, que el board dispara
   solo. **Cero consultas nuevas** — mismo patrón que `surtido-guard` 0.4.0 (la fuente ya viajaba
   gratis). Un test lo fija: si el glue vuelve a nombrar `RackingRecipeNodes`, se pone rojo.

### Se agrupa con DATOS, no con el DOM

El resaltado matchea el **texto** de la celda y la tabla **virtualiza** (34 declaradas, 17 en DOM).
Para *pintar* basta; para *escribir el programa* no: agrupar «lo que alcanzaste a scrollear» crearía
una tarea **incompleta en silencio** — el peor modo de falla, porque el resultado se ve exitoso. Los
grupos salen de `SchedulablePartLocations` + `RelatedSchedulingInformation`, interceptadas del
propio board. El resaltado y el `cb.click()` quedaron **intactos**.

### Fail-safe: cuándo NO se agrupa

Esto escribe en el programa de producción, así que ante dato ausente el núcleo devuelve `null` en
vez de completar con un default. Sin `partsPerRack`, `partsPerBatch` caería a **1** y una tarea de
141 min se vuelve de **~112 días** (medido en `wo-schedule-button` 0.8.0). `diagnoseGroup` bloquea y
**dice por qué**: sin tiempos de tratamiento · tratamiento que no corre en este tablero · sin piezas
por carga · duración implausible (>7 días) · material ya programado (agrupar 2× lo duplicaría).
**Un falso «no puedo» cuesta un clic manual; un falso «sí puedo» ocupa una tina por días.**

### Cobertura medida sobre las 369 órdenes del board (no estimada)

| | |
|---|---|
| 1 nodo programable | 325 órdenes |
| 2 nodos (→ 2 tareas) | 21 |
| **0 nodos** | **23** → no agrupables |
| Con tiempos de tratamiento | 335 de 367 (**91%**) — 32 sin tiempos → fail-safe |
| Nodo programable = `SCANNER_NODE` «Listo para Procesar» | 364 de 367 |

### Arquitectura de la 0.2.0

- **`schedule-batch-group-core.js`** (NUEVO, puro) — `indexBatchesByWorkOrder`,
  `indexSchedulableNodes`, `indexStations`, `partsPerBatchFor`, `groupedTaskTimes`,
  `buildBatchGroups`, `diagnoseGroup`, `buildGroupedScheduleTaskInput`. **28 golden** sobre
  fixtures REALES, incluido el que exige reproducir **byte a byte** el payload que el ERP aceptó.
- **`schedule-batch-group.js`** (NUEVO, glue) — botón 📦 dentro del widget 🏷️ + modal **dark-mode**
  (preview → confirmar → crear). Archivo aparte para no inflar el highlighter, que sigue en lo suyo.
- **`config.json`** — hash nuevo `RelatedSchedulingInformation`
  (`05aa9059…`, ruta de regeneración agregada a `schedules-detail`, así el trinquete de cobertura
  queda en su línea base); la app suma `steelhead-api.js` y los dos scripts nuevos.
- **`schedule-batch-group-wiring.test.js`** (6) — el botón es un contrato entre tres archivos y
  ninguno falla solo; el recorrido config↔glue↔hashes se fija en test.

**`expectedStartTime`** es el instante actual con `status:UNSCHEDULED` e `isIntentional:false` —
igual que el nativo: **no fijamos hora**, el planificador la acomoda. Fijarla es otra decisión (el
📅 de `wo-schedule-button`).

### Pendiente

- [ ] **Corrida real**: el glue no se ha ejecutado contra el ERP. Primero un lote chico y verificar
      que el material sale de los candidatos al refrescar el tablero.
- [ ] Deploy (config + firma KMS) y rebundle Safari/iPad (el applet ya está en la lista blanca;
      los dos scripts nuevos entran solos al expandir `config.apps[].scripts`).

## v0.1.x — el resaltado (VIVO)

**Iteraciones sobre feedback del operador:**
- **v0.1.4** (2026-07-23) — **fix "aparecen los DOS buscadores"** (panel flotante viejo + inline nuevo a
  la vez, reportado con captura). **Causa raíz:** v0.1.0/0.1.1 montaban un panel FLOTANTE `#sa-sbh-panel`
  (`position:fixed`); v0.1.2+ cambió a inline con otro id (`#sa-sbh-inline`). En la SPA de larga vida el
  remote loader **recarga el script sin recargar la página**, y el glue nuevo **nunca removía** el nodo
  viejo → quedaba **huérfano** coexistiendo con el inline. Fix: `cleanupLegacy()` (init) remueve los ids
  de versiones previas —lista `Core.LEGACY_NODE_IDS = ['sa-sbh-panel']`, testeable, invariante "nunca
  incluye `ACTIVE_NODE_ID`"—; y `injectStyles()` **reemplaza** el `<style>` obsoleto (el `STYLE_ID` era
  compartido → short-circuit dejaba al inline sin sus reglas en una reinyección en caliente). Core 14/14.
  Lección general: **todo applet que cambie el id de su nodo raíz entre versiones debe limpiar los ids
  legacy al montar** (mismo espíritu que los latches singleton de surtido-guard/price-confirm-guard).
  **VALIDADO EN VIVO (operador 2026-07-23):** "ya quedó, ya no salen los dos" tras recargar la pestaña.
- **v0.1.1** — fix "No encuentro la columna": el header es un **`<strong>` dentro de un `<td>`** (MUI
  CSS-grid, no `<th>`) y el selector solo cubría `th/div/span`. Fix: selector incluye
  `strong/td/b/a/p/label` + matchea el **nodo hoja** + sube al **`<td>` ancestro** para medir el centro
  X (la columna del grid), no el `<strong>` (que mide solo el texto y desalinearía).
- **v0.1.2** — 3 ajustes de UX pedidos por el operador: (1) el panel flotante era **intrusivo** →
  **buscador inline** en la barra de filtros nativa, tras el último filtro; (2) **Limpiar no
  des-marcaba** (refs de checkbox recicladas por la virtualización) → barrido de filas visibles del
  lote; (3) resaltado **verde pastel** (menos intenso, legible en la tabla clara).
- **v0.1.3** — descubribilidad del aviso: **ícono ⓘ visible** (verde, junto al contador) con el
  tooltip antes escondido solo en el 🏷️; el texto ahora **recomienda ORDENAR la tabla por la columna
  "Received Batches"** (clic en su encabezado) para que los homónimos queden juntos → un solo scroll
  los cubre a todos (mitiga la limitación de virtualización, tanto al marcar como al des-marcar).

**VALIDADO END-TO-END (2026-07-22):** el operador confirmó ("ya quedó") el buscador inline (posición
tras SO), el resaltado verde pastel, que **Limpiar ya des-marca**, y el ícono ⓘ con el tooltip de
scroll + recomendación de ordenar. **Sin pendientes de validación abiertos.**

## Qué es / problema

En el **Schedule Board** (`/Schedules/<id>/ScheduleBoard/<id>?stationId=…`) el filtro nativo
**"Received Batches"** tiene un **bug** (reportado a Steelhead): su dropdown **solo ofrece un id por
nombre**, así que al filtrar por un lote con nombre homónimo (p.ej. varios lotes llamados "210726")
**esconde las tareas de los OTROS lotes** con ese mismo nombre. Validado en vivo: filtrar "210726"
pasó de **2 tareas Unscheduled a 1** (escondió la de recipe FE-PISTON).

**Objetivo (workaround mientras SH corrige el bug):** NO filtrar (eso es lo que está roto), sino
**RESALTAR** (color de fondo verde + borde) las filas cuyo "Received Batches" coincide con el nombre
tecleado **y MARCAR su checkbox**, para que el operador vea de un vistazo TODAS las tareas del lote
(homónimas incluidas) recorriendo la lista.

## Por qué resaltar y NO filtrar (decisión de arquitectura)

El filtro nativo es **100% client-side (estado React)**: validado en vivo que al aplicarlo **NO
cambia la URL ni dispara ninguna query** (solo se movieron pollings de precios de metales). Por eso:

- **Reusar el filtro nativo** exigiría hackear el estado React interno (nombres minificados, hooks
  por índice, datos ofuscados) → **frágil**, se rompe con cada build de SH. **Descartado.**
- **Filtro visual propio (ocultar filas)** → descartado: la tabla **VIRTUALIZA** (declara N filas,
  renderiza solo las visibles; validado: 34 declaradas, 17 en DOM), y ocultar filas descuadra el
  scroll del virtualizador. Además no "ve" las filas no renderizadas.
- **Resaltar + marcar checkbox** (ELEGIDO): no oculta nada → no pelea con la virtualización; no toca
  React internals → sobrevive a los updates de SH. Limitación: solo alcanza las filas presentes en
  el DOM → el **tooltip del 🏷️ AVISA que hay que hacer scroll** para marcar todas (decisión del usuario).

## Mecánica confirmada en vivo (2026-07-22, Ecoplating TLC, Schedule Board 453)

- Tablas de tareas = `table.MuiTable-root` (Unscheduled + Scheduled).
- Celda **"Received Batches"** contiene el **NOMBRE** del lote como link `<a>` (p.ej. "210726").
- **Checkbox** de la fila en la 1a celda; **`cb.click()` programático lo alterna** (dispara el
  handler nativo de selección, sin tocar React) — validado `false→true`.
- **Pintar** la celda (backgroundColor + outline) — validado.
- La tabla **virtualiza** → aviso de scroll.
- Los headers **NO son `<th>`**: la tabla es **MUI CSS-grid** (`display:grid`; header en `<thead>` y
  filas de datos en `<tbody>` comparten las mismas columnas del grid vía `grid-area`). El header
  "Received Batches" es un **`<strong>` hoja dentro de un `<td>`** →
  `<thead><tr class="MuiTableRow-head"><td><div><strong>Received Batches</strong></div></td>`.
  La columna se detecta por **alineación X**: el glue localiza el nodo hoja con "Received Batches",
  **sube al `<td>` ancestro** (su ancho/posición = la columna del grid, igual que la celda de datos)
  y toma su centro X; por fila elige la celda cuyo centro X esté más cerca (tolerancia ~60px). Si no
  hay header, no marca nada = fail-safe. **Bug del 1er deploy (1.7.170):** el selector no incluía
  `strong`/`td`, así que `centersX` salía vacío → fail-safe → "No encuentro la columna". Corregido en
  0.1.1 (config 1.7.171).

## Arquitectura

- **`remote/scripts/schedule-batch-highlighter-core.js`** (puro) — **HECHO**, 14/14 tests:
  `isScheduleBoardUrl` (gate), `extractBatchNames` (celda→nombres, soporta varios por celda),
  `rowMatchesBatchName` (match exacto por nombre, case-insensitive; excluye sub/superstrings),
  `countMatches`, y `ACTIVE_NODE_ID`/`LEGACY_NODE_IDS` (limpieza de nodos de versiones previas, v0.1.4).
- **`remote/scripts/schedule-batch-highlighter.js`** (glue): **buscador INLINE en la barra de filtros
  nativa** (v0.1.2 — el panel flotante `position:fixed` de v0.1.0/0.1.1 era **demasiado intrusivo**
  según el operador). Se ancla **"donde terminan los filtros oficiales"**: `svg[data-testid=
  "FilterListIcon"]` (estable ante idioma) → su `<button>` → contenedor de filtros; inserta el widget
  tras el **último `div[role="button"]`** (SO), idioma-agnóstico (no depende del texto del filtro).
  Widget compacto: 🏷️ + input + contador + ✕, **estilo claro con acento verde** (#13a36f) para
  integrarse a la barra nativa pero seguir siendo reconocible como de la extensión (enriquecimiento,
  análogo a `board-metal-tooltip`; excepción documentada a la regla dark-mode). Aviso de scroll movido
  al **tooltip** (`title`) del 🏷️/input, no en un bloque grande. `MutationObserver` **re-monta el
  widget** si React lo borra (idempotente por id) **y** re-aplica el resaltado a filas nuevas al
  scrollear. **Limpiar DES-MARCA** por **dos vías**: (1) referencias vivas `S.checkedByUs`; (2)
  **barrido de filas visibles del lote** — necesario porque la tabla **VIRTUALIZA** y recicla los
  checkbox al scrollear, dejando las referencias "muertas" (`document.contains`=false) y su fila
  reciclada marcada (bug reportado por el operador). Resaltado **verde pastel `#dbf3e7`** (v0.1.2 bajó
  la intensidad desde `#173a2b`, casi negro, ilegible en la tabla clara de SH). Singleton
  `window.__saSBH`. Detección de columna RB por alineación X (ver §Mecánica).
- **`config.json`** — app `schedule-batch-highlighter` registrado (`autoInject:true`, sin permisos,
  scripts `[core, glue]` — **no usa `steelhead-api.js`**, es 100% DOM). Firmado (KMS) y deployado
  (config 1.7.173).

## Limitaciones conocidas

- **Virtualización:** solo resalta/marca las filas renderizadas; las de más abajo se procesan al
  scrollear (de ahí el aviso). No se puede marcar "todo de golpe" sin el fiber-hack (descartado).
- **Detección de columna por X:** si el layout del board cambia mucho o hay scroll horizontal que
  saca "Received Batches" de vista, la detección puede fallar → fail-safe (no marca), muestra aviso.
- **Colisión numérica teórica:** el match es contra el texto de la celda RB (no contra SO/WO), así
  que un WO/SO homónimo no colisiona salvo que la detección de columna X caiga en otra columna
  (mitigado por la tolerancia de 60px y el resaltado visible que el operador revisa).

## Plan de validación en vivo

- [x] **v0.1.1** Teclear "210726" → resalta las N filas con ese Received Batches (incluidas las
      homónimas que el filtro nativo escondía) y marca sus checkboxes. **VALIDADO** (operador
      2026-07-22, tras el fix de detección de columna).
- [x] **v0.1.2** El **buscador inline** aparece en la barra de filtros, tras el último filtro (SO).
      **VALIDADO** (operador 2026-07-22, "ya quedó").
- [x] **v0.1.2** **Limpiar** quita resaltado **y des-marca** los checkboxes de las filas visibles del
      lote (bug de refs recicladas por virtualización — corregido con el barrido). **VALIDADO** (operador 2026-07-22).
- [x] **v0.1.2** Resaltado verde pastel legible (menos intenso). **VALIDADO** (operador 2026-07-22).
- [x] **v0.1.3** Ícono ⓘ con tooltip de scroll + recomendación de ordenar. **VALIDADO** (operador 2026-07-22).
- [ ] No rompe la SPA a lo largo de una sesión larga (sin congelamientos por el re-montaje del widget) —
      observación continua; sin incidentes reportados hasta ahora.
- [ ] Nombre inexistente → 0 marcadas, sin efectos (caso borde, no reportado explícitamente).

## Safari/iPad
En el bundle desde **v0.5.9** (2026-07-23). Clasificación: **directo / autoInject / sin lanzador** — el buscador inline
se auto-inyecta en la barra de filtros del Schedule Board por su propio gate (`autoInject:true`), así que basta agregar el
`id` a `safari/bundle.json.applets[]`; no requiere cablear `LAUNCHERS`/`LAUNCH_FN`. Sin bloqueadores iOS: es **100% DOM**
(resaltado + `cb.click()` + `MutationObserver`), no usa `steelhead-api.js`, ni `a.download`, ni portapapeles, ni
`chrome.storage`. Deps en el bundle: `schedule-batch-highlighter-core.js`, `schedule-batch-highlighter.js`. **Tras editar
el applet → recompilar en Xcode** (el bundle es estático).
