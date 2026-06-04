# Diseño: extender el applet `archiver` con filtro por etiquetas + archivar/desarchivar

**Fecha:** 2026-06-03
**Autor:** Omar Viazcán (+ Claude)
**Applet afectado:** `archiver` (`remote/scripts/archiver.js`, trigger en `extension/background.js`)
**Estado:** aprobado para planeación

## Problema / motivación

El applet `archiver` hoy solo archiva PNs por criterios de **fecha** (creación / modificación / última utilización). Surge la necesidad de archivar PNs por **etiquetas** — caso concreto inmediato: archivar las partes que tengan **tanto la etiqueta `SQ1` como la etiqueta `Antitarnish`** (AND), con una mini interfaz que indique **cuántas se van a archivar** antes de confirmar.

A futuro se quiere además filtrar por **grupo de partes**, **línea** y **departamento** (estas dos últimas son *dimensiones contables personalizables*; cada PN tiene ambas) y por **proceso**. Eso queda fuera de esta fase (ver §7).

## Hallazgos de datos (verificados contra `docs/api/Payload: AllPartNumbers.txt`)

- El listado `AllPartNumbers` (hash `65c6de2f9f3cef5ffebba067cb80202b86ef6f32e2d6fda721504fd4bcc6a790`, ya usado por el applet) trae por nodo:
  - **Etiquetas pobladas y confiables**: `partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{ id, name, color }`. En la muestra aparecen `SQ2`, `Antitarnish`, `Decapado`, `Plata Flash`, `Plata`, `Epóxico MT`, `NP Desconocido`. → **filtrable client-side sin queries extra.**
  - `partNumberGroupByPartNumberGroupId`: **null** para los PNs de la muestra.
  - `processNodeDescriptionsByPartNumberId.nodes`: **vacío** para la muestra.
- Conclusión: el filtro por etiquetas es directo y barato; grupo/proceso/dimensiones **no** salen del listado y requieren investigación + posibles queries por PN (fase 2).

## Decisiones de diseño (acordadas con el usuario)

1. **Alcance fase 1 = solo etiquetas.** Grupo/línea/departamento/proceso → fase 2.
2. **Match de etiquetas:** AND por default (tiene *todas* las elegidas), con **toggle a OR** (tiene *cualquiera*).
3. **Criterios opcionales que se intersectan (AND).** La **fecha de corte pasa a ser opcional**; se puede archivar solo por etiquetas, solo por fecha, o por ambos.
4. **Modo archivar / desarchivar** (toggle). "Temporal" del pedido original = el archivado de Steelhead es reversible; agregamos el desarchivado en bloque.
5. **El formulario de criterios se muda al script remoto** (Opción A, abajo).

## Arquitectura — dónde vive el formulario (Opción A, recomendada y aprobada)

Hoy el modal de criterios está hardcodeado en `extension/background.js` (case `run-archiver`, ~líneas 705-786). Eso obliga a republicar la extensión por cada campo nuevo.

- **Opción A (elegida):** cambio **único** en `extension/background.js` → el case `run-archiver` solo:
  1. `injectAppScripts(tab.id, 'archiver')`
  2. ejecuta en MAIN world `window.PNArchiver.openConfigAndRun()` y resuelve su resultado.

  Todo el formulario + filtros + preview vive en `remote/scripts/archiver.js`. Se republica la extensión **una sola vez**; de ahí en adelante, cambios de filtros (incl. fase 2) salen solo con **deploy a `gh-pages`**.
- **Opción B (descartada):** seguir armando el form en `background.js`. Republica extensión cada vez.

`PNArchiver` expone hoy `{ run, stop }`. Se agrega `openConfigAndRun()` (nuevo entry point que arma el form, escanea, filtra y ejecuta) manteniendo `run()`/`stop()` por compatibilidad/resume.

## Flujo nuevo (3 pantallas)

1. **Config** (modal remoto):
   - Modo: **Archivar** / **Desarchivar**.
   - Checkbox **"Usar fecha de corte"** (default off). Si on: tipo (creación / modificación / utilización) + dirección (antes / después) + input de fecha.
   - Checkbox validación de ingeniería (solo aplica en modo archivar; se oculta/deshabilita en desarchivar).
   - Botón "Buscar PNs".

2. **Scan**:
   - Pagina `AllPartNumbers` (pageSize 500) como hoy.
   - Guarda **solo campos slim** por PN: `{ id, name, createdAt, customer, archivedAt, labels: [{id,name}] }`. (Hoy hace `allPNs.push(n)` con el nodo pesado completo → se cambia a slim; ver §Memoria.)
   - Modo **archivar** → conserva `!archivedAt` (activos). Modo **desarchivar** → conserva `archivedAt != null` (archivados).
   - Mientras pagina, acumula el **catálogo de etiquetas descubiertas** con conteo (`Map<labelName, count>`).

