# schedule-batch-highlighter — Resaltar Lote en Programación

**Versión actual:** 0.1.4 (config **1.7.178**, tag `v1.7.178`) — **DEPLOYADO**. Core + golden test 14/14,
glue firmado (KMS). **Iteraciones sobre feedback del operador:**
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
