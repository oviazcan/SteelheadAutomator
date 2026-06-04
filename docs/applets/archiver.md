# Applet: `archiver` (Archivador Masivo de PNs)

## Qué hace
Archiva/desarchiva números de parte en bloque por criterios combinables (intersección AND):
- **Modo**: archivar (`archivedAt=now`) o desarchivar (`archivedAt=null`).
- **Fecha** (opcional): creación / modificación / última utilización, antes/después de un corte.
- **Etiquetas** (fase 1): multi-selección con modo AND (todas) / OR (cualquiera).

Flujo (3 pantallas): **config** (modo + fecha opcional + validación) → **scan slim** (mode-aware) → **pantalla de filtros con conteo en vivo** → **preview/tabla** → ejecutar.

## Versión actual
1.0.0 — filtro por etiquetas (AND/OR) + archivar/desarchivar + fecha opcional + form mudado al script remoto.

## Arquitectura
- Form + filtros + preview + ejecución viven en `remote/scripts/archiver.js` vía el entry point `openConfigAndRun()`.
- `extension/background.js` case `run-archiver` solo inyecta scripts y llama `window.PNArchiver.openConfigAndRun()` (cambio único en la extensión; de aquí en más los filtros se cambian por deploy a gh-pages).
- Helpers puros (`slimPN`, `discoverLabels`, `matchesLabels`, `applyFilters`, `isInTargetState`) testeados en `tools/test/archiver.test.js` (`node --test`, sandbox vm), expuestos vía `window.__SAArchiver`.

## Lecciones / notas de implementación
- **Scan SLIM**: `fetchPNsForMode(mode,...)` pagina `AllPartNumbers` y guarda solo `{id,name,createdAt,archivedAt,customer,labels[]}` (no el nodo pesado). archive→activos, unarchive→archivados.
- **Idempotencia doble**: el scan pre-filtra por estado (archive=activos, unarchive=archivados) y, como cinturón, `executeArchive` salta cualquier PN ya en el estado destino vía `isInTargetState`.
- **Resume por modo**: la llave `sa_archiver_resume_v1` guarda `opts.mode`; al reanudar solo ofrece continuar si el modo coincide (no mezcla archive/unarchive).
- **Cruce de utilización**: extraído a `filterByUnused` (WO + recibos). Se **quitó** el fallback per-PN `GetPartNumber`; si `AllWorkOrders`/`AllReceivers` regresan vacío, emite un `warn` y el preview con conteo es el gate humano antes de mutar.
- **Mensajería mode-aware**: progreso, resultado y modal de éxito dicen "Desarchivados" cuando aplica.
- **Etiquetas**: dedup por NOMBRE (no id); `matchesLabels` también compara por nombre, mantener ambas juntas si algún día se hace match por id.

## Datos
- `AllPartNumbers` trae etiquetas en `partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{id,name}`.
- Grupo (`partNumberGroupByPartNumberGroupId`) y proceso (`processNodeDescriptions`) vienen **vacíos** en el listado → fase 2.

## Plan de validación (pendiente en prod)
- [ ] **M1**: confirmar que `AllPartNumbers` devuelve archivados (necesario para el modo desarchivar).
- [ ] **M2**: confirmar que `UpdatePartNumber {archivedAt:null}` desarchiva de verdad.
- [ ] **M3**: confirmar el nombre exacto de la etiqueta `SQ1` (en la muestra solo aparece `SQ2`).
- [ ] **Piloto**: archivar un subconjunto chico de PNs con `SQ1` + `Antitarnish` (AND) y verificar que el conteo en vivo coincide.

## Fase 2 (pendiente)
- Filtro por **grupo de partes**, **línea** y **departamento** (dimensiones contables personalizables; cada PN tiene ambas), y **proceso**. Requieren investigar la fuente del dato (vienen vacíos en el listado; probablemente `GetPartNumber` por PN). Definir costo/memoria antes de integrarlos.

## Spec / plan
- Spec: `docs/superpowers/specs/2026-06-03-archiver-label-filter-design.md`
- Plan: `docs/superpowers/plans/2026-06-03-archiver-label-filter.md`