3. **Filtros + conteo en vivo** (mini interfaz pedida):
   - Multiselect de las etiquetas descubiertas (cada una con su conteo).
   - Toggle **AND / OR**.
   - Si la fecha estaba activa, se aplica también (intersección AND con el filtro de etiquetas).
   - Contador grande **"N partes se archivarán / se desarchivarán"**, recalculado al vuelo cada vez que cambian las etiquetas o el modo AND/OR.
   - Botón "Continuar" → pantalla de **preview/tabla** existente (`showArchiverPreview`, con checkboxes y límite de 500 filas en DOM) → **Ejecutar**.

## Ejecución

- **Archivar:** `UpdatePartNumber { id, archivedAt: new Date().toISOString() }` (igual que hoy).
- **Desarchivar:** `UpdatePartNumber { id, archivedAt: null }`.
- Reusa la maquinaria existente: `runPool` concurrencia 3, `withRetry`, **resume** en `localStorage`.
- **Idempotencia:** skip si el PN ya está en el estado destino (archivar: skip si `archivedAt != null`; desarchivar: skip si `archivedAt == null`).
- **Resume por modo:** la llave de resume incluye el modo (`sa_archiver_resume_v1` → distinguir archive/unarchive, p. ej. guardar `mode` en el estado y validar al reanudar; no mezclar listas de modos distintos).
- **Validación de ingeniería:** se mantiene tal cual solo en modo archivar.

## Memoria (skill `memory-hardening-applets`)

El applet escanea todos los PNs, corre `runPool` y puede tardar minutos → aplica el skill. Mejoras incluidas:
- **Slim al paginar:** no acumular nodos pesados de `AllPartNumbers`; quedarse con `{id,name,createdAt,customer,archivedAt,labels[]}`. Esto reduce el footprint que hoy crece con el nodo completo.
- Limpiar Maps (catálogo de etiquetas) al cerrar/terminar.
- Invocar el skill durante la implementación para revisar host-cleanup-shared (mem monitor / Datadog / Apollo drain) según el patrón vigente.

## A verificar durante la implementación

1. **`AllPartNumbers` y archivados:** confirmar que el listado devuelve PNs archivados (el código actual filtra `!n.archivedAt` client-side, lo que sugiere que sí los devuelve). Si no, ver si necesita `includeArchived: 'YES'` o una query alterna para el modo desarchivar.
2. **`archivedAt: null` desarchiva:** confirmar que `UpdatePartNumber` con `archivedAt:null` revierte el archivado (patrón análogo a `ArchiveReport`, que acepta timestamp o null).
3. **Matching de etiquetas:** por `name` case-insensitive vs por `id`. Preferible resolver/mostrar por `name` (lo que ve el usuario) pero guardar el `id` para robustez. Validar que `SQ1` exista (en la muestra solo aparece `SQ2`; `SQ1` debe confirmarse en datos reales).

## Entregables

- `remote/scripts/archiver.js`: nuevo `openConfigAndRun()` + filtro de etiquetas + modo archive/unarchive + conteo en vivo + slim scan.
- `extension/background.js`: case `run-archiver` simplificado a inyectar + `openConfigAndRun()` (cambio único; requiere republicar extensión una vez).
- `remote/config.json`: bump `version` (cache-bust) y, si aplica, `extensionVersion`.
- **Nueva bitácora** `docs/applets/archiver.md` (hoy no existe) con versión, lecciones, plan de validación y pendientes de fase 2.
- Alta de `archiver` en el índice de applets de `CLAUDE.md`.

## Deploy

1. Bump `remote/config.json` `version` + `lastUpdated`.
2. Commit en `main`.
3. Sync a `gh-pages` (byte-exact `archiver.js` + `config.json`), commit `deploy: ... + bump <version>`.
4. Push `main` y `gh-pages`; verificar con `tools/check-deploy.sh archiver`.
5. Republicar la extensión **una vez** por el cambio de `background.js` (bump `extensionVersion`).

## Fuera de alcance (fase 2 — documentar, no implementar ahora)

- Filtro por **grupo de partes** (`partNumberGroupByPartNumberGroupId`, null en el listado → investigar fuente).
- Filtro por **línea** y **departamento** (dimensiones contables personalizables por PN → investigar query/estructura, probablemente per-PN).
- Filtro por **proceso** (`processNodeDescriptions` vacío en el listado → investigar).
- Cada uno necesita confirmar si el dato sale de un listado ampliado o de `GetPartNumber` por PN (costo/memoria) antes de integrarse.
