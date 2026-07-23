# Applet: `archiver` (Archivador Masivo de PNs)

## Qué hace
Archiva/desarchiva números de parte en bloque por criterios combinables (intersección AND):
- **Modo**: archivar (`archivedAt=now`) o desarchivar (`archivedAt=null`).
- **Fecha** (opcional): creación / modificación / última utilización, antes/después de un corte.
- **Etiquetas** (fase 1): multi-selección con modo AND (todas) / OR (cualquiera).

Flujo (3 pantallas): **config** (modo + fecha opcional + validación) → **scan slim** (mode-aware) → **pantalla de filtros con conteo en vivo** → **preview/tabla** → ejecutar.

## Versión actual
1.2.1 — **feedback de progreso de 2 pasos en desarchivar**. La doble pasada hacía que la barra recorriera 0→100% dos veces y que el contador "del modo" mostrara **activos** durante la pasada 1 (engañoso: parecía ignorar los archivados). Ahora `computeLoadProgress` es step-aware: **Paso 1/2: escaneando catálogo** (sin conteo del modo) y **Paso 2/2: identificando archivados... (N archivados)**; barra continua `[0,0.5]+[0.5,1]` sin retroceso. `fetchPNsForMode` etiqueta cada pasada con `tagStep(step,steps)`. Archivar (pasada única) sin cambios. Tests **32/32**.

1.2.0 — **fix desarchivar (0 resultados) + EJE B de memoria**.
- **Bug:** en modo *desarchivar*, el scan entregaba 0 PNs. Causa raíz: el persisted query `AllPartNumbers` (hash `65c6de…`) (a) **excluye archivados server-side** por defecto (necesita `includeArchived:'YES'`) y (b) **NO expone `archivedAt`** a nivel de nodo PN (verificado contra `docs/api/Payload: AllPartNumbers.txt`: las 17 ocurrencias de `archivedAt` están en sub-objetos, ninguna a nivel PN). El `fetchPNsForMode` viejo llamaba sin `includeArchived` y filtraba con `keep = !!n.archivedAt` → siempre `false` → 0 en unarchive. (En *archivar* funcionaba por coincidencia: el server ya devolvía solo activos.) Bug latente gemelo: `slimPN` dejaba `archivedAt:null` → `isInTargetState(_, 'unarchive')` daba `true` para todos → `executeArchive` los habría saltado como "ya activos".
- **Fix (patrón canónico de `auditor.js`):** `fetchPNsForMode` reescrito. Archivar → 1 pasada `includeArchived:'NO'`. Desarchivar → **diff de dos pasadas** vía `pageAllPNs`: pasada 1 (`'NO'`) recoge el `Set` de IDs activos (solo IDs, sin slim); pasada 2 (`'YES'`=activos+archivados) conserva los que NO son activos = archivados, marcados con `ARCHIVED_SENTINEL='__archived__'`. `slimPN(node, archivedAtOverride)` inyecta el estado (el server no lo da). Dedup `seenIds` por pasada contra drift de paginación. El sentinel **nunca** llega al server: la mutación manda `archivedAt:null` literal.
- **EJE B (memory-hardening):** se cargó `host-cleanup-shared.js` en `config.json`; `startHostGuards()` detiene Datadog RUM + arranca `createMemMonitor` (span `#sa-arch-mem`, guardrail a 88% → abortar + persistir resume + modal); `makePeriodicDrain(50)` en el worker de `executeArchive`; `drainHostCache()` (Apollo) entre páginas — relevante porque desarchivar escanea el dominio dos veces. `stopMemMonitor()` en el `finally` de `openConfigAndRun`.
- Tests `node --test tools/test/archiver.test.js` → **26/26** (incluye diff de dos pasadas, dedup, 0/all archivados, guard de `stopped`, drain con módulo presente).

Previo 1.1.0 — **feedback de progreso** (barra en carga + ejecución): % real si `AllPartNumbers.pagedData.totalCount` está disponible, animada si no; el overlay se re-asegura en `executeArchive`. Previo 1.0.0 — filtro por etiquetas (AND/OR) + archivar/desarchivar + fecha opcional + form mudado al script remoto.

> **Desarchivar = 2 pasadas.** El scan recorre el catálogo dos veces (activos para el diff, luego archivados). Desde 1.2.1 el progreso lo refleja con "Paso 1/2" / "Paso 2/2" y barra continua, en vez de recorrer 0→100% dos veces.

