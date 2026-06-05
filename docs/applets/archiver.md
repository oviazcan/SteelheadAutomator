# Applet: `archiver` (Archivador Masivo de PNs)

## Qué hace
Archiva/desarchiva números de parte en bloque por criterios combinables (intersección AND):
- **Modo**: archivar (`archivedAt=now`) o desarchivar (`archivedAt=null`).
- **Fecha** (opcional): creación / modificación / última utilización, antes/después de un corte.
- **Etiquetas** (fase 1): multi-selección con modo AND (todas) / OR (cualquiera).

Flujo (3 pantallas): **config** (modo + fecha opcional + validación) → **scan slim** (mode-aware) → **pantalla de filtros con conteo en vivo** → **preview/tabla** → ejecutar.

## Versión actual
1.1.0 — **feedback de progreso** (barra en carga + ejecución): % real si `AllPartNumbers.pagedData.totalCount` está disponible, animada si no; el overlay se re-asegura en `executeArchive` (antes desaparecía en el flujo normal → no se veía nada al ejecutar). Previo 1.0.0 — filtro por etiquetas (AND/OR) + archivar/desarchivar + fecha opcional + form mudado al script remoto.

## Estado de deploy (2026-06-04)
- **Feedback de progreso (1.1.0) desplegado a `gh-pages`** (byte-exact verificado, propagado). `remote/config.json` `version` **1.6.37**. Spec/plan en `docs/superpowers/{specs,plans}/2026-06-04-archiver-progress-feedback*`. Tests `node --test tools/test/archiver.test.js` → **16/16**. Pendiente: piloto DOM (recargar extensión → ver barra en carga y al ejecutar).
- Deploy previo (filtro etiquetas) byte-exact. `version` **1.6.34**, `extensionVersion` **1.6.3**.
  - La `1.6.30` que se había bumpeado chocó con un avance paralelo de `main` (que ya había usado 1.6.30 y subió a 1.6.33 con 10 hashes recapturados + bill-autofill). Se reintegró `main` **preservando esos 10 hashes** y se re-bumpeó a 1.6.34.
- Commits: `main` → `8bde8ab`; deploy `gh-pages` → `024bb51`.
- Tests al cierre: `node --test tools/test/archiver.test.js` → **10/10**.
- **Pendiente de Omar antes de uso productivo (no bloquea el deploy del script):**
  1. **Recargar la extensión** (`chrome://extensions` → reload; carga el nuevo `background.js`). Hasta entonces, el `background.js` viejo llama `PNArchiver.run()` con args sin `mode`/`useDate` → el nuevo `run()` default a `mode=archive`, `useDate=false` (ignora la fecha pero el preview sigue siendo gate; sin riesgo de datos). Si se distribuye por `.zip`: bump `manifest.json` a 1.6.3 + repackage + subir `steelhead-automator.zip`.
  2. **Piloto / smoke test** (ver abajo).

## Arquitectura
- Form + filtros + preview + ejecución viven en `remote/scripts/archiver.js` vía el entry point `openConfigAndRun()`.
- `extension/background.js` case `run-archiver` solo inyecta scripts y llama `window.PNArchiver.openConfigAndRun()` (cambio único en la extensión; de aquí en más los filtros se cambian por deploy a gh-pages).
- Helpers puros (`slimPN`, `discoverLabels`, `matchesLabels`, `applyFilters`, `isInTargetState`) testeados en `tools/test/archiver.test.js` (`node --test`, sandbox vm), expuestos vía `window.__SAArchiver`.

