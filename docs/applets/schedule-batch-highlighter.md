# schedule-batch-highlighter — Resaltar Lote en Programación

**Versión actual:** 0.1.0-wip — **core + golden test 12/12 y glue escritos** (sintaxis OK, suite
814/814). **PENDIENTE:** validación en vivo del DOM (el navegador estuvo muy inestable en la sesión
de desarrollo) y deploy.

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
  el DOM → el panel **AVISA que hay que hacer scroll** para marcar todas (decisión del usuario).

## Mecánica confirmada en vivo (2026-07-22, Ecoplating TLC, Schedule Board 453)

- Tablas de tareas = `table.MuiTable-root` (Unscheduled + Scheduled).
- Celda **"Received Batches"** contiene el **NOMBRE** del lote como link `<a>` (p.ej. "210726").
- **Checkbox** de la fila en la 1a celda; **`cb.click()` programático lo alterna** (dispara el
  handler nativo de selección, sin tocar React) — validado `false→true`.
- **Pintar** la celda (backgroundColor + outline) — validado.
- La tabla **virtualiza** → aviso de scroll.
- Los headers **NO son `<th>`** → la columna se detecta por **alineación X del header** (el glue
  busca el header "Received Batches", su centro X, y por fila toma la celda cuyo centro X esté más
  cerca; tolerancia ~60px; si no hay header, no marca nada = fail-safe).

## Arquitectura

- **`remote/scripts/schedule-batch-highlighter-core.js`** (puro) — **HECHO**, 12/12 tests:
  `isScheduleBoardUrl` (gate), `extractBatchNames` (celda→nombres, soporta varios por celda),
  `rowMatchesBatchName` (match exacto por nombre, case-insensitive; excluye sub/superstrings),
  `countMatches`.
- **`remote/scripts/schedule-batch-highlighter.js`** (glue) — **HECHO** (pendiente validar DOM en
  vivo): **panel flotante** dark-mode `position:fixed` (NO inyectado en el header de React — insertar
  entre hijos de un contenedor React del board congelaba la SPA); input de nombre con debounce;
  detección de columna RB por alineación X; resalta filas coincidentes + marca sus checkboxes;
  `MutationObserver` re-aplica al scrollear/re-render (virtualización); aviso de scroll; botón
  Limpiar que **des-marca solo los checkboxes que pusimos nosotros** (`S.checkedByUs`, no toca los
  que el operador marcó a mano); singleton `window.__saSBH`.
- **`config.json`** — app `schedule-batch-highlighter` registrado (`autoInject:true`, sin permisos,
  scripts `[core, glue]` — **no usa `steelhead-api.js`**, es 100% DOM). **Pendiente:** firmar (KMS)
  y deploy tras validación en vivo.

## Limitaciones conocidas

- **Virtualización:** solo resalta/marca las filas renderizadas; las de más abajo se procesan al
  scrollear (de ahí el aviso). No se puede marcar "todo de golpe" sin el fiber-hack (descartado).
- **Detección de columna por X:** si el layout del board cambia mucho o hay scroll horizontal que
  saca "Received Batches" de vista, la detección puede fallar → fail-safe (no marca), muestra aviso.
- **Colisión numérica teórica:** el match es contra el texto de la celda RB (no contra SO/WO), así
  que un WO/SO homónimo no colisiona salvo que la detección de columna X caiga en otra columna
  (mitigado por la tolerancia de 60px y el resaltado visible que el operador revisa).

## Plan de validación en vivo (pendiente — hacer antes de deploy)

- [ ] El panel flotante aparece en el Schedule Board.
- [ ] Teclear "210726" → resalta las N filas con ese Received Batches (incluidas las homónimas que
      el filtro nativo escondía) y marca sus checkboxes; contador correcto.
- [ ] Scrollear → las filas nuevas se resaltan/marcan (observer).
- [ ] Limpiar → quita resaltado y des-marca SOLO lo que marcó el applet (respeta selección manual).
- [ ] No rompe la SPA (sin congelamientos por el panel flotante).
- [ ] Nombre inexistente → 0 marcadas, sin efectos.