## Estado de deploy (2026-06-04)
- **Feedback de progreso (1.1.0) desplegado a `gh-pages`** (byte-exact verificado, propagado). `remote/config.json` `version` **1.6.37**. Spec/plan en `docs/superpowers/{specs,plans}/2026-06-04-archiver-progress-feedback*`. Tests `node --test tools/test/archiver.test.js` → **16/16**. **✅ Piloto DOM validado 2026-07-22** (barra visible en carga y al ejecutar; confirmación del operador).
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

## Plan de validación — ✅ VALIDADO en vivo (Omar, 2026-06-08)
> Piloto en sesión autenticada confirmado por el usuario: **desarchivar ya lista los archivados** (antes 0) y el **progreso de 2 pasos** (1.2.1) se ve correcto. Cierra M1.

- [x] **Desarchivar**, sin fecha → el scan **SÍ lista PNs archivados** (antes daba 0). **Confirmado en vivo.**
  - **M1** (fix): la doble pasada `includeArchived:'NO'`→`'YES'` con diff por ID entrega los archivados. ✅
  - **M2**: `UpdatePartNumber {archivedAt:null}` reactiva los PNs. ✅
- [x] **Progreso de 2 pasos** (1.2.1): "Paso 1/2 escaneando catálogo → Paso 2/2 identificando archivados", barra continua. **Confirmado en vivo.**
- [ ] *(opcional, no bloquea)* **Archivar** SQ1+Antitarnish AND como regresión explícita + screenshot del span `#sa-arch-mem` (EJE B) en una corrida grande — recomendado por la skill `memory-hardening-applets`, pendiente de oportunidad.

## Issues conocidos (pre-existentes, heredados; no introducidos por 1.0.0)
- **`dateType=modificacion` filtra por `createdAt`**: `slimPN` solo trae `createdAt`, así que la opción "Fecha de modificación" del form en realidad filtra por creación. Decidir en fase 2: traer `modifiedAt` al slim y diferenciarlo en `applyFilters`, o quitar la opción del form. ("creación" y "última utilización" sí funcionan bien.)
- **Checkbox huérfano en el `<thead>` del preview** (`#sa-arch-th-check`): no tiene handler; el select-all real es `#sa-arch-selectall` arriba de la tabla. Conectar o eliminar.

## Fase 2 (pendiente)
- Filtro por **grupo de partes**, **línea** y **departamento** (dimensiones contables personalizables; cada PN tiene ambas), y **proceso**. Requieren investigar la fuente del dato (vienen vacíos en el listado; probablemente `GetPartNumber` por PN). Definir costo/memoria antes de integrarlos.

## Pendiente (2026-07-01) — reorientar hacia validación de ingeniería
Omar pidió **ajustar el applet de desarchivar para priorizar la marca de validación de
ingeniería por encima de archivar/desarchivar**, más otros ajustes por definir. Contexto:
en el one-shot `tools/unarchive-non-schneider.js` se descubrió/validó lo relevante:
- Mutación **granular** `CreateProcessNodePartNumberOptInout` (hash `f6fe26e4…`, vars
  `{partNumberId, processNodeId, processNodeOccurrence:1, cancelOthers:false}`) marca la
  validación de ingeniería (nodes `[231176, 231174]`) SIN tocar el resto del PN — a
  diferencia del `enableValidation` actual del archiver, que usa `SavePartNumber` (REPLACE:
  borra labels/proceso/dims/specs/customInputs). **Migrar el archiver a la granular.**
- `includeArchived:'EXCLUSIVELY'` trae SOLO archivados en 1 pasada → el archiver puede
  dejar el diff de 2 pasadas (deuda de `auditor.js`).
- Etiqueta `Borrado definitivo` = labelId **15646** (dominio TLC id 344).
- **Falta capturar** la mutación granular de etiquetado de PN (no está en ningún scan;
  solo hay `CreateWorkOrderLabel`/`DeleteWorkOrderLabels` de WOs).

## Spec / plan
- Spec: `docs/superpowers/specs/2026-06-03-archiver-label-filter-design.md`
- Plan: `docs/superpowers/plans/2026-06-03-archiver-label-filter.md`