## Lecciones / notas de implementación
- **Feedback de progreso (1.1.0)**: la barra (`dl9-bar`) existía en el markup pero **sin CSS** (invisible) y **sin updates de width** (estática); y en el flujo normal `showFilterScreen`/`showArchiverPreview` removían el overlay y `executeArchive` **no lo re-mostraba** → cero feedback al ejecutar (solo el path de *resume* lo mostraba). Fix: helper `setProgress(fraction,text)` que reusa `showArchiverUI` (idempotente → re-asegura overlay) + CSS de barra (determinada/animada con `.indet`) + `tick()` que avanza también al saltar por idempotencia. Cálculo en funciones puras `computeLoadProgress`/`computeExecProgress` (testeadas en `tools/test/archiver.test.js`). Carga: % real solo si `pagedData.totalCount` viene en la 1ª página, si no animada.
- **Scan SLIM**: `fetchPNsForMode(mode,...)` pagina `AllPartNumbers` y guarda solo `{id,name,createdAt,archivedAt,customer,labels[]}` (no el nodo pesado). archive→activos, unarchive→archivados.
- **Idempotencia doble**: el scan pre-filtra por estado (archive=activos, unarchive=archivados) y, como cinturón, `executeArchive` salta cualquier PN ya en el estado destino vía `isInTargetState`.
- **Resume por modo**: la llave `sa_archiver_resume_v1` guarda `opts.mode`; al reanudar solo ofrece continuar si el modo coincide (no mezcla archive/unarchive).
- **Cruce de utilización**: extraído a `filterByUnused` (WO + recibos). Se **quitó** el fallback per-PN `GetPartNumber`; si `AllWorkOrders`/`AllReceivers` regresan vacío, emite un `warn` y el preview con conteo es el gate humano antes de mutar.
- **Mensajería mode-aware**: progreso, resultado y modal de éxito dicen "Desarchivados" cuando aplica.
- **Etiquetas**: dedup por NOMBRE (no id); `matchesLabels` también compara por nombre, mantener ambas juntas si algún día se hace match por id.

## Datos
- `AllPartNumbers` trae etiquetas en `partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{id,name}`.
- Grupo (`partNumberGroupByPartNumberGroupId`) y proceso (`processNodeDescriptions`) vienen **vacíos** en el listado → fase 2.

## Plan de validación (pendiente — piloto de Omar en sesión autenticada)
Un solo piloto valida los tres checkpoints:
- [ ] **Archivar**, sin fecha, elegir **SQ1 + Antitarnish** en **AND** → ver el **conteo en vivo** y archivar un subconjunto chico.
  - Valida **M3**: si la etiqueta no se llama exactamente `SQ1` (en la muestra solo aparecía `SQ2`), se verá con su nombre real en la lista descubierta → autocorrige.
- [ ] **Desarchivar** (mismo flujo) →
  - Valida **M1**: que `AllPartNumbers` devuelva los archivados (si la lista sale vacía, hay que ver `includeArchived`).
  - Valida **M2**: que `UpdatePartNumber {archivedAt:null}` los reactive de verdad.

## Issues conocidos (pre-existentes, heredados; no introducidos por 1.0.0)
- **`dateType=modificacion` filtra por `createdAt`**: `slimPN` solo trae `createdAt`, así que la opción "Fecha de modificación" del form en realidad filtra por creación. Decidir en fase 2: traer `modifiedAt` al slim y diferenciarlo en `applyFilters`, o quitar la opción del form. ("creación" y "última utilización" sí funcionan bien.)
- **Checkbox huérfano en el `<thead>` del preview** (`#sa-arch-th-check`): no tiene handler; el select-all real es `#sa-arch-selectall` arriba de la tabla. Conectar o eliminar.

## Fase 2 (pendiente)
- Filtro por **grupo de partes**, **línea** y **departamento** (dimensiones contables personalizables; cada PN tiene ambas), y **proceso**. Requieren investigar la fuente del dato (vienen vacíos en el listado; probablemente `GetPartNumber` por PN). Definir costo/memoria antes de integrarlos.

## Spec / plan
- Spec: `docs/superpowers/specs/2026-06-03-archiver-label-filter-design.md`
- Plan: `docs/superpowers/plans/2026-06-03-archiver-label-filter.md`
